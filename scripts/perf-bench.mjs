#!/usr/bin/env node
// Bounded, offline performance benchmark for the built MCP server.
//
// Everything runs against a throwaway cache in the OS temp dir: no live
// awwwards.com traffic, no npm registry, no environment probe. A preload
// guard blocks any non-loopback socket/fetch so a synthetic-cache miss cannot
// silently turn this into a crawl.
//
// Usage: npm run build && node scripts/perf-bench.mjs [--runs 3] [--sites 10000]
//        [--calls 7] [--out perf-raw.json] [--keep]
//
// Measures:
//   - cold/warm stdio startup: spawn dist/cli.js -> initialize -> tools/list
//   - tools/list schema bytes
//   - search_sites on a populated cache, with and without a query, plus the
//     score-sort path (all through public tools/call, never internals)
//   - RSS after startup and after the search calls
//   - server process count while running and after shutdown

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { isGuardLine } = require("./egress-guard-marker.cjs");
const CLI = join(ROOT, "dist", "cli.js");
const CACHE_MOD = join(ROOT, "dist", "cache.js");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};
const RUNS = arg("--runs", 3);
const SITES = arg("--sites", 10_000);
const CALLS = arg("--calls", 7);
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const KEEP = args.includes("--keep");
for (const [name, value] of [["--runs", RUNS], ["--sites", SITES], ["--calls", CALLS]]) {
  if (!Number.isInteger(value) || value < 1) {
    console.error(`perf-bench: ${name} must be a positive integer`);
    process.exit(2);
  }
}

if (!existsSync(CLI) || !existsSync(CACHE_MOD)) {
  console.error(`missing ${CLI}; run npm run build first`);
  process.exit(2);
}
const newestSource = (dir) => {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const mtime = entry.isDirectory() ? newestSource(path) : statSync(path).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
};
if (newestSource(join(ROOT, "src")) > statSync(CLI).mtimeMs) {
  console.error("perf-bench: dist/ is older than src/; run npm run build first");
  process.exit(2);
}

const round = (n) => Math.round(n * 100) / 100;
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return { n: 0, min: null, median: null, p90: null, max: null };
  return {
    n: sorted.length,
    min: round(sorted[0]),
    median: round(pct(sorted, 0.5)),
    p90: round(pct(sorted, 0.9)),
    max: round(sorted[sorted.length - 1]),
  };
};
const ms = (n) => (n === null ? "n/a" : `${n}ms`);

const ROOT_TMP = join(tmpdir(), `awwwards-perf-${process.pid}-${Date.now().toString(36)}`);
const GUARD = join(ROOT, "scripts", "v2-eval-no-egress.cjs");
mkdirSync(ROOT_TMP, { recursive: true });

function sampleRss(pid) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`],
        { encoding: "utf8", timeout: 10_000 },
      ).trim();
      return Number(out) || null;
    }
    const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+) kB/);
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

// Server processes alive for this benchmark, identified by the marker argv
// (the CLI ignores extra argv entries).
function countMarked(marker) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command",
          `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' }).Count`],
        { encoding: "utf8", timeout: 15_000 },
      ).trim();
      return Number(out) || 0;
    }
    const out = execFileSync("ps", ["-eo", "args="], { encoding: "utf8", timeout: 10_000 });
    return out.split("\n").filter((line) => line.includes(marker)).length;
  } catch {
    return null;
  }
}

// Any guard line is a live egress attempt: the run is invalid, not "mostly
// offline". Counted again after the search suite so reads during tools/call
// are covered too, not just startup.
const guardBlocks = (server) =>
  server.stderr.filter(isGuardLine).length;

