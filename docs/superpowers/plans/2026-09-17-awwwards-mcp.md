# Awwwards MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `awwwards-mcp`, a free open-source MCP server that gives AI agents design inspiration from Awwwards: search award-winning sites with inline screenshots, extract design DNA (palette, technologies, elements, awards), and optionally capture live sites.

**Architecture:** Four single-purpose modules — `awwwards.ts` (polite HTTP client, 1 req/s, robots-compliant), `parsers.ts` (pure HTML→typed-objects), `cache.ts` (SQLite + image disk cache at `~/.awwwards-mcp/`), `server.ts` (tool handlers) — wired to an MCP stdio server by `cli.ts`. Spec: `docs/superpowers/specs/2026-09-17-awwwards-mcp-design.md`.

**Tech Stack:** TypeScript 5 (strict, ESM, NodeNext), Node ≥22.5, `@modelcontextprotocol/sdk` + `zod` (only runtime deps), `node:sqlite` (built-in — no native modules), vitest.

## Global Constraints

- Node `>=22.5.0` (`node:sqlite` requires it; amends spec's "≥20" — Node 20 is EOL as of 2026-04 and this removes the native-build pain of better-sqlite3 on Windows).
- Runtime dependencies limited to `@modelcontextprotocol/sdk` and `zod`. Playwright is an optional peer, never a hard dependency.
- Robots-compliant request paths ONLY: `/websites/`, `/websites/<filter>/`, `/sites/<slug>`. Never `?page=` URLs, never `/search-websites`.
- Max 1 request/second to `www.awwwards.com`. `assets.awwwards.com` (CDN) is exempt.
- **Combined filter URLs 404** (verified 2026-09-17: `/websites/%23404040/3d/` → 404). One filter per URL (priority color > award > technology > first tag); remaining filters applied client-side.
- Verified award filter paths: `websites/sites_of_the_day` (underscores), `websites/developer`, `websites/honorable`.
- Thumbnail URL pattern: `https://assets.awwwards.com/awards/media/cache/thumb_880_660/<thumbnailPath>` (880) or `thumb_440_330/<thumbnailPath>` (440).
- All unit tests run offline against committed HTML fixtures. Live network only in the manual smoke task.
- User works on Windows (Git Bash); all commands must work in Git Bash on Windows.
- Spec amendment (2026-09-17): `author` field dropped from `SiteDetails` — not present in awwwards' server-rendered HTML.

---

### Task 1: Project scaffold and shared types

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/types.ts`

**Interfaces:**
- Produces: `SiteSummary { id: number; slug: string; title: string; createdAt: number; tags: string[]; thumbnailPath: string; liveUrl: string | null; detailPath: string; awards: string[] }`, `SiteDetails { slug: string; title: string | null; description: string | null; palette: string[]; technologies: string[]; elements: string[]; awards: { title: string; date: string }[]; ogImage: string | null; liveUrl: string | null }`, `Categories { colors: string[]; filters: string[] }` — every later task imports these from `src/types.js`.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "awwwards-mcp",
  "version": "1.0.0",
  "description": "Free MCP server giving AI agents design inspiration from Awwwards: search award-winning sites with inline screenshots and extract design DNA.",
  "type": "module",
  "license": "MIT",
  "bin": { "awwwards-mcp": "dist/cli.js" },
  "files": ["dist", "README.md"],
  "engines": { "node": ">=22.5.0" },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "smoke": "tsx test/live-smoke.ts",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create vitest.config.ts and .gitignore**

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

`.gitignore`:

```
node_modules/
dist/
*.log
```

- [ ] **Step 4: Create src/types.ts**

```ts
export interface SiteSummary {
  id: number;
  slug: string;
  title: string;
  createdAt: number; // unix seconds
  tags: string[];
  thumbnailPath: string; // e.g. "submissions/2026/08/xxx.jpg"
  liveUrl: string | null;
  detailPath: string; // e.g. "/sites/l-i-s-a"
  awards: string[]; // e.g. ["Site of the Day", "Developer Award"]
}

export interface SiteDetails {
  slug: string;
  title: string | null;
  description: string | null;
  palette: string[]; // hex codes, uppercase, e.g. "#000000"
  technologies: string[];
  elements: string[];
  awards: { title: string; date: string }[];
  ogImage: string | null;
  liveUrl: string | null;
}

export interface Categories {
  colors: string[]; // hex codes, uppercase
  filters: string[]; // tag/technology slugs, e.g. "3d", "webgl"
}
```

- [ ] **Step 5: Install dependencies and typecheck**

Run: `cd "A:/AWWARDS MCP" && npm install && npm run typecheck`
Expected: install succeeds, `tsc --noEmit` passes with no errors.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold awwwards-mcp project with shared types"
```

---

### Task 2: Capture offline HTML fixtures

**Files:**
- Create: `test/fixtures/listing.html`, `test/fixtures/detail.html`

**Interfaces:**
- Produces: fixture files consumed by Tasks 3, 4, 5 and the fake fetch in Task 6. `listing.html` = saved `https://www.awwwards.com/websites/`, `detail.html` = saved `https://www.awwwards.com/sites/l-i-s-a`.

- [ ] **Step 1: Download the two pages with a browser User-Agent**

```bash
mkdir -p test/fixtures
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
curl -s -A "$UA" "https://www.awwwards.com/websites/" -o test/fixtures/listing.html
curl -s -A "$UA" "https://www.awwwards.com/sites/l-i-s-a" -o test/fixtures/detail.html
```

- [ ] **Step 2: Verify fixtures contain the markers the parsers rely on**

Run:
```bash
grep -c "card-site js-container-figure" test/fixtures/listing.html
grep -c "data-collectable-model-value" test/fixtures/listing.html
grep -c "list-palette__name" test/fixtures/detail.html
grep -c "Technologies & Tools" test/fixtures/detail.html
grep -c "lisa.locomotive.ca" test/fixtures/detail.html
```
Expected: first two ≥ 25, remaining ≥ 1 each. If any is 0, awwwards.com changed its markup — stop and re-verify the parser assumptions before proceeding.

- [ ] **Step 3: Commit**

```bash
git add test/fixtures && git commit -m "test: capture awwwards listing and detail page fixtures"
```

---

### Task 3: parseListing (TDD)

**Files:**
- Create: `src/parsers.ts`
- Test: `test/parsers.test.ts`

**Interfaces:**
- Consumes: `SiteSummary` from `src/types.js`.
- Produces: `parseListing(html: string): SiteSummary[]`, `decodeEntities(s: string): string` — used by Task 6's client flow and Task 7's handlers.

Listing-page facts the parser relies on (verified against the fixture): each card has a wrapper with `data-collectable-model-value="<html-escaped JSON>"` carrying `id, slug, title, createdAt, tags, images.thumbnail, type`; the card block immediately after contains the detail href `/sites/<slug>` and the live-site anchor (`class="figure-rollover__bt"` with `href="https://..."`); award badges are `budget-tag--<key>` spans (`dev` → Developer Award, `sotd` → Site of the Day, `hm` → Honorable Mention). Card blobs for non-site items (e.g. collections) must be skipped — only entries whose card contains a real `/sites/` href and whose `type` is `"submission"` are kept.

- [ ] **Step 1: Write the failing test**

`test/parsers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseListing, decodeEntities } from "../src/parsers.js";

const FIXTURES = join(__dirname, "fixtures");
const listing = () => readFileSync(join(FIXTURES, "listing.html"), "utf8");

describe("decodeEntities", () => {
  it("unescapes the entities found in card JSON blobs", () => {
    expect(decodeEntities("&quot;a&quot; &amp; &quot;b&quot;")).toBe('"a" & "b"');
    expect(decodeEntities("L&#039;Oreal")).toBe("L'Oreal");
  });
});

describe("parseListing", () => {
  it("parses the ~31 site cards from the listing fixture", () => {
    const sites = parseListing(listing());
    expect(sites.length).toBeGreaterThanOrEqual(25);
  });

  it("extracts L.I.S.A. with live url, tags, thumbnail and award badge", () => {
    const lisa = parseListing(listing()).find((s) => s.slug === "l-i-s-a");
    expect(lisa).toBeDefined();
    expect(lisa!.title).toBe("L.I.S.A.");
    expect(lisa!.liveUrl).toBe("https://lisa.locomotive.ca/en");
    expect(lisa!.detailPath).toBe("/sites/l-i-s-a");
    expect(lisa!.tags).toContain("WebGL");
    expect(lisa!.thumbnailPath).toContain("submissions/2026/08/");
    expect(lisa!.awards).toContain("Developer Award");
    expect(lisa!.createdAt).toBeGreaterThan(0);
  });

  it("skips non-site collectables (no /sites/ href)", () => {
    const sites = parseListing(listing());
    for (const s of sites) expect(s.detailPath).toMatch(/^\/sites\//);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — "Cannot find module '../src/parsers.js'" (or equivalent).

- [ ] **Step 3: Write the implementation**

`src/parsers.ts`:

```ts
import type { SiteSummary } from "./types.js";

const ENTITIES: Record<string, string> = {
  "&quot;": '"',
  "&amp;": "&",
  "&#039;": "'",
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(?:quot|amp|#0?39|lt|gt|nbsp);/g, (e) => ENTITIES[e] ?? e);
}

const AWARD_LABELS: Record<string, string> = {
  sotd: "Site of the Day",
  dev: "Developer Award",
  hm: "Honorable Mention",
  sotm: "Site of the Month",
  mobile: "Mobile Excellence",
  ecom: "E-Commerce Award",
};

// Card JSON blob and its markup: the blob sits in data-collectable-model-value
// immediately before the card markup. The blob is HTML-entity-escaped JSON, so
// the closing quote of the attribute is the first raw `">` after the split point.
export function parseListing(html: string): SiteSummary[] {
  const sites: SiteSummary[] = [];
  const parts = html.split('data-collectable-model-value="');
  for (const part of parts.slice(1)) {
    const end = part.indexOf('">');
    if (end < 0) continue;
    let meta: any;
    try {
      meta = JSON.parse(decodeEntities(part.slice(0, end)));
    } catch {
      continue;
    }
    if (!meta?.slug || !meta?.title) continue;
    if (meta.type && meta.type !== "submission") continue;
    const card = part.slice(end, end + 8000); // one card block is ~3KB; 8KB is safe
    const detailMatch = card.match(/href="(\/sites\/[^"#?]+)"/);
    if (!detailMatch) continue; // collections/other modules are not site cards
    const liveMatch = card.match(/class="figure-rollover__bt"[^>]*href="(https?:\/\/[^"]+)"/);
    const awards = [...card.matchAll(/budget-tag--([a-z-]+)/g)].map(
      (m) => AWARD_LABELS[m[1]] ?? m[1],
    );
    sites.push({
      id: meta.id ?? 0,
      slug: meta.slug,
      title: decodeEntities(meta.title),
      createdAt: meta.createdAt ?? 0,
      tags: Array.isArray(meta.tags) ? meta.tags.map(decodeEntities) : [],
      thumbnailPath: meta.images?.thumbnail ?? "",
      liveUrl: liveMatch ? decodeEntities(liveMatch[1]) : null,
      detailPath: detailMatch[1],
      awards: [...new Set(awards)],
    });
  }
  return sites;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/parsers.ts test/parsers.test.ts && git commit -m "feat: parse awwwards listing pages into SiteSummary"
```

---

### Task 4: parseDetail (TDD)

**Files:**
- Modify: `src/parsers.ts` (append)
- Modify: `test/parsers.test.ts` (append describe block)

**Interfaces:**
- Consumes: `SiteDetails` from `src/types.js`, `decodeEntities` from Task 3.
- Produces: `parseDetail(html: string, slug: string): SiteDetails` — used by Task 7's `get_site_details`.

Detail-page facts the parser relies on (verified against the fixture): palette items are `<strong>HEX</strong> #<hex>` inside `list-palette__name`; technologies live in the section after the literal `Technologies & Tools</h2>` as anchors `class="button button--tag">Name<`; elements are `collectableTitle&quot;:&quot;<name>&quot;` blobs between `>Elements</h2>` and `>Color Palette</h2>`; awards appear as `<h2>Site of the Day - Sep 16, 2026</h2>` style headings; description is the `<h3 class="heading-6">…</h3>` after `>Description</h2>`; `og:image` meta has the full-size screenshot; the live site URL (and title) sit in the h1 anchor `<h1 class="heading-1 text-uppercase"> <a href="https://lisa.locomotive.ca/en" target="_blank" rel="noopener">L.I.S.A.</a> </h1>` — a non-awwwards host with `target="_blank" rel="noopener"` (note: NOT `noopener nofollow` on detail pages).

- [ ] **Step 1: Write the failing test (append to test/parsers.test.ts)**

```ts
import { parseDetail } from "../src/parsers.js";

const detail = () => readFileSync(join(FIXTURES, "detail.html"), "utf8");

describe("parseDetail", () => {
  const d = () => parseDetail(detail(), "l-i-s-a");

  it("extracts the color palette", () => {
    expect(d().palette.length).toBeGreaterThanOrEqual(1);
    expect(d().palette[0]).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("extracts technologies, elements and description", () => {
    expect(d().technologies.length).toBeGreaterThanOrEqual(3);
    expect(d().technologies).toContain("WebGL");
    expect(d().elements).toContain("3D model");
    expect(d().description).toContain("Locomotive Interactive Super Assistant");
  });

  it("extracts the award with date", () => {
    expect(d().awards.some((a) => a.title === "Site of the Day")).toBe(true);
    expect(d().awards[0].date).toMatch(/^[A-Z][a-z]+ \d{1,2}, \d{4}$/);
  });

  it("extracts og image and live url", () => {
    expect(d().ogImage).toContain("assets.awwwards.com");
    expect(d().liveUrl).toBe("https://lisa.locomotive.ca/en");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — parseDetail is not exported.

- [ ] **Step 3: Implement parseDetail (append to src/parsers.ts)**

```ts
import type { SiteDetails } from "./types.js";

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function parseDetail(html: string, slug: string): SiteDetails {
  const palette = [
    ...new Set(
      [...html.matchAll(/<strong>HEX<\/strong>\s*#([0-9A-Fa-f]{6})/g)].map((m) =>
        `#${m[1].toUpperCase()}`,
      ),
    ),
  ];

  const techIdx = html.indexOf("Technologies & Tools</h2>");
  const techSection = techIdx >= 0 ? html.slice(techIdx, techIdx + 6000) : "";
  const technologies = [
    ...new Set(
      [...techSection.matchAll(/class="button button--tag"[^>]*>([^<]+)</g)].map((m) =>
        stripTags(m[1]),
      ),
    ),
  ].filter(Boolean);

  const elStart = html.indexOf(">Elements</h2>");
  const elEnd = elStart >= 0 ? html.indexOf(">Color Palette</h2>", elStart) : -1;
  const elSection = elStart >= 0 && elEnd > elStart ? html.slice(elStart, elEnd) : "";
  const elements = [...elSection.matchAll(/collectableTitle&quot;:&quot;([^&]+)&quot;/g)].map(
    (m) => decodeEntities(m[1]),
  );

  const awards = [...html.matchAll(
    /(Site of the Day|Developer Award|Honorable Mention|Site of the Month|Mobile Excellence|E-Commerce Award)\s*[-–]\s*([A-Z][a-z]+ \d{1,2}, \d{4})/g,
  )].map((m) => ({ title: m[1], date: m[2] }));

  const descIdx = html.indexOf(">Description</h2>");
  const descMatch =
    descIdx >= 0
      ? html.slice(descIdx, descIdx + 3000).match(/<h3 class="heading-6">([\s\S]{0,2000}?)<\/h3>/)
      : null;

  const ogMatch = html.match(/property="og:image" content="([^"]+)"/);

  // Live site: the h1 anchor points at the awarded site itself
  // (verified: <h1 class="heading-1 text-uppercase"> <a href="https://..." target="_blank" rel="noopener">TITLE</a>).
  // Fallback: first blank-target noopener anchor to a non-awwwards host.
  const h1Match = html.match(
    /<h1 class="heading-1[^"]*">\s*<a href="(https?:\/\/(?!www\.awwwards\.com|assets\.awwwards\.com)[^"]+)"[^>]*>([\s\S]*?)<\/a>/,
  );
  const liveFallback = h1Match
    ? null
    : html.match(
        /href="(https?:\/\/(?!www\.awwwards\.com|assets\.awwwards\.com)[^"]+)"[^>]*target="_blank" rel="noopener"/,
      );
  const liveUrl = h1Match?.[1] ?? liveFallback?.[1] ?? null;
  const titleMatch = html.match(/property="og:title" content="([^"]+)"/);

  return {
    slug,
    title: titleMatch ? decodeEntities(titleMatch[1]) : (h1Match ? stripTags(h1Match[2]) : null),
    description: descMatch ? stripTags(descMatch[1]) || null : null,
    palette,
    technologies,
    elements,
    awards,
    ogImage: ogMatch ? decodeEntities(ogMatch[1]) : null,
    liveUrl: liveUrl ? decodeEntities(liveUrl) : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (8 tests). If the technologies/elements/liveUrl assertions fail, inspect `test/fixtures/detail.html` around the failing marker — the exact markup is documented in the Interfaces block; adjust the regex to the fixture, never the test expectation.

- [ ] **Step 5: Commit**

```bash
git add src/parsers.ts test/parsers.test.ts && git commit -m "feat: parse awwwards site detail pages (palette, tech, elements, awards)"
```

---

### Task 5: parseCategories (TDD)

**Files:**
- Modify: `src/parsers.ts` (append)
- Modify: `test/parsers.test.ts` (append describe block)

**Interfaces:**
- Consumes: `Categories` from `src/types.js`.
- Produces: `parseCategories(html: string): Categories` — used by Task 7's `list_categories`.

Listing-page facts: color filter links are `/websites/%23<HEX>/` (27 verified); tag/technology links are `/websites/<lowercase-slug>/`; `sites_of_the_day` must be excluded (it is an award collection, exposed via the `award` argument, not a tag).

- [ ] **Step 1: Write the failing test (append to test/parsers.test.ts)**

```ts
import { parseCategories } from "../src/parsers.js";

describe("parseCategories", () => {
  it("extracts color hex codes and tag slugs from the listing fixture", () => {
    const cats = parseCategories(listing());
    expect(cats.colors.length).toBeGreaterThanOrEqual(20);
    expect(cats.colors).toContain("#404040");
    expect(cats.filters).toContain("3d");
    expect(cats.filters).toContain("webgl");
    expect(cats.filters.length).toBeGreaterThanOrEqual(100);
  });

  it("excludes award collections from the filter list", () => {
    const cats = parseCategories(listing());
    expect(cats.filters).not.toContain("sites_of_the_day");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — parseCategories is not exported.

- [ ] **Step 3: Implement (append to src/parsers.ts)**

```ts
import type { Categories } from "./types.js";

const NON_FILTERS = new Set(["sites_of_the_day"]);

export function parseCategories(html: string): Categories {
  const colors = [
    ...new Set(
      [...html.matchAll(/href="\/websites\/%23([0-9A-Fa-f]{6})\/"/g)].map((m) =>
        `#${m[1].toUpperCase()}`,
      ),
    ),
  ].sort();
  const filters = [
    ...new Set(
      [...html.matchAll(/href="\/websites\/([a-z0-9-]{2,60})\/"/g)].map((m) => m[1]),
    ),
  ]
    .filter((s) => !NON_FILTERS.has(s))
    .sort();
  return { colors, filters };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/parsers.ts test/parsers.test.ts && git commit -m "feat: parse filter taxonomy (colors, tags) from listing pages"
```

---

### Task 6: Rate limiter and Awwwards HTTP client (TDD)

**Files:**
- Create: `src/awwwards.ts`
- Test: `test/awwwards.test.ts`

**Interfaces:**
- Consumes: `parseListing` from Task 3.
- Produces:
  - `class RateLimiter { constructor(intervalMs: number); acquire(): Promise<void> }`
  - `class BlockedError extends Error { status: number }`
  - `buildFilterUrl(filters: SearchFilters): string` where `SearchFilters { color?: string; tags?: string[]; technology?: string; award?: "sotd" | "developer" | "honorable"; query?: string }`
  - `thumbnailUrl(thumbPath: string, size?: 440 | 880): string`
  - `class AwwwardsClient { constructor(opts?: { rateLimiter?: RateLimiter; fetchFn?: typeof fetch }); getHtml(path: string): Promise<string>; getThumbnail(thumbPath: string, size?: 440 | 880): Promise<Buffer> }`
  - `USER_AGENT: string` — used by Task 10's smoke script.

- [ ] **Step 1: Write the failing test**

`test/awwwards.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AwwwardsClient,
  BlockedError,
  RateLimiter,
  buildFilterUrl,
  thumbnailUrl,
} from "../src/awwwards.js";

const FIXTURES = join(__dirname, "fixtures");
const listingHtml = () => readFileSync(join(FIXTURES, "listing.html"), "utf8");

describe("RateLimiter", () => {
  afterEach(() => vi.useRealTimers());

  it("serializes calls at least intervalMs apart", async () => {
    vi.useFakeTimers();
    const rl = new RateLimiter(1000);
    const stamps: number[] = [];
    const track = async () => {
      await rl.acquire();
      stamps.push(Date.now());
    };
    const a = track();
    const b = track();
    const c = track();
    await vi.advanceTimersByTimeAsync(2500);
    await Promise.all([a, b, c]);
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(999);
    expect(stamps[2] - stamps[1]).toBeGreaterThanOrEqual(999);
  });
});

describe("buildFilterUrl", () => {
  // Combined filter URLs 404 on awwwards.com (verified 2026-09-17), so exactly
  // one filter wins the URL; priority color > award > technology > first tag.
  it("picks the single most specific filter", () => {
    expect(buildFilterUrl({ color: "#404040" })).toBe(
      "https://www.awwwards.com/websites/%23404040/",
    );
    expect(buildFilterUrl({ award: "sotd" })).toBe(
      "https://www.awwwards.com/websites/sites_of_the_day/",
    );
    expect(buildFilterUrl({ technology: "WebGL", tags: ["3d"] })).toBe(
      "https://www.awwwards.com/websites/webgl/",
    );
    expect(buildFilterUrl({ tags: ["3d", "portfolio"] })).toBe(
      "https://www.awwwards.com/websites/3d/",
    );
    expect(buildFilterUrl({})).toBe("https://www.awwwards.com/websites/");
  });
});

describe("thumbnailUrl", () => {
  it("builds CDN urls in both sizes", () => {
    const p = "submissions/2026/08/abc.jpg";
    expect(thumbnailUrl(p, 880)).toContain("/thumb_880_660/" + p);
    expect(thumbnailUrl(p, 440)).toContain("/thumb_440_330/" + p);
  });
});

describe("AwwwardsClient", () => {
  const fakeFetch = (body: string | number, status = 200) =>
    vi.fn(async () =>
      new Response(typeof body === "string" ? body : "blocked", {
        status: typeof body === "string" ? status : body,
      }),
    ) as unknown as typeof fetch;

  it("fetches and parses a listing page through the rate limiter", async () => {
    const client = new AwwwardsClient({ fetchFn: fakeFetch(listingHtml()) });
    const html = await client.getHtml("/websites/");
    expect(html).toContain("card-site");
  });

  it("throws BlockedError immediately on 403 without retrying", async () => {
    const fetchFn = fakeFetch(403);
    const client = new AwwwardsClient({ fetchFn });
    await expect(client.getHtml("/websites/")).rejects.toBeInstanceOf(BlockedError);
    expect((fetchFn as any).mock.calls.length).toBe(1);
  });

  it("retries once on a network error then succeeds", async () => {
    const calls = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(new Response(listingHtml(), { status: 200 }));
    const client = new AwwwardsClient({ fetchFn: calls as unknown as typeof fetch });
    const html = await client.getHtml("/websites/");
    expect(html).toContain("card-site");
    expect(calls.mock.calls.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `../src/awwwards.js` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`src/awwwards.ts`:

```ts
import { parseListing } from "./parsers.js";
import type { SiteSummary } from "./types.js";

export const BASE_URL = "https://www.awwwards.com";
export const ASSETS_URL = "https://assets.awwwards.com";

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 awwwards-mcp/1.0";

export const AWARD_FILTERS = {
  sotd: "websites/sites_of_the_day",
  developer: "websites/developer",
  honorable: "websites/honorable",
} as const;

export type AwardFilter = keyof typeof AWARD_FILTERS;

export interface SearchFilters {
  color?: string;
  tags?: string[];
  technology?: string;
  award?: AwardFilter;
  query?: string;
}

// Combined filter URLs return 404 on awwwards.com (verified 2026-09-17), so
// exactly one filter is used in the URL — the most specific one. The caller
// applies the remaining filters client-side over the parsed results.
export function buildFilterUrl(filters: SearchFilters): string {
  if (filters.color) {
    return `${BASE_URL}/websites/%23${filters.color.replace("#", "").toUpperCase()}/`;
  }
  if (filters.award) return `${BASE_URL}/${AWARD_FILTERS[filters.award]}/`;
  const tag = filters.technology ?? filters.tags?.[0];
  if (tag) return `${BASE_URL}/websites/${encodeURIComponent(tag.toLowerCase())}/`;
  return `${BASE_URL}/websites/`;
}

export function thumbnailUrl(thumbPath: string, size: 440 | 880 = 880): string {
  const dim = size === 880 ? "880_660" : "440_330";
  return `${ASSETS_URL}/awards/media/cache/thumb_${dim}/${thumbPath}`;
}

export class BlockedError extends Error {
  constructor(
    url: string,
    public status: number,
  ) {
    super(
      `Awwwards is blocking requests (HTTP ${status} on ${url}). ` +
        "Try again later; the tool never retries through blocks.",
    );
  }
}

export class RateLimiter {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private intervalMs: number) {}

  acquire(): Promise<void> {
    const next = this.chain.then(async () => {
      const wait = this.last + this.intervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

export class AwwwardsClient {
  private rateLimiter: RateLimiter;
  private fetchFn: typeof fetch;

  constructor(opts: { rateLimiter?: RateLimiter; fetchFn?: typeof fetch } = {}) {
    this.rateLimiter = opts.rateLimiter ?? new RateLimiter(1000);
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  // Rate-limited page fetch with one retry on transient failures.
  // Blocks (403/429) are never retried.
  async getHtml(path: string): Promise<string> {
    const url = path.startsWith("http") ? path : BASE_URL + path;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.rateLimiter.acquire();
        const res = await this.fetchFn(url, {
          headers: { "User-Agent": USER_AGENT },
          redirect: "follow",
        });
        if (res.status === 403 || res.status === 429) throw new BlockedError(url, res.status);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return await res.text();
      } catch (err) {
        if (err instanceof BlockedError) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  // Thumbnail fetch from the CDN — not rate-limited.
  async getThumbnail(thumbPath: string, size: 440 | 880 = 880): Promise<Buffer> {
    const res = await this.fetchFn(thumbnailUrl(thumbPath, size), {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching thumbnail ${thumbPath}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

// Convenience for callers that want parsed results straight off the wire.
export async function fetchSites(client: AwwwardsClient, path: string): Promise<SiteSummary[]> {
  return parseListing(await client.getHtml(path));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (16 tests; cumulative from earlier tasks). If the RateLimiter timing test is flaky in CI, increase assertions' tolerance from 999 to 900.

- [ ] **Step 5: Commit**

```bash
git add src/awwwards.ts test/awwwards.test.ts && git commit -m "feat: polite awwwards HTTP client with rate limiter and filter URL builder"
```

---

### Task 7: SQLite cache (TDD)

**Files:**
- Create: `src/cache.ts`
- Test: `test/cache.test.ts`

**Interfaces:**
- Consumes: `SiteSummary`, `Categories` from `src/types.js`.
- Produces: `class Cache { constructor(rootDir: string, now?: () => number); upsertSites(sites: SiteSummary[]): void; getSites(maxAgeMs: number): SiteSummary[]; getSite(slug: string): SiteSummary | null; setMeta(key: string, value: unknown): void; getMeta<T>(key: string, maxAgeMs: number): T | null; getImage(assetPath: string, fetcher: () => Promise<Buffer>): Promise<Buffer> }`. Storage: `<rootDir>/cache.db` (SQLite via `node:sqlite`) and `<rootDir>/images/<sha1><ext>` (thumbnail disk cache).

- [ ] **Step 1: Write the failing test**

`test/cache.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import type { SiteSummary } from "../src/types.js";

const dirs: string[] = [];
const tmpDir = () => {
  const d = mkdtempSync(join(tmpdir(), "awwwards-mcp-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const site = (slug: string): SiteSummary => ({
  id: 1,
  slug,
  title: "Test Site",
  createdAt: 1789516800,
  tags: ["3D", "WebGL"],
  thumbnailPath: "submissions/2026/08/abc.jpg",
  liveUrl: "https://example.com",
  detailPath: `/sites/${slug}`,
  awards: ["Site of the Day"],
});

describe("Cache", () => {
  it("round-trips sites and honors TTL", () => {
    let t = 1_000_000;
    const cache = new Cache(tmpDir(), () => t);
    cache.upsertSites([site("a"), site("b")]);
    expect(cache.getSites(10_000).length).toBe(2);
    expect(cache.getSite("a")!.liveUrl).toBe("https://example.com");
    expect(cache.getSite("a")!.tags).toEqual(["3D", "WebGL"]);
    t += 20_000;
    expect(cache.getSites(10_000).length).toBe(0); // expired
    expect(cache.getSite("a")).toBeNull(); // expired lookups are misses
  });

  it("upserts over existing slugs instead of duplicating", () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site("a")]);
    const updated = { ...site("a"), title: "Renamed" };
    cache.upsertSites([updated]);
    expect(cache.getSites(10_000).length).toBe(1);
    expect(cache.getSites(10_000)[0].title).toBe("Renamed");
  });

  it("stores and expires arbitrary meta values", () => {
    let t = 1_000_000;
    const cache = new Cache(tmpDir(), () => t);
    cache.setMeta("categories", { colors: ["#000000"], filters: ["3d"] });
    expect(cache.getMeta<any>("categories", 5_000)!.filters).toEqual(["3d"]);
    t += 6_000;
    expect(cache.getMeta("categories", 5_000)).toBeNull();
  });

  it("caches image buffers on disk keyed by asset path", async () => {
    const cache = new Cache(tmpDir());
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return Buffer.from("jpeg-bytes-" + calls);
    };
    const first = await cache.getImage("submissions/2026/08/abc.jpg", fetcher);
    const second = await cache.getImage("submissions/2026/08/abc.jpg", fetcher);
    expect(calls).toBe(1);
    expect(second.equals(first)).toBe(true);
    expect(first.toString()).toContain("jpeg-bytes-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `../src/cache.js` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`src/cache.ts`:

```ts
import { createHash } from "node:crypto";
import { mkdirSync, readFile, writeFile } from "node:fs/promises";
import { mkdirSync as mkdirSyncCb } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SiteSummary } from "./types.js";

interface SiteRow {
  slug: string;
  id: number;
  title: string;
  createdAt: number;
  tags: string;
  thumbnailPath: string;
  liveUrl: string | null;
  detailPath: string;
  awards: string;
  fetchedAt: number;
}

function rowToSite(r: SiteRow): SiteSummary {
  return {
    slug: r.slug,
    id: r.id,
    title: r.title,
    createdAt: r.createdAt,
    tags: JSON.parse(r.tags),
    thumbnailPath: r.thumbnailPath,
    liveUrl: r.liveUrl,
    detailPath: r.detailPath,
    awards: JSON.parse(r.awards),
  };
}

export class Cache {
  private db: DatabaseSync;
  private now: () => number;
  readonly imagesDir: string;

  constructor(rootDir: string, now: () => number = Date.now) {
    this.now = now;
    mkdirSyncCb(rootDir, { recursive: true });
    this.imagesDir = join(rootDir, "images");
    mkdirSyncCb(this.imagesDir, { recursive: true });
    this.db = new DatabaseSync(join(rootDir, "cache.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sites (
        slug TEXT PRIMARY KEY, id INTEGER, title TEXT, createdAt INTEGER,
        tags TEXT, thumbnailPath TEXT, liveUrl TEXT, detailPath TEXT,
        awards TEXT, fetchedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY, value TEXT, fetchedAt INTEGER
      );
    `);
  }

  upsertSites(sites: SiteSummary[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO sites (slug, id, title, createdAt, tags, thumbnailPath, liveUrl, detailPath, awards, fetchedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         id=excluded.id, title=excluded.title, createdAt=excluded.createdAt,
         tags=excluded.tags, thumbnailPath=excluded.thumbnailPath,
         liveUrl=excluded.liveUrl, detailPath=excluded.detailPath,
         awards=excluded.awards, fetchedAt=excluded.fetchedAt`,
    );
    const t = this.now();
    for (const s of sites) {
      stmt.run(
        s.slug, s.id, s.title, s.createdAt, JSON.stringify(s.tags),
        s.thumbnailPath, s.liveUrl, s.detailPath, JSON.stringify(s.awards), t,
      );
    }
  }

  getSites(maxAgeMs: number): SiteSummary[] {
    const min = this.now() - maxAgeMs;
    const rows = this.db.prepare(
      "SELECT * FROM sites WHERE fetchedAt > ? ORDER BY createdAt DESC",
    ).all(min) as unknown as SiteRow[];
    return rows.map(rowToSite);
  }

  getSite(slug: string): SiteSummary | null {
    const row = this.db.prepare("SELECT * FROM sites WHERE slug = ?").get(slug) as
      | SiteRow
      | undefined;
    return row ? rowToSite(row) : null;
  }

  setMeta(key: string, value: unknown): void {
    this.db.prepare(
      `INSERT INTO meta (key, value, fetchedAt) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, fetchedAt=excluded.fetchedAt`,
    ).run(key, JSON.stringify(value), this.now());
  }

  getMeta<T>(key: string, maxAgeMs: number): T | null {
    const row = this.db.prepare("SELECT value, fetchedAt FROM meta WHERE key = ?").get(key) as
      | { value: string; fetchedAt: number }
      | undefined;
    if (!row || row.fetchedAt <= this.now() - maxAgeMs) return null;
    return JSON.parse(row.value) as T;
  }

  // Disk cache keyed by the awwwards asset path (immutable content → no TTL).
  async getImage(assetPath: string, fetcher: () => Promise<Buffer>): Promise<Buffer> {
    const ext = assetPath.endsWith(".png") ? ".png" : ".jpg";
    const file = join(this.imagesDir, createHash("sha1").update(assetPath).digest("hex") + ext);
    try {
      return await readFile(file);
    } catch {
      const buf = await fetcher();
      await writeFile(file, buf);
      return buf;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (20 tests). `node:sqlite` prints an experimental warning on some Node versions — harmless.

- [ ] **Step 5: Commit**

```bash
git add src/cache.ts test/cache.test.ts && git commit -m "feat: sqlite + disk cache with TTLs for sites, meta and thumbnails"
```

---

### Task 8: Tool handlers (TDD)

**Files:**
- Create: `src/server.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `AwwwardsClient`, `SearchFilters` from Task 6; `Cache` from Task 7; `parseDetail`, `parseCategories`, `parseListing` from Tasks 3–5.
- Produces:
  - `type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }`
  - `interface Handlers { search_sites(args: SearchArgs): Promise<{ content: Block[]; isError?: boolean }>; get_site_details(args: { slug: string }): Promise<{ content: Block[]; isError?: boolean }>; list_categories(): Promise<{ content: Block[]; isError?: boolean }>; capture_live_site(args: { url: string }): Promise<{ content: Block[]; isError?: boolean }> }`
  - `createHandlers(deps: { client: AwwwardsClient; cache: Cache; captureFn?: CaptureFn }): Handlers` where `CaptureFn = (url: string, imagesDir: string) => Promise<{ file: string; base64: string } | { error: string }>`.
  - `slugifyTag(s: string): string` (exported for tests).
  - `SITE_TTL_MS = 7 * 24 * 60 * 60 * 1000`, `CATEGORY_TTL_MS = 30 * 24 * 60 * 60 * 1000`.

Semantics: `search_sites` builds the single-filter URL (priority color > award > technology > first tag, per Task 6), serves from cache when enough fresh sites already match ALL requested filters, otherwise fetches + parses + upserts, then filters client-side (remaining tags, technology if it wasn't the URL source, `query` substring over title/tags), slices by `page`/`count`, and returns one text block followed by one inline image block per site (880px thumbnails via `cache.getImage`). `get_site_details` uses meta key `detail:<slug>` (TTL 7d) or fetches `/sites/<slug>`. `list_categories` uses meta key `categories` (TTL 30d) or scrapes `/websites/`. All handler errors become `{ isError: true }` text blocks, never thrown.

- [ ] **Step 1: Write the failing test**

`test/server.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandlers, slugifyTag } from "../src/server.js";
import { AwwwardsClient } from "../src/awwwards.js";
import { Cache } from "../src/cache.js";
import type { SiteSummary } from "../src/types.js";

const FIXTURES = join(__dirname, "fixtures");
const listingHtml = readFileSync(join(FIXTURES, "listing.html"), "utf8");

const dirs: string[] = [];
const tmpDir = () => {
  const d = mkdtempSync(join(tmpdir(), "awwwards-srv-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function site(overrides: Partial<SiteSummary> = {}): SiteSummary {
  return {
    id: 1, slug: "s1", title: "Cool Studio", createdAt: 1789516800,
    tags: ["WebGL", "3D"], thumbnailPath: "submissions/2026/08/abc.jpg",
    liveUrl: "https://example.com", detailPath: "/sites/s1",
    awards: ["Site of the Day"], ...overrides,
  };
}

// Client whose fake fetch serves fixture pages; every call is recorded.
function fakeClient() {
  const fetchFn = vi.fn(async (input: any) => {
    const url = String(input);
    if (url.includes("/sites/l-i-s-a")) {
      return new Response(readFileSync(join(FIXTURES, "detail.html"), "utf8"), { status: 200 });
    }
    return new Response(listingHtml, { status: 200 });
  });
  const client = new AwwwardsClient({ fetchFn: fetchFn as unknown as typeof fetch });
  return { client, fetchFn };
}

describe("slugifyTag", () => {
  it("normalizes site tags to filter slugs", () => {
    expect(slugifyTag("Content architecture")).toBe("content-architecture");
    expect(slugifyTag("3D")).toBe("3d");
    expect(slugifyTag("WebGL")).toBe("webgl");
  });
});

describe("search_sites", () => {
  it("serves matching fresh cache without any network call", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites(Array.from({ length: 8 }, (_, i) => site({ slug: `s${i + 1}` })));
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ tags: ["webgl"], count: 6 });
    expect(fetchFn.mock.calls.length).toBe(0);
    const text = res.content[0] as any;
    expect(text.type).toBe("text");
    expect(text.text).toContain("s1");
    expect(text.text).toContain("https://example.com");
  });

  it("scrapes when the cache cannot satisfy the filters, then caches", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ technology: "webgl", count: 3 });
    expect(String(fetchFn.mock.calls[0][0])).toContain("/websites/webgl/");
    expect(res.content.filter((b: any) => b.type === "image").length).toBe(3);
    expect(cache.getSites(10_000).length).toBeGreaterThan(0);
  });

  it("applies the free-text query client-side", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([
      site(),
      site({ slug: "s2", title: "Boring Corp", tags: [] }),
    ]);
    const { client } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.search_sites({ query: "cool", count: 6 });
    expect((res.content[0] as any).text).toContain("s1");
    expect((res.content[0] as any).text).not.toContain("s2");
  });

  it("paginates with page and count", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites(Array.from({ length: 8 }, (_, i) => site({ slug: `s${i + 1}` })));
    const { client } = fakeClient();
    const h = createHandlers({ client, cache });
    const p1 = await h.search_sites({ count: 3, page: 1 });
    const p2 = await h.search_sites({ count: 3, page: 2 });
    expect((p1.content[0] as any).text).toContain("s1");
    expect((p2.content[0] as any).text).toContain("s4");
    expect(p1.content.filter((b: any) => b.type === "image").length).toBe(3);
  });

  it("falls back to stale cache when the live request fails", async () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site(), site({ slug: "s2" })]);
    const client = new AwwwardsClient({
      fetchFn: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    const h = createHandlers({ client, cache });
    // 2 fresh sites < count*page (12*2) → scrape attempt fails → stale cache served
    const res = await h.search_sites({ count: 12, page: 2 });
    const text = (res.content[0] as any).text;
    expect(text).toContain("stale");
    expect(text).toContain("s1");
    expect(res.isError).toBeUndefined();
  });
});

describe("get_site_details", () => {
  it("scrapes the detail page and returns palette + technologies", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.get_site_details({ slug: "l-i-s-a" });
    const text = (res.content[0] as any).text;
    expect(text).toContain("#"); // a palette hex
    expect(text).toContain("WebGL");
    expect(text).toContain("lisa.locomotive.ca");
  });
});

describe("list_categories", () => {
  it("returns colors and filters as JSON and caches for 30 days", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.list_categories();
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.colors.length).toBeGreaterThanOrEqual(20);
    expect(parsed.filters).toContain("3d");
    await h.list_categories(); // second call is served from the meta cache
    expect(fetchFn.mock.calls.length).toBe(1);
  });
});

describe("capture_live_site", () => {
  it("returns install instructions when the capture function reports failure", async () => {
    const cache = new Cache(tmpDir());
    const { client } = fakeClient();
    const h = createHandlers({
      client,
      cache,
      captureFn: async () => ({ error: "Playwright is not installed." }),
    });
    const res = await h.capture_live_site({ url: "https://example.com" });
    expect((res.content[0] as any).text).toContain("Playwright is not installed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `../src/server.js` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`src/server.ts`:

```ts
import { parseCategories, parseDetail, parseListing } from "./parsers.js";
import {
  AwwwardsClient,
  BlockedError,
  buildFilterUrl,
  thumbnailUrl,
} from "./awwwards.js";
import type { Cache } from "./cache.js";
import type { AwardFilter, SearchFilters } from "./awwwards.js";
import type { Categories, SiteDetails, SiteSummary } from "./types.js";

export const SITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CATEGORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type Block =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResponse {
  content: Block[];
  isError?: boolean;
}

export interface SearchArgs extends SearchFilters {
  count?: number;
  page?: number;
}

export type CaptureFn = (
  url: string,
  imagesDir: string,
) => Promise<{ file: string; base64: string } | { error: string }>;

export function slugifyTag(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function text(t: string): Block {
  return { type: "text", text: t };
}

function summarizeSite(s: SiteSummary): string {
  const award = s.awards.length ? ` [${s.awards.join(", ")}]` : "";
  return `- ${s.title} (slug: ${s.slug})${award}\n  live: ${s.liveUrl ?? "unknown"}\n  awwwards: https://www.awwwards.com${s.detailPath}\n  tags: ${s.tags.join(", ")}`;
}

function errorResponse(err: unknown): ToolResponse {
  const message =
    err instanceof BlockedError
      ? err.message
      : `awwwards-mcp request failed: ${err instanceof Error ? err.message : String(err)}`;
  return { content: [text(message)], isError: true };
}

export interface Handlers {
  search_sites(args: SearchArgs): Promise<ToolResponse>;
  get_site_details(args: { slug: string }): Promise<ToolResponse>;
  list_categories(): Promise<ToolResponse>;
  capture_live_site(args: { url: string }): Promise<ToolResponse>;
}

export function createHandlers(deps: {
  client: AwwwardsClient;
  cache: Cache;
  captureFn?: CaptureFn;
}): Handlers {
  const { client, cache } = deps;

  // Which filter wins the URL (combined filter URLs 404 on awwwards.com).
  const urlSource = (f: SearchArgs): "color" | "award" | "technology" | "tag" | "none" =>
    f.color ? "color" : f.award ? "award" : f.technology ? "technology" : f.tags?.length ? "tag" : "none";

  function matchesFilters(s: SiteSummary, f: SearchArgs): boolean {
    const source = urlSource(f);
    if (f.tags?.length) {
      const tagsToCheck = source === "tag" ? f.tags.slice(1) : f.tags;
      for (const t of tagsToCheck) {
        const slug = t.toLowerCase();
        if (!s.tags.some((st) => slugifyTag(st).includes(slug))) return false;
      }
    }
    if (f.technology && source !== "technology") {
      const slug = f.technology.toLowerCase();
      if (!s.tags.some((st) => slugifyTag(st).includes(slug))) return false;
    }
    if (f.query) {
      const q = f.query.toLowerCase();
      if (
        !s.title.toLowerCase().includes(q) &&
        !s.tags.some((st) => st.toLowerCase().includes(q))
      ) {
        return false;
      }
    }
    return true;
  }

  async function siteImage(s: SiteSummary): Promise<Block | null> {
    try {
      const buf = await cache.getImage(s.thumbnailPath, () =>
        client.getThumbnail(s.thumbnailPath, 880),
      );
      return { type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" };
    } catch {
      return null; // thumbnail failures degrade to metadata-only cards
    }
  }

  async function search_sites(args: SearchArgs): Promise<ToolResponse> {
    const count = Math.min(Math.max(args.count ?? 6, 1), 12);
    const page = Math.max(args.page ?? 1, 1);
    try {
      let sites = cache.getSites(SITE_TTL_MS).filter((s) => matchesFilters(s, args));
      if (sites.length < count * page) {
        const html = await client.getHtml(buildFilterUrl(args));
        const parsed = parseListing(html);
        if (parsed.length === 0) {
          return {
            content: [
              text(
                "Awwwards layout may have changed: parsed 0 site cards. " +
                  "The awwwards-mcp parser likely needs an update.",
              ),
            ],
            isError: true,
          };
        }
        cache.upsertSites(parsed);
        sites = cache.getSites(SITE_TTL_MS).filter((s) => matchesFilters(s, args));
      }

      const slice = sites.slice((page - 1) * count, page * count);
      if (slice.length === 0) {
        return {
          content: [
            text(
              "No sites matched the search on this page. Try fewer filters or run list_categories. " +
                "(Deep pagination is unavailable by design: awwwards.com's robots.txt disallows it.)",
            ),
          ],
        };
      }

      const images = await Promise.all(slice.map(siteImage));
      const content: Block[] = [
        text(
          `${sites.length} site(s) matched; showing ${(page - 1) * count + 1}-${(page - 1) * count + slice.length}:\n\n` +
            slice.map(summarizeSite).join("\n\n"),
        ),
        ...images.filter((b): b is Block => b !== null),
      ];
      return { content };
    } catch (err) {
      // Spec: on live-request failure, serve stale cache if present.
      const stale = cache.getSites(Infinity).filter((s) => matchesFilters(s, args));
      if (stale.length > 0) {
        const slice = stale.slice(0, count);
        const images = await Promise.all(slice.map(siteImage));
        return {
          content: [
            text(
              `The live awwwards.com request failed (${err instanceof Error ? err.message : String(err)}). ` +
                `Serving ${slice.length} result(s) from stale cache instead:\n\n` +
                slice.map(summarizeSite).join("\n\n"),
            ),
            ...images.filter((b): b is Block => b !== null),
          ],
        };
      }
      return errorResponse(err);
    }
  }

  async function get_site_details(args: { slug: string }): Promise<ToolResponse> {
    try {
      const metaKey = `detail:${args.slug}`;
      let d = cache.getMeta<SiteDetails>(metaKey, SITE_TTL_MS);
      if (!d) {
        d = parseDetail(await client.getHtml(`/sites/${args.slug}`), args.slug);
        cache.setMeta(metaKey, d);
      }
      const cachedSite = cache.getSite(args.slug);
      const liveUrl = d.liveUrl ?? cachedSite?.liveUrl ?? null;

      const content: Block[] = [
        text(
          [
            `# ${d.title ?? args.slug}`,
            liveUrl ? `Live site: ${liveUrl}` : null,
            d.awards.length
              ? `Awards: ${d.awards.map((a) => `${a.title} (${a.date})`).join(", ")}`
              : null,
            d.palette.length ? `Color palette: ${d.palette.join(", ")}` : null,
            d.technologies.length ? `Technologies & tools: ${d.technologies.join(", ")}` : null,
            d.elements.length ? `Design elements: ${d.elements.join(", ")}` : null,
            d.description ? `Description: ${d.description}` : null,
            d.ogImage ? `Full-size screenshot: ${d.ogImage}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      ];
      if (cachedSite) {
        const img = await siteImage(cachedSite);
        if (img) content.push(img);
      }
      return { content };
    } catch (err) {
      return errorResponse(err);
    }
  }

  async function list_categories(): Promise<ToolResponse> {
    try {
      let cats = cache.getMeta<Categories>("categories", CATEGORY_TTL_MS);
      if (!cats) {
        cats = parseCategories(await client.getHtml("/websites/"));
        cache.setMeta("categories", cats);
      }
      return {
        content: [
          text(
            JSON.stringify(
              {
                colorCount: cats.colors.length,
                colors: cats.colors,
                filterCount: cats.filters.length,
                filters: cats.filters,
                usage:
                  "Pass one of: color (hex), award (sotd|developer|honorable), technology or a tag slug to search_sites. Combine at most one URL filter with client-side tags.",
              },
              null,
              1,
            ),
          ),
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }

  async function capture_live_site(args: { url: string }): Promise<ToolResponse> {
    try {
      const capture = deps.captureFn ?? (await import("./capture.js")).captureLiveSite;
      const result = await capture(args.url, cache.imagesDir);
      if ("error" in result) return { content: [text(result.error)], isError: true };
      return {
        content: [
          text(`Full-page capture of ${args.url} saved to ${result.file}`),
          { type: "image", data: result.base64, mimeType: "image/png" },
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }

  return { search_sites, get_site_details, list_categories, capture_live_site };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (29 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts && git commit -m "feat: MCP tool handlers (search, details, categories, capture)"
```

---

### Task 9: Optional Playwright capture (TDD)

**Files:**
- Create: `src/capture.ts`
- Test: `test/capture.test.ts`

**Interfaces:**
- Consumes: nothing from the project.
- Produces: `captureLiveSite(url: string, imagesDir: string, loader?: () => Promise<any>): Promise<{ file: string; base64: string } | { error: string }>` and `CAPTURE_INSTALL_HINT: string` — the default `captureFn` used by Task 8's `capture_live_site`.

- [ ] **Step 1: Write the failing test**

`test/capture.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { captureLiveSite } from "../src/capture.js";

const dirs: string[] = [];
const tmpDir = () => {
  const d = mkdtempSync(join(tmpdir(), "awwwards-cap-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("captureLiveSite", () => {
  it("returns install instructions when playwright is missing", async () => {
    const res = await captureLiveSite("https://example.com", tmpDir(), async () => {
      throw new Error("Cannot find package 'playwright'");
    });
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toContain("npx playwright install chromium");
  });

  it("screenshots the page with a fake chromium", async () => {
    const dir = tmpDir();
    const fake = {
      launch: async () => ({
        newPage: async () => ({
          goto: async () => {},
          screenshot: async ({ path }: { path: string }) => {
            (await import("node:fs/promises")).writeFile(path, Buffer.from("png-bytes"));
          },
        }),
        close: async () => {},
      }),
    };
    const res = await captureLiveSite(
      "https://example.com",
      dir,
      async () => ({ chromium: fake }),
    );
    expect("file" in res).toBe(true);
    if ("file" in res) {
      expect(readFileSync(res.file).toString()).toBe("png-bytes");
      expect(res.base64).toBe(Buffer.from("png-bytes").toString("base64"));
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `../src/capture.js` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`src/capture.ts`:

```ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const CAPTURE_INSTALL_HINT =
  "Full-page capture needs Playwright, which is an optional dependency.\n" +
  "Install it with:  npm install -D playwright && npx playwright install chromium\n" +
  "Then retry capture_live_site.";

type CaptureResult = { file: string; base64: string } | { error: string };

export async function captureLiveSite(
  url: string,
  imagesDir: string,
  loader: () => Promise<any> = () => import("playwright"),
): Promise<CaptureResult> {
  let chromium: any;
  try {
    ({ chromium } = await loader());
  } catch {
    return { error: CAPTURE_INSTALL_HINT };
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    const file = join(
      imagesDir,
      "capture-" + createHash("sha1").update(url).digest("hex").slice(0, 12) + ".png",
    );
    await page.screenshot({ path: file, fullPage: true });
    return { file, base64: (await readFile(file)).toString("base64") };
  } finally {
    await browser.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (31 tests).

- [ ] **Step 5: Commit**

```bash
git add src/capture.ts test/capture.test.ts && git commit -m "feat: optional full-page live capture via playwright"
```

---

### Task 10: MCP server wiring (cli.ts) and inspector pass

**Files:**
- Create: `src/cli.ts`

**Interfaces:**
- Consumes: `createHandlers` (Task 8), `AwwwardsClient` (Task 6), `Cache` (Task 7), `captureLiveSite` (Task 9).
- Produces: the executable `bin` entry `dist/cli.js` registered in package.json. No exports — this is the process entry point.

- [ ] **Step 1: Write src/cli.ts**

```ts
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { AwwwardsClient } from "./awwwards.js";
import { Cache } from "./cache.js";
import { createHandlers } from "./server.js";
import { captureLiveSite } from "./capture.js";

const cacheRoot = process.env.AWWWARDS_CACHE_DIR ?? join(homedir(), ".awwwards-mcp");
const handlers = createHandlers({
  client: new AwwwardsClient(),
  cache: new Cache(cacheRoot),
  captureFn: captureLiveSite,
});

const server = new McpServer({ name: "awwwards-mcp", version: "1.0.0" });

server.tool(
  "search_sites",
  "Search award-winning websites on Awwwards. Returns site cards with inline screenshots, live URLs, awards and tags.",
  {
    query: z.string().describe("Free text matched against site titles and tags").optional(),
    color: z
      .string()
      .regex(/^#?[0-9A-Fa-f]{6}$/)
      .describe("Dominant color hex, e.g. '#404040'")
      .optional(),
    tags: z.array(z.string()).describe("Tag slugs, e.g. ['3d', 'portfolio']").optional(),
    technology: z.string().describe("Technology slug, e.g. 'webgl', 'gsap', 'astro'").optional(),
    award: z.enum(["sotd", "developer", "honorable"]).optional(),
    count: z.number().int().min(1).max(12).default(6),
    page: z.number().int().min(1).default(1),
  },
  (args) => handlers.search_sites(args),
);

server.tool(
  "get_site_details",
  "Get the design DNA of one Awwwards site: color palette, technologies, design elements, awards, description and inline screenshot.",
  { slug: z.string().describe("Site slug from search_sites, e.g. 'l-i-s-a'") },
  (args) => handlers.get_site_details(args),
);

server.tool(
  "list_categories",
  "List the filter taxonomy available on Awwwards: color hexes and tag/technology slugs usable with search_sites.",
  {},
  () => handlers.list_categories(),
);

server.tool(
  "capture_live_site",
  "Take a fresh full-page screenshot of a live website URL using a headless browser. Requires the optional playwright dependency.",
  { url: z.string().url().describe("Absolute URL of the site to capture") },
  (args) => handlers.capture_live_site(args),
);

await server.connect(new StdioServerTransport());
```

- [ ] **Step 2: Build and typecheck**

Run: `npm run build && npm run typecheck`
Expected: both succeed; `dist/cli.js` exists.

- [ ] **Step 3: Manual MCP Inspector pass**

Run: `npx @modelcontextprotocol/inspector node dist/cli.js`
Expected: inspector opens in a browser. Connect, then exercise all four tools:
- `list_categories` → JSON with ≥20 colors and ≥100 filters.
- `search_sites` with `{ "technology": "webgl", "count": 3 }` → text block with 3 site cards + 3 image blocks.
- `get_site_details` with `{ "slug": "l-i-s-a" }` → palette hexes, "Site of the Day", live URL, screenshot URL.
- `capture_live_site` with any URL → install-hint text (playwright not installed) — this is the correct behavior.

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts && git commit -m "feat: wire MCP stdio server with four tools"
```

---

### Task 11: Live smoke script, README, LICENSE, CI

**Files:**
- Create: `test/live-smoke.ts`, `README.md`, `LICENSE`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: everything built in Tasks 1–10.
- Produces: publishable package surface — README with client config snippets, MIT license, CI on Node 22/24, offline unit tests passing.

- [ ] **Step 1: Write the live smoke script**

`test/live-smoke.ts` (manual, network-dependent, never run in CI):

```ts
import { AwwwardsClient, RateLimiter } from "../src/awwwards.js";
import { parseListing, parseDetail } from "../src/parsers.js";

const client = new AwwwardsClient({ rateLimiter: new RateLimiter(1200) });

const listing = parseListing(await client.getHtml("/websites/"));
console.log("listing sites parsed:", listing.length);
if (listing.length < 10) throw new Error("parseListing returned too few sites");

const first = listing[0];
const details = parseDetail(await client.getHtml(first.detailPath), first.slug);
console.log("detail:", first.slug, "palette:", details.palette, "awards:", details.awards);
if (details.palette.length === 0) throw new Error("parseDetail returned no palette");

const thumb = await client.getThumbnail(first.thumbnailPath, 880);
console.log("thumbnail bytes:", thumb.length);
if (thumb.length < 10_000) throw new Error("thumbnail suspiciously small");

console.log("LIVE SMOKE OK");
```

- [ ] **Step 2: Run it once against the live site**

Run: `npm run smoke`
Expected: ends with `LIVE SMOKE OK` and sane numbers (~31 sites, non-empty palette). Note this hits awwwards.com 3 times, rate-limited to 1.2s apart.

- [ ] **Step 3: Write LICENSE (MIT) and README.md**

`LICENSE` — standard MIT text, `Copyright (c) 2026 Afjal`.

`README.md`:

````markdown
# awwwards-mcp

Free, open-source MCP server that gives AI agents design inspiration from
[Awwwards](https://www.awwwards.com/) — the Mobbin-style visual reference loop,
sourced from the web's best award-winning websites.

Your agent searches in natural language ("dark 3D portfolio sites", "soft pastel
e-commerce"), sees **real screenshots inline**, and can pull the **design DNA**
of any site: color palette, tech stack, design elements, award history.

## Tools

| Tool | What it does |
|------|--------------|
| `search_sites` | Search by color, tags, technology or award type. Returns site cards with inline screenshots. |
| `get_site_details` | Full design DNA for one site: palette, technologies, elements, awards, description. |
| `list_categories` | Every filter the agent can search by (200+ tags, 27 colors). |
| `capture_live_site` | Optional: fresh full-page screenshot of any live URL (needs [playwright](https://playwright.dev)). |

## Setup

**Claude Code**

```bash
claude mcp add awwwards -- npx -y awwwards-mcp
```

**Claude Desktop / Cursor / Windsurf** (`mcpServers` in the config):

```json
{
  "mcpServers": {
    "awwwards": { "command": "npx", "args": ["-y", "awwwards-mcp"] }
  }
}
```

Optional full-page captures:

```bash
npm install -g playwright && npx playwright install chromium
```

## How it works

- Live, polite scraping of awwwards.com public pages (max 1 request/second,
  robots.txt-compliant paths only, cached 7 days in SQLite at `~/.awwwards-mcp/`).
- Screenshots are served from Awwwards' own CDN (880×660), cached on disk.
- No API key, no account, no cost.

## Ethics & terms

This tool fetches publicly available pages for **personal design-inspiration
use**, at human-ish request rates, honoring robots.txt. Awwwards' screenshots
and content remain the property of Awwwards and the credited creators — don't
bulk-scrape, redistribute, or republish them. If you use this commercially,
review awwwards.com's terms yourself.

## Development

```bash
npm install
npm test        # offline unit tests against committed HTML fixtures
npm run smoke   # manual live smoke test against awwwards.com
npm run build   # compile to dist/
```

MIT — see [LICENSE](LICENSE).
````

- [ ] **Step 4: Write the CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [22, 24]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 5: Full verification pass**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green (31 tests). CI is offline — no test touches the network.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "docs: README, MIT license, live smoke script, CI"
```

---

## Post-plan notes for the implementer

- Every commit lands on `main` (solo project, no worktree needed — the repo was initialized fresh for this project).
- If awwwards.com markup changed since 2026-09-17 and fixture-based tests fail, the fixture capture (Task 2) must be re-run first and parser regexes adjusted to the new fixtures — the test expectations (slug `l-i-s-a`, `https://lisa.locomotive.ca/en`, award names) stay as-is only if the new fixture still supports them; otherwise re-derive expectations from the new fixture and note it in the commit message.
- npm publication (`npm publish`) is intentionally out of scope of this plan; the package is publish-ready after Task 11.
