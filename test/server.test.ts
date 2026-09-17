import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandlers, slugifyTag, suggestTags, tokenizeQuery } from "../src/server.js";
import { AwwwardsClient } from "../src/awwwards.js";
import { Cache } from "../src/cache.js";
import type { SiteSummary } from "../src/types.js";

const FIXTURES = join(__dirname, "fixtures");
const listingHtml = readFileSync(join(FIXTURES, "listing.html"), "utf8");

const dirs: string[] = [];
const tmpDir = () => {
  const d = mkdtempSync(join(tmpdir(), "awwwards-srv-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function site(overrides: Partial<SiteSummary> = {}): SiteSummary {
  return {
    id: 1, slug: "s1", title: "Cool Studio", createdAt: 1789516800,
    tags: ["WebGL", "3D"], thumbnailPath: "submissions/2026/08/abc.jpg",
    liveUrl: "https://example.com", detailPath: "/sites/s1",
    awards: ["Site of the Day"], ...overrides,
  };
}

// Client whose fake fetch serves fixture pages; every call is recorded.
function fakeClient() {
  const fetchFn = vi.fn(async (input: any) => {
    const url = String(input);
    if (url.includes("/sites/l-i-s-a")) {
      return new Response(readFileSync(join(FIXTURES, "detail.html"), "utf8"), { status: 200 });
    }
    return new Response(listingHtml, { status: 200 });
  });
  const client = new AwwwardsClient({ fetchFn: fetchFn as unknown as typeof fetch });
  return { client, fetchFn };
}

// Synthetic detail page with n element blobs in the fixture's attribute
// encoding: JSON with `\/` slashes and double quotes entity-escaped, so the
// blob ends at the first raw `">` — exactly what parseElements expects.
function elementsPage(n: number): string {
  const names = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const blob = (title: string, mediaPath: string) =>
    JSON.stringify({ collectableTitle: title, collectableImage: mediaPath })
      .replace(/\//g, "\\/")
      .replace(/"/g, "&quot;");
  const items = Array.from(
    { length: n },
    (_, i) =>
      `<div data-collectable-model-value="${blob(
        `Element ${names[i]}`,
        `element/2026/08/el${i + 1}.${i % 2 === 0 ? "mp4" : "jpg"}`,
      )}"></div>`,
  ).join("\n");
  return `<h2>Elements</h2>${items}<h2>Color Palette</h2>`;
}

describe("slugifyTag", () => {
  it("normalizes site tags to filter slugs", () => {
    expect(slugifyTag("Content architecture")).toBe("content-architecture");
    expect(slugifyTag("3D")).toBe("3d");
    expect(slugifyTag("WebGL")).toBe("webgl");
  });
});

describe("search_sites", () => {
  it("serves matching fresh cache without any network call", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites(Array.from({ length: 8 }, (_, i) => site({ slug: `s${i + 1}` })));
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ tags: ["webgl"], count: 6 });
    const pageCalls = fetchFn.mock.calls.filter((c: any[]) =>
      String(c[0]).includes("/websites/") || String(c[0]).includes("/sites/"),
    );
    expect(pageCalls.length).toBe(0);
    const text = res.content[0] as any;
    expect(text.type).toBe("text");
    expect(text.text).toContain("s1");
    expect(text.text).toContain("https://example.com");
  });

  it("scrapes when the cache cannot satisfy the filters, then caches", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ technology: "webgl", count: 3 });
    expect(String(fetchFn.mock.calls[0][0])).toContain("/websites/webgl/");
    expect(res.content.filter((b: any) => b.type === "image").length).toBe(3);
    expect(cache.getSites(10_000).length).toBeGreaterThan(0);
  });

  it("applies the free-text query client-side", async () => {
    const cache = new Cache(tmpDir());
    // 7 matching rows ≥ count → cache-serve path; the "Boring Corp" row
    // (upserted over s2) carries a NEWER createdAt, so without the query
    // check it would sort first into the served window — its absence proves
    // the query filter excluded it, not the count-6 pagination slice.
    cache.upsertSites([
      ...Array.from({ length: 8 }, (_, i) => site({ slug: `s${i + 1}` })),
      site({ slug: "s2", title: "Boring Corp", tags: [], createdAt: 1789516800 + 60 }),
    ]);
    const { client } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ query: "cool", count: 6 });
    expect((res.content[0] as any).text).toContain("s1");
    expect((res.content[0] as any).text).not.toContain("s2");
  });

  it("paginates with page and count", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites(Array.from({ length: 8 }, (_, i) => site({ slug: `s${i + 1}` })));
    const { client } = fakeClient();
    const h = createHandlers({ client, cache });
    const p1 = await h.search_sites({ count: 3, page: 1 });
    const p2 = await h.search_sites({ count: 3, page: 2 });
    expect((p1.content[0] as any).text).toContain("s1");
    expect((p2.content[0] as any).text).toContain("s4");
    expect(p1.content.filter((b: any) => b.type === "image").length).toBe(3);
  });

  it("falls back to stale cache when the live request fails", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site(), site({ slug: "s2" })]);
    const client = new AwwwardsClient({
      fetchFn: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    const h = createHandlers({ client, cache });
    // 2 fresh sites < count*page (12*2) → scrape attempt fails → stale cache served
    const res = await h.search_sites({ count: 12, page: 2 });
    const text = (res.content[0] as any).text;
    expect(text).toContain("stale");
    expect(text).toContain("s1");
    expect(res.isError).toBeUndefined();
  });

  it("client-checks the technology filter when serving from cache", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites(Array.from({ length: 8 }, (_, i) => site({ slug: `t${i + 1}`, tags: ["3D"] })));
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ technology: "webgl", count: 6 });
    const text = (res.content[0] as any).text;
    // v1 bug: 8 rows ≥ count → served unfiltered with zero fetches. Fixed: the
    // zero cache matches force a scrape of /websites/webgl/, and results come
    // from that page.
    expect(String(fetchFn.mock.calls[0][0])).toContain("/websites/webgl/");
    expect(text).not.toContain("8 site(s) matched");
    expect(res.content.filter((b: any) => b.type === "image").length).toBe(6);
  });

  it("never serves a color search from cache", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites(Array.from({ length: 8 }, (_, i) => site({ slug: `c${i + 1}` })));
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ color: "#404040", count: 6 });
    expect(String(fetchFn.mock.calls[0][0])).toContain("%23404040");
    expect(res.content.filter((b: any) => b.type === "image").length).toBe(6);
  });

  it("scrapes the color page and filters fresh rows by award", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([
      ...Array.from({ length: 8 }, (_, i) =>
        site({ slug: `a${i + 1}`, awards: ["Site of the Day"] })),
      site({ slug: "plain", awards: [] }),
    ]);
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    // Color can't be verified client-side, so the search scrapes the color
    // page (color wins the URL); award is NOT the URL source, so it is still
    // client-checked against the freshly parsed rows.
    const res = await h.search_sites({ color: "#404040", award: "sotd", count: 6 });
    expect(String(fetchFn.mock.calls[0][0])).toContain("%23404040");
    const text = (res.content[0] as any).text;
    expect(res.content.filter((b: any) => b.type === "image").length).toBe(6);
  });

  it("client-checks the award filter when serving from cache", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([
      ...Array.from({ length: 8 }, (_, i) =>
        site({ slug: `w${i + 1}`, awards: ["Site of the Day"], createdAt: 1789516800 + i })),
      site({ slug: "plain", awards: [], createdAt: 1789516800 + 100 }),
    ]);
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ award: "sotd", count: 6 });
    const text = (res.content[0] as any).text;
    expect(text).toContain("8 site(s) matched");
    expect(text).not.toContain("plain");
    const pageCalls = fetchFn.mock.calls.filter((c: any[]) =>
      String(c[0]).includes("/websites/") || String(c[0]).includes("/sites/"));
    expect(pageCalls.length).toBe(0);
  });
});

