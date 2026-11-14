import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Cache } from "../cache.js";
import { rightsRecordSchema } from "./contracts.js";
import { ATLAS_CLASSIFIER_VERSION, ATLAS_FTS_VERSION, ATLAS_SCHEMA_VERSION } from "./schema.js";
import { ATLAS_VOCABULARY_VERSION } from "./vocabulary.js";
import { readStoredArtifactJson, resolveArtifactPath, validateStoredArtifact } from "./artifacts.js";
import type { EvidenceCoverage } from "./types.js";
import {
  EVIDENCE_PACK_ATTRIBUTION,
  EVIDENCE_PACK_EXPORTER_VERSION,
  EVIDENCE_PACK_SCHEMA_VERSION,
  MAX_COPIED_ARTIFACT_BYTES,
  MAX_COPIED_ARTIFACTS,
  MAX_COPIED_TOTAL_BYTES,
  MAX_DESIGN_EVIDENCE_BYTES,
  MAX_DESIGN_MD_BYTES,
  MAX_PACK_GOAL_LENGTH,
  MAX_PACK_REGIONS,
  MAX_RIGHTS_ASSERTIONS,
  MAX_SELECTION_BYTES,
  MAX_TEXT_DOCUMENT_BYTES,
  STYLE_FIELDS,
  EvidencePackError,
  evidenceFileMime,
  supportedExporterVersion,
  type EvidencePackFile,
  type EvidencePackInput,
  type EvidencePackResult,
  type EvidencePackStore,
  type EvidenceSelection,
  type InclusionMode,
  type MediaCandidate,
  type MediaDecision,
  type PackArtifactRef,
  type PackCapture,
  type PackClaim,
  type PackExporterVersion,
  type PackObservation,
  type PackOmission,
  type PackRegion,
  type PolicyState,
  type RenderedDocument,
} from "./evidence-pack-types.js";
import {
  buildTokens,
  copiedArtifactPath,
  deriveComponentSummaries,
  deriveSectionSummaries,
  evidenceClaimId,
  omittedValues,
  packCoverage,
  renderDesignMd,
  renderGeneratedDocuments,
  renderRebuildHandoff,
  renderSelectionArtifact,
} from "./evidence-pack-render.js";
import { canonicalJson, validateEvidencePack } from "./evidence-pack-validate.js";
import { evidencePackId } from "./evidence-pack-id.js";

export {
  validateEvidencePack,
  renderDesignMd,
  renderRebuildHandoff,
  EvidencePackError,
};
export type {
  EvidencePackInput,
  EvidencePackResult,
  EvidencePackStore,
  EvidenceSelection,
  PackValidation,
  RenderedDocument,
} from "./evidence-pack-types.js";

const SLUG = /^[\w-]+$/;
const ID = /^[a-f0-9]{64}$/;
const PACKS_DIR = join("atlas", "evidence-packs");

interface HeadRow {
  page_id: string;
  profile_key: string;
  capture_id: string;
  site_slug: string;
  kind: string;
  public_url: string | null;
  path: string | null;
  status: string;
  config_hash: string;
  source_digest: string | null;
  observed_at: number | null;
  finished_at: number | null;
  source_fetched_at: number | null;
  last_confirmed_at: number | null;
  extractor_version: string;
  classifier_version: string;
  coverage_json: string;
  config_json: string;
  policy_json: string;
}

interface RegionRow {
  id: string;
  capture_id: string;
  parent_id: string | null;
  kind: string;
  ordinal: number;
  locator_json: string | null;
  heading: string;
  text_excerpt: string;
  raw_title: string | null;
  primary_label: string | null;
  samples_json: string;
  pattern_key: string | null;
  coverage_json: string;
}

interface ClaimRow {
  id: string;
  region_id: string;
  field: string;
  value: string;
  sample_key: string;
  classification: string;
  basis: string;
  decision: string;
  state: string;
  rule_id: string | null;
  rule_version: string | null;
  evidence_json: string;
  limitations_json: string;
}

interface ArtifactRow {
  id: string;
  capture_id: string;
  region_id: string | null;
  kind: string;
  storage_path: string | null;
  external_url: string | null;
  sha256: string | null;
  bytes: number | null;
  mime_type: string;
  state: string;
  rights_json: string;
  metadata_json: string;
}

interface PackRegistration {
  packId: string;
  manifestHash: string;
  selectionJson: string;
  createdAt: number;
  exporterVersion: PackExporterVersion;
}

interface FrozenFile {
  path: string;
  sha256: string;
  bytes: number;
}

/** Validated staged bytes captured before any publication seam can run. */
interface FrozenPack {
  manifestHash: string;
  selectionHash: string;
  files: FrozenFile[];
  registration: PackRegistration;
}

function invalid(message: string): EvidencePackError {
  return new EvidencePackError("INVALID_SELECTION", message);
}

function parseJson<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function normalizeGoal(value: unknown): string {
  if (typeof value !== "string") throw invalid("goal is required");
  const goal = value.trim();
  if (!goal) throw invalid("goal is required");
  if (goal.length > MAX_PACK_GOAL_LENGTH) {
    throw invalid(`goal must be at most ${MAX_PACK_GOAL_LENGTH} characters`);
  }
  return goal;
}

function normalizeInput(input: EvidencePackInput): {
  siteSlug: string;
  goal: string;
  regionIds: string[];
  captureIds: string[];
  inclusionMode: InclusionMode;
  rights: Array<{ artifactId: string; rights: import("./types.js").RightsRecord }>;
} {
  if (!input || typeof input !== "object") throw invalid("input is required");
  const siteSlug = typeof input.siteSlug === "string" ? input.siteSlug.trim() : "";
  if (!SLUG.test(siteSlug) || siteSlug.length > 200) {
    throw invalid("siteSlug must be 1-200 characters of letters, digits, underscore or hyphen");
  }
  const goal = normalizeGoal(input.goal);
  if (!Array.isArray(input.regionIds) || input.regionIds.length < 1) {
    throw invalid("regionIds requires at least one region");
  }
  if (input.regionIds.length > MAX_PACK_REGIONS) {
    throw invalid(`regionIds supports at most ${MAX_PACK_REGIONS} regions`);
  }
  const regionIds = input.regionIds.map((value) => {
    if (typeof value !== "string" || !ID.test(value)) {
      throw invalid(`region id is invalid: ${String(value)}`);
    }
    return value;
  });
  if (new Set(regionIds).size !== regionIds.length) {
    throw invalid("regionIds must not contain duplicates");
  }
  const captureIds = [] as string[];
  if (input.captureIds !== undefined) {
    if (!Array.isArray(input.captureIds)) throw invalid("captureIds must be an array");
    for (const value of input.captureIds) {
      if (typeof value !== "string" || !ID.test(value)) {
        throw invalid(`capture id is invalid: ${String(value)}`);
      }
      captureIds.push(value);
    }
    if (new Set(captureIds).size !== captureIds.length) {
      throw invalid("captureIds must not contain duplicates");
    }
  }
  const inclusionMode = input.inclusionMode ?? "references";
  if (inclusionMode !== "references" && inclusionMode !== "permitted") {
    throw invalid('inclusionMode must be "references" or "permitted"');
  }
  const rights: Array<{ artifactId: string; rights: import("./types.js").RightsRecord }> = [];
  if (input.rightsAssertions !== undefined) {
    if (!Array.isArray(input.rightsAssertions)) throw invalid("rightsAssertions must be an array");
    if (input.rightsAssertions.length > MAX_RIGHTS_ASSERTIONS) {
      throw invalid(`rightsAssertions supports at most ${MAX_RIGHTS_ASSERTIONS} entries`);
    }
    for (const entry of input.rightsAssertions) {
      if (!entry || typeof entry !== "object" || typeof entry.artifactId !== "string") {
        throw invalid("rights assertion artifactId is required");
      }
      if (!ID.test(entry.artifactId)) throw invalid("rights assertion artifactId is invalid");
      if (rights.some((item) => item.artifactId === entry.artifactId)) {
        throw invalid("rightsAssertions must not repeat an artifactId");
      }
      const parsed = rightsRecordSchema.safeParse(entry.rights);
      if (!parsed.success) throw invalid("rights assertion is invalid");
      rights.push({ artifactId: entry.artifactId, rights: parsed.data });
    }
  }
  rights.sort((left, right) => compareText(left.artifactId, right.artifactId));
  return {
    siteSlug,
    goal,
    regionIds: [...regionIds].sort(compareText),
    captureIds: [...captureIds].sort(compareText),
    inclusionMode,
    rights,
  };
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
      collected: Number.isFinite(parsed.collected) ? parsed.collected : 0,
      excluded: Number.isFinite(parsed.excluded) ? parsed.excluded : 0,
      limitations: parsed.limitations.filter((item: unknown): item is string => typeof item === "string"),
    };
  }
  return { status: "unknown", collected: 0, excluded: 0, limitations: [] };
}

function viewportOf(profileKey: string, configJson: string): string {
  const config = parseJson<{ viewport?: unknown }>(configJson);
  if (config?.viewport === "desktop" || config?.viewport === "mobile") return config.viewport;
  if (/mobile/i.test(profileKey)) return "mobile";
  if (/desktop/i.test(profileKey)) return "desktop";
  return "unknown";
}

function sourceUrlOf(head: HeadRow): string | null {
  if (head.public_url) return head.public_url;
  const config = parseJson<{ target?: { requestedUrl?: unknown } }>(head.config_json);
  return typeof config?.target?.requestedUrl === "string" ? config.target.requestedUrl : null;
}

function policyStateFromJson(policyJson: string): PolicyState {
  const policy = parseJson<Record<string, unknown>>(policyJson);
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return "unknown";
  if (policy.robots === "disallowed" || policy.robots === "blocked") return "denied";
  if (policy.status === "blocked" || policy.status === "failed") return "denied";
  if (policy.publicOnly === false) return "denied";
  // Fail closed: only an explicit affirmative policy permits a copy.
  if (policy.robots === "allowed" || policy.status === "allowed" || policy.publicOnly === true) {
    return "allowed";
  }
  return "unknown";
}

function policyStateOf(capture: HeadRow): PolicyState {
  return policyStateFromJson(capture.policy_json);
}

/**
 * The one derivation of a capture record from a head row: building a pack and
 * rechecking one at adoption must agree field for field.
 */
