import { attachPage, closeAttached, validateCdpEndpoint, ATTACH_ENV } from "./browser.js";
import { CAPTURE_INSTALL_HINT, waitForOverlays } from "./capture.js";
import { resolveViewport, type ViewportName, type ViewportProfile } from "./viewport.js";

export interface RawBand {
  tag: string;
  label: string;
  bg: string;
  top: number;
  height: number;
  textStart: string;
}

export interface PageBand {
  index: number;
  tag: string;
  label: string;
  background: string;
  offsetTop: number;
  height: number;
  textStart: string;
}

export interface PageStructure {
  url: string;
  finalUrl?: string;
  title: string;
  totalHeight: number;
  bands: PageBand[];
  /** Detected inner scroll container (`tag#id.class`); absent when the page scrolls on the document root. */
  scrollRoot?: string;
  /** Mobile-only element evidence; absent unless the capture asked for it. */
  responsive?: ResponsiveReport;
  /** Additive marker: this scan ran on an attached page and never navigated. */
  attached?: boolean;
}

/** Raw element evidence serialized out of the page (selector parts are innermost-first). */
export interface RawResponsiveElement {
  parts: string[];
  x: number;
  y: number;
  w: number;
  h: number;
  detail: string;
}

/** Raw mobile scan. `counts` are pre-cap totals; arrays are capped in the page. */
export interface RawResponsiveScan {
  innerWidth: number;
  scrollWidth: number;
  counts: { overflow: number; smallText: number; smallTapTarget: number };
  overflow: RawResponsiveElement[];
  smallText: RawResponsiveElement[];
  smallTapTarget: RawResponsiveElement[];
}

export interface ResponsiveIssue {
  kind: "overflow" | "small-text" | "small-tap-target";
  selector: string;
  rect: { x: number; y: number; w: number; h: number };
  detail: string;
}

export interface ResponsiveReport {
  measuredAt: "mobile";
  viewport: { width: number; height: number; dpr: number };
  pageOverflow: { horizontal: boolean; scrollWidth: number; innerWidth: number };
  issues: ResponsiveIssue[];
  counts: { overflow: number; smallText: number; smallTapTarget: number };
  truncated: boolean;
}

/** What page.evaluate(SCAN_SNIPPET) serializes back from the page. */
export interface ScanResult {
  title: string;
  totalHeight: number;
  candidates: RawBand[];
  /** Detected inner scroll container (`tag#id.class`); absent for document-root scrolling. */
  scrollRoot?: string;
  /** Landmark y-tops (headings + distinct-bg children ≥400px). Omitted when collection threw. */
  landmarks?: number[];
  /** Mobile element evidence; omitted unless the snippet was called with responsive:true. */
  responsive?: RawResponsiveScan;
}

