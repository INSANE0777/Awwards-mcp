import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { searchAtlas } from "../src/atlas/search.js";
import type { SearchAtlasData, SearchAtlasResult } from "../src/atlas/search-types.js";
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

const pageSections = [
  { id: "a-pricing", site: "site-a", page: "page-a", purpose: { value: "pricing" }, heading: "Pricing plans" },
  {
    id: "a-hero",
    site: "site-a",
    page: "page-a",
    purpose: { value: "hero" },
    heading: "Build what matters",
    observedAt: SEARCH_NOW - 3 * SEARCH_DAY,
  },
  { id: "b-hero", site: "site-a", page: "page-b", purpose: { value: "hero" }, observedAt: SEARCH_NOW - 2 * SEARCH_DAY },
  {
    id: "c-old-hero",
    site: "site-a",
    page: "page-c",
    purpose: { value: "hero" },
    observedAt: SEARCH_NOW - 40 * SEARCH_DAY,
  },
  {
    id: "d-hero-mobile",
    site: "site-a",
    page: "page-d",
    viewport: "mobile" as const,
    purpose: { value: "hero" },
  },
  { id: "e-hero", site: "site-b", page: "page-e", purpose: { value: "hero" } },
  {
    id: "g-hero",
    site: "site-a",
    page: "page-g",
    purpose: { value: "hero" },
    observedAt: SEARCH_NOW - 3 * SEARCH_DAY,
  },
  {
    id: "f-pricing",
    site: "site-a",
    page: "page-f",
    purpose: { value: "pricing" },
    heading: "Plans and pricing",
  },
];

