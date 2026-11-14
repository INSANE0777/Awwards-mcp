import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AtlasCaptureAttempt } from "./live-types.js";
import {
  ATLAS_COMPONENT_RULE_VERSION,
  ATLAS_INFERRED_COMPONENT_TYPES,
} from "./components.js";
import { sha256Text, stableHash } from "./identity.js";
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

/**
 * Rule fingerprint: the declared classifier version plus a hash of the source
 * files that decide component type, classification and claim outcome. Any edit
 * changes the hash, so a sealed corpus cannot outlive the rules that produced
 * it. Both the source layout (`src/atlas/*.ts`) and the built layout
 * (`dist/atlas/*.js`) are supported; a missing source fails closed.
 */
export const HELDOUT_RULE_SOURCES = ["components", "vocabulary", "collector", "scan"] as const;

function ruleSourceText(name: string): string {
  const self = fileURLToPath(import.meta.url);
  const dir = import.meta.dirname ?? dirname(self);
  // Hash the layout that is actually executing: .ts under tsx, .js in dist.
  const preferred = self.endsWith(".ts") ? ".ts" : ".js";
  for (const extension of [preferred, preferred === ".ts" ? ".js" : ".ts"]) {
    const path = join(dir, `${name}${extension}`);
    try {
      return readFileSync(path, "utf8");
    } catch {
      // Try the other layout; a missing source is reported below.
    }
  }
  throw new HeldoutComponentError(
    "HELDOUT_COMPONENT_RULES_UNAVAILABLE",
    `Cannot read component rule source ${name}.ts/.js beside ${dir}`,
  );
}

export interface HeldoutRuleFingerprint {
  version: string;
  hash: string;
}

export function heldoutRuleFingerprint(): HeldoutRuleFingerprint {
  const sources = HELDOUT_RULE_SOURCES.map(
    (name) => [name, sha256Text(ruleSourceText(name))] as const,
  );
  return {
    version: ATLAS_COMPONENT_RULE_VERSION,
    hash: stableHash(
      "atlas-heldout-rules-v1",
      ATLAS_COMPONENT_RULE_VERSION,
      ...sources.flat(),
    ),
  };
}

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
  /** Classifier fingerprint at collection time; required before attestation. */
  ruleVersion?: string;
  ruleHash?: string;
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

const BLIND_REVIEW_KEYS = new Set([
  "schemaVersion",
  "acceptedOnly",
  "captureKey",
  "capturedAt",
  "siteSlug",
  "requestedUrl",
  "components",
]);

const BLIND_ROW_KEYS = new Set([
  "key",
  "selector",
  "tag",
  "role",
  "accessibleName",
  "sectionHeading",
  "rect",
  "screenshotKeys",
  "inputType",
  "ariaHasPopup",
  "ariaExpanded",
  "ariaControlsResolved",
  "inNavigation",
  "ariaLabel",
]);

/** The only fields a labeler may see; predictions live in the full review. */
export function buildHeldoutComponentBlind(
  review: HeldoutComponentReview,
): HeldoutComponentBlindReview {
  return {
    schemaVersion: "awwwards-atlas-component-blind-v1",
    acceptedOnly: true,
    captureKey: review.captureKey,
    capturedAt: review.capturedAt,
    siteSlug: review.siteSlug,
    requestedUrl: review.requestedUrl,
    components: review.components
      .filter(isScorableAcceptedComponent)
      .map((row, index) => {
        const blindRow: HeldoutComponentBlindRow = {
          key: componentHeldoutKey(row),
          selector: row.selector,
          tag: row.tag,
          role: row.role,
          accessibleName: row.accessibleName,
          sectionHeading: row.sectionHeading,
          // Validate the source rect, then emit numeric-only: a copied object
          // could smuggle predictions, so extra keys are refused, not dropped.
          rect: heldoutRect(
            row.rect,
            "HELDOUT_COMPONENT_INVALID_REVIEW",
            `Component row ${index} rect (component review)`,
          ),
          screenshotKeys: [...row.screenshotKeys],
          inputType: row.inputType,
          ariaHasPopup: row.ariaHasPopup,
          ariaExpanded: row.ariaExpanded,
          ariaControlsResolved: row.ariaControlsResolved,
          inNavigation: row.inNavigation,
          ariaLabel: row.ariaLabel,
        };
        // Re-check the emitted shape: an in-memory review never passed a loader.
        assertBlindFieldShapes(
          blindRow as unknown as Record<string, unknown>,
          index,
          "HELDOUT_COMPONENT_INVALID_REVIEW",
          "component review",
        );
        return blindRow;
      }),
  };
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
  const fingerprint = heldoutRuleFingerprint();
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
    ruleVersion: fingerprint.version,
    ruleHash: fingerprint.hash,
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
  const blind = buildHeldoutComponentBlind(review);
  const labels: Record<string, string[]> = {};
  for (const row of blind.components) labels[row.key] = [];
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
  /** Evaluation population declared before scoring; empty when unspecified. */
  declaredTypes: string[];
  /** Declared types with no measured predictions; they force insufficient. */
  missingDeclaredTypes: string[];
  gate: HeldoutComponentGate;
  /** Human/model evidence status; absent from pure API scoring. */
  provenance?: HeldoutComponentProvenanceSummary;
}

