import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { AtlasCaptureAttempt } from "./live-types.js";
import { ATLAS_INFERRED_COMPONENT_TYPES } from "./components.js";
import { ATLAS_VOCABULARY } from "./vocabulary.js";

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

/** Human labels for F9: exactly one native/declared type, or none/ambiguous. */
export const HELDOUT_COMPONENT_LABELS = [
  ...new Set([
    ...ATLAS_VOCABULARY.filter(
      (entry) =>
        entry.field === "component.type" &&
        entry.support === "supported" &&
        !(ATLAS_INFERRED_COMPONENT_TYPES as readonly string[]).includes(entry.value),
    ).map((entry) => entry.value),
    "none",
    "ambiguous",
  ]),
].sort();

const HELDOUT_COMPONENT_LABEL_SET = new Set(HELDOUT_COMPONENT_LABELS);

export interface HeldoutComponentRow {
  captureKey: string;
  viewport: string;
  selector: string;
  nodeKey: string;
  regionKey: string;
  tag: string;
  role: string | null;
  accessibleName: string;
  sectionHeading: string | null;
  rect: { x: number; y: number; width: number; height: number };
  screenshotKeys: string[];
  inputType: string | null;
  ariaHasPopup: boolean;
  ariaExpanded: string | null;
  ariaControlsResolved: boolean;
  inNavigation: boolean;
  /** Needed to reproduce the nav breadcrumb/pagination classification. */
  ariaLabel: string | null;
  candidateTypes: string[];
  acceptedTypes: string[];
  typeBasis: string;
  typeClassification: "observed" | "inferred";
  typeDecision: "accepted" | "candidate";
}

export interface HeldoutComponentReview {
  schemaVersion: "awwwards-atlas-component-review-v1";
  captureKey: string;
  capturedAt: number;
  siteSlug: string;
  requestedUrl: string;
  status: string;
  limitations: string[];
  error: string | null;
  coverage: { status: string; collected: number; excluded: number; limitations: string[] };
  components: HeldoutComponentRow[];
}

export interface HeldoutComponentBlindRow {
  key: string;
  selector: string;
  tag: string;
  role: string | null;
  accessibleName: string;
  sectionHeading: string | null;
  rect: { x: number; y: number; width: number; height: number };
  screenshotKeys: string[];
  inputType: string | null;
  ariaHasPopup: boolean;
  ariaExpanded: string | null;
  ariaControlsResolved: boolean;
  inNavigation: boolean;
  ariaLabel: string | null;
}

export interface HeldoutComponentBlindReview {
  schemaVersion: "awwwards-atlas-component-blind-v1";
  acceptedOnly: true;
  captureKey: string;
  capturedAt: number;
  siteSlug: string;
  requestedUrl: string;
  components: HeldoutComponentBlindRow[];
}

/**
 * Labels are keyed by capture, viewport and DOM node identity. `nodeKey` is a
 * per-scan node id and carries no predicted type, unlike `regionKey` which
 * hashes the type and would leak the prediction to the labeler.
 */
export function componentHeldoutKey(
  row: Pick<HeldoutComponentRow, "captureKey" | "viewport" | "nodeKey">,
): string {
  return `${row.captureKey}|${row.viewport}|${row.nodeKey}`;
}

/**
 * Single definition of the F9 measurement population: accepted, observed,
 * native/declared rows with exactly one real type. The blind export and the
 * scorer both use it so they cannot drift.
 */
export function isScorableAcceptedComponent(
  row: Pick<
    HeldoutComponentRow,
    "typeDecision" | "typeClassification" | "typeBasis" | "acceptedTypes"
  >,
): boolean {
  if (
    row.typeDecision !== "accepted" ||
    row.typeClassification !== "observed" ||
    (row.typeBasis !== "native_semantics" && row.typeBasis !== "declared_aria") ||
    !Array.isArray(row.acceptedTypes) ||
    row.acceptedTypes.length !== 1
  ) {
    return false;
  }
  const predicted = row.acceptedTypes[0];
  return (
    typeof predicted === "string" &&
    predicted !== "none" &&
    predicted !== "ambiguous" &&
    HELDOUT_COMPONENT_LABEL_SET.has(predicted)
  );
}

