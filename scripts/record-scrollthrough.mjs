// Record a motion-through video of a live site so motion is visible to
// agents — static captures hide it. Covers THREE animation classes:
//   1. preloader / entrance animations (initial dwell)
//   2. scroll-triggered animations (slow stepped scroll)
//   3. hover + click animations (a virtual cursor visits interactive
//      elements and dwells on each so :hover transitions play on camera;
//      safe same-page targets are clicked for click effects)
// Playwright's recorded video does NOT render the real cursor, so a virtual
// cursor element is injected and moved alongside page.mouse.
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

// Virtual cursor (video doesn't show the real one) — follows page.mouse.
await page.evaluate(() => {
  const cur = document.createElement('div');
  cur.id = '__recorder_cursor';
  cur.style.cssText =
    'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;' +
    'pointer-events:none;transform:translate(-2px,-2px);transition:transform .12s ease;' +
    'filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));';
  cur.innerHTML =
    '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M4 2l14 8-6 1.2L15 18l-2.6 1.2L9.6 12 5 16z" ' +
    'fill="#fff" stroke="#111" stroke-width="1.4"/></svg>';
  document.body.appendChild(cur);
});
const moveCursor = async (x, y) => {
  await page.mouse.move(x, y, { steps: 12 });
  await page.evaluate(([x, y]) => {
    document.getElementById('__recorder_cursor')?.style.setProperty('transform', `translate(${x - 2}px,${y - 2}px)`);
  }, [x, y]);
};

// Slow scroll down so every scroll-triggered animation fires on camera
const totalHeight = await page.evaluate(() => document.body.scrollHeight);
for (let y = 0; y < totalHeight; y += 450) {
  await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y);
  await page.waitForTimeout(600);
}
// Let the bottom section finish animating
await page.waitForTimeout(2500);

// ---- Interaction pass: hover + click animations on camera ----
// Target discovery works on ANY site's markup: classic interactive selectors
// PLUS anything whose computed cursor is "pointer" — the browser's own
// "I'm interactive" signal. Pointer cursor inherits to descendants, so only
// elements whose PARENT is not pointer count (the top of each pointer region)
// — otherwise one `body { cursor: pointer }` would nominate the whole page.
const targets = await page.evaluate(() => {
  const isVisibleBox = (r) => r.width >= 24 && r.height >= 16;
  const abs = (r) => Math.round(r.top + window.scrollY);
  const out = [];
  const seen = new Set();
  const push = (el) => {
    const r = el.getBoundingClientRect();
    if (!isVisibleBox(r)) return;
    const top = abs(r);
    if (top < 0 || top > document.body.scrollHeight) return;
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(top + r.height / 2);
    const key = `${cx},${cy}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      x: cx,
      y: cy,
      safeClick:
        (el.tagName === 'A' && (!el.getAttribute('href') || el.getAttribute('href').startsWith('#'))) ||
        (el.tagName === 'BUTTON' && el.type !== 'submit'),
    });
  };
  // Pass 1: classic interactive selectors (always trusted).
  for (const el of document.querySelectorAll('a, button, [role="button"], input, .oval-btn, .btn')) {
    push(el);
  }
  // Pass 2: cursor:pointer discovery — custom interactive surfaces with
  // unknown markup. Skip the pointer region's top (compare against parent).
  let visited = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (++visited > 3000 || out.length > 200) break;
    const style = getComputedStyle(el);
    if (style.cursor !== 'pointer') continue;
    const parent = el.parentElement;
    if (parent && getComputedStyle(parent).cursor === 'pointer') continue; // inherited
    push(el);
  }
  // Spread the tour evenly down the page (top to bottom), not DOM order.
  out.sort((a, b) => a.y - b.y);
  const keep = Math.min(16, out.length);
  const spread = [];
  for (let i = 0; i < keep; i++) {
    spread.push(out[Math.round((i * (out.length - 1)) / Math.max(1, keep - 1))]);
  }
  return spread;
});

let clicked = 0;
for (const t of targets) {
  try {
    // Bring the element into view, then hover: move the real mouse so
    // :hover transitions fire, with the virtual cursor following it.
    await page.evaluate((y) => window.scrollTo({ top: Math.max(0, y - 380), behavior: 'instant' }), t.y);
    await page.waitForTimeout(250);
    const box = await page.evaluate(([x, absY]) => {
      const el = document.elementFromPoint(x, absY - window.scrollY);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, [t.x, t.y]);
    if (!box) continue;
    await moveCursor(box.x, box.y);
    await page.waitForTimeout(750); // let the hover transition play
    if (t.safeClick && clicked < 4) {
      await page.mouse.down(); await page.mouse.up(); // :active + click effects
      clicked++;
      await page.waitForTimeout(650); // let the click animation play
    }
  } catch {
    // detached/overlaid element — skip and continue the tour
  }
}

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
console.log(`Saved ${outDir}/${outName} (${totalHeight}px page height, ${targets.length} hover targets, ${clicked} clicks)`);
