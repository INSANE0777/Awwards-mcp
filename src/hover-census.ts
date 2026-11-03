import { installSnippetShims } from "./structure.js";
import { resolveViewport, type ViewportName } from "./viewport.js";

/** One running CSS animation captured mid-hover (bounded at 6 per sample). */
export interface ActiveAnim {
  sel: string;
  name: string;
  durationMs: number | null;
  easing: string | null;
}

/** ACTIVE_ANIMS_SNIPPET's return: live geometry, inline transform, running anims. */
export interface ActiveAnimsResult {
  rect: { x: number; y: number; width: number; height: number } | null;
  transform: string | null;
  anims: ActiveAnim[];
}

/** One element's measured :hover response. */
export interface HoverSample {
  selector: string;
  changedProps: string[];
  transitionMs: number | null;
  easing: string | null;
  /** Running CSS animations while hovered (L5). Pushed only when non-empty. */
  activeAnims?: ActiveAnim[];
  /** Inline transform samples across the micro-move sweep (L5, ≤4 entries). */
  styleTrail?: string[];
}

/** What captureHoverCensus returns. */
export interface HoverCensus {
  url: string;
  capturedAt: number;
  hoverRuleCount: number;
  candidates: number;
  samples: HoverSample[];
  reducedMotion: boolean;
  /** B4: touch-only viewports skip the hover loop (pointer events don't reliably fire); records why samples is empty. */
  note?: string;
}

/** Serialized getComputedStyle row: the 13 watched props + transition metadata. */
export interface HoverStyleRow {
  [key: string]: string | null;
}

/** The 13 computed-style properties the census watches across a hover. */
export const HOVER_PROPS = [
  "transform",
  "color",
  "backgroundColor",
  "opacity",
  "filter",
  "boxShadow",
  "letterSpacing",
  "borderRadius",
  "clipPath",
  "scale",
  "translate",
  "fill",
  "stroke",
];

const MAX_SAMPLES = 20;

// Task 4 wiring contract: server.ts createHandlers deps get an optional
// hoverCensusFn of this shape (peers: AnalyzeFn/ScrollMapFn in server.ts).
export type HoverCensusFn = (
  url: string,
  opts?: {
    waitStrategy?: "load" | "domcontentloaded" | "networkidle";
    viewport?: ViewportName;
    reducedMotion?: boolean;
  },
) => Promise<HoverCensus | { error: string }>;

// Runs IN THE PAGE via page.evaluate. Pass 1: bounded recursive walk over the
// CSSOM harvesting every rule whose selector mentions ":hover" (split on ","
// so compound selector lists count per-part). Pass 2: label up to MAX_SAMPLES
// hover-candidate elements that match a harvested rule with data-__hidx so the
// orchestrator can page.hover them one at a time. Must be a plain `function`
// expression (no arrow — page.evaluate re-serializes the source) with zero
// outer references: helpers live inside the body, browser globals go through
// globalThis (Node tsconfig has no DOM lib), and every probe is try/caught so
// a hostile page still yields a partial census. Mirrors SCROLL_CENSUS_SNIPPET
// (census.ts).
export const HOVER_RULES_SNIPPET = function (): {
  rules: string[];
  candidates: string[];
} {
  const g = globalThis as any;
  const doc = g.document;

  // Bounded recursion: slice(0..800) at every level so a toxic stylesheet
  // can't stall the census; recurses into grouping rules (media/supports/
  // nested CSS) via .cssRules.
  function collect(ruleList: any, out: string[]): string[] {
    try {
      const arr: any[] = Array.from(ruleList ?? []).slice(0, 800);
      for (const r of arr) {
        const sel = r?.selectorText;
        if (typeof sel === "string" && sel.indexOf(":hover") !== -1) {
          const parts = sel.split(",");
          for (const part of parts) {
            if (part.indexOf(":hover") !== -1) out.push(part.trim());
            if (out.length >= 400) return out;
          }
        }
        if (r && r.cssRules) collect(r.cssRules, out);
        if (out.length >= 400) return out;
      }
    } catch {}
    return out;
  }

  const rules: string[] = collect(doc.styleSheets, []);

  const candidates: string[] = [];
  try {
    const pool = doc.querySelectorAll(
      "a,button,[role='button'],input[type='submit'],label,[data-hover]",
    );
    const arr: any[] = Array.from(pool ?? []).slice(0, 120);
    for (const el of arr) {
      if (candidates.length >= 20) break;
      let matched = false;
      for (const sel of rules) {
        try {
          // ":hover" never matches at rest (live hover state is inactive), so
          // candidates are matched with :hover stripped. Residual limitation:
          // descendant-hover rules (.card:hover .title) label the target
          // element (.title), not the trigger (.card).
          if (el.matches(sel.replace(/:hover/g, ""))) {
            matched = true;
            break;
          }
        } catch {}
      }
      if (!matched) continue;
      try {
        el.setAttribute("data-__hidx", String(candidates.length));
      } catch {}
      candidates.push(String(el.tagName || "*").toLowerCase());
    }
  } catch {}
  return { rules, candidates };
};

