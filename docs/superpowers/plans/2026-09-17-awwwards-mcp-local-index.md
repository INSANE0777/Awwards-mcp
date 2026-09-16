# Local Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a resumable `awwwards-index` crawler that walks all ~198 tag filter pages into the existing SQLite cache (manual CLI + auto-refresh on server startup when stale), so `search_sites` draws from thousands of rows instantly.

**Architecture:** New `src/indexer.ts` (`runIndexer` + staleness/lock helpers) reusing `AwwwardsClient`, `parseCategories`, `parseListing` and the existing `Cache` (no schema change, one new method: `deleteMeta`). New `src/index-cli.ts` bin. `src/cli.ts` gains a fire-and-forget background auto-refresh. Spec: `docs/superpowers/specs/2026-09-17-awwwards-mcp-local-index-design.md`.

**Tech Stack:** Existing stack only — TypeScript 5 strict ESM, `node:sqlite`, vitest, `@modelcontextprotocol/sdk` + `zod`. No new dependencies.

## Global Constraints

- Max 1 request/second to `www.awwwards.com` is preserved in production; tests MUST inject `new RateLimiter(0)` into the fake client or the suite sleeps for minutes.
- Robots-compliant paths only: the crawler requests `/websites/` and `/websites/<tag>/` — nothing else. Tags come from `parseCategories` output (already slug-shaped `[a-z0-9-]+`).
- Offline unit tests only; the real crawl is a manual verification step, never in CI.
- Meta keys (exact strings): `index:progress` (JSON string[] of completed tags), `index:status` (`{ startedAt?, finishedAt?, pagesDone, pagesTotal, sitesIndexed, lastError? }`), `index:lock` (`{ startedAt }`), `categories` (shared with `list_categories`).
- Constants: `INDEX_STALE_MS = 7 * 24 * 60 * 60 * 1000`, `INDEX_LOCK_STALE_MS = 30 * 60 * 1000`, indexer's taxonomy TTL `30 * 24 * 60 * 60 * 1000` (same value as `CATEGORY_TTL_MS` in server.ts — redeclared locally to avoid indexer→server import; note this in a comment).
- CLI logging goes to **stderr** (`console.error`) — the MCP server's stdout is the JSON-RPC channel; never `console.log`.
- Cache root resolution identical to the server: `process.env.AWWWARDS_CACHE_DIR ?? join(homedir(), ".awwwards-mcp")`.
- Committing to `main` is the approved workflow. Working tree must be clean after every task.
- Current suite baseline: 39/39 tests. Target after this plan: 47/47.

---

### Task 1: Cache.deleteMeta + indexer core (happy path, resume, locking, staleness)

**Files:**
- Modify: `src/cache.ts` (add one method to the Cache class)
- Create: `src/indexer.ts`
- Modify: `test/cache.test.ts` (append one test)
- Create: `test/indexer.test.ts`

**Interfaces:**
- Consumes: `AwwwardsClient.getHtml(path)`, `parseCategories(html) → { colors, filters }`, `parseListing(html) → SiteSummary[]`, `cache.upsertSites`, `cache.getMeta<T>(key, maxAgeMs)`, `cache.setMeta(key, value)`, `new RateLimiter(intervalMs)` (for test injection).
- Produces (exact surface later tasks rely on, from `src/indexer.js`):
  - `INDEX_STALE_MS: number`, `INDEX_LOCK_STALE_MS: number`
  - `class IndexLockError extends Error`
  - `interface IndexResult { pagesDone: number; pagesTotal: number; sitesIndexed: number; skipped: number }`
  - `isIndexStale(cache: Cache, now?: () => number): boolean` — true when `index:status.finishedAt` is absent or older than `INDEX_STALE_MS`
  - `shouldAutoIndex(cache: Cache, now?: () => number): boolean` — `!lockHeld && isIndexStale`
  - `runIndexer(deps: { client: AwwwardsClient; cache: Cache; now?: () => number; log?: (msg: string) => void }): Promise<IndexResult>`