function captureFromHead(head: HeadRow): PackCapture {
  const config = parseJson<Record<string, unknown>>(head.config_json);
  const states = Array.isArray(config?.states) ? config.states : [];
  return {
    id: head.capture_id,
    pageId: head.page_id,
    profileKey: head.profile_key,
    sourceKind: head.kind,
    status: head.status,
    viewport: viewportOf(head.profile_key, head.config_json),
    policy: policyStateOf(head),
    sourceDigest: head.source_digest,
    configHash: head.config_hash,
    observedAt: head.observed_at,
    sourceFetchedAt: head.source_fetched_at,
    lastConfirmedAt: head.last_confirmed_at,
    finishedAt: head.finished_at,
    extractorVersion: head.extractor_version,
    classifierVersion: head.classifier_version,
    browserVersion:
      typeof config?.browserVersion === "string" ? config.browserVersion : null,
    dpr: typeof config?.dpr === "number" ? config.dpr : null,
    reducedMotion:
      typeof config?.reducedMotion === "string" ? config.reducedMotion : null,
    requestedStates: states.flatMap((state) => {
      if (typeof state === "string") return [state];
      if (
        state &&
        typeof state === "object" &&
        typeof (state as Record<string, unknown>).action === "string"
      ) {
        const record = state as Record<string, unknown>;
        const target = typeof record.targetRegionId === "string" ? record.targetRegionId : "";
        return [`${record.action}:${target}`];
      }
      return [];
    }),
    coverage: coverageOf(head.coverage_json),
    limitations: coverageOf(head.coverage_json).limitations,
  };
}

