import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Cache } from "../src/cache.js";
import { writeJsonArtifactSync } from "../src/atlas/artifacts.js";
import {
  classifyComponents,
  componentPatternKey,
  discoverComponents,
  groupComponentPatterns,
} from "../src/atlas/components.js";
import { publishCapture } from "../src/atlas/publish.js";
import { classifySections } from "../src/atlas/classification.js";
import { ATLAS_COMPONENT_HINTS } from "../src/atlas/scan.js";
import { isSearchableVocabulary } from "../src/atlas/vocabulary.js";
import { regionStableKey, segmentRegions } from "../src/atlas/segmentation.js";
import type {
  AtlasCaptureAttempt,
  AtlasPageScan,
  AtlasScanComponent,
  AtlasStoredArtifact,
} from "../src/atlas/live-types.js";
import { atlasSearchStore, searchAtlas } from "../src/atlas/search.js";
import type {
  SearchAtlasData,
  SearchAtlasResult,
} from "../src/atlas/search-types.js";
import {
  SEARCH_NOW,
  makeSnapshot,
  memoryStore,
} from "./helpers/atlas-search-fixture.js";

const dirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-components-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataOrThrow(
  result: SearchAtlasResult<SearchAtlasData>,
): SearchAtlasData {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

function rawComponent(
  overrides: Partial<AtlasScanComponent> = {},
): AtlasScanComponent {
  return {
    nodeKey: "node-1",
    selector: "main > section > a.cta",
    tag: "a",
    role: null,
    hint: "link",
    hintBasis: "native_semantics",
    label: "Read more",
    visible: true,
    offscreen: false,
    offCanvas: false,
    fullyClipped: false,
    sectionNodeKey: "section-1",
    childCount: 0,
    descendantCount: 0,
    hasHeading: false,
    hasMedia: false,
    hasIcon: false,
    inNavigation: false,
    ariaHasPopup: false,
    ariaExpanded: null,
    ariaControlsResolved: false,
    ariaLabel: null,
    overflowX: "visible",
    scrollableX: false,
    position: "static",
    transformed: false,
    shape: "span",
    childCounts: "1,0,0",
    display: "inline",
    gap: "normal",
    padding: "0px/0px/0px/0px",
    radius: "0px",
    fontFamily: "Inter",
    fontSize: "16px",
    fontWeight: "400",
    lineHeight: "24px",
    rect: { x: 0, y: 0, width: 100, height: 40 },
    depth: 1,
    pack: {
      nodes: [{ tag: "a", role: null, depth: 0, childCount: 1 }],
      truncated: false,
    },
    ...overrides,
  };
}

function scanWith(...components: AtlasScanComponent[]): AtlasPageScan {
  return {
    title: "Component fixture",
    url: "https://fixture.example/",
    totalHeight: 1_000,
    scrollRoot: null,
    sections: [
      {
        nodeKey: "section-1",
        selector: "main > section",
        tag: "section",
        role: null,
        landmark: null,
        heading: "Pricing",
        headingLevel: 2,
        text: "Plans",
        visible: true,
        articleNested: false,
        landmarkNested: false,
        paragraphCount: 1,
        linkCount: 1,
        mediaCount: 0,
        repeatedItems: 0,
        orderedItems: 0,
        quoteCount: 0,
        citationCount: 0,
        numericPairs: 1,
        formCount: 0,
        emailInputCount: 0,
        buttonCount: 0,
        buttonLabels: [],
        rect: { x: 0, y: 0, width: 1_000, height: 600 },
        viewport: { width: 1_200, height: 800 },
        backgroundColor: "rgb(255, 255, 255)",
        fixed: false,
        depth: 1,
        parentKey: null,
      },
    ],
    components,
    technologies: [],
    canvasCount: 0,
    webglObserved: false,
  };
}

/** RFC 6901 pointer resolution for evidence assertions. */
function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  return pointer
    .split("/")
    .slice(1)
    .reduce<unknown>((current, part) => {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if (Array.isArray(current)) return current[Number(key)];
      if (current && typeof current === "object") {
        return (current as Record<string, unknown>)[key];
      }
      return undefined;
    }, root);
}

