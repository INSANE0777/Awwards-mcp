import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

describe("parser-drift probe taxonomy verdicts", () => {
  it("runs the real parseCategories over the committed listing fixture", () => {
    const res = spawnSync(
      process.execPath,
      [join(ROOT, "scripts", "parser-drift-probe.mjs"), "--fixture"],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(res.status, res.stderr).toBe(0);
    // Counts the real parser returns today; a fixture or parser change that
    // collapses the taxonomy must fail here instead of passing silently.
    expect(res.stdout).toContain("parseCategories[filters] (195 filters)");
    expect(res.stdout).toContain("parseCategories[colors] (27 colors)");
    expect(res.stdout).toContain("parseCategories[Technology nav] (115 technologies)");
  });
});
