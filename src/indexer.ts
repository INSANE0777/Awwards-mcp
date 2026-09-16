import { parseCategories, parseListing } from "./parsers.js";
import { AwwwardsClient } from "./awwwards.js";
import type { Cache } from "./cache.js";
import type { Categories } from "./types.js";

export const INDEX_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const INDEX_LOCK_STALE_MS = 30 * 60 * 1000;
// Same value as server.ts CATEGORY_TTL_MS; redeclared to avoid importing the
// server module (and its MCP wiring) into the indexer.
const CATEGORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface IndexResult {
  pagesDone: number;
  pagesTotal: number;
  sitesIndexed: number;
  skipped: number;
}

export class IndexLockError extends Error {
  constructor() {
    super("another index run is in progress");
  }
}

interface IndexStatus {
  startedAt?: number;
  finishedAt?: number;
  pagesDone: number;
  pagesTotal: number;
  sitesIndexed: number;
  lastError?: string;
}

export function isIndexStale(cache: Cache, now: () => number = Date.now): boolean {
  const status = cache.getMeta<IndexStatus>("index:status", Number.POSITIVE_INFINITY);
  if (!status || !status.finishedAt) return true;
  // >= so the exact INDEX_STALE_MS boundary already counts as stale, matching
  // the lock boundary semantics (exact boundary = expired).
  return now() - status.finishedAt >= INDEX_STALE_MS;
}

export function shouldAutoIndex(cache: Cache, now: () => number = Date.now): boolean {
  const lock = cache.getMeta<{ startedAt: number }>("index:lock", Number.POSITIVE_INFINITY);
  if (lock && now() - lock.startedAt < INDEX_LOCK_STALE_MS) return false;
  return isIndexStale(cache, now);
}

export async function runIndexer(deps: {
  client: AwwwardsClient;
  cache: Cache;
  now?: () => number;
  log?: (msg: string) => void;
}): Promise<IndexResult> {
  const { client, cache } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});

  const lock = cache.getMeta<{ startedAt: number }>("index:lock", Number.POSITIVE_INFINITY);
  if (lock && now() - lock.startedAt < INDEX_LOCK_STALE_MS) throw new IndexLockError();
  cache.setMeta("index:lock", { startedAt: now() });

  try {
    let cats = cache.getMeta<Categories>("categories", CATEGORY_TTL_MS);
    if (!cats || cats.filters.length === 0) {
      cats = parseCategories(await client.getHtml("/websites/"));
      if (cats.filters.length === 0) {
        throw new Error(
          "Awwwards layout may have changed: parsed 0 categories. The awwwards-mcp parser likely needs an update.",
        );
      }
      cache.setMeta("categories", cats);
    }
    const tags = cats.filters;
    const done = new Set(cache.getMeta<string[]>("index:progress", Number.POSITIVE_INFINITY) ?? []);
    const result = await crawl({ client, cache, now, log }, tags, done);
    cache.setMeta("index:status", {
      startedAt: result.startedAt,
      finishedAt: now(),
      pagesDone: done.size,
      pagesTotal: tags.length,
      sitesIndexed: result.sitesIndexed,
    });
    return {
      pagesDone: result.pagesDone,
      pagesTotal: tags.length,
      sitesIndexed: result.sitesIndexed,
      skipped: result.skipped,
    };
  } finally {
    cache.deleteMeta("index:lock");
  }
}

async function crawl(
  deps: { client: AwwwardsClient; cache: Cache; now: () => number; log: (msg: string) => void },
  tags: string[],
  done: Set<string>,
): Promise<{ pagesDone: number; sitesIndexed: number; skipped: number; startedAt: number }> {
  const { client, cache, now, log } = deps;
  const startedAt = now();
  const skipped = [...tags].filter((t) => done.has(t)).length;
  let sitesIndexed = 0;
  let pagesDone = 0;
  for (const tag of tags) {
    if (done.has(tag)) continue;
    const html = await client.getHtml(`/websites/${encodeURIComponent(tag)}/`);
    const sites = parseListing(html);
    cache.upsertSites(sites);
    sitesIndexed += sites.length;
    pagesDone += 1;
    done.add(tag);
    cache.setMeta("index:progress", [...done]);
    log(`[${done.size}/${tags.length}] ${tag}: ${sites.length} sites`);
  }
  return { pagesDone, sitesIndexed, skipped, startedAt };
}