describe("Atlas component discovery", () => {
  it("maps native, declared and structural evidence to distinct bases", () => {
    const candidates = discoverComponents(
      scanWith(
        rawComponent({ nodeKey: "link", selector: "a", hint: "link" }),
        rawComponent({
          nodeKey: "button",
          selector: "button",
          tag: "button",
          hint: "button",
        }),
        rawComponent({
          nodeKey: "switch",
          selector: "div.switch",
          tag: "div",
          role: "switch",
          hint: "switch",
          hintBasis: "declared_aria",
        }),
        rawComponent({
          nodeKey: "dialog",
          selector: "div.drawer",
          tag: "div",
          role: "dialog",
          hint: "dialog",
          hintBasis: "declared_aria",
          position: "fixed",
          transformed: true,
          offCanvas: true,
        }),
        rawComponent({
          nodeKey: "icon",
          selector: "button.icon",
          tag: "button",
          hint: "button",
          label: "",
          hasIcon: true,
        }),
        rawComponent({
          nodeKey: "card",
          selector: "article.card",
          tag: "article",
          hint: "card",
          hintBasis: "rule_derivation",
          hasHeading: true,
          hasMedia: true,
        }),
      ),
    );
    expect(candidates.map((candidate) => candidate.type)).toEqual([
      "link",
      "button",
      "switch",
      "drawer",
      "icon_button",
      "card",
    ]);
    expect(candidates[0]!.typeClassification).toBe("observed");
    expect(candidates[0]!.typeBasis).toBe("native_semantics");
    expect(candidates[2]!.typeClassification).toBe("observed");
    expect(candidates[2]!.typeBasis).toBe("declared_aria");
    expect(candidates[3]!.typeClassification).toBe("inferred");
    expect(candidates[3]!.typeBasis).toBe("rule_derivation");
    expect(candidates[4]!.typeClassification).toBe("inferred");
    expect(candidates[5]!.typeClassification).toBe("inferred");
  });

  it("forwards held-out evidence fields from the scan component", () => {
    const [candidate] = discoverComponents(
      scanWith(
        rawComponent({
          inputType: "email",
          ariaHasPopup: true,
          ariaExpanded: "true",
          ariaControlsResolved: true,
          inNavigation: true,
          ariaLabel: "Main navigation",
        }),
      ),
    );
    expect(candidate).toMatchObject({
      inputType: "email",
      ariaHasPopup: true,
      ariaExpanded: "true",
      ariaControlsResolved: true,
      inNavigation: true,
      ariaLabel: "Main navigation",
    });
  });

  it("keeps the native vocabulary observed and searchable", () => {
    const fixtures: Array<[string, string]> = [
      ["navigation", "nav"],
      ["form", "form"],
      ["text_input", "input"],
      ["select", "select"],
      ["checkbox", "input"],
      ["radio", "input"],
      ["table", "table"],
      ["list", "ul"],
      ["media_player", "video"],
      ["canvas", "canvas"],
      ["progress", "progress"],
      ["disclosure", "details"],
      ["dialog", "dialog"],
    ];
    const candidates = discoverComponents(
      scanWith(
        ...fixtures.map(([hint, tag], index) =>
          rawComponent({
            nodeKey: `native-${index}`,
            selector: `${tag}.native-${index}`,
            tag,
            hint,
          }),
        ),
      ),
    );
    expect(candidates.map((candidate) => candidate.type)).toEqual(
      fixtures.map(([hint]) => hint),
    );
    expect(
      candidates.every(
        (candidate) =>
          candidate.typeClassification === "observed" &&
          candidate.typeBasis === "native_semantics",
      ),
    ).toBe(true);
  });

  it("never turns a declared dialog into an open modal or overflow into a carousel", () => {
    const [dialog, overflowing] = discoverComponents(
      scanWith(
        rawComponent({
          nodeKey: "dialog",
          selector: "div.modal",
          tag: "div",
          role: "dialog",
          hint: "dialog",
          hintBasis: "declared_aria",
          position: "fixed",
          transformed: false,
          offscreen: false,
        }),
        rawComponent({
          nodeKey: "cards",
          selector: "div.cards",
          tag: "div",
          hint: "card",
          hintBasis: "rule_derivation",
          overflowX: "auto",
          scrollableX: true,
        }),
      ),
    );
    expect(dialog!.type).toBe("dialog");
    expect(dialog!.typeClassification).toBe("observed");
    expect(overflowing!.type).toBe("card");
    expect(overflowing!.type).not.toBe("carousel");
  });

  it("keeps an unresolved navigation trigger candidate-only", () => {
    const [trigger] = discoverComponents(
      scanWith(
        rawComponent({
          nodeKey: "trigger",
          selector: "nav button",
          tag: "button",
          hint: "navigation_trigger",
          hintBasis: "declared_aria",
          inNavigation: true,
          ariaHasPopup: true,
          ariaExpanded: "false",
          ariaControlsResolved: false,
        }),
      ),
    );
    expect(trigger!.type).toBe("navigation_trigger");
    expect(trigger!.typeDecision).toBe("candidate");
    expect(classifyComponents({ viewport: "desktop", candidate: trigger!, artifactKey: "scan" })[0]!
      .decision).toBe("candidate");
  });

  it("keeps hidden and offscreen controls candidate-only", () => {
    const scan = scanWith(
      rawComponent({ nodeKey: "hidden", visible: false }),
      rawComponent({ nodeKey: "offscreen", offscreen: true }),
      rawComponent({ nodeKey: "visible" }),
    );
    const candidates = discoverComponents(scan);
    expect(candidates.map((candidate) => candidate.typeDecision)).toEqual([
      "candidate",
      "candidate",
      "accepted",
    ]);
    for (const candidate of candidates.slice(0, 2)) {
      const claims = classifyComponents({
        viewport: "desktop",
        candidate,
        artifactKey: "scan",
        scan,
      });
      expect(claims[0]!).toMatchObject({ field: "component.type", decision: "candidate" });
    }
  });

  it("requires off-canvas geometry, not a transform alone, for a drawer", () => {
    const [onScreen, offCanvas] = discoverComponents(
      scanWith(
        rawComponent({
          nodeKey: "dialog-onscreen",
          selector: "div.modal",
          tag: "div",
          role: "dialog",
          hint: "dialog",
          hintBasis: "declared_aria",
          position: "fixed",
          transformed: true,
          offCanvas: false,
          offscreen: false,
        }),
        rawComponent({
          nodeKey: "dialog-offcanvas",
          selector: "div.drawer",
          tag: "div",
          role: "dialog",
          hint: "dialog",
          hintBasis: "declared_aria",
          position: "fixed",
          transformed: false,
          offCanvas: true,
        }),
      ),
    );
    expect(onScreen!).toMatchObject({ type: "dialog", typeClassification: "observed" });
    expect(offCanvas!).toMatchObject({
      type: "drawer",
      typeClassification: "inferred",
      typeDecision: "candidate",
    });
  });

  it("keeps every inferred component type candidate-only", () => {
    const scan = scanWith(
      rawComponent({
        nodeKey: "card",
        selector: "article.card",
        tag: "article",
        hint: "card",
        hintBasis: "rule_derivation",
      }),
      rawComponent({
        nodeKey: "drawer",
        selector: "div.drawer",
        tag: "div",
        hint: "drawer",
        hintBasis: "rule_derivation",
      }),
      rawComponent({
        nodeKey: "tooltip",
        selector: "div.tip",
        tag: "div",
        role: "tooltip",
        hint: "tooltip",
        hintBasis: "declared_aria",
      }),
      rawComponent({
        nodeKey: "carousel",
        selector: "div.carousel",
        tag: "div",
        hint: "carousel",
        hintBasis: "rule_derivation",
      }),
      rawComponent({
        nodeKey: "icon-button",
        selector: "button.icon",
        tag: "button",
        hint: "button",
        label: "",
        hasIcon: true,
      }),
    );
    const candidates = discoverComponents(scan);
    expect(candidates.map((candidate) => candidate.type)).toEqual([
      "card",
      "drawer",
      "tooltip",
      "carousel",
      "icon_button",
    ]);
    for (const candidate of candidates) {
      expect(candidate.typeClassification).toBe("inferred");
      expect(candidate.typeDecision).toBe("candidate");
      const claims = classifyComponents({
        viewport: "desktop",
        candidate,
        artifactKey: "scan",
        scan,
      });
      expect(claims[0]!.decision).toBe("candidate");
    }
  });

  it("accepts a resolved aria-controls trigger and keeps an unresolved one candidate", () => {
    const scan = scanWith(
      rawComponent({
        nodeKey: "resolved",
        selector: "nav button.resolved",
        tag: "button",
        hint: "navigation_trigger",
        hintBasis: "declared_aria",
        inNavigation: true,
        ariaHasPopup: true,
        ariaControlsResolved: true,
      }),
      rawComponent({
        nodeKey: "unresolved",
        selector: "nav button.unresolved",
        tag: "button",
        hint: "navigation_trigger",
        hintBasis: "declared_aria",
        inNavigation: true,
        ariaHasPopup: true,
        ariaControlsResolved: false,
      }),
    );
    const [resolved, unresolved] = discoverComponents(scan);
    expect(resolved!).toMatchObject({
      typeDecision: "accepted",
      typeRuleId: "component.aria.navigation-trigger.resolved",
    });
    expect(unresolved!).toMatchObject({
      typeDecision: "candidate",
      typeRuleId: "component.aria.navigation-trigger.unresolved",
    });
    const claims = classifyComponents({
      viewport: "desktop",
      candidate: resolved!,
      artifactKey: "scan",
      scan,
    });
    expect(claims[0]!.decision).toBe("accepted");
  });

  it("keys patterns on structure and capture scope only", () => {
    const scan = scanWith(rawComponent({ label: "Alpha", selector: "a.alpha" }));
    const [candidate] = discoverComponents(scan);
    const raw = scan.components![0]!;
    const scope = "site-a|/|desktop";
    const base = componentPatternKey({ ...candidate!, sectionKey: "section-key" }, raw, scope);
    expect(
      componentPatternKey(
        { ...candidate!, sectionKey: "section-key" },
        { ...raw, label: "Beta", selector: "a.beta", ariaLabel: "Beta" },
        scope,
      ),
    ).toBe(base);
    expect(
      componentPatternKey({ ...candidate!, sectionKey: "section-key" }, raw, "site-b|/|desktop"),
    ).not.toBe(base);
    expect(
      componentPatternKey({ ...candidate!, sectionKey: "section-key" }, raw, "site-a|/other|desktop"),
    ).not.toBe(base);
    expect(
      componentPatternKey({ ...candidate!, sectionKey: "other-section" }, raw, scope),
    ).not.toBe(base);
    const variations = [
      { shape: "div" },
      { childCounts: "2,0,0" },
      { display: "flex" },
      { gap: "8px" },
      { padding: "1px/2px/3px/4px" },
      { radius: "4px" },
      { fontFamily: "Serif" },
      { fontSize: "20px" },
      { fontWeight: "700" },
      { lineHeight: "28px" },
    ];
    for (const variation of variations) {
      expect(
        componentPatternKey(
          { ...candidate!, sectionKey: "section-key" },
          { ...raw, ...variation },
          scope,
        ),
      ).not.toBe(base);
    }
  });

  it("carries only accepted section purposes into component context", () => {
    const scan = scanWith(rawComponent({ hint: "link", tag: "a", selector: "a" }));
    const [candidate] = discoverComponents(scan);
    const claims = classifyComponents({
      viewport: "desktop",
      candidate: candidate!,
      artifactKey: "scan-desktop",
      sectionPurposes: ["pricing"],
      scan,
    });
    expect(claims.map((claim) => [claim.field, claim.value, claim.decision])).toEqual([
      ["component.type", "link", "accepted"],
      ["context.section_purpose", "pricing", "accepted"],
    ]);
    expect(claims[1]!.classification).toBe("inferred");
    // The context pointer resolves to the containing section's scan entry, not
    // to the component: a purpose claim is supported by the section evidence.
    expect(claims[1]!.evidence[0]).toMatchObject({
      artifactId: "scan-desktop",
      pointer: "/scan/sections/0",
    });
    const resolved = resolvePointer({ scan }, claims[1]!.evidence[0]!.pointer) as {
      nodeKey: string;
      heading: string;
    };
    expect(resolved.nodeKey).toBe(candidate!.sectionNodeKey);
    expect(resolved.heading.toLowerCase()).toContain("pricing");
    const withoutContext = classifyComponents({
      viewport: "desktop",
      candidate: candidate!,
      artifactKey: "scan-desktop",
      sectionPurposes: [],
      scan,
    });
    expect(withoutContext.some((claim) => claim.field === "context.section_purpose")).toBe(false);
  });

  it("omits section context when the section evidence cannot be resolved", () => {
    const scan = scanWith(rawComponent({ hint: "link", tag: "a", selector: "a" }));
    const [candidate] = discoverComponents(scan);
    const claims = classifyComponents({
      viewport: "desktop",
      candidate: { ...candidate!, sectionNodeKey: "missing-section" },
      artifactKey: "scan-desktop",
      sectionPurposes: ["pricing"],
      scan,
    });
    expect(claims.some((claim) => claim.field === "context.section_purpose")).toBe(false);
  });

  it("groups identical patterns and separates layout changes", () => {
    const base = discoverComponents(
      scanWith(
        rawComponent({ nodeKey: "a", selector: "button.a", tag: "button", hint: "button" }),
        rawComponent({ nodeKey: "b", selector: "button.b", tag: "button", hint: "button" }),
      ),
    );
    const same = base.map((candidate) => {
      const withSection = { ...candidate, sectionKey: "section-key" };
      return {
        ...withSection,
        patternKey: componentPatternKey(withSection, rawComponent({ hint: "button" })),
      };
    });
    const groups = groupComponentPatterns(same);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(2);

    const baseline = componentPatternKey(
      { ...base[0]!, sectionKey: "section-key" },
      rawComponent({ hint: "button" }),
    );
    const changed = componentPatternKey(
      { ...base[0]!, sectionKey: "section-key" },
      rawComponent({ hint: "button", gap: "24px" }),
    );
    expect(baseline).toBe(same[0]!.patternKey);
    expect(changed).not.toBe(baseline);
  });

  it("caps candidates before classification", () => {
    const components = Array.from({ length: 130 }, (_, index) =>
      rawComponent({
        nodeKey: `node-${index}`,
        selector: `a.link-${index}`,
        label: `Link ${index}`,
      }),
    );
    const candidates = discoverComponents(scanWith(...components));
    expect(candidates).toHaveLength(120);
  });
});

