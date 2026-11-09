import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import { writeJsonArtifactSync } from "../src/atlas/artifacts.js";
import { classifySections } from "../src/atlas/classification.js";
import { publishCapture } from "../src/atlas/publish.js";
import { segmentRegions } from "../src/atlas/segmentation.js";
import type { AtlasCaptureAttempt, AtlasStoredArtifact } from "../src/atlas/live-types.js";
import { runAtlasSearchBenchmark } from "../src/atlas/search-bench.js";
import {
  atlasSearchStore,
  compilePredicates,
  deriveRegionTag,
  loadAtlasSearchSnapshot,
  searchAtlas,
  tokenizeQuery,
} from "../src/atlas/search.js";
import { rebuildAtlasSearchProjections } from "../src/atlas/search-projections.js";
import type { SearchAtlasData, SearchAtlasResult } from "../src/atlas/search-types.js";
import {
  SEARCH_DAY,
  SEARCH_NOW,
  makeSnapshot,
  memoryStore,
} from "./helpers/atlas-search-fixture.js";
import { loadPhase2Fixture } from "./helpers/phase2-fixture.js";

function dataOrThrow(result: SearchAtlasResult<SearchAtlasData>): SearchAtlasData {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

const dirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-search-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Atlas search evidence modes", () => {
  const snapshot = makeSnapshot([
    { id: "candidate-hero", purpose: { value: "hero", decision: "candidate" } },
    {
      id: "observed-hero",
      purpose: {
        value: "hero",
        decision: "accepted",
        classification: "observed",
        basis: "native_semantics",
      },
    },
    {
      id: "inferred-hero",
      purpose: { value: "hero", decision: "accepted", classification: "inferred" },
    },
  ]);

  it("candidate is the default and labels candidates as hints", () => {
    const data = dataOrThrow(
      searchAtlas(
        { kind: "sections", predicates: [{ field: "section.purpose", values: ["hero"] }] },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(data.interpreted.evidenceMode).toBe("candidate");
    expect(data.candidateOnly).toBe(true);
    expect(data.candidateNote).toContain("hints");
    expect(data.results.map((hit) => hit.regionId)).toEqual([
      "observed-hero",
      "inferred-hero",
      "candidate-hero",
    ]);
    expect(data.results.every((hit) => hit.candidateOnly)).toBe(true);
  });

  it("accepted includes observed and inferred but not candidate", () => {
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          evidenceMode: "accepted",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(data.candidateOnly).toBe(false);
    expect(data.candidateNote).toBeNull();
    expect(data.results.map((hit) => hit.regionId)).toEqual(["observed-hero", "inferred-hero"]);
  });

  it("observed_only excludes inferred evidence", () => {
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          evidenceMode: "observed_only",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(data.results.map((hit) => hit.regionId)).toEqual(["observed-hero"]);
    expect(data.outcome).toBe("matches");
  });

  it("distinguishes insufficient coverage from a genuine no-match", () => {
    const candidateOnly = makeSnapshot([
      { id: "candidate", purpose: { value: "hero", decision: "candidate" } },
    ]);
    const insufficient = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          evidenceMode: "accepted",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
        },
        memoryStore(candidateOnly),
        SEARCH_NOW,
      ),
    );
    expect(insufficient.outcome).toBe("insufficient_coverage");

    const observed = makeSnapshot([
      {
        id: "about",
        purpose: { value: "about", decision: "accepted", classification: "observed" },
      },
    ]);
    const noMatch = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          evidenceMode: "accepted",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
        },
        memoryStore(observed),
        SEARCH_NOW,
      ),
    );
    expect(noMatch.outcome).toBe("no_observed_match");
  });

  it("reports insufficient coverage for stale, mobile-only or absent value evidence", () => {
    const stale = makeSnapshot([
      {
        id: "stale-hero",
        observedAt: SEARCH_NOW - 40 * SEARCH_DAY,
        purpose: {
          value: "hero",
          decision: "accepted",
          classification: "observed",
          basis: "native_semantics",
        },
      },
      // Keep an eligible section so the corpus is not simply empty.
      { id: "fresh-no-purpose", page: "fresh-page" },
    ]);
    const staleResult = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          evidenceMode: "accepted",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
        },
        memoryStore(stale),
        SEARCH_NOW,
      ),
    );
    expect(staleResult.outcome).toBe("insufficient_coverage");

    const mobile = makeSnapshot([
      {
        id: "mobile-hero",
        viewport: "mobile" as const,
        purpose: {
          value: "hero",
          decision: "accepted",
          classification: "observed",
          basis: "native_semantics",
        },
      },
      { id: "desktop-no-purpose", page: "desktop-page" },
    ]);
    const mobileResult = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          evidenceMode: "accepted",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
        },
        memoryStore(mobile),
        SEARCH_NOW,
      ),
    );
    expect(mobileResult.outcome).toBe("insufficient_coverage");

    const otherTag = makeSnapshot([{ id: "div-only", tag: "div" }]);
    const tagResult = dataOrThrow(
      searchAtlas(
        { kind: "sections", predicates: [{ field: "region.tag", values: ["footer"] }] },
        memoryStore(otherTag),
        SEARCH_NOW,
      ),
    );
    expect(tagResult.outcome).toBe("insufficient_coverage");
  });
});

describe("Atlas search corpus filters", () => {
  const snapshot = makeSnapshot([
    { id: "fresh-desktop", page: "fresh-page", observedAt: SEARCH_NOW - SEARCH_DAY },
    { id: "stale-desktop", page: "stale-page", observedAt: SEARCH_NOW - 10 * SEARCH_DAY },
    { id: "old-desktop", page: "old-page", observedAt: SEARCH_NOW - 40 * SEARCH_DAY },
    { id: "mobile", page: "mobile-page", viewport: "mobile" as const },
    { id: "unknown-time", page: "unknown-page", observedAt: null },
    { id: "inactive", page: "inactive-page", active: false },
  ]);

  it("filters viewport, freshness, unknown time and inactive captures", () => {
    const data = dataOrThrow(
      searchAtlas({ kind: "sections", limit: 20 }, memoryStore(snapshot), SEARCH_NOW),
    );
    expect(data.results.map((hit) => hit.regionId)).toEqual([
      "fresh-desktop",
      "stale-desktop",
    ]);
    expect(data.results.map((hit) => hit.freshness)).toEqual(["fresh", "stale"]);
    expect(data.corpus).toEqual({
      sites: 1,
      pages: 2,
      captures: 2,
      note: "locally cached subset",
      catalogueTotal: null,
    });
  });

  it("honours maxAgeDays and reports missing state evidence honestly", () => {
    const data = dataOrThrow(
      searchAtlas({ kind: "sections", limit: 20, maxAgeDays: 1 }, memoryStore(snapshot), SEARCH_NOW),
    );
    expect(data.results.map((hit) => hit.regionId)).toEqual(["fresh-desktop"]);

    for (const state of ["hover", "focus"] as const) {
      const stateData = dataOrThrow(
        searchAtlas({ kind: "sections", state }, memoryStore(snapshot), SEARCH_NOW),
      );
      expect(stateData.outcome).toBe("insufficient_coverage");
      expect(stateData.total).toBe(0);
      expect(stateData.results).toEqual([]);
    }
  });

  it("returns empty_corpus rather than claiming nothing exists", () => {
    const empty = dataOrThrow(
      searchAtlas({ kind: "sections" }, memoryStore(makeSnapshot([])), SEARCH_NOW),
    );
    expect(empty.outcome).toBe("empty_corpus");
    expect(empty.total).toBe(0);
    expect(empty.nextCursor).toBeNull();
    expect(empty.corpus.sites).toBe(0);
    expect(empty.corpus.pages).toBe(0);
    expect(empty.corpus.captures).toBe(0);

    const wrongViewport = dataOrThrow(
      searchAtlas(
        { kind: "sections", viewport: "desktop" },
        memoryStore(makeSnapshot([{ id: "only-mobile", viewport: "mobile" as const }])),
        SEARCH_NOW,
      ),
    );
    expect(wrongViewport.outcome).toBe("empty_corpus");
  });
});

