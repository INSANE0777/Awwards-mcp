// Generates assets/demo.gif from four frames of REAL awwwards-mcp output.
// Re-run any time: node scripts/make-demo.mjs   (needs `npm run build` first)
// Frames: (1) search_sites results  (2) get_site_details DNA
//         (3) record_site_motion filmstrip (our own RIDGE build)
//         (4) analyze_page_structure band map (our own build)
//
// Politeness contract (see README "How it works"):
// - At most TWO www.awwwards.com page fetches per run — one listing
//   (buildFilterUrl + getHtml, exactly the search_sites handler shape in
//   src/server.ts) and one detail page — spaced >=1s by the client's built-in
//   RateLimiter, both carrying the client's User-Agent.
// - Blocks (BlockedError, HTTP 403/429) are NEVER retried: the frame falls
//   back to the committed test fixtures (test/fixtures/listing.html /
//   detail.html) and the frame header says so.
// - The 4 CDN thumbnail fetches mirror what a single search_sites call already
//   does inline (client.getThumbnail, the siteImage path in src/server.ts).
// - Frames 3 and 4 record OUR OWN RIDGE build via file:// — never an
//   Awwwards recording, no Awwwards content beyond the two polite page fetches.

import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
// dist is CommonJS-free plain ESM compiled from src/ — import by file URL so
// the script works from any cwd (and on Windows paths with spaces).
const dist = (m) => import(pathToFileURL(join(root, "dist", `${m}.js`)).href);

const outDir = resolve(root, "assets/demo-src");
mkdirSync(outDir, { recursive: true });

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const shell = (header, body) => `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#101014;color:#e8e8ee;font:11px/1.5 "Segoe UI",Arial,sans-serif;padding:10px 12px;overflow:hidden}
  .hdr{color:#8f8fa3;font-size:9px;letter-spacing:.2em;text-transform:uppercase;margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .row{display:flex;gap:8px;margin-bottom:6px;align-items:center}
  .row img{width:64px;height:48px;object-fit:cover;border-radius:3px;background:#222}
  .t{font-weight:600;font-size:11px;line-height:1.35;max-width:384px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .m{color:#9a9ab0;font-size:9px;line-height:1.35;max-width:384px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .aw{color:#e8c268}
  .sw{display:inline-block;border-radius:3px;border:1px solid #333;flex:none}
  .hex{color:#9a9ab0;font-size:9px;margin-right:8px}
  .desc{color:#c9c9d6;font-size:10px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  pre{margin:0;white-space:pre-wrap;color:#cde3c8;font-size:9.5px}
</style><div class="hdr">${esc(header)}</div>${body}`;

async function shot(html, name) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 480, height: 300 },
      deviceScaleFactor: 2, // 960x600 PNG → crisp after ffmpeg scales to 480 wide
    });
    const page = await context.newPage();
    // Data-URI-only pages make networkidle instant; if it ever stalls, fall
    // back to "load" rather than hang.
    await page
      .setContent(html, { waitUntil: "networkidle" })
      .catch(() => page.setContent(html, { waitUntil: "load" }));
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(outDir, `${name}.png`) });
    await context.close();
  } finally {
    await browser.close();
  }
  console.log("frame:", name);
}

// ---------------------------------------------------------------------------
// Frame 1 — search_sites: ONE live listing fetch via the real client, exactly
// the search_sites handler call shape (getHtml(buildFilterUrl(...)) → parseListing).
// The award: sotd filter is used so frame 2's first result is a SOTD winner
// with full design DNA (a fresh nominee page would parse empty — see frame 2).
// ---------------------------------------------------------------------------
const { AwwwardsClient, buildFilterUrl } = await dist("awwwards");
const parsers = await dist("parsers");
const client = new AwwwardsClient(); // RateLimiter(1000) built in → >=1s between page fetches

const SEARCH_FILTERS = { award: "sotd" };
let sites;
let searchSource = "live awwwards.com";
try {
  const html = await client.getHtml(buildFilterUrl(SEARCH_FILTERS));
  sites = parsers.parseListing(html);
} catch (err) {
  console.log(
    `search: live listing fetch failed (${err instanceof Error ? err.message : String(err)}) — rendering from test/fixtures/listing.html`,
  );
  sites = parsers.parseListing(
    readFileSync(join(root, "test/fixtures/listing.html"), "utf8"),
  );
  searchSource = "committed fixture (live fetch blocked)";
}
if (sites.length === 0) throw new Error("listing parse produced 0 sites (live AND fixture) — aborting");
sites = sites.sort((a, b) => b.createdAt - a.createdAt).slice(0, 4);

