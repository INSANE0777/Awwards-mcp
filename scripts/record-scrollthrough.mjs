// Record a scroll-through video of a live site so motion (preloader,
// scroll-triggered animations) is visible to agents — static captures hide it.
// Run from A:\AWWARDS MCP so `import('playwright')` resolves.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { renameSync } from 'fs';

const url = process.argv[2] ?? 'https://cerebrium.ai';
const outDir = process.argv[3] ?? 'C:/Users/Afjal/ZCodeProject/_qa';
const outName = process.argv[4] ?? 'reference-scrollthrough.webm';

mkdirSync(outDir, { recursive: true });
const tmpDir = outDir + '/.video-tmp';
mkdirSync(tmpDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: tmpDir, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();

await page.goto(url, { waitUntil: 'load', timeout: 60000 });
// Preloader + entrance animations
await page.waitForTimeout(7000);

// Slow scroll down so every scroll-triggered animation fires on camera
const totalHeight = await page.evaluate(() => document.body.scrollHeight);
for (let y = 0; y < totalHeight; y += 450) {
  await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y);
  await page.waitForTimeout(600);
}
// Let the bottom section finish animating
await page.waitForTimeout(2500);
// Return to top so the video ends where it started
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
await page.waitForTimeout(1500);

await context.close(); // flushes the video file
await browser.close();

const video = await (async () => {
  const { readdirSync } = await import('fs');
  return readdirSync(tmpDir).find((f) => f.endsWith('.webm'));
})();
renameSync(`${tmpDir}/${video}`, `${outDir}/${outName}`);
console.log(`Saved ${outDir}/${outName} (${totalHeight}px page height)`);