export interface HeldoutComponentScoreOptions {
  /** Fixed before scoring: a type declared here must be measured, never dropped. */
  declaredTypes?: readonly string[];
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
      | "HELDOUT_COMPONENT_INVALID_BLIND"
      | "HELDOUT_COMPONENT_PREDICTION_LEAK"
      | "HELDOUT_COMPONENT_BLIND_MISMATCH"
      | "HELDOUT_COMPONENT_INVALID_CORPUS"
      | "HELDOUT_COMPONENT_INCOMPLETE_PAGE"
      | "HELDOUT_COMPONENT_RESERVED_KEY"
      | "HELDOUT_COMPONENT_INVALID_PROVENANCE"
      | "HELDOUT_COMPONENT_PROVENANCE_MISSING"
      | "HELDOUT_COMPONENT_RULES_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "HeldoutComponentError";
  }
}

export function scoreHeldoutComponentCorpus(
  reviews: HeldoutComponentReview[],
  labels: HeldoutHumanLabels,
  options?: HeldoutComponentScoreOptions,
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
    options,
  );
}

/** Content hashes for one corpus page; page names are relative to the root. */
export interface HeldoutComponentPageBinding {
  page: string;
  reviewSha256: string;
  blindSha256: string | null;
  labelsSha256: string;
}

export interface HeldoutComponentCorpusPage extends HeldoutComponentPageBinding {
  review: HeldoutComponentReview;
}

export interface HeldoutComponentCorpus {
  reviews: HeldoutComponentReview[];
  labels: HeldoutHumanLabels;
  pages: HeldoutComponentCorpusPage[];
}

const RESERVED_LABEL_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type HeldoutJsonCode =
  | "HELDOUT_COMPONENT_INVALID_REVIEW"
  | "HELDOUT_COMPONENT_INVALID_LABEL"
  | "HELDOUT_COMPONENT_INVALID_BLIND"
  | "HELDOUT_COMPONENT_INVALID_PROVENANCE";

function readHeldoutText(path: string, code: HeldoutJsonCode, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new HeldoutComponentError(
      code,
      `Cannot read ${what}: ${path} (${(error as Error).message})`,
    );
  }
}

function parseHeldoutJson(
  text: string,
  path: string,
  code: HeldoutJsonCode,
  what: string,
): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new HeldoutComponentError(
      code,
      `Invalid JSON in ${what}: ${path} (${(error as Error).message})`,
    );
  }
}

function readHeldoutJson(path: string, code: HeldoutJsonCode, what: string): unknown {
  return parseHeldoutJson(readHeldoutText(path, code, what), path, code, what);
}

const TYPE_DECISIONS = new Set(["accepted", "candidate"]);
const TYPE_CLASSIFICATIONS = new Set(["observed", "inferred"]);
const TYPE_BASES = new Set(["native_semantics", "declared_aria", "rule_derivation"]);
const RECT_KEYS = ["x", "y", "width", "height"] as const;
const RECT_KEY_SET = new Set<string>(RECT_KEYS);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** A rect is exactly four finite numbers; extra nested keys are never evidence. */
function isHeldoutRect(value: unknown): value is HeldoutComponentRow["rect"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const rect = value as Record<string, unknown>;
  return (
    Object.keys(rect).length === RECT_KEYS.length &&
    RECT_KEYS.every((key) => isFiniteNumber(rect[key]))
  );
}

function heldoutRect(
  value: unknown,
  code: "HELDOUT_COMPONENT_INVALID_REVIEW" | "HELDOUT_COMPONENT_INVALID_BLIND",
  what: string,
): HeldoutComponentRow["rect"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HeldoutComponentError(
      code,
      `${what} must be an object with numeric x, y, width and height`,
    );
  }
  const rect = value as Record<string, unknown>;
  // Never echo an unexpected key: it is untrusted input and could carry a value.
  if (Object.keys(rect).some((key) => !RECT_KEY_SET.has(key))) {
    throw new HeldoutComponentError(code, `${what} must carry only numeric x, y, width and height`);
  }
  for (const key of RECT_KEYS) {
    if (!isFiniteNumber(rect[key])) {
      throw new HeldoutComponentError(code, `${what}.${key} must be a finite number`);
    }
  }
  return {
    x: rect.x as number,
    y: rect.y as number,
    width: rect.width as number,
    height: rect.height as number,
  };
}