// Runs IN THE PAGE via page.evaluate. Collects full-width, tall, opaque
// elements as band candidates; body is always the base candidate. Gradient
// shorthand backgrounds leave backgroundColor transparent — such sections
// fall through to the nearest opaque ancestor (usually body).
//
// page.evaluate serializes plain data only, so this is a single
// self-contained function returning { title, totalHeight, candidates,
// responsive? } (no closures over module scope; every helper below is a
// function declaration — page.evaluate re-serializes the source, so no
// arrows). The Node tsconfig has no DOM lib, so browser globals are
// reached through globalThis.
//
// The backgroundColor alpha parsing in the visit loop (including the
// modern-color-function fallback) is mirrored in test/structure.test.ts
// ("SCAN_SNIPPET alpha parsing handles space syntax and percentage alphas")
// and must stay in sync.
export const SCAN_SNIPPET = function (args: { responsive?: boolean }): ScanResult {
  const g = globalThis as any;
  const doc = g.document;

  // The real scroll container. Sites that pin body (position:fixed) and scroll
  // an inner div never grow documentElement.scrollHeight, so without this the
  // whole page reads as one viewport-tall band. Only when the document itself
  // does not scroll (otherwise a code block or nav menu would win): largest
  // visible element whose overflow-y auto/scroll actually overflows;
  // body/html never qualify. Mirrored inline in preScroll.
  function findScrollRoot(): any {
    let best: any = null;
    let bestArea = 0;
    try {
      const de = doc.documentElement;
      if (de.scrollHeight > de.clientHeight + 100) return null;
      const all = doc.querySelectorAll("*");
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (el === doc.body || el === doc.documentElement) continue;
        if (!(el.scrollHeight > el.clientHeight + 100)) continue;
        const s = g.getComputedStyle(el);
        if (String(s.overflowY) !== "auto" && String(s.overflowY) !== "scroll") continue;
        if (String(s.display) === "none" || String(s.visibility) === "hidden") continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const area = r.width * r.height;
        if (area > bestArea) {
          bestArea = area;
          best = el;
        }
      }
    } catch {}
    return best;
  }

  function cssEscape(value: any): string {
    const css = g.CSS;
    if (css && typeof css.escape === "function") return String(css.escape(String(value)));
    // shortcut: fallback for old engines/fake pages without CSS.escape — it
    // covers the punctuation this label uses, not every CSS ident edge case.
    return String(value).replace(/[^A-Za-z0-9_\u00A0-\uFFFF-]/g, "\\$&");
  }

  function scrollRootLabel(el: any): string {
    const tag = String(el.tagName || "").toLowerCase();
    const id = el.id ? "#" + cssEscape(el.id) : "";
    const cls = el.classList && el.classList.length ? "." + cssEscape(el.classList[0]) : "";
    return tag + id + cls;
  }

  const scroller = findScrollRoot();
  const scrollerRect = scroller ? scroller.getBoundingClientRect() : null;
  const scrollerTop = scrollerRect ? scrollerRect.top : 0;
  const scrollerScrollTop = scroller ? scroller.scrollTop || 0 : 0;
  const totalHeight = Math.round(
    scroller ? scroller.scrollHeight : doc.documentElement.scrollHeight,
  );

  // Content y in the scanned scroller's coordinates: the document root adds
  // window scroll; an element scroller subtracts its viewport top and adds its
  // own scrollTop (mirrors the pure coordinateY helper).
  function coordY(r: any): number {
    return Math.round(scrollerRect ? r.top - scrollerTop + scrollerScrollTop : r.top + g.scrollY);
  }

  const bodyW = doc.body.getBoundingClientRect().width || 1;
  const bodyBg = g.getComputedStyle(doc.body).backgroundColor;
  const candidates: RawBand[] = [
    {
      tag: "body",
      label: "body",
      bg: bodyBg,
      top: 0,
      height: totalHeight,
      textStart: "",
    },
  ];
  const seen = new Set<unknown>();
  function visit(el: any, depth: number): void {
    if (depth > 6 || candidates.length >= 300 || seen.has(el)) return;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (el !== doc.body && r.width >= 0.6 * bodyW && r.height >= 120) {
      const s = g.getComputedStyle(el);
      const color = s.backgroundColor;
      // Alpha parse tolerant of legacy comma syntax and CSS Color 4
      // space syntax: rgb(r g b / a), rgb(r, g, b, a), and percentage alphas.
      // A rgba?() miss falls back by color function: modern opaque functions
      // (oklch/oklab/lab/lch/hwb/color) count as opaque (alpha 1); anything
      // else (gradients, keywords) stays conservative at alpha 0.
      const m = /rgba?\(([^)]+)\)/.exec(color);
      let alpha = 0;
      if (m) {
        const parts = m[1].replace(/\//g, " ").trim().split(/[\s,]+/).filter(Boolean);
        const aRaw = parts.length >= 4 ? parts[3] : "1";
        alpha = aRaw.endsWith("%") ? parseFloat(aRaw) / 100 : parseFloat(aRaw);
        if (Number.isNaN(alpha)) alpha = 0;
      } else if (/^(oklch|oklab|lab|lch|hwb|color)\(/.test(color.trim())) {
        alpha = 1;
      }
      if (alpha > 0) {
        candidates.push({
          tag: el.tagName.toLowerCase(),
          label: (el.id ? "#" + el.id : "") + (el.classList.length ? "." + String(el.classList[0]) : ""),
          bg: s.backgroundColor,
          top: coordY(r),
          height: Math.round(r.height),
          textStart: (el.textContent ?? "").trim().slice(0, 60),
        });
      }
    }
    for (const child of el.children) visit(child, depth + 1);
  }
  visit(doc.body, 0);
  // Landmark tops for band-split v2 (splitCollapsedBands filters per band at
  // match time, so the page ships ONE full-page list): heading tops plus the
  // tops of distinct-background children (computed background-color differs
  // from their parent's) at least 400px tall. Exact-deduped, sorted asc,
  // capped at 200; the walk is bounded like the candidate walk (depth ≤6,
  // ≤600 elements). try/caught: a page that throws here must still return
  // candidates with no landmarks.
  let landmarks: number[] | undefined;
  try {
    const tops: number[] = [];
    for (const h of doc.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
      tops.push(coordY(h.getBoundingClientRect()));
    }
    let walked = 0;
    function walkLandmarks(el: any, depth: number): void {
      if (depth > 6 || walked >= 600) return;
      walked++;
      if (el !== doc.body && el.parentElement) {
        const r = el.getBoundingClientRect();
        const bg = g.getComputedStyle(el).backgroundColor;
        if (r.height >= 400 && bg !== g.getComputedStyle(el.parentElement).backgroundColor) {
          tops.push(coordY(r));
        }
      }
      for (const child of el.children) walkLandmarks(child, depth + 1);
    }
    walkLandmarks(doc.body, 0);
    // D2 residual densify: <section>/<article>/[role=main] rect tops join the
    // landmarks — a giant band holding exactly ONE structural element is the
    // class that used to stay whole (the splitter required several in-range
    // marks). Capped at 12 so heading landmarks stay dominant in the
    // combined ≤200 list; same dedupe+sort as everything else below.
    const secTops: number[] = [];
    try {
      const secs = doc.querySelectorAll("section, article, [role=main]");
      for (let i = 0; i < secs.length && secTops.length < 12; i++) {
        try {
          secTops.push(coordY(secs[i].getBoundingClientRect()));
        } catch {}
      }
    } catch {}
    for (let i = 0; i < secTops.length; i++) tops.push(secTops[i]);
    const unique = [...new Set(tops)];
    unique.sort(function (a: number, b: number): number { return a - b; });
    landmarks = unique.slice(0, 200);
  } catch {
    // landmarks stays undefined — the scan degrades to candidates only
  }
  const out: ScanResult = { title: doc.title, totalHeight, candidates };
  if (scroller) out.scrollRoot = scrollRootLabel(scroller);
  if (landmarks) out.landmarks = landmarks;
  // Responsive evidence, mobile captures only. One pass in document
  // coordinates; every rule is independent and the whole block degrades to no
  // responsive key if anything throws, so band scanning never fails because of
  // it. Counts are pre-cap totals; arrays keep at most 10.
  if (args && args.responsive === true) {
    try {
      // Emulated mobile widens window.innerWidth to the content width, so
      // overflow is measured against the layout client width instead.
      const viewportWidth = doc.documentElement.clientWidth || g.innerWidth;
      const scrollWidth = doc.documentElement.scrollWidth;
      const counts = { overflow: 0, smallText: 0, smallTapTarget: 0 };
      const overflow: RawResponsiveElement[] = [];
      const smallText: RawResponsiveElement[] = [];
      const smallTapTarget: RawResponsiveElement[] = [];
      const all = doc.querySelectorAll("*");

      function isVisible(el: any, r: any): boolean {
        if (r.width <= 0 || r.height <= 0) return false;
        const s = g.getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") {
          return false;
        }
        if (parseFloat(String(s.opacity || "1")) === 0) return false;
        // sr-only boxes (1x1 + clip / clip-path: inset(50%)) have a rect but
        // are not visible; clip without percentages normalizes to this form.
        const clip = String(s.clip || "");
        const clipPath = String(s.clipPath || "");
        if (clip === "rect(0px, 0px, 0px, 0px)" || clipPath === "inset(50%)") return false;
        return true;
      }

      // Same rule as a11y.ts selectorFor: id stops the walk, classList[0]
      // only, at most 4 parts (self + 3 ancestors).
      function selectorParts(el: any): string[] {
        const parts: string[] = [];
        let cur = el;
        let depth = 0;
        while (cur && cur.nodeType === 1 && depth < 4) {
          const tag = String(cur.tagName || "").toLowerCase();
          if (cur.id) {
            parts.push(tag + "#" + String(cur.id));
            break;
          }
          let part = tag;
          const cls = cur.classList && cur.classList.length ? String(cur.classList[0]) : "";
          if (cls && /^[A-Za-z0-9_-]+$/.test(cls)) part += "." + cls;
          parts.push(part);
          cur = cur.parentElement;
          depth++;
        }
        return parts;
      }

      function snapshot(el: any, detail: string): RawResponsiveElement {
        const r = el.getBoundingClientRect();
        return {
          parts: selectorParts(el),
          x: Math.round(r.left + g.scrollX),
          y: coordY(r),
          w: Math.round(r.width),
          h: Math.round(r.height),
          detail: detail,
        };
      }

      function hasDirectText(el: any): boolean {
        const nodes = el.childNodes;
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          if (node.nodeType === 3 && String(node.textContent || "").trim() !== "") return true;
        }
        return false;
      }

      function insideScroller(el: any): boolean {
        let cur = el.parentElement;
        let depth = 0;
        // Walk to the document root; 100 is only a hostile-DOM safety bound.
        while (cur && cur.nodeType === 1 && depth < 100) {
          // A clip/transform on body or html is page-wide: it would mask every
          // offender, so only a descendant ancestor may exclude an element.
          const isRoot = cur === doc.body || cur === doc.documentElement;
          const s = g.getComputedStyle(cur);
          if (s.overflowX === "auto" || s.overflowX === "scroll") return true;
          if (s.overflowX === "hidden" && !isRoot) return true;
          if (String(s.transform || "none") !== "none" && !isRoot) return true;
          cur = cur.parentElement;
          depth++;
        }
        return false;
      }

      // Overflow offenders: document right edge past the viewport, not inside
      // a horizontal scroller or transformed ancestor; keep the widest 10.
      const overflowCandidates: Array<{ el: any; over: number }> = [];
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const r = el.getBoundingClientRect();
        if (r.width > 0) {
          const right = r.left + g.scrollX + r.width;
          if (right > viewportWidth + 1 && !insideScroller(el)) {
            counts.overflow++;
            overflowCandidates.push({ el: el, over: right - viewportWidth });
          }
        }
      }
      overflowCandidates.sort(function (a, b): number { return b.over - a.over; });
      for (let i = 0; i < overflowCandidates.length && overflow.length < 10; i++) {
        const item = overflowCandidates[i];
        if (item) {
          overflow.push(snapshot(item.el, "overflows viewport by " + Math.round(item.over) + "px"));
        }
      }

      // Small text: a direct non-empty text node below the 12px floor.
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (!hasDirectText(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || !isVisible(el, r)) continue;
        const size = parseFloat(String(g.getComputedStyle(el).fontSize || ""));
        if (!(size < 12)) continue;
        counts.smallText++;
        if (smallText.length < 10) {
          smallText.push(snapshot(el, "font-size " + Math.round(size * 10) / 10 + "px < 12px"));
        }
      }

      // Small tap targets: interactive elements under 24px in either axis.
      // Inline prose links are excluded — their click box is the text run.
      const taps = doc.querySelectorAll("a[href], button, input, select, textarea, [role=button]");
      for (let i = 0; i < taps.length; i++) {
        const el = taps[i];
        const r = el.getBoundingClientRect();
        if (!isVisible(el, r)) continue;
        const isInlineLink =
          String(el.tagName || "").toLowerCase() === "a" &&
          g.getComputedStyle(el).display === "inline";
        if (isInlineLink) continue;
        if (r.width >= 24 && r.height >= 24) continue;
        counts.smallTapTarget++;
        if (smallTapTarget.length < 10) {
          smallTapTarget.push(
            snapshot(el, Math.round(r.width) + "×" + Math.round(r.height) + "px < 24px"),
          );
        }
      }

      out.responsive = {
        innerWidth: viewportWidth,
        scrollWidth: scrollWidth,
        counts: counts,
        overflow: overflow,
        smallText: smallText,
        smallTapTarget: smallTapTarget,
      };
    } catch {
      // responsive stays undefined — the band scan is never failed by this
    }
  }
  return out;
};

