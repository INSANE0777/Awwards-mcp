// Read-only Phase 6A retrieval: Atlas status, taxonomy, one stored region and
// legacy-highlight alias resolution. No network and no gallery fetch.
import type { DatabaseSync } from "node:sqlite";
import type { Cache } from "../cache.js";
import { validateStoredArtifact } from "./artifacts.js";
import { resolveAlias } from "./aliases.js";
import { ATLAS_CLAIMS_LIMIT, ATLAS_ID } from "./tool-limits.js";
import type {
  AtlasArtifactAvailability,
  AtlasHighlightData,
  AtlasParentSummary,
  AtlasRegionData,
  AtlasRegionSummary,
  AtlasStatusData,
  AtlasTaxonomyData,
} from "./tool-contracts.js";
import {
  ATLAS_CLASSIFIER_VERSION_CURRENT,
  ATLAS_FTS_VERSION_CURRENT,
  ATLAS_SCHEMA_VERSION_CURRENT,
  ATLAS_VOCABULARY_VERSION_CURRENT,
  atlasHighlightDataSchema,
  atlasRegionDataSchema,
  atlasStatusDataSchema,
  atlasTaxonomyDataSchema,
  type AtlasEnvelope,
} from "./tool-contracts.js";
import { atlasFailure, atlasSuccess, safeMessage, UNKNOWN_COVERAGE } from "./tool-envelope.js";
import { readAtlasCaptureLease } from "./lease.js";
import { ATLAS_VOCABULARY, ATLAS_VOCABULARY_NAMESPACES } from "./vocabulary.js";
import type { EvidenceCoverage } from "./types.js";

const HEAD_FRESHNESS_MS = 30 * 86_400_000;

interface StateRow {
  schema_version: number;
  fts_version: number;
  revision: number;
  vocabulary_version: string;
  classifier_version: string;
  updated_at: number;
}

function parseJson<T>(text: string | null | undefined): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function clip(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  return value.length > max ? value.slice(0, max) : value;
}

function sanitizeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return clip(url.toString(), 1024);
  } catch {
    return null;
  }
}

function coverageOf(text: string | null | undefined): EvidenceCoverage {
  const parsed = parseJson<EvidenceCoverage>(text);
  if (
    parsed &&
    (parsed.status === "complete" || parsed.status === "partial" || parsed.status === "unknown") &&
    Array.isArray(parsed.limitations)
  ) {
    return {
      status: parsed.status,
      collected: Number.isFinite(parsed.collected) ? Math.max(0, Math.trunc(parsed.collected)) : 0,
      excluded: Number.isFinite(parsed.excluded) ? Math.max(0, Math.trunc(parsed.excluded)) : 0,
      limitations: parsed.limitations
        .filter((item): item is string => typeof item === "string")
        .slice(0, 16)
        .map((item) => item.slice(0, 100)),
    };
  }
  return UNKNOWN_COVERAGE;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name) !==
    undefined
  );
}

function emptyCounts(): AtlasStatusData["counts"] {
  return {
    sources: { awwwardsItem: 0, legacyGallery: 0, livePage: 0 },
    regions: { page: 0, highlight: 0, section: 0, component: 0 },
    captures: { running: 0, complete: 0, partial: 0, unknown: 0, blocked: 0, failed: 0, abandoned: 0 },
  };
}

function baseStatus(cache: Cache, enabled: boolean): AtlasStatusData {
  return {
    enabled,
    available: false,
    versions: {
      schema: null,
      fts: null,
      vocabulary: null,
      classifier: null,
      currentSchema: ATLAS_SCHEMA_VERSION_CURRENT,
      currentFts: ATLAS_FTS_VERSION_CURRENT,
      currentVocabulary: ATLAS_VOCABULARY_VERSION_CURRENT,
      currentClassifier: ATLAS_CLASSIFIER_VERSION_CURRENT,
    },
    revision: null,
    updatedAt: null,
    counts: emptyCounts(),
    liveCaptures: { fresh: 0, stale: 0, total: 0 },
    latestPublication: null,
    latestFailedAttempt: null,
    lease: { state: "free", expiresAt: null, ttlSeconds: null },
    artifacts: { records: 0, distinctHashes: 0, bytes: 0, readyRecords: 0 },
    fts: { available: false, version: null },
    coverageNote:
      "Locally cached subset only; live-capture freshness is 30 days. Counts describe this cache, not all of Awwwards.",
  };
}

