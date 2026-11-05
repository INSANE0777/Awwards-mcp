#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { AwwwardsClient } from "./awwwards.js";
import { Cache } from "./cache.js";
import { importLegacyAtlas } from "./atlas/import.js";
import { parseAtlasCliArgs } from "./atlas/cli.js";
import { runIndexer, IndexLockError } from "./indexer.js";

// --atlas is validated and dispatched before any cache/client construction.
const atlasCommand = parseAtlasCliArgs(process.argv.slice(2));
if (atlasCommand?.kind === "error") {
  console.error(`awwwards-index: ${atlasCommand.message}`);
  process.exit(2);
}
if (atlasCommand?.kind === "import") {
  if (process.env.AWWWARDS_MCP_ATLAS !== "1") {
    console.error(
      "awwwards-index: --atlas import requires AWWWARDS_MCP_ATLAS=1; no cache or network access was used.",
    );
    process.exit(2);
  }
  const atlasRoot = process.env.AWWWARDS_CACHE_DIR ?? join(homedir(), ".awwwards-mcp");
  let atlasCache: Cache;
  try {
    atlasCache = new Cache(atlasRoot);
  } catch (err) {
    console.error(
      `awwwards-index: cannot initialize cache at ${atlasRoot}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  const report = await importLegacyAtlas(atlasCache);
  console.error(
    `awwwards-index: atlas import — ${report.processed} processed ` +
      `(${report.sitePages} site pages, ${report.galleryItems} gallery items), ` +
      `${report.published} published, ${report.unpublished} unpublished, ` +
      `${report.failures.length} failures`,
  );
  for (const failure of report.failures) {
    console.error(`awwwards-index: ${failure.slug}: ${failure.error}`);
  }
  process.exit(report.failures.length > 0 ? 1 : 0);
}

// npm run index              — sites crawl (default)
// The --elements gallery crawl is retired: robots.txt disallows /elements/*.
// new_winners backfills elements from each new winner's own site page.
const elementsRequested = process.argv.some(
  (arg) => arg === "--elements" || arg.startsWith("--elements="),
);
if (elementsRequested) {
  console.error(
    "awwwards-index: --elements is retired — robots.txt disallows /elements/*, so the element gallery crawl is disabled. " +
      "The winners poll now backfills elements from each new winner's own site page; cached gallery records stay searchable.",
  );
  process.exit(2);
}

const cacheRoot = process.env.AWWWARDS_CACHE_DIR ?? join(homedir(), ".awwwards-mcp");
let cache: Cache;
try {
  cache = new Cache(cacheRoot);
} catch (err) {
  console.error(`awwwards-index: cannot initialize cache at ${cacheRoot}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const client = new AwwwardsClient();
try {
  const result = await runIndexer({ client, cache, log: (m) => console.error(m) });
  console.error(
    `awwwards-index: done — ${result.pagesDone} pages crawled, ${result.skipped} skipped, ` +
      `${result.sitesIndexed} site rows upserted (${result.pagesTotal} tags total)`,
  );
  process.exit(0);
} catch (err) {
  if (err instanceof IndexLockError) {
    console.error(`awwwards-index: ${err.message}`);
    process.exit(0);
  }
  console.error(`awwwards-index aborted: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
