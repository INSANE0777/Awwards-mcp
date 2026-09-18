// Live parser-drift probe for awwwards-mcp.
//
// Catches awwwards.com markup drift the moment it breaks *us*: every probe is
// one anchor (split/indexOf/regex-literal) that src/parsers.ts depends on,
// counted against the fetched page. Raw-HTML diffing would false-alarm on
// every new site card; probing the anchors fires only when the parsers
// actually break.
//
// Usage:
//   node scripts/parser-drift-probe.mjs                # live probe at 1 req/s
//                                                      # writes .drift/status.json
//   node scripts/parser-drift-probe.mjs --fixture      # probe committed fixtures (offline)
//
// `npm run drift` = the live probe.
// Probe politeness: only two pages whose URL shapes the indexer already
// crawls (a /websites/ listing + a /sites/ detail page), same UA, 1 req/s
// between fetches. Drift-BLYG report: exit 0 ok / 1 drift / 2 fetch-fail.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LIST_URL = "https://www.awwwards.com/websites/";
const DETAIL_URL = "https://www.awwwards.com/sites/gionatan-nese-26/";

// --- parser anchors (kept in sync with src/parsers.ts) ---
// Each probe names the parser + what the anchor locates, so a failure says
// exactly which upstream markup changed.
const PROBE_GROUPS = [
  {
    url: LIST_URL,
    fixtures: ["test/fixtures/listing.html"],
    probes: [
      { name: "parseListing[card JSON blob]", parser: "parseListing (site cards)", anchor: 'data-collectable-model-value="' },
      { name: "parseListing[rollover live-url]", parser: "parseListing (live-site URL)", anchor: 'class="figure-rollover__bt"' },
      { name: "parseListing[detail href]", parser: "parseListing (detail link)", anchor: 'href="/sites/' },
      { name: "parseListing[award tag]", parser: "parseListing (award labels)", anchor: "budget-tag--" },
      { name: "parseCategories[rollover links]", parser: "parseCategories (taxonomy page)", anchor: "figure-rollover" },
    ],
  },
  {
    url: DETAIL_URL,
    fixtures: ["test/fixtures/detail.html", "test/fixtures/detail-lxl.html"],
    probes: [
      { name: "parseDetail[tech section]", parser: "parseDetail (tech stack)", anchor: "Technologies & Tools</h2>" },
      { name: "parseElements[section start]", parser: "parseDetail + parseElements", anchor: ">Elements</h2>" },
      { name: "parseElements[section end]", parser: "parseDetail + parseElements", anchor: ">Color Palette</h2>" },
      { name: "parseDetail[description marker]", parser: "parseDetail (description)", anchor: ">Description</h2>" },
      { name: "parseDetail[description h3]", parser: "parseDetail (description text)", anchor: '<h3 class="heading-6">' },
      { name: "parseDetail[og:image]", parser: "parseDetail (screenshot)", anchor: 'property="og:image" content="' },
      { name: "parseDetail[og:title]", parser: "parseScore + parseElements", anchor: 'property="og:title" content="' },
    ],
  },
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

function probeFixtures() {
  const probes = [];
  const pages = [];
  let driftCount = 0;
  for (const group of PROBE_GROUPS) {
    for (const fx of group.fixtures) {
      const p = resolve(root, fx);
      if (!existsSync(p)) continue;
      const html = readFileSync(p, "utf8");
      pages.push({ url: fx, status: 200, ok: true });
      for (const probe of group.probes) {
        const n = countAll(html, probe.anchor);
        const r = { name: probe.name, parser: probe.parser, url: fx, drift: n === 0, count: n };
        if (n === 0) {
          r.note = "fixture lacks anchor — fixture stale vs parsers, or probe anchor wrong";
          driftCount++;
        }
        probes.push(r);
      }
    }
  }
  const status = { at: new Date().toISOString(), mode: "fixture", pages, probes, driftCount, verdict: driftCount > 0 ? "drift" : "ok" };
  render(status);
  process.exit(driftCount > 0 ? 1 : 0);
}

async function probeLive() {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 awwwards-mcp/1.1 parser-probe";
  const pages = {};
  let fetchFailed = false;
  for (const group of PROBE_GROUPS) {
    if (!pages[group.url]) {
      const res = await fetch(group.url, { headers: { "user-agent": UA } });
      const html = await res.text();
      const blocked = res.status !== 200 || html.includes("Your Humanity") || html.includes("cf-chl");
      pages[group.url] = { html, status: res.status, ok: !blocked };
      if (!pages[group.url].ok) fetchFailed = true;
      // 1 req/s between page fetches (politeness, same as the client)
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const probes = [];
  let driftCount = 0;
  for (const group of PROBE_GROUPS) {
    const page = pages[group.url];
    for (const probe of group.probes) {
      const n = countAll(page.html, probe.anchor);
      const r = { name: probe.name, parser: probe.parser, url: group.url, drift: n === 0, count: n };
      if (n === 0) {
        r.note = page.ok ? "anchor gone from live page — parser drift" : "page fetch blocked/challenge — inconclusive";
        if (page.ok) driftCount++;
      }
      probes.push(r);
    }
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
    const was = prev?.probes?.find((x) => x.name === p.name);
    if (was && was.drift !== p.drift) {
      p.note = `${p.note ? p.note + "; " : ""}since ${prev.at}: ${was.drift ? "was DRIFT" : "was ok"}`;
    }
  }

  const pagesArr = PROBE_GROUPS.map((g) => {
    const { status, ok } = pages[g.url];
    return { url: g.url, status, ok };
  });
  const verdict = driftCount > 0 ? "drift" : fetchFailed ? "fetch-fail" : "ok";
  const status = { at: new Date().toISOString(), mode: "live", pages: pagesArr, probes, driftCount, verdict };

  mkdirSync(dirname(STATUS_FILE), { recursive: true });
  writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  render(status);
  process.exit(verdict === "drift" ? 1 : verdict === "fetch-fail" ? 2 : 0);
}

function render(status) {
  const lines = [
    `Parser-drift probe — ${status.at} (${status.mode})`,
    `verdict: ${status.verdict.toUpperCase()}, drifted anchors: ${status.driftCount}/${status.probes.length}`,
    "",
  ];
  for (const p of status.pages) lines.push(`  [${p.status}] ${p.url}${p.ok ? "" : " (blocked/challenge)"}`);
  lines.push("");
  for (const group of PROBE_GROUPS) {
    const groupProbes = status.probes.filter((p) => group.probes.some((x) => x.name === p.name));
    if (!groupProbes.length) continue;
    lines.push(`${groupProbes[0].url}:`);
    for (const p of groupProbes) {
      lines.push(`  ${p.drift ? "✗ DRIFT" : "✓ ok   "} ${p.name} (count ${p.count})${p.note ? ` — ${p.note}` : ""}`);
    }
    lines.push("");
  }
  console.log(lines.join("\n"));
}

if (process.argv.includes("--fixture")) probeFixtures();
else probeLive();