/**
 * Evidence fields a labeler sees must be flat strings, booleans, string arrays
 * and a numeric rect. An object smuggled into any of them would reach the
 * blind file as a prediction channel, so the whole row shape is checked.
 */
function assertBlindFieldShapes(
  row: Record<string, unknown>,
  index: number,
  code: "HELDOUT_COMPONENT_INVALID_REVIEW" | "HELDOUT_COMPONENT_INVALID_BLIND",
  path: string,
): void {
  const fields: Array<[string, (value: unknown) => boolean]> = [
    ["key", (value) => typeof value === "string" && value.length > 0],
    ["selector", (value) => typeof value === "string"],
    ["tag", (value) => typeof value === "string"],
    ["role", isNullableString],
    ["accessibleName", (value) => typeof value === "string"],
    ["sectionHeading", isNullableString],
    ["screenshotKeys", isStringArray],
    ["inputType", isNullableString],
    ["ariaHasPopup", (value) => typeof value === "boolean"],
    ["ariaExpanded", isNullableString],
    ["ariaControlsResolved", (value) => typeof value === "boolean"],
    ["inNavigation", (value) => typeof value === "boolean"],
    ["ariaLabel", isNullableString],
  ];
  for (const [field, valid] of fields) {
    if (!valid(row[field])) {
      throw new HeldoutComponentError(
        code,
        `Component row ${index} field ${field} has an invalid shape: ${path}`,
      );
    }
  }
  heldoutRect(row.rect, code, `Component row ${index} rect (${path})`);
}

function isHeldoutComponentRow(value: unknown): value is HeldoutComponentRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.captureKey === "string" &&
    typeof row.viewport === "string" &&
    typeof row.nodeKey === "string" &&
    typeof row.selector === "string" &&
    typeof row.tag === "string" &&
    isNullableString(row.role) &&
    typeof row.accessibleName === "string" &&
    isNullableString(row.sectionHeading) &&
    isHeldoutRect(row.rect) &&
    isStringArray(row.screenshotKeys) &&
    isNullableString(row.inputType) &&
    typeof row.ariaHasPopup === "boolean" &&
    isNullableString(row.ariaExpanded) &&
    typeof row.ariaControlsResolved === "boolean" &&
    typeof row.inNavigation === "boolean" &&
    Array.isArray(row.acceptedTypes) &&
    Array.isArray(row.candidateTypes) &&
    isNullableString(row.ariaLabel) &&
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
    // A malformed rect gets a precise error instead of the field checklist.
    if (typeof row === "object" && row !== null && !Array.isArray(row) && "rect" in row) {
      heldoutRect(
        (row as Record<string, unknown>).rect,
        "HELDOUT_COMPONENT_INVALID_REVIEW",
        `Component review row ${index} rect (${path})`,
      );
    }
    if (!isHeldoutComponentRow(row)) {
      throw new HeldoutComponentError(
        "HELDOUT_COMPONENT_INVALID_REVIEW",
        `Component review row ${index} must be an object with string captureKey, viewport, nodeKey, selector, tag and accessibleName, a numeric-only rect, a string screenshotKeys array, string-or-null role/sectionHeading/inputType/ariaExpanded/ariaLabel, boolean ariaHasPopup/ariaControlsResolved/inNavigation, acceptedTypes and candidateTypes arrays, typeBasis one of native_semantics/declared_aria/rule_derivation, typeClassification one of observed/inferred and typeDecision one of accepted/candidate: ${path}`,
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

function assertNoExtraKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  what: string,
  path: string,
): void {
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new HeldoutComponentError(
      "HELDOUT_COMPONENT_PREDICTION_LEAK",
      `${what} exposes non-blind fields ${extra.join(", ")}: ${path}`,
    );
  }
}