// Runs IN THE PAGE via page.evaluate(HOVER_SNAPSHOT_SNIPPET, idx). Returns the
// 13 watched computed-style props (plus transition duration/timing-function)
// for the element labeled data-__hidx="idx", or null when the element is
// missing (the orchestrator skips the index). Plain `function` expression, no
// arrows, browser globals via globalThis.
export const HOVER_SNAPSHOT_SNIPPET = function (idx: number): HoverStyleRow | null {
  const g = globalThis as any;
  const doc = g.document;
  try {
    const el = doc.querySelector("[data-__hidx='" + idx + "']");
    if (!el) return null;
    const cs = g.getComputedStyle(el);
    const out: HoverStyleRow = {};
    const props = [
      "transform",
      "color",
      "backgroundColor",
      "opacity",
      "filter",
      "boxShadow",
      "letterSpacing",
      "borderRadius",
      "clipPath",
      "scale",
      "translate",
      "fill",
      "stroke",
    ];
    for (const p of props) {
      try {
        // getPropertyValue(p) returns "" for camelCase names in real browsers
        // (CSSOM matches kebab-case declaration names only) — camelCase IDL
        // property access reads the same cascade. Kebab fallback + null for "".
        const v = cs ? String(cs[p] ?? cs.getPropertyValue(p) ?? "") : null;
        out[p] = v === "" ? null : v;
      } catch {
        out[p] = null;
      }
    }
    try {
      out.__transitionDuration = cs ? String(cs.transitionDuration) : null;
    } catch {
      out.__transitionDuration = null;
    }
    try {
      out.__transitionTimingFunction = cs ? String(cs.transitionTimingFunction) : null;
    } catch {
      out.__transitionTimingFunction = null;
    }
    return out;
  } catch {
    return null;
  }
};

// Runs IN THE PAGE via page.evaluate(ACTIVE_ANIMS_SNIPPET, idx). L5 precision:
// while the pointer is on the element, returns its live geometry, the inline
// transform (mid-flight translate/scale, sliced to 60 chars) and up to 6
// running animations with timing (name sliced to 40, browser-default "ease"
// easing dropped). The orchestrator calls it before and after a micro-move
// sweep and folds the results into HoverSample.activeAnims/styleTrail.
// Plain `function` expression, no arrows, browser globals via globalThis,
// every probe try/caught so a hostile page degrades to nulls, not a crash.
export const ACTIVE_ANIMS_SNIPPET = function (idx: number): ActiveAnimsResult {
  const g = globalThis as any;
  const doc = g.document;
  const el = doc.querySelector("[data-__hidx='" + idx + "']");
  const r = el ? el.getBoundingClientRect() : null;
  let transform: string | null = null;
  try {
    transform =
      el && (el as any).style && (el as any).style.transform
        ? String((el as any).style.transform).slice(0, 60)
        : null;
  } catch {}
  const anims: any[] = [];
  try {
    const list: any[] = doc.getAnimations ? doc.getAnimations() : [];
    for (const an of list) {
      if (anims.length >= 6) break;
      try {
        const t: string = String(
          (an.effect?.target && an.effect.target.nodeType === 1)
            ? (an.effect.target.tagName || "").toLowerCase()
            : "",
        );
        const timing = an.effect?.getTiming ? an.effect.getTiming() : null;
        anims.push({
          sel: t,
          name: String(
            an.animationName || (an.effect?.target === el ? "hover-target" : "anim"),
          ).slice(0, 40),
          durationMs:
            timing && typeof timing.duration === "number" ? timing.duration : null,
          easing:
            timing && typeof timing.easing === "string" && timing.easing !== "ease"
              ? String(timing.easing).slice(0, 40)
              : null,
        });
      } catch {}
    }
  } catch {}
  return {
    rect: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
    transform: transform,
    anims: anims,
  };
};

// PURE. Resting-vs-hovered snapshot diff: changedProps are HOVER_PROPS whose
// string values differ; transitionMs is the max of the comma-separated
// transition-duration list (s × 1000, ms as-is), null when all entries are 0;
// easing is dropped when it's the browser default ("ease"/"normal"/empty).
export function diffHoverStyles(
  before: HoverStyleRow | null | undefined,
  after: HoverStyleRow | null | undefined,
): { changedProps: string[]; transitionMs: number | null; easing: string | null } {
  const changedProps: string[] = [];
  if (!before || !after) return { changedProps, transitionMs: null, easing: null };
  for (const p of HOVER_PROPS) {
    if (before[p] !== after[p]) changedProps.push(p);
  }
  let transitionMs: number | null = null;
  const raw = String(after.__transitionDuration ?? "").trim();
  if (raw) {
    let maxMs = 0;
    for (const part of raw.split(",")) {
      const v = parseFloat(part);
      if (Number.isNaN(v)) continue;
      const ms = part.trim().endsWith("ms") ? v : v * 1000;
      if (ms > maxMs) maxMs = ms;
    }
    transitionMs = maxMs > 0 ? maxMs : null;
  }
  const ease = String(after.__transitionTimingFunction ?? "").trim();
  const easing = ease && ease !== "ease" && ease !== "normal" ? ease : null;
  return { changedProps, transitionMs, easing };
}

