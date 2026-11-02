// Disposable v2 adoption probe. Direct MCP stdio client (no SDK dependency:
// the project ships @modelcontextprotocol/server/core, not a client package),
// local fixtures only, no Awwwards crawling.
//
//   node scripts/v2-eval.mjs [--out <json>] [--cache <dir>] [--only id,id] [--allow-egress]
//
// Evidence only: exits 0 when the harness completed, regardless of tool verdicts.
// Refuses to start without a seeded cache (an empty DB would launch a live index
// crawl) and preloads a no-egress guard into the server child.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = process.env.V2_EVAL_CLI ?? join(ROOT, "dist", "cli.js");
const FIXTURES = join(ROOT, "scripts", "fixtures", "v2-eval");
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const SOURCE_CACHE = resolve(
  arg("--cache", process.env.AWWWARDS_CACHE_DIR ?? join(homedir(), ".awwwards-mcp")),
);
const OUT = resolve(arg("--out", join(ROOT, ".opencode", "sdd", "2026-11-01-ci-maintenance", "v2-eval-direct.json")));
const ONLY = arg("--only", "") ? new Set(arg("--only", "").split(",")) : null;
const CALL_TIMEOUT_MS = Number(arg("--timeout", "180000"));
const NO_EGRESS = !argv.includes("--allow-egress");

// --- cache: copy the selected seed into a unique disposable directory ------
if (!existsSync(CLI)) {
  console.error(`missing ${CLI}; run npm run build first`);
  process.exit(2);
}
const CACHE = mkdtempSync(join(tmpdir(), "awwwards-v2-eval-cache-"));
process.on("exit", () => {
  try {
    rmSync(CACHE, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
mkdirSync(CACHE, { recursive: true });
const seededCache = join(CACHE, "cache.db");
const sourceDb = join(SOURCE_CACHE, "cache.db");
if (!existsSync(sourceDb)) {
  console.error(
    "refusing to run: no cache.db to seed from.\n" +
      "An empty cache makes the server start a live index crawl at boot.\n" +
      `Looked for ${sourceDb}. Seed one or pass --cache <dir>.`,
  );
  process.exit(2);
}
copyFileSync(sourceDb, seededCache);
console.error(`seeded disposable cache from ${sourceDb}`);
// Daily startup probes are stderr-only but would launch a browser / hit npm.
for (const name of ["env-check.json", "version-check.json"]) {
  const from = join(SOURCE_CACHE, name);
  if (!existsSync(join(CACHE, name)) && existsSync(from)) copyFileSync(from, join(CACHE, name));
  if (!existsSync(join(CACHE, name))) writeFileSync(join(CACHE, name), JSON.stringify({ checkedAt: Date.now() }));
}
// A fresh lock makes shouldAutoIndex false even when index:status is absent or
// stale; sealing this is what guarantees the probe can never crawl.
try {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(seededCache);
  const row = db.prepare("select value from meta where key='index:status'").get();
  const status = row ? JSON.parse(row.value) : null;
  const stale =
    !status?.finishedAt ||
    Date.now() - Number(status.finishedAt) >= 7 * 24 * 60 * 60 * 1000;
  if (stale) {
    db.prepare("insert or replace into meta (key, value) values ('index:lock', ?)").run(
      JSON.stringify({ startedAt: Date.now() }),
    );
    console.error("seeded index:lock (index missing or stale); auto-index disabled for this run");
  }
  db.close();
} catch (err) {
  console.error(`refusing to run: cannot verify the index lock in ${seededCache}: ${err.message}`);
  process.exit(2);
}

// --- static fixture server on loopback only --------------------------------
const TYPES = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".css": "text/css", ".js": "text/javascript" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
  const rel = normalize(path === "/" ? "/reference.html" : path).replace(/^([/\\])+/, "");
  const file = join(FIXTURES, rel);
  if (!file.startsWith(FIXTURES) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const BASE = `http://127.0.0.1:${server.address().port}`;
if (argv.includes("--serve")) {
  console.log(BASE);
  await new Promise(() => {});
}

// --- tiny MCP stdio client --------------------------------------------------
class Mcp {
  constructor() {
    const args = NO_EGRESS
      ? ["--require", join(ROOT, "scripts", "v2-eval-no-egress.cjs"), CLI]
      : [CLI];
    this.child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, AWWWARDS_MCP_PROFILE: "v2", AWWWARDS_CACHE_DIR: CACHE },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.next = 0;
    this.pending = new Map();
    this.stderr = [];
    this.buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) this.stderr.push(line.trim());
      if (this.stderr.length > 500) this.stderr.splice(0, this.stderr.length - 500);
    });
  }
  #onData(chunk) {
    this.buffer += chunk;
    for (let i; (i = this.buffer.indexOf("\n")) >= 0; ) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.stderr.push(`non-JSON stdout: ${line.slice(0, 200)}`);
        continue;
      }
      const entry = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (entry) {
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      }
    }
  }
  request(method, params, timeoutMs = 30000) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
  }
  async init() {
    const res = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "v2-eval", version: "0" },
    });
    this.notify("notifications/initialized");
    return res;
  }
  stop() {
    this.child.stdin.end();
    this.child.kill();
  }
}

