// Phase 6A capture: the existing guarded collector and publisher, wrapped in
// one bounded tool result. Cached reuse follows spec 13.1 (7 days, same head,
// same requested states); a partial attempt may return without publication.
import type { Cache } from "../cache.js";
import {
  collectAtlasPage,
  AtlasCollectionError,
} from "./collector.js";
import type {
  AtlasCaptureAttempt,
  AtlasCollectDeps,
  AtlasStateRequest,
  AtlasStoredArtifact,
  AtlasViewportCapture,
} from "./live-types.js";
import { publishCapture } from "./publish.js";
import { resolveAtlasTarget } from "./target.js";
import { pageId } from "./identity.js";
import { artifactAvailabilityOf } from "./tool-read.js";
import {
  captureAtlasDataSchema,
  type AtlasArtifactAvailability,
  type AtlasEnvelope,
  type AtlasRegionSummary,
  type CaptureAtlasData,
  type CaptureAtlasInput,
} from "./tool-contracts.js";
import { atlasFailure, atlasSuccess, safeMessage, UNKNOWN_COVERAGE } from "./tool-envelope.js";
import type { EvidenceCoverage } from "./types.js";

const REUSE_MS = 7 * 86_400_000;
const SUMMARY_LIMIT = 64;
const ARTIFACT_LIMIT = 32;
const SOURCE_KIND = "live_page";

export interface CaptureAtlasOptions {
  now?: () => number;
  signal?: AbortSignal;
  collect?: typeof collectAtlasPage;
  publish?: typeof publishCapture;
  collectDeps?: Omit<AtlasCollectDeps, "cache">;
}

interface CaptureRow {
  id: string;
  attempt_id: string;
  page_id: string;
  status: string;
  profile_key: string;
  coverage_json: string;
  config_json: string;
  started_at: number;
  finished_at: number | null;
  observed_at: number | null;
  last_confirmed_at: number | null;
  source_fetched_at: number | null;
  site_slug: string;
}

interface SummaryRow {
  id: string;
  kind: string;
  ordinal: number;
  locator_json: string | null;
  heading: string;
  primary_label: string | null;
  samples_json: string;
  pattern_key: string | null;
  coverage_json: string;
}

function parseJson<T>(text: string | null | undefined): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function coverageOf(text: string): EvidenceCoverage {
  const parsed = parseJson<EvidenceCoverage>(text);
  if (
    parsed &&
    (parsed.status === "complete" || parsed.status === "partial" || parsed.status === "unknown") &&
    Array.isArray(parsed.limitations)
  ) {
    return {
      status: parsed.status,
      collected: Math.max(0, Math.trunc(parsed.collected)),
      excluded: Math.max(0, Math.trunc(parsed.excluded)),
      limitations: parsed.limitations
        .filter((item): item is string => typeof item === "string")
        .slice(0, 16)
        .map((item) => item.slice(0, 100)),
    };
  }
  return UNKNOWN_COVERAGE;
}

function coverage(
  status: EvidenceCoverage["status"],
  collected: number,
  excluded = 0,
  limitations: string[] = [],
): EvidenceCoverage {
  return {
    status,
    collected: Math.max(0, Math.trunc(collected)),
    excluded: Math.max(0, Math.trunc(excluded)),
    limitations: [...new Set(limitations)].slice(0, 16).map((item) => item.slice(0, 100)),
  };
}

function rectOf(samples: Record<string, unknown>): AtlasRegionSummary["rect"] {
  const rect = samples.rect;
  if (
    rect &&
    typeof rect === "object" &&
    Number.isFinite((rect as Record<string, unknown>).x) &&
    Number.isFinite((rect as Record<string, unknown>).y) &&
    Number.isFinite((rect as Record<string, unknown>).width) &&
    Number.isFinite((rect as Record<string, unknown>).height)
  ) {
    const value = rect as Record<string, number>;
    return { x: value.x, y: value.y, width: value.width, height: value.height };
  }
  return null;
}

