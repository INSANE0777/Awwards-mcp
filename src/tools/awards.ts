import { z } from "zod";
import { detailArgsSchema } from "../detail-schema.js";
import { indexStatsOutputSchema, indexStatusOutputSchema } from "../index-contracts.js";
import { asMcpResult, viewportSchema, waitStrategySchema, type ToolContext } from "./shared.js";

export function registerSearchSites(ctx: ToolContext): void {
  ctx.tool(
    "search_sites",
    "Search award-winning websites on Awwwards — the site index with filters. Returns site cards with inline screenshots, live URLs, awards and tags. Filters combine as AND. count defaults to 6 (max 12); page is one-based over the matched local set, and deep upstream query-string pagination is not crawled. Color searches always fetch the live filter page (site rows carry no colors). Use search_directory for agencies/studios, search_elements for UI components, get_collections for moodboards, new_winners for today's delta, and get_site_details for one site's DNA. A failed top-up keeps the already-cached page window; if the required live fetch fails, stale cached rows are served (page 1; color unchecked).",
    {
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
          "sotd", "sotm", "soty", "nominees", "developer", "honorable",
          "ecommerce", "portfolio", "product", "typography", "businessServices", "noCode",
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
      responseMode: z.enum(["full", "compact"]).default("full")
        .describe("full (default) returns all inline previews; compact returns concise cards and at most two page previews"),
      count: z.number().int().min(1).max(12).default(6).describe("Results per page (1-12, default 6)"),
      page: z.number().int().min(1).default(1).describe("One-based page over the matched local set; deep upstream query-string pagination is not crawled"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.search_sites(args)),
  );
}

export function registerGetSiteDetails(ctx: ToolContext): void {
  ctx.registerTool(
    "get_site_details",
    {
      description:
        "Get the design DNA of one Awwwards site: color palette, technologies, design elements, awards, description and inline screenshot. compact=true returns a token-diet summary. Batch: pass slugs (1–10, no images) for ordered compact details per slug with cached/fetched/error status; compact is ignored in batch mode (batch output is always compact). Provide exactly one of slug or slugs.",
      inputSchema: detailArgsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args: any) => asMcpResult(ctx.handlers.get_site_details(args)),
  );
}

export function registerCompareSites(ctx: ToolContext): void {
  ctx.tool(
    "compare_sites",
    "Compare the design DNA of 2–3 Awwwards sites: titles, live URLs, palettes, technologies, elements, awards and jury scores. Text only; missing details are fetched and cached. For your own build vs a reference, use verify_build instead.",
    {
      slugs: z.array(z.string().regex(/^[\w-]+$/)).min(2).max(3)
        .refine((slugs) => new Set(slugs.map((slug) => slug.toLowerCase())).size === slugs.length, "Site slugs must be distinct")
        .describe("Two or three distinct site slugs from search_sites"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.compare_sites(args)),
  );
}

export function registerCreateDesignBrief(ctx: ToolContext): void {
  ctx.tool(
    "create_design_brief",
    "Synthesize a cited design direction from 2–5 Awwwards site slugs plus a project goal. Uses cached detail (including its element list) and Motion DNA evidence first and fetches only missing details; includeStructure=true also runs a browser band analysis per reference. Returns one Markdown text block containing versioned JSON: shared signals vs one-site outliers, evidence gaps, an evidence-backed interaction plan, and reduced-motion/content/keyboard guardrails. Use search_sites to find slugs; use compare_sites for raw side-by-side DNA and analyze_page_structure for a band map — this tool synthesizes a brief; it does not score a build or run a motion census.",
    {
      slugs: z.array(z.string().regex(/^[\w-]+$/)).min(2).max(5).refine((slugs) => new Set(slugs.map((slug) => slug.toLowerCase())).size === slugs.length, "slugs must be distinct").describe("Two to five distinct site slugs from search_sites (letters, digits, underscores or hyphens; no duplicates)"),
      goal: z.string().trim().min(1).max(2000).describe("Project goal the brief must serve, e.g. 'a portfolio for a type foundry'; required and non-blank"),
      audience: z.string().trim().min(1).max(1000).optional().describe("Optional target audience; carried into the brief's direction summary"),
      constraints: z.array(z.string().trim().min(1).max(1000)).max(20).optional().describe("Optional list of project constraints (max 20), e.g. 'no WebGL', 'must work without JS'"),
      includeStructure: z.boolean().default(false).describe("Also run analyze_page_structure for each reference (needs Playwright; one browser launch per site)"),
      viewport: viewportSchema,
      waitStrategy: waitStrategySchema,
      maxBands: z.number().int().min(5).max(60).default(12).describe("Band cap for the optional structure pass (5-60, default 12)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.create_design_brief(args)),
  );
}

export function registerGetIndexStatus(ctx: ToolContext): void {
  ctx.tool(
    "get_index_status",
    "Read offline index status: cached site count, progress, last successful finish and error, lock state and freshness. No live requests.",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    () => asMcpResult(ctx.handlers.get_index_status()),
    indexStatusOutputSchema,
  );
}

export function registerGetIndexStats(ctx: ToolContext): void {
  ctx.tool(
    "get_index_stats",
    "Aggregate metrics over the LOCAL cache only (zero network). ALL-TIME: site count, element count and technology/tag frequency. WINDOWED by windowDays (default 90, 1-3650): cached details, palette colour frequency and jury score stats from at most the 500 most recently fetched detail rows, plus Motion DNA library frequency. Each metric carries coverage labelled 'locally cached subset'; windowDays/detailsCached/detailParseCap appear only on windowed metrics (sites/elements/technologies are explicitly all-time). top caps each frequency list (default 10, 1-50). Aggregates only - no site slugs or titles. Personal, non-commercial use.",
    {
      windowDays: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .default(90)
        .describe("Window for detail-derived metrics only (details, colours, scores, motion DNA); sites/elements/technologies are all-time"),
      top: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Max rows per frequency list (technologies, colours, motion libs)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (args: any) => asMcpResult(ctx.handlers.get_index_stats(args)),
    indexStatsOutputSchema,
  );
}

export function registerGetSiteElements(ctx: ToolContext): void {
  ctx.tool(
    "get_site_elements",
    "Get the design-element highlights of one Awwwards site: component-level visuals (3D models, video content, mobile layouts, microcopy) with poster images inline and video URLs.",
    {
      slug: z
        .string()
        .regex(/^[\w-]+$/)
        .describe("Site slug from search_sites, e.g. 'l-i-s-a'"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.get_site_elements(args)),
  );
}

export function registerSearchElements(ctx: ToolContext): void {
  ctx.tool(
    "search_elements",
    "Search Awwwards UI components — award-grade footers, menus, loaders, transitions, micro-interactions… — across cached gallery records plus source:\"site\" records derived from new SOTD winners' own Elements sections. It does not crawl the /elements/* gallery (robots.txt disallows it). " +
      "Usage: pass query text; category and stack combine as AND when both are provided; each result carries its element slug, source and parent project identifiers.",
    {
      query: z.string().describe("Free text: what the component is or does").optional(),
      category: z
        .string()
        .describe("Category id from the gallery taxonomy, e.g. 'footer', 'menu', 'cta', 'loading', 'mouse_interaction', '404_page'")
        .optional(),
      stack: z.array(z.string()).describe("Built-with tokens, e.g. ['gsap', 'webgl']").optional(),
      limit: z.number().int().min(1).max(20).default(8).describe("Max results (1-20, default 8)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.search_elements(args)),
  );
}

export function registerGetElement(ctx: ToolContext): void {
  ctx.tool(
    "get_element",
    "Get one Awwwards element in full: title, author, built-with stack, media URLs, related elements and the parent award-winning project. Use search_elements first for ids.",
    {
      id: z.string().describe("Element slug from search_elements"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (args: any) => asMcpResult(ctx.handlers.get_element(args)),
  );
}

export function registerListCategories(ctx: ToolContext): void {
  ctx.tool(
    "list_categories",
    "List the filter taxonomy available on Awwwards: award collections, color hexes, tag/technology slugs usable with search_sites, and the annual winner categories.",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    () => asMcpResult(ctx.handlers.list_categories()),
  );
}

export function registerGetAnnualCategories(ctx: ToolContext): void {
  ctx.tool(
    "get_annual_categories",
    "List the official Awwwards Annual Awards categories (Site of the Year, Agency of the Year, …) with nominee counts. Annual Awards only: this is not the daily site index. Annual data comes from Awwwards' official public read-only API for personal, non-commercial inspiration use; nominee details are hydrated on request. Media URLs are reference-only — nothing is downloaded.",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    () => asMcpResult(ctx.handlers.get_annual_categories()),
  );
}

export function registerGetAnnualNominees(ctx: ToolContext): void {
  ctx.tool(
    "get_annual_nominees",
    "Annual Awards only: list nominees in one official Awwwards Annual Awards category, hydrated on demand at 1 request/second (default 10, max 20 per call). Site summaries carry siteSlug and inLocalIndex, so an agent can jump to get_site_details when the daily index has the site. Personal, non-commercial inspiration use only; media URLs are reference-only and are never downloaded.",
    {
      category: z
        .string()
        .min(1)
        .describe("Category slug from get_annual_categories, e.g. 'site-of-the-year'"),
      limit: z.number().int().min(1).max(20).default(10)
        .describe("Nominees to hydrate in this call (max 20)"),
      offset: z.number().int().min(0).default(0)
        .describe("Zero-based nominee offset within the category"),
      hydrate: z.boolean().default(true)
        .describe("Hydrate uncached nominees (1 req/s); false returns cached entries plus id stubs"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.get_annual_nominees(args)),
  );
}

export function registerGetAnnualNominee(ctx: ToolContext): void {
  ctx.tool(
    "get_annual_nominee",
    "Annual Awards only: get one official Awwwards Annual Awards nominee in full: site entries carry date, description, designBy, country, image/video URLs; agency entries carry location, avatar, award tag counts and featured projects. Pass id (a UUID or full /api/annual/nominees/... path) or category+slug; category+slug may hydrate up to 20 uncached nominees at 1 request/second (~20s worst case), so prefer id when known. Personal, non-commercial inspiration use only; media URLs are reference-only and nothing is downloaded.",
    {
      id: z
        .string()
        .min(1)
        .optional()
        .describe("Nominee UUID or full /api/annual/nominees/sites|users/<uuid> path"),
      category: z.string().min(1).optional().describe("Category slug, for slug-based lookup"),
      slug: z.string().min(1).optional().describe("Nominee slug, paired with category"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.get_annual_nominee(args)),
  );
}

export function registerGetCollections(ctx: ToolContext): void {
  ctx.tool(
    "get_collections",
    "Browse Awwwards' curated thematic moodboards, not a search index. Without a slug, lists collections (paginated); with a slug, returns that collection's first page of site cards. Curated slugs look like 'brutalism'; member collections need 'owner/slug'. One page per call, 7-day local cache. Personal, non-commercial inspiration use.",
    {
      slug: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Collection slug: 'brutalism' (curated) or 'owner/slug' for a member collection"),
      page: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(1)
        .describe(
          "Collections index page (1-4 live; page > 4 is rejected). With a slug, page N of that collection",
        ),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.get_collections(args)),
  );
}

export function registerSearchDirectory(ctx: ToolContext): void {
  ctx.tool(
    "search_directory",
    "Search the Awwwards directory of agencies/studios, not sites. Filters are path-based, so one of country/category/budget applies per request; query is matched client-side over the fetched page. Returns public profile cards (name, slug, location, website, award counts) — contact details are stripped. One page per call, 7-day local cache. Personal, non-commercial inspiration use.",
    {
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
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.search_directory(args)),
  );
}

export function registerNewWinners(ctx: ToolContext): void {
  ctx.tool(
    "new_winners",
    "Poll today's new Awwwards winners as a delta against the previous poll: new-entrant cards since the last call (first call seeds the baseline and reports no delta). Poll daily for a winners feed; pairs with watch_site for structured monitoring.",
    {
      award: z.enum(["sotd", "developer", "honorable"]).default("sotd")
        .describe("Which winners feed to poll"),
    },
    // Writes the poll baseline, so results change the next call — not idempotent.
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.new_winners(args)),
  );
}

export function registerWatchSite(ctx: ToolContext): void {
  ctx.tool(
    "watch_site",
    "Longitudinal watchlist over Awwwards listings: track a studio (e.g. 'ToyFight'), a tag/technology slug (e.g. 'webgl'), or a site URL-slug for changes and new entries. add/list/remove; the delta is reported by watch_site list after new_winners or search_sites refreshes the listing.",
    {
      action: z.enum(["add", "list", "remove"]).describe("add = create a watch; list = report deltas from the freshest cached listing (no fetch); remove = delete the watch matching kind + pattern"),
      kind: z.enum(["studio", "tag", "url"]).optional()
        .describe("studio = creator name from listing cards; tag = tag/technology slug; url = a /sites/<slug> site-slug"),
      pattern: z.string().optional().describe("What to watch (name/slug per kind)"),
      award: z.enum(["sotd", "developer", "honorable"]).optional()
        .describe("Restrict a watch to one award feed"),
      note: z.string().optional().describe("Why you're watching (free text)"),
    },
    // add/remove mutate the watchlist, so the tool as a whole is not read-only.
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    (args: any) => asMcpResult(ctx.handlers.watch_site(args)),
  );
}
