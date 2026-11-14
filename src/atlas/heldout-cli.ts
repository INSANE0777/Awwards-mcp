import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Cache } from "../cache.js";
import { sha256Text } from "./identity.js";
import { AtlasCollectionError, collectAtlasPage } from "./collector.js";
import {
  attestHeldoutComponentCorpus,
  buildHeldoutComponentReview,
  buildHeldoutReview,
  HeldoutComponentError,
  loadHeldoutComponentCorpus,
  loadHeldoutComponentLabelsFile,
  loadHeldoutComponentReviewFile,
  loadHeldoutProvenanceAttestationFile,
  loadHeldoutProvenanceFile,
  scoreHeldout,
  scoreHeldoutComponentCorpus,
  scoreHeldoutComponents,
  verifyHeldoutComponentProvenance,
  writeHeldoutComponentReview,
  writeHeldoutProvenance,
  writeHeldoutReview,
} from "./heldout.js";
import type {
  HeldoutComponentCorpusPage,
  HeldoutComponentProvenanceSummary,
  HeldoutComponentReport,
  HeldoutComponentReview,
  HeldoutHumanLabels,
  HeldoutProvenanceCheck,
  HeldoutProvenanceManifest,
  HeldoutReview,
} from "./heldout.js";

const [, , command, ...args] = process.argv;

/** Exit pins: usage 2, invalid input 1, numerical gate 3, provenance 4. */
const EXIT_INVALID = 1;
const EXIT_USAGE = 2;
const EXIT_GATE = 3;
const EXIT_PROVENANCE = 4;

const SCORE_USAGE =
  "usage: atlas-heldout-review score-components <components-review-full.json> <component-labels.json> [--provenance <provenance.json>] [--require-pass]\n";
const CORPUS_USAGE =
  "usage: atlas-heldout-review score-components-corpus <outRoot> [--provenance <provenance.json>] [--require-pass]\n";
const ATTEST_USAGE =
  "usage: atlas-heldout-review attest-components <outRoot> <attestation.json>\n";

/** One typed line on stderr, no stack trace and no raw filesystem error text. */
function fail(error: unknown): never {
  if (error instanceof HeldoutComponentError || error instanceof AtlasCollectionError) {
    const message = error.message.replace(/\r\n|\r|\n/g, " ").trim();
    process.stderr.write(`${error.code}: ${message}\n`);
  } else {
    process.stderr.write("HELDOUT_COMPONENT_FAILED: unexpected error\n");
  }
  process.exit(EXIT_INVALID);
}

function usage(message: string): never {
  process.stderr.write(message);
  process.exit(EXIT_USAGE);
}

function oneLine(message: string): string {
  return message.replace(/\r\n|\r|\n/g, " ").trim();
}

interface ComponentScoreArgs {
  positional: string[];
  requirePass: boolean;
  provenancePath: string | null;
}

function parseComponentScoreArgs(args: string[], usageText: string): ComponentScoreArgs {
  const positional: string[] = [];
  let requirePass = false;
  let provenancePath: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--require-pass") {
      requirePass = true;
    } else if (arg === "--provenance") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) usage(usageText);
      provenancePath = value;
      index += 1;
    } else if (arg.startsWith("-")) {
      usage(usageText);
    } else {
      positional.push(arg);
    }
  }
  return { positional, requirePass, provenancePath };
}

function provenanceSummary(
  manifest: HeldoutProvenanceManifest,
  check: HeldoutProvenanceCheck,
): HeldoutComponentProvenanceSummary {
  return {
    kind: manifest.provenance,
    qualifying: check.qualifying,
    reasons: check.reasons,
    reviewers: manifest.reviewers.map((reviewer) => reviewer.id),
    declaredTypes: manifest.declaredTypes,
    datasetSplit: manifest.datasetSplit,
    rulesVersion: manifest.rulesVersion,
    rulesHash: manifest.rulesHash,
    corpusHash: manifest.corpusHash,
    pages: manifest.pages.length,
  };
}

function absentProvenance(): HeldoutComponentProvenanceSummary {
  return {
    kind: "absent",
    qualifying: false,
    reasons: ["PROVENANCE_MISSING"],
    reviewers: [],
    declaredTypes: [],
    datasetSplit: null,
    rulesVersion: null,
    rulesHash: null,
    corpusHash: null,
    pages: 0,
  };
}

/**
 * Prints the numerical report, then applies the optional strict gate. The
 * report and the provenance are separate facts: a passing score with model or
 * stale evidence still exits nonzero under --require-pass.
 */
function finishComponentScore(
  report: HeldoutComponentReport,
  manifest: HeldoutProvenanceManifest | null,
  check: HeldoutProvenanceCheck | null,
  requirePass: boolean,
  missingMessage: string,
): void {
  if (manifest && check) report.provenance = provenanceSummary(manifest, check);
  else if (requirePass) report.provenance = absentProvenance();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!requirePass) return;
  // Let the process end naturally so piped stdout/stderr flush completely.
  if (!manifest || !check) {
    process.stderr.write(`HELDOUT_COMPONENT_PROVENANCE_MISSING: ${oneLine(missingMessage)}\n`);
    process.exitCode = EXIT_PROVENANCE;
    return;
  }
  if (!check.qualifying) {
    process.stderr.write(
      `HELDOUT_COMPONENT_PROVENANCE_INVALID: ${oneLine(check.reasons.join("; "))}\n`,
    );
    process.exitCode = EXIT_PROVENANCE;
    return;
  }
  if (report.gate !== "pass") process.exitCode = EXIT_GATE;
}

