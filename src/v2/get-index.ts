// v2 index: local cache introspection only, zero network. Not registered in
// the 1.x tool surface. Exactly one branch per request; every branch object
// is strict so cross-branch fields fail validation instead of being silently
// ignored.
import { z } from "zod";
import { indexGetOutputSchema } from "../index-contracts.js";
import type { Handlers, ToolResponse } from "../server.js";
import { asMcpResult, type ToolContext } from "../tools/shared.js";

export const getIndexRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("status"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("stats"),
      windowDays: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .default(90)
        .describe(
          "Window for detail-derived metrics only (details, colours, scores, motion DNA); sites/elements/technologies are all-time",
        ),
      top: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Max rows per frequency list (technologies, colours, motion libs)"),
    })
    .strict(),
]);

export type GetIndexRequest = z.infer<typeof getIndexRequestSchema>;

export const getIndexInputSchema = z
  .object({
    request: getIndexRequestSchema.describe(
      "Exactly one index operation; choose kind and its branch fields",
    ),
  })
  .strict();

export async function runGetIndex(
  handlers: Handlers,
  request: GetIndexRequest,
): Promise<ToolResponse> {
  switch (request.kind) {
    case "status":
      return handlers.get_index_status();
    case "stats":
      return handlers.get_index_stats({ windowDays: request.windowDays, top: request.top });
    default: {
      const exhaustive: never = request;
      throw new Error(`unhandled get_index request: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function registerGetIndex(ctx: ToolContext): void {
  ctx.tool(
    "get_index",
    "Read the local offline index only — zero network. Choose exactly one request.kind: status (cached site count, crawl progress, last successful finish and error, lock state and freshness) or stats (aggregate all-time and windowed metrics over locally cached rows; windowDays defaults to 90 and top caps each frequency list). Aggregates only: no site slugs or titles. There is no all mode: exactly one kind per call.",
    getIndexInputSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (args: { request: GetIndexRequest }) =>
      asMcpResult(runGetIndex(ctx.handlers, args.request)),
    indexGetOutputSchema,
  );
}