function readStatus(cache: Cache, now: number): AtlasStatusData {
  // Direct callers bypass the get_atlas gate, so the flag comes from the cache.
  const data = baseStatus(cache, cache.atlas === true);
  data.lease = readAtlasCaptureLease(cache.rootDir, now);
  try {
    return cache.withAtlasReadDb((db) => {
      if (!tableExists(db, "atlas_state")) return data;
      const state = db
        .prepare(
          `SELECT schema_version, fts_version, revision, vocabulary_version,
                  classifier_version, updated_at
             FROM atlas_state WHERE singleton = 1`,
        )
        .get() as StateRow | undefined;
      if (!state) return data;
      data.available = true;
      data.versions.schema = Number(state.schema_version);
      data.versions.fts = Number(state.fts_version);
      data.versions.vocabulary = clip(state.vocabulary_version, 100);
      data.versions.classifier = clip(state.classifier_version, 100);
      data.revision = Math.max(0, Math.trunc(Number(state.revision) || 0));
      data.updatedAt = Math.max(0, Math.trunc(Number(state.updated_at) || 0));
      data.fts = {
        available: tableExists(db, "atlas_regions_fts"),
        version: data.versions.fts,
      };

      for (const row of db
        .prepare("SELECT kind, COUNT(*) AS n FROM atlas_pages GROUP BY kind")
        .all() as Array<{ kind: string; n: number }>) {
        if (row.kind === "awwwards_item") data.counts.sources.awwwardsItem = Number(row.n);
        if (row.kind === "legacy_gallery") data.counts.sources.legacyGallery = Number(row.n);
        if (row.kind === "live_page") data.counts.sources.livePage = Number(row.n);
      }
      for (const row of db
        .prepare("SELECT kind, COUNT(*) AS n FROM atlas_regions GROUP BY kind")
        .all() as Array<{ kind: string; n: number }>) {
        if (row.kind === "page") data.counts.regions.page = Number(row.n);
        if (row.kind === "highlight") data.counts.regions.highlight = Number(row.n);
        if (row.kind === "section") data.counts.regions.section = Number(row.n);
        if (row.kind === "component") data.counts.regions.component = Number(row.n);
      }
      for (const row of db
        .prepare("SELECT status, COUNT(*) AS n FROM atlas_captures GROUP BY status")
        .all() as Array<{ status: string; n: number }>) {
        const key = row.status as keyof AtlasStatusData["counts"]["captures"];
        if (key in data.counts.captures) data.counts.captures[key] = Number(row.n);
      }

      const fresh = db
        .prepare(
          `SELECT COUNT(*) AS total,
                  COALESCE(SUM(CASE WHEN COALESCE(c.last_confirmed_at, c.observed_at,
                    c.source_fetched_at, c.finished_at) >= ?
                    THEN 1 ELSE 0 END), 0) AS fresh
             FROM atlas_heads h
             JOIN atlas_captures c
               ON c.id = h.capture_id AND c.page_id = h.page_id AND c.profile_key = h.profile_key
             JOIN atlas_pages p ON p.id = h.page_id
            WHERE p.kind = 'live_page' AND c.status IN ('complete','partial')`,
        )
        .get(now - HEAD_FRESHNESS_MS) as { total: number; fresh: number };
      data.liveCaptures = {
        total: Number(fresh.total),
        fresh: Number(fresh.fresh),
        stale: Math.max(0, Number(fresh.total) - Number(fresh.fresh)),
      };

      const publication = db
        .prepare(
          `SELECT h.published_at, h.page_id, h.capture_id, h.profile_key
             FROM atlas_heads h
            ORDER BY h.published_at DESC, h.capture_id DESC LIMIT 1`,
        )
        .get() as
        | {
            published_at: number;
            page_id: string;
            capture_id: string;
            profile_key: string;
          }
        | undefined;
      data.latestPublication = publication
        ? {
            publishedAt: Number(publication.published_at),
            pageId: publication.page_id,
            captureId: publication.capture_id,
            profileKey: publication.profile_key,
          }
        : null;

      const failed = db
        .prepare(
          `SELECT c.id AS capture_id, c.page_id, c.status, c.started_at,
                  c.finished_at, c.error_json
             FROM atlas_captures c
            WHERE c.status IN ('blocked','failed','abandoned','unknown')
            ORDER BY COALESCE(c.finished_at, c.started_at) DESC, c.id DESC LIMIT 1`,
        )
        .get() as
        | {
            capture_id: string;
            page_id: string;
            status: string;
            started_at: number;
            finished_at: number | null;
            error_json: string | null;
          }
        | undefined;
      if (failed) {
        const body = parseJson<{ code?: unknown; message?: unknown; error?: unknown }>(
          failed.error_json,
        );
        const rawMessage =
          typeof body?.message === "string"
            ? body.message
            : typeof body?.error === "string"
              ? body.error
              : null;
        const prefix = typeof body?.code === "string" ? `[${body.code}] ` : "";
        const message =
          rawMessage === null
            ? typeof body?.code === "string"
              ? body.code
              : null
            : `${prefix}${rawMessage}`;
        data.latestFailedAttempt = {
          captureId: failed.capture_id,
          pageId: failed.page_id,
          status: failed.status,
          startedAt: Math.max(0, Number(failed.started_at) || 0),
          finishedAt: failed.finished_at === null ? null : Math.max(0, Number(failed.finished_at) || 0),
          error: message === null ? null : safeMessage(message, cache.rootDir).slice(0, 300),
        };
      }

      const artifacts = db
        .prepare(
          `SELECT COUNT(*) AS records, COUNT(DISTINCT sha256) AS distinct_hashes,
                  COALESCE(SUM(CASE WHEN state = 'ready' THEN 1 ELSE 0 END), 0) AS ready_records
             FROM atlas_artifacts WHERE sha256 IS NOT NULL`,
        )
        .get() as { records: number; distinct_hashes: number; ready_records: number };
      const bytes = db
        .prepare(
          `SELECT COALESCE(SUM(bytes), 0) AS bytes FROM (
             SELECT MAX(bytes) AS bytes FROM atlas_artifacts
              WHERE sha256 IS NOT NULL GROUP BY sha256)`,
        )
        .get() as { bytes: number };
      data.artifacts = {
        records: Number(artifacts.records),
        distinctHashes: Number(artifacts.distinct_hashes),
        readyRecords: Number(artifacts.ready_records),
        bytes: Math.max(0, Number(bytes.bytes) || 0),
      };
      return data;
    });
  } catch {
    return data;
  }
}