const bytesOf = (result) =>
  (result?.content ?? []).reduce(
    (n, block) => n + Buffer.byteLength(block.text ?? block.data ?? "", "utf8"),
    0,
  );
const compositionOf = (result) => {
  let textBytes = 0;
  let imageBytes = 0;
  let dataUrls = 0;
  for (const block of result?.content ?? []) {
    if (block.type === "image") imageBytes += Buffer.byteLength(block.data ?? "", "utf8");
    else {
      const text = block.text ?? "";
      textBytes += Buffer.byteLength(text, "utf8");
      dataUrls += (text.match(/data:image\//g) ?? []).length;
    }
  }
  return { textBytes, imageBytes, dataUrls };
};
const textOf = (result) => (result?.content ?? []).map((b) => b.text ?? "").join("\n");
const headline = (result) => {
  const text = textOf(result);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return text.slice(0, 160).replace(/\s+/g, " ");
  }
  if (Array.isArray(data)) return `array(${data.length})`;
  const arrays = Object.entries(data)
    .filter(([, v]) => Array.isArray(v))
    .map(([k, v]) => `${k}:${v.length}`);
  const verdict = data.verdict ? ` verdict=${data.verdict}` : "";
  const err = data.error ? ` error=${String(data.error).slice(0, 100)}` : "";
  const scalars = ["animCount", "hoverRuleCount", "sampleCount", "overall", "motionScore"]
    .filter((k) => typeof data[k] === "number" || typeof data[k] === "string")
    .map((k) => `${k}=${data[k]}`);
  return `keys=${Object.keys(data).slice(0, 8).join(",")}${verdict}${err} ${arrays.join(" ")} ${scalars.join(" ")}`.trim();
};

// --- fixtures for offline builders -----------------------------------------
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
const poseGrid = {
  id: "pose-grid-v1",
  url: `${BASE}/reference.html`,
  capturedAt: 0,
  steps: 3,
  canvasSelector: "#scene",
  canvasW: 800,
  canvasH: 600,
  viewport: { width: 1440, height: 900 },
  snapshots: [0, 0.5, 1].map((ratio, i) => ({
    step: i,
    scrollY: i * 400,
    scrollRatio: ratio,
    frames: [{ label: "canvas", dataUrlPng: `data:image/png;base64,${PNG}` }],
  })),
};
const census = {
  url: `${BASE}/reference.html`,
  capturedAt: 0,
  counts: { "gsap-scrolltrigger": 2, "css-scroll-timeline": 0, "css-view-timeline": 1, "data-attr": 0, "css-keyframe": 1, smil: 0, unknown: 0 },
  anims: [
    { selector: ".reveal", tag: "h2", props: ["opacity", "transform"], durationMs: 0, delayMs: 0, easing: "linear", trigger: "css-view-timeline", scrub: true, pin: false, svgStroke: false },
    { selector: ".drift", tag: "p", props: ["transform"], durationMs: 3000, delayMs: 0, easing: "ease-in-out", trigger: "css-keyframe", scrub: false, pin: false, svgStroke: false },
  ],
  svgStrokes: [],
  nativeScrollTimelines: 1,
  gsapTriggers: [],
  gsapRegistryCount: 0,
  reducedMotion: false,
};
const bands = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "v1.13", "structure-desktop.json"), "utf8"));

