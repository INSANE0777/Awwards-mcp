import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertInstalledTree,
  describeArtifactFile,
  installedPackageDir,
  readInstalledIdentity,
  unsafeArtifactPath,
} from "../scripts/qualify/artifact.mjs";
import { APPROVED_FIXTURE_URL } from "../scripts/qualify/fixture.mjs";
import { requiredCheckInventory, validateReleaseEvidence } from "../scripts/qualify/gate.mjs";
import { addCheck, createReport, finalizeReport } from "../scripts/qualify/report.mjs";
import { computeIntegrity } from "../scripts/release-integrity.mjs";

const root = mkdtempSync(join(tmpdir(), "release-qualification-"));
const repo = join(import.meta.dirname, "..");
const NAME = "awwwards-mcp";
const VERSION = "1.20.0";
const STARTED = "2026-01-01T00:00:00.000Z";
const FINISHED = "2026-01-01T00:10:00.000Z";

afterAll(() => rmSync(root, { recursive: true, force: true }));

function gzipBytes(label: string) {
  return Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.from(label)]);
}

function artifactFile(label: string, filename = `${NAME}-${VERSION}.tgz`) {
  const dir = mkdtempSync(join(root, "artifact-"));
  const path = join(dir, filename);
  writeFileSync(path, gzipBytes(label));
  return path;
}

type Artifact = ReturnType<typeof describeArtifactFile>;

function fullReport(artifact: Artifact, mode = "tarball") {
  const report = createReport({
    startedAt: STARTED,
    node: "v22.20.0",
    platform: "linux-x64",
    qualificationScope: "full",
    environment: { isolatedHome: "/tmp/qualify-home" },
    repo: { root: "/repo", branch: "main", commit: "a".repeat(40), dirty: false },
    input: { mode },
    qualificationFixture: { url: APPROVED_FIXTURE_URL },
    requiredInventory: requiredCheckInventory(mode),
    options: { skipBuild: false, tarball: mode === "tarball", browser: true, keepTemp: false, timeoutMs: 120_000 },
  });
  for (const id of requiredCheckInventory(mode)) {
    addCheck(report, { id, group: "g", required: true, status: "PASS", reason: "evidence" } as never);
  }
  addCheck(report, {
    id: "browser.chromium",
    group: "browser",
    required: false,
    status: "PASS",
    reason: "Chromium present",
  } as never);
  finalizeReport(report, { finishedAt: FINISHED, qualificationScope: "full" });
  report.package = { name: NAME, version: VERSION, source: "installed-artifact" };
  report.artifact = {
    source: mode,
    filename: artifact.filename,
    sha256: artifact.sha256,
    integrity: artifact.integrity,
    bytes: artifact.bytes,
    files: mode === "pack" ? 101 : null,
  };
  return report;
}

function refinalize(report: any, scope = "full") {
  report.qualificationScope = scope;
  finalizeReport(report, { finishedAt: FINISHED, qualificationScope: scope });
}

// Windows environment names are case-insensitive but Node can keep both a
// parent NPM_EXECPATH and an added npm_execpath; only one key may survive.
function childEnv(overrides: Record<string, string>) {
  const env: Record<string, string | undefined> = { ...process.env };
  const names = new Set(Object.keys(overrides).map((key) => key.toLowerCase()));
  for (const key of Object.keys(env)) {
    if (names.has(key.toLowerCase())) delete env[key];
  }
  return { ...env, ...overrides };
}

const expected = { mode: "tarball", package: NAME, version: VERSION };

