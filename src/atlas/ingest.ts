import { parseDetail, parseElements } from "../parsers.js";
import type { SiteDetails, SiteSummary } from "../types.js";
import { sha256Text, highlightIdentity } from "./identity.js";
import type {
  HighlightParse,
  PreparedHighlight,
  PreparedLegacyElement,
  PreparedSitePage,
} from "./types.js";

export interface PrepareSitePageInput {
  slug: string;
  html: string;
  fetchedAt: number;
  sourceUrl: string;
  summary: SiteSummary | null;
}

/** Shared definition of "this parse contains no design data at all". */
export function isAllEmptyDetail(detail: SiteDetails): boolean {
  return (
    detail.palette.length === 0 &&
    detail.technologies.length === 0 &&
    detail.elements.length === 0 &&
    detail.awards.length === 0 &&
    !detail.description
  );
}

/** Normalize parsed media by (site slug, media path), never by title. */
export function normalizeHighlights(
  slug: string,
  items: ReadonlyArray<{ title: string; mediaPath: string }>,
): PreparedHighlight[] {
  const seen = new Set<string>();
  const highlights: PreparedHighlight[] = [];
  for (const item of items) {
    const identity = highlightIdentity(slug, item.mediaPath);
    if (seen.has(identity)) continue;
    seen.add(identity);
    highlights.push({
      title: item.title.slice(0, 300),
      mediaPath: item.mediaPath,
      identity,
    });
  }
  return highlights;
}

/** Pure item-page normalization shared by every Awwwards ingestion path. */
export function prepareSitePage(input: PrepareSitePageInput): PreparedSitePage {
  const detail = parseDetail(input.html, input.slug);
  const parsed = parseElements(input.html);

  let highlightParse: HighlightParse;
  if (parsed === null) {
    highlightParse = { status: "absent", items: [] };
  } else if (parsed.length === 0) {
    highlightParse = { status: "drift", items: [] };
  } else {
    highlightParse = {
      status: "parsed",
      items: normalizeHighlights(input.slug, parsed),
    };
  }

  const summary = input.summary
    ? { title: input.summary.title, liveUrl: input.summary.liveUrl }
    : { title: detail.title, liveUrl: detail.liveUrl };
  const author =
    input.summary?.studio ?? input.summary?.title ?? detail.title ?? input.slug;
  const rawTitleByMedia = new Map<string, string>();
  for (const item of parsed ?? []) {
    if (!rawTitleByMedia.has(item.mediaPath)) rawTitleByMedia.set(item.mediaPath, item.title);
  }
  const legacyElements: PreparedLegacyElement[] = highlightParse.items.map((item) => ({
    identity: item.identity,
    fallbackSlug: `site-${input.slug}-${sha256Text(item.mediaPath)}`,
    siteSlug: input.slug,
    title: rawTitleByMedia.get(item.mediaPath) ?? item.title,
    mediaPath: item.mediaPath,
    mediaType: item.mediaPath.endsWith(".mp4") ? "video" : "image",
    author,
    fetchedAt: input.fetchedAt,
  }));

  return {
    slug: input.slug,
    sourceUrl: input.sourceUrl,
    fetchedAt: input.fetchedAt,
    sourceDigest: sha256Text(input.html),
    detail,
    detailValid: Boolean(detail.title || detail.description || detail.technologies.length),
    detailEmpty: isAllEmptyDetail(detail),
    highlights: highlightParse.items,
    highlightParse,
    legacyElements,
    summary,
  };
}
