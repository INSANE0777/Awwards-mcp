// Public Phase 6A operation facade: envelope in, MCP ToolResponse out.
import type { Cache } from "../cache.js";
import type { ToolResponse } from "../server/types.js";
import { text } from "../server/types.js";
import type { GetAtlasInput } from "./tool-contracts.js";
import type { AtlasEnvelope } from "./tool-contracts.js";
import { atlasFailure } from "./tool-envelope.js";
import { runAtlasHighlight, runAtlasRegion, runAtlasStatus, runAtlasTaxonomy } from "./tool-read.js";
import { runAtlasSearch } from "./tool-search.js";
import { runAtlasCapture } from "./tool-capture.js";
import { runAtlasExport } from "./tool-export.js";

export function runGetAtlas(
  cache: Cache,
  input: GetAtlasInput,
  now: number,
): AtlasEnvelope<unknown> {
  if (!cache.atlas) {
    return atlasFailure(
      "get_atlas",
      "FEATURE_DISABLED",
      "Atlas retrieval requires AWWWARDS_MCP_ATLAS=1",
      false,
    );
  }
  switch (input.kind) {
    case "status":
      return runAtlasStatus(cache, now);
    case "taxonomy":
      return runAtlasTaxonomy();
    case "region":
      return runAtlasRegion(cache, input.regionId);
    case "highlight":
      return runAtlasHighlight(cache, input.elementId);
    default: {
      const exhaustive: never = input;
      return atlasFailure("get_atlas", "INVALID_INPUT", `Unhandled kind: ${String(exhaustive)}`, false);
    }
  }
}

/** MCP behavior from spec 5.6: errors are isError with no success payload. */
export function atlasToolResponse(envelope: AtlasEnvelope<unknown>): ToolResponse {
  const serialized = JSON.stringify(envelope);
  if (envelope.status === "blocked" || envelope.status === "error") {
    return { content: [text(serialized)], isError: true };
  }
  return { content: [text(serialized)], structuredContent: envelope as unknown as Record<string, unknown> };
}

export { runAtlasSearch, runAtlasCapture, runAtlasExport };
