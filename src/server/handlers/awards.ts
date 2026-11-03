import { AWARD_FILTERS, buildFilterUrl, elementPosterPath, elementUrl } from "../../awwwards.js";
import type { AwardFilter } from "../../awwwards.js";
import { createDesignBrief, renderDesignBrief } from "../../design-brief.js";
import type { DesignBriefInput, DesignBriefSource } from "../../design-brief.js";
import { parseCategories, parseDetail, parseElements, parseListing } from "../../parsers.js";
import type { WaitOpts } from "../../structure.js";
import type { Categories, ElementMedia, ElementRecord, SiteDetails, SiteSummary } from "../../types.js";
import type { ViewportName } from "../../viewport.js";
import { isAllEmptyDetail, urlFilterNeedsPageMembership } from "../context.js";
import type { HandlerContext } from "../context.js";
import {
  AWARD_FILTER_LABELS,
  CATEGORY_TTL_MS,
  MAX_INLINE_POSTERS,
  SITE_TTL_MS,
  TAXONOMY_RETRY_MS,
  compactSiteDetails,
  errorResponse,
  suggestTags,
  summarizeSite,
  text,
  tokenizeQuery,
} from "../types.js";
import type { Block, SearchArgs, ToolResponse } from "../types.js";
import type { WaitStrategy } from "../../structure.js";

// One in-flight taxonomy refresh per cache: concurrent reads share the fetch
// instead of each starting one before the retry marker exists.
const taxonomyRefreshes = new WeakMap<
  object,
  Promise<{ refreshed: Categories | null; reason: string }>
>();