// --- case matrix ------------------------------------------------------------
// Every valid case is a first call built from the published schema only.
const cases = [
  { id: "index-status", tool: "get_index", args: { request: { kind: "status" } }, expect: "status" },
  { id: "index-stats", tool: "get_index", args: { request: { kind: "stats", top: 5, windowDays: 90 } }, expect: "stats" },
  { id: "build-pose", tool: "build_motion", args: { request: { kind: "pose_stub", poseGrid } }, expect: "pose_stub" },
  { id: "build-gsap", tool: "build_motion", args: { request: { kind: "gsap_stub", scrollCensus: census } }, expect: "gsap_stub" },
  { id: "build-manifest", tool: "build_motion", args: { request: { kind: "manifest", bands, scrollCensus: census } }, expect: "manifest" },
  { id: "find-sites", tool: "search_references", args: { request: { kind: "sites", query: "portfolio", count: 3 } }, expect: "sites (cache)" },
  { id: "find-sites-compact", tool: "search_references", args: { request: { kind: "sites", query: "portfolio", count: 3, responseMode: "compact" } }, expect: "sites compact (size contrast)" },
  { id: "find-motion", tool: "search_references", args: { request: { kind: "motion", limit: 2 } }, expect: "cached motion corpus (adjacent to analyze_motion dna)" },
  { id: "ref-details", tool: "get_reference", args: { request: { kind: "site_details", slug: "lusion", compact: true } }, expect: "site_details (cached)" },
  { id: "ref-elements", tool: "get_reference", args: { request: { kind: "site_elements", slug: "lusion" } }, expect: "site_elements (cached)" },
  { id: "inspect-structure", tool: "inspect_page", args: { request: { kind: "structure", url: `${BASE}/reference.html`, maxBands: 12 } }, expect: "structure" },
  { id: "inspect-tokens", tool: "inspect_page", args: { request: { kind: "tokens", url: `${BASE}/reference.html`, include: ["colors", "typography"] } }, expect: "tokens" },
  { id: "motion-scroll", tool: "analyze_motion", args: { request: { kind: "scroll", url: `${BASE}/reference.html`, compact: true } }, expect: "scroll" },
  { id: "motion-hover", tool: "analyze_motion", args: { request: { kind: "hover", url: `${BASE}/reference.html`, compact: true } }, expect: "hover" },
  { id: "motion-hover-full", tool: "analyze_motion", args: { request: { kind: "hover", url: `${BASE}/reference.html` } }, expect: "hover (non-compact selector check)" },
  { id: "motion-dna", tool: "analyze_motion", args: { request: { kind: "dna", url: `${BASE}/reference.html`, recapture: true } }, expect: "dna (live, adjacent to scroll)" },
  { id: "capture-shot", tool: "capture_page", args: { request: { kind: "screenshot", url: `${BASE}/reference.html`, inline: false } }, expect: "screenshot" },
  { id: "capture-component", tool: "capture_page", args: { request: { kind: "component", url: `${BASE}/reference.html`, selector: "header", compact: true } }, expect: "component" },
  { id: "audit-images", tool: "audit_page", args: { request: { kind: "images", url: `${BASE}/reference.html` } }, expect: "images" },
  { id: "audit-perf", tool: "audit_page", args: { request: { kind: "performance", url: `${BASE}/reference.html`, timeoutMs: 10000, compact: true } }, expect: "performance (CDP)" },
  { id: "verify-build", tool: "verify_build", args: { buildUrl: `${BASE}/build.html`, referenceUrl: `${BASE}/reference.html`, compact: true }, expect: "verify_build" },
  { id: "verify-flow", tool: "verify_flow", args: { buildUrl: `${BASE}/build.html`, referenceUrl: `${BASE}/reference.html`, steps: [{ action: "scroll", y: 600 }, { action: "wait", ms: 300 }] }, expect: "verify_flow (adjacent to verify_build)" },
  { id: "har", tool: "analyze_network_capture", args: { path: join(ROOT, "test", "fixtures", "har", "valid.har") }, expect: "network capture" },
  { id: "watches", tool: "monitor_awards", args: { request: { action: "list_watches" } }, expect: "list_watches" },
  { id: "annual-categories", tool: "browse_awards", args: { request: { kind: "annual_categories" } }, expect: "annual categories (cached)" },
  { id: "award-filters", tool: "browse_awards", args: { request: { kind: "filters" } }, expect: "filters (cached)" },
  { id: "design-brief", tool: "create_design_brief", args: { slugs: ["lusion", "neutomni"], goal: "portfolio for a type foundry" }, expect: "brief (retained, cached details)" },
  { id: "build-project", tool: "build_project", args: { htmlPath: join(FIXTURES, "build.html"), target: "vite", out: join(tmpdir(), "awwwards-v2-eval-project"), name: "v2-eval-build" }, expect: "vite scaffold (retained, temp out)" },
];

// Deliberate malformed envelopes: measure the exact rejection text a model sees.
const invalid = [
  { id: "bad-flat-envelope", tool: "inspect_page", args: { url: `${BASE}/reference.html` }, why: "flat args instead of {request}" },
  { id: "bad-cross-branch", tool: "search_references", args: { request: { kind: "sites", lib: "gsap" } }, why: "sites branch with motion-only field" },
  { id: "bad-discriminator", tool: "analyze_motion", args: { request: { kind: "motion_dna", url: `${BASE}/reference.html` } }, why: "1.x name used as kind" },
  { id: "bad-missing-required", tool: "build_motion", args: { request: { kind: "manifest", bands } }, why: "manifest without scrollCensus" },
  { id: "bad-extra-top-level", tool: "get_index", args: { request: { kind: "status" }, extra: true }, why: "extra top-level key" },
  { id: "bad-retained-envelope", tool: "verify_build", args: { request: { buildUrl: `${BASE}/build.html`, referenceUrl: `${BASE}/reference.html` } }, why: "retained tool wrapped in the consolidated request envelope" },
  { id: "bad-monitor-action", tool: "monitor_awards", args: { request: { kind: "list_watches" } }, why: "kind used where monitor_awards keys on action" },
  { id: "bad-dna-compact", tool: "analyze_motion", args: { request: { kind: "dna", url: `${BASE}/reference.html`, compact: true } }, why: "scroll-branch field on dna" },
  { id: "bad-annual-nominee-empty", tool: "browse_awards", args: { request: { kind: "annual_nominee" } }, why: "schema allows no id/category+slug (runtime gap)" },
  { id: "bad-manifest-bands", tool: "build_motion", args: { request: { kind: "manifest", bands: {}, scrollCensus: census } }, why: "bands accepted as any then rejected at runtime" },
];

