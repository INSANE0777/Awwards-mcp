# Awwwards MCP — Design Spec

Date: 2026-09-17
Status: Approved by user (design conversation, 2026-09-17)

## Problem

Mobbin's MCP server gives AI agents 600k+ real UI screens from shipped products, returned inline so agents design from real patterns. It is paid. Awwwards.com hosts the web's best award-winning sites — screenshots, color palettes, tech stacks, award metadata — but there is no official MCP server for it, and existing community attempts are thin (static datasets or unrelated tools).

## Goal

Build a free, open-source MCP server (`awwwards-mcp`) that gives AI agents the Mobbin experience sourced from Awwwards: search award-winning sites, see real screenshots inline, and extract design DNA (palette, technologies, elements, awards). Personal use plus publication to GitHub/npm.

## Decisions made

| Decision | Choice |
|----------|--------|
| Data source | Hybrid: live scrape with SQLite cache |
| Screenshots in results | Awwwards' own thumbnails (880×660) inline as base64; optional fresh full-page capture tool |
| Audience | Personal use + open-source publish (npm `awwwards-mcp`, MIT) |
| Runtime | TypeScript on Node.js (≥20), official MCP SDK, stdio transport |

## Verified data sources (probed live, 2026-09-17)

- `https://www.awwwards.com/websites/` — server-rendered HTML, ~32 site cards per page. Each card embeds structured JSON (`data-collectable-model-value`): `id`, `slug`, `title`, `createdAt` (unix), `tags[]`, thumbnail path. Card markup also carries the live site URL and the detail path `/sites/<slug>`. Thumbnails: `https://assets.awwwards.com/awards/media/cache/thumb_440_330/<path>` (1x) and `thumb_880_660` (2x).
- Filter taxonomy (all plain URLs, no query string needed): colors `/websites/%23<HEX>/`, tags `/websites/<tag>/` (e.g. `3d`, `webgl`, `404-pages`), technologies, font names, countries. Hundreds of filter pages exist.
- Detail pages `https://www.awwwards.com/sites/<slug>` — award title + date (e.g. "Site of the Day - Sep 16, 2026"), "Color Palette" section (`palette__list` with hex codes), "Technologies & Tools" tag list, "Elements" list, description text, `og:image` (full-size screenshot).
- `robots.txt`: `Disallow: /websites/?` (paginated URLs), `/search-websites`, `/inspiration/search`. **Allowed**: `/websites/` base, `/websites/<filter>/` pages, `/sites/<slug>` detail pages, `sitemap.xml`. The old public API (`api.awwwards.com`) is dead.
- No Cloudflare challenge encountered with a normal browser User-Agent.

**Consequence:** search happens through the filter taxonomy (tags × colors × technologies), not query-string pagination. Depth comes from the breadth of filter pages.

## Architecture

```
┌──────────────┐   stdio JSON-RPC   ┌────────────────────┐
│ Claude Code / │ ◄───────────────► │  awwwards-mcp       │
│ Cursor / etc. │                   │  (Node ≥20 + TS)    │
└──────────────┘                    │  ├ server.ts   MCP  │
                                    │  ├ awwwards.ts HTTP │──► www.awwwards.com (1 req/s, robots-compliant)
                                    │  ├ parsers.ts HTML  │──► assets.awwwards.com (thumbnails, CDN)
                                    │  └ cache.ts  SQLite │    ~/.awwwards-mcp/cache.db + images/
                                    └────────────────────┘
```

Four modules, single-purpose, independently testable:

- **`server.ts`** — MCP stdio server via `@modelcontextprotocol/sdk`. Registers tools, maps tool args → client calls → MCP content blocks (text + image).
- **`awwwards.ts`** — HTTP client. Polite browser User-Agent; token-bucket rate limit of 1 request/second to `www.awwwards.com`; retries once with exponential backoff; separate no-limit fetcher for the `assets.awwwards.com` CDN.
- **`parsers.ts`** — pure functions: saved HTML strings → typed objects. `parseListing(html)` → `SiteSummary[]`; `parseDetail(html)` → `SiteDetails`; `parseCategories(html)` → taxonomies. Zero network, zero I/O — fixture-testable.
- **`cache.ts`** — SQLite via `better-sqlite3` at `~/.awwwards-mcp/cache.db`. Tables: `sites` (metadata, TTL 7 days), `meta` (category taxonomy, TTL 30 days). Thumbnails cached as files in `~/.awwwards-mcp/images/<hash>.jpg`, keyed by asset path, no TTL (immutable content).

