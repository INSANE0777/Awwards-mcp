import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFacet, compactAuditResult, compactSiteDetails, createHandlers, SITE_TTL_MS, slugifyTag, suggestTags, TAXONOMY_RETRY_MS, tokenizeQuery } from "../src/server.js";
import { detailArgsSchema } from "../src/detail-schema.js";
import type { AuditUrlResult } from "../src/audit-url.js";
import type { ScrollCensus } from "../src/census.js";
import type { HoverCensus } from "../src/hover-census.js";
import type { UnifiedMotionDna } from "../src/motion-dna.js";
import type { ComponentPack } from "../src/component.js";
import { utcDayStart } from "../src/feed.js";
import { AwwwardsClient, BlockedError, RateLimiter } from "../src/awwwards.js";
import { Cache } from "../src/cache.js";
import { INDEX_LOCK_STALE_MS, INDEX_STALE_MS } from "../src/indexer.js";
import type { ElementRecord, MotionDna, SiteDetails, SiteSummary } from "../src/types.js";

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

// One parseable site card per entry: parseListing only reads the
// data-collectable-model-value JSON blob and the card's /sites/ href, so a
// trimmed page is enough to exercise the scrape → upsert → re-query path.
function listingPage(cards: Array<{ slug: string; title: string; tags?: string[] }>): string {
  return cards.map(({ slug, title, tags = [] }) => {
    const blob = JSON.stringify({
      collectableIdentifier: slug,
      collectableImage: `submissions/${slug}.jpg`,
      collectableTitle: title,
      id: 1,
      images: { thumbnail: `submissions/${slug}.jpg` },
      slug,
      title,
      createdAt: 1789516800,
      tags,
      type: "submission",
    }).replace(/\//g, "\\/").replace(/"/g, "&quot;");
    return `<li class="col-3 js-collectable" data-controller="collectable" data-collectable-model-value="${blob}">` +
      `<a href="/sites/${slug}"><span class="figure-rollover__bt" href="https://example.com/${slug}"></span></a></li>`;
  }).join("\n");
}

// Client serving a fixed listing page; every page fetch is recorded.
function clientFor(html: string) {
  const fetchFn = vi.fn(async () => new Response(html, { status: 200 }));
  const client = new AwwwardsClient({ fetchFn: fetchFn as unknown as typeof fetch });
  vi.spyOn(client, "getThumbnail").mockResolvedValue(Buffer.from("jpeg"));
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

describe("canonicalFacet", () => {
  it("runs requested and stored tags through one normalization path", () => {
    expect(canonicalFacet(" Next.js ")).toBe("next-js");
    expect(canonicalFacet("nextjs")).toBe("next-js");
    expect(canonicalFacet("next-js")).toBe("next-js");
    expect(canonicalFacet("React")).toBe("react");
    expect(canonicalFacet("React Native")).toBe("react-native");
    expect(canonicalFacet("Magazine / Newspaper / Blog")).toBe("magazine-newspaper-blog");
  });
});

describe("tokenizeQuery", () => {
  it("treats punctuation as a token boundary instead of gluing words", () => {
    expect(tokenizeQuery("next.js")).toEqual(["next", "js"]);
    expect(tokenizeQuery("editorial, magazine")).toEqual(["editorial", "magazine"]);
    // Non-ASCII letters stay whole: splitting them would turn "Léo" into
    // single-letter tokens that match nearly everything.
    expect(tokenizeQuery("Léo Parpeix")).toEqual(["léo", "parpeix"]);
  });
});

describe("search_sites", () => {
  it("keeps full by default and limits compact previews without hiding cards", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites(Array.from({ length: 8 }, (_, i) => site({
      slug: `compact-${i}`, title: `Studio ${i}`, createdAt: 1789516800 - i,
      tags: ["WebGL", "3D", "Portfolio", "Animation"],
      thumbnailPath: `submissions/compact-${i}.jpg`,
    })));
    const { client, fetchFn } = fakeClient();
    const thumbnail = vi.spyOn(client, "getThumbnail").mockResolvedValue(Buffer.from("jpeg"));
    const h = createHandlers({ client, cache });
    const compact = await h.search_sites({ tags: ["webgl"], count: 6, responseMode: "compact" });
    const body = (compact.content[0] as { type: "text"; text: string }).text;
    expect(body).toContain("8 site(s) matched; showing 1-6");
    for (let i = 0; i < 6; i++) expect(body).toContain(`${i + 1}. Studio ${i} (slug: compact-${i})`);
    expect(body).toContain("WebGL, 3D, Portfolio +1");
    expect(compact.content.filter((block) => block.type === "image")).toHaveLength(2);
    expect(compact.content.slice(1).filter((block) => block.type === "text")
      .map((block) => (block as { type: "text"; text: string }).text))
      .toEqual(["Preview #1: compact-0", "Preview #2: compact-1"]);
    expect(thumbnail.mock.calls.map(([path]) => path)).toEqual([
      "submissions/compact-0.jpg", "submissions/compact-1.jpg",
    ]);
    expect(fetchFn).not.toHaveBeenCalled();

    const full = await h.search_sites({ tags: ["webgl"], count: 6 });
    expect(full.content).toEqual([
      { type: "text", text: "8 site(s) matched; showing 1-6:\n\n" +
        Array.from({ length: 6 }, (_, i) =>
          `- Studio ${i} (slug: compact-${i}) [Site of the Day]\n` +
          "  live: https://example.com\n" +
          "  awwwards: https://www.awwwards.com/sites/s1\n" +
          "  tags: WebGL, 3D, Portfolio, Animation",
        ).join("\n\n"),
      },
      ...Array.from({ length: 6 }, () => ({
        type: "image", data: Buffer.from("jpeg").toString("base64"), mimeType: "image/jpeg",
      })),
    ]);
  });

  it("keeps untrusted multiline metadata on one compact card line", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([
      site({
        slug: "unsafe", title: "Studio\n2. Forged\tTitle", createdAt: 1789516801,
        liveUrl: "https://example.com/\n3. forged", awards: ["Site\r\nof the Day"],
        tags: ["Web\nGL", "3D\tMotion"], thumbnailPath: "submissions/unsafe.jpg",
      }),
      site({ slug: "real", title: "Real Studio", createdAt: 1789516800,
        thumbnailPath: "submissions/real.jpg" }),
    ]);
    const { client } = fakeClient();
    vi.spyOn(client, "getThumbnail").mockResolvedValue(Buffer.from("jpeg"));
    const h = createHandlers({ client, cache });
    const compact = await h.search_sites({ count: 2, responseMode: "compact" });
    expect((compact.content[0] as { type: "text"; text: string }).text).toBe(
      "2 site(s) matched; showing 1-2:\n\n" +
      "1. Studio 2. Forged Title (slug: unsafe) | live: https://example.com/ 3. forged | " +
      "awards: Site of the Day | tags: Web GL, 3D Motion\n" +
      "2. Real Studio (slug: real) | live: https://example.com | " +
      "awards: Site of the Day | tags: WebGL, 3D",
    );
    const full = await h.search_sites({ count: 2 });
    expect((full.content[0] as { type: "text"; text: string }).text)
      .toContain("- Studio\n2. Forged\tTitle (slug: unsafe) [Site\r\nof the Day]");
  });

  it("previews the selected score-sorted page, not page one", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites(Array.from({ length: 8 }, (_, i) => site({
      slug: `rank-${i}`, createdAt: 1789516800 + i,
      thumbnailPath: `submissions/rank-${i}.jpg`,
    })));
    for (let i = 0; i < 8; i++) cache.setMeta(`detail:rank-${i}`, { score: i });
    const { client, fetchFn } = fakeClient();
    const thumbnail = vi.spyOn(client, "getThumbnail").mockResolvedValue(Buffer.from("jpeg"));
    const res = await createHandlers({ client, cache }).search_sites({
      count: 3, page: 2, sortBy: "score", responseMode: "compact",
    });
    const body = (res.content[0] as { type: "text"; text: string }).text;
    expect(body).toContain("showing 4-6");
    expect(body).toContain("4. Cool Studio (slug: rank-4)");
    expect(res.content.filter((block) => block.type === "image")).toHaveLength(2);
    expect(thumbnail.mock.calls.map(([path]) => path)).toEqual([
      "submissions/rank-4.jpg", "submissions/rank-3.jpg",
    ]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("keeps the second card when its first preview fails", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site({ slug: "first", createdAt: 1789516801, thumbnailPath: "submissions/first.jpg" }),
      site({ slug: "second", createdAt: 1789516800, thumbnailPath: "submissions/second.jpg" })]);
    const { client } = fakeClient();
    vi.spyOn(client, "getThumbnail").mockImplementation(async (path) => {
      if (path === "submissions/first.jpg") throw new Error("CDN unavailable");
      return Buffer.from("jpeg");
    });
    const res = await createHandlers({ client, cache }).search_sites({ count: 2, responseMode: "compact" });
    const body = (res.content[0] as { type: "text"; text: string }).text;
    expect(body).toContain("1. Cool Studio (slug: first)");
    expect(body).toContain("2. Cool Studio (slug: second)");
    expect(res.content.slice(1).filter((block) => block.type === "text")
      .map((block) => (block as { type: "text"; text: string }).text))
      .toEqual(["Preview #2: second"]);
    expect(res.content.filter((block) => block.type === "image")).toHaveLength(1);
  });

  it("supports a single compact match", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site({ slug: "single" })]);
    const { client } = fakeClient();
    vi.spyOn(client, "getThumbnail").mockResolvedValue(Buffer.from("jpeg"));
    const res = await createHandlers({ client, cache }).search_sites({ count: 1, responseMode: "compact" });
    expect((res.content[0] as { type: "text"; text: string }).text).toContain("1. Cool Studio (slug: single)");
    expect(res.content.filter((block) => block.type === "image")).toHaveLength(1);
  });

  it("keeps zero-result guidance unchanged in compact mode", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const h = createHandlers({ client, cache });
    const full = await h.search_sites({ query: "unfindabletopicword" });
    const compact = await h.search_sites({ query: "unfindabletopicword", responseMode: "compact" });
    expect((compact.content[0] as { type: "text"; text: string }).text)
      .toContain("No sites matched the search");
    expect(compact.content).toEqual(full.content);
    expect(compact.content.filter((block) => block.type === "image")).toHaveLength(0);
  });

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

  it("keeps the stale warning but inlines only two compact fallback images", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites(Array.from({ length: 4 }, (_, i) => site({
      slug: `stale-${i}`, createdAt: 1789516800 - i,
      thumbnailPath: `submissions/stale-${i}.jpg`,
    })));
    const client = new AwwwardsClient({
      fetchFn: vi.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch,
      rateLimiter: new RateLimiter(0),
    });
    const thumbnail = vi.spyOn(client, "getThumbnail").mockResolvedValue(Buffer.from("jpeg"));
    const res = await createHandlers({ client, cache }).search_sites({
      count: 6, page: 2, responseMode: "compact",
    });
    expect(res.isError).toBeUndefined();
    const body = (res.content[0] as { type: "text"; text: string }).text;
    expect(body).toContain("Serving 4 result(s) from stale cache instead:");
    expect(body).toContain("(slug: stale-3)");
    expect(res.content.slice(1).filter((block) => block.type === "text")
      .map((block) => (block as { type: "text"; text: string }).text))
      .toEqual(["Preview #1: stale-0", "Preview #2: stale-1"]);
    expect(res.content.filter((block) => block.type === "image")).toHaveLength(2);
    // compactContent fetches previews in card order (sequential by design),
    // so the spy's recorded order is deterministic — pin it exactly.
    expect(thumbnail.mock.calls.map(([path]) => path)).toEqual([
      "submissions/stale-0.jpg", "submissions/stale-1.jpg",
    ]);
  });

  it("keeps a partially filled compact page when its top-up fails", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites(Array.from({ length: 4 }, (_, i) => site({
      slug: `partial-${i}`, createdAt: 1789516800 - i,
      thumbnailPath: `submissions/partial-${i}.jpg`,
    })));
    const client = new AwwwardsClient({
      fetchFn: vi.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch,
      rateLimiter: new RateLimiter(0),
    });
    const thumbnail = vi.spyOn(client, "getThumbnail").mockResolvedValue(Buffer.from("jpeg"));
    const res = await createHandlers({ client, cache }).search_sites({
      count: 3, page: 2, responseMode: "compact",
    });
    const body = (res.content[0] as { type: "text"; text: string }).text;
    expect(body).toContain("4 site(s) matched; showing 4-4:");
    expect(body).toContain("4. Cool Studio (slug: partial-3)");
    expect(body).not.toContain("stale cache instead");
    expect(thumbnail.mock.calls.map(([path]) => path)).toEqual(["submissions/partial-3.jpg"]);
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

  it("includes the jury score line when present", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.get_site_details({ slug: "l-i-s-a" });
    // the l-i-s-a fixture (detail.html) has a c-heading-score block
    expect((res.content[0] as any).text).toMatch(/Jury score: \d\.\d{1,2}\/10/);
  });
});

