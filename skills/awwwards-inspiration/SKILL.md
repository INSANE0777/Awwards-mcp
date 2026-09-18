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
4. **Live reference URL named? Capture it full-page first.** (and later capture
   your own build the same way — compare both against each other) If the user
   points at a specific live site (e.g. "recreate cerebrium.ai"), call
   `capture_live_site` on that URL before anything else and design from the
   full-page PNG — every section, top to bottom. Cached Awwwards screenshots
   are hero-only crops (~880×660) and hide everything below the fold: the
   sections that make a site's structure distinctive (pricing, feature
   layouts, contrast breaks, footer) were never visible in them.
5. **Get the design DNA.** Call `get_site_details` on the top pick for its
   palette, technologies, design elements, awards, and description. If it
   reports a layout-drift error, fall back to judging the shortlisted
   screenshots, `get_site_elements` (which uses a different parser), or a
   `capture_live_site` of the site's URL for a first-hand full-page view.
6. **Study MOTION before building (element videos, not posters).** Call
   `get_site_elements` on shortlisted sites — it returns per-element video
   URLs (preloader, page transition, case study, about…). **Download those
   videos and tile them at 1–2 fps BEFORE writing any animation code**:
   `curl -o e.mp4 <video-url> && ffmpeg -i e.mp4 -vf "fps=2,scale=480:-1,tile=6x4" -frames:v 1 tile-e.jpg`,
   then Read the tile. Element **posters are single frames** — they show
   layout, not motion; a 3D carousel looks like floating static cards in a
   poster (this exact mis-build happened). One tile per element shows you the
   whole animation arc (easing, overlap, entrance order). If a marquee
   animation needs finer study, re-tile that video at higher fps. The motion
   IS the design: every reference animation you ship must trace to frames
   you actually studied, and reference videos pass through
   `showcase/ref-motion/` as the design's evidence trail.
7. **State the design direction before writing code.** In prose: palette
   (hexes from the references), type mood, layout patterns, page
   architecture (one page vs separate horizontal sections — judge this from
   the reference passages you studied in steps 4–6, not habit), and tech
   choices, each traceable to a reference. Then build. For a site's own
   marquee frontend skills, prefer proven patterns (GSAP ScrollTrigger for
   horizontal scroll chapters, Lenis for smooth scroll) over hand-rolled
   scroll math.
8. **Verify structure, then polish.** After building, capture your own build
   full-page (`capture_live_site` on its `file://` or served URL) and run
   `analyze_page_structure` on BOTH the reference and the build. Compare band
   maps section by section (count, order, backgrounds, heights). Fix
   distribution mismatches first — a section that is 3× the reference's height
   is a structural bug no amount of pixel polish fixes. Match the reference's
   band structure, never just its total height.

### Anti-patterns

- **Vague single-word searches** ("modern", "nice") — use concrete color/tag/
  technology/award filters instead.
- **Skipping to code** without stating a direction — the references are
  worthless if nothing is derived from them.
- **Dumping raw tool output at the user** — curate: show the shortlist, the
  chosen direction, and why.
- **Designing from a thumbnail or element poster** — thumbnails are hero-only
  crops, posters are single video frames, and neither shows real structure OR
  motion. When the reference URL is known, capture it full-page (step 4);
  when an element has motion, tile its video (step 6) — never animate from
  posters.
- **One filmstrip for everything** — a single N×N tiling of the *whole
  recording* makes late tiles tiny and animation arcs illegible. Tile per
  element/per passage at 1–2 fps instead; re-tile finer passages at higher
  fps when easing or overlap matters.
- **Padding empty bands to match total height** — if your build's total height
  matches the reference but a spacer/background band is far taller than the
  reference's equivalent, the height was stolen from real content sections.
  Compare band maps, not totals. Spacer and decorative elements are measured
  against the reference's equivalent band — never invented to absorb height.

## Tool reference

| Tool | Key params | Returns | Gotchas |
|------|-----------|---------|---------|
| `search_sites` | `query` (free text vs titles/tags), `color` (hex like `#404040`), `tags` (array of slugs), `technology` (slug), `award` (`sotd`\|`developer`\|`honorable`), `count` (1–12, default 6), `page` (default 1) | Text list of site cards (title, slug, live URL, awards, tags) + inline JPEG screenshots | Awwwards applies only one URL filter — priority color > award > technology > first tag; the rest are checked client-side. Color searches always scrape live (never cached). Deep pagination is unavailable by design (robots.txt). On live-request failure, stale cache is served when present. |
| `get_site_details` | `slug` (from `search_sites`, e.g. `l-i-s-a`) | Title, live URL, awards, color palette, technologies, design elements, description, full-size screenshot URL; inline screenshot when available | Cached 7 days; a parse that comes back all-empty is an error, not a quiet empty result. |
| `get_site_elements` | `slug` | Numbered element list (image or video, with video URLs) + up to 8 inline poster JPEGs | Videos are mp4 URLs (posters only are shown inline). Elements feed from the same fetch as `get_site_details`. |
| `list_categories` | none | JSON: every color hex and filter/tag slug, plus usage guidance | Cached 30 days. Call this whenever filter vocabulary is uncertain. |
| `capture_live_site` | `url` (absolute URL) | Full-page PNG saved to disk + inline image | Requires the optional playwright dependency (`npm install -g playwright && npx playwright install chromium`). |
| `analyze_page_structure` | `url` (absolute URL or `file://` path), `maxBands` (cap on returned bands, default 40) | JSON: `title`, `totalHeight`, and an ordered band map (`index`, `tag`, `label`, `background`, `offsetTop`, `height`, `textStart` (first ~60 chars of the band's text) per band) | Requires playwright. Run it on BOTH the reference and your build (step 8) and compare band maps — count, order, backgrounds, heights — never just total height. |
| `record_site_motion` | `url` (absolute URL), `frames` (filmstrip tile count, 4–36, default 16 → a 4x4 grid) | Inline filmstrip JPEG of a motion-through pass (preloader dwell, slow scroll, hover/cursor interactions) + the saved .webm path as text | Requires playwright + ffmpeg-static. Runs a ~30 s scripted pass — heavier than a capture, use when motion matters (step on from static captures). |

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
table above). Two uses: (1) the user wants a screenshot of a URL that is not
an Awwwards site, or a fresher view than the cached thumbnails; and (2) —
the more important one — the user names a live site as the design reference
for a build: capture it full-page first and derive the structure from that
image (see step 4 of the loop).

**Motion capture.** Static images can't show preloaders, scroll-driven
animation, or transitions — and most award-winning sites are built around
exactly those. When the reference site has motion, record it: launch
Playwright with `recordVideo`, wait out the preloader (~7 s), scroll slowly
to the bottom in small steps so every scroll-triggered animation fires on
camera, then extract a filmstrip of frames with ffmpeg (`npm i -D
ffmpeg-static`, one frame every ~3 s) and Read the frames — or call
`record_site_motion` directly: the filmstrip comes back inline and the .webm
path as text.

**Filmstrip is the fallback, not the default.** First try Reading the
video file directly — if your model supports video input, watching the
scroll-through gives you timing, easing, and transitions the frames can't.
If the Read comes back with media omitted / "model does not support video
input", extract the filmstrip and Read the frames instead. A ready-made
recorder ships in this repo at
`scripts/record-scrollthrough.mjs` (run it from the repo root; playwright
and ffmpeg-static are devDependencies).
