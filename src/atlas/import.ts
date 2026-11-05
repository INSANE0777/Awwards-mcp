import type { Cache } from "../cache.js";
import type { ElementMedia, SiteDetails } from "../types.js";
import { sha256Text } from "./identity.js";
import { isAllEmptyDetail, normalizeHighlights } from "./ingest.js";
import { AtlasStore } from "./store.js";
import type { PreparedLegacyElement, PreparedSitePage } from "./types.js";

interface MetaRow {
  key: string;
  value: string;
  fetchedAt: number;
}

interface SiteElementRow {
  siteSlug: string;
  slug: string;
  title: string;
  mediaPath: string;
  author: string;
  fetchedAt: number;
}

interface GalleryElementRow {
  slug: string;
  title: string;
  author: string;
  mediaPath: string;
  mediaType: string | null;
  siteSlug: string | null;
  fetchedAt: number;
}

export interface ImportFailure {
  slug: string;
  error: string;
}

export interface ImportReport {
  enabled: boolean;
  sitePages: number;
  galleryItems: number;
  processed: number;
  published: number;
  unpublished: number;
  artifacts: number;
  skipped: number;
  limitations: string[];
  failures: ImportFailure[];
}

export interface ImportLegacyOptions {
  now?: () => number;
}

/**
 * Offline Phase-1 import: rebuilds the Atlas source projection from cached
 * `detail:*` / `elements:*` metadata. No browser, no network, no synthetic HTML.
 */