describe("Atlas search query and predicates", () => {
  it("tokenizes queries and rejects punctuation-only or oversized queries", () => {
    expect(tokenizeQuery("Dark, hero!")).toEqual(["dark", "hero"]);
    expect(tokenizeQuery("!!!")).toEqual([]);
    const punctuation = searchAtlas(
      { kind: "sections", query: "!!!" },
      memoryStore(makeSnapshot([])),
      SEARCH_NOW,
    );
    expect(punctuation.ok).toBe(false);
    if (!punctuation.ok) expect(punctuation.error.code).toBe("INVALID_INPUT");

    const tooMany = searchAtlas(
      { kind: "sections", query: Array.from({ length: 17 }, () => "word").join(" ") },
      memoryStore(makeSnapshot([])),
      SEARCH_NOW,
    );
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error.code).toBe("INVALID_INPUT");

    const tooLong = searchAtlas(
      { kind: "sections", query: "a".repeat(301) },
      memoryStore(makeSnapshot([])),
      SEARCH_NOW,
    );
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error.code).toBe("INVALID_INPUT");
  });

  it("reports FTS_UNAVAILABLE instead of silently returning no text matches", () => {
    const snapshot = { ...makeSnapshot([{ id: "a" }]), ftsAvailable: false };
    const result = searchAtlas(
      { kind: "sections", query: "hero" },
      memoryStore(snapshot),
      SEARCH_NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FTS_UNAVAILABLE");
  });

  it("ANDs predicates, ORs values and validates unsupported fields", () => {
    const snapshot = makeSnapshot([
      {
        id: "r1",
        purpose: [{ value: "hero" }, { value: "about" }],
        tag: "section",
        landmark: "main",
      },
      { id: "r2", purpose: { value: "hero" }, tag: "div" },
      { id: "r3", purpose: { value: "about" }, tag: "section" },
      { id: "r4", purpose: { value: "hero" }, tag: "section", role: "region" },
    ]);
    const orValues = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          predicates: [{ field: "section.purpose", values: ["hero", "about"] }],
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(orValues.results.map((hit) => hit.regionId).sort()).toEqual([
      "r1",
      "r2",
      "r3",
      "r4",
    ]);

    const andPredicates = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          predicates: [
            { field: "section.purpose", values: ["hero"] },
            { field: "region.tag", values: ["section"] },
          ],
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(andPredicates.results.map((hit) => hit.regionId).sort()).toEqual(["r1", "r4"]);

    const repeated = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          predicates: [
            { field: "section.purpose", values: ["hero"] },
            { field: "section.purpose", values: ["about"] },
          ],
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(repeated.results.map((hit) => hit.regionId)).toEqual(["r1"]);

    const landmark = dataOrThrow(
      searchAtlas(
        { kind: "sections", predicates: [{ field: "region.landmark", values: ["main"] }] },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(landmark.results.map((hit) => hit.regionId)).toEqual(["r1"]);

    const role = dataOrThrow(
      searchAtlas(
        { kind: "sections", predicates: [{ field: "region.role", values: ["region"] }] },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(role.results.map((hit) => hit.regionId)).toEqual(["r4"]);

    for (const field of ["section.purpose", "region.tag", "region.role"] as const) {
      const invalid = compilePredicates({
        kind: "sections",
        predicates: [{ field, values: ["definitely_not_a_value"] }],
      });
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) expect(invalid.error.code).toBe("UNSUPPORTED_PREDICATE");
    }
    const unknownField = compilePredicates({
      kind: "sections",
      predicates: [{ field: "section.colour" as never, values: ["dark"] }],
    });
    expect(unknownField.ok).toBe(false);
    if (!unknownField.ok) expect(unknownField.error.code).toBe("UNSUPPORTED_PREDICATE");

    const reserved = compilePredicates({
      kind: "sections",
      predicates: [{ field: "section.purpose", values: ["announcement"] }],
    });
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) expect(reserved.error.code).toBe("UNSUPPORTED_PREDICATE");

    const componentKind = searchAtlas(
      { kind: "components" },
      memoryStore(makeSnapshot([])),
      SEARCH_NOW,
    );
    expect(componentKind.ok).toBe(true);
    if (componentKind.ok) expect(componentKind.data.outcome).toBe("empty_corpus");

    const sectionOnlyField = compilePredicates({
      kind: "components",
      predicates: [{ field: "section.purpose", values: ["hero"] }],
    });
    expect(sectionOnlyField.ok).toBe(false);
    if (!sectionOnlyField.ok) {
      expect(sectionOnlyField.error.code).toBe("UNSUPPORTED_PREDICATE");
    }
  });
});

describe("Atlas landmark vocabulary", () => {
  const snapshot = makeSnapshot([
    { id: "header", landmark: "header" },
    { id: "banner-old", landmark: "banner" },
    { id: "footer", landmark: "footer" },
    { id: "contentinfo-old", landmark: "contentinfo" },
    { id: "nav", landmark: "navigation" },
  ]);

  it("canonicalizes banner/contentinfo on read and query", () => {
    const header = dataOrThrow(
      searchAtlas(
        { kind: "sections", predicates: [{ field: "region.landmark", values: ["header"] }] },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(header.results.map((hit) => hit.regionId)).toEqual(["header", "banner-old"]);

    const banner = dataOrThrow(
      searchAtlas(
        { kind: "sections", predicates: [{ field: "region.landmark", values: ["banner"] }] },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(banner.interpreted.predicates[0]!.values).toEqual(["header"]);
    expect(banner.results.map((hit) => hit.regionId)).toEqual(["header", "banner-old"]);

    const footer = dataOrThrow(
      searchAtlas(
        { kind: "sections", predicates: [{ field: "region.landmark", values: ["footer"] }] },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(footer.results.map((hit) => hit.regionId)).toEqual(["footer", "contentinfo-old"]);
  });

  it("filters facet values through the same canonicalization", () => {
    const data = dataOrThrow(
      searchAtlas(
        { kind: "sections", facets: ["region.landmark"], limit: 20 },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    const facet = data.facets[0]!;
    expect(facet.values.find((value) => value.value === "header")!.count).toBe(2);
    expect(facet.values.find((value) => value.value === "footer")!.count).toBe(2);
    expect(facet.values.find((value) => value.value === "navigation")!.count).toBe(1);
    expect(facet.values.some((value) => value.value === "banner")).toBe(false);
    expect(facet.values.some((value) => value.value === "contentinfo")).toBe(false);
  });

  it("reports insufficient coverage when legacy selectors yield no tag", () => {
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          predicates: [{ field: "region.tag", values: ["section"] }],
        },
        memoryStore(makeSnapshot([{ id: "opaque", tag: null, selector: "main > .hero" }])),
        SEARCH_NOW,
      ),
    );
    expect(data.outcome).toBe("insufficient_coverage");
    expect(data.results).toEqual([]);
  });
});

describe("Atlas matched sample key", () => {
  const snapshot = makeSnapshot([
    { id: "hero", purpose: { value: "hero", sampleKey: "desktop:hero" }, tag: "section" },
  ]);

  it("is null unless a claim predicate actually matched", () => {
    const queryOnly = dataOrThrow(
      searchAtlas({ kind: "sections", query: "hero" }, memoryStore(snapshot, { hero: -1 }), SEARCH_NOW),
    );
    expect(queryOnly.results[0]!.matchedSampleKey).toBeNull();

    const structural = dataOrThrow(
      searchAtlas(
        { kind: "sections", predicates: [{ field: "region.tag", values: ["section"] }] },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(structural.results[0]!.matchedSampleKey).toBeNull();

    const claim = dataOrThrow(
      searchAtlas(
        { kind: "sections", predicates: [{ field: "section.purpose", values: ["hero"] }] },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(claim.results[0]!.matchedSampleKey).toBe("desktop:hero");
  });

  it("uses a sample key shared by every repeated purpose predicate", () => {
    const shared = makeSnapshot([
      { id: "s1", page: "shared-page", purpose: { value: "hero", sampleKey: "s1" } },
      { id: "s2", page: "shared-page", purpose: { value: "about", sampleKey: "s2" } },
      {
        id: "s3",
        page: "shared-page",
        purpose: [
          { value: "hero", sampleKey: "s3" },
          { value: "about", sampleKey: "s3" },
        ],
      },
    ]);
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          scope: "page",
          predicates: [
            { field: "section.purpose", values: ["hero"] },
            { field: "section.purpose", values: ["about"] },
          ],
          limit: 20,
        },
        memoryStore(shared),
        SEARCH_NOW,
      ),
    );
    const s3 = data.results.find((hit) => hit.regionId === "s3")!;
    // Old behavior returned the first purpose predicate's MIN (s1).
    expect(s3.matchedSampleKey).toBe("s3");
    expect(data.results.every((hit) => hit.matchedSampleKey !== "s1")).toBe(true);
  });

  it("requires one sample key to carry both repeated predicates in a region", () => {
    const snapshot = makeSnapshot([
      {
        id: "split-keys",
        purpose: [
          { value: "hero", sampleKey: "k1" },
          { value: "about", sampleKey: "k2" },
        ],
      },
      {
        id: "shared-key",
        purpose: [
          { value: "hero", sampleKey: "k3" },
          { value: "about", sampleKey: "k3" },
        ],
      },
    ]);
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          predicates: [
            { field: "section.purpose", values: ["hero"] },
            { field: "section.purpose", values: ["about"] },
          ],
          limit: 20,
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(data.total).toBe(1);
    expect(data.results.map((hit) => hit.regionId)).toEqual(["shared-key"]);
    expect(data.results[0]!.matchedSampleKey).toBe("k3");
  });
});

describe("Atlas search facets", () => {
  const snapshot = makeSnapshot([
    { id: "a", purpose: { value: "hero" }, tag: "section", landmark: "main", site: "site-a" },
    { id: "b", purpose: { value: "hero" }, tag: "div", landmark: "main", site: "site-a" },
    { id: "c", purpose: { value: "about" }, tag: "section", site: "site-b" },
    { id: "d", purpose: { value: "pricing" }, tag: "footer", landmark: "contentinfo", site: "site-a" },
  ]);

  it("computes exact disjunctive counts for the local corpus", () => {
    const data = dataOrThrow(
      searchAtlas(
        { kind: "sections", facets: ["section.purpose", "region.tag"], limit: 20 },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    const purpose = data.facets.find((facet) => facet.field === "section.purpose")!;
    expect(purpose.disjunctive).toBe(true);
    expect(purpose.countUnit).toBe("region_instance");
    expect(purpose.values.find((value) => value.value === "hero")).toMatchObject({
      count: 2,
      selected: false,
    });
    expect(purpose.values.find((value) => value.value === "about")!.count).toBe(1);
    expect(purpose.values.find((value) => value.value === "pricing")!.count).toBe(1);

    const tag = data.facets.find((facet) => facet.field === "region.tag")!;
    expect(tag.values.find((value) => value.value === "section")!.count).toBe(2);
    expect(tag.values.find((value) => value.value === "div")!.count).toBe(1);
    expect(tag.values.find((value) => value.value === "footer")!.count).toBe(1);
  });

  it("includes selected values with zero matches", () => {
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          predicates: [{ field: "section.purpose", values: ["contact"] }],
          facets: ["section.purpose"],
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(data.results).toEqual([]);
    const purpose = data.facets[0]!;
    expect(purpose.values.find((value) => value.value === "hero")!.count).toBe(2);
    expect(purpose.values.find((value) => value.value === "contact")).toEqual({
      value: "contact",
      count: 0,
      selected: true,
    });
  });

  it("removes only the facet dimension predicate and keeps other filters", () => {
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          predicates: [
            { field: "section.purpose", values: ["hero"] },
            { field: "region.tag", values: ["section"] },
          ],
          facets: ["section.purpose"],
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    const purpose = data.facets[0]!;
    expect(purpose.values.find((value) => value.value === "hero")!.count).toBe(1);
    expect(purpose.values.find((value) => value.value === "about")!.count).toBe(1);
    expect(purpose.values.find((value) => value.value === "pricing")!.count).toBe(0);
  });

  it("counts the full eligible corpus beyond a 200-row candidate window", () => {
    const purposes = ["hero", "about", "pricing", "features", "contact"];
    const many = makeSnapshot(
      Array.from({ length: 250 }, (_, index) => ({
        id: `m${index}`,
        page: `many-page-${index}`,
        purpose: { value: purposes[index % purposes.length]! },
      })),
    );
    const data = dataOrThrow(
      searchAtlas(
        { kind: "sections", limit: 1, facets: ["section.purpose"] },
        memoryStore(many),
        SEARCH_NOW,
      ),
    );
    expect(data.total).toBe(250);
    expect(data.results).toHaveLength(1);
    expect(data.facets[0]!.values.find((value) => value.value === "hero")!.count).toBe(50);
  });

  it("keeps query filtering when a purpose facet excludes its own predicate", () => {
    const snapshot = makeSnapshot([
      { id: "alpha-hero", page: "alpha-1", purpose: { value: "hero" }, heading: "Alpha" },
      { id: "beta-hero", page: "beta-1", purpose: { value: "hero" }, heading: "Beta" },
      { id: "alpha-about", page: "alpha-2", purpose: { value: "about" }, heading: "Alpha" },
    ]);
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          query: "alpha",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
          facets: ["section.purpose"],
          limit: 20,
        },
        memoryStore(snapshot, { "alpha-hero": -5, "alpha-about": -4 }),
        SEARCH_NOW,
      ),
    );
    const purpose = data.facets[0]!;
    expect(purpose.values.find((value) => value.value === "hero")!.count).toBe(1);
    expect(purpose.values.find((value) => value.value === "about")!.count).toBe(1);
  });

  it("never changes facet counts through limit", () => {
    const first = dataOrThrow(
      searchAtlas(
        { kind: "sections", limit: 1, facets: ["section.purpose"] },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    const all = dataOrThrow(
      searchAtlas(
        { kind: "sections", limit: 20, facets: ["section.purpose"] },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(first.facets).toEqual(all.facets);
    expect(first.total).toBe(all.total);

    const tooMany = searchAtlas(
      {
        kind: "sections",
        facets: ["section.purpose", "region.tag", "region.role", "region.landmark", "region.kind"],
      },
      memoryStore(snapshot),
      SEARCH_NOW,
    );
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error.code).toBe("INVALID_INPUT");
  });
});

describe("Atlas region kind support", () => {
  const snapshot = makeSnapshot([
    { id: "a", tag: "section", site: "site-a" },
    { id: "b", tag: "section", site: "site-b" },
  ]);

  it("accepts only section as a region.kind predicate", () => {
    for (const field of ["page", "highlight", "component"] as const) {
      const compiled = compilePredicates({
        kind: "sections",
        predicates: [{ field: "region.kind", values: [field] }],
      });
      expect(compiled.ok).toBe(false);
      if (!compiled.ok) {
        expect(compiled.error.code).toBe("UNSUPPORTED_PREDICATE");
      }
    }
    const compiled = compilePredicates({
      kind: "sections",
      predicates: [{ field: "region.kind", values: ["section"] }],
    });
    expect(compiled.ok).toBe(true);
  });

  it("does not match a section anchor through an unsupported kind", () => {
    const compiled = compilePredicates({
      kind: "sections",
      predicates: [{ field: "region.kind", values: ["page"] }],
    });
    expect(compiled.ok).toBe(false);

    for (const scope of ["region", "page"] as const) {
      const data = dataOrThrow(
        searchAtlas(
          {
            kind: "sections",
            predicates: [{ field: "region.kind", values: ["section"] }],
            scope,
          },
          memoryStore(snapshot),
          SEARCH_NOW,
        ),
      );
      expect(data.total).toBe(2);
      expect(data.results.every((hit) => hit.kind === "section")).toBe(true);
    }

    const pageScope = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          predicates: [{ field: "region.kind", values: ["section"] }],
          scope: "page",
          facets: ["region.kind"],
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    const kindFacet = pageScope.facets.find((facet) => facet.field === "region.kind")!;
    expect(kindFacet.values).toEqual([
      { value: "section", count: 2, selected: true },
    ]);
  });
});

describe("Atlas facet filterability", () => {
  it("emits only values compilePredicates accepts", () => {
    const snapshot = makeSnapshot([
      {
        id: "a",
        tag: "my-widget",
        role: "customrole",
        landmark: "banner",
        purpose: { value: "hero" },
        site: "site-a",
      },
      {
        id: "b",
        tag: "section",
        role: "region",
        landmark: "main",
        purpose: { value: "about" },
        site: "site-a",
      },
    ]);
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          facets: ["region.tag", "region.role", "region.landmark", "section.purpose"],
          limit: 20,
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    for (const facet of data.facets) {
      expect(facet.values.length).toBeGreaterThan(0);
      for (const value of facet.values) {
        const compiled = compilePredicates({
          kind: "sections",
          predicates: [{ field: facet.field, values: [value.value] }],
        });
        expect(compiled.ok, `${facet.field}=${value.value}`).toBe(true);
      }
    }
    const tagValues = data.facets.find((facet) => facet.field === "region.tag")!.values;
    expect(tagValues.some((value) => value.value === "my-widget")).toBe(false);
    const roleValues = data.facets.find((facet) => facet.field === "region.role")!.values;
    expect(roleValues.some((value) => value.value === "customrole")).toBe(false);
    const landmarkValues = data.facets.find((facet) => facet.field === "region.landmark")!.values;
    expect(landmarkValues.some((value) => value.value === "banner")).toBe(false);
    expect(landmarkValues.some((value) => value.value === "header")).toBe(true);
  });
});

describe("Atlas search ranking", () => {
  it("ranks text queries by bm25, evidence tier, observation time and id", () => {
    const snapshot = makeSnapshot([
      {
        id: "bm25-better",
        page: "rank-1",
        purpose: { value: "hero", decision: "accepted", classification: "inferred" },
        observedAt: SEARCH_NOW - SEARCH_DAY,
      },
      {
        id: "bm25-worse",
        page: "rank-2",
        purpose: { value: "hero", decision: "accepted", classification: "inferred" },
        observedAt: SEARCH_NOW - SEARCH_DAY,
      },
      {
        id: "observed-better",
        page: "rank-3",
        purpose: { value: "hero", decision: "accepted", classification: "observed" },
        observedAt: SEARCH_NOW - 2 * SEARCH_DAY,
      },
      {
        id: "newer",
        page: "rank-4",
        purpose: { value: "hero", decision: "accepted", classification: "inferred" },
        observedAt: SEARCH_NOW - 2 * SEARCH_DAY,
      },
    ]);
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          query: "hero",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
          limit: 20,
        },
        memoryStore(snapshot, {
          "bm25-better": -5,
          "bm25-worse": -1,
          "observed-better": -5,
          newer: -5,
        }),
        SEARCH_NOW,
      ),
    );
    expect(data.results.map((hit) => hit.regionId)).toEqual([
      "observed-better",
      "bm25-better",
      "newer",
      "bm25-worse",
    ]);

    const newest = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          query: "hero",
          sort: "newest",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
          limit: 20,
        },
        memoryStore(snapshot, {
          "bm25-better": -5,
          "bm25-worse": -1,
          "observed-better": -5,
          newer: -5,
        }),
        SEARCH_NOW,
      ),
    );
    expect(newest.results.map((hit) => hit.regionId)).toEqual([
      "bm25-better",
      "bm25-worse",
      "observed-better",
      "newer",
    ]);
  });

  it("ranks facet-only searches by tier, observation time, ordinal and id", () => {
    const snapshot = makeSnapshot([
      {
        id: "a-inferred",
        ordinal: 2,
        purpose: { value: "hero", decision: "accepted", classification: "inferred" },
        observedAt: SEARCH_NOW - SEARCH_DAY,
      },
      {
        id: "b-observed",
        ordinal: 1,
        purpose: { value: "hero", decision: "accepted", classification: "observed" },
        observedAt: SEARCH_NOW - 2 * SEARCH_DAY,
      },
      {
        id: "c-candidate",
        ordinal: 0,
        purpose: { value: "hero", decision: "candidate" },
        observedAt: SEARCH_NOW,
      },
      {
        id: "d-noclaim",
        ordinal: 3,
        observedAt: SEARCH_NOW - SEARCH_DAY,
      },
    ]);
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
          limit: 20,
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(data.results.map((hit) => hit.regionId)).toEqual([
      "b-observed",
      "a-inferred",
      "c-candidate",
    ]);
  });
});

describe("Atlas search pattern grouping", () => {
  it("rejects section pattern grouping until instance counts are exact", () => {
    const result = searchAtlas(
      { kind: "sections", groupBy: "pattern" },
      memoryStore(makeSnapshot([{ id: "p1", patternKey: "hero-pattern" }])),
      SEARCH_NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNSUPPORTED_GROUPING");
      expect(result.error.message).toContain("components");
    }
  });
});

describe("Atlas search pagination", () => {
  it("paginates without overlap and keeps the total stable", () => {
    const snapshot = makeSnapshot(
      Array.from({ length: 5 }, (_, index) => ({
        id: `s${index}`,
        observedAt: SEARCH_NOW - (index + 1) * SEARCH_DAY,
      })),
    );
    const first = dataOrThrow(
      searchAtlas({ kind: "sections", limit: 2 }, memoryStore(snapshot), SEARCH_NOW),
    );
    expect(first.total).toBe(5);
    expect(first.results).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = dataOrThrow(
      searchAtlas(
        { kind: "sections", limit: 2, cursor: first.nextCursor! },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    const third = dataOrThrow(
      searchAtlas(
        { kind: "sections", limit: 2, cursor: second.nextCursor! },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    const ids = [...first.results, ...second.results, ...third.results].map((hit) => hit.regionId);
    expect(new Set(ids).size).toBe(5);
    expect(third.nextCursor).toBeNull();

    const paginated = dataOrThrow(
      searchAtlas({ kind: "sections", limit: 20 }, memoryStore(snapshot), SEARCH_NOW),
    );
    expect(ids).toEqual(paginated.results.map((hit) => hit.regionId));
  });
});

// ---------------------------------------------------------------------------
// SQLite loader integration
// ---------------------------------------------------------------------------

interface SeedSection {
  id: string;
  heading?: string;
  text?: string;
  purpose?: string;
  decision?: "accepted" | "candidate";
  classification?: "observed" | "inferred";
  /** Claim state for the convenience purpose claim (default: default). */
  state?: "default" | "hover" | "focus";
  sampleKey?: string;
  tag?: string | null;
  selector?: string;
  role?: string | null;
  landmark?: string | null;
  patternKey?: string | null;
}

function seed(
  cache: Cache,
  options: {
    siteSlug?: string;
    pageId?: string;
    captureId?: string;
    profileKey?: string;
    observedAt?: number | null;
    lastConfirmedAt?: number | null;
    sourceFetchedAt?: number | null;
    status?: string;
    head?: boolean;
    fts?: boolean;
    revision?: number;
    sections: SeedSection[];
  },
): void {
  const siteSlug = options.siteSlug ?? "fixture-live";
  const pageId = options.pageId ?? `page-${siteSlug}`;
  const captureId = options.captureId ?? `capture-${pageId}`;
  const profileKey = options.profileKey ?? "live-desktop";
  const observedAt = options.observedAt === undefined ? SEARCH_NOW : options.observedAt;
  const lastConfirmedAt = options.lastConfirmedAt ?? null;
  const sourceFetchedAt = options.sourceFetchedAt ?? null;
  const now = SEARCH_NOW;
  cache.withAtlasDb((db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT OR IGNORE INTO sites
           (slug, id, title, createdAt, tags, thumbnailPath, liveUrl, detailPath, awards, fetchedAt)
         VALUES (?, ?, ?, ?, '[]', '', ?, '', '[]', ?)`,
      ).run(
        siteSlug,
        1,
        `${siteSlug} title`,
        now,
        `https://${siteSlug}.example/`,
        now,
      );
      db.prepare(
        `INSERT OR IGNORE INTO atlas_pages (id, site_slug, kind, url_key, public_url, path, created_at)
         VALUES (?, ?, 'live_page', ?, ?, '/', ?)`,
      ).run(pageId, siteSlug, `url-key-${pageId}`, `https://www.awwwards.com/sites/${siteSlug}`, now);
      db.prepare(
        `INSERT INTO atlas_captures
           (id, attempt_id, page_id, source_kind, profile_key, config_hash, status,
            started_at, finished_at, observed_at, source_fetched_at, last_confirmed_at,
            source_digest, config_json, policy_json, coverage_json, error_json,
            extractor_version, classifier_version)
         VALUES (?, ?, ?, 'live_page', ?, ?, 'running', ?, NULL, ?, ?, ?, ?, '{}', '{}', ?, NULL, 'test', 'test')`,
      ).run(
        captureId,
        `attempt-${captureId}`,
        pageId,
        profileKey,
        `config-${captureId}`,
        now - 1_000,
        observedAt,
        sourceFetchedAt,
        lastConfirmedAt,
        `digest-${captureId}`,
        JSON.stringify({ status: "complete", collected: options.sections.length, excluded: 0, limitations: [] }),
      );
      const root = `${captureId}:root`;
      db.prepare(
        `INSERT INTO atlas_regions
           (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
            text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
         VALUES (?, ?, NULL, 'page', 0, NULL, NULL, '', '', NULL, NULL, '{}', NULL, ?)`,
      ).run(
        root,
        captureId,
        JSON.stringify({ status: "complete", collected: 1, excluded: 0, limitations: [] }),
      );
      options.sections.forEach((section, index) => {
        const selector = section.selector ?? `main > section.${section.id}`;
        const locator =
          section.tag === undefined ? { selector } : { selector, tag: section.tag };
        db.prepare(
          `INSERT INTO atlas_regions
             (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
              text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
           VALUES (?, ?, ?, 'section', ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?)`,
        ).run(
          section.id,
          captureId,
          root,
          index + 1,
          JSON.stringify(locator),
          section.heading ?? "",
          section.text ?? "",
          section.heading ?? null,
          JSON.stringify({ role: section.role ?? null, landmark: section.landmark ?? null }),
          section.patternKey ?? null,
          JSON.stringify({ status: "complete", collected: 1, excluded: 0, limitations: [] }),
        );
        let purposeIndex = 0;
        if (section.purpose) {
          db.prepare(
            `INSERT INTO atlas_claims
               (id, region_id, field, value, sample_key, classification, basis, decision,
                state, rule_id, rule_version, evidence_json, limitations_json, review_json)
             VALUES (?, ?, 'section.purpose', ?, ?, ?, 'rule_derivation', ?, ?, NULL, NULL, '[]', '[]', NULL)`,
          ).run(
            `${section.id}:claim:${purposeIndex}`,
            section.id,
            section.purpose,
            section.sampleKey ?? `desktop:${section.id}`,
            section.classification ?? "inferred",
            section.decision ?? "candidate",
            section.state ?? "default",
          );
          purposeIndex += 1;
        }
        if (options.fts) {
          db.prepare(
            `INSERT INTO atlas_regions_fts (region_id, title, heading, copy, labels, context)
             VALUES (?, ?, ?, ?, '', ?)`,
          ).run(
            section.id,
            section.heading ?? "",
            section.heading ?? "",
            section.text ?? "",
            siteSlug,
          );
        }
      });
      db.prepare("UPDATE atlas_captures SET status = ?, finished_at = ? WHERE id = ?").run(
        options.status ?? "complete",
        now,
        captureId,
      );
      if (options.head ?? true) {
        db.prepare(
          "INSERT INTO atlas_heads (page_id, profile_key, capture_id, published_at) VALUES (?, ?, ?, ?)",
        ).run(pageId, profileKey, captureId, now);
      }
      if (options.revision !== undefined) {
        db.prepare("UPDATE atlas_state SET revision = ? WHERE singleton = 1").run(options.revision);
      }
      // Search is read-only; tests that seed rows directly rebuild the same
      // projections publish would have written.
      const revision = (
        db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
          revision: number;
        }
      ).revision;
      rebuildAtlasSearchProjections(db, revision);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

describe("Atlas search SQLite snapshot loader", () => {
  it("loads active heads, site metadata, FTS scores and derives tags for old rows", () => {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    seed(cache, {
      fts: true,
      sections: [
        { id: "s1", heading: "Pricing plans", purpose: "pricing", tag: "section" },
        {
          id: "s2",
          heading: "Build what matters",
          purpose: "hero",
          tag: undefined,
          selector: "main > section.hero",
        },
      ],
    });
    const snapshot = loadAtlasSearchSnapshot(cache, {
      asOf: SEARCH_NOW,
      maxAgeDays: 30,
      viewport: "desktop",
      state: "default",
      query: "pricing",
    });
    expect(snapshot.revision).toBe(0);
    expect(snapshot.ftsAvailable).toBe(true);
    expect(snapshot.regions).toHaveLength(2);
    const old = snapshot.regions.find((region) => region.id === "s2")!;
    expect(old.tag).toBe("section");
    expect(snapshot.regions.find((region) => region.id === "s1")!.tag).toBe("section");
    expect(snapshot.sites[0]).toEqual({
      slug: "fixture-live",
      title: "fixture-live title",
      liveUrl: "https://fixture-live.example/",
    });
    expect(snapshot.pages).toHaveLength(1);
    expect(snapshot.captures).toHaveLength(1);
    expect(snapshot.captures[0]!.viewport).toBe("desktop");
    expect(snapshot.bm25.s1).toBeLessThan(0);
    expect(snapshot.bm25.s2).toBeUndefined();
    expect(snapshot.claims.map((claim) => claim.regionId).sort()).toEqual(["s1", "s2"]);
  });

  it("runs the full search path against SQLite and keeps page scope local", () => {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    seed(cache, {
      fts: true,
      sections: [
        { id: "s1", heading: "Pricing plans", purpose: "pricing", tag: "section" },
        { id: "s2", heading: "Build what matters", purpose: "hero", tag: "section" },
      ],
    });
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          query: "pricing",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
          scope: "page",
        },
        atlasSearchStore(cache),
        SEARCH_NOW,
      ),
    );
    expect(data.results.map((hit) => hit.regionId)).toEqual(["s1"]);
    expect(data.results[0]!.explanations[0]!.supportingRegionIds).toEqual(["s2"]);
    expect(data.results[0]!.siteTitle).toBe("fixture-live title");
    expect(data.results[0]!.sitePublicUrl).toBe("https://fixture-live.example/");
  });

  it("excludes non-head, non-live, stale and unknown-time captures", () => {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    seed(cache, { pageId: "head-page", captureId: "head-capture", sections: [{ id: "head" }] });
    seed(cache, {
      pageId: "head-page",
      captureId: "orphan-capture",
      head: false,
      sections: [{ id: "orphan" }],
    });
    seed(cache, {
      pageId: "stale-page",
      captureId: "stale-capture",
      observedAt: SEARCH_NOW - 40 * SEARCH_DAY,
      sections: [{ id: "stale" }],
    });
    seed(cache, {
      pageId: "unknown-page",
      captureId: "unknown-capture",
      observedAt: null,
      sections: [{ id: "unknown-time" }],
    });
    seed(cache, {
      pageId: "partial-page",
      captureId: "partial-capture",
      status: "unknown",
      sections: [{ id: "bad-status" }],
    });
    const snapshot = loadAtlasSearchSnapshot(cache, {
      asOf: SEARCH_NOW,
      maxAgeDays: 30,
      viewport: "desktop",
      state: "default",
    });
    expect(snapshot.regions.map((region) => region.id)).toEqual(["head"]);
  });

  it("parses the last selector compound and never invents a tag", () => {
    expect(deriveRegionTag(undefined, "main > section.hero")).toBe("section");
    expect(deriveRegionTag(undefined, "main > article.insight:nth-child(2)")).toBe("article");
    expect(deriveRegionTag(undefined, "main > .hero")).toBeNull();
    expect(deriveRegionTag(undefined, "main > [data-section]")).toBeNull();
    expect(deriveRegionTag(undefined, "div.foo > :scope")).toBeNull();
    expect(deriveRegionTag("SECTION", "main > div")).toBe("section");
  });

  it("does not use source_fetched_at as a live freshness fallback", () => {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    seed(cache, {
      pageId: "source-only",
      captureId: "source-only-capture",
      observedAt: null,
      lastConfirmedAt: null,
      sourceFetchedAt: SEARCH_NOW,
      sections: [{ id: "source-only" }],
    });
    const snapshot = loadAtlasSearchSnapshot(cache, {
      asOf: SEARCH_NOW,
      maxAgeDays: 30,
      viewport: "desktop",
      state: "default",
    });
    expect(snapshot.regions).toEqual([]);
    const data = dataOrThrow(
      searchAtlas({ kind: "sections" }, atlasSearchStore(cache), SEARCH_NOW),
    );
    expect(data.outcome).toBe("empty_corpus");
    expect(data.results).toEqual([]);
  });

  it("keeps a boundary region on page two at the cursor asOf", () => {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    seed(cache, {
      pageId: "boundary-0",
      captureId: "boundary-0-capture",
      observedAt: SEARCH_NOW - SEARCH_DAY,
      sections: [{ id: "boundary-0" }],
    });
    seed(cache, {
      pageId: "boundary-1",
      captureId: "boundary-1-capture",
      observedAt: SEARCH_NOW - 2 * SEARCH_DAY,
      sections: [{ id: "boundary-1" }],
    });
    seed(cache, {
      pageId: "boundary-2",
      captureId: "boundary-2-capture",
      observedAt: SEARCH_NOW - 30 * SEARCH_DAY + 60_000,
      sections: [{ id: "boundary-2" }],
    });
    const first = dataOrThrow(
      searchAtlas({ kind: "sections", limit: 2 }, atlasSearchStore(cache), SEARCH_NOW),
    );
    expect(first.results.map((hit) => hit.regionId)).toEqual(["boundary-0", "boundary-1"]);

    const second = dataOrThrow(
      searchAtlas(
        { kind: "sections", limit: 2, cursor: first.nextCursor! },
        atlasSearchStore(cache),
        SEARCH_NOW + 2 * 60_000,
      ),
    );
    expect(second.asOf).toBe(SEARCH_NOW);
    expect(second.results.map((hit) => hit.regionId)).toEqual(["boundary-2"]);

    const withoutCursor = dataOrThrow(
      searchAtlas({ kind: "sections", limit: 2 }, atlasSearchStore(cache), SEARCH_NOW + 2 * 60_000),
    );
    expect(withoutCursor.results.map((hit) => hit.regionId)).toEqual([
      "boundary-0",
      "boundary-1",
    ]);
    expect(withoutCursor.total).toBe(2);
  });

  it("returns bounded artifact descriptors and falls back to external URLs", () => {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    seed(cache, {
      pageId: "artifact-page",
      captureId: "artifact-capture",
      sections: [{ id: "artifact-anchor" }],
    });
    cache.withAtlasDb((db) => {
      const insert = db.prepare(
        `INSERT INTO atlas_artifacts
           (id, capture_id, region_id, kind, storage_path, external_url, sha256, bytes,
            mime_type, state, rights_json, metadata_json)
         VALUES (?, 'artifact-capture', 'artifact-anchor', ?, ?, ?, ?, ?, 'image/png', 'ready', '{}', '{}')`,
      );
      insert.run(
        "a-external",
        "raw_observation",
        null,
        "https://example.test/artifact.png",
        null,
        null,
      );
      for (let index = 0; index < 8; index += 1) {
        insert.run(
          `artifact-${index}`,
          "screenshot",
          `atlas/artifact-${index}.png`,
          null,
          `sha-${index}`,
          100 + index,
        );
      }
    });
    const data = dataOrThrow(
      searchAtlas(
        { kind: "sections", predicates: [{ field: "region.tag", values: ["section"] }] },
        atlasSearchStore(cache),
        SEARCH_NOW,
      ),
    );
    const artifacts = data.results[0]!.artifacts;
    expect(artifacts).toHaveLength(8);
    expect(artifacts[0]).toEqual({
      kind: "raw_observation",
      storagePath: "https://example.test/artifact.png",
      sha256: null,
      bytes: null,
      mimeType: "image/png",
    });
  });

  it("requires every query token and supports prefix terms", () => {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    seed(cache, {
      fts: true,
      sections: [
        { id: "s1", heading: "Pricing plans for teams", text: "Pricing plans for teams" },
        { id: "s2", heading: "Pricing", text: "Pricing" },
        { id: "s3", heading: "Hero", text: "Hero" },
      ],
    });
    const run = (query: string) =>
      dataOrThrow(searchAtlas({ kind: "sections", query, limit: 20 }, atlasSearchStore(cache), SEARCH_NOW));
    expect(run("pric").results.map((hit) => hit.regionId).sort()).toEqual(["s1", "s2"]);
    expect(run("pricing teams").results.map((hit) => hit.regionId)).toEqual(["s1"]);
    expect(run("pricing missing").results).toEqual([]);
    expect(run("hero").results.map((hit) => hit.regionId)).toEqual(["s3"]);
  });
});

describe("Atlas section search projections", () => {
  it("counts page and site structural facets per region, not per capture", () => {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    seed(cache, {
      siteSlug: "facet-site",
      pageId: "facet-page",
      captureId: "facet-capture",
      sections: [
        { id: "facet-footer", purpose: "footer", tag: "footer" },
        { id: "facet-section-1", purpose: "hero", tag: "section" },
        { id: "facet-section-2", purpose: "about", tag: "section" },
      ],
    });
    for (const scope of ["page", "site"] as const) {
      const data = dataOrThrow(
        searchAtlas(
          { kind: "sections", scope, facets: ["region.tag"], limit: 20 },
          atlasSearchStore(cache),
          SEARCH_NOW,
        ),
      );
      expect(data.total).toBe(3);
      const tag = data.facets.find((facet) => facet.field === "region.tag")!;
      // A capture-level sum would report footer: 3 and section: 3 here.
      expect(tag.values.find((value) => value.value === "footer")!.count).toBe(1);
      expect(tag.values.find((value) => value.value === "section")!.count).toBe(2);
    }
  });

  it("counts legacy selector fallback tags without another predicate", () => {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    seed(cache, {
      pageId: "legacy-tag-page",
      captureId: "legacy-tag-capture",
      sections: [{ id: "legacy-tag", tag: undefined, selector: "main > footer.legacy" }],
    });
    const data = dataOrThrow(
      searchAtlas(
        { kind: "sections", facets: ["region.tag"] },
        atlasSearchStore(cache),
        SEARCH_NOW,
      ),
    );
    const tag = data.facets.find((facet) => facet.field === "region.tag")!;
    expect(tag.values.find((value) => value.value === "footer")!.count).toBe(1);
  });

  it("counts query facets from the matched regions, not the whole capture", () => {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    seed(cache, {
      pageId: "query-facet-page",
      captureId: "query-facet-capture",
      fts: true,
      sections: [
        {
          id: "query-facet-footer",
          purpose: "footer",
          tag: "footer",
          heading: "Contact",
          text: "Contact and legal",
        },
        {
          id: "query-facet-pricing",
          purpose: "pricing",
          tag: "section",
          heading: "Pricing plans",
          text: "Pricing plans",
        },
        {
          id: "query-facet-about",
          purpose: "about",
          tag: "section",
          heading: "About us",
          text: "About us",
        },
      ],
    });
    for (const scope of ["page", "site"] as const) {
      const data = dataOrThrow(
        searchAtlas(
          {
            kind: "sections",
            scope,
            query: "pricing",
            facets: ["region.tag", "section.purpose"],
            limit: 20,
          },
          atlasSearchStore(cache),
          SEARCH_NOW,
        ),
      );
      expect(data.total).toBe(1);
      const tag = data.facets.find((facet) => facet.field === "region.tag")!;
      // A capture-level facet would report footer: 1 and section: 2 here.
      expect(tag.values.find((value) => value.value === "footer")!.count).toBe(0);
      expect(tag.values.find((value) => value.value === "section")!.count).toBe(1);
      const purpose = data.facets.find((facet) => facet.field === "section.purpose")!;
      expect(purpose.values.find((value) => value.value === "pricing")!.count).toBe(1);
      expect(purpose.values.find((value) => value.value === "about")!.count).toBe(0);
      expect(purpose.values.find((value) => value.value === "footer")!.count).toBe(0);
    }

    // Without a query the capture totals are unchanged.
    const all = dataOrThrow(
      searchAtlas(
        { kind: "sections", scope: "page", facets: ["region.tag"], limit: 20 },
        atlasSearchStore(cache),
        SEARCH_NOW,
      ),
    );
    expect(all.total).toBe(3);
    const tag = all.facets.find((facet) => facet.field === "region.tag")!;
    expect(tag.values.find((value) => value.value === "footer")!.count).toBe(1);
    expect(tag.values.find((value) => value.value === "section")!.count).toBe(2);
  });

  it("sums purpose regions per capture and excludes stale captures", () => {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    seed(cache, {
      pageId: "sum-a-page",
      captureId: "sum-a",
      sections: [
        { id: "sum-a-pricing-1", purpose: "pricing", tag: "section" },
        { id: "sum-a-pricing-2", purpose: "pricing", tag: "section" },
        { id: "sum-a-about", purpose: "about", tag: "section" },
      ],
    });
    // Same site, footer tag: the tag predicate below keeps it out of the facet
    // capture set, so the purpose count must come from the remaining capture.
    seed(cache, {
      pageId: "sum-b-page",
      captureId: "sum-b",
      sections: [{ id: "sum-b-pricing", purpose: "pricing", tag: "footer" }],
    });
    seed(cache, {
      pageId: "sum-c-page",
      captureId: "sum-c",
      observedAt: SEARCH_NOW - 40 * SEARCH_DAY,
      sections: [
        { id: "sum-c-pricing-1", purpose: "pricing", tag: "section" },
        { id: "sum-c-pricing-2", purpose: "pricing", tag: "section" },
      ],
    });
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          scope: "page",
          predicates: [{ field: "region.tag", values: ["section"] }],
          facets: ["section.purpose"],
          limit: 20,
        },
        atlasSearchStore(cache),
        SEARCH_NOW,
      ),
    );
    const purpose = data.facets[0]!;
    // COUNT(*) over the capture purpose rows would report 1 pricing.
    expect(purpose.values.find((value) => value.value === "pricing")!.count).toBe(2);
    expect(purpose.values.find((value) => value.value === "about")!.count).toBe(1);
  });

  it("keeps stale purposes out of the all-scope purpose facet fast path", () => {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    seed(cache, {
      pageId: "fast-pricing-page",
      captureId: "fast-pricing",
      sections: [
        { id: "fast-pricing-1", purpose: "pricing", tag: "section" },
        { id: "fast-pricing-2", purpose: "pricing", tag: "section" },
        { id: "fast-hero", purpose: "hero", tag: "section" },
      ],
    });
    seed(cache, {
      pageId: "fast-stale-page",
      captureId: "fast-stale",
      observedAt: SEARCH_NOW - 40 * SEARCH_DAY,
      sections: Array.from({ length: 5 }, (_, index) => ({
        id: `fast-stale-${index}`,
        purpose: "pricing",
        tag: "section",
      })),
    });
    const data = dataOrThrow(
      searchAtlas(
        { kind: "sections", scope: "page", facets: ["section.purpose"], limit: 20 },
        atlasSearchStore(cache),
        SEARCH_NOW,
      ),
    );
    const purpose = data.facets[0]!;
    expect(purpose.values.find((value) => value.value === "pricing")!.count).toBe(2);
    expect(purpose.values.find((value) => value.value === "hero")!.count).toBe(1);
  });

  it("orders site results by eligible-capture tier, not stale evidence", () => {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    seed(cache, {
      siteSlug: "tier-site-a",
      pageId: "tier-stale-page",
      captureId: "tier-stale-capture",
      observedAt: SEARCH_NOW - 40 * SEARCH_DAY,
      sections: [
        {
          id: "tier-stale",
          purpose: "hero",
          decision: "accepted",
          classification: "observed",
        },
      ],
    });
    seed(cache, {
      siteSlug: "tier-site-a",
      pageId: "tier-fresh-page",
      captureId: "tier-fresh-capture",
      observedAt: SEARCH_NOW - 2 * SEARCH_DAY,
      sections: [
        {
          id: "tier-fresh",
          purpose: "hero",
          decision: "accepted",
          classification: "inferred",
        },
      ],
    });
    seed(cache, {
      siteSlug: "tier-site-b",
      pageId: "tier-b-page",
      captureId: "tier-b-capture",
      observedAt: SEARCH_NOW - SEARCH_DAY,
      sections: [
        {
          id: "tier-b",
          purpose: "hero",
          decision: "accepted",
          classification: "inferred",
        },
      ],
    });
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          scope: "site",
          evidenceMode: "accepted",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
          limit: 20,
        },
        atlasSearchStore(cache),
        SEARCH_NOW,
      ),
    );
    // Both eligible sites are tier 2; the stale observed capture must not
    // promote site-a to tier 1. Newer eligible evidence orders site-b first.
    expect(data.results.map((hit) => hit.siteSlug)).toEqual(["tier-site-b", "tier-site-a"]);
  });

  it("keeps a site's desktop evidence out of a mobile-only match", () => {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    seed(cache, {
      siteSlug: "desktop-site",
      pageId: "desktop-page",
      captureId: "desktop-capture",
      sections: [{ id: "desktop-pricing", purpose: "pricing", tag: "section" }],
    });
    seed(cache, {
      siteSlug: "mobile-site",
      pageId: "mobile-page",
      captureId: "mobile-capture",
      profileKey: "live-mobile",
      sections: [{ id: "mobile-pricing", purpose: "pricing", tag: "section" }],
    });
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          predicates: [{ field: "section.purpose", values: ["pricing"] }],
          scope: "site",
          facets: ["section.purpose", "region.tag"],
        },
        atlasSearchStore(cache),
        SEARCH_NOW,
      ),
    );
    expect(data.results.map((hit) => hit.siteSlug)).toEqual(["desktop-site"]);
    expect(data.total).toBe(1);
    const purposeFacet = data.facets.find((facet) => facet.field === "section.purpose")!;
    expect(purposeFacet.values.find((value) => value.value === "pricing")).toMatchObject({
      count: 1,
      selected: true,
    });
    const tagFacet = data.facets.find((facet) => facet.field === "region.tag")!;
    expect(tagFacet.values.find((value) => value.value === "section")?.count).toBe(1);
  });

  it("counts no stale capture in site predicates or facets", () => {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    seed(cache, {
      siteSlug: "stale-site",
      pageId: "stale-page",
      captureId: "stale-capture",
      observedAt: SEARCH_NOW - 40 * SEARCH_DAY,
      sections: [{ id: "stale-pricing", purpose: "pricing", tag: "section" }],
    });
    const input = {
      kind: "sections" as const,
      predicates: [{ field: "section.purpose" as const, values: ["pricing"] }],
      scope: "site" as const,
      facets: ["section.purpose" as const],
    };
    const stale = dataOrThrow(searchAtlas(input, atlasSearchStore(cache), SEARCH_NOW));
    expect(stale.total).toBe(0);
    expect(stale.results).toEqual([]);
    expect(
      stale.facets[0]!.values.find((value) => value.value === "pricing")?.count,
    ).toBe(0);

    const widened = dataOrThrow(
      searchAtlas({ ...input, maxAgeDays: 90 }, atlasSearchStore(cache), SEARCH_NOW),
    );
    expect(widened.total).toBe(1);
    expect(widened.facets[0]!.values.find((value) => value.value === "pricing")?.count).toBe(1);
  });

  it("runs site scope without predicates for text and non-text searches", () => {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    seed(cache, {
      siteSlug: "plain-site",
      pageId: "plain-page",
      captureId: "plain-capture",
      fts: true,
      sections: [
        { id: "plain-pricing", heading: "Pricing plans", text: "Pricing plans", purpose: "pricing" },
        { id: "plain-hero", heading: "Hero", text: "Hero", purpose: "hero" },
      ],
    });
    const all = dataOrThrow(
      searchAtlas({ kind: "sections", scope: "site" }, atlasSearchStore(cache), SEARCH_NOW),
    );
    expect(all.total).toBe(2);
    expect(all.results).toHaveLength(2);
    expect(all.results[0]!.observationSpan).toBeDefined();

    const text = dataOrThrow(
      searchAtlas(
        { kind: "sections", scope: "site", query: "pricing" },
        atlasSearchStore(cache),
        SEARCH_NOW,
      ),
    );
    expect(text.results.map((hit) => hit.regionId)).toEqual(["plain-pricing"]);
  });

  it("echoes every selected purpose past the suggestion cap", () => {
    const selected = [
      "header",
      "navigation",
      "hero",
      "about",
      "features",
      "services",
      "process",
      "pricing",
      "testimonials",
      "logos",
      "metrics",
      "team",
      "portfolio_gallery",
      "case_study",
      "editorial_content",
      "resource_list",
      "cta",
      "contact",
      "newsletter",
      "faq",
      "footer",
      "other",
    ];
    const snapshot = makeSnapshot([
      { id: "pricing-section", purpose: { value: "pricing", decision: "accepted" } },
    ]);
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          predicates: [
            { field: "section.purpose", values: selected.slice(0, 8) },
            { field: "section.purpose", values: selected.slice(8, 16) },
            { field: "section.purpose", values: selected.slice(16) },
          ],
          facets: ["section.purpose"],
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    const facet = data.facets[0]!;
    expect(facet.values).toHaveLength(selected.length);
    expect(new Set(facet.values.map((value) => value.value))).toEqual(new Set(selected));
    expect(facet.values.every((value) => value.selected)).toBe(true);
  });
});

