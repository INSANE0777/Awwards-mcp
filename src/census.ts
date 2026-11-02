import { installSnippetShims, preScroll, type WaitStrategy } from "./structure.js";
import { resolveViewport, type ViewportName } from "./viewport.js";

/** Where an animation's scroll linkage was detected. */
export type ScrollTriggerSource =
  | "gsap-scrolltrigger"
  | "css-scroll-timeline"
  | "css-view-timeline"
  | "data-attr"
  | "css-keyframe"
  | "smil"
  | "unknown";

/** One sampled keyframe: numeric-ish offset plus a few clamped props. */
export interface KeyframeSample {
  offset: number | null;
  props: Record<string, string>;
}

/** One GSAP ScrollTrigger row: compiled numerics + bounded tween vars. */
export interface GsapTriggerRow {
  selector: string;
  scrub: boolean;
  pin: boolean;
  startPx: number | null;
  endPx: number | null;
  progress: number | null;
  vars: Record<string, string>;
}

/** One sampled point of the L3 scrub probe (commanded/actual scrollY + live state). */
export interface ScrubProbeSample {
  scrollY: number;
  progress: number | null;
  transform: string | null;
}

/** One scrubbed trigger's real progress curve, read live across the scroll range. */
export interface ScrubCurve {
  selector: string;
  startPx: number;
  endPx: number;
  steps: { scrollY: number; progress: number; transform: string | null }[];
}

/** One per-element animation row, as serialized from the page. */
export interface RawAnim {
  selector: string;
  tag: string;
  props: string[];
  durationMs: number | null;
  delayMs: number | null;
  easing: string | null;
  trigger: ScrollTriggerSource;
  scrub: boolean;
  pin: boolean;
  svgStroke: boolean;
  /** Bounded keyframe matrix — populated for the first ≤60 anim rows only. */
  keyframes?: KeyframeSample[];
}

/** What page.evaluate(SCROLL_CENSUS_SNIPPET) serializes back from the page. */
export interface ScrollScan {
  anims: RawAnim[];
  smilSelectors: string[];
  nativeTimelines: { selector: string; kind: "scroll" | "view" }[];
  /** GSAP ScrollTrigger registry rows — always emitted by the snippet ([] when no GSAP); required so the serialized JSON always carries the key (kit readers see [], never undefined). Capped at 20 detail rows. */
  gsapTriggers: GsapTriggerRow[];
  /** Full registry size BEFORE the 20-row detail cap — always emitted (0 when no GSAP). */
  gsapRegistryTotal: number;
  /** Rendered document height at the start of the census evaluate. Optional so legacy saved scans stay valid. */
  startHeight?: number | null;
  /** Rendered document height at the end of the census evaluate. Optional so legacy saved scans stay valid. */
  documentHeight?: number | null;
}

export interface ScrollCensus {
  url: string;
  capturedAt: number;
  counts: Record<ScrollTriggerSource, number>;
  anims: RawAnim[];
  svgStrokes: string[];
  nativeScrollTimelines: number;
  /** GSAP deep capture rows — always present ([] when empty; required so the serialized JSON always carries the key); passthrough from the scan, order preserved. */
  gsapTriggers: GsapTriggerRow[];
  /** Full GSAP registry size (always emitted) — the pre-cap total from ScrollScan.gsapRegistryTotal, not the ≤20 detail rows. Separate from counts["gsap-scrolltrigger"], which tallies element animations classified onto a trigger. */
  gsapRegistryCount: number;
  /** L3 scrub probe curves — present ONLY when opts.scrubProbe was true; [] when the probe found nothing or failed. Absent (never []) when the flag is off, so disabled keeps the payload lean. */
  scrubCurves?: ScrubCurve[];
  reducedMotion: boolean;
  /** What the fixed waits actually sampled. Absent when the census does not carry it (legacy/saved evidence). */
  acquisition?: CensusAcquisition;
}