describe("Atlas component search", () => {
  function snapshot() {
    return makeSnapshot([
      {
        id: "hero-section",
        kind: "section",
        purpose: { value: "hero", decision: "accepted" },
        capture: "capture-a",
        page: "page-a",
        site: "site-a",
        ordinal: 3,
      },
      {
        id: "button-a",
        kind: "component",
        componentType: "button",
        sectionPurpose: "pricing",
        patternKey: "pattern-button",
        capture: "capture-a",
        page: "page-a",
        site: "site-a",
        ordinal: 0,
      },
      {
        id: "button-b",
        kind: "component",
        componentType: "button",
        sectionPurpose: "pricing",
        patternKey: "pattern-button",
        capture: "capture-a",
        page: "page-a",
        site: "site-a",
        ordinal: 1,
      },
      {
        id: "link-a",
        kind: "component",
        componentType: "link",
        sectionPurpose: "hero",
        patternKey: "pattern-link",
        capture: "capture-a",
        page: "page-a",
        site: "site-a",
        ordinal: 2,
      },
      {
        id: "button-other-site",
        kind: "component",
        componentType: "button",
        sectionPurpose: "pricing",
        patternKey: "pattern-button-other",
        capture: "capture-b",
        page: "page-b",
        site: "site-b",
        ordinal: 4,
      },
    ]);
  }

  it("defaults to pattern grouping and never returns section anchors", () => {
    const data = dataOrThrow(
      searchAtlas({ kind: "components" }, memoryStore(snapshot()), SEARCH_NOW),
    );
    expect(data.interpreted.groupBy).toBe("pattern");
    expect(data.countUnit).toBe("component_pattern");
    expect(data.total).toBe(3);
    expect(data.results.every((hit) => hit.kind === "component")).toBe(true);
    expect(data.results.map((hit) => hit.regionId)).not.toContain("hero-section");
    const button = data.results.find((hit) => hit.patternKey === "pattern-button")!;
    expect(button.group).toMatchObject({
      key: "pattern-button",
      matchingMembers: 2,
      observedMembers: 2,
    });
    expect(button.group!.memberRegionIds).toEqual(["button-a", "button-b"]);
    expect(data.facets).toEqual([]);
  });

  it("never returns a section anchor from the same capture", () => {
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          evidenceMode: "accepted",
          groupBy: "instance",
          limit: 20,
        },
        memoryStore(snapshot()),
        SEARCH_NOW,
      ),
    );
    expect(data.total).toBe(4);
    expect(data.results.map((hit) => hit.regionId)).not.toContain("hero-section");
    expect(data.results.every((hit) => hit.kind === "component")).toBe(true);
  });

  it("keeps hidden controls and inferred types out of accepted search", () => {
    const scoped = makeSnapshot([
      {
        id: "visible-button",
        kind: "component",
        componentType: "button",
        patternKey: "pattern-visible",
        capture: "capture-controls",
        page: "page-controls",
        site: "site-controls",
        ordinal: 0,
      },
      {
        id: "hidden-button",
        kind: "component",
        patternKey: "pattern-hidden",
        capture: "capture-controls",
        page: "page-controls",
        site: "site-controls",
        ordinal: 1,
        claims: [
          {
            field: "component.type",
            value: "button",
            decision: "candidate",
            classification: "observed",
            basis: "native_semantics",
          },
          {
            field: "component.visibility",
            value: "hidden",
            decision: "candidate",
            classification: "observed",
            basis: "computed_style",
          },
        ],
      },
      {
        id: "inferred-card",
        kind: "component",
        patternKey: "pattern-card",
        capture: "capture-controls",
        page: "page-controls",
        site: "site-controls",
        ordinal: 2,
        claims: [
          {
            field: "component.type",
            value: "card",
            decision: "candidate",
            classification: "inferred",
            basis: "rule_derivation",
          },
        ],
      },
    ]);
    const accepted = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          evidenceMode: "accepted",
          groupBy: "instance",
          predicates: [{ field: "component.type", values: ["button"] }],
        },
        memoryStore(scoped),
        SEARCH_NOW,
      ),
    );
    expect(accepted.results.map((hit) => hit.regionId)).toEqual(["visible-button"]);

    const candidates = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          evidenceMode: "candidate",
          groupBy: "instance",
          predicates: [{ field: "component.type", values: ["button"] }],
        },
        memoryStore(scoped),
        SEARCH_NOW,
      ),
    );
    expect(candidates.results.map((hit) => hit.regionId).sort()).toEqual([
      "hidden-button",
      "visible-button",
    ]);
    expect(
      candidates.results.every((hit) => hit.candidateOnly === true),
    ).toBe(true);

    const cardAccepted = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          evidenceMode: "accepted",
          groupBy: "instance",
          predicates: [{ field: "component.type", values: ["card"] }],
        },
        memoryStore(scoped),
        SEARCH_NOW,
      ),
    );
    expect(cardAccepted.total).toBe(0);
    const cardCandidate = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          evidenceMode: "candidate",
          groupBy: "instance",
          predicates: [{ field: "component.type", values: ["card"] }],
        },
        memoryStore(scoped),
        SEARCH_NOW,
      ),
    );
    expect(cardCandidate.results.map((hit) => hit.regionId)).toEqual(["inferred-card"]);
  });

  it("anchors accepted and observed_only search on eligible component types", () => {
    const scoped = makeSnapshot([
      {
        id: "visible-button",
        kind: "component",
        componentType: "button",
        sectionPurpose: "pricing",
        patternKey: "pattern-button",
        heading: "Action button",
        bm25: -1,
        capture: "capture-controls",
        page: "page-controls",
        site: "site-controls",
        ordinal: 0,
      },
      {
        id: "visible-link",
        kind: "component",
        componentType: "link",
        sectionPurpose: "pricing",
        patternKey: "pattern-link",
        heading: "Action link",
        bm25: -2,
        capture: "capture-controls",
        page: "page-controls",
        site: "site-controls",
        ordinal: 1,
      },
      {
        id: "hidden-button",
        kind: "component",
        sectionPurpose: "pricing",
        patternKey: "pattern-button",
        heading: "Action hidden",
        bm25: -10,
        capture: "capture-controls",
        page: "page-controls",
        site: "site-controls",
        ordinal: 2,
        claims: [
          {
            field: "component.type",
            value: "button",
            decision: "candidate",
            classification: "observed",
            basis: "native_semantics",
          },
          {
            field: "component.visibility",
            value: "hidden",
            decision: "candidate",
            classification: "observed",
            basis: "computed_style",
          },
        ],
      },
      {
        id: "inferred-card",
        kind: "component",
        sectionPurpose: "pricing",
        patternKey: "pattern-card",
        heading: "Action card",
        bm25: -9,
        capture: "capture-controls",
        page: "page-controls",
        site: "site-controls",
        ordinal: 3,
        claims: [
          {
            field: "component.type",
            value: "card",
            decision: "candidate",
            classification: "inferred",
            basis: "rule_derivation",
          },
        ],
      },
    ]);
    const eligible = ["visible-button", "visible-link"];
    for (const scope of ["region", "page", "site"] as const) {
      for (const evidenceMode of ["accepted", "observed_only"] as const) {
        const data = dataOrThrow(
          searchAtlas(
            {
              kind: "components",
              evidenceMode,
              scope,
              groupBy: "instance",
              limit: 20,
            },
            memoryStore(scoped),
            SEARCH_NOW,
          ),
        );
        expect(data.total).toBe(eligible.length);
        expect(data.results.map((hit) => hit.regionId).sort()).toEqual(eligible);
        expect(data.results.every((hit) => hit.candidateOnly === false)).toBe(true);
      }
    }

    const acceptedGrouped = dataOrThrow(
      searchAtlas(
        { kind: "components", evidenceMode: "accepted", limit: 20 },
        memoryStore(scoped),
        SEARCH_NOW,
      ),
    );
    expect(acceptedGrouped.total).toBe(2);
    const acceptedButton = acceptedGrouped.results.find(
      (hit) => hit.patternKey === "pattern-button",
    )!;
    expect(acceptedButton.group).toMatchObject({
      matchingMembers: 1,
      observedMembers: 1,
      memberRegionIds: ["visible-button"],
    });

    const facets = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          evidenceMode: "accepted",
          groupBy: "instance",
          facets: ["component.type", "context.section_purpose", "region.kind"],
        },
        memoryStore(scoped),
        SEARCH_NOW,
      ),
    );
    const typeFacet = facets.facets.find((facet) => facet.field === "component.type")!;
    expect(typeFacet.values.find((value) => value.value === "button")?.count).toBe(1);
    expect(typeFacet.values.find((value) => value.value === "link")?.count).toBe(1);
    expect(typeFacet.values.find((value) => value.value === "card")?.count).toBe(0);
    const contextFacet = facets.facets.find(
      (facet) => facet.field === "context.section_purpose",
    )!;
    expect(contextFacet.values.find((value) => value.value === "pricing")?.count).toBe(2);
    const kindFacet = facets.facets.find((facet) => facet.field === "region.kind")!;
    expect(kindFacet.values).toEqual([{ value: "component", count: 2, selected: false }]);

    const candidate = dataOrThrow(
      searchAtlas(
        { kind: "components", evidenceMode: "candidate", groupBy: "instance", limit: 20 },
        memoryStore(scoped),
        SEARCH_NOW,
      ),
    );
    expect(candidate.total).toBe(4);
    expect(candidate.results.map((hit) => hit.regionId).sort()).toEqual([
      "hidden-button",
      "inferred-card",
      "visible-button",
      "visible-link",
    ]);
    expect(candidate.results.every((hit) => hit.candidateOnly === true)).toBe(true);
    const candidateButton = dataOrThrow(
      searchAtlas(
        { kind: "components", evidenceMode: "candidate", limit: 20 },
        memoryStore(scoped),
        SEARCH_NOW,
      ),
    ).results.find((hit) => hit.patternKey === "pattern-button")!;
    expect(candidateButton.group).toMatchObject({
      matchingMembers: 2,
      observedMembers: 2,
      memberRegionIds: ["visible-button", "hidden-button"],
    });

    const text = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          query: "action",
          evidenceMode: "accepted",
          groupBy: "instance",
          limit: 20,
        },
        memoryStore(scoped),
        SEARCH_NOW,
      ),
    );
    expect(text.results.map((hit) => hit.regionId).sort()).toEqual(eligible);

    const cardAccepted = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          evidenceMode: "accepted",
          groupBy: "instance",
          predicates: [{ field: "component.type", values: ["card"] }],
        },
        memoryStore(scoped),
        SEARCH_NOW,
      ),
    );
    expect(cardAccepted.total).toBe(0);
    const contextAccepted = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          evidenceMode: "accepted",
          groupBy: "instance",
          predicates: [{ field: "context.section_purpose", values: ["pricing"] }],
        },
        memoryStore(scoped),
        SEARCH_NOW,
      ),
    );
    expect(contextAccepted.results.map((hit) => hit.regionId).sort()).toEqual(eligible);

    // A candidate hit still describes its own type: accepted first, else the
    // first eligible claim including a candidate one.
    const cardCandidate = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          evidenceMode: "candidate",
          groupBy: "instance",
          predicates: [{ field: "component.type", values: ["card"] }],
        },
        memoryStore(scoped),
        SEARCH_NOW,
      ),
    );
    expect(cardCandidate.results).toHaveLength(1);
    expect(cardCandidate.results[0]).toMatchObject({
      regionId: "inferred-card",
      componentType: "card",
      primaryLabel: "card",
      candidateOnly: true,
    });
  });

  it("filters by component.type and context.section_purpose without section leakage", () => {
    const byType = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          evidenceMode: "accepted",
          predicates: [{ field: "component.type", values: ["button"] }],
          groupBy: "instance",
        },
        memoryStore(snapshot()),
        SEARCH_NOW,
      ),
    );
    expect(byType.countUnit).toBe("region_instance");
    expect(byType.results.map((hit) => hit.regionId)).toEqual([
      "button-a",
      "button-b",
      "button-other-site",
    ]);
    expect(byType.results.every((hit) => hit.componentType === "button")).toBe(true);

    const byContext = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          evidenceMode: "accepted",
          predicates: [{ field: "context.section_purpose", values: ["hero"] }],
          groupBy: "instance",
        },
        memoryStore(snapshot()),
        SEARCH_NOW,
      ),
    );
    expect(byContext.results.map((hit) => hit.regionId)).toEqual(["link-a"]);
  });

  it("counts facets in the requested unit and keeps selected values", () => {
    const grouped = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          evidenceMode: "accepted",
          facets: ["component.type", "context.section_purpose", "region.kind"],
        },
        memoryStore(snapshot()),
        SEARCH_NOW,
      ),
    );
    const typeFacet = grouped.facets.find((facet) => facet.field === "component.type")!;
    expect(typeFacet.countUnit).toBe("component_pattern");
    expect(typeFacet.values.find((value) => value.value === "button")?.count).toBe(2);
    expect(typeFacet.values.find((value) => value.value === "link")?.count).toBe(1);
    const contextFacet = grouped.facets.find(
      (facet) => facet.field === "context.section_purpose",
    )!;
    expect(contextFacet.values.find((value) => value.value === "pricing")?.count).toBe(2);
    const kindFacet = grouped.facets.find((facet) => facet.field === "region.kind")!;
    expect(kindFacet.values).toEqual([
      { value: "component", count: 3, selected: false },
    ]);

    const selected = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          evidenceMode: "accepted",
          predicates: [{ field: "component.type", values: ["link"] }],
          facets: ["component.type"],
          groupBy: "instance",
        },
        memoryStore(snapshot()),
        SEARCH_NOW,
      ),
    );
    expect(
      selected.facets[0]!.values.find((value) => value.value === "link"),
    ).toMatchObject({ count: 1, selected: true });
  });

  it("hydrates only the selected pattern metadata when grouped and limited", () => {
    const snapshot = makeSnapshot(
      Array.from({ length: 10_000 }, (_, index) => ({
        id: `component-${index}`,
        kind: "component" as const,
        componentType: "button",
        patternKey: `pattern-${index}`,
        capture: "capture-large",
        page: "page-large",
        site: "site-large",
        ordinal: index,
      })),
    );
    const original = DatabaseSync.prototype.prepare;
    let anchorRows = 0;
    DatabaseSync.prototype.prepare = function (sql: string) {
      const statement = original.call(this, sql);
      return new Proxy(statement, {
        get(target, property) {
          if (property === "all") {
            return (...args: unknown[]) => {
              const rows = target.all(...args);
              if (sql.includes("temp.component_anchors")) anchorRows += rows.length;
              return rows;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    try {
      const data = dataOrThrow(
        searchAtlas(
          { kind: "components", evidenceMode: "accepted", limit: 1 },
          memoryStore(snapshot),
          SEARCH_NOW,
        ),
      );
      expect(data.results).toHaveLength(1);
      expect(data.total).toBe(10_000);
      expect(data.results[0]!.group).toMatchObject({
        key: "pattern-0",
        matchingMembers: 1,
        memberRegionIds: ["component-0"],
      });
    } finally {
      DatabaseSync.prototype.prepare = original;
    }
    // Selected anchors (limit + hasMore) plus one count and one group member.
    expect(anchorRows).toBeLessThan(10);
  });

  it("keeps section search section-only", () => {
    const sections = dataOrThrow(
      searchAtlas({ kind: "sections", limit: 20 }, memoryStore(snapshot()), SEARCH_NOW),
    );
    expect(sections.results.map((hit) => hit.regionId)).toEqual(["hero-section"]);
    const rejected = searchAtlas(
      {
        kind: "sections",
        predicates: [{ field: "component.type", values: ["button"] }],
      },
      memoryStore(snapshot()),
      SEARCH_NOW,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("UNSUPPORTED_PREDICATE");
  });

  it("accepts region.kind=component as a no-op predicate", () => {
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          evidenceMode: "accepted",
          groupBy: "instance",
          predicates: [{ field: "region.kind", values: ["component"] }],
        },
        memoryStore(snapshot()),
        SEARCH_NOW,
      ),
    );
    expect(data.results).toHaveLength(4);
    expect(data.results.every((hit) => hit.kind === "component")).toBe(true);

    const combined = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          evidenceMode: "accepted",
          groupBy: "instance",
          predicates: [
            { field: "region.kind", values: ["component"] },
            { field: "component.type", values: ["link"] },
          ],
        },
        memoryStore(snapshot()),
        SEARCH_NOW,
      ),
    );
    expect(combined.results.map((hit) => hit.regionId)).toEqual(["link-a"]);
  });

  it("uses text scores without letting section anchors into component results", () => {
    const textSnapshot = makeSnapshot([
      { id: "section-hero", kind: "section", heading: "Action hero", bm25: -9 },
      {
        id: "button-text",
        kind: "component",
        componentType: "button",
        heading: "Action button",
        patternKey: "pattern-button-text",
        bm25: -1,
      },
      {
        id: "link-text",
        kind: "component",
        componentType: "link",
        heading: "Action link",
        patternKey: "pattern-link-text",
        bm25: -5,
      },
    ]);
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          query: "action",
          evidenceMode: "accepted",
          groupBy: "instance",
        },
        memoryStore(textSnapshot),
        SEARCH_NOW,
      ),
    );
    expect(data.results.map((hit) => hit.regionId)).toEqual(["link-text", "button-text"]);
    expect(data.results.every((hit) => hit.kind === "component")).toBe(true);
  });

  it("keeps page witnesses within one capture and site witnesses across pages", () => {
    const scoped = makeSnapshot([
      {
        id: "type-only",
        kind: "component",
        componentType: "button",
        patternKey: "pattern-type",
        capture: "capture-one",
        page: "page-one",
        site: "site-scope",
        ordinal: 0,
      },
      {
        id: "context-only",
        kind: "component",
        componentType: "link",
        sectionPurpose: "pricing",
        patternKey: "pattern-context",
        capture: "capture-one",
        page: "page-one",
        site: "site-scope",
        ordinal: 1,
      },
      {
        id: "other-page",
        kind: "component",
        componentType: "button",
        sectionPurpose: "hero",
        patternKey: "pattern-other",
        capture: "capture-two",
        page: "page-two",
        site: "site-scope",
        ordinal: 0,
      },
    ]);
    const page = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          scope: "page",
          evidenceMode: "accepted",
          groupBy: "instance",
          predicates: [
            { field: "component.type", values: ["button"] },
            { field: "context.section_purpose", values: ["pricing"] },
          ],
        },
        memoryStore(scoped),
        SEARCH_NOW,
      ),
    );
    expect(page.results.map((hit) => hit.regionId).sort()).toEqual([
      "context-only",
      "type-only",
    ]);
    expect(
      page.results
        .find((hit) => hit.regionId === "context-only")!
        .explanations.find((explanation) => explanation.field === "component.type")!
        .supportingRegionIds,
    ).toEqual(["type-only"]);

    const site = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          scope: "site",
          evidenceMode: "accepted",
          groupBy: "instance",
          predicates: [
            { field: "component.type", values: ["button"] },
            { field: "context.section_purpose", values: ["pricing"] },
          ],
        },
        memoryStore(scoped),
        SEARCH_NOW,
      ),
    );
    expect(site.results.map((hit) => hit.regionId).sort()).toEqual([
      "context-only",
      "other-page",
      "type-only",
    ]);
    expect(site.results[0]!.observationSpan).toEqual({
      from: expect.any(Number),
      to: expect.any(Number),
    });
  });

  it("rejects component predicates on sections and section predicates on components", () => {
    const componentFieldOnSections = searchAtlas(
      { kind: "sections", predicates: [{ field: "context.section_purpose", values: ["hero"] }] },
      memoryStore(snapshot()),
      SEARCH_NOW,
    );
    expect(componentFieldOnSections.ok).toBe(false);
    if (!componentFieldOnSections.ok) {
      expect(componentFieldOnSections.error.code).toBe("UNSUPPORTED_PREDICATE");
    }
    const sectionFieldOnComponents = searchAtlas(
      { kind: "components", predicates: [{ field: "section.purpose", values: ["hero"] }] },
      memoryStore(snapshot()),
      SEARCH_NOW,
    );
    expect(sectionFieldOnComponents.ok).toBe(false);
    if (!sectionFieldOnComponents.ok) {
      expect(sectionFieldOnComponents.error.code).toBe("UNSUPPORTED_PREDICATE");
    }
  });
});

