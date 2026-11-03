// Passive 3D scene evidence. This phase records checkpoint frames, canvas
// geometry and the page's own network responses; by default it deliberately
// does NOT read a scene graph, camera, controls, shader source or geometry, and
// downloads no asset bodies. The opt-in `adapters` branch adds bounded,
// experimental summaries: "three" reads objects reachable from a few window
// properties (never a heap crawl); "spector" installs the optional spectorjs
// bundle as an init script before load and captures one WebGL frame with
// command counts, context attributes, analyses and capped shader source. See
// limitations in every pack.
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { CAPTURE_INSTALL_HINT } from "./capture.js";
import { coverageFrom, type EvidenceCoverage } from "./coverage.js";
import { installSnippetShims } from "./structure.js";
import { resolveViewport, type ViewportName } from "./viewport.js";

export const SCENE_LIMITS = {
  timeoutMs: 60_000,
  maxCheckpoints: 10,
  defaultCheckpoints: 6,
  defaultWaitMs: 400,
  maxWaitMs: 2_000,
  maxResources: 200,
  maxMetadataBytes: 2 * 1024 * 1024,
  maxImageBytes: 8 * 1024 * 1024,
  maxTotalImageBytes: 32 * 1024 * 1024,
  maxAssetOrigins: 8,
  // Page-derived string caps: applied the moment a value crosses the probe
  // boundary, before it can reach evidence or the metadata budget.
  maxVersionChars: 200,
  maxScriptChars: 2_048,
  maxResourceUrlChars: 2_048,
  maxMimeChars: 128,
  maxResourceTypeChars: 64,
  maxAllowedPrivateOrigins: 4,
  maxBlockedSampleChars: 2_048,
  maxBlockedSamples: 5,
  // Opt-in three adapter: every cap is passed into the in-page probe and
  // re-applied on the returned values.
  threeProbeTimeoutMs: 3_000,
  maxThreeNodes: 500,
  maxThreeDepth: 20,
  maxThreeCameras: 8,
  maxThreeLights: 8,
  maxThreeMaterials: 32,
  maxThreeTextures: 200,
  maxThreeNameChars: 128,
  maxThreeUuidChars: 64,
  maxThreeTypeChars: 64,
  maxThreeUrlChars: 2_048,
  maxThreeAttributes: 8,
  // Opt-in spector adapter: the bundle is read lazily from the optional
  // spectorjs package and installed as an init script before load; the in-page
  // probe serializes a compact summary only, never command arguments, state,
  // results, stack traces, memory or the raw capture.
  spectorProbeTimeoutMs: 8_000,
  maxSpectorPrograms: 8,
  maxSpectorShaders: 16,
  maxSpectorShaderChars: 64 * 1024,
  maxSpectorTotalShaderChars: 256 * 1024,
  maxSpectorCommandNames: 30,
  maxSpectorAnalyses: 8,
  maxSpectorAnalysisKeys: 8,
  maxSpectorNameChars: 64,
  maxSpectorInfoLogChars: 512,
  maxSpectorReasonChars: 500,
  maxSpectorAttributes: 16,
} as const;

const CLOSE_GRACE_MS = 3_000;

export type SceneResourceClass =
  | "texture"
  | "model"
  | "hdr"
  | "shader"
  | "script"
  | "font"
  | "image"
  | "other";

export type SceneCapabilityName = "scene" | "camera" | "controls" | "shaders" | "geometry";

export interface SceneCheckpointInput {
  scrollRatio: number;
  /** Normalized viewport coordinates (0..1); moved before the settle wait. */
  pointer?: { x: number; y: number };
  waitMs?: number;
}

export interface SceneCheckpoint {
  scrollRatio: number;
  pointer: { x: number; y: number } | null;
  waitMs: number;
}

export interface SceneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SceneCheckpointResult {
  index: number;
  requestedScrollRatio: number;
  requestedScrollTop: number;
  actualScrollTop: number;
  scrollRange: number;
  scrollRoot: string;
  /** Capture-time proof that a custom scroll root was present; replayed by verify. */
  scrollRootFound?: boolean;
  pointer: { x: number; y: number } | null;
  pointerPx: { x: number; y: number } | null;
  waitMs: number;
  elapsedMs: number;
  canvas: { rect: SceneRect; backing: { width: number; height: number }; dpr: number };
  /** False when a post-screenshot re-probe saw the page move or change. */
  stable: boolean;
  /** Why the frame is unstable; present only when stable is false. */
  stabilityReason?: string;
  files: { canvas: string; viewport?: string };
}

/**
 * Persisted beside the redacted evidence URL: the fetchable origin+pathname
 * for a later download, or the reason this observation can never be fetched.
 * Only URLs with no query, fragment or credentials are ever stored here.
 */
export type SceneResourceDownload =
  | { status: "available"; url: string }
  | { status: "skipped"; reason: string };

export interface SceneResource {
  /** Inventory handle (`asset-<n>`) used by the download_assets request. */
  assetId: string;
  url: string;
  origin: string;
  mime: string;
  bytes: number | null;
  resourceType: string;
  classification: SceneResourceClass;
  discovery: "response";
  assetOrigin: boolean;
  download: SceneResourceDownload;
}

export interface SceneFrameworkHint {
  detected: boolean;
  version: string | null;
  scripts: string[];
}

export interface SceneFrameworkHints {
  three: SceneFrameworkHint;
  babylon: SceneFrameworkHint;
  playcanvas: SceneFrameworkHint;
  canvasCount: number;
}

export type SceneAdapterName = "three" | "spector";

/** What the opt-in adapter actually returned; false fields were not observed. */
export interface SceneAdapterCoverage {
  scene: boolean;
  geometry: boolean;
  camera: boolean;
  controls: boolean;
  lights: boolean;
  materials: boolean;
}

export interface SceneThreeMaterial {
  type: string;
  color: string | null;
  opacity: number | null;
  transparent: boolean;
  metalness: number | null;
  roughness: number | null;
  side: number | null;
  /** Redacted texture URL plus its inventory row when one matched. */
  map: { url: string; assetId: string | null } | null;
}

export interface SceneThreeGeometry {
  type: string;
  attributes: Array<{ name: string; count: number }>;
  indexCount: number | null;
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  /** Numeric constructor parameters (width/height/depth/radius...), fixed allowlist. */
  parameters: Record<string, number> | null;
}

export interface SceneThreeNode {
  type: "mesh" | "light" | "camera" | "scene" | "group" | "object";
  name: string | null;
  uuid: string | null;
  visible: boolean;
  position: [number, number, number] | null;
  quaternion: [number, number, number, number] | null;
  scale: [number, number, number] | null;
  childCount: number;
  geometry: SceneThreeGeometry | null;
  material: SceneThreeMaterial | SceneThreeMaterial[] | null;
  camera: SceneThreeCamera | null;
  light: SceneThreeLight | null;
}

export interface SceneThreeCamera {
  type: string;
  fov: number | null;
  near: number | null;
  far: number | null;
  matrixWorld: number[] | null;
}

export interface SceneThreeLight {
  type: string;
  color: string | null;
  intensity: number | null;
  distance: number | null;
}

export interface SceneThreeControls {
  type: string;
  target: [number, number, number];
}

export interface SceneThreeEvidence {
  id: "three-adapter-v1";
  available: boolean;
  reason: string;
  revision: string | null;
  scene: { nodes: SceneThreeNode[]; truncated: boolean; total: number } | null;
  camera: SceneThreeCamera | null;
  cameras: SceneThreeCamera[];
  lights: SceneThreeLight[];
  controls: SceneThreeControls | null;
  coverage: SceneAdapterCoverage;
}

/**
 * One shader source from a captured WebGL program. `source` is untrusted page
 * text: it is capped, stored as data and never executed. `length` is the
 * original length before truncation.
 */
export interface SceneSpectorShader {
  type: string;
  source: string;
  length: number;
  truncated: boolean;
}

export interface SceneSpectorProgramStatus {
  LINK_STATUS: boolean | null;
  VALIDATE_STATUS: boolean | null;
  infoLog: string | null;
}

export interface SceneSpectorProgram {
  programStatus: SceneSpectorProgramStatus;
  shaders: SceneSpectorShader[];
}

export interface SceneSpectorStatuses {
  unknown: number;
  unused: number;
  disabled: number;
  redundant: number;
  valid: number;
  deprecated: number;
}

export interface SceneSpectorLimits {
  maxPrograms: number;
  maxShaders: number;
  maxShaderChars: number;
  maxTotalShaderChars: number;
  maxCommandNames: number;
  programsTruncated: boolean;
  shadersTruncated: boolean;
}

/** Compact result of one spectorjs frame capture; never the raw capture. */
export interface SceneSpectorEvidence {
  id: "spector-adapter-v1";
  available: boolean;
  reason: string;
  /** spectorjs package version, when the optional package was resolvable. */
  version: string | null;
  canvas: { width: number; height: number } | null;
  context: { version: number; attributes: Record<string, boolean | number | string | null> } | null;
  commands: {
    total: number;
    drawCalls: number;
    byName: Array<{ name: string; count: number }>;
    statuses: SceneSpectorStatuses;
  };
  programs: SceneSpectorProgram[];
  analyses: Array<{ name: string; values: Record<string, boolean | number | string> }>;
  limits: SceneSpectorLimits;
}

export interface SceneCapabilityCoverage {
  status: "available" | "unavailable" | "unknown";
  reason: string;
}

export interface SceneCoverage extends EvidenceCoverage {
  capabilities: Record<SceneCapabilityName, SceneCapabilityCoverage>;
}

export interface SceneEvidence {
  id: "scene-evidence-v1";
  url: string;
  captureId: string;
  capturedAt: number;
  viewport: { name: ViewportName; width: number; height: number };
  canvas: { requestedSelector: string | null; usedSelector: string; canvases: number };
  frameworkHints: SceneFrameworkHints;
  checkpoints: SceneCheckpointResult[];
  resources: SceneResource[];
  resourceTotal: number;
  resourcesTruncated: boolean;
  /** Present only when adapters:["three"] was requested. */
  three?: SceneThreeEvidence;
  /** Present only when adapters:["spector"] was requested. */
  spector?: SceneSpectorEvidence;
  blockedRequests: { count: number; samples: string[] };
  assetOrigins: string[];
  paths: { dir: string; evidence: string; framesDir: string };
  coverage: SceneCoverage;
  limitations: string[];
}

export interface SceneCaptureOptions {
  canvasSelector?: string;
  scrollRoot?: string;
  viewport?: ViewportName;
  checkpoints?: SceneCheckpointInput[];
  assetOrigins?: string[];
  includeViewportShots?: boolean;
  /**
   * Experimental, opt-in adapters. "three" reads objects reachable from
   * window.THREE, window.scene/camera/renderer and
   * window.app/experience/viewer/world after load, then serializes a bounded
   * summary. It does not crawl the heap or install hooks. "spector" installs
   * the optional spectorjs bundle as an init script before load and captures
   * one WebGL frame from the selected canvas.
   */
  adapters?: SceneAdapterName[];
  /** TEST ONLY: replaces the lazy spectorjs bundle lookup (null = not installed). */
  spectorBundleLoader?: () => Promise<SpectorBundle | null>;
  timeoutMs?: number;
  /** Output root; the handler passes <cache>/scene-captures. */
  sceneDir?: string;
  loader?: () => Promise<any>;
  /** Injectable DNS so unit tests never touch the network. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /**
   * TEST ONLY, never exposed by an MCP tool schema. Exact http(s) origins that
   * count as trusted even when they resolve to loopback/private addresses, so
   * browser regressions can serve fixtures locally. Every other origin still
   * goes through the full private-address gate.
   */
  allowPrivateOrigins?: string[];
}

export type CaptureSceneFn = (
  url: string,
  opts?: SceneCaptureOptions,
) => Promise<SceneEvidence | { error: string }>;

// ---- SSRF gate -----------------------------------------------------------
// The primary boundary is a loopback HTTP proxy: Chromium is launched with it
// before any page exists, so every connection (initial navigation, redirect
// hop, subresource, popup) is validated before it is dialed, and the proxy
// dials the address DNS returned here instead of re-resolving. Playwright
// request routing did not see redirect hops in the tested Chromium build, so
// it is kept only as defense in depth, not as the claim. DNS rebinding between
// the lookup and the proxy dial is covered because the proxy connects to the
// validated IP; Chromium's own non-proxied traffic is not page-controlled.

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function parseIpv4(address: string): number[] | null {
  if (!IPV4_RE.test(address)) return null;
  const parts = address.split(".").map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

function isPrivateIpv4(parts: number[]): boolean {
  const [a, b, c] = parts;
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol / TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast + reserved
  );
}

function parseIpv6(address: string): number[] | null {
  let value = address.toLowerCase().split("%")[0]!;
  const tailStart = value.lastIndexOf(":");
  const tail = value.slice(tailStart + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    value =
      value.slice(0, tailStart + 1) +
      (((v4[0]! << 8) | v4[1]!).toString(16)) +
      ":" +
      (((v4[2]! << 8) | v4[3]!).toString(16));
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0]!.split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1]!.split(":") : []) : null;
  let groups: string[];
  if (rest === null) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...rest];
  }
  const parsed = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? parsed : null;
}

function embeddedIpv4(groups: number[]): number[] {
  return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff];
}

/** True for loopback, link-local, RFC1918, CGNAT, metadata and reserved addresses. */
export function isPrivateAddress(address: string): boolean {
  const raw = address.trim().replace(/^\[|\]$/g, "").split("%")[0]!;
  const v4 = parseIpv4(raw);
  if (v4) return isPrivateIpv4(v4);
  const groups = parseIpv6(raw);
  // Fail closed: a value dns.lookup returned but this parser cannot read is
  // not provably public.
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5] = groups;
  if (groups.every((g) => g === 0)) return true; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && groups[6] === 0 && groups[7] === 1) {
    return true; // ::1
  }
  if ((g0! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateIpv4(embeddedIpv4(groups)); // ::ffff:a.b.c.d
  }
  if (g0 === 0x0064 && g1 === 0xff9b) return isPrivateIpv4(embeddedIpv4(groups)); // NAT64
  if (g0 === 0x2002) {
    return isPrivateIpv4([g1! >> 8, g1! & 0xff, g2! >> 8, g2! & 0xff]); // 6to4
  }
  return false;
}

export const defaultSceneResolveHost = async (hostname: string): Promise<string[]> =>
  (await lookup(hostname, { all: true, verbatim: true })).map((row) => row.address);

/** Origin+pathname only: query, hash and credentials never reach evidence. */
export function redactSceneUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return String(raw).split(/[?#]/, 1)[0] ?? "";
  }
}

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeScenePrivateOrigins(
  input?: string[],
): { origins: string[] } | { error: string } {
  if (input === undefined) return { origins: [] };
  if (!Array.isArray(input) || input.length > SCENE_LIMITS.maxAllowedPrivateOrigins) {
    return {
      error: `allowPrivateOrigins accepts at most ${SCENE_LIMITS.maxAllowedPrivateOrigins} origins.`,
    };
  }
  const origins: string[] = [];
  for (const raw of input) {
    if (!isHttpUrl(raw)) {
      return { error: `allowPrivateOrigins entry ${JSON.stringify(raw)} is not an absolute http(s) URL.` };
    }
    const origin = new URL(raw).origin;
    if (!origins.includes(origin)) origins.push(origin);
  }
  return { origins };
}

export interface SceneUrlGate {
  allows(raw: string): Promise<boolean>;
  /** Validated address for the proxy to dial, or null when blocked. */
  connectAddress(hostname: string, port: number, origins: readonly string[]): Promise<string | null>;
  blocked: { count: number; samples: string[] };
}

// One hostname resolution per run. The gate fails closed on parse/DNS errors;
// exact test-only origins may still be private, everything else must resolve
// exclusively to public addresses.
export function createSceneUrlGate(
  resolveHost: (hostname: string) => Promise<string[]>,
  allowPrivateOrigins: readonly string[] = [],
): SceneUrlGate {
  const allowedOrigins = new Set(allowPrivateOrigins);
  const resolved = new Map<string, Promise<string[]>>();
  const blocked: { count: number; samples: string[] } = { count: 0, samples: [] };

  const recordBlocked = (raw: string): void => {
    blocked.count += 1;
    if (blocked.samples.length < SCENE_LIMITS.maxBlockedSamples) {
      // Cap at record time: a page-controlled path can be hundreds of KB.
      blocked.samples.push(redactSceneUrl(raw).slice(0, SCENE_LIMITS.maxBlockedSampleChars));
    }
  };

  const hostAddress = async (hostname: string, origins: readonly string[]): Promise<string | null> => {
    const host = hostname.trim().replace(/^\[|\]$/g, "").toLowerCase();
    if (!host) return null;
    const trusted = origins.some((origin) => allowedOrigins.has(origin));
    if (!trusted && (host === "localhost" || host.endsWith(".localhost"))) return null;
    let pending = resolved.get(host);
    if (!pending) {
      pending = resolveHost(host).catch(() => []);
      resolved.set(host, pending);
    }
    const addresses = await pending;
    if (addresses.length === 0) return null;
    if (!trusted && addresses.some((address) => isPrivateAddress(address))) return null;
    return addresses[0]!;
  };

  return {
    blocked,
    async allows(raw: string): Promise<boolean> {
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        recordBlocked(raw);
        return false;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        recordBlocked(raw);
        return false;
      }
      const address = await hostAddress(parsed.hostname, [parsed.origin]);
      if (!address) recordBlocked(raw);
      return address !== null;
    },
    async connectAddress(
      hostname: string,
      port: number,
      origins: readonly string[],
    ): Promise<string | null> {
      const address = await hostAddress(hostname, origins);
      if (!address) {
        recordBlocked(origins[0] ?? `http://${hostname}:${port}/`);
      }
      return address;
    },
  };
}

