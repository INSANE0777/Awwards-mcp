#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { AwwwardsClient } from "./awwwards.js";
import { Cache } from "./cache.js";
import { createHandlers, type ToolResponse } from "./server.js";
import { captureLiveSite } from "./capture.js";

// The handlers return ToolResponse, which is structurally identical to the
// SDK's CallToolResult at runtime ({ content, isError? }). CallToolResult's
// schema additionally carries a [k: string]: unknown index signature that a
// TypeScript interface cannot satisfy implicitly, so a cast bridges the two.
const asMcpResult = (p: Promise<ToolResponse>): Promise<CallToolResult> =>
  p as unknown as Promise<CallToolResult>;

const cacheRoot = process.env.AWWWARDS_CACHE_DIR ?? join(homedir(), ".awwwards-mcp");
let cache: Cache;
try {
  cache = new Cache(cacheRoot);
} catch (err) {
  console.error(
    `awwwards-mcp: cannot initialize cache at ${cacheRoot}: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
  process.exit(1);
}
const handlers = createHandlers({
  client: new AwwwardsClient(),
  cache,
  captureFn: captureLiveSite,
});

const server = new McpServer({ name: "awwwards-mcp", version: "1.0.0" });

server.tool(
  "search_sites",
  "Search award-winning websites on Awwwards. Returns site cards with inline screenshots, live URLs, awards and tags.",
  {
    query: z.string().describe("Free text matched against site titles and tags").optional(),
    color: z
      .string()
      .regex(/^#?[0-9A-Fa-f]{6}$/)
      .describe("Dominant color hex, e.g. '#404040'")
      .optional(),
    tags: z.array(z.string()).describe("Tag slugs, e.g. ['3d', 'portfolio']").optional(),
    technology: z.string().describe("Technology slug, e.g. 'webgl', 'gsap', 'astro'").optional(),
    award: z.enum(["sotd", "developer", "honorable"]).optional(),
    count: z.number().int().min(1).max(12).default(6),
    page: z.number().int().min(1).default(1),
  },
  (args) => asMcpResult(handlers.search_sites(args)),
);

server.tool(
  "get_site_details",
  "Get the design DNA of one Awwwards site: color palette, technologies, design elements, awards, description and inline screenshot.",
  {
    slug: z
      .string()
      .regex(/^[\w-]+$/)
      .describe("Site slug from search_sites, e.g. 'l-i-s-a'"),
  },
  (args) => asMcpResult(handlers.get_site_details(args)),
);

server.tool(
  "list_categories",
  "List the filter taxonomy available on Awwwards: color hexes and tag/technology slugs usable with search_sites.",
  {},
  () => asMcpResult(handlers.list_categories()),
);

server.tool(
  "capture_live_site",
  "Take a fresh full-page screenshot of a live website URL using a headless browser. Requires the optional playwright dependency.",
  { url: z.string().url().describe("Absolute URL of the site to capture") },
  (args) => asMcpResult(handlers.capture_live_site(args)),
);

await server.connect(new StdioServerTransport());
