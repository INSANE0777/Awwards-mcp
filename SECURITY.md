# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | ✅        |

## Reporting a vulnerability

Do **not** open a public GitHub issue for security problems.

Instead, use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**), or email **insaneafjal@gmail.com**
with "[awwwards-mcp]" in the subject if you prefer email.

Include: what's vulnerable, how to reproduce it, and what an attacker could
do. You'll get an initial response within a few days, and credit in the
fix release if you want it.

## What counts as a security issue here

awwwards-mcp runs locally on a developer machine and talks only to
awwwwards.com and its CDN. Things that would be genuine vulnerabilities:

- The server fetching URLs other than awwwards.com / its CDN (SSRF via tool
  args), or shell injection through any tool argument.
- Path traversal out of the SQLite cache directory (`~/.awwwards-mcp/`) —
  e.g. a slug or hash that escapes it when used in file paths.
- Prompt injection via scraped markup — the server injects awwwards.com HTML-
  derived content into agent context, so reports on how scraped content could
  carry hidden instructions to a consuming agent are in scope.
- Supply-chain: a dependency adding install scripts or unexpected network
  calls.

Not in scope: rate-limit annoyance against awwwards.com itself (the 1 req/s
limiter is a politeness feature, not a security boundary), and "the tool
returned emoji" style data-quality bugs — those are regular issues.
