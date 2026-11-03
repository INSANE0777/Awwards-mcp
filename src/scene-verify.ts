// Opt-in visual 3D gate for verify_build. It replays a reference capture's
// checkpoints (viewport, canvas rect/DPR, scroll ratios, pointer, waits) against
// a build page in a fresh browser, screenshots the same canvas crop, and
// compares the PNGs pixel-by-pixel. It never reads a scene graph, camera or
// shader: the frames are rendered output, nothing more.
//
// Every incomparability (missing/blank frame, dimensions, scroll, context loss)
// is recorded per checkpoint and forces an inconclusive verdict. Nothing here
// can turn an incomparable pair into a pass.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { CAPTURE_INSTALL_HINT } from "./capture.js";
import { coverageFrom, type EvidenceCoverage } from "./coverage.js";
import { resolveSceneCaptureDir } from "./scene-assets.js";
import {
  SCENE_CANVAS_PICK,
  SCENE_LIMITS,
  SCENE_PROBE,
  SCENE_SCROLL,
  defaultSceneResolveHost,
  createSceneUrlGate,
  normalizeScenePrivateOrigins,
  redactSceneError,
  sceneCanvasClip,
  startSceneProxy,
  type SceneCheckpointResult,
  type SceneEvidence,
  type SceneNetworkGuard,
  type SceneRect,
} from "./scene-capture.js";
import { resolveViewport } from "./viewport.js";

export const SCENE_VERIFY_LIMITS = {
  /** A frame with at most this many sampled colours is treated as blank. */
  blankUniqueColors: 4,
  scrollSettleMs: 1_500,
  /** The build scroll position must match the reference actual position this closely. */
  scrollMatchPx: 2,
  /** Shared bound for closing all run resources; not a per-resource budget. */
  closeGraceMs: 3_000,
  /** Floor for the whole-run deadline (page acquisition + comparator decode). */
  timeoutMs: 15_000,
  /** Headroom over replayed checkpoint waits for acquisition, shots and comparison. */
  replayHeadroomMs: 10_000,
  /** Hard cap for a computed whole-run deadline. */
  maxTimeoutMs: 45_000,
} as const;

export interface Scene3dVerifyBudget {
  /** Whole-run deadline in milliseconds. */
  timeoutMs: number;
  /** Sum of the replayed checkpoint waits the deadline covers. */
  waitsMs: number;
  /** Why the deadline is this value; quoted in timeout limitations. */
  basis: string;
}

// The capture accepts 10 checkpoints x 2000ms waits, which alone outlives the
// 15s floor, so the deadline is computed from the schedule actually replayed.
// An explicit override (test seam) always wins and is never extended or capped.
export function sceneVerifyBudget(
  checkpoints: ReadonlyArray<{ waitMs?: number }> | undefined,
  overrideMs?: number,
): Scene3dVerifyBudget {
  const waitsMs = (checkpoints ?? []).reduce(
    (sum, checkpoint) =>
      sum + Math.max(0, Math.min(SCENE_LIMITS.maxWaitMs, Number(checkpoint?.waitMs) || 0)),
    0,
  );
  const override = Math.round(Number(overrideMs) || 0);
  if (override > 0) {
    return { timeoutMs: override, waitsMs, basis: "an explicit timeoutMs override" };
  }
  return {
    timeoutMs: Math.min(
      SCENE_VERIFY_LIMITS.maxTimeoutMs,
      Math.max(SCENE_VERIFY_LIMITS.timeoutMs, waitsMs + SCENE_VERIFY_LIMITS.replayHeadroomMs),
    ),
    waitsMs,
    basis: `${waitsMs}ms of checkpoint waits plus ${SCENE_VERIFY_LIMITS.replayHeadroomMs}ms acquisition/comparison headroom`,
  };
}

export interface Scene3dTolerances {
  /** Per-channel normalized delta (0..1) above which a pixel counts as changed. */
  pixelThreshold?: number;
  /** Max share of changed pixels (0..1) for a checkpoint to pass. */
  maxChangedFraction?: number;
  /** Accepted camera-angle delta in degrees; only used when evidence carries it. */
  cameraAngleDeg?: number;
}

export interface Scene3dVerifyOptions {
  referenceCaptureId: string;
  buildSelector: string;
  tolerances?: Scene3dTolerances;
}

export interface Scene3dVerifyCheckpoint {
  index: number;
  status: "comparable" | "inconclusive";
  referenceImage: string | null;
  buildImage: string | null;
  diffImage: string | null;
  changedPixelFraction: number | null;
  meanAbsoluteChannelError: number | null;
  cameraAngleDeg: number | null;
  reasons: string[];
}

export interface Scene3dVerifyResult {
  status: "comparable" | "inconclusive";
  verdict: "within-tolerance" | "outside-tolerance" | "inconclusive";
  requested: number;
  compared: number;
  checkpoints: Scene3dVerifyCheckpoint[];
  coverage: EvidenceCoverage;
  limitations: string[];
}

