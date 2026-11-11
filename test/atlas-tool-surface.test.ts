import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import { CORE_TOOL_NAMES } from "../src/tool-profile.js";
import { registerAllTools } from "../src/tools/index.js";
import { V2_TOOL_NAMES, registerV2Tools, v2ToolNames } from "../src/v2/register.js";
import { createServer } from "../src/server-instance.js";
import { createHandlers } from "../src/server.js";
import { indexGetOutputSchema } from "../src/index-contracts.js";
import {
  captureAtlasInputSchema,
  exportEvidencePackInputSchema,
  getAtlasInputSchema,
  searchAtlasInputSchema,
} from "../src/atlas/tool-contracts.js";
import { runGetAtlas } from "../src/atlas/tools.js";
import { runAtlasStatus } from "../src/atlas/tool-read.js";
import {
  capturePageRequestSchema,
  runCapturePage,
} from "../src/v2/capture-page.js";
import { getIndexRequestSchema, runGetIndex } from "../src/v2/get-index.js";
import { getReferenceRequestSchema, runGetReference } from "../src/v2/get-reference.js";
import {
  runSearchReferences,
  searchReferencesRequestSchema,
} from "../src/v2/search-references.js";

const ATLAS_TOOLS = ["search_atlas", "get_atlas", "capture_atlas", "export_evidence_pack"] as const;
const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-surface-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function withProfile<T>(profile: string | undefined, fn: () => T): T {
  const saved = process.env.AWWWARDS_MCP_PROFILE;
  const savedLegacy = process.env.AWARDS_MCP_PROFILE;
  if (profile === undefined) delete process.env.AWWWARDS_MCP_PROFILE;
  else process.env.AWWWARDS_MCP_PROFILE = profile;
  delete process.env.AWARDS_MCP_PROFILE;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.AWWWARDS_MCP_PROFILE;
    else process.env.AWWWARDS_MCP_PROFILE = saved;
    if (savedLegacy === undefined) delete process.env.AWARDS_MCP_PROFILE;
    else process.env.AWARDS_MCP_PROFILE = savedLegacy;
  }
}

function namesFor(profile: string | undefined, atlas: boolean): string[] {
  return withProfile(profile, () => {
    const names: string[] = [];
    const ctx = {
      handlers: {} as any,
      tool: (...args: any[]) => names.push(String(args[0])),
      registerTool: (...args: any[]) => names.push(String(args[0])),
    };
    if (profile === "v2") registerV2Tools(ctx, { atlas });
    else registerAllTools(ctx, { atlas });
    return names;
  });
}

function serverNames(profile: string | undefined, atlas: boolean): string[] {
  const saved = process.env.AWWWARDS_MCP_ATLAS;
  process.env.AWWWARDS_MCP_ATLAS = atlas ? "1" : "0";
  try {
    return withProfile(profile, () => {
      const server = createServer({ handlers: {} as any, version: "0.0.0-test" }) as any;
      return Object.keys(server._registeredTools ?? {});
    });
  } finally {
    if (saved === undefined) delete process.env.AWWWARDS_MCP_ATLAS;
    else process.env.AWWWARDS_MCP_ATLAS = saved;
  }
}

const okResponse = { content: [{ type: "text", text: "ok" }] };
function fakeAtlasHandlers() {
  return {
    search_sites: vi.fn().mockResolvedValue(okResponse),
    search_elements: vi.fn().mockResolvedValue(okResponse),
    search_directory: vi.fn().mockResolvedValue(okResponse),
    search_motion: vi.fn().mockResolvedValue(okResponse),
    get_collections: vi.fn().mockResolvedValue(okResponse),
    get_site_details: vi.fn().mockResolvedValue(okResponse),
    get_site_elements: vi.fn().mockResolvedValue(okResponse),
    get_element: vi.fn().mockResolvedValue(okResponse),
    compare_sites: vi.fn().mockResolvedValue(okResponse),
    get_index_status: vi.fn().mockResolvedValue(okResponse),
    get_index_stats: vi.fn().mockResolvedValue(okResponse),
    search_atlas: vi.fn().mockResolvedValue(okResponse),
    get_atlas: vi.fn().mockResolvedValue(okResponse),
    capture_atlas: vi.fn().mockResolvedValue(okResponse),
    export_evidence_pack: vi.fn().mockResolvedValue(okResponse),
    capture_live_site: vi.fn().mockResolvedValue(okResponse),
    capture_component: vi.fn().mockResolvedValue(okResponse),
    capture_pose_3d: vi.fn().mockResolvedValue(okResponse),
    capture_scene_3d: vi.fn().mockResolvedValue(okResponse),
    download_scene_assets: vi.fn().mockResolvedValue(okResponse),
    record_site_motion: vi.fn().mockResolvedValue(okResponse),
  };
}