// ---- connection-level proxy ---------------------------------------------

export interface SceneProxy {
  url: string;
  close(): Promise<void>;
}

export interface SceneConnectTarget {
  hostname: string;
  port: number;
}

export type SceneDial = (
  options: { host: string; port: number },
  onConnect: () => void,
) => any;

// URL parsing would drop an explicit :80 on an http:// authority, so CONNECT
// authorities are read directly; 443 is only the fallback when no port is given.
const CONNECT_AUTHORITY_RE = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+)(?::(\d{1,5}))?$/;

export function parseConnectAuthority(authority: string): SceneConnectTarget | null {
  const match = CONNECT_AUTHORITY_RE.exec(authority.trim());
  if (!match) return null;
  const port = match[2] === undefined ? 443 : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { hostname: match[1]!.replace(/^\[|\]$/g, "").toLowerCase(), port };
}

/**
 * CONNECT always carries a TLS tunnel, so its exemption is an https origin and
 * URL.origin normalizes the default port exactly like normalizeScenePrivateOrigins.
 */
export function sceneConnectOrigin(target: SceneConnectTarget): string {
  const host = target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname;
  return new URL(`https://${host}:${target.port}`).origin;
}

interface SceneProxyRegistry {
  sockets: Set<any>;
  closed: boolean;
}

export function startSceneProxy(
  gate: SceneUrlGate,
  dial: SceneDial = (options, onConnect) => netConnect(options, onConnect),
): Promise<SceneProxy> {
  const registry: SceneProxyRegistry = { sockets: new Set(), closed: false };
  const server = createHttpServer((req, res) => {
    void forwardProxyRequest(gate, req, res, registry).catch(() => {
      try {
        res.destroy();
      } catch {
        /* client already gone */
      }
    });
  });
  server.on("connect", (req, socket, head) => {
    // Track the client side immediately: close may race the gate lookup.
    registry.sockets.add(socket);
    // Attach before any await: a client reset during the gate lookup must not
    // surface as an unhandled 'error' event and take down the host process.
    socket.on("error", () => {
      registry.sockets.delete(socket);
    });
    socket.once("close", () => registry.sockets.delete(socket));
    void forwardProxyTunnel(gate, req.url ?? "", socket as any, head, registry, dial).catch(() => {
      socket.destroy();
    });
  });
  server.on("clientError", (_err, socket) => {
    try {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch {
      /* socket already gone */
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      let closing: Promise<void> | null = null;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => (closing ??= closeSceneProxy(server, registry)),
      });
    });
  });
}

function closeSceneProxy(server: any, registry: SceneProxyRegistry): Promise<void> {
  registry.closed = true;
  // closeAllConnections() does not touch upgraded CONNECT tunnels, so client
  // sockets, tunnel upstreams and request sockets are destroyed explicitly
  // before the server stops accepting.
  for (const socket of registry.sockets) {
    try {
      socket.destroy();
    } catch {
      /* already destroyed */
    }
  }
  registry.sockets.clear();
  server.closeAllConnections?.();
  return new Promise<void>((done) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done();
    };
    // Bound shutdown even if a socket from outside this registry lingers.
    const timer = setTimeout(finish, CLOSE_GRACE_MS);
    timer.unref?.();
    server.close(finish);
  });
}

