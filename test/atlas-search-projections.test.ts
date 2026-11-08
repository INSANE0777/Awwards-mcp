import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import { writeJsonArtifactSync } from "../src/atlas/artifacts.js";
import { classifySections } from "../src/atlas/classification.js";
import { publishCapture } from "../src/atlas/publish.js";
import { segmentRegions } from "../src/atlas/segmentation.js";
import type { AtlasCaptureAttempt, AtlasStoredArtifact } from "../src/atlas/live-types.js";
import { atlasSearchStore, compilePredicates, queryAtlasDatabase, searchAtlas } from "../src/atlas/search.js";
import { bumpAtlasRevision, rebuildAtlasSearchProjections } from "../src/atlas/search-projections.js";
import type { SearchAtlasData, SearchAtlasResult } from "../src/atlas/search-types.js";
import { loadPhase2Fixture } from "./helpers/phase2-fixture.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 5, 12);

const dirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-projections-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataOrThrow(result: SearchAtlasResult<SearchAtlasData>): SearchAtlasData {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

let sequence = 0;

/**
 * Minimal publishable attempt built from the phase-2 fixture. Two calls with
 * the same scanTitle and no time change produce the same capture digest, so
 * publishing the second one exercises the identical-recapture path.
 */
function attemptFor(
  cache: Cache,
  options: { finishedAt: number; scanTitle?: string },
): AtlasCaptureAttempt {
  const { scan: baseScan } = loadPhase2Fixture();
  const scan = options.scanTitle ? { ...baseScan, title: options.scanTitle } : baseScan;
  const regions = segmentRegions(scan);
  const target = {
    siteSlug: "fixture-live",
    requestedUrl: "https://fixture.example/",
    urlKey: "https://fixture.example/",
    path: "/",
  };
  const scanArtifact = writeJsonArtifactSync(cache.rootDir, {
    schemaVersion: "awwwards-atlas-live-scan-v1",
    viewport: "desktop",
    scan,
  });
  const stored: AtlasStoredArtifact = {
    key: "scan-desktop",
    kind: "raw_observation",
    storagePath: scanArtifact.storagePath,
    sha256: scanArtifact.sha256,
    bytes: scanArtifact.bytes,
    mimeType: "application/json",
    regionKey: null,
  };
  const claims = classifySections(
    regions.map((candidate) => ({
      viewport: "desktop" as const,
      candidate,
      scan,
      artifactKey: "scan-desktop",
    })),
  );
  return {
    cache,
    target,
    attemptId: `projection-attempt-${++sequence}`,
    startedAt: options.finishedAt - 1_000,
    finishedAt: options.finishedAt,
    status: "complete",
    coverage: { status: "complete", collected: regions.length, excluded: 0, limitations: [] },
    limitations: [],
    artifacts: [stored],
    viewports: [
      {
        viewport: "desktop",
        profileKey: "live-desktop",
        status: "complete",
        coverage: { status: "complete", collected: regions.length, excluded: 0, limitations: [] },
        limitations: [],
        finalUrl: target.requestedUrl,
        browserVersion: "fixture",
        dpr: 1,
        reducedMotion: "no-preference",
        scrollRoot: null,
        overlayState: "none",
        loadingFailures: [],
        scan,
        regions,
        claims,
        screenshots: [],
        artifacts: [stored],
      },
    ],
  };
}

function searchCache(cache: Cache, now: number): SearchAtlasData {
  return dataOrThrow(
    searchAtlas({ kind: "sections", limit: 20 }, atlasSearchStore(cache), now),
  );
}

function projectionState(cache: Cache): { revision: number; feature_revision: number } {
  return cache.withAtlasDb(
    (db) =>
      db
        .prepare("SELECT revision, feature_revision FROM atlas_state WHERE singleton = 1")
        .get() as { revision: number; feature_revision: number },
  );
}

/**
 * Denies writes inside `dir` so SQLite cannot create the -shm sidecar a WAL
 * read normally needs. Windows needs an ACL (the read-only attribute does not
 * block child creation); POSIX uses a read-only mode. Returns the restore.
 */
function denyDirectoryWrites(dir: string): () => void {
  if (process.platform === "win32") {
    const user = process.env.USERNAME ?? "";
    const trustee = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
    execFileSync("icacls", [dir, "/deny", `${trustee}:(WD,AD)`], { stdio: "ignore" });
    return () => execFileSync("icacls", [dir, "/remove:d", trustee], { stdio: "ignore" });
  }
  chmodSync(dir, 0o500);
  return () => chmodSync(dir, 0o700);
}

describe("Atlas search projection lifecycle", () => {
  it("commits projections at the revision publish bumps", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const published = await publishCapture(attemptFor(cache, { finishedAt: NOW }));
    expect(published.published).toBe(true);
    const state = projectionState(cache);
    expect(state.revision).toBe(1);
    expect(state.feature_revision).toBe(state.revision);

    const data = searchCache(cache, NOW + 1_000);
    expect(data.revision).toBe(1);
    expect(data.total).toBe(published.regionCount);
  });

  it("bumps the revision when an identical recapture advances confirmation", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const first = await publishCapture(attemptFor(cache, { finishedAt: NOW }));
    const firstState = projectionState(cache);

    const recaptureAt = NOW + 31 * DAY;
    const second = await publishCapture(attemptFor(cache, { finishedAt: recaptureAt }));
    expect(second.published).toBe(true);
    expect(second.captureIds).toEqual(first.captureIds);

    const state = projectionState(cache);
    expect(state.revision).toBe(firstState.revision + 1);
    expect(state.feature_revision).toBe(state.revision);
    const confirmed = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT last_confirmed_at FROM atlas_captures WHERE id = ?")
          .get(first.captureIds[0]!) as { last_confirmed_at: number },
    );
    expect(confirmed.last_confirmed_at).toBe(recaptureAt);

    const data = searchCache(cache, recaptureAt);
    expect(data.revision).toBe(state.revision);
    expect(data.total).toBe(first.regionCount);
  });

  it("does not bump or rebuild for an identical same-day recapture", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const first = await publishCapture(attemptFor(cache, { finishedAt: NOW }));
    expect(first.published).toBe(true);
    const firstState = projectionState(cache);

    const recaptureAt = NOW + 6 * 60 * 60_000;
    const second = await publishCapture(attemptFor(cache, { finishedAt: recaptureAt }));
    expect(second.published).toBe(true);
    expect(second.captureIds).toEqual(first.captureIds);

    const state = projectionState(cache);
    expect(state.revision).toBe(firstState.revision);
    expect(state.feature_revision).toBe(state.revision);
    const confirmed = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT last_confirmed_at FROM atlas_captures WHERE id = ?")
          .get(first.captureIds[0]!) as { last_confirmed_at: number },
    );
    expect(confirmed.last_confirmed_at).toBe(recaptureAt);
  });

  it("keeps a day-29 recapture searchable at day 31 through the in-place refresh", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const first = await publishCapture(attemptFor(cache, { finishedAt: NOW }));
    expect(first.published).toBe(true);
    const firstState = projectionState(cache);

    const recaptureAt = NOW + 29 * DAY;
    const second = await publishCapture(attemptFor(cache, { finishedAt: recaptureAt }));
    expect(second.published).toBe(true);
    expect(second.captureIds).toEqual(first.captureIds);

    // A later-day confirmation advances the derived freshness columns and
    // bumps the revision, but the identical evidence is not rebuilt.
    const state = projectionState(cache);
    expect(state.revision).toBe(firstState.revision + 1);
    expect(state.feature_revision).toBe(state.revision);
    const summary = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT last_confirmed_at, fresh FROM atlas_captures c JOIN atlas_capture_summary s ON s.capture_id = c.id WHERE c.id = ?",
          )
          .get(first.captureIds[0]!) as { last_confirmed_at: number; fresh: number },
    );
    expect(summary.last_confirmed_at).toBe(recaptureAt);
    expect(summary.fresh).toBe(recaptureAt);

    // Two days after the recapture the capture is still inside the 30-day
    // window even though the first publish is 31 days old.
    const data = searchCache(cache, NOW + 31 * DAY);
    expect(data.revision).toBe(state.revision);
    expect(data.total).toBe(first.regionCount);
  });

  it("returns a typed SEARCH_NOT_READY when a projection object disappears at query time", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    await publishCapture(attemptFor(cache, { finishedAt: NOW }));
    cache.withAtlasDb((db) => db.exec("DROP TABLE atlas_region_features"));
    const result = searchAtlas(
      {
        kind: "sections",
        predicates: [{ field: "region.tag", values: ["section"] }],
      },
      atlasSearchStore(cache),
      NOW + 1_000,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SEARCH_NOT_READY");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("recreates missing supporting indexes without rebuilding projections", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => NOW, { atlas: true });
    const published = await publishCapture(attemptFor(cache, { finishedAt: NOW }));
    const before = projectionState(cache);
    const indexes = [
      "atlas_claims_facet_idx",
      "atlas_regions_lookup_idx",
      "atlas_regions_features_idx",
      "atlas_regions_sort_idx",
      "atlas_regions_tag_fallback_idx",
      "atlas_regions_kind_idx",
      "atlas_region_features_region_idx",
    ];
    cache.withAtlasDb((db) => {
      for (const index of indexes) db.exec(`DROP INDEX IF EXISTS ${index}`);
    });

    const reopened = new Cache(root, () => NOW, { atlas: true });
    const names = reopened.withAtlasDb(
      (db) =>
        (
          db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type = 'index'
               AND name IN (${indexes.map(() => "?").join(",")})`,
            )
            .all(...indexes) as Array<{ name: string }>
        ).map((row) => row.name),
    );
    expect(names.sort()).toEqual([...indexes].sort());
    // The index repair must not pay for a projection rebuild.
    expect(projectionState(reopened)).toEqual(before);
    expect(searchCache(reopened, NOW + 1_000).total).toBe(published.regionCount);
  });

  it("recreates missing projection-local indexes without discarding projection rows", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => NOW, { atlas: true });
    const published = await publishCapture(attemptFor(cache, { finishedAt: NOW }));
    const before = projectionState(cache);
    const indexes = [
      "atlas_capture_summary_scope_idx",
      "atlas_site_features_lookup_idx",
      "atlas_region_purposes_scope_idx",
    ];
    cache.withAtlasDb((db) => {
      db.prepare(
        "INSERT INTO atlas_feature_totals (field, value, captures, regions) VALUES ('sentinel', 'kept', 1, 1)",
      ).run();
      for (const index of indexes) db.exec(`DROP INDEX IF EXISTS ${index}`);
    });

    const reopened = new Cache(root, () => NOW, { atlas: true });
    const present = reopened.withAtlasDb(
      (db) =>
        (
          db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${indexes.map(() => "?").join(",")})`,
            )
            .all(...indexes) as Array<{ name: string }>
        ).map((row) => row.name),
    );
    expect(present.sort()).toEqual([...indexes].sort());
    // The sentinel proves the seven projection tables were not dropped.
    expect(
      reopened.withAtlasDb(
        (db) =>
          db
            .prepare(
              "SELECT captures FROM atlas_feature_totals WHERE field = 'sentinel' AND value = 'kept'",
            )
            .get(),
      ),
    ).toEqual({ captures: 1 });
    expect(projectionState(reopened)).toEqual(before);
    expect(searchCache(reopened, NOW + 1_000).total).toBe(published.regionCount);
  });

  it("searches a checkpointed WAL database when the directory denies writes", async (ctx) => {
    const root = tmpDir();
    const cache = new Cache(root, () => NOW, { atlas: true });
    const published = await publishCapture(attemptFor(cache, { finishedAt: NOW }));
    const dbPath = join(root, "cache.db");
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    const restore = denyDirectoryWrites(root);
    try {
      // The denial must be real, otherwise the plain read-only open succeeds
      // and this test never exercises the immutable fallback (e.g. as root).
      let denied = false;
      try {
        writeFileSync(join(root, "probe-write"), "x");
        rmSync(join(root, "probe-write"), { force: true });
      } catch {
        denied = true;
      }
      if (!denied) ctx.skip();

      const reader = new Cache(root, () => NOW, { atlas: true, readOnly: true });
      const result = searchAtlas(
        { kind: "sections", limit: 20 },
        atlasSearchStore(reader),
        NOW + 1_000,
      );
      if (!result.ok) {
        throw new Error(`search failed: ${result.error.code} ${result.error.message}`);
      }
      expect(result.data.revision).toBe(1);
      expect(result.data.total).toBe(published.regionCount);
    } finally {
      restore();
    }
  });

  it("constructs a missing read-only cache without creating it and reports not-ready", () => {
    const root = join(tmpdir(), `awwwards-atlas-missing-${randomUUID()}`);
    const cache = new Cache(root, () => NOW, { atlas: true, readOnly: true });
    expect(existsSync(root)).toBe(false);
    const result = searchAtlas({ kind: "sections" }, atlasSearchStore(cache), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SEARCH_NOT_READY");
      expect(result.error.retryable).toBe(true);
    }
    expect(existsSync(root)).toBe(false);
  });

  it("rejects writes through the production Atlas search seam", () => {
    const root = tmpDir();
    // Use a writable cache: this is how production search opens the store, so
    // the seam itself must stay read-only rather than relying on the caller.
    const cache = new Cache(root, () => NOW, { atlas: true });
    expect(() =>
      cache.withAtlasReadDb((db) => db.exec("CREATE TABLE read_only_probe (id INTEGER)")),
    ).toThrow(/readonly|read-only/i);
  });

  it("leaves the database bytes untouched after a read-only search", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => NOW, { atlas: true });
    const published = await publishCapture(attemptFor(cache, { finishedAt: NOW }));
    const dbPath = join(root, "cache.db");
    const snapshot = () => ({
      hash: createHash("sha256").update(readFileSync(dbPath)).digest("hex"),
      mtimeMs: statSync(dbPath).mtimeMs,
    });
    const before = snapshot();
    const reader = new Cache(root, () => NOW, { atlas: true, readOnly: true });
    expect(searchCache(reader, NOW + 1_000).total).toBe(published.regionCount);
    expect(snapshot()).toEqual(before);
  });

  it("removes retired-head rows from every projection", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    await publishCapture(attemptFor(cache, { finishedAt: NOW }));
    const firstCapture = cache.withAtlasDb(
      (db) =>
        (db.prepare("SELECT capture_id FROM atlas_heads").get() as { capture_id: string })
          .capture_id,
    );
    const second = await publishCapture(
      attemptFor(cache, { finishedAt: NOW + 1_000, scanTitle: "Changed fixture" }),
    );
    expect(second.published).toBe(true);
    expect(second.captureIds[0]).not.toBe(firstCapture);

    const retired = cache.withAtlasDb((db) => ({
      summary: (
        db
          .prepare("SELECT COUNT(*) AS n FROM atlas_capture_summary WHERE capture_id = ?")
          .get(firstCapture) as { n: number }
      ).n,
      purposes: (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM atlas_region_purposes
             WHERE region_id IN (SELECT id FROM atlas_regions WHERE capture_id = ?)`,
          )
          .get(firstCapture) as { n: number }
      ).n,
      features: (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM atlas_region_features
             WHERE region_id IN (SELECT id FROM atlas_regions WHERE capture_id = ?)`,
          )
          .get(firstCapture) as { n: number }
      ).n,
    }));
    expect(retired).toEqual({ summary: 0, purposes: 0, features: 0 });

    const data = searchCache(cache, NOW + 2_000);
    expect(data.results.every((hit) => hit.captureId === second.captureIds[0])).toBe(true);
  });

  it("deletes orphan projection rows on the next rebuild", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    await publishCapture(attemptFor(cache, { finishedAt: NOW }));
    cache.withAtlasDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        `INSERT INTO atlas_capture_summary
           (capture_id, page_id, site_slug, profile_key, source_kind, status,
            observed, fresh, regions)
         VALUES ('retired-capture', 'retired-page', 'retired-site', 'live-desktop',
                 'live_page', 'complete', ?, ?, 1)`,
      ).run(NOW, NOW);
      db.prepare(
        "INSERT INTO atlas_region_purposes (region_id, value, profile_key, fresh, candidate_tier) VALUES (?, 'pricing', 'live-desktop', ?, 3)",
      ).run("retired-region", NOW);
      db.prepare(
        "INSERT INTO atlas_region_features (field, value, region_id, profile_key, fresh) VALUES ('region.tag', 'section', ?, 'live-desktop', ?)",
      ).run("retired-region", NOW);
      bumpAtlasRevision(db, NOW + 1_000);
      db.exec("COMMIT");
    });
    const counts = cache.withAtlasDb((db) => ({
      summary: (
        db
          .prepare("SELECT COUNT(*) AS n FROM atlas_capture_summary WHERE capture_id = 'retired-capture'")
          .get() as { n: number }
      ).n,
      purposes: (
        db
          .prepare("SELECT COUNT(*) AS n FROM atlas_region_purposes WHERE region_id = 'retired-region'")
          .get() as { n: number }
      ).n,
      features: (
        db
          .prepare("SELECT COUNT(*) AS n FROM atlas_region_features WHERE region_id = 'retired-region'")
          .get() as { n: number }
      ).n,
    }));
    expect(counts).toEqual({ summary: 0, purposes: 0, features: 0 });
  });

  it("joins the caller's transaction instead of committing", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    await publishCapture(attemptFor(cache, { finishedAt: NOW }));
    const before = cache.withAtlasDb(
      (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_capture_summary").get() as { n: number }).n,
    );
    expect(before).toBeGreaterThan(0);
    cache.withAtlasDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      db.exec("DELETE FROM atlas_capture_summary");
      rebuildAtlasSearchProjections(
        db,
        (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
          revision: number;
        }).revision,
      );
      db.exec("ROLLBACK");
    });
    const after = cache.withAtlasDb(
      (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_capture_summary").get() as { n: number }).n,
    );
    expect(after).toBe(before);
  });

  it("returns a typed SEARCH_NOT_READY instead of stale or cross-revision results", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    await publishCapture(attemptFor(cache, { finishedAt: NOW }));
    cache.withAtlasDb((db) => {
      const compiled = compilePredicates({ kind: "sections" });
      if (!compiled.ok) throw new Error(compiled.error.message);
      const request = {
        input: compiled.input,
        asOf: NOW + 1_000,
        tokens: compiled.tokens,
        ftsQuery: compiled.ftsQuery,
        afterTuple: null,
      };
      // A revision bumped outside the projection rebuild must never be
      // answered from the previous revision's projections.
      db.prepare("UPDATE atlas_state SET revision = revision + 1 WHERE singleton = 1").run();
      const stale = queryAtlasDatabase(db, request);
      expect(stale.ok).toBe(false);
      if (!stale.ok) {
        expect(stale.error.code).toBe("SEARCH_NOT_READY");
        expect(stale.error.retryable).toBe(true);
      }
      // Once the projections catch up, the same request answers at the new
      // revision instead of returning an R-labelled result from old rows.
      rebuildAtlasSearchProjections(db, 2);
      const fresh = queryAtlasDatabase(db, request);
      expect(fresh.ok).toBe(true);
      if (fresh.ok) expect(fresh.data.revision).toBe(2);
    });
  });

  it("repairs a stale feature revision on the next cache open", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => NOW, { atlas: true });
    await publishCapture(attemptFor(cache, { finishedAt: NOW }));
    cache.withAtlasDb((db) => {
      db.prepare("UPDATE atlas_state SET feature_revision = -1 WHERE singleton = 1").run();
    });
    const reopened = new Cache(root, () => NOW, { atlas: true });
    const state = projectionState(reopened);
    expect(state.feature_revision).toBe(state.revision);
    expect(searchCache(reopened, NOW + 1_000).total).toBeGreaterThan(0);
  });

  it("repairs a missing or stale projection table on the next cache open", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => NOW, { atlas: true });
    const published = await publishCapture(attemptFor(cache, { finishedAt: NOW }));

    // Missing table: the old guard only checked two of seven tables.
    cache.withAtlasDb((db) => db.exec("DROP TABLE atlas_feature_totals"));
    const missingRepaired = new Cache(root, () => NOW, { atlas: true });
    expect(
      missingRepaired.withAtlasDb(
        (db) =>
          db
            .prepare(
              "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'atlas_feature_totals'",
            )
            .get() as { ok: number } | undefined,
      ),
    ).toEqual({ ok: 1 });
    expect(searchCache(missingRepaired, NOW + 1_000).total).toBe(published.regionCount);

    // Stale column shape: drop the per-feature region count and reopen.
    missingRepaired.withAtlasDb((db) =>
      db.exec("ALTER TABLE atlas_capture_features DROP COLUMN regions"),
    );
    const staleRepaired = new Cache(root, () => NOW, { atlas: true });
    const columns = staleRepaired.withAtlasDb(
      (db) => db.prepare("PRAGMA table_info(atlas_capture_features)").all() as Array<{ name: string }>,
    );
    expect(columns.some((column) => column.name === "regions")).toBe(true);
    expect(searchCache(staleRepaired, NOW + 1_000).total).toBe(published.regionCount);
  });

  it("withdraws invalid artifact heads with one revision bump for the batch", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const missingPath = "atlas/artifacts/missing-head.png";
    cache.withAtlasDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      for (const suffix of ["a", "b"]) {
        const page = `invalid-page-${suffix}`;
        const capture = `invalid-capture-${suffix}`;
        db.prepare(
          `INSERT INTO atlas_pages (id, site_slug, kind, url_key, public_url, path, created_at)
           VALUES (?, ?, 'live_page', ?, ?, '/', ?)`,
        ).run(page, `invalid-site-${suffix}`, `url:${page}`, `https://${page}.example/`, NOW);
        db.prepare(
          `INSERT INTO atlas_captures
             (id, attempt_id, page_id, source_kind, profile_key, config_hash, status,
              started_at, finished_at, observed_at, source_fetched_at, last_confirmed_at,
              source_digest, config_json, policy_json, coverage_json, error_json,
              extractor_version, classifier_version)
           VALUES (?, ?, ?, 'live_page', 'live-desktop', ?, 'running', ?, NULL, ?, ?, ?,
                   ?, '{}', '{}', '{}', NULL, 'test', 'test')`,
        ).run(capture, `attempt-${capture}`, page, `config-${capture}`, NOW, NOW, NOW, NOW, `digest-${capture}`);
        db.prepare(
          `INSERT INTO atlas_regions
             (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
              text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
           VALUES (?, ?, NULL, 'page', 0, NULL, NULL, '', '', NULL, NULL, '{}', NULL, '{}')`,
        ).run(`${capture}:root`, capture);
        db.prepare(
          "UPDATE atlas_captures SET status = 'complete', finished_at = ? WHERE id = ?",
        ).run(NOW, capture);
        db.prepare(
          "INSERT INTO atlas_heads (page_id, profile_key, capture_id, published_at) VALUES (?, 'live-desktop', ?, ?)",
        ).run(page, capture, NOW);
        db.prepare(
          `INSERT INTO atlas_artifacts
             (id, capture_id, region_id, kind, storage_path, external_url, sha256, bytes,
              mime_type, state, rights_json, metadata_json)
           VALUES (?, ?, NULL, 'screenshot', ?, NULL, ?, 1, 'image/png', 'ready', '{}', '{}')`,
        ).run(`artifact-${suffix}`, capture, missingPath, "00");
      }
      db.exec("COMMIT");
    });

    const attempt = attemptFor(cache, { finishedAt: NOW + 1_000 });
    attempt.viewports[0]!.artifacts[0]!.storagePath = missingPath;
    const result = await publishCapture(attempt);
    expect(result.published).toBe(false);
    expect(result.code).toBe("ARTIFACT_INVALID");
    const state = cache.withAtlasDb((db) => ({
      heads: (db.prepare("SELECT COUNT(*) AS n FROM atlas_heads").get() as { n: number }).n,
      revision: (
        db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
          revision: number;
        }
      ).revision,
    }));
    expect(state.heads).toBe(0);
    // Two withdrawn heads share one rebuild, so the revision moves once.
    expect(state.revision).toBe(1);
  });

  it("keeps the rebuild on the publish path and out of search", () => {
    const publish = readFileSync(join("src", "atlas", "publish.ts"), "utf8");
    const publishBody = publish.slice(publish.indexOf("export async function publishCapture("));
    const begin = publishBody.indexOf('db.exec("BEGIN IMMEDIATE")');
    expect(begin).toBeGreaterThan(-1);
    expect(publishBody.indexOf("bumpAtlasRevision(db, attempt.finishedAt)")).toBeGreaterThan(begin);

    const search = readFileSync(join("src", "atlas", "search.ts"), "utf8");
    expect(search).not.toContain("refreshAtlasSearchCache");
    const queryStart = search.indexOf("function queryAtlasSnapshot(");
    const queryEnd = search.indexOf("export function snapshotAtlasSearchStore(");
    expect(queryStart).toBeGreaterThan(-1);
    expect(queryEnd).toBeGreaterThan(queryStart);
    expect(search.slice(queryStart, queryEnd)).not.toContain("BEGIN IMMEDIATE");
  });

  it("labels two concurrent searchers from the snapshot the publisher leaves committed", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    await publishCapture(attemptFor(cache, { finishedAt: NOW }));
    const firstRevision = projectionState(cache).revision;

    cache.withAtlasDb((publisher) => {
      publisher.exec("BEGIN IMMEDIATE");
      const nextRevision = bumpAtlasRevision(publisher, NOW + 5_000);
      expect(nextRevision).toBe(firstRevision + 1);
      // Two independent search connections while the publish transaction is
      // still open: they must read the committed snapshot, never SQLITE_BUSY.
      const first = searchAtlas({ kind: "sections" }, atlasSearchStore(cache), NOW + 5_000);
      const second = searchAtlas({ kind: "sections" }, atlasSearchStore(cache), NOW + 5_000);
      for (const result of [first, second]) {
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.data.revision).toBe(firstRevision);
      }
      publisher.exec("COMMIT");
    });

    const settled = searchCache(cache, NOW + 5_000);
    expect(settled.revision).toBe(firstRevision + 1);
    expect(settled.total).toBeGreaterThan(0);
  });
});
