# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.17.x  | Yes       |
| < 1.17  | No        |

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
only talk to awwwards.com. URL tools that you invoke — `capture_*`, the
URL-taking `analyze_*`/`audit_*` tools, `verify_build`, `verify_flow`,
`inspect_page` and their equivalents — intentionally fetch the user-supplied
http(s) URL you pass.
Local-input tools read user-supplied local files (HAR, HTML, `file://` pages),
and `build_project` writes to a user-chosen output directory. The server does
not execute shell commands from tool arguments.

Genuine vulnerabilities:

- **Unexpected SSRF**: the server fetching a URL that no tool argument named
  and no documented discovery step implies; following off-origin links scraped
  from page content that the tool does not document fetching; or bypassing a
  tool's documented origin, loopback or attach guard (`AWWWARDS_MCP_ATTACH`,
  `cdpEndpoint`, per-tool origin restrictions). Expected traffic is not SSRF:
  fetching the URL you passed, browser subrequests while rendering that page,
  and documented discovery such as `analyze_bundle` intentionally fetching
  script URLs found in page markup (including CDN scripts). Honor each tool's
  documented restrictions.
- **Path traversal**: escaping the SQLite cache directory
  (`~/.awwwards-mcp/`) — e.g. a slug or hash that escapes it when used in file
  paths — or reading/writing outside a user-supplied input/output path.
- **Prompt injection via scraped markup**: the server injects page-derived
  content into agent context, so reports on how scraped content could carry
  hidden instructions to a consuming agent are in scope.
- **Supply chain**: a dependency adding install scripts or unexpected network
  calls.

Not in scope: rate-limit annoyance against awwwards.com itself (the 1 req/s
limiter is a politeness feature, not a security boundary), and "the tool
returned emoji" style data-quality bugs — those are regular issues.
