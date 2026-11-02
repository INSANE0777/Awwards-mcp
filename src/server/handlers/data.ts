import { fetchNewWinners, addWatch, listWatches, removeWatch, recordsFromSiteHtml, checkWatches, matchesWatch } from "../../feed.js";
import { INDEX_LOCK_STALE_MS, INDEX_STALE_MS } from "../../indexer.js";
import type { Categories, ElementRecord } from "../../types.js";
import type { HandlerContext } from "../context.js";
import {
  AWARD_FILTER_LABELS,
  SITE_TTL_MS,
  errorResponse,
  summarizeSite,
  text,
} from "../types.js";
import type { ToolResponse } from "../types.js";
import type { IndexStatsArgs } from "../../index-stats.js";
import type { DirectoryArgs } from "../../directory.js";

export async function get_index_status(ctx: HandlerContext): Promise<ToolResponse> {
  try {
    const status = ctx.cache.getMeta<{
      finishedAt?: number; pagesDone: number; pagesTotal: number; lastError?: string;
    }>("index:status", Number.POSITIVE_INFINITY);
    const progress = ctx.cache.getMeta<string[]>("index:progress", Number.POSITIVE_INFINITY);
    const lock = ctx.cache.getMeta<{ startedAt: number }>("index:lock", Number.POSITIVE_INFINITY);
    const now = Date.now();
    const finishedAt = status?.finishedAt ?? null;
    const lockAge = lock ? now - lock.startedAt : null;
    const indexAge = finishedAt === null ? null : Math.max(0, now - finishedAt);
    const active = lockAge !== null && lockAge < INDEX_LOCK_STALE_MS;
    const categoryTotal = ctx.cache.getMeta<Categories>("categories", Number.POSITIVE_INFINITY)?.filters.length;
    const body = {
      sitesCount: ctx.cache.countSites(),
      progress: {
        pagesDone: progress?.length ?? (active ? 0 : status?.pagesDone ?? 0),
        pagesTotal: active ? categoryTotal ?? status?.pagesTotal ?? 0 : status?.pagesTotal ?? categoryTotal ?? 0,
      },
      lastSuccessfulFinishAt: finishedAt,
      lastError: status?.lastError ?? null,
      lock: {
        startedAt: lock?.startedAt ?? null,
        active,
        stale: lockAge !== null && lockAge >= INDEX_LOCK_STALE_MS,
      },
      indexFreshness: {
        stale: indexAge === null || indexAge >= INDEX_STALE_MS,
        ageMs: indexAge,
        staleAfterMs: INDEX_STALE_MS,
      },
    };
    return { content: [text(JSON.stringify(body, null, 2))], structuredContent: body };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function get_index_stats(ctx: HandlerContext, args: IndexStatsArgs): Promise<ToolResponse> {
  try {
    // Local cache only: the module runs SQL over cache.db, never the network.
    const stats =
      ctx.deps.indexStatsFn ??
      ((a: IndexStatsArgs) => import("../../index-stats.js").then((m) => m.getIndexStats(a, { cache: ctx.cache })));
    const result = await stats(args);
    return {
      content: [text(JSON.stringify(result, null, 1))],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  } catch (err) {
    return errorResponse(err);
  }
}

// ---- official Annual Awards API ----
// Additive source: annual data comes only from the vendor-sanctioned API.
// There is deliberately no HTML-scraping fallback in these three tools.

export async function get_annual_categories(ctx: HandlerContext): Promise<ToolResponse> {
  try {
    const get =
      ctx.deps.annualCategoriesFn ??
      (() => import("../../annual.js").then((m) => m.getCategories({ cache: ctx.cache })));
    return { content: [text(JSON.stringify(await get(), null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function get_annual_nominees(ctx: HandlerContext, args: {
  category: string;
  limit?: number;
  offset?: number;
  hydrate?: boolean;
}): Promise<ToolResponse> {
  try {
    const get =
      ctx.deps.annualNomineesFn ??
      ((a: { category: string; limit?: number; offset?: number; hydrate?: boolean }) =>
        import("../../annual.js").then((m) => m.getNominees(a.category, a, { cache: ctx.cache })));
    return { content: [text(JSON.stringify(await get(args), null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function get_annual_nominee(ctx: HandlerContext, args: {
  id?: string;
  category?: string;
  slug?: string;
}): Promise<ToolResponse> {
  try {
    if (!args.id && !(args.category && args.slug)) {
      return {
        content: [
          text(
            "Provide either id (a UUID or a full /api/annual/nominees/... path) " +
              "or both category and slug.",
          ),
        ],
        isError: true,
      };
    }
    const get =
      ctx.deps.annualNomineeFn ??
      ((a: { id?: string; category?: string; slug?: string }) => {
        if (a.id) {
          return import("../../annual.js").then((m) => m.resolveNominee(a.id!, { cache: ctx.cache }));
        }
        return import("../../annual.js").then((m) =>
          m.getNomineeBySlug(a.category!, a.slug!, { cache: ctx.cache }),
        );
      });
    return { content: [text(JSON.stringify(await get(args), null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

// ---- collections + directory (HTML sources) ----
// Both are parsed pages under the same 7-day local cache + stale-fallback
// contract as annual. No media is downloaded; cards carry public fields only.

export async function get_collections(ctx: HandlerContext, args: {
  slug?: string;
  page?: number;
}): Promise<ToolResponse> {
  try {
    const get =
      ctx.deps.getCollectionsFn ??
      ((a: { slug?: string; page?: number }) => {
        if (a.slug) {
          return import("../../collections.js").then((m) =>
            m.getCollection(a.slug!, a.page, { cache: ctx.cache }),
          );
        }
        return import("../../collections.js").then((m) => m.getCollections(a.page, { cache: ctx.cache }));
      });
    return { content: [text(JSON.stringify(await get(args), null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function search_directory(ctx: HandlerContext, args: DirectoryArgs): Promise<ToolResponse> {
  try {
    const search =
      ctx.deps.searchDirectoryFn ??
      ((a: DirectoryArgs) =>
        import("../../directory.js").then((m) => m.searchDirectory(a, { cache: ctx.cache })));
    return { content: [text(JSON.stringify(await search(args), null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

// ---- longitudinal monitoring ----

export async function new_winners(ctx: HandlerContext, args: { award?: "sotd" | "developer" | "honorable" }): Promise<ToolResponse> {
  try {
    const res = await fetchNewWinners(ctx.client, ctx.cache, { award: args.award ?? "sotd", now: ctx.nowMs });
    // Seed the sites cache too — next search_sites serves these rows
    // without re-fetching the same listing.
    if (res.newWinners.length > 0) ctx.cache.upsertSites(res.newWinners);
    // Backfill: index each winner's Elements section as source="site"
    // component records so search_elements covers fresh winners without
    // waiting for the gallery crawl. One page fetch per winner; per-winner
    // failures never abort the rest.
    let backfilled = 0;
    if (res.newWinners.length > 0) {
      const records: ElementRecord[] = [];
      for (const site of res.newWinners) {
        try {
          const html = await ctx.client.getHtml(site.detailPath);
          records.push(...recordsFromSiteHtml(html, site, Math.floor(ctx.nowMs() / 1000)));
          backfilled++;
        } catch {
          /* site page 404/blocked — the detail remains fetchable on demand */
        }
      }
      if (records.length > 0) ctx.cache.upsertElements(records);
    }
    const body = res.isNewArrivals
      ? `First poll for ${res.day} — no baseline yet, so there is no delta. ` +
        `${res.totalInListing} current listing entries stored as the baseline; call again after the next winners land.`
      : `${res.newWinners.length} new ${AWARD_FILTER_LABELS[args.award ?? "sotd"]} winner(s) for ${res.day} ` +
        `(listing shows ${res.totalInListing})` +
        (backfilled > 0 ? `; ${backfilled} site page(s) backfilled into the component index.` : ".") +
        ` Search the element corpus (source hits show siteSlug).`;
    return {
      content: [
        text(body),
        ...(res.isNewArrivals
          ? []
          : [text(res.newWinners.map(summarizeSite).join("\n\n") || "(no unreported winners — poll again tomorrow)")]),
      ],
    };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function watch_site(ctx: HandlerContext, args: {
  action: "add" | "list" | "remove";
  kind?: "studio" | "tag" | "url";
  pattern?: string;
  award?: "sotd" | "developer" | "honorable";
  note?: string;
}): Promise<ToolResponse> {
  try {
    if (args.action === "list") {
      const watches = listWatches(ctx.cache);
      if (watches.length === 0) return { content: [text("No watches. Add one with action=add.")] };
      // Evaluate against the freshest cached listing rows; watch_site itself
      // never fetches — new_winners/search_sites keep this supply fresh.
      const rows = ctx.cache.getSites(SITE_TTL_MS);
      const deltas = rows.length > 0 ? checkWatches(ctx.cache, rows) : [];
      const lines = watches.map((w) => {
        const delta = deltas.find((d) => d.watch.kind === w.kind && d.watch.pattern === w.pattern);
        const matches = rows.filter((s) => matchesWatch(w, s));
        return (
          `- [${w.kind}] ${w.pattern}${w.award ? ` (award: ${w.award})` : ""}` +
          `${w.note ? ` — ${w.note}` : ""}\n` +
          `  currently matching: ${matches.length} site(s)` +
          (matches.length ? `: ${matches.map((s) => s.slug).join(", ")}` : "") +
          `\n  last checked: ${w.lastCheckedAt ? new Date(w.lastCheckedAt).toISOString() : "never (list again after rows load to seed)"}` +
          (delta ? `\n  NEW since last check: ${delta.matches.map((s) => `${s.title} (/sites/${s.slug})`).join("; ")}` : "")
        );
      });
      return { content: [text(lines.join("\n"))] };
    }
    if (!args.kind || !args.pattern) {
      return { content: [text("add/remove need kind (studio|tag|url) and pattern.")], isError: true };
    }
    if (args.action === "remove") {
      return {
        content: [
          text(removeWatch(ctx.cache, args.kind, args.pattern) ? `Removed watch [${args.kind}] ${args.pattern}.` : `No watch [${args.kind}] ${args.pattern}.`),
        ],
      };
    }
    const rec = await addWatch(ctx.cache, {
      kind: args.kind,
      pattern: args.pattern,
      award: args.award,
      note: args.note,
    });
    return {
      content: [
        text(
          `Watching [${rec.kind}] ${rec.pattern}. Poll with action=list after new winners land ` +
            "(the winners poll also advances the baseline any watch compares against).",
        ),
      ],
    };
  } catch (err) {
    return errorResponse(err);
  }
}