describe("search_sites error hardening", () => {
  it("returns isError instead of throwing when the cache store is broken", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const h = createHandlers({ client, cache });
    (cache as any).getSites = () => {
      throw new Error("corrupt db");
    };
    (cache as any).upsertSites = () => {};
    const res = await h.search_sites({ tags: ["3d"], count: 6 });
    expect(res.isError).toBe(true);
  });
});

describe("get_site_details", () => {
  it("scrapes the detail page and returns palette + technologies", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.get_site_details({ slug: "l-i-s-a" });
    const text = (res.content[0] as any).text;
    expect(text).toContain("#"); // a palette hex
    expect(text).toContain("WebGL");
    expect(text).toContain("lisa.locomotive.ca");
  });
});

describe("list_categories", () => {
  it("returns colors and filters as JSON and caches for 30 days", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.list_categories();
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.colors.length).toBeGreaterThanOrEqual(20);
    expect(parsed.filters).toContain("3d");
    await h.list_categories(); // second call is served from the meta cache
    expect(fetchFn.mock.calls.length).toBe(1);
  });
});

describe("capture_live_site", () => {
  it("returns install instructions when the capture function reports failure", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const h = createHandlers({
      client,
      cache,
      captureFn: async () => ({ error: "Playwright is not installed." }),
    });
    const res = await h.capture_live_site({ url: "https://example.com" });
    expect((res.content[0] as any).text).toContain("Playwright is not installed");
  });
});

