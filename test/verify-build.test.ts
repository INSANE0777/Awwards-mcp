import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  motionFingerprint,
  motionDiffScore,
  compareBands,
  verdictFrom,
  verifyBuild,
  diffComponentTrees,
  compactScrollCensus,
  compactHoverCensus,
} from "../src/verify-build.js";
import type { BandRow, MotionCensusInput, DomDiffResult } from "../src/verify-build.js";
import type { PageStructure } from "../src/structure.js";
import type { CensusAcquisition, ScrollCensus } from "../src/census.js";
import type { HoverCensus } from "../src/hover-census.js";
import type { ComponentPack, ComponentNode } from "../src/component.js";

const base = (p: Partial<MotionCensusInput>): MotionCensusInput => ({
  counts: {
    "gsap-scrolltrigger": 3,
    "css-scroll-timeline": 0,
    "css-view-timeline": 0,
    "data-attr": 0,
    "css-keyframe": 2,
    smil: 0,
  },
  anims: [
    { easing: "power2.out", scrub: true, pin: false },
    { easing: "power2.out", scrub: true, pin: false },
    { easing: "power1.in", scrub: false, pin: true },
  ],
  nativeScrollTimelines: 1,
  ...p,
});

describe("motionFingerprint", () => {
  it("is order-independent (key order + easing token order)", () => {
    const a = motionFingerprint({
      counts: {
        "gsap-scrolltrigger": 3,
        "css-scroll-timeline": 0,
        "css-view-timeline": 1,
        "data-attr": 0,
        "css-keyframe": 2,
        smil: 0,
      },
      anims: [{ easing: "power2.out", scrub: false, pin: false }],
      nativeScrollTimelines: 1,
      easingTokens: ["power2.out", "linear"],
    });
    const b = motionFingerprint({
      counts: {
        smil: 0,
        "css-keyframe": 2,
        "data-attr": 0,
        "css-view-timeline": 1,
        "css-scroll-timeline": 0,
        "gsap-scrolltrigger": 3,
      },
      anims: [{ easing: "power2.out", scrub: false, pin: false }],
      nativeScrollTimelines: 1,
      easingTokens: ["linear", "power2.out"],
    });
    expect(a).toBe(b);
    expect(a.split("|").length).toBeGreaterThan(2);
  });

  it("reflects scrub/pin counts and an easing token", () => {
    const fp = motionFingerprint(base({}));
    // Exact format pin: positional trigger tokens in TRIGGER_KEYS order, then
    // nat/sc/pin, then the sorted easing list (duplicates preserved).
    expect(fp).toBe("k1|tr:g3,c0,v0,d0,k2,s0|nat:1|sc:2|pin:1|e:power1.in,power2.out,power2.out");
    expect(fp).toContain("sc:2");
    expect(fp).toContain("pin:1");
    expect(fp).toContain("power1.in");
  });
});

describe("motionDiffScore", () => {
  it("identical fingerprints → 100", () => {
    const fp = motionFingerprint(base({}));
    expect(motionDiffScore(fp, fp)).toBe(100);
  });

  it("disjoint motion (triggers, easings linear vs power2.out, native 0 vs 4) → < 50", () => {
    const ref = motionFingerprint({
      counts: {
        "gsap-scrolltrigger": 2,
        "css-scroll-timeline": 0,
        "css-view-timeline": 0,
        "data-attr": 0,
        "css-keyframe": 0,
        smil: 0,
      },
      anims: [{ easing: "linear", scrub: false, pin: false }],
      nativeScrollTimelines: 0,
    });
    const build = motionFingerprint({
      counts: {
        "gsap-scrolltrigger": 0,
        "css-scroll-timeline": 0,
        "css-view-timeline": 0,
        "data-attr": 0,
        "css-keyframe": 3,
        smil: 0,
      },
      anims: [{ easing: "power2.out", scrub: false, pin: false }],
      nativeScrollTimelines: 4,
    });
    expect(motionDiffScore(ref, build)).toBeLessThan(50);
  });
});

