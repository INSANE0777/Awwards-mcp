# Changelog

> **Versioning note:** every release through v1.6.0 was an **alpha**;
> `v1.0.0-beta.1` was the beta. `v1.0.0` is the first **stable** release.

## Unreleased

### DESIGN.md skill and guarded public capture

- Added `publicOnly` to `capture_live_site`, `capture_component`, `export_design_tokens` and `analyze_page_structure` (and their v2 branches). It refuses private/loopback/metadata destinations before launch and routes every browser request through the existing pinned public-address proxy.
- Token, structure and component outputs now include bounded capture provenance: requested-URL hash, redacted final URL, capture time, viewport, settle policy and extractor version.
- New `awwwards-design-md` skill in **https://github.com/INSANE0777/awwwards-skills** builds a cited DESIGN.md plus `design-evidence.json` for one public URL. It composes existing tools; it is not a new MCP tool and does not claim official brand systems or recovered source tokens.

## v1.17.1 - 2026-11-03

### Skills now install separately

- The bundled `skills/` tree, its `_memory` registry and `scripts/skill-memory.mjs` have moved to **https://github.com/INSANE0777/awwwards-skills**. They are no longer part of this repository or its npm tarball.
- The old `node_modules/awwwards-mcp/skills` copy workflow is gone. Install with:
  ```bash
  npx skills add INSANE0777/awwwards-skills
  ```
- MCP surfaces are unchanged: **41 full / 13 core / 15 v2**; tools, schemas, executable names and dependencies are unchanged.

### Tooling

- Fixed the packaged browser smoke to expect the current 41-tool default surface.

## v1.17.0 - 2026-11-03

### Index output contracts

- `get_index_status`, `get_index_stats` and the v2 `get_index` status/stats branches now advertise output schemas and return matching `structuredContent` while keeping their text output unchanged. Only these pilot tools advertise schemas; the rest of the surface does not.
- The response byte budget now counts the full serialized result, including `structuredContent`; truncation drops the structured payload instead of letting it bypass the limit.

### Search and taxonomy

- Cached and freshly fetched site searches now use the same FTS query, including after partial top-ups; punctuation is tokenized (`next.js` -> `next` + `js`) rather than joined.
- Tag and technology facets use canonical equality after one normalization path, so `react` no longer matches React Native.
- Legacy taxonomy caches without technologies refresh once on read, with a one-hour backoff and coalesced concurrent reads; a partial parse keeps cached filters/colors and reports `taxonomyStale`.
- Verification keeps full band labels and aligns motion-registry discovery with the census.

### Maintenance and tooling

- Parser-drift CI no longer commits, rebases or pushes to `main`; it keeps artifacts and issue reporting with read-only contents.
- CI covers Ubuntu Node 22/24, Windows 24 and macOS 15 (arm64), plus an isolated real-Chromium smoke. Windows runs with bounded workers.
- Added local-only v2 adoption and performance benchmarks (`scripts/v2-eval.mjs`, `npm run perf:bench`) with fail-closed egress guards.
- `spectorjs@0.9.33` is an optional dependency for the opt-in scene capture adapter.

### Scene3d hardening (review fixes)

