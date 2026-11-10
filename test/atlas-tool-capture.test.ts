import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import { PACK_NOW, buildPackAttempt, publishPackFixture } from "./helpers/atlas-pack-fixture.js";
import { AtlasCollectionError } from "../src/atlas/collector.js";
import { runAtlasCapture } from "../src/atlas/tool-capture.js";
import { createHandlers } from "../src/server.js";
import type { AtlasPublicationResult } from "../src/atlas/live-types.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-capture-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const detail = (slug: string) => ({
  slug,
  title: slug,
  description: null,
  palette: [],
  technologies: [],
  elements: [],
  awards: [],
  nominee: false,
  score: null,
  ogImage: null,
  liveUrl: `https://${slug}.example/`,
});

function cacheWithSite(slug = "probe"): Cache {
  const cache = new Cache(tmpDir(), () => PACK_NOW, { atlas: true });
  cache.setMeta(`detail:${slug}`, detail(slug));
  return cache;
}

const failedPublish = (pageId: string, code = "NO_CLAIMS"): AtlasPublicationResult => ({
  published: false,
  code,
  captureIds: [],
  pageId,
  regionCount: 0,
  componentCount: 0,
  claimCount: 0,
});

describe("capture_atlas", () => {
  it("publishes a complete capture through the existing publisher", async () => {
    const cache = cacheWithSite();
    const collect = vi.fn(async (_input: unknown, deps: any) =>
      buildPackAttempt(deps.cache, { siteSlug: "probe" }),
    );
    const result = await runAtlasCapture(cache, { slug: "probe" }, { now: () => PACK_NOW, collect });
    expect(result.status).toBe("ok");
    const data = result.data!;
    expect(data.published).toBe(true);
    expect(data.cached).toBe(false);
    expect(data.previousHeadId).toBeNull();
    expect(data.viewport).toBe("desktop");
    expect(data.captureId).toMatch(/^[a-f0-9]{64}$/);
    expect(data.attemptId).toContain("pack-attempt-probe");
    expect(data.sections.length).toBeGreaterThan(0);
    expect(data.components.length).toBeGreaterThan(0);
    expect(data.artifacts.length).toBeGreaterThan(0);
    expect(data.artifacts.every((artifact) => artifact.available)).toBe(true);
    expect(data.capabilityCoverage.sections.status).toBe("complete");
    expect(data.capabilityCoverage.states.limitations).toEqual(["STATE_NOT_REQUESTED"]);
    expect(data.omitted).toEqual({
      sections: 0,
      components: 0,
      screenshots: 0,
      componentPacks: 0,
    });
    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({ siteSlug: "probe", viewports: ["desktop"], components: true }),
      expect.objectContaining({ cache }),
    );
  });

  it("forwards the abort signal into the collector deps", async () => {
    const cache = cacheWithSite();
    const controller = new AbortController();
    const collect = vi.fn(async (_input: unknown, deps: any) =>
      buildPackAttempt(deps.cache, { siteSlug: "probe" }),
    );
    await runAtlasCapture(cache, { slug: "probe" }, {
      now: () => PACK_NOW,
      signal: controller.signal,
      collect,
    });
    expect(collect).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("passes the abort signal through the handler into the capture seam", async () => {
    const atlasCaptureFn = vi.fn(async () => ({
      schemaVersion: "awwwards-atlas-v1" as const,
      operation: "capture_atlas",
      status: "blocked" as const,
      data: null,
      coverage: { status: "unknown" as const, collected: 0, excluded: 0, limitations: [] },
      warnings: [],
      error: { code: "ABORTED", message: "aborted", retryable: false },
    }));
    const handlers = createHandlers({
      client: {} as any,
      cache: cacheWithSite(),
      atlasCaptureFn,
    });
    const controller = new AbortController();
    await handlers.capture_atlas({ slug: "probe" }, controller.signal);
    expect(atlasCaptureFn).toHaveBeenCalledWith(
      expect.anything(),
      { slug: "probe" },
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("reuses a matching usable head for 7 days unless refresh is true", async () => {
    const cache = cacheWithSite();
    const first = await runAtlasCapture(cache, { slug: "probe" }, {
      now: () => PACK_NOW,
      collect: async (_input: unknown, deps: any) => buildPackAttempt(deps.cache, { siteSlug: "probe" }),
    });
    expect(first.data?.published).toBe(true);

    const collect = vi.fn(async () => {
      throw new Error("collector must not run for a cached head");
    });
    const reused = await runAtlasCapture(cache, { slug: "probe" }, {
      now: () => PACK_NOW + 86_400_000,
      collect,
    });
    expect(collect).not.toHaveBeenCalled();
    expect(reused.status).toBe("ok");
    expect(reused.data?.cached).toBe(true);
    expect(reused.data?.published).toBe(false);
    expect(reused.data?.captureId).toBe(first.data?.captureId);
    expect(reused.data?.sections.length).toBe(first.data?.sections.length);
    expect(reused.coverage).toEqual({
      status: "complete",
      collected: first.coverage.collected,
      excluded: 0,
      limitations: [],
    });

    const refreshed = await runAtlasCapture(cache, { slug: "probe", refresh: true }, {
      now: () => PACK_NOW + 2 * 86_400_000,
      collect: async (_input: unknown, deps: any) => buildPackAttempt(deps.cache, { siteSlug: "probe" }),
    });
    expect(refreshed.data?.cached).toBe(false);
    expect(refreshed.data?.published).toBe(true);
    expect(refreshed.data?.previousHeadId).toBe(first.data?.captureId);
  });

  it("keeps a reused partial capture partial and preserves its limitations", async () => {
    const cache = cacheWithSite();
    await publishPackFixture(cache, {
      siteSlug: "probe",
      status: "partial",
      coverageLimitations: ["SECTION_TRUNCATION"],
    });
    const collect = vi.fn(async () => {
      throw new Error("collector must not run for a cached head");
    });
    const reused = await runAtlasCapture(cache, { slug: "probe" }, {
      now: () => PACK_NOW + 1000,
      collect,
    });
    expect(collect).not.toHaveBeenCalled();
    expect(reused.data?.cached).toBe(true);
    expect(reused.status).toBe("partial");
    expect(reused.coverage.status).toBe("partial");
    expect(reused.coverage.limitations).toEqual(["SECTION_TRUNCATION"]);
    expect(reused.warnings).toContain("SECTION_TRUNCATION");
    expect(reused.data?.capabilityCoverage.sections.status).toBe("partial");
  });

  it("does not reuse a head older than 7 days or with different states", async () => {
    const cache = cacheWithSite();
    await publishPackFixture(cache, { siteSlug: "probe" });
    const collect = vi.fn(async (_input: unknown, deps: any) =>
      buildPackAttempt(deps.cache, { siteSlug: "probe" }),
    );
    const stale = await runAtlasCapture(cache, { slug: "probe" }, {
      now: () => PACK_NOW + 8 * 86_400_000,
      collect,
    });
    expect(collect).toHaveBeenCalledTimes(1);
    expect(stale.data?.cached).toBe(false);

    collect.mockClear();
    const states = [{ action: "hover" as const, targetRegionId: "a".repeat(64) }];
    const different = await runAtlasCapture(cache, { slug: "probe", states }, {
      now: () => PACK_NOW + 1000,
      collect,
    });
    expect(collect).toHaveBeenCalledTimes(1);
    expect(different.data?.cached).toBe(false);
  });

  it("returns partial evidence when publication refuses it, and says published=false", async () => {
    const cache = cacheWithSite();
    const result = await runAtlasCapture(cache, { slug: "probe" }, {
      now: () => PACK_NOW,
      collect: async (_input: unknown, deps: any) =>
        buildPackAttempt(deps.cache, { siteSlug: "probe" }),
      publish: async (attempt) => failedPublish(attempt.target.urlKey, "NO_CLAIMS"),
    });
    expect(result.status).toBe("partial");
    expect(result.error).toBeNull();
    const data = result.data!;
    expect(data.published).toBe(false);
    expect(data.cached).toBe(false);
    expect(data.captureId).toBe("");
    expect(data.pageId).toMatch(/^[a-f0-9]{64}$/);
    expect(data.sections.length).toBeGreaterThan(0);
    expect(result.warnings).toContain("NO_CLAIMS");
  });

  it("reports stored coverage totals for fresh and cached captures beyond the summary cap", async () => {
    const cache = cacheWithSite();
    const attempt = await buildPackAttempt(cache, {
      siteSlug: "probe",
      sectionCount: 21,
      componentCount: 82,
    });
    // Stored coverage is the capture total, not the capped response arrays.
    attempt.viewports[0]!.coverage = {
      status: "complete",
      collected: 106,
      excluded: 0,
      limitations: [],
    };
    const fresh = await runAtlasCapture(cache, { slug: "probe" }, {
      now: () => PACK_NOW,
      collect: async () => attempt,
    });
    expect(fresh.status).toBe("ok");
    expect(fresh.data?.cached).toBe(false);

    const collect = vi.fn(async () => {
      throw new Error("collector must not run for a cached head");
    });
    const cached = await runAtlasCapture(cache, { slug: "probe" }, {
      now: () => PACK_NOW + 1000,
      collect,
    });
    expect(collect).not.toHaveBeenCalled();
    expect(cached.data?.cached).toBe(true);

    for (const result of [fresh, cached]) {
      expect(result.data?.sections).toHaveLength(21);
      expect(result.data?.components).toHaveLength(64);
      expect(result.coverage).toEqual({
        status: "complete",
        collected: 106,
        excluded: 0,
        limitations: [],
      });
      expect(result.data?.capabilityCoverage.sections.collected).toBe(21);
      expect(result.data?.capabilityCoverage.components.collected).toBe(82);
      expect(result.data?.omitted).toMatchObject({ sections: 0, components: 18 });
    }
    const returned = (kind: string) =>
      cached.data!.artifacts.filter((artifact) => artifact.kind === kind).length;
    expect(cached.data!.omitted.screenshots + returned("screenshot")).toBe(1);
    expect(cached.data!.omitted.componentPacks + returned("component_pack")).toBe(82);
  });

  it("keeps a components-on reuse of a components-off head partial instead of ok", async () => {
    const cache = cacheWithSite();
    const published = await publishPackFixture(cache, { siteSlug: "probe", components: false });
    expect(published.componentIds).toEqual([]);
    const collect = vi.fn(async () => {
      throw new Error("collector must not run for a cached head");
    });
    const reused = await runAtlasCapture(cache, { slug: "probe" }, {
      now: () => PACK_NOW + 1000,
      collect,
    });
    expect(collect).not.toHaveBeenCalled();
    expect(reused.data?.cached).toBe(true);
    expect(reused.status).toBe("partial");
    expect(reused.data?.components).toEqual([]);
    expect(reused.data?.capabilityCoverage.components.status).toBe("unknown");
    expect(reused.data?.capabilityCoverage.components.limitations).toContain(
      "COMPONENTS_NOT_COLLECTED",
    );
    expect(reused.coverage.limitations).toContain("COMPONENTS_NOT_COLLECTED");
    expect(reused.warnings).toContain("COMPONENTS_NOT_COLLECTED");
  });

  it("omits component summaries when components are not requested", async () => {
    const cache = cacheWithSite();
    const collect = vi.fn(async (_input: unknown, deps: any) =>
      buildPackAttempt(deps.cache, { siteSlug: "probe" }),
    );
    const result = await runAtlasCapture(cache, { slug: "probe", components: false }, {
      now: () => PACK_NOW,
      collect,
      publish: async (attempt) => failedPublish(attempt.target.urlKey),
    });
    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({ components: false }),
      expect.anything(),
    );
    expect(result.data?.components).toEqual([]);
    expect(result.data?.omitted.components).toBeGreaterThan(0);
    expect(result.data?.capabilityCoverage.components.status).toBe("unknown");
  });

  it("counts screenshots and component packs beyond the descriptor cap", async () => {
    const cache = cacheWithSite();
    const attempt = await buildPackAttempt(cache, {
      siteSlug: "probe",
      screenshotCount: 41,
      componentPackCount: 42,
    });
    const fresh = await runAtlasCapture(cache, { slug: "probe" }, {
      now: () => PACK_NOW,
      collect: async () => attempt,
      publish: async (captureAttempt) => failedPublish(captureAttempt.target.urlKey),
    });
    expect(fresh.data?.artifacts.length).toBe(32);
    expect(fresh.data?.capabilityCoverage.screenshots.collected).toBe(41);
    expect(fresh.data?.omitted).toMatchObject({ screenshots: 10, componentPacks: 42 });

    const published = await runAtlasCapture(cache, { slug: "probe", refresh: true }, {
      now: () => PACK_NOW + 500,
      collect: async () => attempt,
    });
    expect(published.data?.published).toBe(true);

    const collect = vi.fn(async () => {
      throw new Error("collector must not run for a cached head");
    });
    const cached = await runAtlasCapture(cache, { slug: "probe" }, {
      now: () => PACK_NOW + 1000,
      collect,
    });
    expect(collect).not.toHaveBeenCalled();
    expect(cached.data?.cached).toBe(true);
    expect(cached.data?.artifacts.length).toBe(32);
    expect(cached.data?.capabilityCoverage.screenshots.collected).toBe(41);
    const returned = (kind: string) =>
      cached.data!.artifacts.filter((artifact) => artifact.kind === kind).length;
    expect(cached.data!.omitted.screenshots + returned("screenshot")).toBe(41);
    expect(cached.data!.omitted.componentPacks + returned("component_pack")).toBe(42);
    expect(cached.data!.omitted.screenshots).toBeGreaterThan(0);
    expect(cached.data!.omitted.componentPacks).toBeGreaterThan(0);
  });

  it("maps policy refusal to blocked, busy to retryable, and unknown sites to an error", async () => {
    const cache = cacheWithSite();
    const blocked = await runAtlasCapture(cache, { slug: "probe" }, {
      now: () => PACK_NOW,
      collect: async () => {
        throw new AtlasCollectionError("ROBOTS_DISALLOWED", "robots refused the capture");
      },
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.error?.code).toBe("ROBOTS_DISALLOWED");

    const busy = await runAtlasCapture(cache, { slug: "probe" }, {
      now: () => PACK_NOW,
      collect: async () => {
        throw new AtlasCollectionError("CAPTURE_BUSY", "busy");
      },
    });
    expect(busy.status).toBe("error");
    expect(busy.error).toMatchObject({ code: "CAPTURE_BUSY", retryable: true });

    const collect = vi.fn();
    const missing = await runAtlasCapture(cache, { slug: "missing" }, {
      now: () => PACK_NOW,
      collect: collect as any,
    });
    expect(missing.error?.code).toBe("REFERENCE_UNAVAILABLE");
    expect(collect).not.toHaveBeenCalled();
  });

  it("reports TARGET_CHANGED as inconclusive on the collector and publication paths", async () => {
    const cache = cacheWithSite();
    const collected = await runAtlasCapture(cache, { slug: "probe" }, {
      now: () => PACK_NOW,
      collect: async () => {
        throw new AtlasCollectionError("TARGET_CHANGED", "the page target changed");
      },
    });
    expect(collected.status).toBe("inconclusive");
    expect(collected.data).toBeNull();
    expect(collected.error).toMatchObject({ code: "TARGET_CHANGED", retryable: true });

    const refused = await runAtlasCapture(cache, { slug: "probe" }, {
      now: () => PACK_NOW,
      collect: async (_input: unknown, deps: any) =>
        buildPackAttempt(deps.cache, { siteSlug: "probe" }),
      publish: async (attempt) => failedPublish(attempt.target.urlKey, "TARGET_CHANGED"),
    });
    expect(refused.status).toBe("inconclusive");
    expect(refused.data).toBeNull();
    expect(refused.error).toMatchObject({ code: "TARGET_CHANGED", retryable: true });
  });

  it("returns the envelope through the handler without a success payload on blocked captures", async () => {
    const cache = cacheWithSite();
    const handlers = createHandlers({
      client: {} as any,
      cache,
      atlasCaptureFn: async () => ({
        schemaVersion: "awwwards-atlas-v1",
        operation: "capture_atlas",
        status: "blocked",
        data: null,
        coverage: { status: "unknown", collected: 0, excluded: 0, limitations: [] },
        warnings: [],
        error: { code: "ROBOTS_DISALLOWED", message: "refused", retryable: false },
      }),
    });
    const blocked = await handlers.capture_atlas({ slug: "probe" });
    expect(blocked.isError).toBe(true);
    expect(blocked.structuredContent).toBeUndefined();
    expect(JSON.parse(blocked.content[0]!.text).error.code).toBe("ROBOTS_DISALLOWED");
  });
});
