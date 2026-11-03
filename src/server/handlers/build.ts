import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildGsapStub } from "../../gsap-stub.js";
import { censusInputError, poseCensusError, scaffoldMotionManifest, unwrapScrollCensus } from "../../motion-manifest.js";
import { poseGridInputError, type PoseGrid } from "../../pose3d.js";
import { buildPoseStubHtml, poseSuggestions } from "../../pose-stub.js";
import type { SceneStubOptions } from "../../scene-stub.js";
import type { ScrollCensus } from "../../census.js";
import type { HandlerContext } from "../context.js";
import { errorResponse, text } from "../types.js";
import type { ToolResponse } from "../types.js";

export async function build_pose_stub(ctx: HandlerContext, args: {
  poseGrid: PoseGrid;
  scrollCensus?: ScrollCensus;
}): Promise<ToolResponse> {
  try {
    // Snapshot schemas may drift; only grids stamped pose-grid-v1 build.
    if (args.poseGrid?.id !== "pose-grid-v1") {
      return {
        content: [
          text("poseGrid.id must be \"pose-grid-v1\" - re-capture with the pose-capture tool."),
        ],
        isError: true,
      };
    }
    // An empty grid renders a stub with no frames at all: no scroll-driven
    // canvas evidence, so point at the census path instead.
    const snapshots = args.poseGrid.snapshots;
    if (
      !Array.isArray(snapshots) ||
      snapshots.length === 0 ||
      !snapshots.every(
        (s) =>
          s &&
          Array.isArray(s.frames) &&
          s.frames.length > 0 &&
          s.frames.every(
            (f) => f && typeof f.dataUrlPng === "string" && f.dataUrlPng.length > 0,
          ),
      )
    ) {
      return {
        content: [
          text(
            "poseGrid has no captured frames (the page had no canvas); build a GSAP stub from the scroll census instead.",
          ),
        ],
        isError: true,
      };
    }
    // Frames ship inline: require bounded PNG payloads and finite numbers.
    const gridError = poseGridInputError(args.poseGrid);
    if (gridError) return { content: [text(gridError)], isError: true };
    // The optional census feeds poseSuggestions, which indexes counts[] and
    // anims[] directly. Validate and unwrap before the notes path.
    let poseCensus: ScrollCensus | undefined;
    if (args.scrollCensus !== undefined) {
      const censusError = poseCensusError(args.scrollCensus);
      if (censusError) return { content: [text(censusError)], isError: true };
      poseCensus = unwrapScrollCensus(args.scrollCensus) as ScrollCensus;
    }
    const build =
      ctx.deps.poseStubFn ??
      ((grid: PoseGrid, census?: ScrollCensus) => ({
        stubHtml: buildPoseStubHtml(grid, { scrollCensus: census }),
        notes: [
          `steps=${grid.steps}`,
          `canvas=${grid.canvasW}x${grid.canvasH}`,
          ...(census
            ? (() => {
                const s = poseSuggestions(census);
                return [
                  `suggestions(st)=${s.st}`,
                  `suggestions(pin)=${s.pin}`,
                  `suggestions(ease)=${s.ease.length}`,
                ];
              })()
            : []),
        ],
      }));
    return { content: [text(JSON.stringify(build(args.poseGrid, poseCensus), null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function analyze_stack(ctx: HandlerContext, args: {
  url: string;
  timeoutMs?: number;
}): Promise<ToolResponse> {
  try {
    // Lazy default: the fetch orchestrator is only touched when the tool runs.
    const analyze =
      ctx.deps.stackFn ??
      ((url: string, opts?: { timeoutMs?: number }) =>
        import("../../stack.js").then((m) => m.analyzeStack(url, opts)));
    const result = await analyze(args.url, { timeoutMs: args.timeoutMs });
    if ("error" in result) return { content: [text(result.error)], isError: true };
    return { content: [text(JSON.stringify(result, null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function build_gsap_stub(ctx: HandlerContext, args: {
  scrollCensus: unknown;
  poseGrid?: unknown;
}): Promise<ToolResponse> {
  try {
    // Builders need the full census; a compact summary must be re-captured.
    // Accept the verify_build dump shape by unwrapping before the builder.
    const census = unwrapScrollCensus(args.scrollCensus);
    const censusError = censusInputError(census);
    if (censusError) return { content: [text(censusError)], isError: true };
    const build =
      ctx.deps.gsapStubFn ??
      ((a: { scrollCensus: unknown; poseGrid?: unknown }) => ({
        stubHtml: buildGsapStub(a.poseGrid, a.scrollCensus),
      }));
    return { content: [text(JSON.stringify(build({ ...args, scrollCensus: census }), null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

// Offline scene scaffold: reads one scene-evidence-v1 pack (plus lstat of the
// caller's local asset paths) and returns files; nothing is fetched or written.
export async function build_scene_stub(ctx: HandlerContext, args: {
  evidencePath: string;
  assetBindings?: { resourceId: string; localPath: string }[];
  title?: string;
}): Promise<ToolResponse> {
  try {
    const build =
      ctx.deps.sceneStubFn ??
      ((opts: SceneStubOptions) =>
        import("../../scene-stub.js").then((m) => m.buildSceneStub(opts)));
    const result = await build({
      ...args,
      sceneDir: join(ctx.cache.rootDir, "scene-captures"),
    });
    if ("error" in result) return { content: [text(result.error)], isError: true };
    return { content: [text(JSON.stringify(result, null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function build_motion_manifest(ctx: HandlerContext, args: {
  bands: unknown;
  scrollCensus: unknown;
  sections?: { label: string; selector?: string }[];
}): Promise<ToolResponse> {
  try {
    const result = scaffoldMotionManifest(args);
    if ("error" in result) {
      return { content: [text(JSON.stringify(result))], isError: true };
    }
    return { content: [text(JSON.stringify(result, null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

// build_project: converts a LOCAL single-file rebuild into a runnable
// project tree by delegating to the buildProject core (bin shares it).
export async function build_project(ctx: HandlerContext, args: { htmlPath: string; target: "vite" | "astro" | "next"; out: string; name?: string }): Promise<ToolResponse> {
  try {
    if (!existsSync(args.htmlPath)) {
      return { content: [text(`htmlPath does not exist: ${args.htmlPath}`)], isError: true };
    }
    const build =
      ctx.deps.buildProjectFn ??
      ((a: { html: string; target: "vite" | "astro" | "next"; out: string; name?: string }) =>
        import("../../build-project.js").then((m) => m.buildProject(a)));
    const result = await build({
      html: args.htmlPath,
      target: args.target,
      out: args.out,
      ...(args.name ? { name: args.name } : {}),
    });
    if ("error" in result) return { content: [text(result.error)], isError: true };
    return { content: [text(JSON.stringify(result, null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}