// Same inline-image behavior as the search_sites handler (siteImage): CDN
// thumbnails through the client's UA; failures degrade to metadata-only rows.
const thumbs = await Promise.all(
  sites.map(async (s) => {
    try {
      const buf = await client.getThumbnail(s.thumbnailPath, 440);
      return "data:image/jpeg;base64," + buf.toString("base64");
    } catch {
      return null;
    }
  }),
);

const searchBody = sites
  .map(
    (s, i) => `<div class="row">
  ${thumbs[i] ? `<img src="${thumbs[i]}" alt="">` : `<img alt="">`}
  <div>
    <div class="t">${esc(s.title)}</div>
    <div class="m">${esc(s.tags.slice(0, 3).join(", "))}${s.awards.length ? ` · <span class="aw">${esc(s.awards.join(", "))}</span>` : ""}</div>
  </div>
</div>`,
  )
  .join("");
await shot(
  shell(`search_sites · award: sotd — ${sites.length} of ${sites.length} · ${searchSource}`, searchBody),
  "frame-search",
);

// ---------------------------------------------------------------------------
// Frame 2 — get_site_details: SECOND (and last) page fetch, >=1s after the
// listing via the client's rate limiter. Slug = frame 1's first result, with
// the l-i-s-a fallback; on failure the committed detail.html fixture (which
// pairs with slug l-i-s-a in the tests) feeds parseDetail instead.
// ---------------------------------------------------------------------------
let detail;
let detailSource = "live awwwards.com";
try {
  const slug = sites[0]?.slug ?? "l-i-s-a";
  const html = await client.getHtml(`/sites/${slug}`);
  detail = parsers.parseDetail(html, slug);
} catch (err) {
  console.log(
    `details: live detail fetch failed (${err instanceof Error ? err.message : String(err)}) — rendering from test/fixtures/detail.html`,
  );
  detail = parsers.parseDetail(
    readFileSync(join(root, "test/fixtures/detail.html"), "utf8"),
    "l-i-s-a",
  );
  detailSource = "committed fixture (live fetch blocked)";
}

const d = detail;
const paletteHtml = d.palette.length
  ? `<div style="display:flex;align-items:center;flex-wrap:wrap;margin-bottom:6px">${d.palette
      .map(
        (h) =>
          `<span style="display:flex;align-items:center;margin-bottom:2px"><span class="sw" style="width:18px;height:18px;background:${esc(h)}"></span><span class="hex">${esc(h)}</span></span>`,
      )
      .join("")}</div>`
  : "";
const detailBody = `
  <div class="t" style="font-size:14px;margin-bottom:2px">${esc(d.title ?? d.slug)}</div>
  <div class="m" style="margin-bottom:6px">
    ${d.awards.map((a) => `<span class="aw">${esc(a.title)} · ${esc(a.date)}</span>`).join(" &nbsp; ")}
    ${d.score != null ? ` · jury score ${d.score}/10` : ""}
  </div>
  ${paletteHtml}
  ${d.technologies.length ? `<div class="m" style="margin-bottom:6px"><b style="color:#c9c9d6">Tech:</b> ${esc(d.technologies.join(", "))}</div>` : ""}
  ${d.description ? `<div class="desc">${esc(d.description)}</div>` : ""}
`;
await shot(shell(`get_site_details · ${d.slug} · ${detailSource}`, detailBody), "frame-details");

