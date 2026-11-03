#!/usr/bin/env node
// Protocol smoke: one legacy 2025-era connection and one modern 2026-07-28
// connection against the built CLI. It fails on stdout noise (including
// trailing/partial lines), wrong/missing response ids, a mixed catalog, any
// network attempt, or leftover temp state.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GUARD_MARKER } from "./egress-guard-marker.cjs";

const CLI = resolve(process.argv[2] ?? "dist/cli.js");
const GUARD = resolve("scripts/v2-eval-no-egress.cjs");
const TIMEOUT_MS = 30_000;
const QUIET_MS = 150;
const MODERN = "2026-07-28";
const LEGACY = "2025-06-18";
const PKG = JSON.parse(readFileSync("package.json", "utf8"));

async function prepareCache() {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-protocol-"));
  const now = Date.now();
  writeFileSync(join(dir, "version-check.json"), JSON.stringify({ checkedAt: now, latest: PKG.version }));
  writeFileSync(join(dir, "env-check.json"), JSON.stringify({ checkedAt: now }));
  // A completed index:status stops a cold start from launching the indexer.
  const { Cache } = await import(pathToFileURL(resolve("dist/cache.js")).href);
  new Cache(dir).setMeta("index:status", {
    finishedAt: now, pagesDone: 1, pagesTotal: 1, sitesIndexed: 0, skipped: 0,
  });
  return dir;
}

function run(messages, expectedIds, dir) {
  const child = spawn(process.execPath, ["--require", GUARD, CLI], {
    env: {
      ...process.env,
      AWWWARDS_CACHE_DIR: dir,
      AWWWARDS_AUTO_UPDATE: "0",
      AWWWARDS_MCP_DEBUG_MEMORY: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  const lines = [];
  const stderr = [];
  let quiet = null;
  let finishing = false;
  let done = false;
  let exitResolve = () => {};
  let closeResolve = () => {};
  const exitPromise = new Promise((resolveExit) => (exitResolve = resolveExit));
  const closePromise = new Promise((resolveClose) => (closeResolve = resolveClose));

  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      throw new Error(`temp cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  let rejectOnce = () => {};
  return new Promise((resolve, reject) => {
    rejectOnce = reject;
    let timer;
    const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

    const stopAndReject = async (error) => {
      if (done) return;
      done = true;
      if (quiet) clearTimeout(quiet);
      clearTimeout(timer);
      child.kill();
      const exited = await Promise.race([exitPromise.then(() => true), delay(2_000).then(() => false)]);
      if (!exited) {
        rejectOnce(new Error(`${error.message}; child did not terminate after SIGTERM; cache preserved at ${dir}`));
        return;
      }
      try {
        cleanup();
      } catch (cleanupError) {
        error = new Error(`${error.message}; ${cleanupError.message}`);
      }
      rejectOnce(error);
    };

    const finish = async () => {
      if (finishing || done) return;
      finishing = true;
      if (quiet) clearTimeout(quiet);
      clearTimeout(timer);
      child.kill();
      const exited = await Promise.race([exitPromise.then(() => true), delay(2_000).then(() => false)]);
      if (!exited) return stopAndReject(new Error("child did not terminate after SIGTERM"));
      // Keep draining until every stdio stream has closed, so bytes emitted
      // during shutdown are still validated.
      const closed = await Promise.race([closePromise.then(() => true), delay(2_000).then(() => false)]);
      if (!closed) return stopAndReject(new Error("stdio did not close after SIGTERM"));
      try {
        if (buffer.length > 0) throw new Error(`trailing partial stdout: ${buffer.slice(0, 120)}`);
        const parsed = lines.map((line, index) => parse(line, `line ${index + 1}`));
        if (parsed.length !== expectedIds.length) {
          throw new Error(`expected ${expectedIds.length} responses, got ${parsed.length}`);
        }
        for (let i = 0; i < expectedIds.length; i++) {
          if (parsed[i].id !== expectedIds[i]) {
            throw new Error(`response ${i + 1}: id=${parsed[i].id}, expected ${expectedIds[i]}`);
          }
        }
        const blocked = stderr.join("").split("\n").filter((line) => line.includes(GUARD_MARKER)).length;
        if (blocked > 0) throw new Error(`blocked ${blocked} network request(s) during startup`);
        cleanup();
        done = true;
        resolve(parsed.map((message) => message.result));
      } catch (error) {
        await stopAndReject(error);
      }
    };

    timer = setTimeout(() => void stopAndReject(new Error(`protocol smoke timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    child.on("exit", () => exitResolve());
    child.on("close", () => closeResolve());
    child.on("error", (error) => void stopAndReject(error));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (done) return;
      buffer += chunk;
      for (;;) {
        const i = buffer.indexOf("\n");
        if (i < 0) break;
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        lines.push(line);
      }
      if (lines.length === expectedIds.length && !quiet && !finishing) {
        quiet = setTimeout(() => void finish(), QUIET_MS);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

function parse(line, label) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    throw new Error(`${label}: non-JSON stdout line: ${line.slice(0, 200)}`);
  }
  if (message.jsonrpc !== "2.0") throw new Error(`${label}: missing jsonrpc 2.0`);
  if (message.error) throw new Error(`${label}: ${JSON.stringify(message.error)}`);
  if (!("id" in message)) throw new Error(`${label}: missing response id`);
  return message;
}

function toolNames(result, label) {
  const names = (result?.tools ?? []).map((tool) => tool.name);
  if (names.length !== 41) throw new Error(`${label}: expected 41 tools, got ${names.length}`);
  if (new Set(names).size !== names.length) throw new Error(`${label}: duplicate tool names`);
  if (!names.includes("capture_scene_3d") || !names.includes("verify_build")) {
    throw new Error(`${label}: expected scene and verify tools`);
  }
}

async function legacy() {
  const dir = await prepareCache();
  const values = await run([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LEGACY,
        capabilities: {},
        clientInfo: { name: "protocol-smoke", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ], [1, 2], dir);
  const init = values[0];
  if (init.protocolVersion !== LEGACY) {
    throw new Error(`legacy initialize: negotiated ${init.protocolVersion}, expected ${LEGACY}`);
  }
  if (init.serverInfo?.name !== "awwwards-mcp") throw new Error("legacy initialize: serverInfo missing");
  toolNames(values[1], "legacy tools/list");
}

async function modern() {
  const dir = await prepareCache();
  const meta = {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN,
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  };
  const values = await run([
    { jsonrpc: "2.0", id: 1, method: "server/discover", params: meta },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: meta },
  ], [1, 2], dir);
  const discover = values[0];
  if (!Array.isArray(discover.supportedVersions) || !discover.supportedVersions.includes(MODERN)) {
    throw new Error(`modern discover: supportedVersions=${JSON.stringify(discover.supportedVersions)}`);
  }
  toolNames(values[1], "modern tools/list");
}

try {
  await legacy();
  await modern();
  console.log("protocol-smoke: legacy 2025-06-18 + modern 2026-07-28 PASS (41 tools each)");
} catch (error) {
  console.error(`protocol-smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
