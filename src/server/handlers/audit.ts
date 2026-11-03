import { join } from "node:path";
import type { Scene3dVerifyOptions, VerifySceneFn } from "../../scene-verify.js";
import type { WaitStrategy } from "../../structure.js";
import type { VerifyFlowArgs } from "../../verify-flow.js";
import type { ViewportName } from "../../viewport.js";
import type { HandlerContext } from "../context.js";
import {
  compactAuditResult,
  compactVerifyReport,
  errorResponse,
  text,
} from "../types.js";
import type { ToolResponse } from "../types.js";

// ---- inspection (W2): evidence-only runtime + a11y + local aggregates ----

export async function audit_url(ctx: HandlerContext, args: {
  url: string;
  viewport?: ViewportName;
  timeoutMs?: number;
  compact?: boolean;
}): Promise<ToolResponse> {
  try {
    const audit =
      ctx.deps.auditUrlFn ??
      ((a: { url: string; viewport?: ViewportName; timeoutMs?: number }) =>
        import("../../audit-url.js").then((m) =>
          m.auditUrl(a.url, { viewport: a.viewport, timeoutMs: a.timeoutMs }),
        ));
    const result = await audit({
      url: args.url,
      viewport: args.viewport,
      timeoutMs: args.timeoutMs,
    });
    if ("error" in result) return { content: [text(result.error)], isError: true };
    // compact=true: severity counts + ranked actions instead of every finding.
    const payload = args.compact ? compactAuditResult(result) : result;
    return { content: [text(JSON.stringify(payload, null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function analyze_accessibility(ctx: HandlerContext, args: {
  url: string;
  viewport?: ViewportName;
  limit?: number;
}): Promise<ToolResponse> {
  try {
    const analyze =
      ctx.deps.analyzeAccessibilityFn ??
      ((a: { url: string; viewport?: ViewportName; limit?: number }) =>
        import("../../a11y.js").then((m) =>
          m.analyzeAccessibility(a.url, { viewport: a.viewport, limit: a.limit }),
        ));
    const result = await analyze(args);
    if ("error" in result) return { content: [text(result.error)], isError: true };
    return { content: [text(JSON.stringify(result, null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function analyze_bundle(ctx: HandlerContext, args: {
  url: string;
  keywords?: string[];
  maxChunks?: number;
  walkChunks?: boolean;
  edges?: boolean;
  bundleIntel?: boolean;
}): Promise<ToolResponse> {
  try {
    // Lazy default: bundle-forensics is only touched when the tool actually runs.
    const capture =
      ctx.deps.bundleFn ??
      ((url: string, opts?: { keywords?: string[]; maxChunks?: number; walkChunks?: boolean; edges?: boolean; bundleIntel?: boolean }) =>
        import("../../bundle-forensics.js").then((m) =>
          m.captureBundleForensics(url, {
            keywords: opts?.keywords,
            maxChunks: opts?.maxChunks,
            walkChunks: opts?.walkChunks,
            edges: opts?.edges,
            bundleIntel: opts?.bundleIntel,
          }),
        ));
    const result = await capture(args.url, {
      keywords: args.keywords,
      maxChunks: args.maxChunks,
      walkChunks: args.walkChunks,
      edges: args.edges,
      bundleIntel: args.bundleIntel,
    });
    if ("error" in result) return { content: [text(result.error)], isError: true };
    return { content: [text(JSON.stringify(result, null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function analyze_network_capture(ctx: HandlerContext, args: {
  path: string;
  top?: number;
}): Promise<ToolResponse> {
  try {
    // Local file only: the module never fetches a recorded URL.
    const analyze =
      ctx.deps.networkCaptureFn ??
      ((path: string, opts?: { top?: number }) =>
        import("../../network-capture.js").then((m) => m.analyzeNetworkCapture(path, opts)));
    const result = await analyze(args.path, { top: args.top });
    if ("error" in result) return { content: [text(result.error)], isError: true };
    return { content: [text(JSON.stringify(result, null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function verify_flow(ctx: HandlerContext, args: VerifyFlowArgs): Promise<ToolResponse> {
  try {
    // Lazy default: playwright is only touched when the tool actually runs.
    const run = ctx.deps.verifyFlowFn ??
      ((flowArgs: VerifyFlowArgs) =>
        import("../../verify-flow.js").then((m) => m.verifyFlow(flowArgs)));
    const result = await run(args);
    if ("error" in result) return { content: [text(result.error)], isError: true };
    return { content: [text(JSON.stringify(result, null, 1))] };
  } catch (err) {
    return errorResponse(err);
  }
}

export async function verify_build(ctx: HandlerContext, args: {
  buildUrl: string;
  referenceUrl: string;
  waitStrategy?: WaitStrategy;
  viewport?: ViewportName;
  domDiff?: boolean;
  scene3d?: Scene3dVerifyOptions;
  compact?: boolean;
}): Promise<ToolResponse> {
  try {
    // Lazy default: playwright is only touched when the tool actually runs.
    const verify =
      ctx.deps.verifyBuildFn ??
      ((verifyArgs: {
        buildUrl: string;
        referenceUrl: string;
        waitStrategy?: WaitStrategy;
        viewport?: ViewportName;
        domDiff?: boolean;
        scene3d?: Scene3dVerifyOptions;
        sceneDir?: string;
        sceneFn?: VerifySceneFn;
      }) => import("../../verify-build.js").then((m) => m.verifyBuild(verifyArgs)));
    // scene3d reaches the orchestrator only when requested, so the default
    // payload of every other verify_build call is unchanged.
    const sceneArgs = args.scene3d
      ? {
          scene3d: args.scene3d,
          sceneDir: join(ctx.cache.rootDir, "scene-captures"),
          ...(ctx.deps.verifySceneFn ? { sceneFn: ctx.deps.verifySceneFn } : {}),
        }
      : {};
    const result = await verify({
      buildUrl: args.buildUrl,
      referenceUrl: args.referenceUrl,
      waitStrategy: args.waitStrategy,
      viewport: args.viewport,
      domDiff: args.domDiff,
      ...sceneArgs,
    });
    if ("error" in result) return { content: [text(result.error)], isError: true };
    // compact=true: verdict + scores only; evidence lines and band names drop.
    const payload = args.compact ? compactVerifyReport(result) : result;
    return {
      content: [text(JSON.stringify(payload, null, 1))],
      structuredContent: payload as unknown as Record<string, unknown>,
    };
  } catch (err) {
    return errorResponse(err);
  }
}
