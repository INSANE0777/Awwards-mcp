import { extname } from "node:path";
import { stableHash, sha256Text } from "./identity.js";
import {
  EVIDENCE_DESIGN_SCHEMA_VERSION,
  EVIDENCE_PACK_EXPORTER_VERSION,
  EVIDENCE_SELECTION_SCHEMA_VERSION,
  STYLE_FIELDS,
  packExporterIncludesMotion,
  type EvidenceSelection,
  type PackCapture,
  type PackClaim,
  type PackComponentSummary,
  type PackExporterVersion,
  type PackOmission,
  type PackRegion,
  type PackSectionSummary,
  type RenderedDocument,
  type TokenEntry,
} from "./evidence-pack-types.js";
import type { EvidenceCoverage } from "./types.js";

const TEXT_ENCODER = new TextEncoder();

export function rendered(path: string, content: string): RenderedDocument {
  return { path, content, bytes: TEXT_ENCODER.encode(content).length };
}

/** Copied artifact name; artifact ids are capture-scoped, so equal bytes never collide. */
export function copiedArtifactPath(
  artifactId: string,
  sha256: string,
  storagePath: string,
): string {
  const extension = extname(storagePath).toLowerCase();
  return `artifacts/${artifactId}-${sha256}${/^\.[a-z0-9]+$/.test(extension) ? extension : ".bin"}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

const CONTROL = /[\u0000-\u001f\u007f]/g;
const MARKDOWN_ESCAPE = /[!-/:-@[-`{-~]/g;
const DISPLAY_ESCAPE = /[\\`*_[\]()<>!|~#]/g;

/** Single-line code-span content; backticks cannot terminate the span. */
export function codeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .replace(/`/g, "'")
    .trim();
}

/** Value as written inside tokens.css; shared with the validator. */
export function tokenCssValue(value: string): string {
  return value.replace(/[\r\n;{}]/g, " ");
}

/** Page-derived prose: neutralizes CommonMark links, images, HTML and structure. */
export function markdownText(value: string): string {
  return codeText(value).replace(MARKDOWN_ESCAPE, (character) => `\\${character}`);
}

/** Page-derived display text in JSON documents; keeps one line and neutralizes Markdown. */
export function displayText(value: string): string {
  return codeText(value).replace(DISPLAY_ESCAPE, (character) => `\\${character}`);
}

function code(value: string): string {
  return `\`${codeText(value)}\``;
}

function vettedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function claimList(claims: PackClaim[]): string {
  return claims.length
    ? claims.map((claim) => `\`${claim.id}\``).join(", ")
    : "no claim";
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    const list = groups.get(groupKey) ?? [];
    list.push(value);
    groups.set(groupKey, list);
  }
  return groups;
}

function orderedSections(selection: EvidenceSelection): PackSectionSummary[] {
  const regions = new Map(selection.regions.map((region) => [region.regionId, region]));
  const captures = new Map(selection.captures.map((capture, index) => [capture.id, index]));
  return [...selection.sections].sort((left, right) => {
    const leftRegion = regions.get(left.regionId);
    const rightRegion = regions.get(right.regionId);
    return (
      (captures.get(left.captureId) ?? 0) - (captures.get(right.captureId) ?? 0) ||
      left.ordinal - right.ordinal ||
      (leftRegion?.viewport ?? "").localeCompare(rightRegion?.viewport ?? "") ||
      compareText(left.regionId, right.regionId)
    );
  });
}

function orderedComponents(selection: EvidenceSelection): PackComponentSummary[] {
  const captures = new Map(selection.captures.map((capture, index) => [capture.id, index]));
  return [...selection.components].sort(
    (left, right) =>
      (captures.get(left.captureId) ?? 0) - (captures.get(right.captureId) ?? 0) ||
      left.ordinal - right.ordinal ||
      compareText(left.regionId, right.regionId),
  );
}

function claimsFor(
  selection: EvidenceSelection,
  predicate: (claim: PackClaim) => boolean,
): PackClaim[] {
  return selection.claims.filter(predicate);
}

function claimsForRegion(selection: EvidenceSelection, regionId: string): PackClaim[] {
  return claimsFor(selection, (claim) => claim.regionId === regionId);
}

/**
 * Section and component summaries are derived decisions. Building a pack and
 * validating one derive them with this same function so a summary cannot
 * disagree with the selected regions and claims it summarizes.
 */
export function deriveSectionSummaries(
  regions: PackRegion[],
  claims: PackClaim[],
): PackSectionSummary[] {
  return regions
    .filter((region) => region.kind === "section")
    .map((region) => ({
      regionId: region.regionId,
      captureId: region.captureId,
      ordinal: region.ordinal,
      viewport: region.viewport,
      geometry: region.geometry,
      backgroundColor: region.backgroundColor,
      claimIds: claims.filter((claim) => claim.regionId === region.regionId).map((claim) => claim.id),
    }));
}

