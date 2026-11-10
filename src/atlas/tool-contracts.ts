// Strict contracts for the Phase 6A Atlas tool surface. The envelope is the
// spec's Atlas result; each operation narrows `data` to its own strict schema.
import { z } from "zod";
import { ATLAS_CLASSIFIER_VERSION, ATLAS_FTS_VERSION, ATLAS_SCHEMA_VERSION } from "./schema.js";
import { rightsRecordSchema } from "./contracts.js";
import { ATLAS_ID } from "./tool-limits.js";
import type { SearchAtlasInput } from "./search-types.js";
import { ATLAS_VOCABULARY_VERSION } from "./vocabulary.js";

export const ATLAS_SCHEMA_ID = "awwwards-atlas-v1";
export const ATLAS_SCHEMA_VERSION_CURRENT = ATLAS_SCHEMA_VERSION;
export const ATLAS_FTS_VERSION_CURRENT = ATLAS_FTS_VERSION;
export const ATLAS_VOCABULARY_VERSION_CURRENT = ATLAS_VOCABULARY_VERSION;
export const ATLAS_CLASSIFIER_VERSION_CURRENT = ATLAS_CLASSIFIER_VERSION;

const id = z.string().regex(ATLAS_ID);
const boundedText = z.string().max(200);
const coverage = z
  .object({
    status: z.enum(["complete", "partial", "unknown"]),
    collected: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    limitations: z.array(z.string().min(1).max(200)).max(64),
  })
  .strict();
const warnings = z.array(z.string().min(1).max(100)).max(64);
const errorBody = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(2000),
    retryable: z.boolean(),
  })
  .strict();

/** The spec §5.6 common result envelope. `data` is narrowed per operation. */
export const atlasEnvelopeSchema = <T extends z.ZodTypeAny>(data: T) =>
  z
    .object({
      schemaVersion: z.literal(ATLAS_SCHEMA_ID),
      operation: z.string().min(1).max(100),
      status: z.enum(["ok", "partial", "inconclusive", "blocked", "error"]),
      data: data.nullable(),
      coverage,
      warnings,
      error: errorBody.nullable(),
    })
    .strict();

