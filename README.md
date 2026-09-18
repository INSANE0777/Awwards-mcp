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
| `get_site_elements` | Component-level visuals for one site: each element's poster image inline (3D models, video content, mobile layouts, microcopy…) + video URLs. |
| `list_categories` | Every filter the agent can search by (200+ tags, 27 colors). |
| `capture_live_site` | Optional: fresh full-page screenshot of any live URL. Waits for `load` + a settle window with a bounded pre-scroll, so heavy sites work (`waitStrategy: "networkidle"` available). (needs [playwright](https://playwright.dev)). |
| `analyze_page_structure` | Section band map of any page (live URL or local file:// build): tag, background, offset, height per band. Compare a reference site's structure against your build. Same heavy-site-friendly wait (`waitStrategy: "networkidle"` available). (needs [playwright](https://playwright.dev)). |
| `record_site_motion` | Optional: short motion-through video of a live URL — preloader, scroll-triggered and hover/cursor animations. Returns an inline filmstrip JPEG plus the saved .webm path. (needs [playwright](https://playwright.dev) + ffmpeg-static). |

## Setup

Any MCP-compatible coding agent can use awwwards-mcp — no API key, no account.
Requires Node ≥ 22.13 (`node -v` to check). Pick your agent:

**Claude Code**

```bash
claude mcp add awwwards -- npx -y awwwards-mcp
```

**Codex CLI** (ChatGPT desktop app and the IDE extension share this config)

```bash
codex mcp add awwwards -- npx -y awwwards-mcp
```

or in `~/.codex/config.toml` (project-scoped: `.codex/config.toml`):

```toml
[mcp_servers.awwwards]
command = "npx"
args = ["-y", "awwwards-mcp"]
```

**OpenCode** (`opencode.json` — note the command is an array)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "awwwards": {
      "type": "local",
      "command": ["npx", "-y", "awwwards-mcp"]
    }
  }
}
```

**ZCode** (`~/.zcode/cli/config.json` — note servers nest under `"mcp": { "servers": ... }`)

```json
{
  "mcp": {
    "servers": {
      "awwwards": { "command": "npx", "args": ["-y", "awwwards-mcp"], "env": {} }
    }
  }
}
```

**Claude Desktop / Cursor / Windsurf / Gemini CLI / Cline / Continue** — anything
reading the common `mcpServers` JSON shape (e.g. `~/.claude/claude_desktop_config.json`
or `~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "awwwards": { "command": "npx", "args": ["-y", "awwwards-mcp"] }
  }
}
```

**Anything else** — awwwards-mcp is a plain stdio MCP server: point your client
at `npx -y awwwards-mcp` and it works. To pin a version, use
`npx -y awwwards-mcp@1.0.0`.

**pi coding agent** has no built-in MCP by design — it uses skills and
extensions instead. Two options:

1. Install the awwwards-inspiration skill (below). pi reads skills from
   `~/.pi/agent/skills/` or `~/.agents/skills/` (the latter is shared across
   agents following the Agent Skills standard). The skill teaches the workflow;
   for it to reach the live data, add an MCP-supporting pi extension, or run
   the queries in another agent and paste results.
2. Skip MCP entirely: ask pi to build you a small CLI wrapper around
   awwwards.com, or use a shared skills directory (`~/.agents/skills/`) so the
   same skill file serves pi and every other agent.

Optional full-page captures (needed by `capture_live_site`,
`analyze_page_structure`, `record_site_motion`):

```bash
npm install -g playwright && npx playwright install chromium
```

`record_site_motion` additionally uses ffmpeg; it resolves the `ffmpeg-static`
package automatically if present.

## Skills

This package ships an agent skill that teaches the inspiration workflow —
search, judge from screenshots, pull design DNA, state a design direction —
using the awwwards MCP tools. Any agent that follows the
[Agent Skills standard](https://agentskills.io) can load it; copy it into your
agent's skills directory:

```bash
npm install awwwards-mcp
mkdir -p ~/.agents/skills && cp -r node_modules/awwwards-mcp/skills/awwwards-inspiration ~/.agents/skills/
```

| Agent | Skills directory |
|-------|------------------|
| Claude Code | `~/.claude/skills/` |
| pi | `~/.pi/agent/skills/` (also reads `~/.agents/skills/`) |
| ZCode | `~/.zcode/skills/` |
| Agent Skills-standard agents | `~/.agents/skills/` |

Windows: run this from Git Bash, or copy
`node_modules\awwwards-mcp\skills\awwwards-inspiration` manually.

## Indexing (recommended)

`search_sites` works out of the box, but its depth is limited by polite live
scraping (~31 sites per filter page). Build a local index once and searches
draw from thousands of award-winning sites instantly:

```bash
npx -y -p awwwards-mcp awwwards-index      # once published
# or, from a local checkout of this repo:
npm run index
```

- Crawls all ~200 tag pages at 1 request/second (~4 minutes) into the local
  SQLite cache at `~/.awwwards-mcp/`.
- Resumable: interrupt it and re-run — completed pages are skipped.
- The MCP server re-indexes automatically in the background whenever the
  index is older than 7 days (never blocking your session).

Site details (palettes, tech stacks) are still fetched on demand and cached
for 7 days.

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

## Built with awwwards-mcp: a real portfolio

This project's own showcase — **[showcase/afjal-portfolio](showcase/afjal-portfolio/)**,
[open index.html locally](showcase/afjal-portfolio/index.html) — is a personal
portfolio built through the full inspiration loop this MCP enables, using
nothing but the server's tools. Three pages: the 3D thumbnail-ring home
(reference preloader), a **horizontal** projects gallery (reference case
studies, GSAP ScrollTrigger pin), and a **horizontal** about chapter where a
chrome model holds center while text passes by (reference about).

**The loop, as it ran** (skill used: `awwwards-inspiration`, shipped in this
package — its 8-step structure-before-pixels doctrine drove every step):

1. `list_categories` grounded the filter vocabulary (two combined-filter
   searches came back empty first — that's what step 2 of the skill is for).
2. `search_sites` `{ award: "sotd", tags: ["portfolio", "typography"] }`
   returned 25 proven portfolios with **inline screenshots** — shortlist
   judged from the images, not titles.
3. `get_site_details` on the pick,
   [Gionatan Nese '26](https://www.awwwards.com/sites/gionatan-nese-26)
   (SOTD, jury 7.32) — design DNA: palette `#000`/`#FFF`, serif
   statement-over-canvas, tiny metadata rhythm.
4. `get_site_elements` pulled component-level anatomy — and here the loop
   taught its biggest lesson: **element posters lie**. The first build was
   designed from poster frames alone and rendered the hero as *floating
   static cards*. Downloading the actual element videos (from the CDN URLs
   the tool returns) and frame-tiling them revealed the truth: the hero is a
   **spinning 3D thumbnail ring with perspective depth**, projects are
   **full-bleed tinted panels with giant display type and sliver image
   reveals**, and the about page is a **pinned chrome 3D model with text
   passing by**. The showcase was rebuilt motion-true (pure CSS 3D, no
   WebGL) — and restructured into separate horizontal pages per review.
5. `capture_live_site` caught the live reference's layout first-hand and
   build bugs (invisible `.reveal` content → fixed with progressive
   enhancement; `file://` capture caching → `?v=N` cache-buster).
6. `analyze_page_structure` ran on BOTH the reference and the build — band
   maps compared, never just total height.
7. `record_site_motion` filmed all three pages: the spinning ring mid-
   rotation, the projects gallery sliding past the cobalt and mint panels,
   and the chrome model holding center while chapters pass (with the
   recorder's own hover interactions on camera).

Prompt count: **3** — (1) the build ask, (2) the motion correction that
exposed the poster-lie ("did you see how the preloader animates?"), (3) the
structure pass ("projects and about should be horizontal pages… capture
live sites and animation BEFORE building"). Each correction became doctrine
in the shipped `awwwards-inspiration` skill: frame-study element videos
before animating; judge page architecture from the studied passages; tile
per element, not one giant filmstrip.

**Frontend skills engaged during the build** (from ZCode's skill library):
`awwwards-inspiration` (the loop itself) and `gsap-scrolltrigger` (the
horizontal pin + containerAnimation pattern). Reduced-motion, JS-less
visits, and capture tools all get graceful fallbacks (`no-h` vertical
stacks; progressive-enhancement reveals).

**What the verification loop caught** — proof the structure-before-pixels
doctrine is load-bearing:

- Full-page captures initially showed blank sections: `.reveal` animation
  state vs capture's no-scroll reality. The build ships
  content-visible-without-JS progressive enhancement.
- The v2 motion film caught the preload scroll-lock interacting with
  reduced-motion; the lock now never applies to capture tools or JS-less
  visits.
- Band-map compare kept the reference's rhythm instead of drifting on
  section heights.

## Can awwwards-mcp crawl the sitemap? (robots.txt notes)

The awwwards.com `robots.txt` advertises
`Sitemap: https://www.awwwards.com/sitemap.xml` and — verified live
2026-09-18 — **that sitemap URL returns a soft-404 HTML page** (as do common
child names like `/sitemap-websites.xml`). So sitemap discovery isn't
currently a path to more data; the polite crawl surface is exactly what the
indexer uses:

- **Allowed and used**: `/websites/`, `/websites/<filter>/`, `/sites/<slug>`
  (one filter per URL; deep pagination stays un-crawled).
- **Disallowed and never fetched**: `/tag/`, `/search-websites`,
  `/websites/?` (query-string pagination), `/elements/*`, `/vote/`,
  favourites/likes/follows, and the rest of the 33 rules.
- Our client (`src/awwwards.ts` `buildFilterUrl`) constructs **only**
  `/websites/…` paths at 1 request/second — the loop stays inside the
  published rules by construction, not by convention.

## Contributing

PRs welcome! The project especially needs **parser-drift fixes** — when live
awwwards.com markup changes, a fresh HTML snapshot attached to an issue often
becomes the new test fixture and the fastest merged PR. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full guide:

- Development setup & project layout (offline fixture-tested, no network in tests)
- How to create a PR: fork → `fix/`/`feat/`/`docs/` branch → typecheck + tests → PR template
- The politeness constraints new code must keep (1 req/s, robots.txt paths, light runtime deps)

Bugs and feature ideas start as
[issues](https://github.com/INSANE0777/Awwwards-mcp/issues/new/choose) with
templates. Security problems go privately — see
[SECURITY.md](SECURITY.md). By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Development

```bash
npm install
npm test        # offline unit tests against committed HTML fixtures
npm run smoke   # manual live smoke test against awwwards.com
npm run build   # compile to dist/
```

MIT — see [LICENSE](LICENSE).