function summaryRowOf(row: SummaryRow): AtlasRegionSummary {
  const locator = parseJson<Record<string, unknown>>(row.locator_json) ?? {};
  const samples = parseJson<Record<string, unknown>>(row.samples_json) ?? {};
  return {
    regionId: row.id.slice(0, 128),
    kind: row.kind === "component" ? "component" : "section",
    ordinal: Math.max(0, Number(row.ordinal) || 0),
    tag: typeof locator.tag === "string" ? locator.tag.slice(0, 50) : null,
    role: typeof samples.role === "string" ? samples.role.slice(0, 100) : null,
    landmark: typeof samples.landmark === "string" ? samples.landmark.slice(0, 100) : null,
    selector: typeof locator.selector === "string" ? locator.selector.slice(0, 512) : null,
    heading: (row.heading ?? "").slice(0, 200),
    primaryLabel: row.primary_label === null ? null : row.primary_label.slice(0, 200),
    type: row.kind === "component" && row.primary_label ? row.primary_label.slice(0, 100) : null,
    patternKey: row.pattern_key === null ? null : row.pattern_key.slice(0, 256),
    rect: rectOf(samples),
    visible: typeof samples.visible === "boolean" ? samples.visible : null,
    state: null,
    coverage: coverageOf(row.coverage_json),
  };
}

function summaryFromCandidate(
  candidate: {
    key: string;
    ordinal: number;
    selector: string;
    tag: string;
    role: string | null;
    landmark?: string | null;
    heading?: string | null;
    label?: string;
    type?: string;
    patternKey?: string;
    visible: boolean;
    rect: { x: number; y: number; width: number; height: number };
  },
  kind: "section" | "component",
  viewportCoverage: EvidenceCoverage,
  primaryLabel: string | null,
): AtlasRegionSummary {
  return {
    regionId: candidate.key.slice(0, 128),
    kind,
    ordinal: Math.max(0, Number(candidate.ordinal) || 0),
    tag: candidate.tag ? candidate.tag.slice(0, 50) : null,
    role: candidate.role ? candidate.role.slice(0, 100) : null,
    landmark: candidate.landmark ? candidate.landmark.slice(0, 100) : null,
    selector: candidate.selector ? candidate.selector.slice(0, 512) : null,
    heading: (candidate.heading ?? "").slice(0, 200),
    primaryLabel,
    type: kind === "component" ? (candidate.type ?? "").slice(0, 100) : null,
    patternKey: candidate.patternKey ? candidate.patternKey.slice(0, 256) : null,
    rect: candidate.rect,
    visible: candidate.visible,
    state: null,
    coverage: viewportCoverage,
  };
}

function capabilityCoverage(args: {
  coverage: EvidenceCoverage;
  limitations: string[];
  sections: number;
  components: number;
  componentsRequested: boolean;
  sectionsExcluded?: number;
  componentsExcluded?: number;
  screenshots: number;
  geometryRegions: number;
  statesRequested: number;
  statesObserved: number;
}): CaptureAtlasData["capabilityCoverage"] {
  const base = args.coverage;
  const limits = args.limitations;
  const policyBlocked = limits.includes("POLICY_BLOCKED");
  const stateLimits =
    args.statesRequested === 0 ? ["STATE_NOT_REQUESTED"] : limits.filter((code) => code.startsWith("STATE_"));
  return {
    geometry: coverage(
      args.geometryRegions > 0 ? base.status : "unknown",
      args.geometryRegions,
      0,
      limits.filter((code) => code === "INVALID_GEOMETRY"),
    ),
    sections: coverage(
      args.sections > 0 ? base.status : "unknown",
      args.sections,
      args.sectionsExcluded ?? 0,
      limits.filter((code) => code === "SECTION_TRUNCATION" || code === "SECTION_EXCLUDED"),
    ),
    components:
      !args.componentsRequested
        ? coverage("unknown", 0)
        : coverage(
            args.components > 0 ? base.status : "unknown",
            args.components,
            args.componentsExcluded ?? 0,
            limits.filter((code) => code === "COMPONENT_CAP" || code.startsWith("COMPONENT_CAP:") || code === "COMPONENTS_NOT_COLLECTED"),
          ),
    screenshots: coverage(
      args.screenshots > 0
        ? limits.some((code) => code.startsWith("SCREENSHOT_LIMIT") || code.startsWith("SCREENSHOT_FAILED") || code.startsWith("SCREENSHOT_EMPTY") || code.startsWith("SCREENSHOT_INVALID"))
          ? "partial"
          : "complete"
        : "unknown",
      args.screenshots,
      0,
      limits.filter((code) => code.startsWith("SCREENSHOT")),
    ),
    tokens: coverage("unknown", 0),
    states:
      args.statesRequested === 0
        ? coverage("unknown", 0, 0, stateLimits)
        : coverage(
            args.statesObserved === args.statesRequested ? "complete" : "partial",
            args.statesObserved,
            args.statesRequested - args.statesObserved,
            stateLimits,
          ),
    motion: coverage("unknown", 0),
    rendering: coverage("unknown", 0),
    policy: policyBlocked
      ? coverage("unknown", 0, 0, ["POLICY_BLOCKED"])
      : coverage("complete", 0),
  };
}

