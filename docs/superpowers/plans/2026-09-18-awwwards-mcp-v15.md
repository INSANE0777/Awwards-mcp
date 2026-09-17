# v1.5.0 Reliability & Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v1.5.0 — capture reliability (wait strategy + pre-scroll), the `record_site_motion` tool (filmstrip inline), tokenized search with zero-result tag suggestions, and jury scores in details + score-sorted search.

**Architecture:** Four independent improvements sharing one release. A touches the two Playwright tools' wait/scroll behavior; C and D are pure server/parsers logic; B adds `src/motion.ts` wrapping the validated recorder. Spec: `docs/superpowers/specs/2026-09-18-awwwards-mcp-v15-reliability-motion-design.md`.

**Tech Stack:** Existing stack — TypeScript 5 strict ESM, MCP SDK + zod, vitest, optional playwright + ffmpeg-static devDeps.

## Global Constraints

- Suite baseline **79/79**; target ≥88. All new tests offline (injected loaders/fakes). Live stdio probes are manual (Task 5), never in CI.
- MCP tool ceiling ~30s: capture/analyze/motion must complete their default path well under it — hence `waitUntil: "load"` + settle default, never `networkidle` by default.
- Never-throw handler contract unchanged; optional-dep contract unchanged (missing playwright/ffmpeg → isError with install instructions).
- `SiteDetails.score: number | null` — parsed from `c-heading-score__note` (first decimal after the arrow); null when absent.
- Search `query` tokenization: split on whitespace; a site matches only if EVERY token substring-matches title or tags. Zero-result responses append up to 6 taxonomy tag suggestions (slugs sharing a ≥4-char token or prefix with any query token).
- `sortBy: "score"` enrichment reads cached `detail:<slug>` meta per result (≤12 lookups); scored results first (desc), then unscored (newest first). NEVER fetch details during search.
- ffmpeg binary path: resolve via `import("ffmpeg-static")` default export (string path); missing → isError install hint "npm install ffmpeg-static".
- Version 1.4.0 → 1.5.0 in the docs task. Repo on `main`; clean tree per task.

---

### Task 1: Search UX — tokenized query, suggestions, sortBy score (TDD)

**Files:**
- Modify: `src/server.ts` (search_sites handler), `test/server.test.ts` (append tests)

**Interfaces:**
- Produces: `search_sites` accepts `sortBy?: "score" | "newest"` (newest = default, current behavior); tokenized matching; zero-result suggestion line. Internal helpers exported for tests: `tokenizeQuery(q: string): string[]`, `suggestTags(tokens: string[], taxonomy: string[], limit?: number): string[]`.

- [ ] **Step 1: Write failing tests (append to test/server.test.ts)**

