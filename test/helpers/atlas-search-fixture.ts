import { snapshotAtlasSearchStore } from "../../src/atlas/search.js";
import type {
  AtlasSearchArtifact,
  AtlasSearchCapture,
  AtlasSearchClaim,
  AtlasSearchPage,
  AtlasSearchRegion,
  AtlasSearchSite,
  AtlasSearchSnapshot,
  AtlasSearchStore,
  AtlasSearchViewport,
} from "../../src/atlas/search-types.js";
import type { EvidenceCoverage } from "../../src/atlas/types.js";

export const SEARCH_NOW = Date.UTC(2026, 10, 5, 12);
export const SEARCH_DAY = 86_400_000;

type Decision = "accepted" | "candidate" | "rejected";
type Classification = "observed" | "inferred" | "proposed";
type Basis =
  | "source_title"
  | "source_metadata"
  | "native_semantics"
  | "declared_aria"
  | "computed_style"
  | "geometry"
  | "interaction_observation"
  | "rule_derivation"
  | "human_review";

export interface PurposeSpec {
  value: string;
  decision?: Decision;
  classification?: Classification;
  basis?: Basis;
  sampleKey?: string;
}

export interface SectionSpec {
  id: string;
  purpose?: PurposeSpec | PurposeSpec[];
  claims?: Array<{
    field: string;
    value: string;
    decision?: Decision;
    classification?: Classification;
    basis?: Basis;
    sampleKey?: string;
  }>;
  site?: string;
  siteTitle?: string | null;
  siteUrl?: string | null;
  page?: string;
  pageUrl?: string | null;
  pagePath?: string | null;
  capture?: string;
  viewport?: AtlasSearchViewport;
  status?: "complete" | "partial" | "unknown";
  active?: boolean;
  observedAt?: number | null;
  lastConfirmedAt?: number | null;
  sourceFetchedAt?: number | null;
  ordinal?: number;
  tag?: string | null;
  role?: string | null;
  landmark?: string | null;
  selector?: string | null;
  patternKey?: string | null;
  primaryLabel?: string | null;
  heading?: string;
  text?: string;
  bm25?: number;
  screenshots?: string[];
  artifacts?: Array<{
    kind?: string;
    storagePath: string;
    sha256?: string | null;
    bytes?: number | null;
    mimeType?: string;
  }>;
  coverage?: Partial<EvidenceCoverage>;
}

function coverage(overrides: Partial<EvidenceCoverage> | undefined): EvidenceCoverage {
  return {
    status: "complete",
    collected: 1,
    excluded: 0,
    limitations: [],
    ...overrides,
  };
}

export function makeSnapshot(
  sections: SectionSpec[],
  options: { revision?: number } = {},
): AtlasSearchSnapshot {
  const sites = new Map<string, AtlasSearchSite>();
  const pages = new Map<string, AtlasSearchPage>();
  const captures = new Map<string, AtlasSearchCapture>();
  const regions: AtlasSearchRegion[] = [];
  const claims: AtlasSearchClaim[] = [];
  const bm25: Record<string, number> = {};
  const screenshots: Record<string, string[]> = {};
  const artifacts: AtlasSearchArtifact[] = [];

  sections.forEach((spec, index) => {
    const siteSlug = spec.site ?? "site-a";
    const pageId = spec.page ?? `${siteSlug}:page`;
    const viewport = spec.viewport ?? "desktop";
    const captureId = spec.capture ?? `${pageId}:${viewport}`;
    const observedAt = spec.observedAt === undefined ? SEARCH_NOW - SEARCH_DAY : spec.observedAt;
    sites.set(siteSlug, {
      slug: siteSlug,
      title: spec.siteTitle === undefined ? `${siteSlug} title` : spec.siteTitle,
      liveUrl: spec.siteUrl === undefined ? `https://${siteSlug}.example/` : spec.siteUrl,
    });
    pages.set(pageId, {
      id: pageId,
      siteSlug,
      kind: "live_page",
      publicUrl: spec.pageUrl === undefined ? `https://www.awwwards.com/sites/${siteSlug}` : spec.pageUrl,
      path: spec.pagePath === undefined ? "/" : spec.pagePath,
    });
    if (!captures.has(captureId)) {
      captures.set(captureId, {
        id: captureId,
        pageId,
        profileKey: `live-${viewport}`,
        viewport,
        status: spec.status ?? "complete",
        active: spec.active ?? true,
        observedAt,
        lastConfirmedAt: spec.lastConfirmedAt ?? null,
        sourceFetchedAt: spec.sourceFetchedAt ?? null,
        coverage: coverage(spec.coverage),
      });
    }
    regions.push({
      id: spec.id,
      captureId,
      parentId: null,
      kind: "section",
      ordinal: spec.ordinal ?? index,
      tag: spec.tag === undefined ? "section" : spec.tag,
      role: spec.role ?? null,
      landmark: spec.landmark ?? null,
      selector: spec.selector === undefined ? `main > section.${spec.id}` : spec.selector,
      patternKey: spec.patternKey ?? null,
      primaryLabel: spec.primaryLabel ?? null,
      heading: spec.heading ?? "",
      rawTitle: spec.heading ?? null,
      textExcerpt: spec.text ?? "",
      fingerprint: null,
      coverage: coverage(spec.coverage),
    });
    if (spec.bm25 !== undefined) bm25[spec.id] = spec.bm25;
    if (spec.screenshots) screenshots[captureId] = [...spec.screenshots];
    (spec.artifacts ?? []).forEach((artifact, artifactIndex) => {
      artifacts.push({
        id: `${spec.id}:artifact:${artifactIndex}`,
        captureId,
        regionId: spec.id,
        kind: artifact.kind ?? "raw_observation",
        storagePath: artifact.storagePath,
        sha256: artifact.sha256 ?? null,
        bytes: artifact.bytes ?? null,
        mimeType: artifact.mimeType ?? "application/json",
      });
    });

    const purposes = spec.purpose === undefined ? [] : Array.isArray(spec.purpose) ? spec.purpose : [spec.purpose];
    let claimIndex = 0;
    for (const purpose of purposes) {
      claims.push({
        id: `${spec.id}:purpose:${claimIndex}`,
        regionId: spec.id,
        field: "section.purpose",
        value: purpose.value,
        sampleKey: purpose.sampleKey ?? `${viewport}:${spec.id}`,
        classification: purpose.classification ?? "inferred",
        basis: purpose.basis ?? "rule_derivation",
        decision: purpose.decision ?? "candidate",
        ruleId: null,
      });
      claimIndex += 1;
    }
    for (const claim of spec.claims ?? []) {
      claims.push({
        id: `${spec.id}:${claim.field}:${claimIndex}`,
        regionId: spec.id,
        field: claim.field,
        value: claim.value,
        sampleKey: claim.sampleKey ?? `${viewport}:${spec.id}`,
        classification: claim.classification ?? "inferred",
        basis: claim.basis ?? "rule_derivation",
        decision: claim.decision ?? "candidate",
        ruleId: null,
      });
      claimIndex += 1;
    }
  });

  return {
    revision: options.revision ?? 1,
    asOf: SEARCH_NOW,
    ftsAvailable: true,
    sites: [...sites.values()],
    pages: [...pages.values()],
    captures: [...captures.values()],
    regions,
    claims,
    bm25,
    screenshots,
    artifacts,
  };
}

export function memoryStore(
  snapshot: AtlasSearchSnapshot,
  scores: Record<string, number> = {},
): AtlasSearchStore {
  return snapshotAtlasSearchStore({
    ...snapshot,
    bm25: { ...snapshot.bm25, ...scores },
  });
}