// PURE: content y in the scanned scroll container's coordinate space.
// Document-root scrolling adds window.scrollY to the viewport rect; an inner
// scroller subtracts its own viewport top and adds its scrollTop. Mirrored
// inline in SCAN_SNIPPET (which cannot import module helpers).
export function coordinateY(
  rectTop: number,
  docScrollY: number,
  scroller?: { top: number; scrollTop: number } | null,
): number {
  return Math.round(scroller ? rectTop - scroller.top + scroller.scrollTop : rectTop + docScrollY);
}

// PURE: joins raw selector parts (innermost-first) into a readable path.
// The page snippet collects the parts because page.evaluate cannot import the
// a11y selectorFor helper; the 160-char cap matches it.
export function selectorFromParts(parts: string[]): string {
  return parts.slice().reverse().join(" > ").slice(0, 160);
}

// PURE: classifies a raw mobile scan into the public report. Per-kind order is
// overflow → small-text → small-tap-target; each kind is defensively capped at
// 10 again. counts stay the page's pre-cap totals, and truncated is true when a
// cap hid anything.
export function buildResponsiveReport(
  raw: RawResponsiveScan,
  viewport: ViewportProfile = resolveViewport("mobile"),
): ResponsiveReport {
  const issues: ResponsiveIssue[] = [];
  function add(kind: ResponsiveIssue["kind"], els: RawResponsiveElement[]): void {
    for (const el of els.slice(0, 10)) {
      issues.push({
        kind,
        selector: selectorFromParts(el.parts),
        rect: { x: el.x, y: el.y, w: el.w, h: el.h },
        detail: el.detail,
      });
    }
  }
  add("overflow", raw.overflow);
  add("small-text", raw.smallText);
  add("small-tap-target", raw.smallTapTarget);
  return {
    measuredAt: "mobile",
    // The capture profile, not a literal: a different phone profile (or a
    // desktop capture that requested evidence) must report what it measured.
    viewport: {
      width: viewport.width,
      height: viewport.height,
      dpr: viewport.deviceScaleFactor ?? 1,
    },
    pageOverflow: {
      horizontal: raw.scrollWidth > raw.innerWidth + 1,
      scrollWidth: raw.scrollWidth,
      innerWidth: raw.innerWidth,
    },
    issues,
    counts: { ...raw.counts },
    truncated:
      raw.counts.overflow > Math.min(raw.overflow.length, 10) ||
      raw.counts.smallText > Math.min(raw.smallText.length, 10) ||
      raw.counts.smallTapTarget > Math.min(raw.smallTapTarget.length, 10),
  };
}

