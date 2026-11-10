import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import { PACK_NOW, buildPackAttempt, publishPackFixture } from "./helpers/atlas-pack-fixture.js";
import { createHandlers } from "../src/server.js";
import { createServer } from "../src/server-instance.js";
import { runAtlasExport } from "../src/atlas/tool-export.js";
import { runAtlasSearch } from "../src/atlas/tool-search.js";
import { runAtlasCapture } from "../src/atlas/tool-capture.js";
import { runAtlasHighlight, runAtlasRegion, runAtlasStatus, runAtlasTaxonomy } from "../src/atlas/tool-read.js";
import { safeMessage } from "../src/atlas/tool-envelope.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-contract-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const atlasCache = () => new Cache(tmpDir(), () => PACK_NOW, { atlas: true });

describe("get_atlas status", () => {
  it("reports an empty Atlas cache without inventing counts", () => {
    const cache = atlasCache();
    const result = runAtlasStatus(cache, PACK_NOW);
    expect(result.status).toBe("ok");
    expect(result.data?.enabled).toBe(true);
    expect(result.data?.available).toBe(true);
    expect(result.data?.counts.captures.complete).toBe(0);
    expect(result.data?.revision).toBe(0);
    expect(result.data?.lease.state).toBe("free");
    expect(result.data?.coverageNote).toContain("Locally cached subset");
  });

  it("reports stored versions, counts, freshness, publication and deduplicated bytes", async () => {
    const cache = atlasCache();
    const fixture = await publishPackFixture(cache, { siteSlug: "probe" });
    const result = runAtlasStatus(cache, PACK_NOW + 1000);
    expect(result.status).toBe("ok");
    const data = result.data!;
    expect(data.available).toBe(true);
    expect(data.versions.schema).toBe(10);
    expect(data.versions.fts).toBe(4);
    expect(data.versions.vocabulary).toBe("atlas-vocabulary-4");
    expect(data.versions.classifier).toBe("atlas-classifier-2");
    expect(data.counts.sources.livePage).toBe(1);
    expect(data.counts.regions.section).toBe(fixture.sectionIds.length);
    expect(data.counts.regions.component).toBe(fixture.componentIds.length);
    expect(data.counts.captures.complete).toBe(1);
    expect(data.liveCaptures).toEqual({ fresh: 1, stale: 0, total: 1 });
    expect(data.latestPublication).toMatchObject({
      captureId: fixture.captureId,
      profileKey: "live-desktop",
    });
    expect("siteSlug" in data.latestPublication!).toBe(false);
    expect(data.lease.state).toBe("free");
    expect(data.artifacts.records).toBeGreaterThan(0);
    expect(data.artifacts.distinctHashes).toBeGreaterThan(0);
    expect(data.artifacts.bytes).toBeGreaterThan(0);
    expect(data.fts).toEqual({ available: true, version: 4 });
    expect(data.coverageNote).toContain("not all of Awwwards");
  });

  it("reports the latest failed attempt without leaking an absolute path", async () => {
    const cache = atlasCache();
    await publishPackFixture(cache, { siteSlug: "probe" });
    cache.withAtlasDb((db) => {
      db.prepare("UPDATE atlas_captures SET status = 'failed', error_json = ?").run(
        JSON.stringify({
          code: "CAPTURE_TIMEOUT",
          message: `failed under ${cache.rootDir}\\secret\\file.txt`,
        }),
      );
    });
    const data = runAtlasStatus(cache, PACK_NOW + 1000).data!;
    expect(data.latestFailedAttempt?.status).toBe("failed");
    expect(data.latestFailedAttempt?.error).toContain("CAPTURE_TIMEOUT");
    expect(data.latestFailedAttempt?.error).not.toContain(cache.rootDir);
    expect(data.latestFailedAttempt?.error).not.toContain("secret");
  });
});