describe("compareBands", () => {
  const ref: BandRow[] = [
    { label: "hero", bg: "#111111", tag: "h1" },
    { label: "Feature grid", bg: "#222222", tag: "section" },
    { label: "footer", bg: "#333333", tag: "footer" },
  ];
  const build: BandRow[] = [
    { label: "  HERO  ", bg: "#111111", tag: "h1" },
    { label: "feature-grid", bg: "#222222", tag: "section" },
  ];

  it("matches 3 ref vs 2 build, flags refOnly, scores > 50", () => {
    const r = compareBands(ref, build);
    expect(r.matched).toHaveLength(2);
    expect(r.refOnly).toEqual(["footer"]);
    expect(r.buildOnly).toEqual([]);
    expect(r.score).toBeGreaterThan(50);
  });

  it("falls back to bg+tag match when labels differ", () => {
    const r = compareBands(
      [{ label: "pricing card", bg: "#fafafa", tag: "div" }],
      [{ label: "totally different", bg: "#fafafa", tag: "div" }]
    );
    expect(r.matched).toHaveLength(1);
    expect(r.refOnly).toEqual([]);
    expect(r.buildOnly).toEqual([]);
  });

  it("matches duplicate/generic labels by tag+height despite reversed order", () => {
    // Both ref rows are labelled "body" (generic + duplicate), so the label
    // carries no identity. The build rows are reversed and only heights pair
    // them; a bg+tag row proves the closest height was consumed, not the first.
    const r = compareBands(
      [
        { label: "body", bg: null, tag: "section", height: 900 },
        { label: "body", bg: "#abcdef", tag: "section", height: 1600 },
      ],
      [
        { label: "section", bg: "#abcdef", tag: "section", height: 1600 },
        { label: "section", bg: null, tag: "section", height: 900 },
      ]
    );
    expect(r.matched).toHaveLength(2);
    expect(r.refOnly).toEqual([]);
    expect(r.buildOnly).toEqual([]);
  });

  it("does not use the height fallback for non-duplicate, non-generic labels", () => {
    const r = compareBands(
      [{ label: "hero", bg: null, tag: "section", height: 900 }],
      [{ label: "intro", bg: null, tag: "section", height: 900 }]
    );
    expect(r.matched).toEqual([]);
    expect(r.refOnly).toEqual(["hero"]);
    expect(r.buildOnly).toEqual(["intro"]);
  });

  it("does not match anonymous labels when both explicit backgrounds differ", () => {
    const r = compareBands(
      [{ label: "", bg: "#111111", tag: "div", height: 900 }],
      [{ label: "", bg: "#222222", tag: "div", height: 900 }]
    );
    expect(r.matched).toEqual([]);
    expect(r.refOnly).toEqual(["(unlabeled)"]);
    expect(r.buildOnly).toEqual([""]);
  });

  it("picks the closest generic build height, not the first candidate", () => {
    const r = compareBands(
      [{ label: "", bg: null, tag: "div", height: 900 }],
      [
        { label: "", bg: null, tag: "div", height: 100 },
        { label: "body", bg: null, tag: "div", height: 900 },
      ]
    );
    expect(r.matched).toHaveLength(1);
    expect(r.buildOnly).toEqual([""]); // the 100px candidate stayed unused
  });

  it("honours the 25% height boundary for generic labels", () => {
    const within = compareBands(
      [{ label: "", bg: null, tag: "div", height: 1000 }],
      [{ label: "body", bg: null, tag: "div", height: 1250 }]
    );
    expect(within.matched).toHaveLength(1);
    const outside = compareBands(
      [{ label: "", bg: null, tag: "div", height: 1000 }],
      [{ label: "body", bg: null, tag: "div", height: 1400 }]
    );
    expect(outside.matched).toEqual([]);
  });

  it("does not pair a generic ref band with a named, differently-coloured build band", () => {
    const r = compareBands(
      [{ label: "", bg: "#111111", tag: "div", height: 900 }],
      [{ label: "#footer", bg: "#222222", tag: "div", height: 950 }]
    );
    expect(r.matched).toEqual([]);
    expect(r.refOnly).toEqual(["(unlabeled)"]);
    expect(r.buildOnly).toEqual(["#footer"]);
  });

  it("matches a named ref band to an anonymous rebuild band by tag+height", () => {
    const r = compareBands(
      [{ label: "#hero", bg: "#111111", tag: "section", height: 900 }],
      [{ label: "", bg: "#111111", tag: "section", height: 920 }]
    );
    expect(r.matched).toHaveLength(1);
    expect(r.refOnly).toEqual([]);
    expect(r.buildOnly).toEqual([]);
  });

  it("matches identical >24-char labels and returns the full label", () => {
    const label = `${"a".repeat(30)}-hero`;
    const r = compareBands(
      [{ label, bg: null, tag: "section" }],
      [{ label, bg: null, tag: "section" }]
    );
    expect(r.matched).toEqual([label]);
    expect(r.refOnly).toEqual([]);
    expect(r.buildOnly).toEqual([]);
    expect(r.score).toBe(100);
  });

  it("does not match distinct labels sharing a >24-char prefix (full labels returned)", () => {
    const prefix = "a".repeat(30);
    const refLabel = `${prefix}-hero`;
    const buildLabel = `${prefix}-footer`;
    const r = compareBands(
      [{ label: refLabel, bg: null, tag: "section" }],
      [{ label: buildLabel, bg: null, tag: "section" }]
    );
    expect(r.matched).toEqual([]);
    expect(r.refOnly).toEqual([refLabel]);
    expect(r.buildOnly).toEqual([buildLabel]);
    expect(r.score).toBeLessThan(100);
  });

  it("does not let a generic band steal a named build band", () => {
    const r = compareBands(
      [
        { label: "", bg: null, tag: "div", height: 900 },
        { label: "#pricing", bg: null, tag: "div", height: 1000 },
      ],
      [{ label: "#pricing", bg: null, tag: "div", height: 1000 }]
    );
    expect(r.matched).toEqual(["#pricing"]);
    expect(r.refOnly).toEqual(["(unlabeled)"]);
    expect(r.buildOnly).toEqual([]);
  });
});

describe("verdictFrom", () => {
  it("thresholds: 90/80→pass, 70/60→warn, 40/30→fail", () => {
    expect(verdictFrom(90, 80).verdict).toBe("pass");
    expect(verdictFrom(70, 60).verdict).toBe("warn");
    expect(verdictFrom(40, 30).verdict).toBe("fail");
  });

  it("returns a 3-line human-readable evidence trail", () => {
    const r = verdictFrom(90, 80);
    expect(r.evidence.length).toBe(3);
    expect(r.overall).toBe(86);
    expect(r.evidence[2]).toContain("86");
  });
});