export interface Scene3dVerifyRequest extends Scene3dVerifyOptions {
  buildUrl: string;
  /** Output root; the handler passes <cache>/scene-captures. */
  sceneDir?: string;
  /** Test-only seams; none of these are exposed by a tool schema. */
  loader?: () => Promise<any>;
  resolveHost?: (hostname: string) => Promise<string[]>;
  /** Exact http(s) origins that may resolve to loopback/private addresses. */
  allowPrivateOrigins?: string[];
  /** Reuse a caller-owned guard; verify_build owns and closes it. */
  networkGuard?: SceneNetworkGuard;
  /** TEST ONLY: whole-run deadline override; never exposed by a tool schema. */
  timeoutMs?: number;
}

export type VerifySceneFn = (
  args: Scene3dVerifyRequest,
) => Promise<Scene3dVerifyResult | { error: string }>;

// ---- pure metrics --------------------------------------------------------

export interface SceneDiffMetrics {
  changedPixelFraction: number;
  meanAbsoluteChannelError: number;
}

/**
 * The metric definition. Called in Node by tests and serialized into the page
 * by imageDiffSource() so the browser and the tests share one formula. Keep it
 * self-contained: no imports, closures or module constants.
 */
export function diffRgbaMetrics(
  reference: ArrayLike<number>,
  build: ArrayLike<number>,
  pixelThreshold: number,
): SceneDiffMetrics {
  const cut = Math.max(0, Math.min(1, Number(pixelThreshold) || 0)) * 255;
  const pixels = Math.min(reference.length, build.length) >> 2;
  let changed = 0;
  let absSum = 0;
  for (let p = 0; p < pixels; p++) {
    const i = p << 2;
    const dr = Math.abs(reference[i]! - build[i]!);
    const dg = Math.abs(reference[i + 1]! - build[i + 1]!);
    const db = Math.abs(reference[i + 2]! - build[i + 2]!);
    absSum += dr + dg + db;
    if (dr > cut || dg > cut || db > cut) changed++;
  }
  return {
    changedPixelFraction: pixels > 0 ? changed / pixels : 0,
    meanAbsoluteChannelError: pixels > 0 ? absSum / (pixels * 3) / 255 : 0,
  };
}

// Decodes both PNGs with the browser's own canvas (no image dependency),
// checks dimensions and blankness, then paints a diff PNG: red = changed,
// dimmed grey = unchanged. Runs on a blank comparator page, never the build
// page, so page scripts cannot shadow the decoding APIs.
function imageDiffSource(): string {
  return `async (arg) => {
    const decode = async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error("PNG data URL could not be read");
      const bitmap = await createImageBitmap(await response.blob());
      const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = surface.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("2D canvas unavailable for image decoding");
      ctx.drawImage(bitmap, 0, 0);
      return {
        width: bitmap.width,
        height: bitmap.height,
        data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data,
      };
    };
    const colorCount = (data) => {
      const seen = new Set();
      for (let i = 0; i < data.length; i += 4) {
        seen.add(data[i] * 65536 + data[i + 1] * 256 + data[i + 2]);
        if (seen.size > 64) break;
      }
      return seen.size;
    };
    const ref = await decode(arg.reference);
    const build = await decode(arg.build);
    if (ref.width !== build.width || ref.height !== build.height) {
      return {
        mismatch: {
          reference: { width: ref.width, height: ref.height },
          build: { width: build.width, height: build.height },
        },
      };
    }
    const metrics = (${diffRgbaMetrics.toString()})(ref.data, build.data, arg.pixelThreshold);
    const cut = arg.pixelThreshold * 255;
    const out = new OffscreenCanvas(ref.width, ref.height);
    const octx = out.getContext("2d");
    if (!octx) throw new Error("2D canvas unavailable for diff rendering");
    const image = octx.createImageData(ref.width, ref.height);
    for (let i = 0; i < ref.data.length; i += 4) {
      const changed =
        Math.abs(ref.data[i] - build.data[i]) > cut ||
        Math.abs(ref.data[i + 1] - build.data[i + 1]) > cut ||
        Math.abs(ref.data[i + 2] - build.data[i + 2]) > cut;
      if (changed) {
        image.data[i] = 255;
        image.data[i + 1] = 0;
        image.data[i + 2] = 0;
      } else {
        const grey = Math.round((build.data[i] + build.data[i + 1] + build.data[i + 2]) / 6);
        image.data[i] = grey;
        image.data[i + 1] = grey;
        image.data[i + 2] = grey;
      }
      image.data[i + 3] = 255;
    }
    octx.putImageData(image, 0, 0);
    const png = await out.convertToBlob({ type: "image/png" });
    const buffer = new Uint8Array(await png.arrayBuffer());
    let binary = "";
    for (let i = 0; i < buffer.length; i += 32768) {
      binary += String.fromCharCode.apply(null, Array.from(buffer.subarray(i, i + 32768)));
    }
    return {
      width: ref.width,
      height: ref.height,
      changedPixelFraction: metrics.changedPixelFraction,
      meanAbsoluteChannelError: metrics.meanAbsoluteChannelError,
      referenceColors: colorCount(ref.data),
      buildColors: colorCount(build.data),
      diff: btoa(binary),
    };
  }`;
}

// ---- in-page snippets ----------------------------------------------------

const SCENE_CONTEXT_LOSS_INIT = function (): void {
  const g = globalThis as any;
  try {
    g.addEventListener(
      "webglcontextlost",
      () => {
        g.__awwwardsSceneContextLoss = (Number(g.__awwwardsSceneContextLoss) || 0) + 1;
      },
      true,
    );
  } catch {
    /* page refused the listener */
  }
};

