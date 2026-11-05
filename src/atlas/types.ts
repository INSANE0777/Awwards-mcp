export type AtlasId = string;
export type Timestamp = number;

export type Classification = "observed" | "inferred" | "proposed";
export type EvidenceBasis =
  | "source_title"
  | "source_metadata"
  | "native_semantics"
  | "declared_aria"
  | "computed_style"
  | "geometry"
  | "interaction_observation"
  | "rule_derivation"
  | "human_review";
export type ClaimDecision = "accepted" | "candidate" | "rejected";

export type AtlasSourceKind = "awwwards_item" | "legacy_gallery" | "live_page";
export type AtlasRegionKind = "page" | "highlight" | "section" | "component";
export type AtlasCaptureStatus =
  | "running"
  | "complete"
  | "partial"
  | "unknown"
  | "blocked"
  | "failed"
  | "abandoned";

export type CoverageStatus = "complete" | "partial" | "unknown";

export interface EvidenceCoverage {
  status: CoverageStatus;
  collected: number;
  excluded: number;
  limitations: string[];
}

export interface RightsRecord {
  status: "unknown" | "owned" | "licensed" | "permission";
  reference: string | null;
  recordedAt: Timestamp;
  assertedBy: "unknown" | "caller";
  scope: "local_reference" | "export_copy";
}

export interface EvidenceRef {
  artifactId: AtlasId;
  pointer: string;
  sampleKey: string;
}

export interface AtlasRegionSample {
  geometry?: {
    x: number;
    y: number;
    width: number;
    height: number;
    viewportWidth: number;
    viewportHeight: number;
  };
  mediaPath?: string;
  title?: string;
  [key: string]: unknown;
}

export interface PreparedHighlight {
  title: string;
  mediaPath: string;
  identity: AtlasId;
}

export type HighlightParse =
  | { status: "absent"; items: [] }
  | { status: "parsed"; items: PreparedHighlight[] }
  | { status: "drift"; items: [] };

import type { SiteDetails } from "../types.js";

export interface PreparedLegacyElement {
  identity: AtlasId;
  fallbackSlug: string;
  siteSlug: string;
  title: string;
  mediaPath: string;
  mediaType: "video" | "image" | null;
  author: string;
  fetchedAt: Timestamp;
}

export interface PreparedSitePage {
  slug: string;
  sourceUrl: string;
  fetchedAt: Timestamp;
  sourceDigest: string;
  detail: SiteDetails;
  detailValid: boolean;
  detailEmpty: boolean;
  highlights: PreparedHighlight[];
  highlightParse: HighlightParse;
  legacyElements: PreparedLegacyElement[];
  summary: {
    title: string | null;
    liveUrl: string | null;
  } | null;
  /** Legacy import carries metadata, not the original response body. */
  provenance?: "item_page" | "legacy_import";
  /** null means the original timestamp is unknown (legacy imports only). */
  sourceFetchedAt?: Timestamp | null;
  /** Per-evidence observation times, when the evidence sources differ. */
  evidenceTimes?: { detail: Timestamp | null; elements: Timestamp | null };
  limitations?: string[];
  /** Imported captures can be non-publishable when required metadata is absent. */
  publishable?: boolean;
}

export interface AtlasPageRow {
  id: AtlasId;
  siteSlug: string;
  kind: AtlasSourceKind;
  urlKey: string;
  publicUrl: string | null;
  path: string | null;
  createdAt: Timestamp;
}

export interface AtlasCaptureRow {
  id: AtlasId;
  attemptId: string;
  pageId: AtlasId;
  sourceKind: AtlasSourceKind;
  profileKey: string;
  configHash: string;
  status: AtlasCaptureStatus;
  startedAt: Timestamp;
  finishedAt: Timestamp | null;
  observedAt: Timestamp | null;
  sourceFetchedAt: Timestamp | null;
  sourceDigest: string | null;
  configJson: string;
  policyJson: string;
  coverageJson: string;
  errorJson: string | null;
  extractorVersion: string;
  classifierVersion: string;
}

export interface SitePageCommitResult {
  pageId: AtlasId;
  captureId: AtlasId;
  highlightCount: number;
  highlightParse: HighlightParse["status"];
  published: boolean;
  artifactWritten?: boolean;
}

export interface LegacyGalleryRow {
  slug: string;
  title: string;
  siteSlug: string | null;
  author: string;
  mediaPath: string;
  mediaType: "video" | "image" | null;
  fetchedAt: Timestamp | null;
}

export interface GalleryCommitResult {
  pageId: AtlasId;
  captureId: AtlasId;
  published: boolean;
  artifactWritten?: boolean;
}

export type AtlasAliasKind = "legacy_element_slug" | "legacy_gallery_slug";

export type AliasResolution =
  | {
      status: "resolved";
      aliasKind: AtlasAliasKind;
      alias: string;
      regionId: AtlasId;
      captureId: AtlasId;
      pageId: AtlasId;
      siteSlug: string;
    }
  | {
      status: "ambiguous";
      code: "AMBIGUOUS_ALIAS";
      aliasKind: AtlasAliasKind;
      alias: string;
      regionIds: AtlasId[];
    }
  | {
      status: "not_found";
      aliasKind: AtlasAliasKind;
      alias: string;
    };
