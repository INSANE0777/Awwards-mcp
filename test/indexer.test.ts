import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INDEX_LOCK_STALE_MS,
  IndexLockError,
  INDEX_STALE_MS,
  isIndexStale,
  runIndexer,
  shouldAutoIndex,
} from "../src/indexer.js";
import { AwwwardsClient, RateLimiter } from "../src/awwwards.js";
import { parseCategories } from "../src/parsers.js";
import { Cache } from "../src/cache.js";

const FIXTURES = join(__dirname, "fixtures");
const listingHtml = readFileSync(join(FIXTURES, "listing.html"), "utf8");
const tags = parseCategories(listingHtml).filters; // sorted, ~198
const firstTag = tags[0];

const dirs: string[] = [];
const tmpDir = () => {
  const d = mkdtempSync(join(tmpdir(), "awwwards-idx-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Fake client: no rate limit, serves the listing fixture for every URL,
// records every requested URL. Per-URL overrides let tests inject blocks
// or broken markup for specific tag pages.
function fakeClient(overrides: Map<string, () => Promise<Response>> = new Map()) {
  const urls: string[] = [];
  const fetchFn = vi.fn(async (input: any) => {
    const url = String(input);
    urls.push(url);
    const override = [...overrides.entries()].find(([needle]) => url.includes(needle));
    if (override) return override[1]();
    return new Response(listingHtml, { status: 200 });
  });
  const client = new AwwwardsClient({
    fetchFn: fetchFn as unknown as typeof fetch,
    rateLimiter: new RateLimiter(0), // offline tests must not sleep at 1 req/s
  });
  return { client, urls, fetchFn };
}

describe("isIndexStale / shouldAutoIndex", () => {
  it("is stale when no status exists", () => {
    const cache = new Cache(tmpDir());
    expect(isIndexStale(cache)).toBe(true);
    expect(shouldAutoIndex(cache)).toBe(true);
  });

  it("is fresh right after a successful index", () => {
    const cache = new Cache(tmpDir());
    cache.setMeta("index:status", { startedAt: 1, finishedAt: 2 });
    expect(isIndexStale(cache, () => 2 + INDEX_STALE_MS - 1)).toBe(false);
    expect(shouldAutoIndex(cache, () => 2 + INDEX_STALE_MS - 1)).toBe(false);
  });

  it("goes stale after INDEX_STALE_MS", () => {
    const cache = new Cache(tmpDir());
    cache.setMeta("index:status", { startedAt: 1, finishedAt: 2 });
    expect(isIndexStale(cache, () => 2 + INDEX_STALE_MS)).toBe(true);
  });

  it("shouldAutoIndex is false while a live lock is held", () => {
    const cache = new Cache(tmpDir());
    cache.setMeta("index:lock", { startedAt: 100 });
    expect(shouldAutoIndex(cache, () => 100 + INDEX_LOCK_STALE_MS - 1)).toBe(false);
    expect(shouldAutoIndex(cache, () => 100 + INDEX_LOCK_STALE_MS)).toBe(true);
  });
});

describe("runIndexer", () => {
  it("crawls every tag page once, upserts sites, and writes status", async () => {
    const cache = new Cache(tmpDir());
    const { client, urls } = fakeClient();
    const logs: string[] = [];
    const result = await runIndexer({ client, cache, log: (m) => logs.push(m) });

    expect(result.pagesTotal).toBe(tags.length);
    expect(result.pagesDone).toBe(tags.length);
    expect(result.skipped).toBe(0);
    expect(result.sitesIndexed).toBe(result.pagesDone * 31); // fixture: 31 cards per page
    expect(urls.filter((u) => u.includes("/websites/" + firstTag)).length).toBe(1);
    // unique sites: the fixture's 31 cards upserted repeatedly dedup by slug
    expect(cache.getSites(60_000).length).toBe(31);
    const status = cache.getMeta<any>("index:status", 10_000);
    expect(status.finishedAt).toBeGreaterThan(0);
    expect(cache.getMeta<string[]>("index:progress", 10_000)!.length).toBe(tags.length);
    expect(logs.length).toBe(tags.length);
    expect(cache.getMeta("index:lock", 10_000)).toBeNull(); // released
  });

  it("resume skips already-done tags", async () => {
    const cache = new Cache(tmpDir());
    cache.setMeta("index:progress", [firstTag, tags[1]]);
    const { client, urls } = fakeClient();
    const result = await runIndexer({ client, cache });

    expect(result.skipped).toBe(2);
    expect(result.pagesDone).toBe(tags.length - 2);
    expect(urls.filter((u) => u.includes("/websites/" + firstTag + "/")).length).toBe(0);
    expect(urls.filter((u) => u.includes("/websites/" + tags[1] + "/")).length).toBe(0);
  });

  it("refuses to run while a fresh lock is held", async () => {
    const cache = new Cache(tmpDir());
    let t = 1_000_000;
    cache.setMeta("index:lock", { startedAt: t });
    const { client } = fakeClient();
    await expect(
      runIndexer({ client, cache, now: () => t + INDEX_LOCK_STALE_MS - 1 }),
    ).rejects.toBeInstanceOf(IndexLockError);
    // no page was fetched (taxonomy fetch happens after the lock check)
    expect(cache.getMeta("index:status", 10_000)).toBeNull();
  });

  it("takes over a stale lock", async () => {
    const cache = new Cache(tmpDir());
    let t = 1_000_000;
    cache.setMeta("index:lock", { startedAt: t });
    const { client } = fakeClient();
    const result = await runIndexer({ client, cache, now: () => t + INDEX_LOCK_STALE_MS });
    expect(result.pagesDone).toBe(tags.length);
  });
});
