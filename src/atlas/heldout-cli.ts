import { readFileSync } from "node:fs";
import { Cache } from "../cache.js";
import { collectAtlasPage } from "./collector.js";
import { buildHeldoutReview, scoreHeldout, writeHeldoutReview } from "./heldout.js";
import type { HeldoutHumanLabels, HeldoutReview } from "./heldout.js";

const [, , command, ...args] = process.argv;

if (command === "score") {
  const [reviewPath, labelsPath] = args;
  if (!reviewPath || !labelsPath) {
    process.stderr.write("usage: atlas-heldout-review score <review.json> <labels.json>\n");
    process.exit(2);
  }
  const review = JSON.parse(readFileSync(reviewPath, "utf8")) as HeldoutReview;
  const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as HeldoutHumanLabels;
  process.stdout.write(`${JSON.stringify(scoreHeldout(review, labels), null, 2)}\n`);
} else if (command === "collect") {
  const [cacheRoot, siteSlug, outDir] = args;
  if (!cacheRoot || !siteSlug || !outDir) {
    process.stderr.write(
      "usage: atlas-heldout-review collect <cacheRoot> <siteSlug> <outDir>\n",
    );
    process.exit(2);
  }
  const cache = new Cache(cacheRoot, () => Date.now(), { atlas: true });
  const attempt = await collectAtlasPage({ siteSlug }, { cache });
  const review = buildHeldoutReview(attempt);
  process.stdout.write(`${writeHeldoutReview(review, outDir)}\n`);
} else {
  process.stderr.write(
    "usage: atlas-heldout-review collect <cacheRoot> <siteSlug> <outDir> | score <review.json> <labels.json>\n",
  );
  process.exit(2);
}