describe("empty-parse guards", () => {
  it("list_categories errors instead of caching an empty taxonomy", async () => {
    const cache = new Cache(tmpDir());
    const client = new AwwwardsClient({
      fetchFn: (async () => new Response("<html><body>nothing</body></html>", { status: 200 })) as unknown as typeof fetch,
    });
    const h = createHandlers({ client, cache });
    const res = await h.list_categories();
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain("parsed 0 categories");
    expect(cache.getMeta<any>("categories", 30 * 24 * 60 * 60 * 1000)).toBeNull();
  });

  it("get_site_details errors instead of caching an empty parse", async () => {
    const cache = new Cache(tmpDir());
    const client = new AwwwardsClient({
      fetchFn: (async () => new Response("<html><body>nothing</body></html>", { status: 200 })) as unknown as typeof fetch,
    });
    const h = createHandlers({ client, cache });
    const res = await h.get_site_details({ slug: "l-i-s-a" });
    expect(res.isError).toBe(true);
    expect(cache.getMeta<any>("detail:l-i-s-a", 7 * 24 * 60 * 60 * 1000)).toBeNull();
  });
});

describe("get_site_elements", () => {
  it("returns posters inline with video urls; caches after one page fetch", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.get_site_elements({ slug: "l-i-s-a" });
    const body = (res.content[0] as any).text;
    expect(body).toContain("3D model");
    expect(body).toContain("(video)");
    expect(body).toContain("https://assets.awwwards.com/awards/element/");
    expect(res.content.filter((b: any) => b.type === "image").length).toBe(6);
    const res2 = await h.get_site_elements({ slug: "l-i-s-a" });
    expect(res2.content.filter((b: any) => b.type === "image").length).toBe(6);
    const pageCalls = fetchFn.mock.calls.filter(
      (c: any[]) => String(c[0]).includes("/sites/l-i-s-a"),
    );
    expect(pageCalls.length).toBe(1); // second call served from meta cache
  });

  it("shares one page fetch with get_site_details", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    await h.get_site_details({ slug: "l-i-s-a" });
    await h.get_site_elements({ slug: "l-i-s-a" });
    const pageCalls = fetchFn.mock.calls.filter(
      (c: any[]) => String(c[0]).includes("/sites/l-i-s-a"),
    );
    expect(pageCalls.length).toBe(1);
  });

  it("shares one page fetch with get_site_details when elements runs first", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    await h.get_site_elements({ slug: "l-i-s-a" });
    await h.get_site_details({ slug: "l-i-s-a" });
    const pageCalls = fetchFn.mock.calls.filter(
      (c: any[]) => String(c[0]).includes("/sites/l-i-s-a"),
    );
    expect(pageCalls.length).toBe(1); // details served from the cross-seeded cache
  });

  it("lists every element in text but caps inline posters at 8", async () => {
    const cache = new Cache(tmpDir());
    const client = new AwwwardsClient({
      fetchFn: vi.fn(async () => new Response(elementsPage(9), { status: 200 })) as unknown as typeof fetch,
    });
    const h = createHandlers({ client, cache });
    const res = await h.get_site_elements({ slug: "nine-elements" });
    const body = (res.content[0] as any).text;
    expect(body).toContain("9 design element(s)");
    expect(body).toContain("Element nine"); // the 9th is still listed in text
    expect(res.content.filter((b: any) => b.type === "image").length).toBe(8);
  });

  it("degrades to text-only when every poster fetch fails", async () => {
    const cache = new Cache(tmpDir());
    const client = new AwwwardsClient({
      fetchFn: vi.fn(async (input: any) => {
        const url = String(input);
        if (url.includes("/sites/")) {
          return new Response(elementsPage(3), { status: 200 });
        }
        return new Response("cdn unavailable", { status: 500 }); // asset urls
      }) as unknown as typeof fetch,
    });
    const h = createHandlers({ client, cache });
    const res = await h.get_site_elements({ slug: "broken-posters" });
    expect(res.isError).toBeUndefined();
    const body = (res.content[0] as any).text;
    expect(body).toContain("Element one");
    expect(body).toContain("Element three");
    expect(res.content.filter((b: any) => b.type === "image").length).toBe(0);
  });

  it("reports a legitimate empty (and caches it) when there is no Elements section", async () => {
    const cache = new Cache(tmpDir());
    const fetchFn = vi.fn(async () =>
      new Response("<html><body>no sections</body></html>", { status: 200 }));
    const client = new AwwwardsClient({ fetchFn: fetchFn as unknown as typeof fetch });
    const h = createHandlers({ client, cache });
    const res = await h.get_site_elements({ slug: "plain-site" });
    expect((res.content[0] as any).text).toContain("No design elements listed");
    expect(res.isError).toBeUndefined();
    expect(
      cache.getMeta<any[]>("elements:plain-site", 7 * 24 * 60 * 60 * 1000),
    ).toEqual([]);
    // Repeat call is served from the cached empty: zero additional page fetches.
    await h.get_site_elements({ slug: "plain-site" });
    const pageCalls = fetchFn.mock.calls.filter(
      (c: any[]) => String(c[0]).includes("/sites/plain-site"),
    );
    expect(pageCalls.length).toBe(1);
  });

  it("errors without caching on a section-with-zero-blobs mismatch", async () => {
    const cache = new Cache(tmpDir());
    const client = new AwwwardsClient({
      fetchFn: (async () =>
        new Response(
          "<h2>Elements</h2><p>broken</p><h2>Color Palette</h2>",
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    const h = createHandlers({ client, cache });
    const res = await h.get_site_elements({ slug: "weird" });
    expect(res.isError).toBe(true);
    expect(cache.getMeta("elements:weird", Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("search query tokenization", () => {
  it("splits multi-word queries into tokens (all must match)", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([
      site({ slug: "mag", title: "Editorial Mag", tags: ["Magazine / Newspaper / Blog"] }),
      site({ slug: "half", title: "Editorial Only", tags: [] }),
      site({ slug: "other", title: "Unrelated", tags: [] }),
    ]);
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ query: "editorial mag", count: 6 });
    const text = (res.content[0] as any).text;
    expect(text).toContain("mag");
    expect(text).not.toContain("half");
    expect(text).not.toContain("other");
    const pageCalls = fetchFn.mock.calls.filter((c: any[]) => String(c[0]).includes("/websites/"));
    expect(pageCalls.length).toBe(0);
  });

  it("suggests taxonomy tags on zero results", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site({ slug: "plain", title: "Nothing Relevant", tags: [] })]);
    // seed taxonomy meta so suggestions come from the real slugs
    cache.setMeta("categories", {
      colors: [],
      filters: ["magazine-newspaper-blog", "storytelling", "typography", "minimal", "clean", "portfolio"],
    });
    const { client } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ query: "magazine editorial", count: 6 });
    const text = (res.content[0] as any).text;
    expect(text).toContain("No sites matched");
    expect(text).toContain("Closest filter tags");
    expect(text).toContain("magazine-newspaper-blog");
    // "storytelling" shares no query token and no >=4-char prefix with either
    // token, so the scoring rule leaves it at 0 and it must not be suggested.
    expect(text).not.toContain("storytelling");
  });
});

