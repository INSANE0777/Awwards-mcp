import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Cache } from "../src/cache.js";
import { prepareSitePage } from "../src/atlas/ingest.js";
import { sha256Text } from "../src/atlas/identity.js";
import { AtlasStore } from "../src/atlas/store.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-ingest-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;
const fixture = readFileSync(join("test", "fixtures", "detail.html"), "utf8");
const driftHtml = "<html><body><h2>Elements</h2><p>no collectable blobs</p></body></html>";

const blob = (image: string, title: string) =>
  `data-collectable-model-value="{&quot;collectableImage&quot;:&quot;${image}&quot;,&quot;collectableTitle&quot;:&quot;${title}&quot;}"`;

const elementsPage = (...items: string[]) =>
  `<html><head><meta property="og:title" content="Fixture"></head><body>` +
  `<h2 class="text-default">Elements</h2>${items
    .map((item) => `<div ${item}></div>`)
    .join("")}<h2>Color Palette</h2></body></html>`;

const prepare = (html: string, slug = "fixture-site", fetchedAt = NOW) =>
  prepareSitePage({
    slug,
    html,
    fetchedAt,
    sourceUrl: `https://www.awwwards.com/sites/${slug}`,
    summary: null,
  });

const emptyDetailHtml =
  '<html><head><meta property="og:title" content="Empty"></head><body><h2>Color Palette</h2></body></html>';

const ftsCount = (cache: Cache) =>
  cache.withAtlasDb(
    (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
  );

const revision = (cache: Cache) =>
  cache.withAtlasDb(
    (db) =>
      (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
        revision: number;
      }).revision,
  );

