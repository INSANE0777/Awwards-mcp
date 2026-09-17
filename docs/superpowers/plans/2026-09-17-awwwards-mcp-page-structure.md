# Page Structure Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `analyze_page_structure({ url })` — a Playwright-based MCP tool returning a page's section band map (tag, label, background, offset, height per band) — plus the skill doctrine making reference-vs-build band comparison a mandatory step, and the polish items from the cerebrium loop.

**Architecture:** New `src/structure.ts`: in-page candidate collection (full-width opaque elements ≥120px tall) via one `page.evaluate`, then a pure Node `collapseBands` sweep that resolves each y-position's background to the smallest covering candidate (the pixel-scanline method rebuilt on DOM rects — exact colors, no image decoding). Handler + registration mirror the existing optional-Playwright capture pattern. Spec: `docs/superpowers/specs/2026-09-17-awwwards-mcp-page-structure-design.md`.

**Tech Stack:** Existing stack only — TypeScript 5 strict ESM, official MCP SDK + zod, vitest. Playwright stays an optional devDependency (dynamic import, never a runtime dep).

## Global Constraints

- Suite baseline: **66/66**; target after this plan: **≥74/74**. All new tests offline (injectable loader); live stdio probes are manual (Task 3).
- Playwright optional: dynamic `import("playwright" as string)` only; missing-playwright → `CAPTURE_INSTALL_HINT`-style error object, never a thrown dependency error. Reuse `CAPTURE_INSTALL_HINT` from `src/capture.js`.
- Never-throw handler contract: failures → `{ content: [text], isError: true }`.
- `file://` URLs must work (local build analysis) — `goto` handles them natively.
- In-page candidate filter: `width ≥ 0.6 × body width` AND `height ≥ 120` AND own `background-color` alpha > 0; cap 300 candidates. Body is ALWAYS included as the base candidate (its own backgroundColor, even transparent → recorded as-is).
- `collapseBands(cands, totalHeight, maxBands = 40)`: sweep y in 8px steps; bg(y) = the covering candidate with the SMALLEST height (most specific); merge consecutive same-background runs; absorb bands < 40px into the previous band; if still > maxBands, merge the smallest band into its previous neighbor repeatedly; round all coordinates.
- SKILL.md lives in TWO synced copies: repo `skills/awwwards-inspiration/SKILL.md` and `~/.zcode/skills/awwwards-inspiration/SKILL.md` — edit the repo copy, then copy it over the user-scope one (established manual-sync convention).
- Version bump 1.3.0 → 1.4.0 lands in Task 2. Committing to `main` is approved. Local `grep` is ugrep (mis-handles `<>`) — verify content with Node.

---

### Task 1: src/structure.ts — candidate scan + collapseBands + analyzePageStructure

**Files:**
- Create: `src/structure.ts`
- Create: `test/structure.test.ts`

**Interfaces:**
- Consumes: `CAPTURE_INSTALL_HINT` from `src/capture.js`.
- Produces (exact surface for later tasks, from `src/structure.js`):
  - `interface RawBand { tag: string; label: string; bg: string; top: number; height: number; textStart: string }`
  - `interface PageBand { index: number; tag: string; label: string; background: string; offsetTop: number; height: number; textStart: string }`
  - `interface PageStructure { url: string; title: string; totalHeight: number; bands: PageBand[] }`
  - `collapseBands(cands: RawBand[], totalHeight: number, maxBands = 40): PageBand[]`
  - `SCAN_SNIPPET: () => RawBand[]` (serialized into `page.evaluate`; documented in-page filter per Global Constraints)
  - `analyzePageStructure(url: string, loader?: () => Promise<any>): Promise<PageStructure | { error: string }>`

- [ ] **Step 1: Write the failing tests (create test/structure.test.ts)**