// ---------------------------------------------------------------------------
// Frame 3 — record_site_motion on OUR OWN RIDGE build (file://).
// Real signature: recordSiteMotion(url, { cacheImagesDir, frames }) →
// { file, base64, frames } | { error } — the filmstrip JPEG arrives as base64.
// On any failure: dark banner frame, script continues. Never Awwwards content.
// ---------------------------------------------------------------------------
const { recordSiteMotion } = await dist("motion");
const demoSiteUrl = pathToFileURL(resolve(root, "showcase/ridge/index.html")).href;
let stripDataUri = null;
try {
  const motion = await recordSiteMotion(demoSiteUrl, {
    cacheImagesDir: outDir, // gitignored — the strip stays local like the frames
    frames: 4, // 2x2 grid — the recording yields ~8 tiles at 1 frame/4s, so the grid always fills (12 → 4x3 left empty black cells and unreadably small tiles)
  });
  if ("error" in motion) throw new Error(motion.error);
  stripDataUri = "data:image/jpeg;base64," + motion.base64;
  console.log("motion: recorded", motion.file, `(${motion.frames}-tile filmstrip)`);
} catch (err) {
  console.log(
    `motion: recording failed (${err instanceof Error ? err.message : String(err)}) — rendering banner frame`,
  );
}
const motionBody = stripDataUri
  ? `<img src="${stripDataUri}" alt="" style="display:block;width:456px;height:264px;object-fit:contain;margin:0 auto;background:#0a0a0e;border-radius:4px">`
  : `<div style="display:flex;align-items:center;justify-content:center;height:264px;background:#0a0a0e;border-radius:4px;color:#8f8fa3;font-size:12px;letter-spacing:.08em">record_site_motion — filmstrip</div>`;
await shot(shell("record_site_motion · ridge (our build) · 2x2 filmstrip", motionBody), "frame-motion");

// ---------------------------------------------------------------------------
// Frame 4 — analyze_page_structure on the same file:// build.
// Real signature: analyzePageStructure(url, loader?, maxBands?, opts?) →
// PageStructure { url, title, totalHeight, bands[] } | { error }.
// ---------------------------------------------------------------------------
const { analyzePageStructure } = await dist("structure");
const structure = await analyzePageStructure(demoSiteUrl, undefined, 12);
if ("error" in structure) throw new Error("analyze_page_structure failed: " + structure.error);
const bandRows = structure.bands
  .map(
    (b) => `<div class="row" style="margin-bottom:4px">
  <span class="sw" style="width:40px;height:14px;background:${esc(b.background)}"></span>
  <span class="m" style="max-width:280px;flex:none">${esc(b.tag + (b.label ? " " + b.label : ""))}</span>
  <span class="m">${b.height}px @ ${b.offsetTop}</span>
</div>`,
  )
  .join("");
await shot(
  shell(
    `analyze_page_structure · ridge · ${structure.bands.length} bands · ${structure.totalHeight}px`,
    bandRows,
  ),
  "frame-bands",
);

// ---------------------------------------------------------------------------
// Encode: 4 PNGs → concat → fps → scale → palette GIF. Written to .tmp and
// renamed ONLY on success; >5 MB retries drop fps then scale (max 3 attempts).
// ---------------------------------------------------------------------------
const ffmpegPath = (() => {
  try {
    return require("ffmpeg-static");
  } catch {
    return "ffmpeg";
  }
})();
const gifPath = resolve(root, "assets/demo.gif");
const tmpPath = gifPath + ".tmp";
const frames = ["frame-search", "frame-details", "frame-motion", "frame-bands"];
const attempts = [
  { fps: 10, width: 480 },
  { fps: 8, width: 480 },
  { fps: 7, width: 420 },
];

let encoded = null;
let lastFailure = null;
for (const a of attempts) {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const f of frames) args.push("-loop", "1", "-t", "2.5", "-i", join(outDir, `${f}.png`));
  args.push(
    // concat of stills → resample → split for one-pass palette; output muxer
    // must be named because the filename ends in .tmp
    "-filter_complex",
    `[0:v][1:v][2:v][3:v]concat=n=4:v=1,fps=${a.fps},scale=${a.width}:-1,split[a][b];` +
      `[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer`,
    "-f",
    "gif",
    tmpPath,
  );
  try {
    execFileSync(ffmpegPath, args, { stdio: "pipe" });
    const size = statSync(tmpPath).size;
    console.log(`encode: fps=${a.fps} scale=${a.width} → ${(size / 1024 / 1024).toFixed(2)} MB`);
    if (size <= 5 * 1024 * 1024) {
      encoded = a;
      break;
    }
    lastFailure = new Error(`demo.gif stayed over 5 MB at fps=${a.fps} scale=${a.width}`);
  } catch (err) {
    lastFailure = err;
    console.log(`encode: ffmpeg failed at fps=${a.fps} scale=${a.width} — ${err instanceof Error ? err.message : String(err)}`);
  }
}
if (!encoded) throw lastFailure ?? new Error("demo.gif encode failed");
renameSync(tmpPath, gifPath);
const mb = (statSync(gifPath).size / 1024 / 1024).toFixed(2);
console.log(`demo.gif: ${mb} MB (${encoded.fps} fps, ${encoded.width}px) → ${gifPath}`);
