import { mkdtempSync, rmSync, statSync } from "node:fs";
import { cpus } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { stableHash } from "./identity.js";
import { migrateAtlas } from "./schema.js";
import { compilePredicates, queryAtlasDatabase } from "./search.js";
import { rebuildAtlasSearchProjections } from "./search-projections.js";
import type { AtlasPredicate, SearchAtlasInput, SearchField } from "./search-types.js";
import { SECTION_PURPOSES, isSearchableVocabulary } from "./vocabulary.js";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 10, 5, 12);
const TAGS = ["section", "div", "header", "footer", "main", "article"];
const ROLES = ["region", "main", "navigation", "banner", null];
const LANDMARKS = ["main", "header", "footer", "navigation", null];

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(samples: number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

interface SeedResult {
  /** Regions that pass the default viewport/status/freshness eligibility. */
  regions: number;
  ineligibleRegions: number;
  staleRegions: number;
  unknownRegions: number;
  claims: number;
  stateClaims: number;
  purposes: string[];
  captures: number;
  sites: number;
  publishRebuildMs: number;
}

function seedBenchmarkDatabase(
  db: DatabaseSync,
  regions: number,
  claimsPerRegion: number,
  now: number,
  random: () => number,
): SeedResult {
  const purposes = SECTION_PURPOSES.filter((value) =>
    isSearchableVocabulary("section.purpose", value),
  );
  const sectionsPerCapture = 10;
  const eligibleCaptures = Math.max(1, Math.ceil(regions / sectionsPerCapture));
  // Separate ineligible captures keep corpus-wide shortcuts honest: stale and
  // unknown/other-status captures must never answer an eligible-only query.
  const staleCaptures = Math.max(1, Math.ceil(eligibleCaptures / 10));
  const unknownCaptures = staleCaptures;
  const captures = eligibleCaptures + staleCaptures + unknownCaptures;
  const siteCount = Math.max(1, Math.ceil(captures / 10));
  // The publish rebuild is measured with the same WAL journal a real cache
  // uses; journal_mode = OFF understated it.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA cache_size = -32768");
  db.exec("PRAGMA temp_store = MEMORY");
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
       VALUES (?, ?, ?, ?, '[]', '', ?, '', '[]', ?)`,
    );
    for (let index = 0; index < siteCount; index += 1) {
      const slug = `bench-site-${index}`;
      siteInsert.run(slug, index, `Benchmark ${slug}`, now, `https://${slug}.example/`, now);
    }
    const pageInsert = db.prepare(
      `INSERT INTO atlas_pages (id, site_slug, kind, url_key, public_url, path, created_at)
       VALUES (?, ?, 'live_page', ?, ?, '/', ?)`,
    );
    const captureInsert = db.prepare(
      `INSERT INTO atlas_captures
         (id, attempt_id, page_id, source_kind, profile_key, config_hash, status,
          started_at, finished_at, observed_at, source_fetched_at, last_confirmed_at,
          source_digest, config_json, policy_json, coverage_json, error_json,
          extractor_version, classifier_version)
       VALUES (?, ?, ?, 'live_page', 'live-desktop', ?, 'running', ?, NULL, ?, NULL, ?, ?, '{}', '{}', ?, NULL, 'bench', 'bench')`,
    );
    const captureUpdate = db.prepare(
      "UPDATE atlas_captures SET status = ?, finished_at = ? WHERE id = ?",
    );
    const rootInsert = db.prepare(
      `INSERT INTO atlas_regions
         (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
          text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
       VALUES (?, ?, NULL, 'page', 0, NULL, NULL, '', '', NULL, NULL, '{}', NULL, ?)`,
    );
    const regionInsert = db.prepare(
      `INSERT INTO atlas_regions
         (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
          text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
       VALUES (?, ?, ?, 'section', ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?)`,
    );
    const claimInsert = db.prepare(
      `INSERT INTO atlas_claims
         (id, region_id, field, value, sample_key, classification, basis, decision,
          state, rule_id, rule_version, evidence_json, limitations_json, review_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '[]', '[]', NULL)`,
    );
    const headInsert = db.prepare(
      "INSERT INTO atlas_heads (page_id, profile_key, capture_id, published_at) VALUES (?, 'live-desktop', ?, ?)",
    );
    const coverageFor = (status: "complete" | "partial") =>
      JSON.stringify({
        status,
        collected: sectionsPerCapture,
        excluded: status === "partial" ? 2 : 0,
        limitations: status === "partial" ? ["PARTIAL_VIEWPORT"] : [],
      });
    const fullCoverage = coverageFor("complete");

    let captureIndex = 0;
    let regionIndex = 0;
    let claimCount = 0;
    let stateClaimCount = 0;
    let eligiblePlaced = 0;
    let stalePlaced = 0;
    let unknownPlaced = 0;

    const emitCapture = (
      status: "complete" | "partial" | "unknown",
      observedAt: number,
      sections: number,
    ): void => {
      const pageId = `bench-page-${captureIndex}`;
      const captureId = `bench-capture-${captureIndex}`;
      const siteSlug = `bench-site-${Math.floor(captureIndex / 10) % siteCount}`;
      const coverage = status === "unknown" ? fullCoverage : coverageFor(status);
      const tags = TAGS.filter((_, index) => (captureIndex + index) % 2 === 0);
      const roles = ROLES.filter((role, index) => role !== null && (captureIndex + index) % 2 === 0);
      const landmarks = LANDMARKS.filter(
        (landmark, index) => landmark !== null && (captureIndex + index) % 2 === 0,
      );
      pageInsert.run(
        pageId,
        siteSlug,
        `url:${pageId}`,
        `https://www.awwwards.com/sites/${siteSlug}`,
        now,
      );
      captureInsert.run(
        captureId,
        `attempt:${captureId}`,
        pageId,
        `config:${captureId}`,
        now - 1_000,
        observedAt,
        observedAt,
        `digest:${captureId}`,
        coverage,
      );
      rootInsert.run(`${captureId}:root`, captureId, coverage);
      for (let ordinal = 1; ordinal <= sections; ordinal += 1) {
        const regionId = `bench-region-${regionIndex}`;
        const purpose = purposes[regionIndex % purposes.length]!;
        const tag = tags[regionIndex % tags.length]!;
        const role = roles[regionIndex % roles.length] ?? null;
        const landmark = landmarks[regionIndex % landmarks.length] ?? null;
        regionInsert.run(
          regionId,
          captureId,
          `${captureId}:root`,
          ordinal,
          JSON.stringify({ selector: `main > ${tag}.bench-${regionIndex}`, tag }),
          `Benchmark ${purpose} section ${regionIndex}`,
          `Synthetic benchmark copy for ${purpose} section ${regionIndex}`,
          `Benchmark ${purpose} section ${regionIndex}`,
          purpose,
          JSON.stringify({ role, landmark }),
          coverage,
        );
        for (let claimIndex = 0; claimIndex < claimsPerRegion; claimIndex += 1) {
          const field = claimIndex === 0 ? "section.purpose" : "section.note";
          const value = claimIndex === 0 ? purpose : `note-${claimIndex}`;
          claimInsert.run(
            `bench-claim-${claimCount}`,
            regionId,
            field,
            value,
            `desktop:${regionId}:${claimIndex}`,
            claimIndex === 0 && regionIndex % 10 === 0 ? "observed" : "inferred",
            claimIndex === 0 && regionIndex % 10 === 0 ? "native_semantics" : "rule_derivation",
            regionIndex % 10 < 6 ? "candidate" : "accepted",
            "default",
          );
          claimCount += 1;
        }
        // A realistic minority of regions carries hover evidence: one
        // interaction claim plus the purpose re-emitted under the state sample.
        if (regionIndex % 20 === 0) {
          const stateSample = `desktop:${regionId}:state-hover`;
          claimInsert.run(
            `bench-state-behavior-${regionIndex}`,
            regionId,
            "behavior",
            "hover_change_observed",
            stateSample,
            "observed",
            "interaction_observation",
            "accepted",
            "hover",
          );
          claimInsert.run(
            `bench-state-purpose-${regionIndex}`,
            regionId,
            "section.purpose",
            purpose,
            stateSample,
            "inferred",
            "rule_derivation",
            "accepted",
            "hover",
          );
          claimCount += 2;
          stateClaimCount += 2;
        }
        regionIndex += 1;
      }
      captureUpdate.run(status, now, captureId);
      headInsert.run(pageId, captureId, now);
      captureIndex += 1;
    };

    // Eligible captures: fresh (0-28 days), mixed complete/partial status and
    // per-capture structural subsets.
    for (let index = 0; index < eligibleCaptures; index += 1) {
      const remaining = regions - eligiblePlaced;
      const sections = Math.max(0, Math.min(sectionsPerCapture, remaining));
      const status = index % 7 === 0 ? "partial" : "complete";
      const observedAt = now - (index % 29) * DAY_MS - Math.floor(random() * 1_000);
      emitCapture(status, observedAt, sections);
      eligiblePlaced += sections;
    }
    // Separate stale captures: complete status, outside the 30-day window.
    for (let index = 0; index < staleCaptures; index += 1) {
      const observedAt = now - (31 + (index % 14)) * DAY_MS;
      emitCapture("complete", observedAt, sectionsPerCapture);
      stalePlaced += sectionsPerCapture;
    }
    // Separate unknown-status captures: recent timestamps but unpublishable.
    for (let index = 0; index < unknownCaptures; index += 1) {
      const observedAt = now - (index % 5) * DAY_MS;
      emitCapture("unknown", observedAt, sectionsPerCapture);
      unknownPlaced += sectionsPerCapture;
    }
    db.prepare("UPDATE atlas_state SET revision = 1 WHERE singleton = 1").run();
    // Mirrors publish: pay the projection rebuild inside the write transaction
    // so the measured search workloads never rebuild.
    const rebuildStarted = performance.now();
    rebuildAtlasSearchProjections(db, 1);
    const publishRebuildMs = performance.now() - rebuildStarted;
    db.exec("COMMIT");
    return {
      regions: eligiblePlaced,
      ineligibleRegions: stalePlaced + unknownPlaced,
      staleRegions: stalePlaced,
      unknownRegions: unknownPlaced,
      claims: claimCount,
      stateClaims: stateClaimCount,
      purposes,
      captures,
      sites: siteCount,
      publishRebuildMs,
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw error;
  }
}

