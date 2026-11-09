import { DatabaseSync } from "node:sqlite";
import type { Cache } from "../cache.js";
import { stableHash } from "./identity.js";
import { migrateAtlas } from "./schema.js";
import { queryComponentAtlas } from "./search-components.js";
import {
  buildStateRegionTable,
  claimEligibilitySql,
  claimStateSql,
  claimTierSql,
  deriveRegionTag,
  rebuildAtlasSearchProjections,
  stateRegionEligibilitySql,
  structuralSql,
  tagFallbackSql,
} from "./search-projections.js";
export { deriveRegionTag } from "./search-projections.js";
import type { EvidenceCoverage } from "./types.js";
import {
  CANONICAL_LANDMARKS,
  COMPONENT_TYPES,
  SECTION_PURPOSES,
  canonicalLandmark,
  isSearchableVocabulary,
} from "./vocabulary.js";
import type {
  AtlasArtifactDescriptor,
  AtlasClaimSummary,
  AtlasCursorPayload,
  AtlasCursorRequest,
  AtlasFacet,
  AtlasHit,
  AtlasPredicate,
  AtlasPredicateExplanation,
  AtlasSearchCapture,
  AtlasSearchClaim,
  AtlasSearchErrorBody,
  AtlasSearchErrorCode,
  AtlasSearchPage,
  AtlasSearchQuery,
  AtlasSearchQueryData,
  AtlasSearchRegion,
  AtlasSearchResult,
  AtlasSearchSite,
  AtlasSearchSnapshot,
  AtlasSearchStore,
  AtlasSearchViewport,
  AtlasSnapshotFilters,
  CompiledSearch,
  CursorResult,
  InterpretedSearchInput,
  SearchAtlasData,
  SearchAtlasInput,
  SearchField,
} from "./search-types.js";

const DAY_MS = 86_400_000;
const FRESH_MS = 7 * DAY_MS;
const CURSOR_TTL_MS = 15 * 60_000;
const MAX_CURSOR_LENGTH = 4096;
const MAX_FACET_VALUES = 20;
export const MAX_WITNESS_IDS = 200;
/** Response-wide cap. The budget is shared across every hit and explanation. */
export const MAX_TOTAL_WITNESS_IDS = 2_000;
const MAX_ARTIFACTS = 8;
const MAX_CLAIM_SUMMARIES = 8;
const MAX_SCREENSHOTS_PER_HIT = 8;
/** A request slug longer than this can never name a cached site. */
const MAX_SITE_SLUG_LENGTH = 128;
const MAX_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 200;
const MAX_URL_LENGTH = 1024;
const MAX_PATH_LENGTH = 512;
const MAX_LABEL_LENGTH = 200;
const MAX_SAMPLE_KEY_LENGTH = 256;
const MAX_LIMITATIONS = 16;
/** Every successful search response fits this serialized byte budget. */
export const MAX_SEARCH_RESPONSE_BYTES = 262_144;

function clipText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function clipNullable(value: string | null | undefined, max: number): string | null {
  return typeof value === "string" ? clipText(value, max) : null;
}

export const REGION_TAGS: ReadonlySet<string> = new Set([
  "article",
  "aside",
  "body",
  "details",
  "dialog",
  "div",
  "figure",
  "footer",
  "form",
  "header",
  "main",
  "nav",
  "ol",
  "section",
  "table",
  "ul",
]);

/** Landmark values that scanner output can actually contain, after canonicalization. */
export const REGION_LANDMARKS: ReadonlySet<string> = new Set(CANONICAL_LANDMARKS);

const ARIA_LANDMARK_ROLES: readonly string[] = [
  "banner",
  "complementary",
  "contentinfo",
  "form",
  "main",
  "navigation",
  "region",
  "search",
];

export const REGION_ROLES: ReadonlySet<string> = new Set([
  ...ARIA_LANDMARK_ROLES,
  "alert",
  "alertdialog",
  "application",
  "article",
  "button",
  "cell",
  "columnheader",
  "combobox",
  "definition",
  "dialog",
  "directory",
  "document",
  "feed",
  "figure",
  "grid",
  "gridcell",
  "group",
  "heading",
  "img",
  "link",
  "list",
  "listbox",
  "listitem",
  "log",
  "marquee",
  "math",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "none",
  "note",
  "option",
  "presentation",
  "progressbar",
  "radio",
  "radiogroup",
  "row",
  "rowgroup",
  "rowheader",
  "scrollbar",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "status",
  "switch",
  "tab",
  "table",
  "tablist",
  "tabpanel",
  "term",
  "textbox",
  "timer",
  "toolbar",
  "tooltip",
  "tree",
  "treegrid",
  "treeitem",
]);

const SECTION_PREDICATE_FIELDS: ReadonlySet<string> = new Set([
  "section.purpose",
  "region.kind",
  "region.tag",
  "region.role",
  "region.landmark",
]);

const COMPONENT_PREDICATE_FIELDS: ReadonlySet<string> = new Set([
  "component.type",
  "context.section_purpose",
  "region.kind",
]);

function predicateFields(kind: InterpretedSearchInput["kind"]): ReadonlySet<string> {
  return kind === "components" ? COMPONENT_PREDICATE_FIELDS : SECTION_PREDICATE_FIELDS;
}

function regionKindFor(kind: InterpretedSearchInput["kind"]): "section" | "component" {
  return kind === "components" ? "component" : "section";
}

function errorResult(
  code: AtlasSearchErrorCode,
  message: string,
  retryable = false,
): AtlasSearchResult<never> {
  return { ok: false, error: { code, message, retryable } };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function tokenizeQuery(query: string): string[] {
  return query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function toFtsQuery(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" ");
}

function canonicalValues(
  field: SearchField,
  kind: InterpretedSearchInput["kind"],
): readonly string[] {
  switch (field) {
    case "section.purpose":
      return SECTION_PURPOSES.filter((value) => isSearchableVocabulary("section.purpose", value));
    case "component.type":
      return COMPONENT_TYPES.filter((value) => isSearchableVocabulary("component.type", value));
    case "context.section_purpose":
      return SECTION_PURPOSES.filter((value) =>
        isSearchableVocabulary("context.section_purpose", value),
      );
    case "region.kind":
      return [regionKindFor(kind)];
    case "region.tag":
      return [...REGION_TAGS].sort(cmp);
    case "region.role":
      return [...REGION_ROLES].sort(cmp);
    case "region.landmark":
      return [...REGION_LANDMARKS].sort(cmp);
  }
}

function valueSupported(
  field: SearchField,
  value: string,
  kind: InterpretedSearchInput["kind"],
): boolean {
  switch (field) {
    case "section.purpose":
      return isSearchableVocabulary("section.purpose", value);
    case "component.type":
      return isSearchableVocabulary("component.type", value);
    case "context.section_purpose":
      return isSearchableVocabulary("context.section_purpose", value);
    case "region.kind":
      return value === regionKindFor(kind);
    case "region.tag":
      return REGION_TAGS.has(value);
    case "region.role":
      return REGION_ROLES.has(value);
    case "region.landmark":
      return REGION_LANDMARKS.has(value);
  }
}

/**
 * The single canonicalization gate for predicate values and facet candidates.
 * A facet value that fails here could never be sent back as a predicate.
 */
function canonicalFacetValue(
  field: SearchField,
  raw: unknown,
  kind: InterpretedSearchInput["kind"],
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const value = field === "region.landmark" ? canonicalLandmark(trimmed) : trimmed;
  return value && valueSupported(field, value, kind) ? value : null;
}

function normalizeValues(
  field: SearchField,
  raw: unknown,
  kind: InterpretedSearchInput["kind"],
): string[] | null {
  if (!Array.isArray(raw)) return null;
  const values: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim().toLowerCase();
    if (!trimmed) return null;
    const value = field === "region.landmark" ? canonicalLandmark(trimmed) : trimmed;
    if (!value || !valueSupported(field, value, kind)) return null;
    if (!values.includes(value)) values.push(value);
  }
  return values.length > 0 && values.length <= 8 ? values : null;
}

/**
 * Validates the request and freezes it into a canonical, revision-independent
 * form. Does not touch the store, so invalid requests are rejected before SQL.
 */
export function compilePredicates(input: SearchAtlasInput): CompiledSearch {
  const invalid = (message: string): CompiledSearch =>
    ({ ok: false, error: { code: "INVALID_INPUT", message, retryable: false } });
  if (!input || typeof input !== "object") return invalid("input must be an object");
  if (input.kind !== "sections" && input.kind !== "components") {
    return invalid("kind must be sections or components");
  }
  const kind = input.kind;
  const allowedFields = predicateFields(kind);

  let query: string | undefined;
  let tokens: string[] = [];
  if (input.query !== undefined) {
    if (typeof input.query !== "string") return invalid("query must be a string");
    if (input.query.length < 1 || input.query.length > 300) {
      return invalid("query must be 1-300 characters");
    }
    query = input.query;
    tokens = tokenizeQuery(query);
    if (tokens.length === 0) return invalid("query must contain at least one letter or number");
    if (tokens.length > 16) return invalid("query accepts at most 16 tokens");
  }

  const rawPredicates = input.predicates ?? [];
  if (!Array.isArray(rawPredicates) || rawPredicates.length > 8) {
    return invalid("predicates accepts at most 8 entries");
  }
  const predicates: AtlasPredicate[] = [];
  for (const predicate of rawPredicates) {
    if (!predicate || typeof predicate !== "object") return invalid("predicate must be an object");
    const field = predicate.field as SearchField;
    if (!allowedFields.has(field)) {
      return {
        ok: false,
        error: {
          code: "UNSUPPORTED_PREDICATE",
          message: `Unsupported predicate field: ${String(predicate.field)}`,
          retryable: false,
        },
      };
    }
    const values = normalizeValues(field, predicate.values, kind);
    if (!values) {
      return {
        ok: false,
        error: {
          code: "UNSUPPORTED_PREDICATE",
          message: `Unsupported or empty values for ${field}`,
          retryable: false,
        },
      };
    }
    predicates.push({ field, values });
  }

  const scope = input.scope ?? "region";
  if (scope !== "region" && scope !== "page" && scope !== "site") {
    return invalid("scope must be region, page or site");
  }
  const viewport = input.viewport ?? "desktop";
  if (viewport !== "desktop" && viewport !== "mobile") {
    return invalid("viewport must be desktop or mobile");
  }
  const state = input.state ?? "default";
  if (state !== "default" && state !== "hover" && state !== "focus") {
    return invalid("state must be default, hover or focus");
  }

  const evidenceMode = input.evidenceMode ?? "candidate";
  if (evidenceMode !== "accepted" && evidenceMode !== "observed_only" && evidenceMode !== "candidate") {
    return invalid("evidenceMode must be accepted, observed_only or candidate");
  }

  let siteSlugs: string[] | undefined;
  if (input.siteSlugs !== undefined) {
    if (!Array.isArray(input.siteSlugs) || input.siteSlugs.length === 0) {
      return invalid("siteSlugs must contain 1-20 slugs");
    }
    const unique: string[] = [];
    for (const slug of input.siteSlugs) {
      if (typeof slug !== "string" || !/^[\w-]+$/.test(slug)) {
        return invalid("siteSlugs contains an invalid slug");
      }
      if (slug.length > MAX_SITE_SLUG_LENGTH) {
        return invalid(`siteSlugs accepts slugs of at most ${MAX_SITE_SLUG_LENGTH} characters`);
      }
      if (!unique.includes(slug)) unique.push(slug);
    }
    if (unique.length > 20) return invalid("siteSlugs accepts at most 20 distinct slugs");
    siteSlugs = unique.sort(cmp);
  }

  const maxAgeDays = input.maxAgeDays ?? 30;
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 3650) {
    return invalid("maxAgeDays must be an integer from 1 to 3650");
  }

  const groupBy = input.groupBy ?? (kind === "components" ? "pattern" : "instance");
  if (groupBy !== "instance" && groupBy !== "pattern") {
    return invalid("groupBy must be instance or pattern");
  }
  if (kind === "sections" && groupBy === "pattern") {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_GROUPING",
        message: "Pattern grouping applies to components; sections count region instances",
        retryable: false,
      },
    };
  }
  const sort = input.sort ?? "relevance";
  if (sort !== "relevance" && sort !== "newest") {
    return invalid("sort must be relevance or newest");
  }

  const rawFacets = input.facets ?? [];
  if (!Array.isArray(rawFacets)) return invalid("facets must be an array");
  const facets: SearchField[] = [];
  for (const value of rawFacets) {
    const field = value as SearchField;
    if (!allowedFields.has(field)) {
      return {
        ok: false,
        error: {
          code: "UNSUPPORTED_PREDICATE",
          message: `Unsupported facet field: ${String(value)}`,
          retryable: false,
        },
      };
    }
    if (!facets.includes(field)) facets.push(field);
  }
  if (facets.length > 4) return invalid("facets accepts at most 4 distinct fields");

  const limit = input.limit ?? 8;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    return invalid("limit must be an integer from 1 to 20");
  }

  let cursor: string | null = null;
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string" || input.cursor.length === 0) {
      return {
        ok: false,
        error: { code: "CURSOR_INVALID", message: "cursor must be a non-empty string", retryable: false },
      };
    }
    if (input.cursor.length > MAX_CURSOR_LENGTH) {
      return {
        ok: false,
        error: { code: "CURSOR_INVALID", message: "cursor exceeds 4096 characters", retryable: false },
      };
    }
    cursor = input.cursor;
  }

  const canonicalPredicates = predicates
    .map((predicate) => [predicate.field, [...predicate.values].sort(cmp)] as const)
    .sort((a, b) => cmp(a[0], b[0]) || cmp(a[1].join("\u0000"), b[1].join("\u0000")));
  const queryHash = stableHash(
    "atlas-search-v1",
    JSON.stringify({
      kind,
      query: tokens.join(" "),
      predicates: canonicalPredicates,
      scope,
      viewport,
      state,
      evidenceMode,
      siteSlugs: siteSlugs ?? null,
      maxAgeDays,
      groupBy,
      sort,
      facets: [...facets].sort(cmp),
      limit,
    }),
  );

  const interpreted: InterpretedSearchInput = {
    kind,
    ...(query === undefined ? {} : { query }),
    predicates,
    scope,
    viewport,
    state,
    evidenceMode,
    ...(siteSlugs === undefined ? {} : { siteSlugs }),
    maxAgeDays,
    groupBy,
    sort,
    facets,
    limit,
  };

  return {
    ok: true,
    input: interpreted,
    cursor,
    tokens,
    ftsQuery: toFtsQuery(tokens),
    queryHash,
  };
}

export function encodeCursor(payload: AtlasCursorPayload): string {
  const canonical: AtlasCursorPayload = {
    version: 1,
    revision: payload.revision,
    queryHash: payload.queryHash,
    asOf: payload.asOf,
    expiresAt: payload.expiresAt,
    lastSortTuple: payload.lastSortTuple,
  };
  return Buffer.from(JSON.stringify(canonical), "utf8").toString("base64url");
}

/**
 * Structural cursor validation only. Runs before any store or SQL access so a
 * malformed cursor, bad tuple or expired cursor never touches the corpus.
 */
export function decodeCursorStructure(
  value: string,
  now: number,
  expectedTupleLength?: number,
): CursorResult {
  const invalid = (message: string): CursorResult => ({
    ok: false,
    error: { code: "CURSOR_INVALID", message, retryable: false },
  });
  if (typeof value !== "string" || value.length === 0) return invalid("cursor is empty");
  if (value.length > MAX_CURSOR_LENGTH) return invalid("cursor exceeds 4096 characters");
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return invalid("cursor is not base64url");
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return invalid("cursor is not valid base64url");
  }
  if (decoded.length > MAX_CURSOR_LENGTH) return invalid("cursor payload is oversized");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return invalid("cursor is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") return invalid("cursor payload must be an object");
  const payload = parsed as Record<string, unknown>;
  if (payload.version !== 1) return invalid("unsupported cursor version");
  if (!Number.isInteger(payload.revision) || (payload.revision as number) < 0) {
    return invalid("cursor revision is invalid");
  }
  if (typeof payload.queryHash !== "string" || payload.queryHash.length === 0 || payload.queryHash.length > 128) {
    return invalid("cursor query hash is invalid");
  }
  if (!Number.isFinite(payload.asOf) || (payload.asOf as number) < 0) {
    return invalid("cursor asOf is invalid");
  }
  if (!Number.isFinite(payload.expiresAt)) return invalid("cursor expiry is invalid");
  const asOf = payload.asOf as number;
  const expiresAt = payload.expiresAt as number;
  if (asOf > now + 60_000) return invalid("cursor asOf is in the future");
  if (expiresAt <= asOf || expiresAt - asOf > CURSOR_TTL_MS + 1_000) {
    return invalid("cursor lifetime is invalid");
  }
  if (!Array.isArray(payload.lastSortTuple) || payload.lastSortTuple.length === 0 || payload.lastSortTuple.length > 8) {
    return invalid("cursor sort tuple is invalid");
  }
  if (expectedTupleLength !== undefined && payload.lastSortTuple.length !== expectedTupleLength) {
    return invalid("cursor sort tuple does not match this request");
  }
  const tuple: string[] = [];
  for (const item of payload.lastSortTuple) {
    if (typeof item !== "string" || item.length === 0 || item.length > 128) {
      return invalid("cursor sort tuple is invalid");
    }
    tuple.push(item);
  }
  if (tuple.reduce((total, item) => total + item.length, 0) > 1024) {
    return invalid("cursor sort tuple is oversized");
  }
  for (let index = 0; index < tuple.length - 1; index += 1) {
    if (!Number.isFinite(Number(tuple[index]))) {
      return invalid("cursor sort tuple is not numeric");
    }
  }
  if (now >= expiresAt) {
    return {
      ok: false,
      error: { code: "CURSOR_EXPIRED", message: "Cursor expired after 15 minutes; restart from page one", retryable: false },
    };
  }
  return {
    ok: true,
    cursor: {
      version: 1,
      revision: payload.revision as number,
      queryHash: payload.queryHash,
      asOf,
      expiresAt,
      lastSortTuple: tuple,
    },
  };
}