function geometryOf(samples: Record<string, unknown>): PackRegion["geometry"] {
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

function observationsOf(samples: Record<string, unknown>, viewport: string): PackObservation[] {
  const raw = Array.isArray(samples.observations) ? samples.observations : [];
  const observations: PackObservation[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const sampleKey =
      typeof record.sampleKey === "string"
        ? record.sampleKey
        : typeof record.key === "string"
          ? record.key
          : null;
    if (!sampleKey) continue;
    const rect = geometryOf(record);
    observations.push({
      sampleKey,
      state: typeof record.state === "string" ? record.state : "default",
      viewport,
      rect,
      visible: typeof record.visible === "boolean" ? record.visible : null,
    });
    if (observations.length >= 12) break;
  }
  return observations;
}

function sameText(left: string, right: string): boolean {
  return left.trim() === right.trim();
}

function orderRegions(regions: PackRegion[], captures: PackCapture[]): PackRegion[] {
  const order = new Map(captures.map((capture, index) => [capture.id, index]));
  return [...regions].sort(
    (left, right) =>
      (order.get(left.captureId) ?? 0) - (order.get(right.captureId) ?? 0) ||
      left.ordinal - right.ordinal ||
      compareText(left.regionId, right.regionId),
  );
}

function buildClaims(regions: PackRegion[], claims: PackClaim[]): PackClaim[] {
  const result: PackClaim[] = [];
  regions.forEach((region, index) => {
    if (region.backgroundColor) {
      result.push({
        id: evidenceClaimId(region.regionId, "background-color", region.backgroundColor, "", "default"),
        regionId: region.regionId,
        captureId: region.captureId,
        property: "background-color",
        value: region.backgroundColor,
        classification: "observed",
        artifactId: "selection",
        path: `/regions/${index}/backgroundColor`,
        viewport: region.viewport,
        state: "default",
        sampleKey: null,
        method: "computed-style sample",
        ruleId: null,
        sampleCount: 1,
        limitations: region.limitations.slice(0, 16),
      });
    }
    for (const [field, property] of STYLE_FIELDS) {
      const value = region.styles[field];
      if (!value) continue;
      result.push({
        id: evidenceClaimId(region.regionId, property, value, "", "default"),
        regionId: region.regionId,
        captureId: region.captureId,
        property,
        value,
        classification: "observed",
        artifactId: "selection",
        path: `/regions/${index}/styles/${field}`,
        viewport: region.viewport,
        state: "default",
        sampleKey: null,
        method: "computed-style sample",
        ruleId: null,
        sampleCount: 1,
        limitations: region.limitations.slice(0, 16),
      });
    }
    if (region.geometry) {
      for (const dimension of ["x", "y", "width", "height"] as const) {
        const value = String(region.geometry[dimension]);
        result.push({
          id: evidenceClaimId(region.regionId, dimension, value, "", "default"),
          regionId: region.regionId,
          captureId: region.captureId,
          property: dimension,
          value,
          classification: "observed",
          artifactId: "selection",
          path: `/regions/${index}/geometry/${dimension}`,
          viewport: region.viewport,
          state: "default",
          sampleKey: null,
          method: "observed geometry",
          ruleId: null,
          sampleCount: 1,
          limitations: region.limitations.slice(0, 16),
        });
      }
    }
  });
  const relevant = new Set([
    "component.type",
    "section.purpose",
    "context.section_purpose",
    "behavior",
  ]);
  for (const claim of claims) {
    if (!relevant.has(claim.property)) continue;
    const index = result.length;
    const id = evidenceClaimId(
      claim.regionId,
      claim.property,
      claim.value,
      `${claim.sampleKey ?? ""}|${claim.sourceClaimId ?? ""}`,
      claim.state,
    );
    result.push({
      ...claim,
      id,
      artifactId: "selection",
      path: `/claims/${index}/value`,
      method: claim.method,
    });
  }
  return result;
}

function safeStoragePath(value: string | null | undefined): string | null {
  if (!value || isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return null;
  const parts = value.replaceAll("\\", "/").split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..") ? value : null;
}

function sourceArtifactRef(row: ArtifactRow | undefined, artifactId: string): PackArtifactRef {
  return {
    artifactId,
    captureId: row?.capture_id ?? "",
    regionId: row?.region_id ?? null,
    kind: row?.kind ?? "unknown",
    storagePath: safeStoragePath(row?.storage_path),
    sha256: row?.sha256 ?? null,
    bytes: row?.bytes ?? null,
    mimeType: row?.mime_type ?? "application/octet-stream",
    state: row?.state ?? "missing",
  };
}

function artifactKey(row: ArtifactRow): string | null {
  const metadata = parseJson<{ key?: unknown }>(row.metadata_json);
  return typeof metadata?.key === "string" ? metadata.key : null;
}

interface ScanComponents {
  artifactId: string;
  components: unknown[];
}

/**
 * The scan artifact a capture's component styles come from, validated against
 * its recorded hash and size. Building a pack and rechecking one at adoption
 * use this same lookup so styles cannot come from another observation.
 */
function findScanArtifact(
  cacheRoot: string,
  captureId: string,
  rootSamples: Record<string, unknown> | null,
  artifacts: ArtifactRow[],
): ScanComponents | null {
  const scanKey = typeof rootSamples?.scanKey === "string" ? rootSamples.scanKey : null;
  const candidates = artifacts
    .filter(
      (artifact) =>
        artifact.capture_id === captureId &&
        artifact.kind === "raw_observation" &&
        artifact.state === "ready" &&
        artifact.storage_path &&
        artifact.sha256 &&
        artifact.bytes !== null,
    )
    .sort((left, right) => compareText(left.id, right.id));
  let chosen: ArtifactRow | undefined;
  if (scanKey) chosen = candidates.find((artifact) => artifactKey(artifact) === scanKey);
  if (!chosen) chosen = candidates.find((artifact) => artifactKey(artifact)?.startsWith("scan-"));
  if (!chosen) return null;
  const stored = {
    storagePath: chosen.storage_path!,
    sha256: chosen.sha256!,
    bytes: chosen.bytes!,
  };
  if (validateStoredArtifact(cacheRoot, stored) !== null) return null;
  try {
    const payload = readStoredArtifactJson(cacheRoot, stored) as {
      scan?: { components?: unknown[] };
    };
    return {
      artifactId: chosen.id,
      components: Array.isArray(payload?.scan?.components) ? payload.scan!.components! : [],
    };
  } catch {
    return null;
  }
}

/** Computed styles and their exact scan pointer for one component region. */
function scanStylesOf(
  scan: ScanComponents | null,
  locator: Record<string, unknown>,
): Pick<PackRegion, "styles" | "styleSource"> {
  const styles: Record<string, string> = {};
  if (!scan) return { styles, styleSource: null };
  const selector = typeof locator.selector === "string" ? locator.selector : null;
  const matches = scan.components
    .map((component, index) => ({ component, index }))
    .filter(({ component }) => {
      if (!component || typeof component !== "object") return false;
      const value = (component as Record<string, unknown>).selector;
      return selector !== null && typeof value === "string" && sameText(value, selector);
    });
  if (matches.length !== 1) return { styles, styleSource: null };
  const raw = matches[0]!.component as Record<string, unknown>;
  for (const [field] of STYLE_FIELDS) {
    const value = raw[field];
    if (typeof value === "string" && value.trim() !== "") styles[field] = value;
  }
  return {
    styles,
    styleSource: {
      artifactId: scan.artifactId,
      pointer: `/scan/components/${matches[0]!.index}`,
    },
  };
}

function mediaCandidatesFor(
  selected: PackRegion[],
  artifacts: ArtifactRow[],
  captures: Map<string, HeadRow>,
): MediaCandidate[] {
  const selectedComponents = new Set(
    selected.filter((region) => region.kind === "component").map((region) => region.regionId),
  );
  const captureIds = new Set(selected.map((region) => region.captureId));
  const candidates: ArtifactRow[] = [];
  for (const artifact of artifacts) {
    if (artifact.kind === "component_pack" && artifact.region_id && selectedComponents.has(artifact.region_id)) {
      candidates.push(artifact);
    }
    // Raw external media is never copied or treated as referenceable pack media,
    // but it is surfaced so the exclusion is explained in the manifest.
    if (artifact.kind === "external_media" && captureIds.has(artifact.capture_id)) {
      candidates.push(artifact);
    }
  }
  // One capture-level screenshot per selected capture, chosen deterministically:
  // prefer a ready screenshot, but keep a non-ready one so its exclusion is explained.
  for (const captureId of [...captureIds].sort(compareText)) {
    const shots = artifacts
      .filter(
        (artifact) =>
          artifact.capture_id === captureId &&
          artifact.kind === "screenshot" &&
          artifact.storage_path,
      )
      .sort((left, right) => compareText(left.id, right.id));
    const chosen = shots.find((artifact) => artifact.state === "ready") ?? shots[0];
    if (chosen) candidates.push(chosen);
  }
  const unique = new Map(candidates.map((artifact) => [artifact.id, artifact]));
  return [...unique.values()]
    .sort((left, right) => compareText(left.id, right.id))
    .map((artifact) => {
      const head = captures.get(artifact.capture_id);
      const rights = rightsRecordSchema.safeParse(parseJson(artifact.rights_json));
      return {
        artifactId: artifact.id,
        captureId: artifact.capture_id,
        regionId: artifact.region_id,
        kind: artifact.kind,
        storagePath: safeStoragePath(artifact.storage_path),
        sha256: artifact.sha256 ?? "",
        bytes: artifact.bytes ?? 0,
        mimeType: artifact.mime_type,
        state: artifact.state,
        rights: rights.success ? rights.data : null,
        policy: head ? policyStateOf(head) : "unknown",
      };
    });
}

function rightsReason(
  candidate: MediaCandidate,
  assertions: Map<string, import("./types.js").RightsRecord>,
): string | null {
  const rights = assertions.get(candidate.artifactId);
  if (!rights) return "RIGHTS_NOT_ASSERTED";
  if (rights.status === "unknown") return "RIGHTS_UNKNOWN";
  if (rights.scope !== "export_copy") return "RIGHTS_SCOPE";
  if (!rights.reference || !rights.reference.trim()) return "RIGHTS_REFERENCE";
  return null;
}

function decideMedia(
  candidates: MediaCandidate[],
  inclusionMode: InclusionMode,
  rights: Array<{ artifactId: string; rights: import("./types.js").RightsRecord }>,
  cacheRoot: string,
): MediaDecision[] {
  const assertions = new Map(rights.map((entry) => [entry.artifactId, entry.rights]));
  let includedCount = 0;
  let includedBytes = 0;
  return candidates.map((candidate) => {
    if (candidate.kind === "external_media") {
      return { ...candidate, included: false, copiedPath: null, reason: "EXTERNAL_MEDIA_NOT_COPIED" };
    }
    if (inclusionMode === "references") {
      return { ...candidate, included: false, copiedPath: null, reason: "REFERENCE_ONLY" };
    }
    if (candidate.policy !== "allowed") {
      return {
        ...candidate,
        included: false,
        copiedPath: null,
        reason: candidate.policy === "denied" ? "ROBOTS_OR_DESTINATION_REFUSED" : "POLICY_UNKNOWN",
      };
    }
    if (candidate.state !== "ready") {
      return { ...candidate, included: false, copiedPath: null, reason: "ARTIFACT_NOT_READY" };
    }
    const reason = rightsReason(candidate, assertions);
    if (reason) {
      return { ...candidate, included: false, copiedPath: null, reason };
    }
    if (includedCount >= MAX_COPIED_ARTIFACTS) {
      return { ...candidate, included: false, copiedPath: null, reason: "COUNT_LIMIT" };
    }
    if (candidate.bytes > MAX_COPIED_ARTIFACT_BYTES) {
      return { ...candidate, included: false, copiedPath: null, reason: "SIZE_LIMIT" };
    }
    if (includedBytes + candidate.bytes > MAX_COPIED_TOTAL_BYTES) {
      return { ...candidate, included: false, copiedPath: null, reason: "TOTAL_SIZE_LIMIT" };
    }
    if (
      !candidate.storagePath ||
      validateStoredArtifact(cacheRoot, {
        storagePath: candidate.storagePath,
        sha256: candidate.sha256,
        bytes: candidate.bytes,
      }) !== null
    ) {
      return { ...candidate, included: false, copiedPath: null, reason: "ARTIFACT_INVALID" };
    }
    const copiedPath = copiedArtifactPath(
      candidate.artifactId,
      candidate.sha256,
      candidate.storagePath,
    );
    includedCount += 1;
    includedBytes += candidate.bytes;
    return { ...candidate, included: true, copiedPath, reason: "PERMITTED_COPY" };
  });
}

function ensurePacksDir(cacheRoot: string): string {
  const root = realpathSync(cacheRoot);
  for (const component of ["atlas", PACKS_DIR]) {
    const path = join(root, component);
    const before = lstatSync(path, { throwIfNoEntry: false });
    if (!before) {
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        // A concurrent publisher may have created the shared directory first.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } else if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new EvidencePackError("PACK_WRITE_FAILED", "Atlas evidence-pack directory is redirected");
    }
    const after = lstatSync(path, { throwIfNoEntry: false });
    if (!after || after.isSymbolicLink() || !after.isDirectory()) {
      throw new EvidencePackError("PACK_WRITE_FAILED", "Atlas evidence-pack directory is unusable");
    }
  }
  return join(root, PACKS_DIR);
}

function writeFileExclusive(directory: string, path: string, content: string | Buffer): EvidencePackFile {
  const target = join(directory, path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
  return {
    path,
    sha256: sha256(bytes),
    bytes: bytes.length,
    mimeType: evidenceFileMime(path),
  };
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Registered manifest pin. The advisory creation clock is excluded and object
 * keys are canonicalized so concurrent builds of the same pack agree on the
 * pin across different clocks.
 */
function manifestPin(manifestBytes: Buffer): string {
  const { createdAt: _createdAt, ...pinned } = manifestObject(manifestBytes);
  return sha256(
    JSON.stringify(pinned, (_key, item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const record = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
    }),
  );
}

function manifestObject(manifestBytes: Buffer): Record<string, unknown> {
  try {
    const parsed = JSON.parse(manifestBytes.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as Record<string, unknown>;
  } catch {
    throw new EvidencePackError("PACK_CORRUPT", "evidence pack manifest is unreadable");
  }
}

function manifestFor(
  selection: EvidenceSelection,
  createdAt: number,
  files: EvidencePackFile[],
  exporterVersion: PackExporterVersion,
): Record<string, unknown> {
  const observed = selection.captures
    .map((capture) => capture.observedAt ?? capture.lastConfirmedAt ?? capture.sourceFetchedAt)
    .filter((value): value is number => value !== null);
  const included = selection.media
    .filter((decision) => decision.included)
    .map((decision) => ({
      artifactId: decision.artifactId,
      captureId: decision.captureId,
      kind: decision.kind,
      path: decision.copiedPath,
      sha256: decision.sha256,
      bytes: decision.bytes,
      mimeType: evidenceFileMime(decision.copiedPath!),
    }));
  const excluded = selection.media
    .filter((decision) => !decision.included)
    .map((decision) => ({ artifactId: decision.artifactId, reason: decision.reason }));
  return {
    schemaVersion: EVIDENCE_PACK_SCHEMA_VERSION,
    exporterVersion,
    packId: selection.packId,
    createdAt,
    goal: selection.goal,
    inclusionMode: selection.inclusionMode,
    selection: {
      regionIds: selection.regions.map((region) => region.regionId).sort(compareText),
      captureIds: selection.captures.map((capture) => capture.id),
    },
    site: {
      slug: selection.siteSlug,
      attribution: EVIDENCE_PACK_ATTRIBUTION,
      sourceUrls: selection.sourceUrls,
    },
    captures: selection.captures,
    observationDates: {
      earliest: observed.length ? Math.min(...observed) : null,
      latest: observed.length ? Math.max(...observed) : null,
    },
    vocabularyVersion: ATLAS_VOCABULARY_VERSION,
    classifierVersion: ATLAS_CLASSIFIER_VERSION,
    extractorVersions: uniqueSorted(selection.captures.map((capture) => capture.extractorVersion)),
    schemaVersionUsed: ATLAS_SCHEMA_VERSION,
    ftsVersion: ATLAS_FTS_VERSION,
    rightsAssertions: selection.rightsAssertions,
    artifacts: {
      included,
      excluded,
      references: selection.references,
    },
    coverage: selection.coverage,
    limitations: selection.limitations,
    claimIds: selection.claims.map((claim) => claim.id),
    omitted: selection.omitted,
    files: [...files].sort((left, right) => compareText(left.path, right.path)),
    designEvidence: {
      path: "design-evidence.json",
      claims: selection.claims.length,
    },
  };
}

function writePackRow(db: DatabaseSync, registration: PackRegistration): void {
  db.prepare(
    `INSERT INTO atlas_packs
       (id, storage_path, manifest_hash, selection_json, created_at, state, exporter_version)
     VALUES (?, ?, ?, ?, ?, 'ready', ?)
     ON CONFLICT(id) DO UPDATE SET
       storage_path = excluded.storage_path,
       manifest_hash = excluded.manifest_hash,
       selection_json = excluded.selection_json,
       created_at = excluded.created_at,
       state = 'ready',
       exporter_version = excluded.exporter_version`,
  ).run(
    registration.packId,
    join("atlas", "evidence-packs", registration.packId),
    registration.manifestHash,
    registration.selectionJson,
    registration.createdAt,
    registration.exporterVersion,
  );
}

/**
 * A registered pack is pinned by its manifest hash. A differing hash is only a
 * recovery when the registered directory is gone and the pack has just
 * validated; a differing hash beside an existing directory is corrupt.
 */
function assertPackPin(
  db: DatabaseSync,
  cache: Cache,
  packId: string,
  manifestHash: string,
): void {
  const row = db
    .prepare("SELECT manifest_hash, storage_path FROM atlas_packs WHERE id = ?")
    .get(packId) as { manifest_hash?: unknown; storage_path?: unknown } | undefined;
  if (!row || row.manifest_hash === manifestHash) return;
  if (typeof row.storage_path === "string" && !existsSync(join(cache.rootDir, row.storage_path))) {
    return;
  }
  throw new EvidencePackError(
    "PACK_CORRUPT",
    "evidence pack manifest does not match its registered manifest hash",
  );
}

/**
 * Canonical pack directory. Adoption is limited to a direct child of the cache
 * evidence-pack store, checked before any file in it is read. A junctioned or
 * symlinked store or pack directory is refused before resolution: realpath
 * containment alone would accept a pack reached through a redirect.
 */
function canonicalPackDirectory(cacheRoot: string, directory: string): string {
  let root: string;
  try {
    root = realpathSync(cacheRoot);
  } catch {
    throw new EvidencePackError("PACK_CORRUPT", "Atlas evidence-pack store is unavailable");
  }
  for (const component of ["atlas", PACKS_DIR]) {
    const path = join(root, component);
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) {
      throw new EvidencePackError("PACK_CORRUPT", "Atlas evidence-pack store is unavailable");
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new EvidencePackError(
        "PACK_OUTSIDE_STORE",
        "Atlas evidence-pack store is redirected outside the cache",
      );
    }
  }
  let packsRoot: string;
  try {
    packsRoot = realpathSync(join(root, PACKS_DIR));
  } catch {
    throw new EvidencePackError("PACK_CORRUPT", "Atlas evidence-pack store is unavailable");
  }
  // Check the supplied directory before resolving it: realpath follows a
  // junction, so resolving first would accept pack A redirected to pack B and
  // adopt B's identity in A's place.
  const supplied = lstatSync(directory, { throwIfNoEntry: false });
  if (!supplied) {
    throw new EvidencePackError("PACK_CORRUPT", "evidence pack directory does not exist");
  }
  if (supplied.isSymbolicLink()) {
    throw new EvidencePackError(
      "PACK_OUTSIDE_STORE",
      "evidence pack directory is a symbolic link or junction",
    );
  }
  if (!supplied.isDirectory()) {
    throw new EvidencePackError("PACK_CORRUPT", "evidence pack directory is not a directory");
  }
  let real: string;
  try {
    real = realpathSync(directory);
  } catch {
    throw new EvidencePackError("PACK_CORRUPT", "evidence pack directory does not exist");
  }
  if (dirname(real) !== packsRoot) {
    throw new EvidencePackError(
      "PACK_OUTSIDE_STORE",
      "evidence pack directory is outside the Atlas evidence-pack store",
    );
  }
  return real;
}

function registrationOf(result: EvidencePackResult): PackRegistration {
  const manifestBytes = readFileSync(result.manifestPath);
  if (manifestPin(manifestBytes) !== result.manifestHash) {
    throw new EvidencePackError(
      "PACK_CORRUPT",
      "evidence pack manifest changed after it was validated",
    );
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    createdAt: number;
    goal: string;
    inclusionMode: string;
    exporterVersion: unknown;
    selection: { regionIds: string[]; captureIds: string[] };
  };
  const exporterVersion = supportedExporterVersion(manifest.exporterVersion);
  if (!exporterVersion) {
    throw new EvidencePackError("PACK_CORRUPT", "evidence pack exporter version is unsupported");
  }
  return {
    packId: result.packId,
    manifestHash: result.manifestHash,
    selectionJson: JSON.stringify({
      regionIds: manifest.selection.regionIds,
      captureIds: manifest.selection.captureIds,
      inclusionMode: manifest.inclusionMode,
      goal: manifest.goal,
    }),
    createdAt: manifest.createdAt,
    exporterVersion,
  };
}

/**
 * Freeze the validated staged bytes before `onBeforePublish`: manifest pin,
 * every manifest-listed file hash/size and the canonical selection hash.
 * The registration summary is also built from these bytes, so a later seam
 * cannot make a self-consistent provenance rewrite the registered identity.
 */
function freezePack(directory: string, selection: EvidenceSelection, createdAt: number): FrozenPack {
  const manifestBytes = readFileSync(join(directory, "manifest.json"));
  const manifestHash = manifestPin(manifestBytes);
  const manifest = manifestObject(manifestBytes);
  const exporterVersion = supportedExporterVersion(manifest.exporterVersion);
  if (!exporterVersion) {
    throw new EvidencePackError("PACK_CORRUPT", "evidence pack exporter version is unsupported");
  }
  const files = Array.isArray(manifest.files) ? (manifest.files as EvidencePackFile[]) : [];
  const selectionBytes = readFileSync(join(directory, "artifacts", "selection.json"));
  let selectionValue: unknown;
  try {
    selectionValue = JSON.parse(selectionBytes.toString("utf8")) as unknown;
  } catch {
    throw new EvidencePackError("PACK_CORRUPT", "evidence pack selection is unreadable");
  }
  return {
    manifestHash,
    selectionHash: sha256(canonicalJson(selectionValue)),
    files: files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
    })),
    registration: {
      packId: selection.packId,
      manifestHash,
      selectionJson: JSON.stringify({
        regionIds: selection.regions.map((region) => region.regionId).sort(compareText),
        captureIds: selection.captures.map((capture) => capture.id),
        inclusionMode: selection.inclusionMode,
        goal: selection.goal,
      }),
      createdAt,
      exporterVersion,
    },
  };
}

/**
 * Re-hash every frozen byte after a publication seam. A seam that rewrites
 * provenance and regenerates all documents/hashes is still a change: the
 * frozen manifest pin, per-file hashes and canonical selection must match.
 */
function assertFrozenPack(directory: string, frozen: FrozenPack): void {
  let manifestBytes: Buffer;
  try {
    manifestBytes = readFileSync(join(directory, "manifest.json"));
  } catch {
    throw new EvidencePackError(
      "PACK_CORRUPT",
      "evidence pack manifest disappeared before publication",
    );
  }
  if (manifestPin(manifestBytes) !== frozen.manifestHash) {
    throw new EvidencePackError("PACK_CORRUPT", "evidence pack manifest changed before publication");
  }
  let selectionHash: string;
  try {
    selectionHash = sha256(
      canonicalJson(
        JSON.parse(readFileSync(join(directory, "artifacts", "selection.json"), "utf8")) as unknown,
      ),
    );
  } catch {
    throw new EvidencePackError("PACK_CORRUPT", "evidence pack selection is unreadable");
  }
  if (selectionHash !== frozen.selectionHash) {
    throw new EvidencePackError("PACK_CORRUPT", "evidence pack selection changed before publication");
  }
  for (const file of frozen.files) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(directory, file.path));
    } catch {
      throw new EvidencePackError(
        "PACK_CORRUPT",
        `evidence pack file disappeared before publication: ${file.path}`,
      );
    }
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
      throw new EvidencePackError(
        "PACK_CORRUPT",
        `evidence pack file changed before publication: ${file.path}`,
      );
    }
  }
  let ok = false;
  try {
    ok = validateEvidencePack(directory).ok;
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new EvidencePackError(
      "PACK_CORRUPT",
      "evidence pack file bytes changed before publication",
    );
  }
}