describe("get_atlas taxonomy", () => {
  it("publishes the registry, scopes, states and explicit unsupported operations", () => {
    const result = runAtlasTaxonomy();
    expect(result.status).toBe("ok");
    const data = result.data!;
    expect(data.registryVersion).toBe("atlas-vocabulary-4");
    expect(data.fields.find((field) => field.field === "section.purpose")?.values.length).toBeGreaterThan(0);
    expect(data.fields.find((field) => field.field === "component.type")?.values.length).toBeGreaterThan(0);
    expect(data.scopes).toEqual(["region", "page", "site"]);
    expect(data.states).toEqual(["default", "hover", "focus"]);
    expect(data.evidenceModes).toContain("candidate");
    expect(data.unsupported.map((entry) => entry.operation)).toContain("gallery.fetch");
    const unknownPurpose = data.fields
      .find((field) => field.field === "section.purpose")
      ?.values.find((value) => value.value === "unknown");
    expect(unknownPurpose?.enabled).toBe(false);
    expect(unknownPurpose?.support).toBe("reserved");
  });
});

describe("get_atlas region", () => {
  it("returns a stored region with capture conditions, claims, artifacts, parent/children and head status", async () => {
    const cache = atlasCache();
    const fixture = await publishPackFixture(cache, { siteSlug: "probe" });
    const result = runAtlasRegion(cache, fixture.sectionIds[0]!);
    expect(result.status).toBe("ok");
    const data = result.data!;
    expect(data.region.kind).toBe("section");
    expect(data.region.captureId).toBe(fixture.captureId);
    expect(data.capture.siteSlug).toBe("probe");
    expect(data.capture.conditions.viewport).toBe("desktop");
    expect(data.capture.source.publicUrl).toBe("https://probe.example/");
    expect(data.claims.length).toBeGreaterThan(0);
    expect(data.claims.length).toBeLessThanOrEqual(128);
    expect(data.claimsTruncated).toBe(false);
    expect(data.parent?.regionId).toBe(fixture.pageRootId);
    expect(data.children.length).toBeGreaterThan(0);
    expect(data.artifacts.some((artifact) => artifact.kind === "raw_observation")).toBe(true);
    expect(data.artifacts.every((artifact) => artifact.available)).toBe(true);
    expect(data.head).toMatchObject({ current: true, headCaptureId: fixture.captureId });
  });

  it("marks a replaced region historical and keeps its evidence readable", async () => {
    const cache = atlasCache();
    const first = await publishPackFixture(cache, { siteSlug: "probe" });
    const second = await publishPackFixture(cache, {
      siteSlug: "probe",
      variant: "b",
      fetchedAt: PACK_NOW + 10_000,
    });
    const old = runAtlasRegion(cache, first.sectionIds[1]!);
    expect(old.data?.head.current).toBe(false);
    expect(old.data?.head.headCaptureId).toBe(second.captureId);
    expect(old.data?.claims.length).toBeGreaterThan(0);
  });

  it("rejects unknown, malformed and non-region ids", async () => {
    const cache = atlasCache();
    await publishPackFixture(cache, { siteSlug: "probe" });
    expect(runAtlasRegion(cache, "nope").error?.code).toBe("INVALID_INPUT");
    expect(runAtlasRegion(cache, "a".repeat(64)).error?.code).toBe("REGION_NOT_FOUND");

    const missing = await createHandlers({ client: {} as any, cache }).get_atlas({
      kind: "region",
      regionId: "a".repeat(64),
    });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toBeUndefined();
  });
});

