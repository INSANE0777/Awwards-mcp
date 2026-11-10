// Output contracts for the local-index tools. 1.x exposes status and stats as
// separate tools; v2 merges them into get_index, whose schema must accept
// either branch. MCP requires an object root, so the v2 contract is the merged
// field set with every branch field optional rather than a union.
import { z } from "zod";
import { atlasStatusEnvelopeSchema } from "./atlas/tool-contracts.js";

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

// Optional so pre-1.18 stats payloads (and injected indexStatsFn fixtures)
// keep validating; the current implementation always emits it.
const elementCorpusSchema = z.object({
  total: z.number().int().nonnegative(),
  gallery: z.number().int().nonnegative(),
  site: z.number().int().nonnegative(),
  categorized: z.number().int().nonnegative(),
  uncategorized: z.number().int().nonnegative(),
  builtWithKnown: z.number().int().nonnegative(),
  fetchedOldestAt: z.number().int().nonnegative().nullable(),
  fetchedNewestAt: z.number().int().nonnegative().nullable(),
  fetchedAtUnit: z.literal("unix-ms"),
  note: z.literal("locally cached subset"),
});

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
    corpus: elementCorpusSchema.optional(),
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
const atlasKeys = Object.keys(atlasStatusEnvelopeSchema.shape);

export const indexGetOutputSchema = z
  .object({
    ...indexStatusOutputSchema.shape,
    ...indexStatsOutputSchema.shape,
    ...atlasStatusEnvelopeSchema.shape,
  })
  .partial()
  .strict()
  .superRefine((value, ctx) => {
    const isAtlas = value.schemaVersion === "awwwards-atlas-v1";
    const hasStatus = "sitesCount" in value;
    const hasStats = "sites" in value;
    if (Number(isAtlas) + Number(hasStatus) + Number(hasStats) !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Expected exactly one get_index branch: status, stats or atlas_status",
      });
      return;
    }
    if (isAtlas) {
      const keys = new Set(Object.keys(value));
      for (const key of atlasKeys) {
        if (!keys.has(key)) {
          ctx.addIssue({ code: "custom", message: `Missing ${key} for the selected branch` });
        }
      }
      for (const key of [...statusKeys, ...statsKeys]) {
        if (keys.has(key)) {
          ctx.addIssue({
            code: "custom",
            message: `Unexpected ${String(key)} from another branch`,
          });
        }
      }
      const parsed = atlasStatusEnvelopeSchema.safeParse(value);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        ctx.addIssue({
          code: "custom",
          message: `atlas_status envelope is invalid: ${issue?.path.join(".") || "<root>"}: ${issue?.message ?? "unknown"}`,
        });
      }
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
    for (const key of atlasKeys) {
      if (keys.has(key)) {
        ctx.addIssue({ code: "custom", message: `Unexpected ${key} from the atlas_status branch` });
      }
    }
  });
