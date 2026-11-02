import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Documentation guard: browser tools import playwright/ffmpeg-static from the
// package's install location, so `npx` alone cannot support them. The README
// must keep saying so, or users will file "playwright missing" bugs forever.
const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const DEV = readFileSync(new URL("../README.dev.md", import.meta.url), "utf8");
const PKG = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };
const flatten = (text: string) => text.replace(/\s+/g, " ");

describe("install documentation", () => {
  it("README warns that npx is the core no-browser path", () => {
    expect(flatten(README)).toContain("is the core, no-browser path");
    expect(flatten(README)).toContain("isolated cache that does not contain Playwright");
  });

  it("README documents the global side-by-side browser install", () => {
    expect(README).toContain("npm install -g awwwards-mcp playwright ffmpeg-static");
    expect(README).toContain("npm exec --global -- playwright install chromium");
    expect(flatten(README)).toContain('"command": "awwwards-mcp"');
    expect(flatten(README)).toContain("not `npx`");
    expect(flatten(README)).not.toContain("npm install -g playwright && npx playwright install chromium");
  });

  it("README walkthrough includes restart, a verification call and the built smoke", () => {
    const text = flatten(README);
    expect(text).toContain("Restart the MCP server");
    expect(text).toContain(
      '{ "name": "analyze_page_structure", "arguments": { "url": "https://example.com" } }',
    );
    expect(text).toContain("npm run build && npm run smoke:browser");
    expect(text).toContain("127.0.0.1");
    expect(text).toContain("browser-smoke: pack + global install");
    expect(text).toContain("browser-smoke: connected to awwwards-mcp, 39 tools");
    expect(text).toContain("browser-smoke: analyze_page_structure -> 4 bands");
    expect(text).toContain("browser-smoke: capture_live_site -> image/png");
    expect(text).toContain("browser-smoke: PASS");

    expect(PKG.scripts?.["smoke:browser"]).toBe("node scripts/browser-smoke.mjs");
    expect(existsSync(new URL("../scripts/browser-smoke.mjs", import.meta.url))).toBe(true);
  });

  it("README documents the element, verify_build, v2 and directory limits", () => {
    const text = flatten(README);
    expect(text).toContain("element corpus is partial after the gallery-crawl retirement");
    expect(text).toContain('category: "uncategorized"');
    expect(text).toContain("free-text `query`");
    expect(text).toContain("`verify_build` scores structure and motion, not visual fidelity");
    expect(text).toContain("default 40, smallest bands merged");
    expect(text).toContain("landmark splitting can then add sub-bands up to its own limit of 60");
    expect(text).toContain("Capture timing can move the score");
    expect(text).toContain("`v2` is opt-in, not the default and not a 2.0 release");
    expect(text).toContain("manual post-release admin step");
  });

  it("README.dev documents the supported layout and the entry guard", () => {
    expect(flatten(DEV)).toContain("global side-by-side install");
    expect(flatten(DEV)).toContain("isCliEntry");
    expect(flatten(DEV)).toContain("exits 0 silently");
  });
});
