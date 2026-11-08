import { Cache } from "../../src/cache.js";
import { atlasSearchStore, searchAtlas } from "../../src/atlas/search.js";

const [root, asOfRaw] = process.argv.slice(2);
if (!root || !asOfRaw) throw new Error("usage: atlas-search-worker <root> <asOf>");
const asOf = Number(asOfRaw);

// A search-only process: constructing the cache must not run schema DDL,
// migrations or any write, so a publisher holding the lock cannot block it.
const openStarted = performance.now();
const cache = new Cache(root, () => Date.now(), { atlas: true, readOnly: true });
const openMs = performance.now() - openStarted;

const searchStarted = performance.now();
const result = searchAtlas({ kind: "sections" }, atlasSearchStore(cache), asOf);
const searchMs = performance.now() - searchStarted;

process.stdout.write(
  JSON.stringify(
    result.ok
      ? { openMs, searchMs, ok: true, revision: result.data.revision, total: result.data.total }
      : {
          openMs,
          searchMs,
          ok: false,
          code: result.error.code,
          retryable: result.error.retryable,
          message: result.error.message,
        },
  ),
);
