import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AwwwardsClient,
  BlockedError,
  RateLimiter,
  buildFilterUrl,
  thumbnailUrl,
} from "../src/awwwards.js";

const FIXTURES = join(__dirname, "fixtures");
const listingHtml = () => readFileSync(join(FIXTURES, "listing.html"), "utf8");

describe("RateLimiter", () => {
  afterEach(() => vi.useRealTimers());

  it("serializes calls at least intervalMs apart", async () => {
    vi.useFakeTimers();
    const rl = new RateLimiter(1000);
    const stamps: number[] = [];
    const track = async () => {
      await rl.acquire();
      stamps.push(Date.now());
    };
    const a = track();
    const b = track();
    const c = track();
    await vi.advanceTimersByTimeAsync(2500);
    await Promise.all([a, b, c]);
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(999);
    expect(stamps[2] - stamps[1]).toBeGreaterThanOrEqual(999);
  });
});

describe("buildFilterUrl", () => {
  // Combined filter URLs 404 on awwwards.com (verified 2026-09-17), so exactly
  // one filter wins the URL; priority color > award > technology > first tag.
  it("picks the single most specific filter", () => {
    expect(buildFilterUrl({ color: "#404040" })).toBe(
      "https://www.awwwards.com/websites/%23404040/",
    );
    expect(buildFilterUrl({ award: "sotd" })).toBe(
      "https://www.awwwards.com/websites/sites_of_the_day/",
    );
    expect(buildFilterUrl({ technology: "WebGL", tags: ["3d"] })).toBe(
      "https://www.awwwards.com/websites/webgl/",
    );
    expect(buildFilterUrl({ tags: ["3d", "portfolio"] })).toBe(
      "https://www.awwwards.com/websites/3d/",
    );
    expect(buildFilterUrl({})).toBe("https://www.awwwards.com/websites/");
  });
});

describe("thumbnailUrl", () => {
  it("builds CDN urls in both sizes", () => {
    const p = "submissions/2026/08/abc.jpg";
    expect(thumbnailUrl(p, 880)).toContain("/thumb_880_660/" + p);
    expect(thumbnailUrl(p, 440)).toContain("/thumb_440_330/" + p);
  });
});

describe("AwwwardsClient", () => {
  const fakeFetch = (body: string | number, status = 200) =>
    vi.fn(async () =>
      new Response(typeof body === "string" ? body : "blocked", {
        status: typeof body === "string" ? status : body,
      }),
    ) as unknown as typeof fetch;

  it("fetches and parses a listing page through the rate limiter", async () => {
    const client = new AwwwardsClient({ fetchFn: fakeFetch(listingHtml()) });
    const html = await client.getHtml("/websites/");
    expect(html).toContain("card-site");
  });

  it("throws BlockedError immediately on 403 without retrying", async () => {
    const fetchFn = fakeFetch(403);
    const client = new AwwwardsClient({ fetchFn });
    await expect(client.getHtml("/websites/")).rejects.toBeInstanceOf(BlockedError);
    expect((fetchFn as any).mock.calls.length).toBe(1);
  });

  it("retries once on a network error then succeeds", async () => {
    const calls = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(new Response(listingHtml(), { status: 200 }));
    const client = new AwwwardsClient({ fetchFn: calls as unknown as typeof fetch });
    const html = await client.getHtml("/websites/");
    expect(html).toContain("card-site");
    expect(calls.mock.calls.length).toBe(2);
  });
});