```ts
import { tokenizeQuery, suggestTags } from "../src/server.js";

describe("search query tokenization", () => {
  it("splits multi-word queries into tokens (all must match)", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([
      site({ slug: "mag", title: "Editorial Mag", tags: ["Magazine / Newspaper / Blog"] }),
      site({ slug: "half", title: "Editorial Only", tags: [] }),
      site({ slug: "other", title: "Unrelated", tags: [] }),
    ]);
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ query: "editorial mag", count: 6 });
    const text = (res.content[0] as any).text;
    expect(text).toContain("mag");
    expect(text).not.toContain("half");
    expect(text).not.toContain("other");
    const pageCalls = fetchFn.mock.calls.filter((c: any[]) => String(c[0]).includes("/websites/"));
    expect(pageCalls.length).toBe(0);
  });

  it("suggests taxonomy tags on zero results", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site({ slug: "plain", title: "Nothing Relevant", tags: [] })]);
    // seed taxonomy meta so suggestions come from the real slugs
    cache.setMeta("categories", { colors: [], filters: ["magazine-newspaper-blog", "storytelling", "typography", "minimal", "clean", "portfolio"] });
    const { client } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ query: "magazine editorial", count: 6 });
    const text = (res.content[0] as any).text;
    expect(text).toContain("No sites matched");
    expect(text).toContain("magazine-newspaper-blog");
    expect(text).toContain("storytelling");
  });
});

describe("suggestTags", () => {
  it("ranks slugs sharing tokens or prefixes with query tokens", () => {
    const s = suggestTags(["magazine", "editorial"], ["magazine-newspaper-blog", "typography", "minimal", "clean", "storytelling"], 6);
    expect(s[0]).toBe("magazine-newspaper-blog");
    expect(s).toContain("storytelling"); // shares prefix "stor..."? no — contains token? see rule: slug contains a query token with >=4 chars OR shares a >=4-char prefix
    expect(s.length).toBeLessThanOrEqual(6);
  });
});

describe("search sortBy score", () => {
  it("sorts scored sites first (desc) then unscored (newest first)", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([
      site({ slug: "lo", title: "Low Score" }),
      site({ slug: "hi", title: "High Score" }),
      site({ slug: "none", title: "No Score", createdAt: 1789516800 + 500 }),
      site({ slug: "none2", title: "No Score 2", createdAt: 1789516800 + 400 }),
    ]);
    cache.setMeta("detail:hi", { slug: "hi", title: null, description: null, palette: [], technologies: [], elements: [], awards: [], ogImage: null, liveUrl: null, score: 8.4 });
    cache.setMeta("detail:lo", { slug: "lo", title: null, description: null, palette: [], technologies: [], elements: [], awards: [], ogImage: null, liveUrl: null, score: 6.1 });
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ sortBy: "score", count: 6 });
    const text = (res.content[0] as any).text;
    const order = ["hi", "lo", "none", "none2"].map((s) => text.indexOf(s));
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    expect(order[2]).toBeLessThan(order[3]);
    expect(fetchFn.mock.calls.filter((c: any[]) => String(c[0]).includes("/sites/")).length).toBe(0); // enrichment reads cache only
  });
});
```

- [ ] **Step 2: Run to verify failures** — `npx vitest run test/server.test.ts`
Expected: FAIL — `tokenizeQuery` not exported; suggestion line absent; sortBy ignored.

- [ ] **Step 3: Implement in src/server.ts**

Add exports + logic (module scope):

```ts
export function tokenizeQuery(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

export function suggestTags(tokens: string[], taxonomy: string[], limit = 6): string[] {
  const scored: [string, number][] = [];
  for (const slug of taxonomy) {
    let score = 0;
    for (const t of tokens) {
      if (t.length < 4) continue;
      if (slug.includes(t)) score += 2;
      else if (slug.startsWith(t.slice(0, 5)) || t.startsWith(slug.slice(0, 5))) score += 1;
    }
    if (score > 0) scored.push([slug, score]);
  }
  return scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([s]) => s);
}
```

In `matchesFilters`, replace the query check:

```ts
    if (queryTokens.length) {
      const hay = (s.title + " " + s.tags.join(" ")).toLowerCase();
      if (!queryTokens.every((t) => hay.includes(t))) return false;
    }
```

(`matchesFilters` gains the tokens: compute `const queryTokens = tokenizeQuery(f.query ?? "")` at the top of both `search_sites` call sites — simplest: tokenize inside `matchesFilters` from `f.query`.)

In `search_sites`: accept `sortBy?: "score" | "newest"` in `SearchArgs`. In the two result paths (cache-served and scrape-served), when `sortBy === "score"`:

```ts
      const withScores = slice.map((s) => ({
        s,
        score: cache.getMeta<SiteDetails>(`detail:${s.slug}`, SITE_TTL_MS)?.score ?? null,
      }));
      withScores.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.s.createdAt - a.s.createdAt);
      // then render text + images from withScores.map((w) => w.s)
```

