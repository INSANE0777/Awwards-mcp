import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import { collectAtlasPage } from "../src/atlas/collector.js";
import { sectionFingerprint } from "../src/atlas/identity.js";
import { searchAtlas } from "../src/atlas/search.js";
import { verifyStateTargetFingerprint } from "../src/atlas/states.js";
import type { AtlasStateTarget } from "../src/atlas/states.js";
import type { SearchAtlasData, SearchAtlasResult } from "../src/atlas/search-types.js";
import type { SiteSummary } from "../src/types.js";
import {
  SEARCH_NOW,
  makeSnapshot,
  memoryStore,
} from "./helpers/atlas-search-fixture.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-states-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataOrThrow(result: SearchAtlasResult<SearchAtlasData>): SearchAtlasData {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

const site = (liveUrl: string): SiteSummary => ({
  id: 1,
  slug: "state-fixture",
  title: "State fixture",
  createdAt: 1,
  tags: [],
  thumbnailPath: "submissions/state.jpg",
  liveUrl,
  detailPath: "/sites/state-fixture",
  awards: [],
  studio: "Studio",
});

describe("Atlas explicit state request validation", () => {
  const cache = () => {
    const value = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    value.upsertSites([site("https://fixture.example/")]);
    return value;
  };

  it("rejects more than three requests", async () => {
    await expect(
      collectAtlasPage(
        {
          siteSlug: "state-fixture",
          viewports: ["desktop"],
          states: [
            { action: "hover", targetRegionId: "a" },
            { action: "hover", targetRegionId: "b" },
            { action: "focus", targetRegionId: "c" },
            { action: "focus", targetRegionId: "d" },
          ],
        },
        { cache: cache() },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_STATE_REQUEST",
      message: expect.stringContaining("At most 3"),
    });
  });

  it("rejects duplicate target/action pairs and unsupported actions", async () => {
    await expect(
      collectAtlasPage(
        {
          siteSlug: "state-fixture",
          viewports: ["desktop"],
          states: [
            { action: "hover", targetRegionId: "a" },
            { action: "hover", targetRegionId: "a" },
          ],
        },
        { cache: cache() },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_STATE_REQUEST",
      message: expect.stringContaining("Duplicate state request"),
    });

    await expect(
      collectAtlasPage(
        {
          siteSlug: "state-fixture",
          viewports: ["desktop"],
          states: [{ action: "click" as never, targetRegionId: "a" }],
        },
        { cache: cache() },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_STATE_REQUEST",
      message: expect.stringContaining("hover or focus"),
    });
  });

  it("rejects a target that is not a published region of this page", async () => {
    await expect(
      collectAtlasPage(
        {
          siteSlug: "state-fixture",
          viewports: ["desktop"],
          states: [{ action: "hover", targetRegionId: "not-a-region" }],
        },
        { cache: cache() },
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_REQUEST" });
  });
});

describe("Atlas state-aware search", () => {
  it("returns only regions carrying evidence for the requested state", () => {
    const snapshot = makeSnapshot([
      {
        id: "hovered",
        kind: "component",
        componentType: "button",
        samples: [{ sampleKey: "desktop:hovered:hover", state: "hover" }],
        claims: [
          {
            field: "component.type",
            value: "button",
            decision: "accepted",
            classification: "observed",
            basis: "native_semantics",
            sampleKey: "desktop:hovered:hover",
            state: "hover",
          },
          {
            field: "behavior",
            value: "hover_change_observed",
            decision: "accepted",
            classification: "observed",
            basis: "interaction_observation",
            sampleKey: "desktop:hovered:hover",
            state: "hover",
          },
        ],
      },
      {
        id: "focused",
        kind: "component",
        componentType: "button",
        samples: [{ sampleKey: "desktop:focused:focus", state: "focus" }],
        claims: [
          {
            field: "component.type",
            value: "button",
            decision: "accepted",
            classification: "observed",
            basis: "native_semantics",
            sampleKey: "desktop:focused:focus",
            state: "focus",
          },
          {
            field: "behavior",
            value: "focus_visible_observed",
            decision: "accepted",
            classification: "observed",
            basis: "interaction_observation",
            sampleKey: "desktop:focused:focus",
            state: "focus",
          },
        ],
      },
      { id: "plain", kind: "component", componentType: "button" },
    ]);
    const store = memoryStore(snapshot);
    const hover = dataOrThrow(
      searchAtlas(
        { kind: "components", state: "hover", evidenceMode: "accepted", groupBy: "instance", limit: 20 },
        store,
        SEARCH_NOW,
      ),
    );
    expect(hover.outcome).toBe("matches");
    expect(hover.results.map((hit) => hit.regionId)).toEqual(["hovered"]);
    expect(hover.results[0]!.state).toBe("hover");
    expect(hover.results[0]!.claims.map((claim) => claim.value)).toContain(
      "hover_change_observed",
    );

    const focus = dataOrThrow(
      searchAtlas(
        { kind: "components", state: "focus", evidenceMode: "accepted", groupBy: "instance", limit: 20 },
        store,
        SEARCH_NOW,
      ),
    );
    expect(focus.results.map((hit) => hit.regionId)).toEqual(["focused"]);

    const defaultState = dataOrThrow(
      searchAtlas(
        { kind: "components", groupBy: "instance", limit: 20 },
        store,
        SEARCH_NOW,
      ),
    );
    expect(defaultState.results.map((hit) => hit.regionId)).toEqual([
      "hovered",
      "focused",
      "plain",
    ]);
  });

  it("never combines default or other-state claims into the requested state", () => {
    const snapshot = makeSnapshot([
      {
        id: "hover-only",
        kind: "component",
        // The type claim lives in the default sample, not the hover sample.
        samples: [{ sampleKey: "desktop:hover-only:hover", state: "hover" }],
        claims: [
          {
            field: "component.type",
            value: "button",
            decision: "accepted",
            classification: "observed",
            basis: "native_semantics",
            sampleKey: "desktop:hover-only:default",
          },
          {
            field: "behavior",
            value: "hover_change_observed",
            decision: "accepted",
            classification: "observed",
            basis: "interaction_observation",
            sampleKey: "desktop:hover-only:hover",
            state: "hover",
          },
        ],
      },
    ]);
    const withTypePredicate = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          state: "hover",
          evidenceMode: "accepted",
          predicates: [{ field: "component.type", values: ["button"] }],
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(withTypePredicate.total).toBe(0);
    expect(withTypePredicate.results).toEqual([]);
    expect(withTypePredicate.outcome).toBe("insufficient_coverage");

    const focus = dataOrThrow(
      searchAtlas(
        { kind: "components", state: "focus", evidenceMode: "accepted" },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(focus.total).toBe(0);
    expect(focus.outcome).toBe("insufficient_coverage");
  });

  it("counts state facets only from the requested state's samples", () => {
    const snapshot = makeSnapshot([
      {
        id: "hovered",
        kind: "component",
        componentType: "button",
        samples: [{ sampleKey: "desktop:hovered:hover", state: "hover" }],
        claims: [
          {
            field: "component.type",
            value: "button",
            decision: "accepted",
            classification: "observed",
            basis: "native_semantics",
            sampleKey: "desktop:hovered:hover",
            state: "hover",
          },
        ],
      },
      {
        id: "focused",
        kind: "component",
        componentType: "button",
        samples: [{ sampleKey: "desktop:focused:focus", state: "focus" }],
        claims: [
          {
            field: "component.type",
            value: "button",
            decision: "accepted",
            classification: "observed",
            basis: "native_semantics",
            sampleKey: "desktop:focused:focus",
            state: "focus",
          },
        ],
      },
      {
        id: "default-only",
        kind: "component",
        componentType: "button",
      },
    ]);
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          state: "hover",
          evidenceMode: "accepted",
          groupBy: "instance",
          facets: ["component.type"],
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(data.total).toBe(1);
    expect(data.facets).toHaveLength(1);
    const button = data.facets[0]!.values.find((value) => value.value === "button");
    expect(button).toEqual({ value: "button", count: 1, selected: false });
    expect(
      data.facets[0]!.values
        .filter((value) => value.count > 0)
        .map((value) => value.value),
    ).toEqual(["button"]);
  });

  it("requires repeated region predicates to share the requested state sample", () => {
    const snapshot = makeSnapshot([
      {
        id: "split-samples",
        purpose: [
          { value: "hero", decision: "candidate", sampleKey: "desktop:split-samples:hover", state: "hover" },
          { value: "services", decision: "candidate", sampleKey: "desktop:split-samples:default" },
        ],
        samples: [{ sampleKey: "desktop:split-samples:hover", state: "hover" }],
      },
      {
        id: "shared-sample",
        purpose: [
          { value: "hero", decision: "candidate", sampleKey: "desktop:shared-sample:hover", state: "hover" },
          { value: "services", decision: "candidate", sampleKey: "desktop:shared-sample:hover", state: "hover" },
        ],
        samples: [{ sampleKey: "desktop:shared-sample:hover", state: "hover" }],
      },
    ]);
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          state: "hover",
          scope: "region",
          evidenceMode: "candidate",
          predicates: [
            { field: "section.purpose", values: ["hero"] },
            { field: "section.purpose", values: ["services"] },
          ],
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(data.results.map((hit) => hit.regionId)).toEqual(["shared-sample"]);
    expect(data.results[0]!.matchedSampleKey).toBe("desktop:shared-sample:hover");
  });

  it("matches a component context purpose in the requested state", () => {
    const snapshot = makeSnapshot([
      {
        id: "stated-context",
        kind: "component",
        componentType: "button",
        claims: [
          {
            field: "context.section_purpose",
            value: "hero",
            decision: "accepted",
            classification: "inferred",
            basis: "rule_derivation",
            sampleKey: "desktop:stated-context:hover",
            state: "hover",
          },
          {
            field: "behavior",
            value: "hover_change_observed",
            decision: "accepted",
            classification: "observed",
            basis: "interaction_observation",
            sampleKey: "desktop:stated-context:hover",
            state: "hover",
          },
        ],
        componentTypeState: "hover",
      },
    ]);
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          state: "hover",
          scope: "region",
          evidenceMode: "accepted",
          predicates: [{ field: "context.section_purpose", values: ["hero"] }],
        },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(data.results.map((hit) => hit.regionId)).toEqual(["stated-context"]);
    expect(data.results[0]!.claims.map((claim) => claim.value)).toContain("hero");
  });

  it("never satisfies a state page or site purpose from a default-purpose projection", () => {
    const snapshot = makeSnapshot([
      {
        id: "state-page",
        purpose: [
          { value: "hero", decision: "candidate", sampleKey: "desktop:state-page:default" },
          { value: "services", decision: "candidate", sampleKey: "desktop:state-page:hover", state: "hover" },
        ],
      },
    ]);
    const store = memoryStore(snapshot);
    const defaultPurpose = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          state: "hover",
          scope: "page",
          evidenceMode: "candidate",
          predicates: [{ field: "section.purpose", values: ["hero"] }],
        },
        store,
        SEARCH_NOW,
      ),
    );
    expect(defaultPurpose.total).toBe(0);
    expect(defaultPurpose.outcome).toBe("no_observed_match");
    const statePurpose = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          state: "hover",
          scope: "page",
          evidenceMode: "candidate",
          predicates: [{ field: "section.purpose", values: ["services"] }],
        },
        store,
        SEARCH_NOW,
      ),
    );
    expect(statePurpose.total).toBe(1);
    expect(statePurpose.results[0]!.regionId).toBe("state-page");
  });

  it("derives page and site structural scope from state witnesses", () => {
    const hoverSection = (
      id: string,
      page: string,
      capture: string,
      tag: string,
      landmark: string,
    ) =>
      ({
        id,
        site: "site-a",
        page,
        capture,
        tag,
        landmark,
        samples: [{ sampleKey: `desktop:${id}:hover`, state: "hover" as const }],
        claims: [
          {
            field: "behavior",
            value: "hover_change_observed",
            decision: "accepted" as const,
            classification: "observed" as const,
            basis: "interaction_observation" as const,
            sampleKey: `desktop:${id}:hover`,
            state: "hover" as const,
          },
        ],
      });
    const snapshot = makeSnapshot([
      hoverSection("header-one", "page-one", "cap-one", "header", "header"),
      {
        id: "footer-one",
        site: "site-a",
        page: "page-one",
        capture: "cap-one",
        tag: "footer",
        landmark: "contentinfo",
      },
      hoverSection("header-two", "page-two", "cap-two", "header", "header"),
      {
        id: "footer-two",
        site: "site-a",
        page: "page-two",
        capture: "cap-two",
        tag: "footer",
        landmark: "contentinfo",
      },
    ]);
    const store = memoryStore(snapshot);
    const pageFooter = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          state: "hover",
          scope: "page",
          evidenceMode: "accepted",
          predicates: [{ field: "region.tag", values: ["footer"] }],
        },
        store,
        SEARCH_NOW,
      ),
    );
    expect(pageFooter.total).toBe(0);
    expect(pageFooter.results).toEqual([]);
    // No state region carries the requested tag: the state corpus lacks that
    // structural witness even though default state has it.
    expect(pageFooter.outcome).toBe("insufficient_coverage");
    const pageHeader = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          state: "hover",
          scope: "page",
          evidenceMode: "accepted",
          predicates: [{ field: "region.tag", values: ["header"] }],
        },
        store,
        SEARCH_NOW,
      ),
    );
    expect(pageHeader.results.map((hit) => hit.regionId).sort()).toEqual([
      "header-one",
      "header-two",
    ]);
    for (const hit of pageHeader.results) {
      expect(hit.claims).toContainEqual(
        expect.objectContaining({
          field: "behavior",
          value: "hover_change_observed",
        }),
      );
    }
    const siteFooter = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          state: "hover",
          scope: "site",
          evidenceMode: "accepted",
          predicates: [{ field: "region.tag", values: ["footer"] }],
        },
        store,
        SEARCH_NOW,
      ),
    );
    expect(siteFooter.total).toBe(0);
    expect(siteFooter.outcome).toBe("insufficient_coverage");
    const siteHeader = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          state: "hover",
          scope: "site",
          evidenceMode: "accepted",
          predicates: [{ field: "region.tag", values: ["header"] }],
        },
        store,
        SEARCH_NOW,
      ),
    );
    expect(siteHeader.results.map((hit) => hit.regionId).sort()).toEqual([
      "header-one",
      "header-two",
    ]);
    for (const hit of siteHeader.results) {
      expect(hit.claims).toContainEqual(
        expect.objectContaining({
          field: "behavior",
          value: "hover_change_observed",
        }),
      );
    }
    // The default projection is unaffected by the state witness rule.
    const defaultFooter = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          scope: "region",
          predicates: [{ field: "region.tag", values: ["footer"] }],
        },
        store,
        SEARCH_NOW,
      ),
    );
    expect(defaultFooter.results.map((hit) => hit.regionId).sort()).toEqual([
      "footer-one",
      "footer-two",
    ]);
    const defaultHeader = dataOrThrow(
      searchAtlas(
        {
          kind: "sections",
          scope: "region",
          predicates: [{ field: "region.tag", values: ["header"] }],
        },
        store,
        SEARCH_NOW,
      ),
    );
    expect(defaultHeader.results.map((hit) => hit.regionId).sort()).toEqual([
      "header-one",
      "header-two",
    ]);
  });

  it("returns empty_corpus before insufficient_coverage for a state query", () => {
    const data = dataOrThrow(
      searchAtlas(
        { kind: "components", state: "hover", evidenceMode: "accepted" },
        memoryStore(makeSnapshot([])),
        SEARCH_NOW,
      ),
    );
    expect(data.outcome).toBe("empty_corpus");
    expect(data.total).toBe(0);
  });

  it("requires an eligible component type in the requested state", () => {
    const snapshot = makeSnapshot([
      {
        id: "hover-only",
        kind: "component",
        // Only the default sample carries a type claim.
        samples: [{ sampleKey: "desktop:hover-only:hover", state: "hover" }],
        claims: [
          {
            field: "component.type",
            value: "button",
            decision: "accepted",
            classification: "observed",
            basis: "native_semantics",
            sampleKey: "desktop:hover-only:default",
          },
          {
            field: "behavior",
            value: "hover_change_observed",
            decision: "accepted",
            classification: "observed",
            basis: "interaction_observation",
            sampleKey: "desktop:hover-only:hover",
            state: "hover",
          },
        ],
      },
    ]);
    const data = dataOrThrow(
      searchAtlas(
        { kind: "components", state: "hover", evidenceMode: "accepted" },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(data.total).toBe(0);
    expect(data.outcome).toBe("insufficient_coverage");
  });

  it("paginates state results with a stable cursor", () => {
    const hovered = (id: string) => ({
      id,
      kind: "component" as const,
      componentType: "button",
      samples: [{ sampleKey: `desktop:${id}:hover`, state: "hover" as const }],
      claims: [
        {
          field: "component.type",
          value: "button",
          decision: "accepted" as const,
          classification: "observed" as const,
          basis: "native_semantics" as const,
          sampleKey: `desktop:${id}:hover`,
          state: "hover" as const,
        },
        {
          field: "behavior",
          value: "hover_change_observed",
          decision: "accepted" as const,
          classification: "observed" as const,
          basis: "interaction_observation" as const,
          sampleKey: `desktop:${id}:hover`,
          state: "hover" as const,
        },
      ],
    });
    const store = memoryStore(makeSnapshot([hovered("a"), hovered("b"), hovered("c")]));
    const first = dataOrThrow(
      searchAtlas(
        { kind: "components", state: "hover", evidenceMode: "accepted", limit: 1 },
        store,
        SEARCH_NOW,
      ),
    );
    expect(first.results).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          state: "hover",
          evidenceMode: "accepted",
          limit: 1,
          cursor: first.nextCursor!,
        },
        store,
        SEARCH_NOW,
      ),
    );
    expect(second.results).toHaveLength(1);
    expect(second.results[0]!.regionId).not.toBe(first.results[0]!.regionId);
  });

  it("verifies the observed fingerprint instead of trusting stored fields", () => {
    const target: AtlasStateTarget = {
      request: { action: "hover", targetRegionId: "region-a" },
      kind: "section",
      regionId: "region-a",
      viewport: "desktop",
      selector: "main > section#a",
      tag: "section",
      heading: "Hero",
      text: "Hero copy",
      componentType: null,
      patternKey: null,
      fingerprint: sectionFingerprint("main > section#a", "Hero", "Hero copy"),
    };
    expect(
      verifyStateTargetFingerprint(
        target,
        sectionFingerprint("main > section#a", "Hero", "Hero copy"),
      ),
    ).toBe(true);
    expect(
      verifyStateTargetFingerprint(
        { ...target, fingerprint: "corrupted" },
        sectionFingerprint("main > section#a", "Hero", "Hero copy"),
      ),
    ).toBe(false);
    expect(
      verifyStateTargetFingerprint(
        target,
        sectionFingerprint("main > section#a", "Hero", "Changed copy"),
      ),
    ).toBe(false);
  });
});