// PURE: reduces raw candidates to the page's visible horizontal band map.
// Sweeps y in 8px steps; at each y the effective background is the covering
// candidate with the SMALLEST height (most specific wins). Consecutive
// same-background runs merge (first label wins); bands < 40px are absorbed
// into the previous band; the count is capped by merging the smallest band
// into its previous neighbor. Uncovered y (gaps) never emit a band.
export function collapseBands(cands: RawBand[], totalHeight: number, maxBands = 40): PageBand[] {
  // Round candidate geometry up front: the sweep samples integer y and the
  // emitted coordinates must be rounded (top 0.4 must yield a band at 0).
  const usable = cands
    .map((c) => ({ ...c, top: Math.round(c.top), height: Math.round(c.height) }))
    .filter((c) => c.height > 0);
  const STEP = 8;
  const bgAt = (y: number): RawBand | null => {
    let best: RawBand | null = null;
    for (const c of usable) {
      if (c.top <= y && y < c.top + c.height) {
        if (!best || c.height < best.height) best = c;
      }
    }
    return best;
  };
  const runs: { cand: RawBand; top: number; height: number }[] = [];
  let y = 0;
  let current: { cand: RawBand; top: number } | null = null;
  while (y < totalHeight) {
    const c = bgAt(y);
    if (current && c && c.bg === current.cand.bg) {
      // same run continues
    } else {
      if (current) runs.push({ cand: current.cand, top: current.top, height: y - current.top });
      current = c ? { cand: c, top: y } : null;
      if (!c) {
        // no candidate covers y (gap): nothing is emitted; when coverage
        // resumes the merge pass below re-joins same-bg neighbors.
      }
    }
    y += STEP;
  }
  if (current) runs.push({ cand: current.cand, top: current.top, height: totalHeight - current.top });
  // Merge adjacent same-bg runs (first label wins), absorb tiny slivers.
  // Absorbing a sliver seals the seam so a same-bg run after the sliver
  // stays its own band instead of bleeding across it.
  const merged: { cand: RawBand; top: number; height: number; sealed?: boolean }[] = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (prev && !prev.sealed && prev.cand.bg === r.cand.bg) prev.height = r.top + r.height - prev.top;
    else if (r.height < 40 && prev) {
      prev.height = r.top + r.height - prev.top;
      prev.sealed = true;
    } else merged.push({ ...r });
  }
  // Cap: merge the smallest band into its previous neighbor until <= maxBands.
  while (merged.length > maxBands && merged.length > 1) {
    let idx = 1;
    for (let i = 1; i < merged.length; i++) if (merged[i].height < merged[idx].height) idx = i;
    merged[idx - 1].height = merged[idx - 1].height + merged[idx].height;
    merged.splice(idx, 1);
  }
  return merged.map((r, i) => ({
    index: i,
    tag: r.cand.tag,
    label: r.cand.label,
    background: r.cand.bg,
    offsetTop: Math.round(r.top),
    height: Math.round(r.height),
    textStart: r.cand.textStart,
  }));
}

