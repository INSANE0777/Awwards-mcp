export const BASE_URL = "https://www.awwwards.com";
export const ASSETS_URL = "https://assets.awwwards.com";

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 awwwards-mcp/1.0";

export const AWARD_FILTERS = {
  sotd: "websites/sites_of_the_day",
  developer: "websites/developer",
  honorable: "websites/honorable",
} as const;

export type AwardFilter = keyof typeof AWARD_FILTERS;

export interface SearchFilters {
  color?: string;
  tags?: string[];
  technology?: string;
  award?: AwardFilter;
  query?: string;
}

// Combined filter URLs return 404 on awwwards.com (verified 2026-09-17), so
// exactly one filter is used in the URL — the most specific one. The caller
// applies the remaining filters client-side over the parsed results.
export function buildFilterUrl(filters: SearchFilters): string {
  if (filters.color) {
    return `${BASE_URL}/websites/%23${filters.color.replace("#", "").toUpperCase()}/`;
  }
  if (filters.award) return `${BASE_URL}/${AWARD_FILTERS[filters.award]}/`;
  const tag = filters.technology ?? filters.tags?.[0];
  if (tag) return `${BASE_URL}/websites/${encodeURIComponent(tag.toLowerCase())}/`;
  return `${BASE_URL}/websites/`;
}

export function thumbnailUrl(thumbPath: string, size: 440 | 880 = 880): string {
  const dim = size === 880 ? "880_660" : "440_330";
  return `${ASSETS_URL}/awards/media/cache/thumb_${dim}/${thumbPath}`;
}

export class BlockedError extends Error {
  constructor(
    url: string,
    public status: number,
  ) {
    super(
      `Awwwards is blocking requests (HTTP ${status} on ${url}). ` +
        "Try again later; the tool never retries through blocks.",
    );
  }
}

export class RateLimiter {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private intervalMs: number) {}

  acquire(): Promise<void> {
    const next = this.chain.then(async () => {
      const wait = this.last + this.intervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

export class AwwwardsClient {
  private rateLimiter: RateLimiter;
  private fetchFn: typeof fetch;

  constructor(opts: { rateLimiter?: RateLimiter; fetchFn?: typeof fetch } = {}) {
    this.rateLimiter = opts.rateLimiter ?? new RateLimiter(1000);
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  // Rate-limited page fetch with one retry on transient failures.
  // Blocks (403/429) are never retried.
  async getHtml(path: string): Promise<string> {
    const url = path.startsWith("http") ? path : BASE_URL + path;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.rateLimiter.acquire();
        const res = await this.fetchFn(url, {
          headers: { "User-Agent": USER_AGENT },
          redirect: "follow",
        });
        if (res.status === 403 || res.status === 429) throw new BlockedError(url, res.status);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return await res.text();
      } catch (err) {
        if (err instanceof BlockedError) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  // Thumbnail fetch from the CDN — not rate-limited.
  async getThumbnail(thumbPath: string, size: 440 | 880 = 880): Promise<Buffer> {
    const res = await this.fetchFn(thumbnailUrl(thumbPath, size), {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching thumbnail ${thumbPath}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
