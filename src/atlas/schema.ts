import type { DatabaseSync } from "node:sqlite";
import { removeHead } from "./heads.js";
import { ATLAS_VOCABULARY_VERSION } from "./vocabulary.js";

export const ATLAS_SCHEMA_VERSION = 6;
export const ATLAS_FTS_VERSION = 2;
export const ATLAS_CLASSIFIER_VERSION = "atlas-classifier-0";

const BASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS atlas_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL,
    fts_version INTEGER NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    vocabulary_version TEXT NOT NULL,
    classifier_version TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS atlas_pages (
    id TEXT PRIMARY KEY,
    site_slug TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('awwwards_item','legacy_gallery','live_page')),
    url_key TEXT NOT NULL,
    public_url TEXT,
    path TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (site_slug, kind, url_key)
  );
  CREATE INDEX IF NOT EXISTS atlas_pages_site_idx ON atlas_pages(site_slug, kind);
  CREATE INDEX IF NOT EXISTS atlas_pages_url_idx ON atlas_pages(url_key);

  CREATE TABLE IF NOT EXISTS atlas_captures (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL UNIQUE,
    page_id TEXT NOT NULL REFERENCES atlas_pages(id),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('awwwards_item','legacy_gallery','live_page')),
    profile_key TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running','complete','partial','unknown','blocked','failed','abandoned')),
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    observed_at INTEGER,
    source_fetched_at INTEGER,
    last_confirmed_at INTEGER,
    source_digest TEXT,
    config_json TEXT NOT NULL CHECK (json_valid(config_json)),
    policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
    coverage_json TEXT NOT NULL CHECK (json_valid(coverage_json)),
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    extractor_version TEXT NOT NULL,
    classifier_version TEXT NOT NULL,
    UNIQUE (id, page_id, profile_key),
    CHECK (status = 'running' OR finished_at IS NOT NULL)
  );
  CREATE INDEX IF NOT EXISTS atlas_captures_head_idx ON atlas_captures(page_id, profile_key, finished_at DESC);
  CREATE INDEX IF NOT EXISTS atlas_captures_config_idx ON atlas_captures(config_hash, finished_at DESC);
  CREATE INDEX IF NOT EXISTS atlas_captures_status_idx ON atlas_captures(status, started_at);

  CREATE TABLE IF NOT EXISTS atlas_regions (
    id TEXT PRIMARY KEY,
    capture_id TEXT NOT NULL REFERENCES atlas_captures(id),
    parent_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('page','highlight','section','component')),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    locator_json TEXT CHECK (locator_json IS NULL OR json_valid(locator_json)),
    fingerprint TEXT,
    heading TEXT NOT NULL DEFAULT '',
    text_excerpt TEXT NOT NULL DEFAULT '',
    raw_title TEXT,
    primary_label TEXT,
    samples_json TEXT NOT NULL CHECK (json_valid(samples_json)),
    pattern_key TEXT,
    coverage_json TEXT NOT NULL CHECK (json_valid(coverage_json)),
    UNIQUE (id, capture_id),
    FOREIGN KEY (parent_id, capture_id) REFERENCES atlas_regions(id, capture_id)
  );
  CREATE INDEX IF NOT EXISTS atlas_regions_capture_idx ON atlas_regions(capture_id, kind, ordinal);
  CREATE INDEX IF NOT EXISTS atlas_regions_parent_idx ON atlas_regions(parent_id, ordinal);
  CREATE INDEX IF NOT EXISTS atlas_regions_pattern_idx ON atlas_regions(capture_id, pattern_key);

  CREATE TABLE IF NOT EXISTS atlas_claims (
    id TEXT PRIMARY KEY,
    region_id TEXT NOT NULL REFERENCES atlas_regions(id),
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    sample_key TEXT NOT NULL,
    classification TEXT NOT NULL CHECK (classification IN ('observed','inferred','proposed')),
    basis TEXT NOT NULL CHECK (basis IN ('source_title','source_metadata','native_semantics','declared_aria','computed_style','geometry','interaction_observation','rule_derivation','human_review')),
    decision TEXT NOT NULL CHECK (decision IN ('accepted','candidate','rejected')),
    rule_id TEXT,
    rule_version TEXT,
    evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
    limitations_json TEXT NOT NULL CHECK (json_valid(limitations_json)),
    review_json TEXT CHECK (review_json IS NULL OR json_valid(review_json))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS atlas_claims_unique
    ON atlas_claims(region_id, field, value, sample_key, basis, COALESCE(rule_id, ''));
  CREATE INDEX IF NOT EXISTS atlas_claims_field_idx
    ON atlas_claims(field, value, decision, region_id, sample_key);
  CREATE INDEX IF NOT EXISTS atlas_claims_region_idx ON atlas_claims(region_id, decision);
  CREATE INDEX IF NOT EXISTS atlas_claims_decision_idx ON atlas_claims(decision, classification);

  CREATE TABLE IF NOT EXISTS atlas_artifacts (
    id TEXT PRIMARY KEY,
    capture_id TEXT NOT NULL REFERENCES atlas_captures(id),
    region_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('source_metadata','raw_observation','screenshot','component_pack','tokens','external_media')),
    storage_path TEXT,
    external_url TEXT,
    sha256 TEXT,
    bytes INTEGER,
    mime_type TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('ready','missing','corrupt','restricted')),
    rights_json TEXT NOT NULL CHECK (json_valid(rights_json)),
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
    CHECK ((storage_path IS NULL) <> (external_url IS NULL)),
    CHECK (storage_path IS NULL OR (sha256 IS NOT NULL AND bytes IS NOT NULL)),
    FOREIGN KEY (region_id, capture_id) REFERENCES atlas_regions(id, capture_id)
  );
  CREATE INDEX IF NOT EXISTS atlas_artifacts_capture_idx ON atlas_artifacts(capture_id, kind);
  CREATE INDEX IF NOT EXISTS atlas_artifacts_region_idx ON atlas_artifacts(region_id, kind);
  CREATE INDEX IF NOT EXISTS atlas_artifacts_hash_idx ON atlas_artifacts(sha256);

  CREATE TABLE IF NOT EXISTS atlas_aliases (
    alias_kind TEXT NOT NULL CHECK (alias_kind IN ('legacy_element_slug','legacy_gallery_slug')),
    alias TEXT NOT NULL,
    region_id TEXT NOT NULL REFERENCES atlas_regions(id),
    PRIMARY KEY (alias_kind, alias, region_id)
  );
