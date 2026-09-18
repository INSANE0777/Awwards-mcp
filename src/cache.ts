import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SiteSummary } from "./types.js";

// Freshness window applied by getSite() when the caller does not pass one.
// Expired lookups are misses (single-arg getSite returns null for rows older
// than this window); getSites(Infinity) remains the stale fallback.
const DEFAULT_SITE_TTL_MS = 10_000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sites (
    slug TEXT PRIMARY KEY, id INTEGER, title TEXT, createdAt INTEGER,
    tags TEXT, thumbnailPath TEXT, liveUrl TEXT, detailPath TEXT,
    awards TEXT, fetchedAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY, value TEXT, fetchedAt INTEGER
  );
`;

// FTS5 full-text layer over the sites table (derived — rebuildable at any
// time). Probe-guarded: if this Node build ships without FTS5, every fts
// statement is skipped and searchSites returns null (server keeps the legacy
// substring path). Columns mirror sites; tags/awards stay JSON strings —
// unicode61 tokenizes around brackets/quotes, so tokens extract cleanly.
const FTS_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS sites_fts USING fts5(
    slug UNINDEXED, title, tags, awards, tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS sites_fts_ai AFTER INSERT ON sites BEGIN
    INSERT INTO sites_fts (slug, title, tags, awards)
    VALUES (new.slug, new.title, new.tags, new.awards);
  END;
  CREATE TRIGGER IF NOT EXISTS sites_fts_au AFTER UPDATE OF title, tags, awards ON sites BEGIN
    DELETE FROM sites_fts WHERE slug = new.slug;
    INSERT INTO sites_fts (slug, title, tags, awards)
    VALUES (new.slug, new.title, new.tags, new.awards);
  END;
  CREATE TRIGGER IF NOT EXISTS sites_fts_ad AFTER DELETE ON sites BEGIN
    DELETE FROM sites_fts WHERE slug = old.slug;
  END;
`;

interface SiteRow {
  slug: string;
  id: number;
  title: string;
  createdAt: number;
  tags: string;
  thumbnailPath: string;
  liveUrl: string | null;
  detailPath: string;
  awards: string;
  fetchedAt: number;
}

function rowToSite(r: SiteRow): SiteSummary {
  return {
    slug: r.slug,
    id: r.id,
    title: r.title,
    createdAt: r.createdAt,
    tags: JSON.parse(r.tags),
    thumbnailPath: r.thumbnailPath,
    liveUrl: r.liveUrl,
    detailPath: r.detailPath,
    awards: JSON.parse(r.awards),
  };
}

export class Cache {
  private readonly dbPath: string;
  private readonly now: () => number;
  readonly imagesDir: string;
  // FTS5 capability of this Node build, probed on the first DB open (the
  // constructor's eager withDb). null = not yet probed; false = FTS5 compiled
  // out → searchSites returns null and callers keep the legacy substring
  // path. Instance-cached so searchSites never re-probes; public so the
  // server layer and tests can branch on it.
  ftsAvailable: boolean | null = null;

  constructor(rootDir: string, now: () => number = Date.now) {
    this.now = now;
    mkdirSync(rootDir, { recursive: true });
    this.imagesDir = join(rootDir, "images");
    mkdirSync(this.imagesDir, { recursive: true });
    this.dbPath = join(rootDir, "cache.db");
    // Create cache.db + schema eagerly so the storage layout exists right
    // after construction. The handle is closed immediately (see withDb).
    this.withDb(() => {});
  }

