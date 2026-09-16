import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const CAPTURE_INSTALL_HINT =
  "Full-page capture needs Playwright, which is an optional dependency.\n" +
  "Install it with:  npm install -D playwright && npx playwright install chromium\n" +
  "Then retry capture_live_site.";

type CaptureResult = { file: string; base64: string } | { error: string };

export async function captureLiveSite(
  url: string,
  imagesDir: string,
  // "as string" keeps Playwright an unresolved optional dependency at compile time;
  // Node resolves it (and may throw) at runtime, which the try/catch below handles.
  loader: () => Promise<any> = () => import("playwright" as string),
): Promise<CaptureResult> {
  let chromium: any;
  try {
    ({ chromium } = await loader());
  } catch {
    return { error: CAPTURE_INSTALL_HINT };
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    const file = join(
      imagesDir,
      "capture-" + createHash("sha1").update(url).digest("hex").slice(0, 12) + ".png",
    );
    await page.screenshot({ path: file, fullPage: true });
    return { file, base64: (await readFile(file)).toString("base64") };
  } finally {
    await browser.close();
  }
}