- The scene3d verification deadline is now computed from the schedule it replays: sum of checkpoint waits + 10 s acquisition/comparison headroom, floored at 15 s and capped at 45 s (10 x 2000 ms waits => 30 s). It is raised once the pack is read and still measured from run start; a test-only explicit override is never extended or capped.
- A requested `scene3d` preflights the reference and build URLs on one shared DNS/private-IP guard before any legacy structure/scroll/hover scan, and the legacy acquisitions plus the static HTML read run behind its loopback proxy. A private, loopback or non-http(s) URL is refused with zero requests and an unavailable report; the legacy `overall`/`verdict` never change.
- `capture_scene_3d` and `verify_build` tag the chosen canvas with a per-run random marker and refuse duplicate or pre-marked decoys instead of guessing which canvas was selected (`marker-not-unique`).
- `build_pose_stub` dedupes same-index frame requests and discards stale texture completions, so a scrub tick cannot overwrite the newest frame with an older decode.
- `build_scene_stub` extracts frame basenames across both Windows `\` and POSIX `/` separators, so an exported pack builds the same scene.json on either host.

### Pose viewer fix (phase 0)

- `build_pose_stub` now calls `renderer.render` after texture load, camera updates and resize, so the generated viewer shows its first frame without waiting for a scroll event; `pagehide` disposes geometry, material, texture and renderer. Generated comments label the camera anchors as synthesized guidance: `pose-grid-v1` carries frames and scroll ratios, not camera transforms.

### Passive scene evidence (phase 1, full profile 39 → 40)

- New `capture_scene_3d` (full profile only) writes a `scene-evidence-v1` pack under `<cache>/scene-captures/<captureId>/`: up to 10 checkpoint viewport + clipped-canvas PNG frames, scroll/canvas/DPR/pointer measurements, each checkpoint's post-screenshot `stable`/`stabilityReason` flag, passive framework hints and up to 200 redacted response resources. It downloads no assets during capture; without adapters it recovers no scene graph, camera, controls, shaders or geometry, and `coverage.capabilities` says so explicitly. It cannot detect a WebGL context loss on the reference page. Loopback/link-local/private/metadata/reserved hosts are refused; a loopback proxy set on the browser before any page exists validates every connection, including redirect hops and popup requests, and dials only the resolved address. It is not a general firewall for Chromium's own traffic. Service workers are blocked.
- `capture_scene_3d` is a strict discriminated request: `{request:{op:"capture",...}}` or `{request:{op:"download_assets",...}}`. Each inventory row stores an `assetId` and either a fetchable internal URL (only when the observed URL has no query, fragment or credentials) or a skip reason.
- v2 `capture_page` gains `kind:"scene"` with `op:"capture"` / `op:"download_assets"` dispatching to the same handlers; the v2 surface stays at 15 tools and the full profile stays at 40.

### Licensed asset downloads and offline scene stub (phase 2, full profile 40 → 41)

- `capture_scene_3d` `op:"download_assets"` fetches up to 32 `assetId`s from one capture. `rights.basis` (`owned`/`licensed`/`permission`) and `rights.evidence` are mandatory because downloading is a licensing decision, are recorded with a timestamp in `provenance.json`, and are not verified by the server. It reads only that capture's evidence inventory, fetches with direct Node http(s) at 1 request/s (concurrency 1, manual redirects ≤5, every hop DNS-validated and private/reserved addresses refused, connection pinned to the validated address), caps at 16 MiB/file and 64 MiB/run with 15s body and 120s overall deadlines, writes original bytes atomically with SHA-256 and a MIME/magic-validated extension, and returns a compact `scene-assets-v1` summary (no inline bodies). No crawling, URL guessing, source maps or credentials.
- New `build_scene_stub` (full profile only) turns one `scene-evidence-v1` pack plus up to 32 local `assetBindings` into a deterministic Vite + Three.js project: `package.json` (pinned three 0.160.0 + vite), `index.html`, `src/main.js` (resize, reduced-motion static render, `GLTFLoader` for a bound glb/gltf, texture loading, a labelled placeholder plane when no model or supported adapter mesh exists, pagehide disposal, load-failure message), `scene.json` (bindings + frame references) and a provenance README. It validates the pack (regular file ≤2 MiB, inside `scene-captures` or explicitly exported) and every binding (observed non-script/shader `resourceId`, regular non-symlink file ≤64 MiB, allowed extension, no traversal or duplicates), then returns `files`, `assetCopies` to `public/assets/<assetId>.<ext>`, `unresolved`, `authoredDefaults` and `mode` (`reconstructed-subset` with a model binding or a supported adapter mesh, else `placeholder`). Strictly offline: no fetch, install, directory write or captured-code execution.
- v2 `build_motion` gains `kind:"scene_stub"` dispatching to the same handler; the v2 surface stays at 15 tools and the core profile stays at 13.

### Opt-in scene3d verification (phase 3, no new tool; full stays 41, core 13, v2 15)

- `verify_build` accepts optional `scene3d: {referenceCaptureId, buildSelector, tolerances?}`. It replays the reference `capture_scene_3d` pack's checkpoints against the build's `<canvas>` in a fresh browser: same viewport, canvas backing size/DPR, measured scroll position, optional pointer and settle wait. Reference checkpoints must be stable: `capture_scene_3d` records `stable`/`stabilityReason` from a post-screenshot re-probe, `stable:false` is rejected with that reason, and legacy packs without `stable` remain accepted. Capture cannot detect a reference-side WebGL context loss. It compares the clipped canvas PNGs pixel-by-pixel and returns a separate `scene3d` block with `status` (`comparable`/`inconclusive`), `verdict` (`within-tolerance`/`outside-tolerance`/`inconclusive`), per-checkpoint metrics/reasons, `coverage` and `limitations`. The legacy `overall`/`verdict` are unchanged and never certify a canvas; a gate failure degrades to an inconclusive block.
- Both `tolerances.pixelThreshold` and `tolerances.maxChangedFraction` are required for a within/outside verdict. With either absent the gate still reports `changedPixelFraction` and `meanAbsoluteChannelError` but returns `inconclusive`. `tolerances.cameraAngleDeg` is accepted but has no effect with `scene-evidence-v1`, which carries no comparable camera angle (the three adapter stores one camera pose, not an angle; spector stores none): `cameraAngleDeg` stays `null` with a stated reason, and that note alone does not make a measured pair incomparable.
- Any blocking checkpoint reason makes the whole gate `inconclusive` — never a partial pass: a missing, unreadable or blank frame; an unstable reference frame; mismatched DPR or canvas backing size (never rescaled); a scroll mismatch before the screenshot or a post-shot drift beyond ±2 px from either the pre-shot position or the reference `actualScrollTop`; a canvas rect/backing/DPR change during the screenshot; a WebGL context loss; a missing/lost scroll root, a missing canvas or invalid selector; the dynamic watchdog or a failed capture. Build and diff PNGs (red changed, dimmed grey unchanged) are written under `<cache>/scene-captures/<referenceCaptureId>/verify/<run>/`; an artifact write failure is reported in `limitations` and blocks a within/outside verdict, and an uncreatable or symlinked verify path makes the whole gate inconclusive.
- The watchdog (dynamic: replayed checkpoint waits + 10 s headroom, floor 15 s, cap 45 s) is armed before the pack is resolved and covers pack read, DNS gate, artifact preparation, frame reads, the Playwright import/loader, browser launch and comparison. A timeout returns `inconclusive` with the deadline reason.
- Cleanup closes tracked scene3d resources concurrently under one shared 3 s grace, so the result returns within the deadline plus roughly 3 s. Close promises still pending after the grace are abandoned and their underlying teardown may linger; resources that resolve late still get a closure attempt, but it is not awaited.
- Build URLs must be http(s) on a host that resolves to a public address; loopback/link-local/private/metadata/reserved destinations are refused. The exact-origin loopback allowance is an internal test seam, not a tool input, so a localhost build is inconclusive for this gate.
- `compact:true` keeps the `scene3d` block whole. Honest limits: one frame per checkpoint (time-shifted animation can read outside tolerance), the gate compares pixels only and does not read the pack's scene/camera/geometry evidence, and there is no rescaling (matching DPR and backing size required).

### Opt-in three adapter (phase 4, no new tool; full 41, core 13, v2 15)

- `capture_scene_3d` `op:"capture"` accepts `adapters:["three"]`; v2 `capture_page` `kind:"scene"` carries the same optional field. It reads only objects reachable after load from `window.THREE`, `window.scene`/`camera`/`renderer`/`controls` and `window.app`/`experience`/`viewer`/`world` (including those holders' `scene`/`camera`/`renderer`/`controls` fields), with no heap crawl, hooks or network. A module-local scene is invisible, so absence is not evidence of absence.
- The pack gains `evidence.three` (`three-adapter-v1`): `available`, `reason`, `revision`, scene nodes (≤500, depth 20, with `truncated`/`total`), cameras (≤8), lights (≤8), controls, materials (≤32) and redacted texture references (≤200) that link to an inventory `assetId` when the observed URL matches. `coverage` reports what the adapter actually observed; a requested adapter that finds nothing leaves capabilities unknown, not available. The three adapter never reads shader source.
- `build_scene_stub` reconstructs only Box/Plane/Sphere/Cylinder geometry (captured numeric dimensions where present; missing or out-of-range dimensions fall back to an authored `1` and are listed in `unresolved`), MeshStandard/MeshBasic materials (other types fall back and are listed; multi-material keeps the first), and a validated `PerspectiveCamera` applied from its exact `matrixWorld` with matrix auto-update off. The captured camera is static (no idle orbit). Controls are never recreated: OrbitControls is not wired because its TRS update can move a sheared or non-orthogonal pose, so any captured controls are listed in `unresolved`. Unsupported geometry, materials and cameras are also listed, never guessed. Captured lights are recorded but not applied; lighting and background remain authored. Shader source and `userData` are never read or executed by the scaffold. The idle orbit is used only when the pack has no usable adapter scene. `mode` is `reconstructed-subset` with a model binding or at least one supported adapter mesh, else `placeholder`.
- Honest limits: module-local scenes are invisible; captured node transforms are parent-relative and meshes are flattened at the scene root, so parent transforms are lost; texture maps bind only when `assetBindings` supplies a local image for the texture's `assetId` (otherwise the flat colour stays and the gap is listed).

### Opt-in spector adapter (phase 5, no new tool; full 41, core 13, v2 15)

- `capture_scene_3d` `op:"capture"` also accepts `"spector"` in `adapters`; v2 `capture_page` `kind:"scene"` carries the same optional field. The array takes at most two entries, with no duplicates, so `["three", "spector"]` is valid. Capture still writes the same `scene-evidence-v1` pack.
- `spectorjs@0.9.33` is an optional dependency. When installed, its local `dist/spector.bundle.js` (about 1.19 MB) is read from disk and injected as an init script before navigation, so its WebGL spies exist before the page creates a context. The bundle is read locally and not fetched over the network; the Spector UI is not shown, worker contexts are not captured, and one WebGL frame is captured per request. A missing package records the install hint `npm install --save-optional spectorjs@0.9.33`; a probe timeout or error records a reason. None of these failures fail the scene pack or block checkpoint frames.
- `evidence.spector` (`spector-adapter-v1`) records the WebGL context version and up to 16 context attributes, command total/draw-call count/top 30 names/status counts (`unknown`, `unused`, `disabled`, `redundant`, `valid`, `deprecated`), up to 8 programs with link/validate status and info logs, up to 16 shaders total, shader source capped at 64 Ki characters per shader and 256 Ki characters total (with original `length` and `truncated` flags), up to 8 analyses (8 keys each), canvas dimensions, limits and truncation flags. It never transfers command arguments, command results, GL state, stack traces, memory or the raw capture.
- Shader source is untrusted page text: it is bounded, stored as data and never executed. `coverage.capabilities.shaders` is `available` only when at least one shader source was captured; a spector request that captured none leaves it `unknown`, and capture without any adapter leaves it `unavailable`.
- Honest limits: one frame per request. A page that has stopped drawing can yield no draw calls and therefore no programs; the adapter still returns context and command evidence with an empty `programs` array. The summary cannot explain why a draw call differs because arguments, results, state, stack and memory are deliberately absent.

## v1.16.1 - 2026-11-01

Security and correctness hotfix for the published 1.16.0.

- `build_gsap_stub` no longer interpolates census text into generated JavaScript
  comments without escaping: newlines cannot end the comment, and angle brackets
  cannot close the surrounding `<script>` tag.
- The opt-in bundle walk rejects a discovered chunk whose redirect leaves the
  page origin; every walk redirect hop is validated before the request.
- Motion recording is now annotated non-read-only and destructive in both
  profiles (`record_site_motion` and v2 `capture_page`) and its description
  discloses that it can click interactive elements and submit their forms.
- The motion-study skill marks `scripts/skill-memory.mjs` as checkout-only, and
  the README skill-copy commands include `skills/_memory`.

## v1.16.0 - 2026-10-31

Robots compliance, an opt-in consolidated v2 surface, and correctness fixes
across search, motion evidence and verification. The default surface is
unchanged: `full` still registers all 39 tools.

### Robots compliance: elements gallery retired

- Deleted the gallery indexer; `awwwards-index --elements` now exits 2 with an explanation before any request, and `AwwwardsClient.getHtml` rejects `/elements` and `/elements/*` paths before any request.
- `search_elements` returns a no-network empty-corpus note instead of indexing; cached gallery records and `source:"site"` records remain searchable. `new_winners` backfills each winner first reported after its baseline poll from that winner's site page when reachable (the seed poll backfills nothing; failed per-winner fetches are not retried).
- Docs updated: tool table, elements section and robots notes. The `search_elements` description was updated to match.

### Opt-in v2 surface (15 tools)

- `AWWWARDS_MCP_PROFILE=v2` registers 15 tools instead of the 1.x list: ten consolidated tools (`search_references`, `get_reference`, `browse_awards`, `get_index`, `inspect_page`, `analyze_motion`, `capture_page`, `audit_page`, `build_motion`, `monitor_awards`) plus five retained flat tools (`create_design_brief`, `build_project`, `verify_build`, `verify_flow`, `analyze_network_capture`). Profiles are exclusive and read once at startup, so the 1.x names are not registered at all in a v2 session; set the variable and restart the server.
- Every consolidated tool accepts exactly one `request` object with one branch (`kind` or `action`). There is no all-mode and no cross-branch mixing; branch objects are strict. `monitor_awards` is keyed on `action` (`poll_winners`, `add_watch`, `list_watches`, `remove_watch`).
- `full` remains the default with all 39 tools; `core` registers 13; `v2` registers 15.
- `skills/v2-routing.md` maps all 34 replaced 1.x names to their v2 calls, lists the five retained flat tools, and records the v2-only rules. The skills carry matching profile notes so an agent does not call 1.x names in a v2 session.

### v2 contract fixes

- Legacy `capture_component` gains `maxDepth` (root = 0, clamped 0-64; 0 or absent means unlimited) and sets `depthCapped: true` when the limit omitted children. The v2 `capture_page` component branch fixes the cap at 12 so packs stay inside Code Mode's depth limit; it is not configurable on that surface.
- `build_motion` `gsap_stub` and `manifest` reject a compact scroll census (it omits `anims[]` and replaces keyframes/props/durations with counts) with an explicit "rerun with compact=false" error. `pose_stub` validates its optional census the same way and rejects an empty pose grid (no captured frames) instead of rendering a frameless stub.
- `build_project` docs state that its output is source, not a servable site: run `npm install && npm run build`, then serve the generated output (Vite/Astro `dist/`, Next `.next` with `next start`).
- The v2 server instructions advertised `AWWARDS_MCP_PROFILE` (two W), one W short of the accepted `AWWWARDS_MCP_PROFILE` (three W); `AWARDS_MCP_PROFILE` (one W) remains the one-release legacy fallback. They now advertise `AWWWARDS_MCP_PROFILE`, and a test extracts the advertised name and switches profiles with it.

### Search and taxonomy

- The FTS index is re-run after a scrape upsert, so a cold search and a warm one return the same rows.
- Color and winner-category filters stay bound to the fetched filter page: color rows carry no colors and winner cards carry no award marker, so a fresh page is the only membership evidence. A failed top-up preserves the requested cached page window; a successful top-up still scrapes.
- Facets go through one normalization path (`canonicalFacet`: trim, slugify, display-slug alias, technology alias) and compare exactly. Eleven display/URL aliases (`adobe-illustrator` → `illustrator`, `adobe-photoshop` → `photoshop`, `angular` → `angularjs`, `css` → `css3`, `p5-js` → `p5js`, `sketch` → `sketchapp`, `swiper-js` → `swiper`, `curtains-js` → `curtains`, `matter-js` → `matterjs`, `navigation-menu` → `navigation`, `seo` → `seo-1`) meet their live URL slugs, and `react` no longer matches `react-native`.
- Free-text tokenization splits punctuation into token boundaries before alias expansion, so `next.js` searches as `next` + `js` rather than a glued `nextjs` that matches nothing; wrapped aliases such as `nextjs,` still canonicalize.
- The winner-category award set is derived from `AWARD_FILTERS`, so a newly added winner category cannot drift out of the set.

### Verification evidence

- Band labels are compared at full length (the 24-character truncation is gone); `verify_build` reports the original display labels for matched and leftover bands. Anonymous or duplicate rebuild labels (empty/body, or repeated labels) now fall back to same-tag + closest-height matching (≤25% gap), so a rebuild without stable ids/classes still scores.
- Motion DNA and the scroll census resolve the ScrollTrigger registry the same way (window global first, gsap plugin registry as fallback), so the fingerprint and census cannot read different registries.
- `ScrollCensus` gains `gsapRegistryCount`, the full pre-cap registry size (detail rows stay capped at 20), and compact output keeps it. `get_motion_dna` reports it in `censusSummary`, separate from `counts["gsap-scrolltrigger"]`, which tallies element animations classified onto a trigger.
- Motion DNA cache rows without `gsapRegistryCount` are treated as misses and recaptured once.

### Core profile

- `core` now registers 13 tools, adding `get_annual_categories`: annual nominees are unusable without category discovery. `full` (39) remains the default.

### Dependencies

- Vitest 4.1.12 and `@vitest/mocker` 4.1.12 (dev only), clearing the two moderate advisories; no runtime dependency change.

### Review hardening

- `build_project` now enforces canonical source/output containment for asset, stylesheet, script and generated-file reads/writes, rejecting symlink and junction escapes.
- Pose evidence is validated as PNG data URLs with frame/total byte and count caps; finite numeric fields are required, and embedded JSON escapes `<`, preventing `</script>` breakout in generated stubs.
- `audit_url` validates protocol and origin before every asset redirect hop (max 5); CDP discovery refuses redirects instead of following them.
- Bundle acquisition counts attempted initial and walk fetches against their caps, keeps deadlines through body consumption, and streams HTML/chunk bodies against byte limits.
- Browser launch subscribes to child `error` and bounds CDP discovery/WebSocket/command waits, returning an error instead of crashing.
- Advertised Unix bins have shebangs and alias-safe entry guards; `npm run pack:smoke` installs the tarball and exercises every bin on CI.
- Browser-enabled installs are documented as a global side-by-side layout (`awwwards-mcp`, `playwright`, `ffmpeg-static`); `npx` is core-only.
- Score sorting batches metadata reads instead of reopening SQLite per candidate. Cache locks are atomic and owner-scoped; SQLite uses a busy timeout and transactional migrations.
- Cache directories/database and newly written images use private POSIX modes, image writes are atomic, image downloads are capped, non-rendered (hidden/display:none/visibility:hidden) page text is omitted from component evidence, and page-derived text is labeled untrusted.
- npm publication requests provenance.
- README logo and icon use repository-relative assets so GitHub renders them on the branch and after merge.

## v1.15.1 - 2026-10-30

Tool-definition clarity: descriptions, parameter semantics and published server
instructions. No handler, type, default, annotation or profile changes.

### Tool metadata

- `search_sites` documents AND filters, `count` (6, max 12), one-based `page` over the local matched set (upstream query-string pagination is not crawled), live color requests, routing to directory/elements/collections/winners/details, and both fallback paths: a failed top-up keeps the cached page window; an outer failure serves stale page 1 with color unchecked.
- `create_design_brief` documents the cited Markdown + versioned JSON output, cache-first detail/element/Motion DNA evidence, missing-detail fetches, the optional browser structure pass, all eight parameters, and that `audience` is carried into the summary rather than filtering evidence.
- `verify_flow` documents top-level and per-action fields (`y` is an absolute window position), the 150 ms settle, `load` + 3 s vs `networkidle`, the Playwright dependency, and routing to `verify_build`/`build_project`.
- `verify_build.waitStrategy`, `analyze_bundle.url`, `analyze_scroll_map`/`analyze_hover_census` `waitStrategy` (both default `networkidle`), `search_motion.limit`, `search_elements.limit` and `watch_site.action` are documented; `search_elements` no longer claims category and stack are mutually exclusive.
- Published `SERVER_INSTRUCTIONS`: full-profile loop, routing groups, evidence-not-grade policy, core/full profile, CDP vs Playwright, and the ffmpeg requirement.
- New `test/tool-descriptions.test.ts` pins the published schema text, defaults and optionality through `createServer`.

## v1.15.0 - 2026-10-30

Token export, image-delivery evidence, honest inner-scroll capture, and the MCP
TypeScript SDK v2 migration with the internal refactor.

### SDK v2 and internal refactor

- Migrated to MCP TypeScript SDK v2 (`@modelcontextprotocol/server`): registrations go through `registerTool` with a `z.object` input schema, and `serveStdio` builds a fresh server per connection (the modern-probe → legacy fallback discards the first instance and builds a second).
- Split the monolithic `src/cli.ts` / `src/server.ts` into `src/tools/*` registrations and `src/server/handlers/*` over one handler context. Tool names, annotations and payloads are unchanged.

### New tools (2) - 37 → 39

- `export_design_tokens` - deterministic design tokens from one `capture_component` style pack: colors, typography, spacing, radii, shadows and borders as ordinal CSS variables (`--color-1`, `--space-1`, …) plus a Tailwind theme map. `selector` defaults to `body`, `maxNodes` to 800 (50-2000); `include` filters categories. Values are deduped and frequency-ranked (count then code point, never `localeCompare`), cap hits or node truncation set `truncated` + `notes`, and the CSS contains no URLs. No semantic names. (playwright)
- `analyze_images` - image-delivery evidence from one live page: totals by format, `loading` split (lazy/eager/missing), `srcset`/`sizes` coverage, intrinsic vs rendered dimensions (oversized/tiny/zero-rect), broken images and alt coverage, with ≤20 issue samples (origin+pathname only, query/hash stripped, data URI reduced to `data:<mime>`). The page loads its own assets — no tool-initiated fetches or downloads. `maxImages` default 200 (max 500); evidence, not a WCAG grade. (playwright)
- Core profile keeps the same 12 build-loop tools; `full` exposes all 39.

### Inner-scroll capture honesty

- `capture_live_site` gains `scrollCapture: "auto" | "anchors" | "viewport"` (default `"auto"`). On inner-scroller pages (`preScroll` reports a `scrollRoot`) it re-queries exactly one match and returns `mode:"anchors"` — six ordered viewport screenshots at `round(i*(scrollHeight-clientHeight)/5)`, JSON `anchors[].scrollTop`/`file` paths, no top-level `file`, and scrollTop restored in `finally`. `scrollCapture:"viewport"` returns one explicit viewport shot with `mode`/`scrollRoot`; 0 or >1 re-query matches returns an `{error}` naming the label and count. Document-scroller payloads are unchanged.
- `preScroll` now returns `{ scrollRoot, scrollHeight, clientHeight }`; handlers branch on the `CaptureResult` union, so anchors are reported as text JSON and never as a single full-page image.
- README/README.dev tool tables and counts (37 → 39), module map and capture docs; recreate Phase 1/3 guidance, doctor capture troubleshooting and setup tool list updated.

## v1.14.0 - 2026-10-28

Coverage honesty, output economy and responsive evidence.

### Hardening

- `capture_live_site` waits for full-screen preloaders before shooting: after the pre-scroll it polls every 250 ms (10 s cap, timeout swallowed) until no visible fixed element covers ≥90% of the viewport in both axes with z-index ≥100. `waitForOverlay: false` skips the wait, and pages without `evaluate` (or fake pages) are treated as overlay-free, so an overlay that never leaves cannot fail a capture. The predicate is the exported pure `isBlockingOverlay`; the in-page snippet only collects fixed candidates.
- `preScroll` (capture + structure) is hard-capped at 80 × 450px steps and 8 s per walk, re-reading `scrollHeight` but stopping at either cap and always returning to the top — a page whose height grows on every scroll can no longer stall a capture.
- `analyze_page_structure` detects the real scroll container on body-pinned sites (`body{position:fixed}` + an inner `overflow-y:auto/scroll` element): `totalHeight` comes from that element's `scrollHeight`, candidates/landmarks/responsive y's are mapped into scroller coordinates, and the container is reported as `scrollRoot` (`tag#id.class`, absent for document-root scrolling). `preScroll` drives and resets the same container, so a 900px one-band result becomes the real band map.
- `capture_component compact:true` semantics documented: nodes keep only `{tag, classes, rect}` (styles, text, svg, pseudos, anims dropped) plus top-level fonts/colors; typography/palette summaries are full-mode only. The reported `analyze_hover_census compact:false` TypeError was not reproducible — `compact` only shapes the response after capture, and explicit `compact:false`/`true` handler tests now both pass.
- Bundle import-graph extraction replaces its lazy cross-statement ESM/reexport regexes with a one-pass statement scanner: declarations up to 8 KB (long binding lists included), same `raw`/`kind` values and dedupe/cap semantics; a declaration past the cap sets `truncated:true` instead of disappearing silently. A 1 MB `import ` flood yields no edges in milliseconds instead of backtracking.
- `analyze_network_capture` HAR cap lowered from 50 MB to 20 MB, re-checked after `readFile` so a file that grows mid-read is rejected with the same error; the 2000-entry cap is unchanged.
- `capture_live_site` inline previews are capped at 2.5 MB of base64 (override with `maxInlineBytes`), decided from the raw PNG size before conversion; `inline: false` keeps the saved file and returns text-only, and an omission points at the saved file and the budget instead of suggesting an impossible inline:true. `CaptureResult` now carries optional `base64` + `inlineOmitted`.
- `AWWWARDS_MCP_PROFILE=core|full` (default full) can expose only the 12 build-loop tools; `AWWWARDS_MCP_MAX_RESPONSE_BYTES` (default 32 MB) replaces oversized `content` with a `{truncated:true,...}` JSON block while preserving `isError` and other result fields; `AWWWARDS_MCP_DEBUG_MEMORY=1` logs one JSON line per call on stderr. The v1.14.0 `AWARDS_MCP_*` spellings are accepted as a one-release fallback.
- `AWWWARDS_MCP_IMAGE_RETENTION_DAYS=N` (default 0 = off; legacy `AWARDS_MCP_*` accepted) prunes cached screenshots older than N days once at startup, best-effort.
- README/README.dev resource-limit docs (32 MB default, canonical env names, long imports, pose/component inline budget); hardening tests for the scanner (646/1411-char declarations, 1 MB flood), post-read HAR race, default screenshot budget, tool profile subset, response budget preservation, stderr logging and image retention.

- `get_site_details { slugs }` batch enrichment (1-10, ordered, cached/fetched/error/skipped, stops on block, compact details, no images).
- `get_index_stats` reports per-metric `sample` and `insufficient`; below 30 parsed rows it suppresses colour/motion lists and score averages instead of publishing misleading numbers. This is a deliberate behaviour change for small caches.
- `audit_url` gains `compact: true` (reduced perf + pre-cap severity counts + nextActions + coverage) and always-present ranked `nextActions`; `verify_build` gains `compact: true` (verdict, scores, band counts).
- `analyze_page_structure compare:"mobile"` returns element-level `responsive` evidence: page overflow, overflow offenders, small text, small tap targets, document rects and selectors, per-kind caps. No screenshots, no hidden-band or wide-fixed checks.
- README routing table, compact guidance, and skill notes.

### Web reverse-engineering extension (P1-P5)

- `analyze_network_capture(path, top?)` - offline HAR 1.2 API-surface evidence: requests grouped by method + origin + templated path (dates, versions, UUIDs, hex ids and numbers templated; emails, tokens and high-entropy segments redacted), with counts, statuses, content types and query names only. 20 MB / 2000-entry caps; `evidenceCoverage` discloses exclusions; bodies, headers and query values are never returned.
- `analyze_bundle bundleIntel: true` - opt-in quoted routes, vendor signatures, source-map presence (never fetched) and module graph; default output keys are unchanged without the flag.
- `verify_flow` - step-aligned interaction comparison: the same 1-6 scroll/click/wait steps on a build and a reference, then path, scroll delta, skeleton hash, text hash and element count per step. `same` only when both sides are complete and untruncated; truncated or failed states are `unknown`. Two fresh launches, never attach, no screenshots.
- `analyze_page_structure cdpEndpoint` - loopback CDP attach to a browser the user started: requires `AWWWARDS_MCP_ATTACH=1`, selects an already-open page whose normalized href matches exactly, never navigates, scrolls, clicks or creates tabs, and disconnects without closing anything. An `http://` endpoint is resolved via `/json/version` and the returned ws URL is re-validated before connecting. Rejects `compare: "mobile"`, a custom viewport and responsive evidence; the result carries `attached: true` additively.
- `evidenceCoverage` on the new surfaces (HAR, flow, opt-in bundle intel); tool count 37; README tool/routing rows and attach setup section, README.dev counts, skill pointers, annotation hints.

## v1.13.0 - 2026-10-25

Discovery, sources, and inspection: 35 tools, with award data from Awwwards' official API,
curated collections and the agency directory, plus evidence-only audit surfaces.

### New tools (9) - 26 → 35

- `get_annual_categories`, `get_annual_nominees`, `get_annual_nominee` - Annual Awards
  via the official public read-only API (`llms.txt` / `openapi.json`): 6 categories,
  bounded nominee hydration (default 10, max 20 at 1 req/s), site/user detail with
  country/date/designBy/images/videos. 7-day cache, stale-on-failure marked, 403/429
  stop all further requests. Media URLs are reference-only (never downloaded).
- `get_collections`, plus collection detail by slug/page - curated and member collections
  (`/awwwards/collections/<slug>/`, `/<owner>/collections/<slug>/`), element-only
  collections reported instead of false parser drift.
- `search_directory` - agency/studio directory with path filters (82 canonical countries,
  categories, budgets), client-side free-text query, `applied`/`ignored` arrays,
  contact PII stripped.
- `audit_url` - runtime evidence (fps, dropped frames, long tasks, layout thrash) via an
  installed Chrome/Edge, plus an anti-pattern scan over bounded same-origin CSS/JS.
  Runtime and static halves degrade independently; evidence only.
- `analyze_accessibility` - composited contrast (opacity groups skipped and counted, never
  approximated), alt coverage, heading ladder, focus/tabindex, form labels, lang/title.
  `heuristic: true`, never a WCAG pass/fail.
- `get_index_stats` - aggregates over the local cache only: all-time sites/elements/tags
  vs windowed details/palettes/scores/motion DNA, every metric coverage-disclosed.
- `build_motion_manifest` - census + band map → `motion.manifest.json` scaffold;
  `measured` stays false when the census has no animations.

### Extended

- `capture_component` gains `typography` (families/sizes/weights/line-heights/tracking,
  top 12) and `paletteSummary` (strict colour grammar; background shorthands, gradients,
  images and alpha-0 values rejected and counted) summaries; inert in compact mode.
- `analyze_page_structure` gains `compare: "mobile"` (390×844 second pass) returning
  `mobileBands` + label-matched band diff; a failed mobile pass keeps the desktop result
  with `mobileError`.
- Award discovery: 9 new cuts (`sotm`, `soty`, `nominees`, six `winner_category_*`),
  persisted nominee flag, `list_categories` v2 (12 award filters + technology slugs),
  15 live-verified technology aliases applied in URLs and client-side filters.
- Skills and docs: collections/directory discovery, mobile compare in the section loop,
  motion-manifest hand-off; README "Official Awwwards resources" + non-affiliation note.

### Fixes

- Palette correctness: strict colour parsing, alpha-0 forms rejected, dead style keys removed.
- Accessibility: ancestor opacity groups excluded from ratios rather than faked.
- Mobile compare: desktop result preserved when the mobile capture fails.
- Collections: page-1 404 wording, page-N notes, `owner`/`ref` round-trip, v2 list cache.
- Directory: canonical-country validation blocks Awwwards' wrong-country 200 fallback.
- Bundle/index stats: honest all-time vs windowed semantics, severity-sorted findings.

## v1.12.0 - 2026-10-23

From capture to an owned project: conversion, authored motion, and a sharper audit layer.

### New tool (26 total) — `build_project` + `awwwards-build-project` bin

- Exact rebuild HTML or a real-site rehost → a runnable **Vite**, **Astro**, or **Next.js** project.
- Native structure: sections become real components (JSX for Next/Astro), shell chrome kept once, CSS split into tokens + site, ordered script loader, head metadata / JSON-LD / pre-paint boot replayed in captured order.
- Carries local external CSS/JS, inline scripts, and CDN libraries; StrictMode-safe loader; explicit warnings whenever content cannot be split safely (never silent loss).
- `--authored --motion <census.json>`: drops site logic (head boot and animation libs stay), emits `motion.manifest.json` (measured per-section triggers + `pageTriggers` for unattributed rows) and inert per-section/page motion hooks/modules to author against.
- Proven on a real hand-built GSAP site: all three targets build; desktop 1440×900 (8 anchors) and mobile 390×844 (5 anchors) parity exact — scrollHeight 25,650 identical, zero console errors/404s, reduced-motion clean.

### Audit wave

- Band-split v2: landmark subdivision + residual second pass kill mega-bands (a 20,631 px giant became 10 bands).
- `build_gsap_stub` consumes measured scrub curves (real progress values, not guessed timelines).
- Design briefs carry choreography hints (stagger / delay deltas from measured tween data).
- `get_motion_dna` runs a single browser launch and adds `censusSummary`.
- Compact response modes (`compact`) on the heaviest tools — measured ~38 % token cut.
- `awwwards-verify` bin: CI-grade verdict with exit codes (0 pass … 4 missing tool).
- `analyze_stack`: Webflow/Tailwind arbitration (no more Tailwind false positives on Webflow classes).
- `analyze_bundle`: opt-in chunk-graph walk, static import edges, JSON-LD/importmap filtering, pretty-code keyword scan, 4-char regex floor.
- `verify_build`: opt-in DOM-structure diff (missing/extra/rect-drift evidence, `incomplete` honesty flag); measured fps window audited and documented.
- Mobile hover census skips the hover loop with an explanatory note instead of pretending.

### Skills (seven)

- `recreate` — link-to-site playbook: Awwwards lookup first, evidence capture on any URL, study-build terms, exact assets, scroll-anchor QA, conversion **only on request**.
- `motion-authoring` — converting manifest + inert skeletons into real motion (topology, intent map, per-target surfaces, parity gate).
- `awwwards-section-loop` gains the convert-and-author close-out; `awwwards-motion-study` teaches the manifest hand-off and bundle forensics; `awwwards-setup` mentions optional webcrack.

### Fixes

- Issue #23: viewport-qualified screenshot/motion filenames, per-recording sheet directory, no screenshot read-back race.
- gsap stub keeps `pin` on superseded scrub rows; compact site details restore descriptions; daily env hint for optional webcrack; README tool/skill counts.

## v1.11.0 - 2026-10-20

The precision ladder completed: scrub curves, choreography, and polish.

- `analyze_scroll_map` gains an opt-in `scrubProbe`: the tool drives the page
  through up to 8 scroll steps and samples each scrubbed trigger's real
  progress curve (scrollY -> progress -> transform), so scrub behavior is
  measured, not inferred from declared start/end.
- `analyze_scroll_map` now also returns `choreography` hints: stagger values
  detected from captured tween vars and delay-step groups - rebuilds get
  entrance ordering, not just per-element timing.
- Bundle forensics polish: inline `ld+json`/`importmap`/`speculationrules`
  blocks are no longer captured as chunks; keyword search now also scans
  webcrack-de-obfuscated output (matches carry `source: "raw" | "pretty"`);
  the unpack cap counts only qualifying chunks (an oversized or failing
  chunk no longer consumes one of the 10 slots); distinct hint when webcrack
  is installed but nothing was unpacked.
- Motion Evidence Sheet: the first keyframe no longer wastes its slot on the
  pre-paint frame (guarded to 600ms); the cursor-trail overlay scales with
  the actual viewport instead of assuming 1440x900.
- Fixed a fetch-order race in search previews that intermittently reordered
  thumbnails when serving from cache (deterministic preview fetch + slug
  tie-break; the long-standing ~10% suite-order flake is gone).

## v1.10.0 - 2026-10-20

Motion precision, bundle forensics, and a measured verify loop. Now 25 tools.

- New `analyze_stack` tool: framework and CSS fingerprint (Next, Astro,
  Nuxt, Remix, SvelteKit, WordPress, Webflow, Framer; Tailwind/Bootstrap
  density) from one polite HTML fetch - no browser, no new dependencies.
- New `build_gsap_stub` tool:turns captured motion censuses into a runnable
  GSAP + ScrollTrigger stub (durations, easings, scrub/pin, reduced-motion
  guard).
- New `analyze_bundle` tool: bundle forensics for a live page - fetches its
  script chunks (bounded: 40 chunks, 10 MB, 1 request/second; script tags,
  inline scripts, and modulepreload/preload hints), saves them locally, and
  greps keywords so agents can read the actual animation mechanism instead
  of guessing. Optional webcrack de-obfuscation/unpack if installed (lazy,
  degrades to raw chunks + hint). Runs on URLs you are authorized to
  analyze.
- `analyze_scroll_map` now returns value-precise motion: per-animation
  keyframe matrices (real from/to values like `translateY(56px) -> 0`,
  bounded to 4 frames x 4 props/row) and a site-level `gsapTriggers` array
  with compiled pixel `startPx`/`endPx`, live `progress`, and tween vars
  (e.g. `stagger: 0.09`).
- `analyze_hover_census` now samples animations DURING hover (`activeAnims`
  + in-flight transform trail), catching event-driven tweens that do not
  exist at rest - the on-hover letter-swap class of effects is now
  recoverable without reading source.
- `verify_build` is instrumented: beyond band/motion scoring it runs a
  real-browser perf probe on the build (fps, dropped frames, long tasks,
  layout thrash) plus an anti-pattern scan (transitioning blur, animated
  layout properties, `transition:all`) and names the worst offender in the
  evidence.
- Existing installs: the daily environment notice now hints the optional
  `webcrack` install for bundle de-obfuscation (hint only - environment
  health is unchanged without it).
- CI: parser-drift probes treat network blocks as inconclusive instead of
  filing false drift issues.
- Docs/skills: NEUTOMNI one-shot rehost showcase, any-URL recreation
  positioning, and all five skills updated for the new tools.

## v1.9.0 - 2026-10-17

Motion Evidence, fidelity capture, and the recreation pipeline.

- New `capture_component` tool: serialize any page component (structure,
  computed-style tokens, animations, pseudo-elements) into a portable
  component pack for rebuild tooling. Runs on any URL. New `maxNodes`
  option (50–2000, default 400) for large sections.
- New `capture_pose_3d` tool: hero-canvas reference frames across a scroll
  journey → camera pose grid.
- New `build_pose_stub` tool: pose grid → offline three.js + GSAP replay
  skeleton (reduced-motion guarded, deterministic).
- `record_site_motion` now emits a Motion Evidence Sheet beside the filmstrip:
  census-timed keyframe grid, consecutive-frame difference masks, onion-skin
  composite, cursor-trail overlay, inspector-style timeline strip, and
  `motion-sheet.md` (video→document captions stamped with t / phase / scrollY).
  Degrades gracefully — the recording never fails because the sheet does.
- Fidelity capture: `capture_component` now records 44 computed-style keys
  (layout offsets, background image/size/position, flex/grid alignment,
  aspect-ratio, filters) plus `::before`/`::after` pseudo-elements —
  pixel-adjacent rebuilds, not just structure.
- New `analyze_hover_census` refinements: real-page hover semantics
  (IDL camelCase access, :hover-stripped candidate matching).
- Fixed a tsx-only snippet-injection failure in the hover census
  (`installSnippetShims` now applied everywhere snippets are evaluated).

## v1.8.0 - 2026-10-12

Deterministic design briefs and evidence-backed interaction guidance.

- Added the `create_design_brief` MCP tool for cited, versioned briefs from
  shortlisted Awwwards references.
- Reused cached site details, element metadata, and Motion DNA; optional
  structure analysis runs only when requested.
- Added an Interaction Plan for observed cursor/hover, scroll, entrance/reveal,
  easing, and duration signals, with reduced-motion and keyboard-access
  guidance. Missing evidence is reported rather than inferred.
- Documented the design-brief workflow in the `awwwards-inspiration` skill and
  README.

## v1.7.2 — 2026-09-29

Reliability & housekeeping. No runtime tool changes.

- **Parser-drift probe: network rejections no longer masquerade as parser
  drift.** A raw `fetch()` crash (DNS/reset/classifier network errors)
  killed the live probe with exit 1, which the workflow reported as
  "markup changed — parsers need updating" even though zero anchors had
  been probed. Rejected fetches are now recorded as failed pages and the
  verdict logic emits its existing honest `fetch-fail` (exit 2) state.
  This was the root cause of issue #6 (false alarm — the 9/19 committed
  status was `ok 0/59`, and awwwards.com fetches fine).
- **Dependency alerts cleared**: vitest + @vitest/mocker bumped to 4.1.11
  (dev-only; full suite 251/251 green on vitest 4). Supersedes the two
  Dependabot PRs, which were merged into one local commit.
- **CI updated** to `actions/checkout@v5` / `actions/setup-node@v5` in all
  three workflows (fixes the Node 20 deprecation annotation).
- Removed the stale `elements-motion-dna` worktree (fully merged).

## v1.7.1 — 2026-09-29

Daily environment self-check + corrected optional-dependency install hints.

- **Daily env check**: at server startup (once per day, stderr-only, never
  blocks serving) the server probes playwright with a real chromium launch
  and resolves ffmpeg-static from its own install location. When captures
  or motion recordings later fail, the cause was warned about up to a day
  earlier — and the fix hint prints once, not on every failed capture.
- **Corrected install hints**: capture/motion hints now say
  `npm install -g playwright && npx playwright install chromium` /
  `npm install -g ffmpeg-static` — the server resolves optional deps from
  its own install location, so a `-D` install in whichever project the
  agent happens to sit in does not fix a globally-installed server.
- Failure-tolerant by design: a flaky probe (first-run policy, AV scan)
  records nothing, so the next start re-checks; every failure is swallowed
  and stdout is never touched.

## v1.7.0 — 2026-09-28

> First stable-minor release. npm versions 1.1.0–1.6.0 were the retired
> alpha line, so the stable line jumps to 1.7.0 — semver forbids reusing a
> published version number.

Winner feed (`new_winners` + `watch_site`), `awwwards-setup` skill, repo
renamed to the correct spelling.

- **`new_winners`** polls today's freshly-crowned winners (SOTD /
  Developer Award / Honorable Mention) against a persisted UTC-day
  baseline: the first call seeds silently and dumps the listing; later
  calls report only the delta. Each first-seen winner's site page is
  fetched once and its Elements section is backfilled into the searchable
  element corpus as `source:"site"` records (slugs namespaced
  `site-<siteslug>-<title>` so they never collide with gallery records) —
  new winners are element-searchable immediately, no gallery indexing
  needed. Per-winner fetch failures never abort the loop.
- **`watch_site`** adds persistent watches (studio / tag / url, optional
  `award` + `note`). `list` matches each watch against the freshest cached
  listing and reports per-watch `NEW since last check` deltas; it never
  fetches — `new_winners` / `search_sites` keep the pool fresh. First
  `list` seeds the baseline silently; url watches take the site slug;
  studio matching is a case-insensitive substring.
- **New skill `awwwards-setup`** — first-invocation onboarding: wires the
  MCP server when it isn't connected yet (Claude Code, Codex, OpenCode,
  mcpServers-standard clients, pi), asks the user's preferences once
  (result density full/compact, default viewport, live-capture opt-in
  with playwright install, local-index opt-in, winner watches to register)
  and persists them to `~/.awwwards-mcp/preferences.json`. Later runs
  apply silently and only ask about missing fields. Shipped in the npm
  package; `awwwards-inspiration` hands off to it on first run.
- **Docs**: README documents both new tools and the two-source element
  corpus; `awwwards-inspiration` gains the tool-table rows, a "staying
  current" section, and the first-run setup handoff.
- **Repo renamed** `Awwards-mcp` → `Awwwards-mcp` (three w's, matching the
  npm package and awwwards.com). Old GitHub links redirect automatically;
  `package.json` and issue-template URLs updated.

## v1.0.1 — 2026-09-28

Element↔site pairing (Task 5), element category taxonomy, elements-index docs.

- **Pairing**: gallery elements now link to their owning site. Item-page
  attribution anchors (`/sites/<slug>`) are parsed into a new
  `elements.siteSlug` column (lazy ALTER TABLE migration — existing caches
  upgrade in place). At read time, rows crawled before this change fall back
  to an exact author→site-title match, filled only when the title is unique
  across the sites index (wrong pairing is worse than none). `search_elements`
  and `get_element` payloads carry `siteSlug` + `siteUrl`; the next elements
  re-index stamps `siteSlug` authoritatively.
- **Taxonomy**: `search_elements`'s `category` filter works for real. A
  taxonomy pass (opt-in, any `--elements` crawl beyond page 1) fetches each
  facet page (`/elements/footer/`, `/elements/cta/`, … 46 categories) once
  and stamps every element under it with that category id — element pages
  carry no breadcrumb, so the listing side is the only category source. The
  1-page bootstrap auto-index stays cheap; dead facet pages are skipped;
  a frozen 46-category list covers facet-nav drift. Elements seen on no
  facet page stay `unsorted`. Completes the "Task 5 fills the taxonomy" stub.
- **Docs**: README documents the optional full elements index
  (`--elements all|N`), slug-FTS search, the 7-day freshness gate, and the
  taxonomy pass.

## v1.0.0 — 2026-09-19

First **stable** release. Supersedes the alpha 1.x line and the beta — the
complete feature set: 6 tools, local index, three skills (including the
self-improving skill-memory flywheel), self-heal doctor, parser-drift
monitor, dual-viewport capture, FTS5 search. Ships with the layered-analysis
+ superprompt hand-off upgrade to the motion-study skill.

## v1.0.0-beta.1 — 2026-09-19

First **beta**. Supersedes the alpha 1.x line — the full v1.6.0 feature set
(6 tools, local index, three skills incl. the self-improving memory flywheel,
self-heal doctor, drift monitor, dual-viewport capture) now carries a beta
label while it takes public hardening. Alphas remain on the registry for
reproducibility.

## v1.6.0 — 2026-09-19

Skill-memory flywheel (reviewed and approved for ship):

- `scripts/skill-memory.mjs` (record/recall/distill/stats): the skills
  self-improve from what their verification loops catch. Findings journal
  (episodic, per-machine) + deterministic distiller folding rules seen 2+
  times into installed skill copies (machine-managed section, LRU-capped).
- `promote` + `sync` commands: promote prints folded rules cleaned for the
  shipped-copy PR (machine-local evidence paths stripped); sync copies repo
  skill updates into installed copies WITHOUT wiping learned rules.
- `skills/_memory/techniques.json`: techniques registry seeded from
  researched video-understanding, motion-detection, UI-structure,
  micro-interaction and image-analysis methods; grows via the flywheel.
## v1.4.0 — 2026-09-19

Search intelligence (FTS5 — no new dependencies):

- Porter-stem + prefix matching with BM25 ranking: "magazines" now finds
  Magazine-tagged sites (68 on the live index), best matches first — the old
  substring path returned zero. "edito" finds "editorial"; multi-word queries
  keep AND semantics (every token must hit the same site).
- Zero-result queries gain loose OR-matched hints alongside the taxonomy
  suggestions. Live top-up merge and client-side filters unchanged.

## v1.3.0 — 2026-09-19

Mobile viewports:

- `capture_live_site`, `analyze_page_structure` and `record_site_motion`
  accept `viewport: "desktop" | "mobile"` (mobile = 390×844 @3x with
  isMobile + hasTouch; desktop 1440×900 default, byte-identical).
- Motion recordings render at the selected viewport — no more pillarboxed
  mobile filmstrips.

## v1.2.0 — 2026-09-19

Adoption kit:

- **Demo GIF** at the top of the README — real tool output (search results,
  design DNA, a motion filmstrip of our own build, a band map), generated by
  `scripts/make-demo.mjs`.
- **Release automation**: pushing a `v*` tag now gates on the CHANGELOG
  section + npm-absence, runs typecheck/tests/build, publishes to npm with
  `NPM_TOKEN`, and creates the GitHub Release from the CHANGELOG section.
- **Package metadata**: keywords, repository, bugs, homepage for registry
  discovery.

## v1.1.0 — 2026-09-18

Self-repair + observability release (all shipped in repo 2026-09-18):

- **Parser-drift monitor**: `npm run drift` probes every markup anchor the
  parsers depend on (hybrid pinned + date-sampled detail URLs, section-scoped
  element anchors); daily GitHub Action opens/updates a tracking issue and
  commits probe state for was-ok→DRIFT diffs.
- **Doctor**: `npm run doctor [-- --fix]` diagnoses network blocks, parser
  drift, playwright/ffmpeg deps, corrupt/stale SQLite cache, and server boot —
  and applies the mechanical fixes.
- **Update notification**: once-daily npm registry check at startup with a
  stderr notice on older versions; `AWWWARDS_AUTO_UPDATE=1` opts into
  background self-update.
- **New skills**: `awwwards-doctor` (repair) and `awwwards-motion-study`
  (capture → review → build), alongside `awwwards-inspiration`.
- **Fix**: `parseElements` re-anchored after live awwwards.com element-blob
  markup change (broke `get_site_elements` on 2026-09-18); new offline
  fixture covers the broken shape.

## v1.0.0 — 2026-09-18

First public release: search_sites / get_site_details / get_site_elements /
list_categories / capture_live_site / analyze_page_structure /
record_site_motion, local index (`awwwards-index`), awwwards-inspiration skill.