export function buildHeldoutComponentReview(
  attempt: AtlasCaptureAttempt,
): HeldoutComponentReview {
  const components: HeldoutComponentRow[] = [];
  for (const viewport of attempt.viewports) {
    const sections = new Map(viewport.regions.map((region) => [region.nodeKey, region]));
    for (const component of viewport.components ?? []) {
      const claims = viewport.claims.filter(
        (claim) =>
          claim.regionKey === component.key &&
          claim.field === "component.type" &&
          (claim.state ?? "default") === "default",
      );
      const section = component.sectionNodeKey
        ? sections.get(component.sectionNodeKey)
        : undefined;
      components.push({
        captureKey: attempt.attemptId,
        viewport: viewport.viewport,
        selector: component.selector,
        nodeKey: component.nodeKey,
        regionKey: component.key,
        tag: component.tag,
        role: component.role,
        accessibleName: component.label,
        sectionHeading: section?.heading ?? null,
        rect: component.rect,
        screenshotKeys: viewport.screenshots.map((shot) => shot.key),
        inputType: component.inputType ?? null,
        ariaHasPopup: component.ariaHasPopup === true,
        ariaExpanded: component.ariaExpanded ?? null,
        ariaControlsResolved: component.ariaControlsResolved === true,
        inNavigation: component.inNavigation === true,
        ariaLabel: component.ariaLabel ?? null,
        candidateTypes: [
          ...new Set(
            claims
              .filter((claim) => claim.decision === "candidate")
              .map((claim) => claim.value),
          ),
        ].sort(),
        acceptedTypes: [
          ...new Set(
            claims
              .filter((claim) => claim.decision === "accepted")
              .map((claim) => claim.value),
          ),
        ].sort(),
        typeBasis: component.typeBasis,
        typeClassification: component.typeClassification,
        typeDecision: component.typeDecision,
      });
    }
  }
  return {
    schemaVersion: "awwwards-atlas-component-review-v1",
    captureKey: attempt.attemptId,
    capturedAt: attempt.finishedAt,
    siteSlug: attempt.target.siteSlug,
    requestedUrl: attempt.target.requestedUrl,
    status: attempt.status,
    limitations: attempt.limitations,
    error: attempt.error ?? null,
    coverage: attempt.coverage,
    components,
  };
}

export interface HeldoutComponentFiles {
  full: string;
  blind: string;
  labels: string;
}

/**
 * Writes three files: the full review (with predictions), the blind review a
 * labeler may see, and a labels map keyed by capture|viewport|nodeKey. An
 * existing labels file is never overwritten, so re-collecting a page keeps
 * human work.
 */
