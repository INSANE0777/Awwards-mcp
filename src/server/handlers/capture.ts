import { join } from "node:path";
import { DEFAULT_MAX_INLINE_BYTES } from "../../capture.js";
import type { CaptureOpts } from "../../capture.js";
import { summarizePalette, summarizeTypography } from "../../component.js";
import { summarizeImages } from "../../images.js";
import { summarizeSceneEvidence, type SceneAdapterName, type SceneCaptureOptions } from "../../scene-capture.js";
import type { SceneAssetDownloadOptions, SceneRights } from "../../scene-assets.js";
import { diffBands } from "../../structure.js";
import type { WaitOpts, WaitStrategy } from "../../structure.js";
import { exportDesignTokens } from "../../tokens.js";
import type { TokenCategory } from "../../tokens.js";
import { compactHoverCensus } from "../../verify-build.js";
import type { ViewportName } from "../../viewport.js";
import type { HandlerContext } from "../context.js";
import { compactComponentPack, errorResponse, text } from "../types.js";
import type { ToolResponse } from "../types.js";

export async function capture_live_site(ctx: HandlerContext, args: {
  url: string;
  waitStrategy?: WaitStrategy;
  viewport?: ViewportName;
  inline?: boolean;
  maxInlineBytes?: number;
  waitForOverlay?: boolean;
  scrollCapture?: "auto" | "anchors" | "viewport";
}): Promise<ToolResponse> {
  try {
    // Lazy default: playwright is only touched when the tool actually runs.
    // The default is wrapped because captureLiveSite's third positional is
    // the injectable playwright loader - opts must land in fourth place.
    const capture =
      ctx.deps.captureFn ??
      ((url: string, imagesDir: string, opts?: CaptureOpts) =>
        import("../../capture.js").then((m) => m.captureLiveSite(url, imagesDir, undefined, opts)));
    // The tool schema defaults viewport to "desktop" (zod); the ?? keeps
    // direct handler calls on the same explicit path.
    const result = await capture(args.url, ctx.cache.imagesDir, {
      waitStrategy: args.waitStrategy,
      viewport: args.viewport ?? "desktop",
      inline: args.inline,
      maxInlineBytes: args.maxInlineBytes,
      waitForOverlay: args.waitForOverlay,
      scrollCapture: args.scrollCapture,
    });
    if ("error" in result) return { content: [text(result.error)], isError: true };
    // Anchors are six files, so a single "saved to <file>" line would lie:
    // the payload is text JSON only, with no image block.
    if ("mode" in result && result.mode === "anchors") {
      return { content: [text(JSON.stringify(result, null, 1))] };
    }
    const note = inlineNote(args, result.base64);
    if ("mode" in result) {
      // One viewport shot of an inner scroller: say so, never "full-page".
      return {
        content: [
          text(
            `Viewport capture of ${args.url} (inner scroller ${result.scrollRoot}, not full-page) ` +
              `saved to ${result.file}${note}`,
          ),
          ...(result.base64 === undefined
            ? []
            : [{ type: "image" as const, data: result.base64, mimeType: "image/png" }]),
        ],
      };
    }
    return {
      content: [
        text(`Full-page capture of ${args.url} saved to ${result.file}${note}`),
        ...(result.base64 === undefined
          ? []
          : [{ type: "image" as const, data: result.base64, mimeType: "image/png" }]),
      ],
    };
  } catch (err) {
    return errorResponse(err);
  }
}

// One-line suffix explaining why an inline preview was omitted. Empty when
// the preview is present, so callers can always concatenate it.
function inlineNote(
  args: { inline?: boolean; maxInlineBytes?: number },
  base64: string | undefined,
): string {
  if (base64 !== undefined) return "";
  if (args.inline === false) return " (inline preview disabled; open the saved file)";
  const budget = args.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
  const budgetLabel =
    budget >= 1_000_000 ? `${Number((budget / 1_000_000).toFixed(1))} MB` : `${budget} bytes`;
  return ` (inline preview omitted: the PNG exceeds the ${budgetLabel} inline budget; open the saved file or raise maxInlineBytes)`;
}

