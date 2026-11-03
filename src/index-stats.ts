/**
 * get_index_stats: aggregate metrics over the LOCAL cache only — zero network.
 *
 * Every metric carries a coverage block labelled "locally cached subset" so
 * an agent can never mistake these numbers for the whole Awwwards catalogue.
 * Sites, elements and technology/tag frequency are ALL-TIME counts over the
 * cache. `elements.total` stays gallery-only; `elements.corpus` discloses the
 * whole cached element split (gallery/site, categorized/uncategorized,
 * builtWithKnown, fetch range) with its own "locally cached subset" note. The
 * window (default 90 days) applies only to detail-derived metrics:
 * cached details, palette colours, jury scores and Motion DNA. Output is
 * aggregates only: no site slugs or titles ever appear.
 *
 * Bounds: detail rows parsed for palettes/scores ≤500 (most recently fetched),
 * output arrays ≤ top (default 10, max 50), window 1..3650 days (default 90).
 * Detail-derived metrics with fewer than 30 parsed rows are suppressed
 * (`insufficient: true`) instead of publishing misleading lists or averages.
 */
import type { Cache } from "./cache.js";
import type { MotionDna, SiteDetails } from "./types.js";

export const INDEX_STATS_DEFAULT_WINDOW_DAYS = 90;
export const INDEX_STATS_MAX_WINDOW_DAYS = 3650;
export const INDEX_STATS_DEFAULT_TOP = 10;
export const INDEX_STATS_MAX_TOP = 50;
/** Most recently fetched detail rows parsed for palettes/scores. */
export const MAX_DETAILS_PARSED = 500;
/** Below this many parsed rows, detail-derived metrics are suppressed. */
export const MIN_METRIC_SAMPLE = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface IndexCoverage {
  sitesTotal: number;
  note: "locally cached subset";
}

/** Coverage for the detail-derived metrics, the only windowed numbers. */
export interface WindowedCoverage extends IndexCoverage {
  detailsCached: number;
  windowDays: number;
  detailParseCap: number;
}

/** Sample provenance for a detail-derived metric. */
export interface MetricSample {
  sample: number;
  insufficient: boolean;
  hint?: string;
}

/** Bounded disclosure of the local element corpus. */
export interface ElementCorpus {
  total: number;
  gallery: number;
  site: number;
  categorized: number;
  uncategorized: number;
  builtWithKnown: number;
  fetchedOldestAt: number | null;
  fetchedNewestAt: number | null;
  fetchedAtUnit: "unix-ms";
  note: "locally cached subset";
}

export interface IndexStatsResult {
  windowDays: number;
  top: number;
  sites: { total: number; coverage: IndexCoverage };
  details: { cached: number; coverage: WindowedCoverage };
  elements: { total: number; corpus: ElementCorpus; coverage: IndexCoverage };
  technologies: {
    items: Array<{ tag: string; count: number }>;
    distinct: number;
    coverage: IndexCoverage;
  };
  colors: MetricSample & {
    items: Array<{ hex: string; count: number }>;
    detailsParsed: number;
    coverage: WindowedCoverage;
  };
  scores: MetricSample & {
    n: number;
    avg: number | null;
    median: number | null;
    coverage: WindowedCoverage;
  };
  motionLibs: MetricSample & {
    items: Array<{ lib: string; count: number }>;
    rows: number;
    coverage: WindowedCoverage;
  };
  note: string;
}

export interface IndexStatsArgs {
  windowDays?: number;
  top?: number;
}

