// v2 retrieval: reference evidence for one known target. Not registered in
// the 1.x tool surface. Exactly one branch per request; every branch object
// is strict so cross-branch fields fail validation instead of being silently
// ignored.
import { z } from "zod";
import { ATLAS_ID } from "../atlas/tool-limits.js";
import { detailArgsSchema } from "../detail-schema.js";
import type { Handlers, ToolResponse } from "../server.js";
import { asMcpResult, type ToolContext } from "../tools/shared.js";

const siteDetailsShape = {
  ...detailArgsSchema.shape,
  slug: detailArgsSchema.shape.slug.describe(
    "Site slug from search_references, e.g. 'l-i-s-a'. Provide exactly one of slug or slugs",
  ),
};

export const getReferenceRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("site_details"),
      ...siteDetailsShape,
    })
    .strict()
    .refine((args) => (args.slug === undefined) !== (args.slugs === undefined), {
      message: "Provide exactly one of slug or slugs",
    }),
  z
    .object({
      kind: z.literal("site_elements"),
      slug: z
        .string()
        .regex(/^[\w-]+$/)
        .describe("Site slug from search_references, e.g. 'l-i-s-a'"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("element"),
      id: z.string().describe("Element slug from search_references kind=elements"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("comparison"),
      slugs: z
        .array(z.string().regex(/^[\w-]+$/))
        .min(2)
        .max(3)
        .refine(
          (slugs) => new Set(slugs.map((slug) => slug.toLowerCase())).size === slugs.length,
          "Site slugs must be distinct",
        )
        .describe("Two or three distinct site slugs from search_references"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("collection"),
      slug: z
        .string()
        .min(1)
        .max(200)
        .describe("Collection slug: 'brutalism' (curated) or 'owner/slug' for a member collection"),
      page: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(1)
        .describe("Page N of that collection"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("atlas_region"),
      regionId: z
        .string()
        .regex(ATLAS_ID)
        .describe("Stored Atlas region id (64 lowercase hex characters)"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("atlas_highlight"),
      elementId: z
        .string()
        .min(1)
        .max(400)
        .describe("Existing element id resolved through Atlas aliases; no legacy gallery fetch"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("atlas_taxonomy"),
    })
    .strict(),
]);

export type GetReferenceRequest = z.infer<typeof getReferenceRequestSchema>;

export const getReferenceInputSchema = z
  .object({
    request: getReferenceRequestSchema.describe(
      "Exactly one retrieval operation; choose kind and its branch fields",
    ),
  })
  .strict();

export async function runGetReference(
  handlers: Handlers,
  request: GetReferenceRequest,
): Promise<ToolResponse> {
  switch (request.kind) {
    case "site_details":
      return handlers.get_site_details({
        ...(request.slug !== undefined ? { slug: request.slug } : {}),
        ...(request.slugs !== undefined ? { slugs: request.slugs } : {}),
        ...(request.compact !== undefined ? { compact: request.compact } : {}),
      });
    case "site_elements":
      return handlers.get_site_elements({ slug: request.slug });
    case "element":
      return handlers.get_element({ id: request.id });
    case "comparison":
      return handlers.compare_sites({ slugs: request.slugs });
    case "collection":
      return handlers.get_collections({ slug: request.slug, page: request.page });
    case "atlas_region":
      return handlers.get_atlas({ kind: "region", regionId: request.regionId });
    case "atlas_highlight":
      return handlers.get_atlas({ kind: "highlight", elementId: request.elementId });
    case "atlas_taxonomy":
      return handlers.get_atlas({ kind: "taxonomy" });
    default: {
      const exhaustive: never = request;
      throw new Error(`unhandled get_reference request: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function registerGetReference(ctx: ToolContext): void {
  ctx.tool(
    "get_reference",
    "Retrieve reference evidence for one known target. Choose exactly one request.kind: site_details (one site slug, or a batch of 1–10 distinct slugs, optional compact), site_elements (one site's element highlights), element (one element id), comparison (2–3 distinct site slugs side by side), collection (one collection page by required slug), or — when AWWWARDS_MCP_ATLAS=1 — atlas_region (one stored Atlas region: capture conditions, up to 128 claims, availability-checked artifacts, parent/child summaries and current/historical head status), atlas_highlight (resolve an existing element id through Atlas aliases; ambiguous ids return AMBIGUOUS_ALIAS with candidates and no gallery fetch) or atlas_taxonomy (registry version, values, aliases, evidence bases, scopes/states and unsupported operations). Atlas retrieval returns its own envelope. Use search_references first to find slugs, element ids and Atlas regions. There is no all mode: exactly one kind per call.",
    getReferenceInputSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    (args: { request: GetReferenceRequest }) =>
      asMcpResult(runGetReference(ctx.handlers, args.request)),
  );
}
