// Bounded browser smoke for the packaged server: packs this checkout, installs
// the tarball into a throwaway global prefix with playwright/ffmpeg-static as
// siblings (the documented layout), serves a local static fixture, then makes
// two real MCP stdio calls to the installed dist/cli.js. No Awwwards traffic:
// a seeded temp cache keeps the background indexer and the daily npm-registry /
// environment probes from starting. Run `npm run build` first.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OVERALL_TIMEOUT_MS = 180_000;
const CALL_TIMEOUT_MS = 90_000;

const FIXTURE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>awwwards-mcp browser smoke</title>
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

const fail = (message) => {
  throw new Error(message);
};

if (!existsSync(join(ROOT, "dist", "cli.js"))) fail("dist/cli.js is missing - run `npm run build` first");

// Spawn npm through the CLI script when invoked by `npm run` (cross-platform,
// no .cmd shell); fall back to the platform shim for a direct node invocation.
function npm(args) {
  const npmCli = process.env.npm_execpath;
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 120_000,
      })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 120_000,
        shell: process.platform === "win32",
      });
  if (result.error) fail(`npm ${args[0]}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`npm ${args[0]} exited ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return result.stdout ?? "";
}

const temp = mkdtempSync(join(tmpdir(), "awwwards-browser-smoke-"));
const cacheDir = join(temp, "cache");
let child;
let http;

try {
  console.log("browser-smoke: pack + global install");
  const packed = JSON.parse(
    npm(["pack", "--json", "--pack-destination", temp]),
  );
  const tarball = join(temp, packed[0].filename);
  const prefix = join(temp, "prefix");
  mkdirSync(prefix, { recursive: true });
  npm(["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", "--ignore-scripts", tarball]);

  const globalRoot = npm(["root", "-g", "--prefix", prefix]).trim();
  const pkgDir = join(globalRoot, "awwwards-mcp");
  const cli = join(pkgDir, "dist", "cli.js");
  if (!existsSync(cli)) fail(`installed CLI missing at ${cli}`);

  // The documented side-by-side layout: playwright and ffmpeg-static are
  // siblings of the installed package, so its bare imports resolve. Junctions
  // (Windows) / directory symlinks avoid copying the dev dependencies.
  for (const dep of ["playwright", "ffmpeg-static"]) {
    const source = join(ROOT, "node_modules", dep);
    if (!existsSync(source)) fail(`dev dependency missing at ${source}`);
    symlinkSync(source, join(globalRoot, dep), process.platform === "win32" ? "junction" : "dir");
  }

  // Seed the installed package's cache: a fresh cache would start a 4-minute
  // background crawl, and the daily state files would probe npm and launch a
  // second chromium.
  const { Cache } = await import(pathToFileURL(join(pkgDir, "dist", "cache.js")).href);
  const cache = new Cache(cacheDir);
  const now = Date.now();
  cache.setMeta("index:status", {
    startedAt: now,
    finishedAt: now,
    pagesDone: 0,
    pagesTotal: 0,
    sitesIndexed: 0,
  });
  writeFileSync(join(cacheDir, "version-check.json"), JSON.stringify({ checkedAt: now }));
  writeFileSync(join(cacheDir, "env-check.json"), JSON.stringify({ checkedAt: now }));

  http = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FIXTURE);
  });
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const fixtureUrl = `http://127.0.0.1:${http.address().port}/`;

  child = spawn(process.execPath, [cli], {
    cwd: pkgDir,
    env: { ...process.env, AWWWARDS_CACHE_DIR: cacheDir, AWWWARDS_MCP_PROFILE: "full" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const pending = new Map();
  let buffer = "";
  let nextId = 1;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });

  function rpc(method, params, timeoutMs = 60_000) {
    const id = nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms; stderr: ${stderr.trim()}`));
      }, timeoutMs);
      pending.set(id, (response) => {
        clearTimeout(timer);
        if (response.error) reject(new Error(`${method}: ${response.error.message}`));
        else resolve(response.result);
      });
    });
  }

  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);

  async function callTool(name, args) {
    const result = await rpc("tools/call", { name, arguments: args }, CALL_TIMEOUT_MS);
    if (result.isError) {
      const text = (result.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      fail(`${name} returned isError: ${text || "(no text)"}`);
    }
    return result;
  }

    const overall = setTimeout(() => {
      child?.kill();
      if (http) http.close();
      rmSync(temp, { recursive: true, force: true });
      fail(`browser smoke exceeded ${OVERALL_TIMEOUT_MS} ms`);
    }, OVERALL_TIMEOUT_MS);

  try {
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "awwwards-browser-smoke", version: "0" },
    }, 30_000);
    if (init.serverInfo?.name !== "awwwards-mcp") {
      fail(`unexpected server identity: ${JSON.stringify(init.serverInfo)}`);
    }
    notify("notifications/initialized", {});

    const listed = await rpc("tools/list", {}, 30_000);
    const tools = listed.tools ?? [];
    if (tools.length !== 39) fail(`expected 39 tools in the default profile, got ${tools.length}`);
    console.log(`browser-smoke: connected to ${init.serverInfo.name}, ${tools.length} tools`);

    const structureResult = await callTool("analyze_page_structure", { url: fixtureUrl });
    const structureBlock = (structureResult.content ?? []).find((block) => block.type === "text");
    if (!structureBlock) fail("analyze_page_structure returned no text block");
    const structure = JSON.parse(structureBlock.text);
    if (!Array.isArray(structure.bands) || structure.bands.length < 3) {
      fail(`expected at least 3 fixture bands, got ${JSON.stringify(structure.bands)}`);
    }
    if (!structure.bands.some((band) => String(band.label).startsWith("#hero"))) {
      fail(`fixture hero band missing: ${JSON.stringify(structure.bands.map((band) => band.label))}`);
    }
    console.log(
      `browser-smoke: analyze_page_structure -> ${structure.bands.length} bands, ` +
        `totalHeight ${structure.totalHeight}, labels ${structure.bands.map((band) => band.label).join(",")}`,
    );

    const shotResult = await callTool("capture_live_site", { url: fixtureUrl, inline: true });
    const image = (shotResult.content ?? []).find((block) => block.type === "image");
    if (!image || image.mimeType !== "image/png") fail("capture_live_site returned no inline PNG");
    const bytes = Buffer.from(image.data, "base64");
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytes.length < 1_000 || !bytes.subarray(0, 8).equals(PNG)) {
      fail(`capture_live_site payload is not a PNG (${bytes.length} bytes)`);
    }
    const shotText = (shotResult.content ?? []).find((block) => block.type === "text")?.text ?? "";
    const savedPath = /saved to (.+?)(?:;|$)/.exec(shotText)?.[1]?.trim();
    if (savedPath && !existsSync(savedPath)) fail(`screenshot file missing on disk: ${savedPath}`);
    console.log(
      `browser-smoke: capture_live_site -> image/png ${(bytes.length / 1024).toFixed(1)} KB inline` +
        (savedPath ? `, saved ${basename(savedPath)}` : ""),
    );

    console.log("browser-smoke: PASS");
  } finally {
    clearTimeout(overall);
  }
} finally {
  child?.kill();
  if (http) await new Promise((resolve) => http.close(resolve));
  rmSync(temp, { recursive: true, force: true });
}
