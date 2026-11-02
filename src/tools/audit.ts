import { z } from "zod";
import { verifyFlowArgsSchema } from "../verify-flow.js";
import { asMcpResult, viewportSchema, type ToolContext } from "./shared.js";

export function registerAuditUrl(ctx: ToolContext): void {
  ctx.tool(
    "audit_url",
    "Audit any live page as evidence, not a grade: runtime frame/long-task/layout-thrash measurement via an installed Chrome/Edge over raw CDP (no playwright), plus static animation anti-patterns scanned over the page HTML and up to 8 same-origin CSS/JS assets (bounded: 8 assets, 2MB each, 1 request/second shared limiter, default 10s timeouts). Asset refs resolve against the final post-redirect page URL; asset redirects leaving that origin are rejected. Findings are severity-sorted before the 50-item cap, so `worst` is always present. `nextActions` ranks the first three fixes. compact=true returns the url, a reduced perf block (fps, droppedFrames, longTasks, layoutThrashing), pre-cap antiPatterns counts (count, worst, high, medium, info), coverage, nextActions and note; omit it for the full findings and full perf. Degrades honestly - perf carries {error} when no browser is available and the static scan reports its own error; neither suppresses the other. Personal, non-commercial use; audit only URLs you are authorised to inspect.",
    {
      url: z.string().url().describe("Absolute http(s) URL of the page to audit"),
      viewport: z
        .enum(["desktop", "mobile"])
        .default("desktop")
        .describe("Runtime measurement geometry: desktop = 1280x800 (aegon baseline); mobile = 390x844"),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(30000)
        .default(10000)
        .describe("Per static request timeout in ms (page HTML + each asset)"),
      compact: z
        .boolean()
        .optional()
        .describe("compact=true returns the url, reduced perf, pre-cap antiPatterns counts, coverage, nextActions and note; omit for full findings and full perf"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.audit_url(args)),
  );
}

export function registerAnalyzeAccessibility(ctx: ToolContext): void {
  ctx.tool(
    "analyze_accessibility",
    "Collect accessibility EVIDENCE from a live page — an evidence census, not a compliance audit. Samples up to `limit` (default 100, max 200) visible text nodes with computed colour and a background composited bottom-up from the ancestor stack (colour alpha layers), then the contrast ratio (worst pairs with selector paths). Samples under any ancestor opacity group (<1) are excluded from ratios and counted in coverage.skippedOpacityGroups, never approximated; background images, gradients and pseudo-elements are not composited either, so contrast stays heuristic there. Also: image alt coverage; heading ladder (skipped levels, multiple h1); focusable/positive-tabindex counts plus outline:none stylesheet rules; unlabeled form controls; document lang/title. Result carries coverage and heuristic:true. http(s) URLs only; requires the optional playwright dependency and degrades to {error}. Personal, non-commercial use.",
    {
      url: z.string().url().describe("Absolute http(s) URL of the page to inspect"),
      viewport: viewportSchema,
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(100)
        .describe("Text-node sample cap (1-200)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.analyze_accessibility(args)),
  );
}

export function registerAnalyzeBundle(ctx: ToolContext): void {
  ctx.tool(
    "analyze_bundle",
    "Bundle forensics for a live page: fetch it once, download its script chunks (script tags, inline scripts, and modulepreload/preload-as-script hints; bounded: ≤40 chunks, 10MB, 1 request/second), save them locally, optionally de-obfuscate with webcrack if installed, and grep keywords across the code. Returns chunk paths + match lines so an agent can read the actual animation mechanism instead of guessing. Opt-in bundleIntel adds route, vendor, source-map presence and module-graph evidence; source maps are detected but never fetched, and default output keys are unchanged. Runs on URLs you are authorized to analyze — does not fetch awwwards.com.",
    {
      url: z.string().url().describe("Absolute page URL whose script chunks to inspect"),
      keywords: z.array(z.string().min(1)).max(20).optional().describe("grep these strings across chunks (e.g. class names, effect names)"),
      maxChunks: z.number().int().min(1).max(100).optional().describe("default 40"),
      walkChunks: z.boolean().optional()
        .describe("after the first pass, follow quoted same-origin .js refs inside fetched chunks and fetch up to 20 newly discovered ones (same budgets; adds seconds)"),
      edges: z.boolean().default(false)
        .describe("static import graph over captured chunks"),
      bundleIntel: z.boolean().default(false)
        .describe("opt-in: quoted routes, vendor signatures, source-map presence (never fetched) and module graph; default output keys unchanged"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.analyze_bundle(args))
  );
}

export function registerAnalyzeNetworkCapture(ctx: ToolContext): void {
  ctx.tool(
    "analyze_network_capture",
    "Offline API-surface evidence from a local HAR 1.2 file (browser devtools export): groups requests by method + origin + path template (ISO dates, versions, UUIDs, hex ids and numbers templated; emails, tokens and long high-entropy segments redacted), with counts, statuses, content types and query names only. Reads the file only — never fetches recorded URLs, never returns bodies, headers or query values. No network.",
    {
      path: z.string().min(1).describe("Local path to a HAR 1.2 file"),
      top: z.number().int().min(1).max(200).optional()
        .describe("Max groups after sorting (default 50, max 200)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (args: any) => asMcpResult(ctx.handlers.analyze_network_capture(args)),
  );
}

export function registerVerifyFlow(ctx: ToolContext): void {
  ctx.registerTool(
    "verify_flow",
    {
      description:
        "Step-aligned comparison of interaction flows: runs the same 1–6 scroll/click/wait steps on a build and a reference page (two fresh headless launches, desktop or mobile), then compares path, scroll delta, skeleton hash, text hash and element count after each step. A step is same only when both sides are complete and untruncated; truncated or failed states are unknown. No screenshots: hashes are evidence, not visual truth. A click can still trigger client-side mutations. Runs on URLs you are authorized to inspect. Use verify_build for a scored structure/motion comparison; build_project converts a local file into a project and never verifies. Needs the optional Playwright dependency.",
      inputSchema: verifyFlowArgsSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args: any) => asMcpResult(ctx.handlers.verify_flow(args)),
  );
}

export function registerVerifyBuild(ctx: ToolContext): void {
  ctx.tool(
    "verify_build",
    "Compare a built site against a reference (an Awwwards winner, a client's old site, any URL): band-structure match + motion fingerprint similarity, with a pass/warn/fail verdict and evidence lines. Band labels are #id.firstClass, so give your rebuild's sections stable ids/classes; anonymous rebuild labels (empty/body, or duplicates) fall back to tag+height matching. compact=true returns the verdict, overall and band scores, band counts (matched, refOnly, buildOnly), motion score and captureStable (false when either capture moved or the two captured different heights/animation counts); omit it for evidence lines. Live reports also carry a capture: evidence line with each side's rendered height, animation count and stability, because fixed waits can sample async content at different moments; a score that moved with capture state is visible there. Closes the design loop: build → verify → fix → re-verify. Reference can be an award site found via search_sites, compared read-only via compare_sites.",
    {
      buildUrl: z.string().url().describe("URL of the build to verify"),
      referenceUrl: z.string().url().describe("URL of the reference site to match"),
      // Inline optional enum, not waitStrategySchema: that schema's .default("load")
      // would shadow the orchestrator's networkidle scroll-census default.
      waitStrategy: z.enum(["load", "networkidle"]).optional()
        .describe("'load' waits for load plus settle; 'networkidle' waits for network quiet; omit to let the orchestrator use its scroll-census default"),
      viewport: viewportSchema,
      domDiff: z.boolean().default(false)
        .describe("body-subtree structural diff between reference and build"),
      compact: z
        .boolean()
        .optional()
        .describe("compact=true returns the verdict, overall and band scores, band counts and motion score; omit for evidence lines"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.verify_build(args)),
  );
}
