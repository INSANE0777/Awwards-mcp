import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { analyzeMotionRequestSchema } from "../src/v2/analyze-motion.js";
import { auditPageRequestSchema } from "../src/v2/audit-page.js";
import { browseAwardsRequestSchema } from "../src/v2/browse-awards.js";
import { buildMotionRequestSchema } from "../src/v2/build-motion.js";
import { capturePageRequestSchema } from "../src/v2/capture-page.js";
import { getIndexRequestSchema } from "../src/v2/get-index.js";
import { getReferenceRequestSchema } from "../src/v2/get-reference.js";
import { inspectPageRequestSchema } from "../src/v2/inspect-page.js";
import { monitorAwardsRequestSchema } from "../src/v2/monitor-awards.js";
import { V2_TOOL_NAMES } from "../src/v2/register.js";
import { searchReferencesRequestSchema } from "../src/v2/search-references.js";
import { CORE_TOOL_NAMES } from "../src/tool-profile.js";
import { registerAllTools } from "../src/tools/index.js";

// Documentation guard: the routing doc shipped with the skills must map every
// replaced name to a real v2 envelope with a branch literal that the registered
// schema actually accepts. The canonical copy lives in the awwwards-skills repo;
// this fixture tracks it so the MCP repo can still validate it. One file read
// plus the request schemas; no server boot and no network.
const ROUTING_DOC = readFileSync(
  new URL("./fixtures/v2-routing.md", import.meta.url),
  "utf8",
);
const README_DOC = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const README_TEXT = README_DOC.replace(/\s+/g, " ");

// The 10 consolidated tools, each with the schema that defines its branches.
// The key set is asserted against V2_TOOL_NAMES so a new tool cannot be added
// to the server without appearing here.
const CONSOLIDATED: Record<string, unknown> = {
  search_references: searchReferencesRequestSchema,
  get_reference: getReferenceRequestSchema,
  browse_awards: browseAwardsRequestSchema,
  get_index: getIndexRequestSchema,
  inspect_page: inspectPageRequestSchema,
  analyze_motion: analyzeMotionRequestSchema,
  capture_page: capturePageRequestSchema,
  audit_page: auditPageRequestSchema,
  build_motion: buildMotionRequestSchema,
  monitor_awards: monitorAwardsRequestSchema,
};

const REPLACED_1X: readonly string[] = [
  "search_sites",
  "search_elements",
  "search_directory",
  "search_motion",
  "get_collections",
  "get_site_details",
  "get_site_elements",
  "get_element",
  "compare_sites",
  "get_index_status",
  "get_index_stats",
  "list_categories",
  "get_annual_categories",
  "get_annual_nominees",
  "get_annual_nominee",
  "analyze_page_structure",
  "export_design_tokens",
  "analyze_stack",
  "get_motion_dna",
  "analyze_scroll_map",
  "analyze_hover_census",
  "capture_live_site",
  "capture_component",
  "capture_pose_3d",
  "capture_scene_3d",
  "record_site_motion",
  "audit_url",
  "analyze_accessibility",
  "analyze_images",
  "analyze_bundle",
  "build_pose_stub",
  "build_gsap_stub",
  "build_motion_manifest",
  "build_scene_stub",
  "new_winners",
  "watch_site",
];

const RETAINED: readonly string[] = [
  "create_design_brief",
  "build_project",
  "verify_build",
  "verify_flow",
  "analyze_network_capture",
];

// The intended branch for every legacy operation. Multi-branch legacy tools
// list each documented target in doc order; a valid-but-wrong branch (e.g.
// DNA routed to hover) fails here even though the schema accepts it.
const EXPECTED_TARGETS: Record<string, readonly string[]> = {
  search_sites: ["search_references:sites"],
  search_elements: ["search_references:elements"],
  search_directory: ["search_references:directory"],
  search_motion: ["search_references:motion"],
  get_collections: ["search_references:collections", "get_reference:collection"],
  get_site_details: ["get_reference:site_details"],
  get_site_elements: ["get_reference:site_elements"],
  get_element: ["get_reference:element"],
  compare_sites: ["get_reference:comparison"],
  get_index_status: ["get_index:status"],
  get_index_stats: ["get_index:stats"],
  list_categories: ["browse_awards:filters"],
  get_annual_categories: ["browse_awards:annual_categories"],
  get_annual_nominees: ["browse_awards:annual_nominees"],
  get_annual_nominee: ["browse_awards:annual_nominee"],
  analyze_page_structure: ["inspect_page:structure"],
  export_design_tokens: ["inspect_page:tokens"],
  analyze_stack: ["inspect_page:stack"],
  get_motion_dna: ["analyze_motion:dna"],
  analyze_scroll_map: ["analyze_motion:scroll"],
  analyze_hover_census: ["analyze_motion:hover"],
  capture_live_site: ["capture_page:screenshot"],
  capture_component: ["capture_page:component"],
  capture_pose_3d: ["capture_page:pose"],
  capture_scene_3d: ["capture_page:scene"],
  record_site_motion: ["capture_page:recording"],
  audit_url: ["audit_page:performance"],
  analyze_accessibility: ["audit_page:accessibility"],
  analyze_images: ["audit_page:images"],
  analyze_bundle: ["audit_page:bundle"],
  build_pose_stub: ["build_motion:pose_stub"],
  build_gsap_stub: ["build_motion:gsap_stub"],
  build_motion_manifest: ["build_motion:manifest"],
  build_scene_stub: ["build_motion:scene_stub"],
  new_winners: ["monitor_awards:poll_winners"],
  watch_site: [
    "monitor_awards:add_watch",
    "monitor_awards:list_watches",
    "monitor_awards:remove_watch",
  ],
};

