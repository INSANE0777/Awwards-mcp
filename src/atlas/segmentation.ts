import { stableHash } from "./identity.js";
import type { AtlasPageScan, AtlasScanSection, RegionCandidate } from "./live-types.js";

const MAX_SECTIONS = 24;
const MAX_TEXT = 4_000;

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function signature(section: AtlasScanSection): string {
  return [
    section.tag,
    Math.round(section.rect.x),
    Math.round(section.rect.y),
    Math.round(section.rect.width),
    Math.round(section.rect.height),
    clean(section.text).slice(0, 200),
  ].join("|");
}

/**
 * Deterministic region candidates from DOM/geometry evidence. One scan section
 * is one candidate; fixed overlays and duplicate nested shells are excluded.
 */
export function regionStableKey(
  region: Pick<RegionCandidate, "selector" | "tag" | "heading" | "nodeKey">,
): string {
  return stableHash(
    "region-stable-v1",
    region.nodeKey,
    region.selector,
    region.tag,
    clean(region.heading ?? "").slice(0, 120),
  );
}

export function segmentRegions(scan: AtlasPageScan): RegionCandidate[] {
  return segmentRegionsWithStats(scan).regions;
}

export function segmentRegionsWithStats(scan: AtlasPageScan): {
  regions: RegionCandidate[];
  collapsed: number;
  filtered: number;
  truncated: boolean;
} {
  const usable = scan.sections
    .map((section, scanIndex) => ({ section, scanIndex }))
    .filter(
      ({ section }) =>
        !section.fixed &&
        section.visible !== false &&
        section.rect.width > 0 &&
        section.rect.height > 0 &&
        section.rect.width <= section.viewport.width * 1.2 &&
        section.selector.length > 0,
    )
    .sort(
      (left, right) =>
        left.section.rect.y - right.section.rect.y ||
        left.section.rect.x - right.section.rect.x ||
        left.section.selector.localeCompare(right.section.selector),
    );

  const sectionsByNode = new Map(
    scan.sections.map((section) => [section.nodeKey, section]),
  );
  const isAncestor = (ancestor: AtlasScanSection, descendant: AtlasScanSection): boolean => {
    let key = descendant.parentKey;
    const seenKeys = new Set<string>();
    while (key && !seenKeys.has(key)) {
      if (key === ancestor.nodeKey) return true;
      seenKeys.add(key);
      key = sectionsByNode.get(key)?.parentKey ?? null;
    }
    return false;
  };
  const contains = (ancestor: AtlasScanSection, descendant: AtlasScanSection): boolean =>
    ancestor.rect.x <= descendant.rect.x + 1 &&
    ancestor.rect.y <= descendant.rect.y + 1 &&
    ancestor.rect.x + ancestor.rect.width >= descendant.rect.x + descendant.rect.width - 1 &&
    ancestor.rect.y + ancestor.rect.height >= descendant.rect.y + descendant.rect.height - 1;
  const equivalent = (ancestor: AtlasScanSection, descendant: AtlasScanSection): boolean => {
    if (descendant === ancestor || !isAncestor(ancestor, descendant)) return false;
    if (clean(ancestor.heading ?? "") !== clean(descendant.heading ?? "")) return false;
    if (!contains(ancestor, descendant)) return false;
    const text = clean(descendant.text);
    if (!text) return false;
    const remainder = clean(ancestor.text).split(text).join("").trim();
    const extra = remainder.split(clean(ancestor.heading ?? "")).join("").trim();
    return (
      extra.length === 0 ||
      (ancestor.paragraphCount > 0 &&
        ancestor.text.length <= descendant.text.length * 1.8 &&
        ancestor.paragraphCount === descendant.paragraphCount &&
        ancestor.mediaCount === descendant.mediaCount &&
        ancestor.linkCount === descendant.linkCount)
    );
  };
  const semanticKey = (section: AtlasScanSection): string | null => {
    const tag = section.tag.toLowerCase();
    if (tag === "main" || section.landmark === "main") return null;
    if (section.landmark) return section.landmark;
    if (tag === "header") return "banner";
    if (tag === "nav") return "navigation";
    if (tag === "footer") return "contentinfo";
    if (tag === "aside") return "complementary";
    return null;
  };
  const semantic = (section: AtlasScanSection): boolean => semanticKey(section) !== null;
  const distinctSemantics = (ancestor: AtlasScanSection, descendant: AtlasScanSection): boolean => {
    const left = semanticKey(ancestor);
    const right = semanticKey(descendant);
    return left !== null && right !== null && left !== right;
  };
  const collapsed = usable.filter(({ section }) => {
    const semanticAncestors = usable.filter(
      ({ section: ancestor }) =>
        ancestor !== section && isAncestor(ancestor, section) &&
        semantic(ancestor) && equivalent(ancestor, section),
    );
    if (
      semanticAncestors.length > 0 &&
      !semanticAncestors.some(({ section: ancestor }) => distinctSemantics(ancestor, section))
    ) {
      return false;
    }
    if (
      semantic(section) &&
      usable.some(({ section: descendant }) =>
        equivalent(section, descendant) &&
        (distinctSemantics(section, descendant) || !semantic(descendant)),
      )
    ) {
      return true;
    }
    return !usable.some(({ section: descendant }) => equivalent(section, descendant));
  });

  const seen = new Set<string>();
  const retained: Array<{ section: AtlasScanSection; key: string; depth: number; scanIndex: number }> = [];
  for (const { section, scanIndex } of collapsed) {
    const dedupe = `${signature(section)}|${section.nodeKey}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const key = stableHash(
      "region-scan-v1",
      section.nodeKey,
      section.selector,
      String(Math.round(section.rect.y)),
      String(Math.round(section.rect.height)),
      clean(section.heading ?? "").slice(0, 120),
    );
    retained.push({ section, key, depth: section.depth, scanIndex });
  }

  const bySelector = new Map<string, string>();
  const byNodeKey = new Map<string, string>();
  for (const entry of retained) {
    bySelector.set(entry.section.selector, entry.key);
    byNodeKey.set(entry.section.nodeKey, entry.key);
  }

  const regions = retained.slice(0, MAX_SECTIONS).map((entry, ordinal) => {
    const section = entry.section;
    const ancestor = retained
      .filter(
        (candidate) =>
          candidate !== entry &&
          section.selector.startsWith(`${candidate.section.selector} > `),
      )
      .sort((left, right) => right.section.selector.length - left.section.selector.length)[0];
    const parent = (() => {
      let parentKey = section.parentKey;
      const seenKeys = new Set<string>();
      while (parentKey && !seenKeys.has(parentKey)) {
        seenKeys.add(parentKey);
        const retainedParent = byNodeKey.get(parentKey) ?? bySelector.get(parentKey);
        if (retainedParent) return retainedParent;
        parentKey = sectionsByNode.get(parentKey)?.parentKey ?? null;
      }
      return section.parentKey ? null : ancestor?.key ?? null;
    })();
    return {
      key: entry.key,
      ordinal,
      scanIndex: entry.scanIndex,
      nodeKey: section.nodeKey,
      selector: section.selector,
      parentKey: parent,
      tag: section.tag.toLowerCase(),
      role: section.role ? section.role.toLowerCase() : null,
      landmark: section.landmark ? section.landmark.toLowerCase() : null,
      heading: section.heading ? clean(section.heading).slice(0, 300) : null,
      headingLevel: section.headingLevel,
      text: clean(section.text).slice(0, MAX_TEXT),
      visible: section.visible !== false,
      articleNested: section.articleNested === true,
      landmarkNested: section.landmarkNested === true,
      paragraphCount: Math.max(0, Math.trunc(section.paragraphCount)),
      linkCount: Math.max(0, Math.trunc(section.linkCount)),
      mediaCount: Math.max(0, Math.trunc(section.mediaCount)),
      repeatedItems: Math.max(0, Math.trunc(section.repeatedItems)),
      orderedItems: Math.max(0, Math.trunc(section.orderedItems)),
      quoteCount: Math.max(0, Math.trunc(section.quoteCount)),
      citationCount: Math.max(0, Math.trunc(section.citationCount)),
      numericPairs: Math.max(0, Math.trunc(section.numericPairs)),
      formCount: Math.max(0, Math.trunc(section.formCount)),
      emailInputCount: Math.max(0, Math.trunc(section.emailInputCount)),
      buttonCount: Math.max(0, Math.trunc(section.buttonCount)),
      buttonLabels: section.buttonLabels.slice(0, 12),
      rect: section.rect,
      viewport: section.viewport,
      backgroundColor: section.backgroundColor,
      depth: section.depth,
      inScrollRoot: section.inScrollRoot === true,
    };
  });
  return {
    regions,
    collapsed: usable.length - collapsed.length,
    filtered: (scan.rawSectionCount ?? scan.sections.length) - usable.length,
    truncated: retained.length > MAX_SECTIONS,
  };
}
