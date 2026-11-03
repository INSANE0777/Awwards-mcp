import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerV2Tools, V2_TOOL_NAMES } from "../src/v2/register.js";
import { scaffoldMotionManifest } from "../src/motion-manifest.js";

// Documentation guard: every request example in skills/v2-routing.md must be a
// real v2 tool and must parse against the input schema the server actually
// registers. The schemas are collected from registerV2Tools with a fake
// context, so retained tools (whose shapes are inline) are covered too, and no
// server boot or network is involved.
const ROUTING_DOC = readFileSync(
  new URL("../skills/v2-routing.md", import.meta.url),
  "utf8",
);

const RETAINED: readonly string[] = [
  "create_design_brief",
  "build_project",
  "verify_build",
  "verify_flow",
  "analyze_network_capture",
];

type Example = { tool: string; arguments: unknown };

function registeredSchemas(): Map<string, z.ZodType> {
  const schemas = new Map<string, z.ZodType>();
  const record = (name: string, inputSchema: unknown) => {
    const schema =
      inputSchema instanceof z.ZodType ? inputSchema : z.object(inputSchema as z.ZodRawShape);
    schemas.set(name, schema);
  };
  const tool = (name: string, _description: string, inputSchema: unknown) =>
    record(name, inputSchema);
  const registerTool = (name: string, config: { inputSchema: unknown }) =>
    record(name, config.inputSchema);
  registerV2Tools({ handlers: {} as never, tool, registerTool } as never);
  return schemas;
}

// The examples section is fenced JSON with one complete tools/call envelope per
// line, grouped under one heading per tool.
function documentedExamples(): Example[] {
  const start = ROUTING_DOC.indexOf("## Exact v2 request examples");
  expect(start, "## Exact v2 request examples").toBeGreaterThanOrEqual(0);
  const end = ROUTING_DOC.indexOf("\n## ", start + 1);
  const section = ROUTING_DOC.slice(start, end === -1 ? undefined : end);
  const blocks = [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]);
  expect(blocks.length, "json blocks").toBeGreaterThan(0);
  return blocks.flatMap((block) =>
    block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Example),
  );
}

type JsonSchema = {
  oneOf?: Array<{ properties?: Record<string, { const?: unknown }> }>;
};

// Same discriminator extraction as the routing-table test: read the branch
// literals from the registered schema's JSON Schema instead of zod internals.
function branches(schema: z.ZodType): { key: string; literals: string[] } {
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

function requestObject(example: Example): Record<string, unknown> {
  expect(example.arguments, `${example.tool} arguments`).toBeTypeOf("object");
  const args = example.arguments as Record<string, unknown>;
  expect(args.request, `${example.tool} request`).toBeTypeOf("object");
  return args.request as Record<string, unknown>;
}

const SCHEMAS = registeredSchemas();
const EXAMPLES = documentedExamples();

describe("skills/v2-routing.md exact examples", () => {
  it("registers the schema for every v2 tool and no other name", () => {
    expect([...SCHEMAS.keys()].sort()).toEqual([...V2_TOOL_NAMES].sort());
  });

  it("uses only real v2 tool names", () => {
    for (const example of EXAMPLES) {
      expect(V2_TOOL_NAMES, example.tool).toContain(example.tool);
    }
    expect(new Set(EXAMPLES.map((example) => example.tool)).size).toBe(V2_TOOL_NAMES.length);
  });

  it("parses every example against the schema the server registers", () => {
    for (const example of EXAMPLES) {
      const parsed = SCHEMAS.get(example.tool)!.safeParse(example.arguments);
      expect(parsed.success, `${example.tool}: ${parsed.success ? "" : parsed.error.message}`).toBe(
        true,
      );
    }
  });

  it("keeps consolidated envelopes under request and retained tools flat", () => {
    for (const example of EXAMPLES) {
      const args = example.arguments as Record<string, unknown>;
      if (RETAINED.includes(example.tool)) {
        expect(args, example.tool).not.toHaveProperty("request");
      } else {
        expect(args, example.tool).toHaveProperty("request");
      }
    }
    expect(EXAMPLES).toHaveLength(42);
  });

  it("covers every consolidated branch exactly once", () => {
    for (const tool of V2_TOOL_NAMES.filter((name) => !RETAINED.includes(name))) {
      const input = SCHEMAS.get(tool)! as z.ZodObject<{ request: z.ZodType }>;
      const { key, literals } = branches(input.shape.request);
      const documented = EXAMPLES.filter((example) => example.tool === tool).map((example) => {
        const literal = requestObject(example)[key];
        expect(literal, `${tool} ${key}`).toBeTypeOf("string");
        return literal as string;
      });
      expect(documented.sort(), tool).toEqual([...literals].sort());
    }
  });

  it("documents a build_motion manifest that actually scaffolds", () => {
    const example = EXAMPLES.find(
      (row) =>
        row.tool === "build_motion" &&
        (requestObject(row) as Record<string, unknown>).kind === "manifest",
    );
    expect(example, "manifest example").toBeDefined();
    const result = scaffoldMotionManifest(requestObject(example!));
    expect("error" in result, JSON.stringify(result)).toBe(false);
  });

  it("shows every retained tool with its own flat schema", () => {
    for (const tool of RETAINED) {
      const examples = EXAMPLES.filter((example) => example.tool === tool);
      expect(examples, tool).toHaveLength(1);
      expect(
        SCHEMAS.get(tool)!.safeParse(examples[0].arguments).success,
        `${tool} flat example`,
      ).toBe(true);
    }
  });
});