describe("artifact identity", () => {
  it("computes npm SHA-512 integrity for the supplied bytes", () => {
    const bytes = Buffer.from("hello");
    const expectedIntegrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    expect(computeIntegrity(bytes)).toBe(expectedIntegrity);
    expect(computeIntegrity(bytes)).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
  });

  it("describes a local tarball without changing it", () => {
    const path = artifactFile("describe");
    const before = readFileSync(path);
    const artifact = describeArtifactFile(path);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(artifact).toMatchObject({
      filename: `${NAME}-${VERSION}.tgz`,
      bytes: before.length,
      sha256: createHash("sha256").update(before).digest("hex"),
      integrity: computeIntegrity(before),
    });
  });

  it("refuses a non-tarball payload", () => {
    const path = join(mkdtempSync(join(root, "not-tarball-")), "plain.tgz");
    writeFileSync(path, "not gzip");
    expect(() => describeArtifactFile(path)).toThrow(/gzipped npm tarball/);
  });

  it("reads package identity from the installed tree, never checkout metadata", () => {
    const dir = mkdtempSync(join(root, "installed-"));
    // Deliberately different from the checkout's name/version: returning
    // either constant instead of the installed metadata must fail here.
    const installedName = "installed-copy";
    const installedVersion = "9.9.9-installed";
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: installedName, version: installedVersion }),
    );
    expect(readInstalledIdentity(dir)).toEqual({
      name: installedName,
      version: installedVersion,
      source: "installed-artifact",
    });
    expect(() => readInstalledIdentity(dir, "other-package")).toThrow(/expected other-package/);
  });

  it("finds exactly one installed package under the throwaway prefix", () => {
    const globalRoot = mkdtempSync(join(root, "global-root-"));
    mkdirSync(join(globalRoot, NAME));
    writeFileSync(join(globalRoot, ".package-lock.json"), "{}");
    expect(installedPackageDir(globalRoot)).toBe(join(globalRoot, NAME));
    mkdirSync(join(globalRoot, "second-package"));
    expect(() => installedPackageDir(globalRoot)).toThrow(/exactly one installed package/);
  });
});

describe("installed artifact allowlist", () => {
  const clean = [
    "package.json",
    "dist/cli.js",
    "dist/index-cli.js",
    "dist/cache.js",
    "README.md",
    "ATLAS.md",
    "LICENSE",
  ];

  it("accepts a clean release tree", () => {
    expect(() => assertInstalledTree(clean)).not.toThrow();
    expect(() => assertInstalledTree([...clean, ".package-lock.json"])).not.toThrow();
  });

  it("refuses a tree missing required documentation", () => {
    for (const missing of ["README.md", "ATLAS.md"]) {
      const files = clean.filter((file) => file !== missing);
      expect(() => assertInstalledTree(files)).toThrow(`installed artifact is missing ${missing}`);
    }
  });

  it("refuses leaked checkout sources, docs and tests", () => {
    for (const leaked of ["src/index.ts", "docs/guide.md", "test/unit.test.ts"]) {
      expect(() => assertInstalledTree([...clean, leaked])).toThrow(/leaks checkout files/);
    }
  });

  it("refuses dotfiles and absolute paths", () => {
    for (const leaked of [".npmrc", ".env", join(repo, "dist", "cli.js")]) {
      expect(() => assertInstalledTree([...clean, leaked])).toThrow(/leaks checkout files/);
    }
  });

  it("refuses dotfiles nested inside the shipped dist tree", () => {
    for (const leaked of ["dist/.env", "dist/.npmrc", "dist/.git/config"]) {
      expect(unsafeArtifactPath(leaked), leaked).toBe(true);
      expect(() => assertInstalledTree([...clean, leaked]), leaked).toThrow(
        /leaks checkout files/,
      );
    }
    for (const cleanFile of ["package.json", "dist/cache.js", "dist/nested/cache.js"]) {
      expect(unsafeArtifactPath(cleanFile), cleanFile).toBe(false);
    }
    expect(unsafeArtifactPath("dist/../secret")).toBe(true);
    expect(() => assertInstalledTree([...clean, "dist/../secret"])).toThrow(
      /leaks checkout files/,
    );
    // A drive segment nested below the root is still an absolute escape.
    expect(unsafeArtifactPath("dist/C:/secret")).toBe(true);
    expect(() => assertInstalledTree([...clean, "dist/C:/secret"])).toThrow(
      /leaks checkout files/,
    );
  });

  it("reads report identity from the installed tree, never checkout metadata", () => {
    const source = readFileSync(join(repo, "scripts", "qualify-installed.mjs"), "utf8");
    expect(source).toContain("const installed = readInstalledIdentity(installedPkgDir)");
    expect(source).toContain("report.package = installed;");
    expect(source).not.toMatch(/report\.package\s*=\s*\{[^}]*PKG/);
  });
});