interface PackView {
  siteSlug: string;
  regionIds: string[];
  captureIds: string[];
  sourceUrls: string[];
  captures: Array<{ id: string; policy: PolicyState }>;
  /** Raw selection capture records, compared field for field against the DB. */
  captureRecords: Array<Record<string, unknown>>;
  /** Raw selection region records, re-derived from the DB at adoption. */
  regionRecords: Array<Record<string, unknown>>;
  /** Raw selection claim records, re-derived from the DB at adoption. */
  claimRecords: Array<Record<string, unknown>>;
  /** Raw selection artifact references, bound to atlas_artifacts rows. */
  referenceRecords: Array<Record<string, unknown>>;
  /** Raw selection media decisions, bound to atlas_artifacts rows. */
  mediaRecords: Array<Record<string, unknown>>;
  media: Array<{ captureId: string; included: boolean; policy: PolicyState }>;
}

function selectionViewOf(directory: string): PackView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(directory, "artifacts", "selection.json"), "utf8"));
  } catch {
    throw new EvidencePackError("PACK_CORRUPT", "evidence pack selection is unreadable");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EvidencePackError("PACK_CORRUPT", "evidence pack selection shape is invalid");
  }
  const selection = parsed as Record<string, unknown>;
  const captures = Array.isArray(selection.captures) ? selection.captures : [];
  const regions = Array.isArray(selection.regions) ? selection.regions : [];
  const claims = Array.isArray(selection.claims) ? selection.claims : [];
  const media = Array.isArray(selection.media) ? selection.media : [];
  const references = Array.isArray(selection.references) ? selection.references : [];
  const sourceUrls = Array.isArray(selection.sourceUrls) ? selection.sourceUrls : [];
  if (
    typeof selection.siteSlug !== "string" ||
    !sourceUrls.every((url) => typeof url === "string") ||
    !captures.every(
      (capture) =>
        capture &&
        typeof capture === "object" &&
        typeof (capture as Record<string, unknown>).id === "string" &&
        ["allowed", "denied", "unknown"].includes(
          String((capture as Record<string, unknown>).policy),
        ),
    ) ||
    !regions.every(
      (region) =>
        region &&
        typeof region === "object" &&
        typeof (region as Record<string, unknown>).regionId === "string",
    ) ||
    !claims.every(
      (claim) =>
        claim &&
        typeof claim === "object" &&
        typeof (claim as Record<string, unknown>).id === "string" &&
        typeof (claim as Record<string, unknown>).regionId === "string",
    ) ||
    !media.every(
      (decision) =>
        decision &&
        typeof decision === "object" &&
        typeof (decision as Record<string, unknown>).artifactId === "string" &&
        typeof (decision as Record<string, unknown>).captureId === "string" &&
        typeof (decision as Record<string, unknown>).included === "boolean" &&
        ["allowed", "denied", "unknown"].includes(
          String((decision as Record<string, unknown>).policy),
        ),
    )
  ) {
    throw new EvidencePackError("PACK_CORRUPT", "evidence pack selection shape is invalid");
  }
  return {
    siteSlug: selection.siteSlug,
    regionIds: regions.map((region) => (region as { regionId: string }).regionId),
    captureIds: captures.map((capture) => (capture as { id: string }).id),
    sourceUrls: sourceUrls as string[],
    captures: captures.map((capture) => {
      const value = capture as { id: string; policy: PolicyState };
      return { id: value.id, policy: value.policy };
    }),
    captureRecords: captures as Array<Record<string, unknown>>,
    regionRecords: regions as Array<Record<string, unknown>>,
    claimRecords: claims as Array<Record<string, unknown>>,
    referenceRecords: references as Array<Record<string, unknown>>,
    mediaRecords: media as Array<Record<string, unknown>>,
    media: media.map((decision) => {
      const value = decision as {
        captureId: string;
        included: boolean;
        policy: PolicyState;
      };
      return {
        captureId: value.captureId,
        included: value.included,
        policy: value.policy,
      };
    }),
  };
}

function stale(message: string): EvidencePackError {
  return new EvidencePackError("PACK_STALE", message);
}

function currentPolicies(db: DatabaseSync, captureIds: string[]): Map<string, PolicyState> {
  if (!captureIds.length) throw stale("evidence pack has no captures");
  const rows = db
    .prepare(
      `SELECT id, policy_json FROM atlas_captures WHERE id IN (${captureIds.map(() => "?").join(",")})`,
    )
    .all(...captureIds) as Array<{ id: string; policy_json: string }>;
  if (rows.length !== captureIds.length) {
    throw stale("a selected capture no longer exists");
  }
  return new Map(rows.map((row) => [row.id, policyStateFromJson(row.policy_json)]));
}

function assertPolicyCurrent(db: DatabaseSync, view: PackView): void {
  const current = currentPolicies(
    db,
    view.captures.map((capture) => capture.id),
  );
  for (const capture of view.captures) {
    if (current.get(capture.id) !== capture.policy) {
      throw stale(`capture policy changed: ${capture.id}`);
    }
  }
  for (const decision of view.media) {
    if (!decision.included) continue;
    if (decision.policy !== "allowed" || current.get(decision.captureId) !== "allowed") {
      throw stale("a copied artifact is no longer permitted by the current capture policy");
    }
  }
}

interface CaptureProvenanceRow extends HeadRow {
  capture_source_kind: string;
  summary_capture_id: string | null;
  summary_page_id: string | null;
  summary_site_slug: string | null;
  summary_profile_key: string | null;
  summary_source_kind: string | null;
  summary_status: string | null;
  summary_observed: number | null;
}