export interface IndexStatsDeps {
  cache: Cache;
  /** Injectable clock for window tests; defaults to Date.now. */
  now?: () => number;
}

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Number.isFinite(n) ? Math.trunc(n) : min));

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Sample metadata; below the floor the metric is suppressed and names the fix. */
function sampleState(sample: number): MetricSample {
  return sample < MIN_METRIC_SAMPLE
    ? {
        sample,
        insufficient: true,
        hint: `Insufficient sample (<${MIN_METRIC_SAMPLE}). Enrich with site details for the batch { slugs } and retry.`,
      }
    : { sample, insufficient: false };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Count values, sort by count desc then key asc, keep the top N. */
function topCounts<K extends string>(
  counts: Map<K, number>,
  top: number,
): Array<{ key: K; count: number }> {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([key, count]) => ({ key, count }));
}

export function getIndexStats(
  args: IndexStatsArgs = {},
  deps: IndexStatsDeps,
): IndexStatsResult {
  const windowDays = clamp(args.windowDays ?? INDEX_STATS_DEFAULT_WINDOW_DAYS, 1, INDEX_STATS_MAX_WINDOW_DAYS);
  const top = clamp(args.top ?? INDEX_STATS_DEFAULT_TOP, 1, INDEX_STATS_MAX_TOP);
  const now = deps.now ?? Date.now;
  const cutoff = now() - windowDays * DAY_MS;

  return deps.cache.withReadDb((db): IndexStatsResult => {
    const count = (sql: string, ...params: Array<string | number>): number =>
      (db.prepare(sql).get(...params) as { n: number }).n;

    const sitesTotal = count("SELECT COUNT(*) AS n FROM sites");
    const detailsCached = count(
      "SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'detail:%' AND fetchedAt >= ?",
      cutoff,
    );
    // One aggregate for the element corpus. elements.total keeps its
    // gallery-only meaning (Cache.countElements); corpus discloses the whole
    // searchable set without element titles or slugs.
    const corpus = db.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(source = 'gallery'), 0) AS gallery,
              COALESCE(SUM(source = 'site'), 0) AS site,
              COALESCE(SUM(cid IS NOT NULL AND cid <> '' AND cid <> 'uncategorized'), 0) AS categorized,
              COALESCE(SUM(cid IS NULL OR cid = '' OR cid = 'uncategorized'), 0) AS uncategorized,
              COALESCE(SUM(CASE WHEN json_valid(builtWith) THEN json_array_length(builtWith) > 0 ELSE 0 END), 0) AS builtWithKnown,
              MIN(CASE WHEN fetchedAt < 100000000000 THEN fetchedAt * 1000 ELSE fetchedAt END) AS fetchedOldestAt,
              MAX(CASE WHEN fetchedAt < 100000000000 THEN fetchedAt * 1000 ELSE fetchedAt END) AS fetchedNewestAt
       FROM elements`,
    ).get() as Omit<ElementCorpus, "note" | "fetchedAtUnit">;
    const elementCorpus: ElementCorpus = { ...corpus, fetchedAtUnit: "unix-ms", note: "locally cached subset" };

    const coverage: IndexCoverage = {
      sitesTotal,
      note: "locally cached subset",
    };
    const windowCoverage: WindowedCoverage = {
      ...coverage,
      detailsCached,
      windowDays,
      detailParseCap: MAX_DETAILS_PARSED,
    };

    // Technologies: site tags, slug-normalized. Aggregates only.
    const tech = new Map<string, number>();
    const tagRows = db.prepare("SELECT tags FROM sites").all() as Array<{ tags: string }>;
    for (const row of tagRows) {
      let tags: unknown;
      try {
        tags = JSON.parse(row.tags);
      } catch {
        continue;
      }
      if (!Array.isArray(tags)) continue;
      const seen = new Set<string>();
      for (const tag of tags) {
        if (typeof tag !== "string") continue;
        const slug = slugify(tag);
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        tech.set(slug, (tech.get(slug) ?? 0) + 1);
      }
    }
    const techTop = topCounts(tech, top).map((t) => ({ tag: t.key, count: t.count }));

    // Detail-derived metrics: palettes + scores over the most recent ≤500
    // detail rows inside the window.
    const detailRows = db
      .prepare(
        "SELECT value FROM meta WHERE key LIKE 'detail:%' AND fetchedAt >= ? ORDER BY fetchedAt DESC LIMIT ?",
      )
      .all(cutoff, MAX_DETAILS_PARSED) as Array<{ value: string }>;

    const colorCounts = new Map<string, number>();
    const scores: number[] = [];
    let detailsParsed = 0;
    for (const row of detailRows) {
      let detail: Partial<SiteDetails>;
      try {
        detail = JSON.parse(row.value) as Partial<SiteDetails>;
      } catch {
        continue;
      }
      if (!detail || typeof detail !== "object") continue;
      detailsParsed++;
      if (Array.isArray(detail.palette)) {
        const seen = new Set<string>();
        for (const raw of detail.palette) {
          if (typeof raw !== "string") continue;
          const trimmed = raw.trim().toUpperCase();
          const hex = trimmed.startsWith("#") ? trimmed : "#" + trimmed;
          if (!/^#[0-9A-F]{6}$/.test(hex) || seen.has(hex)) continue;
          seen.add(hex);
          colorCounts.set(hex, (colorCounts.get(hex) ?? 0) + 1);
        }
      }
      if (typeof detail.score === "number" && Number.isFinite(detail.score)) {
        scores.push(detail.score);
      }
    }

    const colorTop = topCounts(colorCounts, top).map((c) => ({ hex: c.key, count: c.count }));

    const scoreAvg = scores.length
      ? round2(scores.reduce((sum, n) => sum + n, 0) / scores.length)
      : null;
    const scoreMedian = (() => {
      const m = median(scores);
      return m === null ? null : round2(m);
    })();

    // Motion DNA rows inside the window; count library appearances.
    const dnaRows = db
      .prepare("SELECT data FROM motion_dna WHERE capturedAt >= ?")
      .all(cutoff) as Array<{ data: string }>;
    const libs = new Map<string, number>();
    let dnaRowsParsed = 0;
    for (const row of dnaRows) {
      let dna: Partial<MotionDna>;
      try {
        dna = JSON.parse(row.data) as Partial<MotionDna>;
      } catch {
        continue;
      }
      if (!dna || typeof dna !== "object") continue;
      dnaRowsParsed++;
      const list = dna?.stack?.libs;
      if (!Array.isArray(list)) continue;
      const seen = new Set<string>();
      for (const lib of list) {
        if (typeof lib !== "string" || !lib || seen.has(lib)) continue;
        seen.add(lib);
        libs.set(lib, (libs.get(lib) ?? 0) + 1);
      }
    }
    const libTop = topCounts(libs, top).map((l) => ({ lib: l.key, count: l.count }));

    const colorsSample = sampleState(detailsParsed);
    const scoresSample = sampleState(scores.length);
    const motionSample = sampleState(dnaRowsParsed);

    return {
      windowDays,
      top,
      sites: { total: sitesTotal, coverage },
      details: { cached: detailsCached, coverage: windowCoverage },
      elements: { total: elementCorpus.gallery, corpus: elementCorpus, coverage },
      technologies: { items: techTop, distinct: tech.size, coverage },
      colors: {
        items: colorsSample.insufficient ? [] : colorTop,
        detailsParsed,
        ...colorsSample,
        coverage: windowCoverage,
      },
      scores: {
        n: scores.length,
        avg: scoresSample.insufficient ? null : scoreAvg,
        median: scoresSample.insufficient ? null : scoreMedian,
        ...scoresSample,
        coverage: windowCoverage,
      },
      motionLibs: {
        items: motionSample.insufficient ? [] : libTop,
        rows: dnaRowsParsed,
        ...motionSample,
        coverage: windowCoverage,
      },
      note: "Aggregates over the local cache only; no network requests and no site slugs or titles. Sites, elements and technologies are all-time; details, colours, scores and motion libraries use the window.",
    };
  });
}