export function writeHeldoutComponentReview(
  review: HeldoutComponentReview,
  outDir: string,
): HeldoutComponentFiles {
  const seen = new Set<string>();
  for (const row of review.components) {
    const key = componentHeldoutKey(row);
    if (seen.has(key)) {
      throw new HeldoutComponentError(
        "HELDOUT_COMPONENT_DUPLICATE_KEY",
        `Duplicate capture/viewport/nodeKey in component review: ${key}`,
      );
    }
    seen.add(key);
  }
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  // F9 labels only scorable accepted native/declared components. Candidate and
  // inferred rows stay in the full review but never appear in the labeler's files.
  const labelable = review.components.filter(isScorableAcceptedComponent);
  const blind: HeldoutComponentBlindReview = {
    schemaVersion: "awwwards-atlas-component-blind-v1",
    acceptedOnly: true,
    captureKey: review.captureKey,
    capturedAt: review.capturedAt,
    siteSlug: review.siteSlug,
    requestedUrl: review.requestedUrl,
    components: labelable.map((row) => ({
      key: componentHeldoutKey(row),
      selector: row.selector,
      tag: row.tag,
      role: row.role,
      accessibleName: row.accessibleName,
      sectionHeading: row.sectionHeading,
      rect: row.rect,
      screenshotKeys: row.screenshotKeys,
      inputType: row.inputType,
      ariaHasPopup: row.ariaHasPopup,
      ariaExpanded: row.ariaExpanded,
      ariaControlsResolved: row.ariaControlsResolved,
      inNavigation: row.inNavigation,
      ariaLabel: row.ariaLabel,
    })),
  };
  const labels: Record<string, string[]> = {};
  for (const row of labelable) labels[componentHeldoutKey(row)] = [];
  const full = join(outDir, "components-review-full.json");
  const blindPath = join(outDir, "components-review.json");
  const labelsPath = join(outDir, "component-labels.json");
  writeFileSync(full, JSON.stringify(review, null, 2), { mode: 0o600 });
  writeFileSync(blindPath, JSON.stringify(blind, null, 2), { mode: 0o600 });
  if (!existsSync(labelsPath)) {
    writeFileSync(labelsPath, JSON.stringify(labels, null, 2), { mode: 0o600 });
  }
  return { full, blind: blindPath, labels: labelsPath };
}

export type HeldoutComponentGate = "pass" | "fail" | "insufficient";

export interface HeldoutComponentScore {
  type: string;
  truePositives: number;
  falsePositives: number;
  support: number;
  precision: number;
  status: HeldoutComponentGate;
}

export interface HeldoutComponentReport {
  schemaVersion: "awwwards-atlas-component-score-v1";
  minimumSupport: number;
  requiredPrecision: number;
  totalComponents: number;
  acceptedComponents: number;
  inferredComponents: number;
  candidateComponents: number;
  labeledAccepted: number;
  invalidAcceptedRows: string[];
  perType: HeldoutComponentScore[];
  macroPrecision: number;
  gate: HeldoutComponentGate;
}

export class HeldoutComponentError extends Error {
  constructor(
    readonly code:
      | "HELDOUT_COMPONENT_UNKNOWN_KEY"
      | "HELDOUT_COMPONENT_DUPLICATE_KEY"
      | "HELDOUT_COMPONENT_MISSING_LABEL"
      | "HELDOUT_COMPONENT_EMPTY_CORPUS"
      | "HELDOUT_COMPONENT_INVALID_LABEL"
      | "HELDOUT_COMPONENT_INVALID_REVIEW"
      | "HELDOUT_COMPONENT_INVALID_CORPUS"
      | "HELDOUT_COMPONENT_INCOMPLETE_PAGE"
      | "HELDOUT_COMPONENT_RESERVED_KEY",
    message: string,
  ) {
    super(message);
    this.name = "HeldoutComponentError";
  }
}

export function scoreHeldoutComponentCorpus(
  reviews: HeldoutComponentReview[],
  labels: HeldoutHumanLabels,
): HeldoutComponentReport {
  if (reviews.length === 0) {
    throw new HeldoutComponentError(
      "HELDOUT_COMPONENT_EMPTY_CORPUS",
      "No component reviews supplied",
    );
  }
  const first = reviews[0]!;
  return scoreHeldoutComponents(
    {
      ...first,
      captureKey: "corpus",
      requestedUrl: "corpus",
      components: reviews.flatMap((review) => review.components),
    },
    labels,
  );
}

export interface HeldoutComponentCorpus {
  reviews: HeldoutComponentReview[];
  labels: HeldoutHumanLabels;
}

