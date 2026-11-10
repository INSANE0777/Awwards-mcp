import { join } from "node:path";
import { Cache } from "../../src/cache.js";
import { writeArtifactBytesSync, writeJsonArtifactSync } from "../../src/atlas/artifacts.js";
import { classifySections } from "../../src/atlas/classification.js";
import {
  classifyComponents,
  componentPatternKey,
  discoverComponents,
} from "../../src/atlas/components.js";
import { publishCapture } from "../../src/atlas/publish.js";
import { regionStableKey, segmentRegions } from "../../src/atlas/segmentation.js";
import type {
  AtlasCaptureAttempt,
  AtlasPageScan,
  AtlasScanComponent,
  AtlasStoredArtifact,
  AtlasViewportProfile,
} from "../../src/atlas/live-types.js";
import { loadPhase2Fixture } from "./phase2-fixture.js";

export const PACK_NOW = Date.UTC(2026, 10, 6, 12);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function componentScan(
  viewport: AtlasViewportProfile,
  sections: Array<{ selector: string; backgroundColor: string | null }>,
  variant: "a" | "b" = "a",
  sectionCount = 0,
  componentCount = 0,
): { scan: AtlasPageScan; components: AtlasScanComponent[] } {
  const { scan: baseScan } = loadPhase2Fixture();
  const sectionsViewport =
    viewport === "desktop" ? { width: 1440, height: 900 } : { width: 390, height: 844 };
  const scan: AtlasPageScan = {
    ...baseScan,
    sections: baseScan.sections.map((section, index) => ({
      ...section,
      rect:
        viewport === "mobile"
          ? { ...section.rect, x: 0, width: Math.min(section.rect.width, sectionsViewport.width) }
          : section.rect,
      backgroundColor:
        sections[index]?.backgroundColor ?? (index === 0 ? "rgb(5, 5, 5)" : "rgb(255, 255, 255)"),
      viewport: sectionsViewport,
    })),
  };
  if (sectionCount > scan.sections.length) {
    const templates = [...scan.sections];
    for (let index = templates.length; index < sectionCount; index += 1) {
      const template = templates[index % templates.length]!;
      scan.sections.push({
        ...template,
        nodeKey: `${template.nodeKey}-extra-${index}`,
        selector: `${template.selector}-extra-${index}`,
      });
    }
  }
  const styles =
    variant === "a"
      ? {
          display: "inline-flex",
          gap: "8px",
          padding: "12px 24px",
          radius: "6px",
          fontFamily: "Inter, sans-serif",
          fontSize: "16px",
          fontWeight: "600",
          lineHeight: "24px",
        }
      : {
          display: "block",
          gap: "10px",
          padding: "16px 20px",
          radius: "8px",
          fontFamily: "Georgia, serif",
          fontSize: "18px",
          fontWeight: "500",
          lineHeight: "28px",
        };
  const heroSection = scan.sections[1]!;
  const headerSection = scan.sections[0]!;
  const components: AtlasScanComponent[] = [
    {
      nodeKey: "component-header-link",
      selector: "header.site-header a.cta",
      tag: "a",
      role: "link",
      hint: "link",
      hintBasis: "native_semantics",
      label: "Get started",
      visible: true,
      offscreen: false,
      offCanvas: false,
      fullyClipped: false,
      sectionNodeKey: headerSection.nodeKey,
      childCount: 0,
      descendantCount: 0,
      hasHeading: false,
      hasMedia: false,
      hasIcon: false,
      inNavigation: true,
      ariaHasPopup: false,
      ariaExpanded: null,
      ariaControlsResolved: false,
      ariaLabel: null,
      overflowX: "visible",
      scrollableX: false,
      position: "static",
      transformed: false,
      shape: "inline",
      childCounts: "0",
      ...styles,
      rect: { x: 1120, y: 24, width: 180, height: 44 },
      depth: 5,
      pack: {
        nodes: [{ tag: "a", role: "link", depth: 0, childCount: 0 }],
        truncated: false,
      },
    },
    {
      nodeKey: "component-hero-button",
      selector: "main > section.hero button.primary",
      tag: "button",
      role: null,
      hint: "button",
      hintBasis: "native_semantics",
      label: "Start a project",
      visible: true,
      offscreen: false,
      offCanvas: false,
      fullyClipped: false,
      sectionNodeKey: heroSection.nodeKey,
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
      shape: "pill",
      childCounts: "0",
      ...styles,
      rect: { x: 200, y: 400, width: 200, height: 56 },
      depth: 6,
      pack: {
        nodes: [{ tag: "button", role: null, depth: 0, childCount: 0 }],
        truncated: false,
      },
    },
  ];
  if (componentCount > components.length) {
    const templates = [...components];
    for (let index = templates.length; index < componentCount; index += 1) {
      const template = templates[index % templates.length]!;
      components.push({
        ...template,
        nodeKey: `${template.nodeKey}-extra-${index}`,
        selector: `${template.selector}-extra-${index}`,
        rect: { ...template.rect, y: template.rect.y + index * 8 },
      });
    }
  }
  scan.components = components;
  return { scan, components };
}

