import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import {
  indexGetOutputSchema,
  indexStatsOutputSchema,
  indexStatusOutputSchema,
} from "../src/index-contracts.js";
import type { IndexStatsResult } from "../src/index-stats.js";
import { createHandlers } from "../src/server.js";
import { createServer } from "../src/server-instance.js";
import { getIndexRequestSchema, runGetIndex } from "../src/v2/get-index.js";

const dirs: string[] = [];
const tmpDir = () => {
  const d = mkdtempSync(join(tmpdir(), "awwwards-contracts-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Captured from the pre-contract implementation: status serializes with two
// spaces, stats with one. These strings are the compatibility fixture.
const EMPTY_STATUS_TEXT = `{
  "sitesCount": 0,
  "progress": {
    "pagesDone": 0,
    "pagesTotal": 0
  },
  "lastSuccessfulFinishAt": null,
  "lastError": null,
  "lock": {
    "startedAt": null,
    "active": false,
    "stale": false
  },
  "indexFreshness": {
    "stale": true,
    "ageMs": null,
    "staleAfterMs": 604800000
  }
}`;

const coverage = { sitesTotal: 3, note: "locally cached subset" as const };
const windowedCoverage = {
  ...coverage,
  detailsCached: 2,
  windowDays: 90,
  detailParseCap: 500,
};

const statsFixture: IndexStatsResult = {
  windowDays: 90,
  top: 10,
  sites: { total: 3, coverage },
  details: { cached: 2, coverage: windowedCoverage },
  elements: { total: 1, coverage },
  technologies: {
    items: [{ tag: "webgl", count: 2 }],
    distinct: 1,
    coverage,
  },
  colors: {
    items: [{ hex: "#FFFFFF", count: 2 }],
    detailsParsed: 30,
    sample: 30,
    insufficient: false,
    coverage: windowedCoverage,
  },
  scores: {
    n: 30,
    avg: 7.5,
    median: 7.5,
    sample: 30,
    insufficient: false,
    coverage: windowedCoverage,
  },
  motionLibs: {
    items: [{ lib: "gsap", count: 3 }],
    rows: 30,
    sample: 30,
    insufficient: false,
    coverage: windowedCoverage,
  },
  note: "Aggregates over the local cache only.",
};

const handlersFor = (cache: Cache, deps: Record<string, unknown> = {}) =>
  createHandlers({ client: {} as any, cache, ...deps });

function withProfile<T>(profile: string | undefined, fn: () => T): T {
  const savedProfile = process.env.AWWWARDS_MCP_PROFILE;
  const savedLegacy = process.env.AWARDS_MCP_PROFILE;
  if (profile === undefined) delete process.env.AWWWARDS_MCP_PROFILE;
  else process.env.AWWWARDS_MCP_PROFILE = profile;
  delete process.env.AWARDS_MCP_PROFILE;
  try {
    return fn();
  } finally {
    if (savedProfile === undefined) delete process.env.AWWWARDS_MCP_PROFILE;
    else process.env.AWWWARDS_MCP_PROFILE = savedProfile;
    if (savedLegacy === undefined) delete process.env.AWARDS_MCP_PROFILE;
    else process.env.AWARDS_MCP_PROFILE = savedLegacy;
  }
}

const serverFor = (profile: string | undefined) =>
  withProfile(profile, () => createServer({ handlers: {} as any, version: "0.0.0-test" }));

// The real tools/list handler: same projection clients receive, including the
// outputSchema conversion.
async function listedTools(profile: string | undefined) {
  const server = serverFor(profile) as any;
  const handler = server.server._requestHandlers.get("tools/list");
  const result = await handler(
    { method: "tools/list", params: {} },
    { mcpReq: { requestState: () => undefined } },
  );
  return result.tools as Array<{ name: string; outputSchema?: Record<string, any> }>;
}

const pilotNames = (tools: Array<{ name: string; outputSchema?: unknown }>) =>
  tools
    .filter((tool) => tool.outputSchema !== undefined)
    .map((tool) => tool.name)
    .sort();

describe("index output contracts", () => {
  it("validates status structuredContent and keeps the text byte-identical", async () => {
    const res = await handlersFor(new Cache(tmpDir())).get_index_status();

    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual([{ type: "text", text: EMPTY_STATUS_TEXT }]);
    expect(res.structuredContent).toEqual(JSON.parse(EMPTY_STATUS_TEXT));
    expect(indexStatusOutputSchema.safeParse(res.structuredContent).success).toBe(true);
  });

  it("validates status with a lock, prior error and populated progress", async () => {
    const cache = new Cache(tmpDir());
    cache.setMeta("index:status", {
      finishedAt: Date.now() - 1000,
      pagesDone: 1,
      pagesTotal: 3,
      lastError: "blocked",
    });
    cache.setMeta("index:progress", ["3d", "webgl"]);
    cache.setMeta("index:lock", { startedAt: Date.now() - 1000 });

    const res = await handlersFor(cache).get_index_status();
    expect(res.isError).toBeUndefined();
    expect(indexStatusOutputSchema.safeParse(res.structuredContent).success).toBe(true);
    expect(res.structuredContent).toMatchObject({
      lastError: "blocked",
      progress: { pagesDone: 2, pagesTotal: 3 },
      lock: { active: true, stale: false },
    });
  });

  it("validates the zero/empty stats result without inventing values", async () => {
    const res = await handlersFor(new Cache(tmpDir())).get_index_stats({});

    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual(JSON.parse((res.content[0] as any).text));
    expect(indexStatsOutputSchema.safeParse(res.structuredContent).success).toBe(true);
    expect(res.structuredContent).toMatchObject({
      sites: { total: 0 },
      colors: { items: [], sample: 0, insufficient: true },
      scores: { n: 0, avg: null, median: null, insufficient: true },
      motionLibs: { items: [], rows: 0, insufficient: true },
    });
  });

  it("validates a populated stats fixture and serializes the same text as before", async () => {
    const res = await handlersFor(new Cache(tmpDir()), {
      indexStatsFn: async () => statsFixture,
    }).get_index_stats({});

    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual([{ type: "text", text: JSON.stringify(statsFixture, null, 1) }]);
    expect(res.structuredContent).toEqual(statsFixture);
    expect(indexStatsOutputSchema.safeParse(res.structuredContent).success).toBe(true);
  });

  it("validates both v2 get_index branches against the merged object contract", async () => {
    const h = handlersFor(new Cache(tmpDir()), {
      indexStatsFn: async () => statsFixture,
    });

    const status = await runGetIndex(h, getIndexRequestSchema.parse({ kind: "status" }));
    expect(status.content).toEqual([{ type: "text", text: EMPTY_STATUS_TEXT }]);
    expect(status.structuredContent).toEqual(JSON.parse(EMPTY_STATUS_TEXT));
    expect(indexGetOutputSchema.safeParse(status.structuredContent).success).toBe(true);

    const stats = await runGetIndex(h, getIndexRequestSchema.parse({ kind: "stats" }));
    expect(stats.content).toEqual([{ type: "text", text: JSON.stringify(statsFixture, null, 1) }]);
    expect(stats.structuredContent).toEqual(statsFixture);
    expect(indexGetOutputSchema.safeParse(stats.structuredContent).success).toBe(true);
    expect(indexGetOutputSchema.safeParse({}).success).toBe(false);
    expect(indexGetOutputSchema.safeParse({ sitesCount: 0 }).success).toBe(false);
    expect(
      indexGetOutputSchema.safeParse({ ...JSON.parse(EMPTY_STATUS_TEXT), windowDays: 30 }).success,
    ).toBe(false);
    expect(indexGetOutputSchema.safeParse({ ...statsFixture, sitesCount: 0 }).success).toBe(false);
    expect(
      indexGetOutputSchema.safeParse({ ...JSON.parse(EMPTY_STATUS_TEXT), ...statsFixture }).success,
    ).toBe(false);
  });

  it("passes the SDK output validator for 1.x and v2 tools", async () => {
    const h = handlersFor(new Cache(tmpDir()), {
      indexStatsFn: async () => statsFixture,
    });

    const full = withProfile(undefined, () =>
      createServer({ handlers: h, version: "0.0.0-test" }),
    ) as any;
    for (const name of ["get_index_status", "get_index_stats"]) {
      const result =
        name === "get_index_status" ? await h.get_index_status() : await h.get_index_stats({});
      await expect(
        full.validateToolOutput(full._registeredTools[name], result, name),
      ).resolves.toBeUndefined();
    }

    const v2 = withProfile("v2", () =>
      createServer({ handlers: h, version: "0.0.0-test" }),
    ) as any;
    for (const request of [{ kind: "status" }, { kind: "stats" }] as const) {
      const result = await runGetIndex(h, getIndexRequestSchema.parse(request));
      await expect(
        v2.validateToolOutput(v2._registeredTools.get_index, result, "get_index"),
      ).resolves.toBeUndefined();
    }
  });

  it("keeps errors as isError with no structured success payload", async () => {
    const cache = new Cache(tmpDir());
    vi.spyOn(cache, "getMeta").mockImplementation(() => {
      throw new Error("status boom");
    });
    const status = await handlersFor(cache).get_index_status();
    expect(status.isError).toBe(true);
    expect(status.structuredContent).toBeUndefined();
    expect((status.content[0] as any).text).toContain("status boom");

    const stats = await handlersFor(new Cache(tmpDir()), {
      indexStatsFn: async () => {
        throw new Error("stats boom");
      },
    }).get_index_stats({});
    expect(stats.isError).toBe(true);
    expect(stats.structuredContent).toBeUndefined();
    expect((stats.content[0] as any).text).toContain("stats boom");
  });

  it("advertises outputSchema only on the pilot tools", async () => {
    const full = await listedTools(undefined);
    expect(full).toHaveLength(39);
    expect(pilotNames(full)).toEqual(["get_index_stats", "get_index_status"]);

    const core = await listedTools("core");
    expect(core).toHaveLength(13);
    expect(pilotNames(core)).toEqual([]);

    const v2 = await listedTools("v2");
    expect(v2).toHaveLength(15);
    expect(pilotNames(v2)).toEqual(["get_index"]);

    // MCP requires an object root; a union root would be wrapped as {result:.}
    // on the 2025 wire and would no longer match the text payload.
    for (const name of ["get_index_status", "get_index_stats"]) {
      expect(full.find((tool) => tool.name === name)?.outputSchema?.type).toBe("object");
    }
    expect(v2.find((tool) => tool.name === "get_index")?.outputSchema?.type).toBe("object");
  });
});
