// Release gate for a qualification report. A report qualifies a release only
// when it is a full-scope run against the approved fixture, was produced by this
// harness version, and is bound to the exact tarball bytes the release will
// publish. The required-check inventory is compiled in here, so deleting a
// required check from a report cannot shrink its own gate.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isSRI } from "../release-integrity.mjs";
import { describeArtifactFile } from "./artifact.mjs";
import { ATLAS_ACTIONS } from "./cli-probe.mjs";
import { APPROVED_FIXTURE_URL } from "./fixture.mjs";
import { HARNESS_VERSION, validateReport } from "./report.mjs";

export const GATE_VERSION = 1;
export const QUALIFICATION_MODES = Object.freeze(["pack", "tarball"]);

const USAGE = `usage: node scripts/qualify/gate.mjs --report <report.json> --tarball <artifact.tgz>
       --package <name> --version <version> [--mode tarball|pack]
       [--filename <packed-name.tgz>] [--integrity <sha512-SRI>]
       [--evidence <gate.json>]`;

const CLI_REFUSALS = ATLAS_ACTIONS.map(({ action }) => `cli.${action}.refusal`);
const CLI_ENABLED = [
  "cli.import.flag_on",
  "cli.capture.flag_on",
  ...ATLAS_ACTIONS.filter(({ offline, action }) => offline && action !== "import").map(
    ({ action }) => `cli.${action}.flag_on`,
  ),
];

// Everything a full PASS must contain, except the optional browser.chromium
// diagnostic and the abort-only harness.* records.
const COMMON_CHECKS = Object.freeze([
  "artifact.install",
  "artifact.isolated",
  "surface.full.flag_off",
  "surface.core.flag_off",
  "surface.v2.flag_off",
  "surface.full.flag_on",
  "surface.core.flag_on",
  "surface.v2.flag_on",
  "surface.delta.full",
  "surface.delta.core",
  "surface.delta.v2",
  "branches.flag_off",
  "branches.flag_on",
  "annotations.flag_on",
  "atlas.tools.runtime",
  "v2.branches.runtime",
  "protocol.legacy.flag_off",
  "protocol.modern.flag_off",
  "protocol.legacy.flag_on",
  "protocol.modern.flag_on",
  ...CLI_REFUSALS,
  ...CLI_ENABLED,
  "browser.fixture",
  "browser.atlas_policy",
  "browser.atlas_capture",
  "browser.qualification",
  "cleanup.processes",
  "cleanup.real_cache",
  "cleanup.temp",
]);

const MODE_CHECKS = Object.freeze({
  pack: Object.freeze(["artifact.build", "artifact.pack"]),
  tarball: Object.freeze(["artifact.input"]),
});

export function requiredCheckInventory(mode) {
  const extra = MODE_CHECKS[mode];
  if (!extra) throw new Error(`unknown qualification mode: ${mode}`);
  return Object.freeze([...extra, ...COMMON_CHECKS]);
}

function sorted(values) {
  return [...values].sort();
}

