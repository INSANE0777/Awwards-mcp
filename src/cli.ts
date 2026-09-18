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
import { runIndexer, shouldAutoIndex } from "./indexer.js";

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
const client = new AwwwardsClient();
const handlers = createHandlers({
  client,
  cache,
  // captureLiveSite's third positional is the injectable playwright loader,
  // so the CaptureFn-shaped (url, dir, opts) call is adapted to land opts
  // in the function's fourth (opts) position.
  captureFn: (url, imagesDir, opts) => captureLiveSite(url, imagesDir, undefined, opts),
});

const server = new McpServer({ name: "awwwards-mcp", version: "1.5.0" });

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
    sortBy: z
      .enum(["score", "newest"])
      .default("newest")
      .describe(
        "Sort results: by Awwwards jury score (details previously fetched) or newest first",
      ),
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
  "get_site_elements",
  "Get the design-element highlights of one Awwwards site: component-level visuals (3D models, video content, mobile layouts, microcopy) with poster images inline and video URLs.",
  {
    slug: z
      .string()
      .regex(/^[\w-]+$/)
      .describe("Site slug from search_sites, e.g. 'l-i-s-a'"),
  },
  (args) => asMcpResult(handlers.get_site_elements(args)),
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
  {
    url: z.string().url().describe("Absolute URL of the site to capture"),
    waitStrategy: z
      .enum(["load", "networkidle"])
      .default("load")
      .describe("'load' + settle works on heavy sites; 'networkidle' waits for total quiet"),
  },
  (args) => asMcpResult(handlers.capture_live_site(args)),
);

server.tool(
  "analyze_page_structure",
  "Extract a page's section band map (tag, label, background color, offset, height per band) via a headless browser. Works on live URLs and file:// paths — use it to compare a reference site's structure against your local build.",
  {
    url: z.string().url().describe("Absolute URL (https:// or file://) of the page to analyze"),
    maxBands: z.number().int().min(5).max(60).default(40).describe("Cap on returned bands"),
    waitStrategy: z
      .enum(["load", "networkidle"])
      .default("load")
      .describe("'load' + settle works on heavy sites; 'networkidle' waits for total quiet"),
  },
  (args) => asMcpResult(handlers.analyze_page_structure(args)),
);

server.tool(
  "record_site_motion",
  "Record a short motion-through video of a live website — preloader, scroll-triggered and hover/cursor animations — and return an inline filmstrip JPEG plus the .webm path. Requires the optional playwright and ffmpeg-static dependencies.",
  {
    url: z.string().url().describe("Absolute URL of the site to record"),
    frames: z
      .number()
      .int()
      .min(4)
      .max(36)
      .default(16)
      .describe("Filmstrip tile count (default 16 → a 4x4 grid)"),
    waitStrategy: z
      .enum(["load", "networkidle"])
      .default("load")
      .describe("'load' + settle works on heavy sites; 'networkidle' waits for total quiet"),
  },
  (args) => asMcpResult(handlers.record_site_motion(args)),
);

// Auto-refresh: if the index is stale (or absent) and no crawl is running,
// re-index in the background. Serving is never blocked; errors are stderr-only.
if (shouldAutoIndex(cache)) {
  void runIndexer({ client, cache, log: (m) => console.error(m) }).catch((err) => {
    console.error(
      `awwwards-mcp: background index failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

await server.connect(new StdioServerTransport());
