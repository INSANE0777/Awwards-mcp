---
name: recreate
description: Recreate a website from a link — evidence-driven reconstruction with the awwwards MCP. Use when the user says "recreate this site", "clone this page", "rebuild <url>", or gives a URL and asks to build it. Produces a faithful hand-built implementation (HTML/CSS/JS + GSAP/Lenis as the reference demands), QA-verified against the live site, then optionally converted into a Vite/Astro/Next project.
---

# Recreate a website from a link

Input: one URL (`$ARGUMENTS`). Follow the phases in order; do not skip the evidence steps.

> **Profile note:** this skill's tools are `search_sites`, `get_site_details`,
> `capture_live_site`, `analyze_page_structure`, `analyze_stack`,
> `capture_component`, `analyze_scroll_map`, `analyze_hover_census`,
> `get_motion_dna`, `capture_pose_3d`, `build_pose_stub`,
> `export_design_tokens`, `analyze_images`, `analyze_bundle` and retained
> `analyze_network_capture` / `verify_flow`. Examples below use 1.x names
> (default `full`). On `AWWWARDS_MCP_PROFILE=v2`, use
> `search_references {request:{kind:"sites", ...}}`,
> `get_reference {request:{kind:"site_details", slug}}`,
> `capture_page {request:{kind:"screenshot", url}}`,
> `inspect_page {request:{kind:"structure", url}}`,
> `inspect_page {request:{kind:"stack", url}}`,
> `capture_page {request:{kind:"component", url}}`,
> `analyze_motion {request:{kind:"scroll", url}}`,
> `analyze_motion {request:{kind:"hover", url}}`,
> `analyze_motion {request:{kind:"dna", url}}`,
> `capture_page {request:{kind:"pose", url}}`,
> `build_motion {request:{kind:"pose_stub", poseGrid}}`,
> `inspect_page {request:{kind:"tokens", url}}`,
> `audit_page {request:{kind:"images", url}}` and
> `audit_page {request:{kind:"bundle", url}}`; `analyze_network_capture` and
> `verify_flow` stay flat. Full mapping: [v2-routing.md](../v2-routing.md).

## Phase 0 — Study-build terms (mandatory, every run)

This is a **local study build**: recreate the reference exactly — layout, text, images, fonts, audio, motion. In exchange, every output MUST ship the disclaimer:

1. **README.md in the build** must state, prominently: the design, copy, images, fonts and audio belong to the original owners; this build is a private study/reference recreation; **it must not be deployed, published, sold, or presented as your own work**; publishing requires replacing every borrowed asset (list them) and obtaining licenses.
2. **Header comment in the HTML** repeats the same notice in one line.
3. **Provenance list**: every borrowed asset path + source URL enumerated in the README.
4. If the user later wants to publish, that is a separate brief: replace assets → publish. Never quietly drop the disclaimer.

Scope: whole page or specific sections? A continuous scroll-narrative (fixed stage + long spacer) is one unit — do not force per-section pages onto it. Target: single-file build by default; **conversion is offered after QA, never assumed** (see Phase 4).

## Phase 1 — Evidence (free MCP, all read-only)

> **Any URL works, but check Awwwards first.** Step 1 is always `search_sites` with the site's domain/name. If the site is listed → `get_site_details` for its recorded DNA (palette, tech, elements, awards) and carry that into the report. If no match → say so once and continue: only the search/index tools are Awwwards-sourced; every capture tool below runs on any public link, and the live evidence still gives you everything.

