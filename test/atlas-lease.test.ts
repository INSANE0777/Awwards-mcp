import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireAtlasCaptureLease, releaseAtlasCaptureLease } from "../src/atlas/lease.js";

const TSX_CLI = join(__dirname, "../node_modules/tsx/dist/cli.mjs");
const WORKER = join(__dirname, "helpers", "atlas-lease-worker.ts");
const runWorker = (root: string, token: string, env: NodeJS.ProcessEnv = {}) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, WORKER, root, token], {
      cwd: join(__dirname, ".."),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) =>
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)),
    );
  });

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-lease-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Atlas capture lease", () => {
  it("rejects a second owner and releases only the current token", () => {
    const root = tmpDir();
    const lease = acquireAtlasCaptureLease(root, { token: "owner-a" });
    expect(() => acquireAtlasCaptureLease(root, { token: "owner-b" })).toThrow(
      /Another Atlas capture owns this cache/,
    );
    const impostor = { ...lease, token: "owner-b" };
    expect(releaseAtlasCaptureLease(impostor)).toBe(false);
    expect(() => acquireAtlasCaptureLease(root, { token: "owner-b" })).toThrow();
    releaseAtlasCaptureLease(lease);
    expect(() => acquireAtlasCaptureLease(root, { token: "owner-b" })).not.toThrow();
  });

  it("reclaims an expired lease", () => {
    const root = tmpDir();
    acquireAtlasCaptureLease(root, { token: "old", ttlMs: 1, now: 1_000 });
    const lease = acquireAtlasCaptureLease(root, { token: "new", now: 1_000_000 });
    expect(lease.token).toBe("new");
    releaseAtlasCaptureLease(lease);
  });

  it("grants exactly one owner with a forced read-before-write interleaving", async () => {
    const root = tmpDir();
    const results = await Promise.all([
      runWorker(root, "pause-a", { ATLAS_LEASE_AFTER_READ_MS: "300" }),
      runWorker(root, "pause-b", { ATLAS_LEASE_AFTER_READ_MS: "300" }),
    ]);
    const parsed = results.map((line) => JSON.parse(line) as { ok: boolean; code?: string });
    expect(parsed.filter((item) => item.ok)).toHaveLength(1);
    expect(parsed.filter((item) => !item.ok)).toEqual([
      expect.objectContaining({ code: "CAPTURE_BUSY" }),
    ]);
  });

  it("quarantines a garbage lease database and recovers", () => {
    const root = tmpDir();
    const path = join(root, "atlas", "capture-lease.db");
    mkdirSync(join(root, "atlas"), { recursive: true });
    writeFileSync(path, Buffer.from("not a sqlite database"));
    const lease = acquireAtlasCaptureLease(root, { token: "recovered" });
    expect(lease.token).toBe("recovered");
    expect(releaseAtlasCaptureLease(lease)).toBe(true);
    expect(
      readdirSync(join(root, "atlas")).some((name) => name.includes(".corrupt-")),
    ).toBe(true);
  });

  it("rejects a lease schema without a primary key", () => {
    const root = tmpDir();
    const path = join(root, "atlas", "capture-lease.db");
    mkdirSync(join(root, "atlas"), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE atlas_capture_lease (singleton INTEGER, token TEXT, expires_at INTEGER)",
    );
    db.close();
    const lease = acquireAtlasCaptureLease(root, { token: "pk" });
    expect(lease.token).toBe("pk");
    expect(releaseAtlasCaptureLease(lease)).toBe(true);
  });

  it("reports an unopenable lease path distinctly", () => {
    const root = tmpDir();
    const path = join(root, "atlas", "capture-lease.db");
    mkdirSync(path, { recursive: true });
    expect(() => acquireAtlasCaptureLease(root, { token: "dir" })).toThrow(
      expect.objectContaining({ code: "CAPTURE_LEASE_UNAVAILABLE" }),
    );
  });

  it("quarantines an incompatible lease schema and recovers", () => {
    const root = tmpDir();
    const path = join(root, "atlas", "capture-lease.db");
    mkdirSync(join(root, "atlas"), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE atlas_capture_lease (wrong TEXT)");
    db.close();
    const lease = acquireAtlasCaptureLease(root, { token: "schema" });
    expect(lease.token).toBe("schema");
    expect(releaseAtlasCaptureLease(lease)).toBe(true);
  });

  it("serializes concurrent recovery of a corrupt lease database", async () => {
    const root = tmpDir();
    mkdirSync(join(root, "atlas"), { recursive: true });
    writeFileSync(join(root, "atlas", "capture-lease.db"), "corrupt");
    const results = await Promise.all([
      runWorker(root, "corrupt-a"),
      runWorker(root, "corrupt-b"),
    ]);
    const parsed = results.map((line) => JSON.parse(line) as { ok: boolean });
    expect(parsed.filter((item) => item.ok)).toHaveLength(1);
  });

  it("grants exactly one owner to concurrent processes", async () => {
    const root = tmpDir();
    const results = await Promise.all([
      runWorker(root, "process-a"),
      runWorker(root, "process-b"),
    ]);
    const parsed = results.map((line) => JSON.parse(line) as { ok: boolean; token?: string });
    expect(parsed.filter((item) => item.ok)).toHaveLength(1);
    expect(parsed.filter((item) => !item.ok)).toHaveLength(1);
    expect(parsed.find((item) => item.ok)?.token).toMatch(/^process-[ab]$/);
  });
});
