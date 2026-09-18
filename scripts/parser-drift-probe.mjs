// Live parser-drift probe for awwwards-mcp.
//
// Catches awwwards.com markup drift the moment it breaks *us*: every probe is
// one anchor (split/indexOf/regex-literal) that src/parsers.ts depends on,
// counted against the fetched page. Raw-HTML diffing would false-alarm on
// every new site card; probing the anchors fires only when the parsers
// actually break.
//
// Coverage: the /websites/ listing + /sites/ detail pages — 3 pinned slugs
// (stable targets, strict verdicts) + up to 3 slugs per-day-sampled from the
// local index DB (rotating coverage; a sampled page can be removed/renamed
// any day, so its fetch failure is inconclusive, never drift).
//
// Usage:
//   node scripts/parser-drift-probe.mjs                # live probe at 1 req/s
//                                                      # writes .drift/status.json
//   node scripts/parser-drift-probe.mjs --fixture      # probe committed fixtures
//                                                      # (offline) + sampler determinism check
//
// `npm run drift` = the live probe.
// Probe politeness: only pages whose URL shapes the indexer already crawls
// (a /websites/ listing + /sites/ detail pages), same UA, 1 req/s between
// ALL fetches, no retries. Exit 0 ok / 1 drift / 2 fetch-fail (3 = fixture
// self-check failure).

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LIST_URL = "https://www.awwwards.com/websites/";
const SITE_DETAIL_URL = (slug) => `https://www.awwwards.com/sites/${slug}`;

// Stable detail targets — strict verdicts (a missing anchor on a healthy
// fetch is drift). Fixture mode probes the committed detail fixtures instead
// (see DETAIL_FIXTURES; gionatan-nese-26 has no committed fixture).
const PINNED_DETAIL_SLUGS = ["gionatan-nese-26", "emergence-magazine", "l-i-s-a"];

// Committed detail-page fixtures; og:url identifies the live page each was
// saved from (detail.html = l-i-s-a, detail-lxl.html = lxl-creative,
// detail-emergence.html = emergence-magazine).
const DETAIL_FIXTURES = [
  "test/fixtures/detail.html",
  "test/fixtures/detail-lxl.html",
  "test/fixtures/detail-emergence.html",
];

// --- parser anchors (kept in sync with src/parsers.ts) ---
// Each probe names the parser + what the anchor locates, so a failure says
// exactly which upstream markup changed.
const LISTING_PROBES = [
  { name: "parseListing[card JSON blob]", parser: "parseListing (site cards)", anchor: 'data-collectable-model-value="' },
  { name: "parseListing[rollover live-url]", parser: "parseListing (live-site URL)", anchor: 'class="figure-rollover__bt"' },
  { name: "parseListing[detail href]", parser: "parseListing (detail link)", anchor: 'href="/sites/' },
  { name: "parseListing[award tag]", parser: "parseListing (award labels)", anchor: "budget-tag--" },
  { name: "parseCategories[rollover links]", parser: "parseCategories (taxonomy page)", anchor: "figure-rollover" },
];

const detailProbesFor = (url) => [
  { name: "parseDetail[tech section]", parser: "parseDetail (tech stack)", anchor: "Technologies & Tools</h2>" },
  { name: "parseElements[section start]", parser: "parseDetail + parseElements", anchor: ">Elements</h2>" },
  { name: "parseElements[section end]", parser: "parseDetail + parseElements", anchor: ">Color Palette</h2>" },
  { name: "parseDetail[description marker]", parser: "parseDetail (description)", anchor: ">Description</h2>" },
  { name: "parseDetail[description h3]", parser: "parseDetail (description text)", anchor: '<h3 class="heading-6">' },
  { name: "parseDetail[og:image]", parser: "parseDetail (screenshot)", anchor: 'property="og:image" content="' },
  { name: "parseDetail[og:title]", parser: "parseScore + parseElements", anchor: 'property="og:title" content="' },
];

const STATUS_FILE = resolve(root, ".drift/status.json");

function countAll(html, anchor) {
  let n = 0;
  let i = html.indexOf(anchor);
  while (i >= 0) {
    n++;
    i = html.indexOf(anchor, i + anchor.length);
  }
  return n;
}

function countMatches(html, regex) {
  const re = regex.global ? regex : new RegExp(regex.source, regex.flags + "g");
  const matches = html.match(re);
  return matches ? matches.length : 0;
}

