import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AtlasCaptureAttempt } from "./live-types.js";

export interface HeldoutSectionReview {
  captureKey: string;
  viewport: string;
  selector: string;
  nodeKey: string;
  regionKey: string;
  rect: { x: number; y: number; width: number; height: number };
  screenshotKeys: string[];
  candidateLabels: string[];
  acceptedLabels: string[];
  /** Human reviewers fill this in after inspecting the evidence. */
  humanLabels: string[];
  reviewed: boolean;
}

export interface HeldoutArtifact {
  key: string;
  kind: string;
  storagePath: string;
  sha256: string;
  bytes: number;
}

export interface HeldoutReview {
  schemaVersion: "awwwards-atlas-heldout-review-v1";
  captureKey: string;
  capturedAt: number;
  siteSlug: string;
  requestedUrl: string;
  status: string;
  limitations: string[];
  error: string | null;
  coverage: { status: string; collected: number; excluded: number; limitations: string[] };
  artifacts: HeldoutArtifact[];
  sections: HeldoutSectionReview[];
}

export interface HeldoutScore {
  class: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  support: number;
  precision: number;
  recall: number;
}

export function buildHeldoutReview(attempt: AtlasCaptureAttempt): HeldoutReview {
  const sections: HeldoutSectionReview[] = [];
  for (const viewport of attempt.viewports) {
    for (const region of viewport.regions) {
      const claims = viewport.claims.filter((claim) => claim.regionKey === region.key);
      sections.push({
        captureKey: attempt.attemptId,
        viewport: viewport.viewport,
        selector: region.selector,
        nodeKey: region.nodeKey,
        regionKey: region.key,
        rect: region.rect,
        screenshotKeys: viewport.screenshots.map((shot) => shot.key),
        candidateLabels: [
          ...new Set(
            claims
              .filter((claim) => claim.decision === "candidate")
              .map((claim) => claim.value),
          ),
        ].sort(),
        acceptedLabels: [
          ...new Set(
            claims
              .filter((claim) => claim.decision === "accepted")
              .map((claim) => claim.value),
          ),
        ].sort(),
        humanLabels: [],
        reviewed: false,
      });
    }
  }
  return {
    schemaVersion: "awwwards-atlas-heldout-review-v1",
    captureKey: attempt.attemptId,
    capturedAt: attempt.finishedAt,
    siteSlug: attempt.target.siteSlug,
    requestedUrl: attempt.target.requestedUrl,
    status: attempt.status,
    limitations: attempt.limitations,
    error: attempt.error ?? null,
    coverage: attempt.coverage,
    artifacts: attempt.artifacts.map((artifact) => ({
      key: artifact.key,
      kind: artifact.kind,
      storagePath: artifact.storagePath,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    })),
    sections,
  };
}

export function writeHeldoutReview(review: HeldoutReview, outDir: string): string {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const target = join(outDir, "review.json");
  writeFileSync(target, JSON.stringify(review, null, 2), { mode: 0o600 });
  return target;
}

/** Labels are keyed by capture, viewport and unique region identity. */
export type HeldoutHumanLabels = Record<string, string[]>;

export function heldoutKey(section: HeldoutSectionReview): string {
  return `${section.captureKey}|${section.viewport}|${section.regionKey}`;
}

export class HeldoutReviewError extends Error {
  constructor(
    readonly code: "HELDOUT_UNREVIEWED" | "HELDOUT_UNKNOWN_LABEL_KEY" | "HELDOUT_DUPLICATE_KEY",
    message: string,
  ) {
    super(message);
    this.name = "HeldoutReviewError";
  }
}

export interface HeldoutMetrics {
  perClass: HeldoutScore[];
  macroPrecision: number;
  macroRecall: number;
}

function metricsFor(
  review: HeldoutReview,
  labels: HeldoutHumanLabels,
  selector: (section: HeldoutSectionReview) => string[],
): HeldoutMetrics {
  const classes = new Set<string>();
  for (const section of review.sections) {
    for (const value of section.humanLabels) classes.add(value);
    for (const value of selector(section)) classes.add(value);
  }
  for (const values of Object.values(labels)) for (const value of values) classes.add(value);
  const perClass: HeldoutScore[] = [];
  for (const value of [...classes].sort()) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const section of review.sections) {
      const truth = new Set(labels[heldoutKey(section)] ?? section.humanLabels);
      const predicted = new Set(selector(section));
      if (truth.has(value) && predicted.has(value)) tp += 1;
      else if (!truth.has(value) && predicted.has(value)) fp += 1;
      else if (truth.has(value) && !predicted.has(value)) fn += 1;
    }
    perClass.push({
      class: value,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      support: tp + fn,
      precision: tp / Math.max(1, tp + fp),
      recall: tp / Math.max(1, tp + fn),
    });
  }
  return {
    perClass,
    macroPrecision:
      perClass.reduce((sum, item) => sum + item.precision, 0) / Math.max(1, perClass.length),
    macroRecall:
      perClass.reduce((sum, item) => sum + item.recall, 0) / Math.max(1, perClass.length),
  };
}

export function scoreHeldout(
  review: HeldoutReview,
  labels: HeldoutHumanLabels,
): HeldoutMetrics & { accepted: HeldoutMetrics; abstainedSections: number } {
  if (review.sections.some((section) => !section.reviewed)) {
    throw new HeldoutReviewError(
      "HELDOUT_UNREVIEWED",
      "Every section must be explicitly marked reviewed before scoring",
    );
  }
  const known = new Set(review.sections.map(heldoutKey));
  if (known.size !== review.sections.length) {
    throw new HeldoutReviewError(
      "HELDOUT_DUPLICATE_KEY",
      "Duplicate capture/viewport/region keys in review",
    );
  }
  const unknown = Object.keys(labels).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new HeldoutReviewError(
      "HELDOUT_UNKNOWN_LABEL_KEY",
      `Unknown annotation keys: ${unknown.join(", ")}`,
    );
  }
  const candidate = metricsFor(review, labels, (section) => section.candidateLabels);
  const accepted = metricsFor(review, labels, (section) => section.acceptedLabels);
  const abstainedSections = review.sections.filter(
    (section) => section.candidateLabels.length === 0 && section.acceptedLabels.length === 0,
  ).length;
  return { ...candidate, accepted, abstainedSections };
}