/**
 * Revision and query-hash validation. Runs after the store returns the current
 * revision because only the database knows whether the corpus moved.
 */
export function validateCursorContext(
  cursor: AtlasCursorPayload,
  request: AtlasCursorRequest,
  revision: number,
): AtlasSearchErrorBody | null {
  if (revision !== cursor.revision) {
    return { code: "CURSOR_STALE", message: "Atlas revision changed; restart from page one", retryable: false };
  }
  if (request.queryHash !== cursor.queryHash) {
    return {
      code: "CURSOR_QUERY_MISMATCH",
      message: "Cursor belongs to a different search request",
      retryable: false,
    };
  }
  return null;
}

/** Combined cursor validation kept for callers that already hold the revision. */
export function decodeCursor(
  value: string,
  request: AtlasCursorRequest,
  revision: number,
  now: number,
): CursorResult {
  const structural = decodeCursorStructure(value, now);
  if (!structural.ok) return structural;
  const context = validateCursorContext(structural.cursor, request, revision);
  return context ? { ok: false, error: context } : structural;
}

// ---------------------------------------------------------------------------
// SQL query planner
// ---------------------------------------------------------------------------

interface SqlPlan {
  input: InterpretedSearchInput;
  asOf: number;
  cutoff: number;
  hasQuery: boolean;
}

function placeholderList(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `:${prefix}${index}`).join(", ");
}

/** Structural predicate columns live in the derived region projection. */
function structuralName(field: SearchField): string | null {
  switch (field) {
    case "region.tag":
      return "tag";
    case "region.role":
      return "role";
    case "region.landmark":
      return "landmark";
    default:
      return null;
  }
}

