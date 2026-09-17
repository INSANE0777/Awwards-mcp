# awwwards-inspiration Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `awwwards-inspiration` skill with the awwwards-mcp npm package that teaches agents the inspiration workflow, tool reference, and index/capture ops.

**Architecture:** Single `SKILL.md` at `skills/awwwards-inspiration/` (spec: approach A), packaged via the `files` array, discoverable in the README. No source code changes — the skill documents the existing five tools.

**Tech Stack:** Markdown (SKILL.md), npm packaging, a one-off Node script using `@modelcontextprotocol/sdk` for the live smoke test.

## Global Constraints

- Skill is one file: `skills/awwwards-inspiration/SKILL.md` (~200 lines max).
- Frontmatter `name:` must be `awwwards-inspiration`; `description:` must cover all three triggers (site builds, standalone research, index/capture ops).
- Every tool name, parameter name, and parameter constraint in the reference must match `src/cli.ts` registrations exactly (see facts below).
- Spec: `docs/superpowers/specs/2026-09-17-awwwards-inspiration-skill-design.md`.
- Verified facts from the codebase (do not re-derive): tools are `search_sites`, `get_site_details`, `get_site_elements`, `list_categories`, `capture_live_site`; `search_sites` accepts `query` (string, free text vs titles/tags), `color` (`#?[0-9A-Fa-f]{6}`), `tags` (string array of slugs), `technology` (slug), `award` (`sotd|developer|honorable`), `count` (int 1–12, default 6), `page` (int ≥1, default 1); the other tools take `slug` (`get_site_details`, `get_site_elements`) or `url` (`capture_live_site`); `list_categories` takes nothing; up to 8 element posters are returned inline; color searches always scrape live (never served from cache); only one URL filter is applied with priority color > award > technology > first tag; deep pagination is unavailable (robots.txt); index cache lives at `~/.awwwards-mcp/`; `package.json` currently has `"files": ["dist", "README.md"]` and version `1.2.0`.

---

### Task 1: Write the skill file

**Files:**
- Create: `skills/awwwards-inspiration/SKILL.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: `skills/awwwards-inspiration/SKILL.md` — Task 2 packages it, Task 3 smoke-tests the workflow it describes.

- [ ] **Step 1: Create the skill file with exactly this content**

````markdown
---
name: awwwards-inspiration
description: Use when building a site that needs design references (e.g. "make it feel premium", "dark 3D portfolio vibes"), when the user asks for standalone inspiration research ("show me award-winning e-commerce sites", "what's trending in brutalism"), or when setting up or maintaining the awwwards-mcp local index or live-capture tooling (awwwards-index, capture_live_site).
---

# Awwwards Inspiration

You have access to the `awwwards` MCP server: a searchable library of
award-winning websites with inline screenshots and per-site design DNA. Use
it to ground design decisions in real, proven references instead of guessing.

## When to use this skill

1. **During site builds** — before writing any UI code, gather references and
   state a design direction.
2. **Standalone research** — the user wants inspiration, trends, or examples
   ("show me dark 3D portfolio sites").
3. **Index & capture ops** — building the local search index, or taking fresh
   screenshots of live URLs.

## The inspiration loop

Run this loop before building anything visual:

1. **Restate the goal as concrete attributes.** Turn the user's request into
   mood, color, technology, and industry terms. "Make it feel premium" becomes
   e.g. "dark, elegant, WebGL, agency portfolio".
2. **Ground your vocabulary.** If unsure which filters exist, call
   `list_categories` first — it returns every color hex and tag/technology
   slug you can search by.
3. **Search.** Call `search_sites` with 1–3 filters (e.g.
   `{ color: "#404040", tags: ["3d", "portfolio"] }`). Judge the results from
   the inline screenshots, not just titles. Shortlist 2–3 candidates.
4. **Get the design DNA.** Call `get_site_details` on the top pick for its
   palette, technologies, design elements, awards, and description.
5. **Get component-level visuals (when building).** Call `get_site_elements`
   on shortlisted sites to see individual design elements — 3D models, video
   content, mobile layouts, microcopy — with poster images inline and video
   URLs.
6. **State the design direction before writing code.** In prose: palette
   (hexes from the references), type mood, layout patterns, and tech choices,
   each traceable to a reference. Then build.

### Anti-patterns

- **Vague single-word searches** ("modern", "nice") — use concrete color/tag/
  technology/award filters instead.
- **Skipping to code** without stating a direction — the references are
  worthless if nothing is derived from them.
- **Dumping raw tool output at the user** — curate: show the shortlist, the
  chosen direction, and why.

## Tool reference

| Tool | Key params | Returns | Gotchas |
|------|-----------|---------|---------|
| `search_sites` | `query` (free text vs titles/tags), `color` (hex like `#404040`), `tags` (array of slugs), `technology` (slug), `award` (`sotd`\|`developer`\|`honorable`), `count` (1–12, default 6), `page` (default 1) | Text list of site cards (title, slug, live URL, awards, tags) + inline JPEG screenshots | Awwwards applies only one URL filter — priority color > award > technology > first tag; the rest are checked client-side. Color searches always scrape live (never cached). Deep pagination is unavailable by design (robots.txt). On live-request failure, stale cache is served when present. |
| `get_site_details` | `slug` (from `search_sites`, e.g. `l-i-s-a`) | Title, live URL, awards, color palette, technologies, design elements, description, full-size screenshot URL; inline screenshot when available | Cached 7 days; a parse that comes back all-empty is an error, not a quiet empty result. |
| `get_site_elements` | `slug` | Numbered element list (image or video, with video URLs) + up to 8 inline poster JPEGs | Videos are mp4 URLs (posters only are shown inline). Elements feed from the same fetch as `get_site_details`. |
| `list_categories` | none | JSON: every color hex and filter/tag slug, plus usage guidance | Cached 30 days. Call this whenever filter vocabulary is uncertain. |
| `capture_live_site` | `url` (absolute URL) | Full-page PNG saved to disk + inline image | Requires the optional playwright dependency (`npm install -g playwright && npx playwright install chromium`). |

