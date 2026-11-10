import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Cache } from "../src/cache.js";
import { writeArtifactBytesSync, writeJsonArtifactSync } from "../src/atlas/artifacts.js";
import {
  adoptEvidencePack,
  buildEvidencePack,
  renderDesignMd,
  renderRebuildHandoff,
  validateEvidencePack,
  type EvidencePackResult,
} from "../src/atlas/evidence-pack.js";
import {
  MAX_COPIED_ARTIFACT_BYTES,
  MAX_PACK_GOAL_LENGTH,
  MAX_SELECTION_BYTES,
  MAX_TEXT_DOCUMENT_BYTES,
  REQUIRED_DESIGN_SECTIONS,
  evidenceFileMime,
  type EvidencePackInput,
  type EvidenceSelection,
  type PackValidation,
} from "../src/atlas/evidence-pack-types.js";
import { evidencePackId } from "../src/atlas/evidence-pack-id.js";
import {
  buildTokens,
  deriveComponentSummaries,
  deriveSectionSummaries,
  omittedValues,
  renderGeneratedDocuments,
  renderSelectionArtifact,
} from "../src/atlas/evidence-pack-render.js";
import { CORE_TOOL_NAMES } from "../src/tool-profile.js";
import { V2_TOOL_NAMES } from "../src/v2/register.js";
import { registerAllTools } from "../src/tools/index.js";
import { PACK_NOW, publishPackFixture } from "./helpers/atlas-pack-fixture.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-pack-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const GOAL = "Rebuild the selected landing page sections";
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const LINK_ERRORS = new Set(["EPERM", "EACCES", "ENOTSUP", "EINVAL", "UNKNOWN"]);

/** Directory junction on Windows (no admin rights) or a directory symlink elsewhere. */
function linkDirectory(target: string, path: string): boolean {
  if (process.platform === "win32") {
    return spawnSync("cmd", ["/c", "mklink", "/J", path, target], { encoding: "utf8" }).status === 0;
  }
  try {
    symlinkSync(target, path, "dir");
    return true;
  } catch (error) {
    if (LINK_ERRORS.has((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

function cacheFor(root = tmpDir(), now = PACK_NOW): Cache {
  return new Cache(root, () => now, { atlas: true });
}

function packFiles(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path, rel);
      else files.set(rel, readFileSync(path));
    }
  };
  walk(root, "");
  return files;
}

function manifestOf(packDir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(packDir, "manifest.json"), "utf8"));
}

function designEvidenceOf(packDir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(packDir, "design-evidence.json"), "utf8"));
}

function selectionOf(packDir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(packDir, "artifacts", "selection.json"), "utf8"));
}

function copyPack(packDir: string, name = manifestOf(packDir).packId): string {
  const target = join(tmpDir(), name);
  mkdirSync(target, { recursive: true });
  for (const [path, bytes] of packFiles(packDir)) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    writeFileSync(join(target, path), bytes);
  }
  return target;
}