/** A blind review must contain evidence fields only, never predictions. */
function assertHeldoutComponentBlind(value: unknown, path: string): HeldoutComponentBlindReview {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HeldoutComponentError(
      "HELDOUT_COMPONENT_INVALID_BLIND",
      `Blind component review must be an object: ${path}`,
    );
  }
  const blind = value as Record<string, unknown>;
  if (
    blind.schemaVersion !== "awwwards-atlas-component-blind-v1" ||
    blind.acceptedOnly !== true ||
    !Array.isArray(blind.components)
  ) {
    throw new HeldoutComponentError(
      "HELDOUT_COMPONENT_INVALID_BLIND",
      `Blind component review must use schemaVersion awwwards-atlas-component-blind-v1, acceptedOnly true and a components array: ${path}`,
    );
  }
  assertNoExtraKeys(blind, BLIND_REVIEW_KEYS, "Blind component review", path);
  const seen = new Set<string>();
  blind.components.forEach((row, index) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new HeldoutComponentError(
        "HELDOUT_COMPONENT_INVALID_BLIND",
        `Blind component row ${index} must be an object: ${path}`,
      );
    }
    const record = row as Record<string, unknown>;
    assertNoExtraKeys(record, BLIND_ROW_KEYS, `Blind component row ${index}`, path);
    assertBlindFieldShapes(record, index, "HELDOUT_COMPONENT_INVALID_BLIND", path);
    const key = record.key as string;
    if (seen.has(key)) {
      throw new HeldoutComponentError(
        "HELDOUT_COMPONENT_DUPLICATE_KEY",
        `Duplicate blind component key ${key}: ${path}`,
      );
    }
    seen.add(key);
  });
  return value as HeldoutComponentBlindReview;
}

export function loadHeldoutComponentBlindFile(path: string): HeldoutComponentBlindReview {
  return assertHeldoutComponentBlind(
    readHeldoutJson(path, "HELDOUT_COMPONENT_INVALID_BLIND", "blind component review"),
    path,
  );
}

/** Sorting keys makes semantically equal JSON compare equal regardless of order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
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
    .map((entry) => ({ name: entry.name, path: join(outRoot, entry.name) }))
    .sort((left, right) => comparePageNames(left.name, right.name));
  if (pages.length === 0) {
    throw new HeldoutComponentError(
      "HELDOUT_COMPONENT_EMPTY_CORPUS",
      `No component review directories under ${outRoot}`,
    );
  }
  const reviews: HeldoutComponentReview[] = [];
  const labels: HeldoutHumanLabels = Object.create(null);
  const bindings: HeldoutComponentCorpusPage[] = [];
  for (const { name, path: page } of pages) {
    const reviewPath = join(page, "components-review-full.json");
    const labelsPath = join(page, "component-labels.json");
    const blindPath = join(page, "components-review.json");
    if (!existsSync(reviewPath) || !existsSync(labelsPath)) {
      throw new HeldoutComponentError(
        "HELDOUT_COMPONENT_INCOMPLETE_PAGE",
        `Corpus page must contain both review and labels files: ${page}`,
      );
    }
    const reviewText = pageScope(page, () =>
      readHeldoutText(reviewPath, "HELDOUT_COMPONENT_INVALID_REVIEW", "component review"),
    );
    const review = pageScope(page, () =>
      assertHeldoutComponentReview(
        parseHeldoutJson(
          reviewText,
          reviewPath,
          "HELDOUT_COMPONENT_INVALID_REVIEW",
          "component review",
        ),
        reviewPath,
      ),
    );
    const labelsText = pageScope(page, () =>
      readHeldoutText(labelsPath, "HELDOUT_COMPONENT_INVALID_LABEL", "component labels"),
    );
    const pageLabels = pageScope(page, () =>
      assertHeldoutLabels(
        parseHeldoutJson(
          labelsText,
          labelsPath,
          "HELDOUT_COMPONENT_INVALID_LABEL",
          "component labels",
        ),
        labelsPath,
      ),
    );
    let blindSha256: string | null = null;
    if (existsSync(blindPath)) {
      try {
        blindSha256 = sha256Text(readFileSync(blindPath, "utf8"));
      } catch (error) {
        throw new HeldoutComponentError(
          "HELDOUT_COMPONENT_INVALID_CORPUS",
          `Cannot read ${blindPath} (${(error as Error).message})`,
        );
      }
    }
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
    bindings.push({
      page: name,
      reviewSha256: sha256Text(reviewText),
      blindSha256,
      labelsSha256: sha256Text(labelsText),
      review,
    });
  }
  return { reviews, labels, pages: bindings };
}

/**
 * Provenance is the human-evidence half of F9; the score report is the
 * numerical half. A manifest records who produced the labels and binds the
 * full reviews, blind evidence, labels and rule sources it was sealed against.
 */
export interface HeldoutProvenanceReviewer {
  id: string;
  attestation: string;
}

export interface HeldoutProvenanceController {
  id: string;
  attestation: string;
  attestedAt: string;
}

export interface HeldoutProvenanceAttestation {
  schemaVersion: "awwwards-atlas-heldout-attestation-v1";
  declaredTypes: string[];
  datasetSplit: string;
  provenance: "human" | "model";
  reviewers: HeldoutProvenanceReviewer[];
  controller: HeldoutProvenanceController;
}

