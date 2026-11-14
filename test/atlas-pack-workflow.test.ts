import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Cache } from "../src/cache.js";
import { REQUIRED_PACK_FILES } from "../src/atlas/evidence-pack-types.js";
import { validateEvidencePack } from "../src/atlas/evidence-pack.js";
import { runAtlasCapture } from "../src/atlas/tool-capture.js";
import { createHandlers } from "../src/server.js";
import type { ToolResponse } from "../src/server/types.js";
import {
  PACK_NOW,
  buildPackAttempt,
  type PackFixtureOptions,
} from "./helpers/atlas-pack-fixture.js";

const SITE = "pack-fixture";
const GOAL = "Rebuild the selected landing page sections";
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-pack-workflow-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const detail = (slug: string) => ({
  slug,
  title: slug,
  description: null,
  palette: [],
  technologies: [],
  elements: [],
  awards: [],
  nominee: false,
  score: null,
  ogImage: null,
  liveUrl: `https://${slug}.example/`,
});

function cacheFor(): Cache {
  const cache = new Cache(tmpDir(), () => PACK_NOW, { atlas: true });
  cache.setMeta(`detail:${SITE}`, detail(SITE));
  return cache;
}

/**
 * Full public handler surface. The only injected piece is the guarded
 * collector: capture still resolves a known site, publishes through the real
 * publisher and returns the stored capture envelope.
 */
function handlersFor(cache: Cache, fixtureOptions: PackFixtureOptions = {}) {
  return createHandlers({
    client: {} as never,
    cache,
    now: () => PACK_NOW,
    atlasCaptureFn: (target, input, options) =>
      runAtlasCapture(target, input, {
        now: options.now,
        collect: async (_input: unknown, deps: { cache: Cache }) =>
          buildPackAttempt(deps.cache, { siteSlug: SITE, ...fixtureOptions }),
      }),
  });
}

function envelope(response: ToolResponse): Record<string, any> {
  // Error envelopes are isError with no structuredContent; their JSON body is
  // still the typed envelope.
  if (response.structuredContent) return response.structuredContent as Record<string, any>;
  const block = response.content[0];
  if (block?.type !== "text") throw new Error("missing Atlas envelope");
  return JSON.parse(block.text) as Record<string, any>;
}

function packFiles(directory: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (statSync(path).isDirectory()) walk(path, relative);
      else files.set(relative, readFileSync(path));
    }
  };
  walk(directory, "");
  return files;
}

function document(directory: string, name: string): string {
  return readFileSync(join(directory, name), "utf8");
}

function documentJson(directory: string, name: string): Record<string, any> {
  return JSON.parse(document(directory, name));
}

/** RFC 6901 pointer lookup used by the selection artifact's claim paths. */
function resolvePointer(root: unknown, pointer: string): unknown {
  return pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((value, part) => {
      if (value === null || typeof value !== "object") return undefined;
      return (value as Record<string, unknown>)[part];
    }, root);
}

const CLAIM_ID = /`(claim-[a-f0-9]{16})`/g;

function claimsCitedIn(text: string): string[] {
  return [...text.matchAll(CLAIM_ID)].map((match) => match[1]!);
}

/**
 * The complete supported workflow: search -> guarded capture -> search/read ->
 * export -> consume the generated handoff documents.
 */
