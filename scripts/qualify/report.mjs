// Pure PASS/FAIL/SKIP registry and report validation for the installed
// qualification harness. No I/O here: the unit tests prove the accounting,
// exit-code mapping and anti-false-green rules without a server or browser.

export const REPORT_SCHEMA_VERSION = 2;
// Bumped whenever the harness changes what a report means, so an old report
// cannot be replayed through a newer release gate.
export const HARNESS_VERSION = 2;
export const CHECK_STATUSES = Object.freeze(["PASS", "FAIL", "SKIP"]);
export const QUALIFICATION_SCOPES = Object.freeze(["full", "offline-installed"]);
const STATUS = new Set(CHECK_STATUSES);
const CHECK_ID = /^[a-z0-9]+(?:[._-][a-z0-9_]+)+$/;

// A check must state PASS/FAIL/SKIP explicitly. A bare {reason} is evidence
// that something was observed, not that the observation passed.
export function normalizeCheckOutcome(outcome) {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
    return { status: "FAIL", reason: "check produced no outcome" };
  }
  if (outcome.status === undefined) {
    const implicitReason = typeof outcome.reason === "string" ? outcome.reason.trim() : "";
    return {
      status: "FAIL",
      reason: implicitReason
        ? `check produced a reason without a status: ${implicitReason}`
        : "check produced neither a status nor a reason",
      details: outcome.details,
    };
  }
  if (!STATUS.has(outcome.status)) {
    return {
      status: "FAIL",
      reason: `check returned invalid status ${JSON.stringify(outcome.status)}`,
      details: outcome.details,
    };
  }
  return outcome;
}

function checkProblems(check, label) {
  const problems = [];
  if (!check || typeof check !== "object" || Array.isArray(check)) {
    return [`${label}: not an object`];
  }
  if (typeof check.id !== "string" || !CHECK_ID.test(check.id)) {
    problems.push(`${label}: invalid id ${JSON.stringify(check.id)}`);
  }
  if (typeof check.group !== "string" || check.group.trim() === "") {
    problems.push(`${label}: missing group`);
  }
  if (!STATUS.has(check.status)) {
    problems.push(`${label}: invalid status ${JSON.stringify(check.status)}`);
  }
  if (typeof check.required !== "boolean") {
    problems.push(`${label}: required must be a boolean`);
  }
  if (typeof check.reason !== "string" || check.reason.trim() === "") {
    problems.push(`${label}: empty reason`);
  }
  if (check.details !== undefined && (typeof check.details !== "object" || check.details === null || Array.isArray(check.details))) {
    problems.push(`${label}: details must be an object`);
  }
  if (check.durationMs !== undefined && (!Number.isFinite(check.durationMs) || check.durationMs < 0)) {
    problems.push(`${label}: invalid durationMs`);
  }
  return problems;
}

export function createReport(meta = {}) {
  const { startedAt = new Date().toISOString(), ...rest } = meta;
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    harnessVersion: HARNESS_VERSION,
    harness: "installed-qualification",
    startedAt,
    ...rest,
    checks: [],
  };
}

export function addCheck(report, check) {
  const problems = checkProblems(check, "check");
  if (problems.length > 0) throw new Error(problems.join("; "));
  if (report.checks.some((existing) => existing.id === check.id)) {
    throw new Error(`duplicate check id: ${check.id}`);
  }
  const stored = { ...check, reason: check.reason.trim() };
  report.checks.push(stored);
  return stored;
}

function summarize(checks, qualificationScope = "full") {
  const entries = (Array.isArray(checks) ? checks : []).filter(
    (check) => check && typeof check === "object" && !Array.isArray(check),
  );
  const pass = entries.filter((check) => check.status === "PASS").length;
  const fail = entries.filter((check) => check.status === "FAIL").length;
  const skip = entries.filter((check) => check.status === "SKIP").length;
  const blockers = entries
    .filter((check) => check.status === "FAIL")
    .map((check) => ({ id: check.id, reason: check.reason }));
  const unqualified = entries
    .filter((check) => check.status === "SKIP")
    .map((check) => ({ id: check.id, required: check.required, reason: check.reason }));
  let status = fail > 0 ? "FAIL" : unqualified.some((entry) => entry.required) ? "INCOMPLETE" : "PASS";
  // An offline run is never a full PASS, even when every check it attempted
  // passed: browser qualification was not exercised.
  if (status === "PASS" && qualificationScope !== "full") status = "INCOMPLETE";
  return { pass, fail, skip, status, qualificationScope, blockers, unqualified };
}

export function exitCodeFor(report) {
  const status = report?.summary?.status;
  if (status === "PASS") return 0;
  if (status === "INCOMPLETE") return 2;
  return 1;
}

export function finalizeReport(report, { finishedAt = new Date().toISOString(), qualificationScope } = {}) {
  const scope = qualificationScope ?? report.qualificationScope ?? "full";
  const summary = summarize(report.checks, scope);
  report.finishedAt = finishedAt;
  report.durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(report.startedAt));
  report.summary = { ...summary, exitCode: exitCodeFor({ summary }) };
  return report;
}

