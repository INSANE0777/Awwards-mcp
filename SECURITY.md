# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.20.x  | Yes       |
| < 1.20  | No        |

Only the current release line receives fixes.

## Reporting a vulnerability

Do **not** open a public GitHub issue for security problems.

Instead, use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**), or email **insaneafjal@gmail.com**
with "[awwwards-mcp]" in the subject if you prefer email.

Include: what's vulnerable, how to reproduce it, and what an attacker could
do. You'll get an initial response within a few days, and credit in the
fix release if you want it.

## What counts as a security issue here

awwwards-mcp runs locally on a developer machine and acts with the permissions
of the user who started it. It is not a sandbox.

Network boundary: Awwwards requests are rate-limited, but the server does not
only talk to awwwards.com. URL tools that you invoke - `capture_*`, the
URL-taking `analyze_*`/`audit_*` tools, `verify_build`, `verify_flow`,
`inspect_page`, `export_design_tokens` and their equivalents - intentionally
fetch the user-supplied http(s) URL you pass. Atlas capture and scene capture
use the same boundary; `capture_scene_3d download_assets` also writes files
into the capture directory, but only for assets it is allowed to fetch.
Local-input tools read user-supplied local files (HAR, HTML, `file://` pages);
`build_project` writes to a user-chosen output directory; scene captures,
downloaded assets and `export_evidence_pack` write under the cache directory.
The server does not execute shell commands from tool arguments.

Genuine vulnerabilities:

- **Unexpected SSRF**: the server fetching a URL that no tool argument named
  and no documented discovery step implies; following off-origin links scraped
  from page content that the tool does not document fetching; or bypassing a
  tool's documented origin, `publicOnly`, loopback or attach guard (`AWWWARDS_MCP_ATTACH`,
  `cdpEndpoint`, per-tool origin restrictions). Expected traffic is not SSRF:
  fetching the URL you passed, browser subrequests while rendering that page,
  and documented discovery such as `analyze_bundle` intentionally fetching
  script URLs found in page markup (including CDN scripts). Honor each tool's
  documented restrictions.
- **Path traversal**: escaping the SQLite cache directory
  (`~/.awwwards-mcp/` or `AWWARDS_CACHE_DIR`), the scene-capture directory,
  the evidence-pack store (`atlas/evidence-packs`) or a user-supplied
  input/output path - e.g. a slug, hash or artifact path that escapes when used
  in file paths.
- **Prompt injection via scraped markup**: the server injects page-derived
  content into agent context - including Atlas region labels, evidence-pack
  documents and scene shader source - so reports on how scraped content could
  carry hidden instructions to a consuming agent are in scope.
- **Supply chain**: a dependency adding install scripts or unexpected network
  calls, or a modified Playwright, ffmpeg or Spector bundle.

Not in scope: rate-limit annoyance against awwwards.com itself (the 1 req/s
limiter is a politeness feature, not a security boundary), and "the tool
returned emoji" style data-quality bugs — those are regular issues.