describe("release qualification inventory", () => {
  it("pins the pack baseline and the explicit tarball addition", () => {
    expect(requiredCheckInventory("pack")).toHaveLength(39);
    expect(requiredCheckInventory("tarball")).toHaveLength(38);
    expect(requiredCheckInventory("pack")).toContain("artifact.build");
    expect(requiredCheckInventory("pack")).toContain("artifact.pack");
    expect(requiredCheckInventory("tarball")).toContain("artifact.input");
    expect(requiredCheckInventory("tarball")).not.toContain("artifact.build");
    expect(requiredCheckInventory("tarball")).not.toContain("artifact.pack");
  });

  it("rejects an unknown mode", () => {
    expect(() => requiredCheckInventory("offline")).toThrow(/unknown qualification mode/);
  });
});

describe("release qualification gate", () => {
  it("accepts a full-scope approved-fixture report for the exact artifact", () => {
    const artifact = describeArtifactFile(artifactFile("accept"));
    const result = validateReleaseEvidence({ report: fullReport(artifact), artifact, expected });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.inventory).toHaveLength(38);
  });

  it("accepts unknown optional checks but not unknown required ones", () => {
    const artifact = describeArtifactFile(artifactFile("optional"));
    const report = fullReport(artifact);
    addCheck(report, {
      id: "diagnostic.extra",
      group: "diagnostic",
      required: false,
      status: "PASS",
      reason: "informational",
    } as never);
    refinalize(report);
    expect(validateReleaseEvidence({ report, artifact, expected }).ok).toBe(true);

    report.checks = report.checks.map((check: any) =>
      check.id === "surface.full.flag_on"
        ? { ...check, id: "unknown.substitute" }
        : check,
    );
    refinalize(report);
    const errors = validateReleaseEvidence({ report, artifact, expected }).errors.join("\n");
    expect(errors).toMatch(/missing required check surface\.full\.flag_on/);
    expect(errors).toMatch(/unknown required check/);
  });

  it("cannot let a report for artifact A qualify artifact B", () => {
    const a = describeArtifactFile(artifactFile("alpha", "awwwards-mcp-1.20.0.tgz"));
    const bPath = artifactFile("beta", "awwwards-mcp-1.20.0.tgz");
    const b = describeArtifactFile(bPath);
    const result = validateReleaseEvidence({ report: fullReport(a), artifact: b, expected });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/artifact\.integrity/);
    expect(result.errors.join("\n")).toMatch(/artifact\.sha256/);
  });

  it("fails when bytes change after the report was created", () => {
    const path = artifactFile("mutable");
    const artifact = describeArtifactFile(path);
    const report = fullReport(artifact);
    expect(validateReleaseEvidence({ report, artifact, expected }).ok).toBe(true);
    writeFileSync(path, gzipBytes("mutated"));
    const changed = describeArtifactFile(path);
    expect(validateReleaseEvidence({ report, artifact: changed, expected }).ok).toBe(false);
  });

  it("fails when a required check is deleted", () => {
    const artifact = describeArtifactFile(artifactFile("deleted"));
    const report = fullReport(artifact);
    report.checks = report.checks.filter((check: any) => check.id !== "browser.qualification");
    refinalize(report);
    expect(validateReleaseEvidence({ report, artifact, expected }).errors.join("\n")).toMatch(
      /missing required check browser\.qualification/,
    );
  });

  it("fails duplicate ids, required SKIP, FAIL and malformed summaries", () => {
    const artifact = describeArtifactFile(artifactFile("bad-status"));

    const duplicate = fullReport(artifact);
    duplicate.checks.push({ ...duplicate.checks[0] });
    refinalize(duplicate);
    expect(validateReleaseEvidence({ report: duplicate, artifact, expected }).errors.join("\n")).toMatch(
      /duplicate id/,
    );

    const skipped = fullReport(artifact);
    skipped.checks.find((check: any) => check.id === "surface.full.flag_on").status = "SKIP";
    refinalize(skipped);
    const skippedErrors = validateReleaseEvidence({ report: skipped, artifact, expected }).errors.join("\n");
    expect(skippedErrors).toMatch(/surface\.full\.flag_on: SKIP, required PASS/);
    expect(skippedErrors).toMatch(/summary\.status/);

    const failed = fullReport(artifact);
    failed.checks.find((check: any) => check.id === "protocol.modern.flag_on").status = "FAIL";
    refinalize(failed);
    expect(validateReleaseEvidence({ report: failed, artifact, expected }).errors.join("\n")).toMatch(
      /protocol\.modern\.flag_on: FAIL, required PASS/,
    );

    const malformed = fullReport(artifact);
    malformed.summary.pass += 1;
    malformed.checks.push(null);
    expect(validateReleaseEvidence({ report: malformed, artifact, expected }).errors.join("\n")).toMatch(
      /summary\.pass/,
    );
  });

  it("never lets a missing optional browser dependency become a full PASS", () => {
    const artifact = describeArtifactFile(artifactFile("browser-missing"));
    const report = fullReport(artifact);
    for (const id of [
      "browser.chromium",
      "browser.fixture",
      "browser.atlas_policy",
      "browser.atlas_capture",
      "browser.qualification",
    ]) {
      report.checks.find((check: any) => check.id === id).status = "SKIP";
    }
    refinalize(report);
    expect(report.summary.status).toBe("INCOMPLETE");
    expect(report.summary.exitCode).toBe(2);
    const errors = validateReleaseEvidence({ report, artifact, expected }).errors.join("\n");
    expect(errors).toMatch(/summary\.status: INCOMPLETE/);
    expect(errors).toMatch(/browser\.qualification: SKIP, required PASS/);
  });

  it("fails a stale inventory or a report that claims fewer checks", () => {
    const artifact = describeArtifactFile(artifactFile("inventory"));
    const report = fullReport(artifact);
    report.requiredInventory = report.requiredInventory.filter(
      (id: string) => id !== "browser.qualification",
    );
    report.checks = report.checks.filter((check: any) => check.id !== "browser.qualification");
    refinalize(report);
    const errors = validateReleaseEvidence({ report, artifact, expected }).errors.join("\n");
    expect(errors).toMatch(/requiredInventory/);
    expect(errors).toMatch(/missing required check browser\.qualification/);
  });

  it("fails a different package identity or version", () => {
    const artifact = describeArtifactFile(artifactFile("identity"));
    const report = fullReport(artifact);
    expect(
      validateReleaseEvidence({
        report,
        artifact,
        expected: { ...expected, version: "1.20.1" },
      }).errors.join("\n"),
    ).toMatch(/package\.version/);
    expect(
      validateReleaseEvidence({
        report,
        artifact,
        expected: { ...expected, package: "other-package" },
      }).errors.join("\n"),
    ).toMatch(/package\.name/);

    report.package = { name: NAME, version: VERSION };
    expect(validateReleaseEvidence({ report, artifact, expected }).errors.join("\n")).toMatch(
      /package\.source/,
    );
  });

  it("fails a report without a candidate source commit", () => {
    const artifact = describeArtifactFile(artifactFile("repo"));
    const report = fullReport(artifact);
    report.repo = { branch: "main", commit: null };
    expect(validateReleaseEvidence({ report, artifact, expected }).errors.join("\n")).toMatch(
      /repo\.commit/,
    );
  });

  it("fails an unapproved fixture, wrong mode or offline scope", () => {
    const artifact = describeArtifactFile(artifactFile("scope"));
    const report = fullReport(artifact);
    report.qualificationFixture = { url: "https://example.com/" };
    expect(validateReleaseEvidence({ report, artifact, expected }).errors.join("\n")).toMatch(
      /qualificationFixture\.url/,
    );

    const offline = fullReport(artifact);
    refinalize(offline, "offline-installed");
    expect(offline.summary.status).toBe("INCOMPLETE");
    expect(offline.summary.exitCode).toBe(2);
    const offlineErrors = validateReleaseEvidence({ report: offline, artifact, expected }).errors.join("\n");
    expect(offlineErrors).toMatch(/qualificationScope: offline-installed/);
    expect(offlineErrors).toMatch(/summary\.status: INCOMPLETE/);

    const packReport = fullReport(artifact, "pack");
    expect(validateReleaseEvidence({ report: packReport, artifact, expected }).errors.join("\n")).toMatch(
      /input\.mode: pack/,
    );
  });

  it("fails when the expected release integrity names other bytes", () => {
    const artifact = describeArtifactFile(artifactFile("integrity"));
    const other = describeArtifactFile(artifactFile("other"));
    expect(
      validateReleaseEvidence({
        report: fullReport(artifact),
        artifact,
        expected: { ...expected, integrity: other.integrity },
      }).errors.join("\n"),
    ).toMatch(/does not match the expected release integrity/);
    expect(
      validateReleaseEvidence({
        report: fullReport(artifact),
        artifact,
        expected: { ...expected, integrity: "not-an-sri" },
      }).errors.join("\n"),
    ).toMatch(/is not an SRI string/);
  });
});

