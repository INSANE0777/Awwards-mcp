import type { DatabaseSync } from "node:sqlite";
import type { Cache } from "../cache.js";
import {
  artifactId,
  captureConfigHash,
  captureId,
  componentFingerprint,
  pageId,
  regionId,
  sectionFingerprint,
  sha256Text,
  stableHash,
} from "./identity.js";
import {
  validateStoredArtifact,
  artifactPointerResolves,
  isPngStoredArtifact,
  readStoredArtifactJson,
} from "./artifacts.js";
import { primaryPurpose } from "./classification.js";
import { regionStableKey } from "./segmentation.js";
import { checkAtlasRedirect } from "./policy.js";
import { removeHead } from "./heads.js";
import {
  bumpAtlasRevision,
  bumpAtlasRevisionInPlace,
  refreshCaptureProjectionFreshness,
} from "./search-projections.js";
import { ATLAS_VOCABULARY_VERSION, canonicalLandmark } from "./vocabulary.js";
import type {
  AtlasCaptureAttempt,
  AtlasClaim,
  AtlasPublicationResult,
  AtlasStateRequest,
  AtlasStoredArtifact,
  AtlasViewportCapture,
  ComponentCandidate,
} from "./live-types.js";

const EXTRACTOR_VERSION = "atlas-extractor-3";
const CLASSIFIER_VERSION = "atlas-classifier-2";
const SOURCE_KIND = "live_page";
/** Must match the search freshness window: 30 days. */
const FRESH_WINDOW_MS = 30 * 86_400_000;

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const errcode = (error as { errcode?: number } | null)?.errcode;
  return (
    errcode === 5 ||
    errcode === 6 ||
    /SQLITE_BUSY|database is locked|database table is locked/i.test(message)
  );
}

function claimKey(region: string, claim: AtlasClaim): string {
  return stableHash(
    "claim-v1",
    region,
    claim.field,
    claim.value,
    claim.sampleKey,
    claim.basis,
    claim.ruleId,
  );
}

/**
 * Capture config identity for state requests: sorted and de-duplicated, so the
 * same request set always hashes equally and a different set never conflates.
 */
function canonicalStates(
  states: AtlasStateRequest[] | undefined,
): Array<{ action: string; targetRegionId: string }> {
  const unique = new Map<string, { action: string; targetRegionId: string }>();
  for (const state of states ?? []) {
    unique.set(`${state.action}\u0000${state.targetRegionId}`, {
      action: state.action,
      targetRegionId: state.targetRegionId,
    });
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.action.localeCompare(right.action) ||
      left.targetRegionId.localeCompare(right.targetRegionId),
  );
}

/** Maps observed state targets onto the region ids stored by this capture. */
function stateRegionIdMap(
  viewport: AtlasViewportCapture,
  capture: string,
): Record<string, string> {
  const components = viewport.components ?? [];
  const retained = new Map([
    ...viewport.regions.map(
      (region) => [region.key, regionId(capture, "section", region.ordinal, region.key)] as const,
    ),
    ...components.map(
      (component) => [component.key, regionId(capture, "component", component.ordinal, component.key)] as const,
    ),
  ]);
  const mapped: Record<string, string> = {};
  for (const state of viewport.states ?? []) {
    const key = state.regionKey;
    const published = key ? retained.get(key) : undefined;
    if (published) mapped[state.targetRegionId] = published;
  }
  return mapped;
}

function claimLabels(claims: AtlasClaim[]): string {
  return claims
    .filter(
      (claim) =>
        (claim.state ?? "default") === "default" &&
        claim.decision === "accepted" &&
        claim.classification !== "proposed",
    )
    .sort((a, b) => a.field.localeCompare(b.field) || a.value.localeCompare(b.value))
    .map((claim) => `${claim.field} ${claim.value}`)
    .join(" ");
}

/**
 * A pack proves structure only for the component that owns it. The payload's
 * component key and type, plus its root tag/role, must match that component.
 */
