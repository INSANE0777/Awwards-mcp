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
| `list_categories` | Every filter the agent can search by (200+ tags, 27 colors). |
| `capture_live_site` | Optional: fresh full-page screenshot of any live URL (needs [playwright](https://playwright.dev)). |

## Setup

**Claude Code**

```bash
claude mcp add awwwards -- npx -y awwwards-mcp
```

**Claude Desktop / Cursor / Windsurf** (`mcpServers` in the config):

```json
{
  "mcpServers": {
    "awwwards": { "command": "npx", "args": ["-y", "awwwards-mcp"] }
  }
}
```

Optional full-page captures:

```bash
npm install -g playwright && npx playwright install chromium
```

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

## Development

```bash
npm install
npm test        # offline unit tests against committed HTML fixtures
npm run smoke   # manual live smoke test against awwwards.com
npm run build   # compile to dist/
```

MIT — see [LICENSE](LICENSE).
