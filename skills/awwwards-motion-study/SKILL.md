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

> **Profile note:** this skill's tools are `record_site_motion`, `analyze_stack`,
> `analyze_scroll_map`, `analyze_hover_census`, `get_motion_dna`,
> `capture_pose_3d`, `analyze_bundle`, `build_pose_stub`, `build_gsap_stub` and
> retained `build_project` / `verify_build`. Examples below use 1.x names
> (default `full`). On `AWWWARDS_MCP_PROFILE=v2`, use
> `capture_page {request:{kind:"recording", url}}`,
> `inspect_page {request:{kind:"stack", url}}`,
> `analyze_motion {request:{kind:"scroll", url}}`,
> `analyze_motion {request:{kind:"hover", url}}`,
> `analyze_motion {request:{kind:"dna", url}}`,
> `capture_page {request:{kind:"pose", url}}`,
> `audit_page {request:{kind:"bundle", url}}`,
> `build_motion {request:{kind:"pose_stub", poseGrid}}` and
> `build_motion {request:{kind:"gsap_stub", scrollCensus}}`; `build_project`
> and `verify_build` stay flat. Feed `build_motion` a `compact:false` scroll
> census. Full mapping: [v2-routing.md](../v2-routing.md).

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

**Beyond motion — the layered lenses.** The inventory above is the motion
layer. Before building, sweep the same tiles through five more lenses (adapted
from the video-to-superprompt skill) and note each per page:

| Lens | What to capture |
|---|---|
| Story | page purpose, emotional arc, section order, how beats transition |
| Layout | viewport framing, grids, sticky zones, card/media placement, nav + footer anatomy |
| Visual design | type scale, palette, surfaces, borders/shadows, texture, iconography, image treatment |
| Technical rebuild | which mechanism serves each effect: IntersectionObserver, GSAP ScrollTrigger/Lenis, WAAPI, canvas, `video.currentTime`, carousel physics |
| A11y + performance | reduced-motion fallback, touch/keyboard states, lazy loading, preload hints, pixel-ratio caps |

A lens finding that changes the build gets its own inventory row or a build
note — not a mental note.

**Output mode — the builder-ready superprompt.** When the video is for a
hand-off (another agent, an article, a future session) rather than an
in-session build, compile the inventory + lenses into one paste-ready prompt:
final thing to build + reference boundary (exact recreation vs inspired),
asset map, global design language, section-by-section anatomy (purpose,
layout, animation, interactions, scroll behavior, library choice,
reduced-motion fallback), and anti-patterns. The prompt must be long enough
to rebuild the interaction without seeing the original video — no "make it
beautiful", only concrete mechanisms and numbers.

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

In a repository checkout (the installed npm package does not ship this dev
script), end every capture/study pass by recording what verification caught:
`node scripts/skill-memory.mjs record --skill awwwards-motion-study --phase motion-study --symptom "..." --rule "..." [--evidence tile.jpg]`. Distill folds rules seen ≥2× into your installed copy; recall prints them at the next study. The techniques registry (`skills/_memory/techniques.json`) grows from promoted findings — propose better methods by recording them. For the human PR that promotes a rule into the shipped copy, `promote --skill awwwards-motion-study` strips machine-local evidence paths.

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
- **Republishing recordings** - captures are local study evidence.

## Instrument-first pass (data before video)

The MCP now ships data instruments that answer questions video can only hint
at. Run them BEFORE recording - then record only what they can't express:

- `analyze_stack` - fingerprint the site's framework (Next/Astro/Webflow/...)
  and CSS framework before you re-derive any of it. One polite request, no
  browser. Knowing "this is Webflow + Tailwind" up front tells you which
  parts of the rebuild are conventions you can copy-minded vs. runtime magic
  to re-instrument.
- `verify_build` (instrumented) - beyond band/motion scoring it now runs a
  real-browser perf probe on the BUILD (fps, dropped frames, long tasks,
  layout thrash) plus an anti-pattern scan (transitioning blur, infinite
  loops, animated layout properties, transition:all) and names the worst
  offender in the evidence. Use it as the "is my build heavy" instrument
  before polishing, not only at the end. Pass `compact: true` for verdict-only
  checks (verdict, overall, band and motion scores).
