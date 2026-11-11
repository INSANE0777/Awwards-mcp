import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addCheck,
  createReport,
  exitCodeFor,
  finalizeReport,
  normalizeCheckOutcome,
  renderHumanSummary,
  validateReport,
} from "../scripts/qualify/report.mjs";
import {
  ATLAS_FULL_TOOLS,
  analyzeAnnotations,
  analyzeBranches,
  analyzeSurface,
  analyzeSurfaceDelta,
  baselineToolsFor,
  browserQualification,
  classifyToolResult,
  expectedCount,
  extractBranchKinds,
  outputAdvertisesAtlasStatus,
  parseErrorCode,
  probeStatus,
} from "../scripts/qualify/expectations.mjs";
import { buildChildEnv, cacheFingerprint, sameCacheFingerprint } from "../scripts/qualify/child-env.mjs";
import { checkDistFreshness } from "../scripts/qualify/freshness.mjs";
import { classifyFlagOffProbe, classifyFlagOnProbe } from "../scripts/qualify/cli-probe.mjs";
import { startMcpClient } from "../scripts/qualify/mcp-client.mjs";

const STARTED = "2026-01-01T00:00:00.000Z";
const FINISHED = "2026-01-01T00:00:01.000Z";
const fakeServer = fileURLToPath(new URL("./fixtures/qualify/fake-mcp-server.mjs", import.meta.url));

function reportWith(checks: Array<Record<string, unknown>>, qualificationScope = "full") {
  const report = createReport({ startedAt: STARTED, qualificationScope });
  for (const check of checks) addCheck(report, check as never);
  return finalizeReport(report, { finishedAt: FINISHED, qualificationScope });
}

function pass(id: string, required = true) {
  return { id, group: "g", required, status: "PASS", reason: "evidence" };
}

function skip(id: string, required: boolean) {
  return { id, group: "g", required, status: "SKIP", reason: "not installed" };
}

function fail(id: string) {
  return { id, group: "g", required: true, status: "FAIL", reason: "expected 45, got 41" };
}

// A realistic profile list: contract anchors followed by unique fillers.
function surfaceNames(profile: string, total: number, extra: string[] = []) {
  const base = [...(baselineToolsFor(profile) as string[])];
  const fillers = Array.from(
    { length: total - base.length - extra.length },
    (_, index) => `filler_${profile}_${index}`,
  );
  return [...base, ...fillers, ...extra];
}