async function forwardProxyRequest(
  gate: SceneUrlGate,
  req: any,
  res: any,
  registry: SceneProxyRegistry,
): Promise<void> {
  let target: URL;
  try {
    target = new URL(String(req.url ?? ""));
  } catch {
    res.writeHead(400, { connection: "close" }).end();
    return;
  }
  if (target.protocol !== "http:") {
    res.writeHead(400, { connection: "close" }).end();
    return;
  }
  const port = Number(target.port) || 80;
  const address = await gate.connectAddress(target.hostname, port, [target.origin]);
  if (registry.closed) {
    res.destroy();
    return;
  }
  if (!address) {
    res.writeHead(403, { connection: "close" }).end("blocked");
    return;
  }
  const upstream = httpRequest(
    {
      host: address,
      port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: { ...req.headers, host: target.host },
      // No pooled keep-alive socket may outlive the proxy.
      agent: false,
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("socket", (socket) => {
    if (registry.closed) {
      socket.destroy();
      return;
    }
    registry.sockets.add(socket);
    socket.once("close", () => registry.sockets.delete(socket));
  });
  upstream.on("error", () => {
    try {
      res.writeHead(502, { connection: "close" }).end();
    } catch {
      /* client already gone */
    }
  });
  req.pipe(upstream);
}

async function forwardProxyTunnel(
  gate: SceneUrlGate,
  authority: string,
  socket: any,
  head: Buffer,
  registry: SceneProxyRegistry,
  dial: SceneDial,
): Promise<void> {
  const target = parseConnectAuthority(authority);
  let origin = "";
  try {
    if (target) origin = sceneConnectOrigin(target);
  } catch {
    /* malformed host that URL cannot normalize */
  }
  if (!target || !origin) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  let clientGone = false;
  const markGone = () => {
    clientGone = true;
  };
  socket.once("close", markGone);
  socket.on("error", markGone);
  const address = await gate.connectAddress(target.hostname, target.port, [origin]);
  // Proxy close or a client reset may have run while DNS was pending: never
  // dial after either.
  if (registry.closed || clientGone || socket.destroyed) {
    socket.destroy();
    return;
  }
  if (!address) {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const upstream = dial({ host: address, port: target.port }, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  // Tracked before the connect callback: the upstream counts as live while
  // still pending.
  registry.sockets.add(upstream);
  upstream.once("close", () => {
    registry.sockets.delete(upstream);
    socket.destroy();
  });
  socket.once("close", () => {
    registry.sockets.delete(socket);
    upstream.destroy();
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

// ---- shared guard -------------------------------------------------------
// verify_build owns one guard for a whole scene-enabled run: the same gate and
// proxy cover the legacy structure/scroll/hover/component/perf acquisitions
// and the scene gate, so no legacy path can reach the network unguarded.

export interface SceneNetworkGuard {
  gate: SceneUrlGate;
  proxy: SceneProxy;
  close(): Promise<void>;
}

export async function createSceneNetworkGuard(
  opts: {
    resolveHost?: (hostname: string) => Promise<string[]>;
    allowPrivateOrigins?: string[];
  } = {},
): Promise<SceneNetworkGuard | { error: string }> {
  const origins = normalizeScenePrivateOrigins(opts.allowPrivateOrigins);
  if ("error" in origins) return origins;
  const gate = createSceneUrlGate(opts.resolveHost ?? defaultSceneResolveHost, origins.origins);
  try {
    const proxy = await startSceneProxy(gate);
    return { gate, proxy, close: () => proxy.close() };
  } catch {
    return { error: "could not start the local network guard (loopback proxy)" };
  }
}

function pinnedSceneLookup(address: string): (hostname: string, options: any, callback?: any) => void {
  const family = address.includes(":") ? 6 : 4;
  return (_hostname: string, options: any, callback?: any) => {
    const done = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? {} : (options ?? {});
    if (opts.all) done(null, [{ address, family }]);
    else done(null, address, family);
  };
}

function firstHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

interface GuardedHop {
  status: number;
  location?: string;
  body?: string;
}

// One HTTP(S) request dialed at the gate-validated address (never a re-resolution),
// so the HTML read in verify_build cannot be rebound between check and connect.
function requestGuardedHop(
  url: URL,
  address: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<GuardedHop | { error: string }> {
  return new Promise((resolve) => {
    const secure = url.protocol === "https:";
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let settled = false;
    const finish = (value: GuardedHop | { error: string }): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = (secure ? httpsRequest : httpRequest)(
      {
        host,
        port: Number(url.port || (secure ? 443 : 80)),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "accept-encoding": "identity",
          "user-agent": "verify-build/1.0 (research tooling)",
        },
        lookup: pinnedSceneLookup(address),
        // No pooled socket may outlive this request.
        agent: false,
        ...(secure ? { servername: host } : {}),
      } as any,
      (response: any) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          const location = firstHeader(response.headers ?? {}, "location");
          response.resume();
          finish(location ? { status, location } : { status });
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          finish({ status });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy();
            finish({ error: `the HTML body exceeded ${Math.round(maxBytes / 1024)} KiB` });
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => finish({ status, body: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", () => finish({ error: "the response stream failed" }));
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      finish({ error: `the HTML request timed out after ${timeoutMs}ms` });
    });
    request.on("error", (err: Error) => finish({ error: err.message }));
    request.end();
  });
}

export const SCENE_GUARDED_HTML = {
  timeoutMs: 15_000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
} as const;

/**
 * Guarded raw-HTML GET for verify_build's anti-pattern evidence. Every hop,
 * including a redirect, passes the same URL gate and is dialed at the address
 * the gate validated. A blocked hop returns {error} and no request is made.
 */
export async function fetchSceneHtml(
  gate: SceneUrlGate,
  raw: string,
  opts?: { timeoutMs?: number; maxBytes?: number },
): Promise<string | { error: string }> {
  let current: URL;
  try {
    current = new URL(raw);
  } catch {
    return { error: `invalid URL ${redactSceneUrl(raw)}` };
  }
  const deadline =
    Date.now() + Math.max(1, Math.round(opts?.timeoutMs ?? SCENE_GUARDED_HTML.timeoutMs));
  const maxBytes = Math.max(1, Math.round(opts?.maxBytes ?? SCENE_GUARDED_HTML.maxBytes));
  for (let redirects = 0; redirects <= SCENE_GUARDED_HTML.maxRedirects; redirects++) {
    if (!isHttpUrl(current.href)) {
      return { error: `${redactSceneUrl(current.href)} is not an http(s) URL` };
    }
    let allowed = false;
    try {
      allowed = await gate.allows(current.href);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      return {
        error:
          `refusing to fetch ${redactSceneUrl(current.href)}: the host resolves to a loopback, ` +
          "link-local, private, metadata or reserved address, or the URL is not http(s)",
      };
    }
    const secure = current.protocol === "https:";
    const address = await gate.connectAddress(
      current.hostname,
      Number(current.port || (secure ? 443 : 80)),
      [current.origin],
    );
    if (!address) {
      return { error: `refusing to fetch ${redactSceneUrl(current.href)}: no validated address` };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { error: "the HTML fetch deadline expired" };
    const hop = await requestGuardedHop(current, address, remaining, maxBytes);
    if ("error" in hop) return hop;
    if (hop.status >= 300 && hop.status < 400) {
      if (!hop.location) return { error: `HTTP ${hop.status} without a location header` };
      try {
        current = new URL(hop.location, current);
      } catch {
        return { error: "the redirect target is not a valid URL" };
      }
      continue;
    }
    if (hop.body === undefined) {
      return { error: `HTTP ${hop.status} fetching ${redactSceneUrl(current.href)}` };
    }
    return hop.body;
  }
  return { error: `more than ${SCENE_GUARDED_HTML.maxRedirects} redirects` };
}

// ---- checkpoints and assets ---------------------------------------------

export function normalizeSceneCheckpoints(
  input?: SceneCheckpointInput[],
): { checkpoints: SceneCheckpoint[] } | { error: string } {
  const raw: SceneCheckpointInput[] =
    input ??
    Array.from({ length: SCENE_LIMITS.defaultCheckpoints }, (_, i) => ({
      scrollRatio: i / (SCENE_LIMITS.defaultCheckpoints - 1),
    }));
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "Scene capture needs at least one checkpoint." };
  }
  if (raw.length > SCENE_LIMITS.maxCheckpoints) {
    return {
      error: `Scene capture accepts at most ${SCENE_LIMITS.maxCheckpoints} checkpoints (received ${raw.length}).`,
    };
  }
  const checkpoints: SceneCheckpoint[] = [];
  for (let i = 0; i < raw.length; i++) {
    const cp = raw[i];
    const ratio = Number(cp?.scrollRatio);
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      return { error: `checkpoints[${i}].scrollRatio must be a finite number between 0 and 1.` };
    }
    let pointer: SceneCheckpoint["pointer"] = null;
    if (cp.pointer !== undefined) {
      const { x, y } = cp.pointer;
      if (!Number.isFinite(x) || x < 0 || x > 1 || !Number.isFinite(y) || y < 0 || y > 1) {
        return { error: `checkpoints[${i}].pointer x/y must be finite numbers between 0 and 1.` };
      }
      pointer = { x, y };
    }
    const rawWait = cp.waitMs;
    if (rawWait !== undefined && (!Number.isFinite(Number(rawWait)) || Number(rawWait) < 0)) {
      return { error: `checkpoints[${i}].waitMs must be a finite non-negative number.` };
    }
    const waitMs = Math.min(
      SCENE_LIMITS.maxWaitMs,
      Math.max(0, Math.round(rawWait === undefined ? SCENE_LIMITS.defaultWaitMs : Number(rawWait))),
    );
    checkpoints.push({ scrollRatio: ratio, pointer, waitMs });
  }
  return { checkpoints };
}

export function normalizeSceneAssetOrigins(
  input?: string[],
): { origins: string[] } | { error: string } {
  if (input === undefined) return { origins: [] };
  if (input.length > SCENE_LIMITS.maxAssetOrigins) {
    return { error: `assetOrigins accepts at most ${SCENE_LIMITS.maxAssetOrigins} origins.` };
  }
  const origins: string[] = [];
  for (const raw of input) {
    if (!isHttpUrl(raw)) {
      return { error: `assetOrigins entry ${JSON.stringify(raw)} is not an absolute http(s) URL.` };
    }
    const origin = new URL(raw).origin;
    if (!origins.includes(origin)) origins.push(origin);
  }
  return { origins };
}

export function classifySceneResource(mime: string, url: string): SceneResourceClass {
  const type = mime.toLowerCase().split(";", 1)[0]!.trim();
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = url.toLowerCase();
  }
  const ext = /\.([a-z0-9]+)$/.exec(path)?.[1] ?? "";

  if (type.includes("radiance") || ext === "hdr" || ext === "exr") return "hdr";
  if (type.startsWith("model/") || ["glb", "gltf", "fbx", "obj", "drc"].includes(ext)) {
    return "model";
  }
  if (type.includes("glsl") || ["glsl", "vert", "frag", "wgsl", "hlsl"].includes(ext)) return "shader";
  if (["ktx", "ktx2", "basis", "dds"].includes(ext) || path.includes("/texture") || path.includes("textures/")) {
    return "texture";
  }
  if (
    type.includes("javascript") ||
    type.includes("ecmascript") ||
    ["js", "mjs", "cjs"].includes(ext)
  ) {
    return "script";
  }
  if (type.startsWith("font/") || type.includes("font") || ["woff", "woff2", "ttf", "otf"].includes(ext)) {
    return "font";
  }
  if (type.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "avif", "gif", "svg"].includes(ext)) {
    return "image";
  }
  return "other";
}

export function normalizeSceneAdapters(
  input?: SceneAdapterName[],
): { adapters: SceneAdapterName[] } | { error: string } {
  if (input === undefined) return { adapters: [] };
  if (!Array.isArray(input) || input.length > 2) {
    return { error: 'adapters accepts at most two entries (supported: "three", "spector").' };
  }
  const adapters: SceneAdapterName[] = [];
  for (const name of input) {
    if (name !== "three" && name !== "spector") {
      return {
        error: `adapters entry ${JSON.stringify(name)} is not supported (supported: "three", "spector").`,
      };
    }
    if (adapters.includes(name)) {
      return { error: `adapters entry ${JSON.stringify(name)} is listed more than once.` };
    }
    adapters.push(name);
  }
  return { adapters };
}

function passiveCapabilityReasons(): Record<SceneCapabilityName, SceneCapabilityCoverage> {
  // Passive means "the page painted it", never "we read it". Keeping these
  // unavailable prevents downstream tools from treating frames as recovered
  // scene state.
  return {
    scene: {
      status: "unavailable",
      reason: "Passive capture only: the page's scene graph was never read.",
    },
    camera: {
      status: "unavailable",
      reason: "Passive capture only: no camera state was read; frames show its effect, not its values.",
    },
    controls: {
      status: "unavailable",
      reason: "Passive capture only: no controls or input handlers were inspected.",
    },
    shaders: {
      status: "unavailable",
      reason: "Passive capture only: no shader source was extracted from the page.",
    },
    geometry: {
      status: "unavailable",
      reason: "Passive capture only: no geometry or mesh data was extracted.",
    },
  };
}

/**
 * Capabilities follow the adapter result, never the request: a requested
 * adapter that returned nothing leaves the capability unknown, not available.
 * Scene/camera/controls/geometry come only from three; shader source comes only
 * from spector and is "available" only when at least one shader was captured.
 */
function sceneCapabilityReasons(
  three?: SceneThreeEvidence,
  spector?: SceneSpectorEvidence,
): Record<SceneCapabilityName, SceneCapabilityCoverage> {
  const base = three ? threeCapabilityReasons(three) : passiveCapabilityReasons();
  let shaders: SceneCapabilityCoverage;
  if (!spector) {
    shaders = passiveCapabilityReasons().shaders;
  } else {
    const shaderCount = spector.programs.reduce((sum, program) => sum + program.shaders.length, 0);
    shaders =
      spector.available && shaderCount > 0
        ? {
            status: "available",
            reason: `Read by the experimental spector adapter from one captured WebGL frame (${shaderCount} shader source${shaderCount === 1 ? "" : "s"}); command arguments, state and memory were not transferred.`,
          }
        : {
            status: "unknown",
            reason: `The spector adapter was requested but captured no shader source: ${spector.reason}`,
          };
  }
  return { ...base, shaders };
}

function threeCapabilityReasons(
  three: SceneThreeEvidence,
): Record<SceneCapabilityName, SceneCapabilityCoverage> {
  const yes = (what: string): SceneCapabilityCoverage => ({
    status: "available",
    reason: `Read by the experimental three adapter from reachable window.* objects (${what}); the heap was not crawled.`,
  });
  const no = (what: string): SceneCapabilityCoverage => ({
    status: "unknown",
    reason: `The three adapter was requested but returned no ${what}: ${three.reason}`,
  });
  return {
    scene: three.coverage.scene ? yes("scene graph") : no("scene graph"),
    camera: three.coverage.camera ? yes("camera") : no("camera"),
    controls: three.coverage.controls ? yes("controls") : no("controls"),
    geometry: three.coverage.geometry ? yes("geometry") : no("geometry"),
    shaders: passiveCapabilityReasons().shaders,
  };
}

// ---- in-page snippets ----------------------------------------------------
// Plain function expressions (page.evaluate re-serializes them), browser
// globals through globalThis because this Node tsconfig has no DOM lib, and
// every probe is try/caught. No getContext anywhere: hints stay passive.

export type SceneCanvasProblem =
  | ""
  | "invalid-selector"
  | "selector-not-found"
  | "selector-not-canvas"
  | "no-canvas"
  | "marker-not-unique";

export const SCENE_CANVAS_PICK = function (arg: { selector: string; marker: string }): {
  canvases: number;
  selector: string;
  rect: { x: number; y: number; width: number; height: number } | null;
  backing: { width: number; height: number } | null;
  dpr: number;
  problem: SceneCanvasProblem;
} {
  const g = globalThis as any;
  const doc = g.document;
  const attr = "data-awwwards-scene-canvas";
  let canvases = 0;
  try {
    canvases = doc.querySelectorAll("canvas").length;
  } catch {}
  let chosen: any = null;
  let problem: SceneCanvasProblem = "";
  if (arg && arg.selector) {
    try {
      const el = doc.querySelector(arg.selector);
      if (!el) problem = "selector-not-found";
      else if (String(el.tagName).toLowerCase() !== "canvas") problem = "selector-not-canvas";
      else chosen = el;
    } catch {
      problem = "invalid-selector";
    }
  } else {
    let bestArea = 0;
    try {
      // Playwright clips viewport screenshots, so an offscreen canvas cannot
      // contribute a frame even if it is larger. Rank only the visible part.
      const vw = Number(g.innerWidth) || 0;
      const vh = Number(g.innerHeight) || 0;
      const all = Array.from(doc.querySelectorAll("canvas")) as any[];
      for (const c of all) {
        try {
          const r = c.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          const s = g.getComputedStyle(c);
          if (String(s.display) === "none" || String(s.visibility) === "hidden") continue;
          const left = Math.max(0, r.x);
          const top = Math.max(0, r.y);
          const right = vw > 0 ? Math.min(vw, r.x + r.width) : r.x + r.width;
          const bottom = vh > 0 ? Math.min(vh, r.y + r.height) : r.y + r.height;
          if (right - left <= 0 || bottom - top <= 0) continue;
          const area = (right - left) * (bottom - top);
          if (area > bestArea) {
            bestArea = area;
            chosen = c;
          }
        } catch {}
      }
    } catch {}
    if (!chosen) problem = "no-canvas";
  }
  if (!chosen) {
    return { canvases, selector: "", rect: null, backing: null, dpr: 0, problem };
  }
  // Page content can pre-set or duplicate any attribute value, so the marker
  // value is generated outside the page and the marked element must stay the
  // only match. A selector that is not provably single is refused, never
  // resolved to whichever element the page happens to put first.
  const marker = String((arg && arg.marker) || "");
  let selector = "";
  try {
    chosen.setAttribute(attr, marker);
    selector = "canvas[" + attr + '="' + marker + '"]';
  } catch {}
  let matches = 0;
  try {
    matches = selector ? doc.querySelectorAll(selector).length : 0;
  } catch {}
  if (!marker || matches !== 1) {
    return {
      canvases,
      selector: "",
      rect: null,
      backing: null,
      dpr: 0,
      problem: "marker-not-unique",
    };
  }
  let rect: { x: number; y: number; width: number; height: number } | null = null;
  try {
    const r = chosen.getBoundingClientRect();
    rect = { x: r.x, y: r.y, width: r.width, height: r.height };
  } catch {}
  let backing: { width: number; height: number } | null = null;
  try {
    backing = { width: chosen.width || 0, height: chosen.height || 0 };
  } catch {}
  let dpr = 0;
  try {
    dpr = Number(g.devicePixelRatio) || 0;
  } catch {}
  return { canvases, selector, rect, backing, dpr, problem: "" };
};

export const SCENE_PROBE = function (arg: { canvasSelector: string; scrollRoot: string }): {
  canvasFound: boolean;
  rect: { x: number; y: number; width: number; height: number } | null;
  backing: { width: number; height: number } | null;
  dpr: number;
  scroll: { top: number; range: number } | null;
  scrollRootFound: boolean;
} {
  const g = globalThis as any;
  const doc = g.document;
  let canvasFound = false;
  let rect: { x: number; y: number; width: number; height: number } | null = null;
  let backing: { width: number; height: number } | null = null;
  try {
    const el = doc.querySelector(arg.canvasSelector);
    if (el) {
      canvasFound = true;
      const r = el.getBoundingClientRect();
      rect = { x: r.x, y: r.y, width: r.width, height: r.height };
      backing = { width: el.width || 0, height: el.height || 0 };
    }
  } catch {}
  let dpr = 0;
  try {
    dpr = Number(g.devicePixelRatio) || 0;
  } catch {}
  let scroll: { top: number; range: number } | null = null;
  let scrollRootFound = true;
  if (arg && arg.scrollRoot) {
    try {
      const root = doc.querySelector(arg.scrollRoot);
      scrollRootFound = !!root;
      if (root) {
        scroll = {
          top: Math.round(Number(root.scrollTop) || 0),
          range: Math.max(0, (Number(root.scrollHeight) || 0) - (Number(root.clientHeight) || 0)),
        };
      }
    } catch {
      scrollRootFound = false;
    }
  } else {
    try {
      const docEl = doc.documentElement;
      const viewportHeight = Number(g.innerHeight) || Number(docEl.clientHeight) || 0;
      scroll = {
        top: Math.round(Number(g.scrollY) || 0),
        range: Math.max(0, (Number(docEl.scrollHeight) || 0) - viewportHeight),
      };
    } catch {}
  }
  return { canvasFound, rect, backing, dpr, scroll, scrollRootFound };
};
export const SCENE_SCROLL = function (arg: { scrollRoot: string; top: number }): number {
  const g = globalThis as any;
  const doc = g.document;
  const top = Math.max(0, Math.round(arg.top));
  if (arg && arg.scrollRoot) {
    try {
      const el = doc.querySelector(arg.scrollRoot);
      if (!el) return -1;
      try {
        el.style.scrollBehavior = "auto";
      } catch {}
      el.scrollTop = top;
      return Math.round(Number(el.scrollTop) || 0);
    } catch {
      return -1;
    }
  }
  try {
    doc.documentElement.style.scrollBehavior = "auto";
  } catch {}
  try {
    g.scrollTo(0, top);
  } catch {}
  return Math.round(Number(g.scrollY) || 0);
};

export const SCENE_READ = function (arg: { scrollRoot: string }): number {
  const g = globalThis as any;
  const doc = g.document;
  if (arg && arg.scrollRoot) {
    try {
      const el = doc.querySelector(arg.scrollRoot);
      return el ? Math.round(Number(el.scrollTop) || 0) : -1;
    } catch {
      return -1;
    }
  }
  try {
    return Math.round(Number(g.scrollY) || 0);
  } catch {
    return 0;
  }
};

export const SCENE_HINTS = function (): {
  threeRevision: string | null;
  babylonVersion: string | null;
  playcanvasVersion: string | null;
  scripts: string[];
  canvasCount: number;
} {
  const g = globalThis as any;
  const doc = g.document;
  const read = (fn: () => unknown): string | null => {
    try {
      const value = fn();
      if (value === undefined || value === null) return null;
      const text = String(value).slice(0, 200);
      return text || null;
    } catch {
      return null;
    }
  };
  const threeRevision = read(() => g.THREE?.REVISION);
  const babylonVersion = read(() => g.BABYLON?.Engine?.Version);
  const playcanvasVersion = read(() => g.pc?.version);
  const scripts: string[] = [];
  let canvasCount = 0;
  try {
    canvasCount = doc.querySelectorAll("canvas").length;
  } catch {}
  try {
    const tags = Array.from(doc.querySelectorAll("script[src]")) as any[];
    for (const tag of tags) {
      try {
        const raw = String(tag.src || "");
        if (!raw || !/three|babylon|playcanvas/i.test(raw)) continue;
        const u = new g.URL(raw);
        const clean = (u.protocol + "//" + u.host + u.pathname).slice(0, 2048);
        if (!scripts.includes(clean) && scripts.length < 20) scripts.push(clean);
      } catch {}
    }
  } catch {}
  return { threeRevision, babylonVersion, playcanvasVersion, scripts, canvasCount };
};

interface SceneThreeProbeMaterial extends Omit<SceneThreeMaterial, "map"> {
  map: string | null;
}

interface SceneThreeProbeNode extends Omit<SceneThreeNode, "material"> {
  material: SceneThreeProbeMaterial | SceneThreeProbeMaterial[] | null;
}

interface SceneThreeProbeResult {
  available: boolean;
  reason: string;
  revision: string | null;
  scene: { nodes: SceneThreeProbeNode[]; truncated: boolean; total: number } | null;
  camera: SceneThreeCamera | null;
  cameras: SceneThreeCamera[];
  lights: SceneThreeLight[];
  controls: SceneThreeControls | null;
}

export interface SceneThreeProbeCaps {
  maxNodes: number;
  maxDepth: number;
  maxCameras: number;
  maxLights: number;
  maxMaterials: number;
  maxTextures: number;
  maxAttributes: number;
  maxNameChars: number;
  maxUuidChars: number;
  maxTypeChars: number;
  maxUrlChars: number;
}

export const THREE_PROBE_CAPS: SceneThreeProbeCaps = {
  maxNodes: SCENE_LIMITS.maxThreeNodes,
  maxDepth: SCENE_LIMITS.maxThreeDepth,
  maxCameras: SCENE_LIMITS.maxThreeCameras,
  maxLights: SCENE_LIMITS.maxThreeLights,
  maxMaterials: SCENE_LIMITS.maxThreeMaterials,
  maxTextures: SCENE_LIMITS.maxThreeTextures,
  maxAttributes: SCENE_LIMITS.maxThreeAttributes,
  maxNameChars: SCENE_LIMITS.maxThreeNameChars,
  maxUuidChars: SCENE_LIMITS.maxThreeUuidChars,
  maxTypeChars: SCENE_LIMITS.maxThreeTypeChars,
  maxUrlChars: SCENE_LIMITS.maxThreeUrlChars,
};

/** Fixed numeric geometry parameters copied for primitive reconstruction. */
export const THREE_GEOMETRY_PARAMETER_KEYS = [
  "width",
  "height",
  "depth",
  "radius",
  "radiusTop",
  "radiusBottom",
  "widthSegments",
  "heightSegments",
  "depthSegments",
  "radialSegments",
  "segments",
  "thetaStart",
  "thetaLength",
  "phiStart",
  "phiLength",
] as const;

/**
 * In-page three probe. It only follows a fixed list of globals (no heap crawl,
 * no hooks, no network) and copies primitives out immediately, so page objects,
 * shaders and userData never cross the boundary. Every read is guarded: a
 * throwing getter drops that value, never the probe.
 */
export const SCENE_THREE_PROBE = function (arg: SceneThreeProbeCaps): SceneThreeProbeResult {
  const g = globalThis as any;
  // Every page property read goes through safeGet: a throwing getter (or a
  // getter for a different key) can never abort the probe.
  const safeGet = (target: any, key: string): any => {
    try {
      if (!target || (typeof target !== "object" && typeof target !== "function")) return undefined;
      return target[key];
    } catch {
      return undefined;
    }
  };
  // Primitives only: Number(value) would invoke page-defined valueOf/toPrimitive.
  const num = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const boundedNum = (value: unknown, min: number, max: number): number | null => {
    const n = num(value);
    if (n === null) return null;
    return n < min ? min : n > max ? max : n;
  };
  const text = (value: unknown, max: number): string | null => {
    if (typeof value !== "string" || value.length === 0) return null;
    return value.slice(0, max);
  };
  const vecOf = (value: any, keys: string[]): number[] | null => {
    try {
      if (!value || typeof value !== "object") return null;
      const out: number[] = [];
      for (let i = 0; i < keys.length; i++) {
        const n = num(safeGet(value, keys[i]!));
        if (n === null) return null;
        out.push(n);
      }
      return out;
    } catch {
      return null;
    }
  };
  const vec3 = (value: any): number[] | null => vecOf(value, ["x", "y", "z"]);
  const quat = (value: any): number[] | null => vecOf(value, ["x", "y", "z", "w"]);
  // Colour via own numeric r/g/b data properties: no getters, no prototypes,
  // no getHexString() call, no coercion. Three stores colours in the working
  // (linear) space; convert back to sRGB unless the page disabled
  // ColourManagement, matching getHexString().
  const ownDescriptor = (target: any, key: string): PropertyDescriptor | null => {
    try {
      return Object.getOwnPropertyDescriptor(target, key) ?? null;
    } catch {
      return null;
    }
  };
  const ownNumber = (target: any, key: string): number | null => {
    const descriptor = ownDescriptor(target, key);
    const value = descriptor && "value" in descriptor ? descriptor.value : null;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const srgbColors = safeGet(safeGet(safeGet(g, "THREE"), "ColorManagement"), "enabled") !== false;
  const hex = (value: any): string | null => {
    try {
      if (!value || typeof value !== "object") return null;
      const r = boundedNum(ownNumber(value, "r"), 0, 1);
      const green = boundedNum(ownNumber(value, "g"), 0, 1);
      const blue = boundedNum(ownNumber(value, "b"), 0, 1);
      if (r === null || green === null || blue === null) return null;
      const encode = (n: number): number => {
        if (!srgbColors) return n;
        return n <= 0.0031308 ? 12.92 * n : 1.055 * Math.pow(n, 1 / 2.4) - 0.055;
      };
      const channel = (n: number): string =>
        Math.round(Math.max(0, Math.min(1, encode(n))) * 255)
          .toString(16)
          .padStart(2, "0");
      return "#" + channel(r) + channel(green) + channel(blue);
    } catch {
      return null;
    }
  };

  // Raw primitive source only: no URL constructor, no page method. Node
  // canonicalises it against the captured page URL and redacts it.
  const textureSource = (material: any): string | null => {
    const map = safeGet(material, "map");
    if (!map || typeof map !== "object") return null;
    const source = safeGet(map, "source");
    const data = source && typeof source === "object" ? safeGet(source, "data") : undefined;
    const image = data && typeof data === "object" ? data : safeGet(map, "image");
    if (!image || typeof image !== "object") return null;
    return (
      text(safeGet(image, "currentSrc"), arg.maxUrlChars) ??
      text(safeGet(image, "src"), arg.maxUrlChars)
    );
  };

  const materials: any[] = [];
  const textures: string[] = [];
  const materialRecord = (material: any): any => {
    // Budget checked before any field is read.
    if (!material || typeof material !== "object") return null;
    if (materials.length >= arg.maxMaterials) return null;
    try {
      const record: any = {
        type: text(safeGet(material, "type"), arg.maxTypeChars) ?? "unknown",
        color: hex(safeGet(material, "color")),
        opacity: num(safeGet(material, "opacity")),
        transparent: safeGet(material, "transparent") === true,
        metalness: num(safeGet(material, "metalness")),
        roughness: num(safeGet(material, "roughness")),
        side: num(safeGet(material, "side")),
        map: null,
      };
      // Texture sources are read only while the URL budget remains.
      if (textures.length < arg.maxTextures) {
        const mapUrl = textureSource(material);
        if (mapUrl) {
          if (textures.indexOf(mapUrl) === -1) textures.push(mapUrl);
          record.map = mapUrl;
        }
      }
      materials.push(record);
      return record;
    } catch {
      return null;
    }
  };

  const geometryRecord = (geometry: any): any => {
    try {
      if (!geometry || typeof geometry !== "object") return null;
      // Fixed allowlist, own data descriptors only: inherited keys and getters
      // are never read, and maxAttributes counts names examined (not accepted).
      const attributes: Array<{ name: string; count: number }> = [];
      const attrs = safeGet(geometry, "attributes");
      if (attrs && typeof attrs === "object") {
        const keys = ["position", "normal", "uv", "uv2", "color", "tangent", "skinIndex", "skinWeight"];
        let examined = 0;
        for (let i = 0; i < keys.length && examined < arg.maxAttributes; i++, examined++) {
          const name = keys[i]!;
          const descriptor = ownDescriptor(attrs, name);
          if (!descriptor || !("value" in descriptor)) continue;
          const attribute = descriptor.value;
          if (!attribute || typeof attribute !== "object") continue;
          const countDescriptor = ownDescriptor(attribute, "count");
          const count = countDescriptor && "value" in countDescriptor ? num(countDescriptor.value) : null;
          if (count === null) continue;
          attributes.push({
            name,
            count: Math.min(Math.trunc(count), 1_000_000_000),
          });
        }
      }
      let indexCount: number | null = null;
      const index = safeGet(geometry, "index");
      if (index && typeof index === "object") indexCount = num(safeGet(index, "count"));
      let bounds: { min: number[]; max: number[] } | null = null;
      const box = safeGet(geometry, "boundingBox");
      if (box && typeof box === "object") {
        const min = vec3(safeGet(box, "min"));
        const max = vec3(safeGet(box, "max"));
        if (min && max) bounds = { min, max };
      }
      const parameters: Record<string, number> = {};
      const rawParameters = safeGet(geometry, "parameters");
      if (rawParameters && typeof rawParameters === "object") {
        // Fixed allowlist, not a page-controlled key set.
        const keys = [
          "width",
          "height",
          "depth",
          "radius",
          "radiusTop",
          "radiusBottom",
          "widthSegments",
          "heightSegments",
          "depthSegments",
          "radialSegments",
          "segments",
          "thetaStart",
          "thetaLength",
          "phiStart",
          "phiLength",
        ];
        for (let i = 0; i < keys.length; i++) {
          const value = boundedNum(safeGet(rawParameters, keys[i]!), -1_000_000, 1_000_000);
          if (value !== null) parameters[keys[i]!] = value;
        }
      }
      return {
        type: text(safeGet(geometry, "type"), arg.maxTypeChars) ?? "unknown",
        attributes,
        indexCount,
        bounds,
        parameters,
      };
    } catch {
      return null;
    }
  };

  const cameraRecord = (camera: any): any => {
    try {
      if (!camera || typeof camera !== "object") return null;
      let matrixWorld: number[] | null = null;
      const elements = safeGet(safeGet(camera, "matrixWorld"), "elements");
      if (elements && typeof elements === "object") {
        let length = 0;
        try {
          const rawLength = (elements as any).length;
          if (typeof rawLength === "number" && Number.isFinite(rawLength)) length = rawLength;
        } catch {
          length = 0;
        }
        if (length >= 16) {
          const out: number[] = [];
          for (let i = 0; i < 16; i++) {
            const n = num(safeGet(elements, String(i)));
            if (n === null) {
              out.length = 0;
              break;
            }
            out.push(n);
          }
          if (out.length === 16) matrixWorld = out;
        }
      }
      return {
        type: text(safeGet(camera, "type"), arg.maxTypeChars) ?? "unknown",
        fov: num(safeGet(camera, "fov")),
        near: num(safeGet(camera, "near")),
        far: num(safeGet(camera, "far")),
        matrixWorld,
      };
    } catch {
      return null;
    }
  };

  const lightRecord = (light: any): any => {
    try {
      if (!light || typeof light !== "object") return null;
      return {
        type: text(safeGet(light, "type"), arg.maxTypeChars) ?? "unknown",
        color: hex(safeGet(light, "color")),
        intensity: num(safeGet(light, "intensity")),
        distance: num(safeGet(light, "distance")),
      };
    } catch {
      return null;
    }
  };

  const controlsRecord = (controls: any): any => {
    try {
      if (!controls || typeof controls !== "object") return null;
      // No page method is called: update is only type-checked, never invoked.
      if (typeof safeGet(controls, "update") !== "function") return null;
      const target = vec3(safeGet(controls, "target"));
      if (!target) return null;
      // Real OrbitControls 0.160 exposes .object; other builds expose .camera.
      const camera = safeGet(controls, "camera") ?? safeGet(controls, "object");
      if (!camera || typeof camera !== "object") return null;
      return {
        type: text(safeGet(controls, "type"), arg.maxTypeChars) ?? "controls",
        target,
      };
    } catch {
      return null;
    }
  };

  // Reachable roots only: the documented globals and one property level on the
  // usual app holders. Every read is guarded so a single throwing getter (for
  // example window.scene) cannot hide a valid window.camera.
  const candidates: any[] = [];
  const push = (value: any): void => {
    if (!value || typeof value !== "object") return;
    if (candidates.length < 24 && candidates.indexOf(value) === -1) candidates.push(value);
  };
  push(safeGet(g, "scene"));
  push(safeGet(g, "camera"));
  push(safeGet(g, "renderer"));
  push(safeGet(g, "controls"));
  for (let i = 0; i < 4; i++) {
    const key = ["app", "experience", "viewer", "world"][i]!;
    const holder = safeGet(g, key);
    push(holder);
    if (holder && typeof holder === "object") {
      push(safeGet(holder, "scene"));
      push(safeGet(holder, "camera"));
      push(safeGet(holder, "renderer"));
      push(safeGet(holder, "controls"));
    }
  }

  const revision = text(safeGet(safeGet(g, "THREE"), "REVISION"), arg.maxNameChars);

  const cameras: any[] = [];
  const cameraObjects: any[] = [];
  const addCamera = (camera: any): void => {
    if (!camera || cameras.length >= arg.maxCameras) return;
    try {
      if (cameraObjects.indexOf(camera) !== -1) return;
    } catch {
      return;
    }
    const record = cameraRecord(camera);
    if (!record) return;
    cameraObjects.push(camera);
    cameras.push(record);
  };
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    if (safeGet(candidate, "isCamera") === true) addCamera(candidate);
  }

  let root: any = null;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    if (safeGet(candidate, "isScene") === true) {
      root = candidate;
      break;
    }
  }
  if (!root) {
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      if (safeGet(candidate, "isCamera") === true || safeGet(candidate, "isLight") === true) continue;
      if (Array.isArray(safeGet(candidate, "children")) && typeof safeGet(candidate, "traverse") === "function") {
        root = candidate;
        break;
      }
    }
  }

  const nodes: any[] = [];
  const lights: any[] = [];
  const lightObjects: any[] = [];
  const addLight = (object: any, record: any): void => {
    if (!record || lights.length >= arg.maxLights) return;
    try {
      if (lightObjects.indexOf(object) !== -1) return;
    } catch {
      return;
    }
    lightObjects.push(object);
    lights.push(record);
  };
  let attempted = 0;
  let total = 0;
  let truncated = false;

  const nodeRecord = (object: any): any => {
    try {
      let type = "object";
      if (safeGet(object, "isMesh") === true) type = "mesh";
      else if (safeGet(object, "isLight") === true) type = "light";
      else if (safeGet(object, "isCamera") === true) type = "camera";
      else if (safeGet(object, "isScene") === true) type = "scene";
      else if (safeGet(object, "isGroup") === true) type = "group";
      let childCount = 0;
      try {
        const kids = safeGet(object, "children");
        const length = Array.isArray(kids) ? (kids as any).length : 0;
        childCount = typeof length === "number" && Number.isFinite(length) ? Math.min(length, 1_000_000) : 0;
      } catch {
        childCount = 0;
      }
      const record: any = {
        type,
        name: text(safeGet(object, "name"), arg.maxNameChars),
        uuid: text(safeGet(object, "uuid"), arg.maxUuidChars),
        visible: safeGet(object, "visible") !== false,
        position: vec3(safeGet(object, "position")),
        quaternion: quat(safeGet(object, "quaternion")),
        scale: vec3(safeGet(object, "scale")),
        childCount,
        geometry: null,
        material: null,
        camera: null,
        light: null,
      };
      if (type === "mesh") {
        record.geometry = geometryRecord(safeGet(object, "geometry"));
        const raw = safeGet(object, "material");
        if (Array.isArray(raw)) {
          const list: any[] = [];
          const limit = raw.length < 8 ? raw.length : 8;
          for (let i = 0; i < limit; i++) {
            const material = materialRecord(safeGet(raw, String(i)));
            if (material) list.push(material);
          }
          record.material = list;
        } else {
          record.material = materialRecord(raw);
        }
      }
      // Camera/light budgets are checked before the record is read, not after.
      if (type === "camera" && cameras.length < arg.maxCameras) {
        record.camera = cameraRecord(object);
      }
      if (type === "light" && lights.length < arg.maxLights) {
        record.light = lightRecord(object);
      }
      return record;
    } catch {
      return null;
    }
  };

  if (root) {
    // Bounded array, not WeakSet: the probe must not invoke any page-replaceable
    // constructor. At <= 2 * maxNodes attempts the scan stays small.
    const visited: any[] = [];
    const queue: Array<{ object: any; depth: number }> = [{ object: root, depth: 0 }];
    attempted += 1;
    total += 1;
    while (queue.length > 0) {
      if (nodes.length >= arg.maxNodes) {
        truncated = true;
        break;
      }
      const item = queue.shift()!;
      let object: any = null;
      try {
        object = item.object;
      } catch {
        object = null;
      }
      if (!object || typeof object !== "object") continue;
      if (visited.indexOf(object) !== -1) continue;
      visited.push(object);
      // Attempted-read counter increments before the object is read.
      attempted += 1;
      const record = nodeRecord(object);
      if (record) {
        nodes.push(record);
        if (record.type === "camera" && record.camera) addCamera(object);
        if (record.type === "light" && record.light) addLight(object, record.light);
      }

      let children: any = null;
      try {
        children = safeGet(object, "children");
      } catch {
        children = null;
      }
      if (!Array.isArray(children)) continue;
      let count = 0;
      try {
        const length = (children as any).length;
        count = typeof length === "number" && Number.isFinite(length) ? length : 0;
      } catch {
        count = 0;
      }
      if (item.depth >= arg.maxDepth) {
        if (count > 0) truncated = true;
        continue;
      }
      // Never enqueue more than the node budget, however long the child list.
      const limit = count < arg.maxNodes ? count : arg.maxNodes;
      for (let i = 0; i < limit; i++) {
        if (total >= arg.maxNodes) {
          truncated = true;
          break;
        }
        if (queue.length >= arg.maxNodes) {
          truncated = true;
          break;
        }
        let child: any = null;
        try {
          child = safeGet(children, String(i));
        } catch {
          continue;
        }
        if (!child || typeof child !== "object") continue;
        if (visited.indexOf(child) !== -1) continue;
        // Increment before enqueue: a 10k child list costs at most the budget.
        attempted += 1;
        total += 1;
        queue.push({ object: child, depth: item.depth + 1 });
      }
      if (limit < count) truncated = true;
    }
    // Observed children that never left the queue are counted, never serialized.
    if (queue.length > 0) truncated = true;
  }

  let controls: any = null;
  for (let i = 0; i < candidates.length; i++) {
    controls = controlsRecord(candidates[i]!);
    if (controls) break;
  }

  const available = root !== null || cameras.length > 0 || controls !== null;
  const reason = available
    ? root
      ? "Reachable three objects were read from window.* only; the heap was not crawled."
      : "A reachable three camera or controls object was read, but no scene root was found."
    : revision
      ? `THREE is present (r${revision}) but no reachable scene, camera or controls object was found on window.scene/camera/renderer, window.app/experience/viewer/world.`
      : "No window.THREE and no reachable three scene, camera or controls object was found.";

  return {
    available,
    reason,
    revision,
    scene: root ? { nodes, truncated, total } : null,
    camera: cameras.length > 0 ? cameras[0]! : null,
    cameras,
    lights,
    controls,
  };
};

// ---- opt-in spector adapter ---------------------------------------------
// The bundle is an optional dependency: it is resolved and read only when the
// adapter is requested, and a missing package is an unavailable adapter, never
// a capture failure. Shader source read from the page is untrusted text: it is
// capped, stored as data and never executed.

const SPECTOR_BUNDLE_ID = "spectorjs/dist/spector.bundle.js";
const SPECTOR_PACKAGE_ID = "spectorjs/package.json";

export const SPECTOR_INSTALL_HINT =
  "spectorjs is not installed; install it with: npm install --save-optional spectorjs@0.9.33";

export interface SpectorBundle {
  source: string;
  version: string | null;
}

type ModuleResolver = (id: string) => string;

const defaultModuleResolver: ModuleResolver = (id) => createRequire(import.meta.url).resolve(id);

/** Resolves and reads the optional spectorjs bundle; null when it is absent. */
export async function loadSpectorBundle(
  resolve: ModuleResolver = defaultModuleResolver,
): Promise<SpectorBundle | null> {
  try {
    const source = await readFile(resolve(SPECTOR_BUNDLE_ID), "utf8");
    let version: string | null = null;
    try {
      const pkg = JSON.parse(await readFile(resolve(SPECTOR_PACKAGE_ID), "utf8")) as {
        version?: unknown;
      };
      version = typeof pkg.version === "string" ? pkg.version : null;
    } catch {
      version = null;
    }
    return { source, version };
  } catch {
    return null;
  }
}

/**
 * Wraps the UMD bundle as an init script. spector.bundle.js inserts its UI
 * stylesheet into <head> at load, but addInitScript runs before the document
 * element exists, so it would throw on document.head/querySelector("html").
 * Give it a detached html/head for its own evaluation, then restore the
 * document: the UI is never displayed, so those styles are never needed.
 */
export function spectorInitScript(bundle: string): string {
  return `(() => {
  const html = document.createElement("html");
  const head = document.createElement("head");
  const headDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "head");
  const querySelector = document.querySelector;
  Object.defineProperty(document, "head", {
    configurable: true,
    get() { return headDescriptor.get.call(document) || head; },
  });
  document.querySelector = function (selector) {
    return querySelector.call(this, selector) || (/^html$/i.test(String(selector)) ? html : null);
  };
  try {
${bundle}
  } finally {
    document.querySelector = querySelector;
    delete document.head;
  }
})();`;
}

export interface SceneSpectorProbeCaps {
  canvasSelector: string;
  timeoutMs: number;
  maxPrograms: number;
  maxShaders: number;
  maxShaderChars: number;
  maxTotalShaderChars: number;
  maxCommandNames: number;
  maxAnalyses: number;
  maxAnalysisKeys: number;
  maxNameChars: number;
  maxInfoLogChars: number;
  maxAttributeCount: number;
}

interface SceneSpectorProbeSummary {
  canvas: { width: number; height: number };
  context: { version: number; attributes: Record<string, boolean | number | string | null> } | null;
  commands: {
    total: number;
    drawCalls: number;
    byName: Array<{ name: string; count: number }>;
    statuses: SceneSpectorStatuses;
  };
  programs: SceneSpectorProgram[];
  analyses: Array<{ name: string; values: Record<string, boolean | number | string> }>;
  programsTruncated: boolean;
  shadersTruncated: boolean;
}

export function spectorProbeCaps(canvasSelector: string, timeoutMs: number): SceneSpectorProbeCaps {
  return {
    canvasSelector,
    timeoutMs,
    maxPrograms: SCENE_LIMITS.maxSpectorPrograms,
    maxShaders: SCENE_LIMITS.maxSpectorShaders,
    maxShaderChars: SCENE_LIMITS.maxSpectorShaderChars,
    maxTotalShaderChars: SCENE_LIMITS.maxSpectorTotalShaderChars,
    maxCommandNames: SCENE_LIMITS.maxSpectorCommandNames,
    maxAnalyses: SCENE_LIMITS.maxSpectorAnalyses,
    maxAnalysisKeys: SCENE_LIMITS.maxSpectorAnalysisKeys,
    maxNameChars: SCENE_LIMITS.maxSpectorNameChars,
    maxInfoLogChars: SCENE_LIMITS.maxSpectorInfoLogChars,
    maxAttributeCount: SCENE_LIMITS.maxSpectorAttributes,
  };
}

/**
 * In-page spector capture. It serializes a compact summary inside the page, so
 * command arguments, results, state, stack traces, memory and the raw capture
 * never cross into Node. Every read is guarded and every value is re-typed.
 *
 * spectorjs has no dispose/uninstall API. Its constructor patches the page's
 * requestAnimationFrame/setTimeout/setInterval wrappers and installs a global
 * shader-compile-delay hook on the WebGL prototypes, and stopCapture() alone
 * can re-arm one more frame. ContextSpy.unSpy() then writes the hook back as an
 * own property of the selected context, so disposal must also restore that
 * context's own compile-hook descriptors. The probe snapshots all of it before
 * construction and restores it on every exit (success, error or timeout); only
 * documented methods and own properties are used, each inside try/catch.
 */
export const SCENE_SPECTOR_PROBE = function (
  arg: SceneSpectorProbeCaps,
): Promise<SceneSpectorProbeSummary | { error: string }> {
  const g = globalThis as any;
  return new Promise((resolve) => {
    let spector: any = null;
    let timer: any = null;
    let settled = false;
    // TimeSpy.init() replaces these on globalThis and stores the original
    // beside them as __SPECTOR_Origin_<name>.
    const timingNames = [
      "requestAnimationFrame",
      "msRequestAnimationFrame",
      "webkitRequestAnimationFrame",
      "mozRequestAnimationFrame",
      "oRequestAnimationFrame",
      "setTimeout",
      "setInterval",
    ];
    // ShaderCompileDelay.install() wraps these prototypes from the constructor.
    const compileHooks = ["linkProgram", "getProgramParameter"];
    // ContextSpy.spy() replaces each context method with an own property and
    // unSpy() writes the value it captured back, which for these two is the
    // constructor's hook rather than the native prototype method. Snapshot the
    // context's own descriptors before the constructor runs so disposal can
    // restore them (or delete the own property when it was inherited).
    const contextHooks: Array<{
      context: any;
      name: string;
      descriptor: PropertyDescriptor | undefined;
    }> = [];
    const snapshotContext = (context: any): void => {
      if (!context || typeof context !== "object") return;
      for (const name of compileHooks) {
        try {
          contextHooks.push({
            context,
            name,
            descriptor: Object.getOwnPropertyDescriptor(context, name),
          });
        } catch {}
      }
    };
    const restoreContexts = (): void => {
      for (const row of contextHooks) {
        try {
          if (row.descriptor) Object.defineProperty(row.context, row.name, row.descriptor);
          else delete row.context[row.name];
        } catch {}
      }
    };
    const prototypes: Array<{ proto: any; functions: any[] }> = [];
    const snapshotPrototype = (iface: any): void => {
      try {
        if (!iface || (typeof iface !== "object" && typeof iface !== "function") || !iface.prototype) {
          return;
        }
        const functions: any[] = [];
        for (const name of compileHooks) {
          functions.push(typeof iface.prototype[name] === "function" ? iface.prototype[name] : null);
        }
        prototypes.push({ proto: iface.prototype, functions });
      } catch {}
    };
    snapshotPrototype(g.WebGLRenderingContext);
    snapshotPrototype(g.WebGL2RenderingContext);

    const restoreTiming = (): void => {
      for (const name of timingNames) {
        try {
          const key = "__SPECTOR_Origin_" + name;
          const origin = g[key];
          if (typeof origin !== "function") continue;
          if (g[name] !== origin) g[name] = origin;
          delete g[key];
        } catch {}
      }
    };
    const restorePrototypes = (): void => {
      for (const row of prototypes) {
        try {
          for (let i = 0; i < compileHooks.length; i++) {
            const original = row.functions[i];
            if (typeof original !== "function") continue;
            if (row.proto[compileHooks[i]!] !== original) row.proto[compileHooks[i]!] = original;
          }
        } catch {}
      }
    };
    const dispose = (): void => {
      // stopCapture() retries one frame when it captured no commands, so the
      // frame budget is zeroed before and after it.
      const zeroCaptureState = (): void => {
        try {
          spector.captureNextFrames = 0;
        } catch {}
        try {
          spector.captureNextCommands = 0;
        } catch {}
        try {
          spector.retry = 0;
        } catch {}
      };
      zeroCaptureState();
      try {
        spector.onCapture.clear();
      } catch {}
      try {
        spector.onError.clear();
      } catch {}
      try {
        spector.onCaptureStarted.clear();
      } catch {}
      try {
        spector.stopCapture();
      } catch {}
      zeroCaptureState();
      try {
        spector.capturingContext = undefined;
      } catch {}
      try {
        if (typeof spector.noFrameTimeout === "number" && spector.noFrameTimeout >= 0) {
          clearTimeout(spector.noFrameTimeout);
        }
      } catch {}
      try {
        spector.noFrameTimeout = -1;
      } catch {}
      // Restore the per-context WebGL method spies.
      try {
        const contexts = spector.contexts;
        if (Array.isArray(contexts)) {
          for (const row of contexts) {
            try {
              if (row && row.contextSpy) {
                row.contextSpy.capturing = false;
                if (typeof row.contextSpy.unSpy === "function") row.contextSpy.unSpy();
              }
            } catch {}
          }
        }
      } catch {}
      try {
        if (spector.canvasSpy && typeof spector.canvasSpy.unSpy === "function") spector.canvasSpy.unSpy();
      } catch {}
      // The frame observers keep the instance reachable from every wrapped
      // rAF/timer callback; remove them before restoring the wrappers.
      try {
        const timeSpy = spector.timeSpy;
        if (timeSpy) {
          if (timeSpy.onFrameStart && typeof timeSpy.onFrameStart.clear === "function") timeSpy.onFrameStart.clear();
          if (timeSpy.onFrameEnd && typeof timeSpy.onFrameEnd.clear === "function") timeSpy.onFrameEnd.clear();
          if (timeSpy.onError && typeof timeSpy.onError.clear === "function") timeSpy.onError.clear();
        }
      } catch {}
      restoreTiming();
      restorePrototypes();
      restoreContexts();
    };
    const finish = (value: any): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        try {
          clearTimeout(timer);
        } catch {}
      }
      try {
        dispose();
      } catch {}
      resolve(value);
    };
    const num = (value: unknown, max: number): number => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
      return Math.min(Math.trunc(value), max);
    };
    const text = (value: unknown, max: number): string | null =>
      typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
    const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

    const summarize = (capture: any): SceneSpectorProbeSummary | { error: string } => {
      if (!capture || typeof capture !== "object") {
        return { error: "spector returned no capture" };
      }
      const commands = Array.isArray(capture.commands) ? capture.commands : [];
      const statusNames = ["unknown", "unused", "disabled", "redundant", "valid", "deprecated"];
      const statusCodes = [0, 10, 20, 30, 40, 50];
      const statuses: SceneSpectorStatuses = {
        unknown: 0,
        unused: 0,
        disabled: 0,
        redundant: 0,
        valid: 0,
        deprecated: 0,
      };
      const nameCounts = new Map<string, number>();
      let drawCalls = 0;
      for (let i = 0; i < commands.length; i++) {
        const command = commands[i];
        if (!command || typeof command !== "object") continue;
        const name = text(command.name, arg.maxNameChars);
        if (name === null) continue;
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
        if (/^draw/i.test(name)) drawCalls += 1;
        const at = statusCodes.indexOf(num(command.status, 100));
        if (at !== -1) statuses[statusNames[at] as keyof SceneSpectorStatuses] += 1;
      }

      const programs: SceneSpectorProgram[] = [];
      const seenPrograms: number[] = [];
      let shaderCount = 0;
      let totalChars = 0;
      let programsTruncated = false;
      let shadersTruncated = false;
      for (let i = 0; i < commands.length; i++) {
        const command = commands[i];
        const draw = command && typeof command === "object" ? command.DrawCall : null;
        if (!draw || typeof draw !== "object") continue;
        const rawShaders = Array.isArray(draw.shaders) ? draw.shaders : [];
        if (rawShaders.length === 0) continue;
        const programStatus =
          draw.programStatus && typeof draw.programStatus === "object" ? draw.programStatus : null;
        let tag: number | null = null;
        try {
          const program = programStatus ? programStatus.program : null;
          const rawTag = program && program.__SPECTOR_Object_TAG ? program.__SPECTOR_Object_TAG.id : null;
          tag = typeof rawTag === "number" && Number.isFinite(rawTag) ? rawTag : null;
        } catch {
          tag = null;
        }
        if (tag !== null) {
          if (seenPrograms.indexOf(tag) !== -1) continue;
          if (programs.length >= arg.maxPrograms) {
            programsTruncated = true;
            continue;
          }
          seenPrograms.push(tag);
        } else if (programs.length >= arg.maxPrograms) {
          programsTruncated = true;
          continue;
        }
        const shaders: SceneSpectorShader[] = [];
        for (let s = 0; s < rawShaders.length; s++) {
          const shader = rawShaders[s];
          if (!shader || typeof shader !== "object" || typeof shader.source !== "string") continue;
          if (shaderCount >= arg.maxShaders) {
            shadersTruncated = true;
            break;
          }
          const full = shader.source;
          const remaining = arg.maxTotalShaderChars - totalChars;
          if (remaining <= 0) {
            shadersTruncated = true;
            break;
          }
          let source = full;
          let truncated = false;
          if (source.length > arg.maxShaderChars) {
            source = source.slice(0, arg.maxShaderChars);
            truncated = true;
          }
          if (source.length > remaining) {
            source = source.slice(0, remaining);
            truncated = true;
            shadersTruncated = true;
          }
          totalChars += source.length;
          shaderCount += 1;
          shaders.push({
            type: text(shader.shaderType, arg.maxNameChars) ?? "unknown",
            source,
            length: full.length,
            truncated,
          });
        }
        if (shaders.length === 0) continue;
        programs.push({
          programStatus: {
            LINK_STATUS: bool(programStatus ? programStatus.LINK_STATUS : null),
            VALIDATE_STATUS: bool(programStatus ? programStatus.VALIDATE_STATUS : null),
            infoLog: text(programStatus ? programStatus.infoLog : null, arg.maxInfoLogChars),
          },
          shaders,
        });
      }

      let context: SceneSpectorProbeSummary["context"] = null;
      const rawContext = capture.context;
      if (rawContext && typeof rawContext === "object") {
        const attributes: Record<string, boolean | number | string | null> = {};
        let rawAttributes: any = null;
        try {
          rawAttributes = rawContext.contextAttributes;
        } catch {
          rawAttributes = null;
        }
        if (rawAttributes && typeof rawAttributes === "object") {
          let keys: string[] = [];
          try {
            keys = Object.keys(rawAttributes).slice(0, arg.maxAttributeCount);
          } catch {
            keys = [];
          }
          for (let k = 0; k < keys.length; k++) {
            const key = String(keys[k]!).slice(0, arg.maxNameChars);
            if (!key) continue;
            let value: any;
            try {
              value = rawAttributes[key];
            } catch {
              continue;
            }
            if (typeof value === "boolean") attributes[key] = value;
            else if (typeof value === "number" && Number.isFinite(value)) attributes[key] = value;
            else if (typeof value === "string") attributes[key] = value.slice(0, arg.maxNameChars);
          }
        }
        context = { version: num(rawContext.version, 10), attributes };
      }

      const rawCanvas = capture.canvas;
      const canvas =
        rawCanvas && typeof rawCanvas === "object"
          ? { width: num(rawCanvas.width, 1_000_000), height: num(rawCanvas.height, 1_000_000) }
          : { width: 0, height: 0 };

      const analyses: Array<{ name: string; values: Record<string, boolean | number | string> }> = [];
      const rawAnalyses = Array.isArray(capture.analyses) ? capture.analyses : [];
      for (let i = 0; i < rawAnalyses.length && analyses.length < arg.maxAnalyses; i++) {
        const analysis = rawAnalyses[i];
        if (!analysis || typeof analysis !== "object") continue;
        const values: Record<string, boolean | number | string> = {};
        let keys: string[] = [];
        try {
          keys = Object.keys(analysis).slice(0, arg.maxAnalysisKeys + 1);
        } catch {
          keys = [];
        }
        for (let k = 0; k < keys.length; k++) {
          const key = String(keys[k]!).slice(0, arg.maxNameChars);
          if (!key || key === "analyserName" || Object.keys(values).length >= arg.maxAnalysisKeys) {
            continue;
          }
          let value: any;
          try {
            value = analysis[key];
          } catch {
            continue;
          }
          if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
            values[key] = value;
          } else if (typeof value === "string") {
            values[key] = value.slice(0, 200);
          }
        }
        analyses.push({
          name: text(analysis.analyserName, arg.maxNameChars) ?? "analysis",
          values,
        });
      }

      const byName = Array.from(nameCounts.entries())
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .slice(0, arg.maxCommandNames)
        .map(([name, count]) => ({ name, count }));

      return {
        canvas,
        context,
        commands: { total: commands.length, drawCalls, byName, statuses },
        programs,
        analyses,
        programsTruncated,
        shadersTruncated,
      };
    };

    try {
      const ctor = g.SPECTOR && typeof g.SPECTOR.Spector === "function" ? g.SPECTOR.Spector : null;
      if (!ctor) {
        finish({ error: "the spectorjs bundle did not load" });
        return;
      }
      let canvas: any = null;
      try {
        canvas = arg.canvasSelector ? g.document.querySelector(arg.canvasSelector) : null;
      } catch {
        canvas = null;
      }
      if (!canvas) {
        finish({ error: "the selected canvas is no longer on the page" });
        return;
      }
      // Resolve the same context captureCanvas will use, and snapshot its own
      // compile-hook descriptors before the constructor patches the prototypes.
      let canvasContext: any = null;
      try {
        canvasContext =
          typeof ctor.getFirstAvailable3dContext === "function"
            ? ctor.getFirstAvailable3dContext(canvas)
            : null;
      } catch {
        canvasContext = null;
      }
      snapshotContext(canvasContext);
      spector = new ctor();
      timer = setTimeout(
        () => finish({ error: "the in-page spector capture exceeded its time budget" }),
        arg.timeoutMs,
      );
      if (spector && spector.onError && typeof spector.onError.add === "function") {
        spector.onError.add((message: any) => {
          const textMessage = typeof message === "string" ? message : String(message);
          finish({ error: "spector reported: " + textMessage.slice(0, 200) });
        });
      }
      if (
        !spector ||
        !spector.onCapture ||
        typeof spector.onCapture.add !== "function" ||
        typeof spector.captureCanvas !== "function"
      ) {
        finish({ error: "the spectorjs Spector API is unavailable" });
        return;
      }
      spector.onCapture.add((capture: any) => {
        let summary: any;
        try {
          summary = summarize(capture);
        } catch {
          summary = { error: "the spector capture could not be summarized" };
        }
        finish(summary);
      });
      // 0 captures one complete frame with all its commands. A positive count
      // stops after N commands, which for a steady frame is just viewport or
      // clear and never reaches a draw call or its program.
      spector.captureCanvas(canvas, 0, false, false);
    } catch (err) {
      const message = err && (err as any).message ? String((err as any).message) : String(err);
      finish({ error: "the in-page spector probe threw: " + message.slice(0, 200) });
    }
  });
};

