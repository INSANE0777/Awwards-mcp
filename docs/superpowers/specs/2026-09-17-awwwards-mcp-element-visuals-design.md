# Awwwards MCP — Element Visuals Design Spec

Date: 2026-09-17
Status: Approved by user (design conversation, 2026-09-17)
Parent specs: `2026-09-17-awwwards-mcp-design.md` (v1), `2026-09-17-awwwards-mcp-local-index-design.md` (local index)

## Problem

`get_site_details` returns element *names* only ("3D model", "Microcopy") as text. Agents asking component-level questions ("how do award sites handle mobile layouts?") get labels, not visuals — the core Mobbin-style value is missing.

## Goal

A `get_site_elements({ slug })` tool returning each element's **poster image inline** plus media metadata, giving agents component-level visual inspiration.

## Verified data facts (probed 2026-09-17 against committed fixture + live CDN)

- Detail pages' Elements section (between `>Elements</h2>` and `>Color Palette</h2>`) carries per-element JSON blobs with `collectableTitle` and `collectableImage` (`element/YYYY/MM/<hash>.mp4` or `.jpg`). L.I.S.A. has 6 elements: 4 mp4, 2 jpg.
- Every `.mp4` element ships a poster at the same path with `.mp4` replaced by `_static.jpeg` (live-verified: HTTP 200, `image/jpeg`, 1600×1200). Image elements are direct `.jpg` URLs.
- Element media lives under `https://assets.awwwards.com/awards/element/...` (CDN; not rate-limited, same as thumbnails).

## Design

New tool; existing tools unchanged.

| File | Change |
|------|--------|
| `src/parsers.ts` | Add `parseElements(html): { title: string; mediaPath: string }[]` — section-bounded extraction of the element blobs. Existing `parseDetail` elements list stays as-is (it feeds text summaries). |
| `src/awwwards.ts` | Add `elementUrl(mediaPath: string): string` (CDN URL) and `elementPosterPath(mediaPath: string): string` (`.mp4` → `_static.jpeg`; jpg unchanged). |
| `src/server.ts` | Add `get_site_elements` to `Handlers` + `createHandlers`. |
| `src/cli.ts` | Register `get_site_elements` (slug schema identical to `get_site_details`: `/^[\w-]+$/`). |
| `README.md` | Tools table row. |

### Semantics

- Detail HTML is fetched once and feeds both `detail:<slug>` and `elements:<slug>` meta caches (TTL 7 days each): a `get_site_details` call followed by `get_site_elements` (or vice versa) performs at most ONE page fetch.
- Response: one text block (site title, element count, per-element title + type + video URL when video) followed by up to **8** inline poster image blocks (base64 JPEG via `cache.getImage`; failures degrade to text-only cards).
- Sites with no Elements section → text "No design elements listed for this site" (legitimate, not an error, and NOT cached as a positive result — cache the empty list under the same key so repeat calls don't re-fetch).
- Parser-mismatch guard mirrors the v1 contract: if the detail HTML contains an `>Elements</h2>` section but zero blobs parse from it, return the isError parser-mismatch message and do not cache.
- Never-throw contract: all failures → `{ content: [text], isError: true }`, same as existing handlers.

## Testing

- `parseElements` unit tests against the committed fixture: 6 elements, exact titles ("3D model", "Microcopy", ...), mp4/jpg path mix; synthetic no-section HTML → `[]`.
- `elementPosterPath` unit tests: mp4 → `_static.jpeg`, jpg → unchanged.
- Handler tests (fake client + fixture): first call fetches detail page once (page-call count 1), returns 1 text + 6 image blocks, video URLs present in text for the 4 mp4 elements; second call zero page fetches (meta cache); empty-section synthetic HTML → the legitimate-empty text and cached (second call zero fetches); blob-section-but-zero-parse → isError and uncached.
- Suite target: 53 → ≥58.

## Out of scope

- Video *playback* or frame extraction (posters only; video URLs are returned as text).
- Cross-site element search ("show me mobile layouts across all sites") — requires an element index; candidate for a future feature.
- Pre-indexing element posters (fetched on demand, disk-cached).