export function deriveComponentSummaries(
  regions: PackRegion[],
  claims: PackClaim[],
): PackComponentSummary[] {
  const acceptedTypeRegions = new Set(
    claims
      .filter((claim) => claim.property === "component.type" && claim.classification !== "proposed")
      .map((claim) => claim.regionId),
  );
  return regions
    .filter((region) => region.kind === "component")
    .map((region) => {
      const regionClaims = claims.filter((claim) => claim.regionId === region.regionId);
      const stateNames = uniqueSorted(
        regionClaims.filter((claim) => claim.state !== "default").map((claim) => claim.state),
      );
      return {
        regionId: region.regionId,
        captureId: region.captureId,
        ordinal: region.ordinal,
        viewport: region.viewport,
        type: region.type,
        typeClassification: region.typeClassification,
        candidateOnly: !acceptedTypeRegions.has(region.regionId),
        patternKey: region.patternKey,
        geometry: region.geometry,
        styles: region.styles,
        sectionRegionId: region.sectionRegionId,
        claimIds: regionClaims.map((claim) => claim.id),
        states: stateNames.map((state) => ({
          state,
          claimIds: regionClaims.filter((claim) => claim.state === state).map((claim) => claim.id),
        })),
      };
    });
}

function claimsForValue(
  selection: EvidenceSelection,
  property: string,
  value: string,
): PackClaim[] {
  return claimsFor(
    selection,
    (claim) => claim.property === property && claim.value === value,
  );
}

function tokenEntry(
  selection: EvidenceSelection,
  property: string,
  value: string,
  name: string,
): TokenEntry {
  const claims = claimsForValue(selection, property, value);
  return {
    name,
    value,
    property,
    claimIds: uniqueSorted(claims.map((claim) => claim.id)),
    evidence: claims.map((claim) => ({ artifactId: "selection", path: claim.path })),
  };
}

function categoryEntries(
  selection: EvidenceSelection,
  property: string,
  namePrefix: string,
): TokenEntry[] {
  const values = uniqueSorted(
    claimsFor(selection, (claim) => claim.property === property).map((claim) => claim.value),
  );
  return values.map((value, index) => tokenEntry(selection, property, value, `${namePrefix}-${index + 1}`));
}

export function buildTokens(selection: EvidenceSelection): EvidenceSelection["tokens"] {
  return {
    generated: true,
    colors: categoryEntries(selection, "background-color", "--atlas-color"),
    typography: {
      fontFamily: categoryEntries(selection, "font-family", "--atlas-font-family"),
      fontSize: categoryEntries(selection, "font-size", "--atlas-font-size"),
      fontWeight: categoryEntries(selection, "font-weight", "--atlas-font-weight"),
      lineHeight: categoryEntries(selection, "line-height", "--atlas-line-height"),
    },
    spacing: {
      gap: categoryEntries(selection, "gap", "--atlas-gap"),
      padding: categoryEntries(selection, "padding", "--atlas-padding"),
    },
    radii: categoryEntries(selection, "border-radius", "--atlas-radius"),
    display: categoryEntries(selection, "display", "--atlas-display"),
  };
}

/** Coverage is a derived decision: recompute it from the selected captures and regions. */
export function packCoverage(captures: PackCapture[], regions: PackRegion[]): EvidenceCoverage {
  const galleryLimited = captures.some((capture) => capture.sourceKind === "legacy_gallery");
  return {
    status: captures.every((capture) => capture.coverage.status === "complete")
      ? "complete"
      : captures.some((capture) => capture.coverage.status === "partial")
        ? "partial"
        : "unknown",
    collected: regions.length,
    excluded: 0,
    limitations: uniqueSorted([
      ...captures.flatMap((capture) => capture.coverage.limitations),
      ...(galleryLimited ? ["LEGACY_GALLERY_NO_SOURCE_ARTIFACT"] : []),
    ]),
  };
}