export function validateReleaseEvidence({ report, artifact, expected = {} }) {
  const errors = [];
  const mode = expected.mode ?? "tarball";
  let inventory;
  try {
    inventory = requiredCheckInventory(mode);
  } catch (error) {
    return { ok: false, errors: [error.message], inventory: [] };
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return { ok: false, errors: ["report: not an object"], inventory: [...inventory] };
  }

  errors.push(...validateReport(report));
  if (report.harnessVersion !== HARNESS_VERSION) {
    errors.push(`harnessVersion: ${report.harnessVersion}, expected ${HARNESS_VERSION}`);
  }
  if (report.input?.mode !== mode) {
    errors.push(`input.mode: ${report.input?.mode}, expected ${mode}`);
  }
  if (report.qualificationScope !== "full") {
    errors.push(`qualificationScope: ${report.qualificationScope}, a release needs full`);
  }
  const summary = report.summary ?? {};
  if (summary.status !== "PASS") errors.push(`summary.status: ${summary.status}, expected PASS`);
  if (summary.exitCode !== 0) errors.push(`summary.exitCode: ${summary.exitCode}, expected 0`);
  if (summary.fail !== 0) errors.push(`summary.fail: ${summary.fail}, expected 0`);
  if (summary.skip !== 0) errors.push(`summary.skip: ${summary.skip}, expected 0 (no skipped checks in a release)`);

  if (report.options?.browser !== true) {
    errors.push("options.browser: a release qualification must run the browser checks");
  }
  if (report.options?.keepTemp !== false) {
    errors.push("options.keepTemp: a release qualification must clean its temp tree");
  }
  if (report.options?.skipBuild !== false) {
    errors.push("options.skipBuild: a release qualification must not reuse a stale dist");
  }
  if (report.options?.tarball !== (mode === "tarball")) {
    errors.push(`options.tarball: ${report.options?.tarball}, expected ${mode === "tarball"}`);
  }

  if (report.qualificationFixture?.url !== APPROVED_FIXTURE_URL) {
    errors.push(
      `qualificationFixture.url: ${report.qualificationFixture?.url ?? "missing"}, expected ${APPROVED_FIXTURE_URL}`,
    );
  }

  const recordedPackage = report.package;
  if (!recordedPackage || typeof recordedPackage !== "object" || Array.isArray(recordedPackage)) {
    errors.push("package: missing installed-artifact identity");
  } else {
    if (recordedPackage.source !== "installed-artifact") {
      errors.push(`package.source: ${recordedPackage.source}, expected installed-artifact`);
    }
    if (expected.package && recordedPackage.name !== expected.package) {
      errors.push(`package.name: ${recordedPackage.name}, expected ${expected.package}`);
    }
    if (expected.version && recordedPackage.version !== expected.version) {
      errors.push(`package.version: ${recordedPackage.version}, expected ${expected.version}`);
    }
  }

  const recordedArtifact = report.artifact;
  if (!recordedArtifact || typeof recordedArtifact !== "object" || Array.isArray(recordedArtifact)) {
    errors.push("artifact: missing artifact metadata");
  } else {
    if (recordedArtifact.source !== mode) {
      errors.push(`artifact.source: ${recordedArtifact.source}, expected ${mode}`);
    }
    if (!isSRI(recordedArtifact.integrity)) {
      errors.push(`artifact.integrity: ${recordedArtifact.integrity ?? "missing"} is not an SRI string`);
    }
    if (recordedArtifact.integrity !== artifact.integrity) {
      errors.push(
        `artifact.integrity: report ${recordedArtifact.integrity} does not match the supplied tarball ${artifact.integrity}`,
      );
    }
    if (recordedArtifact.sha256 !== artifact.sha256) {
      errors.push(`artifact.sha256: report ${recordedArtifact.sha256} does not match the supplied tarball`);
    }
    if (recordedArtifact.bytes !== artifact.bytes) {
      errors.push(`artifact.bytes: report ${recordedArtifact.bytes} does not match ${artifact.bytes}`);
    }
    if (expected.filename && recordedArtifact.filename !== expected.filename) {
      errors.push(`artifact.filename: ${recordedArtifact.filename}, expected ${expected.filename}`);
    }
  }
  if (expected.integrity) {
    if (!isSRI(expected.integrity)) {
      errors.push(`expected integrity: ${expected.integrity} is not an SRI string`);
    } else if (artifact.integrity !== expected.integrity) {
      errors.push(
        `artifact integrity ${artifact.integrity} does not match the expected release integrity ${expected.integrity}`,
      );
    }
  }

  const recordedInventory = Array.isArray(report.requiredInventory) ? report.requiredInventory : null;
  if (!recordedInventory) {
    errors.push("requiredInventory: missing");
  } else if (JSON.stringify(sorted(recordedInventory)) !== JSON.stringify(sorted(inventory))) {
    errors.push(`requiredInventory: does not match the gate inventory for mode ${mode}`);
  }

  const checks = Array.isArray(report.checks) ? report.checks : [];
  const byId = new Map();
  for (const check of checks) {
    if (!check || typeof check !== "object" || Array.isArray(check)) continue;
    if (!byId.has(check.id)) byId.set(check.id, check);
  }
  for (const id of inventory) {
    const check = byId.get(id);
    if (!check) {
      errors.push(`checks: missing required check ${id}`);
      continue;
    }
    if (check.required !== true) errors.push(`checks.${id}: must be required`);
    if (check.status !== "PASS") errors.push(`checks.${id}: ${check.status}, required PASS`);
  }
  const required = new Set(inventory);
  for (const check of checks) {
    if (!check || typeof check !== "object" || Array.isArray(check)) continue;
    if (check.required === true && !required.has(check.id)) {
      errors.push(`checks.${check.id}: unknown required check is not a release inventory substitute`);
    }
  }

  if (typeof report.node !== "string" || !/^v\d+\.\d+\.\d+/.test(report.node)) {
    errors.push("node: missing runtime identity");
  }
  if (typeof report.platform !== "string" || report.platform.trim() === "") {
    errors.push("platform: missing platform identity");
  }
  if (!report.environment || typeof report.environment !== "object") {
    errors.push("environment: missing environment record");
  }
  if (!report.repo || typeof report.repo !== "object" || !/^[0-9a-f]{40}$/.test(String(report.repo.commit ?? ""))) {
    errors.push("repo.commit: missing candidate source commit");
  }

  return { ok: errors.length === 0, errors, inventory: [...inventory] };
}

