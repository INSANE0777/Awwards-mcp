import { parseCategories, parseDetail, parseElements, parseListing } from "./parsers.js";
import {
  AwwwardsClient,
  BlockedError,
  buildFilterUrl,
  elementPosterPath,
  elementUrl,
} from "./awwwards.js";
import type { Cache } from "./cache.js";
import type { PageStructure, WaitOpts, WaitStrategy } from "./structure.js";
import type { AwardFilter, SearchFilters } from "./awwwards.js";
import type { ViewportName } from "./viewport.js";
import type { Categories, ElementMedia, SiteDetails, SiteSummary } from "./types.js";

const AWARD_FILTER_LABELS: Record<AwardFilter, string> = {
  sotd: "Site of the Day",
  developer: "Developer Award",
  honorable: "Honorable Mention",
};

export const SITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CATEGORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// The text block lists every element; only this many posters are fetched inline.
export const MAX_INLINE_POSTERS = 8;

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
  // "newest" (default) = current newest-first behavior; "score" orders scored
  // sites first (detail-meta score, desc), unscored after, newest-first.
  sortBy?: "score" | "newest";
}

export type CaptureFn = (
  url: string,
  imagesDir: string,
  opts?: WaitOpts,
) => Promise<{ file: string; base64: string } | { error: string }>;

export type AnalyzeFn = (
  url: string,
  maxBands?: number,
  opts?: WaitOpts,
) => Promise<PageStructure | { error: string }>;

export type MotionFn = (
  url: string,
  opts: {
    cacheImagesDir: string;
    frames?: number;
    waitStrategy?: WaitStrategy;
    viewport?: ViewportName;
  },
) => Promise<{ file: string; base64: string; frames: number } | { error: string }>;