describe("qualification report", () => {
  it("counts statuses and passes only when no required check was skipped", () => {
    const report = reportWith([pass("artifact.pack"), skip("browser.fixture", false)]);
    expect(report.summary).toMatchObject({ pass: 1, fail: 0, skip: 1, status: "PASS", exitCode: 0 });
    expect(exitCodeFor(report)).toBe(0);
  });

  it("is INCOMPLETE when a required check is skipped", () => {
    const report = reportWith([pass("artifact.pack"), skip("cli.reindex.refusal", true)]);
    expect(report.summary.status).toBe("INCOMPLETE");
    expect(exitCodeFor(report)).toBe(2);
  });

  it("never reports an offline run as PASS, even when every attempted check passed", () => {
    const report = reportWith([pass("artifact.pack"), skip("browser.atlas_capture", false)], "offline-installed");
    expect(report.summary).toMatchObject({
      pass: 1,
      fail: 0,
      skip: 1,
      status: "INCOMPLETE",
      exitCode: 2,
      qualificationScope: "offline-installed",
    });
  });

  it("requires an explicit status; a bare reason is not a PASS", () => {
    expect(normalizeCheckOutcome({ reason: "looked fine" })).toMatchObject({ status: "FAIL" });
    expect(normalizeCheckOutcome({ reason: "looked fine" }).reason).toMatch(/without a status/);
    expect(normalizeCheckOutcome({ status: "GREEN" })).toMatchObject({ status: "FAIL" });
    expect(normalizeCheckOutcome({ status: "PASS", reason: "evidence" }).status).toBe("PASS");
    expect(normalizeCheckOutcome(undefined)).toMatchObject({ status: "FAIL" });
  });

  it("fails ahead of an incomplete surface", () => {
    const report = reportWith([pass("artifact.pack"), fail("surface.full.flag_on"), skip("cli.reindex.refusal", true)]);
    expect(report.summary).toMatchObject({ fail: 1, status: "FAIL", exitCode: 1 });
    expect(report.summary.blockers).toEqual([
      { id: "surface.full.flag_on", reason: "expected 45, got 41" },
    ]);
    expect(report.summary.unqualified).toHaveLength(1);
  });

  it("validates its own finalized report", () => {
    const report = reportWith([pass("artifact.pack")]);
    expect(validateReport(report)).toEqual([]);
  });

  it("rejects tampered counts and mismatched blockers", () => {
    const report = reportWith([pass("artifact.pack"), fail("surface.full.flag_on")]);
    report.summary.pass = 2;
    report.summary.blockers = [];
    const errors = validateReport(report);
    expect(errors.join("\n")).toMatch(/summary\.pass/);
    expect(errors.join("\n")).toMatch(/summary\.blockers/);
  });

  it("rejects duplicate ids, empty reasons and unknown statuses", () => {
    const report = createReport({ startedAt: STARTED });
    addCheck(report, pass("artifact.pack") as never);
    expect(() => addCheck(report, pass("artifact.pack") as never)).toThrow(/duplicate/);
    expect(() =>
      addCheck(report, { ...pass("artifact.install"), reason: "  " } as never),
    ).toThrow(/empty reason/);
    expect(() =>
      addCheck(report, { ...pass("artifact.build"), status: "GREEN" } as never),
    ).toThrow(/invalid status/);
  });

  it("renders check reasons and marks optional skips", () => {
    const report = reportWith([pass("artifact.pack"), skip("browser.fixture", false)]);
    const text = renderHumanSummary(report);
    expect(text).toContain("installed-qualification: PASS");
    expect(text).toContain("scope: full");
    expect(text).toContain("[PASS] artifact.pack — evidence");
    expect(text).toContain("[SKIP] browser.fixture (optional) — not installed");
  });
});

