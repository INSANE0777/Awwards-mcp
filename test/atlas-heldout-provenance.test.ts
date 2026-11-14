import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  HELDOUT_RULE_SOURCES,
  componentHeldoutKey,
  heldoutRuleFingerprint,
  writeHeldoutComponentReview,
} from "../src/atlas/heldout.js";
import type {
  HeldoutComponentReview,
  HeldoutComponentRow,
} from "../src/atlas/heldout.js";
import { ATLAS_COMPONENT_RULE_VERSION } from "../src/atlas/components.js";
import { sha256Text, stableHash } from "../src/atlas/identity.js";

const ROOT = join(import.meta.dirname, "..");
const TSX_CLI = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const HELDOUT_CLI = join(ROOT, "src", "atlas", "heldout-cli.ts");
const TIMEOUT = 60_000;

function runCli(args: string[]) {
  return spawnSync(process.execPath, [TSX_CLI, HELDOUT_CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
}

function row(index: number): HeldoutComponentRow {
  return {
    captureKey: "capture",
    viewport: "desktop",
    selector: `#c${index}`,
    nodeKey: `node-${index}`,
    regionKey: `region-${index}`,
    tag: "button",
    role: null,
    accessibleName: `Item ${index}`,
    sectionHeading: "Hero",
    rect: { x: 0, y: index, width: 10, height: 10 },
    screenshotKeys: ["shot-1"],
    inputType: null,
    ariaHasPopup: false,
    ariaExpanded: null,
    ariaControlsResolved: false,
    inNavigation: false,
    ariaLabel: `Label ${index}`,
    candidateTypes: [],
    acceptedTypes: ["button"],
    typeBasis: "native_semantics",
    typeClassification: "observed",
    typeDecision: "accepted",
  };
}

const FINGERPRINT = heldoutRuleFingerprint();

function reviewWith(rows: HeldoutComponentRow[], captureKey = "capture"): HeldoutComponentReview {
  for (const component of rows) component.captureKey = captureKey;
  return {
    schemaVersion: "awwwards-atlas-component-review-v1",
    captureKey,
    capturedAt: 1,
    siteSlug: "site",
    requestedUrl: "https://example.com/",
    status: "complete",
    limitations: [],
    error: null,
    coverage: { status: "complete", collected: rows.length, excluded: 0, limitations: [] },
    ruleVersion: FINGERPRINT.version,
    ruleHash: FINGERPRINT.hash,
    components: rows,
  };
}

function labelsFor(
  rows: HeldoutComponentRow[],
  correct: number,
): Record<string, string[]> {
  const labels: Record<string, string[]> = {};
  rows.forEach((component, index) => {
    labels[componentHeldoutKey(component)] = [index < correct ? "button" : "link"];
  });
  return labels;
}

function pageDir(root: string, name: string): string {
  return join(root, name);
}

function writeLabeledPage(
  root: string,
  name: string,
  review: HeldoutComponentReview,
  labels: Record<string, string[]>,
): string {
  const dir = pageDir(root, name);
  writeHeldoutComponentReview(review, dir);
  writeFileSync(join(dir, "component-labels.json"), JSON.stringify(labels));
  return dir;
}

function attestation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "awwwards-atlas-heldout-attestation-v1",
    declaredTypes: ["button"],
    datasetSplit: "heldout",
    provenance: "human",
    reviewers: [
      {
        id: "reviewer-1",
        attestation: "Labeled every blind row independently without seeing predictions.",
      },
    ],
    controller: {
      id: "controller-1",
      attestation: "Reviewed the blind handoff and the reviewer attestation.",
      attestedAt: "2026-11-13",
    },
    ...overrides,
  };
}

function attest(root: string, overrides: Record<string, unknown> = {}) {
  const path = join(root, "attestation.json");
  writeFileSync(path, JSON.stringify(attestation(overrides)));
  return runCli(["attest-components", root, path]);
}

function scoreStrict(root: string, extra: string[] = []) {
  return runCli(["score-components-corpus", root, "--require-pass", ...extra]);
}