function requestStateKeys(states: AtlasStateRequest[] | undefined): string[] {
  return (states ?? [])
    .map((state) => `${state.action}:${state.targetRegionId}`)
    .sort();
}

function configStateKeys(config: Record<string, unknown>): string[] {
  const states = Array.isArray(config.states) ? config.states : [];
  return states
    .flatMap((state) => {
      if (!state || typeof state !== "object") return [];
      const record = state as Record<string, unknown>;
      if (typeof record.action !== "string") return [];
      const target = typeof record.targetRegionId === "string" ? record.targetRegionId : "";
      return [`${record.action}:${target}`];
    })
    .sort();
}

function readHead(cache: Cache, pageIdValue: string, profileKey: string): string | null {
  try {
    return cache.withAtlasReadDb(
      (db) =>
        (db
          .prepare("SELECT capture_id FROM atlas_heads WHERE page_id = ? AND profile_key = ?")
          .get(pageIdValue, profileKey) as { capture_id: string } | undefined)?.capture_id ?? null,
    );
  } catch {
    return null;
  }
}

function reusableCapture(
  cache: Cache,
  pageIdValue: string,
  profileKey: string,
  requestedStates: AtlasStateRequest[] | undefined,
  now: number,
): string | null {
  try {
    return cache.withAtlasReadDb((db) => {
      const row = db
        .prepare(
          `SELECT c.id, c.config_json, c.coverage_json,
                  COALESCE(c.last_confirmed_at, c.observed_at, c.source_fetched_at, c.finished_at) AS confirmed
             FROM atlas_heads h
             JOIN atlas_captures c
               ON c.id = h.capture_id AND c.page_id = h.page_id AND c.profile_key = h.profile_key
            WHERE h.page_id = ? AND h.profile_key = ? AND c.status IN ('complete','partial')`,
        )
        .get(pageIdValue, profileKey) as
        | { id: string; config_json: string; coverage_json: string; confirmed: number | null }
        | undefined;
      if (!row || row.confirmed === null || now - Number(row.confirmed) > REUSE_MS) return null;
      const config = parseJson<Record<string, unknown>>(row.config_json) ?? {};
      if (JSON.stringify(configStateKeys(config)) !== JSON.stringify(requestStateKeys(requestedStates))) {
        return null;
      }
      return row.id;
    });
  } catch {
    return null;
  }
}

interface StoredCapture {
  data: CaptureAtlasData;
  status: "ok" | "partial";
  coverage: EvidenceCoverage;
}