/** Single-review strict mode is bound to the page directory holding the review. */
function singlePageBinding(
  reviewPath: string,
  labelsPath: string,
  review: HeldoutComponentReview,
): HeldoutComponentCorpusPage {
  const root = dirname(reviewPath);
  const blindPath = join(root, "components-review.json");
  return {
    page: basename(root),
    reviewSha256: sha256Text(readFileSync(reviewPath, "utf8")),
    blindSha256: existsSync(blindPath) ? sha256Text(readFileSync(blindPath, "utf8")) : null,
    labelsSha256: sha256Text(readFileSync(labelsPath, "utf8")),
    review,
  };
}

if (command === "score") {
  const [reviewPath, labelsPath] = args;
  if (!reviewPath || !labelsPath) {
    process.stderr.write("usage: atlas-heldout-review score <review.json> <labels.json>\n");
    process.exit(EXIT_USAGE);
  }
  const review = JSON.parse(readFileSync(reviewPath, "utf8")) as HeldoutReview;
  const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as HeldoutHumanLabels;
  process.stdout.write(`${JSON.stringify(scoreHeldout(review, labels), null, 2)}\n`);
} else if (command === "score-components") {
  const parsed = parseComponentScoreArgs(args, SCORE_USAGE);
  if (parsed.positional.length !== 2) usage(SCORE_USAGE);
  try {
    const [reviewPath, labelsPath] = parsed.positional as [string, string];
    const review = loadHeldoutComponentReviewFile(reviewPath);
    const labels = loadHeldoutComponentLabelsFile(labelsPath);
    const manifest = parsed.provenancePath
      ? loadHeldoutProvenanceFile(parsed.provenancePath)
      : null;
    const report = scoreHeldoutComponents(
      review,
      labels,
      manifest ? { declaredTypes: manifest.declaredTypes } : undefined,
    );
    // Strict single-review mode requires the canonical <outRoot>/<page>/ layout
    // so the manifest page can be located and re-derived.
    const check = manifest
      ? verifyHeldoutComponentProvenance(manifest, dirname(dirname(reviewPath)), [
          singlePageBinding(reviewPath, labelsPath, review),
        ])
      : null;
    finishComponentScore(
      report,
      manifest,
      check,
      parsed.requirePass,
      "single-review strict mode requires --provenance <provenance.json>",
    );
  } catch (error) {
    fail(error);
  }
} else if (command === "score-components-corpus") {
  const parsed = parseComponentScoreArgs(args, CORPUS_USAGE);
  if (parsed.positional.length !== 1) usage(CORPUS_USAGE);
  try {
    const [outRoot] = parsed.positional as [string];
    const corpus = loadHeldoutComponentCorpus(outRoot);
    const defaultManifest = join(outRoot, "provenance.json");
    const manifestPath = parsed.provenancePath ?? (parsed.requirePass ? defaultManifest : null);
    let manifest: HeldoutProvenanceManifest | null = null;
    if (manifestPath !== null) {
      if (existsSync(manifestPath)) {
        manifest = loadHeldoutProvenanceFile(manifestPath);
      } else if (parsed.provenancePath) {
        throw new HeldoutComponentError(
          "HELDOUT_COMPONENT_INVALID_PROVENANCE",
          `Cannot read provenance manifest: ${manifestPath}`,
        );
      }
    }
    const report = scoreHeldoutComponentCorpus(
      corpus.reviews,
      corpus.labels,
      manifest ? { declaredTypes: manifest.declaredTypes } : undefined,
    );
    const check = manifest
      ? verifyHeldoutComponentProvenance(manifest, outRoot, corpus.pages)
      : null;
    finishComponentScore(
      report,
      manifest,
      check,
      parsed.requirePass,
      `no provenance manifest at ${defaultManifest}`,
    );
  } catch (error) {
    fail(error);
  }
} else if (command === "attest-components") {
  const [outRoot, attestationPath] = args;
  if (!outRoot || !attestationPath || args.length !== 2) usage(ATTEST_USAGE);
  try {
    const attestation = loadHeldoutProvenanceAttestationFile(attestationPath);
    const manifest = attestHeldoutComponentCorpus(outRoot, attestation);
    const path = writeHeldoutProvenance(manifest, outRoot);
    process.stdout.write(
      `${JSON.stringify(
        {
          manifest: path,
          corpusHash: manifest.corpusHash,
          rulesVersion: manifest.rulesVersion,
          rulesHash: manifest.rulesHash,
          pages: manifest.pages.length,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    fail(error);
  }
} else if (command === "collect") {
  const [cacheRoot, siteSlug, outDir] = args;
  if (!cacheRoot || !siteSlug || !outDir) {
    process.stderr.write(
      "usage: atlas-heldout-review collect <cacheRoot> <siteSlug> <outDir>\n",
    );
    process.exit(EXIT_USAGE);
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
    process.exit(EXIT_USAGE);
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
      "attest-components <outRoot> <attestation.json> | " +
      "score|score-components|score-components-corpus ... [--provenance <provenance.json>] [--require-pass]\n",
  );
  process.exit(EXIT_USAGE);
}
