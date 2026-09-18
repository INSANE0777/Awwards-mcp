// awwwards-mcp doctor — when scraping doesn't work, this finds why and fixes it.
//
// Diagnoses every failure class the MCP can hit and applies the matching fix:
//   1. NETWORK   — awwwards.com blocked/challenged the request
//                  (fix: none available locally; reported with retry guidance)
//   2. DRIFT     — awwwards.com markup changed so parsers can't read pages
//                  (fix --fix: capture fresh raw HTML snapshots into docs/
//                   for the parser-drift issue; re-anchoring parsers is then
//                   a code change guided by the awwwards-doctor skill)
//   3. DEPS      — optional dependencies broken (playwright browsers, ffmpeg)
//                  (fix --fix: installs playwright chromium, npm i ffmpeg-static)
//   4. CACHE     — SQLite cache corrupt/locked/stale beyond TTL
//                  (fix --fix: rebuilds the index; corrupt DB is moved aside)
//
// Usage:
//   npm run doctor            # diagnose only, exit 0 healthy / 1 unhealthy
//   npm run doctor -- --fix   # diagnose AND apply available fixes
//   npm run doctor -- --json  # machine-readable report (for agents)
//
// Every fix is logged with what changed; nothing is deleted without "--fix",
// and cache fixes never touch live-fetched data — only the local rebuild.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  statSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = process.argv.includes("--fix");
const JSON_OUT = process.argv.includes("--json");

const cacheRoot = process.env.AWWWARDS_CACHE_DIR ?? join(homedir(), ".awwwards-mcp");
const cacheDb = join(cacheRoot, "cache.db");

const report = { healthy: true, checks: [], fixes: [] };

