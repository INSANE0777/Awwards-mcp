import { z } from "zod";
import { asMcpResult, viewportSchema, type ToolContext } from "./shared.js";
import type { Handlers, ToolResponse } from "../server.js";

// http(s) only: the capture gate also enforces this, but rejecting earlier
// keeps file:// and data: out of the Playwright path entirely.
export const sceneHttpUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "Only http:// and https:// URLs are accepted");

const checkpointSchema = z.object({
  scrollRatio: z
    .number()
    .min(0)
    .max(1)
    .describe("Target scroll position as a fraction of the scroll range (0 = top, 1 = bottom)"),
  pointer: z
    .object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    })
    .optional()
    .describe("Normalized viewport coordinates the mouse is moved to before the settle wait"),
  waitMs: z
    .number()
    .int()
    .min(0)
    .max(2000)
    .optional()
    .describe("Settle wait after scrolling/pointing (default 400, max 2000)"),
});

// Kept as patterns so a traversal attempt fails at the schema boundary too.
export const sceneCaptureIdSchema = z
  .string()
  .regex(
    /^scene-[a-z0-9]{1,24}-[0-9a-f]{8}$/,
    "captureId must be the id returned by an op:\"capture\" run (scene-<time>-<hex>)",
  )
  .describe("captureId returned by a previous op:\"capture\" run");

export const sceneAssetIdsSchema = z
  .array(
    z
      .string()
      .regex(/^asset-\d{1,4}$/, "assetId must be an inventory ID (asset-<n>) from resources[].assetId"),
  )
  .min(1)
  .max(32)
  .describe("Up to 32 assetIds from that capture's inventory (resources[].assetId)");

// Shared by build_scene_stub (1.x) and build_motion kind:"scene_stub" (v2).
// Rejecting traversal at the schema boundary keeps it out of the fs layer.
const safeLocalPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => !value.includes("\0") && !value.split(/[\\/]+/).includes(".."),
    'localPath must not contain a ".." traversal segment',
  );

export const sceneAssetBindingSchema = z
  .object({
    resourceId: z
      .string()
      .regex(/^asset-\d{1,4}$/, "resourceId must be an inventory ID (asset-<n>)")
      .describe("resources[].assetId from the same evidence pack"),
    localPath: safeLocalPathSchema.describe(
      "Local file you already hold: regular file, no symlink, <=64 MiB, extension glb/gltf/bin/png/jpg/jpeg/webp/ktx2/hdr/exr",
    ),
  })
  .strict();

export const sceneAssetBindingsSchema = z
  .array(sceneAssetBindingSchema)
  .max(32)
  .superRefine((rows, ctx) => {
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      if (seen.has(row.resourceId)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "resourceId"],
          message: `resourceId ${row.resourceId} is bound more than once`,
        });
      }
      seen.add(row.resourceId);
    });
  })
  .describe("Up to 32 local files bound to inventory rows; each resourceId binds once");

// Shared by verify_build on both surfaces: the 3D gate replays one capture
// pack on the build, so it never takes free-form paths or URLs.
export const scene3dTolerancesSchema = z
  .object({
    pixelThreshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        "Per-channel normalized delta (0..1) above which a pixel counts as changed (default 0 while no verdict is issued)",
      ),
    maxChangedFraction: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Max share of changed pixels (0..1) for a checkpoint to pass"),
    cameraAngleDeg: z
      .number()
      .min(0)
      .max(180)
      .optional()
      .describe("Accepted camera-angle delta in degrees; used only when the pack carries camera data"),
  })
  .strict()
  .describe("Verdict inputs; supply pixelThreshold and maxChangedFraction together for a pass/fail");

export const scene3dVerifySchema = z
  .object({
    referenceCaptureId: sceneCaptureIdSchema.describe(
      'captureId of the reference pack to replay (from a capture_page kind:"scene" op:"capture" run)',
    ),
    buildSelector: z
      .string()
      .min(1)
      .max(2000)
      .describe("CSS selector of the build page's <canvas> to compare"),
    tolerances: scene3dTolerancesSchema.optional(),
  })
  .strict();

export const sceneRightsSchema = z
  .object({
    basis: z
      .enum(["owned", "licensed", "permission"])
      .describe("Why you may download: you own it, a licence covers it, or you have permission"),
    evidence: z
      .string()
      .min(1)
      .max(2000)
      .describe("Concrete evidence: licence reference, ownership statement or permission source"),
  })
  .strict()
  .describe("Mandatory licensing assertion; recorded with a timestamp in provenance.json");

// Shared by both surfaces: two experimental adapters, each at most once.
export const sceneAdaptersSchema = z
  .array(z.enum(["three", "spector"]))
  .max(2)
  .superRefine((rows, ctx) => {
    rows.forEach((name, index) => {
      if (rows.indexOf(name) !== index) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: `adapters entry ${JSON.stringify(name)} is listed more than once`,
        });
      }
    });
  })
  .describe(
    'Experimental, opt-in adapters (max 2, no duplicates): "three" reads objects reachable from window.THREE, window.scene/camera/renderer and window.app/experience/viewer/world after load (no hooks, no heap crawl) and adds a bounded evidence.three summary; "spector" needs the optional spectorjs package, installs its bundle as an init script before load and captures one WebGL frame into a bounded evidence.spector summary (command names/counts, context attributes, analyses and capped shader source). No network fetch and no UI',
  );

