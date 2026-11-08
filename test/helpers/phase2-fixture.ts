import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AtlasPageScan, AtlasScanSection } from "../../src/atlas/live-types.js";

interface FixtureSection {
  selector: string;
  tag: string;
  landmark?: string | null;
  role?: string | null;
  heading?: string | null;
  headingLevel?: number | null;
  text?: string;
  paragraphCount?: number;
  linkCount?: number;
  mediaCount?: number;
  repeatedItems?: number;
  orderedItems?: number;
  quoteCount?: number;
  citationCount?: number;
  numericPairs?: number;
  formCount?: number;
  emailInputCount?: number;
  buttonCount?: number;
  buttonLabels?: string[];
  rect: { x: number; y: number; width: number; height: number };
  backgroundColor?: string | null;
  fixed?: boolean;
  depth?: number;
  parentKey?: string | null;
  labels: string[];
}

interface Phase2Fixture {
  schemaVersion: string;
  viewport: { width: number; height: number };
  sections: FixtureSection[];
}

export function loadPhase2Fixture(): { scan: AtlasPageScan; labels: Map<string, string[]> } {
  const fixture = JSON.parse(
    readFileSync(join("test", "fixtures", "atlas", "phase2-sections.json"), "utf8"),
  ) as Phase2Fixture;
  const sections: AtlasScanSection[] = fixture.sections.map((section) => ({
    nodeKey: section.selector,
    selector: section.selector,
    tag: section.tag,
    role: section.role ?? null,
    landmark: section.landmark ?? null,
    heading: section.heading ?? null,
    headingLevel: section.headingLevel ?? null,
    text: section.text ?? "",
    visible: true,
    articleNested: false,
    landmarkNested: false,
    paragraphCount: section.paragraphCount ?? 0,
    linkCount: section.linkCount ?? 0,
    mediaCount: section.mediaCount ?? 0,
    repeatedItems: section.repeatedItems ?? 0,
    orderedItems: section.orderedItems ?? 0,
    quoteCount: section.quoteCount ?? 0,
    citationCount: section.citationCount ?? 0,
    numericPairs: section.numericPairs ?? 0,
    formCount: section.formCount ?? 0,
    emailInputCount: section.emailInputCount ?? 0,
    buttonCount: section.buttonCount ?? 0,
    buttonLabels: section.buttonLabels ?? [],
    rect: section.rect,
    viewport: fixture.viewport,
    backgroundColor: section.backgroundColor ?? "rgb(255, 255, 255)",
    fixed: section.fixed ?? false,
    depth: section.depth ?? 1,
    parentKey: section.parentKey ?? null,
  }));
  return {
    scan: {
      title: "Phase 2 fixture",
      url: "https://fixture.example/",
      totalHeight: 8200,
      scrollRoot: null,
      sections,
      technologies: [],
      canvasCount: 0,
      webglObserved: false,
    },
    labels: new Map(fixture.sections.map((section) => [section.selector, section.labels])),
  };
}
