import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AwwwardsClient } from "../src/awwwards.js";
import { Cache } from "../src/cache.js";
import { prepareSitePage } from "../src/atlas/ingest.js";
import { sha256Text } from "../src/atlas/identity.js";
import { createHandlers } from "../src/server.js";
import type { ElementRecord, SiteSummary } from "../src/types.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-callers-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 8, 28, 12);
const fixture = readFileSync(join("test", "fixtures", "detail.html"), "utf8");
const listingHtml = readFileSync(join("test", "fixtures", "listing.html"), "utf8");

function siteRow(rows: ElementRecord[]) {
  return rows
    .filter((row) => row.source === "site")
    .map((row) => ({
      slug: row.slug,
      title: row.title,
      mediaPath: row.mediaPath,
      mediaType: row.mediaType,
      source: row.source,
      siteSlug: row.siteSlug,
      author: row.author,
      cid: row.cid,
      category: row.category,
      builtWith: row.builtWith,
    }))
    .sort((a, b) => a.mediaPath.localeCompare(b.mediaPath));
}

function expectedRows(slug: string, html: string, author: string) {
  const prepared = prepareSitePage({
    slug,
    html,
    fetchedAt: NOW,
    sourceUrl: `https://www.awwwards.com/sites/${slug}`,
    summary: null,
  });
  return prepared.highlights
    .map((item) => ({
      slug: `site-${slug}-${sha256Text(item.mediaPath)}`,
      title: item.title,
      mediaPath: item.mediaPath,
      mediaType: item.mediaPath.endsWith(".mp4") ? "video" : "image",
      source: "site" as const,
      siteSlug: slug,
      author,
      cid: "uncategorized",
      category: "uncategorized",
      builtWith: [] as string[],
    }))
    .sort((a, b) => a.mediaPath.localeCompare(b.mediaPath));
}

const cachedSite: SiteSummary = {
  id: 7,
  slug: "l-i-s-a",
  title: "LISA",
  createdAt: 1,
  tags: [],
  thumbnailPath: "submissions/2026/08/l-i-s-a.jpg",
  liveUrl: null,
  detailPath: "/sites/l-i-s-a",
  awards: ["Site of the Day"],
  studio: "ToyFight",
};

function countingClient(pages: (url: string) => string | null) {
  const fetchFn = vi.fn(async (input: any) => {
    const url = String(input);
    const body = pages(url);
    return body === null
      ? new Response("not found", { status: 404 })
      : new Response(body, { status: 200 });
  });
  const client = new AwwwardsClient({ fetchFn: fetchFn as unknown as typeof fetch });
  vi.spyOn(client, "getAsset").mockResolvedValue(Buffer.from("jpeg"));
  return { client, fetchFn };
}

const pageCalls = (fetchFn: ReturnType<typeof vi.fn>, slug: string) =>
  fetchFn.mock.calls.filter((call) => String(call[0]).includes(`/sites/${slug}`)).length;

describe("atlas shared ingestion callers", () => {
  it("detail view then element view uses one page fetch and one element projection", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    cache.upsertSites([cachedSite]);
    const { client, fetchFn } = countingClient((url) =>
      url.includes("/sites/l-i-s-a") ? fixture : listingHtml,
    );
    const h = createHandlers({ client, cache, now: () => NOW });

    await h.get_site_details({ slug: "l-i-s-a" });
    await h.get_site_elements({ slug: "l-i-s-a" });

    expect(pageCalls(fetchFn, "l-i-s-a")).toBe(1);
    expect(siteRow(cache.listElements(100))).toEqual(
      expectedRows("l-i-s-a", fixture, "ToyFight"),
    );
  });

  it("element view then detail view uses one page fetch and the same rows", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    cache.upsertSites([cachedSite]);
    const { client, fetchFn } = countingClient((url) =>
      url.includes("/sites/l-i-s-a") ? fixture : listingHtml,
    );
    const h = createHandlers({ client, cache, now: () => NOW });

    await h.get_site_elements({ slug: "l-i-s-a" });
    await h.get_site_details({ slug: "l-i-s-a" });

    expect(pageCalls(fetchFn, "l-i-s-a")).toBe(1);
    expect(siteRow(cache.listElements(100))).toEqual(
      expectedRows("l-i-s-a", fixture, "ToyFight"),
    );
  });

  it("winners backfill feeds detail and element views without another fetch", async () => {
    const now = { ms: NOW };
    const day = (n: number) => Date.UTC(2026, 8, 28 + n) / 1000;
    const card = (slug: string, title: string, createdAt: number) =>
      `<li class="col-3 js-collectable" data-collectable-model-value="${JSON.stringify({
        slug, title, createdAt, id: createdAt, tags: ["WebGL"], type: "submission",
        images: { thumbnail: `submissions/2026/09/${slug}.jpg` },
      }).replace(/"/g, "&quot;")}">` +
      `<a href="/sites/${slug}">card</a>` +
      `<a class="figure-rollover__bt" href="https://example.com">live</a>` +
      `<span class="budget-tag--sotd">SOTD</span>` +
      `<h3 class="avatar-name__title">ToyFight</h3></li>`;
    const listingFor = (...cards: string[]) =>
      listingHtml.replace(
        /(<ul class="grid-cards[^>]*>)[\s\S]*(<\/ul>)/,
        (_m, a, b) => a + cards.join("\n") + b,
      );
    const pages: Record<string, string> = {
      "/websites/sites_of_the_day/": listingFor(card("day-one", "Day One", day(0) - 3600)),
      "/sites/day-one": fixture,
      "/sites/day-two": fixture,
    };
    const cache = new Cache(tmpDir(), () => now.ms, { atlas: true });
    const { client, fetchFn } = countingClient((url) => {
      const key = Object.keys(pages).find((path) => url.includes(path));
      return key ? pages[key]! : null;
    });
    const h = createHandlers({ client, cache, now: () => now.ms });

    await h.new_winners({ award: "sotd" }); // seed baseline
    now.ms = Date.UTC(2026, 8, 29, 12);
    pages["/websites/sites_of_the_day/"] = listingFor(
      card("day-two", "Day Two", day(1)),
      card("day-one", "Day One", day(0) - 3600),
    );
    await h.new_winners({ award: "sotd" });

    expect(pageCalls(fetchFn, "day-two")).toBe(1);
    await h.get_site_details({ slug: "day-two" });
    await h.get_site_elements({ slug: "day-two" });
    expect(pageCalls(fetchFn, "day-two")).toBe(1);
    expect(siteRow(cache.listElements(100)).filter((row) => row.siteSlug === "day-two"))
      .toEqual(expectedRows("day-two", fixture, "ToyFight"));
  });
});