class McpChild {
  constructor(dir, marker) {
    this.marker = marker;
    this.stderr = [];
    this.buffer = "";
    this.nextId = 1;
    this.waiters = new Map();
    this.child = spawn(process.execPath, ["--require", GUARD, CLI, marker], {
      cwd: ROOT,
      env: { ...process.env, AWWWARDS_CACHE_DIR: dir, AWWWARDS_MCP_PROFILE: "full" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      for (let i; (i = this.buffer.indexOf("\n")) >= 0;) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const waiter = msg.id !== undefined ? this.waiters.get(msg.id) : undefined;
        if (waiter) {
          this.waiters.delete(msg.id);
          waiter.resolve(msg);
        }
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => this.stderr.push(...String(chunk).split("\n").filter(Boolean)));
    this.child.stdin.on("error", () => {}); // EPIPE when the server already exited
    this.exit = new Promise((resolve) => {
      this.child.on("exit", (code) => {
        for (const waiter of this.waiters.values()) waiter.reject(new Error(`server exited (${code}) before responding`));
        this.waiters.clear();
        resolve(code);
      });
      this.child.on("error", () => resolve(-1));
    });
  }

  request(method, params, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  async close() {
    this.child.stdin.end();
    let code = await Promise.race([this.exit, new Promise((r) => setTimeout(() => r("timeout"), 5_000))]);
    let killed = false;
    if (code === "timeout") {
      killed = true;
      this.child.kill();
      code = await Promise.race([this.exit, new Promise((r) => setTimeout(() => r("stuck"), 5_000))]);
    }
    return { exitCode: code, killFallback: killed };
  }
}

async function timedCall(child, name, toolArgs) {
  const started = performance.now();
  const msg = await child.request("tools/call", { name, arguments: toolArgs });
  const ms = performance.now() - started;
  if (msg.error) throw new Error(`${name}: ${JSON.stringify(msg.error)}`);
  if (msg.result?.isError) throw new Error(`${name}: ${msg.result.content?.[0]?.text ?? "isError"}`);
  return { ms: round(ms), bytes: Buffer.byteLength(JSON.stringify(msg.result), "utf8"), result: msg.result };
}

function seedDailyState(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "version-check.json"), JSON.stringify({ checkedAt: Date.now(), latest: "1.16.1" }));
  writeFileSync(join(dir, "env-check.json"), JSON.stringify({ checkedAt: Date.now() }));
}

// A compact search inlines up to two previews. Seed the exact rows each case
// returns with a fixed-size JPEG-headered stub so the payload includes the
// same local image I/O; the stub is not a decodable photo, only its byte size
// is meaningful here.
const PREVIEW_BYTES = 32 * 1024;
const PREVIEW_JPEG = (() => {
  const buf = Buffer.alloc(PREVIEW_BYTES);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[PREVIEW_BYTES - 2] = 0xff;
  buf[PREVIEW_BYTES - 1] = 0xd9;
  return buf;
})();

async function seedColdState(dir) {
  seedDailyState(dir);
  // A completed index:status keeps shouldAutoIndex false, so a cold start
  // never launches the live indexer (which the egress guard would block).
  const { Cache } = await import(pathToFileURL(CACHE_MOD).href);
  new Cache(dir).setMeta("index:status", {
    finishedAt: Date.now(), pagesDone: 1, pagesTotal: 1, sitesIndexed: 0, skipped: 0,
  });
}

function siteFixture(i, now) {
  const tags = ["portfolio", "3d", "webgl", "gsap", "react", "next-js", "ecommerce", "animation", "typography", "minimal"];
  const slug = `site-${String(i).padStart(5, "0")}`;
  return {
    slug,
    id: 100_000 + i,
    title: `Synthetic Studio ${String(i).padStart(5, "0")}`,
    createdAt: now - i * 60_000,
    tags: [tags[i % tags.length], tags[(i * 3 + 1) % tags.length], tags[(i * 7 + 2) % tags.length]],
    thumbnailPath: `thumbs/${slug}.jpg`,
    liveUrl: `https://${slug}.example/`,
    detailPath: `/sites/${slug}/`,
    awards: i % 5 === 0 ? ["Site of the Day"] : [],
    studio: `Studio ${i % 97}`,
    nominee: false,
    score: ((i * 37) % 101) / 10,
  };
}

async function buildFixture(dir, count) {
  const started = performance.now();
  seedDailyState(dir);
  const { Cache } = await import(pathToFileURL(CACHE_MOD).href);
  const cache = new Cache(dir);
  const now = Date.now();
  const sites = Array.from({ length: count }, (_, i) => siteFixture(i, now));
  cache.upsertSites(sites);
  cache.withDbForTest((db) => {
    const detail = db.prepare("INSERT OR REPLACE INTO meta (key, value, fetchedAt) VALUES (?, ?, ?)");
    const status = db.prepare("INSERT OR REPLACE INTO meta (key, value, fetchedAt) VALUES (?, ?, ?)");
    db.exec("BEGIN");
    try {
      for (const site of sites) {
        detail.run(`detail:${site.slug}`, JSON.stringify({ score: site.score, title: site.title }), now);
      }
      status.run("index:status", JSON.stringify({
        finishedAt: now, pagesDone: 1, pagesTotal: 1, sitesIndexed: count, skipped: 0,
      }), now);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  });
  // Compact searches inline up to two thumbnails. Seed the exact first two
  // rows each recorded case returns so the search payload carries the same
  // local image reads (no network) and the disclosed bytes are meaningful.
  const allFresh = cache.getSites(Number.POSITIVE_INFINITY);
  const broad = cache.searchSites("studio", Number.POSITIVE_INFINITY) ?? [];
  const filtered = cache.searchSites("webgl", Number.POSITIVE_INFINITY) ?? [];
  const scores = cache.getMetaMany(
    allFresh.map((site) => `detail:${site.slug}`),
    Number.POSITIVE_INFINITY,
  );
  const scored = [...allFresh].sort((a, b) =>
    (scores.get(`detail:${b.slug}`)?.score ?? -1) - (scores.get(`detail:${a.slug}`)?.score ?? -1) ||
    b.createdAt - a.createdAt ||
    a.slug.localeCompare(b.slug));
  const previews = {
    search_no_query: allFresh.slice(0, 2),
    search_query_broad: broad.slice(0, 2),
    search_query_filtered: filtered.slice(0, 2),
    search_score_sort: scored.slice(0, 2),
  };
  const imagesDir = join(dir, "images");
  const seeded = new Set();
  const previewByCase = {};
  for (const [key, rows] of Object.entries(previews)) {
    previewByCase[key] = rows.map((site) => {
      const file = join(imagesDir, createHash("sha1").update(site.thumbnailPath).digest("hex") + ".jpg");
      if (!seeded.has(file)) {
        writeFileSync(file, PREVIEW_JPEG);
        seeded.add(file);
      }
      return site.slug;
    });
  }
  return {
    buildMs: round(performance.now() - started),
    dbBytes: statSync(join(dir, "cache.db")).size,
    matches: { broad: broad.length, filtered: filtered.length },
    thumbnails: { bytesPerPreview: PREVIEW_BYTES, files: seeded.size, previewByCase },
  };
}

async function runStartup(dir, label) {
  const marker = `perfbench-${process.pid}-${label}-${Math.random().toString(36).slice(2, 8)}`;
  const t0 = performance.now();
  const server = new McpChild(dir, marker);
  try {
    const init = await server.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "perf-bench", version: "0" },
    });
    const initMs = round(performance.now() - t0);
    server.notify("notifications/initialized");
    const list = await server.request("tools/list", {});
    const listMs = round(performance.now() - t0);
    const rss = sampleRss(server.child.pid);
    const processes = countMarked(marker);
    const tools = list.result?.tools ?? [];
    return {
      server,
      marker,
      record: {
        label,
        initMs,
        listMs,
        tools: tools.length,
        schemaBytes: Buffer.byteLength(JSON.stringify(tools), "utf8"),
        instructionsBytes: Buffer.byteLength(init.result?.instructions ?? "", "utf8"),
        rssAfterStartup: rss,
        processesWhileRunning: processes,
        guardBlocks: guardBlocks(server),
      },
    };
  } catch (err) {
    server.child.kill();
    throw new Error(`${label} startup failed: ${err instanceof Error ? err.message : String(err)}; stderr: ${server.stderr.slice(-5).join(" | ")}`);
  }
}