const shouldRun = (id) => !ONLY || ONLY.has(id);
const mcp = new Mcp();
const report = { startedAt: new Date().toISOString(), cli: CLI, base: BASE, cache: CACHE, init: null, tools: null, cases: [], invalid: [], stderr: [], egress: { guard: NO_EGRESS, blocked: [] } };

try {
  const initStarted = performance.now();
  const init = await mcp.init();
  report.initMs = Math.round(performance.now() - initStarted);
  report.init = {
    ok: !init.error,
    protocolVersion: init.result?.protocolVersion,
    server: init.result?.serverInfo,
    instructionsBytes: Buffer.byteLength(init.result?.instructions ?? "", "utf8"),
    error: init.error,
  };
  const list = await mcp.request("tools/list", {});
  const tools = list.result?.tools ?? [];
  report.tools = {
    count: tools.length,
    names: tools.map((t) => t.name),
    schemaBytes: Buffer.byteLength(JSON.stringify(tools), "utf8"),
  };
  console.error(`v2 tools: ${tools.length} (${report.tools.schemaBytes} bytes of schema)`);

  for (const c of cases.filter((c) => shouldRun(c.id))) {
    const stderrBefore = mcp.stderr.length;
    const started = performance.now();
    let msg;
    let transportError = null;
    try {
      msg = await mcp.request("tools/call", { name: c.tool, arguments: c.args }, CALL_TIMEOUT_MS);
    } catch (err) {
      transportError = err.message;
    }
    const latencyMs = Math.round(performance.now() - started);
    const result = msg?.result;
    const callError = msg?.error;
    const entry = {
      id: c.id,
      tool: c.tool,
      branch: c.expect,
      arguments: c.args,
      firstCallSchemaValid: !callError && !transportError && result?.isError !== true,
      validationError: callError ? `${callError.code}: ${callError.message}` : null,
      transportError,
      isError: result?.isError === true,
      errorText: result?.isError ? textOf(result).slice(0, 600) : null,
      latencyMs,
      bytes: bytesOf(result),
      composition: result ? compositionOf(result) : null,
      headline: result ? headline(result) : null,
      preview: result ? textOf(result).slice(0, 400) : null,
      text: result && bytesOf(result) < 20000 ? textOf(result) : null,
      stderr: mcp.stderr.slice(stderrBefore).slice(-4),
    };
    report.cases.push(entry);
    console.error(
      `${entry.firstCallSchemaValid ? "PASS" : "FAIL"} ${c.id.padEnd(20)} ${String(latencyMs).padStart(6)}ms ${String(entry.bytes).padStart(8)}B  ${entry.headline ?? entry.errorText ?? entry.transportError ?? ""}`,
    );
  }

  for (const c of invalid.filter((c) => shouldRun(c.id))) {
    const started = performance.now();
    let msg;
    let transportError = null;
    try {
      msg = await mcp.request("tools/call", { name: c.tool, arguments: c.args }, 15000);
    } catch (err) {
      transportError = err.message;
    }
    const result = msg?.result;
    const entry = {
      id: c.id,
      tool: c.tool,
      why: c.why,
      arguments: c.args,
      latencyMs: Math.round(performance.now() - started),
      rejected: Boolean(msg?.error) || result?.isError === true,
      rpcError: msg?.error ? `${msg.error.code}: ${msg.error.message}` : null,
      resultError: result?.isError ? textOf(result).slice(0, 600) : null,
      transportError,
    };
    report.invalid.push(entry);
    console.error(`${entry.rejected ? "REJECTED" : "ACCEPTED"} ${c.id.padEnd(22)} ${entry.rpcError ?? entry.resultError ?? entry.transportError ?? ""}`);
  }
} finally {
  report.finishedAt = new Date().toISOString();
  report.stderr = mcp.stderr.slice(-40);
  report.egress.blocked = mcp.stderr.filter((line) => line.startsWith("v2-eval-guard: blocked"));
  mcp.stop();
  server.close();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.error(`\nwrote ${OUT}`);
}
