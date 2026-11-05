import type { DatabaseSync } from "node:sqlite";
import type { ElementRecord } from "../types.js";
import type { PreparedLegacyElement, PreparedSitePage } from "./types.js";

const UNCATEGORIZED = "uncategorized";

export interface LegacyProjectionOptions {
  /** Legacy imports must not refresh metadata TTLs or overwrite stored timestamps. */
  writeMeta?: boolean;
  /** Imports keep existing author/stack/taxonomy fields instead of resetting unknowns. */
  preserveExisting?: boolean;
}

export function toLegacyElementRecord(
  element: PreparedLegacyElement,
  slug: string,
): ElementRecord {
  return {
    slug,
    title: element.title,
    cid: UNCATEGORIZED,
    category: UNCATEGORIZED,
    author: element.author,
    builtWith: [],
    related: [],
    mediaPath: element.mediaPath,
    mediaType: element.mediaType,
    source: "site",
    projectId: null,
    siteSlug: element.siteSlug,
    fetchedAt: element.fetchedAt,
  };
}

/**
 * Writes the legacy element projection and, for fetched pages, the legacy
 * detail/elements metadata. Callers own the surrounding transaction so the
 * legacy and Atlas projections commit or roll back together.
 */
export function writeLegacyProjection(
  db: DatabaseSync,
  prepared: PreparedSitePage,
  now: number,
  options: LegacyProjectionOptions = {},
): void {
  if (options.writeMeta !== false) {
    if (!prepared.detailEmpty || prepared.detail.nominee) {
      setMeta(db, `detail:${prepared.slug}`, prepared.detail, now);
    }
    if (prepared.highlightParse.status === "absent") {
      setMeta(db, `elements:${prepared.slug}`, [], now);
    } else if (prepared.highlightParse.status === "parsed") {
      const legacyTitleByMedia = new Map(
        prepared.legacyElements.map((element) => [element.mediaPath, element.title]),
      );
      setMeta(
        db,
        `elements:${prepared.slug}`,
        prepared.highlights.map(({ title, mediaPath }) => ({
          title: legacyTitleByMedia.get(mediaPath) ?? title,
          mediaPath,
        })),
        now,
      );
    }
  }

  const findExisting = db.prepare(
    `SELECT slug, fetchedAt FROM elements
     WHERE source = 'site' AND siteSlug = ? AND mediaPath = ?`,
  );
  // Never let a site projection overwrite a gallery-origin row that happens to
  // share a slug. Gallery slugs stay untouched and searchable.
  const upsert = db.prepare(
    options.preserveExisting
      ? `INSERT INTO elements
           (slug, title, cid, category, author, builtWith, related, mediaPath, mediaType,
            source, projectId, siteSlug, fetchedAt)
         VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, ?, 'site', NULL, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           mediaPath = excluded.mediaPath,
           mediaType = excluded.mediaType,
           author = CASE WHEN elements.author <> '' THEN elements.author ELSE excluded.author END
         WHERE elements.source = 'site'`
      : `INSERT INTO elements
           (slug, title, cid, category, author, builtWith, related, mediaPath, mediaType,
            source, projectId, siteSlug, fetchedAt)
         VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, ?, 'site', NULL, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           title = excluded.title,
           cid = excluded.cid,
           category = excluded.category,
           author = excluded.author,
           builtWith = excluded.builtWith,
           related = excluded.related,
           mediaPath = excluded.mediaPath,
           mediaType = excluded.mediaType,
           source = excluded.source,
           projectId = excluded.projectId,
           siteSlug = excluded.siteSlug,
           fetchedAt = excluded.fetchedAt
         WHERE elements.source = 'site'`,
  );

  for (const element of prepared.legacyElements) {
    const existing = selectExistingSlug(
      findExisting.all(prepared.slug, element.mediaPath) as Array<{
        slug: string;
        fetchedAt: number;
      }>,
    );
    const record = toLegacyElementRecord(element, existing ?? element.fallbackSlug);
    upsert.run(
      record.slug,
      record.title,
      record.cid,
      record.category,
      record.author,
      record.mediaPath,
      record.mediaType,
      record.siteSlug,
      record.fetchedAt,
    );
  }
}

function selectExistingSlug(
  rows: Array<{ slug: string; fetchedAt: number }>,
): string | undefined {
  let best: { slug: string; at: number | null } | undefined;
  for (const row of rows) {
    const at = normalizeTimestamp(row.fetchedAt);
    if (
      !best ||
      (at !== null && (best.at === null || at > best.at)) ||
      (at === best.at && row.slug.localeCompare(best.slug) < 0)
    ) {
      best = { slug: row.slug, at };
    }
  }
  return best?.slug;
}

function normalizeTimestamp(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < 100_000_000_000 ? value * 1000 : value;
}

function setMeta(db: DatabaseSync, key: string, value: unknown, now: number): void {  db.prepare(
    `INSERT INTO meta (key, value, fetchedAt) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetchedAt = excluded.fetchedAt`,
  ).run(key, JSON.stringify(value), now);
}
