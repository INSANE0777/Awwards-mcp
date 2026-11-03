# v2 routing — 1.x tool names → `AWWWARDS_MCP_PROFILE=v2`

Use this page when the server runs with `AWWWARDS_MCP_PROFILE=v2`. That profile
registers **15** tools and **none** of the 1.x names mapped below, so every 1.x
call in a skill is a dead tool. Set the variable in the server `env` and
**restart the MCP server** — the profile is read once at startup.

| `AWWWARDS_MCP_PROFILE` | Tools | Surface |
|---|---|---|
| `full` (default) | 41 | Every 1.x tool, unchanged |
| `core` | 13 | Build-loop subset of the 1.x tools; includes `get_annual_categories` |
| `v2` | 15 | 10 consolidated tools + 5 retained flat tools |

The ten consolidated tools are `search_references`, `get_reference`,
`browse_awards`, `get_index`, `inspect_page`, `analyze_motion`,
`capture_page`, `audit_page`, `build_motion` and `monitor_awards`; the five
retained flat tools are `create_design_brief`, `build_project`, `verify_build`,
`verify_flow` and `analyze_network_capture`.

In v2 every consolidated tool takes exactly one `request` object with one
branch (`kind` or `action`). There is no all-mode and no cross-branch mixing:

```json
{ "request": { "kind": "sites", "query": "portfolio", "count": 3 } }
```

## Replaced operations: 1.x → v2

All 36 replaced 1.x names. Fields marked `?` are optional; branch objects are
strict, so do not send fields from another branch.

| 1.x tool | v2 call |
|---|---|
| `search_sites` | `search_references {request:{kind:"sites", query?, color?, tags?, technology?, award?, sortBy?, responseMode?, count?, page?}}` |
| `search_elements` | `search_references {request:{kind:"elements", query?, category?, stack?, limit?}}` |
| `search_directory` | `search_references {request:{kind:"directory", query?, country?, category?, budget?, page?}}` |
| `search_motion` | `search_references {request:{kind:"motion", lib?, scrubOnly?, hasPins?, limit?}}` |
| `get_collections` | `search_references {request:{kind:"collections", page?}}` without a slug; `get_reference {request:{kind:"collection", slug, page?}}` for one collection |
| `get_site_details` | `get_reference {request:{kind:"site_details", slug}}` — or `slugs` for a batch of 1-10 (with optional `compact`) |
| `get_site_elements` | `get_reference {request:{kind:"site_elements", slug}}` |
| `get_element` | `get_reference {request:{kind:"element", id}}` |
| `compare_sites` | `get_reference {request:{kind:"comparison", slugs}}` (2-3 slugs) |
| `get_index_status` | `get_index {request:{kind:"status"}}` |
| `get_index_stats` | `get_index {request:{kind:"stats", windowDays?, top?}}` |
| `list_categories` | `browse_awards {request:{kind:"filters"}}` |
| `get_annual_categories` | `browse_awards {request:{kind:"annual_categories"}}` |
| `get_annual_nominees` | `browse_awards {request:{kind:"annual_nominees", category, limit?, offset?, hydrate?}}` |
| `get_annual_nominee` | `browse_awards {request:{kind:"annual_nominee", id}}` — or `category` + `slug` instead of `id` |
| `analyze_page_structure` | `inspect_page {request:{kind:"structure", url, maxBands?, waitStrategy?, viewport?, compare?, cdpEndpoint?}}` |
| `export_design_tokens` | `inspect_page {request:{kind:"tokens", url, selector?, viewport?, maxNodes?, include?}}` |
| `analyze_stack` | `inspect_page {request:{kind:"stack", url, timeoutMs?}}` |
| `get_motion_dna` | `analyze_motion {request:{kind:"dna", url, recapture?}}` |
| `analyze_scroll_map` | `analyze_motion {request:{kind:"scroll", url, waitStrategy?, viewport?, reducedMotion?, scrubProbe?, compact?}}` |
| `analyze_hover_census` | `analyze_motion {request:{kind:"hover", url, waitStrategy?, viewport?, reducedMotion?, compact?}}` |
| `capture_live_site` | `capture_page {request:{kind:"screenshot", url, waitStrategy?, viewport?, inline?, maxInlineBytes?, waitForOverlay?, scrollCapture?}}` |
| `capture_component` | `capture_page {request:{kind:"component", url, selector?, maxNodes?, viewport?, compact?}}` |
| `capture_pose_3d` | `capture_page {request:{kind:"pose", url, steps?, viewport?}}` |
| `capture_scene_3d` | `capture_page {request:{kind:"scene", op:"capture", url, canvasSelector?, scrollRoot?, viewport?, checkpoints?, assetOrigins?, adapters?, includeViewportShots?}}` (then `op:"download_assets"` for inventory assets) |
| `record_site_motion` | `capture_page {request:{kind:"recording", url, frames?, waitStrategy?, viewport?}}` |
| `audit_url` | `audit_page {request:{kind:"performance", url, viewport?, timeoutMs?, compact?}}` |
| `analyze_accessibility` | `audit_page {request:{kind:"accessibility", url, viewport?, limit?}}` |
| `analyze_images` | `audit_page {request:{kind:"images", url, viewport?, maxImages?}}` |
| `analyze_bundle` | `audit_page {request:{kind:"bundle", url, keywords?, maxChunks?, walkChunks?, edges?, bundleIntel?}}` |
| `build_pose_stub` | `build_motion {request:{kind:"pose_stub", poseGrid, scrollCensus?}}` |
| `build_gsap_stub` | `build_motion {request:{kind:"gsap_stub", scrollCensus, poseGrid?}}` |
| `build_motion_manifest` | `build_motion {request:{kind:"manifest", bands, scrollCensus, sections?}}` |
| `build_scene_stub` | `build_motion {request:{kind:"scene_stub", evidencePath, assetBindings?, title?}}` |
| `new_winners` | `monitor_awards {request:{action:"poll_winners", award?}}` |
| `watch_site` | `monitor_awards {request:{action:"add_watch", kind, pattern, award?, note?}}` for add; `monitor_awards {request:{action:"list_watches"}}` for list; `monitor_awards {request:{action:"remove_watch", kind, pattern}}` for remove |