describe("surface expectations", () => {
  it("freezes the flag-off and flag-on counts", () => {
    expect(expectedCount(false, "full")).toBe(41);
    expect(expectedCount(false, "core")).toBe(13);
    expect(expectedCount(false, "v2")).toBe(15);
    expect(expectedCount(true, "full")).toBe(45);
    expect(expectedCount(true, "core")).toBe(13);
    expect(expectedCount(true, "v2")).toBe(16);
  });

  it("accepts the default surface and rejects an early Atlas tool", () => {
    expect(analyzeSurface({ flagOn: false, profile: "full", names: surfaceNames("full", 41) }).ok).toBe(true);
    const analysis = analyzeSurface({
      flagOn: false,
      profile: "full",
      names: surfaceNames("full", 41, ["search_atlas"]),
    });
    expect(analysis.ok).toBe(false);
    expect(analysis.problems.join("\n")).toMatch(/unexpected Atlas tool/);
  });

  it("requires the four full tools only when the flag is on", () => {
    const enabled = surfaceNames("full", 45, [
      "search_atlas",
      "get_atlas",
      "capture_atlas",
      "export_evidence_pack",
    ]);
    expect(analyzeSurface({ flagOn: true, profile: "full", names: enabled }).ok).toBe(true);
    const missing = analyzeSurface({ flagOn: true, profile: "full", names: surfaceNames("full", 45) });
    expect(missing.ok).toBe(false);
    expect(missing.problems.join("\n")).toMatch(/missing Atlas tool: search_atlas/);
  });

  it("adds only export_evidence_pack to v2 and nothing to core", () => {
    const v2 = surfaceNames("v2", 16, ["export_evidence_pack"]);
    expect(analyzeSurface({ flagOn: true, profile: "v2", names: v2 }).ok).toBe(true);
    const core = surfaceNames("core", 13);
    core[core.length - 1] = "search_atlas";
    const analysis = analyzeSurface({ flagOn: true, profile: "core", names: core });
    expect(analysis.ok).toBe(false);
    expect(analysis.problems.join("\n")).toMatch(/unexpected Atlas tool/);
  });

  it("rejects duplicate tool names", () => {
    const list = surfaceNames("full", 41);
    list[list.length - 1] = list[0]!;
    const analysis = analyzeSurface({ flagOn: false, profile: "full", names: list });
    expect(analysis.duplicates).toEqual([list[0]]);
    expect(analysis.ok).toBe(false);
  });

  it("rejects a swapped baseline tool even when the count matches", () => {
    const list = surfaceNames("full", 41);
    list[0] = "filler_replacement";
    const analysis = analyzeSurface({ flagOn: false, profile: "full", names: list });
    expect(analysis.ok).toBe(false);
    expect(analysis.problems.join("\n")).toMatch(/missing baseline tool/);
  });

  it("requires flag-on to equal flag-off plus the Atlas tools", () => {
    const off = surfaceNames("full", 41);
    const on = [...off, ...ATLAS_FULL_TOOLS];
    expect(analyzeSurface({ flagOn: true, profile: "full", names: on }).ok).toBe(true);
    expect(analyzeSurfaceDelta({ profile: "full", offNames: off, onNames: on }).ok).toBe(true);
  });

  it("rejects a non-anchor swap that the count and anchors cannot see", () => {
    const off = surfaceNames("full", 41);
    const on = [...off, ...ATLAS_FULL_TOOLS];
    const filler = on.findIndex((name) => name.startsWith("filler_"));
    on[filler] = "non_anchor_replacement";
    // Count (45) and the 13 anchors still pass; only the delta check catches it.
    expect(analyzeSurface({ flagOn: true, profile: "full", names: on }).ok).toBe(true);
    const delta = analyzeSurfaceDelta({ profile: "full", offNames: off, onNames: on });
    expect(delta.ok).toBe(false);
    expect(delta.missing).toContain(off[filler]);
    expect(delta.unexpected).toContain("non_anchor_replacement");
  });

  it("keeps core identical across the flag and adds only export to v2", () => {
    const core = surfaceNames("core", 13);
    expect(analyzeSurfaceDelta({ profile: "core", offNames: core, onNames: core }).ok).toBe(true);
    const v2Off = surfaceNames("v2", 15);
    const v2On = [...v2Off, "export_evidence_pack"];
    expect(analyzeSurfaceDelta({ profile: "v2", offNames: v2Off, onNames: v2On }).ok).toBe(true);
    expect(
      analyzeSurfaceDelta({ profile: "v2", offNames: v2Off, onNames: [...v2On, "search_atlas"] }).ok,
    ).toBe(false);
  });
});

describe("v2 branch schemas", () => {
  const schema = {
    properties: {
      request: {
        oneOf: [
          { properties: { kind: { const: "sites" } } },
          { properties: { kind: { const: "sections" } } },
        ],
      },
    },
  };

  it("extracts const and enum discriminants", () => {
    expect(extractBranchKinds(schema)).toEqual(["sections", "sites"]);
    expect(extractBranchKinds({ anyOf: [{ properties: { kind: { enum: ["atlas_status"] } } }] })).toEqual([
      "atlas_status",
    ]);
  });

  it("requires Atlas branches in both flag states", () => {
    const enabled = analyzeBranches({ flagOn: true, schema, tool: "search_references" });
    expect(enabled.ok).toBe(false);
    expect(enabled.missing).toEqual(["components"]);
    const disabled = analyzeBranches({ flagOn: false, schema, tool: "search_references" });
    expect(disabled.ok).toBe(false);
    expect(disabled.missing).toEqual(["components"]);
  });

  it("requires Atlas branches even when the flag is off", () => {
    const clean = analyzeBranches({
      flagOn: false,
      schema: { properties: { request: { oneOf: [{ properties: { kind: { const: "sites" } } }] } } },
      tool: "search_references",
    });
    expect(clean.ok).toBe(false);
    expect(clean.missing).toEqual(["sections", "components"]);
  });

  it("inspects the atlas_status discriminant, not the word atlas", () => {
    expect(
      outputAdvertisesAtlasStatus({ anyOf: [{ properties: { kind: { const: "atlas_status" } } }] }),
    ).toBe(true);
    expect(
      outputAdvertisesAtlasStatus({
        type: "object",
        properties: {
          schemaVersion: { type: "string", const: "awwwards-atlas-v1" },
          operation: { type: "string" },
        },
      }),
    ).toBe(true);
    expect(
      outputAdvertisesAtlasStatus({ description: "returns atlas status when the flag is enabled" }),
    ).toBe(false);
    expect(
      outputAdvertisesAtlasStatus({
        properties: { schemaVersion: { type: "string", const: "awwwards-atlas-evidence-pack-v1" } },
      }),
    ).toBe(false);
  });
});