All image results arrive as MCP image content blocks — look at them, don't
just read the text blocks.

## Index & capture ops

**Local index.** `search_sites` works out of the box but unindexed depth is
limited by polite live scraping (~31 sites per filter page). Build the index
once for searches across thousands of sites:

```bash
npx -y -p awwwards-mcp awwwards-index      # from the published package
npm run index                              # from a repo checkout
```

- Crawls all ~200 tag pages at 1 request/second (~4 minutes) into a SQLite
  cache at `~/.awwwards-mcp/`.
- Resumable: interrupt and re-run; completed pages are skipped.
- The MCP server re-indexes automatically in the background whenever the
  index is stale — you rarely need to run this by hand.

**Live captures.** `capture_live_site` needs playwright installed once (see
table above). Use it when the user wants a screenshot of a URL that is not an
Awwwards site, or a fresher view than the cached thumbnails.
````

- [ ] **Step 2: Verify frontmatter and tool-name accuracy**

Run:

```bash
cd "A:\AWWARDS MCP" && node -e "const s=require('fs').readFileSync('skills/awwwards-inspiration/SKILL.md','utf8'); if(!s.startsWith('---')) throw new Error('no frontmatter'); const m=s.match(/^---\n([\s\S]*?)\n---/); if(!m) throw new Error('bad frontmatter'); if(!/^name: awwwards-inspiration$/m.test(m[1])) throw new Error('bad name'); if(!/^description: Use when building a site/m.test(m[1])) throw new Error('bad description'); console.log('frontmatter OK'); const tools=['search_sites','get_site_details','get_site_elements','list_categories','capture_live_site']; const missing=tools.filter(t=>!s.includes(t)); if(missing.length) throw new Error('missing: '+missing); console.log('tool names OK')"
```

Expected: `frontmatter OK` then `tool names OK`.

- [ ] **Step 3: Verify parameter accuracy against the registration source**

Run:

```bash
cd "A:\AWWARDS MCP" && grep -c "query\|color\|tags\|technology\|award\|count\|page" skills/awwwards-inspiration/SKILL.md && grep -n "z.enum(\[\"sotd\"" src/cli.ts && grep -n "max(12)" src/server.ts
```

Expected: a count ≥ 1, and both greps hit. Manually confirm the SKILL.md table's `search_sites` row matches the `z.` definitions in `src/cli.ts` (params, enum values, count 1–12 default 6, page default 1).