- Cache gains: `deleteMeta(key: string): void`.

- [ ] **Step 1: Write failing tests for deleteMeta (append to test/cache.test.ts, inside the existing top-level describe)**

```ts
it("deletes meta keys", () => {
  const cache = new Cache(tmpDir());
  cache.setMeta("index:lock", { startedAt: 1 });
  expect(cache.getMeta<any>("index:lock", 10_000)).toEqual({ startedAt: 1 });
  cache.deleteMeta("index:lock");
  expect(cache.getMeta("index:lock", 10_000)).toBeNull();
  cache.deleteMeta("index:lock"); // idempotent
  expect(cache.getMeta("index:lock", 10_000)).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/cache.test.ts`
Expected: FAIL — `cache.deleteMeta is not a function`.

- [ ] **Step 3: Implement deleteMeta (add inside the Cache class in src/cache.ts, after getMeta)**

```ts
  deleteMeta(key: string): void {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }
```

- [ ] **Step 4: Run cache tests to green**

Run: `npx vitest run test/cache.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write failing indexer tests (create test/indexer.test.ts)**

```ts
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
```

```ts
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
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run test/indexer.test.ts`
Expected: FAIL — `../src/indexer.js` cannot be resolved.

- [ ] **Step 7: Implement src/indexer.ts**

```ts
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
  return now() - status.finishedAt > INDEX_STALE_MS;
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
```

and, in the same file, the crawl loop as a private helper (kept separate so abort handling can be added in Task 2 without reshaping runIndexer). Note its `now`/`log` are REQUIRED — runIndexer passes the normalized versions:

```ts
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
```

Note on the spec's 0-cards guard: abort handling (blocked + parser-mismatch) is added in Task 2 — this task's happy path assumes the fixture serves valid cards for every tag.

- [ ] **Step 8: Run indexer tests to green**

Run: `npx vitest run test/indexer.test.ts`
Expected: PASS (7 tests). If the "crawls every tag page" test is slow, confirm the fake client uses `RateLimiter(0)`.

- [ ] **Step 9: Full suite + commit**

Run: `npm test`
Expected: PASS — 47/47 tests total (39 existing + 1 deleteMeta + 7 indexer).

```bash
git add src/cache.ts src/indexer.ts test/cache.test.ts test/indexer.test.ts
git commit -m "feat: resumable index crawler core (lock, resume, staleness)"
```

---

### Task 2: Abort paths — blocked crawl and parser mismatch

**Files:**
- Modify: `src/indexer.ts` (status error recording + per-page guards)
- Modify: `test/indexer.test.ts` (append tests)

**Interfaces:**
- Consumes: everything from Task 1; `BlockedError` from `src/awwwards.js`.
- Produces: on any abort, `runIndexer` (1) persists the done-set (already per-page), (2) records `lastError` in `index:status` (status object preserved with `pagesDone/pagesTotal/sitesIndexed` so far), (3) releases the lock (existing finally), (4) rethrows. A page yielding 0 cards is a parser mismatch and is NOT marked done.

- [ ] **Step 1: Write failing tests (append to the runIndexer describe)**

```ts
it("aborts on block, preserves progress, records lastError, releases lock", async () => {
  const cache = new Cache(tmpDir());
  const secondTag = tags[1];
  const { client } = fakeClient(
    new Map([[`/websites/${secondTag}/`, () => new Response("blocked", { status: 403 })]]),
  );
  await expect(runIndexer({ client, cache })).rejects.toBeInstanceOf(BlockedError);
  const progress = cache.getMeta<string[]>("index:progress", 10_000)!;
  expect(progress).toContain(firstTag); // first page completed before the block
  expect(progress).not.toContain(secondTag);
  const status = cache.getMeta<any>("index:status", 10_000);
  expect(status.lastError).toMatch(/block|403/i);
  expect(cache.getMeta("index:lock", 10_000)).toBeNull();
  // resume after the block completes the rest
  const { client: client2 } = fakeClient();
  const result = await runIndexer({ client: client2, cache });
  expect(result.skipped).toBe(progress.length);
});