export interface AtlasSearchBenchOptions {
  regions?: number;
  claimsPerRegion?: number;
  runs?: number;
  seed?: number;
  now?: number;
}

export interface AtlasSearchBenchWorkload {
  name: string;
  scope: "region" | "page" | "site";
  facets: SearchField[];
  predicateCount: number;
  gateMs: number;
  p50Ms: number;
  p95Ms: number;
  /** First run of this workload after the measured warmups; cold only for the first workload. */
  firstRunMs: number;
  cold: boolean;
  samplesMs: number[];
  total: number;
}

export interface AtlasSearchBenchResult {
  schemaVersion: "atlas-search-bench-v3";
  /** Eligible regions: active desktop heads, complete/partial, within 30 days. */
  regions: number;
  /** Separate stale and unknown-status regions that no eligible query may see. */
  ineligibleRegions: number;
  staleRegions: number;
  unknownRegions: number;
  claims: number;
  stateClaims: number;
  claimsPerRegion: number;
  captures: number;
  sites: number;
  queries: number;
  runsPerQuery: number;
  measuredRuns: number;
  workloads: AtlasSearchBenchWorkload[];
  /** Cost publish pays inside its write transaction to rebuild the v8 projections. */
  publishRebuildMs: number;
  /** First run of the first workload, measured after the publish-style rebuild. */
  coldFirstRunMs: number;
  p50NoFacetsMs: number;
  p95NoFacetsMs: number;
  p50FourFacetsMs: number;
  p95FourFacetsMs: number;
  p50Ms: number;
  p95Ms: number;
  samplesNoFacetsMs: number[];
  samplesFourFacetsMs: number[];
  baselineRssBytes: number;
  maxRssBytes: number;
  additionalRssBytes: number;
  schemaBytes: number;
  snapshotBytes: number;
  databaseBytes: number;
  totalResults: number;
  deterministicDigest: string;
  statePaging: { pages: number; regions: number };
  now: number;
  environment: {
    cpu: string | null;
    nodeVersion: string;
    sqliteVersion: string;
    warmState: "warm";
    runsPerQuery: number;
  };
}

