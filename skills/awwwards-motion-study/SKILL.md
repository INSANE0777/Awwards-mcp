---
name: awwwards-motion-study
description: Use when building a site whose reference has animation — before writing any motion code, and again when verifying a build. Teaches what to record from a live site (and what to skip), how to study the recordings frame-by-frame (video input or ffmpeg tile-per-element), how to turn the study into a motion inventory, and how to verify the build's motion against the reference. Complements awwwards-inspiration (step 6) with the full capture→review→build procedure.
---

# Awwwards Motion Study — capture, review, build

Motion is design: an award-site hero that "looks the same" in a screenshot
can be a spinning 3D ring, a scrubbed pin, or a staggered reveal. Static
captures hide it; element posters (single frames) lie about it. This skill
covers the whole chain: **record → review → inventory → build → re-record**.

The one rule everything serves: **never write animation code from memory or
posters — every shipped animation must trace to frames you actually studied.**

## 1. What to capture

Record a **motion-through pass**: load, dwell, slow scroll, hover tour.
Three animation classes must all be on camera:

| Class | How it gets captured | Typical duration |
|---|---|---|
| Preloader / entrance | initial dwell after `load` | 5–8 s |
| Scroll-triggered + pinned/scrubbed | slow stepped scroll (~450 px / ~600 ms) | length of page |
| Hover / click / micro-interactions | virtual cursor visits interactive elements and dwells | 10–20 s |

**Capture these** — they are design:

- Preloader/entrance sequences and hero reveals
- Scroll-triggered reveals, parallax, horizontal pins, scrubbed timelines
- Hover states (cards, nav, buttons, image rollovers) and click effects
- Page transitions if the site has them, sticky/nav behaviors on scroll
- Marquees, tickers, counters — anything time-driven

**Skip these** — they are content, noise, or traps:

- **Content videos** (film hero backgrounds, stock footage, showreels):
  they're the site's *media*, not its *interaction* — you'd be styling
  someone's footage, not learning the motion design.
- **Loading states**: capture *after* they resolve. A half-loaded page
  records lazy placeholders as if they were the design. Dwell first, then
  scroll; if a section is still empty in the recording, it's a capture bug,
  not a design feature.
- Cookie banners / newsletter modals: dismiss them early (unless you're
  specifically building one) or they eat the first seconds of footage.
- Ads, tracking iframes, user-generated widgets.
- **Don't redistribute recordings**: captures are local study artifacts
  (keep them in `ref-motion/` or `_qa/`). Awwwards content and site media
  belong to their creators — study them, don't republish them.

Before recording, fingerprint the motion stack (techniques registry `skills/_memory/techniques.json` → motion-detection): library fingerprints in the captured HTML, hover-pair style diffs, transform-polling — the site names its own animation stack, and scene-detect-first (video-understanding domain) scopes your tiles.

## 2. How to capture

Fast path first, fall back when it can't:

1. **`record_site_motion`** (MCP tool): inline filmstrip + saved .webm path.
   Best default. Known ceiling: ~30 s — heavy sites may time out.
2. **`scripts/record-scrollthrough.mjs`** (repo checkout, playwright):
   `node scripts/record-scrollthrough.mjs <url> <outDir> <name>.webm` —
   full-control recorder: 7 s preloader dwell, 450 px/600 ms stepped scroll,
   injected virtual cursor (playwright video doesn't render the real one)
   that visits and dwells on interactive elements. Use when the MCP tool
   times out or when you need to customize the tour.
3. **Direct playwright**: `chromium.launch()` + `newContext({ recordVideo })`
   when neither fits (custom viewports, login flows, multi-page tours).

Capture rules that prevent re-shoots:

- **Capture BEFORE building** — the doctrine step. Review first, code second.
- Use a **consistent viewport** (1440×900 matches the QA scripts) so your
  reference tiles and build tiles are comparable.
- For phone-class references pass `record_site_motion` a `viewport: "mobile"`
  (390×844 @3x with isMobile + hasTouch) — and capture BOTH viewports when
  the desktop and mobile designs diverge.
- **Pre-scroll** to fire lazy content, scroll back to top, then record —
  otherwise reveal-on-scroll sections record as blank boxes.
- For multi-page sites, record **each page** you'll rebuild (home, projects,
  about), not just the hero.