describe("Atlas search scope witnesses", () => {
  it("region scope never lets a sibling satisfy the anchor predicate", () => {
    const snapshot = makeSnapshot(pageSections);
    const result = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          query: "pricing",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
          scope: "region",
        },
        memoryStore(snapshot, { "a-pricing": -5 }),
        SEARCH_NOW,
      ),
    );
    expect(result.results).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.outcome).toBe("no_observed_match");
  });

  it("page scope finds same-capture witnesses and returns supporting region IDs", () => {
    const snapshot = makeSnapshot(pageSections);
    const result = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          query: "pricing",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
          scope: "page",
        },
        memoryStore(snapshot, { "a-pricing": -5 }),
        SEARCH_NOW,
      ),
    );
    expect(result.results.map((hit) => hit.regionId)).toEqual(["a-pricing"]);
    expect(result.results[0]!.explanations[0]!.supportingRegionIds).toEqual(["a-hero"]);
    expect(result.results[0]!.observationSpan).toBeUndefined();
  });

  it("page scope rejects witnesses from another page and site scope accepts them", () => {
    const snapshot = makeSnapshot(pageSections);
    const pageResult = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          query: "pricing",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
          scope: "page",
        },
        memoryStore(snapshot, { "f-pricing": -5 }),
        SEARCH_NOW,
      ),
    );
    expect(pageResult.results).toEqual([]);

    const siteResult = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          query: "pricing",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
          scope: "site",
        },
        memoryStore(snapshot, { "f-pricing": -5 }),
        SEARCH_NOW,
      ),
    );
    expect(siteResult.results.map((hit) => hit.regionId)).toEqual(["f-pricing"]);
    const supporting = siteResult.results[0]!.explanations[0]!.supportingRegionIds;
    expect(supporting).toContain("a-hero");
    expect(supporting).toContain("b-hero");
    expect(supporting).not.toContain("c-old-hero");
    expect(supporting).not.toContain("d-hero-mobile");
    expect(supporting).not.toContain("e-hero");
    expect(siteResult.results[0]!.observationSpan).toEqual({
      from: SEARCH_NOW - 3 * SEARCH_DAY,
      to: SEARCH_NOW - SEARCH_DAY,
    });
  });

  it("query always matches the anchor, not the supporting witness", () => {
    const snapshot = makeSnapshot(pageSections);
    const result = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          query: "pricing",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
          scope: "site",
        },
        memoryStore(snapshot, { "f-pricing": -5 }),
        SEARCH_NOW,
      ),
    );
    expect(result.results.map((hit) => hit.regionId)).toEqual(["f-pricing"]);
    expect(result.results[0]!.regionId).toBe("f-pricing");
  });

  it("region scope never lets a descendant satisfy the anchor predicate", () => {
    const snapshot = makeSnapshot([
      { id: "anchor", page: "shared", purpose: { value: "pricing" } },
      { id: "child", page: "shared", purpose: { value: "hero" } },
    ]);
    snapshot.regions.find((region) => region.id === "child")!.parentId = "anchor";
    const region = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          query: "pricing",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
          scope: "region",
        },
        memoryStore(snapshot, { anchor: -1 }),
        SEARCH_NOW,
      ),
    );
    expect(region.results).toEqual([]);
    const page = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          query: "pricing",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
          scope: "page",
        },
        memoryStore(snapshot, { anchor: -1 }),
        SEARCH_NOW,
      ),
    );
    expect(page.results.map((hit) => hit.regionId)).toEqual(["anchor"]);
    expect(page.results[0]!.explanations[0]!.supportingRegionIds).toEqual(["child"]);
  });

  it("page scope returns every supporting region ID and deduplicates them", () => {
    const snapshot = makeSnapshot([
      { id: "anchor", page: "shared", purpose: { value: "pricing" } },
      { id: "hero-1", page: "shared", purpose: { value: "hero" } },
      { id: "hero-2", page: "shared", purpose: { value: "hero" } },
      { id: "about", page: "shared", purpose: { value: "about" } },
    ]);
    const result = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          query: "pricing",
          predicates: [{ field: "section.purpose", values: ["hero", "about"] }],
          scope: "page",
        },
        memoryStore(snapshot, { anchor: -1 }),
        SEARCH_NOW,
      ),
    );
    expect(result.results[0]!.explanations[0]!.supportingRegionIds).toEqual([
      "hero-1",
      "hero-2",
      "about",
    ]);
  });

  it("bounds explanation IDs for a site with 5,000 witnesses", () => {
    const witnesses = Array.from({ length: 5_000 }, (_, index) => ({
      id: `w${index}`,
      site: "budget",
      page: `budget-page-${index}`,
      purpose: { value: "hero" },
    }));
    const snapshot = makeSnapshot([
      {
        id: "budget-anchor",
        site: "budget",
        page: "budget-anchor-page",
        purpose: { value: "pricing" },
      },
      ...witnesses,
    ]);
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          query: "pricing",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
          scope: "site",
          limit: 1,
        },
        memoryStore(snapshot, { "budget-anchor": -5 }),
        SEARCH_NOW,
      ),
    );
    expect(data.results).toHaveLength(1);
    const explanation = data.results[0]!.explanations[0]!;
    expect(explanation.supportingRegionIds.length).toBeLessThanOrEqual(200);
    expect(explanation.truncated).toBe(true);
    expect(data.results[0]!.explanationsTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(data), "utf8")).toBeLessThan(256 * 1024);
  });

  it("region scope requires repeated claim predicates to share a sample key", () => {
    const snapshot = makeSnapshot([
      {
        id: "anchor",
        purpose: [
          { value: "hero", sampleKey: "default:1" },
          { value: "about", sampleKey: "hover:2" },
        ],
      },
      {
        id: "shared",
        purpose: [
          { value: "hero", sampleKey: "default:1" },
          { value: "about", sampleKey: "default:1" },
        ],
      },
    ]);
    const mismatched = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          predicates: [
            { field: "section.purpose", values: ["hero"] },
            { field: "section.purpose", values: ["about"] },
          ],
          scope: "region",
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(mismatched.results.map((hit) => hit.regionId)).toEqual(["shared"]);
  });

  it("keeps the whole response under 256 KiB with limit 20 and 5,000 witnesses", () => {
    const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
    const purposeValues = [
      "hero",
      "about",
      "pricing",
      "features",
      "services",
      "contact",
      "faq",
      "footer",
    ];
    const anchorId = (index: number): string => hash(`budget-anchor-${index}`);
    const witnesses = Array.from({ length: 5_000 }, (_, index) => {
      const id = hash(`budget-witness-${index}`);
      return {
        id,
        site: "budget",
        page: `budget-witness-page-${index}`,
        purpose: purposeValues.map((value) => ({
          value,
          sampleKey: `desktop:${id}`,
        })),
      };
    });
    const anchors = Array.from({ length: 20 }, (_, index) => ({
      id: anchorId(index),
      site: "budget",
      page: `budget-anchor-page-${index}`,
      purpose: { value: "metrics", sampleKey: `desktop:anchor-${index}` },
      // 20 hits x 5,000 keys was a 3.9 MB response before the cap.
      screenshots: Array.from({ length: 5_000 }, (_, shot) => `shot-${index}-${shot}`),
    }));
    const snapshot = makeSnapshot([...anchors, ...witnesses]);

    const run = (predicateCount: number, facets: boolean) => {
      const predicates = purposeValues.slice(0, predicateCount).map((value) => ({
        field: "section.purpose" as const,
        values: [value],
      }));
      return dataOrThrow(
        searchAtlas(
          {
            kind: "sections",
            predicates,
            scope: "site",
            limit: 20,
            ...(facets
              ? { facets: ["region.tag", "region.role", "region.landmark", "section.purpose"] }
              : {}),
          },
          memoryStore(snapshot),
          SEARCH_NOW,
        ),
      );
    };

    const single = run(1, false);
    expect(single.results).toHaveLength(20);
    expect(Buffer.byteLength(JSON.stringify(single), "utf8")).toBeLessThan(262_144);
    for (const hit of single.results) {
      expect(hit.screenshotKeys.length).toBeLessThanOrEqual(8);
      expect(hit.screenshotsTruncated).toBe(true);
    }

    const eight = run(8, true);
    expect(eight.results).toHaveLength(20);
    expect(Buffer.byteLength(JSON.stringify(eight), "utf8")).toBeLessThan(262_144);
    for (const hit of eight.results) {
      expect(hit.screenshotKeys.length).toBeLessThanOrEqual(8);
      expect(hit.screenshotsTruncated).toBe(true);
    }
    const totalWitnessIds = eight.results.reduce(
      (total, hit) =>
        total + hit.explanations.reduce((sum, explanation) => sum + explanation.supportingRegionIds.length, 0),
      0,
    );
    // Literal on purpose: the response budget is part of the contract, not an
    // implementation detail callers may widen.
    expect(totalWitnessIds).toBeLessThanOrEqual(2_000);
    expect(eight.results[1]!.explanationsTruncated).toBe(true);
    const later = eight.results[19]!;
    expect(later.explanationsTruncated).toBe(true);
    expect(later.explanations.every((explanation) => explanation.supportingRegionIds.length === 0)).toBe(true);
  });
});