describe("verifyBuild orchestrator", () => {
  const refStruct = (): PageStructure => ({
    url: "https://ref.test",
    title: "Reference",
    totalHeight: 2000,
    bands: [
      { index: 0, tag: "h1", label: "hero", background: "#000000", offsetTop: 0, height: 900, textStart: "" },
      { index: 1, tag: "footer", label: "footer", background: "#000000", offsetTop: 900, height: 1100, textStart: "" },
    ],
  });
  const scrollCensus = (): ScrollCensus => ({
    url: "https://x.test",
    capturedAt: 0,
    counts: {
      "gsap-scrolltrigger": 1,
      "css-scroll-timeline": 0,
      "css-view-timeline": 0,
      "data-attr": 0,
      "css-keyframe": 0,
      smil: 0,
      unknown: 0,
    },
    anims: [{ selector: "section", tag: "section", props: ["transform"], durationMs: null, delayMs: null, easing: "power2.out", trigger: "gsap-scrolltrigger", scrub: true, pin: false, svgStroke: false }],
    svgStrokes: [],
    nativeScrollTimelines: 0,
    reducedMotion: false,
  });
  const hoverCensus = (): HoverCensus => ({
    url: "https://x.test",
    capturedAt: 0,
    hoverRuleCount: 0,
    candidates: 0,
    samples: [],
    reducedMotion: false,
  });

  // The aegon evidence-pass defaults would fetch the build URL and launch
  // Chrome, so every verifyBuild call here opts into offline fakes.
  const okFetch =
    (body: string): typeof fetch =>
    (async () => ({ ok: true, status: 200, text: async () => body })) as unknown as typeof fetch;
  const offlineEvidence = {
    perfFn: async () => ({ error: "skipped in fixture" }),
    rulesFn: () => [],
    fetchFn: okFetch(""),
  };
  const perfMeasurement = () => ({
    seconds: 6,
    frames: 360,
    fps: 58,
    droppedFrames: 4,
    worstFrameMs: 41,
    longTaskCount: 2,
    longTaskMaxMs: 64,
    longAnimationFrameCount: 1,
    longAnimationFrameMaxBlockingMs: 33,
    layoutThrashCount: 3,
    measureBeforeCompositeCount: 5,
    layoutReads: 40,
    styleWrites: 12,
    scrollListeners: [] as Array<{ type: string; passive: boolean }>,
    animationsAtEnd: 0,
    chromePath: "fake-chrome",
  });

  it("scores an identical build: bands matched, verdict in pass/warn/fail, evidence, fingerprints", async () => {
    let hoverCalls = 0;
    const report = await verifyBuild({
      buildUrl: "https://build.test",
      referenceUrl: "https://ref.test",
      structureFn: async () => refStruct(),
      scrollFn: async () => ({ ...scrollCensus() }),
      hoverFn: async () => {
        hoverCalls++;
        return hoverCensus();
      },
      ...offlineEvidence,
    });
    expect("error" in report).toBe(false);
    if ("error" in report) return;
    expect(report.bands.matched).toContain("hero");
    expect(report.verdict).toMatch(/pass|warn|fail/);
    expect(report.evidence.length).toBeGreaterThan(2);
    expect(report.motion.refFingerprint).toContain("k1");
    // Presence-only: hover censuses ran for both pages but don't gate the score.
    expect(hoverCalls).toBe(2);
  });

  it("structure-scan error short-circuits before scroll/hover run", async () => {
    const scrollFn = async (): Promise<ScrollCensus> => {
      throw new Error("scrollFn must not be called");
    };
    const hoverFn = async (): Promise<HoverCensus> => {
      throw new Error("hoverFn must not be called");
    };
    const report = await verifyBuild({
      buildUrl: "https://build.test",
      referenceUrl: "https://ref.test",
      structureFn: async () => ({ error: "nope" }),
      scrollFn,
      hoverFn,
      ...offlineEvidence,
    });
    expect("error" in report).toBe(true);
    if (!("error" in report)) return;
    expect(report.error).toContain("nope");
    expect(report.error.toLowerCase()).toContain("reference");
  });

  it("scroll-census error mentions headless browser required", async () => {
    const report = await verifyBuild({
      buildUrl: "https://build.test",
      referenceUrl: "https://ref.test",
      structureFn: async () => refStruct(),
      scrollFn: async () => ({ error: "playwright missing" }),
      hoverFn: async () => hoverCensus(),
      ...offlineEvidence,
    });
    expect("error" in report).toBe(true);
    if (!("error" in report)) return;
    expect(report.error).toContain("headless browser required");
  });

  it("maps structure bands (incl. PageBand.background) into BandRow labels", async () => {
    const report = await verifyBuild({
      buildUrl: "https://build.test",
      referenceUrl: "https://ref.test",
      structureFn: async () => refStruct(),
      scrollFn: async () => scrollCensus(),
      hoverFn: async () => hoverCensus(),
      ...offlineEvidence,
    });
    expect("error" in report).toBe(false);
    if ("error" in report) return;
    // hero matched by label; footer matched too; nothing lost in refOnly.
    expect(report.bands.matched).toEqual(["hero", "footer"]);
    expect(report.bands.refOnly).toEqual([]);
  });

  // Motion-repeatability evidence: two censuses saved from the local fixture
  // (one sampled before the async section landed, one after). Re-scoring the
  // SAME saved inputs must reproduce the SAME fingerprint and score; the 91
  // seen in the field is exactly one keyframe-class difference, not noise in
  // motionDiffScore.
  describe("saved census evidence (motion repeatability)", () => {
    const saved = (name: string): ScrollCensus =>
      JSON.parse(readFileSync(join(__dirname, "fixtures", "motion-variance", name), "utf8")) as ScrollCensus;
    const early = saved("census-early.json");
    const late = saved("census-late.json");

    it("pins the fingerprints and the 100/91 scores for identical saved inputs", () => {
      const earlyFp = motionFingerprint(early);
      const lateFp = motionFingerprint(late);
      expect(earlyFp).toBe("k1|tr:g1,c0,v0,d0,k0,s0|nat:0|sc:1|pin:0|e:linear");
      expect(lateFp).toBe("k1|tr:g1,c0,v0,d0,k3,s0|nat:0|sc:1|pin:0|e:linear,linear,linear,linear");
      expect(motionDiffScore(earlyFp, earlyFp)).toBe(100);
      expect(motionDiffScore(lateFp, lateFp)).toBe(100);
      // One extra css-keyframe animation class → trigger-set Jaccard 5/7.
      expect(motionDiffScore(earlyFp, lateFp)).toBe(91);
      // Repeated calls over the same saved inputs never drift.
      expect(motionFingerprint(early)).toBe(earlyFp);
      expect(motionFingerprint(late)).toBe(lateFp);
      expect(motionDiffScore(earlyFp, lateFp)).toBe(91);
    });

    it("verifyBuild re-scores saved inputs identically and invents no acquisition context", async () => {
      const run = () =>
        verifyBuild({
          buildUrl: "https://build.test",
          referenceUrl: "https://ref.test",
          structureFn: async () => refStruct(),
          scrollFn: async (url) => (url === "https://ref.test" ? early : late),
          hoverFn: async () => hoverCensus(),
          ...offlineEvidence,
        });
      const a = await run();
      const b = await run();
      expect("error" in a || "error" in b).toBe(false);
      if ("error" in a || "error" in b) return;
      expect(a.motion.score).toBe(91);
      expect(a.motion.refFingerprint).toBe(b.motion.refFingerprint);
      expect(a.motion.buildFingerprint).toBe(b.motion.buildFingerprint);
      expect(a.overall).toBe(b.overall);
      // Saved evidence carries no acquisition state: no fabricated block/line.
      expect(a.motion.acquisition).toBeUndefined();
      expect(a.evidence.some((l) => l.startsWith("capture:"))).toBe(false);
    });

    const acquisition = (over: Partial<CensusAcquisition> = {}): CensusAcquisition => ({
      waitStrategy: "networkidle",
      settleMs: 3000,
      postScrollMs: 500,
      capturedAt: 1_793_537_000_000,
      documentHeight: 5000,
      animationCount: 1,
      gsapRegistryCount: 1,
      stable: true,
      ...over,
    });
    const withAcq = (c: ScrollCensus, over: Partial<CensusAcquisition>) => ({
      ...c,
      acquisition: acquisition(over),
    });

    it("discloses acquisition state beside the score when live censuses carry it", async () => {
      const report = await verifyBuild({
        buildUrl: "https://build.test",
        referenceUrl: "https://ref.test",
        structureFn: async () => refStruct(),
        scrollFn: async (url) =>
          url === "https://ref.test" ? withAcq(early, {}) : withAcq(early, { documentHeight: 5600 }),
        hoverFn: async () => hoverCensus(),
        ...offlineEvidence,
      });
      expect("error" in report).toBe(false);
      if ("error" in report) return;
      expect(report.motion.score).toBe(100);
      expect(report.motion.acquisition).toEqual({
        reference: acquisition({}),
        build: acquisition({ documentHeight: 5600 }),
      });
      expect(report.evidence.at(-1)).toBe(
        "capture: reference h=5000 anims=1 gsap=1 stable; build h=5600 anims=1 gsap=1 stable (wait=networkidle/networkidle, settle=3000+500ms)",
      );
      // Stable heights never touch the score-derived motion line.
      expect(report.evidence[1]).toBe("Motion: 100/100 fingerprint similarity");
    });

    it("marks a mid-capture mutation on the motion line and the capture line", async () => {
      const report = await verifyBuild({
        buildUrl: "https://build.test",
        referenceUrl: "https://ref.test",
        structureFn: async () => refStruct(),
        scrollFn: async (url) =>
          url === "https://ref.test" ? withAcq(early, {}) : withAcq(early, { stable: false }),
        hoverFn: async () => hoverCensus(),
        ...offlineEvidence,
      });
      expect("error" in report).toBe(false);
      if ("error" in report) return;
      expect(report.evidence[1]).toBe(
        "Motion: 100/100 fingerprint similarity (capture unstable: page changed during sampling)",
      );
      expect(report.evidence.at(-1)).toContain("build h=5000 anims=1 gsap=1 MUTATED");
    });

    it("says stability-unknown when the probe could not verify the bracket", async () => {
      const report = await verifyBuild({
        buildUrl: "https://build.test",
        referenceUrl: "https://ref.test",
        structureFn: async () => refStruct(),
        scrollFn: async (url) =>
          url === "https://ref.test" ? withAcq(early, { stable: null }) : withAcq(early, { stable: null }),
        hoverFn: async () => hoverCensus(),
        ...offlineEvidence,
      });
      expect("error" in report).toBe(false);
      if ("error" in report) return;
      expect(report.evidence[1]).toBe("Motion: 100/100 fingerprint similarity");
      expect(report.evidence.at(-1)).toContain("reference h=5000 anims=1 gsap=1 stability-unknown");
    });
  });

  it("appends measured perf + anti-pattern evidence after the score-derived lines", async () => {
    const rulesFn = () => [
      { ruleId: "blur-heavy", severity: "HIGH" as const, message: "Heavy blur", why: "w", improvements: "i", source: "css" as const },
      { ruleId: "transition-all", severity: "MEDIUM" as const, message: "all", why: "w", improvements: "i", source: "html" as const },
    ];
    const report = await verifyBuild({
      buildUrl: "https://build.test",
      referenceUrl: "https://ref.test",
      structureFn: async () => refStruct(),
      scrollFn: async () => scrollCensus(),
      hoverFn: async () => hoverCensus(),
      perfFn: async () => perfMeasurement(),
      rulesFn,
      fetchFn: okFetch("<html><body>build</body></html>"),
    });
    expect("error" in report).toBe(false);
    if ("error" in report) return;
    expect(report.evidence).toHaveLength(6);
    expect(report.evidence.slice(0, 4)).toEqual([
      "Bands: 100/100 similarity",
      "Motion: 100/100 fingerprint similarity",
      "Overall: 100/100 → PASS",
      "Hover: reference 0 samples, build 0 samples (presence only)",
    ]);
    // Field mapping (perf-live renames): fps→fps, droppedFrames→dropped,
    // longTaskCount→longTasks, layoutThrashCount→thrash.
    expect(report.evidence[4]).toBe("perf: fps=58 dropped=4 longTasks=2 thrash=3 (measured)");
    // HIGH (12) outranks MEDIUM (5) → worst rule id wins.
    expect(report.evidence[5]).toBe("anti-patterns: 2 (worst: blur-heavy)");
  });

  it("evidence failures degrade to notes; score/verdict/prior evidence byte-identical", async () => {
    const common = {
      buildUrl: "https://build.test",
      referenceUrl: "https://ref.test",
      structureFn: async () => refStruct(),
      scrollFn: async () => scrollCensus(),
      hoverFn: async () => hoverCensus(),
    };
    const control = await verifyBuild({ ...common, ...offlineEvidence });
    const degraded = await verifyBuild({
      ...common,
      perfFn: async () => ({ error: "no chrome" }),
      rulesFn: () => {
        throw new Error("rules blew up");
      },
      fetchFn: okFetch("<html></html>"),
    });
    expect("error" in control).toBe(false);
    expect("error" in degraded).toBe(false);
    if ("error" in control || "error" in degraded) return;
    // Control equality: the pre-existing score/verdict/evidence is untouched.
    expect(degraded.overall).toBe(control.overall);
    expect(degraded.verdict).toBe(control.verdict);
    expect(degraded.evidence.slice(0, 4)).toEqual(control.evidence.slice(0, 4));
    // Hard-pinned literal = the pre-change values for this fixture.
    expect(degraded.evidence.slice(0, 4)).toEqual([
      "Bands: 100/100 similarity",
      "Motion: 100/100 fingerprint similarity",
      "Overall: 100/100 → PASS",
      "Hover: reference 0 samples, build 0 samples (presence only)",
    ]);
    // Both degrade lines replace the success lines, in the same slots.
    expect(degraded.evidence[4]).toBe("perf: not measured (no chrome)");
    expect(degraded.evidence[5]).toBe("anti-patterns: not scanned (rules blew up)");
  });

  it("a failed build-page fetch degrades only the anti-patterns line", async () => {
    const statusFetch =
      (status: number): typeof fetch =>
      (async () => ({ ok: status < 400, status, text: async () => "" })) as unknown as typeof fetch;
    const report = await verifyBuild({
      buildUrl: "https://build.test",
      referenceUrl: "https://ref.test",
      structureFn: async () => refStruct(),
      scrollFn: async () => scrollCensus(),
      hoverFn: async () => hoverCensus(),
      perfFn: async () => perfMeasurement(),
      rulesFn: () => {
        throw new Error("rulesFn must not be called — fetch failed first");
      },
      fetchFn: statusFetch(503),
    });
    expect("error" in report).toBe(false);
    if ("error" in report) return;
    expect(report.evidence[4]).toBe("perf: fps=58 dropped=4 longTasks=2 thrash=3 (measured)");
    expect(report.evidence[5]).toBe("anti-patterns: not scanned (HTTP 503 fetching https://build.test)");
  });

  it("early structural error short-circuits before the evidence pass runs", async () => {
    let perfCalls = 0;
    let rulesCalls = 0;
    const report = await verifyBuild({
      buildUrl: "https://build.test",
      referenceUrl: "https://ref.test",
      structureFn: async () => ({ error: "nope" }),
      scrollFn: async () => scrollCensus(),
      hoverFn: async () => hoverCensus(),
      perfFn: async () => {
        perfCalls++;
        return { error: "must not run" };
      },
      rulesFn: () => {
        rulesCalls++;
        return [];
      },
      fetchFn: okFetch(""),
    });
    expect("error" in report).toBe(true);
    expect(perfCalls).toBe(0);
    expect(rulesCalls).toBe(0);
  });

  it("bounds the fps probe to a fixed 6s window (C1: perfFn receives seconds: 6)", async () => {
    const seen: Array<{ seconds?: number } | undefined> = [];
    const report = await verifyBuild({
      buildUrl: "https://build.test",
      referenceUrl: "https://ref.test",
      structureFn: async () => refStruct(),
      scrollFn: async () => scrollCensus(),
      hoverFn: async () => hoverCensus(),
      perfFn: async (_url, opts) => {
        seen.push(opts);
        return perfMeasurement();
      },
      rulesFn: () => [],
      fetchFn: okFetch(""),
    });
    expect("error" in report).toBe(false);
    if ("error" in report) return;
    expect(seen).toEqual([{ seconds: 6 }]);
    expect(report.evidence[4]).toContain("fps=58");
  });

  it("records the #15997 idle-tail pitfall beside the perf window (C1 audit, no-op branch)", () => {
    // Audit conclusion (plan Task C1): the perf-live collector is registered
    // pre-navigation via Page.addScriptToEvaluateOnNewDocument, so the rAF
    // window always covers the busy load/init work — the comfyui #15997
    // failure mode (sampling AFTER the workload → the idle tail dominates)
    // cannot occur; source-locked here so a future refactor that replaces
    // the pre-navigation injection re-opens the audit consciously.
    const src = readFileSync(join(__dirname, "..", "src", "verify-build.ts"), "utf8");
    expect(src).toContain("15997");
    expect(src).toContain("addScriptToEvaluateOnNewDocument");
  });

  // D2: opt-in domDiff. The component scans (selector "body", maxNodes 1200)
  // run on both urls; the evidence line is appended only when on.
  describe("domDiff (D2, opt-in)", () => {
    const domNode = (
      tag: string,
      children: ComponentNode[] = [],
      rect = { x: 0, y: 0, w: 100, h: 50 },
    ): ComponentNode => ({ tag, classes: [], rect, styles: {}, children });
    const refTree = (): ComponentNode =>
      domNode("body", [domNode("header"), domNode("section", [domNode("p")])]);
    const domPack = (root: ComponentNode, over: Partial<ComponentPack> = {}): ComponentPack => ({
      id: "component-pack-v1",
      url: "https://x.test",
      selector: "body",
      capturedAt: 0,
      viewport: { width: 1440, height: 900 },
      nodeCount: 4,
      root,
      fonts: [],
      colors: [],
      ...over,
    });

    it("runs the body scan on both urls, appends the dom evidence line and the domDiff key", async () => {
      const seen: string[] = [];
      const report = await verifyBuild({
        buildUrl: "https://build.test",
        referenceUrl: "https://ref.test",
        structureFn: async () => refStruct(),
        scrollFn: async () => scrollCensus(),
        hoverFn: async () => hoverCensus(),
        componentFn: async (url) => {
          seen.push(url);
          // build drops the giant section → one missing skeleton path
          if (url === "https://build.test") return domPack(domNode("body", [domNode("header")]));
          return domPack(refTree());
        },
        domDiff: true,
        ...offlineEvidence,
      });
      expect("error" in report).toBe(false);
      if ("error" in report) return;
      expect(seen).toEqual(["https://ref.test", "https://build.test"]);
      // Sixth evidence slot stays untouched; the dom line is appended last.
      expect(report.evidence).toHaveLength(7);
      // build drops the section AND its child p → both skeleton paths missing.
      expect(report.evidence[6]).toBe("dom: 2 missing, 0 extra, 0 rectDrift (body)");
      expect(report.domDiff).toBeDefined();
      expect(report.domDiff!.missing).toEqual(["body/section[0]", "body/section[0]/p[0]"]);
      expect(report.domDiff!.incomplete).toBe(false);
      expect(report.evidence[0]).toBe("Bands: 100/100 similarity");
    });

    it("default run never scans components and never carries the domDiff key (byte-identical)", async () => {
      const componentFn = async (): Promise<ComponentPack> => {
        throw new Error("componentFn must not be called without domDiff");
      };
      const report = await verifyBuild({
        buildUrl: "https://build.test",
        referenceUrl: "https://ref.test",
        structureFn: async () => refStruct(),
        scrollFn: async () => scrollCensus(),
        hoverFn: async () => hoverCensus(),
        componentFn,
        ...offlineEvidence,
      });
      expect("error" in report).toBe(false);
      if ("error" in report) return;
      expect(report.evidence).toHaveLength(6);
      expect(Object.keys(report)).not.toContain("domDiff");
      expect(report.evidence.some((l) => l.startsWith("dom:"))).toBe(false);
    });

    it("errored/truncated scans keep the dom line but mark it (incomplete)", async () => {
      const report = await verifyBuild({
        buildUrl: "https://build.test",
        referenceUrl: "https://ref.test",
        structureFn: async () => refStruct(),
        scrollFn: async () => scrollCensus(),
        hoverFn: async () => hoverCensus(),
        componentFn: async () => domPack(refTree(), { nodeCount: 1200 }), // cap hit ⇒ truncated
        domDiff: true,
        ...offlineEvidence,
      });
      expect("error" in report).toBe(false);
      if ("error" in report) return;
      expect(report.evidence).toHaveLength(7);
      expect(report.evidence[6]).toBe("dom: 0 missing, 0 extra, 0 rectDrift (body) (incomplete)");
      expect(report.domDiff!.incomplete).toBe(true);
    });
  });
});

