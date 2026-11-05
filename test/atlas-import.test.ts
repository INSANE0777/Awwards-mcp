import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import { resolveAlias } from "../src/atlas/aliases.js";
import { prepareSitePage } from "../src/atlas/ingest.js";
import { sha256Text } from "../src/atlas/identity.js";
import { AtlasStore } from "../src/atlas/store.js";
import { importLegacyAtlas } from "../src/atlas/import.js";
import type { ElementRecord, SiteDetails } from "../src/types.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-import-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ORIGINAL = Date.UTC(2026, 8, 20, 12);
const IMPORT = Date.UTC(2026, 8, 28, 12);
const fixture = readFileSync(join("test", "fixtures", "detail.html"), "utf8");

const prepare = () =>
  prepareSitePage({
    slug: "fixture-site",
    html: fixture,
    fetchedAt: ORIGINAL,
    sourceUrl: "https://www.awwwards.com/sites/fixture-site",
    summary: null,
  });

const detail: SiteDetails = {
  slug: "alpha",
  title: "Alpha",
  description: "A cached description",
  palette: ["#000000"],
  technologies: ["GSAP"],
  elements: ["Hero"],
  awards: [{ title: "Site of the Day", date: "September 1, 2026" }],
  nominee: false,
  score: 7.5,
  ogImage: null,
  liveUrl: "https://alpha.example",
};

const elements = [
  { title: "Hero", mediaPath: "element/2026/08/a.jpg" },
  { title: "Hero", mediaPath: "element/2026/08/b.mp4" },
];

const galleryRow: ElementRecord = {
  slug: "gallery-hero",
  title: "Hero",
  cid: "uncategorized",
  category: "uncategorized",
  author: "Alpha",
  builtWith: [],
  related: [],
  mediaPath: "element/2026/08/a.jpg",
  mediaType: "image",
  source: "gallery",
  projectId: null,
  siteSlug: "alpha",
  fetchedAt: ORIGINAL,
};

const seededSiteRow: ElementRecord = {
  ...galleryRow,
  slug: "site-alpha-existing",
  source: "site",
  author: "Alpha Studio",
  cid: "hero",
  category: "hero",
  builtWith: ["GSAP"],
  fetchedAt: ORIGINAL - 5000,
};