- `analyze_scroll_map` - per-element scroll census: which elements animate,
  their triggers (scroll/pin/scrub), durations, easings — now with real
  VALUES: per-anim keyframe matrices (from→to like `translateY(56px) → 0`)
  and a `gsapTriggers` array per site (compiled pixel `startPx`/`endPx`,
  live `progress`, tween vars such as `stagger: 0.09`). This is the motion
  inventory video would take 10 minutes of scrubbing to approximate.
- `analyze_hover_census` - hover rules + computed-style diffs with transition
  timing, no recording needed. Each sample also records animations DURING
  hover (`activeAnims` + in-flight transform trail), catching event-driven
  tweens that don't exist at rest.
- `get_motion_dna` - the site's motion vocabulary in one call: libraries,
  easing tokens, duration quartiles. Feeds a rebuild's type scale directly.
- `capture_pose_3d` - WebGL/canvas heroes, which screen recording captures
  worst (flat pixels of a 3D scene). Pose grids + `build_pose_stub` give the
  frames plus a synthesized camera path (guidance, not recovered camera data);
  the stub dedupes same-index frame loads and discards stale decodes.
- `capture_scene_3d` with `adapters:["three"]` - for Three.js heroes: reads
  only reachable globals into `evidence.three` (nodes/cameras/lights/controls);
  `build_scene_stub` rebuilds only supported primitives and a perspective camera
  from its exact matrix. Controls are never recreated and stay unresolved.
  Module-local scenes, parent transforms and unbound textures are not recovered;
  captured lights are recorded, not applied. `scene.json` frame references are
  basenames extracted from either Windows or POSIX paths.
- `capture_scene_3d` with `adapters:["spector"]` - optional `spectorjs@0.9.33`
  for shader evidence: one WebGL frame with command names/counts, statuses,
  context attributes and capped shader source. Arguments, results, state, stack
  and raw capture are not transferred; a page that stopped drawing can yield no
  programs.
- `analyze_bundle` - bundle forensics when the evidence can't name a
  mechanism: fetches the site's script chunks (≤40, 1 req/s, saved locally),
  greps your keywords, optionally de-obfuscates with webcrack if installed.
  When the census says WHAT animates but not HOW (e.g. an on-hover
  letter-swap driven by imperative tweens), this reads the mechanism from
  the site's own bundle.
- `build_project --motion <census.json>` - the study's hand-off artifact:
  `motion.manifest.json` (measured per-section triggers, `pageTriggers` for
  unattributed rows, initial-hidden hints) + inert per-section/page motion
  hooks. Under `--authored` the site's own scripts are dropped and the hooks
  become the only motion source — author them from the manifest (see
  `motion-authoring`). "Measured" means generator-emitted; never hand-write
  rows and keep the flag.

Video keeps what data cannot express: feel, choreography, sequencing, where
the eye goes. The study order is: censuses first, recording second, then
reconcile - anything the video shows that the census missed is a finding, not
a redundancy. When the study feeds a rebuild, close the loop with
`verify_build` (motion fingerprint + band compare + measured perf and
anti-pattern evidence — expect ~2 min; the evidence line names dropped-frame
counts and the worst anti-pattern, e.g. `anti-patterns: 23 (worst: blur-heavy)`)
instead of eyeballing — for a canvas hero, opt in with `scene3d` after
`capture_scene_3d`: it compares one rendered frame per checkpoint in a
separate gate, rejects unstable reference frames, and can read time-shifted
animation as outside tolerance. It preflights both URLs before the legacy
scans (private/loopback is refused with zero requests), refuses duplicate or
pre-marked canvas decoys through a per-run marker, and budgets the run from the
replayed checkpoint waits + 10 s headroom (floor 15 s, cap 45 s) —
and turn the motion inventory into starting code with `build_gsap_stub`
(feed it the scroll census + optional pose grid; it emits a runnable
GSAP+ScrollTrigger stub with the captured durations, easings, scrub/pin, a
synthesized camera module for canvas heroes, and a reduced-motion guard you
must keep).

<!-- skill-memory:start -->
<!-- skill-memory:end -->