function parseStdout(run: ReturnType<typeof runCli>): Record<string, unknown> {
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

function provenanceOf(report: Record<string, unknown>): Record<string, unknown> {
  return report.provenance as Record<string, unknown>;
}

describe("F9 provenance manifest", () => {
  it("hashes every listed rule source, including scan", () => {
    expect(HELDOUT_RULE_SOURCES).toContain("scan");
    // Recompute independently: dropping a listed source from the hash while
    // leaving it in the inventory would otherwise go unnoticed.
    const sources = HELDOUT_RULE_SOURCES.map(
      (name) =>
        [name, sha256Text(readFileSync(join(ROOT, "src", "atlas", `${name}.ts`), "utf8"))] as const,
    );
    expect(heldoutRuleFingerprint()).toEqual({
      version: ATLAS_COMPONENT_RULE_VERSION,
      hash: stableHash(
        "atlas-heldout-rules-v1",
        ATLAS_COMPONENT_RULE_VERSION,
        ...sources.flat(),
      ),
    });
  });

  it(
    "seals declared population, split, reviewer, controller and hashes",
    () => {
      const root = mkdtempSync(join(tmpdir(), "atlas-provenance-"));
      try {
        const rows = Array.from({ length: 20 }, (_, index) => row(index));
        const labels = labelsFor(rows, 19);
        const dir = writeLabeledPage(root, "page-a", reviewWith(rows), labels);
        const labelsBefore = readFileSync(join(dir, "component-labels.json"), "utf8");

        const seal = attest(root);
        expect(seal.status).toBe(0);
        expect(seal.stderr).toBe("");
        const sealed = parseStdout(seal);
        expect(sealed.pages).toBe(1);
        expect(sealed.rulesVersion).toMatch(/^atlas-component-rules-/);
        expect(sealed.rulesHash).toMatch(/^[0-9a-f]{64}$/);
        expect(sealed.corpusHash).toMatch(/^[0-9a-f]{64}$/);

        const manifest = JSON.parse(
          readFileSync(join(root, "provenance.json"), "utf8"),
        ) as Record<string, unknown>;
        expect(manifest.schemaVersion).toBe("awwwards-atlas-heldout-provenance-v1");
        expect(manifest.declaredTypes).toEqual(["button"]);
        expect(manifest.datasetSplit).toBe("heldout");
        expect(manifest.provenance).toBe("human");
        expect(manifest.reviewers).toEqual([
          {
            id: "reviewer-1",
            attestation: "Labeled every blind row independently without seeing predictions.",
          },
        ]);
        expect(manifest.controller).toMatchObject({
          id: "controller-1",
          attestedAt: "2026-11-13",
        });
        const pages = manifest.pages as Array<Record<string, string>>;
        expect(pages).toHaveLength(1);
        expect(pages[0]!.page).toBe("page-a");
        for (const field of ["reviewSha256", "blindSha256", "labelsSha256"]) {
          expect(pages[0]![field]).toMatch(/^[0-9a-f]{64}$/);
        }
        expect(readFileSync(join(dir, "component-labels.json"), "utf8")).toBe(labelsBefore);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  it(
    "passes strict at 19/20 and fails strict at 47/50 while report-only stays 0",
    () => {
      const passRoot = mkdtempSync(join(tmpdir(), "atlas-provenance-pass-"));
      const failRoot = mkdtempSync(join(tmpdir(), "atlas-provenance-fail-"));
      try {
        const passRows = Array.from({ length: 20 }, (_, index) => row(index));
        writeLabeledPage(passRoot, "page-a", reviewWith(passRows), labelsFor(passRows, 19));
        expect(attest(passRoot).status).toBe(0);
        const pass = scoreStrict(passRoot);
        expect(pass.status).toBe(0);
        expect(pass.stderr).toBe("");
        const passReport = parseStdout(pass);
        expect(passReport.gate).toBe("pass");
        expect(provenanceOf(passReport)).toMatchObject({
          kind: "human",
          qualifying: true,
          declaredTypes: ["button"],
        });

        const failRows = Array.from({ length: 50 }, (_, index) => row(index));
        writeLabeledPage(failRoot, "page-a", reviewWith(failRows), labelsFor(failRows, 47));
        expect(attest(failRoot).status).toBe(0);
        const fail = scoreStrict(failRoot);
        expect(fail.status).toBe(3);
        expect(fail.stderr).toBe("");
        const failReport = parseStdout(fail);
        expect(failReport.gate).toBe("fail");
        // The numerical failure is separate from the human evidence qualification.
        expect(provenanceOf(failReport)).toMatchObject({
          kind: "human",
          qualifying: true,
        });

        const reportOnly = runCli(["score-components-corpus", failRoot]);
        expect(reportOnly.status).toBe(0);
        expect(reportOnly.stderr).toBe("");
        expect(parseStdout(reportOnly).gate).toBe("fail");
      } finally {
        rmSync(passRoot, { recursive: true, force: true });
        rmSync(failRoot, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  it(
    "treats 19 samples and a missing declared type as insufficient",
    () => {
      const scarceRoot = mkdtempSync(join(tmpdir(), "atlas-provenance-scarce-"));
      const declaredRoot = mkdtempSync(join(tmpdir(), "atlas-provenance-declared-"));
      try {
        const scarceRows = Array.from({ length: 19 }, (_, index) => row(index));
        writeLabeledPage(
          scarceRoot,
          "page-a",
          reviewWith(scarceRows),
          labelsFor(scarceRows, 19),
        );
        expect(attest(scarceRoot).status).toBe(0);
        const scarce = scoreStrict(scarceRoot);
        expect(scarce.status).toBe(3);
        expect(parseStdout(scarce).gate).toBe("insufficient");

        const rows = Array.from({ length: 20 }, (_, index) => row(index));
        writeLabeledPage(declaredRoot, "page-a", reviewWith(rows), labelsFor(rows, 20));
        expect(attest(declaredRoot, { declaredTypes: ["button", "link"] }).status).toBe(0);
        const declared = scoreStrict(declaredRoot);
        expect(declared.status).toBe(3);
        const report = parseStdout(declared);
        expect(report.gate).toBe("insufficient");
        expect(report.missingDeclaredTypes).toEqual(["link"]);
        expect(report.declaredTypes).toEqual(["button", "link"]);
      } finally {
        rmSync(scarceRoot, { recursive: true, force: true });
        rmSync(declaredRoot, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  it(
    "keeps report-only exits at 0 for valid reports with stale provenance",
    () => {
      const root = mkdtempSync(join(tmpdir(), "atlas-provenance-report-"));
      try {
        const rows = Array.from({ length: 20 }, (_, index) => row(index));
        writeLabeledPage(root, "page-a", reviewWith(rows), labelsFor(rows, 18));
        expect(attest(root).status).toBe(0);

        const labelsPath = join(root, "page-a", "component-labels.json");
        const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as Record<string, string[]>;
        labels[componentHeldoutKey(rows[0]!)] = ["link"];
        writeFileSync(labelsPath, JSON.stringify(labels));

        const run = runCli([
          "score-components-corpus",
          root,
          "--provenance",
          join(root, "provenance.json"),
        ]);
        expect(run.status).toBe(0);
        expect(run.stderr).toBe("");
        const report = parseStdout(run);
        expect(report.gate).toBe("fail");
        const provenance = provenanceOf(report);
        expect(provenance.qualifying).toBe(false);
        expect((provenance.reasons as string[]).join(" ")).toContain("LABELS_CHANGED");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  it(
    "pins strict exits for absent, model, malformed and unqualified evidence",
    () => {
      const root = mkdtempSync(join(tmpdir(), "atlas-provenance-exits-"));
      const malformedRoot = mkdtempSync(join(tmpdir(), "atlas-provenance-bad-"));
      try {
        const rows = Array.from({ length: 20 }, (_, index) => row(index));
        writeLabeledPage(root, "page-a", reviewWith(rows), labelsFor(rows, 20));

        const absent = scoreStrict(root);
        expect(absent.status).toBe(4);
        expect(absent.stderr).toContain("HELDOUT_COMPONENT_PROVENANCE_MISSING");
        expect(absent.stderr.split("\n")).toHaveLength(2);
        expect(provenanceOf(parseStdout(absent))).toMatchObject({
          kind: "absent",
          qualifying: false,
        });

        expect(attest(root, { provenance: "model", reviewers: [] }).status).toBe(0);
        const model = scoreStrict(root);
        expect(model.status).toBe(4);
        expect(model.stderr).toContain("HELDOUT_COMPONENT_PROVENANCE_INVALID");
        expect(model.stderr).toContain("PROVENANCE_NOT_HUMAN");
        expect(provenanceOf(parseStdout(model))).toMatchObject({
          kind: "model",
          qualifying: false,
        });

        expect(attest(root, { datasetSplit: "train" }).status).toBe(0);
        const train = scoreStrict(root);
        expect(train.status).toBe(4);
        expect(train.stderr).toContain("DATASET_SPLIT_NOT_HELDOUT");
        expect(attest(root).status).toBe(0);

        const malformedRows = Array.from({ length: 20 }, (_, index) => row(index));
        const malformedDir = writeLabeledPage(
          malformedRoot,
          "page-a",
          reviewWith(malformedRows),
          labelsFor(malformedRows, 20),
        );
        const validLabels = readFileSync(
          join(malformedDir, "component-labels.json"),
          "utf8",
        );
        writeFileSync(join(malformedDir, "component-labels.json"), "{");
        const malformedLabels = scoreStrict(malformedRoot);
        expect(malformedLabels.status).toBe(1);
        expect(malformedLabels.stdout).toBe("");
        expect(malformedLabels.stderr).toContain("HELDOUT_COMPONENT_INVALID_LABEL");

        writeFileSync(join(malformedDir, "component-labels.json"), validLabels);
        writeFileSync(join(malformedRoot, "provenance.json"), "{");
        const malformedManifest = scoreStrict(malformedRoot);
        expect(malformedManifest.status).toBe(1);
        expect(malformedManifest.stdout).toBe("");
        expect(malformedManifest.stderr).toContain("HELDOUT_COMPONENT_INVALID_PROVENANCE");
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(malformedRoot, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  it(
    "refuses unattested human evidence and invalid declarations",
    () => {
      const root = mkdtempSync(join(tmpdir(), "atlas-provenance-attest-"));
      try {
        const rows = Array.from({ length: 20 }, (_, index) => row(index));
        writeLabeledPage(root, "page-a", reviewWith(rows), labelsFor(rows, 20));

        for (const overrides of [
          { reviewers: [] },
          { declaredTypes: ["none"] },
          { declaredTypes: [] },
          { datasetSplit: "" },
          {
            reviewers: [
              { id: "same", attestation: "First." },
              { id: "same", attestation: "Second." },
            ],
          },
        ]) {
          const run = attest(root, overrides);
          expect(run.status).toBe(1);
          expect(run.stdout).toBe("");
          expect(run.stderr).toContain("HELDOUT_COMPONENT_INVALID_PROVENANCE");
          expect(existsSync(join(root, "provenance.json"))).toBe(false);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  it(
    "refuses a capture made under different rules",
    () => {
      const root = mkdtempSync(join(tmpdir(), "atlas-provenance-capture-rules-"));
      try {
        const rows = Array.from({ length: 20 }, (_, index) => row(index));
        const dir = writeLabeledPage(root, "page-a", reviewWith(rows), labelsFor(rows, 20));
        const reviewPath = join(dir, "components-review-full.json");
        const review = JSON.parse(readFileSync(reviewPath, "utf8")) as Record<string, unknown>;
        review.ruleHash = "0".repeat(64);
        writeFileSync(reviewPath, JSON.stringify(review));

        const staleCapture = attest(root);
        expect(staleCapture.status).toBe(1);
        expect(staleCapture.stderr).toContain("HELDOUT_COMPONENT_INVALID_PROVENANCE");
        expect(staleCapture.stderr).toContain("different rules");
        expect(existsSync(join(root, "provenance.json"))).toBe(false);

        review.ruleHash = FINGERPRINT.hash;
        writeFileSync(reviewPath, JSON.stringify(review));
        expect(attest(root).status).toBe(0);
        review.ruleHash = "0".repeat(64);
        writeFileSync(reviewPath, JSON.stringify(review));
        const stale = scoreStrict(root);
        expect(stale.status).toBe(4);
        expect(stale.stderr).toContain("CAPTURE_RULES_CHANGED");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  it(
    "refuses to re-seal unchanged labels after a rule change",
    () => {
      const root = mkdtempSync(join(tmpdir(), "atlas-provenance-fresh-"));
      try {
        const rows = Array.from({ length: 20 }, (_, index) => row(index));
        const dir = writeLabeledPage(root, "page-a", reviewWith(rows), labelsFor(rows, 20));
        expect(attest(root).status).toBe(0);

        const manifestPath = join(root, "provenance.json");
        const sealed = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
        sealed.rulesHash = "0".repeat(64);
        writeFileSync(manifestPath, JSON.stringify(sealed));

        const reused = attest(root);
        expect(reused.status).toBe(1);
        expect(reused.stderr).toContain("HELDOUT_COMPONENT_INVALID_PROVENANCE");
        expect(reused.stderr).toContain("fresh holdout");

        const labelsPath = join(dir, "component-labels.json");
        const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as Record<string, string[]>;
        labels[componentHeldoutKey(rows[0]!)] = ["link"];
        writeFileSync(labelsPath, JSON.stringify(labels));
        expect(attest(root).status).toBe(0);
        expect(scoreStrict(root).status).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  it(
    "invalidates label, recapture, rule and page-set changes",
    () => {
      const root = mkdtempSync(join(tmpdir(), "atlas-provenance-stale-"));
      try {
        const firstRows = Array.from({ length: 10 }, (_, index) => row(index));
        const secondRows = Array.from({ length: 10 }, (_, index) => row(100 + index));
        const first = reviewWith(firstRows, "capture-a");
        const second = reviewWith(secondRows, "capture-b");
        writeLabeledPage(root, "page-a", first, labelsFor(firstRows, 10));
        writeLabeledPage(root, "page-b", second, labelsFor(secondRows, 10));
        expect(attest(root).status).toBe(0);
        expect(scoreStrict(root).status).toBe(0);

        const labelsPath = join(root, "page-a", "component-labels.json");
        const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as Record<string, string[]>;
        labels[componentHeldoutKey(firstRows[0]!)] = ["link"];
        writeFileSync(labelsPath, JSON.stringify(labels));
        const relabeled = scoreStrict(root);
        expect(relabeled.status).toBe(4);
        expect(relabeled.stderr).toContain("LABELS_CHANGED");
        expect(attest(root).status).toBe(0);
        expect(scoreStrict(root).status).toBe(0);

        const recaptured = { ...first, capturedAt: 2 };
        writeHeldoutComponentReview(recaptured, join(root, "page-a"));
        const staleReview = scoreStrict(root);
        expect(staleReview.status).toBe(4);
        expect(staleReview.stderr).toContain("REVIEW_CHANGED");
        expect(attest(root).status).toBe(0);
        expect(scoreStrict(root).status).toBe(0);

        const manifestPath = join(root, "provenance.json");
        const sealedText = readFileSync(manifestPath, "utf8");
        const tamperedCorpus = JSON.parse(sealedText) as Record<string, unknown>;
        tamperedCorpus.corpusHash = "0".repeat(64);
        writeFileSync(manifestPath, JSON.stringify(tamperedCorpus));
        const staleCorpus = scoreStrict(root);
        expect(staleCorpus.status).toBe(4);
        expect(staleCorpus.stderr).toContain("CORPUS_HASH_MISMATCH");

        const tampered = JSON.parse(sealedText) as Record<string, unknown>;
        tampered.rulesHash = "0".repeat(64);
        writeFileSync(manifestPath, JSON.stringify(tampered));
        const staleRules = scoreStrict(root);
        expect(staleRules.status).toBe(4);
        expect(staleRules.stderr).toContain("RULES_CHANGED");
        writeFileSync(manifestPath, sealedText);

        const thirdRows = Array.from({ length: 5 }, (_, index) => row(200 + index));
        const third = reviewWith(thirdRows, "capture-c");
        writeLabeledPage(root, "page-c", third, labelsFor(thirdRows, 5));
        const stalePages = scoreStrict(root);
        expect(stalePages.status).toBe(4);
        expect(stalePages.stderr).toContain("PAGES_CHANGED");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  it(
    "rejects a narrowed declaredTypes set that was not resealed",
    () => {
      const root = mkdtempSync(join(tmpdir(), "atlas-provenance-declared-narrow-"));
      try {
        const rows = Array.from({ length: 20 }, (_, index) => row(index));
        writeLabeledPage(root, "page-a", reviewWith(rows), labelsFor(rows, 20));
        expect(attest(root, { declaredTypes: ["button", "link"] }).status).toBe(0);

        const manifestPath = join(root, "provenance.json");
        const sealed = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
        expect(sealed.declaredTypes).toEqual(["button", "link"]);
        // Narrow the declaration but keep the old attestation hash: the seal
        // must detect the edit instead of trusting the narrowed list.
        sealed.declaredTypes = ["button"];
        writeFileSync(manifestPath, JSON.stringify(sealed));

        const narrowed = scoreStrict(root);
        expect(narrowed.status).toBe(4);
        expect(narrowed.stderr).toContain("ATTESTATION_MODIFIED");
        expect(narrowed.stderr).not.toContain("DECLARED_TYPES_MISSING");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  it(
    "refuses a prediction nested inside rect before attestation",
    () => {
      const root = mkdtempSync(join(tmpdir(), "atlas-provenance-nested-"));
      try {
        const clean = row(1);
        const malicious = {
          ...clean,
          rect: { ...clean.rect, acceptedTypes: ["button"] },
        } as HeldoutComponentRow;
        const dir = pageDir(root, "page-a");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "components-review-full.json"),
          JSON.stringify(reviewWith([malicious])),
        );
        writeFileSync(
          join(dir, "component-labels.json"),
          JSON.stringify({ [componentHeldoutKey(malicious)]: ["button"] }),
        );

        const seal = attest(root);
        expect(seal.status).toBe(1);
        expect(seal.stdout).toBe("");
        expect(seal.stderr).toContain("HELDOUT_COMPONENT_INVALID_REVIEW");
        expect(existsSync(join(root, "provenance.json"))).toBe(false);
        expect(existsSync(join(dir, "components-review.json"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  it(
    "refuses prediction leakage, blind mutation and a missing blind file",
    () => {
      const root = mkdtempSync(join(tmpdir(), "atlas-provenance-blind-"));
      try {
        const rows = Array.from({ length: 20 }, (_, index) => row(index));
        const dir = writeLabeledPage(root, "page-a", reviewWith(rows), labelsFor(rows, 20));
        expect(attest(root).status).toBe(0);
        const blindPath = join(dir, "components-review.json");
        const blindText = readFileSync(blindPath, "utf8");

        const leaked = JSON.parse(blindText) as {
          components: Array<Record<string, unknown>>;
        };
        leaked.components[0]!.acceptedTypes = ["button"];
        writeFileSync(blindPath, JSON.stringify(leaked));
        const leak = scoreStrict(root);
        expect(leak.status).toBe(1);
        expect(leak.stdout).toBe("");
        expect(leak.stderr).toContain("HELDOUT_COMPONENT_PREDICTION_LEAK");

        const nested = JSON.parse(blindText) as {
          components: Array<{ rect: Record<string, unknown> }>;
        };
        nested.components[0]!.rect.acceptedTypes = ["button"];
        writeFileSync(blindPath, JSON.stringify(nested));
        const nestedLeak = scoreStrict(root);
        expect(nestedLeak.status).toBe(1);
        expect(nestedLeak.stdout).toBe("");
        expect(nestedLeak.stderr).toContain("HELDOUT_COMPONENT_INVALID_BLIND");

        writeFileSync(blindPath, blindText);
        const mutated = JSON.parse(blindText) as {
          components: Array<Record<string, unknown>>;
        };
        mutated.components[0]!.accessibleName = "Relabeled by hand";
        writeFileSync(blindPath, JSON.stringify(mutated));
        const mismatch = scoreStrict(root);
        expect(mismatch.status).toBe(4);
        expect(mismatch.stderr).toContain("BLIND_MISMATCH");

        rmSync(blindPath);
        const missing = scoreStrict(root);
        expect(missing.status).toBe(4);
        expect(missing.stderr).toContain("BLIND_MISSING");
        const reseal = attest(root);
        expect(reseal.status).toBe(1);
        expect(reseal.stderr).toContain("HELDOUT_COMPONENT_INCOMPLETE_PAGE");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  it(
    "requires provenance for strict single-review scoring",
    () => {
      const root = mkdtempSync(join(tmpdir(), "atlas-provenance-single-"));
      try {
        const rows = Array.from({ length: 20 }, (_, index) => row(index));
        const dir = writeLabeledPage(root, "page-a", reviewWith(rows), labelsFor(rows, 19));
        const reviewPath = join(dir, "components-review-full.json");
        const labelsPath = join(dir, "component-labels.json");
        expect(attest(root).status).toBe(0);

        const pass = runCli([
          "score-components",
          reviewPath,
          labelsPath,
          "--provenance",
          join(root, "provenance.json"),
          "--require-pass",
        ]);
        expect(pass.status).toBe(0);
        expect(pass.stderr).toBe("");
        expect(parseStdout(pass).gate).toBe("pass");

        const missing = runCli([
          "score-components",
          reviewPath,
          labelsPath,
          "--require-pass",
        ]);
        expect(missing.status).toBe(4);
        expect(missing.stderr).toContain("HELDOUT_COMPONENT_PROVENANCE_MISSING");

        const reportOnly = runCli(["score-components", reviewPath, labelsPath]);
        expect(reportOnly.status).toBe(0);
        expect(reportOnly.stderr).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  it(
    "still refuses unknown and reserved label keys under strict loading",
    () => {
      const root = mkdtempSync(join(tmpdir(), "atlas-provenance-keys-"));
      try {
        const rows = Array.from({ length: 20 }, (_, index) => row(index));
        const dir = writeLabeledPage(root, "page-a", reviewWith(rows), labelsFor(rows, 20));
        expect(attest(root).status).toBe(0);
        const labelsPath = join(dir, "component-labels.json");
        const labelsText = readFileSync(labelsPath, "utf8");

        const manifestPath = join(root, "provenance.json");
        const sealedText = readFileSync(manifestPath, "utf8");
        const escaped = JSON.parse(sealedText) as {
          pages: Array<Record<string, unknown>>;
        };
        escaped.pages[0]!.page = "../escape";
        writeFileSync(manifestPath, JSON.stringify(escaped));
        const unsafePage = scoreStrict(root);
        expect(unsafePage.status).toBe(1);
        expect(unsafePage.stdout).toBe("");
        expect(unsafePage.stderr).toContain("HELDOUT_COMPONENT_INVALID_PROVENANCE");
        writeFileSync(manifestPath, sealedText);

        const unknown = JSON.parse(labelsText) as Record<string, string[]>;
        unknown["unknown|desktop|node"] = ["button"];
        writeFileSync(labelsPath, JSON.stringify(unknown));
        const unknownRun = scoreStrict(root);
        expect(unknownRun.status).toBe(1);
        expect(unknownRun.stderr).toContain("HELDOUT_COMPONENT_UNKNOWN_KEY");

        const reserved = JSON.parse(labelsText) as Record<string, string[]>;
        Object.defineProperty(reserved, "__proto__", {
          value: ["button"],
          enumerable: true,
          configurable: true,
          writable: true,
        });
        writeFileSync(labelsPath, JSON.stringify(reserved));
        const reservedRun = scoreStrict(root);
        expect(reservedRun.status).toBe(1);
        expect(reservedRun.stderr).toContain("HELDOUT_COMPONENT_RESERVED_KEY");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  it("keeps predictions out of labeler material and preserves labels on re-export", () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-provenance-export-"));
    try {
      const first = reviewWith([row(1)]);
      const dir = pageDir(root, "page-a");
      const files = writeHeldoutComponentReview(first, dir);
      const humanLabels = { [componentHeldoutKey(first.components[0]!)]: ["button"] };
      writeFileSync(files.labels, JSON.stringify(humanLabels));

      const second = writeHeldoutComponentReview(reviewWith([row(1), row(2)]), dir);
      expect(JSON.parse(readFileSync(second.labels, "utf8"))).toEqual(humanLabels);

      const blind = JSON.parse(readFileSync(second.blind, "utf8")) as {
        components: Array<Record<string, unknown>>;
      };
      expect(blind.components).toHaveLength(2);
      const allowed = new Set([
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
      for (const component of blind.components) {
        expect(new Set(Object.keys(component))).toEqual(allowed);
        expect(Object.keys(component.rect as Record<string, unknown>).sort()).toEqual([
          "height",
          "width",
          "x",
          "y",
        ]);
      }
      for (const forbidden of [
        "acceptedTypes",
        "candidateTypes",
        "typeBasis",
        "typeClassification",
        "typeDecision",
        "typeRuleId",
        "predictions",
      ]) {
        expect(readFileSync(second.blind, "utf8")).not.toContain(`"${forbidden}"`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