const counts = (cache: Cache) =>
  cache.withAtlasDb((db) => ({
    pages: (db.prepare("SELECT COUNT(*) AS n FROM atlas_pages").get() as { n: number }).n,
    captures: (db.prepare("SELECT COUNT(*) AS n FROM atlas_captures").get() as { n: number }).n,
    regions: (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions").get() as { n: number }).n,
    claims: (db.prepare("SELECT COUNT(*) AS n FROM atlas_claims").get() as { n: number }).n,
    heads: (db.prepare("SELECT COUNT(*) AS n FROM atlas_heads").get() as { n: number }).n,
    artifacts: (db.prepare("SELECT COUNT(*) AS n FROM atlas_artifacts").get() as { n: number }).n,
  }));

describe("atlas item-page ingestion", () => {
  it("normalizes highlights by media identity, not title", () => {
    const prepared = prepare(fixture);
    expect(prepared.detailValid).toBe(true);
    expect(prepared.highlightParse.status).toBe("parsed");
    expect(prepared.highlights.length).toBeGreaterThan(0);
    expect(new Set(prepared.highlights.map((item) => item.identity)).size).toBe(
      prepared.highlights.length,
    );
    expect(prepared.legacyElements).toHaveLength(prepared.highlights.length);
    expect(
      prepared.legacyElements.every(
        (element) =>
          element.siteSlug === "fixture-site" &&
          /^site-fixture-site-[a-f0-9]{64}$/.test(element.fallbackSlug),
      ),
    ).toBe(true);
  });

  it("keeps duplicate titles with different media as distinct highlights", () => {
    const prepared = prepare(
      elementsPage(
        blob("element/2024/01/first.jpg", "Same title"),
        blob("element/2024/01/second.jpg", "Same title"),
      ),
      "duplicate-title",
    );
    expect(prepared.highlightParse.status).toBe("parsed");
    expect(prepared.highlights.map((item) => item.title)).toEqual(["Same title", "Same title"]);
    expect(new Set(prepared.highlights.map((item) => item.identity)).size).toBe(2);
  });

  it("represents an absent Elements section as absent, not drift", () => {
    const prepared = prepare(
      `<html><head><meta property="og:title" content="No elements"></head><body></body></html>`,
      "absent-site",
    );
    expect(prepared.highlightParse).toEqual({ status: "absent", items: [] });
    expect(prepared.highlights).toEqual([]);
  });

  it("commits page, capture, root region, highlights, claims, artifact, head and FTS in one transaction", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => NOW, { atlas: true });
    const prepared = prepare(fixture);
    const result = await new AtlasStore(cache).commitSitePage(prepared);
    expect(result.published).toBe(true);
    expect(result.highlightCount).toBe(prepared.highlights.length);

    expect(counts(cache)).toEqual({
      pages: 1,
      captures: 1,
      regions: 1 + prepared.highlights.length,
      claims: prepared.highlights.length,
      heads: 1,
      artifacts: 1,
    });

    const artifact = cache.withAtlasDb((db) =>
      db.prepare("SELECT storage_path, sha256, bytes FROM atlas_artifacts").get(),
    ) as { storage_path: string; sha256: string; bytes: number };
    expect(existsSync(join(root, artifact.storage_path))).toBe(true);
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.bytes).toBeGreaterThan(0);

    const fts = cache.withAtlasDb((db) =>
      db
        .prepare("SELECT region_id FROM atlas_regions_fts ORDER BY region_id")
        .all() as Array<{ region_id: string }>,
    );
    const ftsVersion = cache.withAtlasDb(
      (db) =>
        (db.prepare("SELECT fts_version FROM atlas_state").get() as { fts_version: number })
          .fts_version,
    );
    if (ftsVersion === 2) expect(fts).toHaveLength(1 + prepared.highlights.length);
  });

  it("publishes a legitimate empty observation as the source head", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const prepared = prepare(
      `<html><head><meta property="og:title" content="No elements"></head><body></body></html>`,
      "absent-site",
    );
    const result = await new AtlasStore(cache).commitSitePage(prepared);
    expect(result.published).toBe(true);
    const head = cache.withAtlasDb((db) =>
      db.prepare("SELECT capture_id FROM atlas_heads").get(),
    ) as { capture_id: string };
    expect(head.capture_id).toBe(result.captureId);
    expect(counts(cache).regions).toBe(1);
  });

  it("is idempotent for the same source digest", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const prepared = prepare(fixture);
    const store = new AtlasStore(cache);
    await store.commitSitePage(prepared);
    const before = {
      revision: cache.withAtlasDb(
        (db) => (db.prepare("SELECT revision FROM atlas_state").get() as { revision: number }).revision,
      ),
      ...counts(cache),
    };
    await store.commitSitePage(prepared);
    const after = {
      revision: cache.withAtlasDb(
        (db) => (db.prepare("SELECT revision FROM atlas_state").get() as { revision: number }).revision,
      ),
      ...counts(cache),
    };
    expect(after).toEqual(before);
  });

  it("deduplicates identical HTML fetched at different times", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const store = new AtlasStore(cache);
    const first = await store.commitSitePage(prepare(fixture, "fixture-site", NOW));
    const second = await store.commitSitePage(
      prepare(fixture, "fixture-site", NOW + 60_000),
    );
    expect(second.captureId).toBe(first.captureId);
    expect(counts(cache).captures).toBe(1);
    expect(revision(cache)).toBe(1);
    expect(ftsCount(cache)).toBe(1 + first.highlightCount);
  });

  it("drops the outgoing head's FTS rows when an empty publication replaces it", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const store = new AtlasStore(cache);
    const full = await store.commitSitePage(prepare(fixture, "empty-site", NOW));
    expect(ftsCount(cache)).toBe(1 + full.highlightCount);

    const empty = await store.commitSitePage(
      prepare(emptyDetailHtml, "empty-site", NOW + 1000),
    );
    expect(empty.published).toBe(true);
    expect(ftsCount(cache)).toBe(1);
    const stale = cache.withAtlasDb(
      (db) =>
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM atlas_regions_fts f
               JOIN atlas_regions r ON r.id = f.region_id
               WHERE r.capture_id = ?`,
            )
            .get(full.captureId) as { n: number }
        ).n,
    );
    expect(stale).toBe(0);
  });

  it("treats drift as a veto even when a caller tries to override publication", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const prepared = { ...prepare(driftHtml, "drift-override"), publishable: true };
    const result = await new AtlasStore(cache).commitSitePage(prepared);
    expect(result.published).toBe(false);
    expect(counts(cache).heads).toBe(0);
    const capture = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT status, coverage_json FROM atlas_captures WHERE id = ?")
          .get(result.captureId) as { status: string; coverage_json: string },
    );
    expect(capture.status).toBe("unknown");
    expect(JSON.parse(capture.coverage_json).limitations).toContain("PARSER_DRIFT");
  });

  it("does not publish a maintenance-only page with no detail or highlights", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const prepared = prepare(
      "<html><body><p>Down for maintenance</p></body></html>",
      "maintenance-site",
    );
    expect(prepared.detailValid).toBe(false);
    expect(prepared.highlights).toEqual([]);
    const result = await new AtlasStore(cache).commitSitePage(prepared);
    expect(result.published).toBe(false);
    expect(counts(cache).heads).toBe(0);
    const capture = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT status, coverage_json FROM atlas_captures WHERE id = ?")
          .get(result.captureId) as { status: string; coverage_json: string },
    );
    expect(capture.status).toBe("unknown");
    expect(JSON.parse(capture.coverage_json).limitations).toContain("MAINTENANCE_PAGE");
  });

  it("does not replace a newer head with an older observation", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const store = new AtlasStore(cache);
    const newer = await store.commitSitePage(
      prepare(fixture, "stale-site", NOW + 10_000),
    );
    const revisionBefore = revision(cache);

    const older = await store.commitSitePage(
      prepare(`${fixture}\n<!-- older observation -->`, "stale-site", NOW),
    );
    expect(older.published).toBe(false);
    const head = cache.withAtlasDb(
      (db) => db.prepare("SELECT capture_id FROM atlas_heads").get() as { capture_id: string },
    );
    expect(head.capture_id).toBe(newer.captureId);
    expect(revision(cache)).toBe(revisionBefore);
  });

  it("rejects invalid prepared pages at commit entry", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: false });
    const valid = prepare(fixture);
    await expect(cache.commitSitePage({ ...valid, slug: "bad slug" })).rejects.toThrow(
      /invalid Atlas prepared page/,
    );
    await expect(cache.commitSitePage({ ...valid, fetchedAt: -1 })).rejects.toThrow(
      /invalid Atlas prepared page/,
    );
    await expect(
      cache.commitSitePage({ ...valid, sourceUrl: "ftp://example.test/page" }),
    ).rejects.toThrow(/invalid Atlas prepared page/);
    await expect(
      cache.commitSitePage({ ...valid, sourceUrl: "file:///tmp/page.html" }),
    ).rejects.toThrow(/invalid Atlas prepared page/);
  });

  it("re-publishes an existing capture when A→B→A is the newest observation", async () => {
    const now = { value: NOW };
    const cache = new Cache(tmpDir(), () => now.value, { atlas: true });
    const store = new AtlasStore(cache, { now: () => now.value });
    const a1 = await store.commitSitePage(prepare(fixture, "aba-site", NOW));
    now.value = NOW + 1000;
    const b = await store.commitSitePage(
      prepare(`${fixture}\n<!-- B -->`, "aba-site", NOW + 1000),
    );
    now.value = NOW + 2000;
    const a2 = await store.commitSitePage(prepare(fixture, "aba-site", NOW + 2000));

    expect(a2.captureId).toBe(a1.captureId);
    expect(a2.published).toBe(true);
    expect(b.published).toBe(true);
    expect(counts(cache).captures).toBe(2);
    expect(revision(cache)).toBe(3);
    const head = cache.withAtlasDb(
      (db) => db.prepare("SELECT capture_id FROM atlas_heads").get() as { capture_id: string },
    );
    expect(head.capture_id).toBe(a1.captureId);
    const staleFts = cache.withAtlasDb(
      (db) =>
        (db
          .prepare(
            `SELECT COUNT(*) AS n FROM atlas_regions_fts f
             JOIN atlas_regions r ON r.id = f.region_id
             WHERE r.capture_id = ?`,
          )
          .get(b.captureId) as { n: number }).n,
    );
    expect(staleFts).toBe(0);
    expect(ftsCount(cache)).toBe(1 + a1.highlightCount);
    expect(counts(cache).artifacts).toBe(2);
  });

  it("refreshes legacy metadata TTLs on an identical refetch without a new capture or artifact", async () => {
    const now = { value: NOW };
    const cache = new Cache(tmpDir(), () => now.value, { atlas: true });
    const store = new AtlasStore(cache, { now: () => now.value });
    const first = await store.commitSitePage(prepare(fixture, "ttl-site", NOW));
    now.value = NOW + 60_000;
    const second = await store.commitSitePage(prepare(fixture, "ttl-site", NOW + 60_000));

    expect(second.captureId).toBe(first.captureId);
    expect(second.published).toBe(true);
    expect(counts(cache).captures).toBe(1);
    expect(revision(cache)).toBe(1);
    expect(counts(cache).artifacts).toBe(1);
    expect(
      cache.withReadDb(
        (db) =>
          (db.prepare("SELECT fetchedAt FROM meta WHERE key = 'detail:ttl-site'").get() as {
            fetchedAt: number;
          }).fetchedAt,
      ),
    ).toBe(NOW + 60_000);
    expect(
      cache.withReadDb(
        (db) =>
          (db.prepare("SELECT fetchedAt FROM meta WHERE key = 'elements:ttl-site'").get() as {
            fetchedAt: number;
          }).fetchedAt,
      ),
    ).toBe(NOW + 60_000);
    const rows = cache.listElements(100).filter((row) => row.siteSlug === "ttl-site");
    expect(rows.every((row) => row.fetchedAt === NOW + 60_000)).toBe(true);
  });

  it("does not refresh legacy rows from an older stale observation", async () => {
    const now = { value: NOW + 10_000 };
    const cache = new Cache(tmpDir(), () => now.value, { atlas: true });
    const store = new AtlasStore(cache, { now: () => now.value });
    const newer = await store.commitSitePage(prepare(fixture, "stale-projection", now.value));
    const before = {
      head: cache.withAtlasDb((db) => db.prepare("SELECT capture_id FROM atlas_heads").get()),
      meta: cache.withReadDb(
        (db) => db.prepare("SELECT fetchedAt FROM meta WHERE key = 'elements:stale-projection'").get(),
      ),
      elements: cache
        .listElements(100)
        .filter((row) => row.siteSlug === "stale-projection")
        .map((row) => row.fetchedAt),
    };

    const stale = await store.commitSitePage(
      prepare(`${fixture}\n<!-- stale -->`, "stale-projection", NOW),
    );
    expect(stale.published).toBe(false);
    expect(
      cache.withAtlasDb((db) => db.prepare("SELECT capture_id FROM atlas_heads").get()),
    ).toEqual(before.head);
    expect(
      cache.withReadDb(
        (db) => db.prepare("SELECT fetchedAt FROM meta WHERE key = 'elements:stale-projection'").get(),
      ),
    ).toEqual(before.meta);
    expect(
      cache
        .listElements(100)
        .filter((row) => row.siteSlug === "stale-projection")
        .map((row) => row.fetchedAt),
    ).toEqual(before.elements);
    expect(counts(cache).artifacts).toBe(2);
    expect(newer.published).toBe(true);
  });

  it("revalidates a stale capture when a fresh identical refetch makes it valid", async () => {
    const now = { value: NOW + 1000 };
    const cache = new Cache(tmpDir(), () => now.value, { atlas: true });
    const store = new AtlasStore(cache, { now: () => now.value });
    const newer = await store.commitSitePage(prepare(fixture, "revive-site", now.value));
    now.value = NOW;
    const stale = await store.commitSitePage(
      prepare(`${fixture}\n<!-- stale first -->`, "revive-site", NOW),
    );
    expect(stale.published).toBe(false);
    const staleRow = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT status, source_fetched_at, last_confirmed_at, finished_at FROM atlas_captures WHERE id = ?")
          .get(stale.captureId) as {
          status: string;
          source_fetched_at: number | null;
          last_confirmed_at: number | null;
          finished_at: number | null;
        },
    );
    expect(staleRow).toEqual({
      status: "unknown",
      source_fetched_at: NOW,
      last_confirmed_at: NOW,
      finished_at: NOW,
    });

    now.value = NOW + 2000;
    const revived = await store.commitSitePage(
      prepare(`${fixture}\n<!-- stale first -->`, "revive-site", NOW + 2000),
    );
    expect(revived.captureId).toBe(stale.captureId);
    expect(revived.published).toBe(true);
    const head = cache.withAtlasDb(
      (db) => db.prepare("SELECT capture_id FROM atlas_heads").get() as { capture_id: string },
    );
    expect(head.capture_id).toBe(stale.captureId);
    expect(head.capture_id).not.toBe(newer.captureId);
    const capture = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT status, source_fetched_at, last_confirmed_at, finished_at, coverage_json FROM atlas_captures WHERE id = ?",
          )
          .get(stale.captureId) as {
          status: string;
          source_fetched_at: number | null;
          last_confirmed_at: number | null;
          finished_at: number | null;
          coverage_json: string;
        },
    );
    expect(capture.status).toBe("complete");
    // Original evidence time and finish time are immutable; freshness uses
    // last_confirmed_at.
    expect(capture.source_fetched_at).toBe(NOW);
    expect(capture.finished_at).toBe(NOW);
    expect(capture.last_confirmed_at).toBe(NOW + 2000);
    expect(JSON.parse(capture.coverage_json).limitations).not.toContain(
      "STALE_OR_PROTECTED_OBSERVATION",
    );
  });

  it("coordinates concurrent identical refetches into one artifact row and one file", async () => {
    const root = tmpDir();
    const cacheA = new Cache(root, () => NOW, { atlas: true });
    const cacheB = new Cache(root, () => NOW + 1000, { atlas: true });
    const preparedA = prepare(fixture, "concurrent-site", NOW);
    const preparedB = {
      ...prepare(fixture, "concurrent-site", NOW + 1000),
      summary: { title: "Different caller summary", liveUrl: null },
    };
    const [a, b] = await Promise.all([
      new AtlasStore(cacheA, { now: () => NOW }).commitSitePage(preparedA),
      new AtlasStore(cacheB, { now: () => NOW + 1000 }).commitSitePage(preparedB),
    ]);
    expect(a.captureId).toBe(b.captureId);
    expect([a.artifactWritten, b.artifactWritten].filter(Boolean)).toHaveLength(1);
    expect(counts(cacheA).captures).toBe(1);
    expect(counts(cacheA).artifacts).toBe(1);
    const files = readdirSync(join(root, "atlas", "artifacts"));
    expect(files.filter((file) => file.endsWith(".json"))).toHaveLength(1);
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
  });

  it("removes a newly written artifact when the transaction rolls back", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => NOW, { atlas: true });
    cache.withAtlasDb((db) => {
      db.exec(
        "CREATE TRIGGER fail_claim BEFORE INSERT ON atlas_claims BEGIN SELECT RAISE(ABORT, 'injected'); END",
      );
    });
    await expect(
      new AtlasStore(cache).commitSitePage(prepare(fixture, "failed-site", NOW)),
    ).rejects.toThrow(/injected/);

    expect(counts(cache)).toMatchObject({ captures: 0, artifacts: 0, heads: 0 });
    expect(readdirSync(join(root, "atlas", "artifacts"))).toEqual([]);

    cache.withAtlasDb((db) => db.exec("DROP TRIGGER fail_claim"));
    const retry = await new AtlasStore(cache).commitSitePage(
      prepare(fixture, "failed-site", NOW),
    );
    expect(retry.published).toBe(true);
    expect(counts(cache).artifacts).toBe(1);
  });

  it("ingests when FTS is unavailable", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true, fts: false });
    const result = await new AtlasStore(cache, { now: () => NOW }).commitSitePage(
      prepare(fixture, "no-fts"),
    );
    expect(result.published).toBe(true);
    expect(counts(cache)).toMatchObject({ captures: 1, heads: 1, artifacts: 1 });
    expect(
      cache.withAtlasDb(
        (db) =>
          db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'atlas_regions_fts'")
            .get(),
      ),
    ).toBeUndefined();
  });

  it("bumps revision when identical confirmation changes freshness eligibility", async () => {
    const now = { value: NOW };
    const cache = new Cache(tmpDir(), () => now.value, { atlas: true });
    const store = new AtlasStore(cache, { now: () => now.value });
    const prepared = prepare(fixture, "eligibility-site", NOW);
    await store.commitSitePage({ ...prepared, sourceFetchedAt: null });
    expect(revision(cache)).toBe(1);
    now.value = NOW + 1000;
    const confirmed = await store.commitSitePage({
      ...prepared,
      fetchedAt: NOW + 1000,
      sourceFetchedAt: NOW + 1000,
    });
    expect(confirmed.published).toBe(true);
    expect(revision(cache)).toBe(2);
    const capture = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT source_fetched_at, last_confirmed_at FROM atlas_captures")
          .get() as { source_fetched_at: number | null; last_confirmed_at: number | null },
    );
    expect(capture).toEqual({ source_fetched_at: null, last_confirmed_at: NOW + 1000 });
  });

  it("bumps revision when an old confirmation becomes fresh", async () => {
    const now = { value: NOW };
    const cache = new Cache(tmpDir(), () => now.value, { atlas: true });
    const store = new AtlasStore(cache, { now: () => now.value });
    const prepared = prepare(fixture, "age-old-site", NOW);
    const month = 31 * 24 * 60 * 60 * 1000;
    await store.commitSitePage({ ...prepared, sourceFetchedAt: NOW - month });
    expect(revision(cache)).toBe(1);
    const refreshed = await store.commitSitePage({
      ...prepared,
      fetchedAt: NOW,
      sourceFetchedAt: NOW,
    });
    expect(refreshed.published).toBe(true);
    expect(revision(cache)).toBe(2);
  });

  it("bumps revision when a fresh confirmation ages out", async () => {
    const now = { value: NOW };
    const cache = new Cache(tmpDir(), () => now.value, { atlas: true });
    const store = new AtlasStore(cache, { now: () => now.value });
    const prepared = prepare(fixture, "age-fresh-site", NOW);
    await store.commitSitePage(prepared);
    expect(revision(cache)).toBe(1);
    now.value = NOW + 31 * 24 * 60 * 60 * 1000;
    const stale = await store.commitSitePage({
      ...prepared,
      fetchedAt: NOW,
      sourceFetchedAt: NOW,
    });
    expect(stale.published).toBe(true);
    expect(revision(cache)).toBe(2);
  });

  it("bumps revision when an aged-out site head is refreshed", async () => {
    const now = { value: NOW };
    const cache = new Cache(tmpDir(), () => now.value, { atlas: true });
    const store = new AtlasStore(cache, { now: () => now.value });
    const prepared = prepare(fixture, "age-refresh-site", NOW);
    await store.commitSitePage(prepared);
    expect(revision(cache)).toBe(1);
    now.value = NOW + 31 * 24 * 60 * 60 * 1000;
    await store.commitSitePage({
      ...prepared,
      fetchedAt: now.value,
      sourceFetchedAt: now.value,
    });
    expect(revision(cache)).toBe(2);
  });

  it("removes FTS, aliases, and revision when an invalid head is dropped", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const prepared = prepare(fixture, "invalid-head", NOW);
    const mediaPath = prepared.highlights[0]!.mediaPath;
    cache.upsertElements([
      {
        slug: "site-invalid-head",
        title: "Invalid head",
        cid: "uncategorized",
        category: "uncategorized",
        author: "Alpha",
        builtWith: [],
        related: [],
        mediaPath,
        mediaType: "image",
        source: "site",
        projectId: null,
        siteSlug: "invalid-head",
        fetchedAt: NOW,
      },
    ]);
    await new AtlasStore(cache, { now: () => NOW }).commitSitePage(prepared);
    expect(counts(cache).heads).toBe(1);
    expect(ftsCount(cache)).toBe(1 + prepared.highlights.length);
    expect(
      cache.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_aliases").get() as { n: number }).n,
      ),
    ).toBe(prepared.highlights.length);

    const invalid = await new AtlasStore(cache, { now: () => NOW }).commitSitePage({
      ...prepared,
      publishable: false,
    });
    expect(invalid.published).toBe(false);
    expect(counts(cache).heads).toBe(0);
    expect(ftsCount(cache)).toBe(0);
    expect(
      cache.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_aliases").get() as { n: number }).n,
      ),
    ).toBe(0);
    expect(revision(cache)).toBe(2);
  });

  it("removes a newly written artifact when BEGIN IMMEDIATE fails", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => NOW, { atlas: true });
    cache.withAtlasDb((db) => db.prepare("SELECT 1 FROM atlas_state").get());
    const raw = new DatabaseSync(join(root, "cache.db"));
    raw.exec("BEGIN IMMEDIATE");
    try {
      await expect(
        new AtlasStore(cache).commitSitePage(prepare(fixture, "begin-failure", NOW)),
      ).rejects.toThrow(/locked|busy/i);
    } finally {
      raw.exec("ROLLBACK");
      raw.close();
    }
    expect(
      existsSync(join(root, "atlas", "artifacts"))
        ? readdirSync(join(root, "atlas", "artifacts"))
        : [],
    ).toEqual([]);
  }, 20_000);

  it("rejects publishing a reused capture with a missing artifact", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => NOW, { atlas: true });
    const store = new AtlasStore(cache, { now: () => NOW });
    const prepared = prepare(fixture, "artifact-missing-site", NOW);
    const first = await store.commitSitePage(prepared);
    const artifact = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT storage_path FROM atlas_artifacts WHERE capture_id = ?")
          .get(first.captureId) as { storage_path: string },
    );
    rmSync(join(root, artifact.storage_path), { force: true });

    const reused = await store.commitSitePage({
      ...prepared,
      fetchedAt: NOW + 1000,
      sourceFetchedAt: NOW + 1000,
    });
    expect(reused.published).toBe(false);
    expect(counts(cache)).toMatchObject({ captures: 1, heads: 0, artifacts: 1 });
    expect(ftsCount(cache)).toBe(0);
    expect(
      cache.withAtlasDb((db) =>
        db
          .prepare("SELECT alias_kind, alias, region_id FROM atlas_aliases ORDER BY alias_kind, alias, region_id")
          .all(),
      ),
    ).toEqual([]);
    expect(revision(cache)).toBe(2);
  });

  it("rejects publishing a reused capture with a corrupt artifact", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => NOW, { atlas: true });
    const store = new AtlasStore(cache, { now: () => NOW });
    const prepared = prepare(fixture, "artifact-corrupt-site", NOW);
    const first = await store.commitSitePage(prepared);
    const artifact = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT storage_path FROM atlas_artifacts WHERE capture_id = ?")
          .get(first.captureId) as { storage_path: string },
    );
    writeFileSync(join(root, artifact.storage_path), "corrupt");

    const reused = await store.commitSitePage({
      ...prepared,
      fetchedAt: NOW + 1000,
      sourceFetchedAt: NOW + 1000,
    });
    expect(reused.published).toBe(false);
    expect(counts(cache)).toMatchObject({ captures: 1, heads: 0, artifacts: 1 });
    expect(ftsCount(cache)).toBe(0);
    expect(revision(cache)).toBe(2);
  });

  it("preserves a healthy B head when an older A artifact is invalid", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => NOW, { atlas: true });
    const store = new AtlasStore(cache, { now: () => NOW });
    const a = prepare(fixture, "artifact-aba", NOW);
    const aResult = await store.commitSitePage(a);
    const b = prepare(fixture.replace("</body>", "<!-- b --></body>"), "artifact-aba", NOW + 1000);
    const bResult = await store.commitSitePage(b);
    expect(bResult.published).toBe(true);
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
          .prepare(
            "SELECT alias_kind, alias, region_id FROM atlas_aliases ORDER BY alias_kind, alias, region_id",
          )
          .all(),
      }));
    const before = snapshot();
    const artifact = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT storage_path FROM atlas_artifacts WHERE capture_id = ?")
          .get(aResult.captureId) as { storage_path: string },
    );
    rmSync(join(root, artifact.storage_path), { force: true });

    const again = await store.commitSitePage({
      ...a,
      fetchedAt: NOW + 2000,
      sourceFetchedAt: NOW + 2000,
    });
    expect(again.published).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  it("rejects invalid evidence pointers without changing the healthy projection", async () => {
    const root = tmpDir();
    const cache = new Cache(root, () => NOW, { atlas: true });
    const store = new AtlasStore(cache, { now: () => NOW });
    const a = prepare(fixture, "evidence-site", NOW);
    const aResult = await store.commitSitePage(a);
    const bResult = await store.commitSitePage(
      prepare(fixture.replace("</body>", "<!-- b --></body>"), "evidence-site", NOW + 1000),
    );
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
        aliases: db
          .prepare(
            "SELECT alias_kind, alias, region_id FROM atlas_aliases ORDER BY alias_kind, alias, region_id",
          )
          .all(),
        elements: db
          .prepare("SELECT slug, title, fetchedAt FROM elements ORDER BY slug")
          .all(),
      }));
    const before = snapshot();

    const invalid = [
      "[]",
      JSON.stringify([{ artifactId: artifact.id, pointer: "/~2bad", sampleKey: "x" }]),
      JSON.stringify([
        { artifactId: artifact.id, pointer: "/highlights/999/title", sampleKey: "x" },
      ]),
      JSON.stringify([{ artifactId: artifact.id, pointer: "/highlights/0/title", sampleKey: "" }]),
      JSON.stringify([
        { artifactId: artifact.id, pointer: `/${"a".repeat(1000)}`, sampleKey: "x" },
      ]),
      JSON.stringify([
        {
          artifactId: artifact.id,
          pointer: "/highlights/0/title",
          sampleKey: "x".repeat(101),
        },
      ]),
      JSON.stringify([
        {
          artifactId: artifact.id,
          pointer: "/highlights/0/title",
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
      const reused = await store.commitSitePage({
        ...a,
        fetchedAt: NOW + 2000,
        sourceFetchedAt: NOW + 2000,
      });
      expect(reused.published).toBe(false);
      expect(snapshot()).toEqual(before);
    }
  });

  it("bumps revision when an identical site refetch repairs FTS documents", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const store = new AtlasStore(cache, { now: () => NOW });
    const prepared = prepare(fixture, "fts-repair-site", NOW);
    const first = await store.commitSitePage(prepared);
    expect(revision(cache)).toBe(1);
    cache.withAtlasDb((db) => {
      db.prepare(
        `DELETE FROM atlas_regions_fts WHERE region_id = (
           SELECT id FROM atlas_regions WHERE capture_id = ? AND kind = 'highlight' LIMIT 1
         )`,
      ).run(first.captureId);
    });
    expect(ftsCount(cache)).toBe(prepared.highlights.length);

    const repaired = await store.commitSitePage(prepared);
    expect(repaired.published).toBe(true);
    expect(ftsCount(cache)).toBe(1 + prepared.highlights.length);
    expect(revision(cache)).toBe(2);

    await store.commitSitePage(prepared);
    expect(revision(cache)).toBe(2);
  });

  it("accepts the RFC root pointer for site evidence", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const store = new AtlasStore(cache, { now: () => NOW });
    const prepared = prepare(fixture, "evidence-root-site", NOW);
    const first = await store.commitSitePage(prepared);
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
    const reused = await store.commitSitePage(prepared);
    expect(reused.published).toBe(true);
  });

  it("preserves long legacy detail elements with Atlas on and off", async () => {
    const long = "D".repeat(301);
    const prepared = prepare(fixture, "long-detail-site", NOW);
    const page = {
      ...prepared,
      detail: { ...prepared.detail, elements: [long] },
    };
    const on = new Cache(tmpDir(), () => NOW, { atlas: true });
    await on.commitSitePage(page);
    const onMeta = on.withReadDb(
      (db) =>
        (db.prepare("SELECT value FROM meta WHERE key = 'detail:long-detail-site'").get() as {
          value: string;
        }).value,
    );
    expect(JSON.parse(onMeta).elements).toEqual([long]);

    const off = new Cache(tmpDir(), () => NOW);
    await off.commitSitePage(page);
    const offMeta = off.withReadDb(
      (db) =>
        (db.prepare("SELECT value FROM meta WHERE key = 'detail:long-detail-site'").get() as {
          value: string;
        }).value,
    );
    expect(JSON.parse(offMeta).elements).toEqual([long]);
  });

  it("preserves a long legacy author with Atlas on and off", async () => {
    const long = "A".repeat(301);
    const base = prepare(fixture, "long-author-site");
    const prepared = {
      ...base,
      detail: { ...base.detail, title: long },
      legacyElements: base.legacyElements.map((element) => ({ ...element, author: long })),
    };
    expect(prepared.legacyElements[0]!.author).toBe(long);

    for (const atlas of [true, false]) {
      const cache = new Cache(tmpDir(), () => NOW, { atlas });
      await cache.commitSitePage(prepared);
      const row = cache
        .listElements(100)
        .find((item) => item.slug === prepared.legacyElements[0]!.fallbackSlug)!;
      expect(row.author).toBe(long);
    }
  });

  it("keeps long legacy element titles searchable through refreshes", async () => {
    const longTitle = `${"x".repeat(300)} zeppelin`;
    const prepared = prepare(
      elementsPage(blob("element/2026/08/long-title.jpg", longTitle)),
      "long-element-site",
    );
    expect(prepared.highlights[0]!.title).toHaveLength(300);
    expect(prepared.legacyElements[0]!.title).toBe(longTitle);

    for (const atlas of [true, false]) {
      const cache = new Cache(tmpDir(), () => NOW, { atlas });
      await cache.commitSitePage(prepared);
      expect(cache.listElements(100)[0]!.title).toBe(longTitle);
      expect(cache.searchElements("zeppelin", 10)).toHaveLength(1);
      await cache.commitSitePage(prepared);
      const results = cache.searchElements("zeppelin", 10);
      expect(results).toHaveLength(1);
      expect(results[0]!.title).toBe(longTitle);
    }
  });

  it("preserves a 501-character legacy detail and summary title", async () => {
    const long = "T".repeat(501);
    const base = prepare(fixture, "long-detail-title");
    const page = {
      ...base,
      detail: { ...base.detail, title: long },
      summary: { title: long, liveUrl: null },
    };
    for (const atlas of [true, false]) {
      const cache = new Cache(tmpDir(), () => NOW, { atlas });
      await cache.commitSitePage(page);
      const value = cache.withReadDb(
        (db) =>
          (db.prepare("SELECT value FROM meta WHERE key = 'detail:long-detail-title'").get() as {
            value: string;
          }).value,
      );
      expect(JSON.parse(value).title).toBe(long);
    }
  });

  it("preserves long legacy description, technology, and live URL values", async () => {
    const base = prepare(fixture, "long-legacy-values");
    const description = "D".repeat(20_001);
    const technology = "T".repeat(201);
    const liveUrl = `https://example.com/${"u".repeat(2050)}`;
    const page = {
      ...base,
      detail: {
        ...base.detail,
        description,
        technologies: [technology],
        liveUrl,
      },
      summary: { title: base.summary.title, liveUrl },
    };
    expect(liveUrl).toHaveLength(2070);
    for (const atlas of [true, false]) {
      const cache = new Cache(tmpDir(), () => NOW, { atlas });
      await cache.commitSitePage(page);
      const value = cache.withReadDb(
        (db) =>
          (db.prepare("SELECT value FROM meta WHERE key = 'detail:long-legacy-values'").get() as {
            value: string;
          }).value,
      );
      const stored = JSON.parse(value);
      expect(stored.description).toBe(description);
      expect(stored.technologies).toEqual([technology]);
      expect(stored.liveUrl).toBe(liveUrl);
    }
  });

  it("does not publish a drift parse", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const prepared = prepare(driftHtml, "drift-site");
    expect(prepared.highlightParse.status).toBe("drift");
    const result = await new AtlasStore(cache).commitSitePage(prepared);
    expect(result.published).toBe(false);
    expect(counts(cache).heads).toBe(0);

    const capture = cache.withAtlasDb((db) =>
      db.prepare("SELECT status, coverage_json FROM atlas_captures WHERE id = ?").get(result.captureId),
    ) as { status: string; coverage_json: string };
    expect(capture.status).toBe("unknown");
    expect(JSON.parse(capture.coverage_json).limitations).toContain("PARSER_DRIFT");
  });

  it("keeps the previous valid head when a later parse drifts", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const store = new AtlasStore(cache);
    const valid = await store.commitSitePage(prepare(fixture));
    const headBefore = cache.withAtlasDb((db) => ({
      head: db.prepare("SELECT capture_id, published_at FROM atlas_heads").get(),
      revision: (db.prepare("SELECT revision FROM atlas_state").get() as { revision: number }).revision,
    }));
    expect(headBefore.head).toMatchObject({ capture_id: valid.captureId });

    const drift = await store.commitSitePage(prepare(driftHtml));
    expect(drift.published).toBe(false);

    const headAfter = cache.withAtlasDb((db) => ({
      head: db.prepare("SELECT capture_id, published_at FROM atlas_heads").get(),
      revision: (db.prepare("SELECT revision FROM atlas_state").get() as { revision: number }).revision,
    }));
    expect(headAfter).toEqual(headBefore);
  });

  it("updates the legacy projection even when Atlas is disabled", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: false });
    const prepared = prepare(fixture);
    const result = await cache.commitSitePage(prepared);
    expect(result).toEqual({
      pageId: "",
      captureId: "",
      highlightCount: prepared.highlights.length,
      highlightParse: "parsed",
      published: false,
    });
    const tables = cache.withReadDb((db) =>
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'atlas_%'")
        .all(),
    );
    expect(tables).toEqual([]);
    expect(cache.getMeta("detail:fixture-site", Number.POSITIVE_INFINITY)).toEqual(
      prepared.detail,
    );
    expect(
      cache
        .listElements(100)
        .filter((row) => row.source === "site")
        .map((row) => row.mediaPath)
        .sort(),
    ).toEqual(prepared.highlights.map((item) => item.mediaPath).sort());
  });

  it("reuses an existing site slug for the same media and preserves gallery rows", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const prepared = prepare(fixture);
    const first = prepared.highlights[0]!;
    const oldSlug = "site-fixture-site-virtual-assistant";
    const gallery = {
      slug: "gallery-fixture-hero",
      title: first.title,
      cid: "uncategorized",
      category: "uncategorized",
      author: "Fixture",
      builtWith: [],
      related: [],
      mediaPath: first.mediaPath,
      mediaType: "image" as const,
      source: "gallery" as const,
      projectId: null,
      siteSlug: "fixture-site",
      fetchedAt: NOW - 1000,
    };
    cache.upsertElements([
      {
        ...gallery,
        slug: oldSlug,
        source: "site",
        title: "Old title",
      },
      gallery,
    ]);

    await cache.commitSitePage(prepared);

    const rows = cache.listElements(100);
    const siteRow = rows.find(
      (row) => row.source === "site" && row.mediaPath === first.mediaPath,
    )!;
    expect(siteRow.slug).toBe(oldSlug);
    expect(siteRow.title).toBe(first.title);
    expect(siteRow.builtWith).toEqual([]);
    expect(siteRow.cid).toBe("uncategorized");
    expect(rows.find((row) => row.slug === gallery.slug)).toEqual(gallery);
  });

  it("keeps same-title media as distinct rows and never overwrites by title", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const prepared = prepare(
      elementsPage(
        blob("element/2026/08/same-a.jpg", "Same title"),
        blob("element/2026/08/same-b.mp4", "Same title"),
      ),
      "duplicate-title",
    );
    await cache.commitSitePage(prepared);

    const rows = cache
      .listElements(100)
      .filter((row) => row.siteSlug === "duplicate-title");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.slug)).size).toBe(2);
    expect(rows.map((row) => row.title)).toEqual(["Same title", "Same title"]);
    expect(rows.map((row) => row.mediaType).sort()).toEqual(["image", "video"]);
  });

  it("rolls the whole commit back when a claim write fails", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    cache.withAtlasDb((db) =>
      db.exec(
        "CREATE TRIGGER fail_claim BEFORE INSERT ON atlas_claims BEGIN SELECT RAISE(ABORT, 'claim rejected'); END",
      ),
    );
    await expect(new AtlasStore(cache).commitSitePage(prepare(fixture))).rejects.toThrow(
      /claim rejected/,
    );
    expect(counts(cache)).toEqual({
      pages: 0,
      captures: 0,
      regions: 0,
      claims: 0,
      heads: 0,
      artifacts: 0,
    });
  });
});