describe("diffComponentTrees (D2)", () => {
  const node = (
    tag: string,
    children: ComponentNode[] = [],
    rect = { x: 0, y: 0, w: 100, h: 50 },
  ): ComponentNode => ({ tag, classes: [], rect, styles: {}, children });
  const pack = (root: ComponentNode, over: Partial<ComponentPack> = {}): ComponentPack => ({
    id: "component-pack-v1",
    url: "https://x.test",
    selector: "body",
    capturedAt: 0,
    viewport: { width: 1440, height: 900 },
    nodeCount: 0,
    root,
    fonts: [],
    colors: [],
    ...over,
  });
  const errPack = { error: "selector not found: body" };

  it("identical trees: every list empty, not incomplete", () => {
    const t = () => node("body", [node("header", [node("h1")]), node("section", [node("p")])]);
    const d = diffComponentTrees(pack(t()), pack(t()));
    expect(d.missing).toEqual([]);
    expect(d.extra).toEqual([]);
    expect(d.reordered).toEqual([]);
    expect(d.rectDrift).toEqual([]);
    expect(d.incomplete).toBe(false);
  });

  it("missing = ref-only paths, extra = build-only paths (tag+index chains)", () => {
    const ref = pack(node("body", [node("header"), node("footer")]));
    const build = pack(node("body", [node("header"), node("nav")]));
    const d = diffComponentTrees(ref, build);
    expect(d.missing).toEqual(["body/footer[0]"]);
    expect(d.extra).toEqual(["body/nav[0]"]);
    expect(d.incomplete).toBe(false);
  });

  it("same-tag sibling indices keep the chain stable across different-tag inserts", () => {
    // build inserts a div BEFORE the h1: h1 keeps its h1[0] key, only the
    // insert itself shows up as extra.
    const ref = pack(node("body", [node("h1")]));
    const build = pack(node("body", [node("div"), node("h1")]));
    const d = diffComponentTrees(ref, build);
    expect(d.missing).toEqual([]);
    expect(d.extra).toEqual(["body/div[0]"]);
    expect(d.reordered).toEqual([]);
    expect(d.rectDrift).toEqual([]);
  });

  it("reordered flags common siblings whose relative order differs", () => {
    const ref = pack(node("body", [node("header"), node("section"), node("footer")]));
    const build = pack(node("body", [node("section"), node("header"), node("footer")]));
    const d = diffComponentTrees(ref, build);
    expect(d.missing).toEqual([]);
    expect(d.extra).toEqual([]);
    // header and section swapped; footer keeps its rank
    expect(d.reordered.sort()).toEqual(["body/header[0]", "body/section[0]"]);
  });

  it("rectDrift above the floor only, dPx = L∞ of the four deltas (default floor 8)", () => {
    const ref = pack(node("body", [node("h1", [], { x: 0, y: 0, w: 600, h: 80 })]));
    const still = pack(node("body", [node("h1", [], { x: 2, y: 3, w: 604, h: 84 })]));
    expect(diffComponentTrees(ref, still).rectDrift).toEqual([]); // max 4 ≤ 8
    const moved = pack(node("body", [node("h1", [], { x: 0, y: 20.04, w: 600, h: 80 })]));
    expect(diffComponentTrees(ref, moved).rectDrift).toEqual([{ path: "body/h1[0]", dPx: 20 }]);
    // explicit floor raises the bar over the default
    expect(diffComponentTrees(ref, moved, { rectDriftPx: 25 }).rectDrift).toEqual([]);
  });

  it("bounds every list at 40 first-wins and marks the truncation incomplete", () => {
    const ref = pack(node("body", Array.from({ length: 45 }, (_, i) => node(`h${(i % 6) + 1}`))));
    const build = pack(node("body"));
    const d = diffComponentTrees(ref, build);
    expect(d.missing).toHaveLength(40);
    expect(d.missing[0]).toBe("body/h1[0]");
    expect(d.incomplete).toBe(true);
  });

  it("incomplete on errored or truncated (nodeCount ≥ maxNodes) scans", () => {
    const t = pack(node("body", [node("header")]));
    expect(diffComponentTrees(errPack, t).incomplete).toBe(true);
    expect(diffComponentTrees(t, errPack).incomplete).toBe(true);
    // the errored side yields an empty skeleton → the healthy side's nodes
    // show up there: errored build ⇒ everything missing, errored ref ⇒ extra
    expect(diffComponentTrees(t, errPack).missing).toEqual(["body", "body/header[0]"]);
    expect(diffComponentTrees(errPack, t).extra).toEqual(["body", "body/header[0]"]);
    const truncated = pack(node("body"), { nodeCount: 1200 });
    expect(diffComponentTrees(truncated, t, { maxNodes: 1200 }).incomplete).toBe(true);
    // exactly one under the cap is NOT truncation
    expect(diffComponentTrees(pack(node("body"), { nodeCount: 1199 }), t, { maxNodes: 1200 }).incomplete).toBe(false);
  });
});