- `analyze_stack <url>` → framework + CSS + libs (tells you whether the reference is Webflow/Next/static and which motion libs matter).
- `analyze_page_structure <url>` → bands (section order + heights). If bands collapse into a giant, `capture_component` with explicit id/class selectors instead.
- Per section: `capture_component <url>` with `selector` (id/class), `maxNodes` up to 2000 → geometry, 44 computed style keys, pseudo-elements, inline SVG, text, imgSrc, fonts, colors.
- Motion: `analyze_scroll_map <url>` (keyframes + `gsapTriggers` numerics; `scrubProbe` on for scrubbed narratives), `analyze_hover_census <url>` (during-hover `activeAnims`), `get_motion_dna <url>`.
- Canvas/WebGL hero: `capture_pose_3d` → frames/grid; `build_pose_stub` turns them into a scroll stub whose camera anchors are synthesized guidance (the pose grid holds frames and scroll ratios, not camera transforms). Its frame loader dedupes same-index requests and discards stale decodes, so scrubbing cannot flash an older frame. For Three.js pages, `capture_scene_3d` with `adapters:["three"]` adds reachable nodes/cameras/lights/controls to `evidence.three`; `build_scene_stub` reconstructs only Box/Plane/Sphere/Cylinder primitives with captured dimensions, standard/basic materials and a perspective camera from its exact matrix. Controls are never recreated, module-local scenes and parent transforms are not recovered, and unbound textures stay flat. `scene.json` frame references are basenames extracted from either Windows or POSIX paths.
- Shader inspection: `capture_scene_3d` with `adapters:["spector"]` (optional `spectorjs@0.9.33`) captures one WebGL frame with command names/counts, statuses, context attributes and capped shader source. It needs a frame that actually draws; command arguments, results, state and raw capture are never transferred, and shader source is untrusted page text, not code to run.
- Screenshots: `capture_live_site` on a document-scrolling page returns one full-page PNG + inline preview (your QA ground truth, not decoration); it waits out full-screen preloaders by default. If `analyze_page_structure` returns `scrollRoot`, the page scrolls an inner container: `capture_live_site` returns `mode:"anchors"` — six ordered viewport shots down that container (`anchors[].scrollTop` + `file`, JSON only, no inline image) — so read the six files, and drive the container's `scrollTop` yourself for positions between them. `scrollCapture:"viewport"` forces a single viewport shot; never describe an anchors payload as one full-page image.
- Tokens before build: `export_design_tokens <url>` (optional `selector`, `viewport`, `maxNodes` up to 2000, `include` categories) → ordinal CSS variables + a Tailwind theme map derived from computed styles. Feed that CSS/Tailwind into the build instead of hand-guessing the palette and type scale; `truncated`/`notes` say when a cap was hit.
- Image delivery: `analyze_images <url>` → format mix, lazy/eager/`srcset` coverage, broken/oversized/tiny images, alt coverage and samples (query strings stripped; no downloads). Use it to decide which reference images to copy, how to size them, and which need responsive variants.
- Mechanism unknown after all evidence? `analyze_bundle <url>` (≤40 chunks, 1 req/s, keyword grep, optional webcrack) — understand *how*, still write your own code.
- API shape: export the network log as a HAR and run `analyze_network_capture <path>` — grouped endpoints and path templates only, no bodies/headers/secrets. Already have the page open in Chrome? `analyze_page_structure` with `cdpEndpoint` scans it without driving it (requires `AWWWARDS_MCP_ATTACH=1`; never navigates, scrolls, clicks or creates tabs).

## Phase 2 — Build

- One HTML file + CSS + JS matching the reference's own approach: vanilla for static sites; GSAP + ScrollTrigger + Lenis when the DNA shows them.
- Wire motion from the **measured** values: census durations/easings/triggers, `gsapTriggers` pixel start/end, keyframe from/to values, scrub curves. Do not invent easings the census didn't show.
- Continuous-scroll narratives: fixed viewport-size stage + long invisible spacer + one scrubbed master timeline; layer switching and `--bg` custom property tweens; reduced-motion mode collapses to a calm stacked document (always ship it).
- Three.js hero from `evidence.three`: start from `build_scene_stub` and treat `unresolved`/`authoredDefaults` as the work list. Only Box/Plane/Sphere/Cylinder meshes, standard/basic materials and a validated perspective camera from its exact matrix are recreated; captured controls are never recreated and stay unresolved, captured lights are recorded but not applied, unsupported types stay unresolved, and parent transforms are lost. A captured camera is static; the idle orbit is used only when the pack has no usable adapter scene.
- Structure: semantic ids per section (`#hero`, `#work`), local `vendor/` for libs (strict load order: gsap → ScrollTrigger → lenis → app.js), local `assets/` for fonts/audio/covers/images — **exact assets, copied in**.
- All links `target="_blank" rel="noopener"`, metadata + OG + JSON-LD updated.

## Phase 3 — QA gate (do not declare done without it)