export interface HeldoutProvenancePage {
  page: string;
  reviewSha256: string;
  blindSha256: string;
  labelsSha256: string;
}

export interface HeldoutProvenanceManifest {
  schemaVersion: "awwwards-atlas-heldout-provenance-v1";
  declaredTypes: string[];
  datasetSplit: string;
  provenance: "human" | "model";
  reviewers: HeldoutProvenanceReviewer[];
  controller: HeldoutProvenanceController;
  rulesVersion: string;
  rulesHash: string;
  corpusHash: string;
  attestationSha256: string;
  pages: HeldoutProvenancePage[];
}

export interface HeldoutProvenanceCheck {
  qualifying: boolean;
  reasons: string[];
  fingerprint: HeldoutRuleFingerprint;
}

export interface HeldoutComponentProvenanceSummary {
  kind: "human" | "model" | "absent";
  qualifying: boolean;
  reasons: string[];
  reviewers: string[];
  declaredTypes: string[];
  datasetSplit: string | null;
  rulesVersion: string | null;
  rulesHash: string | null;
  corpusHash: string | null;
  pages: number;
}

const ATTESTATION_KEYS = new Set([
  "schemaVersion",
  "declaredTypes",
  "datasetSplit",
  "provenance",
  "reviewers",
  "controller",
]);

const MANIFEST_KEYS = new Set([
  ...ATTESTATION_KEYS,
  "rulesVersion",
  "rulesHash",
  "corpusHash",
  "attestationSha256",
  "pages",
]);

const REVIEWER_KEYS = new Set(["id", "attestation"]);
const CONTROLLER_KEYS = new Set(["id", "attestation", "attestedAt"]);
const PROVENANCE_PAGE_KEYS = new Set([
  "page",
  "reviewSha256",
  "blindSha256",
  "labelsSha256",
]);
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const UNSAFE_PAGE_NAME = /[/\\\u0000-\u001f\u007f]|^[A-Za-z]:/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Manifest page names address a direct child directory of the corpus root. */
function isSafePageName(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    value !== "." &&
    value !== ".." &&
    !UNSAFE_PAGE_NAME.test(value)
  );
}

/** Code-unit order is locale-independent, so corpus hashes match everywhere. */
function comparePageNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidProvenance(message: string): never {
  throw new HeldoutComponentError("HELDOUT_COMPONENT_INVALID_PROVENANCE", message);
}

function provenanceRecord(value: unknown, path: string, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidProvenance(`${what} must be an object: ${path}`);
  }
  return value as Record<string, unknown>;
}

function provenanceExtraKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  what: string,
  path: string,
): void {
  const extra = Object.keys(record).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    invalidProvenance(`${what} has unknown fields ${extra.join(", ")}: ${path}`);
  }
}

function assertDeclaredTypes(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalidProvenance(`declaredTypes must be a non-empty array: ${path}`);
  }
  const declared: string[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      entry === "none" ||
      entry === "ambiguous" ||
      !HELDOUT_COMPONENT_LABEL_SET.has(entry)
    ) {
      invalidProvenance(`declaredTypes contains an invalid component type: ${String(entry)} (${path})`);
    }
    if (declared.includes(entry)) {
      invalidProvenance(`declaredTypes contains duplicate type ${entry}: ${path}`);
    }
    declared.push(entry);
  }
  return declared;
}

function assertReviewers(value: unknown, provenance: string, path: string): HeldoutProvenanceReviewer[] {
  if (!Array.isArray(value)) invalidProvenance(`reviewers must be an array: ${path}`);
  const reviewers: HeldoutProvenanceReviewer[] = [];
  for (const [index, entry] of value.entries()) {
    const record = provenanceRecord(entry, path, `reviewers[${index}]`);
    provenanceExtraKeys(record, REVIEWER_KEYS, `reviewers[${index}]`, path);
    if (!isNonEmptyString(record.id) || !isNonEmptyString(record.attestation)) {
      invalidProvenance(`reviewers[${index}] requires non-empty id and attestation: ${path}`);
    }
    if (reviewers.some((reviewer) => reviewer.id === record.id)) {
      invalidProvenance(`Duplicate reviewer id ${record.id}: ${path}`);
    }
    reviewers.push({ id: record.id, attestation: record.attestation });
  }
  if (provenance === "human" && reviewers.length === 0) {
    invalidProvenance(`Human provenance requires at least one named reviewer: ${path}`);
  }
  return reviewers;
}

