/**
 * Live runtime performance measurement through raw CDP — zero dependencies.
 * Launches an installed headless Chrome/Edge, injects an in-page collector
 * (frame sampling, long tasks / long animation frames, measured layout
 * thrashing, measure-before-composite, scroll-listener registrations) and
 * returns what static analysis cannot see.
 *
 * Ported from aegon-mcp (MIT) — A:\Motion (src/cdp.ts + src/live.ts, merged).
 * Adaptations from the aegon originals:
 * - {error} contract: nothing throws; every failure path resolves
 *   `{ error: string }`, and the spawned browser is always cleaned up (aegon
 *   leaked the child when the post-launch CDP connect failed).
 * - URL measurement needed a functional change: aegon only ever ran its own
 *   harness files, where a buildUrl has no collector — measureRuntime now
 *   registers the collector via `Page.addScriptToEvaluateOnNewDocument`
 *   before navigation (aegon's Page.enable/navigate/readiness flow kept).
 * - DI knobs for offline tests (defaults = aegon's real behavior):
 *   `spawnFn` / `fetchFn` / `connectFn` / `findBrowserFn`; `findBrowser`
 *   takes a `{ platform, env, exists }` struct instead of touching the
 *   real filesystem.
 * - No DOM lib in the house tsconfig: the Node >= 22 global WebSocket is
 *   reached via globalThis with a minimal structural type.
 * - Field renames (aegon → here), documented once: avgFps → fps,
 *   badFrames → droppedFrames, longTasks → longTaskCount,
 *   loaf → longAnimationFrameCount, loafMaxBlockingMs →
 *   longAnimationFrameMaxBlockingMs, thrashEvents → layoutThrashCount,
 *   layoutReadsInRaf → measureBeforeCompositeCount. Added: chromePath
 *   (the executable actually used; when degraded there is no measurement
 *   object at all — the {error} reason carries it instead).
 * - The in-page COLLECTOR is byte-identical to aegon's, including its
 *   __AEGON_* window globals (its instrumentation subtleties must not drift).
 * - seconds defaults to aegon's 4 and is clamped to (0.05 .. 10] per plan.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { ViewportName } from "./viewport.js";

/** Fields renamed from aegon's collector output — see the header mapping. */
export interface PerfMeasurement {
  seconds: number;
  frames: number;
  /** aegon avgFps */
  fps: number;
  /** aegon badFrames — frame deltas past 32ms */
  droppedFrames: number;
  worstFrameMs: number;
  /** aegon longTasks */
  longTaskCount: number;
  longTaskMaxMs: number;
  /** aegon loaf */
  longAnimationFrameCount: number;
  /** aegon loafMaxBlockingMs */
  longAnimationFrameMaxBlockingMs: number;
  /** aegon thrashEvents — measured layout-read-after-style-write interleaves (tier F evidence) */
  layoutThrashCount: number;
  /** aegon layoutReadsInRaf — measured reads inside animation frames (tier B evidence) */
  measureBeforeCompositeCount: number;
  layoutReads: number;
  styleWrites: number;
  scrollListeners: Array<{ type: string; passive: boolean }>;
  animationsAtEnd: number;
  /** Executable used for the capture (AEGON_BROWSER override wins). */
  chromePath: string;
}

export interface PerfChild {
  stderr: { on(event: "data", cb: (chunk: unknown) => void): void } | null;
  on(event: "exit" | "error", cb: (err?: Error) => void): void;
  kill(): void;
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { stdio: ["ignore", "ignore", "pipe"] },
) => PerfChild;

export type FetchFn = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ json(): Promise<unknown> }>;

/** One CDP wire response for a command: a result envelope or an exception. */
export interface CdpResult {
  result?: { value?: unknown };
  exceptionDetails?: { exception?: { description?: string }; text?: string };
}

/** Minimal CDP surface measureRuntime needs — spoofed wholesale in tests. */
export interface CdpLike {
  send(method: string, params?: Record<string, unknown>): Promise<CdpResult>;
  evaluate(expression: string): Promise<unknown>;
  close(): void;
}

interface WsLike {
  addEventListener(type: string, cb: (ev: unknown) => void, opts?: { once?: boolean }): void;
  send(data: string): void;
  close(): void;
}

