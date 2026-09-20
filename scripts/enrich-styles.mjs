// enrich-styles.mjs — Phase-1 style-classification experiment (spec:
// docs/superpowers/specs/2026-09-20-jev-style-enrichment-design.md).
//
// Classifies sites from the local index into a curated design-direction
// vocabulary via a local simple-jev server (github.com/featherless-ai/simple-jev,
// self-hosted; our repo never vendors their code — we only call its HTTP API).
//
// Usage:
//   node scripts/enrich-styles.mjs --sample 50 [--with-descriptions]
//        [--sample-from .drift/style-experiment.json] [--out .drift/style-experiment.json]
// --with-descriptions fetches detail-page descriptions first via the repo's own
// AwwwardsClient (1 req/s politeness), cached in .drift/descriptions.json.
// --sample-from reuses the exact slugs of a previous run for comparability.
// Env:
//   SIMPLE_JEV_URL  classifier endpoint (default http://127.0.0.1:8123/v1/classifier)
//   AWWWARDS_DB     cache.db path (default ~/.awwwards-mcp/cache.db)

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { AwwwardsClient } from '../dist/awwwards.js';
import { parseDetail, decodeEntities } from '../dist/parsers.js';

const ENDPOINT = process.env.SIMPLE_JEV_URL ?? 'http://127.0.0.1:8123/v1/classifier';
const DB_PATH = process.env.AWWWARDS_DB ?? `${homedir()}/.awwwards-mcp/cache.db`;
let modelId = 'unknown'; // set from the server's /health by waitForServer

// Curated design-direction vocabulary (spec §Vocabulary).
const VOCAB = {
  'swiss-grid': 'Asymmetric editorial grids, oversized grotesque type, restrained palette with one accent',
  minimal: 'Restraint, generous whitespace, few visual elements',
  brutalist: 'Raw typography, exposed structure, harsh contrast, deliberately rough',
  editorial: 'Magazine rhythm, serif or display headlines, article-like sections and bands',
  portfolio: 'A work-first showcase of projects or creative output',
  'agency-corporate': 'A studio, agency, or company presentation site',
  'saas-product': 'Product marketing: features, pricing, testimonials, signup CTAs',
  'e-commerce': 'Shop, product catalog, checkout',
  '3d-webgl': 'Real-time 3D scenes, WebGL canvases, interactive depth',
  'motion-heavy': 'Scroll or hover choreography as the core identity',
  'typography-driven': 'Type as the main visual subject, experimental lettering',
  photographic: 'Large photography or videography leads the design',
  illustrative: 'Drawn, painted, or graphic artwork as the visual language',
  'retro-pixel': 'Dither, grain, pixel art, nostalgia',
  'gradient-mesh': 'Soft color fields, gradients, blurred meshes',
  'dark-luxe': 'Dark backgrounds with gold, neon, or premium finishing',
  playful: 'Bright, rounded, casual, cartoonish energy',
  'data-interactive': 'Visualized or interactive data as the centerpiece',
  experimental: 'Defies standard categories, avant-garde structure',
  'classic-corporate': 'A traditional business or enterprise website',
  other: 'None of the above',
};

// Known control sites with expected primary labels (spec §Phase 1).
const CONTROLS = {
  'aspen-search': 'swiss-grid',
  ordr: 'editorial',
  'hearst-exhibit-2026': 'editorial',
  'emergence-magazine': 'editorial',
  'gionatan-nese-26': 'portfolio',
  'lxl-creative': 'portfolio',
  'l-i-sa': 'typography-driven',
};

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] != null && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const sampleArg = Number(arg('--sample', 50));
const withDescriptions = args.includes('--with-descriptions');
const sampleFrom = arg('--sample-from', null);
const outPath = arg('--out', '.drift/style-experiment.json');
const DESC_PATH = '.drift/descriptions.json';

// Wait for the classifier server to report ready (model load can take minutes)
// and return its health payload — the loaded model id names the model in requests.
async function waitForServer(timeoutMs = 600000) {
  const health = ENDPOINT.replace(/\/v1\/classifier$/, '/health');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(health);
      if (r.ok) return await r.json();
    } catch {}
    process.stdout.write('.');
    await new Promise((res) => setTimeout(res, 5000));
  }
  throw new Error(`classifier server not ready at ${health}`);
}