export async function analyze_page_structure(ctx: HandlerContext, args: {
  url: string;
  maxBands?: number;
  waitStrategy?: WaitStrategy;
  viewport?: ViewportName;
  compare?: "mobile";
  cdpEndpoint?: string;
}): Promise<ToolResponse> {
  try {
    // Attach scans one open page; the compare pass opens its own
    // mobile capture, so the two contracts cannot be mixed.
    if (args.cdpEndpoint !== undefined && args.compare !== undefined) {
      return {
        content: [
          text(
            'cdpEndpoint (attach) cannot be combined with compare:"mobile": the compare pass opens its own mobile capture. Remove compare or cdpEndpoint.',
          ),
        ],
        isError: true,
      };
    }
    // Lazy default: playwright is only touched when the tool actually runs.
    // maxBands from the tool schema is forwarded so the analyzer honors the
    // caller's cap (falling back to the analyzer's own default of 40).
    const analyze =
      ctx.deps.analyzeFn ??
      ((url: string, maxBands?: number, opts?: WaitOpts) =>
        import("../../structure.js").then((m) =>
          m.analyzePageStructure(url, undefined, maxBands, opts),
        ));
    const viewport = args.viewport ?? "desktop";
    const wantsResponsive = args.compare === "mobile";
    const primaryOpts: WaitOpts = {
      waitStrategy: args.waitStrategy,
      viewport,
      ...(args.cdpEndpoint !== undefined ? { cdpEndpoint: args.cdpEndpoint } : {}),
    };
    // Only the mobile capture scans elements; a mobile primary IS that capture.
    if (wantsResponsive && viewport === "mobile") primaryOpts.responsive = true;
    const structure = await analyze(args.url, args.maxBands, primaryOpts);
    if ("error" in structure) return { content: [text(structure.error)], isError: true };
    // Desktop default is byte-identical: no new keys unless compare is set.
    if (args.compare !== "mobile") {
      return { content: [text(JSON.stringify(structure, null, 1))] };
    }
    // compare:"mobile" adds a second capture at 390×844 (a phone capture is
    // already the mobile side, so it is reused). A failed second capture is
    // an error response, never a silently desktop-only "diff".
    const mobile =
      viewport === "mobile"
        ? structure
        : await analyze(args.url, args.maxBands, {
            waitStrategy: args.waitStrategy,
            viewport: "mobile",
            responsive: true,
          });
    if ("error" in mobile) {
      // Keep the valid desktop result; degrade the compare half explicitly.
      return {
        content: [
          text(JSON.stringify({ ...structure, mobileError: mobile.error }, null, 1)),
        ],
      };
    }
    const payload: Record<string, unknown> = {
      ...structure,
      mobileBands: mobile.bands,
      diff: diffBands(structure, mobile),
    };
    if (mobile.responsive) payload.responsive = mobile.responsive;
    return {
      content: [text(JSON.stringify(payload, null, 1))],
    };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function analyze_hover_census(ctx: HandlerContext, args: {
  url: string;
  waitStrategy?: WaitStrategy;
  viewport?: ViewportName;
  reducedMotion?: boolean;
  compact?: boolean;
}): Promise<ToolResponse> {
  try {
    // Lazy default: playwright is only touched when the tool actually runs.
    const capture =
      ctx.deps.hoverCensusFn ??
      ((url: string, opts?: { waitStrategy?: WaitStrategy; viewport?: ViewportName; reducedMotion?: boolean }) =>
        import("../../hover-census.js").then((m) => m.captureHoverCensus(url, opts)));
    const result = await capture(args.url, {
      waitStrategy: args.waitStrategy,
      viewport: args.viewport ?? "desktop",
      reducedMotion: args.reducedMotion,
    });
    if ("error" in result) return { content: [text(result.error)], isError: true };
    // C3: compact=true replaces sample bodies with count + selectors.
    return { content: [text(JSON.stringify(args.compact ? compactHoverCensus(result) : result, null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

// Gap 4: captures the page's 3D pose grid (headless browser via the
// injected/default capturePose3d) and renders a scroll-scrubbed three.js
// stub from a grid — the default stub path is the pure builder in
// pose-stub.ts, so no browser is ever launched for build_pose_stub.
export async function capture_pose_3d(ctx: HandlerContext, args: {
  url: string;
  steps?: number;
  viewport?: ViewportName;
}): Promise<ToolResponse> {
  try {
    const capture =
      ctx.deps.pose3dFn ??
      ((url: string, opts?: { steps?: number; viewport?: ViewportName }) =>
        import("../../pose3d.js").then((m) => m.capturePose3d(url, opts)));
    const result = await capture(args.url, { steps: args.steps, viewport: args.viewport });
    if ("error" in result) return { content: [text(result.error)], isError: true };
    return { content: [text(JSON.stringify(result, null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

// Passive scene evidence: checkpoint frames + canvas geometry + a response
// inventory, written under <cache>/scene-captures. The default loader is lazy
// (playwright is only touched when the tool runs); no image bytes are inlined.
export async function capture_scene_3d(ctx: HandlerContext, args: {
  url: string;
  canvasSelector?: string;
  scrollRoot?: string;
  viewport?: ViewportName;
  checkpoints?: { scrollRatio: number; pointer?: { x: number; y: number }; waitMs?: number }[];
  assetOrigins?: string[];
  adapters?: SceneAdapterName[];
  includeViewportShots?: boolean;
}): Promise<ToolResponse> {
  try {
    const capture =
      ctx.deps.captureSceneFn ??
      ((url: string, opts?: SceneCaptureOptions) =>
        import("../../scene-capture.js").then((m) => m.captureScene3d(url, opts)));
    const result = await capture(args.url, {
      canvasSelector: args.canvasSelector,
      scrollRoot: args.scrollRoot,
      viewport: args.viewport ?? "desktop",
      checkpoints: args.checkpoints,
      assetOrigins: args.assetOrigins,
      ...(args.adapters !== undefined ? { adapters: args.adapters } : {}),
      includeViewportShots: args.includeViewportShots,
      sceneDir: join(ctx.cache.rootDir, "scene-captures"),
    });
    if ("error" in result) return { content: [text(result.error)], isError: true };
    return { content: [text(JSON.stringify(summarizeSceneEvidence(result), null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

// Selected asset download for one capture: the module reads only that
// capture's evidence inventory, enforces the caps and writes provenance.
export async function download_scene_assets(ctx: HandlerContext, args: {
  captureId: string;
  assetIds: string[];
  rights: SceneRights;
  allowUnknown?: boolean;
}): Promise<ToolResponse> {
  try {
    const download =
      ctx.deps.downloadSceneAssetsFn ??
      ((opts: SceneAssetDownloadOptions) =>
        import("../../scene-assets.js").then((m) => m.downloadSceneAssets(opts)));
    const result = await download({
      ...args,
      sceneDir: join(ctx.cache.rootDir, "scene-captures"),
    });
    if ("error" in result) return { content: [text(result.error)], isError: true };
    // Already compact: paths, hashes, counts and rights only, never bodies.
    return { content: [text(JSON.stringify(result, null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function capture_component(ctx: HandlerContext, args: {
  url: string;
  selector?: string;
  viewport?: ViewportName;
  maxNodes?: number;
  maxDepth?: number;
  compact?: boolean;
}): Promise<ToolResponse> {
  try {
    // Lazy default: playwright is only touched when the tool actually runs.
    const capture =
      ctx.deps.captureComponentFn ??
      ((url: string, opts?: { selector?: string; viewport?: ViewportName; maxNodes?: number; maxDepth?: number }) =>
        import("../../component.js").then((m) => m.captureComponent(url, opts)));
    const result = await capture(args.url, {
      selector: args.selector,
      viewport: args.viewport ?? "desktop",
      maxNodes: args.maxNodes,
      ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
    });
    if ("error" in result) return { content: [text(result.error)], isError: true };
    // C3: compact=true strips per-node styles/text/svg/anims; the tree's
    // tag/classes/rect skeleton + fonts/colors stay (summaries omitted).
    const payload = args.compact
      ? compactComponentPack(result)
      : {
          ...result,
          typography: summarizeTypography(result),
          paletteSummary: summarizePalette(result),
        };
    return { content: [text(JSON.stringify(payload, null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function export_design_tokens(ctx: HandlerContext, args: {
  url: string;
  selector?: string;
  viewport?: ViewportName;
  maxNodes?: number;
  include?: TokenCategory[];
}): Promise<ToolResponse> {
  try {
    // Lazy default: playwright is only touched when the tool actually runs.
    const capture =
      ctx.deps.captureComponentFn ??
      ((url: string, opts?: { selector?: string; viewport?: ViewportName; maxNodes?: number }) =>
        import("../../component.js").then((m) => m.captureComponent(url, opts)));
    // Materialized because captureComponent defaults to header/400, not body/800.
    const selector = args.selector ?? "body";
    const viewport = args.viewport ?? "desktop";
    const maxNodes = args.maxNodes ?? 800;
    const pack = await capture(args.url, { selector, viewport, maxNodes });
    if ("error" in pack) return { content: [text(pack.error)], isError: true };
    const tokens = exportDesignTokens(pack, { maxNodes, include: args.include });
    return {
      content: [
        text(JSON.stringify({ url: pack.url, selector: pack.selector, viewport, ...tokens }, null, 1)),
      ],
    };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function analyze_images(ctx: HandlerContext, args: {
  url: string;
  viewport?: ViewportName;
  maxImages?: number;
}): Promise<ToolResponse> {
  try {
    // Lazy default: playwright is only touched when the tool actually runs.
    const analyze =
      ctx.deps.analyzeImagesFn ??
      ((url: string, opts?: { viewport?: ViewportName; maxImages?: number }) =>
        import("../../images.js").then((m) => m.scanImages(url, opts)));
    const viewport = args.viewport ?? "desktop";
    const maxImages = args.maxImages ?? 200;
    const scan = await analyze(args.url, { viewport, maxImages });
    if ("error" in scan) return { content: [text(scan.error)], isError: true };
    const report = summarizeImages(scan.rows, maxImages);
    return {
      content: [
        text(
          JSON.stringify(
            {
              url: args.url,
              viewport,
              ...report,
              // The scan caps rows at 500; total stays the true pre-cap count.
              total: scan.total,
              truncated: report.truncated || scan.total > report.scanned,
            },
            null,
            1,
          ),
        ),
      ],
    };
  } catch (err) {
    return errorResponse(err);
  }
}