describe("Atlas tool flag", () => {
  it("registers none of the four when the flag is off", () => {
    const full = namesFor(undefined, false);
    expect(full).toHaveLength(41);
    expect(full.some((name) => ATLAS_TOOLS.includes(name as any))).toBe(false);
    expect(serverNames("core", false)).toHaveLength(13);
    expect(namesFor("v2", false)).toHaveLength(15);
    expect(namesFor("v2", false)).not.toContain("export_evidence_pack");
  });

  it("registers 45 full / 13 core / 16 v2 when the flag is on, without dual registration", () => {
    const full = namesFor(undefined, true);
    expect(full).toHaveLength(45);
    expect(new Set(full).size).toBe(45);
    expect(full.slice(-4)).toEqual([...ATLAS_TOOLS]);
    expect(full.filter((name) => ATLAS_TOOLS.includes(name as any))).toHaveLength(4);

    const core = serverNames("core", true);
    expect(core).toHaveLength(13);
    for (const name of ATLAS_TOOLS) expect(core).not.toContain(name);
    for (const name of CORE_TOOL_NAMES) expect(core).toContain(name);

    const v2 = namesFor("v2", true);
    expect(v2).toHaveLength(16);
    expect(v2.filter((name) => name === "export_evidence_pack")).toHaveLength(1);
    for (const name of ["search_atlas", "get_atlas", "capture_atlas"]) {
      expect(v2).not.toContain(name);
    }
    expect(V2_TOOL_NAMES).toHaveLength(15);
    expect(v2ToolNames(true)).toHaveLength(16);
    expect(v2ToolNames(false)).toHaveLength(15);
  });

  it("reads the flag at server start and keeps old counts when off", () => {
    expect(serverNames(undefined, false)).toHaveLength(41);
    expect(serverNames(undefined, true)).toHaveLength(45);
    expect(serverNames("core", true)).toHaveLength(13);
    expect(serverNames("v2", false)).toHaveLength(15);
    expect(serverNames("v2", true)).toHaveLength(16);

    const off = serverNames(undefined, false);
    for (const name of ATLAS_TOOLS) expect(off).not.toContain(name);
  });
});