// PURE: band-split v2 — subdivides collapsed giant bands at landmark tops so
// a 20,000px background run stops reading as one band. A band only splits
// when it is a real giant (height ≥ 3000px) with at least one in-range
// landmark that stands ≥ 200px from both edges (no sub-band born under the
// 200px floor the merge rule enforces anyway). Several valid cuts subdivide
// at all of them; a single valid cut — the residual giants whose only mark
// is one section/article/[role=main] top (scan now records those) — splits
// ONCE into two parts. Sub-band heights are the deltas between cuts, and a
// delta < 200px merges into the previous sub-band (that landmark sits too
// close to its neighbor to stand alone); the last sub takes the remainder,
// so sub heights always sum to the parent height. Sub 0 keeps the parent's
// tag/label/bg/textStart; later subs keep tag/bg but take empty
// label/textStart — the parent's label and text describe the giant's top,
// not where those subs begin. The maxBands guard SKIPS the whole split
// instead of truncating: dropping sub-bands mid-split would fabricate
// coverage the landmarks disprove.
export function splitCollapsedBands(bands: PageBand[], landmarks: number[], maxBands = 60): PageBand[] {
  const marks = [...new Set(landmarks.filter(Number.isFinite))].sort((a, b) => a - b);
  if (!marks.length) return bands; // no landmarks: byte-identical passthrough
  const out: PageBand[] = [];
  for (const band of bands) {
    const top = band.offsetTop;
    const bottom = top + band.height;
    const inRange = marks.filter((lm) => lm > top && lm < bottom);
    const validCuts = inRange.filter((lm) => lm - top >= 200 && bottom - lm >= 200);
    const heights: number[] = [];
    if (band.height >= 3000 && validCuts.length) {
      let prev = top;
      for (const cut of [...validCuts, bottom]) {
        const delta = cut - prev;
        if (heights.length && delta < 200) heights[heights.length - 1] += delta;
        else heights.push(delta);
        prev = cut;
      }
    }
    // Running maxBands guard: a split either fits entirely or not at all.
    if (!heights.length || out.length + heights.length > maxBands) {
      out.push(band);
      continue;
    }
    let offset = top;
    for (let i = 0; i < heights.length; i++) {
      out.push({
        index: 0, // renumbered below
        tag: band.tag,
        label: i === 0 ? band.label : "",
        background: band.background,
        offsetTop: offset,
        height: heights[i],
        textStart: i === 0 ? band.textStart : "",
      });
      offset += heights[i];
    }
  }
  return out.map((b, i) => ({ ...b, index: i }));
}

