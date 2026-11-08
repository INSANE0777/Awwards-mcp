import { describe, expect, it } from "vitest";
import { searchAtlas, ATLAS_DATA_RESPONSE_BUDGET } from "../src/atlas/search.js";
import type { AtlasEvidenceMode, SearchAtlasData, SearchAtlasResult } from "../src/atlas/search-types.js";
import {
  SEARCH_DAY,
  SEARCH_NOW,
  makeSnapshot,
  memoryStore,
} from "./helpers/atlas-search-fixture.js";

function dataOrThrow(result: SearchAtlasResult<SearchAtlasData>): SearchAtlasData {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

function facetCount(data: SearchAtlasData, field: string, value: string): number | undefined {
  return data.facets
    .find((facet) => facet.field === field)
    ?.values.find((entry) => entry.value === value)?.count;
}

it("reserves the response envelope inside the byte budget", () => {
  expect(ATLAS_DATA_RESPONSE_BUDGET).toBe(262_080);
});

describe("Phase 3 gate: response bounds", () => {
  it("rejects an oversized siteSlugs entry before touching the corpus", () => {
    const result = searchAtlas(
      { kind: "sections", siteSlugs: ["a".repeat(262_144)] },
      memoryStore(makeSnapshot([{ id: "only" }])),
      SEARCH_NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("accepts a 128-character site slug and rejects 129", () => {
    const snapshot = makeSnapshot([{ id: "only" }]);
    const accepted = searchAtlas(
      { kind: "sections", siteSlugs: ["a".repeat(128)] },
      memoryStore(snapshot),
      SEARCH_NOW,
    );
    expect(accepted.ok).toBe(true);
    const rejected = searchAtlas(
      { kind: "sections", siteSlugs: ["a".repeat(129)] },
      memoryStore(snapshot),
      SEARCH_NOW,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("INVALID_INPUT");
  });

  it("clips hostile local fields without dropping the result page", () => {
    const hostile = "h".repeat(20_000);
    const snapshot = makeSnapshot(
      Array.from({ length: 20 }, (_, index) => ({
        id: `hostile-region-${index}`,
        capture: `hostile-capture-${index}`,
        page: `hostile-page-${index}`,
        patternKey: hostile,
        screenshots: [hostile],
        coverage: { limitations: Array.from({ length: 40 }, () => hostile) },
        artifacts: [
          {
            kind: "raw_observation",
            storagePath: hostile,
            sha256: "a".repeat(64),
            bytes: 1,
          },
        ],
      })),
    );
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          predicates: [{ field: "region.tag", values: ["section"] }],
          limit: 20,
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(data.results).toHaveLength(20);
    expect(new Set(data.results.map((hit) => hit.regionId)).size).toBe(20);
    expect(new Set(data.results.map((hit) => hit.captureId)).size).toBe(20);
    expect(new Set(data.results.map((hit) => hit.pageId)).size).toBe(20);
    expect(data.responseTruncated).toBe(false);
    expect(Buffer.byteLength(JSON.stringify({ ok: true, data }), "utf8")).toBeLessThanOrEqual(262_144);
    for (const hit of data.results) {
      expect(hit.regionId.length).toBeLessThanOrEqual(128);
      expect(hit.captureId.length).toBeLessThanOrEqual(128);
      expect(hit.pageId.length).toBeLessThanOrEqual(128);
      expect(hit.patternKey!.length).toBeLessThanOrEqual(256);
      expect(hit.screenshotKeys).toHaveLength(1);
      expect(hit.screenshotKeys[0]!.length).toBeLessThanOrEqual(256);
      expect(hit.explanations[0]!.supportingRegionIds[0]!.length).toBeLessThanOrEqual(128);
      expect(hit.artifacts).toHaveLength(1);
      expect(hit.artifacts[0]!.storagePath.length).toBeLessThanOrEqual(1_024);
      expect(hit.coverage.limitations).toHaveLength(16);
      expect(hit.coverage.limitations.every((item) => item.length <= 200)).toBe(true);
    }
  });

  it("paginates rows whose identifiers are exactly 128 characters", () => {
    const id = (index: number) => `${index}`.padStart(4, "0").padEnd(128, "x");
    const snapshot = makeSnapshot(
      Array.from({ length: 3 }, (_, index) => ({
        id: id(index),
        capture: `capture-${index}`,
        page: `page-${index}`,
      })),
    );
    const store = memoryStore(snapshot);
    const first = dataOrThrow(searchAtlas({ kind: "sections", limit: 2 }, store, SEARCH_NOW));
    expect(first.results.map((hit) => hit.regionId)).toEqual([id(0), id(1)]);
    expect(first.nextCursor).not.toBeNull();
    const second = dataOrThrow(
      searchAtlas({ kind: "sections", limit: 2, cursor: first.nextCursor! }, store, SEARCH_NOW),
    );
    expect(second.results.map((hit) => hit.regionId)).toEqual([id(2)]);
  });

  it("omits rows whose stored identifiers cannot round-trip a cursor", () => {
    const hostile = "h".repeat(20_000);
    const snapshot = makeSnapshot([
      { id: `long-region-${hostile}`, capture: `long-capture-${hostile}`, page: "page-long" },
      { id: "short-region", capture: "short-capture", page: "page-short" },
    ]);
    const data = dataOrThrow(
      searchAtlas({ kind: "sections", limit: 20 }, memoryStore(snapshot), SEARCH_NOW),
    );
    expect(data.results.map((hit) => hit.regionId)).toEqual(["short-region"]);
    expect(data.responseTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ ok: true, data }), "utf8")).toBeLessThanOrEqual(262_144);
  });

  it("marks an explanation truncated when a witness ID is omitted", () => {
    const longWitness = `hero-${"w".repeat(126)}`;
    expect(longWitness).toHaveLength(131);
    const snapshot = makeSnapshot([
      {
        id: longWitness,
        page: "witness-page",
        capture: "witness-capture",
        tag: "header",
        purpose: { value: "hero" },
      },
      {
        id: "pricing-anchor",
        page: "witness-page",
        capture: "witness-capture",
        tag: "section",
        purpose: { value: "pricing" },
        heading: "Pricing plans",
      },
    ]);
    for (const scope of ["page", "site"] as const) {
      const data = dataOrThrow(
        searchAtlas(
          {
            kind: "sections",
            scope,
            query: "pricing",
            predicates: [{ field: "section.purpose", values: ["hero"] }],
            limit: 20,
          },
          memoryStore(snapshot, { "pricing-anchor": -5 }),
          SEARCH_NOW,
        ),
      );
      expect(data.results).toHaveLength(1);
      expect(data.results[0]!.explanations[0]!.supportingRegionIds).toEqual([]);
      expect(data.results[0]!.explanations[0]!.truncated).toBe(true);
      expect(data.results[0]!.explanationsTruncated).toBe(true);
    }
  });

  it("bounds a 20-hit response whose site titles are oversized", () => {
    const longTitle = "t".repeat(20_000);
    const snapshot = makeSnapshot(
      Array.from({ length: 20 }, (_, index) => ({
        id: `long-title-${index}`,
        page: `long-title-page-${index}`,
        siteTitle: longTitle,
      })),
    );
    const data = dataOrThrow(
      searchAtlas({ kind: "sections", limit: 20 }, memoryStore(snapshot), SEARCH_NOW),
    );
    expect(data.results).toHaveLength(20);
    expect(Buffer.byteLength(JSON.stringify({ ok: true, data }), "utf8")).toBeLessThanOrEqual(262_144);
    expect(data.results.every((hit) => hit.siteTitle.length <= 200)).toBe(true);
  });

  it("trims optional evidence deterministically when the response exceeds the budget", () => {
    const witnessId = (index: number): string => `w${"x".repeat(200)}-${index}`;
    const snapshot = makeSnapshot([
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `budget-anchor-${index}`,
        page: `budget-anchor-page-${index}`,
        purpose: { value: "pricing" as const },
        claims: Array.from({ length: 100 }, (_, claim) => ({
          field: "section.note",
          value: `note-${claim}-${"c".repeat(180)}`,
        })),
        artifacts: Array.from({ length: 8 }, (_, artifact) => ({
          kind: "raw_observation",
          storagePath: `atlas/artifacts/${artifact}-${"p".repeat(1_000)}.json`,
          sha256: `${artifact}`.padStart(64, "a"),
          bytes: 1_024,
        })),
      })),
      ...Array.from({ length: 2_000 }, (_, index) => ({
        id: witnessId(index),
        page: `budget-witness-page-${index}`,
        purpose: { value: "hero" as const },
      })),
    ]);
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
          scope: "site",
          limit: 20,
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(data.results).toHaveLength(20);
    expect(Buffer.byteLength(JSON.stringify({ ok: true, data }), "utf8")).toBeLessThanOrEqual(262_144);
    expect(data.responseTruncated).toBe(true);
  });
});