/**
 * A confirmation clock may advance without changing the exported evidence:
 * an identical refetch only moves `last_confirmed_at`. Everything else the
 * pack printed must still match the DB field for field.
 */
function captureProvenanceMatches(record: Record<string, unknown>, current: PackCapture): boolean {
  if (!Object.prototype.hasOwnProperty.call(record, "lastConfirmedAt")) return false;
  const { lastConfirmedAt: confirmedAt, ...stored } = record;
  const { lastConfirmedAt: currentConfirmedAt, ...derived } = current;
  if (canonicalJson(stored) !== canonicalJson(derived)) return false;
  if (confirmedAt === null) return true;
  if (typeof confirmedAt !== "number" || !Number.isFinite(confirmedAt)) return false;
  return currentConfirmedAt !== null && currentConfirmedAt >= confirmedAt;
}

/**
 * Adoption and fresh publication re-derive every selected capture from the DB
 * instead of trusting the manifest or selection: viewport/profile, browser,
 * DPR, observation dates, conditions, coverage, hashes, policy and status must
 * still describe the observation the pack exported. The derived capture
 * summary must agree when it exists; legacy sources legitimately have no
 * summary row.
 */
function assertCaptureProvenance(db: DatabaseSync, view: PackView): void {
  const ids = view.captureRecords.map((capture) => capture.id as string);
  const rows = db
    .prepare(
      `SELECT c.id AS capture_id, c.page_id, c.profile_key, p.kind, p.site_slug,
              p.public_url, p.path, c.status, c.config_hash, c.source_digest,
              c.source_kind AS capture_source_kind,
              c.observed_at, c.finished_at, c.source_fetched_at, c.last_confirmed_at,
              c.extractor_version, c.classifier_version, c.coverage_json, c.config_json,
              c.policy_json,
              cm.capture_id AS summary_capture_id, cm.page_id AS summary_page_id,
              cm.site_slug AS summary_site_slug, cm.profile_key AS summary_profile_key,
              cm.source_kind AS summary_source_kind, cm.status AS summary_status,
              cm.observed AS summary_observed
         FROM atlas_captures c
         JOIN atlas_pages p ON p.id = c.page_id
         LEFT JOIN atlas_capture_summary cm ON cm.capture_id = c.id
        WHERE c.id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as unknown as CaptureProvenanceRow[];
  if (rows.length !== ids.length) {
    throw stale("a selected capture no longer exists");
  }
  const byId = new Map(rows.map((row) => [row.capture_id, row]));
  for (const record of view.captureRecords) {
    const id = record.id as string;
    const row = byId.get(id);
    if (!row || !captureProvenanceMatches(record, captureFromHead(row))) {
      throw stale(`capture provenance changed: ${id}`);
    }
    if (
      row.summary_capture_id !== null &&
      (row.summary_page_id !== row.page_id ||
        row.summary_site_slug !== row.site_slug ||
        row.summary_profile_key !== row.profile_key ||
        row.summary_source_kind !== row.capture_source_kind ||
        row.summary_status !== row.status ||
        row.summary_observed !== (row.observed_at ?? row.last_confirmed_at))
    ) {
      throw stale(`capture summary changed: ${id}`);
    }
  }
  const expectedUrls = uniqueSorted(
    rows
      .map((row) => sourceUrlOf(row))
      .filter((value): value is string => typeof value === "string"),
  );
  const actualUrls = [...view.sourceUrls].sort(compareText);
  if (canonicalJson(actualUrls) !== canonicalJson(expectedUrls)) {
    throw stale("capture source URLs changed");
  }
}

function adoptabilityOf(db: DatabaseSync, view: PackView, cacheRoot: string): void {
  assertActiveHeads(db, view.siteSlug, view.captureIds);
  assertActiveRegions(db, view, cacheRoot);
  assertArtifactProvenance(db, view);
  assertClaimProvenance(db, view);
  assertCaptureProvenance(db, view);
  assertPolicyCurrent(db, view);
}

function removeCreatedPack(finalDir: string): void {
  try {
    const parent = realpathSync(dirname(finalDir));
    const info = lstatSync(finalDir);
    if (info.isSymbolicLink() || !info.isDirectory()) return;
    const real = realpathSync(finalDir);
    if (
      dirname(real) !== parent ||
      basename(real) !== basename(finalDir) ||
      !ID.test(basename(finalDir))
    ) {
      return;
    }
    rmSync(real, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup of a directory this build just created */
  }
}

/**
 * Adopt an intact pack only after the write transaction confirms every
 * selected region still belongs to an active head and the recorded policy
 * decisions still match the current capture policy.
 */
export function adoptEvidencePack(
  directory: string,
  store: EvidencePackStore,
  expectedPackId?: string,
): EvidencePackResult {
  if (!store?.cache?.atlas) {
    throw new EvidencePackError("ATLAS_DISABLED", "Atlas evidence packs require AWWWARDS_MCP_ATLAS=1");
  }
  const canonical = canonicalPackDirectory(store.cache.rootDir, directory);
  const result = resultFromPack(canonical, true);
  if (expectedPackId !== undefined && result.packId !== expectedPackId) {
    throw new EvidencePackError(
      "PACK_CORRUPT",
      "evidence pack directory does not contain the requested pack",
    );
  }
  const view = selectionViewOf(canonical);
  try {
    store.cache.withAtlasDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        adoptabilityOf(db, view, store.cache.rootDir);
        assertPackPin(db, store.cache, result.packId, result.manifestHash);
        writePackRow(db, registrationOf(result));
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* already rolled back */
        }
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof EvidencePackError) throw error;
    throw new EvidencePackError(
      "PACK_WRITE_FAILED",
      error instanceof Error ? error.message : "evidence pack registration failed",
    );
  }
  return result;
}

/**
 * Final publication is one write transaction: the head recheck, the atomic
 * rename and the atlas_packs row commit together, so a head retirement or
 * replacement cannot interleave between the recheck and the rename.
 */
function publishPack(
  cache: Cache,
  selection: EvidenceSelection,
  tempDir: string,
  finalDir: string,
  frozen: FrozenPack,
  onBeforeRename?: () => void,
  onAfterRename?: (finalDir: string) => void,
): EvidencePackResult {
  const view: PackView = {
    siteSlug: selection.siteSlug,
    regionIds: selection.regions.map((region) => region.regionId),
    captureIds: selection.captures.map((capture) => capture.id),
    sourceUrls: selection.sourceUrls,
    captures: selection.captures.map((capture) => ({
      id: capture.id,
      policy: capture.policy,
    })),
    captureRecords: selection.captures.map((capture) => ({ ...capture })),
    regionRecords: selection.regions.map((region) => ({ ...region })),
    claimRecords: selection.claims.map((claim) => ({ ...claim })),
    referenceRecords: selection.references.map((reference) => ({ ...reference })),
    mediaRecords: selection.media.map((decision) => ({ ...decision })),
    media: selection.media.map((decision) => ({
      captureId: decision.captureId,
      included: decision.included,
      policy: decision.policy,
    })),
  };
  return cache.withAtlasDb((db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      assertActiveHeads(db, selection.siteSlug, selection.captures.map((capture) => capture.id));
      assertActiveRegions(db, view, cache.rootDir);
      assertArtifactProvenance(db, view);
      assertClaimProvenance(db, view);
      assertCaptureProvenance(db, view);
      assertPolicyCurrent(db, view);
      // Pin the bytes about to be renamed into place: a differing registered
      // hash is only recoverable while its registered directory is missing.
      assertPackPin(db, cache, selection.packId, frozen.manifestHash);
      onBeforeRename?.();
      // The seam (or another process) may have changed the validated bytes:
      // recheck every frozen hash and size under the write lock.
      assertFrozenPack(tempDir, frozen);
      let created = false;
      try {
        renameSync(tempDir, finalDir);
        created = true;
      } catch (error) {
        if (!lstatSync(finalDir, { throwIfNoEntry: false })) throw error;
        // A concurrent publisher won the rename; adopt and register its pack.
        rmSync(tempDir, { recursive: true, force: true });
        const adopted = resultFromPack(finalDir, true);
        if (adopted.packId !== selection.packId) {
          throw new EvidencePackError(
            "PACK_CORRUPT",
            "published pack id does not match the selection",
          );
        }
        adoptabilityOf(db, selectionViewOf(finalDir), cache.rootDir);
        assertPackPin(db, cache, adopted.packId, adopted.manifestHash);
        writePackRow(db, registrationOf(adopted));
        db.exec("COMMIT");
        return adopted;
      }
      let result: EvidencePackResult;
      try {
        onAfterRename?.(finalDir);
        assertFrozenPack(finalDir, frozen);
        result = resultFromPack(finalDir, false);
        if (
          result.packId !== selection.packId ||
          result.manifestHash !== frozen.manifestHash
        ) {
          throw new EvidencePackError(
            "PACK_CORRUPT",
            "published pack id does not match the selection",
          );
        }
      } catch (error) {
        // Only a final directory created by this build is removed; a valid
        // pack whose DB registration fails below stays for later adoption.
        if (created) removeCreatedPack(finalDir);
        throw error;
      }
      // Register the identity frozen before the seams, never a hash recomputed
      // from bytes a seam could have rewritten.
      writePackRow(db, frozen.registration);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw error;
    }
  });
}

/** Publish/adoption recheck: build-time selection errors are INVALID_SELECTION. */
function assertActiveHeads(db: DatabaseSync, siteSlug: string, captureIds: string[]): void {
  const rows = db
    .prepare(
      `SELECT h.capture_id
         FROM atlas_heads h
         JOIN atlas_captures c
           ON c.id = h.capture_id AND c.page_id = h.page_id AND c.profile_key = h.profile_key
         JOIN atlas_pages p ON p.id = h.page_id
        WHERE p.site_slug = ? AND c.status IN ('complete','partial')
          AND h.capture_id IN (${captureIds.map(() => "?").join(",")})`,
    )
    .all(siteSlug, ...captureIds) as Array<{ capture_id: string }>;
  if (rows.length !== captureIds.length) {
    throw new EvidencePackError(
      "PACK_STALE",
      "a selected capture is no longer an active head for this site",
    );
  }
}

interface RegionProvenanceRow {
  id: string;
  capture_id: string;
  parent_id: string | null;
  kind: string;
  ordinal: number;
  locator_json: string | null;
  samples_json: string;
  pattern_key: string | null;
  coverage_json: string;
  page_id: string;
  profile_key: string;
  status: string;
  config_json: string;
  site_slug: string;
  page_kind: string;
  head_capture_id: string | null;
}

/**
 * A selected region is only evidence while it still belongs to the capture it
 * names, that capture is the selected active head of the same page/profile,
 * and every stored region field the pack printed still derives from the
 * current row and its samples.
 */
function assertActiveRegions(db: DatabaseSync, view: PackView, cacheRoot: string): void {
  const ids = view.regionRecords.map((record) => record.regionId as string);
  const rows = db
    .prepare(
      `SELECT r.id, r.capture_id, r.parent_id, r.kind, r.ordinal, r.locator_json,
              r.samples_json, r.pattern_key, r.coverage_json,
              c.page_id, c.profile_key, c.status, c.config_json,
              p.site_slug, p.kind AS page_kind,
              h.capture_id AS head_capture_id
         FROM atlas_regions r
         JOIN atlas_captures c ON c.id = r.capture_id
         JOIN atlas_pages p ON p.id = c.page_id
         LEFT JOIN atlas_heads h
           ON h.capture_id = c.id AND h.page_id = c.page_id AND h.profile_key = c.profile_key
        WHERE r.id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as unknown as RegionProvenanceRow[];
  if (rows.length !== ids.length) {
    throw stale("a selected region no longer exists");
  }
  // Component styles come from the capture's scan artifact: re-read the one
  // the DB currently records, under its stored hash and size.
  const capturePlaceholders = view.captureIds.map(() => "?").join(",");
  const roots = db
    .prepare(
      `SELECT capture_id, samples_json FROM atlas_regions
        WHERE capture_id IN (${capturePlaceholders}) AND kind = 'page'`,
    )
    .all(...view.captureIds) as Array<{ capture_id: string; samples_json: string }>;
  const artifacts = db
    .prepare(
      `SELECT id, capture_id, region_id, kind, storage_path, external_url, sha256, bytes,
              mime_type, state, rights_json, metadata_json
         FROM atlas_artifacts
        WHERE capture_id IN (${capturePlaceholders}) AND kind = 'raw_observation'`,
    )
    .all(...view.captureIds) as unknown as ArtifactRow[];
  const scanByCapture = new Map<string, ScanComponents | null>();
  const scanFor = (captureId: string): ScanComponents | null => {
    if (scanByCapture.has(captureId)) return scanByCapture.get(captureId) ?? null;
    const root = roots.find((entry) => entry.capture_id === captureId);
    const rootSamples = root ? parseJson<Record<string, unknown>>(root.samples_json) : null;
    const scan = findScanArtifact(cacheRoot, captureId, rootSamples, artifacts);
    scanByCapture.set(captureId, scan);
    return scan;
  };
  const byId = new Map(rows.map((row) => [row.id, row]));
  const selected = new Set(ids);
  const captureById = new Map(
    view.captureRecords.map((record) => [record.id as string, record]),
  );
  for (const record of view.regionRecords) {
    const id = record.regionId as string;
    const row = byId.get(id);
    if (!row) throw stale(`a selected region no longer exists: ${id}`);
    if (row.capture_id !== record.captureId) {
      throw stale(`region capture changed: ${id}`);
    }
    if (row.head_capture_id !== row.capture_id) {
      throw stale(`region capture is no longer the active head: ${id}`);
    }
    if (row.status !== "complete" && row.status !== "partial") {
      throw stale(`region capture is no longer publishable: ${id}`);
    }
    if (row.site_slug !== view.siteSlug) {
      throw stale(`region belongs to another site: ${id}`);
    }
    const capture = captureById.get(row.capture_id);
    if (!capture || !view.captureIds.includes(row.capture_id)) {
      throw stale(`region capture is not selected: ${id}`);
    }
    const viewport = viewportOf(row.profile_key, row.config_json);
    if (
      capture.pageId !== row.page_id ||
      capture.profileKey !== row.profile_key ||
      capture.viewport !== viewport ||
      record.viewport !== viewport
    ) {
      throw stale(`region page/profile/viewport changed: ${id}`);
    }
    if (row.kind !== "section" && row.kind !== "component") {
      throw stale(`region kind is invalid: ${id}`);
    }
    if (record.kind !== row.kind) throw stale(`region kind changed: ${id}`);
    const samples = parseJson<Record<string, unknown>>(row.samples_json) ?? {};
    const locator = row.locator_json
      ? parseJson<Record<string, unknown>>(row.locator_json) ?? {}
      : {};
    const { styles, styleSource }: Pick<PackRegion, "styles" | "styleSource"> =
      row.kind === "component"
        ? scanStylesOf(scanFor(row.capture_id), locator)
        : { styles: {}, styleSource: null };
    const limitations = coverageOf(row.coverage_json).limitations.slice(0, 16);
    if (row.page_kind === "legacy_gallery") limitations.push("LEGACY_GALLERY_NO_SOURCE_ARTIFACT");
    const expected = {
      regionId: id,
      captureId: row.capture_id,
      pageId: row.page_id,
      kind: row.kind,
      ordinal: row.ordinal,
      viewport,
      role: typeof samples.role === "string" ? samples.role : null,
      landmark: typeof samples.landmark === "string" ? samples.landmark : null,
      type:
        row.kind === "component" && typeof samples.type === "string" && samples.type.trim()
          ? samples.type
          : null,
      typeClassification:
        samples.typeClassification === "observed" || samples.typeClassification === "inferred"
          ? samples.typeClassification
          : null,
      patternKey: row.pattern_key,
      geometry: geometryOf(samples),
      backgroundColor:
        typeof samples.backgroundColor === "string" && samples.backgroundColor.trim()
          ? samples.backgroundColor
          : null,
      styles,
      sectionRegionId:
        row.kind === "component" && row.parent_id && selected.has(row.parent_id)
          ? row.parent_id
          : null,
      observations: observationsOf(samples, viewport),
      styleSource,
      limitations: limitations.slice(0, 16),
    };
    const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, record[key]]));
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw stale(`region provenance changed: ${id}`);
    }
  }
}

