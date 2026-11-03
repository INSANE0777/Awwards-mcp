import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalizeTechnology } from "./awwwards.js";
import type { ElementRecord, MotionDna, SiteSummary } from "./types.js";

// Freshness window applied by getSite() when the caller does not pass one.
// Expired lookups are misses (single-arg getSite returns null for rows older
// than this window); getSites(Infinity) remains the stale fallback.
const DEFAULT_SITE_TTL_MS = 10_000;
// SQLite write-lock wait for the per-operation open/close handles. Without it
// a second process (indexer vs server, two servers) fails immediately with
// SQLITE_BUSY instead of waiting for the short write transaction.
const BUSY_TIMEOUT_MS = 5_000;
// Keys per IN (...) statement. Keeps the bound-variable count well under
// SQLite's default 999 limit on older builds/builds configured low.
const META_KEY_CHUNK = 500;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sites (
    slug TEXT PRIMARY KEY, id INTEGER, title TEXT, createdAt INTEGER,
    tags TEXT, thumbnailPath TEXT, liveUrl TEXT, detailPath TEXT,
    awards TEXT, studio TEXT, nominee INTEGER, fetchedAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY, value TEXT, fetchedAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS elements (
    slug TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    cid TEXT,               -- normalized category id (Task 5 fills the taxonomy; raw title until then)
    category TEXT,
    author TEXT,
    builtWith TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
    related TEXT NOT NULL DEFAULT '[]',     -- JSON string[]
    mediaPath TEXT,
    mediaType TEXT,                         -- 'video' | 'image' | NULL
    source TEXT NOT NULL,                   -- 'gallery' | 'site'
    projectId TEXT,
    siteSlug TEXT,                          -- Task 5 pairing: owning /sites/<slug>
    fetchedAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS motion_dna (
    url TEXT PRIMARY KEY,
    data TEXT NOT NULL,      -- whole MotionDna record as JSON — small corpus, filters run in JS
    capturedAt INTEGER NOT NULL
  );
`;

// FTS5 layer over the elements table — same standalone variant as sites_fts
// (columns stored in the fts table itself, triggers delete+reinsert by the
// unindexed slug; NOT the external-content content= variant). builtWith stays
// a JSON string — unicode61 tokenizes around brackets/quotes, so tokens
// extract cleanly. v2: slug is an indexed column (slug tokens like "countup"
// search directly); ELEMENTS_FTS_VERSION gates a drop/recreate/reindex
// migration for databases created before the change.
const ELEMENTS_FTS_VERSION = 2;
const ELEMENTS_FTS_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS elements_fts USING fts5(
    slug, title, author, builtWith, category, tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS elements_fts_ai AFTER INSERT ON elements BEGIN
    INSERT INTO elements_fts (slug, title, author, builtWith, category)
    VALUES (new.slug, new.title, new.author, new.builtWith, new.category);
  END;
  CREATE TRIGGER IF NOT EXISTS elements_fts_au AFTER UPDATE OF title, author, builtWith, category ON elements BEGIN
    DELETE FROM elements_fts WHERE slug = new.slug;
    INSERT INTO elements_fts (slug, title, author, builtWith, category)
    VALUES (new.slug, new.title, new.author, new.builtWith, new.category);
  END;
  CREATE TRIGGER IF NOT EXISTS elements_fts_ad AFTER DELETE ON elements BEGIN
    DELETE FROM elements_fts WHERE slug = old.slug;
  END;
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
  studio: string | null;
  nominee: number | null;
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
    studio: r.studio ?? null,
    nominee: r.nominee === 1 ? true : undefined,
  };
}

/** Pre-LIMIT element filters shared by the FTS and recent-list paths. */
export interface ElementSearchFilter {
  category?: string;
  stack?: string[];
}

// SQL conditions (alias `e` = elements) for ElementSearchFilter. Stack keeps
// the old handler semantics — case-insensitive substring over the builtWith
// array — by matching the JSON text; "%"/"_"/"\" are escaped so they stay
// literal. lower() folds ASCII only, which covers Awwwards stack tokens.
function elementFilterConditions(filter?: ElementSearchFilter): {
  conditions: string[];
  params: string[];
} {
  const conditions: string[] = [];
  const params: string[] = [];
  if (filter?.category) {
    conditions.push("e.cid = ?");
    params.push(filter.category);
  }
  for (const term of filter?.stack ?? []) {
    // Decode the JSON array and rejoin with spaces, preserving the original
    // "joined names" substring semantics without matching JSON syntax.
    conditions.push(
      "(CASE WHEN json_valid(e.builtWith) THEN COALESCE((SELECT lower(group_concat(value, ' ')) FROM json_each(e.builtWith)), '') ELSE '' END) LIKE ? ESCAPE '\\'",
    );
    params.push(`%${term.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  return { conditions, params };
}

interface ElementRow {
  slug: string;
  title: string;
  cid: string | null;
  category: string | null;
  author: string | null;
  builtWith: string;
  related: string;
  mediaPath: string | null;
  mediaType: "video" | "image" | null;
  source: "gallery" | "site";
  projectId: string | null;
  siteSlug: string | null;
  fetchedAt: number;
}

function rowToElement(r: ElementRow): ElementRecord {
  return {
    slug: r.slug,
    title: r.title,
    cid: r.cid ?? "",
    category: r.category ?? "",
    author: r.author ?? "",
    builtWith: JSON.parse(r.builtWith),
    related: JSON.parse(r.related),
    mediaPath: r.mediaPath ?? "",
    mediaType: r.mediaType,
    source: r.source,
    projectId: r.projectId,
    siteSlug: r.siteSlug,
    fetchedAt: r.fetchedAt,
  };
}

export class Cache {
  private readonly dbPath: string;
  private readonly now: () => number;
  readonly rootDir: string;
  readonly imagesDir: string;
  // In-flight image writes keyed by target file. Parallel previews of the same
  // thumbnail share one fetch/write instead of racing two renames onto it.
  private readonly imageWrites = new Map<string, Promise<Buffer>>();
  // FTS5 capability of this Node build, probed on the first DB open (the
  // constructor's eager withDb). null = not yet probed; false = FTS5 compiled
  // out → searchSites returns null and callers keep the legacy substring
  // path. Instance-cached so searchSites never re-probes; public so the
  // server layer and tests can branch on it.
  ftsAvailable: boolean | null = null;

  constructor(rootDir: string, now: () => number = Date.now) {
    this.now = now;
    // 0700/0600 keep the cache (tokens, page text) private to the OS user.
    // Windows ignores POSIX modes, so passing them must not fail there.
    mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    this.rootDir = rootDir;
    this.imagesDir = join(rootDir, "images");
    mkdirSync(this.imagesDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      // Repair pre-existing permissive installs; Windows ignores POSIX modes.
      try {
        chmodSync(rootDir, 0o700);
        chmodSync(this.imagesDir, 0o700);
      } catch {
        /* best effort on read-only or foreign-owned dirs */
      }
    }
    this.pruneImages();
    this.dbPath = join(rootDir, "cache.db");
    if (process.platform !== "win32") {
      let fd: number | undefined;
      try {
        fd = openSync(this.dbPath, "a", 0o600);
        chmodSync(this.dbPath, 0o600);
      } catch {
        /* SQLite will surface a real permission error */
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    // Create cache.db + schema eagerly so the storage layout exists right
    // after construction. The handle is closed immediately (see withDb).
    this.withDb(() => {});
  }

  // Opt-in retention: AWWWARDS_MCP_IMAGE_RETENTION_DAYS=N (legacy
  // AWARDS_MCP_IMAGE_RETENTION_DAYS also accepted) prunes image files older
  // than N days once at construction. Best-effort: an unreadable or locked
  // file never blocks opening the cache; 0/unset keeps images forever.
  private pruneImages(): void {
    const raw =
      process.env.AWWWARDS_MCP_IMAGE_RETENTION_DAYS ??
      process.env.AWARDS_MCP_IMAGE_RETENTION_DAYS ??
      0;
    const days = Number(raw);
    if (!Number.isFinite(days) || days <= 0) return;
    const cutoff = this.now() - days * 24 * 60 * 60 * 1000;
    try {
      for (const name of readdirSync(this.imagesDir)) {
        const path = join(this.imagesDir, name);
        try {
          const st = statSync(path);
          if (st.isFile() && st.mtimeMs < cutoff) rmSync(path, { force: true });
        } catch {
          /* skip unreadable/locked entry */
        }
      }
    } catch {
      /* images dir unreadable — never block construction */
    }
  }

  // Open → run → close per operation. node:sqlite keeps cache.db open until
  // close(); on Windows an open handle makes the file and its directory
  // undeletable, which broke temp-dir cleanup in tests. Per-operation
  // open/close keeps the same public API with no lingering handles.
  private withDb<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.dbPath);
    try {
      // Wait (instead of failing SQLITE_BUSY) when another process holds the
      // short write transaction used by migrations and lock acquisition.
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      db.exec(SCHEMA);
      // Lazy column migration: databases created before Task 5 lack the
      // elements.siteSlug column. CREATE TABLE above adds it for fresh
      // databases; on the old shape this ALTER fires once, then duplicates
      // are caught per-open below (dupes are rare and this open→close path
      // runs on every op, so branch inside try/catch rather than probe).
      try {
        db.exec("ALTER TABLE elements ADD COLUMN siteSlug TEXT");
      } catch {
        /* column already exists */
      }
      // Same lazy migration for sites.studio (monitoring feature) and
      // sites.nominee (nominees-listing flag).
      try {
        db.exec("ALTER TABLE sites ADD COLUMN studio TEXT");
      } catch {
        /* column already exists */
      }
      try {
        db.exec("ALTER TABLE sites ADD COLUMN nominee INTEGER");
      } catch {
        /* column already exists */
      }
      if (this.ftsAvailable === null) {
        // One transaction: an interruption must not leave a partial FTS layer
        // (e.g. the elements_fts table without its sync triggers).
        db.exec("BEGIN IMMEDIATE");
        try {
          db.exec(FTS_SCHEMA);
          db.exec(ELEMENTS_FTS_SCHEMA);
          db.exec("COMMIT");
          this.ftsAvailable = true;
        } catch {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* no transaction left to roll back */
          }
          this.ftsAvailable = false; // FTS5 compiled out → legacy fallback
        }
      }
      if (this.ftsAvailable) {
        // Versioned FTS migration: if elements exists but its fts table was
        // built by an older schema version (e.g. v1 indexed slug as
        // UNINDEXED), drop and rebuild. The elements table itself is the
        // source of truth; the fts table is derived, so the migration is a
        // full reinsert with today's triggers — no data loss, no request.
        const { v } = db.prepare(
          "SELECT COALESCE((SELECT value FROM meta WHERE key = 'elements_fts_version'), '0') AS v",
        ).get() as { v: string };
        if (Number(v) < ELEMENTS_FTS_VERSION) {
          // Re-check inside the write transaction: a second process may have
          // migrated while this one waited on the busy timeout.
          db.exec("BEGIN IMMEDIATE");
          try {
            const { v: current } = db.prepare(
              "SELECT COALESCE((SELECT value FROM meta WHERE key = 'elements_fts_version'), '0') AS v",
            ).get() as { v: string };
            if (Number(current) < ELEMENTS_FTS_VERSION) {
              db.exec("DROP TRIGGER IF EXISTS elements_fts_ai; DROP TRIGGER IF EXISTS elements_fts_au; DROP TRIGGER IF EXISTS elements_fts_ad; DROP TABLE IF EXISTS elements_fts;");
              db.exec(ELEMENTS_FTS_SCHEMA);
              db.exec("INSERT INTO elements_fts (slug, title, author, builtWith, category) SELECT slug, title, author, builtWith, category FROM elements");
              db.prepare("INSERT INTO meta (key, value) VALUES ('elements_fts_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(ELEMENTS_FTS_VERSION));
            }
            db.exec("COMMIT");
          } catch (err) {
            try {
              db.exec("ROLLBACK");
            } catch {
              /* no transaction left to roll back */
            }
            throw err;
          }
        }
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
          db.exec("BEGIN IMMEDIATE");
          try {
            // Same double-check as the migration: the other process may have
            // backfilled while this one waited.
            const { s: sitesAgain } = db.prepare("SELECT COUNT(*) AS s FROM sites").get() as { s: number };
            const { s: ftsAgain } = db.prepare("SELECT COUNT(*) AS s FROM sites_fts").get() as { s: number };
            if (sitesAgain > 0 && ftsAgain === 0) {
              db.exec("INSERT INTO sites_fts (slug, title, tags, awards) SELECT slug, title, tags, awards FROM sites WHERE slug NOT IN (SELECT slug FROM sites_fts)");
            }
            db.exec("COMMIT");
          } catch (err) {
            try {
              db.exec("ROLLBACK");
            } catch {
              /* no transaction left to roll back */
            }
            throw err;
          }
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

  /**
   * Read-only query seam for derived aggregate modules (index-stats). Same
   * per-operation open/close contract as every other cache op.
   */
  withReadDb<T>(fn: (db: DatabaseSync) => T): T {
    return this.withDb(fn);
  }

  upsertSites(sites: SiteSummary[]): void {
    this.withDb((db) => {
      // `nominee` overwrites (current-state semantics): a nominee that later
      // wins is re-crawled from an award listing, and a sticky-true flag
      // would keep claiming nominee forever. `studio` COALESCEs instead — it
      // is an attribution that older crawls lacked, so the first known value
      // wins over a later crawl's null.
      const stmt = db.prepare(
        `INSERT INTO sites (slug, id, title, createdAt, tags, thumbnailPath, liveUrl, detailPath, awards, studio, nominee, fetchedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           id=excluded.id, title=excluded.title, createdAt=excluded.createdAt,
           tags=excluded.tags, thumbnailPath=excluded.thumbnailPath,
           liveUrl=excluded.liveUrl, detailPath=excluded.detailPath,
           awards=excluded.awards, studio=COALESCE(excluded.studio, sites.studio),
           nominee=excluded.nominee, fetchedAt=excluded.fetchedAt`,
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
            s.thumbnailPath, s.liveUrl, s.detailPath, JSON.stringify(s.awards),
            s.studio ?? null, s.nominee === true ? 1 : 0, t,
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

  countSites(): number {
    return this.withDb((db) =>
      (db.prepare("SELECT COUNT(*) AS count FROM sites").get() as { count: number }).count,
    );
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
  // match first). Returns all fresh matches unless a limit is passed (e.g.
  // for OR hints). Returns null when FTS5 is unavailable on this build or the
  // query has no usable tokens — callers fall back to legacy search.
  searchSites(
    query: string,
    maxAgeMs: number,
    limit?: number,
    matchMode: "AND" | "OR" = "AND",
  ): SiteSummary[] | null {
    // Sanitization turns every punctuation run into a token boundary, the way
    // the FTS tokenizer indexes text — "next.js" is ["next", "js"], never a
    // glued "nextjs" that matches nothing. Split BEFORE alias expansion so a
    // wrapped alias ("nextjs,", "(nextjs)") is still recognized, then split
    // again because aliases resolve to hyphenated slugs. Letters of any script
    // stay intact. The quoted `"tok"*` MATCH string below cannot inject FTS
    // syntax.
    const tokens = query.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u)
      .flatMap((t) => canonicalizeTechnology(t).split(/[^\p{L}\p{M}\p{N}]+/u))
      .filter((t) => t.length > 0);
    if (!tokens.length) return null;
    return this.withDb((db) => {
      if (!this.ftsAvailable) return null;
      const match = tokens.map((t) => `"${t}"*`).join(matchMode === "OR" ? " OR " : " AND ");
      const min = this.now() - maxAgeMs;
      const stmt = db.prepare(
        `SELECT s.* FROM sites_fts
         JOIN sites s ON s.slug = sites_fts.slug
         WHERE sites_fts MATCH ? AND s.fetchedAt > ?
         ORDER BY bm25(sites_fts) ASC${limit === undefined ? "" : " LIMIT ?"}`,
      );
      const rows = (limit === undefined ? stmt.all(match, min) : stmt.all(match, min, limit)) as unknown as SiteRow[];
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

  /**
   * TTL-filtered meta read for a candidate list: one DB open and a bounded
   * number of IN (...) statements instead of one open per key. Missing,
   * expired, or malformed rows are simply absent from the map, so callers
   * keep their normal "no value" fallback.
   */
  getMetaMany<T>(keys: string[], maxAgeMs: number): Map<string, T> {
    const values = new Map<string, T>();
    if (keys.length === 0) return values;
    return this.withReadDb((db) => {
      const min = this.now() - maxAgeMs;
      for (let i = 0; i < keys.length; i += META_KEY_CHUNK) {
        const chunk = keys.slice(i, i + META_KEY_CHUNK);
        const rows = db.prepare(
          `SELECT key, value FROM meta WHERE key IN (${chunk.map(() => "?").join(",")}) AND fetchedAt > ?`,
        ).all(...chunk, min) as { key: string; value: string }[];
        for (const row of rows) {
          try {
            values.set(row.key, JSON.parse(row.value) as T);
          } catch {
            /* malformed cached JSON counts as missing */
          }
        }
      }
      return values;
    });
  }

  /**
   * Atomic cross-process lock stored as a meta row. BEGIN IMMEDIATE serializes
   * contenders (busy_timeout waits for the winner); a stale row is replaced
   * inside the same transaction, so two processes can never both acquire.
   * Release deletes only the exact value this process wrote (pid/start/token),
   * never another owner's lock.
   */
  acquireMetaLock(
    key: string,
    staleMs: number,
    now: number = this.now(),
  ): { token: string; release: () => void } | null {
    const token = randomUUID();
    const startedAt = now;
    const value = JSON.stringify({ pid: process.pid, startedAt, token });
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
          | { value: string }
          | undefined;
        if (row) {
          let ownerStart: number | null = null;
          try {
            const parsed = JSON.parse(row.value) as { startedAt?: unknown };
            if (typeof parsed?.startedAt === "number" && Number.isFinite(parsed.startedAt)) {
              ownerStart = parsed.startedAt;
            }
          } catch {
            /* malformed legacy lock: treated as stale below */
          }
          // Malformed/half-written locks have no trustworthy age; treating
          // them as stale is safe because acquisition is serialized here.
          if (ownerStart !== null && startedAt - ownerStart < staleMs) {
            db.exec("ROLLBACK");
            return null;
          }
        }
        db.prepare(
          `INSERT INTO meta (key, value, fetchedAt) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, fetchedAt=excluded.fetchedAt`,
        ).run(key, value, startedAt);
        db.exec("COMMIT");
        return {
          token,
          release: () => {
            this.withDb((releaseDb) => {
              releaseDb.prepare("DELETE FROM meta WHERE key = ? AND value = ?").run(key, value);
            });
          },
        };
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* no transaction left to roll back */
        }
        throw err;
      }
    });
  }

  deleteMeta(key: string): void {
    this.withDb((db) => {
      db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    });
  }

  // All meta rows whose key starts with prefix — watchlist storage keeps one
  // key per watch, so listing needs a scan rather than an exact key.
  listMetaPrefix<T>(prefix: string): T[] {
    return this.withDb((db) => {
      const rows = db
        .prepare("SELECT value FROM meta WHERE key LIKE ? ESCAPE '\\' ORDER BY key")
        .all(prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + "%") as { value: string }[];
      return rows.map((r) => JSON.parse(r.value) as T);
    });
  }

  // ---- elements (gallery items) ----

  upsertElements(records: ElementRecord[]): void {
    if (records.length === 0) return;
    this.withDb((db) => {
      const stmt = db.prepare(
        `INSERT INTO elements (slug, title, cid, category, author, builtWith, related, mediaPath, mediaType, source, projectId, siteSlug, fetchedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           title=excluded.title, cid=excluded.cid, category=excluded.category,
           author=excluded.author, builtWith=excluded.builtWith, related=excluded.related,
           mediaPath=excluded.mediaPath, mediaType=excluded.mediaType,
           source=excluded.source, projectId=excluded.projectId, siteSlug=excluded.siteSlug,
           fetchedAt=excluded.fetchedAt`,
      );
      // One transaction for the whole batch — same reason as upsertSites.
      db.exec("BEGIN");
      try {
        for (const r of records) {
          stmt.run(
            r.slug, r.title, r.cid, r.category, r.author,
            JSON.stringify(r.builtWith), JSON.stringify(r.related),
            r.mediaPath, r.mediaType, r.source, r.projectId, r.siteSlug, r.fetchedAt,
          );
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  getElements(slugs: string[]): ElementRecord[] {
    if (slugs.length === 0) return [];
    return this.withDb((db) => {
      const rows = db.prepare(
        `SELECT * FROM elements WHERE slug IN (${slugs.map(() => "?").join(",")})`,
      ).all(...slugs) as unknown as ElementRow[];
      return rows.map(rowToElement);
    });
  }

  // Full-text search over elements. Caller passes a prebuilt FTS query (the
  // server layer owns sanitization/token shaping). Raw FTS match over ALL
  // rows — NO Tier A filter here: any source='gallery' gating is the caller's
  // job (Task 5). No TTL: element rows are reused across gallery pages,
  // staleness is not a correctness gate. `filter` runs in SQL before LIMIT so
  // matches ranked outside the first N rows are not lost.
  searchElements(ftsQuery: string, limit: number, filter?: ElementSearchFilter): ElementRecord[] {
    const { conditions, params } = elementFilterConditions(filter);
    return this.withDb((db) => {
      if (!this.ftsAvailable) return [];
      const rows = db.prepare(
        `SELECT e.* FROM elements_fts
         JOIN elements e ON e.slug = elements_fts.slug
         WHERE elements_fts MATCH ?${conditions.map((c) => ` AND ${c}`).join("")}
         ORDER BY bm25(elements_fts) ASC
         LIMIT ?`,
      ).all(ftsQuery, ...params, limit) as unknown as ElementRow[];
      return rows.map(rowToElement);
    });
  }

  countElements(): number {
    return this.withDb((db) =>
      (db.prepare("SELECT COUNT(*) AS count FROM elements WHERE source='gallery'").get() as { count: number }).count,
    );
  }

  // `filter` runs before LIMIT, like searchElements. With no filter this is
  // the same recent-list query as before.
  listElements(limit: number, filter?: ElementSearchFilter): ElementRecord[] {
    const { conditions, params } = elementFilterConditions(filter);
    return this.withDb((db) => {
      const rows = db.prepare(
        `SELECT e.* FROM elements e${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY CASE WHEN e.fetchedAt < 100000000000 THEN e.fetchedAt * 1000 ELSE e.fetchedAt END DESC LIMIT ?`,
      ).all(...params, limit) as unknown as ElementRow[];
      return rows.map(rowToElement);
    });
  }

  // Disk cache keyed by the awwwards asset path (immutable content → no TTL).
  // Private mode + temp-then-rename: a concurrent or interrupted write can
  // never leave a truncated image that later reads treat as a cache hit.
  async getImage(assetPath: string, fetcher: () => Promise<Buffer>): Promise<Buffer> {
    const ext = assetPath.endsWith(".png") ? ".png" : ".jpg";
    const file = join(this.imagesDir, createHash("sha1").update(assetPath).digest("hex") + ext);
    try {
      return await readFile(file);
    } catch {
      /* miss: fetch below */
    }
    const inflight = this.imageWrites.get(file);
    if (inflight) return inflight;
    const write = (async () => {
      const buf = await fetcher();
      const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, buf, { mode: 0o600 });
        await rename(tmp, file);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      return buf;
    })().finally(() => {
      this.imageWrites.delete(file);
    });
    this.imageWrites.set(file, write);
    return write;
  }

  // ---- motion dna ----

  upsertMotionDna(dna: MotionDna): void {
    this.withDb((db) => {
      db.prepare(
        `INSERT INTO motion_dna (url, data, capturedAt) VALUES (?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET data=excluded.data, capturedAt=excluded.capturedAt`,
      ).run(dna.url, JSON.stringify(dna), dna.capturedAt);
    });
  }

  getMotionDna(url: string): MotionDna | null {
    return this.withDb((db) => {
      const row = db.prepare("SELECT data FROM motion_dna WHERE url = ?").get(url) as
        | { data: string }
        | undefined;
      return row ? (JSON.parse(row.data) as MotionDna) : null;
    });
  }

  // JS filter over parsed records: small corpora make SQL columns premature.
  // scrubOnly matches the brief exactly: scrubCount >= 2 OR scrubRatio >= 0.5.
  searchMotion(filter: { lib?: string; scrubOnly?: boolean; hasPins?: boolean }): MotionDna[] {
    return this.withDb((db) => {
      const rows = db.prepare("SELECT data FROM motion_dna").all() as { data: string }[];
      return rows
        .map((r) => JSON.parse(r.data) as MotionDna)
        .filter((d) => {
          if (filter.lib && !d.stack.libs.includes(filter.lib)) return false;
          if (filter.scrubOnly && !(d.scroll.scrubCount >= 2 || d.scroll.scrubRatio >= 0.5)) return false;
          if (filter.hasPins && d.scroll.pinCount === 0) return false;
          return true;
        });
    });
  }
}