(Applied to BOTH the normal path and the stale fallback; keep image pairing aligned with the final order.) Zero-result path: when `sites.length === 0` after filtering, fetch taxonomy from cache meta `categories` (do NOT fetch live), build the suggestion line, and include it in the "No sites matched" text: `No sites matched the search. Closest filter tags: a, b, c. Run list_categories for the full taxonomy.` If `suggestTags` returns nothing, keep today's text.

- [ ] **Step 4: Verify green** — `npx vitest run test/server.test.ts && npm test` (expect 83/83: 79 + 4)
- [ ] **Step 5: Commit** — `git commit -m "feat: tokenized search queries, zero-result tag suggestions, score-sorted results"`

---

### Task 2: Jury scores — parseScore + details line (TDD)

**Files:**
- Modify: `src/types.ts` (SiteDetails.score), `src/parsers.ts` (parseScore), `src/server.ts` (details text line), `test/parsers.test.ts`, `test/server.test.ts`

**Interfaces:**
- Produces: `parseScore(html: string): number | null` from `src/parsers.js`; `SiteDetails.score: number | null`.

- [ ] **Step 1: Failing tests**

In `test/parsers.test.ts` (add `parseScore` to imports):

```ts
describe("parseScore", () => {
  it("extracts the displayed overall score from the score heading", () => {
    const d = readFixture("detail-lxl.html");
    expect(parseScore(d)).toBeCloseTo(7.37, 2);
  });
  it("returns null when no score heading exists", () => {
    expect(parseScore("<html><body>no score</body></html>")).toBeNull();
  });
});
```

In `test/server.test.ts` (extend the existing `get_site_details` describe):

```ts
  it("includes the jury score line when present", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.get_site_details({ slug: "l-i-s-a" });
    // the l-i-s-a fixture (detail.html) has a c-heading-score block
    expect((res.content[0] as any).text).toMatch(/Jury score: \d\.\d{1,2}\/10/);
  });
```