async function refreshLegacyTaxonomy(
  ctx: HandlerContext,
): Promise<{ refreshed: Categories | null; reason: string }> {
  try {
    const parsed = parseCategories(await ctx.client.getHtml("/websites/"));
    if (parsed.filters.length === 0 || parsed.colors.length === 0) {
      return { refreshed: null, reason: "the refreshed page parsed 0 categories (layout drift)" };
    }
    if (!Array.isArray(parsed.technologies) || parsed.technologies.length === 0) {
      return {
        refreshed: null,
        reason: "the refreshed page parsed no technology navigation (layout drift)",
      };
    }
    return { refreshed: parsed, reason: "" };
  } catch (err) {
    return { refreshed: null, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function search_sites(ctx: HandlerContext, args: SearchArgs): Promise<ToolResponse> {
  const count = Math.min(Math.max(args.count ?? 6, 1), 12);
  const page = Math.max(args.page ?? 1, 1);
  try {
    // Color can't be verified client-side (site rows carry no colors), so a
    // color search always scrapes its filter page; everything else is
    // client-checkable against the index.
    let sites: SiteSummary[];
    let ftsEmpty = false; // FTS ran and matched nothing → loose hints apply
    if (args.color) {
      sites = [];
    } else if (args.query) {
      const ranked = ctx.cache.searchSites(args.query, SITE_TTL_MS);
      if (ranked) {
        ftsEmpty = ranked.length === 0;
        // FTS already applied the query (prefix+stem, bm25-ranked). Re-check
        // only the non-query filters; re-checking the query here with
        // substring semantics would wrongly drop prefix/stem matches.
        // Array.filter preserves the bm25 order.
        sites = ranked.filter((s) => ctx.matchesFilters(s, args, false, true));
      } else {
        // FTS5 unavailable or no usable tokens: legacy substring path (the
        // documented fallback; only this path re-checks the query text).
        sites = ctx.cache.getSites(SITE_TTL_MS).filter((s) => ctx.matchesFilters(s, args, false));
      }
    } else {
      sites = ctx.cache.getSites(SITE_TTL_MS).filter((s) => ctx.matchesFilters(s, args, false));
    }
    // URL filters whose membership no site row can prove (color, winner
    // categories) are pinned to the fetched filter page; every other filter
    // is re-checked from the row itself.
    const pageBound = urlFilterNeedsPageMembership(args);
    // A scrape can only prove membership for rows it returned, so freshly
    // parsed rows must not be judged by substring semantics: after upsertSites
    // re-run the same FTS query the warm path uses over the full fresh cache.
    // Returns null when FTS is unavailable — callers keep the substring
    // fallback documented above.
    const requeryFreshCache = (fetched: SiteSummary[]): SiteSummary[] | null => {
      if (!args.query) return null;
      const ranked = ctx.cache.searchSites(args.query, SITE_TTL_MS);
      if (ranked === null) return null;
      const fetchedSlugs = pageBound ? new Set(fetched.map((s) => s.slug)) : null;
      // pageBound rows skip the URL filter they cannot verify (honorUrlSource)
      // and never include cached rows from another page; everything else is
      // client-checked, including the URL filter.
      return ranked.filter(
        (s) =>
          (fetchedSlugs === null || fetchedSlugs.has(s.slug)) &&
          ctx.matchesFilters(s, args, fetchedSlugs !== null, true),
      );
    };
    // A scrape replaces the matched rows when the requested page window is
    // empty, because the cache cannot serve that window at all. A PARTIALLY
    // filled window gets a best-effort top-up instead. Both successful paths
    // re-run the query over the full fresh cache, so freshly parsed rows are
    // judged by the same FTS semantics a warm query uses; the fallback below
    // is the documented substring path for builds without FTS5.
    const pageWindowEmpty = sites.slice((page - 1) * count, page * count).length === 0;
    const pageWindowPartial = !pageWindowEmpty && sites.length < page * count;
    if (pageWindowEmpty) {
      const html = await ctx.client.getHtml(buildFilterUrl(args));
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
      // Nominees-listing rows are flagged (and the flag persisted) — their
      // cards carry no award tags, so this is the only marker they get.
      if (args.award === "nominees") for (const s of parsed) s.nominee = true;
      ctx.cache.upsertSites(parsed);
      sites = requeryFreshCache(parsed) ??
        // Substring fallback: fresh rows carry the URL filter by construction
        // (honorUrlSource: true); serve only those, newest-first like getSites.
        parsed
          .filter((s) => ctx.matchesFilters(s, args, true))
          .sort((a, b) => b.createdAt - a.createdAt);
    } else if (pageWindowPartial) {
      // Top-up scrape: best-effort in the fullest sense — a fetch failure
      // (HTTP error, BlockedError) must not escape to the outer catch, whose
      // stale-fallback always slices page 1 and would silently discard the
      // requested page window's cached rows. Keep those rows instead.
      try {
        const html = await ctx.client.getHtml(buildFilterUrl(args));
        const parsed = parseListing(html);
        if (parsed.length > 0) {
          if (args.award === "nominees") for (const s of parsed) s.nominee = true;
          ctx.cache.upsertSites(parsed);
          const reranked = requeryFreshCache(parsed);
          if (reranked) {
            // bm25 order over the full fresh cache: cached rows that still
            // match keep their rank, freshly fetched rows join the ranking.
            sites = reranked;
          } else {
            const fresh = parsed.filter((s) => ctx.matchesFilters(s, args, true));
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

    const ordered = ctx.orderByScore(sites, args.sortBy);
    const slice = ordered.slice((page - 1) * count, page * count);
    if (slice.length === 0) {
      // Loose-match hint, computed once: only for genuine FTS zero results
      // (FTS ran and matched nothing) — rows dropped by the non-query
      // filters are not "loose matches". Up to 3 OR-relaxed slugs.
      let looseHint = "";
      if (ftsEmpty && args.query) {
        const orSlugs = (ctx.cache.searchSites(args.query, SITE_TTL_MS, 3, "OR") ?? [])
          .map((s) => s.slug);
        if (orSlugs.length > 0) {
          looseHint = `\nLoose matches (any token): ${orSlugs.join(", ")}.`;
        }
      }
      if (sites.length === 0) {
        // True zero-result search: suggest the closest taxonomy tags. The
        // taxonomy comes from the cache only — never a live fetch just to
        // phrase a suggestion; without a cached taxonomy, keep today's text.
        const cats = ctx.cache.getMeta<Categories>("categories", CATEGORY_TTL_MS);
        const suggestions = cats
          ? suggestTags(tokenizeQuery(args.query ?? ""), cats.filters)
          : [];
        if (suggestions.length > 0) {
          return {
            content: [
              text(
                `No sites matched the search. Closest filter tags: ${suggestions.join(", ")}. ` +
                  `Run the taxonomy tool for the full filter list.${looseHint}`,
              ),
            ],
          };
        }
      }
      return {
        content: [
          text(
            `No sites matched the search on this page. Try fewer filters or fetch the taxonomy first. ` +
              "(Deep pagination is unavailable by design: awwwards.com's robots.txt disallows it.)" +
              // looseHint is empty unless this is a true FTS zero result.
              looseHint,
          ),
        ],
      };
    }

    if (args.responseMode === "compact") {
      const start = (page - 1) * count + 1;
      return { content: await ctx.compactContent(
        slice,
        start,
        `${ordered.length} site(s) matched; showing ${start}-${start + slice.length - 1}:`,
      ) };
    }

    const images = await Promise.all(slice.map(ctx.siteImage));
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
      stale = ctx.cache.getSites(Infinity).filter((s) => ctx.matchesFilters(s, args, false));
    } catch {
      stale = [];
    }
    if (stale.length > 0) {
      const orderedStale = ctx.orderByScore(stale, args.sortBy);
      const slice = orderedStale.slice(0, count);
      if (args.responseMode === "compact") {
        const message = `The live awwwards.com request failed (${err instanceof Error ? err.message : String(err)}). ` +
          `Serving ${slice.length} result(s) from stale cache instead:`;
        return { content: await ctx.compactContent(slice, 1, message) };
      }
      const images = await Promise.all(slice.map(ctx.siteImage));
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

// ---- C3 token-diet helpers ----
// Pure compaction for the four tools' `compact` flag (plan Task C3). Heavy
// per-element detail → counts; top-level numerics and triggers stay. The
// helpers (compactComponentPack / compactSiteDetails) live at module scope
// so tests can call them directly; census-typed siblings live in
// verify-build.ts (census.ts/hover-census.ts are out of this wave's scope).

export async function get_site_details(ctx: HandlerContext, args: {
  slug?: string;
  slugs?: string[];
  compact?: boolean;
}): Promise<ToolResponse> {
  const hasSlug = args.slug !== undefined;
  const hasSlugs = args.slugs !== undefined;
  if (hasSlug === hasSlugs) {
    return { content: [text("Provide exactly one of slug or slugs.")], isError: true };
  }
  const slugs = hasSlug ? [args.slug!] : args.slugs!;
  if (
    !Array.isArray(slugs) || slugs.length < 1 || slugs.length > 10 ||
    slugs.some((slug) => typeof slug !== "string" || !/^[\w-]+$/.test(slug)) ||
    new Set(slugs.map((slug) => slug.toLowerCase())).size !== slugs.length
  ) {
    return {
      content: [text(
        "Provide 1 to 10 distinct valid site slugs (letters, digits, underscores or hyphens only).",
      )],
      isError: true,
    };
  }
  try {
    if (args.slugs !== undefined) {
      const results = await ctx.loadDetails(slugs);
      const summary = {
        requested: slugs.length,
        fetched: results.filter((r) => r.status === "fetched").length,
        cached: results.filter((r) => r.status === "cached").length,
        failed: results.filter((r) => r.status === "error").length,
        skipped: results.filter((r) => r.status === "skipped").length,
      };
      const blocked = results.some((r) => r.status === "error" && r.blocked === true);
      // Partial failure is a normal response; only a batch with no usable
      // entry at all is an error.
      const anyOk = summary.fetched + summary.cached > 0;
      return {
        content: [text(JSON.stringify(
          { results, summary, ...(blocked ? { blocked: true } : {}) },
          null,
          1,
        ))],
        ...(anyOk ? {} : { isError: true }),
      };
    }

    const slug = slugs[0]!;
    const d = await ctx.loadDetail(slug);
    if (!d) {
      return {
        content: [text(ctx.detailDriftMessage(slug))],
        isError: true,
      };
    }
    // C3: compact=true returns the token-diet JSON (lists → counts, no
    // markdown body, no inline screenshot); default stays byte-identical.
    if (args.compact) {
      return { content: [text(JSON.stringify(compactSiteDetails(d), null, 1))] };
    }
    const cachedSite = ctx.cache.getSite(slug, SITE_TTL_MS);
    const liveUrl = d.liveUrl ?? cachedSite?.liveUrl ?? null;

    const content: Block[] = [
      text(
        [
          `# ${d.title ?? slug}`,
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
          d.nominee
            ? `Status: Nominee - awwwards.com publishes no jury score, color palette or technologies for nominees.`
            : null,
          d.ogImage ? `Full-size screenshot: ${d.ogImage}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    ];
    if (cachedSite) {
      const img = await ctx.siteImage(cachedSite);
      if (img) content.push(img);
    }
    return { content };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function compare_sites(ctx: HandlerContext, args: { slugs: string[] }): Promise<ToolResponse> {
  try {
    const slugs = args.slugs;
    if (!Array.isArray(slugs) || slugs.length < 2 || slugs.length > 3 ||
        slugs.some((slug) => typeof slug !== "string" || !/^[\w-]+$/.test(slug)) ||
        new Set(slugs.map((slug) => slug.toLowerCase())).size !== slugs.length) {
      return { content: [text("Provide 2 or 3 distinct site slugs (letters, digits, underscores or hyphens only).")], isError: true };
    }

    const sites = [];
    for (const slug of slugs) {
      const detail = await ctx.loadDetail(slug);
      if (!detail) {
        return { content: [text(ctx.detailDriftMessage(slug))], isError: true };
      }
      const summary = ctx.cache.getSite(slug, SITE_TTL_MS);
      sites.push({
        slug,
        title: detail.title ?? summary?.title ?? slug,
        liveUrl: detail.liveUrl ?? summary?.liveUrl ?? null,
        palette: detail.palette,
        technologies: detail.technologies,
        elements: detail.elements,
        awards: detail.awards.length ? detail.awards : (summary?.awards ?? []).map((title) => ({ title, date: "" })),
        score: detail.score,
        juryDimensions: detail.juryDimensions ?? null,
        nominee: detail.nominee,
      });
    }
    return { content: [text(JSON.stringify({ sites }, null, 2))] };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function create_design_brief(ctx: HandlerContext, args: DesignBriefInput & {
  viewport?: ViewportName;
  waitStrategy?: WaitStrategy;
  maxBands?: number;
}): Promise<ToolResponse> {
  if (!Array.isArray(args.slugs) || args.slugs.length < 2 || args.slugs.length > 5 ||
      args.slugs.some((slug) => typeof slug !== "string" || !/^[\w-]+$/.test(slug)) ||
      new Set(args.slugs.map((slug) => slug.toLowerCase())).size !== args.slugs.length ||
      typeof args.goal !== "string" || args.goal.trim().length === 0) {
    return { content: [text("Provide 2 to 5 distinct valid site slugs and a non-blank goal.")], isError: true };
  }
  try {
    const sources: DesignBriefSource[] = [];
    for (const slug of args.slugs) {
      let detail = ctx.cache.getMeta<SiteDetails>(`detail:${slug}`, SITE_TTL_MS);
      let detailStatus: DesignBriefSource["detailStatus"] = detail ? "cached" : "unavailable";
      if (!detail) {
        try {
          detail = await ctx.loadDetail(slug);
          if (detail) detailStatus = "fetched";
        } catch {
          detail = null;
        }
      }
      const summary = ctx.cache.getSite(slug, SITE_TTL_MS);
      const liveUrl = detail?.liveUrl ?? summary?.liveUrl ?? null;
      const source: DesignBriefSource = {
        slug,
        title: detail?.title ?? summary?.title ?? slug,
        detail,
        detailStatus: detail ? detailStatus : "unavailable",
        motion: liveUrl ? ctx.cache.getMotionDna(liveUrl) : null,
        structure: null,
        structureStatus: args.includeStructure === true ? "unavailable" : "not_requested",
      };
      sources.push(source);
    }

    if (!sources.some((source) => source.detail !== null)) {
      return {
        content: [text("No usable design evidence was available for the requested references. Check the slugs or try again after Awwwards access recovers.")],
        isError: true,
      };
    }

    if (args.includeStructure === true) {
      const analyze = ctx.deps.analyzeFn ?? ((url: string, maxBands?: number, opts?: WaitOpts) =>
        import("../../structure.js").then((m) => m.analyzePageStructure(url, undefined, maxBands, opts))
      );
      await Promise.all(sources.map(async (source) => {
        const liveUrl = source.detail?.liveUrl ?? ctx.cache.getSite(source.slug, SITE_TTL_MS)?.liveUrl ?? null;
        if (!liveUrl) return;
        try {
          const result = await analyze(liveUrl, args.maxBands ?? 12, {
            waitStrategy: args.waitStrategy,
            viewport: args.viewport ?? "desktop",
          });
          if (!("error" in result)) {
            source.structure = result;
            source.structureStatus = "captured";
          }
        } catch {
          source.structureStatus = "unavailable";
        }
      }));
    }

    const brief = createDesignBrief(args, sources);
    return { content: [text(renderDesignBrief(brief))] };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function get_site_elements(ctx: HandlerContext, args: { slug: string }): Promise<ToolResponse> {
  try {
    const elementsKey = `elements:${args.slug}`;
    let elements = ctx.cache.getMeta<ElementMedia[]>(elementsKey, SITE_TTL_MS);
    if (elements === null) {
      const html = await ctx.client.getHtml(`/sites/${args.slug}`);
      const parsed = parseElements(html);
      if (parsed === null) {
        elements = [];
        ctx.cache.setMeta(elementsKey, elements);
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
        ctx.cache.setMeta(elementsKey, elements);
      }
      // One fetch feeds both caches: seed the detail cache from the same
      // HTML unless it is an all-empty parse (never cached, per contract).
      if (ctx.cache.getMeta<SiteDetails>(`detail:${args.slug}`, SITE_TTL_MS) === null) {
        const d = parseDetail(html, args.slug);
        if (!isAllEmptyDetail(d) || d.nominee) ctx.cache.setMeta(`detail:${args.slug}`, d);
      }
    }
    const cachedSite = ctx.cache.getSite(args.slug, SITE_TTL_MS);
    const title =
      ctx.cache.getMeta<SiteDetails>(`detail:${args.slug}`, SITE_TTL_MS)?.title ??
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
          const buf = await ctx.cache.getImage(poster, () => ctx.client.getAsset(poster));
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

// Task 5 read-time pairing: rows crawled before the attribution href was
// parsed carry siteSlug = null, so fall back to matching the element author
// against site titles (exact, case-insensitive; matched ~74% of the live
// corpus at 2026-09-28). Author names are not unique across sites, so the
// fallback only fills when exactly one site row has that title.
function resolveSiteSlug(ctx: HandlerContext, r: ElementRecord): string | null {
  if (r.siteSlug) return r.siteSlug;
  if (!r.author) return null;
  const titleMatches = ctx.cache.getSites(Infinity)
    .filter((s) => s.title.trim().toLowerCase() === r.author.trim().toLowerCase());
  return titleMatches.length === 1 ? titleMatches[0].slug : null;
}

// Compact payload per hit. mediaPath is coalesced to "" by rowToElement; an
// empty path would yield a garbage "assets.awwwards.com/awards/" URL, so
// mediaUrl/posterUrl render as null instead.
function compactElement(ctx: HandlerContext, r: ElementRecord) {
  return {
    slug: r.slug,
    title: r.title,
    category: r.category,
    author: r.author,
    mediaUrl: r.mediaPath ? elementUrl(r.mediaPath) : null,
    posterUrl: r.mediaPath ? elementUrl(elementPosterPath(r.mediaPath)) : null,
    source: r.source,
    projectId: r.projectId,
    siteSlug: resolveSiteSlug(ctx, r),
    siteUrl: (() => {
      const s = resolveSiteSlug(ctx, r);
      return s ? `https://www.awwwards.com/sites/${s}/` : null;
    })(),
  };
}

export async function search_elements(ctx: HandlerContext, args: {
  query?: string; category?: string; stack?: string[]; limit?: number;
}): Promise<ToolResponse> {
  try {
    // Gallery crawl retired: robots.txt disallows /elements/*. An empty corpus
    // is reported as-is; new_winners backfills from winners' own site pages.
    // countElements() counts gallery rows only, so an empty list means the
    // whole corpus (gallery + site records) is empty.
    if (ctx.cache.listElements(1).length === 0) {
      return {
        content: [
          text(
            JSON.stringify(
              {
                count: 0,
                results: [],
                note: "Element corpus is empty. The Awwwards gallery crawl is retired for robots.txt compliance; elements are indexed from new SOTD winners' own Elements sections by the winners poll after it has seeded its baseline. Cached gallery records remain searchable if present.",
              },
              null,
              1,
            ),
          ),
        ],
      };
    }
    // Tokens exist but no query → no FTS call at all (searchElements with an
    // empty MATCH string would error). No-query searches list recent rows.
    const ftsQuery = args.query
      ? tokenizeQuery(args.query).map((t) => `"${t}"*`).join(" ")
      : null;
    const rows = ftsQuery
      ? ctx.cache.searchElements(ftsQuery, 100)
      : ctx.cache.listElements(200);

    const stackWords = (args.stack ?? []).map((s) => s.toLowerCase());
    const hits = rows
      .filter((r) => (args.category ? r.cid === args.category : true))
      .filter((r) => {
        if (stackWords.length === 0) return true;
        const hay = r.builtWith.map((b) => b.toLowerCase()).join(" ");
        return stackWords.every((w) => hay.includes(w));
      })
      .slice(0, args.limit ?? 8)
      .map((r) => compactElement(ctx, r));
    return { content: [text(JSON.stringify({ count: hits.length, results: hits }, null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function get_element(ctx: HandlerContext, args: { id: string }): Promise<ToolResponse> {
  try {
    const [record] = ctx.cache.getElements([args.id]);
    if (!record) {
      return { content: [text(`Unknown element id: ${args.id}`)], isError: true };
    }
    // One batched lookup resolves every related slug's title.
    const bySlug = new Map(ctx.cache.getElements(record.related).map((r) => [r.slug, r]));
    const related = record.related.map((slug) => {
      const r = bySlug.get(slug);
      return { slug, title: r?.title ?? "" };
    });
    return { content: [text(JSON.stringify({ ...record, related }, null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function list_categories(ctx: HandlerContext): Promise<ToolResponse> {
  try {
    let cats = ctx.cache.getMeta<Categories>("categories", CATEGORY_TTL_MS);
    let taxonomyWarning: string | undefined;
    // Legacy taxonomies predate technology facets. Waiting out the 30-day TTL
    // would leave those slugs unavailable, so upgrade on read; the retry marker
    // keeps a failed refresh from firing on every later call.
    if (cats && !Array.isArray(cats.technologies)) {
      if (ctx.cache.getMeta<boolean>("categories:refresh-failed", TAXONOMY_RETRY_MS) === null) {
        let pending = taxonomyRefreshes.get(ctx.cache);
        if (!pending) {
          pending = refreshLegacyTaxonomy(ctx);
          taxonomyRefreshes.set(ctx.cache, pending);
          void pending.finally(() => taxonomyRefreshes.delete(ctx.cache));
        }
        const { refreshed, reason } = await pending;
        if (refreshed) {
          cats = refreshed;
          ctx.cache.setMeta("categories", refreshed);
          ctx.cache.deleteMeta("categories:refresh-failed");
        } else {
          ctx.cache.setMeta("categories:refresh-failed", true);
          taxonomyWarning =
            `Cached taxonomy is missing technology facets and the refresh failed (${reason}). ` +
            "Serving the cached filters, colors and awards; technology facets remain unavailable.";
        }
      } else {
        taxonomyWarning =
          "Cached taxonomy is missing technology facets; the last refresh failed and the next attempt is deferred. " +
          "Serving the cached filters, colors and awards; technology facets remain unavailable.";
      }
    }
    if (!cats) {
      cats = parseCategories(await ctx.client.getHtml("/websites/"));
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
      ctx.cache.setMeta("categories", cats);
    }
    const awards = (Object.keys(AWARD_FILTERS) as AwardFilter[]).map((filter) => ({
      filter,
      label: AWARD_FILTER_LABELS[filter],
    }));
    // Technology facets entered the taxonomy later; a cache written by an
    // older version has none (undefined) — report that instead of pretending
    // the list is complete. An empty list on a current crawl is different:
    // the Technology nav section wasn't found, which is crawl-time drift.
    const technologies = cats.technologies ?? [];
    const technologiesNote =
      cats.technologies === undefined
        ? "Technology facets were not crawled yet — these slugs are missing; re-crawl the taxonomy to fill them."
        : cats.technologies.length === 0
          ? "Technology section not found — crawl-time drift."
          : undefined;
    return {
      content: [
        text(
          JSON.stringify(
            {
              colorCount: cats.colors.length,
              colors: cats.colors,
              filterCount: cats.filters.length,
              filters: cats.filters,
              awards,
              technologies,
              ...(technologiesNote ? { technologiesNote } : {}),
              ...(taxonomyWarning ? { taxonomyStale: true, taxonomyWarning } : {}),
              usage:
                "Pass one of: color (hex), award (any filter from awards), technology or a tag slug to the site index. Fetch the taxonomy first when unsure of a slug. Combine at most one URL filter with client-side tags.",
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