```ts
import { describe, expect, it, vi } from "vitest";
import { collapseBands, analyzePageStructure } from "../src/structure.js";
import type { RawBand } from "../src/structure.js";

const band = (over: Partial<RawBand> = {}): RawBand => ({
  tag: "section",
  label: "",
  bg: "rgb(16, 21, 42)",
  top: 0,
  height: 1000,
  textStart: "",
  ...over,
});

describe("collapseBands", () => {
  it("resolves each y to the smallest covering candidate (most specific wins)", () => {
    const bands = collapseBands(
      [
        band({ label: "body", bg: "rgb(16, 21, 42)", top: 0, height: 2000 }),
        band({ label: ".shell", bg: "rgb(240, 242, 247)", top: 400, height: 1200 }),
      ],
      2000,
    );
    // body band 0-400, shell band 400-1600, body again 1600-2000
    expect(bands.map((b) => b.label)).toEqual(["body", ".shell", "body"]);
    expect(bands.map((b) => b.height)).toEqual([400, 1200, 400]);
  });

  it("merges consecutive runs with the same background", () => {
    const bands = collapseBands(
      [
        band({ label: "a", bg: "rgb(1, 1, 1)", top: 0, height: 300 }),
        band({ label: "b", bg: "rgb(1, 1, 1)", top: 300, height: 300 }),
      ],
      600,
    );
    expect(bands.length).toBe(1);
    expect(bands[0].height).toBe(600);
    expect(bands[0].label).toBe("a"); // first label wins on merge
  });

  it("absorbs tiny bands (<40px) into the previous band", () => {
    const bands = collapseBands(
      [
        band({ label: "big", bg: "rgb(1, 1, 1)", top: 0, height: 500 }),
        band({ label: "sliver", bg: "rgb(2, 2, 2)", top: 500, height: 30 }),
        band({ label: "tail", bg: "rgb(1, 1, 1)", top: 530, height: 470 }),
      ],
      1000,
    );
    expect(bands.map((b) => b.label)).toEqual(["big", "tail"]);
  });

  it("caps band count by merging the smallest band into its previous neighbor", () => {
    const many: RawBand[] = Array.from({ length: 12 }, (_, i) =>
      band({ label: `b${i}`, bg: `rgb(${i}, ${i}, ${i})`, top: i * 100, height: 100 }),
    );
    const bands = collapseBands(many, 1200, 5);
    expect(bands.length).toBeLessThanOrEqual(5);
    expect(bands[bands.length - 1].offsetTop + bands[bands.length - 1].height).toBe(1200);
  });

  it("rounds coordinates and assigns sequential indexes", () => {
    const bands = collapseBands(
      [band({ top: 0.4, height: 999.6, label: "x" })],
      1000,
    );
    expect(bands[0].index).toBe(0);
    expect(bands[0].offsetTop).toBe(0);
    expect(bands[0].height).toBe(1000);
  });
});

describe("analyzePageStructure", () => {
  it("builds the structure from the loader's evaluate result", async () => {
    const fake = {
      launch: async () => ({
        newPage: async () => ({
          goto: async () => {},
          evaluate: async () => ({
            title: "Test Page",
            totalHeight: 2000,
            candidates: [
              band({ label: "body", bg: "rgb(16, 21, 42)", top: 0, height: 2000 }),
              band({ tag: "section", label: ".shell", bg: "rgb(240, 242, 247)", top: 500, height: 1000, textStart: "Production speed" }),
            ],
          }),
        }),
        close: async () => {},
      }),
    };
    const res = await analyzePageStructure("https://example.com", async () => ({ chromium: fake }));
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.title).toBe("Test Page");
      expect(res.totalHeight).toBe(2000);
      expect(res.bands.map((b) => b.label)).toContain(".shell");
      expect(res.bands[0].background).toBe("rgb(16, 21, 42)");
    }
  });

  it("returns the install hint when playwright is missing", async () => {
    const res = await analyzePageStructure("https://example.com", async () => {
      throw new Error("Cannot find package 'playwright'");
    });
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toContain("npx playwright install chromium");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/structure.test.ts`
Expected: FAIL — `../src/structure.js` cannot be resolved.

- [ ] **Step 3: Implement src/structure.ts**