  // Open → run → close per operation. node:sqlite keeps cache.db open until
  // close(); on Windows an open handle makes the file and its directory
  // undeletable, which broke temp-dir cleanup in tests. Per-operation
  // open/close keeps the same public API with no lingering handles.
  private withDb<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.dbPath);
    try {
      db.exec(SCHEMA);
      if (this.ftsAvailable === null) {
        try {
          db.exec(FTS_SCHEMA);
          this.ftsAvailable = true;
        } catch {
          this.ftsAvailable = false; // FTS5 compiled out → legacy fallback
        }
      }
      if (this.ftsAvailable) {
        // The fts table is derived and must never gate correctness: if sites
        // has rows but sites_fts is empty (pre-FTS database opened for the
        // first time), rebuild the index. The guard lives inside the INSERT
        // itself (slug NOT IN sites_fts), not only in the counts above: the
        // counts are read non-atomically, so `npm run index` and a first open
        // can both pass them and both run this statement — sites_fts.slug has
        // no unique constraint, so an unguarded re-run would double-index.
        // Afterwards triggers keep it synced.
        const { s: sitesN } = db.prepare("SELECT COUNT(*) AS s FROM sites").get() as { s: number };
        const { s: ftsN } = db.prepare("SELECT COUNT(*) AS s FROM sites_fts").get() as { s: number };
        if (sitesN > 0 && ftsN === 0) {
          db.exec("INSERT INTO sites_fts (slug, title, tags, awards) SELECT slug, title, tags, awards FROM sites WHERE slug NOT IN (SELECT slug FROM sites_fts)");
        }
      }
      return fn(db);
    } finally {
      db.close();
    }
  }

  /** @visibleForTesting */
  withDbForTest(fn: (db: DatabaseSync) => void): void {
    this.withDb(fn);
  }

  upsertSites(sites: SiteSummary[]): void {
    this.withDb((db) => {
      const stmt = db.prepare(
        `INSERT INTO sites (slug, id, title, createdAt, tags, thumbnailPath, liveUrl, detailPath, awards, fetchedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           id=excluded.id, title=excluded.title, createdAt=excluded.createdAt,
           tags=excluded.tags, thumbnailPath=excluded.thumbnailPath,
           liveUrl=excluded.liveUrl, detailPath=excluded.detailPath,
           awards=excluded.awards, fetchedAt=excluded.fetchedAt`,
      );
      const t = this.now();
      // One transaction for the whole batch: each autocommitted INSERT pays a
      // disk sync (~4ms on Windows), which made a 31-card upsert ~150ms and a
      // full index crawl take minutes. A single commit syncs once.
      db.exec("BEGIN");
      try {
        for (const s of sites) {
          stmt.run(
            s.slug, s.id, s.title, s.createdAt, JSON.stringify(s.tags),
            s.thumbnailPath, s.liveUrl, s.detailPath, JSON.stringify(s.awards), t,
          );
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  getSites(maxAgeMs: number): SiteSummary[] {
    return this.withDb((db) => {
      const min = this.now() - maxAgeMs;
      const rows = db.prepare(
        "SELECT * FROM sites WHERE fetchedAt > ? ORDER BY createdAt DESC",
      ).all(min) as unknown as SiteRow[];
      return rows.map(rowToSite);
    });
  }

  getSite(slug: string, maxAgeMs: number = DEFAULT_SITE_TTL_MS): SiteSummary | null {
    return this.withDb((db) => {
      const row = db.prepare("SELECT * FROM sites WHERE slug = ?").get(slug) as
        | SiteRow
        | undefined;
      if (!row || row.fetchedAt <= this.now() - maxAgeMs) return null;
      return rowToSite(row);
    });
  }

  // Full-text search over cached sites. matchMode "AND" (default) requires
  // every token; "OR" matches rows containing any token (the server uses OR
  // for its zero-result "loose matches" hint). Each token is a porter-stemmed
  // prefix term, so multi-word queries match rows where the words are
  // scattered across title/tags/awards. Results are bm25-ascending (best
  // match first). Returns null when FTS5 is unavailable on this build or the
  // query has no usable tokens — callers fall back to legacy search.
  searchSites(
    query: string,
    maxAgeMs: number,
    limit = 200,
    matchMode: "AND" | "OR" = "AND",
  ): SiteSummary[] | null {
    // Sanitization strips quotes/parens/operators, leaving [a-z0-9-] only —
    // the quoted `"tok"*` MATCH string below cannot inject FTS syntax.
    const tokens = query.toLowerCase().split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9-]/g, ""))
      .filter((t) => t.length > 0);
    if (!tokens.length) return null;
    return this.withDb((db) => {
      if (!this.ftsAvailable) return null;
      const match = tokens.map((t) => `"${t}"*`).join(matchMode === "OR" ? " OR " : " AND ");
      const min = this.now() - maxAgeMs;
      const rows = db.prepare(
        `SELECT s.* FROM sites_fts
         JOIN sites s ON s.slug = sites_fts.slug
         WHERE sites_fts MATCH ? AND s.fetchedAt > ?
         ORDER BY bm25(sites_fts) ASC
         LIMIT ?`,
      ).all(match, min, limit) as unknown as SiteRow[];
      return rows.map(rowToSite);
    });
  }

  setMeta(key: string, value: unknown): void {
    this.withDb((db) => {
      db.prepare(
        `INSERT INTO meta (key, value, fetchedAt) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, fetchedAt=excluded.fetchedAt`,
      ).run(key, JSON.stringify(value), this.now());
    });
  }

  getMeta<T>(key: string, maxAgeMs: number): T | null {
    return this.withDb((db) => {
      const row = db.prepare("SELECT value, fetchedAt FROM meta WHERE key = ?").get(key) as
        | { value: string; fetchedAt: number }
        | undefined;
      if (!row || row.fetchedAt <= this.now() - maxAgeMs) return null;
      return JSON.parse(row.value) as T;
    });
  }

  deleteMeta(key: string): void {
    this.withDb((db) => {
      db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    });
  }

  // Disk cache keyed by the awwwards asset path (immutable content → no TTL).
  async getImage(assetPath: string, fetcher: () => Promise<Buffer>): Promise<Buffer> {
    const ext = assetPath.endsWith(".png") ? ".png" : ".jpg";
    const file = join(this.imagesDir, createHash("sha1").update(assetPath).digest("hex") + ext);
    try {
      return await readFile(file);
    } catch {
      const buf = await fetcher();
      await writeFile(file, buf);
      return buf;
    }
  }
}
