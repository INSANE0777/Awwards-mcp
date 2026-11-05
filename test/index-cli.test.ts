import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Cache } from "../src/cache.js";

const TSX_CLI = join(__dirname, "../node_modules/tsx/dist/cli.mjs");
const CLI = join(__dirname, "../src/index-cli.ts");
const ORIGINAL = Date.UTC(2026, 8, 20, 12);

describe("index CLI --atlas", () => {
  const run = (args: string[], env: NodeJS.ProcessEnv, cacheDir: string) =>
    spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
      env: { ...env, AWWWARDS_CACHE_DIR: cacheDir },
      encoding: "utf8",
      timeout: 30_000,
    });

  it.each([
    ["--atlas"],
    ["--atlas", "export"],
    ["--atlas="],
    ["--atlas=export"],
    ["--atlas", "import", "extra"],
    ["--atlas=import", "extra"],
    ["--pages", "1", "--atlas", "import"],
    ["--atlasfoo"],
  ])("rejects unsupported form %s before cache construction", (...args: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "awwwards-cli-atlas-"));
    try {
      const cacheDir = join(dir, "cache");
      const result = run(args, { ...process.env, AWWWARDS_MCP_ATLAS: "1" }, cacheDir);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--atlas");
      expect(existsSync(cacheDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires AWWWARDS_MCP_ATLAS=1 before constructing the cache", () => {
    const dir = mkdtempSync(join(tmpdir(), "awwwards-cli-atlas-"));
    try {
      const cacheDir = join(dir, "cache");
      const env = { ...process.env };
      delete env.AWWWARDS_MCP_ATLAS;
      const result = run(["--atlas", "import"], env, cacheDir);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("AWWWARDS_MCP_ATLAS=1");
      expect(existsSync(cacheDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imports the offline cache and never falls through to the crawler", () => {
    const dir = mkdtempSync(join(tmpdir(), "awwwards-cli-atlas-"));
    try {
      const cacheDir = join(dir, "cache");
      const cache = new Cache(cacheDir, () => ORIGINAL, { atlas: true });
      cache.setMeta("detail:alpha", {
        slug: "alpha",
        title: "Alpha",
        description: "Cached",
        palette: [],
        technologies: [],
        elements: ["Hero"],
        awards: [],
        nominee: false,
        score: null,
        ogImage: null,
        liveUrl: null,
      });
      cache.setMeta("elements:alpha", [
        { title: "Hero", mediaPath: "element/2026/08/a.jpg" },
      ]);

      const result = run(
        ["--atlas", "import"],
        { ...process.env, AWWWARDS_MCP_ATLAS: "1" },
        cacheDir,
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("atlas import");
      expect(result.stderr).toContain("1 processed");
      expect(result.stderr).not.toContain("pages crawled");

      const reopened = new Cache(cacheDir, () => ORIGINAL, { atlas: true });
      const counts = reopened.withAtlasDb((db) => ({
        pages: (db.prepare("SELECT COUNT(*) AS n FROM atlas_pages").get() as { n: number }).n,
        captures: (db.prepare("SELECT COUNT(*) AS n FROM atlas_captures").get() as { n: number }).n,
      }));
      expect(counts).toEqual({ pages: 1, captures: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts the --atlas=import form", () => {
    const dir = mkdtempSync(join(tmpdir(), "awwwards-cli-atlas-"));
    try {
      const cacheDir = join(dir, "cache");
      const result = run(
        ["--atlas=import"],
        { ...process.env, AWWWARDS_MCP_ATLAS: "1" },
        cacheDir,
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("0 processed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("index CLI --elements retirement", () => {
  it.each([
    ["--elements"],
    ["--elements=all"],
    ["--elements=10"],
    ["--elements="],
    ["--pages", "1", "--elements=all"],
  ])("rejects %s before touching the cache", (...args: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "awwwards-cli-"));
    try {
      const cacheDir = join(dir, "cache");
      const result = spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
        env: { ...process.env, AWWWARDS_CACHE_DIR: cacheDir },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("retired");
      expect(existsSync(cacheDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
