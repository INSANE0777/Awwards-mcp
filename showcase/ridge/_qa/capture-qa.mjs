// RIDGE QA — dual-viewport captures, overflow audit, pin-center shots.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const base = 'file:///A:/AWWARDS MCP/showcase/ridge/';
const qa = 'A:/AWWARDS MCP/showcase/ridge/_qa';
mkdirSync(qa, { recursive: true });

const browser = await chromium.launch();

async function auditOverflow(page, label) {
  const over = await page.evaluate(() => {
    const bad = [];
    if (document.documentElement.scrollWidth > window.innerWidth) {
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.right > window.innerWidth + 1 && r.width > 8) {
          bad.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} right=${Math.round(r.right)}`);
          if (bad.length >= 4) break;
        }
      }
    }
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, offenders: bad };
  });
  console.log(`[${label}] overflow: ${over.overflow}px`, over.offenders.length ? JSON.stringify(over.offenders) : '(none)');
}

async function fullCapture(label, viewport) {
  const page = await (await browser.newContext({ viewport })).newPage();
  await page.goto(base + 'index.html', { waitUntil: 'load' });
  await page.waitForTimeout(2600);
  const h = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < h; y += 400) { await page.evaluate((t) => window.scrollTo(0, t), y); await page.waitForTimeout(90); }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(700);
  await auditOverflow(page, label);
  await page.screenshot({ path: `${qa}/${label}-full.png`, fullPage: true });
  console.log(`[${label}] full capture, height ${h}`);
  await page.context().close();
  return h;
}

const hD = await fullCapture('desktop', { width: 1440, height: 900 });
const hM = await fullCapture('mobile', { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

// pin-center shots for the horizontal passage (desktop only)
{
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(base + 'index.html', { waitUntil: 'load' });
  await page.waitForTimeout(2600);
  const panels = 4;
  const pinStart = await page.evaluate(() => {
    const w = document.getElementById('hwrap');
    const st = w.getBoundingClientRect().top + window.scrollY;
    return st;
  });
  const total = await page.evaluate(() => document.body.scrollHeight);
  // pin distance ≈ track.scrollWidth - innerWidth; probe via ScrollTrigger state
  const pinDist = await page.evaluate(() => {
    const track = document.getElementById('htrack');
    return track.scrollWidth - window.innerWidth;
  });
  for (let i = 0; i < panels; i++) {
    const y = Math.round(pinStart + (pinDist * i) / (panels - 1));
    await page.evaluate((t) => window.scrollTo(0, t), y);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${qa}/pin-${((i / (panels - 1))).toFixed(2)}.png` });
  }
  console.log('pin shots ×', panels, '— pinStart', Math.round(pinStart), 'pinDist', pinDist, '(page', total + ')');
  await page.context().close();
}

await browser.close();
console.log('RIDGE QA done.');