describe("get_site_details batch", () => {
  // Minimal awarded-page shape: parseDetail needs a non-empty palette,
  // technologies or description to treat the parse as real content.
  function detailPage(slug: string): string {
    return [
      `<meta property="og:title" content="Site ${slug}">`,
      `<meta property="og:description" content="About ${slug}">`,
      `<meta property="og:image" content="https://cdn.test/${slug}.jpg">`,
      "<strong>HEX</strong> #AABBCC",
      '<h2>Technologies & Tools</h2><a class="button button--tag">WebGL</a>',
    ].join("\n");
  }

  it("returns one ordered entry per slug and reports cache hits", async () => {
    const cache = new Cache(tmpDir());
    const client = new AwwwardsClient({ rateLimiter: new RateLimiter(0) });
    const getHtml = vi.spyOn(client, "getHtml").mockImplementation(async (path: string) =>
      detailPage(path.split("/sites/")[1] ?? ""));
    const h = createHandlers({ client, cache });

    const first = await h.get_site_details({ slugs: ["a", "b", "c"] });
    expect(first.isError).toBeUndefined();
    expect(first.content).toHaveLength(1);
    expect(first.content.filter((block) => block.type === "image")).toHaveLength(0);
    const parsed = JSON.parse((first.content[0] as any).text);
    expect(parsed.results.map((r: any) => r.slug)).toEqual(["a", "b", "c"]);
    expect(parsed.results.every((r: any) => r.status === "fetched")).toBe(true);
    expect(parsed.summary).toEqual({ requested: 3, fetched: 3, cached: 0, failed: 0, skipped: 0 });
    expect(parsed.blocked).toBeUndefined();
    expect(getHtml).toHaveBeenCalledTimes(3);

    const again = await h.get_site_details({ slugs: ["a", "b", "c"] });
    const cached = JSON.parse((again.content[0] as any).text);
    expect(cached.results.every((r: any) => r.status === "cached")).toBe(true);
    expect(cached.summary).toEqual({ requested: 3, fetched: 0, cached: 3, failed: 0, skipped: 0 });
    expect(getHtml).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(cached)).not.toContain("base64");
  });

  it("rejects both slug and slugs, neither, duplicates, bad shapes and more than 10", async () => {
    const cache = new Cache(tmpDir());
    const client = new AwwwardsClient({ rateLimiter: new RateLimiter(0) });
    const getHtml = vi.spyOn(client, "getHtml").mockRejectedValue(new Error("offline"));
    const h = createHandlers({ client, cache });
    const invalid = [
      { slug: "a", slugs: ["b"] },
      {},
      { slugs: ["a", "A"] },
      { slugs: Array.from({ length: 11 }, (_, i) => `s${i}`) },
      { slugs: [] },
      { slugs: ["../bad"] },
      { slugs: ["a", 1] },
      { slug: "" },
      { slugs: "a" },
    ];
    for (const args of invalid) {
      const res = await h.get_site_details(args as any);
      expect(res.isError).toBe(true);
    }
    expect(getHtml).not.toHaveBeenCalled();
  });

  it("stops on block and marks the rest skipped", async () => {
    const cache = new Cache(tmpDir());
    const client = new AwwwardsClient({ rateLimiter: new RateLimiter(0) });
    const getHtml = vi.spyOn(client, "getHtml").mockImplementation(async (path: string) => {
      if (path.includes("/sites/b")) {
        throw new BlockedError("https://www.awwwards.com/sites/b", 429);
      }
      return detailPage("a");
    });
    const h = createHandlers({ client, cache });
    const res = await h.get_site_details({ slugs: ["a", "b", "c"] });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.results.map((r: any) => r.status)).toEqual(["fetched", "error", "skipped"]);
    expect(parsed.results[1]).toMatchObject({ status: "error", blocked: true });
    expect(parsed.results[2]).toMatchObject({
      status: "skipped", error: "blocked-before-request", blocked: true,
    });
    expect(parsed.summary).toEqual({ requested: 3, fetched: 1, cached: 0, failed: 1, skipped: 1 });
    expect(parsed.blocked).toBe(true);
    expect(getHtml).toHaveBeenCalledTimes(2);
  });

  it("keeps fetching after a per-slug failure and counts it", async () => {
    const cache = new Cache(tmpDir());
    const client = new AwwwardsClient({ rateLimiter: new RateLimiter(0) });
    const getHtml = vi.spyOn(client, "getHtml").mockImplementation(async (path: string) => {
      if (path.includes("/sites/b")) throw new Error("HTTP 500 for https://www.awwwards.com/sites/b");
      return detailPage(path.split("/sites/")[1] ?? "");
    });
    const h = createHandlers({ client, cache });
    const res = await h.get_site_details({ slugs: ["a", "b", "c"] });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.results.map((r: any) => r.status)).toEqual(["fetched", "error", "fetched"]);
    expect(parsed.results[1]).toMatchObject({
      slug: "b", status: "error", error: "HTTP 500 for https://www.awwwards.com/sites/b",
    });
    expect(parsed.summary).toEqual({ requested: 3, fetched: 2, cached: 0, failed: 1, skipped: 0 });
    expect(parsed.blocked).toBeUndefined();
    expect(getHtml).toHaveBeenCalledTimes(3);
  });

  it("errors only when every requested slug fails", async () => {
    const cache = new Cache(tmpDir());
    const client = new AwwwardsClient({ rateLimiter: new RateLimiter(0) });
    const getHtml = vi.spyOn(client, "getHtml")
      .mockResolvedValue("<html><body>nothing</body></html>");
    const h = createHandlers({ client, cache });
    const slugs = ["a", "b", "c"];
    const res = await h.get_site_details({ slugs });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.results).toHaveLength(slugs.length);
    expect(parsed.results.every((r: any) => r.status === "error")).toBe(true);
    expect(parsed.results.every((r: any) => r.blocked === undefined)).toBe(true);
    expect(parsed.summary).toEqual({ requested: 3, fetched: 0, cached: 0, failed: 3, skipped: 0 });
    expect(parsed.blocked).toBeUndefined();
    expect(getHtml).toHaveBeenCalledTimes(3);
  });

  it("fetches a full 10-slug batch", async () => {
    const cache = new Cache(tmpDir());
    const client = new AwwwardsClient({ rateLimiter: new RateLimiter(0) });
    const getHtml = vi.spyOn(client, "getHtml").mockImplementation(async (path: string) =>
      detailPage(path.split("/sites/")[1] ?? ""));
    const h = createHandlers({ client, cache });
    const slugs = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const res = await h.get_site_details({ slugs });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.results.map((r: any) => r.slug)).toEqual(slugs);
    expect(parsed.results.every((r: any) => r.status === "fetched")).toBe(true);
    expect(parsed.summary).toEqual({ requested: 10, fetched: 10, cached: 0, failed: 0, skipped: 0 });
    expect(getHtml).toHaveBeenCalledTimes(10);
  });

  it("returns compactSiteDetails output per entry", async () => {
    const cache = new Cache(tmpDir());
    const client = new AwwwardsClient({ rateLimiter: new RateLimiter(0) });
    vi.spyOn(client, "getHtml").mockImplementation(async (path: string) =>
      detailPage(path.split("/sites/")[1] ?? ""));
    const h = createHandlers({ client, cache });
    const res = await h.get_site_details({ slugs: ["a", "b"] });
    const parsed = JSON.parse((res.content[0] as any).text);
    const detail = cache.getMeta<SiteDetails>("detail:a", 7 * 24 * 60 * 60 * 1000);
    expect(detail).not.toBeNull();
    expect(parsed.results[0].details).toEqual(compactSiteDetails(detail!));
  });
});

describe("get_site_details schema", () => {
  it("enforces exactly one of slug or slugs, the 1–10 bound and distinctness", () => {
    const ok = (args: unknown) => detailArgsSchema.safeParse(args).success;
    expect(ok({ slugs: ["a"] })).toBe(true);
    expect(ok({ slug: "a" })).toBe(true);
    expect(ok({ slugs: Array.from({ length: 10 }, (_, i) => `s${i}`) })).toBe(true);
    expect(ok({})).toBe(false);
    expect(ok({ slug: "a", slugs: ["b"] })).toBe(false);
    expect(ok({ slugs: [] })).toBe(false);
    expect(ok({ slugs: ["a", "a"] })).toBe(false);
    expect(ok({ slugs: ["a", "A"] })).toBe(false);
    expect(ok({ slugs: Array.from({ length: 11 }, (_, i) => `s${i}`) })).toBe(false);
  });
});

describe("compare_sites", () => {
  it("compares cached details and summary fallbacks without any HTTP or CDN requests", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site({ slug: "first", title: "Fallback title", liveUrl: "https://fallback.test", awards: ["Site of the Day"] })]);
    const base = {
      title: null, description: null, palette: ["#123456"], technologies: ["WebGL"],
      elements: ["3D"], awards: [], score: 7.5, ogImage: null, liveUrl: null, nominee: false,
    };
    cache.setMeta("detail:first", { ...base, slug: "first", juryDimensions: { design: 8, usability: 7, creativity: 9, content: 6 } });
    cache.setMeta("detail:second", { ...base, slug: "second", title: "Second", liveUrl: "https://second.test", awards: [{ title: "Developer Award", date: "2026-09-01" }] });
    cache.setMeta("detail:third", { ...base, slug: "third", title: "Third", score: null });
    const { client, fetchFn } = fakeClient();
    const res = await createHandlers({ client, cache }).compare_sites({ slugs: ["first", "second", "third"] });
    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(1);
    const { sites } = JSON.parse((res.content[0] as any).text);
    expect(sites.map((s: any) => s.slug)).toEqual(["first", "second", "third"]);
    expect(sites[0]).toMatchObject({
      title: "Fallback title", liveUrl: "https://fallback.test", palette: ["#123456"],
      technologies: ["WebGL"], elements: ["3D"], awards: [{ title: "Site of the Day", date: "" }],
      score: 7.5, juryDimensions: { design: 8, usability: 7, creativity: 9, content: 6 },
    });
    expect(sites[1]).toMatchObject({ title: "Second", liveUrl: "https://second.test", awards: [{ title: "Developer Award", date: "2026-09-01" }] });
    expect(sites[2].juryDimensions).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fetches only missing details from /sites/{slug}, seeds elements, then serves cache", async () => {
    const cache = new Cache(tmpDir());
    cache.setMeta("detail:cached", {
      slug: "cached", title: "Cached", description: "hello", palette: [], technologies: [],
      elements: [], awards: [], score: null, ogImage: null, liveUrl: null,
    });
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const first = await h.compare_sites({ slugs: ["cached", "l-i-s-a"] });
    expect(first.isError).toBeUndefined();
    const { sites } = JSON.parse((first.content[0] as any).text);
    expect(sites[1].palette.length).toBeGreaterThan(0);
    expect(sites[1].technologies).toContain("WebGL");
    expect(sites[1].score).toBeGreaterThan(0);
    expect(cache.getMeta<any[]>("elements:l-i-s-a", SITE_TTL)).not.toBeNull();
    await h.compare_sites({ slugs: ["l-i-s-a", "cached"] });
    await h.get_site_details({ slug: "l-i-s-a" });
    expect(fetchFn.mock.calls.map((call: any[]) => String(call[0]))).toEqual(["https://www.awwwards.com/sites/l-i-s-a"]);
  });

  it("fetches each missing slug once and shares parsed details with get_site_details", async () => {
    const cache = new Cache(tmpDir());
    const html = readFileSync(join(FIXTURES, "detail.html"), "utf8");
    const fetchFn = vi.fn(async () => new Response(html, { status: 200 }));
    const client = new AwwwardsClient({ fetchFn: fetchFn as unknown as typeof fetch });
    const h = createHandlers({ client, cache });
    const res = await h.compare_sites({ slugs: ["one", "two"] });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse((res.content[0] as any).text).sites).toHaveLength(2);
    await h.get_site_details({ slug: "one" });
    await h.compare_sites({ slugs: ["two", "one"] });
    expect(fetchFn.mock.calls.map((call: any[]) => String(call[0]))).toEqual([
      "https://www.awwwards.com/sites/one", "https://www.awwwards.com/sites/two",
    ]);
  });

  it("rejects invalid counts, duplicates and unsafe slugs before accessing cache or network", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    for (const slugs of [["one"], ["a", "b", "c", "d"], ["a", "A"], ["good", "../bad"], ["good", "bad?x=1"], ["good", ""]]) {
      const res = await h.compare_sites({ slugs });
      expect(res.isError).toBe(true);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports an all-empty parse without caching it or fetching images", async () => {
    const cache = new Cache(tmpDir());
    const fetchFn = vi.fn(async () => new Response("<html>layout drift</html>", { status: 200 }));
    const client = new AwwwardsClient({ fetchFn: fetchFn as unknown as typeof fetch });
    cache.setMeta("detail:cached", { slug: "cached", title: "Cached", description: "ok", palette: [], technologies: [], elements: [], awards: [], score: null, ogImage: null, liveUrl: null });
    const res = await createHandlers({ client, cache }).compare_sites({ slugs: ["cached", "broken"] });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain("broken");
    expect(cache.getMeta("detail:broken", SITE_TTL)).toBeNull();
    expect(cache.getMeta("elements:broken", SITE_TTL)).toBeNull();
    expect(fetchFn.mock.calls.map((call: any[]) => String(call[0]))).toEqual(["https://www.awwwards.com/sites/broken"]);
  });

  it("compares a nominee with an awarded site and reports nominee status", async () => {
    const cache = new Cache(tmpDir());
    const fetchFn = vi.fn(async (url: any) =>
      new Response(
        String(url).includes("/sites/brandon-yasin")
          ? "<div class=\"c-heading text-center\"> <div class=\"c-heading__top\"> <h2 class=\"text-default\">Nominee - Sep 23, 2026</h2></div></div><meta property=\"og:title\" content=\"Brandon Yasin\" /><meta property=\"og:image\" content=\"https://s.awwwards.com/shot.jpg\" />"
          : readFileSync(join(FIXTURES, "detail.html"), "utf8"),
        { status: 200 },
      ));
    const client = new AwwwardsClient({ fetchFn: fetchFn as unknown as typeof fetch });
    const h = createHandlers({ client, cache });
    const res = await h.compare_sites({ slugs: ["brandon-yasin", "l-i-s-a"] });
    expect(res.isError).toBeUndefined();
    const { sites } = JSON.parse((res.content[0] as any).text);
    expect(sites[0].nominee).toBe(true);
    expect(sites[0].title).toBe("Brandon Yasin");
    expect(sites[0].liveUrl).toBeNull();
    expect(sites[1].nominee).toBe(false);
    expect(sites[1].palette.length).toBeGreaterThan(0);
    // The nominee parse is real content, so the second call is cache-only.
    await h.compare_sites({ slugs: ["brandon-yasin", "l-i-s-a"] });
    const pageCalls = fetchFn.mock.calls.filter((c: any[]) => String(c[0]).includes("/sites/"));
    expect(pageCalls.length).toBe(2);
  });

  it("still rejects parser drift on an awarded page during comparison", async () => {
    const cache = new Cache(tmpDir());
    const client = new AwwwardsClient({
      fetchFn: (async () => new Response("<html><body>nothing</body></html>", { status: 200 })) as unknown as typeof fetch,
    });
    const res = await createHandlers({ client, cache }).compare_sites({ slugs: ["a-one", "b-two"] });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain("layout may have changed");
  });
});

const SITE_TTL = 7 * 24 * 60 * 60 * 1000;