// The Elements grid slice of a detail page — null when the page has no
// Elements section (legitimate for some sites; never drift by itself).
function elementsSection(html) {
  const start = html.indexOf(">Elements</h2>");
  if (start < 0) return null;
  const end = html.indexOf(">Color Palette</h2>", start);
  return end > start ? html.slice(start, end) : html.slice(start);
}

// The emergence-magazine incident signal: section present, zero blobs.
function sectionBlobCount(html) {
  const section = elementsSection(html);
  if (section === null) return -1; // no section on this site = legitimate, skip
  return countAll(section, 'data-collectable-model-value="');
}

// element|external media paths inside the Elements section. Detail HTML
// embeds collectable JSON entity-escaped (&quot;) with JSON-escaped slashes
// (element\/…), so the pattern pins that exact byte shape — a prefix scheme
// change (element/ → something else) zeroes this count while blob counts
// stay healthy.
const MEDIA_PATH_RE = new RegExp('&quot;collectableImage&quot;:&quot;(element|external)\\\\/', "g");

// Deterministic per-day sample of detail slugs from the local index.
// seed = YYYYMMDD → same picks all day, different slice daily.
function sampleDetailSlugs(slugs, count = 3, seed = Number(new Date().toISOString().slice(0, 10).replaceAll("-", ""))) {
  const sorted = [...new Set(slugs)].sort();
  if (sorted.length === 0) return [];
  const start = seed % sorted.length;
  const picked = new Set();
  // k < sorted.length: the +97 stride visits every index when it copes with
  // the list length; the cap only stops a pathological multiple-of-97 list
  // from looping forever (it would then just sample fewer than `count`).
  for (let k = 0; picked.size < Math.min(count, sorted.length) && k < sorted.length; k++) {
    picked.add(sorted[(start + k * 97) % sorted.length]);
  }
  return [...picked];
}

// Index slugs live in the cache DB; read via a throwaway subprocess so a
// missing/locked DB can never crash or block the probe (empty list → the
// caller falls back to pinned-only and logs it).
function loadIndexSlugs() {
  try {
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `
        import { DatabaseSync } from "node:sqlite";
        import { homedir } from "node:os";
        import { join } from "node:path";
        const db = new DatabaseSync(join(process.env.AWWWARDS_CACHE_DIR ?? join(homedir(), ".awwwards-mcp"), "cache.db"), { readOnly: true });
        const rows = db.prepare("SELECT DISTINCT slug FROM sites ORDER BY slug").all();
        console.log(JSON.stringify(rows.map((r) => r.slug)));
        db.close();
      `],
      { encoding: "utf8", timeout: 10000 },
    );
    return JSON.parse(out.trim());
  } catch {
    return []; // no index → caller falls back to pinned-only, logged
  }
}

// Behavioral verdicts over a detail page's Elements section. Sampled pages
// are inconclusive on fetch failure instead of drift (they can disappear any
// day); pinned pages and fixtures keep strict verdicts.
function sectionVerdictRows(url, html, pageOk, kind) {
  const section = elementsSection(html);
  const blobs = section === null ? -1 : countAll(section, 'data-collectable-model-value="');
  const paths = section === null ? 0 : countMatches(section, MEDIA_PATH_RE);
  const inconclusive = !pageOk
    ? kind === "sampled"
      ? "sampled page inconclusive (fetch/removed)"
      : "page fetch blocked/challenge — inconclusive"
    : null;

  const blobRow = { name: "parseElements[section blobs]", parser: "parseDetail + parseElements", url, count: blobs, drift: false };
  if (inconclusive) blobRow.note = inconclusive;
  else if (blobs === -1) blobRow.note = "no section";
  else if (blobs === 0) {
    blobRow.drift = true;
    blobRow.note = "Elements section present but zero collectable blobs — section markup drift";
  }

  const pathRow = { name: "parseElements[media path scheme]", parser: "parseElements", url, count: paths, drift: false };
  if (inconclusive) pathRow.note = inconclusive;
  else if (section === null) pathRow.note = "no section";
  else if (blobs === 0) pathRow.note = "no blobs";
  else if (paths === 0) {
    pathRow.drift = true;
    pathRow.note = `section has ${blobs} blobs but zero element/external media paths — media path scheme changed`;
  }

  return { rows: [blobRow, pathRow], drifts: (blobRow.drift ? 1 : 0) + (pathRow.drift ? 1 : 0) };
}