export function validateReport(report) {
  const errors = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return ["report: not an object"];
  }
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION) {
    errors.push(`schemaVersion: expected ${REPORT_SCHEMA_VERSION}`);
  }
  if (report.harnessVersion !== HARNESS_VERSION) {
    errors.push(`harnessVersion: expected ${HARNESS_VERSION}`);
  }
  if (report.harness !== "installed-qualification") errors.push("harness: unexpected name");
  if (!QUALIFICATION_SCOPES.includes(report.qualificationScope)) {
    errors.push(`qualificationScope: expected one of ${QUALIFICATION_SCOPES.join(", ")}`);
  }
  if (typeof report.startedAt !== "string" || !Number.isFinite(Date.parse(report.startedAt))) {
    errors.push("startedAt: not an ISO timestamp");
  }
  if (typeof report.finishedAt !== "string" || !Number.isFinite(Date.parse(report.finishedAt))) {
    errors.push("finishedAt: not an ISO timestamp");
  }
  if (!Number.isFinite(report.durationMs) || report.durationMs < 0) {
    errors.push("durationMs: not a non-negative number");
  }
  if (!Array.isArray(report.checks) || report.checks.length === 0) {
    errors.push("checks: must be a non-empty array");
    return errors;
  }
  const ids = new Set();
  report.checks.forEach((check, index) => {
    errors.push(...checkProblems(check, `checks[${index}]`));
    if (!check || typeof check !== "object" || Array.isArray(check)) return;
    if (ids.has(check.id)) errors.push(`checks[${index}]: duplicate id ${check.id}`);
    ids.add(check.id);
  });

  const summary = report.summary;
  if (!summary || typeof summary !== "object") {
    errors.push("summary: missing");
    return errors;
  }
  const expected = summarize(report.checks, report.qualificationScope);
  for (const key of ["pass", "fail", "skip"]) {
    if (summary[key] !== expected[key]) {
      errors.push(`summary.${key}: ${summary[key]}, expected ${expected[key]}`);
    }
  }
  if (summary.qualificationScope !== expected.qualificationScope) {
    errors.push(
      `summary.qualificationScope: ${summary.qualificationScope}, expected ${expected.qualificationScope}`,
    );
  }
  const expectedExit =
    expected.status === "PASS" ? 0 : expected.status === "INCOMPLETE" ? 2 : 1;
  if (summary.status !== expected.status) {
    errors.push(`summary.status: ${summary.status}, expected ${expected.status}`);
  }
  if (summary.exitCode !== expectedExit) {
    errors.push(`summary.exitCode: ${summary.exitCode}, expected ${expectedExit}`);
  }
  const idsOf = (entries) => (Array.isArray(entries) ? entries.map((entry) => entry.id).join(",") : "missing");
  if (idsOf(summary.blockers) !== idsOf(expected.blockers)) {
    errors.push("summary.blockers: does not match failed checks");
  }
  if (idsOf(summary.unqualified) !== idsOf(expected.unqualified)) {
    errors.push("summary.unqualified: does not match skipped checks");
  }
  return errors;
}

export function renderHumanSummary(report) {
  const summary = report.summary;
  if (!summary) throw new Error("report has no summary; finalize it first");
  const lines = [];
  lines.push(
    `installed-qualification: ${summary.status} — ` +
      `${summary.pass} pass, ${summary.fail} fail, ${summary.skip} skip`,
  );
  lines.push(
    summary.qualificationScope === "full"
      ? "scope: full (browser qualification exercised)"
      : "scope: offline-installed (browser qualification incomplete; not a full PASS)",
  );
  const repo = report.repo ?? {};
  if (repo.branch || repo.commit) {
    lines.push(
      `repo: ${repo.branch ?? "?"} @ ${String(repo.commit ?? "?").slice(0, 12)}` +
        `${repo.dirty ? " (uncommitted)" : ""}, node ${report.node ?? "?"}`,
    );
  }
  if (report.artifact) {
    const artifact = report.artifact;
    lines.push(
      `artifact: ${artifact.filename} sha256:${String(artifact.sha256).slice(0, 16)}… ` +
        `${artifact.bytes} bytes` +
        (Number.isFinite(artifact.files) ? `, ${artifact.files} files` : "") +
        (artifact.source ? ` (${artifact.source})` : ""),
    );
  }
  const groups = [...new Set(report.checks.map((check) => check.group))];
  for (const group of groups) {
    lines.push("", group);
    for (const check of report.checks.filter((entry) => entry.group === group)) {
      lines.push(`  [${check.status}] ${check.id}${check.required ? "" : " (optional)"} — ${check.reason}`);
    }
  }
  if (summary.blockers.length > 0) {
    lines.push("", "BLOCKERS");
    for (const blocker of summary.blockers) lines.push(`  - ${blocker.id}: ${blocker.reason}`);
  }
  if (summary.unqualified.length > 0) {
    lines.push("", "UNQUALIFIED (skipped)");
    for (const entry of summary.unqualified) {
      lines.push(`  - ${entry.id}${entry.required ? " (required)" : " (optional)"}: ${entry.reason}`);
    }
  }
  if (Array.isArray(report.notes) && report.notes.length > 0) {
    lines.push("", "NOTES");
    for (const note of report.notes) lines.push(`  - ${note}`);
  }
  return lines.join("\n");
}