function predicateValues(predicate: AtlasPredicate, index: number): string {
  return placeholderList(`p${index}v`, predicate.values.length);
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

type EffectivePredicateKind = "structural" | "purpose" | "kind";

interface EffectivePredicate {
  field: SearchField;
  values: string[];
  kind: EffectivePredicateKind;
}

/**
 * Collapses input predicates into the smallest equivalent filter set.
 * Region scope intersects same-field structural value sets because one region
 * has one tag/role/landmark. Page and site scope keep separate requirements:
 * a header and a footer can satisfy `tag=header` and `tag=footer` as two
 * witnesses in one capture or site. Repeated purpose predicates keep only the
 * narrowest value set, because a narrower set already proves the broader one.
 * Purpose sets that are not comparable stay separate so shared-sample
 * semantics hold.
 */
function effectivePredicates(
  predicates: AtlasPredicate[],
  scope: InterpretedSearchInput["scope"],
): EffectivePredicate[] {
  const effective: EffectivePredicate[] = [];
  for (const field of ["region.tag", "region.role", "region.landmark"] as const) {
    const sets = predicates.filter((predicate) => predicate.field === field).map((predicate) => predicate.values);
    if (sets.length === 0) continue;
    if (scope !== "region") {
      const keptSets: string[][] = [];
      for (const set of sets) {
        if (keptSets.some((kept) => kept.length === set.length && kept.every((value) => set.includes(value)))) {
          continue;
        }
        keptSets.push(set);
        effective.push({ field, values: set, kind: "structural" });
      }
      continue;
    }
    let values = [...sets[0]!];
    for (const set of sets.slice(1)) {
      values = values.filter((value) => set.includes(value));
    }
    effective.push({ field, values, kind: "structural" });
  }

  const purposes = predicates.filter((predicate) => predicate.field === "section.purpose");
  const kept: string[][] = [];
  for (const predicate of purposes) {
    const isSupersetOfNarrower = purposes.some(
      (other) =>
        other !== predicate &&
        other.values.length < predicate.values.length &&
        other.values.every((value) => predicate.values.includes(value)),
    );
    const alreadyKept = kept.some(
      (values) =>
        values.length === predicate.values.length &&
        values.every((value) => predicate.values.includes(value)),
    );
    if (isSupersetOfNarrower || alreadyKept) continue;
    kept.push(predicate.values);
  }
  for (const values of kept) {
    effective.push({ field: "section.purpose", values, kind: "purpose" });
  }

  if (predicates.some((predicate) => predicate.field === "region.kind")) {
    effective.push({ field: "region.kind", values: ["section"], kind: "kind" });
  }
  return effective;
}

function anchorTierSql(plan: SqlPlan): string {
  const state = `AND ${claimStateSql("cl", plan.input.state)}`;
  return `COALESCE((
    SELECT MIN(${claimTierSql("cl")})
    FROM atlas_claims cl
    WHERE cl.region_id = r.id
      AND ${claimEligibilitySql("cl", plan.input.evidenceMode)}
      ${state}
  ), 2)`;
}

// ---------------------------------------------------------------------------
// Scope metadata and predicate hit sets
// ---------------------------------------------------------------------------

/** Eligible active-head captures with the page/site metadata hits need. */
function prepareCaptureMeta(db: DatabaseSync, plan: SqlPlan): void {
  db.exec("DROP TABLE IF EXISTS temp.atlas_search_capture_meta");
  db.exec(`CREATE TEMP TABLE atlas_search_capture_meta (
    capture_id TEXT PRIMARY KEY,
    site_slug TEXT NOT NULL,
    page_id TEXT NOT NULL,
    observed INTEGER NOT NULL,
    fresh INTEGER NOT NULL,
    regions INTEGER NOT NULL
  ) WITHOUT ROWID`);
  const clauses = [
    "source_kind = 'live_page'",
    "status IN ('complete','partial')",
    "profile_key = :profileKey",
    "fresh IS NOT NULL",
    "fresh >= :cutoff",
  ];
  const params: Record<string, string | number> = {
    profileKey: `live-${plan.input.viewport}`,
    cutoff: plan.cutoff,
  };
  const slugs = plan.input.siteSlugs;
  if (slugs && slugs.length > 0) {
    clauses.push(`site_slug IN (${placeholderList("site", slugs.length)})`);
    slugs.forEach((slug, index) => {
      params[`site${index}`] = slug;
    });
  }
  db.prepare(
    `INSERT INTO temp.atlas_search_capture_meta
       (capture_id, site_slug, page_id, observed, fresh, regions)
     SELECT capture_id, site_slug, page_id, observed, fresh, regions
     FROM atlas_capture_summary
     WHERE ${clauses.join("\n   AND ")}`,
  ).run(params);
  if (plan.input.scope === "site") {
    // Page scope joins by capture_id; only site scope probes by site slug.
    db.exec(
      `CREATE INDEX atlas_search_capture_meta_site_idx
       ON atlas_search_capture_meta(site_slug, capture_id)`,
    );
  }
}

/** Anchor counts per capture, then per page/site scope. */
function prepareScopeCounts(db: DatabaseSync, plan: SqlPlan): void {
  if (plan.input.scope === "region") {
    // Region scope only needs the eligible-region check; page scope reuses
    // capture_meta directly and site scope builds the aggregate below.
    db.exec("DROP TABLE IF EXISTS temp.atlas_search_capture_counts");
    db.exec(`CREATE TEMP TABLE atlas_search_capture_counts (
      capture_id TEXT PRIMARY KEY,
      regions INTEGER NOT NULL
    ) WITHOUT ROWID`);
    db.exec(
      `INSERT INTO temp.atlas_search_capture_counts (capture_id, regions)
       SELECT capture_id, regions
       FROM temp.atlas_search_capture_meta
       WHERE regions > 0`,
    );
    return;
  }
  if (plan.input.scope === "page") {
    // `atlas_search_capture_meta` already carries the section count per
    // capture, so a page-scope copy would only add an insert per query.
    return;
  }
  db.exec("DROP TABLE IF EXISTS temp.atlas_search_capture_counts");
  db.exec(`CREATE TEMP TABLE atlas_search_capture_counts (
    capture_id TEXT PRIMARY KEY,
    regions INTEGER NOT NULL
  ) WITHOUT ROWID`);
  db.exec(
    `INSERT INTO temp.atlas_search_capture_counts (capture_id, regions)
     SELECT capture_id, regions
     FROM temp.atlas_search_capture_meta
     WHERE regions > 0`,
  );
  db.exec("DROP TABLE IF EXISTS temp.atlas_search_scope_counts");
  db.exec(`CREATE TEMP TABLE atlas_search_scope_counts (
    scope_key TEXT PRIMARY KEY,
    regions INTEGER NOT NULL
  ) WITHOUT ROWID`);
  db.exec(
    `INSERT INTO temp.atlas_search_scope_counts (scope_key, regions)
     SELECT cm.site_slug, SUM(cc.regions)
     FROM temp.atlas_search_capture_counts cc
     JOIN temp.atlas_search_capture_meta cm ON cm.capture_id = cc.capture_id
     GROUP BY cm.site_slug`,
  );
}

/**
 * Region-scope purpose predicates reduce to region-id sets. Repeated
 * predicates intersect, and sample keys must be shared so one region cannot
 * satisfy two predicates through unrelated evidence.
 */
function preparePurposeRegionMatches(
  db: DatabaseSync,
  plan: SqlPlan,
  purposes: EffectivePredicate[],
): string | null {
  if (purposes.length === 0) return null;
  const stateFilter = plan.input.state !== "default";
  const claimState = (alias: string): string =>
    `AND ${claimStateSql(alias, plan.input.state)}`;
  // The projection path cannot prove which sample a purpose belongs to, so a
  // state query always takes the claims path with its sample-key check.
  if (purposes.length === 1 && !stateFilter) {
    const predicate = purposes[0]!;
    const table = "atlas_search_purpose_matches";
    db.exec(`DROP TABLE IF EXISTS temp.${table}`);
    db.exec(`CREATE TEMP TABLE ${table} (
      region_id TEXT PRIMARY KEY,
      tier INTEGER NOT NULL
    ) WITHOUT ROWID`);
    const tierColumn = evidenceTierColumn(plan.input.evidenceMode);
    const params: Record<string, string | number> = {
      profileKey: `live-${plan.input.viewport}`,
      cutoff: plan.cutoff,
    };
    const placeholders = bindValues(params, "v", predicate.values);
    // The projection is already built from active eligible captures; only a
    // site filter can narrow it further, so pay the capture_meta join only then.
    const siteJoin =
      plan.input.siteSlugs === undefined
        ? ""
        : `JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = rp.region_id
           JOIN temp.atlas_search_capture_meta cm ON cm.capture_id = r.capture_id`;
    db.prepare(
      // A region satisfying several values of one OR predicate keeps its
      // best (lowest) qualifying tier; INSERT OR IGNORE used to keep whichever
      // row SQLite happened to visit first.
      `INSERT INTO temp.${table} (region_id, tier)
       SELECT rp.region_id, MIN(rp.${tierColumn})
       FROM atlas_region_purposes rp
       ${siteJoin}
       WHERE rp.value IN ${placeholders} AND rp.${tierColumn} IS NOT NULL
         AND rp.profile_key = :profileKey AND rp.fresh >= :cutoff
       GROUP BY rp.region_id`,
    ).run(params);
    return table;
  }
  const tables: string[] = [];
  purposes.forEach((predicate, index) => {
    const table = `atlas_search_purpose_${index}`;
    tables.push(table);
    db.exec(`DROP TABLE IF EXISTS temp.${table}`);
    db.exec(`CREATE TEMP TABLE ${table} (
      region_id TEXT PRIMARY KEY,
      tier INTEGER NOT NULL
    ) WITHOUT ROWID`);
    const params: Record<string, string | number> = {
      profileKey: `live-${plan.input.viewport}`,
      cutoff: plan.cutoff,
    };
    const placeholders = bindValues(params, "v", predicate.values);
    const siteJoin =
      plan.input.siteSlugs === undefined
        ? ""
        : `JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = cl.region_id
           JOIN temp.atlas_search_capture_meta cm ON cm.capture_id = r.capture_id`;
    if (stateFilter) {
      // The purpose projection is default-state only, so a state query reads
      // the state claims directly and takes freshness from capture_meta.
      delete params.profileKey;
      delete params.cutoff;
      db.prepare(
        `INSERT INTO temp.${table} (region_id, tier)
         SELECT cl.region_id, MIN(${claimTierSql("cl")})
         FROM atlas_claims cl
         JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = cl.region_id
         JOIN temp.atlas_search_capture_meta cm ON cm.capture_id = r.capture_id
         WHERE cl.field = 'section.purpose'
           AND cl.value IN ${placeholders}
           AND ${claimEligibilitySql("cl", plan.input.evidenceMode)}
           AND ${claimStateSql("cl", plan.input.state)}
         GROUP BY cl.region_id`,
      ).run(params);
      return;
    }
    db.prepare(
      `INSERT INTO temp.${table} (region_id, tier)
       SELECT cl.region_id, MIN(${claimTierSql("cl")})
       FROM atlas_claims cl INDEXED BY atlas_claims_facet_idx
       JOIN atlas_region_purposes rp
         ON rp.region_id = cl.region_id AND rp.value = cl.value
       ${siteJoin}
       WHERE cl.field = 'section.purpose'
         AND cl.value IN ${placeholders}
         AND ${claimEligibilitySql("cl", plan.input.evidenceMode)}
         AND ${claimStateSql("cl", plan.input.state)}
         AND rp.profile_key = :profileKey AND rp.fresh >= :cutoff
       GROUP BY cl.region_id`,
    ).run(params);
  });

  db.exec(`DROP TABLE IF EXISTS temp.atlas_search_purpose_matches`);
  db.exec(`CREATE TEMP TABLE atlas_search_purpose_matches (
    region_id TEXT PRIMARY KEY,
    tier INTEGER NOT NULL
  ) WITHOUT ROWID`);
  db.exec(
    `INSERT INTO temp.atlas_search_purpose_matches (region_id, tier)
     SELECT region_id, tier FROM temp.${tables[0]!}`,
  );
  for (const table of tables.slice(1)) {
    db.exec(
      `DELETE FROM temp.atlas_search_purpose_matches
       WHERE region_id NOT IN (SELECT region_id FROM temp.${table})`,
    );
    db.exec(
      `UPDATE temp.atlas_search_purpose_matches
       SET tier = MAX(tier, COALESCE((
         SELECT other.tier FROM temp.${table} other
         WHERE other.region_id = atlas_search_purpose_matches.region_id
       ), 0))`,
    );
  }
  if (tables.length < 2) {
    return "atlas_search_purpose_matches";
  }

  db.exec(`DROP TABLE IF EXISTS temp.atlas_search_purpose_samples`);
  db.exec(`CREATE TEMP TABLE atlas_search_purpose_samples (
    region_id TEXT NOT NULL,
    sample_key TEXT NOT NULL,
    PRIMARY KEY (region_id, sample_key)
  ) WITHOUT ROWID`);
  const firstParams: Record<string, string> = {};
  const firstValues = bindValues(firstParams, "v", purposes[0]!.values);
  db.prepare(
    `INSERT OR IGNORE INTO temp.atlas_search_purpose_samples (region_id, sample_key)
     SELECT cl.region_id, cl.sample_key
     FROM temp.atlas_search_purpose_matches pm
     JOIN atlas_claims cl INDEXED BY atlas_claims_region_idx ON cl.region_id = pm.region_id
     WHERE cl.field = 'section.purpose'
       AND cl.value IN ${firstValues}
       AND ${claimEligibilitySql("cl", plan.input.evidenceMode)}
       ${claimState("cl")}`,
  ).run(firstParams);
  purposes.slice(1).forEach((predicate) => {
    const params: Record<string, string> = {};
    const placeholders = bindValues(params, "v", predicate.values);
    db.prepare(
      `DELETE FROM temp.atlas_search_purpose_samples
       WHERE NOT EXISTS (
         SELECT 1 FROM atlas_claims cl INDEXED BY atlas_claims_region_idx
         WHERE cl.region_id = atlas_search_purpose_samples.region_id
           AND cl.sample_key = atlas_search_purpose_samples.sample_key
           AND cl.field = 'section.purpose'
           AND cl.value IN ${placeholders}
           AND ${claimEligibilitySql("cl", plan.input.evidenceMode)}
           ${claimState("cl")}
       )`,
    ).run(params);
  });
  db.exec(
    `DELETE FROM temp.atlas_search_purpose_matches
     WHERE region_id NOT IN (SELECT region_id FROM temp.atlas_search_purpose_samples)`,
  );
  return "atlas_search_purpose_matches";
}

/**
 * Page/site scope sets read precomputed features. Site rows carry the site
 * profile and the newest confirmation among the captures holding the value,
 * so `fresh >= cutoff` is exactly "some eligible capture for this viewport".
 */
function prepareFeatureScopeSet(
  db: DatabaseSync,
  plan: SqlPlan,
  predicate: EffectivePredicate,
  table: string,
): void {
  db.exec(`DROP TABLE IF EXISTS temp.${table}`);
  db.exec(`CREATE TEMP TABLE ${table} (
    scope_key TEXT PRIMARY KEY,
    tier INTEGER NOT NULL
  ) WITHOUT ROWID`);
  const tierColumn =
    predicate.kind === "purpose" ? evidenceTierColumn(plan.input.evidenceMode) : "structural_tier";
  const tierValue = predicate.kind === "purpose" ? `MIN(${tierColumn})` : "1";
  const params: Record<string, string | number> = {};
  const placeholders = bindValues(params, "v", predicate.values);
  // State-scoped structural witnesses come from the same eligible state
  // regions the query will return, never from the default-state projections.
  const stateStructuralExpression = (): string =>
    predicate.field === "region.tag"
      ? `COALESCE(${structuralSql("region.tag", "r")}, ${tagFallbackSql("r")})`
      : structuralSql(predicate.field, "r")!;
  if (plan.input.scope === "page") {
    if (predicate.field === "section.purpose") {
      if (plan.input.state !== "default") {
        db.prepare(
          `INSERT OR IGNORE INTO temp.${table} (scope_key, tier)
           SELECT r.capture_id, MIN(${claimTierSql("cl")})
           FROM atlas_claims cl INDEXED BY atlas_claims_state_region_idx
           JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = cl.region_id
           JOIN temp.atlas_search_capture_meta cm ON cm.capture_id = r.capture_id
           WHERE cl.field = 'section.purpose'
             AND cl.value IN ${placeholders}
             AND ${claimEligibilitySql("cl", plan.input.evidenceMode)}
             AND ${claimStateSql("cl", plan.input.state)}
           GROUP BY r.capture_id`,
        ).run(params);
        return;
      }
      db.prepare(
        `INSERT OR IGNORE INTO temp.${table} (scope_key, tier)
         SELECT p.capture_id, ${tierValue}
         FROM atlas_capture_purposes p
         JOIN temp.atlas_search_capture_meta cm ON cm.capture_id = p.capture_id
         WHERE p.value IN ${placeholders} AND p.${tierColumn} IS NOT NULL
         GROUP BY p.capture_id`,
      ).run(params);
      return;
    }
    if (plan.input.state !== "default") {
      db.prepare(
        `INSERT OR IGNORE INTO temp.${table} (scope_key, tier)
         SELECT r.capture_id, 1
         FROM temp.atlas_search_state_regions sr
         JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = sr.region_id
         JOIN temp.atlas_search_capture_meta cm ON cm.capture_id = r.capture_id
         WHERE r.kind = 'section'
           AND ${stateStructuralExpression()} IN ${placeholders}
         GROUP BY r.capture_id`,
      ).run(params);
      return;
    }
    db.prepare(
      `INSERT OR IGNORE INTO temp.${table} (scope_key, tier)
       SELECT f.capture_id, 1
       FROM atlas_capture_features f
       JOIN temp.atlas_search_capture_meta cm ON cm.capture_id = f.capture_id
       WHERE f.field = '${predicate.field}'
         AND f.value IN ${placeholders}
         AND f.structural_tier IS NOT NULL`,
    ).run(params);
    return;
  }
  if (predicate.field === "section.purpose") {
    if (plan.input.state !== "default") {
      db.prepare(
        `INSERT OR IGNORE INTO temp.${table} (scope_key, tier)
         SELECT cm.site_slug, MIN(${claimTierSql("cl")})
         FROM atlas_claims cl INDEXED BY atlas_claims_state_region_idx
         JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = cl.region_id
         JOIN temp.atlas_search_capture_meta cm ON cm.capture_id = r.capture_id
         WHERE cl.field = 'section.purpose'
           AND cl.value IN ${placeholders}
           AND ${claimEligibilitySql("cl", plan.input.evidenceMode)}
           AND ${claimStateSql("cl", plan.input.state)}
         GROUP BY cm.site_slug`,
      ).run(params);
      return;
    }
    // Site membership and tier come from the eligible capture set only; a
    // stale desktop capture can never contribute the site's purpose tier.
    db.prepare(
      `INSERT OR IGNORE INTO temp.${table} (scope_key, tier)
       SELECT cm.site_slug, MIN(p.${tierColumn})
       FROM atlas_capture_purposes p
       JOIN temp.atlas_search_capture_meta cm ON cm.capture_id = p.capture_id
       WHERE p.value IN ${placeholders} AND p.${tierColumn} IS NOT NULL
       GROUP BY cm.site_slug`,
    ).run(params);
    return;
  }
  if (plan.input.state !== "default") {
    db.prepare(
      `INSERT OR IGNORE INTO temp.${table} (scope_key, tier)
       SELECT cm.site_slug, 1
       FROM temp.atlas_search_state_regions sr
       JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = sr.region_id
       JOIN temp.atlas_search_capture_meta cm ON cm.capture_id = r.capture_id
       WHERE r.kind = 'section'
         AND ${stateStructuralExpression()} IN ${placeholders}
       GROUP BY cm.site_slug`,
    ).run(params);
    return;
  }
  params.profileKey = `live-${plan.input.viewport}`;
  params.cutoff = plan.cutoff;
  db.prepare(
    `INSERT OR IGNORE INTO temp.${table} (scope_key, tier)
     SELECT sf.site_slug, 1
     FROM atlas_site_features sf
     JOIN (SELECT DISTINCT site_slug FROM temp.atlas_search_capture_meta) cm
       ON cm.site_slug = sf.site_slug
     WHERE sf.profile_key = :profileKey
       AND sf.field = '${predicate.field}'
       AND sf.value IN ${placeholders}
       AND sf.structural_tier IS NOT NULL
       AND sf.fresh >= :cutoff
     GROUP BY sf.site_slug`,
  ).run(params);
}

interface PredicateSet {
  field: SearchField;
  table: string;
}

/** Intersects page/site scope sets into one table, keeping the best tier. */
function intersectScopeSets(
  db: DatabaseSync,
  target: string,
  sets: PredicateSet[],
  withTier = true,
): string | null {
  if (sets.length === 0) return null;
  db.exec(`DROP TABLE IF EXISTS temp.${target}`);
  db.exec(`CREATE TEMP TABLE ${target} (
    scope_key TEXT PRIMARY KEY,
    tier INTEGER NOT NULL
  ) WITHOUT ROWID`);
  if (!withTier) {
    const selects = sets.map(
      (set) => `SELECT scope_key FROM temp.${set.table}`,
    );
    db.exec(
      `INSERT INTO temp.${target} (scope_key, tier)
       SELECT scope_key, 0 FROM (${selects.join(" INTERSECT ")})`,
    );
    return target;
  }
  if (sets.length === 1) {
    db.exec(
      `INSERT INTO temp.${target} (scope_key, tier)
       SELECT scope_key, tier FROM temp.${sets[0]!.table}`,
    );
    return target;
  }
  const unions = sets
    .map(
      (set) =>
        `SELECT scope_key, tier FROM temp.${set.table}`,
    )
    .join(" UNION ALL ");
  db.exec(
    `INSERT INTO temp.${target} (scope_key, tier)
     SELECT scope_key, MAX(tier)
     FROM (${unions})
     GROUP BY scope_key
     HAVING COUNT(*) = ${sets.length}`,
  );
  return target;
}

/** Restricts a region-id set to FTS matches, if the query has text tokens. */
function evidenceTierColumn(mode: InterpretedSearchInput["evidenceMode"]): string {
  if (mode === "accepted") return "accepted_tier";
  if (mode === "observed_only") return "observed_tier";
  return "candidate_tier";
}

function prepareMatchedCaptures(
  db: DatabaseSync,
  plan: SqlPlan,
  matches: string | null,
): void {
  db.exec(`DROP TABLE IF EXISTS temp.atlas_search_matched_captures`);
  db.exec(`CREATE TEMP TABLE atlas_search_matched_captures (
    capture_id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    observed INTEGER NOT NULL,
    fresh INTEGER NOT NULL
  ) WITHOUT ROWID`);
  if (plan.input.scope === "page") {
    const source = matches
      ? `SELECT m.scope_key AS capture_id, m.scope_key, cm.observed, cm.fresh
         FROM temp.${matches} m
         JOIN temp.atlas_search_capture_meta cm ON cm.capture_id = m.scope_key`
      : `SELECT capture_id, capture_id AS scope_key, observed, fresh
         FROM temp.atlas_search_capture_meta`;
    db.exec(`INSERT INTO temp.atlas_search_matched_captures SELECT * FROM (${source})`);
    return;
  }
  const source = matches
    ? `SELECT cm.capture_id, m.scope_key, cm.observed, cm.fresh
       FROM temp.${matches} m
       JOIN temp.atlas_search_capture_meta cm ON cm.site_slug = m.scope_key`
    : `SELECT capture_id, site_slug AS scope_key, observed, fresh
       FROM temp.atlas_search_capture_meta`;
  db.exec(`INSERT INTO temp.atlas_search_matched_captures SELECT * FROM (${source})`);
}

function sortColumns(plan: SqlPlan): string[] {
  const observed = "-observed_eff";
  if (plan.input.sort === "newest") {
    return plan.hasQuery
      ? [observed, "bm25", "tier", "region_id"]
      : [observed, "tier", "region_id"];
  }
  return plan.hasQuery
    ? ["bm25", "tier", observed, "region_id"]
    : ["tier", observed, "ordinal", "region_id"];
}

function sortTupleFor(row: AnchorRow, plan: SqlPlan): string[] {
  if (plan.input.sort === "newest") {
    return plan.hasQuery
      ? [String(-row.observed_eff), String(row.bm25), String(row.tier), row.region_id]
      : [String(-row.observed_eff), String(row.tier), row.region_id];
  }
  return plan.hasQuery
    ? [String(row.bm25), String(row.tier), String(-row.observed_eff), row.region_id]
    : [String(row.tier), String(-row.observed_eff), String(row.ordinal), row.region_id];
}

interface AnchorRow {
  region_id: string;
  capture_id: string;
  ordinal: number;
  locator_json: string | null;
  samples_json: string;
  pattern_key: string | null;
  primary_label: string | null;
  coverage_json: string;
  page_id: string;
  site_slug: string;
  public_url: string | null;
  path: string | null;
  site_title: string | null;
  site_live_url: string | null;
  observed_eff: number;
  fresh_eff: number;
  tier: number;
  bm25: number | null;
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

interface ScreenshotKeys {
  keys: string[];
  truncated: boolean;
}

function loadScreenshots(
  db: DatabaseSync,
  captureIds: string[],
): Map<string, ScreenshotKeys> {
  const result = new Map<string, ScreenshotKeys>();
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
    if (entry.keys.length >= MAX_SCREENSHOTS_PER_HIT) {
      entry.truncated = true;
    } else {
      entry.keys.push(clipText(row.key, MAX_SAMPLE_KEY_LENGTH));
    }
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

interface WitnessBudget {
  remaining: number;
}

function witnessParams(
  plan: SqlPlan,
  row: AnchorRow,
  _predicate: AtlasPredicate,
  _index: number,
): Record<string, string | number> {
  return {
    scopeKey: plan.input.scope === "page" ? row.capture_id : row.site_slug,
  };
}

function witnessScopeFrom(plan: SqlPlan): string {
  return plan.input.scope === "site"
    ? "JOIN temp.atlas_search_capture_meta wcm ON wcm.capture_id = r.capture_id"
    : "";
}

function witnessScopeWhere(plan: SqlPlan, alias: string): string {
  return plan.input.scope === "page"
    ? `${alias}.capture_id = :scopeKey`
    : "wcm.site_slug = :scopeKey";
}

function structuralWitnessMatch(
  field: SearchField,
  values: string[],
  prefix = "w",
): string {
  if (field === "region.kind") return "1 = 1";
  const expression = structuralSql(field, "r");
  if (!expression) return "1 = 0";
  const placeholders = `(${values.map((_, index) => `:${prefix}${index}`).join(", ")})`;
  if (field === "region.tag") {
    return `(${expression} IN ${placeholders}
      OR (${expression} IS NULL AND ${tagFallbackSql("r")} IN ${placeholders}))`;
  }
  return `${expression} IN ${placeholders}`;
}

function witnessIdsFor(
  db: DatabaseSync,
  plan: SqlPlan,
  row: AnchorRow,
  predicate: AtlasPredicate,
  index: number,
  maxIds: number,
): { ids: string[]; sampleKeys: string[]; truncated: boolean } {
  if (plan.input.scope === "region") {
    let sampleKeys: string[] = [];
    if (predicate.field === "section.purpose") {
      const params: Record<string, string> = { anchorId: row.region_id };
      predicate.values.forEach((value, valueIndex) => {
        params[`p${index}v${valueIndex}`] = value;
      });
      sampleKeys = (
        db
          .prepare(
            `SELECT DISTINCT cl.sample_key AS sample_key
             FROM atlas_claims cl INDEXED BY atlas_claims_region_idx
             WHERE cl.region_id = :anchorId
               AND cl.field = 'section.purpose'
               AND cl.value IN (${predicateValues(predicate, index)})
               AND ${claimEligibilitySql("cl", plan.input.evidenceMode)}
               AND ${claimStateSql("cl", plan.input.state)}
             ORDER BY cl.sample_key
             LIMIT 3`,
          )
          .all(params) as Array<{ sample_key: string }>
      ).map((sample) => sample.sample_key);
    }
    return { ids: [row.region_id], sampleKeys, truncated: false };
  }

  const cap = Math.min(MAX_WITNESS_IDS, Math.max(0, maxIds));
  if (cap <= 0) return { ids: [], sampleKeys: [], truncated: false };
  const params = witnessParams(plan, row, predicate, index);
  const scopeFrom = witnessScopeFrom(plan);
  const scopeWhere = witnessScopeWhere(plan, "r");
  let sampleKeys: string[] = [];
  let rows: Array<{ id: string }>;
  if (predicate.field === "section.purpose") {
    predicate.values.forEach((value, valueIndex) => {
      params[`p${index}v${valueIndex}`] = value;
    });
    rows = db
      .prepare(
        `SELECT r.id AS id, r.ordinal AS ordinal
         FROM atlas_regions r INDEXED BY atlas_regions_sort_idx
         ${scopeFrom}
         JOIN atlas_claims cl INDEXED BY atlas_claims_region_idx ON cl.region_id = r.id
         WHERE r.kind = 'section'
           AND ${scopeWhere}
           AND cl.field = 'section.purpose'
           AND cl.value IN (${predicateValues(predicate, index)})
           AND ${claimEligibilitySql("cl", plan.input.evidenceMode)}
           AND ${claimStateSql("cl", plan.input.state)}
         GROUP BY r.id
         ORDER BY r.ordinal, r.id
         LIMIT ${cap + 1}`,
      )
      .all(params) as Array<{ id: string }>;
    sampleKeys = (
      db
        .prepare(
          `SELECT DISTINCT cl.sample_key AS sample_key
           FROM atlas_regions r INDEXED BY atlas_regions_sort_idx
           ${scopeFrom}
           JOIN atlas_claims cl INDEXED BY atlas_claims_region_idx ON cl.region_id = r.id
           WHERE r.kind = 'section'
             AND ${scopeWhere}
             AND cl.field = 'section.purpose'
             AND cl.value IN (${predicateValues(predicate, index)})
             AND ${claimEligibilitySql("cl", plan.input.evidenceMode)}
             AND ${claimStateSql("cl", plan.input.state)}
           ORDER BY cl.sample_key
           LIMIT 3`,
        )
        .all(params) as Array<{ sample_key: string }>
    ).map((sample) => sample.sample_key);
  } else {
    const match = structuralWitnessMatch(predicate.field, predicate.values);
    if (predicate.field !== "region.kind") {
      predicate.values.forEach((value, valueIndex) => {
        params[`w${valueIndex}`] = value;
      });
    }
    rows = db
      .prepare(
        `SELECT r.id AS id, r.ordinal AS ordinal
         FROM atlas_regions r INDEXED BY atlas_regions_sort_idx
         ${scopeFrom}
         WHERE r.kind = 'section'
           AND ${scopeWhere}
           AND ${match}
           ${plan.input.state === "default" ? "" : `AND ${stateRegionEligibilitySql("r.id")}`}
         ORDER BY r.ordinal, r.id
         LIMIT ${cap + 1}`,
      )
      .all(params) as Array<{ id: string }>;
  }
  return {
    ids: rows.slice(0, cap).map((witness) => witness.id),
    sampleKeys,
    truncated: rows.length > cap,
  };
}

function observationSpanFor(
  db: DatabaseSync,
  plan: SqlPlan,
  row: AnchorRow,
): { from: number; to: number } | undefined {
  if (plan.input.scope !== "site") return undefined;
  const parts: string[] = [];
  const params: Record<string, string | number> = {
    anchorCapture: row.capture_id,
    siteSlug: row.site_slug,
  };
  parts.push(
    `SELECT cm.observed AS obs
     FROM temp.atlas_search_capture_meta cm
     WHERE cm.capture_id = :anchorCapture
       AND cm.site_slug = :siteSlug`,
  );
  plan.input.predicates.forEach((predicate, index) => {
    if (predicate.field === "section.purpose") {
      predicate.values.forEach((value, valueIndex) => {
        params[`p${index}v${valueIndex}`] = value;
      });
      parts.push(
        `SELECT cm.observed AS obs
         FROM atlas_regions r INDEXED BY atlas_regions_sort_idx
         JOIN temp.atlas_search_capture_meta cm ON cm.capture_id = r.capture_id
         JOIN atlas_claims cl INDEXED BY atlas_claims_region_idx ON cl.region_id = r.id
         WHERE r.kind = 'section'
           AND cm.site_slug = :siteSlug
           AND cl.field = 'section.purpose'
           AND cl.value IN (${predicateValues(predicate, index)})
           AND ${claimEligibilitySql("cl", plan.input.evidenceMode)}
           AND ${claimStateSql("cl", plan.input.state)}`,
      );
      return;
    }
    // Distinct parameter names per predicate: every UNION ALL branch sees the
    // same statement bindings, so shared names would make each branch test the
    // last predicate's values.
    const prefix = `o${index}`;
    if (predicate.field !== "region.kind") {
      predicate.values.forEach((value, valueIndex) => {
        params[`${prefix}${valueIndex}`] = value;
      });
    }
    parts.push(
      `SELECT cm.observed AS obs
       FROM atlas_regions r INDEXED BY atlas_regions_sort_idx
       JOIN temp.atlas_search_capture_meta cm ON cm.capture_id = r.capture_id
       WHERE r.kind = 'section'
         AND cm.site_slug = :siteSlug
         AND ${structuralWitnessMatch(predicate.field, predicate.values, prefix)}
         ${plan.input.state === "default" ? "" : `AND ${stateRegionEligibilitySql("r.id")}`}`,
    );
  });
  const span = db
    .prepare(
      `SELECT MIN(obs) AS from_ts, MAX(obs) AS to_ts
       FROM (${parts.join(" UNION ALL ")})`,
    )
    .get(params) as { from_ts: number; to_ts: number } | undefined;
  return span ? { from: span.from_ts, to: span.to_ts } : undefined;
}

function matchedSampleKeyFor(
  db: DatabaseSync,
  plan: SqlPlan,
  row: AnchorRow,
  cache: Map<string, string | null>,
): string | null {
  const purposes = plan.input.predicates.filter(
    (predicate) => predicate.field === "section.purpose",
  );
  if (purposes.length === 0) return null;
  const params: Record<string, string | number> =
    plan.input.scope === "region"
      ? { anchorId: row.region_id }
      : { scopeKey: plan.input.scope === "page" ? row.capture_id : row.site_slug };
  const cacheKey = `${plan.input.scope}:${String(params.anchorId ?? params.scopeKey)}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;
  const having = purposes
    .map((predicate, index) => {
      const placeholders = bindValues(params, `ms${index}v`, predicate.values);
      return `SUM(CASE WHEN cl.value IN ${placeholders} THEN 1 ELSE 0 END) > 0`;
    })
    .join(" AND ");
  const where =
    plan.input.scope === "region"
      ? `WHERE cl.region_id = :anchorId`
      : `WHERE r.kind = 'section'
           AND ${witnessScopeWhere(plan, "r")}`;
  const from =
    plan.input.scope === "region"
      ? `FROM atlas_claims cl INDEXED BY atlas_claims_region_idx`
      : `FROM atlas_regions r INDEXED BY atlas_regions_sort_idx
         ${witnessScopeFrom(plan)}
         JOIN atlas_claims cl INDEXED BY atlas_claims_region_idx ON cl.region_id = r.id`;
  // A sample key must carry every repeated predicate's value itself; two
  // unrelated claims in the same scope are not a shared observation.
  const sql = `SELECT MIN(sample_key) AS sample_key FROM (
    SELECT cl.sample_key AS sample_key
    ${from}
    ${where}
      AND cl.field = 'section.purpose'
      AND ${claimEligibilitySql("cl", plan.input.evidenceMode)}
      AND ${claimStateSql("cl", plan.input.state)}
    GROUP BY cl.region_id, cl.sample_key
    HAVING ${having}
  )`;
  const found = db.prepare(sql).get(params) as { sample_key: string | null } | undefined;
  const sampleKey = found?.sample_key ?? null;
  cache.set(cacheKey, sampleKey);
  return sampleKey;
}

function buildExplanations(
  db: DatabaseSync,
  plan: SqlPlan,
  row: AnchorRow,
  budget: WitnessBudget,
): { explanations: AtlasPredicateExplanation[]; truncated: boolean } {
  const explanations: AtlasPredicateExplanation[] = [];
  let truncated = false;
  plan.input.predicates.forEach((predicate, index) => {
    if (budget.remaining <= 0) {
      explanations.push({
        field: predicate.field,
        values: predicate.values,
        supportingRegionIds: [],
        sampleKeys: [],
        truncated: true,
      });
      truncated = true;
      return;
    }
    const witness = witnessIdsFor(db, plan, row, predicate, index, budget.remaining);
    const take = Math.min(witness.ids.length, budget.remaining);
    budget.remaining -= take;
    if (witness.truncated || take < witness.ids.length) truncated = true;
    const supporting = witness.ids
      .slice(0, take)
      .filter((id) => id.length <= MAX_ID_LENGTH);
    if (supporting.length < take) truncated = true;
    explanations.push({
      field: predicate.field,
      values: predicate.values,
      supportingRegionIds: supporting,
      sampleKeys: witness.sampleKeys.map((key) => clipText(key, MAX_SAMPLE_KEY_LENGTH)),
      truncated: witness.truncated || take < witness.ids.length || supporting.length < take,
    });
  });
  return { explanations, truncated };
}

function toHit(
  db: DatabaseSync,
  plan: SqlPlan,
  row: AnchorRow,
  claims: AtlasSearchClaim[],
  screenshots: Map<string, ScreenshotKeys>,
  artifacts: Map<string, AtlasArtifactDescriptor[]>,
  sampleKeys: Map<string, string | null>,
  budget: WitnessBudget,
): AtlasHit {
  const summaries = claimSummaries(claims);
  const purpose = summaries.find((claim) => claim.field === "section.purpose")?.value ?? null;
  const { explanations, truncated } = buildExplanations(db, plan, row, budget);
  const observationSpan = observationSpanFor(db, plan, row);
  return {
    regionId: row.region_id,
    captureId: row.capture_id,
    pageId: row.page_id,
    siteSlug: clipText(row.site_slug, MAX_SITE_SLUG_LENGTH),
    siteTitle: clipText(row.site_title ?? row.site_slug, MAX_TEXT_LENGTH),
    sitePublicUrl: clipNullable(row.site_live_url, MAX_URL_LENGTH),
    sourceUrl: clipNullable(row.public_url, MAX_URL_LENGTH),
    pageUrl: clipNullable(row.public_url, MAX_URL_LENGTH),
    pagePath: clipNullable(row.path, MAX_PATH_LENGTH),
    kind: "section",
    componentType: null,
    primaryLabel: clipNullable(row.primary_label ?? purpose, MAX_LABEL_LENGTH),
    viewport: plan.input.viewport,
    state: plan.input.state,
    observedAt: row.observed_eff,
    freshness: plan.asOf - row.fresh_eff <= FRESH_MS ? "fresh" : "stale",
    matchedSampleKey: clipNullable(
      matchedSampleKeyFor(db, plan, row, sampleKeys),
      MAX_SAMPLE_KEY_LENGTH,
    ),
    explanations,
    explanationsTruncated: truncated,
    claims: summaries,
    screenshotKeys: screenshots.get(row.capture_id)?.keys ?? [],
    screenshotsTruncated: screenshots.get(row.capture_id)?.truncated ?? false,
    artifacts: artifacts.get(row.region_id) ?? [],
    coverage: parseCoverage(row.coverage_json),
    patternKey: clipNullable(row.pattern_key, MAX_SAMPLE_KEY_LENGTH),
    group: null,
    ...(observationSpan ? { observationSpan } : {}),
    candidateOnly: plan.input.evidenceMode === "candidate",
  };
}

interface FacetCount {
  value: string;
  count: number;
}

/** Turns raw counts into the capped, canonical facet payload. */
function facetFor(plan: SqlPlan, field: SearchField, rows: FacetCount[]): AtlasFacet {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = canonicalFacetValue(field, row.value, plan.input.kind);
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + row.count);
  }
  const selected = new Set(
    plan.input.predicates
      .filter((predicate) => predicate.field === field)
      .flatMap((predicate) => predicate.values),
  );
  const candidates = new Set<string>(canonicalValues(field, plan.input.kind));
  for (const value of counts.keys()) candidates.add(value);
  for (const value of selected) candidates.add(value);
  const ordered = [...candidates]
    .map((value) => ({
      value,
      count: counts.get(value) ?? 0,
      selected: selected.has(value),
    }))
    .sort((left, right) => right.count - left.count || cmp(left.value, right.value));
  // Every selected value is echoed back, even with zero matches; only
  // unselected suggestions are capped.
  const top = [
    ...ordered.filter((item) => item.selected),
    ...ordered.filter((item) => !item.selected).slice(0, MAX_FACET_VALUES),
  ];
  top.sort((left, right) => right.count - left.count || cmp(left.value, right.value));
  return {
    field,
    disjunctive: true,
    countUnit:
      plan.input.kind === "components" && plan.input.groupBy === "pattern"
        ? "component_pattern"
        : "region_instance",
    values: top,
  };
}

interface SelectedAnchor {
  region_id: string;
  capture_id: string;
  ordinal: number;
  tier: number;
  observed_eff: number;
  fresh_eff: number;
  bm25: number | null;
}

/**
 * Any storage failure search can recover from by retrying: a writer holding
 * the lock, a read-only open racing `-wal`/`-shm` creation, or a projection
 * object missing while another process upgrades the cache. Never surface a raw
 * SQLite message to callers.
 */
function isSearchStorageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const errcode = (error as { errcode?: number } | null)?.errcode;
  return (
    errcode === 5 ||
    errcode === 6 ||
    errcode === 8 ||
    errcode === 10 ||
    errcode === 11 ||
    errcode === 14 ||
    errcode === 17 ||
    errcode === 18 ||
    errcode === 19 ||
    errcode === 20 ||
    errcode === 21 ||
    errcode === 23 ||
    errcode === 26 ||
    /SQLITE_BUSY|SQLITE_LOCKED|SQLITE_CANTOPEN|SQLITE_READONLY|SQLITE_NOTADB|SQLITE_CORRUPT|SQLITE_IOERR|database is locked|database table is locked|unable to open database file|no such table|no such index|no such column/i.test(
      message,
    )
  );
}

const NOT_READY_MESSAGE =
  "Atlas search projections are not at the committed revision; retry the search";

/**
 * Runs the whole search against a SQLite connection whose Atlas tables are
 * seeded. Predicates resolve to indexed hit sets; only the requested anchor
 * page is materialized with its JSON payload, witnesses, claims and artifacts.
 *
 * The query path is read-only: projections are rebuilt by publish inside its
 * write transaction, so search only verifies `feature_revision` under a read
 * snapshot and retries once before returning a typed SEARCH_NOT_READY.
 */
export function queryAtlasDatabase(
  db: DatabaseSync,
  request: AtlasSearchQuery,
  options: { ftsAvailable?: boolean; scores?: Record<string, number> } = {},
): AtlasSearchResult<AtlasSearchQueryData> {
  if (request.input.kind === "components") {
    const first = queryComponentAtlas(db, request, options);
    if (first.ok || first.error.code !== "SEARCH_NOT_READY") return first;
    return queryComponentAtlas(db, request, options);
  }
  const first = queryAtlasSnapshot(db, request, options);
  if (first.ok || first.error.code !== "SEARCH_NOT_READY") return first;
  return queryAtlasSnapshot(db, request, options);
}

function queryAtlasSnapshot(
  db: DatabaseSync,
  request: AtlasSearchQuery,
  options: { ftsAvailable?: boolean; scores?: Record<string, number> },
): AtlasSearchResult<AtlasSearchQueryData> {
  const plan: SqlPlan = {
    input: request.input,
    asOf: request.asOf,
    cutoff: request.asOf - request.input.maxAgeDays * DAY_MS,
    hasQuery: request.tokens.length > 0,
  };
  let inTransaction = false;
  try {
    // Connection setup is part of the retryable path: a read-only open can
    // fail while another process is creating the WAL sidecars.
    db.function("atlas_region_tag", { deterministic: true }, (tag: unknown, selector: unknown) =>
      deriveRegionTag(tag, selector),
    );
    // Search builds small per-query projections; a 32 MiB page cache per
    // connection keeps that predictable. Production opens one connection per
    // search, so concurrent searches each carry their own page cache while
    // sharing the persisted v8 projections.
    db.exec("PRAGMA temp_store = MEMORY");
    db.exec("PRAGMA cache_size = -32768");
    // Deferred read transaction: revision and feature_revision are read from
    // one snapshot and every projection row in the response comes from it.
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
      return errorResult("SEARCH_NOT_READY", NOT_READY_MESSAGE, true);
    }
    const revision = state.revision;
    const ftsTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'atlas_regions_fts'")
      .get();
    let ftsAvailable =
      options.ftsAvailable ?? (Boolean(ftsTable) && (state?.fts_version ?? 0) > 0);

    const commit = <T>(value: T): T => {
      db.exec("COMMIT");
      inTransaction = false;
      return value;
    };

    db.exec(
      "CREATE TEMP TABLE IF NOT EXISTS atlas_search_scores (region_id TEXT PRIMARY KEY, score REAL NOT NULL) WITHOUT ROWID",
    );
    db.exec("DELETE FROM temp.atlas_search_scores");

    if (plan.hasQuery) {
      if (!ftsAvailable) {
        return commit(errorResult("FTS_UNAVAILABLE", "FTS5 is unavailable; retry without a text query"));
      }
      try {
        if (options.scores) {
          const insert = db.prepare(
            "INSERT OR REPLACE INTO temp.atlas_search_scores (region_id, score) VALUES (?, ?)",
          );
          for (const [regionId, score] of Object.entries(options.scores)) {
            if (Number.isFinite(score)) insert.run(regionId, score);
          }
        } else {
          db.prepare(
            `INSERT INTO temp.atlas_search_scores (region_id, score)
             SELECT region_id, bm25(atlas_regions_fts, 0.0, 5.0, 4.0, 1.0, 5.0, 1.0) AS score
             FROM atlas_regions_fts
             WHERE atlas_regions_fts MATCH ?`,
          ).run(request.ftsQuery ?? "");
        }
      } catch {
        ftsAvailable = false;
        return commit(errorResult("FTS_UNAVAILABLE", "FTS5 is unavailable; retry without a text query"));
      }
    }

    const effective = effectivePredicates(plan.input.predicates, plan.input.scope);
    prepareCaptureMeta(db, plan);
    prepareScopeCounts(db, plan);
    const stateFilter = plan.input.state !== "default";
    const stateEvidence = stateFilter
      ? buildStateRegionTable(db, {
          captureTable: "atlas_search_capture_meta",
          kind: "section",
          state: plan.input.state === "hover" ? "hover" : "focus",
          mode: plan.input.evidenceMode,
        })
      : 0;
    const stateRegion = (regionExpr: string): string =>
      stateFilter ? `AND ${stateRegionEligibilitySql(regionExpr)}` : "";
    const scopeCountTable =
      plan.input.scope === "page"
        ? "atlas_search_capture_meta"
        : "atlas_search_scope_counts";
    const eligibleCountTable =
      plan.input.scope === "page"
        ? "atlas_search_capture_meta"
        : "atlas_search_capture_counts";
    const scopeCountKey = plan.input.scope === "page" ? "capture_id" : "scope_key";
    const summaryCaptures = (
      db.prepare("SELECT COUNT(*) AS n FROM atlas_capture_summary").get() as { n: number }
    ).n;
    /** A structural value present in every capture never filters scopes. */
    const isUniversalStructural = (predicate: EffectivePredicate): boolean => {
      if (predicate.kind !== "structural") return false;
      // `atlas_feature_totals` is built from default-state features; a state
      // query must never inherit that universality and skip its witness set.
      if (plan.input.state !== "default") return false;
      // Universality is corpus-wide; a site filter can make a globally
      // universal tag non-universal for the requested subset.
      if (plan.input.siteSlugs !== undefined && plan.input.siteSlugs !== null) return false;
      if (summaryCaptures === 0) return false;
      return predicate.values.some((value) => {
        const row = db
          .prepare(
            "SELECT captures FROM atlas_feature_totals WHERE field = ? AND value = ?",
          )
          .get(predicate.field, value) as { captures: number } | undefined;
        return row?.captures === summaryCaptures;
      });
    };
    let allRegionsEligibleCache: boolean | null = null;
    const allRegionsEligible = (): boolean => {
      if (allRegionsEligibleCache === null) {
        const eligible = (
          db
            .prepare(`SELECT COALESCE(SUM(regions), 0) AS total FROM temp.${eligibleCountTable}`)
            .get() as { total: number }
        ).total;
        const regionTotal = (
          db
            .prepare(
              `SELECT COUNT(*) AS total FROM atlas_regions INDEXED BY atlas_regions_kind_idx
               WHERE kind = 'section'`,
            )
            .get() as { total: number }
        ).total;
        allRegionsEligibleCache = eligible === regionTotal;
      }
      return allRegionsEligibleCache;
    };
    /** Materialized once per query for filters that cannot join capture_meta directly. */
    let eligibleRegionsTableCache: string | null = null;
    const eligibleRegions = (): string => {
      if (eligibleRegionsTableCache) return eligibleRegionsTableCache;
      const table = "atlas_search_eligible_regions";
      db.exec(`DROP TABLE IF EXISTS temp.${table}`);
      db.exec(`CREATE TEMP TABLE ${table} (
        region_id TEXT PRIMARY KEY
      ) WITHOUT ROWID`);
      db.exec(
        `INSERT INTO temp.${table} (region_id)
         SELECT r.id
         FROM temp.atlas_search_capture_meta cm
         JOIN atlas_regions r INDEXED BY atlas_regions_capture_idx
           ON r.capture_id = cm.capture_id
         WHERE r.kind = 'section'`,
      );
      eligibleRegionsTableCache = table;
      return table;
    };
    /**
     * Projection tables already contain only active, live, publishable and
     * fresh captures, so a site filter is the only query filter that can
     * narrow them further. FTS-seeded sets need the full eligibility check.
     */
    const restrictToEligible = (table: string): void => {
      if (allRegionsEligible()) return;
      db.exec(
        `DELETE FROM temp.${table}
         WHERE region_id NOT IN (SELECT region_id FROM temp.${eligibleRegions()})`,
      );
    };
    const restrictToSite = (table: string): void => {
      if (plan.input.siteSlugs === undefined) return;
      db.exec(
        `DELETE FROM temp.${table}
         WHERE region_id NOT IN (SELECT region_id FROM temp.${eligibleRegions()})`,
      );
    };
    /** Same site restriction as a WHERE fragment for projection scans. */
    const regionEligibilityCondition = (alias: string): string =>
      plan.input.siteSlugs === undefined
        ? ""
        : `${alias}.region_id IN (SELECT region_id FROM temp.${eligibleRegions()})`;
    const regionEligibilitySql = (alias: string): string => {
      const condition = regionEligibilityCondition(alias);
      return condition ? `AND ${condition}` : "";
    };

    let ftsRegions: string | null = null;
    let ftsAnchors: string | null = null;
    if (plan.hasQuery) {
      db.exec(`DROP TABLE IF EXISTS temp.atlas_search_fts_regions`);
      db.exec(`CREATE TEMP TABLE atlas_search_fts_regions (
        region_id TEXT PRIMARY KEY,
        tier INTEGER NOT NULL
      ) WITHOUT ROWID`);
      db.exec(
        // Section search must never seed from component FTS rows: components
        // are a different anchor kind and a component-only text match is an
        // honest no-match for kind=sections.
        `INSERT INTO temp.atlas_search_fts_regions (region_id, tier)
         SELECT sc.region_id, 0
         FROM temp.atlas_search_scores sc
         JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = sc.region_id
         WHERE r.kind = 'section'`,
      );
      db.exec(`DROP TABLE IF EXISTS temp.atlas_search_fts_anchors`);
      db.exec(`CREATE TEMP TABLE atlas_search_fts_anchors (
        region_id TEXT PRIMARY KEY,
        capture_id TEXT NOT NULL
      ) WITHOUT ROWID`);
      db.exec(
        `INSERT INTO temp.atlas_search_fts_anchors (region_id, capture_id)
         SELECT sc.region_id, r.capture_id
         FROM temp.atlas_search_scores sc
         JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = sc.region_id
         WHERE r.kind = 'section'`,
      );
      ftsRegions = "atlas_search_fts_regions";
      ftsAnchors = "atlas_search_fts_anchors";
    }

    const structuralPredicates = effective.filter((predicate) => predicate.kind === "structural");
    // Region scope and every page/site facet query need the region-level
    // purpose hit set; non-query page/site predicates stay on capture totals.
    const purpose =
      plan.input.scope === "region" || plan.hasQuery
        ? preparePurposeRegionMatches(
            db,
            plan,
            effective.filter((predicate) => predicate.kind === "purpose"),
          )
        : null;

    const scopeSets: PredicateSet[] = [];
    const scopePredicates = effective.filter((predicate) => predicate.kind !== "kind");
    if (plan.input.scope !== "region") {
      scopePredicates.forEach((predicate, index) => {
        if (isUniversalStructural(predicate)) return;
        const table = `atlas_search_scope_set_${index}`;
        prepareFeatureScopeSet(db, plan, predicate, table);
        scopeSets.push({ field: predicate.field, table });
      });
      if (effective.some((predicate) => predicate.kind === "kind")) {
        const table = "atlas_search_scope_set_kind";
        db.exec(`DROP TABLE IF EXISTS temp.${table}`);
        db.exec(`CREATE TEMP TABLE ${table} (
          scope_key TEXT PRIMARY KEY,
          tier INTEGER NOT NULL
        ) WITHOUT ROWID`);
        db.exec(
          `INSERT INTO temp.${table} (scope_key, tier)
           SELECT ${scopeCountKey} AS scope_key, 1 FROM temp.${scopeCountTable}`,
        );
        scopeSets.push({ field: "region.kind", table });
      }
    }

    /**
     * Index-only pass over `atlas_region_features`. The projection already
     * carries the tag fallback and only eligible captures, so region-scope
     * predicates never re-extract JSON from regions.
     */
    const buildFeaturesHits = (
      target: string,
      structural: EffectivePredicate[],
    ): string | null => {
      if (structural.length === 0) return null;
      db.exec(`DROP TABLE IF EXISTS temp.${target}`);
      db.exec(`CREATE TEMP TABLE ${target} (
        region_id TEXT PRIMARY KEY,
        tier INTEGER NOT NULL
      ) WITHOUT ROWID`);
      structural.forEach((predicate, index) => {
        const params: Record<string, string | number> = {
          profileKey: `live-${plan.input.viewport}`,
          cutoff: plan.cutoff,
        };
        const placeholders = bindValues(params, `f${index}v`, predicate.values);
        if (index === 0) {
          if (stateFilter) {
            // The state region set is small; drive the feature scan from it
            // instead of selecting the corpus-wide value set first.
            db.prepare(
              `INSERT OR IGNORE INTO temp.${target} (region_id, tier)
               SELECT rf.region_id, 1
               FROM temp.atlas_search_state_regions sr
               JOIN atlas_region_features rf INDEXED BY atlas_region_features_region_idx
                 ON rf.region_id = sr.region_id
               WHERE rf.field = '${predicate.field}' AND rf.value IN ${placeholders}
                 AND rf.profile_key = :profileKey AND rf.fresh >= :cutoff`,
            ).run(params);
            return;
          }
          db.prepare(
            `INSERT OR IGNORE INTO temp.${target} (region_id, tier)
             SELECT region_id, 1 FROM atlas_region_features
             WHERE field = '${predicate.field}' AND value IN ${placeholders}
               AND profile_key = :profileKey AND fresh >= :cutoff`,
          ).run(params);
          return;
        }
        if (stateFilter) {
          db.prepare(
            `DELETE FROM temp.${target}
             WHERE region_id NOT IN (
               SELECT rf.region_id
               FROM temp.atlas_search_state_regions sr
               JOIN atlas_region_features rf INDEXED BY atlas_region_features_region_idx
                 ON rf.region_id = sr.region_id
               WHERE rf.field = '${predicate.field}' AND rf.value IN ${placeholders}
                 AND rf.profile_key = :profileKey AND rf.fresh >= :cutoff
             )`,
          ).run(params);
          return;
        }
        db.prepare(
          `DELETE FROM temp.${target}
           WHERE region_id NOT IN (
             SELECT region_id FROM atlas_region_features
             WHERE field = '${predicate.field}' AND value IN ${placeholders}
               AND profile_key = :profileKey AND fresh >= :cutoff
           )`,
        ).run(params);
      });
      restrictToSite(target);
      if (stateFilter) {
        db.exec(
          `DELETE FROM temp.${target}
           WHERE region_id NOT IN (
             SELECT region_id FROM temp.atlas_search_state_regions
           )`,
        );
      }
      return target;
    };

    /**
     * Region hits start from the narrowest available set (purpose claims) and
     * filter candidates through the covering feature index. Without a purpose
     * seed, one index-only scan applies all structural predicates at once.
     */
    let purposeFeaturesTable: string | null = null;
    const purposeFeatures = (): string => {
      if (purposeFeaturesTable) return purposeFeaturesTable;
      const table = "atlas_search_purpose_features";
      db.exec(`DROP TABLE IF EXISTS temp.${table}`);
      db.exec(`CREATE TEMP TABLE ${table} (
        region_id TEXT PRIMARY KEY,
        tier INTEGER NOT NULL,
        tag TEXT,
        role TEXT,
        landmark TEXT
      ) WITHOUT ROWID`);
      db.exec(
        `INSERT INTO temp.${table} (region_id, tier, tag, role, landmark)
         SELECT pm.region_id, pm.tier,
                COALESCE(${structuralSql("region.tag", "r")}, ${tagFallbackSql("r")}),
                ${structuralSql("region.role", "r")},
                ${structuralSql("region.landmark", "r")}
         FROM temp.${purpose!} pm
         CROSS JOIN atlas_regions r INDEXED BY atlas_regions_features_idx ON r.id = pm.region_id`,
      );
      // Facets read this table directly, so the text anchors must narrow it
      // here as well; otherwise a structural facet counts every
      // purpose-matching region and drops the query.
      if (ftsRegions) {
        db.exec(
          `DELETE FROM temp.${table}
           WHERE region_id NOT IN (SELECT region_id FROM temp.${ftsRegions})`,
        );
      }
      purposeFeaturesTable = table;
      return table;
    };

    const structuralConditions = (
      prefix: string,
      structural: EffectivePredicate[],
    ): { clauses: string[]; params: Record<string, string> } => {
      const clauses: string[] = [];
      const params: Record<string, string> = {};
      structural.forEach((predicate, index) => {
        const name = structuralName(predicate.field)!;
        const placeholders = bindValues(params, `${prefix}${index}v`, predicate.values);
        clauses.push(`${prefix}.${name} IN ${placeholders}`);
      });
      return { clauses, params };
    };

    const buildRegionHits = (target: string, excludeField?: SearchField): string | null => {
      const structural = structuralPredicates.filter(
        (predicate) => predicate.field !== excludeField,
      );
      if (purpose && excludeField !== "section.purpose") {
        const features = purposeFeatures();
        const conditions = structuralConditions("pf", structural);
        db.exec(`DROP TABLE IF EXISTS temp.${target}`);
        db.exec(`CREATE TEMP TABLE ${target} (
          region_id TEXT PRIMARY KEY,
          tier INTEGER NOT NULL
        ) WITHOUT ROWID`);
        db.prepare(
          `INSERT INTO temp.${target} (region_id, tier)
           SELECT region_id, tier FROM temp.${features} pf
           ${conditions.clauses.length > 0 ? `WHERE ${conditions.clauses.join(" AND ")}` : ""}`,
        ).run(conditions.params);
        if (structural.length > 0) {
          db.exec(`UPDATE temp.${target} SET tier = MAX(tier, 1)`);
        }
        if (ftsRegions) {
          db.exec(
            `DELETE FROM temp.${target}
             WHERE region_id NOT IN (SELECT region_id FROM temp.${ftsRegions})`,
          );
        }
        // `purpose_features` already joined the eligible capture set.
        return target;
      }
      const features = buildFeaturesHits(target, structural);
      if (features) {
        if (ftsRegions) {
          db.exec(
            `DELETE FROM temp.${target}
             WHERE region_id NOT IN (SELECT region_id FROM temp.${ftsRegions})`,
          );
        }
        // `atlas_region_features` only contains eligible captures.
        return target;
      }
      let seed: { table: string } | null = null;
      if (ftsRegions) seed = { table: ftsRegions };
      if (!seed) return null;
      db.exec(`DROP TABLE IF EXISTS temp.${target}`);
      db.exec(`CREATE TEMP TABLE ${target} (
        region_id TEXT PRIMARY KEY,
        tier INTEGER NOT NULL
      ) WITHOUT ROWID`);
      db.exec(
        `INSERT INTO temp.${target} (region_id, tier)
         SELECT region_id, tier FROM temp.${seed.table}`,
      );
      restrictToEligible(target);
      if (stateFilter) {
        db.exec(
          `DELETE FROM temp.${target}
           WHERE region_id NOT IN (
             SELECT region_id FROM temp.atlas_search_state_regions
           )`,
        );
      }
      return target;
    };
    const regionHits =
      plan.input.scope === "region" ? buildRegionHits("atlas_search_region_hits") : null;

    const predSets: PredicateSet[] = [...scopeSets];
    const scopeMatches =
      plan.input.scope === "region"
        ? null
        : intersectScopeSets(db, "atlas_search_scope_matches", predSets);

    let matchedCaptures: string | null = null;
    if (plan.input.scope !== "region") {
      prepareMatchedCaptures(db, plan, scopeMatches);
      matchedCaptures = "atlas_search_matched_captures";
    }

    // Total results. Region hits are exact rows; page/site totals are sums over
    // scope counts so no anchor rows are materialized for counting.
    const total = (() => {
      if (plan.input.scope === "region") {
        if (regionHits) {
          return (db.prepare(`SELECT COUNT(*) AS total FROM temp.${regionHits}`).get() as { total: number })
            .total;
        }
        if (ftsAnchors) {
          return (
            db
              .prepare(
                `SELECT COUNT(*) AS total
                 FROM temp.${ftsAnchors} fa
                 JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = fa.region_id
                 WHERE 1 = 1 ${stateRegion("r.id")}`,
              )
              .get() as { total: number }
          ).total;
        }
        return (
          db
            .prepare(
              `SELECT COUNT(*) AS total
               FROM temp.atlas_search_capture_meta cm
               CROSS JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx
                 ON r.capture_id = cm.capture_id
               WHERE r.kind = 'section' ${stateRegion("r.id")}`,
            )
            .get() as { total: number }
        ).total;      }
      if (plan.hasQuery && ftsAnchors) {
        return (
          db
            .prepare(
              `SELECT COUNT(*) AS total
               FROM temp.${ftsAnchors} fa
               JOIN temp.${matchedCaptures!} mc ON mc.capture_id = fa.capture_id
               ${stateFilter ? `JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = fa.region_id` : ""}
               ${stateFilter ? `WHERE ${stateRegionEligibilitySql("r.id")}` : ""}`,
            )
            .get() as { total: number }
        ).total;
      }
      if (stateFilter) {
        return (
          db
            .prepare(
              `SELECT COUNT(*) AS total
               FROM atlas_regions r
               JOIN temp.${matchedCaptures!} mc ON mc.capture_id = r.capture_id
               WHERE r.kind = 'section'
                 AND ${stateRegionEligibilitySql("r.id")}`,
            )
            .get() as { total: number }
        ).total;
      }
      return (
        db
          .prepare(
            `SELECT COALESCE(SUM(sc.regions), 0) AS total
             FROM temp.${scopeCountTable} sc
             ${scopeMatches ? `JOIN temp.${scopeMatches} m ON m.scope_key = sc.${scopeCountKey}` : ""}`,
          )
          .get() as { total: number }
      ).total;
    })();

    const sort = sortColumns(plan);
    const params: Record<string, string | number> = { take: plan.input.limit + 1 };
    let cursorWhere = "";
    if (request.afterTuple) {
      request.afterTuple.forEach((value, index) => {
        params[`a${index}`] =
          index === request.afterTuple!.length - 1 ? value : Number(value);
      });
      cursorWhere = `WHERE (${sort.join(", ")}) > (${placeholderList("a", request.afterTuple.length)})`;
    }

    let selected: SelectedAnchor[];
    if (plan.input.scope === "region") {
      const tierSql = regionHits ? "h.tier" : anchorTierSql(plan);
      const from = regionHits
        ? `FROM temp.${regionHits} h
           CROSS JOIN atlas_regions r INDEXED BY atlas_regions_features_idx ON r.id = h.region_id
           JOIN temp.atlas_search_capture_meta meta ON meta.capture_id = r.capture_id`
        : `FROM atlas_regions r
           JOIN temp.atlas_search_capture_meta meta ON meta.capture_id = r.capture_id`;
      const queryJoin = plan.hasQuery
        ? "JOIN temp.atlas_search_scores sc ON sc.region_id = r.id"
        : "";
      selected = db
        .prepare(
          `WITH filtered AS (
             SELECT r.id AS region_id, r.capture_id, r.ordinal,
                    ${tierSql} AS tier,
                    meta.observed AS observed_eff,
                    meta.fresh AS fresh_eff,
                    ${plan.hasQuery ? "sc.score" : "NULL"} AS bm25
             ${from}
             ${queryJoin}
             WHERE r.kind = 'section'
               ${stateRegion("r.id")}
           )
           SELECT * FROM filtered
           ${cursorWhere}
           ORDER BY ${sort.join(", ")}
           LIMIT :take`,
        )
        .all(params) as unknown as SelectedAnchor[];
    } else {
      const tierSql = scopeMatches ? "m.tier" : anchorTierSql(plan);
      const queryJoin = plan.hasQuery
        ? "JOIN temp.atlas_search_scores sc ON sc.region_id = r.id"
        : "";
      const from = plan.hasQuery && ftsAnchors
        ? `FROM temp.${ftsAnchors} fa
           JOIN temp.${matchedCaptures!} mc ON mc.capture_id = fa.capture_id
           CROSS JOIN atlas_regions r INDEXED BY atlas_regions_features_idx ON r.id = fa.region_id
           ${scopeMatches ? `JOIN temp.${scopeMatches} m ON m.scope_key = mc.scope_key` : ""}`
        : `FROM temp.${matchedCaptures!} mc
           CROSS JOIN atlas_regions r INDEXED BY atlas_regions_sort_idx ON r.capture_id = mc.capture_id
           ${scopeMatches ? `JOIN temp.${scopeMatches} m ON m.scope_key = mc.scope_key` : ""}`;
      const bm25 = plan.hasQuery ? "sc.score" : "NULL";
      selected = db
        .prepare(
          `WITH filtered AS (
             SELECT r.id AS region_id, r.capture_id, r.ordinal,
                    ${tierSql} AS tier,
                    mc.observed AS observed_eff,
                    mc.fresh AS fresh_eff,
                    ${bm25} AS bm25
             ${from}
             ${queryJoin}
             WHERE r.kind = 'section'
               ${stateRegion("r.id")}
           )
           SELECT * FROM filtered
           ${cursorWhere}
           ORDER BY ${sort.join(", ")}
           LIMIT :take`,
        )
        .all(params) as unknown as SelectedAnchor[];
    }

    const hasMore = selected.length > plan.input.limit;
    const pageSelected = selected.slice(0, plan.input.limit);

    // Fetch the heavy payload for only the selected anchors.
    const detailById = new Map<string, AnchorRow>();
    if (pageSelected.length > 0) {
      const detailParams: Record<string, string> = {};
      pageSelected.forEach((row, index) => {
        detailParams[`d${index}`] = row.region_id;
      });
      const detailRows = db
        .prepare(
          `SELECT r.id AS region_id, r.capture_id, r.ordinal, r.locator_json, r.samples_json,
                  r.pattern_key, r.primary_label, r.coverage_json,
                  meta.page_id, meta.site_slug, meta.observed AS observed_eff, meta.fresh AS fresh_eff,
                  p.public_url, p.path, s.title AS site_title, s.liveUrl AS site_live_url
           FROM atlas_regions r
           JOIN temp.atlas_search_capture_meta meta ON meta.capture_id = r.capture_id
           JOIN atlas_pages p ON p.id = meta.page_id
           LEFT JOIN sites s ON s.slug = meta.site_slug
           WHERE r.id IN (${placeholderList("d", pageSelected.length)})`,
        )
        .all(detailParams) as unknown as AnchorRow[];
      for (const row of detailRows) detailById.set(row.region_id, row);
    }
    const pageRows: AnchorRow[] = pageSelected.map((row) => {
      const detail = detailById.get(row.region_id);
      return {
        ...(detail ?? {
          region_id: row.region_id,
          capture_id: row.capture_id,
          ordinal: row.ordinal,
          locator_json: null,
          samples_json: "{}",
          pattern_key: null,
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
      };
    });

    const corpusRow = db
      .prepare(
        `SELECT CASE WHEN EXISTS (
           SELECT 1 FROM temp.atlas_search_capture_meta cm WHERE cm.regions > 0
         ) THEN 1 ELSE 0 END AS regions,
                COUNT(DISTINCT cm.site_slug) AS sites,
                COUNT(DISTINCT cm.page_id) AS pages,
                COUNT(*) AS captures
         FROM temp.atlas_search_capture_meta cm
         WHERE cm.regions > 0`,
      )
      .get() as { regions: number; sites: number; pages: number; captures: number };

    const predicatePresence: Partial<Record<SearchField, boolean>> = {};
    for (const field of total > 0
      ? []
      : new Set(plan.input.predicates.map((predicate) => predicate.field))) {
      if (field === "region.kind") {
        predicatePresence[field] = stateFilter
          ? stateEvidence > 0
          : corpusRow.regions > 0;
        continue;
      }
      const requested = [
        ...new Set(
          plan.input.predicates
            .filter((predicate) => predicate.field === field)
            .flatMap((predicate) => predicate.values),
        ),
      ];
      const present = stateFilter
        ? field === "section.purpose"
          ? db
              .prepare(
                `SELECT 1 AS present
                 FROM atlas_claims cl INDEXED BY atlas_claims_facet_idx
                 JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = cl.region_id
                 JOIN temp.atlas_search_capture_meta cm ON cm.capture_id = r.capture_id
                 WHERE r.kind = 'section'
                   AND cl.field = 'section.purpose'
                   AND ${claimEligibilitySql("cl", plan.input.evidenceMode)}
                   AND ${claimStateSql("cl", plan.input.state)}
                 LIMIT 1`,
              )
              .get()
          : (() => {
              const params: Record<string, string> = { presenceField: field };
              const placeholders = bindValues(params, "presence", requested);
              return db
                .prepare(
                  `SELECT 1 AS present
                   FROM atlas_region_features f
                   JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = f.region_id
                   JOIN temp.atlas_search_capture_meta cm ON cm.capture_id = r.capture_id
                   WHERE f.field = :presenceField AND f.value IN ${placeholders}
                     AND r.kind = 'section'
                     AND ${stateRegionEligibilitySql("r.id")}
                   LIMIT 1`,
                )
                .get(params);
            })()
        : field === "section.purpose"
          ? // Purpose presence is field-level: a corpus with eligible purpose
            // evidence but no requested value is a genuine no-match. A stale,
            // mobile-only or candidate-only corpus is insufficient coverage.
            db
              .prepare(
                `SELECT 1 AS present
                 FROM atlas_capture_purposes p
                 JOIN temp.atlas_search_capture_meta cm ON cm.capture_id = p.capture_id
                 WHERE p.${evidenceTierColumn(plan.input.evidenceMode)} IS NOT NULL
                 LIMIT 1`,
              )
              .get()
          : (() => {
              // Structural presence is value-level: the tag/role/landmark must
              // itself exist in an eligible capture.
              const params: Record<string, string> = { presenceField: field };
              const placeholders = bindValues(params, "presence", requested);
              return db
                .prepare(
                  `SELECT 1 AS present
                   FROM atlas_capture_features f
                   JOIN temp.atlas_search_capture_meta cm ON cm.capture_id = f.capture_id
                   WHERE f.field = :presenceField AND f.value IN ${placeholders}
                     AND f.structural_tier IS NOT NULL
                   LIMIT 1`,
                )
                .get(params);
            })();
      predicatePresence[field] = Boolean(present);
    }

    // Facet counts are computed after the page so they never depend on limit.
    const facetCaptures = (facetMatches: string | null): string => {
      db.exec("DROP TABLE IF EXISTS temp.atlas_search_facet_captures");
      db.exec(`CREATE TEMP TABLE atlas_search_facet_captures (
        capture_id TEXT PRIMARY KEY
      ) WITHOUT ROWID`);
      if (plan.input.scope === "page") {
        db.exec(
          facetMatches
            ? `INSERT INTO temp.atlas_search_facet_captures (capture_id)
               SELECT m.scope_key FROM temp.${facetMatches} m
               JOIN temp.atlas_search_capture_meta cm ON cm.capture_id = m.scope_key`
            : `INSERT INTO temp.atlas_search_facet_captures (capture_id)
               SELECT capture_id FROM temp.atlas_search_capture_meta`,
        );
        return "atlas_search_facet_captures";
      }
      db.exec(
        facetMatches
          ? `INSERT INTO temp.atlas_search_facet_captures (capture_id)
             SELECT cm.capture_id FROM temp.atlas_search_capture_meta cm
             JOIN temp.${facetMatches} m ON m.scope_key = cm.site_slug`
          : `INSERT INTO temp.atlas_search_facet_captures (capture_id)
             SELECT capture_id FROM temp.atlas_search_capture_meta`,
      );
      return "atlas_search_facet_captures";
    };

    const facetRowsFor = (field: SearchField): FacetCount[] => {
      const tierColumn = evidenceTierColumn(plan.input.evidenceMode);
      if (plan.input.scope === "region") {
        if (field === "region.kind") {
          const hits = buildRegionHits("atlas_search_facet_hits");
          const count = hits
            ? (db.prepare(`SELECT COUNT(*) AS total FROM temp.${hits}`).get() as { total: number }).total
            : (
                db
                  .prepare(
                    `SELECT COUNT(*) AS total
                     FROM temp.atlas_search_capture_meta cm
                     CROSS JOIN atlas_regions r INDEXED BY atlas_regions_features_idx
                       ON r.capture_id = cm.capture_id
                     WHERE r.kind = 'section' ${stateRegion("r.id")}`,
                  )
                  .get() as { total: number }
              ).total;
          return [{ value: "section", count }];
        }
        if (purpose && field !== "section.purpose") {
          const features = purposeFeatures();
          const structural = structuralPredicates.filter(
            (predicate) => predicate.field !== field,
          );
          const conditions = structuralConditions("pf", structural);
          const name = structuralName(field)!;
          return db
            .prepare(
              `SELECT pf.${name} AS value, COUNT(*) AS count
               FROM temp.${features} pf
               ${conditions.clauses.length > 0 ? `WHERE ${conditions.clauses.join(" AND ")}` : ""}
               ${conditions.clauses.length > 0 ? "AND" : "WHERE"} pf.${name} IS NOT NULL
               GROUP BY pf.${name}`,
            )
            .all(conditions.params) as unknown as FacetCount[];
        }
        if (field === "section.purpose" && stateFilter) {
          // The purpose projection is default-state only. Count the requested
          // state's claims over the state region set (already restricted to
          // eligible captures and siteSlugs), applying the query's structural
          // and text predicates per region. Only parameters the SQL actually
          // uses are bound; no structural predicate means no profile/cutoff.
          const params: Record<string, string | number> = { state: plan.input.state };
          const conditions = structuralPredicates.map((predicate, index) => {
            params.profileKey = `live-${plan.input.viewport}`;
            params.cutoff = plan.cutoff;
            const placeholders = bindValues(params, `sf${index}v`, predicate.values);
            return `EXISTS (
              SELECT 1 FROM atlas_region_features f INDEXED BY atlas_region_features_region_idx
              WHERE f.region_id = r.id
                AND f.field = '${predicate.field}'
                AND f.value IN ${placeholders}
                AND f.profile_key = :profileKey AND f.fresh >= :cutoff
            )`;
          });
          if (ftsRegions) {
            conditions.push(
              `r.id IN (SELECT region_id FROM temp.${ftsRegions})`,
            );
          }
          return db
            .prepare(
              `SELECT cl.value AS value, COUNT(DISTINCT cl.region_id) AS count
               FROM temp.atlas_search_state_regions sr
               CROSS JOIN atlas_claims cl INDEXED BY atlas_claims_region_state_idx
                 ON cl.region_id = sr.region_id
               JOIN atlas_regions r INDEXED BY atlas_regions_lookup_idx ON r.id = cl.region_id
               WHERE cl.state = :state
                 AND cl.field = 'section.purpose'
                 AND r.kind = 'section'
                 AND ${claimEligibilitySql("cl", plan.input.evidenceMode)}
                 ${conditions.map((condition) => `AND ${condition}`).join("\n                 ")}
               GROUP BY cl.value`,
            )
            .all(params) as unknown as FacetCount[];
        }
        if (field === "section.purpose") {
          if (structuralPredicates.length > 0) {
            // Purpose rows carry their region's tag/role/landmark, so a
            // structural combination is one covering-index scan of the purpose
            // table instead of a materialized hit set plus region joins.
            const params: Record<string, string | number> = {
              profileKey: `live-${plan.input.viewport}`,
              cutoff: plan.cutoff,
            };
            const clauses = structuralPredicates.map((predicate, index) => {
              const column = structuralName(predicate.field)!;
              const placeholders = bindValues(params, `pf${index}v`, predicate.values);
              return `rp.${column} IN ${placeholders}`;
            });
            const ftsClause = ftsAnchors
              ? `AND rp.region_id IN (SELECT region_id FROM temp.${ftsAnchors})`
              : "";
            return db
              .prepare(
                `SELECT rp.value AS value, COUNT(*) AS count
                 FROM atlas_region_purposes rp INDEXED BY atlas_region_purposes_facet_idx
                 WHERE rp.${tierColumn} IS NOT NULL
                   AND rp.profile_key = :profileKey
                   AND rp.fresh >= :cutoff
                   ${regionEligibilitySql("rp")}
                   AND ${clauses.join(" AND ")}
                   ${ftsClause}
                 GROUP BY rp.value`,
              )
              .all(params) as unknown as FacetCount[];
          }
          const params: Record<string, string | number> = {
            profileKey: `live-${plan.input.viewport}`,
            cutoff: plan.cutoff,
          };
          const conditions = [
            "rp.profile_key = :profileKey",
            "rp.fresh >= :cutoff",
            regionEligibilityCondition("rp"),
          ].filter(Boolean);
          if (ftsAnchors) {
            conditions.push(
              `rp.region_id IN (SELECT region_id FROM temp.${ftsAnchors})`,
            );
          }
          return db
            .prepare(
              `SELECT rp.value AS value, COUNT(*) AS count
               FROM atlas_region_purposes rp
               WHERE rp.${tierColumn} IS NOT NULL
                 AND ${conditions.join(" AND ")}
               GROUP BY rp.value`,
            )
            .all(params) as unknown as FacetCount[];
        }
        const hits = buildRegionHits("atlas_search_facet_hits", field);
        const expression = structuralSql(field, "r")!;
        const rows = hits
          ? (db
              .prepare(
                `SELECT ${expression} AS value, COUNT(*) AS count
                 FROM temp.${hits} h
                 CROSS JOIN atlas_regions r INDEXED BY atlas_regions_features_idx ON r.id = h.region_id
                 WHERE ${expression} IS NOT NULL
                 GROUP BY ${expression}`,
              )
              .all() as unknown as FacetCount[])
          : allRegionsEligible()
            ? (db
                .prepare(
                  `SELECT ${expression} AS value, COUNT(*) AS count
                   FROM atlas_regions r INDEXED BY atlas_regions_features_idx
                   WHERE r.kind = 'section' AND ${expression} IS NOT NULL ${stateRegion("r.id")}
                   GROUP BY ${expression}`,
                )
                .all() as unknown as FacetCount[])
            : (db
                .prepare(
                  `SELECT ${expression} AS value, COUNT(*) AS count
                   FROM temp.atlas_search_capture_meta cm
                   CROSS JOIN atlas_regions r ON r.capture_id = cm.capture_id
                   WHERE r.kind = 'section' AND ${expression} IS NOT NULL ${stateRegion("r.id")}
                   GROUP BY ${expression}`,
                )
                .all() as unknown as FacetCount[]);
        if (field === "region.tag") {
          // Legacy rows without locator.tag derive it from the selector. The
          // fallback must apply to the same hit set even when the query has
          // no other predicate or FTS term.
          const fallbackSql = `SELECT ${tagFallbackSql("r")} AS value, COUNT(*) AS count
             FROM {FROM}
             WHERE r.kind = 'section' AND ${expression} IS NULL
             GROUP BY value`;
          const fallback = hits
            ? (db
                .prepare(
                  fallbackSql.replace(
                    "{FROM}",
                    `temp.${hits} h CROSS JOIN atlas_regions r ON r.id = h.region_id`,
                  ),
                )
                .all() as unknown as FacetCount[])
            : allRegionsEligible()
              ? (db
                  .prepare(
                    fallbackSql.replace(
                      "{FROM}",
                      "atlas_regions r INDEXED BY atlas_regions_features_idx",
                    ),
                  )
                  .all() as unknown as FacetCount[])
              : (db
                  .prepare(
                    fallbackSql.replace(
                      "{FROM}",
                      "temp.atlas_search_capture_meta cm CROSS JOIN atlas_regions r ON r.capture_id = cm.capture_id",
                    ),
                  ).all() as unknown as FacetCount[]);
          return [...rows, ...fallback];
        }
        return rows;
      }

      const totalScopes = (
        db.prepare(`SELECT COUNT(*) AS n FROM temp.${scopeCountTable}`).get() as { n: number }
      ).n;
      const facetSets = scopeSets.filter((set) => set.field !== field);
      const facetMatches = intersectScopeSets(
        db,
        "atlas_search_facet_matches",
        facetSets,
        false,
      );
      const facetScopeCount = facetMatches
        ? (db.prepare(`SELECT COUNT(*) AS n FROM temp.${facetMatches}`).get() as { n: number }).n
        : totalScopes;
      const allScopes =
        facetMatches === null ||
        (totalScopes > 0 && facetScopeCount === totalScopes);
      // Capture-level totals from the persisted projections are exact only
      // when every section in the cache belongs to this eligible scope set.
      const allCaptures =
      !plan.hasQuery &&
      !(plan.input.siteSlugs !== null && plan.input.siteSlugs !== undefined && plan.input.siteSlugs.length > 0) &&
      allRegionsEligible() &&
      allScopes;
      // With every scope matching, the eligible capture set is exactly
      // capture_meta; otherwise restrict to the facet's scope matches.
      const captures = allScopes ? null : facetCaptures(facetMatches);

      /**
       * Text queries count at region level. A capture that matched the text in
       * one section must not contribute its other sections to a facet, so only
       * the text anchors are counted. Page/site predicates are already
       * satisfied at scope level by `facetSets`/`captures`; re-applying them to
       * the anchor would require the text match and the predicate witness to be
       * the same region, which page/site scope explicitly does not.
       */
      const queryFacetRegions = (): string => {
        const table = "atlas_search_query_regions";
        db.exec(`DROP TABLE IF EXISTS temp.${table}`);
        db.exec(`CREATE TEMP TABLE ${table} (
          region_id TEXT PRIMARY KEY
        ) WITHOUT ROWID`);
        const captureTable = allScopes ? "atlas_search_capture_meta" : captures!;
        db.prepare(
          `INSERT INTO temp.${table} (region_id)
           SELECT fa.region_id
           FROM temp.${ftsAnchors!} fa
           JOIN temp.${captureTable} qc ON qc.capture_id = fa.capture_id`,
        ).run();
        return table;
      };

      if (stateFilter) {
        // State evidence is a region sample, not a scope aggregate. Drive the
        // facet from the state region set so the scan is bounded by state
        // evidence, never by the whole eligible corpus.
        const stateBase = `temp.atlas_search_state_regions sr
          JOIN atlas_regions r INDEXED BY atlas_regions_features_idx ON r.id = sr.region_id`;
        const source = plan.hasQuery
          ? `${stateBase}
             JOIN temp.${queryFacetRegions()} qr ON qr.region_id = r.id`
          : allScopes
            ? stateBase
            : `${stateBase}
               JOIN temp.${captures!} fc ON fc.capture_id = r.capture_id`;
        if (field === "region.kind") {
          return [
            {
              value: "section",
              count: (
                db
                  .prepare(
                    `SELECT COUNT(*) AS total FROM ${source}
                     WHERE r.kind = 'section'`,
                  )
                  .get() as { total: number }
              ).total,
            },
          ];
        }
        if (field === "section.purpose") {
          return db
            .prepare(
              `SELECT cl.value AS value, COUNT(DISTINCT r.id) AS count
               FROM ${source}
               JOIN atlas_claims cl INDEXED BY atlas_claims_region_idx ON cl.region_id = r.id
               WHERE r.kind = 'section'
                 AND cl.field = 'section.purpose'
                 AND ${claimEligibilitySql("cl", plan.input.evidenceMode)}
                 AND ${claimStateSql("cl", plan.input.state)}
               GROUP BY cl.value`,
            )
            .all() as unknown as FacetCount[];
        }
        const expression = structuralSql(field, "r")!;
        return db
          .prepare(
            `SELECT ${expression} AS value, COUNT(DISTINCT r.id) AS count
             FROM ${source}
             WHERE r.kind = 'section'
               AND ${expression} IS NOT NULL
             GROUP BY ${expression}`,
          )
          .all() as unknown as FacetCount[];
      }

      if (field === "region.kind") {
        if (plan.hasQuery) {
          return [
            { value: "section", count: (db.prepare(`SELECT COUNT(*) AS total FROM temp.${queryFacetRegions()}`).get() as { total: number }).total },
          ];
        }
        const count = allScopes
          ? (
              db
                .prepare(
                  `SELECT COALESCE(SUM(regions), 0) AS total FROM temp.${scopeCountTable}`,
                )
                .get() as { total: number }
            ).total
          : (
              db
                .prepare(
                  `SELECT COALESCE(SUM(cc.regions), 0) AS total
                   FROM temp.${eligibleCountTable} cc
                   JOIN temp.${captures!} fc ON fc.capture_id = cc.capture_id`,
                )
                .get() as { total: number }
            ).total;
        return [{ value: "section", count }];
      }
      const scopeTierColumn =
        field === "section.purpose"
          ? evidenceTierColumn(plan.input.evidenceMode)
          : "structural_tier";

      if (plan.hasQuery) {
        const regionTable = queryFacetRegions();
        const params: Record<string, string | number> = {
          profileKey: `live-${plan.input.viewport}`,
          cutoff: plan.cutoff,
        };
        if (field === "section.purpose") {
          return db
            .prepare(
              `SELECT rp.value AS value, COUNT(*) AS count
               FROM temp.${regionTable} qr
               JOIN atlas_region_purposes rp ON rp.region_id = qr.region_id
               WHERE rp.${tierColumn} IS NOT NULL
                 AND rp.profile_key = :profileKey AND rp.fresh >= :cutoff
               GROUP BY rp.value`,
            )
            .all(params) as unknown as FacetCount[];
        }
        return db
          .prepare(
            `SELECT rf.value AS value, COUNT(*) AS count
             FROM temp.${regionTable} qr
             JOIN atlas_region_features rf ON rf.region_id = qr.region_id
             WHERE rf.field = :field
               AND rf.profile_key = :profileKey AND rf.fresh >= :cutoff
             GROUP BY rf.value`,
          )
          .all({ ...params, field }) as unknown as FacetCount[];
      }

      if (allCaptures && field !== "section.purpose") {
        return db
          .prepare(
            `SELECT value, regions AS count
             FROM atlas_feature_totals
             WHERE field = ? AND value <> ''`,
          )
          .all(field) as unknown as FacetCount[];
      }
      if (field === "section.purpose") {
        // Purpose counts are exact region instances per capture. When every
        // eligible scope matches and no site filter narrows the corpus, the
        // region projection answers them with one covering-index scan; the
        // profile+freshness filter is exactly the eligible capture set.
        // Otherwise drive from the eligible capture rows and their exact
        // per-capture region counts.
        const params: Record<string, string | number> = {
          profileKey: `live-${plan.input.viewport}`,
          cutoff: plan.cutoff,
        };
        if (allScopes && plan.input.siteSlugs === undefined) {
          return db
            .prepare(
              `SELECT rp.value AS value, COUNT(*) AS count
               FROM atlas_region_purposes rp
               WHERE rp.${scopeTierColumn} IS NOT NULL
                 AND rp.profile_key = :profileKey AND rp.fresh >= :cutoff
               GROUP BY rp.value`,
            )
            .all(params) as unknown as FacetCount[];
        }
        const capturesOrMeta = captures ?? "atlas_search_capture_meta";
        // Per-mode region counts: a capture can hold accepted and candidate
        // regions for the same purpose, and only the requested mode may count.
        const modeRegionsColumn =
          plan.input.evidenceMode === "accepted"
            ? "accepted_regions"
            : plan.input.evidenceMode === "observed_only"
              ? "observed_regions"
              : "candidate_regions";
        return db
          .prepare(
            `SELECT p.value AS value, SUM(p.${modeRegionsColumn}) AS count
             FROM temp.${capturesOrMeta} fc
             CROSS JOIN atlas_capture_purposes p
             WHERE p.capture_id = fc.capture_id AND p.${scopeTierColumn} IS NOT NULL
             GROUP BY p.value`,
          )
          .all() as unknown as FacetCount[];
      }
      const captureDriver = captures ?? "atlas_search_capture_meta";
      return db
        .prepare(
          `SELECT f.value AS value, SUM(f.regions) AS count
           FROM atlas_capture_features f
           JOIN temp.${captureDriver} fc ON fc.capture_id = f.capture_id
           WHERE f.field = '${field}' AND f.${scopeTierColumn} IS NOT NULL
           GROUP BY f.value`,
        )
        .all() as unknown as FacetCount[];
    };

    const facets = plan.input.facets.map((field) =>
      facetFor(plan, field, facetRowsFor(field)),
    );

    const anchorIds = pageRows.map((row) => row.region_id);
    const claimsByRegion = loadClaims(
      db,
      anchorIds,
      plan.input.evidenceMode,
      plan.input.state,
    );
    const screenshots = loadScreenshots(
      db,
      pageRows.map((row) => row.capture_id),
    );
    const artifacts = loadArtifacts(db, anchorIds);
    const budget: WitnessBudget = { remaining: MAX_TOTAL_WITNESS_IDS };
    const sampleKeys = new Map<string, string | null>();
    const hits = pageRows.map((row) =>
      toHit(
        db,
        plan,
        row,
        claimsByRegion.get(row.region_id) ?? [],
        screenshots,
        artifacts,
        sampleKeys,
        budget,
      ),
    );
    const nextTuple =
      hasMore && pageSelected.length > 0
        ? sortTupleFor(pageSelected[pageSelected.length - 1]! as unknown as AnchorRow, plan)
        : null;

    // Re-read under the same snapshot before returning: the revision used for
    // the response label and the projections that produced it must agree.
    const closing = db
      .prepare("SELECT revision, feature_revision FROM atlas_state WHERE singleton = 1")
      .get() as { revision: number; feature_revision: number } | undefined;
    if (!closing || closing.revision !== revision || closing.feature_revision !== revision) {
      db.exec("ROLLBACK");
      inTransaction = false;
      return errorResult("SEARCH_NOT_READY", NOT_READY_MESSAGE, true);
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
        corpus: { sites: corpusRow.sites, pages: corpusRow.pages, captures: corpusRow.captures },
        hasEligibleRegions: corpusRow.regions > 0,
        stateEvidence,
        predicatePresence,
      },
    });
  } catch (error) {
    if (inTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
    }
    // A concurrent publish may hold the write lock past the busy timeout.
    // Never surface a raw SQLITE_BUSY to callers.
    if (isSearchStorageError(error)) {
      return errorResult("SEARCH_NOT_READY", NOT_READY_MESSAGE, true);
    }
    throw error;
  }
}

/**
 * Snapshot adapter used only by tests and the deterministic benchmark path.
 * It seeds a private in-memory SQLite database and runs the same query core.
 */
export function snapshotAtlasSearchStore(snapshot: AtlasSearchSnapshot): AtlasSearchStore {
  return {
    query: (request) => {
      const db = new DatabaseSync(":memory:");
      try {
        migrateAtlas(db, request.asOf, false);
        seedSnapshotDatabase(db, snapshot, request.asOf);
        return queryAtlasDatabase(db, request, {
          ftsAvailable: snapshot.ftsAvailable,
          scores: snapshot.bm25,
        });
      } finally {
        db.close();
      }
    },
  };
}

function seedSnapshotDatabase(
  db: DatabaseSync,
  snapshot: AtlasSearchSnapshot,
  now: number,
): void {
  db.exec(`CREATE TABLE IF NOT EXISTS sites (
    slug TEXT PRIMARY KEY, id INTEGER, title TEXT, createdAt INTEGER,
    tags TEXT, thumbnailPath TEXT, liveUrl TEXT, detailPath TEXT,
    awards TEXT, studio TEXT, nominee INTEGER, fetchedAt INTEGER
  )`);
  db.exec("BEGIN IMMEDIATE");
  try {
    const siteInsert = db.prepare(
      `INSERT OR IGNORE INTO sites
         (slug, id, title, createdAt, tags, thumbnailPath, liveUrl, detailPath, awards, fetchedAt)
       VALUES (?, 1, ?, ?, '[]', '', ?, '', '[]', ?)`,
    );
    for (const site of snapshot.sites) {
      siteInsert.run(site.slug, site.title, now, site.liveUrl, now);
    }
    const pageInsert = db.prepare(
      `INSERT INTO atlas_pages (id, site_slug, kind, url_key, public_url, path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const page of snapshot.pages) {
      pageInsert.run(
        page.id,
        page.siteSlug,
        page.kind,
        `url:${page.id}`,
        page.publicUrl,
        page.path,
        now,
      );
    }
    const captureInsert = db.prepare(
      `INSERT INTO atlas_captures
         (id, attempt_id, page_id, source_kind, profile_key, config_hash, status,
          started_at, finished_at, observed_at, source_fetched_at, last_confirmed_at,
          source_digest, config_json, policy_json, coverage_json, error_json,
          extractor_version, classifier_version)
       VALUES (?, ?, ?, 'live_page', ?, ?, 'running', ?, NULL, ?, ?, ?, ?, '{}', '{}', ?, NULL, 'test', 'test')`,
    );
    const rootInsert = db.prepare(
      `INSERT INTO atlas_regions
         (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
          text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
       VALUES (?, ?, NULL, 'page', 0, NULL, NULL, '', '', NULL, NULL, '{}', NULL, ?)`,
    );
    const captureUpdate = db.prepare(
      "UPDATE atlas_captures SET status = ?, finished_at = ? WHERE id = ?",
    );
    for (const capture of snapshot.captures) {
      const captureCoverage = JSON.stringify(capture.coverage);
      captureInsert.run(
        capture.id,
        `attempt:${capture.id}`,
        capture.pageId,
        capture.profileKey,
        `config:${capture.id}`,
        now - 1_000,
        capture.observedAt,
        capture.sourceFetchedAt,
        capture.lastConfirmedAt,
        `digest:${capture.id}`,
        captureCoverage,
      );
      rootInsert.run(`${capture.id}:root`, capture.id, captureCoverage);
      captureUpdate.run(capture.status, now, capture.id);
    }
    const regionInsert = db.prepare(
      `INSERT INTO atlas_regions
         (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
          text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const region of snapshot.regions) {
      regionInsert.run(
        region.id,
        region.captureId,
        `${region.captureId}:root`,
        region.kind,
        region.ordinal,
        JSON.stringify({ selector: region.selector, tag: region.tag }),
        region.fingerprint,
        region.heading,
        region.textExcerpt,
        region.rawTitle,
        region.primaryLabel,
        JSON.stringify({
          role: region.role,
          landmark: region.landmark,
          observations: (region.samples ?? []).map((sample) => ({
            state: sample.state,
            regions: [{ sampleKey: sample.sampleKey }],
          })),
        }),
        region.patternKey,
        JSON.stringify(region.coverage),
      );
    }
    const claimInsert = db.prepare(
      `INSERT INTO atlas_claims
         (id, region_id, field, value, sample_key, classification, basis, decision,
          state, rule_id, rule_version, evidence_json, limitations_json, review_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', '[]', NULL)`,
    );
    for (const claim of snapshot.claims) {
      claimInsert.run(
        claim.id,
        claim.regionId,
        claim.field,
        claim.value,
        claim.sampleKey,
        claim.classification,
        claim.basis,
        claim.decision,
        claim.state ?? "default",
        claim.ruleId,
      );
    }
    const headInsert = db.prepare(
      "INSERT INTO atlas_heads (page_id, profile_key, capture_id, published_at) VALUES (?, ?, ?, ?)",
    );
    for (const capture of snapshot.captures) {
      if (!capture.active) continue;
      headInsert.run(capture.pageId, capture.profileKey, capture.id, now);
    }
    const artifactInsert = db.prepare(
      `INSERT INTO atlas_artifacts
         (id, capture_id, region_id, kind, storage_path, external_url, sha256, bytes,
          mime_type, state, rights_json, metadata_json)
       VALUES (?, ?, NULL, 'screenshot', ?, NULL, ?, ?, 'image/png', 'ready', '{}', ?)`,
    );
    for (const [captureId, keys] of Object.entries(snapshot.screenshots)) {
      keys.forEach((key, index) => {
        artifactInsert.run(
          `shot:${captureId}:${index}:${key}`,
          captureId,
          `test://${captureId}/${key}`,
          `sha:${key}`,
          1,
          JSON.stringify({ key }),
        );
      });
    }
    const regionArtifactInsert = db.prepare(
      `INSERT INTO atlas_artifacts
         (id, capture_id, region_id, kind, storage_path, external_url, sha256, bytes,
          mime_type, state, rights_json, metadata_json)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'ready', '{}', '{}')`,
    );
    for (const artifact of snapshot.artifacts ?? []) {
      regionArtifactInsert.run(
        artifact.id,
        artifact.captureId,
        artifact.regionId,
        artifact.kind,
        artifact.storagePath,
        artifact.sha256,
        artifact.bytes,
        artifact.mimeType,
      );
    }
    db.prepare("UPDATE atlas_state SET revision = ? WHERE singleton = 1").run(snapshot.revision);
    // Mirrors publish: projections committed with the revision they describe.
    rebuildAtlasSearchProjections(db, snapshot.revision);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw error;
  }
}

/**
 * SQL-backed store used by production search. Opens one cache connection per
 * query and never materializes the corpus in JavaScript.
 */
export function atlasSearchStore(cache: Cache): AtlasSearchStore {
  return {
    query: (request) => {
      try {
        // Read-only open: no schema work, so a publisher holding the write
        // lock cannot delay the reader past the WAL snapshot.
        return cache.withAtlasReadDb((db) => queryAtlasDatabase(db, request));
      } catch (error) {
        if (isSearchStorageError(error)) {
          return errorResult("SEARCH_NOT_READY", NOT_READY_MESSAGE, true);
        }
        throw error;
      }
    },
  };
}

function responseBytes(data: SearchAtlasData): number {
  return Buffer.byteLength(JSON.stringify(data), "utf8");
}

// Reserve the `{"ok":true,"data":...}` envelope so the complete returned
// result stays inside MAX_SEARCH_RESPONSE_BYTES, not only the data payload.
const DATA_RESPONSE_BUDGET = MAX_SEARCH_RESPONSE_BYTES - 64;
export const ATLAS_DATA_RESPONSE_BUDGET = DATA_RESPONSE_BUDGET;

/**
 * Deterministic response-wide budget. Optional evidence is shed in a fixed
 * order (witnesses, screenshots/artifacts, claims/scalars), so the same corpus
 * row always yields the same trimmed response and `responseTruncated` tells
 * the caller the payload is a subset.
 */
function enforceResponseBudget(data: SearchAtlasData): SearchAtlasData {
  if (responseBytes(data) <= DATA_RESPONSE_BUDGET) return data;
  let current: SearchAtlasData = { ...data, responseTruncated: true };
  const fits = (): boolean => responseBytes(current) <= DATA_RESPONSE_BUDGET;

  current = {
    ...current,
    results: current.results.map((hit) => ({
      ...hit,
      explanations: hit.explanations.map((explanation) => ({
        ...explanation,
        supportingRegionIds: [],
        sampleKeys: [],
        truncated:
          explanation.truncated ||
          explanation.supportingRegionIds.length > 0 ||
          explanation.sampleKeys.length > 0,
      })),
      explanationsTruncated:
        hit.explanationsTruncated ||
        hit.explanations.some(
          (explanation) =>
            explanation.supportingRegionIds.length > 0 || explanation.sampleKeys.length > 0,
        ),
    })),
  };
  if (fits()) return current;

  current = {
    ...current,
    results: current.results.map((hit) => ({
      ...hit,
      artifacts: [],
      screenshotKeys: [],
      screenshotsTruncated: hit.screenshotsTruncated || hit.screenshotKeys.length > 0,
    })),
  };
  if (fits()) return current;

  current = {
    ...current,
    results: current.results.map((hit) => ({
      ...hit,
      claims: [],
      matchedSampleKey: null,
      coverage: { ...hit.coverage, limitations: [] },
      ...(hit.observationSpan ? { observationSpan: undefined } : {}),
    })),
  };
  if (fits()) return current;

  current = {
    ...current,
    results: current.results.map((hit) => ({
      ...hit,
      siteSlug: clipText(hit.siteSlug, 64),
      siteTitle: clipText(hit.siteTitle, 64),
      sitePublicUrl: clipNullable(hit.sitePublicUrl, 256),
      sourceUrl: clipNullable(hit.sourceUrl, 256),
      pageUrl: clipNullable(hit.pageUrl, 256),
      pagePath: clipNullable(hit.pagePath, 128),
      primaryLabel: clipNullable(hit.primaryLabel, 64),
    })),
  };
  if (fits()) return current;

  // Pathological identifiers: keep the response bounded and stop paginating
  // from a tuple that no longer describes the last returned hit.
  while (current.results.length > 0 && !fits()) {
    current = { ...current, results: current.results.slice(0, -1), nextCursor: null };
  }
  return current;
}

/** Search entry point. Cursor structure is validated before any store access. */
export function searchAtlas(
  input: SearchAtlasInput,
  store: AtlasSearchStore,
  now: number,
): AtlasSearchResult<SearchAtlasData> {
  const compiled = compilePredicates(input);
  if (!compiled.ok) return compiled;
  const search = compiled.input;
  const hasQuery = compiled.tokens.length > 0;
  const expectedTupleLength = search.sort === "newest" && !hasQuery ? 3 : 4;

  let decoded: AtlasCursorPayload | null = null;
  if (compiled.cursor) {
    const structural = decodeCursorStructure(compiled.cursor, now, expectedTupleLength);
    if (!structural.ok) return structural;
    decoded = structural.cursor;
  }

  const asOf = decoded?.asOf ?? now;
  const result = store.query({
    input: search,
    asOf,
    tokens: compiled.tokens,
    ftsQuery: compiled.ftsQuery,
    afterTuple: decoded?.lastSortTuple ?? null,
  });
  if (!result.ok) return result;

  if (decoded) {
    const context = validateCursorContext(
      decoded,
      { queryHash: compiled.queryHash },
      result.data.revision,
    );
    if (context) return { ok: false, error: context };
  }

  const predicatesPresent = search.predicates.every(
    (predicate) => result.data.predicatePresence[predicate.field] === true,
  );
  const outcome: SearchAtlasData["outcome"] = !result.data.hasEligibleRegions
    ? "empty_corpus"
    : search.state !== "default" && (result.data.stateEvidence ?? 0) === 0
      ? "insufficient_coverage"
      : result.data.total > 0
        ? "matches"
        : predicatesPresent
          ? "no_observed_match"
          : "insufficient_coverage";

  const boundedHits = result.data.hits.filter(
    (hit) =>
      hit.regionId.length <= MAX_ID_LENGTH &&
      hit.captureId.length <= MAX_ID_LENGTH &&
      hit.pageId.length <= MAX_ID_LENGTH,
  );
  const idsDropped = boundedHits.length !== result.data.hits.length;
  const nextCursor =
    !idsDropped && result.data.hasMore && result.data.nextTuple
      ? encodeCursor({
          version: 1,
          revision: result.data.revision,
          queryHash: compiled.queryHash,
          asOf,
          expiresAt: asOf + CURSOR_TTL_MS,
          lastSortTuple: result.data.nextTuple,
        })
      : null;

  const data: SearchAtlasData = {
    outcome,
    revision: result.data.revision,
    asOf,
    interpreted: search,
    results: boundedHits,
    total: result.data.total,
    countUnit:
      search.kind === "components" && search.groupBy === "pattern"
        ? "component_pattern"
        : "region_instance",
    nextCursor,
    facets: result.data.facets,
    corpus: {
      sites: result.data.corpus.sites,
      pages: result.data.corpus.pages,
      captures: result.data.corpus.captures,
      note: "locally cached subset",
      catalogueTotal: null,
    },
    candidateOnly: search.evidenceMode === "candidate",
    candidateNote:
      search.evidenceMode === "candidate"
        ? "Candidate labels are hints, not accepted evidence."
        : null,
    responseTruncated: idsDropped,
  };
  return { ok: true, data: enforceResponseBudget(data) };
}

// ---------------------------------------------------------------------------
// Legacy snapshot loader (tests and compatibility only)
// ---------------------------------------------------------------------------

function parseViewport(profileKey: string): AtlasSearchViewport | null {
  if (profileKey === "live-desktop") return "desktop";
  if (profileKey === "live-mobile") return "mobile";
  return null;
}

interface RegionRow {
  id: string;
  capture_id: string;
  parent_id: string | null;
  ordinal: number;
  locator_json: string | null;
  samples_json: string;
  pattern_key: string | null;
  primary_label: string | null;
  heading: string;
  raw_title: string | null;
  text_excerpt: string;
  fingerprint: string | null;
  coverage_json: string;
  page_id: string;
  profile_key: string;
  status: string;
  observed_at: number | null;
  last_confirmed_at: number | null;
  source_fetched_at: number | null;
  capture_coverage: string;
  site_slug: string;
  page_kind: string;
  public_url: string | null;
  path: string | null;
  site_title: string | null;
  site_live_url: string | null;
}

/**
 * Loads the locally cached active-head corpus in one cache open. Kept for
 * loader compatibility tests; search itself uses `atlasSearchStore`.
 */
export function loadAtlasSearchSnapshot(
  cache: Cache,
  filters: AtlasSnapshotFilters,
): AtlasSearchSnapshot {
  return cache.withAtlasDb((db) => {
    db.exec("BEGIN");
    try {
      const state = db
        .prepare("SELECT revision, fts_version FROM atlas_state WHERE singleton = 1")
        .get() as { revision: number; fts_version: number } | undefined;
      const ftsTable = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'atlas_regions_fts'",
        )
        .get();
      let ftsAvailable = Boolean(ftsTable) && (state?.fts_version ?? 0) > 0;

      const profileKey = `live-${filters.viewport}`;
      const cutoff = filters.asOf - filters.maxAgeDays * DAY_MS;
      const siteSlugs = filters.siteSlugs ?? [];
      const siteClause =
        siteSlugs.length > 0
          ? `AND p.site_slug IN (${siteSlugs.map(() => "?").join(",")})`
          : "";
      const regionFilter = `
        FROM atlas_heads h
        JOIN atlas_captures c
          ON c.id = h.capture_id AND c.page_id = h.page_id AND c.profile_key = h.profile_key
        JOIN atlas_pages p ON p.id = c.page_id
        JOIN atlas_regions r ON r.capture_id = c.id
        LEFT JOIN sites s ON s.slug = p.site_slug
        WHERE r.kind = 'section'
          AND c.source_kind = 'live_page'
          AND c.status IN ('complete','partial')
          AND c.profile_key = ?
          AND COALESCE(c.last_confirmed_at, c.observed_at) IS NOT NULL
          AND COALESCE(c.last_confirmed_at, c.observed_at) >= ?
          ${siteClause}
      `;
      const params = [profileKey, cutoff, ...siteSlugs];
      const rows = db
        .prepare(
          `SELECT r.id, r.capture_id, r.parent_id, r.kind, r.ordinal, r.locator_json,
                  r.samples_json, r.pattern_key, r.primary_label, r.heading, r.raw_title,
                  r.text_excerpt, r.fingerprint, r.coverage_json,
                  c.page_id, c.profile_key, c.status, c.observed_at, c.last_confirmed_at,
                  c.source_fetched_at, c.coverage_json AS capture_coverage,
                  p.site_slug, p.kind AS page_kind, p.public_url, p.path,
                  s.title AS site_title, s.liveUrl AS site_live_url
           ${regionFilter}
           ORDER BY r.capture_id, r.ordinal, r.id`,
        )
        .all(...params) as unknown as RegionRow[];

      const sites = new Map<string, AtlasSearchSite>();
      const pages = new Map<string, AtlasSearchPage>();
      const captures = new Map<string, AtlasSearchCapture>();
      const regions: AtlasSearchRegion[] = [];
      for (const row of rows) {
        sites.set(row.site_slug, {
          slug: row.site_slug,
          title: row.site_title ?? null,
          liveUrl: row.site_live_url ?? null,
        });
        pages.set(row.page_id, {
          id: row.page_id,
          siteSlug: row.site_slug,
          kind: row.page_kind,
          publicUrl: row.public_url ?? null,
          path: row.path ?? null,
        });
        if (!captures.has(row.capture_id)) {
          captures.set(row.capture_id, {
            id: row.capture_id,
            pageId: row.page_id,
            profileKey: row.profile_key,
            viewport: parseViewport(row.profile_key),
            status: row.status,
            active: true,
            observedAt: row.observed_at ?? null,
            lastConfirmedAt: row.last_confirmed_at ?? null,
            sourceFetchedAt: row.source_fetched_at ?? null,
            coverage: parseCoverage(row.capture_coverage),
          });
        }
        const locator = parseObject(row.locator_json);
        const samples = parseObject(row.samples_json);
        const selector = typeof locator?.selector === "string" ? locator.selector : null;
        const role = typeof samples?.role === "string" ? samples.role.toLowerCase() : null;
        const landmark = canonicalLandmark(
          typeof samples?.landmark === "string" ? samples.landmark : null,
        );
        const stateSamples: NonNullable<AtlasSearchRegion["samples"]> = [];
        if (Array.isArray(samples?.observations)) {
          for (const observation of samples.observations) {
            if (!observation || typeof observation !== "object") continue;
            const observationObject = observation as Record<string, unknown>;
            const state = observationObject.state;
            if (state !== "default" && state !== "hover" && state !== "focus") continue;
            if (!Array.isArray(observationObject.regions)) continue;
            for (const sample of observationObject.regions) {
              if (!sample || typeof sample !== "object") continue;
              const sampleKey = (sample as Record<string, unknown>).sampleKey;
              if (typeof sampleKey !== "string") continue;
              stateSamples.push({ sampleKey, state });
            }
          }
        }
        regions.push({
          id: row.id,
          captureId: row.capture_id,
          parentId: row.parent_id ?? null,
          kind: "section",
          ordinal: row.ordinal,
          tag: deriveRegionTag(locator?.tag, selector),
          role,
          landmark,
          selector,
          patternKey: row.pattern_key ?? null,
          primaryLabel: row.primary_label ?? null,
          heading: row.heading ?? "",
          rawTitle: row.raw_title ?? null,
          textExcerpt: row.text_excerpt ?? "",
          fingerprint: row.fingerprint ?? null,
          coverage: parseCoverage(row.coverage_json),
          samples: stateSamples,
        });
      }

      const rawClaims = db
        .prepare(
          `SELECT cl.id, cl.region_id, cl.field, cl.value, cl.sample_key, cl.state,
                  cl.classification, cl.basis, cl.decision, cl.rule_id
           FROM atlas_claims cl
           JOIN atlas_regions r ON r.id = cl.region_id
           JOIN atlas_captures c ON c.id = r.capture_id
           JOIN atlas_pages p ON p.id = c.page_id
           JOIN atlas_heads h
             ON h.capture_id = c.id AND h.page_id = c.page_id AND h.profile_key = c.profile_key
           WHERE r.kind = 'section'
             AND c.source_kind = 'live_page'
             AND c.status IN ('complete','partial')
             AND c.profile_key = ?
             AND COALESCE(c.last_confirmed_at, c.observed_at) IS NOT NULL
             AND COALESCE(c.last_confirmed_at, c.observed_at) >= ?
             ${siteClause}
           ORDER BY cl.region_id, cl.field, cl.value, cl.sample_key`,
        )
        .all(...params) as Array<{
        id: string;
        region_id: string;
        field: string;
        value: string;
        sample_key: string;
        state: string;
        classification: AtlasSearchClaim["classification"];
        basis: AtlasSearchClaim["basis"];
        decision: AtlasSearchClaim["decision"];
        rule_id: string | null;
      }>;
      const claimRows: AtlasSearchClaim[] = rawClaims.map((claim) => ({
        id: claim.id,
        regionId: claim.region_id,
        field: claim.field,
        value: claim.value,
        sampleKey: claim.sample_key,
        state: claim.state as AtlasSearchClaim["state"],
        classification: claim.classification,
        basis: claim.basis,
        decision: claim.decision,
        ruleId: claim.rule_id,
      }));

      const screenshotRows = db
        .prepare(
          `SELECT a.capture_id, json_extract(a.metadata_json, '$.key') AS key
           FROM atlas_artifacts a
           WHERE a.kind = 'screenshot' AND a.state = 'ready'
             AND a.capture_id IN (
               SELECT c.id
               FROM atlas_heads h
               JOIN atlas_captures c
                 ON c.id = h.capture_id AND c.page_id = h.page_id AND c.profile_key = h.profile_key
               JOIN atlas_pages p ON p.id = c.page_id
               JOIN atlas_regions r ON r.capture_id = c.id
               WHERE r.kind = 'section'
                 AND c.source_kind = 'live_page'
                 AND c.status IN ('complete','partial')
                 AND c.profile_key = ?
                 AND COALESCE(c.last_confirmed_at, c.observed_at) IS NOT NULL
                 AND COALESCE(c.last_confirmed_at, c.observed_at) >= ?
                 ${siteClause}
             )
           ORDER BY a.capture_id, key`,
        )
        .all(...params) as Array<{ capture_id: string; key: string | null }>;
      const screenshots: Record<string, string[]> = {};
      for (const row of screenshotRows) {
        if (!row.key) continue;
        const list = screenshots[row.capture_id] ?? [];
        if (!list.includes(row.key)) list.push(row.key);
        screenshots[row.capture_id] = list;
      }

      const bm25: Record<string, number> = {};
      const tokens = filters.query ? tokenizeQuery(filters.query) : [];
      if (tokens.length > 0 && ftsAvailable) {
        const ftsQuery = toFtsQuery(tokens);
        if (ftsQuery) {
          try {
            const scores = db
              .prepare(
                `SELECT region_id,
                        bm25(atlas_regions_fts, 0.0, 5.0, 4.0, 1.0, 5.0, 1.0) AS score
                 FROM atlas_regions_fts
                 WHERE atlas_regions_fts MATCH ?`,
              )
              .all(ftsQuery) as Array<{ region_id: string; score: number }>;
            for (const score of scores) {
              if (Number.isFinite(score.score)) bm25[score.region_id] = score.score;
            }
          } catch {
            ftsAvailable = false;
          }
        }
      }

      db.exec("COMMIT");
      return {
        revision: state?.revision ?? 0,
        asOf: filters.asOf,
        ftsAvailable,
        sites: [...sites.values()],
        pages: [...pages.values()],
        captures: [...captures.values()],
        regions,
        claims: claimRows,
        bm25,
        screenshots,
      };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw error;
    }
  });
}
