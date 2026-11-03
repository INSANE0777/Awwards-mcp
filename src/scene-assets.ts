// Selected asset acquisition for a scene evidence pack. This module never
// discovers assets: it reads the capture's own evidence.json inventory and
// fetches only entries that were marked downloadable when the page's response
// was observed. Rights are the caller's assertion and are recorded, not
// verified. Every hop is DNS-validated and private/reserved addresses are
// refused; the connection is pinned to the validated address.
import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isAbsolute, join, relative } from "node:path";
import {
  isPrivateAddress,
  normalizeScenePrivateOrigins,
  redactSceneError,
  type SceneEvidence,
  type SceneResource,
} from "./scene-capture.js";

export const SCENE_ASSET_LIMITS = {
  maxIds: 32,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  bodyDeadlineMs: 15_000,
  overallDeadlineMs: 120_000,
  maxRedirects: 5,
  // Shared by every download in this process, so two tool calls cannot exceed
  // one request per second between them.
  minRequestIntervalMs: 1_000,
  maxEvidenceBytes: 4 * 1024 * 1024,
  maxRightsEvidenceChars: 2_000,
  maxMimeChars: 128,
  maxInventoryRows: 1_000,
  maxProvenanceBytes: 1024 * 1024,
} as const;

export type SceneRightsBasis = "owned" | "licensed" | "permission";

export interface SceneRights {
  basis: SceneRightsBasis;
  evidence: string;
}

export interface SceneAssetFile {
  assetId: string;
  path: string;
  sha256: string;
  bytes: number;
  mime: string;
}

export interface SceneAssetsResult {
  id: "scene-assets-v1";
  captureId: string;
  downloaded: number;
  skipped: number;
  /** Every body byte read this run, including discarded and failed transfers. */
  receivedBytes: number;
  /** Bytes actually published as files. */
  totalBytes: number;
  rights: SceneRights & { recordedAt: number };
  files: SceneAssetFile[];
  limitations: string[];
  /** Present only when the client's signal aborted the run. */
  cancelled?: true;
}

/** Test-only seams; none of these are exposed by a tool schema. */
export interface SceneAssetDownloadOptions {
  sceneDir: string;
  captureId: string;
  assetIds: string[];
  rights: SceneRights;
  /** Save assets whose MIME and magic bytes identify no known type as .bin. */
  allowUnknown?: boolean;
  /** Client cancellation; an abort stops before the next asset and cancels the in-flight request. */
  signal?: AbortSignal;
  resolveHost?: (hostname: string) => Promise<string[]>;
  /** Exact http(s) origins that may resolve to loopback/private addresses. */
  allowPrivateOrigins?: string[];
  fetch?: SceneAssetFetcher;
  limits?: Partial<typeof SCENE_ASSET_LIMITS>;
  now?: () => number;
}

export type DownloadSceneAssetsFn = (
  opts: SceneAssetDownloadOptions,
) => Promise<SceneAssetsResult | { error: string }>;

export interface SceneAssetHop {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}

/** Dials `url` at the already-validated `address`. */
export type SceneAssetFetcher = (
  url: URL,
  address: string,
  signal: AbortSignal,
) => Promise<SceneAssetHop>;

const CAPTURE_ID_RE = /^scene-[a-z0-9]{1,24}-[0-9a-f]{8}$/;
const ASSET_ID_RE = /^asset-\d{1,4}$/;
const RIGHTS_BASES: readonly string[] = ["owned", "licensed", "permission"];
// The client-abort skip reason, shared by the job loop and the in-flight races.
const CLIENT_CANCELLED = "cancelled by the client";

