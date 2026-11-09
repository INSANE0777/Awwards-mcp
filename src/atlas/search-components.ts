import type { DatabaseSync } from "node:sqlite";
import {
  buildStateRegionTable,
  claimEligibilitySql,
  claimStateSql,
  claimTierSql,
  stateRegionEligibilitySql,
} from "./search-projections.js";
import type {
  AtlasArtifactDescriptor,
  AtlasClaimSummary,
  AtlasFacet,
  AtlasHit,
  AtlasPatternGroup,
  AtlasPredicate,
  AtlasPredicateExplanation,
  AtlasSearchClaim,
  AtlasSearchErrorCode,
  AtlasSearchQuery,
  AtlasSearchQueryData,
  AtlasSearchResult,
  InterpretedSearchInput,
} from "./search-types.js";
import type { EvidenceCoverage } from "./types.js";
import { COMPONENT_TYPES, SECTION_PURPOSES, isSearchableVocabulary } from "./vocabulary.js";

const DAY_MS = 86_400_000;
const FRESH_MS = 7 * DAY_MS;
const MAX_FACET_VALUES = 20;
const MAX_WITNESS_IDS = 200;
const MAX_TOTAL_WITNESS_IDS = 2_000;
const MAX_ARTIFACTS = 8;
const MAX_CLAIM_SUMMARIES = 8;
const MAX_SCREENSHOTS_PER_HIT = 8;
const MAX_TEXT_LENGTH = 200;
const MAX_ID_LENGTH = 128;
const MAX_URL_LENGTH = 1_024;
const MAX_PATH_LENGTH = 512;
const MAX_LABEL_LENGTH = 200;
const MAX_SAMPLE_KEY_LENGTH = 256;
const MAX_LIMITATIONS = 16;

function clipText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function clipNullable(value: string | null | undefined, max: number): string | null {
  return typeof value === "string" ? clipText(value, max) : null;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function placeholderList(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `:${prefix}${index}`).join(", ");
}

function bindValues(
  params: Record<string, string | number>,
  prefix: string,
  values: string[],
): string {
  values.forEach((value, index) => {
    params[`${prefix}${index}`] = value;
  });
  return `(${values.map((_, index) => `:${prefix}${index}`).join(", ")})`;
}

