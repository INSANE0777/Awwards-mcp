import { AWARD_FILTERS, BlockedError } from "../awwwards.js";
import type { AwardFilter } from "../awwwards.js";
import type { SiteSummary, SiteDetails } from "../types.js";
import { isAllEmptyDetail, prepareSitePage } from "../atlas/ingest.js";
import {
  AWARD_FILTER_LABELS,
  SITE_TTL_MS,
  canonicalFacet,
  compactSiteDetails,
  formatCompactSite,
  text,
  tokenizeQuery,
} from "./types.js";
import type {
  BatchDetailEntry,
  Block,
  CreateHandlersDeps,
  DetailSource,
  SearchArgs,
} from "./types.js";

/** Shared state and private helpers every domain handler receives. */
export interface HandlerContext {
  client: CreateHandlersDeps["client"];
  cache: CreateHandlersDeps["cache"];
  deps: CreateHandlersDeps;
  nowMs: () => number;
  matchesFilters: (
    s: SiteSummary,
    f: SearchArgs,
    honorUrlSource: boolean,
    skipQueryCheck?: boolean,
  ) => boolean;
  siteImage: (s: SiteSummary) => Promise<Block | null>;
  compactContent: (slice: SiteSummary[], start: number, header: string) => Promise<Block[]>;
  orderByScore: (list: SiteSummary[], sortBy: SearchArgs["sortBy"]) => SiteSummary[];
  detailDriftMessage: (slug: string) => string;
  loadDetail: (slug: string) => Promise<SiteDetails | null>;
  loadDetails: (slugs: string[]) => Promise<BatchDetailEntry[]>;
}

// An all-empty parse on an awarded page means the layout changed (or the page
// was not found): neither tool may cache such a parse, so the mismatch can
// still be surfaced. A Nominee submission carries no palette, technology,
// award or description section at all, so its empty parse is real content.
export { isAllEmptyDetail };

// Annual "Winners — ..." categories: listing cards carry no award marker, so
// only the fetched filter page proves membership (unlike sotd/sotm/soty and
// the persisted nominee flag, which rows can verify). Derived from the URL
// table so a new winner category cannot drift out of this set.
const WINNER_CATEGORY_AWARDS: ReadonlySet<AwardFilter> = new Set(
  (Object.keys(AWARD_FILTERS) as AwardFilter[])
    .filter((key) => AWARD_FILTERS[key].startsWith("websites/winner_category_")),
);

// Color rows carry no colors and winner-category cards carry no marker: for
// those URL filters a fresh scrape is the only membership evidence.
export function urlFilterNeedsPageMembership(f: SearchArgs): boolean {
  return Boolean(f.color) || (f.award !== undefined && WINNER_CATEGORY_AWARDS.has(f.award));
}

function matchesFacet(s: SiteSummary, requested: string): boolean {
  const wanted = canonicalFacet(requested);
  return s.tags.some((tag) => canonicalFacet(tag) === wanted);
}

