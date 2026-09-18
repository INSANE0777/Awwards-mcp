import { describe, expect, it } from "vitest";
import {
  buildUpdateNotice,
  compareVersions,
  parseVersion,
} from "../src/version-check.js";

describe("parseVersion", () => {
  it("splits semver into numeric triple", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("1.10.0")).toEqual([1, 10, 0]);
  });

  it("unparseable versions sort as oldest", () => {
    expect(parseVersion("garbage")).toEqual([0, 0, 0]);
  });
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.0.1", "1.0.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
  });
});

describe("buildUpdateNotice", () => {
  it("returns a notice when the registry version is newer", () => {
    const notice = buildUpdateNotice("1.0.0", "1.1.0", false);
    expect(notice).toContain("v1.1.0");
    expect(notice).toContain("v1.0.0");
    expect(notice).toContain("npm install -g awwwards-mcp@latest");
  });

  it("mentions the restart step when auto-update is enabled", () => {
    const notice = buildUpdateNotice("1.0.0", "1.1.0", true);
    expect(notice).toContain("restart your agent");
  });

  it("returns null when running the latest or newer", () => {
    expect(buildUpdateNotice("1.1.0", "1.1.0", false)).toBeNull();
    expect(buildUpdateNotice("2.0.0", "1.1.0", false)).toBeNull();
  });
});
