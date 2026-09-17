# Element Visuals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `get_site_elements({ slug })` MCP tool returning each design element of an award site with its **poster image inline** (and video URL for video elements), giving agents component-level visual inspiration.

**Architecture:** New parser (`parseElements`, section-bounded, null-vs-empty distinction), CDN URL helpers + asset fetcher in the client, a new handler that shares one detail-page fetch with `get_site_details` (both 7-day meta caches populated from a single fetch), tool registration in cli.ts, README row. Spec: `docs/superpowers/specs/2026-09-17-awwwards-mcp-element-visuals-design.md`.

**Tech Stack:** Existing stack only — TypeScript 5 strict ESM, node:sqlite, vitest. No new dependencies.

## Global Constraints

- Suite baseline: **53/53**; target after this plan: **62/62** (3 parsers + 2 client + 4 handler tests). Offline only; the one live stdio probe (Task 3) is manual.
- Meta keys: `elements:<slug>` (JSON `ElementMedia[]`, TTL `SITE_TTL_MS` = 7 days), `detail:<slug>` (existing). One page fetch must populate BOTH when either handler fetches.
- Cache semantics: no-Elements-section → cache `[]` (legitimate empty, repeat calls don't re-fetch); section-present-but-zero-blobs → `isError` parser-mismatch response and **do not cache**; never cache an all-empty `parseDetail` result (existing guard).
- Poster derivation (live-verified): `element/…/<hash>.mp4` → same path with `.mp4` replaced by `_static.jpeg`; `.jpg` paths unchanged. Poster URLs are `https://assets.awwwards.com/awards/<mediaPath>`; CDN fetches are NOT rate-limited.
- Posters go through `cache.getImage(posterPath, () => client.getAsset(posterPath))` (disk cache keyed by asset path — no collision with thumbnail paths); a failed poster degrades to a text-only listing (no image block), never an error.
- Response cap: list ALL elements in the text block but inline at most **8** poster image blocks.
- Never-throw contract: handler failures → `{ content: [text], isError: true }`, same as existing handlers.
- `src/types.ts` gains `ElementMedia { title: string; mediaPath: string }`.
- Suite/verify commands: `npm test`, `npm run typecheck`, `npm run build`. Repo on `main`; clean tree after every commit. Local `grep` is ugrep and mis-handles `<>` — verify content with Node.
- Version bump 1.1.0 → 1.2.0 lands in Task 3.

---

### Task 1: Data layer — ElementMedia type, parseElements, URL helpers, getAsset

**Files:**
- Modify: `src/types.ts` (append interface)
- Modify: `src/parsers.ts` (append parseElements)
- Modify: `src/awwwards.ts` (append helpers + client method)
- Modify: `test/parsers.test.ts` (append describe block)
- Modify: `test/awwwards.test.ts` (append describe block)

**Interfaces:**
- Consumes: existing `decodeEntities` in parsers.ts; `ASSETS_URL`, `USER_AGENT`, `AwwwardsClient.fetchFn` in awwards.ts; existing `readFixture` helper in test/parsers.test.ts (fixture `detail.html` has exactly 6 element blobs — 4 mp4, 2 jpg, first is "Virtual assistant").
- Produces (exact, later tasks import these): `ElementMedia` from `src/types.js`; `parseElements(html: string): ElementMedia[] | null` from `src/parsers.js` (null = no Elements section; [] = section present, zero blobs parsed); `elementUrl(mediaPath: string): string`, `elementPosterPath(mediaPath: string): string`, `AwwwardsClient.getAsset(assetPath: string): Promise<Buffer>` from `src/awwwards.js`.

- [ ] **Step 1: Write failing parser tests (append to test/parsers.test.ts; add `parseElements` to the existing import from `../src/parsers.js`)**

```ts
describe("parseElements", () => {
  it("parses the 6 element blobs from the detail fixture", () => {
    const els = parseElements(detail())!;
    expect(els.length).toBe(6);
    expect(els[0]).toEqual({
      title: "Virtual assistant",
      mediaPath: "element/2026/08/6a723caaa57bb151055998.mp4",
    });
    expect(els.map((e) => e.title)).toContain("3D model");
    expect(els.map((e) => e.title)).toContain("Microcopy");
    expect(els.filter((e) => e.mediaPath.endsWith(".mp4")).length).toBe(4);
    expect(els.filter((e) => e.mediaPath.endsWith(".jpg")).length).toBe(2);
  });

  it("returns null when the page has no Elements section", () => {
    expect(parseElements("<html><body>nothing here</body></html>")).toBeNull();
  });

  it("returns an empty array when the section exists but no blobs parse", () => {
    const html = "<h2>Elements</h2><p>broken markup</p><h2>Color Palette</h2>";
    expect(parseElements(html)).toEqual([]);
  });
});
```

(`detail()` is the existing fixture helper in this file. Note `<h2>Elements</h2>` matches because the parser bounds on the literal `>Elements</h2>`.)

- [ ] **Step 2: Write failing client tests (append to test/awwwards.test.ts; add `elementPosterPath`, `elementUrl` to the existing import from `../src/awwwards.js`)**

```ts
describe("elementUrl / elementPosterPath", () => {
  it("builds CDN urls for element media", () => {
    expect(elementUrl("element/2026/08/x.mp4")).toBe(
      "https://assets.awwwards.com/awards/element/2026/08/x.mp4",
    );
  });

  it("derives video posters and passes images through unchanged", () => {
    expect(elementPosterPath("element/2026/08/x.mp4")).toBe("element/2026/08/x_static.jpeg");
    expect(elementPosterPath("element/2026/08/y.jpg")).toBe("element/2026/08/y.jpg");
  });
});
```

- [ ] **Step 3: Run to verify both fail**

Run: `npx vitest run test/parsers.test.ts test/awwwards.test.ts`
Expected: FAIL — `parseElements` / `elementUrl` not exported.

- [ ] **Step 4: Implement**

Append to `src/types.ts`:

```ts
export interface ElementMedia {
  title: string;
  mediaPath: string; // e.g. "element/2026/08/<hash>.mp4" or ".jpg"
}
```

Append to `src/parsers.ts` (add `ElementMedia` to the existing type import from `./types.js`):

```ts
// Elements section highlights: null means the page has no Elements section
// (a legitimate empty); an empty array means the section exists but no blobs
// parsed — the markup changed and the parser needs updating.
export function parseElements(html: string): ElementMedia[] | null {
  const start = html.indexOf(">Elements</h2>");
  if (start < 0) return null;
  const end = html.indexOf(">Color Palette</h2>", start);
  const section = end > start ? html.slice(start, end) : html.slice(start);
  const elements: ElementMedia[] = [];
  const parts = section.split('data-collectable-model-value="');
  for (const part of parts.slice(1)) {
    const stop = part.indexOf('">');
    if (stop < 0) continue;
    let blob: any;
    try {
      blob = JSON.parse(decodeEntities(part.slice(0, stop)));
    } catch {
      continue;
    }
    const mediaPath = blob?.collectableImage;
    // Only element media (videos/posters live under element/); other blobs
    // (site card, collections) must not leak in if the end bound is missing.
    if (typeof mediaPath === "string" && mediaPath.startsWith("element/")) {
      elements.push({
        title: decodeEntities(String(blob.collectableTitle ?? "")),
        mediaPath,
      });
    }
  }
  return elements;
}
```

Append to `src/awwwards.ts` (after `thumbnailUrl`):

```ts
export function elementUrl(mediaPath: string): string {
  return `${ASSETS_URL}/awards/${mediaPath}`;
}

// Video elements ship a poster at the same path with .mp4 → _static.jpeg
// (live-verified on the CDN); image elements are used as-is.
export function elementPosterPath(mediaPath: string): string {
  return mediaPath.endsWith(".mp4")
    ? mediaPath.replace(/\.mp4$/, "_static.jpeg")
    : mediaPath;
}
```

Add inside the `AwwwardsClient` class (after `getThumbnail`):

```ts
  // Asset fetch from the CDN (element posters etc.) — not rate-limited.
  async getAsset(assetPath: string): Promise<Buffer> {
    const res = await this.fetchFn(elementUrl(assetPath), {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching asset ${assetPath}`);
    return Buffer.from(await res.arrayBuffer());
  }