function spectorLimits(): SceneSpectorLimits {
  return {
    maxPrograms: SCENE_LIMITS.maxSpectorPrograms,
    maxShaders: SCENE_LIMITS.maxSpectorShaders,
    maxShaderChars: SCENE_LIMITS.maxSpectorShaderChars,
    maxTotalShaderChars: SCENE_LIMITS.maxSpectorTotalShaderChars,
    maxCommandNames: SCENE_LIMITS.maxSpectorCommandNames,
    programsTruncated: false,
    shadersTruncated: false,
  };
}

function emptySpectorStatuses(): SceneSpectorStatuses {
  return { unknown: 0, unused: 0, disabled: 0, redundant: 0, valid: 0, deprecated: 0 };
}

function unavailableSpector(reason: string, version: string | null): SceneSpectorEvidence {
  return {
    id: "spector-adapter-v1",
    available: false,
    reason: boundedText(reason, SCENE_LIMITS.maxSpectorReasonChars) ?? "the spector adapter returned no reason",
    version,
    canvas: null,
    context: null,
    commands: { total: 0, drawCalls: 0, byName: [], statuses: emptySpectorStatuses() },
    programs: [],
    analyses: [],
    limits: spectorLimits(),
  };
}

/** Rebuilds the in-page summary with only known fields and the documented caps. */
export function spectorFromProbe(
  raw: SceneSpectorProbeSummary,
  version: string | null,
): SceneSpectorEvidence {
  const numOf = (value: unknown, max = 1_000_000): number => {
    const n = typeof value === "number" ? value : NaN;
    return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), max) : 0;
  };
  // Original shader length is a character count, not a capped counter: it must
  // stay exact for sources far past the truncation cap. Its own bound is a
  // non-negative safe integer.
  const lengthOf = (value: unknown, fallback: number): number => {
    const n = typeof value === "number" ? value : NaN;
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.min(Math.trunc(n), Number.MAX_SAFE_INTEGER);
  };
  const textOf = (value: unknown, max: number): string | null => boundedText(value, max);
  const boolOf = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

  const statuses = emptySpectorStatuses();
  const rawStatuses = raw.commands?.statuses;
  if (rawStatuses && typeof rawStatuses === "object") {
    for (const key of Object.keys(statuses) as Array<keyof SceneSpectorStatuses>) {
      statuses[key] = numOf((rawStatuses as any)[key]);
    }
  }
  const byName = (Array.isArray(raw.commands?.byName) ? raw.commands.byName : [])
    .slice(0, SCENE_LIMITS.maxSpectorCommandNames)
    .map((row) => ({
      name: textOf(row?.name, SCENE_LIMITS.maxSpectorNameChars) ?? "unknown",
      count: numOf(row?.count),
    }));

  const programs: SceneSpectorProgram[] = [];
  let shaderTotal = 0;
  let charTotal = 0;
  let programsTruncated = raw.programsTruncated === true;
  let shadersTruncated = raw.shadersTruncated === true;
  const rawPrograms = Array.isArray(raw.programs) ? raw.programs : [];
  for (const row of rawPrograms) {
    if (programs.length >= SCENE_LIMITS.maxSpectorPrograms) {
      programsTruncated = true;
      break;
    }
    if (!row || typeof row !== "object") continue;
    const shaders: SceneSpectorShader[] = [];
    const rawShaders = Array.isArray(row.shaders) ? row.shaders : [];
    for (const shader of rawShaders) {
      if (shaderTotal >= SCENE_LIMITS.maxSpectorShaders) {
        shadersTruncated = true;
        break;
      }
      const full = typeof shader?.source === "string" ? shader.source : null;
      if (full === null) continue;
      const remaining = SCENE_LIMITS.maxSpectorTotalShaderChars - charTotal;
      if (remaining <= 0) {
        shadersTruncated = true;
        break;
      }
      let source = full;
      let truncated = shader.truncated === true;
      if (source.length > SCENE_LIMITS.maxSpectorShaderChars) {
        source = source.slice(0, SCENE_LIMITS.maxSpectorShaderChars);
        truncated = true;
      }
      if (source.length > remaining) {
        source = source.slice(0, remaining);
        truncated = true;
        shadersTruncated = true;
      }
      charTotal += source.length;
      shaderTotal += 1;
      shaders.push({
        type: textOf(shader.type, SCENE_LIMITS.maxSpectorNameChars) ?? "unknown",
        source,
        length: Math.max(source.length, lengthOf(shader.length, source.length)),
        truncated,
      });
    }
    if (shaders.length === 0) continue;
    const status = row.programStatus;
    programs.push({
      programStatus: {
        LINK_STATUS: boolOf(status?.LINK_STATUS),
        VALIDATE_STATUS: boolOf(status?.VALIDATE_STATUS),
        infoLog: textOf(status?.infoLog, SCENE_LIMITS.maxSpectorInfoLogChars),
      },
      shaders,
    });
  }

  const analyses = (Array.isArray(raw.analyses) ? raw.analyses : [])
    .slice(0, SCENE_LIMITS.maxSpectorAnalyses)
    .map((row) => {
      const values: Record<string, boolean | number | string> = {};
      const rawValues = row && typeof row === "object" ? row.values : null;
      if (rawValues && typeof rawValues === "object") {
        for (const rawKey of Object.keys(rawValues).slice(0, SCENE_LIMITS.maxSpectorAnalysisKeys)) {
          const key = rawKey.slice(0, SCENE_LIMITS.maxSpectorNameChars);
          if (!key) continue;
          const value = (rawValues as any)[rawKey];
          if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
            values[key] = value;
          } else if (typeof value === "string") {
            values[key] = value.slice(0, 200);
          }
        }
      }
      return { name: textOf(row?.name, SCENE_LIMITS.maxSpectorNameChars) ?? "analysis", values };
    });

  const attributes: Record<string, boolean | number | string | null> = {};
  const rawAttributes = raw.context?.attributes;
  if (rawAttributes && typeof rawAttributes === "object") {
    for (const rawKey of Object.keys(rawAttributes).slice(0, SCENE_LIMITS.maxSpectorAttributes)) {
      const key = rawKey.slice(0, SCENE_LIMITS.maxSpectorNameChars);
      if (!key) continue;
      const value = (rawAttributes as any)[rawKey];
      if (typeof value === "boolean") attributes[key] = value;
      else if (typeof value === "number" && Number.isFinite(value)) attributes[key] = value;
      else if (typeof value === "string") attributes[key] = value.slice(0, SCENE_LIMITS.maxSpectorNameChars);
    }
  }

  return {
    id: "spector-adapter-v1",
    available: true,
    reason:
      "Captured one WebGL frame with the experimental spector adapter; only command names and counts, context attributes, analyses and capped shader source were transferred, never command arguments, state, results, stack traces or memory.",
    version,
    canvas: raw.canvas
      ? { width: numOf(raw.canvas.width), height: numOf(raw.canvas.height) }
      : null,
    context: raw.context ? { version: numOf(raw.context.version, 10), attributes } : null,
    commands: {
      total: numOf(raw.commands?.total),
      drawCalls: numOf(raw.commands?.drawCalls),
      byName,
      statuses,
    },
    programs,
    analyses,
    limits: {
      ...spectorLimits(),
      programsTruncated,
      shadersTruncated,
    },
  };
}

