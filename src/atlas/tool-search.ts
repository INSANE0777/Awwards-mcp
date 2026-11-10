// Phase 6A search envelope: dispatch only, no query logic of its own.
import type { Cache } from "../cache.js";
import { atlasSearchStore, searchAtlas } from "./search.js";
import type { SearchAtlasData } from "./search-types.js";
import {
  searchAtlasDataSchema,
  searchAtlasEnvelopeSchema,
  type AtlasEnvelope,
  type SearchAtlasToolInput,
} from "./tool-contracts.js";
import { atlasFailure, atlasSuccess, safeMessage } from "./tool-envelope.js";
import type { EvidenceCoverage } from "./types.js";

function coverageFor(data: SearchAtlasData): EvidenceCoverage {
  const status: EvidenceCoverage["status"] =
    data.outcome === "empty_corpus"
      ? "unknown"
      : data.outcome === "insufficient_coverage" || data.responseTruncated
        ? "partial"
        : "complete";
  return {
    status,
    collected: data.total,
    excluded: 0,
    limitations: [],
  };
}

export function runAtlasSearch(
  cache: Cache,
  input: SearchAtlasToolInput,
  now: number,
): AtlasEnvelope<SearchAtlasData> {
  if (!cache.atlas) {
    return atlasFailure(
      "search_atlas",
      "FEATURE_DISABLED",
      "Atlas search requires AWWWARDS_MCP_ATLAS=1",
      false,
    );
  }
  const result = searchAtlas(input, atlasSearchStore(cache), now);
  if (!result.ok) {
    return atlasFailure(
      "search_atlas",
      result.error.code,
      result.error.message,
      result.error.retryable,
    );
  }
  const data = result.data;
  const status: AtlasEnvelope<SearchAtlasData>["status"] =
    data.outcome === "empty_corpus" || data.outcome === "insufficient_coverage"
      ? "inconclusive"
      : data.responseTruncated
        ? "partial"
        : "ok";
  const warnings = data.candidateOnly ? ["CLASSIFICATION_AMBIGUOUS"] : [];
  let envelope: AtlasEnvelope<SearchAtlasData>;
  try {
    envelope = atlasSuccess(
      "search_atlas",
      status,
      searchAtlasDataSchema.parse(data),
      coverageFor(data),
      warnings,
    );
  } catch (error) {
    return atlasFailure(
      "search_atlas",
      "INVALID_INPUT",
      safeMessage(error instanceof Error ? error.message : String(error), cache.rootDir),
      false,
    );
  }
  // Keep the envelope schema and the data schema coupled: a response that
  // cannot round-trip is an internal error, never a success-shaped payload.
  const parsed = searchAtlasEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    return atlasFailure(
      "search_atlas",
      "INVALID_INPUT",
      "Atlas search produced an invalid response",
      false,
    );
  }
  return envelope;
}
