import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import { parseAtlasCliArgs } from "../src/atlas/cli.js";
import { redactCachePath, runAtlasCommand } from "../src/atlas/cli-run.js";
import type { AtlasCaptureAttempt, AtlasCollectInput } from "../src/atlas/live-types.js";
import type { ImportReport } from "../src/atlas/import.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-cli-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const atlasCache = (): Cache => new Cache(join(tmpDir(), "cache"), () => Date.UTC(2026, 10, 10), {
  atlas: true,
});

describe("parseAtlasCliArgs actions", () => {
  it.each([
    [["--atlas", "import"], { kind: "import" }],
    [["--atlas=import"], { kind: "import" }],
    [["--atlas", "reindex"], { kind: "reindex" }],
    [["--atlas=reindex"], { kind: "reindex" }],
    [["--atlas", "verify"], { kind: "verify" }],
    [["--atlas=verify"], { kind: "verify" }],
    [
      ["--atlas", "capture", "--slug", "alpha", "--path", "/work", "--viewport", "both"],
      { kind: "capture", slug: "alpha", path: "/work", viewport: "both" },
    ],
    [
      ["--atlas=capture", "--slug=alpha", "--viewport=mobile"],
      { kind: "capture", slug: "alpha", path: "/", viewport: "mobile" },
    ],
    [
      ["--atlas", "prune", "--older-than-days", "30"],
      { kind: "prune", olderThanDays: 30, apply: false },
    ],
    [
      ["--atlas=prune", "--older-than-days=30", "--apply"],
      { kind: "prune", olderThanDays: 30, apply: true },
    ],
  ])("parses %j", (args, expected) => {
    expect(parseAtlasCliArgs(args)).toEqual(expected);
  });

  it.each([
    ["capture missing slug", ["--atlas", "capture", "--viewport", "desktop"]],
    ["capture missing viewport", ["--atlas", "capture", "--slug", "alpha"]],
    ["capture bad viewport", ["--atlas", "capture", "--slug", "alpha", "--viewport", "tablet"]],
    ["capture bad slug", ["--atlas", "capture", "--slug", "../alpha", "--viewport", "desktop"]],
    ["capture bad path", ["--atlas", "capture", "--slug", "alpha", "--path", "work", "--viewport", "desktop"]],
    ["capture query path", ["--atlas", "capture", "--slug", "alpha", "--path", "/?q=1", "--viewport", "desktop"]],
    ["capture fragment path", ["--atlas", "capture", "--slug", "alpha", "--path", "/#x", "--viewport", "desktop"]],
    ["capture duplicate", ["--atlas", "capture", "--slug", "a", "--slug", "b", "--viewport", "desktop"]],
    ["capture unknown option", ["--atlas", "capture", "--slug", "alpha", "--viewport", "desktop", "--foo", "x"]],
    ["capture positional", ["--atlas", "capture", "--slug", "alpha", "--viewport", "desktop", "extra"]],
    ["prune missing days", ["--atlas", "prune"]],
    ["prune zero days", ["--atlas", "prune", "--older-than-days", "0"]],
    ["prune negative days", ["--atlas", "prune", "--older-than-days", "-1"]],
    ["prune fractional days", ["--atlas", "prune", "--older-than-days", "1.5"]],
    ["prune apply on verify", ["--atlas", "verify", "--apply"]],
    ["reindex option", ["--atlas", "reindex", "--older-than-days", "3"]],
    ["import option", ["--atlas", "import", "--apply"]],
    ["atlas after crawl flag", ["--pages", "1", "--atlas", "import"]],
    ["atlas before crawl flag", ["--atlas", "import", "--pages", "1"]],
    ["atlas twice", ["--atlas", "import", "--atlas", "verify"]],
  ])("rejects %s", (_label, args) => {
    expect(parseAtlasCliArgs(args)?.kind).toBe("error");
  });
});

describe("runAtlasCommand capture", () => {
  const published = (capture: string) => ({
    published: true,
    captureIds: [capture],
    pageId: "page",
    regionCount: 2,
    componentCount: 0,
    claimCount: 3,
  });

  it("captures both viewports sequentially and publishes each", async () => {
    const cache = atlasCache();
    const calls: Array<{ input: AtlasCollectInput; viewport: string }> = [];
    const publishedOrder: string[] = [];
    const collect = async (input: AtlasCollectInput): Promise<AtlasCaptureAttempt> => {
      const viewport = input.viewports?.[0] ?? "desktop";
      calls.push({ input, viewport });
      return { marker: viewport } as unknown as AtlasCaptureAttempt;
    };
    const publish = async (attempt: AtlasCaptureAttempt) => {
      const marker = (attempt as unknown as { marker: string }).marker;
      publishedOrder.push(marker);
      return published(marker);
    };
    const lines: string[] = [];

    const code = await runAtlasCommand(
      { kind: "capture", slug: "alpha", path: "/work", viewport: "both" },
      { cache, log: (line) => lines.push(line), collect, publish },
    );

    expect(code).toBe(0);
    expect(calls.map((call) => call.viewport)).toEqual(["desktop", "mobile"]);
    expect(calls.map((call) => call.input.siteSlug)).toEqual(["alpha", "alpha"]);
    expect(calls.map((call) => call.input.path)).toEqual(["/work", "/work"]);
    expect(publishedOrder).toEqual(["desktop", "mobile"]);
    expect(lines.join("\n")).toContain("desktop");
    expect(lines.join("\n")).toContain("mobile");
  });

  it("returns a failure exit code when a viewport does not publish", async () => {
    const cache = atlasCache();
    const collect = async (): Promise<AtlasCaptureAttempt> =>
      ({} as AtlasCaptureAttempt);
    const publish = async () => ({
      published: false,
      code: "NO_CLAIMS",
      captureIds: [],
      pageId: "page",
      regionCount: 0,
      componentCount: 0,
      claimCount: 0,
    });
    const code = await runAtlasCommand(
      { kind: "capture", slug: "alpha", path: "/", viewport: "mobile" },
      { cache, log: () => undefined, collect, publish },
    );
    expect(code).toBe(1);
  });
});