const RESERVED_LABEL_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function readHeldoutJson(
  path: string,
  code: "HELDOUT_COMPONENT_INVALID_REVIEW" | "HELDOUT_COMPONENT_INVALID_LABEL",
  what: string,
): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new HeldoutComponentError(
      code,
      `Cannot read ${what}: ${path} (${(error as Error).message})`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new HeldoutComponentError(
      code,
      `Invalid JSON in ${what}: ${path} (${(error as Error).message})`,
    );
  }
}

const TYPE_DECISIONS = new Set(["accepted", "candidate"]);
const TYPE_CLASSIFICATIONS = new Set(["observed", "inferred"]);
const TYPE_BASES = new Set(["native_semantics", "declared_aria", "rule_derivation"]);

function isHeldoutComponentRow(value: unknown): value is HeldoutComponentRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.captureKey === "string" &&
    typeof row.viewport === "string" &&
    typeof row.nodeKey === "string" &&
    Array.isArray(row.acceptedTypes) &&
    Array.isArray(row.candidateTypes) &&
    (row.ariaLabel === null || typeof row.ariaLabel === "string") &&
    typeof row.typeBasis === "string" &&
    TYPE_BASES.has(row.typeBasis) &&
    typeof row.typeClassification === "string" &&
    TYPE_CLASSIFICATIONS.has(row.typeClassification) &&
    typeof row.typeDecision === "string" &&
    TYPE_DECISIONS.has(row.typeDecision)
  );
}

function assertHeldoutComponentReview(value: unknown, path: string): HeldoutComponentReview {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { schemaVersion?: unknown }).schemaVersion !==
      "awwwards-atlas-component-review-v1" ||
    !Array.isArray((value as { components?: unknown }).components)
  ) {
    throw new HeldoutComponentError(
      "HELDOUT_COMPONENT_INVALID_REVIEW",
      `Component review must be an object with schemaVersion awwwards-atlas-component-review-v1 and a components array: ${path}`,
    );
  }
  const components = (value as { components: unknown[] }).components;
  components.forEach((row, index) => {
    if (!isHeldoutComponentRow(row)) {
      throw new HeldoutComponentError(
        "HELDOUT_COMPONENT_INVALID_REVIEW",
        `Component review row ${index} must be an object with string captureKey, viewport, nodeKey and ariaLabel (or null), acceptedTypes and candidateTypes arrays, typeBasis one of native_semantics/declared_aria/rule_derivation, typeClassification one of observed/inferred and typeDecision one of accepted/candidate: ${path}`,
      );
    }
  });
  return value as HeldoutComponentReview;
}

function assertHeldoutLabels(value: unknown, path: string): HeldoutHumanLabels {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HeldoutComponentError(
      "HELDOUT_COMPONENT_INVALID_LABEL",
      `Component labels must be an object: ${path}`,
    );
  }
  return value as HeldoutHumanLabels;
}

export function loadHeldoutComponentReviewFile(path: string): HeldoutComponentReview {
  return assertHeldoutComponentReview(
    readHeldoutJson(path, "HELDOUT_COMPONENT_INVALID_REVIEW", "component review"),
    path,
  );
}

export function loadHeldoutComponentLabelsFile(path: string): HeldoutHumanLabels {
  return assertHeldoutLabels(
    readHeldoutJson(path, "HELDOUT_COMPONENT_INVALID_LABEL", "component labels"),
    path,
  );
}

function pageContext(error: unknown, page: string): never {
  if (error instanceof HeldoutComponentError) {
    // Name the page once: loader messages already carry the page's file path.
    const scoped = error.message.includes(page)
      ? error.message
      : `${error.message} (page ${page})`;
    throw new HeldoutComponentError(error.code, scoped);
  }
  throw error;
}

function pageScope<T>(page: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    pageContext(error, page);
  }
}

