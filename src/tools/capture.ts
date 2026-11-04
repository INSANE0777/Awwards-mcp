import { z } from "zod";
import { asMcpResult, viewportSchema, waitStrategySchema, type ToolContext } from "./shared.js";

export function registerCaptureLiveSite(ctx: ToolContext): void {
  ctx.tool(
    "capture_live_site",
    "Take a fresh full-page screenshot of a live website URL using a headless browser. Requires the optional playwright dependency. Caveat: inner-scroll pages (body pinned, one container scrolls) return mode:\"anchors\" — six ordered viewport screenshots as JSON paths, not one full-page image.",
    {
      url: z.string().url().describe("Absolute URL of the site to capture"),
      waitStrategy: waitStrategySchema,
      viewport: viewportSchema,
      inline: z
        .boolean()
        .optional()
        .describe(
          "false omits the inline base64 preview (file is still saved); previews over the inline budget are omitted automatically",
        ),
      maxInlineBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Byte budget for the inline base64 preview (default 2500000); larger previews are saved without an inline image",
        ),
      waitForOverlay: z
        .boolean()
        .default(true)
        .describe(
          "wait up to 10s after the pre-scroll for a full-screen fixed preloader (≥90% viewport, z-index ≥100) to clear; false captures immediately",
        ),
      scrollCapture: z
        .enum(["auto", "anchors", "viewport"])
        .default("auto")
        .describe(
          'Inner-scroller pages (body pinned, one div scrolls): "auto"/"anchors" saves 6 ordered viewport screenshots down the scroller and returns JSON anchors; "viewport" saves one viewport screenshot. Document-scrolling pages always keep the single full-page capture',
        ),
      publicOnly: z.boolean().optional().describe("Refuse private/loopback/metadata destinations and route every browser connection through the pinned public-address guard"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.capture_live_site(args)),
  );
}