const V2_ONLY = V2_TOOL_NAMES.filter((name) => !RETAINED.includes(name));

// Derive the expected documentation coverage from the actual full-profile
// registrations: every registered tool except the retained flat five must have
// a routing row. A new tool without a doc row now fails here.
function fullToolNames(): string[] {
  const names: string[] = [];
  const ctx = {
    handlers: {} as never,
    tool: (name: string) => names.push(name),
    registerTool: (name: string) => names.push(name),
  };
  registerAllTools(ctx as never, { atlas: false });
  return names;
}
const FULL_TOOL_NAMES = fullToolNames();
const DERIVED_REPLACED = FULL_TOOL_NAMES.filter((name) => !RETAINED.includes(name));

type JsonSchema = {
  oneOf?: Array<{ properties?: Record<string, { const?: unknown }> }>;
};

// Read the discriminator and its allowed literals from the registered schema's
// JSON Schema, so the doc cannot describe a branch that the tool would reject.
// toJSONSchema is used instead of zod internals because one branch is refined.
function branches(schema: unknown): { key: string; literals: string[] } {
  const json = z.toJSONSchema(schema as never) as JsonSchema;
  const options = json.oneOf ?? [];
  expect(options.length, "discriminated union branches").toBeGreaterThan(0);

  let key: string | undefined;
  const literals: string[] = [];
  for (const option of options) {
    const consts = Object.entries(option.properties ?? {}).filter(
      ([, property]) => typeof property.const === "string",
    );
    expect(consts, "one discriminator per branch").toHaveLength(1);
    const [branchKey, property] = consts[0];
    if (key === undefined) key = branchKey;
    expect(branchKey, "shared discriminator").toBe(key);
    literals.push(property.const as string);
  }
  return { key: key!, literals };
}

type Call = { tool: string; body: string };

const CALL = /`([a-z0-9_]+) \{request:\{([^}]*)\}\}`/g;

// Every fully qualified backticked call in a table cell.
function callsFrom(cell: string): Call[] {
  return [...cell.matchAll(CALL)].map((match) => ({
    tool: match[1],
    body: match[2],
  }));
}

// Every backticked span that mentions request:, including malformed calls the
// parser above would otherwise skip silently.
function requestSpans(cell: string): string[] {
  return [...cell.matchAll(/`([^`]*request:[^`]*)`/g)].map((match) => match[1]);
}

// tool:branch for one documented call, using the schema's discriminator.
function targetOf(call: Call): string {
  const schema = CONSOLIDATED[call.tool];
  expect(schema, call.tool).toBeDefined();
  const { key } = branches(schema);
  const literal = new RegExp(`\\b${key}:"([a-z_]+)"`).exec(call.body)?.[1];
  expect(literal, `${call.tool} branch`).toBeDefined();
  return `${call.tool}:${literal}`;
}

function section(heading: string): string {
  const start = ROUTING_DOC.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const rest = ROUTING_DOC.slice(start + heading.length);
  const end = rest.indexOf("\n## ");
  return end === -1 ? rest : rest.slice(0, end);
}

function tableRows(heading: string): Array<{ from: string; to: string }> {
  return section(heading)
    .split("\n")
    .filter((line) => /^\|\s*`[a-z0-9_]+`\s*\|/.test(line))
    .map((line) => {
      const cells = line.split("|").map((cell) => cell.trim());
      return { from: cells[1].replaceAll("`", ""), to: cells[2] };
    });
}