describe("Atlas annotations", () => {
  const full = [
    { name: "search_atlas", annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
    { name: "get_atlas", annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
    { name: "capture_atlas", annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true } },
    { name: "export_evidence_pack", annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false } },
  ];
  const v2 = [
    { name: "search_references", annotations: { readOnlyHint: true } },
    { name: "get_reference", annotations: { readOnlyHint: true } },
    { name: "get_index", annotations: { readOnlyHint: true } },
    { name: "capture_page", annotations: { readOnlyHint: false } },
  ];

  it("accepts the spec 11.6 annotation table", () => {
    expect(analyzeAnnotations({ fullTools: full, v2Tools: v2 })).toMatchObject({ ok: true, problems: [] });
  });

  it("rejects capture_page advertising all branches as read-only", () => {
    const tools = v2.map((tool) =>
      tool.name === "capture_page" ? { name: "capture_page", annotations: { readOnlyHint: true } } : tool,
    );
    const result = analyzeAnnotations({ fullTools: full, v2Tools: tools });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/capture_page: readOnlyHint/);
  });

  it("rejects capture_atlas marked read-only or closed-world", () => {
    const tools = full.map((tool) =>
      tool.name === "capture_atlas"
        ? { name: "capture_atlas", annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true } }
        : tool,
    );
    const result = analyzeAnnotations({ fullTools: tools, v2Tools: v2 });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/capture_atlas: readOnlyHint/);
  });

  it("rejects a missing Atlas tool or missing annotations", () => {
    expect(
      analyzeAnnotations({ fullTools: full.filter((tool) => tool.name !== "get_atlas"), v2Tools: v2 }).problems.join("\n"),
    ).toMatch(/get_atlas is not advertised/);
    expect(
      analyzeAnnotations({
        fullTools: full.map((tool) => (tool.name === "get_atlas" ? { name: "get_atlas" } : tool)),
        v2Tools: v2,
      }).problems.join("\n"),
    ).toMatch(/no annotations/);
  });
});

