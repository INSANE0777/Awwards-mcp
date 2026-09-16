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

  it("screenshots the page with a fake chromium", async () => {
    const dir = tmpDir();
    const fake = {
      launch: async () => ({
        newPage: async () => ({
          goto: async () => {},
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
});
