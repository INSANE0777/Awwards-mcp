#!/usr/bin/env node
// Installed-artifact qualification for the final Atlas build. Everything under
// test comes from the packed tarball installed into a throwaway prefix; the
// checkout's dist is never on the child's resolution path. The harness runs
// offline (Node egress guard plus a loopback-only fixture) and records every
// assertion as PASS/FAIL/SKIP in a machine-readable report.
//
// The expected surfaces are Phase 6 exit criteria: 41/13/15 flag off and
// 45/13/16 flag on. On a base where Phase 6A/6B are not integrated the
// flag-on and CLI checks fail or skip explicitly; they are never green.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GUARD_MARKER } from "./egress-guard-marker.cjs";
import { buildChildEnv, cacheFingerprint, sameCacheFingerprint } from "./qualify/child-env.mjs";
import { ATLAS_ACTIONS, classifyFlagOffProbe, classifyFlagOnProbe } from "./qualify/cli-probe.mjs";
import {
  ATLAS_FULL_TOOLS,
  ATLAS_V2_BRANCHES,
  ATLAS_V2_BRANCH_KINDS,
  EXPECTED_COUNTS,
  analyzeAnnotations,
  analyzeBranches,
  analyzeSurface,
  analyzeSurfaceDelta,
  browserQualification,
  classifyToolResult,
  extractBranchKinds,
  firstLine,
  outputAdvertisesAtlasStatus,
  parseErrorCode,
  probeStatus,
} from "./qualify/expectations.mjs";
import { checkDistFreshness } from "./qualify/freshness.mjs";
import { startMcpClient } from "./qualify/mcp-client.mjs";
import {
  addCheck,
  createReport,
  exitCodeFor,
  finalizeReport,
  normalizeCheckOutcome,
  renderHumanSummary,
  validateReport,
} from "./qualify/report.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const LEGACY = "2025-06-18";
const MODERN = "2026-07-28";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ZERO_ID = "0".repeat(64);