/** Omitted families are a derived decision: recompute them from the final claim set. */
export function omittedValues(
  selection: Pick<EvidenceSelection, "regions" | "tokens" | "captures" | "claims">,
  exporterVersion: PackExporterVersion = EVIDENCE_PACK_EXPORTER_VERSION,
): PackOmission[] {
  const omitted: PackOmission[] = [];
  const add = (family: string, reason: string): void => {
    if (!omitted.some((entry) => entry.family === family)) omitted.push({ family, reason });
  };
  const tokens = selection.tokens;
  if (!tokens.colors.length) add("background-color", "NO_OBSERVED_VALUES");
  for (const [family, entries] of [
    ["font-family", tokens.typography.fontFamily],
    ["font-size", tokens.typography.fontSize],
    ["font-weight", tokens.typography.fontWeight],
    ["line-height", tokens.typography.lineHeight],
    ["gap", tokens.spacing.gap],
    ["padding", tokens.spacing.padding],
    ["border-radius", tokens.radii],
    ["display", tokens.display],
  ] as Array<[string, unknown[]]>) {
    if (!entries.length) add(family, "NO_OBSERVED_VALUES");
  }
  const viewports = new Set(selection.captures.map((capture) => capture.viewport));
  if (!viewports.has("desktop")) add("desktop viewport", "NOT_CAPTURED");
  if (!viewports.has("mobile")) add("mobile viewport", "NOT_CAPTURED");
  const states = new Set(selection.claims.map((claim) => claim.state));
  if (!states.has("hover")) add("hover state", "NOT_CAPTURED");
  if (!states.has("focus")) add("focus state", "NOT_CAPTURED");
  // Exporters have never observed motion; v1 packs predate this disclosure, so
  // version 1 must keep rendering exactly what it shipped.
  if (packExporterIncludesMotion(exporterVersion)) add("motion", "NOT_CAPTURED");
  add("elevation", "NO_DEFAULT_STATE_EVIDENCE");
  add("border", "NO_DEFAULT_STATE_EVIDENCE");
  for (const region of selection.regions) {
    if (region.kind === "section" && !region.backgroundColor) {
      add(`section:${region.regionId}:background-color`, "NO_OBSERVED_VALUE");
    }
    if (region.kind === "component" && Object.keys(region.styles).length === 0) {
      add(`component:${region.regionId}:computed-styles`, "STYLE_SOURCE_UNAVAILABLE");
    }
  }
  return omitted;
}

function tokenFamilies(tokens: EvidenceSelection["tokens"]): TokenEntry[][] {
  return [
    tokens.colors,
    tokens.typography.fontFamily,
    tokens.typography.fontSize,
    tokens.typography.fontWeight,
    tokens.typography.lineHeight,
    tokens.spacing.gap,
    tokens.spacing.padding,
    tokens.radii,
    tokens.display,
  ];
}

export function renderTokensJson(selection: EvidenceSelection): RenderedDocument {
  const tokens = selection.tokens;
  const payload: Record<string, unknown> = {
    schemaVersion: "awwwards-atlas-tokens-v1",
    packId: selection.packId,
    generated: true,
    note: "Generated names for observed values; these are not the source site's token names.",
  };
  if (tokens.colors.length) payload.colors = tokens.colors;
  const typography = Object.fromEntries(
    Object.entries(tokens.typography).filter(([, entries]) => entries.length > 0),
  );
  if (Object.keys(typography).length) payload.typography = typography;
  const spacing = Object.fromEntries(
    Object.entries(tokens.spacing).filter(([, entries]) => entries.length > 0),
  );
  if (Object.keys(spacing).length) payload.spacing = spacing;
  if (tokens.radii.length) payload.radii = tokens.radii;
  if (tokens.display.length) payload.display = tokens.display;
  return rendered("tokens.json", `${JSON.stringify(payload, null, 2)}\n`);
}

export function renderTokensCss(selection: EvidenceSelection): RenderedDocument {
  const lines: string[] = [
    "/* Generated from observed Atlas evidence. Names are generated, not source tokens. */",
    ":root {",
  ];
  for (const family of tokenFamilies(selection.tokens)) {
    for (const entry of family) {
      lines.push(`  ${entry.name}: ${tokenCssValue(entry.value)};`);
    }
  }
  lines.push("}", "");
  return rendered("tokens.css", lines.join("\n"));
}

export function renderComponentsJson(selection: EvidenceSelection): RenderedDocument {
  const mediaByRegion = new Map<string, EvidenceSelection["media"]>();
  for (const decision of selection.media) {
    if (!decision.regionId) continue;
    const list = mediaByRegion.get(decision.regionId) ?? [];
    list.push(decision);
    mediaByRegion.set(decision.regionId, list);
  }
  const components = orderedComponents(selection).map((component) => {
    const packs = (mediaByRegion.get(component.regionId) ?? []).filter(
      (decision) => decision.kind === "component_pack",
    );
    return {
      regionId: component.regionId,
      captureId: component.captureId,
      ordinal: component.ordinal,
      viewport: component.viewport,
      type: component.type === null ? null : displayText(component.type),
      typeClassification: component.typeClassification,
      candidateOnly: component.candidateOnly,
      patternKey: component.patternKey === null ? null : displayText(component.patternKey),
      geometry: component.geometry,
      styles: component.styles,
      sectionRegionId: component.sectionRegionId,
      claimIds: component.claimIds,
      states: component.states,
      pack: packs.length
        ? packs.map((decision) => ({
            artifactId: decision.artifactId,
            sha256: decision.sha256,
            bytes: decision.bytes,
            storagePath: decision.storagePath,
            included: decision.included,
            copiedPath: decision.copiedPath,
            reason: decision.reason,
          }))
        : null,
    };
  });
  const payload = {
    schemaVersion: "awwwards-atlas-components-v1",
    packId: selection.packId,
    inclusionMode: selection.inclusionMode,
    generated: true,
    assets: selection.media.map((decision) => ({
      artifactId: decision.artifactId,
      kind: decision.kind,
      regionId: decision.regionId,
      sha256: decision.sha256,
      bytes: decision.bytes,
      storagePath: decision.storagePath,
      included: decision.included,
      copiedPath: decision.copiedPath,
      reason: decision.reason,
    })),
    sections: orderedSections(selection),
    components,
  };
  return rendered("components.json", `${JSON.stringify(payload, null, 2)}\n`);
}