- [ ] **Step 4: Commit**

```bash
cd "A:\AWWARDS MCP" && git add skills/awwwards-inspiration/SKILL.md && git commit -m "feat: awwwards-inspiration skill teaching the reference loop"
```

---

### Task 2: Package the skill

**Files:**
- Modify: `package.json` (line 8: `"files"` array; line ~4: `"version"`)
- Modify: `README.md` (add a "Skills" section after the Setup section)

**Interfaces:**
- Consumes: `skills/awwwards-inspiration/SKILL.md` from Task 1.
- Produces: npm package ships the skill; README documents installation.

- [ ] **Step 1: Update package.json**

Change the version to `1.3.0` and add the skill to `files`:

```json
  "version": "1.3.0",
  "files": ["dist", "README.md", "skills"],
```

(Keep all other fields exactly as they are.)

- [ ] **Step 2: Add a Skills section to README.md**

Insert this section after the Setup section (before "Indexing (recommended)"):

````markdown
## Skills

This package ships an agent skill that teaches the inspiration workflow —
search, judge from screenshots, pull design DNA, state a design direction —
using the awwwards MCP tools. Copy it into your agent's skills directory:

```bash
npx -y -p awwwards-mcp sh -c 'mkdir -p ~/.claude/skills && cp -r $(npm root -p)/awwwards-mcp/skills/awwwards-inspiration ~/.claude/skills/'
```

For ZCode, copy to `~/.zcode/skills/` instead of `~/.claude/skills/`.
````

- [ ] **Step 3: Verify the package contents**

Run:

```bash
cd "A:\AWWARDS MCP" && npm pack --dry-run 2>&1 | grep skills
```

Expected: `skills/awwwards-inspiration/SKILL.md` listed in the tarball contents.

- [ ] **Step 4: Commit**

```bash
cd "A:\AWWARDS MCP" && git add package.json README.md && git commit -m "feat: ship awwwards-inspiration skill in package, 1.3.0"
```

---

### Task 3: Live smoke test of the documented loop

**Files:**
- Create (temporary, not committed): `.tmp-smoke.mjs` in the repo root

**Interfaces:**
- Consumes: the built server (`dist/cli.js`), the workflow steps from Task 1's SKILL.md.
- Produces: evidence that the loop the skill teaches (search → details) works end-to-end.

- [ ] **Step 1: Write the smoke script**

`.tmp-smoke.mjs`:

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["dist/cli.js"] });
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name).sort();
console.log("TOOLS:", names.join(","));

const res = await client.callTool({ name: "search_sites", arguments: { tags: ["portfolio"], count: 2 } });
const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
console.log("SEARCH:", text.slice(0, 400));
const images = res.content.filter((b) => b.type === "image");
console.log("SEARCH_IMAGES:", images.length);

const slug = text.match(/slug: ([\w-]+)/)?.[1];
if (!slug) throw new Error("no slug found in search output");
const det = await client.callTool({ name: "get_site_details", arguments: { slug } });
const detText = det.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
console.log("DETAILS:", detText.slice(0, 400));

await client.close();
console.log("SMOKE OK");
```

- [ ] **Step 2: Run it**

Run:

```bash
cd "A:\AWWARDS MCP" && node .tmp-smoke.mjs
```

Expected output:
- `TOOLS:` lists all five names: `capture_live_site,get_site_details,get_site_elements,list_categories,search_sites`
- `SEARCH:` shows matched site cards with slugs; `SEARCH_IMAGES:` is ≥ 1 (if a thumbnail failed to fetch it may be 0 — acceptable only if the text cards are present; rerun once before treating 0 as a failure)
- `DETAILS:` shows a details block (palette/technologies/awards lines as available)
- `SMOKE OK`

If the live request fails entirely (network/blocked), the script throws — report the failure instead of papering over it; retry once before investigating.

- [ ] **Step 3: Delete the temp script (do not commit it)**

```bash
cd "A:\AWWARDS MCP" && rm .tmp-smoke.mjs && git status --porcelain
```

Expected: no untracked `.tmp-smoke.mjs`; working tree clean (Task 1 and 2 already committed).

- [ ] **Step 4: No commit (verification-only task)**