describe("create_design_brief", () => {
  const cachedDetail = (slug: string, liveUrl: string | null = `https://${slug}.example`) => ({
    slug, title: slug, description: null, palette: ["#111111"], technologies: ["GSAP"],
    elements: ["Cursor"], awards: [], nominee: false, score: null, ogImage: null, liveUrl,
  });

  it("rejects invalid direct-handler input before cache or network access", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = fakeClient();
    const result = await createHandlers({ client, cache }).create_design_brief({ slugs: ["bad slug", "bad slug"], goal: "   " });
    expect(result.isError).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toContain("distinct valid site slugs");
  });

  it("uses fresh cached details and cached Motion DNA without fetching or invoking structure", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site({ slug: "alpha", title: "Alpha", liveUrl: "https://alpha.example" }), site({ slug: "beta", title: "Beta", liveUrl: "https://beta.example" })]);
    for (const slug of ["alpha", "beta"]) cache.setMeta(`detail:${slug}`, cachedDetail(slug));
    cache.upsertMotionDna({
      url: "https://alpha.example", stack: { libs: ["gsap"], render: [], scrollModel: "native" },
      scroll: { triggerCount: 0, scrubCount: 0, pinCount: 0, scrubRatio: 0, sample: [] },
      easingVocab: [], durationVocab: null, capturedAt: Date.now(),
    });
    const { client, fetchFn } = fakeClient();
    const analyzeFn = vi.fn();
    const result = await createHandlers({ client, cache, analyzeFn, motionDnaFn: vi.fn() }).create_design_brief({ slugs: ["alpha", "beta"], goal: "a studio site" });
    expect(result.isError).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(analyzeFn).not.toHaveBeenCalled();
    const rendered = (result.content[0] as { text: string }).text;
    expect(rendered).toContain("gsap");
    expect(rendered).toContain("motion cached");
  });

  it("fetches cache misses and preserves partial source failures", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site({ slug: "l-i-s-a", liveUrl: "https://lisa.locomotive.ca/en" }), site({ slug: "missing" })]);
    const { client } = fakeClient();
    const getHtml = vi.spyOn(client, "getHtml").mockImplementation(async (path: string) => {
      if (path.includes("/sites/missing")) throw new Error("offline");
      return readFileSync(join(FIXTURES, "detail.html"), "utf8");
    });
    const result = await createHandlers({ client, cache }).create_design_brief({ slugs: ["l-i-s-a", "missing"], goal: "a portfolio" });
    expect(result.isError).toBeUndefined();
    expect(getHtml).toHaveBeenCalledTimes(2);
    expect((result.content[0] as { text: string }).text).toContain("Evidence and limitations");
    expect((result.content[0] as { text: string }).text).toContain("missing");
  });

  it("returns isError only when every reference is unavailable", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    vi.spyOn(client, "getHtml").mockRejectedValue(new Error("offline"));
    const result = await createHandlers({ client, cache }).create_design_brief({ slugs: ["alpha", "beta"], goal: "a gallery" });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("No usable design evidence");
  });

  it("runs optional structure only on usable live URLs and isolates per-source failure", async () => {
    const cache = new Cache(tmpDir());
    cache.setMeta("detail:alpha", cachedDetail("alpha"));
    cache.setMeta("detail:beta", cachedDetail("beta", "https://beta.example"));
    const { client, fetchFn } = fakeClient();
    const analyzeFn = vi.fn(async (url: string) => url.includes("alpha")
      ? { url, title: "Alpha", totalHeight: 800, bands: [] }
      : { error: "Install playwright" });
    const handlers = createHandlers({ client, cache, analyzeFn });
    const result = await handlers.create_design_brief({ slugs: ["alpha", "beta"], goal: "a gallery", includeStructure: true });
    expect(result.isError).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(analyzeFn).toHaveBeenCalledTimes(2);
    expect((result.content[0] as { text: string }).text).toContain("beta");
  });
});


  it("reports a never-indexed cache without any network calls", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = fakeClient();
    const res = await createHandlers({ client, cache }).get_index_status();
    expect(res.isError).toBeUndefined();
    expect(JSON.parse((res.content[0] as any).text)).toEqual({
      sitesCount: 0, progress: { pagesDone: 0, pagesTotal: 0 },
      lastSuccessfulFinishAt: null, lastError: null,
      lock: { startedAt: null, active: false, stale: false },
      indexFreshness: { stale: true, ageMs: null, staleAfterMs: INDEX_STALE_MS },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("shows cached taxonomy total during the first crawl before status exists", async () => {
    const cache = new Cache(tmpDir());
    cache.setMeta("categories", { colors: [], filters: ["3d", "webgl", "studio"] });
    cache.setMeta("index:progress", ["3d"]);
    cache.setMeta("index:lock", { startedAt: Date.now() });
    const { client, fetchFn } = fakeClient();
    const res = await createHandlers({ client, cache }).get_index_status();
    expect(JSON.parse((res.content[0] as any).text)).toMatchObject({
      progress: { pagesDone: 1, pagesTotal: 3 },
      lastSuccessfulFinishAt: null, lock: { active: true },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("uses completed status after the progress checkpoint is cleared", async () => {
    const cache = new Cache(tmpDir());
    cache.setMeta("index:status", { finishedAt: Date.now(), pagesDone: 3, pagesTotal: 3 });
    const { client, fetchFn } = fakeClient();
    const res = await createHandlers({ client, cache }).get_index_status();
    expect(cache.getMeta("index:progress", Number.POSITIVE_INFINITY)).toBeNull();
    expect(JSON.parse((res.content[0] as any).text)).toMatchObject({
      progress: { pagesDone: 3, pagesTotal: 3 }, indexFreshness: { stale: false },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("shows the new crawl at zero immediately after acquiring a lock", async () => {
    const cache = new Cache(tmpDir());
    cache.setMeta("categories", { colors: [], filters: ["3d", "webgl", "studio", "portfolio"] });
    cache.setMeta("index:status", { finishedAt: Date.now() - INDEX_STALE_MS, pagesDone: 3, pagesTotal: 3 });
    cache.setMeta("index:lock", { startedAt: Date.now() });
    const { client, fetchFn } = fakeClient();
    const res = await createHandlers({ client, cache }).get_index_status();
    expect(JSON.parse((res.content[0] as any).text)).toMatchObject({
      progress: { pagesDone: 0, pagesTotal: 4 },
      lock: { active: true }, indexFreshness: { stale: true },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reads persisted counts, progress, errors, lock and freshness offline", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site({ slug: "a" }), site({ slug: "b" })]);
    const finishedAt = Date.now() - 1000;
    cache.setMeta("index:status", { finishedAt, pagesDone: 1, pagesTotal: 3, lastError: "blocked" });
    cache.setMeta("index:progress", ["3d", "webgl"]);
    cache.setMeta("index:lock", { startedAt: Date.now() - 1000 });
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const currentResult = await h.get_index_status();
    const current = JSON.parse((currentResult.content[0] as any).text);
    expect(current).toMatchObject({
      sitesCount: 2, progress: { pagesDone: 2, pagesTotal: 3 },
      lastSuccessfulFinishAt: finishedAt, lastError: "blocked",
      lock: { active: true, stale: false }, indexFreshness: { stale: false },
    });
    cache.setMeta("index:status", { finishedAt: Date.now() - INDEX_STALE_MS, pagesDone: 3, pagesTotal: 3 });
    cache.setMeta("index:lock", { startedAt: Date.now() - INDEX_LOCK_STALE_MS });
    const old = await h.get_index_status();
    const stale = JSON.parse((old.content[0] as any).text);
    expect(stale.lock).toMatchObject({ active: false, stale: true });
    expect(stale.indexFreshness.stale).toBe(true);
    expect(stale.lastError).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
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
    const warm = await h.list_categories(); // second call is served from the meta cache
    expect(JSON.parse((warm.content[0] as any).text)).toEqual(parsed);
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

  it("returns text-only when inline is disabled", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const h = createHandlers({
      client,
      cache,
      captureFn: async (_url: string, imagesDir: string) => ({
        file: join(imagesDir, "big.png"),
        inlineOmitted: true,
      }),
    });
    const res = await h.capture_live_site({ url: "https://example.com", inline: false });
    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(1);
    expect((res.content[0] as any).text).toContain("Full-page capture of https://example.com saved to");
    expect((res.content[0] as any).text).toContain("(inline preview disabled; open the saved file)");
    expect((res.content[0] as any).text).not.toContain("pass inline:true");
  });

  it("explains an automatic omission and how to raise the budget", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const h = createHandlers({
      client,
      cache,
      captureFn: async (_url: string, imagesDir: string) => ({
        file: join(imagesDir, "big.png"),
        inlineOmitted: true,
      }),
    });
    const res = await h.capture_live_site({ url: "https://example.com" });
    const text = (res.content[0] as any).text;
    expect(text).toContain(
      "(inline preview omitted: the PNG exceeds the 2.5 MB inline budget; open the saved file or raise maxInlineBytes)",
    );
    expect(text).not.toContain("pass inline:true");
  });

  it("reports the custom maxInlineBytes budget in the omission message", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const h = createHandlers({
      client,
      cache,
      captureFn: async (_url: string, imagesDir: string) => ({
        file: join(imagesDir, "big.png"),
        inlineOmitted: true,
      }),
    });
    const res = await h.capture_live_site({ url: "https://example.com", maxInlineBytes: 1_000_000 });
    expect((res.content[0] as any).text).toContain("the PNG exceeds the 1 MB inline budget");
  });

  it("returns text+image when base64 is present and threads inline:false/maxInlineBytes", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const seen: Array<{ inline?: boolean; maxInlineBytes?: number } | undefined> = [];
    const h = createHandlers({
      client,
      cache,
      captureFn: async (_url: string, imagesDir: string, opts?: { inline?: boolean; maxInlineBytes?: number }) => {
        seen.push(opts);
        return { file: join(imagesDir, "shot.png"), base64: Buffer.from("png").toString("base64") };
      },
    });
    const withImage = await h.capture_live_site({ url: "https://example.com" });
    expect(withImage.content.filter((block) => block.type === "image")).toHaveLength(1);
    await h.capture_live_site({ url: "https://example.com", inline: false, maxInlineBytes: 1234 });
    expect(seen[1]).toMatchObject({ inline: false, maxInlineBytes: 1234 });
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

  it("get_site_details returns nominee data instead of a parser-drift error", async () => {
    const cache = new Cache(tmpDir());
    const client = new AwwwardsClient({
      fetchFn: (async () => new Response("<div class=\"c-heading text-center\"> <div class=\"c-heading__top\"> <h2 class=\"text-default\">Nominee - Sep 23, 2026</h2></div></div><meta property=\"og:title\" content=\"Brandon Yasin\" /><meta property=\"og:image\" content=\"https://s.awwwards.com/shot.jpg\" />", { status: 200 })) as unknown as typeof fetch,
    });
    const h = createHandlers({ client, cache });
    const res = await h.get_site_details({ slug: "brandon-yasin" });
    expect(res.isError).toBeFalsy();
    const body = (res.content[0] as any).text;
    expect(body).toContain("Brandon Yasin");
    expect(body).toContain("Nominee");
    expect(cache.getMeta<any>("detail:brandon-yasin", 7 * 24 * 60 * 60 * 1000)).toBeTruthy();
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

describe("compactSiteDetails (D2 grab-bag)", () => {
  const details = (over: Partial<SiteDetails> = {}): SiteDetails => ({
    slug: "s",
    title: "T",
    description: "x".repeat(600),
    palette: ["#111111"],
    technologies: ["WebGL"],
    elements: [],
    awards: [],
    nominee: false,
    score: 8,
    juryDimensions: { design: 8, usability: 7, creativity: 9, content: 6 },
    ogImage: null,
    liveUrl: null,
    ...over,
  });

  it("restores description to the compact diet, clamped at 500 chars (null stays null)", () => {
    const c = compactSiteDetails(details()) as Record<string, unknown>;
    expect(c.description).toHaveLength(500);
    // the list→counts diet is untouched
    expect(c.paletteCount).toBe(1);
    expect(c.technologiesCount).toBe(1);
    expect(c.elementsCount).toBe(0);
    expect(compactSiteDetails(details({ description: null })).description).toBeNull();
    expect(compactSiteDetails(details({ description: "short brief" })).description).toBe("short brief");
  });
});

describe("search query tokenization", () => {
  it("merges a top-up scrape into a partially filled window instead of replacing it", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([
      site({ slug: "ed1", title: "Editorial Thing 1", tags: [], createdAt: 1789516800 }),
      site({ slug: "ed2", title: "Editorial Thing 2", tags: [], createdAt: 1789516800 + 1 }),
      site({ slug: "ed3", title: "Editorial Thing 3", tags: [], createdAt: 1789516800 + 2 }),
    ]);
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    // 3 verified cache matches < count*page (6): the window is partial. The
    // old no-scrape behavior under-served (returned 3 forever); the old
    // REPLACE behavior scraped and discarded the verified rows (returned 0 —
    // no fixture title matches "editorial"). The merge path must scrape AND
    // keep the cache rows.
    const res = await h.search_sites({ query: "editorial", count: 6 });
    expect(String(fetchFn.mock.calls[0][0])).toContain("/websites/"); // top-up scrape fired
    const text = (res.content[0] as any).text;
    // The verified cache rows survive the merge...
    expect(text).toContain("ed1");
    expect(text).toContain("ed2");
    expect(text).toContain("ed3");
    // ...while the scraped fixture-only rows are client-filtered out.
    expect(text).not.toContain("l-i-s-a");
  });

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
    // 1 verified cache match < 6 → partial window → a top-up scrape fires, but
    // every scraped row fails the all-tokens check, so only the cache row serves.
    const pageCalls = fetchFn.mock.calls.filter((c: any[]) => String(c[0]).includes("/websites/"));
    expect(pageCalls.length).toBe(1);
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

  it("matches multi-word queries against the FTS cache (historical failure)", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site({ slug: "mag", title: "Editorial Mag", tags: ["Magazine / Newspaper / Blog"] })]);
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ query: "editorial magazine", count: 6 });
    expect(res.content[0]).toHaveProperty("text");
    expect((res.content[0] as any).text).toContain("mag");
    // 1 FTS row < count 6: the partial-window top-up merge still fires under
    // FTS routing (the scraped rows are client-checked and dropped here).
    const pageCalls = fetchFn.mock.calls.filter((c: any[]) => String(c[0]).includes("/websites/"));
    expect(pageCalls.length).toBe(1);
    // The porter stem matches where substring search cannot: "magazines"
    // appears nowhere in the title/tag text ("Magazine" does).
    const stemmed = await h.search_sites({ query: "editorial magazines", count: 6 });
    expect((stemmed.content[0] as any).text).toContain("mag");
  });

  it("orders query results by bm25 rank, not createdAt (title hit leads)", async () => {
    const cache = new Cache(tmpDir());
    // The tag-only-style longer-title hit is NEWER, so the legacy
    // newest-first sort would serve it first; bm25 ranks the short-title
    // exact hit first. This goes through the partial-window merge (2 rows <
    // count 6), so it also pins the merge's keep-rank-order behavior.
    cache.upsertSites([
      site({ slug: "magazine-post", title: "A Magazine Post About Editorial Things", createdAt: 1789516800 + 500 }),
      site({ slug: "editorial-mag", title: "Editorial Mag", createdAt: 1789516800 }),
    ]);
    const { client } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ query: "editorial", count: 6 });
    const text = (res.content[0] as any).text;
    expect(text.indexOf("editorial-mag")).toBeLessThan(text.indexOf("magazine-post"));
  });

  it("falls back to the legacy substring path when FTS5 is unavailable", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site({ slug: "mag", title: "Editorial Mag", tags: ["Magazine / Newspaper / Blog"] })]);
    // Simulate an FTS-less Node build: drop the derived table via the test
    // hook and flip the cached capability flag so the probe never re-fires.
    cache.withDbForTest((db) => db.exec("DROP TABLE sites_fts"));
    cache.ftsAvailable = false;
    const { client } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ query: "editorial", count: 6 });
    expect((res.content[0] as any).text).toContain("mag");
  });

  it("hints loose OR matches on FTS zero results", async () => {
    const cache = new Cache(tmpDir());
    // "half" matches the "editorial" token but not the AND of both tokens,
    // so the strict search is empty while the loose hint names it.
    cache.upsertSites([site({ slug: "half", title: "Editorial Only", tags: [] })]);
    const { client } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ query: "editorial magazine", count: 6 });
    const text = (res.content[0] as any).text;
    expect(text).toContain("No sites matched");
    expect(text).toContain("Loose matches (any token): half");
  });

  it("drops stem-matched rows that fail a non-query filter (filter composition)", async () => {
    const cache = new Cache(tmpDir());
    // Both rows match the FTS stem ("magazines" → magazin): one via its
    // Magazine tag, one via its title only. Facets compare canonical slugs
    // exactly, so the tag filter asks for the real taxonomy slug
    // "magazine-newspaper-blog" (a bare "magazine" only worked when substring
    // matching was accidental). skipQueryCheck must skip ONLY the query
    // re-check — with no URL filter (pure query + tags search) the tag is
    // client-checked with honorUrlSource=false, so the untagged stem match
    // must drop instead of riding the FTS path into the results.
    cache.upsertSites([
      site({ slug: "mag-tagged", title: "Paper Journal", tags: ["Magazine / Newspaper / Blog"] }),
      site({ slug: "mag-untagged", title: "Magazine Warehouse", tags: [] }),
    ]);
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ query: "magazines", tags: ["magazine-newspaper-blog"], count: 6 });
    const text = (res.content[0] as any).text;
    // The partial-window top-up re-runs FTS over the fresh cache: the fixture
    // row that genuinely carries the Magazine tag joins the result, but no
    // untagged row does.
    expect(text).toContain("2 site(s) matched");
    expect(text).toContain("mag-tagged");
    expect(text).toContain("ai-in-design-report-2026");
    expect(text).not.toContain("mag-untagged");
    expect(fetchFn.mock.calls.every((c: any[]) => !String(c[0]).includes("/sites/"))).toBe(true);
    expect(text).not.toContain("l-i-s-a");
  });
});

