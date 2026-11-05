import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import { resolveAlias } from "../src/atlas/aliases.js";
import { prepareSitePage } from "../src/atlas/ingest.js";
import type { ElementRecord } from "../src/types.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-aliases-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;
const fixture = readFileSync(join("test", "fixtures", "detail.html"), "utf8");
const SITE_URL = "https://www.awwwards.com/sites/fixture-site";

const prepare = (fetchedAt = NOW) =>
  prepareSitePage({
    slug: "fixture-site",
    html: fixture,
    fetchedAt,
    sourceUrl: SITE_URL,
    summary: null,
  });

describe("atlas alias resolution", () => {
  it("resolves unique site and gallery aliases to the active highlight", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const prepared = prepare();
    const gallery: ElementRecord = {
      slug: "gallery-fixture",
      title: prepared.highlights[0]!.title,
      cid: "uncategorized",
      category: "uncategorized",
      author: "Fixture",
      builtWith: [],
      related: [],
      mediaPath: prepared.highlights[0]!.mediaPath,
      mediaType: "image",
      source: "gallery",
      projectId: null,
      siteSlug: "fixture-site",
      fetchedAt: NOW,
    };
    cache.upsertElements([gallery]);

    const result = await cache.commitSitePage(prepared);
    const siteRow = cache
      .listElements(100)
      .find((row) => row.source === "site" && row.mediaPath === gallery.mediaPath)!;
    expect(siteRow.slug).toMatch(/^site-fixture-site-[a-f0-9]{64}$/);

    expect(resolveAlias(cache, "legacy_element_slug", siteRow.slug)).toMatchObject({
      status: "resolved",
      aliasKind: "legacy_element_slug",
      alias: siteRow.slug,
      captureId: result.captureId,
      siteSlug: "fixture-site",
    });
    expect(resolveAlias(cache, "legacy_gallery_slug", gallery.slug)).toMatchObject({
      status: "resolved",
      aliasKind: "legacy_gallery_slug",
      alias: gallery.slug,
      captureId: result.captureId,
      siteSlug: "fixture-site",
    });
    expect(resolveAlias(cache, "legacy_element_slug", "missing-slug")).toEqual({
      status: "not_found",
      aliasKind: "legacy_element_slug",
      alias: "missing-slug",
    });
  });

  it("returns every match instead of choosing when an alias is ambiguous", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const result = await cache.commitSitePage(prepare());
    const siteRow = cache.listElements(100).find((row) => row.source === "site")!;
    const regions = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT id FROM atlas_regions WHERE capture_id = ? AND kind = 'highlight' ORDER BY id")
          .all(result.captureId) as Array<{ id: string }>,
    );
    expect(regions.length).toBeGreaterThan(1);
    cache.withAtlasDb((db) =>
      db
        .prepare("INSERT INTO atlas_aliases (alias_kind, alias, region_id) VALUES (?, ?, ?)")
        .run("legacy_element_slug", siteRow.slug, regions[1]!.id),
    );

    const resolution = resolveAlias(cache, "legacy_element_slug", siteRow.slug);
    expect(resolution.status).toBe("ambiguous");
    if (resolution.status === "ambiguous") {
      const expected = cache.withAtlasDb(
        (db) =>
          db
            .prepare("SELECT region_id FROM atlas_aliases WHERE alias_kind = ? AND alias = ? ORDER BY region_id")
            .all("legacy_element_slug", siteRow.slug) as Array<{ region_id: string }>,
      );
      expect(resolution.code).toBe("AMBIGUOUS_ALIAS");
      expect(resolution.regionIds).toEqual(expected.map((row) => row.region_id));
      expect(resolution.regionIds).toHaveLength(2);
    }
  });

  it("re-points an alias at the new head when the page is refetched", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const first = await cache.commitSitePage(prepare(NOW));
    const siteRow = cache.listElements(100).find((row) => row.source === "site")!;
    const refetched = prepareSitePage({
      slug: "fixture-site",
      html: `${fixture}\n<!-- refetched -->`,
      fetchedAt: NOW + 1000,
      sourceUrl: SITE_URL,
      summary: null,
    });
    const second = await cache.commitSitePage(refetched);

    expect(second.captureId).not.toBe(first.captureId);
    const aliasRows = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT region_id FROM atlas_aliases WHERE alias_kind = ? AND alias = ?")
          .all("legacy_element_slug", siteRow.slug) as Array<{ region_id: string }>,
    );
    expect(aliasRows).toHaveLength(1);
    const resolution = resolveAlias(cache, "legacy_element_slug", siteRow.slug);
    expect(resolution).toMatchObject({
      status: "resolved",
      captureId: second.captureId,
      alias: siteRow.slug,
    });
  });
});
