// Output contract for verify_build. Two success shapes share one tool:
// compact=true returns counts only, the default returns labels plus band
// diagnostics. MCP requires an object root (a union root would be wrapped as
// {result: ...} on the 2025 wire), so this is one optional-field object whose
// superRefine selects the branch by buildUrl presence, mirroring
// indexGetOutputSchema.
import { z } from "zod";

const verdictSchema = z.enum(["pass", "warn", "fail"]);

const bandDiagnosticSchema = z.object({
  referenceIndex: z.number().int().nonnegative().nullable(),
  buildIndex: z.number().int().nonnegative().nullable(),
  status: z.enum(["matched", "reference-only", "build-only"]),
  matchReason: z.enum(["label", "background", "height"]).nullable(),
  orderChanged: z.boolean(),
  heightDeltaRatio: z.number().nullable(),
  backgroundChanged: z.boolean().nullable(),
});

const fullBandsSchema = z.object({
  score: z.number(),
  matched: z.array(z.string()),
  refOnly: z.array(z.string()),
  buildOnly: z.array(z.string()),
  diagnostics: z.array(bandDiagnosticSchema),
});

const compactBandsSchema = z.object({
  score: z.number(),
  matched: z.number().int().nonnegative(),
  refOnly: z.number().int().nonnegative(),
  buildOnly: z.number().int().nonnegative(),
});

const fullMotionSchema = z.object({
  score: z.number(),
  refFingerprint: z.string(),
  buildFingerprint: z.string(),
  // Compact-only today; optional so legacy full reports stay valid.
  captureStable: z.boolean().nullable().optional(),
  acquisition: z.unknown().optional(),
});

const compactMotionSchema = z.object({
  score: z.number(),
  captureStable: z.boolean().nullable().optional(),
});

const fullOutputSchema = z.strictObject({
  buildUrl: z.string(),
  referenceUrl: z.string(),
  bands: fullBandsSchema,
  motion: fullMotionSchema,
  overall: z.number(),
  verdict: verdictSchema,
  evidence: z.array(z.string()),
  domDiff: z.unknown().optional(),
  scene3d: z.unknown().optional(),
});

const compactOutputSchema = z.strictObject({
  verdict: verdictSchema,
  overall: z.number(),
  bands: compactBandsSchema,
  motion: compactMotionSchema,
  scene3d: z.unknown().optional(),
});

export const verifyBuildOutputSchema = z
  .object({
    buildUrl: z.string().optional(),
    referenceUrl: z.string().optional(),
    bands: z.union([fullBandsSchema, compactBandsSchema]).optional(),
    motion: z.union([fullMotionSchema, compactMotionSchema]).optional(),
    overall: z.number().optional(),
    verdict: verdictSchema.optional(),
    evidence: z.array(z.string()).optional(),
    domDiff: z.unknown().optional(),
    scene3d: z.unknown().optional(),
  })
  .superRefine((value, ctx) => {
    const branch = value.buildUrl === undefined ? compactOutputSchema : fullOutputSchema;
    const parsed = branch.safeParse(value);
    if (parsed.success) return;
    const label = branch === fullOutputSchema ? "full" : "compact";
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        code: "custom",
        message: `${label} report: ${issue.message}`,
        path: issue.path,
      });
    }
  });