export function createHandlerContext(deps: CreateHandlersDeps): HandlerContext {
  const { client, cache } = deps;
  const nowMs = deps.now ?? Date.now;

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
  // non-query filters run.
  function matchesFilters(
    s: SiteSummary,
    f: SearchArgs,
    honorUrlSource: boolean,
    skipQueryCheck = false,
  ): boolean {
    const source = urlSource(f);
    // Facets are exact after one normalization path (canonicalFacet: trim,
    // slugify, display-slug alias, technology alias). The old substring check
    // made "react" match "react-native" and leaned on display tags happening
    // to contain their slug; "nextjs"/"Next.js"/"next js" all resolve to
    // "next-js", and display names meet their URL slugs.
    if (f.tags?.length) {
      const tagsToCheck =
        honorUrlSource && source === "tag" ? f.tags.slice(1) : f.tags;
      for (const t of tagsToCheck) {
        if (!matchesFacet(s, t)) return false;
      }
    }
    if (f.technology && !(honorUrlSource && source === "technology")) {
      if (!matchesFacet(s, f.technology)) return false;
    }
    if (f.award && !(honorUrlSource && source === "award")) {
      // nominees: listing cards carry no award tags, so the persisted
      // nominee flag (set when rows were scraped from /websites/nominees/)
      // is the only client-checkable marker. The winner_category_* filters
      // have no card marker at all — cache rows fail their label check and
      // an empty page window makes the search re-scrape the filter page,
      // which is the correct (conservative) outcome.
      if (f.award === "nominees") {
        if (s.nominee !== true) return false;
      } else if (!s.awards.includes(AWARD_FILTER_LABELS[f.award])) {
        return false;
      }
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

  async function compactContent(slice: SiteSummary[], start: number, header: string): Promise<Block[]> {
    // Previews fetch sequentially in card order: getImage's async disk-cache
    // miss-check races under Promise.all, making the fetch (side-effect) order
    // scheduler-dependent instead of card-ordered. ≤2 previews; nothing
    // depends on parallelism here.
    const images: (Block | null)[] = [];
    for (const s of slice.slice(0, 2)) images.push(await siteImage(s));
    return [
      text(`${header}\n\n${slice.map((s, i) => formatCompactSite(s, start + i)).join("\n")}`),
      ...images.flatMap((image, i): Block[] => image
        ? [text(`Preview #${start + i}: ${slice[i].slug}`), image]
        : []),
    ];
  }

  // sortBy: "score" view. Scores live in detail-meta entries written by
  // get_site_details, so this reads the cache only — never a live fetch during
  // search. SiteDetails gains its score field in a later v1.5.0 task, so the
  // meta read is typed locally. Scored sites come first (desc); unscored ones
  // follow, newest-first.
  function orderByScore(list: SiteSummary[], sortBy: SearchArgs["sortBy"]): SiteSummary[] {
    if (sortBy !== "score") return list;
    // One batched cache read for every candidate: per-site getMeta opened the
    // SQLite file once per row (N+1) and made score sorting O(candidates) DB
    // opens. map() preserves the input order for the stable sort fallback.
    const scores = cache.getMetaMany<{ score?: number }>(
      list.map((s) => `detail:${s.slug}`),
      SITE_TTL_MS,
    );
    const withScores = list.map((s) => ({
      s,
      score: scores.get(`detail:${s.slug}`)?.score ?? null,
    }));
    withScores.sort(
      (a, b) =>
        (b.score ?? -1) - (a.score ?? -1) ||
        b.s.createdAt - a.s.createdAt ||
        a.s.slug.localeCompare(b.s.slug),
    );
    return withScores.map((w) => w.s);
  }

  function detailDriftMessage(slug: string): string {
    return "Awwwards layout may have changed: parsed no design data for " + slug +
      ". The awwwards-mcp parser likely needs an update (or the site page was not found).";
  }

  // Shared by details and comparison: only successful parses seed the detail
  // and elements caches, and neither caller needs an image to do so.
  async function loadDetail(slug: string): Promise<SiteDetails | null> {
    const metaKey = `detail:${slug}`;
    let d = cache.getMeta<SiteDetails>(metaKey, SITE_TTL_MS);
    if (!d) {
      const html = await client.getHtml(`/sites/${slug}`);
      const prepared = prepareSitePage({
        slug,
        html,
        fetchedAt: nowMs(),
        sourceUrl: `https://www.awwwards.com/sites/${slug}`,
        summary: cache.getSite(slug, Number.POSITIVE_INFINITY),
      });
      d = prepared.detail;
      // Nominees legitimately parse empty; only an awarded page that parses
      // empty is parser drift, and only drift stays uncached.
      if (isAllEmptyDetail(d) && !d.nominee) return null;
      await cache.commitSitePage(prepared);
    }
    return d;
  }

  // Cache-first wrapper for the batch path: a real loadDetail call (including
  // its built-in retry) is the only thing reported as "fetched".
  async function loadDetailWithSource(
    slug: string,
  ): Promise<{ detail: SiteDetails | null; source: DetailSource }> {
    const cached = cache.getMeta<SiteDetails>(`detail:${slug}`, SITE_TTL_MS);
    if (cached) return { detail: cached, source: "cached" };
    return { detail: await loadDetail(slug), source: "fetched" };
  }

  // Ordered batch outcomes: per-slug failures are tolerant, and the first
  // block skips every remaining slug (no further requests).
  async function loadDetails(slugs: string[]): Promise<BatchDetailEntry[]> {
    const results: BatchDetailEntry[] = [];
    let blocked = false;
    for (const slug of slugs) {
      if (blocked) {
        results.push({ slug, status: "skipped", error: "blocked-before-request", blocked: true });
        continue;
      }
      try {
        const { detail, source } = await loadDetailWithSource(slug);
        results.push(detail
          ? { slug, status: source, details: compactSiteDetails(detail) }
          : { slug, status: "error", error: detailDriftMessage(slug) });
      } catch (err) {
        const isBlocked = err instanceof BlockedError;
        if (isBlocked) blocked = true;
        results.push({
          slug,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          ...(isBlocked ? { blocked: true as const } : {}),
        });
      }
    }
    return results;
  }

  return {
    client,
    cache,
    deps,
    nowMs,
    matchesFilters,
    siteImage,
    compactContent,
    orderByScore,
    detailDriftMessage,
    loadDetail,
    loadDetails,
  };
}
