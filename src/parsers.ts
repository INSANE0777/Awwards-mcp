import type { SiteDetails, SiteSummary } from "./types.js";

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

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function parseDetail(html: string, slug: string): SiteDetails {
  const palette = [
    ...new Set(
      [...html.matchAll(/<strong>HEX<\/strong>\s*#([0-9A-Fa-f]{6})/g)].map((m) =>
        `#${m[1].toUpperCase()}`,
      ),
    ),
  ];

  const techIdx = html.indexOf("Technologies & Tools</h2>");
  const techSection = techIdx >= 0 ? html.slice(techIdx, techIdx + 6000) : "";
  const technologies = [
    ...new Set(
      [...techSection.matchAll(/class="button button--tag"[^>]*>([^<]+)</g)].map((m) =>
        stripTags(m[1]),
      ),
    ),
  ].filter(Boolean);

  const elStart = html.indexOf(">Elements</h2>");
  const elEnd = elStart >= 0 ? html.indexOf(">Color Palette</h2>", elStart) : -1;
  const elSection = elStart >= 0 && elEnd > elStart ? html.slice(elStart, elEnd) : "";
  const elements = [...elSection.matchAll(/collectableTitle&quot;:&quot;(.+?)&quot;/g)].map(
    (m) => decodeEntities(m[1]),
  );

  const awards = [...html.matchAll(
    /(Site of the Day|Developer Award|Honorable Mention|Site of the Month|Mobile Excellence|E-Commerce Award)\s*[-–]\s*([A-Z][a-z]+ \d{1,2}, \d{4})/g,
  )].map((m) => ({ title: m[1], date: m[2] }));

  const descIdx = html.indexOf(">Description</h2>");
  const descMatch =
    descIdx >= 0
      ? html.slice(descIdx, descIdx + 3000).match(/<h3 class="heading-6">([\s\S]{0,2000}?)<\/h3>/)
      : null;

  const ogMatch = html.match(/property="og:image" content="([^"]+)"/);

  // Live site: the h1 anchor points at the awarded site itself
  // (verified: <h1 class="heading-1 text-uppercase"> <a href="https://..." target="_blank" rel="noopener">TITLE</a>).
  // Fallback: first blank-target noopener anchor to a non-awwwards host.
  const h1Match = html.match(
    /<h1 class="heading-1[^"]*">\s*<a href="(https?:\/\/(?!www\.awwwards\.com|assets\.awwwards\.com)[^"]+)"[^>]*>([\s\S]*?)<\/a>/,
  );
  const liveFallback = h1Match
    ? null
    : html.match(
        /href="(https?:\/\/(?!www\.awwwards\.com|assets\.awwwards\.com)[^"]+)"[^>]*target="_blank" rel="noopener"/,
      );
  const liveUrl = h1Match?.[1] ?? liveFallback?.[1] ?? null;
  const titleMatch = html.match(/property="og:title" content="([^"]+)"/);

  return {
    slug,
    title: titleMatch ? decodeEntities(titleMatch[1]) : (h1Match ? stripTags(h1Match[2]) : null),
    description: descMatch ? stripTags(descMatch[1]) || null : null,
    palette,
    technologies,
    elements,
    awards,
    ogImage: ogMatch ? decodeEntities(ogMatch[1]) : null,
    liveUrl: liveUrl ? decodeEntities(liveUrl) : null,
  };
}