const atlasCounts = (cache: Cache) =>
  cache.withAtlasDb((db) => ({
    captures: (db.prepare("SELECT COUNT(*) AS n FROM atlas_captures").get() as { n: number }).n,
    regions: (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions").get() as { n: number }).n,
    claims: (db.prepare("SELECT COUNT(*) AS n FROM atlas_claims").get() as { n: number }).n,
    heads: (db.prepare("SELECT COUNT(*) AS n FROM atlas_heads").get() as { n: number }).n,
    artifacts: (db.prepare("SELECT COUNT(*) AS n FROM atlas_artifacts").get() as { n: number }).n,
    aliases: (db.prepare("SELECT COUNT(*) AS n FROM atlas_aliases").get() as { n: number }).n,
  }));

describe("legacy Atlas import", () => {
  it("imports cached metadata without touching the network and keeps source timestamps", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => ORIGINAL, { atlas: true });
    cache.setMeta("detail:alpha", detail);
    cache.setMeta("elements:alpha", elements);
    cache.upsertElements([galleryRow, seededSiteRow]);

    const report = await importLegacyAtlas(cache, { now: () => IMPORT });
    expect(report).toMatchObject({
      enabled: true,
      sitePages: 1,
      galleryItems: 1,
      processed: 2,
      published: 2,
      unpublished: 0,
      artifacts: 2,
      skipped: 0,
      failures: [],
    });

    const capture = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            `SELECT status, source_fetched_at, source_digest, config_json, coverage_json
             FROM atlas_captures WHERE source_kind = 'awwwards_item'`,
          )
          .get() as {
          status: string;
          source_fetched_at: number | null;
          source_digest: string | null;
          config_json: string;
          coverage_json: string;
        },
    );
    expect(capture.status).toBe("partial");
    expect(capture.source_fetched_at).toBe(ORIGINAL);
    expect(capture.source_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(capture.config_json)).toMatchObject({
      provenance: "legacy_import",
      digestKind: "legacy_metadata",
    });
    expect(JSON.parse(capture.coverage_json).limitations).toContain("LEGACY_METADATA_ONLY");

    const artifact = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            `SELECT a.storage_path FROM atlas_artifacts a
             JOIN atlas_captures c ON c.id = a.capture_id
             JOIN atlas_pages p ON p.id = c.page_id
             WHERE p.kind = 'awwwards_item'`,
          )
          .get() as { storage_path: string },
    );
    const artifactPath = join(root, artifact.storage_path);
    expect(existsSync(artifactPath)).toBe(true);
    const body = JSON.parse(readFileSync(artifactPath, "utf8"));
    expect(body.schemaVersion).toBe("awwwards-atlas-legacy-metadata-v1");
    expect(body.digestKind).toBe("legacy_metadata");
    expect(body.detail).toEqual(detail);
    expect(body).not.toHaveProperty("html");

    expect(atlasCounts(cache)).toEqual({
      captures: 2, // source page + gallery element
      regions: 5, // source root + two highlights + gallery root + component
      claims: 3,
      heads: 2,
      artifacts: 2,
      aliases: 3, // two site slugs + one matching gallery slug
    });

    const galleryCapture = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            `SELECT status, source_kind, source_fetched_at
             FROM atlas_captures WHERE source_kind = 'legacy_gallery'`,
          )
          .get() as { status: string; source_kind: string; source_fetched_at: number | null },
    );
    expect(galleryCapture).toEqual({
      status: "partial",
      source_kind: "legacy_gallery",
      source_fetched_at: ORIGINAL,
    });
    expect(
      cache.withAtlasDb(
        (db) =>
          db
            .prepare(
              `SELECT p.kind FROM atlas_pages p JOIN atlas_captures c ON c.page_id = p.id
               WHERE c.source_kind = 'legacy_gallery'`,
            )
            .get() as { kind: string },
      ).kind,
    ).toBe("legacy_gallery");

    const legacyRows = cache.listElements(100);
    expect(legacyRows.filter((row) => row.source === "gallery")).toEqual([galleryRow]);
    const siteRows = legacyRows.filter((row) => row.source === "site");
    expect(siteRows.map((row) => row.mediaPath).sort()).toEqual([
      "element/2026/08/a.jpg",
      "element/2026/08/b.mp4",
    ]);
    const preserved = siteRows.find((row) => row.mediaPath === "element/2026/08/a.jpg")!;
    expect(preserved.slug).toBe(seededSiteRow.slug);
    expect(preserved.author).toBe("Alpha Studio");
    expect(preserved.cid).toBe("hero");
    expect(preserved.builtWith).toEqual(["GSAP"]);
    // Import never overwrites an existing element's source timestamp.
    expect(preserved.fetchedAt).toBe(ORIGINAL - 5000);
    expect(
      siteRows.find((row) => row.mediaPath === "element/2026/08/b.mp4")!.fetchedAt,
    ).toBe(ORIGINAL);
    expect(
      cache.getMeta<SiteDetails>("detail:alpha", Number.POSITIVE_INFINITY),
    ).toEqual(detail);
    expect(
      cache.withReadDb(
        (db) =>
          db.prepare("SELECT fetchedAt FROM meta WHERE key = 'detail:alpha'").get() as {
            fetchedAt: number;
          },
      ).fetchedAt,
    ).toBe(ORIGINAL);

    const siteAlias = siteRows.find((row) => row.mediaPath.endsWith("a.jpg"))!;
    expect(resolveAlias(cache, "legacy_element_slug", siteAlias.slug)).toMatchObject({
      status: "resolved",
      aliasKind: "legacy_element_slug",
      alias: siteAlias.slug,
    });
    expect(resolveAlias(cache, "legacy_gallery_slug", galleryRow.slug)).toMatchObject({
      status: "resolved",
      aliasKind: "legacy_gallery_slug",
      alias: galleryRow.slug,
    });
  });

  it("imports gallery-only caches as legacy_gallery evidence", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    const row: ElementRecord = {
      ...galleryRow,
      slug: "gallery-only",
      siteSlug: null,
      mediaPath: "element/2026/08/only.jpg",
    };
    cache.upsertElements([row]);

    const report = await importLegacyAtlas(cache, { now: () => IMPORT });
    expect(report).toMatchObject({
      enabled: true,
      sitePages: 0,
      galleryItems: 1,
      processed: 1,
      published: 1,
      failures: [],
    });
    expect(report.processed).toBeGreaterThan(0);

    const page = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            `SELECT p.kind, c.source_kind FROM atlas_pages p
             JOIN atlas_captures c ON c.page_id = p.id`,
          )
          .get() as { kind: string; source_kind: string },
    );
    expect(page).toEqual({ kind: "legacy_gallery", source_kind: "legacy_gallery" });
    expect(atlasCounts(cache)).toMatchObject({
      captures: 1,
      regions: 2,
      claims: 1,
      heads: 1,
    });
    expect(cache.listElements(100).find((item) => item.slug === row.slug)).toEqual(row);

    const resolution = resolveAlias(cache, "legacy_gallery_slug", row.slug);
    expect(resolution).toMatchObject({ status: "resolved", alias: row.slug });
    if (resolution.status === "resolved") {
      expect(
        cache.withAtlasDb(
          (db) =>
            db.prepare("SELECT kind FROM atlas_regions WHERE id = ?").get(resolution.regionId) as {
              kind: string;
            },
        ).kind,
      ).toBe("component");
    }
  });

  it("moves a gallery alias to the active site highlight when the site is captured later", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    const row: ElementRecord = {
      ...galleryRow,
      slug: "gallery-later",
      siteSlug: "alpha",
      mediaPath: "element/2026/08/later.jpg",
    };
    cache.upsertElements([row]);
    await importLegacyAtlas(cache, { now: () => IMPORT });
    const before = resolveAlias(cache, "legacy_gallery_slug", row.slug);
    expect(before).toMatchObject({ status: "resolved" });
    if (before.status === "resolved") {
      expect(
        cache.withAtlasDb(
          (db) =>
            db.prepare("SELECT kind FROM atlas_regions WHERE id = ?").get(before.regionId) as {
              kind: string;
            },
        ).kind,
      ).toBe("component");
    }

    const prepared = prepareSitePage({
      slug: "alpha",
      html:
        `<html><head><meta property="og:title" content="Alpha"></head><body>` +
        `<h2 class="text-default">Elements</h2>` +
        `<div data-collectable-model-value="{&quot;collectableImage&quot;:&quot;${row.mediaPath}&quot;,&quot;collectableTitle&quot;:&quot;Only&quot;}"></div>` +
        `<h2>Color Palette</h2></body></html>`,
      fetchedAt: ORIGINAL + 1000,
      sourceUrl: "https://www.awwwards.com/sites/alpha",
      summary: null,
    });
    await cache.commitSitePage(prepared);

    const after = resolveAlias(cache, "legacy_gallery_slug", row.slug);
    expect(after).toMatchObject({ status: "resolved", alias: row.slug });
    if (after.status === "resolved") {
      expect(
        cache.withAtlasDb(
          (db) =>
            db.prepare("SELECT kind FROM atlas_regions WHERE id = ?").get(after.regionId) as {
              kind: string;
            },
        ).kind,
      ).toBe("highlight");
    }
  });

  it("restores surviving gallery aliases when an empty site publication replaces the head", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    const row: ElementRecord = {
      ...galleryRow,
      slug: "gallery-survivor",
      siteSlug: "alpha",
      mediaPath: "element/2026/08/survivor.jpg",
    };
    cache.upsertElements([row]);
    await importLegacyAtlas(cache, { now: () => IMPORT });

    const blob = (image: string, title: string) =>
      `data-collectable-model-value="{&quot;collectableImage&quot;:&quot;${image}&quot;,&quot;collectableTitle&quot;:&quot;${title}&quot;}"`;
    const page = (body: string) =>
      `<html><head><meta property="og:title" content="Alpha"></head><body>${body}</body></html>`;
    const prepared = (html: string, fetchedAt: number) =>
      prepareSitePage({
        slug: "alpha",
        html,
        fetchedAt,
        sourceUrl: "https://www.awwwards.com/sites/alpha",
        summary: null,
      });

    await cache.commitSitePage(
      prepared(
        page(
          `<h2 class="text-default">Elements</h2><div ${blob(row.mediaPath, "Survivor")}></div><h2>Color Palette</h2>`,
        ),
        IMPORT + 1000,
      ),
    );
    const highlighted = resolveAlias(cache, "legacy_gallery_slug", row.slug);
    expect(highlighted).toMatchObject({ status: "resolved" });
    if (highlighted.status === "resolved") {
      expect(
        cache.withAtlasDb(
          (db) =>
            db.prepare("SELECT kind FROM atlas_regions WHERE id = ?").get(highlighted.regionId) as {
              kind: string;
            },
        ).kind,
      ).toBe("highlight");
    }

    await cache.commitSitePage(
      prepared(page("<h2>Color Palette</h2>"), IMPORT + 2000),
    );
    const restored = resolveAlias(cache, "legacy_gallery_slug", row.slug);
    expect(restored).toMatchObject({ status: "resolved" });
    if (restored.status === "resolved") {
      expect(
        cache.withAtlasDb(
          (db) =>
            db.prepare("SELECT kind FROM atlas_regions WHERE id = ?").get(restored.regionId) as {
              kind: string;
            },
        ).kind,
      ).toBe("component");
    }

    await importLegacyAtlas(cache, { now: () => IMPORT + 3000 });
    const afterReimport = resolveAlias(cache, "legacy_gallery_slug", row.slug);
    expect(afterReimport).toMatchObject({ status: "resolved" });
    if (afterReimport.status === "resolved") {
      expect(
        cache.withAtlasDb(
          (db) =>
            db.prepare("SELECT kind FROM atlas_regions WHERE id = ?").get(afterReimport.regionId) as {
              kind: string;
            },
        ).kind,
      ).toBe("component");
    }
  });

  it("restores each gallery alias to its own component with two gallery items", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    const first: ElementRecord = {
      ...galleryRow,
      slug: "gallery-first",
      siteSlug: "alpha",
      mediaPath: "element/2026/08/first.jpg",
    };
    const second: ElementRecord = {
      ...galleryRow,
      slug: "gallery-second",
      siteSlug: "alpha",
      mediaPath: "element/2026/08/second.jpg",
    };
    cache.upsertElements([first, second]);
    await importLegacyAtlas(cache, { now: () => IMPORT });

    const blob = (image: string, title: string) =>
      `data-collectable-model-value="{&quot;collectableImage&quot;:&quot;${image}&quot;,&quot;collectableTitle&quot;:&quot;${title}&quot;}"`;
    const page = (body: string) =>
      `<html><head><meta property="og:title" content="Alpha"></head><body>${body}</body></html>`;
    const prepared = (html: string, fetchedAt: number) =>
      prepareSitePage({
        slug: "alpha",
        html,
        fetchedAt,
        sourceUrl: "https://www.awwwards.com/sites/alpha",
        summary: null,
      });
    await cache.commitSitePage(
      prepared(
        page(
          `<h2 class="text-default">Elements</h2>` +
            `<div ${blob(first.mediaPath, "First")}></div>` +
            `<div ${blob(second.mediaPath, "Second")}></div>` +
            `<h2>Color Palette</h2>`,
        ),
        IMPORT + 1000,
      ),
    );
    await cache.commitSitePage(
      prepared(page("<h2>Color Palette</h2>"), IMPORT + 2000),
    );

    const componentFor = (slug: string) => {
      const resolution = resolveAlias(cache, "legacy_gallery_slug", slug);
      expect(resolution).toMatchObject({ status: "resolved", alias: slug });
      if (resolution.status !== "resolved") return null;
      return cache.withAtlasDb(
        (db) =>
          db
            .prepare("SELECT kind, samples_json FROM atlas_regions WHERE id = ?")
            .get(resolution.regionId) as { kind: string; samples_json: string },
      );
    };
    const firstRegion = componentFor(first.slug)!;
    const secondRegion = componentFor(second.slug)!;
    expect(firstRegion.kind).toBe("component");
    expect(secondRegion.kind).toBe("component");
    expect(JSON.parse(firstRegion.samples_json).gallerySlug).toBe(first.slug);
    expect(JSON.parse(secondRegion.samples_json).gallerySlug).toBe(second.slug);
    expect(firstRegion).not.toEqual(secondRegion);
  });

  it("keeps missing import timestamps unknown across reimports", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    cache.upsertElements([
      {
        ...galleryRow,
        slug: "site-no-time",
        source: "site",
        siteSlug: "alpha",
        mediaPath: "element/2026/08/no-time.jpg",
        fetchedAt: 0,
      },
    ]);
    const first = await importLegacyAtlas(cache, { now: () => IMPORT });
    expect(first.limitations).toContain("MISSING_TIMESTAMP");
    const second = await importLegacyAtlas(cache, { now: () => IMPORT + 60_000 });
    expect(second.limitations).toContain("MISSING_TIMESTAMP");

    const capture = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT source_fetched_at, last_confirmed_at FROM atlas_captures WHERE source_kind = 'awwwards_item'",
          )
          .get() as { source_fetched_at: number | null; last_confirmed_at: number | null },
    );
    expect(capture).toEqual({ source_fetched_at: null, last_confirmed_at: null });
    const row = cache
      .listElements(100)
      .find((item) => item.slug === "site-no-time")!;
    expect(row.fetchedAt).toBe(0);
    expect(cache.listElements(100)).toHaveLength(1);
  });

  it("bumps gallery revision when an old confirmation becomes fresh", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    const row = {
      slug: "gallery-age-old",
      title: "Age old",
      siteSlug: "alpha",
      author: "Alpha",
      mediaPath: "element/2026/08/age-old.jpg",
      mediaType: "image" as const,
      fetchedAt: ORIGINAL - 31 * 24 * 60 * 60 * 1000,
    };
    await new AtlasStore(cache, { now: () => ORIGINAL }).commitLegacyGallery(row);
    await new AtlasStore(cache, { now: () => ORIGINAL }).commitLegacyGallery({
      ...row,
      fetchedAt: ORIGINAL,
    });
    expect(
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }).revision,
      ),
    ).toBe(2);
  });

  it("bumps gallery revision when a fresh confirmation ages out", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    const row = {
      slug: "gallery-age-fresh",
      title: "Age fresh",
      siteSlug: "alpha",
      author: "Alpha",
      mediaPath: "element/2026/08/age-fresh.jpg",
      mediaType: "image" as const,
      fetchedAt: ORIGINAL,
    };
    await new AtlasStore(cache, { now: () => ORIGINAL }).commitLegacyGallery(row);
    await new AtlasStore(cache, {
      now: () => ORIGINAL + 31 * 24 * 60 * 60 * 1000,
    }).commitLegacyGallery(row);
    expect(
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }).revision,
      ),
    ).toBe(2);
  });

  it("bumps gallery revision when an aged-out head is refreshed", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    const row = {
      slug: "gallery-age-refresh",
      title: "Age refresh",
      siteSlug: "alpha",
      author: "Alpha",
      mediaPath: "element/2026/08/age-refresh.jpg",
      mediaType: "image" as const,
      fetchedAt: ORIGINAL,
    };
    await new AtlasStore(cache, { now: () => ORIGINAL }).commitLegacyGallery(row);
    const later = ORIGINAL + 31 * 24 * 60 * 60 * 1000;
    await new AtlasStore(cache, { now: () => later }).commitLegacyGallery({
      ...row,
      fetchedAt: later,
    });
    expect(
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }).revision,
      ),
    ).toBe(2);
  });

  it("removes gallery FTS and aliases when an invalid head is dropped", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    const row = {
      slug: "gallery-invalid-head",
      title: "Invalid gallery",
      siteSlug: "alpha",
      author: "Alpha",
      mediaPath: "element/2026/08/invalid.jpg",
      mediaType: "image" as const,
      fetchedAt: ORIGINAL,
    };
    await new AtlasStore(cache, { now: () => ORIGINAL }).commitLegacyGallery(row);
    cache.withAtlasDb((db) => {
      db.prepare(
        "UPDATE atlas_captures SET status = 'failed' WHERE source_kind = 'legacy_gallery'",
      ).run();
    });
    const invalid = await new AtlasStore(cache, { now: () => ORIGINAL }).commitLegacyGallery(row);
    expect(invalid.published).toBe(false);
    expect(atlasCounts(cache)).toMatchObject({ captures: 1, heads: 0 });
    expect(
      cache.withAtlasDb((db) =>
        db
          .prepare("SELECT alias_kind, alias, region_id FROM atlas_aliases ORDER BY alias_kind, alias, region_id")
          .all(),
      ),
    ).toEqual([]);
    expect(
      cache.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
      ),
    ).toBe(0);
    expect(
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }).revision,
      ),
    ).toBe(2);
  });

  it("bumps revision when gallery confirmation changes freshness eligibility", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    const row = {
      slug: "gallery-eligibility",
      title: "Eligibility",
      siteSlug: "alpha",
      author: "Alpha",
      mediaPath: "element/2026/08/eligibility.jpg",
      mediaType: "image" as const,
      fetchedAt: null,
    };
    await new AtlasStore(cache, { now: () => ORIGINAL }).commitLegacyGallery(row);
    const first = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT source_fetched_at, last_confirmed_at FROM atlas_captures")
          .get() as { source_fetched_at: number | null; last_confirmed_at: number | null },
    );
    expect(first).toEqual({ source_fetched_at: null, last_confirmed_at: null });
    await new AtlasStore(cache, { now: () => ORIGINAL + 1000 }).commitLegacyGallery({
      ...row,
      fetchedAt: ORIGINAL + 1000,
    });
    expect(
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }).revision,
      ),
    ).toBe(2);
    expect(
      cache.withAtlasDb(
        (db) =>
          db
            .prepare("SELECT source_fetched_at, last_confirmed_at FROM atlas_captures")
            .get() as { source_fetched_at: number | null; last_confirmed_at: number | null },
      ),
    ).toEqual({ source_fetched_at: null, last_confirmed_at: ORIGINAL + 1000 });
  });

  it("restores gallery aliases when migration removes an invalid site head", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => ORIGINAL, { atlas: true });
    const gallery: ElementRecord = {
      ...galleryRow,
      slug: "gallery-migrate",
      siteSlug: "alpha",
      mediaPath: "element/2026/08/migrate.jpg",
    };
    cache.upsertElements([gallery]);
    await importLegacyAtlas(cache, { now: () => IMPORT });
    const blob = (image: string, title: string) =>
      `data-collectable-model-value="{&quot;collectableImage&quot;:&quot;${image}&quot;,&quot;collectableTitle&quot;:&quot;${title}&quot;}"`;
    await cache.commitSitePage(
      prepareSitePage({
        slug: "alpha",
        html:
          `<html><head><meta property="og:title" content="Alpha"></head><body>` +
          `<h2 class="text-default">Elements</h2>` +
          `<div ${blob(gallery.mediaPath, "Migrate")}></div>` +
          `<h2>Color Palette</h2></body></html>`,
        fetchedAt: IMPORT + 1000,
        sourceUrl: "https://www.awwwards.com/sites/alpha",
        summary: null,
      }),
    );
    expect(resolveAlias(cache, "legacy_gallery_slug", gallery.slug)).toMatchObject({
      status: "resolved",
    });
    expect(
      cache.withAtlasDb(
        (db) =>
          (db
            .prepare(
              `SELECT r.kind FROM atlas_aliases a JOIN atlas_regions r ON r.id = a.region_id
               WHERE a.alias = ?`,
            )
            .get(gallery.slug) as { kind: string }).kind,
      ),
    ).toBe("highlight");
    cache.withAtlasDb((db) => {
      db.prepare(
        "UPDATE atlas_captures SET status = 'failed' WHERE source_kind = 'awwwards_item'",
      ).run();
      db.prepare("UPDATE atlas_state SET schema_version = 5 WHERE singleton = 1").run();
    });

    const reopened = new Cache(root, () => ORIGINAL, { atlas: true });
    const resolution = resolveAlias(reopened, "legacy_gallery_slug", gallery.slug);
    expect(resolution).toMatchObject({ status: "resolved", alias: gallery.slug });
    if (resolution.status === "resolved") {
      expect(
        reopened.withAtlasDb(
          (db) =>
            db.prepare("SELECT kind FROM atlas_regions WHERE id = ?").get(resolution.regionId) as {
              kind: string;
            },
        ).kind,
      ).toBe("component");
    }
  });

  it("replaces a gallery slug alias when its media changes", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    const row: ElementRecord = {
      ...galleryRow,
      slug: "gallery-media-change",
      siteSlug: "alpha",
      mediaPath: "element/2026/08/change-a.jpg",
    };
    cache.upsertElements([row]);
    await importLegacyAtlas(cache, { now: () => IMPORT });
    const blob = (image: string, title: string) =>
      `data-collectable-model-value="{&quot;collectableImage&quot;:&quot;${image}&quot;,&quot;collectableTitle&quot;:&quot;${title}&quot;}"`;
    await cache.commitSitePage(
      prepareSitePage({
        slug: "alpha",
        html:
          `<html><head><meta property="og:title" content="Alpha"></head><body>` +
          `<h2 class="text-default">Elements</h2>` +
          `<div ${blob(row.mediaPath, "Change")}></div>` +
          `<h2>Color Palette</h2></body></html>`,
        fetchedAt: IMPORT + 1000,
        sourceUrl: "https://www.awwwards.com/sites/alpha",
        summary: null,
      }),
    );
    await new AtlasStore(cache, { now: () => IMPORT + 2000 }).commitLegacyGallery({
      slug: row.slug,
      title: row.title,
      siteSlug: row.siteSlug,
      author: row.author,
      mediaPath: "element/2026/08/change-b.jpg",
      mediaType: "image",
      fetchedAt: IMPORT + 2000,
    });

    const aliases = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT region_id FROM atlas_aliases WHERE alias_kind = 'legacy_gallery_slug' AND alias = ?",
          )
          .all(row.slug) as Array<{ region_id: string }>,
    );
    expect(aliases).toHaveLength(1);
    const resolution = resolveAlias(cache, "legacy_gallery_slug", row.slug);
    expect(resolution).toMatchObject({ status: "resolved", alias: row.slug });
    if (resolution.status === "resolved") {
      const region = cache.withAtlasDb(
        (db) =>
          db.prepare("SELECT kind, samples_json FROM atlas_regions WHERE id = ?").get(
            resolution.regionId,
          ) as { kind: string; samples_json: string },
      );
      expect(region.kind).toBe("component");
      expect(JSON.parse(region.samples_json).mediaPath).toBe(
        "element/2026/08/change-b.jpg",
      );
    }
  });

  it("rejects a reused gallery capture with a missing artifact", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => ORIGINAL, { atlas: true });
    const row = {
      slug: "gallery-missing-artifact",
      title: "Missing artifact",
      siteSlug: "alpha",
      author: "Alpha",
      mediaPath: "element/2026/08/missing-artifact.jpg",
      mediaType: "image" as const,
      fetchedAt: ORIGINAL,
    };
    const first = await new AtlasStore(cache, { now: () => ORIGINAL }).commitLegacyGallery(row);
    const artifact = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT storage_path FROM atlas_artifacts WHERE capture_id = ?")
          .get(first.captureId) as { storage_path: string },
    );
    rmSync(join(root, artifact.storage_path), { force: true });
    const reused = await new AtlasStore(cache, {
      now: () => ORIGINAL + 1000,
    }).commitLegacyGallery({ ...row, fetchedAt: ORIGINAL + 1000 });
    expect(reused.published).toBe(false);
    expect(atlasCounts(cache)).toMatchObject({ captures: 1, heads: 0, artifacts: 1 });
    expect(
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
      ),
    ).toBe(0);
    expect(
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }).revision,
      ),
    ).toBe(2);
  });

  it("rejects a reused gallery capture with a corrupt artifact", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => ORIGINAL, { atlas: true });
    const row = {
      slug: "gallery-corrupt-artifact",
      title: "Corrupt artifact",
      siteSlug: "alpha",
      author: "Alpha",
      mediaPath: "element/2026/08/corrupt-artifact.jpg",
      mediaType: "image" as const,
      fetchedAt: ORIGINAL,
    };
    const first = await new AtlasStore(cache, { now: () => ORIGINAL }).commitLegacyGallery(row);
    const artifact = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT storage_path FROM atlas_artifacts WHERE capture_id = ?")
          .get(first.captureId) as { storage_path: string },
    );
    writeFileSync(join(root, artifact.storage_path), "corrupt");
    const reused = await new AtlasStore(cache, {
      now: () => ORIGINAL + 1000,
    }).commitLegacyGallery({ ...row, fetchedAt: ORIGINAL + 1000 });
    expect(reused.published).toBe(false);
    expect(atlasCounts(cache)).toMatchObject({ captures: 1, heads: 0, artifacts: 1 });
    expect(
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
      ),
    ).toBe(0);
    expect(
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }).revision,
      ),
    ).toBe(2);
  });

  it("preserves the healthy gallery head when an older capture artifact is invalid", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => ORIGINAL, { atlas: true });
    const a = {
      slug: "gallery-aba",
      title: "A",
      siteSlug: "alpha",
      author: "Alpha",
      mediaPath: "element/2026/08/aba-a.jpg",
      mediaType: "image" as const,
      fetchedAt: ORIGINAL,
    };
    const aResult = await new AtlasStore(cache, { now: () => ORIGINAL }).commitLegacyGallery(a);
    const bResult = await new AtlasStore(cache, {
      now: () => ORIGINAL + 1000,
    }).commitLegacyGallery({
      ...a,
      mediaPath: "element/2026/08/aba-b.jpg",
      fetchedAt: ORIGINAL + 1000,
    });
    expect(bResult.published).toBe(true);
    const artifact = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT storage_path FROM atlas_artifacts WHERE capture_id = ?")
          .get(aResult.captureId) as { storage_path: string },
    );
    const before = cache.withAtlasDb((db) => ({
      head: (db.prepare("SELECT capture_id FROM atlas_heads").get() as { capture_id: string })
        .capture_id,
      revision: (
        db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
          revision: number;
        }
      ).revision,
      fts: db
        .prepare(
          "SELECT region_id, title, heading, copy, labels, context FROM atlas_regions_fts ORDER BY region_id",
        )
        .all(),
      aliases: db
        .prepare(
          "SELECT alias_kind, alias, region_id FROM atlas_aliases ORDER BY alias_kind, alias, region_id",
        )
        .all(),
    }));
    rmSync(join(root, artifact.storage_path), { force: true });
    const again = await new AtlasStore(cache, {
      now: () => ORIGINAL + 2000,
    }).commitLegacyGallery({ ...a, fetchedAt: ORIGINAL + 2000 });
    expect(again.published).toBe(false);
    expect(
      cache.withAtlasDb((db) => ({
        head: (db.prepare("SELECT capture_id FROM atlas_heads").get() as { capture_id: string })
          .capture_id,
        revision: (
          db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }
        ).revision,
        fts: db
          .prepare(
            "SELECT region_id, title, heading, copy, labels, context FROM atlas_regions_fts ORDER BY region_id",
          )
          .all(),
        aliases: db
          .prepare(
            "SELECT alias_kind, alias, region_id FROM atlas_aliases ORDER BY alias_kind, alias, region_id",
          )
          .all(),
      })),
    ).toEqual(before);
  });

  it("rejects invalid gallery evidence pointers without changing the healthy projection", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => ORIGINAL, { atlas: true });
    const a = {
      slug: "gallery-evidence",
      title: "Evidence",
      siteSlug: "alpha",
      author: "Alpha",
      mediaPath: "element/2026/08/evidence-a.jpg",
      mediaType: "image" as const,
      fetchedAt: ORIGINAL,
    };
    const aResult = await new AtlasStore(cache, { now: () => ORIGINAL }).commitLegacyGallery(a);
    const bResult = await new AtlasStore(cache, {
      now: () => ORIGINAL + 1000,
    }).commitLegacyGallery({
      ...a,
      mediaPath: "element/2026/08/evidence-b.jpg",
      fetchedAt: ORIGINAL + 1000,
    });
    expect(bResult.published).toBe(true);
    const artifact = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT id, storage_path, sha256, bytes FROM atlas_artifacts WHERE capture_id = ?")
          .get(aResult.captureId) as {
          id: string;
          storage_path: string;
          sha256: string;
          bytes: number;
        },
    );
    const oversizedKey = "a".repeat(1000);
    const artifactPath = join(root, artifact.storage_path);
    const artifactBody = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
    artifactBody[oversizedKey] = "existing";
    const artifactText = JSON.stringify(artifactBody);
    writeFileSync(artifactPath, artifactText);
    cache.withAtlasDb((db) => {
      db.prepare("UPDATE atlas_artifacts SET sha256 = ?, bytes = ? WHERE id = ?").run(
        sha256Text(artifactText),
        Buffer.byteLength(artifactText),
        artifact.id,
      );
    });
    const snapshot = () =>
      cache.withAtlasDb((db) => ({
        head: (db.prepare("SELECT capture_id FROM atlas_heads").get() as { capture_id: string })
          .capture_id,
        revision: (
          db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }
        ).revision,
        capture: db
          .prepare(
            "SELECT status, source_fetched_at, last_confirmed_at, finished_at FROM atlas_captures WHERE id = ?",
          )
          .get(aResult.captureId),
        fts: db
          .prepare(
            "SELECT region_id, title, heading, copy, labels, context FROM atlas_regions_fts ORDER BY region_id",
          )
          .all(),
        aliases: db.prepare("SELECT * FROM atlas_aliases ORDER BY alias").all(),
      }));
    const before = snapshot();
    const invalid = [
      "[]",
      JSON.stringify([{ artifactId: artifact.id, pointer: "/~2bad", sampleKey: "x" }]),
      JSON.stringify([{ artifactId: artifact.id, pointer: "/gallery/missing", sampleKey: "x" }]),
      JSON.stringify([
        { artifactId: artifact.id, pointer: `/${"a".repeat(1000)}`, sampleKey: "x" },
      ]),
      JSON.stringify([
        { artifactId: artifact.id, pointer: "/gallery/title", sampleKey: "x".repeat(101) },
      ]),
      JSON.stringify([
        {
          artifactId: artifact.id,
          pointer: "/gallery/title",
          sampleKey: "x",
          extra: true,
        },
      ]),
    ];
    for (const evidence of invalid) {
      cache.withAtlasDb((db) => {
        db.prepare(
          `UPDATE atlas_claims SET evidence_json = ?
           WHERE region_id IN (SELECT id FROM atlas_regions WHERE capture_id = ?)`,
        ).run(evidence, aResult.captureId);
      });
      const reused = await new AtlasStore(cache, {
        now: () => ORIGINAL + 2000,
      }).commitLegacyGallery({ ...a, fetchedAt: ORIGINAL + 2000 });
      expect(reused.published).toBe(false);
      expect(snapshot()).toEqual(before);
    }
  });

  it("bumps gallery revision when an identical refetch repairs FTS documents", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    const row = {
      slug: "gallery-fts-repair",
      title: "FTS repair",
      siteSlug: "alpha",
      author: "Alpha",
      mediaPath: "element/2026/08/fts-repair.jpg",
      mediaType: "image" as const,
      fetchedAt: ORIGINAL,
    };
    await new AtlasStore(cache, { now: () => ORIGINAL }).commitLegacyGallery(row);
    cache.withAtlasDb((db) => {
      db.prepare(
        "DELETE FROM atlas_regions_fts WHERE region_id = (SELECT region_id FROM atlas_regions_fts LIMIT 1)",
      ).run();
    });
    expect(
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
      ),
    ).toBe(1);

    await new AtlasStore(cache, { now: () => ORIGINAL }).commitLegacyGallery(row);
    expect(
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
      ),
    ).toBe(2);
    expect(
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }).revision,
      ),
    ).toBe(2);

    await new AtlasStore(cache, { now: () => ORIGINAL }).commitLegacyGallery(row);
    expect(
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }).revision,
      ),
    ).toBe(2);
  });

  it("retires duplicate gallery heads when ownership changes", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    const row: ElementRecord = {
      ...galleryRow,
      slug: "gallery-ownership",
      siteSlug: null,
      mediaPath: "element/2026/08/ownership.jpg",
    };
    cache.upsertElements([row]);
    await importLegacyAtlas(cache, { now: () => IMPORT });
    expect(atlasCounts(cache)).toMatchObject({
      captures: 1,
      heads: 1,
      aliases: 1,
    });
    expect(
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
      ),
    ).toBe(2);

    cache.upsertElements([{ ...row, siteSlug: "alpha" }]);
    await importLegacyAtlas(cache, { now: () => IMPORT + 1000 });
    expect(atlasCounts(cache)).toMatchObject({
      captures: 2,
      heads: 1,
      aliases: 1,
    });
    expect(
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
      ),
    ).toBe(2);
    const revision = () =>
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }).revision,
      );
    expect(revision()).toBe(2);
    const resolution = resolveAlias(cache, "legacy_gallery_slug", row.slug);
    expect(resolution).toMatchObject({ status: "resolved", alias: row.slug });
    if (resolution.status === "resolved") {
      const capture = cache.withAtlasDb(
        (db) =>
          db.prepare("SELECT capture_id FROM atlas_regions WHERE id = ?").get(
            resolution.regionId,
          ) as { capture_id: string },
      );
      expect(
        cache.withAtlasDb(
          (db) =>
            (
              db
                .prepare(
                  `SELECT c.id FROM atlas_captures c
                   JOIN atlas_pages p ON p.id = c.page_id
                   WHERE p.site_slug = 'alpha' AND p.kind = 'legacy_gallery'
                     AND p.url_key = ?`,
                )
                .get(`inspiration:${row.slug}`) as { id: string }
            ).id,
        ),
      ).toBe(capture.capture_id);
    }

    await importLegacyAtlas(cache, { now: () => IMPORT + 2000 });
    expect(atlasCounts(cache)).toMatchObject({
      captures: 2,
      heads: 1,
      aliases: 1,
    });
    expect(
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
      ),
    ).toBe(2);
    expect(revision()).toBe(2);
  });

  it("does not let a stale owner retire a newer gallery head", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    const row: ElementRecord = {
      ...galleryRow,
      slug: "gallery-stale-owner",
      siteSlug: null,
      mediaPath: "element/2026/08/stale-owner.jpg",
    };
    cache.upsertElements([row]);
    await importLegacyAtlas(cache, { now: () => IMPORT });
    cache.upsertElements([{ ...row, siteSlug: "alpha", fetchedAt: IMPORT + 2000 }]);
    await importLegacyAtlas(cache, { now: () => IMPORT + 2000 });
    const head = () =>
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT capture_id FROM atlas_heads").get() as { capture_id: string })
            .capture_id,
      );
    const currentHead = head();
    const ftsBefore = cache.withAtlasDb((db) =>
      db
        .prepare(
          "SELECT region_id, title, heading, copy, labels, context FROM atlas_regions_fts ORDER BY region_id",
        )
        .all(),
    );
    const aliasesBefore = cache.withAtlasDb((db) =>
      db
        .prepare("SELECT alias_kind, alias, region_id FROM atlas_aliases ORDER BY alias")
        .all(),
    );
    const revision = () =>
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }).revision,
      );
    expect(revision()).toBe(2);

    cache.upsertElements([{ ...row, fetchedAt: IMPORT + 1000 }]);
    const report = await importLegacyAtlas(cache, { now: () => IMPORT + 1000 });
    expect(report).toMatchObject({ published: 0, unpublished: 1 });
    expect(head()).toBe(currentHead);
    expect(revision()).toBe(2);
    expect(
      cache.withAtlasDb((db) =>
        db
          .prepare(
            "SELECT region_id, title, heading, copy, labels, context FROM atlas_regions_fts ORDER BY region_id",
          )
          .all(),
      ),
    ).toEqual(ftsBefore);
    expect(
      cache.withAtlasDb((db) =>
        db
          .prepare("SELECT alias_kind, alias, region_id FROM atlas_aliases ORDER BY alias")
          .all(),
      ),
    ).toEqual(aliasesBefore);
    const resolution = resolveAlias(cache, "legacy_gallery_slug", row.slug);
    expect(resolution).toMatchObject({ status: "resolved" });
    if (resolution.status === "resolved") {
      const region = cache.withAtlasDb(
        (db) =>
          db.prepare("SELECT capture_id FROM atlas_regions WHERE id = ?").get(
            resolution.regionId,
          ) as { capture_id: string },
      );
      expect(region.capture_id).toBe(currentHead);
    }
  });

  it("keeps candidate gallery claims out of FTS labels", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    const row: ElementRecord = {
      ...galleryRow,
      slug: "gallery-labels",
      mediaPath: "element/2026/08/labels.jpg",
    };
    cache.upsertElements([row]);
    await importLegacyAtlas(cache, { now: () => IMPORT });
    const region = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            `SELECT r.id, r.capture_id, c.decision
             FROM atlas_regions r
             JOIN atlas_claims c ON c.region_id = r.id
             WHERE r.kind = 'component' AND json_extract(r.samples_json, '$.gallerySlug') = ?`,
          )
          .get(row.slug) as { id: string; capture_id: string; decision: string },
    );
    expect(region.decision).toBe("candidate");
    const fts = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT title, copy, labels FROM atlas_regions_fts WHERE region_id = ?")
          .get(region.id) as { title: string; copy: string; labels: string },
    );
    expect(fts).toEqual({ title: row.title, copy: row.title, labels: "" });

    cache.withAtlasDb((db) => {
      db.prepare("UPDATE atlas_regions_fts SET labels = 'source.title stale' WHERE region_id = ?").run(
        region.id,
      );
      db.prepare("UPDATE atlas_state SET schema_version = 5 WHERE singleton = 1").run();
    });
    const reopened = new Cache(cache.rootDir, () => ORIGINAL, { atlas: true });
    const repaired = reopened.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT title, copy, labels FROM atlas_regions_fts WHERE region_id = ?")
          .get(region.id) as { title: string; copy: string; labels: string },
    );
    expect(repaired).toEqual({ title: row.title, copy: row.title, labels: "" });
  });

  it("accepts the RFC root pointer for gallery evidence", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    const row = {
      slug: "gallery-root-pointer",
      title: "Root",
      siteSlug: "alpha",
      author: "Alpha",
      mediaPath: "element/2026/08/root-pointer.jpg",
      mediaType: "image" as const,
      fetchedAt: ORIGINAL,
    };
    const first = await new AtlasStore(cache, { now: () => ORIGINAL }).commitLegacyGallery(row);
    const artifact = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT id FROM atlas_artifacts WHERE capture_id = ?")
          .get(first.captureId) as { id: string },
    );
    cache.withAtlasDb((db) => {
      db.prepare(
        `UPDATE atlas_claims SET evidence_json = ?
         WHERE region_id IN (SELECT id FROM atlas_regions WHERE capture_id = ?)`,
      ).run(
        JSON.stringify([{ artifactId: artifact.id, pointer: "", sampleKey: "root" }]),
        first.captureId,
      );
    });
    const reused = await new AtlasStore(cache, {
      now: () => ORIGINAL + 1000,
    }).commitLegacyGallery({ ...row, fetchedAt: ORIGINAL + 1000 });
    expect(reused.published).toBe(true);
  });

  it("rebuilds candidate labels when upgrading a v6/FTS1 cache", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    const row: ElementRecord = {
      ...galleryRow,
      slug: "gallery-fts1-labels",
      mediaPath: "element/2026/08/fts1-labels.jpg",
    };
    cache.upsertElements([row]);
    await importLegacyAtlas(cache, { now: () => IMPORT });
    const region = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            `SELECT r.id FROM atlas_regions r
             WHERE r.kind = 'component' AND json_extract(r.samples_json, '$.gallerySlug') = ?`,
          )
          .get(row.slug) as { id: string },
    );
    cache.withAtlasDb((db) => {
      db.prepare(
        "UPDATE atlas_regions_fts SET labels = 'source.title Candidate' WHERE region_id = ?",
      ).run(region.id);
      db.prepare(
        "UPDATE atlas_state SET schema_version = 6, fts_version = 1, revision = 1 WHERE singleton = 1",
      ).run();
    });

    const reopened = new Cache(cache.rootDir, () => ORIGINAL, { atlas: true });
    const state = reopened.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT fts_version, revision FROM atlas_state WHERE singleton = 1")
          .get() as { fts_version: number; revision: number },
    );
    expect(state).toEqual({ fts_version: 2, revision: 2 });
    expect(
      reopened.withAtlasDb(
        (db) =>
          (db
            .prepare("SELECT labels FROM atlas_regions_fts WHERE region_id = ?")
            .get(region.id) as { labels: string }).labels,
      ),
    ).toBe("");
  });

  it("rejects malformed nonempty elements metadata instead of publishing empty", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    cache.setMeta("detail:alpha", detail);
    cache.setMeta("elements:alpha", elements);
    await importLegacyAtlas(cache, { now: () => IMPORT });
    const snapshot = () =>
      cache.withAtlasDb((db) => ({
        head: (db.prepare("SELECT capture_id FROM atlas_heads").get() as { capture_id: string })
          .capture_id,
        revision: (
          db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }
        ).revision,
        fts: db
          .prepare(
            "SELECT region_id, title, heading, copy, labels, context FROM atlas_regions_fts ORDER BY region_id",
          )
          .all(),
        aliases: db
          .prepare("SELECT alias_kind, alias, region_id FROM atlas_aliases ORDER BY alias")
          .all(),
      }));
    const before = snapshot();

    cache.setMeta("elements:alpha", [{ title: "Broken" }]);
    const report = await importLegacyAtlas(cache, { now: () => IMPORT + 1000 });
    expect(report).toMatchObject({ processed: 1, published: 0, unpublished: 1 });
    expect(report.limitations).toContain("LEGACY_ELEMENTS_MALFORMED");
    expect(snapshot()).toEqual(before);
  });

  it("orders highlight publication by elements time, not detail time", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    cache.setMeta("detail:alpha", detail);
    cache.setMeta("elements:alpha", elements);
    cache.withDbForTest((db) => {
      db.prepare("UPDATE meta SET fetchedAt = ? WHERE key = 'elements:alpha'").run(
        IMPORT + 2000,
      );
      db.prepare("UPDATE meta SET fetchedAt = ? WHERE key = 'detail:alpha'").run(
        IMPORT + 3000,
      );
    });
    await importLegacyAtlas(cache, { now: () => IMPORT + 3000 });
    const snapshot = () =>
      cache.withAtlasDb((db) => ({
        head: (db.prepare("SELECT capture_id FROM atlas_heads").get() as { capture_id: string })
          .capture_id,
        revision: (
          db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }
        ).revision,
        fts: db
          .prepare(
            "SELECT region_id, title, heading, copy, labels, context FROM atlas_regions_fts ORDER BY region_id",
          )
          .all(),
        aliases: db
          .prepare("SELECT alias_kind, alias, region_id FROM atlas_aliases ORDER BY alias")
          .all(),
      }));
    const before = snapshot();

    cache.setMeta("elements:alpha", [
      { title: "Stale", mediaPath: "element/2026/08/stale.jpg" },
    ]);
    cache.withDbForTest((db) => {
      db.prepare("UPDATE meta SET fetchedAt = ? WHERE key = 'elements:alpha'").run(
        IMPORT + 1000,
      );
      db.prepare("UPDATE meta SET fetchedAt = ? WHERE key = 'detail:alpha'").run(
        IMPORT + 3000,
      );
    });
    const report = await importLegacyAtlas(cache, { now: () => IMPORT + 3000 });
    expect(report).toMatchObject({ published: 0, unpublished: 1 });
    expect(snapshot()).toEqual(before);
  });

  it("rejects non-array and invalid JSON elements metadata without fallback", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    cache.setMeta("detail:alpha", detail);
    cache.setMeta("elements:alpha", elements);
    cache.upsertElements([
      {
        ...galleryRow,
        slug: "site-fallback-alpha",
        title: "Fallback",
        source: "site",
        siteSlug: "alpha",
        mediaPath: "element/2026/08/fallback.jpg",
      },
    ]);
    await importLegacyAtlas(cache, { now: () => IMPORT });
    const snapshot = () =>
      cache.withAtlasDb((db) => ({
        head: (db.prepare("SELECT capture_id FROM atlas_heads").get() as { capture_id: string })
          .capture_id,
        revision: (
          db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }
        ).revision,
        fts: db
          .prepare(
            "SELECT region_id, title, heading, copy, labels, context FROM atlas_regions_fts ORDER BY region_id",
          )
          .all(),
        aliases: db
          .prepare("SELECT alias_kind, alias, region_id FROM atlas_aliases ORDER BY alias")
          .all(),
      }));
    const before = snapshot();

    cache.setMeta("elements:alpha", { bad: "shape" });
    const nonArray = await importLegacyAtlas(cache, { now: () => IMPORT + 1000 });
    expect(nonArray).toMatchObject({ published: 0, unpublished: 1 });
    expect(nonArray.limitations).toContain("LEGACY_ELEMENTS_MALFORMED");
    expect(snapshot()).toEqual(before);

    cache.withDbForTest((db) => {
      db.prepare("UPDATE meta SET value = '{not-json', fetchedAt = ? WHERE key = 'elements:alpha'").run(
        IMPORT + 2000,
      );
    });
    const invalidJson = await importLegacyAtlas(cache, { now: () => IMPORT + 2000 });
    expect(invalidJson).toMatchObject({ published: 0, unpublished: 1 });
    expect(invalidJson.limitations).toContain("LEGACY_ELEMENTS_MALFORMED");
    expect(snapshot()).toEqual(before);
  });

  it("never borrows a site-row time for elements metadata with timestamp 0", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    cache.setMeta("detail:alpha", detail);
    cache.setMeta("elements:alpha", elements);
    cache.withDbForTest((db) => {
      db.prepare("UPDATE meta SET fetchedAt = ? WHERE key = 'elements:alpha'").run(
        IMPORT + 2000,
      );
      db.prepare("UPDATE meta SET fetchedAt = ? WHERE key = 'detail:alpha'").run(
        IMPORT + 3000,
      );
    });
    await importLegacyAtlas(cache, { now: () => IMPORT + 3000 });
    const snapshot = () =>
      cache.withAtlasDb((db) => ({
        head: (db.prepare("SELECT capture_id FROM atlas_heads").get() as { capture_id: string })
          .capture_id,
        revision: (
          db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }
        ).revision,
        fts: db
          .prepare(
            "SELECT region_id, title, heading, copy, labels, context FROM atlas_regions_fts ORDER BY region_id",
          )
          .all(),
        aliases: db
          .prepare("SELECT alias_kind, alias, region_id FROM atlas_aliases ORDER BY alias")
          .all(),
      }));
    const before = snapshot();

    cache.setMeta("elements:alpha", [
      { title: "Unknown time", mediaPath: "element/2026/08/unknown-time.jpg" },
    ]);
    cache.withDbForTest((db) => {
      db.prepare("UPDATE meta SET fetchedAt = 0 WHERE key = 'elements:alpha'").run();
      db.prepare("UPDATE meta SET fetchedAt = ? WHERE key = 'detail:alpha'").run(
        IMPORT + 3000,
      );
    });
    cache.upsertElements([
      {
        ...galleryRow,
        slug: "site-unrelated-alpha",
        title: "Unrelated",
        source: "site",
        siteSlug: "alpha",
        mediaPath: "element/2026/08/unrelated.jpg",
        fetchedAt: IMPORT + 3000,
      },
    ]);

    const report = await importLegacyAtlas(cache, { now: () => IMPORT + 3000 });
    expect(report).toMatchObject({ published: 0, unpublished: 1 });
    expect(report.limitations).toContain("MISSING_TIMESTAMP");
    expect(snapshot()).toEqual(before);
    expect(
      cache.withAtlasDb(
        (db) =>
          (
            db
              .prepare("SELECT COUNT(*) AS n FROM atlas_captures WHERE source_fetched_at IS NULL")
              .get() as { n: number }
          ).n,
      ),
    ).toBe(1);
  });

  it("normalizes mixed timestamp units before choosing the newest fallback row", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    cache.setMeta("detail:alpha", detail);
    cache.setMeta("elements:alpha", elements);
    cache.withDbForTest((db) => {
      db.prepare("UPDATE meta SET fetchedAt = ? WHERE key = 'elements:alpha'").run(
        IMPORT + 2000,
      );
      db.prepare("UPDATE meta SET fetchedAt = ? WHERE key = 'detail:alpha'").run(
        IMPORT + 3000,
      );
    });
    await importLegacyAtlas(cache, { now: () => IMPORT + 3000 });
    const headBefore = cache.withAtlasDb(
      (db) =>
        (db.prepare("SELECT capture_id FROM atlas_heads").get() as { capture_id: string })
          .capture_id,
    );
    cache.withDbForTest((db) => {
      db.prepare("DELETE FROM meta WHERE key = 'elements:alpha'").run();
      db.prepare("DELETE FROM elements WHERE source = 'site' AND siteSlug = 'alpha'").run();
    });
    cache.upsertElements([
      {
        ...galleryRow,
        slug: "site-old-ms",
        title: "Old milliseconds",
        source: "site",
        siteSlug: "alpha",
        mediaPath: "element/2026/08/old-ms.jpg",
        fetchedAt: IMPORT + 1000,
      },
      {
        ...galleryRow,
        slug: "site-new-seconds",
        title: "New seconds",
        source: "site",
        siteSlug: "alpha",
        mediaPath: "element/2026/08/new-seconds.jpg",
        fetchedAt: (IMPORT + 3000) / 1000,
      },
    ]);

    const report = await importLegacyAtlas(cache, { now: () => IMPORT + 3000 });
    expect(report).toMatchObject({ published: 1, unpublished: 0 });
    const headAfter = cache.withAtlasDb(
      (db) =>
        (db.prepare("SELECT capture_id FROM atlas_heads").get() as { capture_id: string })
          .capture_id,
    );
    expect(headAfter).not.toBe(headBefore);
    expect(
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
      ),
    ).toBe(3);
  });

  it("selects the newest duplicate-media row before deriving highlights", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    cache.setMeta("detail:alpha", detail);
    cache.upsertElements([
      {
        ...galleryRow,
        slug: "a-old",
        title: "Old",
        source: "site",
        siteSlug: "alpha",
        mediaPath: "element/2026/08/duplicate.jpg",
        fetchedAt: IMPORT + 1000,
      },
      {
        ...galleryRow,
        slug: "z-new",
        title: "New",
        source: "site",
        siteSlug: "alpha",
        mediaPath: "element/2026/08/duplicate.jpg",
        fetchedAt: (IMPORT + 3000) / 1000,
      },
    ]);
    await importLegacyAtlas(cache, { now: () => IMPORT });
    const snapshot = () =>
      cache.withAtlasDb((db) => ({
        head: (db.prepare("SELECT capture_id FROM atlas_heads").get() as { capture_id: string })
          .capture_id,
        revision: (
          db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }
        ).revision,
        captures: (db.prepare("SELECT COUNT(*) AS n FROM atlas_captures").get() as { n: number })
          .n,
        fts: db
          .prepare(
            "SELECT region_id, title, heading, copy, labels, context FROM atlas_regions_fts ORDER BY region_id",
          )
          .all(),
        aliases: db
          .prepare("SELECT alias_kind, alias, region_id FROM atlas_aliases ORDER BY alias")
          .all(),
      }));
    const first = snapshot();
    const highlight = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT id, raw_title FROM atlas_regions WHERE kind = 'highlight' AND capture_id = ?",
          )
          .get(first.head) as { id: string; raw_title: string },
    );
    expect(highlight.raw_title).toBe("New");
    const aliases = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT alias, region_id FROM atlas_aliases WHERE alias IN ('a-old', 'z-new') ORDER BY alias",
          )
          .all() as Array<{ alias: string; region_id: string }>,
    );
    expect(aliases).toEqual([
      { alias: "a-old", region_id: highlight.id },
      { alias: "z-new", region_id: highlight.id },
    ]);
    expect(
      cache.withAtlasDb((db) =>
        db
          .prepare(
            `SELECT slug, title, fetchedAt FROM elements
             WHERE siteSlug = 'alpha' AND mediaPath = 'element/2026/08/duplicate.jpg'
             ORDER BY slug`,
          )
          .all(),
      ),
    ).toEqual([
      { slug: "a-old", title: "Old", fetchedAt: IMPORT + 1000 },
      { slug: "z-new", title: "New", fetchedAt: (IMPORT + 3000) / 1000 },
    ]);

    await importLegacyAtlas(cache, { now: () => IMPORT + 4000 });
    expect(snapshot()).toEqual(first);
  });

  it("keeps a 301-character fallback title stable across repeated import", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    cache.setMeta("detail:alpha", detail);
    const longTitle = "L".repeat(301);
    cache.upsertElements([
      {
        ...galleryRow,
        slug: "site-long-title",
        title: longTitle,
        source: "site",
        siteSlug: "alpha",
        mediaPath: "element/2026/08/long-title.jpg",
        fetchedAt: IMPORT + 1000,
      },
    ]);
    const report = await importLegacyAtlas(cache, { now: () => IMPORT });
    expect(report).toMatchObject({ published: 1, failures: [] });
    const snapshot = () =>
      cache.withAtlasDb((db) => ({
        captures: (db.prepare("SELECT COUNT(*) AS n FROM atlas_captures").get() as { n: number })
          .n,
        head: (db.prepare("SELECT capture_id FROM atlas_heads").get() as { capture_id: string })
          .capture_id,
        revision: (
          db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
            revision: number;
          }
        ).revision,
      }));
    const first = snapshot();
    expect(
      cache.withAtlasDb(
        (db) => (db.prepare("SELECT title FROM elements WHERE slug = 'site-long-title'").get() as {
          title: string;
        }).title,
      ),
    ).toBe(longTitle);
    expect(
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT raw_title FROM atlas_regions WHERE kind = 'highlight'").get() as {
            raw_title: string;
          }).raw_title.length,
      ),
    ).toBe(300);

    await importLegacyAtlas(cache, { now: () => IMPORT + 1000 });
    expect(snapshot()).toEqual(first);
    expect(
      cache.withAtlasDb(
        (db) => (db.prepare("SELECT title FROM elements WHERE slug = 'site-long-title'").get() as {
          title: string;
        }).title,
      ),
    ).toBe(longTitle);
  });

  it("rebuilds aliases when a site slug moves to another media", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    cache.setMeta("detail:alpha", detail);
    cache.setMeta("elements:alpha", elements);
    const moving = {
      ...galleryRow,
      slug: "moving-slug",
      title: "Moving",
      source: "site" as const,
      siteSlug: "alpha",
      mediaPath: "element/2026/08/a.jpg",
    };
    const other = {
      ...galleryRow,
      slug: "other-slug",
      title: "Other",
      source: "site" as const,
      siteSlug: "alpha",
      mediaPath: "element/2026/08/b.mp4",
    };
    cache.upsertElements([moving, other]);
    await importLegacyAtlas(cache, { now: () => IMPORT });
    cache.upsertElements([{ ...moving, mediaPath: "element/2026/08/b.mp4" }]);
    await importLegacyAtlas(cache, { now: () => IMPORT + 1000 });

    const aliases = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            `SELECT alias, region_id FROM atlas_aliases
             WHERE alias_kind = 'legacy_element_slug' AND alias = 'moving-slug'`,
          )
          .all() as Array<{ alias: string; region_id: string }>,
    );
    expect(aliases).toHaveLength(1);
    const region = cache.withAtlasDb(
      (db) =>
        db.prepare("SELECT samples_json FROM atlas_regions WHERE id = ?").get(
          aliases[0]!.region_id,
        ) as { samples_json: string },
    );
    expect(JSON.parse(region.samples_json).mediaPath).toBe("element/2026/08/b.mp4");
    expect(resolveAlias(cache, "legacy_element_slug", "moving-slug")).toMatchObject({
      status: "resolved",
    });
  });

  it("imports populated legacy detail with long element text", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => ORIGINAL, { atlas: true });
    const long = "D".repeat(301);
    cache.setMeta("detail:alpha", { ...detail, elements: [long] });
    cache.setMeta("elements:alpha", elements);
    const report = await importLegacyAtlas(cache, { now: () => IMPORT });
    expect(report).toMatchObject({ published: 1, failures: [] });
    const artifact = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            `SELECT a.storage_path FROM atlas_artifacts a
             JOIN atlas_captures c ON c.id = a.capture_id
             JOIN atlas_pages p ON p.id = c.page_id
             WHERE p.kind = 'awwwards_item'`,
          )
          .get() as { storage_path: string },
    );
    const body = JSON.parse(readFileSync(join(root, artifact.storage_path), "utf8"));
    expect(body.detail.elements).toEqual([long]);
  });

  it("removes alias targets when a legacy slug changes owner", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    cache.setMeta("detail:alpha", detail);
    cache.setMeta("elements:alpha", elements);
    cache.upsertElements([
      {
        ...galleryRow,
        slug: "moving-owner",
        title: "Moving owner",
        source: "site",
        siteSlug: "alpha",
        mediaPath: "element/2026/08/a.jpg",
      },
    ]);
    await importLegacyAtlas(cache, { now: () => IMPORT });
    cache.setMeta("detail:beta", { ...detail, slug: "beta", title: "Beta" });
    cache.setMeta("elements:beta", elements);
    cache.withDbForTest((db) => {
      db.prepare("DELETE FROM meta WHERE key = 'elements:alpha'").run();
      db.prepare("UPDATE elements SET siteSlug = 'beta' WHERE slug = 'moving-owner'").run();
    });
    await importLegacyAtlas(cache, { now: () => IMPORT + 1000 });

    const aliases = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT alias_kind, alias, region_id FROM atlas_aliases WHERE alias = 'moving-owner' ORDER BY alias_kind, alias, region_id",
          )
          .all() as Array<{ alias_kind: string; alias: string; region_id: string }>,
    );
    expect(aliases).toHaveLength(1);
    expect(resolveAlias(cache, "legacy_element_slug", "moving-owner")).toMatchObject({
      status: "resolved",
    });
  });

  it("imports a long fallback author from populated detail", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    const long = "A".repeat(301);
    cache.setMeta("detail:alpha", { ...detail, title: long });
    cache.setMeta("elements:alpha", elements);
    const report = await importLegacyAtlas(cache, { now: () => IMPORT });
    expect(report).toMatchObject({ published: 1, failures: [] });
    const rows = cache.listElements(100).filter((row) => row.source === "site");
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.author === long)).toBe(true);
  });

  it("imports a 501-character legacy detail title", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => ORIGINAL, { atlas: true });
    const long = "T".repeat(501);
    cache.setMeta("detail:alpha", { ...detail, title: long });
    cache.setMeta("elements:alpha", elements);
    const report = await importLegacyAtlas(cache, { now: () => IMPORT });
    expect(report).toMatchObject({ published: 1, failures: [] });
    const artifact = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            `SELECT a.storage_path FROM atlas_artifacts a
             JOIN atlas_captures c ON c.id = a.capture_id
             JOIN atlas_pages p ON p.id = c.page_id
             WHERE p.kind = 'awwwards_item'`,
          )
          .get() as { storage_path: string },
    );
    const body = JSON.parse(readFileSync(join(root, artifact.storage_path), "utf8"));
    expect(body.detail.title).toBe(long);
  });

  it("keeps ownerless gallery items out of the unattributed project", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    cache.setMeta("detail:unattributed", {
      ...detail,
      slug: "unattributed",
      title: "Unattributed",
    });
    cache.setMeta("elements:unattributed", [elements[0]!]);
    await importLegacyAtlas(cache, { now: () => IMPORT });
    await new AtlasStore(cache, { now: () => IMPORT + 1000 }).commitLegacyGallery({
      slug: "gallery-ownerless",
      title: "Ownerless",
      siteSlug: null,
      author: "Unknown",
      mediaPath: elements[0]!.mediaPath,
      mediaType: "image",
      fetchedAt: IMPORT + 1000,
    });
    const resolution = resolveAlias(cache, "legacy_gallery_slug", "gallery-ownerless");
    expect(resolution).toMatchObject({ status: "resolved" });
    if (resolution.status === "resolved") {
      const region = cache.withAtlasDb(
        (db) =>
          db.prepare("SELECT kind, capture_id FROM atlas_regions WHERE id = ?").get(
            resolution.regionId,
          ) as { kind: string; capture_id: string },
      );
      expect(region.kind).toBe("component");
      expect(
        cache.withAtlasDb(
          (db) =>
            (db.prepare("SELECT source_kind FROM atlas_captures WHERE id = ?").get(
              region.capture_id,
            ) as { source_kind: string }).source_kind,
        ),
      ).toBe("legacy_gallery");
    }
  });

  it("keeps unknown gallery ownership distinct from explicit ownership", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    const base = {
      slug: "gallery-unknown-to-owned",
      title: "Ownership",
      author: "Alpha",
      mediaPath: "element/2026/08/ownership-change.jpg",
      mediaType: "image" as const,
      fetchedAt: ORIGINAL,
    };
    const ownerless = await new AtlasStore(cache, { now: () => ORIGINAL }).commitLegacyGallery({
      ...base,
      siteSlug: null,
    });
    const owned = await new AtlasStore(cache, { now: () => ORIGINAL }).commitLegacyGallery({
      ...base,
      siteSlug: "unknown-owner",
    });
    expect(owned.captureId).not.toBe(ownerless.captureId);
    const pages = cache.withAtlasDb((db) =>
      db
        .prepare(
          "SELECT site_slug FROM atlas_pages WHERE kind = 'legacy_gallery' ORDER BY site_slug",
        )
        .all() as Array<{ site_slug: string }>,
    );
    expect(pages.map((page) => page.site_slug)).toEqual([":unattributed", "unknown-owner"]);
    expect(
      cache.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_captures").get() as { n: number }).n,
      ),
    ).toBe(2);
  });

  it("imports long legacy description, technology, and live URL values", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => ORIGINAL, { atlas: true });
    const description = "D".repeat(20_001);
    const technology = "T".repeat(201);
    const liveUrl = `https://example.com/${"u".repeat(2050)}`;
    cache.setMeta("detail:alpha", {
      ...detail,
      description,
      technologies: [technology],
      liveUrl,
    });
    cache.setMeta("elements:alpha", elements);
    const report = await importLegacyAtlas(cache, { now: () => IMPORT });
    expect(report).toMatchObject({ published: 1, failures: [] });
    const artifact = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            `SELECT a.storage_path FROM atlas_artifacts a
             JOIN atlas_captures c ON c.id = a.capture_id
             JOIN atlas_pages p ON p.id = c.page_id
             WHERE p.kind = 'awwwards_item'`,
          )
          .get() as { storage_path: string },
    );
    const body = JSON.parse(readFileSync(join(root, artifact.storage_path), "utf8"));
    expect(body.detail.description).toBe(description);
    expect(body.detail.technologies).toEqual([technology]);
    expect(body.detail.liveUrl).toBe(liveUrl);
  });

  it("marks gallery rows with unknown timestamps as incomplete", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    cache.upsertElements([
      {
        ...galleryRow,
        slug: "gallery-no-time",
        siteSlug: null,
        mediaPath: "element/2026/08/no-time.jpg",
        fetchedAt: 0,
      },
    ]);
    const report = await importLegacyAtlas(cache, { now: () => IMPORT });
    expect(report.limitations).toContain("MISSING_TIMESTAMP");
    const capture = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT source_fetched_at, coverage_json FROM atlas_captures WHERE source_kind = 'legacy_gallery'",
          )
          .get() as { source_fetched_at: number | null; coverage_json: string },
    );
    expect(capture.source_fetched_at).toBeNull();
    expect(JSON.parse(capture.coverage_json).limitations).toContain("MISSING_TIMESTAMP");
  });

  it("uses the elements observation time for highlights when detail is older", async () => {
    const DETAIL_TIME = Date.UTC(2026, 8, 1, 12);
    const ELEMENTS_TIME = Date.UTC(2026, 8, 25, 12);
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    cache.setMeta("detail:alpha", detail);
    cache.setMeta("elements:alpha", elements);
    cache.withReadDb((db) => {
      db.prepare("UPDATE meta SET fetchedAt = ? WHERE key = 'detail:alpha'").run(DETAIL_TIME);
      db.prepare("UPDATE meta SET fetchedAt = ? WHERE key = 'elements:alpha'").run(ELEMENTS_TIME);
    });

    const report = await importLegacyAtlas(cache, { now: () => IMPORT });
    expect(report).toMatchObject({ processed: 1, published: 1, failures: [] });

    const capture = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT source_fetched_at, config_json FROM atlas_captures WHERE source_kind = 'awwwards_item'",
          )
          .get() as { source_fetched_at: number | null; config_json: string },
    );
    expect(capture.source_fetched_at).toBe(ELEMENTS_TIME);
    expect(JSON.parse(capture.config_json).evidenceTimes).toEqual({
      detail: DETAIL_TIME,
      elements: ELEMENTS_TIME,
    });

    const rows = cache.listElements(100).filter((row) => row.source === "site");
    expect(rows).toHaveLength(elements.length);
    expect(rows.every((row) => row.fetchedAt === ELEMENTS_TIME)).toBe(true);

    const artifact = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            `SELECT a.storage_path FROM atlas_artifacts a
             JOIN atlas_captures c ON c.id = a.capture_id
             WHERE c.source_kind = 'awwwards_item'`,
          )
          .get() as { storage_path: string },
    );
    const body = JSON.parse(readFileSync(join(cache.rootDir, artifact.storage_path), "utf8"));
    expect(body).not.toHaveProperty("evidenceTimes");
  });

  it("is resumable and idempotent", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    cache.setMeta("detail:alpha", detail);
    cache.setMeta("elements:alpha", elements);
    cache.upsertElements([galleryRow]);
    await importLegacyAtlas(cache, { now: () => IMPORT });
    const before = atlasCounts(cache);
    const aliasRows = () =>
      cache.withAtlasDb((db) =>
        db
          .prepare(
            "SELECT alias_kind, alias, region_id FROM atlas_aliases ORDER BY alias_kind, alias, region_id",
          )
          .all(),
      );
    const aliasesBefore = aliasRows();
    const second = await importLegacyAtlas(cache, { now: () => IMPORT + 60_000 });
    expect(second).toMatchObject({ processed: 2, published: 2, failures: [] });
    expect(atlasCounts(cache)).toEqual(before);
    expect(aliasRows()).toEqual(aliasesBefore);
  });

  it("marks missing timestamps and missing elements records as incomplete", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    cache.setMeta("detail:beta", { ...detail, slug: "beta", title: "Beta" });
    cache.withDbForTest((db) =>
      db.prepare("UPDATE meta SET fetchedAt = 0 WHERE key = 'detail:beta'").run(),
    );

    const report = await importLegacyAtlas(cache, { now: () => IMPORT });
    expect(report).toMatchObject({ processed: 1, published: 0, unpublished: 1 });
    expect(report.limitations).toEqual(
      expect.arrayContaining(["LEGACY_ELEMENTS_MISSING", "MISSING_TIMESTAMP"]),
    );

    const capture = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT status, source_fetched_at, coverage_json FROM atlas_captures")
          .get() as { status: string; source_fetched_at: number | null; coverage_json: string },
    );
    expect(capture.status).toBe("unknown");
    expect(capture.source_fetched_at).toBeNull();
    expect(JSON.parse(capture.coverage_json).limitations).toEqual(
      expect.arrayContaining(["LEGACY_ELEMENTS_MISSING", "MISSING_TIMESTAMP", "LEGACY_METADATA_ONLY"]),
    );
    expect(atlasCounts(cache).heads).toBe(0);
  });

  it("imports site elements rows that have no meta records", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    const row: ElementRecord = {
      slug: "site-gamma-existing",
      title: "Gamma hero",
      cid: "uncategorized",
      category: "uncategorized",
      author: "Gamma Studio",
      builtWith: [],
      related: [],
      mediaPath: "element/2026/08/gamma.jpg",
      mediaType: "image",
      source: "site",
      projectId: null,
      siteSlug: "gamma",
      fetchedAt: ORIGINAL,
    };
    cache.upsertElements([row]);

    const report = await importLegacyAtlas(cache, { now: () => IMPORT });
    expect(report).toMatchObject({ processed: 1, published: 1, failures: [] });
    expect(report.limitations).toEqual(
      expect.arrayContaining(["LEGACY_METADATA_ONLY", "LEGACY_DETAIL_MISSING"]),
    );

    const capture = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT source_fetched_at FROM atlas_captures")
          .get() as { source_fetched_at: number | null },
    );
    expect(capture.source_fetched_at).toBe(ORIGINAL);
    const kept = cache.listElements(100).find((item) => item.siteSlug === "gamma")!;
    expect(kept.slug).toBe(row.slug);
    expect(resolveAlias(cache, "legacy_element_slug", row.slug)).toMatchObject({
      status: "resolved",
      alias: row.slug,
    });
  });

  it("never downgrades an existing live head to a metadata-only import", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: true });
    const live = await cache.commitSitePage(prepare(fixture));
    expect(live.published).toBe(true);

    const report = await importLegacyAtlas(cache, { now: () => IMPORT });
    expect(report).toMatchObject({ processed: 1, published: 0, unpublished: 1 });

    const head = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT capture_id FROM atlas_heads WHERE page_id = ?")
          .get(live.pageId) as { capture_id: string },
    );
    expect(head.capture_id).toBe(live.captureId);
    expect(atlasCounts(cache).captures).toBe(2);
  });

  it("does nothing when Atlas is disabled", async () => {
    const cache = new Cache(tmpDir(), () => ORIGINAL, { atlas: false });
    cache.setMeta("detail:alpha", detail);
    cache.setMeta("elements:alpha", elements);
    const report = await importLegacyAtlas(cache);
    expect(report).toMatchObject({ enabled: false, processed: 0, skipped: 1 });
    expect(
      cache.withReadDb(
        (db) =>
          db.prepare("SELECT name FROM sqlite_master WHERE name = 'atlas_state'").get(),
      ),
    ).toBeUndefined();
  });
});