/**
 * Acquisition state for one live census. Fixed waits (goto strategy + settle +
 * preScroll + post-scroll pause) mean an async section can land before, during
 * or after the sample: two runs can then fingerprint different pages. This
 * block is the disclosure — capturedAt/documentHeight/animationCount show what
 * was captured, and `stable: false` means the document height changed across
 * the census evaluate itself (late content landed mid-capture). `stable: null`
 * means the post-capture probe was unavailable; absence of the block means no
 * acquisition evidence at all.
 */
export interface CensusAcquisition {
  /** goto wait strategy actually used for this capture. */
  waitStrategy: WaitStrategy;
  /** Fixed post-goto settle before preScroll (ms). */
  settleMs: number;
  /** Fixed pause after preScroll before the census evaluate (ms). */
  postScrollMs: number;
  /** Epoch ms of the census reduce (same value as ScrollCensus.capturedAt). */
  capturedAt: number;
  /** Rendered document height when the census ran; null when the scan couldn't report it. */
  documentHeight: number | null;
  /** Animation rows sampled (ScrollCensus.anims.length). */
  animationCount: number;
  /** GSAP registry total at capture time. */
  gsapRegistryCount: number;
  /** true = height unchanged from the start of the census evaluate through the post-capture probe; false = content landed mid-capture; null = unknown. Content arriving before the evaluate starts is not detectable. */
  stable: boolean | null;
}

const TRIGGER_SOURCES: ScrollTriggerSource[] = [
  "gsap-scrolltrigger",
  "css-scroll-timeline",
  "css-view-timeline",
  "data-attr",
  "css-keyframe",
  "smil",
  "unknown",
];

// PURE mirror of the sampleKeyframes helper inside SCROLL_CENSUS_SNIPPET (the
// snippet must stay self-contained for page.evaluate serialization, so it
// keeps an inline copy — keep the two in sync). Exported for unit tests.
export function sampleKeyframes(kfs: any[]): KeyframeSample[] {
  const KP = ["transform", "opacity", "filter", "clip-path", "color", "background-color", "width", "height"];
  const picks = kfs.length <= 4 ? kfs : [kfs[0], kfs[Math.floor(kfs.length / 2)], kfs[kfs.length - 1]];
  const out: KeyframeSample[] = [];
  for (const kf of picks.slice(0, 4)) {
    const props: Record<string, string> = {};
    let n = 0;
    for (const k of KP) {
      if (n >= 4) break;
      try {
        if (kf[k] != null) {
          props[k] = String(kf[k]).slice(0, 40);
          n++;
        }
      } catch {}
    }
    out.push({ offset: typeof kf.offset === "number" ? kf.offset : null, props });
  }
  return out;
}

