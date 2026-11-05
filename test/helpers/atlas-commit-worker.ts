import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Cache } from "../../src/cache.js";
import { prepareSitePage } from "../../src/atlas/ingest.js";
import { AtlasStore } from "../../src/atlas/store.js";

const [root, fetchedAtRaw] = process.argv.slice(2);
if (!root || !fetchedAtRaw) throw new Error("usage: atlas-commit-worker <root> <fetchedAt>");
const fetchedAt = Number(fetchedAtRaw);
const html = readFileSync(join("test", "fixtures", "detail.html"), "utf8");
const cache = new Cache(root, () => fetchedAt, { atlas: true });
const prepared = prepareSitePage({
  slug: "cross-process",
  html,
  fetchedAt,
  sourceUrl: "https://www.awwwards.com/sites/cross-process",
  summary: null,
});
const result = await new AtlasStore(cache, { now: () => fetchedAt }).commitSitePage(prepared);
process.stdout.write(JSON.stringify(result));