## Retained flat tools (no `request`)

Five 1.x tools keep their names **and** their flat input shape in v2. Do not
wrap them in `request`:

| Tool | Flat example |
|---|---|
| `create_design_brief` | `create_design_brief { slugs: ["l-i-s-a", "bruno-simon"], goal: "portfolio for a type foundry" }` |
| `build_project` | `build_project { htmlPath: "rebuild/index.html", target: "vite", out: "site" }` |
| `verify_build` | `verify_build { buildUrl: "http://localhost:5173", referenceUrl: "https://example.com" }` |
| `verify_flow` | `verify_flow { buildUrl: "http://localhost:5173", referenceUrl: "https://example.com", steps: [{ action: "scroll", y: 1200 }] }` |
| `analyze_network_capture` | `analyze_network_capture { path: "capture.har", top: 50 }` |

## Exact v2 request examples

Each line below is one `tools/call` payload: `tool` is the registered name
passed as `params.name`, and `arguments` is passed verbatim as
`params.arguments`. The ten consolidated tools take exactly one `request`
branch; the five retained tools stay flat. Every name is asserted against the
real v2 surface and every `arguments` object is parsed by the schema the server
registers (`test/v2-examples.test.ts`). The `build_motion` evidence objects are
abridged: take the pose grid, census and bands verbatim from `capture_page`,
`analyze_motion` and `inspect_page`.

### `search_references` (5 branches)

```json
{ "tool": "search_references", "arguments": { "request": { "kind": "sites" } } }
{ "tool": "search_references", "arguments": { "request": { "kind": "elements", "query": "footer" } } }
{ "tool": "search_references", "arguments": { "request": { "kind": "directory", "country": "United States" } } }
{ "tool": "search_references", "arguments": { "request": { "kind": "motion", "lib": "gsap" } } }
{ "tool": "search_references", "arguments": { "request": { "kind": "collections" } } }
```

### `get_reference` (5 branches)

```json
{ "tool": "get_reference", "arguments": { "request": { "kind": "site_details", "slug": "l-i-s-a" } } }
{ "tool": "get_reference", "arguments": { "request": { "kind": "site_elements", "slug": "l-i-s-a" } } }
{ "tool": "get_reference", "arguments": { "request": { "kind": "element", "id": "site-l-i-s-a-footer" } } }
{ "tool": "get_reference", "arguments": { "request": { "kind": "comparison", "slugs": ["l-i-s-a", "bruno-simon"] } } }
{ "tool": "get_reference", "arguments": { "request": { "kind": "collection", "slug": "brutalism" } } }
```