interface ClaimProvenanceRow {
  id: string;
  region_id: string;
  capture_id: string;
  field: string;
  value: string;
  sample_key: string;
  classification: string;
  basis: string;
  decision: string;
  state: string;
  rule_id: string | null;
  limitations_json: string;
}

/** Mirrors claimTierSql: candidate 3, human review 0, observed 1, else 2. */
function claimTierOf(decision: unknown, basis: unknown, classification: unknown): number {
  if (decision === "candidate") return 3;
  if (basis === "human_review") return 0;
  return classification === "observed" ? 1 : 2;
}

function claimLimitationsOf(json: string): string[] {
  const parsed = parseJson<unknown[]>(json);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string").slice(0, 16)
    : [];
}

/**
 * A claim is evidence only while its provenance still holds: a stored Atlas
 * claim must still exist with the exported field, value, decision, class and
 * basis, and a derived style/geometry claim must still point at the selected
 * region value it summarizes.
 */
function assertClaimProvenance(db: DatabaseSync, view: PackView): void {
  const styleFieldByProperty = new Map<string, string>(
    STYLE_FIELDS.map(([field, property]) => [property, field]),
  );
  const geometry = new Set(["x", "y", "width", "height"]);
  const regionIndex = new Map(
    view.regionRecords.map((record, index) => [record.regionId as string, index]),
  );
  const regionById = new Map(
    view.regionRecords.map((record) => [record.regionId as string, record as unknown as PackRegion]),
  );
  const sourceIds = [
    ...new Set(
      view.claimRecords
        .map((record) => record.sourceClaimId)
        .filter((value): value is string => typeof value === "string"),
    ),
  ];
  const rows = sourceIds.length
    ? (db
        .prepare(
          `SELECT cl.id, cl.region_id, cl.field, cl.value, cl.sample_key, cl.classification,
                  cl.basis, cl.decision, cl.state, cl.rule_id, cl.limitations_json,
                  r.capture_id
             FROM atlas_claims cl
             JOIN atlas_regions r ON r.id = cl.region_id
            WHERE cl.id IN (${sourceIds.map(() => "?").join(",")})`,
        )
        .all(...sourceIds) as unknown as ClaimProvenanceRow[])
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const record of view.claimRecords) {
    const claim = record as unknown as PackClaim;
    const id = claim.id;
    if (claim.artifactId !== "selection") {
      throw stale(`claim ${id} does not resolve against the selection artifact`);
    }
    const region = regionById.get(claim.regionId);
    if (!region || region.captureId !== claim.captureId) {
      throw stale(`claim ${id} capture does not match its selected region`);
    }
    if (region.viewport !== claim.viewport) {
      throw stale(`claim ${id} viewport does not match its selected region`);
    }
    const sourceClaimId =
      typeof record.sourceClaimId === "string" ? record.sourceClaimId : null;
    if (sourceClaimId) {
      const row = byId.get(sourceClaimId);
      if (!row) throw stale(`claim ${id} no longer exists in the Atlas store`);
      const pointer = /^\/claims\/(0|[1-9]\d*)\/value$/.exec(String(record.path ?? ""));
      const indexed = pointer ? view.claimRecords[Number(pointer[1])] : undefined;
      if (
        !indexed ||
        indexed.id !== id ||
        row.region_id !== claim.regionId ||
        row.capture_id !== claim.captureId ||
        row.field !== claim.property ||
        row.value !== claim.value ||
        row.decision !== "accepted" ||
        row.classification !== claim.classification ||
        `atlas-claim:${row.basis}` !== claim.method ||
        row.sample_key !== claim.sampleKey ||
        row.state !== claim.state ||
        (row.rule_id ?? null) !== (claim.ruleId ?? null) ||
        claim.sampleCount !== 1 ||
        claimTierOf(row.decision, row.basis, row.classification) !==
          claimTierOf("accepted", claim.method.replace(/^atlas-claim:/, ""), claim.classification) ||
        canonicalJson(claimLimitationsOf(row.limitations_json)) !==
          canonicalJson(claim.limitations)
      ) {
        throw stale(`claim provenance changed: ${id}`);
      }
      continue;
    }
    const index = regionIndex.get(claim.regionId);
    if (index === undefined) {
      throw stale(`claim ${id} refers to an unselected region`);
    }
    let expectedValue: string;
    let expectedPath: string;
    let expectedMethod: string;
    if (claim.property === "background-color") {
      if (typeof region.backgroundColor !== "string") {
        throw stale(`claim ${id} has no observed background`);
      }
      expectedValue = region.backgroundColor;
      expectedPath = `/regions/${index}/backgroundColor`;
      expectedMethod = "computed-style sample";
    } else if (styleFieldByProperty.has(claim.property)) {
      const field = styleFieldByProperty.get(claim.property)!;
      const value = region.styles?.[field];
      if (typeof value !== "string") throw stale(`claim ${id} has no observed style`);
      expectedValue = value;
      expectedPath = `/regions/${index}/styles/${field}`;
      expectedMethod = "computed-style sample";
    } else if (geometry.has(claim.property)) {
      const value = region.geometry?.[claim.property as "x" | "y" | "width" | "height"];
      if (typeof value !== "number") throw stale(`claim ${id} has no observed geometry`);
      expectedValue = String(value);
      expectedPath = `/regions/${index}/geometry/${claim.property}`;
      expectedMethod = "observed geometry";
    } else {
      throw stale(`claim ${id} has no provenance`);
    }
    if (
      String(claim.value) !== expectedValue ||
      claim.path !== expectedPath ||
      claim.classification !== "observed" ||
      claim.method !== expectedMethod ||
      claim.state !== "default" ||
      claim.sampleKey !== null ||
      (claim.ruleId ?? null) !== null ||
      claim.sampleCount !== 1 ||
      canonicalJson(claim.limitations) !== canonicalJson(region.limitations)
    ) {
      throw stale(`claim provenance changed: ${id}`);
    }
  }
}