describe("get_atlas highlight", () => {
  it("resolves a legacy element alias without fetching the gallery", async () => {
    const cache = atlasCache();
    const fixture = await publishPackFixture(cache, { siteSlug: "probe" });
    cache.withAtlasDb((db) => {
      db.prepare("INSERT INTO atlas_aliases (alias_kind, alias, region_id) VALUES (?, ?, ?)").run(
        "legacy_element_slug",
        "hero-panel",
        fixture.sectionIds[1]!,
      );
    });
    const result = runAtlasHighlight(cache, "hero-panel");
    expect(result.status).toBe("ok");
    expect(result.data?.status).toBe("resolved");
    expect(result.data?.aliasKind).toBe("legacy_element_slug");
    expect(result.data?.regionIds).toEqual([fixture.sectionIds[1]]);
    expect(result.data?.region?.region.regionId).toBe(fixture.sectionIds[1]);
  });

  it("returns AMBIGUOUS_ALIAS with candidates and not-found without a fetch", async () => {
    const cache = atlasCache();
    const fixture = await publishPackFixture(cache, { siteSlug: "probe" });
    cache.withAtlasDb((db) => {
      for (const regionId of [fixture.sectionIds[0]!, fixture.sectionIds[1]!]) {
        db.prepare("INSERT INTO atlas_aliases (alias_kind, alias, region_id) VALUES (?, ?, ?)").run(
          "legacy_element_slug",
          "shared",
          regionId,
        );
      }
    });
    const ambiguous = runAtlasHighlight(cache, "shared");
    expect(ambiguous.status).toBe("inconclusive");
    expect(ambiguous.error?.code).toBe("AMBIGUOUS_ALIAS");
    expect(ambiguous.data?.regionIds).toEqual(
      [fixture.sectionIds[0], fixture.sectionIds[1]].sort(),
    );

    const missing = runAtlasHighlight(cache, "never-seen");
    expect(missing.status).toBe("inconclusive");
    expect(missing.data).toMatchObject({ status: "not_found", regionIds: [] });
  });
});

describe("export_evidence_pack", () => {  it("builds a validated pack, then returns the same pack as cached", async () => {
    const cache = atlasCache();
    const fixture = await publishPackFixture(cache, { siteSlug: "probe" });
    const input = {
      regionIds: [fixture.sectionIds[1]!, fixture.componentIds[0]!],
      goal: "Rebuild the header and primary action",
    };
    const first = await runAtlasExport(cache, input, PACK_NOW + 1000);
    expect(first.status).toBe("ok");
    const data = first.data!;
    expect(data.cached).toBe(false);
    expect(data.packId).toMatch(/^[a-f0-9]{64}$/);
    expect(data.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(data.selectedRegionIds).toEqual([...input.regionIds].sort());
    expect(data.files.map((file) => file.path)).toContain("DESIGN.md");
    expect(data.validation).toEqual({
      manifest: "pass",
      claims: "pass",
      hashes: "pass",
      designMd: "pass",
    });
    expect(data.directory.startsWith(cache.rootDir)).toBe(true);

    const second = await runAtlasExport(cache, input, PACK_NOW + 2000);
    expect(second.status).toBe("ok");
    expect(second.data?.cached).toBe(true);
    expect(second.data?.packId).toBe(data.packId);
    expect(second.data?.manifestHash).toBe(data.manifestHash);
  });

  it("applies a neutral goal when omitted and rejects mixed sites", async () => {
    const cache = atlasCache();
    const probe = await publishPackFixture(cache, { siteSlug: "probe" });
    const other = await publishPackFixture(cache, { siteSlug: "other" });
    const single = await runAtlasExport(
      cache,
      { regionIds: [probe.sectionIds[1]!] },
      PACK_NOW + 1000,
    );
    expect(single.status).toBe("ok");

    // The handler pre-check, not the later builder rejection, must decide this.
    const build = vi.fn();
    const mixed = await runAtlasExport(
      cache,
      { regionIds: [probe.sectionIds[1]!, other.sectionIds[1]!] },
      PACK_NOW + 1000,
      { build: build as any },
    );
    expect(build).not.toHaveBeenCalled();
    expect(mixed.status).toBe("error");
    expect(mixed.error?.code).toBe("INVALID_SELECTION");
    const packRoot = join(cache.rootDir, "atlas", "evidence-packs");
    expect(existsSync(packRoot) ? readdirSync(packRoot).length : 0).toBe(1);
  });
});

describe("search_atlas", () => {
  it("returns the Atlas search envelope over the local fixture and fills interpreted defaults", async () => {
    const cache = atlasCache();
    await publishPackFixture(cache, { siteSlug: "probe" });
    const result = runAtlasSearch(cache, { kind: "sections", limit: 5 }, PACK_NOW + 1000);
    expect(result.status).toBe("ok");
    const data = result.data!;
    expect(data.outcome).toBe("matches");
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results.length).toBeLessThanOrEqual(5);
    expect(data.interpreted).toMatchObject({
      kind: "sections",
      scope: "region",
      viewport: "desktop",
      state: "default",
      evidenceMode: "candidate",
      groupBy: "instance",
      sort: "relevance",
      maxAgeDays: 30,
      limit: 5,
    });
    expect(data.countUnit).toBe("region_instance");
    expect(data.corpus.note).toBe("locally cached subset");
    expect(data.candidateOnly).toBe(true);
    expect(data.total).toBeGreaterThan(0);
  });

  it("returns inconclusive empty_corpus instead of claiming there are no examples", () => {
    const cache = atlasCache();
    const result = runAtlasSearch(cache, { kind: "components" }, PACK_NOW);
    expect(result.status).toBe("inconclusive");
    expect(result.data?.outcome).toBe("empty_corpus");
    expect(result.data?.results).toEqual([]);
    expect(result.error).toBeNull();
  });
});