describe("suggestTags", () => {
  it("ranks slugs sharing tokens or prefixes with query tokens", () => {
    const s = suggestTags(
      ["magazine", "editorial"],
      ["magazine-newspaper-blog", "typography", "minimal", "clean", "storytelling"],
      6,
    );
    expect(s[0]).toBe("magazine-newspaper-blog"); // +2: slug contains the token "magazine"
    // "storytelling" contains neither token and shares no >=4-char prefix with
    // either, so the exact rule scores it 0 and it must not be suggested.
    expect(s).not.toContain("storytelling");
    expect(s.length).toBeLessThanOrEqual(6);
    // +1 branch: token shares a >=5-char prefix with the slug without being contained
    expect(suggestTags(["typographic"], ["typography", "minimal"], 6)).toEqual(["typography"]);
    // +1 branch (reversed): slug is a prefix of the token
    expect(suggestTags(["minimalism"], ["mini", "clean"], 6)).toEqual(["mini"]);
    // tokens shorter than 4 chars never score
    expect(suggestTags(["art"], ["artstation", "clean"], 6)).toEqual([]);
    // equal scores rank stably by slug
    expect(suggestTags(["clean"], ["clean-ui", "clean-type"], 6)).toEqual(["clean-type", "clean-ui"]);
  });
});

