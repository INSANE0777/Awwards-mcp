import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { buildPoseStubHtml } from "../src/pose-stub.js";
import type { PoseGrid } from "../src/pose3d.js";

// Real-browser regression for the generated stub: HTML substring checks cannot
// prove that anything reached the canvas. Chromium loads the page, decodes a
// real PNG, and screenshots before/after a scroll update.
//
// Skip cleanly when Chromium is not installed locally; AWWWARDS_CHROMIUM_SMOKE=1
// turns a missing browser into a failure (CI gate).
const REQUIRED = process.env.AWWWARDS_CHROMIUM_SMOKE === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

// Serve the exact pinned packages from node_modules, so the regression is the
// same three/gsap code the stub pins and never touches the network.
function serveNodeModule(route: any, prefix: string, pkg: string): Promise<void> {
  const rel = new URL(route.request().url()).pathname.slice(prefix.length);
  const file = join(ROOT, "node_modules", pkg, rel);
  if (!existsSync(file)) {
    return route.fulfill({ status: 404, contentType: "text/plain", body: "missing" });
  }
  return route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: readFileSync(file),
  });
}

// 16x16 quadrant PNG (yellow/cyan/magenta/blue) generated once; PNG, not a fake
// data URL, so Chromium has to decode it.
const QUADRANT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR4nGP4/5/hPz6MXxaMRw0YDgYQMp6BAT8eNWA4GAAA+ql9nwbX3w8AAAAASUVORK5CYII=";

let chromium: typeof import("playwright").chromium | null = null;
let browser: Browser | null = null;
let unavailable = "";
try {
  ({ chromium } = await import("playwright"));
  browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
} catch (err) {
  unavailable = err instanceof Error ? err.message : String(err);
}

afterAll(async () => {
  if (browser) await browser.close();
}, 120_000);

function grid(): PoseGrid {
  return {
    id: "pose-grid-v1",
    // Hostile evidence string: it must land as text, never as executable script.
    url: 'https://example.com/"><script>window.__posePwned = 1</script>',
    capturedAt: 0,
    steps: 6,
    canvasSelector: "#scene",
    canvasW: 1920,
    canvasH: 1080,
    viewport: { width: 1280, height: 720 },
    // Same frame at every step so the only pixel change after scrolling is the
    // synthesized camera move, not a different snapshot image.
    snapshots: Array.from({ length: 6 }, (_, i) => ({
      step: i,
      scrollY: i * 200,
      scrollRatio: i / 5,
      frames: [{ label: "canvas", dataUrlPng: QUADRANT_PNG }],
    })),
  };
}

type Pixels = { nonBg: number; saturated: number; hash: number; colorHash: number; width: number; height: number };

// Decode the screenshot in Chromium (2D canvas), not in Node: no image library,
// and it proves the PNG we captured is actually decodable.
async function pixelStats(page: Page, png: Buffer): Promise<Pixels> {
  return page.evaluate(async (b64) => {
    const blob = await (await fetch("data:image/png;base64," + b64)).blob();
    const bitmap = await createImageBitmap(blob);
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = surface.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let nonBg = 0;
    let saturated = 0;
    let hash = 2166136261;
    let colorHash = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      // Page background is #0b0d12; count anything meaningfully different.
      if (Math.abs(r - 11) + Math.abs(g - 13) + Math.abs(b - 18) > 24) nonBg++;
      // The texture quadrants are fully saturated; the background, scrollbar
      // and anti-aliased chrome are grey, so this counts actual 3D content.
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max > 180 && max - min > 100) {
        saturated++;
        colorHash = Math.imul(colorHash ^ (i | (r << 24) | (g << 16) | (b << 8)), 16777619);
      }
      hash = Math.imul(hash ^ ((r << 16) | (g << 8) | b), 16777619);
    }
    return {
      nonBg,
      saturated,
      hash: hash >>> 0,
      colorHash: colorHash >>> 0,
      width: bitmap.width,
      height: bitmap.height,
    };
  }, png.toString("base64"));
}