describe("Phase 3 gate: repeated structural predicates", () => {
  const snapshot = makeSnapshot([
    { id: "split-header", page: "split-page", tag: "header", ordinal: 0 },
    { id: "split-footer", page: "split-page", tag: "footer", ordinal: 1 },
  ]);

  it("keeps region scope intersection (one region has one tag)", () => {
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          scope: "region",
          predicates: [
            { field: "region.tag", values: ["header"] },
            { field: "region.tag", values: ["footer"] },
          ],
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(data.total).toBe(0);
    expect(data.results).toEqual([]);
  });

  it("matches header and footer through separate page and site witnesses", () => {
    for (const scope of ["page", "site"] as const) {
      const data = dataOrThrow(
        searchAtlas(
          {
            kind: "sections",
            scope,
            predicates: [
              { field: "region.tag", values: ["header"] },
              { field: "region.tag", values: ["footer"] },
            ],
            limit: 20,
          },
          memoryStore(snapshot),
          SEARCH_NOW,
        ),
      );
      expect(data.total, scope).toBe(2);
      expect(data.results.map((hit) => hit.regionId), scope).toEqual([
        "split-header",
        "split-footer",
      ]);
      expect(data.results[0]!.explanations.map((entry) => entry.supportingRegionIds), scope).toEqual([
        ["split-header"],
        ["split-footer"],
      ]);
    }
  });

  it("counts disjunctively but treats repeated predicates as AND", () => {
    const store = memoryStore(snapshot);
    const selected = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          scope: "region",
          predicates: [{ field: "region.tag", values: ["header"] }],
          facets: ["region.tag"],
          limit: 20,
        },
        store,
        SEARCH_NOW,
      ),
    );
    expect(selected.total).toBe(1);
    expect(selected.facets[0]!.disjunctive).toBe(true);
    // The footer count is the result count if footer replaced header.
    expect(facetCount(selected, "region.tag", "footer")).toBe(1);

    // The supported way to select both values: one predicate, OR values.
    const merged = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          scope: "region",
          predicates: [{ field: "region.tag", values: ["header", "footer"] }],
          limit: 20,
        },
        store,
        SEARCH_NOW,
      ),
    );
    expect(merged.total).toBe(2);

    // Two predicates are AND requirements, not a second selection.
    const repeated = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          scope: "region",
          predicates: [
            { field: "region.tag", values: ["header"] },
            { field: "region.tag", values: ["footer"] },
          ],
          limit: 20,
        },
        store,
        SEARCH_NOW,
      ),
    );
    expect(repeated.total).toBe(0);

    // Page scope also applies repeated predicates as AND: no page has both.
    const splitPages = memoryStore(
      makeSnapshot([
        { id: "only-header", page: "header-only-page", tag: "header" },
        { id: "only-footer", page: "footer-only-page", tag: "footer" },
      ]),
    );
    const pageAnd = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          scope: "page",
          predicates: [
            { field: "region.tag", values: ["header"] },
            { field: "region.tag", values: ["footer"] },
          ],
          limit: 20,
        },
        splitPages,
        SEARCH_NOW,
      ),
    );
    expect(pageAnd.total).toBe(0);
    const pageOr = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          scope: "page",
          predicates: [{ field: "region.tag", values: ["header", "footer"] }],
          limit: 20,
        },
        splitPages,
        SEARCH_NOW,
      ),
    );
    expect(pageOr.total).toBe(2);
  });
});