const FIXTURE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>awwwards-mcp qualification fixture</title>
<style>
  html, body { margin: 0; }
  .hero { height: 800px; background: #101820; color: #fff; }
  .work { height: 700px; background: #f2f2f2; color: #111; }
  .contact { height: 500px; background: #c8102e; color: #fff; }
</style></head>
<body>
  <header id="hero" class="hero"><h1>Hero</h1></header>
  <section id="work" class="work"><h2>Work</h2></section>
  <footer id="contact" class="contact"><h2>Contact</h2></footer>
</body>
</html>`;

const USAGE = `usage: node scripts/qualify-installed.mjs [--report <path>] [--skip-build]
       [--no-browser] [--keep-temp] [--verbose] [--timeout-ms <n>]`;

function parseArgs(argv) {
  const options = {
    report: join(ROOT, ".qualification", "installed-report.json"),
    skipBuild: false,
    browser: true,
    keepTemp: false,
    timeoutMs: 120_000,
    verbose: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--no-browser") options.browser = false;
    else if (arg === "--keep-temp") options.keepTemp = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--report") {
      const value = argv[++index];
      if (!value) throw new Error(`--report needs a path\n${USAGE}`);
      options.report = resolve(value);
    } else if (arg === "--timeout-ms") {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value < 1_000) throw new Error(`--timeout-ms needs >= 1000\n${USAGE}`);
      options.timeoutMs = Math.trunc(value);
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}\n${USAGE}`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const report = createReport({
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  package: { name: PKG.name, version: PKG.version },
  repo: gitInfo(),
  options: {
    skipBuild: options.skipBuild,
    browser: options.browser,
    keepTemp: options.keepTemp,
    timeoutMs: options.timeoutMs,
  },
});
report.notes = [];
report.qualificationScope = "offline-installed";

let tempRoot = null;
let isolatedHome = null;
let guardPath = null;
let installedCli = null;
let installedIndexCli = null;
let installedPkgDir = null;
let globalRoot = null;
let tarball = null;
let fixture = null;
let realCache = null;
let realCacheBefore = null;
let playwrightBrowsersPath = null;
const tools = { off: {}, on: {} };
const spawned = [];

function gitInfo() {
  const run = (args) => {
    const result = spawnSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return null;
    return result.stdout.trim();
  };
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = run(["rev-parse", "HEAD"]);
  const status = run(["status", "--porcelain"]);
  return {
    root: ROOT,
    branch,
    commit,
    dirty: status === null ? null : status !== "",
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const quoteWin = (args) => args.map((arg) => (/[\s"]/.test(arg) ? `"${arg}"` : arg));

function npm(args) {
  const npmCli = process.env.npm_execpath;
  const common = { cwd: ROOT, encoding: "utf8", timeout: 300_000, windowsHide: true };
  let result;
  if (npmCli) {
    result = spawnSync(process.execPath, [npmCli, ...args], common);
  } else if (process.platform === "win32") {
    // npm/npx are .cmd shims here; one explicit cmd.exe line avoids Node's
    // DEP0190 warning about an args array with shell:true.
    const line = ["npm.cmd", ...quoteWin(args)].join(" ");
    result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", line], {
      ...common,
      windowsVerbatimArguments: true,
    });
  } else {
    result = spawnSync("npm", args, common);
  }
  if (result.error) throw new Error(`npm ${args[0]}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `npm ${args.join(" ")} exited ${result.status}\n` +
        `${(result.stdout ?? "").slice(-2_000)}${(result.stderr ?? "").slice(-2_000)}`,
    );
  }
  return result;
}

function runNode(args, { env, timeoutMs = options.timeoutMs, cwd = tempRoot } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    errorText: result.error ? result.error.message : null,
  };
}

function serverEnv(cacheDir, { flagOn = false, profile } = {}) {
  return buildChildEnv({
    baseEnv: process.env,
    cacheDir,
    homeDir: isolatedHome,
    flagOn,
    profile,
    playwrightBrowsersPath,
  });
}

function defaultRealCache() {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home ? join(home, ".awwwards-mcp") : null;
}

function isInside(child, parent) {
  const normalizePath = (value) => {
    const text = resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? text.toLowerCase() : text;
  };
  const inner = normalizePath(child);
  const outer = normalizePath(parent);
  return inner === outer || inner.startsWith(`${outer}/`);
}

function walkFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function check(id, group, required, fn) {
  const started = Date.now();
  let outcome;
  try {
    outcome = normalizeCheckOutcome(await fn());
  } catch (error) {
    outcome = { status: "FAIL", reason: error instanceof Error ? error.message : String(error) };
  }
  const reason =
    (outcome.reason && String(outcome.reason).trim()) || `${id}: ${String(outcome.status).toLowerCase()}`;
  const entry = addCheck(report, {
    id,
    group,
    required,
    status: outcome.status,
    reason,
    details: outcome.details,
    durationMs: Date.now() - started,
  });
  if (options.verbose) console.log(`[${entry.status}] ${entry.id} — ${entry.reason}`);
  return entry;
}

function requirePass(entry, label) {
  if (entry.status !== "PASS") throw new Error(`${label} did not pass; dependent qualification aborted`);
}

function describeAudit(audit) {
  const parts = [...audit.problems];
  if (audit.noise.length > 0) {
    parts.unshift(`stdout noise: ${audit.noise.slice(0, 3).map((line) => line.slice(0, 100)).join(" | ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : "clean channel";
}

function assertCleanAudit(audit) {
  if (audit.noise.length > 0) {
    throw new Error(`stdout noise: ${audit.noise.slice(0, 3).map((line) => line.slice(0, 120)).join(" | ")}`);
  }
  assert(audit.problems.length === 0, audit.problems.join("; "));
}

async function runClient({ label, cacheDir, flagOn, profile }, fn) {
  assert(installedCli, "installed CLI unavailable");
  const client = await startMcpClient({
    command: process.execPath,
    args: ["--require", guardPath, installedCli],
    cwd: tempRoot,
    env: serverEnv(cacheDir, { flagOn, profile }),
    label,
    requestTimeoutMs: options.timeoutMs,
  });
  const entry = { label, pid: client.pid, audit: null };
  spawned.push(entry);
  let value;
  let error = null;
  try {
    value = await fn(client);
  } catch (caught) {
    error = caught;
  }
  const audit = await client.stop();
  entry.audit = audit;
  if (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}; ${describeAudit(audit)}`);
  }
  return { value, audit };
}

async function seedCache(cacheDir, { siteUrl } = {}) {
  mkdirSync(cacheDir, { recursive: true });
  const { Cache } = await import(pathToFileURL(join(installedPkgDir, "dist", "cache.js")).href);
  const cache = new Cache(cacheDir, Date.now, { atlas: false });
  const now = Date.now();
  cache.setMeta("index:status", {
    finishedAt: now,
    pagesDone: 1,
    pagesTotal: 1,
    sitesIndexed: siteUrl ? 1 : 0,
    skipped: 0,
  });
  if (siteUrl) {
    cache.upsertSites([
      {
        id: 1,
        slug: "qualify-fixture",
        title: "Qualification fixture",
        createdAt: Math.floor(now / 1000),
        tags: [],
        thumbnailPath: "",
        liveUrl: siteUrl,
        detailPath: "/sites/qualify-fixture",
        awards: [],
        studio: "Qualification",
        nominee: false,
      },
    ]);
    const seeded = cache.getSite("qualify-fixture", Number.POSITIVE_INFINITY);
    assert(seeded?.liveUrl === siteUrl, "seeded qualification site is not readable from the installed cache");
  }
  writeFileSync(
    join(cacheDir, "version-check.json"),
    JSON.stringify({ checkedAt: now, latest: PKG.version }),
  );
  writeFileSync(join(cacheDir, "env-check.json"), JSON.stringify({ checkedAt: now }));
}

async function initializeLegacy(client) {
  const init = await client.result(
    "initialize",
    {
      protocolVersion: LEGACY,
      capabilities: {},
      clientInfo: { name: "awwwards-qualification", version: "1" },
    },
    options.timeoutMs,
  );
  client.notify("notifications/initialized", {});
  return init;
}

async function listTools(client, params = {}) {
  const result = await client.result("tools/list", params, options.timeoutMs);
  return Array.isArray(result?.tools) ? result.tools : [];
}

async function toolJson(client, name, args, timeoutMs = options.timeoutMs) {
  const message = await client.request("tools/call", { name, arguments: args }, timeoutMs);
  const classified = classifyToolResult(message);
  if (classified.kind !== "ok") {
    throw new Error(`${name} failed (${classified.kind}): ${firstLine(classified.text)}`);
  }
  return JSON.parse(classified.text);
}

function modernMeta() {
  return {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN,
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  };
}

async function runSurface(flagOn, profile) {
  const state = flagOn ? "on" : "off";
  await check(`surface.${profile}.flag_${state}`, "surfaces", true, async () => {
    const cacheDir = join(tempRoot, "caches", `surface-${profile}-${state}`);
    await seedCache(cacheDir);
    const { value, audit } = await runClient(
      { label: `surface ${profile} ${state}`, cacheDir, flagOn, profile: profile === "full" ? undefined : profile },
      async (client) => {
        const init = await initializeLegacy(client);
        assert(
          init?.serverInfo?.name === "awwwards-mcp",
          `unexpected initialize serverInfo: ${JSON.stringify(init?.serverInfo)}`,
        );
        const list = await listTools(client);
        tools[state][profile] = list;
        return list.map((tool) => tool.name);
      },
    );
    assertCleanAudit(audit);
    const surface = analyzeSurface({ flagOn, profile, names: value });
    assert(surface.ok, surface.problems.join("; "));
    return {
      status: "PASS",
      reason:
        `${surface.actual} tools (expected ${surface.expected})` +
        (surface.wanted.length > 0 ? `; Atlas tools: ${surface.wanted.join(", ")}` : ""),
      details: surface,
    };
  });
}

async function runProtocol(flagOn, era) {
  const state = flagOn ? "on" : "off";
  await check(`protocol.${era}.flag_${state}`, "protocol", true, async () => {
    const cacheDir = join(tempRoot, "caches", `protocol-${era}-${state}`);
    await seedCache(cacheDir);
    const { value, audit } = await runClient(
      { label: `protocol ${era} ${state}`, cacheDir, flagOn, profile: undefined },
      async (client) => {
        if (era === "legacy") {
          const init = await initializeLegacy(client);
          const list = await listTools(client);
          return { init, list };
        }
        const meta = modernMeta();
        const discover = await client.result("server/discover", meta, options.timeoutMs);
        const list = await listTools(client, meta);
        return { discover, list };
      },
    );
    assertCleanAudit(audit);
    const names = value.list.map((tool) => tool.name);
    const surface = analyzeSurface({ flagOn, profile: "full", names });
    assert(surface.ok, surface.problems.join("; "));
    let version;
    if (era === "legacy") {
      version = value.init?.protocolVersion;
      assert(version === LEGACY, `legacy initialize negotiated ${version}, expected ${LEGACY}`);
    } else {
      version = value.discover?.supportedVersions;
      assert(
        Array.isArray(version) && version.includes(MODERN),
        `modern discover supportedVersions=${JSON.stringify(version)}`,
      );
    }
    return {
      status: "PASS",
      reason:
        `${era} ${state}: ${names.length} unique tools, version ${era === "legacy" ? version : MODERN} accepted, ` +
        "clean stdout",
      details: { era, count: names.length, version, surface },
    };
  });
}

async function runBranchSchemas(flagOn) {
  const state = flagOn ? "on" : "off";
  await check(`branches.flag_${state}`, "branches", true, async () => {
    const list = tools[state].v2;
    assert(Array.isArray(list), `v2 tools/list unavailable (flag ${state}); the surface check failed first`);
    const details = [];
    const problems = [];
    for (const { tool } of ATLAS_V2_BRANCHES) {
      const found = list.find((entry) => entry.name === tool);
      if (!found) {
        problems.push(`v2 tool ${tool} is missing`);
        details.push({ tool, found: false });
        continue;
      }
      const result = analyzeBranches({ flagOn, schema: found.inputSchema, tool });
      problems.push(...result.problems);
      details.push(result);
    }
    if (flagOn) {
      const getIndex = list.find((entry) => entry.name === "get_index");
      if (!outputAdvertisesAtlasStatus(getIndex?.outputSchema)) {
        problems.push(
          "get_index outputSchema does not advertise the atlas_status envelope " +
            "(schemaVersion const awwwards-atlas-v1)",
        );
      }
    }
    assert(problems.length === 0, problems.join("; "));
    return {
      status: "PASS",
      reason: flagOn
        ? `all ${ATLAS_V2_BRANCH_KINDS.length} Atlas branch kinds advertised; get_index outputSchema advertises Atlas`
        : "all expected Atlas branch kinds remain declared with the flag off",
      details: { branches: details },
    };
  });
}

function checkStatus(id) {
  return report.checks.find((entry) => entry.id === id)?.status;
}

async function runSurfaceDeltas() {
  for (const profile of ["full", "core", "v2"]) {
    await check(`surface.delta.${profile}`, "surfaces", true, async () => {
      const off = tools.off[profile];
      const on = tools.on[profile];
      if (!Array.isArray(off) || !Array.isArray(on)) {
        return { status: "SKIP", reason: `flag-off/flag-on ${profile} tools/list unavailable` };
      }
      if (checkStatus(`surface.${profile}.flag_off`) !== "PASS" || checkStatus(`surface.${profile}.flag_on`) !== "PASS") {
        return { status: "SKIP", reason: "surface checks did not pass; the flag-on delta was not evaluated" };
      }
      const delta = analyzeSurfaceDelta({
        profile,
        offNames: off.map((tool) => tool.name),
        onNames: on.map((tool) => tool.name),
      });
      assert(delta.ok, delta.problems.join("; "));
      const added = delta.expectedOn.filter((name) => !off.some((tool) => tool.name === name));
      return {
        status: "PASS",
        reason:
          `flag-on ${profile} surface equals flag-off` +
          (added.length > 0 ? ` plus ${added.join(", ")}` : " exactly"),
        details: delta,
      };
    });
  }
}

async function runAnnotations() {
  await check("annotations.flag_on", "annotations", true, async () => {
    const full = tools.on.full;
    const v2 = tools.on.v2;
    if (!Array.isArray(full) || !Array.isArray(v2)) {
      return { status: "SKIP", reason: "flag-on tools/list unavailable; the surface check failed first" };
    }
    if (checkStatus("surface.full.flag_on") !== "PASS" || checkStatus("surface.v2.flag_on") !== "PASS") {
      return { status: "SKIP", reason: "flag-on surfaces did not pass; annotations were not evaluated" };
    }
    const result = analyzeAnnotations({ fullTools: full, v2Tools: v2 });
    assert(result.ok, result.problems.join("; "));
    return {
      status: "PASS",
      reason:
        "Atlas annotations match spec 11.6 (search/retrieval read-only+idempotent, capture open-world, " +
        "export idempotent) and capture_page is not all read-only",
      details: result,
    };
  });
}

async function runAtlasToolProbes() {
  await check("atlas.tools.runtime", "runtime", true, async () => {
    const list = tools.on.full;
    if (!Array.isArray(list)) {
      return { status: "SKIP", reason: "flag-on full tools/list unavailable; the surface check failed first" };
    }
    const present = ATLAS_FULL_TOOLS.filter((name) => list.some((tool) => tool.name === name));
    if (present.length === 0) {
      return { status: "SKIP", reason: "no Atlas tools advertised (Phase 6A is not integrated)" };
    }
    const cacheDir = join(tempRoot, "caches", "atlas-tool-probes");
    await seedCache(cacheDir, { siteUrl: fixture.url });
    const probes = [];
    const { audit } = await runClient(
      { label: "atlas tool probes", cacheDir, flagOn: true, profile: undefined },
      async (client) => {
        await initializeLegacy(client);
        for (const name of present) {
          const before = fixture.requests.length;
          let args;
          let expectation = {};
          if (name === "search_atlas") args = { kind: "sections", query: "hero" };
          else if (name === "get_atlas") args = { kind: "status" };
          else if (name === "capture_atlas") {
            args = { slug: "qualify-fixture", path: "/", viewport: "desktop" };
            expectation = { expectPrivate: true };
          } else if (name === "export_evidence_pack") {
            args = { regionIds: [ZERO_ID] };
            expectation = { expectDomain: true };
          }
          const message = await client.request("tools/call", { name, arguments: args }, options.timeoutMs);
          const classified = classifyToolResult(message);
          const outcome = probeStatus(classified, expectation);
          const fixtureDelta = fixture.requests.length - before;
          if (name === "capture_atlas" && fixtureDelta !== 0) {
            outcome.status = "FAIL";
            outcome.reason = `capture_atlas reached the loopback fixture ${fixtureDelta} time(s)`;
          }
          probes.push({ tool: name, ...outcome });
        }
      },
    );
    assertCleanAudit(audit);
    const failures = probes.filter((probe) => probe.status === "FAIL");
    assert(failures.length === 0, failures.map((probe) => `${probe.tool}: ${probe.reason}`).join("; "));
    const missing = ATLAS_FULL_TOOLS.filter((name) => !present.includes(name));
    if (missing.length > 0) {
      return {
        status: "SKIP",
        reason: `runtime probe incomplete: ${missing.join(", ")} not advertised (surface check failed first)`,
        details: { probes },
      };
    }
    return {
      status: "PASS",
      reason: `${probes.length}/${present.length} Atlas tool probe(s) recognized (no schema rejection)`,
      details: { probes },
    };
  });
}

const V2_PROBES = [
  {
    id: "search_references.sections",
    tool: "search_references",
    kind: "sections",
    args: { request: { kind: "sections" } },
  },
  {
    id: "search_references.components",
    tool: "search_references",
    kind: "components",
    args: { request: { kind: "components" } },
  },
  {
    id: "get_reference.atlas_region",
    tool: "get_reference",
    kind: "atlas_region",
    args: { request: { kind: "atlas_region", regionId: ZERO_ID } },
  },
  {
    id: "get_reference.atlas_highlight",
    tool: "get_reference",
    kind: "atlas_highlight",
    args: { request: { kind: "atlas_highlight", elementId: ZERO_ID } },
  },
  {
    id: "get_reference.atlas_taxonomy",
    tool: "get_reference",
    kind: "atlas_taxonomy",
    args: { request: { kind: "atlas_taxonomy" } },
  },
  {
    id: "get_index.atlas_status",
    tool: "get_index",
    kind: "atlas_status",
    args: { request: { kind: "atlas_status" } },
  },
  {
    id: "capture_page.atlas",
    tool: "capture_page",
    kind: "atlas",
    args: { request: { kind: "atlas", slug: "qualify-fixture", path: "/" } },
    expectPrivate: true,
  },
  {
    id: "export_evidence_pack",
    tool: "export_evidence_pack",
    args: { regionIds: [ZERO_ID] },
    expectDomain: true,
  },
];

async function runV2BranchProbes() {
  await check("v2.branches.runtime", "runtime", true, async () => {
    const list = tools.on.v2;
    if (!Array.isArray(list)) {
      return { status: "SKIP", reason: "flag-on v2 tools/list unavailable; the surface check failed first" };
    }
    const advertised = V2_PROBES.filter((probe) => {
      const tool = list.find((entry) => entry.name === probe.tool);
      return Boolean(tool && (!probe.kind || extractBranchKinds(tool.inputSchema).includes(probe.kind)));
    });
    if (advertised.length === 0) {
      return {
        status: "SKIP",
        reason: "no Atlas v2 branch is advertised (Phase 6A is not integrated)",
      };
    }
    const cacheDir = join(tempRoot, "caches", "v2-branch-probes");
    await seedCache(cacheDir, { siteUrl: fixture.url });
    const probes = [];
    const { audit } = await runClient(
      { label: "v2 branch probes", cacheDir, flagOn: true, profile: "v2" },
      async (client) => {
        await initializeLegacy(client);
        for (const probe of V2_PROBES) {
          const tool = list.find((entry) => entry.name === probe.tool);
          if (!tool) {
            probes.push({ id: probe.id, status: "SKIP", reason: `${probe.tool} is not advertised` });
            continue;
          }
          const advertised = probe.kind
            ? extractBranchKinds(tool.inputSchema).includes(probe.kind)
            : true;
          if (!advertised) {
            probes.push({ id: probe.id, status: "SKIP", reason: `branch ${probe.kind} is not advertised` });
            continue;
          }
          const before = fixture.requests.length;
          const message = await client.request(
            "tools/call",
            { name: probe.tool, arguments: probe.args },
            options.timeoutMs,
          );
          const classified = classifyToolResult(message);
          const outcome = probeStatus(classified, {
            expectPrivate: probe.expectPrivate === true,
            expectDomain: probe.expectDomain === true,
          });
          if (probe.expectPrivate && fixture.requests.length !== before) {
            outcome.status = "FAIL";
            outcome.reason = `${probe.id} reached the loopback fixture after refusing it`;
          }
          probes.push({ id: probe.id, ...outcome });
        }
      },
    );
    assertCleanAudit(audit);
    const failures = probes.filter((probe) => probe.status === "FAIL");
    assert(failures.length === 0, failures.map((probe) => `${probe.id}: ${probe.reason}`).join("; "));
    const skipped = probes.filter((probe) => probe.status === "SKIP");
    if (skipped.length > 0) {
      return {
        status: "SKIP",
        reason:
          `runtime probe incomplete: ${skipped.map((probe) => probe.id).join(", ")} ` +
          "not advertised or unavailable (branch check failed first)",
        details: { probes },
      };
    }
    return {
      status: "PASS",
      reason: `${probes.length}/${V2_PROBES.length} Atlas v2 branch probe(s) recognized (no schema rejection)`,
      details: { probes },
    };
  });
}

async function runCli() {
  const availability = new Map();
  for (const action of ATLAS_ACTIONS) {
    const entry = await check(`cli.${action.action}.refusal`, "cli", true, async () => {
      const dir = join(tempRoot, "cli", action.action);
      mkdirSync(dir, { recursive: true });
      const cacheDir = join(dir, "cache");
      const result = runNode(["--require", guardPath, installedIndexCli, ...action.argv], {
        env: serverEnv(cacheDir),
        timeoutMs: 60_000,
        cwd: tempRoot,
      });
      const classified = classifyFlagOffProbe({
        action: action.action,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        cacheExisted: existsSync(cacheDir),
        error: result.errorText,
      });
      if (result.stderr.includes(GUARD_MARKER)) {
        classified.status = "FAIL";
        classified.reason = `${action.action}: attempted non-loopback egress while the flag is off`;
      }
      return {
        status: classified.status,
        reason: classified.reason,
        details: {
          argv: action.argv,
          exit: result.status,
          available: classified.available,
          cacheExisted: existsSync(cacheDir),
        },
      };
    });
    availability.set(action.action, entry.details?.available === true);
  }

  await check("cli.import.flag_on", "cli", true, async () => {
    const cacheDir = join(tempRoot, "cli", "import-on-cache");
    const result = runNode(["--require", guardPath, installedIndexCli, "--atlas", "import"], {
      env: serverEnv(cacheDir, { flagOn: true }),
      timeoutMs: 60_000,
      cwd: tempRoot,
    });
    const classified = classifyFlagOnProbe({
      action: "import",
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.errorText,
    });
    assert(classified.status === "PASS", classified.reason);
    assert(!result.stderr.includes(GUARD_MARKER), "import attempted non-loopback egress");
    assert(existsSync(join(cacheDir, "cache.db")), "import did not create the cache database");
    return {
      status: "PASS",
      reason: "import completed offline on an empty cache (exit 0) with the flag enabled",
      details: { exit: result.status, cacheCreated: true },
    };
  });

  await check("cli.capture.flag_on", "cli", false, async () => ({
    status: "SKIP",
    reason:
      "positive --atlas capture needs a permitted non-loopback fixture; this offline run does not exercise it",
  }));

  for (const action of ATLAS_ACTIONS.filter((entry) => entry.offline && entry.action !== "import")) {
    await check(`cli.${action.action}.flag_on`, "cli", true, async () => {
      if (!availability.get(action.action)) {
        return {
          status: "SKIP",
          reason: `${action.action}: not wired on this base (Phase 6B), so the enabled run was not attempted`,
        };
      }
      const cacheDir = join(tempRoot, "cli", `${action.action}-on-cache`);
      await seedCache(cacheDir);
      if (action.action === "verify") {
        const seeded = runNode(["--require", guardPath, installedIndexCli, "--atlas", "import"], {
          env: serverEnv(cacheDir, { flagOn: true }),
          timeoutMs: 60_000,
          cwd: tempRoot,
        });
        assert(seeded.status === 0, `verify seed import failed: ${seeded.stderr}`);
      }
      const result = runNode(["--require", guardPath, installedIndexCli, ...action.argv], {
        env: serverEnv(cacheDir, { flagOn: true }),
        timeoutMs: 60_000,
        cwd: tempRoot,
      });
      const classified = classifyFlagOnProbe({
        action: action.action,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.errorText,
      });
      assert(classified.status === "PASS", classified.reason);
      assert(!result.stderr.includes(GUARD_MARKER), `${action.action} attempted non-loopback egress`);
      return {
        status: "PASS",
        reason: `${action.action} completed offline with the flag enabled (exit 0)`,
        details: { argv: action.argv, exit: result.status },
      };
    });
  }
}

function browsersPathFromExecutable(executable) {
  let cursor = dirname(executable);
  while (cursor !== dirname(cursor)) {
    if (/^chromium-\d+$/.test(basename(cursor))) return dirname(cursor);
    cursor = dirname(cursor);
  }
  return null;
}

function chromiumInfo() {
  if (!options.browser) return { available: false, reason: "--no-browser was requested" };
  try {
    const require = createRequire(join(ROOT, "package.json"));
    const playwright = require("playwright");
    const executable = playwright.chromium?.executablePath();
    if (!executable || !existsSync(executable)) {
      return { available: false, reason: "Playwright Chromium is not installed (npx playwright install chromium)" };
    }
    return {
      available: true,
      executable,
      browsersPath: browsersPathFromExecutable(executable),
    };
  } catch (error) {
    return {
      available: false,
      reason: `playwright is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function linkBrowserRuntime() {
  const linked = [];
  const failures = [];
  for (const dep of ["playwright", "ffmpeg-static"]) {
    const source = join(ROOT, "node_modules", dep);
    if (!existsSync(source)) {
      failures.push(`${dep} missing at ${source}`);
      continue;
    }
    const target = join(globalRoot, dep);
    if (existsSync(target)) {
      linked.push(dep);
      continue;
    }
    try {
      symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
      linked.push(dep);
    } catch (error) {
      failures.push(`${dep}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // A stray user-level node_modules can shadow the sibling link. Prove the
  // installed package will resolve the checkout's version, not a different one
  // whose browser revision is not installed.
  if (installedPkgDir) {
    const requireFromInstalled = createRequire(join(installedPkgDir, "package.json"));
    for (const dep of ["playwright", "ffmpeg-static"]) {
      try {
        const resolved = requireFromInstalled.resolve(`${dep}/package.json`);
        if (!isInside(realpathSync(resolved), realpathSync(join(ROOT, "node_modules", dep)))) {
          failures.push(`${dep} resolves to ${resolved}, outside the checkout link`);
        }
      } catch (error) {
        failures.push(
          `${dep} is not resolvable from the installed package: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return { linked, failures };
}

async function runBrowser() {
  const chromium = chromiumInfo();
  playwrightBrowsersPath = chromium.browsersPath ?? playwrightBrowsersPath;
  report.environment = { ...(report.environment ?? {}), chromium };
  await check("browser.chromium", "browser", false, async () =>
    chromium.available
      ? { status: "PASS", reason: `Playwright Chromium present at ${chromium.executable}` }
      : { status: "SKIP", reason: chromium.reason },
  );

  if (!chromium.available) {
    await check("browser.fixture", "browser", false, async () => ({
      status: "SKIP",
      reason: `real browser unavailable: ${chromium.reason}`,
    }));
  } else {
    await check("browser.fixture", "browser", true, async () => {
      const cacheDir = join(tempRoot, "caches", "browser");
      await seedCache(cacheDir, { siteUrl: fixture.url });
      const { value, audit } = await runClient(
        { label: "browser fixture", cacheDir, flagOn: false, profile: undefined },
        async (client) => {
          const init = await initializeLegacy(client);
          assert(
            init?.serverInfo?.name === "awwwards-mcp",
            `unexpected initialize serverInfo: ${JSON.stringify(init?.serverInfo)}`,
          );
          const list = await listTools(client);
          assert(
            list.length === EXPECTED_COUNTS.off.full,
            `expected ${EXPECTED_COUNTS.off.full} tools in the default profile, got ${list.length}`,
          );
          const structure = await toolJson(client, "analyze_page_structure", { url: fixture.url });
          assert(
            Array.isArray(structure.bands) && structure.bands.length >= 3,
            `expected at least 3 fixture bands, got ${JSON.stringify(structure.bands)}`,
          );
          const message = await client.request(
            "tools/call",
            { name: "capture_live_site", arguments: { url: fixture.url, inline: true } },
            120_000,
          );
          const classified = classifyToolResult(message);
          assert(classified.kind === "ok", `capture_live_site failed: ${firstLine(classified.text)}`);
          const image = (message.result.content ?? []).find((block) => block.type === "image");
          assert(image?.mimeType === "image/png", "capture_live_site returned no inline PNG");
          const bytes = Buffer.from(image.data, "base64");
          assert(
            bytes.length > 1_000 && bytes.subarray(0, 8).equals(PNG_SIGNATURE),
            `capture_live_site payload is not a PNG (${bytes.length} bytes)`,
          );
          return { bands: structure.bands.length, pngBytes: bytes.length };
        },
      );
      assertCleanAudit(audit);
      return {
        status: "PASS",
        reason: `installed server drove Chromium on the loopback fixture: ${value.bands} bands, ` +
          `${(value.pngBytes / 1024).toFixed(1)} KB PNG, clean stdio`,
        details: value,
      };
    });
  }

  await check("browser.atlas_policy", "browser", true, async () => {
    const list = tools.on.full;
    if (!Array.isArray(list)) {
      return { status: "SKIP", reason: "flag-on full tools/list unavailable; the surface check failed first" };
    }
    if (!list.some((tool) => tool.name === "capture_atlas")) {
      return { status: "SKIP", reason: "capture_atlas is not advertised (Phase 6A is not integrated)" };
    }
    const cacheDir = join(tempRoot, "caches", "browser-atlas-policy");
    await seedCache(cacheDir, { siteUrl: fixture.url });
    const before = fixture.requests.length;
    const { value, audit } = await runClient(
      { label: "atlas policy", cacheDir, flagOn: true, profile: undefined },
      async (client) => {
        await initializeLegacy(client);
        return client.callTool("capture_atlas", {
          slug: "qualify-fixture",
          path: "/",
          viewport: "desktop",
        });
      },
    );
    assertCleanAudit(audit);
    const classified = classifyToolResult(value);
    assert(
      classified.kind === "domain_error" && parseErrorCode(classified.text) === "PRIVATE_DESTINATION",
      `expected a PRIVATE_DESTINATION refusal, got ${classified.kind}: ${firstLine(classified.text)}`,
    );
    assert(
      fixture.requests.length === before,
      "capture_atlas reached the loopback fixture after supposedly refusing it",
    );
    return {
      status: "PASS",
      reason: "capture_atlas refused a loopback cached reference before any page request",
      details: { classification: classified.kind },
    };
  });

  await check("browser.atlas_capture", "browser", false, async () => ({
    status: "SKIP",
    reason: "positive Atlas capture needs a permitted non-loopback owned fixture; this run has no live network",
  }));

  const atlasPresent =
    Array.isArray(tools.on.full) &&
    tools.on.full.some((tool) => ATLAS_FULL_TOOLS.includes(tool.name));
  const aggregate = browserQualification({
    chromium: report.checks.find((entry) => entry.id === "browser.chromium"),
    fixture: report.checks.find((entry) => entry.id === "browser.fixture"),
    policy: report.checks.find((entry) => entry.id === "browser.atlas_policy"),
    capture: report.checks.find((entry) => entry.id === "browser.atlas_capture"),
    atlasPresent,
  });
  const entry = await check("browser.qualification", "browser", aggregate.required, async () => aggregate);
  report.qualificationScope = entry.status === "PASS" ? "full" : "offline-installed";
}

async function startFixture() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "/");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(FIXTURE);
  });
  await new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveStart);
  });
  const address = server.address();
  assert(address && typeof address === "object", "fixture server has no address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    requests,
    close: () =>
      new Promise((resolveClose) => {
        server.closeAllConnections?.();
        server.close(() => resolveClose());
      }),
  };
}

async function runQualification() {
  isolatedHome = join(tempRoot, "home");
  mkdirSync(isolatedHome, { recursive: true });
  realCache = defaultRealCache();
  realCacheBefore = realCache ? cacheFingerprint(realCache) : { exists: false };
  report.environment = {
    ...(report.environment ?? {}),
    isolatedHome,
    realCache: { path: realCache, existedBefore: realCacheBefore.exists },
  };

  const build = await check("artifact.build", "artifact", true, async () => {
    if (options.skipBuild) {
      assert(existsSync(join(ROOT, "dist", "cli.js")), "dist/cli.js is missing; run without --skip-build");
      const freshness = checkDistFreshness({
        srcDir: join(ROOT, "src"),
        distDir: join(ROOT, "dist"),
      });
      if (!freshness.ok) {
        return {
          status: "SKIP",
          reason: `--skip-build refused: ${freshness.reason}`,
          details: freshness,
        };
      }
      return {
        status: "PASS",
        reason: `using the existing dist (build skipped); ${freshness.reason}`,
        details: freshness,
      };
    }
    npm(["run", "build"]);
    assert(existsSync(join(ROOT, "dist", "cli.js")), "npm run build produced no dist/cli.js");
    return { status: "PASS", reason: "npm run build completed; dist/cli.js present" };
  });
  if (build.status === "SKIP") {
    report.notes.push(
      "artifact build was not qualified (stale dist under --skip-build); dependent checks were not run",
    );
    return;
  }
  requirePass(build, "artifact build");

  requirePass(
    await check("artifact.pack", "artifact", true, async () => {
      const packDir = join(tempRoot, "pack");
      mkdirSync(packDir, { recursive: true });
      const parsed = JSON.parse(
        npm(["pack", "--json", "--prefer-offline", "--pack-destination", packDir]).stdout,
      );
      const info = parsed?.[0];
      assert(info?.filename, "npm pack returned no filename");
      tarball = join(packDir, info.filename);
      const bytes = readFileSync(tarball);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const files = (info.files ?? []).map((file) => file.path);
      assert(files.length > 0, "npm pack reported no files");
      for (const required of ["package.json", "dist/cli.js", "dist/index-cli.js", "README.md", "ATLAS.md"]) {
        assert(files.includes(required), `packed artifact is missing ${required}`);
      }
      const forbidden = files.filter(
        (file) =>
          /^(src|test|scripts|node_modules|docs|coverage)\//.test(file) ||
          file.startsWith(".") ||
          file.includes("..") ||
          resolve(file) === file,
      );
      assert(forbidden.length === 0, `packed artifact leaks checkout files: ${forbidden.slice(0, 5).join(", ")}`);
      report.artifact = {
        filename: info.filename,
        sha256,
        bytes: bytes.length,
        files: files.length,
      };
      return {
        status: "PASS",
        reason: `${info.filename}: ${files.length} files, sha256 ${sha256.slice(0, 16)}…, no checkout files`,
        details: { filename: info.filename, sha256, bytes: bytes.length, files: files.length },
      };
    }),
    "artifact pack",
  );

  requirePass(
    await check("artifact.install", "artifact", true, async () => {
      const prefix = join(tempRoot, "prefix");
      mkdirSync(prefix, { recursive: true });
      npm([
        "install",
        "-g",
        "--prefix",
        prefix,
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        "--prefer-offline",
        tarball,
      ]);
      globalRoot = npm(["root", "-g", "--prefix", prefix]).stdout.trim();
      const globalPrefix = npm(["prefix", "-g", "--prefix", prefix]).stdout.trim();
      installedPkgDir = join(globalRoot, PKG.name);
      installedCli = join(installedPkgDir, "dist", "cli.js");
      installedIndexCli = join(installedPkgDir, "dist", "index-cli.js");
      assert(existsSync(join(installedPkgDir, "package.json")), `installed package missing at ${installedPkgDir}`);
      assert(existsSync(installedCli), `installed CLI missing at ${installedCli}`);
      assert(existsSync(installedIndexCli), `installed index CLI missing at ${installedIndexCli}`);
      const installed = JSON.parse(readFileSync(join(installedPkgDir, "package.json"), "utf8"));
      assert(installed.version === PKG.version, `installed version ${installed.version}, expected ${PKG.version}`);
      for (const [bin, target] of Object.entries(PKG.bin)) {
        assert(existsSync(join(installedPkgDir, target)), `${bin} target missing: ${target}`);
      }
      report.artifact = { ...report.artifact, installedVersion: installed.version };
      return {
        status: "PASS",
        reason: `${PKG.name}@${installed.version} installed under the throwaway prefix; all bins present`,
        details: { globalRoot, globalPrefix, packageDir: installedPkgDir },
      };
    }),
    "artifact install",
  );

  requirePass(
    await check("artifact.isolated", "artifact", true, async () => {
      const realTemp = realpathSync(tempRoot);
      assert(isInside(realpathSync(installedPkgDir), realTemp), "installed package resolves outside the temp root");
      assert(isInside(realpathSync(installedCli), realTemp), "installed CLI resolves outside the temp root");
      assert(!lstatSync(installedPkgDir).isSymbolicLink(), "installed package directory is a symlink");
      const needles = [ROOT, ROOT.replace(/\\/g, "/")];
      const offenders = [];
      for (const file of walkFiles(join(installedPkgDir, "dist"))) {
        if (!/\.[cm]?js$/.test(file)) continue;
        const text = readFileSync(file, "utf8");
        if (needles.some((needle) => text.includes(needle))) offenders.push(file);
      }
      assert(offenders.length === 0, `installed dist references the checkout: ${offenders.slice(0, 3).join(", ")}`);
      return {
        status: "PASS",
        reason:
          "CLI resolves inside the temp prefix, no symlinked package, and no installed dist file embeds the checkout path",
        details: { packageDir: installedPkgDir, cli: installedCli },
      };
    }),
    "artifact isolation",
  );

  const browserRuntime = linkBrowserRuntime();
  report.environment = { ...(report.environment ?? {}), browserRuntime };
  if (browserRuntime.failures.length > 0) report.notes.push(`browser runtime links: ${browserRuntime.failures.join("; ")}`);

  const guardDir = join(tempRoot, "guard");
  mkdirSync(guardDir, { recursive: true });
  copyFileSync(join(ROOT, "scripts", "egress-guard-marker.cjs"), join(guardDir, "egress-guard-marker.cjs"));
  copyFileSync(join(ROOT, "scripts", "v2-eval-no-egress.cjs"), join(guardDir, "v2-eval-no-egress.cjs"));
  guardPath = join(guardDir, "v2-eval-no-egress.cjs");

  fixture = await startFixture();

  await runSurface(false, "full");
  await runSurface(false, "core");
  await runSurface(false, "v2");
  await runSurface(true, "full");
  await runSurface(true, "core");
  await runSurface(true, "v2");
  await runSurfaceDeltas();
  await runBranchSchemas(false);
  await runBranchSchemas(true);
  await runAnnotations();
  await runAtlasToolProbes();
  await runV2BranchProbes();
  await runProtocol(false, "legacy");
  await runProtocol(false, "modern");
  await runProtocol(true, "legacy");
  await runProtocol(true, "modern");
  await runCli();
  await runBrowser();
}

async function finishCleanup() {
  if (fixture) {
    await fixture.close();
    fixture = null;
  }
  await check("cleanup.processes", "cleanup", true, async () => {
    const alive = spawned.filter((entry) => !entry.audit || entry.audit.exit === null);
    assert(
      alive.length === 0,
      `server process(es) never reported exit: ${alive.map((entry) => `${entry.label}(${entry.pid})`).join(", ")}`,
    );
    const unclosed = spawned.filter((entry) => entry.audit?.problems?.some((problem) => /stdio did not close/.test(problem)));
    assert(unclosed.length === 0, `server stdio did not close: ${unclosed.map((entry) => entry.label).join(", ")}`);
    return {
      status: "PASS",
      reason: `${spawned.length} spawned server process(es) reported exit and closed stdio`,
      details: { pids: spawned.map((entry) => entry.pid) },
    };
  });
  await check("cleanup.real_cache", "cleanup", true, async () => {
    if (!realCache || !realCacheBefore) {
      return { status: "SKIP", reason: "the real cache path was never resolved; no operator cache was touched" };
    }
    const after = cacheFingerprint(realCache);
    report.environment = {
      ...(report.environment ?? {}),
      realCache: {
        path: realCache,
        existedBefore: realCacheBefore.exists,
        existedAfter: after.exists,
      },
    };
    assert(
      realCacheBefore.exists === after.exists,
      after.exists
        ? `qualification created the real cache at ${realCache}`
        : `qualification removed the real cache at ${realCache}`,
    );
    assert(sameCacheFingerprint(realCacheBefore, after), `real cache changed during qualification: ${realCache}`);
    return {
      status: "PASS",
      reason: realCacheBefore.exists
        ? `operator cache at ${realCache} is unchanged (child HOME/APPDATA were isolated)`
        : `operator cache at ${realCache} was not created (child HOME/APPDATA were isolated)`,
      details: { path: realCache, existed: after.exists },
    };
  });
  await check("cleanup.temp", "cleanup", !options.keepTemp, async () => {
    if (options.keepTemp) {
      return { status: "SKIP", reason: `kept for inspection at ${tempRoot}` };
    }
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    assert(!existsSync(tempRoot), `temp root still exists: ${tempRoot}`);
    return { status: "PASS", reason: "temporary pack/install/cache/fixture root removed" };
  });
}

function writeReport() {
  const path = options.report;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

async function main() {
  tempRoot = mkdtempSync(join(tmpdir(), "awwwards-qualify-"));
  try {
    await runQualification();
  } catch (error) {
    await check("harness.failed", "harness", true, async () => {
      throw new Error(`qualification aborted: ${error instanceof Error ? error.message : String(error)}`);
    });
  } finally {
    await finishCleanup().catch((error) => {
      addCheck(report, {
        id: "harness.cleanup_failed",
        group: "harness",
        required: true,
        status: "FAIL",
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  }

  const flagOnSurface = report.checks.find((entry) => entry.id === "surface.full.flag_on");
  if (flagOnSurface?.status === "FAIL" && /missing Atlas tool/.test(flagOnSurface.reason)) {
    report.notes.push(
      "Phase 6A (Atlas tool surfaces) is not integrated on this base: the flag-on build still " +
        "advertises the pre-Atlas surface, so flag-on discovery, branch and Atlas runtime checks cannot pass.",
    );
  }
  const cliSkips = report.checks.filter(
    (entry) => entry.group === "cli" && entry.status === "SKIP" && entry.id.endsWith(".refusal"),
  );
  if (cliSkips.length > 0) {
    report.notes.push(
      "Phase 6B (Atlas CLI actions) is not integrated on this base: " +
        `${cliSkips.map((entry) => entry.id.replace("cli.", "").replace(".refusal", "")).join(", ")} ` +
        "remain unqualified; SKIP is never reported as PASS.",
    );
  }

  if (report.qualificationScope !== "full") {
    report.notes.push(
      "qualification scope is offline-installed: browser/positive-capture qualification did not pass, " +
        "so this run is INCOMPLETE rather than a full PASS.",
    );
  }

  finalizeReport(report, { qualificationScope: report.qualificationScope });
  const errors = validateReport(report);
  if (errors.length > 0) {
    report.validationErrors = errors;
    console.error(`installed-qualification: report validation failed\n- ${errors.join("\n- ")}`);
  }
  const reportPath = writeReport();
  console.log(renderHumanSummary(report));
  console.log(`\nreport: ${reportPath}`);
  if (errors.length > 0) process.exit(1);
  process.exit(exitCodeFor(report));
}

main().catch((error) => {
  console.error(`installed-qualification: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