async function shot(page: Page): Promise<{ png: Buffer; pixels: Pixels }> {
  const png = await page.screenshot();
  return { png, pixels: await pixelStats(page, png) };
}

async function waitForVisible(page: Page, errors: string[]): Promise<{ png: Buffer; pixels: Pixels }> {
  const deadline = Date.now() + 20_000;
  let last: { png: Buffer; pixels: Pixels } | null = null;
  while (Date.now() < deadline) {
    last = await shot(page);
    if (last.pixels.saturated > 1000) return last;
    await page.waitForTimeout(150);
  }
  const detail = errors.length ? `\npage errors:\n${errors.join("\n")}` : "";
  throw new Error(
    `pose stub never painted the captured texture (last saturated=${last?.pixels.saturated ?? 0})${detail}`,
  );
}

if (!browser && REQUIRED) {
  describe("pose stub Chromium rendering", () => {
    it("launches Chromium", () => {
      throw new Error(
        `AWWWARDS_CHROMIUM_SMOKE=1 but Chromium is unavailable: ${unavailable || "playwright missing"}\n` +
          "Install it with: npm exec -- playwright install chromium",
      );
    });
  });
} else {
  const suite = browser ? describe : describe.skip;
  suite("pose stub Chromium rendering", () => {
    it(
      "renders visible pixels, then changes them after a scroll update",
      { timeout: 60_000 },
      async () => {
        const page = await browser!.newPage({ viewport: { width: 1280, height: 720 } });
        const errors: string[] = [];
        page.on("pageerror", (err) => errors.push(err.message));
        page.on("console", (msg) => {
          if (msg.type() === "error") errors.push(msg.text());
        });
        try {
          // The stub imports three/gsap from unpkg. Serve the pinned local
          // packages so the regression runs the real renderer and never
          // depends on the network.
          await page.route("https://unpkg.com/three@0.160.0/**", (route) =>
            serveNodeModule(route, "/three@0.160.0/", "three"),
          );
          await page.route("https://unpkg.com/gsap@3.12.5/**", (route) =>
            serveNodeModule(route, "/gsap@3.12.5/", "gsap"),
          );
          await page.goto("data:text/html;charset=utf-8," + encodeURIComponent(buildPoseStubHtml(grid())), {
            waitUntil: "load",
            timeout: 30_000,
          });
          const before = await waitForVisible(page, errors);
          expect(before.pixels.nonBg).toBeGreaterThan(1000);
          expect(before.pixels.saturated).toBeGreaterThan(1000);
          // Evidence strings are text, not executed script.
          expect(await page.evaluate(() => (window as any).__posePwned)).toBeUndefined();

          await page.evaluate(() => {
            const max = document.documentElement.scrollHeight - window.innerHeight;
            window.scrollTo(0, Math.round(max * 0.6));
          });
          await page.waitForTimeout(600);
          const after = await shot(page);
          expect(after.pixels.nonBg).toBeGreaterThan(1000);
          expect(after.pixels.saturated).toBeGreaterThan(1000);
          // Compare only saturated (texture) pixels: a moving scrollbar cannot
          // make this pass.
          expect(after.pixels.colorHash).not.toBe(before.pixels.colorHash);
          expect(after.pixels.hash).not.toBe(before.pixels.hash);

          // Resize must update the drawing buffer and repaint, not leave a
          // stale/blank canvas.
          await page.setViewportSize({ width: 800, height: 600 });
          await page.waitForTimeout(400);
          const resized = await shot(page);
          expect(await page.evaluate(() => (document.getElementById("pose-canvas") as HTMLCanvasElement).width)).toBe(800);
          expect(resized.pixels.nonBg).toBeGreaterThan(500);
          expect(errors, errors.join("\n")).toEqual([]);
        } finally {
          await page.close();
        }
      },
    );
  });
}