const FOUR_FACETS: SearchField[] = [
  "region.tag",
  "region.role",
  "region.landmark",
  "section.purpose",
];

/**
 * Eight predicates across the four searchable dimensions. The purpose and
 * structural value sets are spread so every synthetic page contains a match,
 * keeping page/site workloads at the full 100k-anchor worst case.
 */
function benchmarkPredicates(purposes: string[]): AtlasPredicate[] {
  const pick = (values: string[], indexes: number[]): string[] =>
    indexes.map((index) => values[index]!).filter((value): value is string => Boolean(value));
  const tags = ["article", "div", "footer", "header", "main", "section"];
  const roles = ["banner", "main", "navigation", "region"];
  const landmarks = ["footer", "header", "main", "navigation"];
  return [
    { field: "section.purpose", values: pick(purposes, [0, 3, 6, 7, 10, 14, 17, 20]) },
    { field: "section.purpose", values: pick(purposes, [0, 7, 14, 20]) },
    { field: "region.tag", values: tags.slice(0, 5) },
    { field: "region.tag", values: tags.slice(0, 4) },
    { field: "region.role", values: roles },
    { field: "region.role", values: roles.slice(0, 3) },
    { field: "region.landmark", values: landmarks },
    { field: "region.landmark", values: landmarks.slice(0, 3) },
  ];
}

