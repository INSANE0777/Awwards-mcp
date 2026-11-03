import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AwwwardsClient } from "../src/awwwards.js";
import { Cache } from "../src/cache.js";
import type { SceneEvidence } from "../src/scene-capture.js";
import type { SceneAssetsResult } from "../src/scene-assets.js";
import { createHandlers, type ToolResponse } from "../src/server.js";
import { registerCaptureScene3d } from "../src/tools/scene.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-scene-tool-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ok = (): ToolResponse => ({ content: [{ type: "text", text: "ok" }] });

function fakeCtx(handlers: object) {
  return { handlers, tool: vi.fn(), registerTool: vi.fn() } as any;
}

const url = "https://example.com/scene";
const captureId = "scene-mg2k3j4p-0123abcd";
const rights = { basis: "licensed" as const, evidence: "CC BY 4.0 licence" };

function evidence(): SceneEvidence {
  return {
    id: "scene-evidence-v1",
    url: "https://example.com/scene",
    captureId: "scene-test",
    capturedAt: 1,
    viewport: { name: "desktop", width: 1440, height: 900 },
    canvas: { requestedSelector: null, usedSelector: "canvas", canvases: 1 },
    frameworkHints: {
      three: { detected: false, version: null, scripts: [] },
      babylon: { detected: false, version: null, scripts: [] },
      playcanvas: { detected: false, version: null, scripts: [] },
      canvasCount: 1,
    },
    checkpoints: [],
    resources: [],
    resourceTotal: 0,
    resourcesTruncated: false,
    blockedRequests: { count: 0, samples: [] },
    assetOrigins: [],
    paths: { dir: "/tmp/scene-test", evidence: "/tmp/scene-test/evidence.json", framesDir: "/tmp/scene-test" },
    coverage: {
      status: "partial",
      collected: 0,
      excluded: 0,
      limitations: ["passive"],
      capabilities: {
        scene: { status: "unavailable", reason: "not read" },
        camera: { status: "unavailable", reason: "not read" },
        controls: { status: "unavailable", reason: "not read" },
        shaders: { status: "unavailable", reason: "not read" },
        geometry: { status: "unavailable", reason: "not read" },
      },
    },
    limitations: ["passive"],
  };
}

function assets(): SceneAssetsResult {
  return {
    id: "scene-assets-v1",
    captureId,
    downloaded: 1,
    skipped: 0,
    receivedBytes: 3,
    totalBytes: 3,
    rights: { ...rights, recordedAt: 1 },
    files: [{ assetId: "asset-1", path: "/tmp/a.png", sha256: "a".repeat(64), bytes: 3, mime: "image/png" }],
    limitations: ["only observed assets"],
  };
}

describe("registerCaptureScene3d", () => {
  it("registers the two-op scene tool as non-read-only but non-destructive", async () => {
    const ctx = fakeCtx({
      capture_scene_3d: vi.fn().mockResolvedValue(ok()),
      download_scene_assets: vi.fn().mockResolvedValue(ok()),
    });

    registerCaptureScene3d(ctx);

    expect(ctx.tool).toHaveBeenCalledTimes(1);
    const [name, description, shape, annotations, callback] = ctx.tool.mock.calls[0];
    expect(name).toBe("capture_scene_3d");
    expect(description).toMatch(/passive/i);
    expect(description).toMatch(/no scene graph, camera, controls, shader source or geometry/i);
    expect(description).toMatch(/licensing decision/i);
    expect(description).toMatch(/rights\.basis/);
    expect(description).toMatch(/16 MiB per file, 64 MiB per run/);
    expect(description).toMatch(/1 request\/second/);
    expect(annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });

    const schema = z.object(shape);
    expect(Object.keys(shape)).toEqual(["request"]);
    expect(schema.parse({ request: { op: "capture", url } })).toEqual({
      request: { op: "capture", url, viewport: "desktop", includeViewportShots: true },
    });
    expect(
      schema.parse({
        request: { op: "download_assets", captureId, assetIds: ["asset-1"], rights },
      }),
    ).toEqual({
      request: { op: "download_assets", captureId, assetIds: ["asset-1"], rights, allowUnknown: false },
    });
    expect(Object.keys(shape)).not.toContain("allowPrivateOrigins");

    await callback(schema.parse({ request: { op: "capture", url } }));
    expect(ctx.handlers.capture_scene_3d).toHaveBeenCalledWith({
      url,
      canvasSelector: undefined,
      scrollRoot: undefined,
      viewport: "desktop",
      checkpoints: undefined,
      assetOrigins: undefined,
      includeViewportShots: true,
    });

    await callback(
      schema.parse({ request: { op: "download_assets", captureId, assetIds: ["asset-2"], rights } }),
    );
    expect(ctx.handlers.download_scene_assets).toHaveBeenCalledWith({
      captureId,
      assetIds: ["asset-2"],
      rights,
      allowUnknown: false,
    });
  });

  it("rejects bad capture fields, bad rights, bad ids and unknown ops", () => {
    const ctx = fakeCtx({});
    registerCaptureScene3d(ctx);
    const schema = z.object(ctx.tool.mock.calls[0][2]);

    expect(schema.safeParse({ request: { op: "capture", url: "ftp://example.com/x" } }).success).toBe(false);
    expect(schema.safeParse({ request: { op: "capture", url: "file:///tmp/x.html" } }).success).toBe(false);
    expect(
      schema.safeParse({
        request: {
          op: "capture",
          url,
          checkpoints: Array.from({ length: 11 }, () => ({ scrollRatio: 0.5 })),
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ request: { op: "capture", url, assetOrigins: Array.from({ length: 9 }, (_, i) => `https://c${i}.test`) } })
        .success,
    ).toBe(false);
    // Opt-in adapters: at most two entries, known names, no duplicates.
    expect(schema.safeParse({ request: { op: "capture", url, adapters: ["three"] } }).success).toBe(true);
    expect(schema.safeParse({ request: { op: "capture", url, adapters: ["spector"] } }).success).toBe(true);
    expect(
      schema.safeParse({ request: { op: "capture", url, adapters: ["three", "spector"] } }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ request: { op: "capture", url, adapters: ["spector", "three"] } }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ request: { op: "capture", url, adapters: ["three", "three"] } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ request: { op: "capture", url, adapters: ["spector", "spector"] } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ request: { op: "capture", url, adapters: ["three", "spector", "spector"] } })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ request: { op: "capture", url, adapters: ["babylon"] } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        request: { op: "download_assets", captureId, assetIds: ["asset-1"], rights, adapters: ["three"] },
      }).success,
    ).toBe(false);

    const download = (extra: Record<string, unknown> = {}) => ({
      request: {
        op: "download_assets",
        captureId,
        assetIds: ["asset-1"],
        rights,
        ...extra,
      },
    });
    expect(schema.safeParse(download({ rights: undefined })).success).toBe(false);
    expect(schema.safeParse(download({ rights: { basis: "borrowed", evidence: "x" } })).success).toBe(false);
    expect(schema.safeParse(download({ rights: { basis: "owned", evidence: "" } })).success).toBe(false);
    expect(
      schema.safeParse(download({ assetIds: Array.from({ length: 33 }, (_, i) => `asset-${i + 1}`) })).success,
    ).toBe(false);
    expect(schema.safeParse(download({ captureId: "../../etc" })).success).toBe(false);
    expect(schema.safeParse(download({ assetIds: ["../../etc/passwd"] })).success).toBe(false);
    expect(
      schema.safeParse({ request: { op: "capture", url, assetIds: ["asset-1"] } }).success,
    ).toBe(false);
    expect(schema.safeParse({ request: { op: "delete", url } }).success).toBe(false);
  });
});