async function probeSpector(
  page: any,
  canvasSelector: string,
  timeoutMs: number,
  version: string | null,
): Promise<SceneSpectorEvidence> {
  if (typeof page?.evaluate !== "function") {
    return unavailableSpector("The page could not be evaluated for a spector capture.", version);
  }
  const caps = spectorProbeCaps(canvasSelector, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.resolve()
    .then(() => page.evaluate(SCENE_SPECTOR_PROBE, caps))
    .catch((err: unknown) => ({ error: redactSceneError(messageOf(err)) }));
  // The in-page probe owns its own timer; this outer race only covers a page
  // that never resolves the evaluate at all.
  const timeout = new Promise<{ error: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ error: "the in-page spector capture exceeded its time budget" }),
      timeoutMs + 1_000,
    );
    timer.unref?.();
  });
  let raw: any;
  try {
    raw = await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!raw || typeof raw !== "object" || "error" in raw) {
    const message = boundedText(raw?.error, SCENE_LIMITS.maxSpectorReasonChars) ?? "unknown error";
    return unavailableSpector(
      `The spector adapter could not capture a frame: ${redactSceneError(message)}`,
      version,
    );
  }
  return spectorFromProbe(raw as SceneSpectorProbeSummary, version);
}

function unavailableThree(reason: string): SceneThreeEvidence {
  return {
    id: "three-adapter-v1",
    available: false,
    reason: reason.slice(0, SCENE_LIMITS.maxThreeUrlChars),
    revision: null,
    scene: null,
    camera: null,
    cameras: [],
    lights: [],
    controls: null,
    coverage: { scene: false, geometry: false, camera: false, controls: false, lights: false, materials: false },
  };
}

