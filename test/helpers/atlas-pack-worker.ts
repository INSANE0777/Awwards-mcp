import { readFileSync } from "node:fs";
import { Cache } from "../../src/cache.js";
import { buildEvidencePack } from "../../src/atlas/evidence-pack.js";

const [root, inputPath, nowRaw] = process.argv.slice(2);
if (!root || !inputPath || !nowRaw) {
  throw new Error("usage: atlas-pack-worker <root> <input.json> <now>");
}
const input = JSON.parse(readFileSync(inputPath, "utf8")) as Parameters<typeof buildEvidencePack>[0];
const now = Number(nowRaw);
const cache = new Cache(root, () => now, { atlas: true });
const result = await buildEvidencePack(input, { cache, now: () => now });
process.stdout.write(
  JSON.stringify({
    packId: result.packId,
    cached: result.cached,
    manifestHash: result.manifestHash,
    files: result.files.length,
  }),
);
