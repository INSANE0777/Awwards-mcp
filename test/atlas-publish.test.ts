import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import { writeArtifactBytesSync, writeJsonArtifactSync } from "../src/atlas/artifacts.js";
import { classifySections } from "../src/atlas/classification.js";
import { publishCapture } from "../src/atlas/publish.js";
import { atlasSearchStore, searchAtlas } from "../src/atlas/search.js";
import { regionStableKey, segmentRegions } from "../src/atlas/segmentation.js";
import type {
  AtlasCaptureAttempt,
  AtlasStoredArtifact,
  ComponentCandidate,
} from "../src/atlas/live-types.js";
import { loadPhase2Fixture } from "./helpers/phase2-fixture.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-publish-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 10, 5, 12);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const PNG_ALT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const target = {
  siteSlug: "fixture-live",
  requestedUrl: "https://fixture.example/",
  urlKey: "https://fixture.example/",
  path: "/",
};

let attemptSequence = 0;

function attemptFor(
  cache: Cache,
  mode: "valid" | "no-claims" | "missing-artifact",
  overrides: { scanTitle?: string; screenshot?: Buffer } = {},
): AtlasCaptureAttempt {
  const { scan: baseScan } = loadPhase2Fixture();
  const scan = overrides.scanTitle
    ? { ...baseScan, title: overrides.scanTitle }
    : baseScan;
  const regions = segmentRegions(scan);
  const scanArtifact = writeJsonArtifactSync(cache.rootDir, {
    schemaVersion: "awwwards-atlas-live-scan-v1",
    viewport: "desktop",
    scan,
  });
  const scanStored: AtlasStoredArtifact = {
    key: "scan-desktop",
    kind: "raw_observation",
    storagePath:
      mode === "missing-artifact" ? "atlas/artifacts/missing.json" : scanArtifact.storagePath,
    sha256: scanArtifact.sha256,
    bytes: scanArtifact.bytes,
    mimeType: "application/json",
    regionKey: null,
  };
  const screenshot = writeArtifactBytesSync(
    cache.rootDir,
    overrides.screenshot ?? PNG,
    ".png",
  );
  const screenshotStored: AtlasStoredArtifact = {
    key: "screenshot-desktop-0",
    kind: "screenshot",
    storagePath: screenshot.storagePath,
    sha256: screenshot.sha256,
    bytes: screenshot.bytes,
    mimeType: "image/png",
    regionKey: null,
  };
  const claims =
    mode === "no-claims"
      ? []
      : classifySections(
          regions.map((candidate) => ({
            viewport: "desktop" as const,
            candidate,
            scan,
            artifactKey: "scan-desktop",
          })),
        );
  const attempt: AtlasCaptureAttempt = {
    cache,
    target,
    attemptId: `attempt-fixture-${++attemptSequence}`,
    startedAt: NOW,
    finishedAt: NOW + 1000,
    status: "complete",
    coverage: { status: "complete", collected: regions.length, excluded: 0, limitations: [] },
    limitations: [],
    artifacts: [scanStored, screenshotStored],
    viewports: [
      {
        viewport: "desktop",
        profileKey: "live-desktop",
        status: "complete",
        coverage: { status: "complete", collected: regions.length, excluded: 0, limitations: [] },
        limitations: [],
        finalUrl: target.requestedUrl,
        browserVersion: "fixture",
        dpr: 1,
        reducedMotion: "no-preference",
        scrollRoot: null,
        overlayState: "none",
        loadingFailures: [],
        scan,
        regions,
        claims,
        screenshots: [screenshotStored],
        artifacts: [scanStored, screenshotStored],
      },
    ],
  };
  return attempt;
}