/** Desktop→mobile band diff: mobile-only, desktop-only and order-changed labels. */
export interface BandDiff {
  heightDelta: number;
  bandsAdded: string[];
  bandsRemoved: string[];
  reordered: string[];
}

// PURE: compares two band maps by normalized label with the same greedy
// first-match pool as verify-build's compareBands (one other-side band can
// absorb only one base band). `heightDelta` is other − base. A label whose
// rank among greedily matched bands changes is reported once per matched pair.
export function diffBands(base: PageStructure, other: PageStructure): BandDiff {
  const norm = (s: string): string => s.trim().toLowerCase();
  const show = (s: string): string => s.trim() || "(unlabeled)";
  const pool = other.bands.map((b) => ({ key: norm(b.label), label: show(b.label), used: false }));
  const pairs: { label: string; index: number }[] = [];
  const removed: string[] = [];
  for (const band of base.bands) {
    const key = norm(band.label);
    const index = pool.findIndex((p) => !p.used && p.key === key);
    if (index === -1) {
      removed.push(show(band.label));
      continue;
    }
    pool[index]!.used = true;
    pairs.push({ label: show(band.label), index });
  }
  const added = pool.filter((p) => !p.used).map((p) => p.label);
  // Rank each matched pair by its order on the other side; a rank that moved
  // from its base position means the common bands are not in the same order.
  const otherOrder = pairs.map((_, i) => i).sort((a, b) => pairs[a]!.index - pairs[b]!.index);
  const reordered = pairs.filter((_, i) => otherOrder.indexOf(i) !== i).map((p) => p.label);
  return {
    heightDelta: Math.round(other.totalHeight - base.totalHeight),
    bandsAdded: added.slice(0, 60),
    bandsRemoved: removed.slice(0, 60),
    reordered: reordered.slice(0, 60),
  };
}

/** Wait strategy for page.goto: "load" (default, plus a fixed settle) or "networkidle". */
export type WaitStrategy = "load" | "networkidle";

export interface WaitOpts {
  waitStrategy?: WaitStrategy;
  /** Page creation profile: "desktop" (default, 1440x900) or "mobile" (390x844 @ DPR 3, touch). */
  viewport?: ViewportName;
  /** Mobile only: collect overflow, small-text and small-tap-target evidence. */
  responsive?: boolean;
  /** Attach to a loopback CDP endpoint (requires AWWWARDS_MCP_ATTACH=1); never navigates, scrolls, clicks or creates tabs. */
  cdpEndpoint?: string;
  /** Route every launched-browser connection through this loopback guard proxy. */
  proxyServer?: string;
}

/** What preScroll measured after its walk. `scrollRoot` is the detected inner scroller label, null for the document. */
export interface PreScrollInfo {
  scrollRoot: string | null;
  scrollHeight: number;
  clientHeight: number;
}