/** Minimal Chrome/Edge/Chromium discovery, or null. Env override: AEGON_BROWSER. */
export interface FindBrowserDeps {
  platform?: string;
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
}

export function findBrowser(deps: FindBrowserDeps = {}): string | null {
  const platform = deps.platform ?? process.platform;
  const env: Record<string, string | undefined> = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  if (env.AEGON_BROWSER && exists(env.AEGON_BROWSER)) {
    return env.AEGON_BROWSER;
  }
  const cands: Array<string | null> = [];
  if (platform === "win32") {
    const pf = env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const lad = env["LocalAppData"] ?? "";
    cands.push(
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      lad ? `${lad}\\Google\\Chrome\\Application\\chrome.exe` : null,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    );
  } else if (platform === "darwin") {
    cands.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    cands.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
    );
  }
  for (const c of cands) {
    if (c && exists(c)) return c;
  }
  return null;
}

const CDP_OPEN_TIMEOUT_MS = 5_000;
const CDP_COMMAND_TIMEOUT_MS = 10_000;

/** Race work against a deadline; aborting the signal lets the transport clean up. */
async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error(message));
    }, ms);
  });
  try {
    return await Promise.race([work(ac.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

interface PendingCommand {
  resolve: (v: CdpResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One CDP connection over a WebSocket. Messages are plain JSON; command
 * results resolve, protocol errors and page exceptions reject. The socket
 * open and every command are deadline-bounded so a dead browser degrades
 * instead of hanging the measurement forever.
 */
export class Cdp implements CdpLike {
  private ws: WsLike;
  private nextId = 1;
  private pending = new Map<number, PendingCommand>();
  private commandTimeoutMs: number;

  static async connect(
    wsUrl: string,
    openTimeoutMs = CDP_OPEN_TIMEOUT_MS,
    commandTimeoutMs = CDP_COMMAND_TIMEOUT_MS,
  ): Promise<Cdp> {
    // Node >= 22 ships a global WebSocket; the house tsconfig has no DOM lib.
    const WS = (globalThis as { WebSocket?: new (url: string) => WsLike }).WebSocket;
    if (!WS) throw new Error("global WebSocket unavailable — Node >= 22 required");
    const ws = new WS(wsUrl);
    try {
      await withTimeout(
        () =>
          new Promise<void>((resolve, reject) => {
            ws.addEventListener("open", () => resolve(), { once: true });
            ws.addEventListener("error", () => reject(new Error("CDP websocket failed")), {
              once: true,
            });
          }),
        openTimeoutMs,
        `CDP websocket open timed out after ${openTimeoutMs}ms`,
      );
    } catch (err) {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      throw err;
    }
    return new Cdp(ws, commandTimeoutMs);
  }

  private constructor(ws: WsLike, commandTimeoutMs: number) {
    this.ws = ws;
    this.commandTimeoutMs = commandTimeoutMs;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String((ev as { data: unknown }).data)) as {
        id?: number;
        error?: { message: string; code: number };
        result?: CdpResult;
      };
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`${msg.error.message} (CDP ${msg.error.code})`));
        else p.resolve(msg.result ?? {});
      }
    });
    // A transport failure must reject in-flight commands now, not at their
    // individual deadlines.
    ws.addEventListener("close", () => this.failPending(new Error("CDP websocket closed")));
    ws.addEventListener("error", () => this.failPending(new Error("CDP websocket failed")));
  }

  private failPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(err);
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${this.commandTimeoutMs}ms`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { timer, resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Evaluate an expression in the page, returning its value. */
  async evaluate(expression: string): Promise<unknown> {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(d.exception?.description ?? d.text ?? "page evaluation failed");
    }
    return res.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const DEFAULT_SECONDS = 4;
const MAX_SECONDS = 10;
const MIN_SECONDS = 0.05;

/** Plan constraint: aegon's small default (4s), never above 10s. */
export function clampSeconds(seconds?: number): number {
  const n = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : DEFAULT_SECONDS;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, n));
}

const WIDTH = 1280;
const HEIGHT = 800;
// Mobile profile mirrors viewport.ts's 390x844 phone class; desktop keeps the
// aegon harness geometry above so existing measurements stay comparable.
const MOBILE_WIDTH = 390;
const MOBILE_HEIGHT = 844;

/**
 * In-page collector — byte-identical to aegon's (A:\Motion\src\live.ts). It
 * instruments addEventListener, getBoundingClientRect, the offset/client
 * dimension getters, getComputedStyle reads, setProperty + element.style
 * writes (via a Proxy), runs its own rAF frame sampler, and observes
 * longtask + long-animation-frame. It parks results on `window.__AEGON_LIVE__` once the
 * deadline passed; do not rename or reformat the internals — see header.
 */
export const COLLECTOR = String.raw`
(() => {
  const R = window.__AEGON_RAW__ = {
    frameCount: 0, badFrames: 0, worstFrameMs: 0, deltaSum: 0,
    longTasks: 0, longTaskMaxMs: 0, loaf: 0, loafMaxBlockingMs: 0,
    layoutReads: 0, layoutReadsInRaf: 0, styleWrites: 0, thrashEvents: 0,
    scrollListeners: [], inRaf: false, lastOpInRaf: null,
  };
  const SECONDS = window.__AEGON_SECONDS__ || 4;

  // scroll/wheel/touchmove registrations (runtime confirmation)
  const origAEL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (["scroll", "wheel", "touchmove"].includes(type)) {
      R.scrollListeners.push({ type, passive: opts === true ? false : Boolean(opts && opts.passive) });
    }
    return origAEL.call(this, type, fn, opts);
  };

  // layout reads
  const bumpRead = () => { R.layoutReads++; if (R.inRaf) { R.layoutReadsInRaf++;
    if (R.lastOpInRaf === "write") R.thrashEvents++; R.lastOpInRaf = "read"; } };
  const elProto = Element.prototype;
  const origGBCR = elProto.getBoundingClientRect;
  elProto.getBoundingClientRect = function (...a) { bumpRead(); return origGBCR.apply(this, a); };
  for (const k of ["offsetWidth","offsetHeight","offsetTop","offsetLeft","clientWidth","clientHeight"]) {
    const d = Object.getOwnPropertyDescriptor(elProto, k);
    if (d && d.get) Object.defineProperty(elProto, k, { ...d, get() { bumpRead(); return d.get.call(this); } });
  }
  const origGCS = window.getComputedStyle;
  window.getComputedStyle = function (...a) { bumpRead(); return origGCS.apply(window, a); };

  // style writes: direct .style.<prop> assignment goes through Blink's named-property
  // interceptor (no prototype accessor to patch), so wrap the element.style getter
  // in a proxy whose set trap tags writes. setProperty stays patched normally.
  const dProto = CSSStyleDeclaration.prototype;
  const origSP = dProto.setProperty;
  dProto.setProperty = function (...a) { R.styleWrites++; if (R.inRaf) R.lastOpInRaf = "write"; return origSP.apply(this, a); };
  const styleProxies = new WeakMap();
  for (const proto of [HTMLElement.prototype, SVGElement.prototype, MathMLElement?.prototype]) {
    if (!proto) continue;
    const d = Object.getOwnPropertyDescriptor(proto, "style");
    if (!d || !d.get) continue;
    Object.defineProperty(proto, "style", {
      ...d,
      get() {
        const decl = d.get.call(this);
        if (!styleProxies.has(decl)) {
          styleProxies.set(decl, new Proxy(decl, {
            set(t, p, v) { R.styleWrites++; if (R.inRaf) R.lastOpInRaf = "write"; return Reflect.set(t, p, v, t); },
            get(t, p) { const v = Reflect.get(t, p, t); return typeof v === "function" ? v.bind(t) : v; },
          }));
        }
        return styleProxies.get(decl);
      },
    });
  }

  // frame sampling: ONE chain drives the timeline (its own rAF chain), the
  // exported window.requestAnimationFrame only tags reads/writes with rAF context.
  const origRAF = window.requestAnimationFrame;
  window.requestAnimationFrame = (cb) => origRAF.call(window, (t) => {
    R.inRaf = true; R.lastOpInRaf = null;
    try { cb(t); } finally { R.inRaf = false; }
  });
  let pumpPrev = 0;
  const pump = () => {
    if (performance.now() >= window.__AEGON_DEADLINE__) { R.done = true; return; }
    origRAF.call(window, () => {
      const now = performance.now();
      if (pumpPrev) {
        const d = now - pumpPrev;
        R.frameCount++; R.deltaSum += d;
        if (d > R.worstFrameMs) R.worstFrameMs = d;
        if (d > 32) R.badFrames++;
      }
      pumpPrev = now;
      origRAF.call(window, pump);
    });
  };
  window.__AEGON_DEADLINE__ = performance.now() + SECONDS * 1000;
  pump();

  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { R.longTasks++; R.longTaskMaxMs = Math.max(R.longTaskMaxMs, e.duration); } }).observe({ type: "longtask", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { R.loaf++; R.loafMaxBlockingMs = Math.max(R.loafMaxBlockingMs, e.blockingDuration || 0); } }).observe({ type: "long-animation-frame", buffered: true });
  } catch {}

  const finish = () => {
    if (R.done && !window.__AEGON_LIVE__) {
      window.__AEGON_LIVE__ = {
        seconds: SECONDS,
        frames: R.frameCount,
        badFrames: R.badFrames,
        worstFrameMs: Math.round(R.worstFrameMs),
        avgFps: R.frameCount > 1 ? Math.round((R.frameCount - 1) / (R.deltaSum / 1000)) : 0,
        longTasks: R.longTasks,
        longTaskMaxMs: Math.round(R.longTaskMaxMs),
        loaf: R.loaf,
        loafMaxBlockingMs: Math.round(R.loafMaxBlockingMs),
        layoutReads: R.layoutReads,
        layoutReadsInRaf: R.layoutReadsInRaf,
        styleWrites: R.styleWrites,
        thrashEvents: R.thrashEvents,
        scrollListeners: R.scrollListeners,
        animationsAtEnd: document.getAnimations ? document.getAnimations().length : -1,
      };
    }
  };
  const iv = setInterval(finish, 200);
})();
`;

/** Wait for the headless browser to announce its debugging port on stderr. */
function waitDevtoolsPort(proc: PerfChild, timeoutMs = 15_000): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () => settle(() => reject(new Error(`Browser did not open a DevTools port in ${timeoutMs / 1000}s`))),
      timeoutMs,
    );
    if (!proc.stderr) {
      settle(() => reject(new Error("Browser spawned without a stderr stream")));
      return;
    }
    proc.stderr.on("data", (d) => {
      buf += String(d);
      const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) settle(() => resolve(Number(m[1])));
    });
    // Missing executable / EACCES arrives as an async 'error' event. Without a
    // listener Node throws it as an uncaught exception and the process dies.
    proc.on("error", (err) =>
      settle(() =>
        reject(err instanceof Error ? err : new Error("Browser failed to start")),
      ),
    );
    proc.on("exit", () => settle(() => reject(new Error("Browser exited before the DevTools port opened"))));
  });
}

const defaultSpawn: SpawnFn = (cmd, args, opts) => spawn(cmd, args, opts);
const defaultFetch: FetchFn = (url, init) => fetch(url, init);

export interface MeasureRuntimeOpts {
  /** Capture window in seconds, clamped to (0.05 .. 10]. Default: 4. */
  seconds?: number;
  /** Measurement viewport: desktop keeps aegon's 1280x800; mobile uses 390x844. */
  viewport?: ViewportName;
  spawnFn?: SpawnFn;
  fetchFn?: FetchFn;
  connectFn?: (wsUrl: string) => Promise<CdpLike>;
  findBrowserFn?: () => string | null;
  /** CDP /json/list fetch and websocket-open deadline (ms). Default 5000; min 10. */
  cdpTimeoutMs?: number;
  /** Route every page connection through this loopback guard proxy. */
  proxyServer?: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Collector output (aegon names) → PerfMeasurement (renamed, guarded). */
function toMeasurement(raw: object, chromePath: string): PerfMeasurement {
  const r = raw as Record<string, unknown>;
  const listeners = Array.isArray(r.scrollListeners) ? r.scrollListeners : [];
  return {
    seconds: num(r.seconds),
    frames: num(r.frames),
    fps: num(r.avgFps),
    droppedFrames: num(r.badFrames),
    worstFrameMs: num(r.worstFrameMs),
    longTaskCount: num(r.longTasks),
    longTaskMaxMs: num(r.longTaskMaxMs),
    longAnimationFrameCount: num(r.loaf),
    longAnimationFrameMaxBlockingMs: num(r.loafMaxBlockingMs),
    layoutThrashCount: num(r.thrashEvents),
    measureBeforeCompositeCount: num(r.layoutReadsInRaf),
    layoutReads: num(r.layoutReads),
    styleWrites: num(r.styleWrites),
    scrollListeners: listeners.flatMap((l) => {
      if (!l || typeof l !== "object" || typeof (l as { type?: unknown }).type !== "string") return [];
      const o = l as { type: string; passive?: unknown };
      return [{ type: o.type, passive: Boolean(o.passive) }];
    }),
    animationsAtEnd: num(r.animationsAtEnd),
    chromePath,
  };
}

/**
 * Measure a live URL in a headless Chrome/Edge over raw CDP (zero deps).
 * Aegon's defaults; every failure degrades to `{ error: string }` — callers
 * surface the note and never fail because of measurement.
 */
export async function measureRuntime(
  url: string,
  opts: MeasureRuntimeOpts = {},
): Promise<PerfMeasurement | { error: string }> {
  const seconds = clampSeconds(opts.seconds);
  const mobile = opts.viewport === "mobile";
  const width = mobile ? MOBILE_WIDTH : WIDTH;
  const height = mobile ? MOBILE_HEIGHT : HEIGHT;
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const cdpTimeoutMs = Math.max(10, opts.cdpTimeoutMs ?? CDP_OPEN_TIMEOUT_MS);
  const connectFn =
    opts.connectFn ?? ((wsUrl: string) => Cdp.connect(wsUrl, cdpTimeoutMs));
  const findBrowserFn = opts.findBrowserFn ?? (() => findBrowser());
  let proc: PerfChild | null = null;
  let cdp: CdpLike | null = null;
  try {
    const chromePath = findBrowserFn();
    if (!chromePath) {
      return { error: "No Chrome or Edge found. Install Chrome or set AEGON_BROWSER to the executable path." };
    }
    proc = spawnFn(
      chromePath,
      [
        "--headless",
        "--disable-gpu",
        "--no-first-run",
        "--disable-extensions",
        `--window-size=${width},${height}`,
        "--remote-debugging-port=0",
        ...(opts.proxyServer
          ? [
              `--proxy-server=${opts.proxyServer}`,
              // Chromium bypasses proxies for loopback by default; the scene
              // guard's `<-loopback>` rule removes that bypass.
              "--proxy-bypass-list=<-loopback>",
            ]
          : []),
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const wsPort = await waitDevtoolsPort(proc);
    // The raw /json/list fetch is bounded too: a browser that opens a port but
    // never answers must not hang the measurement.
    const list = (await withTimeout(
      async (signal) =>
        (await fetchFn(`http://127.0.0.1:${wsPort}/json/list`, { signal })).json(),
      cdpTimeoutMs,
      `CDP target list timed out after ${cdpTimeoutMs}ms`,
    )) as Array<{
      type: string;
      webSocketDebuggerUrl: string;
    }>;
    const target = list.find((t) => t.type === "page");
    if (!target) return { error: "Browser opened with no page target" };
    cdp = await connectFn(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
    });
    // collector must exist before page scripts run — foreign buildUrl pages
    // get it at document-start (aegon only measured its own harness files)
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__AEGON_SECONDS__=${seconds};${COLLECTOR}`,
    });
    await cdp.send("Page.navigate", { url });
    for (let i = 0; i < 100; i++) {
      if ((await cdp.evaluate("document.readyState")) === "complete") break;
      await sleep(100);
    }
    await sleep(seconds * 1000 + 600); // wall-clock capture while the collector samples
    const raw = await cdp.evaluate("window.__AEGON_LIVE__");
    if (!raw || typeof raw !== "object") {
      return { error: "Live collector never reported — the page navigated away or crashed before capture ended." };
    }
    return toMeasurement(raw, chromePath);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      cdp?.close();
    } catch {
      /* already gone */
    }
    try {
      // Direct child kill only (no shell): Node maps this to TerminateProcess
      // on Windows and SIGTERM on POSIX, and a dead child returns false rather
      // than throwing, so cleanup can never mask the real result.
      proc?.kill();
    } catch {
      /* already gone */
    }
  }
}
