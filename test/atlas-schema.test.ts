import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Cache } from "../src/cache.js";
import { prepareSitePage } from "../src/atlas/ingest.js";
import { AtlasStore } from "../src/atlas/store.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-test-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ATLAS_TABLES = [
  "atlas_aliases",
  "atlas_artifacts",
  "atlas_captures",
  "atlas_claims",
  "atlas_heads",
  "atlas_pages",
  "atlas_packs",
  "atlas_regions",
  "atlas_state",
];

const listAtlasTables = (cache: Cache) =>
  cache.withReadDb(
    (db) =>
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name LIKE 'atlas_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>,
  ).map((row) => row.name);

describe("atlas schema", () => {
  it("is disabled by default and creates no Atlas tables", () => {
    vi.stubEnv("AWWWARDS_MCP_ATLAS", "0");
    const cache = new Cache(tmpDir(), () => 1_700_000_000_000);
    expect(listAtlasTables(cache)).toEqual([]);
  });

  it("creates the versioned schema when the cache option enables Atlas", () => {
    vi.stubEnv("AWWWARDS_MCP_ATLAS", "0");
    const cache = new Cache(tmpDir(), () => 1_700_000_000_000, { atlas: true });
    expect(listAtlasTables(cache)).toEqual(expect.arrayContaining(ATLAS_TABLES));

    const state = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT schema_version, fts_version, revision FROM atlas_state WHERE singleton = 1")
          .get() as { schema_version: number; fts_version: number; revision: number },
    );
    expect(state.schema_version).toBe(6);
    expect([0, 2]).toContain(state.fts_version);
    expect(state.revision).toBe(0);
    if (state.fts_version === 2) {
      const fts = cache.withAtlasDb((db) =>
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'atlas_regions_fts'").get(),
      );
      expect(fts).toBeTruthy();
    }
  });

  it("keeps Atlas off when the option overrides the environment flag", () => {
    vi.stubEnv("AWWWARDS_MCP_ATLAS", "1");
    const cache = new Cache(tmpDir(), () => 1_700_000_000_000, { atlas: false });
    expect(listAtlasTables(cache)).toEqual([]);
  });

  it("is idempotent across cache opens", () => {
    vi.stubEnv("AWWWARDS_MCP_ATLAS", "1");
    const root = tmpDir();
    const first = new Cache(root, () => 1_700_000_000_000);
    const before = first.withAtlasDb((db) =>
      db.prepare("SELECT updated_at, revision FROM atlas_state WHERE singleton = 1").get(),
    );
    const second = new Cache(root, () => 1_700_000_100_000);
    const after = second.withAtlasDb((db) =>
      db.prepare("SELECT updated_at, revision FROM atlas_state WHERE singleton = 1").get(),
    );
    expect(after).toEqual(before);
  });

  it("rejects a newer Atlas schema instead of downgrading it", () => {
    vi.stubEnv("AWWWARDS_MCP_ATLAS", "1");
    const root = tmpDir();
    const cache = new Cache(root, () => 1_700_000_000_000);
    cache.withAtlasDb((db) =>
      db.prepare("UPDATE atlas_state SET schema_version = 999 WHERE singleton = 1").run(),
    );
    expect(() => new Cache(root, () => 1_700_000_000_000)).toThrow(
      /newer than supported/,
    );
  });

  it("enforces exactly one page root per published capture", async () => {
    const fixture = readFileSync(join("test", "fixtures", "detail.html"), "utf8");
    const cache = new Cache(tmpDir(), () => 1_700_000_000_000, { atlas: true });
    const prepared = prepareSitePage({
      slug: "fixture-site",
      html: fixture,
      fetchedAt: 1_700_000_000_000,
      sourceUrl: "https://www.awwwards.com/sites/fixture-site",
      summary: null,
    });
    const result = await new AtlasStore(cache).commitSitePage(prepared);

    expect(() =>
      cache.withAtlasDb((db) =>
        db
          .prepare(
            `INSERT INTO atlas_regions
               (id, capture_id, kind, ordinal, samples_json, coverage_json)
             VALUES ('second-root', ?, 'page', 1, '{}', '{}')`,
          )
          .run(result.captureId),
      ),
    ).toThrow(/UNIQUE constraint failed/);

    const root = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT id FROM atlas_regions WHERE capture_id = ? AND kind = 'page'")
          .get(result.captureId) as { id: string },
    );
    expect(() =>
      cache.withAtlasDb((db) =>
        db.prepare("DELETE FROM atlas_regions WHERE id = ?").run(root.id),
      ),
    ).toThrow(/cannot delete the page root/);
    expect(() =>
      cache.withAtlasDb((db) =>
        db.prepare("UPDATE atlas_regions SET kind = 'component' WHERE id = ?").run(root.id),
      ),
    ).toThrow(/cannot retarget the page root/);
    expect(() =>
      cache.withAtlasDb((db) =>
        db.prepare("UPDATE atlas_regions SET parent_id = 'other' WHERE id = ?").run(root.id),
      ),
    ).toThrow(/cannot retarget the page root/);
  });

  it("refuses an active head whose capture has no page root", () => {
    const cache = new Cache(tmpDir(), () => 1_700_000_000_000, { atlas: true });
    expect(() =>
      cache.withAtlasDb((db) => {
        db.prepare(
          `INSERT INTO atlas_pages (id, site_slug, kind, url_key, public_url, path, created_at)
           VALUES ('page-x', 'rootless', 'awwwards_item', 'https://x.test', 'https://x.test', '/', 1)`,
        ).run();
        db.prepare(
          `INSERT INTO atlas_captures
             (id, attempt_id, page_id, source_kind, profile_key, config_hash, status,
              started_at, finished_at, config_json, policy_json, coverage_json,
              extractor_version, classifier_version)
           VALUES ('cap-x', 'attempt-x', 'page-x', 'awwwards_item', 'source', 'hash', 'running',
              1, NULL, '{}', '{}', '{}', 'extractor', 'classifier')`,
        ).run();
        expect(() =>
          db
            .prepare("UPDATE atlas_captures SET status = 'partial' WHERE id = 'cap-x'")
            .run(),
        ).toThrow(/exactly one page root/);
        db.prepare(
          "INSERT INTO atlas_heads (page_id, profile_key, capture_id, published_at) VALUES ('page-x', 'source', 'cap-x', 1)",
        ).run();
      }),
    ).toThrow(/exactly one page root/);
  });

  it("cleans historical FTS rows when upgrading to the invariant schema", () => {
    const root = tmpDir();
    const cache = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    const ftsVersion = cache.withAtlasDb(
      (db) =>
        (db.prepare("SELECT fts_version FROM atlas_state WHERE singleton = 1").get() as {
          fts_version: number;
        }).fts_version,
    );
    if (ftsVersion === 0) return;
    cache.withAtlasDb((db) => {
      db.prepare(
        "INSERT INTO atlas_regions_fts (region_id, title, heading, copy, labels, context) VALUES ('orphan', 'old', '', '', '', '')",
      ).run();
      db.prepare("UPDATE atlas_state SET schema_version = 3 WHERE singleton = 1").run();
    });

    const reopened = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    expect(
      reopened.withAtlasDb(
        (db) =>
          (
            db
              .prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts WHERE region_id = 'orphan'")
              .get() as { n: number }
          ).n,
      ),
    ).toBe(0);
    expect(
      reopened.withAtlasDb(
        (db) =>
          (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }).revision,
      ),
    ).toBe(1);
  });

  it.each([3, 4])(
    "deduplicates active FTS on the v%i→v6 migration and bumps revision",
    async (schemaVersion: number, ctx: { skip: () => void }) => {
    const fixture = readFileSync(join("test", "fixtures", "detail.html"), "utf8");
    const root = tmpDir();
    const cache = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    const ftsVersion = cache.withAtlasDb(
      (db) =>
        (db.prepare("SELECT fts_version FROM atlas_state WHERE singleton = 1").get() as {
          fts_version: number;
        }).fts_version,
    );
    if (ftsVersion === 0) {
      ctx.skip();
      return;
    }
    const prepared = prepareSitePage({
      slug: "fixture-site",
      html: fixture,
      fetchedAt: 1_700_000_000_000,
      sourceUrl: "https://www.awwwards.com/sites/fixture-site",
      summary: null,
    });
    await new AtlasStore(cache).commitSitePage(prepared);
    const revisionBefore = cache.withAtlasDb(
      (db) =>
        (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
          revision: number;
        }).revision,
    );
    cache.withAtlasDb((db) => {
      db.prepare(
        `INSERT INTO atlas_regions_fts (region_id, title, heading, copy, labels, context)
         SELECT region_id, title, heading, copy, labels, context FROM atlas_regions_fts`,
      ).run();
      db.prepare(
        "DELETE FROM atlas_regions_fts WHERE rowid = (SELECT MIN(rowid) FROM atlas_regions_fts)",
      ).run();
      db.prepare(
        "UPDATE atlas_regions_fts SET title = 'wrong title' WHERE rowid = (SELECT MIN(rowid) FROM atlas_regions_fts)",
      ).run();
      db.prepare(
        "INSERT INTO atlas_regions_fts (region_id, title, heading, copy, labels, context) VALUES ('orphan', 'old', '', '', '', '')",
      ).run();
      db.prepare("UPDATE atlas_state SET schema_version = ? WHERE singleton = 1").run(
        schemaVersion,
      );
    });

    const reopened = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    const state = reopened.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT schema_version, revision FROM atlas_state WHERE singleton = 1",
          )
          .get() as { schema_version: number; revision: number },
    );
    expect(state.schema_version).toBe(6);
    expect(state.revision).toBe(revisionBefore + 1);
    expect(
      reopened.withAtlasDb(
        (db) =>
          (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
      ),
    ).toBe(1 + prepared.highlights.length);
    expect(
      reopened.withAtlasDb(
        (db) =>
          (db
            .prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts WHERE region_id = 'orphan'")
            .get() as { n: number }).n,
      ),
    ).toBe(0);
    expect(
      reopened.withAtlasDb(
        (db) =>
          (db
            .prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts WHERE title = 'wrong title'")
            .get() as { n: number }).n,
      ),
    ).toBe(0);
  });

  it("removes invalid heads during migration reconciliation", async () => {
    const fixture = readFileSync(join("test", "fixtures", "detail.html"), "utf8");
    const root = tmpDir();
    const cache = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    const prepared = prepareSitePage({
      slug: "fixture-site",
      html: fixture,
      fetchedAt: 1_700_000_000_000,
      sourceUrl: "https://www.awwwards.com/sites/fixture-site",
      summary: null,
    });
    await new AtlasStore(cache).commitSitePage(prepared);
    cache.withAtlasDb((db) => {
      db.prepare("UPDATE atlas_captures SET status = 'failed'").run();
      db.prepare("UPDATE atlas_state SET schema_version = 5 WHERE singleton = 1").run();
    });

    const reopened = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    expect(
      reopened.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_heads").get() as { n: number }).n,
      ),
    ).toBe(0);
    expect(
      reopened.withAtlasDb(
        (db) =>
          (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
      ),
    ).toBe(0);
    expect(
      reopened.withAtlasDb(
        (db) =>
          (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }).revision,
      ),
    ).toBe(2);
  });

  it("activates canonical FTS documents from an FTS-disabled cache", async () => {
    const fixture = readFileSync(join("test", "fixtures", "detail.html"), "utf8");
    const root = tmpDir();
    const prepared = prepareSitePage({
      slug: "fixture-site",
      html: fixture,
      fetchedAt: 1_700_000_000_000,
      sourceUrl: "https://www.awwwards.com/sites/fixture-site",
      summary: null,
    });
    const cache = new Cache(root, () => 1_700_000_000_000, { atlas: true, fts: false });
    await new AtlasStore(cache).commitSitePage(prepared);

    const reopened = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    expect(
      reopened.withAtlasDb(
        (db) =>
          (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
      ),
    ).toBe(1 + prepared.highlights.length);
    const labels = reopened.withAtlasDb(
      (db) =>
        (db
          .prepare(
            "SELECT labels FROM atlas_regions_fts WHERE labels <> '' ORDER BY labels LIMIT 1",
          )
          .get() as { labels: string }).labels,
    );
    expect(labels).toMatch(/^source\.title /);
    expect(
      reopened.withAtlasDb(
        (db) =>
          (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }).revision,
      ),
    ).toBe(2);
  });

  it("withdraws a complete head that has no page root during migration", async () => {
    const fixture = readFileSync(join("test", "fixtures", "detail.html"), "utf8");
    const root = tmpDir();
    const cache = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    const prepared = prepareSitePage({
      slug: "fixture-site",
      html: fixture,
      fetchedAt: 1_700_000_000_000,
      sourceUrl: "https://www.awwwards.com/sites/fixture-site",
      summary: null,
    });
    await new AtlasStore(cache).commitSitePage(prepared);
    cache.withAtlasDb((db) => {
      db.exec("DROP TRIGGER IF EXISTS atlas_heads_require_root_ai");
      db.exec("DROP TRIGGER IF EXISTS atlas_heads_require_root_au");
      db.exec("DROP TRIGGER IF EXISTS atlas_regions_root_delete_guard");
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("DELETE FROM atlas_aliases");
      db.exec("DELETE FROM atlas_claims");
      db.exec("DELETE FROM atlas_heads");
      db.exec("DELETE FROM atlas_regions");
      db.exec(
        `INSERT INTO atlas_heads (page_id, profile_key, capture_id, published_at)
         SELECT page_id, profile_key, id, finished_at FROM atlas_captures`,
      );
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("UPDATE atlas_state SET schema_version = 4 WHERE singleton = 1");
    });

    const reopened = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    expect(
      reopened.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_heads").get() as { n: number }).n,
      ),
    ).toBe(0);
    expect(
      reopened.withAtlasDb(
        (db) =>
          (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
      ),
    ).toBe(0);
    expect(
      reopened.withAtlasDb(
        (db) =>
          (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }).revision,
      ),
    ).toBe(2);
  });

  it("withdraws a head whose profile does not match its capture", async () => {
    const fixture = readFileSync(join("test", "fixtures", "detail.html"), "utf8");
    const root = tmpDir();
    const cache = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    const prepared = prepareSitePage({
      slug: "fixture-site",
      html: fixture,
      fetchedAt: 1_700_000_000_000,
      sourceUrl: "https://www.awwwards.com/sites/fixture-site",
      summary: null,
    });
    await new AtlasStore(cache).commitSitePage(prepared);
    expect(
      cache.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_aliases").get() as { n: number }).n,
      ),
    ).toBe(prepared.highlights.length);
    cache.withAtlasDb((db) => {
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare("UPDATE atlas_heads SET profile_key = 'gallery'").run();
      db.exec("PRAGMA foreign_keys = ON");
      db.prepare("UPDATE atlas_state SET schema_version = 5 WHERE singleton = 1").run();
    });

    const reopened = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    expect(
      reopened.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_heads").get() as { n: number }).n,
      ),
    ).toBe(0);
    expect(
      reopened.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_aliases").get() as { n: number }).n,
      ),
    ).toBe(0);
    expect(
      reopened.withAtlasDb(
        (db) =>
          (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
      ),
    ).toBe(0);
  });

  it("withdraws a head whose capture row is missing", async () => {
    const fixture = readFileSync(join("test", "fixtures", "detail.html"), "utf8");
    const root = tmpDir();
    const cache = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    const prepared = prepareSitePage({
      slug: "fixture-site",
      html: fixture,
      fetchedAt: 1_700_000_000_000,
      sourceUrl: "https://www.awwwards.com/sites/fixture-site",
      summary: null,
    });
    await new AtlasStore(cache).commitSitePage(prepared);
    cache.withAtlasDb((db) => {
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("DELETE FROM atlas_captures");
      db.exec("PRAGMA foreign_keys = ON");
      db.prepare("UPDATE atlas_state SET schema_version = 5 WHERE singleton = 1").run();
    });

    const reopened = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    expect(
      reopened.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_heads").get() as { n: number }).n,
      ),
    ).toBe(0);
    expect(
      reopened.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_aliases").get() as { n: number }).n,
      ),
    ).toBe(0);
    expect(
      reopened.withAtlasDb(
        (db) =>
          (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
      ),
    ).toBe(0);
  });

  it("keeps aliases when an invalid duplicate profile is removed", async () => {
    const fixture = readFileSync(join("test", "fixtures", "detail.html"), "utf8");
    const root = tmpDir();
    const cache = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    const prepared = prepareSitePage({
      slug: "fixture-site",
      html: fixture,
      fetchedAt: 1_700_000_000_000,
      sourceUrl: "https://www.awwwards.com/sites/fixture-site",
      summary: null,
    });
    await new AtlasStore(cache).commitSitePage(prepared);
    cache.withAtlasDb((db) => {
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec(
        `INSERT INTO atlas_heads (page_id, profile_key, capture_id, published_at)
         SELECT page_id, 'gallery', capture_id, published_at FROM atlas_heads WHERE profile_key = 'source'`,
      );
      db.exec("PRAGMA foreign_keys = ON");
      db.prepare("UPDATE atlas_state SET schema_version = 5 WHERE singleton = 1").run();
    });

    const reopened = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    expect(
      reopened.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_heads").get() as { n: number }).n,
      ),
    ).toBe(1);
    expect(
      reopened.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_aliases").get() as { n: number }).n,
      ),
    ).toBe(prepared.highlights.length);
    expect(
      reopened.withAtlasDb(
        (db) =>
          (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
      ),
    ).toBe(1 + prepared.highlights.length);
    expect(
      reopened.withAtlasDb(
        (db) =>
          (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }).revision,
      ),
    ).toBe(2);
  });

  it("rolls a failed migration back completely", () => {
    vi.stubEnv("AWWWARDS_MCP_ATLAS", "1");
    const root = tmpDir();
    // A malformed pre-existing table makes the claims index in migration 1
    // fail. The whole migration must roll back, leaving no partial state.
    const raw = new DatabaseSync(join(root, "cache.db"));
    raw.exec("CREATE TABLE atlas_claims (id TEXT PRIMARY KEY)");
    raw.close();

    expect(() => new Cache(root, () => 1_700_000_000_000)).toThrow();

    const check = new DatabaseSync(join(root, "cache.db"));
    const tables = check
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('atlas_state','atlas_pages','atlas_captures','atlas_regions','atlas_heads')",
      )
      .all() as Array<{ name: string }>;
    check.close();
    expect(tables).toEqual([]);
  });

  it("enforces foreign keys on Atlas connections", () => {
    vi.stubEnv("AWWWARDS_MCP_ATLAS", "1");
    const cache = new Cache(tmpDir(), () => 1_700_000_000_000, { atlas: true });
    expect(() =>
      cache.withAtlasDb((db) =>
        db
          .prepare(
            `INSERT INTO atlas_regions
               (id, capture_id, kind, ordinal, samples_json, coverage_json)
             VALUES ('region-1', 'missing-capture', 'page', 0, '{}', '{}')`,
          )
          .run(),
      ),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});
