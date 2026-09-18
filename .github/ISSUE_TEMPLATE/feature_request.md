---
name: Feature request
about: Suggest a new tool, filter, or output format
title: "[feature] "
labels: enhancement
assignees: ""
---

**The problem it solves**

What are you trying to do with the agent that awwwards-mcp can't help with
today? Concrete agent workflows beat abstract ideas.

**Proposed shape**

If it's a new tool: name, args (zod-style), and what it returns. If it's a
filter/search change: example queries that should work after the change.

**Constraints to keep in mind**

- Politeness: 1 req/s to awwwards.com, robots.txt-compliant paths only,
  one filter per URL (deep pagination is disallowed).
- Runtime deps must stay light: MCP SDK + zod; `node:sqlite`; playwright
  and ffmpeg stay optional.
- Features get fixture-backed offline tests like everything else.

**Are you willing to build it?**

The best feature requests come with a PR — say so and see CONTRIBUTING.md.