```

- [ ] **Step 5: Run to verify green, then full suite**

Run: `npx vitest run test/parsers.test.ts test/awwwards.test.ts && npm test`
Expected: 58/58 (53 + 5 new). If the fixture counts differ (awwwards markup changed), report actuals — do not weaken assertions silently.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/parsers.ts src/awwwards.ts test/parsers.test.ts test/awwwards.test.ts
git commit -m "feat: element media parsing and CDN poster helpers"
```

---

### Task 2: get_site_elements handler + shared detail fetch

**Files:**
- Modify: `src/server.ts`
- Modify: `test/server.test.ts` (append describe block; extend the `Handlers` usage)

**Interfaces:**
- Consumes: `parseElements`, `parseDetail` from `src/parsers.js`; `elementUrl`, `elementPosterPath`, `AwwwardsClient.getAsset` from `src/awwwards.js`; `ElementMedia` from `src/types.js`; existing `cache.getMeta/setMeta`, `cache.getSite(slug, SITE_TTL_MS)`, `cache.getImage`, `SITE_TTL_MS`, `Block`, `ToolResponse`, `text`, existing test helpers `tmpDir`, `fakeClient`, `site`.
- Produces: `get_site_elements(args: { slug: string }): Promise<ToolResponse>` added to the `Handlers` interface and the object returned by `createHandlers`; `get_site_details` gains the cross-cache insertion (one fetch feeds both `detail:<slug>` and `elements:<slug>`).