describe("Atlas state-aware SQLite facets", () => {
  const hoverPurpose = (
    id: string,
    purpose: string,
    overrides: Partial<SeedSection> = {},
  ): SeedSection => ({
    id,
    purpose,
    decision: "accepted",
    classification: "observed",
    state: "hover",
    sampleKey: `desktop:${id}:state-hover`,
    ...overrides,
  });

  function seedStateFacets(): Cache {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    seed(cache, {
      siteSlug: "facet-site-a",
      pageId: "facet-a-page",
      captureId: "facet-a",
      fts: true,
      sections: [
        hoverPurpose("facet-a-hero", "hero", { heading: "Alpha hero", text: "Alpha hero" }),
        hoverPurpose("facet-a-pricing", "pricing", { heading: "Pricing", text: "Pricing" }),
      ],
    });
    seed(cache, {
      siteSlug: "facet-site-b",
      pageId: "facet-b-page",
      captureId: "facet-b",
      sections: [hoverPurpose("facet-b-hero", "hero", { heading: "Beta hero", text: "Beta hero" })],
    });
    // Stale state evidence must never contribute to a facet count.
    seed(cache, {
      siteSlug: "facet-site-stale",
      pageId: "facet-stale-page",
      captureId: "facet-stale",
      observedAt: SEARCH_NOW - 40 * SEARCH_DAY,
      sections: [hoverPurpose("facet-stale-hero", "hero")],
    });
    return cache;
  }

  const facetCount = (data: SearchAtlasData, value: string): number | undefined =>
    data.facets[0]!.values.find((entry) => entry.value === value)?.count;

  it("counts a region-scope state purpose facet without structural predicates", () => {
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          state: "hover",
          evidenceMode: "accepted",
          facets: ["section.purpose"],
          limit: 20,
        },
        atlasSearchStore(seedStateFacets()),
        SEARCH_NOW,
      ),
    );
    expect(data.total).toBe(3);
    expect(facetCount(data, "hero")).toBe(2);
    expect(facetCount(data, "pricing")).toBe(1);
  });

  it("applies siteSlugs, the text query and capture eligibility to the state facet", () => {
    const cache = seedStateFacets();
    const site = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          state: "hover",
          evidenceMode: "accepted",
          siteSlugs: ["facet-site-a"],
          facets: ["section.purpose"],
          limit: 20,
        },
        atlasSearchStore(cache),
        SEARCH_NOW,
      ),
    );
    expect(site.total).toBe(2);
    expect(facetCount(site, "hero")).toBe(1);

    const text = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          state: "hover",
          evidenceMode: "accepted",
          query: "alpha",
          facets: ["section.purpose"],
          limit: 20,
        },
        atlasSearchStore(cache),
        SEARCH_NOW,
      ),
    );
    expect(text.total).toBe(1);
    expect(facetCount(text, "hero")).toBe(1);
    expect(facetCount(text, "pricing")).toBe(0);
  });

  it("returns empty_corpus for a state facet on an empty corpus", () => {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          state: "hover",
          evidenceMode: "accepted",
          facets: ["section.purpose"],
        },
        atlasSearchStore(cache),
        SEARCH_NOW,
      ),
    );
    expect(data.outcome).toBe("empty_corpus");
    expect(data.total).toBe(0);
    expect(data.facets[0]!.values.every((value) => value.count === 0)).toBe(true);
  });
});

