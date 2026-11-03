import { describe, expect, it } from "vitest";
import {
  SCROLL_CENSUS_SNIPPET,
  SCRUB_PROBE_INTRO,
  SCRUB_PROBE_STEP,
  SCRUB_SCROLL_TO,
  ACQUISITION_HEIGHT,
  reduceScrollCensus,
  captureScrollCensus,
  sampleKeyframes,
} from "../src/census.js";
import type { RawAnim, ScrollScan, GsapTriggerRow } from "../src/census.js";

// Fixture builder: Trigger is used verbatim in results, so tests can encode
// expected counts by handing raw anims pre-classified (the snippet owns the
// in-page classification; the reducer trusts it).
const anim = (p: Partial<RawAnim>): RawAnim => ({
  selector: p.selector ?? "div.x",
  tag: p.tag ?? "div",
  props: p.props ?? ["transform"],
  durationMs: p.durationMs ?? 600,
  delayMs: p.delayMs ?? null,
  easing: p.easing ?? null,
  trigger: p.trigger ?? "css-keyframe",
  scrub: p.scrub ?? false,
  pin: p.pin ?? false,
  svgStroke: false,
});

const scan: ScrollScan = {
  anims: [
    anim({ selector: "section.hero", trigger: "css-keyframe" }),
    anim({ selector: "div.scrub", trigger: "gsap-scrolltrigger", scrub: true }),
    anim({ selector: "p.view", trigger: "css-view-timeline" }),
    anim({ selector: "div.pin", trigger: "gsap-scrolltrigger", pin: true }),
  ],
  smilSelectors: ["svg#logo"],
  nativeTimelines: [{ selector: "main", kind: "scroll" }],
  gsapTriggers: [],
  gsapRegistryTotal: 0,
};

describe("reduceScrollCensus", () => {
  it("counts by trigger and sorts anims with scrub/pin first", () => {
    const c = reduceScrollCensus("https://example.com", scan, 1700000000000);
    expect(c.counts["gsap-scrolltrigger"]).toBe(2);
    expect(c.counts["css-keyframe"]).toBe(1);
    expect(c.counts["css-view-timeline"]).toBe(1);
    expect(c.anims[0].selector).toBe("div.scrub");
    expect(c.svgStrokes).toEqual(["svg#logo"]);
    expect(c.nativeScrollTimelines).toBe(1);
    expect(c.url).toBe("https://example.com");
    expect(c.capturedAt).toBe(1700000000000);
    expect(c.reducedMotion).toBe(false);
  });

  it("marks svgStroke when stroke props are animated", () => {
    const c = reduceScrollCensus("u", {
      anims: [anim({ selector: "svg path", props: ["stroke-dashoffset"] })],
      smilSelectors: [],
      nativeTimelines: [],
      gsapTriggers: [],
      gsapRegistryTotal: 0,
    }, 1);
    expect(c.anims[0].svgStroke).toBe(true);
    expect(c.svgStrokes).toContain("svg path");
  });

  it("passes keyframes through to the census unchanged", () => {
    const c = reduceScrollCensus("u", {
      anims: [{ ...anim({}), keyframes: [{ offset: 0, props: { transform: "none" } }] }],
      smilSelectors: [],
      nativeTimelines: [],
      gsapTriggers: [],
      gsapRegistryTotal: 0,
    }, 1);
    expect(c.anims[0].keyframes).toEqual([{ offset: 0, props: { transform: "none" } }]);
  });

  it("passes gsapTriggers through to the census preserving order", () => {
    const rows: GsapTriggerRow[] = [
      { selector: "div.a", scrub: true, pin: false, startPx: 0, endPx: 500, progress: 0.5, vars: { y: "100" } },
      { selector: "", scrub: false, pin: false, startPx: null, endPx: null, progress: null, vars: {} },
    ];
    const c = reduceScrollCensus("u", {
      anims: [],
      smilSelectors: [],
      nativeTimelines: [],
      gsapTriggers: rows,
      gsapRegistryTotal: 2,
    }, 1);
    expect(c.gsapTriggers).toEqual(rows);
    // Registry total is always emitted and stays separate from the animation
    // tally in counts["gsap-scrolltrigger"].
    expect(c.gsapRegistryCount).toBe(2);
    expect(c.counts["gsap-scrolltrigger"]).toBe(0);
  });
});

