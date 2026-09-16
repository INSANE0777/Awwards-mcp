# Awwwards MCP — Local Index Design Spec

Date: 2026-09-17
Status: Approved by user (design conversation, 2026-09-17)
Parent spec: `2026-09-17-awwwards-mcp-design.md` (v1, shipped)

## Problem

`search_sites` (v1) serves from a cache populated only by ad-hoc scrapes — typically one filter page (~31 sites) per unique search. Robots.txt disallows `?page=` pagination, so live depth is capped. Result: thin result sets for specific searches and a live request on nearly every first-time query.

## Goal

A resumable background indexer that walks the robots-compliant tag taxonomy and stores every discovered site in the existing SQLite cache, so `search_sites` draws from thousands of rows instantly. Manual trigger plus automatic refresh when stale.

## Decisions made

| Decision | Choice |
|----------|--------|
| Crawl breadth | All tag/technology filter pages (~198 pages ≈ 4 min at 1 req/s). Colors/awards still scrape live on demand. |
| Detail pages | On demand only (as in v1) — index stores listing metadata (title, slug, tags, thumbnail path, award badges, live URL, date). |
| Trigger | Manual `awwwards-index` CLI **plus** auto-refresh on MCP server startup when the index is older than 7 days (background, non-blocking). |

## Architecture

```
src/indexer.ts      runIndexer(deps): IndexResult
src/index-cli.ts    bin "awwwards-index": real client+cache, progress logging, exit codes
src/cli.ts          (changed) background auto-refresh on startup when stale
cache.ts            no schema change — sites table + meta table suffice
```

### `runIndexer(deps: { client: AwwwardsClient; cache: Cache; now?: () => number; log?: (msg: string) => void }): Promise<IndexResult>`

- Discovers taxonomy via `parseCategories` on `/websites/` (meta-cached 30 days, same as `list_categories`).
- For each tag: `GET /websites/<tag>/` → `parseListing` → `cache.upsertSites` (slug-keyed dedup) → record tag done in meta `index:progress` (JSON array of completed tags).
- Status in meta `index:status`: `{ startedAt, finishedAt, pagesDone, pagesTotal, sitesIndexed, lastError? }`.
- Concurrency lock: meta `index:lock` = start timestamp; a run refuses to start if a lock exists younger than 30 minutes (throws `IndexLockError`); a lock older than 30 minutes is stale and is taken over.
- Rate limiting: uses its own `AwwwardsClient` (1 req/s to `www.awwwards.com`; CDN untouched). Accepted trade-off: while a background index runs alongside serving, combined worst case is ~2 req/s for the crawl duration.
- `IndexResult = { pagesDone: number; pagesTotal: number; sitesIndexed: number; skipped: number; aborted: false }` on success; aborts throw.

### CLI (`index-cli.ts`, bin `awwwards-index`)

- Builds real `AwwwardsClient` + `Cache` (same cache root resolution as the server: `AWWWARDS_CACHE_DIR ?? ~/.awwwards-mcp`).
- Logs progress per page ("12/198 tags, 344 sites so far").
- Exit 0 on success (including `IndexLockError` — "another index is running" is a healthy no-op); exit 1 on abort (blocked / parser mismatch), after persisting progress.

### Server startup auto-refresh (`cli.ts` change)

- After the stdio server connects, check `index:status.finishedAt` (via meta): if absent or older than 7 days, and no live lock, spawn `runIndexer` fire-and-forget. Startup and serving are never blocked; failures are logged to stderr only.

## Data flow

1. `awwwards-index` → taxonomy → tag pages at 1 req/s → upsert per page → mark done → write final status.
2. Re-run loads the done-set and skips those pages (interrupted crawls resume without re-hitting).
3. `search_sites` logic is unchanged: fresh rows now number in the thousands, so the live-scrape fallback becomes the exception. `get_site_details` still fetches on demand and caches 7 days.
4. Freshness: sites TTL (7 days) and index TTL (7 days) are aligned — expired rows and a stale index trigger a background re-crawl on next server start, or an explicit manual run.

## Error handling

- **Blocked (403/429)**: abort crawl, keep done-set, status records `lastError: "blocked"`, CLI exits 1. Next run resumes.
- **Markup change (0 cards parsed on a page)**: abort with a parser-mismatch error (same contract as the v1 tools); page NOT marked done.
- **Concurrent runs**: lock refuses the second run with a clear message; CLI exits 0 in that case.
- **Stale lock** (>30 min, e.g. crash): taken over automatically.
- **First run on a fresh install via server auto-refresh**: index runs in background; meanwhile v1 live-scrape behavior serves searches.

## Testing

- `indexer.test.ts` (offline, fake client, injectable clock): all tags fetched exactly once; resume skips done tags; dedup through upsertSites; BlockedError aborts, persists progress, throws; parser-mismatch (0 cards) aborts and does not mark done; lock blocks a second run; stale lock is taken over.
- `index-cli` / auto-refresh decision logic: stale/absent/fresh index and lock states → background run fires or not (runIndexer injected/spied).
- Live verification (manual): run `awwwards-index` for real (~198 pages), confirm thousands of rows; then a live stdio `search_sites` returning deep results without a live page fetch.

## Out of scope

- Pre-fetching detail pages (palette/elements/tech) for indexed sites.
- Colors × tags matrix crawl; award-collection pages in the crawl.
- Scheduled/cron re-indexing; HTTP-transport remote index; multi-source adapters.