export function runAtlasStatus(cache: Cache, now: number): AtlasEnvelope<AtlasStatusData> {
  const data = readStatus(cache, now);
  return atlasSuccess("get_atlas.status", "ok", atlasStatusDataSchema.parse(data), {
    status: "complete",
    collected: data.counts.captures.complete + data.counts.captures.partial,
    excluded: 0,
    limitations: [],
  });
}

const UNSUPPORTED_OPERATIONS: AtlasTaxonomyData["unsupported"] = [
  {
    operation: "state.click",
    reason: "Click, type, submit, drag, keyboard navigation and route transitions are never performed.",
  },
  {
    operation: "accepted.inferred_component_type",
    reason: "Card, drawer, carousel, icon_button and tooltip are candidate-only until human labels exist.",
  },
  {
    operation: "cross_site.combination",
    reason: "Scopes are same region, same page or same site; trait combinations never combine across regions.",
  },
  {
    operation: "asset.download",
    reason: "Search, retrieval and export never download missing third-party assets.",
  },
  {
    operation: "color.similarity",
    reason: "No color-similarity search is implemented.",
  },
  {
    operation: "vector.semantic_search",
    reason: "Search is SQLite FTS5 plus explicit predicates; no embeddings are used.",
  },
  {
    operation: "gallery.fetch",
    reason: "Highlights resolve only through stored Atlas aliases; the legacy gallery is not fetched.",
  },
  {
    operation: "arbitrary_url.capture",
    reason: "Capture accepts a known site slug and a path on its known live origin.",
  },
  {
    operation: "reduced_motion.comparison",
    reason: "Reduced-motion comparison is not collected in this release.",
  },
];

