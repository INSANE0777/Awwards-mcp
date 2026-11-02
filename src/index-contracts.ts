// Output contracts for the local-index tools. 1.x exposes status and stats as
// separate tools; v2 merges them into get_index, whose schema must accept
// either branch. MCP requires an object root, so the v2 contract is the merged
// field set with every branch field optional rather than a union.
import { z } from "zod";

const coverageSchema = z.object({
  sitesTotal: z.number().int().nonnegative(),
  note: z.literal("locally cached subset"),
});

const windowedCoverageSchema = coverageSchema.extend({
  detailsCached: z.number().int().nonnegative(),
  windowDays: z.number().int().positive(),
  detailParseCap: z.number().int().positive(),
});

const sampleShape = {
  sample: z.number().int().nonnegative(),
  insufficient: z.boolean(),
  hint: z.string().optional(),
};

export const indexStatusOutputSchema = z.object({
  sitesCount: z.number().int().nonnegative(),
  progress: z.object({
    pagesDone: z.number().int().nonnegative(),
    pagesTotal: z.number().int().nonnegative(),
  }),
  lastSuccessfulFinishAt: z.number().int().nonnegative().nullable(),
  lastError: z.string().nullable(),
  lock: z.object({
    startedAt: z.number().int().nonnegative().nullable(),
    active: z.boolean(),
    stale: z.boolean(),
  }),
  indexFreshness: z.object({
    stale: z.boolean(),
    ageMs: z.number().int().nonnegative().nullable(),
    staleAfterMs: z.number().int().positive(),
  }),
});

export const indexStatsOutputSchema = z.object({
  windowDays: z.number().int().positive(),
  top: z.number().int().positive(),
  sites: z.object({
    total: z.number().int().nonnegative(),
    coverage: coverageSchema,
  }),
  details: z.object({
    cached: z.number().int().nonnegative(),
    coverage: windowedCoverageSchema,
  }),
  elements: z.object({
    total: z.number().int().nonnegative(),
    coverage: coverageSchema,
  }),
  technologies: z.object({
    items: z.array(
      z.object({ tag: z.string(), count: z.number().int().nonnegative() }),
    ),
    distinct: z.number().int().nonnegative(),
    coverage: coverageSchema,
  }),
  colors: z.object({
    items: z.array(
      z.object({ hex: z.string(), count: z.number().int().nonnegative() }),
    ),
    detailsParsed: z.number().int().nonnegative(),
    ...sampleShape,
    coverage: windowedCoverageSchema,
  }),
  scores: z.object({
    n: z.number().int().nonnegative(),
    avg: z.number().nullable(),
    median: z.number().nullable(),
    ...sampleShape,
    coverage: windowedCoverageSchema,
  }),
  motionLibs: z.object({
    items: z.array(
      z.object({ lib: z.string(), count: z.number().int().nonnegative() }),
    ),
    rows: z.number().int().nonnegative(),
    ...sampleShape,
    coverage: windowedCoverageSchema,
  }),
  note: z.string(),
});

const statusKeys = Object.keys(indexStatusOutputSchema.shape) as Array<
  keyof z.infer<typeof indexStatusOutputSchema>
>;
const statsKeys = Object.keys(indexStatsOutputSchema.shape) as Array<
  keyof z.infer<typeof indexStatsOutputSchema>
>;

export const indexGetOutputSchema = z
  .object({ ...indexStatusOutputSchema.shape, ...indexStatsOutputSchema.shape })
  .partial()
  .superRefine((value, ctx) => {
    const hasStatus = "sitesCount" in value;
    const hasStats = "sites" in value;
    if (hasStatus === hasStats) {
      ctx.addIssue({
        code: "custom",
        message: "Expected exactly one get_index branch: status or stats",
      });
      return;
    }
    const required = hasStatus ? statusKeys : statsKeys;
    const forbidden = hasStatus ? statsKeys : statusKeys;
    const keys = new Set(Object.keys(value));
    for (const key of required) {
      if (!keys.has(key)) {
        ctx.addIssue({ code: "custom", message: `Missing ${String(key)} for the selected branch` });
      }
    }
    for (const key of forbidden) {
      if (keys.has(key)) {
        ctx.addIssue({ code: "custom", message: `Unexpected ${String(key)} from the other branch` });
      }
    }
  });
