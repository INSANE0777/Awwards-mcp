import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const ARTIFACT_DIR = join("atlas", "artifacts");
const ARTIFACT_COMPONENTS = ["atlas", ARTIFACT_DIR] as const;
const LOCK_TIMEOUT_MS = 10_000;

export interface ArtifactIdentity {
  storagePath: string;
  sha256: string;
  bytes: number;
  text: string;
}

export interface WrittenArtifact {
  storagePath: string;
  sha256: string;
  bytes: number;
  /** True when this call created the final content-addressed file. */
  created: boolean;
}

export function artifactIdentity(value: unknown): ArtifactIdentity {
  const text = JSON.stringify(value);
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  return {
    text,
    sha256,
    storagePath: join(ARTIFACT_DIR, `${sha256}.json`),
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

/** Content-addressed JSON artifact under <cache>/atlas/artifacts. */
export async function writeJsonArtifact(
  cacheRoot: string,
  value: unknown,
  options: { lock?: boolean } = {},
): Promise<WrittenArtifact> {
  const identity = artifactIdentity(value);
  if (options.lock === false) return writeJsonArtifactUnlocked(cacheRoot, identity);
  return withArtifactLock(cacheRoot, identity.storagePath, () =>
    writeJsonArtifactUnlocked(cacheRoot, identity),
  );
}

async function writeJsonArtifactUnlocked(
  cacheRoot: string,
  identity: ArtifactIdentity,
): Promise<WrittenArtifact> {
  const { text, sha256, storagePath } = identity;
  await ensureArtifactDir(cacheRoot);
  const target = resolveArtifactPath(cacheRoot, storagePath);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  let tempOwned = false;
  try {
    // wx refuses an existing file or symlink at the temp path.
    await writeFile(temp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    tempOwned = true;
    const existing = await readFile(target).catch(() => null);
    if (existing !== null) {
      if (hash(existing) !== sha256) {
        throw new Error("Atlas artifact content hash mismatch");
      }
    } else {
      try {
        await rename(temp, target);
        created = true;
      } catch (error) {
        // A concurrent writer may have published the same target first.
        const winner = await readFile(target).catch(() => null);
        if (winner === null || hash(winner) !== sha256) throw error;
      }
    }
  } finally {
    // Only remove a temp file this call exclusively created.
    if (tempOwned) await rm(temp, { force: true }).catch(() => undefined);
  }
  return { storagePath, sha256, bytes: identity.bytes, created };
}

const localLocks = new Map<string, Promise<void>>();

/** Visible for tests: number of in-flight or queued local artifact locks. */
export function localArtifactLockCount(): number {
  return localLocks.size;
}

/** Synchronous variant for callers already holding the SQLite write lock. */
export function writeJsonArtifactSync(cacheRoot: string, value: unknown): WrittenArtifact {
  const identity = artifactIdentity(value);
  ensureArtifactDirSync(cacheRoot);
  const target = resolveArtifactPath(cacheRoot, identity.storagePath);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  let tempOwned = false;
  try {
    writeFileSync(temp, identity.text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    tempOwned = true;
    const existing = readFileSync(target, { encoding: "utf8", flag: "r" });
    if (hash(existing) !== identity.sha256) {
      throw new Error("Atlas artifact content hash mismatch");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        renameSync(temp, target);
        created = true;
      } catch (renameError) {
        const winner = readFileSync(target, { encoding: "utf8", flag: "r" });
        if (hash(winner) !== identity.sha256) throw renameError;
      }
    } else {
      throw error;
    }
  } finally {
    if (tempOwned) {
      try {
        rmSync(temp, { force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }
  return { storagePath: identity.storagePath, sha256: identity.sha256, bytes: identity.bytes, created };
}

export interface StoredArtifactRef {
  storagePath: string;
  sha256: string;
  bytes: number;
}

/** Returns null when the stored file matches its size and SHA-256. */
export function validateStoredArtifact(
  cacheRoot: string,
  artifact: StoredArtifactRef,
): string | null {
  try {
    const target = resolveArtifactPath(cacheRoot, artifact.storagePath);
    const info = statSync(target);
    if (!info.isFile()) return "artifact path is not a file";
    if (info.size !== artifact.bytes) return "artifact byte size mismatch";
    const actual = hash(readFileSync(target));
    if (actual !== artifact.sha256) return "artifact SHA-256 mismatch";
    return null;
  } catch {
    return "artifact file is missing or unreadable";
  }
}

export function readStoredArtifactJson(
  cacheRoot: string,
  artifact: StoredArtifactRef,
): unknown {
  const target = resolveArtifactPath(cacheRoot, artifact.storagePath);
  return JSON.parse(readFileSync(target, "utf8"));
}

export function removeArtifactFileSync(cacheRoot: string, storagePath: string): void {  const target = resolveArtifactPath(cacheRoot, storagePath);
  try {
    rmSync(target, { force: true });
  } catch {
    /* best-effort cleanup */
  }
}

function ensureArtifactDirSync(cacheRoot: string): void {
  const root = realpathSync(cacheRoot);
  const atlas = join(root, "atlas");
  const artifacts = join(root, ARTIFACT_DIR);
  for (const path of [atlas, artifacts]) {
    try {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isDirectory()) throw invalidArtifactPath();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw invalidArtifactPath();
      mkdirSync(path, { mode: 0o700 });
    }
  }
  const realDir = realpathSync(artifacts);
  if (realDir !== artifacts) throw invalidArtifactPath();
}

/**
 * Serialize publication/cleanup for one artifact path. The process queue
 * prevents same-process polling; the lock file coordinates other processes.
 */
export async function withArtifactLock<T>(
  cacheRoot: string,
  storagePath: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  await ensureArtifactDir(cacheRoot);
  const target = resolveArtifactPath(cacheRoot, storagePath);
  const previous = localLocks.get(target) ?? Promise.resolve();
  let releaseLocal!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseLocal = resolve;
  });
  const chain = previous.then(() => current);
  localLocks.set(target, chain);
  await previous;
  try {
    const lockPath = `${target}.lock`;
    const token = randomUUID();
    const handle = await acquireLockFile(lockPath, token);
    try {
      return await fn();
    } finally {
      await handle.close().catch(() => undefined);
      const currentToken = await readFile(lockPath, "utf8").catch(() => null);
      if (currentToken === token) await unlink(lockPath).catch(() => undefined);
    }
  } finally {
    releaseLocal();
    if (localLocks.get(target) === chain) localLocks.delete(target);
  }
}

async function acquireLockFile(
  lockPath: string,
  token: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(token, "utf8");
        return handle;
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("Atlas artifact lock timeout");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/**
 * Resolve a stored artifact path and prove it stays inside the cache's
 * artifacts directory after symlink/junction resolution.
 */
export function resolveArtifactPath(cacheRoot: string, storagePath: string): string {
  const normalized = normalizeArtifactPath(storagePath);
  let realRoot: string;
  try {
    realRoot = realpathSync(cacheRoot);
    assertArtifactComponents(realRoot);
  } catch {
    throw invalidArtifactPath();
  }
  const candidate = join(realRoot, normalized);
  let realDir: string;
  try {
    realDir = realpathSync(dirname(candidate));
  } catch {
    throw invalidArtifactPath();
  }
  if (realDir !== join(realRoot, ARTIFACT_DIR) || !isInside(realRoot, realDir)) {
    throw invalidArtifactPath();
  }
  const realCandidate = join(realDir, basename(candidate));
  if (!isInside(realRoot, realCandidate)) throw invalidArtifactPath();

  const stat = lstatSync(realCandidate, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw invalidArtifactPath();
  if (stat) {
    const resolved = realpathSync(realCandidate);
    if (resolved !== realCandidate || !isInside(realRoot, resolved)) {
      throw invalidArtifactPath();
    }
  }
  return realCandidate;
}

/** Remove an artifact this commit created but no transaction referenced. */
export async function removeArtifactFile(cacheRoot: string, storagePath: string): Promise<void> {
  const target = resolveArtifactPath(cacheRoot, storagePath);
  await rm(target, { force: true });
}

/**
 * Validate every path component before creating it. A junction or symlink at
 * `atlas` or `atlas/artifacts` is rejected even when it targets inside the
 * cache root, so artifact writes cannot be redirected.
 */
async function ensureArtifactDir(cacheRoot: string): Promise<string> {
  let realRoot: string;
  try {
    realRoot = realpathSync(cacheRoot);
  } catch {
    throw invalidArtifactPath();
  }
  for (const component of ARTIFACT_COMPONENTS) {
    const path = join(realRoot, component);
    const before = lstatSync(path, { throwIfNoEntry: false });
    if (!before) {
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } else if (before.isSymbolicLink() || !before.isDirectory()) {
      throw invalidArtifactPath();
    }
    const after = lstatSync(path, { throwIfNoEntry: false });
    if (!after || after.isSymbolicLink() || !after.isDirectory()) {
      throw invalidArtifactPath();
    }
  }
  return join(realRoot, ARTIFACT_DIR);
}

function assertArtifactComponents(realRoot: string): void {
  for (const component of ARTIFACT_COMPONENTS) {
    const stat = lstatSync(join(realRoot, component), { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw invalidArtifactPath();
  }
}

function normalizeArtifactPath(storagePath: string): string {
  if (!storagePath || storagePath.includes("\u0000")) throw invalidArtifactPath();
  if (
    isAbsolute(storagePath) ||
    /^[A-Za-z]:[\\/]/.test(storagePath) ||
    /^[\\/]{2}/.test(storagePath)
  ) {
    throw invalidArtifactPath();
  }
  const parts = storagePath.replaceAll("\\", "/").split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw invalidArtifactPath();
  }
  const normalized = parts.join(sep);
  const prefix = `${ARTIFACT_DIR}${sep}`;
  if (!normalized.startsWith(prefix)) throw invalidArtifactPath();
  const file = normalized.slice(prefix.length);
  // shortcut: Phase 1 artifacts are flat; allow nested pack paths when packs land.
  if (!file || file.includes(sep)) throw invalidArtifactPath();
  return normalized;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function invalidArtifactPath(): Error {
  return new Error("invalid Atlas artifact path");
}