export function registerAnalyzePageStructure(ctx: ToolContext): void {
  ctx.tool(
    "analyze_page_structure",
    "Extract a page's section band map (tag, label, background color, offset, height per band) via a headless browser. Works on live URLs and file:// paths — use it to compare a reference site's structure against your local build. compare:\"mobile\" also captures at 390×844 and returns mobileBands + diff {heightDelta, bandsAdded, bandsRemoved, reordered} plus responsive evidence: horizontal overflow, small text and small tap targets. cdpEndpoint instead attaches to a browser you started (AWWWARDS_MCP_ATTACH=1) and scans the already-open matching page: it never navigates, scrolls, clicks or creates tabs.",
    {
      url: z.string().url().describe("Absolute URL (https:// or file://) of the page to analyze"),
      maxBands: z.number().int().min(5).max(60).default(40).describe("Cap on returned bands"),
      waitStrategy: waitStrategySchema,
      viewport: viewportSchema,
      compare: z
        .enum(["mobile"])
        .optional()
        .describe("Also capture at 390×844 (mobile): adds mobileBands + diff; if the mobile capture fails you still get the desktop result plus mobileError; absent keeps the desktop response unchanged"),
      cdpEndpoint: z
        .string()
        .optional()
        .describe("Attach to a browser YOU started (requires AWWWARDS_MCP_ATTACH=1): loopback CDP endpoint (http://127.0.0.1:9222, http://[::1]:9222, or ws://127.0.0.1:9222/devtools/browser/<id>; an http endpoint is resolved via /json/version and its ws URL re-validated before connecting). Selects an already-open page whose URL matches exactly - never navigates, scrolls, clicks or creates tabs - and disconnects without closing it. Not available with compare or a non-desktop viewport"),
      publicOnly: z.boolean().optional().describe("Refuse private/loopback/metadata destinations and route browser captures through the pinned public-address guard; cannot be combined with cdpEndpoint"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.analyze_page_structure(args)),
  );
}

export function registerAnalyzeScrollMap(ctx: ToolContext): void {
  ctx.tool(
    "analyze_scroll_map",
    "Per-element motion census of a live page: what animates, its CSS properties, duration, delay, easing, and what triggered it (GSAP ScrollTrigger, native CSS scroll()/view() timelines, data attributes, SMIL/SVG). Includes svgStrokes list for stroke draw-in effects. Runs on any URL you give it (builds, references) — does not fetch awwwards.com. Run twice (with reducedMotion) to audit prefers-reduced-motion degradation. Optional scrubProbe drives the page and returns real progress curves per scrubbed trigger. compact=true returns a token-diet summary. Every payload also carries a `choreography` block: stagger hints (hint selector/value/source, groups) distilled from GSAP tween vars and stepped delays across sibling animations.",
    {
      url: z.string().url().describe("Absolute page URL to census"),
      waitStrategy: z.enum(["load", "networkidle"]).optional()
        .describe("'load' plus a settle works on heavy sites; 'networkidle' (default) waits for total quiet"),
      viewport: viewportSchema,
      reducedMotion: z.boolean().default(false)
        .describe("Emulate prefers-reduced-motion: reduce for this capture"),
      scrubProbe: z.boolean().optional()
        .describe("drive the page through up to 8 scroll steps and sample each scrubbed trigger's progress curve (adds seconds)"),
      compact: z.boolean().optional()
        .describe("token-diet summary: keyframes/props/durations and scrubCurves replaced by counts; all numerics and triggers stay. It cannot feed build_gsap_stub/build_motion_manifest (anims[] is omitted) — use compact=false for that handoff"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.analyze_scroll_map(args)),
  );
}

export function registerAnalyzeHoverCensus(ctx: ToolContext): void {
  ctx.tool(
    "analyze_hover_census",
    ":hover interaction census of a live page: counts hover rules, samples up to 20 interactive elements, and reports which CSS properties change on hover with transition duration and easing. Use it to reproduce micro-interactions and verify interaction-state coverage. On mobile the hover loop is skipped and a note is returned. compact=true returns a token-diet summary. Runs on any URL — does not fetch awwwards.com.",
    {
      url: z.string().url().describe("Absolute page URL to census"),
      // Inline optional enum, not waitStrategySchema: that schema's .default("load")
      // would shadow captureHoverCensus's own networkidle default.
      waitStrategy: z.enum(["load", "networkidle"]).optional()
        .describe("'load' plus a settle works on heavy sites; 'networkidle' (default) waits for total quiet"),
      viewport: viewportSchema,
      reducedMotion: z.boolean().default(false)
        .describe("Emulate prefers-reduced-motion: reduce for this capture"),
      compact: z.boolean().optional()
        .describe("token-diet summary: sample style bodies become a selector list + count"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.analyze_hover_census(args)),
  );
}

export function registerCaptureComponent(ctx: ToolContext): void {
  ctx.tool(
    "capture_component",
    "Serialize a page component (structure, computed-style tokens, animations) into a portable pack for rebuild tooling. Adds typography usage summaries (families/sizes/weights/line-heights/letter-spacings, top 12 each + sampled node count) and paletteSummary (colour counts from node styles + pack colors, transparent/rgba(0,0,0,0)/none filtered, top 24). compact=true returns a token-diet summary and omits both. Runs on any URL — does not fetch awwwards.com.",
    {
      url: z.string().url().describe("Absolute page URL whose component to serialize"),
      selector: z
        .string()
        .min(1)
        .optional()
        .describe("CSS selector of the component root (default 'header')"),
      maxNodes: z.number().int().min(50).max(2000).optional()
        .describe("Max DOM nodes to serialize (default 400, clamp 50-2000)"),
      maxDepth: z.number().int().min(0).max(64).optional()
        .describe("Max serialized tree depth (0 = unlimited; omit for unlimited). Values above 12 risk Code Mode's 32-level response cap; 12 keeps a capped pack safe. `depthCapped:true` means deeper nodes were omitted."),
      viewport: viewportSchema,
      compact: z.boolean().optional()
        .describe("token-diet summary: node styles/text/svg/anims and the typography/paletteSummary blocks are dropped; the {tag, classes, rect} tree, fonts and colors stay"),
      publicOnly: z.boolean().optional().describe("Refuse private/loopback/metadata destinations and route the browser through the pinned public-address guard"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.capture_component(args)),
  );
}

export function registerExportDesignTokens(ctx: ToolContext): void {
  ctx.tool(
    "export_design_tokens",
    "Extract a page's design tokens (colors, typography, spacing, radii, shadows, borders) from computed styles and return ordinal CSS custom properties plus a Tailwind theme map. Token names are ordinals (--color-1, --space-1, ...), never semantic guesses. Runs on any URL — does not fetch awwwards.com.",
    {
      url: z.string().url().describe("Absolute page URL to extract tokens from"),
      selector: z
        .string()
        .min(1)
        .optional()
        .describe("CSS selector of the root element to scan (default 'body')"),
      viewport: viewportSchema,
      maxNodes: z.number().int().min(50).max(2000).optional()
        .describe("Max DOM nodes to scan (default 800, clamp 50-2000)"),
      include: z
        .array(z.enum(["colors", "typography", "spacing", "radii", "shadows", "borders"]))
        .optional()
        .describe("Token categories to emit (default all)"),
      publicOnly: z.boolean().optional().describe("Refuse private/loopback/metadata destinations and route the browser through the pinned public-address guard"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.export_design_tokens(args)),
  );
}

export function registerAnalyzeImages(ctx: ToolContext): void {
  ctx.tool(
    "analyze_images",
    "Image-delivery audit of a live page: totals by format, loading strategy, responsiveness and dimensions; flags broken, oversized, tiny and missing-alt images with issue samples. The page loads its own assets (no tool-initiated fetches) after load, a 3s settle, fonts and a pre-scroll that triggers lazy loading. Runs on any URL — does not fetch awwwards.com.",
    {
      url: z.string().url().describe("Absolute page URL to audit"),
      viewport: viewportSchema,
      maxImages: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(200)
        .describe("Max images scanned in document order (default 200, max 500)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.analyze_images(args)),
  );
}

export function registerCapturePose3d(ctx: ToolContext): void {
  ctx.tool(
    "capture_pose_3d",
    "Capture a page's WebGL/canvas pose grid: samples the largest canvas (toDataURL, viewport-screenshot fallback) at up to 10 scroll steps with per-step scroll ratios, for studying scroll-driven canvas motion as frames. Frame evidence only — camera transforms are not recovered. Runs on any URL — does not fetch awwwards.com. Requires the optional playwright dependency.",
    {
      url: z.string().url().describe("Absolute page URL to capture (https:// or file://)"),
      steps: z.number().int().min(3).max(10).optional()
        .describe("Scroll samples across the page (default 6)"),
      viewport: viewportSchema,
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.capture_pose_3d(args)),
  );
}

export function registerRecordSiteMotion(ctx: ToolContext): void {
  ctx.tool(
    "record_site_motion",
    "Record a short motion-through video of a live website - preloader, scroll-triggered and hover/cursor animations - and return an inline filmstrip JPEG plus the .webm path. Requires the optional playwright and ffmpeg-static dependencies. Also writes a Motion Evidence Sheet (keyframes with census-stamped captions, diff masks, cursor-trail overlay, timeline strip) beside the filmstrip. This is not read-only: to expose hover/click motion it can click interactive elements and submit their forms.",
    {
      url: z.string().url().describe("Absolute URL of the site to record"),
      frames: z
        .number()
        .int()
        .min(4)
        .max(36)
        .default(16)
        .describe("Filmstrip tile count (default 16 → a 4x4 grid)"),
      waitStrategy: waitStrategySchema,
      viewport: viewportSchema,
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.record_site_motion(args)),
  );
}
