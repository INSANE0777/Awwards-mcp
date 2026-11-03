import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { captureComponent } from "../src/component.js";

// Real-Chromium smoke: one bounded captureComponent run against a local
// fixture. No Awwwards calls, no external network. Locally it is skipped when
// Playwright's Chromium is not installed; CI sets AWWWARDS_CHROMIUM_SMOKE=1 on
// the browser entries, where a missing browser must fail instead of skip.
function chromiumInstalled(): boolean {
  try {
    const { chromium } = createRequire(import.meta.url)("playwright");
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const REQUIRED = process.env.AWWWARDS_CHROMIUM_SMOKE === "1";
const INSTALLED = chromiumInstalled();

const FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><title>component fixture</title>
<style>
  body { margin: 0; font-family: Arial, sans-serif; }
  #hero { display: flex; gap: 8px; padding: 16px; background-color: rgb(12, 34, 56); }
  #hero::before { content: ""; width: 4px; background: rgb(255, 0, 0); }
  h1 { font-size: 32px; margin: 0; color: rgb(240, 240, 240); }
</style></head>
<body><main><section id="hero"><h1>Fixture</h1><p>Bounded smoke</p></section></main></body></html>`;

let server: Server | undefined;
let url = "";

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FIXTURE);
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  const s = server;
  if (!s) return;
  server = undefined;
  s.closeAllConnections();
  await new Promise<void>((resolve) => s.close(() => resolve()));
});

describe.skipIf(!INSTALLED && !REQUIRED)("captureComponent (real Chromium)", () => {
  it(
    "serializes the fixture subtree within the time budget",
    async () => {
      if (!INSTALLED) {
        throw new Error(
          "AWWWARDS_CHROMIUM_SMOKE=1 but Playwright's Chromium is missing: npx playwright install chromium",
        );
      }
      const started = Date.now();
      const pack = await captureComponent(url, { selector: "#hero", timeoutMs: 20_000 });
      const elapsed = Date.now() - started;

      expect(pack).not.toHaveProperty("error");
      if ("error" in pack) return; // narrows the union for the assertions below
      expect(pack.id).toBe("component-pack-v1");
      expect(pack.selector).toBe("#hero");
      expect(pack.viewport).toEqual({ width: 1440, height: 900 });
      expect(pack.root.tag).toBe("section");
      expect(pack.nodeCount).toBeGreaterThanOrEqual(3);
      expect(pack.root.styles["backgroundColor"]).toBe("rgb(12, 34, 56)");
      expect(pack.colors).toContain("rgb(12, 34, 56)");
      expect(pack.root.children.map((child) => child.tag)).toEqual(
        expect.arrayContaining(["h1", "p"]),
      );
      // A passing run stays well inside the 30 s budget (measured ~6 s); the
      // 30 s test timeout is what catches a hung browser launch.
      expect(elapsed).toBeLessThan(28_000);
    },
    30_000,
  );
});