export type AtlasEnvelope<T> = {
  schemaVersion: typeof ATLAS_SCHEMA_ID;
  operation: string;
  status: "ok" | "partial" | "inconclusive" | "blocked" | "error";
  data: T | null;
  coverage: z.infer<typeof coverage>;
  warnings: string[];
  error: z.infer<typeof errorBody> | null;
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export const atlasSearchFieldSchema = z.enum([
  "section.purpose",
  "component.type",
  "context.section_purpose",
  "region.kind",
  "region.tag",
  "region.role",
  "region.landmark",
]);

export const atlasSearchScopeSchema = z.enum(["region", "page", "site"]);
export const atlasSearchViewportSchema = z.enum(["desktop", "mobile"]);
export const atlasSearchStateSchema = z.enum(["default", "hover", "focus"]);
export const atlasEvidenceModeSchema = z.enum(["accepted", "observed_only", "candidate"]);
export const atlasGroupBySchema = z.enum(["instance", "pattern"]);
export const atlasSortSchema = z.enum(["relevance", "newest"]);

const predicateSchema = z
  .object({
    field: atlasSearchFieldSchema.describe(
      "Predicate field: section.purpose, component.type, context.section_purpose, region.kind, region.tag, region.role or region.landmark",
    ),
    values: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(8)
      .describe("One or more values (max 8) in that field; values in one predicate are OR, separate predicates are AND"),
  })
  .strict();

/** Fields shared by the flat `search_atlas` input and the v2 branches. */
export const atlasSearchFilterShape = {
  query: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe("Bounded free text over stored region titles, headings, copy and accepted labels (max 16 tokens)"),
  predicates: z
    .array(predicateSchema)
    .max(8)
    .optional()
    .describe("At most 8 AND predicates; values inside one predicate are OR"),
  scope: atlasSearchScopeSchema
    .optional()
    .describe("Witness scope: region (same region), page (same page) or site (same site); default region"),
  viewport: atlasSearchViewportSchema.optional().describe("Collection viewport; default desktop"),
  state: atlasSearchStateSchema
    .optional()
    .describe("Observed interaction state; default default. hover/focus need explicit state evidence, otherwise the outcome is insufficient_coverage"),
  evidenceMode: atlasEvidenceModeSchema
    .optional()
    .describe("accepted (accepted labels only), observed_only (observed non-proposed) or candidate (hints included); default candidate"),
  siteSlugs: z
    .array(z.string().min(1).max(128).regex(/^[\w-]+$/))
    .min(1)
    .max(20)
    .refine((slugs) => new Set(slugs).size === slugs.length, "siteSlugs must be distinct")
    .optional()
    .describe("Restrict every match, count and facet to these site slugs (max 20 distinct)"),
  maxAgeDays: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .describe("Freshness window in days over the evidence confirmation time; default 30"),
  groupBy: atlasGroupBySchema
    .optional()
    .describe("instance counts regions; pattern groups repeated components (components default pattern, sections only instance)"),
  sort: atlasSortSchema
    .optional()
    .describe("relevance (bm25 for text queries, tiered otherwise) or newest; default relevance"),
  facets: z
    .array(atlasSearchFieldSchema)
    .max(4)
    .optional()
    .describe("Up to 4 distinct facet fields; counts are disjunctive"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Anchors per page, 1-20; default 8"),
  cursor: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe("Opaque cursor from a previous nextCursor; bound to the query and revision and expires after 15 minutes"),
};

export const searchAtlasInputSchema = z
  .object({
    kind: z.enum(["sections", "components"]).describe("Search sections or component patterns"),
    ...atlasSearchFilterShape,
  })
  .strict();

export type SearchAtlasToolInput = z.infer<typeof searchAtlasInputSchema>;
// Compile-time check: the tool contract cannot drift from the search engine input.
const _searchInputCheck: SearchAtlasInput = {} as SearchAtlasToolInput;
void _searchInputCheck;

const interpretedSchema = z
  .object({
    kind: z.enum(["sections", "components"]),
    query: z.string().max(300).optional(),
    predicates: z.array(predicateSchema).max(8),
    scope: atlasSearchScopeSchema,
    viewport: atlasSearchViewportSchema,
    state: atlasSearchStateSchema,
    evidenceMode: atlasEvidenceModeSchema,
    siteSlugs: z.array(z.string().max(128)).max(20).optional(),
    maxAgeDays: z.number().int().min(1).max(3650),
    groupBy: atlasGroupBySchema,
    sort: atlasSortSchema,
    facets: z.array(atlasSearchFieldSchema).max(4),
    limit: z.number().int().min(1).max(20),
  })
  .strict();

const predicateExplanationSchema = z
  .object({
    field: atlasSearchFieldSchema,
    values: z.array(z.string().max(200)).max(20),
    supportingRegionIds: z.array(z.string().max(128)).max(200),
    sampleKeys: z.array(z.string().max(256)).max(200),
    truncated: z.boolean(),
  })
  .strict();

const claimSummarySchema = z
  .object({
    field: z.string().max(100),
    value: z.string().max(200),
    classification: z.enum(["observed", "inferred", "proposed"]),
    decision: z.enum(["accepted", "candidate", "rejected"]),
    basis: z.enum([
      "source_title",
      "source_metadata",
      "native_semantics",
      "declared_aria",
      "computed_style",
      "geometry",
      "interaction_observation",
      "rule_derivation",
      "human_review",
    ]),
    sampleKey: z.string().max(256),
  })
  .strict();

const artifactDescriptorSchema = z
  .object({
    kind: z.string().max(100),
    storagePath: z.string().max(1024),
    sha256: z.string().max(128).nullable(),
    bytes: z.number().int().nonnegative().nullable(),
    mimeType: z.string().max(200),
  })
  .strict();

const patternGroupSchema = z
  .object({
    key: z.string().max(256),
    memberRegionIds: z.array(z.string().max(128)).max(200),
    matchingMembers: z.number().int().nonnegative(),
    observedMembers: z.number().int().nonnegative(),
  })
  .strict();

const atlasHitSchema = z
  .object({
    regionId: z.string().max(128),
    captureId: z.string().max(128),
    pageId: z.string().max(128),
    siteSlug: z.string().max(128),
    siteTitle: z.string().max(200),
    sitePublicUrl: z.string().max(1024).nullable(),
    sourceUrl: z.string().max(1024).nullable(),
    pageUrl: z.string().max(1024).nullable(),
    pagePath: z.string().max(512).nullable(),
    kind: z.enum(["section", "component"]),
    componentType: z.string().max(200).nullable(),
    primaryLabel: z.string().max(200).nullable(),
    viewport: atlasSearchViewportSchema,
    state: atlasSearchStateSchema,
    observedAt: z.number().int().nonnegative(),
    freshness: z.enum(["fresh", "stale"]),
    matchedSampleKey: z.string().max(256).nullable(),
    explanations: z.array(predicateExplanationSchema).max(8),
    explanationsTruncated: z.boolean(),
    claims: z.array(claimSummarySchema).max(8),
    screenshotKeys: z.array(z.string().max(256)).max(8),
    screenshotsTruncated: z.boolean(),
    artifacts: z.array(artifactDescriptorSchema).max(8),
    coverage,
    patternKey: z.string().max(256).nullable(),
    group: patternGroupSchema.nullable(),
    observationSpan: z
      .object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() })
      .strict()
      .optional(),
    candidateOnly: z.boolean(),
  })
  .strict();