const SCENE_CONTEXT_LOSSES = function (): number {
  const g = globalThis as any;
  try {
    return Number(g.__awwwardsSceneContextLoss) || 0;
  } catch {
    return 0;
  }
};

// ---- evidence reading ----------------------------------------------------

const defaultSceneDir = (): string =>
  join(process.env.AWWWARDS_CACHE_DIR ?? join(homedir(), ".awwwards-mcp"), "scene-captures");

async function readReferencePack(
  dir: string,
  captureId: string,
): Promise<{ evidence: SceneEvidence } | { error: string }> {
  const path = join(dir, "evidence.json");
  let entry;
  try {
    entry = await lstat(path);
  } catch {
    return { error: `reference capture ${captureId} has no readable evidence.json` };
  }
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > SCENE_LIMITS.maxMetadataBytes) {
    return { error: `reference capture ${captureId} evidence.json is not a readable scene pack` };
  }
  let parsed: SceneEvidence;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as SceneEvidence;
  } catch {
    return { error: `reference capture ${captureId} evidence.json is not valid JSON` };
  }
  if (parsed?.id !== "scene-evidence-v1" || parsed.captureId !== captureId) {
    return { error: `reference capture ${captureId} is not a scene-evidence-v1 pack for that id` };
  }
  const viewport = parsed.viewport;
  if (
    !viewport ||
    (viewport.name !== "desktop" && viewport.name !== "mobile") ||
    !(Number(viewport.width) > 0) ||
    !(Number(viewport.height) > 0)
  ) {
    return { error: `reference capture ${captureId} has no usable viewport` };
  }
  if (!Array.isArray(parsed.checkpoints)) {
    return { error: `reference capture ${captureId} has no checkpoint list` };
  }
  const finite = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);
  const unit = (value: unknown): boolean =>
    finite(value) && value >= 0 && value <= 1;
  for (const checkpoint of parsed.checkpoints) {
    const bad = (detail: string) => ({
      error: `reference capture ${captureId} has a checkpoint with ${detail}`,
    });
    if (!unit(checkpoint?.requestedScrollRatio)) return bad("a malformed scroll ratio");
    // Replay targets the measured position, so both the requested target and
    // the position the reference capture actually reached must be present.
    if (!finite(checkpoint?.requestedScrollTop) || checkpoint.requestedScrollTop < 0) {
      return bad("no finite requestedScrollTop");
    }
    if (!finite(checkpoint?.actualScrollTop) || checkpoint.actualScrollTop < 0) {
      return bad("no finite actualScrollTop");
    }
    if (
      !finite(checkpoint?.waitMs) ||
      checkpoint.waitMs < 0 ||
      checkpoint.waitMs > SCENE_LIMITS.maxWaitMs
    ) {
      return bad(`a waitMs outside 0..${SCENE_LIMITS.maxWaitMs}`);
    }
    if (checkpoint?.scrollRootFound !== true) {
      return bad("no proof its scroll root was found");
    }
    if (checkpoint.pointer !== null && checkpoint.pointer !== undefined) {
      if (
        typeof checkpoint.pointer !== "object" ||
        !unit(checkpoint.pointer.x) ||
        !unit(checkpoint.pointer.y)
      ) {
        return bad("a pointer outside 0..1");
      }
    }
    const rect = checkpoint?.canvas?.rect;
    if (
      !rect ||
      !finite(rect.x) ||
      !finite(rect.y) ||
      !finite(rect.width) ||
      !finite(rect.height) ||
      !(rect.width > 0) ||
      !(rect.height > 0)
    ) {
      return bad("no usable canvas rect");
    }
    if (
      !(finite(checkpoint.canvas.backing?.width) && checkpoint.canvas.backing.width > 0) ||
      !(finite(checkpoint.canvas.backing?.height) && checkpoint.canvas.backing.height > 0)
    ) {
      return bad("no usable canvas backing size");
    }
    if (!finite(checkpoint.canvas.dpr) || !(checkpoint.canvas.dpr > 0)) {
      return bad("no usable device pixel ratio");
    }
    if (typeof checkpoint.files?.canvas !== "string" || !checkpoint.files.canvas) {
      return bad("no frame path");
    }
  }
  return { evidence: parsed };
}

/** Regular non-symlink file inside the capture directory, or null. */
async function readFrame(imagePath: unknown, captureDir: string): Promise<Buffer | null> {
  if (typeof imagePath !== "string" || !imagePath) return null;
  let entry;
  try {
    entry = await lstat(imagePath);
  } catch {
    return null;
  }
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > SCENE_LIMITS.maxImageBytes) {
    return null;
  }
  let resolved: string;
  try {
    resolved = await realpath(imagePath);
  } catch {
    return null;
  }
  const rel = relative(captureDir, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  try {
    return await readFile(resolved);
  } catch {
    return null;
  }
}

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message.replace(/\s+/g, " ").trim() : String(err);

/** lstat that treats only ENOENT as absent; any other error is a real failure. */
async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Creates <capture>/verify/<run> and returns its realpath, refusing symlinked or
 * non-directory components. The caller must not write artifacts on an error.
 */