describe("SCROLL_CENSUS_SNIPPET", () => {
  it("is a self-contained browser function (serializable, no outer refs)", () => {
    // Plain function expression like SCAN_SNIPPET/MOTION_SNIPPET, not an arrow —
    // page.evaluate re-serializes the source, so no arrows and no outer
    // closure refs may appear.
    expect(String(SCROLL_CENSUS_SNIPPET)).not.toContain("=>");
    expect(typeof SCROLL_CENSUS_SNIPPET).toBe("function");
  });

  it("harvests bounded keyframe matrices (source-lock)", () => {
    // Harness fallback: this suite has no fake-document snippet executor, so
    // lock the harvest call site and the 60-row cap on the serialized source.
    // (The props pass already called effect.getKeyframes(), so "getKeyframes"
    // alone is not the signal — the cap lock is.)
    const src = String(SCROLL_CENSUS_SNIPPET);
    expect(src).toContain("getKeyframes");
    expect(src).toContain("kfCount < 60");
  });

  it("harvests the GSAP registry with exact bounds (source-lock)", () => {
    // 20-row cap, 24-char var clamp, and the brief's 11 priority vars keys.
    const src = String(SCROLL_CENSUS_SNIPPET);
    expect(src).toContain("gsapTriggers.length >= 20");
    expect(src).toContain(".slice(0, 24)");
    expect(src).toContain("autoAlpha");
    expect(src).toContain("gsapTriggers");
  });
});

describe("sampleKeyframes", () => {
  it("samples first/mid/last frames with ≤4 priority props and 40-char values", () => {
    const long = "0123456789012345678901234567890123456789EXTRA";
    const kfs = Array.from({ length: 10 }, (_, i) => ({
      offset: i / 10,
      transform: "translateX(" + i + "px)",
      opacity: String(i % 2),
      color: long,
      width: "10px",
      margin: "0px",
    }));
    const out = sampleKeyframes(kfs);
    expect(out.length).toBe(3);
    expect(out[0].offset).toBe(0);
    expect(out[2].offset).toBe(0.9);
    for (const kf of out) {
      expect(Object.keys(kf.props).length).toBeLessThanOrEqual(4);
      for (const v of Object.values(kf.props)) expect(String(v).length).toBeLessThanOrEqual(40);
    }
    // Priority-ordered, unprioritized props dropped, long values clamped.
    expect(Object.keys(out[0].props)).toEqual(["transform", "opacity", "color", "width"]);
    expect(out[0].props.color).toBe(long.slice(0, 40));
  });

  it("keeps all frames when ≤4 and nulls non-number offsets", () => {
    const out = sampleKeyframes([
      { offset: 0, transform: "none" },
      { offset: "half", opacity: "1" },
      { offset: 1, transform: "scale(2)" },
    ]);
    expect(out.length).toBe(3);
    expect(out[1].offset).toBeNull();
    expect(out[1].props).toEqual({ opacity: "1" });
    expect(out[2].props).toEqual({ transform: "scale(2)" });
  });

  it("returns [] for an empty matrix", () => {
    expect(sampleKeyframes([])).toEqual([]);
  });
});