const CASES = [
  { key: "search_no_query", name: "search_sites", args: { count: 12, responseMode: "compact" } },
  { key: "search_query_broad", name: "search_sites", args: { query: "studio", count: 12, responseMode: "compact" } },
  { key: "search_query_filtered", name: "search_sites", args: { query: "webgl", count: 12, responseMode: "compact" } },
  { key: "search_score_sort", name: "search_sites", args: { count: 12, responseMode: "compact", sortBy: "score" } },
];

function imageSummary(result) {
  const images = (Array.isArray(result?.content) ? result.content : [])
    .filter((block) => block?.type === "image");
  return {
    count: images.length,
    bytes: images.reduce((n, block) => n + Buffer.from(String(block.data ?? ""), "base64").length, 0),
  };
}

async function runSearchSuite(server) {
  const out = {};
  for (const c of CASES) {
    await timedCall(server, c.name, c.args); // warm-up, not recorded
    const latencies = [];
    const bytes = [];
    const previewCounts = [];
    const previewBytes = [];
    for (let i = 0; i < CALLS; i++) {
      const call = await timedCall(server, c.name, c.args);
      latencies.push(call.ms);
      bytes.push(call.bytes);
      const image = imageSummary(call.result);
      previewCounts.push(image.count);
      previewBytes.push(image.bytes);
    }
    const s = stats(latencies);
    out[c.key] = {
      ...s,
      bytesMedian: pct([...bytes].sort((a, b) => a - b), 0.5),
      previewCountMedian: pct([...previewCounts].sort((a, b) => a - b), 0.5),
      previewBytesMedian: pct([...previewBytes].sort((a, b) => a - b), 0.5),
      latencies,
      bytes,
      previewCounts,
      previewBytes,
    };
  }
  out.rssAfterSearch = sampleRss(server.child.pid);
  return out;
}

