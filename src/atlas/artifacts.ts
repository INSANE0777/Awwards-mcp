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
  existsSync,
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
import { inflateSync } from "node:zlib";

const ARTIFACT_DIR = join("atlas", "artifacts");
const ARTIFACT_COMPONENTS = ["atlas", ARTIFACT_DIR] as const;
// Publish holds each per-path lock from artifact validation through COMMIT,
// and a 100k-region projection rebuild was measured at 17.7 s inside the 90 s
// capture budget. The wait therefore covers a whole publish but stays bounded:
// a lock still held after 120 s fails closed with "Atlas artifact lock timeout"
// and the caller retries (no deletion or publication has happened yet).
const LOCK_TIMEOUT_MS = 120_000;

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

export interface StoredArtifactBytes {
  storagePath: string;
  sha256: string;
  bytes: number;
  /** True when this call created the final content-addressed file. */
  created: boolean;
}

/** Content-addressed binary artifact (screenshots, packs) used by live capture. */
export function writeArtifactBytesSync(
  cacheRoot: string,
  data: Buffer,
  extension = ".bin",
): StoredArtifactBytes {
  ensureArtifactDirSync(cacheRoot);
  const sha256 = createHash("sha256").update(data).digest("hex");
  const ext = /^\.[a-z0-9]+$/i.test(extension) ? extension.toLowerCase() : ".bin";
  const storagePath = join(ARTIFACT_DIR, `${sha256}${ext}`);
  const target = resolveArtifactPath(cacheRoot, storagePath);
  if (existsSync(target)) return { storagePath, sha256, bytes: data.length, created: false };
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  writeFileSync(temp, data, { mode: 0o600, flag: "wx" });
  try {
    renameSync(temp, target);
    created = true;
  } catch (error) {
    if (!existsSync(target)) throw error;
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* best effort */
    }
  }
  return { storagePath, sha256, bytes: data.length, created };
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

