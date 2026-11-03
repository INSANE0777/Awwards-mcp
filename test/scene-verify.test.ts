import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ScrollCensus } from "../src/census.js";
import type { HoverCensus } from "../src/hover-census.js";
import type { Scene3dVerifyResult, VerifySceneFn } from "../src/scene-verify.js";
import { diffRgbaMetrics, sceneVerifyBudget, verifyScene3d } from "../src/scene-verify.js";
import type { PageStructure } from "../src/structure.js";
import { compactVerifyReport } from "../src/server/types.js";
import type { VerifyReport } from "../src/server.js";
import { verify_build } from "../src/server/handlers/audit.js";
import { registerVerifyBuild } from "../src/tools/audit.js";
import { registerVerifyBuildV2 } from "../src/v2/retained.js";
import { verifyBuild } from "../src/verify-build.js";

// ---- scene-verify fixtures ----------------------------------------------

const SCENE_ID = "scene-mg2k3j4p-0123abcd";
const publicDns = async () => ["93.184.216.34"];

interface ScenePack {
  sceneDir: string;
  captureDir: string;
  evidencePath: string;
  framePath: string;
}

/** A minimal scene-evidence-v1 pack whose only checkpoint is replayable. */
function writeScenePack(
  sceneDir: string,
  mutate: (evidence: any) => void = () => {},
): ScenePack {
  const captureDir = join(sceneDir, SCENE_ID);
  const framesDir = join(captureDir, "frames");
  mkdirSync(framesDir, { recursive: true });
  const framePath = join(framesDir, "frame-01-canvas.png");
  writeFileSync(framePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const evidencePath = join(captureDir, "evidence.json");
  const evidence: any = {
    id: "scene-evidence-v1",
    url: "https://ref.test/",
    captureId: SCENE_ID,
    capturedAt: 1_700_000_000_000,
    viewport: { name: "desktop", width: 1440, height: 900 },
    canvas: { requestedSelector: null, usedSelector: "canvas", canvases: 1 },
    frameworkHints: {
      three: { detected: false, version: null, scripts: [] },
      babylon: { detected: false, version: null, scripts: [] },
      playcanvas: { detected: false, version: null, scripts: [] },
      canvasCount: 1,
    },
    checkpoints: [
      {
        index: 0,
        requestedScrollRatio: 0.6,
        requestedScrollTop: 1260,
        actualScrollTop: 1100,
        scrollRange: 2100,
        scrollRoot: "window",
        scrollRootFound: true,
        pointer: null,
        pointerPx: null,
        waitMs: 0,
        elapsedMs: 5,
        canvas: {
          rect: { x: 40, y: 30, width: 600, height: 400 },
          backing: { width: 600, height: 400 },
          dpr: 1,
        },
        files: { canvas: framePath },
      },
    ],
    resources: [],
    resourceTotal: 0,
    resourcesTruncated: false,
    blockedRequests: { count: 0, samples: [] },
    assetOrigins: [],
    paths: { dir: captureDir, evidence: evidencePath, framesDir },
    coverage: { status: "partial", collected: 1, excluded: 0, limitations: [] },
    limitations: [],
  };
  mutate(evidence);
  writeFileSync(evidencePath, JSON.stringify(evidence));
  return { sceneDir, captureDir, evidencePath, framePath };
}

const sceneVerifyArgs = (pack: ScenePack) => ({
  buildUrl: "https://build.test/",
  referenceCaptureId: SCENE_ID,
  buildSelector: "#scene",
  sceneDir: pack.sceneDir,
  resolveHost: publicDns,
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "awwwards-scene-verify-unit-"));
}


