// Output contract for create_design_brief: the success payload is the exact
// DesignBrief object also embedded as JSON in the Markdown. Errors carry none.
import { z } from "zod";
import type { DesignBrief } from "./design-brief.js";

const signalSchema = z.object({
  value: z.string(),
  display: z.string(),
  frequency: z.number().int().nonnegative(),
  sourceSlugs: z.array(z.string()),
});

const categorySignalSchema = signalSchema.extend({
  // Category signals include sharedPatterns/outliers, which preserve palette
  // entries and their luminance band.
  luminanceBand: z.enum(["light", "mid", "dark"]).optional(),
});

const durationRangeSchema = z.object({
  p25: z.number(),
  median: z.number(),
  p75: z.number(),
  sourceSlugs: z.array(z.string()),
});

export const designBriefOutputSchema = z.strictObject({
  version: z.literal(1),
  goal: z.string(),
  audience: z.string().optional(),
  constraints: z.array(z.string()),
  sources: z.array(
    z.object({
      slug: z.string(),
      title: z.string(),
      evidence: z.object({
        detail: z.enum(["cached", "fetched", "unavailable"]),
        motion: z.enum(["cached", "unavailable"]),
        elements: z.enum(["cached", "unavailable"]),
        structure: z.enum(["captured", "unavailable", "not_requested"]),
      }),
    }),
  ),
  direction: z.object({
    summary: z.string(),
    sharedPatterns: z.array(categorySignalSchema),
    outliers: z.array(categorySignalSchema),
    palette: z.array(signalSchema.extend({ luminanceBand: z.enum(["light", "mid", "dark"]) })),
    technologySignals: z.array(signalSchema),
    elementSignals: z.array(signalSchema),
    motion: z.object({
      availableSourceSlugs: z.array(z.string()),
      libraries: z.array(signalSchema),
      renderers: z.array(signalSchema),
      scrollModels: z.array(signalSchema),
      interactionSignals: z.array(signalSchema),
      easings: z.array(signalSchema),
      durationRange: durationRangeSchema.nullable(),
    }),
    interactionPlan: z.object({
      cursorHover: z.array(signalSchema),
      scroll: z.array(signalSchema),
      entranceReveal: z.array(signalSchema),
      easings: z.array(signalSchema),
      durationRange: durationRangeSchema.nullable(),
      accessibility: z.string(),
      staggerHints: z.array(z.string()).optional(),
    }),
    structure: z
      .object({
        availableSourceSlugs: z.array(z.string()),
        bandCounts: z.array(
          z.object({ slug: z.string(), count: z.number().int().nonnegative() }),
        ),
        repeatedTags: z.array(signalSchema),
      })
      .optional(),
    buildConstraints: z.array(z.string()),
    limitations: z.array(z.string()),
  }),
});

// Compile-time guard: the contract and the TypeScript shape must not drift.
type SchemaBrief = z.infer<typeof designBriefOutputSchema>;
const _schemaMatchesBrief: [
  DesignBrief extends SchemaBrief ? true : never,
  SchemaBrief extends DesignBrief ? true : never,
] = [true, true];
