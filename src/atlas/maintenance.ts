import type { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import type { Cache } from "../cache.js";
import {
  removeArtifactFileSync,
  resolveArtifactPath,
  validateStoredArtifact,
  withArtifactLock,
} from "./artifacts.js";

export type AtlasMaintenanceCode =
  | "INVALID_ARGUMENT"
  | "PACK_PIN_UNREADABLE"
  | "PRUNE_FAILED";

export class AtlasMaintenanceError extends Error {
  constructor(
    readonly code: AtlasMaintenanceCode,
    message: string,
  ) {
    super(message);
    this.name = "AtlasMaintenanceError";
  }
}

export interface AtlasVerifyIssue {
  artifactId: string;
  captureId: string;
  kind: string;
  code:
    | "MISSING"
    | "SIZE_MISMATCH"
    | "HASH_MISMATCH"
    | "NOT_FILE"
    | "UNSAFE_PATH";
}

export interface AtlasVerifyReport {
  checked: number;
  ok: number;
  external: number;
  missing: number;
  sizeMismatch: number;
  hashMismatch: number;
  notFile: number;
  unsafePath: number;
  issues: AtlasVerifyIssue[];
}

/** Offline artifact integrity census. No network and no explicit database writes. */
export function verifyAtlasArtifacts(cache: Cache): AtlasVerifyReport {
  const rows = cache.withAtlasDb(
    (db) =>
      db
        .prepare(
          `SELECT id, capture_id, kind, storage_path, sha256, bytes
           FROM atlas_artifacts
           ORDER BY id`,
        )
        .all() as Array<{
        id: string;
        capture_id: string;
        kind: string;
        storage_path: string | null;
        sha256: string | null;
        bytes: number | null;
      }>,
  );
  const report: AtlasVerifyReport = {
    checked: 0,
    ok: 0,
    external: 0,
    missing: 0,
    sizeMismatch: 0,
    hashMismatch: 0,
    notFile: 0,
    unsafePath: 0,
    issues: [],
  };
  for (const row of rows) {
    if (row.storage_path === null) {
      report.external += 1;
      continue;
    }
    report.checked += 1;
    let code: AtlasVerifyIssue["code"] | null = null;
    try {
      resolveArtifactPath(cache.rootDir, row.storage_path);
    } catch {
      code = "UNSAFE_PATH";
    }
    if (code === null) {
      const error = validateStoredArtifact(cache.rootDir, {
        storagePath: row.storage_path,
        sha256: row.sha256 ?? "",
        bytes: row.bytes ?? -1,
      });
      if (error === "artifact byte size mismatch") code = "SIZE_MISMATCH";
      else if (error === "artifact SHA-256 mismatch") code = "HASH_MISMATCH";
      else if (error === "artifact path is not a file") code = "NOT_FILE";
      else if (error !== null) code = "MISSING";
    }
    if (code === null) {
      report.ok += 1;
      continue;
    }
    if (code === "MISSING") report.missing += 1;
    else if (code === "SIZE_MISMATCH") report.sizeMismatch += 1;
    else if (code === "HASH_MISMATCH") report.hashMismatch += 1;
    else if (code === "NOT_FILE") report.notFile += 1;
    else report.unsafePath += 1;
    report.issues.push({
      artifactId: row.id,
      captureId: row.capture_id,
      kind: row.kind,
      code,
    });
  }
  return report;
}

export interface AtlasPruneOptions {
  olderThanDays: number;
  apply?: boolean;
  now?: number;
}

export interface AtlasPruneReport {
  dryRun: boolean;
  cutoff: number;
  scanned: number;
  eligible: number;
  deleted: number;
  protectedActiveHeads: number;
  protectedPacks: number;
  skippedRunning: number;
  retainedYoung: number;
  skippedUnsafe: number;
  skippedNotFile: number;
  regions: number;
  claims: number;
  aliases: number;
  artifacts: number;
  files: number;
  bytes: number;
  filesDeleted: number;
  bytesDeleted: number;
  fileFailures: number;
}

const DAY_MS = 86_400_000;
const PRUNE_CANDIDATES = "atlas_prune_candidates";
const PRUNE_PATHS = "atlas_prune_paths";

interface CaptureRow {
  id: string;
  status: string;
  age_at: number;
}

function count(db: DatabaseSync, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

function packPins(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT id, selection_json FROM atlas_packs").all() as Array<{
    id: string;
    selection_json: string;
  }>;
  const pins = new Set<string>();
  for (const row of rows) {
    let selection: unknown;
    try {
      selection = JSON.parse(row.selection_json);
    } catch {
      throw new AtlasMaintenanceError(
        "PACK_PIN_UNREADABLE",
        `evidence pack "${row.id}" has an unreadable capture pin`,
      );
    }
    const ids =
      typeof selection === "object" && selection !== null
        ? (selection as { captureIds?: unknown }).captureIds
        : undefined;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      throw new AtlasMaintenanceError(
        "PACK_PIN_UNREADABLE",
        `evidence pack "${row.id}" has an unreadable capture pin`,
      );
    }
    for (const id of ids) pins.add(id);
  }
  return pins;
}

