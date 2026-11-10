import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Registrations live in src/tools/*.ts and run at connect time, so the
// annotation contract is asserted on the sources themselves. M8ven/OpenAI's
// directory rejects tools where any of the four hints is missing or
// non-boolean — this test fails if a tool regresses.
describe("tool annotations", () => {
  const toolsDir = join(__dirname, "../src/tools");
  const src = readdirSync(toolsDir)
    .filter((file) => file.endsWith(".ts") && file !== "shared.ts" && file !== "index.ts")
    .sort()
    .map((file) => readFileSync(join(toolsDir, file), "utf8"))
    .join("\n");

  // Slice out the balanced-parens block for one named registration.
  function registrationBlock(kind: "tool" | "registerTool", name: string): string {
    const match = new RegExp(`(?:ctx\\.)?${kind}\\(\\s*"${name}"`).exec(src);
    expect(match, `registration for ${name}`).not.toBeNull();
    const start = match!.index + match![0].indexOf("(");
    let i = start + 1;
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      i++;
    }
    return src.slice(start, i);
  }

  it("every tool registration declares all four boolean hints", () => {
    // get_site_details uses registerTool because its cross-field .refine
    // cannot be expressed as a raw parameter shape. All registrations go
    // through the guarded tool()/registerTool() wrappers in server-instance.ts.
    const calls = src.match(/^\s*(?:ctx\.)?(?:tool|registerTool)\(/gm) ?? [];
    // 41 historical tools + 4 Phase 6A Atlas tools (registered only when the
    // runtime flag is on; the source contract is still four hints each).
    expect(calls.length).toBe(45);

    // Slice out each balanced-parens registration block and require the
    // four hint keys with explicit boolean values inside it.
    const re = /^\s*(?:ctx\.)?(?:tool|registerTool)\(/gm;
    let m: RegExpExecArray | null;
    let checked = 0;
    while ((m = re.exec(src))) {
      let i = m.index + m[0].length;
      let depth = 1;
      while (i < src.length && depth > 0) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
        i++;
      }
      const block = src.slice(m.index, i);
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        expect(block, `tool block missing ${hint}: ${block.slice(0, 80)}`).toMatch(
          new RegExp(`${hint}: (true|false)`),
        );
      }
      checked++;
    }
    expect(checked).toBe(calls.length);
  });

  it("registers create_design_brief as a read-only idempotent open-world tool", () => {
    const block = registrationBlock("tool", "create_design_brief");
    expect(block).toContain("slugs:");
    expect(block).toContain("goal:");
    expect(block).toContain("includeStructure:");
    expect(block).toContain("readOnlyHint: true");
    expect(block).toContain("destructiveHint: false");
    expect(block).toContain("idempotentHint: true");
    expect(block).toContain("openWorldHint: true");
    expect(block).toContain("/^[\\w-]+$/");
    expect(block).toContain("toLowerCase()");
    expect(block).toContain("goal: z.string().trim().min(1).max(2000)");
    expect(block).toContain("audience: z.string().trim().min(1).max(1000).optional()");
    expect(block).toContain("constraints: z.array(z.string().trim().min(1).max(1000)).max(20).optional()");
  });

  it("registers analyze_network_capture as a read-only offline tool", () => {
    const block = registrationBlock("tool", "analyze_network_capture");
    expect(block).toContain("path: z.string()");
    expect(block).toContain("top: z.number().int().min(1).max(200).optional()");
    expect(block).toContain("readOnlyHint: true");
    expect(block).toContain("destructiveHint: false");
    expect(block).toContain("idempotentHint: true");
    expect(block).toContain("openWorldHint: false");
  });

  it("registers verify_flow as a non-read-only click tool with bounded steps", () => {
    const block = registrationBlock("registerTool", "verify_flow");
    expect(block).toContain("inputSchema: verifyFlowArgsSchema");
    expect(block).toContain("readOnlyHint: false");
    expect(block).toContain("destructiveHint: false");
    expect(block).toContain("idempotentHint: false");
    expect(block).toContain("openWorldHint: true");
    expect(block).toContain("No screenshots");
  });

  it("registers the Atlas tools with the spec annotations", () => {
    const search = registrationBlock("tool", "search_atlas");
    for (const hint of [
      "readOnlyHint: true",
      "destructiveHint: false",
      "idempotentHint: true",
      "openWorldHint: false",
    ]) {
      expect(search).toContain(hint);
    }
    const get = registrationBlock("tool", "get_atlas");
    expect(get).toContain("readOnlyHint: true");
    expect(get).toContain("openWorldHint: false");
    const capture = registrationBlock("tool", "capture_atlas");
    expect(capture).toContain("readOnlyHint: false");
    expect(capture).toContain("idempotentHint: false");
    expect(capture).toContain("openWorldHint: true");
    expect(capture).toContain("destructiveHint: false");
    const exportPack = registrationBlock("tool", "export_evidence_pack");
    expect(exportPack).toContain("readOnlyHint: false");
    expect(exportPack).toContain("idempotentHint: true");
    expect(exportPack).toContain("openWorldHint: false");
    expect(exportPack).toContain("destructiveHint: false");
  });

  it("registers recording as non-read-only because it clicks and submits", () => {
    const legacy = registrationBlock("tool", "record_site_motion");
    expect(legacy).toContain("readOnlyHint: false");
    expect(legacy).toContain("destructiveHint: true");
    expect(legacy).toContain("idempotentHint: false");
    expect(legacy).toContain("can click interactive elements and submit their forms");
    const v2 = readFileSync(join(__dirname, "../src/v2/capture-page.ts"), "utf8");
    expect(v2).toContain("destructiveHint: true");
    expect(v2).toContain("readOnlyHint: false");
    expect(v2).toContain("recording branch can click interactive elements and submit their forms");
  });
});
