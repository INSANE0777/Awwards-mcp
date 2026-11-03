---
name: awwwards-setup
description: Use when the awwwards MCP server or its skills are invoked for the first time in a session or on a new machine — when no awwwards preferences exist yet, or the user asks to set up, configure, or change awwwards-mcp settings (result density, viewport, live captures, local index, winner watches). First-time onboarding asks the user a short set of preference questions, persists them to ~/.awwwards-mcp/preferences.json, and runs any one-time installs they opt into.
---

# Awwwards MCP Setup

First-time onboarding for the awwwards MCP server. Goal: before the first
real search, know how this user wants results served, and have the optional
heavy deps installed only if they'll be used. Every choice is persisted, no
choice is re-asked.

> **Profile note:** this skill's tools are `search_sites`, `list_categories`,
> `get_annual_categories` (plus `get_annual_nominees` / `get_annual_nominee`),
> `new_winners`, `watch_site`, `capture_live_site`, `analyze_page_structure`,
> `record_site_motion`, `export_design_tokens`, `analyze_images` and
> `analyze_bundle`. Examples below use 1.x names (default `full`). On
> `AWWWARDS_MCP_PROFILE=v2`, use
> `search_references {request:{kind:"sites", ...}}`,
> `browse_awards {request:{kind:"filters"}}`,
> `browse_awards {request:{kind:"annual_categories"}}` (also
> `kind:"annual_nominees"` and `kind:"annual_nominee"`),
> `monitor_awards {request:{action:"poll_winners"}}`,
> `monitor_awards {request:{action:"add_watch", kind, pattern}}`,
> `monitor_awards {request:{action:"list_watches"}}`,
> `monitor_awards {request:{action:"remove_watch", kind, pattern}}`,
> `capture_page {request:{kind:"screenshot", url}}`,
> `inspect_page {request:{kind:"structure", url}}`,
> `capture_page {request:{kind:"recording", url}}`,
> `inspect_page {request:{kind:"tokens", url}}`,
> `audit_page {request:{kind:"images", url}}` and
> `audit_page {request:{kind:"bundle", url}}`. Full mapping:
> [v2-routing.md](../v2-routing.md).

## 0. Check for existing preferences

Read `~/.awwwards-mcp/preferences.json` (cache dir may be relocated via
`AWWWARDS_CACHE_DIR` — respect it if set). If the file exists and names the
fields below, apply it silently and stop — do not re-onboard. If a field is
missing, ask only about that field. If the file is absent, proceed.

## 0b. No MCP connected? Wire it first

Profile-blind detection: the server is unregistered only when no awwwards
tools at all are available. A connected `v2` session intentionally has no
`search_sites` or `list_categories`; recognize it by `search_references`
and/or `get_index`. A connected `core` session registers 13 tools and does not
include `list_categories`, so do not require it. If any awwwards tool
responds, skip to step 1.

When nothing is available, the server isn't registered with the agent yet —
set it up before anything else. Detect the agent and use its add command
(install one-time optional deps afterwards in step 1, no API key, no
account, Node ≥ 22.13):

| Agent | Command |
|-------|---------|
| Claude Code | `claude mcp add awwwards -- npx -y awwwards-mcp` |
| Codex CLI | `codex mcp add awwwards -- npx -y awwwards-mcp` |
| OpenCode (opencode.json) | `"mcp": { "awwwards": { "type": "local", "command": ["npx", "-y", "awwwards-mcp"] } }` |
| mcpServers-standard clients (Claude Desktop, Cursor, Windsurf, Gemini CLI, Cline, Continue) | `"mcpServers": { "awwwards": { "command": "npx", "args": ["-y", "awwwards-mcp"] } }` |

For pi (no MCP by design): install this skill into the agent's skill
directory — pi gets the workflow; live data needs another agent or an
MCP-supporting extension. After registering, the agent restart is needed
before the tools appear — say so and stop; preferences (step 1) can be
collected now and persisted so the restarted session lands running.
Optional env additions: `AWWWARDS_CACHE_DIR` (custom cache location),
`AWWWARDS_AUTO_UPDATE=1` (background self-update on new releases),
`AWWWARDS_MCP_PROFILE=core|full|v2` (`core` registers only the 13
build-loop tools, including `get_annual_categories`; `full` exposes all 41;
`v2` registers 10 consolidated tools plus 5 retained tools with their existing
names and flat inputs (create_design_brief, build_project, verify_build,
verify_flow, analyze_network_capture); only the 34 replaced 1.x names
disappear; default full;
changing it requires a server restart). The old → new v2 mapping lives in
[../v2-routing.md](../v2-routing.md) — do not mix 1.x names into a v2 session.
`AWWWARDS_MCP_MAX_RESPONSE_BYTES` (default 32 MB; oversized results become a truncation JSON),
`AWWWARDS_MCP_DEBUG_MEMORY=1` (one stderr metrics line per tool call), and
`AWWWARDS_MCP_ATTACH=1` (allow read-only CDP attach for logged-in pages).
The one-release legacy `AWARDS_MCP_*` spellings are accepted; canonical is `AWWWARDS_MCP_*`.

## 1. Ask the user (batched, all at once)