describe("Atlas publisher tag projection", () => {
  it("writes locator.tag for new captures", async () => {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    const { scan } = loadPhase2Fixture();
    const regions = segmentRegions(scan);
    const scanArtifact = writeJsonArtifactSync(cache.rootDir, {
      schemaVersion: "awwwards-atlas-live-scan-v1",
      viewport: "desktop",
      scan,
    });
    const stored: AtlasStoredArtifact = {
      key: "scan-desktop",
      kind: "raw_observation",
      storagePath: scanArtifact.storagePath,
      sha256: scanArtifact.sha256,
      bytes: scanArtifact.bytes,
      mimeType: "application/json",
      regionKey: null,
    };
    const claims = classifySections(
      regions.map((candidate) => ({
        viewport: "desktop" as const,
        candidate,
        scan,
        artifactKey: "scan-desktop",
      })),
    );
    const attempt: AtlasCaptureAttempt = {
      cache,
      target: {
        siteSlug: "tag-site",
        requestedUrl: "https://fixture.example/",
        urlKey: "https://fixture.example/",
        path: "/",
      },
      attemptId: "attempt-tag",
      startedAt: SEARCH_NOW,
      finishedAt: SEARCH_NOW + 1_000,
      status: "complete",
      coverage: { status: "complete", collected: regions.length, excluded: 0, limitations: [] },
      limitations: [],
      artifacts: [stored],
      viewports: [
        {
          viewport: "desktop",
          profileKey: "live-desktop",
          status: "complete",
          coverage: { status: "complete", collected: regions.length, excluded: 0, limitations: [] },
          limitations: [],
          finalUrl: "https://fixture.example/",
          browserVersion: "fixture",
          dpr: 1,
          reducedMotion: "no-preference",
          scrollRoot: null,
          overlayState: "none",
          loadingFailures: [],
          scan,
          regions,
          claims,
          screenshots: [],
          artifacts: [stored],
        },
      ],
    };
    const published = await publishCapture(attempt);
    expect(published.code).toBeUndefined();
    expect(published.published).toBe(true);
    const snapshot = loadAtlasSearchSnapshot(cache, {
      asOf: SEARCH_NOW + 2_000,
      maxAgeDays: 30,
      viewport: "desktop",
      state: "default",
    });
    expect(snapshot.regions.find((region) => region.selector === "main > section.pricing")!.tag).toBe(
      "section",
    );
    expect(snapshot.regions.find((region) => region.selector === "main > article.insight")!.tag).toBe(
      "article",
    );
  });
});

