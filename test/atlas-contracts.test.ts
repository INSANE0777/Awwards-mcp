import { describe, expect, it } from "vitest";
import {
  atlasResultSchema,
  evidenceCoverageSchema,
  evidenceRefSchema,
  preparedSitePageSchema,
  rightsRecordSchema,
  validatePreparedSitePage,
} from "../src/atlas/contracts.js";

const digest = "a".repeat(64);
const identity = "b".repeat(64);
const highlight = { title: "Hero", mediaPath: "element/2024/01/a.jpg", identity };
const detail = {
  slug: "fixture-site",
  title: "Fixture",
  description: null,
  palette: [],
  technologies: [],
  elements: [],
  awards: [],
  nominee: false,
  score: null,
  ogImage: null,
  liveUrl: "https://fixture.example",
};
const legacyElement = {
  identity,
  fallbackSlug: `site-fixture-site-${"c".repeat(64)}`,
  siteSlug: "fixture-site",
  title: "Hero",
  mediaPath: "element/2024/01/a.jpg",
  mediaType: "image",
  author: "Fixture",
  fetchedAt: 1_700_000_000_000,
};

const prepared = {
  slug: "fixture-site",
  sourceUrl: "https://www.awwwards.com/sites/fixture-site",
  fetchedAt: 1_700_000_000_000,
  sourceDigest: digest,
  detail,
  detailValid: true,
  detailEmpty: false,
  highlights: [highlight],
  highlightParse: { status: "parsed", items: [highlight] },
  legacyElements: [legacyElement],
  summary: { title: "Fixture", liveUrl: "https://fixture.example" },
};

describe("atlas contracts", () => {
  it("accepts a valid prepared page and rejects unknown fields", () => {
    expect(preparedSitePageSchema.safeParse(prepared).success).toBe(true);
    expect(preparedSitePageSchema.safeParse({ ...prepared, extra: true }).success).toBe(false);
  });

  it("ties each parse state to its item count", () => {
    expect(
      preparedSitePageSchema.safeParse({
        ...prepared,
        highlights: [],
        legacyElements: [],
        highlightParse: { status: "absent", items: [] },
      }).success,
    ).toBe(true);
    expect(
      preparedSitePageSchema.safeParse({
        ...prepared,
        highlightParse: { status: "absent", items: [highlight] },
      }).success,
    ).toBe(false);
    expect(
      preparedSitePageSchema.safeParse({
        ...prepared,
        highlights: [],
        highlightParse: { status: "parsed", items: [] },
      }).success,
    ).toBe(false);
    expect(
      preparedSitePageSchema.safeParse({
        ...prepared,
        highlights: [],
        legacyElements: [],
        highlightParse: { status: "drift", items: [] },
      }).success,
    ).toBe(true);
    expect(
      preparedSitePageSchema.safeParse({
        ...prepared,
        highlightParse: { status: "drift", items: [highlight] },
      }).success,
    ).toBe(false);
  });

  it("requires lowercase SHA-256 ids and bounded highlight lists", () => {
    expect(
      preparedSitePageSchema.safeParse({ ...prepared, sourceDigest: digest.toUpperCase() }).success,
    ).toBe(false);
    expect(
      preparedSitePageSchema.safeParse({
        ...prepared,
        highlights: [{ ...highlight, identity: identity.toUpperCase() }],
      }).success,
    ).toBe(false);
    expect(
      preparedSitePageSchema.safeParse({
        ...prepared,
        highlights: Array.from({ length: 501 }, () => highlight),
        highlightParse: { status: "parsed", items: Array.from({ length: 501 }, () => highlight) },
      }).success,
    ).toBe(false);
  });

  it("rejects fractional and negative counts in coverage", () => {
    const coverage = { status: "complete", collected: 1, excluded: 0, limitations: [] };
    expect(evidenceCoverageSchema.safeParse(coverage).success).toBe(true);
    expect(evidenceCoverageSchema.safeParse({ ...coverage, collected: -1 }).success).toBe(false);
    expect(evidenceCoverageSchema.safeParse({ ...coverage, excluded: 0.5 }).success).toBe(false);
  });

  it("requires a rights reference only when copying a non-unknown asset", () => {
    const rights = {
      status: "licensed",
      reference: null,
      recordedAt: 1,
      assertedBy: "caller",
      scope: "local_reference",
    };
    expect(rightsRecordSchema.safeParse(rights).success).toBe(true);
    expect(rightsRecordSchema.safeParse({ ...rights, scope: "export_copy" }).success).toBe(false);
    expect(
      rightsRecordSchema.safeParse({ ...rights, scope: "export_copy", reference: "license-1" })
        .success,
    ).toBe(true);
    expect(
      rightsRecordSchema.safeParse({ ...rights, status: "unknown", scope: "export_copy" }).success,
    ).toBe(true);
  });

  it("validates evidence pointers and sample-key bounds", () => {
    const ref = { artifactId: digest, pointer: "/highlights/0/title", sampleKey: "element/a.jpg" };
    expect(evidenceRefSchema.safeParse(ref).success).toBe(true);
    expect(evidenceRefSchema.safeParse({ ...ref, pointer: "highlights/0" }).success).toBe(false);
    expect(evidenceRefSchema.safeParse({ ...ref, sampleKey: "" }).success).toBe(false);
    expect(evidenceRefSchema.safeParse({ ...ref, sampleKey: "x".repeat(101) }).success).toBe(false);
    expect(evidenceRefSchema.safeParse({ ...ref, sampleKey: "x".repeat(100) }).success).toBe(true);
  });

  it("rejects invalid slugs, negative timestamps and non-HTTP(S) sources", () => {
    expect(preparedSitePageSchema.safeParse({ ...prepared, slug: "bad slug" }).success).toBe(false);
    expect(preparedSitePageSchema.safeParse({ ...prepared, fetchedAt: -1 }).success).toBe(false);
    for (const sourceUrl of [
      "ftp://example.test/page",
      "file:///tmp/page.html",
      "mailto:test@example.test",
      "not-a-url",
    ]) {
      expect(preparedSitePageSchema.safeParse({ ...prepared, sourceUrl }).success, sourceUrl).toBe(
        false,
      );
    }
    expect(preparedSitePageSchema.safeParse({ ...prepared, sourceUrl: "http://example.test" }).success)
      .toBe(true);
    expect(preparedSitePageSchema.safeParse({ ...prepared, sourceUrl: "https://example.test" }).success)
      .toBe(true);
  });

  it("exposes a strict commit-entry validator", () => {
    expect(() => validatePreparedSitePage(prepared as never)).not.toThrow();
    expect(() => validatePreparedSitePage({ ...prepared, slug: "bad/slug" } as never)).toThrow(
      /invalid Atlas prepared page/,
    );
  });

  it("validates the common result envelope", () => {
    const envelope = {
      schemaVersion: "awwwards-atlas-v1",
      operation: "test",
      status: "ok",
      data: null,
      coverage: { status: "unknown", collected: 0, excluded: 0, limitations: [] },
      warnings: [],
      error: null,
    };
    expect(atlasResultSchema(preparedSitePageSchema).safeParse(envelope).success).toBe(true);
    expect(
      atlasResultSchema(preparedSitePageSchema).safeParse({ ...envelope, status: "done" }).success,
    ).toBe(false);
  });
});
