import { CAPTURE_INSTALL_HINT } from "./capture.js";

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
  title: string;
  totalHeight: number;
  bands: PageBand[];
}

/** What page.evaluate(SCAN_SNIPPET) serializes back from the page. */
export interface ScanResult {
  title: string;
  totalHeight: number;
  candidates: RawBand[];
}

// Runs IN THE PAGE via page.evaluate. Collects full-width, tall, opaque
// elements as band candidates; body is always the base candidate. Gradient
// shorthand backgrounds leave backgroundColor transparent — such sections
// fall through to the nearest opaque ancestor (usually body).
//
// page.evaluate serializes plain data only, so this is a single
// self-contained function returning { title, totalHeight, candidates }
// (no closures over module scope). The Node tsconfig has no DOM lib, so
// browser globals are reached through globalThis.
export const SCAN_SNIPPET = (): ScanResult => {
  const g = globalThis as any;
  const doc = g.document;
  const totalHeight = Math.round(doc.documentElement.scrollHeight);
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
  const visit = (el: any, depth: number): void => {
    if (depth > 6 || candidates.length >= 300 || seen.has(el)) return;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (el !== doc.body && r.width >= 0.6 * bodyW && r.height >= 120) {
      const s = g.getComputedStyle(el);
      const m = /rgba?\(([^)]+)\)/.exec(s.backgroundColor);
      const alpha = m ? (m[1].split(",").length === 4 ? parseFloat(m[1].split(",")[3]) : 1) : 0;
      if (alpha > 0) {
        candidates.push({
          tag: el.tagName.toLowerCase(),
          label: (el.id ? "#" + el.id : "") + (el.classList.length ? "." + String(el.classList[0]) : ""),
          bg: s.backgroundColor,
          top: Math.round(r.top + g.scrollY),
          height: Math.round(r.height),
          textStart: (el.textContent ?? "").trim().slice(0, 60),
        });
      }
    }
    for (const child of el.children) visit(child, depth + 1);
  };
  visit(doc.body, 0);
  return { title: doc.title, totalHeight, candidates };
};

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

export async function analyzePageStructure(
  url: string,
  loader: () => Promise<any> = () => import("playwright" as string),
): Promise<PageStructure | { error: string }> {
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    const raw = (await page.evaluate(SCAN_SNIPPET)) as ScanResult;
    return {
      url,
      title: raw.title,
      totalHeight: raw.totalHeight,
      bands: collapseBands(raw.candidates, raw.totalHeight),
    };
  } finally {
    try {
      await browser.close();
    } catch {
      /* keep the primary error */
    }
  }
}