### `browse_awards` (4 branches)

```json
{ "tool": "browse_awards", "arguments": { "request": { "kind": "filters" } } }
{ "tool": "browse_awards", "arguments": { "request": { "kind": "annual_categories" } } }
{ "tool": "browse_awards", "arguments": { "request": { "kind": "annual_nominees", "category": "site-of-the-year" } } }
{ "tool": "browse_awards", "arguments": { "request": { "kind": "annual_nominee", "id": "00000000-0000-4000-8000-000000000000" } } }
```

### `get_index` (2 branches)

```json
{ "tool": "get_index", "arguments": { "request": { "kind": "status" } } }
{ "tool": "get_index", "arguments": { "request": { "kind": "stats", "windowDays": 30, "top": 5 } } }
```

### `inspect_page` (3 branches)

```json
{ "tool": "inspect_page", "arguments": { "request": { "kind": "structure", "url": "https://example.com" } } }
{ "tool": "inspect_page", "arguments": { "request": { "kind": "tokens", "url": "https://example.com", "selector": "body" } } }
{ "tool": "inspect_page", "arguments": { "request": { "kind": "stack", "url": "https://example.com" } } }
```

### `analyze_motion` (3 branches)

```json
{ "tool": "analyze_motion", "arguments": { "request": { "kind": "dna", "url": "https://example.com" } } }
{ "tool": "analyze_motion", "arguments": { "request": { "kind": "scroll", "url": "https://example.com", "compact": false } } }
{ "tool": "analyze_motion", "arguments": { "request": { "kind": "hover", "url": "https://example.com" } } }
```

### `capture_page` (5 branches)

```json
{ "tool": "capture_page", "arguments": { "request": { "kind": "screenshot", "url": "https://example.com" } } }
{ "tool": "capture_page", "arguments": { "request": { "kind": "component", "url": "https://example.com", "selector": "header" } } }
{ "tool": "capture_page", "arguments": { "request": { "kind": "pose", "url": "https://example.com" } } }
{ "tool": "capture_page", "arguments": { "request": { "kind": "scene", "op": "capture", "url": "https://example.com", "adapters": ["three"] } } }
{ "tool": "capture_page", "arguments": { "request": { "kind": "recording", "url": "https://example.com" } } }
```

### `audit_page` (4 branches)

```json
{ "tool": "audit_page", "arguments": { "request": { "kind": "performance", "url": "https://example.com" } } }
{ "tool": "audit_page", "arguments": { "request": { "kind": "accessibility", "url": "https://example.com" } } }
{ "tool": "audit_page", "arguments": { "request": { "kind": "images", "url": "https://example.com" } } }
{ "tool": "audit_page", "arguments": { "request": { "kind": "bundle", "url": "https://example.com", "keywords": ["gsap"] } } }
```

### `build_motion` (4 branches)

```json
{ "tool": "build_motion", "arguments": { "request": { "kind": "pose_stub", "poseGrid": { "id": "pose-grid-v1", "url": "https://example.com", "capturedAt": 0, "steps": 1, "canvasSelector": "canvas", "canvasW": 1, "canvasH": 1, "snapshots": [{ "step": 0, "scrollY": 0, "scrollRatio": 0, "frames": [{ "label": "canvas", "dataUrlPng": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }] }], "viewport": { "width": 1440, "height": 900 } } } } }
{ "tool": "build_motion", "arguments": { "request": { "kind": "gsap_stub", "scrollCensus": { "anims": [], "gsapTriggers": [] } } } }
{ "tool": "build_motion", "arguments": { "request": { "kind": "manifest", "bands": { "bands": [{ "label": "#hero", "tag": "section" }] }, "scrollCensus": { "anims": [], "gsapTriggers": [] } } } }
{ "tool": "build_motion", "arguments": { "request": { "kind": "scene_stub", "evidencePath": "/path/to/scene-captures/scene-abc/evidence.json", "assetBindings": [] } } }
```

### `monitor_awards` (4 actions)