/** Loads `<outRoot>/<page>/{components-review-full,component-labels}.json`. */
export function loadHeldoutComponentCorpus(outRoot: string): HeldoutComponentCorpus {
  let entries: Dirent[];
  try {
    entries = readdirSync(outRoot, { withFileTypes: true });
  } catch (error) {
    throw new HeldoutComponentError(
      "HELDOUT_COMPONENT_INVALID_CORPUS",
      `Cannot read component corpus root ${outRoot} (${(error as Error).message})`,
    );
  }
  const linked: string[] = [];
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const path = join(outRoot, entry.name);
    // Only a link whose target is a directory can smuggle a page in; a
    // symlinked file is just a stray file next to the pages.
    const stats = (() => {
      try {
        // A broken link is a stray entry, not a page.
        return statSync(path, { throwIfNoEntry: false });
      } catch (error) {
        // A loop or permission failure cannot be classified as a safe link.
        throw new HeldoutComponentError(
          "HELDOUT_COMPONENT_INVALID_CORPUS",
          `Cannot inspect symlink ${path} (${(error as Error).message})`,
        );
      }
    })();
    if (stats?.isDirectory()) linked.push(path);
  }
  if (linked.length > 0) {
    throw new HeldoutComponentError(
      "HELDOUT_COMPONENT_INVALID_CORPUS",
      `Symlinked page directories are refused: ${linked.join(", ")}`,
    );
  }
  const pages = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(outRoot, entry.name))
    .sort();
  if (pages.length === 0) {
    throw new HeldoutComponentError(
      "HELDOUT_COMPONENT_EMPTY_CORPUS",
      `No component review directories under ${outRoot}`,
    );
  }
  const reviews: HeldoutComponentReview[] = [];
  const labels: HeldoutHumanLabels = Object.create(null);
  for (const page of pages) {
    const reviewPath = join(page, "components-review-full.json");
    const labelsPath = join(page, "component-labels.json");
    if (!existsSync(reviewPath) || !existsSync(labelsPath)) {
      throw new HeldoutComponentError(
        "HELDOUT_COMPONENT_INCOMPLETE_PAGE",
        `Corpus page must contain both review and labels files: ${page}`,
      );
    }
    const review = pageScope(page, () => loadHeldoutComponentReviewFile(reviewPath));
    const pageLabels = pageScope(page, () => loadHeldoutComponentLabelsFile(labelsPath));
    try {
      for (const key of Object.keys(pageLabels)) {
        if (RESERVED_LABEL_KEYS.has(key)) {
          throw new HeldoutComponentError(
            "HELDOUT_COMPONENT_RESERVED_KEY",
            `Reserved component annotation key: ${key}`,
          );
        }
      }
      scoreHeldoutComponents(review, pageLabels);
    } catch (error) {
      pageContext(error, page);
    }
    for (const key of Object.keys(pageLabels)) {
      if (Object.hasOwn(labels, key)) {
        throw new HeldoutComponentError(
          "HELDOUT_COMPONENT_DUPLICATE_KEY",
          `Duplicate component annotation key across pages: ${key} (page ${page})`,
        );
      }
      labels[key] = pageLabels[key]!;
    }
    reviews.push(review);
  }
  return { reviews, labels };
}

/** F9: precision >= 0.95 for accepted native/declared component types. */
export const HELDOUT_COMPONENT_MIN_SUPPORT = 20;
export const HELDOUT_COMPONENT_REQUIRED_PRECISION = 0.95;

