import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Cache, enableAtlasWal } from "../src/cache.js";
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

/**
 * Rewrites a published v10 cache into the pre-v10 claim shape: one active
 * hover claim, no `state` column, schema 9. Returns the revision to beat.
 */
function seedPreV10Claim(
  cache: Cache,
  claimId: string,
  sampleKey: string,
  failureTrigger = false,
): number {
  return cache.withAtlasDb((db) => {
    db.prepare(
      `INSERT INTO atlas_pages (id, site_slug, kind, url_key, public_url, path, created_at)
       VALUES ('page-v10', 'v10-fixture', 'live_page', 'https://v10.test/', 'https://v10.test/', '/', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO atlas_captures
         (id, attempt_id, page_id, source_kind, profile_key, config_hash, status,
          started_at, finished_at, observed_at, source_fetched_at, last_confirmed_at,
          config_json, policy_json, coverage_json, extractor_version, classifier_version)
       VALUES ('cap-v10', 'attempt-v10', 'page-v10', 'live_page', 'live-desktop',
               'hash-v10', 'running', 1, NULL, 2, 2, 2, '{}', '{}', '{}', 'test', 'test')`,
    ).run();
    db.prepare(
      `INSERT INTO atlas_regions
         (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
          text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
       VALUES ('root-v10', 'cap-v10', NULL, 'page', 0, NULL, NULL, '', '', NULL, NULL, '{}', NULL, '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO atlas_regions
         (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
          text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
       VALUES ('section-v10', 'cap-v10', 'root-v10', 'section', 0,
               '{"selector":"main > section","tag":"section"}', NULL, 'Hero', 'Hero copy',
               'Hero', NULL, '{"role":null}', NULL, '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO atlas_claims
         (id, region_id, field, value, sample_key, classification, basis, decision,
          rule_id, rule_version, evidence_json, limitations_json, review_json)
       VALUES (?, 'section-v10', 'behavior', 'hover_change_observed', ?,
               'observed', 'interaction_observation', 'accepted', NULL, NULL, '[]', '[]', NULL)`,
    ).run(claimId, sampleKey);
    db.prepare(
      `INSERT INTO atlas_heads (page_id, profile_key, capture_id, published_at)
       VALUES ('page-v10', 'live-desktop', 'cap-v10', 2)`,
    ).run();
    db.prepare("UPDATE atlas_captures SET status = 'complete', finished_at = 2 WHERE id = 'cap-v10'").run();
    db.exec("DROP INDEX IF EXISTS atlas_claims_state_region_idx");
    db.exec("DROP INDEX IF EXISTS atlas_claims_region_state_idx");
    db.exec("ALTER TABLE atlas_claims DROP COLUMN state");
    if (failureTrigger) {
      // Any withAtlasDb call after this point migrates; the trigger must exist
      // before the next open so the v10 backfill UPDATE aborts.
      db.exec(
        `CREATE TRIGGER atlas_claims_v10_fail BEFORE UPDATE ON atlas_claims
         BEGIN SELECT RAISE(ABORT, 'forced v10 failure'); END;`,
      );
    }
    db.prepare(
      "UPDATE atlas_state SET schema_version = 9, fts_version = 3, feature_revision = revision WHERE singleton = 1",
    ).run();
    return (
      db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
        revision: number;
      }
    ).revision;
  });
}

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
    expect(state.schema_version).toBe(10);
    // 0 means this SQLite build has no FTS5; otherwise the current version.
    expect(state.fts_version === 0 || state.fts_version >= 4).toBe(true);
    expect(state.revision).toBe(0);
    if (state.fts_version > 0) {
      const fts = cache.withAtlasDb((db) =>
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'atlas_regions_fts%'",
          )
          .all() as Array<{ name: string }>,
      );
      expect(fts.map((row) => row.name)).toEqual(
        expect.arrayContaining([
          "atlas_regions_fts",
          "atlas_regions_fts_data",
          "atlas_regions_fts_idx",
          "atlas_regions_fts_content",
          "atlas_regions_fts_docsize",
          "atlas_regions_fts_config",
        ]),
      );
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

  it("preserves section body text when migration rebuilds FTS at v10/4", () => {
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
        `INSERT INTO atlas_pages (id, site_slug, kind, url_key, public_url, path, created_at)
         VALUES ('page-plans', 'plans-fixture', 'live_page', 'https://plans.test/', 'https://plans.test/', '/', 1)`,
      ).run();
      db.prepare(
        `INSERT INTO atlas_captures
           (id, attempt_id, page_id, source_kind, profile_key, config_hash, status,
            started_at, finished_at, observed_at, source_fetched_at, last_confirmed_at,
            config_json, policy_json, coverage_json, extractor_version, classifier_version)
         VALUES ('cap-plans', 'attempt-plans', 'page-plans', 'live_page', 'live-desktop',
                 'hash', 'running', 1, NULL, 2, 2, 2, '{}', '{}', '{}', 'test', 'test')`,
      ).run();
      const regionInsert = db.prepare(
        `INSERT INTO atlas_regions
           (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
            text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
         VALUES (?, 'cap-plans', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, '{}')`,
      );
      regionInsert.run(
        "root-plans",
        null,
        "page",
        0,
        "{}",
        "",
        "",
        null,
        null,
        "{}",
        null,
      );
      regionInsert.run(
        "section-plans",
        "root-plans",
        "section",
        0,
        '{"selector":"main > section","tag":"section"}',
        "Pricing",
        "Plans for every team",
        "Pricing",
        null,
        '{"role":null}',
        null,
      );
      regionInsert.run(
        "component-plans",
        "section-plans",
        "component",
        0,
        '{"selector":"main > section > a","tag":"a"}',
        "Start now",
        "",
        "link",
        "link",
        '{"role":null,"type":"link"}',
        "pattern-plans",
      );
      const claimInsert = db.prepare(
        `INSERT INTO atlas_claims
           (id, region_id, field, value, sample_key, classification, basis, decision,
            rule_id, rule_version, evidence_json, limitations_json, review_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', NULL, NULL, '[]', '[]', NULL)`,
      );
      claimInsert.run(
        "claim-section-plans",
        "section-plans",
        "section.purpose",
        "pricing",
        "desktop:section-plans",
        "inferred",
        "rule_derivation",
      );
      claimInsert.run(
        "claim-component-plans",
        "component-plans",
        "component.type",
        "link",
        "desktop:component-plans",
        "observed",
        "native_semantics",
      );
      db.prepare(
        `INSERT INTO atlas_claims
           (id, region_id, field, value, sample_key, classification, basis, decision,
            state, rule_id, rule_version, evidence_json, limitations_json, review_json)
         VALUES ('claim-hover-plans', 'section-plans', 'behavior', 'hover_change_observed',
                 'desktop:section-plans:state-hover', 'observed', 'interaction_observation',
                 'accepted', 'hover', NULL, NULL, '[]', '[]', NULL)`,
      ).run();
      db.prepare(
        `INSERT INTO atlas_heads (page_id, profile_key, capture_id, published_at)
         VALUES ('page-plans', 'live-desktop', 'cap-plans', 2)`,
      ).run();
      db.prepare("UPDATE atlas_captures SET status = 'complete', finished_at = 2 WHERE id = 'cap-plans'").run();
      const ftsInsert = db.prepare(
        "INSERT INTO atlas_regions_fts (region_id, title, heading, copy, labels, context) VALUES (?, ?, ?, ?, ?, ?)",
      );
      ftsInsert.run("root-plans", "", "", "", "", "plans-fixture");
      ftsInsert.run(
        "section-plans",
        "Pricing",
        "Pricing",
        "Plans for every team",
        "section.purpose pricing",
        "plans-fixture",
      );
      ftsInsert.run(
        "component-plans",
        "link",
        "Start now",
        "",
        "component.type link",
        "plans-fixture",
      );
      db.prepare(
        "UPDATE atlas_state SET schema_version = 8, fts_version = 2, feature_revision = revision WHERE singleton = 1",
      ).run();
    });

    const reopened = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    const state = reopened.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT schema_version, fts_version FROM atlas_state WHERE singleton = 1")
          .get() as { schema_version: number; fts_version: number },
    );
    expect(state).toEqual({ schema_version: 10, fts_version: 4 });
    const documents = reopened.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT region_id, title, heading, copy, labels FROM atlas_regions_fts WHERE region_id IN ('section-plans', 'component-plans') ORDER BY region_id",
          )
          .all() as Array<{
          region_id: string;
          title: string;
          heading: string;
          copy: string;
          labels: string;
        }>,
    );
    expect(documents).toEqual([
      {
        region_id: "component-plans",
        title: "link",
        heading: "Start now",
        copy: "",
        labels: "component.type link",
      },
      {
        region_id: "section-plans",
        title: "Pricing",
        heading: "Pricing",
        copy: "Plans for every team",
        labels: "section.purpose pricing",
      },
    ]);
    const states = reopened.withAtlasDb(
      (db) =>
        new Map(
          (
            db
              .prepare("SELECT id, state FROM atlas_claims ORDER BY id")
              .all() as Array<{ id: string; state: string }>
          ).map((row) => [row.id, row.state]),
        ),
    );
    expect(states.get("claim-section-plans")).toBe("default");
    expect(states.get("claim-hover-plans")).toBe("hover");
    expect(documents.find((row) => row.region_id === "section-plans")!.labels).not.toContain(
      "hover",
    );
    const found = reopened.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT region_id FROM atlas_regions_fts WHERE atlas_regions_fts MATCH 'Plans' ORDER BY region_id",
          )
          .all() as Array<{ region_id: string }>,
    );
    expect(found.map((row) => row.region_id)).toContain("section-plans");
    const componentFound = reopened.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT region_id FROM atlas_regions_fts WHERE atlas_regions_fts MATCH 'Start' ORDER BY region_id",
          )
          .all() as Array<{ region_id: string }>,
    );
    expect(componentFound.map((row) => row.region_id)).toContain("component-plans");
  });

  it("backfills v9 state claims from their sample key and rebuilds default labels", () => {
    const root = tmpDir();
    const cache = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    const ftsVersion = cache.withAtlasDb(
      (db) =>
        (db.prepare("SELECT fts_version FROM atlas_state WHERE singleton = 1").get() as {
          fts_version: number;
        }).fts_version,
    );
    if (ftsVersion === 0) return;
    const before = cache.withAtlasDb((db) => {
      db.prepare(
        `INSERT INTO atlas_pages (id, site_slug, kind, url_key, public_url, path, created_at)
         VALUES ('page-v9', 'v9-fixture', 'live_page', 'https://v9.test/', 'https://v9.test/', '/', 1)`,
      ).run();
      db.prepare(
        `INSERT INTO atlas_captures
           (id, attempt_id, page_id, source_kind, profile_key, config_hash, status,
            started_at, finished_at, observed_at, source_fetched_at, last_confirmed_at,
            config_json, policy_json, coverage_json, extractor_version, classifier_version)
         VALUES ('cap-v9', 'attempt-v9', 'page-v9', 'live_page', 'live-desktop',
                 'hash-v9', 'running', 1, NULL, 2, 2, 2, '{}', '{}', '{}', 'test', 'test')`,
      ).run();
      db.prepare(
        `INSERT INTO atlas_regions
           (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
            text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
         VALUES ('root-v9', 'cap-v9', NULL, 'page', 0, NULL, NULL, '', '', NULL, NULL, '{}', NULL, '{}')`,
      ).run();
      db.prepare(
        `INSERT INTO atlas_regions
           (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
            text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
         VALUES ('section-v9', 'cap-v9', 'root-v9', 'section', 0,
                 '{"selector":"main > section","tag":"section"}', NULL, 'Hero', 'Hero copy',
                 'Hero', NULL, '{"role":null}', NULL, '{}')`,
      ).run();
      db.prepare(
        `INSERT INTO atlas_claims
           (id, region_id, field, value, sample_key, classification, basis, decision,
            state, rule_id, rule_version, evidence_json, limitations_json, review_json)
         VALUES ('claim-v9-hover', 'section-v9', 'behavior', 'hover_change_observed',
                 'desktop:section-v9:state-hover', 'observed', 'interaction_observation',
                 'accepted', 'default', NULL, NULL, '[]', '[]', NULL)`,
      ).run();
      db.prepare(
        `INSERT INTO atlas_heads (page_id, profile_key, capture_id, published_at)
         VALUES ('page-v9', 'live-desktop', 'cap-v9', 2)`,
      ).run();
      db.prepare("UPDATE atlas_captures SET status = 'complete', finished_at = 2 WHERE id = 'cap-v9'").run();
      db.prepare(
        "INSERT INTO atlas_regions_fts (region_id, title, heading, copy, labels, context) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        "section-v9",
        "Hero",
        "Hero",
        "Hero copy",
        "behavior hover_change_observed",
        "v9-fixture",
      );
      db.prepare(
        "UPDATE atlas_state SET schema_version = 9, fts_version = 3, feature_revision = revision WHERE singleton = 1",
      ).run();
      return (
        db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
          revision: number;
        }
      ).revision;
    });
    const reopened = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    const state = reopened.withAtlasDb((db) => {
      const claim = db
        .prepare("SELECT state FROM atlas_claims WHERE id = 'claim-v9-hover'")
        .get() as { state: string };
      const labels = (
        db
          .prepare("SELECT labels FROM atlas_regions_fts WHERE region_id = 'section-v9'")
          .get() as { labels: string }
      ).labels;
      const version = db
        .prepare("SELECT schema_version, fts_version, revision FROM atlas_state WHERE singleton = 1")
        .get() as { schema_version: number; fts_version: number; revision: number };
      return { claim, labels, version };
    });
    expect(state.claim.state).toBe("hover");
    expect(state.labels).not.toContain("hover_change_observed");
    expect(state.version).toMatchObject({ schema_version: 10, fts_version: 4 });
    expect(state.version.revision).toBeGreaterThan(before);
  });

  it("adds the state column to a pre-v10 claims table and backfills it", () => {
    const root = tmpDir();
    const cache = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    const ftsVersion = cache.withAtlasDb(
      (db) =>
        (db.prepare("SELECT fts_version FROM atlas_state WHERE singleton = 1").get() as {
          fts_version: number;
        }).fts_version,
    );
    if (ftsVersion === 0) return;
    const before = seedPreV10Claim(
      cache,
      "claim-v10-hover",
      "desktop:section-v10:state-hover",
    );
    const reopened = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    const state = reopened.withAtlasDb((db) => {
      const columns = db
        .prepare("PRAGMA table_info(atlas_claims)")
        .all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
      const claim = db
        .prepare("SELECT state FROM atlas_claims WHERE id = 'claim-v10-hover'")
        .get() as { state: string };
      const labels = (
        db
          .prepare("SELECT labels FROM atlas_regions_fts WHERE region_id = 'section-v10'")
          .get() as { labels: string }
      ).labels;
      const version = db
        .prepare("SELECT schema_version, fts_version, revision FROM atlas_state WHERE singleton = 1")
        .get() as { schema_version: number; fts_version: number; revision: number };
      return { columns, claim, labels, version };
    });
    expect(state.columns.find((column) => column.name === "state")).toMatchObject({
      notnull: 1,
      dflt_value: "'default'",
    });
    expect(state.claim.state).toBe("hover");
    expect(state.labels).not.toContain("hover_change_observed");
    expect(state.version).toMatchObject({ schema_version: 10, fts_version: 4 });
    expect(state.version.revision).toBeGreaterThan(before);

    // A second open of the upgraded cache is a no-op.
    const again = new Cache(root, () => 1_700_000_100_000, { atlas: true });
    expect(
      again.withAtlasDb(
        (db) =>
          db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          },
      ),
    ).toEqual({ revision: state.version.revision });
  });

  it("rolls a failed v10 state migration back completely", () => {
    const root = tmpDir();
    const cache = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    const ftsVersion = cache.withAtlasDb(
      (db) =>
        (db.prepare("SELECT fts_version FROM atlas_state WHERE singleton = 1").get() as {
          fts_version: number;
        }).fts_version,
    );
    if (ftsVersion === 0) return;
    seedPreV10Claim(
      cache,
      "claim-v10-rollback",
      "desktop:section-v10:state-hover",
      true,
    );

    expect(() => {
      const failing = new Cache(root, () => 1_700_000_000_000, { atlas: true });
      failing.withAtlasDb(() => undefined);
    }).toThrow(/forced v10 failure/);

    const check = new DatabaseSync(join(root, "cache.db"));
    const columns = check
      .prepare("PRAGMA table_info(atlas_claims)")
      .all() as Array<{ name: string }>;
    const version = check
      .prepare("SELECT schema_version, fts_version FROM atlas_state WHERE singleton = 1")
      .get() as { schema_version: number; fts_version: number };
    const claims = check
      .prepare("SELECT COUNT(*) AS n FROM atlas_claims WHERE id = 'claim-v10-rollback'")
      .get() as { n: number };
    check.close();
    expect(columns.some((column) => column.name === "state")).toBe(false);
    expect(version).toEqual({ schema_version: 9, fts_version: 3 });
    expect(claims.n).toBe(1);
  });

  it.each([3, 4, 5])(
    "upgrades a schema %i cache whose claim table predates the state column",
    async (schemaVersion: number, ctx: { skip: () => void }) => {
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
      cache.withAtlasDb((db) => {
        db.exec("DROP INDEX IF EXISTS atlas_claims_state_region_idx");
        db.exec("DROP INDEX IF EXISTS atlas_claims_region_state_idx");
        db.exec("ALTER TABLE atlas_claims DROP COLUMN state");
        db.prepare(
          "UPDATE atlas_state SET schema_version = ?, fts_version = 1 WHERE singleton = 1",
        ).run(schemaVersion);
      });

      const reopened = new Cache(root, () => 1_700_000_000_000, { atlas: true });
      const state = reopened.withAtlasDb(
        (db) =>
          db
            .prepare(
              "SELECT schema_version, fts_version, revision FROM atlas_state WHERE singleton = 1",
            )
            .get() as { schema_version: number; fts_version: number; revision: number },
      );
      expect(state.schema_version).toBe(10);
      expect(state.fts_version).toBe(4);
      const columns = reopened.withAtlasDb(
        (db) =>
          db.prepare("PRAGMA table_info(atlas_claims)").all() as Array<{ name: string }>,
      );
      expect(columns.some((column) => column.name === "state")).toBe(true);
      expect(
        reopened.withAtlasDb(
          (db) =>
            db.prepare("SELECT DISTINCT state FROM atlas_claims").all() as Array<{
              state: string;
            }>,
        ),
      ).toEqual([{ state: "default" }]);
      expect(
        reopened.withAtlasDb(
          (db) =>
            (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
        ),
      ).toBeGreaterThan(0);

      const before = reopened.withAtlasDb(
        (db) =>
          db
            .prepare(
              "SELECT schema_version, fts_version, revision, updated_at FROM atlas_state WHERE singleton = 1",
            )
            .get(),
      );
      const again = new Cache(root, () => 1_700_000_100_000, { atlas: true });
      const after = again.withAtlasDb(
        (db) =>
          db
            .prepare(
              "SELECT schema_version, fts_version, revision, updated_at FROM atlas_state WHERE singleton = 1",
            )
            .get(),
      );
      expect(after).toEqual(before);
    },
  );

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
    expect(state.schema_version).toBe(10);
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

  it("uses WAL with NORMAL synchronous durability", () => {
    const cache = new Cache(tmpDir(), () => 1_700_000_000_000, { atlas: true });
    const pragmas = cache.withAtlasDb((db) => ({
      journal_mode: (
        db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
      ).journal_mode,
      synchronous: (
        db.prepare("PRAGMA synchronous").get() as { synchronous: number }
      ).synchronous,
    }));
    expect(pragmas).toEqual({ journal_mode: "wal", synchronous: 1 });
  });

  it("does not apply NORMAL when the VFS refuses WAL", () => {
    const db = new DatabaseSync(":memory:");
    try {
      // The in-memory VFS never enters WAL: the requested pragma silently
      // stays on the memory journal, so the read-back must not confirm it.
      expect(enableAtlasWal(db)).toBe(false);
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "memory" });
      // synchronous stays FULL; NORMAL on a rollback journal may corrupt.
      expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    } finally {
      db.close();
    }
  });

  it("opens a healthy normal cache without waiting on the write lock", () => {
    const root = tmpDir();
    const cache = new Cache(root, () => 1_700_000_000_000, { atlas: true });
    cache.withAtlasDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      const started = performance.now();
      // The FTS layer is current: construction probes it read-only instead of
      // taking the write lock the outer transaction is holding.
      const second = new Cache(root, () => 1_700_000_000_000, { atlas: true });
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(
        second.withReadDb(
          (read) => (read.prepare("SELECT COUNT(*) AS n FROM atlas_state").get() as { n: number }).n,
        ),
      ).toBe(1);
      db.exec("COMMIT");
    });
  });
});