```ts
import { CAPTURE_INSTALL_HINT } from "./capture.js";

export interface RawBand {
  tag: string;
  label: string;
  bg: string;
  top: number;
  height: number;
  textStart: string;
}

export interface PageBand {
  index: number;
  tag: string;
  label: string;
  background: string;
  offsetTop: number;
  height: number;
  textStart: string;
}

export interface PageStructure {
  url: string;
  title: string;
  totalHeight: number;
  bands: PageBand[];
}

// Runs IN THE PAGE via page.evaluate. Collects full-width, tall, opaque
// elements as band candidates; body is always the base candidate. Gradient
// shorthand backgrounds leave backgroundColor transparent — such sections
// fall through to the nearest opaque ancestor (usually body).
export const SCAN_SNIPPET = (): RawBand[] => {
  const bodyW = document.body.getBoundingClientRect().width || 1;
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const out: RawBand[] = [
    {
      tag: "body",
      label: "body",
      bg: bodyBg,
      top: 0,
      height: Math.round(document.documentElement.scrollHeight),
      textStart: "",
    },
  ];
  const seen = new Set<Element>();
  const visit = (el: Element, depth: number) => {
    if (depth > 6 || out.length >= 300 || seen.has(el)) return;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (el !== document.body && r.width >= 0.6 * bodyW && r.height >= 120) {
      const s = getComputedStyle(el);
      const m = /rgba?\(([^)]+)\)/.exec(s.backgroundColor);
      const alpha = m ? (m[1].split(",").length === 4 ? parseFloat(m[1].split(",")[3]) : 1) : 0;
      if (alpha > 0) {
        out.push({
          tag: el.tagName.toLowerCase(),
          label: (el.id ? "#" + el.id : "") + (el.classList.length ? "." + String(el.classList[0]) : ""),
          bg: s.backgroundColor,
          top: Math.round(r.top + window.scrollY),
          height: Math.round(r.height),
          textStart: (el.textContent ?? "").trim().slice(0, 60),
        });
      }
    }
    for (const child of el.children) visit(child, depth + 1);
  };
  visit(document.body, 0);
  return out;
};

export function collapseBands(cands: RawBand[], totalHeight: number, maxBands = 40): PageBand[] {
  const usable = cands.filter((c) => c.height > 0);
  const STEP = 8;
  const bgAt = (y: number): RawBand | null => {
    let best: RawBand | null = null;
    for (const c of usable) {
      if (c.top <= y && y < c.top + c.height) {
        if (!best || c.height < best.height) best = c;
      }
    }
    return best;
  };
  const runs: { cand: RawBand; top: number; height: number }[] = [];
  let y = 0;
  let current: { cand: RawBand; top: number } | null = null;
  while (y < totalHeight) {
    const c = bgAt(y);
    if (current && c && c.bg === current.cand.bg) {
      // same run continues
    } else {
      if (current) runs.push({ cand: current.cand, top: current.top, height: y - current.top });
      current = c ? { cand: c, top: y } : null;
      if (!c) {
        // no candidate covers y (gap): extend nothing; advance and re-handle
      }
    }
    y += STEP;
  }
  if (current) runs.push({ cand: current.cand, top: current.top, height: totalHeight - current.top });
  // Merge adjacent same-bg runs (first label wins), absorb tiny slivers.
  const merged: { cand: RawBand; top: number; height: number }[] = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.cand.bg === r.cand.bg) prev.height = r.top + r.height - prev.top;
    else if (r.height < 40 && prev) prev.height = r.top + r.height - prev.top;
    else merged.push({ ...r });
  }
  // Cap: merge the smallest band into its previous neighbor until <= maxBands.
  while (merged.length > maxBands) {
    let idx = 1;
    for (let i = 1; i < merged.length; i++) if (merged[i].height < merged[idx].height) idx = i;
    merged[idx - 1].height = merged[idx - 1].height + merged[idx].height;
    merged.splice(idx, 1);
  }
  return merged.map((r, i) => ({
    index: i,
    tag: r.cand.tag,
    label: r.cand.label,
    background: r.cand.bg,
    offsetTop: Math.round(r.top),
    height: Math.round(r.height),
    textStart: r.cand.textStart,
  }));
}

export async function analyzePageStructure(
  url: string,
  loader: () => Promise<any> = () => import("playwright" as string),
): Promise<PageStructure | { error: string }> {
  let chromium: any;
  try {
    ({ chromium } = await loader());
  } catch {
    return { error: CAPTURE_INSTALL_HINT };
  }
  let browser: any;
  try {
    browser = await chromium.launch();
  } catch {
    return { error: CAPTURE_INSTALL_HINT };
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    const raw = (await page.evaluate(SCAN_SNIPPET)) as {
      title: string;
      totalHeight: number;
      candidates: RawBand[];
    };
    // NOTE: SCAN_SNIPPET as written returns an array; adapt here if the
    // snippet shape differs — see implementation note below.
    return {
      url,
      title: raw.title,
      totalHeight: raw.totalHeight,
      bands: collapseBands(raw.candidates, raw.totalHeight),
    };
  } finally {
    try {
      await browser.close();
    } catch {
      // keep the primary error
    }
  }
}
```