export function renderDesignMd(selection: EvidenceSelection): RenderedDocument {
  const sections = orderedSections(selection);
  const components = orderedComponents(selection);
  const tokens = selection.tokens;
  const viewports = uniqueSorted(selection.captures.map((capture) => capture.viewport));
  const observedStates = uniqueSorted(
    selection.claims
      .map((claim) => claim.state)
      .filter((state) => state !== "default"),
  );
  const lines: string[] = [
    "---",
    "version: alpha",
    `name: "${codeText(selection.siteSlug)}"`,
    `description: "Observed design evidence for ${codeText(selection.siteSlug)} from selected Atlas regions."`,
    "colors: {}",
    "typography: {}",
    "rounded: {}",
    "spacing: {}",
    "components: {}",
    "---",
    "",
    "## Overview",
    "",
    `This document describes an observed subset of ${code(selection.siteSlug)}: ${sections.length} selected section(s) and ${components.length} selected component(s) across ${selection.captures.length} active head capture(s). It is not the site's official brand system, and generated token names are not the source site's token names. Sources: [S1].`,
    "",
    "## Colors",
    "",
  ];
  if (tokens.colors.length) {
    for (const entry of tokens.colors) {
      const regionClaims = claimsForValue(selection, "background-color", entry.value);
      const regionIds = uniqueSorted(regionClaims.map((claim) => claim.regionId));
      lines.push(
        `- ${code(entry.value)} — observed section background on ${regionIds.length} selected region(s); generated token ${code(entry.name)}; claims ${claimList(regionClaims)}.`,
      );
    }
  } else {
    lines.push("No section background color was observed in the selected evidence.");
  }

  lines.push("", "## Typography", "");
  const typographyGroups: Array<[string, TokenEntry[]]> = [
    ["Font family", tokens.typography.fontFamily],
    ["Font size", tokens.typography.fontSize],
    ["Font weight", tokens.typography.fontWeight],
    ["Line height", tokens.typography.lineHeight],
  ];
  let typographyFound = false;
  for (const [label, entries] of typographyGroups) {
    if (!entries.length) continue;
    typographyFound = true;
    for (const entry of entries) {
      const claims = claimsForValue(selection, entry.property, entry.value);
      lines.push(
        `- ${label}: ${code(entry.value)} — generated token ${code(entry.name)}; claims ${claimList(claims)}.`,
      );
    }
  }
  if (!typographyFound) {
    lines.push("No component font family, size, weight or line height was observed in the selected evidence.");
  }

  lines.push("", "## Layout", "");
  if (sections.length) {
    for (const section of sections) {
      const region = selection.regions.find((entry) => entry.regionId === section.regionId);
      const geometry = section.geometry
        ? `${section.geometry.width}x${section.geometry.height} at (${section.geometry.x}, ${section.geometry.y})`
        : "geometry unavailable";
      const background = section.backgroundColor
        ? `background ${code(section.backgroundColor)}`
        : "background unavailable";
      lines.push(
        `- Section ${code(section.regionId)} (ordinal ${section.ordinal}, ${markdownText(region?.viewport ?? "unknown")} viewport): ${geometry}; ${background}; claims ${claimList(claimsForRegion(selection, section.regionId))}.`,
      );
    }
  } else {
    lines.push("No section region was selected, so page band order is unavailable.");
  }
  for (const component of components) {
    const layout = ["display", "gap", "padding", "fontFamily", "fontSize", "fontWeight", "lineHeight"]
      .filter((field) => component.styles[field])
      .map((field) => `${field} ${code(component.styles[field]!)}`);
    if (layout.length) {
      lines.push(
        `- Component ${code(component.regionId)}: ${layout.join("; ")}; claims ${claimList(claimsForRegion(selection, component.regionId))}.`,
      );
    }
  }
  lines.push(
    "Layout evidence is limited to selected region geometry and observed component computed styles. No max-width, grid template or breakpoint system is inferred.",
  );

  lines.push("", "## Elevation & Depth", "");
  lines.push(
    "Unavailable: the selected default-state evidence contains no shadow, border, overlay, z-index or depth observation. No elevation value is inferred.",
  );

  lines.push("", "## Shapes", "");
  if (tokens.radii.length) {
    for (const entry of tokens.radii) {
      lines.push(
        `- Border radius ${code(entry.value)} — generated token ${code(entry.name)}; claims ${claimList(claimsForValue(selection, entry.property, entry.value))}.`,
      );
    }
  } else {
    lines.push("Unavailable: no border-radius was observed on the selected components.");
  }

  lines.push("", "## Components", "");
  if (components.length) {
    for (const component of components) {
      const styles = STYLE_FIELDS.filter(([field]) => component.styles[field])
        .map(([field]) => `${field} ${code(component.styles[field]!)}`)
        .join(", ");
      lines.push(
        `- ${code(component.regionId)} — type ${code(component.type ?? "unknown")} (${markdownText(component.typeClassification ?? "unclassified")}${component.candidateOnly ? ", candidate-only" : ""}); pattern ${code(component.patternKey ?? "none")}; viewport ${markdownText(component.viewport)}; ${styles || "no computed styles observed"}; claims ${claimList(claimsForRegion(selection, component.regionId))}.`,
      );
      if (component.states.length) {
        for (const state of component.states) {
          lines.push(
            `  - Observed ${markdownText(state.state)} state; claims ${claimList(claimsForRegion(selection, component.regionId).filter((claim) => claim.state === state.state))}.`,
          );
        }
      } else {
        lines.push("  - No hover or focus state was observed for this component.");
      }
    }
  } else {
    lines.push("No component region was selected.");
  }

  lines.push("", "## Do's and Don'ts", "");
  lines.push(
    "- Do ground implementation choices in the cited claims and the selection artifact [S1].",
    "- Do treat token names as generated labels; do not present them as the source site's token names.",
    "- Do capture missing viewports and interaction states before claiming responsive or state behavior.",
    "- Don't reuse reference-only assets; only permitted copies listed in the manifest may be copied.",
    "- Don't infer brand intent, font substitutes, spacing systems, motion rules or elevation that the evidence does not contain.",
  );

  lines.push("", "## Sources", "");
  lines.push(
    `- [S1] Atlas evidence pack selection — ${code("artifacts/selection.json")} — pack ${code(selection.packId)} — claims ${selection.claims.length}.`,
  );
  for (const url of selection.sourceUrls) {
    const safe = vettedUrl(url);
    lines.push(
      safe
        ? `- Source page: ${code(safe)}`
        : "- Source page: an unrenderable source URL was omitted.",
    );
  }
  if (!selection.sourceUrls.length) lines.push("- Source page: not recorded in the selected captures.");

  lines.push("", "## Coverage and limitations", "");
  lines.push(
    `- Coverage: ${markdownText(selection.coverage.status)}; observed viewports: ${viewports.map(markdownText).join(", ") || "none"}; observed interaction states: ${observedStates.map(markdownText).join(", ") || "none"}.`,
  );
  lines.push(`- Inclusion mode: ${markdownText(selection.inclusionMode)}.`);
  for (const limitation of selection.limitations) {
    lines.push(`- Limitation: ${markdownText(limitation)}.`);
  }
  if (!selection.limitations.length) lines.push("- No capture-level limitation was recorded.");

  lines.push("", "## Unresolved details", "");
  for (const omission of selection.omitted) {
    lines.push(`- ${markdownText(omission.family)}: ${markdownText(omission.reason)}.`);
  }
  lines.push(
    "- Font substitution is not proposed.",
    "- Brand intent and original token names are not established.",
    "- Application logic, data and unobserved interactions are outside this evidence.",
    "",
  );

  return rendered("DESIGN.md", lines.join("\n"));
}

