import { createHash } from "node:crypto";
import { join } from "node:path";
// preScroll lives in structure.ts so there is ONE scroll-through loop for
// both tools; this is an intentional circular import (structure.ts imports
// CAPTURE_INSTALL_HINT from here) — both sides only use the other's bindings
// at call time, which ESM resolves fine.
import { preScroll, type WaitOpts, type WaitStrategy } from "./structure.js";
import { resolveViewport } from "./viewport.js";

export const CAPTURE_INSTALL_HINT =
  "Full-page capture needs Playwright, which is an optional dependency.\n" +
  "Install the side-by-side global layout and run the installed awwwards-mcp (not npx):  npm install -g awwwards-mcp playwright ffmpeg-static && npm exec --global -- playwright install chromium\n" +
  "Then retry the capture or structure tool (or restart your agent afterward).";

// Inline previews are base64, ~33% larger than the PNG. Past this budget the
// file is still saved but the preview is omitted so a 30MB retina capture
// cannot blow up the agent's context window.
export const DEFAULT_MAX_INLINE_BYTES = 2_500_000;

export type ScrollCaptureMode = "auto" | "anchors" | "viewport";

export interface CaptureOpts extends WaitOpts {
  /** false omits the base64 preview and keeps only the saved file (default true). */
  inline?: boolean;
  /** Base64 length above which the preview is omitted (default 2_500_000). */
  maxInlineBytes?: number;
  /** false skips waiting for a full-screen preloader overlay to clear (default true). */
  waitForOverlay?: boolean;
  /**
   * Inner-scroller handling: "auto"/"anchors" (default) takes 6 anchored
   * viewport screenshots down the page; "viewport" takes one viewport shot.
   * Document-root pages always keep the full-page capture.
   */
  scrollCapture?: ScrollCaptureMode;
}

export interface OverlayCandidate {
  rect: { width: number; height: number };
  style: { position: string; zIndex: string; opacity: string; visibility: string; display: string };
  viewport: { width: number; height: number };
}

// PURE: would this fixed element cover the screenshot? ≥90% of the viewport
// in BOTH axes, z-index ≥100, opacity >0.05 and visible. Kept as a Node-side
// helper so waitForOverlays and tests share one rule; the in-page snippet only
// collects candidates.
export function isBlockingOverlay(
  rect: { width: number; height: number } | null | undefined,
  style: OverlayCandidate["style"] | null | undefined,
  viewport: { width: number; height: number },
): boolean {
  if (!rect || !style) return false;
  if (style.position !== "fixed") return false;
  if (rect.width < 0.9 * viewport.width || rect.height < 0.9 * viewport.height) return false;
  const z = parseInt(String(style.zIndex), 10);
  if (!(z >= 100)) return false;
  const opacity = parseFloat(String(style.opacity ?? "1"));
  if (!(opacity > 0.05)) return false;
  if (style.visibility === "hidden" || style.display === "none") return false;
  return true;
}

// Runs IN THE PAGE via page.evaluate: one pass over fixed-position elements,
// returning their geometry + the style fields isBlockingOverlay checks. No
// nested named helpers (capture installs no tsx __name shim); capped at 50.
export const OVERLAY_SNIPPET = function (): OverlayCandidate[] {
  const g = globalThis as any;
  const doc = g.document;
  const viewport = {
    width: doc.documentElement.clientWidth || g.innerWidth || 1,
    height: doc.documentElement.clientHeight || g.innerHeight || 1,
  };
  const out: OverlayCandidate[] = [];
  const els = doc.querySelectorAll("*");
  for (let i = 0; i < els.length && out.length < 50; i++) {
    const s = g.getComputedStyle(els[i]);
    if (String(s.position) !== "fixed") continue;
    const r = els[i].getBoundingClientRect();
    out.push({
      rect: { width: r.width, height: r.height },
      style: {
        position: String(s.position),
        zIndex: String(s.zIndex),
        opacity: String(s.opacity ?? "1"),
        visibility: String(s.visibility),
        display: String(s.display),
      },
      viewport: viewport,
    });
  }
  return out;
};