describe("Phase 3 gate: siteSlugs scope isolation", () => {
  const snapshot = makeSnapshot([
    { id: "site-a-hero", site: "site-a", page: "site-a-page", purpose: { value: "hero" }, tag: "section" },
    { id: "site-b-hero", site: "site-b", page: "site-b-page", purpose: { value: "hero" }, tag: "footer" },
  ]);

  it("constrains region, page and site totals and facets to the requested sites", () => {
    for (const scope of ["region", "page", "site"] as const) {
      const data = dataOrThrow(
        searchAtlas(
          {
            kind: "sections",
            scope,
            siteSlugs: ["site-a"],
            predicates: [{ field: "section.purpose", values: ["hero"] }],
            facets: ["section.purpose", "region.tag"],
            limit: 20,
          },
          memoryStore(snapshot),
          SEARCH_NOW,
        ),
      );
      expect(data.total, scope).toBe(1);
      expect(facetCount(data, "section.purpose", "hero"), scope).toBe(1);
      expect(facetCount(data, "region.tag", "section"), scope).toBe(1);
      // The unrequested site's hero/footer must not leak into any count.
      expect(facetCount(data, "region.tag", "footer"), scope).toBe(0);
    }
  });

  it("does not reuse another site's scope set when the filter excludes the requested site", () => {
    const twoSites = makeSnapshot([
      {
        id: "site-a-pricing",
        site: "site-a",
        page: "site-a-page",
        tag: "section",
        role: "main",
        purpose: { value: "pricing" },
      },
      {
        id: "site-b-header",
        site: "site-b",
        page: "site-b-page",
        tag: "header",
        purpose: { value: "hero" },
      },
    ]);
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          scope: "site",
          siteSlugs: ["site-a"],
          predicates: [{ field: "region.tag", values: ["header"] }],
          facets: ["region.role", "section.purpose"],
          limit: 20,
        },
        memoryStore(twoSites),
        SEARCH_NOW,
      ),
    );
    expect(data.total).toBe(0);
    expect(facetCount(data, "region.role", "main") ?? 0).toBe(0);
    expect(facetCount(data, "section.purpose", "pricing") ?? 0).toBe(0);
  });
});

