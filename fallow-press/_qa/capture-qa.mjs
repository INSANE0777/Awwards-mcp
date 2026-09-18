// QA captures for fallow-press.
// home: full-page with pre-scroll (reveals fired).
// projects/about: pinned horizontal pages — capture viewport shots at several
//   pin progress points instead of naive fullPage (pin spacers distort it).
import { chromium } from 'playwright';

const base = 'file:///A:/AWWARDS MCP/fallow-press/';
const out = base.replace('file:///', '').replace(/\//g, '/') ;
const qa = 'A:/AWWARDS MCP/fallow-press/_qa';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

async function settleAndCaptureHome() {
  await page.goto(base + 'index.html', { waitUntil: 'load' });
  await page.waitForTimeout(2800); // hero entrance done
  const h = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < h; y += 420) {
    await page.evaluate((t) => window.scrollTo(0, t), y);
    await page.waitForTimeout(130);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(700);
  await page.screenshot({ path: qa + '/home-full.png', fullPage: true });
  console.log('Saved', qa + '/home-full.png', '— height', h);
}

async function captureHorizontal(file, name) {
  await page.goto(base + file, { waitUntil: 'load' });
  await page.waitForTimeout(2600); // fonts + tracks settle
  const pin = await page.evaluate(() => {
    const st = document.querySelector('.hgallery');
    return { scrollH: document.body.scrollHeight };
  });
  // pin range = scrollHeight - 100vh; panel count = (scrollH / 100vw) + 1 panels →
  // stop at each panel's CENTER so every panel is verified with copy visible.
  const panels = await page.evaluate(() => document.querySelectorAll('.panel, .chapter').length);
  const tip = pin.scrollH - 900;
  const frac = (n) => Math.min(tip, tip * (n / (panels - 1)));
  const stops = [0, frac(0.5), frac(1), frac(1.5), frac(2), frac(2.5), frac(3), frac(3.5), frac(4), frac(4.5), frac(5), frac(5.5), frac(6)];
  for (let i = 0; i < stops.length; i++) {
    await page.evaluate((t) => window.scrollTo(0, t), Math.round(stops[i]));
    await page.waitForTimeout(450); // scrub catch-up (scrub: 1)
    await page.screenshot({ path: `${qa}/${name}-pin-${(stops[i] / tip).toFixed(2)}.png` });
  }
  console.log('Saved', name, 'pin shots ×', stops.length, '— pin range', tip, 'panels', panels);
}

await settleAndCaptureHome();
await captureHorizontal('projects.html', 'home-fields');
await captureHorizontal('about.html', 'home-practices');

await browser.close();
console.log('All QA captures done.');