/** Trusted-side canonical URL: resolve, drop credentials/query/hash, bound. */
function canonicalSceneUrl(raw: unknown, base: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw, base);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  const href = parsed.href;
  return href ? href.slice(0, SCENE_LIMITS.maxThreeUrlChars) : null;
}

/** Rebuilds the probe result with only known fields and the documented caps. */
function threeFromProbe(raw: SceneThreeProbeResult, documentUrl: string): SceneThreeEvidence {
  const countOf = (value: unknown): number => {
    const n = typeof value === "number" ? value : NaN;
    return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 1_000_000) : 0;
  };
  const finiteOrNull = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const tuple = (value: unknown, size: number): number[] | null => {
    if (!Array.isArray(value) || value.length !== size) return null;
    const out: number[] = [];
    for (let i = 0; i < size; i++) {
      const n = finiteOrNull(value[i]);
      if (n === null) return null;
      out.push(n);
    }
    return out;
  };
  const colorOf = (value: unknown): string | null =>
    typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;

  const cameraOf = (value: any): SceneThreeCamera | null => {
    if (!value || typeof value !== "object") return null;
    const matrix = tuple(value.matrixWorld, 16);
    return {
      type: boundedText(value.type, SCENE_LIMITS.maxThreeTypeChars) ?? "unknown",
      fov: finiteOrNull(value.fov),
      near: finiteOrNull(value.near),
      far: finiteOrNull(value.far),
      matrixWorld: matrix,
    };
  };
  const lightOf = (value: any): SceneThreeLight => ({
    type: boundedText(value?.type, SCENE_LIMITS.maxThreeTypeChars) ?? "unknown",
    color: colorOf(value?.color),
    intensity: finiteOrNull(value?.intensity),
    distance: finiteOrNull(value?.distance),
  });
  const geometryOf = (value: any): SceneThreeGeometry | null => {
    if (!value || typeof value !== "object") return null;
    const attributes = (Array.isArray(value.attributes) ? value.attributes : [])
      .slice(0, SCENE_LIMITS.maxThreeAttributes)
      .map((row: any) => ({
        name: boundedText(row?.name, SCENE_LIMITS.maxThreeTypeChars) ?? "",
        count: countOf(row?.count),
      }));
    let bounds: { min: [number, number, number]; max: [number, number, number] } | null = null;
    const min = tuple(value.bounds?.min, 3);
    const max = tuple(value.bounds?.max, 3);
    if (min && max) {
      bounds = { min: min as [number, number, number], max: max as [number, number, number] };
    }
    const parameters: Record<string, number> = {};
    if (value.parameters && typeof value.parameters === "object") {
      for (const key of THREE_GEOMETRY_PARAMETER_KEYS) {
        const n = finiteOrNull(value.parameters[key]);
        if (n !== null) parameters[key] = Math.max(-1_000_000, Math.min(1_000_000, n));
      }
    }
    return {
      type: boundedText(value.type, SCENE_LIMITS.maxThreeTypeChars) ?? "unknown",
      attributes,
      indexCount: finiteOrNull(value.indexCount),
      bounds,
      parameters: Object.keys(parameters).length > 0 ? parameters : null,
    };
  };

  // Budgets are re-applied here too: a hostile or hand-edited probe payload
  // cannot exceed them even if it skipped the in-page checks.
  let materialSlots = SCENE_LIMITS.maxThreeMaterials;
  let textureSlots = SCENE_LIMITS.maxThreeTextures;
  const textureSeen = new Set<string>();
  const materialOf = (value: any): SceneThreeMaterial | null => {
    if (!value || typeof value !== "object") return null;
    if (materialSlots <= 0) return null;
    materialSlots -= 1;
    const rawMap = value.map;
    const rawUrl =
      typeof rawMap === "string" ? rawMap : rawMap && typeof rawMap === "object" ? rawMap.url : null;
    const mapUrl = canonicalSceneUrl(rawUrl, documentUrl);
    let map: SceneThreeMaterial["map"] = null;
    if (mapUrl) {
      if (textureSeen.has(mapUrl)) {
        map = { url: mapUrl, assetId: null };
      } else if (textureSlots > 0) {
        textureSeen.add(mapUrl);
        textureSlots -= 1;
        map = { url: mapUrl, assetId: null };
      }
    }
    return {
      type: boundedText(value.type, SCENE_LIMITS.maxThreeTypeChars) ?? "unknown",
      color: colorOf(value.color),
      opacity: finiteOrNull(value.opacity),
      transparent: value.transparent === true,
      metalness: finiteOrNull(value.metalness),
      roughness: finiteOrNull(value.roughness),
      side: finiteOrNull(value.side),
      map,
    };
  };

  const rawNodes = raw.scene?.nodes.slice(0, SCENE_LIMITS.maxThreeNodes) ?? [];
  const rawCameras = (Array.isArray(raw.cameras) ? raw.cameras : [])
    .slice(0, SCENE_LIMITS.maxThreeCameras)
    .map(cameraOf)
    .filter((row): row is SceneThreeCamera => row !== null);
  const lights = (Array.isArray(raw.lights) ? raw.lights : [])
    .slice(0, SCENE_LIMITS.maxThreeLights)
    .map(lightOf);
  const cameras = rawCameras;
  const topCamera = cameras.length > 0 ? cameras[0]! : cameraOf(raw.camera);

  let cameraSlots = Math.max(
    0,
    SCENE_LIMITS.maxThreeCameras - cameras.length - (cameras.length === 0 && topCamera ? 1 : 0),
  );
  let lightSlots = Math.max(0, SCENE_LIMITS.maxThreeLights - lights.length);

  const cleanNodes: SceneThreeNode[] = [];
  for (const node of rawNodes) {
    if (!node || typeof node !== "object") continue;
    const rawMaterial = node.material;
    const materialList = Array.isArray(rawMaterial)
      ? rawMaterial
          .slice(0, 8)
          .map(materialOf)
          .filter((row): row is SceneThreeMaterial => row !== null)
      : null;
    // A camera/light record inside a node consumes the same budget as the
    // top-level arrays: at most the cap exists anywhere in the payload.
    const nodeCamera =
      node.camera && typeof node.camera === "object" && cameraSlots > 0
        ? (cameraSlots--, cameraOf(node.camera))
        : null;
    const nodeLight =
      node.light && typeof node.light === "object" && lightSlots > 0
        ? (lightSlots--, lightOf(node.light))
        : null;
    cleanNodes.push({
      type:
        node.type === "mesh" ||
        node.type === "light" ||
        node.type === "camera" ||
        node.type === "scene" ||
        node.type === "group"
          ? node.type
          : "object",
      name: boundedText(node.name, SCENE_LIMITS.maxThreeNameChars),
      uuid: boundedText(node.uuid, SCENE_LIMITS.maxThreeUuidChars),
      visible: node.visible !== false,
      position: tuple(node.position, 3) as [number, number, number] | null,
      quaternion: tuple(node.quaternion, 4) as [number, number, number, number] | null,
      scale: tuple(node.scale, 3) as [number, number, number] | null,
      childCount: countOf(node.childCount),
      geometry: geometryOf(node.geometry),
      material: materialList ?? materialOf(rawMaterial),
      camera: nodeCamera,
      light: nodeLight,
    });
  }

  const scene = raw.scene
    ? {
        nodes: cleanNodes,
        truncated: raw.scene.truncated === true,
        total: Math.max(cleanNodes.length, countOf(raw.scene.total)),
      }
    : null;
  const controlsTarget = tuple(raw.controls?.target, 3);
  const controls =
    raw.controls && typeof raw.controls === "object" && controlsTarget
      ? {
          type: boundedText(raw.controls.type, SCENE_LIMITS.maxThreeTypeChars) ?? "controls",
          target: controlsTarget as [number, number, number],
        }
      : null;

  const coverage: SceneAdapterCoverage = {
    scene: scene !== null && cleanNodes.length > 0,
    geometry: cleanNodes.some((node) => node.geometry !== null),
    camera: topCamera !== null,
    controls: controls !== null,
    lights: lights.length > 0,
    materials: cleanNodes.some((node) =>
      Array.isArray(node.material) ? node.material.length > 0 : node.material !== null,
    ),
  };

  return {
    id: "three-adapter-v1",
    available: raw.available === true,
    reason: boundedText(raw.reason, SCENE_LIMITS.maxThreeUrlChars) ?? "the three adapter returned no reason",
    revision: boundedText(raw.revision, SCENE_LIMITS.maxVersionChars),
    scene,
    camera: topCamera,
    cameras,
    lights,
    controls,
    coverage,
  };
}

/** Links a material map URL to the inventory row it came from. */
function linkThreeAssets(three: SceneThreeEvidence, resources: SceneResource[]): void {
  const byUrl = new Map<string, string>();
  for (const resource of resources) {
    if (!byUrl.has(resource.url)) byUrl.set(resource.url, resource.assetId);
  }
  const link = (value: SceneThreeMaterial | null): void => {
    if (value?.map) value.map.assetId = byUrl.get(value.map.url) ?? null;
  };
  for (const node of three.scene?.nodes ?? []) {
    if (Array.isArray(node.material)) node.material.forEach(link);
    else link(node.material);
  }
}

async function probeThreeScene(page: any, documentUrl: string): Promise<SceneThreeEvidence> {
  if (typeof page?.evaluate !== "function") {
    return unavailableThree("The page could not be evaluated for three objects.");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.resolve()
    .then(() => page.evaluate(SCENE_THREE_PROBE, THREE_PROBE_CAPS))
    .catch((err: unknown) => ({ error: redactSceneError(messageOf(err)) }));
  const timeout = new Promise<{ error: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ error: "the in-page three probe exceeded its time budget" }),
      SCENE_LIMITS.threeProbeTimeoutMs,
    );
    timer.unref?.();
  });
  let raw: any;
  try {
    raw = await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!raw || typeof raw !== "object" || "error" in raw) {
    return unavailableThree(
      `The three adapter could not read the page: ${boundedText(raw?.error, SCENE_LIMITS.maxThreeUrlChars) ?? "unknown error"}`,
    );
  }
  return threeFromProbe(raw as SceneThreeProbeResult, documentUrl);
}

