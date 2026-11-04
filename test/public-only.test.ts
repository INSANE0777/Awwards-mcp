import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cache } from "../src/cache.js";
import { createHandlers } from "../src/server.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-public-only-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("publicOnly capture guard", () => {
  it("refuses loopback before any capture runs", async () => {
    const captureFn = vi.fn();
    const h = createHandlers({ cache: new Cache(tmpDir()), captureFn });
    const result = await h.capture_live_site({ url: "http://127.0.0.1:9/", publicOnly: true });
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Refusing to load");
    expect(captureFn).not.toHaveBeenCalled();
  });

  it("passes the guard proxy to all four capture primitives", async () => {
    const dir = tmpDir();
    const cache = new Cache(dir);
    const seen: string[] = [];
    const h = createHandlers({
      cache,
      captureFn: async (_url, _dir, opts: any) => {
        seen.push(opts.proxyServer);
        return { error: "stop after proxy assertion" } as any;
      },
      captureComponentFn: async (_url, opts: any) => {
        seen.push(opts.proxyServer);
        return { error: "stop after proxy assertion" } as any;
      },
      analyzeFn: async (_url, _maxBands, opts: any) => {
        seen.push(opts.proxyServer);
        return { error: "stop after proxy assertion" } as any;
      },
    });
    const url = "https://93.184.216.34/";
    await h.capture_live_site({ url, publicOnly: true });
    await h.capture_component({ url, publicOnly: true });
    await h.export_design_tokens({ url, publicOnly: true });
    await h.analyze_page_structure({ url, publicOnly: true });
    expect(seen).toHaveLength(4);
    for (const proxy of seen) expect(proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("rejects publicOnly with an attached CDP browser", async () => {
    const h = createHandlers({ cache: new Cache(tmpDir()) });
    const result = await h.analyze_page_structure({
      url: "https://93.184.216.34/",
      publicOnly: true,
      cdpEndpoint: "http://127.0.0.1:9222",
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("publicOnly cannot attach");
  });
});