function packOwnershipMismatch(
  cacheRoot: string,
  artifact: AtlasStoredArtifact,
  components: Map<string, ComponentCandidate>,
): boolean {
  const owner = artifact.regionKey ? components.get(artifact.regionKey) : undefined;
  if (!owner) return true;
  let payload: unknown;
  try {
    payload = readStoredArtifactJson(cacheRoot, artifact);
  } catch {
    return true;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return true;
  const record = payload as Record<string, unknown>;
  if (record.componentKey !== owner.key || record.type !== owner.type) return true;
  const nodes = record.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return true;
  const root = nodes[0];
  if (!root || typeof root !== "object" || Array.isArray(root)) return true;
  const node = root as Record<string, unknown>;
  const role = node.role === null || node.role === undefined ? null : String(node.role);
  return node.tag !== owner.tag || role !== owner.role;
}

function artifactRow(
  db: DatabaseSync,
  capture: string,
  artifact: AtlasStoredArtifact,
  ordinal: number,
  now: number,
): string {
  const id = artifactId(capture, artifact.kind, artifact.sha256, ordinal);
  db.prepare(
    `INSERT OR IGNORE INTO atlas_artifacts
       (id, capture_id, region_id, kind, storage_path, external_url, sha256, bytes,
        mime_type, state, rights_json, metadata_json)
     VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, ?, 'ready', ?, ?)`,
  ).run(
    id,
    capture,
    artifact.kind,
    artifact.storagePath,
    artifact.sha256,
    artifact.bytes,
    artifact.mimeType,
    JSON.stringify({
      status: "unknown",
      reference: null,
      recordedAt: now,
      assertedBy: "unknown",
      scope: "local_reference",
    }),
    JSON.stringify({ key: artifact.key }),
  );
  return id;
}

function deleteHeadFts(db: DatabaseSync, page: string, profile: string): void {
  const head = db
    .prepare("SELECT capture_id FROM atlas_heads WHERE page_id = ? AND profile_key = ?")
    .get(page, profile) as { capture_id: string } | undefined;
  if (!head) return;
  const ftsTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'atlas_regions_fts'")
    .get();
  if (!ftsTable) return;
  db.prepare(
    "DELETE FROM atlas_regions_fts WHERE region_id IN (SELECT id FROM atlas_regions WHERE capture_id = ?)",
  ).run(head.capture_id);
}

function existingCaptureCounts(
  db: DatabaseSync,
  capture: string,
): { regions: number; components: number; claims: number } {
  const regions = db
    .prepare("SELECT COUNT(*) AS n FROM atlas_regions WHERE capture_id = ? AND kind = 'section'")
    .get(capture) as { n: number };
  const components = db
    .prepare("SELECT COUNT(*) AS n FROM atlas_regions WHERE capture_id = ? AND kind = 'component'")
    .get(capture) as { n: number };
  const claims = db
    .prepare(
      `SELECT COUNT(*) AS n FROM atlas_claims c
       JOIN atlas_regions r ON r.id = c.region_id
       WHERE r.capture_id = ?`,
    )
    .get(capture) as { n: number };
  return { regions: regions.n, components: components.n, claims: claims.n };
}

/** Refresh FTS/head for an already-stored deterministic capture. */
function refreshExistingCapture(
  db: DatabaseSync,
  attempt: AtlasCaptureAttempt,
  viewport: AtlasViewportCapture,
  capture: string,
  page: string,
  now: number,
): {
  regions: number;
  components: number;
  claims: number;
  freshnessChanged: boolean;
  freshnessAdvanced: boolean;
} {
  const prior = db
    .prepare(
      `SELECT status, COALESCE(last_confirmed_at, observed_at) AS fresh
       FROM atlas_captures WHERE id = ?`,
    )
    .get(capture) as { status: string; fresh: number | null } | undefined;
  const ftsVersion = (
    db.prepare("SELECT fts_version FROM atlas_state WHERE singleton = 1").get() as {
      fts_version: number;
    }
  ).fts_version;
  deleteHeadFts(db, page, viewport.profileKey);
  if (ftsVersion >= 2) {
    db.prepare(
      "DELETE FROM atlas_regions_fts WHERE region_id IN (SELECT id FROM atlas_regions WHERE capture_id = ?)",
    ).run(capture);
    const insertFts = db.prepare(
      "INSERT INTO atlas_regions_fts (region_id, title, heading, copy, labels, context) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const root = db
      .prepare("SELECT id FROM atlas_regions WHERE capture_id = ? AND kind = 'page'")
      .get(capture) as { id: string } | undefined;
    if (root) insertFts.run(root.id, "", "", "", "", attempt.target.siteSlug);
    const sections = db
      .prepare(
        `SELECT r.id, r.raw_title, r.heading, r.text_excerpt,
                COALESCE((SELECT group_concat(c.field || ' ' || c.value, ' ' ORDER BY c.field, c.value)
                          FROM atlas_claims c
                          WHERE c.region_id = r.id AND c.state = 'default'
                            AND c.decision = 'accepted'
                            AND c.classification <> 'proposed'), '') AS labels
         FROM atlas_regions r WHERE r.capture_id = ? AND r.kind = 'section' ORDER BY r.ordinal`,
      )
      .all(capture) as Array<{
      id: string;
      raw_title: string | null;
      heading: string;
      text_excerpt: string;
      labels: string;
    }>;
    for (const section of sections) {
      insertFts.run(
        section.id,
        section.raw_title ?? "",
        section.heading,
        section.text_excerpt,
        section.labels,
        attempt.target.siteSlug,
      );
    }
    const components = db
      .prepare(
        `SELECT r.id, COALESCE(r.raw_title, '') AS title, r.heading,
                COALESCE((SELECT group_concat(c.field || ' ' || c.value, ' ' ORDER BY c.field, c.value)
                          FROM atlas_claims c
                          WHERE c.region_id = r.id AND c.state = 'default'
                            AND c.decision = 'accepted'
                            AND c.classification <> 'proposed'), '') AS labels
         FROM atlas_regions r WHERE r.capture_id = ? AND r.kind = 'component'
         ORDER BY r.ordinal`,
      )
      .all(capture) as Array<{ id: string; title: string; heading: string; labels: string }>;
    for (const component of components) {
      insertFts.run(
        component.id,
        component.title,
        component.heading,
        "",
        component.labels,
        attempt.target.siteSlug,
      );
    }
  }
  db.prepare(
    `INSERT INTO atlas_heads (page_id, profile_key, capture_id, published_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(page_id, profile_key) DO UPDATE SET
       capture_id = excluded.capture_id, published_at = excluded.published_at`,
  ).run(page, viewport.profileKey, capture, now);
  db.prepare(
    `UPDATE atlas_captures
     SET status = ?, coverage_json = ?, last_confirmed_at = ?, finished_at = ?
     WHERE id = ?`,
  ).run(
    viewport.status,
    JSON.stringify(viewport.coverage),
    now,
    now,
    capture,
  );
  // An identical recapture only changes what search can see when it was
  // already outside the freshness window, or when its status changed. A
  // same-day confirmation keeps the revision (and skips the rebuild).
  const wasFresh =
    prior !== undefined &&
    prior.fresh !== null &&
    now - prior.fresh <= FRESH_WINDOW_MS;
  const freshnessChanged =
    prior === undefined || prior.status !== viewport.status || !wasFresh;
  // A later-day confirmation of unchanged evidence only moves the freshness
  // columns. Refresh them in place (summary, region projections and the site's
  // facet rows) and bump the revision without rebuilding the whole corpus.
  const freshnessAdvanced =
    !freshnessChanged && refreshCaptureProjectionFreshness(db, capture, now);
  return {
    ...existingCaptureCounts(db, capture),
    freshnessChanged,
    freshnessAdvanced,
  };
}

function storeViewport(
  db: DatabaseSync,
  attempt: AtlasCaptureAttempt,
  viewport: AtlasViewportCapture,
  capture: string,
  page: string,
  now: number,
  artifactIds: Map<string, string>,
): { regions: number; components: number } {
  for (const [index, artifact] of viewport.artifacts.entries()) {
    artifactIds.set(artifact.key, artifactRow(db, capture, artifact, index, now));
  }
  const components = viewport.components ?? [];
  const root = regionId(capture, "page", 0, attempt.target.urlKey);
  db.prepare(
    `INSERT INTO atlas_regions
       (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
        text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
     VALUES (?, ?, NULL, 'page', 0, ?, ?, '', '', NULL, NULL, ?, NULL, ?)`,
  ).run(
    root,
    capture,
    JSON.stringify({ url: viewport.finalUrl, viewport: viewport.viewport }),
    sha256Text(viewport.scan.url),
    JSON.stringify({
      url: viewport.finalUrl,
      viewport: viewport.viewport,
      dpr: viewport.dpr,
      browserVersion: viewport.browserVersion,
      reducedMotion: viewport.reducedMotion,
      scrollRoot: viewport.scrollRoot,
      screenshots: viewport.screenshots.map((shot) => shot.key),
      scanKey: viewport.artifacts.find((item) => item.kind === "raw_observation")?.key ?? null,
    }),
    JSON.stringify({ status: viewport.coverage.status, limitations: viewport.limitations }),
  );

  const claimsByRegion = new Map<string, AtlasClaim[]>();
  const acceptedByRegion = new Map<string, AtlasClaim[]>();
  for (const claim of viewport.claims) {
    const list = claimsByRegion.get(claim.regionKey) ?? [];
    list.push(claim);
    claimsByRegion.set(claim.regionKey, list);
    if (claim.decision === "accepted") {
      const accepted = acceptedByRegion.get(claim.regionKey) ?? [];
      accepted.push(claim);
      acceptedByRegion.set(claim.regionKey, accepted);
    }
  }
  const retainedIds = new Map(
    [
      ...viewport.regions.map((region) => [
        region.key,
        regionId(capture, "section", region.ordinal, region.key),
      ] as const),
      ...components.map((component) => [
        component.key,
        regionId(capture, "component", component.ordinal, component.key),
      ] as const),
    ],
  );
  const observations = viewport.observations ?? [];
  const stableIds = new Map([
    ...viewport.regions.map(
      (region) => [regionStableKey(region), retainedIds.get(region.key)!] as const,
    ),
    ...components.map(
      (component) => [component.key, retainedIds.get(component.key)!] as const,
    ),
  ]);
  const observationsFor = (key: string) =>
    observations
      .filter((observation) => observation.regionKeys.includes(key))
      .map((observation) => ({
        ...observation,
        regionKeys: [key],
        regions: observation.regions
          .filter((sample) => sample.key === key)
          .map((sample) => ({
            ...sample,
            targetRegionId:
              (sample.targetRegionId
                ? retainedIds.get(sample.targetRegionId)
                : null) ?? stableIds.get(sample.key) ?? null,
          })),
      }));

  const insertClaims = (id: string, regionKey: string): void => {
    const claims = claimsByRegion.get(regionKey) ?? [];
    for (const claim of claims) {
      const evidence = claim.evidence.map((ref) => {
        const mapped = artifactIds.get(ref.artifactId);
        if (!mapped) throw new Error(`unresolved evidence artifact ${ref.artifactId}`);
        return { ...ref, artifactId: mapped };
      });
      db.prepare(
        `INSERT OR IGNORE INTO atlas_claims
           (id, region_id, field, value, sample_key, classification, basis, decision,
            state, rule_id, rule_version, evidence_json, limitations_json, review_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        claimKey(id, claim),
        id,
        claim.field,
        claim.value,
        claim.sampleKey,
        claim.classification,
        claim.basis,
        claim.decision,
        claim.state ?? "default",
        claim.ruleId,
        claim.ruleVersion,
        JSON.stringify(evidence),
        "[]",
      );
    }
  };

  for (const region of viewport.regions) {
    const id = retainedIds.get(region.key)!;
    const claims = claimsByRegion.get(region.key) ?? [];
    db.prepare(
      `INSERT INTO atlas_regions
         (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
          text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
       VALUES (?, ?, ?, 'section', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      id,
      capture,
      root,
      region.ordinal,
      JSON.stringify({ selector: region.selector, tag: region.tag, rect: region.rect }),
      sectionFingerprint(region.selector, region.heading, region.text),
      region.heading ? region.heading.slice(0, 300) : "",
      region.text.slice(0, 4_000),
      region.heading ? region.heading.slice(0, 300) : null,
      primaryPurpose(claims),
      JSON.stringify({
        selector: region.selector,
        role: region.role,
        landmark: canonicalLandmark(region.landmark),
        rect: region.rect,
        viewport: region.viewport,
        depth: region.depth,
        backgroundColor: region.backgroundColor,
        seq: region.ordinal,
        observations: observationsFor(regionStableKey(region)),
      }),
      JSON.stringify({
        status: viewport.coverage.status,
        collected: claims.length,
        excluded: 0,
        limitations: viewport.limitations,
      }),
    );
    insertClaims(id, region.key);
  }
  // Region order is geometric, so a retained parent can follow its child. Set
  // the real parent only after every section row exists.
  for (const region of viewport.regions) {
    if (!region.parentKey || !retainedIds.has(region.parentKey)) continue;
    db.prepare("UPDATE atlas_regions SET parent_id = ? WHERE id = ?").run(
      retainedIds.get(region.parentKey)!,
      retainedIds.get(region.key)!,
    );
  }

  for (const component of components) {
    const id = retainedIds.get(component.key)!;
    const parent =
      component.sectionKey && retainedIds.has(component.sectionKey)
        ? retainedIds.get(component.sectionKey)!
        : root;
    const packKey =
      viewport.artifacts.find(
        (artifact) =>
          artifact.kind === "component_pack" && artifact.regionKey === component.key,
      )?.key ?? null;
    db.prepare(
      `INSERT INTO atlas_regions
         (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
          text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
       VALUES (?, ?, ?, 'component', ?, ?, ?, ?, '', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      capture,
      parent,
      component.ordinal,
      JSON.stringify({
        selector: component.selector,
        tag: component.tag,
        rect: component.rect,
        visible: component.visible,
        offscreen: component.offscreen,
      }),
      componentFingerprint(component.selector, component.type, component.patternKey),
      component.label.slice(0, 300),
      component.type,
      component.type,
      JSON.stringify({
        role: component.role,
        type: component.type,
        typeBasis: component.typeBasis,
        typeClassification: component.typeClassification,
        sectionKey: component.sectionKey,
        rect: component.rect,
        viewport: viewport.viewport,
        depth: component.depth,
        visible: component.visible,
        offscreen: component.offscreen,
        packKey,
        observations: observationsFor(component.key),
      }),
      component.patternKey,
      JSON.stringify({
        status: viewport.coverage.status,
        collected: (claimsByRegion.get(component.key) ?? []).length,
        excluded: 0,
        limitations: viewport.limitations,
      }),
    );
    insertClaims(id, component.key);
  }

  // Attach each component pack to the component region it describes. The
  // artifact row is inserted before regions exist (claims need its id), so the
  // link is applied once the region ids are known.
  for (const artifact of viewport.artifacts) {
    if (!artifact.regionKey) continue;
    const artifactIdValue = artifactIds.get(artifact.key);
    const regionIdValue = retainedIds.get(artifact.regionKey);
    if (!artifactIdValue || !regionIdValue) continue;
    db.prepare(
      "UPDATE atlas_artifacts SET region_id = ? WHERE id = ? AND region_id IS NULL",
    ).run(regionIdValue, artifactIdValue);
  }

  const ftsVersion = (
    db.prepare("SELECT fts_version FROM atlas_state WHERE singleton = 1").get() as {
      fts_version: number;
    }
  ).fts_version;
  deleteHeadFts(db, page, viewport.profileKey);
  if (ftsVersion >= 2) {
    const insertFts = db.prepare(
      "INSERT INTO atlas_regions_fts (region_id, title, heading, copy, labels, context) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insertFts.run(root, "", "", "", "", attempt.target.siteSlug);
    for (const region of viewport.regions) {
      const id = regionId(capture, "section", region.ordinal, region.key);
      const claims = acceptedByRegion.get(region.key) ?? [];
      insertFts.run(
        id,
        region.heading ?? "",
        region.heading ?? "",
        region.text.slice(0, 4_000),
        claimLabels(claims),
        attempt.target.siteSlug,
      );
    }
    for (const component of components) {
      const id = retainedIds.get(component.key)!;
      const claims = acceptedByRegion.get(component.key) ?? [];
      const labels = claimLabels(claims);
      insertFts.run(
        id,
        component.type,
        component.label,
        "",
        labels,
        attempt.target.siteSlug,
      );
    }
  }

  db.prepare(
    `INSERT INTO atlas_heads (page_id, profile_key, capture_id, published_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(page_id, profile_key) DO UPDATE SET
       capture_id = excluded.capture_id,
       published_at = excluded.published_at`,
  ).run(page, viewport.profileKey, capture, now);
  return { regions: viewport.regions.length, components: components.length };
}

type WithdrawalResult = { ok: true } | { ok: false; code: "PUBLICATION_BUSY" };

function withdrawInvalidArtifactHeads(
  cache: Cache,
  attempt: AtlasCaptureAttempt,
  storagePath: string,
): WithdrawalResult {
  const busy = { ok: false, code: "PUBLICATION_BUSY" } as const;
  try {
    return cache.withAtlasDb((db) => {
      let inTransaction = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        inTransaction = true;
        const refs = db
          .prepare(
            `SELECT DISTINCT h.page_id, h.profile_key, p.site_slug,
                    a.storage_path, a.sha256, a.bytes
             FROM atlas_heads h
             JOIN atlas_artifacts a ON a.capture_id = h.capture_id
             JOIN atlas_pages p ON p.id = h.page_id
             WHERE a.storage_path = ?`,
          )
          .all(storagePath) as Array<{
          page_id: string;
          profile_key: string;
          site_slug: string;
          storage_path: string;
          sha256: string | null;
          bytes: number | null;
        }>;
        const invalid = new Map<string, { page: string; profile: string; siteSlug: string }>();
        for (const ref of refs) {
          if (
            ref.sha256 === null ||
            ref.bytes === null ||
            validateStoredArtifact(cache.rootDir, {
              storagePath: ref.storage_path,
              sha256: ref.sha256,
              bytes: ref.bytes,
            }) !== null
          ) {
            invalid.set(`${ref.page_id}\u0000${ref.profile_key}`, {
              page: ref.page_id,
              profile: ref.profile_key,
              siteSlug: ref.site_slug,
            });
          }
        }
        let removed = false;
        for (const head of invalid.values()) {
          if (
            removeHead(
              db,
              head.page,
              head.profile,
              attempt.finishedAt,
              head.siteSlug,
              false,
            )
          ) {
            removed = true;
          }
        }
        // One projection rebuild for the whole batch, not one per head.
        if (removed) bumpAtlasRevision(db, attempt.finishedAt);
        db.exec("COMMIT");
        inTransaction = false;
        return { ok: true };
      } catch (error) {
        if (inTransaction) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* already rolled back */
          }
        }
        if (isBusyError(error)) return busy;
        throw error;
      }
    });
  } catch (error) {
    if (isBusyError(error)) return busy;
    throw error;
  }
}

export async function publishCapture(
  attempt: AtlasCaptureAttempt,
): Promise<AtlasPublicationResult> {
  const cache = attempt.cache;
  const pageIdValue = pageId(attempt.target.siteSlug, SOURCE_KIND, attempt.target.urlKey);
  if (!cache.atlas) {
    return {
      published: false,
      code: "ATLAS_DISABLED",
      captureIds: [],
      pageId: pageIdValue,
      regionCount: 0,
      componentCount: 0,
      claimCount: 0,
    };
  }
  if (attempt.limitations.includes("POLICY_BLOCKED")) {
    return {
      published: false,
      code: "POLICY_BLOCKED",
      captureIds: [],
      pageId: pageIdValue,
      regionCount: 0,
      componentCount: 0,
      claimCount: 0,
    };
  }
  if (attempt.status === "blocked" || attempt.status === "failed" || attempt.status === "unknown") {
    return {
      published: false,
      code: "ATTEMPT_NOT_PUBLISHABLE",
      captureIds: [],
      pageId: pageIdValue,
      regionCount: 0,
      componentCount: 0,
      claimCount: 0,
    };
  }
  const publishableViewports = attempt.viewports.filter((viewport) => viewport.claims.length > 0);
  if (publishableViewports.length === 0) {
    return {
      published: false,
      code: "NO_CLAIMS",
      captureIds: [],
      pageId: pageIdValue,
      regionCount: 0,
      componentCount: 0,
      claimCount: 0,
    };
  }
  for (const viewport of publishableViewports) {
    const components = viewport.components ?? [];
    const regionIds = [
      ...viewport.regions.map((region) => region.key),
      ...components.map((component) => component.key),
    ];
    if (new Set(regionIds).size !== regionIds.length) {
      return {
        published: false,
        code: "DUPLICATE_REGION_KEY",
        captureIds: [],
        pageId: pageIdValue,
        regionCount: 0,
        componentCount: 0,
        claimCount: 0,
      };
    }
    const usableRegions = viewport.regions.filter(
      (region) =>
        Number.isFinite(region.rect.x) &&
        Number.isFinite(region.rect.y) &&
        Number.isFinite(region.rect.width) &&
        Number.isFinite(region.rect.height) &&
        region.rect.width > 0 &&
        region.rect.height > 0,
    );
    if (usableRegions.length !== viewport.regions.length) {
      return {
        published: false,
        code: "INVALID_GEOMETRY",
        captureIds: [],
        pageId: pageIdValue,
        regionCount: 0,
        componentCount: 0,
        claimCount: 0,
      };
    }
    if (usableRegions.length === 0) {
      return {
        published: false,
        code: "NO_SECTION_REGIONS",
        captureIds: [],
        pageId: pageIdValue,
        regionCount: 0,
        componentCount: 0,
        claimCount: 0,
      };
    }
    for (const component of components) {
      if (
        !Number.isFinite(component.rect.x) ||
        !Number.isFinite(component.rect.y) ||
        !Number.isFinite(component.rect.width) ||
        !Number.isFinite(component.rect.height)
      ) {
        return {
          published: false,
          code: "INVALID_GEOMETRY",
          captureIds: [],
          pageId: pageIdValue,
          regionCount: 0,
          componentCount: 0,
          claimCount: 0,
        };
      }
    }
    const regionKeys = new Set([
      ...usableRegions.map((region) => region.key),
      ...components.map((component) => component.key),
    ]);
    for (const claim of viewport.claims) {
      if (!regionKeys.has(claim.regionKey)) {
        return {
          published: false,
          code: "CLAIM_REGION_MISSING",
          captureIds: [],
          pageId: pageIdValue,
          regionCount: 0,
          componentCount: 0,
          claimCount: 0,
        };
      }
    }
    const destination = checkAtlasRedirect(attempt.target.requestedUrl, viewport.finalUrl);
    const observed = checkAtlasRedirect(attempt.target.requestedUrl, viewport.scan.url);
    if (!destination.ok || !observed.ok) {
      return {
        published: false,
        code: "TARGET_CHANGED",
        captureIds: [],
        pageId: pageIdValue,
        regionCount: 0,
        componentCount: 0,
        claimCount: 0,
      };
    }
    for (const artifact of viewport.artifacts) {
      if (
        validateStoredArtifact(cache.rootDir, {
          storagePath: artifact.storagePath,
          sha256: artifact.sha256,
          bytes: artifact.bytes,
        }) !== null
      ) {
        const withdrawn = withdrawInvalidArtifactHeads(cache, attempt, artifact.storagePath);
        return {
          published: false,
          code: withdrawn.ok ? "ARTIFACT_INVALID" : withdrawn.code,
          captureIds: [],
          pageId: pageIdValue,
          regionCount: 0,
          componentCount: 0,
          claimCount: 0,
        };
      }
      if (
        artifact.kind === "screenshot" &&
        !isPngStoredArtifact(cache.rootDir, {
          storagePath: artifact.storagePath,
          sha256: artifact.sha256,
          bytes: artifact.bytes,
        })
      ) {
        const withdrawn = withdrawInvalidArtifactHeads(cache, attempt, artifact.storagePath);
        return {
          published: false,
          code: withdrawn.ok ? "ARTIFACT_INVALID" : withdrawn.code,
          captureIds: [],
          pageId: pageIdValue,
          regionCount: 0,
          componentCount: 0,
          claimCount: 0,
        };
      }
    }
    const componentsByKey = new Map(
      (viewport.components ?? []).map((component) => [component.key, component]),
    );
    for (const artifact of viewport.artifacts) {
      if (
        artifact.kind === "component_pack" &&
        packOwnershipMismatch(cache.rootDir, artifact, componentsByKey)
      ) {
        return {
          published: false,
          code: "PACK_OWNERSHIP_MISMATCH",
          captureIds: [],
          pageId: pageIdValue,
          regionCount: 0,
          componentCount: 0,
          claimCount: 0,
        };
      }
    }
    const artifactsByKey = new Map(viewport.artifacts.map((artifact) => [artifact.key, artifact]));
    for (const claim of viewport.claims) {
      if (
        claim.evidence.some((ref) => {
          const artifact = artifactsByKey.get(ref.artifactId);
          return artifact?.kind === "component_pack" && artifact.regionKey !== claim.regionKey;
        })
      ) {
        return {
          published: false,
          code: "PACK_OWNERSHIP_MISMATCH",
          captureIds: [],
          pageId: pageIdValue,
          regionCount: 0,
          componentCount: 0,
          claimCount: 0,
        };
      }
    }
    for (const claim of viewport.claims) {
      if (
        claim.evidence.length === 0 ||
        claim.evidence.some((ref) => {
          const artifact = artifactsByKey.get(ref.artifactId);
          return (
            !artifact ||
            !artifactPointerResolves(cache.rootDir, {
              storagePath: artifact.storagePath,
              sha256: artifact.sha256,
              bytes: artifact.bytes,
            }, ref.pointer)
          );
        })
      ) {
        return {
          published: false,
          code: "EVIDENCE_UNRESOLVED",
          captureIds: [],
          pageId: pageIdValue,
          regionCount: 0,
          componentCount: 0,
          claimCount: 0,
        };
      }
    }
  }

  try {
    return cache.withAtlasDb((db) => {
    let inTransaction = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      inTransaction = true;
      for (const viewport of publishableViewports) {
          const head = db
            .prepare(
              `SELECT MAX(
                 COALESCE(c.observed_at, 0),
                 COALESCE(c.last_confirmed_at, 0),
                 COALESCE(c.finished_at, 0),
                 COALESCE(c.source_fetched_at, 0)
               ) AS observed_at
               FROM atlas_heads h JOIN atlas_captures c ON c.id = h.capture_id
               WHERE h.page_id = ? AND h.profile_key = ?`,
            )
            .get(pageIdValue, viewport.profileKey) as { observed_at: number | null } | undefined;
          if (head?.observed_at !== null && head?.observed_at !== undefined && attempt.finishedAt < head.observed_at) {
            db.exec("ROLLBACK");
            inTransaction = false;
            return {
              published: false,
              code: "STALE_OBSERVATION",
              captureIds: [],
              pageId: pageIdValue,
              regionCount: 0,
              componentCount: 0,
              claimCount: 0,
            };
          }
        }
        db.prepare(
          `INSERT INTO atlas_pages
             (id, site_slug, kind, url_key, public_url, path, created_at)
           VALUES (?, ?, 'live_page', ?, ?, ?, ?)
           ON CONFLICT(site_slug, kind, url_key) DO UPDATE SET
             public_url = excluded.public_url,
             path = excluded.path`,
        ).run(
          pageIdValue,
          attempt.target.siteSlug,
          attempt.target.urlKey,
          attempt.target.requestedUrl,
          attempt.target.path,
          attempt.startedAt,
        );
        const captureIds: string[] = [];
        let regionCount = 0;
        let componentCount = 0;
        let claimCount = 0;
        const publishedRegionIds: Record<string, string> = {};
        let revisionChanged = false;
        let freshnessAdvanced = false;
        for (const viewport of publishableViewports) {
          const config = {
            schemaVersion: "awwwards-atlas-live-config-v1",
            viewport: viewport.viewport,
            target: attempt.target,
            states: canonicalStates(attempt.states),
            browserVersion: viewport.browserVersion,
            dpr: viewport.dpr,
            reducedMotion: viewport.reducedMotion,
            extractorVersion: EXTRACTOR_VERSION,
            classifierVersion: CLASSIFIER_VERSION,
            vocabularyVersion: ATLAS_VOCABULARY_VERSION,
          };
          const digest = sha256Text(
            JSON.stringify({
              scan: viewport.scan,
              regions: viewport.regions.map((region) => ({
                key: region.key,
                parentKey: region.parentKey,
                heading: region.heading,
                text: region.text,
                rect: region.rect,
              })),
              components: (viewport.components ?? []).map((component) => ({
                key: component.key,
                type: component.type,
                sectionKey: component.sectionKey,
                patternKey: component.patternKey,
                rect: component.rect,
              })),
              componentPacks: viewport.artifacts
                .filter((artifact) => artifact.kind === "component_pack")
                .map((artifact) => artifact.sha256),
              claims: viewport.claims.map((claim) => ({
                regionKey: claim.regionKey,
                field: claim.field,
                value: claim.value,
                decision: claim.decision,
                classification: claim.classification,
                basis: claim.basis,
                sampleKey: claim.sampleKey,
                ruleId: claim.ruleId,
                ruleVersion: claim.ruleVersion,
                evidence: claim.evidence,
              })),
              screenshots: viewport.screenshots.map((shot) => shot.sha256),
              checkpoints: viewport.artifacts
                .filter((artifact) => artifact.key.startsWith("checkpoint-"))
                .map((artifact) => artifact.sha256),
              observations: (viewport.observations ?? []).map((observation) => ({
                key: observation.key,
                scrollY: observation.scrollY,
                scrollX: observation.scrollX,
                state: observation.state,
                settleStatus: observation.settleStatus,
                coordinateSpace: observation.coordinateSpace,
                regions: observation.regions.map((region) => ({
                  key: region.key,
                  sampleKey: region.sampleKey,
                  targetRegionId: region.targetRegionId,
                  visible: region.visible,
                  coordinateSpace: region.coordinateSpace,
                  inScrollRoot: region.inScrollRoot,
                  scrollX: region.scrollX,
                  text: region.text,
                  rect: region.rect,
                })),
              })),
              coverage: viewport.coverage,
              limitations: viewport.limitations,
            }),
          );
          const capture = captureId(
            pageIdValue,
            viewport.profileKey,
            digest,
            captureConfigHash(config),
          );
          captureIds.push(capture);
          Object.assign(publishedRegionIds, stateRegionIdMap(viewport, capture));
          const existing = db
            .prepare("SELECT 1 FROM atlas_captures WHERE id = ?")
            .get(capture) !== undefined;
          if (existing) {
            const priorHead = db
              .prepare("SELECT capture_id FROM atlas_heads WHERE page_id = ? AND profile_key = ?")
              .get(pageIdValue, viewport.profileKey) as { capture_id: string } | undefined;
            const counts = refreshExistingCapture(
              db,
              attempt,
              viewport,
              capture,
              pageIdValue,
              attempt.finishedAt,
            );
            regionCount += counts.regions;
            componentCount += counts.components;
            claimCount += counts.claims;
            if (priorHead?.capture_id !== capture || counts.freshnessChanged) {
              revisionChanged = true;
            } else if (counts.freshnessAdvanced) {
              freshnessAdvanced = true;
            }
            continue;
          }
          revisionChanged = true;
          db.prepare(
            `INSERT INTO atlas_captures
               (id, attempt_id, page_id, source_kind, profile_key, config_hash, status,
                started_at, finished_at, observed_at, source_fetched_at, source_digest,
                config_json, policy_json, coverage_json, error_json, extractor_version,
                classifier_version, last_confirmed_at)
             VALUES (?, ?, ?, 'live_page', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
          ).run(
            capture,
            `${attempt.attemptId}:${viewport.profileKey}`,
            pageIdValue,
            viewport.profileKey,
            captureConfigHash(config),
            "running",
            attempt.startedAt,
            attempt.finishedAt,
            attempt.finishedAt,
            attempt.finishedAt,
            digest,
            JSON.stringify(config),
            JSON.stringify({ robots: "allowed", publicOnly: true }),
            JSON.stringify(viewport.coverage),
            EXTRACTOR_VERSION,
            CLASSIFIER_VERSION,
            attempt.finishedAt,
          );
          const artifactIds = new Map<string, string>();
          const storedCounts = storeViewport(
            db,
            attempt,
            viewport,
            capture,
            pageIdValue,
            attempt.finishedAt,
            artifactIds,
          );
          regionCount += storedCounts.regions;
          componentCount += storedCounts.components;
          db.prepare(
            "UPDATE atlas_captures SET status = ?, coverage_json = ? WHERE id = ?",
          ).run(viewport.status, JSON.stringify(viewport.coverage), capture);
          claimCount += viewport.claims.length;
        }
        if (revisionChanged) {
          // Projections are rebuilt inside this transaction so a committed
          // revision always has a matching `feature_revision`; search is read-only.
          bumpAtlasRevision(db, attempt.finishedAt);
        } else if (freshnessAdvanced) {
          // Same evidence on a later day: the in-place freshness update above
          // is already complete, so only the revision needs to move.
          bumpAtlasRevisionInPlace(db, attempt.finishedAt);
        }
      db.exec("COMMIT");
      inTransaction = false;
      return {
        published: true,
        captureIds,
        pageId: pageIdValue,
        regionCount,
        componentCount,
        claimCount,
        ...(Object.keys(publishedRegionIds).length > 0 ? { publishedRegionIds } : {}),
      };
    } catch (error) {
      if (inTransaction) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* already rolled back */
        }
      }
      return {
        published: false,
        code: isBusyError(error)
          ? "PUBLICATION_BUSY"
          : error instanceof Error
            ? error.message
            : "PUBLICATION_FAILED",
        captureIds: [],
        pageId: pageIdValue,
        regionCount: 0,
        componentCount: 0,
        claimCount: 0,
      };
    }
    });
  } catch (error) {
    if (isBusyError(error)) {
      return {
        published: false,
        code: "PUBLICATION_BUSY",
        captureIds: [],
        pageId: pageIdValue,
        regionCount: 0,
        componentCount: 0,
        claimCount: 0,
      };
    }
    throw error;
  }
}