export interface PackFixtureOptions {
  siteSlug?: string;
  fetchedAt?: number;
  variant?: "a" | "b";
  includeState?: boolean;
  viewport?: AtlasViewportProfile;
  /** Capture-level coverage limitations that are not region limitations. */
  coverageLimitations?: string[];
  /** Stored status; default complete. */
  status?: "complete" | "partial";
  /** Total screenshot artifacts (default 1). */
  screenshotCount?: number;
  /** Total component-pack artifacts (default: one per discovered pack). */
  componentPackCount?: number;
  /** Total scan sections; default is the phase2 fixture's own count. */
  sectionCount?: number;
  /** Total scan components; default is the two built-in components. */
  componentCount?: number;
  /** Collect component candidates and packs; default true. */
  components?: boolean;
}

export interface PackFixtureResult {
  captureId: string;
  pageId: string;
  sectionIds: string[];
  componentIds: string[];
  pageRootId: string;
}

export async function buildPackAttempt(
  cache: Cache,
  options: PackFixtureOptions = {},
): Promise<AtlasCaptureAttempt> {
  const siteSlug = options.siteSlug ?? "pack-fixture";
  const viewport = options.viewport ?? "desktop";
  const fetchedAt = options.fetchedAt ?? PACK_NOW;
  const coverageLimitations = options.coverageLimitations ?? [];
  const status = options.status ?? "complete";
  const componentsEnabled = options.components !== false;
  const { scan, components: rawComponents } = componentScan(
    viewport,
    [],
    options.variant ?? "a",
    options.sectionCount ?? 0,
    options.componentCount ?? 0,
  );
  if (!componentsEnabled) scan.components = [];
  scan.url = `https://${siteSlug}.example/`;
  const regions = segmentRegions(scan);
  const purposesByKey = new Map<string, string[]>();
  const sectionClaims = classifySections(
    regions.map((candidate) => ({
      viewport,
      candidate,
      scan,
      artifactKey: `scan-${viewport}`,
    })),
  );
  for (const claim of sectionClaims) {
    if (claim.field !== "section.purpose" || claim.decision !== "accepted") continue;
    const list = purposesByKey.get(claim.regionKey) ?? [];
    list.push(claim.value);
    purposesByKey.set(claim.regionKey, list);
  }

  const scanArtifact = writeJsonArtifactSync(cache.rootDir, {
    schemaVersion: "awwwards-atlas-live-scan-v1",
    viewport,
    scan,
  });
  const scanStored: AtlasStoredArtifact = {
    key: `scan-${viewport}`,
    kind: "raw_observation",
    storagePath: scanArtifact.storagePath,
    sha256: scanArtifact.sha256,
    bytes: scanArtifact.bytes,
    mimeType: "application/json",
    regionKey: null,
  };
  const screenshot = writeArtifactBytesSync(cache.rootDir, PNG, ".png");
  const screenshotStored: AtlasStoredArtifact = {
    key: `screenshot-${viewport}-0`,
    kind: "screenshot",
    storagePath: screenshot.storagePath,
    sha256: screenshot.sha256,
    bytes: screenshot.bytes,
    mimeType: "image/png",
    regionKey: null,
  };
  const screenshots: AtlasStoredArtifact[] = [screenshotStored];
  for (let index = 1; index < (options.screenshotCount ?? 1); index += 1) {
    screenshots.push({ ...screenshotStored, key: `screenshot-${viewport}-${index}` });
  }

  const sectionKeyByNode = new Map(regions.map((region) => [region.nodeKey, region.key]));
  const candidates = discoverComponents(scan).map((candidate) => {
    const sectionKey = candidate.sectionNodeKey
      ? (sectionKeyByNode.get(candidate.sectionNodeKey) ?? null)
      : null;
    const withSection = { ...candidate, sectionKey };
    return {
      ...withSection,
      patternKey: componentPatternKey(
        withSection,
        rawComponents[candidate.scanIndex] ?? null,
        `${siteSlug}|https://${siteSlug}.example/|${viewport}`,
      ),
    };
  });

  const packArtifacts: AtlasStoredArtifact[] = [];
  const packKeys = new Map<string, string>();
  candidates.forEach((candidate, index) => {
    if (!candidate.pack) return;
    const payload = {
      schemaVersion: "awwwards-atlas-component-pack-v1",
      componentKey: candidate.key,
      type: candidate.type,
      nodes: candidate.pack.nodes,
      truncated: candidate.pack.truncated,
    };
    const stored = writeJsonArtifactSync(cache.rootDir, payload);
    const key = `component-pack-${index}`;
    const artifact: AtlasStoredArtifact = {
      key,
      kind: "component_pack",
      storagePath: stored.storagePath,
      sha256: stored.sha256,
      bytes: stored.bytes,
      mimeType: "application/json",
      regionKey: candidate.key,
    };
    packArtifacts.push(artifact);
    packKeys.set(candidate.key, key);
  });

  const packTarget = options.componentPackCount ?? packArtifacts.length;
  while (packArtifacts.length > 0 && packArtifacts.length < packTarget) {
    packArtifacts.push({
      ...packArtifacts[0]!,
      key: `component-pack-extra-${packArtifacts.length}`,
    });
  }

  const claims = [...sectionClaims];
  for (const candidate of candidates) {
    const sampleKey = `${viewport}:${candidate.key}:observation-${viewport}-initial`;
    const componentClaims = classifyComponents({
      viewport,
      candidate,
      artifactKey: `scan-${viewport}`,
      packArtifactKey: packKeys.get(candidate.key) ?? null,
      sectionPurposes: candidate.sectionKey
        ? (purposesByKey.get(candidate.sectionKey) ?? [])
        : [],
      scan,
    });
    for (const claim of componentClaims) {
      claims.push({
        ...claim,
        sampleKey,
        evidence: claim.evidence.map((ref) => ({ ...ref, sampleKey })),
      });
    }
  }

  const artifacts: AtlasStoredArtifact[] = [scanStored, ...screenshots, ...packArtifacts];
  let stateArtifact: AtlasStoredArtifact | null = null;
  if (options.includeState) {
    const stored = writeJsonArtifactSync(cache.rootDir, {
      schemaVersion: "awwwards-atlas-state-v1",
      state: { action: "hover", changedProperties: ["backgroundColor"] },
    });
    stateArtifact = {
      key: `state-hover-${viewport}-0`,
      kind: "raw_observation",
      storagePath: stored.storagePath,
      sha256: stored.sha256,
      bytes: stored.bytes,
      mimeType: "application/json",
      regionKey: candidates[1]?.key ?? null,
    };
    artifacts.push(stateArtifact);
    const target = candidates[1];
    if (target) {
      const sampleKey = `${viewport}:${target.key}:state-hover`;
      const stateKey = `state-hover-${viewport}-0`;
      claims.push({
        regionKey: target.key,
        field: "component.type",
        value: target.type,
        decision: "accepted",
        classification: "observed",
        basis: "native_semantics",
        ruleId: target.typeRuleId,
        ruleVersion: "fixture-1",
        sampleKey,
        state: "hover",
        evidence: [{ artifactId: stateKey, pointer: "/state", sampleKey }],
      });
      claims.push({
        regionKey: target.key,
        field: "behavior",
        value: "hover_change_observed",
        decision: "accepted",
        classification: "observed",
        basis: "interaction_observation",
        ruleId: "behavior.state.hover",
        ruleVersion: "fixture-1",
        sampleKey,
        state: "hover",
        evidence: [{ artifactId: stateKey, pointer: "/state", sampleKey }],
      });
    }
  }

  const attempt: AtlasCaptureAttempt = {
    cache,
    target: {
      siteSlug,
      requestedUrl: `https://${siteSlug}.example/`,
      urlKey: `https://${siteSlug}.example/`,
      path: "/",
    },
    attemptId: `pack-attempt-${siteSlug}-${options.variant ?? "a"}-${viewport}-${options.includeState ? "state" : "plain"}`,
    startedAt: fetchedAt,
    finishedAt: fetchedAt + 1000,
    status,
    coverage: {
      status,
      collected: regions.length,
      excluded: 0,
      limitations: coverageLimitations,
    },
    limitations: [],
    artifacts,
    components: componentsEnabled,
    viewports: [
      {
        viewport,
        profileKey: `live-${viewport}`,
        status,
        coverage: {
          status,
          collected: regions.length,
          excluded: 0,
          limitations: coverageLimitations,
        },
        limitations: [],
        finalUrl: `https://${siteSlug}.example/`,
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
        screenshots,
        artifacts,
      },
    ],
  };
  return attempt;
}

