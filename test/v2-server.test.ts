import { describe, expect, it } from "vitest";
import { createServer } from "../src/server-instance.js";
import { V2_SERVER_INSTRUCTIONS, V2_TOOL_NAMES } from "../src/v2/register.js";

const toolNames = (server: unknown): string[] =>
  Object.keys((server as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {});

const toolTable = (server: any): Record<string, any> => server._registeredTools;
const schemaJson = (server: any, name: string): unknown => server.toolInputSchemaJson(name);

// Routing prose is allowed to change in v2; the field contract is not.
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key !== "description") out[key] = stripDescriptions(child);
  }
  return out;
}

function withProfile<T>(profile: string | undefined, fn: () => T): T {
  const savedProfile = process.env.AWWWARDS_MCP_PROFILE;
  const savedLegacy = process.env.AWARDS_MCP_PROFILE;
  const savedAtlas = process.env.AWWWARDS_MCP_ATLAS;
  process.env.AWWWARDS_MCP_PROFILE = profile ?? "full";
  delete process.env.AWARDS_MCP_PROFILE;
  delete process.env.AWWWARDS_MCP_ATLAS;
  try {
    return fn();
  } finally {
    if (savedProfile === undefined) delete process.env.AWWWARDS_MCP_PROFILE;
    else process.env.AWWWARDS_MCP_PROFILE = savedProfile;
    if (savedLegacy === undefined) delete process.env.AWARDS_MCP_PROFILE;
    else process.env.AWARDS_MCP_PROFILE = savedLegacy;
    if (savedAtlas === undefined) delete process.env.AWWWARDS_MCP_ATLAS;
    else process.env.AWWWARDS_MCP_ATLAS = savedAtlas;
  }
}

const serverFor = (profile: string | undefined) =>
  withProfile(profile, () => createServer({ handlers: {} as any, version: "0.0.0-test" }));

describe("v2 server profile", () => {
  it("registers exactly the 15 consolidated tools and no 1.x names", () => {
    const server = serverFor("v2");
    const names = toolNames(server);

    expect(V2_TOOL_NAMES).toHaveLength(15);
    expect(new Set(V2_TOOL_NAMES).size).toBe(15);
    expect(names.sort()).toEqual([...V2_TOOL_NAMES].sort());
    expect(names).not.toContain("search_sites");
    expect(names).not.toContain("get_site_details");
    expect(names).not.toContain("build_gsap_stub");
    expect(names).not.toContain("search_motion");
    expect(names).not.toContain("capture_live_site");
    expect(names).not.toContain("audit_url");
    expect((server as any).server._instructions).toBe(V2_SERVER_INSTRUCTIONS);
    expect(V2_SERVER_INSTRUCTIONS).toContain("search_references");
    expect(V2_SERVER_INSTRUCTIONS).toContain("build_motion");
    expect(V2_SERVER_INSTRUCTIONS).toContain("verify_build");
    expect(V2_SERVER_INSTRUCTIONS).toContain("AWWWARDS_MCP_PROFILE=v2");
  });

  it("keeps the five retained tools identical to 1.x", () => {
    const base = serverFor(undefined) as any;
    const v2 = serverFor("v2") as any;
    for (const name of [
      "create_design_brief",
      "build_project",
      "verify_build",
      "verify_flow",
      "analyze_network_capture",
    ]) {
      expect(stripDescriptions(schemaJson(v2, name)), `${name} schema`).toEqual(
        stripDescriptions(schemaJson(base, name)),
      );
      expect(toolTable(v2)[name].annotations, `${name} annotations`).toEqual(
        toolTable(base)[name].annotations,
      );
    }
  });

  it("does not reference 1.x tool names in v2 descriptions or schemas", () => {
    const base = serverFor(undefined) as any;
    const v2 = serverFor("v2") as any;
    const legacy = toolNames(base).filter((name) => !V2_TOOL_NAMES.includes(name));
    expect(legacy.length).toBe(36);
    for (const name of V2_TOOL_NAMES) {
      const text = `${toolTable(v2)[name].description}\n${JSON.stringify(schemaJson(v2, name))}`;
      for (const old of legacy) {
        expect(text, `${name} references ${old}`).not.toContain(old);
      }
    }
  });

  it("switches between default, core and v2 in one process", () => {
    expect(toolNames(serverFor(undefined))).toHaveLength(41);
    expect(toolNames(serverFor("core"))).toHaveLength(13);
    expect(toolNames(serverFor("v2"))).toHaveLength(15);
  });

  it("honours the profile variable advertised in the instructions", () => {
    const advertised = /([A-Z_]+)=v2/.exec(V2_SERVER_INSTRUCTIONS)?.[1];
    expect(advertised).toBe("AWWWARDS_MCP_PROFILE");
    const savedProfile = process.env.AWWWARDS_MCP_PROFILE;
    const savedLegacy = process.env.AWARDS_MCP_PROFILE;
    delete process.env.AWWWARDS_MCP_PROFILE;
    delete process.env.AWARDS_MCP_PROFILE;
    process.env[advertised!] = "v2";
    try {
      expect(toolNames(createServer({ handlers: {} as any, version: "0.0.0-test" }))).toHaveLength(
        15,
      );
    } finally {
      delete process.env[advertised!];
      if (savedProfile === undefined) delete process.env.AWWWARDS_MCP_PROFILE;
      else process.env.AWWWARDS_MCP_PROFILE = savedProfile;
      if (savedLegacy === undefined) delete process.env.AWARDS_MCP_PROFILE;
      else process.env.AWARDS_MCP_PROFILE = savedLegacy;
    }
  });
});
