import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import { getIndexStats, MIN_METRIC_SAMPLE } from "../src/index-stats.js";
import type { ElementRecord, MotionDna, SiteDetails, SiteSummary } from "../src/types.js";

const dirs: string[] = [];
const tmpDir = () => {
  const d = mkdtempSync(join(tmpdir(), "awwwards-stats-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 25);

const site = (slug: string, title: string, tags: string[]): SiteSummary => ({
  id: 1,
  slug,
  title,
  createdAt: 1789516800,
  tags,
  thumbnailPath: `submissions/${slug}.jpg`,
  liveUrl: "https://example.com",
  detailPath: `/sites/${slug}`,
  awards: ["Site of the Day"],
});

const details = (score: number | null, palette: string[]): SiteDetails => ({
  slug: "x",
  title: null,
  description: null,
  palette,
  technologies: [],
  elements: [],
  awards: [],
  nominee: false,
  score,
  ogImage: null,
  liveUrl: null,
});

const dna = (url: string, libs: string[], capturedAt: number): MotionDna => ({
  url,
  stack: { libs, render: [], scrollModel: "native" },
  scroll: { triggerCount: 0, scrubCount: 0, pinCount: 0, scrubRatio: 0, sample: [] },
  easingVocab: [],
  durationVocab: null,
  capturedAt,
});

const element = (
  slug: string,
  fetchedAt: number,
  overrides: Partial<ElementRecord> = {},
): ElementRecord => ({
  slug,
  title: "Element",
  cid: "hero",
  category: "hero",
  author: "Studio",
  builtWith: [],
  related: [],
  mediaPath: "",
  mediaType: null,
  source: "gallery",
  projectId: null,
  siteSlug: null,
  fetchedAt,
  ...overrides,
});

const BASE_COVERAGE = {
  sitesTotal: 3,
  note: "locally cached subset",
};

const WINDOW_COVERAGE = {
  detailsCached: 2,
  sitesTotal: 3,
  windowDays: 90,
  detailParseCap: 500,
  note: "locally cached subset",
};

/** Seeded cache: two recent detail rows + one 100-day-old row. */
function seeded() {
  let clock = NOW - 100 * DAY;
  const cache = new Cache(tmpDir(), () => clock);
  cache.upsertSites([
    site("alpha", "Cool Studio", ["WebGL", "3D"]),
    site("beta", "Beta Site", ["WebGL", "Next.js"]),
    site("gamma", "Gamma", ["Portfolio"]),
  ]);
  cache.upsertElements([element("el-one", clock)]);
  // Old rows (outside the default 90-day window).
  cache.setMeta("detail:old", details(10, ["#00FF00"]));
  cache.upsertMotionDna(dna("https://old.example", ["gsap"], clock));

  clock = NOW;
  cache.setMeta("detail:alpha", details(8, ["#FFFFFF", "#000000"]));
  cache.setMeta("detail:beta", details(6, ["#000000", "#FF0000"]));
  cache.upsertMotionDna(dna("https://one.example", ["gsap", "three.js"], clock));
  cache.upsertMotionDna(dna("https://two.example", ["gsap"], clock));
  return cache;
}

/** Seed `n` fresh parsed detail rows and `n` fresh Motion DNA rows. */
function seedSamples(cache: Cache, n: number): void {
  for (let i = 0; i < n; i++) {
    cache.setMeta(`detail:fixture-${i}`, details(5 + (i % 5), ["#112233", "#445566"]));
    cache.upsertMotionDna(dna(`https://fixture-${i}.example`, ["gsap", "three.js"], NOW));
  }
}

describe("getIndexStats", () => {
  it("aggregates all-time counts and suppresses low-sample detail metrics", () => {
    const cache = seeded();
    const stats = getIndexStats({}, { cache, now: () => NOW });

    expect(stats.windowDays).toBe(90);
    expect(stats.top).toBe(10);
    expect(stats.sites.total).toBe(3);
    expect(stats.details.cached).toBe(2);
    expect(stats.elements.total).toBe(1);

    expect(stats.technologies.items).toEqual([
      { tag: "webgl", count: 2 },
      { tag: "3d", count: 1 },
      { tag: "next-js", count: 1 },
      { tag: "portfolio", count: 1 },
    ]);
    expect(stats.technologies.distinct).toBe(4);

    // Two parsed rows are below the 30-row floor, so derived lists and
    // averages are suppressed rather than published as fact.
    expect(stats.colors).toMatchObject({
      items: [],
      detailsParsed: 2,
      sample: 2,
      insufficient: true,
    });
    expect(stats.colors.hint).toContain("site details");

    expect(stats.scores).toMatchObject({
      n: 2,
      avg: null,
      median: null,
      sample: 2,
      insufficient: true,
    });

    expect(stats.motionLibs).toMatchObject({
      items: [],
      rows: 2,
      sample: 2,
      insufficient: true,
    });

    for (const metric of [stats.colors, stats.scores, stats.motionLibs]) {
      expect(metric.hint).toContain("site details");
      expect(metric.hint).toContain(`<${MIN_METRIC_SAMPLE}`);
    }
    expect(MIN_METRIC_SAMPLE).toBe(30);

    // All-time metrics carry all-time coverage; windowed metrics carry the
    // window and the detail-parse cap.
    for (const metric of [stats.sites, stats.elements, stats.technologies]) {
      expect(metric.coverage).toEqual(BASE_COVERAGE);
      expect("windowDays" in metric.coverage).toBe(false);
    }
    for (const metric of [stats.details, stats.colors, stats.scores, stats.motionLibs]) {
      expect(metric.coverage).toEqual(WINDOW_COVERAGE);
    }
  });

  it("reports metrics at 30 parsed rows and caps derived lists at top", () => {
    const cache = new Cache(tmpDir(), () => NOW);
    seedSamples(cache, 30);
    const result = getIndexStats({}, { cache, now: () => NOW });

    expect(result.colors.sample).toBe(30);
    expect(result.colors.insufficient).toBe(false);
    expect(result.colors.hint).toBeUndefined();
    expect(result.colors.items).toEqual([
      { hex: "#112233", count: 30 },
      { hex: "#445566", count: 30 },
    ]);

    expect(result.scores.sample).toBe(30);
    expect(result.scores.insufficient).toBe(false);
    expect(result.scores.avg).toBe(7);
    expect(result.scores.median).toBe(7);

    expect(result.motionLibs.sample).toBe(30);
    expect(result.motionLibs.insufficient).toBe(false);
    expect(result.motionLibs.items).toEqual([
      { lib: "gsap", count: 30 },
      { lib: "three.js", count: 30 },
    ]);

    const capped = getIndexStats({ top: 1 }, { cache, now: () => NOW });
    expect(capped.colors.items).toEqual([{ hex: "#112233", count: 30 }]);
    expect(capped.motionLibs.items).toEqual([{ lib: "gsap", count: 30 }]);
  });

  it("derives score provenance from scored rows, not parsed rows", () => {
    const cache = new Cache(tmpDir(), () => NOW);
    for (let i = 0; i < 30; i++) {
      cache.setMeta(`detail:score-${i}`, details(i < 2 ? 7 : null, ["#112233"]));
    }
    const result = getIndexStats({}, { cache, now: () => NOW });

    expect(result.colors.sample).toBe(30);
    expect(result.colors.insufficient).toBe(false);
    expect(result.scores.sample).toBe(2);
    expect(result.scores.insufficient).toBe(true);
    expect(result.scores.avg).toBeNull();
  });

  it("uses parsed rows for sample, not detailsCached", () => {
    const cache = new Cache(tmpDir(), () => NOW);
    cache.setMeta("detail:valid-a", details(8, ["#FFFFFF"]));
    cache.setMeta("detail:valid-b", details(6, ["#000000"]));
    cache.withDbForTest((db) => {
      const insert = db.prepare("INSERT INTO meta (key, value, fetchedAt) VALUES (?, ?, ?)");
      for (let i = 0; i < 38; i++) insert.run(`detail:malformed-${i}`, "{not json", NOW);
    });

    const result = getIndexStats({}, { cache, now: () => NOW });
    expect(result.details.cached).toBe(40);
    expect(result.colors.sample).toBe(2);
    expect(result.colors.detailsParsed).toBe(2);
    expect(result.colors.insufficient).toBe(true);
  });

  it("never emits site slugs, titles or URLs", () => {
    const cache = seeded();
    const json = JSON.stringify(getIndexStats({}, { cache, now: () => NOW }));
    for (const forbidden of ['"alpha"', "Cool Studio", "Beta Site", "example.com", "gamma"]) {
      expect(json).not.toContain(forbidden);
    }
    expect(json).toContain("locally cached subset");
  });

  it("honours the window and the top cap", () => {
    const cache = seeded();
    const wide = getIndexStats({ windowDays: 3650, top: 1 }, { cache, now: () => NOW });
    expect(wide.details.cached).toBe(3);
    // Still below the 30-row floor after widening the window.
    expect(wide.scores).toMatchObject({
      n: 3,
      avg: null,
      median: null,
      sample: 3,
      insufficient: true,
    });
    expect(wide.colors.items).toEqual([]);
    expect(wide.colors.sample).toBe(3);
    expect(wide.motionLibs.items).toEqual([]);
    expect(wide.motionLibs.rows).toBe(3);
    expect(wide.motionLibs.sample).toBe(3);
    expect(wide.technologies.items).toHaveLength(1);
    for (const metric of [wide.sites, wide.elements, wide.technologies]) {
      expect(metric.coverage).toEqual(BASE_COVERAGE);
    }
    for (const metric of [wide.details, wide.colors, wide.scores, wide.motionLibs]) {
      expect(metric.coverage.windowDays).toBe(3650);
      expect(metric.coverage.detailsCached).toBe(3);
    }

    const narrow = getIndexStats({ windowDays: 1 }, { cache, now: () => NOW + 10 * DAY });
    expect(narrow.details.cached).toBe(0);
    expect(narrow.colors.items).toEqual([]);
    expect(narrow.scores).toMatchObject({ n: 0, avg: null, median: null });
    expect(narrow.motionLibs.rows).toBe(0);
    expect(narrow.details.coverage.detailsCached).toBe(0);
    expect(narrow.details.coverage.windowDays).toBe(1);
    // Sites, elements and their tags are all-time: they describe the local index.
    expect(narrow.sites.total).toBe(3);
    expect(narrow.elements.total).toBe(1);
    expect(narrow.technologies.distinct).toBe(4);
    expect(narrow.sites.coverage).toEqual(BASE_COVERAGE);
  });

  it("clamps windowDays and top to the documented range", () => {
    const cache = seeded();
    const low = getIndexStats({ windowDays: 0, top: 0 }, { cache, now: () => NOW });
    expect(low.windowDays).toBe(1);
    expect(low.top).toBe(1);
    const high = getIndexStats({ windowDays: 99_999, top: 999 }, { cache, now: () => NOW });
    expect(high.windowDays).toBe(3650);
    expect(high.top).toBe(50);
  });

  it("returns a well-formed zero result on an empty cache", () => {
    const cache = new Cache(tmpDir(), () => NOW);
    const stats = getIndexStats({}, { cache, now: () => NOW });
    expect(stats.sites.total).toBe(0);
    expect(stats.details.cached).toBe(0);
    expect(stats.elements.total).toBe(0);
    expect(stats.elements.corpus).toEqual({
      total: 0,
      gallery: 0,
      site: 0,
      categorized: 0,
      uncategorized: 0,
      builtWithKnown: 0,
      fetchedOldestAt: null,
      fetchedNewestAt: null,
      fetchedAtUnit: "unix-ms",
      note: "locally cached subset",
    });
    expect(stats.technologies).toMatchObject({ items: [], distinct: 0 });
    expect(stats.colors).toMatchObject({ items: [], detailsParsed: 0 });
    expect(stats.scores).toMatchObject({ n: 0, avg: null, median: null });
    expect(stats.motionLibs).toMatchObject({ items: [], rows: 0 });
    expect(stats.sites.coverage).toEqual({
      sitesTotal: 0,
      note: "locally cached subset",
    });
    expect(stats.details.coverage).toEqual({
      detailsCached: 0,
      sitesTotal: 0,
      windowDays: 90,
      detailParseCap: 500,
      note: "locally cached subset",
    });
  });

  it("skips malformed JSON rows without failing the aggregates", () => {
    const cache = seeded();
    cache.withDbForTest((db) => {
      db.prepare("INSERT INTO meta (key, value, fetchedAt) VALUES (?, ?, ?)").run(
        "detail:bad",
        "{not json",
        NOW,
      );
      db.prepare("INSERT INTO motion_dna (url, data, capturedAt) VALUES (?, ?, ?)").run(
        "https://bad.example",
        "not json",
        NOW,
      );
      db.prepare("UPDATE sites SET tags = ? WHERE slug = ?").run("not json", "gamma");
    });
    const stats = getIndexStats({}, { cache, now: () => NOW });
    // The cached row exists (SQL count) but does not contribute evidence.
    expect(stats.details.cached).toBe(3);
    expect(stats.colors.detailsParsed).toBe(2);
    expect(stats.colors.sample).toBe(2);
    expect(stats.colors.insufficient).toBe(true);
    expect(stats.colors.items).toEqual([]);
    expect(stats.scores).toMatchObject({
      n: 2,
      avg: null,
      median: null,
      sample: 2,
      insufficient: true,
    });
    // rows counts parsed DNA rows, so the malformed row is not double-counted.
    expect(stats.motionLibs.rows).toBe(2);
    expect(stats.motionLibs.sample).toBe(2);
    expect(stats.motionLibs.insufficient).toBe(true);
    expect(stats.motionLibs.items).toEqual([]);
    expect(stats.technologies.items).toEqual([
      { tag: "webgl", count: 2 },
      { tag: "3d", count: 1 },
      { tag: "next-js", count: 1 },
    ]);
    expect(stats.technologies.distinct).toBe(3);
  });

  it("makes zero network requests", () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network disabled");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const cache = seeded();
      getIndexStats({}, { cache, now: () => NOW });
      getIndexStats({ windowDays: 3650 }, { cache, now: () => NOW });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("element corpus disclosure", () => {
  it("counts a gallery-only corpus and keeps elements.total gallery-only", () => {
    const cache = new Cache(tmpDir(), () => NOW);
    cache.upsertElements([
      element("gallery-hero", NOW - 30, { builtWith: ["GSAP"] }),
      element("gallery-uncategorized", NOW - 10, { cid: "uncategorized" }),
      element("gallery-empty-cid", NOW, { cid: "", builtWith: ["Lenis"] }),
    ]);

    const { elements } = getIndexStats({}, { cache, now: () => NOW });
    expect(elements.total).toBe(3);
    expect(elements.corpus).toEqual({
      total: 3,
      gallery: 3,
      site: 0,
      categorized: 1,
      uncategorized: 2,
      builtWithKnown: 2,
      fetchedOldestAt: NOW - 30,
      fetchedNewestAt: NOW,
      fetchedAtUnit: "unix-ms",
      note: "locally cached subset",
    });
  });

  it("normalizes legacy second-based fetchedAt in corpus extrema", () => {
    const cache = new Cache(tmpDir(), () => NOW);
    const oldSec = Math.floor((NOW - 100_000) / 1000);
    cache.upsertElements([
      element("legacy-seconds", oldSec),
      element("current-ms", NOW),
    ]);
    const { elements } = getIndexStats({}, { cache, now: () => NOW });
    expect(elements.corpus.fetchedOldestAt).toBe(NOW - 100_000);
    expect(elements.corpus.fetchedNewestAt).toBe(NOW);
    expect(elements.corpus.fetchedAtUnit).toBe("unix-ms");
  });

  it("counts a site-only corpus while elements.total stays 0", () => {
    const cache = new Cache(tmpDir(), () => NOW);
    cache.upsertElements([
      element("site-hero", NOW, {
        source: "site",
        cid: "uncategorized",
        category: "uncategorized",
        siteSlug: "example",
      }),
    ]);

    const { elements } = getIndexStats({}, { cache, now: () => NOW });
    expect(elements.total).toBe(0);
    expect(elements.corpus).toMatchObject({
      total: 1,
      gallery: 0,
      site: 1,
      categorized: 0,
      uncategorized: 1,
      builtWithKnown: 0,
      fetchedOldestAt: NOW,
      fetchedNewestAt: NOW,
    });
  });

  it("counts a mixed corpus, missing builtWith and legacy NULL cid without leaking rows", () => {
    const cache = new Cache(tmpDir(), () => NOW);
    cache.upsertElements([
      element("gallery-hero", NOW - 5, { builtWith: ["GSAP", "Lenis"] }),
      element("site-hero", NOW, { source: "site", cid: "uncategorized", siteSlug: "example" }),
    ]);
    cache.withDbForTest((db) => {
      db.prepare(
        `INSERT INTO elements (slug, title, cid, category, author, builtWith, related, mediaPath, mediaType, source, projectId, siteSlug, fetchedAt)
         VALUES ('legacy-null-cid', 'Legacy Title', NULL, NULL, 'Studio', '[]', '[]', NULL, NULL, 'gallery', NULL, NULL, ?)`,
      ).run(NOW - 1);
    });

    const stats = getIndexStats({}, { cache, now: () => NOW });
    expect(stats.elements.total).toBe(2);
    expect(stats.elements.corpus).toEqual({
      total: 3,
      gallery: 2,
      site: 1,
      categorized: 1,
      uncategorized: 2,
      builtWithKnown: 1,
      fetchedOldestAt: NOW - 5,
      fetchedNewestAt: NOW,
      fetchedAtUnit: "unix-ms",
      note: "locally cached subset",
    });
    const json = JSON.stringify(stats);
    for (const forbidden of ["gallery-hero", "site-hero", "legacy-null-cid", "Legacy Title"]) {
      expect(json).not.toContain(forbidden);
    }
  });
});
