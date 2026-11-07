import { describe, expect, it } from "vitest";
import { segmentRegions, segmentRegionsWithStats } from "../src/atlas/segmentation.js";
import type { AtlasPageScan, AtlasScanSection } from "../src/atlas/live-types.js";
import { loadPhase2Fixture } from "./helpers/phase2-fixture.js";

const section = (over: Partial<AtlasScanSection> = {}): AtlasScanSection => ({
  nodeKey: over.nodeKey ?? over.selector ?? "node-x",
  selector: "main > section.x",
  tag: "section",
  role: null,
  landmark: null,
  heading: "X",
  headingLevel: 2,
  text: "X",
  visible: true,
  articleNested: false,
  landmarkNested: false,
  paragraphCount: 1,
  linkCount: 0,
  mediaCount: 0,
  repeatedItems: 0,
  orderedItems: 0,
  quoteCount: 0,
  citationCount: 0,
  numericPairs: 0,
  formCount: 0,
  emailInputCount: 0,
  buttonCount: 0,
  buttonLabels: [],
  rect: { x: 0, y: 100, width: 1200, height: 400 },
  viewport: { width: 1440, height: 900 },
  backgroundColor: "#fff",
  fixed: false,
  depth: 1,
  parentKey: null,
  ...over,
});

const scan = (sections: AtlasScanSection[]): AtlasPageScan => ({
  title: "t",
  url: "https://example.com/",
  totalHeight: 2000,
  scrollRoot: null,
  sections,
  technologies: [],
  canvasCount: 0,
  webglObserved: false,
});