describe("Atlas section search component isolation", () => {
  const snapshot = makeSnapshot([
    {
      id: "hero-section",
      kind: "section",
      heading: "Hero",
      capture: "capture-shared",
      page: "page-shared",
      site: "site-shared",
    },
    {
      id: "component-only",
      kind: "component",
      componentType: "button",
      heading: "Component only",
      capture: "capture-shared",
      page: "page-shared",
      site: "site-shared",
      bm25: -9,
    },
  ]);

  it("reports a component-only text match as an honest section no-match", () => {
    const data = dataOrThrow(
      searchAtlas(
        { kind: "sections", query: "component" },
        memoryStore(snapshot, { "component-only": -9 }),
        SEARCH_NOW,
      ),
    );
    expect(data.total).toBe(0);
    expect(data.outcome).toBe("no_observed_match");
    expect(data.results).toEqual([]);
  });

  it("counts only section anchors for a mixed text match", () => {
    const data = dataOrThrow(
      searchAtlas(
        { kind: "sections", query: "hero component" },
        memoryStore(snapshot, { "component-only": -9, "hero-section": -2 }),
        SEARCH_NOW,
      ),
    );
    expect(data.total).toBe(1);
    expect(data.results.map((hit) => hit.regionId)).toEqual(["hero-section"]);
    expect(data.results.every((hit) => hit.kind === "section")).toBe(true);
  });
});

describe("Atlas search benchmark", () => {
  it("runs deterministically on a synthetic corpus", () => {
    const first = runAtlasSearchBenchmark({ regions: 300, queries: 2, runs: 1, now: SEARCH_NOW });
    const second = runAtlasSearchBenchmark({ regions: 300, queries: 2, runs: 1, now: SEARCH_NOW });
    expect(first.measuredRuns).toBe(8);
    expect(first.stateClaims).toBeGreaterThan(0);
    expect(first.statePaging.pages).toBeGreaterThan(0);
    expect(first.workloads.some((workload) => workload.name.startsWith("state-"))).toBe(true);
    expect(first.p95Ms).toBeGreaterThanOrEqual(first.p50Ms);
    expect(first.p50Ms).toBeGreaterThanOrEqual(0);
    expect(first.schemaBytes).toBeGreaterThan(0);
    expect(first.snapshotBytes).toBeGreaterThan(0);
    expect(first.totalResults).toBeGreaterThan(0);
    expect(first.deterministicDigest).toBe(second.deterministicDigest);
  });
});