describe("Phase 3 gate: text query on structural facets", () => {
  it("intersects the purpose-feature facet path with the text anchors", () => {
    const snapshot = makeSnapshot([
      {
        id: "hero-pricing",
        page: "facet-page",
        purpose: { value: "hero" },
        tag: "section",
        heading: "Pricing",
      },
      {
        id: "hero-about",
        page: "facet-page",
        purpose: { value: "hero" },
        tag: "footer",
        heading: "About",
      },
    ]);
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          query: "pricing",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
          facets: ["region.tag"],
          limit: 20,
        },
        memoryStore(snapshot, { "hero-pricing": -5 }),
        SEARCH_NOW,
      ),
    );
    expect(data.total).toBe(1);
    expect(facetCount(data, "region.tag", "section")).toBe(1);
    expect(facetCount(data, "region.tag", "footer")).toBe(0);
  });
});

describe("Phase 3 gate: page/site query facets use scope witnesses", () => {
  const snapshot = makeSnapshot([
    {
      id: "facet-pricing",
      page: "facet-page",
      tag: "section",
      purpose: { value: "pricing" },
      heading: "Pricing plans",
    },
    {
      id: "facet-hero",
      page: "facet-page",
      tag: "header",
      purpose: { value: "hero" },
      heading: "Welcome",
    },
  ]);

  it("counts a structural facet when the purpose witness is another region", () => {
    for (const scope of ["page", "site"] as const) {
      const data = dataOrThrow(
        searchAtlas(
          {
            kind: "sections",
            query: "pricing",
            scope,
            predicates: [{ field: "section.purpose", values: ["hero"] }],
            facets: ["region.tag"],
            limit: 20,
          },
          memoryStore(snapshot, { "facet-pricing": -5 }),
          SEARCH_NOW,
        ),
      );
      expect(data.total, scope).toBe(1);
      expect(data.results.map((hit) => hit.regionId), scope).toEqual(["facet-pricing"]);
      expect(facetCount(data, "region.tag", "section"), scope).toBe(1);
      expect(facetCount(data, "region.tag", "header"), scope).toBe(0);
    }
  });

  it("counts a purpose facet when the structural witness is another region", () => {
    for (const scope of ["page", "site"] as const) {
      const data = dataOrThrow(
        searchAtlas(
          {
            kind: "sections",
            query: "pricing",
            scope,
            predicates: [{ field: "region.tag", values: ["header"] }],
            facets: ["section.purpose"],
            limit: 20,
          },
          memoryStore(snapshot, { "facet-pricing": -5 }),
          SEARCH_NOW,
        ),
      );
      expect(data.total, scope).toBe(1);
      expect(facetCount(data, "section.purpose", "pricing"), scope).toBe(1);
      expect(facetCount(data, "section.purpose", "hero"), scope).toBe(0);
    }
  });
});

