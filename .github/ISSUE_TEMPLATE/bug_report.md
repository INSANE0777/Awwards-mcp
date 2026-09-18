---
name: Bug report
about: A tool returned wrong data, a parser broke against live markup, something crashed
title: "[bug] "
labels: bug
assignees: ""
---

**Which tool / command**

e.g. `search_sites`, `get_site_details`, `awwwards-index`, or "any tool".

**What happened**

A concise description of the wrong behavior.

**What you expected**

**How to reproduce**

Steps or the exact args that trigger it:

```
{ "tool": "search_sites", "args": { ... } }
```

**Environment**

- OS: (e.g. Windows 11, macOS 15, Ubuntu 24.04)
- Node: (`node -v`)
- Installed via: `npx awwwards-mcp` / `npm install awwwards-mcp` / repo checkout
- Indexed: did you run `awwwards-index`? (yes/no)

**Extra context**

If a parser looks wrong against live awwwards.com, a saved HTML snapshot of
the affected page (Save Page As → HTML only) attached to the issue makes the
fix dramatically faster — the project tests against committed fixtures, and
your snapshot becomes the new fixture.