function serializeState(row, description) {
  const tags = (() => {
    try { return JSON.parse(row.tags).join(', '); } catch { return String(row.tags ?? ''); }
  })();
  const awards = String(row.awards ?? '').replace(/^\[|\]$/g, '').replace(/"/g, '');
  let state = `Website: ${row.title}\nTags: ${tags}\nAwards: ${awards}`;
  if (description) state += `\nDescription: ${description}`;
  return state;
}

async function classify(state, modelId) {
  const t0 = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      state,
      questions: {
        primary: {
          type: 'choice',
          instructions: 'Which single design direction best describes this website? Pick from the criteria.',
          criteria: VOCAB,
        },
        secondary: {
          type: 'choice',
          instructions: 'Which is the second-strongest design direction, other than the primary one?',
          criteria: VOCAB,
        },
        decidable: {
          type: 'noul',
          instructions:
            'Based only on the website information above, is there enough information to confidently determine the primary design direction?',
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return { body, ms: Date.now() - t0 };
}

// ---------- sample selection ----------
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const rowsBySlug = new Map(
  db.prepare('SELECT slug, title, tags, awards, detailPath FROM sites').all().map((r) => [r.slug, r])
);
const allSlugs = [...rowsBySlug.keys()];

let rows;
if (sampleFrom && existsSync(sampleFrom)) {
  const prev = JSON.parse(readFileSync(sampleFrom, 'utf8'));
  rows = prev.results.map((r) => rowsBySlug.get(r.slug)).filter(Boolean);
  console.log(`sample: reusing ${rows.length} slugs from ${sampleFrom}`);
} else {
  const controlSlugs = Object.keys(CONTROLS).filter((s) => rowsBySlug.has(s));
  const missing = Object.keys(CONTROLS).filter((s) => !rowsBySlug.has(s));
  const randomCount = Math.max(0, sampleArg - controlSlugs.length);
  const ph = (n) => Array.from({ length: n }, () => '?').join(',');
  const randomSlugs = db
    .prepare(`SELECT slug FROM sites WHERE slug NOT IN (${ph(controlSlugs.length)}) ORDER BY RANDOM() LIMIT ?`)
    .all(...controlSlugs, randomCount)
    .map((r) => r.slug);
  rows = [...controlSlugs, ...randomSlugs].map((s) => rowsBySlug.get(s));
  if (missing.length) console.log(`controls missing from index (ignored): ${missing.join(', ')}`);
  console.log(`sample: ${controlSlugs.length} controls + ${randomSlugs.length} random = ${rows.length} sites`);
}
console.log(`endpoint: ${ENDPOINT} | model: ${modelId} | descriptions: ${withDescriptions ? 'yes' : 'no'}\n`);

// ---------- Phase 1b: description fetch (cached, 1 req/s via AwwwardsClient) ----------
let descriptions = {};
const serverHealth = await waitForServer();
modelId = serverHealth?.model ?? modelId;
console.log(`server: ${modelId}`);
if (withDescriptions) {
  if (existsSync(DESC_PATH)) descriptions = JSON.parse(readFileSync(DESC_PATH, 'utf8'));
  const client = new AwwwardsClient();
  const need = rows.filter((r) => descriptions[r.slug] === undefined);
  console.log(`descriptions: ${Object.keys(descriptions).length} cached, fetching ${need.length} detail pages…`);
  for (const [i, r] of need.entries()) {
    try {
      const html = await client.getHtml(r.detailPath || `/sites/${r.slug}/`);
      const details = parseDetail(html, r.slug);
      // parseDetail only reads the curated ">Description</h2>" section; most sites
      // instead carry an og:description meta tag (see spec follow-up: parser gap).
      let desc = details?.description ?? null;
      if (!desc) {
        const og = html.match(/property="og:description" content="([^"]*)"/);
        desc = og ? decodeEntities(og[1]).trim() : null;
      }
      descriptions[r.slug] = desc || null;
    } catch (e) {
      descriptions[r.slug] = null; // blocked/parse failure: classify tags-only, honestly
      console.log(`  ${r.slug}: fetch failed (${e.message.slice(0, 60)}) — tags-only`);
    }
    process.stdout.write(`\r  fetched ${i + 1}/${need.length}   `);
  }
  console.log('');
  mkdirSync(dirname(DESC_PATH), { recursive: true });
  writeFileSync(DESC_PATH, JSON.stringify(descriptions, null, 2));
  const got = rows.filter((r) => descriptions[r.slug]).length;
  console.log(`descriptions available for ${got}/${rows.length} sites\n`);
}

// ---------- classification ----------
const results = [];
for (const row of rows) {
  const expected = CONTROLS[row.slug];
  try {
    const { body, ms } = await classify(serializeState(row, descriptions[row.slug] ?? null), modelId);
    const a = body.answers;
    const primary = a.primary?.choice;
    let secondary = a.secondary?.choice;
    if (secondary === primary) secondary = null; // duplicate pick = no real second direction
    results.push({
      slug: row.slug,
      control: expected ?? null,
      hasDescription: Boolean(descriptions[row.slug]),
      primary,
      primaryProb: a.primary?.probabilities?.[primary],
      secondary,
      decidable: a.decidable?.noul,
      ms,
      inputTokens: body.usage?.input_tokens,
    });
    process.stdout.write(
      `\r${results.length}/${rows.length} last: ${row.slug} -> ${primary}${expected ? ` (want ${expected})` : ''}   `
    );
  } catch (e) {
    results.push({ slug: row.slug, control: expected ?? null, error: e.message });
  }
}
console.log('');

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ model: modelId, endpoint: ENDPOINT, descriptions: withDescriptions, results }, null, 2));

