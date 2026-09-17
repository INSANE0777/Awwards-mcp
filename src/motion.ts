import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CAPTURE_INSTALL_HINT } from "./capture.js";
// WaitStrategy is shared with capture/structure (leaf-direction import —
// motion → {capture, structure}; the existing capture⇄structure cycle is
// verified safe). The pre-scroll itself is motion-local: boundedPreScroll
// below caps the walk so a huge page cannot blow the recording budget.
import { type WaitStrategy } from "./structure.js";

export const MOTION_FFMPEG_HINT =
  "Motion recording needs ffmpeg-static, which is an optional dependency.\n" +
  "Install it with:  npm install -D ffmpeg-static\n" +
  "Then retry record_site_motion.";

export type MotionResult =
  | { file: string; base64: string; frames: number }
  | { error: string };

export interface MotionOpts {
  cacheImagesDir: string;
  // Injects the playwright module (tests pass a fake; the default dynamically
  // imports "playwright" so it stays an unresolved optional dependency at
  // compile time and is handled at runtime).
  loader?: () => Promise<any>;
  // Explicit ffmpeg binary path; null short-circuits to MOTION_FFMPEG_HINT.
  // Default: dynamic import("ffmpeg-static")'s default-export binary path.
  ffmpegPath?: string | null;
  // Filmstrip tile count — grid is ceil(sqrt(n)) x ceil(n/cols); default 16 (4x4).
  frames?: number;
  // Injectable ffmpeg invocation for offline tests; default spawns the real
  // binary (runFfmpeg below). Spawn/encode failure → MOTION_FFMPEG_HINT.
  ffmpegFn?: (bin: string, video: string, strip: string, frames: number) => Promise<void>;
  waitStrategy?: WaitStrategy;
}

// Recording-pass timings, tuned against the 30s MCP tool ceiling. The
// validated script (scripts/record-scrollthrough.mjs) spends well past 45s
// (7s dwell, 600ms scroll steps, 750ms hover dwells, 16 targets, 4 clicks),
// so the tool constrains every dial:
//   goto ....................... (network; not budgeted — waitStrategy decides)
//   preloader dwell ............ 5.0s   (script: 7s; also covers the fixed
//                                       "load" settle capture.ts applies —
//                                       one top-of-page wait serves both)
//   lazy-render pre-scroll ...... ≤ ~1s  (bounded 40ms-step pass, back to top:
//                                       the ceiling is min(page height, 450 ×
//                                       24 = 10.8k px, matching the tour cap,
//                                       so the walk can never exceed ~1s — the
//                                       capped tour below still renders lazy
//                                       content on taller pages)
//   stepped scroll tour ........ ~8.4s  (450px steps / 350ms settle, capped at
//                                       MAX_SCROLL_STEPS=24 ≈ 10.8k px of page
//                                       height so tall pages cannot blow the
//                                       budget)
//   interaction pass ........... ~14s   (≤12 targets × [250ms into-view settle
//                                       + cursor move + 500ms hover dwell]
//                                       ≈ 10.2s, ≤3 safe clicks × 650ms ≈ 2s,
//                                       1.5s return-to-top)
// Recording worst case ≈ 28s, then context.close() flush + the ffmpeg strip
// pass ≈ 1–2s — inside the 30s ceiling.
const DWELL_MS = 5000;
const SCROLL_STEP = 450;
const SCROLL_SETTLE_MS = 350;
const MAX_SCROLL_STEPS = 24;
const SCROLL_INTO_VIEW_SETTLE_MS = 250;
const HOVER_DWELL_MS = 500;
const CLICK_SETTLE_MS = 650;
const MAX_HOVER_TARGETS = 12;
const MAX_CLICKS = 3;
const TOP_RETURN_MS = 1500;

// Default ffmpeg invocation: tile the recorded video into one filmstrip JPEG
// (a frame every 4s, 720px wide, cols x rows grid, single output frame).
// Exported for direct testing; callers inject ffmpegFn to replace it.
const FFMPEG_TIMEOUT_MS = 60_000;

