// v2 discovery: one entry point for finding references. Not registered in the
// 1.x tool surface. Exactly one branch per request; every branch object is
// strict so cross-branch fields fail validation instead of being silently
// ignored.
import { z } from "zod";
import type { Handlers, ToolResponse } from "../server.js";
import { asMcpResult, type ToolContext } from "../tools/shared.js";
import { atlasSearchFilterShape } from "../atlas/tool-contracts.js";

export const searchReferencesRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("sites"),
      query: z.string().describe("Free text matched against site titles and tags").optional(),
      color: z
        .string()
        .regex(/^#?[0-9A-Fa-f]{6}$/)
        .describe("Dominant color hex, e.g. '#404040'")
        .optional(),
      tags: z.array(z.string()).describe("Tag slugs, e.g. ['3d', 'portfolio']").optional(),
      technology: z.string().describe("Technology slug, e.g. 'webgl', 'gsap', 'astro'").optional(),
      award: z
        .enum([
          "sotd",
          "sotm",
          "soty",
          "nominees",
          "developer",
          "honorable",
          "ecommerce",
          "portfolio",
          "product",
          "typography",
          "businessServices",
          "noCode",
        ])
        .optional()
        .describe(
          "Award collection: sotd | developer | honorable | sotm | soty | nominees, or an annual winner category: ecommerce | portfolio | product | typography | businessServices | noCode",
        ),
      sortBy: z
        .enum(["score", "newest"])
        .default("newest")
        .describe(
          "Sort results: by Awwwards jury score (details previously fetched) or default order — newest first, or bm25 relevance for a free-text query",
        ),
      responseMode: z
        .enum(["full", "compact"])
        .default("full")
        .describe(
          "full (default) returns all inline previews; compact returns concise cards and at most two page previews",
        ),
      count: z.number().int().min(1).max(12).default(6).describe("Results per page (1-12, default 6)"),
      page: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe(
          "One-based page over the matched local set; deep upstream query-string pagination is not crawled",
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("elements"),
      query: z.string().describe("Free text: what the component is or does").optional(),
      category: z
        .string()
        .describe(
          "Category id from the gallery taxonomy, e.g. 'footer', 'menu', 'cta', 'loading', 'mouse_interaction', '404_page'",
        )
        .optional(),
      stack: z.array(z.string()).describe("Built-with tokens, e.g. ['gsap', 'webgl']").optional(),
      limit: z.number().int().min(1).max(20).default(8).describe("Max results (1-20, default 8)"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("directory"),
      query: z
        .string()
        .max(200)
        .optional()
        .describe("Free text matched client-side against name, location and website"),
      country: z
        .string()
        .max(100)
        .optional()
        .describe("Canonical country name, case-sensitive, e.g. 'United States' or 'United Kingdom'"),
      category: z
        .string()
        .max(100)
        .optional()
        .describe("Category or type slug/label, e.g. 'web-design', 'Agency & Studio', 'freelance'"),
      budget: z
        .string()
        .max(100)
        .optional()
        .describe("Budget filter slug or label, e.g. 'over_hundred_thousand' or 'Over $100,000'"),
      page: z.number().int().min(1).max(100).default(1).describe("Directory page"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("motion"),
      lib: z.string().optional().describe("Motion library filter, e.g. 'gsap', 'three'"),
      scrubOnly: z.boolean().default(false).describe("Only cached sites with scrubbed motion"),
      hasPins: z.boolean().default(false).describe("Only cached sites with pinned sections"),
      limit: z.number().int().min(1).max(50).default(20).describe("Max results (1-50, default 20)"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("collections"),
      page: z.number().int().min(1).max(100).default(1).describe("Collections index page"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("sections"),
      ...atlasSearchFilterShape,
    })
    .strict(),
  z
    .object({
      kind: z.literal("components"),
      ...atlasSearchFilterShape,
    })
    .strict(),
]);

export type SearchReferencesRequest = z.infer<typeof searchReferencesRequestSchema>;

export const searchReferencesInputSchema = z
  .object({
    request: searchReferencesRequestSchema.describe(
      "Exactly one discovery operation; choose kind and its branch fields",
    ),
  })
  .strict();

export async function runSearchReferences(
  handlers: Handlers,
  request: SearchReferencesRequest,
): Promise<ToolResponse> {
  switch (request.kind) {
    case "sites":
      return handlers.search_sites({
        ...(request.query !== undefined ? { query: request.query } : {}),
        ...(request.color !== undefined ? { color: request.color } : {}),
        ...(request.tags !== undefined ? { tags: request.tags } : {}),
        ...(request.technology !== undefined ? { technology: request.technology } : {}),
        ...(request.award !== undefined ? { award: request.award } : {}),
        sortBy: request.sortBy,
        responseMode: request.responseMode,
        count: request.count,
        page: request.page,
      });
    case "elements":
      return handlers.search_elements({
        ...(request.query !== undefined ? { query: request.query } : {}),
        ...(request.category !== undefined ? { category: request.category } : {}),
        ...(request.stack !== undefined ? { stack: request.stack } : {}),
        limit: request.limit,
      });
    case "directory":
      return handlers.search_directory({
        ...(request.query !== undefined ? { query: request.query } : {}),
        ...(request.country !== undefined ? { country: request.country } : {}),
        ...(request.category !== undefined ? { category: request.category } : {}),
        ...(request.budget !== undefined ? { budget: request.budget } : {}),
        page: request.page,
      });
    case "motion":
      return handlers.search_motion({
        ...(request.lib !== undefined ? { lib: request.lib } : {}),
        scrubOnly: request.scrubOnly,
        hasPins: request.hasPins,
        limit: request.limit,
      });
    case "collections":
      return handlers.get_collections({ page: request.page });
    case "sections":
    case "components": {
      const { kind, ...filters } = request;
      return handlers.search_atlas({ kind, ...filters });
    }
    default: {
      const exhaustive: never = request;
      throw new Error(`unhandled search_references request: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function registerSearchReferences(ctx: ToolContext): void {
  ctx.tool(
    "search_references",
    "One entry point for finding Awwwards references. Choose exactly one request.kind: sites (award-winning site index with query, color, tag, technology and award filters; color searches always fetch the live filter page, a failed top-up keeps the requested cached page window, and only a failed cold fetch falls back to stale cached page 1), elements (cached gallery records plus source:\"site\" records from new winners' own site pages; the /elements/* gallery is not crawled), directory (agencies/studios; country/category/budget are path-based, so only one applies per call, in that priority), motion (cached Motion DNA corpus only), collections (curated moodboards; the index is live for pages 1-4, page > 4 is rejected), sections or components (local Atlas evidence when AWWWARDS_MCP_ATLAS=1; region/page/site scopes, conjunctive predicates, disjunctive facets, accepted/observed/candidate evidence modes and hover/focus states; default candidate mode returns uncalibrated hints; the result is the Atlas envelope with interpreted input, witnesses, coverage and an optional next cursor; empty_corpus/insufficient_coverage mean not observed). collections lists collections only - use get_reference with kind=collection for one collection's sites. There is no all mode: exactly one kind per call.",
    searchReferencesInputSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    (args: { request: SearchReferencesRequest }) =>
      asMcpResult(runSearchReferences(ctx.handlers, args.request)),
  );
}
