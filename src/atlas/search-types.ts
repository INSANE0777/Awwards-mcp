import type { EvidenceBasis, EvidenceCoverage } from "./types.js";

export type AtlasSearchScope = "region" | "page" | "site";
export type AtlasSearchViewport = "desktop" | "mobile";
export type AtlasSearchState = "default" | "hover" | "focus";
export type AtlasEvidenceMode = "accepted" | "observed_only" | "candidate";
export type AtlasGroupBy = "instance" | "pattern";
export type AtlasSort = "relevance" | "newest";

/** Phase 3 exposes the region-level predicates shipped by the Phase 2 model. */
export type SearchField =
  | "section.purpose"
  | "region.kind"
  | "region.tag"
  | "region.role"
  | "region.landmark";

export interface AtlasPredicate {
  field: SearchField;
  values: string[];
}

export interface SearchAtlasInput {
  kind: "sections" | "components";
  query?: string;
  predicates?: AtlasPredicate[];
  scope?: AtlasSearchScope;
  viewport?: AtlasSearchViewport;
  state?: AtlasSearchState;
  evidenceMode?: AtlasEvidenceMode;
  siteSlugs?: string[];
  maxAgeDays?: number;
  groupBy?: AtlasGroupBy;
  sort?: AtlasSort;
  facets?: SearchField[];
  limit?: number;
  cursor?: string;
}

/** Input with every default filled; returned as `interpreted`. */
export interface InterpretedSearchInput {
  kind: "sections" | "components";
  query?: string;
  predicates: AtlasPredicate[];
  scope: AtlasSearchScope;
  viewport: AtlasSearchViewport;
  state: AtlasSearchState;
  evidenceMode: AtlasEvidenceMode;
  siteSlugs?: string[];
  maxAgeDays: number;
  groupBy: AtlasGroupBy;
  sort: AtlasSort;
  facets: SearchField[];
  limit: number;
}

export type AtlasSearchErrorCode =
  | "INVALID_INPUT"
  | "UNSUPPORTED_KIND"
  | "UNSUPPORTED_STATE"
  | "UNSUPPORTED_PREDICATE"
  | "UNSUPPORTED_GROUPING"
  | "FTS_UNAVAILABLE"
  | "SEARCH_NOT_READY"
  | "CURSOR_STALE"
  | "CURSOR_EXPIRED"
  | "CURSOR_QUERY_MISMATCH"
  | "CURSOR_INVALID";

export interface AtlasSearchErrorBody {
  code: AtlasSearchErrorCode;
  message: string;
  retryable: boolean;
}

export type AtlasSearchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AtlasSearchErrorBody };

export type CursorResult =
  | { ok: true; cursor: AtlasCursorPayload }
  | { ok: false; error: AtlasSearchErrorBody };

export interface AtlasCursorPayload {
  version: 1;
  revision: number;
  queryHash: string;
  asOf: number;
  expiresAt: number;
  lastSortTuple: string[];
}

export interface AtlasCursorRequest {
  queryHash: string;
}

export type CompiledSearch =
  | {
      ok: true;
      input: InterpretedSearchInput;
      cursor: string | null;
      tokens: string[];
      ftsQuery: string | null;
      queryHash: string;
    }
  | { ok: false; error: AtlasSearchErrorBody };

export type AtlasSearchOutcome =
  | "matches"
  | "no_observed_match"
  | "empty_corpus"
  | "insufficient_coverage";

export type AtlasFreshness = "fresh" | "stale";

export interface AtlasClaimSummary {
  field: string;
  value: string;
  classification: "observed" | "inferred" | "proposed";
  decision: "accepted" | "candidate" | "rejected";
  basis: EvidenceBasis;
  sampleKey: string;
}

export interface AtlasPredicateExplanation {
  field: SearchField;
  values: string[];
  supportingRegionIds: string[];
  sampleKeys: string[];
  /** True when witness IDs were clipped to the per-explanation or per-hit cap. */
  truncated: boolean;
}

export interface AtlasArtifactDescriptor {
  kind: string;
  storagePath: string;
  sha256: string | null;
  bytes: number | null;
  mimeType: string;
}

export interface AtlasPatternGroup {
  key: string;
  memberRegionIds: string[];
  matchingMembers: number;
  observedMembers: number;
}

export interface AtlasObservationSpan {
  from: number;
  to: number;
}

export interface AtlasHit {
  regionId: string;
  captureId: string;
  pageId: string;
  siteSlug: string;
  siteTitle: string;
  sitePublicUrl: string | null;
  sourceUrl: string | null;
  pageUrl: string | null;
  pagePath: string | null;
  kind: "section";
  primaryLabel: string | null;
  viewport: AtlasSearchViewport;
  state: AtlasSearchState;
  observedAt: number;
  freshness: AtlasFreshness;
  matchedSampleKey: string | null;
  explanations: AtlasPredicateExplanation[];
  /** True when the per-hit explanation ID cap clipped witnesses. */
  explanationsTruncated: boolean;
  claims: AtlasClaimSummary[];
  screenshotKeys: string[];
  /** True when the per-hit screenshot key cap clipped the list. */
  screenshotsTruncated: boolean;
  artifacts: AtlasArtifactDescriptor[];
  coverage: EvidenceCoverage;
  patternKey: string | null;
  group: AtlasPatternGroup | null;
  observationSpan?: AtlasObservationSpan;
  candidateOnly: boolean;
}