describe("Atlas tool output contracts", () => {
  it("passes the SDK output validator for every tool and every get_atlas branch", async () => {
    const cache = atlasCache();
    cache.setMeta("detail:probe", {
      slug: "probe",
      title: "Probe",
      description: null,
      palette: [],
      technologies: [],
      elements: [],
      awards: [],
      nominee: false,
      score: null,
      ogImage: null,
      liveUrl: "https://probe.example/",
    });
    const fixture = await publishPackFixture(cache, { siteSlug: "probe" });
    cache.withAtlasDb((db) => {
      db.prepare("INSERT INTO atlas_aliases (alias_kind, alias, region_id) VALUES (?, ?, ?)").run(
        "legacy_element_slug",
        "hero-panel",
        fixture.sectionIds[1]!,
      );
    });
    const captureEnvelope = await runAtlasCapture(cache, { slug: "probe" }, {
      now: () => PACK_NOW,
      collect: async (_input: unknown, deps: any) => buildPackAttempt(deps.cache, { siteSlug: "probe" }),
      publish: async (attempt) => ({
        published: false,
        code: "NO_CLAIMS",
        captureIds: [],
        pageId: attempt.target.urlKey,
        regionCount: 0,
        componentCount: 0,
        claimCount: 0,
      }),
    });
    const handlers = createHandlers({
      client: {} as any,
      cache,
      atlasCaptureFn: async () => captureEnvelope,
    });
    const saved = process.env.AWWWARDS_MCP_ATLAS;
    const savedProfile = process.env.AWWWARDS_MCP_PROFILE;
    process.env.AWWWARDS_MCP_ATLAS = "1";
    delete process.env.AWWWARDS_MCP_PROFILE;
    try {
      const server = createServer({ handlers, version: "0.0.0-test" }) as any;
      const results: Array<[string, any]> = [
        ["search_atlas", await handlers.search_atlas({ kind: "sections", limit: 3 })],
        ["get_atlas", await handlers.get_atlas({ kind: "status" })],
        ["capture_atlas", await handlers.capture_atlas({ slug: "probe" })],
        [
          "export_evidence_pack",
          await handlers.export_evidence_pack({ regionIds: [fixture.sectionIds[1]!] }),
        ],
      ];
      for (const [name, result] of results) {
        await expect(
          server.validateToolOutput(server._registeredTools[name], result, name),
          name,
        ).resolves.toBeUndefined();
      }

      const get = server._registeredTools.get_atlas;
      for (const branch of [
        { kind: "taxonomy" },
        { kind: "region", regionId: fixture.sectionIds[1]! },
        { kind: "highlight", elementId: "hero-panel" },
      ] as const) {
        const result = await handlers.get_atlas(branch);
        await expect(
          server.validateToolOutput(get, result, `get_atlas ${branch.kind}`),
        ).resolves.toBeUndefined();
      }
    } finally {
      if (saved === undefined) delete process.env.AWWWARDS_MCP_ATLAS;
      else process.env.AWWWARDS_MCP_ATLAS = saved;
      if (savedProfile === undefined) delete process.env.AWWWARDS_MCP_PROFILE;
      else process.env.AWWWARDS_MCP_PROFILE = savedProfile;
    }
  });

  it("resolves a highlight without touching the HTTP client", async () => {
    const cache = atlasCache();
    const fixture = await publishPackFixture(cache, { siteSlug: "probe" });
    cache.withAtlasDb((db) => {
      db.prepare("INSERT INTO atlas_aliases (alias_kind, alias, region_id) VALUES (?, ?, ?)").run(
        "legacy_element_slug",
        "hero-panel",
        fixture.sectionIds[1]!,
      );
    });
    const handlers = createHandlers({
      client: {
        getHtml: () => {
          throw new Error("no network allowed");
        },
        getThumbnail: () => {
          throw new Error("no network allowed");
        },
      } as any,
      cache,
    });
    const result = await handlers.get_atlas({ kind: "highlight", elementId: "hero-panel" });
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent?.data as any)?.status).toBe("resolved");
  });
});