export async function runFfmpeg(
  bin: string,
  video: string,
  strip: string,
  frames: number,
): Promise<void> {
  const cols = Math.ceil(Math.sqrt(frames));
  const rows = Math.ceil(frames / cols);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      bin,
      ["-y", "-i", video, "-vf", `fps=1/4,scale=720:-1,tile=${cols}x${rows}`, "-frames:v", "1", strip],
      { stdio: "ignore", windowsHide: true },
    );
    // Deadline: a hung ffmpeg (wedged pipe, dead filesystem) must not hang the
    // tool call forever — kill the child and reject so the caller gets the
    // install-hint error path.
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS / 1000}s`));
    }, FFMPEG_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err); // spawn failure (missing binary, ...)
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

// Lazy-render pre-scroll for the motion pass. Same loop shape as structure.ts's
// preScroll, but bounded: the walk ceiling is min(page height, 450 × 24 = 10.8k
// px, matching MAX_SCROLL_STEPS) so a 50k-px page costs ≤ ~1s instead of ~4.5s
// — the capped scroll tour below still renders lazy content on taller pages.
async function boundedPreScroll(page: any): Promise<void> {
  await page.evaluate(async () => {
    const g = globalThis as any;
    const ceiling = Math.min(g.document.documentElement.scrollHeight, 450 * 24);
    const step = 450;
    for (let y = 0; y < ceiling; y += step) {
      g.window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    g.window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 150));
  });
}

// Record a motion-through video of a live site so motion is visible to agents
// — static captures hide it. Ported from scripts/record-scrollthrough.mjs and
// structured like capture.ts (injectable loader, in-band install hints,
// runtime errors propagate to the handler). Covers three animation classes:
//   1. preloader / entrance animations (initial dwell)
//   2. scroll-triggered animations (slow stepped scroll tour)
//   3. hover + click animations (a virtual cursor — Playwright's video does
//      not render the real one — visits interactive elements and dwells so
//      :hover transitions play on camera; safe same-page targets are clicked)
// Returns the renamed .webm path plus the filmstrip JPEG inline as base64.
export async function recordSiteMotion(url: string, opts: MotionOpts): Promise<MotionResult> {
  // Resolve ffmpeg first: it is the cheap check and a missing binary must not
  // pay for a browser launch. An explicit ffmpegPath: null short-circuits too.
  let ffmpegBin: string | null = null;
  if (opts.ffmpegPath !== undefined) {
    ffmpegBin = opts.ffmpegPath;
  } else {
    try {
      // "as string" keeps ffmpeg-static an unresolved optional dependency at
      // compile time; Node resolves it (and may throw) at runtime.
      const mod: any = await import("ffmpeg-static" as string);
      ffmpegBin = mod?.default ?? mod;
    } catch {
      return { error: MOTION_FFMPEG_HINT };
    }
  }
  if (!ffmpegBin) return { error: MOTION_FFMPEG_HINT };

  let chromium: any;
  try {
    ({ chromium } = await (opts.loader ?? (() => import("playwright" as string)))());
  } catch {
    return { error: CAPTURE_INSTALL_HINT };
  }
  let browser: any;
  try {
    browser = await chromium.launch();
  } catch {
    return { error: CAPTURE_INSTALL_HINT };
  }

  const frames = opts.frames ?? 16;
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 10);
  const videoPath = join(opts.cacheImagesDir, `motion-${hash}.webm`);
  const stripPath = join(opts.cacheImagesDir, `motion-${hash}-strip.jpg`);
  // Per-call tmp isolation: each run records into its own mkdtemp dir, so a
  // stale partial video from a crashed run (e.g. goto timeout → context.close()
  // still flushes a partial .webm) or a concurrent run's video can never be
  // globbed and filmed under this URL's hash.
  mkdirSync(opts.cacheImagesDir, { recursive: true });
  const videoTmp = mkdtempSync(join(opts.cacheImagesDir, ".video-tmp-"));

  const waitStrategy: WaitStrategy = opts.waitStrategy ?? "load";
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      recordVideo: { dir: videoTmp, size: { width: 1440, height: 900 } },
    });
    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: waitStrategy, timeout: 45_000 });
      // Preloader + entrance animations on camera. This top-of-page wait also
      // stands in for capture.ts's fixed 3s "load" settle (see budget above).
      await page.waitForTimeout(DWELL_MS);
      // Pre-render lazy sections so the tour films settled layout (bounded —
      // see boundedPreScroll; a huge page must not burn the budget here).
      await boundedPreScroll(page);

      // Virtual cursor: an SVG arrow injected into the page, moved alongside
      // page.mouse (page.evaluate serializes plain data only, so snippets are
      // self-contained and reach browser globals through globalThis — the
      // Node tsconfig has no DOM lib).
      await page.evaluate(() => {
        const doc = (globalThis as any).document;
        const cur = doc.createElement("div");
        cur.id = "__recorder_cursor";
        cur.style.cssText =
          "position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;" +
          "pointer-events:none;transform:translate(-2px,-2px);transition:transform .12s ease;" +
          "filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));";
        cur.innerHTML =
          '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M4 2l14 8-6 1.2L15 18l-2.6 1.2L9.6 12 5 16z" ' +
          'fill="#fff" stroke="#111" stroke-width="1.4"/></svg>';
        doc.body.appendChild(cur);
      });
      const moveCursor = async (x: number, y: number): Promise<void> => {
        await page.mouse.move(x, y, { steps: 12 });
        await page.evaluate(
          ([mx, my]: number[]) => {
            const cur = (globalThis as any).document.getElementById("__recorder_cursor");
            cur?.style.setProperty("transform", `translate(${mx - 2}px,${my - 2}px)`);
          },
          [x, y],
        );
      };

      // Slow scroll down so every scroll-triggered animation fires on camera.
      const totalHeight: number = await page.evaluate(
        () => Math.round((globalThis as any).document.body.scrollHeight),
      );
      const steps = Math.min(Math.ceil(totalHeight / SCROLL_STEP), MAX_SCROLL_STEPS);
      for (let i = 1; i <= steps; i++) {
        await page.evaluate(
          (top: number) => (globalThis as any).window.scrollTo({ top, behavior: "instant" }),
          i * SCROLL_STEP,
        );
        await page.waitForTimeout(SCROLL_SETTLE_MS);
      }

      // Interaction-pass target discovery (runs IN THE PAGE): classic
      // interactive selectors PLUS anything whose computed cursor is "pointer"
      // — the browser's own "I'm interactive" signal. Pointer cursor inherits
      // to descendants, so only elements whose PARENT is not pointer count
      // (the top of each pointer region); otherwise one `body { cursor:
      // pointer }` would nominate the whole page. The tour then spreads the
      // kept targets evenly down the page (top to bottom), not DOM order.
      const targets: Array<{ x: number; y: number; safeClick: boolean }> = await page.evaluate(
        () => {
          const g = globalThis as any;
          const doc = g.document;
          const isVisibleBox = (r: any): boolean => r.width >= 24 && r.height >= 16;
          const abs = (r: any): number => Math.round(r.top + g.scrollY);
          const out: any[] = [];
          const seen = new Set<string>();
          const push = (el: any): void => {
            const r = el.getBoundingClientRect();
            if (!isVisibleBox(r)) return;
            const top = abs(r);
            if (top < 0 || top > doc.body.scrollHeight) return;
            const cx = Math.round(r.left + r.width / 2);
            const cy = Math.round(top + r.height / 2);
            const key = `${cx},${cy}`;
            if (seen.has(key)) return;
            seen.add(key);
            const href = el.getAttribute ? el.getAttribute("href") : null;
            out.push({
              x: cx,
              y: cy,
              safeClick:
                (el.tagName === "A" && (!href || String(href).startsWith("#"))) ||
                (el.tagName === "BUTTON" && el.type !== "submit"),
            });
          };
          // Pass 1: classic interactive selectors (always trusted).
          for (const el of doc.querySelectorAll('a, button, [role="button"], input, .oval-btn, .btn')) {
            push(el);
          }
          // Pass 2: cursor:pointer discovery — custom interactive surfaces
          // with unknown markup. Skip the pointer region's top (compare
          // against the parent). Bounded by ITERATIONS only (the 3k-element
          // walk below); no pool cap — dedupe plus the 16-target spread at
          // the end bound the output anyway, and an out.length cap here would
          // silently disable pointer discovery on link-dense pages.
          let visited = 0;
          for (const el of doc.querySelectorAll("body *")) {
            if (++visited > 3000) break;
            if (g.getComputedStyle(el).cursor !== "pointer") continue;
            const parent = el.parentElement;
            if (parent && g.getComputedStyle(parent).cursor === "pointer") continue; // inherited
            push(el);
          }
          out.sort((a: any, b: any) => a.y - b.y);
          const keep = Math.min(MAX_HOVER_TARGETS, out.length);
          const spread: any[] = [];
          for (let i = 0; i < keep; i++) {
            spread.push(out[Math.round((i * (out.length - 1)) / Math.max(1, keep - 1))]);
          }
          return spread;
        },
      );

      let clicked = 0;
      for (const t of targets) {
        try {
          // Bring the element into view, then hover: move the real mouse so
          // :hover transitions fire, with the virtual cursor following it.
          await page.evaluate(
            (y: number) =>
              (globalThis as any).window.scrollTo({
                top: Math.max(0, y - 380),
                behavior: "instant",
              }),
            t.y,
          );
          await page.waitForTimeout(SCROLL_INTO_VIEW_SETTLE_MS);
          const box: { x: number; y: number } | null = await page.evaluate(
            ([x, absY]: number[]) => {
              const g = globalThis as any;
              const el = g.document.elementFromPoint(x, absY - g.scrollY);
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            },
            [t.x, t.y],
          );
          if (!box) continue;
          await moveCursor(box.x, box.y);
          await page.waitForTimeout(HOVER_DWELL_MS); // let the hover transition play
          if (t.safeClick && clicked < MAX_CLICKS) {
            await page.mouse.down();
            await page.mouse.up(); // :active + click effects
            clicked++;
            await page.waitForTimeout(CLICK_SETTLE_MS); // let the click animation play
          }
        } catch {
          // detached/overlaid element — skip and continue the tour
        }
      }

      // Return to top so the video ends where it started.
      await page.evaluate(() => (globalThis as any).window.scrollTo({ top: 0, behavior: "instant" }));
      await page.waitForTimeout(TOP_RETURN_MS);
    } finally {
      // Closing the context is what flushes the .webm to disk.
      try {
        await context.close();
      } catch {
        /* flush is best-effort */
      }
    }

    // Video handoff: the glob only sees THIS call's flushed .webm (fresh
    // per-call tmp dir). Rename it to its stable, URL-keyed name in
    // cacheImagesDir while the tmp dir still exists.
    const webms = readdirSync(videoTmp).filter((f) => f.endsWith(".webm"));
    if (webms.length === 0) {
      // Not an install problem — plain failure, no install advice attached.
      return { error: "recording failed: no video file was produced" };
    }
    renameSync(join(videoTmp, webms[0]), videoPath);
  } finally {
    try {
      await browser.close();
    } catch {
      /* keep the primary error */
    }
    // Drop this run's tmp dir last: any partial video flushed by a mid-run
    // failure dies here instead of leaking into a later run's glob.
    rmSync(videoTmp, { recursive: true, force: true });
  }

  const ffmpegFn = opts.ffmpegFn ?? runFfmpeg;
  try {
    await ffmpegFn(ffmpegBin, videoPath, stripPath, frames);
  } catch {
    return { error: MOTION_FFMPEG_HINT };
  }
  if (!existsSync(stripPath)) return { error: MOTION_FFMPEG_HINT };
  return { file: videoPath, base64: (await readFile(stripPath)).toString("base64"), frames };
}
