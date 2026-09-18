import { describe, expect, it, vi } from "vitest";
import { collapseBands, analyzePageStructure } from "../src/structure.js";
import type { RawBand } from "../src/structure.js";

const band = (over: Partial<RawBand> = {}): RawBand => ({
  tag: "section",
  label: "",
  bg: "rgb(16, 21, 42)",
  top: 0,
  height: 1000,
  textStart: "",
  ...over,
});

describe("collapseBands", () => {
  it("resolves each y to the smallest covering candidate (most specific wins)", () => {
    const bands = collapseBands(
      [
        band({ label: "body", bg: "rgb(16, 21, 42)", top: 0, height: 2000 }),
        band({ label: ".shell", bg: "rgb(240, 242, 247)", top: 400, height: 1200 }),
      ],
      2000,
    );
    // body band 0-400, shell band 400-1600, body again 1600-2000
    expect(bands.map((b) => b.label)).toEqual(["body", ".shell", "body"]);
    expect(bands.map((b) => b.height)).toEqual([400, 1200, 400]);
  });

  it("merges consecutive runs with the same background", () => {
    const bands = collapseBands(
      [
        band({ label: "a", bg: "rgb(1, 1, 1)", top: 0, height: 300 }),
        band({ label: "b", bg: "rgb(1, 1, 1)", top: 300, height: 300 }),
      ],
      600,
    );
    expect(bands.length).toBe(1);
    expect(bands[0].height).toBe(600);
    expect(bands[0].label).toBe("a"); // first label wins on merge
  });

  it("absorbs tiny bands (<40px) into the previous band", () => {
    const bands = collapseBands(
      [
        band({ label: "big", bg: "rgb(1, 1, 1)", top: 0, height: 500 }),
        band({ label: "sliver", bg: "rgb(2, 2, 2)", top: 500, height: 30 }),
        band({ label: "tail", bg: "rgb(1, 1, 1)", top: 530, height: 470 }),
      ],
      1000,
    );
    expect(bands.map((b) => b.label)).toEqual(["big", "tail"]);
  });

  it("caps band count by merging the smallest band into its previous neighbor", () => {
    const many: RawBand[] = Array.from({ length: 12 }, (_, i) =>
      band({ label: `b${i}`, bg: `rgb(${i}, ${i}, ${i})`, top: i * 100, height: 100 }),
    );
    const bands = collapseBands(many, 1200, 5);
    expect(bands.length).toBeLessThanOrEqual(5);
    expect(bands[bands.length - 1].offsetTop + bands[bands.length - 1].height).toBe(1200);
  });

  it("rounds coordinates and assigns sequential indexes", () => {
    const bands = collapseBands(
      [band({ top: 0.4, height: 999.6, label: "x" })],
      1000,
    );
    expect(bands[0].index).toBe(0);
    expect(bands[0].offsetTop).toBe(0);
    expect(bands[0].height).toBe(1000);
  });
});

