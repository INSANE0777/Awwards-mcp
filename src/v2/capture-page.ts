// v2 capture group: screenshot, component pack, pose grid and motion recording.
// Not registered in the 1.x surface. Exactly one branch per request; every
// branch object is strict so cross-branch fields fail validation.
import { z } from "zod";
import type { Handlers, ToolResponse } from "../server.js";
import { asMcpResult, viewportSchema, waitStrategySchema, type ToolContext } from "../tools/shared.js";
import {
  sceneAdaptersSchema,
  sceneAssetIdsSchema,
  sceneCaptureIdSchema,
  sceneHttpUrlSchema,
  sceneRightsSchema,
} from "../tools/scene.js";
import { captureAtlasInputSchema } from "../atlas/tool-contracts.js";

const SCENE_CAPTURE_ONLY = [
  "url",
  "canvasSelector",
  "scrollRoot",
  "viewport",
  "checkpoints",
  "assetOrigins",
  "adapters",
  "includeViewportShots",
] as const;
const SCENE_DOWNLOAD_ONLY = ["captureId", "assetIds", "rights", "allowUnknown"] as const;

export const capturePageRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("screenshot"),
      url: z.string().url().describe("Absolute URL of the site to capture"),
      waitStrategy: waitStrategySchema,
      viewport: viewportSchema,
      inline: z
        .boolean()
        .optional()
        .describe("false omits the inline base64 preview (file is still saved)"),
      maxInlineBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Byte budget for the inline base64 preview (default 2500000)"),
      waitForOverlay: z
        .boolean()
        .default(true)
        .describe("wait up to 10s for a full-screen fixed preloader to clear; false captures immediately"),
      scrollCapture: z
        .enum(["auto", "anchors", "viewport"])
        .default("auto")
        .describe(
          'inner-scroller pages: "auto"/"anchors" saves 6 ordered viewport screenshots; "viewport" saves one; document-scrolling pages keep the single full-page capture',
        ),
      publicOnly: z.boolean().optional().describe("Refuse private/loopback/metadata destinations and route the browser through the pinned public-address guard"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("component"),
      url: z.string().url().describe("Absolute page URL whose component to serialize"),
      selector: z
        .string()
        .min(1)
        .optional()
        .describe("CSS selector of the component root (default 'header')"),
      maxNodes: z.number().int().min(50).max(2000).optional()
        .describe("Max DOM nodes to serialize (default 400, clamp 50-2000)"),
      viewport: viewportSchema,
      compact: z
        .boolean()
        .optional()
        .describe("token-diet summary: node styles/text/svg/anims and typography/paletteSummary are dropped"),
      publicOnly: z.boolean().optional().describe("Refuse private/loopback/metadata destinations and route the browser through the pinned public-address guard"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pose"),
      url: z.string().url().describe("Absolute page URL to capture (https:// or file://)"),
      steps: z.number().int().min(3).max(10).optional()
        .describe("Scroll samples across the page (default 6)"),
      viewport: viewportSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("scene"),
      op: z
        .enum(["capture", "download_assets"])
        .describe('"capture" records evidence; "download_assets" fetches selected inventory assets (licensing required)'),
      url: sceneHttpUrlSchema
        .optional()
        .describe('Absolute http(s) page URL to capture (required for op:"capture")'),
      canvasSelector: z
        .string()
        .min(1)
        .optional()
        .describe("CSS selector of the canvas to track; omit to pick the largest visible canvas"),
      scrollRoot: z
        .string()
        .min(1)
        .optional()
        .describe("CSS selector of the element to scroll (default: the window)"),
      viewport: z
        .enum(["desktop", "mobile"])
        .optional()
        .describe("desktop = 1440x900 (default); mobile = 390x844 iPhone-class"),
      checkpoints: z
        .array(
          z.object({
            scrollRatio: z.number().min(0).max(1),
            pointer: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
            waitMs: z.number().int().min(0).max(2000).optional(),
          }),
        )
        .min(1)
        .max(10)
        .optional()
        .describe("Up to 10 checkpoints (default 6 evenly spaced ratios from 0 to 1)"),
      assetOrigins: z
        .array(sceneHttpUrlSchema)
        .max(8)
        .optional()
        .describe("Up to 8 expected asset origins to flag in the inventory; nothing is fetched"),
      adapters: sceneAdaptersSchema.optional(),
      includeViewportShots: z
        .boolean()
        .optional()
        .describe("Save a full-viewport screenshot beside each clipped canvas frame (default true)"),
      captureId: sceneCaptureIdSchema
        .optional()
        .describe('captureId from a previous op:"capture" run (required for op:"download_assets")'),
      assetIds: sceneAssetIdsSchema
        .optional()
        .describe('Up to 32 resources[].assetId values from that capture (required for op:"download_assets")'),
      rights: sceneRightsSchema
        .optional()
        .describe('Mandatory for op:"download_assets": licensing basis and evidence'),
      allowUnknown: z
        .boolean()
        .optional()
        .describe("Save assets of unknown type as .bin instead of skipping them"),
    })
    .strict()
    .superRefine((value, ctx) => {
      // superRefine is the only place the two scene ops can be separated: the
      // outer union already discriminates on `kind`, and each op keeps its own
      // required and forbidden fields here.
      if (value.op === "capture") {
        if (value.url === undefined) {
          ctx.addIssue({ code: "custom", message: 'op:"capture" requires url', path: ["url"] });
        }
        for (const key of SCENE_DOWNLOAD_ONLY) {
          if (value[key] !== undefined) {
            ctx.addIssue({
              code: "custom",
              message: `${key} belongs to op:"download_assets"`,
              path: [key],
            });
          }
        }
        return;
      }
      for (const key of ["captureId", "assetIds", "rights"] as const) {
        if (value[key] === undefined) {
          ctx.addIssue({
            code: "custom",
            message: `op:"download_assets" requires ${key}`,
            path: [key],
          });
        }
      }
      for (const key of SCENE_CAPTURE_ONLY) {
        if (value[key] !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: `${key} belongs to op:"capture"`,
            path: [key],
          });
        }
      }
    }),
  z
    .object({
      kind: z.literal("recording"),
      url: z.string().url().describe("Absolute URL of the site to record"),
      frames: z
        .number()
        .int()
        .min(4)
        .max(36)
        .default(16)
        .describe("Filmstrip tile count (default 16 → a 4x4 grid)"),
      waitStrategy: waitStrategySchema,
      viewport: viewportSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("atlas"),
      ...captureAtlasInputSchema.shape,
    })
    .strict(),
]);

