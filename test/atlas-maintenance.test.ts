import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import { runAtlasCommand } from "../src/atlas/cli-run.js";
import { removeHead } from "../src/atlas/heads.js";
import { reindexAtlas } from "../src/atlas/schema.js";
import { pruneAtlas, verifyAtlasArtifacts } from "../src/atlas/maintenance.js";
import { PACK_NOW, publishPackFixture } from "./helpers/atlas-pack-fixture.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-maintenance-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const OLD = PACK_NOW - 40 * DAY;

const newCache = (now = PACK_NOW) => new Cache(join(tmpDir(), "cache"), () => now, { atlas: true });

async function setupPruneCache() {
  const cache = newCache();
  const active = await publishPackFixture(cache, { siteSlug: "active-site", fetchedAt: PACK_NOW });
  const old = await publishPackFixture(cache, { siteSlug: "old-site", fetchedAt: PACK_NOW });
  const pinned = await publishPackFixture(cache, { siteSlug: "pinned-site", fetchedAt: PACK_NOW });

  cache.withAtlasDb((db) => {
    removeHead(db, old.pageId, "live-desktop", PACK_NOW);
    removeHead(db, pinned.pageId, "live-desktop", PACK_NOW);
    const age = db.prepare(
      `UPDATE atlas_captures
       SET started_at = ?, finished_at = ?, observed_at = ?, source_fetched_at = ?, last_confirmed_at = ?
       WHERE id = ?`,
    );
    age.run(OLD, OLD, OLD, OLD, OLD, old.captureId);
    age.run(OLD, OLD, OLD, OLD, OLD, pinned.captureId);
    db.prepare(
      `INSERT INTO atlas_packs
         (id, storage_path, manifest_hash, selection_json, created_at, state, exporter_version)
       VALUES (?, ?, ?, ?, ?, 'ready', ?)`,
    ).run(
      "pack-pinned",
      "atlas/evidence-packs/pack-pinned",
      "manifest-hash",
      JSON.stringify({ regionIds: [], captureIds: [pinned.captureId], inclusionMode: "references", goal: "pin" }),
      PACK_NOW,
      "atlas-exporter-1",
    );
  });

  const artifacts = cache.withAtlasDb((db) => ({
    active: db
      .prepare("SELECT storage_path, bytes FROM atlas_artifacts WHERE capture_id = ?")
      .all(active.captureId) as Array<{ storage_path: string; bytes: number }>,
    old: db
      .prepare("SELECT id, storage_path, bytes FROM atlas_artifacts WHERE capture_id = ?")
      .all(old.captureId) as Array<{ id: string; storage_path: string; bytes: number }>,
    pinned: db
      .prepare("SELECT storage_path FROM atlas_artifacts WHERE capture_id = ?")
      .all(pinned.captureId) as Array<{ storage_path: string }>,
  }));
  return { cache, active, old, pinned, artifacts };
}