describe("analyzePageStructure", () => {
  it("builds the structure from the loader's evaluate result", async () => {
    const fake = {
      launch: async () => ({
        newPage: async () => ({
          goto: async () => {},
          // settle wait from the load strategy; the fake's evaluate result is
          // returned for both the pre-scroll and the scan call
          waitForTimeout: async () => {},
          evaluate: async () => ({
            title: "Test Page",
            totalHeight: 2000,
            candidates: [
              band({ label: "body", bg: "rgb(16, 21, 42)", top: 0, height: 2000 }),
              band({ tag: "section", label: ".shell", bg: "rgb(240, 242, 247)", top: 500, height: 1000, textStart: "Production speed" }),
            ],
          }),
        }),
        close: async () => {},
      }),
    };
    const res = await analyzePageStructure("https://example.com", async () => ({ chromium: fake }));
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.title).toBe("Test Page");
      expect(res.totalHeight).toBe(2000);
      expect(res.bands.map((b) => b.label)).toContain(".shell");
      expect(res.bands[0].background).toBe("rgb(16, 21, 42)");
    }
  });

  it("returns the install hint when playwright is missing", async () => {
    const res = await analyzePageStructure("https://example.com", async () => {
      throw new Error("Cannot find package 'playwright'");
    });
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toContain("npx playwright install chromium");
  });

  it("defaults to the load strategy, settles, and scrolls before the scan", async () => {
    const calls: string[] = [];
    const fake = {
      launch: async () => ({
        newPage: async () => ({
          goto: async (_u: string, o: any) => { calls.push("goto:" + o.waitUntil); },
          waitForTimeout: async (ms: number) => { calls.push("wait:" + ms); },
          evaluate: async () => {
            calls.push("eval");
            return {
              title: "Test Page",
              totalHeight: 2000,
              candidates: [
                band({ label: "body", bg: "rgb(16, 21, 42)", top: 0, height: 2000 }),
              ],
            };
          },
        }),
        close: async () => {},
      }),
    };
    const res = await analyzePageStructure("https://example.com", async () => ({ chromium: fake }));
    expect("error" in res).toBe(false);
    expect(calls[0]).toBe("goto:load"); // default wait strategy is "load"
    expect(calls.indexOf("wait:3000")).toBe(1); // settle right after load
    expect(calls.filter((c) => c === "eval").length).toBe(2); // pre-scroll + scan
    expect(calls[calls.length - 1]).toBe("eval"); // scan runs last, after the scroll
  });

  // Fake chromium whose newPage captures its creation options so tests can
  // pin the viewport threading (desktop default vs the mobile profile flags).
  const optionCapturingFake = (captured: any[]) => ({
    launch: async () => ({
      newPage: async (opts: any) => {
        captured.push(opts);
        return {
          goto: async () => {},
          // settle wait from the load strategy; the fake's evaluate result is
          // returned for both the pre-scroll and the scan call
          waitForTimeout: async () => {},
          evaluate: async () => ({
            title: "Test Page",
            totalHeight: 2000,
            candidates: [
              band({ label: "body", bg: "rgb(16, 21, 42)", top: 0, height: 2000 }),
            ],
          }),
        };
      },
      close: async () => {},
    }),
  });

  it("uses the mobile viewport profile when opts.viewport is mobile", async () => {
    const captured: any[] = [];
    const res = await analyzePageStructure(
      "https://x.test",
      async () => ({ chromium: optionCapturingFake(captured) }),
      40,
      { viewport: "mobile" },
    );
    expect("error" in res).toBe(false);
    expect(captured).toHaveLength(1);
    // The profile is SPLIT: width/height land in playwright's `viewport` key,
    // the mobile flags are sibling context options.
    expect(captured[0]).toEqual({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
  });

  it("defaults to the desktop viewport (no mobile flags)", async () => {
    const captured: any[] = [];
    const res = await analyzePageStructure(
      "https://x.test",
      async () => ({ chromium: optionCapturingFake(captured) }),
    );
    expect("error" in res).toBe(false);
    expect(captured).toHaveLength(1);
    // Exact equality: the desktop default must inject no mobile flags and no
    // extra fields into newPage.
    expect(captured[0]).toEqual({ viewport: { width: 1440, height: 900 } });
  });
});

// Mirror of the SCAN_SNIPPET in-page alpha parse (src/structure.ts). The
// snippet runs in a browser DOM we cannot spin up in offline tests, so the
// parse logic is mirrored here to pin the exact contract: space syntax,
// slash notation, percentage alphas, and the rgba?()-miss fallback (modern
// color functions are opaque; anything else stays conservative at 0).
// Keep in sync with src/structure.ts.
it("SCAN_SNIPPET alpha parsing handles space syntax and percentage alphas", () => {
  const parseAlpha = (color: string): number => {
    const m = /rgba?\(([^)]+)\)/.exec(color);
    let alpha = 0;
    if (m) {
      const parts = m[1].replace(/\//g, " ").trim().split(/[\s,]+/).filter(Boolean);
      const aRaw = parts.length >= 4 ? parts[3] : "1";
      alpha = aRaw.endsWith("%") ? parseFloat(aRaw) / 100 : parseFloat(aRaw);
      if (Number.isNaN(alpha)) alpha = 0;
    } else if (/^(oklch|oklab|lab|lch|hwb|color)\(/.test(color.trim())) {
      alpha = 1;
    }
    return alpha;
  };
  expect(parseAlpha("rgb(16 21 42 / 0)")).toBe(0); // space syntax, transparent
  expect(parseAlpha("rgb(16, 21, 42, 0)")).toBe(0); // legacy comma, transparent
  expect(parseAlpha("rgb(16 21 42 / 50%)")).toBeCloseTo(0.5); // percentage alpha
  expect(parseAlpha("rgb(240, 242, 247)")).toBe(1); // opaque, no alpha part
  expect(parseAlpha("oklch(0.7 0.1 200)")).toBe(1); // modern opaque function
  expect(parseAlpha("color(srgb 0.2 0.4 0.6)")).toBe(1); // modern opaque function
  expect(parseAlpha("linear-gradient(...)")).toBe(0); // non-function → conservative
});