## Tools exposed to agents

| Tool | Input | Output |
|------|-------|--------|
| `search_sites` | `query?` (string, matched against title/tags), `color?` (hex), `tags?` (string[]), `technology?`, `award?` (`sotd`\|`developer`\|`honorable`), `count?` (default 6, max 12), `page?` (default 1) | Per site: title, slug, live URL, awwwards URL, award + date, tags, thumbnail inline as base64 image content |
| `get_site_details` | `slug` | Color palette (hex list), technologies & tools, design elements, description, award history, full-size screenshot URL, thumbnail inline |
| `list_categories` | — | Tag taxonomy, color list, technology list (cached 30 days) — lets the agent discover valid search keys |
| `capture_live_site` | `url` | Fresh full-page screenshot via Playwright headless Chromium. **Optional dependency**: if Playwright is not installed, the tool returns clear install instructions instead of erroring |

Query resolution: `search_sites` maps the agent's natural language to filter combinations (e.g. "dark 3D portfolios" → `color: #404040` + `tags: ["3d", "portfolio"]`), using `list_categories` output when unsure. Free-text `query` is applied as a client-side filter over the scraped result set (title/tags match); Awwwards' own search endpoint is disallowed by robots.txt and is not used.

## Data flow

1. `search_sites` → compute filter URL(s) → cache lookup (TTL 7 days) → on miss/expiry: fetch and parse 1–2 filter pages → upsert sites.
2. Thumbnails: fetch from CDN cache-first → store on disk → embed as base64 image content blocks.
3. `get_site_details` → cache lookup (TTL 7 days) → on miss: fetch detail page → parse → upsert.
4. Responses cap inline images (6 default) and paginate via `page` argument on the tool.

## Error handling

- **Network failure**: retry once (exponential backoff), then serve stale cache if present, else clear error naming the failed step.
- **Markup change**: parser yields zero cards/details → error: "Awwwards layout may have changed; parser mismatch at <step>". No silent empty results.
- **Blocking (403 / captcha)**: exponential backoff + explicit message "Awwwards is rate-limiting; try again later". Never hammer.
- **Robots compliance**: only allowed paths are requested (filter pages, detail pages, sitemap). No `?page=` pagination. 1 req/s to `www.awwwards.com`.
- **Playwright missing**: `capture_live_site` returns instructions (`npm i playwright && npx playwright install chromium`) rather than failing the server.

## Testing

- Unit tests (vitest): `parsers.ts` against saved HTML fixtures (real pages captured once into `test/fixtures/`); cache round-trips on a temp DB. No network in CI.
- Live smoke test (manual, not in CI): script fetches one listing page + one detail page and asserts parse counts > 0.
- Manual acceptance: `npx @modelcontextprotocol/inspector` — exercise all four tools.

## Packaging & open source

- npm package `awwwards-mcp`, `bin: { "awwwards-mcp": "dist/cli.js" }`, MIT license.
- README: one-line config snippets for Claude Desktop, Claude Code, Cursor; screenshot example; ethics section (personal inspiration use; respect awwwards.com ToS and robots.txt; no bulk redistribution of their screenshots).
- CI (GitHub Actions): typecheck, lint, unit tests on Node 20 and 22.

## Out of scope (v1)

- Bulk scraping / full database of all Awwwards sites (sitemap-driven indexer) — possible v2.
- Text extraction or HTML analysis of the live awarded sites (beyond optional screenshot).
- Authentication, hosted/remote transport (HTTP/SSE), multi-user deployment.
- Fuzzy semantic image search over screenshots (needs embeddings storage).