- [ ] **Step 1: Write failing tests (append to test/server.test.ts; add `parseElements` NOT needed here — handler-only tests)**

```ts
describe("get_site_elements", () => {
  it("returns posters inline with video urls; caches after one page fetch", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    const res = await h.get_site_elements({ slug: "l-i-s-a" });
    const body = (res.content[0] as any).text;
    expect(body).toContain("3D model");
    expect(body).toContain("(video)");
    expect(body).toContain("https://assets.awwwards.com/awards/element/");
    expect(res.content.filter((b: any) => b.type === "image").length).toBe(6);
    const res2 = await h.get_site_elements({ slug: "l-i-s-a" });
    expect(res2.content.filter((b: any) => b.type === "image").length).toBe(6);
    const pageCalls = fetchFn.mock.calls.filter(
      (c: any[]) => String(c[0]).includes("/sites/l-i-s-a"),
    );
    expect(pageCalls.length).toBe(1); // second call served from meta cache
  });

  it("shares one page fetch with get_site_details", async () => {
    const cache = new Cache(tmpDir());
    const { client, fetchFn } = fakeClient();
    const h = createHandlers({ client, cache });
    await h.get_site_details({ slug: "l-i-s-a" });
    await h.get_site_elements({ slug: "l-i-s-a" });
    const pageCalls = fetchFn.mock.calls.filter(
      (c: any[]) => String(c[0]).includes("/sites/l-i-s-a"),
    );
    expect(pageCalls.length).toBe(1);
  });

  it("reports a legitimate empty (and caches it) when there is no Elements section", async () => {
    const cache = new Cache(tmpDir());
    const client = new AwwwardsClient({
      fetchFn: (async () =>
        new Response("<html><body>no sections</body></html>", { status: 200 })) as unknown as typeof fetch,
    });
    const h = createHandlers({ client, cache });
    const res = await h.get_site_elements({ slug: "plain-site" });
    expect((res.content[0] as any).text).toContain("No design elements listed");
    expect(res.isError).toBeUndefined();
    expect(
      cache.getMeta<any[]>("elements:plain-site", 7 * 24 * 60 * 60 * 1000),
    ).toEqual([]);
  });

  it("errors without caching on a section-with-zero-blobs mismatch", async () => {
    const cache = new Cache(tmpDir());
    const client = new AwwwardsClient({
      fetchFn: (async () =>
        new Response(
          "<h2>Elements</h2><p>broken</p><h2>Color Palette</h2>",
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    const h = createHandlers({ client, cache });
    const res = await h.get_site_elements({ slug: "weird" });
    expect(res.isError).toBe(true);
    expect(cache.getMeta("elements:weird", Number.POSITIVE_INFINITY)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL — `h.get_site_elements is not a function`.

- [ ] **Step 3: Implement in src/server.ts**

3a. Extend imports: add `parseElements` to the parsers import; add `elementPosterPath`, `elementUrl` to the awwards import; add `ElementMedia` to the types import.

3b. Add to the `Handlers` interface:

```ts
  get_site_elements(args: { slug: string }): Promise<ToolResponse>;