describe("runAtlasCommand import", () => {
  it("never captures after a legacy import", async () => {
    const cache = atlasCache();
    const collect = vi.fn(async () => ({} as AtlasCaptureAttempt));
    const report: ImportReport = {
      enabled: true,
      sitePages: 1,
      galleryItems: 0,
      processed: 1,
      published: 1,
      unpublished: 0,
      artifacts: 1,
      skipped: 0,
      limitations: [],
      failures: [],
    };
    const lines: string[] = [];
    const code = await runAtlasCommand(
      { kind: "import" },
      {
        cache,
        log: (line) => lines.push(line),
        importLegacy: async () => report,
        collect,
      },
    );
    expect(code).toBe(0);
    expect(collect).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("1 processed");
  });
});

describe("runAtlasCommand redaction", () => {
  it("redacts a slash-form cache root when the message uses backslashes", () => {
    const root = "C:/cache/root";
    expect(redactCachePath("cannot read C:\\cache\\root\\atlas\\x.json", root)).toBe(
      "cannot read <cache>\\atlas\\x.json",
    );
    expect(redactCachePath("cannot read C:/cache/root/atlas/x.json", root)).toBe(
      "cannot read <cache>/atlas/x.json",
    );
    expect(redactCachePath("cannot read C:/cache/root/atlas/x.json", `${root}/`)).toBe(
      "cannot read <cache>/atlas/x.json",
    );
    expect(redactCachePath("cannot read C:\\cache\\root", root)).toBe("cannot read <cache>");
  });

  it("redacts a native-separator injected capture error against a slash cache root", async () => {
    const root = join(tmpDir(), "cache").replace(/\\/g, "/");
    const cache = new Cache(root, () => Date.UTC(2026, 10, 10), { atlas: true });
    const nativePath = join(cache.rootDir, "atlas", "artifacts");
    const lines: string[] = [];
    const code = await runAtlasCommand(
      { kind: "capture", slug: "alpha", path: "/", viewport: "desktop" },
      {
        cache,
        log: (line) => lines.push(line),
        collect: async () => {
          throw new Error(`cannot read ${nativePath}`);
        },
      },
    );

    expect(code).toBe(1);
    const output = lines.join("\n");
    expect(output).toContain("<cache>");
    expect(output).not.toContain(nativePath);
    expect(output).not.toContain(cache.rootDir);
  });
  it("redacts a cache path inside a publication code", async () => {
    const root = join(tmpDir(), "cache").replace(/\\/g, "/");
    const cache = new Cache(root, () => Date.UTC(2026, 10, 10), { atlas: true });
    const nativePath = join(cache.rootDir, "atlas", "artifacts", "broken.json");
    const lines: string[] = [];
    const code = await runAtlasCommand(
      { kind: "capture", slug: "alpha", path: "/", viewport: "desktop" },
      {
        cache,
        log: (line) => lines.push(line),
        collect: async () =>
          ({ status: "failed", limitations: [] }) as unknown as AtlasCaptureAttempt,
        publish: async () => ({
          published: false,
          code: `cannot read ${nativePath}`,
          captureIds: [],
          pageId: "page",
          regionCount: 0,
          componentCount: 0,
          claimCount: 0,
        }),
      },
    );

    expect(code).toBe(1);
    const output = lines.join("\n");
    expect(output).toContain("<cache>");
    expect(output).not.toContain(nativePath);
    expect(output).not.toContain(cache.rootDir);
  });
});

describe("runAtlasCommand offline actions", () => {
  it("reindexes without touching the network", async () => {
    const cache = atlasCache();
    const fetchSpy = vi.fn(() => {
      throw new Error("network use in reindex");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const lines: string[] = [];
    const code = await runAtlasCommand(
      { kind: "reindex" },
      { cache, log: (line) => lines.push(line), now: () => Date.UTC(2026, 10, 10) },
    );
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("reindex");
  });

  it("verifies artifacts without touching the network", async () => {
    const cache = atlasCache();
    const fetchSpy = vi.fn(() => {
      throw new Error("network use in verify");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const lines: string[] = [];
    const code = await runAtlasCommand(
      { kind: "verify" },
      { cache, log: (line) => lines.push(line) },
    );
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("verify");
  });
});