Present these as a single short questionnaire — the user should answer once,
not endure four follow-ups. Offer a sensible default for each so "just use
defaults" is a valid answer:

1. **Result density** — When you `search_sites`, how should results look?
   - **Full** (default): every result gets its inline screenshot. Best for
     judging design at a glance; costs more context.
   - **Compact**: concise text cards, inline previews only for the top two
     results of the requested page. Best for broad exploration and
     long-running agents.
   This maps to the `responseMode` parameter: the chosen default is passed
   on every search unless the request says otherwise (screen-judging tasks
   should still use full). Store as `"responseMode": "full" | "compact"`.

2. **Default viewport** for live captures, structure analysis and motion
   records — `"desktop"` (1440×900, default) or `"mobile"` (390×844), or
   `"both"` for design work where the user says mobile matters. Store as
   `"defaultViewport": "desktop" | "mobile" | "both"`.

3. **Live captures** — Do you want fresh screenshots / structure band maps /
   motion recordings / design-token exports / image audits (`capture_live_site`,
   `analyze_page_structure`, `record_site_motion`, `export_design_tokens`,
   `analyze_images`)? They need the optional playwright + chromium install
   (~120 MB):
   `npm install -g awwwards-mcp playwright ffmpeg-static && npm exec --global -- playwright install chromium`
   Then switch this agent's `awwwards` registration from `npx -y awwwards-mcp`
   to the installed command (`awwwards-mcp`) in the same scope and restart, so
   the server and Playwright resolve from the same global install. If yes, run
   that install now (it is one-time, safe to re-run). If no,
   skip and note that the capture tools will error until installed. Store
   as `"capturesEnabled": true | false`.
   Optional extra for bundle forensics: `npm install -g webcrack`
   enables `analyze_bundle`'s de-obfuscation/unpack mode; without it the
   tool still fetches, saves, and keyword-greps raw chunks.

4. **Local index** — `search_sites` works immediately, but builds depth by
   polite live scraping (~31 sites per page). The local index (~4 minutes,
   resumable, then background-refreshed automatically) buys searches across
   thousands of sites instantly:
   `npx -y -p awwwards-mcp awwwards-index` (or `npm run index` in a repo
   checkout). Offer it; if accepted, run it in the background and continue —
   do not block onboarding. Store as `"autoIndex": true | false`.

5. **Winner watches** — Do you want to track studios, tags or specific
   sites across sessions? If the user names any, register them
   (`watch_site`, `action: "add"`, `kind: studio|tag|url`, one per entry,
   optional `award` and `note`), remind them the first `watch_site list`
   only seeds a baseline, and store nothing here (watches live in the
   server's own cache).

6. **Staying current** (optional, no storage — just behavior): if the user
   does trend research, note that opening sessions with `new_winners` keeps
   the winner baseline fresh and feeds any watches.

Mention while onboarding: annual-awards questions run through the three
`get_annual_*` tools, and `search_sites`' award filter extends past the daily
winners to `sotm`/`soty`/`nominees` and the winner-category cuts (`ecommerce`,
`portfolio`, `product`, `typography`, `businessServices`, `noCode`).

Persist the answers to the preferences file as one JSON object, creating
`~/.awwwards-mcp/` if needed:

```json
{
  "responseMode": "full",
  "defaultViewport": "desktop",
  "capturesEnabled": true,
  "autoIndex": true,
  "onboardedAt": "2026-09-28T00:00:00.000Z"
}
```

## 2. Verify the toolchain (no questions)

After answering preferences, sanity-check the setup in one pass:

- **Version drift**: if the server printed an update notice (stderr) on
  boot, tell the user the newer version and how to pick it up (`npx -y
  awwwards-mcp@latest` or set `AWWWARDS_AUTO_UPDATE=1` in the server `env`).
- **If capturesEnabled**: a one-line confirmation that playwright resolved.
  If it fails, say the capture tools are disabled until
  `npm exec --global -- playwright install chromium` succeeds - do not retry in a loop.
- **If the cache dir looks broken** (tool errors about SQLite or locks):
  route to the `awwwards-doctor` skill; do not delete anything.
- **If `AWWWARDS_MCP_PROFILE=v2`**: probe the consolidated surface with
  `get_index {request:{kind:"status"}}` (zero network) or
  `search_references {request:{kind:"sites", query:"portfolio"}}` once the
  local index has rows. A 1.x tool name in a v2 session is a routing error,
  not a broken install — check [../v2-routing.md](../v2-routing.md) and
  restart after changing the profile.

## 3. Report and hand off

Close with a 2–3 line summary: the stored preferences, what was installed /
started in the background, and the single next command the user's workflow
starts with (usually `search_sites` — with the stored `responseMode`.
Round the reporting off; this skill is setup, not a tutorial. The working
methods live in `awwwards-inspiration` (research loop, winner feed, index
ops), `awwwards-motion-study` (video reference study) and `awwwards-doctor`
(repairs).

## Changing settings later

If the user asks to change any of these ("make it compact", "capture on
mobile"), update the preferences file and confirm in one line. Re-running
this skill with existing preferences only asks about missing fields.

<!-- skill-memory:start -->
<!-- skill-memory:end -->
