import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Cache } from "../src/cache.js";
import { rebuildAtlasSearchProjections } from "../src/atlas/search-projections.js";
import { atlasSearchStore, searchAtlas } from "../src/atlas/search.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-cross-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TSX_CLI = join(__dirname, "../node_modules/tsx/dist/cli.mjs");
const WORKER = join(__dirname, "helpers", "atlas-commit-worker.ts");
const LOCK_WORKER = join(__dirname, "helpers", "atlas-publish-lock-worker.ts");
const SEARCH_WORKER = join(__dirname, "helpers", "atlas-search-worker.ts");
const NOW = 1_700_000_000_000;

function seedSearchableCache(root: string): Cache {
  const cache = new Cache(root, () => NOW, { atlas: true });
  cache.withAtlasDb((db) => {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      `INSERT INTO sites (slug, id, title, createdAt, tags, thumbnailPath, liveUrl,
                          detailPath, awards, fetchedAt)
       VALUES ('lock-site', 1, 'Lock site', ?, '[]', '', 'https://lock.example/', '', '[]', ?)`,
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO atlas_pages (id, site_slug, kind, url_key, public_url, path, created_at)
       VALUES ('lock-page', 'lock-site', 'live_page', 'url:lock-page',
               'https://lock.example/', '/', ?)`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO atlas_captures
         (id, attempt_id, page_id, source_kind, profile_key, config_hash, status,
          started_at, finished_at, observed_at, source_fetched_at, last_confirmed_at,
          source_digest, config_json, policy_json, coverage_json, error_json,
          extractor_version, classifier_version)
       VALUES ('lock-capture', 'lock-attempt', 'lock-page', 'live_page', 'live-desktop',
               'lock-config', 'running', ?, NULL, ?, NULL, ?, 'lock-digest', '{}', '{}',
               '{}', NULL, 'test', 'test')`,
    ).run(NOW - 1_000, NOW, NOW);
    db.prepare(
      `INSERT INTO atlas_regions
         (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
          text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
       VALUES ('lock-root', 'lock-capture', NULL, 'page', 0, NULL, NULL, '', '', NULL,
               NULL, '{}', NULL, '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO atlas_regions
         (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
          text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
       VALUES ('lock-section', 'lock-capture', 'lock-root', 'section', 1,
               '{"selector":"main > section","tag":"section"}', NULL, 'Hero', 'Hero',
               'Hero', NULL, '{}', NULL, '{}')`,
    ).run();
    db.prepare("UPDATE atlas_captures SET status = 'complete', finished_at = ? WHERE id = ?").run(
      NOW,
      "lock-capture",
    );
    db.prepare(
      "INSERT INTO atlas_heads (page_id, profile_key, capture_id, published_at) VALUES (?, ?, ?, ?)",
    ).run("lock-page", "live-desktop", "lock-capture", NOW);
    db.prepare("UPDATE atlas_state SET revision = 1 WHERE singleton = 1").run();
    rebuildAtlasSearchProjections(db, 1);
    db.exec("COMMIT");
  });
  return cache;
}