- On the 30 s MCP ceiling: fall back to the script; never shorten the scroll
  so much that sections get skipped.

## 3. How to review the video

Posters are frames; you need frames **in sequence**. Two paths:

**Path A — direct video input.** `Read` the .webm first. If your model
supports video, watching the pass gives timing, easing, and transitions no
filmstrip can. If the read comes back "media omitted / not supported",
use Path B.

**Path B — tile per element at 1–2 fps.** One tiling *per element/passage*,
never one mega-strip of the whole recording (late tiles go thumbnail-size
and easing becomes unreadable — a mis-build happened exactly this way):

```bash
ffmpeg -i reference.webm -vf "fps=2,scale=480:-1,tile=6x4" -frames:v 1 tile-hero.jpg
```

Cut the video into per-element segments first (by timestamp from watching
the strip), then tile each segment. **Re-tile finer at higher fps** when
easing or overlap matters: `fps=6` on a 3 s passage shows whether an ease
is `power2.out` vs `expo.out`; overlap ordering needs ~200 ms granularity.

While reading tiles, extract per element:

| Field | What to look for |
|---|---|
| trigger | load / scroll-enter / scroll-scrub / hover / click |
| transform | opacity, y/x, scale, clip-path, blur — which properties move |
| duration + easing | count frames between first and last movement; fast-out = expo/power4, soft = power2, linear = scrub |
| stagger | siblings entering in sequence → measure the delay between them |
| overlap | does the next element start before the previous ends? |

Write the result as a **motion inventory** — a table per page — and build
from the table, not from impressions:

```markdown
| Element | Trigger | Transform | Duration | Easing | Overlap |
|---|---|---|---|---|---|
| Hero paper | load | yPercent -104→0 | ~1.2 s | power4.out | photo fades under at -1.0 s |
| Story cards | scroll 86% | opacity + y 56 | ~0.85 s | power3.out | stagger 0.09 |
```

## 4. Build from the inventory

- Every shipped animation cites an inventory row. If you can't name the
  frames an animation came from, you're inventing — stop and study.
- Use proven motion primitives, not hand-rolled scroll math: GSAP
  ScrollTrigger (pins, `containerAnimation` with `ease: "none"` for
  horizontal, `scrub` for scrubbed timelines), Lenis for smooth scroll.
- Full-viewport horizontal panels get **one-shot entrances**
  (`toggleActions: "play none none none"`) — reverse-on-leave hides copy
  mid-view (caught by QA pin shots).
- Ship `prefers-reduced-motion` fallbacks and progressive enhancement
  (content visible without JS) — a capture tool or JS-less visit must never
  see blank sections.

## 5. Close the loop: re-record your build

Verification is the same skill pointed at yourself:

1. Record your build exactly as you recorded the reference (same viewport,
   same pass shape — `record_site_motion` works on `file://` URLs too).
2. Tile your build's key passages and **compare tile-to-tile** against the
   reference tiles: same trigger order? similar durations? easing in the
   same family?
3. QA captures for scroll builds must land at **panel/section centers**, not
   uniform scroll fractions — mid-transition shots photograph empty
   transition zones and look broken when they aren't.
4. Fix what mismatches, re-record, repeat — one loop, not ten.

## Close the flywheel

End every capture/study pass by recording what verification caught:
`node scripts/skill-memory.mjs record --skill awwwards-motion-study --phase motion-study --symptom "..." --rule "..." [--evidence tile.jpg]`. Distill folds rules seen ≥2× into your installed copy; recall prints them at the next study. The techniques registry (`skills/_memory/techniques.json`) grows from promoted findings — propose better methods by recording them.

## Anti-patterns

- **Designing from posters or thumbnails** — posters are single frames; the
  3D carousel reads as "floating static cards" (a real mis-build).
- **One filmstrip for the whole recording** — element-level detail dies in
  an N×N mega-grid.
- **Capturing only the hero** — the distinctive motion usually lives below
  the fold.
- **Recording over a half-loaded page** — lazy placeholders captured as
  design.
- **Studying nothing, animating from vibes** — "it probably fades in" is
  how builds drift from references.
- **Republishing recordings** — captures are local study evidence.

<!-- skill-memory:start -->
<!-- skill-memory:end -->