export function slugifyTag(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Free-text queries match token-wise: every whitespace-separated token must
// substring-match the site's title+tags. A single token behaves exactly like
// the old whole-query substring check.
export function tokenizeQuery(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

// Zero-result suggestions: rank taxonomy slugs against the query's tokens.
// +2 per token (>=4 chars) the slug contains; +1 when slug and token share a
// >=4-char prefix (compared via their first 5 chars, in either direction).
// Ties rank stably by slug; only positive scores are suggested.
export function suggestTags(tokens: string[], taxonomy: string[], limit = 6): string[] {
  const scored: [string, number][] = [];
  for (const slug of taxonomy) {
    let score = 0;
    for (const t of tokens) {
      if (t.length < 4) continue;
      if (slug.includes(t)) score += 2;
      else if (slug.startsWith(t.slice(0, 5)) || t.startsWith(slug.slice(0, 5))) score += 1;
    }
    if (score > 0) scored.push([slug, score]);
  }
  return scored
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([s]) => s);
}

function text(t: string): Block {
  return { type: "text", text: t };
}

function summarizeSite(s: SiteSummary): string {
  const award = s.awards.length ? ` [${s.awards.join(", ")}]` : "";
  return `- ${s.title} (slug: ${s.slug})${award}\n  live: ${s.liveUrl ?? "unknown"}\n  awwwards: https://www.awwwards.com${s.detailPath}\n  tags: ${s.tags.join(", ")}`;
}

// An all-empty parse means the layout changed (or the page was not found):
// neither tool may cache such a parse, so the mismatch can still be surfaced.
function isAllEmptyDetail(d: SiteDetails): boolean {
  return (
    d.palette.length === 0 &&
    d.technologies.length === 0 &&
    d.elements.length === 0 &&
    d.awards.length === 0 &&
    !d.description
  );
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
  get_site_elements(args: { slug: string }): Promise<ToolResponse>;
  list_categories(): Promise<ToolResponse>;
  capture_live_site(args: {
    url: string;
    waitStrategy?: WaitStrategy;
    viewport?: ViewportName;
  }): Promise<ToolResponse>;
  analyze_page_structure(args: {
    url: string;
    maxBands?: number;
    waitStrategy?: WaitStrategy;
    viewport?: ViewportName;
  }): Promise<ToolResponse>;
  record_site_motion(args: {
    url: string;
    frames?: number;
    waitStrategy?: WaitStrategy;
    viewport?: ViewportName;
  }): Promise<ToolResponse>;
}

export function createHandlers(deps: {
  client: AwwwardsClient;
  cache: Cache;
  captureFn?: CaptureFn;
  analyzeFn?: AnalyzeFn;
  motionFn?: MotionFn;
}): Handlers {
  const { client, cache } = deps;

  // Which filter wins the URL (combined filter URLs 404 on awwwards.com).
  const urlSource = (f: SearchArgs): "color" | "award" | "technology" | "tag" | "none" =>
    f.color ? "color" : f.award ? "award" : f.technology ? "technology" : f.tags?.length ? "tag" : "none";

  // Two modes:
  // - honorUrlSource=true: rows freshly scraped from the filter page — the URL
  //   really did apply the highest-priority filter (color > award > technology
  //   > first tag), so skip re-checking that one and verify the rest.
  // - honorUrlSource=false: cache/index rows — nothing guarantees the URL
  //   filter was applied, so check every client-checkable filter. Color is
  //   never client-checkable (site rows carry no colors); it is handled by
  //   never serving color searches from cache (see search_sites).
  // skipQueryCheck=true: the rows already matched the free-text query through
  // FTS (prefix+stem semantics); re-checking with substring semantics would
  // wrongly drop stem matches ("magazines" → "Magazine"), so only the
  // non-query filters run. Scraped rows keep the check (default false) — they
  // never came from FTS.
  function matchesFilters(
    s: SiteSummary,
    f: SearchArgs,
    honorUrlSource: boolean,
    skipQueryCheck = false,
  ): boolean {
    const source = urlSource(f);
    if (f.tags?.length) {
      const tagsToCheck =
        honorUrlSource && source === "tag" ? f.tags.slice(1) : f.tags;
      for (const t of tagsToCheck) {
        const slug = t.toLowerCase();
        if (!s.tags.some((st) => slugifyTag(st).includes(slug))) return false;
      }
    }
    if (f.technology && !(honorUrlSource && source === "technology")) {
      const slug = f.technology.toLowerCase();
      if (!s.tags.some((st) => slugifyTag(st).includes(slug))) return false;
    }
    if (f.award && !(honorUrlSource && source === "award")) {
      if (!s.awards.includes(AWARD_FILTER_LABELS[f.award])) return false;
    }
    if (f.query && !skipQueryCheck) {
      const queryTokens = tokenizeQuery(f.query);
      if (queryTokens.length) {
        const hay = (s.title + " " + s.tags.join(" ")).toLowerCase();
        if (!queryTokens.every((t) => hay.includes(t))) return false;
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

  // sortBy: "score" view. Scores live in detail-meta entries written by
  // get_site_details, so this reads the cache only — never a live fetch during
  // search. SiteDetails gains its score field in a later v1.5.0 task, so the
  // meta read is typed locally. Scored sites come first (desc); unscored ones
  // follow, newest-first.
  function orderByScore(list: SiteSummary[], sortBy: SearchArgs["sortBy"]): SiteSummary[] {
    if (sortBy !== "score") return list;
    const withScores = list.map((s) => ({
      s,
      score: cache.getMeta<{ score?: number }>(`detail:${s.slug}`, SITE_TTL_MS)?.score ?? null,
    }));
    withScores.sort(
      (a, b) => (b.score ?? -1) - (a.score ?? -1) || b.s.createdAt - a.s.createdAt,
    );
    return withScores.map((w) => w.s);
  }

  async function search_sites(args: SearchArgs): Promise<ToolResponse> {
    const count = Math.min(Math.max(args.count ?? 6, 1), 12);
    const page = Math.max(args.page ?? 1, 1);
    try {
      // Color can't be verified client-side (site rows carry no colors), so a
      // color search always scrapes its filter page; everything else is
      // client-checkable against the index.
      let sites: SiteSummary[];
      let ftsRows = false; // query served from FTS-ranked rows (bm25 order)
      let ftsEmpty = false; // FTS ran and matched nothing → loose hints apply
      if (args.color) {
        sites = [];
      } else if (args.query) {
        const ranked = cache.searchSites(args.query, SITE_TTL_MS);
        if (ranked) {
          ftsRows = true;
          ftsEmpty = ranked.length === 0;
          // FTS already applied the query (prefix+stem, bm25-ranked). Re-check
          // only the non-query filters; re-checking the query here with
          // substring semantics would wrongly drop prefix/stem matches.
          // Array.filter preserves the bm25 order.
          sites = ranked.filter((s) => matchesFilters(s, args, false, true));
        } else {
          // FTS5 unavailable or no usable tokens: legacy substring path.
          sites = cache.getSites(SITE_TTL_MS).filter((s) => matchesFilters(s, args, false));
        }
      } else {
        sites = cache.getSites(SITE_TTL_MS).filter((s) => matchesFilters(s, args, false));
      }
      // A scrape normally REPLACES the matched rows (fresh rows are only
      // guaranteed the URL filter), so it must run when the cache cannot serve
      // the requested page window at all. When the window is only PARTIALLY
      // filled (e.g. a query matched 3 cached rows for count 6), replacing
      // would discard already-verified matches — those runs scrape the filter
      // page and MERGE instead: dedupe by slug, verified cache rows win
      // duplicate slugs, scraped-only rows appended; the merge result is
      // client-checked as before (cache rows already passed matchesFilters,
      // scraped rows matchesFilters(true)). Non-FTS runs sort everything
      // newest-first like getSites; FTS runs keep the bm25-ranked cache rows
      // first in rank order and append the scraped-only rows newest-first
      // among themselves — re-sorting ranked rows by createdAt would destroy
      // the ranking the query asked for.
      const pageWindowEmpty = sites.slice((page - 1) * count, page * count).length === 0;
      const pageWindowPartial = !pageWindowEmpty && sites.length < page * count;
      if (pageWindowEmpty) {
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
        // Freshly parsed rows carry the URL filter by construction
        // (honorUrlSource: true); serve only those, newest-first like getSites.
        sites = parsed
          .filter((s) => matchesFilters(s, args, true))
          .sort((a, b) => b.createdAt - a.createdAt);
      } else if (pageWindowPartial) {
        // Top-up scrape: best-effort in the fullest sense — a fetch failure
        // (HTTP error, BlockedError) must not escape to the outer catch, whose
        // stale-fallback always slices page 1 and would silently discard the
        // requested page window's cached rows. Keep those rows instead.
        try {
          const html = await client.getHtml(buildFilterUrl(args));
          const parsed = parseListing(html);
          if (parsed.length > 0) {
            cache.upsertSites(parsed);
            const fresh = parsed.filter((s) => matchesFilters(s, args, true));
            if (ftsRows) {
              // Ranked cache rows keep their bm25 order; scraped-only rows
              // append newest-first (cache rows win duplicate slugs, as
              // everywhere — a slug in the ranked set is never re-added).
              const rankedSlugs = new Set(sites.map((s) => s.slug));
              const scrapedOnly = fresh
                .filter((s) => !rankedSlugs.has(s.slug))
                .sort((a, b) => b.createdAt - a.createdAt);
              sites = [...sites, ...scrapedOnly];
            } else {
              const bySlug = new Map<string, SiteSummary>();
              // Scraped rows seed the map; verified cache rows then overwrite any
              // duplicate slug, so they always win.
              for (const s of fresh) bySlug.set(s.slug, s);
              for (const s of sites) bySlug.set(s.slug, s);
              sites = [...bySlug.values()].sort((a, b) => b.createdAt - a.createdAt);
            }
          }
        } catch {
          /* keep cached rows; an empty parse is equally tolerated above */
        }
      }

      const ordered = orderByScore(sites, args.sortBy);
      const slice = ordered.slice((page - 1) * count, page * count);
      if (slice.length === 0) {
        // Loose-match hint, computed once: only for genuine FTS zero results
        // (FTS ran and matched nothing) — rows dropped by the non-query
        // filters are not "loose matches". Up to 3 OR-relaxed slugs.
        let looseHint = "";
        if (ftsEmpty && args.query) {
          const orSlugs = (cache.searchSites(args.query, SITE_TTL_MS, 3, "OR") ?? [])
            .map((s) => s.slug);
          if (orSlugs.length > 0) {
            looseHint = `\nLoose matches (any token): ${orSlugs.join(", ")}.`;
          }
        }
        if (sites.length === 0) {
          // True zero-result search: suggest the closest taxonomy tags. The
          // taxonomy comes from the cache only — never a live fetch just to
          // phrase a suggestion; without a cached taxonomy, keep today's text.
          const cats = cache.getMeta<Categories>("categories", CATEGORY_TTL_MS);
          const suggestions = cats
            ? suggestTags(tokenizeQuery(args.query ?? ""), cats.filters)
            : [];
          if (suggestions.length > 0) {
            return {
              content: [
                text(
                  `No sites matched the search. Closest filter tags: ${suggestions.join(", ")}. ` +
                    `Run list_categories for the full taxonomy.${looseHint}`,
                ),
              ],
            };
          }
        }
        return {
          content: [
            text(
              `No sites matched the search on this page. Try fewer filters or run list_categories. ` +
                "(Deep pagination is unavailable by design: awwwards.com's robots.txt disallows it.)" +
                // looseHint is empty unless this is a true FTS zero result.
                looseHint,
            ),
          ],
        };
      }

      const images = await Promise.all(slice.map(siteImage));
      const content: Block[] = [
        text(
          `${ordered.length} site(s) matched; showing ${(page - 1) * count + 1}-${(page - 1) * count + slice.length}:\n\n` +
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
        stale = cache.getSites(Infinity).filter((s) => matchesFilters(s, args, false));
      } catch {
        stale = [];
      }
      if (stale.length > 0) {
        const orderedStale = orderByScore(stale, args.sortBy);
        const slice = orderedStale.slice(0, count);
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
        const html = await client.getHtml(`/sites/${args.slug}`);
        d = parseDetail(html, args.slug);
        if (isAllEmptyDetail(d)) {
          return {
            content: [
              text(
                "Awwwards layout may have changed: parsed no design data for " +
                  args.slug +
                  ". The awwwards-mcp parser likely needs an update (or the site page was not found).",
              ),
            ],
            isError: true,
          };
        }
        cache.setMeta(metaKey, d);
        // One fetch feeds both caches: seed the elements cache from the same
        // HTML. Null (no section) caches as a legitimate empty; a zero-blob
        // parse is left uncached for get_site_elements to surface as a mismatch.
        if (cache.getMeta<ElementMedia[]>(`elements:${args.slug}`, SITE_TTL_MS) === null) {
          const els = parseElements(html);
          if (els === null) cache.setMeta(`elements:${args.slug}`, []);
          else if (els.length > 0) cache.setMeta(`elements:${args.slug}`, els);
        }
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
            d.score != null ? `Jury score: ${d.score.toFixed(2)}/10` : null,
            d.juryDimensions
              ? `Jury dimensions: Design ${d.juryDimensions.design.toFixed(2)}, Usability ${d.juryDimensions.usability.toFixed(2)}, Creativity ${d.juryDimensions.creativity.toFixed(2)}, Content ${d.juryDimensions.content.toFixed(2)}`
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

  async function get_site_elements(args: { slug: string }): Promise<ToolResponse> {
    try {
      const elementsKey = `elements:${args.slug}`;
      let elements = cache.getMeta<ElementMedia[]>(elementsKey, SITE_TTL_MS);
      if (elements === null) {
        const html = await client.getHtml(`/sites/${args.slug}`);
        const parsed = parseElements(html);
        if (parsed === null) {
          elements = [];
          cache.setMeta(elementsKey, elements);
        } else if (parsed.length === 0) {
          return {
            content: [
              text(
                "Awwwards layout may have changed: found an Elements section but parsed 0 elements. " +
                  "The awwwards-mcp parser likely needs an update.",
              ),
            ],
            isError: true,
          };
        } else {
          elements = parsed;
          cache.setMeta(elementsKey, elements);
        }
        // One fetch feeds both caches: seed the detail cache from the same
        // HTML unless it is an all-empty parse (never cached, per contract).
        if (cache.getMeta<SiteDetails>(`detail:${args.slug}`, SITE_TTL_MS) === null) {
          const d = parseDetail(html, args.slug);
          if (!isAllEmptyDetail(d)) cache.setMeta(`detail:${args.slug}`, d);
        }
      }
      const cachedSite = cache.getSite(args.slug, SITE_TTL_MS);
      const title =
        cache.getMeta<SiteDetails>(`detail:${args.slug}`, SITE_TTL_MS)?.title ??
        cachedSite?.title ??
        args.slug;
      if (elements.length === 0) {
        return { content: [text(`No design elements listed for ${title} (${args.slug}).`)] };
      }
      const shown = elements.slice(0, MAX_INLINE_POSTERS);
      const lines = elements.map((el, i) => {
        const isVideo = el.mediaPath.endsWith(".mp4");
        return `${i + 1}. ${el.title} (${isVideo ? "video" : "image"})` +
          (isVideo ? ` — ${elementUrl(el.mediaPath)}` : "");
      });
      const posters = await Promise.all(
        shown.map(async (el): Promise<Block | null> => {
          try {
            const poster = elementPosterPath(el.mediaPath);
            const buf = await cache.getImage(poster, () => client.getAsset(poster));
            return { type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" };
          } catch {
            return null; // poster failures degrade to text-only listings
          }
        }),
      );
      return {
        content: [
          text(`${title}: ${elements.length} design element(s):\n\n${lines.join("\n")}`),
          ...posters.filter((b): b is Block => b !== null),
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }

  async function list_categories(): Promise<ToolResponse> {
    try {
      let cats = cache.getMeta<Categories>("categories", CATEGORY_TTL_MS);
      if (!cats) {
        cats = parseCategories(await client.getHtml("/websites/"));
        if (cats.colors.length === 0 && cats.filters.length === 0) {
          return {
            content: [
              text(
                "Awwwards layout may have changed: parsed 0 categories. " +
                  "The awwwards-mcp parser likely needs an update.",
              ),
            ],
            isError: true,
          };
        }
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

  async function capture_live_site(args: {
    url: string;
    waitStrategy?: WaitStrategy;
    viewport?: ViewportName;
  }): Promise<ToolResponse> {
    try {
      // Lazy default: playwright is only touched when the tool actually runs.
      // The default is wrapped because captureLiveSite's third positional is
      // the injectable playwright loader — opts must land in fourth place.
      const capture =
        deps.captureFn ??
        ((url: string, imagesDir: string, opts?: WaitOpts) =>
          import("./capture.js").then((m) => m.captureLiveSite(url, imagesDir, undefined, opts)));
      // The tool schema defaults viewport to "desktop" (zod); the ?? keeps
      // direct handler calls on the same explicit path.
      const result = await capture(args.url, cache.imagesDir, {
        waitStrategy: args.waitStrategy,
        viewport: args.viewport ?? "desktop",
      });
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

  async function analyze_page_structure(args: {
    url: string;
    maxBands?: number;
    waitStrategy?: WaitStrategy;
    viewport?: ViewportName;
  }): Promise<ToolResponse> {
    try {
      // Lazy default: playwright is only touched when the tool actually runs.
      // maxBands from the tool schema is forwarded so the analyzer honors the
      // caller's cap (falling back to the analyzer's own default of 40).
      const analyze =
        deps.analyzeFn ??
        ((url: string, maxBands?: number, opts?: WaitOpts) =>
          import("./structure.js").then((m) =>
            m.analyzePageStructure(url, undefined, maxBands, opts),
          ));
      const structure = await analyze(args.url, args.maxBands, {
        waitStrategy: args.waitStrategy,
        viewport: args.viewport ?? "desktop",
      });
      if ("error" in structure) return { content: [text(structure.error)], isError: true };
      return { content: [text(JSON.stringify(structure, null, 1))] };
    } catch (err) {
      return errorResponse(err);
    }
  }

  async function record_site_motion(args: {
    url: string;
    frames?: number;
    waitStrategy?: WaitStrategy;
    viewport?: ViewportName;
  }): Promise<ToolResponse> {
    try {
      // Lazy default: playwright/ffmpeg are only touched when the tool runs.
      // The default forwards motionOpts wholesale, so waitStrategy and viewport
      // flow into recordSiteMotion's MotionOpts (which already accepts both).
      const motion =
        deps.motionFn ??
        ((
          url: string,
          motionOpts: {
            cacheImagesDir: string;
            frames?: number;
            waitStrategy?: WaitStrategy;
            viewport?: ViewportName;
          },
        ) => import("./motion.js").then((m) => m.recordSiteMotion(url, motionOpts)));
      const result = await motion(args.url, {
        cacheImagesDir: cache.imagesDir,
        frames: args.frames,
        waitStrategy: args.waitStrategy,
        viewport: args.viewport ?? "desktop",
      });
      if ("error" in result) return { content: [text(result.error)], isError: true };
      return {
        content: [
          text(`Motion recording saved to ${result.file}`),
          { type: "image", data: result.base64, mimeType: "image/jpeg" },
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }

  return {
    search_sites,
    get_site_details,
    get_site_elements,
    list_categories,
    capture_live_site,
    analyze_page_structure,
    record_site_motion,
  };
}