// ---- orchestration -------------------------------------------------------

const settle = async (page: any, ms: number): Promise<void> => {
  if (ms <= 0) return;
  if (typeof page?.waitForTimeout === "function") {
    await page.waitForTimeout(ms);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message.replace(/\s+/g, " ").trim() : String(err);

const defaultSceneDir = (): string =>
  join(process.env.AWWWARDS_CACHE_DIR ?? join(homedir(), ".awwwards-mcp"), "scene-captures");

// Playwright viewport screenshots clip in viewport coordinates, and
// getBoundingClientRect already returns viewport coordinates: clip the rect but
// never translate it by scroll offsets.
export function sceneCanvasClip(
  rect: SceneRect,
  viewport: { width: number; height: number },
): SceneRect | null {
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(viewport.width, rect.x + rect.width);
  const bottom = Math.min(viewport.height, rect.y + rect.height);
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const PAD = (n: number): string => String(n).padStart(2, "0");

function boundedText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : String(value);
  if (!text) return null;
  return text.slice(0, max);
}

/** Redacts query, hash and credentials from URLs that survive in an error. */
export function redactSceneError(message: string): string {
  return message.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/gi, (match) =>
    redactSceneUrl(match),
  );
}

/** Decides, at observation time, whether this response may ever be fetched. */
export function sceneDownloadTarget(raw: string): SceneResourceDownload {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { status: "skipped", reason: "the observed URL could not be parsed" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { status: "skipped", reason: "the observed URL is not http(s)" };
  }
  if (parsed.username || parsed.password) {
    return { status: "skipped", reason: "the observed URL carried credentials" };
  }
  if (parsed.search) {
    return { status: "skipped", reason: "the observed URL has a query string, which is never persisted" };
  }
  if (parsed.hash) {
    return { status: "skipped", reason: "the observed URL has a fragment" };
  }
  const target = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  if (target.length > SCENE_LIMITS.maxResourceUrlChars) {
    // A truncated URL would fetch a different resource than the one observed.
    return {
      status: "skipped",
      reason: `the observed URL is longer than ${SCENE_LIMITS.maxResourceUrlChars} characters`,
    };
  }
  return { status: "available", url: target };
}

function classifyResponse(
  response: any,
  headers: Record<string, string>,
  assetOrigins: string[],
): Omit<SceneResource, "assetId"> | null {
  let parsed: URL;
  try {
    parsed = new URL(String(response.url()));
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const mime = String(headers["content-type"] ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase()
    .slice(0, SCENE_LIMITS.maxMimeChars);
  const declared = Number(headers["content-length"]);
  const url = redactSceneUrl(parsed.href).slice(0, SCENE_LIMITS.maxResourceUrlChars);
  const origin = parsed.origin.slice(0, SCENE_LIMITS.maxResourceUrlChars);
  let resourceType = "other";
  try {
    resourceType = String(response.request?.()?.resourceType?.() ?? "other").slice(
      0,
      SCENE_LIMITS.maxResourceTypeChars,
    );
  } catch {
    resourceType = "other";
  }
  return {
    url,
    origin,
    mime,
    bytes: Number.isFinite(declared) && declared >= 0 ? declared : null,
    resourceType,
    classification: classifySceneResource(mime, parsed.href),
    discovery: "response",
    assetOrigin: assetOrigins.includes(origin),
    download: sceneDownloadTarget(parsed.href),
  };
}

function capabilityLimitations(
  blocked: { count: number },
  resourcesTruncated: boolean,
  budgetHit: boolean,
  adapters: SceneAdapterName[],
): string[] {
  const wantThree = adapters.includes("three");
  const wantSpector = adapters.includes("spector");
  const limitations = [
    wantThree
      ? "Scene graph, camera, controls and geometry evidence comes only from the experimental, opt-in three adapter reading objects reachable from a few window properties; the heap was not crawled."
      : wantSpector
        ? "No scene graph, camera state, controls or geometry was read; frames show rendered output only."
        : "Passive evidence only: no scene graph, camera state, controls, shader source or geometry is recovered; frames show rendered output.",
    "No asset bodies are downloaded during capture; a later download_assets request may fetch inventory assets whose observed URL has no query string, fragment or credentials, and every other asset is marked not downloadable with a reason.",
    "Service workers are blocked, so requests they would serve never appear in the resource list.",
    "The private-address gate is a loopback proxy installed before any page exists: every HTTP(S) connection, including redirect hops and popup requests, is validated before it is dialed and dialed at the resolved address. It does not cover Chromium's own non-page traffic.",
    "Resource and blocked-request URLs are redacted to origin+pathname: query, hash and credentials are removed, and page-derived strings are length-capped.",
    "Screenshot sizes are bounded per frame and in total; oversized frames fail the capture instead of being truncated.",
  ];
  if (blocked.count > 0) {
    limitations.push(
      `${blocked.count} request${blocked.count === 1 ? "" : "s"} were blocked as private, reserved or non-http(s).`,
    );
  }
  if (resourcesTruncated) {
    limitations.push(
      budgetHit
        ? `The ${SCENE_LIMITS.maxMetadataBytes / (1024 * 1024)} MiB resource-metadata budget was reached; later responses were counted but not recorded.`
        : `Only the first ${SCENE_LIMITS.maxResources} responses were collected; the rest were counted but not recorded.`,
    );
  }
  return limitations;
}

export async function captureScene3d(
  url: string,
  opts: SceneCaptureOptions = {},
): Promise<SceneEvidence | { error: string }> {
  const startedAt = Date.now();
  const timeoutMs = Math.min(opts.timeoutMs ?? SCENE_LIMITS.timeoutMs, SCENE_LIMITS.timeoutMs);
  const deadline = startedAt + timeoutMs;
  const resolveHost = opts.resolveHost ?? defaultSceneResolveHost;

  if (!isHttpUrl(url)) {
    return { error: "Scene capture accepts http:// and https:// URLs only." };
  }
  const adapters = normalizeSceneAdapters(opts.adapters);
  if ("error" in adapters) return adapters;
  const wantThree = adapters.adapters.includes("three");
  const wantSpector = adapters.adapters.includes("spector");
  // The optional bundle is read from disk, never fetched over the network, and
  // only when the adapter is requested. A missing package degrades the adapter.
  let spectorBundle: SpectorBundle | null = null;
  if (wantSpector) {
    try {
      spectorBundle = await (opts.spectorBundleLoader ?? loadSpectorBundle)();
    } catch {
      spectorBundle = null;
    }
  }
  const allowedOrigins = normalizeScenePrivateOrigins(opts.allowPrivateOrigins);
  if ("error" in allowedOrigins) return allowedOrigins;
  const gate = createSceneUrlGate(resolveHost, allowedOrigins.origins);

  let browser: any;
  let context: any;
  let proxy: SceneProxy | undefined;
  let tmpDir: string | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  // Closing must never hang the caller: each resource gets a bounded grace,
  // and an expired deadline still returns while the closes settle.
  const closeWithinGrace = async (target: { close(): unknown } | undefined): Promise<void> => {
    if (!target) return;
    await Promise.race([
      Promise.resolve()
        .then(() => target.close())
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_GRACE_MS);
        timer.unref?.();
      }),
    ]);
  };

  // Every resource is owned from the instant it exists. release() is repeatable
  // and clears only what it takes, so a resource that arrives after the race
  // (late launch, late context, late proxy) is still closed by the next call.
  const owned = new Set<{ close(): unknown }>();
  const own = <T extends { close(): unknown } | undefined>(target: T): T => {
    if (target) owned.add(target);
    return target;
  };
  const release = async (): Promise<void> => {
    const pending = [...owned].reverse();
    owned.clear();
    for (const target of pending) await closeWithinGrace(target);
    if (tmpDir) {
      const dir = tmpDir;
      tmpDir = undefined;
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        /* best effort on Windows locks */
      }
    }
  };
  // The watchdog may win while an acquisition await is still in flight.
  const ensureLive = async (): Promise<void> => {
    if (!cancelled) return;
    await release();
    throw new Error("capture cancelled after the deadline");
  };

  const acquire = async (): Promise<SceneEvidence | { error: string }> => {
    const allowed = await gate.allows(url);
    await ensureLive();
    if (!allowed) {
      return {
        error:
          `Refusing to capture ${redactSceneUrl(url)}: the host resolves to a loopback, link-local, ` +
          "private, metadata or reserved address, or the URL is not http(s).",
      };
    }
    const normalized = normalizeSceneCheckpoints(opts.checkpoints);
    if ("error" in normalized) return normalized;
    const checkpoints = normalized.checkpoints;
    const assetOrigins = normalizeSceneAssetOrigins(opts.assetOrigins);
    if ("error" in assetOrigins) return assetOrigins;
    const assetOriginList = assetOrigins.origins;

    let chromium: any;
    try {
      const loader = opts.loader ?? (() => import("playwright" as string));
      ({ chromium } = await loader());
    } catch {
      return { error: CAPTURE_INSTALL_HINT };
    }
    await ensureLive();
    try {
      proxy = own(await startSceneProxy(gate));
    } catch {
      return { error: "Scene capture failed: could not start the local network guard." };
    }
    await ensureLive();
    try {
      // The proxy is set on the browser, before any context or page exists.
      // `<-loopback>` removes Chromium's implicit loopback proxy bypass.
      browser = own(
        await chromium.launch({
          proxy: { server: proxy.url, bypass: "<-loopback>" },
        }),
      );
    } catch {
      return { error: CAPTURE_INSTALL_HINT };
    }
    await ensureLive();

    try {
      const { width, height, ...contextOpts } = resolveViewport(opts.viewport ?? "desktop");
      // Blocking service workers keeps the response census deterministic; the
      // trade-off is recorded in limitations.
      context = own(
        await browser.newContext({
          viewport: { width, height },
          ...contextOpts,
          serviceWorkers: "block",
        }),
      );
      await ensureLive();

      // Defense in depth only: Chromium routing missed redirect hops in the
      // regression, so the proxy above is the enforcement claim.
      if (typeof context.route === "function") {
        await context.route("**/*", async (route: any) => {
          let allowed = false;
          try {
            const target = typeof route?.request === "function" ? String(route.request().url()) : "";
            allowed = await gate.allows(target);
          } catch {
            allowed = false;
          }
          try {
            if (allowed) await route.continue();
            else await route.abort("blockedbyclient");
          } catch {
            /* request already gone */
          }
        });
        await ensureLive();
      }

      // The first page is the capture page; every popup is closed immediately
      // and its connection is still gated by the proxy.
      let primaryPage: any = null;
      if (typeof context.on === "function") {
        context.on("page", (opened: any) => {
          if (primaryPage === null) {
            primaryPage = opened;
            return;
          }
          try {
            void Promise.resolve(opened.close?.()).catch(() => undefined);
          } catch {
            /* page already closed */
          }
        });
      }
      const page = own(await context.newPage());
      await ensureLive();
      primaryPage = page;
      // The probe calls named helpers; tsx/esbuild keepNames injects __name
      // references that must exist in the page before navigation.
      if (wantThree || wantSpector) await installSnippetShims(page);
      await ensureLive();
      // The bundle must be installed before goto so its WebGL spies exist
      // before the page creates a context; nothing is fetched over the network.
      if (wantSpector && spectorBundle) {
        await page.addInitScript(spectorInitScript(spectorBundle.source));
        await ensureLive();
      }
      if (typeof page.setDefaultTimeout === "function") {
        page.setDefaultTimeout(Math.min(15_000, Math.max(1, timeoutMs)));
      }

      const pendingResources: Promise<Omit<SceneResource, "assetId"> | null>[] = [];
      let resourceTotal = 0;
      if (typeof page.on === "function") {
        page.on("response", (response: any) => {
          resourceTotal += 1;
          if (resourceTotal > SCENE_LIMITS.maxResources) return;
          pendingResources.push(
            (async () => {
              let headers: Record<string, string> = {};
              try {
                headers = (await response.headers?.()) ?? {};
              } catch {
                headers = {};
              }
              return classifyResponse(response, headers, assetOriginList);
            })().catch(() => null),
          );
        });
      }

      await page.goto(url, {
        waitUntil: "load",
        timeout: Math.max(1, Math.min(45_000, deadline - Date.now())),
      });
      await ensureLive();
      await settle(page, Math.min(1_500, Math.max(0, deadline - Date.now())));
      await ensureLive();

      const picked = (await page.evaluate(SCENE_CANVAS_PICK, {
        selector: opts.canvasSelector ?? "",
        // Generated outside the page: page content cannot pre-set or guess it.
        marker: randomUUID(),
      })) as {
        canvases?: number;
        selector?: string;
        problem?: string;
      };
      await ensureLive();
      const pickProblem = picked?.problem ?? "";
      if (pickProblem || !picked?.selector) {
        const label = opts.canvasSelector
          ? `canvasSelector ${JSON.stringify(opts.canvasSelector)}`
          : "the page";
        const detail =
          pickProblem === "invalid-selector"
            ? "is not a valid CSS selector."
            : pickProblem === "selector-not-canvas"
              ? "matched an element that is not a <canvas>."
              : pickProblem === "selector-not-found"
                ? "matched no element."
                : pickProblem === "marker-not-unique"
                  ? "could not be tagged uniquely for capture; refusing to guess which canvas was chosen."
                  : "has no visible <canvas>.";
        return { error: `Scene capture failed: ${label} ${detail}` };
      }
      const usedSelector = String(picked.selector);
      const canvases = Number(picked.canvases) || 0;

      const scrollRoot = opts.scrollRoot;
      if (scrollRoot) {
        const probe = (await page.evaluate(SCENE_PROBE, {
          canvasSelector: usedSelector,
          scrollRoot,
        })) as { scrollRootFound?: boolean };
        await ensureLive();
        if (!probe?.scrollRootFound) {
          return {
            error: `Scene capture failed: scrollRoot ${JSON.stringify(scrollRoot)} matched no element.`,
          };
        }
      }

      const hints = (await page.evaluate(SCENE_HINTS, {})) as {
        threeRevision?: string | null;
        babylonVersion?: string | null;
        playcanvasVersion?: string | null;
        scripts?: string[];
        canvasCount?: number;
      };
      await ensureLive();
      const threeVersion = boundedText(hints?.threeRevision, SCENE_LIMITS.maxVersionChars);
      const babylonVersion = boundedText(hints?.babylonVersion, SCENE_LIMITS.maxVersionChars);
      const playcanvasVersion = boundedText(hints?.playcanvasVersion, SCENE_LIMITS.maxVersionChars);
      const scripts = (Array.isArray(hints?.scripts) ? hints.scripts : [])
        .slice(0, 20)
        .map((value) => boundedText(value, SCENE_LIMITS.maxScriptChars))
        .filter((value): value is string => value !== null && isHttpUrl(value))
        .map(redactSceneUrl)
        .slice(0, 20);
      const scriptHits = (re: RegExp): string[] => scripts.filter((s) => re.test(s));
      const frameworkHints: SceneFrameworkHints = {
        three: {
          detected: threeVersion !== null || scriptHits(/three/i).length > 0,
          version: threeVersion,
          scripts: scriptHits(/three/i),
        },
        babylon: {
          detected: babylonVersion !== null || scriptHits(/babylon/i).length > 0,
          version: babylonVersion,
          scripts: scriptHits(/babylon/i),
        },
        playcanvas: {
          detected: playcanvasVersion !== null || scriptHits(/playcanvas/i).length > 0,
          version: playcanvasVersion,
          scripts: scriptHits(/playcanvas/i),
        },
        canvasCount: Number(hints?.canvasCount) || canvases,
      };

      // Opt-in experimental adapter, after load and before any checkpoint.
      // A failed or timed-out probe never fails the capture: the pack records
      // the adapter as unavailable with a reason.
      const three = wantThree ? await probeThreeScene(page, url) : undefined;
      await ensureLive();
      let spector: SceneSpectorEvidence | undefined;
      if (wantSpector) {
        if (!spectorBundle) {
          spector = unavailableSpector(SPECTOR_INSTALL_HINT, null);
        } else {
          // Keep budget for the checkpoint frames: the probe may spend up to
          // 8s, its outer race adds 1s, and the checkpoint work needs the rest.
          const remaining = Math.max(0, deadline - Date.now() - 6_000);
          const probeTimeout = Math.min(SCENE_LIMITS.spectorProbeTimeoutMs, remaining);
          spector =
            probeTimeout < 250
              ? unavailableSpector(
                  "The capture had no time budget left for the spector probe.",
                  spectorBundle.version,
                )
              : await probeSpector(page, usedSelector, probeTimeout, spectorBundle.version);
          await ensureLive();
        }
      }

      const sceneDir = opts.sceneDir ?? defaultSceneDir();
      await mkdir(sceneDir, { recursive: true, mode: 0o700 });
      const captureId = `scene-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      const finalDir = join(sceneDir, captureId);
      tmpDir = await mkdtemp(join(sceneDir, ".tmp-"));
      await ensureLive();
      const stagingDir = tmpDir;
      const includeViewportShots = opts.includeViewportShots !== false;
      const imageBudget = { total: 0 };

      const writeImage = async (name: string, data: unknown): Promise<string> => {
        if (cancelled) throw new Error("capture cancelled after the deadline");
        const buf = Buffer.isBuffer(data)
          ? data
          : data instanceof Uint8Array
            ? Buffer.from(data)
            : null;
        if (!buf) throw new Error(`scene frame ${name} was not image bytes`);
        if (buf.length > SCENE_LIMITS.maxImageBytes) {
          throw new Error(
            `scene frame exceeded the ${SCENE_LIMITS.maxImageBytes / (1024 * 1024)} MiB per-image limit`,
          );
        }
        if (imageBudget.total + buf.length > SCENE_LIMITS.maxTotalImageBytes) {
          throw new Error(
            `scene frames exceeded the ${SCENE_LIMITS.maxTotalImageBytes / (1024 * 1024)} MiB total image limit`,
          );
        }
        imageBudget.total += buf.length;
        await writeFile(join(stagingDir, name), buf, { mode: 0o600 });
        // Frames are written to the temp dir and published by rename, so report
        // the final path rather than the temp one.
        return join(finalDir, name);
      };

      const frames: SceneCheckpointResult[] = [];
      for (let index = 0; index < checkpoints.length; index++) {
        if (cancelled || Date.now() > deadline) {
          throw new Error(
            `scene capture exceeded the ${Math.round(timeoutMs / 1000)}s budget after ${index} of ${checkpoints.length} checkpoints`,
          );
        }
        const checkpoint = checkpoints[index];
        const checkpointStart = Date.now();
        const before = (await page.evaluate(SCENE_PROBE, {
          canvasSelector: usedSelector,
          scrollRoot: scrollRoot ?? "",
        })) as { scroll?: { range?: number } | null };
        await ensureLive();
        const range = Math.max(0, Number(before?.scroll?.range) || 0);
        const requestedTop = Math.round(checkpoint.scrollRatio * range);
        const immediate = Number(
          await page.evaluate(SCENE_SCROLL, { scrollRoot: scrollRoot ?? "", top: requestedTop }),
        );
        await ensureLive();
        let actual = Number.isFinite(immediate) && immediate >= 0 ? immediate : 0;
        const arrivalDeadline = Math.min(deadline, Date.now() + 1_500);
        while (Math.abs(actual - requestedTop) > 1 && Date.now() < arrivalDeadline) {
          await settle(page, 50);
          actual =
            Number(await page.evaluate(SCENE_READ, { scrollRoot: scrollRoot ?? "" })) || 0;
          await ensureLive();
        }

        let pointerPx: { x: number; y: number } | null = null;
        if (checkpoint.pointer) {
          pointerPx = {
            x: Math.round(checkpoint.pointer.x * Math.max(0, width - 1)),
            y: Math.round(checkpoint.pointer.y * Math.max(0, height - 1)),
          };
          if (page.mouse && typeof page.mouse.move === "function") {
            await page.mouse.move(pointerPx.x, pointerPx.y);
            await ensureLive();
          }
        }

        const settleMs = Math.min(checkpoint.waitMs, Math.max(0, deadline - Date.now()));
        await settle(page, settleMs);
        await ensureLive();

        const after = (await page.evaluate(SCENE_PROBE, {
          canvasSelector: usedSelector,
          scrollRoot: scrollRoot ?? "",
        })) as {
          canvasFound?: boolean;
          rect?: SceneRect | null;
          backing?: { width: number; height: number } | null;
          dpr?: number;
          scroll?: { top?: number; range?: number } | null;
          scrollRootFound?: boolean;
        };
        await ensureLive();
        if (!after?.canvasFound || !after.rect) {
          throw new Error(
            `the selected canvas (${usedSelector}) disappeared at checkpoint ${index + 1}`,
          );
        }
        if (scrollRoot && !after.scrollRootFound) {
          throw new Error(`scrollRoot ${JSON.stringify(scrollRoot)} disappeared at checkpoint ${index + 1}`);
        }
        const clip = sceneCanvasClip(after.rect, { width, height });
        if (!clip) {
          throw new Error(
            `the selected canvas (${usedSelector}) is outside the viewport at checkpoint ${index + 1}; ` +
              "adjust scrollRoot or the checkpoint ratios",
          );
        }

        const stem = `frame-${PAD(index + 1)}`;
        const canvasShot = await page.screenshot({ clip });
        await ensureLive();
        const canvasFile = await writeImage(`${stem}-canvas.png`, canvasShot);
        let viewportFile: string | undefined;
        if (includeViewportShots) {
          const viewportShot = await page.screenshot({ fullPage: false });
          await ensureLive();
          viewportFile = await writeImage(`${stem}-viewport.png`, viewportShot);
        }
        const observedTop = Number(after?.scroll?.top);
        const observedRange = Number(after?.scroll?.range);
        const actualScrollTop = Number.isFinite(observedTop) ? Math.max(0, observedTop) : actual;
        // A screenshot is not atomic: re-probe after it and record whether the
        // frame still represents the measured checkpoint.
        let stable = true;
        let stabilityReason: string | undefined;
        try {
          const settled = (await page.evaluate(SCENE_PROBE, {
            canvasSelector: usedSelector,
            scrollRoot: scrollRoot ?? "",
          })) as {
            canvasFound?: boolean;
            rect?: SceneRect | null;
            backing?: { width: number; height: number } | null;
            dpr?: number;
            scroll?: { top?: number } | null;
            scrollRootFound?: boolean;
          };
          await ensureLive();
          const settledTop = Number(settled?.scroll?.top);
          const expectedRect = after.rect;
          const expectedBacking = after.backing ?? { width: 0, height: 0 };
          const expectedDpr = Number(after.dpr) || 0;
          if (!settled?.canvasFound || !settled.rect) {
            stable = false;
            stabilityReason = "the canvas disappeared while the frame was being captured";
          } else if (
            !Number.isFinite(settledTop) ||
            Math.abs(settledTop - actualScrollTop) > 2
          ) {
            stable = false;
            stabilityReason = `the page scroll moved during the screenshot (measured ${actualScrollTop}px, after ${Number.isFinite(settledTop) ? settledTop : "unknown"}px)`;
          } else if (
            settled.rect.x !== expectedRect.x ||
            settled.rect.y !== expectedRect.y ||
            settled.rect.width !== expectedRect.width ||
            settled.rect.height !== expectedRect.height ||
            Number(settled.dpr) !== expectedDpr ||
            Number(settled.backing?.width) !== expectedBacking.width ||
            Number(settled.backing?.height) !== expectedBacking.height
          ) {
            stable = false;
            stabilityReason = "the canvas geometry or device pixel ratio changed during the screenshot";
          }
        } catch (err) {
          stable = false;
          stabilityReason = `the page could not be re-probed after the screenshot (${redactSceneError(
            err instanceof Error ? err.message : String(err),
          )})`;
        }
        frames.push({
          index,
          requestedScrollRatio: checkpoint.scrollRatio,
          requestedScrollTop: requestedTop,
          // A finite zero is a real measurement; only absent/invalid values
          // fall back to the scroll call's return value.
          actualScrollTop,
          scrollRange: Number.isFinite(observedRange) ? Math.max(range, observedRange) : range,
          scrollRoot: scrollRoot ?? "window",
          // Capture throws when a custom root disappears, so reaching here proves it.
          scrollRootFound: true,
          pointer: checkpoint.pointer,
          pointerPx,
          waitMs: settleMs,
          elapsedMs: Date.now() - checkpointStart,
          canvas: {
            rect: after.rect,
            backing: after.backing ?? { width: 0, height: 0 },
            dpr: Number(after.dpr) || 0,
          },
          stable,
          ...(stabilityReason ? { stabilityReason } : {}),
          files: { canvas: canvasFile, ...(viewportFile ? { viewport: viewportFile } : {}) },
        });
      }

      const collected = (await Promise.all(pendingResources)).filter(
        (row): row is Omit<SceneResource, "assetId"> => row !== null,
      );
      // Retain rows only while they fit the shared metadata budget.
      const retained: SceneResource[] = [];
      let metadataBytes = 0;
      let budgetHit = false;
      for (const row of collected) {
        // Asset IDs follow the persisted order, so they always resolve against
        // this capture's own evidence.json inventory.
        const resource: SceneResource = {
          assetId: `asset-${retained.length + 1}`,
          ...row,
        };
        const size = Buffer.byteLength(JSON.stringify(resource), "utf8");
        if (metadataBytes + size > SCENE_LIMITS.maxMetadataBytes) {
          budgetHit = true;
          continue;
        }
        metadataBytes += size;
        retained.push(resource);
      }
      const resourcesTruncated = resourceTotal > SCENE_LIMITS.maxResources || budgetHit;
      if (three) linkThreeAssets(three, retained);
      const limitations = capabilityLimitations(gate.blocked, resourcesTruncated, budgetHit, adapters.adapters);
      if (wantThree) {
        limitations.push(
          three?.available
            ? "The experimental three adapter read only objects reachable from window.THREE, window.scene/camera/renderer and window.app/experience/viewer/world; the heap was not crawled, so absent nodes are not evidence of absence, and captured transforms are parent-relative without hierarchy."
            : `The experimental three adapter was requested but returned no readable scene: ${three?.reason ?? "the probe did not run"}`,
        );
      }
      if (spector) {
        limitations.push(
          spector.available
            ? "The experimental spector adapter captured one WebGL frame; only command names and counts, context attributes, analyses and capped shader source were kept. Command arguments, state, results, stack traces, memory and the raw capture were not transferred, and shader source is untrusted page text that is never executed."
            : `The experimental spector adapter was requested but could not capture a frame: ${spector.reason}`,
        );
      }
      const coverage: SceneCoverage = {
        ...coverageFrom({
          collected: frames.length,
          excluded: Math.max(0, resourceTotal - retained.length),
          limitations,
        }),
        capabilities: sceneCapabilityReasons(three, spector),
      };

      const evidence: SceneEvidence = {
        id: "scene-evidence-v1",
        // The page URL is redacted too: query strings can carry tokens.
        url: redactSceneUrl(url),
        captureId,
        capturedAt: startedAt,
        viewport: { name: opts.viewport ?? "desktop", width, height },
        canvas: {
          requestedSelector: opts.canvasSelector ?? null,
          usedSelector,
          canvases,
        },
        frameworkHints,
        checkpoints: frames,
        resources: retained,
        resourceTotal,
        resourcesTruncated,
        ...(three ? { three } : {}),
        ...(spector ? { spector } : {}),
        blockedRequests: { count: gate.blocked.count, samples: gate.blocked.samples },
        assetOrigins: assetOriginList,
        paths: { dir: finalDir, evidence: join(finalDir, "evidence.json"), framesDir: finalDir },
        coverage,
        limitations,
      };

      if (cancelled) throw new Error("capture cancelled after the deadline");
      const json = JSON.stringify(evidence, null, 1);
      if (Buffer.byteLength(json, "utf8") > SCENE_LIMITS.maxMetadataBytes) {
        throw new Error(
          `scene evidence metadata exceeded the ${SCENE_LIMITS.maxMetadataBytes / (1024 * 1024)} MiB limit`,
        );
      }
      await writeFile(join(stagingDir, "evidence.json"), json, { mode: 0o600 });
      // Publish only a complete pack: frames and metadata appear together.
      await rename(stagingDir, finalDir);
      tmpDir = undefined;
      return evidence;
    } catch (err) {
      return { error: `Scene capture failed: ${redactSceneError(messageOf(err))}` };
    }
  };

  const work = acquire().catch((err) => ({
    error: `Scene capture failed: ${redactSceneError(messageOf(err))}`,
  }));
  const timeout = new Promise<{ error: string }>((resolve) => {
    watchdog = setTimeout(() => {
      cancelled = true;
      resolve({ error: `Scene capture timed out after ${Math.round(timeoutMs / 1000)}s.` });
    }, timeoutMs);
    watchdog.unref?.();
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    cancelled = true;
    // Idempotent: an acquisition that is still in flight owns its late
    // resources and releases them on its next ensureLive() check.
    await release();
  }
}

// ---- compact MCP summary -------------------------------------------------

export interface SceneThreeSummary {
  id: SceneThreeEvidence["id"];
  available: boolean;
  reason: string;
  revision: string | null;
  scene: { nodes: number; truncated: boolean; total: number } | null;
  camera: SceneThreeCamera | null;
  cameras: number;
  lights: number;
  controls: SceneThreeControls | null;
  coverage: SceneAdapterCoverage;
}

/** Compact spector result: shader source stays in evidence.json only. */
export type SceneSpectorSummary = Omit<SceneSpectorEvidence, "programs"> & {
  programs: Array<{
    programStatus: SceneSpectorProgramStatus;
    shaders: Array<Omit<SceneSpectorShader, "source">>;
  }>;
};

export interface SceneEvidenceSummary {
  id: SceneEvidence["id"];
  url: string;
  captureId: string;
  capturedAt: number;
  viewport: SceneEvidence["viewport"];
  canvas: SceneEvidence["canvas"];
  frameworkHints: SceneFrameworkHints;
  checkpoints: Array<
    Pick<
      SceneCheckpointResult,
      | "index"
      | "requestedScrollRatio"
      | "requestedScrollTop"
      | "actualScrollTop"
      | "scrollRange"
      | "scrollRoot"
      | "pointer"
      | "waitMs"
      | "elapsedMs"
      | "files"
    > & { canvas: SceneCheckpointResult["canvas"] }
  >;
  resources: {
    total: number;
    collected: number;
    truncated: boolean;
    byClassification: Record<SceneResourceClass, number>;
    origins: Array<{ origin: string; count: number }>;
    /** Inventory handles for download_assets; only `downloadable` will fetch. */
    assetIds: string[];
    downloadable: string[];
  };
  /** Compact adapter result; full nodes stay in evidence.json. */
  three: SceneThreeSummary | null;
  /** Compact spector result; shader source stays in evidence.json. */
  spector: SceneSpectorSummary | null;
  blockedRequests: SceneEvidence["blockedRequests"];
  assetOrigins: string[];
  paths: SceneEvidence["paths"];
  coverage: SceneCoverage;
  limitations: string[];
}

/** Drops the full resource rows (they live in evidence.json) and keeps counts. */
export function summarizeSceneEvidence(evidence: SceneEvidence): SceneEvidenceSummary {
  const byClassification: Record<SceneResourceClass, number> = {
    texture: 0,
    model: 0,
    hdr: 0,
    shader: 0,
    script: 0,
    font: 0,
    image: 0,
    other: 0,
  };
  const originCounts = new Map<string, number>();
  for (const resource of evidence.resources) {
    byClassification[resource.classification] += 1;
    originCounts.set(resource.origin, (originCounts.get(resource.origin) ?? 0) + 1);
  }
  const origins = [...originCounts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([origin, count]) => ({ origin, count }));

  return {
    id: evidence.id,
    url: evidence.url,
    captureId: evidence.captureId,
    capturedAt: evidence.capturedAt,
    viewport: evidence.viewport,
    canvas: evidence.canvas,
    frameworkHints: evidence.frameworkHints,
    checkpoints: evidence.checkpoints.map((frame) => ({
      index: frame.index,
      requestedScrollRatio: frame.requestedScrollRatio,
      requestedScrollTop: frame.requestedScrollTop,
      actualScrollTop: frame.actualScrollTop,
      scrollRange: frame.scrollRange,
      scrollRoot: frame.scrollRoot,
      pointer: frame.pointer,
      waitMs: frame.waitMs,
      elapsedMs: frame.elapsedMs,
      files: frame.files,
      canvas: frame.canvas,
    })),
    resources: {
      total: evidence.resourceTotal,
      collected: evidence.resources.length,
      truncated: evidence.resourcesTruncated,
      byClassification,
      origins,
      assetIds: evidence.resources.map((resource) => resource.assetId),
      downloadable: evidence.resources
        .filter((resource) => resource.download?.status === "available")
        .map((resource) => resource.assetId),
    },
    three: evidence.three
      ? {
          id: evidence.three.id,
          available: evidence.three.available,
          reason: evidence.three.reason,
          revision: evidence.three.revision,
          scene: evidence.three.scene
            ? {
                nodes: evidence.three.scene.nodes.length,
                truncated: evidence.three.scene.truncated,
                total: evidence.three.scene.total,
              }
            : null,
          camera: evidence.three.camera,
          cameras: evidence.three.cameras.length,
          lights: evidence.three.lights.length,
          controls: evidence.three.controls,
          coverage: evidence.three.coverage,
        }
      : null,
    spector: evidence.spector
      ? {
          ...evidence.spector,
          programs: evidence.spector.programs.map((program) => ({
            programStatus: program.programStatus,
            shaders: program.shaders.map(({ type, length, truncated }) => ({
              type,
              length,
              truncated,
            })),
          })),
        }
      : null,
    blockedRequests: evidence.blockedRequests,
    assetOrigins: evidence.assetOrigins,
    paths: evidence.paths,
    coverage: evidence.coverage,
    limitations: evidence.limitations,
  };
}