function check(name, ok, detail, fixable) {
  report.checks.push({ name, ok, detail, fixable: fixable ?? false });
  if (!ok) report.healthy = false;
  if (!JSON_OUT) {
    const mark = ok ? "✓" : "✗";
    console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function applied(fix, detail) {
  report.fixes.push({ fix, detail });
  if (!JSON_OUT) console.log(`  ⚒ fix: ${fix}${detail ? ` — ${detail}` : ""}`);
}

function run(cmd, args, opts = {}) {
  // npm/npx are .cmd shims on Windows: spawnSync can't exec them without a
  // shell (ENOENT). node must NOT go through a shell — its inline -e scripts
  // here contain spaces/newlines/quotes that shell-mode's raw arg join would
  // mangle — so the shell is scoped to the shim commands, and win32 only.
  const shell = process.platform === "win32" && /^(npm|npx)(\.cmd)?$/.test(cmd);
  const r = spawnSync(cmd, args, { stdio: "pipe", encoding: "utf8", shell, ...opts });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 awwwards-mcp/1.1 doctor";

// Pinned detail page (the same stable target the drift probe pins), fetched
// 1 s after the listing so the doctor keeps the client's 1 request/second
// politeness promise.
const DETAIL_URL = "https://www.awwwards.com/sites/gionatan-nese-26/";

// ---------- 1. NETWORK: can we reach awwwards.com at all? ----------
async function checkNetwork() {
  if (!JSON_OUT) console.log("\n[1/5] network — reachability");
  try {
    const res = await fetch("https://www.awwwards.com/websites/", {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(15000),
    });
    const html = await res.text().catch(() => "");
    const challenge = res.status !== 200 || html.includes("cf-chl") || html.includes("Assert Your Humanity");
    check("network", !challenge, challenge ? `blocked (HTTP ${res.status}${html.includes("cf-chl") ? ", challenge page" : ""}) — retry later; the client never retries through blocks; for deployment, egress IPs may need allowlisting` : `reachable (HTTP ${res.status})`);
    // Detail page, fetched 1 s later (politeness: 1 req/s, same as client & probe).
    let detailHtml = "";
    if (!challenge) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const dres = await fetch(DETAIL_URL, {
          headers: { "user-agent": UA },
          signal: AbortSignal.timeout(15000),
        });
        detailHtml = await dres.text().catch(() => "");
        const dchallenge = dres.status !== 200 || detailHtml.includes("cf-chl") || detailHtml.includes("Assert Your Humanity");
        if (!JSON_OUT) console.log(`  detail page: HTTP ${dres.status}${dchallenge ? " (blocked/challenge)" : ""}`);
      } catch (err) {
        if (!JSON_OUT) console.log(`  detail page: unreachable (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    return { html, detailHtml, challenge };
  } catch (err) {
    check("network", false, `unreachable: ${err instanceof Error ? err.message : String(err)} — check DNS/proxy/firewall`);
    return { html: "", detailHtml: "", challenge: true };
  }
}

// ---------- 2. DRIFT: do the parser anchors still exist on live pages? ----------
async function checkDrift(liveHtml, detailHtml) {
  if (!JSON_OUT) console.log("\n[2/5] parser-drift — anchors on live pages");
  const anchors = [
    { name: "parseListing[card JSON blob]", anchor: 'data-collectable-model-value="' },
    { name: "parseListing[rollover live-url]", anchor: 'class="figure-rollover__bt"' },
    { name: "parseListing[detail href]", anchor: 'href="/sites/' },
    { name: "parseListing[award tag]", anchor: "budget-tag--" },
  ];
  const drifted = anchors.filter((a) => !liveHtml || liveHtml.indexOf(a.anchor) < 0);
  const listingOk = drifted.length === 0;
  check("parser-drift", listingOk, listingOk
    ? "all listing anchors present on live page"
    : driftFixHint(drifted), true);

  // Elements-section blob verdict on the detail page — same signal as the
  // probe's parseElements[section blobs] row (sectionBlobCount in
  // scripts/parser-drift-probe.mjs), duplicated inline so this script stays
  // standalone. Section absent = legitimate; present with 0 collectable
  // blobs = drift (the emergence-magazine incident signal).
  const blocked = !detailHtml || detailHtml.includes("cf-chl") || detailHtml.includes("Assert Your Humanity");
  let elementsOk = true;
  if (blocked) {
    check("parser-drift-elements", true, "detail page not captured (blocked/challenge or fetch failed) — Elements-section verdict inconclusive");
  } else {
    const start = detailHtml.indexOf(">Elements</h2>");
    const end = start < 0 ? -1 : detailHtml.indexOf(">Color Palette</h2>", start);
    const section = start < 0 ? null : end > start ? detailHtml.slice(start, end) : detailHtml.slice(start);
    const BLOB = 'data-collectable-model-value="';
    let blobs = 0;
    if (section !== null) {
      for (let i = section.indexOf(BLOB); i >= 0; i = section.indexOf(BLOB, i + BLOB.length)) blobs++;
    }
    elementsOk = section === null || blobs > 0;
    check("parser-drift-elements", elementsOk, section === null
      ? "no elements section (legitimate)"
      : blobs > 0
        ? `elements blobs present (${blobs})`
        : "Elements section present but zero collectable blobs — detail markup drift", true);
  }
  return listingOk && elementsOk;
}

function driftFixHint(drifted) {
  void drifted;
  return "live page no longer carries parser anchors — awwwards.com markup changed";
}

// Drift fix: capture the exact raw pages the parsers can't read into docs/
// (gitignored) so the parser-drift issue/PR has its fixtures without bloating git.
function fixDrift(liveHtml, detailHtml) {
  if (!FIX) return;
  if (!liveHtml && !detailHtml) {
    applied("drift-snapshot", "skipped — no live HTML captured (network failed first)");
    return;
  }
  mkdirSync(join(root, "docs"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const captureDir = join(root, "docs", `drift-${stamp}`);
  mkdirSync(captureDir, { recursive: true });
  const wrote = [];
  if (liveHtml) {
    writeFileSync(join(captureDir, "listing.html"), liveHtml);
    wrote.push("listing.html");
  }
  if (detailHtml) {
    writeFileSync(join(captureDir, "detail.html"), detailHtml);
    wrote.push("detail.html");
  }
  applied(
    "drift-snapshot",
    `captured ${wrote.join(" + ")} → ${join("docs", `drift-${stamp}`)} ` +
      "— attach to the parser-drift tracking issue; re-anchor src/parsers.ts, update test/fixtures, then npm test",
  );
}

// ---------- 3. DEPS: optional playwright + ffmpeg usable? ----------
function checkDeps() {
  if (!JSON_OUT) console.log("\n[3/5] optional deps — playwright & ffmpeg");
  // playwright: resolvable + chromium actually launches. `playwright install
  // --dry-run` only prints locations (it can't verify), so launch for real.
  const pwRes = run("node", ["-e", 'import("playwright").then(()=>console.log("ok")).catch(e=>{console.error(e.message);process.exit(1)})']);
  if (pwRes.code !== 0) {
    check("playwright", false, "module not resolvable — capture/analyze/motion tools will fail (fixable with --fix: npm i -D playwright)");
    return;
  }
  const launchScript = 'import { chromium } from "playwright"; const b = await chromium.launch(); await b.close(); console.log("ok");';
  const launch = run("node", ["--input-type=module", "-e", launchScript], { timeout: 30000 });
  check("playwright-chromium", launch.code === 0, launch.code === 0
    ? "chromium launches"
    : `chromium launch failed: ${launch.out.slice(0, 200)} (fixable: npm run doctor -- --fix)`);
  // ffmpeg-static: used by record_site_motion; optional
  const ffRes = run("node", ["-e", 'import("ffmpeg-static").then(()=>console.log("ok")).catch(e=>{console.error(e.message);process.exit(1)})']);
  check("ffmpeg-static", ffRes.code === 0, ffRes.code === 0 ? "record_site_motion ready" : "not installed — record_site_motion will fail (fixable with --fix)");
}

function fixDeps() {
  if (!FIX) return;
  const pwRes = run("node", ["-e", 'import("playwright").then(()=>console.log("ok")).catch(()=>process.exit(1))']);
  if (pwRes.code !== 0) {
    const r = run("npm", ["i", "-D", "playwright"]);
    if (r.code === 0) applied("deps", "installed playwright (devDependency)");
    else applied("deps", `npm i -D playwright failed: ${r.out.slice(0, 200)}`);
  }
  const chromRes = run("npx", ["playwright", "install", "chromium"]);
  if (chromRes.code === 0) applied("deps", "playwright chromium installed — capture_live_site/analyze_page_structure/record_site_motion ready");
  else applied("deps", `chromium install failed: ${chromRes.out.slice(0, 200)}`);
  const ffRes = run("node", ["-e", 'import("ffmpeg-static").then(()=>console.log("ok")).catch(()=>process.exit(1))']);
  if (ffRes.code !== 0) {
    const r = run("npm", ["i", "-D", "ffmpeg-static"]);
    if (r.code === 0) applied("deps", "installed ffmpeg-static — record_site_motion ready");
  }
}

// ---------- 4. CACHE: SQLite cache usable + index fresh? ----------
function checkCache() {
  if (!JSON_OUT) console.log("\n[4/5] cache — SQLite usable & index fresh");
  const stat = existsSync(cacheDb) ? statSync(cacheDb) : null;
  if (!stat) {
    check("cache", true, `no cache DB yet at ${cacheDb} — search_sites still serves from polite live scraping; build the index (npm run index) for full depth`, true);
    return;
  }
  // probe the DB with node:sqlite (the same driver src/cache.ts uses);
  // a corrupt/locked DB fails its first read fast, so a 10s timeout suffices.
  const probe = run("node", ["--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    try {
      const db = new DatabaseSync(${JSON.stringify(cacheDb)}, { readOnly: true });
      db.prepare("SELECT COUNT(*) AS n FROM sites").get();
      db.close();
      console.log("ok");
    } catch (e) { console.error(e.message); process.exit(1); }
  `], { timeout: 10000 });
  if (probe.code === 0) {
    const ageDays = Math.floor((Date.now() - stat.mtimeMs) / 86400000);
    check(
      "cache",
      ageDays < 30,
      ageDays < 30 ? `cache DB alive (modified ${ageDays}d ago)` : `cache DB stale (${ageDays}d old) — background re-index should have caught this; force with --fix`,
      true,
    );
  } else {
    check("cache", false, `cache DB unreadable/locked: ${probe.out.slice(0, 200)} (fixable with --fix: DB moved aside and rebuilt)`, true);
  }
}

function fixCache() {
  if (!FIX) return;
  if (!existsSync(cacheDb)) {
    const r = run("npm", ["run", "index"]);
    if (r.code === 0) applied("cache", "index built (full-depth search ready)");
    else applied("cache", `index build failed/skipped: ${r.out.slice(0, 200)} — run npm run index manually (~4 min crawl)`);
    return;
  }
  const probe = run("node", ["--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    try {
      const db = new DatabaseSync(${JSON.stringify(cacheDb)}, { readOnly: true });
      db.prepare("SELECT COUNT(*) AS n FROM sites").get();
      db.close();
      console.log("ok");
    } catch (e) { console.error(e.message); process.exit(1); }
  `], { timeout: 10000 });
  if (probe.code === 0) {
    // DB fine — refresh it
    const r = run("npm", ["run", "index"]);
    if (r.code === 0) applied("cache", "index refreshed");
    else applied("cache", `index refresh failed: ${r.out.slice(0, 200)}`);
  } else {
    // DB corrupt/locked — move aside, rebuild
    const aside = join(tmpdir(), `awwwards-cache-corrupt-${Date.now()}.db`);
    try {
      renameSync(cacheDb, aside);
      applied("cache", `corrupt DB moved aside → ${aside}; rebuilding`);
      const r = run("npm", ["run", "index"]);
      if (r.code === 0) applied("cache", "index rebuilt on fresh DB");
      else applied("cache", `rebuild failed: ${r.out.slice(0, 200)} — run npm run index manually`);
    } catch (err) {
      applied("cache", `cannot move corrupt DB: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ---------- 5. PROGRAM: does the MCP itself boot? ----------
function checkBoot() {
  if (!JSON_OUT) console.log("\n[5/5] program — MCP server boots");
  const r = run("node", ["-e", 'import("./dist/cli.js").then(()=>{setTimeout(()=>process.exit(0),500)}).catch(e=>{console.error(e.message);process.exit(1)})'], { timeout: 8000, cwd: root });
  if (r.code !== 0 && !existsSync(join(root, "dist", "cli.js"))) {
    check("boot", false, "dist/cli.js missing — run npm run build (fixable with --fix)");
    if (FIX) {
      const b = run("npm", ["run", "build"]);
      if (b.code === 0) applied("program", "built dist/ — MCP entry ready");
      else applied("program", `build failed: ${b.out.slice(0, 200)}`);
    }
    return;
  }
  check("boot", r.code === 0, r.code === 0 ? "dist/cli.js boots (server transport waits for client)" : `boot failed: ${r.out.slice(0, 200)}`);
}

// ---------- main ----------
const { html, detailHtml } = await checkNetwork();
if (!JSON_OUT) console.log("");
const driftOk = await checkDrift(html, detailHtml);
if (FIX && !driftOk) fixDrift(html, detailHtml); // the documented --fix for DRIFT: snapshot both pages
checkDeps();
checkCache();
checkBoot();

if (FIX) {
  fixDeps();
  fixCache();
}

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    report.healthy
      ? "\nverdict: HEALTHY — nothing to fix"
      : `\nverdict: UNHEALTHY${FIX ? " — fixes applied above; re-run npm run doctor to re-check" : " — re-run with --fix to apply available fixes"}`,
  );
}
process.exit(report.healthy ? 0 : 1);