describe("search cold/warm consistency", () => {
  it("re-runs FTS after a scrape so a cold 'magazines' query finds Magazine", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = clientFor(listingPage([
      { slug: "mag-cold", title: "Magazine Editorial", tags: ["Magazine / Newspaper / Blog"] },
    ]));
    const h = createHandlers({ client, cache });
    const pageCalls = () => fetchFn.mock.calls.filter((c: any[]) => String(c[0]).includes("/websites/"));
    const cold = await h.search_sites({ query: "magazines", count: 1 });
    expect((cold.content[0] as any).text).toContain("mag-cold");
    expect(pageCalls()).toHaveLength(1);
    // The row is cached now; the warm call must return the same match through
    // FTS with no second fetch (the old substring check dropped it cold).
    const warm = await h.search_sites({ query: "magazines", count: 1 });
    expect((warm.content[0] as any).text).toContain("mag-cold");
    expect(pageCalls()).toHaveLength(1);
  });

  it("matches a cached Next.js site for next.js, nextjs and next-js queries", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site({ slug: "next-site", title: "Studio", tags: ["Next.js"] })]);
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    for (const query of ["next.js", "nextjs", "next-js"]) {
      const res = await h.search_sites({ query, count: 1 });
      expect((res.content[0] as any).text, query).toContain("next-site");
    }
    expect(fetchFn.mock.calls.filter((c: any[]) => String(c[0]).includes("/websites/"))).toHaveLength(0);
  });

  it("keeps the requested page window and filters bound across cold and warm reads", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = clientFor(listingPage([
      ...Array.from({ length: 5 }, (_, i) => ({
        slug: `cw-${i}`, title: `Editorial ${i}`, tags: ["WebGL"],
      })),
      // Same query match, wrong technology: the filter must keep it out on
      // both the cold re-rank and the warm read.
      { slug: "cw-off", title: "Editorial Off", tags: ["3D"] },
    ]));
    const h = createHandlers({ client, cache });
    const args = { query: "editorial", technology: "webgl", page: 2, count: 2 };
    const pageCalls = () => fetchFn.mock.calls.filter((c: any[]) => String(c[0]).includes("/websites/"));
    const slugsOf = (text: string) => [...text.matchAll(/\(slug: ([^)]+)\)/g)].map((m) => m[1]);

    const cold = await h.search_sites(args);
    const coldText = (cold.content[0] as any).text;
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("/websites/webgl/");
    expect(coldText).toContain("5 site(s) matched; showing 3-4");
    expect(coldText).not.toContain("cw-off");
    expect(pageCalls()).toHaveLength(1);

    // The warm read must serve the same page-window slice through FTS, with
    // the technology filter still binding, and without a second fetch.
    const warm = await h.search_sites(args);
    const warmText = (warm.content[0] as any).text;
    expect(warmText).toBe(coldText);
    expect(slugsOf(warmText)).toEqual(slugsOf(coldText));
    expect(slugsOf(warmText)).toHaveLength(2);
    expect(pageCalls()).toHaveLength(1);
  });
});

describe("partial top-up re-rank", () => {
  it("rebuilds the page window from the global FTS re-rank after a successful top-up", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites(Array.from({ length: 5 }, (_, i) =>
      site({ slug: `ed-${i}`, title: `Editorial Archive ${i}`, tags: [], createdAt: 1789516800 + i })));
    const { client, fetchFn } = clientFor(listingPage([
      // Shortest title of the six, so bm25 ranks it first after upsert.
      { slug: "ed-fresh", title: "Editorial", tags: [] },
    ]));
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ query: "editorial", count: 3, page: 2 });
    expect(fetchFn.mock.calls.filter((c: any[]) => String(c[0]).includes("/websites/"))).toHaveLength(1);
    const text = (res.content[0] as any).text;
    expect(text).toContain("6 site(s) matched; showing 4-6");

    // The fresh row outranks every cached row, so page 2 must be exactly the
    // post-upsert FTS slice at positions 3-5. Append-only would have put the
    // fresh row last and leaked it into this window.
    const ranked = cache.searchSites("editorial", SITE_TTL_MS)!;
    expect(ranked.map((s) => s.slug)[0]).toBe("ed-fresh");
    const expected = ranked.slice(3, 6).map((s) => s.slug);
    expect(expected).toHaveLength(3);
    const returned = [...text.matchAll(/\(slug: ([^)]+)\)/g)].map((match) => match[1]!);
    expect(returned).toEqual(expected);
    expect(returned).not.toContain("ed-fresh");
  });

  it("keeps the requested page window when the top-up fetch fails", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites(Array.from({ length: 4 }, (_, i) =>
      site({ slug: `ed-${i}`, title: `Editorial Archive ${i}`, tags: [], createdAt: 1789516800 + i })));
    const fetchFn = vi.fn(async () => { throw new Error("upstream down"); });
    const client = new AwwwardsClient({ fetchFn: fetchFn as unknown as typeof fetch });
    const h = createHandlers({ client, cache });
    // 4 matches < count*page (6) → partial window → top-up scrape, which
    // fails. The requested page-2 window must survive; the stale fallback
    // (page 1 only) must not swallow it.
    const res = await h.search_sites({ query: "editorial", page: 2, count: 3 });
    expect(fetchFn.mock.calls.some((c: any[]) => String(c[0]).includes("/websites/"))).toBe(true);
    const text = (res.content[0] as any).text;
    expect(text).toContain("4 site(s) matched; showing 4-4");
    expect(text).not.toContain("showing 1-3");
  });
});

describe("page-bound URL filters", () => {
  it("does not let cached rows outside the fetched color page into a query", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site({ slug: "outside", title: "Porcelain Outside", tags: [] })]);
    const { client, fetchFn } = clientFor(listingPage([
      { slug: "color-page", title: "Color Page Studio", tags: ["WebGL"] },
    ]));
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ color: "#404040", query: "porcelain", count: 1 });
    // The color filter must actually be in the fetched URL — otherwise the
    // "no leak" result would pass merely because no filter page was fetched.
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("/websites/%23404040/");
    const text = (res.content[0] as any).text;
    // Color is not client-verifiable: the cached match from another page must
    // not ride the post-scrape FTS re-run into a color result.
    expect(text).toContain("No sites matched");
    expect(text).not.toContain("outside");
  });

  it("keeps fresh color-page rows and their query matches", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = clientFor(listingPage([
      { slug: "color-page", title: "Color Page Studio", tags: ["WebGL"] },
    ]));
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ color: "#404040", query: "color", count: 1 });
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("/websites/%23404040/");
    expect((res.content[0] as any).text).toContain("color-page");
  });

  it("does not let cached rows outside the fetched winner-category page in", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site({ slug: "winner-outside", title: "Aurora Outside", awards: [] })]);
    const { client, fetchFn } = clientFor(listingPage([
      { slug: "winner-page", title: "Winner Page", tags: [] },
    ]));
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ award: "portfolio", query: "aurora", count: 1 });
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("/websites/winner_category_portfolio/");
    const text = (res.content[0] as any).text;
    // Winner-category cards carry no marker, so the award filter cannot be
    // re-checked; membership comes only from the fetched filter page.
    expect(text).toContain("No sites matched");
    expect(text).not.toContain("winner-outside");
  });

  it("serves fresh winner-category rows even though cards carry no marker", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = clientFor(listingPage([
      { slug: "winner-page", title: "Winner Page", tags: [] },
    ]));
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ award: "portfolio", query: "winner", count: 1 });
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("/websites/winner_category_portfolio/");
    const text = (res.content[0] as any).text;
    expect(text).toContain("winner-page");
    expect(text).not.toContain("No sites matched");
  });
});

describe("exact canonical facets", () => {
  it("does not match React Native for technology react", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([
      site({ slug: "react-site", title: "React Studio", tags: ["React"] }),
      site({ slug: "rn-site", title: "React Native Studio", tags: ["React Native"] }),
    ]);
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const pageCalls = () => fetchFn.mock.calls.filter((c: any[]) => String(c[0]).includes("/websites/"));
    const react = await h.search_sites({ technology: "react", count: 1 });
    const reactText = (react.content[0] as any).text;
    expect(reactText).toContain("1 site(s) matched");
    expect(reactText).toContain("react-site");
    expect(reactText).not.toContain("rn-site");
    expect(pageCalls()).toHaveLength(0);

    const native = await h.search_sites({ technology: "react-native", count: 1 });
    const nativeText = (native.content[0] as any).text;
    expect(nativeText).toContain("1 site(s) matched");
    expect(nativeText).toContain("rn-site");
    expect(nativeText).not.toContain("react-site");
    expect(pageCalls()).toHaveLength(0);
  });

  it("resolves aliases and whitespace variants to the same canonical facet", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site({ slug: "next-site", title: "Next Studio", tags: ["Next.js"] })]);
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    for (const technology of ["nextjs", "Next.js", "next-js", " next js "]) {
      const res = await h.search_sites({ technology, count: 1 });
      expect((res.content[0] as any).text, technology).toContain("next-site");
    }
    for (const tags of [["nextjs"], ["Next.js"], ["next-js"]]) {
      const res = await h.search_sites({ tags, count: 1 });
      expect((res.content[0] as any).text, tags.join(",")).toContain("next-site");
    }
    expect(fetchFn.mock.calls.filter((c: any[]) => String(c[0]).includes("/websites/"))).toHaveLength(0);
  });

  it("matches a multi-word display tag by its canonical slug", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site({ slug: "mag", title: "Editorial Mag", tags: ["Magazine / Newspaper / Blog"] })]);
    const { client } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ tags: ["magazine-newspaper-blog"], count: 1 });
    expect((res.content[0] as any).text).toContain("mag");
  });

  it("serves cached rows for every live display-tag / URL-slug pair", async () => {
    const pairs: Array<[display: string, urlSlug: string]> = [
      ["Adobe Illustrator", "illustrator"],
      ["Adobe Photoshop", "photoshop"],
      ["Angular", "angularjs"],
      ["CSS", "css3"],
      ["Curtains.js", "curtains"],
      ["Matter.js", "matterjs"],
      ["P5.js", "p5js"],
      ["Sketch", "sketchapp"],
      ["Swiper.js", "swiper"],
      ["Navigation Menu", "navigation"],
      ["SEO", "seo-1"],
    ];
    for (const [display, urlSlug] of pairs) {
      const cache = new Cache(tmpDir());
      cache.upsertSites([site({ slug: `facet-${urlSlug}`, title: "Facet Studio", tags: [display] })]);
      const { client, fetchFn } = fakeClient();
      const h = createHandlers({ client, cache });
      for (const technology of [display, urlSlug]) {
        const res = await h.search_sites({ technology, count: 1 });
        expect((res.content[0] as any).text, `${display} via ${technology}`)
          .toContain(`facet-${urlSlug}`);
      }
      expect(
        fetchFn.mock.calls.filter((c: any[]) => String(c[0]).includes("/websites/")),
        display,
      ).toHaveLength(0);
    }
  });

  it("serves a cold query + technology:'illustrator' row from the fetched page", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = clientFor(listingPage([
      { slug: "illustrator-site", title: "Illustration Studio", tags: ["Adobe Illustrator"] },
    ]));
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ query: "studio", technology: "illustrator", count: 1 });
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("/websites/illustrator/");
    expect((res.content[0] as any).text).toContain("illustrator-site");
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

  it("sorts many candidates with one batched meta read", async () => {
    const cache = new Cache(tmpDir());
    const sites = Array.from({ length: 60 }, (_, i) => site({
      slug: `bulk-${String(i).padStart(3, "0")}`,
      createdAt: 1789516800 + i,
      thumbnailPath: `submissions/bulk-${i}.jpg`,
    }));
    cache.upsertSites(sites);
    for (let i = 0; i < 60; i++) cache.setMeta(`detail:bulk-${String(i).padStart(3, "0")}`, { score: i % 7 });
    const readSpy = vi.spyOn(cache, "withReadDb");
    const { client } = fakeClient();
    vi.spyOn(client, "getThumbnail").mockResolvedValue(Buffer.from("jpeg"));

    const res = await createHandlers({ client, cache }).search_sites({
      sortBy: "score", count: 12, responseMode: "compact",
    });

    // One batched metadata read for all 60 candidates, not one open per slug.
    expect(readSpy).toHaveBeenCalledTimes(1);
    const expected = sites
      .map((s, i) => ({ s, score: i % 7 }))
      .sort((a, b) =>
        b.score - a.score ||
        b.s.createdAt - a.s.createdAt ||
        a.s.slug.localeCompare(b.s.slug))
      .slice(0, 12)
      .map((w) => w.s.slug);
    const body = (res.content[0] as { type: "text"; text: string }).text;
    const positions = expected.map((slug) => body.indexOf(`slug: ${slug}`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i - 1]).toBeLessThan(positions[i]);
    }
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
    expect("mobileBands" in parsed).toBe(false);
    expect("diff" in parsed).toBe(false);
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

  it("forwards maxBands and the viewport to the analyzer", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const seen: Array<{
      url: string;
      maxBands?: number;
      opts?: { waitStrategy?: string; viewport?: string };
    }> = [];
    const h = createHandlers({
      client,
      cache,
      analyzeFn: async (
        url: string,
        maxBands?: number,
        opts?: { waitStrategy?: string; viewport?: string },
      ) => {
        seen.push({ url, maxBands, opts });
        return { url, title: "T", totalHeight: 100, bands: [] };
      },
    });
    await h.analyze_page_structure({
      url: "https://example.com",
      maxBands: 10,
      viewport: "mobile",
    });
    expect(seen[0]?.maxBands).toBe(10);
    expect(seen[0]?.opts).toMatchObject({ viewport: "mobile" });
  });

  it("compare:mobile captures a second mobile pass and appends mobileBands + diff", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const seen: Array<string | undefined> = [];
    const h = createHandlers({
      client,
      cache,
      analyzeFn: async (url: string, _maxBands?: number, opts?: { viewport?: string }) => {
        seen.push(opts?.viewport);
        const mobile = opts?.viewport === "mobile";
        return {
          url,
          title: "T",
          totalHeight: mobile ? 800 : 1000,
          bands: mobile
            ? [
                { index: 0, tag: "section", label: ".a", background: "rgb(0, 0, 0)", offsetTop: 0, height: 300, textStart: "" },
                { index: 1, tag: "section", label: ".b", background: "rgb(0, 0, 0)", offsetTop: 300, height: 500, textStart: "" },
              ]
            : [
                { index: 0, tag: "section", label: ".a", background: "rgb(0, 0, 0)", offsetTop: 0, height: 500, textStart: "" },
                { index: 1, tag: "section", label: ".c", background: "rgb(0, 0, 0)", offsetTop: 500, height: 500, textStart: "" },
              ],
        };
      },
    });
    const res = await h.analyze_page_structure({ url: "https://example.com", compare: "mobile" });
    expect(res.isError).toBeUndefined();
    expect(seen).toEqual(["desktop", "mobile"]);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.totalHeight).toBe(1000); // desktop stays the base
    expect(parsed.bands.map((b: any) => b.label)).toEqual([".a", ".c"]);
    expect(parsed.mobileBands.map((b: any) => b.label)).toEqual([".a", ".b"]);
    expect(parsed.diff).toEqual({
      heightDelta: -200,
      bandsAdded: [".b"],
      bandsRemoved: [".c"],
      reordered: [],
    });
  });

  it("compare:mobile keeps the desktop result and reports mobileError when the second capture fails", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const desktop = {
      url: "https://example.com",
      title: "T",
      totalHeight: 900,
      bands: [
        { index: 0, tag: "section", label: ".a", background: "rgb(0, 0, 0)", offsetTop: 0, height: 900, textStart: "" },
      ],
    };
    const h = createHandlers({
      client,
      cache,
      analyzeFn: async (_url: string, _maxBands?: number, opts?: { viewport?: string }) =>
        opts?.viewport === "mobile" ? { error: "mobile boom" } : desktop,
    });
    const res = await h.analyze_page_structure({ url: "https://example.com", compare: "mobile" });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.totalHeight).toBe(900);
    expect(parsed.bands.map((b: any) => b.label)).toEqual([".a"]);
    expect(parsed.mobileError).toBe("mobile boom");
    expect("mobileBands" in parsed).toBe(false);
    expect("diff" in parsed).toBe(false);
    expect("responsive" in parsed).toBe(false);
  });

  it("compare:mobile reuses a mobile primary capture instead of a second call", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    let calls = 0;
    const h = createHandlers({
      client,
      cache,
      analyzeFn: async (url: string) => {
        calls++;
        return { url, title: "T", totalHeight: 500, bands: [] };
      },
    });
    const res = await h.analyze_page_structure({
      url: "https://example.com",
      viewport: "mobile",
      compare: "mobile",
    });
    expect(calls).toBe(1);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.diff).toEqual({ heightDelta: 0, bandsAdded: [], bandsRemoved: [], reordered: [] });
  });

  const REPORT = {
    measuredAt: "mobile" as const,
    viewport: { width: 390, height: 844, dpr: 3 },
    pageOverflow: { horizontal: true, scrollWidth: 420, innerWidth: 390 },
    issues: [],
    counts: { overflow: 1, smallText: 0, smallTapTarget: 0 },
    truncated: false,
  };

  it("compare:mobile requests responsive evidence on the mobile capture only", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const optsSeen: Array<{ viewport?: string; responsive?: boolean }> = [];
    const h = createHandlers({
      client,
      cache,
      analyzeFn: async (_url: string, _maxBands?: number, opts?: { viewport?: string; responsive?: boolean }) => {
        optsSeen.push({ viewport: opts?.viewport, responsive: opts?.responsive });
        return {
          url: "https://example.com",
          title: "T",
          totalHeight: 800,
          bands: [],
          ...(opts?.responsive ? { responsive: REPORT } : {}),
        };
      },
    });
    const res = await h.analyze_page_structure({ url: "https://example.com", compare: "mobile" });
    expect(optsSeen).toEqual([
      { viewport: "desktop", responsive: undefined },
      { viewport: "mobile", responsive: true },
    ]);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.responsive).toEqual(REPORT);
  });

  it("desktop-only structure has no responsive key and matches the 1.13 baseline", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const desktop = JSON.parse(
      readFileSync(join(FIXTURES, "v1.13", "structure-desktop.json"), "utf8"),
    );
    const h = createHandlers({ client, cache, analyzeFn: async () => desktop });
    const res = await h.analyze_page_structure({ url: "https://example.com" });
    const parsed = JSON.parse((res.content[0] as any).text);
    expect("responsive" in parsed).toBe(false);
    expect(parsed).toEqual(desktop);
  });

  it("viewport mobile + compare:mobile makes one responsive capture", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    let calls = 0;
    const seen: Array<{ viewport?: string; responsive?: boolean }> = [];
    const h = createHandlers({
      client,
      cache,
      analyzeFn: async (_url: string, _maxBands?: number, opts?: { viewport?: string; responsive?: boolean }) => {
        calls++;
        seen.push({ viewport: opts?.viewport, responsive: opts?.responsive });
        return {
          url: "https://example.com",
          title: "T",
          totalHeight: 500,
          bands: [],
          ...(opts?.responsive ? { responsive: REPORT } : {}),
        };
      },
    });
    const res = await h.analyze_page_structure({
      url: "https://example.com",
      viewport: "mobile",
      compare: "mobile",
    });
    expect(calls).toBe(1);
    expect(seen).toEqual([{ viewport: "mobile", responsive: true }]);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.responsive).toEqual(REPORT);
  });

  it("rejects compare:mobile with cdpEndpoint before calling the analyzer", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    let calls = 0;
    const h = createHandlers({
      client,
      cache,
      analyzeFn: async () => {
        calls++;
        return { url: "https://example.com", title: "T", totalHeight: 0, bands: [] };
      },
    });
    const res = await h.analyze_page_structure({
      url: "https://example.com",
      compare: "mobile",
      cdpEndpoint: "http://127.0.0.1:9222",
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain("cdpEndpoint");
    expect(calls).toBe(0);
  });

  it("passes cdpEndpoint to the analyzer and keeps the attached marker", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const seen: Array<{ cdpEndpoint?: string; viewport?: string }> = [];
    const h = createHandlers({
      client,
      cache,
      analyzeFn: async (url: string, _maxBands?: number, opts?: any) => {
        seen.push(opts);
        return { url, title: "T", totalHeight: 500, bands: [], attached: true };
      },
    });
    const res = await h.analyze_page_structure({
      url: "https://example.com",
      cdpEndpoint: "http://127.0.0.1:9222",
    });
    expect(res.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ cdpEndpoint: "http://127.0.0.1:9222", viewport: "desktop" });
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.attached).toBe(true);
    expect("mobileBands" in parsed).toBe(false);
  });
});