describe("probe status", () => {
  const ok = { kind: "ok", text: "{}" };
  const domain = (text: string) => ({ kind: "domain_error", text });

  it("passes ok and spec-defined domain codes", () => {
    expect(probeStatus(ok).status).toBe("PASS");
    expect(probeStatus(domain('{"code":"SEARCH_NOT_READY","message":"indexing"}')).status).toBe("PASS");
    expect(probeStatus(domain("ATLAS_DISABLED: no"), { expectDomain: true }).status).toBe("FAIL");
    expect(probeStatus(domain('{"code":"FEATURE_DISABLED"}'), { expectDomain: true }).status).toBe("FAIL");
  });

  it("rejects an unknown code or a raw exception with no code", () => {
    expect(probeStatus(domain('{"code":"SOMETHING_ELSE","message":"boom"}')).status).toBe("FAIL");
    expect(probeStatus(domain("TypeError: Cannot read properties of undefined")).status).toBe("FAIL");
    expect(probeStatus(domain("awwwards-mcp request failed: boom")).status).toBe("FAIL");
  });

  it("requires the exact private-destination refusal", () => {
    expect(probeStatus(domain('{"code":"PRIVATE_DESTINATION"}'), { expectPrivate: true }).status).toBe("PASS");
    expect(probeStatus(domain('{"code":"INVALID_INPUT"}'), { expectPrivate: true }).status).toBe("FAIL");
    expect(probeStatus(ok, { expectPrivate: true }).status).toBe("FAIL");
    expect(probeStatus(domain('{"code":"INVALID_SELECTION"}'), { expectDomain: true }).status).toBe("PASS");
  });

  it("parses JSON and prefixed codes", () => {
    expect(parseErrorCode('{"code":"PACK_CORRUPT","message":"x"}')).toBe("PACK_CORRUPT");
    expect(parseErrorCode("ATLAS_DISABLED: enable the flag")).toBe("ATLAS_DISABLED");
    expect(parseErrorCode("TypeError: undefined")).toBeNull();
  });
});

describe("tool result classification", () => {
  it("separates schema rejection, domain refusal and success", () => {
    expect(
      classifyToolResult({
        result: {
          isError: true,
          content: [{ type: "text", text: "Input validation error: Invalid arguments for tool get_index" }],
        },
      }).kind,
    ).toBe("schema_rejected");
    expect(
      classifyToolResult({
        result: {
          isError: true,
          content: [{ type: "text", text: '{"code":"PRIVATE_DESTINATION","message":"loopback"}' }],
        },
      }).kind,
    ).toBe("domain_error");
    expect(classifyToolResult({ result: { content: [{ type: "text", text: "{}" }] } }).kind).toBe("ok");
    expect(classifyToolResult({ error: { code: -32603, message: "boom" } }).kind).toBe("protocol_error");
  });
});

describe("Atlas CLI probes", () => {
  it("passes a documented flag refusal", () => {
    const result = classifyFlagOffProbe({
      action: "import",
      status: 2,
      stderr: "awwwards-index: --atlas import requires AWWWARDS_MCP_ATLAS=1; no cache or network access was used.",
      cacheExisted: false,
    });
    expect(result.status).toBe("PASS");
    expect(result.available).toBe(true);
  });

  it("never passes an action that is not wired yet", () => {
    const result = classifyFlagOffProbe({
      action: "reindex",
      status: 2,
      stderr: 'awwwards-index: unsupported --atlas action "reindex"; expected "import".',
      cacheExisted: false,
    });
    expect(result.status).toBe("SKIP");
    expect(result.available).toBe(false);
  });

  it("fails a silent run, cache creation and unexpected exits", () => {
    expect(classifyFlagOffProbe({ action: "capture", status: 0 }).status).toBe("FAIL");
    expect(
      classifyFlagOffProbe({
        action: "capture",
        status: 2,
        stderr: "requires AWWWARDS_MCP_ATLAS=1",
        cacheExisted: true,
      }).status,
    ).toBe("FAIL");
    expect(classifyFlagOffProbe({ action: "capture", status: 1, stderr: "boom" }).status).toBe("FAIL");
    expect(
      classifyFlagOffProbe({ action: "capture", status: 2, error: "ETIMEDOUT" }).status,
    ).toBe("FAIL");
  });

  it("classifies an enabled offline action", () => {
    expect(classifyFlagOnProbe({ action: "import", status: 0 }).status).toBe("PASS");
    expect(classifyFlagOnProbe({ action: "import", status: 1, stderr: "boom" }).status).toBe("FAIL");
  });
});

