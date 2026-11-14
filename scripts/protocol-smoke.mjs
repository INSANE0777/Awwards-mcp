#!/usr/bin/env node
// Protocol smoke: both MCP eras, every profile surface for the current Atlas
// flag, representative tool calls, typed failures, output-schema success/error,
// annotations, cancellation (full/v2) and a clean stdout channel. Each session
// runs against its own temp cache under the OS temp directory; the seeded
// index:status timestamp is read back through a tool call, so a fallback to the
// user's real cache fails the run. It also fails on stdout noise, trailing or
// partial lines, wrong/duplicate/missing response ids, blocked egress, a
// non-terminating child, or leftover temp state.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { GUARD_MARKER } from "./egress-guard-marker.cjs";

const CLI = resolve(process.argv[2] ?? "dist/cli.js");
const GUARD = resolve("scripts/v2-eval-no-egress.cjs");
const REQUEST_TIMEOUT_MS = 20_000;
// Must outlast the cancelled call's own timeout: a server that ignores the
// cancellation answers when the call times out, inside this window.
const CANCEL_SETTLE_MS = 2_500;
const CANCELLED_CALL_TIMEOUT_MS = 1_000;
const MODERN = "2026-07-28";
const LEGACY = "2025-06-18";
const ATLAS = process.env.AWWWARDS_MCP_ATLAS === "1";
const PKG = JSON.parse(readFileSync("package.json", "utf8"));
const SURFACES = { full: ATLAS ? 45 : 41, core: 13, v2: ATLAS ? 16 : 15 };
const ATLAS_FLAT = ["search_atlas", "get_atlas", "capture_atlas", "export_evidence_pack"];
const ANNOTATIONS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
const META = {
  _meta: {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientCapabilities": {},
  },
};

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

let fixtureServer;
let fixtureBase;
const tempDirs = [];

function prepareCache(label) {
  const dir = mkdtempSync(join(tmpdir(), `awwwards-protocol-${label}-`));
  tempDirs.push(dir);
  assert(
    realpathSync(dir).startsWith(`${realpathSync(tmpdir())}${sep}`),
    `cache ${dir} is not under the OS temp directory`,
  );
  assert(resolve(dir) !== resolve(join(homedir(), ".awwwards-mcp")), "cache resolves to the real user cache");
  const now = Date.now();
  const finishedAt = now - 60_000 - tempDirs.length;
  writeFileSync(join(dir, "version-check.json"), JSON.stringify({ checkedAt: now, latest: PKG.version }));
  writeFileSync(join(dir, "env-check.json"), JSON.stringify({ checkedAt: now }));
  return { dir, finishedAt };
}

async function seedCache(dir, finishedAt) {
  const { Cache } = await import(pathToFileURL(resolve("dist/cache.js")).href);
  new Cache(dir).setMeta("index:status", {
    finishedAt,
    pagesDone: 1,
    pagesTotal: 1,
    sitesIndexed: 0,
    skipped: 0,
  });
}

