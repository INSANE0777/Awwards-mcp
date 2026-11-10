// Phase 6A evidence export: derive the site from the selected regions, then
// call the existing bounded builder. No arbitrary output path and no download.
import type { Cache } from "../cache.js";
import { buildEvidencePack, EvidencePackError } from "./evidence-pack.js";
import {
  exportEvidencePackDataSchema,
  type AtlasEnvelope,
  type ExportEvidencePackData,
  type ExportEvidencePackInput,
} from "./tool-contracts.js";
import { atlasFailure, atlasSuccess, safeMessage } from "./tool-envelope.js";
import { ATLAS_ID } from "./tool-limits.js";

const DEFAULT_GOAL = "Local Atlas evidence reference for the selected regions";
const MAX_REGIONS = 12;

function validSelection(regionIds: readonly string[]): boolean {
  return (
    regionIds.length >= 1 &&
    regionIds.length <= MAX_REGIONS &&
    new Set(regionIds).size === regionIds.length &&
    regionIds.every((regionId) => ATLAS_ID.test(regionId))
  );
}

function selectedSite(cache: Cache, regionIds: string[]): string | null {
  if (!validSelection(regionIds)) return null;
  if (!cache.atlas) return null;
  try {
    const rows = cache.withAtlasReadDb(
      (db) =>
        db
          .prepare(
            `SELECT DISTINCT p.site_slug
               FROM atlas_regions r
               JOIN atlas_captures c ON c.id = r.capture_id
               JOIN atlas_pages p ON p.id = c.page_id
              WHERE r.id IN (${regionIds.map(() => "?").join(",")})`,
          )
          .all(...regionIds) as Array<{ site_slug: string }>,
    );
    if (rows.length !== 1) return null;
    return rows[0]!.site_slug;
  } catch {
    return null;
  }
}

export async function runAtlasExport(
  cache: Cache,
  input: ExportEvidencePackInput,
  now: number,
  options: { build?: typeof buildEvidencePack } = {},
): Promise<AtlasEnvelope<ExportEvidencePackData>> {
  if (!cache.atlas) {
    return atlasFailure(
      "export_evidence_pack",
      "FEATURE_DISABLED",
      "Atlas evidence packs require AWWWARDS_MCP_ATLAS=1",
      false,
    );
  }
  if (!validSelection(input.regionIds)) {
    return atlasFailure(
      "export_evidence_pack",
      "INVALID_SELECTION",
      "regionIds must be 1-12 distinct 64-character hex region ids",
      false,
    );
  }
  const siteSlug = selectedSite(cache, input.regionIds);
  if (!siteSlug) {
    return atlasFailure(
      "export_evidence_pack",
      "INVALID_SELECTION",
      "regionIds must all belong to active heads of one cached site",
      false,
    );
  }
  try {
    const build = options.build ?? buildEvidencePack;
    const result = await build(
      {
        siteSlug,
        goal: input.goal?.trim() || DEFAULT_GOAL,
        regionIds: input.regionIds,
        inclusionMode: input.includeMedia ?? "references",
        ...(input.rightsAssertions !== undefined
          ? { rightsAssertions: input.rightsAssertions }
          : {}),
      },
      { cache, now: () => now },
    );
    const data: ExportEvidencePackData = {
      packId: result.packId,
      directory: result.directory,
      manifestPath: result.manifestPath,
      manifestHash: result.manifestHash,
      files: result.files.slice(0, 256),
      selectedRegionIds: result.selectedRegionIds.slice(0, 12),
      excludedArtifacts: result.excludedArtifacts.slice(0, 64),
      validation: {
        manifest: "pass",
        claims: "pass",
        hashes: "pass",
        designMd: result.files.some((file) => file.path === "DESIGN.md")
          ? "pass"
          : "not_applicable",
      },
      cached: result.cached,
    };
    return atlasSuccess("export_evidence_pack", "ok", exportEvidencePackDataSchema.parse(data), {
      status: "complete",
      collected: data.files.length,
      excluded: data.excludedArtifacts.length,
      limitations: [],
    });
  } catch (error) {
    if (error instanceof EvidencePackError) {
      return atlasFailure(
        "export_evidence_pack",
        error.code === "ATLAS_DISABLED" ? "FEATURE_DISABLED" : error.code,
        safeMessage(error.message, cache.rootDir),
        error.code === "PACK_WRITE_FAILED",
      );
    }
    return atlasFailure(
      "export_evidence_pack",
      "EXPORT_FAILED",
      safeMessage(error instanceof Error ? error.message : String(error), cache.rootDir),
      false,
    );
  }
}
