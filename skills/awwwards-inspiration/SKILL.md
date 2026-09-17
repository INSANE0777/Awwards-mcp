---
name: awwwards-inspiration
description: Use when building a site that needs design references (e.g. "make it feel premium", "dark 3D portfolio vibes"), when the user asks for standalone inspiration research ("show me award-winning e-commerce sites", "what's trending in brutalism"), or when setting up or maintaining the awwwards-mcp local index or live-capture tooling (awwwards-index, capture_live_site).
---

# Awwwards Inspiration

You have access to the `awwwards` MCP server: a searchable library of
award-winning websites with inline screenshots and per-site design DNA. Use
it to ground design decisions in real, proven references instead of guessing.

## When to use this skill

1. **During site builds** — before writing any UI code, gather references and
   state a design direction.
2. **Standalone research** — the user wants inspiration, trends, or examples
   ("show me dark 3D portfolio sites").
3. **Index & capture ops** — building the local search index, or taking fresh
   screenshots of live URLs.

## The inspiration loop

Run this loop before building anything visual:

1. **Restate the goal as concrete attributes.** Turn the user's request into
   mood, color, technology, and industry terms. "Make it feel premium" becomes
   e.g. "dark, elegant, WebGL, agency portfolio".
2. **Ground your vocabulary.** If unsure which filters exist, call
   `list_categories` first — it returns every color hex and tag/technology
   slug you can search by.
3. **Search.** Call `search_sites` with 1–3 filters (e.g.
   `{ color: "#404040", tags: ["3d", "portfolio"] }`). Judge the results from
   the inline screenshots, not just titles. Shortlist 2–3 candidates.
4. **Get the design DNA.** Call `get_site_details` on the top pick for its
   palette, technologies, design elements, awards, and description. If it
   reports a layout-drift error, fall back to judging the shortlisted
   screenshots and `get_site_elements` (which uses a different parser) instead.
5. **Get component-level visuals (when building).** Call `get_site_elements`
   on shortlisted sites to see individual design elements — 3D models, video
   content, mobile layouts, microcopy — with poster images inline and video
   URLs.
6. **State the design direction before writing code.** In prose: palette
   (hexes from the references), type mood, layout patterns, and tech choices,
   each traceable to a reference. Then build.

### Anti-patterns

- **Vague single-word searches** ("modern", "nice") — use concrete color/tag/
  technology/award filters instead.
- **Skipping to code** without stating a direction — the references are
  worthless if nothing is derived from them.
- **Dumping raw tool output at the user** — curate: show the shortlist, the
  chosen direction, and why.

## Tool reference

| Tool | Key params | Returns | Gotchas |
|------|-----------|---------|---------|
| `search_sites` | `query` (free text vs titles/tags), `color` (hex like `#404040`), `tags` (array of slugs), `technology` (slug), `award` (`sotd`\|`developer`\|`honorable`), `count` (1–12, default 6), `page` (default 1) | Text list of site cards (title, slug, live URL, awards, tags) + inline JPEG screenshots | Awwwards applies only one URL filter — priority color > award > technology > first tag; the rest are checked client-side. Color searches always scrape live (never cached). Deep pagination is unavailable by design (robots.txt). On live-request failure, stale cache is served when present. |
| `get_site_details` | `slug` (from `search_sites`, e.g. `l-i-s-a`) | Title, live URL, awards, color palette, technologies, design elements, description, full-size screenshot URL; inline screenshot when available | Cached 7 days; a parse that comes back all-empty is an error, not a quiet empty result. |
| `get_site_elements` | `slug` | Numbered element list (image or video, with video URLs) + up to 8 inline poster JPEGs | Videos are mp4 URLs (posters only are shown inline). Elements feed from the same fetch as `get_site_details`. |
| `list_categories` | none | JSON: every color hex and filter/tag slug, plus usage guidance | Cached 30 days. Call this whenever filter vocabulary is uncertain. |
| `capture_live_site` | `url` (absolute URL) | Full-page PNG saved to disk + inline image | Requires the optional playwright dependency (`npm install -g playwright && npx playwright install chromium`). |

All image results arrive as MCP image content blocks — look at them, don't
just read the text blocks.

## Index & capture ops

**Local index.** `search_sites` works out of the box but unindexed depth is
limited by polite live scraping (~31 sites per filter page). Build the index
once for searches across thousands of sites:

```bash
npx -y -p awwwards-mcp awwwards-index      # from the published package
npm run index                              # from a repo checkout
```

- Crawls all ~200 tag pages at 1 request/second (~4 minutes) into a SQLite
  cache at `~/.awwwards-mcp/`.
- Resumable: interrupt and re-run; completed pages are skipped.
- The MCP server re-indexes automatically in the background whenever the
  index is stale — you rarely need to run this by hand.

**Live captures.** `capture_live_site` needs playwright installed once (see
table above). Use it when the user wants a screenshot of a URL that is not an
Awwwards site, or a fresher view than the cached thumbnails.