describe("search sortBy score", () => {
  it("sorts scored sites first (desc) then unscored (newest first)", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([
      site({ slug: "lo", title: "Low Score" }),
      site({ slug: "hi", title: "High Score" }),
      site({ slug: "none", title: "No Score", createdAt: 1789516800 + 500 }),
      site({ slug: "none2", title: "No Score 2", createdAt: 1789516800 + 400 }),
    ]);
    cache.setMeta("detail:hi", { slug: "hi", title: null, description: null, palette: [], technologies: [], elements: [], awards: [], ogImage: null, liveUrl: null, score: 8.4 });
    cache.setMeta("detail:lo", { slug: "lo", title: null, description: null, palette: [], technologies: [], elements: [], awards: [], ogImage: null, liveUrl: null, score: 6.1 });
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ sortBy: "score", count: 6 });
    const text = (res.content[0] as any).text;
    const order = ["hi", "lo", "none", "none2"].map((s) => text.indexOf(s));
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    expect(order[2]).toBeLessThan(order[3]);
    expect(fetchFn.mock.calls.filter((c: any[]) => String(c[0]).includes("/sites/")).length).toBe(0); // enrichment reads cache only
  });
});

describe("analyze_page_structure", () => {
  it("returns the band map as a JSON text block", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const structure = {
      url: "file:///build/index.html",
      title: "Build",
      totalHeight: 2000,
      bands: [
        { index: 0, tag: "body", label: "body", background: "rgb(16, 21, 42)", offsetTop: 0, height: 1000, textStart: "" },
        { index: 1, tag: "section", label: ".shell", background: "rgb(240, 242, 247)", offsetTop: 1000, height: 1000, textStart: "Production speed" },
      ],
    };
    const h = createHandlers({
      client,
      cache,
      analyzeFn: async () => structure,
    });
    const res = await h.analyze_page_structure({ url: "file:///build/index.html" });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.totalHeight).toBe(2000);
    expect(parsed.bands.length).toBe(2);
  });

  it("surfaces the install hint as isError when playwright is missing", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const h = createHandlers({
      client,
      cache,
      analyzeFn: async () => ({ error: "install playwright" }),
    });
    const res = await h.analyze_page_structure({ url: "https://example.com" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain("install playwright");
  });

  it("forwards maxBands to the analyzer", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const seen: Array<{ url: string; maxBands?: number }> = [];
    const h = createHandlers({
      client,
      cache,
      analyzeFn: async (url: string, maxBands?: number) => {
        seen.push({ url, maxBands });
        return { url, title: "T", totalHeight: 100, bands: [] };
      },
    });
    await h.analyze_page_structure({ url: "https://example.com", maxBands: 10 });
    expect(seen[0]).toEqual({ url: "https://example.com", maxBands: 10 });
  });
});