function commonalityLines(selection: EvidenceSelection): {
  shared: string[];
  different: string[];
} {
  const shared: string[] = [];
  const different: string[] = [];
  const totalRegions = selection.regions.length;
  const families: Array<[string, string[]]> = [
    ["background color", selection.tokens.colors.map((entry) => entry.value)],
    ["font family", selection.tokens.typography.fontFamily.map((entry) => entry.value)],
    ["font size", selection.tokens.typography.fontSize.map((entry) => entry.value)],
    ["font weight", selection.tokens.typography.fontWeight.map((entry) => entry.value)],
    ["line height", selection.tokens.typography.lineHeight.map((entry) => entry.value)],
    ["gap", selection.tokens.spacing.gap.map((entry) => entry.value)],
    ["padding", selection.tokens.spacing.padding.map((entry) => entry.value)],
    ["border radius", selection.tokens.radii.map((entry) => entry.value)],
    ["display", selection.tokens.display.map((entry) => entry.value)],
  ];
  for (const [label, values] of families) {
    for (const value of values) {
      const claims = claimsForValue(
        selection,
        {
          "background color": "background-color",
          "font family": "font-family",
          "font size": "font-size",
          "font weight": "font-weight",
          "line height": "line-height",
          gap: "gap",
          padding: "padding",
          "border radius": "border-radius",
          display: "display",
        }[label]!,
        value,
      );
      const regions = uniqueSorted(claims.map((claim) => claim.regionId));
      const line = `${label} ${code(value)} observed on ${regions.length}/${totalRegions} selected region(s); claims ${claimList(claims)}.`;
      if (regions.length >= 2) shared.push(line);
      else if (totalRegions >= 2) different.push(line);
    }
  }
  const types = groupBy(
    selection.components.filter((component) => component.type),
    (component) => component.type!,
  );
  for (const [type, members] of [...types.entries()].sort(([left], [right]) => compareText(left, right))) {
    if (members.length >= 2) {
      const typeClaims = selection.claims.filter(
        (claim) =>
          claim.property === "component.type" &&
          members.some((member) => member.regionId === claim.regionId),
      );
      shared.push(
        `component type ${code(type)} observed ${members.length} time(s): ${members.map((member) => code(member.regionId)).join(", ")}; claims ${claimList(typeClaims)}.`,
      );
    }
  }
  return { shared: shared.sort(compareText), different: different.sort(compareText) };
}