async function main() {
  const fixture = await buildFixture(join(ROOT_TMP, "warm"), SITES);
  const runs = [];
  for (let r = 1; r <= RUNS; r++) {
    const coldDir = join(ROOT_TMP, `cold-${r}`);
    await seedColdState(coldDir);
    const cold = await runStartup(coldDir, `cold-${r}`);
    const coldClose = await cold.server.close();
    cold.record.guardBlocks = guardBlocks(cold.server);
    const coldLeft = countMarked(cold.marker);

    const warm = await runStartup(join(ROOT_TMP, "warm"), `warm-${r}`);
    let searches;
    let warmLeftBefore;
    let warmClose;
    let warmLeft;
    try {
      searches = await runSearchSuite(warm.server);
      warmLeftBefore = countMarked(warm.marker);
      warm.record.guardBlocks = guardBlocks(warm.server);
    } finally {
      // A failed search suite must still reap the child, or the temp cache
      // stays locked and the benchmark leaks a server process.
      warmClose = await warm.server.close();
      warmLeft = countMarked(warm.marker);
      warm.record.guardBlocks = guardBlocks(warm.server);
    }
    runs.push({
      run: r,
      cold: { ...cold.record, ...coldClose, processesAfterClose: coldLeft },
      warm: {
        ...warm.record,
        processesWhileSearching: warmLeftBefore,
        ...warmClose,
        processesAfterClose: warmLeft,
        searches,
      },
    });
    console.log(`run ${r}/${RUNS}: cold init ${cold.record.initMs}ms, warm init ${warm.record.initMs}ms`);
  }

  const aggregate = {};
  for (const c of CASES) {
    const all = runs.flatMap((run) => run.warm.searches[c.key].latencies);
    const bytes = runs.flatMap((run) => run.warm.searches[c.key].bytes);
    const previewCounts = runs.flatMap((run) => run.warm.searches[c.key].previewCounts);
    const previewBytes = runs.flatMap((run) => run.warm.searches[c.key].previewBytes);
    const s = stats(all);
    aggregate[c.key] = {
      ...s,
      bytesMedian: pct([...bytes].sort((a, b) => a - b), 0.5),
      previewCountMedian: pct([...previewCounts].sort((a, b) => a - b), 0.5),
      previewBytesMedian: pct([...previewBytes].sort((a, b) => a - b), 0.5),
    };
  }
  const cold = stats(runs.map((run) => run.cold.listMs));
  const warm = stats(runs.map((run) => run.warm.listMs));
  const coldInit = stats(runs.map((run) => run.cold.initMs));
  const warmInit = stats(runs.map((run) => run.warm.initMs));
  const startupRss = runs.map((run) => run.warm.rssAfterStartup).filter((n) => n !== null);
  const searchRss = runs.map((run) => run.warm.searches.rssAfterSearch).filter((n) => n !== null);

  // Expected: exactly one live server per phase, zero after close. A null
  // count means the OS query failed; a zero-alive check means spawn or the
  // query lied. Both are failures, not clean results.
  const afterChecks = runs.flatMap((run) => [run.cold.processesAfterClose, run.warm.processesAfterClose]);
  const aliveChecks = runs.flatMap((run) => [run.cold.processesWhileRunning, run.warm.processesWhileSearching]);
  const unknownProcessCounts = [...afterChecks, ...aliveChecks].filter((n) => n === null).length;
  const leftoverProcesses = afterChecks.reduce((n, v) => n + (v ?? 0), 0);
  const unexpectedAlive = aliveChecks.filter((n) => n !== 1).length;
  const blockedEgress = runs.reduce((n, run) => n + run.cold.guardBlocks + run.warm.guardBlocks, 0);
  const cleanup = {
    tempRemoved: false,
    leftoverProcesses,
    unexpectedAlive,
    unknownProcessCounts,
    blockedEgress,
  };
  if (!KEEP) {
    rmSync(ROOT_TMP, { recursive: true, force: true });
    cleanup.tempRemoved = !existsSync(ROOT_TMP);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    cpu: process.env.PROCESSOR_IDENTIFIER ?? null,
    cli: CLI,
    config: { runs: RUNS, sites: SITES, callsPerCase: CALLS },
    fixture,
    startup: {
      cold,
      warm,
      coldInit,
      warmInit,
      coldRuns: runs.map((run) => run.cold),
      warmRuns: runs.map((run) => run.warm),
    },
    search: aggregate,
    rss: {
      afterStartup: stats(startupRss),
      afterSearch: stats(searchRss),
      afterStartupBytes: startupRss,
      afterSearchBytes: searchRss,
    },
    cleanup,
    runs,
  };

  console.log("\nstartup");
  console.log(`  cold initialize   median ${ms(coldInit.median)}  p90 ${ms(coldInit.p90)}`);
  console.log(`  cold tools/list   median ${ms(cold.median)}  p90 ${ms(cold.p90)}  min ${ms(cold.min)}  max ${ms(cold.max)}`);
  console.log(`  warm initialize   median ${ms(warmInit.median)}  p90 ${ms(warmInit.p90)}`);
  console.log(`  warm tools/list   median ${ms(warm.median)}  p90 ${ms(warm.p90)}  min ${ms(warm.min)}  max ${ms(warm.max)}`);
  console.log(`  tools ${runs[0].warm.tools}, schema ${runs[0].warm.schemaBytes} bytes`);
  console.log("\nsearch_sites (10k sites, compact)");
  for (const c of CASES) {
    const a = aggregate[c.key];
    console.log(`  ${c.key.padEnd(24)} median ${String(a.median).padStart(7)}ms  p90 ${String(a.p90).padStart(7)}ms  max ${String(a.max).padStart(7)}ms  bytes ${a.bytesMedian}  previews ${a.previewCountMedian}x${a.previewBytesMedian}B`);
  }
  console.log("\nmemory (RSS)");
  const mb = (n) => (n === null ? "n/a" : `${(n / 1048576).toFixed(1)} MB`);
  console.log(`  after startup  median ${mb(report.rss.afterStartup.median)}`);
  console.log(`  after search   median ${mb(report.rss.afterSearch.median)}`);
  console.log(`\ncleanup: tempRemoved=${cleanup.tempRemoved} leftoverProcesses=${cleanup.leftoverProcesses} unexpectedAlive=${cleanup.unexpectedAlive} unknownProcessCounts=${cleanup.unknownProcessCounts} blockedEgress=${cleanup.blockedEgress}`);

  if (OUT) {
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`wrote ${OUT}`);
  }
  if (cleanup.blockedEgress > 0) {
    console.error(
      `perf-bench: FAIL: ${cleanup.blockedEgress} blocked egress attempt(s); the run was not offline and its numbers are invalid`,
    );
  }
  if (cleanup.unexpectedAlive > 0) {
    console.error(
      `perf-bench: FAIL: ${cleanup.unexpectedAlive} phase(s) did not see exactly one live server process`,
    );
  }
  if (
    cleanup.leftoverProcesses !== 0 ||
    cleanup.unexpectedAlive !== 0 ||
    cleanup.unknownProcessCounts > 0 ||
    cleanup.blockedEgress > 0 ||
    (!KEEP && !cleanup.tempRemoved)
  ) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
} finally {
  if (!KEEP) rmSync(ROOT_TMP, { recursive: true, force: true });
}