function errorResult(
  code: AtlasSearchErrorCode,
  message: string,
  retryable = false,
): AtlasSearchResult<never> {
  return { ok: false, error: { code, message, retryable } };
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseCoverage(value: unknown): EvidenceCoverage {
  const parsed = parseObject(value);
  const status =
    parsed?.status === "complete" || parsed?.status === "partial" ? parsed.status : "unknown";
  return {
    status,
    collected: typeof parsed?.collected === "number" ? parsed.collected : 0,
    excluded: typeof parsed?.excluded === "number" ? parsed.excluded : 0,
    limitations: Array.isArray(parsed?.limitations)
      ? parsed.limitations
          .filter((item): item is string => typeof item === "string")
          .slice(0, MAX_LIMITATIONS)
          .map((item) => clipText(item, MAX_TEXT_LENGTH))
      : [],
  };
}

interface ClaimRow {
  region_id: string;
  field: string;
  value: string;
  sample_key: string;
  state: string;
  classification: AtlasSearchClaim["classification"];
  basis: AtlasSearchClaim["basis"];
  decision: AtlasSearchClaim["decision"];
}

function loadClaims(
  db: DatabaseSync,
  regionIds: string[],
  mode: InterpretedSearchInput["evidenceMode"],
  state: InterpretedSearchInput["state"] = "default",
): Map<string, AtlasSearchClaim[]> {
  const result = new Map<string, AtlasSearchClaim[]>();
  if (regionIds.length === 0) return result;
  const params: Record<string, string> = {};
  regionIds.forEach((id, index) => {
    params[`id${index}`] = id;
  });
  const rows = db
    .prepare(
      `SELECT cl.region_id, cl.field, cl.value, cl.sample_key, cl.state,
              cl.classification, cl.basis, cl.decision
       FROM atlas_claims cl
       WHERE cl.region_id IN (${placeholderList("id", regionIds.length)})
         AND ${claimEligibilitySql("cl", mode)}
         AND ${claimStateSql("cl", state)}
       ORDER BY cl.region_id, cl.field, cl.value, cl.sample_key, cl.id`,
    )
    .all(params) as unknown as ClaimRow[];
  for (const row of rows) {
    const list = result.get(row.region_id) ?? [];
    list.push({
      id: "",
      regionId: row.region_id,
      field: row.field,
      value: row.value,
      sampleKey: row.sample_key,
      state: row.state as AtlasSearchClaim["state"],
      classification: row.classification,
      basis: row.basis,
      decision: row.decision,
      ruleId: null,
    });
    result.set(row.region_id, list);
  }
  return result;
}

function claimSummaries(claims: AtlasSearchClaim[]): AtlasClaimSummary[] {
  const seen = new Set<string>();
  const summaries: AtlasClaimSummary[] = [];
  for (const claim of claims) {
    const key = `${claim.field}\u0000${claim.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    summaries.push({
      field: clipText(claim.field, 64),
      value: clipText(claim.value, MAX_TEXT_LENGTH),
      classification: claim.classification,
      decision: claim.decision,
      basis: claim.basis,
      sampleKey: clipText(claim.sampleKey, MAX_SAMPLE_KEY_LENGTH),
    });
    if (summaries.length === MAX_CLAIM_SUMMARIES) break;
  }
  return summaries;
}

function loadScreenshots(
  db: DatabaseSync,
  captureIds: string[],
): Map<string, { keys: string[]; truncated: boolean }> {
  const result = new Map<string, { keys: string[]; truncated: boolean }>();
  if (captureIds.length === 0) return result;
  const unique = [...new Set(captureIds)];
  const params: Record<string, string> = {};
  unique.forEach((id, index) => {
    params[`id${index}`] = id;
  });
  const rows = db
    .prepare(
      `SELECT capture_id, key FROM (
         SELECT capture_id, key,
                ROW_NUMBER() OVER (PARTITION BY capture_id ORDER BY key) AS rn
         FROM (
           SELECT DISTINCT a.capture_id AS capture_id,
                           json_extract(a.metadata_json, '$.key') AS key
           FROM atlas_artifacts a
           WHERE a.kind = 'screenshot' AND a.state = 'ready'
             AND a.capture_id IN (${placeholderList("id", unique.length)})
             AND json_extract(a.metadata_json, '$.key') IS NOT NULL
         )
       )
       WHERE rn <= ${MAX_SCREENSHOTS_PER_HIT + 1}
       ORDER BY capture_id, key`,
    )
    .all(params) as Array<{ capture_id: string; key: string }>;
  for (const row of rows) {
    const entry = result.get(row.capture_id) ?? { keys: [], truncated: false };
    if (entry.keys.length >= MAX_SCREENSHOTS_PER_HIT) entry.truncated = true;
    else entry.keys.push(clipText(row.key, MAX_SAMPLE_KEY_LENGTH));
    result.set(row.capture_id, entry);
  }
  return result;
}

function loadArtifacts(
  db: DatabaseSync,
  regionIds: string[],
): Map<string, AtlasArtifactDescriptor[]> {
  const result = new Map<string, AtlasArtifactDescriptor[]>();
  if (regionIds.length === 0) return result;
  const params: Record<string, string> = {};
  regionIds.forEach((id, index) => {
    params[`id${index}`] = id;
  });
  const rows = db
    .prepare(
      `SELECT a.region_id, a.kind, a.storage_path, a.external_url,
              a.sha256, a.bytes, a.mime_type
       FROM atlas_artifacts a
       WHERE a.region_id IN (${placeholderList("id", regionIds.length)})
         AND a.state = 'ready'
       ORDER BY a.region_id, a.kind, a.id`,
    )
    .all(params) as Array<{
    region_id: string;
    kind: string;
    storage_path: string | null;
    external_url: string | null;
    sha256: string | null;
    bytes: number | null;
    mime_type: string;
  }>;
  for (const row of rows) {
    const list = result.get(row.region_id) ?? [];
    if (list.length >= MAX_ARTIFACTS) continue;
    list.push({
      kind: clipText(row.kind, 64),
      storagePath: clipText(row.storage_path ?? row.external_url ?? "", MAX_URL_LENGTH),
      sha256: row.sha256 === null ? null : clipText(row.sha256, MAX_ID_LENGTH),
      bytes: row.bytes ?? null,
      mimeType: clipText(row.mime_type, 128),
    });
    result.set(row.region_id, list);
  }
  return result;
}

interface ComponentAnchor {
  region_id: string;
  capture_id: string;
  ordinal: number;
  tier: number;
  observed_eff: number;
  fresh_eff: number;
  bm25: number | null;
  pattern_key: string | null;
}

interface ComponentDetailRow extends ComponentAnchor {
  locator_json: string | null;
  samples_json: string;
  primary_label: string | null;
  coverage_json: string;
  page_id: string;
  site_slug: string;
  public_url: string | null;
  path: string | null;
  site_title: string | null;
  site_live_url: string | null;
}

function sortColumns(input: InterpretedSearchInput, hasQuery: boolean): string[] {
  const observed = "-observed_eff";
  if (input.sort === "newest") {
    return hasQuery
      ? [observed, "bm25", "tier", "region_id"]
      : [observed, "tier", "region_id"];
  }
  return hasQuery
    ? ["bm25", "tier", observed, "region_id"]
    : ["tier", observed, "ordinal", "region_id"];
}

function sortTupleFor(row: ComponentAnchor, input: InterpretedSearchInput, hasQuery: boolean): string[] {
  if (input.sort === "newest") {
    return hasQuery
      ? [String(-row.observed_eff), String(row.bm25), String(row.tier), row.region_id]
      : [String(-row.observed_eff), String(row.tier), row.region_id];
  }
  return hasQuery
    ? [String(row.bm25), String(row.tier), String(-row.observed_eff), row.region_id]
    : [String(row.tier), String(-row.observed_eff), String(row.ordinal), row.region_id];
}

/**
 * Non-candidate modes anchor only components with a matching `component.type`
 * claim. An accepted context purpose or any other claim never qualifies a
 * candidate type (hidden control, inferred card/drawer/...).
 */
function componentTypeEligibilitySql(
  alias: string,
  mode: InterpretedSearchInput["evidenceMode"],
  state: InterpretedSearchInput["state"] = "default",
): string {
  const stateCondition = `AND ${claimStateSql("ct", state)}`;
  if (mode === "candidate" && state === "default") return "";
  const typeClaim = `EXISTS (
    SELECT 1 FROM atlas_claims ct INDEXED BY atlas_claims_region_idx
    WHERE ct.region_id = ${alias}.id
      AND ct.field = 'component.type'
      ${mode === "candidate" ? "AND ct.value <> 'unknown' AND ct.classification <> 'proposed' AND ct.decision IN ('accepted','candidate')" : `AND ${claimEligibilitySql("ct", mode)}`}
      ${stateCondition}
  )`;
  return `AND ${typeClaim}`;
}

function canonicalFacetValues(field: string): readonly string[] {
  if (field === "component.type") {
    return COMPONENT_TYPES.filter((value) => isSearchableVocabulary("component.type", value));
  }
  if (field === "context.section_purpose") {
    return SECTION_PURPOSES.filter((value) =>
      isSearchableVocabulary("context.section_purpose", value),
    );
  }
  return ["component"];
}

function facetPayload(
  input: InterpretedSearchInput,
  field: string,
  rows: Array<{ value: string; count: number }>,
): AtlasFacet {
  const counts = new Map<string, number>();
  const supported = new Set(canonicalFacetValues(field));
  for (const row of rows) {
    const value = row.value.trim().toLowerCase();
    if (!supported.has(value)) continue;
    counts.set(value, (counts.get(value) ?? 0) + row.count);
  }
  const selected = new Set(
    input.predicates
      .filter((predicate) => predicate.field === field)
      .flatMap((predicate) => predicate.values),
  );
  const candidates = new Set<string>(supported);
  for (const value of counts.keys()) candidates.add(value);
  for (const value of selected) candidates.add(value);
  const ordered = [...candidates]
    .map((value) => ({
      value,
      count: counts.get(value) ?? 0,
      selected: selected.has(value),
    }))
    .sort((left, right) => right.count - left.count || cmp(left.value, right.value));
  const top = [
    ...ordered.filter((item) => item.selected),
    ...ordered.filter((item) => !item.selected).slice(0, MAX_FACET_VALUES),
  ];
  top.sort((left, right) => right.count - left.count || cmp(left.value, right.value));
  return {
    field: field as AtlasFacet["field"],
    disjunctive: true,
    countUnit:
      input.kind === "components" && input.groupBy === "pattern"
        ? "component_pattern"
        : "region_instance",
    values: top,
  };
}

/**
 * Component search is a separate projection path so section search keeps its
 * Phase 3 semantics unchanged. Components are Atlas regions with kind
 * `component`; a component query can never anchor on a section.
 */
export function queryComponentAtlas(
  db: DatabaseSync,
  request: AtlasSearchQuery,
  options: { ftsAvailable?: boolean; scores?: Record<string, number> } = {},
): AtlasSearchResult<AtlasSearchQueryData> {
  const input = request.input;
  const hasQuery = request.tokens.length > 0;
  const cutoff = request.asOf - input.maxAgeDays * DAY_MS;
  const grouped = input.groupBy === "pattern";
  const unitExpr = grouped ? "COALESCE(pattern_key, region_id)" : "region_id";
  let inTransaction = false;
  try {
    db.exec("PRAGMA temp_store = MEMORY");
    db.exec("PRAGMA cache_size = -32768");
    db.exec("BEGIN");
    inTransaction = true;
    const state = db
      .prepare("SELECT revision, fts_version, feature_revision FROM atlas_state WHERE singleton = 1")
      .get() as
      | { revision: number; fts_version: number; feature_revision: number }
      | undefined;
    if (!state || state.feature_revision !== state.revision) {
      db.exec("ROLLBACK");
      inTransaction = false;
      return errorResult(
        "SEARCH_NOT_READY",
        "Atlas search projections are not at the committed revision; retry the search",
        true,
      );
    }
    const revision = state.revision;
    const ftsTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'atlas_regions_fts'")
      .get();
    const ftsAvailable =
      options.ftsAvailable ?? (Boolean(ftsTable) && (state.fts_version ?? 0) > 0);
    const commit = <T>(value: T): T => {
      db.exec("COMMIT");
      inTransaction = false;
      return value;
    };
    if (hasQuery && !ftsAvailable) {
      return commit(errorResult("FTS_UNAVAILABLE", "FTS5 is unavailable; retry without a text query"));
    }

    const metaParams: Record<string, string | number> = {
      profileKey: `live-${input.viewport}`,
      cutoff,
    };
    const metaClauses = [
      "source_kind = 'live_page'",
      "status IN ('complete','partial')",
      "profile_key = :profileKey",
      "fresh IS NOT NULL",
      "fresh >= :cutoff",
      "components > 0",
    ];
    if (input.siteSlugs && input.siteSlugs.length > 0) {
      metaClauses.push(`site_slug IN (${placeholderList("site", input.siteSlugs.length)})`);
      input.siteSlugs.forEach((slug, index) => {
        metaParams[`site${index}`] = slug;
      });
    }
    db.exec("DROP TABLE IF EXISTS temp.component_capture_meta");
    db.exec(`CREATE TEMP TABLE component_capture_meta (
      capture_id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      site_slug TEXT NOT NULL,
      observed INTEGER NOT NULL,
      fresh INTEGER NOT NULL,
      components INTEGER NOT NULL
    ) WITHOUT ROWID`);
    db.prepare(
      `INSERT INTO temp.component_capture_meta
         (capture_id, page_id, site_slug, observed, fresh, components)
       SELECT capture_id, page_id, site_slug, observed, fresh, components
       FROM atlas_capture_summary
       WHERE ${metaClauses.join(" AND ")}`,
    ).run(metaParams);

    const stateFilter = input.state !== "default";
    const stateEvidence = stateFilter
      ? buildStateRegionTable(db, {
          captureTable: "component_capture_meta",
          kind: "component",
          state: input.state === "hover" ? "hover" : "focus",
          mode: input.evidenceMode,
          componentTypeEligible: true,
        })
      : 0;
    const stateClaim = (alias: string): string =>
      `AND ${claimStateSql(alias, input.state)}`;
    const stateRegion = (regionExpr: string): string =>
      stateFilter ? `AND ${stateRegionEligibilitySql(regionExpr)}` : "";

    db.exec("DROP TABLE IF EXISTS temp.component_scores");
    db.exec(
      "CREATE TEMP TABLE component_scores (region_id TEXT PRIMARY KEY, score REAL NOT NULL) WITHOUT ROWID",
    );
    if (hasQuery) {
      try {
        if (options.scores) {
          const insert = db.prepare(
            "INSERT OR REPLACE INTO temp.component_scores (region_id, score) VALUES (?, ?)",
          );
          for (const [regionId, score] of Object.entries(options.scores)) {
            if (Number.isFinite(score)) insert.run(regionId, score);
          }
        } else {
          db.prepare(
            `INSERT INTO temp.component_scores (region_id, score)
             SELECT region_id, bm25(atlas_regions_fts, 0.0, 5.0, 4.0, 1.0, 5.0, 1.0)
             FROM atlas_regions_fts
             WHERE atlas_regions_fts MATCH ?`,
          ).run(request.ftsQuery ?? "");
        }
      } catch {
        return commit(
          errorResult("FTS_UNAVAILABLE", "FTS5 is unavailable; retry without a text query"),
        );
      }
      db.exec(
        `DELETE FROM temp.component_scores
         WHERE region_id NOT IN (
           SELECT r.id FROM atlas_regions r
           JOIN temp.component_capture_meta cm ON cm.capture_id = r.capture_id
           WHERE r.kind = 'component'
         )`,
      );
    }

    const predicates = input.predicates;
    const typeEligibility = componentTypeEligibilitySql(
      "r",
      input.evidenceMode,
      input.state,
    );
    predicates.forEach((predicate, index) => {
      const table = `component_pred_${index}`;
      db.exec(`DROP TABLE IF EXISTS temp.${table}`);
      db.exec(`CREATE TEMP TABLE ${table} (
        scope_key TEXT PRIMARY KEY,
        tier INTEGER NOT NULL
      ) WITHOUT ROWID`);
      if (predicate.field === "region.kind") {
        // Every component anchor already satisfies kind=component.
        const select =
          input.scope === "region"
            ? `SELECT r.id AS scope_key, 1 AS tier
               FROM temp.component_capture_meta cm
               JOIN atlas_regions r INDEXED BY atlas_regions_capture_idx
                 ON r.capture_id = cm.capture_id
               WHERE r.kind = 'component'
                 ${typeEligibility}
                 ${stateRegion("r.id")}`
            : input.scope === "page"
              ? `SELECT capture_id AS scope_key, 1 AS tier FROM temp.component_capture_meta`
              : `SELECT site_slug AS scope_key, 1 AS tier
                 FROM temp.component_capture_meta GROUP BY site_slug`;
        db.exec(`INSERT INTO temp.${table} (scope_key, tier) ${select}`);
        return;
      }
      const params: Record<string, string | number> = {};
      const placeholders = bindValues(params, "v", predicate.values);
      params.field = predicate.field;
      const scopeExpr =
        input.scope === "region"
          ? "cl.region_id"
          : input.scope === "page"
            ? "r.capture_id"
            : "cm.site_slug";
      db.prepare(
        `INSERT INTO temp.${table} (scope_key, tier)
         SELECT ${scopeExpr}, MIN(${claimTierSql("cl")})
         FROM atlas_claims cl INDEXED BY atlas_claims_field_idx
         JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = cl.region_id
         JOIN temp.component_capture_meta cm ON cm.capture_id = r.capture_id
         WHERE r.kind = 'component'
           ${typeEligibility}
           AND cl.field = :field
           AND cl.value IN ${placeholders}
           AND ${claimEligibilitySql("cl", input.evidenceMode)}
           ${stateClaim("cl")}
         GROUP BY ${scopeExpr}`,
      ).run(params);
    });

    const claimPredicates = predicates.filter(
      (predicate) => predicate.field !== "region.kind",
    );
    // Repeated region-scope predicates must share one sample key. Page/site
    // scope allows separate witnesses, matching section search semantics.
    if (input.scope === "region" && claimPredicates.length > 1) {
      db.exec("DROP TABLE IF EXISTS temp.component_pred_samples");
      db.exec(`CREATE TEMP TABLE component_pred_samples (
        region_id TEXT NOT NULL,
        sample_key TEXT NOT NULL,
        PRIMARY KEY (region_id, sample_key)
      ) WITHOUT ROWID`);
      const firstIndex = predicates.findIndex(
        (predicate) => predicate.field !== "region.kind",
      );
      const first = predicates[firstIndex]!;
      const firstParams: Record<string, string> = {};
      const firstValues = bindValues(firstParams, "v", first.values);
      db.prepare(
        `INSERT OR IGNORE INTO temp.component_pred_samples (region_id, sample_key)
         SELECT cl.region_id, cl.sample_key
         FROM temp.component_pred_${firstIndex} pm
         JOIN atlas_claims cl INDEXED BY atlas_claims_region_idx ON cl.region_id = pm.scope_key
         WHERE cl.field = '${first.field}'
           AND cl.value IN ${firstValues}
           AND ${claimEligibilitySql("cl", input.evidenceMode)}
           ${stateClaim("cl")}`,
      ).run(firstParams);
      predicates.forEach((predicate, index) => {
        if (predicate.field === "region.kind" || index === firstIndex) return;
        const params: Record<string, string> = {};
        const placeholders = bindValues(params, "v", predicate.values);
        db.prepare(
          `DELETE FROM temp.component_pred_samples
           WHERE NOT EXISTS (
             SELECT 1 FROM atlas_claims cl INDEXED BY atlas_claims_region_idx
             WHERE cl.region_id = component_pred_samples.region_id
               AND cl.sample_key = component_pred_samples.sample_key
               AND cl.field = '${predicate.field}'
               AND cl.value IN ${placeholders}
               AND ${claimEligibilitySql("cl", input.evidenceMode)}
               ${stateClaim("cl")}
           )`,
        ).run(params);
      });
      db.exec(
        `DELETE FROM temp.component_pred_${firstIndex}
         WHERE scope_key NOT IN (SELECT region_id FROM temp.component_pred_samples)`,
      );
    }

    const predicateSets = predicates
      .map((predicate, index) => ({
        field: predicate.field,
        table: `component_pred_${index}`,
      }))
      // region.kind=component is true for every component anchor; it must not
      // affect scope intersection or ranking.
      .filter((set) => set.field !== "region.kind");

    const buildScopes = (target: string, excludeField?: string): void => {
      const sets = predicateSets.filter((set) => set.field !== excludeField);
      db.exec(`DROP TABLE IF EXISTS temp.${target}`);
      db.exec(`CREATE TEMP TABLE ${target} (
        scope_key TEXT PRIMARY KEY,
        tier INTEGER NOT NULL
      ) WITHOUT ROWID`);
      if (sets.length === 0) {
        const expr = input.scope === "page" ? "capture_id" : "site_slug";
        db.exec(
          `INSERT INTO temp.${target} (scope_key, tier)
           SELECT ${expr}, 0 FROM temp.component_capture_meta GROUP BY ${expr}`,
        );
        return;
      }
      if (sets.length === 1) {
        db.exec(
          `INSERT INTO temp.${target} (scope_key, tier)
           SELECT scope_key, tier FROM temp.${sets[0]!.table}`,
        );
        return;
      }
      const unions = sets
        .map((set) => `SELECT scope_key, tier FROM temp.${set.table}`)
        .join(" UNION ALL ");
      db.exec(
        `INSERT INTO temp.${target} (scope_key, tier)
         SELECT scope_key, MAX(tier)
         FROM (${unions})
         GROUP BY scope_key
         HAVING COUNT(*) = ${sets.length}`,
      );
    };

    const restrictScopesToQuery = (scopes: string): void => {
      if (!hasQuery) return;
      const scopeExpr = input.scope === "page" ? "r.capture_id" : "cm.site_slug";
      db.exec(
        `DELETE FROM temp.${scopes}
         WHERE scope_key NOT IN (
           SELECT DISTINCT ${scopeExpr}
           FROM temp.component_scores sc
           JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = sc.region_id
           JOIN temp.component_capture_meta cm ON cm.capture_id = r.capture_id
           WHERE r.kind = 'component'
         )`,
      );
    };

    const buildAnchors = (target: string, excludeField?: string): string => {
      db.exec(`DROP TABLE IF EXISTS temp.${target}`);
      db.exec(`CREATE TEMP TABLE ${target} (
        region_id TEXT PRIMARY KEY,
        capture_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        tier INTEGER NOT NULL,
        observed_eff INTEGER NOT NULL,
        fresh_eff INTEGER NOT NULL,
        bm25 REAL,
        pattern_key TEXT
      ) WITHOUT ROWID`);
      const activeSets = predicateSets.filter((set) => set.field !== excludeField);
      if (input.scope === "region") {
        db.exec(
          `INSERT INTO temp.${target}
             (region_id, capture_id, ordinal, tier, observed_eff, fresh_eff, bm25, pattern_key)
           SELECT r.id, r.capture_id, r.ordinal,
                  COALESCE((
                    SELECT MIN(${claimTierSql("cl")})
                    FROM atlas_claims cl INDEXED BY atlas_claims_region_idx
                    WHERE cl.region_id = r.id
                      AND ${claimEligibilitySql("cl", input.evidenceMode)}
                      ${stateClaim("cl")}
                  ), 2),
                  cm.observed, cm.fresh, NULL, r.pattern_key
           FROM temp.component_capture_meta cm
           JOIN atlas_regions r INDEXED BY atlas_regions_capture_idx ON r.capture_id = cm.capture_id
           WHERE r.kind = 'component'
             ${typeEligibility}
             ${stateRegion("r.id")}`,
        );
        if (hasQuery) {
          db.exec(
            `DELETE FROM temp.${target}
             WHERE region_id NOT IN (SELECT region_id FROM temp.component_scores)`,
          );
          db.exec(
            `UPDATE temp.${target}
             SET bm25 = (SELECT score FROM temp.component_scores WHERE component_scores.region_id = ${target}.region_id)`,
          );
        }
        for (const set of activeSets) {
          db.exec(
            `DELETE FROM temp.${target}
             WHERE region_id NOT IN (SELECT scope_key FROM temp.${set.table})`,
          );
          db.exec(
            `UPDATE temp.${target}
             SET tier = MAX(tier, COALESCE((
               SELECT tier FROM temp.${set.table} WHERE ${set.table}.scope_key = ${target}.region_id
             ), 0))`,
          );
        }
        return target;
      }

      const scopes = `${target}_scopes`;
      buildScopes(scopes, excludeField);
      restrictScopesToQuery(scopes);
      const join =
        input.scope === "page"
          ? `cm.capture_id = sc.scope_key`
          : `cm.site_slug = sc.scope_key`;
      const stateTier = ` AND ${claimStateSql("cl", input.state)}`;
      const tierExpr =
        predicates.length > 0 && activeSets.length === predicates.length
          ? "sc.tier"
          : predicates.length > 0
            ? "MAX(sc.tier, COALESCE((SELECT MIN(" + claimTierSql("cl") + ") FROM atlas_claims cl INDEXED BY atlas_claims_region_idx WHERE cl.region_id = r.id AND " + claimEligibilitySql("cl", input.evidenceMode) + stateTier + "), 2))"
            : "COALESCE((SELECT MIN(" + claimTierSql("cl") + ") FROM atlas_claims cl INDEXED BY atlas_claims_region_idx WHERE cl.region_id = r.id AND " + claimEligibilitySql("cl", input.evidenceMode) + stateTier + "), 2)";
      db.exec(
        `INSERT INTO temp.${target}
           (region_id, capture_id, ordinal, tier, observed_eff, fresh_eff, bm25, pattern_key)
         SELECT r.id, r.capture_id, r.ordinal, ${tierExpr},
                cm.observed, cm.fresh, NULL, r.pattern_key
         FROM temp.${scopes} sc
         JOIN temp.component_capture_meta cm ON ${join}
         JOIN atlas_regions r INDEXED BY atlas_regions_capture_idx ON r.capture_id = cm.capture_id
         WHERE r.kind = 'component'
           ${typeEligibility}
           ${stateRegion("r.id")}`,
      );
      if (hasQuery) {
        db.exec(
          `DELETE FROM temp.${target}
           WHERE region_id NOT IN (SELECT region_id FROM temp.component_scores)`,
        );
        db.exec(
          `UPDATE temp.${target}
           SET bm25 = (SELECT score FROM temp.component_scores WHERE component_scores.region_id = ${target}.region_id)`,
        );
      }
      return target;
    };

    buildAnchors("component_anchors");

    const sort = sortColumns(input, hasQuery);
    const params: Record<string, string | number> = { take: input.limit + 1 };
    let cursorWhere = "";
    if (request.afterTuple) {
      request.afterTuple.forEach((value, index) => {
        params[`a${index}`] =
          index === request.afterTuple!.length - 1 ? value : Number(value);
      });
      cursorWhere = `WHERE (${sort.join(", ")}) > (${placeholderList("a", request.afterTuple.length)})`;
    }

    let selected: ComponentAnchor[];
    if (grouped) {
      const where = cursorWhere.replace(/^WHERE /, "AND ");
      selected = db
        .prepare(
          `WITH ranked AS (
             SELECT region_id, capture_id, ordinal, tier, observed_eff, fresh_eff,
                    bm25, pattern_key,
                    ROW_NUMBER() OVER (
                      PARTITION BY COALESCE(pattern_key, region_id)
                      ORDER BY ${sort.join(", ")}
                    ) AS rn
             FROM temp.component_anchors
           )
           SELECT region_id, capture_id, ordinal, tier, observed_eff, fresh_eff,
                  bm25, pattern_key
           FROM ranked
           WHERE rn = 1 ${where}
           ORDER BY ${sort.join(", ")}
           LIMIT :take`,
        )
        .all(params) as unknown as ComponentAnchor[];
    } else {
      selected = db
        .prepare(
          `SELECT region_id, capture_id, ordinal, tier, observed_eff, fresh_eff,
                  bm25, pattern_key
           FROM temp.component_anchors
           ${cursorWhere}
           ORDER BY ${sort.join(", ")}
           LIMIT :take`,
        )
        .all(params) as unknown as ComponentAnchor[];
    }
    const hasMore = selected.length > input.limit;
    const pageSelected = selected.slice(0, input.limit);

    const total = (
      db
        .prepare(
          `SELECT COUNT(DISTINCT ${unitExpr}) AS total FROM temp.component_anchors`,
        )
        .get() as { total: number }
    ).total;

    const detailById = new Map<string, ComponentDetailRow>();
    if (pageSelected.length > 0) {
      const detailParams: Record<string, string> = {};
      pageSelected.forEach((row, index) => {
        detailParams[`d${index}`] = row.region_id;
      });
      const detailRows = db
        .prepare(
          `SELECT r.id AS region_id, r.capture_id, r.ordinal, r.locator_json, r.samples_json,
                  r.pattern_key, r.primary_label, r.coverage_json,
                  cm.page_id, cm.site_slug, cm.observed AS observed_eff, cm.fresh AS fresh_eff,
                  p.public_url, p.path, s.title AS site_title, s.liveUrl AS site_live_url
           FROM atlas_regions r
           JOIN temp.component_capture_meta cm ON cm.capture_id = r.capture_id
           JOIN atlas_pages p ON p.id = cm.page_id
           LEFT JOIN sites s ON s.slug = cm.site_slug
           WHERE r.id IN (${placeholderList("d", pageSelected.length)})`,
        )
        .all(detailParams) as unknown as ComponentDetailRow[];
      for (const row of detailRows) detailById.set(row.region_id, row);
    }
    const pageRows: ComponentDetailRow[] = pageSelected.map((row) => {
      const detail = detailById.get(row.region_id);
      return {
        ...(detail ?? {
          region_id: row.region_id,
          capture_id: row.capture_id,
          ordinal: row.ordinal,
          locator_json: null,
          samples_json: "{}",
          primary_label: null,
          coverage_json: "{}",
          page_id: "",
          site_slug: "",
          public_url: null,
          path: null,
          site_title: null,
          site_live_url: null,
          observed_eff: row.observed_eff,
          fresh_eff: row.fresh_eff,
        }),
        tier: row.tier,
        bm25: row.bm25,
        pattern_key: row.pattern_key,
      };
    });

    const corpusRow = db
      .prepare(
        `SELECT COUNT(DISTINCT site_slug) AS sites,
                COUNT(DISTINCT page_id) AS pages,
                COUNT(*) AS captures,
                COALESCE(SUM(components), 0) AS components
         FROM temp.component_capture_meta`,
      )
      .get() as { sites: number; pages: number; captures: number; components: number };

    const predicatePresence: Partial<Record<string, boolean>> = {};
    if (total === 0) {
      for (const field of new Set(predicates.map((predicate) => predicate.field))) {
        if (field === "region.kind") {
          predicatePresence[field] = stateFilter
            ? stateEvidence > 0
            : corpusRow.components > 0;
          continue;
        }
        const found = db
          .prepare(
            `SELECT 1 AS present
             FROM atlas_claims cl INDEXED BY atlas_claims_field_idx
             JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = cl.region_id
             JOIN temp.component_capture_meta cm ON cm.capture_id = r.capture_id
             WHERE r.kind = 'component' ${typeEligibility} AND cl.field = :field
               AND ${claimEligibilitySql("cl", input.evidenceMode)}
               ${stateClaim("cl")}
             LIMIT 1`,
          )
          .get({ field });
        predicatePresence[field] = Boolean(found);
      }
    }

    const facetRowsFor = (field: string): Array<{ value: string; count: number }> => {
      const facetAnchors = buildAnchors("component_facet_anchors", field);
      if (field === "region.kind") {
        return [
          {
            value: "component",
            count: (
              db
                .prepare(
                  `SELECT COUNT(DISTINCT ${unitExpr}) AS count FROM temp.${facetAnchors}`,
                )
                .get() as { count: number }
            ).count,
          },
        ];
      }
      if (input.scope === "region") {
        const groupExpr = grouped ? "COALESCE(a.pattern_key, a.region_id)" : "a.region_id";
        return db
          .prepare(
            `SELECT cl.value AS value, COUNT(DISTINCT ${groupExpr}) AS count
             FROM temp.${facetAnchors} a
             JOIN atlas_claims cl INDEXED BY atlas_claims_region_idx ON cl.region_id = a.region_id
             WHERE cl.field = :field
               AND ${claimEligibilitySql("cl", input.evidenceMode)}
               ${stateClaim("cl")}
             GROUP BY cl.value`,
          )
          .all({ field }) as unknown as Array<{ value: string; count: number }>;
      }
      const groupExpr = grouped ? "COALESCE(a.pattern_key, a.region_id)" : "a.region_id";
      const witnessScope =
        input.scope === "page"
          ? "wr.capture_id = a.capture_id"
          : `EXISTS (
               SELECT 1 FROM temp.component_capture_meta wcm
               WHERE wcm.capture_id = wr.capture_id AND wcm.site_slug = acm.site_slug
             )`;
      return db
        .prepare(
          `SELECT cl.value AS value, COUNT(DISTINCT ${groupExpr}) AS count
           FROM temp.${facetAnchors} a
           JOIN temp.component_capture_meta acm ON acm.capture_id = a.capture_id
           JOIN atlas_regions wr ON wr.kind = 'component' AND ${witnessScope}
             ${componentTypeEligibilitySql("wr", input.evidenceMode, input.state)}
           JOIN atlas_claims cl INDEXED BY atlas_claims_region_idx ON cl.region_id = wr.id
           WHERE cl.field = :field
             AND ${claimEligibilitySql("cl", input.evidenceMode)}
             ${stateClaim("cl")}
             ${stateRegion("wr.id")}
           GROUP BY cl.value`,
        )
        .all({ field }) as unknown as Array<{ value: string; count: number }>;
    };
    const facets = input.facets.map((field) =>
      facetPayload(input, field, facetRowsFor(field)),
    );

    const anchorIds = pageRows.map((row) => row.region_id);
    const claimsByRegion = loadClaims(db, anchorIds, input.evidenceMode, input.state);
    const screenshots = loadScreenshots(
      db,
      pageRows.map((row) => row.capture_id),
    );
    const artifacts = loadArtifacts(db, anchorIds);

    const matchingCounts = new Map<string, number>();
    const memberIds = new Map<string, string[]>();
    const observedCounts = new Map<string, number>();
    if (grouped) {
      // Group metadata is only needed for the patterns on this page, never the
      // whole corpus (limit:1 over 10k patterns must hydrate one group).
      const selectedUnits = [
        ...new Set(pageSelected.map((row) => row.pattern_key ?? row.region_id)),
      ];
      const unitParams: Record<string, string> = {};
      const unitFilter =
        selectedUnits.length > 0
          ? `COALESCE(pattern_key, region_id) IN ${bindValues(unitParams, "u", selectedUnits)}`
          : "0";
      const counts = db
        .prepare(
          `SELECT COALESCE(pattern_key, region_id) AS unit, COUNT(*) AS n
           FROM temp.component_anchors
           WHERE ${unitFilter}
           GROUP BY unit`,
        )
        .all(unitParams) as Array<{ unit: string; n: number }>;
      for (const row of counts) matchingCounts.set(row.unit, row.n);
      const members = db
        .prepare(
          `SELECT region_id, unit FROM (
             SELECT region_id, COALESCE(pattern_key, region_id) AS unit,
                    ROW_NUMBER() OVER (
                      PARTITION BY COALESCE(pattern_key, region_id)
                      ORDER BY ${sort.join(", ")}
                    ) AS rn
             FROM temp.component_anchors
             WHERE ${unitFilter}
           ) WHERE rn <= 3`,
        )
        .all(unitParams) as Array<{ region_id: string; unit: string }>;
      for (const row of members) {
        const list = memberIds.get(row.unit) ?? [];
        list.push(row.region_id);
        memberIds.set(row.unit, list);
      }
      const selectedPatterns = [
        ...new Set(
          pageSelected
            .map((row) => row.pattern_key)
            .filter((key): key is string => typeof key === "string"),
        ),
      ];
      if (selectedPatterns.length > 0) {
        const patternParams: Record<string, string> = {};
        const observed = db
          .prepare(
            `SELECT r.capture_id, r.pattern_key, COUNT(*) AS n
             FROM atlas_regions r
             JOIN temp.component_capture_meta cm ON cm.capture_id = r.capture_id
             WHERE r.kind = 'component' AND r.pattern_key IS NOT NULL
               ${typeEligibility}
               AND r.pattern_key IN ${bindValues(patternParams, "p", selectedPatterns)}
             GROUP BY r.capture_id, r.pattern_key`,
          )
          .all(patternParams) as Array<{ capture_id: string; pattern_key: string; n: number }>;
        for (const row of observed) {
          observedCounts.set(`${row.capture_id}\u0000${row.pattern_key}`, row.n);
        }
      }
    }

    const witnessFor = (
      row: ComponentDetailRow,
      predicate: AtlasPredicate,
      index: number,
      cap: number,
    ): { ids: string[]; sampleKeys: string[]; truncated: boolean } => {
      if (predicate.field === "region.kind") {
        return { ids: [row.region_id], sampleKeys: [], truncated: false };
      }
      if (input.scope === "region") {
        const regionParams: Record<string, string | number> = { anchorId: row.region_id };
        predicate.values.forEach((value, valueIndex) => {
          regionParams[`p${index}v${valueIndex}`] = value;
        });
        const sampleKeys = (
          db
            .prepare(
              `SELECT DISTINCT cl.sample_key AS sample_key
               FROM atlas_claims cl INDEXED BY atlas_claims_region_idx
               WHERE cl.region_id = :anchorId
                 AND cl.field = '${predicate.field}'
                 AND cl.value IN (${placeholderList(`p${index}v`, predicate.values.length)})
                 AND ${claimEligibilitySql("cl", input.evidenceMode)}
                 ${stateClaim("cl")}
               ORDER BY cl.sample_key
               LIMIT 3`,
            )
            .all(regionParams) as Array<{ sample_key: string }>
        ).map((sample) => sample.sample_key);
        return { ids: [row.region_id], sampleKeys, truncated: false };
      }
      if (cap <= 0) return { ids: [], sampleKeys: [], truncated: false };
      const scopeWhere =
        input.scope === "page"
          ? "r.capture_id = :anchorCapture"
          : "cm.site_slug = :anchorSite";
      const params: Record<string, string | number> =
        input.scope === "page"
          ? { anchorCapture: row.capture_id }
          : { anchorSite: row.site_slug };
      predicate.values.forEach((value, valueIndex) => {
        params[`p${index}v${valueIndex}`] = value;
      });
      const rows = db
        .prepare(
          `SELECT DISTINCT r.id AS id
           FROM atlas_regions r INDEXED BY atlas_regions_sort_idx
           JOIN temp.component_capture_meta cm ON cm.capture_id = r.capture_id
           JOIN atlas_claims cl INDEXED BY atlas_claims_region_idx ON cl.region_id = r.id
           WHERE r.kind = 'component'
             ${typeEligibility}
             AND ${scopeWhere}
             AND cl.field = '${predicate.field}'
             AND cl.value IN (${placeholderList(`p${index}v`, predicate.values.length)})
             AND ${claimEligibilitySql("cl", input.evidenceMode)}
             ${stateClaim("cl")}
             ${stateRegion("r.id")}
           GROUP BY r.id
           ORDER BY r.ordinal, r.id
           LIMIT ${cap + 1}`,
        )
        .all(params) as Array<{ id: string }>;
      const sampleKeys = (
        db
          .prepare(
            `SELECT DISTINCT cl.sample_key AS sample_key
             FROM atlas_regions r INDEXED BY atlas_regions_sort_idx
             JOIN temp.component_capture_meta cm ON cm.capture_id = r.capture_id
             JOIN atlas_claims cl INDEXED BY atlas_claims_region_idx ON cl.region_id = r.id
             WHERE r.kind = 'component'
               ${typeEligibility}
               AND ${scopeWhere}
               AND cl.field = '${predicate.field}'
               AND cl.value IN (${placeholderList(`p${index}v`, predicate.values.length)})
               AND ${claimEligibilitySql("cl", input.evidenceMode)}
               ${stateClaim("cl")}
               ${stateRegion("r.id")}
             ORDER BY cl.sample_key
             LIMIT 3`,
          )
          .all(params) as Array<{ sample_key: string }>
      ).map((sample) => sample.sample_key);
      return {
        ids: rows.slice(0, cap).map((witness) => witness.id),
        sampleKeys,
        truncated: rows.length > cap,
      };
    };

    const matchedSampleKeyFor = (row: ComponentDetailRow): string | null => {
      const claims = predicates.filter(
        (predicate) => predicate.field !== "region.kind",
      );
      if (claims.length === 0) return null;
      const params: Record<string, string | number> =
        input.scope === "region"
          ? { anchorId: row.region_id }
          : input.scope === "page"
            ? { anchorCapture: row.capture_id }
            : { anchorSite: row.site_slug };
      const having = claims
        .map((predicate, index) => {
          const placeholders = bindValues(params, `ms${index}v`, predicate.values);
          return `SUM(CASE WHEN cl.field = '${predicate.field}' AND cl.value IN ${placeholders} THEN 1 ELSE 0 END) > 0`;
        })
        .join(" AND ");
      const where =
        input.scope === "region"
          ? "WHERE cl.region_id = :anchorId"
          : input.scope === "page"
            ? `WHERE r.kind = 'component' ${typeEligibility} ${stateRegion("r.id")} AND r.capture_id = :anchorCapture`
            : `WHERE r.kind = 'component' ${typeEligibility} ${stateRegion("r.id")} AND cm.site_slug = :anchorSite`;
      const from =
        input.scope === "region"
          ? "FROM atlas_claims cl INDEXED BY atlas_claims_region_idx"
          : `FROM atlas_regions r INDEXED BY atlas_regions_sort_idx
             JOIN temp.component_capture_meta cm ON cm.capture_id = r.capture_id
             JOIN atlas_claims cl INDEXED BY atlas_claims_region_idx ON cl.region_id = r.id`;
      const found = db
        .prepare(
          `SELECT MIN(sample_key) AS sample_key FROM (
             SELECT cl.sample_key AS sample_key
             ${from}
             ${where}
               AND ${claimEligibilitySql("cl", input.evidenceMode)}
               ${stateClaim("cl")}
             GROUP BY ${input.scope === "region" ? "cl.sample_key" : "cl.region_id, cl.sample_key"}
             HAVING ${having}
           )`,
        )
        .get(params) as { sample_key: string | null } | undefined;
      return found?.sample_key ?? null;
    };

    const observationSpanFor = (
      row: ComponentDetailRow,
    ): { from: number; to: number } | undefined => {
      if (input.scope !== "site") return undefined;
      const parts: string[] = [
        `SELECT cm.observed AS obs FROM temp.component_capture_meta cm
         WHERE cm.capture_id = :anchorCapture AND cm.site_slug = :anchorSite`,
      ];
      const params: Record<string, string | number> = {
        anchorCapture: row.capture_id,
        anchorSite: row.site_slug,
      };
      predicates.forEach((predicate, index) => {
        if (predicate.field === "region.kind") return;
        predicate.values.forEach((value, valueIndex) => {
          params[`o${index}v${valueIndex}`] = value;
        });
        parts.push(
          `SELECT cm.observed AS obs
           FROM atlas_regions r INDEXED BY atlas_regions_sort_idx
           JOIN temp.component_capture_meta cm ON cm.capture_id = r.capture_id
           JOIN atlas_claims cl INDEXED BY atlas_claims_region_idx ON cl.region_id = r.id
           WHERE r.kind = 'component'
             ${typeEligibility}
             AND cm.site_slug = :anchorSite
             AND cl.field = '${predicate.field}'
             AND cl.value IN (${placeholderList(`o${index}v`, predicate.values.length)})
             AND ${claimEligibilitySql("cl", input.evidenceMode)}
             ${stateClaim("cl")}
             ${stateRegion("r.id")}`,
        );
      });
      const span = db
        .prepare(
          `SELECT MIN(obs) AS from_ts, MAX(obs) AS to_ts FROM (${parts.join(" UNION ALL ")})`,
        )
        .get(params) as { from_ts: number; to_ts: number } | undefined;
      return span ? { from: span.from_ts, to: span.to_ts } : undefined;
    };

    const budget = { remaining: MAX_TOTAL_WITNESS_IDS };
    const hits: AtlasHit[] = pageRows.map((row) => {
      const claims = claimsByRegion.get(row.region_id) ?? [];
      const summaries = claimSummaries(claims);
      const componentType =
        summaries.find(
          (claim) => claim.field === "component.type" && claim.decision === "accepted",
        )?.value ??
        summaries.find((claim) => claim.field === "component.type")?.value ??
        null;
      const contextPurpose =
        summaries.find(
          (claim) =>
            claim.field === "context.section_purpose" && claim.decision === "accepted",
        )?.value ?? null;
      let explanationsTruncated = false;
      const explanations: AtlasPredicateExplanation[] = predicates.map(
        (predicate, index) => {
          if (budget.remaining <= 0) {
            explanationsTruncated = true;
            return {
              field: predicate.field,
              values: predicate.values,
              supportingRegionIds: [],
              sampleKeys: [],
              truncated: true,
            };
          }
          const witness = witnessFor(row, predicate, index, budget.remaining);
          const take = Math.min(witness.ids.length, budget.remaining);
          budget.remaining -= take;
          const supporting = witness.ids
            .slice(0, take)
            .filter((id) => id.length <= MAX_ID_LENGTH);
          if (witness.truncated || take < witness.ids.length || supporting.length < take) {
            explanationsTruncated = true;
          }
          return {
            field: predicate.field,
            values: predicate.values,
            supportingRegionIds: supporting,
            sampleKeys: witness.sampleKeys.map((key) =>
              clipText(key, MAX_SAMPLE_KEY_LENGTH),
            ),
            truncated: witness.truncated,
          };
        },
      );
      const patternKey = row.pattern_key;
      const group: AtlasPatternGroup | null =
        grouped && patternKey
          ? {
              key: patternKey,
              memberRegionIds: (memberIds.get(patternKey) ?? []).slice(0, 3),
              matchingMembers: matchingCounts.get(patternKey) ?? 1,
              observedMembers:
                observedCounts.get(`${row.capture_id}\u0000${patternKey}`) ?? 1,
            }
          : null;
      const observationSpan = observationSpanFor(row);
      return {
        regionId: row.region_id,
        captureId: row.capture_id,
        pageId: row.page_id,
        siteSlug: clipText(row.site_slug, 128),
        siteTitle: clipText(row.site_title ?? row.site_slug, MAX_TEXT_LENGTH),
        sitePublicUrl: clipNullable(row.site_live_url, MAX_URL_LENGTH),
        sourceUrl: clipNullable(row.public_url, MAX_URL_LENGTH),
        pageUrl: clipNullable(row.public_url, MAX_URL_LENGTH),
        pagePath: clipNullable(row.path, MAX_PATH_LENGTH),
        kind: "component",
        componentType: clipNullable(componentType, MAX_LABEL_LENGTH),
        primaryLabel: clipNullable(
          componentType ?? contextPurpose ?? "component",
          MAX_LABEL_LENGTH,
        ),
        viewport: input.viewport,
        state: input.state,
        observedAt: row.observed_eff,
        freshness: request.asOf - row.fresh_eff <= FRESH_MS ? "fresh" : "stale",
        matchedSampleKey: clipNullable(matchedSampleKeyFor(row), MAX_SAMPLE_KEY_LENGTH),
        explanations,
        explanationsTruncated,
        claims: summaries,
        screenshotKeys: screenshots.get(row.capture_id)?.keys ?? [],
        screenshotsTruncated: screenshots.get(row.capture_id)?.truncated ?? false,
        artifacts: artifacts.get(row.region_id) ?? [],
        coverage: parseCoverage(row.coverage_json),
        patternKey: clipNullable(patternKey, MAX_SAMPLE_KEY_LENGTH),
        group,
        ...(observationSpan ? { observationSpan } : {}),
        candidateOnly: input.evidenceMode === "candidate",
      };
    });

    const nextTuple =
      hasMore && pageSelected.length > 0
        ? sortTupleFor(pageSelected[pageSelected.length - 1]!, input, hasQuery)
        : null;

    const closing = db
      .prepare("SELECT revision, feature_revision FROM atlas_state WHERE singleton = 1")
      .get() as { revision: number; feature_revision: number } | undefined;
    if (!closing || closing.revision !== revision || closing.feature_revision !== revision) {
      db.exec("ROLLBACK");
      inTransaction = false;
      return errorResult(
        "SEARCH_NOT_READY",
        "Atlas search projections are not at the committed revision; retry the search",
        true,
      );
    }

    return commit({
      ok: true,
      data: {
        revision,
        ftsAvailable,
        hits,
        total,
        hasMore,
        nextTuple,
        facets,
        corpus: {
          sites: corpusRow.sites,
          pages: corpusRow.pages,
          captures: corpusRow.captures,
        },
        hasEligibleRegions: corpusRow.components > 0,
        stateEvidence,
        predicatePresence,
      } satisfies AtlasSearchQueryData,
    });
  } catch (error) {
    if (inTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    if (
      /SQLITE_BUSY|SQLITE_LOCKED|SQLITE_CANTOPEN|SQLITE_READONLY|database is locked|no such table|no such index|no such column/i.test(
        message,
      )
    ) {
      return errorResult(
        "SEARCH_NOT_READY",
        "Atlas search projections are not at the committed revision; retry the search",
        true,
      );
    }
    throw error;
  }
}