function assertController(value: unknown, path: string): HeldoutProvenanceController {
  const record = provenanceRecord(value, path, "controller");
  provenanceExtraKeys(record, CONTROLLER_KEYS, "controller", path);
  if (
    !isNonEmptyString(record.id) ||
    !isNonEmptyString(record.attestation) ||
    !isNonEmptyString(record.attestedAt)
  ) {
    invalidProvenance(`controller requires non-empty id, attestation and attestedAt: ${path}`);
  }
  return { id: record.id, attestation: record.attestation, attestedAt: record.attestedAt };
}

function assertProvenanceCommon(
  record: Record<string, unknown>,
  path: string,
): Pick<HeldoutProvenanceAttestation, "declaredTypes" | "datasetSplit" | "provenance" | "reviewers" | "controller"> {
  if (!isNonEmptyString(record.datasetSplit)) {
    invalidProvenance(`datasetSplit must be a non-empty string: ${path}`);
  }
  if (record.provenance !== "human" && record.provenance !== "model") {
    invalidProvenance(`provenance must be human or model: ${path}`);
  }
  return {
    declaredTypes: assertDeclaredTypes(record.declaredTypes, path),
    datasetSplit: record.datasetSplit,
    provenance: record.provenance,
    reviewers: assertReviewers(record.reviewers, record.provenance, path),
    controller: assertController(record.controller, path),
  };
}

function assertHeldoutProvenanceAttestation(
  value: unknown,
  path: string,
): HeldoutProvenanceAttestation {
  const record = provenanceRecord(value, path, "Attestation");
  provenanceExtraKeys(record, ATTESTATION_KEYS, "Attestation", path);
  if (record.schemaVersion !== "awwwards-atlas-heldout-attestation-v1") {
    invalidProvenance(
      `Attestation schemaVersion must be awwwards-atlas-heldout-attestation-v1: ${path}`,
    );
  }
  return {
    schemaVersion: "awwwards-atlas-heldout-attestation-v1",
    ...assertProvenanceCommon(record, path),
  };
}

function assertHeldoutProvenanceManifest(
  value: unknown,
  path: string,
): HeldoutProvenanceManifest {
  const record = provenanceRecord(value, path, "Provenance manifest");
  provenanceExtraKeys(record, MANIFEST_KEYS, "Provenance manifest", path);
  if (record.schemaVersion !== "awwwards-atlas-heldout-provenance-v1") {
    invalidProvenance(
      `Provenance manifest schemaVersion must be awwwards-atlas-heldout-provenance-v1: ${path}`,
    );
  }
  if (!isNonEmptyString(record.rulesVersion)) {
    invalidProvenance(`Provenance manifest requires rulesVersion: ${path}`);
  }
  for (const field of ["rulesHash", "corpusHash", "attestationSha256"] as const) {
    if (typeof record[field] !== "string" || !HEX_SHA256.test(record[field])) {
      invalidProvenance(`Provenance manifest ${field} must be a sha256 hex digest: ${path}`);
    }
  }
  if (!Array.isArray(record.pages) || record.pages.length === 0) {
    invalidProvenance(`Provenance manifest pages must be a non-empty array: ${path}`);
  }
  const pages: HeldoutProvenancePage[] = [];
  for (const [index, entry] of record.pages.entries()) {
    const page = provenanceRecord(entry, path, `pages[${index}]`);
    provenanceExtraKeys(page, PROVENANCE_PAGE_KEYS, `pages[${index}]`, path);
    if (!isSafePageName(page.page)) {
      invalidProvenance(`pages[${index}] requires a safe direct-child page name: ${path}`);
    }
    for (const field of ["reviewSha256", "blindSha256", "labelsSha256"] as const) {
      if (typeof page[field] !== "string" || !HEX_SHA256.test(page[field])) {
        invalidProvenance(`pages[${index}].${field} must be a sha256 hex digest: ${path}`);
      }
    }
    if (pages.some((existing) => existing.page === page.page)) {
      invalidProvenance(`Duplicate provenance page ${page.page}: ${path}`);
    }
    pages.push({
      page: page.page as string,
      reviewSha256: page.reviewSha256 as string,
      blindSha256: page.blindSha256 as string,
      labelsSha256: page.labelsSha256 as string,
    });
  }
  return {
    schemaVersion: "awwwards-atlas-heldout-provenance-v1",
    ...assertProvenanceCommon(record, path),
    rulesVersion: record.rulesVersion,
    rulesHash: record.rulesHash as string,
    corpusHash: record.corpusHash as string,
    attestationSha256: record.attestationSha256 as string,
    pages,
  };
}

export function loadHeldoutProvenanceAttestationFile(
  path: string,
): HeldoutProvenanceAttestation {
  return assertHeldoutProvenanceAttestation(
    readHeldoutJson(path, "HELDOUT_COMPONENT_INVALID_PROVENANCE", "provenance attestation"),
    path,
  );
}

