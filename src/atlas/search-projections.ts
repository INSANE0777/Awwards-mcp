import type { DatabaseSync } from "node:sqlite";
import type { SearchField } from "./search-types.js";

/**
 * Revision-keyed search projections. They are derived data: every row is
 * rebuilt from active heads, captures, regions and claims, so they can be
 * dropped and recreated at any time.
 */
export const SEARCH_PROJECTION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS atlas_capture_summary (
    capture_id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    site_slug TEXT NOT NULL,
    profile_key TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    status TEXT NOT NULL,
    observed INTEGER,
    fresh INTEGER,
    regions INTEGER NOT NULL,
    components INTEGER NOT NULL
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS atlas_capture_summary_scope_idx
    ON atlas_capture_summary(profile_key, source_kind, status, fresh, site_slug);

  CREATE TABLE IF NOT EXISTS atlas_capture_features (
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    capture_id TEXT NOT NULL,
    structural_tier INTEGER,
    candidate_tier INTEGER,
    accepted_tier INTEGER,
    observed_tier INTEGER,
    regions INTEGER NOT NULL,
    PRIMARY KEY (field, value, capture_id)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS atlas_site_features (
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    site_slug TEXT NOT NULL,
    profile_key TEXT NOT NULL,
    structural_tier INTEGER,
    candidate_tier INTEGER,
    accepted_tier INTEGER,
    observed_tier INTEGER,
    fresh INTEGER NOT NULL,
    regions INTEGER NOT NULL,
    PRIMARY KEY (field, value, site_slug, profile_key)
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS atlas_site_features_lookup_idx
    ON atlas_site_features(profile_key, field, value);

  CREATE TABLE IF NOT EXISTS atlas_region_purposes (
    region_id TEXT NOT NULL,
    value TEXT NOT NULL,
    profile_key TEXT NOT NULL,
    fresh INTEGER NOT NULL,
    candidate_tier INTEGER,
    accepted_tier INTEGER,
    observed_tier INTEGER,
    tag TEXT,
    role TEXT,
    landmark TEXT,
    PRIMARY KEY (region_id, value)
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS atlas_region_purposes_scope_idx
    ON atlas_region_purposes(
      profile_key, value, fresh, region_id,
      candidate_tier, accepted_tier, observed_tier,
      tag, role, landmark
    );

  CREATE INDEX IF NOT EXISTS atlas_region_purposes_facet_idx
    ON atlas_region_purposes(
      profile_key, tag, role, landmark, fresh,
      value, candidate_tier, accepted_tier, observed_tier
    );

  CREATE TABLE IF NOT EXISTS atlas_region_features (
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    region_id TEXT NOT NULL,
    profile_key TEXT NOT NULL,
    fresh INTEGER NOT NULL,
    candidate_tier INTEGER,
    accepted_tier INTEGER,
    observed_tier INTEGER,
    PRIMARY KEY (field, value, region_id)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS atlas_capture_purposes (
    capture_id TEXT NOT NULL,
    value TEXT NOT NULL,
    candidate_tier INTEGER,
    accepted_tier INTEGER,
    observed_tier INTEGER,
    candidate_regions INTEGER NOT NULL,
    accepted_regions INTEGER NOT NULL,
    observed_regions INTEGER NOT NULL,
    regions INTEGER NOT NULL,
    PRIMARY KEY (capture_id, value)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS atlas_feature_totals (
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    captures INTEGER NOT NULL,
    regions INTEGER NOT NULL,
    PRIMARY KEY (field, value)
  ) WITHOUT ROWID;
`;

const PROJECTION_TABLES = [
  "atlas_capture_summary",
  "atlas_capture_features",
  "atlas_site_features",
  "atlas_region_purposes",
  "atlas_region_features",
  "atlas_capture_purposes",
  "atlas_feature_totals",
] as const;

export function claimEligibilitySql(
  alias: string,
  mode: "accepted" | "observed_only" | "candidate",
): string {
  const common = `${alias}.value <> 'unknown' AND ${alias}.classification <> 'proposed'`;
  if (mode === "accepted") return `${common} AND ${alias}.decision = 'accepted'`;
  if (mode === "observed_only") {
    return `${common} AND ${alias}.decision = 'accepted' AND ${alias}.classification = 'observed'`;
  }
  return `${common} AND ${alias}.decision IN ('accepted','candidate')`;
}

export function claimTierSql(alias: string): string {
  return `CASE
    WHEN ${alias}.decision = 'candidate' THEN 3
    WHEN ${alias}.basis = 'human_review' THEN 0
    WHEN ${alias}.classification = 'observed' THEN 1
    ELSE 2
  END`;
}

export type AtlasStateEvidence = "hover" | "focus";

/** Exact claim-state predicate; the state value is validated search input. */
export function claimStateSql(alias: string, state: string): string {
  return `${alias}.state = '${state}'`;
}

/**
 * Materializes the eligible regions that carry at least one claim for the
 * requested state. The `(state, region_id, sample_key)` index drives this, so
 * state search never scans `samples_json` for the whole corpus.
 */
export function buildStateRegionTable(
  db: DatabaseSync,
  options: {
    captureTable: string;
    kind: "section" | "component";
    state: AtlasStateEvidence;
    mode: "accepted" | "observed_only" | "candidate";
    componentTypeEligible?: boolean;
    table?: string;
  },
): number {
  const table = options.table ?? "atlas_search_state_regions";
  db.exec(`DROP TABLE IF EXISTS temp.${table}`);
  db.exec(`CREATE TEMP TABLE ${table} (
    region_id TEXT PRIMARY KEY
  ) WITHOUT ROWID`);
  const typeEligibility = options.componentTypeEligible
    ? `AND EXISTS (
         SELECT 1 FROM atlas_claims ct INDEXED BY atlas_claims_region_state_idx
         WHERE ct.region_id = r.id
           AND ct.field = 'component.type'
           AND ${claimStateSql("ct", options.state)}
           AND ${claimEligibilitySql("ct", options.mode)}
       )`
    : "";
  const insertSql = `INSERT OR IGNORE INTO temp.${table} (region_id)
     SELECT DISTINCT cl.region_id
     FROM atlas_claims cl INDEXED BY atlas_claims_state_region_idx
     JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = cl.region_id
     JOIN temp.${options.captureTable} cm ON cm.capture_id = r.capture_id
     WHERE r.kind = :kind
       AND ${claimStateSql("cl", options.state)}
       AND ${claimEligibilitySql("cl", options.mode)}
       ${typeEligibility}`;
  db.prepare(insertSql).run({ kind: options.kind });
  return (
    db.prepare(`SELECT COUNT(*) AS regions FROM temp.${table}`).get() as {
      regions: number;
    }
  ).regions;
}

export function stateRegionEligibilitySql(
  regionExpr: string,
  table = "atlas_search_state_regions",
): string {
  return `${regionExpr} IN (SELECT region_id FROM temp.${table})`;
}

/**
 * Exact structural expressions shared by the migrations, indexes and queries.
 * Every expression here must match the corresponding index definition
 * character for character or SQLite silently falls back to a table scan.
 */
export function structuralSql(field: SearchField, alias: string): string | null {
  switch (field) {
    case "region.tag":
      return `lower(json_extract(${alias}.locator_json, '$.tag'))`;
    case "region.role":
      return `lower(json_extract(${alias}.samples_json, '$.role'))`;
    case "region.landmark":
      return `CASE lower(json_extract(${alias}.samples_json, '$.landmark'))
        WHEN 'banner' THEN 'header'
        WHEN 'contentinfo' THEN 'footer'
        WHEN 'complementary' THEN 'aside'
        ELSE lower(json_extract(${alias}.samples_json, '$.landmark'))
      END`;
    default:
      return null;
  }
}

export function tagFallbackSql(alias: string): string {
  return `atlas_region_tag(NULL, json_extract(${alias}.locator_json, '$.selector'))`;
}

/**
 * Old captures did not store `locator_json.tag`. Parse the last compound in
 * the selector and read its leading HTML tag; never invent one from an
 * earlier ancestor.
 */
export function deriveRegionTag(tag: unknown, selector: unknown): string | null {
  if (typeof tag === "string" && tag.trim()) {
    const match = /^([a-z][a-z0-9-]*)/i.exec(tag.trim());
    if (match) return match[1]!.toLowerCase();
  }
  if (typeof selector !== "string") return null;
  const compound = selector.split(">").pop()?.trim() ?? "";
  const match = /^([a-z][a-z0-9-]*)(?=$|[.#:\[\s])/i.exec(compound);
  return match ? match[1]!.toLowerCase() : null;
}

const PROJECTION_COLUMNS: Record<(typeof PROJECTION_TABLES)[number], readonly string[]> = {
  atlas_capture_summary: [
    "capture_id",
    "page_id",
    "site_slug",
    "profile_key",
    "source_kind",
    "status",
    "observed",
    "fresh",
    "regions",
    "components",
  ],
  atlas_capture_features: [
    "field",
    "value",
    "capture_id",
    "structural_tier",
    "candidate_tier",
    "accepted_tier",
    "observed_tier",
    "regions",
  ],
  atlas_site_features: [
    "field",
    "value",
    "site_slug",
    "profile_key",
    "structural_tier",
    "candidate_tier",
    "accepted_tier",
    "observed_tier",
    "fresh",
    "regions",
  ],
  atlas_region_purposes: [
    "region_id",
    "value",
    "profile_key",
    "fresh",
    "candidate_tier",
    "accepted_tier",
    "observed_tier",
    "tag",
    "role",
    "landmark",
  ],
  atlas_region_features: [
    "field",
    "value",
    "region_id",
    "profile_key",
    "fresh",
    "candidate_tier",
    "accepted_tier",
    "observed_tier",
  ],
  atlas_capture_purposes: [
    "capture_id",
    "value",
    "candidate_tier",
    "accepted_tier",
    "observed_tier",
    "candidate_regions",
    "accepted_regions",
    "observed_regions",
    "regions",
  ],
  atlas_feature_totals: ["field", "value", "captures", "regions"],
};

/**
 * Indexes owned by the projection tables. They are derived DDL, not part of
 * the table shape: losing one is repaired in place, never by dropping the
 * seven tables (which would discard every projection row).
 */
const PROJECTION_LOCAL_INDEXES: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: "atlas_capture_summary_scope_idx",
    sql: `CREATE INDEX IF NOT EXISTS atlas_capture_summary_scope_idx
          ON atlas_capture_summary(profile_key, source_kind, status, fresh, site_slug)`,
  },
  {
    name: "atlas_site_features_lookup_idx",
    sql: `CREATE INDEX IF NOT EXISTS atlas_site_features_lookup_idx
          ON atlas_site_features(profile_key, field, value)`,
  },
  {
    name: "atlas_region_purposes_scope_idx",
    sql: `CREATE INDEX IF NOT EXISTS atlas_region_purposes_scope_idx
          ON atlas_region_purposes(
            profile_key, value, fresh, region_id,
            candidate_tier, accepted_tier, observed_tier,
            tag, role, landmark
          )`,
  },
  {
    // Structural purpose facets filter on tag/role/landmark before grouping.
    name: "atlas_region_purposes_facet_idx",
    sql: `CREATE INDEX IF NOT EXISTS atlas_region_purposes_facet_idx
          ON atlas_region_purposes(
            profile_key, tag, role, landmark, fresh,
            value, candidate_tier, accepted_tier, observed_tier
          )`,
  },
  {
    // Component type/context facets read claim tiers from the region feature
    // projection, keyed by field/value/profile.
    name: "atlas_region_features_claim_idx",
    sql: `CREATE INDEX IF NOT EXISTS atlas_region_features_claim_idx
          ON atlas_region_features(
            field, value, profile_key, fresh,
            candidate_tier, accepted_tier, observed_tier
          )`,
  },
];

/**
 * Supporting indexes search depends on for bounded latency. A v8 database can
 * lose any of these (dropped manually, interrupted DDL, older build) without
 * changing table shape, so the writer open checks and recreates them without
 * rebuilding the projections. The projection-local indexes live here too:
 * they are derived DDL, not part of the table shape, so a missing index must
 * never drop the seven tables and discard every projection row.
 */
const SUPPORT_INDEXES: ReadonlyArray<{ name: string; sql: string }> = [
  ...PROJECTION_LOCAL_INDEXES,
  {
    name: "atlas_claims_facet_idx",
    sql: `CREATE INDEX IF NOT EXISTS atlas_claims_facet_idx
          ON atlas_claims(field, decision, classification, region_id, value)`,
  },
  {
    name: "atlas_claims_state_region_idx",
    sql: `CREATE INDEX IF NOT EXISTS atlas_claims_state_region_idx
          ON atlas_claims(state, region_id, sample_key, decision, classification, value)`,
  },
  {
    name: "atlas_claims_region_state_idx",
    sql: `CREATE INDEX IF NOT EXISTS atlas_claims_region_state_idx
          ON atlas_claims(region_id, state, sample_key, field, value, decision, classification)`,
  },
  {
    name: "atlas_regions_lookup_idx",
    sql: `CREATE INDEX IF NOT EXISTS atlas_regions_lookup_idx
          ON atlas_regions(id, capture_id, kind, ordinal)`,
  },
  {
    name: "atlas_regions_features_idx",
    sql: `CREATE INDEX IF NOT EXISTS atlas_regions_features_idx
          ON atlas_regions(
            id, kind,
            lower(json_extract(locator_json, '$.tag')),
            lower(json_extract(samples_json, '$.role')),
            CASE lower(json_extract(samples_json, '$.landmark'))
              WHEN 'banner' THEN 'header'
              WHEN 'contentinfo' THEN 'footer'
              WHEN 'complementary' THEN 'aside'
              ELSE lower(json_extract(samples_json, '$.landmark'))
            END
          )`,
  },
  {
    name: "atlas_regions_sort_idx",
    sql: `CREATE INDEX IF NOT EXISTS atlas_regions_sort_idx
          ON atlas_regions(capture_id, kind, ordinal, id)`,
  },
  {
    name: "atlas_regions_tag_fallback_idx",
    sql: `CREATE INDEX IF NOT EXISTS atlas_regions_tag_fallback_idx
          ON atlas_regions(id)
          WHERE locator_json IS NULL OR json_extract(locator_json, '$.tag') IS NULL`,
  },
  {
    name: "atlas_regions_kind_idx",
    sql: "CREATE INDEX IF NOT EXISTS atlas_regions_kind_idx ON atlas_regions(kind)",
  },
  {
    // Text-query facets walk matched region ids, so probe the feature
    // projection by region instead of scanning one field's whole value space.
    name: "atlas_region_features_region_idx",
    sql: `CREATE INDEX IF NOT EXISTS atlas_region_features_region_idx
          ON atlas_region_features(region_id, field)`,
  },
];

export function atlasSupportIndexesCurrent(db: DatabaseSync): boolean {
  for (const index of SUPPORT_INDEXES) {
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(index.name)
    ) {
      return false;
    }
  }
  return true;
}

/** Recreates missing supporting indexes. Returns true when any was added. */
export function ensureAtlasSupportIndexes(db: DatabaseSync): boolean {
  let changed = false;
  for (const index of SUPPORT_INDEXES) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(index.name);
    if (exists) continue;
    db.exec(index.sql);
    changed = true;
  }
  return changed;
}

export function searchProjectionShapeCurrent(db: DatabaseSync): boolean {
  for (const table of PROJECTION_TABLES) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!exists) return false;
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    for (const required of PROJECTION_COLUMNS[table]) {
      if (!names.has(required)) return false;
    }
  }
  return true;
}

/**
 * Recreates the projection tables when they predate the site profile and
 * freshness columns. Returns true when every row must be rebuilt.
 * Transaction-neutral: the caller owns the transaction.
 */
export function ensureSearchProjectionShape(db: DatabaseSync): boolean {
  if (searchProjectionShapeCurrent(db)) return false;
  for (const name of PROJECTION_TABLES) db.exec(`DROP TABLE IF EXISTS ${name}`);
  db.exec(SEARCH_PROJECTION_SCHEMA);
  db.prepare("UPDATE atlas_state SET feature_revision = -1 WHERE singleton = 1").run();
  return true;
}

/**
 * Site facet rows are the newest confirmation across the captures that carry
 * the value. `siteSlug` restricts the refresh to one site/profile pair after an
 * in-place freshness advance.
 */
function insertSiteFeatures(
  db: DatabaseSync,
  siteSlug?: string,
  profileKey?: string,
): void {
  const scoped = siteSlug !== undefined;
  const statement = db.prepare(
    `INSERT INTO atlas_site_features
       (field, value, site_slug, profile_key, structural_tier, candidate_tier,
        accepted_tier, observed_tier, fresh, regions)
     SELECT f.field, f.value, cm.site_slug, cm.profile_key,
            MIN(f.structural_tier), MIN(f.candidate_tier),
            MIN(f.accepted_tier), MIN(f.observed_tier), MAX(cm.fresh),
            SUM(f.regions)
     FROM atlas_capture_features f
     JOIN atlas_capture_summary cm ON cm.capture_id = f.capture_id
     ${scoped ? "WHERE cm.site_slug = ? AND cm.profile_key = ?" : ""}
     GROUP BY f.field, f.value, cm.site_slug, cm.profile_key`,
  );
  if (scoped) statement.run(siteSlug as string, profileKey as string);
  else statement.run();
}

/**
 * Rebuilds the revision-keyed search projections. Runs inside the caller's
 * transaction: publish pays this cost before COMMIT, and search never writes.
 */
export function rebuildAtlasSearchProjections(db: DatabaseSync, revision: number): void {
  // The tag fallback is a SQL function so the expression stays indexable in
  // search; callers here run outside queryAtlasDatabase, so register it.
  db.function("atlas_region_tag", { deterministic: true }, (tag: unknown, selector: unknown) =>
    deriveRegionTag(tag, selector),
  );
  for (const name of PROJECTION_TABLES) db.exec(`DELETE FROM ${name}`);
  // Only captures that can ever satisfy a query enter the summary: active
  // heads, live pages, publishable status and a known confirmation time.
  db.exec(
    `INSERT INTO atlas_capture_summary
       (capture_id, page_id, site_slug, profile_key, source_kind, status,
        observed, fresh, regions, components)
     SELECT c.id, c.page_id, p.site_slug, c.profile_key, c.source_kind, c.status,
            COALESCE(c.observed_at, c.last_confirmed_at),
            COALESCE(c.last_confirmed_at, c.observed_at),
            (SELECT COUNT(*) FROM atlas_regions r
             WHERE r.capture_id = c.id AND r.kind = 'section'),
            (SELECT COUNT(*) FROM atlas_regions r
             WHERE r.capture_id = c.id AND r.kind = 'component')
     FROM atlas_heads h
     JOIN atlas_captures c
       ON c.id = h.capture_id AND c.page_id = h.page_id AND c.profile_key = h.profile_key
     JOIN atlas_pages p ON p.id = c.page_id
     WHERE c.source_kind = 'live_page'
       AND c.status IN ('complete','partial')
       AND COALESCE(c.last_confirmed_at, c.observed_at) IS NOT NULL`,
  );
  const tagExpression = structuralSql("region.tag", "r")!;
  const roleExpression = structuralSql("region.role", "r")!;
  const landmarkExpression = structuralSql("region.landmark", "r")!;
  const tagValue = `COALESCE(${tagExpression}, ${tagFallbackSql("r")})`;
  db.exec(
    `INSERT INTO atlas_capture_features
       (field, value, capture_id, structural_tier, regions)
     SELECT 'region.tag', ${tagValue}, r.capture_id, 1, COUNT(*)
     FROM atlas_regions r
     JOIN atlas_capture_summary cm ON cm.capture_id = r.capture_id
     WHERE r.kind = 'section' AND ${tagValue} IS NOT NULL
     GROUP BY ${tagValue}, r.capture_id`,
  );
  db.exec(
    `INSERT INTO atlas_capture_features
       (field, value, capture_id, structural_tier, regions)
     SELECT 'region.role', ${roleExpression}, r.capture_id, 1, COUNT(*)
     FROM atlas_regions r
     JOIN atlas_capture_summary cm ON cm.capture_id = r.capture_id
     WHERE r.kind = 'section' AND ${roleExpression} IS NOT NULL
     GROUP BY ${roleExpression}, r.capture_id`,
  );
  db.exec(
    `INSERT INTO atlas_capture_features
       (field, value, capture_id, structural_tier, regions)
     SELECT 'region.landmark', ${landmarkExpression}, r.capture_id, 1, COUNT(*)
     FROM atlas_regions r
     JOIN atlas_capture_summary cm ON cm.capture_id = r.capture_id
     WHERE r.kind = 'section' AND ${landmarkExpression} IS NOT NULL
     GROUP BY ${landmarkExpression}, r.capture_id`,
  );
  db.exec(
    `INSERT INTO atlas_capture_features
       (field, value, capture_id, candidate_tier, accepted_tier, observed_tier, regions)
     SELECT 'section.purpose', cl.value, r.capture_id,
            MIN(CASE WHEN cl.value <> 'unknown' AND cl.classification <> 'proposed'
                       AND cl.decision IN ('accepted','candidate')
                     THEN ${claimTierSql("cl")} END),
            MIN(CASE WHEN cl.value <> 'unknown' AND cl.classification <> 'proposed'
                       AND cl.decision = 'accepted'
                     THEN ${claimTierSql("cl")} END),
            MIN(CASE WHEN cl.value <> 'unknown' AND cl.classification <> 'proposed'
                       AND cl.decision = 'accepted' AND cl.classification = 'observed'
                     THEN ${claimTierSql("cl")} END),
            COUNT(DISTINCT cl.region_id)
     FROM atlas_claims cl INDEXED BY atlas_claims_field_idx
     JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = cl.region_id
     JOIN atlas_capture_summary cm ON cm.capture_id = r.capture_id
     WHERE cl.field = 'section.purpose' AND r.kind = 'section'
       AND cl.state = 'default'
     GROUP BY cl.value, r.capture_id`,
  );
  db.exec(
    `INSERT OR REPLACE INTO atlas_region_purposes
       (region_id, value, profile_key, fresh, candidate_tier, accepted_tier, observed_tier,
        tag, role, landmark)
     SELECT cl.region_id, cl.value, cm.profile_key, cm.fresh,
            MIN(CASE WHEN cl.value <> 'unknown' AND cl.classification <> 'proposed'
                       AND cl.decision IN ('accepted','candidate')
                     THEN ${claimTierSql("cl")} END),
            MIN(CASE WHEN cl.value <> 'unknown' AND cl.classification <> 'proposed'
                       AND cl.decision = 'accepted'
                     THEN ${claimTierSql("cl")} END),
            MIN(CASE WHEN cl.value <> 'unknown' AND cl.classification <> 'proposed'
                       AND cl.decision = 'accepted' AND cl.classification = 'observed'
                     THEN ${claimTierSql("cl")} END),
            MAX(${tagValue}), MAX(${roleExpression}), MAX(${landmarkExpression})
     FROM atlas_claims cl INDEXED BY atlas_claims_field_idx
     JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = cl.region_id
     JOIN atlas_capture_summary cm ON cm.capture_id = r.capture_id
     WHERE cl.field = 'section.purpose' AND r.kind = 'section'
       AND cl.state = 'default'
     GROUP BY cl.region_id, cl.value`,
  );
  db.exec(
    `INSERT OR REPLACE INTO atlas_capture_purposes
       (capture_id, value, candidate_tier, accepted_tier, observed_tier,
        candidate_regions, accepted_regions, observed_regions, regions)
     SELECT r.capture_id, cl.value,
            MIN(CASE WHEN cl.value <> 'unknown' AND cl.classification <> 'proposed'
                       AND cl.decision IN ('accepted','candidate')
                     THEN ${claimTierSql("cl")} END),
            MIN(CASE WHEN cl.value <> 'unknown' AND cl.classification <> 'proposed'
                       AND cl.decision = 'accepted'
                     THEN ${claimTierSql("cl")} END),
            MIN(CASE WHEN cl.value <> 'unknown' AND cl.classification <> 'proposed'
                       AND cl.decision = 'accepted' AND cl.classification = 'observed'
                     THEN ${claimTierSql("cl")} END),
            COUNT(DISTINCT CASE WHEN cl.value <> 'unknown' AND cl.classification <> 'proposed'
                                  AND cl.decision IN ('accepted','candidate')
                                THEN cl.region_id END),
            COUNT(DISTINCT CASE WHEN cl.value <> 'unknown' AND cl.classification <> 'proposed'
                                  AND cl.decision = 'accepted'
                                THEN cl.region_id END),
            COUNT(DISTINCT CASE WHEN cl.value <> 'unknown' AND cl.classification <> 'proposed'
                                  AND cl.decision = 'accepted' AND cl.classification = 'observed'
                                THEN cl.region_id END),
            COUNT(DISTINCT cl.region_id)
     FROM atlas_claims cl INDEXED BY atlas_claims_field_idx
     JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = cl.region_id
     JOIN atlas_capture_summary cm ON cm.capture_id = r.capture_id
     WHERE cl.field = 'section.purpose' AND r.kind = 'section'
       AND cl.state = 'default'
     GROUP BY r.capture_id, cl.value`,
  );
  // Component type/context claims are claim evidence (not structural), so the
  // per-mode tiers travel with the value into both capture and region rows.
  db.exec(
    `INSERT INTO atlas_capture_features
       (field, value, capture_id, candidate_tier, accepted_tier, observed_tier, regions)
     SELECT cl.field, cl.value, r.capture_id,
            MIN(CASE WHEN cl.value <> 'unknown' AND cl.classification <> 'proposed'
                       AND cl.decision IN ('accepted','candidate')
                     THEN ${claimTierSql("cl")} END),
            MIN(CASE WHEN cl.value <> 'unknown' AND cl.classification <> 'proposed'
                       AND cl.decision = 'accepted'
                     THEN ${claimTierSql("cl")} END),
            MIN(CASE WHEN cl.value <> 'unknown' AND cl.classification <> 'proposed'
                       AND cl.decision = 'accepted' AND cl.classification = 'observed'
                     THEN ${claimTierSql("cl")} END),
            COUNT(DISTINCT cl.region_id)
     FROM atlas_claims cl INDEXED BY atlas_claims_field_idx
     JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = cl.region_id
     JOIN atlas_capture_summary cm ON cm.capture_id = r.capture_id
     WHERE cl.field IN ('component.type','context.section_purpose')
       AND cl.state = 'default'
       AND r.kind = 'component'
     GROUP BY cl.field, cl.value, r.capture_id`,
  );
  db.exec(
    `INSERT OR REPLACE INTO atlas_region_features
       (field, value, region_id, profile_key, fresh,
        candidate_tier, accepted_tier, observed_tier)
     SELECT cl.field, cl.value, cl.region_id, cm.profile_key, cm.fresh,
            MIN(CASE WHEN cl.value <> 'unknown' AND cl.classification <> 'proposed'
                       AND cl.decision IN ('accepted','candidate')
                     THEN ${claimTierSql("cl")} END),
            MIN(CASE WHEN cl.value <> 'unknown' AND cl.classification <> 'proposed'
                       AND cl.decision = 'accepted'
                     THEN ${claimTierSql("cl")} END),
            MIN(CASE WHEN cl.value <> 'unknown' AND cl.classification <> 'proposed'
                       AND cl.decision = 'accepted' AND cl.classification = 'observed'
                     THEN ${claimTierSql("cl")} END)
     FROM atlas_claims cl INDEXED BY atlas_claims_field_idx
     JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = cl.region_id
     JOIN atlas_capture_summary cm ON cm.capture_id = r.capture_id
     WHERE cl.field IN ('component.type','context.section_purpose')
       AND cl.state = 'default'
       AND r.kind = 'component'
     GROUP BY cl.field, cl.value, cl.region_id`,
  );
  // Site rows are keyed by profile so a desktop query never sees mobile
  // evidence. `fresh` is the newest confirmation among captures carrying the
  // value, which makes `fresh >= cutoff` an exact per-query eligibility test.
  insertSiteFeatures(db);
  for (const field of ["region.tag", "region.role", "region.landmark"] as const) {
    const expression = structuralSql(field, "r")!;
    db.exec(
      `INSERT OR IGNORE INTO atlas_region_features (field, value, region_id, profile_key, fresh)
       SELECT '${field}', ${expression}, r.id, cm.profile_key, cm.fresh
       FROM atlas_regions r
       JOIN atlas_capture_summary cm ON cm.capture_id = r.capture_id
       WHERE r.kind = 'section' AND ${expression} IS NOT NULL`,
    );
  }
  db.exec(
    `INSERT OR IGNORE INTO atlas_region_features (field, value, region_id, profile_key, fresh)
     SELECT 'section.purpose', value, region_id, profile_key, fresh
     FROM atlas_region_purposes`,
  );
  db.exec(
    `INSERT OR IGNORE INTO atlas_region_features (field, value, region_id, profile_key, fresh)
     SELECT 'region.tag', ${tagFallbackSql("r")}, r.id, cm.profile_key, cm.fresh
     FROM atlas_regions r
     JOIN atlas_capture_summary cm ON cm.capture_id = r.capture_id
     WHERE r.kind = 'section'
       AND (r.locator_json IS NULL OR json_extract(r.locator_json, '$.tag') IS NULL)
       AND ${tagFallbackSql("r")} IS NOT NULL`,
  );
  db.exec(
    `INSERT INTO atlas_feature_totals (field, value, captures, regions)
     SELECT f.field, f.value, COUNT(DISTINCT f.capture_id), SUM(f.regions)
     FROM atlas_capture_features f
     GROUP BY f.field, f.value`,
  );
  db.prepare("UPDATE atlas_state SET feature_revision = ? WHERE singleton = 1").run(revision);
}

/**
 * Bumps the corpus revision once and refreshes the projections in the same
 * transaction, so a committed revision always has projections built from it.
 */
export function bumpAtlasRevision(db: DatabaseSync, now: number): number {
  db.prepare(
    "UPDATE atlas_state SET revision = revision + 1, updated_at = ? WHERE singleton = 1",
  ).run(now);
  const revision = (
    db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
      revision: number;
    }
  ).revision;
  rebuildAtlasSearchProjections(db, revision);
  return revision;
}

const FRESHNESS_DAY_MS = 86_400_000;

/**
 * Advances one capture's freshness in place after an identical recapture on a
 * later day. The evidence is unchanged, so a full rebuild would be wasted work;
 * only the derived `fresh` columns and the revision move. Same-day
 * confirmations return false and keep the revision stable.
 */
export function refreshCaptureProjectionFreshness(
  db: DatabaseSync,
  captureId: string,
  now: number,
): boolean {
  const summary = db
    .prepare(
      "SELECT site_slug, profile_key, fresh FROM atlas_capture_summary WHERE capture_id = ?",
    )
    .get(captureId) as
    | { site_slug: string; profile_key: string; fresh: number | null }
    | undefined;
  if (!summary || summary.fresh === null) return false;
  if (
    Math.floor(summary.fresh / FRESHNESS_DAY_MS) ===
    Math.floor(now / FRESHNESS_DAY_MS)
  ) {
    return false;
  }
  db.prepare("UPDATE atlas_capture_summary SET fresh = ? WHERE capture_id = ?").run(
    now,
    captureId,
  );
  db.prepare(
    `UPDATE atlas_region_features SET fresh = ?
     WHERE region_id IN (SELECT id FROM atlas_regions WHERE capture_id = ?)`,
  ).run(now, captureId);
  db.prepare(
    `UPDATE atlas_region_purposes SET fresh = ?
     WHERE region_id IN (SELECT id FROM atlas_regions WHERE capture_id = ?)`,
  ).run(now, captureId);
  db.prepare(
    "DELETE FROM atlas_site_features WHERE site_slug = ? AND profile_key = ?",
  ).run(summary.site_slug, summary.profile_key);
  insertSiteFeatures(db, summary.site_slug, summary.profile_key);
  return true;
}

/**
 * Commits an in-place projection refresh. `feature_revision` is set to the new
 * revision in the same statement, so the committed state is always ready and
 * old cursors are invalidated by the bump.
 */
export function bumpAtlasRevisionInPlace(db: DatabaseSync, now: number): number {
  db.prepare(
    `UPDATE atlas_state
     SET revision = revision + 1, feature_revision = revision + 1, updated_at = ?
     WHERE singleton = 1`,
  ).run(now);
  return (
    db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
      revision: number;
    }
  ).revision;
}