describe("release qualification gate CLI", () => {
  const gate = join(repo, "scripts", "qualify", "gate.mjs");

  it("writes evidence and exits 0 for matching bytes", () => {
    const dir = mkdtempSync(join(root, "gate-cli-"));
    const path = artifactFile("cli-pass");
    const artifact = describeArtifactFile(path);
    const reportPath = join(dir, "report.json");
    writeFileSync(reportPath, JSON.stringify(fullReport(artifact), null, 2));
    const evidencePath = join(dir, "gate.json");
    const result = spawnSync(
      process.execPath,
      [
        gate,
        "--report",
        reportPath,
        "--tarball",
        path,
        "--mode",
        "tarball",
        "--package",
        NAME,
        "--version",
        VERSION,
        "--filename",
        artifact.filename,
        "--evidence",
        evidencePath,
      ],
      { encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    expect(evidence).toMatchObject({ verdict: "PASS", gateVersion: 1 });
    expect(evidence.artifact.integrity).toBe(artifact.integrity);
    expect(evidence.report.package).toEqual({ name: NAME, version: VERSION, source: "installed-artifact" });
  });

  it("exits 1 and records the failure when the bytes move", () => {
    const dir = mkdtempSync(join(root, "gate-cli-fail-"));
    const path = artifactFile("cli-fail");
    const artifact = describeArtifactFile(path);
    const reportPath = join(dir, "report.json");
    writeFileSync(reportPath, JSON.stringify(fullReport(artifact), null, 2));
    writeFileSync(path, gzipBytes("changed"));
    const evidencePath = join(dir, "gate.json");
    const result = spawnSync(
      process.execPath,
      [
        gate,
        "--report",
        reportPath,
        "--tarball",
        path,
        "--package",
        NAME,
        "--version",
        VERSION,
        "--evidence",
        evidencePath,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("release-qualification gate: FAIL");
    expect(JSON.parse(readFileSync(evidencePath, "utf8")).errors.join("\n")).toMatch(/artifact\.integrity/);
  });

  it("exits 2 on missing required arguments", () => {
    const result = spawnSync(process.execPath, [gate, "--report", "x.json"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--tarball is required/);
  });
});

describe("release workflow ordering", () => {
  const workflow = readFileSync(join(repo, ".github", "workflows", "release.yml"), "utf8");

  it("packs once, qualifies that path, gates it, uploads evidence, then publishes it", () => {
    expect((workflow.match(/npm pack --json/g) ?? []).length).toBe(1);
    const qualify = workflow.indexOf("name: Qualify the exact packed artifact");
    const gate = workflow.indexOf("name: Gate - qualification evidence matches the release artifact");
    const upload = workflow.indexOf("name: Upload qualification evidence");
    const publish = workflow.indexOf("name: Publish (beta tag when prerelease)");
    expect(qualify).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(qualify);
    expect(upload).toBeGreaterThan(gate);
    expect(publish).toBeGreaterThan(upload);
    expect(workflow.slice(qualify, gate)).toContain(
      '--tarball ".release-artifact/${{ steps.artifact.outputs.filename }}"',
    );
    expect(workflow.slice(gate, upload)).toContain('--integrity "$REGISTRY_INTEGRITY"');
    expect(workflow.slice(publish)).toContain("steps.artifact.outputs.filename");
  });

  it("keeps the evidence upload unconditional and failing when empty", () => {
    const upload = workflow.indexOf("name: Upload qualification evidence");
    const publish = workflow.indexOf("name: Publish (beta tag when prerelease)");
    expect(upload).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(upload);
    const step = workflow.slice(upload, publish);
    expect(step).toContain("if: always()");
    expect(step).toContain("if-no-files-found: error");
  });

  it("keeps the existing version, changelog, registry and test gates", () => {
    for (const gate of [
      "release-version-gate.mjs",
      "changelog-gate.mjs",
      "npm-published-gate.mjs",
      "npm ci",
      "npm run typecheck",
      "npm test",
      "npm run build",
      "npm run registry:gate",
    ]) {
      expect(workflow).toContain(gate);
    }
  });
});

describe("artifact-input qualification mode", () => {
  it("never builds or packs a supplied tarball", () => {
    const dir = mkdtempSync(join(root, "artifact-mode-"));
    const path = join(dir, `${NAME}-${VERSION}.tgz`);
    writeFileSync(path, gzipBytes("supplied"));
    const log = join(dir, "npm-calls.jsonl");
    const recorder = join(dir, "npm-recorder.cjs");
    writeFileSync(
      recorder,
      [
        'const { appendFileSync } = require("node:fs");',
        'appendFileSync(process.env.QUALIFY_NPM_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");',
        "process.exit(1);",
        "",
      ].join("\n"),
    );
    const reportPath = join(dir, "report.json");
    const home = join(dir, "home");
    mkdirSync(home);
    const result = spawnSync(
      process.execPath,
      [join(repo, "scripts", "qualify-installed.mjs"), "--tarball", path, "--report", reportPath],
      {
        cwd: repo,
        encoding: "utf8",
        timeout: 120_000,
        env: childEnv({
          npm_execpath: recorder,
          QUALIFY_NPM_LOG: log,
          HOME: home,
          USERPROFILE: home,
          APPDATA: home,
          LOCALAPPDATA: home,
          XDG_CACHE_HOME: home,
        }),
      },
    );

    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.some((call) => call[0] === "install")).toBe(true);
    expect(calls.some((call) => call[0] === "install" && call.includes(realpathSync(path)))).toBe(true);
    expect(calls.some((call) => call[0] === "run" && call[1] === "build")).toBe(false);
    expect(calls.some((call) => call[0] === "pack")).toBe(false);

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(report.input.mode).toBe("tarball");
    expect(report.requiredInventory).toEqual(requiredCheckInventory("tarball"));
    expect(report.checks.find((check: any) => check.id === "artifact.input").status).toBe("PASS");
    expect(report.checks.some((check: any) => check.id === "artifact.build")).toBe(false);
    expect(report.checks.some((check: any) => check.id === "artifact.pack")).toBe(false);
    expect(report.artifact).toMatchObject({
      source: "tarball",
      bytes: readFileSync(path).length,
      integrity: computeIntegrity(readFileSync(path)),
    });
    expect(result.status).toBe(1);
  });

  it("refuses --skip-build with a supplied tarball", () => {
    const result = spawnSync(
      process.execPath,
      [join(repo, "scripts", "qualify-installed.mjs"), "--tarball", "missing.tgz", "--skip-build"],
      { cwd: repo, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--skip-build");
  });
});
