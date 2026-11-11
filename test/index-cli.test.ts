import { describe, expect, it } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
    ["--atlas", "capture"],
    ["--atlas", "capture", "--slug", "alpha"],
    ["--atlas=capture"],
    ["--atlas", "capture", "--slug", "alpha", "--viewport", "tablet"],
    ["--atlas", "capture", "--slug", "alpha", "--viewport", "desktop", "extra"],
    ["--atlas", "capture", "--slug", "alpha", "--viewport", "desktop", "--pages", "1"],
    ["--atlas", "reindex", "extra"],
    ["--atlas", "verify", "--apply"],
    ["--atlas", "prune"],
    ["--atlas", "prune", "--older-than-days", "0"],
    ["--atlas", "prune", "--older-than-days", "x"],
    ["--atlas", "prune", "--older-than-days", "30", "extra"],
    ["--pages", "1", "--atlas", "reindex"],
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

  it.each([
    [["--atlas", "import"]],
    [["--atlas", "capture", "--slug", "alpha", "--viewport", "desktop"]],
    [["--atlas", "reindex"]],
    [["--atlas", "verify"]],
    [["--atlas", "prune", "--older-than-days", "30"]],
  ])("requires AWWWARDS_MCP_ATLAS=1 for %s before constructing the cache", (args: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "awwwards-cli-atlas-"));
    try {
      const cacheDir = join(dir, "cache");
      const env = { ...process.env };
      delete env.AWWWARDS_MCP_ATLAS;
      const result = run(args, env, cacheDir);
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

  it.each([
    [["--atlas", "reindex"], "atlas reindex"],
    [["--atlas", "prune", "--older-than-days", "30"], "dry run"],
    [["--atlas", "prune", "--older-than-days", "30", "--apply"], "apply"],
  ])("runs %s against an empty cache", (args, expected) => {
    const dir = mkdtempSync(join(tmpdir(), "awwwards-cli-atlas-"));
    try {
      const cacheDir = join(dir, "cache");
      const result = run(args, { ...process.env, AWWWARDS_MCP_ATLAS: "1" }, cacheDir);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain(expected);
      expect(result.stderr).not.toContain("pages crawled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifies an existing Atlas cache read-only and never creates a missing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "awwwards-cli-atlas-"));
    try {
      const cacheDir = join(dir, "cache");
      const imported = run(
        ["--atlas", "import"],
        { ...process.env, AWWWARDS_MCP_ATLAS: "1" },
        cacheDir,
      );
      expect(imported.status).toBe(0);
      const dbPath = join(cacheDir, "cache.db");
      const before = readFileSync(dbPath);
      const beforeMtime = statSync(dbPath).mtimeMs;
      const sidecars = [`${dbPath}-wal`, `${dbPath}-shm`];
      const verified = run(
        ["--atlas", "verify"],
        { ...process.env, AWWWARDS_MCP_ATLAS: "1" },
        cacheDir,
      );
      expect(verified.status).toBe(0);
      expect(verified.stderr).toContain("atlas verify");
      expect(readFileSync(dbPath).equals(before)).toBe(true);
      expect(statSync(dbPath).mtimeMs).toBe(beforeMtime);
      expect(sidecars.map((path) => existsSync(path))).toEqual([false, false]);

      const missing = join(dir, "missing");
      const refused = run(
        ["--atlas", "verify"],
        { ...process.env, AWWWARDS_MCP_ATLAS: "1" },
        missing,
      );
      expect(refused.status).toBe(1);
      expect(existsSync(missing)).toBe(false);

      const walDir = join(dir, "wal-cache");
      mkdirSync(walDir, { recursive: true });
      copyFileSync(dbPath, join(walDir, "cache.db"));
      writeFileSync(join(walDir, "cache.db-wal"), "");
      const walRefused = run(
        ["--atlas", "verify"],
        { ...process.env, AWWWARDS_MCP_ATLAS: "1" },
        walDir,
      );
      expect(walRefused.status).toBe(1);
      expect(existsSync(join(walDir, "cache.db-shm"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("capture fails at target resolution without launching the crawler", () => {
    const dir = mkdtempSync(join(tmpdir(), "awwwards-cli-atlas-"));
    try {
      const cacheDir = join(dir, "cache");
      const result = run(
        ["--atlas", "capture", "--slug", "missing-site", "--viewport", "desktop"],
        { ...process.env, AWWWARDS_MCP_ATLAS: "1" },
        cacheDir,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("capture desktop failed");
      expect(result.stderr).not.toContain("pages crawled");
      expect(result.stderr).not.toContain(cacheDir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "redacts a native-separator init error when AWWWARDS_CACHE_DIR uses slashes",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "awwwards-cli-atlas-"));
      try {
        const cacheDir = join(dir, "cache").replace(/\\/g, "/");
        writeFileSync(cacheDir, "not a directory");
        const result = run(
          ["--atlas", "reindex"],
          { ...process.env, AWWWARDS_MCP_ATLAS: "1" },
          cacheDir,
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("<cache>");
        expect(result.stderr).not.toContain(cacheDir);
        expect(result.stderr).not.toContain(cacheDir.replace(/\//g, "\\"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
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