const captureRequestSchema = z
  .object({
    op: z.literal("capture"),
    url: sceneHttpUrlSchema.describe("Absolute http(s) page URL to capture"),
    canvasSelector: z
      .string()
      .min(1)
      .optional()
      .describe("CSS selector of the canvas to track; omit to pick the largest visible <canvas>"),
    scrollRoot: z
      .string()
      .min(1)
      .optional()
      .describe("CSS selector of the element to scroll (default: the window)"),
    viewport: viewportSchema,
    checkpoints: z
      .array(checkpointSchema)
      .min(1)
      .max(10)
      .optional()
      .describe("Up to 10 checkpoints (default 6 evenly spaced ratios from 0 to 1)"),
    assetOrigins: z
      .array(sceneHttpUrlSchema)
      .max(8)
      .optional()
      .describe(
        "Up to 8 expected asset origins to flag in the inventory; nothing is fetched from them",
      ),
    adapters: sceneAdaptersSchema.optional(),
    includeViewportShots: z
      .boolean()
      .default(true)
      .describe("Save a full-viewport screenshot beside each clipped canvas frame"),
  })
  .strict();

const downloadRequestSchema = z
  .object({
    op: z.literal("download_assets"),
    captureId: sceneCaptureIdSchema,
    assetIds: sceneAssetIdsSchema,
    rights: sceneRightsSchema,
    allowUnknown: z
      .boolean()
      .default(false)
      .describe(
        "Save assets whose MIME and magic bytes identify no known type as .bin instead of skipping them",
      ),
  })
  .strict();

export const sceneRequestSchema = z.discriminatedUnion("op", [
  captureRequestSchema,
  downloadRequestSchema,
]);

export type SceneRequest = z.infer<typeof sceneRequestSchema>;

export async function runSceneRequest(
  handlers: Handlers,
  request: SceneRequest,
): Promise<ToolResponse> {
  if (request.op === "capture") {
    return handlers.capture_scene_3d({
      url: request.url,
      canvasSelector: request.canvasSelector,
      scrollRoot: request.scrollRoot,
      viewport: request.viewport,
      checkpoints: request.checkpoints,
      assetOrigins: request.assetOrigins,
      ...(request.adapters !== undefined ? { adapters: request.adapters } : {}),
      includeViewportShots: request.includeViewportShots,
    });
  }
  return handlers.download_scene_assets({
    captureId: request.captureId,
    assetIds: request.assetIds,
    rights: request.rights,
    allowUnknown: request.allowUnknown,
  });
}

export function registerCaptureScene3d(ctx: ToolContext): void {
  ctx.tool(
    "capture_scene_3d",
    "Scene evidence in two strict operations. request.op:\"capture\" records a passive evidence pack for a WebGL/canvas page: at each checkpoint it scrolls the selected root, optionally moves the pointer, and saves a viewport screenshot plus a clipped canvas screenshot, with requested/actual scroll, canvas CSS rect/backing size/DPR and elapsed time. It also records a redacted inventory of the page's own responses (URL, MIME, size when declared, resource type, texture/model/HDR/shader/script/font/image guess, and an assetId per row) and passive framework hints (THREE.REVISION, BABYLON.Engine.Version, pc.version, matching script URLs, canvas count) without calling getContext or installing hooks. request.op:\"download_assets\" downloads up to 32 inventory assets from one capture: downloading is a licensing decision, so rights.basis (owned|licensed|permission) and rights.evidence are mandatory, are recorded with a timestamp in scene-captures/<captureId>/provenance.json, and are not verified by the server - do not download assets you may not use. It only fetches observed inventory URLs that carry no query string, fragment or credentials; there is no crawling, no guessed model or source-map URL and no credential use. Original bytes are written under scene-captures/<captureId>/assets with SHA-256 and an extension validated from MIME/magic (glb, gltf, bin, png, jpg, webp, ktx2, hdr, exr); unknown types are skipped unless allowUnknown saves them as .bin. Caps: 16 MiB per file, 64 MiB per run, 5 manual redirects, 1 request/second, one request at a time, 15s body deadline, 120s overall; every hop is DNS-validated and loopback/private/metadata/reserved addresses are refused. Honest scope: without the opt-in adapters no scene graph, camera, controls, shader source or geometry is recovered - frames show rendered output only. adapters are experimental and opt-in (at most two entries, each once): \"three\" reads objects reachable from window.THREE, window.scene/camera/renderer and window.app/experience/viewer/world after load (no heap crawl, no hooks, no network) and adds a bounded evidence.three summary (max 500 nodes, depth 20, 8 cameras, 8 lights, 32 materials, 200 texture URLs); \"spector\" needs the optional spectorjs package, installs its bundle as an init script before load and captures one WebGL frame into a bounded evidence.spector summary (command names/counts, context attributes, analyses, max 8 programs, 16 shaders, 64 KiB per shader source and 256 KiB of shader source total; command arguments, state, results, stack traces and memory are never transferred, and shader source is untrusted page text that is never executed). scene/camera/controls/geometry are marked available only for what three actually returned, shaders only when spector captured at least one source, and neither adapter promises scene recovery. Evidence is written to scene-captures/<captureId>/evidence.json plus PNG frames; responses are compact JSON with assetIds and downloadability, paths, hashes, counts, coverage and limitations, never inline image or asset bodies. The capture op requires the optional playwright dependency; download_assets does not.",
    { request: sceneRequestSchema.describe("Exactly one scene operation: choose op and its fields") },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    (args: { request: SceneRequest }) => asMcpResult(runSceneRequest(ctx.handlers, args.request)),
  );
}