async function runWorkflow(fixtureOptions: PackFixtureOptions = {}) {
  const cache = cacheFor();
  const handlers = handlersFor(cache, fixtureOptions);
  // Any fetch attempt fails loudly: this workflow is offline by design, and a
  // mockRejectedValue spy cannot silently reach the real network.
  const fetched = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("network access attempted by offline workflow"));

  const beforeCapture = await handlers.search_atlas({
    kind: "sections",
    siteSlugs: [SITE],
    limit: 5,
  });
  expect(beforeCapture.isError).toBeFalsy();
  const empty = envelope(beforeCapture);
  expect(empty.status).toBe("inconclusive");
  expect(empty.data.outcome).toBe("empty_corpus");
  expect(empty.data.results).toEqual([]);

  const captured = await handlers.capture_atlas({ slug: SITE });
  expect(captured.isError).toBeFalsy();
  const capture = envelope(captured);
  expect(capture.status).toBe("ok");
  expect(capture.data.published).toBe(true);
  expect(capture.data.cached).toBe(false);
  expect(capture.data.viewport).toBe("desktop");
  expect(capture.data.sections.length).toBeGreaterThan(0);
  expect(capture.data.components.length).toBeGreaterThan(0);

  const sections = await handlers.search_atlas({
    kind: "sections",
    siteSlugs: [SITE],
    limit: 20,
  });
  const components = await handlers.search_atlas({
    kind: "components",
    siteSlugs: [SITE],
    limit: 20,
  });
  for (const response of [sections, components]) {
    expect(response.isError).toBeFalsy();
    const search = envelope(response);
    expect(search.status).toBe("ok");
    expect(search.data.outcome).toBe("matches");
    expect(search.data.results.length).toBeGreaterThan(0);
    for (const hit of search.data.results) {
      expect(hit.siteSlug).toBe(SITE);
      expect(hit.captureId).toBe(capture.data.captureId);
      expect(hit.viewport).toBe("desktop");
      expect(hit.state).toBe("default");
      expect(hit.coverage.status).toBe("complete");
    }
  }
  const sectionHit = envelope(sections).data.results[0];
  const componentHit = envelope(components).data.results[0];
  expect(sectionHit.kind).toBe("section");
  expect(componentHit.kind).toBe("component");

  const readSection = await handlers.get_atlas({
    kind: "region",
    regionId: sectionHit.regionId,
  });
  const readComponent = await handlers.get_atlas({
    kind: "region",
    regionId: componentHit.regionId,
  });
  for (const response of [readSection, readComponent]) {
    expect(response.isError).toBeFalsy();
    const region = envelope(response).data;
    expect(region.head.current).toBe(true);
    expect(region.artifactsTruncated).not.toBe(true);
    expect(region.claimsTruncated).not.toBe(true);
    expect(region.claims.length).toBeGreaterThan(0);
    expect(region.capture.conditions.viewport).toBe("desktop");
  }

  const exported = await handlers.export_evidence_pack({
    regionIds: [sectionHit.regionId, componentHit.regionId],
    goal: GOAL,
  });
  expect(exported.isError).toBeFalsy();
  const pack = envelope(exported);
  expect(pack.status).toBe("ok");
  expect(pack.data.cached).toBe(false);
  // macOS resolves tmpdir /var to /private/var, so compare canonical paths.
  expect(
    realpathSync(pack.data.directory).startsWith(
      realpathSync(join(cache.rootDir, "atlas", "evidence-packs")),
    ),
  ).toBe(true);

  // The guarded collector is local; export/reference mode performs no fetch.
  expect(fetched).not.toHaveBeenCalled();

  return {
    cache,
    handlers,
    capture: capture.data,
    sectionHit,
    componentHit,
    pack: pack.data,
    fetched,
  };
}

