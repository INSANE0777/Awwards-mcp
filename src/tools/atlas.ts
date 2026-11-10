import {
  captureAtlasEnvelopeSchema,
  captureAtlasInputSchema,
  exportEvidencePackEnvelopeSchema,
  exportEvidencePackInputSchema,
  getAtlasEnvelopeSchema,
  getAtlasInputSchema,
  searchAtlasEnvelopeSchema,
  searchAtlasInputSchema,
} from "../atlas/tool-contracts.js";
import { asMcpResult, type ToolContext } from "./shared.js";
import { z } from "zod";

export function registerSearchAtlas(ctx: ToolContext): void {
  ctx.tool(
    "search_atlas",
    "Search the local Atlas section/component evidence index; zero network. Choose kind=sections or kind=components. scopes are same region (default), same page or same site — trait combinations never silently combine across regions. evidenceMode defaults to candidate because labels are uncalibrated hints; accepted returns only accepted labels and observed_only excludes proposed values. A state=hover/focus query needs explicit state evidence and otherwise returns inconclusive insufficient_coverage. Facets are disjunctive; predicates are conjunctive. The result is the Atlas envelope: interpreted input, hits with witnesses/claims/artifacts/coverage, total, facets, corpus counts, nextCursor (15 minutes, bound to query and revision) and outcome. empty_corpus and insufficient_coverage mean not observed, never proven absent. Candidate hits are candidateOnly and must not be reported as validated taxonomy. Follow nextCursor for page 2.",
    searchAtlasInputSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (args: z.infer<typeof searchAtlasInputSchema>) =>
      asMcpResult(ctx.handlers.search_atlas(args)),
    searchAtlasEnvelopeSchema,
  );
}

export function registerGetAtlas(ctx: ToolContext): void {
  ctx.tool(
    "get_atlas",
    "Read local Atlas evidence; zero network. Choose exactly one kind: status (enabled state, stored/current schema, FTS, vocabulary and classifier versions, revision, counts by source/region/capture status, fresh/stale live captures, latest publication and failed attempt as aggregate identifiers only (no site slugs), lease, deduplicated artifact bytes, FTS availability, coverage note; no filesystem-wide scan) | taxonomy (registry version, fields/values/aliases/enabled state/permitted evidence bases, supported scopes/states and explicitly unsupported operations) | region (one stored region with capture conditions and source identity, up to 128 claims, relevant artifact descriptors with hash/size availability checks, parent and up to 24 child summaries, and current/historical head status; no raw component tree is embedded — use the pack artifact path and hash) | highlight (resolve an existing element id through Atlas aliases; ambiguous ids return AMBIGUOUS_ALIAS with candidate region ids; the legacy gallery is never fetched). Returns the Atlas envelope with typed errors.",
    getAtlasInputSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (args: z.infer<typeof getAtlasInputSchema>) => asMcpResult(ctx.handlers.get_atlas(args)),
    getAtlasEnvelopeSchema,
  );
}

export function registerCaptureAtlas(ctx: ToolContext): void {
  ctx.tool(
    "capture_atlas",
    "Capture and publish Atlas evidence for one known Awwwards site. The live URL comes only from cached site metadata; path (optional) must be a single-slash path on that origin with no query, fragment or credentials. One viewport per call (desktop default, mobile opt-in); components default true; at most 3 hover/focus state requests on regions of the current active head, and click/type/submit are never performed. refresh=false (default) reuses a matching usable active head up to 7 days old; refresh=true always launches the guarded collector. Publication atomicity, robots/destination policy and the one-per-cache lease are unchanged. A capture may return partial evidence without publication; published states the actual result, and cached=true means no new capture ran. captureId is empty when nothing was stored. Rights: page-derived content stays local evidence, not redistribution permission.",
    captureAtlasInputSchema,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    (args: z.infer<typeof captureAtlasInputSchema>) =>
      asMcpResult(ctx.handlers.capture_atlas(args)),
    captureAtlasEnvelopeSchema,
  );
}

export function registerExportEvidencePack(ctx: ToolContext): void {
  ctx.tool(
    "export_evidence_pack",
    "Build a validated local Atlas evidence pack for 1-12 distinct section/component regions from one cached site. goal (max 1,000 characters) explains the intended rebuild; includeMedia=references (default) copies only derived summaries, while permitted copies only artifacts covered by an explicit caller rights assertion (owned/licensed/permission, export_copy scope, non-empty reference) and never overrides robots/destination refusals. rightsAssertions are recorded, not verified legal conclusions. The pack is written under the cache's fixed evidence-packs directory and returns packId, directory, manifest path/hash, file hashes, selected regions, excluded artifacts and validation. There is no arbitrary output path, overwrite switch, asset downloader or sharing operation; an identical selection returns cached=true. If validation fails, the previous pack is preserved.",
    exportEvidencePackInputSchema,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (args: z.infer<typeof exportEvidencePackInputSchema>) =>
      asMcpResult(ctx.handlers.export_evidence_pack(args)),
    exportEvidencePackEnvelopeSchema,
  );
}