interface ArtifactBindingRow {
  id: string;
  capture_id: string;
  region_id: string | null;
  kind: string;
  storage_path: string | null;
  sha256: string | null;
  bytes: number | null;
  mime_type: string;
  state: string;
  rights_json: string;
}

function rightsOf(json: string): import("./types.js").RightsRecord | null {
  const parsed = rightsRecordSchema.safeParse(parseJson(json));
  return parsed.success ? parsed.data : null;
}

/**
 * References and media decisions name Atlas artifacts: they are evidence only
 * while the current atlas_artifacts row still matches the exported identity.
 * A replaced artifact whose pack copies, hashes and pack id were regenerated
 * is still stale because the store row it names never changed.
 */
function assertArtifactProvenance(db: DatabaseSync, view: PackView): void {
  const ids = [
    ...new Set(
      [...view.referenceRecords, ...view.mediaRecords]
        .map((record) => record.artifactId)
        .filter((value): value is string => typeof value === "string"),
    ),
  ];
  if (!ids.length) return;
  const rows = db
    .prepare(
      `SELECT id, capture_id, region_id, kind, storage_path, sha256, bytes, mime_type,
              state, rights_json
         FROM atlas_artifacts
        WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as unknown as ArtifactBindingRow[];
  if (rows.length !== ids.length) {
    throw stale("a referenced artifact no longer exists");
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const assertBound = (
    record: Record<string, unknown>,
    withRights: boolean,
    externalMedia: boolean,
  ): void => {
    const artifactId = String(record.artifactId);
    const row = byId.get(artifactId);
    // External media rows keep only the source URL, so the builder's media
    // decision carries ""/0 placeholders for the absent hash and size.
    const bytesMatch = externalMedia
      ? (row?.sha256 ?? "") === String(record.sha256 ?? "") &&
        (row?.bytes ?? 0) === Number(record.bytes ?? 0)
      : row?.sha256 === (record.sha256 ?? null) &&
        row?.bytes === (record.bytes ?? null);
    if (
      !row ||
      row.capture_id !== record.captureId ||
      (row.region_id ?? null) !== (record.regionId ?? null) ||
      row.kind !== record.kind ||
      safeStoragePath(row.storage_path) !== (record.storagePath ?? null) ||
      !bytesMatch ||
      row.mime_type !== record.mimeType ||
      row.state !== record.state
    ) {
      throw stale(`artifact provenance changed: ${artifactId}`);
    }
    if (withRights && canonicalJson(rightsOf(row.rights_json)) !== canonicalJson(record.rights ?? null)) {
      throw stale(`artifact rights changed: ${artifactId}`);
    }
  };
  for (const record of view.referenceRecords) assertBound(record, false, false);
  for (const record of view.mediaRecords) {
    assertBound(record, true, record.kind === "external_media");
  }
}

function resultFromPack(
  directory: string,
  cached: boolean,
): EvidencePackResult {
  const validation = validateEvidencePack(directory);
  if (!validation.ok || !validation.packId) {
    throw new EvidencePackError(
      "PACK_CORRUPT",
      `evidence pack failed validation: ${validation.errors.map((error) => error.code).join(", ")}`,
    );
  }
  const manifestPath = join(directory, "manifest.json");
  const manifestBytes = readFileSync(manifestPath);
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(manifestBytes.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    manifest = parsed as Record<string, unknown>;
  } catch {
    throw new EvidencePackError("PACK_CORRUPT", "evidence pack manifest is unreadable");
  }
  const selection = manifest.selection as Record<string, unknown> | undefined;
  const artifacts = manifest.artifacts as Record<string, unknown> | undefined;
  if (
    typeof manifest.packId !== "string" ||
    typeof manifest.createdAt !== "number" ||
    !selection ||
    !Array.isArray(selection.regionIds) ||
    !Array.isArray(manifest.files) ||
    !artifacts ||
    !Array.isArray(artifacts.included) ||
    !Array.isArray(artifacts.excluded)
  ) {
    throw new EvidencePackError("PACK_CORRUPT", "evidence pack manifest shape is invalid");
  }
  if (manifest.packId !== basename(directory)) {
    throw new EvidencePackError("PACK_CORRUPT", "evidence pack directory does not match its pack id");
  }
  return {
    packId: manifest.packId,
    directory,
    manifestPath,
    manifestHash: manifestPin(manifestBytes),
    files: manifest.files as EvidencePackFile[],
    selectedRegionIds: selection.regionIds as string[],
    includedArtifacts: (artifacts.included as Array<Record<string, unknown>>).map((entry) => ({
      artifactId: String(entry.artifactId),
      path: String(entry.path),
      sha256: String(entry.sha256),
      bytes: Number(entry.bytes),
    })),
    excludedArtifacts: artifacts.excluded as Array<{ artifactId: string; reason: string }>,
    validation: { manifest: "pass", claims: "pass", hashes: "pass", designMd: "pass" },
    cached,
  };
}

function assertWithinLimits(documents: RenderedDocument[]): void {
  for (const document of documents) {
    const limit =
      document.path === "DESIGN.md"
        ? MAX_DESIGN_MD_BYTES
        : document.path === "design-evidence.json"
          ? MAX_DESIGN_EVIDENCE_BYTES
          : document.path === "artifacts/selection.json"
            ? MAX_SELECTION_BYTES
            : MAX_TEXT_DOCUMENT_BYTES;
    if (document.bytes > limit) {
      throw new EvidencePackError(
        "PACK_LIMIT_EXCEEDED",
        `${document.path} is ${document.bytes} bytes (limit ${limit})`,
      );
    }
  }
}

export async function buildEvidencePack(
  input: EvidencePackInput,
  store: EvidencePackStore,
): Promise<EvidencePackResult> {
  if (!store?.cache?.atlas) {
    throw new EvidencePackError("ATLAS_DISABLED", "Atlas evidence packs require AWWWARDS_MCP_ATLAS=1");
  }
  const cache = store.cache;
  const normalized = normalizeInput(input);
  const now = store.now?.() ?? Date.now();
  const exporterVersion = supportedExporterVersion(
    store.exporterVersion ?? EVIDENCE_PACK_EXPORTER_VERSION,
  );
  if (!exporterVersion) throw invalid("exporter version is not supported");

  const loaded = cache.withAtlasDb((db) => {
    db.exec("BEGIN");
    try {
    const heads = db
      .prepare(
        `SELECT h.page_id, h.profile_key, h.capture_id, p.site_slug, p.kind, p.public_url, p.path,
                c.status, c.config_hash, c.source_digest, c.observed_at, c.finished_at,
                c.source_fetched_at, c.last_confirmed_at, c.extractor_version,
                c.classifier_version, c.coverage_json, c.config_json, c.policy_json
         FROM atlas_heads h
         JOIN atlas_captures c
           ON c.id = h.capture_id AND c.page_id = h.page_id AND c.profile_key = h.profile_key
         JOIN atlas_pages p ON p.id = h.page_id
         WHERE p.site_slug = ? AND c.status IN ('complete','partial')
         ORDER BY c.id`,
      )
      .all(normalized.siteSlug) as unknown as HeadRow[];
    if (!heads.length) {
      throw invalid(`site has no active Atlas head: ${normalized.siteSlug}`);
    }
    store.onSnapshotRead?.();
    const headByCapture = new Map(heads.map((head) => [head.capture_id, head]));
    if (normalized.captureIds.length) {
      for (const captureId of normalized.captureIds) {
        if (!headByCapture.has(captureId)) {
          throw invalid(`capture is not an active head for this site: ${captureId}`);
        }
      }
    }
    const allowed = new Set(
      normalized.captureIds.length ? normalized.captureIds : heads.map((head) => head.capture_id),
    );
    const placeholders = normalized.regionIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT r.id, r.capture_id, r.parent_id, r.kind, r.ordinal, r.locator_json, r.heading,
                r.text_excerpt, r.raw_title, r.primary_label, r.samples_json, r.pattern_key,
                r.coverage_json
         FROM atlas_regions r
         WHERE r.id IN (${placeholders})`,
      )
      .all(...normalized.regionIds) as unknown as RegionRow[];
    if (rows.length !== normalized.regionIds.length) {
      const found = new Set(rows.map((row) => row.id));
      throw invalid(
        `unknown region id: ${normalized.regionIds.filter((id) => !found.has(id)).join(", ")}`,
      );
    }
    for (const row of rows) {
      if (row.kind !== "section" && row.kind !== "component") {
        throw invalid(`region is not a section or component: ${row.id}`);
      }
      const head = headByCapture.get(row.capture_id);
      if (!head) throw invalid(`region does not belong to an active head: ${row.id}`);
      if (!allowed.has(row.capture_id)) {
        throw invalid(`region capture is outside the requested capture set: ${row.id}`);
      }
      if (head.site_slug !== normalized.siteSlug) {
        throw invalid(`region belongs to another site: ${row.id}`);
      }
    }

    const captures = heads.filter((head) =>
      rows.some((row) => row.capture_id === head.capture_id),
    );
    const captureIds = captures.map((capture) => capture.capture_id);
    const artifacts = db
      .prepare(
        `SELECT id, capture_id, region_id, kind, storage_path, external_url, sha256, bytes,
                mime_type, state, rights_json, metadata_json
         FROM atlas_artifacts WHERE capture_id IN (${captureIds.map(() => "?").join(",")})
         ORDER BY id`,
      )
      .all(...captureIds) as unknown as ArtifactRow[];
    const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    const claims = db
      .prepare(
        `SELECT id, region_id, field, value, sample_key, classification, basis, decision,
                state, rule_id, rule_version, evidence_json, limitations_json
         FROM atlas_claims
         WHERE region_id IN (${placeholders})
           AND decision = 'accepted'
           AND classification <> 'proposed'
         ORDER BY region_id, state, field, value, sample_key, id`,
      )
      .all(...normalized.regionIds) as unknown as ClaimRow[];
    const roots = db
      .prepare(
        `SELECT id, capture_id, samples_json FROM atlas_regions
         WHERE capture_id IN (${captureIds.map(() => "?").join(",")}) AND kind = 'page'`,
      )
      .all(...captureIds) as unknown as Array<{
      id: string;
      capture_id: string;
      samples_json: string;
    }>;
    db.exec("COMMIT");
    return {
      heads,
      captures,
      rows,
      artifacts,
      artifactById,
      claims,
      roots,
    };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* transaction already closed */
      }
      throw error;
    }
  });

  const headByCapture = new Map(loaded.heads.map((head) => [head.capture_id, head]));
  const captures: PackCapture[] = loaded.captures
    .map((head) => captureFromHead(head))
    .sort((left, right) => compareText(left.id, right.id));
  const captureById = new Map(captures.map((capture) => [capture.id, capture]));

  const scanByCapture = new Map<string, ScanComponents | null>();
  const readScan = (captureId: string): ScanComponents | null => {
    if (scanByCapture.has(captureId)) return scanByCapture.get(captureId) ?? null;
    const root = loaded.roots.find((entry) => entry.capture_id === captureId);
    const rootSamples = root ? parseJson<Record<string, unknown>>(root.samples_json) : null;
    const scan = findScanArtifact(cache.rootDir, captureId, rootSamples, loaded.artifacts);
    scanByCapture.set(captureId, scan);
    return scan;
  };

  const regions: PackRegion[] = loaded.rows
    .map((row) => {
      const head = headByCapture.get(row.capture_id)!;
      const capture = captureById.get(row.capture_id)!;
      const samples = parseJson<Record<string, unknown>>(row.samples_json) ?? {};
      const locator = row.locator_json
        ? parseJson<Record<string, unknown>>(row.locator_json) ?? {}
        : {};
      const { styles, styleSource }: Pick<PackRegion, "styles" | "styleSource"> =
        row.kind === "component"
          ? scanStylesOf(readScan(row.capture_id), locator)
          : { styles: {}, styleSource: null };
      const type =
        row.kind === "component" && typeof samples.type === "string" && samples.type.trim()
          ? samples.type
          : null;
      const limitations = coverageOf(row.coverage_json).limitations.slice(0, 16);
      if (head.kind === "legacy_gallery") limitations.push("LEGACY_GALLERY_NO_SOURCE_ARTIFACT");
      return {
        regionId: row.id,
        captureId: row.capture_id,
        pageId: head.page_id,
        kind: row.kind as "section" | "component",
        ordinal: row.ordinal,
        viewport: capture.viewport,
        role: typeof samples.role === "string" ? samples.role : null,
        landmark: typeof samples.landmark === "string" ? samples.landmark : null,
        type,
        typeClassification:
          samples.typeClassification === "observed" || samples.typeClassification === "inferred"
            ? samples.typeClassification
            : null,
        patternKey: row.pattern_key,
        geometry: geometryOf(samples),
        backgroundColor:
          typeof samples.backgroundColor === "string" && samples.backgroundColor.trim()
            ? samples.backgroundColor
            : null,
        styles,
        sectionRegionId:
          row.kind === "component" && row.parent_id && loaded.rows.some((entry) => entry.id === row.parent_id)
            ? row.parent_id
            : null,
        observations: observationsOf(samples, capture.viewport),
        styleSource,
        limitations: limitations.slice(0, 16),
      } satisfies PackRegion;
    })
    .sort((left, right) => compareText(left.captureId, right.captureId) || left.ordinal - right.ordinal);

  const ordered = orderRegions(regions, captures);
  const storedClaims: PackClaim[] = [];
  for (const claim of loaded.claims) {
    const region = ordered.find((entry) => entry.regionId === claim.region_id);
    if (!region) continue;
    const limitations = parseJson<unknown[]>(claim.limitations_json);
    storedClaims.push({
      id: "",
      regionId: claim.region_id,
      captureId: region.captureId,
      property: claim.field,
      value: claim.value,
      classification:
        claim.classification === "inferred" || claim.classification === "proposed"
          ? claim.classification
          : "observed",
      artifactId: "selection",
      path: "",
      viewport: region.viewport,
      state: claim.state || "default",
      sampleKey: claim.sample_key,
      method: `atlas-claim:${claim.basis}`,
      ruleId: claim.rule_id,
      sampleCount: 1,
      limitations: Array.isArray(limitations)
        ? limitations.filter((item): item is string => typeof item === "string").slice(0, 16)
        : [],
      sourceClaimId: claim.id,
    });
  }
  const claims = buildClaims(ordered, storedClaims);
  const sections = deriveSectionSummaries(ordered, claims);
  const components = deriveComponentSummaries(ordered, claims);

  const referencesById = new Map<string, PackArtifactRef>();
  const addReference = (artifactId: string): void => {
    if (!artifactId || referencesById.has(artifactId)) return;
    referencesById.set(artifactId, sourceArtifactRef(loaded.artifactById.get(artifactId), artifactId));
  };
  for (const claim of loaded.claims) {
    const evidence = parseJson<unknown[]>(claim.evidence_json);
    if (!Array.isArray(evidence)) continue;
    for (const ref of evidence) {
      if (ref && typeof ref === "object" && typeof (ref as Record<string, unknown>).artifactId === "string") {
        addReference((ref as Record<string, string>).artifactId!);
      }
    }
  }
  for (const region of ordered) {
    if (region.styleSource) addReference(region.styleSource.artifactId);
  }

  const mediaCandidates = mediaCandidatesFor(ordered, loaded.artifacts, headByCapture);
  for (const candidate of mediaCandidates) {
    referencesById.set(
      candidate.artifactId,
      sourceArtifactRef(loaded.artifactById.get(candidate.artifactId), candidate.artifactId),
    );
  }
  const media = decideMedia(
    mediaCandidates,
    normalized.inclusionMode,
    normalized.rights,
    cache.rootDir,
  );
  const coverage = packCoverage(captures, ordered);
  const sourceUrls = uniqueSorted(
    captures
      .map((capture) => {
        const head = loaded.heads.find((entry) => entry.capture_id === capture.id);
        return head ? sourceUrlOf(head) : null;
      })
      .filter((value): value is string => typeof value === "string"),
  );
  const omitted: PackOmission[] = [];
  const packId = evidencePackId(
    {
      siteSlug: normalized.siteSlug,
      goal: normalized.goal,
      inclusionMode: normalized.inclusionMode,
      regionIds: ordered.map((region) => region.regionId),
      captures,
      references: [...referencesById.values()],
      rights: normalized.rights,
    },
    exporterVersion,
  );

  const selection: EvidenceSelection = {
    packId,
    siteSlug: normalized.siteSlug,
    goal: normalized.goal,
    inclusionMode: normalized.inclusionMode,
    captures,
    regions: ordered,
    claims,
    tokens: {
      generated: true,
      colors: [],
      typography: { fontFamily: [], fontSize: [], fontWeight: [], lineHeight: [] },
      spacing: { gap: [], padding: [] },
      radii: [],
      display: [],
    },
    sections,
    components,
    references: [...referencesById.values()].sort((left, right) =>
      compareText(left.artifactId, right.artifactId),
    ),
    mediaCandidates,
    media,
    omitted,
    coverage,
    limitations: coverage.limitations,
    rightsAssertions: normalized.rights,
    sourceUrls,
  };
  // Tokens and omitted families derive from the final claim set.
  selection.tokens = buildTokens(selection);
  selection.omitted = omittedValues(selection, exporterVersion);

  const selectionArtifact = renderSelectionArtifact(selection);
  const documents = [
    selectionArtifact.document,
    ...renderGeneratedDocuments(
      selection,
      sha256(selectionArtifact.document.content),
      exporterVersion,
    ),
  ];
  assertWithinLimits(documents);

  const packsDir = ensurePacksDir(cache.rootDir);
  const finalDir = join(packsDir, packId);
  if (lstatSync(finalDir, { throwIfNoEntry: false })) {
    return adoptEvidencePack(finalDir, store, packId);
  }

  const tempDir = join(packsDir, `.tmp-${packId}-${process.pid}-${randomUUID()}`);
  try {
    mkdirSync(tempDir, { mode: 0o700 });
    const files: EvidencePackFile[] = [];
    for (const document of documents) {
      files.push(writeFileExclusive(tempDir, document.path, document.content));
    }
    for (const decision of selection.media.filter((entry) => entry.included)) {
      let storagePath: string;
      try {
        storagePath = resolveArtifactPath(cache.rootDir, decision.storagePath!);
      } catch {
        throw new EvidencePackError(
          "PACK_WRITE_FAILED",
          `artifact path is unsafe: ${decision.artifactId}`,
        );
      }
      const bytes = readFileSync(storagePath);
      if (sha256(bytes) !== decision.sha256 || bytes.length !== decision.bytes) {
        throw new EvidencePackError(
          "PACK_WRITE_FAILED",
          `artifact changed while copying: ${decision.artifactId}`,
        );
      }
      const target = join(tempDir, decision.copiedPath!);
      if (existsSync(target)) {
        const existing = readFileSync(target);
        if (sha256(existing) !== decision.sha256 || existing.length !== decision.bytes) {
          throw new EvidencePackError(
            "PACK_WRITE_FAILED",
            `conflicting copied artifact: ${decision.artifactId}`,
          );
        }
      } else {
        files.push(writeFileExclusive(tempDir, decision.copiedPath!, bytes));
      }
    }

    const manifest = manifestFor(selection, now, files, exporterVersion);
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileExclusive(tempDir, "manifest.json", manifestText);

    const validation = validateEvidencePack(tempDir);
    if (!validation.ok) {
      throw new EvidencePackError(
        "PACK_WRITE_FAILED",
        `pack failed pre-publication validation: ${validation.errors.map((error) => error.code).join(", ")}`,
      );
    }
    const frozen = freezePack(tempDir, selection, now);
    store.onBeforePublish?.(tempDir);

    return publishPack(
      cache,
      selection,
      tempDir,
      finalDir,
      frozen,
      store.onBeforeRename,
      store.onAfterRename,
    );
  } catch (error) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
    if (error instanceof EvidencePackError) throw error;
    throw new EvidencePackError(
      "PACK_WRITE_FAILED",
      error instanceof Error ? error.message : "evidence pack write failed",
    );
  }
}
