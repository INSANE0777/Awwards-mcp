# awwwards-mcp — project & architecture guide

Developer-facing guide to this repository. The [main README](README.md) covers
installation and user-facing features; this file explains how the codebase is
structured, how the data flows, and how to work on it without breaking it.

## What this is

A free, open-source MCP server that gives AI agents design inspiration from
[Awwwards](https://www.awwwards.com/). No API key, no account: it politely
scrapes public pages (1 request/second, robots.txt-compliant paths), caches
them in local SQLite, and serves them through 41 MCP tools — screenshots,
design DNA, band maps and motion recordings included.

```
                    ┌─────────────────────────────────────────────┐
 awwwards.com ─────►│ src/awwwards.ts  HTTP client (1 req/s,      │
                    │                  BlockedError on 403/429)   │
                    └───────────────┬─────────────────────────────┘
                                    │ HTML
                    ┌───────────────▼───────────────┐
                    │ src/parsers.ts  regex parsers │
                    │  parseListing / parseDetail / │
                    │  parseJuryDimensions /        │
                    │  parseCategories / parseElements
                    └───────────────┬───────────────┘
                                    │ rows
        ┌───────────────────────────▼───────────────────────────┐
        │ src/cache.ts  SQLite (node:sqlite) at ~/.awwwards-mcp │
        │  sites table + FTS5 (probe-guarded, derived) + asset  │
        │  image cache (sha1 of CDN path, no TTL)               │
        └───────────────────────────┬───────────────────────────┘
                                    │
        ┌───────────────────────────▼───────────────────────────┐
        │ src/server/  41 MCP tools over createHandlers(deps)   │
        └───────────────────────────┬───────────────────────────┘
                                    │
                    src/cli.ts ── serveStdio entry (awwwards-mcp)
                    src/index-cli.ts ── crawl CLI (awwwards-index)
```

`awwwards-verify` (`src/verify-cli.ts` → `dist/verify-cli.js`): verify_build as a
CLI — `awwwards-verify <buildUrl> <referenceUrl> [--viewport desktop|mobile]`
prints one JSON verdict line (exit 0 pass / 1 warn / 2 fail / 3 error / 4 usage).
Note: it spawns a real browser.

**Install layout.** Bins are thin wrappers (`src/cli-entry.ts` decides whether
they are the entry). Browser features import `playwright` / `ffmpeg-static` as
bare optional deps and resolve them from the package's own install location.
The supported browser-enabled layout is a global side-by-side install
(`npm install -g awwwards-mcp playwright ffmpeg-static`, MCP command
`awwwards-mcp`); `npx -y awwwards-mcp` is core-tools-only because its cache has
no sibling packages. `scripts/pack-smoke.mjs` installs the packed tarball into a
throwaway global prefix to prove the installed-bin aliases and that layout,
including a synthetic side-by-side `playwright` / `ffmpeg-static` import.

## Module map (`src/`)

| Module | Lines | Role |
|---|---|---|
| `awwwards.ts` | ~134 | HTTP client. `BASE_URL` / `ASSETS_URL`, `AWARD_FILTERS`, `buildFilterUrl`, `RateLimiter` (promise-chained), `AwwwardsClient` with one retry on transient failures — **never** retries 403/429 (throws `BlockedError`). All binary CDN assets flow through one `getAsset` path. |
| `parsers.ts` | ~250 | Dependency-free regex parsers. See [parsers & drift](#parsers--drift-the-safety-net) below. |
| `cache.ts` | ~262 | SQLite storage. FTS5 layer is **derived and probe-guarded**: if the Node build lacks FTS5, `searchSites` returns null and callers fall back to substring search. Per-operation DB open/close (an open handle makes cache files undeletable on Windows). Batched-transaction upserts (per-insert autocommit pays ~4 ms disk sync on Windows). Opt-in `AWWWARDS_MCP_IMAGE_RETENTION_DAYS=N` (legacy `AWARDS_MCP_*` accepted) prunes `images/` files older than N days once at construction (best-effort, default off). |
| `annual.ts` | ~650 | Official Awwwards Annual Awards API client (JSON:API): categories plus per-nominee hydration through the shared 1 req/s limiter and house UA/retry/`BlockedError` semantics. Caches under `meta` keys `annual:categories` / `annual:nominee:<kind>:<id>` (7-day TTL), serves stale cache with an explicit `stale: true` on request failure, stops all further requests on a block, clamps list hydration to 10 default / 20 max, and resolves a UUID or full `/api/annual/nominees/...` path. Additive — daily listings keep their scrape path; media is never downloaded. |
| `collections.ts` | ~400 | Awwwards collections. Parses the `/collections/` index (HTML-escaped `data-model` blobs, curated + member hrefs, `owner`/`ref` round-trip fields, `?page=N`) and collection pages via `parseListing`. Pages carry both site and element cards: live brutalism page 1 has 10 site cards of 83 collectable items, talks has 19 element items and zero site cards (returned as empty `sites`, not drift). Curated pages live at `/awwwards/collections/<slug>/`; member pages at `/<owner>/collections/<slug>/` — the short `/collections/<slug>/` form 404s. Cache keys `collections:list:v2:<page>` / `collections:item:<owner>/<slug>:<page>` (7-day TTL, stale fallback). |
| `directory.ts` | ~490 | Awwwards directory. Parses ordinary `card-directory` cards (the `card-directory-sp` promo grid is skipped), path filters (`/directory/<country|category|budget>/`, verified live 2026-10-25), pagination and HM/SOTD/SOTM/SOTY counts. Country names are validated against the 82-name canonical sidebar list (case-sensitive: the lowercase path returns 200 with wrong-country cards). One path filter per request — results carry machine-readable `applied`/`ignored` arrays; `query` filters client-side because `/directory/search/?` is robots-disallowed. Explicit email/phone stripping (separator-aware) before output. Cache key `directory:<filter>:<page>` (7-day TTL, stale fallback). |
| `indexer.ts` | ~153 | `runIndexer`: meta-keyed lock (`index:lock`, 30 min stale), incremental crawl via `index:progress`, abort-safe status writes. `isIndexStale` gates the 7-day background re-index. |
| `index-stats.ts` | ~240 | `getIndexStats`: SQL aggregates over the local cache only (zero network). All-time: sites, elements and site-tag technology frequency (`items[].tag`). Windowed (`windowDays`, default 90): `detail:%` meta rows (≤500 most recently fetched, `detailParseCap`) for palettes/scores, plus Motion DNA rows. Windowed metrics repeat `detailsCached`/`windowDays`/`detailParseCap` coverage; all-time metrics carry only `sitesTotal`. Every metric is labelled `locally cached subset`; aggregates only, no slugs or titles. Reads through `Cache.withReadDb`. Powers `get_index_stats`. |
| `server.ts` | ~5 | Thin facade: re-exports the public types and `createHandlers` so existing `src/server.js` imports keep working. |
| `server/types.ts` | ~556 | Public types (`Handlers`, `CreateHandlersDeps`, capture Fns), `text`/`errorResponse`, the `compact*` token diets and slug/tokenize/suggest helpers. |
| `server/context.ts` | ~250 | `HandlerContext` / `createHandlerContext`: client + cache + deps + clock plus the shared private helpers (`matchesFilters`, `loadDetail(s)`, `siteImage`, `compactContent`, `orderByScore`). |
| `server/handlers/*.ts` | ~1700 | Domain handler modules — `awards` (search/detail/brief/elements/categories), `data` (index/annual/collections/directory/monitoring), `capture` (screenshots/structure/hover/component/pose/scene/tokens/images), `motion` (record/DNA/scroll census), `audit` (audit/a11y/bundle/HAR/verify), `build` (project/stubs/manifest/stack). |
| `server/create-handlers.ts` | ~95 | Composes the 41-method `Handlers` object from the domain modules over one context. |
| `tools/shared.ts` | ~30 | `ToolContext`, `asMcpResult` and the shared wait-strategy / viewport zod schemas. |
| `tools/{awards,capture,audit,build,scene}.ts` | ~800 | The 41 `tool()` / `registerTool()` registrations, annotations and schemas, grouped by domain. |
| `tools/index.ts` | ~87 | `registerAllTools`: calls the per-tool registrars in the historical registration order. |
| `motion.ts` | ~429 | `recordSiteMotion`: webm recording + ffmpeg filmstrip under a strict 30 s budget (documented timing table at the top of the file). Virtual SVG cursor, per-call `mkdtemp` isolation, 10-min stale-tmp sweep, 60 s ffmpeg deadline. |
| `motion-sheet.ts` | ~375 | `buildMotionSheet`: Motion Evidence Sheet from a recording + timeline — keyframes at phase-kind transitions (≤9), pairwise difference masks, onion composite, `motion-sheet.md` + static `sheet.html` with a pure-CSS timeline strip. All ffmpeg injectable; throws so the caller can degrade to the filmstrip. Wired via `recordSiteMotion`'s injectable `sheetFn`. |
| `structure.ts` | ~886 | Band map. `SCAN_SNIPPET` runs in-page via `page.evaluate` (self-contained, reaches DOM through `globalThis` — the Node tsconfig has no DOM lib). Detects the real scroll root when `body` is pinned and an inner element (`overflow-y: auto/scroll`, `scrollHeight > clientHeight+100`, largest visible) actually scrolls; reports it as `scrollRoot` and measures candidates, landmarks and responsive y's in scroller coordinates (`coordinateY`: rect top − scroller top + scrollTop). `collapseBands` is pure: 8 px sweep, smallest-covering candidate wins, sliver absorb, max-40 cap. `diffBands` is the pure label-matched desktop→mobile diff behind `compare:"mobile"` (`heightDelta`, added/removed/reordered). Owns the ONE `preScroll` shared with capture; it returns `{ scrollRoot, scrollHeight, clientHeight }`, scrolls the detected container (else window) and resets it, with both walks capped at 80 × 450px steps / 8 s (growing `scrollHeight` cannot stall it). `analyzePageStructure` also has an attach path (`cdpEndpoint`, gated by `AWWWARDS_MCP_ATTACH=1`) that scans an already-open page without goto/preScroll, installing the one-shot `__name` shim for tsx runs. |
| `browser.ts` | ~180 | Loopback CDP attach (design §4.4), never navigates, scrolls, clicks or creates tabs: `validateCdpEndpoint` accepts only `http://127.0.0.1:<port>` / `http://[::1]:<port>` and `ws://…/devtools/browser/<id>`; an http endpoint is resolved via `/json/version` (5 s timeout) and the returned `webSocketDebuggerUrl` is re-validated as loopback ws before Playwright sees it; `attachPage` returns the existing page whose normalized href matches exactly (no launch, goto or new page; no-match errors list origins only); `closeAttached` disconnects without closing pages. |
| `capture.ts` | ~270 | Full-page screenshot. Intentionally circular import with `structure.ts` (call-time-only bindings; ESM resolves it). `CaptureOpts.inline: false` omits the base64 preview; previews over `maxInlineBytes` (default 2.5 MB) are detected from the raw buffer (`4*ceil(n/3)`) and saved with `inlineOmitted: true` instead. After `preScroll`, `waitForOverlays` polls `OVERLAY_SNIPPET` every 250 ms (10 s cap, timeout swallowed) and applies the pure `isBlockingOverlay` (fixed, ≥90% viewport both axes, z-index ≥100, opacity >0.05, visible) — preloaders otherwise fill the screenshot; `waitForOverlay: false` skips it, and pages without `evaluate` are treated as overlay-free. When `preScroll` reports a `scrollRoot`, it re-queries exactly one match and returns the `CaptureResult` union: `mode:"anchors"` (six ordered viewport screenshots at `round(i*(scrollHeight-clientHeight)/5)`, JSON paths only; the walk pins inline `scroll-behavior:auto` on the scroller — restored in `finally` — polls each jump until `scrollTop` reaches the target (1.5 s cap) before the shot, and reports each anchor's observed `scrollTop` — the last observed position on timeout, never the requested target), `mode:"viewport"` for one explicit viewport shot, or `{error}` on 0/>1 matches. Document-scroller payload is unchanged. |
| `a11y.ts` | ~640 | Evidence-only accessibility census. `A11Y_SNIPPET` (function declarations + `globalThis`, no arrows, re-serializable) samples ≤200 visible text nodes with computed colour + the element-first background stack (backgroundColor + computed opacity per ancestor, ≤20 layers), images (≤300), heading ladder, focusables + stylesheet `outline:none` rules (≤5000 rules, cross-origin sheets counted blocked), unlabeled controls (≤200) and lang/title. `reduceA11y` is pure: samples under any ancestor opacity group (<0.999) are skipped and counted in `coverage.skippedOpacityGroups` — never approximated, because opacity applies to text as well as backgrounds. Fully opaque chains composite bottom-up over the white canvas (`compositeBackground`/`contrastRatioOverLayers`/`contrastRatio` exported; `hasOpacityGroup` rejects opacity groups) before computing WCAG ratios; background images, gradients and pseudo-elements are not modelled, so contrast stays heuristic there. `analyzeAccessibility` accepts http(s) only, uses the lazy playwright loader (45 s goto + 3 s settle, desktop 1440×900 profile by default (mobile 390×844 with viewport: "mobile")) and always stamps `heuristic: true` + "Evidence only — not a WCAG pass/fail". Powers `analyze_accessibility`. |
| `census.ts` | ~407 | per-element scroll/SVG motion census (snippet + reducer + capture); powers `analyze_scroll_map`. |
| `motion-manifest.ts` | ~500 | Motion manifest core: `normalizeScrollCensus` validates/normalizes an `analyze_scroll_map` payload (bounded rows, skipped-row warnings, accepts a `{scrollCensus}` dump) and `buildMotionManifest` attributes census triggers to split sections by unique id/class tokens (structural `section:nth-of-type` fallback, page-level when ambiguous). `scaffoldMotionManifest` is the pure `build_motion_manifest` tool core: bands (+ optional section overrides) become tag/id/class-only skeleton sections — no markup, so DOM initial-state hints are empty — and returns `{manifest, measured:false, note}` or `{error}`, never throws. |
| `hover-census.ts` | ~391 | :hover rule extraction + computed-style diff sampling; powers `analyze_hover_census`. |
| `bundle-forensics.ts` | ~310 | Bundle forensics: bounded chunk fetch (`<script src>` + inline `<script>` + modulepreload/preload-as-script hints; ≤40 chunks, 10MB, 1 req/s rate limit, 15 s AbortController timeout on page + chunk fetches), save + sha1 hash, keyword grep, optional lazy webcrack unpack (per-chunk degrade); powers `analyze_bundle`. The opt-in import graph is a one-pass statement scanner (declarations up to 8 KB, `;`/quotes/parens end a pending declaration) instead of lazy cross-statement regexes, so long binding lists resolve and adversarial bundles cannot backtrack. |
| `verify-build.ts` | ~720 | Motion fingerprint + band-map compare + verdict; powers `verify_build`. The aegon-port build-side evidence pass fetches the build page's raw HTML once (polite UA, 15 s abort) and appends two trailing evidence lines — `perf: fps=… dropped=… longTasks=… thrash=… (measured)` (6 s live measurement via `perf-live.ts`) and `anti-patterns: <n> (worst: <rule>)` (`scanAntiPatterns` on `{html}`). Evidence only: any failure degrades to one line and never gates score or verdict; DI knobs `perfFn`/`rulesFn`/`fetchFn` keep offline tests Chrome-free. When `scene3d` is requested it forwards the pack id, build selector and tolerances to `scene-verify.ts` after the legacy score is final; a gate error becomes an inconclusive `scene3d` block and never changes `overall`/`verdict`. |
| `perf-live.ts` | ~500 | Aegon port (MIT, `A:\Motion` `src/cdp.ts` + `src/live.ts`, merged). Raw-CDP runtime measurement through an installed headless Chrome/Edge — zero deps, no playwright. `measureRuntime(url, {seconds?, viewport?})` registers the collector at document-start (frame sampling, long tasks / long animation frames, measured layout thrashing) and returns `PerfMeasurement | { error }` — nothing throws, the spawned browser always cleans up. DI: `spawnFn`/`fetchFn`/`connectFn`/`findBrowserFn`; `AEGON_BROWSER` env override. |
| `audit-rules.ts` | ~350 | Aegon port (MIT, `A:\Motion` `src/rules.ts` + the scan core of `src/audit.ts`). Pure synchronous anti-pattern scanner: `scanAntiPatterns({ css?, html?, js? })` → `AntiPatternFinding[]` (`ruleId`, `severity`/`tier`, `source`, `line`; `SEVERITY_WEIGHTS` exported). Aegon's rule table verbatim (blur-heavy, scroll-nonpassive, will-change-overuse, …) plus animated-property tier findings (S/A/B/C/D/F); never throws, deterministic order. |
| `audit-url.ts` | ~330 | `auditUrl`: composes `measureRuntime` (installed Chrome/Edge, viewport-aware, no dep) with `scanAntiPatterns` over the page HTML + ≤8 same-origin CSS/JS assets (≤2MB per body via a streamed byte cap, one shared 1 req/s limiter, 10 s default per-request timeout). Asset refs resolve against the final post-redirect page URL; an asset redirect leaving that origin is rejected and counted failed. Runtime and static acquisition run in parallel and degrade independently (`perf: { error }`, `antiPatterns.error` + note); findings are severity-sorted before the 50 cap, so `worst` is always present. Evidence only. Powers `audit_url`. |
| `component.ts` | ~540 | component capture: bounded DOM walk (snippet + pure reducer) serializing one component's structure, 45 computed-style props, fonts/colors and element animations into `component-pack-v1`; pure `summarizeTypography` (top 12 families/sizes/weights/line-heights/letter-spacings + sampled nodes) and `summarizePalette` (node colours + pack colours, junk filtered, top 24) feed the full response. `compact: true` keeps only `{tag, classes, rect}` per node + top-level fonts/colors (styles, text, svg, pseudos and anims are dropped; summaries omitted). Powers `capture_component`. |
| `tokens.ts` | ~420 | Pure token reducer for `export_design_tokens`: walks a `component-pack-v1` root without mutating it, derives colors/typography/spacing/radii/shadows/borders only from captured keys, rejects junk colours, and reads colours only from `color`/`backgroundColor` — the composite `background` shorthand is ignored, so any `url(...)` inside it never reaches the output. Ranks by count then code point (never `localeCompare`), caps each category, and emits ordinal CSS variables plus a Tailwind theme map. Deterministic (no timestamps); a category cap or node truncation sets `truncated` + `notes`. |
| `images.ts` | ~350 | Image-delivery census for `analyze_images`: in-page `IMAGE_SCAN_SNIPPET` (self-contained, caps 500 rows) reads `document.images` after the shared `preScroll`, reducing data URIs in `currentSrc`/`src` to `data:<mime>` and clipping `srcset`/`sizes` at 200 chars (presence evidence only). Pure `summarizeImages` aggregates the scanned rows (loaded/notLoaded/broken disjoint, zero-rect excluded), strips query/hash and URL userinfo (data URI → `data:<mime>`), applies the presentational-alt policy and issue precedence, and caps 20 samples. The page loads its own assets — no tool-initiated fetches. |
| `pose3d.ts` | ~261 | Pose capture core. `POSE_SNIPPET` mirrors the census/structure in-page snippets (self-contained, `globalThis`, every probe try/caught); `reducePose` is pure; `capturePose3d` orchestrates step capture and stamps the `pose-grid-v1` grid. Powers `capture_pose_3d`. |
| `pose-stub.ts` | ~190 | Pure + synchronous `buildPoseStubHtml`: renders a PoseGrid as a standalone scroll-scrubbed three.js stub page (frames inline, synthesized camera path interpolated between snapshot scroll ratios — guidance, not recovered camera data; calls `renderer.render` after texture load, camera updates and resize; reduced-motion static frame; disposes on pagehide; no eval, no `Date.now` - byte-identical output for identical grids). Powers `build_pose_stub`. |
| `scene-capture.ts` | ~3,690 | Scene evidence (`scene-evidence-v1`), passive by default: DNS/private-IP gate plus a loopback HTTP proxy set on the browser before any page exists, so every connection (redirect hops and popups included) is validated and dialed at the resolved address; Playwright routing is defense in depth only; service workers blocked; largest-visible or selector canvas pick (stamped attribute, no `getContext`); checkpoint loop records scroll/canvas/DPR/pointer and writes PNG frames + `evidence.json` under `<cache>/scene-captures/<captureId>/` (2 MiB metadata, 8 MiB per image, 32 MiB total); each checkpoint also records `stable`/`stabilityReason` from a post-screenshot re-probe, and reference-side WebGL context loss is not detected; ≤200 response resources redacted to origin+pathname, each with an `assetId` and a download status (fetchable URL only for query/hash/credential-free observations, otherwise a skip reason); passive THREE/BABYLON/pc hints; optional adapters (max 2, no duplicates): `three` reads only reachable `window.THREE`, `window.scene`/`camera`/`renderer`/`controls` and `window.app`/`experience`/`viewer`/`world` objects (no heap crawl, hooks or network) into `evidence.three` (`three-adapter-v1`): ≤500 nodes at depth 20, ≤8 cameras, ≤8 lights, ≤32 materials and ≤200 redacted texture refs that can link to an inventory `assetId`, plus controls and coverage; `spector` reads the optional spectorjs 0.9.33 bundle from disk (~1.19 MB), injects it before load (bundle read locally; no UI or worker capture) and captures one WebGL frame into `evidence.spector` (`spector-adapter-v1`) with context attributes, command names/counts/statuses, analyses, ≤8 programs, ≤16 shaders and shader source (untrusted page text, stored as data) capped at 64 Ki characters each / 256 Ki total, never command arguments, results, state, stack traces, memory or the raw capture. A missing package, timeout or error degrades only that adapter (install hint recorded); requested-but-absent leaves capabilities unknown; shaders are available only when at least one shader was captured, and passive capture without an adapter marks scene/camera/controls/shaders/geometry unavailable. Powers `capture_scene_3d` `op:"capture"`. |
| `scene-assets.ts` | ~840 | Selected asset acquisition for one capture: resolves `captureId` inside `scene-captures` (pattern + realpath containment, symlinks refused), reads only that capture's `evidence.json` inventory, requires a rights basis/evidence and writes `provenance.json` with a timestamp. Direct Node http(s) with manual redirects (≤5), per-hop DNS lookup + private/reserved-address gate, connection pinned through the `lookup` option, one request per second process-wide and one at a time, 15s body / 120s overall deadlines, 16 MiB per file / 64 MiB per run, atomic temp-then-rename writes, SHA-256, magic-then-MIME extension validation (unknown types only with `allowUnknown` as `.bin`). No crawling, URL guessing or credentials. Powers `capture_scene_3d` `op:"download_assets"`. |
| `scene-stub.ts` | ~1,290 | Offline scaffold builder (`build_scene_stub`): reads one `scene-evidence-v1` pack (regular file ≤2 MiB, inside `scene-captures` or a pack with top-level `"exported": true`), lstat-only validation of ≤32 local `assetBindings` (observed non-script/shader `resourceId`, non-symlink regular file ≤64 MiB, allowed extension, no traversal or duplicates) and returns a deterministic file list — Vite + Three.js (`package.json` with pinned three 0.160.0/vite, `index.html`, `src/main.js` with resize/reduced-motion/GLTFLoader/textures/pagehide disposal, `scene.json`, provenance README) plus `assetCopies` to `public/assets/<assetId>.<ext>`, `unresolved` and `authoredDefaults`. When `evidence.three` is usable it re-validates the adapter block and reconstructs only Box/Plane/Sphere/Cylinder meshes with captured numeric dimensions (missing/out-of-range dimensions fall back to an authored `1` and are listed), MeshStandard/MeshBasic materials (other types fall back and are listed; multi-material keeps the first) and a validated perspective camera applied from its exact `matrixWorld` (static, no idle orbit); captured controls are never recreated (OrbitControls would decompose the matrix) and are listed in `unresolved`. Unsupported geometry/materials/cameras are listed in `unresolved` rather than guessed. Captured lights are recorded but not applied, the scaffold never reads or executes shader source/`userData`, texture maps bind only to bound local images, and parent transforms are lost because meshes are flattened at the root. `mode` is `reconstructed-subset` with a glb/gltf model or a supported adapter mesh, else `placeholder`. The idle orbit is used only when the pack has no usable adapter scene. Never fetches, installs, writes or executes captured code. |
| `scene-verify.ts` | ~1,080 | Opt-in `verify_build` 3D gate (`scene3d`): resolves the reference pack inside `scene-captures` (pattern + realpath containment, `scene-evidence-v1` id check), validates its viewport/checkpoint geometry and required scroll fields, then replays every checkpoint against the build page in a fresh Chromium behind the same DNS/private-IP gate and loopback proxy. Each checkpoint reuses the reference viewport, canvas backing size/DPR, measured scroll position, pointer and settle wait. Before the shot it requires the build to hold the reference actual position within 2 px and match DPR/backing; after the shot it re-probes and requires the position to stay within 2 px of both the pre-shot position and the reference `actualScrollTop`, and the canvas rect/backing/DPR to be exactly unchanged, with no WebGL context loss at either probe. Reference checkpoints with `stable:false` are rejected with their `stabilityReason`; packs without `stable` remain accepted. Both PNGs are decoded on a blank comparator page to compute `changedPixelFraction` / `meanAbsoluteChannelError` plus a diff PNG; matching decoded dimensions are required and blank frames (≤4 sampled colours) are rejected. Writes `<referenceCaptureId>/verify/<run>/frame-NN-build.png` and `-diff.png` (red changed, dimmed grey unchanged). A verdict needs both `pixelThreshold` and `maxChangedFraction`; every incomparability is a per-checkpoint reason forcing `inconclusive`, never a pass. The 15 s watchdog is armed before pack resolution and covers pack read, DNS, artifact prep, frame reads, Playwright import/loader, launch and comparison. Cleanup closes tracked resources concurrently under one shared 3 s grace, so the result returns within the deadline plus roughly 3 s; hung closes are abandoned (underlying teardown may linger), and late-resolving resources get an unawaited closure attempt. An artifact write failure is surfaced in `limitations` and blocks the verdict; an uncreatable or symlinked verify path aborts the gate. `cameraAngleDeg` stays `null` because the pack carries no comparable camera angle (the three adapter stores one camera pose, not an angle; spector stores none); capture does not detect reference-side context loss. Build URLs must resolve publicly; the exact-origin loopback allowance is an internal test seam, not a tool input. |
| `stack.ts` | ~115 | Marker-based stack fingerprint: `detectFramework` (8-framework table-order precedence), `detectCss` (class-attr-scoped Tailwind density vs Bootstrap markers, arbitration ladder), `collectLibs`, deterministic `buildStack` (`stack-fingerprint-v1`, no timestamps), and `analyzeStack` (one polite fetch, neutral UA, AbortController timeout; never throws — returns `{ error }`). Powers `analyze_stack`. |
| `gsap-stub.ts` | ~230 | Pure + synchronous `buildGsapStub` + `normalizeEase`: one GSAP timeline per scroll-census anim (trigger, `start: "top 80%"`, scrub/pin, `durationMs` → seconds, cubic-bezier → nearest GSAP token via a 20-row bezier table with 1-decimal rounding), optional scroll-driven camera module with anchors synthesized from pose-grid scroll ratios (y=r·2.5, z=12−r·4, gated on `canvasW>0` + ≥2 snapshots; guidance, not recovered camera data), unconditional reduced-motion guard, `<` neutralized for script safety, no `eval`, byte-deterministic, never throws. Powers `build_gsap_stub`. |
| `build-project.ts` | ~660 | build_project core: rebuild-shape section split (top-level roots keyed on the `c-N` class + generic fallback), style buckets (tokens hoisted, class-safe per-section mention match), timeline extraction (quote-aware balanced-paren `.from(` scan so `;`-bearing callbacks never drop a block), vite/astro/next emit dispatch + the `buildProject` orchestration the bin and MCP tool share. Emitters are pure files arrays (byte-deterministic tests); CLI arg model maps exits 0/2/3 in `build-project-cli.ts`. |
| `build-project-cli.ts` / `emit-next.ts` | ~45 / ~410 | Thin `awwwards-build-project` bin: one JSON line, exit 0/2/3, verify-cli's DI + main-guard shape. `emit-next.ts`: kit `jsx.mjs` port (`htmlToJsx`: class→className, for→htmlFor, style string→object with kebab→camel + `!important` strip, svg camelCase tags/attrs, text-brace entity escaping) + the Next App Router tree — `package.json`/`next.config.mjs`/tsconfig, `app/layout.tsx` (metadata + font links), `app/globals.css` (tokens+shared+section buckets), `app/page.tsx` and per-section components with kit-verbatim `useEffect` + `gsap.context` + `ctx.revert()` wiring; gsap dep and imports gated on the source's CDN tags. |
| `cli.ts` | ~65 | Startup only: cache/client/handlers, background auto-reindex, daily version/env checks, then `serveStdio` with a per-connection factory - stdout stays clean for JSON-RPC. |
| `server-instance.ts` | ~45 | `createServer({handlers,version})`: a fresh v2 `McpServer` with the profile-selected surface (default 41, `core` 13, `v2` 15; mapping in `skills/v2-routing.md`). `serveStdio` calls it once per connection; the modern-probe -> legacy fallback discards the first instance and builds a second. |
| `version-check.ts` | ~131 | Daily npm-registry check, stderr-only, 3 s timeout, all failures swallowed. Self-update is opt-in via `AWWWARDS_AUTO_UPDATE=1`. |
| `viewport.ts` | ~20 | Desktop (1440×900) / mobile (390×844, DPR 3, touch) profiles. Width/height go in playwright's `viewport` key; mobile flags spread as sibling context options. |
| `types.ts`, `index-cli.ts` | — | Shared types (`SiteSummary`, `SiteDetails`, `ElementMedia`); thin crawl-CLI entry. |

The `pose3d.ts` / `pose-stub.ts` pair (added with the `capture_pose_3d` /
`build_pose_stub` tools) follows the census module conventions: self-contained
in-page snippet, pure reducer/renderer, injectable loader, DI-fakes-only tests.

## Search semantics (read before touching `src/server/handlers/awards.ts`)

`search_sites` invariants, each pinned by tests in `test/server.test.ts`:

- **One filter per URL.** Combined filter URLs return 404 on awwwards.com, so
  `buildFilterUrl` picks the highest-priority filter (color > award >
  technology > first tag) and the rest are verified client-side by
  `matchesFilters`. `honorUrlSource` skips re-checking the URL filter for
  freshly scraped rows only.
- **FTS skip-query-check.** FTS matches prefix+porter-stem; re-checking the
  query with substring semantics would wrongly drop stem matches
  ("magazines" → Magazine). FTS-sourced rows skip the query check.
- **Scrapes re-run FTS.** After `upsertSites`, both the empty-window and
  partial-top-up paths re-run the query over the full fresh cache, so a row
  that just arrived is judged exactly like a warm row (cold "magazines" finds
  Magazine on the first call). Rows scraped from a **color** or
  **winner-category** page are pinned to that page's slugs: those URL filters
  have no client-checkable marker, so the re-run must not add cached rows from
  other pages. Substring matching remains only the FTS-unavailable fallback.
- **Facets are exact.** Requested tags/technology and stored display tags both
  run through `canonicalFacet` (trim → `slugifyTag` → display-slug alias →
  technology alias) and compare with equality: `react` no longer matches
  `React Native`, while `nextjs` / `Next.js` / `next-js` all resolve to
  `next-js`, and display names meet their URL slugs (`Adobe Illustrator` ↔
  `illustrator`, `SEO` ↔ `seo-1`). `buildFilterUrl` uses the same path.
- **Query tokenization.** Punctuation is a token boundary (`next.js` →
  `next` + `js`); punctuation splits before alias expansion, so `nextjs,` /
  `(nextjs)` resolve to the same tokens.
- **Color is never served from cache.** Site rows carry no colors, so a color
  search always scrapes its filter page.
- **Page-window scrape.** An empty requested window → scrape and serve the
  re-queried fresh cache. A *partially* filled window → best-effort top-up
  scrape, then the same global re-rank (bm25 order preserved). A failed top-up
  keeps the cached page window.
- **Top-up scrapes are best-effort.** A failed fetch must not escape to the
  stale-fallback catch, which would silently discard the cached page window.
- **Never cache an all-empty parse.** `get_site_details` /
  `get_site_elements` treat an all-empty detail as layout drift and leave it
  uncached so the mismatch keeps surfacing. One fetch feeds both caches.
- **Zero results get hints, not live fetches.** Loose-match OR hint (up to 3
  slugs) + taxonomy suggestions computed from cached categories only.
- **Stale fallback.** On live-request failure, serve stale cache — and the
  cache lookup itself is guarded (the store may be the failure source).

## Parsers & drift: the safety net

awwwards.com is a moving target, so the parsers follow strict conventions:

- Every regex / `split` / `indexOf` anchor carries a date-stamped
  verification note ("verified live 2026-09-XX").
- **`parseJuryDimensions` refuses to guess**: if the chartbar labels are not
  exactly Design/Usability/Creativity/Content, it returns undefined instead
  of mapping by position.
- `parseElements`: `null` = no Elements section (legitimate); empty array =
  markup drift (never cached).
- Description: curated `>Description</h2>` section primary (~16 % coverage),
  `og:description` meta fallback (~50 %).
- Elements media paths come in two schemes — modern `element/YYYY/MM/…` and
  2018-era `external/YYYY/MM/…` — both with `_static.jpeg` posters on the CDN.

Three layers guard these anchors:

1. **Fixtures** — real saved awwwards pages in `test/fixtures/` (listing +
   four detail variants, 300–600 KB each). All parser tests are offline.
2. **Drift probe** — `scripts/parser-drift-probe.mjs` (`npm run drift`)
   checks every parser anchor against the live listing and detail pages
   (2 fetches at 1 req/s) and against the committed fixtures
   (`npm run drift -- --fixture`, offline). Writes `.drift/status.json`.
3. **CI** — a daily GitHub Action (`.github/workflows/parser-drift.yml`)
   runs the live probe and opens/updates a single tracking issue on drift
   (auto-closes when green).

When a drift issue lands, the fresh HTML snapshot becomes the new fixture.

## Tests

```bash
npm test        # offline, vitest, fixtures only — no network
npm run smoke   # manual live smoke test (test/live-smoke.ts)
npm run build   # tsc → dist/
```

Run via `npm run build` + `node dist/cli.js`, not tsx: tsx's esbuild
`keepNames` injects `__name` into page.evaluate-serialized snippets, which
throws `ReferenceError` in the page; and always rebuild `dist` after pulling,
or the motion evidence sheet silently degrades to `null`.

Suites: `parsers` (fixtures pin every anchor), `cache` (FTS on/off, TTLs),
`server` (the merge semantics above — the largest suite), `indexer` (lock,
resume, abort), `motion` / `capture` / `structure` (fake playwright +
injectable ffmpeg — nothing launches a browser), `awwwards` (fetch fake),
`version-check`. `vitest.config.ts` raises the timeout to 30 s for the
multi-page indexer crawls.

Dependency injection is the pattern everywhere a hard dependency exists:
`AwwwardsClient.fetchFn`, `Cache` paths + clock, playwright loaders,
`ffmpegFn`. Write new tests against fakes, not networks.

## Resource limits & diagnostics

Read once at startup; `src/tool-profile.ts` owns the registration guard and its
tests import it directly (cli.ts connects to stdio on import). The guard is
called from `server-instance.ts`, once per `serveStdio` factory invocation.

- `AWWWARDS_MCP_PROFILE=core|full|v2` (default `full`) - `core` registers only the
  13 build-loop tools (including `get_annual_categories`); `full` keeps all 41;
  `v2` (beta) registers the 15-tool consolidated surface instead of the 1.x
  list. The profile is read once at startup, so changing it needs a restart.
  The complete 1.x → v2 mapping for all 36 replaced names lives in
  `skills/v2-routing.md`; the skills carry matching profile notes so an agent
  never calls a 1.x name in a v2 session.
- `AWWWARDS_MCP_MAX_RESPONSE_BYTES` (default `32000000`) - text + inline image
  base64 bytes per response; over-budget calls keep `isError` and other result
  fields but replace `content` with a
  `{truncated:true,tool,bytes,limit,note}` JSON block.
- `AWWWARDS_MCP_DEBUG_MEMORY=1` - one JSON line per tool call (duration +
  `process.memoryUsage()`) on stderr; stdout stays JSON-RPC-only.
- `AWWWARDS_MCP_IMAGE_RETENTION_DAYS=N` - prune cached images older than N days
  at `Cache` construction; 0/unset keeps them.
- `AWWWARDS_MCP_IMAGE_MAX_BYTES` (default `26214400`, 25 MB) - cap for one CDN
  image/asset download; a declared or streamed oversize body is aborted and
  never fully buffered. Cache dirs are created 0700 and the database is 0600
  on POSIX; newly written images use 0600 and atomic rename. Existing cache
  dirs are repaired on open; existing image files are not chmod-repaired.
  Windows ignores the modes.
- Screenshots: 2.5 MB base64 inline budget (`maxInlineBytes` overrides it),
  estimated from the raw buffer (`4*ceil(n/3)`) before conversion;
  `inline:false` omits the preview. Pose and component inline images count
  toward the response budget too.
- HAR: 20 MB cap, checked before and after `readFile`; 2000 entries.
- Bundle edges: import/reexport declarations up to 8 KB each; a longer
  declaration sets `truncated:true` instead of disappearing silently.

The legacy `AWARDS_MCP_*` names (one fewer W, v1.14.0) are accepted as a
one-release fallback; the canonical `AWWWARDS_MCP_*` value wins.

## Scripts & tooling

| Script | Purpose |
|---|---|
| `scripts/doctor.mjs` | `npm run doctor` — checks network, drift, deps, cache, boot; applies fixes. |
| `scripts/parser-drift-probe.mjs` | `npm run drift` — live + fixture anchor probe (see above). |
| `scripts/enrich-styles.mjs` | Phase-1 style-classification experiment via a self-hosted simple-jev classifier (spec: `docs/superpowers/specs/2026-09-20-jev-style-enrichment-design.md`). |
| `scripts/make-demo.mjs` | Builds the README demo assets. |
| `scripts/record-scrollthrough.mjs` | The validated recording script `motion.ts` was ported from. |
| `scripts/pack-smoke.mjs` | `npm run pack:smoke` — packs, installs into a temp global prefix, runs all four bins and the side-by-side browser layout (CI, after build). |
| `scripts/skill-memory.mjs` | Journal → techniques distillation for the skills flywheel (`skills/_memory/techniques.json`). |

## Skills & showcase

- `skills/` ships seven agent skills (`awwwards-inspiration`,
  `awwwards-motion-study`, `awwwards-section-loop`, `awwwards-doctor`,
  `awwwards-setup`, `recreate`, `motion-authoring`). Shipped copies change only
  via human PRs; local copies self-improve through the skill-memory flywheel.
- `showcase/` holds real sites built through the loop (`ridge`,
  `afjal-portfolio`, `fallow-press`, `neutomni`, `nio`, `two26`), each with `_qa/` capture evidence. They
  double as regression demos for the capture/structure/motion tools.

## Conventions worth preserving

These are hard-won; check for them before "simplifying":

- `page.evaluate` snippets are self-contained and reach browser globals via
  `globalThis` (no DOM lib in tsconfig).
- Per-operation SQLite open/close; batched transaction upserts.
- Optional heavy deps (playwright, ffmpeg-static) stay unresolved at compile
  time and resolve lazily at runtime. Capture/structure/a11y/motion/browser
  failures return in-band install hints; component/images/tokens pass the raw
  loader/module error through.
- Bin wrappers use `isCliEntry` (`src/cli-entry.ts`) — realpath plus the
  advertised aliases — because npm runs a bin through an extensionless
  `.bin` symlink. Never go back to a compiled-filename suffix check: it misses
  the alias and exits 0 silently.
- stdout is the MCP JSON-RPC channel — every log/notice goes to stderr.
- New crawler code must keep the politeness contract: `/websites/…` paths
  only, 1 req/s, no query-string pagination (`/tag/`, `/search-websites`,
  `/elements/*` etc. are robots-disallowed and have not been fetched since v1.16.0).

## Contributing

PRs welcome — parser-drift fixes especially (a fresh HTML snapshot attached
to a drift issue is the fastest merged PR). See [CONTRIBUTING.md](CONTRIBUTING.md)
for branch naming, the PR template and the politeness constraints. Security
issues go privately via [SECURITY.md](SECURITY.md).

MIT — see [LICENSE](LICENSE).