// Direct snippet execution: the harness below routes a fixed fixture through
// page.evaluate, but the GSAP registry pass needs a fake ScrollTrigger global,
// so these tests stub globalThis (restored in finally) and call the snippet
// body in-process — the DOM passes no-op harmlessly under their own try/catch.
describe("gsapTriggers capture (direct snippet run)", () => {
  const g = globalThis as any;

  function withST<T>(stGlobal: unknown, fn: () => T): T {
    const prev = g.ScrollTrigger;
    g.ScrollTrigger = stGlobal;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete g.ScrollTrigger;
      else g.ScrollTrigger = prev;
    }
  }

  it("captures compiled ScrollTrigger numerics + tween vars (bounded)", () => {
    const el = { nodeType: 1, tagName: "DIV" };
    const fakeST = {
      getAll: function () {
        return [{
          trigger: el,
          start: 640,
          end: 1800,
          progress: 0.3,
          animation: { vars: { y: 100, stagger: 0.09, onUpdate: function () {} } },
        }];
      },
    };
    const scan = withST(fakeST, SCROLL_CENSUS_SNIPPET);
    const gt = scan.gsapTriggers;
    expect(gt.length).toBe(1);
    expect(gt[0].startPx).toBe(640);
    expect(gt[0].endPx).toBe(1800);
    expect(gt[0].progress).toBe(0.3);
    expect(gt[0].selector).toBe("div");
    expect(gt[0].scrub).toBe(false);
    expect(gt[0].pin).toBe(false);
    expect(gt[0].vars.y).toBe("100");
    expect(gt[0].vars.stagger).toBe("0.09");
    expect(gt[0].vars.onUpdate).toBeUndefined(); // functions/objects skipped
  });

  it("caps at 20 rows and nulls uncompiled numerics", () => {
    const fakeST = {
      getAll: function () {
        const arr: Record<string, never>[] = [];
        for (let i = 0; i < 25; i++) arr.push({});
        return arr;
      },
    };
    const scan = withST(fakeST, SCROLL_CENSUS_SNIPPET);
    expect(scan.gsapTriggers.length).toBe(20);
    // Regression: the detail rows are capped at 20, but the registry total is
    // the full pre-cap size and must flow through the reducer.
    expect(scan.gsapRegistryTotal).toBe(25);
    const census = reduceScrollCensus("u", scan, 1);
    expect(census.gsapRegistryCount).toBe(25);
    expect(census.gsapTriggers).toHaveLength(20);
    const row = scan.gsapTriggers[0];
    expect(row.startPx).toBeNull();
    expect(row.endPx).toBeNull();
    expect(row.progress).toBeNull();
    expect(row.selector).toBe("");
    expect(row.vars).toEqual({});
  });

  it("always emits gsapTriggers ([] when no GSAP)", () => {
    const scan = withST(undefined, SCROLL_CENSUS_SNIPPET);
    expect(scan.gsapTriggers).toEqual([]);
  });

  it("resolves a plugin-only registry (gsap.plugins.ScrollTrigger)", () => {
    const prevGsap = g.gsap;
    const prevST = g.ScrollTrigger;
    const fakeST = {
      getAll: function () {
        return [{ animation: { vars: { duration: 0.5, ease: "power1.out" } }, vars: { scrub: true } }];
      },
    };
    g.gsap = { plugins: { ScrollTrigger: fakeST } };
    delete g.ScrollTrigger;
    try {
      const census = reduceScrollCensus("u", SCROLL_CENSUS_SNIPPET(), 1);
      expect(census.gsapRegistryCount).toBe(1);
      expect(census.counts["gsap-scrolltrigger"]).toBe(0);
    } finally {
      if (prevGsap === undefined) delete g.gsap;
      else g.gsap = prevGsap;
      if (prevST === undefined) delete g.ScrollTrigger;
      else g.ScrollTrigger = prevST;
    }
  });
});

// Offline orchestrator harness: a fake page whose evaluate returns the fixture
// scan; a fake browser that hands it out; a loader resolving a fake chromium.
// fakeBrowser optionally records the context opts passed to newPage and can
// throw on newPage (reducedMotion + page-opts assertion).
function harness(scan: ScrollScan, newPageImpl?: (opts: unknown) => Promise<any>) {
  const fakePage = {
    addInitScript: async () => {},
    goto: async () => {},
    waitForTimeout: async () => {},
    evaluate: async () => scan,
  };
  let seenContextOpts: unknown = null;
  const fakeBrowser = {
    newPage: newPageImpl ?? (async (opts: unknown) => {
      seenContextOpts = opts;
      return fakePage;
    }),
    close: async () => {},
  };
  const loader = async () => ({
    chromium: { launch: async () => fakeBrowser },
  });
  return { loader, getSeenContextOpts: () => seenContextOpts, fakeBrowser };
}