**Implementation note (resolve when writing the real file):** `page.evaluate` can only serialize plain data, so `SCAN_SNIPPET` must return `{ title, totalHeight, candidates }` — read `document.title` and `scrollHeight` in-page and return the object; the array shown in the snippet sketch is the `candidates` field. Write the snippet accordingly (single function returning the object; the visit loop inside it). The test above fakes exactly this object shape.

- [ ] **Step 4: Run to verify green, then full suite**

Run: `npx vitest run test/structure.test.ts && npm test`
Expected: PASS — 74/74 (66 + 5 collapse + 2 analyze + 1 extra if you split a test; report actuals). `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/structure.ts test/structure.test.ts
git commit -m "feat: page band-map extraction (in-page scan + collapseBands)"
```

---

### Task 2: Handler, registration, README, version 1.4.0

**Files:**
- Modify: `src/server.ts`, `src/cli.ts`, `README.md`, `package.json`
- Modify: `test/server.test.ts` (append describe block)

**Interfaces:**
- Consumes: `analyzePageStructure`, `PageStructure` from `src/structure.js`; handler patterns in `src/server.ts` (never-throw, `errorResponse`); registration pattern in `src/cli.ts` (including whatever adapter the existing tools use, e.g. `asMcpResult`).
- Produces: `analyze_page_structure(args: { url: string; maxBands?: number }): Promise<ToolResponse>` on the `Handlers` interface + `createHandlers` return + registered tool.

- [ ] **Step 1: Write failing handler tests (append to test/server.test.ts)**