export function loadHeldoutProvenanceFile(path: string): HeldoutProvenanceManifest {
  return assertHeldoutProvenanceManifest(
    readHeldoutJson(path, "HELDOUT_COMPONENT_INVALID_PROVENANCE", "provenance manifest"),
    path,
  );
}

export function heldoutCorpusHash(pages: readonly HeldoutProvenancePage[]): string {
  const ordered = [...pages].sort((left, right) => comparePageNames(left.page, right.page));
  return stableHash(
    "atlas-heldout-corpus-v1",
    ...ordered.flatMap((page) => [
      page.page,
      page.reviewSha256,
      page.blindSha256,
      page.labelsSha256,
    ]),
  );
}

function blindForPage(page: string, review: HeldoutComponentReview, root: string): HeldoutComponentBlindReview {
  const path = join(root, page, "components-review.json");
  const blind = loadHeldoutComponentBlindFile(path);
  if (canonicalJson(blind) !== canonicalJson(buildHeldoutComponentBlind(review))) {
    throw new HeldoutComponentError(
      "HELDOUT_COMPONENT_BLIND_MISMATCH",
      `Blind review does not match the full review: ${path}`,
    );
  }
  return blind;
}

/**
 * Seals a labeled corpus. The caller supplies the human attestation; every
 * hash and the rule fingerprint are computed here, so a sealed manifest cannot
 * claim a corpus or rule set it was not built from.
 */
export function attestHeldoutComponentCorpus(
  outRoot: string,
  attestation: HeldoutProvenanceAttestation,
): HeldoutProvenanceManifest {
  const corpus = loadHeldoutComponentCorpus(outRoot);
  const fingerprint = heldoutRuleFingerprint();
  const pages: HeldoutProvenancePage[] = corpus.pages.map((binding) => {
    if (
      binding.review.ruleVersion !== fingerprint.version ||
      binding.review.ruleHash !== fingerprint.hash
    ) {
      throw new HeldoutComponentError(
        "HELDOUT_COMPONENT_INVALID_PROVENANCE",
        `Corpus page ${binding.page} was collected under different rules (${binding.review.ruleVersion ?? "unrecorded"}); collect a fresh holdout before attestation`,
      );
    }
    if (!isSafePageName(binding.page)) {
      throw new HeldoutComponentError(
        "HELDOUT_COMPONENT_INVALID_CORPUS",
        `Unsafe corpus page directory name: ${JSON.stringify(binding.page)}`,
      );
    }
    if (binding.blindSha256 === null) {
      throw new HeldoutComponentError(
        "HELDOUT_COMPONENT_INCOMPLETE_PAGE",
        `Corpus page must contain a blind review before attestation: ${join(outRoot, binding.page)}`,
      );
    }
    blindForPage(binding.page, binding.review, outRoot);
    return {
      page: binding.page,
      reviewSha256: binding.reviewSha256,
      blindSha256: binding.blindSha256,
      labelsSha256: binding.labelsSha256,
    };
  });
  // A rule change burns the old holdout: refuse to re-seal the exact labels
  // that were scored under the previous classifier. New pages or new labels
  // are a fresh corpus; an unreadable prior manifest must be moved aside.
  const previousPath = join(outRoot, "provenance.json");
  if (existsSync(previousPath)) {
    const previous = loadHeldoutProvenanceFile(previousPath);
    if (
      previous.rulesHash !== fingerprint.hash ||
      previous.rulesVersion !== fingerprint.version
    ) {
      const previousLabels = new Map(
        previous.pages.map((page) => [page.page, page.labelsSha256]),
      );
      const reused = pages
        .filter((page) => previousLabels.get(page.page) === page.labelsSha256)
        .map((page) => page.page);
      if (reused.length > 0) {
        throw new HeldoutComponentError(
          "HELDOUT_COMPONENT_INVALID_PROVENANCE",
          `Classifier changed; labels for ${reused.join(", ")} are unchanged and must not be reused. Collect and label a fresh holdout`,
        );
      }
    }
  }
  return {
    schemaVersion: "awwwards-atlas-heldout-provenance-v1",
    declaredTypes: attestation.declaredTypes,
    datasetSplit: attestation.datasetSplit,
    provenance: attestation.provenance,
    reviewers: attestation.reviewers,
    controller: attestation.controller,
    rulesVersion: fingerprint.version,
    rulesHash: fingerprint.hash,
    corpusHash: heldoutCorpusHash(pages),
    attestationSha256: sha256Text(canonicalJson(attestation)),
    pages,
  };
}