export function isValidPngBuffer(buffer: Buffer): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length < 8 + 25) return false;
  for (let i = 0; i < 8; i += 1) if (buffer[i] !== signature[i]) return false;
  let offset = 8;
  let sawHeader = false;
  let sawData = false;
  let idatClosed = false;
  let sawEnd = false;
  let imageWidth = 0;
  let imageHeight = 0;
  let imageBitDepth = 8;
  let imageColorType = 0;
  let imageInterlace = 0;
  let sawPalette = false;
  const idat: Buffer[] = [];
  let index = 0;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (length > buffer.length || dataEnd + 4 > buffer.length) return false;
    const expectedCrc = buffer.readUInt32BE(dataEnd);
    if (crc32(buffer.subarray(offset + 4, dataEnd)) !== expectedCrc) return false;
    if (index === 0) {
      if (type !== "IHDR" || length !== 13) return false;
      const width = buffer.readUInt32BE(dataStart);
      const height = buffer.readUInt32BE(dataStart + 4);
      const bitDepth = buffer[dataStart + 8];
      const colorType = buffer[dataStart + 9];
      const compression = buffer[dataStart + 10];
      const filter = buffer[dataStart + 11];
      const interlace = buffer[dataStart + 12];
      if (width === 0 || height === 0) return false;
      if (![1, 2, 4, 8, 16].includes(bitDepth ?? -1)) return false;
      if (![0, 2, 3, 4, 6].includes(colorType ?? -1)) return false;
      const allowedDepths =
        colorType === 0
          ? [1, 2, 4, 8, 16]
          : colorType === 2 || colorType === 4 || colorType === 6
            ? [8, 16]
            : [1, 2, 4, 8];
      if (!allowedDepths.includes(bitDepth ?? -1)) return false;
      if (compression !== 0 || filter !== 0 || ![0, 1].includes(interlace ?? -1)) return false;
      imageWidth = width;
      imageHeight = height;
      imageBitDepth = bitDepth!;
      imageColorType = colorType!;
      imageInterlace = interlace!;
      sawHeader = true;
    } else if (type === "IHDR") {
      return false;
    } else if (type === "IDAT") {
      if (!sawHeader || sawEnd || idatClosed) return false;
      if (imageColorType === 3 && !sawPalette) return false;
      sawData = true;
      idat.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === "PLTE") {
      if (!sawHeader || sawData || sawEnd || sawPalette) return false;
      if (imageColorType === 0 || imageColorType === 4) return false;
      if (length === 0 || length % 3 !== 0 || length > 768) return false;
      if (length / 3 > 2 ** imageBitDepth) return false;
      sawPalette = true;
    } else if (type === "IEND") {
      if (!sawData || length !== 0) return false;
      sawEnd = true;
    } else if (/^[A-Z]/.test(type)) {
      return false;
    } else if (sawData) {
      idatClosed = true;
    }
    offset = dataEnd + 4;
    index += 1;
    if (sawEnd) break;
  }
  if (offset !== buffer.length) return false;
  if (!sawHeader || !sawData || !sawEnd) return false;
  try {
    const decoded = inflateSync(Buffer.concat(idat), {
      maxOutputLength: 64 * 1024 * 1024,
    });
    if (decoded.length === 0) return false;
    if (imageInterlace !== 0) return false;
    const channels =
      imageColorType === 0
        ? 1
        : imageColorType === 2
          ? 3
          : imageColorType === 3
            ? 1
            : imageColorType === 4
              ? 2
              : 4;
    const rowBytes = Math.ceil((imageWidth * channels * imageBitDepth) / 8);
    const expected = imageHeight * (1 + rowBytes);
    if (decoded.length !== expected) return false;
    for (let row = 0; row < imageHeight; row += 1) {
      if (decoded[row * (1 + rowBytes)]! > 4) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function isPngStoredArtifact(cacheRoot: string, artifact: StoredArtifactRef): boolean {
  try {
    const target = resolveArtifactPath(cacheRoot, artifact.storagePath);
    return isValidPngBuffer(readFileSync(target));
  } catch {
    return false;
  }
}

export function artifactPointerResolves(  cacheRoot: string,
  artifact: StoredArtifactRef,
  pointer: string,
): boolean {
  if (pointer !== "" && !pointer.startsWith("/")) return false;
  let node: unknown;
  try {
    node = readStoredArtifactJson(cacheRoot, artifact);
  } catch {
    return false;
  }
  if (pointer === "") return true;
  for (const raw of pointer.slice(1).split("/")) {
    let token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    try {
      token = decodeURIComponent(token);
    } catch {
      return false;
    }
    if (Array.isArray(node)) {
      if (!/^\d+$/.test(token)) return false;
      const index = Number(token);
      if (index >= node.length) return false;
      node = node[index];
    } else if (node && typeof node === "object") {
      if (!Object.prototype.hasOwnProperty.call(node, token)) return false;
      node = (node as Record<string, unknown>)[token];
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Remove one artifact file. Returns false only when the file is already gone;
 * unsafe, non-regular and permission failures throw so callers can report them.
 */
export function removeArtifactFileSync(cacheRoot: string, storagePath: string): boolean {
  const target = resolveArtifactPath(cacheRoot, storagePath);
  const info = lstatSync(target, { throwIfNoEntry: false });
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("artifact path is not a file");
  }
  try {
    rmSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return true;
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
 * Hold several artifact locks for one operation. Targets are resolved before
 * deduplication so two spellings of one file (separator style or case) cannot
 * self-deadlock, then acquired in sorted order so concurrent publishers cannot
 * deadlock each other.
 */
export async function withArtifactLocks<T>(
  cacheRoot: string,
  storagePaths: readonly string[],
  fn: () => Promise<T> | T,
): Promise<T> {
  await ensureArtifactDir(cacheRoot);
  const unique = new Map<string, string>();
  for (const storagePath of storagePaths) {
    const target = resolveArtifactPath(cacheRoot, storagePath);
    if (!unique.has(target)) unique.set(target, storagePath);
  }
  const ordered = [...unique.keys()].sort().map((target) => unique.get(target)!);
  const acquire = async (index: number): Promise<T> =>
    index >= ordered.length
      ? fn()
      : withArtifactLock(cacheRoot, ordered[index]!, () => acquire(index + 1));
  return acquire(0);
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