function rewriteManifest(packDir: string, mutate: (manifest: Record<string, any>) => void): void {
  const manifest = manifestOf(packDir);
  mutate(manifest);
  writeFileSync(join(packDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function removeField(target: Record<string, any>, path: string[]): void {
  let node: any = target;
  for (const key of path.slice(0, -1)) node = node[key];
  delete node[path[path.length - 1]!];
}

function updateManifestFile(packDir: string, relativePath: string, content: Buffer | string): void {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  writeFileSync(join(packDir, relativePath), bytes);
  const manifest = manifestOf(packDir);
  const entry = manifest.files.find((file: { path: string }) => file.path === relativePath);
  if (!entry) throw new Error(`missing manifest entry ${relativePath}`);
  entry.sha256 = sha256(bytes);
  entry.bytes = bytes.length;
  writeFileSync(join(packDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function rewriteSelection(packDir: string, mutate: (selection: Record<string, any>) => void): void {
  const selection = selectionOf(packDir);
  mutate(selection);
  updateManifestFile(packDir, "artifacts/selection.json", `${JSON.stringify(selection, null, 2)}\n`);
}

/** Keep the design-evidence selection capture hash in step with a rewritten selection. */
function refreshSelectionEvidence(packDir: string): void {
  const bytes = readFileSync(join(packDir, "artifacts", "selection.json"));
  const evidence = designEvidenceOf(packDir);
  const capture = evidence.captures.find((entry: { artifactId?: string }) => entry.artifactId === "selection");
  if (!capture) throw new Error("missing selection capture");
  capture.sha256 = sha256(bytes);
  updateManifestFile(packDir, "design-evidence.json", `${JSON.stringify(evidence, null, 2)}\n`);
}

/**
 * Rewrite the selection artifact consistently across the manifest and every
 * derived document, re-hashing all of them.
 */
function rewriteSelectionDocuments(packDir: string, selection: EvidenceSelection): void {
  selection.omitted = omittedValues(selection);
  const selectionDocument = renderSelectionArtifact(selection).document;
  const documents = [
    selectionDocument,
    ...renderGeneratedDocuments(selection, sha256(selectionDocument.content)),
  ];
  for (const document of documents) {
    writeFileSync(join(packDir, document.path), document.content);
  }
  rewriteManifest(packDir, (manifest) => {
    manifest.captures = selection.captures;
    manifest.site.sourceUrls = selection.sourceUrls;
    const observed = selection.captures
      .map((capture) => capture.observedAt ?? capture.lastConfirmedAt ?? capture.sourceFetchedAt)
      .filter((value): value is number => value !== null);
    manifest.observationDates = {
      earliest: observed.length ? Math.min(...observed) : null,
      latest: observed.length ? Math.max(...observed) : null,
    };
    manifest.omitted = selection.omitted;
    for (const document of documents) {
      const entry = manifest.files.find((file: { path: string }) => file.path === document.path);
      if (!entry) throw new Error(`missing manifest entry ${document.path}`);
      entry.sha256 = sha256(document.content);
      entry.bytes = Buffer.byteLength(document.content, "utf8");
    }
  });
}

/**
 * Rewrite capture provenance consistently across the selection artifact,
 * manifest and every derived document, re-hashing all of them.
 */
function rewriteCaptureProvenance(
  packDir: string,
  mutate: (capture: Record<string, any>, selection: Record<string, any>) => void,
): void {
  const selection = selectionOf(packDir) as unknown as EvidenceSelection;
  for (const capture of selection.captures) {
    mutate(capture as unknown as Record<string, any>, selection as unknown as Record<string, any>);
  }
  rewriteSelectionDocuments(packDir, selection);
}

/** Rewrite selected regions consistently across documents and manifest hashes. */
function rewriteSelectionConsistently(
  packDir: string,
  mutate: (selection: Record<string, any>) => void,
): void {
  const selection = selectionOf(packDir) as unknown as EvidenceSelection;
  mutate(selection as unknown as Record<string, any>);
  selection.sections = deriveSectionSummaries(selection.regions, selection.claims);
  selection.components = deriveComponentSummaries(selection.regions, selection.claims);
  rewriteSelectionDocuments(packDir, selection);
}

/** Recompute the pack identity after rewriting artifact references or rights. */
function recomputePackId(selection: Record<string, any>): string {
  return evidencePackId({
    siteSlug: selection.siteSlug,
    goal: selection.goal,
    inclusionMode: selection.inclusionMode,
    regionIds: selection.regions.map((region: { regionId: string }) => region.regionId),
    captures: selection.captures,
    references: selection.references,
    rights: selection.rightsAssertions,
  });
}

/** Rewrite references, identity, manifest pin and regenerated documents together. */
function rewriteSelectionIdentity(packDir: string, selection: Record<string, any>): void {
  selection.packId = recomputePackId(selection);
  rewriteSelectionDocuments(packDir, selection as unknown as EvidenceSelection);
  rewriteManifest(packDir, (manifest) => {
    manifest.packId = selection.packId;
    manifest.artifacts.references = selection.references;
  });
}

function placePack(cache: Cache, source: string): string {
  const target = join(cache.rootDir, "atlas", "evidence-packs", manifestOf(source).packId);
  rmSync(target, { recursive: true, force: true });
  for (const [path, bytes] of packFiles(source)) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    writeFileSync(join(target, path), bytes);
  }
  return target;
}

function codes(validation: PackValidation): string[] {
  return validation.errors.map((error) => error.code);
}

function packStore(
  cache: Cache,
  onBeforePublish?: (tempDir: string) => void,
  onBeforeRename?: () => void,
  onAfterRename?: (finalDir: string) => void,
) {
  return {
    cache,
    now: () => PACK_NOW,
    ...(onBeforePublish ? { onBeforePublish } : {}),
    ...(onBeforeRename ? { onBeforeRename } : {}),
    ...(onAfterRename ? { onAfterRename } : {}),
  };
}

function runPackWorker(
  root: string,
  inputPath: string,
  now: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const worker = join(__dirname, "helpers", "atlas-pack-worker.ts");
  const tsx = join(__dirname, "../node_modules/tsx/dist/cli.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsx, worker, root, inputPath, String(now)], {
      cwd: join(__dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function stripCodeSpans(text: string): string {
  return text.replace(/`[^`]*`/g, "");
}

function inputFor(fixture: { sectionIds: string[]; componentIds: string[] }, overrides: Partial<EvidencePackInput> = {}): EvidencePackInput {
  return {
    siteSlug: "pack-fixture",
    goal: GOAL,
    regionIds: [fixture.sectionIds[1]!, fixture.componentIds[1]!],
    inclusionMode: "references",
    ...overrides,
  };
}

function artifactIds(cache: Cache, captureId: string): Array<{ id: string; kind: string }> {
  return cache.withAtlasDb(
    (db) =>
      db
        .prepare(
          "SELECT id, kind FROM atlas_artifacts WHERE capture_id = ? AND kind IN ('component_pack','screenshot') ORDER BY kind, id",
        )
        .all(captureId) as Array<{ id: string; kind: string }>,
  );
}

function packRows(cache: Cache): Array<{ id: string; manifest_hash: string }> {
  return cache.withAtlasDb(
    (db) =>
      db
        .prepare("SELECT id, manifest_hash FROM atlas_packs ORDER BY id")
        .all() as Array<{ id: string; manifest_hash: string }>,
  );
}

const publicRights = {
  status: "owned" as const,
  reference: "fixture license",
  recordedAt: PACK_NOW,
  assertedBy: "caller" as const,
  scope: "export_copy" as const,
};

/** External media keeps only its source URL: no stored path, hash or size. */
function addExternalMedia(cache: Cache, captureId: string, id: string): void {
  cache.withAtlasDb((db) => {
    db.prepare(
      `INSERT INTO atlas_artifacts
         (id, capture_id, region_id, kind, storage_path, external_url, sha256, bytes,
          mime_type, state, rights_json, metadata_json)
       VALUES (?, ?, NULL, 'external_media', NULL, ?, NULL, NULL, 'image/webp', 'ready', '{}', ?)`,
    ).run(
      id,
      captureId,
      "https://pack-fixture.example/hero.webp",
      JSON.stringify({ key: "external-hero" }),
    );
  });
}

describe("Atlas evidence packs", () => {
  it("has a deterministic pack id and byte-identical output across caches", async () => {
    const first = cacheFor();
    const fixture = await publishPackFixture(first);
    const input = inputFor(fixture);
    const built = await buildEvidencePack(input, packStore(first));
    expect(built.packId).toMatch(/^[a-f0-9]{64}$/);
    expect(built.cached).toBe(false);
    expect(built.validation).toEqual({
      manifest: "pass",
      claims: "pass",
      hashes: "pass",
      designMd: "pass",
    });
    const firstFiles = packFiles(built.directory);

    const second = cacheFor();
    const secondFixture = await publishPackFixture(second);
    expect(secondFixture.captureId).toBe(fixture.captureId);
    const rebuilt = await buildEvidencePack(input, packStore(second));
    expect(rebuilt.packId).toBe(built.packId);
    const secondFiles = packFiles(rebuilt.directory);
    expect([...secondFiles.keys()]).toEqual([...firstFiles.keys()]);
    for (const [path, bytes] of firstFiles) {
      expect(secondFiles.get(path)!.equals(bytes), path).toBe(true);
    }

    const manifestBefore = readFileSync(join(built.directory, "manifest.json"));
    const cached = await buildEvidencePack(input, {
      cache: first,
      now: () => PACK_NOW + 86_400_000,
    });
    expect(cached.cached).toBe(true);
    expect(cached.packId).toBe(built.packId);
    expect(cached.manifestHash).toBe(built.manifestHash);
    expect(readFileSync(join(built.directory, "manifest.json")).equals(manifestBefore)).toBe(true);
  });

  it("returns PACK_CORRUPT for a tampered existing pack and never overwrites it", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const input = inputFor(fixture);
    const built = await buildEvidencePack(input, packStore(cache));
    const designPath = join(built.directory, "DESIGN.md");
    writeFileSync(designPath, `${readFileSync(designPath, "utf8")}\nTODO tamper\n`);

    await expect(buildEvidencePack(input, packStore(cache))).rejects.toMatchObject({
      code: "PACK_CORRUPT",
    });
    expect(readFileSync(designPath, "utf8")).toContain("TODO tamper");
    const validation = validateEvidencePack(built.directory);
    expect(validation.ok).toBe(false);
    expect(codes(validation)).toContain("HASH_MISMATCH");
  });

  it("leaves no final directory or temp file when a write fails before rename", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const input = inputFor(fixture);
    await expect(
      buildEvidencePack(
        input,
        packStore(cache, () => {
          throw new Error("interrupted before publish");
        }),
      ),
    ).rejects.toMatchObject({ code: "PACK_WRITE_FAILED" });
    const packsDir = join(cache.rootDir, "atlas", "evidence-packs");
    expect(existsSync(packsDir)).toBe(true);
    expect(readdirSync(packsDir)).toEqual([]);
    expect(cache.withAtlasDb((db) => db.prepare("SELECT COUNT(*) AS n FROM atlas_packs").get())).toEqual({
      n: 0,
    });
  });

  it("does not corrupt the pack when two processes publish the same selection", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const input = inputFor(fixture);
    const inputPath = join(tmpDir(), "input.json");
    writeFileSync(inputPath, JSON.stringify(input));
    const [left, right] = await Promise.all([
      runPackWorker(cache.rootDir, inputPath, PACK_NOW),
      runPackWorker(cache.rootDir, inputPath, PACK_NOW),
    ]);
    expect(left.code, left.stderr).toBe(0);
    expect(right.code, right.stderr).toBe(0);
    const leftResult = JSON.parse(left.stdout) as { packId: string; cached: boolean };
    const rightResult = JSON.parse(right.stdout) as { packId: string; cached: boolean };
    expect(leftResult.packId).toBe(rightResult.packId);
    expect([leftResult.cached, rightResult.cached]).toContain(false);
    const packDir = join(cache.rootDir, "atlas", "evidence-packs", leftResult.packId);
    expect(validateEvidencePack(packDir).ok).toBe(true);
    const leftovers = readdirSync(join(cache.rootDir, "atlas", "evidence-packs")).filter((name) =>
      name.startsWith(".tmp-"),
    );
    expect(leftovers).toEqual([]);
  });

  it("shares one manifest pin across concurrent builds with different clocks", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const input = inputFor(fixture);
    const inputPath = join(tmpDir(), "input.json");
    writeFileSync(inputPath, JSON.stringify(input));
    const [left, right] = await Promise.all([
      runPackWorker(cache.rootDir, inputPath, PACK_NOW),
      runPackWorker(cache.rootDir, inputPath, PACK_NOW + 86_400_000),
    ]);
    expect(left.code, left.stderr).toBe(0);
    expect(right.code, right.stderr).toBe(0);
    const leftResult = JSON.parse(left.stdout) as {
      packId: string;
      cached: boolean;
      manifestHash: string;
    };
    const rightResult = JSON.parse(right.stdout) as {
      packId: string;
      cached: boolean;
      manifestHash: string;
    };
    expect(leftResult.packId).toBe(rightResult.packId);
    expect(leftResult.manifestHash).toBe(rightResult.manifestHash);
    expect([leftResult.cached, rightResult.cached].sort()).toEqual([false, true]);
    const packDir = join(cache.rootDir, "atlas", "evidence-packs", leftResult.packId);
    const manifestBytes = readFileSync(join(packDir, "manifest.json"));
    expect([PACK_NOW, PACK_NOW + 86_400_000]).toContain(
      (JSON.parse(manifestBytes.toString("utf8")) as { createdAt: number }).createdAt,
    );
    expect(
      cache.withAtlasDb((db) => db.prepare("SELECT COUNT(*) AS n FROM atlas_packs").get()),
    ).toEqual({ n: 1 });
    expect(
      cache.withAtlasDb(
        (db) =>
          db.prepare("SELECT manifest_hash FROM atlas_packs WHERE id = ?").get(leftResult.packId) as {
            manifest_hash: string;
          },
      ).manifest_hash,
    ).toBe(leftResult.manifestHash);

    const cached = await buildEvidencePack(input, { cache, now: () => PACK_NOW + 172_800_000 });
    expect(cached.cached).toBe(true);
    expect(cached.manifestHash).toBe(leftResult.manifestHash);
    expect(readFileSync(join(packDir, "manifest.json")).equals(manifestBytes)).toBe(true);
  });

  it("rejects unknown, foreign, duplicate, root and page-only regions", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const other = await publishPackFixture(cache, { siteSlug: "other-site" });
    const input = inputFor(fixture);
    await expect(
      buildEvidencePack({ ...input, regionIds: ["f".repeat(64)] }, packStore(cache)),
    ).rejects.toMatchObject({ code: "INVALID_SELECTION" });
    await expect(
      buildEvidencePack({ ...input, regionIds: [fixture.sectionIds[1]!, fixture.sectionIds[1]!] }, packStore(cache)),
    ).rejects.toMatchObject({ code: "INVALID_SELECTION" });
    await expect(
      buildEvidencePack({ ...input, regionIds: [fixture.pageRootId] }, packStore(cache)),
    ).rejects.toMatchObject({ code: "INVALID_SELECTION" });
    await expect(
      buildEvidencePack({ ...input, regionIds: [other.sectionIds[1]!] }, packStore(cache)),
    ).rejects.toMatchObject({ code: "INVALID_SELECTION" });
    await expect(
      buildEvidencePack({ ...input, captureIds: [other.captureId] }, packStore(cache)),
    ).rejects.toMatchObject({ code: "INVALID_SELECTION" });
    await expect(
      buildEvidencePack({ ...input, captureIds: [fixture.captureId] }, packStore(cache)),
    ).resolves.toMatchObject({ cached: false });
  });

  it("validates goal, mode and rights assertion shapes before writing", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const input = inputFor(fixture);
    const todoGoal = await buildEvidencePack({ ...input, goal: "Build a TODO app" }, packStore(cache));
    expect(todoGoal.packId).toMatch(/^[a-f0-9]{64}$/);
    expect(validateEvidencePack(todoGoal.directory).ok).toBe(true);
    const todoSite = cacheFor();
    const todoFixture = await publishPackFixture(todoSite, { siteSlug: "todo" });
    await expect(
      buildEvidencePack(
        { siteSlug: "todo", goal: GOAL, regionIds: [todoFixture.sectionIds[1]!] },
        packStore(todoSite),
      ),
    ).resolves.toMatchObject({ cached: false });
    await expect(buildEvidencePack({ ...input, goal: "   " }, packStore(cache))).rejects.toMatchObject({
      code: "INVALID_SELECTION",
    });
    await expect(
      buildEvidencePack({ ...input, goal: "x".repeat(MAX_PACK_GOAL_LENGTH + 1) }, packStore(cache)),
    ).rejects.toMatchObject({ code: "INVALID_SELECTION" });
    await expect(
      buildEvidencePack({ ...input, inclusionMode: "all" as any }, packStore(cache)),
    ).rejects.toMatchObject({ code: "INVALID_SELECTION" });
    await expect(
      buildEvidencePack(
        {
          ...input,
          inclusionMode: "permitted",
          rightsAssertions: [{ artifactId: "a".repeat(64), rights: { status: "owned" } as any }],
        },
        packStore(cache),
      ),
    ).rejects.toMatchObject({ code: "INVALID_SELECTION" });
  });

  it("writes the required manifest fields, file hashes, versions and used claim ids", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache, { includeState: true });
    const input = inputFor(fixture);
    const built = await buildEvidencePack(input, packStore(cache));
    const manifest = manifestOf(built.directory);
    expect(manifest).toMatchObject({
      schemaVersion: "awwwards-atlas-evidence-pack-v1",
      exporterVersion: "atlas-exporter-1",
      packId: built.packId,
      createdAt: PACK_NOW,
      goal: GOAL,
      inclusionMode: "references",
      vocabularyVersion: expect.any(String),
      classifierVersion: expect.any(String),
    });
    expect(manifest.selection.regionIds).toEqual([...input.regionIds].sort());
    expect(manifest.selection.captureIds).toEqual([fixture.captureId]);
    expect(manifest.site.slug).toBe("pack-fixture");
    expect(manifest.site.sourceUrls).toContain("https://pack-fixture.example/");
    expect(manifest.observationDates.latest).toBe(PACK_NOW + 1000);
    expect(manifest.files.some((file: { path: string }) => file.path === "manifest.json")).toBe(false);
    for (const file of manifest.files) {
      const bytes = readFileSync(join(built.directory, file.path));
      expect(sha256(bytes)).toBe(file.sha256);
      expect(bytes.length).toBe(file.bytes);
    }
    const evidence = designEvidenceOf(built.directory);
    expect(manifest.claimIds).toEqual(evidence.claims.map((claim: { id: string }) => claim.id));
    expect(manifest.claimIds.length).toBeGreaterThan(5);
    expect(evidence.claims.some((claim: { state: string }) => claim.state === "hover")).toBe(true);
    expect(manifest.coverage).toMatchObject({ status: "complete", collected: 2 });
    expect(manifest.rightsAssertions).toEqual([]);
  });

  it("resolves every evidence pointer in the pack-local selection artifact", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache, { includeState: true });
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const selection = selectionOf(built.directory);
    const resolve = (root: unknown, pointer: string): unknown => {
      let node = root;
      for (const token of pointer.slice(1).split("/")) {
        const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
        if (Array.isArray(node)) node = node[Number(key)];
        else if (node && typeof node === "object") node = (node as Record<string, unknown>)[key];
        else return undefined;
      }
      return node;
    };
    for (const claim of designEvidenceOf(built.directory).claims) {
      const value = resolve(selection, claim.path);
      expect(value, claim.id).not.toBeUndefined();
      expect(String(value)).toBe(String(claim.value));
    }
    expect(validateEvidencePack(built.directory)).toMatchObject({ ok: true });
  });

  it("lists omitted families instead of emitting placeholder values", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const sectionOnly = await buildEvidencePack(
      {
        siteSlug: "pack-fixture",
        goal: GOAL,
        regionIds: [fixture.sectionIds[1]!],
      },
      packStore(cache),
    );
    const manifest = manifestOf(sectionOnly.directory);
    const families = manifest.omitted.map((entry: { family: string }) => entry.family);
    expect(families).toEqual(
      expect.arrayContaining(["elevation", "mobile viewport", "hover state", "focus state", "font-family"]),
    );
    const design = readFileSync(join(sectionOnly.directory, "DESIGN.md"), "utf8");
    expect(design).toContain("Unavailable");
    expect(design).not.toMatch(/TODO|TBD|FIXME|placeholder/i);
  });

  it("renders DESIGN.md in the exact H2 order without invented elevation or fonts", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const design = readFileSync(join(built.directory, "DESIGN.md"), "utf8");
    const positions = REQUIRED_DESIGN_SECTIONS.map((section) => design.indexOf(`\n## ${section}\n`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    expect(design).toContain("generated token");
    expect(design).toContain("No elevation value is inferred");
    expect(design).not.toMatch(/box-shadow\s*:/i);
    expect(design).not.toMatch(/Helvetica|Arial|system-ui/i);
    const noOp = designEvidenceOf(built.directory).claims;
    for (const claim of noOp) expect(design).toContain(claim.id);
    const claims = new Set(designEvidenceOf(built.directory).claims.map((claim: { id: string }) => claim.id));
    for (const match of design.matchAll(/claim-[a-f0-9]{16}/g)) {
      expect(claims.has(match[0])).toBe(true);
    }
    expect(validateEvidencePack(built.directory).ok).toBe(true);
  });

  it("references raw media without copying it in references mode", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const artifactsDir = join(built.directory, "artifacts");
    expect(readdirSync(artifactsDir)).toEqual(["selection.json"]);
    const manifest = manifestOf(built.directory);
    expect(manifest.artifacts.included).toEqual([]);
    expect(manifest.artifacts.excluded.length).toBeGreaterThan(0);
    expect(
      manifest.artifacts.excluded.every((entry: { reason: string }) => entry.reason === "REFERENCE_ONLY"),
    ).toBe(true);
    const components = JSON.parse(readFileSync(join(built.directory, "components.json"), "utf8"));
    expect(components.components[0].pack[0]).toMatchObject({
      included: false,
      reason: "REFERENCE_ONLY",
    });
  });

  it("copies only artifacts with a qualifying permitted rights record", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const artifacts = artifactIds(cache, fixture.captureId);
    expect(artifacts.length).toBeGreaterThan(0);
    const input = inputFor(fixture);

    const denied = await buildEvidencePack({ ...input, inclusionMode: "permitted" }, packStore(cache));
    const deniedManifest = manifestOf(denied.directory);
    expect(deniedManifest.artifacts.included).toEqual([]);
    expect(
      deniedManifest.artifacts.excluded.every(
        (entry: { reason: string }) => entry.reason === "RIGHTS_NOT_ASSERTED",
      ),
    ).toBe(true);

    const unknown = await buildEvidencePack(
      {
        ...input,
        inclusionMode: "permitted",
        rightsAssertions: artifacts.map((artifact) => ({
          artifactId: artifact.id,
          rights: { ...publicRights, status: "unknown" as const, reference: null },
        })),
      },
      packStore(cache),
    );
    expect(
      manifestOf(unknown.directory).artifacts.excluded.every(
        (entry: { reason: string }) => entry.reason === "RIGHTS_UNKNOWN",
      ),
    ).toBe(true);

    const wrongScope = await buildEvidencePack(
      {
        ...input,
        inclusionMode: "permitted",
        rightsAssertions: artifacts.map((artifact) => ({
          artifactId: artifact.id,
          rights: { ...publicRights, scope: "local_reference" as const },
        })),
      },
      packStore(cache),
    );
    expect(
      manifestOf(wrongScope.directory).artifacts.excluded.every(
        (entry: { reason: string }) => entry.reason === "RIGHTS_SCOPE",
      ),
    ).toBe(true);

    const permitted = await buildEvidencePack(
      {
        ...input,
        inclusionMode: "permitted",
        rightsAssertions: artifacts.map((artifact) => ({
          artifactId: artifact.id,
          rights: publicRights,
        })),
      },
      packStore(cache),
    );
    const manifest = manifestOf(permitted.directory);
    const selectedMedia = selectionOf(permitted.directory).media as Array<{ artifactId: string }>;
    expect(manifest.artifacts.included).toHaveLength(selectedMedia.length);
    expect(selectedMedia.length).toBeGreaterThan(0);
    for (const included of manifest.artifacts.included) {
      expect(included.path.startsWith("artifacts/")).toBe(true);
      const bytes = readFileSync(join(permitted.directory, included.path));
      expect(sha256(bytes)).toBe(included.sha256);
      expect(bytes.length).toBe(included.bytes);
      expect(relative(permitted.directory, join(permitted.directory, included.path))).not.toMatch(/^\.\./);
    }
    expect(validateEvidencePack(permitted.directory).ok).toBe(true);
  });

  it("exports external media without a stored hash as an uncopied artifact", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const externalId = sha256("external-media");
    addExternalMedia(cache, fixture.captureId, externalId);
    const artifacts = artifactIds(cache, fixture.captureId);
    const screenshotRow = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT sha256, bytes FROM atlas_artifacts WHERE capture_id = ? AND kind = 'screenshot'",
          )
          .get(fixture.captureId) as { sha256: string; bytes: number },
    );

    const references = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const referencesManifest = manifestOf(references.directory);
    expect(referencesManifest.artifacts.included).toEqual([]);
    expect(referencesManifest.artifacts.excluded).toContainEqual({
      artifactId: externalId,
      reason: "EXTERNAL_MEDIA_NOT_COPIED",
    });
    expect(
      referencesManifest.artifacts.excluded
        .filter((entry: { artifactId: string }) => entry.artifactId !== externalId)
        .every((entry: { reason: string }) => entry.reason === "REFERENCE_ONLY"),
    ).toBe(true);
    const referencesSelection = selectionOf(references.directory);
    expect(
      referencesSelection.references.find(
        (entry: { artifactId: string }) => entry.artifactId === externalId,
      ),
    ).toMatchObject({ kind: "external_media", storagePath: null, sha256: null, bytes: null });
    expect(
      referencesSelection.media.find(
        (entry: { artifactId: string }) => entry.artifactId === externalId,
      ),
    ).toMatchObject({ sha256: "", bytes: 0, included: false, copiedPath: null });
    expect(
      referencesSelection.media.find((entry: { kind: string }) => entry.kind === "screenshot"),
    ).toMatchObject(screenshotRow);
    expect(validateEvidencePack(references.directory).ok).toBe(true);
    expect(adoptEvidencePack(references.directory, packStore(cache)).packId).toBe(
      references.packId,
    );

    const permitted = await buildEvidencePack(
      {
        ...inputFor(fixture),
        inclusionMode: "permitted",
        rightsAssertions: artifacts.map((artifact) => ({
          artifactId: artifact.id,
          rights: publicRights,
        })),
      },
      packStore(cache),
    );
    const permittedManifest = manifestOf(permitted.directory);
    expect(permittedManifest.artifacts.excluded).toContainEqual({
      artifactId: externalId,
      reason: "EXTERNAL_MEDIA_NOT_COPIED",
    });
    const copied = permittedManifest.artifacts.included as Array<{
      artifactId: string;
      kind: string;
      sha256: string;
    }>;
    expect(copied.some((entry) => entry.artifactId === externalId)).toBe(false);
    expect(
      copied.some(
        (entry) => entry.kind === "screenshot" && entry.sha256 === screenshotRow.sha256,
      ),
    ).toBe(true);
    expect(validateEvidencePack(permitted.directory).ok).toBe(true);
    expect(adoptEvidencePack(permitted.directory, packStore(cache)).packId).toBe(
      permitted.packId,
    );

    // Control: non-external media keeps its exact nullable comparison, so a
    // blanked screenshot record never adopts even though external media may.
    const controlCache = cacheFor();
    const controlFixture = await publishPackFixture(controlCache);
    addExternalMedia(controlCache, controlFixture.captureId, externalId);
    const control = copyPack(references.directory);
    rewriteSelectionConsistently(control, (selection) => {
      const screenshot = selection.media.find(
        (entry: { kind: string }) => entry.kind === "screenshot",
      );
      screenshot.sha256 = "";
      screenshot.bytes = 0;
    });
    const controlDir = placePack(controlCache, control);
    expect(validateEvidencePack(controlDir).ok).toBe(true);
    expect(() => adoptEvidencePack(controlDir, packStore(controlCache))).toThrowError(
      expect.objectContaining({ code: "PACK_STALE" }),
    );
    expect(packRows(controlCache)).toEqual([]);
  });

  it("copies identical bytes from different captures under distinct names", async () => {
    const cache = cacheFor();
    const desktop = await publishPackFixture(cache);
    const mobile = await publishPackFixture(cache, {
      viewport: "mobile",
      fetchedAt: PACK_NOW + 1000,
    });
    const artifacts = [
      ...artifactIds(cache, desktop.captureId),
      ...artifactIds(cache, mobile.captureId),
    ];
    const built = await buildEvidencePack(
      {
        siteSlug: "pack-fixture",
        goal: "duplicate screenshot bytes",
        regionIds: [
          desktop.sectionIds[1]!,
          desktop.componentIds[1]!,
          mobile.sectionIds[1]!,
          mobile.componentIds[1]!,
        ],
        inclusionMode: "permitted",
        rightsAssertions: artifacts.map((artifact) => ({
          artifactId: artifact.id,
          rights: publicRights,
        })),
      },
      packStore(cache),
    );
    const screenshots = manifestOf(built.directory).artifacts.included.filter(
      (entry: { kind: string }) => entry.kind === "screenshot",
    ) as Array<{ path: string; sha256: string }>;
    expect(screenshots).toHaveLength(2);
    expect(screenshots[0]!.sha256).toBe(screenshots[1]!.sha256);
    expect(new Set(screenshots.map((entry) => entry.path)).size).toBe(2);
    for (const entry of screenshots) {
      expect(entry.path).toMatch(/^artifacts\/[a-f0-9]{64}-[a-f0-9]{64}\.png$/);
      expect(existsSync(join(built.directory, entry.path))).toBe(true);
    }
    expect(validateEvidencePack(built.directory).ok).toBe(true);
  });

  it("binds every permitted copy to both its media decision and source reference", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const artifacts = artifactIds(cache, fixture.captureId);
    const input = {
      ...inputFor(fixture),
      inclusionMode: "permitted" as const,
      rightsAssertions: artifacts.map((artifact) => ({
        artifactId: artifact.id,
        rights: publicRights,
      })),
    };
    const built = await buildEvidencePack(input, packStore(cache));
    const pristine = copyPack(built.directory);
    const manifest = manifestOf(built.directory);
    const included = manifest.artifacts.included[0] as {
      artifactId: string;
      path: string;
      sha256: string;
      bytes: number;
    };
    const substituted = Buffer.from("substituted artifact bytes", "utf8");
    const replacedSha = sha256(substituted);
    const extension = included.path.slice(included.path.lastIndexOf("."));
    const replacedPath = `artifacts/${included.artifactId}-${replacedSha}${extension}`;
    writeFileSync(join(built.directory, replacedPath), substituted);
    unlinkSync(join(built.directory, included.path));
    const fileEntry = manifest.files.find((file: { path: string }) => file.path === included.path);
    fileEntry.path = replacedPath;
    fileEntry.sha256 = replacedSha;
    fileEntry.bytes = substituted.length;
    const includedEntry = manifest.artifacts.included.find(
      (entry: { artifactId: string }) => entry.artifactId === included.artifactId,
    );
    includedEntry.path = replacedPath;
    includedEntry.sha256 = replacedSha;
    includedEntry.bytes = substituted.length;
    writeFileSync(join(built.directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    rewriteSelection(built.directory, (selection) => {
      const decision = selection.media.find(
        (entry: { artifactId: string }) => entry.artifactId === included.artifactId,
      );
      decision.copiedPath = replacedPath;
      decision.sha256 = replacedSha;
      decision.bytes = substituted.length;
    });
    refreshSelectionEvidence(built.directory);

    const validation = validateEvidencePack(built.directory);
    expect(validation.ok).toBe(false);
    expect(codes(validation)).toContain("ARTIFACT_REFERENCE_MISMATCH");
    await expect(buildEvidencePack(input, packStore(cache))).rejects.toMatchObject({
      code: "PACK_CORRUPT",
    });
    expect(
      cache.withAtlasDb(
        (db) =>
          db
            .prepare("SELECT manifest_hash FROM atlas_packs WHERE id = ?")
            .get(built.packId) as { manifest_hash: string },
      ).manifest_hash,
    ).toBe(built.manifestHash);

    const pathCopy = copyPack(pristine);
    const pathManifest = manifestOf(pathCopy);
    const pathEntry = pathManifest.artifacts.included[0] as {
      artifactId: string;
      path: string;
      sha256: string;
    };
    const originalPath = pathEntry.path;
    const wrongPath = `artifacts/renamed-${pathEntry.sha256}${originalPath.slice(originalPath.lastIndexOf("."))}`;
    writeFileSync(join(pathCopy, wrongPath), readFileSync(join(pathCopy, originalPath)));
    unlinkSync(join(pathCopy, originalPath));
    const copiedFile = pathManifest.files.find(
      (file: { path: string }) => file.path === originalPath,
    );
    copiedFile.path = wrongPath;
    pathEntry.path = wrongPath;
    writeFileSync(join(pathCopy, "manifest.json"), `${JSON.stringify(pathManifest, null, 2)}\n`);
    rewriteSelection(pathCopy, (selection) => {
      const decision = selection.media.find(
        (entry: { artifactId: string }) => entry.artifactId === pathEntry.artifactId,
      );
      decision.copiedPath = wrongPath;
    });
    refreshSelectionEvidence(pathCopy);
    expect(codes(validateEvidencePack(pathCopy))).toContain("ARTIFACT_COPY_PATH_INVALID");

    const stateCopy = copyPack(pristine);
    rewriteSelection(stateCopy, (selection) => {
      const decision = selection.media.find(
        (entry: { artifactId: string }) => entry.artifactId === pathEntry.artifactId,
      );
      decision.state = "restricted";
      const reference = selection.references.find(
        (entry: { artifactId: string }) => entry.artifactId === pathEntry.artifactId,
      );
      reference.state = "restricted";
    });
    refreshSelectionEvidence(stateCopy);
    const stateCodes = codes(validateEvidencePack(stateCopy));
    expect(stateCodes).toContain("ARTIFACT_DECISION_MISMATCH");
    expect(stateCodes).toContain("ARTIFACT_REFERENCE_MISMATCH");

    const storageCopy = copyPack(pristine);
    rewriteSelection(storageCopy, (selection) => {
      const decision = selection.media.find(
        (entry: { artifactId: string }) => entry.artifactId === pathEntry.artifactId,
      );
      decision.storagePath = "atlas/artifacts/rewritten.png";
    });
    refreshSelectionEvidence(storageCopy);
    expect(codes(validateEvidencePack(storageCopy))).toContain("ARTIFACT_DECISION_MISMATCH");
  });

  it("binds media and reference metadata to current artifact rows at adoption", async () => {
    const source = cacheFor();
    const fixture = await publishPackFixture(source);
    const artifacts = artifactIds(source, fixture.captureId);
    const input = {
      ...inputFor(fixture),
      inclusionMode: "permitted" as const,
      rightsAssertions: artifacts.map((artifact) => ({
        artifactId: artifact.id,
        rights: publicRights,
      })),
    };
    const built = await buildEvidencePack(input, packStore(source));
    const originalPackId = manifestOf(built.directory).packId as string;
    const included = manifestOf(built.directory).artifacts.included.find(
      (entry: { kind: string }) => entry.kind === "screenshot",
    ) as {
      artifactId: string;
      path: string;
      sha256: string;
      bytes: number;
    };
    expect(included).toBeDefined();

    const cache = cacheFor();
    await publishPackFixture(cache);
    const rows = () => packRows(cache);

    // Included copy: replaced bytes, hashes, references, documents and pack id.
    const copy = copyPack(built.directory);
    const replacement = Buffer.from("replaced permitted artifact bytes", "utf8");
    const replacementSha = sha256(replacement);
    const replacementPath = `artifacts/${included.artifactId}-${replacementSha}${extname(included.path)}`;
    writeFileSync(join(copy, replacementPath), replacement);
    unlinkSync(join(copy, included.path));
    rewriteManifest(copy, (manifest) => {
      manifest.files = manifest.files.filter(
        (file: { path: string }) => file.path !== included.path,
      );
      manifest.files.push({
        path: replacementPath,
        sha256: replacementSha,
        bytes: replacement.length,
        mimeType: evidenceFileMime(replacementPath),
      });
      const entry = manifest.artifacts.included.find(
        (item: { artifactId: string }) => item.artifactId === included.artifactId,
      );
      entry.path = replacementPath;
      entry.sha256 = replacementSha;
      entry.bytes = replacement.length;
    });
    const selection = selectionOf(copy) as Record<string, any>;
    const decision = selection.media.find(
      (item: { artifactId: string }) => item.artifactId === included.artifactId,
    );
    decision.sha256 = replacementSha;
    decision.bytes = replacement.length;
    decision.copiedPath = replacementPath;
    const reference = selection.references.find(
      (item: { artifactId: string }) => item.artifactId === included.artifactId,
    );
    reference.sha256 = replacementSha;
    reference.bytes = replacement.length;
    rewriteSelectionIdentity(copy, selection);
    expect(selection.packId).not.toBe(originalPackId);

    const adoptedCopy = placePack(cache, copy);
    expect(validateEvidencePack(adoptedCopy).ok).toBe(true);
    expect(() => adoptEvidencePack(adoptedCopy, packStore(cache))).toThrowError(
      expect.objectContaining({ code: "PACK_STALE" }),
    );
    expect(rows()).toEqual([]);
    rmSync(adoptedCopy, { recursive: true, force: true });

    // Reference-only artifact: replaced hash and bytes, identity regenerated.
    const referenceCopy = copyPack(built.directory);
    const referenceSelection = selectionOf(referenceCopy) as Record<string, any>;
    const scanReference = referenceSelection.references.find(
      (item: { kind: string }) => item.kind === "raw_observation",
    );
    expect(scanReference).toBeDefined();
    scanReference.sha256 = sha256("rewritten reference bytes");
    scanReference.bytes = 1234;
    rewriteSelectionIdentity(referenceCopy, referenceSelection);
    expect(referenceSelection.packId).not.toBe(originalPackId);

    const adoptedReference = placePack(cache, referenceCopy);
    expect(validateEvidencePack(adoptedReference).ok).toBe(true);
    expect(() => adoptEvidencePack(adoptedReference, packStore(cache))).toThrowError(
      expect.objectContaining({ code: "PACK_STALE" }),
    );
    expect(rows()).toEqual([]);
    rmSync(adoptedReference, { recursive: true, force: true });

    // Source rights drift: the exported media rights no longer match the row.
    const rightsCopy = copyPack(built.directory);
    const rightsSelection = selectionOf(rightsCopy) as Record<string, any>;
    const rightsDecision = rightsSelection.media.find(
      (item: { artifactId: string }) => item.artifactId === included.artifactId,
    );
    if (!rightsDecision?.rights) throw new Error("fixture media decision has no rights record");
    rightsDecision.rights = {
      ...rightsDecision.rights,
      reference: "replaced rights reference",
    };
    rewriteSelectionIdentity(rightsCopy, rightsSelection);

    const adoptedRights = placePack(cache, rightsCopy);
    expect(validateEvidencePack(adoptedRights).ok).toBe(true);
    expect(() => adoptEvidencePack(adoptedRights, packStore(cache))).toThrowError(
      expect.objectContaining({ code: "PACK_STALE" }),
    );
    expect(rows()).toEqual([]);
    rmSync(adoptedRights, { recursive: true, force: true });

    // Control: the untouched pack still adopts.
    const control = placePack(cache, built.directory);
    expect(adoptEvidencePack(control, packStore(cache)).cached).toBe(true);
    expect(rows().map((row) => row.id)).toEqual([built.packId]);
  });

  it("never adopts or rewrites a pack whose registered manifest hash differs", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const input = inputFor(fixture);
    const built = await buildEvidencePack(input, packStore(cache));
    const tampered = sha256("tampered pin");
    cache.withAtlasDb((db) =>
      db
        .prepare("UPDATE atlas_packs SET manifest_hash = ? WHERE id = ?")
        .run(tampered, built.packId),
    );
    expect(() => adoptEvidencePack(built.directory, packStore(cache))).toThrowError(
      expect.objectContaining({ code: "PACK_CORRUPT" }),
    );
    await expect(buildEvidencePack(input, packStore(cache))).rejects.toMatchObject({
      code: "PACK_CORRUPT",
    });
    expect(
      cache.withAtlasDb(
        (db) =>
          db
            .prepare("SELECT manifest_hash FROM atlas_packs WHERE id = ?")
            .get(built.packId) as { manifest_hash: string },
      ).manifest_hash,
    ).toBe(tampered);
    expect(validateEvidencePack(built.directory).ok).toBe(true);
  });

  it("recovers a registered pack whose directory is gone but never rewrites one beside it", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const input = inputFor(fixture);
    const built = await buildEvidencePack(input, packStore(cache));
    const rowOf = () =>
      cache.withAtlasDb(
        (db) =>
          db.prepare("SELECT manifest_hash FROM atlas_packs WHERE id = ?").get(built.packId) as {
            manifest_hash: string;
          },
      );

    rmSync(built.directory, { recursive: true, force: true });
    const recovered = await buildEvidencePack(input, { cache, now: () => PACK_NOW + 1000 });
    expect(recovered.cached).toBe(false);
    // The advisory creation clock is excluded from the pin, so the rebuild is
    // still pinned by the registered hash.
    expect(recovered.manifestHash).toBe(built.manifestHash);
    expect(
      (JSON.parse(readFileSync(join(recovered.directory, "manifest.json"), "utf8")) as {
        createdAt: number;
      }).createdAt,
    ).toBe(PACK_NOW + 1000);
    expect(validateEvidencePack(recovered.directory).ok).toBe(true);
    expect(rowOf().manifest_hash).toBe(recovered.manifestHash);

    const pin = sha256("another pin");
    cache.withAtlasDb((db) =>
      db.prepare("UPDATE atlas_packs SET manifest_hash = ? WHERE id = ?").run(pin, built.packId),
    );
    const manifestBefore = readFileSync(join(recovered.directory, "manifest.json"));
    await expect(
      buildEvidencePack(input, { cache, now: () => PACK_NOW + 2000 }),
    ).rejects.toMatchObject({ code: "PACK_CORRUPT" });
    expect(readFileSync(join(recovered.directory, "manifest.json")).equals(manifestBefore)).toBe(true);
    expect(rowOf().manifest_hash).toBe(pin);
  });

  it("refuses to adopt a pack outside the evidence-pack store before reading it", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    cache.withAtlasDb((db) => db.prepare("DELETE FROM atlas_packs").run());
    const outside = copyPack(built.directory);
    unlinkSync(join(outside, "manifest.json"));

    expect(() => adoptEvidencePack(outside, packStore(cache))).toThrowError(
      expect.objectContaining({ code: "PACK_OUTSIDE_STORE" }),
    );
    expect(() =>
      adoptEvidencePack(
        join(cache.rootDir, "atlas", "evidence-packs", "..", ".."),
        packStore(cache),
      ),
    ).toThrowError(expect.objectContaining({ code: "PACK_OUTSIDE_STORE" }));
    expect(
      cache.withAtlasDb((db) => db.prepare("SELECT COUNT(*) AS n FROM atlas_packs").get()),
    ).toEqual({ n: 0 });
  });

  it("refuses a redirected evidence-pack store before reading a pack", async (ctx) => {
    const source = cacheFor();
    const fixture = await publishPackFixture(source);
    const built = await buildEvidencePack(inputFor(fixture), packStore(source));
    source.withAtlasDb((db) => db.prepare("DELETE FROM atlas_packs").run());
    // Any read would fail PACK_CORRUPT without the manifest, so an
    // outside-store result proves the store root is rejected first.
    unlinkSync(join(built.directory, "manifest.json"));
    const count = () =>
      source.withAtlasDb((db) => db.prepare("SELECT COUNT(*) AS n FROM atlas_packs").get());

    const atlasRoot = tmpDir();
    if (!linkDirectory(join(source.rootDir, "atlas"), join(atlasRoot, "atlas"))) {
      ctx.skip();
      return;
    }
    expect(() =>
      adoptEvidencePack(
        join(atlasRoot, "atlas", "evidence-packs", built.packId),
        packStore(cacheFor(atlasRoot)),
      ),
    ).toThrowError(expect.objectContaining({ code: "PACK_OUTSIDE_STORE" }));
    expect(count()).toEqual({ n: 0 });

    const packsRoot = tmpDir();
    mkdirSync(join(packsRoot, "atlas"));
    if (
      !linkDirectory(
        join(source.rootDir, "atlas", "evidence-packs"),
        join(packsRoot, "atlas", "evidence-packs"),
      )
    ) {
      ctx.skip();
      return;
    }
    expect(() =>
      adoptEvidencePack(
        join(packsRoot, "atlas", "evidence-packs", built.packId),
        packStore(cacheFor(packsRoot)),
      ),
    ).toThrowError(expect.objectContaining({ code: "PACK_OUTSIDE_STORE" }));
    expect(count()).toEqual({ n: 0 });
  });

  it("refuses a junctioned pack directory instead of adopting the pack it targets", async (ctx) => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const target = await buildEvidencePack(
      { ...inputFor(fixture), goal: "junction target pack" },
      packStore(cache),
    );
    const sourceInput = { ...inputFor(fixture), goal: "junction source pack" };
    const source = await buildEvidencePack(sourceInput, packStore(cache));
    expect(source.packId).not.toBe(target.packId);

    // Redirect the source pack directory to the target pack's directory: a
    // resolution-first check would return the target's id and goal for a
    // rebuild of the source selection.
    cache.withAtlasDb((db) =>
      db.prepare("DELETE FROM atlas_packs WHERE id = ?").run(source.packId),
    );
    rmSync(source.directory, { recursive: true, force: true });
    if (!linkDirectory(target.directory, source.directory)) {
      ctx.skip();
      return;
    }
    const rows = () =>
      cache.withAtlasDb(
        (db) =>
          db.prepare("SELECT id, manifest_hash FROM atlas_packs ORDER BY id").all() as Array<{
            id: string;
            manifest_hash: string;
          }>,
      );

    expect(() => adoptEvidencePack(source.directory, packStore(cache))).toThrowError(
      expect.objectContaining({ code: "PACK_OUTSIDE_STORE" }),
    );
    await expect(buildEvidencePack(sourceInput, packStore(cache))).rejects.toMatchObject({
      code: "PACK_OUTSIDE_STORE",
    });
    expect(rows()).toEqual([{ id: target.packId, manifest_hash: target.manifestHash }]);
    expect(validateEvidencePack(target.directory).ok).toBe(true);
    rmSync(source.directory, { force: true });
  });

  it("rejects a complete but unregistered pack during adoption", async () => {
    const source = cacheFor();
    const fixture = await publishPackFixture(source);
    const built = await buildEvidencePack(inputFor(fixture), packStore(source));
    expect(validateEvidencePack(built.directory).ok).toBe(true);

    const cache = cacheFor();
    const adopted = join(cache.rootDir, "atlas", "evidence-packs", built.packId);
    for (const [path, bytes] of packFiles(built.directory)) {
      mkdirSync(dirname(join(adopted, path)), { recursive: true });
      writeFileSync(join(adopted, path), bytes);
    }
    expect(validateEvidencePack(adopted).ok).toBe(true);
    expect(() => adoptEvidencePack(adopted, packStore(cache))).toThrowError(
      expect.objectContaining({ code: "PACK_STALE" }),
    );
    expect(
      cache.withAtlasDb((db) => db.prepare("SELECT COUNT(*) AS n FROM atlas_packs").get()),
    ).toEqual({ n: 0 });
  });

  it("rejects a self-consistent pack whose capture provenance contradicts the DB", async () => {
    const source = cacheFor();
    const fixture = await publishPackFixture(source);
    const input = inputFor(fixture);
    const built = await buildEvidencePack(input, packStore(source));

    const cache = cacheFor();
    const targetFixture = await publishPackFixture(cache);
    expect(targetFixture.captureId).toBe(fixture.captureId);
    const rows = () =>
      cache.withAtlasDb((db) => db.prepare("SELECT COUNT(*) AS n FROM atlas_packs").get());

    const moveViewportToMobile = (
      capture: Record<string, any>,
      selection: Record<string, any>,
    ): void => {
      capture.viewport = "mobile";
      for (const region of selection.regions) {
        if (region.captureId !== capture.id) continue;
        region.viewport = "mobile";
        for (const observation of region.observations ?? []) observation.viewport = "mobile";
      }
      for (const claim of selection.claims) {
        if (claim.captureId === capture.id) claim.viewport = "mobile";
      }
      for (const section of selection.sections) {
        if (section.captureId === capture.id) section.viewport = "mobile";
      }
      for (const component of selection.components) {
        if (component.captureId === capture.id) component.viewport = "mobile";
      }
    };
    const shiftDates = (capture: Record<string, any>): void => {
      for (const field of ["observedAt", "sourceFetchedAt", "lastConfirmedAt", "finishedAt"]) {
        if (typeof capture[field] === "number") capture[field] += 86_400_000;
      }
    };
    const cases: Array<
      [string, (capture: Record<string, any>, selection: Record<string, any>) => void]
    > = [
      ["viewport", moveViewportToMobile],
      ["browser", (capture) => (capture.browserVersion = "forged-browser/9.9")],
      ["DPR", (capture) => (capture.dpr = 3)],
      ["observation dates", shiftDates],
      ["source URL", (_capture, selection) => (selection.sourceUrls = ["https://forged.example/"])],
    ];

    for (const [name, mutate] of cases) {
      const pack = copyPack(built.directory);
      rewriteCaptureProvenance(pack, mutate);
      const validation = validateEvidencePack(pack);
      expect(validation.errors, name).toEqual([]);
      const adopted = placePack(cache, pack);
      expect(() => adoptEvidencePack(adopted, packStore(cache)), name).toThrowError(
        expect.objectContaining({ code: "PACK_STALE" }),
      );
      expect(rows(), name).toEqual({ n: 0 });
      rmSync(adopted, { recursive: true, force: true });
    }

    // Control: the unmodified pack still adopts, and a registered pack whose
    // directory was deleted rebuilds from the same DB rows.
    const adopted = placePack(cache, built.directory);
    expect(adoptEvidencePack(adopted, packStore(cache)).cached).toBe(true);
    expect(rows()).toEqual({ n: 1 });
    rmSync(adopted, { recursive: true, force: true });
    const rebuilt = await buildEvidencePack(input, packStore(cache));
    expect(rebuilt.cached).toBe(false);
    expect(validateEvidencePack(rebuilt.directory).ok).toBe(true);
    expect(rows()).toEqual({ n: 1 });
  });

  it("rechecks capture provenance inside the publishing transaction", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const input = inputFor(fixture);
    const packsDir = join(cache.rootDir, "atlas", "evidence-packs");
    await expect(
      buildEvidencePack(
        input,
        packStore(cache, () => {
          cache.withAtlasDb((db) =>
            db
              .prepare("UPDATE atlas_captures SET config_hash = ? WHERE id = ?")
              .run("f".repeat(64), fixture.captureId),
          );
        }),
      ),
    ).rejects.toMatchObject({ code: "PACK_STALE" });
    expect(readdirSync(packsDir)).toEqual([]);
    expect(packRows(cache)).toEqual([]);
  });

  it("rechecks claim provenance inside the publishing transaction", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const input = inputFor(fixture);
    const packsDir = join(cache.rootDir, "atlas", "evidence-packs");
    let changed: string | null = null;
    await expect(
      buildEvidencePack(
        input,
        packStore(cache, (tempDir) => {
          const selection = selectionOf(tempDir) as Record<string, any>;
          const claim = selection.claims.find(
            (entry: { sourceClaimId?: string }) => typeof entry.sourceClaimId === "string",
          );
          if (!claim) throw new Error("fixture has no stored claim");
          changed = claim.sourceClaimId as string;
          cache.withAtlasDb((db) =>
            db
              .prepare("UPDATE atlas_claims SET decision = 'candidate' WHERE id = ?")
              .run(changed),
          );
        }),
      ),
    ).rejects.toMatchObject({ code: "PACK_STALE" });
    expect(changed).not.toBeNull();
    expect(readdirSync(packsDir)).toEqual([]);
    expect(packRows(cache)).toEqual([]);

    // Control: with the claim unchanged, the same build publishes and registers.
    const control = await buildEvidencePack(input, packStore(cache));
    expect(control.cached).toBe(false);
    expect(packRows(cache).map((row) => row.id)).toEqual([control.packId]);
  });

  it("rejects self-consistent claim metadata rewrites at the publication seams", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const input = inputFor(fixture);
    const packsDir = join(cache.rootDir, "atlas", "evidence-packs");
    const rewriteClaim = (directory: string): void => {
      rewriteSelectionConsistently(directory, (selection) => {
        const claim = selection.claims.find(
          (entry: { sourceClaimId?: string }) => typeof entry.sourceClaimId === "string",
        );
        if (!claim) throw new Error("fixture has no stored claim");
        claim.method = "atlas-claim:human_review";
      });
      expect(validateEvidencePack(directory).errors).toEqual([]);
    };
    const seams: Array<[string, ReturnType<typeof packStore>]> = [
      ["onBeforePublish", packStore(cache, rewriteClaim)],
      ["onAfterRename", packStore(cache, undefined, undefined, rewriteClaim)],
    ];
    for (const [name, store] of seams) {
      await expect(buildEvidencePack(input, store), name).rejects.toMatchObject({
        code: "PACK_CORRUPT",
      });
      expect(readdirSync(packsDir), name).toEqual([]);
      expect(packRows(cache), name).toEqual([]);
    }

    const control = await buildEvidencePack(input, packStore(cache));
    expect(control.cached).toBe(false);
    expect(packRows(cache).map((row) => row.id)).toEqual([control.packId]);
  });

  it("serves a published pack after an identical recapture confirmation", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const input = inputFor(fixture);
    const built = await buildEvidencePack(input, packStore(cache));
    const manifest = manifestOf(built.directory);
    const recorded = manifest.captures[0].lastConfirmedAt as number;
    expect(typeof recorded).toBe("number");
    const manifestBefore = readFileSync(join(built.directory, "manifest.json"));
    const confirm = (value: number) =>
      cache.withAtlasDb((db) =>
        db
          .prepare("UPDATE atlas_captures SET last_confirmed_at = ? WHERE id = ?")
          .run(value, fixture.captureId),
      );

    // A later identical confirmation is freshness, not a new observation.
    confirm(recorded + 60_000);
    const served = await buildEvidencePack(input, packStore(cache));
    expect(served.cached).toBe(true);
    expect(served.packId).toBe(built.packId);
    expect(readFileSync(join(built.directory, "manifest.json")).equals(manifestBefore)).toBe(true);

    // A future confirmation is still allowed; the pack records the older one.
    confirm(recorded + 86_400_000);
    expect(adoptEvidencePack(built.directory, packStore(cache)).packId).toBe(built.packId);

    // A backwards confirmation is not a monotonic advance.
    confirm(recorded - 1);
    expect(() => adoptEvidencePack(built.directory, packStore(cache))).toThrowError(
      expect.objectContaining({ code: "PACK_STALE" }),
    );

    // A change to any other capture field still stales the pack.
    confirm(recorded + 60_000);
    cache.withAtlasDb((db) =>
      db
        .prepare("UPDATE atlas_captures SET observed_at = observed_at + 1 WHERE id = ?")
        .run(fixture.captureId),
    );
    expect(() => adoptEvidencePack(built.directory, packStore(cache))).toThrowError(
      expect.objectContaining({ code: "PACK_STALE" }),
    );
  });

  it("stales a selection region rewritten to another active capture", async () => {
    const source = cacheFor();
    const desktopFixture = await publishPackFixture(source);
    const built = await buildEvidencePack(inputFor(desktopFixture), packStore(source));
    const mobileFixture = await publishPackFixture(source, { viewport: "mobile" });
    const mobilePack = await buildEvidencePack(inputFor(mobileFixture), packStore(source));
    const mobileSelection = selectionOf(mobilePack.directory);

    const cache = cacheFor();
    const desktop = await publishPackFixture(cache);
    const mobile = await publishPackFixture(cache, { viewport: "mobile" });
    expect(desktop.captureId).toBe(desktopFixture.captureId);
    expect(mobile.captureId).toBe(mobileFixture.captureId);
    expect(mobile.captureId).not.toBe(desktop.captureId);

    const pack = copyPack(built.directory);
    const targetId = desktop.sectionIds[1]!;
    const selection = selectionOf(pack) as Record<string, any>;
    const target = selection.regions.find(
      (region: { regionId: string }) => region.regionId === targetId,
    );
    if (!target) throw new Error("selected region is missing");
    const other = mobileSelection.regions.find(
      (region: { kind: string; ordinal: number }) =>
        region.kind === target.kind && region.ordinal === target.ordinal,
    );
    if (!other) throw new Error("other capture has no matching region");
    for (const field of [
      "captureId",
      "viewport",
      "role",
      "landmark",
      "patternKey",
      "observations",
      "limitations",
    ]) {
      target[field] = other[field];
    }
    for (const claim of selection.claims) {
      if (claim.regionId !== targetId) continue;
      claim.captureId = other.captureId;
      claim.viewport = other.viewport;
    }
    // Select the other capture too, so the rewritten claim provenance is
    // internally consistent and only the DB region row can expose the swap.
    selection.captures.push(mobileSelection.captures[0]!);
    selection.captures.sort((left: { id: string }, right: { id: string }) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    selection.sections = deriveSectionSummaries(selection.regions, selection.claims);
    selection.components = deriveComponentSummaries(selection.regions, selection.claims);
    rewriteSelectionIdentity(pack, selection);
    rewriteManifest(pack, (manifest) => {
      manifest.selection.captureIds = selection.captures.map(
        (capture: { id: string }) => capture.id,
      );
      manifest.extractorVersions = [
        ...new Set(selection.captures.map((capture: { extractorVersion: string }) => capture.extractorVersion)),
      ].sort();
    });

    const adopted = placePack(cache, pack);
    expect(validateEvidencePack(adopted).errors).toEqual([]);
    expect(() => adoptEvidencePack(adopted, packStore(cache))).toThrowError(
      expect.objectContaining({ code: "PACK_STALE" }),
    );
    expect(packRows(cache)).toEqual([]);
    rmSync(adopted, { recursive: true, force: true });

    const control = placePack(cache, built.directory);
    expect(adoptEvidencePack(control, packStore(cache)).cached).toBe(true);
    expect(packRows(cache).map((row) => row.id)).toEqual([built.packId]);
    rmSync(control, { recursive: true, force: true });
  });

  it("exports and adopts a capture limitation that is not a region limitation", async () => {
    const source = cacheFor();
    const options = { coverageLimitations: ["COMPONENT_INITIAL_SCAN_ONLY"] };
    const fixture = await publishPackFixture(source, options);
    const built = await buildEvidencePack(inputFor(fixture), packStore(source));
    const selection = selectionOf(built.directory);
    expect(selection.captures[0].limitations).toContain("COMPONENT_INITIAL_SCAN_ONLY");
    expect(
      selection.regions.every(
        (region: { limitations: string[] }) =>
          !region.limitations.includes("COMPONENT_INITIAL_SCAN_ONLY"),
      ),
    ).toBe(true);
    expect(validateEvidencePack(built.directory).ok).toBe(true);

    const cache = cacheFor();
    await publishPackFixture(cache, options);
    const adopted = placePack(cache, built.directory);
    expect(adoptEvidencePack(adopted, packStore(cache)).cached).toBe(true);
    expect(packRows(cache).map((row) => row.id)).toEqual([built.packId]);
  });

  it("rejects a component summary that contradicts its region and claims", async () => {
    const source = cacheFor();
    const fixture = await publishPackFixture(source);
    const built = await buildEvidencePack(inputFor(fixture), packStore(source));

    const pack = copyPack(built.directory);
    const selection = selectionOf(pack) as unknown as EvidenceSelection;
    selection.components[0]!.type = "forged-type";
    rewriteSelectionDocuments(pack, selection);
    const validation = validateEvidencePack(pack);
    expect(validation.ok).toBe(false);
    expect(codes(validation)).toContain("SELECTION_MISMATCH");

    const cache = cacheFor();
    await publishPackFixture(cache);
    const adopted = placePack(cache, pack);
    expect(() => adoptEvidencePack(adopted, packStore(cache))).toThrowError(
      expect.objectContaining({ code: "PACK_CORRUPT" }),
    );
    expect(packRows(cache)).toEqual([]);

    const control = placePack(cache, built.directory);
    expect(adoptEvidencePack(control, packStore(cache)).cached).toBe(true);
  });

  it("re-derives component styles from the stored scan before adoption", async () => {
    const source = cacheFor();
    const fixture = await publishPackFixture(source);
    const built = await buildEvidencePack(inputFor(fixture), packStore(source));

    const pack = copyPack(built.directory);
    rewriteSelectionConsistently(pack, (selection) => {
      const region = selection.regions.find(
        (entry: { kind: string; styles: Record<string, string> }) =>
          entry.kind === "component" && Object.keys(entry.styles).length > 0,
      );
      if (!region) throw new Error("fixture has no styled component");
      region.styles.fontFamily = "Comic Sans";
      const claim = selection.claims.find(
        (entry: { regionId: string; property: string }) =>
          entry.regionId === region.regionId && entry.property === "font-family",
      );
      if (!claim) throw new Error("fixture has no font-family claim");
      claim.value = "Comic Sans";
      selection.tokens = buildTokens(selection as unknown as EvidenceSelection);
    });
    expect(validateEvidencePack(pack).ok).toBe(true);

    const cache = cacheFor();
    await publishPackFixture(cache);
    const adopted = placePack(cache, pack);
    expect(() => adoptEvidencePack(adopted, packStore(cache))).toThrowError(
      expect.objectContaining({ code: "PACK_STALE" }),
    );
    expect(packRows(cache)).toEqual([]);

    const control = placePack(cache, built.directory);
    expect(adoptEvidencePack(control, packStore(cache)).cached).toBe(true);
  });

  it("rejects forged claim metadata against the stored Atlas claim", async () => {
    const source = cacheFor();
    const fixture = await publishPackFixture(source);
    const built = await buildEvidencePack(inputFor(fixture), packStore(source));

    const pack = copyPack(built.directory);
    rewriteSelectionConsistently(pack, (selection) => {
      const claim = selection.claims.find(
        (entry: { sourceClaimId?: string }) => typeof entry.sourceClaimId === "string",
      );
      if (!claim) throw new Error("fixture has no stored claim");
      claim.method = "atlas-claim:human_review";
    });
    expect(validateEvidencePack(pack).ok).toBe(true);

    const cache = cacheFor();
    await publishPackFixture(cache);
    const adopted = placePack(cache, pack);
    expect(() => adoptEvidencePack(adopted, packStore(cache))).toThrowError(
      expect.objectContaining({ code: "PACK_STALE" }),
    );
    expect(packRows(cache)).toEqual([]);

    const control = placePack(cache, built.directory);
    expect(adoptEvidencePack(control, packStore(cache)).cached).toBe(true);
  });

  it("rejects claim capture and viewport provenance that leaves the selected region", async () => {
    const source = cacheFor();
    const desktopFixture = await publishPackFixture(source);
    const mobileFixture = await publishPackFixture(source, { viewport: "mobile" });
    const input = inputFor(desktopFixture, {
      regionIds: [
        desktopFixture.sectionIds[1]!,
        desktopFixture.componentIds[1]!,
        mobileFixture.sectionIds[1]!,
      ],
    });
    const built = await buildEvidencePack(input, packStore(source));
    expect(validateEvidencePack(built.directory).ok).toBe(true);

    const otherCapture = (selection: Record<string, any>, claim: Record<string, any>): string => {
      const other = selection.captures.find(
        (capture: { id: string }) => capture.id !== claim.captureId,
      );
      if (!other) throw new Error("fixture has no second capture");
      return other.id;
    };
    const cases: Array<[string, (selection: Record<string, any>) => void]> = [
      [
        "derived font claim on another selected capture",
        (selection) => {
          const claim = selection.claims.find(
            (entry: { property: string; sourceClaimId?: string }) =>
              entry.property === "font-family" && entry.sourceClaimId === undefined,
          );
          if (!claim) throw new Error("fixture has no derived font claim");
          claim.captureId = otherCapture(selection, claim);
        },
      ],
      [
        "source claim viewport",
        (selection) => {
          const claim = selection.claims.find(
            (entry: { sourceClaimId?: string }) => typeof entry.sourceClaimId === "string",
          );
          if (!claim) throw new Error("fixture has no source claim");
          const region = selection.regions.find(
            (entry: { regionId: string }) => entry.regionId === claim.regionId,
          );
          claim.viewport = region.viewport === "mobile" ? "desktop" : "mobile";
        },
      ],
      [
        "derived font claim viewport",
        (selection) => {
          const claim = selection.claims.find(
            (entry: { property: string; sourceClaimId?: string }) =>
              entry.property === "font-family" && entry.sourceClaimId === undefined,
          );
          if (!claim) throw new Error("fixture has no derived font claim");
          const region = selection.regions.find(
            (entry: { regionId: string }) => entry.regionId === claim.regionId,
          );
          claim.viewport = region.viewport === "mobile" ? "desktop" : "mobile";
        },
      ],
    ];

    const cache = cacheFor();
    await publishPackFixture(cache);
    await publishPackFixture(cache, { viewport: "mobile" });
    for (const [name, mutate] of cases) {
      const pack = copyPack(built.directory);
      rewriteSelectionConsistently(pack, mutate);
      expect(codes(validateEvidencePack(pack)), name).toContain("CLAIM_PROVENANCE_MISMATCH");
      const adopted = placePack(cache, pack);
      expect(() => adoptEvidencePack(adopted, packStore(cache)), name).toThrowError(
        expect.objectContaining({ code: "PACK_CORRUPT" }),
      );
      expect(packRows(cache), name).toEqual([]);
      rmSync(adopted, { recursive: true, force: true });
    }

    const control = placePack(cache, built.directory);
    expect(adoptEvidencePack(control, packStore(cache)).cached).toBe(true);
    expect(packRows(cache).map((row) => row.id)).toEqual([built.packId]);
  });

  it("rejects a claim pointer that leaves the selected regions", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const pack = copyPack(built.directory);
    rewriteSelectionConsistently(pack, (selection) => {
      const claim = selection.claims.find(
        (entry: { property: string }) => entry.property === "font-family",
      );
      if (!claim) throw new Error("fixture has no style claim");
      claim.path = `/regions/${selection.regions.length}/styles/fontFamily`;
    });
    expect(codes(validateEvidencePack(pack))).toContain("POINTER_UNRESOLVED");
  });

  it("rejects a style-source pointer that does not resolve to the stored scan", async () => {
    const source = cacheFor();
    const fixture = await publishPackFixture(source);
    const built = await buildEvidencePack(inputFor(fixture), packStore(source));

    const pack = copyPack(built.directory);
    rewriteSelectionConsistently(pack, (selection) => {
      const region = selection.regions.find(
        (entry: { styleSource: { pointer: string } | null }) => entry.styleSource,
      );
      if (!region) throw new Error("fixture has no styled component");
      region.styleSource!.pointer = "/scan/components/99";
    });
    expect(validateEvidencePack(pack).ok).toBe(true);

    const cache = cacheFor();
    await publishPackFixture(cache);
    const adopted = placePack(cache, pack);
    expect(() => adoptEvidencePack(adopted, packStore(cache))).toThrowError(
      expect.objectContaining({ code: "PACK_STALE" }),
    );
    expect(packRows(cache)).toEqual([]);
  });

  it("rechecks every staged file hash under the publication lock", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const artifacts = artifactIds(cache, fixture.captureId);
    const input = {
      ...inputFor(fixture),
      inclusionMode: "permitted" as const,
      rightsAssertions: artifacts.map((artifact) => ({
        artifactId: artifact.id,
        rights: publicRights,
      })),
    };
    const packsDir = join(cache.rootDir, "atlas", "evidence-packs");
    let swapped: string | null = null;
    let renamed = false;
    const swapIncludedCopy = (): void => {
      const temp = readdirSync(packsDir).find((name) => name.startsWith(".tmp-"));
      if (!temp) throw new Error("staged pack is missing");
      const manifest = JSON.parse(readFileSync(join(packsDir, temp, "manifest.json"), "utf8"));
      const included = manifest.artifacts.included[0];
      if (!included) throw new Error("no included artifact to swap");
      swapped = join(packsDir, temp, included.path);
      writeFileSync(swapped, "tampered after validation");
    };
    await expect(
      buildEvidencePack(
        input,
        packStore(cache, undefined, swapIncludedCopy, () => {
          renamed = true;
        }),
      ),
    ).rejects.toMatchObject({ code: "PACK_CORRUPT" });
    expect(swapped).not.toBeNull();
    expect(renamed).toBe(false);
    expect(readdirSync(packsDir)).toEqual([]);
    expect(packRows(cache)).toEqual([]);
  });

  it("rejects self-consistent provenance rewrites at the publication seams", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const input = inputFor(fixture);
    const packsDir = join(cache.rootDir, "atlas", "evidence-packs");
    const forgeProvenance = (directory: string): void => {
      rewriteCaptureProvenance(directory, (capture) => {
        capture.browserVersion = "forged-browser/9.9";
      });
      // The rewritten pack is internally consistent: only the values frozen
      // from the validated staged bytes can tell it apart.
      expect(validateEvidencePack(directory).errors).toEqual([]);
    };
    const seams: Array<[string, ReturnType<typeof packStore>]> = [
      ["onBeforePublish", packStore(cache, forgeProvenance)],
      ["onAfterRename", packStore(cache, undefined, undefined, forgeProvenance)],
    ];
    for (const [name, store] of seams) {
      await expect(buildEvidencePack(input, store), name).rejects.toMatchObject({
        code: "PACK_CORRUPT",
      });
      expect(readdirSync(packsDir), name).toEqual([]);
      expect(packRows(cache), name).toEqual([]);
    }

    // Control: unchanged staged bytes still publish and register.
    const control = await buildEvidencePack(input, packStore(cache));
    expect(control.cached).toBe(false);
    expect(packRows(cache).map((row) => row.id)).toEqual([control.packId]);
    expect(validateEvidencePack(control.directory).ok).toBe(true);
  });

  it("rejects contradictory capture provenance in the manifest and selection", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache, { includeState: true });
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    type Mutation = (capture: Record<string, any>) => void;
    const cases: Array<[string, Mutation, string]> = [
      ["viewport", (capture) => (capture.viewport = "mobile"), "MANIFEST_DECISION_MISMATCH"],
      ["unknown viewport", (capture) => (capture.viewport = "phablet"), "CAPTURE_INVALID"],
      [
        "browser",
        (capture) => (capture.browserVersion = "another-browser"),
        "MANIFEST_DECISION_MISMATCH",
      ],
      [
        "unbounded browser",
        (capture) => (capture.browserVersion = "x".repeat(201)),
        "CAPTURE_INVALID",
      ],
      ["dpr", (capture) => (capture.dpr = 3), "MANIFEST_DECISION_MISMATCH"],
      ["non-positive dpr", (capture) => (capture.dpr = 0), "CAPTURE_INVALID"],
      [
        "observation date",
        (capture) => (capture.observedAt = capture.observedAt + 1),
        "MANIFEST_DECISION_MISMATCH",
      ],
      ["fractional observation date", (capture) => (capture.observedAt = 1.5), "CAPTURE_INVALID"],
      ["malformed hash", (capture) => (capture.configHash = "f".repeat(63)), "CAPTURE_INVALID"],
      [
        "reduced motion condition",
        (capture) => (capture.reducedMotion = "reduce"),
        "MANIFEST_DECISION_MISMATCH",
      ],
      ["extra field", (capture) => (capture.provenance = "forged"), "MANIFEST_DECISION_MISMATCH"],
    ];
    for (const [name, mutate, code] of cases) {
      const copy = copyPack(built.directory);
      rewriteManifest(copy, (manifest) => mutate(manifest.captures[0]));
      expect(codes(validateEvidencePack(copy)), `manifest ${name}`).toContain(code);
    }
    for (const [name, mutate, code] of cases) {
      const copy = copyPack(built.directory);
      rewriteSelection(copy, (selection) => mutate(selection.captures[0]));
      refreshSelectionEvidence(copy);
      expect(codes(validateEvidencePack(copy)), `selection ${name}`).toContain(code);
    }
    expect(validateEvidencePack(built.directory).ok).toBe(true);
  });

  it("excludes restricted, unreadable and refused artifacts with an explanation", async () => {
    const restrictedCache = cacheFor();
    const restrictedFixture = await publishPackFixture(restrictedCache);
    const restrictedArtifacts = artifactIds(restrictedCache, restrictedFixture.captureId);
    restrictedCache.withAtlasDb((db) => {
      db.prepare("UPDATE atlas_artifacts SET state = 'restricted' WHERE id = ?").run(
        restrictedArtifacts[0]!.id,
      );
    });
    const restricted = await buildEvidencePack(
      {
        ...inputFor(restrictedFixture),
        inclusionMode: "permitted",
        rightsAssertions: restrictedArtifacts.map((artifact) => ({
          artifactId: artifact.id,
          rights: publicRights,
        })),
      },
      packStore(restrictedCache),
    );
    expect(
      manifestOf(restricted.directory).artifacts.excluded.some(
        (entry: { artifactId: string; reason: string }) =>
          entry.artifactId === restrictedArtifacts[0]!.id && entry.reason === "ARTIFACT_NOT_READY",
      ),
    ).toBe(true);

    const traversalCache = cacheFor();
    const traversalFixture = await publishPackFixture(traversalCache);
    const traversalArtifacts = artifactIds(traversalCache, traversalFixture.captureId);
    traversalCache.withAtlasDb((db) => {
      db.prepare("UPDATE atlas_artifacts SET storage_path = ? WHERE id = ?").run(
        "atlas/artifacts/../../escape.json",
        traversalArtifacts[0]!.id,
      );
    });
    const traversal = await buildEvidencePack(
      {
        ...inputFor(traversalFixture),
        inclusionMode: "permitted",
        rightsAssertions: traversalArtifacts.map((artifact) => ({
          artifactId: artifact.id,
          rights: publicRights,
        })),
      },
      packStore(traversalCache),
    );
    expect(
      manifestOf(traversal.directory).artifacts.excluded.some(
        (entry: { artifactId: string; reason: string }) =>
          entry.artifactId === traversalArtifacts[0]!.id && entry.reason === "ARTIFACT_INVALID",
      ),
    ).toBe(true);

    const refusedCache = cacheFor();
    const refusedFixture = await publishPackFixture(refusedCache);
    const refusedArtifacts = artifactIds(refusedCache, refusedFixture.captureId);
    refusedCache.withAtlasDb((db) => {
      db.prepare("UPDATE atlas_captures SET policy_json = ? WHERE id = ?").run(
        JSON.stringify({ robots: "disallowed", publicOnly: true }),
        refusedFixture.captureId,
      );
    });
    const refused = await buildEvidencePack(
      {
        ...inputFor(refusedFixture),
        inclusionMode: "permitted",
        rightsAssertions: refusedArtifacts.map((artifact) => ({
          artifactId: artifact.id,
          rights: publicRights,
        })),
      },
      packStore(refusedCache),
    );
    expect(
      manifestOf(refused.directory).artifacts.excluded.every(
        (entry: { reason: string }) => entry.reason === "ROBOTS_OR_DESTINATION_REFUSED",
      ),
    ).toBe(true);
  });

  it("renders deterministic tokens with generated names and provenance", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const tokens = JSON.parse(readFileSync(join(built.directory, "tokens.json"), "utf8"));
    const css = readFileSync(join(built.directory, "tokens.css"), "utf8");
    const claims = new Set(
      designEvidenceOf(built.directory).claims.map((claim: { id: string }) => claim.id),
    );
    expect(tokens.generated).toBe(true);
    expect(tokens.colors[0].name).toMatch(/^--atlas-color-\d+$/);
    expect(tokens.typography.fontFamily[0].name).toMatch(/^--atlas-font-family-\d+$/);
    expect(tokens.typography.fontSize[0].value).toBe("16px");
    expect(tokens.spacing.gap[0].value).toBe("8px");
    expect(tokens.radii[0].value).toBe("6px");
    for (const family of [
      tokens.colors,
      tokens.typography.fontFamily,
      tokens.typography.fontSize,
      tokens.typography.fontWeight,
      tokens.typography.lineHeight,
      tokens.spacing.gap,
      tokens.spacing.padding,
      tokens.radii,
      tokens.display,
    ]) {
      for (const entry of family) {
        expect(css).toContain(`${entry.name}:`);
        for (const claimId of entry.claimIds) expect(claims.has(claimId)).toBe(true);
      }
    }
    expect(tokens.note).toContain("not the source site's token names");
  });

  it("writes a grounded brief and rebuild handoff without claiming application logic recovery", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const brief = readFileSync(join(built.directory, "brief.md"), "utf8");
    expect(brief).toContain("## Goal");
    expect(brief).toContain(GOAL);
    expect(brief).toContain("## Selected evidence");
    expect(brief).toContain("## Supported commonalities");
    expect(brief).toContain("## Differences");
    expect(brief).toContain("## Missing evidence");
    expect(brief).toContain("## Proposed adaptations");
    expect(brief).toContain("proposals, not observations");

    const handoff = readFileSync(join(built.directory, "rebuild-handoff.md"), "utf8");
    expect(handoff).toContain("## Selected sections and components in order");
    expect(handoff).toContain("## Observed design constraints");
    expect(handoff).toContain("## Assets");
    expect(handoff).toContain("## Suggested verification targets");
    expect(handoff).toContain("## Limitations");
    expect(handoff).toContain("cannot recover application logic");
    expect(handoff).toMatch(/Reference only/);
    expect(handoff).toContain("Generated token names are labels");
  });

  it("builds and validates without any network call", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const artifacts = artifactIds(cache, fixture.captureId);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    let httpSpy: any;
    let httpsSpy: any;
    let httpGetSpy: any;
    let httpsGetSpy: any;
    try {
      httpSpy = vi.spyOn(http, "request");
      httpsSpy = vi.spyOn(https, "request");
      httpGetSpy = vi.spyOn(http, "get");
      httpsGetSpy = vi.spyOn(https, "get");
    } catch {
      httpSpy = null;
      httpsSpy = null;
      httpGetSpy = null;
      httpsGetSpy = null;
    }
    try {
      const built = await buildEvidencePack(
        {
          ...inputFor(fixture),
          inclusionMode: "permitted",
          rightsAssertions: artifacts.map((artifact) => ({
            artifactId: artifact.id,
            rights: publicRights,
          })),
        },
        packStore(cache),
      );
      expect(validateEvidencePack(built.directory).ok).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      if (httpSpy) expect(httpSpy).not.toHaveBeenCalled();
      if (httpsSpy) expect(httpsSpy).not.toHaveBeenCalled();
      if (httpGetSpy) expect(httpGetSpy).not.toHaveBeenCalled();
      if (httpsGetSpy) expect(httpsGetSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      httpSpy?.mockRestore();
      httpsSpy?.mockRestore();
      httpGetSpy?.mockRestore();
      httpsGetSpy?.mockRestore();
    }
  });

  it("registers atlas_packs only after publication and never on a corrupt pack", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const input = inputFor(fixture);
    const built = await buildEvidencePack(input, packStore(cache));
    const row = cache.withAtlasDb(
      (db) =>
        db.prepare("SELECT * FROM atlas_packs WHERE id = ?").get(built.packId) as Record<
          string,
          unknown
        >,
    );
    expect(row.state).toBe("ready");
    expect(row.manifest_hash).toBe(built.manifestHash);
    expect(row.exporter_version).toBe("atlas-exporter-1");
    const selection = JSON.parse(String(row.selection_json));
    expect(selection.regionIds).toEqual([...input.regionIds].sort());
    expect(selection.inclusionMode).toBe("references");

    cache.withAtlasDb((db) => db.prepare("DELETE FROM atlas_packs").run());
    const designPath = join(built.directory, "DESIGN.md");
    writeFileSync(designPath, `${readFileSync(designPath, "utf8")}\nTODO tamper\n`);
    await expect(buildEvidencePack(input, packStore(cache))).rejects.toMatchObject({
      code: "PACK_CORRUPT",
    });
    expect(cache.withAtlasDb((db) => db.prepare("SELECT COUNT(*) AS n FROM atlas_packs").get())).toEqual({
      n: 0,
    });
  });

  it("detects tamper, missing files, traversal, unresolved pointers and placeholders", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));

    const copy = (): string => copyPack(built.directory);

    const missing = copy();
    unlinkSync(join(missing, "brief.md"));
    expect(codes(validateEvidencePack(missing))).toContain("REQUIRED_FILE_MISSING");

    const hash = copy();
    writeFileSync(join(hash, "tokens.json"), "{}\n");
    expect(codes(validateEvidencePack(hash))).toContain("HASH_MISMATCH");

    const traversal = copy();
    const traversed = manifestOf(traversal);
    traversed.files[0].path = "../escape.json";
    writeFileSync(join(traversal, "manifest.json"), `${JSON.stringify(traversed, null, 2)}\n`);
    expect(codes(validateEvidencePack(traversal))).toContain("PATH_TRAVERSAL");

    const pointer = copy();
    const evidence = designEvidenceOf(pointer);
    evidence.claims[0].path = "/does-not-exist";
    updateManifestFile(pointer, "design-evidence.json", `${JSON.stringify(evidence, null, 2)}\n`);
    expect(codes(validateEvidencePack(pointer))).toContain("POINTER_UNRESOLVED");

    const placeholder = copy();
    updateManifestFile(placeholder, "brief.md", `${readFileSync(join(placeholder, "brief.md"), "utf8")}\nTODO: fill this in\n`);
    expect(codes(validateEvidencePack(placeholder))).toContain("PLACEHOLDER_FOUND");

    const template = copy();
    updateManifestFile(template, "brief.md", `${readFileSync(join(template, "brief.md"), "utf8")}\n{{goal}}\n`);
    expect(codes(validateEvidencePack(template))).toContain("PLACEHOLDER_FOUND");

    const sourceTypes = copy();
    const sourceEvidence = designEvidenceOf(sourceTypes);
    sourceEvidence.claims[0].sourceRegionId = 42;
    updateManifestFile(
      sourceTypes,
      "design-evidence.json",
      `${JSON.stringify(sourceEvidence, null, 2)}\n`,
    );
    expect(codes(validateEvidencePack(sourceTypes))).toContain("CLAIM_INVALID");

    const unknownClaim = copy();
    const design = readFileSync(join(unknownClaim, "DESIGN.md"), "utf8");
    updateManifestFile(
      unknownClaim,
      "DESIGN.md",
      design.replace(/claim-[a-f0-9]{16}/, "claim-0000000000000000"),
    );
    expect(codes(validateEvidencePack(unknownClaim))).toContain("CLAIM_UNKNOWN");

    const extra = copy();
    writeFileSync(join(extra, "artifacts", "extra.bin"), "extra");
    expect(codes(validateEvidencePack(extra))).toContain("UNLISTED_FILE");

    const section = copy();
    updateManifestFile(
      section,
      "DESIGN.md",
      readFileSync(join(section, "DESIGN.md"), "utf8").replace("\n## Shapes\n", "\n"),
    );
    expect(codes(validateEvidencePack(section))).toContain("DESIGN_SECTION_MISSING");

    const invalidSelection = copy();
    const manifest = manifestOf(invalidSelection);
    manifest.selection.regionIds.push("f".repeat(64));
    writeFileSync(join(invalidSelection, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    expect(codes(validateEvidencePack(invalidSelection))).toContain("SELECTION_MISMATCH");
  });

  it("refuses a symlinked copied artifact", async (ctx) => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const artifacts = artifactIds(cache, fixture.captureId);
    const built = await buildEvidencePack(
      {
        ...inputFor(fixture),
        inclusionMode: "permitted",
        rightsAssertions: artifacts.map((artifact) => ({
          artifactId: artifact.id,
          rights: publicRights,
        })),
      },
      packStore(cache),
    );
    const included = manifestOf(built.directory).artifacts.included[0] as { path: string };
    const copied = join(built.directory, included.path);
    const external = join(tmpDir(), "external.bin");
    writeFileSync(external, "external");
    unlinkSync(copied);
    try {
      symlinkSync(external, copied, "file");
    } catch (error) {
      if (LINK_ERRORS.has((error as NodeJS.ErrnoException).code ?? "")) {
        ctx.skip();
        return;
      }
      throw error;
    }
    expect(codes(validateEvidencePack(built.directory))).toContain("SYMLINK_REFUSED");
  });

  it("refuses a Windows junction at a copied artifact", async (ctx) => {
    if (process.platform !== "win32") {
      ctx.skip();
      return;
    }
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const artifacts = artifactIds(cache, fixture.captureId);
    const built = await buildEvidencePack(
      {
        ...inputFor(fixture),
        inclusionMode: "permitted",
        rightsAssertions: artifacts.map((artifact) => ({
          artifactId: artifact.id,
          rights: publicRights,
        })),
      },
      packStore(cache),
    );
    const included = manifestOf(built.directory).artifacts.included[0] as { path: string };
    const copied = join(built.directory, included.path);
    const external = join(tmpDir(), "junction-target");
    mkdirSync(external);
    writeFileSync(join(external, "outside.bin"), "outside");
    unlinkSync(copied);
    // Junctions need no administrator rights, so this path is CI-covered on Windows.
    const link = spawnSync("cmd", ["/c", "mklink", "/J", copied, external], { encoding: "utf8" });
    if (link.status !== 0) {
      ctx.skip();
      return;
    }
    expect(codes(validateEvidencePack(built.directory))).toContain("SYMLINK_REFUSED");
  });

  it("omits component styles when the stored scan artifact is tampered", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const scan = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT id, storage_path, metadata_json FROM atlas_artifacts WHERE capture_id = ? AND kind = 'raw_observation'",
          )
          .all(fixture.captureId) as Array<{
          id: string;
          storage_path: string;
          metadata_json: string;
        }>,
    ).find((row) => JSON.parse(row.metadata_json).key === "scan-desktop");
    expect(scan).toBeTruthy();
    const scanPath = join(cache.rootDir, scan!.storage_path);
    const original = readFileSync(scanPath, "utf8");
    expect(original).toContain("16px");
    writeFileSync(scanPath, original.replace("16px", "99px"));

    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const component = selectionOf(built.directory).regions.find(
      (region: { kind: string }) => region.kind === "component",
    );
    expect(component.styles).toEqual({});
    expect(manifestOf(built.directory).omitted).toContainEqual({
      family: `component:${component.regionId}:computed-styles`,
      reason: "STYLE_SOURCE_UNAVAILABLE",
    });
    expect(readFileSync(join(built.directory, "tokens.json"), "utf8")).not.toContain("99px");
    expect(validateEvidencePack(built.directory).ok).toBe(true);
  });

  it("never falls back to a non-scan raw observation for component styles", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache, { includeState: true });
    const fake = writeJsonArtifactSync(cache.rootDir, {
      scan: {
        components: [
          {
            selector: "main > section.hero button.primary",
            display: "grid",
            gap: "77px",
          },
        ],
      },
    });
    cache.withAtlasDb((db) => {
      db.prepare(
        `INSERT INTO atlas_artifacts
           (id, capture_id, region_id, kind, storage_path, external_url, sha256, bytes,
            mime_type, state, rights_json, metadata_json)
         VALUES (?, ?, NULL, 'raw_observation', ?, NULL, ?, ?, 'application/json', 'ready', '{}', ?)`,
      ).run(
        sha256("not-a-scan"),
        fixture.captureId,
        fake.storagePath,
        fake.sha256,
        fake.bytes,
        JSON.stringify({ key: "not-a-scan" }),
      );
      db.prepare(
        "UPDATE atlas_artifacts SET state = 'missing' WHERE capture_id = ? AND metadata_json LIKE '%scan-desktop%'",
      ).run(fixture.captureId);
    });

    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const component = selectionOf(built.directory).regions.find(
      (region: { kind: string }) => region.kind === "component",
    );
    expect(component.styles).toEqual({});
    expect(readFileSync(join(built.directory, "DESIGN.md"), "utf8")).not.toContain("77px");
    expect(validateEvidencePack(built.directory).ok).toBe(true);
  });

  it("takes component types from observed samples, never gallery titles, and sanitizes Markdown", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const componentId = fixture.componentIds[1]!;
    cache.withAtlasDb((db) => {
      db.prepare("UPDATE atlas_regions SET raw_title = ? WHERE id = ?").run(
        "Card\n## Injected heading\n- injected bullet",
        componentId,
      );
    });
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const component = selectionOf(built.directory).components.find(
      (entry: { regionId: string }) => entry.regionId === componentId,
    );
    expect(component.type).toBe("button");
    const brief = readFileSync(join(built.directory, "brief.md"), "utf8");
    expect(brief).not.toMatch(/^## Injected heading/m);
    expect(brief).not.toMatch(/^- injected bullet/m);

    const hostileCache = cacheFor();
    const hostileFixture = await publishPackFixture(hostileCache);
    const hostileId = hostileFixture.componentIds[1]!;
    hostileCache.withAtlasDb((db) => {
      const row = db.prepare("SELECT samples_json FROM atlas_regions WHERE id = ?").get(hostileId) as {
        samples_json: string;
      };
      const samples = JSON.parse(row.samples_json);
      samples.type = "button\n## Injected observed heading\n- injected observed bullet";
      db.prepare("UPDATE atlas_regions SET samples_json = ? WHERE id = ?").run(
        JSON.stringify(samples),
        hostileId,
      );
    });
    const hostile = await buildEvidencePack(
      { ...inputFor(hostileFixture), goal: "Hostile observed type" },
      packStore(hostileCache),
    );
    const hostileBrief = readFileSync(join(hostile.directory, "brief.md"), "utf8");
    expect(hostileBrief).toContain("button ## Injected observed heading - injected observed bullet");
    expect(hostileBrief).not.toMatch(/^## Injected observed heading/m);
    expect(hostileBrief).not.toMatch(/^- injected observed bullet/m);
    expect(validateEvidencePack(hostile.directory).ok).toBe(true);
  });

  it("emits a claim for every section geometry value printed in DESIGN.md", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const claims = designEvidenceOf(built.directory).claims as Array<{
      property: string;
      value: string;
      path: string;
      sourceRegionId: string;
    }>;
    const design = readFileSync(join(built.directory, "DESIGN.md"), "utf8");
    const pattern =
      /Section `([^`]+)`[^\n]*?: ([-\d.]+)x([-\d.]+) at \(([-\d.]+), ([-\d.]+)\);/g;
    let matches = 0;
    for (const match of design.matchAll(pattern)) {
      matches += 1;
      const [, regionId, width, height, x, y] = match;
      for (const [property, value] of [
        ["width", width],
        ["height", height],
        ["x", x],
        ["y", y],
      ] as const) {
        const claim = claims.find(
          (entry) =>
            entry.sourceRegionId === regionId &&
            entry.property === property &&
            entry.value === value,
        );
        expect(claim, `${regionId} ${property}=${value}`).toBeTruthy();
        expect(claim!.path).toMatch(/^\/regions\/\d+\/geometry\/(x|y|width|height)$/);
      }
    }
    expect(matches).toBeGreaterThan(0);
    expect(validateEvidencePack(built.directory).ok).toBe(true);
  });

  it("rejects a manifest missing any 12.1 field and returns PACK_CORRUPT for artifacts: {}", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const input = inputFor(fixture);
    const built = await buildEvidencePack(input, packStore(cache));
    const required: string[][] = [
      ["exporterVersion"],
      ["vocabularyVersion"],
      ["classifierVersion"],
      ["extractorVersions"],
      ["schemaVersionUsed"],
      ["ftsVersion"],
      ["observationDates"],
      ["designEvidence"],
      ["selection", "captureIds"],
      ["site", "sourceUrls"],
      ["artifacts", "included"],
      ["artifacts", "excluded"],
      ["artifacts", "references"],
      ["captures"],
      ["limitations"],
      ["rightsAssertions"],
      ["omitted"],
    ];
    for (const path of required) {
      const copy = copyPack(built.directory);
      rewriteManifest(copy, (manifest) => removeField(manifest, path));
      expect(validateEvidencePack(copy).ok, path.join(".")).toBe(false);
    }
    const typed = copyPack(built.directory);
    rewriteManifest(typed, (manifest) => {
      manifest.captures[0].configHash = 42;
    });
    expect(codes(validateEvidencePack(typed))).toContain("MANIFEST_INVALID");

    for (const field of ["requestedUrlHash", "viewport", "toolVersion", "omissions"]) {
      const evidenceCopy = copyPack(built.directory);
      const evidence = designEvidenceOf(evidenceCopy);
      delete evidence[field];
      updateManifestFile(
        evidenceCopy,
        "design-evidence.json",
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
      expect(validateEvidencePack(evidenceCopy).ok, `design-evidence.${field}`).toBe(false);
    }
    const claimCopy = copyPack(built.directory);
    const claimEvidence = designEvidenceOf(claimCopy);
    delete claimEvidence.claims[0].sampleKey;
    updateManifestFile(
      claimCopy,
      "design-evidence.json",
      `${JSON.stringify(claimEvidence, null, 2)}\n`,
    );
    expect(codes(validateEvidencePack(claimCopy))).toContain("CLAIM_INVALID");
    const referenceCopy = copyPack(built.directory);
    rewriteManifest(referenceCopy, (manifest) => {
      delete manifest.artifacts.references[0].captureId;
    });
    expect(codes(validateEvidencePack(referenceCopy))).toContain("ARTIFACT_INVALID");

    rewriteManifest(built.directory, (manifest) => {
      manifest.artifacts = {};
    });
    await expect(buildEvidencePack(input, packStore(cache))).rejects.toMatchObject({
      code: "PACK_CORRUPT",
    });
  });

  it("resolves claims only against the selection artifact", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const copy = copyPack(built.directory);
    const manifest = manifestOf(copy);
    const evidence = designEvidenceOf(copy);
    evidence.captures[0].id = "root";
    evidence.captures[0].artifactId = "root";
    evidence.captures[0].artifactPath = "manifest.json";
    evidence.captures[0].sha256 = sha256(readFileSync(join(copy, "manifest.json")));
    evidence.claims[0].artifactId = "root";
    evidence.claims[0].path = "/packId";
    evidence.claims[0].value = manifest.packId;
    updateManifestFile(copy, "design-evidence.json", `${JSON.stringify(evidence, null, 2)}\n`);
    expect(codes(validateEvidencePack(copy))).toContain("CLAIM_INVALID");
  });

  it("requires set equality between manifest and selection", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const expected = (mutate: (manifest: Record<string, any>) => void): string[] => {
      const copy = copyPack(built.directory);
      rewriteManifest(copy, mutate);
      return codes(validateEvidencePack(copy));
    };
    expect(expected((manifest) => manifest.selection.regionIds.pop())).toContain(
      "SELECTION_MISMATCH",
    );
    expect(expected((manifest) => (manifest.goal = "another goal"))).toContain(
      "SELECTION_MISMATCH",
    );
    expect(expected((manifest) => (manifest.site.slug = "other"))).toContain(
      "SELECTION_MISMATCH",
    );
    expect(expected((manifest) => (manifest.inclusionMode = "permitted"))).toContain(
      "SELECTION_MISMATCH",
    );
    expect(expected((manifest) => manifest.selection.captureIds.push("f".repeat(64)))).toContain(
      "SELECTION_MISMATCH",
    );
    expect(expected((manifest) => manifest.claimIds.pop())).toContain(
      "CLAIM_MANIFEST_MISMATCH",
    );
    expect(expected((manifest) => (manifest.captures[0].policy = "denied"))).toContain(
      "SELECTION_MISMATCH",
    );

    // A duplicate in the selection must not be masked by set comparison.
    const duplicate = copyPack(built.directory);
    rewriteManifest(duplicate, (manifest) => {
      manifest.site.sourceUrls = ["https://example.com/a", "https://example.com/b"];
    });
    rewriteSelection(duplicate, (selection) => {
      selection.sourceUrls = ["https://example.com/a", "https://example.com/a"];
    });
    refreshSelectionEvidence(duplicate);
    expect(codes(validateEvidencePack(duplicate))).toContain("SELECTION_MISMATCH");
  });

  it("re-derives the pack id and refuses a fake id or directory", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const copy = copyPack(built.directory);
    const fake = "f".repeat(64);
    const manifest = manifestOf(copy);
    manifest.packId = fake;
    writeFileSync(join(copy, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const selection = selectionOf(copy);
    selection.packId = fake;
    updateManifestFile(copy, "artifacts/selection.json", `${JSON.stringify(selection, null, 2)}\n`);
    expect(codes(validateEvidencePack(copy))).toContain("PACK_ID_MISMATCH");

    const consistentFake = copyPack(copy, fake);
    expect(codes(validateEvidencePack(consistentFake))).toContain("PACK_ID_MISMATCH");

    const wrongDir = copyPack(built.directory, fake);
    expect(codes(validateEvidencePack(wrongDir))).toContain("PACK_ID_MISMATCH");
  });

  it("matches the builder caps for selection, tokens.css and copied artifacts", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));

    const tokensCopy = copyPack(built.directory);
    const css = readFileSync(join(tokensCopy, "tokens.css"), "utf8");
    const padding = Math.max(0, 200 * 1024 - css.length);
    updateManifestFile(tokensCopy, "tokens.css", `${css}${" ".repeat(padding)}\n`);
    expect(codes(validateEvidencePack(tokensCopy))).toContain("DOCUMENT_RENDER_MISMATCH");

    const oversizedCopy = copyPack(built.directory);
    updateManifestFile(
      oversizedCopy,
      "tokens.css",
      `${css}${" ".repeat(MAX_TEXT_DOCUMENT_BYTES + 1)}`,
    );
    expect(codes(validateEvidencePack(oversizedCopy))).toContain("DOCUMENT_TOO_LARGE");

    const selectionCopy = copyPack(built.directory);
    const selectionText = readFileSync(join(selectionCopy, "artifacts", "selection.json"), "utf8");
    updateManifestFile(
      selectionCopy,
      "artifacts/selection.json",
      `${selectionText}${" ".repeat(MAX_SELECTION_BYTES)}`,
    );
    expect(codes(validateEvidencePack(selectionCopy))).toContain("DOCUMENT_TOO_LARGE");

    const countCopy = copyPack(built.directory);
    rewriteManifest(countCopy, (manifest) => {
      manifest.artifacts.included = Array.from({ length: 25 }, (_, index) => ({
        artifactId: sha256(`artifact-${index}`),
        captureId: sha256(`capture-${index}`),
        kind: "component_pack",
        path: `artifacts/${sha256(`path-${index}`)}.bin`,
        sha256: sha256(`bytes-${index}`),
        bytes: 1,
        mimeType: "application/octet-stream",
      }));
    });
    expect(codes(validateEvidencePack(countCopy))).toContain("PACK_LIMIT_EXCEEDED");

    const sizeCopy = copyPack(built.directory);
    rewriteManifest(sizeCopy, (manifest) => {
      manifest.artifacts.included = [
        {
          artifactId: sha256("artifact"),
          captureId: sha256("capture"),
          kind: "component_pack",
          path: `artifacts/${sha256("payload")}.bin`,
          sha256: sha256("payload"),
          bytes: MAX_COPIED_ARTIFACT_BYTES + 1,
          mimeType: "application/octet-stream",
        },
      ];
    });
    expect(codes(validateEvidencePack(sizeCopy))).toContain("PACK_LIMIT_EXCEEDED");
  });

  it("refuses a 256 MiB listed file before reading it", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const copy = copyPack(built.directory);
    const oversized = join(copy, "artifacts", "oversized.bin");
    writeFileSync(oversized, "");
    truncateSync(oversized, 256 * 1024 * 1024);
    rewriteManifest(copy, (manifest) => {
      manifest.files.push({
        path: "artifacts/oversized.bin",
        sha256: "f".repeat(64),
        bytes: 256 * 1024 * 1024,
        mimeType: "application/octet-stream",
      });
    });

    const declared = Date.now();
    const declaredValidation = validateEvidencePack(copy);
    expect(Date.now() - declared).toBeLessThan(2000);
    expect(codes(declaredValidation)).toContain("DOCUMENT_TOO_LARGE");
    expect(codes(declaredValidation)).not.toContain("HASH_MISMATCH");

    rewriteManifest(copy, (manifest) => {
      const entry = manifest.files.find(
        (file: { path: string }) => file.path === "artifacts/oversized.bin",
      );
      entry.bytes = 1;
    });
    const lying = Date.now();
    const lyingValidation = validateEvidencePack(copy);
    expect(Date.now() - lying).toBeLessThan(2000);
    expect(codes(lyingValidation)).toContain("DOCUMENT_TOO_LARGE");
    expect(codes(lyingValidation)).not.toContain("HASH_MISMATCH");
  });

  it("rejects duplicate claim ids", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const copy = copyPack(built.directory);
    const evidence = designEvidenceOf(copy);
    evidence.claims.push({ ...evidence.claims[0] });
    updateManifestFile(copy, "design-evidence.json", `${JSON.stringify(evidence, null, 2)}\n`);
    expect(codes(validateEvidencePack(copy))).toContain("CLAIM_DUPLICATE");
  });

  it("rejects unsafe reference paths and omits them at build time", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));

    const manifestCopy = copyPack(built.directory);
    rewriteManifest(manifestCopy, (manifest) => {
      manifest.artifacts.references[0].storagePath = "../escape.json";
    });
    expect(codes(validateEvidencePack(manifestCopy))).toContain("PATH_TRAVERSAL");

    const selectionCopy = copyPack(built.directory);
    const selection = selectionOf(selectionCopy);
    selection.references[0].storagePath = "C:\\escape.json";
    updateManifestFile(
      selectionCopy,
      "artifacts/selection.json",
      `${JSON.stringify(selection, null, 2)}\n`,
    );
    expect(codes(validateEvidencePack(selectionCopy))).toContain("PATH_TRAVERSAL");

    const tampered = cacheFor();
    const tamperedFixture = await publishPackFixture(tampered);
    tampered.withAtlasDb((db) => {
      db.prepare("UPDATE atlas_artifacts SET storage_path = ? WHERE capture_id = ?").run(
        "../escape.json",
        tamperedFixture.captureId,
      );
    });
    const sanitized = await buildEvidencePack(
      { ...inputFor(tamperedFixture), goal: "unsafe references" },
      packStore(tampered),
    );
    const references = selectionOf(sanitized.directory).references as Array<{
      storagePath: string | null;
    }>;
    expect(references.length).toBeGreaterThan(0);
    expect(references.every((reference) => reference.storagePath === null)).toBe(true);
    const media = selectionOf(sanitized.directory).media as Array<{ storagePath: string | null }>;
    expect(media.length).toBeGreaterThan(0);
    expect(media.every((decision) => decision.storagePath === null)).toBe(true);
    const assets = JSON.parse(
      readFileSync(join(sanitized.directory, "components.json"), "utf8"),
    ).assets as Array<{ storagePath: string | null }>;
    expect(assets.length).toBeGreaterThan(0);
    expect(assets.every((asset) => asset.storagePath === null)).toBe(true);
    expect(validateEvidencePack(sanitized.directory).ok).toBe(true);

    const mediaCopy = copyPack(built.directory);
    const mediaSelection = selectionOf(mediaCopy);
    mediaSelection.media[0].storagePath = "../escape.json";
    updateManifestFile(
      mediaCopy,
      "artifacts/selection.json",
      `${JSON.stringify(mediaSelection, null, 2)}\n`,
    );
    expect(codes(validateEvidencePack(mediaCopy))).toContain("PATH_TRAVERSAL");

    const assetCopy = copyPack(built.directory);
    const assetDocument = JSON.parse(readFileSync(join(assetCopy, "components.json"), "utf8"));
    assetDocument.assets[0].storagePath = "C:\\escape.json";
    updateManifestFile(
      assetCopy,
      "components.json",
      `${JSON.stringify(assetDocument, null, 2)}\n`,
    );
    expect(codes(validateEvidencePack(assetCopy))).toContain("PATH_TRAVERSAL");
  });

  it("fails closed unless the capture policy explicitly allows permitted copies", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const artifacts = artifactIds(cache, fixture.captureId);
    const cases: Array<{ policy: string; allowed: boolean; reason?: string }> = [
      { policy: "null", allowed: false, reason: "POLICY_UNKNOWN" },
      { policy: "{}", allowed: false, reason: "POLICY_UNKNOWN" },
      {
        policy: JSON.stringify({ status: "not_evaluated" }),
        allowed: false,
        reason: "POLICY_UNKNOWN",
      },
      { policy: "[]", allowed: false, reason: "POLICY_UNKNOWN" },
      { policy: JSON.stringify({ robots: "allowed" }), allowed: true },
      { policy: JSON.stringify({ status: "allowed" }), allowed: true },
      { policy: JSON.stringify({ publicOnly: true }), allowed: true },
      {
        policy: JSON.stringify({ robots: "disallowed" }),
        allowed: false,
        reason: "ROBOTS_OR_DESTINATION_REFUSED",
      },
      {
        policy: JSON.stringify({ status: "blocked" }),
        allowed: false,
        reason: "ROBOTS_OR_DESTINATION_REFUSED",
      },
      {
        policy: JSON.stringify({ status: "failed" }),
        allowed: false,
        reason: "ROBOTS_OR_DESTINATION_REFUSED",
      },
      {
        policy: JSON.stringify({ publicOnly: false }),
        allowed: false,
        reason: "ROBOTS_OR_DESTINATION_REFUSED",
      },
    ];
    for (const [index, entry] of cases.entries()) {
      cache.withAtlasDb((db) => {
        db.prepare("UPDATE atlas_captures SET policy_json = ? WHERE id = ?").run(
          entry.policy,
          fixture.captureId,
        );
      });
      const built = await buildEvidencePack(
        {
          ...inputFor(fixture),
          inclusionMode: "permitted",
          goal: `policy case ${index}`,
          rightsAssertions: artifacts.map((artifact) => ({
            artifactId: artifact.id,
            rights: publicRights,
          })),
        },
        packStore(cache),
      );
      const manifest = manifestOf(built.directory);
      if (entry.allowed) {
        expect(manifest.artifacts.included.length, entry.policy).toBeGreaterThan(0);
      } else {
        expect(manifest.artifacts.included, entry.policy).toEqual([]);
        expect(
          manifest.artifacts.excluded.every(
            (excluded: { reason: string }) => excluded.reason === entry.reason,
          ),
          entry.policy,
        ).toBe(true);
      }
    }
  });

  it("enforces copy count, per-artifact size and total size caps", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const existing = artifactIds(cache, fixture.captureId);
    cache.withAtlasDb((db) => {
      db.prepare("UPDATE atlas_artifacts SET bytes = ? WHERE id = ?").run(
        MAX_COPIED_ARTIFACT_BYTES + 1,
        existing[0]!.id,
      );
    });
    const sized = await buildEvidencePack(
      {
        ...inputFor(fixture),
        inclusionMode: "permitted",
        goal: "size cap",
        rightsAssertions: existing.map((artifact) => ({
          artifactId: artifact.id,
          rights: publicRights,
        })),
      },
      packStore(cache),
    );
    expect(manifestOf(sized.directory).artifacts.excluded).toContainEqual(
      expect.objectContaining({ artifactId: existing[0]!.id, reason: "SIZE_LIMIT" }),
    );

    const countCache = cacheFor();
    const countFixture = await publishPackFixture(countCache);
    const inserted: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const stored = writeArtifactBytesSync(
        countCache.rootDir,
        Buffer.from(`count-${index}`),
        ".bin",
      );
      const id = sha256(`count-artifact-${index}`);
      inserted.push(id);
      countCache.withAtlasDb((db) => {
        db.prepare(
          `INSERT INTO atlas_artifacts
             (id, capture_id, region_id, kind, storage_path, external_url, sha256, bytes,
              mime_type, state, rights_json, metadata_json)
           VALUES (?, ?, ?, 'component_pack', ?, NULL, ?, ?, 'application/octet-stream', 'ready', '{}', ?)`,
        ).run(
          id,
          countFixture.captureId,
          countFixture.componentIds[1]!,
          stored.storagePath,
          stored.sha256,
          stored.bytes,
          JSON.stringify({ key: `count-${index}` }),
        );
      });
    }
    const capped = await buildEvidencePack(
      {
        ...inputFor(countFixture),
        regionIds: [countFixture.componentIds[1]!],
        inclusionMode: "permitted",
        goal: "count cap",
        rightsAssertions: inserted.slice(0, 24).map((artifactId) => ({
          artifactId,
          rights: publicRights,
        })),
      },
      packStore(countCache),
    );
    expect(manifestOf(capped.directory).artifacts.included).toHaveLength(24);

    const totalCache = cacheFor();
    const totalFixture = await publishPackFixture(totalCache);
    const bigBytes = Buffer.alloc(MAX_COPIED_ARTIFACT_BYTES, 7);
    const bigIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      bigBytes[0] = index + 1;
      const stored = writeArtifactBytesSync(totalCache.rootDir, bigBytes, ".bin");
      const id = sha256(`total-artifact-${index}`);
      bigIds.push(id);
      totalCache.withAtlasDb((db) => {
        db.prepare(
          `INSERT INTO atlas_artifacts
             (id, capture_id, region_id, kind, storage_path, external_url, sha256, bytes,
              mime_type, state, rights_json, metadata_json)
           VALUES (?, ?, ?, 'component_pack', ?, NULL, ?, ?, 'application/octet-stream', 'ready', '{}', ?)`,
        ).run(
          id,
          totalFixture.captureId,
          totalFixture.componentIds[1]!,
          stored.storagePath,
          stored.sha256,
          stored.bytes,
          JSON.stringify({ key: `total-${index}` }),
        );
      });
    }
    const tiny = writeArtifactBytesSync(totalCache.rootDir, Buffer.from("x"), ".bin");
    const tinyId = sha256("total-artifact-tiny");
    bigIds.push(tinyId);
    totalCache.withAtlasDb((db) => {
      db.prepare(
        `INSERT INTO atlas_artifacts
           (id, capture_id, region_id, kind, storage_path, external_url, sha256, bytes,
            mime_type, state, rights_json, metadata_json)
         VALUES (?, ?, ?, 'component_pack', ?, NULL, ?, ?, 'application/octet-stream', 'ready', '{}', ?)`,
      ).run(
        tinyId,
        totalFixture.captureId,
        totalFixture.componentIds[1]!,
        tiny.storagePath,
        tiny.sha256,
        tiny.bytes,
        JSON.stringify({ key: "total-tiny" }),
      );
    });
    const total = await buildEvidencePack(
      {
        ...inputFor(totalFixture),
        regionIds: [totalFixture.componentIds[1]!],
        inclusionMode: "permitted",
        goal: "total cap",
        rightsAssertions: bigIds.map((artifactId) => ({ artifactId, rights: publicRights })),
      },
      packStore(totalCache),
    );
    const totalManifest = manifestOf(total.directory);
    expect(totalManifest.artifacts.included).toHaveLength(4);
    expect(totalManifest.artifacts.excluded).toContainEqual(
      expect.objectContaining({ reason: "TOTAL_SIZE_LIMIT" }),
    );
    expect(validateEvidencePack(total.directory).ok).toBe(true);
  });

  it("registers after rename and adoption, or leaves the pack unregistered on a DB failure", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const input = inputFor(fixture);
    const trigger = (): void => {
      cache.withAtlasDb((db) =>
        db.exec(
          "CREATE TRIGGER fail_pack BEFORE INSERT ON atlas_packs BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
        ),
      );
    };
    const dropTrigger = (): void => {
      cache.withAtlasDb((db) => db.exec("DROP TRIGGER fail_pack"));
    };
    trigger();
    await expect(buildEvidencePack(input, packStore(cache))).rejects.toMatchObject({
      code: "PACK_WRITE_FAILED",
    });
    const packsDir = join(cache.rootDir, "atlas", "evidence-packs");
    const published = readdirSync(packsDir);
    expect(published).toHaveLength(1);
    expect(validateEvidencePack(join(packsDir, published[0]!)).ok).toBe(true);
    expect(
      cache.withAtlasDb((db) => db.prepare("SELECT COUNT(*) AS n FROM atlas_packs").get()),
    ).toEqual({ n: 0 });

    dropTrigger();
    const adopted = await buildEvidencePack(input, packStore(cache));
    expect(adopted.cached).toBe(true);
    expect(
      cache.withAtlasDb((db) => db.prepare("SELECT COUNT(*) AS n FROM atlas_packs").get()),
    ).toEqual({ n: 1 });

    trigger();
    await expect(buildEvidencePack(input, packStore(cache))).rejects.toMatchObject({
      code: "PACK_WRITE_FAILED",
    });
    dropTrigger();
    expect(validateEvidencePack(adopted.directory).ok).toBe(true);
  });

  it("refuses a claim changed after the snapshot read instead of publishing stale evidence", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const claim = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT id FROM atlas_claims WHERE region_id = ? AND decision = 'accepted' LIMIT 1",
          )
          .get(fixture.componentIds[1]!) as { id: string },
    );
    const store = {
      cache,
      now: () => PACK_NOW,
      onSnapshotRead: () => {
        const writer = new Cache(cache.rootDir, () => PACK_NOW, { atlas: true });
        writer.withAtlasDb((db) =>
          db.prepare("UPDATE atlas_claims SET value = '9999px' WHERE id = ?").run(claim.id),
        );
      },
    };
    // The build reads one snapshot, so the old value is not mixed in; the
    // publication recheck then refuses the claim that moved underneath it.
    await expect(buildEvidencePack(inputFor(fixture), store)).rejects.toMatchObject({
      code: "PACK_STALE",
    });
    expect(
      cache.withAtlasDb(
        (db) =>
          db.prepare("SELECT value FROM atlas_claims WHERE id = ?").get(claim.id) as {
            value: string;
          },
      ).value,
    ).toBe("9999px");
    expect(readdirSync(join(cache.rootDir, "atlas", "evidence-packs"))).toEqual([]);
    expect(packRows(cache)).toEqual([]);
  });

  it("rechecks active heads before publication and reports PACK_STALE", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const packsDir = join(cache.rootDir, "atlas", "evidence-packs");
    await expect(
      buildEvidencePack(
        inputFor(fixture),
        packStore(cache, () => {
          cache.withAtlasDb((db) => {
            db.prepare("DELETE FROM atlas_heads WHERE capture_id = ?").run(fixture.captureId);
          });
        }),
      ),
    ).rejects.toMatchObject({ code: "PACK_STALE" });
    expect(readdirSync(packsDir)).toEqual([]);
    expect(packRows(cache)).toEqual([]);
  });

  it("returns PACK_STALE when a head retires after the build snapshot", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const packsDir = join(cache.rootDir, "atlas", "evidence-packs");
    const retired = {
      cache,
      now: () => PACK_NOW,
      onSnapshotRead: () => {
        const writer = new Cache(cache.rootDir, () => PACK_NOW, { atlas: true });
        writer.withAtlasDb((db) =>
          db.prepare("DELETE FROM atlas_heads WHERE capture_id = ?").run(fixture.captureId),
        );
      },
    };
    await expect(buildEvidencePack(inputFor(fixture), retired)).rejects.toMatchObject({
      code: "PACK_STALE",
    });
    expect(readdirSync(packsDir)).toEqual([]);
    expect(packRows(cache)).toEqual([]);
  });

  it("serializes the head recheck, rename and registration in one write transaction", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    let locked = false;
    let failure: { code?: string; errcode?: number } | null = null;
    const built = await buildEvidencePack(
      inputFor(fixture),
      packStore(cache, undefined, () => {
        locked = true;
        // A second writer with no busy wait must fail while the publication
        // transaction holds the database write lock between recheck and rename.
        const other = new DatabaseSync(join(cache.rootDir, "cache.db"));
        try {
          other.exec("PRAGMA busy_timeout = 0");
          other.prepare("DELETE FROM atlas_heads WHERE capture_id = ?").run(fixture.captureId);
        } catch (error) {
          failure = error as { code?: string; errcode?: number };
        } finally {
          other.close();
        }
      }),
    );
    expect(locked).toBe(true);
    expect(failure).toMatchObject({ errcode: 5 });
    expect(validateEvidencePack(built.directory).ok).toBe(true);
    expect(
      cache.withAtlasDb((db) =>
        db
          .prepare("SELECT COUNT(*) AS n FROM atlas_heads WHERE capture_id = ?")
          .get(fixture.captureId),
      ),
    ).toEqual({ n: 1 });
  });

  it("orders regions from multiple captures deterministically", async () => {
    const cache = cacheFor();
    const desktop = await publishPackFixture(cache);
    const mobile = await publishPackFixture(cache, {
      viewport: "mobile",
      fetchedAt: PACK_NOW + 1000,
    });
    expect(mobile.captureId).not.toBe(desktop.captureId);
    const built = await buildEvidencePack(
      {
        ...inputFor(desktop),
        goal: "multi capture",
        regionIds: [
          mobile.componentIds[1]!,
          desktop.sectionIds[1]!,
          desktop.componentIds[1]!,
          mobile.sectionIds[1]!,
        ],
      },
      packStore(cache),
    );
    const selection = selectionOf(built.directory);
    expect(new Set(selection.captures.map((capture: { viewport: string }) => capture.viewport))).toEqual(
      new Set(["desktop", "mobile"]),
    );
    const order = selection.regions.map((region: { captureId: string }) => region.captureId);
    expect(order).toEqual([...order].sort());
    for (const capture of selection.captures) {
      const ordinals = selection.regions
        .filter((region: { captureId: string }) => region.captureId === capture.id)
        .map((region: { ordinal: number }) => region.ordinal);
      expect(ordinals).toEqual([...ordinals].sort((left: number, right: number) => left - right));
    }
    expect(validateEvidencePack(built.directory).ok).toBe(true);
  });

  it("records an explicit limitation for legacy gallery sources", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    cache.withAtlasDb((db) => {
      db.prepare("UPDATE atlas_pages SET kind = 'legacy_gallery' WHERE id = ?").run(fixture.pageId);
    });
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    expect(manifestOf(built.directory).limitations).toContain(
      "LEGACY_GALLERY_NO_SOURCE_ARTIFACT",
    );
    const component = selectionOf(built.directory).components.find(
      (entry: { regionId: string }) => entry.regionId === fixture.componentIds[1],
    );
    expect(selectionOf(built.directory).regions.some(
      (region: { limitations: string[] }) =>
        region.limitations.includes("LEGACY_GALLERY_NO_SOURCE_ARTIFACT"),
    )).toBe(true);
    expect(component).toBeTruthy();
    expect(validateEvidencePack(built.directory).ok).toBe(true);
  });

  it("adds claims to the brief component-type commonality line", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    cache.withAtlasDb((db) => {
      for (const id of fixture.componentIds) {
        const row = db.prepare("SELECT samples_json FROM atlas_regions WHERE id = ?").get(id) as {
          samples_json: string;
        };
        const samples = JSON.parse(row.samples_json);
        samples.type = "link";
        db.prepare("UPDATE atlas_regions SET samples_json = ? WHERE id = ?").run(
          JSON.stringify(samples),
          id,
        );
      }
    });
    const built = await buildEvidencePack(
      {
        ...inputFor(fixture),
        goal: "common type",
        regionIds: [...fixture.componentIds],
      },
      packStore(cache),
    );
    const brief = readFileSync(join(built.directory, "brief.md"), "utf8");
    expect(brief).toMatch(/component type `link` observed 2 time\(s\):.*claims `claim-/);
    expect(validateEvidencePack(built.directory).ok).toBe(true);
  });

  it("does not flag source URL paths or observed text as template placeholders", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    cache.withAtlasDb((db) => {
      db.prepare("UPDATE atlas_pages SET public_url = ?, path = ? WHERE id = ?").run(
        "https://pack-fixture.example/todo-project/placeholder",
        "/todo-project/placeholder",
        fixture.pageId,
      );
    });
    const urlPack = await buildEvidencePack(
      { ...inputFor(fixture), goal: "url placeholder" },
      packStore(cache),
    );
    expect(readFileSync(join(urlPack.directory, "DESIGN.md"), "utf8")).toContain(
      "/todo-project/placeholder",
    );
    expect(validateEvidencePack(urlPack.directory).ok).toBe(true);

    const observedCache = cacheFor();
    const observedFixture = await publishPackFixture(observedCache);
    observedCache.withAtlasDb((db) => {
      const id = observedFixture.componentIds[1]!;
      const row = db.prepare("SELECT samples_json FROM atlas_regions WHERE id = ?").get(id) as {
        samples_json: string;
      };
      const samples = JSON.parse(row.samples_json);
      samples.type = "TODO placeholder";
      db.prepare("UPDATE atlas_regions SET samples_json = ? WHERE id = ?").run(
        JSON.stringify(samples),
        id,
      );
    });
    const observedPack = await buildEvidencePack(
      { ...inputFor(observedFixture), goal: "observed placeholder" },
      packStore(observedCache),
    );
    expect(readFileSync(join(observedPack.directory, "DESIGN.md"), "utf8")).toContain(
      "TODO placeholder",
    );
    expect(validateEvidencePack(observedPack.directory).ok).toBe(true);
  });

  it("ignores placeholder markers in generated code spans but rejects prose markers", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    cache.withAtlasDb((db) => {
      db.prepare("UPDATE atlas_pages SET public_url = ?, path = ? WHERE id = ?").run(
        "https://pack-fixture.example/todo:list/TBD:later",
        "/todo:list/TBD:later",
        fixture.pageId,
      );
    });
    const built = await buildEvidencePack(
      { ...inputFor(fixture), goal: "code span placeholders" },
      packStore(cache),
    );
    expect(readFileSync(join(built.directory, "DESIGN.md"), "utf8")).toContain(
      "`https://pack-fixture.example/todo:list/TBD:later`",
    );
    expect(validateEvidencePack(built.directory).ok).toBe(true);

    const prose = copyPack(built.directory);
    updateManifestFile(
      prose,
      "brief.md",
      `${readFileSync(join(prose, "brief.md"), "utf8")}\nTODO: fill this in\n`,
    );
    expect(codes(validateEvidencePack(prose))).toContain("PLACEHOLDER_FOUND");
  });

  it("refuses a symlinked source artifact before copying", async (ctx) => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const artifacts = artifactIds(cache, fixture.captureId);
    const row = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT id, storage_path, sha256, bytes FROM atlas_artifacts WHERE id = ?")
          .get(artifacts[0]!.id) as {
          id: string;
          storage_path: string;
          sha256: string;
          bytes: number;
        },
    );
    const source = join(cache.rootDir, row.storage_path);
    const external = join(tmpDir(), "symlinked-source.bin");
    writeFileSync(external, readFileSync(source));
    unlinkSync(source);
    try {
      symlinkSync(external, source, "file");
    } catch (error) {
      if (LINK_ERRORS.has((error as NodeJS.ErrnoException).code ?? "")) {
        ctx.skip();
        return;
      }
      throw error;
    }
    const built = await buildEvidencePack(
      {
        ...inputFor(fixture),
        inclusionMode: "permitted",
        goal: "symlink source",
        rightsAssertions: artifacts.map((artifact) => ({
          artifactId: artifact.id,
          rights: publicRights,
        })),
      },
      packStore(cache),
    );
    expect(manifestOf(built.directory).artifacts.excluded).toContainEqual(
      expect.objectContaining({ artifactId: row.id, reason: "ARTIFACT_INVALID" }),
    );
    expect(
      manifestOf(built.directory).artifacts.included.some(
        (entry: { artifactId: string }) => entry.artifactId === row.id,
      ),
    ).toBe(false);
  });

  it("rejects duplicate capture ids", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    await expect(
      buildEvidencePack(
        { ...inputFor(fixture), captureIds: [fixture.captureId, fixture.captureId] },
        packStore(cache),
      ),
    ).rejects.toMatchObject({ code: "INVALID_SELECTION" });
  });

  it("rechecks active heads inside cached adoption and never adopts a retired head", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const input = inputFor(fixture);
    const built = await buildEvidencePack(input, packStore(cache));

    const raced = {
      cache,
      now: () => PACK_NOW,
      onSnapshotRead: () => {
        const writer = new Cache(cache.rootDir, () => PACK_NOW, { atlas: true });
        writer.withAtlasDb((db) =>
          db.prepare("DELETE FROM atlas_heads WHERE capture_id = ?").run(fixture.captureId),
        );
      },
    };
    await expect(buildEvidencePack(input, raced)).rejects.toMatchObject({ code: "PACK_STALE" });
    expect(() => adoptEvidencePack(built.directory, packStore(cache))).toThrowError(
      expect.objectContaining({ code: "PACK_STALE" }),
    );
    expect(validateEvidencePack(built.directory).ok).toBe(true);
  });

  it("rechecks selected regions inside cached adoption", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const regionId = fixture.sectionIds[1]!;
    cache.withAtlasDb((db) => {
      db.prepare("DELETE FROM atlas_claims WHERE region_id = ?").run(regionId);
      db.prepare("DELETE FROM atlas_artifacts WHERE region_id = ?").run(regionId);
      db.prepare("DELETE FROM atlas_aliases WHERE region_id = ?").run(regionId);
      db.prepare("DELETE FROM atlas_regions WHERE id = ?").run(regionId);
    });
    expect(() => adoptEvidencePack(built.directory, packStore(cache))).toThrowError(
      expect.objectContaining({ code: "PACK_STALE" }),
    );
    expect(validateEvidencePack(built.directory).ok).toBe(true);
  });

  it("stales cached copies when the current capture policy changes", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const artifacts = artifactIds(cache, fixture.captureId);
    const input = {
      ...inputFor(fixture),
      inclusionMode: "permitted" as const,
      rightsAssertions: artifacts.map((artifact) => ({
        artifactId: artifact.id,
        rights: publicRights,
      })),
    };
    const allowed = await buildEvidencePack(input, packStore(cache));
    expect(manifestOf(allowed.directory).artifacts.included.length).toBeGreaterThan(0);

    cache.withAtlasDb((db) => {
      db.prepare("UPDATE atlas_captures SET policy_json = ? WHERE id = ?").run(
        JSON.stringify({ robots: "disallowed", publicOnly: true }),
        fixture.captureId,
      );
    });
    expect(() => adoptEvidencePack(allowed.directory, packStore(cache))).toThrowError(
      expect.objectContaining({ code: "PACK_STALE" }),
    );

    const denied = await buildEvidencePack(input, packStore(cache));
    expect(denied.cached).toBe(false);
    expect(denied.packId).not.toBe(allowed.packId);
    const manifest = manifestOf(denied.directory);
    expect(manifest.artifacts.included).toEqual([]);
    expect(manifest.artifacts.excluded.length).toBeGreaterThan(0);
    expect(
      manifest.artifacts.excluded.every(
        (entry: { reason: string }) => entry.reason === "ROBOTS_OR_DESTINATION_REFUSED",
      ),
    ).toBe(true);
    expect(validateEvidencePack(denied.directory).ok).toBe(true);
  });

  it("rejects an injected hashed copy with empty rights and does not adopt it", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const screenshot = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT id, storage_path, sha256, bytes FROM atlas_artifacts WHERE capture_id = ? AND kind = 'screenshot' LIMIT 1",
          )
          .get(fixture.captureId) as {
          id: string;
          storage_path: string;
          sha256: string;
          bytes: number;
        },
    );
    const copiedPath = `artifacts/${screenshot.id}-${screenshot.sha256}.png`;
    writeFileSync(join(built.directory, copiedPath), readFileSync(join(cache.rootDir, screenshot.storage_path)));
    const manifest = manifestOf(built.directory);
    manifest.files.push({
      path: copiedPath,
      sha256: screenshot.sha256,
      bytes: screenshot.bytes,
      mimeType: "image/png",
    });
    manifest.artifacts.included.push({
      artifactId: screenshot.id,
      captureId: fixture.captureId,
      kind: "screenshot",
      path: copiedPath,
      sha256: screenshot.sha256,
      bytes: screenshot.bytes,
      mimeType: "image/png",
    });
    writeFileSync(join(built.directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const validation = validateEvidencePack(built.directory);
    expect(validation.ok).toBe(false);
    expect(codes(validation)).toContain("ARTIFACT_DECISION_MISMATCH");
    expect(codes(validation)).toContain("ARTIFACT_RIGHTS_INVALID");

    cache.withAtlasDb((db) => db.prepare("DELETE FROM atlas_packs").run());
    await expect(buildEvidencePack(inputFor(fixture), packStore(cache))).rejects.toMatchObject({
      code: "PACK_CORRUPT",
    });
    expect(
      cache.withAtlasDb((db) => db.prepare("SELECT COUNT(*) AS n FROM atlas_packs").get()),
    ).toEqual({ n: 0 });
  });

  it("rejects fabricated token, CSS, design, claim-provenance and manifest values", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));

    const tokensCopy = copyPack(built.directory);
    const tokens = JSON.parse(readFileSync(join(tokensCopy, "tokens.json"), "utf8"));
    tokens.typography.fontSize[0].value = "99px";
    updateManifestFile(tokensCopy, "tokens.json", `${JSON.stringify(tokens, null, 2)}\n`);
    expect(codes(validateEvidencePack(tokensCopy))).toContain("TOKENS_INVALID");

    const cssCopy = copyPack(built.directory);
    const css = readFileSync(join(cssCopy, "tokens.css"), "utf8");
    updateManifestFile(cssCopy, "tokens.css", css.replace(": 16px;", ": 99px;"));
    expect(codes(validateEvidencePack(cssCopy))).toContain("TOKENS_INVALID");

    const designCopy = copyPack(built.directory);
    updateManifestFile(
      designCopy,
      "DESIGN.md",
      readFileSync(join(designCopy, "DESIGN.md"), "utf8").replace(
        "Unavailable: the selected default-state evidence",
        "box-shadow: 0 1px 2px #000;\nUnavailable: the selected default-state evidence",
      ),
    );
    expect(codes(validateEvidencePack(designCopy))).toContain("UNCLAIMED_DESIGN_VALUE");

    const fontCopy = copyPack(built.directory);
    updateManifestFile(
      fontCopy,
      "DESIGN.md",
      readFileSync(join(fontCopy, "DESIGN.md"), "utf8").replace(
        /Font family: `[^`]+`/,
        "Font family: `Comic Sans`",
      ),
    );
    expect(codes(validateEvidencePack(fontCopy))).toContain("UNCLAIMED_DESIGN_VALUE");

    const provenanceCopy = copyPack(built.directory);
    const evidence = designEvidenceOf(provenanceCopy);
    evidence.claims[0].method = "forged method";
    updateManifestFile(
      provenanceCopy,
      "design-evidence.json",
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    expect(codes(validateEvidencePack(provenanceCopy))).toContain("CLAIM_PROVENANCE_MISMATCH");

    const manifestCopies: Array<[string, (manifest: Record<string, any>) => void]> = [
      ["exporterVersion", (manifest) => (manifest.exporterVersion = "atlas-exporter-99")],
      ["vocabularyVersion", (manifest) => (manifest.vocabularyVersion = "atlas-vocabulary-99")],
      ["classifierVersion", (manifest) => (manifest.classifierVersion = "atlas-classifier-99")],
      ["schemaVersionUsed", (manifest) => (manifest.schemaVersionUsed = 99)],
      ["ftsVersion", (manifest) => (manifest.ftsVersion = 99)],
      ["extractorVersions", (manifest) => (manifest.extractorVersions = ["atlas-extractor-99"])],
      ["site.attribution", (manifest) => (manifest.site.attribution = "forged")],
      ["files.mimeType", (manifest) => (manifest.files[0].mimeType = "text/html")],
    ];
    const forged: PackValidation[] = manifestCopies.map(([, mutate]) => {
      const copy = copyPack(built.directory);
      rewriteManifest(copy, mutate);
      return validateEvidencePack(copy);
    });
    for (const [index, validation] of forged.entries()) {
      expect(validation.ok, manifestCopies[index]![0]).toBe(false);
      expect(codes(validation), manifestCopies[index]![0]).toContain("MANIFEST_INVALID");
    }
  });

  it("re-renders every generated document and rejects appended values or prose", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const design = readFileSync(join(built.directory, "DESIGN.md"), "utf8");
    const appends = [
      'font-family: "Comic Sans";',
      "color: #ff00ff;",
      "border-radius: 42px;",
      "border: 1px solid red;",
      "This paragraph was appended after generation.",
    ];
    for (const appended of appends) {
      const copy = copyPack(built.directory);
      updateManifestFile(copy, "DESIGN.md", `${design}\n${appended}\n`);
      expect(codes(validateEvidencePack(copy)), appended).toContain("DOCUMENT_RENDER_MISMATCH");
    }
    const brief = copyPack(built.directory);
    updateManifestFile(
      brief,
      "brief.md",
      `${readFileSync(join(brief, "brief.md"), "utf8")}Appended after generation.\n`,
    );
    expect(codes(validateEvidencePack(brief))).toContain("DOCUMENT_RENDER_MISMATCH");

    const selectionCopy = copyPack(built.directory);
    updateManifestFile(
      selectionCopy,
      "artifacts/selection.json",
      `${readFileSync(join(selectionCopy, "artifacts", "selection.json"), "utf8")}\n`,
    );
    refreshSelectionEvidence(selectionCopy);
    expect(codes(validateEvidencePack(selectionCopy))).toContain("DOCUMENT_RENDER_MISMATCH");
  });

  it("cross-checks manifest summaries against the selection and recomputed decisions", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const mutations: Array<[string, (manifest: Record<string, any>) => void]> = [
      ["coverage", (manifest) => (manifest.coverage.collected += 1)],
      ["limitations", (manifest) => manifest.limitations.push("appended limitation")],
      ["omitted", (manifest) => manifest.omitted.push({ family: "appended", reason: "APPENDED" })],
      ["excluded", (manifest) => (manifest.artifacts.excluded[0].reason = "APPENDED")],
      ["references", (manifest) => (manifest.artifacts.references[0].sha256 = "f".repeat(64))],
    ];
    for (const [name, mutate] of mutations) {
      const copy = copyPack(built.directory);
      rewriteManifest(copy, mutate);
      const validation = validateEvidencePack(copy);
      expect(validation.ok, name).toBe(false);
      expect(codes(validation), name).toContain("MANIFEST_DECISION_MISMATCH");
    }
    for (const createdAt of [1.5, -1, 8_640_000_000_000_001]) {
      const copy = copyPack(built.directory);
      rewriteManifest(copy, (manifest) => (manifest.createdAt = createdAt));
      expect(codes(validateEvidencePack(copy)), String(createdAt)).toContain("MANIFEST_INVALID");
    }
  });

  it("accepts reordered JSON keys in semantically identical manifest decisions", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const artifacts = artifactIds(cache, fixture.captureId);
    const built = await buildEvidencePack(
      {
        ...inputFor(fixture),
        inclusionMode: "permitted",
        rightsAssertions: artifacts.map((artifact) => ({
          artifactId: artifact.id,
          rights: publicRights,
        })),
      },
      packStore(cache),
    );
    const original = manifestOf(built.directory);
    expect(original.omitted.length).toBeGreaterThan(0);
    expect(original.rightsAssertions.length).toBeGreaterThan(0);

    const copy = copyPack(built.directory);
    const reversed = (value: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(value).reverse());
    rewriteManifest(copy, (manifest) => {
      const { limitations, excluded, status, collected } = manifest.coverage;
      manifest.coverage = { limitations, excluded, status, collected };
      manifest.omitted = manifest.omitted.map(reversed);
      manifest.artifacts.references = manifest.artifacts.references.map(reversed);
      manifest.rightsAssertions = manifest.rightsAssertions.map(
        (entry: { artifactId: string; rights: Record<string, unknown> }) => ({
          rights: reversed(entry.rights),
          artifactId: entry.artifactId,
        }),
      );
    });
    const validation = validateEvidencePack(copy);
    expect(validation.errors, JSON.stringify(validation.errors)).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it("removes a corrupt final directory created by this build after rename", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const packsDir = join(cache.rootDir, "atlas", "evidence-packs");
    await expect(
      buildEvidencePack(
        inputFor(fixture),
        packStore(cache, undefined, undefined, (finalDir) => {
          writeFileSync(join(finalDir, "brief.md"), "tampered after rename\n");
        }),
      ),
    ).rejects.toMatchObject({ code: "PACK_CORRUPT" });
    expect(readdirSync(packsDir)).toEqual([]);
    expect(
      cache.withAtlasDb((db) => db.prepare("SELECT COUNT(*) AS n FROM atlas_packs").get()),
    ).toEqual({ n: 0 });
  });

  it("neutralizes CommonMark injection from page values and goals", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const hostile =
      "Build [link](https://evil.example) ![img](https://evil.example/i.png) <img src=x> `code`\n## injected\n- bullet";
    const componentId = fixture.componentIds[1]!;
    cache.withAtlasDb((db) => {
      const row = db.prepare("SELECT samples_json FROM atlas_regions WHERE id = ?").get(componentId) as {
        samples_json: string;
      };
      const samples = JSON.parse(row.samples_json);
      samples.type = hostile;
      db.prepare("UPDATE atlas_regions SET samples_json = ? WHERE id = ?").run(
        JSON.stringify(samples),
        componentId,
      );
      db.prepare("UPDATE atlas_pages SET public_url = ? WHERE id = ?").run(
        "https://pack-fixture.example/[x](https://evil.example)/<img>",
        fixture.pageId,
      );
    });
    const built = await buildEvidencePack(
      { ...inputFor(fixture), goal: hostile },
      packStore(cache),
    );
    for (const name of ["DESIGN.md", "brief.md", "rebuild-handoff.md"]) {
      const text = readFileSync(join(built.directory, name), "utf8");
      const prose = stripCodeSpans(text);
      expect(prose, name).not.toMatch(/\]\(https:\/\/evil\.example/);
      expect(prose, name).not.toMatch(/!\[/);
      expect(prose, name).not.toMatch(/(^|[^\\])<img/i);
      expect(prose, name).not.toMatch(/^## injected/m);
      expect(prose, name).not.toMatch(/^- bullet/m);
    }
    const components = JSON.parse(readFileSync(join(built.directory, "components.json"), "utf8"));
    const display = String(components.components[0]?.type ?? "");
    expect(display).not.toContain("\n");
    expect(display).not.toContain("](https://evil.example");
    expect(display).not.toMatch(/(^|[^\\])<img/i);
    expect(validateEvidencePack(built.directory).ok).toBe(true);
  });

  it("keeps the public surfaces at 41 full, 13 core and 15 v2", () => {
    const registrations: string[] = [];
    registerAllTools({
      handlers: {} as any,
      tool: ((...args: any[]) => registrations.push(String(args[0]))) as any,
      registerTool: ((...args: any[]) => registrations.push(String(args[0]))) as any,
    });
    expect(registrations).toHaveLength(41);
    expect(new Set(registrations).size).toBe(41);
    expect(CORE_TOOL_NAMES).toHaveLength(13);
    expect(V2_TOOL_NAMES).toHaveLength(15);
    expect(registrations).not.toContain("export_evidence_pack");
  });

  it("renders public document helpers deterministically", async () => {
    const cache = cacheFor();
    const fixture = await publishPackFixture(cache);
    const built = await buildEvidencePack(inputFor(fixture), packStore(cache));
    const selection = selectionOf(built.directory) as any;
    const design = renderDesignMd(selection);
    const handoff = renderRebuildHandoff(selection, "A different goal");
    expect(design.path).toBe("DESIGN.md");
    expect(design.content).toBe(readFileSync(join(built.directory, "DESIGN.md"), "utf8"));
    expect(handoff.path).toBe("rebuild-handoff.md");
    expect(handoff.content).toContain("A different goal");
    expect(handoff.content).toBe(renderRebuildHandoff(selection, "A different goal").content);
  });
});