describe("Atlas prune", () => {
  it("defaults to a dry run and reports what would be removed", async () => {
    const { cache, old, artifacts } = await setupPruneCache();
    const report = await pruneAtlas(cache, { olderThanDays: 30, now: PACK_NOW });

    expect(report.dryRun).toBe(true);
    expect(report.eligible).toBe(1);
    expect(report.deleted).toBe(0);
    expect(report.protectedActiveHeads).toBe(1);
    expect(report.protectedPacks).toBe(1);
    expect(report.regions).toBeGreaterThan(0);
    expect(report.claims).toBeGreaterThan(0);
    expect(report.artifacts).toBe(artifacts.old.length);
    expect(report.files).toBeGreaterThan(0);
    expect(report.files).toBeLessThan(artifacts.old.length);

    const stillThere = cache.withAtlasDb(
      (db) =>
        db.prepare("SELECT 1 FROM atlas_captures WHERE id = ?").get(old.captureId) !== undefined,
    );
    expect(stillThere).toBe(true);
    const oldOnly = artifacts.old.find(
      (artifact) => !artifacts.active.some((active) => active.storage_path === artifact.storage_path),
    );
    expect(oldOnly).toBeDefined();
    expect(existsSync(join(cache.rootDir, oldOnly!.storage_path))).toBe(true);
  });

  it("deletes only eligible evidence, keeps protected rows and shared files", async () => {
    const { cache, active, old, pinned, artifacts } = await setupPruneCache();
    const dry = await pruneAtlas(cache, { olderThanDays: 30, now: PACK_NOW });
    const reports: string[] = [];
    const code = await runAtlasCommand(
      { kind: "prune", olderThanDays: 30, apply: true },
      { cache, log: (line) => reports.push(line), now: () => PACK_NOW },
    );

    expect(code).toBe(0);
    expect(reports.join("\n")).toContain("deleted");
    expect(reports.join("\n")).not.toContain(cache.rootDir);

    const remaining = cache.withAtlasDb((db) => ({
      old: db.prepare("SELECT 1 FROM atlas_captures WHERE id = ?").get(old.captureId),
      active: db.prepare("SELECT 1 FROM atlas_captures WHERE id = ?").get(active.captureId),
      pinned: db.prepare("SELECT 1 FROM atlas_captures WHERE id = ?").get(pinned.captureId),
    }));
    expect(remaining.old).toBeUndefined();
    expect(remaining.active).toBeDefined();
    expect(remaining.pinned).toBeDefined();

    const oldOnly = artifacts.old.find(
      (artifact) => !artifacts.active.some((activeArtifact) => activeArtifact.storage_path === artifact.storage_path),
    );
    expect(oldOnly).toBeDefined();
    expect(existsSync(join(cache.rootDir, oldOnly!.storage_path))).toBe(false);
    for (const artifact of artifacts.active) {
      expect(existsSync(join(cache.rootDir, artifact.storage_path))).toBe(true);
    }
    for (const artifact of artifacts.pinned) {
      expect(existsSync(join(cache.rootDir, artifact.storage_path))).toBe(true);
    }
    expect(dry.files).toBeGreaterThan(0);
  });

  it.each([
    ["component_pack directory first", ["component_pack", "tokens"]],
    ["tokens unsafe after raw_observation", ["raw_observation", "tokens", "component_pack"]],
  ])("classifies an unsafe path and a directory independently (%s)", async (_label, order) => {
    const { cache, old } = await setupPruneCache();
    const name = `overlap-${order.join("-")}.json`;
    const directoryPath = `atlas/artifacts/${name}`;
    const unsafePath = `../outside-${name}`;
    const outside = join(cache.rootDir, "..", `outside-${name}`);
    writeFileSync(outside, "outside");
    mkdirSync(join(cache.rootDir, directoryPath), { recursive: true });

    const paths: Record<string, string> = {
      component_pack: directoryPath,
      tokens: unsafePath,
      raw_observation: `atlas/artifacts/raw-${name}`,
    };
    if (order.includes("raw_observation")) {
      writeFileSync(join(cache.rootDir, paths.raw_observation!), "raw");
    }
    cache.withAtlasDb((db) => {
      const insert = db.prepare(
        `INSERT INTO atlas_artifacts
           (id, capture_id, region_id, kind, storage_path, external_url, sha256, bytes,
            mime_type, state, rights_json, metadata_json)
         VALUES (?, ?, NULL, ?, ?, NULL, 'x', 3, 'application/json', 'ready', '{}', '{}')`,
      );
      for (const kind of order) {
        insert.run(`overlap-${kind}`, old.captureId, kind, paths[kind]);
      }
    });

    const report = await pruneAtlas(cache, { olderThanDays: 30, apply: true, now: PACK_NOW });
    expect(report.eligible).toBe(0);
    expect(report.deleted).toBe(0);
    expect(report.skippedUnsafe).toBe(1);
    expect(report.skippedNotFile).toBe(1);
    expect(report.fileFailures).toBe(1);
    expect(existsSync(outside)).toBe(true);
    expect(statSync(join(cache.rootDir, directoryPath)).isDirectory()).toBe(true);
    const stillThere = cache.withAtlasDb(
      (db) => db.prepare("SELECT 1 FROM atlas_captures WHERE id = ?").get(old.captureId),
    );
    expect(stillThere).toBeDefined();

    const lines: string[] = [];
    const code = await runAtlasCommand(
      { kind: "prune", olderThanDays: 30, apply: true },
      { cache, log: (line) => lines.push(line), now: () => PACK_NOW },
    );
    expect(code).toBe(1);
  });

  it("fails --apply and keeps rows when an artifact path is not a regular file", async () => {
    const { cache, old, artifacts } = await setupPruneCache();
    const oldOnly = artifacts.old.find(
      (artifact) =>
        !artifacts.active.some((shared) => shared.storage_path === artifact.storage_path),
    )!;
    const target = join(cache.rootDir, oldOnly.storage_path);
    unlinkSync(target);
    mkdirSync(target, { recursive: true });

    const lines: string[] = [];
    const code = await runAtlasCommand(
      { kind: "prune", olderThanDays: 30, apply: true },
      { cache, log: (line) => lines.push(line), now: () => PACK_NOW },
    );

    expect(code).toBe(1);
    const output = lines.join("\n");
    expect(output).toContain("file failure(s)");
    expect(output).toContain("1 not-file");
    const retained = cache.withAtlasDb((db) => ({
      capture: db.prepare("SELECT 1 FROM atlas_captures WHERE id = ?").get(old.captureId),
      artifact: db.prepare("SELECT 1 FROM atlas_artifacts WHERE id = ?").get(oldOnly.id),
    }));
    expect(retained.capture).toBeDefined();
    expect(retained.artifact).toBeDefined();
    expect(verifyAtlasArtifacts(cache).notFile).toBeGreaterThanOrEqual(1);
  });

  it("rechecks references under the artifact lock before deleting a planned file", async () => {
    const { cache, active, artifacts } = await setupPruneCache();
    const oldOnly = artifacts.old.find(
      (artifact) =>
        !artifacts.active.some((shared) => shared.storage_path === artifact.storage_path),
    )!;

    // Planning and its delete transaction complete synchronously before
    // pruneAtlas first awaits, so this reference lands after the plan and
    // before the artifact-lock file pass.
    const pending = pruneAtlas(cache, { olderThanDays: 30, apply: true, now: PACK_NOW });
    cache.withAtlasDb((db) => {
      db.prepare(
        `INSERT INTO atlas_artifacts
           (id, capture_id, region_id, kind, storage_path, external_url, sha256, bytes,
            mime_type, state, rights_json, metadata_json)
         VALUES ('late-artifact', ?, NULL, 'tokens', ?, NULL, 'late', ?,
                 'application/json', 'ready', '{}', '{}')`,
      ).run(active.captureId, oldOnly.storage_path, oldOnly.bytes);
    });

    const report = await pending;
    expect(report.eligible).toBe(1);
    expect(existsSync(join(cache.rootDir, oldOnly.storage_path))).toBe(true);
    const kept = cache.withAtlasDb(
      (db) => db.prepare("SELECT 1 FROM atlas_artifacts WHERE id = 'late-artifact'").get(),
    );
    expect(kept).toBeDefined();
  });

  it("counts a file that turns non-regular after planning as a failure", async () => {
    const { cache, artifacts } = await setupPruneCache();
    const oldOnly = artifacts.old.find(
      (artifact) =>
        !artifacts.active.some((shared) => shared.storage_path === artifact.storage_path),
    )!;
    const target = join(cache.rootDir, oldOnly.storage_path);

    const pending = pruneAtlas(cache, { olderThanDays: 30, apply: true, now: PACK_NOW });
    unlinkSync(target);
    mkdirSync(target, { recursive: true });

    const report = await pending;
    expect(report.fileFailures).toBe(1);
    expect(statSync(target).isDirectory()).toBe(true);
  });

  it("does not count an already-missing planned file as deleted", async () => {
    const { cache, artifacts } = await setupPruneCache();
    const oldOnly = artifacts.old.find(
      (artifact) =>
        !artifacts.active.some((shared) => shared.storage_path === artifact.storage_path),
    )!;
    const target = join(cache.rootDir, oldOnly.storage_path);
    expect(existsSync(target)).toBe(true);

    const pending = pruneAtlas(cache, { olderThanDays: 30, apply: true, now: PACK_NOW });
    unlinkSync(target);

    const report = await pending;
    expect(report.files).toBeGreaterThan(0);
    expect(report.filesDeleted).toBe(0);
    expect(report.bytesDeleted).toBe(0);
    expect(report.fileFailures).toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it("never prunes an active head older than the cutoff", async () => {
    const { cache, active, artifacts } = await setupPruneCache();
    cache.withAtlasDb((db) => {
      db.prepare(
        `UPDATE atlas_captures
         SET started_at = ?, finished_at = ?, observed_at = ?, source_fetched_at = ?, last_confirmed_at = ?
         WHERE id = ?`,
      ).run(OLD, OLD, OLD, OLD, OLD, active.captureId);
    });

    const report = await pruneAtlas(cache, {
      olderThanDays: 30,
      apply: true,
      now: PACK_NOW,
    });

    expect(report.protectedActiveHeads).toBeGreaterThanOrEqual(1);
    expect(report.deleted).toBe(1);
    const remaining = cache.withAtlasDb((db) => ({
      capture: db.prepare("SELECT 1 FROM atlas_captures WHERE id = ?").get(active.captureId),
      head: db.prepare("SELECT 1 FROM atlas_heads WHERE capture_id = ?").get(active.captureId),
    }));
    expect(remaining.capture).toBeDefined();
    expect(remaining.head).toBeDefined();
    for (const artifact of artifacts.active) {
      expect(existsSync(join(cache.rootDir, artifact.storage_path))).toBe(true);
    }
  });

  it("never prunes a running capture", async () => {
    const cache = newCache();
    cache.withAtlasDb((db) => {
      db.prepare(
        `INSERT INTO atlas_pages (id, site_slug, kind, url_key, public_url, path, created_at)
         VALUES ('running-page', 'running-site', 'live_page', 'https://running.example/', NULL, '/', ?)`,
      ).run(OLD);
      db.prepare(
        `INSERT INTO atlas_captures
           (id, attempt_id, page_id, source_kind, profile_key, config_hash, status,
            started_at, finished_at, observed_at, source_fetched_at, last_confirmed_at,
            source_digest, config_json, policy_json, coverage_json, error_json,
            extractor_version, classifier_version)
         VALUES ('running-capture', 'running-attempt', 'running-page', 'live_page',
                 'live-desktop', 'hash', 'running', ?, NULL, NULL, NULL, NULL, NULL,
                 '{}', '{}', '{}', NULL, 'x', 'x')`,
      ).run(OLD);
    });
    const report = await pruneAtlas(cache, {
      olderThanDays: 1,
      apply: true,
      now: PACK_NOW,
    });
    expect(report.skippedRunning).toBe(1);
    expect(report.eligible).toBe(0);
    const stillThere = cache.withAtlasDb(
      (db) => db.prepare("SELECT 1 FROM atlas_captures WHERE id = 'running-capture'").get(),
    );
    expect(stillThere).toBeDefined();
  });

  it("refuses to prune when a pack pin is unreadable", async () => {
    const { cache } = await setupPruneCache();
    cache.withAtlasDb((db) => {
      db.prepare(
        `INSERT INTO atlas_packs
           (id, storage_path, manifest_hash, selection_json, created_at, state, exporter_version)
         VALUES ('bad-pack', 'atlas/evidence-packs/bad-pack', 'hash', '{}', ?, 'ready', ?)`,
      ).run(PACK_NOW, "atlas-exporter-1");
    });
    await expect(pruneAtlas(cache, { olderThanDays: 30, now: PACK_NOW })).rejects.toMatchObject({
      code: "PACK_PIN_UNREADABLE",
    });
  });
});

describe("Atlas verify", () => {
  it("reports missing and hash-mismatched artifacts without network access", async () => {
    const cache = newCache();
    const fixture = await publishPackFixture(cache, { siteSlug: "verify-site", fetchedAt: PACK_NOW });
    const artifacts = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT id, kind, storage_path, sha256 FROM atlas_artifacts WHERE capture_id = ? ORDER BY id",
          )
          .all(fixture.captureId) as Array<{
          id: string;
          kind: string;
          storage_path: string;
          sha256: string;
        }>,
    );
    const jsonArtifact = artifacts.find((artifact) => artifact.kind === "raw_observation")!;
    const pngArtifact = artifacts.find((artifact) => artifact.kind === "screenshot")!;
    unlinkSync(join(cache.rootDir, jsonArtifact.storage_path));
    writeFileSync(join(cache.rootDir, pngArtifact.storage_path), "changed");
    const fetchSpy = vi.fn(() => {
      throw new Error("network use in verify");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const report = verifyAtlasArtifacts(cache);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(report.checked).toBe(artifacts.length);
    expect(report.ok).toBe(artifacts.length - 2);
    expect(report.missing).toBe(1);
    expect(report.hashMismatch + report.sizeMismatch).toBe(1);
    expect(report.issues.map((issue) => issue.code)).toContain("MISSING");
    expect(report.issues.every((issue) => !issue.artifactId.includes(cache.rootDir))).toBe(true);
  });
});

describe("Atlas reindex", () => {
  it("repairs FTS once and stays revision-stable on a second run", async () => {
    const cache = newCache();
    const fixture = await publishPackFixture(cache, { siteSlug: "reindex-site", fetchedAt: PACK_NOW });
    const fetchSpy = vi.fn(() => {
      throw new Error("network use in reindex");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const before = cache.withAtlasDb((db) => {
      const state = db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
        revision: number;
      };
      const fts = db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number };
      db.prepare(
        "DELETE FROM atlas_regions_fts WHERE region_id IN (SELECT id FROM atlas_regions WHERE capture_id = ? AND kind = 'section')",
      ).run(fixture.captureId);
      return { revision: state.revision, fts: fts.n };
    });

    const first = cache.withAtlasDb((db) => reindexAtlas(db, PACK_NOW));
    expect(first.changed).toBe(true);
    expect(first.revision).toBe(before.revision + 1);
    const restored = cache.withAtlasDb(
      (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
    );
    expect(restored).toBe(before.fts);

    const second = cache.withAtlasDb((db) => reindexAtlas(db, PACK_NOW));
    expect(second.changed).toBe(false);
    expect(second.revision).toBe(first.revision);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("repairs missing search projections without bumping the revision", async () => {
    const cache = newCache();
    const fixture = await publishPackFixture(cache, { siteSlug: "repair-site", fetchedAt: PACK_NOW });
    const before = cache.withAtlasDb((db) => {
      const revision = (
        db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
          revision: number;
        }
      ).revision;
      db.prepare("DELETE FROM atlas_capture_features WHERE capture_id = ?").run(fixture.captureId);
      return revision;
    });

    const result = cache.withAtlasDb((db) => reindexAtlas(db, PACK_NOW));
    expect(result.changed).toBe(false);
    expect(result.revision).toBe(before);
    const features = cache.withAtlasDb(
      (db) =>
        (
          db
            .prepare("SELECT COUNT(*) AS n FROM atlas_capture_features WHERE capture_id = ?")
            .get(fixture.captureId) as { n: number }
        ).n,
    );
    expect(features).toBeGreaterThan(0);
  });

  it("retires an invalid active head once", async () => {
    const cache = newCache();
    const fixture = await publishPackFixture(cache, { siteSlug: "invalid-head-site", fetchedAt: PACK_NOW });
    const before = cache.withAtlasDb((db) => {
      db.prepare("UPDATE atlas_captures SET status = 'unknown' WHERE id = ?").run(fixture.captureId);
      return (
        db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
          revision: number;
        }
      ).revision;
    });

    const result = cache.withAtlasDb((db) => reindexAtlas(db, PACK_NOW));
    expect(result.changed).toBe(true);
    expect(result.revision).toBe(before + 1);
    const head = cache.withAtlasDb(
      (db) => db.prepare("SELECT 1 FROM atlas_heads WHERE capture_id = ?").get(fixture.captureId),
    );
    expect(head).toBeUndefined();
  });
});

describe("verify CLI output", () => {
  it("exits non-zero for an invalid artifact and never prints the cache path", async () => {
    const cache = newCache();
    const fixture = await publishPackFixture(cache, { siteSlug: "cli-verify-site", fetchedAt: PACK_NOW });
    const artifact = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT storage_path FROM atlas_artifacts WHERE capture_id = ? ORDER BY id LIMIT 1")
          .get(fixture.captureId) as { storage_path: string },
    );
    unlinkSync(join(cache.rootDir, artifact.storage_path));
    const lines: string[] = [];
    const code = await runAtlasCommand(
      { kind: "verify" },
      { cache, log: (line) => lines.push(line) },
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("missing");
    expect(lines.join("\n")).not.toContain(cache.rootDir);
  });
});