describe("get_atlas read failures", () => {
  const REGION = "a".repeat(64);

  it("separates schema drift from operational read failures", () => {
    const cache = atlasCache();
    const drift = vi.spyOn(cache, "withAtlasReadDb").mockImplementation(() => {
      throw new Error("Atlas cache schema 99 is newer than supported 10");
    });
    const tooNew = runAtlasRegion(cache, REGION);
    expect(tooNew.status).toBe("error");
    expect(tooNew.error).toMatchObject({ code: "SCHEMA_TOO_NEW", retryable: false });
    drift.mockRestore();

    const missingColumn = vi.spyOn(cache, "withAtlasReadDb").mockImplementation(() => {
      throw new Error("no such column: last_confirmed_at");
    });
    expect(runAtlasRegion(cache, REGION).error?.code).toBe("SCHEMA_TOO_NEW");
    missingColumn.mockRestore();

    const io = vi.spyOn(cache, "withAtlasReadDb").mockImplementation(() => {
      throw new Error(`disk I/O error in ${cache.rootDir}\\atlas.sqlite`);
    });
    const failed = runAtlasRegion(cache, REGION);
    expect(failed.status).toBe("error");
    expect(failed.error).toMatchObject({ code: "ATLAS_READ_FAILED", retryable: true });
    expect(failed.error?.message).toContain("<cache>");
    expect(failed.error?.message).not.toContain(cache.rootDir);
    io.mockRestore();

    const malformed = vi.spyOn(cache, "withAtlasDb").mockImplementation(() => {
      throw new Error("database disk image is malformed");
    });
    expect(runAtlasHighlight(cache, "hero-panel").error).toMatchObject({
      code: "ATLAS_READ_FAILED",
      retryable: true,
    });
    malformed.mockRestore();
  });
});

