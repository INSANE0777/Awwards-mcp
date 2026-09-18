import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
// preScroll lives in structure.ts so there is ONE scroll-through loop for
// both tools; this is an intentional circular import (structure.ts imports
// CAPTURE_INSTALL_HINT from here) — both sides only use the other's bindings
// at call time, which ESM resolves fine.
import { preScroll, type WaitOpts, type WaitStrategy } from "./structure.js";
import { resolveViewport } from "./viewport.js";

export const CAPTURE_INSTALL_HINT =
  "Full-page capture needs Playwright, which is an optional dependency.\n" +
  "Install it with:  npm install -D playwright && npx playwright install chromium\n" +
  "Then retry the capture or structure tool.";

type CaptureResult = { file: string; base64: string } | { error: string };

export async function captureLiveSite(
  url: string,
  imagesDir: string,
  // "as string" keeps Playwright an unresolved optional dependency at compile time;
  // Node resolves it (and may throw) at runtime, which the try/catch below handles.
  loader: () => Promise<any> = () => import("playwright" as string),
  opts?: WaitOpts,
): Promise<CaptureResult> {
  let chromium: any;
  try {
    ({ chromium } = await loader());
  } catch {
    return { error: CAPTURE_INSTALL_HINT };
  }
  let browser: any;
  try {
    browser = await chromium.launch();
  } catch {
    return { error: CAPTURE_INSTALL_HINT };
  }
  try {
    const waitStrategy: WaitStrategy = opts?.waitStrategy ?? "load";
    // Same viewport-profile split as analyzePageStructure (structure.ts):
    // width/height fill the `viewport` key, mobile-profile flags spread in as
    // sibling context options. Desktop resolves to no extra fields, so the
    // default call shape is unchanged.
    const { width, height, ...contextOpts } = resolveViewport(opts?.viewport);
    const page = await browser.newPage({ viewport: { width, height }, ...contextOpts });
    await page.goto(url, { waitUntil: waitStrategy, timeout: 45_000 });
    // "load" can fire before late XHRs settle, so give the page a fixed
    // settle window; networkidle already means the network went quiet.
    if (waitStrategy === "load") await page.waitForTimeout(3000);
    await preScroll(page);
    const file = join(
      imagesDir,
      "capture-" + createHash("sha1").update(url).digest("hex").slice(0, 12) + ".png",
    );
    await page.screenshot({ path: file, fullPage: true });
    return { file, base64: (await readFile(file)).toString("base64") };
  } finally {
    try {
      await browser.close();
    } catch {
      /* keep the primary error */
    }
  }
}