describe("record_site_motion", () => {
  it("returns the filmstrip inline and forwards url + frames to the motion fn", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const seen: Array<{
      url: string;
      opts: { cacheImagesDir: string; frames?: number; waitStrategy?: string; viewport?: string };
    }> = [];
    const h = createHandlers({
      client,
      cache,
      motionFn: async (url, opts) => {
        seen.push({ url, opts });
        return {
          file: "/cache/motion-abc1234567.webm",
          base64: Buffer.from("strip-jpeg").toString("base64"),
          frames: 16,
        };
      },
    });
    const res = await h.record_site_motion({
      url: "https://example.com",
      frames: 12,
      waitStrategy: "networkidle",
      viewport: "mobile",
    });
    expect(res.isError).toBeUndefined();
    expect((res.content[0] as any).text).toBe(
      "Motion recording saved to /cache/motion-abc1234567.webm",
    );
    expect(res.content[1]).toEqual({
      type: "image",
      data: Buffer.from("strip-jpeg").toString("base64"),
      mimeType: "image/jpeg",
    });
    expect(seen[0]).toEqual({
      url: "https://example.com",
      opts: {
        cacheImagesDir: cache.imagesDir,
        frames: 12,
        waitStrategy: "networkidle",
        viewport: "mobile",
      },
    });
  });

  it("surfaces the install hint as isError when the motion fn reports failure", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const h = createHandlers({
      client,
      cache,
      motionFn: async () => ({ error: "Install it with:  npm install -D ffmpeg-static" }),
    });
    const res = await h.record_site_motion({ url: "https://example.com" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain("ffmpeg-static");
  });

  it("appends sheet paths to the text block when the motion fn returns a sheet", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const h = createHandlers({
      client,
      cache,
      motionFn: async () => ({
        file: "/cache/motion-abc1234567.webm",
        base64: Buffer.from("strip-jpeg").toString("base64"),
        frames: 16,
        sheet: {
          htmlPath: "/cache/motion-abc1234567/sheet.html",
          mdPath: "/cache/motion-abc1234567/sheet.md",
          keyframes: 4,
          masks: 3,
        },
      }),
    });
    const res = await h.record_site_motion({ url: "https://example.com" });
    expect(res.isError).toBeUndefined();
    expect((res.content[0] as any).text).toBe(
      "Motion recording saved to /cache/motion-abc1234567.webm — motion sheet: /cache/motion-abc1234567/sheet.html + /cache/motion-abc1234567/sheet.md (4 keyframes, 3 masks)",
    );
  });

  it("appends the sheet error to the text block when sheetError is present", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const h = createHandlers({
      client,
      cache,
      motionFn: async () => ({
        file: "/cache/motion-abc1234567.webm",
        base64: Buffer.from("strip-jpeg").toString("base64"),
        frames: 16,
        sheet: null,
        sheetError: "ffmpeg not found",
      }),
    });
    const res = await h.record_site_motion({ url: "https://example.com" });
    expect(res.isError).toBeUndefined();
    expect((res.content[0] as any).text).toBe(
      "Motion recording saved to /cache/motion-abc1234567.webm (motion sheet failed: ffmpeg not found)",
    );
  });
});

describe("viewport threading", () => {
  it("threads viewport: mobile through capture_live_site to the capture fn", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const seen: Array<{ url: string; opts?: { waitStrategy?: string; viewport?: string } }> = [];
    const h = createHandlers({
      client,
      cache,
      captureFn: async (url: string, imagesDir: string, opts?: { viewport?: string }) => {
        seen.push({ url, opts });
        return { file: join(imagesDir, "shot.png"), base64: Buffer.from("png").toString("base64") };
      },
    });
    const res = await h.capture_live_site({ url: "https://example.com", viewport: "mobile" });
    expect(res.isError).toBeUndefined();
    expect(seen[0]?.url).toBe("https://example.com");
    expect(seen[0]?.opts).toMatchObject({ viewport: "mobile" });
  });

  it("arrives as desktop when viewport is omitted (zod default path)", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const captured: {
      capture?: unknown;
      analyze?: unknown;
      motion?: unknown;
    } = {};
    const h = createHandlers({
      client,
      cache,
      captureFn: async (_url: string, _imagesDir: string, opts?: unknown) => {
        captured.capture = opts;
        return { file: "shot.png", base64: Buffer.from("png").toString("base64") };
      },
      analyzeFn: async (_url: string, _maxBands?: number, opts?: unknown) => {
        captured.analyze = opts;
        return { url: "https://example.com", title: "T", totalHeight: 100, bands: [] };
      },
      motionFn: async (_url: string, opts?: unknown) => {
        captured.motion = opts;
        return { file: "m.webm", base64: Buffer.from("strip").toString("base64"), frames: 16 };
      },
    });
    // Tool callers omitting viewport get zod's "desktop" default; the handler
    // normalizes direct calls to the same explicit value.
    await h.capture_live_site({ url: "https://example.com" });
    await h.analyze_page_structure({ url: "https://example.com" });
    await h.record_site_motion({ url: "https://example.com" });
    expect(captured.capture).toMatchObject({ viewport: "desktop" });
    expect(captured.analyze).toMatchObject({ viewport: "desktop" });
    expect(captured.motion).toMatchObject({ viewport: "desktop" });
  });
});

// ---- search_elements / get_element handlers ----

const elementFixture: ElementRecord = {
  slug: "footers-editorial-studio", title: "Editorial Footer", cid: "footers",
  category: "Footers", author: "Studio X", builtWith: ["GSAP", "Lenis"],
  related: ["footers-editorial-studio-2"], mediaPath: "element/2025/11/e.jpg",
  mediaType: "image", source: "gallery", projectId: null, siteSlug: null,
  fetchedAt: Date.now(),
};
const elementFixture2: ElementRecord = {
  ...elementFixture, slug: "footers-editorial-studio-2", title: "Second Footer",
};

describe("search_elements handler", () => {
  it("empty corpus returns count 0 with a retired-crawl note and no fetch", async () => {
    const { client, fetchFn } = fakeClient();
    const cache = new Cache(tmpDir());
    const h = createHandlers({ client, cache });
    const res = await h.search_elements({ query: "footer" });
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.count).toBe(0);
    expect(body.results).toEqual([]);
    expect(body.note).toMatch(/retired.*robots\.txt/);
    expect(res.isError).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("searches a site-only corpus without the empty-corpus note", async () => {
    const { client, fetchFn } = fakeClient();
    const cache = new Cache(tmpDir());
    cache.upsertElements([{
      ...elementFixture, slug: "site-example-hero", title: "Hero loop",
      source: "site", siteSlug: "example",
    }]);
    const h = createHandlers({ client, cache });
    const res = await h.search_elements({ query: "hero" });
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.results.map((r: any) => r.slug)).toContain("site-example-hero");
    expect(body.note).toBeUndefined();
    expect(res.isError).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns facet-filtered compact payloads with media URLs (no base64)", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    cache.upsertElements([elementFixture, elementFixture2]);
    const h = createHandlers({ client, cache });
    const res = await h.search_elements({ query: "footer", category: "footers", limit: 10 });
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.results.length).toBe(2);
    expect(body.results[0].mediaUrl).toContain("assets.awwwards.com");
    expect(JSON.stringify(res)).not.toContain("base64");
  });

  it("stack facet rejects records missing a requested token", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    cache.upsertElements([elementFixture, elementFixture2]);
    const h = createHandlers({ client, cache });
    const res = await h.search_elements({ query: "footer", stack: ["lenis", "webgl"], limit: 10 });
    expect(JSON.parse((res.content[0] as any).text).results).toHaveLength(0);
  });

  it("serves an empty corpus without a query via listElements (no FTS call)", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    cache.upsertElements([elementFixture, elementFixture2]);
    const h = createHandlers({ client, cache });
    const res = await h.search_elements({ category: "footers", limit: 1 });
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.count).toBe(1);
    expect(body.results[0].slug).toBe("footers-editorial-studio");
  });

  it("pairs elements to sites: stored siteSlug wins, else author→title fallback", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    // Sites index has two rows; only one matches elementFixture's author
    // "Studio X" by title. A stored siteSlug bypasses the fallback entirely.
    cache.upsertSites([
      site({ slug: "studio-x", title: "Studio X" }),
      site({ slug: "other-site", title: "Unrelated" }),
    ]);
    cache.upsertElements([
      elementFixture, // siteSlug null → resolves via author→title
      elementFixture2, // siteSlug stored → used as-is
    ]);
    cache.upsertElements([
      { ...elementFixture2, siteSlug: "the-real-site" },
    ]);
    const h = createHandlers({ client, cache });
    const res = await h.search_elements({ query: "footer", limit: 10 });
    const parsed = JSON.parse((res.content[0] as any).text);
    const bySlug = new Map(parsed.results.map((r: any) => [r.slug, r]));
    // Fallback: author "Studio X" matches exactly one site title.
    expect(bySlug.get("footers-editorial-studio").siteSlug).toBe("studio-x");
    expect(bySlug.get("footers-editorial-studio").siteUrl).toContain("/sites/studio-x/");
    // Stored value beats the fallback.
    expect(bySlug.get("footers-editorial-studio-2").siteSlug).toBe("the-real-site");
  });

  it("leaves siteSlug null when the author matches zero or multiple site titles", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    cache.upsertSites([
      site({ slug: "studio-x-1", title: "Studio X" }),
      site({ slug: "studio-x-2", title: "Studio X" }), // duplicate titles → ambiguous
    ]);
    cache.upsertElements([elementFixture]);
    const h = createHandlers({ client, cache });
    const res = await h.search_elements({ query: "footer", limit: 10 });
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.results[0].siteSlug).toBeNull();
    expect(parsed.results[0].siteUrl).toBeNull();
  });

  it("renders mediaUrl/posterUrl null when mediaPath is empty (no garbage URL)", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const noMedia: ElementRecord = { ...elementFixture, mediaPath: "" };
    cache.upsertElements([noMedia]);
    const h = createHandlers({ client, cache });
    const res = await h.search_elements({ query: "footer", limit: 5 });
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.results[0].mediaUrl).toBeNull();
    expect(body.results[0].posterUrl).toBeNull();
  });
});

describe("get_element handler", () => {
  it("returns full record with resolved related titles", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    cache.upsertElements([elementFixture, elementFixture2]);
    const h = createHandlers({ client, cache });
    const res = await h.get_element({ id: "footers-editorial-studio" });
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.slug).toBe("footers-editorial-studio");
    expect(body.related).toEqual([{ slug: "footers-editorial-studio-2", title: "Second Footer" }]);
  });

  it("reports a clean error for an unknown id", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const h = createHandlers({ client, cache });
    const res = await h.get_element({ id: "nope" });
    expect(res.isError).toBe(true);
  });
});

