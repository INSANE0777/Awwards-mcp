# Awwwards MCP — v1.5.0 Reliability & Motion Release Design Spec

Date: 2026-09-18
Status: Approved by user (menu selection, all four items)
Parent specs: v1, local-index, element-visuals, page-structure designs. Version target: 1.5.0.

All four items come from demonstrated pain in the first real skill-loop run (editorial-site build, 2026-09-17/18) — none are speculative.

## A. Capture reliability fix (demonstrated: ORDR timeouts, The Meridian invisible reveals)

**Problem 1:** `capture_live_site` and `analyze_page_structure` time out at the ~30s MCP ceiling on heavy live sites — `waitUntil: "networkidle"` never settles when analytics keep firing.
**Fix:** both tools default to `waitUntil: "load"` + a fixed settle (~3s) before their work; `networkidle` remains available via an optional `waitStrategy: "load" | "networkidle"` argument (default `"load"`). analyze_page_structure keeps its scroll-through.

**Problem 2:** `capture_live_site` takes fullPage screenshots without scrolling first — IntersectionObserver reveals below the fold render invisible (confirmed on The Meridian: entire sections blank in the capture while `analyze_page_structure` showed them present).
**Fix:** capture runs the same pre-scroll loop as analyze (450px steps, brief settle, return to top) before `page.screenshot({ fullPage: true })`.

## B. `record_site_motion` — 7th tool (workflow validated on cerebrium.ai + The Meridian)

Wraps the validated recorder (`scripts/record-scrollthrough.mjs` logic) as an MCP tool:

- `record_site_motion({ url, frames? })` → Playwright `recordVideo` context; sequence: preloader dwell (~7s) → slow scroll-through → interaction pass (virtual cursor SVG injected and following `page.mouse`; up to 16 hover targets discovered via classic selectors + `cursor: pointer` regions, evenly spread down the page; ≤4 safe same-page clicks) → return to top.
- Returns: the **filmstrip inline** (ffmpeg-static tiled JPEG, 1 frame / ~4s — models cannot watch video, frames are the payload) + the `.webm` file path as text. ffmpeg-static is a devDependency; if missing, return install instructions as isError (same optional-dep contract as playwright).
- Films are saved to the cache images dir; old recordings are overwritten per URL+name hash.
- `frames` param: filmstrip tile count (default 16, 4×4).

## C. Search UX fixes (demonstrated: `query: "editorial magazine"` can never match)

- **Tokenized query:** `search_sites`' free-text `query` is split on whitespace; a site matches when EVERY token matches (title or tags, substring per token). Single-token behavior unchanged.
- **Zero-result suggestions:** when the final result set is empty and the query had tokens, the response text appends "No matches. Closest filter tags: …" — up to 6 taxonomy slugs (from the cached `categories`) whose slug shares a prefix or token with any query token (e.g. "editorial" → `magazine-newspaper-blog` via token "magazine"? — no; prefix/token matching covers "blog"; also include slugs containing any token with ≥4 chars).

## D. Jury scores (markup probed live 2026-09-17 on `lxl-creative`, SOTD)

- Detail pages carry a `c-heading-score__note` anchor: `→ 7.37<sup>/ 10</sup>` (also mirrored in `box-score__note`). Parse: first decimal in the `c-heading-score__note` heading → `overall`. Absent (non-award pages) → null.
- `SiteDetails` gains `score: number | null`. `get_site_details` text block gains "Jury score: 7.37/10" when present.
- **Search sort (incremental enrichment, no crawl):** `search_sites` gains `sortBy?: "score" | "newest"` (default `"newest"` = current behavior). With `"score"`: for each matching site, look up its cached `detail:<slug>` meta; sites with a known score sort first (score desc), unscored sites follow (newest first). Scores accumulate as the agent fetches details — no bulk re-crawl.

## Files

| File | Change |
|------|--------|
| `src/capture.ts` | waitStrategy param + pre-scroll before screenshot |
| `src/structure.ts` | waitStrategy param (load default, networkidle optional) |
| `src/motion.ts` (new) | `recordSiteMotion(url, opts)` — recorder logic, returns filmstrip base64 + video path |
| `src/parsers.ts` | `parseScore(html): number | null`; `SiteDetails.score` |
| `src/server.ts` | `record_site_motion` handler; `search_sites` tokenized query + suggestions + `sortBy` score enrichment; `get_site_details` score line; register changes |
| `src/cli.ts` | new tool registration; `waitStrategy`/`frames`/`sortBy` schema params |
| `src/types.ts` | `SiteDetails.score` |
| test files | per-task TDD |
| `README.md`, `package.json` | tools table rows, version 1.5.0 |

## Testing

Per-task TDD offline (injectable loaders/fakes): collapse/score parsing against `test/fixtures/detail-lxl.html` (displays 7.37) and synthetic HTML; motion tool with injected loader + fake ffmpeg path; search tokenization + suggestion + sortBy tests. Live verification: stdio probes — `record_site_motion` on The Meridian, `capture_live_site` on ORDR (previously timing out), `get_site_details` showing a score, search with multi-word query + suggestions. Suite baseline 79/79 → target ≥88.

## Out of scope

- Bulk score backfill (2,854 detail fetches); semantic search; multi-source adapters; hosted transport.