async function prepareArtifactRoot(
  captureDir: string,
  captureReal: string,
): Promise<{ root: string } | { error: string }> {
  const verifyDir = join(captureDir, "verify");
  try {
    let existing = await lstatOrNull(verifyDir);
    if (!existing) {
      try {
        await mkdir(verifyDir, { recursive: false, mode: 0o700 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      existing = await lstatOrNull(verifyDir);
    }
    if (!existing) return { error: "the verify artifact path could not be created" };
    if (existing.isSymbolicLink()) {
      return { error: "the verify artifact path is a symlink or junction" };
    }
    if (!existing.isDirectory()) {
      return { error: "the verify artifact path is not a directory" };
    }
    const runDir = join(verifyDir, `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`);
    // Non-recursive and unique: an existing path (including a planted symlink)
    // fails instead of being reused.
    await mkdir(runDir, { mode: 0o700 });
    const created = await lstat(runDir);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      return { error: "the run artifact path is not a real directory" };
    }
    const resolved = await realpath(runDir);
    const rel = relative(captureReal, resolved);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      return { error: "the run artifact path escapes the reference capture directory" };
    }
    return { root: resolved };
  } catch (err) {
    return { error: `the artifact directory could not be created (${messageOf(err)})` };
  }
}

const closeWithinGrace = async (target: { close(): unknown } | undefined): Promise<void> => {
  if (!target) return;
  await Promise.race([
    Promise.resolve()
      .then(() => target.close())
      .catch(() => undefined),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SCENE_VERIFY_LIMITS.closeGraceMs);
      timer.unref?.();
    }),
  ]);
};