```json
{ "tool": "monitor_awards", "arguments": { "request": { "action": "poll_winners" } } }
{ "tool": "monitor_awards", "arguments": { "request": { "action": "add_watch", "kind": "studio", "pattern": "lusion", "note": "track new work" } } }
{ "tool": "monitor_awards", "arguments": { "request": { "action": "list_watches" } } }
{ "tool": "monitor_awards", "arguments": { "request": { "action": "remove_watch", "kind": "tag", "pattern": "3d" } } }
```

### Retained flat tools (no `request` wrapper)

```json
{ "tool": "create_design_brief", "arguments": { "slugs": ["l-i-s-a", "bruno-simon"], "goal": "portfolio for a type foundry" } }
{ "tool": "build_project", "arguments": { "htmlPath": "rebuild/index.html", "target": "vite", "out": "site" } }
{ "tool": "verify_build", "arguments": { "buildUrl": "http://localhost:5173", "referenceUrl": "https://example.com" } }
{ "tool": "verify_flow", "arguments": { "buildUrl": "http://localhost:5173", "referenceUrl": "https://example.com", "steps": [{ "action": "scroll", "y": 1200 }] } }
{ "tool": "analyze_network_capture", "arguments": { "path": "capture.har", "top": 50 } }
```

## v2 rules the 1.x workflow didn't need

- **`monitor_awards` is keyed on `action`, not `kind`.** Valid actions are
  `poll_winners`, `add_watch`, `list_watches`, `remove_watch`. On
  `add_watch`/`remove_watch`, `kind` is the watch target
  (`studio | tag | url`) and both `kind` and `pattern` are required.
- **`build_project` output is source, not a servable site.** It scaffolds a
  Vite/Astro/Next project; run `npm install && npm run build`, then serve the
  generated output (Vite/Astro `dist/`, Next `.next` with `next start`). Never
  serve the raw scaffold directory.
- **A compact motion census cannot feed `build_motion`.** `analyze_motion`
  `{kind:"scroll", compact:true}` omits `anims[]` and turns
  keyframes/props/durations/`scrubCurves` into counts, so `build_motion`
  `gsap_stub`/`manifest` reject it. Capture the census with `compact:false`
  (the default) for that handoff.
- **Branch limits worth knowing:** `inspect_page` `tokens` and `stack` require a
  live URL, while `structure` accepts `file://` and `cdpEndpoint`; `capture_page`
  `screenshot` is the only branch with `inline`/`scrollCapture`; `audit_page`
  performance uses Chrome/Edge over CDP, accessibility and images need
  Playwright, and bundle fetches chunks without a browser.
- **`capture_page` `scene` is passive by default, with opt-in three and spector
  adapters.** `op:"capture"` saves checkpoint frames, canvas geometry and a
  redacted response inventory. Without any adapter it does not recover a scene
  graph, camera, controls, shader source or geometry; treat its
  `coverage.capabilities` blocks as authoritative. `op:"download_assets"` fetches
  up to 32 observed `resources[].assetId` values from that capture and is a
  licensing decision: `rights.basis` (`owned | licensed | permission`) and
  `rights.evidence` are mandatory and recorded in `provenance.json`. It never
  crawls, never guesses URLs, never uses credentials, and skips any observed URL
  with a query string, fragment or credentials. Caps: 16 MiB/file, 64 MiB/run,
  5 redirects, 1 request/second, 15s body, 120s overall; unknown types are
  skipped unless `allowUnknown` saves them as `.bin`.
- **`adapters` takes at most two entries, without duplicates.** `["three"]`,
  `["spector"]` and `["three", "spector"]` are valid.
- **`adapters:["three"]` is experimental and reads reachable globals only.**
  After load it reads `window.THREE`, `window.scene`/`camera`/`renderer`/`controls`
  and `window.app`/`experience`/`viewer`/`world` (including those holders'
  scene/camera/renderer/controls fields), with no heap crawl, hooks or network.
  Module-local scenes are invisible, so absence is not evidence of absence. The
  pack gains `evidence.three` (`three-adapter-v1`): ≤500 nodes at depth 20, ≤8
  cameras, ≤8 lights, ≤32 materials, ≤200 redacted texture refs that link to an
  inventory `assetId` when matched, controls and coverage. Coverage follows what
  was observed: a requested adapter that finds nothing leaves capabilities
  unknown, not available.
