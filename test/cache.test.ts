import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import type { SiteSummary } from "../src/types.js";

const dirs: string[] = [];
const tmpDir = () => {
  const d = mkdtempSync(join(tmpdir(), "awwwards-mcp-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Accepts a bare slug or an overrides object (e.g. site({ slug, title, tags })).
const site = (spec: string | Partial<SiteSummary>): SiteSummary => {
  const over: Partial<SiteSummary> = typeof spec === "string" ? { slug: spec } : spec;
  return {
    id: 1,
    slug: over.slug ?? "a",
    title: "Test Site",
    createdAt: 1789516800,
    tags: ["3D", "WebGL"],
    thumbnailPath: "submissions/2026/08/abc.jpg",
    liveUrl: "https://example.com",
    detailPath: `/sites/${over.slug ?? "a"}`,
    awards: ["Site of the Day"],
    ...over,
  };
};

describe("Cache", () => {
  it("round-trips sites and honors TTL", () => {
    let t = 1_000_000;
    const cache = new Cache(tmpDir(), () => t);
    cache.upsertSites([site("a"), site("b")]);
    expect(cache.getSites(10_000).length).toBe(2);
    expect(cache.getSite("a")!.liveUrl).toBe("https://example.com");
    expect(cache.getSite("a")!.tags).toEqual(["3D", "WebGL"]);
    t += 20_000;
    expect(cache.getSites(10_000).length).toBe(0); // expired
    expect(cache.getSite("a")).toBeNull(); // expired lookups are misses
  });

  it("upserts over existing slugs instead of duplicating", () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site("a")]);
    const updated = { ...site("a"), title: "Renamed" };
    cache.upsertSites([updated]);
    expect(cache.getSites(10_000).length).toBe(1);
    expect(cache.getSites(10_000)[0].title).toBe("Renamed");
  });

  it("stores and expires arbitrary meta values", () => {
    let t = 1_000_000;
    const cache = new Cache(tmpDir(), () => t);
    cache.setMeta("categories", { colors: ["#000000"], filters: ["3d"] });
    expect(cache.getMeta<any>("categories", 5_000)!.filters).toEqual(["3d"]);
    t += 6_000;
    expect(cache.getMeta("categories", 5_000)).toBeNull();
  });

  it("caches image buffers on disk keyed by asset path", async () => {
    const cache = new Cache(tmpDir());
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return Buffer.from("jpeg-bytes-" + calls);
    };
    const first = await cache.getImage("submissions/2026/08/abc.jpg", fetcher);
    const second = await cache.getImage("submissions/2026/08/abc.jpg", fetcher);
    expect(calls).toBe(1);
    expect(second.equals(first)).toBe(true);
    expect(first.toString()).toContain("jpeg-bytes-1");
  });

  it("deletes meta keys", () => {
    const cache = new Cache(tmpDir());
    cache.setMeta("index:lock", { startedAt: 1 });
    expect(cache.getMeta<any>("index:lock", 10_000)).toEqual({ startedAt: 1 });
    cache.deleteMeta("index:lock");
    expect(cache.getMeta("index:lock", 10_000)).toBeNull();
    cache.deleteMeta("index:lock"); // idempotent
    expect(cache.getMeta("index:lock", 10_000)).toBeNull();
  });
});

describe("searchSites (FTS5)", () => {
  const seed = (cache: Cache) =>
    cache.upsertSites([
      site({ slug: "editorial-mag", title: "Editorial Mag", tags: ["Magazine / Newspaper / Blog"] }),
      site({ slug: "webgl-studio", title: "WebGL Studio", tags: ["3d", "webgl"] }),
      site({ slug: "magazine-post", title: "A Magazine Post About Editorial Things", tags: [] }),
    ]);

  it("matches multi-word queries that substring search could never match", () => {
    const cache = new Cache(tmpDir());
    seed(cache);
    // "magazine" is in the tag of row 1 and the title of row 3; "editorial"
    // in the title of row 1 and the title of row 3 — no single substring span.
    const rows = cache.searchSites("editorial magazine", 1000)!;
    expect(rows.map((r) => r.slug)).toContain("editorial-mag");
    expect(rows.map((r) => r.slug)).toContain("magazine-post");
  });

  it("ranks title hits above tag-only hits (bm25)", () => {
    const cache = new Cache(tmpDir());
    seed(cache);
    const rows = cache.searchSites("editorial", 1000)!;
    expect(rows[0]!.slug).toBe("editorial-mag"); // title hit leads
  });

  it("matches prefixes and porter stems (editor → Editorial)", () => {
    const cache = new Cache(tmpDir());
    seed(cache);
    const rows = cache.searchSites("edito", 1000)!;
    expect(rows.map((r) => r.slug)).toContain("editorial-mag");
    const stemmed = cache.searchSites("magazines", 1000)!; // stem ≡ magazine
    expect(stemmed.length).toBeGreaterThanOrEqual(2);
  });

  it("respects maxAgeMs and sanitizes FTS operators out of tokens", () => {
    const cache = new Cache(tmpDir());
    seed(cache);
    expect(cache.searchSites('editorial" OR NEAR (', 1000)).not.toBeNull();
    expect(cache.searchSites("editorial", 0)).toEqual([]); // all expired
  });

  it("backfills the fts table on first open of a legacy DB (rows exist, fts empty)", () => {
    // simulate a pre-FTS DB: drop the insert-sync trigger BEFORE seeding so
    // rows land in sites while sites_fts stays empty, then reopen a Cache on
    // the same dir and query — the backfill at open must make search work.
    const dir = tmpDir();
    const cache = new Cache(dir);
    cache.withDbForTest((db) => db.exec("DROP TRIGGER sites_fts_ai"));
    seed(cache);
    const reopened = new Cache(dir);
    const rows = reopened.searchSites("editorial", 1000)!;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    reopened.withDbForTest((db) => {
      const { n } = db.prepare("SELECT COUNT(*) AS n FROM sites_fts").get() as unknown as { n: number };
      expect(n).toBe(3);
    });
  });
});