function storedCaptureData(
  cache: Cache,
  captureId: string,
  previousHeadId: string | null,
  cached: boolean,
  published: boolean,
  componentsRequested: boolean,
): StoredCapture | null {
  return cache.withAtlasReadDb((db) => {
    const capture = db
      .prepare(
        `SELECT c.id, c.attempt_id, c.page_id, c.status, c.profile_key, c.coverage_json,
                c.config_json, c.started_at, c.finished_at, c.observed_at, c.last_confirmed_at,
                c.source_fetched_at, p.site_slug
           FROM atlas_captures c JOIN atlas_pages p ON p.id = c.page_id
          WHERE c.id = ?`,
      )
      .get(captureId) as CaptureRow | undefined;
    if (!capture) return null;
    const viewport = capture.profile_key.includes("mobile") ? "mobile" : "desktop";
    const rows = db
      .prepare(
        `SELECT id, kind, ordinal, locator_json, heading, primary_label, samples_json,
                pattern_key, coverage_json
           FROM atlas_regions
          WHERE capture_id = ? AND kind IN ('section','component')
          ORDER BY kind, ordinal, id`,
      )
      .all(captureId) as unknown as SummaryRow[];
    const sectionRows = rows.filter((row) => row.kind === "section");
    const componentRows = rows.filter((row) => row.kind === "component");
    const artifacts = db
      .prepare(
        `SELECT id, capture_id, region_id, kind, storage_path, sha256, bytes, mime_type, state
           FROM atlas_artifacts WHERE capture_id = ? ORDER BY id LIMIT ${ARTIFACT_LIMIT + 1}`,
      )
      .all(captureId) as unknown as Array<{
      id: string;
      capture_id: string;
      region_id: string | null;
      kind: string;
      storage_path: string | null;
      sha256: string | null;
      bytes: number | null;
      mime_type: string;
      state: string;
    }>;
    const allArtifacts = db
      .prepare(
        `SELECT id, capture_id, region_id, kind, storage_path, sha256, bytes, mime_type, state
           FROM atlas_artifacts WHERE capture_id = ? ORDER BY id`,
      )
      .all(captureId) as unknown as Array<{
      id: string;
      capture_id: string;
      region_id: string | null;
      kind: string;
      storage_path: string | null;
      sha256: string | null;
      bytes: number | null;
      mime_type: string;
      state: string;
    }>;
    const brokenArtifacts = allArtifacts.filter(
      (row) =>
        row.kind !== "external_media" &&
        row.state === "ready" &&
        !artifactAvailabilityOf(cache.rootDir, row).available,
    );
    const artifactLimitations = brokenArtifacts.length > 0 ? ["ARTIFACT_MISSING"] : [];
    const stateEvidence = db
      .prepare(
        `SELECT COUNT(DISTINCT cl.sample_key) AS n
           FROM atlas_claims cl JOIN atlas_regions r ON r.id = cl.region_id
          WHERE r.capture_id = ? AND cl.state <> 'default'`,
      )
      .get(captureId) as { n: number };
    const config = parseJson<Record<string, unknown>>(capture.config_json) ?? {};
    const availability = coverageOf(capture.coverage_json);
    // A head captured with components off cannot answer a components-on
    // request; reuse stays allowed but must not claim component completeness.
    const componentsNotCollected = componentsRequested && config.components === false;
    const storedLimitations = componentsNotCollected
      ? [...new Set([...availability.limitations, ...artifactLimitations, "COMPONENTS_NOT_COLLECTED"])]
      : [...new Set([...availability.limitations, ...artifactLimitations])];
    const suffix = `:${capture.profile_key}`;
    const attemptId = capture.attempt_id.endsWith(suffix)
      ? capture.attempt_id.slice(0, -suffix.length)
      : capture.attempt_id;
    const sections = sectionRows.slice(0, SUMMARY_LIMIT).map(summaryRowOf);
    const components = componentsRequested
      ? componentRows.slice(0, SUMMARY_LIMIT).map(summaryRowOf)
      : [];
    const artifactRows = artifacts.slice(0, ARTIFACT_LIMIT).map((row) =>
      artifactAvailabilityOf(cache.rootDir, row),
    );
    // Counts come from SQL: the descriptor query is capped, so counting its
    // rows would undercount a capture with more than ARTIFACT_LIMIT artifacts.
    const artifactTotals = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN kind = 'screenshot' THEN 1 ELSE 0 END), 0) AS screenshots,
                COALESCE(SUM(CASE WHEN kind = 'component_pack' THEN 1 ELSE 0 END), 0) AS packs
           FROM atlas_artifacts WHERE capture_id = ?`,
      )
      .get(captureId) as { screenshots: number; packs: number };
    const screenshotCount = Math.max(0, Number(artifactTotals.screenshots) || 0);
    const packCount = Math.max(0, Number(artifactTotals.packs) || 0);
    const returnedScreenshots = artifactRows.filter((row) => row.kind === "screenshot").length;
    const returnedPacks = artifactRows.filter((row) => row.kind === "component_pack").length;
    const geometryRegions = rows.filter((row) => {
      const samples = parseJson<Record<string, unknown>>(row.samples_json) ?? {};
      return rectOf(samples) !== null;
    }).length;
    const data: CaptureAtlasData = {
      captureId: capture.id,
      attemptId: attemptId.slice(0, 200),
      pageId: capture.page_id,
      cached,
      published,
      previousHeadId,
      viewport,
      sections,
      components,
      artifacts: artifactRows,
      capabilityCoverage: capabilityCoverage({
        coverage: availability,
        limitations: storedLimitations,
        sections: sectionRows.length,
        components: componentRows.length,
        componentsRequested,
        sectionsExcluded: Math.max(0, sectionRows.length - sections.length),
        componentsExcluded: componentsRequested
          ? Math.max(0, componentRows.length - components.length)
          : 0,
        screenshots: screenshotCount,
        geometryRegions,
        statesRequested: configStateKeys(config).length,
        statesObserved: Math.max(0, Number(stateEvidence.n) || 0),
      }),
      omitted: {
        sections: Math.max(0, sectionRows.length - sections.length),
        components: componentsRequested
          ? Math.max(0, componentRows.length - components.length)
          : componentRows.length,
        screenshots: Math.max(0, screenshotCount - returnedScreenshots),
        componentPacks: Math.max(0, packCount - returnedPacks),
      },
    };
    // A stored partial capture stays partial on reuse: status, excluded and
    // limitations are read back from the capture row and its coverage_json.
    const coverageStatus: EvidenceCoverage["status"] =
      availability.status === "unknown"
        ? "unknown"
        : componentsNotCollected ||
            artifactLimitations.length > 0 ||
            capture.status !== "complete" ||
            availability.status === "partial" ||
            data.capabilityCoverage.sections.status !== "complete"
          ? "partial"
          : "complete";
    return {
      data: captureAtlasDataSchema.parse(data),
      status: coverageStatus === "complete" ? "ok" : "partial",
      // The envelope reports what the capture stored, not the capped summary
      // arrays; those truncations stay in `omitted`.
      coverage: {
        status: coverageStatus,
        collected: availability.collected,
        excluded: availability.excluded,
        limitations: storedLimitations,
      },
    };
  });
}

function attemptArtifact(
  cache: Cache,
  artifact: AtlasStoredArtifact,
  captureId: string,
): AtlasArtifactAvailability {
  return artifactAvailabilityOf(cache.rootDir, {
    id: artifact.key.slice(0, 128),
    capture_id: captureId,
    region_id: null,
    kind: artifact.kind,
    storage_path: artifact.storagePath,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    mime_type: artifact.mimeType,
    state: "ready",
  });
}

function attemptCaptureData(
  cache: Cache,
  attempt: AtlasCaptureAttempt,
  viewport: AtlasViewportCapture,
  captureId: string,
  pageIdValue: string,
  previousHeadId: string | null,
  componentsRequested: boolean,
): CaptureAtlasData {
  const claims = viewport.claims;
  const acceptedPurpose = (key: string): string | null =>
    claims.find(
      (claim) =>
        claim.regionKey === key &&
        claim.field === "section.purpose" &&
        claim.decision === "accepted" &&
        claim.value !== "unknown",
    )?.value ?? null;
  const allSections = viewport.regions.map((candidate) =>
    summaryFromCandidate(
      {
        ...candidate,
        heading: candidate.heading,
        label: undefined,
        type: undefined,
        patternKey: undefined,
      },
      "section",
      viewport.coverage,
      acceptedPurpose(candidate.key),
    ),
  );
  const allComponents = (viewport.components ?? []).map((candidate) =>
    summaryFromCandidate(
      {
        ...candidate,
        heading: candidate.label,
        patternKey: candidate.patternKey,
      },
      "component",
      viewport.coverage,
      candidate.label ? candidate.label.slice(0, 200) : null,
    ),
  );
  const sections = allSections.slice(0, SUMMARY_LIMIT);
  const components = componentsRequested ? allComponents.slice(0, SUMMARY_LIMIT) : [];
  const artifacts = viewport.artifacts
    .slice(0, ARTIFACT_LIMIT)
    .map((artifact) => attemptArtifact(cache, artifact, captureId));
  const screenshots = viewport.screenshots.length;
  const packs = viewport.artifacts.filter((artifact) => artifact.kind === "component_pack").length;
  const returnedScreenshots = artifacts.filter((row) => row.kind === "screenshot").length;
  const returnedPacks = artifacts.filter((row) => row.kind === "component_pack").length;
  const statesRequested = attempt.states?.length ?? 0;
  const statesObserved = viewport.states?.filter((state) => state.status === "observed").length ?? 0;
  const geometryRegions = [...viewport.regions, ...(viewport.components ?? [])].filter(
    (candidate) =>
      candidate.rect &&
      Number.isFinite(candidate.rect.width) &&
      Number.isFinite(candidate.rect.height) &&
      candidate.rect.width > 0 &&
      candidate.rect.height > 0,
  ).length;
  const data: CaptureAtlasData = {
    captureId: captureId.slice(0, 128),
    attemptId: attempt.attemptId.slice(0, 200),
    pageId: pageIdValue,
    cached: false,
    published: false,
    previousHeadId,
    viewport: viewport.viewport,
    sections,
    components,
    artifacts,
    capabilityCoverage: capabilityCoverage({
      coverage: viewport.coverage,
      limitations: viewport.limitations,
      sections: viewport.regions.length,
      components: viewport.components?.length ?? 0,
      componentsRequested,
      sectionsExcluded: Math.max(0, viewport.regions.length - sections.length),
      componentsExcluded: componentsRequested
        ? Math.max(0, (viewport.components?.length ?? 0) - components.length)
        : 0,
      screenshots,
      geometryRegions,
      statesRequested,
      statesObserved,
    }),
    omitted: {
      sections: Math.max(0, viewport.regions.length - sections.length),
      components: componentsRequested
        ? Math.max(0, (viewport.components?.length ?? 0) - components.length)
        : viewport.components?.length ?? 0,
      screenshots: Math.max(0, screenshots - returnedScreenshots),
      componentPacks: Math.max(0, packs - returnedPacks),
    },
  };
  return captureAtlasDataSchema.parse(data);
}

function collectionFailure(
  error: unknown,
  cache: Cache,
): { status: "error" | "blocked" | "inconclusive"; code: string; message: string; retryable: boolean } {
  const code = error instanceof AtlasCollectionError ? error.code : "CAPTURE_FAILED";
  const message = safeMessage(error instanceof Error ? error.message : String(error), cache.rootDir);
  switch (code) {
    case "POLICY_BLOCKED":
    case "BLOCKED_DESTINATION":
    case "DESTINATION_CHANGED":
    case "ROBOTS_DENIED":
    case "ROBOTS_DISALLOWED":
    case "HTTP_BLOCKED":
    case "PRIVATE_DESTINATION":
      return { status: "blocked", code, message, retryable: false };
    case "CAPTURE_DEADLINE_EXCEEDED":
    case "CAPTURE_TIMEOUT":
    case "NAVIGATION_FAILED":
    case "ROBOTS_UNAVAILABLE":
    case "TARGET_CHANGED":
      return { status: "inconclusive", code, message, retryable: true };
    case "CAPTURE_BUSY":
      return { status: "error", code, message: "Another Atlas capture owns this cache", retryable: true };
    case "CAPTURE_LEASE_UNAVAILABLE":
    case "CAPTURE_LEASE_CORRUPT":
      return { status: "error", code, message: "The Atlas capture lease is unavailable", retryable: true };
    default:
      return { status: "error", code, message, retryable: false };
  }
}

export async function runAtlasCapture(
  cache: Cache,
  input: CaptureAtlasInput,
  options: CaptureAtlasOptions = {},
): Promise<AtlasEnvelope<CaptureAtlasData>> {
  if (!cache.atlas) {
    return atlasFailure(
      "capture_atlas",
      "FEATURE_DISABLED",
      "Atlas capture requires AWWWARDS_MCP_ATLAS=1",
      false,
    );
  }
  const now = options.now?.() ?? Date.now();
  const viewport = input.viewport ?? "desktop";
  const componentsRequested = input.components !== false;
  const profileKey = `live-${viewport}`;
  const target = resolveAtlasTarget({ siteSlug: input.slug, path: input.path }, { cache });
  if (!target.ok) {
    return atlasFailure("capture_atlas", target.code, target.message, false);
  }
  const pageIdValue = pageId(input.slug, SOURCE_KIND, target.target.urlKey);

  if (input.refresh !== true) {
    const reused = reusableCapture(cache, pageIdValue, profileKey, input.states, now);
    if (reused) {
      try {
        const stored = storedCaptureData(cache, reused, null, true, false, componentsRequested);
        if (stored) {
          return atlasSuccess(
            "capture_atlas",
            stored.status,
            stored.data,
            stored.coverage,
            stored.coverage.limitations,
          );
        }
      } catch {
        /* fall through to a fresh capture */
      }
    }
  }

  const previousHeadId = readHead(cache, pageIdValue, profileKey);
  const collect = options.collect ?? collectAtlasPage;
  const publish = options.publish ?? publishCapture;
  let attempt: AtlasCaptureAttempt;
  try {
    attempt = await collect(
      {
        siteSlug: input.slug,
        ...(input.path !== undefined ? { path: input.path } : {}),
        viewports: [viewport],
        components: componentsRequested,
        ...(input.states !== undefined ? { states: input.states } : {}),
      },
      { cache, ...(options.collectDeps ?? {}), ...(options.signal ? { signal: options.signal } : {}) },
    );
  } catch (error) {
    const failure = collectionFailure(error, cache);
    return atlasFailure("capture_atlas", failure.code, failure.message, failure.retryable, failure.status);
  }

  let publication;
  try {
    publication = await publish(attempt);
  } catch (error) {
    return atlasFailure(
      "capture_atlas",
      "CAPTURE_FAILED",
      safeMessage(error instanceof Error ? error.message : String(error), cache.rootDir),
      false,
    );
  }
  const viewportCapture = attempt.viewports.find((item) => item.viewport === viewport);
  if (!viewportCapture) {
    const code =
      attempt.limitations.find((entry) =>
        [
          "CAPTURE_DEADLINE_EXCEEDED",
          "CAPTURE_TIMEOUT",
          "CAPTURE_BUSY",
          "NAVIGATION_FAILED",
          "ROBOTS_UNAVAILABLE",
          "ROBOTS_DENIED",
          "PRIVATE_DESTINATION",
          "POLICY_BLOCKED",
          "BLOCKED_DESTINATION",
          "TARGET_CHANGED",
        ].includes(entry),
      ) ?? "CAPTURE_FAILED";
    const failure = collectionFailure(
      new AtlasCollectionError(
        code,
        attempt.error ?? "The capture returned no evidence for the requested viewport",
      ),
      cache,
    );
    return atlasFailure(
      "capture_atlas",
      failure.code,
      failure.message,
      failure.retryable,
      failure.status,
    );
  }

  if (publication.published && !publication.captureIds[0]) {
    return atlasFailure(
      "capture_atlas",
      "CAPTURE_FAILED",
      "The publisher reported success without a capture id",
      false,
    );
  }

  if (publication.published && publication.captureIds[0]) {
    const stored = storedCaptureData(
      cache,
      publication.captureIds[0],
      previousHeadId,
      false,
      true,
      componentsRequested,
    );
    if (!stored) {
      return atlasFailure(
        "capture_atlas",
        "CAPTURE_FAILED",
        "The capture was published but its stored evidence could not be read",
        true,
      );
    }
    return atlasSuccess(
      "capture_atlas",
      stored.status,
      stored.data,
      stored.coverage,
      [...new Set(viewportCapture.limitations)].slice(0, 16),
    );
  }

  const code = publication.code ?? "NOT_PUBLISHED";
  if (code === "ATLAS_DISABLED") {
    return atlasFailure("capture_atlas", "FEATURE_DISABLED", "Atlas capture is disabled", false);
  }
  if (code === "POLICY_BLOCKED") {
    return atlasFailure("capture_atlas", code, "The capture was refused by the collection policy", false, "blocked");
  }
  if (code === "TARGET_CHANGED") {
    // Spec 14: a changed target is inconclusive state, not a policy refusal.
    return atlasFailure(
      "capture_atlas",
      code,
      "The page target changed during capture; the evidence was not published",
      true,
      "inconclusive",
    );
  }
  if (code === "PUBLICATION_BUSY") {
    return atlasFailure(
      "capture_atlas",
      "DATABASE_BUSY",
      "Another Atlas publication holds the cache; retry",
      true,
    );
  }
  if (attempt.status === "blocked") {
    return atlasFailure("capture_atlas", code, "The capture was blocked", false, "blocked");
  }
  if (attempt.status === "failed") {
    return atlasFailure("capture_atlas", code, "The capture failed before usable evidence was produced", false);
  }

  const data = attemptCaptureData(
    cache,
    attempt,
    viewportCapture,
    publication.captureIds[0] ?? "",
    pageIdValue,
    previousHeadId,
    componentsRequested,
  );
  const status = attempt.status === "unknown" ? "inconclusive" : "partial";
  return atlasSuccess(
    "capture_atlas",
    status,
    data,
    viewportCapture.coverage,
    [...new Set([...viewportCapture.limitations, code])].slice(0, 16),
  );
}
