import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import { createHandlers } from "../src/server.js";
import { createServer } from "../src/server-instance.js";
import { compactVerifyReport } from "../src/server/types.js";
import { verifyBuildOutputSchema } from "../src/verify-contracts.js";
import type { BandDiagnostic, VerifyReport } from "../src/verify-build.js";

const dirs: string[] = [];
const tmpDir = () => {
  const d = mkdtempSync(join(tmpdir(), "awwwards-verify-contracts-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const acquisition = {
  waitStrategy: "networkidle" as const,
  settleMs: 3000,
  postScrollMs: 500,
  capturedAt: 1_793_537_000_000,
  documentHeight: 5000,
  animationCount: 1,
  gsapRegistryCount: 1,
  stable: true as boolean | null,
};

const diagnostics: BandDiagnostic[] = [
  { referenceIndex: 0, buildIndex: 0, status: "matched", matchReason: "label", orderChanged: false, heightDeltaRatio: 0.05, backgroundChanged: false },
  { referenceIndex: 1, buildIndex: 1, status: "matched", matchReason: "height", orderChanged: false, heightDeltaRatio: null, backgroundChanged: null },
  { referenceIndex: 2, buildIndex: null, status: "reference-only", matchReason: null, orderChanged: false, heightDeltaRatio: null, backgroundChanged: null },
  { referenceIndex: null, buildIndex: 2, status: "build-only", matchReason: null, orderChanged: false, heightDeltaRatio: null, backgroundChanged: null },
];

const fullReport = (): VerifyReport => ({
  buildUrl: "https://b.test/",
  referenceUrl: "https://r.test/",
  bands: {
    score: 67,
    matched: ["hero", "main"],
    refOnly: ["footer"],
    buildOnly: ["cta"],
    diagnostics,
  },
  motion: {
    score: 64,
    refFingerprint: "k1|tr:g3,c0,v0,d0,k2,s0|nat:1|sc:2|pin:1|e:power2.out",
    buildFingerprint: "k1|tr:g2,c0,v0,d0,k2,s0|nat:1|sc:2|pin:1|e:power2.out",
    acquisition: { reference: acquisition, build: { ...acquisition, stable: false } },
  },
  overall: 66,
  verdict: "warn",
  evidence: ["Bands: 67/100 similarity", "Motion: 64/100 fingerprint similarity", "Overall: 66/100 → WARN"],
});

const handlersFor = (result: VerifyReport | { error: string }) =>
  createHandlers({
    client: {} as any,
    cache: new Cache(tmpDir()),
    verifyBuildFn: async () => result,
  } as any);

const serverFor = (handlers: ReturnType<typeof handlersFor>) =>
  createServer({ handlers, version: "0.0.0-test" }) as any;

const validate = (server: any, result: unknown) =>
  server.validateToolOutput(server._registeredTools.verify_build, result, "verify_build");

function withResponseLimit<T>(bytes: number | undefined, fn: () => T): T {
  const saved = process.env.AWWWARDS_MCP_MAX_RESPONSE_BYTES;
  const savedLegacy = process.env.AWARDS_MCP_MAX_RESPONSE_BYTES;
  if (bytes === undefined) delete process.env.AWWWARDS_MCP_MAX_RESPONSE_BYTES;
  else process.env.AWWWARDS_MCP_MAX_RESPONSE_BYTES = String(bytes);
  delete process.env.AWARDS_MCP_MAX_RESPONSE_BYTES;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.AWWWARDS_MCP_MAX_RESPONSE_BYTES;
    else process.env.AWWWARDS_MCP_MAX_RESPONSE_BYTES = saved;
    if (savedLegacy === undefined) delete process.env.AWARDS_MCP_MAX_RESPONSE_BYTES;
    else process.env.AWARDS_MCP_MAX_RESPONSE_BYTES = savedLegacy;
  }
}

describe("verify_build output contract", () => {
  it("validates the full report and keeps the pretty-JSON text unchanged", async () => {
    const report = fullReport();
    const h = handlersFor(report);
    const res = await h.verify_build({
      buildUrl: report.buildUrl,
      referenceUrl: report.referenceUrl,
    });

    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual([{ type: "text", text: JSON.stringify(report, null, 1) }]);
    expect(res.structuredContent).toEqual(report);
    expect(verifyBuildOutputSchema.safeParse(res.structuredContent).success).toBe(true);
    await expect(validate(serverFor(h), res)).resolves.toBeUndefined();
  });

  it("validates the compact report, keeps counts and omits diagnostics", async () => {
    const report = fullReport();
    const expected = compactVerifyReport(report);
    const h = handlersFor(report);
    const res = await h.verify_build({
      buildUrl: report.buildUrl,
      referenceUrl: report.referenceUrl,
      compact: true,
    });

    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual([{ type: "text", text: JSON.stringify(expected, null, 1) }]);
    expect(res.structuredContent).toEqual(expected);
    expect(res.structuredContent?.bands).toEqual({ score: 67, matched: 2, refOnly: 1, buildOnly: 1 });
    expect("diagnostics" in (res.structuredContent as any).bands).toBe(false);
    expect(verifyBuildOutputSchema.safeParse(res.structuredContent).success).toBe(true);
    await expect(validate(serverFor(h), res)).resolves.toBeUndefined();
  });

  it("validates optional domDiff and scene3d blocks on both shapes", async () => {
    const report: VerifyReport = {
      ...fullReport(),
      domDiff: { missing: [], extra: [], reordered: [], rectDrift: [], incomplete: false },
      scene3d: { status: "inconclusive", verdict: "inconclusive" } as any,
    };
    const h = handlersFor(report);

    const full = await h.verify_build({
      buildUrl: report.buildUrl,
      referenceUrl: report.referenceUrl,
    });
    expect(verifyBuildOutputSchema.safeParse(full.structuredContent).success).toBe(true);
    await expect(validate(serverFor(h), full)).resolves.toBeUndefined();

    const compact = await h.verify_build({
      buildUrl: report.buildUrl,
      referenceUrl: report.referenceUrl,
      compact: true,
    });
    expect((compact.structuredContent as any).scene3d).toEqual(report.scene3d);
    expect("domDiff" in (compact.structuredContent as any)).toBe(false);
    expect(verifyBuildOutputSchema.safeParse(compact.structuredContent).success).toBe(true);
    await expect(validate(serverFor(h), compact)).resolves.toBeUndefined();
  });

  it("keeps errors as isError with no structured success payload", async () => {
    const h = handlersFor({ error: "reference is blocked" });
    const res = await h.verify_build({
      buildUrl: "https://b.test/",
      referenceUrl: "https://r.test/",
    });

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    expect((res.content[0] as any).text).toBe("reference is blocked");
    // The SDK skips output validation for isError results.
    await expect(validate(serverFor(h), res)).resolves.toBeUndefined();
  });

  it("rejects malformed payloads at the schema and SDK boundaries", async () => {
    expect(verifyBuildOutputSchema.safeParse({}).success).toBe(false);
    expect(
      verifyBuildOutputSchema.safeParse({ ...fullReport(), verdict: "great" }).success,
    ).toBe(false);
    const { diagnostics: _dropped, ...bandsWithoutDiagnostics } = fullReport().bands;
    expect(
      verifyBuildOutputSchema.safeParse({ ...fullReport(), bands: bandsWithoutDiagnostics }).success,
    ).toBe(false);
    expect(
      verifyBuildOutputSchema.safeParse({ ...fullReport(), bands: compactVerifyReport(fullReport()).bands }).success,
    ).toBe(false);
    expect(
      verifyBuildOutputSchema.safeParse({ ...compactVerifyReport(fullReport()), overall: "66" }).success,
    ).toBe(false);
    expect(
      verifyBuildOutputSchema.safeParse({ ...compactVerifyReport(fullReport()), referenceUrl: "https://r.test/" }).success,
    ).toBe(false);
    expect(
      verifyBuildOutputSchema.safeParse({
        ...fullReport(),
        bands: { ...fullReport().bands, diagnostics: [{ ...diagnostics[0], status: "unknown" }] },
      }).success,
    ).toBe(false);

    const h = handlersFor({ ...fullReport(), verdict: "great" } as unknown as VerifyReport);
    const res = await h.verify_build({
      buildUrl: "https://b.test/",
      referenceUrl: "https://r.test/",
    });
    expect(res.isError).toBeUndefined();
    await expect(validate(serverFor(h), res)).rejects.toThrow(/Output validation error/);
  });

  it("drops structuredContent when the response exceeds the byte ceiling", async () => {
    const report = fullReport();
    const h = handlersFor(report);
    const server = withResponseLimit(512, () => serverFor(h));
    const result = await server._registeredTools.verify_build.executor(
      { buildUrl: report.buildUrl, referenceUrl: report.referenceUrl },
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ truncated: true, tool: "verify_build" });
    // A truncated success cannot validate, so the guard marks it isError.
    await expect(validate(server, result)).resolves.toBeUndefined();
  });
});