const runWorker = (root: string, fetchedAt: number) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [TSX_CLI, WORKER, root, String(fetchedAt)],
      { cwd: join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

describe("Atlas artifact publication across processes", () => {
  it("serializes two processes into one capture and one artifact", async () => {
    const root = tmpDir();
    const results = await Promise.all([
      runWorker(root, NOW),
      runWorker(root, NOW + 1000),
    ]);
    for (const result of results) {
      expect(result.code, result.stderr).toBe(0);
    }
    const payloads = results.map((result) => {
      expect(result.stdout, result.stderr).not.toBe("");
      return JSON.parse(result.stdout) as {
        captureId: string;
        artifactWritten: boolean;
      };
    });
    expect(payloads[0]!.captureId).toBe(payloads[1]!.captureId);
    expect(payloads.filter((payload) => payload.artifactWritten)).toHaveLength(1);

    const cache = new Cache(root, () => NOW, { atlas: true });
    expect(
      cache.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_captures").get() as { n: number }).n,
      ),
    ).toBe(1);
    expect(
      cache.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_artifacts").get() as { n: number }).n,
      ),
    ).toBe(1);
    expect(readdirSync(join(root, "atlas", "artifacts")).filter((f) => f.endsWith(".json"))).toHaveLength(1);
  }, 60_000);

  it("serves the last committed snapshot while a 6s publish holds the write lock", async () => {
    const root = tmpDir();
    const cache = seedSearchableCache(root);
    const child = spawn(
      process.execPath,
      [TSX_CLI, LOCK_WORKER, root, "6000"],
      { cwd: join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const began = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", () => {
        if (stdout.includes("BEGIN")) resolve();
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (!stdout.includes("BEGIN")) reject(new Error(`worker exited early (${code}): ${stderr}`));
      });
    });
    await began;
    const beginAt = Date.now();

    // A long reader must not delay the publisher's commit under WAL.
    const reader = new DatabaseSync(join(root, "cache.db"), { readOnly: true });
    reader.exec("BEGIN");
    const readerRevision = (
      reader.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
        revision: number;
      }
    ).revision;
    expect(readerRevision).toBe(1);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = performance.now();
      const result = searchAtlas({ kind: "sections" }, atlasSearchStore(cache), NOW);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(1_000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.revision).toBe(1);
        expect(result.data.total).toBe(1);
      } else {
        expect(result.error.code).toBe("SEARCH_NOT_READY");
      }
    }

    const code = await new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) resolve(child.exitCode);
      else child.on("close", (exitCode) => resolve(exitCode));
    });
    const publishElapsed = Date.now() - beginAt;
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("COMMITTED");
    // Six seconds of publish plus startup, never a five-second reader stall.
    expect(publishElapsed).toBeGreaterThanOrEqual(5_500);
    expect(publishElapsed).toBeLessThan(11_000);

    // The long reader still sees its transaction snapshot.
    expect(
      (
        reader.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
          revision: number;
        }
      ).revision,
    ).toBe(1);
    reader.exec("COMMIT");
    reader.close();

    const settled = searchAtlas({ kind: "sections" }, atlasSearchStore(cache), NOW);
    expect(settled.ok).toBe(true);
    if (settled.ok) expect(settled.data.revision).toBe(2);
  }, 60_000);

  it("opens a new read-only search process promptly during a 6s publish", async () => {
    const root = tmpDir();
    seedSearchableCache(root);
    const lock = spawn(process.execPath, [TSX_CLI, LOCK_WORKER, root, "6000"], {
      cwd: join(__dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let lockStdout = "";
    let lockStderr = "";
    lock.stdout.setEncoding("utf8").on("data", (chunk) => {
      lockStdout += chunk;
    });
    lock.stderr.setEncoding("utf8").on("data", (chunk) => {
      lockStderr += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      lock.stdout.on("data", () => {
        if (lockStdout.includes("BEGIN")) resolve();
      });
      lock.on("error", reject);
      lock.on("exit", (code) => {
        if (!lockStdout.includes("BEGIN")) {
          reject(new Error(`lock worker exited early (${code}): ${lockStderr}`));
        }
      });
    });

    const child = spawn(process.execPath, [TSX_CLI, SEARCH_WORKER, root, String(NOW)], {
      cwd: join(__dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const exit = new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
    });
    const code = await Promise.race([
      exit,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
    ]);
    expect(code, `search worker stalled: ${stderr}`).not.toBe("timeout");

    const lockCode = await new Promise<number | null>((resolve) => {
      if (lock.exitCode !== null) resolve(lock.exitCode);
      else lock.on("close", (exitCode) => resolve(exitCode));
    });
    expect(lockCode, lockStderr).toBe(0);
    expect(lockStdout).toContain("COMMITTED");

    expect(code, stderr).toBe(0);
    expect(stderr).not.toMatch(/database is locked|SQLITE_BUSY/i);
    const payload = JSON.parse(stdout) as {
      openMs: number;
      searchMs: number;
      ok: boolean;
      revision?: number;
      total?: number;
      code?: string;
    };
    // The write lock is still held: either the last committed snapshot or a
    // typed retry, never a raw lock after the 5 s busy timeout.
    expect(payload.openMs + payload.searchMs).toBeLessThan(1_000);
    if (payload.ok) {
      expect(payload.revision).toBe(1);
      expect(payload.total).toBe(1);
    } else {
      expect(payload.code).toBe("SEARCH_NOT_READY");
    }
  }, 60_000);
});
