import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { AtlasCaptureAttempt } from "../src/atlas/live-types.js";
import {
  buildHeldoutComponentReview,
  componentHeldoutKey,
  HeldoutComponentError,
  loadHeldoutComponentCorpus,
  loadHeldoutComponentReviewFile,
  scoreHeldoutComponentCorpus,
  scoreHeldoutComponents,
  writeHeldoutComponentReview,
} from "../src/atlas/heldout.js";
import type {
  HeldoutComponentReview,
  HeldoutComponentRow,
} from "../src/atlas/heldout.js";
import { HELDOUT_COMPONENT_LABELS } from "../src/atlas/heldout.js";
import { ATLAS_INFERRED_COMPONENT_TYPES } from "../src/atlas/components.js";

const ROOT = join(import.meta.dirname, "..");
const TSX_CLI = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const HELDOUT_CLI = join(ROOT, "src", "atlas", "heldout-cli.ts");

function runScoreComponents(reviewPath: string, labelsPath: string) {
  return spawnSync(
    process.execPath,
    [TSX_CLI, HELDOUT_CLI, "score-components", reviewPath, labelsPath],
    { encoding: "utf8", timeout: 30_000 },
  );
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, [TSX_CLI, HELDOUT_CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

const LINK_ERRORS = new Set(["EPERM", "EACCES", "ENOTSUP", "EINVAL", "UNKNOWN"]);

/** Directory junction on Windows (no admin rights) or a directory symlink elsewhere. */
function linkDirectory(target: string, path: string): boolean {
  if (process.platform === "win32") {
    return spawnSync("cmd", ["/c", "mklink", "/J", path, target], { encoding: "utf8" }).status === 0;
  }
  try {
    symlinkSync(target, path, "dir");
    return true;
  } catch (error) {
    if (LINK_ERRORS.has((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

function row(index: number, acceptedType: string, decision: "accepted" | "candidate" = "accepted"): HeldoutComponentRow {
  return {
    captureKey: "capture",
    viewport: "desktop",
    selector: `#c${index}`,
    nodeKey: `node-${index}`,
    regionKey: `region-${index}`,
    tag: acceptedType === "button" ? "button" : acceptedType === "text_input" ? "input" : "a",
    role: null,
    accessibleName: `Item ${index}`,
    sectionHeading: "Hero",
    rect: { x: 0, y: index, width: 10, height: 10 },
    screenshotKeys: ["shot-1"],
    inputType: acceptedType === "text_input" ? "email" : null,
    ariaHasPopup: true,
    ariaExpanded: "false",
    ariaControlsResolved: true,
    inNavigation: true,
    ariaLabel: `Label ${index}`,
    candidateTypes: decision === "candidate" ? [acceptedType] : [],
    acceptedTypes: decision === "accepted" ? [acceptedType] : [],
    typeBasis: acceptedType === "button" ? "native_semantics" : "declared_aria",
    typeClassification: acceptedType === "card" ? "inferred" : "observed",
    typeDecision: decision,
  };
}

function reviewWith(rows: HeldoutComponentRow[]): HeldoutComponentReview {
  return {
    schemaVersion: "awwwards-atlas-component-review-v1",
    captureKey: "capture",
    capturedAt: 1,
    siteSlug: "site",
    requestedUrl: "https://example.com/",
    status: "complete",
    limitations: [],
    error: null,
    coverage: { status: "complete", collected: rows.length, excluded: 0, limitations: [] },
    components: rows,
  };
}

function writePage(
  root: string,
  name: string,
  review: HeldoutComponentReview,
  labels: unknown,
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "components-review-full.json"), JSON.stringify(review));
  writeFileSync(join(dir, "component-labels.json"), JSON.stringify(labels));
  return dir;
}

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as HeldoutComponentError).code;
  }
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function labelsFor(
  rows: HeldoutComponentRow[],
  correct: number,
): Record<string, string[]> {
  const labels: Record<string, string[]> = {};
  rows.forEach((item, index) => {
    labels[componentHeldoutKey(item)] = [index < correct ? "button" : "link"];
  });
  return labels;
}

describe("component held-out review", () => {
  it("builds component rows with section context and claim outcomes", () => {
    const attempt = {
      attemptId: "capture",
      finishedAt: 1,
      target: { siteSlug: "site", requestedUrl: "https://example.com/" },
      status: "complete",
      limitations: [],
      coverage: { status: "complete", collected: 1, excluded: 0, limitations: [] },
      artifacts: [],
      viewports: [
        {
          viewport: "desktop",
          regions: [{ nodeKey: "section-node", heading: "Hero" }],
          components: [
            {
              key: "component-1",
              selector: "#email",
              nodeKey: "component-node",
              tag: "input",
              role: null,
              inputType: "email",
              ariaHasPopup: true,
              ariaExpanded: "true",
              ariaControlsResolved: true,
              inNavigation: true,
              ariaLabel: "Email field",
              label: "Email",
              rect: { x: 0, y: 0, width: 10, height: 10 },
              typeBasis: "native_semantics",
              typeClassification: "observed",
              typeDecision: "accepted",
              sectionNodeKey: "section-node",
            },
          ],
          claims: [
            {
              regionKey: "component-1",
              field: "component.type",
              value: "text_input",
              decision: "accepted",
            },
            {
              regionKey: "component-1",
              field: "component.type",
              value: "card",
              decision: "candidate",
            },
          ],
          screenshots: [{ key: "shot-1" }],
        },
      ],
    } as unknown as AtlasCaptureAttempt;
    const review = buildHeldoutComponentReview(attempt);
    expect(review.components).toHaveLength(1);
    expect(review.components[0]).toMatchObject({
      accessibleName: "Email",
      sectionHeading: "Hero",
      inputType: "email",
      ariaHasPopup: true,
      ariaExpanded: "true",
      ariaControlsResolved: true,
      inNavigation: true,
      ariaLabel: "Email field",
      acceptedTypes: ["text_input"],
      candidateTypes: ["card"],
    });
  });

  it("writes a blind review with evidence fields and no predictions", () => {
    const out = mkdtempSync(join(tmpdir(), "atlas-component-heldout-"));
    try {
      const review = reviewWith([
        row(1, "button"),
        row(2, "card", "candidate"),
        row(3, "text_input"),
      ]);
      const files = writeHeldoutComponentReview(review, out);
      const blind = JSON.parse(readFileSync(files.blind, "utf8"));
      const labels = JSON.parse(readFileSync(files.labels, "utf8"));
      expect(blind.acceptedOnly).toBe(true);
      expect(blind.components).toHaveLength(2);
      expect(blind.components[0]).toMatchObject({
        tag: "button",
        accessibleName: "Item 1",
        inputType: null,
        ariaHasPopup: true,
        ariaExpanded: "false",
        ariaControlsResolved: true,
        inNavigation: true,
        ariaLabel: "Label 1",
      });
      expect(blind.components[1]).toMatchObject({
        tag: "input",
        accessibleName: "Item 3",
        inputType: "email",
        ariaLabel: "Label 3",
      });
      for (const field of [
        "inputType",
        "ariaHasPopup",
        "ariaExpanded",
        "ariaControlsResolved",
        "inNavigation",
        "ariaLabel",
      ]) {
        expect(blind.components[0]).toHaveProperty(field);
      }
      for (const field of [
        "acceptedTypes",
        "candidateTypes",
        "typeBasis",
        "typeClassification",
        "typeDecision",
        "typeRuleId",
        "claims",
      ]) {
        expect(blind.components[0]).not.toHaveProperty(field);
      }
      expect(labels).toEqual({
        [componentHeldoutKey(review.components[0]!)]: [],
        [componentHeldoutKey(review.components[2]!)]: [],
      });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("rejects a review row that drops ariaLabel or uses an off-enum value", () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-component-heldout-"));
    try {
      const path = join(root, "components-review-full.json");
      const cases: Array<Record<string, unknown>> = [
        (() => {
          const dropped = JSON.parse(JSON.stringify(row(1, "button")));
          delete dropped.ariaLabel;
          return dropped;
        })(),
        { ...row(1, "button"), typeDecision: "Accepted" },
        { ...row(1, "button"), typeClassification: "Observed" },
        { ...row(1, "button"), typeBasis: "native" },
      ];
      for (const bad of cases) {
        writeFileSync(
          path,
          JSON.stringify({ ...reviewWith([]), components: [bad] }),
        );
        expect(errorCode(() => loadHeldoutComponentReviewFile(path))).toBe(
          "HELDOUT_COMPONENT_INVALID_REVIEW",
        );
      }
      writeFileSync(path, JSON.stringify(reviewWith([row(1, "button")])));
      expect(loadHeldoutComponentReviewFile(path).components).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes an observed candidate from the blind export", () => {
    const out = mkdtempSync(join(tmpdir(), "atlas-component-heldout-"));
    try {
      const review = reviewWith([row(1, "button", "candidate")]);
      const files = writeHeldoutComponentReview(review, out);
      const blind = JSON.parse(readFileSync(files.blind, "utf8"));
      const labels = JSON.parse(readFileSync(files.labels, "utf8"));
      expect(blind.components).toEqual([]);
      expect(labels).toEqual({});
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("keys a component by node identity so the prediction cannot be brute-forced", () => {
    const base = row(1, "button");
    const relabeled = {
      ...base,
      acceptedTypes: ["link"],
      candidateTypes: ["card", "navigation_trigger"],
      typeBasis: "declared_aria",
    };
    expect(componentHeldoutKey(base)).toBe("capture|desktop|node-1");
    expect(componentHeldoutKey(relabeled)).toBe(componentHeldoutKey(base));
  });

  it("uses the same key in the full review, blind review and labels", () => {
    const out = mkdtempSync(join(tmpdir(), "atlas-component-heldout-"));
    try {
      const review = reviewWith([row(1, "button"), row(2, "link")]);
      const files = writeHeldoutComponentReview(review, out);
      const blind = JSON.parse(readFileSync(files.blind, "utf8"));
      const labels = JSON.parse(readFileSync(files.labels, "utf8"));
      const expected = review.components.map(componentHeldoutKey);
      expect(blind.components.map((component: { key: string }) => component.key)).toEqual(
        expected,
      );
      expect(Object.keys(labels)).toEqual(expected);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("never overwrites existing human labels on re-collect", () => {
    const out = mkdtempSync(join(tmpdir(), "atlas-component-heldout-"));
    try {
      const firstReview = reviewWith([row(1, "button")]);
      const files = writeHeldoutComponentReview(firstReview, out);
      const humanLabels = { [componentHeldoutKey(firstReview.components[0]!)]: ["button"] };
      writeFileSync(files.labels, JSON.stringify(humanLabels));

      const second = writeHeldoutComponentReview(
        reviewWith([row(1, "button"), row(2, "link")]),
        out,
      );
      expect(JSON.parse(readFileSync(second.labels, "utf8"))).toEqual(humanLabels);
      const blind = JSON.parse(readFileSync(second.blind, "utf8"));
      expect(blind.components).toHaveLength(2);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("excludes an accepted inferred row from the blind export", () => {
    const out = mkdtempSync(join(tmpdir(), "atlas-component-heldout-"));
    try {
      const review = reviewWith([row(1, "card", "accepted")]);
      const files = writeHeldoutComponentReview(review, out);
      const blind = JSON.parse(readFileSync(files.blind, "utf8"));
      const labels = JSON.parse(readFileSync(files.labels, "utf8"));
      expect(blind.components).toEqual([]);
      expect(labels).toEqual({});
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("offers native/declared labels and excludes inferred types", () => {
    expect(HELDOUT_COMPONENT_LABELS).toContain("navigation_trigger");
    expect(HELDOUT_COMPONENT_LABELS).toContain("breadcrumb");
    expect(HELDOUT_COMPONENT_LABELS).toContain("pagination");
    expect(HELDOUT_COMPONENT_LABELS).toContain("none");
    expect(HELDOUT_COMPONENT_LABELS).toContain("ambiguous");
    for (const inferred of ATLAS_INFERRED_COMPONENT_TYPES) {
      expect(HELDOUT_COMPONENT_LABELS).not.toContain(inferred);
    }
  });

  it("scores accepted native types only and fails below 95% precision", () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, index) => row(index, "button")),
      ...Array.from({ length: 5 }, (_, index) => row(100 + index, "card", "candidate")),
    ];
    const labels: Record<string, string[]> = {};
    rows.forEach((item, index) => {
      if (item.typeDecision !== "accepted") return;
      labels[componentHeldoutKey(item)] = [index < 18 ? "button" : "link"];
    });
    const report = scoreHeldoutComponents(reviewWith(rows), labels);
    expect(report.acceptedComponents).toBe(20);
    expect(report.candidateComponents).toBe(5);
    expect(report.perType).toHaveLength(1);
    expect(report.perType[0]).toMatchObject({
      type: "button",
      support: 20,
      truePositives: 18,
      falsePositives: 2,
      precision: 0.9,
      status: "fail",
    });
    expect(report.gate).toBe("fail");
  });

  it("passes a type at exactly 95% with 20 samples and reports 19 as insufficient", () => {
    const passRows = Array.from({ length: 20 }, (_, index) => row(index, "button"));
    const pass = scoreHeldoutComponents(reviewWith(passRows), labelsFor(passRows, 19));
    expect(pass.perType[0]).toMatchObject({ precision: 0.95, status: "pass", support: 20 });
    expect(pass.gate).toBe("pass");

    const fewRows = Array.from({ length: 19 }, (_, index) => row(index, "button"));
    const few = scoreHeldoutComponents(reviewWith(fewRows), labelsFor(fewRows, 19));
    expect(few.perType[0]?.status).toBe("insufficient");
    expect(few.gate).toBe("insufficient");
  });

  it("fails at 47 of 50 (0.94) so the 0.95 threshold cannot drift down", () => {
    const rows = Array.from({ length: 50 }, (_, index) => row(index, "button"));
    const report = scoreHeldoutComponents(reviewWith(rows), labelsFor(rows, 47));
    expect(report.perType[0]).toMatchObject({
      support: 50,
      truePositives: 47,
      falsePositives: 3,
      precision: 0.94,
      status: "fail",
    });
    expect(report.gate).toBe("fail");
  });

  it("aggregates support across a corpus", () => {
    const first = reviewWith([row(1, "button")]);
    first.captureKey = "capture-1";
    first.components[0]!.captureKey = "capture-1";
    const second = reviewWith([row(2, "button"), row(3, "link")]);
    second.captureKey = "capture-2";
    for (const component of second.components) component.captureKey = "capture-2";
    const labels: Record<string, string[]> = {};
    for (const review of [first, second]) {
      for (const component of review.components) {
        labels[componentHeldoutKey(component)] = [component.acceptedTypes[0]!];
      }
    }
    const report = scoreHeldoutComponentCorpus([first, second], labels);
    expect(report.totalComponents).toBe(3);
    expect(report.perType.map((item) => [item.type, item.support])).toEqual([
      ["button", 2],
      ["link", 1],
    ]);
    expect(report.gate).toBe("insufficient");
  });

  it("rejects an empty corpus", () => {
    expect(errorCode(() => scoreHeldoutComponentCorpus([], {}))).toBe(
      "HELDOUT_COMPONENT_EMPTY_CORPUS",
    );
  });

  it("keeps fail ahead of insufficient when both statuses are present", () => {
    const failing = Array.from({ length: 20 }, (_, index) => row(index, "button"));
    const scarce = Array.from({ length: 19 }, (_, index) => row(100 + index, "link"));
    const labels: Record<string, string[]> = {};
    failing.forEach((item, index) => {
      labels[componentHeldoutKey(item)] = [index < 18 ? "button" : "link"];
    });
    for (const item of scarce) labels[componentHeldoutKey(item)] = ["link"];
    const report = scoreHeldoutComponents(reviewWith([...failing, ...scarce]), labels);
    expect(report.perType.map((item) => item.status).sort()).toEqual(["fail", "insufficient"]);
    expect(report.gate).toBe("fail");
  });

  it("requires a label for every accepted component", () => {
    const review = reviewWith([row(1, "button")]);
    expect(() => scoreHeldoutComponents(review, {})).toThrow(HeldoutComponentError);
    try {
      scoreHeldoutComponents(review, {});
    } catch (error) {
      expect((error as HeldoutComponentError).code).toBe("HELDOUT_COMPONENT_MISSING_LABEL");
    }
  });

  it("rejects unknown labels and unknown keys", () => {
    const review = reviewWith([row(1, "button")]);
    const key = componentHeldoutKey(review.components[0]!);
    expect(() => scoreHeldoutComponents(review, { [key]: ["not-a-type"] })).toThrow(
      /Unknown component label/,
    );
    expect(() => scoreHeldoutComponents(review, { "unknown|desktop|region": ["button"] })).toThrow(
      /Unknown component annotation keys/,
    );
  });

  it("invalidates an accepted prediction of none instead of counting it", () => {
    const review = reviewWith([{ ...row(1, "button"), acceptedTypes: ["none"] }]);
    const key = componentHeldoutKey(review.components[0]!);
    const report = scoreHeldoutComponents(review, { [key]: ["button"] });
    expect(report.invalidAcceptedRows).toEqual([key]);
    expect(report.perType).toEqual([]);
    expect(report.gate).toBe("fail");
  });

  it("invalidates an accepted row derived by rule instead of counting it", () => {
    const review = reviewWith([{ ...row(1, "button"), typeBasis: "rule_derivation" }]);
    const key = componentHeldoutKey(review.components[0]!);
    const report = scoreHeldoutComponents(review, { [key]: ["button"] });
    expect(report.invalidAcceptedRows).toEqual([key]);
    expect(report.perType).toEqual([]);
    expect(report.gate).toBe("fail");
  });

  it("invalidates an accepted prediction outside the label vocabulary", () => {
    const review = reviewWith([{ ...row(1, "button"), acceptedTypes: ["carousel"] }]);
    const key = componentHeldoutKey(review.components[0]!);
    const report = scoreHeldoutComponents(review, { [key]: ["button"] });
    expect(report.invalidAcceptedRows).toEqual([key]);
    expect(report.perType).toEqual([]);
    expect(report.gate).toBe("fail");
  });

  it("invalidates an accepted prediction with two types", () => {
    const review = reviewWith([{ ...row(1, "button"), acceptedTypes: ["button", "link"] }]);
    const key = componentHeldoutKey(review.components[0]!);
    const report = scoreHeldoutComponents(review, { [key]: ["button"] });
    expect(report.invalidAcceptedRows).toEqual([key]);
    expect(report.perType).toEqual([]);
    expect(report.gate).toBe("fail");
  });

  it("invalidates an accepted row missing acceptedTypes without crashing", () => {
    const broken = {
      ...row(1, "button"),
      acceptedTypes: undefined,
    } as unknown as HeldoutComponentRow;
    const key = componentHeldoutKey(broken);
    const report = scoreHeldoutComponents(reviewWith([broken]), { [key]: ["button"] });
    expect(report.invalidAcceptedRows).toEqual([key]);
    expect(report.acceptedComponents).toBe(1);
    expect(report.labeledAccepted).toBe(0);
    expect(report.perType).toEqual([]);
    expect(report.gate).toBe("fail");
  });

  it("excludes an accepted inferred button from the denominator and the blind export", () => {
    const inferred = { ...row(1, "button"), typeClassification: "inferred" as const };
    const report = scoreHeldoutComponents(reviewWith([inferred]), {});
    expect(report.inferredComponents).toBe(1);
    expect(report.acceptedComponents).toBe(0);
    expect(report.candidateComponents).toBe(1);
    expect(report.labeledAccepted).toBe(0);
    expect(report.perType).toEqual([]);
    expect(report.gate).toBe("insufficient");

    const out = mkdtempSync(join(tmpdir(), "atlas-component-heldout-"));
    try {
      const files = writeHeldoutComponentReview(reviewWith([inferred]), out);
      expect(JSON.parse(readFileSync(files.blind, "utf8")).components).toEqual([]);
      expect(JSON.parse(readFileSync(files.labels, "utf8"))).toEqual({});
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("rejects a non-array annotation object instead of counting a true positive", () => {
    const review = reviewWith([row(1, "button")]);
    const key = componentHeldoutKey(review.components[0]!);
    const annotation = { 0: "button", length: 1 };
    expect(
      errorCode(() =>
        scoreHeldoutComponents(review, {
          [key]: annotation,
        } as unknown as Record<string, string[]>),
      ),
    ).toBe("HELDOUT_COMPONENT_INVALID_LABEL");
  });

  it("rejects duplicate component keys within one review", () => {
    const first = row(1, "button");
    const second = { ...row(2, "button"), nodeKey: first.nodeKey };
    expect(errorCode(() => scoreHeldoutComponents(reviewWith([first, second]), {}))).toBe(
      "HELDOUT_COMPONENT_DUPLICATE_KEY",
    );
  });

  it("refuses duplicate nodeKey rows before writing anything", () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-component-heldout-"));
    try {
      const first = row(1, "button");
      const review = reviewWith([first, { ...row(2, "button"), nodeKey: first.nodeKey }]);
      const out = join(root, "out");
      expect(errorCode(() => writeHeldoutComponentReview(review, out))).toBe(
        "HELDOUT_COMPONENT_DUPLICATE_KEY",
      );
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exports only scorable accepted rows to blind review and labels", () => {
    const out = mkdtempSync(join(tmpdir(), "atlas-component-heldout-"));
    try {
      const review = reviewWith([
        row(1, "button"),
        { ...row(2, "button"), acceptedTypes: ["none"] },
        { ...row(3, "button"), typeBasis: "rule_derivation" },
        { ...row(4, "button"), acceptedTypes: ["button", "link"] },
        row(5, "card"),
      ]);
      const files = writeHeldoutComponentReview(review, out);
      const blind = JSON.parse(readFileSync(files.blind, "utf8"));
      const labels = JSON.parse(readFileSync(files.labels, "utf8"));
      const expected = [componentHeldoutKey(review.components[0]!)];
      expect(blind.components.map((component: { key: string }) => component.key)).toEqual(
        expected,
      );
      expect(Object.keys(labels)).toEqual(expected);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("reports aggregates and keeps accepted inferred rows out of the denominator", () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, index) => row(index, "button")),
      row(100, "card"),
    ];
    const report = scoreHeldoutComponents(reviewWith(rows), labelsFor(rows, 20));
    expect(report.inferredComponents).toBe(1);
    expect(report.acceptedComponents).toBe(20);
    expect(report.candidateComponents).toBe(1);
    expect(report.labeledAccepted).toBe(20);
    expect(report.invalidAcceptedRows).toEqual([]);
    expect(report.perType).toHaveLength(1);
    expect(report.macroPrecision).toBe(1);
    expect(report.gate).toBe("pass");
  });

  it("accepts none and ambiguous truth labels and counts the prediction as a false positive", () => {
    for (const truth of ["none", "ambiguous"]) {
      const review = reviewWith([row(1, "button")]);
      const key = componentHeldoutKey(review.components[0]!);
      const report = scoreHeldoutComponents(review, { [key]: [truth] });
      expect(report.perType).toHaveLength(1);
      expect(report.perType[0]).toMatchObject({
        type: "button",
        truePositives: 0,
        falsePositives: 1,
        support: 1,
        status: "insufficient",
      });
      expect(report.labeledAccepted).toBe(1);
      expect(report.gate).toBe("insufficient");
    }
  });

  it("rejects an empty label array and a label with two values", () => {
    const review = reviewWith([row(1, "button")]);
    const key = componentHeldoutKey(review.components[0]!);
    expect(errorCode(() => scoreHeldoutComponents(review, { [key]: [] }))).toBe(
      "HELDOUT_COMPONENT_MISSING_LABEL",
    );
    expect(errorCode(() => scoreHeldoutComponents(review, { [key]: ["button", "link"] }))).toBe(
      "HELDOUT_COMPONENT_INVALID_LABEL",
    );
  });

  it("rejects inherited and non-array labels instead of passing", () => {
    const review = reviewWith([row(1, "button")]);
    const key = componentHeldoutKey(review.components[0]!);
    const inherited = Object.create({ [key]: ["button"] }) as Record<string, string[]>;
    expect(errorCode(() => scoreHeldoutComponents(review, inherited))).toBe(
      "HELDOUT_COMPONENT_MISSING_LABEL",
    );
    expect(
      errorCode(() =>
        scoreHeldoutComponents(review, { [key]: "button" } as unknown as Record<string, string[]>),
      ),
    ).toBe("HELDOUT_COMPONENT_INVALID_LABEL");
    expect(
      errorCode(() =>
        scoreHeldoutComponents(review, { [key]: [1] } as unknown as Record<string, string[]>),
      ),
    ).toBe("HELDOUT_COMPONENT_INVALID_LABEL");
  });
});

describe("component corpus loader", () => {
  function corpusRoot(): string {
    return mkdtempSync(join(tmpdir(), "atlas-component-corpus-"));
  }

  it("rejects a page with a review but no labels file", () => {
    const root = corpusRoot();
    try {
      const dir = join(root, "page-a");
      mkdirSync(dir);
      writeFileSync(
        join(dir, "components-review-full.json"),
        JSON.stringify(reviewWith([row(1, "button")])),
      );
      expect(errorCode(() => loadHeldoutComponentCorpus(root))).toBe(
        "HELDOUT_COMPONENT_INCOMPLETE_PAGE",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an empty corpus", () => {
    const root = corpusRoot();
    try {
      expect(errorCode(() => loadHeldoutComponentCorpus(root))).toBe(
        "HELDOUT_COMPONENT_EMPTY_CORPUS",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a duplicate annotation key across pages", () => {
    const root = corpusRoot();
    try {
      const review = reviewWith([row(1, "button")]);
      const key = componentHeldoutKey(review.components[0]!);
      writePage(root, "page-a", review, { [key]: ["button"] });
      writePage(root, "page-b", reviewWith([row(1, "button")]), { [key]: ["button"] });
      let caught: HeldoutComponentError | undefined;
      try {
        loadHeldoutComponentCorpus(root);
      } catch (error) {
        caught = error as HeldoutComponentError;
      }
      expect(caught?.code).toBe("HELDOUT_COMPONENT_DUPLICATE_KEY");
      expect(caught?.message).toContain("page-b");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes the page directory in a within-page duplicate key error", () => {
    const root = corpusRoot();
    try {
      const first = row(1, "button");
      const review = reviewWith([first, { ...row(2, "button"), nodeKey: first.nodeKey }]);
      writePage(root, "page-a", review, {});
      let caught: HeldoutComponentError | undefined;
      try {
        loadHeldoutComponentCorpus(root);
      } catch (error) {
        caught = error as HeldoutComponentError;
      }
      expect(caught?.code).toBe("HELDOUT_COMPONENT_DUPLICATE_KEY");
      expect(caught?.message).toContain("page-a");
      expect(caught?.message).toContain("node keys");
      expect(caught?.message).toContain(`${componentHeldoutKey(first)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes the page directory in a missing-label error", () => {
    const root = corpusRoot();
    try {
      writePage(root, "page-a", reviewWith([row(1, "button")]), {});
      let caught: HeldoutComponentError | undefined;
      try {
        loadHeldoutComponentCorpus(root);
      } catch (error) {
        caught = error as HeldoutComponentError;
      }
      expect(caught?.code).toBe("HELDOUT_COMPONENT_MISSING_LABEL");
      // The page is named once: a second "(page ...)" suffix is a regression.
      expect(occurrences(caught?.message ?? "", "page-a")).toBe(1);
      expect(occurrences(caught?.message ?? "", "(page ")).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects reserved __proto__, constructor and prototype label keys", () => {
    for (const reserved of ["__proto__", "constructor", "prototype"]) {
      const root = corpusRoot();
      try {
        const dir = join(root, "page-a");
        mkdirSync(dir);
        writeFileSync(
          join(dir, "components-review-full.json"),
          JSON.stringify(reviewWith([row(1, "button")])),
        );
        writeFileSync(
          join(dir, "component-labels.json"),
          JSON.stringify({ [reserved]: ["button"] }),
        );
        let caught: HeldoutComponentError | undefined;
        try {
          loadHeldoutComponentCorpus(root);
        } catch (error) {
          caught = error as HeldoutComponentError;
        }
        expect(caught?.code).toBe("HELDOUT_COMPONENT_RESERVED_KEY");
        expect(caught?.message).toContain("page-a");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("reports an unreadable corpus root as a typed error", () => {
    const root = corpusRoot();
    try {
      expect(errorCode(() => loadHeldoutComponentCorpus(join(root, "missing")))).toBe(
        "HELDOUT_COMPONENT_INVALID_CORPUS",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports malformed review JSON as a typed error", () => {
    const root = corpusRoot();
    try {
      const dir = join(root, "page-a");
      mkdirSync(dir);
      writeFileSync(join(dir, "components-review-full.json"), '{"components": [');
      writeFileSync(join(dir, "component-labels.json"), "{}");
      expect(errorCode(() => loadHeldoutComponentCorpus(root))).toBe(
        "HELDOUT_COMPONENT_INVALID_REVIEW",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes the page directory in loader errors", () => {
    for (const [reviewText, labelsText, code] of [
      ['{"components": [', "{}", "HELDOUT_COMPONENT_INVALID_REVIEW"],
      [JSON.stringify(reviewWith([row(1, "button")])), "{bad json", "HELDOUT_COMPONENT_INVALID_LABEL"],
    ] as const) {
      const root = corpusRoot();
      try {
        const dir = join(root, "page-a");
        mkdirSync(dir);
        writeFileSync(join(dir, "components-review-full.json"), reviewText);
        writeFileSync(join(dir, "component-labels.json"), labelsText);
        let caught: HeldoutComponentError | undefined;
        try {
          loadHeldoutComponentCorpus(root);
        } catch (error) {
          caught = error as HeldoutComponentError;
        }
        expect(caught?.code).toBe(code);
        // The loader message already carries the page path; pageContext must
        // not append it a second time.
        expect(occurrences(caught?.message ?? "", "page-a")).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects malformed review rows with the file path and row index", () => {
    for (const bad of [
      null,
      42,
      { selector: "#x" },
      { ...row(1, "button"), acceptedTypes: undefined },
    ]) {
      const root = corpusRoot();
      try {
        const dir = join(root, "page-a");
        mkdirSync(dir);
        const review = reviewWith([row(1, "button")]) as unknown as {
          components: unknown[];
        };
        review.components[0] = bad;
        writeFileSync(join(dir, "components-review-full.json"), JSON.stringify(review));
        writeFileSync(join(dir, "component-labels.json"), "{}");
        let caught: HeldoutComponentError | undefined;
        try {
          loadHeldoutComponentCorpus(root);
        } catch (error) {
          caught = error as HeldoutComponentError;
        }
        expect(caught?.code).toBe("HELDOUT_COMPONENT_INVALID_REVIEW");
        expect(caught?.message).toContain(join("page-a", "components-review-full.json"));
        expect(caught?.message).toContain("row 0");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects an array, a wrong schemaVersion and non-array components", () => {
    for (const review of [
      [],
      { ...reviewWith([]), schemaVersion: "awwwards-atlas-component-review-v0" },
      { ...reviewWith([]), components: {} },
    ]) {
      const root = corpusRoot();
      try {
        writePage(root, "page-a", review as unknown as HeldoutComponentReview, {});
        expect(errorCode(() => loadHeldoutComponentCorpus(root))).toBe(
          "HELDOUT_COMPONENT_INVALID_REVIEW",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects labels that are not a plain object", () => {
    for (const raw of ["null", "[]", '"button"', "{bad json"]) {
      const root = corpusRoot();
      try {
        const dir = join(root, "page-a");
        mkdirSync(dir);
        writeFileSync(
          join(dir, "components-review-full.json"),
          JSON.stringify(reviewWith([row(1, "button")])),
        );
        writeFileSync(join(dir, "component-labels.json"), raw);
        expect(errorCode(() => loadHeldoutComponentCorpus(root))).toBe(
          "HELDOUT_COMPONENT_INVALID_LABEL",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("validates labels against the page that owns the review", () => {
    const root = corpusRoot();
    try {
      const first = reviewWith([row(1, "button")]);
      first.captureKey = "capture-1";
      first.components[0]!.captureKey = "capture-1";
      const second = reviewWith([row(2, "button")]);
      second.captureKey = "capture-2";
      second.components[0]!.captureKey = "capture-2";
      const foreignKey = componentHeldoutKey(second.components[0]!);
      writePage(root, "page-a", first, { [foreignKey]: ["button"] });
      writePage(root, "page-b", second, { [foreignKey]: ["button"] });
      let caught: HeldoutComponentError | undefined;
      try {
        loadHeldoutComponentCorpus(root);
      } catch (error) {
        caught = error as HeldoutComponentError;
      }
      expect(caught?.code).toBe("HELDOUT_COMPONENT_UNKNOWN_KEY");
      expect(caught?.message).toContain("page-a");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("merges a valid two-page corpus into a null-prototype map", () => {
    const root = corpusRoot();
    try {
      const first = reviewWith([row(1, "button")]);
      first.captureKey = "capture-1";
      first.components[0]!.captureKey = "capture-1";
      const second = reviewWith([row(2, "link")]);
      second.captureKey = "capture-2";
      second.components[0]!.captureKey = "capture-2";
      const firstKey = componentHeldoutKey(first.components[0]!);
      const secondKey = componentHeldoutKey(second.components[0]!);
      writePage(root, "page-a", first, { [firstKey]: ["button"] });
      writePage(root, "page-b", second, { [secondKey]: ["link"] });

      const corpus = loadHeldoutComponentCorpus(root);
      expect(corpus.reviews.map((review) => review.captureKey)).toEqual([
        "capture-1",
        "capture-2",
      ]);
      expect(Object.keys(corpus.labels).sort()).toEqual([firstKey, secondKey].sort());
      expect(corpus.labels[firstKey]).toEqual(["button"]);
      expect(corpus.labels[secondKey]).toEqual(["link"]);
      expect(Object.getPrototypeOf(corpus.labels)).toBeNull();

      const report = scoreHeldoutComponentCorpus(corpus.reviews, corpus.labels);
      expect(report.perType.map((item) => [item.type, item.support])).toEqual([
        ["button", 1],
        ["link", 1],
      ]);
      expect(report.gate).toBe("insufficient");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked or junction page directory instead of skipping it", (ctx) => {
    const root = corpusRoot();
    const external = mkdtempSync(join(tmpdir(), "atlas-component-page-"));
    try {
      const page = writePage(external, "page-a", reviewWith([row(1, "button")]), {});
      const link = join(root, "page-linked");
      if (!linkDirectory(page, link)) return ctx.skip();
      let caught: HeldoutComponentError | undefined;
      try {
        loadHeldoutComponentCorpus(root);
      } catch (error) {
        caught = error as HeldoutComponentError;
      }
      expect(caught?.code).toBe("HELDOUT_COMPONENT_INVALID_CORPUS");
      expect(caught?.message).toContain("Symlinked page directories are refused");
      expect(caught?.message).toContain(link);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("ignores a symlinked file instead of refusing the corpus", (ctx) => {
    const root = corpusRoot();
    const external = mkdtempSync(join(tmpdir(), "atlas-component-file-"));
    try {
      const review = reviewWith([row(1, "button")]);
      writePage(root, "page-a", review, labelsFor(review.components, 1));
      const target = join(external, "stray.txt");
      writeFileSync(target, "stray");
      const link = join(root, "stray.txt");
      try {
        symlinkSync(target, link, "file");
      } catch (error) {
        if (LINK_ERRORS.has((error as NodeJS.ErrnoException).code ?? "")) return ctx.skip();
        throw error;
      }
      expect(loadHeldoutComponentCorpus(root).reviews).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("ignores a broken link instead of refusing the corpus", (ctx) => {
    const root = corpusRoot();
    try {
      const review = reviewWith([row(1, "button")]);
      writePage(root, "page-a", review, labelsFor(review.components, 1));
      if (!linkDirectory(join(root, "missing-target"), join(root, "dangling"))) {
        return ctx.skip();
      }
      expect(loadHeldoutComponentCorpus(root).reviews).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports an unreadable link as a typed corpus error with the link path", (ctx) => {
    const root = corpusRoot();
    try {
      const loop = join(root, "loop");
      if (!linkDirectory(loop, loop)) return ctx.skip();
      let caught: HeldoutComponentError | undefined;
      try {
        loadHeldoutComponentCorpus(root);
      } catch (error) {
        caught = error as HeldoutComponentError;
      }
      expect(caught?.code).toBe("HELDOUT_COMPONENT_INVALID_CORPUS");
      expect(caught?.message).toContain(loop);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is report-only: a failing gate still exits 0 with an empty stderr", () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-component-cli-"));
    try {
      const rows = Array.from({ length: 20 }, (_, index) => row(index, "button"));
      const reviewPath = join(root, "components-review-full.json");
      const labelsPath = join(root, "component-labels.json");
      writeFileSync(reviewPath, JSON.stringify(reviewWith(rows)));
      writeFileSync(labelsPath, JSON.stringify(labelsFor(rows, 18)));
      const run = runScoreComponents(reviewPath, labelsPath);
      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      const report = JSON.parse(run.stdout) as { gate: string };
      expect(report.gate).toBe("fail");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a typed CLI error for a blind file or a malformed review", () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-component-cli-"));
    try {
      const labelsPath = join(root, "component-labels.json");
      writeFileSync(labelsPath, "{}");
      const blindPath = join(root, "components-review.json");
      writeFileSync(
        blindPath,
        JSON.stringify({
          schemaVersion: "awwwards-atlas-component-blind-v1",
          acceptedOnly: true,
          components: [],
        }),
      );
      const blind = runScoreComponents(blindPath, labelsPath);
      expect(blind.status).toBe(1);
      expect(blind.stdout).toBe("");
      expect(blind.stderr).toContain("HELDOUT_COMPONENT_INVALID_REVIEW");
      expect(blind.stderr.split("\n")).toHaveLength(2);

      const malformedPath = join(root, "components-review-full.json");
      writeFileSync(
        malformedPath,
        JSON.stringify({
          ...reviewWith([row(1, "button")]),
          components: [{ selector: "#x" }],
        }),
      );
      const malformed = runScoreComponents(malformedPath, labelsPath);
      expect(malformed.status).toBe(1);
      expect(malformed.stdout).toBe("");
      expect(malformed.stderr).toContain("HELDOUT_COMPONENT_INVALID_REVIEW");
      expect(malformed.stderr.split("\n")).toHaveLength(2);

      const newlinePath = join(root, "components-review-newline.json");
      writeFileSync(newlinePath, '{\n "components": [oops\n]}');
      const newline = runScoreComponents(newlinePath, labelsPath);
      expect(newline.status).toBe(1);
      expect(newline.stdout).toBe("");
      expect(newline.stderr).toContain("HELDOUT_COMPONENT_INVALID_REVIEW");
      expect(newline.stderr.split("\n")).toHaveLength(2);
      expect(newline.stderr).not.toContain("\r");

      const crlfPath = join(root, "components-review-crlf.json");
      writeFileSync(crlfPath, '{\r\n "components": [oops\r\n]}');
      const crlf = runScoreComponents(crlfPath, labelsPath);
      expect(crlf.status).toBe(1);
      expect(crlf.stdout).toBe("");
      expect(crlf.stderr).toContain("HELDOUT_COMPONENT_INVALID_REVIEW");
      expect(crlf.stderr).not.toContain("\r");
      expect(crlf.stderr.split("\n")).toHaveLength(2);

      const crPath = join(root, "components-review-cr.json");
      writeFileSync(crPath, '{\r "components": [oops\r]}');
      const cr = runScoreComponents(crPath, labelsPath);
      expect(cr.status).toBe(1);
      expect(cr.stdout).toBe("");
      expect(cr.stderr).toContain("HELDOUT_COMPONENT_INVALID_REVIEW");
      expect(cr.stderr).not.toContain("\r");
      expect(cr.stderr.split("\n")).toHaveLength(2);

      const labelRoot = join(root, "newline-label");
      mkdirSync(labelRoot);
      const labelRow = row(1, "button");
      const labelReview = join(labelRoot, "components-review-full.json");
      const labelFile = join(labelRoot, "component-labels.json");
      writeFileSync(labelReview, JSON.stringify(reviewWith([labelRow])));
      writeFileSync(
        labelFile,
        JSON.stringify({ [componentHeldoutKey(labelRow)]: ["bad\nlabel"] }),
      );
      const labelRun = runScoreComponents(labelReview, labelFile);
      expect(labelRun.status).toBe(1);
      expect(labelRun.stdout).toBe("");
      expect(labelRun.stderr).toContain("HELDOUT_COMPONENT_INVALID_LABEL");
      expect(labelRun.stderr.split("\n")).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    "reports corpus, duplicate and collect failures as one typed stderr line",
    () => {
      const root = mkdtempSync(join(tmpdir(), "atlas-component-cli-"));
      try {
        const corpus = runCli(["score-components-corpus", join(root, "missing")]);
        expect(corpus.status).toBe(1);
        expect(corpus.stdout).toBe("");
        expect(corpus.stderr).toContain("HELDOUT_COMPONENT_INVALID_CORPUS");
        expect(corpus.stderr.split("\n")).toHaveLength(2);

        const first = row(1, "button");
        const duplicatePath = join(root, "duplicate.json");
        writeFileSync(
          duplicatePath,
          JSON.stringify(
            reviewWith([first, { ...row(2, "button"), nodeKey: first.nodeKey }]),
          ),
        );
        const labelsPath = join(root, "empty-labels.json");
        writeFileSync(labelsPath, "{}");
        const duplicate = runCli(["score-components", duplicatePath, labelsPath]);
        expect(duplicate.status).toBe(1);
        expect(duplicate.stdout).toBe("");
        expect(duplicate.stderr).toContain("HELDOUT_COMPONENT_DUPLICATE_KEY");
        expect(duplicate.stderr.split("\n")).toHaveLength(2);

        const collect = runCli([
          "collect-components",
          root,
          "not a slug!",
          join(root, "out"),
        ]);
        expect(collect.status).toBe(1);
        expect(collect.stdout).toBe("");
        expect(collect.stderr).toContain("INVALID_SITE_SLUG");
        expect(collect.stderr.split("\n")).toHaveLength(2);
        expect(existsSync(join(root, "out"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
