// v2 inspection group: page composition, styling tokens and technology.
// Not registered in the 1.x surface. Exactly one branch per request; every
// branch object is strict so cross-branch fields fail validation.
import { z } from "zod";
import type { Handlers, ToolResponse } from "../server.js";
import { asMcpResult, viewportSchema, waitStrategySchema, type ToolContext } from "../tools/shared.js";

export const inspectPageRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("structure"),
      url: z.string().url().describe("Absolute URL (https:// or file://) of the page to analyze"),
      maxBands: z.number().int().min(5).max(60).default(40).describe("Cap on returned bands"),
      waitStrategy: waitStrategySchema,
      viewport: viewportSchema,
      compare: z
        .enum(["mobile"])
        .optional()
        .describe(
          "Also capture at 390×844 (mobile): adds mobileBands + diff; absent keeps the desktop response unchanged",
        ),
      cdpEndpoint: z
        .string()
        .optional()
        .describe(
          "Attach to a browser YOU started (requires AWWWARDS_MCP_ATTACH=1): loopback CDP endpoint. Selects an already-open matching page and never navigates, scrolls, clicks or creates tabs",
        ),
      publicOnly: z.boolean().optional().describe("Refuse private/loopback/metadata destinations and route the browser through the pinned public-address guard; cannot be combined with cdpEndpoint"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tokens"),
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
    })
    .strict(),
  z
    .object({
      kind: z.literal("stack"),
      url: z.string().url().describe("Page URL to fetch and fingerprint"),
      timeoutMs: z.number().int().min(1000).max(30000).optional()
        .describe("Fetch timeout in ms (default 15000)"),
    })
    .strict(),
]);

export type InspectPageRequest = z.infer<typeof inspectPageRequestSchema>;

export const inspectPageInputSchema = z
  .object({
    request: inspectPageRequestSchema.describe(
      "Exactly one inspection operation; choose kind and its branch fields",
    ),
  })
  .strict();

export async function runInspectPage(
  handlers: Handlers,
  request: InspectPageRequest,
): Promise<ToolResponse> {
  switch (request.kind) {
    case "structure":
      return handlers.analyze_page_structure({
        url: request.url,
        maxBands: request.maxBands,
        waitStrategy: request.waitStrategy,
        viewport: request.viewport,
        ...(request.compare !== undefined ? { compare: request.compare } : {}),
        ...(request.cdpEndpoint !== undefined ? { cdpEndpoint: request.cdpEndpoint } : {}),
        ...(request.publicOnly !== undefined ? { publicOnly: request.publicOnly } : {}),
      });
    case "tokens":
      return handlers.export_design_tokens({
        url: request.url,
        ...(request.selector !== undefined ? { selector: request.selector } : {}),
        viewport: request.viewport,
        ...(request.maxNodes !== undefined ? { maxNodes: request.maxNodes } : {}),
        ...(request.include !== undefined ? { include: request.include } : {}),
        ...(request.publicOnly !== undefined ? { publicOnly: request.publicOnly } : {}),
      });
    case "stack":
      return handlers.analyze_stack({
        url: request.url,
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      });
    default: {
      const exhaustive: never = request;
      throw new Error(`unhandled inspect_page request: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function registerInspectPage(ctx: ToolContext): void {
  ctx.tool(
    "inspect_page",
    "Read-only inspection of a page's composition, styling and technology. Choose exactly one request.kind: structure (section band map with an optional mobile compare or CDP attach; supports live URLs and file:// paths), tokens (design tokens from computed styles, live URL), or stack (framework/CSS/library fingerprint from one fetched HTML page, live URL). structure supports file:// and CDP; cdpEndpoint is incompatible with compare and non-desktop viewports. tokens and stack are live URL tools.",
    inspectPageInputSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    (args: { request: InspectPageRequest }) =>
      asMcpResult(runInspectPage(ctx.handlers, args.request)),
  );
}