describe("Atlas live publication", () => {
  it("publishes a capture, sections, claims, artifacts, head and FTS atomically", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const result = await publishCapture(attemptFor(cache, "valid"));
    expect(result.code).toBeUndefined();
    expect(result.published).toBe(true);
    expect(result.captureIds).toHaveLength(1);
    expect(result.regionCount).toBeGreaterThan(10);
    expect(result.claimCount).toBeGreaterThan(10);
    const counts = cache.withAtlasDb((db) => ({
      pages: (db.prepare("SELECT COUNT(*) AS n FROM atlas_pages").get() as { n: number }).n,
      captures: (db.prepare("SELECT COUNT(*) AS n FROM atlas_captures").get() as { n: number }).n,
      heads: (db.prepare("SELECT COUNT(*) AS n FROM atlas_heads").get() as { n: number }).n,
      claims: (db.prepare("SELECT COUNT(*) AS n FROM atlas_claims").get() as { n: number }).n,
      artifacts: (db.prepare("SELECT COUNT(*) AS n FROM atlas_artifacts").get() as { n: number }).n,
      fts: (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
    }));
    expect(counts).toMatchObject({ pages: 1, captures: 1, heads: 1 });
    expect(counts.claims).toBeGreaterThan(0);
    expect(counts.artifacts).toBe(2);
    expect(counts.fts).toBeGreaterThan(1);
    const claim = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT evidence_json FROM atlas_claims WHERE decision IN ('accepted','candidate') LIMIT 1")
          .get() as { evidence_json: string },
    );
    const refs = JSON.parse(claim.evidence_json) as Array<{ artifactId: string; pointer: string }>;
    expect(refs[0]!.pointer).toMatch(/^\/scan\/sections\/\d+$/);
    const artifact = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT storage_path FROM atlas_artifacts WHERE id = ?")
          .get(refs[0]!.artifactId) as { storage_path: string },
    );
    expect(artifact.storage_path.replaceAll("\\", "/")).toContain("atlas/artifacts/");
    expect(
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT primary_label FROM atlas_regions WHERE kind = 'section' LIMIT 1").get() as {
            primary_label: string | null;
          }).primary_label,
      ),
    ).toBeNull();
    const region = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            `SELECT r.locator_json FROM atlas_regions r
             JOIN atlas_claims c ON c.region_id = r.id
             WHERE c.evidence_json = ? LIMIT 1`,
          )
          .get(claim.evidence_json) as { locator_json: string },
    );
    const scanBody = JSON.parse(
      readFileSync(join(cache.rootDir, artifact.storage_path), "utf8"),
    ) as { scan: { sections: Array<{ selector: string }> } };
    const index = Number(refs[0]!.pointer.split("/").pop());
    expect(scanBody.scan.sections[index]!.selector).toBe(
      (JSON.parse(region.locator_json) as { selector: string }).selector,
    );
  });

  it("refuses publication without accepted claims", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const result = await publishCapture(attemptFor(cache, "no-claims"));
    expect(result).toMatchObject({ published: false, code: "NO_CLAIMS" });
  });

  it("publishes only the eligible profile and keeps its coverage viewport-local", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const attempt = attemptFor(cache, "valid");
    const desktop = attempt.viewports[0]!;
    const mobileScan = {
      ...desktop.scan,
      totalHeight: 900,
      sections: [{ ...desktop.scan.sections[0]!, heading: null, headingLevel: null }],
    };
    const stored = writeJsonArtifactSync(cache.rootDir, {
      schemaVersion: "awwwards-atlas-live-scan-v1",
      viewport: "mobile",
      scan: mobileScan,
    });
    const scanArtifact = desktop.artifacts.find((artifact) => artifact.kind === "raw_observation")!;
    const mobileArtifact: AtlasStoredArtifact = {
      ...scanArtifact,
      key: "scan-mobile",
      storagePath: stored.storagePath,
      sha256: stored.sha256,
      bytes: stored.bytes,
    };
    attempt.viewports.push({
      ...desktop,
      viewport: "mobile",
      profileKey: "live-mobile",
      dpr: 2,
      scan: mobileScan,
      regions: [{ ...desktop.regions[0]!, viewport: { width: 390, height: 844 } }],
      claims: [],
      screenshots: [],
      artifacts: [mobileArtifact],
      status: "partial",
      coverage: {
        status: "partial",
        collected: 1,
        excluded: 0,
        limitations: ["DOM_NODE_LIMIT"],
      },
      limitations: ["DOM_NODE_LIMIT"],
    });
    attempt.artifacts.push(mobileArtifact);
    attempt.status = "partial";
    attempt.coverage = {
      status: "partial",
      collected: desktop.regions.length + 1,
      excluded: 0,
      limitations: ["DOM_NODE_LIMIT"],
    };
    attempt.limitations = ["DOM_NODE_LIMIT"];

    const result = await publishCapture(attempt);
    expect(result).toMatchObject({
      published: true,
      regionCount: desktop.regions.length,
      claimCount: desktop.claims.length,
    });
    expect(result.code).toBeUndefined();
    expect(result.captureIds).toHaveLength(1);

    const storedRows = cache.withAtlasDb((db) => ({
      captures: db
        .prepare("SELECT id, profile_key, status, coverage_json FROM atlas_captures")
        .all() as Array<{
        id: string;
        profile_key: string;
        status: string;
        coverage_json: string;
      }>,
      heads: db.prepare("SELECT profile_key, capture_id FROM atlas_heads").all() as Array<{
        profile_key: string;
        capture_id: string;
      }>,
      regions: db
        .prepare(
          `SELECT c.profile_key, r.kind, r.coverage_json FROM atlas_regions r
           JOIN atlas_captures c ON c.id = r.capture_id`,
        )
        .all() as Array<{ profile_key: string; kind: string; coverage_json: string }>,
      claims: (db.prepare("SELECT COUNT(*) AS n FROM atlas_claims").get() as { n: number }).n,
    }));
    expect(storedRows.captures).toHaveLength(1);
    const capture = storedRows.captures[0]!;
    expect(capture).toMatchObject({ profile_key: "live-desktop", status: "complete" });
    expect(JSON.parse(capture.coverage_json)).toEqual({
      status: "complete",
      collected: desktop.regions.length,
      excluded: 0,
      limitations: [],
    });
    expect(storedRows.heads).toEqual([
      { profile_key: "live-desktop", capture_id: result.captureIds[0] },
    ]);
    expect(storedRows.regions).toHaveLength(desktop.regions.length + 1);
    expect(storedRows.regions.every((row) => row.profile_key === "live-desktop")).toBe(true);
    expect(
      storedRows.regions.filter((row) => row.kind === "section"),
    ).toHaveLength(desktop.regions.length);
    for (const row of storedRows.regions) {
      expect(JSON.parse(row.coverage_json)).toMatchObject({
        status: "complete",
        limitations: [],
      });
    }
    expect(storedRows.claims).toBe(desktop.claims.length);
  });

  it("persists retained section nesting", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const attempt = attemptFor(cache, "valid");
    const regions = attempt.viewports[0]!.regions;
    regions[1]!.parentKey = regions[0]!.key;
    const result = await publishCapture(attempt);
    expect(result.published).toBe(true);
    const child = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT parent_id FROM atlas_regions WHERE kind = 'section' AND ordinal = 1",
          )
          .get() as { parent_id: string },
    );
    const parent = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT id FROM atlas_regions WHERE kind = 'section' AND ordinal = 0",
          )
          .get() as { id: string },
    );
    expect(child.parent_id).toBe(parent.id);
  });

  it("persists a retained parent that sorts after its child", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const attempt = attemptFor(cache, "valid");
    const regions = attempt.viewports[0]!.regions;
    regions[0]!.parentKey = regions[1]!.key;
    const result = await publishCapture(attempt);
    expect(result.published, result.code).toBe(true);
    const child = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT parent_id FROM atlas_regions WHERE kind = 'section' AND ordinal = 0",
          )
          .get() as { parent_id: string },
    );
    const parent = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT id FROM atlas_regions WHERE kind = 'section' AND ordinal = 1",
          )
          .get() as { id: string },
    );
    expect(child.parent_id).toBe(parent.id);
  });

  it("refuses publication without usable section regions", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const attempt = attemptFor(cache, "valid");
    attempt.viewports[0]!.regions = [];
    const result = await publishCapture(attempt);
    expect(result).toMatchObject({ published: false, code: "NO_SECTION_REGIONS" });
  });

  it("refuses mixed valid and invalid section geometry", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const attempt = attemptFor(cache, "valid");
    attempt.viewports[0]!.regions[1]!.rect.width = 0;
    const result = await publishCapture(attempt);
    expect(result).toMatchObject({ published: false, code: "INVALID_GEOMETRY" });
  });

  it("refuses zero-width and non-finite section geometry", async () => {
    for (const width of [0, Number.POSITIVE_INFINITY]) {
      const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
      const attempt = attemptFor(cache, "valid");
      attempt.viewports[0]!.regions.forEach((region) => {
        region.rect.width = width;
      });
      const result = await publishCapture(attempt);
      expect(result).toMatchObject({ published: false, code: "INVALID_GEOMETRY" });
    }
  });

  it("refuses claims that reference absent regions", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const attempt = attemptFor(cache, "valid");
    attempt.viewports[0]!.claims[0]!.regionKey = "missing-region";
    const result = await publishCapture(attempt);
    expect(result).toMatchObject({ published: false, code: "CLAIM_REGION_MISSING" });
  });

  it("rejects B@2000 after identical A@3000 confirmation", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const first = attemptFor(cache, "valid");
    first.finishedAt = NOW + 1000;
    await publishCapture(first);
    const confirmed = attemptFor(cache, "valid");
    confirmed.finishedAt = NOW + 3000;
    expect((await publishCapture(confirmed)).published).toBe(true);
    const older = attemptFor(cache, "valid", { scanTitle: "Different content" });
    older.finishedAt = NOW + 2000;
    const result = await publishCapture(older);
    expect(result).toMatchObject({ published: false, code: "STALE_OBSERVATION" });
  });

  it("rejects an older observation before changing the head", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const first = attemptFor(cache, "valid");
    first.finishedAt = NOW + 3000;
    await publishCapture(first);
    const head = cache.withAtlasDb(
      (db) =>
        (db.prepare("SELECT capture_id FROM atlas_heads").get() as { capture_id: string })
          .capture_id,
    );
    const second = attemptFor(cache, "valid", { scanTitle: "Older" });
    second.finishedAt = NOW + 500;
    const result = await publishCapture(second);
    expect(result).toMatchObject({ published: false, code: "STALE_OBSERVATION" });
    expect(
      cache.withAtlasDb(
        (db) =>
          (db.prepare("SELECT capture_id FROM atlas_heads").get() as { capture_id: string })
            .capture_id,
      ),
    ).toBe(head);
  });

  it("does not reuse a capture when coverage materiality changes", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    await publishCapture(attemptFor(cache, "valid"));
    const partial = attemptFor(cache, "valid");
    partial.status = "partial";
    partial.limitations = ["SCREENSHOTS_MISSING"];
    partial.coverage = {
      status: "partial",
      collected: partial.coverage.collected,
      excluded: 1,
      limitations: ["SCREENSHOTS_MISSING"],
    };
    partial.viewports[0]!.status = partial.status;
    partial.viewports[0]!.limitations = [...partial.limitations];
    partial.viewports[0]!.coverage = { ...partial.coverage };
    const result = await publishCapture(partial);
    expect(result.published).toBe(true);
    expect(
      cache.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_captures").get() as { n: number }).n,
      ),
    ).toBe(2);
  });

  it("updates confirmation metadata on a genuine identical reuse", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    await publishCapture(attemptFor(cache, "valid"));
    const second = attemptFor(cache, "valid");
    second.finishedAt = NOW + 5000;
    await publishCapture(second);
    const capture = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT last_confirmed_at, finished_at FROM atlas_captures")
          .get() as { last_confirmed_at: number; finished_at: number },
    );
    expect(capture).toEqual({ last_confirmed_at: NOW + 5000, finished_at: NOW + 5000 });
  });

  it("persists checkpoint observations in region samples", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const attempt = attemptFor(cache, "valid");
    const region = attempt.viewports[0]!.regions[0]!;
    const stable = regionStableKey(region);
    attempt.viewports[0]!.observations = [
      {
        key: "observation-desktop-0",
        checkpoint: 0,
        scrollY: 0,
        scrollRoot: null,
        state: "default",
        settleStatus: "settled",
        coordinateSpace: "document",
        scrollX: 0,
        viewport: "desktop",
        regionKeys: [stable],
        regions: [
          {
            key: stable,
            sampleKey: `desktop:${stable}:observation-desktop-0`,
            targetRegionId: null,
            visible: true,
            coordinateSpace: "document",
            scrollX: 0,
            selector: region.selector,
            tag: region.tag,
            heading: region.heading,
            text: region.text,
            rect: region.rect,
          },
        ],
        screenshotKey: "screenshot-desktop-0",
        scanArtifactKey: "checkpoint-desktop-0",
      },
    ];
    expect((await publishCapture(attempt)).published).toBe(true);
    const row = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT samples_json FROM atlas_regions WHERE kind = 'section' ORDER BY ordinal LIMIT 1")
          .get() as { samples_json: string },
    );
    expect(JSON.parse(row.samples_json).observations[0]).toMatchObject({
      checkpoint: 0,
      scrollY: 0,
      state: "default",
      coordinateSpace: "document",
      screenshotKey: "screenshot-desktop-0",
      regionKeys: [stable],
    });
    const sample = JSON.parse(row.samples_json).observations[0].regions[0];
    const regionId = cache.withAtlasDb(
      (db) =>
        (db
          .prepare("SELECT id FROM atlas_regions WHERE kind = 'section' ORDER BY ordinal LIMIT 1")
          .get() as { id: string }).id,
    );
    expect(sample).toMatchObject({
      sampleKey: `desktop:${stable}:observation-desktop-0`,
      visible: true,
      targetRegionId: regionId,
    });
  });

  it("creates new captures for checkpoint, claim, and region changes", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const first = attemptFor(cache, "valid");
    const firstResult = await publishCapture(first);
    expect(firstResult.published).toBe(true);
    const firstCapture = firstResult.captureIds[0];

    const headingChange = attemptFor(cache, "valid");
    headingChange.viewports[0]!.regions[0]!.heading = "Changed heading";
    const headingResult = await publishCapture(headingChange);
    expect(headingResult.captureIds[0]).not.toBe(firstCapture);

    const checkpointChange = attemptFor(cache, "valid");
    const region = checkpointChange.viewports[0]!.regions[0]!;
    const stable = regionStableKey(region);
    checkpointChange.viewports[0]!.observations = [
      {
        key: "observation-desktop-0",
        checkpoint: 0,
        scrollY: 0,
        scrollRoot: null,
        state: "default",
        settleStatus: "settled",
        coordinateSpace: "document",
        scrollX: 0,
        viewport: "desktop",
        regionKeys: [stable],
        regions: [
          {
            key: stable,
            sampleKey: `desktop:${stable}:observation-desktop-0`,
            targetRegionId: null,
            visible: true,
            coordinateSpace: "document",
            scrollX: 0,
            selector: region.selector,
            tag: region.tag,
            heading: region.heading,
            text: "Checkpoint A",
            rect: region.rect,
          },
        ],
        screenshotKey: "screenshot-desktop-0",
        scanArtifactKey: "checkpoint-desktop-0",
      },
    ];
    const checkpointResult = await publishCapture(checkpointChange);
    expect(checkpointResult.captureIds[0]).not.toBe(firstCapture);
    expect(checkpointResult.captureIds[0]).not.toBe(headingResult.captureIds[0]);

    const claimChange = attemptFor(cache, "valid");
    const baseClaim = claimChange.viewports[0]!.claims[0];
    expect(baseClaim).toBeTruthy();
    claimChange.viewports[0]!.claims = [
      { ...baseClaim!, value: "sentinel-purpose", sampleKey: "sentinel" },
    ];
    const claimResult = await publishCapture(claimChange);
    expect(claimResult.captureIds[0]).not.toBe(firstCapture);
    expect(claimResult.captureIds[0]).not.toBe(headingResult.captureIds[0]);
    expect(claimResult.captureIds[0]).not.toBe(checkpointResult.captureIds[0]);

    const checkpointArtifact = (payload: unknown): AtlasStoredArtifact => {
      const stored = writeJsonArtifactSync(cache.rootDir, payload);
      return {
        key: "checkpoint-desktop-0",
        kind: "raw_observation",
        storagePath: stored.storagePath,
        sha256: stored.sha256,
        bytes: stored.bytes,
        mimeType: "application/json",
        regionKey: null,
      };
    };
    const artifactA = attemptFor(cache, "valid");
    artifactA.viewports[0]!.artifacts.push(checkpointArtifact({ content: "A" }));
    const artifactAResult = await publishCapture(artifactA);
    expect(artifactAResult.published).toBe(true);

    const artifactB = attemptFor(cache, "valid");
    artifactB.viewports[0]!.artifacts.push(checkpointArtifact({ content: "B" }));
    const artifactBResult = await publishCapture(artifactB);
    expect(artifactBResult.captureIds[0]).not.toBe(artifactAResult.captureIds[0]);
  });

  it("creates a new capture when claim rule provenance changes", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const firstResult = await publishCapture(attemptFor(cache, "valid"));
    expect(firstResult.published).toBe(true);

    const changed = attemptFor(cache, "valid");
    const claim = changed.viewports[0]!.claims[0]!;
    claim.ruleVersion = "sentinel-rule-v2";
    const changedResult = await publishCapture(changed);

    expect(changedResult.published).toBe(true);
    expect(changedResult.captureIds[0]).not.toBe(firstResult.captureIds[0]);
    const stored = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            `SELECT c.rule_version AS rule_version FROM atlas_claims c
             JOIN atlas_regions r ON r.id = c.region_id
             JOIN atlas_heads h ON h.capture_id = r.capture_id
             WHERE c.sample_key = ? AND c.field = ? AND c.value = ?`,
          )
          .get(claim.sampleKey, claim.field, claim.value) as { rule_version: string },
    );
    expect(stored.rule_version).toBe("sentinel-rule-v2");
  });

  it("creates a new capture when claim evidence changes", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const firstResult = await publishCapture(attemptFor(cache, "valid"));
    expect(firstResult.published).toBe(true);

    const changed = attemptFor(cache, "valid");
    const claim = changed.viewports[0]!.claims[0]!;
    const evidence = claim.evidence[0]!;
    evidence.pointer = evidence.pointer === "/scan/sections/0" ? "/scan/sections/1" : "/scan/sections/0";
    const changedResult = await publishCapture(changed);

    expect(changedResult.published).toBe(true);
    expect(changedResult.captureIds[0]).not.toBe(firstResult.captureIds[0]);
    const stored = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            `SELECT c.evidence_json AS evidence_json FROM atlas_claims c
             JOIN atlas_regions r ON r.id = c.region_id
             JOIN atlas_heads h ON h.capture_id = r.capture_id
             WHERE c.sample_key = ? AND c.field = ? AND c.value = ?`,
          )
          .get(claim.sampleKey, claim.field, claim.value) as { evidence_json: string },
    );
    expect(JSON.parse(stored.evidence_json)[0].pointer).toBe(evidence.pointer);
  });

  it("refuses publication after a denied subresource policy block", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const first = attemptFor(cache, "valid");
    expect((await publishCapture(first)).published).toBe(true);
    const blocked = attemptFor(cache, "valid");
    blocked.limitations = ["POLICY_BLOCKED"];
    blocked.status = "partial";
    const result = await publishCapture(blocked);
    expect(result).toMatchObject({ published: false, code: "POLICY_BLOCKED" });
    const head = cache.withAtlasDb(
      (db) =>
        db.prepare("SELECT COUNT(*) AS n FROM atlas_heads").get() as { n: number },
    );
    expect(head.n).toBe(1);
  });

  it("preserves partial coverage on published regions", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const attempt = attemptFor(cache, "valid");
    attempt.status = "partial";
    attempt.limitations = ["SCREENSHOTS_MISSING"];
    attempt.coverage = {
      status: "partial",
      collected: attempt.coverage.collected,
      excluded: 2,
      limitations: ["SCREENSHOTS_MISSING"],
    };
    attempt.viewports[0]!.status = attempt.status;
    attempt.viewports[0]!.limitations = [...attempt.limitations];
    attempt.viewports[0]!.coverage = { ...attempt.coverage };
    const result = await publishCapture(attempt);
    expect(result.published).toBe(true);
    const coverage = cache.withAtlasDb(
      (db) =>
        db
          .prepare(
            "SELECT coverage_json FROM atlas_regions WHERE kind = 'section' ORDER BY ordinal LIMIT 1",
          )
          .get() as { coverage_json: string },
    );
    expect(JSON.parse(coverage.coverage_json)).toMatchObject({
      status: "partial",
      limitations: ["SCREENSHOTS_MISSING"],
    });
  });

  it("refuses a non-PNG screenshot payload", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const result = await publishCapture(
      attemptFor(cache, "valid", { screenshot: Buffer.from("not-a-png") }),
    );
    expect(result).toMatchObject({ published: false, code: "ARTIFACT_INVALID" });
  });

  it("withdraws a head whose artifact is corrupted on republish", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const attempt = attemptFor(cache, "valid");
    expect((await publishCapture(attempt)).published).toBe(true);
    const first = cache.withAtlasDb((db) => ({
      heads: (db.prepare("SELECT COUNT(*) AS n FROM atlas_heads").get() as { n: number }).n,
      fts: (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
      captures: (db.prepare("SELECT COUNT(*) AS n FROM atlas_captures").get() as { n: number }).n,
      revision: (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
        revision: number;
      }).revision,
    }));
    expect(first).toMatchObject({ heads: 1, captures: 1, revision: 1 });
    expect(first.fts).toBeGreaterThan(0);
    const raw = attempt.viewports[0]!.artifacts.find((artifact) => artifact.kind === "raw_observation");
    expect(raw).toBeTruthy();
    writeFileSync(join(cache.rootDir, raw!.storagePath), "corrupt");
    const result = await publishCapture(attempt);
    expect(result).toMatchObject({ published: false, code: "ARTIFACT_INVALID" });
    const after = cache.withAtlasDb((db) => ({
      heads: (db.prepare("SELECT COUNT(*) AS n FROM atlas_heads").get() as { n: number }).n,
      fts: (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
      aliases: (db.prepare("SELECT COUNT(*) AS n FROM atlas_aliases").get() as { n: number }).n,
      captures: (db.prepare("SELECT COUNT(*) AS n FROM atlas_captures").get() as { n: number }).n,
      revision: (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
        revision: number;
      }).revision,
    }));
    expect(after).toMatchObject({ heads: 0, fts: 0, aliases: 0, captures: 1, revision: 2 });
  });

  it("keeps a head when only the incoming artifact metadata is invalid", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const attempt = attemptFor(cache, "valid");
    expect((await publishCapture(attempt)).published).toBe(true);
    const raw = attempt.viewports[0]!.artifacts.find((artifact) => artifact.kind === "raw_observation");
    expect(raw).toBeTruthy();
    raw!.bytes += 1;
    const result = await publishCapture(attempt);
    expect(result).toMatchObject({ published: false, code: "ARTIFACT_INVALID" });
    const after = cache.withAtlasDb((db) => ({
      heads: (db.prepare("SELECT COUNT(*) AS n FROM atlas_heads").get() as { n: number }).n,
      fts: (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
      revision: (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
        revision: number;
      }).revision,
    }));
    expect(after.heads).toBe(1);
    expect(after.fts).toBeGreaterThan(0);
    expect(after.revision).toBe(1);
  });

  it("withdraws all heads sharing a corrupted artifact", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const first = attemptFor(cache, "valid");
    expect((await publishCapture(first)).published).toBe(true);
    const second = attemptFor(cache, "valid");
    second.target.urlKey = "/other";
    second.target.path = "/other";
    expect((await publishCapture(second)).published).toBe(true);
    const screenshot = first.viewports[0]!.artifacts.find(
      (artifact) => artifact.kind === "screenshot",
    );
    expect(screenshot).toBeTruthy();
    writeFileSync(join(cache.rootDir, screenshot!.storagePath), "corrupt");
    const result = await publishCapture(first);
    expect(result).toMatchObject({ published: false, code: "ARTIFACT_INVALID" });
    const after = cache.withAtlasDb((db) => ({
      heads: (db.prepare("SELECT COUNT(*) AS n FROM atlas_heads").get() as { n: number }).n,
      fts: (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
      captures: (db.prepare("SELECT COUNT(*) AS n FROM atlas_captures").get() as { n: number }).n,
    }));
    expect(after).toMatchObject({ heads: 0, fts: 0, captures: 2 });
  });

  it("refuses accepted claims with empty evidence arrays", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const attempt = attemptFor(cache, "valid");
    attempt.viewports[0]!.claims[0]!.evidence = [];
    const result = await publishCapture(attempt);
    expect(result).toMatchObject({ published: false, code: "EVIDENCE_UNRESOLVED" });
  });

  it("refuses publication when an accepted evidence pointer does not resolve", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const attempt = attemptFor(cache, "valid");
    attempt.viewports[0]!.claims[0]!.evidence[0]!.pointer = "/does/not/exist";
    const result = await publishCapture(attempt);
    expect(result).toMatchObject({ published: false, code: "EVIDENCE_UNRESOLVED" });
  });

  it("withdraws the outgoing head's FTS when a new capture is published", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    await publishCapture(attemptFor(cache, "valid"));
    const before = cache.withAtlasDb(
      (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
    );
    const result = await publishCapture(attemptFor(cache, "valid", { scanTitle: "Changed title" }));
    expect(result.published).toBe(true);
    const after = cache.withAtlasDb(
      (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_regions_fts").get() as { n: number }).n,
    );
    expect(after).toBe(before);
    expect(
      cache.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_captures").get() as { n: number }).n,
      ),
    ).toBe(2);
  });

  it("republishes identical content when FTS is unavailable", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true, fts: false });
    const first = await publishCapture(attemptFor(cache, "valid"));
    expect(first.published).toBe(true);

    const second = await publishCapture(attemptFor(cache, "valid"));

    expect(second).toMatchObject({ published: true, captureIds: first.captureIds });
    expect(
      cache.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_captures").get() as { n: number }).n,
      ),
    ).toBe(1);
  });

  it("republishes changed content when FTS is unavailable", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true, fts: false });
    const first = await publishCapture(attemptFor(cache, "valid"));
    expect(first.published).toBe(true);

    const changed = await publishCapture(
      attemptFor(cache, "valid", { scanTitle: "Changed without FTS" }),
    );

    expect(changed.published).toBe(true);
    expect(changed.captureIds[0]).not.toBe(first.captureIds[0]);
    const state = cache.withAtlasDb((db) => ({
      captures: (db.prepare("SELECT COUNT(*) AS n FROM atlas_captures").get() as { n: number }).n,
      head: (db.prepare("SELECT capture_id FROM atlas_heads").get() as { capture_id: string })
        .capture_id,
    }));
    expect(state).toEqual({ captures: 2, head: changed.captureIds[0] });
  });

  it("handles an identical refresh without duplicating capture rows", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    await publishCapture(attemptFor(cache, "valid"));
    const second = await publishCapture(attemptFor(cache, "valid"));
    expect(second).toMatchObject({ published: true });
    expect(
      cache.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_captures").get() as { n: number }).n,
      ),
    ).toBe(1);
  });

  it("creates a new capture when screenshot evidence changes", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    await publishCapture(attemptFor(cache, "valid"));
    const second = await publishCapture(
      attemptFor(cache, "valid", {
        screenshot: PNG_ALT,
      }),
    );
    expect(second.published).toBe(true);
    expect(
      cache.withAtlasDb(
        (db) => (db.prepare("SELECT COUNT(*) AS n FROM atlas_captures").get() as { n: number }).n,
      ),
    ).toBe(2);
  });

  it("keeps hover claims out of default labels, hit claims and ranking", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const attempt = attemptFor(cache, "valid");
    const viewport = attempt.viewports[0]!;
    const first = viewport.regions[0]!;
    const second = viewport.regions[1]!;
    const hoverSample = `desktop:${regionStableKey(first)}:state-hover`;
    viewport.claims.push({
      regionKey: first.key,
      field: "behavior",
      value: "hover_change_observed",
      decision: "accepted",
      classification: "observed",
      basis: "interaction_observation",
      ruleId: "behavior.state.hover",
      ruleVersion: "test",
      sampleKey: hoverSample,
      state: "hover",
      evidence: [
        {
          artifactId: "scan-desktop",
          pointer: `/scan/sections/${first.scanIndex}`,
          sampleKey: hoverSample,
        },
      ],
    });
    const defaultSample = `desktop:${regionStableKey(second)}:default`;
    viewport.claims.push({
      regionKey: second.key,
      field: "section.purpose",
      value: "pricing",
      decision: "accepted",
      classification: "observed",
      basis: "native_semantics",
      ruleId: "test.default",
      ruleVersion: "test",
      sampleKey: defaultSample,
      evidence: [
        {
          artifactId: "scan-desktop",
          pointer: `/scan/sections/${second.scanIndex}`,
          sampleKey: defaultSample,
        },
      ],
    });
    viewport.states = [
      {
        action: "hover",
        targetRegionId: "requested-region",
        status: "observed",
        sampleKey: hoverSample,
        regionKey: first.key,
      },
    ];
    attempt.states = [{ action: "hover", targetRegionId: "requested-region" }];
    const published = await publishCapture(attempt);
    expect(published.published, published.code).toBe(true);
    const idByOrdinal = cache.withAtlasDb(
      (db) =>
        new Map(
          (
            db
              .prepare(
                "SELECT id, ordinal FROM atlas_regions WHERE capture_id = ? AND kind = 'section'",
              )
              .all(published.captureIds[0]!) as Array<{ id: string; ordinal: number }>
          ).map((row) => [row.ordinal, row.id]),
        ),
    );
    const firstId = idByOrdinal.get(first.ordinal)!;
    const secondId = idByOrdinal.get(second.ordinal)!;
    expect(published.publishedRegionIds).toEqual({ "requested-region": firstId });
    expect(
      cache.withAtlasDb(
        (db) =>
          (
            db
              .prepare(
                "SELECT state FROM atlas_claims WHERE region_id = ? AND field = 'behavior'",
              )
              .all(firstId) as Array<{ state: string }>
          )[0]?.state,
      ),
    ).toBe("hover");

    const store = atlasSearchStore(cache);
    const defaultHits = searchAtlas(
      { kind: "sections", evidenceMode: "accepted", limit: 20 },
      store,
      NOW + 2_000,
    );
    if (!defaultHits.ok) throw new Error(defaultHits.error.code);
    expect(defaultHits.data.results[0]!.regionId).toBe(secondId);
    expect(
      defaultHits.data.results
        .find((hit) => hit.regionId === firstId)!
        .claims.some((claim) => claim.field === "behavior"),
    ).toBe(false);

    const text = searchAtlas(
      {
        kind: "sections",
        query: "hover_change_observed",
        evidenceMode: "accepted",
        limit: 20,
      },
      store,
      NOW + 2_000,
    );
    if (!text.ok) throw new Error(text.error.code);
    expect(text.data.total).toBe(0);

    const hovered = searchAtlas(
      { kind: "sections", state: "hover", evidenceMode: "accepted", limit: 20 },
      store,
      NOW + 2_000,
    );
    if (!hovered.ok) throw new Error(hovered.error.code);
    expect(hovered.data.outcome).toBe("matches");
    expect(hovered.data.results.map((hit) => hit.regionId)).toEqual([firstId]);
    expect(
      hovered.data.results[0]!.claims.map((claim) => claim.value),
    ).toEqual(["hover_change_observed"]);
  });

  it("keeps a candidate state context purpose candidate in search", async () => {
    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const attempt = attemptFor(cache, "valid");
    const viewport = attempt.viewports[0]!;
    const component: ComponentCandidate = {
      key: "component-state",
      ordinal: 0,
      scanIndex: 0,
      nodeKey: "component-node",
      selector: "main > section#a > button#open",
      tag: "button",
      role: null,
      type: "button",
      typeClassification: "observed",
      typeBasis: "native_semantics",
      typeDecision: "accepted",
      typeRuleId: "component.native_semantics.button",
      label: "Open",
      visible: true,
      offscreen: false,
      sectionNodeKey: null,
      sectionKey: null,
      patternKey: "pattern-state",
      rect: { x: 0, y: 0, width: 40, height: 20 },
      depth: 1,
      pack: null,
    };
    viewport.components = [component];
    const defaultSample = "desktop:component-state:default";
    const hoverSample = "desktop:component-state:state-hover";
    const ref = (sampleKey: string) => [
      { artifactId: "scan-desktop", pointer: "/scan/sections/0", sampleKey },
    ];
    viewport.claims.push(
      {
        regionKey: component.key,
        field: "component.type",
        value: "button",
        decision: "accepted",
        classification: "observed",
        basis: "native_semantics",
        ruleId: "component.native_semantics.button",
        ruleVersion: "test",
        sampleKey: defaultSample,
        evidence: ref(defaultSample),
      },
      {
        regionKey: component.key,
        field: "context.section_purpose",
        value: "hero",
        decision: "accepted",
        classification: "inferred",
        basis: "rule_derivation",
        ruleId: "context.section_purpose.accepted",
        ruleVersion: "test",
        sampleKey: defaultSample,
        evidence: ref(defaultSample),
      },
      {
        regionKey: component.key,
        field: "component.type",
        value: "button",
        decision: "accepted",
        classification: "observed",
        basis: "native_semantics",
        ruleId: "component.native_semantics.button",
        ruleVersion: "test",
        sampleKey: hoverSample,
        state: "hover",
        evidence: ref(hoverSample),
      },
      {
        regionKey: component.key,
        field: "context.section_purpose",
        value: "pricing",
        decision: "candidate",
        classification: "inferred",
        basis: "rule_derivation",
        ruleId: "test.state",
        ruleVersion: "test",
        sampleKey: hoverSample,
        state: "hover",
        evidence: ref(hoverSample),
      },
      {
        regionKey: component.key,
        field: "behavior",
        value: "hover_change_observed",
        decision: "accepted",
        classification: "observed",
        basis: "interaction_observation",
        ruleId: "behavior.state.hover",
        ruleVersion: "test",
        sampleKey: hoverSample,
        state: "hover",
        evidence: ref(hoverSample),
      },
    );
    viewport.states = [
      {
        action: "hover",
        targetRegionId: "component-request",
        status: "observed",
        sampleKey: hoverSample,
        regionKey: component.key,
      },
    ];
    attempt.states = [{ action: "hover", targetRegionId: "component-request" }];
    const published = await publishCapture(attempt);
    expect(published.published, published.code).toBe(true);
    const componentId = published.publishedRegionIds!["component-request"]!;

    const accepted = searchAtlas(
      {
        kind: "components",
        state: "hover",
        scope: "region",
        evidenceMode: "accepted",
        predicates: [{ field: "context.section_purpose", values: ["pricing"] }],
      },
      atlasSearchStore(cache),
      NOW + 2_000,
    );
    if (!accepted.ok) throw new Error(accepted.error.code);
    expect(accepted.data.total).toBe(0);

    const candidates = searchAtlas(
      {
        kind: "components",
        state: "hover",
        scope: "region",
        evidenceMode: "candidate",
        predicates: [{ field: "context.section_purpose", values: ["pricing"] }],
      },
      atlasSearchStore(cache),
      NOW + 2_000,
    );
    if (!candidates.ok) throw new Error(candidates.error.code);
    expect(candidates.data.results.map((hit) => hit.regionId)).toEqual([componentId]);
    expect(candidates.data.results[0]!.claims).toContainEqual(
      expect.objectContaining({ value: "pricing", decision: "candidate" }),
    );
  });

  it("stores canonical state requests in the capture config", async () => {
    const captureFor = async (
      states: Array<{ action: "hover" | "focus"; targetRegionId: string }>,
    ): Promise<string> => {
      const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
      const attempt = attemptFor(cache, "valid");
      attempt.states = states;
      const published = await publishCapture(attempt);
      expect(published.published, published.code).toBe(true);
      return published.captureIds[0]!;
    };
    const forward = await captureFor([
      { action: "hover", targetRegionId: "target-a" },
      { action: "focus", targetRegionId: "target-b" },
    ]);
    const reversed = await captureFor([
      { action: "focus", targetRegionId: "target-b" },
      { action: "hover", targetRegionId: "target-a" },
    ]);
    const different = await captureFor([{ action: "focus", targetRegionId: "target-c" }]);
    expect(reversed).toBe(forward);
    expect(different).not.toBe(forward);

    const cache = new Cache(tmpDir(), () => NOW, { atlas: true });
    const attempt = attemptFor(cache, "valid");
    attempt.states = [{ action: "hover", targetRegionId: "target-a" }];
    const published = await publishCapture(attempt);
    const config = cache.withAtlasDb(
      (db) =>
        JSON.parse(
          (
            db
              .prepare("SELECT config_json FROM atlas_captures WHERE id = ?")
              .get(published.captureIds[0]!) as { config_json: string }
          ).config_json,
        ) as { states: unknown },
    );
    expect(config.states).toEqual([{ action: "hover", targetRegionId: "target-a" }]);
  });
});