// Runs IN THE PAGE via page.evaluate. One row per element animation in
// doc.getAnimations(), plus native CSS scroll/view timelines and SMIL
// animations. Must be a plain `function` expression (no arrow — page.evaluate
// re-serializes the source) with zero outer references: helpers live inside
// the body, browser globals go through globalThis (Node tsconfig has no DOM
// lib), and every probe is try/caught so a site whose JS explodes still
// yields a partial census. Mirrors SCAN_SNIPPET (structure.ts) and
// MOTION_SNIPPET (motion-dna.ts).
export const SCROLL_CENSUS_SNIPPET = function (): ScrollScan {
  const g = globalThis as any;
  const doc = g.document;
  const win = g;
  const anims: ScrollScan["anims"] = [];
  const smilSelectors: string[] = [];
  const nativeTimelines: ScrollScan["nativeTimelines"] = [];

  function docHeight(): number | null {
    try {
      const de = doc?.documentElement;
      const body = doc?.body;
      const h = Math.round(
        Math.max(de ? de.scrollHeight || 0 : 0, body ? body.scrollHeight || 0 : 0),
      );
      return Number.isFinite(h) ? h : null;
    } catch {
      return null;
    }
  }
  const startHeight = docHeight();

  // CSS selector path up to depth 6: tagName lowercase, nth-of-type
  // disambiguation only when same-tag siblings exceed 1.
  function selPath(el: any): string {
    const parts: string[] = [];
    let node = el;
    for (let depth = 0; node && depth < 6; depth++) {
      let part = String(node.tagName || "*").toLowerCase();
      try {
        const parent = node.parentElement;
        if (parent) {
          const same = Array.from(parent.children).filter(function (c: any) {
            return String(c.tagName) === String(node.tagName);
          });
          if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
        }
      } catch {}
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(">");
  }

  // Native CSS scroll-driven animation: ScrollTimeline subclass ⇒ "scroll",
  // ViewTimeline ⇒ "view".
  function classifyTimeline(anim: any): "css-scroll-timeline" | "css-view-timeline" | null {
    try {
      const timeline = anim?.timeline;
      if (!timeline || typeof win.ScrollTimeline !== "function") return null;
      if (!(timeline instanceof win.ScrollTimeline)) return null;
      if (typeof win.ViewTimeline === "function" && timeline instanceof win.ViewTimeline) {
        return "css-view-timeline";
      }
      return "css-scroll-timeline";
    } catch {
      return null;
    }
  }

  // GSAP ScrollTrigger atlas, however the site exposed it.
  let stGlobal: any = null;
  try {
    stGlobal = win.ScrollTrigger || win.gsap?.plugins?.ScrollTrigger || null;
  } catch {}

  // Exact/contained registry match for an element.
  function stOf(el: any): any {
    try {
      if (!stGlobal?.getAll) return null;
      const list = stGlobal.getAll().slice(0, 120);
      for (const st of list) {
        const t = st.trigger ?? st.getTrigger?.() ?? null;
        if (t && t.nodeType === 1 && t === el) return st;
      }
      for (const st of list) {
        const t = st.trigger ?? st.getTrigger?.() ?? null;
        if (t && t.nodeType === 1 && el && (t.contains?.(el) || el.contains?.(t))) return st;
      }
    } catch {}
    return null;
  }

  // Classification precedence: native timeline → ScrollTrigger → scroll-cue
  // data attributes → plain css-keyframe.
  function classify(anim: any, target: any): { trigger: ScrollTriggerSource; scrub: boolean; pin: boolean } {
    const tl = classifyTimeline(anim);
    if (tl) return { trigger: tl, scrub: false, pin: false };
    const st = stOf(target);
    if (st) {
      return {
        trigger: "gsap-scrolltrigger",
        scrub: Boolean(st.vars?.scrub),
        pin: Boolean(st.vars?.pin || st.pin),
      };
    }
    try {
      if (target?.closest?.("[data-aos],[data-scroll],[data-animate],[data-sal],[data-reveal]")) {
        return { trigger: "data-attr", scrub: false, pin: false };
      }
    } catch {}
    return { trigger: "css-keyframe", scrub: false, pin: false };
  }

  // Keyframe matrix sampling: first/mid/last ≤4 frames, ≤4 priority props
  // each, values clamped to 40 chars — keeps the serialized scan bounded.
  function sampleKeyframes(kfs: any[]): KeyframeSample[] {
    const KP = ["transform", "opacity", "filter", "clip-path", "color", "background-color", "width", "height"];
    const picks = kfs.length <= 4 ? kfs : [kfs[0], kfs[Math.floor(kfs.length / 2)], kfs[kfs.length - 1]];
    const out: KeyframeSample[] = [];
    for (const kf of picks.slice(0, 4)) {
      const props: Record<string, string> = {};
      let n = 0;
      for (const k of KP) {
        if (n >= 4) break;
        try {
          if (kf[k] != null) {
            props[k] = String(kf[k]).slice(0, 40);
            n++;
          }
        } catch {}
      }
      out.push({ offset: typeof kf.offset === "number" ? kf.offset : null, props });
    }
    return out;
  }

  // Pass 1: element animations from doc.getAnimations().
  try {
    const list = doc.getAnimations ? doc.getAnimations() : [];
    const seen = new Set<unknown>();
    let kfCount = 0; // rows that got a matrix — harvest cap: 60
    for (const a of list.slice(0, 200)) {
      try {
        const effect = a?.effect;
        const target = effect?.target;
        // One row per element: repeated Animation objects (transform + opacity
        // as separate animations on the same node) merge into the first row.
        if (!target || target.nodeType !== 1 || seen.has(target)) continue;
        seen.add(target);
        const keyframes = effect.getKeyframes ? effect.getKeyframes() : [];
        const props: string[] = [];
        for (const kf of keyframes) {
          for (const key of Object.keys(kf)) {
            if (key === "offset" || key === "easing" || key === "composite") continue;
            if (!props.includes(key)) props.push(key);
          }
        }
        if (props.length === 0) continue;
        const timing = effect.getComputedTiming ? effect.getComputedTiming() : null;
        const durationMs = typeof timing?.duration === "number" ? timing.duration : null;
        const delayMs = typeof timing?.delay === "number" ? timing.delay : null;
        const easing = timing?.easing && timing.easing !== "ease" ? String(timing.easing) : null;
        const cls = classify(a, target);
        // Keyframe matrix on the first 60 rows only — reuses the already
        // fetched `keyframes` from the props pass (no second getKeyframes).
        let matrix: KeyframeSample[] | undefined;
        if (kfCount < 60 && keyframes.length > 0) {
          try {
            matrix = sampleKeyframes(keyframes);
            kfCount++;
          } catch {}
        }
        anims.push({
          selector: selPath(target),
          tag: String(target.tagName || "*").toLowerCase(),
          props,
          durationMs,
          delayMs,
          easing,
          trigger: cls.trigger,
          scrub: cls.scrub,
          pin: cls.pin,
          svgStroke: props.some(function (p: string) {
            return p.startsWith("stroke-dash");
          }),
          ...(matrix ? { keyframes: matrix } : {}),
        });
      } catch {}
    }
  } catch {}

  // Pass 2: native scroll/view timelines for the anims classified above.
  try {
    const list = doc.getAnimations ? doc.getAnimations() : [];
    for (const a of list.slice(0, 200)) {
      const kind = classifyTimeline(a);
      if (!kind) continue;
      const target = a?.effect?.target;
      if (!target || target.nodeType !== 1) continue;
      nativeTimelines.push({
        selector: selPath(target),
        kind: kind === "css-view-timeline" ? "view" : "scroll",
      });
    }
  } catch {}

  // Pass 3: SMIL animations — selector of the owning SVG element.
  try {
    const smil = doc.querySelectorAll("animate, animateTransform, animateMotion");
    const smilArr: any[] = Array.from(smil ?? []);
    for (const s of smilArr.slice(0, 80)) {
      const owner = s.ownerSVGElement || s.parentElement;
      if (owner) smilSelectors.push(selPath(owner));
    }
  } catch {}

  // Pass 4: GSAP ScrollTrigger registry — compiled start/end px, live
  // progress, and bounded tween vars (≤20 rows, ≤24 chars per var value,
  // priority keys only; functions/objects skipped). Independent of
  // getAnimations, so it works even when animations are hidden from the Web
  // Animations API.
  const STVARS_KEYS = ["x", "y", "rotate", "scale", "scaleX", "scaleY", "opacity", "autoAlpha", "stagger", "width", "height"];
  const gsapTriggers: GsapTriggerRow[] = [];
  // Full registry size before any cap: gsapTriggers is a bounded SAMPLE
  // (≤20 rows), so its length cannot stand in for the registry total.
  let gsapRegistryTotal = 0;
  try {
    const allSt = stGlobal && stGlobal.getAll ? stGlobal.getAll() : [];
    gsapRegistryTotal = Array.isArray(allSt) ? allSt.length : 0;
    const stList = Array.isArray(allSt) ? allSt.slice(0, 120) : [];
    for (const st of stList) {
      if (gsapTriggers.length >= 20) break;
      try {
        const trig = st.trigger ?? st.getTrigger?.() ?? null;
        const vars: Record<string, string> = {};
        const tv = st.animation && st.animation.vars ? st.animation.vars : null;
        if (tv) {
          for (const vk of STVARS_KEYS) {
            try {
              const vv = tv[vk];
              if (vv !== undefined && typeof vv !== "object" && typeof vv !== "function") {
                vars[vk] = String(vv).slice(0, 24);
              }
            } catch {}
          }
        }
        gsapTriggers.push({
          selector: trig && trig.nodeType === 1 ? selPath(trig) : "",
          scrub: Boolean(st.vars?.scrub),
          pin: Boolean(st.vars?.pin || st.pin),
          startPx: typeof st.start === "number" ? st.start : null,
          endPx: typeof st.end === "number" ? st.end : null,
          progress: typeof st.progress === "number" ? st.progress : null,
          vars,
        });
      } catch {}
    }
  } catch {}

  // Rendered height at scan end (second half of the acquisition bracket).
  const documentHeight = docHeight();

  return { anims, smilSelectors, nativeTimelines, gsapTriggers, gsapRegistryTotal, startHeight, documentHeight };
};

// Phase-0 of the L3 scrub probe. Runs IN THE PAGE once, AFTER the census
// evaluate (page still open): re-reads the same stGlobal atlas the census
// used, picks the first ≤6 scrubbed triggers (Boolean(st.vars?.scrub),
// mirroring the census — the probe only samples scrubbed curves) with BOTH
// bounds compiled (numeric startPx AND endPx) and maps them to selector paths. The per-step snippet
// then re-finds these SAME triggers by selector path, so atlas order drift
// across steps cannot swap which trigger a curve belongs to. Plain function
// expression (no arrow — page.evaluate re-serializes the source), zero outer
// references, every probe try/caught. selPath is an inner copy of the
// SCROLL_CENSUS_SNIPPET helper (self-containment > DRY — see the census
// snippet comment; keep the two in sync).
export const SCRUB_PROBE_INTRO = function (): {
  maxScroll: number;
  triggers: { selector: string; startPx: number; endPx: number }[];
} {
  const g = globalThis as any;
  const out: { maxScroll: number; triggers: { selector: string; startPx: number; endPx: number }[] } = {
    maxScroll: 0,
    triggers: [],
  };
  try {
    const doc = g.document;
    const win = g;
    // Banked scroll range: scrollHeight minus the viewport, floored at 0.
    let sh = 0;
    try {
      sh = Math.round(doc.documentElement.scrollHeight || 0);
    } catch {}
    let ih = 0;
    try {
      ih = Math.round(win.innerHeight || 0);
    } catch {}
    out.maxScroll = sh > 0 ? Math.max(0, sh - ih) : 0;

    // CSS selector path up to depth 6: tagName lowercase, nth-of-type
    // disambiguation only when same-tag siblings exceed 1. (sync: selPath in
    // SCROLL_CENSUS_SNIPPET)
    function selPath(el: any): string {
      const parts: string[] = [];
      let node = el;
      for (let depth = 0; node && depth < 6; depth++) {
        let part = String(node.tagName || "*").toLowerCase();
        try {
          const parent = node.parentElement;
          if (parent) {
            const same = Array.from(parent.children).filter(function (c: any) {
              return String(c.tagName) === String(node.tagName);
            });
            if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
          }
        } catch {}
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(">");
    }

    // First ≤6 scrubbed registry triggers (Boolean(st.vars?.scrub), mirroring
    // the census — binding = scrubbed curves only) with both bounds compiled;
    // selector-path keyed so later steps can re-locate the same instance.
    try {
      const stGlobal = win.ScrollTrigger || win.gsap?.plugins?.ScrollTrigger || null;
      const list = stGlobal && stGlobal.getAll ? stGlobal.getAll().slice(0, 120) : [];
      for (const st of list) {
        if (out.triggers.length >= 6) break;
        try {
          if (!Boolean(st.vars?.scrub)) continue;
          if (typeof st.start !== "number" || typeof st.end !== "number") continue;
          const trig = st.trigger ?? st.getTrigger?.() ?? null;
          if (!trig || trig.nodeType !== 1) continue;
          out.triggers.push({ selector: selPath(trig), startPx: st.start, endPx: st.end });
        } catch {}
      }
    } catch {}
  } catch {}
  return out;
};

// Runs IN THE PAGE via page.evaluate(SCRUB_PROBE_STEP, selectors) once per
// scroll step: re-finds each saved trigger element by selector path, matches
// it back to the LIVE ScrollTrigger registry (stOf-style, same precedence as
// the census), and samples progress + computed transform (≤60 chars) + the
// page's actual scrollY. Rows keep the selectors' order. Plain function
// expression, no arrows, zero outer references, every probe try/caught.
// stOf is an inner copy of the SCROLL_CENSUS_SNIPPET helper (self-containment
// > DRY — see the census snippet comment; keep the two in sync).
export const SCRUB_PROBE_STEP = function (selectors: string[]): {
  progress: number | null;
  transform: string | null;
  scrollY: number;
}[] {
  const g = globalThis as any;
  const rows: { progress: number | null; transform: string | null; scrollY: number }[] = [];
  const sels = Array.isArray(selectors) ? selectors.slice(0, 6) : [];
  try {
    const doc = g.document;
    function stOf(el: any): any {
      try {
        const stGlobal = g.ScrollTrigger || g.gsap?.plugins?.ScrollTrigger || null;
        if (!stGlobal?.getAll) return null;
        const list = stGlobal.getAll().slice(0, 120);
        for (const st of list) {
          const t = st.trigger ?? st.getTrigger?.() ?? null;
          if (t && t.nodeType === 1 && t === el) return st;
        }
        for (const st of list) {
          const t = st.trigger ?? st.getTrigger?.() ?? null;
          if (t && t.nodeType === 1 && el && (t.contains?.(el) || el.contains?.(t))) return st;
        }
      } catch {}
      return null;
    }
    let scrollY = 0;
    try {
      scrollY = Math.round(g.scrollY) || 0;
    } catch {}
    for (const sel of sels) {
      const row = { progress: null as number | null, transform: null as string | null, scrollY };
      try {
        const el = doc.querySelector(String(sel));
        if (el) {
          const st = stOf(el);
          if (st && typeof st.progress === "number") row.progress = st.progress;
          try {
            row.transform = String(g.getComputedStyle(el).transform).slice(0, 60);
          } catch {}
        }
      } catch {}
      rows.push(row);
    }
  } catch {}
  return rows;
};

// Runs IN THE PAGE via page.evaluate(SCRUB_SCROLL_TO, y): one plain scroll
// command, same shape as pose3d.ts's SCROLL_TO (kept local — census must not
// import from pose3d).
export const SCRUB_SCROLL_TO = function (y: number): void {
  try {
    (globalThis as any).scrollTo(0, Math.max(0, Math.round(y)));
  } catch {}
};

// Runs IN THE PAGE via page.evaluate after the census: second half of the
// acquisition bracket. A height delta means content landed while the census
// was sampling, so the fingerprint describes a half-acquired page. Height can
// miss content that arrives after this probe — that residual limit is why the
// acquisition block is reported rather than treated as a guarantee.
export const ACQUISITION_HEIGHT = function (): number | null {
  try {
    const doc = (globalThis as any).document;
    const de = doc && doc.documentElement;
    const body = doc && doc.body;
    return Math.round(
      Math.max(de ? de.scrollHeight || 0 : 0, body ? body.scrollHeight || 0 : 0),
    );
  } catch {
    return null;
  }
};

// PURE: aggregates a raw scan into the census. Counts per trigger source,
// propagates stroke flags (SMIL owners count as strokes), sorts the preview
// list scrub-first then pin-first.
export function reduceScrollCensus(
  url: string,
  scan: ScrollScan,
  now: number,
  reducedMotion = false,
): ScrollCensus {
  const counts = Object.fromEntries(TRIGGER_SOURCES.map(function (k) {
    return [k, 0];
  })) as Record<ScrollTriggerSource, number>;

  const strokes = new Set(scan.smilSelectors);
  for (const a of scan.anims) {
    counts[a.trigger] = (counts[a.trigger] ?? 0) + 1;
    // Trust-borderline scans may carry the prop without the flag set; derive
    // from stroke-dash* props so svgStrokes stays complete.
    a.svgStroke = Boolean(a.svgStroke) || (a.props ?? []).some(function (p) {
      return typeof p === "string" && p.startsWith("stroke-dash");
    });
    if (a.svgStroke) strokes.add(a.selector);
  }
  if (scan.smilSelectors.length > 0) counts.smil = scan.smilSelectors.length;

  const anims = [...scan.anims].sort(function (a, b) {
    if (a.scrub !== b.scrub) return a.scrub ? -1 : 1;
    if (a.pin !== b.pin) return a.pin ? -1 : 1;
    return 0;
  });

  return {
    url,
    capturedAt: now,
    counts,
    anims,
    svgStrokes: [...strokes],
    nativeScrollTimelines: scan.nativeTimelines.length,
    gsapTriggers: scan.gsapTriggers,
    // Pre-cap registry total; the captured rows are only a bounded sample.
    gsapRegistryCount: scan.gsapRegistryTotal ?? scan.gsapTriggers.length,
    reducedMotion,
  };
}

export async function captureScrollCensus(
  url: string,
  opts?: {
    timeoutMs?: number;
    waitStrategy?: WaitStrategy;
    viewport?: ViewportName;
    reducedMotion?: boolean;
    scrubProbe?: boolean;
    loader?: () => Promise<any>;
  },
): Promise<ScrollCensus | { error: string }> {
  let chrome: any;
  try {
    // Lazy default: playwright is only touched when the tool actually runs.
    const loader = opts?.loader ?? (() => import("playwright" as string));
    ({ chromium: chrome } = await loader());
    const browser = await chrome.launch();
    try {
      // Viewport profile split as in structure.ts: width/height fill the
      // `viewport` key; mobile-profile flags are sibling context options.
      const { width, height, ...contextOpts } = resolveViewport(opts?.viewport ?? "desktop");
      const page = await browser.newPage({
        viewport: { width, height },
        ...contextOpts,
        ...(opts?.reducedMotion ? { reducedMotion: "reduce" as const } : {}),
      });
      await installSnippetShims(page);
      await page.goto(url, {
        waitUntil: opts?.waitStrategy ?? "networkidle",
        timeout: opts?.timeoutMs ?? 45_000,
      });
      await page.waitForTimeout(3000);
      await preScroll(page);
      await page.waitForTimeout(500);
      const scan = (await page.evaluate(SCROLL_CENSUS_SNIPPET)) as ScrollScan;
      const census = reduceScrollCensus(url, scan, Date.now(), !!opts?.reducedMotion);
      // Acquisition disclosure: record what the fixed waits actually sampled.
      // The bracket is start-of-evaluate -> end-of-evaluate -> post-evaluate
      // probe; any height delta across those three points means async content
      // landed mid-capture (stable:false). Content that arrives before the
      // evaluate starts is already in all three and cannot be detected. A
      // failed probe leaves stable:null rather than claiming stability.
      const scanHeight = (v: unknown): number | null =>
        typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
      const startHeight = scanHeight(scan.startHeight);
      const sampledHeight = scanHeight(scan.documentHeight);
      let afterHeight: number | null = null;
      try {
        afterHeight = scanHeight(await page.evaluate(ACQUISITION_HEIGHT));
      } catch {
        /* probe is best-effort: stable stays null */
      }
      census.acquisition = {
        waitStrategy: opts?.waitStrategy ?? "networkidle",
        settleMs: 3000,
        postScrollMs: 500,
        capturedAt: census.capturedAt,
        documentHeight: startHeight ?? sampledHeight ?? afterHeight,
        animationCount: census.anims.length,
        gsapRegistryCount: census.gsapRegistryCount,
        stable: (() => {
          const sawMismatch =
            (startHeight !== null && sampledHeight !== null && startHeight !== sampledHeight) ||
            (sampledHeight !== null && afterHeight !== null && sampledHeight !== afterHeight) ||
            (startHeight !== null && afterHeight !== null && startHeight !== afterHeight);
          if (sawMismatch) return false;
          return startHeight !== null && sampledHeight !== null && afterHeight !== null
            ? true
            : null;
        })(),
      };
      // L3 scrub probe: opt-in second phase, page still open after the census
      // evaluate. Drives ≤8 evenly spaced scrollTo steps across 0..maxScroll
      // and samples the same triggers' live progress each step. ZERO extra
      // evaluates when the flag is off, and scrubCurves stays absent unless
      // the flag was set (lean-pack contract, pinned by tests).
      if (opts?.scrubProbe) {
        const curves: ScrubCurve[] = [];
        try {
          const intro = (await page.evaluate(SCRUB_PROBE_INTRO)) as {
            maxScroll: number;
            triggers: { selector: string; startPx: number; endPx: number }[];
          };
          const triggers = (intro && Array.isArray(intro.triggers) ? intro.triggers : []).filter(
            function (t) {
              return (
                t &&
                typeof t.selector === "string" &&
                t.selector.length > 0 &&
                typeof t.startPx === "number" &&
                typeof t.endPx === "number"
              );
            },
          ).slice(0, 6);
          const maxScroll =
            intro && typeof intro.maxScroll === "number" && intro.maxScroll > 0
              ? Math.floor(intro.maxScroll)
              : 0;
          if (triggers.length > 0 && maxScroll > 0) {
            // Rows are sampled in the triggers' order, so per-trigger buckets
            // align by index — no selector-key collisions between curves.
            const perTrigger: ScrubProbeSample[][] = triggers.map(function () {
              return [];
            });
            let lastY = -1;
            for (let step = 0; step < 8; step++) {
              const y = Math.round((maxScroll * step) / 7);
              // Evenly spaced points only repeat when maxScroll is 0 (loop is
              // guarded above) — still honor "visited y ⇒ skip the scroll,
              // keep the sample".
              if (y !== lastY) {
                lastY = y;
                try {
                  await page.evaluate(SCRUB_SCROLL_TO, y);
                } catch {
                  /* a refused scroll still gets sampled at the old offset */
                }
                await page.waitForTimeout(150);
              }
              try {
                const rows = (await page.evaluate(
                  SCRUB_PROBE_STEP,
                  triggers.map(function (t) {
                    return t.selector;
                  }),
                )) as ScrubProbeSample[];
                for (let i = 0; i < triggers.length; i++) {
                  const row = rows && rows[i] ? rows[i] : null;
                  perTrigger[i].push({
                    scrollY:
                      row && typeof row.scrollY === "number" ? row.scrollY : y,
                    progress:
                      row && typeof row.progress === "number" ? row.progress : null,
                    transform:
                      row && typeof row.transform === "string" ? row.transform : null,
                  });
                }
              } catch {
                /* the step fails for all triggers; keep what earlier steps got */
              }
            }
            // Silence per-trigger failures: one null progress (element or
            // registry row unresolvable at any step) drops that trigger from
            // the curves and the probe continues.
            for (let i = 0; i < triggers.length; i++) {
              const steps = perTrigger[i];
              if (steps.length === 0) continue;
              if (steps.some(function (s) {
                return s.progress === null;
              })) {
                continue;
              }
              curves.push({
                selector: triggers[i].selector,
                startPx: triggers[i].startPx,
                endPx: triggers[i].endPx,
                steps: steps.map(function (s) {
                  return { scrollY: s.scrollY, progress: s.progress as number, transform: s.transform };
                }),
              });
            }
          }
        } catch {
          /* probe is best-effort: any phase failure leaves curves empty */
        }
        // Flag ON: the key is always present ([] when nothing probed).
        census.scrubCurves = curves;
      }
      return census;
    } finally {
      try {
        await browser.close();
      } catch {
        /* keep the primary error */
      }
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

