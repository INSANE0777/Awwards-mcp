import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  artifactIdentity,
  localArtifactLockCount,
  removeArtifactFile,
  resolveArtifactPath,
  withArtifactLock,
  writeJsonArtifact,
} from "../src/atlas/artifacts.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-artifacts-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HASH = "a".repeat(64);
const LINK_ERRORS = new Set(["EPERM", "EACCES", "ENOTSUP", "EINVAL", "UNKNOWN"]);

function linkOrSkip(
  ctx: { skip: () => void },
  target: string,
  path: string,
  type: "file" | "dir" | "junction",
): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (error) {
    if (LINK_ERRORS.has((error as NodeJS.ErrnoException).code ?? "")) {
      ctx.skip();
      return false;
    }
    throw error;
  }
}

describe("atlas artifacts", () => {
  it("writes a content-addressed artifact inside the cache root", async () => {
    const root = tmpDir();
    const value = { schemaVersion: "awwwards-atlas-source-v1", highlights: [] };
    const written = await writeJsonArtifact(root, value);

    expect(isAbsolute(written.storagePath)).toBe(false);
    expect(written.storagePath).toBe(join("atlas", "artifacts", `${written.sha256}.json`));
    expect(resolveArtifactPath(root, written.storagePath)).toBe(
      resolve(realpathSync.native(root), written.storagePath),
    );

    const text = readFileSync(resolveArtifactPath(root, written.storagePath), "utf8");
    expect(text).toBe(JSON.stringify(value));
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(written.sha256);
    expect(written.bytes).toBe(Buffer.byteLength(text, "utf8"));
  });

  it("rejects non-artifact, absolute, traversal, nested and empty paths", () => {
    const root = tmpDir();
    mkdirSync(join(root, "atlas", "artifacts"), { recursive: true });
    const unsafe = [
      "",
      "cache.db",
      "atlas/cache.db",
      "atlas/artifacts",
      "atlas/artifacts/",
      "..",
      "../escape.json",
      "atlas/../../escape.json",
      "atlas/artifacts/../cache.db",
      "atlas/artifacts/sub/escape.json",
      "/etc/passwd",
      "C:\\Windows\\win.ini",
      "..\\escape.json",
      "\\\\server\\share\\x",
      "atlas/artifacts/a\u0000b.json",
    ];
    for (const path of unsafe) {
      expect(() => resolveArtifactPath(root, path), path).toThrow(/invalid Atlas artifact path/);
    }
  });

  it("rejects a redirected atlas component that escapes the cache root", async (ctx) => {
    const root = tmpDir();
    const outside = tmpDir();
    if (
      !linkOrSkip(
        ctx,
        outside,
        join(root, "atlas"),
        process.platform === "win32" ? "junction" : "dir",
      )
    ) {
      return;
    }
    expect(() => resolveArtifactPath(root, join("atlas", "artifacts", `${HASH}.json`))).toThrow(
      /invalid Atlas artifact path/,
    );
    await expect(writeJsonArtifact(root, { escaped: true })).rejects.toThrow(
      /invalid Atlas artifact path/,
    );
  });

  it("rejects an internal atlas/artifacts junction targeting cache images", async (ctx) => {
    const root = tmpDir();
    const images = join(root, "images");
    mkdirSync(images);
    mkdirSync(join(root, "atlas"));
    if (
      !linkOrSkip(
        ctx,
        images,
        join(root, "atlas", "artifacts"),
        process.platform === "win32" ? "junction" : "dir",
      )
    ) {
      return;
    }
    expect(() => resolveArtifactPath(root, join("atlas", "artifacts", `${HASH}.json`))).toThrow(
      /invalid Atlas artifact path/,
    );
    await expect(writeJsonArtifact(root, { escaped: true })).rejects.toThrow(
      /invalid Atlas artifact path/,
    );
    expect(readdirSync(images)).toEqual([]);
  });

  it("rejects a symlinked artifact file that escapes the cache root", (ctx) => {
    const root = tmpDir();
    const outside = tmpDir();
    mkdirSync(join(root, "atlas", "artifacts"), { recursive: true });
    const outsideFile = join(outside, "outside.json");
    writeFileSync(outsideFile, "{}");
    if (
      !linkOrSkip(ctx, outsideFile, join(root, "atlas", "artifacts", `${HASH}.json`), "file")
    ) {
      return;
    }
    expect(() => resolveArtifactPath(root, join("atlas", "artifacts", `${HASH}.json`))).toThrow(
      /invalid Atlas artifact path/,
    );
  });

  it("handles concurrent identical writes without collisions or temp files", async () => {
    const root = tmpDir();
    const value = { schemaVersion: "awwwards-atlas-source-v1", concurrent: true };
    const writes = await Promise.all(
      Array.from({ length: 8 }, () => writeJsonArtifact(root, value)),
    );
    expect(new Set(writes.map((written) => written.storagePath)).size).toBe(1);
    expect(new Set(writes.map((written) => written.sha256)).size).toBe(1);
    const files = readdirSync(join(root, "atlas", "artifacts"));
    expect(files).toEqual([`${writes[0]!.sha256}.json`]);
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
  });

  it("serializes rollback cleanup before a second publisher reads or writes", async () => {
    const root = tmpDir();
    const value = { schemaVersion: "awwwards-atlas-source-v1", lock: true };
    const storagePath = artifactIdentity(value).storagePath;
    const events: string[] = [];
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const first = withArtifactLock(root, storagePath, async () => {
      await writeJsonArtifact(root, value, { lock: false });
      events.push("a-write");
      releaseStarted();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await removeArtifactFile(root, storagePath);
      events.push("a-delete");
    });
    await started;
    const second = withArtifactLock(root, storagePath, async () => {
      events.push("b-enter");
      const written = await writeJsonArtifact(root, value, { lock: false });
      expect(written.created).toBe(true);
      events.push("b-write");
    });
    await Promise.all([first, second]);
    expect(events).toEqual(["a-write", "a-delete", "b-enter", "b-write"]);
    expect(resolveArtifactPath(root, storagePath)).toEqual(
      resolve(realpathSync.native(root), storagePath),
    );
  });

  it("releases local lock queue entries after serial commits", async () => {
    const root = tmpDir();
    for (let index = 0; index < 12; index += 1) {
      await withArtifactLock(
        root,
        join("atlas", "artifacts", `queue-${index}.json`),
        async () => undefined,
      );
    }
    expect(localArtifactLockCount()).toBe(0);
  });

  it("accepts a normal relative artifact path", () => {
    const root = tmpDir();
    mkdirSync(join(root, "atlas", "artifacts"), { recursive: true });
    expect(resolveArtifactPath(root, "atlas/artifacts/abc.json")).toBe(
      resolve(realpathSync.native(root), "atlas", "artifacts", "abc.json"),
    );
  });
});
