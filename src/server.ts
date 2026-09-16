import { parseCategories, parseDetail, parseListing } from "./parsers.js";
import { AwwwardsClient, BlockedError, buildFilterUrl } from "./awwwards.js";
import type { Cache } from "./cache.js";
import type { AwardFilter, SearchFilters } from "./awwwards.js";
import type { Categories, SiteDetails, SiteSummary } from "./types.js";

const AWARD_FILTER_LABELS: Record<AwardFilter, string> = {
  sotd: "Site of the Day",
  developer: "Developer Award",
  honorable: "Honorable Mention",
};

export const SITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CATEGORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type Block =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResponse {
  content: Block[];
  isError?: boolean;
}

export interface SearchArgs extends SearchFilters {
  count?: number;
  page?: number;
}

export type CaptureFn = (
  url: string,
  imagesDir: string,
) => Promise<{ file: string; base64: string } | { error: string }>;

export function slugifyTag(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function text(t: string): Block {
  return { type: "text", text: t };
}

function summarizeSite(s: SiteSummary): string {
  const award = s.awards.length ? ` [${s.awards.join(", ")}]` : "";
  return `- ${s.title} (slug: ${s.slug})${award}\n  live: ${s.liveUrl ?? "unknown"}\n  awwwards: https://www.awwwards.com${s.detailPath}\n  tags: ${s.tags.join(", ")}`;
}

function errorResponse(err: unknown): ToolResponse {
  const message =
    err instanceof BlockedError
      ? err.message
      : `awwwards-mcp request failed: ${err instanceof Error ? err.message : String(err)}`;
  return { content: [text(message)], isError: true };
}

export interface Handlers {
  search_sites(args: SearchArgs): Promise<ToolResponse>;
  get_site_details(args: { slug: string }): Promise<ToolResponse>;
  list_categories(): Promise<ToolResponse>;
  capture_live_site(args: { url: string }): Promise<ToolResponse>;
}

// Placeholder until src/capture.ts lands in Task 9; Task 10 wires the real
// dynamic import here. Keeping it static avoids a dangling module specifier.
const defaultCapture: CaptureFn = async () =>
  ({ error: "capture module not wired until Task 9" });

export function createHandlers(deps: {
  client: AwwwardsClient;
  cache: Cache;
  captureFn?: CaptureFn;
}): Handlers {
  const { client, cache } = deps;

  // Which filter wins the URL (combined filter URLs 404 on awwwards.com).
  const urlSource = (f: SearchArgs): "color" | "award" | "technology" | "tag" | "none" =>
    f.color ? "color" : f.award ? "award" : f.technology ? "technology" : f.tags?.length ? "tag" : "none";

  function matchesFilters(s: SiteSummary, f: SearchArgs): boolean {
    const source = urlSource(f);
    if (f.tags?.length) {
      const tagsToCheck = source === "tag" ? f.tags.slice(1) : f.tags;
      for (const t of tagsToCheck) {
        const slug = t.toLowerCase();
        if (!s.tags.some((st) => slugifyTag(st).includes(slug))) return false;
      }
    }
    if (f.technology && source !== "technology") {
      const slug = f.technology.toLowerCase();
      if (!s.tags.some((st) => slugifyTag(st).includes(slug))) return false;
    }
    if (f.award && source !== "award") {
      if (!s.awards.includes(AWARD_FILTER_LABELS[f.award])) return false;
    }
    if (f.query) {
      const q = f.query.toLowerCase();
      if (
        !s.title.toLowerCase().includes(q) &&
        !s.tags.some((st) => st.toLowerCase().includes(q))
      ) {
        return false;
      }
    }
    return true;
  }

  async function siteImage(s: SiteSummary): Promise<Block | null> {
    try {
      const buf = await cache.getImage(s.thumbnailPath, () =>
        client.getThumbnail(s.thumbnailPath, 880),
      );
      return { type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" };
    } catch {
      return null; // thumbnail failures degrade to metadata-only cards
    }
  }

  async function search_sites(args: SearchArgs): Promise<ToolResponse> {
    const count = Math.min(Math.max(args.count ?? 6, 1), 12);
    const page = Math.max(args.page ?? 1, 1);
    try {
      let sites = cache.getSites(SITE_TTL_MS).filter((s) => matchesFilters(s, args));
      if (sites.length < count * page) {
        const html = await client.getHtml(buildFilterUrl(args));
        const parsed = parseListing(html);
        if (parsed.length === 0) {
          return {
            content: [
              text(
                "Awwwards layout may have changed: parsed 0 site cards. " +
                  "The awwwards-mcp parser likely needs an update.",
              ),
            ],
            isError: true,
          };
        }
        cache.upsertSites(parsed);
        sites = cache.getSites(SITE_TTL_MS).filter((s) => matchesFilters(s, args));
      }

      const slice = sites.slice((page - 1) * count, page * count);
      if (slice.length === 0) {
        return {
          content: [
            text(
              "No sites matched the search on this page. Try fewer filters or run list_categories. " +
                "(Deep pagination is unavailable by design: awwwards.com's robots.txt disallows it.)",
            ),
          ],
        };
      }

      const images = await Promise.all(slice.map(siteImage));
      const content: Block[] = [
        text(
          `${sites.length} site(s) matched; showing ${(page - 1) * count + 1}-${(page - 1) * count + slice.length}:\n\n` +
            slice.map(summarizeSite).join("\n\n"),
        ),
        ...images.filter((b): b is Block => b !== null),
      ];
      return { content };
    } catch (err) {
      // Spec: on live-request failure, serve stale cache if present. The store
      // itself may be the failure source, so this lookup is guarded too.
      let stale: SiteSummary[] = [];
      try {
        stale = cache.getSites(Infinity).filter((s) => matchesFilters(s, args));
      } catch {
        stale = [];
      }
      if (stale.length > 0) {
        const slice = stale.slice(0, count);
        const images = await Promise.all(slice.map(siteImage));
        return {
          content: [
            text(
              `The live awwwards.com request failed (${err instanceof Error ? err.message : String(err)}). ` +
                `Serving ${slice.length} result(s) from stale cache instead:\n\n` +
                slice.map(summarizeSite).join("\n\n"),
            ),
            ...images.filter((b): b is Block => b !== null),
          ],
        };
      }
      return errorResponse(err);
    }
  }

  async function get_site_details(args: { slug: string }): Promise<ToolResponse> {
    try {
      const metaKey = `detail:${args.slug}`;
      let d = cache.getMeta<SiteDetails>(metaKey, SITE_TTL_MS);
      if (!d) {
        d = parseDetail(await client.getHtml(`/sites/${args.slug}`), args.slug);
        cache.setMeta(metaKey, d);
      }
      const cachedSite = cache.getSite(args.slug, SITE_TTL_MS);
      const liveUrl = d.liveUrl ?? cachedSite?.liveUrl ?? null;

      const content: Block[] = [
        text(
          [
            `# ${d.title ?? args.slug}`,
            liveUrl ? `Live site: ${liveUrl}` : null,
            d.awards.length
              ? `Awards: ${d.awards.map((a) => `${a.title} (${a.date})`).join(", ")}`
              : null,
            d.palette.length ? `Color palette: ${d.palette.join(", ")}` : null,
            d.technologies.length ? `Technologies & tools: ${d.technologies.join(", ")}` : null,
            d.elements.length ? `Design elements: ${d.elements.join(", ")}` : null,
            d.description ? `Description: ${d.description}` : null,
            d.ogImage ? `Full-size screenshot: ${d.ogImage}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      ];
      if (cachedSite) {
        const img = await siteImage(cachedSite);
        if (img) content.push(img);
      }
      return { content };
    } catch (err) {
      return errorResponse(err);
    }
  }

  async function list_categories(): Promise<ToolResponse> {
    try {
      let cats = cache.getMeta<Categories>("categories", CATEGORY_TTL_MS);
      if (!cats) {
        cats = parseCategories(await client.getHtml("/websites/"));
        cache.setMeta("categories", cats);
      }
      return {
        content: [
          text(
            JSON.stringify(
              {
                colorCount: cats.colors.length,
                colors: cats.colors,
                filterCount: cats.filters.length,
                filters: cats.filters,
                usage:
                  "Pass one of: color (hex), award (sotd|developer|honorable), technology or a tag slug to search_sites. Combine at most one URL filter with client-side tags.",
              },
              null,
              1,
            ),
          ),
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }

  async function capture_live_site(args: { url: string }): Promise<ToolResponse> {
    try {
      const capture = deps.captureFn ?? defaultCapture;
      const result = await capture(args.url, cache.imagesDir);
      if ("error" in result) return { content: [text(result.error)], isError: true };
      return {
        content: [
          text(`Full-page capture of ${args.url} saved to ${result.file}`),
          { type: "image", data: result.base64, mimeType: "image/png" },
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }

  return { search_sites, get_site_details, list_categories, capture_live_site };
}