export function renderBrief(selection: EvidenceSelection): RenderedDocument {
  // createDesignBrief expects Awwwards SiteDetails/MotionDna and its live refresh
  // inputs; an Atlas selection has no compatible source shape, so this brief is
  // rendered from stored selection evidence only.
  const sections = orderedSections(selection);
  const components = orderedComponents(selection);
  const common = commonalityLines(selection);
  const lines: string[] = [
    "# Evidence brief",
    "",
    "## Goal",
    "",
    markdownText(selection.goal),
    "",
    "## Selected evidence",
    "",
  ];
  for (const section of sections) {
    const region = selection.regions.find((entry) => entry.regionId === section.regionId);
    lines.push(
      `- Section ${code(section.regionId)} (ordinal ${section.ordinal}, ${markdownText(region?.viewport ?? "unknown")} viewport, capture ${code(section.captureId)}).`,
    );
  }
  for (const component of components) {
    lines.push(
      `- Component ${code(component.regionId)} (${code(component.type ?? "unknown type")}, ${markdownText(component.viewport)} viewport, capture ${code(component.captureId)}).`,
    );
  }
  if (!sections.length && !components.length) lines.push("- No region was selected.");

  lines.push("", "## Supported commonalities", "");
  lines.push(...(common.shared.length ? common.shared.map((line) => `- ${line}`) : ["- No value was observed on more than one selected region."]));

  lines.push("", "## Differences", "");
  lines.push(...(common.different.length ? common.different.map((line) => `- ${line}`) : ["- No single-region outlier was observed across the selected evidence."]));

  lines.push("", "## Missing evidence", "");
  if (selection.omitted.length) {
    for (const omission of selection.omitted) {
      lines.push(`- ${markdownText(omission.family)}: ${markdownText(omission.reason)}.`);
    }
  } else {
    lines.push("- No evidence family was recorded as omitted.");
  }

  lines.push("", "## Proposed adaptations", "");
  lines.push("The following are proposals, not observations:");
  lines.push(
    "- Preserve the selected section order and component placement before introducing new structure.",
    "- Start from the observed background colors and component typography; do not rename them as source tokens.",
    "- Capture the missing viewports and interaction states before implementing responsive or hover/focus variants.",
    "- Use the observed component patterns for repeated structures, and verify computed values after implementation.",
    "",
  );
  return rendered("brief.md", lines.join("\n"));
}