// Polls every 250ms until no candidate blocks the viewport — a preloader that
// would otherwise be the whole screenshot. Pages that keep one mounted forever
// hit the timeout, which is swallowed: a late overlay is better than a failed
// capture. Fake/older pages without evaluate are treated as overlay-free.
export async function waitForOverlays(page: any, timeoutMs = 10_000): Promise<void> {
  if (typeof page?.evaluate !== "function") return;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let found: any;
    try {
      found = await page.evaluate(OVERLAY_SNIPPET);
    } catch {
      return; // page closed mid-wait
    }
    const blocked =
      Array.isArray(found) &&
      found.some((c: any) => !!c?.viewport && isBlockingOverlay(c.rect, c.style, c.viewport));
    if (!blocked || Date.now() >= deadline) return;
    try {
      if (typeof page.waitForTimeout === "function") await page.waitForTimeout(250);
      else await new Promise((r) => setTimeout(r, 250));
    } catch {
      return;
    }
  }
}

export type CaptureResult =
  | { file: string; base64?: string; inlineOmitted?: boolean }
  | {
      mode: "viewport";
      scrollRoot: string;
      file: string;
      base64?: string;
      inlineOmitted?: boolean;
      viewport: { width: number; height: number };
    }
  | {
      mode: "anchors";
      scrollRoot: string;
      /** Observed scrollTop at shot time (may fall short of the requested target). */
      anchors: Array<{ scrollTop: number; file: string }>;
      viewport: { width: number; height: number };
    }
  | { error: string };

// Runs IN THE PAGE: how many elements the preScroll label still matches. An
// invalid selector reports count 0 plus the parser message, so capture can say
// why it refused instead of guessing. No nested helpers (tsx __name shim).
const COUNT_SCROLL_ROOT = function (label: string): { count: number; invalid?: string } {
  const doc = (globalThis as any).document;
  try {
    return { count: doc.querySelectorAll(label).length };
  } catch (err) {
    return { count: 0, invalid: String((err as any)?.message ?? err) };
  }
};

// Runs IN THE PAGE: pins scroll-behavior:auto on the re-queried scroller so a
// page-level `scroll-behavior:smooth` cannot animate the anchor jump. Returns
// the inline value finally must put back ("" when the page set none).
export const PIN_SCROLL_BEHAVIOR = function (arg: { label: string }): { inline: string } | null {
  const doc = (globalThis as any).document;
  const el = doc.querySelectorAll(arg.label)[0];
  if (!el) return null;
  const style = el.style;
  const inline = style ? String(style.scrollBehavior || "") : "";
  if (style) style.scrollBehavior = "auto";
  return { inline: inline };
};

// Runs IN THE PAGE: sets the re-queried inner scroller's scrollTop and returns
// where it actually landed (-1 when the element vanished).
export const SET_SCROLL_TOP = function (arg: { label: string; top: number }): number {
  const doc = (globalThis as any).document;
  const el = doc.querySelectorAll(arg.label)[0];
  if (!el) return -1;
  el.scrollTop = arg.top;
  return Number(el.scrollTop) || 0;
};

// Runs IN THE PAGE: current scrollTop (-1 when the element vanished).
export const READ_SCROLL_TOP = function (arg: { label: string }): number {
  const doc = (globalThis as any).document;
  const el = doc.querySelectorAll(arg.label)[0];
  return el ? Number(el.scrollTop) || 0 : -1;
};

// Runs IN THE PAGE: back to the top and the page's own inline scroll-behavior.
export const RESTORE_SCROLL = function (arg: { label: string; inline: string }): void {
  const doc = (globalThis as any).document;
  const el = doc.querySelectorAll(arg.label)[0];
  if (!el) return;
  el.scrollTop = 0;
  if (el.style) el.style.scrollBehavior = arg.inline;
};

// Polls after the jump: the inline pin defeats CSS smooth scrolling, but a
// JS-driven scroller (Lenis, rAF lerps) ignores it, so the shot must wait for
// the real position. A timeout returns the last observed position, never throws.
export async function scrollToAnchor(
  page: any,
  label: string,
  top: number,
  timeoutMs = 1500,
): Promise<number> {
  let actual = Number(await page.evaluate(SET_SCROLL_TOP, { label, top })) || 0;
  const deadline = Date.now() + timeoutMs;
  while (actual >= 0 && Math.abs(actual - top) > 1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    actual = Number(await page.evaluate(READ_SCROLL_TOP, { label })) || 0;
  }
  return actual;
}

// Shared inline-preview decision: an omitted preview still leaves the saved
// file. Computed from the raw PNG length so a large capture never pays for
// the base64 conversion.
function previewOf(
  buf: Buffer,
  opts?: CaptureOpts,
): { base64?: string; inlineOmitted?: boolean } {
  if (opts?.inline === false) return { inlineOmitted: true };
  const base64Length = Math.ceil(buf.length / 3) * 4;
  if (base64Length > (opts?.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES)) {
    return { inlineOmitted: true };
  }
  return { base64: buf.toString("base64") };
}

