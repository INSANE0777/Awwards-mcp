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
      return fn(db);
    } finally {
      db.close();
    }
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
      for (const s of sites) {
        stmt.run(
          s.slug, s.id, s.title, s.createdAt, JSON.stringify(s.tags),
          s.thumbnailPath, s.liveUrl, s.detailPath, JSON.stringify(s.awards), t,
        );
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