// A Map, not an object literal: a Content-Type such as "constructor" must miss
// instead of resolving through Object.prototype.
const MIME_EXTENSIONS = new Map<string, string>([
  ["model/gltf-binary", "glb"],
  ["model/gltf+json", "gltf"],
  ["application/octet-stream", "bin"],
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/webp", "webp"],
  ["image/ktx2", "ktx2"],
  ["image/vnd.radiance", "hdr"],
  ["image/x-exr", "exr"],
  ["image/exr", "exr"],
]);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KTX2_MAGIC = Buffer.from([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** A per-asset failure that becomes a counted skip, never a thrown run. */
class AssetSkip extends Error {
  constructor(
    message: string,
    readonly stop = false,
  ) {
    super(message);
  }
}

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message.replace(/\s+/g, " ").trim() : String(err);

const mib = (bytes: number): string => `${Math.round((bytes / (1024 * 1024)) * 10) / 10}`;

const defaultResolveHost = async (hostname: string): Promise<string[]> =>
  (await lookup(hostname, { all: true, verbatim: true })).map((row) => row.address);

// One download at a time and one request per second across the whole process.
let downloadQueue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

function normalizeRights(input: SceneRights | undefined): { rights: SceneRights } | { error: string } {
  const basis = typeof input?.basis === "string" ? input.basis : "";
  if (!RIGHTS_BASES.includes(basis)) {
    return { error: 'rights.basis must be "owned", "licensed" or "permission".' };
  }
  const evidence = typeof input?.evidence === "string" ? input.evidence.trim() : "";
  if (!evidence) {
    return {
      error:
        "rights.evidence is required: state the licence, ownership or permission that allows downloading these assets.",
    };
  }
  if (evidence.length > SCENE_ASSET_LIMITS.maxRightsEvidenceChars) {
    return {
      error: `rights.evidence must be at most ${SCENE_ASSET_LIMITS.maxRightsEvidenceChars} characters.`,
    };
  }
  return { rights: { basis: basis as SceneRightsBasis, evidence } };
}

function normalizeAssetIds(input: unknown): { ids: string[] } | { error: string } {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: `assetIds must list between 1 and ${SCENE_ASSET_LIMITS.maxIds} inventory IDs.` };
  }
  if (input.length > SCENE_ASSET_LIMITS.maxIds) {
    return {
      error: `assetIds accepts at most ${SCENE_ASSET_LIMITS.maxIds} IDs (received ${input.length}).`,
    };
  }
  const ids: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string" || !ASSET_ID_RE.test(raw)) {
      return { error: `assetId ${JSON.stringify(raw)} is not an inventory ID (expected asset-<n>).` };
    }
    if (!ids.includes(raw)) ids.push(raw);
  }
  return { ids };
}

/** http(s), no credentials, no query, no fragment: the only URLs we fetch. */
export function safeSceneDownloadUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

/** Shared with scene-verify: schema-shaped id, real directory, no symlink, inside the root. */
export async function resolveSceneCaptureDir(
  sceneDir: string,
  captureId: unknown,
): Promise<{ dir: string } | { error: string }> {
  if (typeof captureId !== "string" || !CAPTURE_ID_RE.test(captureId)) {
    return { error: "captureId is not a scene capture ID (expected scene-<time>-<hex>)." };
  }
  const missing = { error: `scene capture ${captureId} was not found under scene-captures.` };
  let root: string;
  try {
    root = await realpath(sceneDir);
  } catch {
    return missing;
  }
  const candidate = join(root, captureId);
  let entry;
  try {
    entry = await lstat(candidate);
  } catch {
    return missing;
  }
  // lstat does not follow the final component: a symlinked capture is refused
  // even when it points inside the root.
  if (entry.isSymbolicLink() || !entry.isDirectory()) return missing;
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    return missing;
  }
  const rel = relative(root, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return { error: `scene capture ${captureId} escapes the scene-captures directory.` };
  }
  return { dir: resolved };
}

interface InventoryAsset {
  assetId: string;
  downloadUrl: string | null;
  skipReason: string | null;
  mime: string;
}