function anchorProbeRows(group, html, pageOk, mode) {
  const rows = [];
  let drifts = 0;
  for (const probe of group.probes) {
    const n = countAll(html, probe.anchor);
    const r = { name: probe.name, parser: probe.parser, url: group.url, drift: n === 0, count: n };
    if (group.kind === "sampled") {
      // Sampled pages are arbitrary sites: sections like Technologies /
      // Color Palette / Description are optional per-site (verified on
      // healthy pages), so a count of 0 there is an observation, not drift.
      // Strict anchor verdicts stay on the listing + pinned pages.
      if (n === 0) {
        r.drift = false;
        r.note = pageOk
          ? "anchor absent on sampled page (optional per-site — observed, not drift)"
          : "sampled page inconclusive (fetch/removed)";
      }
    } else if (n === 0) {
      r.note = !pageOk
        ? "page fetch blocked/challenge — inconclusive"
        : mode === "fixture"
          ? "fixture lacks anchor — fixture stale vs parsers, or probe anchor wrong"
          : "anchor gone from live page — parser drift";
      if (pageOk) drifts++;
    }
    rows.push(r);
  }
  return { rows, drifts };
}

function probePage(group, html, pageOk, mode) {
  const a = anchorProbeRows(group, html, pageOk, mode);
  let rows = a.rows;
  let drifts = a.drifts;
  if (group.kind !== "listing") {
    const s = sectionVerdictRows(group.url, html, pageOk, group.kind);
    rows = rows.concat(s.rows);
    drifts += s.drifts;
  }
  return { rows, drifts };
}

const listingGroup = () => ({ url: LIST_URL, kind: "listing", probes: LISTING_PROBES });
const detailGroup = (url, kind) => ({ url, kind, probes: detailProbesFor(url) });

function determinismSelfCheck() {
  const slugs = Array.from({ length: 30 }, (_, i) => `probe-seed-slug-${String(i + 1).padStart(2, "0")}`);
  const a1 = sampleDetailSlugs(slugs, 3, 20260918);
  const a2 = sampleDetailSlugs(slugs, 3, 20260918);
  const b = sampleDetailSlugs(slugs, 3, 20260919);
  const ok =
    a1.length === 3 &&
    a1.every((s) => slugs.includes(s)) &&
    JSON.stringify(a1) === JSON.stringify(a2) &&
    JSON.stringify(a1) !== JSON.stringify(b);
  if (ok) {
    console.log(`determinism: ok — seed 20260918 → ${a1.join(", ")} (stable across calls); seed 20260919 → ${b.join(", ")} (different slice)`);
  } else {
    console.error(`determinism: FAILED — a1=${JSON.stringify(a1)} a2=${JSON.stringify(a2)} seed20260919=${JSON.stringify(b)}`);
  }
  return ok;
}

function probeFixtures() {
  const groups = [
    { url: "test/fixtures/listing.html", kind: "listing", probes: LISTING_PROBES },
    ...DETAIL_FIXTURES.map((fx) => detailGroup(fx, "pinned")),
  ];
  if (!determinismSelfCheck()) process.exit(3);

  const probes = [];
  const pages = [];
  let driftCount = 0;
  for (const group of groups) {
    const p = resolve(root, group.url);
    if (!existsSync(p)) {
      console.error(`fixture missing: ${group.url} — skipped`);
      continue;
    }
    const html = readFileSync(p, "utf8");
    pages.push({ url: group.url, status: 200, ok: true });
    const { rows, drifts } = probePage(group, html, true, "fixture");
    probes.push(...rows);
    driftCount += drifts;
  }
  const status = { at: new Date().toISOString(), mode: "fixture", pages, probes, driftCount, verdict: driftCount > 0 ? "drift" : "ok" };
  render(status, groups);
  process.exit(driftCount > 0 ? 1 : 0);
}