describe("Atlas component persistence", () => {
  async function publishComponentAttempt() {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    const scan = scanWith(
      rawComponent({
        nodeKey: "link",
        selector: "main > section > a.cta",
        label: "Start now",
      }),
    );
    const regions = segmentRegions(scan);
    const sectionKey = regions[0]!.key;
    const raw = scan.components![0]!;
    const candidates = discoverComponents(scan).map((candidate) => ({
      ...candidate,
      sectionKey,
      patternKey: componentPatternKey({ ...candidate, sectionKey }, raw),
    }));
    const scanArtifact = writeJsonArtifactSync(cache.rootDir, {
      schemaVersion: "awwwards-atlas-live-scan-v1",
      viewport: "desktop",
      scan,
    });
    const packArtifact = writeJsonArtifactSync(cache.rootDir, {
      schemaVersion: "awwwards-atlas-component-pack-v1",
      componentKey: candidates[0]!.key,
      type: candidates[0]!.type,
      nodes: candidates[0]!.pack!.nodes,
      truncated: false,
    });
    const scanStored: AtlasStoredArtifact = {
      key: "scan-desktop",
      kind: "raw_observation",
      storagePath: scanArtifact.storagePath,
      sha256: scanArtifact.sha256,
      bytes: scanArtifact.bytes,
      mimeType: "application/json",
      regionKey: null,
    };
    const packStored: AtlasStoredArtifact = {
      key: "component-pack-0",
      kind: "component_pack",
      storagePath: packArtifact.storagePath,
      sha256: packArtifact.sha256,
      bytes: packArtifact.bytes,
      mimeType: "application/json",
      regionKey: candidates[0]!.key,
    };
    const claims = [
      ...classifySections(
        regions.map((candidate) => ({
          viewport: "desktop" as const,
          candidate,
          scan,
          artifactKey: "scan-desktop",
        })),
      ),
      ...classifyComponents({
        viewport: "desktop",
        candidate: candidates[0]!,
        artifactKey: "scan-desktop",
        packArtifactKey: "component-pack-0",
        sectionPurposes: ["pricing"],
        scan,
      }),
    ];
    const target = {
      siteSlug: "component-fixture",
      requestedUrl: "https://fixture.example/",
      urlKey: "https://fixture.example/",
      path: "/",
    };
    const attempt: AtlasCaptureAttempt = {
      cache,
      target,
      attemptId: "component-attempt",
      startedAt: SEARCH_NOW - 1_000,
      finishedAt: SEARCH_NOW,
      status: "complete",
      coverage: { status: "complete", collected: 2, excluded: 0, limitations: [] },
      limitations: [],
      artifacts: [scanStored, packStored],
      viewports: [
        {
          viewport: "desktop",
          profileKey: "live-desktop",
          status: "complete",
          coverage: { status: "complete", collected: 2, excluded: 0, limitations: [] },
          limitations: [],
          finalUrl: target.requestedUrl,
          browserVersion: "fixture",
          dpr: 1,
          reducedMotion: "no-preference",
          scrollRoot: null,
          overlayState: "none",
          loadingFailures: [],
          scan,
          regions,
          components: candidates,
          claims,
          screenshots: [],
          artifacts: [scanStored, packStored],
        },
      ],
    };
    return { cache, attempt, candidate: candidates[0]! };
  }

  it("persists kind=component with containment, pattern and claims", async () => {
    const { cache, attempt, candidate } = await publishComponentAttempt();
    const result = await publishCapture(attempt);
    expect(result.published, result.code).toBe(true);
    expect(result.componentCount).toBe(1);
    expect(result.regionCount).toBe(1);
    const rows = cache.withAtlasDb((db) => {
      const component = db
        .prepare(
          "SELECT id, parent_id, pattern_key FROM atlas_regions WHERE kind = 'component'",
        )
        .get() as { id: string; parent_id: string; pattern_key: string };
      const section = db
        .prepare("SELECT id FROM atlas_regions WHERE kind = 'section'")
        .get() as { id: string };
      const claims = db
        .prepare("SELECT field, value, decision FROM atlas_claims WHERE region_id = ? ORDER BY field")
        .all(component.id) as Array<{ field: string; value: string; decision: string }>;
      const fts = db
        .prepare("SELECT title, labels FROM atlas_regions_fts WHERE region_id = ?")
        .get(component.id) as { title: string; labels: string } | undefined;
      const pack = db
        .prepare("SELECT region_id FROM atlas_artifacts WHERE kind = 'component_pack'")
        .get() as { region_id: string | null } | undefined;
      return { component, section, claims, fts, pack };
    });
    expect(rows.component.parent_id).toBe(rows.section.id);
    expect(rows.component.pattern_key).toBe(candidate.patternKey);
    expect(rows.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "component.type", value: "link", decision: "accepted" }),
        expect.objectContaining({
          field: "context.section_purpose",
          value: "pricing",
          decision: "accepted",
        }),
      ]),
    );
    expect(rows.fts?.labels).toContain("component.type link");
    expect(rows.pack?.region_id).toBe(rows.component.id);
  });

  it("keeps off-canvas and fully clipped controls out of accepted search", async () => {
    const cache = new Cache(tmpDir(), () => SEARCH_NOW, { atlas: true });
    const scan = scanWith(
      rawComponent({
        nodeKey: "fixed-below",
        selector: "main > section > button.fixed",
        tag: "button",
        hint: "button",
        label: "Fixed below",
        offCanvas: true,
        rect: { x: 10, y: 900, width: 100, height: 40 },
      }),
      rawComponent({
        nodeKey: "fully-clipped",
        selector: "main > section > div.clipped",
        tag: "div",
        role: "button",
        hint: "button",
        hintBasis: "declared_aria",
        label: "Fully clipped",
        fullyClipped: true,
      }),
      rawComponent({
        nodeKey: "partial-native",
        selector: "main > section > button.partial",
        tag: "button",
        hint: "button",
        label: "Partial native",
      }),
      rawComponent({
        nodeKey: "partial-declared",
        selector: "main > section > div.partial",
        tag: "div",
        role: "button",
        hint: "button",
        hintBasis: "declared_aria",
        label: "Partial declared",
      }),
    );
    const regions = segmentRegions(scan);
    const sectionKey = regions[0]!.key;
    const candidates = discoverComponents(scan).map((candidate) => ({
      ...candidate,
      sectionKey,
      patternKey: componentPatternKey(
        { ...candidate, sectionKey },
        scan.components![candidate.scanIndex],
      ),
    }));
    const scanArtifact = writeJsonArtifactSync(cache.rootDir, {
      schemaVersion: "awwwards-atlas-live-scan-v1",
      viewport: "desktop",
      scan,
    });
    const scanStored: AtlasStoredArtifact = {
      key: "scan-desktop",
      kind: "raw_observation",
      storagePath: scanArtifact.storagePath,
      sha256: scanArtifact.sha256,
      bytes: scanArtifact.bytes,
      mimeType: "application/json",
      regionKey: null,
    };
    const claims = [
      ...classifySections(
        regions.map((candidate) => ({
          viewport: "desktop" as const,
          candidate,
          scan,
          artifactKey: "scan-desktop",
        })),
      ),
      ...candidates.flatMap((candidate) =>
        classifyComponents({
          viewport: "desktop",
          candidate,
          artifactKey: "scan-desktop",
          sectionPurposes: [],
          scan,
        }),
      ),
    ];
    const target = {
      siteSlug: "visibility-fixture",
      requestedUrl: "https://fixture.example/",
      urlKey: "https://fixture.example/",
      path: "/",
    };
    const attempt: AtlasCaptureAttempt = {
      cache,
      target,
      attemptId: "visibility-attempt",
      startedAt: SEARCH_NOW - 1_000,
      finishedAt: SEARCH_NOW,
      status: "complete",
      coverage: { status: "complete", collected: 2, excluded: 0, limitations: [] },
      limitations: [],
      artifacts: [scanStored],
      viewports: [
        {
          viewport: "desktop",
          profileKey: "live-desktop",
          status: "complete",
          coverage: { status: "complete", collected: 2, excluded: 0, limitations: [] },
          limitations: [],
          finalUrl: target.requestedUrl,
          browserVersion: "fixture",
          dpr: 1,
          reducedMotion: "no-preference",
          scrollRoot: null,
          overlayState: "none",
          loadingFailures: [],
          scan,
          regions,
          components: candidates,
          claims,
          screenshots: [],
          artifacts: [scanStored],
        },
      ],
    };
    const published = await publishCapture(attempt);
    expect(published.published, published.code).toBe(true);
    const labelByRegion = cache.withAtlasDb(
      (db) =>
        new Map(
          (
            db
              .prepare("SELECT id, heading FROM atlas_regions WHERE kind = 'component'")
              .all() as Array<{ id: string; heading: string }>
          ).map((row) => [row.id, row.heading]),
        ),
    );
    const accepted = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          evidenceMode: "accepted",
          groupBy: "instance",
          limit: 20,
        },
        atlasSearchStore(cache),
        SEARCH_NOW,
      ),
    );
    expect(accepted.results.map((hit) => labelByRegion.get(hit.regionId))).toEqual([
      "Partial native",
      "Partial declared",
    ]);
    const candidatesMode = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          evidenceMode: "candidate",
          groupBy: "instance",
          limit: 20,
        },
        atlasSearchStore(cache),
        SEARCH_NOW,
      ),
    );
    expect(candidatesMode.results.map((hit) => labelByRegion.get(hit.regionId)).sort()).toEqual([
      "Fixed below",
      "Fully clipped",
      "Partial declared",
      "Partial native",
    ]);
    expect(candidatesMode.results.every((hit) => hit.candidateOnly === true)).toBe(true);
  });

  it("rejects a pack whose payload names another component", async () => {
    const { cache, attempt, candidate } = await publishComponentAttempt();
    const viewport = attempt.viewports[0]!;
    const pack = viewport.artifacts.find((artifact) => artifact.kind === "component_pack")!;
    const replacement = writeJsonArtifactSync(cache.rootDir, {
      schemaVersion: "awwwards-atlas-component-pack-v1",
      componentKey: "other-component",
      type: candidate.type,
      nodes: candidate.pack!.nodes,
      truncated: false,
    });
    Object.assign(pack, replacement);
    const result = await publishCapture(attempt);
    expect(result).toMatchObject({ published: false, code: "PACK_OWNERSHIP_MISMATCH" });
    const heads = cache.withAtlasDb(
      (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_heads").get() as { n: number }).n,
    );
    expect(heads).toBe(0);
  });

  it("rejects a pack whose root does not match the owning component", async () => {
    const { cache, attempt, candidate } = await publishComponentAttempt();
    const viewport = attempt.viewports[0]!;
    const pack = viewport.artifacts.find((artifact) => artifact.kind === "component_pack")!;
    const replacement = writeJsonArtifactSync(cache.rootDir, {
      schemaVersion: "awwwards-atlas-component-pack-v1",
      componentKey: candidate.key,
      type: "dialog",
      nodes: [{ tag: "div", role: "dialog", depth: 0, childCount: 0 }],
      truncated: false,
    });
    Object.assign(pack, replacement);
    const result = await publishCapture(attempt);
    expect(result).toMatchObject({ published: false, code: "PACK_OWNERSHIP_MISMATCH" });
  });

  it("rejects a claim that points at another component's pack", async () => {
    const { attempt, candidate } = await publishComponentAttempt();
    const viewport = attempt.viewports[0]!;
    const other = {
      ...candidate,
      key: "other-component-key",
      nodeKey: "other-component-node",
      selector: "main > section > a.other",
      ordinal: 1,
    };
    viewport.components = [...(viewport.components ?? []), other];
    const claim = viewport.claims.find(
      (item) => item.regionKey === candidate.key && item.field === "component.type",
    )!;
    claim.regionKey = other.key;
    const result = await publishCapture(attempt);
    expect(result).toMatchObject({ published: false, code: "PACK_OWNERSHIP_MISMATCH" });
  });

  it("serves persisted components through search and keeps sections separate", async () => {
    const { cache, attempt } = await publishComponentAttempt();
    const published = await publishCapture(attempt); expect(published.published, published.code).toBe(true);
    const components = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          evidenceMode: "accepted",
          groupBy: "instance",
          predicates: [{ field: "context.section_purpose", values: ["pricing"] }],
        },
        atlasSearchStore(cache),
        SEARCH_NOW,
      ),
    );
    expect(components.results).toHaveLength(1);
    expect(components.results[0]!.kind).toBe("component");
    expect(components.results[0]!.componentType).toBe("link");
    expect(components.results[0]!.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "component_pack",
          mimeType: "application/json",
          bytes: expect.any(Number),
          sha256: expect.any(String),
        }),
      ]),
    );
    const sections = dataOrThrow(
      searchAtlas({ kind: "sections", limit: 20 }, atlasSearchStore(cache), SEARCH_NOW),
    );
    expect(sections.results.every((hit) => hit.kind === "section")).toBe(true);
    expect(sections.results.map((hit) => hit.regionId)).not.toContain(
      components.results[0]!.regionId,
    );
  });

  it("rebuilds v10 component projections from stored rows after a v8 downgrade", async () => {
    const { cache, attempt } = await publishComponentAttempt();
    const published = await publishCapture(attempt); expect(published.published, published.code).toBe(true);
    cache.withAtlasDb((db) => {
      db.prepare(
        "UPDATE atlas_state SET schema_version = 8, fts_version = 2 WHERE singleton = 1",
      ).run();
    });
    const reopened = new Cache(cache.rootDir, () => SEARCH_NOW, { atlas: true });
    const state = reopened.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT schema_version, fts_version FROM atlas_state WHERE singleton = 1")
          .get() as { schema_version: number; fts_version: number },
    );
    expect(state).toEqual({ schema_version: 10, fts_version: 4 });
    const data = dataOrThrow(
      searchAtlas(
        {
          kind: "components",
          evidenceMode: "accepted",
          groupBy: "instance",
        },
        atlasSearchStore(reopened),
        SEARCH_NOW,
      ),
    );
    expect(data.results.some((hit) => hit.componentType === "link")).toBe(true);
  });
});