export function writeHeldoutProvenance(
  manifest: HeldoutProvenanceManifest,
  outDir: string,
): string {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const target = join(outDir, "provenance.json");
  writeFileSync(target, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return target;
}

/**
 * Checks a manifest against the material being scored. A stale capture, edited
 * label, changed rule source, incomplete page set or non-human provenance makes
 * the evidence non-qualifying; it never changes the numerical report.
 */
export function verifyHeldoutComponentProvenance(
  manifest: HeldoutProvenanceManifest,
  root: string,
  pages: readonly HeldoutComponentCorpusPage[],
): HeldoutProvenanceCheck {
  const reasons = new Set<string>();
  const fingerprint = heldoutRuleFingerprint();
  if (
    manifest.rulesVersion !== fingerprint.version ||
    manifest.rulesHash !== fingerprint.hash
  ) {
    reasons.add("RULES_CHANGED");
  }
  if (manifest.corpusHash !== heldoutCorpusHash(manifest.pages)) {
    reasons.add("CORPUS_HASH_MISMATCH");
  }
  const expectedAttestation = sha256Text(
    canonicalJson({
      schemaVersion: "awwwards-atlas-heldout-attestation-v1",
      declaredTypes: manifest.declaredTypes,
      datasetSplit: manifest.datasetSplit,
      provenance: manifest.provenance,
      reviewers: manifest.reviewers,
      controller: manifest.controller,
    }),
  );
  if (manifest.attestationSha256 !== expectedAttestation) {
    reasons.add("ATTESTATION_MODIFIED");
  }
  if (manifest.pages.length !== pages.length) reasons.add("PAGES_CHANGED");
  const expectedPages = new Map(manifest.pages.map((page) => [page.page, page]));
  const presentPages = new Set(pages.map((page) => page.page));
  if (manifest.pages.some((page) => !presentPages.has(page.page))) {
    reasons.add("PAGES_CHANGED");
  }
  for (const binding of pages) {
    const expected = expectedPages.get(binding.page);
    if (!expected) {
      reasons.add("PAGES_CHANGED");
      continue;
    }
    if (
      binding.review.ruleVersion !== fingerprint.version ||
      binding.review.ruleHash !== fingerprint.hash
    ) {
      reasons.add(`CAPTURE_RULES_CHANGED:${binding.page}`);
    }
    if (expected.reviewSha256 !== binding.reviewSha256) {
      reasons.add(`REVIEW_CHANGED:${binding.page}`);
    }
    if (expected.labelsSha256 !== binding.labelsSha256) {
      reasons.add(`LABELS_CHANGED:${binding.page}`);
    }
    if (binding.blindSha256 === null) {
      reasons.add(`BLIND_MISSING:${binding.page}`);
    } else if (expected.blindSha256 !== binding.blindSha256) {
      reasons.add(`BLIND_CHANGED:${binding.page}`);
    }
    if (binding.blindSha256 !== null) {
      const path = join(root, binding.page, "components-review.json");
      const blind = loadHeldoutComponentBlindFile(path);
      if (canonicalJson(blind) !== canonicalJson(buildHeldoutComponentBlind(binding.review))) {
        reasons.add(`BLIND_MISMATCH:${binding.page}`);
      }
    }
  }
  if (manifest.provenance !== "human") reasons.add("PROVENANCE_NOT_HUMAN");
  if (manifest.provenance === "human" && manifest.reviewers.length === 0) {
    reasons.add("REVIEWERS_MISSING");
  }
  if (manifest.datasetSplit !== "heldout") reasons.add("DATASET_SPLIT_NOT_HELDOUT");
  if (manifest.declaredTypes.length === 0) reasons.add("DECLARED_TYPES_MISSING");
  return {
    qualifying: reasons.size === 0,
    reasons: [...reasons],
    fingerprint,
  };
}

/** F9: precision >= 0.95 for accepted native/declared component types. */
export const HELDOUT_COMPONENT_MIN_SUPPORT = 20;
export const HELDOUT_COMPONENT_REQUIRED_PRECISION = 0.95;

export function scoreHeldoutComponents(
  review: HeldoutComponentReview,
  labels: HeldoutHumanLabels,
  options?: HeldoutComponentScoreOptions,
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
  const declaredTypes = [...new Set(options?.declaredTypes ?? [])];
  const missingDeclaredTypes = declaredTypes.filter(
    (type) => !perType.some((item) => item.type === type),
  );
  const gate: HeldoutComponentGate = invalidAcceptedRows.length > 0 ||
    perType.some((item) => item.status === "fail")
    ? "fail"
    : perType.length === 0 ||
        missingDeclaredTypes.length > 0 ||
        perType.some((item) => item.status === "insufficient")
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
    declaredTypes,
    missingDeclaredTypes,
    gate,
  };
}