`;

const HEADS_AND_FTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS atlas_heads (
    page_id TEXT NOT NULL REFERENCES atlas_pages(id),
    profile_key TEXT NOT NULL,
    capture_id TEXT NOT NULL,
    published_at INTEGER NOT NULL,
    PRIMARY KEY (page_id, profile_key),
    FOREIGN KEY (capture_id, page_id, profile_key)
      REFERENCES atlas_captures(id, page_id, profile_key)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS atlas_regions_fts USING fts5(
    region_id UNINDEXED,
    title,
    heading,
    copy,
    labels,
    context,
    tokenize = 'porter unicode61'
  );
`;

const PACKS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS atlas_packs (
    id TEXT PRIMARY KEY,
    storage_path TEXT NOT NULL UNIQUE,
    manifest_hash TEXT NOT NULL,
    selection_json TEXT NOT NULL CHECK (json_valid(selection_json)),
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('ready','missing','corrupt')),
    exporter_version TEXT NOT NULL
  );
`;

const INVARIANTS_SCHEMA = `
  CREATE UNIQUE INDEX IF NOT EXISTS atlas_regions_page_root_uq
    ON atlas_regions(capture_id) WHERE kind = 'page';

  CREATE TRIGGER IF NOT EXISTS atlas_heads_require_root_ai
  BEFORE INSERT ON atlas_heads
  WHEN (SELECT COUNT(*) FROM atlas_regions WHERE capture_id = NEW.capture_id AND kind = 'page') <> 1
  BEGIN
    SELECT RAISE(ABORT, 'atlas_heads requires exactly one page root');
  END;

  CREATE TRIGGER IF NOT EXISTS atlas_heads_require_root_au
  BEFORE UPDATE OF capture_id ON atlas_heads
  WHEN (SELECT COUNT(*) FROM atlas_regions WHERE capture_id = NEW.capture_id AND kind = 'page') <> 1
  BEGIN
    SELECT RAISE(ABORT, 'atlas_heads requires exactly one page root');
  END;

  CREATE TRIGGER IF NOT EXISTS atlas_regions_root_delete_guard
  BEFORE DELETE ON atlas_regions
  WHEN OLD.kind = 'page'
    AND EXISTS (SELECT 1 FROM atlas_heads WHERE capture_id = OLD.capture_id)
  BEGIN
    SELECT RAISE(ABORT, 'cannot delete the page root of an active capture');
  END;

  CREATE TRIGGER IF NOT EXISTS atlas_regions_root_update_guard
  BEFORE UPDATE OF kind, parent_id, capture_id ON atlas_regions
  WHEN OLD.kind = 'page'
    AND (NEW.kind <> 'page' OR NEW.parent_id IS NOT NULL OR NEW.capture_id <> OLD.capture_id)
    AND (
      EXISTS (SELECT 1 FROM atlas_heads WHERE capture_id = OLD.capture_id)
      OR EXISTS (
        SELECT 1 FROM atlas_captures c
        WHERE c.id = OLD.capture_id AND c.status <> 'running'
      )
    )
  BEGIN
    SELECT RAISE(ABORT, 'cannot retarget the page root of a completed or active capture');
  END;

  CREATE TRIGGER IF NOT EXISTS atlas_captures_require_root_bi
  BEFORE INSERT ON atlas_captures
  WHEN NEW.status <> 'running'
    AND (SELECT COUNT(*) FROM atlas_regions WHERE capture_id = NEW.id AND kind = 'page') <> 1
  BEGIN
    SELECT RAISE(ABORT, 'atlas_captures requires exactly one page root before completion');
  END;

  CREATE TRIGGER IF NOT EXISTS atlas_captures_require_root_bu
  BEFORE UPDATE OF status ON atlas_captures
  WHEN NEW.status <> 'running'
    AND (SELECT COUNT(*) FROM atlas_regions WHERE capture_id = NEW.id AND kind = 'page') <> 1
  BEGIN
    SELECT RAISE(ABORT, 'atlas_captures requires exactly one page root before completion');
  END;
