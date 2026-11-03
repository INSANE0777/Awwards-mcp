// v2 pilot: consolidated offline builder. Not registered in the 1.x tool
// surface. Exactly one branch per request; every branch object is strict so
// cross-branch fields fail validation instead of being silently ignored.
import { z } from "zod";
import type { Handlers, ToolResponse } from "../server.js";
import { asMcpResult, type ToolContext } from "../tools/shared.js";
import { sceneAssetBindingsSchema } from "../tools/scene.js";

export const buildMotionRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("pose_stub"),
      poseGrid: z
        .any()
        .describe(
          "PoseGrid object as returned by capture_page (kind=pose; id pose-grid-v1): frames + scroll ratios only, so the stub's camera anchors are synthesized guidance, not recovered camera data",
        ),
      scrollCensus: z
        .any()
        .optional()
        .describe("Optional full ScrollCensus from analyze_motion (kind=scroll, compact=false)"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("gsap_stub"),
      scrollCensus: z
        .any()
        .describe(
          "Full ScrollCensus JSON from analyze_motion (kind=scroll): anims[] + gsapTriggers[] required; compact census output is rejected",
        ),
      poseGrid: z
        .any()
        .optional()
        .describe(
          "Optional PoseGrid JSON from capture_page (kind=pose): adds synthesized camera anchors (guidance, not recovered camera data)",
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("manifest"),
      bands: z.any().describe("inspect_page (kind=structure) result (must carry bands[])"),
      scrollCensus: z
        .any()
        .describe(
          "Full analyze_motion (kind=scroll, compact=false) result: anims[] + gsapTriggers[] required; compact census output is rejected",
        ),
      sections: z
        .array(z.object({ label: z.string().min(1), selector: z.string().optional() }))
        .max(60)
        .optional()
        .describe("Optional section overrides in build order"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("scene_stub"),
      evidencePath: z
        .string()
        .min(1)
        .max(4096)
        .describe(
          "Local scene-evidence-v1 JSON from capture_page (kind=scene): under <cache>/scene-captures, or an exported pack with top-level \"exported\": true",
        ),
      assetBindings: sceneAssetBindingsSchema.optional(),
      title: z.string().min(1).max(200).optional().describe("Title for index.html and the provenance README"),
    })
    .strict(),
]);

export type BuildMotionRequest = z.infer<typeof buildMotionRequestSchema>;

export const buildMotionInputSchema = z
  .object({
    request: buildMotionRequestSchema.describe(
      "Exactly one build operation; choose kind and its branch fields",
    ),
  })
  .strict();

export async function runBuildMotion(
  handlers: Handlers,
  request: BuildMotionRequest,
): Promise<ToolResponse> {
  switch (request.kind) {
    case "pose_stub":
      return handlers.build_pose_stub({
        poseGrid: request.poseGrid,
        ...(request.scrollCensus !== undefined ? { scrollCensus: request.scrollCensus } : {}),
      });
    case "gsap_stub":
      return handlers.build_gsap_stub({
        scrollCensus: request.scrollCensus,
        ...(request.poseGrid !== undefined ? { poseGrid: request.poseGrid } : {}),
      });
    case "manifest":
      return handlers.build_motion_manifest({
        bands: request.bands,
        scrollCensus: request.scrollCensus,
        ...(request.sections ? { sections: request.sections } : {}),
      });
    case "scene_stub":
      return handlers.build_scene_stub({
        evidencePath: request.evidencePath,
        ...(request.assetBindings !== undefined ? { assetBindings: request.assetBindings } : {}),
        ...(request.title !== undefined ? { title: request.title } : {}),
      });
    default: {
      const exhaustive: never = request;
      throw new Error(`unhandled build_motion request: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function registerBuildMotion(ctx: ToolContext): void {
  ctx.tool(
    "build_motion",
    "Generate motion scaffolding from captured evidence. Choose exactly one request.kind: pose_stub (standalone three.js scroll stub from a PoseGrid with synthesized camera guidance, optional scroll census), gsap_stub (GSAP+ScrollTrigger timeline stub from a scroll census, optional PoseGrid), manifest (motion.manifest.json scaffold from page bands + scroll census, optional section overrides), or scene_stub (offline Vite + Three.js scaffold from a scene-evidence-v1 pack: mode reconstructed-subset when a glb/gltf model is bound or the experimental three adapter recorded at least one supported mesh, otherwise placeholder; primitive meshes, perspective camera and OrbitControls-compatible controls are recreated only from evidence.three, unsupported types stay unresolved, and it never executes captured code). Pure and offline: no page fetches, no install and no project files written by the tool — write the returned files yourself. Use build_project to convert a local HTML rebuild into a framework project.",
    buildMotionInputSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (args: { request: BuildMotionRequest }) =>
      asMcpResult(runBuildMotion(ctx.handlers, args.request)),
  );
}
