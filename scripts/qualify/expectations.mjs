// Surface expectations and probe classifiers for Atlas release qualification.
// The counts come from docs/atlas-spec.md §18 Phase 6 / §20.1: the flag-off
// surface stays at 41 full / 13 core / 15 v2 and the flag-on surface is
// 45 full / 13 core / 16 v2.

export const ATLAS_FULL_TOOLS = Object.freeze([
  "search_atlas",
  "get_atlas",
  "capture_atlas",
  "export_evidence_pack",
]);

export const V2_ATLAS_EXPORT_TOOL = "export_evidence_pack";

// Baseline names that must survive the Atlas additions. They are the stable
// contract anchors: a count-only check would miss a swapped tool.
export const CORE_TOOL_NAMES = Object.freeze([
  "search_sites",
  "get_site_details",
  "analyze_page_structure",
  "analyze_scroll_map",
  "capture_component",
  "verify_build",
  "build_project",
  "get_motion_dna",
  "analyze_stack",
  "capture_live_site",
  "get_annual_categories",
  "get_annual_nominees",
  "get_collections",
]);

export const V2_BASELINE_TOOLS = Object.freeze([
  "search_references",
  "get_reference",
  "browse_awards",
  "get_index",
  "inspect_page",
  "analyze_motion",
  "capture_page",
  "audit_page",
  "build_motion",
  "monitor_awards",
  "create_design_brief",
  "build_project",
  "verify_build",
  "verify_flow",
  "analyze_network_capture",
]);

export function baselineToolsFor(profile) {
  return profile === "v2" ? V2_BASELINE_TOOLS : CORE_TOOL_NAMES;
}

export const ATLAS_V2_BRANCHES = Object.freeze([
  { tool: "search_references", kinds: Object.freeze(["sections", "components"]) },
  {
    tool: "get_reference",
    kinds: Object.freeze(["atlas_region", "atlas_highlight", "atlas_taxonomy"]),
  },
  { tool: "get_index", kinds: Object.freeze(["atlas_status"]) },
  { tool: "capture_page", kinds: Object.freeze(["atlas"]) },
]);

export const ATLAS_V2_BRANCH_KINDS = Object.freeze(
  ATLAS_V2_BRANCHES.flatMap((entry) => entry.kinds),
);

export const EXPECTED_COUNTS = Object.freeze({
  off: Object.freeze({ full: 41, core: 13, v2: 15 }),
  on: Object.freeze({ full: 45, core: 13, v2: 16 }),
});

export function expectedCount(flagOn, profile) {
  const state = EXPECTED_COUNTS[flagOn ? "on" : "off"];
  const count = state[profile];
  if (count === undefined) throw new Error(`unknown profile: ${profile}`);
  return count;
}

/** Atlas tools this profile/flag combination must advertise, and no others. */
export function expectedAtlasTools(flagOn, profile) {
  if (!flagOn) return [];
  if (profile === "full") return [...ATLAS_FULL_TOOLS];
  if (profile === "v2") return [V2_ATLAS_EXPORT_TOOL];
  return [];
}

export function analyzeSurface({ flagOn, profile, names }) {
  const expected = expectedCount(flagOn, profile);
  const wanted = expectedAtlasTools(flagOn, profile);
  const problems = [];
  const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
  if (duplicates.length > 0) problems.push(`duplicate tool names: ${duplicates.join(", ")}`);
  for (const name of baselineToolsFor(profile)) {
    if (!names.includes(name)) problems.push(`missing baseline tool: ${name}`);
  }
  for (const name of wanted) {
    if (!names.includes(name)) problems.push(`missing Atlas tool: ${name}`);
  }
  for (const name of ATLAS_FULL_TOOLS) {
    if (!wanted.includes(name) && names.includes(name)) {
      problems.push(`unexpected Atlas tool in ${profile}/${flagOn ? "on" : "off"}: ${name}`);
    }
  }
  if (names.length !== expected) problems.push(`expected ${expected} tools, got ${names.length}`);
  return {
    ok: problems.length === 0,
    expected,
    actual: names.length,
    wanted,
    duplicates,
    problems,
  };
}

