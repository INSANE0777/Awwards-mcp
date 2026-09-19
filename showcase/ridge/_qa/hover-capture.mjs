// Hover-capture: record a slow mouse pass over a target region so mousemove-
// driven effects (dither dissolves, spotlights) land on camera. The standard
// recorder only dwells on cursor:pointer elements — this one sweeps a region.
// Usage: node hover-capture.mjs <url> <outDir> <name> <x1%,y1%> <x2%,y2%>
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const [url, outDir, name, from = '60,25', to = '92,48'] = process.argv.slice(2);
mkdirSync(outDir + '/.video-tmp', { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: outDir + '/.video-tmp', size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(4000); // intro/entrance done

const [x1p, y1p] = from.split(',').map(Number);
const [x2p, y2p] = to.split(',').map(Number);
// slow serpentine sweep across the region so the effect trails on camera
for (let row = 0; row < 6; row++) {
  const y = 900 * (y1p + ((y2p - y1p) * row) / 5) / 100;
  const [xa, xb] = row % 2 === 0 ? [x1p, x2p] : [x2p, x1p];
  for (let step = 0; step <= 20; step++) {
    const x = 1440 * (xa + ((xb - xa) * step) / 20) / 100;
    await page.mouse.move(x, y, { steps: 4 });
    await page.waitForTimeout(60);
  }
}
await page.waitForTimeout(800);
const video = page.video();
await context.close();
const saved = await video.path();
import { renameSync } from 'fs';
renameSync(saved, `${outDir}/${name}.webm`);
console.log('saved', `${outDir}/${name}.webm`);
await browser.close();