// Playwright orchestrator for the hover census. Same pattern as
// captureScrollCensus (census.ts): lazy/injectable loader, resolveViewport
// contextOpts with reduce-motion spread, goto + settle, outer catch →
// { error }, finally { browser.close() } with inner try/catch.
export async function captureHoverCensus(
  url: string,
  opts?: {
    timeoutMs?: number;
    waitStrategy?: "load" | "domcontentloaded" | "networkidle";
    viewport?: ViewportName;
    reducedMotion?: boolean;
    loader?: () => Promise<any>;
    /** Route every browser connection through this loopback guard proxy. */
    proxyServer?: string;
  },
): Promise<HoverCensus | { error: string }> {
  let chrome: any;
  try {
    // Lazy default: playwright is only touched when the tool actually runs.
    const loader = opts?.loader ?? (() => import("playwright" as string));
    ({ chromium: chrome } = await loader());
    const browser = await chrome.launch(
      opts?.proxyServer
        ? { proxy: { server: opts.proxyServer, bypass: "<-loopback>" } }
        : {},
    );
    try {
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
      await page.waitForTimeout(2000);
      const scan = (await page.evaluate(HOVER_RULES_SNIPPET)) as {
        rules: string[];
        candidates: string[];
      };
      // Touch-only viewport (mobile): synthetic pointer hover doesn't reliably
      // fire there, so the interaction loop is skipped entirely and the census
      // says why instead of returning misleading sampleless counts.
      if (contextOpts.hasTouch) {
        return {
          url,
          capturedAt: Date.now(),
          hoverRuleCount: scan.rules.length,
          candidates: scan.rules.length,
          samples: [],
          reducedMotion: !!opts?.reducedMotion,
          note: "touch-only context — hover interactions skipped",
        };
      }
      const samples: HoverSample[] = [];
      for (let i = 0; i < MAX_SAMPLES; i++) {
        let before: HoverStyleRow | null = null;
        try {
          before = (await page.evaluate(HOVER_SNAPSHOT_SNIPPET, i)) as HoverStyleRow | null;
        } catch {
          continue;
        }
        if (!before) continue;
        let hovered = false;
        try {
          await page.hover("[data-__hidx='" + i + "']", { timeout: 2000 });
          hovered = true;
        } catch {
          hovered = false;
        }
        // L5 precision: probe the element WHILE hovered — live anims + inline
        // transform before and after a bounded sweep across it (≤3 moves, adds
        // ~0.5s per probed candidate; the hover timeout above bounds failures).
        let anims: ActiveAnim[] = [];
        let trail: string[] = [];
        if (hovered) {
          let active0: ActiveAnimsResult | null = null;
          try {
            active0 = (await page.evaluate(ACTIVE_ANIMS_SNIPPET, i)) as ActiveAnimsResult | null;
          } catch {}
          if (active0?.transform) trail.push(active0.transform);
          try {
            const rect = active0?.rect;
            if (rect && rect.width > 0 && rect.height > 0) {
              // Sweep left-half → right-half → center to wake pointermove-path
              // effects, then resample.
              await page.mouse.move(rect.x + rect.width * 0.35, rect.y + rect.height * 0.5);
              await page.waitForTimeout(80);
              await page.mouse.move(rect.x + rect.width * 0.7, rect.y + rect.height * 0.5);
              await page.waitForTimeout(80);
              await page.mouse.move(rect.x + rect.width * 0.5, rect.y + rect.height * 0.5);
              await page.waitForTimeout(80);
            }
          } catch {}
          let active1: ActiveAnimsResult | null = null;
          try {
            active1 = (await page.evaluate(ACTIVE_ANIMS_SNIPPET, i)) as ActiveAnimsResult | null;
          } catch {}
          if (active1?.transform && trail.length < 4) trail.push(active1.transform);
          anims = active1 && active1.anims.length > 0 ? active1.anims : active0?.anims ?? [];
          await page.waitForTimeout(450);
        }
        let after: HoverStyleRow | null = before;
        try {
          after = (await page.evaluate(HOVER_SNAPSHOT_SNIPPET, i)) as HoverStyleRow | null;
        } catch {}
        try {
          await page.mouse.move(0, 0);
          await page.waitForTimeout(250);
        } catch {}
        const d = diffHoverStyles(before, after);
        if (d.changedProps.length > 0) {
          const sample: HoverSample = { selector: "hover-candidate-" + i, ...d };
          // Lean packs: enrich only pushed samples, only with non-empty data.
          if (anims.length > 0) sample.activeAnims = anims;
          if (trail.length > 0) sample.styleTrail = trail;
          samples.push(sample);
        }
      }
      return {
        url,
        capturedAt: Date.now(),
        hoverRuleCount: scan.rules.length,
        candidates: scan.rules.length,
        samples,
        reducedMotion: !!opts?.reducedMotion,
      };
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
