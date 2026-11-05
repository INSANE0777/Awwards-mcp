import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-cross-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TSX_CLI = join(__dirname, "../node_modules/tsx/dist/cli.mjs");
const WORKER = join(__dirname, "helpers", "atlas-commit-worker.ts");
const NOW = 1_700_000_000_000;

const runWorker = (root: string, fetchedAt: number) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [TSX_CLI, WORKER, root, String(fetchedAt)],
      { cwd: join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

describe("Atlas artifact publication across processes", () => {
  it("serializes two processes into one capture and one artifact", async () => {
    const root = tmpDir();
    const results = await Promise.all([
      runWorker(root, NOW),
      runWorker(root, NOW + 1000),
    ]);
    for (const result of results) {
      expect(result.code, result.stderr).toBe(0);
    }
    const payloads = results.map((result) => {
      expect(result.stdout, result.stderr).not.toBe("");
      return JSON.parse(result.stdout) as {
        captureId: string;
        artifactWritten: boolean;
      };
    });
    expect(payloads[0]!.captureId).toBe(payloads[1]!.captureId);
    expect(payloads.filter((payload) => payload.artifactWritten)).toHaveLength(1);

    const cache = new Cache(root, () => NOW, { atlas: true });
    expect(
      cache.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_captures").get() as { n: number }).n,
      ),
    ).toBe(1);
    expect(
      cache.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_artifacts").get() as { n: number }).n,
      ),
    ).toBe(1);
    expect(readdirSync(join(root, "atlas", "artifacts")).filter((f) => f.endsWith(".json"))).toHaveLength(1);
  }, 60_000);
});
