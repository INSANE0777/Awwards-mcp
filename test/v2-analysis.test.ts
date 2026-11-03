import { describe, expect, it, vi } from "vitest";
import type { ToolResponse } from "../src/server.js";
import {
  analyzeMotionInputSchema,
  analyzeMotionRequestSchema,
  registerAnalyzeMotion,
  runAnalyzeMotion,
} from "../src/v2/analyze-motion.js";
import {
  auditPageInputSchema,
  auditPageRequestSchema,
  registerAuditPage,
  runAuditPage,
} from "../src/v2/audit-page.js";
import {
  capturePageInputSchema,
  capturePageRequestSchema,
  registerCapturePage,
  runCapturePage,
} from "../src/v2/capture-page.js";
import {
  inspectPageInputSchema,
  inspectPageRequestSchema,
  registerInspectPage,
  runInspectPage,
} from "../src/v2/inspect-page.js";
import {
  monitorAwardsInputSchema,
  monitorAwardsRequestSchema,
  registerMonitorAwards,
  runMonitorAwards,
} from "../src/v2/monitor-awards.js";

const okResponse: ToolResponse = { content: [{ type: "text", text: "ok" }] };

function inspectHandlers() {
  return {
    analyze_page_structure: vi.fn().mockResolvedValue(okResponse),
    export_design_tokens: vi.fn().mockResolvedValue(okResponse),
    analyze_stack: vi.fn().mockResolvedValue(okResponse),
  };
}

function motionHandlers() {
  return {
    get_motion_dna: vi.fn().mockResolvedValue(okResponse),
    analyze_scroll_map: vi.fn().mockResolvedValue(okResponse),
    analyze_hover_census: vi.fn().mockResolvedValue(okResponse),
  };
}

function captureHandlers() {
  return {
    capture_live_site: vi.fn().mockResolvedValue(okResponse),
    capture_component: vi.fn().mockResolvedValue(okResponse),
    capture_pose_3d: vi.fn().mockResolvedValue(okResponse),
    capture_scene_3d: vi.fn().mockResolvedValue(okResponse),
    download_scene_assets: vi.fn().mockResolvedValue(okResponse),
    record_site_motion: vi.fn().mockResolvedValue(okResponse),
  };
}

function auditHandlers() {
  return {
    audit_url: vi.fn().mockResolvedValue(okResponse),
    analyze_accessibility: vi.fn().mockResolvedValue(okResponse),
    analyze_images: vi.fn().mockResolvedValue(okResponse),
    analyze_bundle: vi.fn().mockResolvedValue(okResponse),
  };
}

function monitorHandlers() {
  return {
    new_winners: vi.fn().mockResolvedValue(okResponse),
    watch_site: vi.fn().mockResolvedValue(okResponse),
  };
}

function fakeCtx(handlers: object) {
  return { handlers, tool: vi.fn(), registerTool: vi.fn() } as any;
}

const url = "https://example.com";
const page = "https://example.com/page";

