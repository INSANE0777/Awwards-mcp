import type { Cache } from "../cache.js";
import type { AliasResolution, AtlasAliasKind } from "./types.js";

/**
 * Resolves a legacy slug to the Atlas highlight region(s) that currently
 * reference it. Ambiguity is explicit: the caller gets every match and no
 * arbitrary winner.
 */
export function resolveAlias(
  cache: Cache,
  aliasKind: AtlasAliasKind,
  alias: string,
): AliasResolution {
  if (!cache.atlas) return { status: "not_found", aliasKind, alias };
  const rows = cache.withAtlasDb(
    (db) =>
      db
        .prepare(
          `SELECT a.region_id, r.capture_id, c.page_id, p.site_slug
           FROM atlas_aliases a
           JOIN atlas_regions r ON r.id = a.region_id
           JOIN atlas_captures c ON c.id = r.capture_id
           JOIN atlas_pages p ON p.id = c.page_id
           WHERE a.alias_kind = ? AND a.alias = ?
           ORDER BY a.region_id`,
        )
        .all(aliasKind, alias) as Array<{
        region_id: string;
        capture_id: string;
        page_id: string;
        site_slug: string;
      }>,
  );

  if (rows.length === 0) return { status: "not_found", aliasKind, alias };
  if (rows.length > 1) {
    return {
      status: "ambiguous",
      code: "AMBIGUOUS_ALIAS",
      aliasKind,
      alias,
      regionIds: rows.map((row) => row.region_id),
    };
  }
  const row = rows[0]!;
  return {
    status: "resolved",
    aliasKind,
    alias,
    regionId: row.region_id,
    captureId: row.capture_id,
    pageId: row.page_id,
    siteSlug: row.site_slug,
  };
}