describe("Atlas component mapping audit", () => {
  // Documented contract. Fixtures below exercise the same table; this audit
  // proves mapping, not held-out precision.
  const expectedNative: Record<string, string> = {
    a: "link",
    button: "button",
    nav: "navigation",
    form: "form",
    select: "select",
    textarea: "text_input",
    table: "table",
    ul: "list",
    ol: "list",
    video: "media_player",
    audio: "media_player",
    canvas: "canvas",
    progress: "progress",
    details: "disclosure",
    dialog: "dialog",
  };
  const expectedAria: Record<string, string> = {
    link: "link",
    button: "button",
    navigation: "navigation",
    checkbox: "checkbox",
    radio: "radio",
    switch: "switch",
    tablist: "tabs",
    dialog: "dialog",
    alertdialog: "dialog",
    tooltip: "tooltip",
    alert: "alert",
    progressbar: "progress",
    list: "list",
    table: "table",
    form: "form",
    search: "form",
    searchbox: "text_input",
    textbox: "text_input",
    combobox: "combobox",
  };
  const expectedInput: Record<string, string> = {
    checkbox: "checkbox",
    radio: "radio",
    submit: "button",
    button: "button",
    reset: "button",
    text: "text_input",
    search: "text_input",
    email: "text_input",
    tel: "text_input",
    url: "text_input",
    password: "text_input",
    number: "text_input",
    "": "text_input",
  };

  it("matches the documented native/ARIA/input table exactly", () => {
    expect(ATLAS_COMPONENT_HINTS.native).toEqual(expectedNative);
    expect(ATLAS_COMPONENT_HINTS.aria).toEqual(expectedAria);
    expect(ATLAS_COMPONENT_HINTS.input).toEqual(expectedInput);
    // The vocabulary has no listbox or grid type; a lossy alias would be a
    // declared claim about a role that was never observed.
    expect(Object.keys(expectedAria)).not.toContain("listbox");
    expect(Object.keys(expectedAria)).not.toContain("grid");
  });

  it("emits only supported canonical vocabulary values", () => {
    const fixtures = [
      ...Object.entries(expectedNative).map(([tag, type]) =>
        rawComponent({
          nodeKey: `native-${tag}`,
          selector: tag,
          tag,
          hint: type,
          hintBasis: "native_semantics",
        }),
      ),
      ...Object.entries(expectedAria).map(([role, type]) =>
        rawComponent({
          nodeKey: `aria-${role}`,
          selector: `div[role=${role}]`,
          tag: "div",
          role,
          hint: type,
          hintBasis: "declared_aria",
        }),
      ),
      ...Object.entries(expectedInput).map(([type, hint]) =>
        rawComponent({
          nodeKey: `input-${type || "text"}`,
          selector: `input[type=${type || "text"}]`,
          tag: "input",
          hint,
          hintBasis: "native_semantics",
        }),
      ),
    ];
    const candidates = discoverComponents(scanWith(...fixtures));
    expect(candidates.map((candidate) => candidate.type)).toEqual([
      ...Object.values(expectedNative),
      ...Object.values(expectedAria),
      ...Object.values(expectedInput),
    ]);
    expect(
      candidates.every((candidate) =>
        isSearchableVocabulary("component.type", candidate.type),
      ),
    ).toBe(true);
  });
});

describe("Atlas component schema migration", () => {
  it("upgrades a v8 cache additively to v10 component projections", () => {
    const root = tmpDir();
    const cache = new Cache(root, () => SEARCH_NOW, { atlas: true });
    cache.withAtlasDb((db) => {
      db.prepare("UPDATE atlas_state SET schema_version = 8 WHERE singleton = 1").run();
    });
    const reopened = new Cache(root, () => SEARCH_NOW, { atlas: true });
    const state = reopened.withAtlasDb((db) => {
      const summary = db.prepare("PRAGMA table_info(atlas_capture_summary)").all() as Array<{
        name: string;
      }>;
      const features = db.prepare("PRAGMA table_info(atlas_region_features)").all() as Array<{
        name: string;
      }>;
      return {
        version: (
          db
            .prepare("SELECT schema_version FROM atlas_state WHERE singleton = 1")
            .get() as { schema_version: number }
        ).schema_version,
        summary: summary.map((column) => column.name),
        features: features.map((column) => column.name),
      };
    });
    expect(state.version).toBe(10);
    expect(state.summary).toContain("components");
    expect(state.features).toEqual(
      expect.arrayContaining(["candidate_tier", "accepted_tier", "observed_tier"]),
    );
  });
});
