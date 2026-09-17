# Design: `awwwards-inspiration` Skill

Date: 2026-09-17
Status: Approved (approach A — single SKILL.md)

## Problem

The awwwards-mcp server exposes five tools, but an agent that has never seen
them before doesn't know the workflow that makes them valuable: how to turn a
vague design goal into concrete filters, how to judge references from
screenshots, and how to translate findings into a design direction. The MCP
README documents the tools; nothing teaches the *loop*.

## Goal

Ship a skill with the npm package that any user can install into their agent's
skills directory. The skill teaches agents to (1) run the inspiration loop
during site builds, (2) run standalone inspiration research, and (3) maintain
the local index and live-capture setup.

## Non-goals

- Teaching generic design taste or frontend implementation technique — the
  skill ends at "state the design direction"; building the site is other
  skills' territory.
- A full parameter-by-parameter API reference — the reference section covers
  purpose, key params, return shape, and gotchas only.

## Artifact

`skills/awwwards-inspiration/SKILL.md` — a single file, ~200 lines.

### Packaging

- Add `skills/awwwards-inspiration/SKILL.md` to `package.json` `files` so it
  ships with the npm package.
- README gains a short "Skills" section explaining where to copy the skill
  (e.g. `~/.zcode/skills/` or `~/.claude/skills/`) and what it does.

### Frontmatter

- `name: awwwards-inspiration`
- `description:` covers all three trigger scenarios in one line each:
  building a site that needs design references; standalone inspiration
  research ("show me dark 3D portfolio sites"); index/capture operations
  (awwwards-index CLI, capture_live_site setup).

### Body sections

1. **When to use this skill** — the three trigger scenarios with example user
   phrasings.
2. **The inspiration loop** — the core section. Steps:
   1. Restate the design goal as concrete attributes (mood, color, tech,
      industry).
   2. If unsure which filters exist, call `list_categories` to ground the
      vocabulary before searching.
   3. `search_sites` with 1–3 filters; judge from the inline screenshots;
      shortlist 2–3 sites.
   4. `get_site_details` on the top pick for design DNA (palette, tech,
      elements, awards).
   5. If building: `get_site_elements` for component-level visuals (posters,
      video URLs, mobile layouts).
   6. Translate findings into an explicit design direction — palette, type
      mood, layout patterns, tech choices — stated in prose *before* writing
      any code.
   Anti-patterns called out: vague single-word searches; skipping straight to
   code without stating a direction; dumping raw tool output at the user
   instead of curating.
3. **Tool reference** — compact table or per-tool bullets: purpose, key
   params, return shape, gotchas (results carry inline screenshots as images;
   unindexed search depth is limited by polite scraping; the server
   re-indexes in the background; `capture_live_site` requires a playwright
   install).
4. **Index & capture ops** — `awwwards-index` CLI usage (resumable, ~4
   minutes, SQLite cache at `~/.awwwards-mcp/`), and the playwright setup
   steps for `capture_live_site`.

## Verification

The vitest suite does not cover docs, so verification is manual:

1. Frontmatter is well-formed YAML and the file reads as a valid SKILL.md.
2. Every tool name and parameter mentioned in the reference matches the
   definitions in `src/` (spot-checked against `src/server.ts` and tool
   schemas).
3. README and `package.json` changes are consistent with existing patterns.
4. Live smoke test: run one loop described by the skill against the locally
   registered `awwwards` MCP (search → details → direction) and confirm the
   instructions produce the expected behavior.