describe("Phase 3 gate: purpose facet evidence modes", () => {
  const snapshot = makeSnapshot([
    {
      id: "accepted-observed-hero",
      site: "mode-site",
      page: "mode-page",
      purpose: { value: "hero", decision: "accepted", classification: "observed" },
    },
    {
      id: "candidate-hero",
      site: "mode-site",
      page: "mode-page",
      purpose: { value: "hero", decision: "candidate" },
    },
    {
      id: "rejected-hero",
      site: "mode-site",
      page: "mode-page",
      purpose: { value: "hero", decision: "rejected" },
    },
  ]);

  const heroCount = (evidenceMode: AtlasEvidenceMode): number | undefined =>
    facetCount(
      dataOrThrow(
        searchAtlas(
          {
            kind: "sections",
            evidenceMode,
            scope: "page",
            siteSlugs: ["mode-site"],
            facets: ["section.purpose"],
            limit: 20,
          },
          memoryStore(snapshot),
          SEARCH_NOW,
        ),
      ),
      "section.purpose",
      "hero",
    );

  it("counts only accepted observed regions in accepted mode", () => {
    expect(heroCount("accepted")).toBe(1);
  });

  it("counts only accepted observed regions in observed_only mode", () => {
    expect(heroCount("observed_only")).toBe(1);
  });

  it("counts accepted and candidate regions but never rejected ones in candidate mode", () => {
    expect(heroCount("candidate")).toBe(2);
  });
});

describe("Phase 3 gate: site observation spans", () => {
  it("includes every supporting predicate capture in the span", () => {
    const older = SEARCH_NOW - 10 * SEARCH_DAY;
    const middle = SEARCH_NOW - 5 * SEARCH_DAY;
    const snapshot = makeSnapshot([
      { id: "span-old-header", site: "span-site", page: "span-old", tag: "header", purpose: { value: "header" }, observedAt: older },
      { id: "span-new-nav", site: "span-site", page: "span-new", role: "navigation", observedAt: middle },
      { id: "span-anchor", site: "span-site", page: "span-anchor", purpose: { value: "pricing" }, observedAt: SEARCH_NOW - SEARCH_DAY },
    ]);
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          query: "pricing",
          scope: "site",
          predicates: [
            { field: "region.tag", values: ["header"] },
            { field: "region.role", values: ["navigation"] },
          ],
        },
        memoryStore(snapshot, { "span-anchor": -5 }),
        SEARCH_NOW,
      ),
    );
    expect(data.results.map((hit) => hit.regionId)).toEqual(["span-anchor"]);
    expect(data.results[0]!.explanations.map((entry) => entry.supportingRegionIds)).toEqual([
      ["span-old-header"],
      ["span-new-nav"],
    ]);
    expect(data.results[0]!.observationSpan).toEqual({
      from: older,
      to: SEARCH_NOW - SEARCH_DAY,
    });
  });
});

describe("Phase 3 gate: OR purpose tiers", () => {
  it("ranks a region by its best qualifying purpose tier", () => {
    const snapshot = makeSnapshot([
      {
        id: "mixed-purpose",
        page: "mixed-page",
        purpose: [
          { value: "about", decision: "candidate" },
          { value: "hero", decision: "accepted", classification: "inferred" },
        ],
        observedAt: SEARCH_NOW - SEARCH_DAY,
      },
      {
        id: "inferred-hero",
        page: "inferred-page",
        purpose: { value: "hero", decision: "accepted", classification: "inferred" },
        observedAt: SEARCH_NOW - 3 * SEARCH_DAY,
      },
      {
        id: "observed-hero",
        page: "observed-page",
        purpose: { value: "hero", decision: "accepted", classification: "observed" },
        observedAt: SEARCH_NOW - 6 * SEARCH_DAY,
      },
    ]);
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          predicates: [{ field: "section.purpose", values: ["about", "hero"] }],
          limit: 20,
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    // Tier 1 first even though it is the oldest: MIN tier, not recency.
    expect(data.results.map((hit) => hit.regionId)).toEqual([
      "observed-hero",
      "mixed-purpose",
      "inferred-hero",
    ]);
  });
});
