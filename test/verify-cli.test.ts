import { describe, expect, it } from "vitest";
import { runVerifyCli } from "../src/verify-cli.js";
import type { VerifyReport } from "../src/verify-build.js";
import type { RunVerifyCliIo } from "../src/verify-cli.js";

const report = (verdict: VerifyReport["verdict"]): VerifyReport => ({
  buildUrl: "https://build.test",
  referenceUrl: "https://ref.test",
  bands: {
    score: 90,
    matched: ["hero"],
    refOnly: [],
    buildOnly: [],
    diagnostics: [
      { referenceIndex: 0, buildIndex: 0, status: "matched", matchReason: "label", orderChanged: false, heightDeltaRatio: null, backgroundChanged: null },
    ],
  },
  motion: { score: 90, refFingerprint: "k1|tr:g1|nat:0|sc:0|pin:0|e:", buildFingerprint: "k1|tr:g1|nat:0|sc:0|pin:0|e:" },
  overall: 90,
  verdict,
  evidence: ["Bands: 90/100 similarity"],
});

interface Harness {
  lines: string[];
  calls: Array<{ buildUrl: string; referenceUrl: string; viewport?: string }>;
  run: (args: string[], result: VerifyReport | { error: string } | "throw") => Promise<number>;
}

const harness = (): Harness => {
  const lines: string[] = [];
  const calls: Array<{ buildUrl: string; referenceUrl: string; viewport?: string }> = [];
  const run = async (args: string[], result: VerifyReport | { error: string } | "throw") => {
    const io: RunVerifyCliIo = {
      args,
      write: (line) => lines.push(line),
      verifyBuildFn: async (a) => {
        calls.push(a);
        if (result === "throw") throw new Error("browser exploded");
        return result as VerifyReport | { error: string };
      },
    };
    return runVerifyCli(io);
  };
  return { lines, calls, run };
};

describe("runVerifyCli (C4, offline injected verifyBuildFn)", () => {
  it("pass → exit 0, exactly one machine-parseable JSON line", async () => {
    const h = harness();
    const code = await h.run(["https://build.test", "https://ref.test"], report("pass"));
    expect(code).toBe(0);
    expect(h.lines).toHaveLength(1);
    const parsed = JSON.parse(h.lines[0]);
    expect(parsed.verdict).toBe("pass");
    expect(parsed.overall).toBe(90);
    expect(h.calls[0]).toEqual({ buildUrl: "https://build.test", referenceUrl: "https://ref.test", viewport: undefined });
  });

  it("warn → exit 1; fail → exit 2", async () => {
    const warn = harness();
    expect(await warn.run(["https://b", "https://r"], report("warn"))).toBe(1);
    expect(JSON.parse(warn.lines[0]).verdict).toBe("warn");
    const fail = harness();
    expect(await fail.run(["https://b", "https://r"], report("fail"))).toBe(2);
    expect(JSON.parse(fail.lines[0]).verdict).toBe("fail");
  });

  it("{error} result → exit 3 with an {error} JSON line; thrown error → exit 3", async () => {
    const h = harness();
    const code = await h.run(["https://b", "https://r"], { error: "headless browser required" });
    expect(code).toBe(3);
    expect(JSON.parse(h.lines[0])).toEqual({ error: "headless browser required" });
    const thrown = harness();
    expect(await thrown.run(["https://b", "https://r"], "throw")).toBe(3);
    expect(JSON.parse(thrown.lines[0]).error).toContain("browser exploded");
  });

  it("usage errors → exit 4 with a JSON usage line (arg count, bad viewport, dangling flag)", async () => {
    const cases: string[][] = [
      [],
      ["https://only-one.test"],
      ["https://a.test", "https://b.test", "https://c.test"],
      ["https://a.test", "https://b.test", "--viewport", "tablet"],
      ["https://a.test", "https://b.test", "--viewport=fridge"],
      ["https://a.test", "https://b.test", "--viewport"],
    ];
    for (const args of cases) {
      const h = harness();
      const code = await h.run(args, report("pass"));
      expect(code).toBe(4);
      expect(h.lines).toHaveLength(1);
      expect(h.calls).toHaveLength(0);
      const parsed = JSON.parse(h.lines[0]);
      expect(parsed.error).toContain("usage: awwwards-verify");
    }
  });

  it("--viewport forms forward to verifyBuildFn (split and = forms)", async () => {
    const split = harness();
    await split.run(["https://b", "https://r", "--viewport", "mobile"], report("pass"));
    expect(split.calls[0].viewport).toBe("mobile");
    const eq = harness();
    await eq.run(["--viewport=desktop", "https://b", "https://r"], report("pass"));
    expect(eq.calls[0].viewport).toBe("desktop");
  });
});