export interface AtlasFacetValue {
  value: string;
  count: number;
  selected: boolean;
}

export interface AtlasFacet {
  field: SearchField;
  /**
   * Counts are disjunctive: each value is the result count if that value were
   * selected instead of the field's current values. To select several values
   * in one field, send one predicate with OR values
   * (`values: ["header", "footer"]`). Repeated predicates for the same field
   * are separate AND requirements, so adding a second predicate for an
   * advertised value is not the same as selecting it and can yield zero.
   */
  disjunctive: true;
  countUnit: "region_instance";
  values: AtlasFacetValue[];
}

export interface SearchAtlasData {
  outcome: AtlasSearchOutcome;
  revision: number;
  asOf: number;
  interpreted: InterpretedSearchInput;
  results: AtlasHit[];
  total: number;
  countUnit: "region_instance";
  nextCursor: string | null;
  facets: AtlasFacet[];
  corpus: {
    sites: number;
    pages: number;
    captures: number;
    note: "locally cached subset";
    catalogueTotal: null;
  };
  candidateOnly: boolean;
  candidateNote: string | null;
  /** True when optional evidence was trimmed to fit the response byte budget. */
  responseTruncated: boolean;
}

export interface AtlasSearchSite {
  slug: string;
  title: string | null;
  liveUrl: string | null;
}

export interface AtlasSearchPage {
  id: string;
  siteSlug: string;
  kind: string;
  publicUrl: string | null;
  path: string | null;
}

export interface AtlasSearchCapture {
  id: string;
  pageId: string;
  profileKey: string;
  viewport: AtlasSearchViewport | null;
  status: string;
  active: boolean;
  observedAt: number | null;
  lastConfirmedAt: number | null;
  sourceFetchedAt: number | null;
  coverage: EvidenceCoverage;
}

export interface AtlasSearchRegion {
  id: string;
  captureId: string;
  parentId: string | null;
  kind: "section";
  ordinal: number;
  tag: string | null;
  role: string | null;
  landmark: string | null;
  selector: string | null;
  patternKey: string | null;
  primaryLabel: string | null;
  heading: string;
  rawTitle: string | null;
  textExcerpt: string;
  fingerprint: string | null;
  coverage: EvidenceCoverage;
}

export interface AtlasSearchClaim {
  id: string;
  regionId: string;
  field: string;
  value: string;
  sampleKey: string;
  classification: "observed" | "inferred" | "proposed";
  basis: EvidenceBasis;
  decision: "accepted" | "candidate" | "rejected";
  ruleId: string | null;
}

export interface AtlasSnapshotFilters {
  asOf: number;
  maxAgeDays: number;
  viewport: AtlasSearchViewport;
  state: AtlasSearchState;
  siteSlugs?: string[];
  query?: string;
}

/**
 * SQL-backed search seam. Implementations push eligibility, predicates,
 * ordering, pagination and facets into SQLite; the search core never
 * materializes the full corpus.
 */
export interface AtlasSearchQuery {
  input: InterpretedSearchInput;
  asOf: number;
  tokens: string[];
  ftsQuery: string | null;
  afterTuple: string[] | null;
}

export interface AtlasSearchQueryData {
  revision: number;
  ftsAvailable: boolean;
  hits: AtlasHit[];
  total: number;
  hasMore: boolean;
  nextTuple: string[] | null;
  facets: AtlasFacet[];
  corpus: { sites: number; pages: number; captures: number };
  /** True when at least one section region is eligible for the requested viewport and age. */
  hasEligibleRegions: boolean;
  predicatePresence: Partial<Record<SearchField, boolean>>;
}

export interface AtlasSearchStore {
  query(request: AtlasSearchQuery): AtlasSearchResult<AtlasSearchQueryData>;
}

/** Region artifact descriptor seeded by the test/benchmark snapshot adapter. */
export interface AtlasSearchArtifact {
  id: string;
  captureId: string;
  regionId: string;
  kind: string;
  storagePath: string;
  sha256: string | null;
  bytes: number | null;
  mimeType: string;
}

export interface AtlasSearchSnapshot {
  revision: number;
  asOf: number;
  ftsAvailable: boolean;
  sites: AtlasSearchSite[];
  pages: AtlasSearchPage[];
  captures: AtlasSearchCapture[];
  regions: AtlasSearchRegion[];
  claims: AtlasSearchClaim[];
  /** Raw FTS5 bm25 scores (negative is better), keyed by region id. */
  bm25: Record<string, number>;
  screenshots: Record<string, string[]>;
  artifacts?: AtlasSearchArtifact[];
}