describe("capture_scene_3d handler", () => {
  it("forwards the injected capture fn with the cache scene dir and returns a compact summary", async () => {
    const dir = tmpDir();
    const cache = new Cache(dir);
    const seen: Array<{ url: string; opts: any }> = [];
    const captureSceneFn = async (target: string, opts?: any) => {
      seen.push({ url: target, opts });
      return evidence();
    };
    const handlers = createHandlers({
      client: new AwwwardsClient(),
      cache,
      captureSceneFn,
    });

    const result = await handlers.capture_scene_3d({
      url,
      viewport: "mobile",
      includeViewportShots: false,
      checkpoints: [{ scrollRatio: 0.5, pointer: { x: 0.5, y: 0.5 }, waitMs: 100 }],
    });

    expect(result.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(url);
    expect(seen[0].opts).toMatchObject({
      viewport: "mobile",
      includeViewportShots: false,
      checkpoints: [{ scrollRatio: 0.5, pointer: { x: 0.5, y: 0.5 }, waitMs: 100 }],
      sceneDir: join(dir, "scene-captures"),
    });

    expect(seen[0].opts).not.toHaveProperty("adapters");
    await handlers.capture_scene_3d({ url, adapters: ["three"] });
    expect(seen[1].opts).toMatchObject({ adapters: ["three"] });

    // Text-only: no inline image block ever reaches the MCP response.
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.id).toBe("scene-evidence-v1");
    expect(parsed.captureId).toBe("scene-test");
    expect(parsed.resources.collected).toBe(0);
    expect(parsed.coverage.capabilities.shaders.status).toBe("unavailable");
    expect(parsed.paths.evidence).toBe("/tmp/scene-test/evidence.json");
  });

  it("turns a capture error into an isError response", async () => {
    const cache = new Cache(tmpDir());
    const handlers = createHandlers({
      client: new AwwwardsClient(),
      cache,
      captureSceneFn: async () => ({ error: "Scene capture failed: no canvas" }),
    });

    const result = await handlers.capture_scene_3d({ url });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("no canvas");
  });
});

describe("download_scene_assets handler", () => {
  it("forwards the cache scene dir and returns the compact asset summary", async () => {
    const dir = tmpDir();
    const cache = new Cache(dir);
    const seen: any[] = [];
    const handlers = createHandlers({
      client: new AwwwardsClient(),
      cache,
      downloadSceneAssetsFn: async (opts) => {
        seen.push(opts);
        return assets();
      },
    });

    const result = await handlers.download_scene_assets({
      captureId,
      assetIds: ["asset-1"],
      rights,
      allowUnknown: true,
    });

    expect(result.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      captureId,
      assetIds: ["asset-1"],
      rights,
      allowUnknown: true,
      sceneDir: join(dir, "scene-captures"),
    });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.id).toBe("scene-assets-v1");
    expect(parsed.downloaded).toBe(1);
    expect(parsed.rights.recordedAt).toBe(1);
    expect(JSON.stringify(parsed)).not.toContain("base64");
  });

  it("turns a download error into an isError response", async () => {
    const cache = new Cache(tmpDir());
    const handlers = createHandlers({
      client: new AwwwardsClient(),
      cache,
      downloadSceneAssetsFn: async () => ({ error: "assetIds not in this capture's inventory: asset-9" }),
    });

    const result = await handlers.download_scene_assets({
      captureId,
      assetIds: ["asset-9"],
      rights,
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("not in this capture's inventory");
  });
});
