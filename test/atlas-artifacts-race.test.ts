import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: () => "fixed-temp-id" };
});

import { writeJsonArtifact } from "../src/atlas/artifacts.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-artifact-race-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("artifact temp ownership", () => {
  it("does not delete a file when exclusive temp creation fails", async () => {
    const root = tmpDir();
    const value = { schemaVersion: "awwwards-atlas-source-v1" };
    const text = JSON.stringify(value);
    const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
    const dir = join(root, "atlas", "artifacts");
    mkdirSync(dir, { recursive: true });
    const temp = join(dir, `${sha256}.json.${process.pid}.fixed-temp-id.tmp`);
    writeFileSync(temp, "unowned");

    await expect(writeJsonArtifact(root, value)).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(temp, "utf8")).toBe("unowned");
  });
});
