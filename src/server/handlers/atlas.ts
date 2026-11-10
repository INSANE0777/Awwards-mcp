import type { HandlerContext } from "../context.js";
import type { ToolResponse } from "../types.js";
import {
  runAtlasCapture,
  runAtlasExport,
  runAtlasSearch,
  runGetAtlas,
  atlasToolResponse,
} from "../../atlas/tools.js";
import { atlasFailure, safeMessage } from "../../atlas/tool-envelope.js";
import type {
  CaptureAtlasInput,
  ExportEvidencePackInput,
  GetAtlasInput,
  SearchAtlasToolInput,
} from "../../atlas/tool-contracts.js";

function unexpected(ctx: HandlerContext, operation: string, error: unknown): ToolResponse {
  return atlasToolResponse(
    atlasFailure(
      operation,
      "INTERNAL_ERROR",
      safeMessage(error instanceof Error ? error.message : String(error), ctx.cache.rootDir),
      false,
    ),
  );
}

export async function search_atlas(
  ctx: HandlerContext,
  args: SearchAtlasToolInput,
): Promise<ToolResponse> {
  try {
    const run = ctx.deps.atlasSearchFn ?? runAtlasSearch;
    return atlasToolResponse(run(ctx.cache, args, ctx.nowMs()));
  } catch (error) {
    return unexpected(ctx, "search_atlas", error);
  }
}

export async function get_atlas(
  ctx: HandlerContext,
  args: GetAtlasInput,
): Promise<ToolResponse> {
  try {
    const run = ctx.deps.atlasGetFn ?? runGetAtlas;
    return atlasToolResponse(run(ctx.cache, args, ctx.nowMs()));
  } catch (error) {
    return unexpected(ctx, "get_atlas", error);
  }
}

export async function capture_atlas(
  ctx: HandlerContext,
  args: CaptureAtlasInput,
  signal?: AbortSignal,
): Promise<ToolResponse> {
  try {
    const run = ctx.deps.atlasCaptureFn ?? runAtlasCapture;
    return atlasToolResponse(
      await run(ctx.cache, args, { now: ctx.nowMs, ...(signal ? { signal } : {}) }),
    );
  } catch (error) {
    return unexpected(ctx, "capture_atlas", error);
  }
}

export async function export_evidence_pack(
  ctx: HandlerContext,
  args: ExportEvidencePackInput,
): Promise<ToolResponse> {
  try {
    const run = ctx.deps.atlasExportFn ?? runAtlasExport;
    return atlasToolResponse(await run(ctx.cache, args, ctx.nowMs()));
  } catch (error) {
    return unexpected(ctx, "export_evidence_pack", error);
  }
}