describe("get_motion_dna handler", () => {
  const dnaFixture = {
    url: "https://example.com/a",
    stack: { libs: ["gsap", "scrolltrigger"], render: ["webgl", "three"], scrollModel: "native" as const },
    scroll: { triggerCount: 6, scrubCount: 3, pinCount: 2, scrubRatio: 0.5, sample: [] },
    easingVocab: [{ token: "power4.out", bezier: [0.23, 1, 0.32, 1], uses: 9 }],
    durationVocab: { p25: 400, median: 700, p75: 1200 },
    capturedAt: Date.now(),
  };

  it("serves cached records under 90 days", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const cached: UnifiedMotionDna = {
      ...dnaFixture,
      capturedAt: Date.now(),
      censusSummary: { counts: {}, gsapRegistryCount: 0 },
    };
    cache.upsertMotionDna(cached);
    const captured = vi.fn();
    const h = createHandlers({ client, cache, motionDnaFn: async (u: string) => { captured(u); return dnaFixture; } });
    const res = await h.get_motion_dna({ url: dnaFixture.url });
    expect(JSON.parse((res.content[0] as any).text).url).toBe(dnaFixture.url);
    expect(captured).not.toHaveBeenCalled();
  });

  it("treats cached rows without censusSummary.gsapRegistryCount as a miss", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    // Pre-change on-disk shapes: no summary at all (old captureMotionDna) and
    // the early unified summary that only carried counts.
    type LegacyRow = MotionDna & { censusSummary?: { counts: Record<string, number> } };
    const legacyRows: LegacyRow[] = [
      { ...dnaFixture, capturedAt: Date.now() },
      { ...dnaFixture, capturedAt: Date.now(), censusSummary: { counts: {} } },
    ];
    for (const legacy of legacyRows) {
      cache.upsertMotionDna(legacy);
      let captured = 0;
      const h = createHandlers({
        client,
        cache,
        motionDnaFn: async (): Promise<UnifiedMotionDna> => {
          captured++;
          return { ...dnaFixture, censusSummary: { counts: {}, gsapRegistryCount: 2 } };
        },
      });
      const res = await h.get_motion_dna({ url: dnaFixture.url });
      const parsed = JSON.parse((res.content[0] as any).text);
      expect(captured).toBe(1);
      expect(parsed.censusSummary.gsapRegistryCount).toBe(2);
    }
  });

  it("live-captures and upserts on a cache miss, surfacing failure as clean error", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const h = createHandlers({ client, cache, motionDnaFn: async () => { throw new Error("boom"); } });
    const miss = await h.get_motion_dna({ url: "https://unreachable.example" });
    expect(miss.isError).toBe(true);
    expect((miss.content[0] as any).text).toContain("boom");
  });

  // F3 (dogfood): the injected unified capture's slimmed censusSummary
  // (counts + registry row count) must reach the response verbatim — no
  // scrubRatio/pinCount doppelgänger beside dna.scroll, which is the single
  // runtime truth for scrub/pin.
  it("live-capture passthrough: censusSummary reaches the response verbatim", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const unified: UnifiedMotionDna = {
      ...dnaFixture,
      censusSummary: { counts: { "gsap-scrolltrigger": 3 }, gsapRegistryCount: 4 },
    };
    const h = createHandlers({ client, cache, motionDnaFn: async () => unified });
    const res = await h.get_motion_dna({ url: dnaFixture.url });
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.censusSummary).toEqual({
      counts: { "gsap-scrolltrigger": 3 },
      gsapRegistryCount: 4,
    });
    expect(Object.keys(parsed.censusSummary).sort()).toEqual(["counts", "gsapRegistryCount"]);
  });
});

describe("analyze_stack handler", () => {
  it("passes url/timeout through to the stack fn and returns JSON", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const seen: Array<{ url: string; opts?: { timeoutMs?: number } }> = [];
    const h = createHandlers({
      client,
      cache,
      stackFn: async (url, opts) => {
        seen.push({ url, opts });
        return {
          id: "stack-fingerprint-v1",
          framework: "next",
          frameworkMarkers: ["/_next/"],
          frameworkConfidence: "high",
          css: "custom",
          cssMarkers: [],
          cssConfidence: "low",
          libs: [],
        };
      },
    });
    const res = await h.analyze_stack({ url: "https://example.com", timeoutMs: 3000 });
    expect(res.isError).toBeUndefined();
    expect(seen).toEqual([{ url: "https://example.com", opts: { timeoutMs: 3000 } }]);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.id).toBe("stack-fingerprint-v1");
    expect(parsed.framework).toBe("next");
  });

  it("surfaces a stack-fn error as isError text", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const h = createHandlers({
      client,
      cache,
      stackFn: async () => ({ error: "HTTP 404 fetching https://example.com" }),
    });
    const res = await h.analyze_stack({ url: "https://example.com" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain("HTTP 404");
  });
});

describe("analyze_bundle handler", () => {
  it("passes bundleIntel through and serializes intel fields", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    let seenOpts: { bundleIntel?: boolean } | undefined;
    const h = createHandlers({
      client,
      cache,
      bundleFn: async (_url, opts) => {
        seenOpts = opts;
        return {
          url: "https://example.com",
          host: "example.com",
          outDir: join("tmp", "chunks-intel"),
          chunkCount: 1,
          totalBytes: 1,
          chunks: [{ index: 0, url: "https://example.com/a.js", bytes: 1, sha1: "a".repeat(40), path: join("tmp", "0-a.js") }],
          matches: [],
          warnings: [],
          unpacked: false,
          routes: [{ method: "GET", route: "/api/x", foundVia: "axios", chunk: 0 }],
          vendors: [],
          sourceMaps: [],
          moduleGraph: { nodes: 1, edges: 0, truncated: false, externalSpecifiers: [] },
          evidenceCoverage: { status: "complete", collected: 1, excluded: 0, limitations: [] },
        };
      },
    });
    const res = await h.analyze_bundle({ url: "https://example.com", bundleIntel: true });
    expect(res.isError).toBeUndefined();
    expect(seenOpts).toEqual({ bundleIntel: true });
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.routes[0].route).toBe("/api/x");
    expect(parsed.evidenceCoverage.status).toBe("complete");
  });
});

describe("build_gsap_stub handler", () => {
  it("passes args through to the gsap-stub fn and returns JSON", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const seen: Array<{ scrollCensus: unknown; poseGrid?: unknown }> = [];
    const h = createHandlers({
      client,
      cache,
      gsapStubFn: (a) => {
        seen.push(a);
        return { stubHtml: "STUB" };
      },
    });
    const res = await h.build_gsap_stub({ scrollCensus: { anims: [], gsapTriggers: [] }, poseGrid: { canvasW: 0 } });
    expect(res.isError).toBeUndefined();
    expect(seen).toEqual([{ scrollCensus: { anims: [], gsapTriggers: [] }, poseGrid: { canvasW: 0 } }]);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.stubHtml).toBe("STUB");
  });

  it("falls back to the real builder when no fn is injected", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const h = createHandlers({ client, cache });
    const res = await h.build_gsap_stub({ scrollCensus: { anims: [], gsapTriggers: [] } });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.stubHtml).toContain("gsap.registerPlugin(ScrollTrigger)");
    expect(parsed.stubHtml).toContain("no usable scroll-census anims");
  });

  it("rejects a compact census before calling the builder", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    let called = false;
    const h = createHandlers({
      client,
      cache,
      gsapStubFn: () => {
        called = true;
        return { stubHtml: "STUB" };
      },
    });
    const res = await h.build_gsap_stub({
      scrollCensus: { counts: { "gsap-scrolltrigger": 2 }, animCount: 2 },
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain("compact summary");
    expect((res.content[0] as any).text).toContain("compact=false");
    expect(called).toBe(false);
  });

  it("unwraps a census nested under scrollCensus before the builder", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const seen: Array<{ scrollCensus: unknown }> = [];
    const h = createHandlers({
      client,
      cache,
      gsapStubFn: (args) => {
        seen.push(args);
        return { stubHtml: "STUB" };
      },
    });
    const res = await h.build_gsap_stub({
      scrollCensus: { scrollCensus: { anims: [], gsapTriggers: [] } },
    });
    expect(res.isError).toBeUndefined();
    expect(seen[0]?.scrollCensus).toEqual({ anims: [], gsapTriggers: [] });
  });
});

describe("build_motion_manifest handler", () => {
  const census = () =>
    JSON.parse(readFileSync(join(FIXTURES, "build-project", "census.json"), "utf8"));
  const bands = {
    url: "https://example.test/native",
    title: "Native",
    totalHeight: 2000,
    bands: [
      { index: 0, tag: "section", label: "#a", background: "rgb(0, 0, 0)", offsetTop: 0, height: 1000, textStart: "" },
      { index: 1, tag: "section", label: "#b", background: "rgb(0, 0, 0)", offsetTop: 1000, height: 1000, textStart: "" },
    ],
  };

  it("returns the manifest scaffold envelope as JSON", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const h = createHandlers({ client, cache });
    const res = await h.build_motion_manifest({ bands, scrollCensus: census() });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.measured).toBe(false);
    expect(parsed.note).toContain("author motion before shipping");
    expect(parsed.manifest.sections.map((s: any) => s.id)).toEqual(["a", "b"]);
    expect(parsed.manifest.pageTriggers.map((t: any) => t.selector)).toEqual(["#space"]);
    expect(parsed.censusAnims).toBe(census().anims.length);
    expect(parsed.warnings).toEqual([]);
  });

  it("maps invalid input to a { error } isError response, never a throw", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const h = createHandlers({ client, cache });
    const res = await h.build_motion_manifest({ bands: {}, scrollCensus: {} });
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content[0] as any).text).error).toContain("bands:");
  });

  it("rejects a compact census with the rerun hint", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const h = createHandlers({ client, cache });
    const res = await h.build_motion_manifest({
      bands,
      scrollCensus: { counts: { "gsap-scrolltrigger": 2 }, animCount: 2 },
    });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.error).toContain("scrollCensus is a compact summary");
    expect(parsed.error).toContain("compact=false");
  });
});

describe("search_motion handler", () => {
  const dnaFixture = {
    url: "https://example.com/a",
    stack: { libs: ["gsap"], render: ["webgl"], scrollModel: "lenis" as const },
    scroll: { triggerCount: 10, scrubCount: 4, pinCount: 3, scrubRatio: 0.4, sample: [] },
    easingVocab: [{ token: "power2.out", bezier: null, uses: 5 }],
    durationVocab: null,
    capturedAt: Date.now(),
  };

  it("returns compact payloads and honors limit", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    cache.upsertMotionDna(dnaFixture);
    const h = createHandlers({ client, cache });
    const res = await h.search_motion({});
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.count).toBe(1);
    expect(body.results[0]).toEqual({
      url: "https://example.com/a", libs: ["gsap"], scrollModel: "lenis",
      triggerCount: 10, scrubCount: 4, pinCount: 3, topEasing: "power2.out",
    });
  });

  it("filters on lib, scrubOnly and hasPins", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const quiet = { ...dnaFixture, url: "https://example.com/quiet",
      scroll: { triggerCount: 2, scrubCount: 0, pinCount: 0, scrubRatio: 0, sample: [] } };
    cache.upsertMotionDna(quiet);
    cache.upsertMotionDna(dnaFixture);
    const h = createHandlers({ client, cache });
    const urls = async (args: Parameters<ReturnType<typeof createHandlers>["search_motion"]>[0]) =>
      JSON.parse(((await h.search_motion(args)).content[0] as any).text).results.map((r: any) => r.url);
    expect(await urls({ scrubOnly: true })).toEqual(["https://example.com/a"]);
    expect(await urls({ hasPins: true })).toEqual(["https://example.com/a"]);
    // lib matches both rows; insertion order is preserved
    expect(await urls({ lib: "gsap" })).toEqual(["https://example.com/quiet", "https://example.com/a"]);
  });
});

describe("new_winners + watch_site", () => {
  // One listing card per (title, createdAt) with escaped attribute encoding,
  // matching what parseListing reads in the fixture.
  const card = (slug: string, title: string, createdAt: number) =>
    `<li class="col-3 js-collectable" data-collectable-model-value="${JSON.stringify({
      slug, title, createdAt, id: createdAt, tags: ["WebGL"], type: "submission",
      images: { thumbnail: `submissions/2026/09/${slug}.jpg` },
    }).replace(/"/g, "&quot;")}">` +
    `<a href="/sites/${slug}">card</a>` +
    `<a class="figure-rollover__bt" href="https://example.com">live</a>` +
    `<span class="budget-tag--sotd">SOTD</span>` +
    `<h3 class="avatar-name__title">ToyFight</h3></li>`;
  const listingFor = (...cards: string[]) => listingHtml.replace(
    /(<ul class="grid-cards[^>]*>)[\s\S]*(<\/ul>)/,
    (_m, a, b) => a + cards.join("\n") + b,
  );
  // Test-controlled clock: UTC noon on synthetic "day 0" (2026-09-28).
  const now = { ms: Date.UTC(2026, 8, 28, 12) };
  const day = (n: number) => Date.UTC(2026, 8, 28 + n) / 1000; // UTC date n offset from day 0 (2026-09-28)

  it("new_winners seeds then reports a delta and backfills element records", async () => {
    const cache = new Cache(tmpDir());
    const pages: Record<string, string> = {
      "/websites/sites_of_the_day/": listingFor(
        card("day-one", "Day One", day(0) - 3600),
        card("old-one", "Old One", day(-5)),
      ),
      "/sites/day-one": elementsPage(2),
      "/sites/day-two": [
        `<h2 class="text-default">Elements</h2>`,
        `<div data-collectable-model-value="${JSON.stringify({
          collectableTitle: "Hero loop", collectableImage: "element/2026/09/x.mp4",
        }).replace(/"/g, "&quot;")}"></div>`,
        `<h2 class="text-default">Color Palette</h2>`,
      ].join("\n"),
    };
    const fetchFn = vi.fn(async (input: any) => {
      const url = String(input);
      const p = Object.keys(pages).find((k) => url.includes(k));
      if (!p) return new Response("not found", { status: 404 });
      return new Response(pages[p], { status: 200 });
    });
    const client = new AwwwardsClient({ fetchFn: fetchFn as unknown as typeof fetch });
    const h = createHandlers({ client, cache, now: () => now.ms });

    const asJson = (res: { content: { type: string; text?: string }[] }) =>
      (res.content[0] as { text: string }).text;

    // First call seeds the baseline (no rows upserted — nothing is "new").
    const first = await h.new_winners({ award: "sotd" });
    expect(asJson(first)).toContain("no baseline");
    expect(cache.countSites()).toBe(0);

    // Next day: advance the test clock to Sep 29 — one new winner → reported + Elements backfilled.
    now.ms = Date.UTC(2026, 8, 29, 12);
    pages["/websites/sites_of_the_day/"] = listingFor(
      card("day-two", "Day Two", day(1)),
      card("day-one", "Day One", day(0) - 3600),
      card("old-one", "Old One", day(-5)),
    );
    const second = await h.new_winners({ award: "sotd" });
    expect(asJson(second)).toContain("1 new");
    expect(asJson(second)).toContain("backfilled");
    // Backfilled record is searchable.
    const els = JSON.parse(asJson(await h.search_elements({ query: "Hero loop" })));
    expect(els.results.some((r: any) => r.title === "Hero loop" && r.source === "site")).toBe(true);

    // Same-day re-poll (clock still Sep 29): nothing new.
    const third = await h.new_winners({ award: "sotd" });
    expect(asJson(third)).toContain("0 new");
  });

  it("watch_site add/list seeds, then reports deltas from refreshed rows", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([
      site({ slug: "alpha", title: "Alpha", createdAt: day(-1), studio: "ToyFight" }),
      site({ slug: "beta", title: "Beta", createdAt: day(0), studio: "Other" }),
    ]);
    const { client } = fakeClient();
    const h = createHandlers({ client, cache });
    const body = async (args: any) => ((await h.watch_site(args)).content[0] as any).text;

    expect(await body({ action: "add", kind: "studio", pattern: "toyfight", award: "sotd" })).toContain("Watching");
    // First list just seeds (no delta line).
    expect(await body({ action: "list" })).not.toContain("NEW since last check");

    // A new ToyFight site appears in the cache (as new_winners would seed it).
    cache.upsertSites([site({ slug: "gamma", title: "Gamma", createdAt: day(1), studio: "ToyFight" })]);
    const out = await body({ action: "list" });
    expect(out).toContain("toyfight");
    expect(out).toContain("NEW since last check");
    expect(out).toContain("/sites/gamma");

    expect(await body({ action: "remove", kind: "studio", pattern: "toyfight" })).toContain("Removed");
    expect(await body({ action: "remove", kind: "studio", pattern: "toyfight" })).toContain("No watch");
  });
});

