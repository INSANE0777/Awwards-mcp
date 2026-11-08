import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assignBenchmarkSplit,
  benchmarkAnnotationSchema,
  benchmarkArtifactSchema,
  compatibilityMatrixSchema,
} from "../src/atlas/benchmark.js";
import { parseAtlasCliArgs } from "../src/atlas/cli.js";
import { ATLAS_SCHEMA_VERSION } from "../src/atlas/schema.js";
import { isSearchableVocabulary, lookupVocabulary } from "../src/atlas/vocabulary.js";

const benchmarkFixture = JSON.parse(
  readFileSync(join("test", "fixtures", "atlas", "benchmark-annotations.json"), "utf8"),
);
const compatibilityFixture = JSON.parse(
  readFileSync(join("test", "fixtures", "atlas", "compatibility-matrix.json"), "utf8"),
);

describe("Phase 0 benchmark and compatibility artifacts", () => {
  it("validates the checked-in benchmark annotations", () => {
    const artifact = benchmarkArtifactSchema.parse(benchmarkFixture);
    expect(artifact.dataset.regions).toBeGreaterThanOrEqual(100_000);
    expect(artifact.dataset.claims).toBeGreaterThanOrEqual(1_000_000);
    expect(artifact.dataset.sites).toBeGreaterThanOrEqual(1_000);
    expect(artifact.annotations.length).toBeGreaterThan(0);
  });

  it("keeps calibration and held-out splits site-disjoint", () => {
    const artifact = benchmarkArtifactSchema.parse(benchmarkFixture);
    const splits = new Map<string, string>();
    for (const annotation of artifact.annotations) {
      expect(annotation.split).toBe(assignBenchmarkSplit(annotation.siteSlug));
      const previous = splits.get(annotation.siteSlug);
      if (previous) expect(previous).toBe(annotation.split);
      splits.set(annotation.siteSlug, annotation.split);
    }
  });

  it("assigns roughly the documented 60/40 split deterministically", () => {
    const slugs = Array.from({ length: 2_000 }, (_, index) => `site-${index}`);
    const calibration = slugs.filter(
      (slug) => assignBenchmarkSplit(slug) === "calibration",
    ).length;
    expect(calibration / slugs.length).toBeGreaterThan(0.5);
    expect(calibration / slugs.length).toBeLessThan(0.7);
    expect(assignBenchmarkSplit("realevate")).toBe(assignBenchmarkSplit("realevate"));
  });

  it("uses only registered vocabulary labels in annotations", () => {
    const artifact = benchmarkArtifactSchema.parse(benchmarkFixture);
    for (const annotation of artifact.annotations) {
      for (const label of annotation.labels) {
        expect(lookupVocabulary(label.field, label.value), `${label.field}:${label.value}`).not.toBeNull();
        expect(isSearchableVocabulary(label.field, label.value)).toBe(true);
      }
    }
  });

  it("keeps every compatibility mapping inside the versioned vocabulary", () => {
    const matrix = compatibilityMatrixSchema.parse(compatibilityFixture);
    for (const mapping of matrix.legacyFields) {
      expect(mapping.compatible).toBe(true);
      for (const [legacyValue, atlasValue] of Object.entries(mapping.values)) {
        const legacy = lookupVocabulary(mapping.legacyField, legacyValue);
        const atlas = lookupVocabulary(mapping.atlasField, atlasValue);
        expect(legacy, `${mapping.legacyField}:${legacyValue}`).not.toBeNull();
        expect(legacy?.enabled).toBe(false);
        expect(atlas, `${mapping.atlasField}:${atlasValue}`).not.toBeNull();
        expect(atlas?.enabled).toBe(true);
        expect(atlas?.aliases).toContain(`${mapping.legacyField}:${legacyValue}`);
      }
    }
  });

  it("declares a contiguous additive migration chain ending at the current schema", () => {
    const matrix = compatibilityMatrixSchema.parse(compatibilityFixture);
    expect(matrix.migrations.map((migration) => migration.from)).toEqual(
      matrix.migrations.map((_, index) => index),
    );
    for (const [index, migration] of matrix.migrations.entries()) {
      expect(migration.to).toBe(migration.from + 1);
      expect(migration.additive).toBe(true);
      if (index > 0) expect(migration.from).toBe(matrix.migrations[index - 1]!.to);
    }
    expect(matrix.migrations.at(-1)?.to).toBe(ATLAS_SCHEMA_VERSION);
  });

  it("matches the CLI parser to the compatibility matrix", () => {
    const matrix = compatibilityMatrixSchema.parse(compatibilityFixture);
    for (const entry of matrix.cli) {
      const parsed = parseAtlasCliArgs(entry.form.split(" "));
      if (entry.supported) {
        expect(parsed, entry.form).toEqual({ kind: "import" });
      } else {
        expect(parsed?.kind, entry.form).toBe("error");
      }
    }
  });

  it("rejects annotations with the wrong split or unknown fields", () => {
    const annotation = benchmarkArtifactSchema.parse(benchmarkFixture).annotations[0]!;
    const wrong = annotation.split === "calibration" ? "held_out" : "calibration";
    expect(benchmarkAnnotationSchema.safeParse({ ...annotation, split: wrong }).success).toBe(false);
    expect(
      benchmarkAnnotationSchema.safeParse({ ...annotation, unexpected: true }).success,
    ).toBe(false);
  });

  it("rejects non-additive or incomplete compatibility matrices", () => {
    const matrix = compatibilityMatrixSchema.parse(compatibilityFixture);
    expect(
      compatibilityMatrixSchema.safeParse({
        ...matrix,
        migrations: [{ from: 0, to: 1, additive: false }],
      }).success,
    ).toBe(false);
    expect(
      compatibilityMatrixSchema.safeParse({ ...matrix, matrixVersion: "atlas-compat-0" }).success,
    ).toBe(false);
  });
});
