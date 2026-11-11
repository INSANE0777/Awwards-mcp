import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerAllTools } from "../../src/tools/index.js";
import { createHandlers } from "../../src/server.js";
import type { AwwwardsClient } from "../../src/awwwards.js";
import type { Cache } from "../../src/cache.js";
import type { CaptureOpts, CaptureResult } from "../../src/capture.js";

// createHandlers only needs client+cache typed slots; these tests inject
// capture fns that never touch them, and the handler only reads imagesDir.
const deps = (extra: object) =>
  ({
    client: null as unknown as AwwwardsClient,
    cache: { imagesDir: "/cache/images" } as unknown as Cache,
    ...extra,
  }) as Parameters<typeof createHandlers>[0];

const anchorsResult: CaptureResult = {
  mode: "anchors",
  scrollRoot: "div#page.page",
  anchors: [
    { scrollTop: 0, file: "/cache/images/capture-abc-desktop-a0.png" },
    { scrollTop: 1500, file: "/cache/images/capture-abc-desktop-a5.png" },
  ],
  viewport: { width: 1440, height: 900 },
};

describe("capture_live_site scrollCapture handler output", () => {
  it("returns anchors as text JSON only (no image block, no single-file claim)", async () => {
    const h = createHandlers(deps({ captureFn: async () => anchorsResult }));
    const res = await h.capture_live_site({ url: "https://inner.test/", scrollCapture: "anchors" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(1);
    expect(res.content.every((block) => block.type === "text")).toBe(true);
    const raw = (res.content[0] as any).text as string;
    expect(raw).not.toContain("Full-page");
    expect(JSON.parse(raw)).toEqual(anchorsResult);
  });

  it("returns viewport mode as text + image, including mode/scrollRoot", async () => {
    const viewportResult: CaptureResult = {
      mode: "viewport",
      scrollRoot: "div#page.page",
      file: "/cache/images/shot.png",
      base64: Buffer.from("png").toString("base64"),
      viewport: { width: 1440, height: 900 },
    };
    const h = createHandlers(deps({ captureFn: async () => viewportResult }));
    const res = await h.capture_live_site({ url: "https://inner.test/", scrollCapture: "viewport" });
    const text = (res.content[0] as any).text as string;
    expect(text).toContain("Viewport capture of https://inner.test/");
    expect(text).toContain("inner scroller div#page.page");
    expect(text).toContain("not full-page");
    expect(text).toContain("/cache/images/shot.png");
    expect(res.content).toHaveLength(2);
    expect(res.content[1]).toEqual({
      type: "image",
      data: viewportResult.base64,
      mimeType: "image/png",
    });
  });

  it("explains an omitted viewport preview without adding an image block", async () => {
    const viewportResult: CaptureResult = {
      mode: "viewport",
      scrollRoot: "div#page.page",
      file: "/cache/images/shot.png",
      inlineOmitted: true,
      viewport: { width: 1440, height: 900 },
    };
    const h = createHandlers(deps({ captureFn: async () => viewportResult }));
    const res = await h.capture_live_site({
      url: "https://inner.test/",
      inline: false,
      scrollCapture: "viewport",
    });
    expect(res.content).toHaveLength(1);
    const text = (res.content[0] as any).text as string;
    expect(text).toContain("(inline preview disabled; open the saved file)");
    expect(text).toContain("not full-page");
  });

  it("threads scrollCapture to the capture fn and defaults to undefined (auto)", async () => {
    const seen: Array<CaptureOpts | undefined> = [];
    const h = createHandlers(
      deps({
        captureFn: async (_url: string, _dir: string, opts?: CaptureOpts) => {
          seen.push(opts);
          return anchorsResult;
        },
      }),
    );
    await h.capture_live_site({ url: "https://inner.test/" });
    await h.capture_live_site({ url: "https://inner.test/", scrollCapture: "viewport" });
    expect(seen[0]?.scrollCapture).toBeUndefined();
    expect(seen[1]?.scrollCapture).toBe("viewport");
  });
});

describe("capture_live_site scrollCapture schema", () => {
  it("registers the enum with an auto default", () => {
    const regs: any[][] = [];
    const tool = (...args: any[]) => regs.push(args);
    registerAllTools({ handlers: {} as any, tool, registerTool: tool }, { atlas: false });
    const match = regs.find((args) => args[0] === "capture_live_site");
    expect(match).toBeDefined();
    // Tool modules pass a raw field shape; server-instance wraps it in z.object.
    const schema = z.object(match![2]);
    expect(schema.parse({ url: "https://x.test" }).scrollCapture).toBe("auto");
    expect(schema.parse({ url: "https://x.test", scrollCapture: "anchors" }).scrollCapture).toBe(
      "anchors",
    );
    expect(schema.safeParse({ url: "https://x.test", scrollCapture: "nope" }).success).toBe(false);
  });
});