// tsx (esbuild keepNames) injects __name()/__defProp helpers at module scope;
// page.evaluate serializes only the snippet function body, so those helper
// references would be undefined in the page (tsc dist never injects them).
// Install a no-op shim before navigation so tsx-run captures behave like
// compiled ones. Only snippets serialized via page.evaluate need this.
export const SNIPPET_SHIM_SOURCE =
  `globalThis.__name = globalThis.__name || ((target, name) => { try { Object.defineProperty(target, "name", { value: name, configurable: true }); } catch {} return target; });`;

export async function installSnippetShims(page: any): Promise<void> {
  if (typeof page.addInitScript !== "function") return; // fake pages in tests
  await page.addInitScript(SNIPPET_SHIM_SOURCE);
}

// Attached pages are already loaded, so addInitScript never runs for them.
// One-shot string evaluate installs the same no-op shim before the scan:
// harmless on compiled builds, required when the server runs under tsx.
export async function installAttachedShim(page: any): Promise<void> {
  if (typeof page.evaluate !== "function") return; // fake pages in tests
  await page.evaluate(SNIPPET_SHIM_SOURCE);
}

// Hard caps for one preScroll walk. The in-page function cannot close over
// module scope (page.evaluate re-serializes it), so the same literals are
// repeated below and pinned by test/structure.test.ts — keep them in sync.
export const MAX_PRESCROLL_STEPS = 80;
export const PRE_SCROLL_DEADLINE_MS = 8_000;

// Scroll through the page so lazy-rendered sections have layout before a
// screenshot or band scan (spec requirement; 450px steps, brief settle, back
// to top). Shared by captureLiveSite and analyzePageStructure — this is the
// ONE implementation; capture.ts imports it. Scrolls the detected inner
// scroll container when the page has one (body-pinned sites), else window.
// Both walks stop at MAX_PRESCROLL_STEPS/8s even when scrollHeight keeps
// growing, and always reset to the top. Returns the detected inner scroller
// label + final metrics so capture can re-query it; existing callers ignore it.
export async function preScroll(page: any): Promise<PreScrollInfo> {
  return page.evaluate(async function () {
    const g = globalThis as any;
    const doc = g.document;
    const step = 450;
    const maxSteps = 80; // MAX_PRESCROLL_STEPS
    const deadlineMs = 8000; // PRE_SCROLL_DEADLINE_MS
    const started = Date.now();
    // Mirror of SCAN_SNIPPET's findScrollRoot, kept inline (no nested named
    // function): this evaluate can run before the tsx __name shim is installed.
    let scroller: any = null;
    let bestArea = 0;
    try {
      const de = doc.documentElement;
      if (!(de.scrollHeight > de.clientHeight + 100)) {
        const all = doc.querySelectorAll("*");
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (el === doc.body || el === doc.documentElement) continue;
          if (!(el.scrollHeight > el.clientHeight + 100)) continue;
          const s = g.getComputedStyle(el);
          if (String(s.overflowY) !== "auto" && String(s.overflowY) !== "scroll") continue;
          if (String(s.display) === "none" || String(s.visibility) === "hidden") continue;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          const area = r.width * r.height;
          if (area > bestArea) {
            bestArea = area;
            scroller = el;
          }
        }
      }
    } catch {}
    // Same tag#id.class[0] label SCAN_SNIPPET emits, escaped the same way
    // (inlined: this evaluate can run before the tsx __name shim, so it may
    // declare no named helpers).
    const css = g.CSS;
    let scrollRoot: string | null = null;
    if (scroller) {
      const id = scroller.id
        ? "#" +
          (css && typeof css.escape === "function"
            ? String(css.escape(String(scroller.id)))
            : String(scroller.id).replace(/[^A-Za-z0-9_\u00A0-\uFFFF-]/g, "\\$&"))
        : "";
      const cls =
        scroller.classList && scroller.classList.length
          ? "." +
            (css && typeof css.escape === "function"
              ? String(css.escape(String(scroller.classList[0])))
              : String(scroller.classList[0]).replace(/[^A-Za-z0-9_\u00A0-\uFFFF-]/g, "\\$&"))
          : "";
      scrollRoot = String(scroller.tagName || "").toLowerCase() + id + cls;
    }
    if (scroller) {
      let y = 0;
      let steps = 0;
      while (steps < maxSteps && Date.now() - started < deadlineMs && y < scroller.scrollHeight) {
        scroller.scrollTop = y;
        await new Promise((r) => setTimeout(r, 40));
        y += step;
        steps++;
      }
      scroller.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 150));
      return {
        scrollRoot: scrollRoot,
        scrollHeight: Math.round(scroller.scrollHeight || 0),
        clientHeight: Math.round(scroller.clientHeight || 0),
      };
    }
    let y = 0;
    let steps = 0;
    while (steps < maxSteps && Date.now() - started < deadlineMs && y < doc.documentElement.scrollHeight) {
      g.window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
      y += step;
      steps++;
    }
    g.window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 150));
    return {
      scrollRoot: null,
      scrollHeight: Math.round(doc.documentElement.scrollHeight || 0),
      clientHeight: Math.round(doc.documentElement.clientHeight || 0),
    };
  });
}