describe("captureScrollCensus", () => {
  const currentScan: ScrollScan = {
    anims: [
      anim({ selector: "div.scrub", trigger: "gsap-scrolltrigger", scrub: true }),
    ],
    smilSelectors: [],
    nativeTimelines: [{ selector: "main", kind: "scroll" }],
    gsapTriggers: [],
    gsapRegistryTotal: 0,
  };

  it("records acquisition state and marks a height mismatch unstable", async () => {
    const run = async (scanHeight: number, afterHeight: number | null) => {
      const fakePage = {
        addInitScript: async () => {},
        goto: async () => {},
        waitForTimeout: async () => {},
        evaluate: async (fn: unknown) => {
          const src = String(fn);
          if (src.includes("getAnimations")) {
            return { ...currentScan, startHeight: scanHeight, documentHeight: scanHeight };
          }
          if (src.includes("documentElement")) return afterHeight;
          return undefined;
        },
      };
      const loader = async () => ({
        chromium: { launch: async () => ({ newPage: async () => fakePage, close: async () => {} }) },
      });
      return captureScrollCensus("https://example.com", { loader });
    };

    const stable = await run(5000, 5000);
    expect("error" in stable).toBe(false);
    if ("error" in stable) return;
    expect(stable.acquisition).toMatchObject({
      waitStrategy: "networkidle",
      settleMs: 3000,
      postScrollMs: 500,
      documentHeight: 5000,
      animationCount: 1,
      gsapRegistryCount: 0,
      stable: true,
    });
    expect(stable.acquisition!.capturedAt).toBe(stable.capturedAt);

    const mutated = await run(5000, 5600);
    if ("error" in mutated) throw new Error(mutated.error);
    expect(mutated.acquisition!.stable).toBe(false);

    // Content landing inside the census evaluate is caught even when the
    // post-evaluate probe matches the end height.
    const midEvaluate = await (async () => {
      const fakePage = {
        addInitScript: async () => {},
        goto: async () => {},
        waitForTimeout: async () => {},
        evaluate: async (fn: unknown) => {
          const src = String(fn);
          if (src.includes("getAnimations")) {
            return { ...currentScan, startHeight: 5000, documentHeight: 5600 };
          }
          if (src.includes("documentElement")) return 5600;
          return undefined;
        },
      };
      const loader = async () => ({
        chromium: { launch: async () => ({ newPage: async () => fakePage, close: async () => {} }) },
      });
      return captureScrollCensus("https://example.com", { loader });
    })();
    if ("error" in midEvaluate) throw new Error(midEvaluate.error);
    expect(midEvaluate.acquisition!.stable).toBe(false);

    // A proven mid-evaluate mismatch is false even when the final probe fails.
    const mismatchNoProbe = await (async () => {
      const fakePage = {
        addInitScript: async () => {},
        goto: async () => {},
        waitForTimeout: async () => {},
        evaluate: async (fn: unknown) => {
          const src = String(fn);
          if (src.includes("getAnimations")) {
            return { ...currentScan, startHeight: 5000, documentHeight: 5600 };
          }
          if (src.includes("documentElement")) return null;
          return undefined;
        },
      };
      const loader = async () => ({
        chromium: { launch: async () => ({ newPage: async () => fakePage, close: async () => {} }) },
      });
      return captureScrollCensus("https://example.com", { loader });
    })();
    if ("error" in mismatchNoProbe) throw new Error(mismatchNoProbe.error);
    expect(mismatchNoProbe.acquisition!.stable).toBe(false);

    // A failed/short probe must not claim stability it never observed.
    const unknown = await run(5000, null);
    if ("error" in unknown) throw new Error(unknown.error);
    expect(unknown.acquisition!.stable).toBeNull();
    expect(unknown.acquisition!.documentHeight).toBe(5000);
  });

  it("honours an explicit waitStrategy in the acquisition record", async () => {
    const { loader } = harness(currentScan);
    const result = await captureScrollCensus("https://example.com", { loader, waitStrategy: "load" });
    if ("error" in result) throw new Error(result.error);
    expect(result.acquisition!.waitStrategy).toBe("load");
    // The fake page returns the scan for the height probe too → no number.
    expect(result.acquisition!.stable).toBeNull();
  });

  it("captures a census through a fake browser", async () => {
    const { loader } = harness(currentScan);
    const result = await captureScrollCensus("https://example.com", { loader });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.url).toBe("https://example.com");
    expect(result.reducedMotion).toBe(false);
    expect(result.anims[0].trigger).toBe("gsap-scrolltrigger");
  });

  it("returns { error } when the browser fails to launch", async () => {
    const loader = async () => ({
      chromium: {
        launch: async () => {
          throw new Error("boom");
        },
      },
    });
    const result = await captureScrollCensus("https://example.com", { loader });
    expect("error" in result).toBe(true);
    expect(JSON.stringify(result)).toContain("boom");
  });

  it("emulates reduced motion when requested", async () => {
    const { loader, getSeenContextOpts } = harness(currentScan);
    const result = await captureScrollCensus("https://example.com", {
      loader,
      reducedMotion: true,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.reducedMotion).toBe(true);
    expect((getSeenContextOpts() as { reducedMotion?: string }).reducedMotion).toBe("reduce");
  });
});

