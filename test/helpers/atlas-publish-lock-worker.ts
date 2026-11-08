import { Cache } from "../../src/cache.js";
import { bumpAtlasRevision } from "../../src/atlas/search-projections.js";

const [root, holdRaw] = process.argv.slice(2);
if (!root || !holdRaw) throw new Error("usage: atlas-publish-lock-worker <root> <holdMs>");
const holdMs = Number(holdRaw);

const cache = new Cache(root, () => Date.now(), { atlas: true });
cache.withAtlasDb((db) => {
  db.exec("BEGIN IMMEDIATE");
  process.stdout.write("BEGIN\n");
  const end = Date.now() + holdMs;
  while (Date.now() < end) {
    /* hold the write transaction for the full publish budget */
  }
  bumpAtlasRevision(db, Date.now());
  db.exec("COMMIT");
});
process.stdout.write("COMMITTED\n");