export type CapturePageRequest = z.infer<typeof capturePageRequestSchema>;

export const capturePageInputSchema = z
  .object({
    request: capturePageRequestSchema.describe(
      "Exactly one capture operation; choose kind and its branch fields",
    ),
  })
  .strict();

export async function runCapturePage(
  handlers: Handlers,
  request: CapturePageRequest,
  signal?: AbortSignal,
): Promise<ToolResponse> {
  switch (request.kind) {
    case "screenshot":
      return handlers.capture_live_site({
        url: request.url,
        waitStrategy: request.waitStrategy,
        viewport: request.viewport,
        ...(request.inline !== undefined ? { inline: request.inline } : {}),
        ...(request.maxInlineBytes !== undefined ? { maxInlineBytes: request.maxInlineBytes } : {}),
        waitForOverlay: request.waitForOverlay,
        scrollCapture: request.scrollCapture,
        ...(request.publicOnly !== undefined ? { publicOnly: request.publicOnly } : {}),
      });
    case "component":
      return handlers.capture_component({
        url: request.url,
        ...(request.selector !== undefined ? { selector: request.selector } : {}),
        ...(request.maxNodes !== undefined ? { maxNodes: request.maxNodes } : {}),
        maxDepth: 12,
        viewport: request.viewport,
        ...(request.compact !== undefined ? { compact: request.compact } : {}),
        ...(request.publicOnly !== undefined ? { publicOnly: request.publicOnly } : {}),
      });
    case "pose":
      return handlers.capture_pose_3d({
        url: request.url,
        ...(request.steps !== undefined ? { steps: request.steps } : {}),
        viewport: request.viewport,
      });
    case "scene":
      // The branch's superRefine enforces the op-specific required fields, so
      // the captures below only narrow them for TypeScript.
      if (request.op === "capture") {
        return handlers.capture_scene_3d({
          url: request.url!,
          ...(request.canvasSelector !== undefined ? { canvasSelector: request.canvasSelector } : {}),
          ...(request.scrollRoot !== undefined ? { scrollRoot: request.scrollRoot } : {}),
          ...(request.viewport !== undefined ? { viewport: request.viewport } : {}),
          ...(request.checkpoints !== undefined ? { checkpoints: request.checkpoints } : {}),
          ...(request.assetOrigins !== undefined ? { assetOrigins: request.assetOrigins } : {}),
          ...(request.adapters !== undefined ? { adapters: request.adapters } : {}),
          ...(request.includeViewportShots !== undefined
            ? { includeViewportShots: request.includeViewportShots }
            : {}),
          ...(signal ? { signal } : {}),
        });
      }
      return handlers.download_scene_assets({
        captureId: request.captureId!,
        assetIds: request.assetIds!,
        rights: request.rights!,
        ...(request.allowUnknown !== undefined ? { allowUnknown: request.allowUnknown } : {}),
        ...(signal ? { signal } : {}),
      });
    case "recording":
      return handlers.record_site_motion({
        url: request.url,
        frames: request.frames,
        waitStrategy: request.waitStrategy,
        viewport: request.viewport,
      });
    case "atlas": {
      const { kind: _kind, ...args } = request;
      return handlers.capture_atlas(args, signal);
    }
    default: {
      const exhaustive: never = request;
      throw new Error(`unhandled capture_page request: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function registerCapturePage(ctx: ToolContext): void {
  ctx.tool(
    "capture_page",
    "Capture the artifact needed for a rebuild. Choose exactly one request.kind: screenshot (full-page or inner-scroller anchors), component (portable component pack with structure, styles and animations), pose (WebGL/canvas pose grid for scroll-driven 3D), scene (two strict ops: op:\"capture\" records passive scene evidence - checkpoint frames, canvas geometry and a redacted response inventory, with no scene graph, camera, shader or geometry recovery unless the experimental adapters opt in: \"three\" adds a bounded evidence.three summary from reachable window objects (no heap crawl), and \"spector\" installs the optional spectorjs bundle before load and adds a bounded evidence.spector summary of one WebGL frame (command names/counts, context attributes, analyses and capped shader source; no command arguments, state or memory); op:\"download_assets\" downloads up to 32 inventory assetIds and requires rights.basis (owned|licensed|permission) plus rights.evidence because downloading is a licensing decision, recorded in provenance.json; caps are 16 MiB/file, 64 MiB/run, 5 redirects, 1 req/s, 15s body and 120s overall, and only observed URLs without query, fragment or credentials are fetched), or recording (motion filmstrip video of preloader, scroll and hover), or — when AWWWARDS_MCP_ATLAS=1 — atlas (capture and publish local Atlas evidence for one known site slug; one viewport, components default true, up to 3 hover/focus states, refresh=false reuses a matching usable head up to 7 days old; partial evidence may return without publication). Component packs cap serialized tree depth at 12 (not configurable on this surface; depthCapped:true means deeper nodes were omitted) so the payload stays inside Code Mode's depth limit. Dependencies differ: all five need the optional Playwright dependency, except scene op:\"download_assets\" which uses plain Node http(s); recording also needs ffmpeg-static. This tool is not read-only: the recording branch can click interactive elements and submit their forms to expose hover/click motion, scene op:\"download_assets\" writes asset files, and the atlas branch writes an active head.",
    capturePageInputSchema,
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    (args: { request: CapturePageRequest }, sdkCtx?: { mcpReq?: { signal?: AbortSignal } }) =>
      asMcpResult(runCapturePage(ctx.handlers, args.request, sdkCtx?.mcpReq?.signal)),
  );
}