// L3 scrub probe. The fake page routes evaluate calls by sniffing the snippet
// source (census / intro / scroll / step markers never overlap) and records
// the call sequence plus every commanded scrollY, so the disabled path can be
// pinned at zero extra evaluates and the enabled path checked against the
// brief's bounds.
type IntroFixture = { maxScroll: number; triggers: { selector: string; startPx: number; endPx: number }[] };

function probeHarness(
  scan: ScrollScan,
  intro: IntroFixture | Error,
  stepRowFn?: (selIndex: number) => { progress: number | null; transform: string | null },
) {
  const calls: string[] = [];
  const scrolled: number[] = [];
  const fakePage = {
    addInitScript: async () => {},
    goto: async () => {},
    waitForTimeout: async () => {},
    evaluate: async (fn: unknown, arg?: unknown) => {
      const src = String(fn);
      if (src.includes("getAnimations")) {
        calls.push("census");
        return scan;
      }
      if (src.includes("maxScroll")) {
        calls.push("intro");
        if (intro instanceof Error) throw intro;
        return intro;
      }
      // preScroll's settle loop also says scrollTo — mark it separately so
      // probe assertions can filter the always-present census-phase calls.
      if (src.includes("scrollTo(0, 0)")) {
        calls.push("prescroll");
        return undefined;
      }
      if (src.includes("Math.round(y)")) {
        calls.push("scroll");
        scrolled.push(Number(arg));
        return undefined;
      }
      // Acquisition height probe runs after every census; it is not a probe
      // phase call, so keep it out of the phase assertions below.
      if (src.includes("documentElement")) {
        calls.push("height");
        return 0;
      }
      calls.push("step");
      const count = intro instanceof Error ? 0 : intro.triggers.length;
      const lastY = scrolled.length > 0 ? scrolled[scrolled.length - 1] : 0;
      return Array.from({ length: count }, (_, i) => ({
        scrollY: lastY,
        progress: stepRowFn ? stepRowFn(i).progress : 0.5,
        transform: stepRowFn ? stepRowFn(i).transform : "none",
      }));
    },
  };
  const fakeBrowser = {
    newPage: async () => fakePage,
    close: async () => {},
  };
  const loader = async () => ({ chromium: { launch: async () => fakeBrowser } });
  return { loader, calls, scrolled };
}

const introFixture: IntroFixture = {
  maxScroll: 7000,
  triggers: [
    { selector: "div.a", startPx: 0, endPx: 7000 },
    { selector: "div.b", startPx: 1000, endPx: 5000 },
  ],
};