```

3c. In `get_site_details`, in the fresh-fetch branch, immediately AFTER the existing `cache.setMeta(metaKey, d);` line (inside the `if (!d) { ... }` block, so `html` is in scope), insert:

```ts
      // One fetch feeds both caches: seed the elements cache from the same
      // HTML. Null (no section) caches as a legitimate empty; a zero-blob
      // parse is left uncached for get_site_elements to surface as a mismatch.
      if (cache.getMeta<ElementMedia[]>(`elements:${args.slug}`, SITE_TTL_MS) === null) {
        const els = parseElements(html);
        if (els === null) cache.setMeta(`elements:${args.slug}`, []);
        else if (els.length > 0) cache.setMeta(`elements:${args.slug}`, els);
      }
```

3d. Add the handler function (inside `createHandlers`, next to the others) and include it in the returned object:

```ts
  async function get_site_elements(args: { slug: string }): Promise<ToolResponse> {
    try {
      const elementsKey = `elements:${args.slug}`;
      let elements = cache.getMeta<ElementMedia[]>(elementsKey, SITE_TTL_MS);
      if (!elements) {
        const html = await client.getHtml(`/sites/${args.slug}`);
        const parsed = parseElements(html);
        if (parsed === null) {
          elements = [];
          cache.setMeta(elementsKey, elements);
        } else if (parsed.length === 0) {
          return {
            content: [
              text(
                "Awwwards layout may have changed: found an Elements section but parsed 0 elements. " +
                  "The awwwards-mcp parser likely needs an update.",
              ),
            ],
            isError: true,
          };
        } else {
          elements = parsed;
          cache.setMeta(elementsKey, elements);
        }
        // One fetch feeds both caches: seed the detail cache from the same
        // HTML unless it is an all-empty parse (never cached, per contract).
        if (cache.getMeta<SiteDetails>(`detail:${args.slug}`, SITE_TTL_MS) === null) {
          const d = parseDetail(html, args.slug);
          const empty =
            d.palette.length === 0 && d.technologies.length === 0 &&
            d.elements.length === 0 && d.awards.length === 0 && !d.description;
          if (!empty) cache.setMeta(`detail:${args.slug}`, d);
        }
      }
      const cachedSite = cache.getSite(args.slug, SITE_TTL_MS);
      const title =
        cache.getMeta<SiteDetails>(`detail:${args.slug}`, SITE_TTL_MS)?.title ??
        cachedSite?.title ??
        args.slug;
      if (elements.length === 0) {
        return { content: [text(`No design elements listed for ${title} (${args.slug}).`)] };
      }
      const shown = elements.slice(0, 8);
      const lines = shown.map((el, i) => {
        const isVideo = el.mediaPath.endsWith(".mp4");
        return `${i + 1}. ${el.title} (${isVideo ? "video" : "image"})` +
          (isVideo ? ` — ${elementUrl(el.mediaPath)}` : "");
      });
      const posters = await Promise.all(
        shown.map(async (el): Promise<Block | null> => {
          try {
            const poster = elementPosterPath(el.mediaPath);
            const buf = await cache.getImage(poster, () => client.getAsset(poster));
            return { type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" };
          } catch {
            return null; // poster failures degrade to text-only listings
          }
        }),
      );
      return {
        content: [
          text(`${title}: ${elements.length} design element(s):\n\n${lines.join("\n")}`),
          ...posters.filter((b): b is Block => b !== null),
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
```

Return object becomes `{ search_sites, get_site_details, get_site_elements, list_categories, capture_live_site }`.

- [ ] **Step 4: Run to verify green, then full suite**

Run: `npx vitest run test/server.test.ts && npm test`
Expected: 62/62 (58 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: get_site_elements handler with inline posters and shared detail fetch"
```

---

### Task 3: Tool registration, README, version bump, live verification

**Files:**
- Modify: `src/cli.ts`, `README.md`, `package.json`

**Interfaces:**
- Consumes: `handlers.get_site_elements` (Task 2). Registration mirrors the existing `get_site_details` block exactly (same slug zod schema `/^[\w-]+$/`, same result adapter/cast the neighboring registrations use).
- Produces: published tool surface (5 tools) + docs; version 1.2.0.

- [ ] **Step 1: Register the tool in src/cli.ts** — add immediately after the `get_site_details` registration, mirroring its shape (including whatever adapter the existing callbacks use, e.g. `asMcpResult(...)`):

```ts
server.tool(
  "get_site_elements",
  "Get the design-element highlights of one Awwwards site: component-level visuals (3D models, video content, mobile layouts, microcopy) with poster images inline and video URLs.",
  { slug: z.string().regex(/^[\w-]+$/).describe("Site slug from search_sites, e.g. 'l-i-s-a'") },
  (args) => asMcpResult(handlers.get_site_elements(args)),
);
```

(If the neighboring registrations do NOT use an `asMcpResult` wrapper, match whatever they do — the goal is a registration identical in shape to `get_site_details`.)

- [ ] **Step 2: README + version** — in the Tools table, add after the `get_site_details` row:

```markdown
| `get_site_elements` | Component-level visuals for one site: each element's poster image inline (3D models, video content, mobile layouts, microcopy…) + video URLs. |
```

In `package.json`, bump `"version"` from `"1.1.0"` to `"1.2.0"`.

- [ ] **Step 3: Build, suite, and the live stdio probe**

Run: `npm run typecheck && npm test && npm run build`
Expected: 62/62, clean build.

Live probe (manual; uses the real site + CDN once):

```bash
IDX=$(mktemp -d)
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_site_elements","arguments":{"slug":"l-i-s-a"}}}' \
  | AWWWARDS_CACHE_DIR="$IDX" node dist/cli.js 2>/dev/null > /tmp/ev-probe.json; wc -c /tmp/ev-probe.json
node --input-type=module -e "
const raw = await import('node:fs').then(fs => fs.readFileSync('/tmp/ev-probe.json', 'utf8'));
const lines = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } });
const res = lines.find(l => l?.id === 2)?.result;
const blocks = res?.content ?? [];
console.log('isError:', res?.isError ?? false);
console.log('text block first 200 chars:', (blocks.find(b => b.type === 'text')?.text ?? '').slice(0, 200));
console.log('image blocks:', blocks.filter(b => b.type === 'image').length);
"
```

Expected: `isError: false`; text starts `L.I.S.A.: 6 design element(s):`; **6 image blocks** (real posters fetched from the CDN). If awwwards blocks the detail fetch, wait 60s and retry once; blocked twice → report BLOCKED.

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts README.md package.json
git commit -m "feat: register get_site_elements tool; docs and 1.2.0"
```

---

## Post-plan notes for the implementer

- Fixture ground truth (verified 2026-09-17): detail.html has exactly 6 element blobs in order — Virtual assistant (.mp4), 3D model (.mp4), Video content (.mp4), Mobile layout (.jpg), Conversational interface (.mp4), Microcopy (.jpg).
- The fake client in server tests serves the detail fixture for ALL URLs — poster fetches return fixture bytes; that's intended (block counts are what's asserted).
- Task 2's `get_site_details` insertion must come after the all-empty guard and the `cache.setMeta(metaKey, d)` — i.e., only on the successful-fresh-parse path.
