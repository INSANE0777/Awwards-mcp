import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateRegistryMetadata } from "../scripts/registry-gate.mjs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const server = JSON.parse(readFileSync("server.json", "utf8"));
const clone = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("registry metadata", () => {
  it("keeps package.json and server.json in lockstep", () => {
    expect(validateRegistryMetadata(pkg, server)).toEqual([]);
  });

  it("rejects a mismatched mcpName, version, package or transport", () => {
    for (const mutate of [
      (next: any) => (next.mcpName = "io.github.someone-else/other"),
      (next: any) => (next.version = "9.9.9"),
    ]) {
      const next = clone(pkg);
      mutate(next);
      expect(validateRegistryMetadata(next, clone(server)).length).toBeGreaterThan(0);
    }

    for (const mutate of [
      (next: any) => (next.packages[0].identifier = "other-package"),
      (next: any) => (next.packages[0].version = "9.9.9"),
      (next: any) => (next.packages[0].transport.type = "http"),
    ]) {
      const next = clone(server);
      mutate(next);
      expect(validateRegistryMetadata(clone(pkg), next).length).toBeGreaterThan(0);
    }
  });

  it("rejects missing required values instead of comparing undefined", () => {
    const missingPkg = clone(pkg);
    delete missingPkg.version;
    delete missingPkg.name;
    delete missingPkg.description;
    const missingServer = clone(server);
    delete missingServer.version;
    delete missingServer.description;
    delete missingServer.packages[0].identifier;
    delete missingServer.packages[0].version;
    expect(validateRegistryMetadata(missingPkg, missingServer).length).toBeGreaterThan(0);
  });

  it("rejects schema-invalid names, versions and latest", () => {
    const longName = clone(pkg);
    longName.mcpName = `io.github.${"a".repeat(185)}/x`;
    longName.mcpName = longName.mcpName.slice(0, 201);
    expect(validateRegistryMetadata(longName, clone(server)).length).toBeGreaterThan(0);

    const longVersion = clone(server);
    longVersion.version = "1".repeat(256);
    expect(validateRegistryMetadata(clone(pkg), longVersion).length).toBeGreaterThan(0);

    const latest = clone(server);
    latest.version = "latest";
    latest.packages[0].version = "latest";
    expect(validateRegistryMetadata(clone(pkg), latest).length).toBeGreaterThan(0);
  });

  it("rejects an overlong description and a fabricated schema URL", () => {
    const longDescription = clone(pkg);
    longDescription.description = "x".repeat(101);
    expect(validateRegistryMetadata(longDescription, clone(server)).length).toBeGreaterThan(0);

    const fakeSchema = clone(server);
    fakeSchema.$schema = "https://static.modelcontextprotocol.io/schemas/not-real/server.schema.json";
    expect(validateRegistryMetadata(pkg, fakeSchema).length).toBeGreaterThan(0);
  });

  it("rejects a non-string or malformed websiteUrl", () => {
    for (const websiteUrl of [42, "not a url", null]) {
      const next = clone(server);
      next.websiteUrl = websiteUrl;
      expect(validateRegistryMetadata(pkg, next).length).toBeGreaterThan(0);
    }
  });

  it("rejects a mismatched server name or repository", () => {
    const wrongName = clone(server);
    wrongName.name = "io.github.someone-else/awwwards-mcp";
    expect(validateRegistryMetadata(pkg, wrongName).length).toBeGreaterThan(0);

    const wrongRepo = clone(server);
    wrongRepo.repository.url = "https://github.com/someone-else/other";
    expect(validateRegistryMetadata(pkg, wrongRepo).length).toBeGreaterThan(0);
  });
});
