import { afterEach, describe, expect, it } from "vitest";
import { IMAGE_SCAN_SNIPPET, scanImages } from "../../src/images.js";
import type { RawImage } from "../../src/images.js";
import { createHandlers } from "../../src/server.js";
import type { AwwwardsClient } from "../../src/awwwards.js";
import type { Cache } from "../../src/cache.js";
import { registerAllTools } from "../../src/tools/index.js";

// createHandlers needs client+cache typed slots, but every test here injects an
// analyze fn that never touches them — dummies keep the file offline.
const deps = (extra: object) =>
  ({
    client: null as unknown as AwwwardsClient,
    cache: null as unknown as Cache,
    ...extra,
  }) as Parameters<typeof createHandlers>[0];

const row = (over: Partial<RawImage> = {}): RawImage => ({
  currentSrc: "",
  src: "https://cdn.example.dev/hero.jpg",
  complete: true,
  naturalWidth: 1200,
  naturalHeight: 800,
  displayWidth: 600,
  displayHeight: 400,
  widthAttr: "1200",
  heightAttr: "800",
  loadingAttr: null,
  srcset: null,
  sizes: null,
  altAttr: "Hero",
  role: null,
  ariaHidden: null,
  ...over,
});

const scan = { total: 3, rows: [row(), row({ src: "https://cdn.example.dev/2.png" })] };

describe("scanImages browser path", () => {
  it("runs goto, settle, fonts, preScroll, then the image scan and closes", async () => {
    const order: string[] = [];
    const pageOptions: any[] = [];
    const page = {
      addInitScript: async () => {
        order.push("shims");
      },
      goto: async () => {
        order.push("goto");
      },
      waitForTimeout: async (ms: number) => {
        order.push(`wait:${ms}`);
      },
      evaluate: async (fn: unknown) => {
        if (fn === IMAGE_SCAN_SNIPPET) {
          order.push("scan");
          return scan;
        }
        const source = typeof fn === "string" ? fn : String((fn as () => unknown).toString());
        order.push(source.includes("fonts.ready") ? "fonts" : "prescroll");
        return undefined;
      },
    };
    const browser = {
      newPage: async (opts: any) => {
        pageOptions.push(opts);
        return page;
      },
      close: async () => {
        order.push("close");
      },
    };
    const loader = async () => ({ chromium: { launch: async () => browser } });

    const result = await scanImages("https://example.dev/", { loader });

    expect(result).toEqual(scan);
    expect(order).toEqual(["shims", "goto", "wait:3000", "fonts", "prescroll", "scan", "close"]);
    expect(pageOptions).toEqual([{ viewport: { width: 1440, height: 900 } }]);
  });

  it("closes the browser when the scan throws", async () => {
    let closed = false;
    const browser = {
      newPage: async () => ({
        addInitScript: async () => {},
        goto: async () => {
          throw new Error("navigation failed");
        },
        waitForTimeout: async () => {},
        evaluate: async () => undefined,
      }),
      close: async () => {
        closed = true;
      },
    };
    const loader = async () => ({ chromium: { launch: async () => browser } });

    const result = await scanImages("https://example.dev/", { loader });

    expect(result).toEqual({ error: "navigation failed" });
    expect(closed).toBe(true);
  });
});

describe("IMAGE_SCAN_SNIPPET", () => {
  afterEach(() => {
    delete (globalThis as any).document;
  });

  it("reports the true total and caps rows at 500", () => {
    const images = Array.from({ length: 600 }, (_, i) => ({
      currentSrc: i === 0 ? "https://cdn.example.dev/hero.avif" : "",
      src: `https://cdn.example.dev/${i}.png`,
      complete: true,
      naturalWidth: 100,
      naturalHeight: 50,
      getBoundingClientRect: () => ({ width: 50, height: 25 }),
      getAttribute: (name: string) =>
        name === "alt" ? "Hero" : name === "loading" ? "lazy" : name === "width" ? "100" : null,
    }));
    (globalThis as any).document = { images };

    const result = IMAGE_SCAN_SNIPPET();

    expect(result.total).toBe(600);
    expect(result.rows).toHaveLength(500);
    expect(result.rows[0]).toEqual({
      currentSrc: "https://cdn.example.dev/hero.avif",
      src: "https://cdn.example.dev/0.png",
      complete: true,
      naturalWidth: 100,
      naturalHeight: 50,
      displayWidth: 50,
      displayHeight: 25,
      loadingAttr: "lazy",
      srcset: null,
      sizes: null,
      altAttr: "Hero",
      role: null,
      ariaHidden: null,
      widthAttr: "100",
      heightAttr: null,
    });
    expect(result.rows[1]!.src).toBe("https://cdn.example.dev/1.png");
  });
});

describe("analyze_images handler", () => {
  it("forwards viewport/maxImages and keeps the scan's pre-cap total", async () => {
    const seen: Array<{ url: string; opts?: { viewport?: string; maxImages?: number } }> = [];
    const h = createHandlers(
      deps({
        analyzeImagesFn: async (url, opts) => {
          seen.push({ url, opts });
          return { total: 900, rows: scan.rows };
        },
      }),
    );

    const res = await h.analyze_images({ url: "https://example.dev/", maxImages: 1 });
    expect(res.isError).toBeUndefined();
    expect(seen).toEqual([
      { url: "https://example.dev/", opts: { viewport: "desktop", maxImages: 1 } },
    ]);

    const raw = (res.content[0] as any).text as string;
    expect(raw).toContain('\n "total"');
    const parsed = JSON.parse(raw);
    expect(parsed.url).toBe("https://example.dev/");
    expect(parsed.viewport).toBe("desktop");
    expect(parsed.total).toBe(900);
    expect(parsed.scanned).toBe(1);
    expect(parsed.truncated).toBe(true);
  });

  it("defaults viewport desktop and maxImages 200", async () => {
    const seen: any[] = [];
    const h = createHandlers(
      deps({
        analyzeImagesFn: async (_url, opts) => {
          seen.push(opts);
          return scan;
        },
      }),
    );

    await h.analyze_images({ url: "https://example.dev/" });
    expect(seen).toEqual([{ viewport: "desktop", maxImages: 200 }]);
  });

  it("returns scan errors as error responses", async () => {
    const h = createHandlers(
      deps({ analyzeImagesFn: async () => ({ error: "navigation failed" }) }),
    );
    const res = await h.analyze_images({ url: "https://example.dev/" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toBe("navigation failed");
  });

  it("wraps thrown errors", async () => {
    const h = createHandlers(
      deps({
        analyzeImagesFn: async () => {
          throw new Error("boom");
        },
      }),
    );
    const res = await h.analyze_images({ url: "https://example.dev/" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain("awwwards-mcp request failed: boom");
  });

  it("is registered once with non-idempotent open-world annotations", () => {
    const regs: any[][] = [];
    const tool = (...args: any[]) => regs.push(args);
    registerAllTools({ handlers: {} as any, tool, registerTool: tool }, { atlas: false });

    const matches = regs.filter((args) => args[0] === "analyze_images");
    expect(matches).toHaveLength(1);
    expect(matches[0]![3]).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(matches[0]![1]).toContain("does not fetch awwwards.com");
    expect(matches[0]![2].maxImages).toBeDefined();
  });
});