// Count-plus-anchor checks cannot see a swap among unanchored names. The
// flag-on surface must be exactly the flag-off surface plus the Atlas tools.
export function analyzeSurfaceDelta({ profile, offNames, onNames }) {
  if (!Array.isArray(offNames) || !Array.isArray(onNames)) {
    return {
      ok: false,
      problems: ["both flag-off and flag-on tool lists are required"],
      missing: [],
      unexpected: [],
      duplicates: [],
    };
  }
  const expectedOn = [...new Set([...offNames, ...expectedAtlasTools(true, profile)])];
  const missing = expectedOn.filter((name) => !onNames.includes(name));
  const unexpected = onNames.filter((name) => !expectedOn.includes(name));
  const duplicates = [...new Set(onNames.filter((name, index) => onNames.indexOf(name) !== index))];
  const problems = [];
  if (duplicates.length > 0) problems.push(`duplicate flag-on tool names: ${duplicates.join(", ")}`);
  if (missing.length > 0) problems.push(`flag-on surface is missing: ${missing.join(", ")}`);
  if (unexpected.length > 0) problems.push(`flag-on surface added or swapped: ${unexpected.join(", ")}`);
  return { ok: problems.length === 0, expectedOn, missing, unexpected, duplicates, problems };
}

// Builds the set of branch discriminants a tool advertises. Zod discriminated
// unions reach MCP as oneOf branches whose `kind` property carries a const (or
// a single-value enum), so this is implementation-shape tolerant.
export function extractBranchKinds(schema) {
  const found = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    const properties = node.properties;
    if (properties && typeof properties === "object" && properties.kind && typeof properties.kind === "object") {
      const kind = properties.kind;
      if (typeof kind.const === "string") found.add(kind.const);
      if (Array.isArray(kind.enum)) {
        for (const value of kind.enum) if (typeof value === "string") found.add(value);
      }
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(schema);
  return [...found].sort();
}

export const ATLAS_OUTPUT_SCHEMA_ID = "awwwards-atlas-v1";

export function outputAdvertisesAtlasStatus(schema) {
  if (extractBranchKinds(schema).includes("atlas_status")) return true;
  let found = false;
  const walk = (node) => {
    if (found || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    const properties = node.properties;
    if (properties && typeof properties === "object" && properties.schemaVersion && typeof properties.schemaVersion === "object") {
      const version = properties.schemaVersion;
      if (version.const === ATLAS_OUTPUT_SCHEMA_ID) found = true;
      if (Array.isArray(version.enum) && version.enum.includes(ATLAS_OUTPUT_SCHEMA_ID)) found = true;
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(schema);
  return found;
}

export function analyzeBranches({ flagOn, schema, tool }) {
  const entry = ATLAS_V2_BRANCHES.find((candidate) => candidate.tool === tool);
  if (!entry) throw new Error(`no Atlas branch expectation for ${tool}`);
  const found = extractBranchKinds(schema);
  const expected = [...entry.kinds];
  const missing = expected.filter((kind) => !found.includes(kind));
  const unexpected = flagOn ? [] : expected.filter((kind) => found.includes(kind));
  const problems = [];
  if (missing.length > 0) {
    problems.push(`${tool} is missing Atlas branch(es): ${missing.join(", ")}`);
  }
  return {
    ok: problems.length === 0,
    tool,
    expected,
    found,
    missing,
    unexpected,
    problems,
  };
}

// docs/atlas-spec.md §11.6. Atlas capture is the only open-world, non-read-only
// operation; evidence export is a write but idempotent and closed-world.
export const ATLAS_ANNOTATION_EXPECTATIONS = Object.freeze({
  search_atlas: Object.freeze({ readOnlyHint: true, idempotentHint: true, openWorldHint: false }),
  get_atlas: Object.freeze({ readOnlyHint: true, idempotentHint: true, openWorldHint: false }),
  capture_atlas: Object.freeze({ readOnlyHint: false, idempotentHint: false, openWorldHint: true }),
  export_evidence_pack: Object.freeze({ readOnlyHint: false, idempotentHint: true, openWorldHint: false }),
});

// Mixed v2 groups keep conservative annotations covering every branch. Adding
// the capture branch to capture_page makes that group non-read-only.
export const V2_ANNOTATION_EXPECTATIONS = Object.freeze({
  search_references: Object.freeze({ readOnlyHint: true }),
  get_reference: Object.freeze({ readOnlyHint: true }),
  get_index: Object.freeze({ readOnlyHint: true }),
  capture_page: Object.freeze({ readOnlyHint: false }),
});

function annotationProblems(tool, expected) {
  const problems = [];
  const annotations = tool?.annotations;
  if (!annotations || typeof annotations !== "object") {
    return [`${tool?.name ?? "tool"}: no annotations advertised`];
  }
  for (const [key, value] of Object.entries(expected)) {
    if (annotations[key] !== value) {
      problems.push(
        `${tool.name}: ${key} is ${JSON.stringify(annotations[key])}, expected ${JSON.stringify(value)}`,
      );
    }
  }
  return problems;
}

export function analyzeAnnotations({ fullTools = [], v2Tools = [] }) {
  const problems = [];
  const byName = (tools) => new Map((Array.isArray(tools) ? tools : []).map((tool) => [tool?.name, tool]));
  const full = byName(fullTools);
  const v2 = byName(v2Tools);
  for (const [name, expected] of Object.entries(ATLAS_ANNOTATION_EXPECTATIONS)) {
    const tool = full.get(name);
    if (!tool) {
      problems.push(`Atlas tool ${name} is not advertised`);
      continue;
    }
    problems.push(...annotationProblems(tool, expected));
  }
  for (const [name, expected] of Object.entries(V2_ANNOTATION_EXPECTATIONS)) {
    const tool = v2.get(name);
    if (!tool) {
      problems.push(`v2 tool ${name} is not advertised`);
      continue;
    }
    problems.push(...annotationProblems(tool, expected));
  }
  return { ok: problems.length === 0, problems };
}

// docs/atlas-spec.md §11.6 / §13 failure codes. A domain error is only evidence
// that a branch is wired when its code is one the spec defines; an arbitrary
// exception message is a failure, not a recognized refusal.
export const ATLAS_KNOWN_CODES = Object.freeze([
  "AMBIGUOUS_ALIAS",
  "ARTIFACT_INVALID",
  "ARTIFACT_LIMIT",
  "ARTIFACT_MISSING",
  "ARTIFACT_CORRUPT",
  "ATLAS_DISABLED",
  "ATTEMPT_NOT_PUBLISHABLE",
  "BLOCKED_DESTINATION",
  "BROWSER_UNAVAILABLE",
  "CAPTURE_BUSY",
  "CAPTURE_DEADLINE_EXCEEDED",
  "CAPTURE_FAILED",
  "CAPTURE_INVALID",
  "CAPTURE_LEASE_CORRUPT",
  "CAPTURE_LEASE_UNAVAILABLE",
  "CAPTURE_TIMEOUT",
  "CHECKPOINT_EVIDENCE_LIMIT",
  "CHECKPOINT_LIMIT",
  "CHECKPOINT_OBSERVATION_MISSING",
  "CHECKPOINT_SECTION_EXCLUDED",
  "CHECKPOINT_SECTION_TRUNCATION",
  "CLAIM_REGION_MISSING",
  "COMPONENT_CAP",
  "COMPONENT_INITIAL_SCAN_ONLY",
  "COMPONENT_PACK_CAP",
  "COMPONENT_PACK_TRUNCATED",
  "CREDENTIAL_URL",
  "CURSOR_EXPIRED",
  "CURSOR_INVALID",
  "CURSOR_QUERY_MISMATCH",
  "CURSOR_STALE",
  "DATABASE_BUSY",
  "DESTINATION_CHANGED",
  "DOM_NODE_LIMIT",
  "DUPLICATE_REGION_KEY",
  "EVIDENCE_UNRESOLVED",
  "FEATURE_DISABLED",
  "FTS_UNAVAILABLE",
  "HTTP_BLOCKED",
  "HTTP_STATUS",
  "INVALID_GEOMETRY",
  "INVALID_INPUT",
  "INVALID_SELECTION",
  "INVALID_SITE_SLUG",
  "INVALID_STATE_REQUEST",
  "LEGACY_DETAIL_MISSING",
  "LEGACY_ELEMENTS_MALFORMED",
  "LEGACY_ELEMENTS_MISSING",
  "LEGACY_METADATA_ONLY",
  "LIVE_URL_UNAVAILABLE",
  "MAINTENANCE_PAGE",
  "MISSING_TIMESTAMP",
  "NAVIGATION_FAILED",
  "NO_CLAIMS",
  "NO_SECTIONS",
  "NO_SECTION_REGIONS",
  "PACK_CORRUPT",
  "PACK_ID_MISMATCH",
  "PACK_LIMIT_EXCEEDED",
  "PACK_OUTSIDE_STORE",
  "PACK_OWNERSHIP_MISMATCH",
  "PACK_STALE",
  "PACK_WRITE_FAILED",
  "PARSER_DRIFT",
  "PARTIAL_VIEWPORT",
  "POLICY_BLOCKED",
  "POLICY_CONFIG",
  "PREFLIGHT_FAILED",
  "PRIVATE_DESTINATION",
  "PUBLICATION_BUSY",
  "PUBLICATION_FAILED",
  "PUBLICATION_SUPPRESSED",
  "REDIRECT_LIMIT",
  "REFERENCE_UNAVAILABLE",
  "REGION_NOT_FOUND",
  "RESOURCE_NETWORK_ERROR",
  "RIGHTS_REQUIRED",
  "ROBOTS_DENIED",
  "ROBOTS_DISALLOWED",
  "ROBOTS_UNAVAILABLE",
  "SCHEMA_TOO_NEW",
  "SCREENSHOT_EMPTY",
  "SCREENSHOT_FAILED",
  "SCREENSHOT_INVALID",
  "SCREENSHOT_LIMIT",
  "SCREENSHOTS_MISSING",
  "SCROLL_OFFSET_MISMATCH",
  "SCROLL_ROOT_UNKNOWN",
  "SEARCH_NOT_READY",
  "SECTION_EXCLUDED",
  "SECTION_TRUNCATION",
  "STALE_OBSERVATION",
  "STALE_OR_PROTECTED_OBSERVATION",
  "STATE_ARTIFACT_LIMIT",
  "STATE_DEADLINE_EXCEEDED",
  "STATE_FOCUS_NOT_VISIBLE",
  "STATE_FOCUS_UNCONFIRMED",
  "STATE_HOVER_NOT_ACTIVE",
  "STATE_NO_CHANGE",
  "STATE_NOT_REQUESTED",
  "STATE_PROBE_FAILED",
  "STATE_RESET_FAILED",
  "STATE_TARGET_AMBIGUOUS",
  "STATE_TARGET_CHANGED",
  "STATE_TARGET_FULL_VIEWPORT",
  "STATE_TARGET_MISSING",
  "STORAGE_LIMIT",
  "TARGET_CHANGED",
  "UNSUPPORTED_GROUPING",
  "UNSUPPORTED_KIND",
  "UNSUPPORTED_PREDICATE",
  "UNSUPPORTED_PROTOCOL",
  "UNSUPPORTED_ROUTE",
  "UNSUPPORTED_STATE",
  "UNKNOWN_SITE",
]);

const ATLAS_CODE_SET = new Set(ATLAS_KNOWN_CODES);

export function parseErrorCode(text) {
  const raw = String(text ?? "");
  const jsonCode = raw.match(/"code"\s*:\s*"([A-Z][A-Z0-9_]+)"/);
  if (jsonCode) return jsonCode[1];
  const leading = raw.match(/(?:^|[\s[])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?=:|\]|\s|$)/);
  return leading ? leading[1] : null;
}

export function probeStatus(
  classified,
  { expectDomain = false, expectPrivate = false, knownCodes = ATLAS_KNOWN_CODES } = {},
) {
  const known = new Set(knownCodes);
  if (classified.kind === "ok") {
    return expectDomain || expectPrivate
      ? { status: "FAIL", reason: `accepted the request but a refusal was required: ${firstLine(classified.text)}` }
      : { status: "PASS", reason: firstLine(classified.text) || "ok" };
  }
  if (classified.kind === "domain_error") {
    const code = parseErrorCode(classified.text);
    if (!code || !ATLAS_CODE_SET.has(code) || !known.has(code)) {
      return {
        status: "FAIL",
        reason:
          `domain error without a known Atlas code: ${firstLine(classified.text)}` +
          (code ? ` (code ${code})` : ""),
      };
    }
    if (code === "ATLAS_DISABLED" || code === "FEATURE_DISABLED") {
      return { status: "FAIL", reason: `Atlas reported itself disabled while the flag was on: ${firstLine(classified.text)}` };
    }
    if (expectPrivate && code !== "PRIVATE_DESTINATION") {
      return {
        status: "FAIL",
        reason: `expected PRIVATE_DESTINATION, got ${code}: ${firstLine(classified.text)}`,
      };
    }
    if (expectDomain || expectPrivate) {
      return { status: "PASS", reason: `refused with ${code}: ${firstLine(classified.text)}` };
    }
    return { status: "PASS", reason: `recognized ${code}: ${firstLine(classified.text)}` };
  }
  if (classified.kind === "schema_rejected") {
    return { status: "FAIL", reason: `request shape rejected: ${firstLine(classified.text)}` };
  }
  return { status: "FAIL", reason: `${classified.kind}: ${firstLine(classified.text)}` };
}

// A single aggregate keeps a skipped browser qualification from hiding behind
// optional checks. It is required whenever any Atlas surface is advertised.
export function browserQualification({ chromium, fixture, policy, capture, atlasPresent = false }) {
  const required = Boolean(atlasPresent);
  const failed = [fixture, policy, capture].filter((entry) => entry?.status === "FAIL");
  if (failed.length > 0) {
    return {
      status: "FAIL",
      required: true,
      reason: `browser qualification failed: ${failed.map((entry) => entry.id ?? entry.reason).join(", ")}`,
    };
  }
  if (chromium?.status !== "PASS") {
    return {
      status: "SKIP",
      required,
      reason: `browser qualification not performed: ${chromium?.reason ?? "Chromium unavailable"}`,
    };
  }
  if (fixture?.status !== "PASS") {
    return {
      status: "SKIP",
      required,
      reason: `browser qualification not performed: fixture check ended ${fixture?.status ?? "missing"}`,
    };
  }
  if (capture?.status !== "PASS") {
    return {
      status: "SKIP",
      required,
      reason:
        "browser qualification has no positive capture: " +
        `${capture?.reason ?? "capture_atlas was not exercised"}`,
    };
  }
  return {
    status: "PASS",
    required: true,
    reason: "real Chromium drove the installed server and a positive capture was qualified",
  };
}

// Classifies a tools/call response. The SDK reports schema failures as an
// isError result whose text starts with "Input validation error"; anything
// else that fails is a domain refusal and still proves the branch is wired.
export function classifyToolResult(message) {
  if (!message || typeof message !== "object") {
    return { kind: "invalid", text: "no response" };
  }
  if (message.error) {
    return {
      kind: "protocol_error",
      text: String(message.error.message ?? JSON.stringify(message.error)),
    };
  }
  const result = message.result;
  if (!result || typeof result !== "object") {
    return { kind: "invalid", text: "missing result" };
  }
  const text = (Array.isArray(result.content) ? result.content : [])
    .filter((block) => block && block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n");
  if (result.isError === true) {
    if (/^Input validation error/im.test(text)) return { kind: "schema_rejected", text };
    return { kind: "domain_error", text };
  }
  return { kind: "ok", text };
}

export function firstLine(text) {
  return String(text ?? "").split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";
}