const facetSchema = z
  .object({
    field: atlasSearchFieldSchema,
    disjunctive: z.literal(true),
    countUnit: z.enum(["region_instance", "component_pattern"]),
    values: z
      .array(
        z
          .object({
            value: z.string().max(200),
            count: z.number().int().nonnegative(),
            selected: z.boolean(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

export const searchAtlasDataSchema = z
  .object({
    outcome: z.enum(["matches", "no_observed_match", "empty_corpus", "insufficient_coverage"]),
    revision: z.number().int().nonnegative(),
    asOf: z.number().int().nonnegative(),
    interpreted: interpretedSchema,
    results: z.array(atlasHitSchema).max(20),
    total: z.number().int().nonnegative(),
    countUnit: z.enum(["region_instance", "component_pattern"]),
    nextCursor: z.string().max(4096).nullable(),
    facets: z.array(facetSchema).max(4),
    corpus: z
      .object({
        sites: z.number().int().nonnegative(),
        pages: z.number().int().nonnegative(),
        captures: z.number().int().nonnegative(),
        note: z.literal("locally cached subset"),
        catalogueTotal: z.null(),
      })
      .strict(),
    candidateOnly: z.boolean(),
    candidateNote: z.string().max(500).nullable(),
    responseTruncated: z.boolean(),
  })
  .strict();

export const searchAtlasEnvelopeSchema = atlasEnvelopeSchema(searchAtlasDataSchema);

// ---------------------------------------------------------------------------
// get_atlas: status / taxonomy / region / highlight
// ---------------------------------------------------------------------------

const int = z.number().int().nonnegative();

const statusCountsSchema = z
  .object({
    sources: z
      .object({
        awwwardsItem: int,
        legacyGallery: int,
        livePage: int,
      })
      .strict(),
    regions: z
      .object({
        page: int,
        highlight: int,
        section: int,
        component: int,
      })
      .strict(),
    captures: z
      .object({
        running: int,
        complete: int,
        partial: int,
        unknown: int,
        blocked: int,
        failed: int,
        abandoned: int,
      })
      .strict(),
  })
  .strict();

export const atlasStatusDataSchema = z
  .object({
    enabled: z.boolean(),
    available: z.boolean(),
    versions: z
      .object({
        schema: int.nullable(),
        fts: int.nullable(),
        vocabulary: z.string().max(100).nullable(),
        classifier: z.string().max(100).nullable(),
        currentSchema: int,
        currentFts: int,
        currentVocabulary: z.string().max(100),
        currentClassifier: z.string().max(100),
      })
      .strict(),
    revision: int.nullable(),
    updatedAt: int.nullable(),
    counts: statusCountsSchema,
    liveCaptures: z
      .object({ fresh: int, stale: int, total: int })
      .strict(),
    latestPublication: z
      .object({
        publishedAt: int,
        pageId: z.string().max(128),
        captureId: z.string().max(128),
        profileKey: z.string().max(100),
      })
      .strict()
      .nullable(),
    latestFailedAttempt: z
      .object({
        captureId: z.string().max(128),
        pageId: z.string().max(128),
        status: z.string().max(50),
        startedAt: int,
        finishedAt: int.nullable(),
        error: z.string().max(300).nullable(),
      })
      .strict()
      .nullable(),
    lease: z
      .object({
        state: z.enum(["free", "held", "expired", "unavailable"]),
        expiresAt: int.nullable(),
        ttlSeconds: int.nullable(),
      })
      .strict(),
    artifacts: z
      .object({
        records: int,
        distinctHashes: int,
        bytes: int,
        readyRecords: int,
      })
      .strict(),
    fts: z.object({ available: z.boolean(), version: int.nullable() }).strict(),
    coverageNote: z.string().max(300),
  })
  .strict();

export const atlasStatusEnvelopeSchema = atlasEnvelopeSchema(atlasStatusDataSchema);

const vocabularyValueSchema = z
  .object({
    value: z.string().max(200),
    label: z.string().max(200),
    support: z.enum(["supported", "reserved", "dynamic", "disabled"]),
    enabled: z.boolean(),
    searchable: z.boolean(),
    permittedBases: z.array(z.string().max(100)).max(16),
    aliases: z.array(z.string().max(200)).max(16),
    ruleIds: z.array(z.string().max(200)).max(32),
  })
  .strict();

export const atlasTaxonomyDataSchema = z
  .object({
    registryVersion: z.string().max(100),
    fields: z
      .array(
        z
          .object({
            field: z.string().max(100),
            support: z.enum(["supported", "dynamic"]),
            provider: z.string().max(100).nullable(),
            values: z.array(vocabularyValueSchema).max(200),
          })
          .strict(),
      )
      .max(32),
    scopes: z.array(atlasSearchScopeSchema).max(8),
    states: z.array(atlasSearchStateSchema).max(8),
    evidenceModes: z.array(atlasEvidenceModeSchema).max(8),
    groupBy: z.array(atlasGroupBySchema).max(8),
    unsupported: z
      .array(
        z
          .object({
            operation: z.string().max(100),
            reason: z.string().max(300),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();

export const atlasTaxonomyEnvelopeSchema = atlasEnvelopeSchema(atlasTaxonomyDataSchema);

const regionSummarySchema = z
  .object({
    regionId: z.string().max(128),
    kind: z.enum(["section", "component"]),
    ordinal: int,
    tag: z.string().max(50).nullable(),
    role: z.string().max(100).nullable(),
    landmark: z.string().max(100).nullable(),
    selector: z.string().max(512).nullable(),
    heading: z.string().max(200),
    primaryLabel: z.string().max(200).nullable(),
    type: z.string().max(100).nullable(),
    patternKey: z.string().max(256).nullable(),
    rect: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite(),
        height: z.number().finite(),
      })
      .strict()
      .nullable(),
    visible: z.boolean().nullable(),
    state: z.string().max(50).nullable(),
    coverage,
  })
  .strict();

export type AtlasRegionSummary = z.infer<typeof regionSummarySchema>;

/** A region's parent may be the page root; children stay section/component. */
export const atlasParentSummarySchema = regionSummarySchema
  .extend({ kind: z.enum(["page", "section", "component"]) })
  .strict();
export type AtlasParentSummary = z.infer<typeof atlasParentSummarySchema>;

const regionClaimSchema = z
  .object({
    claimId: z.string().max(128),
    field: z.string().max(100),
    value: z.string().max(200),
    sampleKey: z.string().max(256),
    state: z.string().max(50),
    classification: z.enum(["observed", "inferred", "proposed"]),
    basis: z.string().max(100),
    decision: z.enum(["accepted", "candidate", "rejected"]),
    ruleId: z.string().max(200).nullable(),
    ruleVersion: z.string().max(100).nullable(),
    evidence: z
      .array(
        z
          .object({
            artifactId: z.string().max(128),
            pointer: z.string().max(1000),
            sampleKey: z.string().max(256),
          })
          .strict(),
      )
      .max(8),
    limitations: z.array(z.string().max(200)).max(16),
  })
  .strict();

const artifactAvailabilitySchema = z
  .object({
    artifactId: z.string().max(128),
    captureId: z.string().max(128),
    regionId: z.string().max(128).nullable(),
    kind: z.string().max(100),
    storagePath: z.string().max(1024).nullable(),
    sha256: z.string().max(128).nullable(),
    bytes: int.nullable(),
    mimeType: z.string().max(200),
    state: z.enum(["ready", "missing", "corrupt", "restricted"]),
    available: z.boolean(),
    availabilityNote: z.string().max(300).nullable(),
  })
  .strict();

export type AtlasArtifactAvailability = z.infer<typeof artifactAvailabilitySchema>;

export const atlasRegionDataSchema = z
  .object({
    region: z
      .object({
        regionId: z.string().max(128),
        captureId: z.string().max(128),
        pageId: z.string().max(128),
        parentId: z.string().max(128).nullable(),
        kind: z.enum(["page", "highlight", "section", "component"]),
        ordinal: int,
        tag: z.string().max(50).nullable(),
        role: z.string().max(100).nullable(),
        landmark: z.string().max(100).nullable(),
        selector: z.string().max(512).nullable(),
        heading: z.string().max(300),
        textExcerpt: z.string().max(4000),
        rawTitle: z.string().max(300).nullable(),
        primaryLabel: z.string().max(200).nullable(),
        patternKey: z.string().max(256).nullable(),
        fingerprint: z.string().max(128).nullable(),
        coverage,
        sampleKeys: z.array(z.string().max(256)).max(24),
        geometry: z
          .object({
            x: z.number().finite(),
            y: z.number().finite(),
            width: z.number().finite(),
            height: z.number().finite(),
          })
          .strict()
          .nullable(),
        viewport: z.string().max(50).nullable(),
      })
      .strict(),
    capture: z
      .object({
        captureId: z.string().max(128),
        pageId: z.string().max(128),
        siteSlug: z.string().max(200),
        sourceKind: z.string().max(50),
        profileKey: z.string().max(100),
        status: z.string().max(50),
        startedAt: int,
        finishedAt: int.nullable(),
        observedAt: int.nullable(),
        lastConfirmedAt: int.nullable(),
        sourceFetchedAt: int.nullable(),
        configHash: z.string().max(128),
        extractorVersion: z.string().max(100),
        classifierVersion: z.string().max(100),
        policy: z
          .object({
            robots: z.string().max(50).nullable(),
            publicOnly: z.boolean().nullable(),
          })
          .strict(),
        conditions: z
          .object({
            browserVersion: z.string().max(200).nullable(),
            dpr: z.number().finite().nullable(),
            reducedMotion: z.string().max(50).nullable(),
            viewport: z.string().max(50).nullable(),
            requestedStates: z.array(z.string().max(200)).max(8),
          })
          .strict(),
        source: z
          .object({
            publicUrl: z.string().max(1024).nullable(),
            path: z.string().max(512).nullable(),
            requestedUrl: z.string().max(1024).nullable(),
          })
          .strict(),
      })
      .strict(),
    claims: z.array(regionClaimSchema).max(128),
    claimsTruncated: z.boolean(),
    artifacts: z.array(artifactAvailabilitySchema).max(32),
    artifactsTruncated: z.boolean(),
    parent: atlasParentSummarySchema.nullable(),
    children: z.array(regionSummarySchema).max(24),
    childrenTruncated: z.boolean(),
    head: z
      .object({
        current: z.boolean(),
        headCaptureId: z.string().max(128).nullable(),
        publishedAt: int.nullable(),
      })
      .strict(),
  })
  .strict();

export const atlasRegionEnvelopeSchema = atlasEnvelopeSchema(atlasRegionDataSchema);

export const atlasHighlightDataSchema = z
  .object({
    elementId: z.string().min(1).max(400),
    status: z.enum(["resolved", "ambiguous", "not_found"]),
    aliasKind: z.enum(["legacy_element_slug", "legacy_gallery_slug"]).nullable(),
    regionIds: z.array(z.string().max(128)).max(64),
    region: atlasRegionDataSchema.nullable(),
  })
  .strict();

export const atlasHighlightEnvelopeSchema = atlasEnvelopeSchema(atlasHighlightDataSchema);

export const getAtlasEnvelopeSchema = atlasEnvelopeSchema(
  z.union([
    atlasStatusDataSchema,
    atlasTaxonomyDataSchema,
    atlasRegionDataSchema,
    atlasHighlightDataSchema,
  ]),
);

export const getAtlasInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status") }).strict(),
  z.object({ kind: z.literal("taxonomy") }).strict(),
  z
    .object({
      kind: z.literal("region"),
      regionId: id.describe("Stored Atlas region id (64 lowercase hex characters)"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("highlight"),
      elementId: z
        .string()
        .min(1)
        .max(400)
        .describe("Existing Awwwards element id/slug resolved through Atlas aliases; no gallery fetch"),
    })
    .strict(),
]);

export type GetAtlasInput = z.infer<typeof getAtlasInputSchema>;

// ---------------------------------------------------------------------------
// capture_atlas
// ---------------------------------------------------------------------------

const stateRequestSchema = z
  .object({
    action: z.enum(["hover", "focus"]).describe("Observed state to capture; click/type/submit are unsupported"),
    targetRegionId: id.describe("Stored section or component region id from the current active head"),
  })
  .strict();

export const captureAtlasInputSchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\w-]+$/)
      .describe("Known Awwwards site slug; the live URL comes from cached site metadata, never from a free URL"),
    path: z
      .string()
      .min(1)
      .max(2000)
      .refine(
        (value) => value.startsWith("/") && !value.startsWith("//") && !value.includes("?") && !value.includes("#"),
        "path must start with one slash and may not contain a query or fragment",
      )
      .optional()
      .describe("Path on the site's known live origin (default: known root); no query, fragment or credentials"),
    viewport: atlasSearchViewportSchema.optional().describe("desktop (1440x900) or mobile (390x844); default desktop"),
    components: z
      .boolean()
      .optional()
      .describe("Capture component candidates and packs; default true"),
    states: z
      .array(stateRequestSchema)
      .max(3)
      .optional()
      .describe("At most 3 hover/focus requests, each on a region of the current active head; unsupported actions are refused before launch")
      .refine(
        (states) => !states || new Set(states.map((state) => `${state.action}:${state.targetRegionId}`)).size === states.length,
        "state requests must not repeat an action/target pair",
      ),
    refresh: z
      .boolean()
      .optional()
      .describe("false (default) reuses a usable matching capture up to 7 days old; true always captures"),
  })
  .strict();

export type CaptureAtlasInput = z.infer<typeof captureAtlasInputSchema>;

export const captureAtlasDataSchema = z
  .object({
    captureId: z.string().max(128),
    attemptId: z.string().max(200),
    pageId: z.string().max(128),
    cached: z.boolean(),
    published: z.boolean(),
    previousHeadId: z.string().max(128).nullable(),
    viewport: atlasSearchViewportSchema,
    sections: z.array(regionSummarySchema).max(64),
    components: z.array(regionSummarySchema).max(64),
    artifacts: z.array(artifactAvailabilitySchema).max(32),
    capabilityCoverage: z
      .object({
        geometry: coverage,
        sections: coverage,
        components: coverage,
        screenshots: coverage,
        tokens: coverage,
        states: coverage,
        motion: coverage,
        rendering: coverage,
        policy: coverage,
      })
      .strict(),
    omitted: z
      .object({
        sections: int,
        components: int,
        screenshots: int,
        componentPacks: int,
      })
      .strict(),
  })
  .strict();

export const captureAtlasEnvelopeSchema = atlasEnvelopeSchema(captureAtlasDataSchema);

// ---------------------------------------------------------------------------
// export_evidence_pack
// ---------------------------------------------------------------------------

export const exportEvidencePackInputSchema = z
  .object({
    regionIds: z
      .array(id)
      .min(1)
      .max(12)
      .refine((values) => new Set(values).size === values.length, "regionIds must be distinct")
      .describe("1-12 distinct section/component region ids from one site's active heads"),
    goal: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .optional()
      .describe("What the pack is for, at most 1,000 characters; a neutral local-reference goal is used when omitted"),
    includeMedia: z
      .enum(["references", "permitted"])
      .optional()
      .describe("references (default) copies only derived summaries; permitted copies only artifacts with a caller rights assertion"),
    rightsAssertions: z
      .array(
        z
          .object({
            artifactId: id.describe("Stored artifact id the assertion is about"),
            rights: rightsRecordSchema.describe("Caller assertion; recorded, never presented as a verified legal conclusion"),
          })
          .strict(),
      )
      .max(24)
      .refine(
        (values) => new Set(values.map((value) => value.artifactId)).size === values.length,
        "rightsAssertions must not repeat an artifactId",
      )
      .optional()
      .describe("At most 24 assertions; required to copy an artifact in permitted mode"),
  })
  .strict();

export type ExportEvidencePackInput = z.infer<typeof exportEvidencePackInputSchema>;

export const exportEvidencePackDataSchema = z
  .object({
    packId: z.string().max(128),
    directory: z.string().max(4096),
    manifestPath: z.string().max(4096),
    manifestHash: z.string().max(128),
    files: z
      .array(
        z
          .object({
            path: z.string().max(512),
            sha256: z.string().max(128),
            bytes: int,
            mimeType: z.string().max(200),
          })
          .strict(),
      )
      .max(256),
    selectedRegionIds: z.array(z.string().max(128)).max(12),
    excludedArtifacts: z
      .array(
        z
          .object({
            artifactId: z.string().max(128),
            reason: z.string().max(100),
          })
          .strict(),
      )
      .max(64),
    validation: z
      .object({
        manifest: z.literal("pass"),
        claims: z.literal("pass"),
        hashes: z.literal("pass"),
        designMd: z.enum(["pass", "not_applicable"]),
      })
      .strict(),
    cached: z.boolean(),
  })
  .strict();

export const exportEvidencePackEnvelopeSchema = atlasEnvelopeSchema(exportEvidencePackDataSchema);

export type AtlasStatusData = z.infer<typeof atlasStatusDataSchema>;
export type AtlasTaxonomyData = z.infer<typeof atlasTaxonomyDataSchema>;
export type AtlasRegionData = z.infer<typeof atlasRegionDataSchema>;
export type AtlasHighlightData = z.infer<typeof atlasHighlightDataSchema>;
export type CaptureAtlasData = z.infer<typeof captureAtlasDataSchema>;
export type ExportEvidencePackData = z.infer<typeof exportEvidencePackDataSchema>;