/**
 * State evidence is a 5% subset, so the state workload keeps the purpose
 * predicate and structural sets that subset actually carries. It still
 * exercises predicate filtering, facets and state eligibility.
 */
function benchmarkStatePredicates(purposes: string[]): AtlasPredicate[] {
  const pick = (values: string[], indexes: number[]): string[] =>
    indexes.map((index) => values[index]!).filter((value): value is string => Boolean(value));
  return [
    { field: "section.purpose", values: pick(purposes, [0, 3, 6, 7, 10, 14, 17, 20]) },
    { field: "section.purpose", values: pick(purposes, [0, 7, 14, 20]) },
    { field: "region.tag", values: ["section", "header", "main"] },
    { field: "region.role", values: ["region", "navigation"] },
    { field: "region.landmark", values: ["main", "footer"] },
  ];
}

function cpuModel(): string | null {
  try {
    return cpus()[0]?.model?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Local SQLite benchmark. Generates the requested region/claim corpus in a
 * temporary database, then measures the SQL-backed search path across region,
 * page and site scopes. No network.
 */
export function runAtlasSearchBenchmark(
  options: AtlasSearchBenchOptions = {},
): AtlasSearchBenchResult {
  const regionCount = options.regions ?? 100_000;
  const claimsPerRegion = options.claimsPerRegion ?? 10;
  const runs = options.runs ?? 50;
  const now = options.now ?? NOW;
  const random = mulberry32(options.seed ?? 20261105);
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-search-bench-"));
  const dbPath = join(dir, "atlas.db");
  const db = new DatabaseSync(dbPath);
  try {
    const sqliteVersion =
      (db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version;
    migrateAtlas(db, now, false);
    const seeded = seedBenchmarkDatabase(db, regionCount, claimsPerRegion, now, random);
    const predicates = benchmarkPredicates(seeded.purposes);
    const statePredicates = benchmarkStatePredicates(seeded.purposes);
    const run = (input: SearchAtlasInput) => {
      const compiled = compilePredicates(input);
      if (!compiled.ok) throw new Error(`${compiled.error.code}: ${compiled.error.message}`);
      const result = queryAtlasDatabase(db, {
        input: compiled.input,
        asOf: now,
        tokens: compiled.tokens,
        ftsQuery: compiled.ftsQuery,
        afterTuple: null,
      });
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      return {
        data: result.data,
        ids: result.data.hits.map((hit) => hit.regionId),
        total: result.data.total,
      };
    };

    const measure = (
      name: string,
      scope: "region" | "page" | "site",
      facets: SearchField[],
      cold: boolean,
      state: "hover" | "default" = "default",
    ): { workload: AtlasSearchBenchWorkload; ids: string[]; schemaBytes: number; maxRssBytes: number } => {
      const activePredicates = state === "default" ? predicates : statePredicates;
      const input: SearchAtlasInput = {
        kind: "sections",
        predicates: activePredicates,
        scope,
        ...(state === "default" ? {} : { state }),
        ...(facets.length > 0 ? { facets } : {}),
        limit: 8,
      };
      const firstRunStarted = performance.now();
      run(input);
      const firstRunMs = performance.now() - firstRunStarted;
      for (let warmup = 0; warmup < 5; warmup += 1) run(input);
      const samples: number[] = [];
      const rssSamples: number[] = [process.memoryUsage().rss];
      let ids: string[] = [];
      let schemaBytes = 0;
      let total = 0;
      for (let index = 0; index < runs; index += 1) {
        const started = performance.now();
        const result = run(input);
        samples.push(performance.now() - started);
        rssSamples.push(process.memoryUsage().rss);
        ids = result.ids;
        schemaBytes = Buffer.byteLength(JSON.stringify(result.data), "utf8");
        total = result.total;
      }
      const gateMs = facets.length > 0 ? 500 : 300;
      return {
        workload: {
          name,
          scope,
          facets,
          predicateCount: activePredicates.length,
          gateMs,
          p50Ms: percentile(samples, 0.5),
          p95Ms: percentile(samples, 0.95),
          firstRunMs,
          cold,
          samplesMs: samples,
          total,
        },
        ids,
        schemaBytes,
        maxRssBytes: Math.max(...rssSamples),
      };
    };

    const baselineRss = process.memoryUsage().rss;
    const measured = [
      measure("region-8-predicates", "region", [], true),
      measure("region-8-predicates-4-facets", "region", FOUR_FACETS, false),
      measure("state-region-predicates", "region", [], false, "hover"),
      measure("state-region-predicates-4-facets", "region", FOUR_FACETS, false, "hover"),
      measure("page-8-predicates", "page", [], false),
      measure("page-8-predicates-4-facets", "page", FOUR_FACETS, false),
      measure("site-8-predicates", "site", [], false),
      measure("site-8-predicates-4-facets", "site", FOUR_FACETS, false),
    ];
    const maxRss = Math.max(baselineRss, ...measured.map((entry) => entry.maxRssBytes));

    // State cursor pagination: two regions per page until the corpus is
    // exhausted, proving the state filter survives page boundaries.
    const pagingCompiled = compilePredicates({
      kind: "sections",
      state: "hover",
      predicates: statePredicates,
      limit: 2,
    });
    if (!pagingCompiled.ok) {
      throw new Error(`${pagingCompiled.error.code}: ${pagingCompiled.error.message}`);
    }
    let pagingAfter: string[] | null = null;
    const pagingIds: string[] = [];
    let pagingPages = 0;
    for (let page = 0; page < 3; page += 1) {
      const result = queryAtlasDatabase(db, {
        input: pagingCompiled.input,
        asOf: now,
        tokens: pagingCompiled.tokens,
        ftsQuery: pagingCompiled.ftsQuery,
        afterTuple: pagingAfter,
      });
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      pagingPages += 1;
      pagingIds.push(...result.data.hits.map((hit) => hit.regionId));
      if (!result.data.hasMore || !result.data.nextTuple) break;
      pagingAfter = result.data.nextTuple;
    }
    if (new Set(pagingIds).size !== pagingIds.length) {
      throw new Error("state cursor pagination returned duplicate regions");
    }
    const statePaging = { pages: pagingPages, regions: pagingIds.length };

    const workloads = measured.map((entry) => entry.workload);
    const noFacetSamples = workloads
      .filter((workload) => workload.facets.length === 0)
      .flatMap((workload) => workload.samplesMs);
    const fourFacetSamples = workloads
      .filter((workload) => workload.facets.length > 0)
      .flatMap((workload) => workload.samplesMs);
    const digest = stableHash(
      "atlas-search-bench-v3",
      ...measured.flatMap((entry) => [entry.ids.join(","), String(entry.workload.total)]),
    );
    return {
      schemaVersion: "atlas-search-bench-v3",
      regions: seeded.regions,
      ineligibleRegions: seeded.ineligibleRegions,
      staleRegions: seeded.staleRegions,
      unknownRegions: seeded.unknownRegions,
      claims: seeded.claims,
      stateClaims: seeded.stateClaims,
      claimsPerRegion,
      captures: seeded.captures,
      sites: seeded.sites,
      queries: workloads.length,
      runsPerQuery: runs,
      measuredRuns: noFacetSamples.length + fourFacetSamples.length,
      workloads,
      publishRebuildMs: seeded.publishRebuildMs,
      coldFirstRunMs: workloads[0]?.firstRunMs ?? 0,
      p50NoFacetsMs: percentile(noFacetSamples, 0.5),
      p95NoFacetsMs: percentile(noFacetSamples, 0.95),
      p50FourFacetsMs: percentile(fourFacetSamples, 0.5),
      p95FourFacetsMs: percentile(fourFacetSamples, 0.95),
      p50Ms: percentile([...noFacetSamples, ...fourFacetSamples], 0.5),
      p95Ms: percentile([...noFacetSamples, ...fourFacetSamples], 0.95),
      samplesNoFacetsMs: noFacetSamples,
      samplesFourFacetsMs: fourFacetSamples,
      baselineRssBytes: baselineRss,
      maxRssBytes: maxRss,
      additionalRssBytes: Math.max(0, maxRss - baselineRss),
      schemaBytes: Math.max(...measured.map((entry) => entry.schemaBytes)),
      snapshotBytes: statSync(dbPath).size,
      databaseBytes: statSync(dbPath).size,
      totalResults: workloads.reduce((total, workload) => total + workload.total, 0),
      deterministicDigest: digest,
      statePaging,
      now,
      environment: {
        cpu: cpuModel(),
        nodeVersion: process.version,
        sqliteVersion,
        warmState: "warm",
        runsPerQuery: runs,
      },
    };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