describe("Atlas error redaction", () => {
  it("redacts quoted and unquoted paths with spaces, drives and mixed separators", () => {
    expect(safeMessage("open '/home/afjal/My Folder/cache.db' failed")).toBe(
      "open '<path>' failed",
    );

    // Inside quotes, only the matching quote ends the path.
    expect(safeMessage('open "/home/My | Folder/secret.db" failed')).toBe(
      'open "<path>" failed',
    );
    expect(safeMessage('open "/home/My < Folder/secret.db" failed')).toBe(
      'open "<path>" failed',
    );
    expect(safeMessage("open '/home/My > Folder/secret.db' failed")).toBe(
      "open '<path>' failed",
    );

    const windows = safeMessage("cannot read C:\\Program Files\\Vendor\\secret.exe");
    expect(windows).toContain("<path>");
    expect(windows).not.toContain("Program Files");
    expect(windows).not.toContain("Vendor");
    expect(windows).not.toContain("secret");

    const mixed = safeMessage('"C:/Program Files\\Vendor/secret.exe"');
    expect(mixed).toContain("<path>");
    expect(mixed).not.toContain("Program Files");
    expect(mixed).not.toContain("secret");

    const root = "C:\\Users\\Afjal\\App Data\\Local\\cache";
    const below = safeMessage(`failed in ${root}\\db.sqlite`, root);
    expect(below).toContain("<cache>");
    expect(below).not.toContain("Afjal");
    expect(below).not.toContain("db.sqlite");
    expect(below).not.toContain(root);

    // Whitespace-only separators are prose, not paths.
    expect(safeMessage("read / write and 1 / 2")).toBe("read / write and 1 / 2");
  });

  it("keeps an embedded apostrophe inside a quoted path", () => {
    expect(safeMessage("open '/Users/O'Brien/My Folder/db.sqlite'")).toBe("open '<path>'");
    expect(safeMessage('open "/Users/O\'Brien/My Folder/db.sqlite"')).toBe('open "<path>"');
    expect(safeMessage("open 'C:\\Users\\O'Brien\\My Folder\\db.sqlite' failed")).toBe(
      "open '<path>' failed",
    );
    expect(safeMessage("failed at 'C:/Users/O'Brien/My Folder\\db.sqlite', retry")).toBe(
      "failed at '<path>', retry",
    );
    expect(safeMessage("open '/Users/O'Brien/My Folder/db.sqlite'")).not.toContain("Brien");
    expect(safeMessage("open 'C:\\Users\\O'Brien\\My Folder\\db.sqlite' failed")).not.toContain(
      "Brien",
    );
  });

  it("redacts an injected search error at the envelope boundary", async () => {
    const cache = atlasCache();
    const handlers = createHandlers({
      client: {} as any,
      cache,
      atlasSearchFn: () => {
        throw new Error("ENOENT: open 'C:\\Users\\Afjal\\My Folder\\cache.db'");
      },
    });
    const result = await handlers.search_atlas({ kind: "sections" });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toContain("<path>");
    expect(body.error.message).not.toContain("My Folder");
    expect(body.error.message).not.toContain("cache.db");
    expect(body.error.message).not.toContain("Afjal");
  });
});

describe("export_evidence_pack direct boundary", () => {
  it("enforces 1-12 distinct region ids before building", async () => {
    const cache = atlasCache();
    const id = (n: number) => String(n).padStart(2, "0").repeat(32);
    for (const regionIds of [
      [],
      [id(1), id(1)],
      Array.from({ length: 13 }, (_, index) => id(index + 1)),
    ]) {
      const result = await runAtlasExport(cache, { regionIds }, PACK_NOW);
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("INVALID_SELECTION");
    }

    // 13 real regions of one site: the builder accepts 200, so the handler
    // boundary itself must refuse before any pack is written.
    const fixture = await publishPackFixture(cache, { siteSlug: "probe", sectionCount: 13 });
    expect(fixture.sectionIds.length).toBeGreaterThanOrEqual(13);
    const tooMany = await runAtlasExport(
      cache,
      { regionIds: fixture.sectionIds.slice(0, 13) },
      PACK_NOW + 1000,
    );
    expect(tooMany.status).toBe("error");
    expect(tooMany.error?.code).toBe("INVALID_SELECTION");
    const packRoot = join(cache.rootDir, "atlas", "evidence-packs");
    expect(existsSync(packRoot) ? readdirSync(packRoot).length : 0).toBe(0);
  });
});