/**
 * Remove old, inactive, unpinned captures and their artifact files. Dry-run by
 * default; every protected capture is counted and never touched.
 */
export async function pruneAtlas(
  cache: Cache,
  options: AtlasPruneOptions,
): Promise<AtlasPruneReport> {
  if (!Number.isSafeInteger(options.olderThanDays) || options.olderThanDays < 1) {
    throw new AtlasMaintenanceError(
      "INVALID_ARGUMENT",
      "--older-than-days must be a positive integer",
    );
  }
  const now = options.now ?? Date.now();
  const cutoff = now - options.olderThanDays * DAY_MS;
  const apply = options.apply ?? false;

  const { report, files } = cache.withAtlasDb((db) => {
    db.exec(
      `DROP TABLE IF EXISTS temp.${PRUNE_CANDIDATES}; DROP TABLE IF EXISTS temp.${PRUNE_PATHS}`,
    );
    db.exec(`CREATE TEMP TABLE ${PRUNE_CANDIDATES} (id TEXT PRIMARY KEY)`);
    db.exec(
      `CREATE TEMP TABLE ${PRUNE_PATHS} (path TEXT PRIMARY KEY, bytes INTEGER NOT NULL)`,
    );
    db.exec(apply ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result: AtlasPruneReport = {
        dryRun: !apply,
        cutoff,
        scanned: 0,
        eligible: 0,
        deleted: 0,
        protectedActiveHeads: 0,
        protectedPacks: 0,
        skippedRunning: 0,
        retainedYoung: 0,
        skippedUnsafe: 0,
        skippedNotFile: 0,
        regions: 0,
        claims: 0,
        aliases: 0,
        artifacts: 0,
        files: 0,
        bytes: 0,
        filesDeleted: 0,
        bytesDeleted: 0,
        fileFailures: 0,
      };
      const heads = new Set(
        (
          db.prepare("SELECT DISTINCT capture_id AS id FROM atlas_heads").all() as Array<{
            id: string;
          }>
        ).map((row) => row.id),
      );
      const pins = packPins(db);
      const rows = db
        .prepare(
          `SELECT c.id, c.status,
                  COALESCE(c.last_confirmed_at, c.observed_at, c.source_fetched_at,
                           c.finished_at, c.started_at) AS age_at
           FROM atlas_captures c
           ORDER BY c.id`,
        )
        .all() as unknown as CaptureRow[];
      result.scanned = rows.length;
      const candidates: string[] = [];
      for (const row of rows) {
        if (heads.has(row.id)) {
          result.protectedActiveHeads += 1;
          continue;
        }
        if (pins.has(row.id)) {
          result.protectedPacks += 1;
          continue;
        }
        if (row.status === "running") {
          result.skippedRunning += 1;
          continue;
        }
        if (row.age_at >= cutoff) {
          result.retainedYoung += 1;
          continue;
        }
        candidates.push(row.id);
      }
      const insertCandidate = db.prepare(`INSERT INTO ${PRUNE_CANDIDATES} (id) VALUES (?)`);
      for (const id of candidates) insertCandidate.run(id);
      // A capture whose stored artifact path cannot be resolved inside this
      // cache, or whose file was replaced by a directory, is skipped whole:
      // pruning rows without their files is not safe. The two sets are
      // independent, so artifact row order cannot change the classification.
      const unsafe = new Set<string>();
      const notFile = new Set<string>();
      if (candidates.length > 0) {
        const artifactRows = db
          .prepare(
            `SELECT capture_id, storage_path FROM atlas_artifacts
             WHERE capture_id IN (SELECT id FROM ${PRUNE_CANDIDATES})
               AND storage_path IS NOT NULL`,
          )
          .all() as Array<{ capture_id: string; storage_path: string }>;
        for (const artifact of artifactRows) {
          let target: string;
          try {
            target = resolveArtifactPath(cache.rootDir, artifact.storage_path);
          } catch {
            unsafe.add(artifact.capture_id);
            continue;
          }
          const info = lstatSync(target, { throwIfNoEntry: false });
          if (info && !info.isFile()) notFile.add(artifact.capture_id);
        }
      }
      const skippedIds = new Set([...unsafe, ...notFile]);
      if (skippedIds.size > 0) {
        const removeCandidate = db.prepare(`DELETE FROM ${PRUNE_CANDIDATES} WHERE id = ?`);
        for (const id of skippedIds) removeCandidate.run(id);
      }
      result.skippedUnsafe = unsafe.size;
      result.skippedNotFile = notFile.size;
      // A non-regular artifact path is a real file-level prune failure, not a
      // quiet skip: --apply must exit non-zero while the capture rows stay.
      result.fileFailures += notFile.size;
      result.eligible = candidates.length - skippedIds.size;

      if (result.eligible > 0) {
        result.regions = count(
          db,
          `SELECT COUNT(*) AS n FROM atlas_regions
           WHERE capture_id IN (SELECT id FROM ${PRUNE_CANDIDATES})`,
        );
        result.claims = count(
          db,
          `SELECT COUNT(*) AS n FROM atlas_claims
           WHERE region_id IN (
             SELECT id FROM atlas_regions
             WHERE capture_id IN (SELECT id FROM ${PRUNE_CANDIDATES})
           )`,
        );
        result.aliases = count(
          db,
          `SELECT COUNT(*) AS n FROM atlas_aliases
           WHERE region_id IN (
             SELECT id FROM atlas_regions
             WHERE capture_id IN (SELECT id FROM ${PRUNE_CANDIDATES})
           )`,
        );
        result.artifacts = count(
          db,
          `SELECT COUNT(*) AS n FROM atlas_artifacts
           WHERE capture_id IN (SELECT id FROM ${PRUNE_CANDIDATES})`,
        );
        db.exec(
          `INSERT OR IGNORE INTO ${PRUNE_PATHS} (path, bytes)
           SELECT storage_path, bytes FROM atlas_artifacts
           WHERE capture_id IN (SELECT id FROM ${PRUNE_CANDIDATES})
             AND storage_path IS NOT NULL`,
        );
        const fileCounts = db
          .prepare(
            `SELECT COUNT(*) AS files, COALESCE(SUM(p.bytes), 0) AS bytes
             FROM ${PRUNE_PATHS} p
             WHERE NOT EXISTS (
               SELECT 1 FROM atlas_artifacts a
               WHERE a.storage_path = p.path
                 AND a.capture_id NOT IN (SELECT id FROM ${PRUNE_CANDIDATES})
             )`,
          )
          .get() as { files: number; bytes: number };
        result.files = fileCounts.files;
        result.bytes = fileCounts.bytes;
      }

      let plannedFiles: Array<{ path: string; bytes: number }> = [];
      if (apply && result.eligible > 0) {
        const fts = db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'atlas_regions_fts'",
          )
          .get();
        if (fts) {
          db.exec(
            `DELETE FROM atlas_regions_fts
             WHERE region_id IN (
               SELECT id FROM atlas_regions
               WHERE capture_id IN (SELECT id FROM ${PRUNE_CANDIDATES})
             )`,
          );
        }
        db.exec(
          `DELETE FROM atlas_claims
           WHERE region_id IN (
             SELECT id FROM atlas_regions
             WHERE capture_id IN (SELECT id FROM ${PRUNE_CANDIDATES})
           )`,
        );
        db.exec(
          `DELETE FROM atlas_aliases
           WHERE region_id IN (
             SELECT id FROM atlas_regions
             WHERE capture_id IN (SELECT id FROM ${PRUNE_CANDIDATES})
           )`,
        );
        db.exec(
          `DELETE FROM atlas_artifacts
           WHERE capture_id IN (SELECT id FROM ${PRUNE_CANDIDATES})`,
        );
        // The regions self-reference parent_id; defer those checks to COMMIT.
        db.exec("PRAGMA defer_foreign_keys = ON");
        db.exec(
          `DELETE FROM atlas_regions
           WHERE capture_id IN (SELECT id FROM ${PRUNE_CANDIDATES})`,
        );
        const removed = db
          .prepare(`DELETE FROM atlas_captures WHERE id IN (SELECT id FROM ${PRUNE_CANDIDATES})`)
          .run();
        result.deleted = Number(removed.changes);
        plannedFiles = db
          .prepare(
            `SELECT p.path, p.bytes FROM ${PRUNE_PATHS} p
             WHERE NOT EXISTS (
               SELECT 1 FROM atlas_artifacts a WHERE a.storage_path = p.path
             )`,
          )
          .all() as unknown as Array<{ path: string; bytes: number }>;
      }
      db.exec("COMMIT");
      return { report: result, files: plannedFiles };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      if (error instanceof AtlasMaintenanceError) throw error;
      throw new AtlasMaintenanceError(
        "PRUNE_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  if (apply && files.length > 0) {
    for (const file of files) {
      try {
        const deleted = await withArtifactLock(cache.rootDir, file.path, () => {
          // A concurrent publisher may have re-referenced the bytes after the
          // delete transaction; keep the file unless it is still unreferenced.
          const referenced = cache.withAtlasDb(
            (db) => db.prepare("SELECT 1 FROM atlas_artifacts WHERE storage_path = ?").get(file.path),
          );
          if (referenced !== undefined) return false;
          // An already-missing file is not a deletion: keep the counters tied
          // to bytes this prune actually removed.
          return removeArtifactFileSync(cache.rootDir, file.path);
        });
        if (deleted) {
          report.filesDeleted += 1;
          report.bytesDeleted += file.bytes;
        }
      } catch {
        report.fileFailures += 1;
      }
    }
  }
  return report;
}