describe("Atlas input contracts", () => {
  it("rejects cross-branch and unbounded search input", () => {
    expect(searchAtlasInputSchema.safeParse({ kind: "sections", extra: true }).success).toBe(false);
    expect(searchAtlasInputSchema.safeParse({ kind: "sections", limit: 21 }).success).toBe(false);
    expect(searchAtlasInputSchema.safeParse({ kind: "sections", facets: ["region.tag", "region.role", "region.landmark", "section.purpose", "region.kind"] }).success).toBe(false);
    expect(searchAtlasInputSchema.safeParse({ kind: "sections", predicates: [{ field: "section.purpose", values: [] }] }).success).toBe(false);
    expect(searchAtlasInputSchema.safeParse({ kind: "components", query: "x".repeat(301) }).success).toBe(false);
    // Spec 10.1: one predicate carries 1-8 values; 9+ is rejected at the schema
    // boundary instead of passing through to UNSUPPORTED_PREDICATE.
    const eight = ["hero", "features", "pricing", "contact", "cta", "faq", "logos", "metrics"];
    expect(
      searchAtlasInputSchema.safeParse({
        kind: "sections",
        predicates: [{ field: "section.purpose", values: eight }],
      }).success,
    ).toBe(true);
    expect(
      searchAtlasInputSchema.safeParse({
        kind: "sections",
        predicates: [{ field: "section.purpose", values: [...eight, "about"] }],
      }).success,
    ).toBe(false);
    // Spec 10.1: siteSlugs is 1-20 distinct.
    expect(searchAtlasInputSchema.safeParse({ kind: "sections", siteSlugs: ["site-a", "site-a"] }).success).toBe(false);
    expect(searchAtlasInputSchema.safeParse({ kind: "sections", siteSlugs: ["site-a", "site-b"] }).success).toBe(true);
  });

  it("validates each get_atlas branch strictly", () => {
    for (const input of [
      { kind: "status" },
      { kind: "taxonomy" },
      { kind: "region", regionId: "a".repeat(64) },
      { kind: "highlight", elementId: "some-element" },
    ]) {
      expect(getAtlasInputSchema.safeParse(input).success).toBe(true);
      expect(getAtlasInputSchema.safeParse({ ...input, extra: true }).success).toBe(false);
    }
    expect(getAtlasInputSchema.safeParse({ kind: "status", regionId: "a".repeat(64) }).success).toBe(false);
    expect(getAtlasInputSchema.safeParse({ kind: "region", regionId: "short" }).success).toBe(false);
    expect(getAtlasInputSchema.safeParse({ kind: "highlight", elementId: "" }).success).toBe(false);
    expect(captureAtlasInputSchema.safeParse({ slug: "site", extra: true }).success).toBe(false);
    expect(exportEvidencePackInputSchema.safeParse({ regionIds: ["a".repeat(64)], extra: true }).success).toBe(false);
  });

  it("bounds capture_atlas states and paths", () => {
    const id = "a".repeat(64);
    expect(
      captureAtlasInputSchema.safeParse({
        slug: "site",
        states: [
          { action: "hover", targetRegionId: id },
          { action: "hover", targetRegionId: id },
        ],
      }).success,
    ).toBe(false);
    expect(
      captureAtlasInputSchema.safeParse({
        slug: "site",
        states: [
          { action: "hover", targetRegionId: id },
          { action: "focus", targetRegionId: id },
          { action: "hover", targetRegionId: "b".repeat(64) },
          { action: "focus", targetRegionId: "b".repeat(64) },
        ],
      }).success,
    ).toBe(false);
    expect(captureAtlasInputSchema.safeParse({ slug: "site", path: "/a?b=1" }).success).toBe(false);
    expect(captureAtlasInputSchema.safeParse({ slug: "site", path: "//evil.example" }).success).toBe(false);
    expect(captureAtlasInputSchema.safeParse({ slug: "site", path: "/work" }).success).toBe(true);
  });

  it("bounds and de-duplicates export selections", () => {
    const id = (n: number) => String(n).padStart(2, "0").repeat(32);
    expect(exportEvidencePackInputSchema.safeParse({ regionIds: [] }).success).toBe(false);
    expect(exportEvidencePackInputSchema.safeParse({ regionIds: [id(1), id(1)] }).success).toBe(false);
    expect(
      exportEvidencePackInputSchema.safeParse({ regionIds: Array.from({ length: 13 }, (_, i) => id(i)) })
        .success,
    ).toBe(false);
    expect(
      exportEvidencePackInputSchema.safeParse({
        regionIds: [id(1)],
        goal: "x".repeat(1001),
      }).success,
    ).toBe(false);
    expect(
      exportEvidencePackInputSchema.safeParse({
        regionIds: [id(1), id(2)],
        includeMedia: "permitted",
        rightsAssertions: [
          {
            artifactId: id(3),
            rights: {
              status: "licensed",
              reference: "license-1",
              recordedAt: 1,
              assertedBy: "caller",
              scope: "export_copy",
            },
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("v2 Atlas routing", () => {
  it("routes search_references sections/components to search_atlas", async () => {
    const handlers = fakeAtlasHandlers();
    const request = searchReferencesRequestSchema.parse({
      kind: "sections",
      query: "pricing",
      scope: "page",
      viewport: "mobile",
      state: "hover",
      evidenceMode: "accepted",
      facets: ["region.tag"],
      limit: 3,
    });
    await runSearchReferences(handlers as any, request);
    expect(handlers.search_atlas).toHaveBeenCalledWith({
      kind: "sections",
      query: "pricing",
      scope: "page",
      viewport: "mobile",
      state: "hover",
      evidenceMode: "accepted",
      facets: ["region.tag"],
      limit: 3,
    });
    expect(handlers.search_sites).not.toHaveBeenCalled();
  });

  it("routes get_reference atlas branches", async () => {
    const handlers = fakeAtlasHandlers();
    const id = "a".repeat(64);
    await runGetReference(
      handlers as any,
      getReferenceRequestSchema.parse({ kind: "atlas_region", regionId: id }),
    );
    await runGetReference(
      handlers as any,
      getReferenceRequestSchema.parse({ kind: "atlas_highlight", elementId: "hero" }),
    );
    await runGetReference(
      handlers as any,
      getReferenceRequestSchema.parse({ kind: "atlas_taxonomy" }),
    );
    expect(handlers.get_atlas).toHaveBeenNthCalledWith(1, { kind: "region", regionId: id });
    expect(handlers.get_atlas).toHaveBeenNthCalledWith(2, {
      kind: "highlight",
      elementId: "hero",
    });
    expect(handlers.get_atlas).toHaveBeenNthCalledWith(3, { kind: "taxonomy" });
    expect(handlers.get_site_details).not.toHaveBeenCalled();
  });

  it("routes get_index atlas_status to get_atlas status", async () => {
    const handlers = fakeAtlasHandlers();
    await runGetIndex(handlers as any, getIndexRequestSchema.parse({ kind: "atlas_status" }));
    expect(handlers.get_atlas).toHaveBeenCalledWith({ kind: "status" });
    expect(handlers.get_index_status).not.toHaveBeenCalled();
  });

  it("routes capture_page atlas to capture_atlas", async () => {
    const handlers = fakeAtlasHandlers();
    const request = capturePageRequestSchema.parse({
      kind: "atlas",
      slug: "known-site",
      viewport: "mobile",
      components: false,
      refresh: true,
    });
    await runCapturePage(handlers as any, request);
    expect(handlers.capture_atlas).toHaveBeenCalledWith({
      slug: "known-site",
      viewport: "mobile",
      components: false,
      refresh: true,
    }, undefined);
    expect(handlers.capture_live_site).not.toHaveBeenCalled();
  });

  it("forwards the abort signal to the atlas capture branch", async () => {
    const handlers = fakeAtlasHandlers();
    const request = capturePageRequestSchema.parse({ kind: "atlas", slug: "known-site" });
    const signal = new AbortController().signal;
    await runCapturePage(handlers as any, request, signal);
    expect(handlers.capture_atlas).toHaveBeenCalledWith({ slug: "known-site" }, signal);
  });
});

describe("atlas_status output contract", () => {
  it("validates the atlas branch explicitly and rejects mixed branches", () => {
    const cache = new Cache(tmpDir(), () => 1_700_000_000_000, { atlas: true });
    const envelope = runGetAtlas(cache, { kind: "status" }, 1_700_000_000_000);
    expect(indexGetOutputSchema.safeParse(envelope).success).toBe(true);
    expect(indexGetOutputSchema.safeParse({ ...envelope, sitesCount: 0 }).success).toBe(false);
    expect(indexGetOutputSchema.safeParse({ ...envelope, data: { bogus: true } }).success).toBe(false);
    expect(indexGetOutputSchema.safeParse({ sitesCount: 0, coverage: {} }).success).toBe(false);
  });

  it("returns FEATURE_DISABLED for every Atlas op when the cache flag is off", async () => {
    const cache = new Cache(tmpDir(), () => 1_700_000_000_000, { atlas: false });
    const handlers = createHandlers({ client: {} as any, cache });
    const calls = [
      () => handlers.search_atlas({ kind: "sections" }),
      () => handlers.get_atlas({ kind: "status" }),
      () => handlers.capture_atlas({ slug: "site" }),
      () => handlers.export_evidence_pack({ regionIds: ["a".repeat(64)] }),
    ];
    for (const call of calls) {
      const result = await call();
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.parse(result.content[0]!.text).error.code).toBe("FEATURE_DISABLED");
    }

    // The direct status reader bypasses the gate, so it reports the real flag.
    expect(runAtlasStatus(cache, 1_700_000_000_000).data?.enabled).toBe(false);
  });

  it("returns FEATURE_DISABLED for every v2 Atlas branch when the flag is off", async () => {
    const cache = new Cache(tmpDir(), () => 1_700_000_000_000, { atlas: false });
    const handlers = createHandlers({ client: {} as any, cache });
    const calls = [
      () => runSearchReferences(handlers, { kind: "sections" } as any),
      () =>
        runGetReference(handlers, {
          kind: "atlas_region",
          regionId: "a".repeat(64),
        } as any),
      () => runGetIndex(handlers, { kind: "atlas_status" } as any),
      () => runCapturePage(handlers, { kind: "atlas", slug: "site" } as any),
    ];
    for (const call of calls) {
      const result = await call();
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text).error.code).toBe("FEATURE_DISABLED");
    }
  });

  it("advertises an object output schema for the four Atlas tools when on", () => {
    const saved = process.env.AWWWARDS_MCP_ATLAS;
    process.env.AWWWARDS_MCP_ATLAS = "1";
    try {
      const server = withProfile(undefined, () =>
        createServer({ handlers: {} as any, version: "0.0.0-test" }),
      ) as any;
      for (const name of ATLAS_TOOLS) {
        expect(server._registeredTools[name].outputSchema?.type, name).toBe("object");
      }
      expect(server.server._instructions).toContain("Experimental Atlas");
    } finally {
      if (saved === undefined) delete process.env.AWWWARDS_MCP_ATLAS;
      else process.env.AWWWARDS_MCP_ATLAS = saved;
    }
  });

  it("does not advertise Atlas tools or instructions in the core profile", () => {
    const saved = process.env.AWWWARDS_MCP_ATLAS;
    process.env.AWWWARDS_MCP_ATLAS = "1";
    try {
      const core = withProfile("core", () =>
        createServer({ handlers: {} as any, version: "0.0.0-test" }),
      ) as any;
      expect(Object.keys(core._registeredTools)).toHaveLength(13);
      expect(core.server._instructions).toContain("13 core tools");
      expect(core.server._instructions).not.toContain("Experimental Atlas");
      for (const name of ATLAS_TOOLS) {
        expect(core.server._instructions).not.toContain(name);
      }

      // Full and v2 still advertise the flag-gated surface.
      const full = withProfile(undefined, () =>
        createServer({ handlers: {} as any, version: "0.0.0-test" }),
      ) as any;
      expect(Object.keys(full._registeredTools)).toHaveLength(45);
      expect(full.server._instructions).toContain("Experimental Atlas");

      const v2 = withProfile("v2", () =>
        createServer({ handlers: {} as any, version: "0.0.0-test" }),
      ) as any;
      expect(v2.server._instructions).toContain("Experimental Atlas");
      expect(v2.server._instructions).toContain("16 tools");
    } finally {
      if (saved === undefined) delete process.env.AWWWARDS_MCP_ATLAS;
      else process.env.AWWWARDS_MCP_ATLAS = saved;
    }
  });

  it("states the actual v2 tool count in the server instructions", () => {
    const saved = process.env.AWWWARDS_MCP_ATLAS;
    try {
      delete process.env.AWWWARDS_MCP_ATLAS;
      const off = withProfile("v2", () =>
        createServer({ handlers: {} as any, version: "0.0.0-test" }),
      ) as any;
      expect(off.server._instructions).toContain("15 tools");

      process.env.AWWWARDS_MCP_ATLAS = "1";
      const on = withProfile("v2", () =>
        createServer({ handlers: {} as any, version: "0.0.0-test" }),
      ) as any;
      expect(on.server._instructions).toContain("16 tools");
      expect(on.server._instructions).not.toContain("15 tools");
    } finally {
      if (saved === undefined) delete process.env.AWWWARDS_MCP_ATLAS;
      else process.env.AWWWARDS_MCP_ATLAS = saved;
    }
  });

  it("validates the v2 atlas_status branch through the registered output schema", async () => {
    const saved = process.env.AWWWARDS_MCP_ATLAS;
    process.env.AWWWARDS_MCP_ATLAS = "1";
    try {
      const cache = new Cache(tmpDir(), () => 1_700_000_000_000, { atlas: true });
      const handlers = createHandlers({ client: {} as any, cache });
      const server = withProfile("v2", () =>
        createServer({ handlers, version: "0.0.0-test" }),
      ) as any;
      const result = await runGetIndex(
        handlers,
        getIndexRequestSchema.parse({ kind: "atlas_status" }),
      );
      expect(result.isError).toBeUndefined();
      await expect(
        server.validateToolOutput(server._registeredTools.get_index, result, "get_index atlas_status"),
      ).resolves.toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.AWWWARDS_MCP_ATLAS;
      else process.env.AWWWARDS_MCP_ATLAS = saved;
    }
  });
});