`;

export interface AtlasMigrationResult {
  schemaVersion: number;
  ftsVersion: number;
  revision: number;
}

interface FtsRow {
  region_id: string;
  title: string;
  heading: string;
  copy: string;
  labels: string;
  context: string;
}

/**
 * Canonical active FTS projection: one document per active-head region.
 * Rebuilds when counts or content differ; returns true when changed.
 */
function rebuildActiveFts(db: DatabaseSync): boolean {
  const expected = db
    .prepare(
      `SELECT r.id AS region_id,
              COALESCE(r.raw_title, '') AS title,
              '' AS heading,
              CASE
                WHEN p.kind = 'legacy_gallery' AND r.kind = 'component'
                  THEN COALESCE(r.raw_title, '')
                ELSE ''
              END AS copy,
              COALESCE((
                SELECT group_concat(cl.field || ' ' || cl.value, ' ' ORDER BY cl.field, cl.value)
                FROM atlas_claims cl
                WHERE cl.region_id = r.id
                  AND cl.decision = 'accepted'
                  AND cl.classification <> 'proposed'
              ), '') AS labels,
              COALESCE(p.site_slug, '') AS context
       FROM atlas_regions r
       JOIN atlas_captures cap ON cap.id = r.capture_id
       JOIN atlas_heads h
         ON h.capture_id = cap.id AND h.page_id = cap.page_id AND h.profile_key = cap.profile_key
       LEFT JOIN atlas_pages p ON p.id = cap.page_id
       WHERE cap.status IN ('complete', 'partial')
       ORDER BY r.id, title, labels, context`,
    )
    .all() as unknown as FtsRow[];
  const actual = db
    .prepare(
      `SELECT region_id, title, heading, copy, labels, context
       FROM atlas_regions_fts
       ORDER BY region_id, title, heading, copy, labels, context`,
    )
    .all() as unknown as FtsRow[];
  if (JSON.stringify(expected) === JSON.stringify(actual)) return false;

  db.exec("DELETE FROM atlas_regions_fts");
  const insert = db.prepare(
    "INSERT INTO atlas_regions_fts (region_id, title, heading, copy, labels, context) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const row of expected) {
    insert.run(row.region_id, row.title, row.heading, row.copy, row.labels, row.context);
  }
  return true;
}

/** Validate active heads and rebuild the canonical FTS projection. */
function reconcileActiveProjection(
  db: DatabaseSync,
  ftsAvailable: boolean,
  now: number,
): boolean {
  let changed = false;
  const invalid = db
    .prepare(
      `SELECT h.page_id, h.profile_key, h.capture_id, p.kind, p.site_slug
       FROM atlas_heads h
       LEFT JOIN atlas_captures c ON c.id = h.capture_id
       LEFT JOIN atlas_pages p ON p.id = h.page_id
       WHERE c.id IS NULL
          OR h.page_id <> c.page_id
          OR h.profile_key <> c.profile_key
          OR c.status NOT IN ('complete', 'partial')
          OR p.id IS NULL
          OR (SELECT COUNT(*) FROM atlas_regions r
              WHERE r.capture_id = c.id AND r.kind = 'page') <> 1`,
    )
    .all() as Array<{
    page_id: string;
    profile_key: string;
    capture_id: string;
    kind: string | null;
    site_slug: string | null;
  }>;
  for (const head of invalid) {
    const siteSlug =
      head.kind === "awwwards_item" && head.site_slug ? head.site_slug : undefined;
    if (removeHead(db, head.page_id, head.profile_key, now, siteSlug, false)) {
      changed = true;
    }
  }
  if (ftsAvailable) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'atlas_regions_fts'")
      .get();
    if (exists && rebuildActiveFts(db)) changed = true;
  }
  return changed;
}

export function migrateAtlas(
  db: DatabaseSync,
  now: number,
  ftsAvailable: boolean,
): AtlasMigrationResult {
  const readState = () => {
    const exists = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'atlas_state'")
      .get();
    if (!exists) return undefined;
    return db
      .prepare("SELECT schema_version, fts_version, revision FROM atlas_state WHERE singleton = 1")
      .get() as { schema_version: number; fts_version: number; revision: number } | undefined;
  };

  const existing = readState();
  if (existing && existing.schema_version > ATLAS_SCHEMA_VERSION) {
    throw new Error(
      `Atlas cache schema ${existing.schema_version} is newer than supported ${ATLAS_SCHEMA_VERSION}`,
    );
  }
  if (
    existing &&
    existing.schema_version === ATLAS_SCHEMA_VERSION &&
    (existing.fts_version >= ATLAS_FTS_VERSION || !ftsAvailable)
  ) {
    return {
      schemaVersion: existing.schema_version,
      ftsVersion: existing.fts_version,
      revision: existing.revision,
    };
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const state = readState();
    if (state && state.schema_version > ATLAS_SCHEMA_VERSION) {
      // Re-check under the write lock: another process may have upgraded the
      // database between the fast-path read and this transaction.
      throw new Error(
        `Atlas cache schema ${state.schema_version} is newer than supported ${ATLAS_SCHEMA_VERSION}`,
      );
    }
    let version = state?.schema_version ?? 0;
    let ftsVersion = state?.fts_version ?? 0;
    let revision = state?.revision ?? 0;

    if (version < 1) {
      db.exec(BASE_SCHEMA);
      version = 1;
    }
    if (version < 2) {
      if (ftsAvailable) db.exec(HEADS_AND_FTS_SCHEMA);
      else db.exec("CREATE TABLE IF NOT EXISTS atlas_heads (page_id TEXT NOT NULL REFERENCES atlas_pages(id), profile_key TEXT NOT NULL, capture_id TEXT NOT NULL, published_at INTEGER NOT NULL, PRIMARY KEY (page_id, profile_key), FOREIGN KEY (capture_id, page_id, profile_key) REFERENCES atlas_captures(id, page_id, profile_key));");
      ftsVersion = ftsAvailable ? ATLAS_FTS_VERSION : 0;
      version = 2;
    }
    if (version < 3) {
      db.exec(PACKS_SCHEMA);
      version = 3;
    }
    if (version < 4) {
      db.exec(INVARIANTS_SCHEMA);
      version = 4;
    }
    if (version < 5) {
      // Re-apply invariants idempotently so v4 caches gain new root guards.
      db.exec(INVARIANTS_SCHEMA);
      if (reconcileActiveProjection(db, ftsAvailable && ftsVersion > 0, now)) revision += 1;
      version = 5;
    }
    if (version < 6) {
      const columns = db.prepare("PRAGMA table_info(atlas_captures)").all() as Array<{
        name: string;
      }>;
      if (!columns.some((column) => column.name === "last_confirmed_at")) {
        db.exec("ALTER TABLE atlas_captures ADD COLUMN last_confirmed_at INTEGER");
      }
      db.exec(
        `UPDATE atlas_captures
         SET last_confirmed_at = source_fetched_at
         WHERE last_confirmed_at IS NULL AND source_fetched_at IS NOT NULL`,
      );
      if (reconcileActiveProjection(db, ftsAvailable && ftsVersion > 0, now)) revision += 1;
      version = 6;
    }
    if (ftsAvailable && ftsVersion > 0 && ftsVersion < ATLAS_FTS_VERSION) {
      // FTS2 rebuilds labels from accepted claims instead of raw titles.
      if (reconcileActiveProjection(db, true, now)) revision += 1;
      ftsVersion = ATLAS_FTS_VERSION;
    }
    if (ftsAvailable && ftsVersion === 0) {
      db.exec(HEADS_AND_FTS_SCHEMA);
      if (reconcileActiveProjection(db, true, now)) revision += 1;
      ftsVersion = ATLAS_FTS_VERSION;
    }

    if (!state) {
      db.prepare(
        `INSERT INTO atlas_state
          (singleton, schema_version, fts_version, revision, vocabulary_version, classifier_version, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)`,
      ).run(version, ftsVersion, revision, ATLAS_VOCABULARY_VERSION, ATLAS_CLASSIFIER_VERSION, now);
    } else {
      db.prepare(
        `UPDATE atlas_state
         SET schema_version = ?, fts_version = ?, revision = ?, updated_at = ?,
             vocabulary_version = ?, classifier_version = ?
         WHERE singleton = 1`,
      ).run(
        version,
        ftsVersion,
        revision,
        now,
        ATLAS_VOCABULARY_VERSION,
        ATLAS_CLASSIFIER_VERSION,
      );
    }
    db.exec("COMMIT");
    return { schemaVersion: version, ftsVersion, revision };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw error;
  }
}