(Verify against the fixture during GREEN: if the August fixture's `l-i-s-a` page has no `c-heading-score` anchor, assert instead that the l-i-s-a text LACKS the line and keep the positive case on a synthetic HTML test — report which way it went. Synthetic positive test: `parseDetail` already handles it; for the handler line, feed a fake fetch returning a small HTML with `c-heading-score__note">→ 8.10<sup>/ 10</sup>` embedded in an otherwise valid detail page? Simplest: positive case lives in parsers tests; the handler line test uses whichever fixture supports it.)

- [ ] **Step 2: RED** — `npx vitest run test/parsers.test.ts` fails (`parseScore` missing).

- [ ] **Step 3: Implement**

`src/types.ts`: add `score: number | null;` to `SiteDetails`.

`src/parsers.ts`:

```ts
// Displayed overall jury score, e.g. c-heading-score__note">→ 7.37<sup>/ 10</sup>.
// Non-award pages have no such heading → null.
export function parseScore(html: string): number | null {
  const m = /c-heading-score__note[^>]*>[^<]*?([\d]+(?:\.\d{1,2})?)/.exec(html);
  return m ? parseFloat(m[1]) : null;
}
```

`parseDetail`: add `score: parseScore(html),` to the returned object.

`src/server.ts` `get_site_details` text assembly: insert after the Awards line:

```ts
            d.score != null ? `Jury score: ${d.score.toFixed(2)}/10` : null,
```

(The old fixture `detail.html` may or may not carry the anchor — the handler test adapts per Step 1's note.)

Empty-parse guard in `get_site_details` treats all-empty as mismatch — score alone must not satisfy the guard (guard already checks palette/technologies/elements/awards/description; leave unchanged).

- [ ] **Step 4: GREEN + suite** — expect 85/85 (83 + 2).
- [ ] **Step 5: Commit** — `git commit -m "feat: jury score in site details"`

---

### Task 3: Capture reliability — waitStrategy + pre-scroll (TDD)

**Files:**
- Modify: `src/capture.ts`, `src/structure.ts`, `test/capture.test.ts`, `test/structure.test.ts`

**Interfaces:**
- Produces: `captureLiveSite(url, imagesDir, loader?, opts?: { waitStrategy?: "load" | "networkidle" })` and `analyzePageStructure(url, loader?, maxBands?, opts?: { waitStrategy?: "load" | "networkidle" })` — both default `"load"`; after `goto`, both wait `3000ms` settle (networkidle strategy skips the fixed settle), then run their scroll-through, then capture/scan.

- [ ] **Step 1: Failing tests**

In `test/capture.test.ts`, extend the fake browser's page to record `goto` options and evaluate calls:

```ts
  it("uses load strategy with settle and scrolls before the screenshot", async () => {
    const calls: string[] = [];
    const dir = tmpDir();
    const fake = {
      launch: async () => ({
        newPage: async () => ({
          goto: async (_u: string, o: any) => { calls.push("goto:" + o.waitUntil); },
          evaluate: async (fn: any) => { calls.push("eval"); return 500; },
          screenshot: async ({ path }: { path: string }) => {
            calls.push("shot");
            (await import("node:fs/promises")).writeFile(path, Buffer.from("png"));
          },
        }),
        close: async () => {},
      }),
    };
    const res = await captureLiveSite("https://example.com", dir, async () => ({ chromium: fake }));
    expect("file" in res).toBe(true);
    expect(calls[0]).toBe("goto:load");
    expect(calls.filter((c) => c === "eval").length).toBeGreaterThanOrEqual(2); // scroll loop + settle marker
    expect(calls[calls.length - 1]).toBe("shot");
  });
```

(Adapt to the current fake shapes in the file — the point is: default `goto` waitUntil is `"load"`, at least one scroll evaluate precedes the screenshot. If the existing capture fake's evaluate is used for the scroll loop, assert ordering via the calls log.)

In `test/structure.test.ts`, add: analyze's default goto uses `load` (mirror assertion on the fake's goto options).

- [ ] **Step 2: RED**, then **Step 3: Implement**

Shared pre-scroll helper (duplicate the small loop in both files OR export from structure.ts and import in capture.ts — prefer exporting `SCROLL_SNIPPET`-equivalent helper `preScroll(page)` from `src/structure.ts` and reuse in `capture.ts` to keep one implementation):

```ts
export async function preScroll(page: any): Promise<void> {
  await page.evaluate(async () => {
    const step = 450;
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 150));
  });
}
```

Both tools: `goto(url, { waitUntil: waitStrategy, timeout: 45_000 })`, then `if (waitStrategy === "load") await page.waitForTimeout(3000);`, then `await preScroll(page)`, then screenshot/scan.

- [ ] **Step 4: GREEN + suite** — expect 87/87 (+2).
- [ ] **Step 5: Commit** — `git commit -m "fix: load-wait default and pre-scroll for capture and structure tools"`

---

### Task 4: record_site_motion tool (TDD)

**Files:**
- Create: `src/motion.ts`, `test/motion.test.ts`
- Modify: `src/server.ts` (handler + AnalyzeFn-style injection: `motionFn?`), `src/cli.ts` (registration), `test/server.test.ts` (handler tests)

**Interfaces:**
- Produces from `src/motion.js`: `recordSiteMotion(url, opts: { cacheImagesDir: string; loader?: () => Promise<any>; ffmpegPath?: string | null; frames?: number }): Promise<{ file: string; base64: string; frames: number } | { error: string }>`.
- Handler: `record_site_motion({ url, frames? })` — success → `[text("Motion recording saved to <file>"), image(filmstrip base64, image/jpeg)]`; missing playwright → isError with existing hint; missing ffmpeg → isError with "npm install ffmpeg-static".

- [ ] **Step 1: Failing tests (test/motion.test.ts)**

```ts
import { describe, expect, it } from "vitest";
import { recordSiteMotion } from "../src/motion.js";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("recordSiteMotion", () => {
  it("records, extracts a filmstrip, and returns file + base64", async () => {
    const dir = mkdtempSync(join(tmpdir(), "motion-"));
    dirs.push(dir);
    // fake playwright: context records nothing; we fabricate the video file
    const fake = {
      launch: async () => ({
        newPage: async () => ({
          goto: async () => {},
          evaluate: async () => {},
          mouse: { move: async () => {}, down: async () => {}, up: async () => {} },
        }),
        newContext: async () => ({
          newPage: async () => ({
            goto: async () => {},
            evaluate: async () => {},
            mouse: { move: async () => {}, down: async () => {}, up: async () => {} },
          }),
          close: async () => {},
        }),
        close: async () => {},
      }),
    };
    // Pre-place a fake webm in the tmp recordVideo dir? The real recorder
    // renames from recordVideo dir — for the fake, we instead monkeypatch via
    // the ffmpeg hook: give ffmpegPath a stub that writes the strip.
    const ffmpegStub = join(dir, "ffmpeg-stub.exe");
    writeFileSync(ffmpegStub, "stub");
    const res = await recordSiteMotion("https://example.com", {
      cacheImagesDir: dir,
      loader: async () => ({ chromium: fake }),
      ffmpegPath: ffmpegStub,
    });
    expect("error" in res).toBe(false);
  });

  it("returns an error when ffmpeg is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "motion-"));
    dirs.push(dir);
    const fake = { launch: async () => ({ newPage: async () => ({}), newContext: async () => ({ newPage: async () => ({}), close: async () => {} }), close: async () => {} }) };
    const res = await recordSiteMotion("https://example.com", { cacheImagesDir: dir, loader: async () => ({ chromium: fake }), ffmpegPath: null });
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toContain("ffmpeg-static");
  });
});
```

NOTE to implementer: the fake-playwright shape above is a starting sketch — the REAL `recordSiteMotion` must be structured for testability exactly like capture.ts: `recordSiteMotion` takes `loader` and `ffmpegPath` injection, performs the flow (goto → dwell → scroll → interaction pass → context.close() flush → rename webm → ffmpeg strip → read strip), and the test's job is to verify the FLOW and the two error contracts. Make the video-file handoff testable: export the flow as `recordMotionFlow(page, opts)` where the test can stub `page.evaluate`/`mouse` and provide a pre-made webm file path via an injected `videoSink`? Simplest robust design: `recordSiteMotion(url, { loader, ffmpegPath, frames, cacheImagesDir })` where after `context.close()` it reads the video from the recordVideo dir — for the fake, the test pre-writes a webm into `cacheImagesDir/.video-tmp/` and the fake `newContext` returns a page whose methods are no-ops; `close()` is where real Playwright flushes, so the file must already exist — put the pre-written webm in the tmp dir BEFORE calling, keyed by the same convention the implementation uses (it globs `*.webm`). Then the ffmpeg step: with `ffmpegPath` pointing at the stub, the implementation must still produce a strip file — so the implementation writes the strip itself? No: keep honest. The ffmpeg invocation is a child_process call; with the stub, it fails silently. THEREFORE: the strip step should verify the strip file exists after spawn and return `{ error }` if spawn failed... For offline testing, structure the ffmpeg call as `runFfmpeg(ffmpegPath, video, out, frames)` — exported, and the test stubs it via dependency injection (`ffmpegFn?: (args) => Promise<void>` default spawns the real binary). The two tests then: (1) flow + strip via injected `ffmpegFn` that writes a fake JPEG; (2) missing ffmpeg → error hint. Follow this injection design; adjust the sketch accordingly.

- [ ] **Step 2: RED**, **Step 3: Implement `src/motion.ts`**

Core structure (mirroring the validated script — reuse its exact sequence: 7s dwell, 450px/600ms scroll, virtual cursor, 16 evenly-spread hover targets with 750ms dwell, ≤4 safe clicks, top return; then `context.close()` flush, rename, ffmpeg tile strip):

```ts
import { CAPTURE_INSTALL_HINT } from "./capture.js";

export const MOTION_FFMPEG_HINT =
  "Motion recording needs ffmpeg-static, which is an optional dependency.\n" +
  "Install it with:  npm install -D ffmpeg-static\n" +
  "Then retry record_site_motion.";

export interface MotionOpts {
  cacheImagesDir: string;
  loader?: () => Promise<any>;
  ffmpegPath?: string | null; // default: dynamic import("ffmpeg-static")
  frames?: number; // default 16 (4x4)
  ffmpegFn?: (bin: string, video: string, strip: string, frames: number) => Promise<void>;
  waitStrategy?: "load" | "networkidle";
}
```

Flow: mkdir tmp; context with recordVideo; page goto (load + 3s settle per Task 3 convention — the 7s preloader dwell from the script is folded into a `dwellMs` default 5000; keep 5000 to stay under the 30s ceiling with the interaction pass: 5s dwell + ~12s scroll + ~20s interactions ≈ 37s… TOO LONG. Constrain: scroll step 450px/350ms and hover dwell 500ms, targets ≤12, clicks ≤3 → worst case ≈ 5 + 8 + 14 ≈ 27s. Document the budget in code.) Then close/flush → glob *.webm in tmp → rename to `motion-<sha1(url).slice(0,10)>.webm` in cacheImagesDir → ffmpeg strip: `-i video -vf fps=1/4,scale=720:-1,tile=4x4 -frames:v 1 strip.jpg` via `child_process.spawn` (promisified) with the injected `ffmpegFn` default → read strip base64 → return `{ file, base64, frames }`. Any spawn failure → `{ error: MOTION_FFMPEG_HINT }`; loader/launch failure → `{ error: CAPTURE_INSTALL_HINT }`.

Handler + registration mirror capture (`asMcpResult`, url schema, `frames: z.number().int().min(4).max(36).default(16)`).

- [ ] **Step 4: GREEN + suite** — expect ≥90/89.
- [ ] **Step 5: Commit** — `git commit -m "feat: record_site_motion tool (filmstrip inline + webm path)"`

---

### Task 5: Docs, version, live probes

**Files:**
- Modify: `README.md`, `package.json`, `skills/awwwards-inspiration/SKILL.md` (+ user-scope sync)

- [ ] **Step 1:** README Tools table: add `record_site_motion` row (returns filmstrip + video path; needs playwright + ffmpeg-static); note capture/analyze work on heavy sites now. `package.json` → 1.5.0.
- [ ] **Step 2:** SKILL.md motion-capture paragraph: add "or call `record_site_motion` directly (filmstrip comes back inline)"; tool-reference table gains the row. Sync user-scope copy (`cp` to `~/.zcode/skills/awwwards-inspiration/SKILL.md`).
- [ ] **Step 3:** Full offline verification: `npm run typecheck && npm test && npm run build`.
- [ ] **Step 4:** Live stdio probes (manual):
  1. `capture_live_site` on `https://www.ordrhealth.com` (previously timing out) → isError false.
  2. `search_sites` with `{"query":"magazine editorial","count":4}` → suggestion line with `magazine-newspaper-blog`.
  3. `get_site_details` on a fresh SOTD slug → `Jury score: N/10` line.
  4. `record_site_motion` on `file:///C:/Users/Afjal/editorial-site/index.html` → filmstrip image block + webm path.
- [ ] **Step 5: Commit** — `git commit -m "docs: v1.5.0 — record_site_motion, score, search UX; version 1.5.0"`

---

## Post-plan notes

- Budget discipline for record_site_motion is critical (30s ceiling): dwell 5s + scroll ~8s + interactions ~14s ≈ 27s worst case — keep scroll/hover timings tight per the Task 4 constraint note.
- The jury-score parse must NOT satisfy the all-empty detail guard alone (unchanged guard).
- If the l-i-s-a fixture lacks the score anchor, the positive handler assertion moves to a synthetic-HTML test (documented in Task 2 Step 1).