// ---------- summary ----------
const ok = results.filter((r) => !r.error);
const controls = ok.filter((r) => r.control);
const randoms = ok.filter((r) => !r.control);
const controlHits = controls.filter((r) => r.primary === r.control).length;
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const pct = (arr, f) => (arr.length ? (arr.filter(f).length / arr.length) * 100 : 0);

console.log(`\n===== SUMMARY (model: ${modelId} | mode: ${withDescriptions ? 'with descriptions' : 'tags-only'} | full: ${outPath}) =====`);
console.log(`errors: ${results.filter((r) => r.error).length}`);
console.log(`controls: ${controlHits}/${controls.length} exact primary match`);
controls.forEach((r) =>
  console.log(`  ${r.control === r.primary ? 'PASS' : 'MISS'} ${r.slug}: got ${r.primary} (want ${r.control})`)
);
console.log(`random sites: ${randoms.length}`);
console.log(`decidable >= 0.5: ${pct(randoms.map((r) => r.decidable ?? 0), (d) => d >= 0.5).toFixed(1)}%`);
console.log(`decidable median: ${median(randoms.map((r) => r.decidable ?? 0)).toFixed(3)}`);
console.log(`primary confidence >= 0.5: ${pct(randoms.map((r) => r.primaryProb ?? 0), (p) => p >= 0.5).toFixed(1)}%`);
console.log(`primary confidence median: ${median(randoms.map((r) => r.primaryProb ?? 0)).toFixed(3)}`);
const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
console.log(`latency: median ${median(lat)}ms, p95 ${lat[Math.floor(lat.length * 0.95)]}ms`);
console.log(`usage: ${ok.reduce((s, r) => s + (r.inputTokens ?? 0), 0)} input tokens total`);
const dist = {};
randoms.forEach((r) => { dist[r.primary] = (dist[r.primary] ?? 0) + 1; });
console.log(`primary label distribution (randoms): ${Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(', ')}`);
console.log(`\nrandom face-check list (primary @ prob | 2nd | decidable${withDescriptions ? ' | desc' : ''}):`);
randoms.slice(0, 20).forEach((r) =>
  console.log(`  ${r.slug}: ${r.primary} @ ${r.primaryProb?.toFixed(2)} | ${r.secondary ?? '—'} | ${r.decidable?.toFixed(2)}${withDescriptions ? ` | ${r.hasDescription ? 'y' : 'n'}` : ''}`)
);
console.log(`\n(index: ${allSlugs.length} sites total)`);
