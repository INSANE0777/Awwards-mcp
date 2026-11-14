import type { Cache } from "../cache.js";
import type { EvidenceCoverage, RightsRecord } from "./types.js";

export const EVIDENCE_PACK_SCHEMA_VERSION = "awwwards-atlas-evidence-pack-v1";
export const EVIDENCE_SELECTION_SCHEMA_VERSION = "awwwards-atlas-evidence-selection-v2";
export const EVIDENCE_DESIGN_SCHEMA_VERSION = "awwwards-design-evidence-v1";
/**
 * Exporter version 2 records the missing motion family. Version 1 packs were
 * shipped by 1.19.0 without it; both are validated with their own rules so an
 * existing pack keeps its identity and stays adoptable.
 */
export const EVIDENCE_PACK_EXPORTER_VERSION = "atlas-exporter-2";
export const LEGACY_EVIDENCE_PACK_EXPORTER_VERSION = "atlas-exporter-1";
export type PackExporterVersion =
  | typeof EVIDENCE_PACK_EXPORTER_VERSION
  | typeof LEGACY_EVIDENCE_PACK_EXPORTER_VERSION;
export const EVIDENCE_PACK_EXPORTER_VERSIONS: readonly PackExporterVersion[] = [
  LEGACY_EVIDENCE_PACK_EXPORTER_VERSION,
  EVIDENCE_PACK_EXPORTER_VERSION,
];
/** Null means unsupported: callers must fail closed, never guess a version. */
export function supportedExporterVersion(value: unknown): PackExporterVersion | null {
  return EVIDENCE_PACK_EXPORTER_VERSIONS.find((version) => version === value) ?? null;
}
/** Whether this exporter version records the missing-motion omission. */
export function packExporterIncludesMotion(version: PackExporterVersion): boolean {
  return version !== LEGACY_EVIDENCE_PACK_EXPORTER_VERSION;
}
export const EVIDENCE_PACK_ATTRIBUTION = "Awwwards Atlas local evidence pack";

/** MIME recorded for a pack file, derived only from its extension. */
export function evidenceFileMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

export const MAX_PACK_REGIONS = 200;
export const MAX_PACK_GOAL_LENGTH = 1000;
export const MAX_RIGHTS_ASSERTIONS = 24;
export const MAX_COPIED_ARTIFACTS = 24;
export const MAX_COPIED_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_COPIED_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_SELECTION_BYTES = 1024 * 1024;
export const MAX_DESIGN_MD_BYTES = 24 * 1024;
export const MAX_DESIGN_EVIDENCE_BYTES = 256 * 1024;
export const MAX_TEXT_DOCUMENT_BYTES = 256 * 1024;

export const REQUIRED_PACK_FILES = [
  "design-evidence.json",
  "DESIGN.md",
  "brief.md",
  "tokens.json",
  "tokens.css",
  "components.json",
  "rebuild-handoff.md",
] as const;

export const REQUIRED_DESIGN_SECTIONS = [
  "Overview",
  "Colors",
  "Typography",
  "Layout",
  "Elevation & Depth",
  "Shapes",
  "Components",
  "Do's and Don'ts",
  "Sources",
  "Coverage and limitations",
  "Unresolved details",
] as const;

export type InclusionMode = "references" | "permitted";

export const STYLE_FIELDS = [
  ["display", "display"],
  ["gap", "gap"],
  ["padding", "padding"],
  ["radius", "border-radius"],
  ["fontFamily", "font-family"],
  ["fontSize", "font-size"],
  ["fontWeight", "font-weight"],
  ["lineHeight", "line-height"],
] as const;

export type PolicyState = "allowed" | "denied" | "unknown";

export interface EvidencePackInput {
  siteSlug: string;
  goal: string;
  regionIds: string[];
  captureIds?: string[];
  inclusionMode?: InclusionMode;
  rightsAssertions?: Array<{ artifactId: string; rights: RightsRecord }>;
}

export interface EvidencePackStore {
  cache: Cache;
  now?: () => number;
  /**
   * Test/compat seam: emit a supported historical exporter version. Production
   * callers omit it and get the current version.
   */
  exporterVersion?: PackExporterVersion;
  /** Test seam between the validated temp directory and the atomic rename. */
  onBeforePublish?: (tempDir: string) => void;
  /** Test seam inside the publication write transaction, after the head recheck. */
  onBeforeRename?: () => void;
  /** Test seam after the atomic rename and before the final validation runs. */
  onAfterRename?: (finalDir: string) => void;
  /** Test seam after the read transaction's first snapshot read. */
  onSnapshotRead?: () => void;
}

export interface RenderedDocument {
  path: string;
  content: string;
  bytes: number;
}

export interface EvidencePackFile {
  path: string;
  sha256: string;
  bytes: number;
  mimeType: string;
}

export interface EvidencePackResult {
  packId: string;
  directory: string;
  manifestPath: string;
  manifestHash: string;
  files: EvidencePackFile[];
  selectedRegionIds: string[];
  includedArtifacts: Array<{ artifactId: string; path: string; sha256: string; bytes: number }>;
  excludedArtifacts: Array<{ artifactId: string; reason: string }>;
  validation: {
    manifest: "pass";
    claims: "pass";
    hashes: "pass";
    designMd: "pass";
  };
  cached: boolean;
}