async function probeLive() {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 awwwards-mcp/1.1 parser-probe";
  const groups = [listingGroup(), ...PINNED_DETAIL_SLUGS.map((slug) => detailGroup(SITE_DETAIL_URL(slug), "pinned"))];

  const indexSlugs = loadIndexSlugs();
  const sampled = sampleDetailSlugs(indexSlugs.filter((s) => !PINNED_DETAIL_SLUGS.includes(s)));
  if (indexSlugs.length === 0) {
    console.error("local index empty/missing — pinned-only run (no sampled detail pages)");
  } else {
    console.error(`local index: ${indexSlugs.length} slugs — sampled detail pages: ${sampled.join(", ")}`);
  }
  for (const slug of sampled) groups.push(detailGroup(SITE_DETAIL_URL(slug), "sampled"));

  // Every page fetched sequentially, ≥1s between ALL fetches (politeness,
  // same as the client). No retries, ever.
  const pages = {};
  let fetchFailed = false;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (i > 0) await new Promise((r) => setTimeout(r, 1000));
    const res = await fetch(group.url, { headers: { "user-agent": UA } });
    const html = await res.text();
    const blocked = res.status !== 200 || html.includes("Your Humanity") || html.includes("cf-chl");
    pages[group.url] = { html, status: res.status, ok: !blocked };
    // Sampled fetch failures are inconclusive (rows note it); only listing +
    // pinned failures push the run to fetch-fail.
    if (!pages[group.url].ok && group.kind !== "sampled") fetchFailed = true;
  }

  const probes = [];
  let driftCount = 0;
  for (const group of groups) {
    const page = pages[group.url];
    const { rows, drifts } = probePage(group, page.html, page.ok, "live");
    probes.push(...rows);
    driftCount += drifts;
  }

  // per-anchor diff against the previous run's verdicts (cosmetic context)
  let prev = null;
  if (existsSync(STATUS_FILE)) {
    try {
      prev = JSON.parse(readFileSync(STATUS_FILE, "utf8"));
    } catch {
      prev = null;
    }
  }
  for (const p of probes) {
    const was = prev?.probes?.find((x) => x.name === p.name && x.url === p.url);
    if (was && was.drift !== p.drift) {
      p.note = `${p.note ? p.note + "; " : ""}since ${prev.at}: ${was.drift ? "was DRIFT" : "was ok"}`;
    }
  }

  const pagesArr = groups.map((g) => {
    const { status, ok } = pages[g.url];
    return { url: g.url, status, ok };
  });
  const verdict = driftCount > 0 ? "drift" : fetchFailed ? "fetch-fail" : "ok";
  const status = { at: new Date().toISOString(), mode: "live", pages: pagesArr, probes, driftCount, verdict };

  mkdirSync(dirname(STATUS_FILE), { recursive: true });
  writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  render(status, groups);
  process.exit(verdict === "drift" ? 1 : verdict === "fetch-fail" ? 2 : 0);
}

function render(status, groups) {
  const lines = [
    `Parser-drift probe — ${status.at} (${status.mode})`,
    `verdict: ${status.verdict.toUpperCase()}, drifted anchors: ${status.driftCount}/${status.probes.length}`,
    "",
  ];
  for (const p of status.pages) lines.push(`  [${p.status}] ${p.url}${p.ok ? "" : " (blocked/challenge)"}`);
  lines.push("");
  for (const group of groups) {
    const rows = status.probes.filter((p) => p.url === group.url);
    if (!rows.length) continue;
    const isDetail = group.kind !== "listing";
    lines.push(isDetail && status.mode === "live" ? `${group.url} [${group.kind}]:` : `${group.url}:`);
    const verdicts = rows.filter((r) => r.name === "parseElements[section blobs]" || r.name === "parseElements[media path scheme]");
    const anchors = rows.filter((r) => !verdicts.includes(r));
    if (anchors.some((r) => r.drift)) {
      // something broke — show every anchor row for this page
      for (const p of anchors) {
        lines.push(`  ${p.drift ? "✗ DRIFT" : "✓ ok   "} ${p.name} (count ${p.count})${p.note ? ` — ${p.note}` : ""}`);
      }
    } else if (anchors.length > 0 && anchors.every((r) => r.note?.includes("inconclusive"))) {
      lines.push(`  ~ hold  anchors ${anchors.length}/${anchors.length} — ${anchors[0].note}`);
    } else {
      const absent = anchors.filter((r) => r.count === 0).length;
      lines.push(
        absent > 0
          ? `  ✓ ok    anchors ${anchors.length - absent}/${anchors.length} present, ${absent} absent (optional per-site)`
          : `  ✓ ok    anchors ${anchors.length}/${anchors.length} (min count ${Math.min(...anchors.map((r) => r.count))})`
      );
    }
    for (const p of verdicts) {
      const what = p.name === "parseElements[section blobs]" ? "blobs" : "element|external paths";
      lines.push(`  ${p.drift ? "✗ DRIFT" : "✓ ok   "} ${p.name} (${what} ${p.count})${p.note ? ` — ${p.note}` : ""}`);
    }
    lines.push("");
  }
  console.log(lines.join("\n"));
}

if (process.argv.includes("--fixture")) probeFixtures();
else probeLive();
