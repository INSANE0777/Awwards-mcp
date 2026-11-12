import { readFileSync } from "node:fs";
import { Cache } from "../cache.js";
import { AtlasCollectionError, collectAtlasPage } from "./collector.js";
import {
  buildHeldoutComponentReview,
  buildHeldoutReview,
  HeldoutComponentError,
  loadHeldoutComponentCorpus,
  loadHeldoutComponentLabelsFile,
  loadHeldoutComponentReviewFile,
  scoreHeldout,
  scoreHeldoutComponentCorpus,
  scoreHeldoutComponents,
  writeHeldoutComponentReview,
  writeHeldoutReview,
} from "./heldout.js";
import type { HeldoutHumanLabels, HeldoutReview } from "./heldout.js";

const [, , command, ...args] = process.argv;

/** One typed line on stderr, no stack trace and no raw filesystem error text. */
function fail(error: unknown): never {
  if (error instanceof HeldoutComponentError || error instanceof AtlasCollectionError) {
    const message = error.message.replace(/\r\n|\r|\n/g, " ").trim();
    process.stderr.write(`${error.code}: ${message}\n`);
  } else {
    process.stderr.write("HELDOUT_COMPONENT_FAILED: unexpected error\n");
  }
  process.exit(1);
}

if (command === "score") {
  const [reviewPath, labelsPath] = args;
  if (!reviewPath || !labelsPath) {
    process.stderr.write("usage: atlas-heldout-review score <review.json> <labels.json>\n");
    process.exit(2);
  }
  const review = JSON.parse(readFileSync(reviewPath, "utf8")) as HeldoutReview;
  const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as HeldoutHumanLabels;
  process.stdout.write(`${JSON.stringify(scoreHeldout(review, labels), null, 2)}\n`);
} else if (command === "score-components") {
  const [reviewPath, labelsPath] = args;
  if (!reviewPath || !labelsPath) {
    process.stderr.write(
      "usage: atlas-heldout-review score-components <components-review-full.json> <component-labels.json>\n",
    );
    process.exit(2);
  }
  try {
    const review = loadHeldoutComponentReviewFile(reviewPath);
    const labels = loadHeldoutComponentLabelsFile(labelsPath);
    process.stdout.write(`${JSON.stringify(scoreHeldoutComponents(review, labels), null, 2)}\n`);
  } catch (error) {
    fail(error);
  }
} else if (command === "score-components-corpus") {
  const [outRoot] = args;
  if (!outRoot) {
    process.stderr.write(
      "usage: atlas-heldout-review score-components-corpus <outRoot>\n",
    );
    process.exit(2);
  }
  try {
    const { reviews, labels } = loadHeldoutComponentCorpus(outRoot);
    process.stdout.write(`${JSON.stringify(scoreHeldoutComponentCorpus(reviews, labels), null, 2)}\n`);
  } catch (error) {
    fail(error);
  }
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
} else if (command === "collect-components") {
  const [cacheRoot, siteSlug, outDir] = args;
  if (!cacheRoot || !siteSlug || !outDir) {
    process.stderr.write(
      "usage: atlas-heldout-review collect-components <cacheRoot> <siteSlug> <outDir>\n",
    );
    process.exit(2);
  }
  try {
    const cache = new Cache(cacheRoot, () => Date.now(), { atlas: true });
    const attempt = await collectAtlasPage({ siteSlug, components: true }, { cache });
    const review = buildHeldoutComponentReview(attempt);
    const files = writeHeldoutComponentReview(review, outDir);
    process.stdout.write(`${JSON.stringify(files, null, 2)}\n`);
  } catch (error) {
    fail(error);
  }
} else {
  process.stderr.write(
    "usage: atlas-heldout-review collect|collect-components <cacheRoot> <siteSlug> <outDir> | " +
      "score|score-components <review.json> <labels.json> | score-components-corpus <outRoot>\n",
  );
  process.exit(2);
}