describe("verifyScene3d reference resolution", () => {
  // Both failures resolve before Playwright is imported, so no browser runs.
  it("missing packs and traversal ids are inconclusive, never a thrown error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "awwwards-scene-verify-unit-"));
    try {
      const missing = await verifyScene3d({
        buildUrl: "https://build.test/",
        referenceCaptureId: "scene-nope-0123abcd",
        buildSelector: "#scene",
        sceneDir: dir,
      });
      expect("error" in missing).toBe(false);
      if ("error" in missing) return;
      expect(missing.status).toBe("inconclusive");
      expect(missing.verdict).toBe("inconclusive");
      expect(missing.limitations[0]).toContain("was not found");

      const traversal = await verifyScene3d({
        buildUrl: "https://build.test/",
        referenceCaptureId: "../scene-nope-0123abcd",
        buildSelector: "#scene",
        sceneDir: dir,
      });
      expect("error" in traversal).toBe(false);
      if ("error" in traversal) return;
      expect(traversal.status).toBe("inconclusive");
      expect(traversal.limitations[0]).toContain("is not a scene capture ID");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verifyScene3d evidence validation", () => {
  const cases: Array<[string, (evidence: any) => void]> = [
    ["missing actualScrollTop", (e) => delete e.checkpoints[0].actualScrollTop],
    ["null actualScrollTop", (e) => (e.checkpoints[0].actualScrollTop = null)],
    ["string actualScrollTop", (e) => (e.checkpoints[0].actualScrollTop = "1100")],
    ["missing requestedScrollTop", (e) => delete e.checkpoints[0].requestedScrollTop],
    ["null requestedScrollTop", (e) => (e.checkpoints[0].requestedScrollTop = null)],
    ["missing waitMs", (e) => delete e.checkpoints[0].waitMs],
    ["waitMs above the capture cap", (e) => (e.checkpoints[0].waitMs = 2_001)],
    ["negative waitMs", (e) => (e.checkpoints[0].waitMs = -1)],
    ["missing scrollRootFound", (e) => delete e.checkpoints[0].scrollRootFound],
    ["scrollRootFound false", (e) => (e.checkpoints[0].scrollRootFound = false)],
    ["empty canvas rect", (e) => (e.checkpoints[0].canvas.rect = {})],
    ["zero-width canvas rect", (e) => (e.checkpoints[0].canvas.rect.width = 0)],
    ["zero backing size", (e) => (e.checkpoints[0].canvas.backing = { width: 0, height: 400 })],
    ["zero dpr", (e) => (e.checkpoints[0].canvas.dpr = 0)],
    ["pointer outside 0..1", (e) => (e.checkpoints[0].pointer = { x: 1.2, y: 0.5 })],
    ["pointer missing a coordinate", (e) => (e.checkpoints[0].pointer = { x: 0.5 })],
    ["missing frame path", (e) => (e.checkpoints[0].files.canvas = "")],
  ];

  for (const [name, mutate] of cases) {
    it(`${name}: inconclusive before any browser work`, async () => {
      const dir = tempDir();
      try {
        const pack = writeScenePack(dir, mutate);
        const result = await verifyScene3d(sceneVerifyArgs(pack));
        expect("error" in result).toBe(false);
        if ("error" in result) return;
        expect(result.status).toBe("inconclusive");
        expect(result.verdict).toBe("inconclusive");
        expect(result.limitations.join(" ")).toContain("has a checkpoint with");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("verifyScene3d artifact confinement", () => {
  it("an occupied verify path is an artifact failure, never a pass", async () => {
    const dir = tempDir();
    try {
      const pack = writeScenePack(dir);
      writeFileSync(join(pack.captureDir, "verify"), "not a directory");
      const result = await verifyScene3d(sceneVerifyArgs(pack));
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.status).toBe("inconclusive");
      expect(result.verdict).toBe("inconclusive");
      expect(result.checkpoints.every((cp) => cp.buildImage === null && cp.diffImage === null)).toBe(
        true,
      );
      expect(result.limitations.join(" ")).toContain("artifacts could not be prepared");
      expect(result.limitations.join(" ")).toContain("not a directory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a junction at capture/verify cannot redirect artifacts outside the capture", async () => {
    const dir = tempDir();
    const outside = tempDir();
    try {
      const pack = writeScenePack(dir);
      try {
        symlinkSync(outside, join(pack.captureDir, "verify"), "junction");
      } catch {
        // The OS denied junction creation; there is nothing to assert here.
        return;
      }
      const result = await verifyScene3d(sceneVerifyArgs(pack));
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.status).toBe("inconclusive");
      expect(result.verdict).not.toBe("within-tolerance");
      expect(result.limitations.join(" ")).toContain("artifacts could not be prepared");
      expect(result.limitations.join(" ")).toContain("symlink or junction");
      // Nothing may be written through the junction.
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("diffRgbaMetrics (pure)", () => {
  const pixel = (...rgba: number[]) => rgba;

  it("identical buffers: no changed pixels, zero error", () => {
    const frame = Uint8Array.from([10, 20, 30, 255, 200, 100, 50, 255]);
    const m = diffRgbaMetrics(frame, frame, 0);
    expect(m.changedPixelFraction).toBe(0);
    expect(m.meanAbsoluteChannelError).toBe(0);
  });

  it("one fully changed pixel of four: fraction 0.25, MAE 255/(4*3*255)", () => {
    const a = Uint8Array.from([
      ...pixel(0, 0, 0, 255),
      ...pixel(0, 0, 0, 255),
      ...pixel(0, 0, 0, 255),
      ...pixel(0, 0, 0, 255),
    ]);
    const b = Uint8Array.from([
      ...pixel(255, 255, 255, 255),
      ...pixel(0, 0, 0, 255),
      ...pixel(0, 0, 0, 255),
      ...pixel(0, 0, 0, 255),
    ]);
    const m = diffRgbaMetrics(a, b, 0);
    expect(m.changedPixelFraction).toBe(0.25);
    // One fully-different pixel of four = a quarter of the total channel error.
    expect(m.meanAbsoluteChannelError).toBeCloseTo(0.25, 10);
  });

  it("pixelThreshold is normalized 0..1: delta 10 passes 0.1, fails 0.03", () => {
    const a = Uint8Array.from([0, 0, 0, 255]);
    const b = Uint8Array.from([10, 0, 0, 255]);
    expect(diffRgbaMetrics(a, b, 0.1).changedPixelFraction).toBe(0);
    expect(diffRgbaMetrics(a, b, 0.03).changedPixelFraction).toBe(1);
    // Boundary: the comparison is strictly greater than the threshold.
    expect(diffRgbaMetrics(a, b, 10 / 255).changedPixelFraction).toBe(0);
  });

  it("ignores alpha and clamps out-of-range thresholds", () => {
    const a = Uint8Array.from([1, 2, 3, 0]);
    const b = Uint8Array.from([1, 2, 3, 255]);
    expect(diffRgbaMetrics(a, b, 0).changedPixelFraction).toBe(0);
    // Negative thresholds clamp to 0, so any RGB delta counts...
    expect(
      diffRgbaMetrics(Uint8Array.from([0, 0, 0, 255]), Uint8Array.from([1, 0, 0, 255]), -5)
        .changedPixelFraction,
    ).toBe(1);
    // ...and 1 clamps to full scale, where no 8-bit delta can exceed it.
    expect(
      diffRgbaMetrics(Uint8Array.from([0, 0, 0, 255]), Uint8Array.from([255, 255, 255, 255]), 9)
        .changedPixelFraction,
    ).toBe(0);
  });

  it("truncates to whole pixels of the shorter buffer", () => {
    const a = Uint8Array.from([0, 0, 0, 255, 0, 0, 0, 255]);
    const b = Uint8Array.from([0, 0, 0, 255, 0, 0, 0]);
    const m = diffRgbaMetrics(a, b, 0);
    expect(m.changedPixelFraction).toBe(0);
    expect(m.meanAbsoluteChannelError).toBe(0);
  });
});

function surfaceSchema(register: (ctx: any) => void): z.ZodObject<any> {
  const ctx = { handlers: {}, tool: vi.fn(), registerTool: vi.fn() } as any;
  register(ctx);
  expect(ctx.tool).toHaveBeenCalledTimes(1);
  const [, , shape] = ctx.tool.mock.calls[0];
  return z.object(shape);
}

describe("verify_build scene3d schema (full and v2)", () => {
  const full = surfaceSchema(registerVerifyBuild);
  const v2 = surfaceSchema(registerVerifyBuildV2);
  const base = { buildUrl: "https://build.test/", referenceUrl: "https://ref.test/" };
  const scene3d = {
    referenceCaptureId: "scene-mg2k3j4p-0123abcd",
    buildSelector: "#scene",
    tolerances: { pixelThreshold: 0.05, maxChangedFraction: 0.02, cameraAngleDeg: 4 },
  };

  for (const [name, schema] of [
    ["full", full],
    ["v2", v2],
  ] as const) {
    it(`${name}: accepts scene3d and keeps the legacy defaults`, () => {
      const parsed = schema.parse({ ...base, scene3d });
      expect(parsed.scene3d).toEqual(scene3d);
      expect(parsed.domDiff).toBe(false);
      // Legacy-only payloads stay valid and carry no scene3d key.
      expect("scene3d" in schema.parse(base)).toBe(false);
    });

    it(`${name}: rejects missing/invalid scene3d fields and out-of-range tolerances`, () => {
      const invalid = [
        { ...base, scene3d: { buildSelector: "#scene" } },
        { ...base, scene3d: { referenceCaptureId: scene3d.referenceCaptureId } },
        { ...base, scene3d: { ...scene3d, buildSelector: "" } },
        { ...base, scene3d: { ...scene3d, referenceCaptureId: "../scene-mg2k3j4p-0123abcd" } },
        { ...base, scene3d: { ...scene3d, referenceCaptureId: "scene-abc" } },
        { ...base, scene3d: { ...scene3d, tolerances: { pixelThreshold: 1.01 } } },
        { ...base, scene3d: { ...scene3d, tolerances: { maxChangedFraction: -0.01 } } },
        { ...base, scene3d: { ...scene3d, tolerances: { cameraAngleDeg: 181 } } },
        { ...base, scene3d: { ...scene3d, extra: true } },
        { ...base, scene3d: { ...scene3d, tolerances: { pixelThreshold: 0.1, nope: 1 } } },
      ];
      for (const input of invalid) {
        expect(schema.safeParse(input).success, JSON.stringify(input)).toBe(false);
      }
    });
  }
});

// ---- verifyBuild wiring -------------------------------------------------

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
  anims: [
    {
      selector: "section",
      tag: "section",
      props: ["transform"],
      durationMs: null,
      delayMs: null,
      easing: "power2.out",
      trigger: "gsap-scrolltrigger",
      scrub: true,
      pin: false,
      svgStroke: false,
    },
  ],
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
const okFetch =
  (): typeof fetch =>
  (async () => ({ ok: true, status: 200, text: async () => "" })) as unknown as typeof fetch;
const offlineEvidence = {
  perfFn: async () => ({ error: "skipped in fixture" }),
  rulesFn: () => [],
  fetchFn: okFetch(),
};
const captureFakes = {
  structureFn: async () => refStruct(),
  scrollFn: async () => scrollCensus(),
  hoverFn: async () => hoverCensus(),
};

const sceneResult = (): Scene3dVerifyResult => ({
  status: "comparable",
  verdict: "within-tolerance",
  requested: 1,
  compared: 1,
  checkpoints: [
    {
      index: 0,
      status: "comparable",
      referenceImage: "/cache/scene-captures/ref/frame-01-canvas.png",
      buildImage: "/cache/scene-captures/ref/verify/run/frame-01-build.png",
      diffImage: "/cache/scene-captures/ref/verify/run/frame-01-diff.png",
      changedPixelFraction: 0.001,
      meanAbsoluteChannelError: 0.0004,
      cameraAngleDeg: null,
      reasons: ["no comparable camera angle in the reference evidence (passive capture never reads camera state)"],
    },
  ],
  coverage: { status: "partial", collected: 1, excluded: 0, limitations: ["pixel only"] },
  limitations: ["pixel only"],
});

const sceneArgs = {
  referenceCaptureId: "scene-mg2k3j4p-0123abcd",
  buildSelector: "#scene",
  tolerances: { pixelThreshold: 0.05, maxChangedFraction: 0.02 },
};

// A fake Playwright surface: the comparator page's evaluate never settles, so
// only the watchdog can end the run, unless opts.compare resolves it.
function fakeSceneBrowser(
  opts: {
    hangClose?: boolean;
    compare?: boolean;
    onWait?: (ms: number) => Promise<void>;
  } = {},
): {
  loader: () => Promise<any>;
  closed: string[];
  waits: number[];
} {
  const closed: string[] = [];
  const waits: number[] = [];
  const close = (name: string): Promise<void> => {
    closed.push(name);
    return opts.hangClose ? new Promise<void>(() => {}) : Promise.resolve();
  };
  const page = (kind: "build" | "comparator") => ({
    setDefaultTimeout: vi.fn(),
    addInitScript: vi.fn(async () => undefined),
    goto: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async (ms: number) => {
      waits.push(ms);
      await opts.onWait?.(ms);
    }),
    close: vi.fn(() => close(`${kind}-page`)),
    mouse: { move: vi.fn(async () => undefined) },
    screenshot: vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    evaluate: vi.fn(async (_fn: unknown, arg: any) => {
      if (kind === "comparator") {
        return opts.compare
          ? {
              width: 600,
              height: 400,
              changedPixelFraction: 0,
              meanAbsoluteChannelError: 0,
              referenceColors: 12,
              buildColors: 12,
              diff: "",
            }
          : new Promise(() => {});
      }
      if (arg && typeof arg === "object" && "selector" in arg) {
        return { selector: 'canvas[data-awwwards-scene="1"]' };
      }
      if (arg && typeof arg === "object" && "top" in arg) return arg.top;
      if (arg && typeof arg === "object" && "canvasSelector" in arg) {
        return {
          canvasFound: true,
          canvasMatches: 1,
          rect: { x: 40, y: 30, width: 600, height: 400 },
          backing: { width: 600, height: 400 },
          dpr: 1,
          scroll: { top: 1100, range: 2100 },
          scrollRootFound: true,
        };
      }
      return 0;
    }),
  });
  const contexts = [
    {
      route: vi.fn(async () => undefined),
      on: vi.fn(),
      newPage: vi.fn(async () => page("build")),
      close: vi.fn(() => close("build-context")),
    },
    {
      route: vi.fn(async () => undefined),
      on: vi.fn(),
      newPage: vi.fn(async () => page("comparator")),
      close: vi.fn(() => close("comparator-context")),
    },
  ];
  const browser = {
    newContext: vi.fn(async () => contexts.shift()),
    close: vi.fn(() => close("browser")),
  };
  const chromium = { launch: vi.fn(async () => browser) };
  return { loader: async () => ({ chromium }), closed, waits };
}

describe("verifyScene3d watchdog", () => {
  it("a never-settling comparator stops at the deadline, closes resources and still returns the legacy report", async () => {
    const dir = tempDir();
    try {
      const pack = writeScenePack(dir);
      const fake = fakeSceneBrowser();
      const started = Date.now();
      const result = await verifyScene3d({
        ...sceneVerifyArgs(pack),
        loader: fake.loader,
        // Long enough that preflight and the comparator page are reached even
        // on a loaded CI box; the comparator itself never settles.
        timeoutMs: 2_000,
      });
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.status).toBe("inconclusive");
      expect(result.verdict).toBe("inconclusive");
      expect(result.limitations.join(" ")).toMatch(/2000ms deadline/);
      expect(Date.now() - started).toBeLessThan(5_000);
      for (const name of [
        "comparator-page",
        "comparator-context",
        "build-page",
        "build-context",
        "browser",
      ]) {
        expect(fake.closed).toContain(name);
      }

      // A timed-out scene gate must not take the legacy verify report with it.
      const legacyFake = fakeSceneBrowser();
      const legacy = await verifyBuild({
        buildUrl: "https://build.test",
        referenceUrl: "https://ref.test",
        ...captureFakes,
        ...offlineEvidence,
        scene3d: { referenceCaptureId: SCENE_ID, buildSelector: "#scene" },
        sceneDir: dir,
        resolveHost: publicDns,
        sceneFn: (args) =>
          verifyScene3d({
            ...args,
            loader: legacyFake.loader,
            timeoutMs: 2_000,
            resolveHost: publicDns,
          }),
      });
      expect("error" in legacy).toBe(false);
      if ("error" in legacy) return;
      expect(legacy.verdict).toMatch(/pass|warn|fail/);
      expect(legacy.scene3d?.status).toBe("inconclusive");
      expect(legacy.scene3d?.limitations.join(" ")).toContain("deadline");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verifyScene3d replay budget", () => {
  const maxSchedule = Array.from({ length: 10 }, () => ({ waitMs: 2_000 }));

  it("the maximum accepted schedule fits the default deadline", () => {
    const budget = sceneVerifyBudget(maxSchedule);
    expect(budget.waitsMs).toBe(20_000);
    expect(budget.timeoutMs).toBe(30_000);
    expect(budget.timeoutMs).toBeGreaterThanOrEqual(budget.waitsMs + 10_000);
    // A short schedule keeps the 15s floor; the cap and an explicit seam win.
    expect(sceneVerifyBudget(undefined).timeoutMs).toBe(15_000);
    expect(sceneVerifyBudget(maxSchedule.concat(maxSchedule, maxSchedule)).timeoutMs).toBe(45_000);
    expect(sceneVerifyBudget(maxSchedule, 60_000).timeoutMs).toBe(60_000);
  });

  it("replays 10 x 2000ms checkpoints under the default deadline", async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    try {
      const pack = writeScenePack(dir, (evidence) => {
        const base = evidence.checkpoints[0];
        evidence.checkpoints = Array.from({ length: 10 }, (_, index) => ({
          ...base,
          index,
          waitMs: 2_000,
        }));
      });
      const fake = fakeSceneBrowser({
        compare: true,
        // Clock time moves only when the run replays a wait, so a 15s deadline
        // would expire inside this 20s schedule and a 30s one would not.
        onWait: (ms) => vi.advanceTimersByTimeAsync(ms),
      });
      const result = await verifyScene3d({
        ...sceneVerifyArgs(pack),
        tolerances: { pixelThreshold: 0.02, maxChangedFraction: 0.01 },
        loader: fake.loader,
      });
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.limitations.join(" ")).not.toContain("deadline");
      expect(result.requested).toBe(10);
      expect(result.compared).toBe(10);
      expect(result.status).toBe("comparable");
      expect(result.verdict).toBe("within-tolerance");
      const replayWaits = fake.waits.filter((ms) => ms === 2_000);
      expect(replayWaits).toHaveLength(10);
      expect(replayWaits.reduce((sum, ms) => sum + ms, 0)).toBe(20_000);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verifyScene3d whole-run watchdog", () => {
  const legacyReport = async (
    dir: string,
    overrides: { resolveHost?: () => Promise<string[]>; loader?: () => Promise<any> },
  ) => {
    const report = await verifyBuild({
      buildUrl: "https://build.test",
      referenceUrl: "https://ref.test",
      ...captureFakes,
      ...offlineEvidence,
      scene3d: { referenceCaptureId: SCENE_ID, buildSelector: "#scene" },
      sceneDir: dir,
      resolveHost: publicDns,
      sceneFn: (args) => verifyScene3d({ ...args, timeoutMs: 50, ...overrides }),
    });
    expect("error" in report).toBe(false);
    if ("error" in report) return report;
    expect(report.verdict).toMatch(/pass|warn|fail/);
    expect(report.scene3d?.status).toBe("inconclusive");
    expect(report.scene3d?.limitations.join(" ")).toContain("50ms deadline");
    return report;
  };

  it("stalled DNS resolves at the deadline and still returns the legacy report", async () => {
    const dir = tempDir();
    try {
      const pack = writeScenePack(dir);
      const started = Date.now();
      const result = await verifyScene3d({
        ...sceneVerifyArgs(pack),
        resolveHost: () => new Promise<string[]>(() => {}),
        timeoutMs: 50,
      });
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.status).toBe("inconclusive");
      expect(result.limitations.join(" ")).toContain("50ms deadline");
      expect(Date.now() - started).toBeLessThan(4_000);

      await legacyReport(dir, { resolveHost: () => new Promise<string[]>(() => {}) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stalled Playwright loader resolves at the deadline and still returns the legacy report", async () => {
    const dir = tempDir();
    try {
      const pack = writeScenePack(dir);
      const started = Date.now();
      const result = await verifyScene3d({
        ...sceneVerifyArgs(pack),
        loader: () => new Promise<any>(() => {}),
        timeoutMs: 50,
      });
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.status).toBe("inconclusive");
      expect(result.limitations.join(" ")).toContain("50ms deadline");
      expect(Date.now() - started).toBeLessThan(4_000);

      await legacyReport(dir, {
        loader: () => new Promise<any>(() => {}),
        resolveHost: publicDns,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("a browser that launches after the deadline is closed on arrival", async () => {
    const dir = tempDir();
    try {
      const pack = writeScenePack(dir);
      let release!: (value: any) => void;
      const closed: string[] = [];
      const browser = {
        close: async () => {
          closed.push("browser");
        },
        newContext: async () => {
          throw new Error("browser was already closing");
        },
      };
      const result = await verifyScene3d({
        ...sceneVerifyArgs(pack),
        loader: () => new Promise<any>((resolve) => (release = resolve)),
        // The local preflight must finish before the stalled loader is reached.
        timeoutMs: 2_000,
      });
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.limitations.join(" ")).toContain("2000ms deadline");
      expect(typeof release).toBe("function");

      release({ chromium: { launch: async () => browser } });
      for (let i = 0; i < 50 && !closed.includes("browser"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(closed).toContain("browser");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("stalled close calls share one 3s grace and still return the legacy report", async () => {
    const dir = tempDir();
    try {
      const pack = writeScenePack(dir);
      const fake = fakeSceneBrowser({ hangClose: true });
      const started = Date.now();
      const legacy = await verifyBuild({
        buildUrl: "https://build.test",
        referenceUrl: "https://ref.test",
        ...captureFakes,
        ...offlineEvidence,
        scene3d: { referenceCaptureId: SCENE_ID, buildSelector: "#scene" },
        sceneDir: dir,
        resolveHost: publicDns,
        sceneFn: (args) =>
          verifyScene3d({
            ...args,
            loader: fake.loader,
            timeoutMs: 1_500,
            resolveHost: publicDns,
          }),
      });
      const elapsed = Date.now() - started;

      expect("error" in legacy).toBe(false);
      if ("error" in legacy) return;
      expect(legacy.verdict).toMatch(/pass|warn|fail/);
      expect(legacy.scene3d?.status).toBe("inconclusive");
      expect(legacy.scene3d?.limitations.join(" ")).toContain("1500ms deadline");
      // Closes were started, not serialized: build resources plus the browser
      // are all in flight when the shared grace expires.
      expect(fake.closed).toEqual(
        expect.arrayContaining(["build-page", "build-context", "browser"]),
      );
      expect(elapsed).toBeGreaterThanOrEqual(4_400);
      expect(elapsed).toBeLessThan(5_200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verifyBuild scene3d orchestration", () => {
  it("dispatches the scene gate with the build URL and keeps legacy score/verdict", async () => {
    const seen: unknown[] = [];
    const sceneFn: VerifySceneFn = async (args) => {
      seen.push(args);
      return sceneResult();
    };
    const control = await verifyBuild({
      buildUrl: "https://build.test",
      referenceUrl: "https://ref.test",
      ...captureFakes,
      ...offlineEvidence,
    });
    const report = await verifyBuild({
      buildUrl: "https://build.test",
      referenceUrl: "https://ref.test",
      ...captureFakes,
      ...offlineEvidence,
      scene3d: sceneArgs,
      sceneDir: "/cache/scene-captures",
      resolveHost: publicDns,
      sceneFn,
    });
    expect("error" in control || "error" in report).toBe(false);
    if ("error" in control || "error" in report) return;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      ...sceneArgs,
      buildUrl: "https://build.test",
      sceneDir: "/cache/scene-captures",
    });
    expect(
      (seen[0] as { networkGuard?: { proxy: { url: string } } }).networkGuard?.proxy.url,
    ).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(report.scene3d).toEqual(sceneResult());
    // The legacy score, verdict and evidence slots are untouched.
    expect(report.overall).toBe(control.overall);
    expect(report.verdict).toBe(control.verdict);
    expect(report.evidence).toEqual(control.evidence);
    expect("scene3d" in control).toBe(false);
  });

  it("a scene-gate error degrades to an inconclusive block, never a failed verify", async () => {
    const report = await verifyBuild({
      buildUrl: "https://build.test",
      referenceUrl: "https://ref.test",
      ...captureFakes,
      ...offlineEvidence,
      scene3d: sceneArgs,
      resolveHost: publicDns,
      sceneFn: async () => ({ error: "reference capture scene-x-0123abcd was not found under scene-captures." }),
    });
    expect("error" in report).toBe(false);
    if ("error" in report) return;
    expect(report.verdict).toMatch(/pass|warn|fail/);
    expect(report.scene3d?.status).toBe("inconclusive");
    expect(report.scene3d?.verdict).toBe("inconclusive");
    expect(report.scene3d?.requested).toBe(0);
    expect(report.scene3d?.checkpoints).toEqual([]);
    expect(report.scene3d?.limitations[0]).toContain("was not found");
  });

  it("a throwing sceneFn is contained the same way", async () => {
    const report = await verifyBuild({
      buildUrl: "https://build.test",
      referenceUrl: "https://ref.test",
      ...captureFakes,
      ...offlineEvidence,
      scene3d: sceneArgs,
      resolveHost: publicDns,
      sceneFn: async () => {
        throw new Error("browser crashed");
      },
    });
    expect("error" in report).toBe(false);
    if ("error" in report) return;
    expect(report.scene3d?.status).toBe("inconclusive");
    expect(report.scene3d?.limitations[0]).toContain("browser crashed");
  });

  it("compact output keeps scene3d whole and still drops evidence", () => {
    const report: VerifyReport = {
      buildUrl: "https://build.test",
      referenceUrl: "https://ref.test",
      bands: { score: 82, matched: ["hero", "footer"], refOnly: [], buildOnly: [] },
      motion: { score: 64, refFingerprint: "k1", buildFingerprint: "k1" },
      overall: 75,
      verdict: "warn",
      evidence: ["Bands: 82/100 similarity"],
      scene3d: sceneResult(),
    };
    const compact = compactVerifyReport(report);
    expect(compact.scene3d).toEqual(sceneResult());
    expect(compact).toEqual({
      verdict: "warn",
      overall: 75,
      bands: { score: 82, matched: 2, refOnly: 0, buildOnly: 0 },
      motion: { score: 64 },
      scene3d: sceneResult(),
    });
    expect("evidence" in compact).toBe(false);
  });
});

// ---- handler wiring -----------------------------------------------------

const handlerReport = (): VerifyReport => ({
  buildUrl: "https://b.test/",
  referenceUrl: "https://r.test/",
  bands: { score: 82, matched: [], refOnly: [], buildOnly: [] },
  motion: { score: 64, refFingerprint: "k1", buildFingerprint: "k1" },
  overall: 75,
  verdict: "warn",
  evidence: [],
});

describe("verify_build handler scene3d wiring", () => {
  const rootDir = join("/tmp", "awwwards-cache");

  it("forwards scene3d, the capture directory and the injected gate", async () => {
    const verifyBuildFn = vi.fn(async (_args: any) => handlerReport());
    const verifySceneFn: VerifySceneFn = async () => sceneResult();
    const ctx = {
      deps: { verifyBuildFn, verifySceneFn },
      cache: { rootDir },
    } as any;

    const res = await verify_build(ctx, {
      buildUrl: "https://b.test/",
      referenceUrl: "https://r.test/",
      scene3d: sceneArgs,
    });

    expect(res.isError).toBeUndefined();
    expect(verifyBuildFn).toHaveBeenCalledTimes(1);
    expect(verifyBuildFn.mock.calls[0]![0]).toEqual({
      buildUrl: "https://b.test/",
      referenceUrl: "https://r.test/",
      waitStrategy: undefined,
      viewport: undefined,
      domDiff: undefined,
      scene3d: sceneArgs,
      sceneDir: join(rootDir, "scene-captures"),
      sceneFn: verifySceneFn,
    });
  });

  it("legacy calls carry no scene keys", async () => {
    const verifyBuildFn = vi.fn(async (_args: any) => handlerReport());
    const ctx = { deps: { verifyBuildFn }, cache: { rootDir } } as any;

    await verify_build(ctx, { buildUrl: "https://b.test/", referenceUrl: "https://r.test/" });

    const args = verifyBuildFn.mock.calls[0]![0] as Record<string, unknown>;
    expect("scene3d" in args).toBe(false);
    expect("sceneDir" in args).toBe(false);
    expect("sceneFn" in args).toBe(false);
  });

  it("compact response keeps the scene3d block", async () => {
    const ctx = {
      deps: {
        verifyBuildFn: async (_args: any): Promise<VerifyReport> => ({
          ...handlerReport(),
          scene3d: sceneResult(),
        }),
      },
      cache: { rootDir },
    } as any;

    const res = await verify_build(ctx, {
      buildUrl: "https://b.test/",
      referenceUrl: "https://r.test/",
      compact: true,
    });
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.scene3d).toEqual(sceneResult());
    expect("evidence" in parsed).toBe(false);
  });
});
