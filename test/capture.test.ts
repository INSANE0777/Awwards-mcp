import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { captureLiveSite } from "../src/capture.js";

const dirs: string[] = [];
const tmpDir = () => {
  const d = mkdtempSync(join(tmpdir(), "awwwards-cap-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("captureLiveSite", () => {
  it("returns install instructions when playwright is missing", async () => {
    const res = await captureLiveSite("https://example.com", tmpDir(), async () => {
      throw new Error("Cannot find package 'playwright'");
    });
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toContain("npx playwright install chromium");
  });

  it("returns install instructions when chromium launch fails", async () => {
    const res = await captureLiveSite("https://example.com", tmpDir(), async () => ({
      chromium: { launch: async () => { throw new Error("Executable doesn't exist"); } },
    }));
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toContain("npx playwright install chromium");
  });

  it("propagates page-level runtime errors instead of the install hint", async () => {
    const res = captureLiveSite("https://example.com", tmpDir(), async () => ({
      chromium: {
        launch: async () => ({
          newPage: async () => ({
            goto: async () => {
              throw new Error("Timeout 45000ms exceeded");
            },
            screenshot: async () => {},
          }),
          close: async () => {},
        }),
      },
    }));
    await expect(res).rejects.toThrow("Timeout 45000ms exceeded");
  });

  it("screenshots the page with a fake chromium", async () => {
    const dir = tmpDir();
    const fake = {
      launch: async () => ({
        newPage: async () => ({
          goto: async () => {},
          // settle wait + pre-scroll evaluate from the capture flow
          waitForTimeout: async () => {},
          evaluate: async () => 500,
          screenshot: async ({ path }: { path: string }) => {
            const fs = await import("node:fs/promises");
            await fs.writeFile(path, Buffer.from("png-bytes"));
          },
        }),
        close: async () => {},
      }),
    };
    const res = await captureLiveSite(
      "https://example.com",
      dir,
      async () => ({ chromium: fake }),
    );
    expect("file" in res).toBe(true);
    if ("file" in res) {
      expect(readFileSync(res.file).toString()).toBe("png-bytes");
      expect(res.base64).toBe(Buffer.from("png-bytes").toString("base64"));
    }
  });

  // Page fake that records the order of goto/waitForTimeout/evaluate/screenshot
  // calls so tests can pin the wait-strategy, settle, and pre-scroll ordering.
  const recordingFake = (calls: string[]) => ({
    launch: async () => ({
      newPage: async () => ({
        goto: async (_u: string, o: any) => { calls.push("goto:" + o.waitUntil); },
        waitForTimeout: async (ms: number) => { calls.push("wait:" + ms); },
        evaluate: async () => { calls.push("eval"); return 500; },
        screenshot: async ({ path }: { path: string }) => {
          calls.push("shot");
          const fs = await import("node:fs/promises");
          await fs.writeFile(path, Buffer.from("png-bytes"));
        },
      }),
      close: async () => {},
    }),
  });

  it("uses load strategy with settle and scrolls before the screenshot", async () => {
    const calls: string[] = [];
    const res = await captureLiveSite(
      "https://example.com",
      tmpDir(),
      async () => ({ chromium: recordingFake(calls) }),
    );
    expect("file" in res).toBe(true);
    expect(calls[0]).toBe("goto:load"); // default wait strategy is "load"
    expect(calls.indexOf("wait:3000")).toBe(1); // settle right after load
    expect(calls.filter((c) => c === "eval").length).toBeGreaterThanOrEqual(1); // pre-scroll runs
    expect(calls.indexOf("eval")).toBeGreaterThan(calls.indexOf("wait:3000")); // scroll after settle
    expect(calls[calls.length - 1]).toBe("shot"); // screenshot last
  });

  it("networkidle strategy skips the settle but still pre-scrolls", async () => {
    const calls: string[] = [];
    const res = await captureLiveSite(
      "https://example.com",
      tmpDir(),
      async () => ({ chromium: recordingFake(calls) }),
      { waitStrategy: "networkidle" },
    );
    expect("file" in res).toBe(true);
    expect(calls[0]).toBe("goto:networkidle");
    expect(calls).not.toContain("wait:3000"); // fixed settle is load-only
    expect(calls.filter((c) => c === "eval").length).toBeGreaterThanOrEqual(1); // still pre-scrolls
    expect(calls[calls.length - 1]).toBe("shot");
  });

  // Fake chromium whose newPage captures its creation options (mirrors
  // structure.test.ts's optionCapturingFake) so tests can pin the viewport
  // threading through captureLiveSite.
  const optionCapturingFake = (captured: any[]) => ({
    launch: async () => ({
      newPage: async (opts: any) => {
        captured.push(opts);
        return {
          goto: async () => {},
          // settle wait + pre-scroll evaluate from the capture flow
          waitForTimeout: async () => {},
          evaluate: async () => 500,
          screenshot: async ({ path }: { path: string }) => {
            const fs = await import("node:fs/promises");
            await fs.writeFile(path, Buffer.from("png-bytes"));
          },
        };
      },
      close: async () => {},
    }),
  });

  it("uses the mobile viewport profile when opts.viewport is mobile", async () => {
    const captured: any[] = [];
    const res = await captureLiveSite(
      "https://x.test",
      tmpDir(),
      async () => ({ chromium: optionCapturingFake(captured) }),
      { viewport: "mobile" },
    );
    expect("file" in res).toBe(true);
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
    const res = await captureLiveSite(
      "https://x.test",
      tmpDir(),
      async () => ({ chromium: optionCapturingFake(captured) }),
    );
    expect("file" in res).toBe(true);
    expect(captured).toHaveLength(1);
    // Exact equality: the desktop default must inject no mobile flags and no
    // extra fields into newPage.
    expect(captured[0]).toEqual({ viewport: { width: 1440, height: 900 } });
  });
});
