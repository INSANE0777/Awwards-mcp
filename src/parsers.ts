import type { SiteSummary } from "./types.js";

const ENTITIES: Record<string, string> = {
  "&quot;": '"',
  "&amp;": "&",
  "&#039;": "'",
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(?:quot|amp|#0?39|lt|gt|nbsp);/g, (e) => ENTITIES[e] ?? e);
}

const AWARD_LABELS: Record<string, string> = {
  sotd: "Site of the Day",
  dev: "Developer Award",
  hm: "Honorable Mention",
  sotm: "Site of the Month",
  mobile: "Mobile Excellence",
  ecom: "E-Commerce Award",
};

// Card JSON blob and its markup: the blob sits in data-collectable-model-value
// immediately before the card markup. The blob is HTML-entity-escaped JSON, so
// the closing quote of the attribute is the first raw `">` after the split point.
export function parseListing(html: string): SiteSummary[] {
  const sites: SiteSummary[] = [];
  const parts = html.split('data-collectable-model-value="');
  for (const part of parts.slice(1)) {
    const end = part.indexOf('">');
    if (end < 0) continue;
    let meta: any;
    try {
      meta = JSON.parse(decodeEntities(part.slice(0, end)));
    } catch {
      continue;
    }
    if (!meta?.slug || !meta?.title) continue;
    if (meta.type && meta.type !== "submission") continue;
    const card = part.slice(end, end + 8000); // one card block is ~3KB; 8KB is safe
    const detailMatch = card.match(/href="(\/sites\/[^"#?]+)"/);
    if (!detailMatch) continue; // collections/other modules are not site cards
    const liveMatch = card.match(/class="figure-rollover__bt"[^>]*href="(https?:\/\/[^"]+)"/);
    const awards = [...card.matchAll(/budget-tag--([a-z-]+)/g)].map(
      (m) => AWARD_LABELS[m[1]] ?? m[1],
    );
    sites.push({
      id: meta.id ?? 0,
      slug: meta.slug,
      title: decodeEntities(meta.title),
      createdAt: meta.createdAt ?? 0,
      tags: Array.isArray(meta.tags) ? meta.tags.map(decodeEntities) : [],
      thumbnailPath: meta.images?.thumbnail ?? "",
      liveUrl: liveMatch ? decodeEntities(liveMatch[1]) : null,
      detailPath: detailMatch[1],
      awards: [...new Set(awards)],
    });
  }
  return sites;
}