describe("analyze_scroll_map handler", () => {
  const census = (): ScrollCensus => ({
    url: "https://example.com/page",
    capturedAt: 1700000000000,
    counts: {
      "gsap-scrolltrigger": 1,
      "css-scroll-timeline": 0,
      "css-view-timeline": 0,
      "data-attr": 0,
      "css-keyframe": 0,
      smil: 0,
      unknown: 0,
    },
    anims: [],
    svgStrokes: [],
    nativeScrollTimelines: 0,
    gsapTriggers: [
      {
        selector: "main>h1",
        scrub: false,
        pin: false,
        startPx: 0,
        endPx: 800,
        progress: 0,
        vars: { stagger: "0.09" },
      },
    ],
    gsapRegistryCount: 1,
    reducedMotion: false,
  });

  it("composes choreography into the JSON additively; census payload unchanged", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const h = createHandlers({ client, cache, scrollMapFn: async () => census() });
    const res = await h.analyze_scroll_map({ url: "https://example.com/page" });
    expect(res.isError).toBeUndefined();
    const payload = JSON.parse((res.content[0] as any).text);
    expect(payload.url).toBe("https://example.com/page");
    expect(payload.gsapTriggers[0].vars.stagger).toBe("0.09");
    expect(payload.choreography).toEqual({
      hints: [{ selector: "main>h1", value: 0.09, source: "tween-var" }],
      groups: 1,
    });
    expect(payload.scrubCurves).toBeUndefined();
  });

  it("error path stays unchanged (no choreography key)", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const h = createHandlers({ client, cache, scrollMapFn: async () => ({ error: "boom" }) });
    const res = await h.analyze_scroll_map({ url: "https://unreachable.example" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toBe("boom");
  });
});

describe("C3 compact response modes", () => {
  const richCensus = (): ScrollCensus => ({
    url: "https://example.com/page",
    capturedAt: 1700000000000,
    counts: {
      "gsap-scrolltrigger": 1,
      "css-scroll-timeline": 0,
      "css-view-timeline": 0,
      "data-attr": 0,
      "css-keyframe": 0,
      smil: 0,
      unknown: 0,
    },
    anims: [
      {
        selector: "main>h1", tag: "h1", props: ["transform"], durationMs: 500,
        delayMs: null, easing: "power2.out", trigger: "gsap-scrolltrigger",
        scrub: true, pin: false, svgStroke: false,
        keyframes: [{ offset: 0, props: { transform: "translateY(0)" } }],
      },
    ],
    svgStrokes: [],
    nativeScrollTimelines: 0,
    gsapTriggers: [
      { selector: "main>h1", scrub: false, pin: false, startPx: 0, endPx: 800, progress: 0, vars: { stagger: "0.09" } },
    ],
    gsapRegistryCount: 1,
    reducedMotion: false,
  });

  it("analyze_scroll_map compact: detail → counts, choreography stays; default keeps everything", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const h = createHandlers({ client, cache, scrollMapFn: async () => richCensus() });
    const compact = await h.analyze_scroll_map({ url: "https://example.com/page", compact: true });
    const body = JSON.parse((compact.content[0] as any).text);
    expect(body.anims).toBeUndefined();
    expect(body.animCount).toBe(1);
    expect(body.scrubCount).toBe(1);
    expect(body.pinCount).toBe(0);
    expect(body.scrubCurves).toBeUndefined();
    expect(body.scrubCurveCount).toBe(0);
    expect(body.counts["gsap-scrolltrigger"]).toBe(1);
    expect(body.gsapRegistryCount).toBe(1);
    expect(body.gsapTriggers[0]).toEqual({ selector: "main>h1", scrub: false, pin: false, startPx: 0, endPx: 800, progress: 0 });
    // The handler-composed trigger hints survive the diet.
    expect(body.choreography).toEqual({ hints: [{ selector: "main>h1", value: 0.09, source: "tween-var" }], groups: 1 });
    expect(JSON.stringify(body)).not.toContain("keyframes");

    // Pin: default (compact absent) response keeps every heavy field.
    const full = await h.analyze_scroll_map({ url: "https://example.com/page" });
    const fullBody = JSON.parse((full.content[0] as any).text);
    expect(fullBody.anims[0].keyframes).toEqual([{ offset: 0, props: { transform: "translateY(0)" } }]);
    expect(fullBody.anims[0].props).toEqual(["transform"]);
    expect(fullBody.gsapTriggers[0].vars).toEqual({ stagger: "0.09" });
  });

  it("analyze_hover_census compact: sample bodies → selectors + count", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const hover = (): HoverCensus => ({
      url: "https://example.com/page",
      capturedAt: 0,
      hoverRuleCount: 4,
      candidates: 2,
      samples: [
        { selector: "a.cta", changedProps: ["transform"], transitionMs: 150, easing: "cubic-bezier(0, 0, 0.2, 1)" },
        { selector: "nav li", changedProps: ["color"], transitionMs: 200, easing: "linear" },
      ],
      note: "touch-only context — hover interactions skipped",
      reducedMotion: false,
    });
    const h = createHandlers({ client, cache, hoverCensusFn: async () => hover() });
    const compact = await h.analyze_hover_census({ url: "https://example.com/page", compact: true });
    const body = JSON.parse((compact.content[0] as any).text);
    expect(body.samples).toBeUndefined();
    expect(body.sampleCount).toBe(2);
    expect(body.sampleSelectors).toEqual(["a.cta", "nav li"]);
    expect(body.note).toBe("touch-only context — hover interactions skipped");

    // compact:false (the reported TypeError case): full payload, no throw.
    const full = await h.analyze_hover_census({ url: "https://example.com/page", compact: false });
    expect(full.isError).toBeFalsy();
    const fullBody = JSON.parse((full.content[0] as any).text);
    expect(fullBody.samples).toHaveLength(2);
    expect(fullBody.samples[0].changedProps).toEqual(["transform"]);
  });

  it("capture_component compact: {tag, classes, rect} skeleton + fonts/colors", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const pack = (): ComponentPack => ({
      id: "component-pack-v1",
      url: "https://example.com/page",
      selector: "header",
      capturedAt: 0,
      viewport: { width: 1440, height: 900 },
      nodeCount: 2,
      root: {
        tag: "header",
        classes: ["hero"],
        rect: { x: 0, y: 0, w: 1440, h: 200 },
        styles: { color: "rgb(0, 0, 0)" },
        anims: [{ props: ["opacity"], durationMs: 300, easing: "linear" }],
        children: [
          {
            tag: "h1",
            classes: ["title"],
            rect: { x: 0, y: 24, w: 640, h: 60 },
            styles: { color: "rgb(255, 255, 255)" },
            text: "Hi",
            children: [],
          },
        ],
      },
      fonts: ["Inter"],
      colors: ["#000000"],
    });
    const h = createHandlers({ client, cache, captureComponentFn: async () => pack() });
    const compact = await h.capture_component({ url: "https://example.com/page", compact: true });
    const body = JSON.parse((compact.content[0] as any).text);
    expect(body.id).toBe("component-pack-v1");
    expect(body.nodeCount).toBe(2);
    expect(body.root).toEqual({
      tag: "header",
      classes: ["hero"],
      rect: { x: 0, y: 0, w: 1440, h: 200 },
      children: [
        { tag: "h1", classes: ["title"], rect: { x: 0, y: 24, w: 640, h: 60 }, children: [] },
      ],
    });
    expect(body.fonts).toEqual(["Inter"]);
    expect(body.colors).toEqual(["#000000"]);
    expect(JSON.stringify(body)).not.toContain("rgb(0, 0, 0)");

    const full = await h.capture_component({ url: "https://example.com/page" });
    const fullBody = JSON.parse((full.content[0] as any).text);
    expect(fullBody.root.styles).toEqual({ color: "rgb(0, 0, 0)" });
    expect(fullBody.root.children[0].text).toBe("Hi");
  });

  it("get_site_details compact: one JSON text block, lists → counts; default pin untouched", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const h = createHandlers({ client, cache });
    const compact = await h.get_site_details({ slug: "l-i-s-a", compact: true });
    expect(compact.content).toHaveLength(1);
    expect(compact.content[0].type).toBe("text");
    const body = JSON.parse((compact.content[0] as any).text);
    expect(body.slug).toBe("l-i-s-a");
    expect(body.palette).toBeUndefined();
    expect(body.technologies).toBeUndefined();
    expect(body.elements).toBeUndefined();
    expect(typeof body.paletteCount).toBe("number");
    expect(typeof body.technologiesCount).toBe("number");
    expect(typeof body.elementsCount).toBe("number");
    expect(Array.isArray(body.awards)).toBe(true);
    expect(typeof body.score).toBe("number");

    // Default stays the pre-existing markdown shape (existing tests pin its
    // text): first block is the markdown text, never the compact JSON.
    const full = await h.get_site_details({ slug: "l-i-s-a" });
    expect(full.content[0].type).toBe("text");
    expect((full.content[0] as any).text).toContain("Live site:");
  });
});

describe("build_project handler (v1.12 — first local-write tool)", () => {
  it("checks htmlPath existence, forwards args to the injected build fn, returns the result JSON", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const dir = tmpDir();
    writeFileSync(join(dir, "site.html"), "<!doctype html><html><body></body></html>");
    const seen: Array<{ html: string; target: string; out: string; name?: string }> = [];
    const h = createHandlers({
      client,
      cache,
      buildProjectFn: async (a) => {
        seen.push(a);
        return { outDir: "/abs/out", target: "next", files: ["package.json", "app/page.tsx"], warnings: ["asset not found: ./assets/gone.png"] };
      },
    });
    const res = await h.build_project({ htmlPath: join(dir, "site.html"), target: "next", out: "out/site", name: "Neu Omni 2" });
    expect(res.isError).toBeUndefined();
    expect(seen).toEqual([{ html: join(dir, "site.html"), target: "next", out: "out/site", name: "Neu Omni 2" }]);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.outDir).toBe("/abs/out");
    expect(parsed.files).toContain("app/page.tsx");
    expect(parsed.warnings).toEqual(["asset not found: ./assets/gone.png"]);
  });

  it("missing html -> isError before the build fn runs; core {error} -> isError; default core reads a real tmp file", async () => {
    const { client } = fakeClient();
    const cache = new Cache(tmpDir());
    const dir = tmpDir();
    writeFileSync(join(dir, "exists.html"), "<!doctype html><html><body></body></html>");
    const seen: unknown[] = [];
    const h = createHandlers({
      client,
      cache,
      buildProjectFn: async (a) => {
        seen.push(a);
        return { error: "cannot read x" };
      },
    });
    const missing = await h.build_project({ htmlPath: join(dir, "nope.html"), target: "vite", out: dir });
    expect(missing.isError).toBe(true);
    expect((missing.content[0] as any).text).toContain("htmlPath does not exist");
    expect(seen).toHaveLength(0);
    const err = await h.build_project({ htmlPath: join(dir, "exists.html"), target: "vite", out: "o" });
    expect(err.isError).toBe(true);
    expect((err.content[0] as any).text).toContain("cannot read x");
    // default path writes a real tree from a real tmp html (offline fs only)
    const h2 = createHandlers({ client, cache });
    const htmlPath = join(dir, "site.html");
    writeFileSync(htmlPath, '<!doctype html><html><body><section class="c-1"><p>x</p></section></body></html>');
    const res = await h2.build_project({ htmlPath, target: "vite", out: join(dir, "proj") });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.target).toBe("vite");
    expect(existsSync(join(dir, "proj", "index.html"))).toBe(true);
  });
});

describe("award filters (Theme A)", () => {
  const listingCalls = (fetchFn: { mock: { calls: unknown[][] } }) =>
    fetchFn.mock.calls.filter((c) => String(c[0]).includes("/websites/")).length;

  it("flags nominee rows on scrape, persists the flag, and re-serves nominees from cache without refetching", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ award: "nominees", count: 6 });
    const body = (res.content[0] as { type: "text"; text: string }).text;
    expect(body).toContain("[nominee]");
    // The flag persisted through the sites table — the persisted marker is
    // the only client-checkable filter for nominee rows (no card badges).
    expect(cache.getSite("l-i-s-a", 7 * 24 * 60 * 60 * 1000)?.nominee).toBe(true);
    const second = await h.search_sites({ award: "nominees", count: 6 });
    expect((second.content[0] as { type: "text"; text: string }).text).toContain("[nominee]");
    expect(listingCalls(fetchFn)).toBe(1); // second call served from cache
  });

  it("does not serve unflagged cache rows for award=nominees (re-scrapes instead)", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site({ slug: "unflagged" })]);
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ award: "nominees", count: 6 });
    const body = (res.content[0] as { type: "text"; text: string }).text;
    expect(body).not.toContain("(slug: unflagged)");
    expect(body).toContain("[nominee]");
    expect(listingCalls(fetchFn)).toBe(1);
  });

  it("re-scrapes winner-category filters — cards carry no verifiable category label", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    await h.search_sites({ award: "ecommerce", count: 6 });
    expect(listingCalls(fetchFn)).toBe(1);
    // Cached rows fail the label check (winner pages stamp no distinct badge),
    // so the empty page window triggers a conservative re-scrape.
    await h.search_sites({ award: "ecommerce", count: 6 });
    expect(listingCalls(fetchFn)).toBe(2);
  });

  it("soty/sotm stay card-verifiable through the expanded award labels", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([
      site({ slug: "soty-winner", awards: ["Site of the Year", "Site of the Day"] }),
      site({ slug: "untagged", awards: [] }),
    ]);
    const { client } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ award: "soty", count: 6 });
    const body = (res.content[0] as { type: "text"; text: string }).text;
    expect(body).toContain("(slug: soty-winner)");
    // The cache row matching the card label passes; a badge-less row never
    // does (the top-up merge may add freshly scraped URL-filter rows, but the
    // untagged cache row itself is filtered out by the client-side check).
    expect(body).not.toContain("(slug: untagged)");
  });
});

describe("technology aliases in matchesFilters (review I1)", () => {
  it("serves cached display-tag rows for alias tokens without refetching", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([
      site({ slug: "warm-a", tags: ["Next.js", "3D"], createdAt: 1789516801, thumbnailPath: "submissions/warm-a.jpg" }),
      site({ slug: "warm-b", tags: ["Next.js", "3D"], createdAt: 1789516800, thumbnailPath: "submissions/warm-b.jpg" }),
    ]);
    const { client, fetchFn } = fakeClient();
    vi.spyOn(client, "getThumbnail").mockResolvedValue(Buffer.from("jpeg"));
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ tags: ["3d", "nextjs"], count: 2 });
    const body = (res.content[0] as { type: "text"; text: string }).text;
    expect(body).toContain("(slug: warm-a)");
    expect(body).toContain("(slug: warm-b)");
    expect(fetchFn).not.toHaveBeenCalled(); // page window filled from cache alone
  });

  it("serves cache for technology: 'nextjs' against display tags", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site({ slug: "nexty", tags: ["Three.js", "Next.js", "Sanity"], thumbnailPath: "submissions/nexty.jpg" })]);
    const { client, fetchFn } = fakeClient();
    vi.spyOn(client, "getThumbnail").mockResolvedValue(Buffer.from("jpeg"));
    const h = createHandlers({ client, cache });
    // count: 1 exactly fills the page window — a partially filled window
    // would top-up-scrape by design (that path is pinned elsewhere).
    const res = await h.search_sites({ technology: "nextjs", count: 1 });
    const body = (res.content[0] as { type: "text"; text: string }).text;
    expect(body).toContain("(slug: nexty)");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("combined color + alias technology keeps matching scraped rows", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ color: "#404040", technology: "nextjs", count: 6 });
    const body = (res.content[0] as { type: "text"; text: string }).text;
    expect(body).toContain("(slug: aspen-search)"); // fixture card tagged Next.js
    expect(body).not.toContain("(slug: l-i-s-a)"); // non-Next.js cards dropped client-side
  });

  it("combined tags+alias and award+alias keep matching scraped rows", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const h = createHandlers({ client, cache });
    const tagsRes = await h.search_sites({ tags: ["3d", "nextjs"], count: 6 });
    expect((tagsRes.content[0] as { type: "text"; text: string }).text).toContain("(slug: warm-fuzzy)");
    const awardRes = await h.search_sites({ award: "sotd", technology: "nextjs", count: 6 });
    expect((awardRes.content[0] as { type: "text"; text: string }).text).toContain("(slug: aspen-search)");
  });
});
describe("list_categories v2 (awards + technologies)", () => {
  it("reports every award filter with its label and the technology facets", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.list_categories();
    const body = JSON.parse((res.content[0] as { type: "text"; text: string }).text);
    expect(body.awards).toHaveLength(12);
    expect(body.awards).toEqual(expect.arrayContaining([
      { filter: "sotd", label: "Site of the Day" },
      { filter: "soty", label: "Site of the Year" },
      { filter: "nominees", label: "Nominee" },
      { filter: "ecommerce", label: "Winners — E-commerce" },
      { filter: "noCode", label: "Winners — No Code" },
    ]));
    // Technologies come from the crawled taxonomy's Technology nav section,
    // in page (usage) order.
    expect(body.technologies[0]).toBe("11ty");
    expect(body.technologies).toContain("next-js");
    expect(body.technologies).toContain("webgl");
    expect(body.technologiesNote).toBeUndefined();
    expect((res.content[0] as { type: "text"; text: string }).text).toContain('"technologies"');
  });
});