- Playwright: 390, 768, 1024, 1440, 1728 widths; screenshot every scroll anchor (match the reference capture); compare compositions side by side. For inner-scroll pages (`scrollRoot`), drive the container's `scrollTop` at each anchor — the reference side is the six `capture_live_site` `mode:"anchors"` files (or your own anchored shots); there is no single full-page image to compare against.
- Zero console errors, zero 404s, zero horizontal overflow; assert element bounds (name width, card count/hrefs, contact block) at 1440 and 390.
- Reduced-motion pass at 1440: stacked layout, no overflow.
- Interaction parity: `verify_flow { buildUrl, referenceUrl, steps }` replays the same 1–6 scroll/click/wait steps and reports per-step `same`/`changed`/`unknown` — use it when a menu, accordion, modal or hover-revealed panel is part of the reference; treat `unknown` as unverified, not as a pass.
- 3D canvas: `verify_build { buildUrl, referenceUrl, scene3d: { referenceCaptureId, buildSelector } }` replays the capture pack's checkpoints and compares clipped canvas frames. It preflights both URLs on one shared DNS/private-IP guard before the legacy scans (private/loopback is refused with zero requests, and the legacy acquisitions run behind the same proxy), and its deadline is the replayed checkpoint waits + 10 s headroom, floored at 15 s and capped at 45 s. Supply both `pixelThreshold` and `maxChangedFraction` for a within/outside verdict; otherwise it reports metrics as `inconclusive`. The gate tags the canvas with a per-run random marker, so duplicate or pre-marked decoys are refused. The legacy band pass never certifies the canvas.
- If anything drifts from the evidence, fix and re-shoot — one anchor at a time (section-loop discipline).

## Phase 4 — Optional project conversion (ask first)

The rebuild is a valid deliverable on its own. After Phase 3 passes, **ask the user**:

> Keep it as a single-file build, or convert it to a project — Vite (plain HTML/CSS/JS, no components), Astro (HTML components), or Next.js (React components)? And if converted, keep the original scripts or switch to authored motion (`--authored`)?

Do not convert unprompted. Do not pick a framework for them. If they say "just build it", stop at Phase 3 + handoff.

When they choose:
1. `awwwards-build-project <file.html> --target vite|astro|next --out <dir>` → native structure: real section components, shell chrome, split CSS (`tokens.css` + `site.css`), ordered libs, head metadata/boot replayed.
2. If they chose authored motion: `--authored --motion <census.json>` — site logic scripts dropped, head boot + animation libs kept, `motion.manifest.json` carries measured per-section + page triggers. Then author the motion (see `motion-authoring`), recording any authored rows explicitly.
3. Gate: `npm install && npm run build` per target, serve, re-run Phase 3 anchors **plus a 390×844 mobile smoke** and reduced-motion; zero errors/404s.

## Phase 5 — Handoff

Always deliver a **reference report** — even if the user only asked for information and no build: detected stack + libs (`analyze_stack`, `get_motion_dna`), section map with heights/backgrounds (bands), motion summary (triggers, easings, durations, scrub/pin), asset inventory (fonts, images, audio), and bundle notes when `analyze_bundle` ran. For non-Awwwards links this report *is* the value when a build is out of scope.

If a build was produced: README with run instructions, the **mandatory study-build disclaimer** (copyright belongs to the original owners; no deploy/publish/production use; not presented as your own), full provenance list of borrowed assets, and the replace-before-publish plan if the user later wants to ship. Report: reference URL, evidence tools used, section map, QA matrix results, residual gaps.

## Known limits (say them out loud)

- Passive canvas capture is frames only. `capture_scene_3d` with `adapters:["three"]` reads only reachable globals; module-local scenes are invisible, `build_scene_stub` flattens meshes at the root so parent transforms are lost, and textures bind only when you hold a local file. Absence is not evidence of absence. `adapters:["spector"]` needs a frame that draws and reports only bounded command summaries plus capped shader text — no arguments, results, state, stack or raw capture.
- Webflow IX2 / JS-driven initial states are recoverable as behavior evidence but not as their runtime — re-implement with your own JS (N2 authored mode proves the shape; vendor-bundle interpretation stays manual).
- `--authored` keeps head inline scripts even if they may be site logic (warned when >2 KB or animation-looking) — verify before shipping.
- Generator `pageTriggers` cover unattributed census rows; a page-level hook still needs authoring before it animates.
- Fonts: only ship if owned → self-host; otherwise match the closest licensed face.