export function gateEvidence({ report, artifact, expected = {}, result }) {
  return {
    gate: "release-qualification",
    gateVersion: GATE_VERSION,
    verdict: result.ok ? "PASS" : "FAIL",
    checkedAt: new Date().toISOString(),
    expected: {
      mode: expected.mode ?? "tarball",
      package: expected.package ?? null,
      version: expected.version ?? null,
      filename: expected.filename ?? null,
      integrity: expected.integrity ?? null,
    },
    artifact: {
      filename: artifact.filename,
      integrity: artifact.integrity,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    },
    report: report
      ? {
          schemaVersion: report.schemaVersion ?? null,
          harnessVersion: report.harnessVersion ?? null,
          qualificationScope: report.qualificationScope ?? null,
          status: report.summary?.status ?? null,
          exitCode: report.summary?.exitCode ?? null,
          fixture: report.qualificationFixture?.url ?? null,
          package: report.package ?? null,
          requiredChecks: result.inventory?.length ?? null,
        }
      : null,
    errors: result.errors,
  };
}

export function renderGateSummary(evidence) {
  const lines = [
    `release-qualification gate: ${evidence.verdict} — ` +
      `${evidence.expected.package ?? "?"}@${evidence.expected.version ?? "?"} ` +
      `(${evidence.expected.mode})`,
    `artifact: ${evidence.artifact.filename} sha512:${evidence.artifact.integrity.slice(0, 24)}… ` +
      `${evidence.artifact.bytes} bytes`,
  ];
  if (evidence.errors.length > 0) {
    lines.push("", "ERRORS");
    for (const error of evidence.errors) lines.push(`  - ${error}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = { mode: "tarball", help: false };
  let index = 0;
  const value = (flag) => {
    const next = argv[++index];
    if (!next) throw new Error(`${flag} needs a value`);
    return next;
  };
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--report") options.report = resolve(value(arg));
    else if (arg === "--tarball") options.tarball = resolve(value(arg));
    else if (arg === "--package") options.package = value(arg);
    else if (arg === "--version") options.version = value(arg);
    else if (arg === "--mode") options.mode = value(arg);
    else if (arg === "--filename") options.filename = value(arg);
    else if (arg === "--integrity") options.integrity = value(arg);
    else if (arg === "--evidence") options.evidence = resolve(value(arg));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.help) return options;
  if (!options.report) throw new Error("--report is required");
  if (!options.tarball) throw new Error("--tarball is required");
  if (!options.package) throw new Error("--package is required");
  if (!options.version) throw new Error("--version is required");
  if (!QUALIFICATION_MODES.includes(options.mode)) {
    throw new Error(`--mode must be one of ${QUALIFICATION_MODES.join(", ")}`);
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`release-qualification gate: ${error.message}\n${USAGE}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  let report;
  try {
    report = JSON.parse(readFileSync(options.report, "utf8"));
  } catch (error) {
    console.error(`release-qualification gate: cannot read report: ${error.message}`);
    process.exit(1);
  }
  let artifact;
  try {
    artifact = describeArtifactFile(options.tarball);
  } catch (error) {
    console.error(`release-qualification gate: cannot read artifact: ${error.message}`);
    process.exit(1);
  }

  const result = validateReleaseEvidence({ report, artifact, expected: options });
  const evidence = gateEvidence({ report, artifact, expected: options, result });
  if (options.evidence) {
    mkdirSync(dirname(options.evidence), { recursive: true });
    writeFileSync(options.evidence, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  console.log(renderGateSummary(evidence));
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
