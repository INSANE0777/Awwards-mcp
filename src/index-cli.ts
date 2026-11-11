#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { AwwwardsClient } from "./awwwards.js";
import { Cache } from "./cache.js";
import { parseAtlasCliArgs } from "./atlas/cli.js";
import { redactCachePath, runAtlasCommand } from "./atlas/cli-run.js";
import { runIndexer, IndexLockError } from "./indexer.js";

// --atlas is validated and dispatched before any cache/client construction.
const atlasCommand = parseAtlasCliArgs(process.argv.slice(2));
if (atlasCommand) {
  if (atlasCommand.kind === "error") {
    console.error(`awwwards-index: ${atlasCommand.message}`);
    process.exit(2);
  }
  if (process.env.AWWWARDS_MCP_ATLAS !== "1") {
    console.error(
      `awwwards-index: --atlas ${atlasCommand.kind} requires AWWWARDS_MCP_ATLAS=1; no cache or network access was used.`,
    );
    process.exit(2);
  }
  const atlasRoot = process.env.AWWWARDS_CACHE_DIR ?? join(homedir(), ".awwwards-mcp");
  let atlasCache: Cache;
  try {
    atlasCache = new Cache(atlasRoot, Date.now, {
      atlas: true,
      ...(atlasCommand.kind === "verify" ? { readOnly: true } : {}),
    });
  } catch (err) {
    const detail = redactCachePath(
      err instanceof Error ? err.message : String(err),
      atlasRoot,
    );
    console.error(`awwwards-index: cannot initialize the Atlas cache: ${detail}`);
    process.exit(1);
  }
  const code = await runAtlasCommand(atlasCommand, {
    cache: atlasCache,
    log: (line) => console.error(line),
  });
  process.exit(code);
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