describe("Atlas section segmentation", () => {
  it("is deterministic and maps fixture sections to ordered candidates", () => {
    const { scan: fixture } = loadPhase2Fixture();
    const first = segmentRegions(fixture);
    const second = segmentRegions(fixture);
    expect(first.length).toBe(fixture.sections.length);
    expect(first.map((region) => region.key)).toEqual(second.map((region) => region.key));
    expect(first.map((region) => region.ordinal)).toEqual(first.map((_, index) => index));
    expect(first.every((region) => region.rect.width > 0 && region.rect.height > 0)).toBe(true);
  });

  it("drops fixed overlays and duplicate nested shells", () => {
    const base = section({ selector: "main > section.a" });
    const regions = segmentRegions(
      scan([
        base,
        { ...base, selector: "main > section.a-inner" },
        section({ selector: "div.cookie", fixed: true }),
        section({ selector: "main > section.b", rect: { x: 0, y: 600, width: 1200, height: 300 } }),
      ]),
    );
    expect(regions).toHaveLength(2);
    expect(regions.map((region) => region.selector)).toEqual([
      "main > section.a",
      "main > section.b",
    ]);
  });

  it("links parents from retained candidate ancestry", () => {
    const regions = segmentRegions(
      scan([
        section({ selector: "main", tag: "main", heading: null }),
        section({ selector: "main > div.outer", tag: "div", heading: "Outer", rect: { x: 0, y: 100, width: 1200, height: 900 } }),
        section({ selector: "main > div.outer > div.inner", tag: "div", heading: "Inner", parentKey: "main > div.outer", rect: { x: 0, y: 150, width: 1200, height: 300 } }),
      ]),
    );
    expect(regions.find((region) => region.selector === "main > div.outer > div.inner")?.parentKey).toBe(
      regions.find((region) => region.selector === "main > div.outer")?.key,
    );
  });

  it("keeps parent identity beyond the selector depth bound", () => {
    const regions = segmentRegions(
      scan([
        section({ nodeKey: "main-node", selector: "main", tag: "main", heading: null }),
        section({
          nodeKey: "inner-node",
          selector: "main > div.a > div.b > div.c > div.d > div.e > div.f > div.g > div.h > div.i",
          tag: "div",
          heading: "Inner",
          parentKey: "main-node",
          rect: { x: 0, y: 200, width: 1200, height: 300 },
        }),
      ]),
    );
    expect(regions.find((region) => region.nodeKey === "inner-node")?.parentKey).toBe(
      regions.find((region) => region.nodeKey === "main-node")?.key,
    );
  });

  it("keeps a distinct heading-led child inside a larger parent", () => {
    const regions = segmentRegions(
      scan([
        section({
          nodeKey: "main",
          selector: "main",
          tag: "main",
          heading: "About",
          text: "About The child section Other work",
          rect: { x: 0, y: 0, width: 1200, height: 2000 },
        }),
        section({
          nodeKey: "child",
          selector: "main > section.child",
          tag: "section",
          heading: "About",
          text: "About The child section",
          parentKey: "main",
          rect: { x: 0, y: 100, width: 1200, height: 400 },
        }),
      ]),
    );
    expect(regions.some((region) => region.nodeKey === "child")).toBe(true);
  });

  it("collapses shells before the cap so every section survives", () => {
    const sections = Array.from({ length: 15 }, (_, index) =>
      section({
        nodeKey: `section-${index}`,
        selector: `main > section.s${index}`,
        tag: "section",
        heading: `Section ${index}`,
        text: `Section ${index} Copy`,
        rect: { x: 0, y: index * 100, width: 1200, height: 90 },
      }),
    );
    for (let index = 0; index < 5; index += 1) {
      sections.push(
        section({
          nodeKey: `shell-${index}`,
          selector: `main > section.s${index} > div.shell`,
          tag: "div",
          heading: `Section ${index}`,
          text: `Section ${index} Copy`,
          parentKey: `section-${index}`,
          rect: { x: 0, y: index * 100, width: 1200, height: 90 },
        }),
      );
    }
    const result = segmentRegionsWithStats(scan(sections));
    expect(result.regions).toHaveLength(15);
    expect(result.collapsed).toBe(5);
    expect(result.truncated).toBe(false);
  });

  it("keeps a headed main with unique parent content", () => {
    const regions = segmentRegions(
      scan([
        section({
          nodeKey: "main",
          selector: "main",
          tag: "main",
          heading: "About",
          text: "About Unique parent copy Child copy",
          rect: { x: 0, y: 0, width: 1200, height: 900 },
        }),
        section({
          nodeKey: "child",
          selector: "main > section.about",
          tag: "section",
          heading: "About",
          text: "About Child copy",
          parentKey: "main",
          rect: { x: 0, y: 300, width: 1200, height: 400 },
        }),
      ]),
    );
    expect(regions.some((region) => region.nodeKey === "main")).toBe(true);
  });

  it("keeps an equivalent section inside a main container", () => {
    const regions = segmentRegions(
      scan([
        section({
          nodeKey: "main",
          selector: "main",
          tag: "main",
          landmark: "main",
          heading: "Hero",
          text: "Hero Same copy",
          rect: { x: 0, y: 0, width: 1200, height: 900 },
        }),
        section({
          nodeKey: "hero",
          selector: "main > section.hero",
          tag: "section",
          heading: "Hero",
          text: "Hero Same copy",
          parentKey: "main",
          rect: { x: 0, y: 0, width: 1200, height: 900 },
        }),
      ]),
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]!.tag).toBe("section");
    expect(regions[0]!.selector).toBe("main > section.hero");
  });

  it("keeps a section inside an equivalent div role main wrapper", () => {
    const regions = segmentRegions(
      scan([
        section({
          nodeKey: "main-role",
          selector: "div[role=main]",
          tag: "div",
          landmark: "main",
          heading: "Hero",
          text: "Hero Same copy",
          rect: { x: 0, y: 0, width: 1200, height: 900 },
        }),
        section({
          nodeKey: "hero",
          selector: "div[role=main] > section.hero",
          tag: "section",
          heading: "Hero",
          text: "Hero Same copy",
          parentKey: "main-role",
          rect: { x: 0, y: 0, width: 1200, height: 900 },
        }),
      ]),
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]!.tag).toBe("section");
    expect(regions[0]!.selector).toBe("div[role=main] > section.hero");
  });

  it("keeps equivalent header and nav landmarks with distinct semantics", () => {
    const regions = segmentRegions(
      scan([
        section({
          nodeKey: "header",
          selector: "main > header",
          tag: "header",
          landmark: "banner",
          heading: "Site",
          text: "Site Home",
        }),
        section({
          nodeKey: "nav",
          selector: "main > header > nav",
          tag: "nav",
          landmark: "navigation",
          heading: "Site",
          text: "Site Home",
          parentKey: "header",
        }),
      ]),
    );
    expect(regions.map((region) => region.tag).sort()).toEqual(["header", "nav"]);
  });

  it("retains semantic landmark ancestry when collapsing a shell", () => {
    const regions = segmentRegions(
      scan([
        section({
          nodeKey: "header",
          selector: "main > header",
          tag: "header",
          landmark: "banner",
          heading: "About",
          text: "About Same copy",
        }),
        section({
          nodeKey: "inner",
          selector: "main > header > div",
          tag: "div",
          heading: "About",
          text: "About Same copy",
          parentKey: "header",
        }),
      ]),
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]!.tag).toBe("header");
    expect(regions[0]!.landmark).toBe("banner");
  });

  it("reparents through a filtered intermediate wrapper", () => {
    const regions = segmentRegions(
      scan([
        section({
          nodeKey: "outer",
          selector: "main > section.outer",
          tag: "section",
          heading: "Outer",
          text: "Outer content",
          rect: { x: 0, y: 0, width: 1200, height: 2000 },
        }),
        section({
          nodeKey: "wrapper",
          selector: "main > section.outer > div.wide",
          tag: "div",
          heading: "Outer",
          text: "Outer content",
          parentKey: "outer",
          rect: { x: 0, y: 0, width: 2000, height: 2000 },
        }),
        section({
          nodeKey: "child",
          selector: "main > section.outer > div.wide > section.child",
          tag: "section",
          heading: "Child",
          text: "Child content",
          parentKey: "wrapper",
          rect: { x: 0, y: 200, width: 1000, height: 300 },
        }),
      ]),
    );
    const outer = regions.find((region) => region.nodeKey === "outer");
    const child = regions.find((region) => region.nodeKey === "child");
    expect(regions.some((region) => region.nodeKey === "wrapper")).toBe(false);
    expect(child?.parentKey).toBe(outer?.key);
  });

  it("reparents a child past a collapsed intermediate shell", () => {
    const regions = segmentRegions(
      scan([
        section({
          nodeKey: "outer",
          selector: "main > section.outer",
          tag: "section",
          heading: "Outer",
          text: "Outer About Child copy",
          rect: { x: 0, y: 0, width: 1200, height: 1200 },
        }),
        section({
          nodeKey: "shell",
          selector: "main > section.outer > div.shell",
          tag: "div",
          heading: "About",
          text: "About Child copy",
          parentKey: "outer",
          rect: { x: 0, y: 200, width: 1200, height: 400 },
        }),
        section({
          nodeKey: "child",
          selector: "main > section.outer > div.shell > section.child",
          tag: "section",
          heading: "About",
          text: "About Child copy",
          parentKey: "shell",
          rect: { x: 0, y: 200, width: 1200, height: 400 },
        }),
      ]),
    );
    const outer = regions.find((region) => region.nodeKey === "outer");
    const child = regions.find((region) => region.nodeKey === "child");
    expect(regions.some((region) => region.nodeKey === "shell")).toBe(false);
    expect(child?.parentKey).toBe(outer?.key);
  });

  it("collapses equivalent nested shells before truncation", () => {
    const regions = segmentRegions(
      scan([
        section({ nodeKey: "outer", selector: "main > div.outer", tag: "div", heading: "Same", text: "Same copy" }),
        section({ nodeKey: "inner", selector: "main > div.outer > div.inner", tag: "div", heading: "Same", text: "Same copy", parentKey: "outer" }),
      ]),
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]!.selector).toBe("main > div.outer > div.inner");
  });

  it("keeps sibling sections with equal geometry and copy", () => {
    const regions = segmentRegions(
      scan([
        section({ nodeKey: "node-a", selector: "main > div.a", heading: "Same", rect: { x: 0, y: 100, width: 600, height: 400 } }),
        section({ nodeKey: "node-b", selector: "main > div.b", heading: "Same", rect: { x: 0, y: 100, width: 600, height: 400 } }),
      ]),
    );
    expect(regions).toHaveLength(2);
    expect(new Set(regions.map((region) => region.key)).size).toBe(2);
  });

  it("links parents only when the retained candidate exists", () => {
    const regions = segmentRegions(
      scan([
        section({ selector: "main", tag: "main", heading: null }),
        section({ selector: "main > section.child", parentKey: "main" }),
        section({
          selector: "main > section.orphan",
          parentKey: "missing",
          rect: { x: 0, y: 1200, width: 1200, height: 300 },
        }),
      ]),
    );
    expect(regions.find((region) => region.selector === "main > section.child")?.parentKey).toBe(
      regions[0]!.key,
    );
    expect(regions.find((region) => region.selector === "main > section.orphan")?.parentKey).toBeNull();
  });
});