export async function importLegacyAtlas(
  cache: Cache,
  options: ImportLegacyOptions = {},
): Promise<ImportReport> {
  const now = options.now ?? Date.now;
  const details = readMeta(cache, "detail:");
  const elements = readMeta(cache, "elements:", true);
  const siteRows = readSiteElementRows(cache);
  const galleryRows = readGalleryRows(cache);
  const slugs = [
    ...new Set([...details.keys(), ...elements.keys(), ...siteRows.keys()]),
  ].sort();

  const report: ImportReport = {
    enabled: cache.atlas,
    sitePages: 0,
    galleryItems: 0,
    processed: 0,
    published: 0,
    unpublished: 0,
    artifacts: 0,
    skipped: cache.atlas ? 0 : slugs.length + galleryRows.length,
    limitations: [],
    failures: [],
  };
  if (!cache.atlas) return report;

  const store = new AtlasStore(cache, { now });
  for (const slug of slugs) {
    try {
      const prepared = prepareLegacyPage(
        slug,
        details.get(slug),
        elements.get(slug),
        siteRows.get(slug) ?? [],
      );
      const result = await store.commitSitePage(prepared);
      report.sitePages++;
      report.processed++;
      if (result.artifactWritten) report.artifacts++;
      if (result.published) report.published++;
      else report.unpublished++;
      for (const limitation of prepared.limitations ?? []) {
        if (!report.limitations.includes(limitation)) report.limitations.push(limitation);
      }
    } catch (error) {
      report.failures.push({
        slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const row of galleryRows) {
    try {
      const result = await store.commitLegacyGallery({
        slug: row.slug,
        title: row.title,
        siteSlug: row.siteSlug,
        author: row.author,
        mediaPath: row.mediaPath,
        mediaType: row.mediaType === "video" || row.mediaType === "image" ? row.mediaType : null,
        fetchedAt: usableTimestamp(row.fetchedAt),
      });
      report.galleryItems++;
      report.processed++;
      if (result.artifactWritten) report.artifacts++;
      if (result.published) report.published++;
      else report.unpublished++;
      if (!usableTimestamp(row.fetchedAt) && !report.limitations.includes("MISSING_TIMESTAMP")) {
        report.limitations.push("MISSING_TIMESTAMP");
      }
    } catch (error) {
      report.failures.push({
        slug: `gallery:${row.slug}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (report.processed > 0 && !report.limitations.includes("LEGACY_METADATA_ONLY")) {
    report.limitations.unshift("LEGACY_METADATA_ONLY");
  }
  return report;
}

function prepareLegacyPage(
  slug: string,
  detailMeta: MetaRow | undefined,
  elementsMeta: MetaRow | undefined,
  siteRows: SiteElementRow[],
): PreparedSitePage {
  const detail = parseDetailMeta(slug, detailMeta);
  const metaElements = parseElementsMeta(elementsMeta);
  const malformedElements = metaElements === "malformed";
  // Duplicate legacy rows can disagree. Pick the newest normalized row per
  // media identity before deriving highlights, provenance, or the digest.
  const selectedSiteRows = newestSiteRowsByMedia(siteRows);
  // A site-origin elements row is itself legacy evidence, so use it when the
  // normalized elements:* metadata is absent.
  const parsedElements: ElementMedia[] | null = malformedElements
    ? null
    : metaElements ??
      (selectedSiteRows.length > 0
        ? selectedSiteRows.map((row) => ({ title: row.title, mediaPath: row.mediaPath }))
        : null);
  const detailFetchedAt = usableTimestamp(detailMeta?.fetchedAt);
  const elementsFetchedAt = elementsMeta
    ? usableTimestamp(elementsMeta.fetchedAt)
    : newestUsableTimestamp(selectedSiteRows.map((row) => row.fetchedAt));
  // Highlight ordering must use the elements evidence time. Detail metadata
  // freshness is retained in evidenceTimes but cannot authorize stale highlights.
  const sourceFetchedAt = parsedElements !== null ? elementsFetchedAt : detailFetchedAt;
  const timestampKnown = sourceFetchedAt !== null;

  let highlightParse: PreparedSitePage["highlightParse"];
  if (malformedElements || parsedElements === null) {
    // Missing evidence means the projection is unknown, not empty. Malformed
    // nonempty arrays are likewise unusable and must never publish emptiness.
    highlightParse = { status: "drift", items: [] };
  } else if (parsedElements.length === 0) {
    highlightParse = { status: "absent", items: [] };
  } else {
    highlightParse = {
      status: "parsed",
      items: normalizeHighlights(slug, parsedElements),
    };
  }

  const limitations: string[] = [];
  if (!detailMeta) limitations.push("LEGACY_DETAIL_MISSING");
  if (malformedElements) limitations.push("LEGACY_ELEMENTS_MALFORMED");
  if (parsedElements === null && !malformedElements)
    limitations.push("LEGACY_ELEMENTS_MISSING");
  if (!timestampKnown) limitations.push("MISSING_TIMESTAMP");
  else if (
    (parsedElements !== null && elementsFetchedAt === null) ||
    (elementsMeta === undefined &&
      selectedSiteRows.some((row) => usableTimestamp(row.fetchedAt) === null))
  ) {
    limitations.push("MISSING_TIMESTAMP");
  }

  const siteByMedia = new Map(selectedSiteRows.map((row) => [row.mediaPath, row]));
  const fallbackAuthor = detail.title ?? slug;
  const rawTitleByMedia = new Map<string, string>();
  for (const item of parsedElements ?? []) {
    if (!rawTitleByMedia.has(item.mediaPath)) rawTitleByMedia.set(item.mediaPath, item.title);
  }
  const legacyElements: PreparedLegacyElement[] = highlightParse.items.map((item) => {
    const siteRow = siteByMedia.get(item.mediaPath);
    // Elements evidence keeps its own observation time; a newer detail
    // timestamp must not leak into highlight provenance.
    const fetchedAt =
      metaElements !== null
        ? elementsFetchedAt ?? 0
        : usableTimestamp(siteRow?.fetchedAt) ?? 0;
    return {
      identity: item.identity,
      fallbackSlug: `site-${slug}-${sha256Text(item.mediaPath)}`,
      siteSlug: slug,
      title: rawTitleByMedia.get(item.mediaPath) ?? item.title,
      mediaPath: item.mediaPath,
      mediaType: item.mediaPath.endsWith(".mp4") ? "video" : "image",
      author: siteRow?.author || fallbackAuthor,
      // 0 is the explicit unknown sentinel; never synthesize an observation
      // time from the import clock, and flag missing time in coverage.
      fetchedAt,
    };
  });

  const digestInput = {
    provenance: "legacy_import",
    slug,
    detail: detailMeta?.value ?? null,
    elements:
      highlightParse.status === "parsed"
        ? highlightParse.items.map(({ title, mediaPath }) => ({ title, mediaPath }))
        : parsedElements,
  };

  return {
    slug,
    sourceUrl: `https://www.awwwards.com/sites/${slug}`,
    fetchedAt: sourceFetchedAt ?? 0,
    sourceDigest: sha256Text(JSON.stringify(digestInput)),
    detail,
    detailValid: Boolean(detailMeta),
    detailEmpty: isAllEmptyDetail(detail),
    highlights: highlightParse.items,
    highlightParse,
    legacyElements,
    summary: detailMeta
      ? { title: detail.title, liveUrl: detail.liveUrl }
      : null,
    provenance: "legacy_import",
    sourceFetchedAt,
    evidenceTimes: {
      detail: detailFetchedAt,
      elements: elementsFetchedAt,
    },
    limitations,
    publishable: parsedElements !== null,
  };
}

/** Choose one deterministic newest row per media path. */
function newestSiteRowsByMedia(rows: SiteElementRow[]): SiteElementRow[] {
  const selected = new Map<string, { row: SiteElementRow; at: number | null }>();
  for (const row of rows) {
    const at = usableTimestamp(row.fetchedAt);
    const current = selected.get(row.mediaPath);
    if (
      !current ||
      (at !== null && (current.at === null || at > current.at)) ||
      (at === current.at && row.slug.localeCompare(current.row.slug) < 0)
    ) {
      selected.set(row.mediaPath, { row, at });
    }
  }
  return [...selected.values()]
    .map((entry) => entry.row)
    .sort(
      (left, right) =>
        left.mediaPath.localeCompare(right.mediaPath) ||
        left.slug.localeCompare(right.slug),
    );
}

function parseDetailMeta(slug: string, meta: MetaRow | undefined): SiteDetails {
  if (meta) {
    const value = safeJson(meta.value);
    if (value && typeof value === "object") return value as SiteDetails;
  }
  return {
    slug,
    title: null,
    description: null,
    palette: [],
    technologies: [],
    elements: [],
    awards: [],
    nominee: false,
    score: null,
    ogImage: null,
    liveUrl: null,
  };
}

function parseElementsMeta(
  meta: MetaRow | undefined,
): ElementMedia[] | null | "malformed" {
  if (!meta) return null;
  const value = safeJson(meta.value);
  if (!Array.isArray(value)) return "malformed";
  const valid = value.every(
    (item): item is ElementMedia =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as { title?: unknown }).title === "string" &&
      typeof (item as { mediaPath?: unknown }).mediaPath === "string" &&
      (item as { mediaPath: string }).mediaPath.length > 0,
  );
  if (!valid) return "malformed";
  return value;
}

function readMeta(
  cache: Cache,
  prefix: string,
  keepMalformed = false,
): Map<string, MetaRow> {
  const rows = cache.withReadDb(
    (db) =>
      db
        .prepare("SELECT key, value, fetchedAt FROM meta WHERE key LIKE ? ORDER BY key")
        .all(`${prefix}%`) as unknown as MetaRow[],
  );
  const values = new Map<string, MetaRow>();
  for (const row of rows) {
    if (!row.key.startsWith(prefix)) continue;
    // Malformed detail rows are skipped; malformed elements rows must remain
    // visible so they can veto publication instead of looking absent.
    if (!keepMalformed && safeJson(row.value) === undefined) continue;
    values.set(row.key.slice(prefix.length), row);
  }
  return values;
}

function readSiteElementRows(cache: Cache): Map<string, SiteElementRow[]> {
  const rows = cache.withReadDb(
    (db) =>
      db
        .prepare(
          `SELECT siteSlug, slug, title, mediaPath, author, fetchedAt
           FROM elements
           WHERE source = 'site' AND siteSlug IS NOT NULL AND mediaPath IS NOT NULL
           ORDER BY siteSlug, mediaPath, slug`,
        )
        .all() as unknown as SiteElementRow[],
  );
  const grouped = new Map<string, SiteElementRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.siteSlug);
    if (list) list.push(row);
    else grouped.set(row.siteSlug, [row]);
  }
  return grouped;
}

function readGalleryRows(cache: Cache): GalleryElementRow[] {
  return cache.withReadDb(
    (db) =>
      db
        .prepare(
          `SELECT slug, title, author, mediaPath, mediaType, siteSlug, fetchedAt
           FROM elements
           WHERE source = 'gallery' AND mediaPath IS NOT NULL AND mediaPath <> ''
           ORDER BY slug`,
        )
        .all() as unknown as GalleryElementRow[],
  );
}

function usableTimestamp(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  // Legacy rows may still store unix seconds; Atlas timestamps are milliseconds.
  return value < 100_000_000_000 ? value * 1000 : value;
}

function newestUsableTimestamp(values: number[]): number | null {
  let latest: number | null = null;
  for (const value of values) {
    const normalized = usableTimestamp(value);
    if (normalized !== null && (latest === null || normalized > latest)) latest = normalized;
  }
  return latest;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