it("aborts on parser mismatch and does not mark the page done", async () => {
  const cache = new Cache(tmpDir());
  const secondTag = tags[1];
  const { client } = fakeClient(
    new Map([[`/websites/${secondTag}/`, () => new Response("<html><body>nothing</body></html>", { status: 200 })]]),
  );
  await expect(runIndexer({ client, cache })).rejects.toThrow(/parsed 0 site cards/);
  const progress = cache.getMeta<string[]>("index:progress", 10_000)!;
  expect(progress).toContain(firstTag);
  expect(progress).not.toContain(secondTag);
  const status = cache.getMeta<any>("index:status", 10_000);
  expect(status.lastError).toContain(secondTag);
});
```

Add `BlockedError` to the existing import from `../src/awwwards.js`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/indexer.test.ts`
Expected: the two new tests FAIL (no lastError recorded today; blocked test's first assertion may pass but status/lastError assertions fail).

- [ ] **Step 3: Implement (modify src/indexer.ts)**

Single-writer rule for `index:status`: the crawl loop itself never writes status; the catch handler in `runIndexer` is the only abort writer.

Add a per-page guard inside the `crawl` loop, replacing the current 4 lines from `const html = ...` through `const sites = parseListing(html);`:

```ts
    const html = await client.getHtml(`/websites/${encodeURIComponent(tag)}/`);
    const sites = parseListing(html);
    if (sites.length === 0) {
      throw new Error(
        `Awwwards layout may have changed: parsed 0 site cards on /websites/${tag}/. ` +
          "The awwwards-mcp parser likely needs an update.",
      );
    }
    cache.upsertSites(sites);
```

Wrap the `runIndexer` body so any abort records `lastError` before rethrowing. Replace the `try { ... } finally { ... }` region with:

```ts
  try {
    // ... taxonomy + crawl exactly as in Task 1 ...
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
  } catch (err) {
    const previous = cache.getMeta<IndexStatus>("index:status", Number.POSITIVE_INFINITY);
    const progress = (cache.getMeta<string[]>("index:progress", Number.POSITIVE_INFINITY) ?? []).length;
    cache.setMeta("index:status", {
      startedAt: previous?.startedAt,
      pagesDone: progress,
      pagesTotal: tagsCount(cache),
      sitesIndexed: previous?.sitesIndexed ?? 0,
      lastError: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    cache.deleteMeta("index:lock");
  }
```

with a tiny helper so the catch can report the intended total even when the abort happened before the finish-write:

```ts
function tagsCount(cache: Cache): number {
  return (
    cache.getMeta<IndexStatus>("index:status", Number.POSITIVE_INFINITY)?.pagesTotal ??
    (cache.getMeta<Categories>("categories", CATEGORY_TTL_MS)?.filters.length ?? 0)
  );
}
```

(Abort before the taxonomy is fetched — e.g. an unexpected failure of the taxonomy fetch itself — records `pagesTotal: 0`, which is accurate. `sitesIndexed` on abort is the previous run's value or 0; exact per-run counts are only guaranteed on success.)

- [ ] **Step 4: Run indexer tests to green, then full suite**

Run: `npx vitest run test/indexer.test.ts && npm test`
Expected: PASS — 9 indexer tests; 49 total.

- [ ] **Step 5: Commit**

```bash
git add src/indexer.ts test/indexer.test.ts
git commit -m "feat: indexer abort handling (blocks, parser mismatch) with resumable progress"
```

---

### Task 3: awwwards-index CLI

**Files:**
- Create: `src/index-cli.ts`
- Modify: `package.json` (add bin entry)

**Interfaces:**
- Consumes: `runIndexer`, `IndexLockError` (Task 1/2), `AwwwardsClient`, `Cache`.
- Produces: executable bin `awwwards-index` → `dist/index-cli.js`; exit 0 on success or lock, 1 on abort.

- [ ] **Step 1: Write src/index-cli.ts**

```ts
#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { AwwwardsClient } from "./awwwards.js";
import { Cache } from "./cache.js";
import { runIndexer, IndexLockError } from "./indexer.js";

const cacheRoot = process.env.AWWWARDS_CACHE_DIR ?? join(homedir(), ".awwwards-mcp");
let cache: Cache;
try {
  cache = new Cache(cacheRoot);
} catch (err) {
  console.error(`awwwards-index: cannot initialize cache at ${cacheRoot}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const client = new AwwwardsClient();
try {
  const result = await runIndexer({ client, cache, log: (m) => console.error(m) });
  console.error(
    `awwwards-index: done — ${result.pagesDone} pages crawled, ${result.skipped} skipped, ` +
      `${result.sitesIndexed} site rows upserted (${result.pagesTotal} tags total)`,
  );
  process.exit(0);
} catch (err) {
  if (err instanceof IndexLockError) {
    console.error(`awwwards-index: ${err.message}`);
    process.exit(0);
  }
  console.error(`awwwards-index aborted: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
```

- [ ] **Step 2: Register the bin in package.json**

Change:

```json
  "bin": { "awwwards-mcp": "dist/cli.js" },
```

to:

```json
  "bin": { "awwwards-mcp": "dist/cli.js", "awwwards-index": "dist/index-cli.js" },
```

- [ ] **Step 3: Build, typecheck, sanity-run the CLI against the real site (manual, ~198 requests / ~4 min)**

Run: `npm run build && npm run typecheck`
Expected: clean; `dist/index-cli.js` exists.

Run: `AWWWARDS_CACHE_DIR="$(mktemp -d)" node dist/index-cli.js 2>&1 | tail -3`
Expected: stderr progress lines ending with `awwwards-index: done — ...`; exit code 0. This performs the real crawl (~4 min at 1 req/s). If awwwards blocks (aborted message), record it, wait 60s, and retry once; if it blocks twice, report BLOCKED with the message.

- [ ] **Step 4: Commit**

```bash
git add src/index-cli.ts package.json
git commit -m "feat: awwwards-index CLI bin for manual full-taxonomy crawls"
```

---

### Task 4: Server auto-refresh on startup

**Files:**
- Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `shouldAutoIndex`, `runIndexer`, `IndexLockError` from `src/indexer.js`; existing `cache` and `client` instances already constructed in cli.ts.
- Produces: on server startup with a stale index and no live lock, a fire-and-forget background crawl; serving is never blocked; failures logged to stderr only.

- [ ] **Step 1: Add the background auto-refresh to src/cli.ts**

Add to the existing indexer import (this file has none yet — add):

```ts
import { runIndexer, shouldAutoIndex } from "./indexer.js";
```

Then, immediately BEFORE the `await server.connect(new StdioServerTransport());` line, insert:

```ts
// Auto-refresh: if the index is stale (or absent) and no crawl is running,
// re-index in the background. Serving is never blocked; errors are stderr-only.
if (shouldAutoIndex(cache)) {
  void runIndexer({ client, cache, log: (m) => console.error(m) }).catch((err) => {
    console.error(
      `awwwards-mcp: background index failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}
```

Note: stderr is safe here — only stdout carries the MCP JSON-RPC protocol. (If `client`/`cache` local names differ in the current file, use the actual ones — they are the same instances passed to `createHandlers`.)

- [ ] **Step 2: Build and verify with stdio probes**

Run: `npm run build && npm run typecheck && npm test`
Expected: all clean, 49/49 tests.

Fresh-index probe (background crawl must NOT fire — use a temp cache pre-seeded as fresh):

```bash
PROBE=$(mktemp -d)
node --input-type=module -e "
const { Cache } = await import('./dist/cache.js');
const c = new Cache(process.argv[1]);
c.setMeta('index:status', { startedAt: 1, finishedAt: Date.now(), pagesDone: 1, pagesTotal: 1, sitesIndexed: 1 });
" "$PROBE"
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | AWWWARDS_CACHE_DIR="$PROBE" timeout 10 node dist/cli.js 2>stderr.txt
echo "--- stderr (must NOT contain crawl progress lines like '[1/'):"; head -3 stderr.txt
```

Expected: tools/list returns 4 tools; stderr shows no crawl progress lines. (The `node -e` uses dynamic import with top-level await — requires `--input-type=module`; if it errors, run it as `node --input-type=module -e "..."`.)

Stale-index probe (background crawl DOES fire — then kill it quickly; do not let it finish the full 4-minute crawl):

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.0"}}}' \
  | AWWWARDS_CACHE_DIR="$(mktemp -d)" timeout 5 node dist/cli.js 2>&1 | head -3
```

Expected: within the first seconds, stderr shows crawl progress lines like `[1/198] ... sites` (proof the background crawl fired on a stale/absent index), then the timeout kills the process — that is the expected outcome.

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: background index auto-refresh on server startup when stale"
```

---

### Task 4b: Search over the indexed cache — verify depth (controller check, no code)

**Files:** none (verification task)

- [ ] **Step 1: Verify a search now draws from thousands of indexed rows without a page fetch**

Using the cache the Task 3 real crawl populated (its `mktemp -d` dir — or re-run the crawl into a fresh dir if it was cleaned):

```bash
IDX=$(mktemp -d)
AWWWARDS_CACHE_DIR="$IDX" node dist/index-cli.js 2>&1 | tail -1   # real crawl (~4 min)
printf '%s\n%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_sites","arguments":{"technology":"webgl","count":12}}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_categories"}}' \
  | AWWWARDS_CACHE_DIR="$IDX" node dist/cli.js 2>/dev/null | head -c 2000
```

Expected: id 2 returns a text block reporting thousands of matched sites with 12 image blocks — served from the index (only CDN thumbnail requests in stderr, no `/websites/` page fetches). If results are thin for `webgl` specifically (legitimately few sites on page 1 of that filter), try `award: "sotd"` instead — the assertion that matters is `pagesTotal`-scale coverage: `getSites` row count in the thousands.

Record the observed numbers in the report. No commit (nothing changed).

---

### Task 5: README documentation + final verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: documented user-facing behavior; final green suite.

- [ ] **Step 1: Add an "Indexing (recommended)" section to README.md, immediately after the "Setup" section**

```markdown
## Indexing (recommended)

`search_sites` works out of the box, but its depth is limited by polite live
scraping (~31 sites per filter page). Build a local index once and searches
draw from thousands of award-winning sites instantly:

```bash
npx awwwards-index
```

- Crawls all ~200 tag pages at 1 request/second (~4 minutes) into the local
  SQLite cache at `~/.awwwards-mcp/`.
- Resumable: interrupt it and re-run — completed pages are skipped.
- The MCP server re-indexes automatically in the background whenever the
  index is older than 7 days (never blocking your session).

Site details (palettes, tech stacks) are still fetched on demand and cached
for 7 days.
```

- [ ] **Step 2: Full verification pass**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green — 49/49 tests.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document awwwards-index and background auto-refresh"
```

---

## Post-plan notes for the implementer

- Every commit lands on `main` (established workflow for this repo).
- The Task 3 and Task 4b live crawls hit awwwards.com ~198 + ~198 times at 1 req/s. Run them once each, not repeatedly. If awwwards blocks, record and retry once after 60s per the Global Constraints etiquette.
- If parse counts drift from the fixture-era numbers (198 tags / 31 cards per page), trust the live pages, adjust assertions to floors (`toBeGreaterThanOrEqual`) rather than exact values, and note it in the commit message.
- Suite target: 49/49 (39 baseline + 1 deleteMeta + 7 indexer + 2 abort).
