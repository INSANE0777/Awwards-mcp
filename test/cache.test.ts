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

const site = (slug: string): SiteSummary => ({
  id: 1,
  slug,
  title: "Test Site",
  createdAt: 1789516800,
  tags: ["3D", "WebGL"],
  thumbnailPath: "submissions/2026/08/abc.jpg",
  liveUrl: "https://example.com",
  detailPath: `/sites/${slug}`,
  awards: ["Site of the Day"],
});

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
});