export interface PackValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface PackValidation {
  ok: boolean;
  packId: string | null;
  errors: PackValidationIssue[];
  warnings: string[];
}

export interface PackCapture {
  id: string;
  pageId: string;
  profileKey: string;
  sourceKind: string;
  status: string;
  viewport: string;
  /** Canonical capture policy decision at build time; part of the pack identity. */
  policy: PolicyState;
  sourceDigest: string | null;
  configHash: string;
  observedAt: number | null;
  sourceFetchedAt: number | null;
  lastConfirmedAt: number | null;
  finishedAt: number | null;
  extractorVersion: string;
  classifierVersion: string;
  browserVersion: string | null;
  dpr: number | null;
  reducedMotion: string | null;
  requestedStates: string[];
  coverage: EvidenceCoverage;
  limitations: string[];
}

export interface PackGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PackObservation {
  sampleKey: string;
  state: string;
  viewport: string;
  rect: PackGeometry | null;
  visible: boolean | null;
}

export interface PackRegion {
  regionId: string;
  captureId: string;
  pageId: string;
  kind: "section" | "component";
  ordinal: number;
  viewport: string;
  role: string | null;
  landmark: string | null;
  type: string | null;
  typeClassification: "observed" | "inferred" | null;
  patternKey: string | null;
  geometry: PackGeometry | null;
  backgroundColor: string | null;
  styles: Record<string, string>;
  sectionRegionId: string | null;
  observations: PackObservation[];
  styleSource: { artifactId: string; pointer: string } | null;
  limitations: string[];
}

export interface PackClaim {
  id: string;
  regionId: string;
  captureId: string;
  property: string;
  value: string;
  classification: "observed" | "inferred" | "proposed";
  artifactId: "selection";
  path: string;
  viewport: string;
  state: string;
  sampleKey: string | null;
  method: string;
  ruleId: string | null;
  sampleCount: number;
  limitations: string[];
  sourceClaimId?: string;
}

export interface TokenEntry {
  name: string;
  value: string;
  property: string;
  claimIds: string[];
  evidence: Array<{ artifactId: string; path: string }>;
}

export interface PackTokens {
  generated: true;
  colors: TokenEntry[];
  typography: {
    fontFamily: TokenEntry[];
    fontSize: TokenEntry[];
    fontWeight: TokenEntry[];
    lineHeight: TokenEntry[];
  };
  spacing: {
    gap: TokenEntry[];
    padding: TokenEntry[];
  };
  radii: TokenEntry[];
  display: TokenEntry[];
}

export interface MediaCandidate {
  artifactId: string;
  captureId: string;
  regionId: string | null;
  kind: string;
  storagePath: string | null;
  sha256: string;
  bytes: number;
  mimeType: string;
  state: string;
  rights: RightsRecord | null;
  policy: PolicyState;
}

export interface MediaDecision extends MediaCandidate {
  included: boolean;
  copiedPath: string | null;
  reason: string;
}

export interface PackArtifactRef {
  artifactId: string;
  captureId: string;
  regionId: string | null;
  kind: string;
  storagePath: string | null;
  sha256: string | null;
  bytes: number | null;
  mimeType: string;
  state: string;
}

export interface PackOmission {
  family: string;
  reason: string;
}

export interface PackSectionSummary {
  regionId: string;
  captureId: string;
  ordinal: number;
  viewport: string;
  geometry: PackGeometry | null;
  backgroundColor: string | null;
  claimIds: string[];
}

export interface PackComponentSummary {
  regionId: string;
  captureId: string;
  ordinal: number;
  viewport: string;
  type: string | null;
  typeClassification: "observed" | "inferred" | null;
  candidateOnly: boolean;
  patternKey: string | null;
  geometry: PackGeometry | null;
  styles: Record<string, string>;
  sectionRegionId: string | null;
  claimIds: string[];
  states: Array<{ state: string; claimIds: string[] }>;
}

export interface EvidenceSelection {
  packId: string;
  siteSlug: string;
  goal: string;
  inclusionMode: InclusionMode;
  captures: PackCapture[];
  regions: PackRegion[];
  claims: PackClaim[];
  tokens: PackTokens;
  sections: PackSectionSummary[];
  components: PackComponentSummary[];
  references: PackArtifactRef[];
  mediaCandidates: MediaCandidate[];
  media: MediaDecision[];
  omitted: PackOmission[];
  coverage: EvidenceCoverage;
  limitations: string[];
  rightsAssertions: Array<{ artifactId: string; rights: RightsRecord }>;
  sourceUrls: string[];
}

export class EvidencePackError extends Error {
  constructor(
    readonly code:
      | "INVALID_SELECTION"
      | "PACK_CORRUPT"
      | "PACK_STALE"
      | "PACK_LIMIT_EXCEEDED"
      | "PACK_OUTSIDE_STORE"
      | "PACK_WRITE_FAILED"
      | "ATLAS_DISABLED",
    message: string,
  ) {
    super(message);
    this.name = "EvidencePackError";
  }
}
