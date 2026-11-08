import type { Cache } from "../cache.js";
import type { EvidenceBasis, EvidenceCoverage, EvidenceRef, AtlasId } from "./types.js";

export type AtlasViewportProfile = "desktop" | "mobile";

export interface AtlasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AtlasTarget {
  siteSlug: string;
  requestedUrl: string;
  /** Path-only identity used for page ids and policy checks. */
  urlKey: string;
  path: string;
}

/** Serialized DOM section evidence collected inside the guarded page. */
export interface AtlasScanSection {
  nodeKey: string;
  selector: string;
  tag: string;
  role: string | null;
  landmark: string | null;
  heading: string | null;
  headingLevel: number | null;
  text: string;
  visible: boolean;
  articleNested: boolean;
  landmarkNested: boolean;
  paragraphCount: number;
  linkCount: number;
  mediaCount: number;
  repeatedItems: number;
  orderedItems: number;
  quoteCount: number;
  citationCount: number;
  numericPairs: number;
  formCount: number;
  emailInputCount: number;
  buttonCount: number;
  buttonLabels: string[];
  rect: AtlasRect;
  viewport: { width: number; height: number };
  backgroundColor: string | null;
  fixed: boolean;
  depth: number;
  parentKey: string | null;
  inScrollRoot?: boolean;
}

export interface AtlasPageScan {
  title: string;
  url: string;
  totalHeight: number;
  scrollRoot: string | null;
  scrollRootClientHeight?: number | null;
  scrollRootScrollLeft?: number | null;
  scrollRootScrollTop?: number | null;
  scrollX?: number;
  scrollY?: number;
  sections: AtlasScanSection[];
  rawSectionCount?: number;
  sectionLimitHit?: boolean;
  nodeBudgetHit?: boolean;
  technologies: string[];
  canvasCount: number;
  webglObserved: boolean;
}

export interface RegionCandidate {
  key: string;
  ordinal: number;
  /** Original index in the serialized scan artifact. */
  scanIndex: number;
  nodeKey: string;
  selector: string;
  parentKey: string | null;
  tag: string;
  role: string | null;
  landmark: string | null;
  heading: string | null;
  headingLevel: number | null;
  text: string;
  visible: boolean;
  inScrollRoot?: boolean;
  articleNested: boolean;
  landmarkNested: boolean;
  paragraphCount: number;
  linkCount: number;
  mediaCount: number;
  repeatedItems: number;
  orderedItems: number;
  quoteCount: number;
  citationCount: number;
  numericPairs: number;
  formCount: number;
  emailInputCount: number;
  buttonCount: number;
  buttonLabels: string[];
  rect: AtlasRect;
  viewport: { width: number; height: number };
  backgroundColor: string | null;
  depth: number;
}

export interface SectionEvidence {
  viewport: AtlasViewportProfile;
  candidate: RegionCandidate;
  scan: AtlasPageScan;
  /** Artifact key supplied by the collector/publication layer. */
  artifactKey?: string;
}

export interface AtlasClaim {
  regionKey: string;
  field: string;
  value: string;
  decision: "accepted" | "candidate" | "rejected";
  classification: "observed" | "inferred" | "proposed";
  basis: EvidenceBasis;
  ruleId: string;
  ruleVersion: string;
  sampleKey: string;
  checkpointKeys?: string[];
  evidence: EvidenceRef[];
}

export interface AtlasStoredArtifact {
  key: string;
  kind: "screenshot" | "raw_observation" | "tokens" | "component_pack";
  storagePath: string;
  sha256: string;
  bytes: number;
  mimeType: string;
  regionKey: string | null;
}

export interface AtlasObservation {
  key: string;
  checkpoint: number;
  scrollY: number;
  scrollRoot: string | null;
  state: "default";
  settleStatus?: "settled";
  coordinateSpace: "document" | "scroll_root";
  scrollX: number;
  viewport: AtlasViewportProfile;
  regionKeys: string[];
  regions: Array<{
    key: string;
    sampleKey: string;
    targetRegionId: string | null;
    visible: boolean;
    coordinateSpace: "document" | "scroll_root";
    inScrollRoot?: boolean;
    scrollX: number;
    selector: string;
    tag: string;
    heading: string | null;
    text: string;
    rect: { x: number; y: number; width: number; height: number };
  }>;
  screenshotKey: string;
  scanArtifactKey: string;
}

export interface AtlasViewportCapture {
  viewport: AtlasViewportProfile;
  profileKey: string;
  status: AtlasAttemptStatus;
  coverage: EvidenceCoverage;
  limitations: string[];
  finalUrl: string;
  browserVersion: string;
  dpr: number;
  reducedMotion: "no-preference" | "reduce";
  scrollRoot: string | null;
  overlayState: "none" | "dismissed" | "present";
  loadingFailures: string[];
  scan: AtlasPageScan;
  regions: RegionCandidate[];
  claims: AtlasClaim[];
  screenshots: AtlasStoredArtifact[];
  observations?: AtlasObservation[];
  artifacts: AtlasStoredArtifact[];
}

export type AtlasAttemptStatus = "complete" | "partial" | "unknown" | "blocked" | "failed";

export interface AtlasCaptureAttempt {
  cache: Cache;
  target: AtlasTarget;
  attemptId: string;
  startedAt: number;
  finishedAt: number;
  status: AtlasAttemptStatus;
  coverage: EvidenceCoverage;
  limitations: string[];
  viewports: AtlasViewportCapture[];
  artifacts: AtlasStoredArtifact[];
  error?: string;
}

export interface AtlasCollectInput {
  siteSlug: string;
  path?: string;
  viewports?: AtlasViewportProfile[];
}

export interface AtlasCollectDeps {
  cache: Cache;
  now?: () => number;
  /** Test seam; production uses the optional Playwright loader. */
  loader?: () => Promise<any>;
  resolveHost?: (hostname: string) => Promise<string[]>;
  /** Explicit test-only private origins, normalized by scene-capture. */
  allowPrivateOrigins?: string[];
  signal?: AbortSignal;
  totalBudgetMs?: number;
  navigationTimeoutMs?: number;
  /** Test seams; production uses the guarded page-level defaults. */
  settle?: (page: any) => Promise<void>;
  scanPage?: (page: any, viewport: AtlasViewportProfile) => Promise<AtlasPageScan>;
  screenshot?: (page: any) => Promise<Buffer>;
}

export interface AtlasPublicationResult {
  published: boolean;
  code?: string;
  captureIds: AtlasId[];
  pageId: AtlasId;
  regionCount: number;
  claimCount: number;
}

export interface AtlasPublishDeps {
  now?: () => number;
}

export type AtlasClassificationRegistry = ReadonlyArray<{
  field: string;
  value: string;
  enabled: boolean;
  searchable: boolean;
  permittedBases: readonly EvidenceBasis[];
  ruleIds: readonly string[];
}>;