describe("compact census helpers (C3)", () => {
  const census = (): ScrollCensus => ({
    url: "https://x.test",
    capturedAt: 1700000000000,
    counts: {
      "gsap-scrolltrigger": 1,
      "css-scroll-timeline": 0,
      "css-view-timeline": 0,
      "data-attr": 0,
      "css-keyframe": 1,
      smil: 1,
      unknown: 0,
    },
    anims: [
      {
        selector: "a", tag: "a", props: ["transform", "opacity"], durationMs: 400,
        delayMs: null, easing: "power2.out", trigger: "gsap-scrolltrigger",
        scrub: true, pin: false, svgStroke: false,
        keyframes: [{ offset: 0, props: { transform: "none" } }],
      },
      {
        selector: "b", tag: "b", props: ["opacity"], durationMs: null,
        delayMs: null, easing: null, trigger: "css-keyframe",
        scrub: false, pin: true, svgStroke: false,
      },
    ],
    svgStrokes: ["#pulse"],
    nativeScrollTimelines: 2,
    gsapTriggers: [
      { selector: "a", scrub: true, pin: false, startPx: 0, endPx: 800, progress: 0.25, vars: { stagger: "0.09" } },
    ],
    gsapRegistryCount: 1,
    scrubCurves: [{ selector: "a", startPx: 0, endPx: 800, steps: [{ scrollY: 0, progress: 0, transform: null }] }],
    reducedMotion: false,
  });

  it("scroll diet: numerics/counts/svg strokes/trigger numerics stay, detail drops", () => {
    const c = compactScrollCensus(census());
    expect(c.counts["gsap-scrolltrigger"]).toBe(1);
    expect(c.gsapRegistryCount).toBe(1);
    expect(c.nativeScrollTimelines).toBe(2);
    expect(c.svgStrokes).toEqual(["#pulse"]);
    expect(c.gsapTriggers).toEqual([
      { selector: "a", scrub: true, pin: false, startPx: 0, endPx: 800, progress: 0.25 },
    ]);
    expect(c.animCount).toBe(2);
    expect(c.scrubCount).toBe(1);
    expect(c.pinCount).toBe(1);
    expect(c.scrubCurveCount).toBe(1);
    expect(c.reducedMotion).toBe(false);
    // Purity + no heavy payloads leak through.
    expect(c as unknown as Record<string, unknown>).not.toHaveProperty("anims");
    expect(c as unknown as Record<string, unknown>).not.toHaveProperty("scrubCurves");
    expect(c.gsapTriggers[0]).not.toHaveProperty("vars");
    expect(compactScrollCensus(census())).toEqual(c);
  });

  it("scroll diet keeps the acquisition disclosure when present", () => {
    const withAcq = {
      ...census(),
      acquisition: {
        waitStrategy: "networkidle" as const,
        settleMs: 3000,
        postScrollMs: 500,
        capturedAt: 1_793_537_000_000,
        documentHeight: 5000,
        animationCount: 2,
        gsapRegistryCount: 1,
        stable: false,
      },
    };
    const c = compactScrollCensus(withAcq);
    expect(c.acquisition).toEqual(withAcq.acquisition);
    expect(compactScrollCensus(census())).not.toHaveProperty("acquisition");
  });

  it("scroll diet is total: drops keyframes, scrubCurves, per-anim props", () => {
    const c = compactScrollCensus(census()) as unknown as Record<string, unknown>;
    expect(JSON.stringify(c)).not.toContain("keyframes");
    expect(JSON.stringify(c)).not.toContain('"steps"');
    expect(JSON.stringify(c)).not.toContain("power2.out");
  });

  it("hover diet: counts + selectors stay, sample bodies drop, note passes through", () => {
    const hover = (): HoverCensus => ({
      url: "https://x.test",
      capturedAt: 0,
      hoverRuleCount: 7,
      candidates: 3,
      samples: [
        { selector: "a.cta", changedProps: ["transform"], transitionMs: 150, easing: "cubic-bezier(0, 0, 0.2, 1)" },
        { selector: "nav li", changedProps: ["color"], transitionMs: 200, easing: "linear" },
      ],
      note: "touch-only context — hover interactions skipped",
      reducedMotion: false,
    });
    const c = compactHoverCensus(hover());
    expect(c.hoverRuleCount).toBe(7);
    expect(c.candidates).toBe(3);
    expect(c.sampleCount).toBe(2);
    expect(c.sampleSelectors).toEqual(["a.cta", "nav li"]);
    expect(c.note).toBe("touch-only context — hover interactions skipped");
    expect(c as unknown as Record<string, unknown>).not.toHaveProperty("samples");
    expect(compactHoverCensus(hover())).toEqual(c);
    // Purity: the input census is not mutated.
    expect(hover().samples).toHaveLength(2);
  });
});