async function readInventory(
  dir: string,
  captureId: string,
  limits: typeof SCENE_ASSET_LIMITS,
): Promise<{ assets: Map<string, InventoryAsset> } | { error: string }> {
  const evidencePath = join(dir, "evidence.json");
  let entry;
  try {
    entry = await lstat(evidencePath);
  } catch {
    return { error: `scene capture ${captureId} has no evidence.json.` };
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    return { error: `scene capture ${captureId} evidence.json is not a regular file.` };
  }
  if (entry.size > limits.maxEvidenceBytes) {
    return { error: `scene capture ${captureId} evidence.json is too large to read.` };
  }
  let evidence: SceneEvidence;
  try {
    evidence = JSON.parse(await readFile(evidencePath, "utf8")) as SceneEvidence;
  } catch {
    return { error: `scene capture ${captureId} evidence.json is not valid JSON.` };
  }
  if (
    evidence?.id !== "scene-evidence-v1" ||
    evidence.captureId !== captureId ||
    !Array.isArray(evidence.resources)
  ) {
    return { error: `scene capture ${captureId} evidence.json does not belong to this captureId.` };
  }

  const assets = new Map<string, InventoryAsset>();
  for (const row of evidence.resources.slice(0, limits.maxInventoryRows)) {
    const resource = row as SceneResource & { download?: { status?: string; url?: string; reason?: string } };
    if (typeof resource?.assetId !== "string" || !ASSET_ID_RE.test(resource.assetId)) continue;
    if (assets.has(resource.assetId)) continue;
    const download = resource.download;
    let downloadUrl: string | null = null;
    let skipReason: string | null = null;
    if (download?.status === "available") {
      downloadUrl = safeSceneDownloadUrl(download.url);
      if (!downloadUrl) skipReason = "the stored download URL is not a safe http(s) URL";
    } else {
      skipReason =
        typeof download?.reason === "string" && download.reason
          ? download.reason.slice(0, 300)
          : "the pack did not mark this resource downloadable";
    }
    assets.set(resource.assetId, {
      assetId: resource.assetId,
      downloadUrl,
      skipReason,
      mime: typeof resource.mime === "string" ? resource.mime.slice(0, limits.maxMimeChars) : "",
    });
  }
  return { assets };
}

async function ensureAssetsDir(dir: string): Promise<string> {
  const assetsDir = join(dir, "assets");
  let entry;
  try {
    entry = await lstat(assetsDir);
  } catch {
    entry = null;
  }
  if (entry && (entry.isSymbolicLink() || !entry.isDirectory())) {
    throw new Error("the capture's assets path exists but is not a directory");
  }
  await mkdir(assetsDir, { recursive: true, mode: 0o700 });
  return assetsDir;
}

