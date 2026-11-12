# Contributing to awwwards-mcp

Free, open-source MCP server giving AI agents design inspiration from
[Awwwards](https://www.awwwards.com/). PRs are welcome — this guide covers
everything you need, from fork to merged PR.

## Ways to contribute

- **Bug reports** — a tool returned wrong data, a parser broke against live
  awwwards.com markup, something crashes. Open an
  [issue](https://github.com/INSANE0777/Awwwards-mcp/issues/new?template=bug_report.md).
- **Feature ideas** — new tools, search filters, output formats. Open an
  [issue](https://github.com/INSANE0777/Awwwards-mcp/issues/new?template=feature_request.md)
  first so we can agree on the shape before you code it.
- **Code** — bug fixes, parser updates, new tools. Follow the PR flow below.
- **Docs** — setup guides for more coding agents, clearer README sections,
  examples. Docs PRs skip most gates (see below).

## Development setup

Requires Node ≥ 22.13. Windows/macOS/Linux all work (the maintainer develops
on Windows + Git Bash; CI runs ubuntu).

```bash
git clone https://github.com/INSANE0777/Awwwards-mcp.git
cd Awwwards-mcp
npm install
npm run typecheck   # tsc --noEmit
npm test            # full suite, including Chromium regressions
# Fast offline run without browser tests:
npx vitest run --exclude "**/*.chromium.test.ts" --maxWorkers=2
```

Most tests run against **committed HTML fixtures** in `test/fixtures/` - you
never hit awwwards.com during development or CI. Browser regressions
(`*.chromium.test.ts`) run against local loopback fixtures and need a
Playwright Chromium build; they skip only where the host has no Chromium and
`AWWARDS_CHROMIUM_SMOKE` is unset. Playwright is a devDependency, but
`npm install` does not download a browser binary.

If the `ffmpeg-static` download fails during install, use
`npm ci --ignore-scripts`: tests inject their own ffmpeg path or stub.

For a manual smoke test against live awwwards.com:

```bash
npm run smoke
```

## Project layout

```
src/
  parsers.ts    Pure HTML parsers (fixture-tested — most PRs land here)
  awwwards.ts   HTTP client: 1 req/s limiter, BlockedError on 403/429
  cache.ts      SQLite cache at ~/.awwwards-mcp/ or AWWWARDS_CACHE_DIR (node:sqlite)
  server.ts     Thin facade: re-exports public types + createHandlers
  server/       Handler domains: awards, data, capture, motion, audit, build, atlas
  tools/        41 base MCP tool registrations (45 with AWWARDS_MCP_ATLAS=1)
  atlas/        Atlas ingest, collector, search, components, states and evidence packs
  capture.ts    Optional playwright: capture_live_site
  structure.ts  Optional playwright: analyze_page_structure
  motion.ts     Optional playwright + ffmpeg: record_site_motion
  cli.ts        stdio server entry + startup wiring
  index-cli.ts  awwwards-index bin (cache priming crawler)
test/           vitest, offline, committed fixtures
docs/           design specs and plans
```

Agent skills live in the separate
[awwwards-skills repository](https://github.com/INSANE0777/awwwards-skills),
not in this repo: edit, test, and review them there. This repository no longer
carries a `skills/` directory and the npm package does not ship one.

Hard constraints the codebase enforces (keep them in new code):

- **Politeness**: max 1 request/second to awwwards.com, robots.txt-compliant
  paths only, one filter per URL. New crawlers go through `AwwwardsClient`.
- **Offline tests**: no test may touch the network. Capture network-shaped
  behavior behind the existing injectable seams (`loader`, `ffmpegFn`,
  `client`).
- **No native deps**: runtime deps are the MCP SDK + zod; the cache is
  `node:sqlite`. Don't add anything needing compilation.
- **playwright stays optional**: every browser-backed tool must fail with an
  install hint when playwright or Chromium is absent, never crash the server.
- **Atlas is opt-in**: `AWWARDS_MCP_ATLAS=1` adds four tools and changes the
  surface to **45 / 13 / 16**. Keep the default **41 / 13 / 15**, keep Atlas
  off by default, and do not present candidate labels or the F9 component gate
  as settled.

## How to create a PR

1. **Fork & branch.** Fork the repo, then from your fork:

   ```bash
   git checkout -b fix/parser-drift-body-copy
   ```

   Branch names: `fix/…`, `feat/…`, `docs/…`, `chore/…`.

2. **Make the change.** Match the surrounding code style — TypeScript strict
   ESM, comment density like neighboring files. Keep PRs focused: one bug or
   one feature per PR.

3. **Test it.**

   ```bash
   npm run typecheck
   npm test
   ```

   - Bug fix: add a test that fails without your fix (committed fixture or
     unit test) and passes with it.
   - Parser change: add/replace a fixture in `test/fixtures/` and derive the
     new expectations from it — floors for volatile counts, never exact live
     values.
   - Feature: tests for the handler logic via the existing fake seams.

4. **Commit.** Small focused commits with messages in the repo's style:

   ```
   fix: strip soft-404 markup from parseDetail body-copy anchor
   feat: add technology filter to search_sites
   docs: add Codex setup to README
   ```

   Conventional-ish prefixes (`fix`/`feat`/`docs`/`chore`/`test`) + one-line
   summary. No AI-attribution footers, please.

5. **Open the PR** against `main` from your fork. Fill the PR template —
   what changed, why, how you tested it. Link the issue it closes
   (`Closes #123`).

6. **Green checks.** CI must pass on Ubuntu 22.04, Ubuntu 24.04, Windows 24
   and macOS 15, including the Chromium launch preflight, pack smoke and
   protocol smoke for both protocol generations. The maintainer reviews within
   a few days; expect comments on parser PRs - fixtures drive everything here,
   so reviews verify fixtures against live markup.

### What gets PRs merged fast

- A failing parser + fresh fixture proving the new markup (this is the
  highest-value contribution the project accepts — awwwards.com drifts).
- Docs fixes and new agent setup guides (setup shapes verified against the
  agent's official docs, like the existing README section).
- Tests tightening floors on volatile values.

### Docs-only PRs

Docs PRs skip the test gates when no `src/`/`test/` file changed — CI still
runs, it just won't find anything to break. Keep code blocks in README valid
(embedded JSON is validated in review).

## Reporting security issues

Please **do not open a public issue** for anything that looks like a security
problem (e.g. a way the server could be tricked into scraping non-awwwards
URLs, cache poisoning, path traversal in the cache, capture directories,
evidence-pack store or build output). See
[SECURITY.md](SECURITY.md) for private reporting.

## License

By contributing, you agree your contributions are licensed under the MIT
License that covers the project.