export function scoreHeldoutComponents(
  review: HeldoutComponentReview,
  labels: HeldoutHumanLabels,
): HeldoutComponentReport {
  const known = new Set<string>();
  let duplicate: string | null = null;
  for (const row of review.components) {
    const key = componentHeldoutKey(row);
    if (known.has(key)) {
      duplicate = key;
      break;
    }
    known.add(key);
  }
  if (duplicate !== null) {
    throw new HeldoutComponentError(
      "HELDOUT_COMPONENT_DUPLICATE_KEY",
      `Duplicate capture/viewport/node keys in component review: ${duplicate}`,
    );
  }
  const unknown = Object.keys(labels).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new HeldoutComponentError(
      "HELDOUT_COMPONENT_UNKNOWN_KEY",
      `Unknown component annotation keys: ${unknown.join(", ")}`,
    );
  }
  const allowed = HELDOUT_COMPONENT_LABEL_SET;
  const counts = new Map<string, { tp: number; fp: number }>();
  const invalidAcceptedRows: string[] = [];
  let labeledAccepted = 0;
  let acceptedComponents = 0;
  let inferredComponents = 0;
  let candidateComponents = 0;
  for (const row of review.components) {
    if (row.typeClassification === "inferred") {
      inferredComponents += 1;
      candidateComponents += 1;
      continue;
    }
    if (row.typeDecision !== "accepted") {
      candidateComponents += 1;
      continue;
    }
    acceptedComponents += 1;
    const key = componentHeldoutKey(row);
    if (!isScorableAcceptedComponent(row)) {
      invalidAcceptedRows.push(key);
      continue;
    }
    const predicted = row.acceptedTypes[0]!;
    if (!Object.hasOwn(labels, key)) {
      throw new HeldoutComponentError(
        "HELDOUT_COMPONENT_MISSING_LABEL",
        `Accepted component has no human label: ${key}`,
      );
    }
    const values = labels[key];
    if (!Array.isArray(values)) {
      throw new HeldoutComponentError(
        "HELDOUT_COMPONENT_INVALID_LABEL",
        `Component label must be an array: ${key}`,
      );
    }
    if (values.length === 0) {
      throw new HeldoutComponentError(
        "HELDOUT_COMPONENT_MISSING_LABEL",
        `Accepted component has no human label: ${key}`,
      );
    }
    if (values.length !== 1 || typeof values[0] !== "string") {
      throw new HeldoutComponentError(
        "HELDOUT_COMPONENT_INVALID_LABEL",
        `Component labels must contain exactly one value: ${key} -> ${JSON.stringify(values)}`,
      );
    }
    const truth = values[0]!;
    if (truth !== "none" && truth !== "ambiguous" && !allowed.has(truth)) {
      throw new HeldoutComponentError(
        "HELDOUT_COMPONENT_INVALID_LABEL",
        `Unknown component label ${truth} for ${key}`,
      );
    }
    labeledAccepted += 1;
    const bucket = counts.get(predicted) ?? { tp: 0, fp: 0 };
    if (truth === predicted) bucket.tp += 1;
    else bucket.fp += 1;
    counts.set(predicted, bucket);
  }
  const perType: HeldoutComponentScore[] = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, bucket]) => {
      const support = bucket.tp + bucket.fp;
      const precision = bucket.tp / Math.max(1, support);
      const status: HeldoutComponentGate =
        support < HELDOUT_COMPONENT_MIN_SUPPORT
          ? "insufficient"
          : precision >= HELDOUT_COMPONENT_REQUIRED_PRECISION
            ? "pass"
            : "fail";
      return {
        type,
        truePositives: bucket.tp,
        falsePositives: bucket.fp,
        support,
        precision,
        status,
      };
    });
  const gate: HeldoutComponentGate = invalidAcceptedRows.length > 0 ||
    perType.some((item) => item.status === "fail")
    ? "fail"
    : perType.length === 0 || perType.some((item) => item.status === "insufficient")
      ? "insufficient"
      : "pass";
  return {
    schemaVersion: "awwwards-atlas-component-score-v1",
    minimumSupport: HELDOUT_COMPONENT_MIN_SUPPORT,
    requiredPrecision: HELDOUT_COMPONENT_REQUIRED_PRECISION,
    totalComponents: review.components.length,
    acceptedComponents,
    inferredComponents,
    candidateComponents,
    labeledAccepted,
    invalidAcceptedRows,
    perType,
    macroPrecision:
      perType.reduce((sum, item) => sum + item.precision, 0) / Math.max(1, perType.length),
    gate,
  };
}
