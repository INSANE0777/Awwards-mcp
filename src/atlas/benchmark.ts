import { z } from "zod";
import { stableHash } from "./identity.js";

export const ATLAS_BENCHMARK_VERSION = "atlas-benchmark-v1";
export const ATLAS_COMPATIBILITY_VERSION = "atlas-compat-v1";

const httpUrl = z.string().max(2048).refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}, "expected an absolute HTTP(S) URL");

const basis = z.enum([
  "source_title",
  "source_metadata",
  "native_semantics",
  "declared_aria",
  "computed_style",
  "geometry",
  "interaction_observation",
  "rule_derivation",
  "human_review",
]);

export type BenchmarkSplit = "calibration" | "held_out";

/** Deterministic 60/40 site-level split; pages from one site never cross. */
export function assignBenchmarkSplit(siteSlug: string): BenchmarkSplit {
  const bucket = Number.parseInt(stableHash("atlas-benchmark-split-v1", siteSlug).slice(0, 8), 16) % 100;
  return bucket < 60 ? "calibration" : "held_out";
}

export const benchmarkDatasetSchema = z
  .object({
    regions: z.number().int().min(100_000),
    claims: z.number().int().min(1_000_000),
    sites: z.number().int().min(1_000),
    views: z
      .array(z.enum(["desktop", "tablet", "mobile"]))
      .min(1)
      .max(3),
    features: z.array(z.string().min(1).max(200)).min(1).max(64),
  })
  .strict();

export const benchmarkAnnotationSchema = z
  .object({
    annotationVersion: z.literal(ATLAS_BENCHMARK_VERSION),
    annotationId: z.string().regex(/^[\w-]+$/),
    siteSlug: z.string().regex(/^[\w-]+$/),
    pageUrl: httpUrl,
    regionKey: z.string().min(1).max(200),
    viewport: z.enum(["desktop", "tablet", "mobile"]),
    split: z.enum(["calibration", "held_out"]),
    labels: z
      .array(
        z
          .object({
            field: z.string().regex(/^[\w.]+$/),
            value: z.string().regex(/^[\w.-]+$/),
            decision: z.enum(["accepted", "candidate", "rejected"]),
            basis,
          })
          .strict(),
      )
      .min(1)
      .max(64),
    notes: z.array(z.string().min(1).max(500)).max(64),
    reviewedAt: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expected = assignBenchmarkSplit(value.siteSlug);
    if (value.split !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["split"],
        message: `site ${value.siteSlug} belongs in ${expected}`,
      });
    }
  });

export const benchmarkArtifactSchema = z
  .object({
    annotationVersion: z.literal(ATLAS_BENCHMARK_VERSION),
    dataset: benchmarkDatasetSchema,
    annotations: z.array(benchmarkAnnotationSchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const sitesBySplit = new Map<string, BenchmarkSplit>();
    for (const annotation of value.annotations) {
      const existing = sitesBySplit.get(annotation.siteSlug);
      if (existing && existing !== annotation.split) {
        ctx.addIssue({
          code: "custom",
          path: ["annotations"],
          message: `site ${annotation.siteSlug} appears in both splits`,
        });
      }
      sitesBySplit.set(annotation.siteSlug, annotation.split);
    }
  });

export const compatibilityMatrixSchema = z
  .object({
    matrixVersion: z.literal(ATLAS_COMPATIBILITY_VERSION),
    runtime: z
      .object({
        nodeMajor: z.number().int().positive(),
        sqliteMin: z.string().regex(/^\d+\.\d+\.\d+$/),
        fts5: z.boolean(),
        json1: z.boolean(),
      })
      .strict(),
    migrations: z
      .array(
        z
          .object({
            from: z.number().int().nonnegative(),
            to: z.number().int().positive(),
            additive: z.literal(true),
          })
          .strict(),
      )
      .min(1),
    legacyFields: z
      .array(
        z
          .object({
            legacyField: z.string().regex(/^[\w.]+$/),
            atlasField: z.string().regex(/^[\w.]+$/),
            values: z.record(z.string(), z.string()),
            compatible: z.literal(true),
          })
          .strict(),
      )
      .min(1),
    cli: z
      .array(
        z
          .object({
            form: z.string().min(1).max(100),
            action: z.string().min(1).max(100),
            supported: z.boolean(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type BenchmarkArtifact = z.infer<typeof benchmarkArtifactSchema>;
export type CompatibilityMatrix = z.infer<typeof compatibilityMatrixSchema>;
