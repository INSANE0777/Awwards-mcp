import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const LEASE_DB = join("atlas", "capture-lease.db");
const DEFAULT_TTL_MS = 120_000;

export interface AtlasCaptureLease {
  token: string;
  expiresAt: number;
  path: string;
}

export class AtlasLeaseBusyError extends Error {
  readonly code = "CAPTURE_BUSY";
  constructor(message = "Another Atlas capture owns this cache") {
    super(message);
    this.name = "AtlasLeaseBusyError";
  }
}

export class AtlasLeaseCorruptError extends Error {
  readonly code = "CAPTURE_LEASE_CORRUPT";
  constructor(
    readonly path: string,
    message = "The Atlas capture lease database is corrupt or incompatible",
  ) {
    super(`${message}: ${path}`);
    this.name = "AtlasLeaseCorruptError";
  }
}

function isCorrupt(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? error);
  const code = Number((error as { errcode?: unknown })?.errcode ?? -1);
  return (
    code === 11 ||
    code === 26 ||
    /SQLITE_CORRUPT|SQLITE_NOTADB|malformed|not a database|no such column|no such table/i.test(
      message,
    )
  );
}

export class AtlasLeaseUnavailableError extends Error {
  readonly code = "CAPTURE_LEASE_UNAVAILABLE";
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${message}: ${path}`);
    this.name = "AtlasLeaseUnavailableError";
  }
}

function isBusy(error: unknown): boolean {
  const code = Number((error as { errcode?: unknown })?.errcode ?? -1);
  const message = String((error as { message?: unknown })?.message ?? error);
  return code === 5 || code === 6 || /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(message);
}

function schemaValid(db: DatabaseSync): boolean {
  try {
    const rows = db
      .prepare("PRAGMA table_info(atlas_capture_lease)")
      .all() as Array<{ name: string; pk: number; notnull: number }>;
    const singleton = rows.find((row) => row.name === "singleton");
    const token = rows.find((row) => row.name === "token");
    const expires = rows.find((row) => row.name === "expires_at");
    return Boolean(
      singleton?.pk === 1 &&
        token?.pk === 0 &&
        expires?.pk === 0 &&
        token?.notnull === 1 &&
        expires?.notnull === 1,
    );
  } catch {
    return false;
  }
}

function openLeaseDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(
      `CREATE TABLE IF NOT EXISTS atlas_capture_lease (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         token TEXT NOT NULL,
         expires_at INTEGER NOT NULL
       )`,
    );
    if (!schemaValid(db)) {
      throw new Error("SQLITE_CORRUPT: incompatible atlas_capture_lease schema");
    }
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      /* close best effort */
    }
    throw error;
  }
}

function quarantine(path: string): string {
  const target = `${path}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
  // Windows refuses to rename a file while another process still has it
  // open. The losing recovery worker is about to close and retry, so give it
  // a short bounded window instead of swallowing the failure and leaving the
  // corrupt file in place.
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      renameSync(path, target);
      return target;
    } catch {
      Atomics.wait(buffer, 0, 0, 20);
    }
  }
  try {
    renameSync(path, target);
  } catch {
    /* the caller will surface the corrupt path */
  }
  return target;
}

function openWithRecovery(path: string): DatabaseSync {
  try {
    return openLeaseDb(path);
  } catch (error) {
    if (!isCorrupt(error)) throw error;
    const lock = `${path}.recover.lock`;
    let ownsLock = false;
    try {
      writeFileSync(lock, "", { flag: "wx", mode: 0o600 });
      ownsLock = true;
    } catch {
      const buffer = new Int32Array(new SharedArrayBuffer(4));
      for (let attempt = 0; attempt < 100; attempt += 1) {
        Atomics.wait(buffer, 0, 0, 20);
        try {
          return openLeaseDb(path);
        } catch (retry) {
          if (!isCorrupt(retry)) throw retry;
        }
      }
      throw new AtlasLeaseCorruptError(path);
    }
    try {
      try {
        return openLeaseDb(path);
      } catch (retry) {
        if (!isCorrupt(retry)) throw retry;
      }
      quarantine(path);
      try {
        return openLeaseDb(path);
      } catch (retry) {
        if (isCorrupt(retry)) throw new AtlasLeaseCorruptError(path);
        throw retry;
      }
    } finally {
      if (ownsLock) {
        try {
          rmSync(lock, { force: true });
        } catch {
          /* best effort */
        }
      }
    }
  }
}

function pauseAfterRead(): void {
  const ms = Number(process.env.ATLAS_LEASE_AFTER_READ_MS ?? 0);
  if (Number.isFinite(ms) && ms > 0) {
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buffer, 0, 0, ms);
  }
}

/** Acquire the per-cache single-owner capture lease atomically. */
export function acquireAtlasCaptureLease(
  cacheRoot: string,
  options: { token?: string; ttlMs?: number; now?: number } = {},
): AtlasCaptureLease {
  const directory = join(cacheRoot, "atlas");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(cacheRoot, LEASE_DB);
  const token = options.token ?? randomUUID();
  const now = options.now ?? Date.now();
  const expiresAt = now + Math.max(1, options.ttlMs ?? DEFAULT_TTL_MS);
  let db: DatabaseSync | undefined;
  try {
    db = openWithRecovery(path);
    db.exec("BEGIN IMMEDIATE");
    const current = db
      .prepare("SELECT token, expires_at FROM atlas_capture_lease WHERE singleton = 1")
      .get() as { token: string; expires_at: number } | undefined;
    pauseAfterRead();
    if (current && current.expires_at > now) {
      db.exec("ROLLBACK");
      throw new AtlasLeaseBusyError();
    }
    db.prepare(
      `INSERT INTO atlas_capture_lease (singleton, token, expires_at)
       VALUES (1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET token = excluded.token,
         expires_at = excluded.expires_at`,
    ).run(token, expiresAt);
    db.exec("COMMIT");
    return { token, expiresAt, path };
  } catch (error) {
    try {
      db?.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    if (error instanceof AtlasLeaseBusyError || error instanceof AtlasLeaseCorruptError) {
      throw error;
    }
    if (error instanceof AtlasLeaseUnavailableError) throw error;
    if (isCorrupt(error)) throw new AtlasLeaseCorruptError(path);
    if (isBusy(error)) throw new AtlasLeaseBusyError();
    throw new AtlasLeaseUnavailableError(
      path,
      error instanceof Error ? error.message : "The Atlas lease could not be opened",
    );
  } finally {
    try {
      db?.close();
    } catch {
      /* close is best effort */
    }
  }
}

/** Release only when the token still owns the lease. Returns whether it did. */
export function releaseAtlasCaptureLease(lease: AtlasCaptureLease): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = openWithRecovery(lease.path);
    db.exec("BEGIN IMMEDIATE");
    const result = db
      .prepare("DELETE FROM atlas_capture_lease WHERE singleton = 1 AND token = ?")
      .run(lease.token);
    db.exec("COMMIT");
    return Number(result.changes ?? 0) > 0;
  } catch (error) {
    try {
      db?.exec("ROLLBACK");
    } catch {
      /* best effort */
    }
    if (isCorrupt(error)) throw new AtlasLeaseCorruptError(lease.path);
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* best effort */
    }
  }
}