export function runAtlasTaxonomy(): AtlasEnvelope<AtlasTaxonomyData> {
  const fields: AtlasTaxonomyData["fields"] = ATLAS_VOCABULARY_NAMESPACES.map((namespace) => ({
    field: namespace.field,
    support: namespace.support,
    provider: namespace.provider,
    values: ATLAS_VOCABULARY.filter((entry) => entry.field === namespace.field).map((entry) => ({
      value: entry.value,
      label: entry.label,
      support: entry.support,
      enabled: entry.enabled,
      searchable: entry.searchable,
      permittedBases: [...entry.permittedBases],
      aliases: [...entry.aliases],
      ruleIds: [...entry.ruleIds],
    })),
  }));
  const data: AtlasTaxonomyData = {
    registryVersion: ATLAS_VOCABULARY_VERSION_CURRENT,
    fields,
    scopes: ["region", "page", "site"],
    states: ["default", "hover", "focus"],
    evidenceModes: ["accepted", "observed_only", "candidate"],
    groupBy: ["instance", "pattern"],
    unsupported: UNSUPPORTED_OPERATIONS,
  };
  return atlasSuccess("get_atlas.taxonomy", "ok", atlasTaxonomyDataSchema.parse(data), {
    status: "complete",
    collected: fields.length,
    excluded: 0,
    limitations: [],
  });
}

interface RegionRow {
  id: string;
  capture_id: string;
  parent_id: string | null;
  kind: string;
  ordinal: number;
  locator_json: string | null;
  fingerprint: string | null;
  heading: string;
  text_excerpt: string;
  raw_title: string | null;
  primary_label: string | null;
  samples_json: string;
  pattern_key: string | null;
  coverage_json: string;
  page_id: string;
  source_kind: string;
  profile_key: string;
  status: string;
  started_at: number;
  finished_at: number | null;
  observed_at: number | null;
  last_confirmed_at: number | null;
  source_fetched_at: number | null;
  config_hash: string;
  extractor_version: string;
  classifier_version: string;
  config_json: string;
  policy_json: string;
  site_slug: string;
  public_url: string | null;
  path: string | null;
}

interface RegionRowMinimal {
  id: string;
  capture_id: string;
  parent_id: string | null;
  kind: string;
  ordinal: number;
  locator_json: string | null;
  heading: string;
  raw_title: string | null;
  primary_label: string | null;
  samples_json: string;
  pattern_key: string | null;
  coverage_json: string;
}

function locatorOf(text: string | null): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(text) ?? {};
}

function samplesOf(text: string): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(text) ?? {};
}

function sampleKeysOf(samples: Record<string, unknown>): string[] {
  const keys: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (keys.length >= 24 || depth > 5 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "sampleKey" && typeof child === "string" && !keys.includes(child)) {
        keys.push(child.slice(0, 256));
      } else {
        visit(child, depth + 1);
      }
    }
  };
  visit(samples, 0);
  return keys;
}