describe("Atlas evidence-pack workflow", () => {
  it("serves search -> guarded capture -> read -> export -> a citable handoff", async () => {
    const flow = await runWorkflow();
    const { directory, packId, manifestHash } = flow.pack;
    const files = packFiles(directory);
    const manifest = documentJson(directory, "manifest.json");
    const selection = documentJson(directory, "artifacts/selection.json");

    // All seven required pack documents plus the selection artifact exist.
    for (const required of REQUIRED_PACK_FILES) {
      expect(files.has(required), required).toBe(true);
      expect(files.get(required)!.length, required).toBeGreaterThan(0);
      expect(
        manifest.files.some((file: { path: string }) => file.path === required),
        required,
      ).toBe(true);
    }
    expect(files.has("artifacts/selection.json")).toBe(true);
    expect(packId).toBe(manifest.packId);
    expect(manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(validateEvidencePack(directory).ok).toBe(true);
    expect(manifest.selection.regionIds.sort()).toEqual(
      [flow.sectionHit.regionId, flow.componentHit.regionId].sort(),
    );

    const design = document(directory, "DESIGN.md");
    const brief = document(directory, "brief.md");
    const handoff = document(directory, "rebuild-handoff.md");
    const designEvidence = documentJson(directory, "design-evidence.json");
    const tokens = documentJson(directory, "tokens.json");
    const tokensCss = document(directory, "tokens.css");
    const components = documentJson(directory, "components.json");

    // Every claim citation in the prose resolves to a stored claim, and every
    // stored claim path resolves to the value the document prints.
    const claimIds = new Set<string>(selection.claims.map((claim: { id: string }) => claim.id));
    for (const [name, text] of [
      ["DESIGN.md", design],
      ["brief.md", brief],
      ["rebuild-handoff.md", handoff],
    ] as const) {
      const cited = claimsCitedIn(text);
      expect(cited.length, name).toBeGreaterThan(0);
      for (const id of cited) expect(claimIds.has(id), `${name} cites ${id}`).toBe(true);
    }
    for (const claim of selection.claims) {
      const value = resolvePointer(selection, claim.path);
      expect(value, claim.id).not.toBeUndefined();
      expect(String(value)).toBe(String(claim.value));
      expect(claim.artifactId).toBe("selection");
    }
    const evidenceClaims = designEvidence.claims;
    expect(evidenceClaims).toHaveLength(selection.claims.length);
    for (const claim of evidenceClaims) {
      const stored = selection.claims.find((entry: { id: string }) => entry.id === claim.id);
      expect(stored).toBeTruthy();
      expect(claim.value).toBe(stored.value);
      expect(claim.path).toBe(stored.path);
      expect(String(resolvePointer(selection, claim.path))).toBe(String(claim.value));
    }

    // Tokens are generated names for observed values, never invented values.
    const tokenFamilies = [
      tokens.colors ?? [],
      ...Object.values(tokens.typography ?? {}),
      ...Object.values(tokens.spacing ?? {}),
      tokens.radii ?? [],
      tokens.display ?? [],
    ].flat() as Array<{ name: string; value: string; property: string; claimIds: string[] }>;
    expect(tokenFamilies.length).toBeGreaterThan(0);
    for (const entry of tokenFamilies) {
      expect(entry.claimIds.length).toBeGreaterThan(0);
      for (const id of entry.claimIds) {
        const claim = selection.claims.find((item: { id: string }) => item.id === id);
        expect(claim, `${entry.name} cites ${id}`).toBeTruthy();
        expect(claim.property).toBe(entry.property);
        expect(claim.value).toBe(entry.value);
      }
      expect(tokensCss).toContain(`${entry.name}: ${entry.value.replace(/[\r\n;{}]/g, " ")};`);
    }

    // Component summaries describe the selected regions, not new observations.
    for (const component of components.components) {
      const region = selection.regions.find(
        (entry: { regionId: string }) => entry.regionId === component.regionId,
      );
      expect(region).toBeTruthy();
      expect(component.styles).toEqual(region.styles);
      expect(component.type).toBe(region.type);
      // A component summary may only cite claims stored against that same
      // component region, and it must list exactly that region's claims.
      for (const id of component.claimIds) {
        const claim = selection.claims.find((entry: { id: string }) => entry.id === id);
        expect(claim, `${component.regionId} cites ${id}`).toBeTruthy();
        expect(claim.regionId, `${component.regionId} cites ${id}`).toBe(component.regionId);
      }
      expect(new Set(component.claimIds)).toEqual(
        new Set(
          selection.claims
            .filter((entry: { regionId: string }) => entry.regionId === component.regionId)
            .map((entry: { id: string }) => entry.id),
        ),
      );
    }
    expect(components.components.map((component: { regionId: string }) => component.regionId)).toEqual([
      flow.componentHit.regionId,
    ]);
    expect(components.sections.map((section: { regionId: string }) => section.regionId)).toEqual([
      flow.sectionHit.regionId,
    ]);

    // Reference artifacts stay bound in the manifest; every media decision the
    // handoff lists resolves to a stored artifact row.
    expect(manifest.artifacts.references).toEqual(selection.references);
    for (const reference of manifest.artifacts.references) {
      expect(reference.artifactId).toMatch(/^[a-f0-9]{64}$/);
      expect(reference.kind).toMatch(
        /^(screenshot|raw_observation|component_pack|source_metadata|tokens|external_media)$/,
      );
      expect(reference.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(reference.bytes).toBeGreaterThan(0);
    }
    for (const decision of selection.media) {
      expect(handoff).toContain(decision.artifactId);
      expect(handoff).toContain(decision.sha256);
      if (decision.storagePath) expect(handoff).toContain(basename(decision.storagePath));
    }
    for (const asset of components.assets) {
      const decision = selection.media.find(
        (entry: { artifactId: string }) => entry.artifactId === asset.artifactId,
      );
      expect(decision).toBeTruthy();
      expect(asset.included).toBe(false);
      expect(asset.sha256).toBe(decision.sha256);
    }

    // The rendered prose contains no elevation or shadow observation.
    expect(design).not.toMatch(/box-shadow|text-shadow|z-index\s*:/i);
    expect(design).toContain("No elevation value is inferred");

    // A reviewer can follow the handoff: every numbered rebuild item resolves
    // to a selected region and every CSS variable to an observed claim value.
    const order = [
      ...handoff.matchAll(/^\d+\. (Section|Component) `([a-f0-9]{64})`/gm),
    ].map((match) => ({ kind: match[1]!.toLowerCase(), regionId: match[2]! }));
    expect(order).toHaveLength(2);
    expect(order.map((item) => item.regionId).sort()).toEqual(
      [flow.sectionHit.regionId, flow.componentHit.regionId].sort(),
    );
    const cssValues = [...tokensCss.matchAll(/--atlas-[\w-]+:\s*([^;]+);/g)].map((match) =>
      match[1]!.trim(),
    );
    const observedValues = new Set(
      selection.claims.map((claim: { value: string }) => String(claim.value)),
    );
    expect(cssValues.length).toBeGreaterThan(0);
    for (const value of cssValues) expect(observedValues.has(value)).toBe(true);
  });

  it("keeps missing viewport, state and motion evidence explicit", async () => {
    const flow = await runWorkflow();
    const design = document(flow.pack.directory, "DESIGN.md");
    const brief = document(flow.pack.directory, "brief.md");
    const handoff = document(flow.pack.directory, "rebuild-handoff.md");
    const manifest = documentJson(flow.pack.directory, "manifest.json");
    for (const name of ["DESIGN.md", "brief.md", "rebuild-handoff.md"] as const) {
      // Prose neutralizes Markdown, so the underscore in the reason is escaped.
      const text = document(flow.pack.directory, name);
      expect(text).toMatch(/mobile viewport: NOT\\?_CAPTURED/);
      expect(text).toMatch(/hover state: NOT\\?_CAPTURED/);
      expect(text).toMatch(/focus state: NOT\\?_CAPTURED/);
      expect(text).toMatch(/motion: NOT\\?_CAPTURED/);
    }
    expect(design).toContain("observed viewports: desktop");
    expect(design).toContain("observed interaction states: none");
    expect(handoff).toContain("Unobserved viewports, states and hierarchy remain unknown");
    expect(manifest.omitted).toEqual(
      expect.arrayContaining([
        { family: "mobile viewport", reason: "NOT_CAPTURED" },
        { family: "hover state", reason: "NOT_CAPTURED" },
        { family: "focus state", reason: "NOT_CAPTURED" },
        { family: "motion", reason: "NOT_CAPTURED" },
      ]),
    );
  });

  it("copies no media and downloads nothing in references mode", async () => {
    const flow = await runWorkflow();
    const manifest = documentJson(flow.pack.directory, "manifest.json");
    const selection = documentJson(flow.pack.directory, "artifacts/selection.json");
    expect(manifest.inclusionMode).toBe("references");
    expect(manifest.artifacts.included).toEqual([]);
    expect(selection.media.length).toBeGreaterThan(0);
    // The fixture has only first-party artifacts: references mode must classify
    // every one as REFERENCE_ONLY, with no external-media exception.
    for (const decision of selection.media) {
      expect(decision.kind).not.toBe("external_media");
      expect(decision.included).toBe(false);
      expect(decision.copiedPath).toBeNull();
      expect(decision.reason).toBe("REFERENCE_ONLY");
      expect(flow.pack.excludedArtifacts).toContainEqual({
        artifactId: decision.artifactId,
        reason: decision.reason,
      });
    }
    const copied = [...packFiles(flow.pack.directory).keys()].filter((path) =>
      /^artifacts\/[a-f0-9]{64}-/.test(path),
    );
    expect(copied).toEqual([]);
    expect(flow.fetched).not.toHaveBeenCalled();
  });

  it("explains external media as not copied without downloading it", async () => {
    const flow = await runWorkflow({ externalMedia: true });
    const selection = documentJson(flow.pack.directory, "artifacts/selection.json");
    const external = selection.media.filter(
      (decision: { kind: string }) => decision.kind === "external_media",
    );
    expect(external.length).toBeGreaterThan(0);
    for (const decision of external) {
      expect(decision.included).toBe(false);
      expect(decision.copiedPath).toBeNull();
      expect(decision.reason).toBe("EXTERNAL_MEDIA_NOT_COPIED");
      expect(flow.pack.excludedArtifacts).toContainEqual({
        artifactId: decision.artifactId,
        reason: "EXTERNAL_MEDIA_NOT_COPIED",
      });
    }
    for (const decision of selection.media.filter(
      (entry: { kind: string }) => entry.kind !== "external_media",
    )) {
      expect(decision.reason).toBe("REFERENCE_ONLY");
    }
    const copied = [...packFiles(flow.pack.directory).keys()].filter((path) =>
      /^artifacts\/[a-f0-9]{64}-/.test(path),
    );
    expect(copied).toEqual([]);
    expect(flow.fetched).not.toHaveBeenCalled();
  });

  it("serves a cached repeat deterministically and preserves it when evidence goes stale", async () => {
    const flow = await runWorkflow();
    const before = packFiles(flow.pack.directory);
    const beforeHash = flow.pack.manifestHash;

    const repeat = await flow.handlers.export_evidence_pack({
      regionIds: [flow.sectionHit.regionId, flow.componentHit.regionId],
      goal: GOAL,
    });
    expect(repeat.isError).toBeFalsy();
    const cached = envelope(repeat);
    expect(cached.status).toBe("ok");
    expect(cached.data.cached).toBe(true);
    expect(cached.data.packId).toBe(flow.pack.packId);
    expect(cached.data.manifestHash).toBe(beforeHash);
    expect(packFiles(flow.pack.directory)).toEqual(before);

    // Change the stored observation behind the published region. The pack id
    // is unchanged, so the cached pack is rechecked and refused, not rewritten.
    flow.cache.withAtlasDb((db) => {
      const row = db
        .prepare("SELECT samples_json FROM atlas_regions WHERE id = ?")
        .get(flow.sectionHit.regionId) as { samples_json: string };
      const samples = JSON.parse(row.samples_json) as { rect?: Record<string, number> };
      if (samples.rect) samples.rect.height = Number(samples.rect.height) + 1;
      db.prepare("UPDATE atlas_regions SET samples_json = ? WHERE id = ?").run(
        JSON.stringify(samples),
        flow.sectionHit.regionId,
      );
    });
    const stale = await flow.handlers.export_evidence_pack({
      regionIds: [flow.sectionHit.regionId, flow.componentHit.regionId],
      goal: GOAL,
    });
    expect(stale.isError).toBe(true);
    expect(envelope(stale).error.code).toBe("PACK_STALE");
    expect(packFiles(flow.pack.directory)).toEqual(before);
    expect(packFiles(flow.pack.directory).get("artifacts/selection.json")).toEqual(
      before.get("artifacts/selection.json"),
    );
  });

  it("refuses a corrupt pack without rewriting or deleting it", async () => {
    const flow = await runWorkflow();
    const designPath = join(flow.pack.directory, "DESIGN.md");
    writeFileSync(designPath, "corrupted after publication\n");
    const corrupted = packFiles(flow.pack.directory);

    const response = await flow.handlers.export_evidence_pack({
      regionIds: [flow.sectionHit.regionId, flow.componentHit.regionId],
      goal: GOAL,
    });
    expect(response.isError).toBe(true);
    expect(envelope(response).error.code).toBe("PACK_CORRUPT");
    expect(existsSync(flow.pack.directory)).toBe(true);
    expect(packFiles(flow.pack.directory)).toEqual(corrupted);
    expect(readFileSync(designPath, "utf8")).toBe("corrupted after publication\n");
  });

  it("refuses arbitrary URLs, off-origin paths and unknown references", async () => {
    const cache = cacheFor();
    const handlers = handlersFor(cache);
    const absolute = await handlers.capture_atlas({ slug: "https://evil.example/" });
    expect(absolute.isError).toBe(true);
    expect(envelope(absolute).error.code).toBe("INVALID_SITE_SLUG");

    const offOrigin = await handlers.capture_atlas({
      slug: SITE,
      path: "//evil.example/steal",
    });
    expect(offOrigin.isError).toBe(true);
    expect(envelope(offOrigin).error.code).toBe("UNSUPPORTED_ROUTE");

    const unknown = await handlers.capture_atlas({ slug: "never-cached" });
    expect(unknown.isError).toBe(true);
    expect(envelope(unknown).error.code).toBe("REFERENCE_UNAVAILABLE");
  });
});

// Keep the pilot record reproducible: run the focused test with
// PACK_PILOT_EVIDENCE=1 to print the exact ids and hashes the report cites.
describe("Atlas pack pilot evidence", () => {
  it("prints the recorded pilot identity when requested", async () => {
    if (process.env.PACK_PILOT_EVIDENCE !== "1") return;
    const flow = await runWorkflow();
    const files = packFiles(flow.pack.directory);
    const selectionBytes = files.get("artifacts/selection.json")!;
    const selection = JSON.parse(selectionBytes.toString("utf8"));
    const manifest = documentJson(flow.pack.directory, "manifest.json");
    process.stdout.write(
      `${JSON.stringify(
        {
          siteSlug: SITE,
          sourceUrls: selection.sourceUrls,
          exporterVersion: manifest.exporterVersion,
          captureId: flow.capture.captureId,
          pageId: flow.capture.pageId,
          viewport: flow.capture.viewport,
          statesRequested: selection.captures.flatMap(
            (capture: { requestedStates: string[] }) => capture.requestedStates,
          ),
          selectedRegionIds: [flow.sectionHit.regionId, flow.componentHit.regionId],
          packId: flow.pack.packId,
          manifestHash: flow.pack.manifestHash,
          selectionSha256: sha256(selectionBytes),
          references: manifest.artifacts.references,
          media: selection.media.map(
            (decision: {
              artifactId: string;
              kind: string;
              regionId: string | null;
              sha256: string;
              bytes: number;
              reason: string;
              included: boolean;
            }) => ({
              artifactId: decision.artifactId,
              kind: decision.kind,
              regionId: decision.regionId,
              sha256: decision.sha256,
              bytes: decision.bytes,
              reason: decision.reason,
              included: decision.included,
            }),
          ),
          omitted: manifest.omitted,
          files: [...files.keys()].sort().map((path) => ({
            path,
            sha256: sha256(files.get(path)!),
            bytes: files.get(path)!.length,
          })),
        },
        null,
        2,
      )}\n`,
    );
  });
});