describe("list_categories technology drift note (review M2)", () => {
  it("notes crawl-time drift when a taxonomy carries an empty technology section", async () => {
    const cache = new Cache(tmpDir());
    cache.setMeta("categories", { colors: ["#404040"], filters: ["3d"], technologies: [] });
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.list_categories();
    const body = JSON.parse((res.content[0] as { type: "text"; text: string }).text);
    expect(body.technologies).toEqual([]);
    expect(body.technologiesNote).toContain("Technology section not found");
    expect(body.technologiesNote).toContain("crawl-time drift");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("list_categories legacy taxonomy freshness", () => {
  const LEGACY = { colors: ["#404040"], filters: ["3d", "webgl"] };
  const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

  it("refreshes a cache without technologies instead of waiting out the 30-day TTL", async () => {
    const cache = new Cache(tmpDir());
    cache.setMeta("categories", LEGACY);
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.list_categories();
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.technologies).toHaveLength(115);
    expect(body.technologiesNote).toBeUndefined();
    expect(body.taxonomyStale).toBeUndefined();
    expect(body.filterCount).toBeGreaterThan(LEGACY.filters.length);
    expect(fetchFn.mock.calls.filter((c: any[]) => String(c[0]).includes("/websites/"))).toHaveLength(1);
    expect(cache.getMeta<any>("categories", MONTH_MS)?.technologies).toHaveLength(115);
  });

  it("serves the refreshed taxonomy on later calls without another fetch", async () => {
    const cache = new Cache(tmpDir());
    cache.setMeta("categories", LEGACY);
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const cold = await h.list_categories();
    const warm = await h.list_categories();
    expect(JSON.parse((warm.content[0] as any).text)).toEqual(JSON.parse((cold.content[0] as any).text));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("keeps cached filters/colors and flags staleness when the refresh fails", async () => {
    const cache = new Cache(tmpDir());
    cache.setMeta("categories", LEGACY);
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const client = new AwwwardsClient({
      fetchFn: fetchFn as unknown as typeof fetch,
      rateLimiter: new RateLimiter(0),
    });
    const h = createHandlers({ client, cache });
    const res = await h.list_categories();
    const body = JSON.parse((res.content[0] as any).text);
    expect(res.isError).toBeUndefined();
    expect(body.filters).toEqual(LEGACY.filters);
    expect(body.colors).toEqual(LEGACY.colors);
    expect(body.awards).toHaveLength(12);
    expect(body.technologies).toEqual([]);
    expect(body.taxonomyStale).toBe(true);
    expect(body.taxonomyWarning).toContain("refresh failed");
    expect(body.taxonomyWarning).toContain("technology facets remain unavailable");
    expect(body.technologiesNote).toContain("Technology facets were not crawled");
  });

  it("coalesces concurrent legacy-taxonomy refreshes into one fetch", async () => {
    const cache = new Cache(tmpDir());
    cache.setMeta("categories", LEGACY);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchFn = vi.fn(async () => {
      await gate;
      return new Response(listingHtml, { status: 200 });
    });
    const client = new AwwwardsClient({ fetchFn: fetchFn as unknown as typeof fetch });
    const h = createHandlers({ client, cache });
    const pending = Promise.all([h.list_categories(), h.list_categories(), h.list_categories()]);
    release();
    const results = await pending;
    expect(fetchFn).toHaveBeenCalledTimes(1);
    for (const res of results) {
      expect(JSON.parse((res.content[0] as any).text).technologies.length).toBeGreaterThan(0);
    }
  });

  it("coalesces concurrent failed refreshes and marks one backoff", async () => {
    const cache = new Cache(tmpDir());
    cache.setMeta("categories", LEGACY);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchFn = vi.fn(async () => {
      await gate;
      throw new Error("ECONNRESET");
    });
    const client = new AwwwardsClient({
      fetchFn: fetchFn as unknown as typeof fetch,
      rateLimiter: new RateLimiter(0),
    });
    const h = createHandlers({ client, cache });
    const pending = Promise.all([h.list_categories(), h.list_categories(), h.list_categories()]);
    release();
    const results = await pending;
    // One coalesced refresh; the client's single transient retry accounts for the second fetch.
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(cache.getMeta<boolean>("categories:refresh-failed", 60_000)).toBe(true);
    for (const res of results) {
      expect(JSON.parse((res.content[0] as any).text)).toMatchObject({
        taxonomyStale: true,
        filters: LEGACY.filters,
      });
    }
  });

  it("does not retry a failed refresh before the backoff expires, then retries once", async () => {
    let now = 1_000_000;
    const cache = new Cache(tmpDir(), () => now);
    cache.setMeta("categories", LEGACY);
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const client = new AwwwardsClient({
      fetchFn: fetchFn as unknown as typeof fetch,
      rateLimiter: new RateLimiter(0),
    });
    const h = createHandlers({ client, cache });
    const first = await h.list_categories();
    const attempts = fetchFn.mock.calls.length;
    expect(attempts).toBeGreaterThan(0);

    now += TAXONOMY_RETRY_MS - 1;
    const second = await h.list_categories();
    expect(fetchFn.mock.calls.length).toBe(attempts);
    expect(JSON.parse((second.content[0] as any).text)).toMatchObject({
      taxonomyStale: true,
      filters: LEGACY.filters,
      colors: LEGACY.colors,
    });
    expect((first.content[0] as any).text).toContain("refresh failed");
    expect((second.content[0] as any).text).toContain("next attempt is deferred");

    now += 2;
    await h.list_categories();
    expect(fetchFn.mock.calls.length).toBe(attempts + 2);
  });

  it("rejects a refresh that loses its color facet and keeps cached colors", async () => {
    const cache = new Cache(tmpDir());
    cache.setMeta("categories", LEGACY);
    const noColors = listingHtml.replaceAll("/websites/%23", "/websites/%24");
    const { client } = clientFor(noColors);
    const h = createHandlers({ client, cache });
    const res = await h.list_categories();
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.filters).toEqual(LEGACY.filters);
    expect(body.colors).toEqual(LEGACY.colors);
    expect(body.taxonomyStale).toBe(true);
    expect(body.taxonomyWarning).toContain("parsed 0 categories");
    expect(cache.getMeta<any>("categories", MONTH_MS)?.colors).toEqual(LEGACY.colors);
  });

  it("treats an empty refresh parse as a failed refresh, not a fresh taxonomy", async () => {
    const cache = new Cache(tmpDir());
    cache.setMeta("categories", LEGACY);
    const { client } = clientFor("<html><body>nothing</body></html>");
    const h = createHandlers({ client, cache });
    const res = await h.list_categories();
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.taxonomyStale).toBe(true);
    expect(body.taxonomyWarning).toContain("parsed 0 categories");
    expect(body.filters).toEqual(LEGACY.filters);
    expect(body.colors).toEqual(LEGACY.colors);
    expect(cache.getMeta<any>("categories", MONTH_MS)?.technologies).toBeUndefined();
  });
});

describe("audit_url and verify_build compact payloads", () => {
  const findingOf = (
    ruleId: string,
    severity: "HIGH" | "MEDIUM" | "INFO" | undefined,
    source: "css" | "html" | "js",
    line: number,
    improvements: string,
  ) => ({
    ruleId,
    severity,
    source,
    line,
    message: ruleId,
    why: "test",
    improvements,
  });

  const auditReport = () => ({
    url: "https://example.com/",
    perf: { error: "No Chrome or Edge found." },
    antiPatterns: {
      count: 4,
      high: 2,
      medium: 1,
      info: 1,
      worst: "blur-heavy",
      findings: [
        findingOf("blur-heavy", "HIGH", "css", 3, "Keep blurs under 10px."),
        findingOf("scroll-nonpassive", "HIGH", "js", 2, "Pass { passive: true }."),
        findingOf("fixed-position", "MEDIUM", "css", 8, "Avoid fixed overlays."),
        findingOf("animated-property", undefined, "css", 12, "Animate transform."),
      ],
    },
    coverage: { assetsScanned: 2, failed: 1 },
    nextActions: [
      "blur-heavy at css:3 — Keep blurs under 10px.",
      "scroll-nonpassive at js:2 — Pass { passive: true }.",
      "fixed-position at css:8 — Avoid fixed overlays.",
    ],
    note: "Evidence only — not a performance grade.",
  });

  const auditHandler = () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    return createHandlers({ client, cache, auditUrlFn: async () => auditReport() });
  };

  it("audit_url compact returns counts plus nextActions and no finding bodies", async () => {
    const res = await auditHandler().audit_url({ url: "https://example.com/", compact: true });
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(Object.keys(parsed).sort()).toEqual([
      "antiPatterns",
      "coverage",
      "nextActions",
      "note",
      "perf",
      "url",
    ]);
    expect(parsed.antiPatterns).toMatchObject({
      count: 4,
      worst: "blur-heavy",
      high: 2,
      medium: 1,
      info: 1,
    });
    expect(parsed.antiPatterns.high).toBeTypeOf("number");
    expect(parsed.antiPatterns.medium).toBeTypeOf("number");
    expect(parsed.antiPatterns.info).toBeTypeOf("number");
    expect(parsed.antiPatterns.findings).toBeUndefined();
    expect(parsed.nextActions).toEqual(auditReport().nextActions);
    expect(parsed.coverage).toEqual({ assetsScanned: 2, failed: 1 });
  });

  it("audit_url compact passes perf and antiPatterns errors through unchanged", async () => {
    const degraded = {
      ...auditReport(),
      antiPatterns: {
        ...auditReport().antiPatterns,
        error: "Page HTML could not be fetched (HTTP error, timeout, or over 2MB).",
      },
    };
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const h = createHandlers({ client, cache, auditUrlFn: async () => degraded });
    const res = await h.audit_url({ url: "https://example.com/", compact: true });
    const parsed = JSON.parse((res.content[0] as any).text);
    // Degraded halves are reported, not hidden or replaced by zeros.
    expect(parsed.perf).toEqual({ error: "No Chrome or Edge found." });
    expect(parsed.antiPatterns.error).toBe(degraded.antiPatterns.error);
    expect(parsed.antiPatterns.count).toBe(4);
  });

  it("audit_url full payload keeps findings and gains nextActions", async () => {
    const res = await auditHandler().audit_url({ url: "https://example.com/" });
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.antiPatterns.findings).toHaveLength(4);
    // Full perf and the pre-cap severity counts stay in the full payload.
    expect(parsed.antiPatterns.high).toBe(2);
    expect(parsed.antiPatterns.medium).toBe(1);
    expect(parsed.antiPatterns.info).toBe(1);
    expect(parsed.perf).toEqual({ error: "No Chrome or Edge found." });
    expect(parsed.nextActions).toEqual(auditReport().nextActions);
    expect(parsed.note).toBe("Evidence only — not a performance grade.");
  });

  it("audit_url compact reduces a successful perf block and drops chrome details", () => {
    const full: AuditUrlResult = {
      ...auditReport(),
      perf: {
        seconds: 4,
        frames: 240,
        fps: 60,
        droppedFrames: 1,
        worstFrameMs: 18,
        longTaskCount: 2,
        longTaskMaxMs: 55,
        longAnimationFrameCount: 1,
        longAnimationFrameMaxBlockingMs: 40,
        layoutThrashCount: 3,
        measureBeforeCompositeCount: 4,
        layoutReads: 10,
        styleWrites: 6,
        scrollListeners: [{ type: "scroll", passive: false }],
        animationsAtEnd: 2,
        chromePath: "C:\\fake\\chrome.exe",
      },
    };
    const parsed = compactAuditResult(full);
    expect(parsed.perf).toEqual({
      fps: 60,
      droppedFrames: 1,
      longTasks: 2,
      layoutThrashing: 3,
    });
    expect(Object.keys(parsed.perf).sort()).toEqual([
      "droppedFrames",
      "fps",
      "layoutThrashing",
      "longTasks",
    ]);
    expect("chromePath" in parsed.perf).toBe(false);
    expect("scrollListeners" in parsed.perf).toBe(false);
    // Full payload still carries the whole measurement.
    expect(full.perf).toMatchObject({ chromePath: "C:\\fake\\chrome.exe" });
  });

  it("audit_url compact maps pre-cap counts that can exceed the bounded findings", () => {
    const full: AuditUrlResult = {
      ...auditReport(),
      antiPatterns: {
        count: 60,
        high: 1,
        medium: 9,
        info: 50,
        worst: "blur-heavy",
        findings: auditReport().antiPatterns.findings,
      },
    };
    const parsed = compactAuditResult(full);
    expect(parsed.antiPatterns).toMatchObject({
      count: 60,
      high: 1,
      medium: 9,
      info: 50,
    });
    expect(parsed.antiPatterns.high + parsed.antiPatterns.medium + parsed.antiPatterns.info)
      .toBeGreaterThan(full.antiPatterns.findings.length);
    expect("findings" in parsed.antiPatterns).toBe(false);
  });

  const verifyReport = () => ({
    buildUrl: "https://b.test/",
    referenceUrl: "https://r.test/",
    bands: { score: 82, matched: ["hero", "main"], refOnly: ["footer"], buildOnly: [] },
    motion: { score: 64, refFingerprint: "ref-fp", buildFingerprint: "build-fp" },
    overall: 75,
    verdict: "warn",
    evidence: ["Bands: 82/100", "Motion: 64/100", "Overall: 75/100 → WARN"],
  });

  const verifyHandler = () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    return createHandlers({ client, cache, verifyBuildFn: async () => verifyReport() });
  };

  it("verify_build compact returns verdict and scores without evidence", async () => {
    const res = await verifyHandler().verify_build({
      buildUrl: "https://b.test/",
      referenceUrl: "https://r.test/",
      compact: true,
    });
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed).toEqual({
      verdict: "warn",
      overall: 75,
      bands: { score: 82, matched: 2, refOnly: 1, buildOnly: 0 },
      motion: { score: 64 },
    });
    expect("evidence" in parsed).toBe(false);
    expect("domDiff" in parsed).toBe(false);
  });

  it("verify_build full payload is unchanged", async () => {
    const res = await verifyHandler().verify_build({
      buildUrl: "https://b.test/",
      referenceUrl: "https://r.test/",
    });
    expect(JSON.parse((res.content[0] as any).text)).toEqual(verifyReport());
  });
});