async function publishFile(path: string, bytes: Buffer): Promise<void> {
  const tmp = `${path}.partial-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(tmp, bytes, { mode: 0o600, flag: "wx" });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

function sniffMagic(bytes: Buffer, mime: string, url: URL): string | null {
  const startsWith = (magic: Buffer): boolean =>
    bytes.length >= magic.length && bytes.subarray(0, magic.length).equals(magic);
  if (startsWith(PNG_MAGIC)) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (
    bytes.length >= 12 &&
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  if (bytes.length >= 4 && bytes.toString("latin1", 0, 4) === "glTF") return "glb";
  if (startsWith(KTX2_MAGIC)) return "ktx2";
  if (bytes.length >= 4 && bytes[0] === 0x76 && bytes[1] === 0x2f && bytes[2] === 0x31 && bytes[3] === 0x01) {
    return "exr";
  }
  const head = bytes.toString("latin1", 0, Math.min(bytes.length, 16));
  if (head.startsWith("#?RADIANCE") || head.startsWith("#?RGBE")) return "hdr";
  // JSON is only an asset magic when the response itself claims glTF/JSON.
  const text = bytes.toString("utf8", 0, Math.min(bytes.length, 64)).trimStart();
  if (text.startsWith("{") && (mime.includes("json") || url.pathname.toLowerCase().endsWith(".gltf"))) {
    return "gltf";
  }
  return null;
}

/** Validated extension from magic first, then MIME; null when unknown. */
export function sceneAssetExtension(
  bytes: Buffer,
  mime: string,
  url: URL,
  allowUnknown: boolean,
): string | null {
  const magic = sniffMagic(bytes, mime, url);
  if (magic) return magic;
  const fromMime = MIME_EXTENSIONS.get(mime);
  if (fromMime) return fromMime;
  return allowUnknown ? "bin" : null;
}

function pinnedLookup(address: string): (hostname: string, options: any, callback?: any) => void {
  const family = address.includes(":") ? 6 : 4;
  return (_hostname: string, options: any, callback?: any) => {
    const done = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? {} : (options ?? {});
    if (opts.all) done(null, [{ address, family }]);
    else done(null, address, family);
  };
}

/** Direct Node http(s); the connection dials the validated address only. */
const defaultFetcher: SceneAssetFetcher = (url, address, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const secure = url.protocol === "https:";
    const options: Record<string, unknown> = {
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || (secure ? 443 : 80)),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { accept: "*/*", "user-agent": "awwwards-mcp scene-assets" },
      lookup: pinnedLookup(address),
      // No pooled socket may outlive this request.
      agent: false,
      ...(secure ? { servername: url.hostname.replace(/^\[|\]$/g, "") } : {}),
    };
    const request = (secure ? httpsRequest : httpRequest)(options as any, (response) => {
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: response as AsyncIterable<Uint8Array>,
        destroy: () => response.destroy(),
      });
    });
    // The overall deadline aborts a connection that never answers.
    signal.addEventListener("abort", () => request.destroy(new Error("aborted")), { once: true });
    request.on("error", reject);
    request.end();
  });

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

interface FetchContext {
  fetcher: SceneAssetFetcher;
  resolveHost: (hostname: string) => Promise<string[]>;
  trustedOrigins: ReadonlySet<string>;
  maxBytes: number;
  /** Run-level received-byte counter, shared by every body read. */
  budget: { receivedBytes: number };
  overflowReason: string;
  overflowStops: boolean;
  deadlineAt: number;
  deadlineReason: string;
  now: () => number;
  limits: typeof SCENE_ASSET_LIMITS;
  /** Client cancellation; races every DNS, connection and body step. */
  signal?: AbortSignal;
}

async function acquireRequestSlot(
  now: () => number,
  limits: typeof SCENE_ASSET_LIMITS,
  signal?: AbortSignal,
): Promise<void> {
  const wait = lastRequestAt + limits.minRequestIntervalMs - now();
  if (wait > 0) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, wait);
      timer.unref?.();
      const onAbort = () => {
        clearTimeout(timer);
        reject(new AssetSkip(CLIENT_CANCELLED, true));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  lastRequestAt = now();
}

/**
 * A client abort promise that rejects the pending step with a run-stopping
 * skip. The step's own promise is abandoned, like the deadline race; the
 * optional hook closes whatever socket the step owns.
 */
function cancelWatch(
  ctx: FetchContext,
  beforeReject?: () => void,
): { promise: Promise<never>; clear: () => void } | null {
  const signal = ctx.signal;
  if (!signal) return null;
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    listener = () => {
      try {
        beforeReject?.();
      } catch {
        /* the step's resource is already gone */
      }
      reject(new AssetSkip(CLIENT_CANCELLED, true));
    };
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
  });
  promise.catch(() => undefined);
  return {
    promise,
    clear: () => {
      if (listener) signal.removeEventListener("abort", listener);
    },
  };
}

async function resolveHop(url: URL, ctx: FetchContext): Promise<string> {
  const host = url.hostname.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new AssetSkip("the URL has no host");
  const trusted = ctx.trustedOrigins.has(url.origin);
  if (!trusted && (host === "localhost" || host.endsWith(".localhost"))) {
    throw new AssetSkip("localhost is never downloaded");
  }
  let addresses: string[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = cancelWatch(ctx);
  try {
    const pending = ctx.resolveHost(host);
    // A resolver that never settles must not hold the run or the queue.
    pending.catch(() => undefined);
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new AssetSkip(ctx.deadlineReason, true)),
        Math.max(0, ctx.deadlineAt - ctx.now()),
      );
      timer.unref?.();
    });
    addresses = await Promise.race([
      pending,
      deadline,
      ...(cancel ? [cancel.promise] : []),
    ]);
  } catch (err) {
    if (err instanceof AssetSkip) throw err;
    throw new AssetSkip("DNS lookup failed");
  } finally {
    if (timer) clearTimeout(timer);
    cancel?.clear();
  }
  if (!addresses.length) throw new AssetSkip("DNS lookup returned no address");
  // Fail closed like the capture gate: one private answer blocks the hop.
  if (!trusted && addresses.some((address) => isPrivateAddress(address))) {
    throw new AssetSkip("the host resolves to a loopback, private, metadata or reserved address");
  }
  return addresses[0]!;
}

async function readBody(hop: SceneAssetHop, ctx: FetchContext): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = Math.max(0, Math.min(ctx.now() + ctx.limits.bodyDeadlineMs, ctx.deadlineAt) - ctx.now());
  const bodyDeadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        hop.destroy();
      } catch {
        /* already closed */
      }
      reject(
        new AssetSkip(
          `the body did not finish within ${Math.round(ctx.limits.bodyDeadlineMs / 1000)}s`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
  });
  const read = (async (): Promise<Buffer> => {
    try {
      for await (const chunk of hop.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += buf.length;
        // Count before the cap check: discarded bytes still consumed budget.
        ctx.budget.receivedBytes += buf.length;
        if (size > ctx.maxBytes) {
          try {
            hop.destroy();
          } catch {
            /* already closed */
          }
          throw new AssetSkip(ctx.overflowReason, ctx.overflowStops);
        }
        chunks.push(buf);
      }
      return Buffer.concat(chunks, size);
    } catch (err) {
      if (err instanceof AssetSkip) throw err;
      // A reset or refused stream is this asset's problem, not the run's.
      throw new AssetSkip("the transfer failed before completion");
    }
  })();
  // A deadline or client win abandons the body: never let its later rejection
  // surface, and close the socket the abandoned read still holds.
  read.catch(() => undefined);
  const cancel = cancelWatch(ctx, () => hop.destroy());
  try {
    return await Promise.race([read, bodyDeadline, ...(cancel ? [cancel.promise] : [])]);
  } finally {
    if (timer) clearTimeout(timer);
    cancel?.clear();
  }
}

interface FetchedAsset {
  bytes: Buffer;
  mime: string;
  extension: string;
}

async function fetchAsset(
  rawUrl: string,
  allowUnknown: boolean,
  ctx: FetchContext,
): Promise<FetchedAsset> {
  let current = new URL(rawUrl);
  for (let redirects = 0; ; redirects++) {
    if (redirects > ctx.limits.maxRedirects) {
      throw new AssetSkip(`more than ${ctx.limits.maxRedirects} redirects`);
    }
    if (ctx.signal?.aborted) throw new AssetSkip(CLIENT_CANCELLED, true);
    if (ctx.now() >= ctx.deadlineAt) {
      throw new AssetSkip(ctx.deadlineReason, true);
    }
    const address = await resolveHop(current, ctx);
    await acquireRequestSlot(ctx.now, ctx.limits, ctx.signal);
    if (ctx.now() >= ctx.deadlineAt) {
      throw new AssetSkip(ctx.deadlineReason, true);
    }
    const controller = new AbortController();
    let rejectDeadline: (err: Error) => void = () => undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const abortTimer = setTimeout(() => {
      controller.abort();
      rejectDeadline(new AssetSkip(ctx.deadlineReason, true));
    }, Math.max(0, ctx.deadlineAt - ctx.now()));
    abortTimer.unref?.();
    const cancel = cancelWatch(ctx);
    // The client signal is combined with the deadline so a fetcher that honors
    // its signal stops dialing or reading even before the race rejects.
    const fetchSignal = ctx.signal
      ? AbortSignal.any([controller.signal, ctx.signal])
      : controller.signal;
    let hop: SceneAssetHop;
    try {
      // The race keeps the overall cap even when a fetcher ignores the signal.
      const pending = ctx.fetcher(current, address, fetchSignal);
      pending.catch(() => undefined);
      hop = await Promise.race([pending, deadline, ...(cancel ? [cancel.promise] : [])]);
    } catch (err) {
      if (ctx.signal?.aborted) throw new AssetSkip(CLIENT_CANCELLED, true);
      if (controller.signal.aborted) throw new AssetSkip(ctx.deadlineReason, true);
      if (err instanceof AssetSkip) throw err;
      throw new AssetSkip("the request failed before a response arrived");
    } finally {
      clearTimeout(abortTimer);
      cancel?.clear();
    }
    if (hop.status >= 300 && hop.status < 400) {
      const location = headerValue(hop.headers, "location");
      try {
        hop.destroy();
      } catch {
        /* already closed */
      }
      if (!location) throw new AssetSkip(`HTTP ${hop.status} without a location header`);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new AssetSkip("the redirect target is not a valid URL");
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new AssetSkip("the redirect target is not http(s)");
      }
      // A redirect may not reintroduce what the initial URL may not carry.
      const safeNext = safeSceneDownloadUrl(next.href);
      if (!safeNext) {
        throw new AssetSkip("the redirect target has a query string, fragment or credentials");
      }
      current = new URL(safeNext);
      continue;
    }
    if (hop.status < 200 || hop.status >= 300) {
      try {
        hop.destroy();
      } catch {
        /* already closed */
      }
      throw new AssetSkip(`HTTP ${hop.status}`);
    }
    const declared = Number(headerValue(hop.headers, "content-length"));
    if (Number.isFinite(declared) && declared > ctx.maxBytes) {
      try {
        hop.destroy();
      } catch {
        /* already closed */
      }
      throw new AssetSkip(ctx.overflowReason, ctx.overflowStops);
    }
    const mime = String(headerValue(hop.headers, "content-type") ?? "")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase()
      .slice(0, ctx.limits.maxMimeChars);
    const bytes = await readBody(hop, ctx);
    const extension = sceneAssetExtension(bytes, mime, current, allowUnknown);
    if (!extension) {
      throw new AssetSkip(
        `${mime || "no content-type"} is not a recognised asset type; pass allowUnknown:true to save it as .bin`,
      );
    }
    return { bytes, mime, extension };
  }
}

interface AssetsProvenance {
  id: "scene-assets-provenance-v1";
  captureId: string;
  updatedAt: number;
  rights: Array<SceneRights & { recordedAt: number }>;
  files: SceneAssetFile[];
}

async function readProvenance(
  path: string,
  captureId: string,
  limits: typeof SCENE_ASSET_LIMITS,
): Promise<AssetsProvenance | null> {
  let entry;
  try {
    entry = await lstat(path);
  } catch {
    return null;
  }
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > limits.maxProvenanceBytes) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as AssetsProvenance;
    if (parsed?.id !== "scene-assets-provenance-v1" || parsed.captureId !== captureId) return null;
    if (!Array.isArray(parsed.rights) || !Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

const assetOrdinal = (assetId: string): number => Number(assetId.slice("asset-".length));

async function runDownload(
  opts: SceneAssetDownloadOptions,
): Promise<SceneAssetsResult | { error: string }> {
  const limits = { ...SCENE_ASSET_LIMITS, ...(opts.limits ?? {}) };
  try {
    const rights = normalizeRights(opts.rights);
    if ("error" in rights) return rights;
    const ids = normalizeAssetIds(opts.assetIds);
    if ("error" in ids) return ids;
    const now = opts.now ?? Date.now;
    const startedAt = now();
    const rightsRecord = { ...rights.rights, recordedAt: startedAt };
    // An already-aborted client gets the same shape as a cancelled run, with
    // no directory read, DNS lookup or request.
    if (opts.signal?.aborted) {
      return {
        id: "scene-assets-v1",
        captureId: opts.captureId,
        downloaded: 0,
        skipped: ids.ids.length,
        receivedBytes: 0,
        totalBytes: 0,
        rights: rightsRecord,
        files: [],
        limitations: [
          `Cancelled by the client before any request: 0 of ${ids.ids.length} requested asset(s) were downloaded.`,
          ...ids.ids.map((assetId) => `${assetId} skipped: ${CLIENT_CANCELLED}`),
        ],
        cancelled: true,
      };
    }
    const capture = await resolveSceneCaptureDir(opts.sceneDir, opts.captureId);
    if ("error" in capture) return capture;
    const inventory = await readInventory(capture.dir, opts.captureId, limits);
    if ("error" in inventory) return inventory;

    const unknown = ids.ids.filter((id) => !inventory.assets.has(id));
    if (unknown.length) {
      return {
        error: `assetIds not in this capture's inventory: ${unknown.slice(0, 8).join(", ")}${
          unknown.length > 8 ? ", ..." : ""
        }`,
      };
    }

    const allowedOrigins = normalizeScenePrivateOrigins(opts.allowPrivateOrigins);
    if ("error" in allowedOrigins) return allowedOrigins;

    const overallDeadline = startedAt + limits.overallDeadlineMs;
    const assetsDir = await ensureAssetsDir(capture.dir);

    const skipped: Array<{ assetId: string; reason: string }> = [];
    const jobs: InventoryAsset[] = [];
    for (const id of ids.ids) {
      const asset = inventory.assets.get(id)!;
      if (!asset.downloadUrl) {
        skipped.push({ assetId: id, reason: asset.skipReason ?? "not downloadable" });
        continue;
      }
      jobs.push(asset);
    }

    const files: SceneAssetFile[] = [];
    let totalBytes = 0;
    const received = { receivedBytes: 0 };
    let stopReason: string | null = null;
    let cancelled = false;
    const totalCapReason = `the ${mib(limits.maxTotalBytes)} MiB total cap was reached`;

    for (const asset of jobs) {
      if (opts.signal?.aborted) {
        cancelled = true;
        stopReason = CLIENT_CANCELLED;
        skipped.push({ assetId: asset.assetId, reason: stopReason });
        continue;
      }
      if (stopReason) {
        skipped.push({ assetId: asset.assetId, reason: stopReason });
        continue;
      }
      if (now() >= overallDeadline) {
        stopReason = `the ${Math.round(limits.overallDeadlineMs / 1000)}s overall deadline was reached`;
        skipped.push({ assetId: asset.assetId, reason: stopReason });
        continue;
      }
      // Discarded bodies and failed transfers consume the run budget too.
      const remainingTotal = limits.maxTotalBytes - received.receivedBytes;
      if (remainingTotal <= 0) {
        stopReason = totalCapReason;
        skipped.push({ assetId: asset.assetId, reason: stopReason });
        continue;
      }
      const maxBytes = Math.min(limits.maxFileBytes, remainingTotal);
      const perFile = limits.maxFileBytes < remainingTotal;
      const overflowReason = perFile
        ? `the ${mib(limits.maxFileBytes)} MiB per-file cap was exceeded`
        : totalCapReason;
      const deadlineReason = `the ${Math.round(limits.overallDeadlineMs / 1000)}s overall deadline was reached`;
      try {
        const fetched = await fetchAsset(asset.downloadUrl!, opts.allowUnknown === true, {
          fetcher: opts.fetch ?? defaultFetcher,
          resolveHost: opts.resolveHost ?? defaultResolveHost,
          trustedOrigins: new Set(allowedOrigins.origins),
          maxBytes,
          budget: received,
          overflowReason,
          overflowStops: !perFile,
          deadlineAt: overallDeadline,
          deadlineReason,
          now,
          limits,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        const path = join(assetsDir, `${asset.assetId}.${fetched.extension}`);
        const sha256 = createHash("sha256").update(fetched.bytes).digest("hex");
        const previous = await readFile(path).catch(() => null);
        await publishFile(path, fetched.bytes);
        if (opts.signal?.aborted) {
          // Restore an asset from a previous run rather than deleting it: its
          // provenance entry is still valid after this cancelled retry.
          if (previous) await publishFile(path, previous);
          else await rm(path, { force: true }).catch(() => undefined);
          throw new AssetSkip(CLIENT_CANCELLED, true);
        }
        totalBytes += fetched.bytes.length;
        files.push({
          assetId: asset.assetId,
          path,
          sha256,
          bytes: fetched.bytes.length,
          mime: fetched.mime || asset.mime,
        });
      } catch (err) {
        if (err instanceof AssetSkip) {
          skipped.push({ assetId: asset.assetId, reason: err.message });
          if (err.stop) stopReason = err.message;
          if (opts.signal?.aborted) cancelled = true;
          continue;
        }
        throw err;
      }
    }

    const prior = await readProvenance(join(capture.dir, "provenance.json"), opts.captureId, limits);
    const mergedFiles = new Map<string, SceneAssetFile>();
    for (const file of prior?.files ?? []) mergedFiles.set(file.assetId, file);
    for (const file of files) mergedFiles.set(file.assetId, file);
    const provenance: AssetsProvenance = {
      id: "scene-assets-provenance-v1",
      captureId: opts.captureId,
      updatedAt: now(),
      rights: [...(prior?.rights ?? []), rightsRecord].slice(-20),
      files: [...mergedFiles.values()].sort((a, b) => assetOrdinal(a.assetId) - assetOrdinal(b.assetId)),
    };
    await publishFile(
      join(capture.dir, "provenance.json"),
      Buffer.from(JSON.stringify(provenance, null, 1), "utf8"),
    );

    if (opts.signal?.aborted) cancelled = true;
    const limitations = [
      "Only assets recorded in this capture's own evidence inventory are downloaded: the tool never crawls the site, guesses model or source-map URLs, or supplies credentials.",
      `Rights are the caller's assertion (${rights.rights.basis}); they were recorded in provenance.json with a timestamp, not verified by the server.`,
      `Requests are serialized (one at a time, one per ${Math.round(limits.minRequestIntervalMs / 1000)}s) with manual redirects capped at ${limits.maxRedirects}; each file is capped at ${mib(limits.maxFileBytes)} MiB, the run at ${mib(limits.maxTotalBytes)} MiB counted across every body byte received (saved, skipped or failed), the body deadline at ${Math.round(limits.bodyDeadlineMs / 1000)}s and the run at ${Math.round(limits.overallDeadlineMs / 1000)}s.`,
      "URLs observed with a query string, fragment or credentials are never downloaded.",
    ];
    for (const skip of skipped.slice(0, 10)) limitations.push(`${skip.assetId} skipped: ${skip.reason}`);
    if (skipped.length > 10) {
      limitations.push(`${skipped.length - 10} more asset(s) were skipped for the stated caps or reasons.`);
    }
    if (cancelled) {
      limitations.push(
        `Cancelled by the client: the run stopped before the remaining requests; ${received.receivedBytes} received byte(s) remain counted.`,
      );
    }

    return {
      id: "scene-assets-v1",
      captureId: opts.captureId,
      downloaded: files.length,
      skipped: skipped.length,
      receivedBytes: received.receivedBytes,
      totalBytes,
      rights: rightsRecord,
      files,
      limitations,
      ...(cancelled ? { cancelled: true as const } : {}),
    };
  } catch (err) {
    return { error: `Asset download failed: ${redactSceneError(messageOf(err))}` };
  }
}

/**
 * Downloads selected inventory assets for one capture. Calls are serialized
 * process-wide so the shared 1 req/s limit cannot be exceeded by concurrency.
 */
export function downloadSceneAssets(
  opts: SceneAssetDownloadOptions,
): Promise<SceneAssetsResult | { error: string }> {
  // An already-cancelled call must not wait behind the process-wide queue.
  if (opts.signal?.aborted) return runDownload(opts);
  let started = false;
  const run = (): Promise<SceneAssetsResult | { error: string }> => {
    started = true;
    return runDownload(opts);
  };
  const result = downloadQueue.then(run, run);
  downloadQueue = result.then(
    () => undefined,
    () => undefined,
  );
  if (!opts.signal) return result;

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<SceneAssetsResult | { error: string }>((resolve) => {
    onAbort = () => {
      // Only a still-queued call resolves immediately. Once runDownload owns
      // the slot, its own cancellation path preserves received-byte accounting.
      if (!started) resolve(runDownload(opts));
    };
    opts.signal!.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([result, aborted]).finally(() => {
    if (onAbort) opts.signal!.removeEventListener("abort", onAbort);
  });
}