export async function captureLiveSite(
  url: string,
  imagesDir: string,
  // "as string" keeps Playwright an unresolved optional dependency at compile time;
  // Node resolves it (and may throw) at runtime, which the try/catch below handles.
  loader: () => Promise<any> = () => import("playwright" as string),
  opts?: CaptureOpts,
): Promise<CaptureResult> {
  let chromium: any;
  try {
    ({ chromium } = await loader());
  } catch {
    return { error: CAPTURE_INSTALL_HINT };
  }
  let browser: any;
  try {
    browser = await chromium.launch(
      opts?.proxyServer
        ? {
            proxy: { server: opts.proxyServer, bypass: "<-loopback>" },
            args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
          }
        : {},
    );
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
    if (opts?.waitForOverlay !== false) await waitForOverlays(page, 15_000);
    const scroll = await preScroll(page);
    // Viewport goes into the name: the same URL captured at desktop and mobile
    // must keep both files (issue #23). Return the buffer playwright already
    // gave us — re-reading the file races a concurrent capture of the same URL.
    const vp = opts?.viewport ?? "desktop";
    const stem =
      "capture-" + createHash("sha1").update(url).digest("hex").slice(0, 12) + "-" + vp;
    const viewportSize = { width, height };
    // The label came from the pre-scroll walk; re-query it and require exactly
    // one element before scrolling anything. A vanished/duplicated scroller is
    // reported, never guessed around.
    const scrollRoot = typeof scroll?.scrollRoot === "string" ? scroll.scrollRoot : null;
    if (scrollRoot) {
      const probe = (await page.evaluate(COUNT_SCROLL_ROOT, scrollRoot)) as {
        count?: number;
        invalid?: string;
      };
      if (probe?.count !== 1) {
        const reason = probe?.invalid ? ` (${probe.invalid})` : "";
        return {
          error:
            `Inner scroller ${scrollRoot} re-query matched ${probe?.count ?? 0} elements ` +
            `(expected exactly 1)${reason}; refusing to guess which one to scroll.`,
        };
      }
      if (opts?.scrollCapture === "viewport") {
        // Explicitly one viewport-sized shot, not a full-page claim.
        const file = join(imagesDir, stem + ".png");
        const buf = (await page.screenshot({ path: file, fullPage: false })) as Buffer;
        return { mode: "viewport", scrollRoot, file, ...previewOf(buf, opts), viewport: viewportSize };
      }
      // auto/anchors: six ordered viewport shots down the inner scroller. The
      // inline scroll-behavior pin and the top reset live in finally so a
      // mid-loop screenshot failure still leaves the page as it was found.
      const maxScroll = Math.max(0, (scroll.scrollHeight || 0) - (scroll.clientHeight || 0));
      const anchors: Array<{ scrollTop: number; file: string }> = [];
      const pinned = (await page.evaluate(PIN_SCROLL_BEHAVIOR, { label: scrollRoot })) as {
        inline?: string;
      } | null;
      const inline = typeof pinned?.inline === "string" ? pinned.inline : "";
      try {
        for (let i = 0; i < 6; i++) {
          const scrollTop = Math.round((i * maxScroll) / 5);
          // Reach the anchor before the shot: the pin handles CSS smooth
          // scrolling, the poll handles JS-driven scrolling. The wait below is
          // only a paint/animation settle, not the arrival guarantee.
          const observedTop = await scrollToAnchor(page, scrollRoot, scrollTop);
          await page.waitForTimeout(250);
          const file = join(imagesDir, `${stem}-a${i}.png`);
          await page.screenshot({ path: file, fullPage: false });
          anchors.push({ scrollTop: observedTop, file });
        }
      } finally {
        try {
          await page.evaluate(RESTORE_SCROLL, { label: scrollRoot, inline });
        } catch {
          /* keep the primary error */
        }
      }
      return { mode: "anchors", scrollRoot, anchors, viewport: viewportSize };
    }
    const file = join(imagesDir, stem + ".png");
    const buf = (await page.screenshot({ path: file, fullPage: true })) as Buffer;
    return { file, ...previewOf(buf, opts) };
  } finally {
    try {
      await browser.close();
    } catch {
      /* keep the primary error */
    }
  }
}