```ts
describe("analyze_page_structure", () => {
  it("returns the band map as a JSON text block", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const structure = {
      url: "file:///build/index.html",
      title: "Build",
      totalHeight: 2000,
      bands: [
        { index: 0, tag: "body", label: "body", background: "rgb(16, 21, 42)", offsetTop: 0, height: 1000, textStart: "" },
        { index: 1, tag: "section", label: ".shell", background: "rgb(240, 242, 247)", offsetTop: 1000, height: 1000, textStart: "Production speed" },
      ],
    };
    const h = createHandlers({
      client,
      cache,
      analyzeFn: async () => structure,
    });
    const res = await h.analyze_page_structure({ url: "file:///build/index.html" });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.totalHeight).toBe(2000);
    expect(parsed.bands.length).toBe(2);
  });

  it("surfaces the install hint as isError when playwright is missing", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const h = createHandlers({
      client,
      cache,
      analyzeFn: async () => ({ error: "install playwright" }),
    });
    const res = await h.analyze_page_structure({ url: "https://example.com" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain("install playwright");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL — handler `analyze_page_structure` does not exist / `analyzeFn` not accepted.

- [ ] **Step 3: Implement**

3a. `src/server.ts`: add `analyzeFn?: (url: string) => Promise<PageStructure | { error: string }>` to the `createHandlers` deps type; add `analyze_page_structure` to the `Handlers` interface; add the handler next to `capture_live_site` (mirroring its shape — lazy dynamic import default: `const analyze = deps.analyzeFn ?? ((url: string) => (import("./structure.js")).then((m) => m.analyzePageStructure(url)))`); success → `{ content: [text(JSON.stringify(structure, null, 1))] }`; `{ error }` → isError text; wrap in try/catch → `errorResponse`.

3b. `src/cli.ts`: register after `capture_live_site`, mirroring the neighboring registration shape (adapter included):

```ts
server.tool(
  "analyze_page_structure",
  "Extract a page's section band map (tag, label, background color, offset, height per band) via a headless browser. Works on live URLs and file:// paths — use it to compare a reference site's structure against your local build.",
  {
    url: z.string().url().describe("Absolute URL (https:// or file://) of the page to analyze"),
    maxBands: z.number().int().min(5).max(60).default(40).describe("Cap on returned bands"),
  },
  (args) => asMcpResult(handlers.analyze_page_structure(args)),
);
```

(If neighbors do not use `asMcpResult`, match their actual adapter.)

3c. `package.json`: version `1.3.0` → `1.4.0`. `README.md`: add to the Tools table after `capture_live_site`:

```markdown
| `analyze_page_structure` | Section band map of any page (live URL or local file:// build): tag, background, offset, height per band. Compare a reference site's structure against your build. |
```

- [ ] **Step 4: Verify green**

Run: `npx vitest run test/server.test.ts && npm test && npm run typecheck && npm run build`
Expected: 76/76 (74 + 2), typecheck + build clean.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/cli.ts README.md package.json test/server.test.ts
git commit -m "feat: analyze_page_structure tool; docs and 1.4.0"
```

---

### Task 3: SKILL.md doctrine + live probes

**Files:**
- Modify: `skills/awwwards-inspiration/SKILL.md`
- Sync: `~/.zcode/skills/awwwards-inspiration/SKILL.md` (copy of the repo file)

**Interfaces:**
- Consumes: the registered tool (Task 2).
- Produces: skill doctrine per the spec; live verification of the tool on a real reference + the local build.

- [ ] **Step 1: Apply the SKILL.md doctrine (repo copy)**

1. In the inspiration loop, after the current step 7 ("State the design direction before writing code"), insert a new step and renumber nothing (it becomes step 8):

```markdown
8. **Verify structure, then polish.** After building, capture your own build
   full-page (`capture_live_site` on its `file://` or served URL) and run
   `analyze_page_structure` on BOTH the reference and the build. Compare band
   maps section by section (count, order, backgrounds, heights). Fix
   distribution mismatches first — a section that is 3× the reference's height
   is a structural bug no amount of pixel polish fixes. Match the reference's
   band structure, never just its total height.
```

2. In the anti-patterns list, add:

```markdown
- **Padding empty bands to match total height** — if your build's total height
  matches the reference but a spacer/background band is far taller than the
  reference's equivalent, the height was stolen from real content sections.
  Compare band maps, not totals.
```

3. Polish edits: in step 4, after "capture it full-page first", add "(and later capture your own build the same way — compare both against each other)". In the tool reference table, add the `analyze_page_structure` row (one line, matching the table's existing style).

- [ ] **Step 2: Sync the user-scope skill copy**

```bash
cp "skills/awwwards-inspiration/SKILL.md" "$HOME/.zcode/skills/awwwards-inspiration/SKILL.md"
```

- [ ] **Step 3: Live stdio probes (manual; ~2 browser runs)**

Probe 1 — local build (the cerebrium recreation):

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"analyze_page_structure","arguments":{"url":"file:///C:/Users/Afjal/cerebrium-recreation/index.html"}}}' \
  | node dist/cli.js 2>/dev/null > /tmp/ps-build.json; node --input-type=module -e "
import { readFileSync } from 'node:fs';
const lines = readFileSync('/tmp/ps-build.json', 'utf8').split('\n').filter(Boolean);
const res = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).find(l => l?.id === 2)?.result;
const s = JSON.parse(res.content[0].text);
console.log('totalHeight:', s.totalHeight, 'bands:', s.bands.length);
console.log(s.bands.map(b => b.index + ' ' + b.tag + ' ' + b.label + ' ' + b.background + ' @' + b.offsetTop + ' h' + b.height).join('\n'));
"
```

Expected: `totalHeight` ≈ 10870; alternating dark/light bands matching the known map (dark ~1489, light ~3721, dark ~2225, light ~2559, dark footer).

Probe 2 — the live reference:

Same probe with `"url":"https://cerebrium.ai"` (or the canonical URL). Expected: isError false, a band map with a plausible marketing-page structure (dark hero band first, light sections). If the site blocks headless browsers, record the actual error — the tool contract is still verified by probe 1; note probe 2's outcome as env-only.

- [ ] **Step 4: Commit**

```bash
git add skills/awwwards-inspiration/SKILL.md
git commit -m "feat: skill doctrine — structure-before-pixels loop step and band-map anti-pattern"
```

---

## Post-plan notes for the implementer

- The fake `evaluate` in tests returns `{ title, totalHeight, candidates }` — the SCAN_SNIPPET must return exactly that object shape (title/totalHeight read in-page).
- The collapseBands sweep must handle "no candidate covers y" (gaps between candidates): treat as continuation of the previous run's bg when a run is open, else skip until coverage resumes — never emit a null band.
- If probe 2 (live cerebrium.ai) fails due to bot protection, that is env-only — record it and rely on probe 1.
- Suite target ≥ 76/76; report actuals.