describe("child environment isolation", () => {
  it("redirects HOME/APPDATA and strips inherited Atlas variables", () => {
    const env = buildChildEnv({
      baseEnv: {
        HOME: "C:\\real-home",
        USERPROFILE: "C:\\real-home",
        APPDATA: "C:\\real-home\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\real-home\\AppData\\Local",
        XDG_CACHE_HOME: "/real-home/.cache",
        NODE_OPTIONS: "--experimental-flag",
        AWWWARDS_MCP_ATLAS: "0",
        AWWWARDS_MCP_PROFILE: "core",
        KEEP_ME: "yes",
      },
      cacheDir: "C:\\temp\\cache",
      homeDir: "C:\\temp\\home",
      flagOn: true,
      playwrightBrowsersPath: "C:\\temp\\ms-playwright",
    });
    for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
      expect(env[key]).toBe("C:\\temp\\home");
    }
    expect(env.AWWWARDS_CACHE_DIR).toBe("C:\\temp\\cache");
    expect(env.AWWWARDS_MCP_ATLAS).toBe("1");
    expect(env.AWWWARDS_MCP_PROFILE).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe("C:\\temp\\ms-playwright");
    expect(env.KEEP_ME).toBe("yes");
  });

  it("requires both a cache directory and an isolated home", () => {
    expect(() => buildChildEnv({ cacheDir: "x" })).toThrow(/homeDir/);
    expect(() => buildChildEnv({ homeDir: "x" })).toThrow(/cacheDir/);
  });

  it("fingerprints a cache so creation and mutation are detectable", () => {
    const root = mkdtempSync(join(tmpdir(), "qualify-fingerprint-"));
    try {
      const dir = join(root, "cache");
      const missing = cacheFingerprint(dir);
      expect(missing.exists).toBe(false);
      mkdirSync(dir);
      const created = cacheFingerprint(dir);
      expect(created.exists).toBe(true);
      expect(sameCacheFingerprint(missing, created)).toBe(false);
      writeFileSync(join(dir, "cache.db"), "db");
      const written = cacheFingerprint(dir);
      expect(sameCacheFingerprint(created, written)).toBe(false);
      expect(sameCacheFingerprint(written, cacheFingerprint(dir))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("--skip-build freshness", () => {
  it("accepts a dist built after src and rejects a stale dist", () => {
    const root = mkdtempSync(join(tmpdir(), "qualify-freshness-"));
    try {
      const src = join(root, "src");
      const dist = join(root, "dist");
      mkdirSync(src);
      mkdirSync(dist);
      writeFileSync(join(src, "cli.ts"), "export {};\n");
      writeFileSync(join(dist, "cli.js"), "export {};\n");
      const base = Math.floor(Date.now() / 1000) - 100;
      utimesSync(join(src, "cli.ts"), base, base);
      utimesSync(join(dist, "cli.js"), base + 10, base + 10);
      expect(checkDistFreshness({ srcDir: src, distDir: dist }).ok).toBe(true);
      utimesSync(join(src, "cli.ts"), base + 20, base + 20);
      const stale = checkDistFreshness({ srcDir: src, distDir: dist });
      expect(stale.ok).toBe(false);
      expect(stale.reason).toMatch(/stale/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when dist is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "qualify-freshness-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "cli.ts"), "");
      expect(checkDistFreshness({ srcDir: join(root, "src"), distDir: join(root, "dist") }).ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("browser qualification aggregate", () => {
  const entry = (id: string, status: string, reason = id) => ({ id, status, reason });

  it("is required and SKIP when Atlas is present but Chromium is missing", () => {
    const result = browserQualification({
      chromium: entry("browser.chromium", "SKIP", "--no-browser was requested"),
      fixture: entry("browser.fixture", "SKIP"),
      policy: entry("browser.atlas_policy", "SKIP"),
      capture: entry("browser.atlas_capture", "SKIP"),
      atlasPresent: true,
    });
    expect(result).toMatchObject({ status: "SKIP", required: true });
    expect(result.reason).toMatch(/not performed/);
  });

  it("is required and SKIP when a positive capture was not exercised", () => {
    const result = browserQualification({
      chromium: entry("browser.chromium", "PASS"),
      fixture: entry("browser.fixture", "PASS"),
      policy: entry("browser.atlas_policy", "PASS"),
      capture: entry("browser.atlas_capture", "SKIP", "no live fixture"),
      atlasPresent: true,
    });
    expect(result).toMatchObject({ status: "SKIP", required: true });
    expect(result.reason).toMatch(/positive capture/);
  });

  it("passes only when Chromium, the fixture and a positive capture all pass", () => {
    const result = browserQualification({
      chromium: entry("browser.chromium", "PASS"),
      fixture: entry("browser.fixture", "PASS"),
      policy: entry("browser.atlas_policy", "PASS"),
      capture: entry("browser.atlas_capture", "PASS"),
      atlasPresent: true,
    });
    expect(result).toMatchObject({ status: "PASS", required: true });
  });

  it("fails a failed browser check even when Atlas is not present", () => {
    const result = browserQualification({
      chromium: entry("browser.chromium", "PASS"),
      fixture: entry("browser.fixture", "FAIL", "no bands"),
      policy: entry("browser.atlas_policy", "SKIP"),
      capture: entry("browser.atlas_capture", "SKIP"),
      atlasPresent: false,
    });
    expect(result).toMatchObject({ status: "FAIL", required: true });
  });

  it("stays optional without Atlas surfaces", () => {
    const result = browserQualification({
      chromium: entry("browser.chromium", "SKIP"),
      fixture: entry("browser.fixture", "SKIP"),
      policy: entry("browser.atlas_policy", "SKIP"),
      capture: entry("browser.atlas_capture", "SKIP"),
      atlasPresent: false,
    });
    expect(result).toMatchObject({ status: "SKIP", required: false });
  });
});

describe("MCP stdio client", () => {
  it("exchanges JSON-RPC and audits a clean channel", async () => {
    const client = await startMcpClient({
      command: process.execPath,
      args: [fakeServer],
      cwd: process.cwd(),
      env: { ...process.env, FAKE_NOISE: "" },
      requestTimeoutMs: 5_000,
    });
    const listed = await client.result("tools/list", {});
    expect(listed.tools).toEqual([{ name: "fake_tool" }]);
    const audit = await client.stop();
    expect(audit.ok).toBe(true);
    expect(audit.noise).toEqual([]);
    expect(audit.problems).toEqual([]);
  });

  it("records stdout noise instead of ignoring it", async () => {
    const client = await startMcpClient({
      command: process.execPath,
      args: [fakeServer],
      cwd: process.cwd(),
      env: { ...process.env, FAKE_NOISE: "1" },
      requestTimeoutMs: 5_000,
    });
    await client.result("tools/list", {});
    const audit = await client.stop();
    expect(audit.ok).toBe(false);
    expect(audit.noise.join("\n")).toContain("noise-before-response");
  });

  it("surfaces JSON-RPC errors", async () => {
    const client = await startMcpClient({
      command: process.execPath,
      args: [fakeServer],
      cwd: process.cwd(),
      env: { ...process.env, FAKE_ERROR: "1" },
      requestTimeoutMs: 5_000,
    });
    await expect(client.result("tools/list", {})).rejects.toThrow(/boom/);
    await client.stop();
  });

  it("records an unknown response id", async () => {
    const client = await startMcpClient({
      command: process.execPath,
      args: [fakeServer],
      cwd: process.cwd(),
      env: { ...process.env, FAKE_BAD_ID: "1" },
      requestTimeoutMs: 400,
    });
    await expect(client.request("tools/list", {})).rejects.toThrow(/timed out/);
    const audit = await client.stop();
    expect(audit.ok).toBe(false);
    expect(audit.problems.join("\n")).toMatch(/unknown response id/);
  });

  it("records a duplicate response id", async () => {
    const client = await startMcpClient({
      command: process.execPath,
      args: [fakeServer],
      cwd: process.cwd(),
      env: { ...process.env, FAKE_DUP_ID: "1" },
      requestTimeoutMs: 5_000,
    });
    await client.result("tools/list", {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    const audit = await client.stop();
    expect(audit.ok).toBe(false);
    expect(audit.problems.join("\n")).toMatch(/duplicate response id/);
  });
});