- **`adapters:["spector"]` captures one WebGL frame with the optional spectorjs
  package.** `spectorjs@0.9.33` is an optional dependency; when installed, its
  local `dist/spector.bundle.js` (~1.19 MB) is injected before load (bundle read
  locally; no UI or worker capture), and one frame is captured. The pack gains
  `evidence.spector` (`spector-adapter-v1`) with WebGL context attributes, command
  total/draw calls/top 30 names/status counts, ≤8 programs, ≤16 shaders and
  shader source (untrusted page text stored as data, never executed) capped at
  64 Ki characters each / 256 Ki total, plus analyses, canvas dimensions, limits
  and truncation flags. No command arguments, results, state, stack traces,
  memory or raw capture are transferred. A missing package records the install
  hint `npm install --save-optional spectorjs@0.9.33`; a timeout or error records
  a reason, and neither fails the scene pack. Shader coverage is `available` only
  when at least one shader was captured; otherwise it is `unknown`.
- **`build_motion` `scene_stub` is a scaffold, not a recovery.** It reads one
  `scene-evidence-v1` pack (regular file ≤2 MiB, inside the server's
  `scene-captures` directory or a pack exported with top-level
  `"exported": true`) and up to 32 `assetBindings` that map an observed
  `resourceId` to a local file you already hold. It returns
  `files[{path,content}]`, `assetCopies[{from,to}]` (→`public/assets/<assetId>.<ext>`),
  `unresolved[]`, `authoredDefaults[]` and `provenance`; `mode` is
  `reconstructed-subset` when a glb/gltf is bound or `evidence.three` yields at
  least one supported adapter mesh, otherwise `placeholder`. Adapter packs
  reconstruct only Box/Plane/Sphere/Cylinder geometry with captured dimensions
  (missing/out-of-range dimensions become authored `1` and are listed),
  MeshStandard/MeshBasic materials (others fall back and are listed, multi-material
  keeps the first) and a validated perspective camera from its exact
  `matrixWorld` (static). Captured controls are never recreated: OrbitControls is
  not wired because its TRS update would decompose a sheared or non-orthogonal
  pose, so any captured controls are listed in `unresolved`. Unsupported
  geometry/materials/cameras are also listed. Captured lights are recorded but
  not applied, shaders and `userData` are never read or executed by the scaffold,
  the idle orbit is used only when the pack has no usable adapter scene, textures
  bind only to bound local images, and meshes are flattened at the root so parent
  transforms are lost.
  It never fetches, installs, copies an asset body or writes a directory: copy
  the `assetCopies` yourself, then `npm install && npm run build`. It never
  executes captured code, shader source, `userData` or callbacks.
- **`verify_build` `scene3d` is a separate gate.** `verify_build` stays flat in
  v2, including `scene3d: {referenceCaptureId, buildSelector, tolerances?}`.
  The id comes from a `capture_page` `{kind:"scene"}` pack; `status`/`verdict`
  live under `scene3d` and never change the legacy `overall`/`verdict`. A
  `within-tolerance`/`outside-tolerance` verdict needs both
  `tolerances.pixelThreshold` and `tolerances.maxChangedFraction`; otherwise the
  gate reports metrics as `inconclusive`. Reference checkpoints must be stable:
  `capture_scene_3d` records `stable`/`stabilityReason` from a post-screenshot
  re-probe, `stable:false` is rejected, and packs without `stable` remain
  accepted; capture cannot detect reference-side context loss. The gate
  re-probes the build after the screenshot and requires the scroll to stay
  within 2 px of both the pre-shot position and the reference `actualScrollTop`,
  plus an unchanged canvas rect/backing/DPR and no context loss. The 15 s
  watchdog starts before pack resolution and covers pack read, DNS, artifact
  prep, frame reads, Playwright import/loader, launch and comparison. Cleanup
  closes tracked resources concurrently under one shared 3 s grace; the result
  returns within the deadline plus roughly 3 s, hung closes are abandoned
  (underlying teardown may linger), and late resources get an unawaited closure
  attempt.
  Build and diff PNGs land under the reference capture's `verify/<run>/`. The
  build URL must resolve to a public host (loopback is refused), so this is not
  a localhost-to-localhost check. `compact:true` keeps `scene3d` whole.
