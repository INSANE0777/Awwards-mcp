import { z } from "zod";
import { verifyFlowArgsSchema } from "../verify-flow.js";
import { asMcpResult, viewportSchema, waitStrategySchema, type ToolContext } from "../tools/shared.js";

// Retained 1.x tools with v2-native descriptions. Their input contracts and
// handler behaviour are unchanged; only the surrounding routing prose moves to
// the v2 names so a v2 client never sees a dead tool reference.
export function registerCreateDesignBriefV2(ctx: ToolContext): void {
  ctx.tool(
    "create_design_brief",
    "Synthesize a cited design direction from 2-5 Awwwards site slugs plus a project goal. Uses cached detail (including its element list) and Motion DNA evidence first and fetches only missing details; includeStructure=true also runs a browser band analysis per reference. Returns one Markdown text block containing versioned JSON: shared signals vs one-site outliers, evidence gaps, an evidence-backed interaction plan, and reduced-motion/content/keyboard guardrails. Use search_references to find slugs; use get_reference for raw side-by-side DNA and inspect_page for a band map - this tool synthesizes a brief; it does not score a build or run a motion census.",
    {
      slugs: z
        .array(z.string().regex(/^[\w-]+$/))
        .min(2)
        .max(5)
        .refine(
          (slugs) => new Set(slugs.map((slug) => slug.toLowerCase())).size === slugs.length,
          "slugs must be distinct",
        )
        .describe("Two to five distinct site slugs from search_references (letters, digits, underscores or hyphens; no duplicates)"),
      goal: z.string().trim().min(1).max(2000).describe("Project goal the brief must serve, e.g. 'a portfolio for a type foundry'; required and non-blank"),
      audience: z.string().trim().min(1).max(1000).optional().describe("Optional target audience; carried into the brief's direction summary"),
      constraints: z.array(z.string().trim().min(1).max(1000)).max(20).optional().describe("Optional list of project constraints (max 20), e.g. 'no WebGL', 'must work without JS'"),
      includeStructure: z.boolean().default(false).describe("Also run the structure inspector for each reference (needs Playwright; one browser launch per site)"),
      viewport: viewportSchema,
      waitStrategy: waitStrategySchema,
      maxBands: z.number().int().min(5).max(60).default(12).describe("Band cap for the optional structure pass (5-60, default 12)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.create_design_brief(args)),
  );
}

export function registerBuildProjectV2(ctx: ToolContext): void {
  ctx.tool(
    "build_project",
    "Convert a single-file exact rebuild (any local .html, e.g. the rebuild flow's full-page-exact.html) into a runnable Vite, Astro or Next.js project: sections become components, CSS splits per section, gsap timelines re-wire in the framework idiom (useEffect + gsap.context on Next), assets carried. Reads a local file and writes the project dir. The output is source, not a servable site: install and build it (npm install && npm run build) and serve the generated output (Vite/Astro dist, Next .next with next start), not the raw scaffold directory. Pairs with verify_build: build -> convert -> verify.",
    {
      htmlPath: z.string().describe("Local path to the single-file rebuild html to convert"),
      target: z.enum(["vite", "astro", "next"]).describe("Framework of the generated project"),
      out: z.string().describe("Directory to scaffold the project into (created as needed)"),
      name: z.string().optional().describe("package.json name (default rebuild-site)"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    (args: any) => asMcpResult(ctx.handlers.build_project(args)),
  );
}

export function registerVerifyBuildV2(ctx: ToolContext): void {
  ctx.tool(
    "verify_build",
    "Compare a built site against a reference (an Awwwards winner, a client's old site, any URL): band-structure match + motion fingerprint similarity, with a pass/warn/fail verdict and evidence lines. Band labels are #id.firstClass, so give your rebuild's sections stable ids/classes; anonymous rebuild labels (empty/body, or duplicates) fall back to tag+height matching. compact=true returns the verdict, overall and band scores, band counts (matched, refOnly, buildOnly), motion score and captureStable (false when either capture moved or the two captured different heights/animation counts); omit it for evidence lines. Closes the design loop: build -> verify -> fix -> re-verify. Reference can be an award site found via search_references, compared read-only via get_reference.",
    {
      buildUrl: z.string().url().describe("URL of the build to verify"),
      referenceUrl: z.string().url().describe("URL of the reference site to match"),
      waitStrategy: z
        .enum(["load", "networkidle"])
        .optional()
        .describe("'load' waits for load plus settle; 'networkidle' waits for network quiet; omit to let the orchestrator use its scroll-census default"),
      viewport: viewportSchema,
      domDiff: z.boolean().default(false).describe("body-subtree structural diff between reference and build"),
      compact: z
        .boolean()
        .optional()
        .describe("compact=true returns the verdict, overall and band scores, band counts and motion score; omit for evidence lines"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.verify_build(args)),
  );
}

export function registerVerifyFlowV2(ctx: ToolContext): void {
  ctx.registerTool(
    "verify_flow",
    {
      description:
        "Step-aligned comparison of interaction flows: runs the same 1-6 scroll/click/wait steps on a build and a reference page (two fresh headless launches, desktop or mobile), then compares path, scroll delta, skeleton hash, text hash and element count after each step. A step is same only when both sides are complete and untruncated; truncated or failed states are unknown. No screenshots: hashes are evidence, not visual truth. A click can still trigger client-side mutations. Runs on URLs you are authorized to inspect. Use verify_build for a scored structure/motion comparison; build_project converts a local file into a project and never verifies. Needs the optional Playwright dependency.",
      inputSchema: verifyFlowArgsSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args: any) => asMcpResult(ctx.handlers.verify_flow(args)),
  );
}

export function registerAnalyzeNetworkCaptureV2(ctx: ToolContext): void {
  ctx.tool(
    "analyze_network_capture",
    "Offline API-surface evidence from a local HAR 1.2 file (browser devtools export): groups requests by method + origin + path template (ISO dates, versions, UUIDs, hex ids and numbers templated; emails, tokens and long high-entropy segments redacted), with counts, statuses, content types and query names only. Reads the file only - never fetches recorded URLs, never returns bodies, headers or query values. No network.",
    {
      path: z.string().min(1).describe("Local path to a HAR 1.2 file"),
      top: z.number().int().min(1).max(200).optional().describe("Max groups after sorting (default 50, max 200)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (args: any) => asMcpResult(ctx.handlers.analyze_network_capture(args)),
  );
}