const settle = async (page: any, ms: number): Promise<void> => {
  if (ms <= 0) return;
  if (typeof page?.waitForTimeout === "function") {
    await page.waitForTimeout(ms);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const isHttpUrl = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

// ---- verdict -------------------------------------------------------------

export function scene3dInconclusive(reason: string): Scene3dVerifyResult {
  return {
    status: "inconclusive",
    verdict: "inconclusive",
    requested: 0,
    compared: 0,
    checkpoints: [],
    coverage: coverageFrom({ collected: 0, excluded: 0, error: reason }),
    limitations: [reason],
  };
}

function cameraAngleOf(checkpoint: SceneCheckpointResult, evidence: SceneEvidence): number | null {
  // scene-evidence-v1 marks camera state unavailable; a pack that actually
  // carries a comparable angle may override that here.
  if (evidence.coverage?.capabilities?.camera?.status === "unavailable") return null;
  const row = checkpoint as unknown as Record<string, unknown>;
  for (const key of ["cameraAngleDeg", "cameraAngle"]) {
    const value = Number(row[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function finalize(
  requested: number,
  checkpoints: Scene3dVerifyCheckpoint[],
  tolerances: Scene3dTolerances | undefined,
  extraLimitations: string[],
  artifactLimitations: string[] = [],
): Scene3dVerifyResult {
  const compared = checkpoints.filter((cp) => cp.status === "comparable").length;
  const status: Scene3dVerifyResult["status"] =
    requested > 0 && compared === requested ? "comparable" : "inconclusive";
  const hasTolerances =
    typeof tolerances?.pixelThreshold === "number" &&
    typeof tolerances?.maxChangedFraction === "number";
  let verdict: Scene3dVerifyResult["verdict"] = "inconclusive";
  if (hasTolerances && status === "comparable" && artifactLimitations.length === 0) {
    const outside = checkpoints.some(
      (cp) =>
        (cp.changedPixelFraction ?? 1) > tolerances!.maxChangedFraction! ||
        (cp.cameraAngleDeg !== null &&
          tolerances!.cameraAngleDeg !== undefined &&
          Math.abs(cp.cameraAngleDeg) > tolerances!.cameraAngleDeg),
    );
    verdict = outside ? "outside-tolerance" : "within-tolerance";
  }
  const limitations = [
    "Pixel comparison only: frames are the rendered output of two pages; no scene graph, camera state, shader source or geometry is read.",
    "changedPixelFraction counts pixels whose R, G or B delta exceeds pixelThreshold; meanAbsoluteChannelError is the mean absolute R/G/B delta normalized to 0..1.",
    "Diff PNGs land under the reference capture's verify/<run>/; red pixels changed, dimmed grey pixels did not.",
    ...extraLimitations,
    ...artifactLimitations,
  ];
  if (!hasTolerances) {
    limitations.push(
      "No verdict inputs: supply tolerances.pixelThreshold and tolerances.maxChangedFraction to get within-tolerance or outside-tolerance; metrics are still reported.",
    );
  }
  if (status !== "comparable") {
    limitations.push(
      `${requested - compared} of ${requested} checkpoint(s) were not comparable, so no pass is possible.`,
    );
  }
  return {
    status,
    verdict,
    requested,
    compared,
    checkpoints,
    coverage: coverageFrom({
      collected: compared,
      excluded: requested - compared,
      total: requested,
      ...(requested === 0 ? { error: "the reference pack has no checkpoints" } : {}),
      limitations,
    }),
    limitations,
  };
}

// ---- orchestration -------------------------------------------------------

export async function verifyScene3d(
  opts: Scene3dVerifyRequest,
): Promise<Scene3dVerifyResult | { error: string }> {
  if (!isHttpUrl(opts.buildUrl ?? "")) {
    return { error: "scene3d verification accepts http:// and https:// build URLs only." };
  }
  const startedAt = Date.now();
  // The pack has not been read yet, so the watchdog starts on the short-run
  // floor and is raised to the replay budget once the schedule is known.
  let budget = sceneVerifyBudget(undefined, opts.timeoutMs);
  const deadlineReason = (): string =>
    `scene3d verification exceeded its ${budget.timeoutMs}ms deadline (budget: ${budget.basis}); the run was abandoned and its browser resources were closed.`;
  const closers: Array<{ close(): unknown }> = [];
  let disposed = false;
  const own = <T extends { close(): unknown }>(target: T): T => {
    // A resource that resolves after the deadline is closed on arrival instead
    // of being leaked by the already-returned run.
    if (disposed) {
      void closeWithinGrace(target);
      return target;
    }
    closers.push(target);
    return target;
  };
  const closeAll = async (): Promise<void> => {
    const targets = closers.splice(0).reverse();
    if (targets.length === 0) return;
    // Every resource is closed concurrently under one shared grace window, so
    // a hung close cannot add its own 3s to the run.
    await Promise.race([
      Promise.allSettled(
        targets.map((target) =>
          Promise.resolve()
            .then(() => target.close())
            .catch(() => undefined),
        ),
      ),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SCENE_VERIFY_LIMITS.closeGraceMs);
        timer.unref?.();
      }),
    ]);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveDeadline!: (result: Scene3dVerifyResult) => void;
  const deadlineHit = new Promise<Scene3dVerifyResult>((resolve) => {
    resolveDeadline = resolve;
  });
  const armDeadline = (): void => {
    if (timer) clearTimeout(timer);
    // Measured from the run start: raising the budget never adds a fresh full
    // window on top of the time already spent.
    const remaining = Math.max(1, startedAt + budget.timeoutMs - Date.now());
    timer = setTimeout(() => {
      disposed = true;
      resolveDeadline(scene3dInconclusive(deadlineReason()));
    }, remaining);
    timer.unref?.();
  };
  armDeadline();

  // The deadline covers every asynchronous step, including pack reads, DNS,
  // artifact setup, frame reads, the Playwright import and the comparison.
  const work = (async (): Promise<Scene3dVerifyResult | { error: string }> => {
    try {
      const sceneDir = opts.sceneDir ?? defaultSceneDir();
      const capture = await resolveSceneCaptureDir(sceneDir, opts.referenceCaptureId);
      if ("error" in capture) return scene3dInconclusive(capture.error);
      const pack = await readReferencePack(capture.dir, opts.referenceCaptureId);
      if ("error" in pack) return scene3dInconclusive(pack.error);
      const evidence = pack.evidence;
      const requested = evidence.checkpoints.length;
      if (requested === 0) {
        return scene3dInconclusive("the reference pack contains no checkpoints to compare");
      }
      if (requested > SCENE_LIMITS.maxCheckpoints) {
        return scene3dInconclusive(
          `the reference pack has ${requested} checkpoints, above the ${SCENE_LIMITS.maxCheckpoints} supported`,
        );
      }
      const replayBudget = sceneVerifyBudget(evidence.checkpoints, opts.timeoutMs);
      if (replayBudget.timeoutMs > budget.timeoutMs) {
        budget = replayBudget;
        armDeadline();
      }

      const { width, height, ...contextOpts } = resolveViewport(evidence.viewport.name);
      if (width !== evidence.viewport.width || height !== evidence.viewport.height) {
        return scene3dInconclusive(
          `reference viewport ${evidence.viewport.width}x${evidence.viewport.height} does not match the ${evidence.viewport.name} profile`,
        );
      }
      const allowedOrigins = normalizeScenePrivateOrigins(opts.allowPrivateOrigins);
      if ("error" in allowedOrigins) return { error: allowedOrigins.error };
      const gate =
        opts.networkGuard?.gate ??
        createSceneUrlGate(opts.resolveHost ?? defaultSceneResolveHost, allowedOrigins.origins);
      let allowedBuild = false;
      try {
        allowedBuild = await gate.allows(opts.buildUrl);
      } catch {
        allowedBuild = false;
      }
      if (!allowedBuild) {
        return scene3dInconclusive(
          "refusing to load the build page: its host resolves to a loopback, link-local, private, metadata or reserved address, or the URL is not http(s).",
        );
      }

      let captureReal: string;
      try {
        captureReal = await realpath(capture.dir);
      } catch {
        return scene3dInconclusive(
          `reference capture ${opts.referenceCaptureId} directory could not be resolved`,
        );
      }
      const artifacts = await prepareArtifactRoot(capture.dir, captureReal);
      if ("error" in artifacts) {
        return scene3dInconclusive(
          `scene3d verification artifacts could not be prepared: ${artifacts.error}`,
        );
      }
      const artifactsRoot = artifacts.root;

      const frames = await Promise.all(
        evidence.checkpoints.map((checkpoint) =>
          readFrame(checkpoint.files?.canvas, captureReal),
        ),
      );

      let chromium: any;
      try {
        const loader = opts.loader ?? (() => import("playwright" as string));
        ({ chromium } = await loader());
      } catch {
        return { error: CAPTURE_INSTALL_HINT };
      }

      const proxy = opts.networkGuard?.proxy ?? own(await startSceneProxy(gate));
      const browser = own(
        await chromium.launch({ proxy: { server: proxy.url, bypass: "<-loopback>" } }),
      );
      const context = own(
        await browser.newContext({
          viewport: { width, height },
          ...contextOpts,
          serviceWorkers: "block",
        }),
      );
      if (typeof context.route === "function") {
        await context.route("**/*", async (route: any) => {
          let allowed = false;
          try {
            const target = typeof route?.request === "function" ? String(route.request().url()) : "";
            allowed = await gate.allows(target);
          } catch {
            allowed = false;
          }
          try {
            if (allowed) await route.continue();
            else await route.abort("blockedbyclient");
          } catch {
            /* request already gone */
          }
        });
      }
      // Popups are closed and still pass through the connection-level gate.
      let primaryPage: any = null;
      if (typeof context.on === "function") {
        context.on("page", (opened: any) => {
          if (primaryPage === null) {
            primaryPage = opened;
            return;
          }
          try {
            void Promise.resolve(opened.close?.()).catch(() => undefined);
          } catch {
            /* page already closed */
          }
        });
      }
      const page = own(await context.newPage());
      primaryPage = page;
      if (typeof page.setDefaultTimeout === "function") {
        page.setDefaultTimeout(15_000);
      }
      if (typeof page.addInitScript === "function") {
        await page.addInitScript(SCENE_CONTEXT_LOSS_INIT);
      }

      try {
        await page.goto(opts.buildUrl, { waitUntil: "load", timeout: 45_000 });
      } catch (err) {
        return { error: `scene3d verification could not load the build page: ${redactSceneError(messageOf(err))}` };
      }
      await settle(page, SCENE_VERIFY_LIMITS.scrollSettleMs);

      const picked = (await page.evaluate(SCENE_CANVAS_PICK, {
        selector: opts.buildSelector ?? "",
        // Generated outside the page: page content cannot pre-set or guess it.
        marker: randomUUID(),
      })) as { selector?: string; problem?: string };
      const pickProblem = String(picked?.problem ?? "");
      if (pickProblem || !picked?.selector) {
        const detail =
          pickProblem === "invalid-selector"
            ? "is not a valid CSS selector."
            : pickProblem === "selector-not-canvas"
              ? "matched an element that is not a <canvas>."
              : pickProblem === "selector-not-found"
                ? "matched no element."
                : pickProblem === "marker-not-unique"
                  ? "could not be tagged uniquely for verification; refusing to guess which canvas was selected."
                  : "matched no visible canvas.";
        return scene3dInconclusive(
          `buildSelector ${JSON.stringify(opts.buildSelector ?? "")} ${detail}`,
        );
      }
      const buildCanvasSelector = String(picked.selector);

      let artifactFailure = "";
      const writeArtifact = async (name: string, bytes: Buffer): Promise<string | null> => {
        if (disposed) return null;
        try {
          const path = join(artifactsRoot, name);
          await writeFile(path, bytes, { mode: 0o600 });
          return path;
        } catch (err) {
          if (!artifactFailure) {
            artifactFailure = `an artifact image could not be written (${redactSceneError(messageOf(err))})`;
          }
          return null;
        }
      };
      // Playwright serializes a real function; a bare string would be evaluated
      // as an expression and drop the argument. It runs on the blank comparator
      // page, so build-page overrides of the decoding APIs cannot affect metrics.
      const compareFrames = new Function(`return (${imageDiffSource()});`)() as (
        arg: unknown,
      ) => unknown;
      let comparator: any = null;
      const comparatorPage = async (): Promise<any> => {
        if (comparator) return comparator;
        const comparatorContext = own(
          await browser.newContext({ serviceWorkers: "block" }),
        );
        const blankPage = own(await comparatorContext.newPage());
        if (typeof blankPage.setDefaultTimeout === "function") {
          blankPage.setDefaultTimeout(15_000);
        }
        await blankPage.goto("about:blank", { waitUntil: "load", timeout: 10_000 });
        comparator = blankPage;
        return blankPage;
      };

      const results: Scene3dVerifyCheckpoint[] = [];
      for (let index = 0; index < evidence.checkpoints.length; index++) {
        if (disposed) break;
        const checkpoint = evidence.checkpoints[index]!;
        const frame = frames[index];
        const reasons: string[] = [];
        const scrollRoot =
          checkpoint.scrollRoot && checkpoint.scrollRoot !== "window" ? checkpoint.scrollRoot : "";
        const stem = `frame-${String(index + 1).padStart(2, "0")}`;
        let referenceImage: string | null = null;
        let buildImage: string | null = null;
        let diffImage: string | null = null;
        let changedPixelFraction: number | null = null;
        let meanAbsoluteChannelError: number | null = null;

        if (!frame) {
          reasons.push("the reference frame for this checkpoint is missing or unreadable");
        } else {
          referenceImage = checkpoint.files.canvas;
        }
        if (checkpoint.requestedScrollTop > 0 && checkpoint.actualScrollTop < 1) {
          reasons.push("the reference capture never reached this scroll position");
        }
        const referenceDpr = Number(checkpoint.canvas.dpr);
        if (!(referenceDpr > 0)) {
          reasons.push("the reference frame has no comparable device pixel ratio");
        }
        if (checkpoint.stable === false) {
          reasons.push(
            `the reference frame was captured while the page was moving (${checkpoint.stabilityReason ?? "no reason recorded"})`,
          );
        }

        const referenceActual = checkpoint.actualScrollTop;
        let preShot: {
          actual: number;
          rect: SceneRect;
          backing: { width: number; height: number };
          dpr: number;
        } | null = null;
        let clip: SceneRect | null = null;
        if (reasons.length === 0) {
          try {
            const before = (await page.evaluate(SCENE_PROBE, {
              canvasSelector: buildCanvasSelector,
              scrollRoot,
            })) as {
              scroll?: { top?: number; range?: number } | null;
              scrollRootFound?: boolean;
              canvasFound?: boolean;
            };
            if (before?.scrollRootFound !== true) {
              reasons.push(
                `the build page has no scroll root ${JSON.stringify(checkpoint.scrollRoot)} at this checkpoint`,
              );
            }
            const range = Math.max(0, Number(before?.scroll?.range) || 0);
            if (
              reasons.length === 0 &&
              checkpoint.requestedScrollRatio > 0 &&
              checkpoint.scrollRange > 0 &&
              range === 0
            ) {
              reasons.push("the build page has no scroll range at this checkpoint");
            }
            if (reasons.length === 0) {
              const contextLosses = Number(await page.evaluate(SCENE_CONTEXT_LOSSES));
              if (contextLosses > 0) {
                reasons.push("the build page lost its WebGL context");
              }
            }
            if (reasons.length === 0) {
              // Replay the reference's measured position, never its requested
              // target: the pair is only comparable at the same actual scroll.
              await page.evaluate(SCENE_SCROLL, { scrollRoot, top: referenceActual });
              if (checkpoint.pointer) {
                const px = {
                  x: Math.round(checkpoint.pointer.x * Math.max(0, width - 1)),
                  y: Math.round(checkpoint.pointer.y * Math.max(0, height - 1)),
                };
                if (page.mouse && typeof page.mouse.move === "function") {
                  await page.mouse.move(px.x, px.y);
                }
              }
              await settle(page, Math.max(0, Math.min(SCENE_LIMITS.maxWaitMs, checkpoint.waitMs)));

              // The final measurement happens immediately before the screenshot;
              // scroll-snap or page motion after this point cannot be hidden.
              const after = (await page.evaluate(SCENE_PROBE, {
                canvasSelector: buildCanvasSelector,
                scrollRoot,
              })) as {
                canvasFound?: boolean;
                rect?: SceneRect | null;
                backing?: { width: number; height: number } | null;
                dpr?: number;
                scroll?: { top?: number; range?: number } | null;
                scrollRootFound?: boolean;
              };
              const buildActual = Number(after?.scroll?.top);
              const buildDpr = Number(after?.dpr);
              if (after?.scrollRootFound !== true) {
                reasons.push(
                  `the build page lost the scroll root ${JSON.stringify(checkpoint.scrollRoot)} at this checkpoint`,
                );
              } else if (!after?.canvasFound || !after.rect) {
                reasons.push("the build canvas disappeared at this checkpoint");
              } else if (!Number.isFinite(buildActual)) {
                reasons.push("the build scroll position could not be measured at this checkpoint");
              } else if (
                Math.abs(buildActual - referenceActual) > SCENE_VERIFY_LIMITS.scrollMatchPx
              ) {
                reasons.push(
                  `the build scroll position differs after settle (reference ${referenceActual}px, build ${buildActual}px); ` +
                    "scroll-snap or page motion made the frames incomparable",
                );
              } else if (Math.abs(buildDpr - referenceDpr) > 0.01) {
                reasons.push(
                  `device pixel ratio differs (reference ${referenceDpr}, build ${buildDpr || "unknown"})`,
                );
              } else if (
                Number(after.backing?.width) !== Number(checkpoint.canvas.backing.width) ||
                Number(after.backing?.height) !== Number(checkpoint.canvas.backing.height)
              ) {
                reasons.push(
                  `canvas backing size differs (reference ${checkpoint.canvas.backing.width}x${checkpoint.canvas.backing.height}, ` +
                    `build ${after.backing?.width ?? 0}x${after.backing?.height ?? 0})`,
                );
              } else {
                preShot = {
                  actual: buildActual,
                  rect: after.rect,
                  backing: {
                    width: Number(after.backing?.width),
                    height: Number(after.backing?.height),
                  },
                  dpr: buildDpr,
                };
                clip = sceneCanvasClip(after.rect, { width, height });
                if (!clip) reasons.push("the build canvas is outside the viewport at this checkpoint");
              }
            }
          } catch (err) {
            reasons.push(`build inspection failed: ${redactSceneError(messageOf(err))}`);
          }
        }

        if (reasons.length === 0 && clip && frame) {
          try {
            const shot = await page.screenshot({ clip });
            buildImage = await writeArtifact(`${stem}-build.png`, shot);
            // The screenshot is not atomic either: re-probe scroll, geometry,
            // DPR and WebGL context after it, including on the final checkpoint.
            const post = (await page.evaluate(SCENE_PROBE, {
              canvasSelector: buildCanvasSelector,
              scrollRoot,
            })) as {
              canvasFound?: boolean;
              rect?: SceneRect | null;
              backing?: { width: number; height: number } | null;
              dpr?: number;
              scroll?: { top?: number } | null;
              scrollRootFound?: boolean;
            };
            const postLosses = Number(await page.evaluate(SCENE_CONTEXT_LOSSES));
            if (!preShot) {
              reasons.push("the pre-screenshot scroll position was not recorded");
            } else if (postLosses > 0) {
              reasons.push("the build page lost its WebGL context during the screenshot");
            } else if (!post?.canvasFound || !post.rect) {
              reasons.push("the build canvas disappeared during the screenshot");
            } else {
              const postActual = Number(post?.scroll?.top);
              if (!Number.isFinite(postActual)) {
                reasons.push("the build scroll position could not be measured after the screenshot");
              } else if (Math.abs(postActual - preShot.actual) > SCENE_VERIFY_LIMITS.scrollMatchPx) {
                reasons.push(
                  `the build scroll position moved during the screenshot (before ${preShot.actual}px, after ${postActual}px)`,
                );
              } else if (Math.abs(postActual - referenceActual) > SCENE_VERIFY_LIMITS.scrollMatchPx) {
                reasons.push(
                  `the build scroll position drifted away from the reference during the screenshot (reference ${referenceActual}px, after ${postActual}px)`,
                );
              } else if (
                post.rect.x !== preShot.rect.x ||
                post.rect.y !== preShot.rect.y ||
                post.rect.width !== preShot.rect.width ||
                post.rect.height !== preShot.rect.height ||
                Number(post.dpr) !== preShot.dpr ||
                Number(post.backing?.width) !== preShot.backing.width ||
                Number(post.backing?.height) !== preShot.backing.height
              ) {
                reasons.push(
                  "the build canvas geometry or device pixel ratio changed during the screenshot",
                );
              }
            }
            if (reasons.length === 0) {
              const comparedFrame = (await (await comparatorPage()).evaluate(compareFrames, {
                reference: `data:image/png;base64,${frame.toString("base64")}`,
                build: `data:image/png;base64,${Buffer.from(shot).toString("base64")}`,
                pixelThreshold: Number(opts.tolerances?.pixelThreshold) || 0,
              })) as
              | {
                  mismatch: {
                    reference: { width: number; height: number };
                    build: { width: number; height: number };
                  };
                }
              | {
                  width: number;
                  height: number;
                  changedPixelFraction: number;
                  meanAbsoluteChannelError: number;
                  referenceColors: number;
                  buildColors: number;
                  diff: string;
                };

              if ("mismatch" in comparedFrame) {
                reasons.push(
                  `canvas dimensions differ (reference ${comparedFrame.mismatch.reference.width}x${comparedFrame.mismatch.reference.height}, ` +
                    `build ${comparedFrame.mismatch.build.width}x${comparedFrame.mismatch.build.height})`,
                );
              } else if (comparedFrame.referenceColors <= SCENE_VERIFY_LIMITS.blankUniqueColors) {
                reasons.push(
                  `the reference frame is blank (${comparedFrame.referenceColors} sampled colours)`,
                );
              } else if (comparedFrame.buildColors <= SCENE_VERIFY_LIMITS.blankUniqueColors) {
                reasons.push(
                  `the build frame is blank (${comparedFrame.buildColors} sampled colours)`,
                );
              } else {
                changedPixelFraction = comparedFrame.changedPixelFraction;
                meanAbsoluteChannelError = comparedFrame.meanAbsoluteChannelError;
                diffImage = await writeArtifact(
                  `${stem}-diff.png`,
                  Buffer.from(comparedFrame.diff, "base64"),
                );
              }
            }
          } catch (err) {
            reasons.push(`frame comparison failed: ${redactSceneError(messageOf(err))}`);
          }
        }

        const cameraAngleDeg = cameraAngleOf(checkpoint, evidence);
        if (cameraAngleDeg === null) {
          reasons.push(
            "no comparable camera angle in the reference evidence (passive capture never reads camera state)",
          );
        }
        // The camera note alone does not make a measured pair incomparable.
        const blocking = reasons.filter((reason) => !reason.startsWith("no comparable camera angle"));
        results.push({
          index,
          status: blocking.length === 0 && changedPixelFraction !== null ? "comparable" : "inconclusive",
          referenceImage,
          buildImage,
          diffImage,
          changedPixelFraction,
          meanAbsoluteChannelError,
          cameraAngleDeg,
          reasons,
        });
      }

      if (disposed) return scene3dInconclusive(deadlineReason());
      const cameraNote = evidence.checkpoints.every(
        (checkpoint) => cameraAngleOf(checkpoint, evidence) === null,
      )
        ? [
            "cameraAngleDeg stays null: the reference evidence carries no comparable camera state, so camera tolerance cannot be checked.",
          ]
        : [];
      return finalize(
        requested,
        results,
        opts.tolerances,
        cameraNote,
        artifactFailure ? [artifactFailure] : [],
      );
    } catch (err) {
      return { error: `scene3d verification failed: ${redactSceneError(messageOf(err))}` };
    }
  })();

  try {
    return await Promise.race([work, deadlineHit]);
  } finally {
    if (timer) clearTimeout(timer);
    disposed = true;
    await closeAll();
  }
}