export async function analyzePageStructure(
  url: string,
  loader: () => Promise<any> = () => import("playwright" as string),
  maxBands?: number,
  opts?: WaitOpts,
): Promise<PageStructure | { error: string }> {
  const endpoint = opts?.cdpEndpoint;
  if (endpoint !== undefined) {
    if (process.env[ATTACH_ENV] !== "1") {
      return {
        error:
          `Attach is disabled. Set ${ATTACH_ENV}=1 in the MCP server's environment and restart it, then retry with cdpEndpoint. ` +
          "Attach connects to a loopback browser you started, scans one already-open page without navigating, scrolling, clicking or creating tabs, and disconnects without closing it.",
      };
    }
    const valid = validateCdpEndpoint(endpoint);
    if ("error" in valid) return valid;
    // The attached page owns its viewport and scroll position: only scan as-is.
    if (opts?.viewport !== undefined && opts.viewport !== "desktop") {
      return {
        error:
          "cdpEndpoint attaches to an already-open page, so a custom viewport is unavailable. Omit viewport (the page's own viewport is used).",
      };
    }
    if (opts?.responsive === true) {
      return {
        error:
          "cdpEndpoint never scrolls the attached page, so responsive evidence is unavailable. Drop responsive, or run a launched compare without cdpEndpoint.",
      };
    }
  }
  let chromium: any;
  try {
    ({ chromium } = await loader());
  } catch {
    return { error: CAPTURE_INSTALL_HINT };
  }
  if (endpoint !== undefined) {
    const attached = await attachPage(async () => ({ chromium }), endpoint, url);
    if ("error" in attached) return attached;
    try {
      // No goto, no settle, no preScroll: attach only reads the user's tab.
      await installAttachedShim(attached.page);
      const raw = (await attached.page.evaluate(SCAN_SNIPPET, {
        responsive: false,
      })) as ScanResult;
      return {
        url,
        title: raw.title,
        totalHeight: raw.totalHeight,
        bands: splitCollapsedBands(collapseBands(raw.candidates, raw.totalHeight, maxBands ?? 40), raw.landmarks ?? []),
        ...(raw.scrollRoot ? { scrollRoot: raw.scrollRoot } : {}),
        attached: true,
      };
    } finally {
      await closeAttached(attached.browser);
    }
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
    // Viewport profile split: width/height fill playwright's `viewport` key;
    // the mobile-profile flags (deviceScaleFactor/isMobile/hasTouch) are
    // sibling context options. The desktop profile resolves to no extra
    // fields, so the default call shape is unchanged.
    const profile = resolveViewport(opts?.viewport);
    const { width, height, ...contextOpts } = profile;
    const page = await browser.newPage({ viewport: { width, height }, ...contextOpts });
    await installSnippetShims(page);
    await page.goto(url, { waitUntil: waitStrategy, timeout: 45_000 });
    // "load" can fire before late XHRs settle, so give the page a fixed
    // settle window; networkidle already means the network went quiet.
    if (waitStrategy === "load") await page.waitForTimeout(3000);
    // Wait out a full-screen preloader before scanning: on body-pinned sites
    // the inner scroller may not exist until the loader has finished.
    await waitForOverlays(page, 15_000);
    await preScroll(page);
    const raw = (await page.evaluate(SCAN_SNIPPET, {
      responsive: opts?.responsive === true,
    })) as ScanResult;
    const structure: PageStructure = {
      url,
      finalUrl: typeof page.url === "function" ? page.url() : url,
      title: raw.title,
      totalHeight: raw.totalHeight,
      bands: splitCollapsedBands(collapseBands(raw.candidates, raw.totalHeight, maxBands ?? 40), raw.landmarks ?? []),
    };
    if (raw.scrollRoot) structure.scrollRoot = raw.scrollRoot;
    if (raw.responsive) structure.responsive = buildResponsiveReport(raw.responsive, profile);
    return structure;
  } finally {
    try {
      await browser.close();
    } catch {
      /* keep the primary error */
    }
  }
}
