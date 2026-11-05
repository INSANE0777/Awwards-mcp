import { z } from "zod";
import type { PreparedSitePage } from "./types.js";

const id = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().nonnegative();
const siteSlug = z.string().min(1).max(200).regex(/^[\w-]+$/);
const httpUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "expected an absolute HTTP(S) URL");

const juryDimensionsSchema = z
  .object({
    design: z.number().finite(),
    usability: z.number().finite(),
    creativity: z.number().finite(),
    content: z.number().finite(),
  })
  .strict();

export const siteDetailsSchema = z
  .object({
    slug: siteSlug,
    title: z.string().nullable(),
    description: z.string().nullable(),
    palette: z.array(z.string().max(32)).max(64),
    technologies: z.array(z.string()).max(200),
    elements: z.array(z.string()).max(500),
    awards: z
      .array(z.object({ title: z.string().max(300), date: z.string().max(100) }).strict())
      .max(100),
    nominee: z.boolean(),
    score: z.number().finite().nullable(),
    juryDimensions: juryDimensionsSchema.optional(),
    ogImage: z.string().max(2048).nullable(),
    liveUrl: z.string().nullable(),
  })
  .strict();

export const evidenceCoverageSchema = z
  .object({
    status: z.enum(["complete", "partial", "unknown"]),
    collected: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    limitations: z.array(z.string().min(1).max(100)).max(64),
  })
  .strict();

export const rightsRecordSchema = z
  .object({
    status: z.enum(["unknown", "owned", "licensed", "permission"]),
    reference: z.string().max(2000).nullable(),
    recordedAt: timestamp,
    assertedBy: z.enum(["unknown", "caller"]),
    scope: z.enum(["local_reference", "export_copy"]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "export_copy" && value.status !== "unknown" && !value.reference) {
      ctx.addIssue({
        code: "custom",
        path: ["reference"],
        message: "a rights reference is required to copy an artifact into an export",
      });
    }
  });

export const evidenceRefSchema = z
  .object({
    artifactId: id,
    pointer: z.string().max(1000).regex(/^(?:\/(?:[^~]|~[01])*)*$/),
    sampleKey: z.string().min(1).max(100),
  })
  .strict();

export const atlasResultSchema = <T extends z.ZodTypeAny>(data: T) =>
  z
    .object({
      schemaVersion: z.literal("awwwards-atlas-v1"),
      operation: z.string().min(1).max(100),
      status: z.enum(["ok", "partial", "inconclusive", "blocked", "error"]),
      data: data.nullable(),
      coverage: evidenceCoverageSchema,
      warnings: z.array(z.string().min(1).max(100)).max(64),
      error: z
        .object({
          code: z.string().min(1).max(100),
          message: z.string().min(1).max(2000),
          retryable: z.boolean(),
        })
        .strict()
        .nullable(),
    })
    .strict();

export const preparedHighlightSchema = z
  .object({
    title: z.string().max(300),
    mediaPath: z.string().min(1).max(2000),
    identity: id,
  })
  .strict();

export const preparedLegacyElementSchema = z
  .object({
    identity: id,
    fallbackSlug: z.string().min(1).max(400).regex(/^[\w-]+$/),
    siteSlug: z.string().min(1).max(200),
    title: z.string(),
    mediaPath: z.string().min(1).max(2000),
    mediaType: z.enum(["video", "image"]).nullable(),
    author: z.string(),
    fetchedAt: timestamp,
  })
  .strict();

export const preparedSitePageSchema = z
  .object({
    slug: siteSlug,
    sourceUrl: httpUrl,
    fetchedAt: timestamp,
    sourceDigest: id,
    detail: siteDetailsSchema,
    detailValid: z.boolean(),
    detailEmpty: z.boolean(),
    highlights: z.array(preparedHighlightSchema).max(500),
    highlightParse: z.discriminatedUnion("status", [
      z.object({ status: z.literal("absent"), items: z.tuple([]) }).strict(),
      z.object({ status: z.literal("parsed"), items: z.array(preparedHighlightSchema).min(1).max(500) }).strict(),
      z.object({ status: z.literal("drift"), items: z.tuple([]) }).strict(),
    ]),
    legacyElements: z.array(preparedLegacyElementSchema).max(500),
    summary: z
      .object({
        title: z.string().nullable(),
        liveUrl: z.string().nullable(),
      })
      .strict()
      .nullable(),
    provenance: z.enum(["item_page", "legacy_import"]).optional(),
    sourceFetchedAt: timestamp.nullable().optional(),
    evidenceTimes: z
      .object({
        detail: timestamp.nullable(),
        elements: timestamp.nullable(),
      })
      .strict()
      .optional(),
    limitations: z.array(z.string().min(1).max(100)).max(64).optional(),
    publishable: z.boolean().optional(),
  })
  .strict();

export type PreparedSitePageInput = z.infer<typeof preparedSitePageSchema>;

/** Strict entry check shared by the cache and Atlas store commit paths. */
export function validatePreparedSitePage(value: PreparedSitePage): void {
  const parsed = preparedSitePageSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid Atlas prepared page: ${detail}`);
  }
}