export function renderRebuildHandoff(
  selection: EvidenceSelection,
  goal: string,
): RenderedDocument {
  const sections = orderedSections(selection);
  const components = orderedComponents(selection);
  const included = selection.media.filter((decision) => decision.included);
  const references = selection.media.filter((decision) => !decision.included);
  const lines: string[] = [
    "# Rebuild handoff",
    "",
    "## Goal",
    "",
    markdownText(goal),
    "",
    "## Selected sections and components in order",
    "",
  ];
  let index = 1;
  for (const section of sections) {
    lines.push(
      `${index}. Section ${code(section.regionId)} — ordinal ${section.ordinal}, ${markdownText(selection.regions.find((region) => region.regionId === section.regionId)?.viewport ?? "unknown")} viewport, capture ${code(section.captureId)}.`,
    );
    index += 1;
  }
  for (const component of components) {
    lines.push(
      `${index}. Component ${code(component.regionId)} — ordinal ${component.ordinal}, ${markdownText(component.viewport)} viewport, type ${code(component.type ?? "unknown")}, capture ${code(component.captureId)}.`,
    );
    index += 1;
  }
  if (!sections.length && !components.length) lines.push("No region was selected.");

  lines.push("", "## Observed design constraints", "");
  for (const entry of selection.tokens.colors) {
    lines.push(`- Background ${code(entry.value)}; generated token ${code(entry.name)}; claims ${claimList(claimsForValue(selection, "background-color", entry.value))}.`);
  }
  for (const [label, entries] of [
    ["font family", selection.tokens.typography.fontFamily],
    ["font size", selection.tokens.typography.fontSize],
    ["font weight", selection.tokens.typography.fontWeight],
    ["line height", selection.tokens.typography.lineHeight],
    ["gap", selection.tokens.spacing.gap],
    ["padding", selection.tokens.spacing.padding],
    ["border radius", selection.tokens.radii],
    ["display", selection.tokens.display],
  ] as Array<[string, TokenEntry[]]>) {
    for (const entry of entries) {
      lines.push(
        `- ${label} ${code(entry.value)}; generated token ${code(entry.name)}; claims ${claimList(claimsForValue(selection, entry.property, entry.value))}.`,
      );
    }
  }
  for (const component of components) {
    const styles = STYLE_FIELDS.filter(([field]) => component.styles[field])
      .map(([field]) => `${field}=${code(component.styles[field]!)}`)
      .join(", ");
    lines.push(
      `- Component ${code(component.regionId)} (${markdownText(component.viewport)}): ${styles || "no computed styles observed"}; claims ${claimList(claimsForRegion(selection, component.regionId))}.`,
    );
  }
  if (!selection.tokens.colors.length && !components.length) {
    lines.push("- No observed design constraint was available.");
  }

  lines.push("", "## Assets", "");
  if (included.length) {
    lines.push("Permitted copies:");
    for (const decision of included) {
      lines.push(
        `- ${code(decision.artifactId)} (${markdownText(decision.kind)}) — copied to ${code(decision.copiedPath ?? "")}; sha256 ${code(decision.sha256)}; ${bytesLabel(decision.bytes)}.`,
      );
    }
  } else {
    lines.push("Permitted copies: none.");
  }
  if (references.length) {
    lines.push("Reference only (not copied):");
    for (const decision of references) {
      lines.push(
        `- ${code(decision.artifactId)} (${markdownText(decision.kind)}) — ${code(decision.storagePath ?? "unavailable")}; sha256 ${code(decision.sha256)}; ${bytesLabel(decision.bytes)}; reason ${markdownText(decision.reason)}.`,
      );
    }
  } else {
    lines.push("Reference only: none.");
  }

  lines.push("", "## Suggested verification targets", "");
  for (const section of sections) {
    const background = section.backgroundColor
      ? `background ${code(section.backgroundColor)}`
      : "recorded background";
    lines.push(
      `- Section ${code(section.regionId)}: compare the ${markdownText(selection.regions.find((region) => region.regionId === section.regionId)?.viewport ?? "recorded")} viewport ${background} and approximate geometry against the selection artifact.`,
    );
  }
  for (const component of components) {
    const fields = STYLE_FIELDS.filter(([field]) => component.styles[field]).map(([field]) => field);
    lines.push(
      `- Component ${code(component.regionId)}: compare computed ${fields.length ? fields.join(", ") : "geometry"}${component.states.length ? ` and the observed ${component.states.map((state) => markdownText(state.state)).join("/")} state` : ""}.`,
    );
  }
  if (!sections.length && !components.length) {
    lines.push("- No verification target was available.");
  }

  lines.push("", "## Limitations", "");
  lines.push(
    "- `build_project` can scaffold layout and styling from these observations; it cannot recover application logic, data, business rules, fonts, licensed assets or interactions that were not observed.",
    "- Reference-only artifacts are not copied into this pack and must not be reused as assets.",
    "- Generated token names are labels for observed values, not the source site's token names.",
    "- Unobserved viewports, states and hierarchy remain unknown.",
  );
  for (const omission of selection.omitted) {
    lines.push(`- ${markdownText(omission.family)}: ${markdownText(omission.reason)}.`);
  }
  lines.push("");
  return rendered("rebuild-handoff.md", lines.join("\n"));
}

