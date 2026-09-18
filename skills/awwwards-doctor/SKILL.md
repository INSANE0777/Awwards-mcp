---
name: awwwards-doctor
description: Use when awwwards-mcp scraping or tools stop working — BlockedError, "layout may have changed" parser errors, empty results, failed captures, stale searches — or when the user reports the MCP behaving oddly. Guides running the doctor/drift/index scripts, applying their fixes, re-anchoring parsers after real awwwards.com drift, and recovering the in-flight task that surfaced the failure.
---

# Awwwards MCP Doctor

You are repairing the awwwards-mcp toolchain or working around it mid-task.
Work in this order: **diagnose → fix mechanically → fix parsers (if drift) →
recover the user's task**. Never delete user data; the only destructive step
(cache DB moved aside) preserves the old file in the OS temp dir.

## 1. Run the doctor (repo checkout)

```bash
npm run doctor             # diagnose only
npm run doctor -- --fix    # diagnose AND apply available fixes
npm run doctor -- --json   # machine-readable report
```

The doctor checks five things and knows how to fix the mechanical ones:

| Check | Failure meaning | What --fix does |
|---|---|---|
| network | awwwards.com blocked/challenged the request | nothing to fix locally — wait, retry later; never retry in a loop |
| parser-drift | awwwards.com markup changed under the parsers | captures the raw live page into `docs/drift-<timestamp>/` (gitignored) as the fixture for the fix |
| playwright-chromium / ffmpeg-static | optional capture deps missing or broken | installs them (dev deps + `npx playwright install chromium`) |
| cache | SQLite DB corrupt/locked, or index older than 30 days | moves an unreadable DB aside (kept in temp) and rebuilds via `npm run index` |
| boot | `dist/cli.js` doesn't start | `npm run build` |

Re-run the doctor after fixing; the verdict must be HEALTHY before you claim
the MCP is repaired.

## 2. Fixing real parser drift (the only code-level failure)

If the doctor reports parser-drift, the anchor probes say which parser broke.
Repair sequence — keep it mechanical, verify at each step:

1. **Capture the evidence**: the `--fix` snapshot in `docs/drift-*/` IS the
   new truth. (The daily GitHub Action also opens/updates a `parser-drift`
   tracking issue with the drifted anchor names.)
2. **Locate the new anchors**: open the captured HTML and find the markup
   that replaced the old anchor (search the old anchor's *purpose*, e.g. the
   card JSON blob, the Elements section heading, the og:image meta).
3. **Re-anchor the parsers** in `src/parsers.ts` — change the minimum needed
   (one split/indexOf/regex literal), not the surrounding logic.
4. **Update the probe list** in `scripts/parser-drift-probe.mjs`
   (`PROBE_GROUPS`) so the same failure is detectable next time.
5. **Refresh the fixture**: download the live page with the same UA the
   client uses and replace `test/fixtures/listing.html` (or the detail
   fixture). The offline tests run against fixtures only — a refreshed
   fixture proves the re-anchor against reality.
6. `npm run typecheck && npm test` — all tests must pass.
7. Commit as `fix: re-anchor <parser> after awwwards.com markup change`,
   reference the tracking issue.

## 3. End users (installed via npm, not a repo checkout)

The doctor scripts live in the repo, so for an npm-installed server:

1. Check the version notice: stderr at startup prints when a newer
   `awwwards-mcp` exists. Update with `npm install -g awwwards-mcp@latest`
   (or clear the npx cache) and restart the agent — a surprising share of
   "broken" reports are old parsers fixed in a newer release.
   `AWWWARDS_AUTO_UPDATE=1` in the MCP server env opts into background
   self-update on startup.
2. Reset local state: `rm -rf ~/.awwwards-mcp` is safe (cache + index +
   version-check state rebuild automatically; nothing user-authored lives
   there).
3. If it still fails, it's upstream (block or drift): open an issue at the
   awwwards-mcp repo attaching the raw HTML of the failing URL.

## 4. Recovering the in-flight task (the reason you noticed)

The user's build/research doesn't wait for the repair. Degrade gracefully:

- **Stale cache is your friend**: `search_sites`/`get_site_details` serve
  cached data when live fetches fail — say so in the reply ("7-day-old
  cached data").
- **BlockedError means stop, not retry**: the client never retries through
  blocks; tell the user and continue with cached/alternate data.
- **Capture tools down** (playwright missing): fall back to
  `get_site_details` screenshots (CDN-served, no browser needed) until
  `npm run doctor -- --fix` restores chromium.
- **Parser drift mid-task**: results may be partially empty (e.g. details
  without palette). Surface which part is missing; don't silently present
  degraded data as complete.
- After the MCP is healthy again, **re-run the failed calls** and reconcile
  with whatever the fallback produced.

## Anti-patterns

- Retrying blocked requests in a loop — politeness rules and block
  detection exist precisely so this doesn't hammer awwwards.com.
- Diffing raw HTML to detect drift — cosmetic page changes would false-alarm
  daily; only parser-anchor probes matter.
- "Fixing" parsers by loosening them to return empty results quietly — a
  parse that can't find its anchors must error loudly (that is the drift
  signal).
- Treating the doctor's UNHEALTHY verdict as done because one check passed.
