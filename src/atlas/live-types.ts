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

/** One bounded node in a serialized component pack. No page copy is stored. */
export interface AtlasComponentNode {
  tag: string;
  role: string | null;
  depth: number;
  childCount: number;
}

/**
 * Raw component evidence serialized by the page scan. `hint` is the semantic
 * type the DOM/ARIA structure points at; classification still decides whether
 * it is observed, inferred or unknown.
 */
export interface AtlasScanComponent {
  nodeKey: string;
  selector: string;
  tag: string;
  role: string | null;
  hint: string;
  hintBasis: "native_semantics" | "declared_aria" | "rule_derivation";
  label: string;
  visible: boolean;
  offscreen: boolean;
  /** Off-canvas geometry: rect fully outside the viewport on any axis. */
  offCanvas: boolean;
  /** No visible pixels after viewport and containing-block overflow clipping. */
  fullyClipped: boolean;
  sectionNodeKey: string | null;
  childCount: number;
  descendantCount: number;
  hasHeading: boolean;
  hasMedia: boolean;
  hasIcon: boolean;
  inNavigation: boolean;
  ariaHasPopup: boolean;
  ariaExpanded: string | null;
  ariaControlsResolved: boolean;
  ariaLabel: string | null;
  overflowX: string;
  scrollableX: boolean;
  position: string;
  transformed: boolean;
  shape: string;
  childCounts: string;
  display: string;
  gap: string;
  padding: string;
  radius: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  rect: AtlasRect;
  depth: number;
  pack: { nodes: AtlasComponentNode[]; truncated: boolean } | null;
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
  components?: AtlasScanComponent[];
  rawSectionCount?: number;
  sectionLimitHit?: boolean;
  componentLimitHit?: boolean;
  /** Candidates discarded by the component cap after ranking. */
  componentDroppedCount?: number;
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

/**
 * A classified component candidate. A declared type is not an observed state:
 * `type` records how the control is declared, never that it is open or active.
 */
export interface ComponentCandidate {
  key: string;
  ordinal: number;
  /** Original index in the serialized scan components array. */
  scanIndex: number;
  nodeKey: string;
  selector: string;
  tag: string;
  role: string | null;
  type: string;
  typeClassification: "observed" | "inferred";
  typeBasis: "native_semantics" | "declared_aria" | "rule_derivation";
  typeDecision: "accepted" | "candidate";
  typeRuleId: string;
  label: string;
  visible: boolean;
  offscreen: boolean;
  sectionNodeKey: string | null;
  /** Published containing section key, when that section was retained. */
  sectionKey: string | null;
  patternKey: string;
  rect: AtlasRect;
  depth: number;
  pack: { nodes: AtlasComponentNode[]; truncated: boolean } | null;
}

export interface ComponentEvidence {
  viewport: AtlasViewportProfile;
  candidate: ComponentCandidate;
  /** Artifact key supplied by the collector/publication layer. */
  artifactKey?: string;
  /** Component pack artifact key, when one was serialized. */
  packArtifactKey?: string | null;
  /** Accepted purposes of the containing section only. */
  sectionPurposes?: string[];
  /** Scan that produced the candidate, used to resolve the section evidence pointer. */
  scan?: AtlasPageScan;
}

export interface PatternMembership {
  key: string;
  memberKeys: string[];
  count: number;
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
  /** Interaction state this claim was observed in; absent means default. */
  state?: AtlasStateName;
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

export type AtlasStateAction = "hover" | "focus";
export type AtlasStateName = "default" | AtlasStateAction;

/** An explicit, bounded interaction-state request on an already published region. */
export interface AtlasStateRequest {
  action: AtlasStateAction;
  targetRegionId: string;
}

/** Outcome of one explicit state request, including inconclusive results. */
export interface AtlasStateResult {
  action: AtlasStateAction;
  targetRegionId: string;
  status: "observed" | "inconclusive";
  code?: string;
  sampleKey?: string;
  /** Capture-local region key that received the state sample. */
  regionKey?: string;
}

export interface AtlasObservation {
  key: string;
  checkpoint: number;
  scrollY: number;
  scrollRoot: string | null;
  state: AtlasStateName;
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
  /** State evidence JSON for non-default observations. */
  stateArtifactKey?: string;
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
  components?: ComponentCandidate[];
  claims: AtlasClaim[];
  screenshots: AtlasStoredArtifact[];
  observations?: AtlasObservation[];
  /** State request outcomes, including explicit inconclusive codes. */
  states?: AtlasStateResult[];
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
  /** Explicit state requests this attempt was asked to observe. */
  states?: AtlasStateRequest[];
  /** Component candidates and packs; default true. */
  components?: boolean;
  error?: string;
}

export interface AtlasCollectInput {
  siteSlug: string;
  path?: string;
  viewports?: AtlasViewportProfile[];
  /** Component candidates and packs; default true. */
  components?: boolean;
  /** At most three explicit hover/focus observations on current head regions. */
  states?: AtlasStateRequest[];
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
  scanPage?: (
    page: any,
    viewport: AtlasViewportProfile,
    options?: { components?: boolean },
  ) => Promise<AtlasPageScan>;
  screenshot?: (page: any) => Promise<Buffer>;
}

export interface AtlasPublicationResult {
  published: boolean;
  code?: string;
  captureIds: AtlasId[];
  pageId: AtlasId;
  /** Section regions stored by this publication. */
  regionCount: number;
  /** Component regions stored by this publication. */
  componentCount: number;
  claimCount: number;
  /**
   * For observed state requests: the requested region id mapped to the region
   * id stored in this publication's capture. A follow-up state request uses
   * the published id, which belongs to the new active head.
   */
  publishedRegionIds?: Record<string, string>;
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
