import type { DatabaseSync } from "node:sqlite";

/** Restore gallery aliases only when no site highlight alias survived. */
export function restoreGalleryAliases(db: DatabaseSync, siteSlug: string): void {
  const rows = db
    .prepare(
      `SELECT e.slug AS alias, r.id AS region_id
       FROM elements e
       JOIN atlas_pages p
         ON p.site_slug = e.siteSlug
        AND p.kind = 'legacy_gallery'
        AND p.url_key = 'inspiration:' || e.slug
       JOIN atlas_captures c ON c.page_id = p.id AND c.source_kind = 'legacy_gallery'
       JOIN atlas_heads h
         ON h.capture_id = c.id AND h.page_id = c.page_id AND h.profile_key = c.profile_key
       JOIN atlas_regions r
         ON r.capture_id = c.id
        AND r.kind = 'component'
        AND json_extract(r.samples_json, '$.gallerySlug') = e.slug
       WHERE e.source = 'gallery' AND e.siteSlug = ?
       ORDER BY e.slug`,
    )
    .all(siteSlug) as Array<{ alias: string; region_id: string }>;
  const insert = db.prepare(
    `INSERT INTO atlas_aliases (alias_kind, alias, region_id)
     SELECT 'legacy_gallery_slug', ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM atlas_aliases
       WHERE alias_kind = 'legacy_gallery_slug' AND alias = ?
     )`,
  );
  for (const row of rows) insert.run(row.alias, row.region_id, row.alias);
}

/**
 * Remove a head and every projection derived from it. Callers that batch
 * removals can pass bumpRevision=false and bump once themselves.
 */
export function removeHead(
  db: DatabaseSync,
  page: string,
  profile: string,
  now: number,
  siteSlug?: string,
  bumpRevision = true,
): boolean {
  const head = db
    .prepare("SELECT capture_id FROM atlas_heads WHERE page_id = ? AND profile_key = ?")
    .get(page, profile) as { capture_id: string } | undefined;
  if (!head) return false;
  const otherHead = db
    .prepare(
      `SELECT 1 FROM atlas_heads
       WHERE capture_id = ? AND NOT (page_id = ? AND profile_key = ?)`,
    )
    .get(head.capture_id, page, profile);
  const ftsTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'atlas_regions_fts'")
    .get();
  if (!otherHead && ftsTable) {
    db.prepare(
      "DELETE FROM atlas_regions_fts WHERE region_id IN (SELECT id FROM atlas_regions WHERE capture_id = ?)",
    ).run(head.capture_id);
  }
  if (!otherHead) {
    db.prepare(
      "DELETE FROM atlas_aliases WHERE region_id IN (SELECT id FROM atlas_regions WHERE capture_id = ?)",
    ).run(head.capture_id);
  }
  db.prepare("DELETE FROM atlas_heads WHERE page_id = ? AND profile_key = ?").run(page, profile);
  if (!otherHead && siteSlug) restoreGalleryAliases(db, siteSlug);
  if (bumpRevision) {
    db.prepare(
      "UPDATE atlas_state SET revision = revision + 1, updated_at = ? WHERE singleton = 1",
    ).run(now);
  }
  return true;
}