describe("inspectPageRequestSchema", () => {
  it("parses each valid branch", () => {
    expect(inspectPageRequestSchema.parse({ kind: "structure", url })).toEqual({
      kind: "structure",
      url,
      maxBands: 40,
      waitStrategy: "load",
      viewport: "desktop",
    });

    expect(
      inspectPageRequestSchema.parse({
        kind: "structure",
        url: "file:///tmp/build/index.html",
        maxBands: 12,
        waitStrategy: "networkidle",
        viewport: "mobile",
        compare: "mobile",
        cdpEndpoint: "http://127.0.0.1:9222",
      }),
    ).toEqual({
      kind: "structure",
      url: "file:///tmp/build/index.html",
      maxBands: 12,
      waitStrategy: "networkidle",
      viewport: "mobile",
      compare: "mobile",
      cdpEndpoint: "http://127.0.0.1:9222",
    });

    expect(
      inspectPageRequestSchema.parse({
        kind: "tokens",
        url,
        selector: "#app",
        viewport: "mobile",
        maxNodes: 1200,
        include: ["colors", "typography"],
      }),
    ).toEqual({
      kind: "tokens",
      url,
      selector: "#app",
      viewport: "mobile",
      maxNodes: 1200,
      include: ["colors", "typography"],
    });

    expect(
      inspectPageRequestSchema.parse({ kind: "stack", url, timeoutMs: 5000 }),
    ).toEqual({ kind: "stack", url, timeoutMs: 5000 });
  });

  it("rejects a valid-looking payload with a foreign branch field", () => {
    const parsed = inspectPageRequestSchema.safeParse({
      kind: "structure",
      url,
      include: ["colors"],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("rejects an array form, an all form and an extra top-level key", () => {
    expect(
      inspectPageInputSchema.safeParse({
        request: [
          { kind: "structure", url },
          { kind: "stack", url },
        ],
      }).success,
    ).toBe(false);
    expect(inspectPageInputSchema.safeParse({ request: { kind: "all", url } }).success).toBe(false);
    expect(
      inspectPageInputSchema.safeParse({ request: { kind: "stack", url }, extra: true }).success,
    ).toBe(false);
  });
});

describe("runInspectPage", () => {
  it("dispatches structure with defaults and omits undefined optionals", async () => {
    const handlers = inspectHandlers();
    const request = inspectPageRequestSchema.parse({ kind: "structure", url });

    const result = await runInspectPage(handlers as any, request);

    expect(handlers.analyze_page_structure).toHaveBeenCalledTimes(1);
    expect(handlers.analyze_page_structure).toHaveBeenCalledWith({
      url,
      maxBands: 40,
      waitStrategy: "load",
      viewport: "desktop",
    });
    expect(handlers.export_design_tokens).not.toHaveBeenCalled();
    expect(handlers.analyze_stack).not.toHaveBeenCalled();
    expect(result).toBe(okResponse);
  });

  it("dispatches tokens with defaults and omits undefined optionals", async () => {
    const handlers = inspectHandlers();
    const request = inspectPageRequestSchema.parse({ kind: "tokens", url });

    const result = await runInspectPage(handlers as any, request);

    expect(handlers.export_design_tokens).toHaveBeenCalledTimes(1);
    expect(handlers.export_design_tokens).toHaveBeenCalledWith({ url, viewport: "desktop" });
    expect(handlers.analyze_page_structure).not.toHaveBeenCalled();
    expect(handlers.analyze_stack).not.toHaveBeenCalled();
    expect(result).toBe(okResponse);
  });

  it("dispatches stack and omits undefined timeoutMs", async () => {
    const handlers = inspectHandlers();
    const request = inspectPageRequestSchema.parse({ kind: "stack", url });

    const result = await runInspectPage(handlers as any, request);

    expect(handlers.analyze_stack).toHaveBeenCalledTimes(1);
    expect(handlers.analyze_stack).toHaveBeenCalledWith({ url });
    expect(handlers.analyze_page_structure).not.toHaveBeenCalled();
    expect(handlers.export_design_tokens).not.toHaveBeenCalled();
    expect(result).toBe(okResponse);
  });

  it("forwards optional branch fields", async () => {
    const handlers = inspectHandlers();

    await runInspectPage(
      handlers as any,
      inspectPageRequestSchema.parse({
        kind: "structure",
        url,
        maxBands: 12,
        compare: "mobile",
        cdpEndpoint: "http://127.0.0.1:9222",
      }),
    );
    await runInspectPage(
      handlers as any,
      inspectPageRequestSchema.parse({
        kind: "tokens",
        url,
        selector: "#app",
        maxNodes: 1200,
        include: ["colors"],
      }),
    );
    await runInspectPage(
      handlers as any,
      inspectPageRequestSchema.parse({ kind: "stack", url, timeoutMs: 5000 }),
    );

    expect(handlers.analyze_page_structure).toHaveBeenCalledWith({
      url,
      maxBands: 12,
      waitStrategy: "load",
      viewport: "desktop",
      compare: "mobile",
      cdpEndpoint: "http://127.0.0.1:9222",
    });
    expect(handlers.export_design_tokens).toHaveBeenCalledWith({
      url,
      selector: "#app",
      viewport: "desktop",
      maxNodes: 1200,
      include: ["colors"],
    });
    expect(handlers.analyze_stack).toHaveBeenCalledWith({ url, timeoutMs: 5000 });
  });
});

describe("analyzeMotionRequestSchema", () => {
  it("parses each valid branch", () => {
    expect(analyzeMotionRequestSchema.parse({ kind: "dna", url })).toEqual({
      kind: "dna",
      url,
      recapture: false,
    });

    expect(
      analyzeMotionRequestSchema.parse({ kind: "dna", url, recapture: true }),
    ).toEqual({ kind: "dna", url, recapture: true });

    expect(
      analyzeMotionRequestSchema.parse({
        kind: "scroll",
        url: page,
        waitStrategy: "load",
        viewport: "mobile",
        reducedMotion: true,
        scrubProbe: true,
        compact: true,
      }),
    ).toEqual({
      kind: "scroll",
      url: page,
      waitStrategy: "load",
      viewport: "mobile",
      reducedMotion: true,
      scrubProbe: true,
      compact: true,
    });

    expect(
      analyzeMotionRequestSchema.parse({
        kind: "hover",
        url: page,
        waitStrategy: "networkidle",
        compact: false,
      }),
    ).toEqual({
      kind: "hover",
      url: page,
      waitStrategy: "networkidle",
      viewport: "desktop",
      reducedMotion: false,
      compact: false,
    });
  });

  it("rejects a valid-looking payload with a foreign branch field", () => {
    const parsed = analyzeMotionRequestSchema.safeParse({
      kind: "dna",
      url,
      compact: true,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("rejects an array form, an all form and an extra top-level key", () => {
    expect(
      analyzeMotionInputSchema.safeParse({
        request: [
          { kind: "dna", url },
          { kind: "hover", url },
        ],
      }).success,
    ).toBe(false);
    expect(analyzeMotionInputSchema.safeParse({ request: { kind: "all", url } }).success).toBe(false);
    expect(
      analyzeMotionInputSchema.safeParse({ request: { kind: "dna", url }, extra: true }).success,
    ).toBe(false);
  });
});

describe("runAnalyzeMotion", () => {
  it("dispatches dna with the recapture default", async () => {
    const handlers = motionHandlers();
    const request = analyzeMotionRequestSchema.parse({ kind: "dna", url });

    const result = await runAnalyzeMotion(handlers as any, request);

    expect(handlers.get_motion_dna).toHaveBeenCalledTimes(1);
    expect(handlers.get_motion_dna).toHaveBeenCalledWith({ url, recapture: false });
    expect(handlers.analyze_scroll_map).not.toHaveBeenCalled();
    expect(handlers.analyze_hover_census).not.toHaveBeenCalled();
    expect(result).toBe(okResponse);
  });

  it("dispatches scroll without a waitStrategy default and omits undefined optionals", async () => {
    const handlers = motionHandlers();
    const request = analyzeMotionRequestSchema.parse({ kind: "scroll", url: page });

    const result = await runAnalyzeMotion(handlers as any, request);

    expect(handlers.analyze_scroll_map).toHaveBeenCalledTimes(1);
    expect(handlers.analyze_scroll_map).toHaveBeenCalledWith({
      url: page,
      viewport: "desktop",
      reducedMotion: false,
    });
    expect(handlers.get_motion_dna).not.toHaveBeenCalled();
    expect(handlers.analyze_hover_census).not.toHaveBeenCalled();
    expect(result).toBe(okResponse);
  });

  it("dispatches hover without a waitStrategy default and omits undefined optionals", async () => {
    const handlers = motionHandlers();
    const request = analyzeMotionRequestSchema.parse({ kind: "hover", url: page });

    const result = await runAnalyzeMotion(handlers as any, request);

    expect(handlers.analyze_hover_census).toHaveBeenCalledTimes(1);
    expect(handlers.analyze_hover_census).toHaveBeenCalledWith({
      url: page,
      viewport: "desktop",
      reducedMotion: false,
    });
    expect(handlers.get_motion_dna).not.toHaveBeenCalled();
    expect(handlers.analyze_scroll_map).not.toHaveBeenCalled();
    expect(result).toBe(okResponse);
  });

  it("forwards optional branch fields", async () => {
    const handlers = motionHandlers();

    await runAnalyzeMotion(
      handlers as any,
      analyzeMotionRequestSchema.parse({ kind: "dna", url, recapture: true }),
    );
    await runAnalyzeMotion(
      handlers as any,
      analyzeMotionRequestSchema.parse({
        kind: "scroll",
        url: page,
        waitStrategy: "load",
        viewport: "mobile",
        reducedMotion: true,
        scrubProbe: true,
        compact: true,
      }),
    );
    await runAnalyzeMotion(
      handlers as any,
      analyzeMotionRequestSchema.parse({
        kind: "hover",
        url: page,
        waitStrategy: "networkidle",
        compact: true,
      }),
    );

    expect(handlers.get_motion_dna).toHaveBeenCalledWith({ url, recapture: true });
    expect(handlers.analyze_scroll_map).toHaveBeenCalledWith({
      url: page,
      waitStrategy: "load",
      viewport: "mobile",
      reducedMotion: true,
      scrubProbe: true,
      compact: true,
    });
    expect(handlers.analyze_hover_census).toHaveBeenCalledWith({
      url: page,
      waitStrategy: "networkidle",
      viewport: "desktop",
      reducedMotion: false,
      compact: true,
    });
  });
});

describe("capturePageRequestSchema", () => {
  it("parses each valid branch", () => {
    expect(capturePageRequestSchema.parse({ kind: "screenshot", url })).toEqual({
      kind: "screenshot",
      url,
      waitStrategy: "load",
      viewport: "desktop",
      waitForOverlay: true,
      scrollCapture: "auto",
    });

    expect(
      capturePageRequestSchema.parse({
        kind: "screenshot",
        url,
        waitStrategy: "networkidle",
        viewport: "mobile",
        inline: false,
        maxInlineBytes: 100000,
        waitForOverlay: false,
        scrollCapture: "anchors",
      }),
    ).toEqual({
      kind: "screenshot",
      url,
      waitStrategy: "networkidle",
      viewport: "mobile",
      inline: false,
      maxInlineBytes: 100000,
      waitForOverlay: false,
      scrollCapture: "anchors",
    });

    expect(
      capturePageRequestSchema.parse({
        kind: "component",
        url,
        selector: "#hero",
        maxNodes: 800,
        viewport: "mobile",
        compact: true,
      }),
    ).toEqual({
      kind: "component",
      url,
      selector: "#hero",
      maxNodes: 800,
      viewport: "mobile",
      compact: true,
    });

    expect(
      capturePageRequestSchema.parse({ kind: "pose", url, steps: 8, viewport: "mobile" }),
    ).toEqual({ kind: "pose", url, steps: 8, viewport: "mobile" });

    expect(capturePageRequestSchema.parse({ kind: "recording", url })).toEqual({
      kind: "recording",
      url,
      frames: 16,
      waitStrategy: "load",
      viewport: "desktop",
    });

    expect(capturePageRequestSchema.parse({ kind: "scene", op: "capture", url })).toEqual({
      kind: "scene",
      op: "capture",
      url,
    });

    expect(
      capturePageRequestSchema.parse({
        kind: "scene",
        op: "download_assets",
        captureId: "scene-mg2k3j4p-0123abcd",
        assetIds: ["asset-1", "asset-2"],
        rights: { basis: "licensed", evidence: "CC BY 4.0, https://creativecommons.org/licenses/by/4.0/" },
      }),
    ).toEqual({
      kind: "scene",
      op: "download_assets",
      captureId: "scene-mg2k3j4p-0123abcd",
      assetIds: ["asset-1", "asset-2"],
      rights: { basis: "licensed", evidence: "CC BY 4.0, https://creativecommons.org/licenses/by/4.0/" },
    });
  });

  it("rejects scene requests that mix ops or omit op-specific fields", () => {
    const captureId = "scene-mg2k3j4p-0123abcd";
    const rights = { basis: "owned", evidence: "own studio asset" };
    const invalid = [
      { kind: "scene", op: "capture" },
      { kind: "scene", url },
      { kind: "scene", op: "capture", url, captureId },
      { kind: "scene", op: "capture", url, rights },
      { kind: "scene", op: "download_assets", captureId, assetIds: ["asset-1"] },
      { kind: "scene", op: "download_assets", captureId, rights },
      { kind: "scene", op: "download_assets", assetIds: ["asset-1"], rights },
      { kind: "scene", op: "download_assets", url, captureId, assetIds: ["asset-1"], rights },
      { kind: "scene", op: "download_assets", captureId, assetIds: ["../asset-1"], rights },
      {
        kind: "scene",
        op: "download_assets",
        captureId,
        assetIds: ["asset-1"],
        rights: { basis: "borrowed", evidence: "x" },
      },
    ];
    for (const input of invalid) {
      expect(capturePageRequestSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it("rejects a valid-looking payload with a foreign branch field", () => {
    const parsed = capturePageRequestSchema.safeParse({
      kind: "pose",
      url,
      frames: 12,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("rejects an array form, an all form and an extra top-level key", () => {
    expect(
      capturePageInputSchema.safeParse({
        request: [
          { kind: "pose", url },
          { kind: "recording", url },
        ],
      }).success,
    ).toBe(false);
    expect(capturePageInputSchema.safeParse({ request: { kind: "all", url } }).success).toBe(false);
    expect(
      capturePageInputSchema.safeParse({ request: { kind: "pose", url }, extra: true }).success,
    ).toBe(false);
  });
});

describe("runCapturePage", () => {
  it("dispatches screenshot with defaults and omits undefined optionals", async () => {
    const handlers = captureHandlers();
    const request = capturePageRequestSchema.parse({ kind: "screenshot", url });

    const result = await runCapturePage(handlers as any, request);

    expect(handlers.capture_live_site).toHaveBeenCalledTimes(1);
    expect(handlers.capture_live_site).toHaveBeenCalledWith({
      url,
      waitStrategy: "load",
      viewport: "desktop",
      waitForOverlay: true,
      scrollCapture: "auto",
    });
    expect(handlers.capture_component).not.toHaveBeenCalled();
    expect(handlers.capture_pose_3d).not.toHaveBeenCalled();
    expect(handlers.record_site_motion).not.toHaveBeenCalled();
    expect(result).toBe(okResponse);
  });

  it("dispatches component with defaults and omits undefined optionals", async () => {
    const handlers = captureHandlers();
    const request = capturePageRequestSchema.parse({ kind: "component", url });

    const result = await runCapturePage(handlers as any, request);

    expect(handlers.capture_component).toHaveBeenCalledTimes(1);
    expect(handlers.capture_component).toHaveBeenCalledWith({ url, viewport: "desktop", maxDepth: 12 });
    expect(handlers.capture_live_site).not.toHaveBeenCalled();
    expect(handlers.capture_pose_3d).not.toHaveBeenCalled();
    expect(handlers.record_site_motion).not.toHaveBeenCalled();
    expect(result).toBe(okResponse);
  });

  it("dispatches pose with defaults and omits undefined steps", async () => {
    const handlers = captureHandlers();
    const request = capturePageRequestSchema.parse({ kind: "pose", url });

    const result = await runCapturePage(handlers as any, request);

    expect(handlers.capture_pose_3d).toHaveBeenCalledTimes(1);
    expect(handlers.capture_pose_3d).toHaveBeenCalledWith({ url, viewport: "desktop" });
    expect(handlers.capture_live_site).not.toHaveBeenCalled();
    expect(handlers.capture_component).not.toHaveBeenCalled();
    expect(handlers.record_site_motion).not.toHaveBeenCalled();
    expect(result).toBe(okResponse);
  });

  it("dispatches scene capture and omits undefined optionals", async () => {
    const handlers = captureHandlers();
    const request = capturePageRequestSchema.parse({ kind: "scene", op: "capture", url });

    const result = await runCapturePage(handlers as any, request);

    expect(handlers.capture_scene_3d).toHaveBeenCalledTimes(1);
    expect(handlers.capture_scene_3d).toHaveBeenCalledWith({ url });
    expect(handlers.download_scene_assets).not.toHaveBeenCalled();
    expect(handlers.capture_live_site).not.toHaveBeenCalled();
    expect(handlers.capture_component).not.toHaveBeenCalled();
    expect(handlers.capture_pose_3d).not.toHaveBeenCalled();
    expect(handlers.record_site_motion).not.toHaveBeenCalled();
    expect(result).toBe(okResponse);
  });

  it("dispatches scene download_assets with rights and no capture fields", async () => {
    const handlers = captureHandlers();
    const rights = { basis: "permission" as const, evidence: "written permission, 2026-11-01" };
    const request = capturePageRequestSchema.parse({
      kind: "scene",
      op: "download_assets",
      captureId: "scene-mg2k3j4p-0123abcd",
      assetIds: ["asset-2"],
      rights,
    });

    const result = await runCapturePage(handlers as any, request);

    expect(handlers.download_scene_assets).toHaveBeenCalledWith({
      captureId: "scene-mg2k3j4p-0123abcd",
      assetIds: ["asset-2"],
      rights,
    });
    expect(handlers.capture_scene_3d).not.toHaveBeenCalled();
    expect(result).toBe(okResponse);
  });

  it("forwards scene optionals", async () => {
    const handlers = captureHandlers();
    const checkpoints = [
      { scrollRatio: 0.25, pointer: { x: 0.5, y: 0.75 }, waitMs: 100 },
      { scrollRatio: 1 },
    ];
    const request = capturePageRequestSchema.parse({
      kind: "scene",
      op: "capture",
      url,
      canvasSelector: "#scene",
      scrollRoot: "#scroll",
      viewport: "mobile",
      checkpoints,
      assetOrigins: ["https://cdn.example.com"],
      adapters: ["three"],
      includeViewportShots: false,
    });

    await runCapturePage(handlers as any, request);

    expect(handlers.capture_scene_3d).toHaveBeenCalledWith({
      url,
      canvasSelector: "#scene",
      scrollRoot: "#scroll",
      viewport: "mobile",
      checkpoints,
      assetOrigins: ["https://cdn.example.com"],
      adapters: ["three"],
      includeViewportShots: false,
    });
  });

  it("forwards both opt-in scene adapters and rejects duplicates or download use", async () => {
    const handlers = captureHandlers();
    const request = capturePageRequestSchema.parse({
      kind: "scene",
      op: "capture",
      url,
      adapters: ["three", "spector"],
    });

    await runCapturePage(handlers as any, request);

    expect(handlers.capture_scene_3d).toHaveBeenCalledWith({
      url,
      adapters: ["three", "spector"],
    });
    expect(
      capturePageRequestSchema.safeParse({
        kind: "scene",
        op: "capture",
        url,
        adapters: ["spector", "spector"],
      }).success,
    ).toBe(false);
    expect(
      capturePageRequestSchema.safeParse({
        kind: "scene",
        op: "capture",
        url,
        adapters: ["three", "spector", "specter"],
      }).success,
    ).toBe(false);
    expect(
      capturePageRequestSchema.safeParse({
        kind: "scene",
        op: "download_assets",
        captureId: "scene-mg2k3j4p-0123abcd",
        assetIds: ["asset-1"],
        rights: { basis: "permission", evidence: "written permission" },
        adapters: ["spector"],
      }).success,
    ).toBe(false);
  });

  it("dispatches recording with defaults", async () => {
    const handlers = captureHandlers();
    const request = capturePageRequestSchema.parse({ kind: "recording", url });

    const result = await runCapturePage(handlers as any, request);

    expect(handlers.record_site_motion).toHaveBeenCalledTimes(1);
    expect(handlers.record_site_motion).toHaveBeenCalledWith({
      url,
      frames: 16,
      waitStrategy: "load",
      viewport: "desktop",
    });
    expect(handlers.capture_live_site).not.toHaveBeenCalled();
    expect(handlers.capture_component).not.toHaveBeenCalled();
    expect(handlers.capture_pose_3d).not.toHaveBeenCalled();
    expect(result).toBe(okResponse);
  });

  it("forwards optional branch fields", async () => {
    const handlers = captureHandlers();

    await runCapturePage(
      handlers as any,
      capturePageRequestSchema.parse({
        kind: "screenshot",
        url,
        inline: false,
        maxInlineBytes: 100000,
        waitForOverlay: false,
        scrollCapture: "viewport",
      }),
    );
    await runCapturePage(
      handlers as any,
      capturePageRequestSchema.parse({
        kind: "component",
        url,
        selector: "#hero",
        maxNodes: 800,
        compact: true,
      }),
    );
    await runCapturePage(
      handlers as any,
      capturePageRequestSchema.parse({ kind: "pose", url, steps: 8 }),
    );

    expect(handlers.capture_live_site).toHaveBeenCalledWith({
      url,
      waitStrategy: "load",
      viewport: "desktop",
      inline: false,
      maxInlineBytes: 100000,
      waitForOverlay: false,
      scrollCapture: "viewport",
    });
    expect(handlers.capture_component).toHaveBeenCalledWith({
      url,
      selector: "#hero",
      maxNodes: 800,
      maxDepth: 12,
      viewport: "desktop",
      compact: true,
    });
    expect(handlers.capture_pose_3d).toHaveBeenCalledWith({ url, steps: 8, viewport: "desktop" });
  });
});

describe("auditPageRequestSchema", () => {
  it("parses each valid branch", () => {
    expect(auditPageRequestSchema.parse({ kind: "performance", url })).toEqual({
      kind: "performance",
      url,
      viewport: "desktop",
      timeoutMs: 10000,
    });

    expect(
      auditPageRequestSchema.parse({
        kind: "performance",
        url,
        viewport: "mobile",
        timeoutMs: 3000,
        compact: true,
      }),
    ).toEqual({
      kind: "performance",
      url,
      viewport: "mobile",
      timeoutMs: 3000,
      compact: true,
    });

    expect(
      auditPageRequestSchema.parse({
        kind: "accessibility",
        url,
        viewport: "mobile",
        limit: 25,
      }),
    ).toEqual({ kind: "accessibility", url, viewport: "mobile", limit: 25 });

    expect(
      auditPageRequestSchema.parse({
        kind: "images",
        url,
        viewport: "mobile",
        maxImages: 50,
      }),
    ).toEqual({ kind: "images", url, viewport: "mobile", maxImages: 50 });

    expect(
      auditPageRequestSchema.parse({
        kind: "bundle",
        url,
        keywords: ["gsap", "ScrollTrigger"],
        maxChunks: 20,
        walkChunks: true,
        edges: true,
        bundleIntel: true,
      }),
    ).toEqual({
      kind: "bundle",
      url,
      keywords: ["gsap", "ScrollTrigger"],
      maxChunks: 20,
      walkChunks: true,
      edges: true,
      bundleIntel: true,
    });
  });

  it("rejects a valid-looking payload with a foreign branch field", () => {
    const parsed = auditPageRequestSchema.safeParse({
      kind: "bundle",
      url,
      viewport: "mobile",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("rejects an array form, an all form and an extra top-level key", () => {
    expect(
      auditPageInputSchema.safeParse({
        request: [
          { kind: "performance", url },
          { kind: "images", url },
        ],
      }).success,
    ).toBe(false);
    expect(auditPageInputSchema.safeParse({ request: { kind: "all", url } }).success).toBe(false);
    expect(
      auditPageInputSchema.safeParse({ request: { kind: "images", url }, extra: true }).success,
    ).toBe(false);
  });
});

describe("runAuditPage", () => {
  it("dispatches performance with defaults and omits undefined compact", async () => {
    const handlers = auditHandlers();
    const request = auditPageRequestSchema.parse({ kind: "performance", url });

    const result = await runAuditPage(handlers as any, request);

    expect(handlers.audit_url).toHaveBeenCalledTimes(1);
    expect(handlers.audit_url).toHaveBeenCalledWith({
      url,
      viewport: "desktop",
      timeoutMs: 10000,
    });
    expect(handlers.analyze_accessibility).not.toHaveBeenCalled();
    expect(handlers.analyze_images).not.toHaveBeenCalled();
    expect(handlers.analyze_bundle).not.toHaveBeenCalled();
    expect(result).toBe(okResponse);
  });

  it("dispatches accessibility with defaults", async () => {
    const handlers = auditHandlers();
    const request = auditPageRequestSchema.parse({ kind: "accessibility", url });

    const result = await runAuditPage(handlers as any, request);

    expect(handlers.analyze_accessibility).toHaveBeenCalledTimes(1);
    expect(handlers.analyze_accessibility).toHaveBeenCalledWith({
      url,
      viewport: "desktop",
      limit: 100,
    });
    expect(handlers.audit_url).not.toHaveBeenCalled();
    expect(handlers.analyze_images).not.toHaveBeenCalled();
    expect(handlers.analyze_bundle).not.toHaveBeenCalled();
    expect(result).toBe(okResponse);
  });

  it("dispatches images with defaults", async () => {
    const handlers = auditHandlers();
    const request = auditPageRequestSchema.parse({ kind: "images", url });

    const result = await runAuditPage(handlers as any, request);

    expect(handlers.analyze_images).toHaveBeenCalledTimes(1);
    expect(handlers.analyze_images).toHaveBeenCalledWith({
      url,
      viewport: "desktop",
      maxImages: 200,
    });
    expect(handlers.audit_url).not.toHaveBeenCalled();
    expect(handlers.analyze_accessibility).not.toHaveBeenCalled();
    expect(handlers.analyze_bundle).not.toHaveBeenCalled();
    expect(result).toBe(okResponse);
  });

  it("dispatches bundle with defaults and omits undefined optionals", async () => {
    const handlers = auditHandlers();
    const request = auditPageRequestSchema.parse({ kind: "bundle", url });

    const result = await runAuditPage(handlers as any, request);

    expect(handlers.analyze_bundle).toHaveBeenCalledTimes(1);
    expect(handlers.analyze_bundle).toHaveBeenCalledWith({
      url,
      edges: false,
      bundleIntel: false,
    });
    expect(handlers.audit_url).not.toHaveBeenCalled();
    expect(handlers.analyze_accessibility).not.toHaveBeenCalled();
    expect(handlers.analyze_images).not.toHaveBeenCalled();
    expect(result).toBe(okResponse);
  });

  it("forwards optional branch fields", async () => {
    const handlers = auditHandlers();

    await runAuditPage(
      handlers as any,
      auditPageRequestSchema.parse({
        kind: "performance",
        url,
        viewport: "mobile",
        timeoutMs: 3000,
        compact: true,
      }),
    );
    await runAuditPage(
      handlers as any,
      auditPageRequestSchema.parse({ kind: "accessibility", url, limit: 25 }),
    );
    await runAuditPage(
      handlers as any,
      auditPageRequestSchema.parse({ kind: "images", url, maxImages: 50 }),
    );
    await runAuditPage(
      handlers as any,
      auditPageRequestSchema.parse({
        kind: "bundle",
        url,
        keywords: ["gsap"],
        maxChunks: 20,
        walkChunks: true,
        edges: true,
        bundleIntel: true,
      }),
    );

    expect(handlers.audit_url).toHaveBeenCalledWith({
      url,
      viewport: "mobile",
      timeoutMs: 3000,
      compact: true,
    });
    expect(handlers.analyze_accessibility).toHaveBeenCalledWith({
      url,
      viewport: "desktop",
      limit: 25,
    });
    expect(handlers.analyze_images).toHaveBeenCalledWith({
      url,
      viewport: "desktop",
      maxImages: 50,
    });
    expect(handlers.analyze_bundle).toHaveBeenCalledWith({
      url,
      keywords: ["gsap"],
      maxChunks: 20,
      walkChunks: true,
      edges: true,
      bundleIntel: true,
    });
  });
});

describe("monitorAwardsRequestSchema", () => {
  it("parses each valid branch", () => {
    expect(monitorAwardsRequestSchema.parse({ action: "poll_winners" })).toEqual({
      action: "poll_winners",
      award: "sotd",
    });

    expect(
      monitorAwardsRequestSchema.parse({
        action: "poll_winners",
        award: "developer",
      }),
    ).toEqual({ action: "poll_winners", award: "developer" });

    expect(
      monitorAwardsRequestSchema.parse({
        action: "add_watch",
        kind: "studio",
        pattern: "ToyFight",
        award: "honorable",
        note: "check monthly",
      }),
    ).toEqual({
      action: "add_watch",
      kind: "studio",
      pattern: "ToyFight",
      award: "honorable",
      note: "check monthly",
    });

    expect(monitorAwardsRequestSchema.parse({ action: "list_watches" })).toEqual({
      action: "list_watches",
    });

    expect(
      monitorAwardsRequestSchema.parse({
        action: "remove_watch",
        kind: "tag",
        pattern: "webgl",
      }),
    ).toEqual({ action: "remove_watch", kind: "tag", pattern: "webgl" });
  });

  it("rejects a valid-looking payload with a foreign branch field", () => {
    const parsed = monitorAwardsRequestSchema.safeParse({
      action: "poll_winners",
      kind: "studio",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("rejects an array form, an all form and an extra top-level key", () => {
    expect(
      monitorAwardsInputSchema.safeParse({
        request: [
          { action: "poll_winners" },
          { action: "list_watches" },
        ],
      }).success,
    ).toBe(false);
    expect(monitorAwardsInputSchema.safeParse({ request: { action: "all" } }).success).toBe(false);
    expect(
      monitorAwardsInputSchema.safeParse({ request: { action: "list_watches" }, extra: true }).success,
    ).toBe(false);
  });
});

describe("runMonitorAwards", () => {
  it("dispatches poll_winners with the award default", async () => {
    const handlers = monitorHandlers();
    const request = monitorAwardsRequestSchema.parse({ action: "poll_winners" });

    const result = await runMonitorAwards(handlers as any, request);

    expect(handlers.new_winners).toHaveBeenCalledTimes(1);
    expect(handlers.new_winners).toHaveBeenCalledWith({ award: "sotd" });
    expect(handlers.watch_site).not.toHaveBeenCalled();
    expect(result).toBe(okResponse);
  });

  it("dispatches add_watch and omits undefined award and note", async () => {
    const handlers = monitorHandlers();
    const request = monitorAwardsRequestSchema.parse({
      action: "add_watch",
      kind: "studio",
      pattern: "ToyFight",
    });

    const result = await runMonitorAwards(handlers as any, request);

    expect(handlers.watch_site).toHaveBeenCalledTimes(1);
    expect(handlers.watch_site).toHaveBeenCalledWith({
      action: "add",
      kind: "studio",
      pattern: "ToyFight",
    });
    expect(handlers.new_winners).not.toHaveBeenCalled();
    expect(result).toBe(okResponse);
  });

  it("dispatches list_watches to the list action", async () => {
    const handlers = monitorHandlers();
    const request = monitorAwardsRequestSchema.parse({ action: "list_watches" });

    const result = await runMonitorAwards(handlers as any, request);

    expect(handlers.watch_site).toHaveBeenCalledTimes(1);
    expect(handlers.watch_site).toHaveBeenCalledWith({ action: "list" });
    expect(handlers.new_winners).not.toHaveBeenCalled();
    expect(result).toBe(okResponse);
  });

  it("dispatches remove_watch to the remove action", async () => {
    const handlers = monitorHandlers();
    const request = monitorAwardsRequestSchema.parse({
      action: "remove_watch",
      kind: "tag",
      pattern: "webgl",
    });

    const result = await runMonitorAwards(handlers as any, request);

    expect(handlers.watch_site).toHaveBeenCalledTimes(1);
    expect(handlers.watch_site).toHaveBeenCalledWith({
      action: "remove",
      kind: "tag",
      pattern: "webgl",
    });
    expect(handlers.new_winners).not.toHaveBeenCalled();
    expect(result).toBe(okResponse);
  });

  it("forwards optional add_watch fields", async () => {
    const handlers = monitorHandlers();

    await runMonitorAwards(
      handlers as any,
      monitorAwardsRequestSchema.parse({
        action: "add_watch",
        kind: "url",
        pattern: "l-i-s-a",
        award: "honorable",
        note: "check monthly",
      }),
    );

    expect(handlers.watch_site).toHaveBeenCalledWith({
      action: "add",
      kind: "url",
      pattern: "l-i-s-a",
      award: "honorable",
      note: "check monthly",
    });
  });
});

describe("registerInspectPage", () => {
  it("registers inspect_page with read-only annotations and dispatches", async () => {
    const ctx = fakeCtx(inspectHandlers());

    registerInspectPage(ctx);

    expect(ctx.tool).toHaveBeenCalledTimes(1);
    const [name, description, schema, annotations, callback] = ctx.tool.mock.calls[0];

    expect(name).toBe("inspect_page");
    expect(description).toContain("exactly one");
    expect(description).toContain("file://");
    expect(description).toContain("live URL");
    expect(schema).toBe(inspectPageInputSchema);
    expect(annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(typeof callback).toBe("function");
    expect(schema.safeParse({ request: { kind: "stack", url } }).success).toBe(true);
    expect(
      schema.safeParse({ request: { kind: "stack", url, selector: "#app" } }).success,
    ).toBe(false);

    const result = await callback({ request: { kind: "stack", url } });
    expect(ctx.handlers.analyze_stack).toHaveBeenCalledWith({ url });
    expect(result).toBe(okResponse);
  });
});

describe("registerAnalyzeMotion", () => {
  it("registers analyze_motion with read-only annotations and dispatches", async () => {
    const ctx = fakeCtx(motionHandlers());

    registerAnalyzeMotion(ctx);

    expect(ctx.tool).toHaveBeenCalledTimes(1);
    const [name, description, schema, annotations, callback] = ctx.tool.mock.calls[0];

    expect(name).toBe("analyze_motion");
    expect(description).toContain("exactly one");
    expect(description).toContain("cached corpus");
    expect(description).toContain("live");
    expect(schema).toBe(analyzeMotionInputSchema);
    expect(annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(typeof callback).toBe("function");
    expect(schema.safeParse({ request: { kind: "dna", url } }).success).toBe(true);
    expect(
      schema.safeParse({ request: { kind: "dna", url, compact: true } }).success,
    ).toBe(false);

    const result = await callback({
      request: analyzeMotionRequestSchema.parse({ kind: "dna", url }),
    });
    expect(ctx.handlers.get_motion_dna).toHaveBeenCalledWith({ url, recapture: false });
    expect(result).toBe(okResponse);
  });
});

describe("registerCapturePage", () => {
  it("registers capture_page as non-read-only and dispatches", async () => {
    const ctx = fakeCtx(captureHandlers());

    registerCapturePage(ctx);

    expect(ctx.tool).toHaveBeenCalledTimes(1);
    const [name, description, schema, annotations, callback] = ctx.tool.mock.calls[0];

    expect(name).toBe("capture_page");
    expect(description).toContain("exactly one");
    expect(description).toContain("Playwright");
    expect(description).toContain("ffmpeg");
    expect(description).toContain("not read-only");
    expect(schema).toBe(capturePageInputSchema);
    expect(annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(typeof callback).toBe("function");
    expect(schema.safeParse({ request: { kind: "pose", url } }).success).toBe(true);
    expect(
      schema.safeParse({ request: { kind: "pose", url, frames: 12 } }).success,
    ).toBe(false);

    const result = await callback({
      request: capturePageRequestSchema.parse({ kind: "pose", url }),
    });
    expect(ctx.handlers.capture_pose_3d).toHaveBeenCalledWith({ url, viewport: "desktop" });
    expect(result).toBe(okResponse);
  });
});

describe("registerAuditPage", () => {
  it("registers audit_page with read-only annotations and dispatches", async () => {
    const ctx = fakeCtx(auditHandlers());

    registerAuditPage(ctx);

    expect(ctx.tool).toHaveBeenCalledTimes(1);
    const [name, description, schema, annotations, callback] = ctx.tool.mock.calls[0];

    expect(name).toBe("audit_page");
    expect(description).toContain("exactly one");
    expect(description).toContain("evidence");
    expect(description).toContain("not a grade");
    expect(schema).toBe(auditPageInputSchema);
    expect(annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(typeof callback).toBe("function");
    expect(schema.safeParse({ request: { kind: "images", url } }).success).toBe(true);
    expect(
      schema.safeParse({ request: { kind: "images", url, keywords: ["x"] } }).success,
    ).toBe(false);

    const result = await callback({
      request: auditPageRequestSchema.parse({ kind: "images", url }),
    });
    expect(ctx.handlers.analyze_images).toHaveBeenCalledWith({
      url,
      viewport: "desktop",
      maxImages: 200,
    });
    expect(result).toBe(okResponse);
  });
});

describe("registerMonitorAwards", () => {
  it("registers monitor_awards with mutation annotations and dispatches", async () => {
    const ctx = fakeCtx(monitorHandlers());

    registerMonitorAwards(ctx);

    expect(ctx.tool).toHaveBeenCalledTimes(1);
    const [name, description, schema, annotations, callback] = ctx.tool.mock.calls[0];

    expect(name).toBe("monitor_awards");
    expect(description).toContain("exactly one");
    expect(description).toContain("watchlist");
    expect(description).toContain("not read-only");
    expect(schema).toBe(monitorAwardsInputSchema);
    expect(annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(typeof callback).toBe("function");
    expect(schema.safeParse({ request: { action: "list_watches" } }).success).toBe(true);
    expect(
      schema.safeParse({ request: { action: "list_watches", pattern: "x" } }).success,
    ).toBe(false);

    const result = await callback({
      request: { action: "add_watch", kind: "studio", pattern: "ToyFight" },
    });
    expect(ctx.handlers.watch_site).toHaveBeenCalledWith({
      action: "add",
      kind: "studio",
      pattern: "ToyFight",
    });
    expect(result).toBe(okResponse);
  });
});