describe("v2-routing.md", () => {
  it("maps every replaced 1.x tool exactly once", () => {
    const rows = tableRows("## Replaced operations");
    expect(rows).toHaveLength(DERIVED_REPLACED.length);
    expect([...new Set(REPLACED_1X)].sort()).toEqual([...DERIVED_REPLACED].sort());
    expect(ROUTING_DOC).toContain(`All ${DERIVED_REPLACED.length} replaced`);
    expect(rows.map((row) => row.from).sort()).toEqual([...REPLACED_1X].sort());
    for (const name of REPLACED_1X) expect(ROUTING_DOC, name).toContain(name);
  });

  it("pins every legacy operation to its intended v2 branch", () => {
    const actual: Record<string, string[]> = {};
    for (const row of tableRows("## Replaced operations")) {
      actual[row.from] = callsFrom(row.to).map(targetOf);
    }
    expect(actual).toEqual(EXPECTED_TARGETS);
  });

  it("sends every mapped call to a consolidated tool with a real branch literal", () => {
    expect(Object.keys(CONSOLIDATED).sort()).toEqual([...V2_ONLY].sort());

    for (const row of tableRows("## Replaced operations")) {
      const calls = callsFrom(row.to);
      expect(calls.length, row.from).toBeGreaterThan(0);
      expect(calls.length, `${row.from} has an unparsed request call`).toBe(
        requestSpans(row.to).length,
      );

      for (const call of calls) {
        const label = `${row.from} -> ${call.tool}`;
        const schema = CONSOLIDATED[call.tool];
        expect(schema, label).toBeDefined();

        const { key, literals } = branches(schema);
        const discriminators = [
          ...call.body.matchAll(/\b(kind|action):"[a-z_]+"/g),
        ].map((match) => match[1]);
        expect(discriminators, label).toEqual([key]);

        const literal = new RegExp(`\\b${key}:"([a-z_]+)"`).exec(call.body)?.[1];
        expect(literal, label).toBeDefined();
        expect(literals, `${label} ${literal}`).toContain(literal!);
      }
    }
  });

  it("keeps retained examples flat and every v2 tool accounted for", () => {
    const retainedRows = tableRows("## Retained flat tools");
    const retained = retainedRows.map((row) => row.from);
    expect(retained.sort()).toEqual([...RETAINED].sort());

    for (const row of retainedRows) {
      expect(row.to, row.from).not.toContain("request:");
      expect(/^`([a-z0-9_]+) \{/.exec(row.to)?.[1], row.from).toBe(row.from);
    }

    const targets = [
      ...new Set(
        tableRows("## Replaced operations").flatMap((row) =>
          callsFrom(row.to).map((call) => call.tool),
        ),
      ),
    ];
    expect(targets.sort()).toEqual([...V2_ONLY].sort());
    expect([...new Set([...targets, ...retained])].sort()).toEqual(
      [...V2_TOOL_NAMES].sort(),
    );
  });

  it("never presents a v2-only tool as a 1.x tool", () => {
    const mapped = tableRows("## Replaced operations").map((row) => row.from);
    const retained = tableRows("## Retained flat tools").map((row) => row.from);
    expect(V2_ONLY).toHaveLength(10);
    for (const name of V2_ONLY) {
      expect(mapped, name).not.toContain(name);
      expect(retained, name).not.toContain(name);
    }
  });

  it("documents every v2 tool and the exact profile counts", () => {
    for (const name of V2_TOOL_NAMES) expect(ROUTING_DOC, name).toContain(`\`${name}\``);
    expect(ROUTING_DOC).toContain("AWWWARDS_MCP_PROFILE=v2");
    expect(ROUTING_DOC).toContain(`| \`full\` (default) | ${FULL_TOOL_NAMES.length} |`);
    expect(ROUTING_DOC).toContain(`| \`core\` | ${CORE_TOOL_NAMES.length} |`);
    expect(ROUTING_DOC).toContain(`| \`v2\` | ${V2_TOOL_NAMES.length} |`);
  });

  it("keeps the build_project and compact-census hand-off caveats", () => {
    expect(ROUTING_DOC).toContain("npm install && npm run build");
    expect(ROUTING_DOC).toContain("compact:false");
    expect(ROUTING_DOC).toContain("cannot feed `build_motion`");
  });
});

describe("skills install docs", () => {
  it("installs the skills from the awwwards-skills repository", () => {
    expect(README_TEXT).toContain("npx skills add INSANE0777/awwwards-skills");
    expect(README_DOC).toContain("https://github.com/INSANE0777/awwwards-skills");
    expect(README_DOC).not.toContain("node_modules/awwwards-mcp/skills");
    expect(README_DOC).not.toContain("node_modules\\awwwards-mcp\\skills");
  });
});
