// Classifies the `awwwards-index --atlas <action>` probes. The flag-off run is
// also the availability probe: a documented refusal proves the action exists,
// while the current parser's "unsupported action" / "does not accept extra
// arguments" response means Phase 6B has not wired that action yet. An
// unsupported action is a SKIP, never a PASS.

const FLAG_REFUSAL = /AWWWARDS_MCP_ATLAS\s*=\s*1/i;
const NOT_IMPLEMENTED =
  /unsupported --atlas action|does not accept extra arguments|expected "import"/i;

export const ATLAS_ACTIONS = Object.freeze([
  { action: "import", argv: Object.freeze(["--atlas", "import"]), offline: true },
  {
    action: "capture",
    argv: Object.freeze([
      "--atlas",
      "capture",
      "--slug",
      "qualify-fixture",
      "--path",
      "/",
      "--viewport",
      "desktop",
    ]),
    offline: false,
  },
  { action: "reindex", argv: Object.freeze(["--atlas", "reindex"]), offline: true },
  { action: "verify", argv: Object.freeze(["--atlas", "verify"]), offline: true },
  {
    action: "prune",
    argv: Object.freeze(["--atlas", "prune", "--older-than-days", "30"]),
    offline: true,
  },
]);

export function classifyFlagOffProbe({ action, status, stderr = "", stdout = "", cacheExisted, error }) {
  const output = `${stdout}\n${stderr}`.trim();
  if (error) {
    return {
      status: "FAIL",
      available: null,
      reason: `${action}: probe failed before a documented refusal (${error}); it may have started a crawl`,
    };
  }
  if (cacheExisted) {
    return {
      status: "FAIL",
      available: true,
      reason: `${action}: created cache state before checking AWWWARDS_MCP_ATLAS`,
    };
  }
  if (status === 0) {
    return {
      status: "FAIL",
      available: true,
      reason: `${action}: exited 0 with AWWWARDS_MCP_ATLAS unset; the action ran instead of refusing`,
    };
  }
  if (FLAG_REFUSAL.test(stderr)) {
    return {
      status: status === 2 ? "PASS" : "FAIL",
      available: true,
      reason:
        status === 2
          ? `${action}: refused with exit 2 before cache/network use while the flag is off`
          : `${action}: refused with exit ${status}, expected 2 for the documented usage refusal`,
    };
  }
  if (NOT_IMPLEMENTED.test(output)) {
    return {
      status: "SKIP",
      available: false,
      reason: `${action}: not wired on this base (Phase 6B); the CLI reports an unsupported action instead of a flag refusal`,
    };
  }
  return {
    status: "FAIL",
    available: null,
    reason: `${action}: unexpected exit ${status} without a flag refusal: ${output.split(/\r?\n/)[0] ?? "(no output)"}`,
  };
}

export function classifyFlagOnProbe({ action, status, stderr = "", stdout = "", error }) {
  if (error) return { status: "FAIL", reason: `${action}: failed while enabled (${error})` };
  if (status === 0) {
    return { status: "PASS", reason: `${action}: completed offline with the flag enabled (exit 0)` };
  }
  const line = `${stdout}\n${stderr}`.split(/\r?\n/).find((entry) => entry.trim() !== "");
  return {
    status: "FAIL",
    reason: `${action}: exit ${status} with the flag enabled: ${line?.trim() ?? "(no output)"}`,
  };
}