/** Offline publication of one fixture attempt; returns the stored region ids. */
export async function publishPackFixture(
  cache: Cache,
  options: PackFixtureOptions = {},
): Promise<PackFixtureResult> {
  const attempt = await buildPackAttempt(cache, options);
  const result = await publishCapture(attempt);
  if (!result.published) throw new Error(`fixture publish failed: ${result.code ?? "unknown"}`);
  const ids = cache.withAtlasDb((db) => {
    const sections = db
      .prepare(
        "SELECT id FROM atlas_regions WHERE capture_id = ? AND kind = 'section' ORDER BY ordinal",
      )
      .all(result.captureIds[0]!) as Array<{ id: string }>;
    const components = db
      .prepare(
        "SELECT id FROM atlas_regions WHERE capture_id = ? AND kind = 'component' ORDER BY ordinal",
      )
      .all(result.captureIds[0]!) as Array<{ id: string }>;
    const root = db
      .prepare("SELECT id FROM atlas_regions WHERE capture_id = ? AND kind = 'page'")
      .get(result.captureIds[0]!) as { id: string };
    return {
      sectionIds: sections.map((row) => row.id),
      componentIds: components.map((row) => row.id),
      pageRootId: root.id,
    };
  });
  return {
    captureId: result.captureIds[0]!,
    pageId: result.pageId,
    ...ids,
  };
}