function geometryOf(samples: Record<string, unknown>): AtlasRegionSummary["rect"] {
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

function summaryFields(row: RegionRowMinimal): Omit<AtlasRegionSummary, "kind"> {
  const locator = locatorOf(row.locator_json);
  const samples = samplesOf(row.samples_json);
  return {
    regionId: row.id,
    ordinal: Math.max(0, Number(row.ordinal) || 0),
    tag: clip(typeof locator.tag === "string" ? locator.tag : null, 50),
    role: clip(typeof samples.role === "string" ? samples.role : null, 100),
    landmark: clip(typeof samples.landmark === "string" ? samples.landmark : null, 100),
    selector: clip(typeof locator.selector === "string" ? locator.selector : null, 512),
    heading: (row.heading ?? "").slice(0, 200),
    primaryLabel: clip(row.primary_label, 200),
    type: row.kind === "component" ? clip(row.primary_label, 100) : null,
    patternKey: clip(row.pattern_key, 256),
    rect: geometryOf(samples),
    visible: typeof samples.visible === "boolean" ? samples.visible : null,
    state: typeof samples.state === "string" ? samples.state.slice(0, 50) : null,
    coverage: coverageOf(row.coverage_json),
  };
}

function summaryOf(row: RegionRowMinimal): AtlasRegionSummary {
  return {
    ...summaryFields(row),
    kind: row.kind === "component" ? "component" : "section",
  };
}

function parentSummaryOf(row: RegionRowMinimal): AtlasParentSummary {
  return {
    ...summaryFields(row),
    kind: row.kind === "page" ? "page" : row.kind === "component" ? "component" : "section",
  };
}

interface ArtifactRow {
  id: string;
  capture_id: string;
  region_id: string | null;
  kind: string;
  storage_path: string | null;
  sha256: string | null;
  bytes: number | null;
  mime_type: string;
  state: string;
}

export function artifactAvailabilityOf(
  cacheRoot: string,
  row: ArtifactRow,
): AtlasArtifactAvailability {
  const stored =
    row.storage_path && row.sha256 && row.bytes !== null
      ? { storagePath: row.storage_path, sha256: row.sha256, bytes: row.bytes }
      : null;
  const note = stored === null ? "artifact has no stored content" : validateStoredArtifact(cacheRoot, stored);
  return {
    artifactId: row.id,
    captureId: row.capture_id,
    regionId: row.region_id,
    kind: row.kind.slice(0, 100),
    storagePath: clip(row.storage_path, 1024),
    sha256: clip(row.sha256, 128),
    bytes: row.bytes === null ? null : Math.max(0, Number(row.bytes)),
    mimeType: row.mime_type.slice(0, 200),
    state:
      row.state === "ready" ||
      row.state === "missing" ||
      row.state === "corrupt" ||
      row.state === "restricted"
        ? row.state
        : "missing",
    available: note === null,
    availabilityNote: note === null ? null : note.slice(0, 300),
  };
}

function loadRegion(cache: Cache, regionId: string): AtlasRegionData | null {
  return cache.withAtlasReadDb((db) => {
    const row = db
      .prepare(
        `SELECT r.id, r.capture_id, r.parent_id, r.kind, r.ordinal, r.locator_json,
                r.fingerprint, r.heading, r.text_excerpt, r.raw_title, r.primary_label,
                r.samples_json, r.pattern_key, r.coverage_json,
                c.page_id, c.source_kind, c.profile_key, c.status, c.started_at, c.finished_at,
                c.observed_at, c.last_confirmed_at, c.source_fetched_at, c.config_hash,
                c.extractor_version, c.classifier_version, c.config_json, c.policy_json,
                p.site_slug, p.public_url, p.path
           FROM atlas_regions r
           JOIN atlas_captures c ON c.id = r.capture_id
           JOIN atlas_pages p ON p.id = c.page_id
          WHERE r.id = ?`,
      )
      .get(regionId) as RegionRow | undefined;
    if (!row) return null;

    const locator = locatorOf(row.locator_json);
    const samples = samplesOf(row.samples_json);
    const config = parseJson<Record<string, unknown>>(row.config_json) ?? {};
    const policy = parseJson<Record<string, unknown>>(row.policy_json) ?? {};
    const target = (config.target ?? {}) as Record<string, unknown>;
    const states = Array.isArray(config.states) ? config.states : [];

    const childrenRows = db
      .prepare(
        `SELECT id, capture_id, parent_id, kind, ordinal, locator_json, heading, raw_title,
                primary_label, samples_json, pattern_key, coverage_json
           FROM atlas_regions
          WHERE parent_id = ? AND kind IN ('section','component')
          ORDER BY ordinal, id LIMIT 25`,
      )
      .all(regionId) as unknown as RegionRowMinimal[];
    const parentRow = row.parent_id
      ? (db
          .prepare(
            `SELECT id, capture_id, parent_id, kind, ordinal, locator_json, heading, raw_title,
                    primary_label, samples_json, pattern_key, coverage_json
               FROM atlas_regions WHERE id = ?`,
          )
          .get(row.parent_id) as RegionRowMinimal | undefined)
      : undefined;

    const claims = db
      .prepare(
        `SELECT id, field, value, sample_key, classification, basis, decision, state,
                rule_id, rule_version, evidence_json, limitations_json
           FROM atlas_claims WHERE region_id = ?
          ORDER BY state, field, value, id LIMIT ${ATLAS_CLAIMS_LIMIT + 1}`,
      )
      .all(regionId) as Array<{
        id: string;
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
      }>;

    const artifacts = db
      .prepare(
        `SELECT id, capture_id, region_id, kind, storage_path, sha256, bytes, mime_type, state
           FROM atlas_artifacts
          WHERE capture_id = ? AND (region_id = ? OR region_id IS NULL)
          ORDER BY id LIMIT 33`,
      )
      .all(row.capture_id, regionId) as unknown as ArtifactRow[];

    const head = db
      .prepare(
        "SELECT capture_id, published_at FROM atlas_heads WHERE page_id = ? AND profile_key = ?",
      )
      .get(row.page_id, row.profile_key) as
      | { capture_id: string; published_at: number }
      | undefined;

    const claimItems: AtlasRegionData["claims"] = claims.slice(0, ATLAS_CLAIMS_LIMIT).map((claim) => {
      const evidence = parseJson<Array<Record<string, unknown>>>(claim.evidence_json) ?? [];
      const limitations = parseJson<unknown[]>(claim.limitations_json) ?? [];
      return {
        claimId: claim.id,
        field: claim.field.slice(0, 100),
        value: claim.value.slice(0, 200),
        sampleKey: claim.sample_key.slice(0, 256),
        state: claim.state.slice(0, 50),
        classification:
          claim.classification === "observed" ||
          claim.classification === "inferred" ||
          claim.classification === "proposed"
            ? claim.classification
            : "inferred",
        basis: claim.basis.slice(0, 100),
        decision:
          claim.decision === "accepted" || claim.decision === "rejected"
            ? claim.decision
            : "candidate",
        ruleId: clip(claim.rule_id, 200),
        ruleVersion: clip(claim.rule_version, 100),
        evidence: evidence.slice(0, 8).flatMap((item) =>
          item &&
          typeof item === "object" &&
          typeof item.artifactId === "string" &&
          typeof item.pointer === "string" &&
          typeof item.sampleKey === "string"
            ? [
                {
                  artifactId: item.artifactId.slice(0, 128),
                  pointer: item.pointer.slice(0, 1000),
                  sampleKey: item.sampleKey.slice(0, 256),
                },
              ]
            : [],
        ),
        limitations: limitations
          .filter((item): item is string => typeof item === "string")
          .slice(0, 16)
          .map((item) => item.slice(0, 200)),
      };
    });

    const data: AtlasRegionData = {
      region: {
        regionId: row.id,
        captureId: row.capture_id,
        pageId: row.page_id,
        parentId: row.parent_id,
        kind:
          row.kind === "page" ||
          row.kind === "highlight" ||
          row.kind === "component" ||
          row.kind === "section"
            ? row.kind
            : "section",
        ordinal: Math.max(0, Number(row.ordinal) || 0),
        tag: clip(typeof locator.tag === "string" ? locator.tag : null, 50),
        role: clip(typeof samples.role === "string" ? samples.role : null, 100),
        landmark: clip(typeof samples.landmark === "string" ? samples.landmark : null, 100),
        selector: clip(typeof locator.selector === "string" ? locator.selector : null, 512),
        heading: (row.heading ?? "").slice(0, 300),
        textExcerpt: (row.text_excerpt ?? "").slice(0, 4000),
        rawTitle: clip(row.raw_title, 300),
        primaryLabel: clip(row.primary_label, 200),
        patternKey: clip(row.pattern_key, 256),
        fingerprint: clip(row.fingerprint, 128),
        coverage: coverageOf(row.coverage_json),
        sampleKeys: sampleKeysOf(samples),
        geometry: geometryOf(samples),
        viewport: clip(typeof samples.viewport === "string" ? samples.viewport : null, 50),
      },
      capture: {
        captureId: row.capture_id,
        pageId: row.page_id,
        siteSlug: row.site_slug,
        sourceKind: row.source_kind,
        profileKey: row.profile_key,
        status: row.status,
        startedAt: Math.max(0, Number(row.started_at) || 0),
        finishedAt: row.finished_at === null ? null : Math.max(0, Number(row.finished_at) || 0),
        observedAt: row.observed_at === null ? null : Math.max(0, Number(row.observed_at) || 0),
        lastConfirmedAt:
          row.last_confirmed_at === null ? null : Math.max(0, Number(row.last_confirmed_at) || 0),
        sourceFetchedAt:
          row.source_fetched_at === null ? null : Math.max(0, Number(row.source_fetched_at) || 0),
        configHash: row.config_hash,
        extractorVersion: row.extractor_version.slice(0, 100),
        classifierVersion: row.classifier_version.slice(0, 100),
        policy: {
          robots: clip(typeof policy.robots === "string" ? policy.robots : null, 50),
          publicOnly: typeof policy.publicOnly === "boolean" ? policy.publicOnly : null,
        },
        conditions: {
          browserVersion: clip(
            typeof config.browserVersion === "string" ? config.browserVersion : null,
            200,
          ),
          dpr: typeof config.dpr === "number" && Number.isFinite(config.dpr) ? config.dpr : null,
          reducedMotion: clip(
            typeof config.reducedMotion === "string" ? config.reducedMotion : null,
            50,
          ),
          viewport: clip(typeof config.viewport === "string" ? config.viewport : null, 50),
          requestedStates: states.slice(0, 8).flatMap((state) => {
            if (!state || typeof state !== "object") return [];
            const record = state as Record<string, unknown>;
            if (typeof record.action !== "string") return [];
            const target = typeof record.targetRegionId === "string" ? record.targetRegionId : "";
            return [`${record.action}:${target}`.slice(0, 200)];
          }),
        },
        source: {
          publicUrl: sanitizeUrl(row.public_url),
          path: clip(row.path, 512),
          requestedUrl: sanitizeUrl(
            typeof target.requestedUrl === "string" ? target.requestedUrl : null,
          ),
        },
      },
      claims: claimItems,
      claimsTruncated: claims.length > ATLAS_CLAIMS_LIMIT,
      artifacts: artifacts
        .slice(0, 32)
        .map((artifact) => artifactAvailabilityOf(cache.rootDir, artifact)),
      artifactsTruncated: artifacts.length > 32,
      parent: parentRow ? parentSummaryOf(parentRow) : null,
      children: childrenRows.slice(0, 24).map(summaryOf),
      childrenTruncated: childrenRows.length > 24,
      head: {
        current: head?.capture_id === row.capture_id,
        headCaptureId: head ? head.capture_id : null,
        publishedAt: head ? Math.max(0, Number(head.published_at) || 0) : null,
      },
    };
    return atlasRegionDataSchema.parse(data);
  });
}

// A newer stored schema or a vanished column/table means this build cannot
// read the cache at all; anything else (disk, lock, corruption) is an
// operational read failure that a retry may recover.
const SCHEMA_DRIFT =
  /Atlas cache schema \d+ is newer than supported|no such (?:table|column):|has no column named/i;

function readFailure(
  operation: string,
  cache: Cache,
  error: unknown,
): AtlasEnvelope<never> {
  const raw = error instanceof Error ? error.message : String(error);
  const drift = SCHEMA_DRIFT.test(raw);
  return atlasFailure(
    operation,
    drift ? "SCHEMA_TOO_NEW" : "ATLAS_READ_FAILED",
    safeMessage(raw, cache.rootDir),
    !drift,
  );
}

export function runAtlasRegion(
  cache: Cache,
  regionId: string,
): AtlasEnvelope<AtlasRegionData> {
  if (!ATLAS_ID.test(regionId)) {
    return atlasFailure("get_atlas.region", "INVALID_INPUT", "regionId must be 64 lowercase hex characters", false);
  }
  try {
    const data = loadRegion(cache, regionId);
    if (!data) {
      return atlasFailure("get_atlas.region", "REGION_NOT_FOUND", "No stored Atlas region has that id", false);
    }
    return atlasSuccess("get_atlas.region", "ok", data, data.region.coverage);
  } catch (error) {
    return readFailure("get_atlas.region", cache, error);
  }
}

export function runAtlasHighlight(
  cache: Cache,
  elementId: string,
): AtlasEnvelope<AtlasHighlightData> {
  try {
    let resolution = resolveAlias(cache, "legacy_element_slug", elementId);
    if (resolution.status === "not_found") {
      resolution = resolveAlias(cache, "legacy_gallery_slug", elementId);
    }
    if (resolution.status === "not_found") {
      const data: AtlasHighlightData = {
        elementId,
        status: "not_found",
        aliasKind: null,
        regionIds: [],
        region: null,
      };
      return atlasSuccess("get_atlas.highlight", "inconclusive", data, UNKNOWN_COVERAGE);
    }
    if (resolution.status === "ambiguous") {
      const data: AtlasHighlightData = {
        elementId,
        status: "ambiguous",
        aliasKind: resolution.aliasKind,
        regionIds: resolution.regionIds.slice(0, 64),
        region: null,
      };
      return {
        schemaVersion: "awwwards-atlas-v1",
        operation: "get_atlas.highlight",
        status: "inconclusive",
        data: atlasHighlightDataSchema.parse(data),
        coverage: UNKNOWN_COVERAGE,
        warnings: [],
        error: {
          code: "AMBIGUOUS_ALIAS",
          message:
            "The element id resolves to more than one Atlas region; choose one of the returned region ids",
          retryable: false,
        },
      };
    }
    const region = loadRegion(cache, resolution.regionId);
    if (!region) {
      return atlasFailure(
        "get_atlas.highlight",
        "ARTIFACT_MISSING",
        "The alias points at a region that is not present",
        false,
        "inconclusive",
      );
    }
    const data: AtlasHighlightData = {
      elementId,
      status: "resolved",
      aliasKind: resolution.aliasKind,
      regionIds: [resolution.regionId],
      region,
    };
    return atlasSuccess("get_atlas.highlight", "ok", atlasHighlightDataSchema.parse(data), region.region.coverage);
  } catch (error) {
    return readFailure("get_atlas.highlight", cache, error);
  }
}