export function renderSelectionArtifact(selection: EvidenceSelection): {
  document: RenderedDocument;
  payload: Record<string, unknown>;
} {
  const payload: Record<string, unknown> = {
    schemaVersion: EVIDENCE_SELECTION_SCHEMA_VERSION,
    packId: selection.packId,
    siteSlug: selection.siteSlug,
    goal: selection.goal,
    inclusionMode: selection.inclusionMode,
    captures: selection.captures,
    regions: selection.regions,
    claims: selection.claims,
    tokens: selection.tokens,
    sections: orderedSections(selection),
    components: orderedComponents(selection),
    references: selection.references,
    media: selection.media,
    omitted: selection.omitted,
    coverage: selection.coverage,
    limitations: selection.limitations,
    rightsAssertions: selection.rightsAssertions,
    sourceUrls: selection.sourceUrls,
  };
  return {
    document: rendered("artifacts/selection.json", `${JSON.stringify(payload, null, 2)}\n`),
    payload,
  };
}

function redactUrl(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

export function renderDesignEvidence(
  selection: EvidenceSelection,
  selectionSha256: string,
  documentBytes: number,
  exporterVersion: PackExporterVersion = EVIDENCE_PACK_EXPORTER_VERSION,
): { document: RenderedDocument; payload: Record<string, unknown> } {
  const selectionHash = selectionSha256;
  const observedAt = selection.captures.reduce<number | null>((latest, capture) => {
    const value = capture.observedAt ?? capture.lastConfirmedAt ?? capture.sourceFetchedAt;
    if (value === null) return latest;
    return latest === null || value > latest ? value : latest;
  }, null);
  const viewports = uniqueSorted(selection.captures.map((capture) => capture.viewport));
  const base: Record<string, unknown> = {
    schemaVersion: EVIDENCE_DESIGN_SCHEMA_VERSION,
    packId: selection.packId,
    requestedUrlHash: sha256Text(selection.sourceUrls[0] ?? selection.siteSlug),
    redactedFinalUrl: redactUrl(selection.sourceUrls[0]),
    capturedAt: observedAt ?? 0,
    viewport: viewports.length === 1 ? viewports[0] : viewports.join("+"),
    toolVersion: exporterVersion,
    captures: [
      {
        id: "selection",
        tool: "buildEvidencePack",
        artifactId: "selection",
        capturedAt: observedAt ?? 0,
        sha256: selectionHash,
        artifactPath: "artifacts/selection.json",
        coverage: selection.coverage.status,
        limitations: selection.limitations,
      },
    ],
    claims: selection.claims.map((claim) => ({
      id: claim.id,
      value: claim.value,
      classification: claim.classification,
      artifactId: claim.artifactId,
      path: claim.path,
      property: claim.property,
      viewport: claim.viewport,
      state: claim.state,
      method: claim.method,
      ruleId: claim.ruleId,
      sampleKey: claim.sampleKey,
      sampleCount: claim.sampleCount,
      sourceRegionId: claim.regionId,
      sourceCaptureId: claim.captureId,
      limitations: claim.limitations,
    })),
    omissions: [
      ...selection.omitted.map((omission) => ({
        family: omission.family,
        reason: omission.reason,
      })),
      ...selection.media
        .filter((decision) => !decision.included)
        .map((decision) => ({
          family: `artifact:${decision.artifactId}`,
          reason: decision.reason,
        })),
    ],
    validation: {
      documentBytes,
      localValidator: "pass",
      googleLint: "not-run",
    },
  };
  // The byte count must describe the final file; iterate until the reported value
  // no longer changes the serialized length.
  let sidecarBytes = 0;
  let text = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    base.validation = { ...(base.validation as Record<string, unknown>), sidecarBytes };
    text = `${JSON.stringify(base, null, 2)}\n`;
    const next = TEXT_ENCODER.encode(text).length;
    if (next === sidecarBytes) break;
    sidecarBytes = next;
  }
  return { document: rendered("design-evidence.json", text), payload: base };
}

/**
 * Every document a selection derives, in one place. The builder writes these
 * and the validator re-renders and byte-compares them.
 */
export function renderGeneratedDocuments(
  selection: EvidenceSelection,
  selectionSha256: string,
  exporterVersion: PackExporterVersion = EVIDENCE_PACK_EXPORTER_VERSION,
): RenderedDocument[] {
  const designMd = renderDesignMd(selection);
  return [
    designMd,
    renderTokensJson(selection),
    renderTokensCss(selection),
    renderComponentsJson(selection),
    renderBrief(selection),
    renderRebuildHandoff(selection, selection.goal),
    renderDesignEvidence(selection, selectionSha256, designMd.bytes, exporterVersion).document,
  ];
}

export function evidenceClaimId(
  regionId: string,
  property: string,
  value: string,
  sampleKey: string,
  state: string,
): string {
  return `claim-${stableHash(
    "evidence-claim-v1",
    regionId,
    property,
    value,
    sampleKey,
    state,
  ).slice(0, 16)}`;
}