function startClient({ dir, profile, label }) {
  const env = {
    ...process.env,
    AWWWARDS_CACHE_DIR: dir,
    AWWWARDS_MCP_PROFILE: profile,
    AWWWARDS_AUTO_UPDATE: "0",
    AWWWARDS_MCP_DEBUG_MEMORY: "0",
  };
  if (ATLAS) env.AWWWARDS_MCP_ATLAS = "1";
  else {
    delete env.AWWWARDS_MCP_ATLAS;
    delete env.AWARDS_MCP_ATLAS;
  }
  const child = spawn(process.execPath, ["--require", GUARD, CLI], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });

  const pending = new Map();
  const responded = new Set();
  const problems = [];
  let buffer = "";
  let stderr = "";
  let nextId = 1;
  let exit = null;
  let closed = false;
  let spawnError = null;

  const exitPromise = new Promise((done) => {
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      done(exit);
    });
  });
  const closePromise = new Promise((done) => {
    child.once("close", () => {
      closed = true;
      done();
    });
  });
  child.once("error", (error) => {
    spawnError = error;
    problems.push(`${label}: child error: ${error.message}`);
  });

  const ingest = (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      problems.push(`${label}: non-JSON stdout line: ${line.slice(0, 160)}`);
      return;
    }
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
      problems.push(`${label}: non-JSON-RPC stdout line: ${line.slice(0, 160)}`);
      return;
    }
    if (message.id === undefined) {
      problems.push(`${label}: unsolicited server notification: ${line.slice(0, 160)}`);
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) {
      problems.push(
        `${label}: ${responded.has(message.id) ? "duplicate" : "unknown"} response id ${message.id}`,
      );
      return;
    }
    pending.delete(message.id);
    responded.add(message.id);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== "") ingest(line);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  function request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = nextId++;
    const message = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    const promise = new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`${label}: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer, method });
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(id);
        rejectRequest(new Error(`${label}: ${method} write failed: ${error.message}`));
      });
    });
    return Object.assign(promise, { id });
  }

  async function result(method, params, timeoutMs) {
    const message = await request(method, params, timeoutMs);
    if (message.error) {
      throw new Error(`${label}: ${method}: ${message.error.message ?? JSON.stringify(message.error)}`);
    }
    return message.result;
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  function forget(id) {
    const waiter = pending.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(id);
  }

  function killTree(force) {
    if (!child.pid) return;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
        stdio: "ignore",
      });
      return;
    }
    try {
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      /* already gone */
    }
  }

  async function stop() {
    const exitedEarly = exit;
    for (const [id, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`${label}: ${waiter.method} still pending at shutdown`));
      pending.delete(id);
    }
    if (!spawnError && !exit) {
      killTree(false);
      let terminated = await Promise.race([exitPromise.then(() => true), delay(2_000).then(() => false)]);
      if (!terminated) {
        killTree(true);
        terminated = await Promise.race([exitPromise.then(() => true), delay(3_000).then(() => false)]);
      }
      if (!terminated) problems.push(`${label}: child ${child.pid} did not terminate`);
    }
    await Promise.race([closePromise, delay(2_000)]);
    if (exitedEarly && exitedEarly.code !== 0) {
      problems.push(
        `${label}: child exited early with code ${exitedEarly.code} signal ${exitedEarly.signal}`,
      );
    }
    if (buffer.length > 0) problems.push(`${label}: trailing partial stdout: ${buffer.slice(0, 160)}`);
    if (!closed) problems.push(`${label}: stdio did not close`);
    const blocks = stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes(GUARD_MARKER));
    if (blocks.length > 0) problems.push(`${label}: blocked egress: ${blocks.join(" | ")}`);
    if (/server error|background index failed|background self-update failed/.test(stderr)) {
      problems.push(`${label}: server stderr reported an error: ${stderr.slice(0, 240)}`);
    }
    if (problems.length > 0) throw new Error(problems.join("; "));
  }

  return { request, result, notify, forget, stop, responded, get stderr() { return stderr; } };
}

function textJson(message) {
  const text = (message.result?.content ?? []).find((block) => block.type === "text")?.text;
  assert(typeof text === "string", "tool result has no text block");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`tool result text is not JSON: ${text.slice(0, 160)}`);
  }
}

function toolText(message) {
  return (message.result?.content ?? []).find((block) => block.type === "text")?.text ?? "";
}

function assertSuccess(message, label) {
  assert(!message.error, `${label}: JSON-RPC error: ${message.error?.message ?? "unknown"}`);
  const result = message.result;
  assert(result && typeof result === "object", `${label}: missing result`);
  assert(result.isError !== true, `${label}: isError true: ${toolText(message).slice(0, 160)}`);
  return result;
}

function assertToolError(message, label) {
  assert(!message.error, `${label}: JSON-RPC error: ${message.error?.message ?? "unknown"}`);
  assert(message.result?.isError === true, `${label}: expected isError true`);
  assert(message.result.structuredContent === undefined, `${label}: error result carried structuredContent`);
  return toolText(message);
}

function requestMeta(era) {
  return era === "modern" ? META : {};
}

function assertSurface(tools, profile, era) {
  const label = `${profile} ${era}`;
  const names = tools.map((tool) => tool.name);
  assert(names.length === SURFACES[profile], `${label}: expected ${SURFACES[profile]} tools, got ${names.length}`);
  assert(new Set(names).size === names.length, `${label}: duplicate tool names`);
  for (const tool of tools) {
    for (const hint of ANNOTATIONS) {
      assert(typeof tool.annotations?.[hint] === "boolean", `${label}: ${tool.name} missing boolean ${hint}`);
    }
  }
  const atlasPresent = ATLAS_FLAT.filter((name) => names.includes(name));
  if (profile === "core" || !ATLAS) {
    assert(atlasPresent.length === 0, `${label}: unexpected Atlas tools ${atlasPresent.join(", ")}`);
  } else if (profile === "full") {
    assert(atlasPresent.length === ATLAS_FLAT.length, `${label}: missing Atlas tool(s)`);
  } else {
    assert(
      atlasPresent.length === 1 && atlasPresent[0] === "export_evidence_pack",
      `${label}: v2 flag-on Atlas surface should add only export_evidence_pack`,
    );
  }
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  if (profile !== "core") {
    const statusTool = profile === "v2" ? "get_index" : "get_index_status";
    assert(byName.get(statusTool)?.outputSchema, `${label}: ${statusTool} has no advertised outputSchema`);
  }
  if (ATLAS && profile === "full") {
    for (const name of ["search_atlas", "get_atlas"]) {
      assert(byName.get(name)?.annotations?.readOnlyHint === true, `${label}: ${name} must be read-only`);
      assert(byName.get(name)?.annotations?.openWorldHint === false, `${label}: ${name} must be closed-world`);
    }
    assert(byName.get("capture_atlas")?.annotations?.openWorldHint === true, `${label}: capture_atlas must be open-world`);
    assert(byName.get("capture_atlas")?.annotations?.idempotentHint === false, `${label}: capture_atlas must not be idempotent`);
    assert(byName.get("export_evidence_pack")?.annotations?.idempotentHint === true, `${label}: export_evidence_pack must be idempotent`);
  }
  if (profile === "v2") {
    assert(byName.get("capture_page")?.annotations?.readOnlyHint === false, `${label}: capture_page must not be read-only`);
  }
  return names;
}

async function handshake(client, era) {
  if (era === "legacy") {
    const init = await client.result("initialize", {
      protocolVersion: LEGACY,
      capabilities: {},
      clientInfo: { name: "protocol-smoke", version: "1" },
    });
    assert(init.protocolVersion === LEGACY, `legacy initialize: negotiated ${init.protocolVersion}`);
    assert(init.serverInfo?.name === "awwwards-mcp", "legacy initialize: serverInfo missing");
    assert(init.capabilities?.tools, "legacy initialize: tools capability missing");
    client.notify("notifications/initialized", {});
    return;
  }
  const discover = await client.result("server/discover", META);
  assert(
    Array.isArray(discover.supportedVersions) && discover.supportedVersions.includes(MODERN),
    `modern discover: supportedVersions=${JSON.stringify(discover.supportedVersions)}`,
  );
  assert(discover.capabilities?.tools, "modern discover: tools capability missing");
}

async function stackSuccess(client, profile, era) {
  const meta = requestMeta(era);
  const url = `${fixtureBase}/stack`;
  const message =
    profile === "v2"
      ? await client.request("tools/call", {
          name: "inspect_page",
          arguments: { request: { kind: "stack", url, timeoutMs: 3000 } },
          ...meta,
        })
      : await client.request("tools/call", {
          name: "analyze_stack",
          arguments: { url, timeoutMs: 3000 },
          ...meta,
        });
  assertSuccess(message, `${profile} ${era}: stack call`);
  const data = textJson(message);
  assert(data.framework === "next", `${profile} ${era}: stack framework=${data.framework}`);
}

async function outputSchemaSuccess(client, profile, era, finishedAt) {
  if (profile === "core") return;
  const meta = requestMeta(era);
  const message =
    profile === "v2"
      ? await client.request("tools/call", {
          name: "get_index",
          arguments: { request: { kind: "status" } },
          ...meta,
        })
      : await client.request("tools/call", { name: "get_index_status", arguments: {}, ...meta });
  const result = assertSuccess(message, `${profile} ${era}: status call`);
  const data = textJson(message);
  assert(data.lastSuccessfulFinishAt === finishedAt, `${profile} ${era}: status read the wrong cache`);
  assert(result.structuredContent && typeof result.structuredContent === "object", `${profile} ${era}: missing structuredContent`);
  assert(
    result.structuredContent.lastSuccessfulFinishAt === finishedAt,
    `${profile} ${era}: structuredContent read the wrong cache`,
  );
  assert(result.structuredContent.sitesCount === 0, `${profile} ${era}: unexpected seeded site count`);
  return result;
}

async function typedFailures(client, profile, era) {
  const meta = requestMeta(era);
  const invalid =
    profile === "v2"
      ? await client.request("tools/call", {
          name: "inspect_page",
          arguments: { request: { kind: "stack" } },
          ...meta,
        })
      : await client.request("tools/call", { name: "get_site_details", arguments: { slug: "" }, ...meta });
  const invalidText = assertToolError(invalid, `${profile} ${era}: validation`);
  assert(
    invalidText.startsWith("Input validation error:"),
    `${profile} ${era}: validation text=${invalidText.slice(0, 160)}`,
  );
  assert(
    invalidText.includes(profile === "v2" ? "inspect_page" : "get_site_details"),
    `${profile} ${era}: validation text does not name the tool`,
  );

  const badSchema =
    profile === "v2"
      ? await client.request("tools/call", {
          name: "get_index",
          arguments: { request: { kind: "status", extra: true } },
          ...meta,
        })
      : await client.request("tools/call", { name: "verify_build", arguments: {}, ...meta });
  assertToolError(badSchema, `${profile} ${era}: error result without structuredContent`);

  const unknown = await client.request("tools/call", {
    name: "__protocol_smoke_missing__",
    arguments: {},
    ...meta,
  });
  assert(unknown.error?.code === -32602, `${profile} ${era}: unknown tool should return -32602, got ${JSON.stringify(unknown.error)}`);
}

async function atlasChecks(client, profile, era) {
  const meta = requestMeta(era);
  if (!ATLAS) {
    if (profile !== "v2") return;
    const disabled = await client.request("tools/call", {
      name: "get_index",
      arguments: { request: { kind: "atlas_status" } },
      ...meta,
    });
    const result = disabled.result;
    assert(result?.isError === true, "v2 flag-off: atlas_status should fail");
    const text = result.content?.find((block) => block.type === "text")?.text ?? "";
    assert(text.includes("FEATURE_DISABLED"), `v2 flag-off: atlas_status text=${text.slice(0, 160)}`);
    assert(result.structuredContent === undefined, "v2 flag-off: atlas_status carried structuredContent");
    return;
  }

  const status =
    profile === "v2"
      ? await client.request("tools/call", {
          name: "get_index",
          arguments: { request: { kind: "atlas_status" } },
          ...meta,
        })
      : profile === "full"
        ? await client.request("tools/call", { name: "get_atlas", arguments: { kind: "status" }, ...meta })
        : null;
  if (status) {
    const result = assertSuccess(status, `${profile} ${era}: Atlas status`);
    const data = textJson(status);
    assert(data.schemaVersion === "awwwards-atlas-v1", `${profile} ${era}: Atlas status envelope missing`);
    assert(result.structuredContent?.schemaVersion === "awwwards-atlas-v1", `${profile} ${era}: Atlas status structuredContent`);
  }

  if (profile === "core") return;
  const pack = await client.request("tools/call", {
    name: "export_evidence_pack",
    arguments: { regionIds: ["0".repeat(64)] },
    ...meta,
  });
  const error = assertToolError(pack, `${profile} ${era}: export_evidence_pack`);
  const parsed = JSON.parse(error);
  assert(parsed.error?.code === "INVALID_SELECTION", `${profile} ${era}: Atlas typed error=${parsed.error?.code}`);
}

async function cancellation(client, profile, era) {
  if (profile === "core") return;
  const meta = requestMeta(era);
  const url = `${fixtureBase}/hang`;
  const cancelled =
    profile === "v2"
      ? client.request("tools/call", {
          name: "inspect_page",
          arguments: { request: { kind: "stack", url, timeoutMs: CANCELLED_CALL_TIMEOUT_MS } },
          ...meta,
        })
      : client.request("tools/call", {
          name: "analyze_stack",
          arguments: { url, timeoutMs: CANCELLED_CALL_TIMEOUT_MS },
          ...meta,
        });
  client.notify("notifications/cancelled", { requestId: cancelled.id, reason: "protocol-smoke" });
  await delay(CANCEL_SETTLE_MS);
  assert(!client.responded.has(cancelled.id), `${profile} ${era}: cancelled request still returned a response`);
  client.forget(cancelled.id);
  const after =
    profile === "v2"
      ? await client.request("tools/call", { name: "get_index", arguments: { request: { kind: "status" } }, ...meta })
      : await client.request("tools/call", { name: "get_index_status", arguments: {}, ...meta });
  assertSuccess(after, `${profile} ${era}: call after cancellation`);
}

async function runSession(profile, era) {
  const { dir, finishedAt } = prepareCache(`${profile}-${era}`);
  try {
    await seedCache(dir, finishedAt);
    const client = startClient({ dir, profile, label: `${profile} ${era}` });
    try {
      await handshake(client, era);
      const list = await client.result("tools/list", era === "modern" ? META : {});
      assert(Array.isArray(list.tools), `${profile} ${era}: tools/list missing tools`);
      assertSurface(list.tools, profile, era);
      await stackSuccess(client, profile, era);
      await outputSchemaSuccess(client, profile, era, finishedAt);
      await typedFailures(client, profile, era);
      await atlasChecks(client, profile, era);
      await cancellation(client, profile, era);
    } finally {
      await client.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const index = tempDirs.indexOf(dir);
    if (index >= 0) tempDirs.splice(index, 1);
  }
}

async function startFixture() {
  fixtureServer = createServer((request, response) => {
    if (request.url === "/hang") return;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><html><head><title>protocol smoke</title></head><body><div id="__next"></div>' +
        '<script id="__NEXT_DATA__" type="application/json">{}</script></body></html>',
    );
  });
  await new Promise((done, fail) => {
    fixtureServer.once("error", fail);
    fixtureServer.listen(0, "127.0.0.1", done);
  });
  fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`;
}

async function closeFixture() {
  if (!fixtureServer) return;
  await new Promise((done) => fixtureServer.close(() => done()));
  fixtureServer = undefined;
}

try {
  await startFixture();
  for (const profile of ["full", "core", "v2"]) {
    for (const era of ["legacy", "modern"]) {
      await runSession(profile, era);
    }
    console.log(
      `protocol-smoke: ${profile} ${ATLAS ? "on" : "off"} ${SURFACES[profile]} tools, ` +
        "legacy 2025-06-18 + modern 2026-07-28 PASS",
    );
  }
  console.log(
    `protocol-smoke: PASS (${ATLAS ? "Atlas on" : "Atlas off"}; surfaces ${SURFACES.full}/${SURFACES.core}/${SURFACES.v2}; ` +
      "clean stdout, cancelled requests stayed cancelled, temp caches removed)",
  );
} catch (error) {
  console.error(`protocol-smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await closeFixture();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