describe("captureScrollCensus scrubProbe", () => {
  it("disabled: zero extra evaluates and scrubCurves stays absent", async () => {
    const { loader, calls, scrolled } = probeHarness(scan, introFixture);
    const result = await captureScrollCensus("https://example.com", { loader });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(calls.filter((c) => c !== "prescroll" && c !== "height")).toEqual(["census"]);
    expect(scrolled).toEqual([]);
    expect("scrubCurves" in result).toBe(false);
    expect(result.acquisition).toBeDefined();
  });

  it("enabled: drives ≤8 monotonic steps across 0..maxScroll with aligned curves", async () => {
    const { loader, calls, scrolled } = probeHarness(scan, introFixture);
    const result = await captureScrollCensus("https://example.com", {
      loader,
      scrubProbe: true,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    // preScroll + the acquisition height probe aside: 1 census + 1 intro +
    // 8 scrolls + 8 samples.
    const probing = calls.filter((c) => c !== "prescroll" && c !== "height");
    expect(probing[0]).toBe("census");
    expect(probing[1]).toBe("intro");
    expect(calls.filter((c) => c === "height").length).toBe(1);
    expect(calls.filter((c) => c === "scroll").length).toBe(8);
    expect(calls.filter((c) => c === "step").length).toBe(8);
    expect(scrolled.length).toBeLessThanOrEqual(8);
    expect(scrolled[0]).toBe(0);
    expect(scrolled[scrolled.length - 1]).toBe(7000);
    for (let i = 1; i < scrolled.length; i++) {
      expect(scrolled[i]).toBeGreaterThan(scrolled[i - 1]);
    }
    const curves = result.scrubCurves ?? [];
    expect(curves.length).toBe(2);
    expect(curves[0]).toEqual({
      selector: "div.a",
      startPx: 0,
      endPx: 7000,
      steps: [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000].map((y) => ({
        scrollY: y,
        progress: 0.5,
        transform: "none",
      })),
    });
    expect(curves[1]).toEqual({
      selector: "div.b",
      startPx: 1000,
      endPx: 5000,
      steps: [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000].map((y) => ({
        scrollY: y,
        progress: 0.5,
        transform: "none",
      })),
    });
  });

  it("silently drops a trigger whose progress is unreadable at any step", async () => {
    const { loader } = probeHarness(scan, introFixture, (i) => ({
      progress: i === 1 ? null : 0.25,
      transform: "none",
    }));
    const result = await captureScrollCensus("https://example.com", {
      loader,
      scrubProbe: true,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const curves = result.scrubCurves ?? [];
    expect(curves.length).toBe(1);
    expect(curves[0].selector).toBe("div.a");
    expect(curves[0].steps.every((s) => s.progress === 0.25)).toBe(true);
  });

  it("probe phase failure leaves scrubCurves empty (but present) and never throws", async () => {
    const { loader, scrolled } = probeHarness(scan, new Error("page exploded"));
    const result = await captureScrollCensus("https://example.com", {
      loader,
      scrubProbe: true,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.scrubCurves).toEqual([]);
    expect(scrolled).toEqual([]);
  });

  it("a page with no banked scroll range samples nothing", async () => {
    const { loader, calls, scrolled } = probeHarness(scan, {
      maxScroll: 0,
      triggers: [{ selector: "div.a", startPx: 0, endPx: 0 }],
    });
    const result = await captureScrollCensus("https://example.com", {
      loader,
      scrubProbe: true,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.scrubCurves).toEqual([]);
    expect(scrolled).toEqual([]);
    expect(calls.filter((c) => c !== "prescroll" && c !== "height")).toEqual(["census", "intro"]);
  });
});

// Direct snippet runs: patch globalThis (restored in finally) with a fake
// ScrollTrigger registry / document so the probe snippets execute in-process.
describe("SCRUB_PROBE snippets (direct snippet runs + source locks)", () => {
  const g = globalThis as any;

  function withEnv<T>(env: Record<string, unknown>, fn: () => T): T {
    const saved: Record<string, { v: unknown; had: boolean }> = {};
    for (const k of Object.keys(env)) {
      saved[k] = { v: g[k], had: k in g };
      if (env[k] === undefined) delete g[k];
      else g[k] = env[k];
    }
    try {
      return fn();
    } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k].had) g[k] = saved[k].v;
        else delete g[k];
      }
    }
  }

  it("intro picks the first ≤6 scrubbed triggers with numeric start AND end bounds", () => {
    const el = { nodeType: 1, tagName: "DIV" };
    const fakeST = {
      getAll: function () {
        const rows: unknown[] = [{ trigger: el, start: "x", end: 100, vars: { scrub: true } }]; // non-numeric start → skipped
        for (let i = 0; i < 8; i++) {
          rows.push({ trigger: el, start: i * 100, end: i * 100 + 500, vars: { scrub: true } });
        }
        return rows;
      },
    };
    const out = withEnv({ ScrollTrigger: fakeST, document: undefined }, SCRUB_PROBE_INTRO);
    expect(out.maxScroll).toBe(0); // no document probe available in-process
    expect(out.triggers.length).toBe(6);
    expect(out.triggers[0]).toEqual({ selector: "div", startPx: 0, endPx: 500 });
    expect(out.triggers[1].startPx).toBe(100);
  });

  it("intro excludes numeric-bounds triggers without the scrub flag (scrubbed fill the cap)", () => {
    const el = { nodeType: 1, tagName: "DIV" };
    const fakeST = {
      getAll: function () {
        const rows: unknown[] = [
          { trigger: el, start: 2000, end: 3000, vars: {} }, // numeric bounds, no scrub flag → skipped
        ];
        for (let i = 0; i < 6; i++) {
          rows.push({ trigger: el, start: i * 100, end: i * 100 + 500, vars: { scrub: true } });
        }
        return rows;
      },
    };
    const out = withEnv({ ScrollTrigger: fakeST, document: undefined }, SCRUB_PROBE_INTRO);
    expect(out.triggers.length).toBe(6);
    expect(out.triggers[0]).toEqual({ selector: "div", startPx: 0, endPx: 500 });
    expect(out.triggers.every((t) => t.startPx !== 2000)).toBe(true);
  });

  it("step re-finds saved selectors and samples live progress (nulls on miss)", () => {
    const el = { nodeType: 1, tagName: "DIV", parentElement: null };
    const fakeST = {
      getAll: function () {
        return [{ trigger: el, progress: 0.42, start: 0, end: 500 }];
      },
    };
    const fakeDoc = {
      querySelector: function (s: string) {
        return s === "div.a" ? el : null;
      },
    };
    const rows = withEnv(
      { ScrollTrigger: fakeST, document: fakeDoc, scrollY: 240 },
      function () {
        return SCRUB_PROBE_STEP(["div.a", "div.missing"]);
      },
    );
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({ progress: 0.42, transform: null, scrollY: 240 });
    expect(rows[1].progress).toBeNull();
  });

  it("both probe snippets are serializable plain functions (no-arrow lock)", () => {
    for (const snippet of [SCRUB_PROBE_INTRO, SCRUB_PROBE_STEP]) {
      expect(typeof snippet).toBe("function");
      expect(String(snippet)).not.toContain("=>");
    }
  });

  it("SCRUB_SCROLL_TO is a serializable plain function (no-arrow lock)", () => {
    expect(typeof SCRUB_SCROLL_TO).toBe("function");
    expect(String(SCRUB_SCROLL_TO)).not.toContain("=>");
  });

  it("ACQUISITION_HEIGHT is a serializable plain function (no-arrow lock)", () => {
    expect(typeof ACQUISITION_HEIGHT).toBe("function");
    expect(String(ACQUISITION_HEIGHT)).not.toContain("=>");
    const h = ACQUISITION_HEIGHT();
    expect(h === null || Number.isFinite(h)).toBe(true);
  });

  it("probe bounds are locked in source (≤6 triggers, ≤60-char transform)", () => {
    const intro = String(SCRUB_PROBE_INTRO);
    expect(intro).toContain("triggers.length >= 6");
    expect(intro).toContain("maxScroll");
    expect(intro).toContain("vars?.scrub");
    const step = String(SCRUB_PROBE_STEP);
    expect(step).toContain("selectors.slice(0, 6)");
    expect(step).toContain(".slice(0, 60)");
    expect(step).toContain("querySelector");
  });
});
