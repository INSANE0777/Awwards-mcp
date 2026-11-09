import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Cache } from "../cache.js";
import {
  artifactId,
  captureConfigHash,
  captureId,
  pageId,
  regionId,
  sha256Text,
  stableHash,
} from "./identity.js";
import {
  readStoredArtifactJson,
  removeArtifactFileSync,
  validateStoredArtifact,
  writeJsonArtifactSync,
} from "./artifacts.js";
import type { WrittenArtifact } from "./artifacts.js";
import { evidenceRefSchema, validatePreparedSitePage } from "./contracts.js";
import { removeHead, restoreGalleryAliases } from "./heads.js";
import { bumpAtlasRevision } from "./search-projections.js";
import { writeLegacyProjection } from "./legacy.js";
import type {
  GalleryCommitResult,
  LegacyGalleryRow,
  PreparedSitePage,
  SitePageCommitResult,
} from "./types.js";

const EXTRACTOR_VERSION = "atlas-extractor-1";
const CLASSIFIER_VERSION = "atlas-classifier-0";
const SOURCE_PROFILE = "source";
const GALLERY_PROFILE = "gallery";
const SLUG_PATTERN = /^[\w-]+$/;
const UNATTRIBUTED_SITE = ":unattributed";
const FRESHNESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function freshnessEligible(
  lastConfirmedAt: number | null,
  evaluatedAt: number,
  status: string,
): boolean {
  return (
    (status === "complete" || status === "partial") &&
    lastConfirmedAt !== null &&
    evaluatedAt - lastConfirmedAt <= FRESHNESS_WINDOW_MS
  );
}

/** RFC 6901 syntax: only ~0/~1 escapes, and JSON Pointer array indices. */
function isValidPointer(pointer: string): boolean {
  if (pointer === "") return true;
  if (!pointer.startsWith("/")) return false;
  for (const token of pointer.slice(1).split("/")) {
    for (let index = 0; index < token.length; index += 1) {
      if (token[index] !== "~") continue;
      const escaped = token[index + 1];
      if (escaped !== "0" && escaped !== "1") return false;
      index += 1;
    }
  }
  return true;
}

function decodePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolvePointer(root: unknown, pointer: string): boolean {
  if (pointer === "") return true;
  if (!isValidPointer(pointer)) return false;
  let current = root;
  for (const raw of pointer.slice(1).split("/")) {
    const token = decodePointerToken(raw);
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return false;
      const index = Number(token);
      if (index >= current.length) return false;
      current = current[index];
    } else if (typeof current === "object" && current !== null) {
      if (!Object.prototype.hasOwnProperty.call(current, token)) return false;
      current = (current as Record<string, unknown>)[token];
    } else {
      return false;
    }
  }
  return true;
}

function claimLabels(db: DatabaseSync, region: string): string {
  const rows = db
    .prepare(
      `SELECT field, value FROM atlas_claims
       WHERE region_id = ? AND decision = 'accepted' AND classification <> 'proposed'
         AND state = 'default'
       ORDER BY field, value`,
    )
    .all(region) as Array<{ field: string; value: string }>;
  return rows.map((row) => `${row.field} ${row.value}`).join(" ");
}

function captureFtsSnapshot(db: DatabaseSync, capture: string): string {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'atlas_regions_fts'")
    .get();
  if (!exists) return "[]";
  const rows = db
    .prepare(
      `SELECT region_id, title, heading, copy, labels, context
       FROM atlas_regions_fts
       WHERE region_id IN (SELECT id FROM atlas_regions WHERE capture_id = ?)
       ORDER BY region_id`,
    )
    .all(capture);
  return JSON.stringify(rows);
}

/** Validate stored artifact files and the evidence pointers that reference them. */
function validateCaptureArtifacts(
  cacheRoot: string,
  db: DatabaseSync,
  capture: string,
): boolean {
  const artifacts = db
    .prepare(
      `SELECT id, region_id, kind, storage_path, sha256, bytes, state
       FROM atlas_artifacts WHERE capture_id = ?`,
    )
    .all(capture) as Array<{
    id: string;
    region_id: string | null;
    kind: string;
    storage_path: string | null;
    sha256: string | null;
    bytes: number | null;
    state: string;
  }>;
  if (artifacts.length === 0) return false;
  if (
    !artifacts.some(
      (artifact) => artifact.kind === "source_metadata" && artifact.state === "ready",
    )
  ) {
    return false;
  }
  const bodies = new Map<string, unknown>();
  for (const artifact of artifacts) {
    if (
      artifact.state !== "ready" ||
      !artifact.storage_path ||
      !artifact.sha256 ||
      artifact.bytes === null
    ) {
      return false;
    }
    const reference = {
      storagePath: artifact.storage_path,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    };
    if (validateStoredArtifact(cacheRoot, reference) !== null) return false;
    try {
      bodies.set(artifact.id, readStoredArtifactJson(cacheRoot, reference));
    } catch {
      return false;
    }
    if (artifact.region_id) {
      const region = db
        .prepare("SELECT capture_id FROM atlas_regions WHERE id = ?")
        .get(artifact.region_id) as { capture_id: string } | undefined;
      if (!region || region.capture_id !== capture) return false;
    }
  }
  const claims = db
    .prepare(
      `SELECT c.evidence_json FROM atlas_claims c
       JOIN atlas_regions r ON r.id = c.region_id
       WHERE r.capture_id = ?`,
    )
    .all(capture) as Array<{ evidence_json: string }>;
  for (const claim of claims) {
    let evidence: unknown;
    try {
      evidence = JSON.parse(claim.evidence_json);
    } catch {
      return false;
    }
    if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 4) {
      return false;
    }
    for (const pointer of evidence) {
      const parsed = evidenceRefSchema.safeParse(pointer);
      if (!parsed.success) return false;
      const ref = parsed.data;
      if (
        !bodies.has(ref.artifactId) ||
        !resolvePointer(bodies.get(ref.artifactId), ref.pointer)
      ) {
        return false;
      }
    }
  }
  return true;
}

export interface AtlasStoreOptions {
  now?: () => number;
}

/**
 * Phase-1 Atlas writer. One item-page commit updates the legacy cache and the
 * normalized Atlas projection in a single SQLite transaction.
 */
export class AtlasStore {
  private readonly now: () => number;

  constructor(
    private readonly cache: Cache,
    options: AtlasStoreOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  async commitSitePage(
    prepared: PreparedSitePage,
    options: { atlasEnabled?: boolean } = {},
  ): Promise<SitePageCommitResult> {
    validatePreparedSitePage(prepared);
    const enabled = this.cache.atlas && (options.atlasEnabled ?? true);
    if (!enabled) {
      return {
        pageId: "",
        captureId: "",
        highlightCount: 0,
        highlightParse: prepared.highlightParse.status,
        published: false,
      };
    }

    const provenance = prepared.provenance ?? "item_page";
    const requestedPublication = prepared.publishable ?? true;
    const drift = prepared.highlightParse.status === "drift";
    const maintenancePage = !prepared.detailValid && prepared.highlights.length === 0;
    // Drift is an unconditional veto; a maintenance-only page has no usable
    // source projection either. Caller overrides can only suppress, not force.
    const publishCandidate = requestedPublication && !drift && !maintenancePage;
    const status = publishCandidate
      ? provenance === "legacy_import"
        ? "partial"
        : "complete"
      : "unknown";
    const limitations = [
      ...(provenance === "legacy_import" ? ["LEGACY_METADATA_ONLY"] : []),
      ...(prepared.limitations ?? []),
      ...(drift ? ["PARSER_DRIFT"] : []),
      ...(maintenancePage ? ["MAINTENANCE_PAGE"] : []),
      ...(!requestedPublication && !drift && !maintenancePage
        ? ["PUBLICATION_SUPPRESSED"]
        : []),
    ];

    const now = this.now();
    const page = pageId(prepared.slug, "awwwards_item", prepared.sourceUrl);
    const configHash = captureConfigHash({
      profile: SOURCE_PROFILE,
      sourceUrl: prepared.sourceUrl,
      sourceDigest: prepared.sourceDigest,
      extractorVersion: EXTRACTOR_VERSION,
      classifierVersion: CLASSIFIER_VERSION,
    });
    const capture = captureId(page, SOURCE_PROFILE, prepared.sourceDigest, configHash);
    const attemptId = randomUUID();
    const sourceFetchedAt =
      prepared.sourceFetchedAt === undefined ? prepared.fetchedAt : prepared.sourceFetchedAt;
    const artifactPayload =
      provenance === "legacy_import"
        ? {
            schemaVersion: "awwwards-atlas-legacy-metadata-v1",
            provenance,
            slug: prepared.slug,
            sourceUrl: prepared.sourceUrl,
            digestKind: "legacy_metadata",
            sourceDigest: prepared.sourceDigest,
            detail: prepared.detailValid ? prepared.detail : null,
            limitations: prepared.limitations ?? [],
            highlights: prepared.highlights.map((item) => ({
              title: item.title,
              mediaPath: item.mediaPath,
              identity: item.identity,
            })),
          }
        : {
            schemaVersion: "awwwards-atlas-source-v1",
            slug: prepared.slug,
            sourceUrl: prepared.sourceUrl,
            sourceDigest: prepared.sourceDigest,
            detailValid: prepared.detailValid,
            detail: prepared.detail,
            highlightParse: prepared.highlightParse.status,
            highlights: prepared.highlights.map((item) => ({
              title: item.title,
              mediaPath: item.mediaPath,
              identity: item.identity,
            })),
          };

    return this.cache.withAtlasDb((db) => {
      let writtenArtifact: WrittenArtifact | null = null;
      let artifactWritten = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        const head = db
          .prepare(
            `SELECT h.capture_id, h.published_at,
                    COALESCE(c.last_confirmed_at, c.source_fetched_at) AS confirmed_at,
                    c.config_json
             FROM atlas_heads h
             JOIN atlas_captures c ON c.id = h.capture_id
             WHERE h.page_id = ? AND h.profile_key = ?`,
          )
          .get(page, SOURCE_PROFILE) as
          | {
              capture_id: string;
              published_at: number;
              confirmed_at: number | null;
              config_json: string;
            }
          | undefined;
        const captureExists = db
          .prepare("SELECT 1 FROM atlas_captures WHERE id = ?")
          .get(capture) !== undefined;
        if (captureExists && !validateCaptureArtifacts(this.cache.rootDir, db, capture)) {
          // The invalid capture cannot remain active. Historical capture
          // evidence stays, but its head and projections are withdrawn.
          if (head?.capture_id === capture) {
            removeHead(db, page, SOURCE_PROFILE, now, prepared.slug);
          }
          db.exec("COMMIT");
          return {
            pageId: page,
            captureId: capture,
            highlightCount: prepared.highlights.length,
            highlightParse: prepared.highlightParse.status,
            published: false,
            artifactWritten: false,
          };
        }
        if (!captureExists) {
          // The SQLite write lock is held, so no other process can publish
          // this capture's artifact while it is written synchronously.
          writtenArtifact = writeJsonArtifactSync(this.cache.rootDir, artifactPayload);
        }
        let headProvenance = "item_page";
        if (head) {
          try {
            headProvenance = (JSON.parse(head.config_json) as { provenance?: string })
              .provenance ?? "item_page";
          } catch {
            /* malformed legacy config is treated as a live capture */
          }
        }
        const stale =
          head !== undefined &&
          head.confirmed_at !== null &&
          (sourceFetchedAt === null || sourceFetchedAt < head.confirmed_at);
        const liveDowngrade =
          head !== undefined &&
          provenance === "legacy_import" &&
          headProvenance !== "legacy_import";
        const blocked = stale || liveDowngrade;
        if (blocked && captureExists) {
          db.exec("ROLLBACK");
          if (writtenArtifact?.created) {
            this.removeOrphanArtifact(writtenArtifact.storagePath);
          }
          return {
            pageId: page,
            captureId: capture,
            highlightCount: prepared.highlights.length,
            highlightParse: prepared.highlightParse.status,
            published: false,
            artifactWritten: false,
          };
        }

        const captureStatus = blocked ? "unknown" : status;
        const captureCoverage = JSON.stringify({
          status: blocked
            ? "partial"
            : publishCandidate && provenance !== "legacy_import"
              ? "complete"
              : "partial",
          collected: prepared.highlights.length,
          excluded: 0,
          limitations: [
            ...limitations,
            ...(blocked ? ["STALE_OR_PROTECTED_OBSERVATION"] : []),
          ],
        });

        db.prepare(
          `INSERT INTO atlas_pages (id, site_slug, kind, url_key, public_url, path, created_at)
           VALUES (?, ?, 'awwwards_item', ?, ?, ?, ?)
           ON CONFLICT(site_slug, kind, url_key) DO UPDATE SET
             public_url = COALESCE(excluded.public_url, atlas_pages.public_url),
             path = COALESCE(excluded.path, atlas_pages.path)`,
        ).run(
          page,
          prepared.slug,
          prepared.sourceUrl,
          prepared.sourceUrl,
          safePath(prepared.sourceUrl),
          now,
        );

        const captureInsert = db.prepare(
          `INSERT OR IGNORE INTO atlas_captures
             (id, attempt_id, page_id, source_kind, profile_key, config_hash, status,
              started_at, finished_at, observed_at, source_fetched_at, last_confirmed_at,
              source_digest, config_json, policy_json, coverage_json, error_json,
              extractor_version, classifier_version)
           VALUES (?, ?, ?, 'awwwards_item', ?, ?, 'running', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        ).run(
          capture,
          attemptId,
          page,
          SOURCE_PROFILE,
          configHash,
          now,
          sourceFetchedAt,
          sourceFetchedAt,
          prepared.sourceDigest,
          JSON.stringify({
            source: "awwwards_item",
            sourceUrl: prepared.sourceUrl,
            provenance,
            digestKind: provenance === "legacy_import" ? "legacy_metadata" : "source_response",
            evidenceTimes: prepared.evidenceTimes ?? null,
          }),
          JSON.stringify({ status: "not_evaluated" }),
          captureCoverage,
          EXTRACTOR_VERSION,
          CLASSIFIER_VERSION,
        );
        const newCapture = captureInsert.changes > 0;

        if (newCapture && !writtenArtifact) {
          throw new Error("Atlas source artifact was not written for a new capture");
        }
        if (newCapture) {
          const artifactToInsert = writtenArtifact!;
          const artifactInsert = db
            .prepare(
              `INSERT OR IGNORE INTO atlas_artifacts
                 (id, capture_id, region_id, kind, storage_path, external_url, sha256, bytes,
                  mime_type, state, rights_json, metadata_json)
               VALUES (?, ?, NULL, 'source_metadata', ?, NULL, ?, ?, 'application/json', 'ready', ?, ?)`,
            )
            .run(
              artifactId(capture, "source_metadata", artifactToInsert.sha256),
              capture,
              artifactToInsert.storagePath,
              artifactToInsert.sha256,
              artifactToInsert.bytes,
              JSON.stringify({
                status: "unknown",
                reference: null,
                recordedAt: now,
                assertedBy: "unknown",
                scope: "local_reference",
              }),
              JSON.stringify({
                sourceUrl: prepared.sourceUrl,
                provenance,
                evidenceTimes: prepared.evidenceTimes ?? null,
              }),
            );
          artifactWritten = Number(artifactInsert.changes) > 0;
        }

        // A reused capture keeps its original evidence time and finished_at,
        // but revalidates status/coverage and advances the last-confirmed
        // observation used for freshness.
        const previousCapture = !newCapture
          ? (db
              .prepare("SELECT status, last_confirmed_at FROM atlas_captures WHERE id = ?")
              .get(capture) as { status: string; last_confirmed_at: number | null })
          : undefined;
        if (!newCapture && !blocked) {
          db.prepare(
            `UPDATE atlas_captures
             SET last_confirmed_at = CASE
                   WHEN ? IS NULL THEN last_confirmed_at
                   WHEN last_confirmed_at IS NULL OR ? > last_confirmed_at THEN ?
                   ELSE last_confirmed_at END,
                 status = ?,
                 coverage_json = ?
             WHERE id = ?`,
          ).run(
            sourceFetchedAt,
            sourceFetchedAt,
            sourceFetchedAt,
            captureStatus,
            captureCoverage,
            capture,
          );
        }

        // Legacy metadata/element refresh happens for every accepted
        // observation, including A→B→A and identical refetches. Stale or
        // live-head-protected observations skip both legacy projections.
        if (!blocked) {
          writeLegacyProjection(db, prepared, now, {
            writeMeta: provenance !== "legacy_import",
            preserveExisting: provenance === "legacy_import",
          });
        }

        const root = regionId(capture, "page", 0, "source-root");
        if (newCapture) {
          const artifact = artifactId(capture, "source_metadata", writtenArtifact!.sha256);
          db.prepare(
            `INSERT OR IGNORE INTO atlas_regions
               (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
                text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
             VALUES (?, ?, NULL, 'page', 0, NULL, NULL, '', '', NULL, NULL, ?, NULL, ?)`,
          ).run(
            root,
            capture,
            JSON.stringify({
              source: provenance === "legacy_import" ? "legacy_import" : "awwwards_item",
            }),
            captureCoverage,
          );

          const insertClaim = db.prepare(
            `INSERT OR IGNORE INTO atlas_claims
               (id, region_id, field, value, sample_key, classification, basis, decision,
                rule_id, rule_version, evidence_json, limitations_json, review_json)
             VALUES (?, ?, 'source.title', ?, ?, 'observed', 'source_title', 'accepted',
                NULL, NULL, ?, '[]', NULL)`,
          );

          prepared.highlights.forEach((item, index) => {
            const id = regionId(capture, "highlight", index, item.identity);
            db.prepare(
              `INSERT OR IGNORE INTO atlas_regions
                 (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
                  text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
               VALUES (?, ?, ?, 'highlight', ?, NULL, ?, '', '', ?, NULL, ?, NULL, ?)`,
            ).run(
              id,
              capture,
              root,
              index,
              item.identity,
              item.title || null,
              JSON.stringify({ mediaPath: item.mediaPath, title: item.title }),
              captureCoverage,
            );
            if (item.title) {
              insertClaim.run(
                stableHash(
                  "claim-v1",
                  id,
                  "source.title",
                  item.title,
                  item.mediaPath,
                  "source_title",
                ),
                id,
                item.title,
                item.mediaPath,
                JSON.stringify([
                  {
                    artifactId: artifact,
                    pointer: `/highlights/${index}/title`,
                    sampleKey: item.mediaPath.slice(0, 100),
                  },
                ]),
              );
            }
          });

          db.prepare(
            "UPDATE atlas_captures SET status = ?, finished_at = ? WHERE id = ?",
          ).run(captureStatus, now, capture);
        }

        const ftsVersion = (
          db.prepare("SELECT fts_version FROM atlas_state WHERE singleton = 1").get() as {
            fts_version: number;
          }
        ).fts_version;
        const deleteFts =
          ftsVersion > 0
            ? db.prepare(
                "DELETE FROM atlas_regions_fts WHERE region_id IN (SELECT id FROM atlas_regions WHERE capture_id = ?)",
              )
            : null;
        const insertSiteFts = (): boolean => {
          if (!(ftsVersion > 0 && deleteFts)) return false;
          const before = captureFtsSnapshot(db, capture);
          deleteFts.run(capture);
          const insertFts = db.prepare(
            "INSERT INTO atlas_regions_fts (region_id, title, heading, copy, labels, context) VALUES (?, ?, '', '', ?, ?)",
          );
          insertFts.run(root, "", "", prepared.slug);
          prepared.highlights.forEach((item, index) => {
            const id = regionId(capture, "highlight", index, item.identity);
            insertFts.run(id, item.title, claimLabels(db, id), prepared.slug);
          });
          return captureFtsSnapshot(db, capture) !== before;
        };

        const captureState = db
          .prepare("SELECT status, last_confirmed_at FROM atlas_captures WHERE id = ?")
          .get(capture) as { status: string; last_confirmed_at: number | null };
        const validStatus = captureState.status === "complete" || captureState.status === "partial";
        const wasEligibleAtPublish =
          previousCapture !== undefined && head?.capture_id === capture
            ? freshnessEligible(
                previousCapture.last_confirmed_at,
                head.published_at,
                previousCapture.status,
              )
            : false;
        const wasEligibleAtNow =
          previousCapture !== undefined && head?.capture_id === capture
            ? freshnessEligible(previousCapture.last_confirmed_at, now, previousCapture.status)
            : false;
        const isEligible = freshnessEligible(
          captureState.last_confirmed_at,
          now,
          captureState.status,
        );
        const eligibilityChanged =
          !newCapture &&
          (wasEligibleAtPublish !== isEligible || wasEligibleAtNow !== isEligible);
        const alreadyHead = head?.capture_id === capture;
        const publishCapture =
          !blocked && validStatus && (alreadyHead || publishCandidate);
        if (publishCapture) {
          const deleteAliasesForCapture = db.prepare(
            "DELETE FROM atlas_aliases WHERE region_id IN (SELECT id FROM atlas_regions WHERE capture_id = ?)",
          );

          if (alreadyHead) {
            const ftsChanged = insertSiteFts();
            db.prepare(
              "UPDATE atlas_heads SET published_at = ? WHERE page_id = ? AND profile_key = ?",
            ).run(now, page, SOURCE_PROFILE);
            if (eligibilityChanged || ftsChanged) {
              bumpAtlasRevision(db, now);
            }
          } else {
            if (head) {
              deleteAliasesForCapture.run(head.capture_id);
              if (deleteFts) deleteFts.run(head.capture_id);
            }
            deleteAliasesForCapture.run(capture);
            db.prepare(
              `INSERT INTO atlas_heads (page_id, profile_key, capture_id, published_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(page_id, profile_key) DO UPDATE SET
                 capture_id = excluded.capture_id,
                 published_at = excluded.published_at`,
            ).run(page, SOURCE_PROFILE, capture, now);
            insertSiteFts();

            bumpAtlasRevision(db, now);
          }

          writeAliases(db, prepared, page, capture);
          restoreGalleryAliases(db, prepared.slug);
        } else if (alreadyHead) {
          // Never leave an unknown/invalid capture as the active head.
          removeHead(db, page, SOURCE_PROFILE, now, prepared.slug);
        }

        db.exec("COMMIT");
        if (writtenArtifact?.created && !artifactWritten) {
          this.removeOrphanArtifact(writtenArtifact.storagePath);
        }
        return {
          pageId: page,
          captureId: capture,
          highlightCount: prepared.highlights.length,
          highlightParse: prepared.highlightParse.status,
          published: publishCapture,
          artifactWritten,
        };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* already rolled back */
        }
        if (writtenArtifact?.created) {
          this.removeOrphanArtifact(writtenArtifact.storagePath);
        }
        throw error;
      }
    });
  }

  private removeOrphanArtifact(storagePath: string): void {
    try {
      this.cache.withAtlasDb((db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const referenced = db
            .prepare("SELECT 1 FROM atlas_artifacts WHERE storage_path = ?")
            .get(storagePath);
          if (!referenced) {
            removeArtifactFileSync(this.cache.rootDir, storagePath);
          }
          db.exec("COMMIT");
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* already rolled back */
          }
          throw error;
        }
      });
    } catch {
      /* orphan cleanup is best-effort; never mask the commit error */
    }
  }

  async commitLegacyGallery(row: LegacyGalleryRow): Promise<GalleryCommitResult> {
    if (!this.cache.atlas) {
      return { pageId: "", captureId: "", published: false };
    }
    if (!SLUG_PATTERN.test(row.slug) || !row.mediaPath) {
      throw new Error("invalid legacy gallery row");
    }
    const ownedSiteSlug =
      row.siteSlug && SLUG_PATTERN.test(row.siteSlug) ? row.siteSlug : null;
    const siteSlug = ownedSiteSlug ?? UNATTRIBUTED_SITE;
    const sourceUrl = `https://www.awwwards.com/inspiration/${row.slug}`;
    const urlKey = `inspiration:${row.slug}`;
    const page = pageId(siteSlug, "legacy_gallery", urlKey);
    const digest = sha256Text(
      JSON.stringify({
        slug: row.slug,
        title: row.title,
        siteSlug: ownedSiteSlug,
        ownership: ownedSiteSlug ? "explicit" : "unknown",
        author: row.author,
        mediaPath: row.mediaPath,
        mediaType: row.mediaType,
      }),
    );
    const configHash = captureConfigHash({
      profile: GALLERY_PROFILE,
      sourceUrl,
      sourceDigest: digest,
      extractorVersion: EXTRACTOR_VERSION,
      classifierVersion: CLASSIFIER_VERSION,
    });
    const capture = captureId(page, GALLERY_PROFILE, digest, configHash);
    const now = this.now();
    const attemptId = randomUUID();
    const coverage = JSON.stringify({
      status: "partial",
      collected: 1,
      excluded: 0,
      limitations: [
        "LEGACY_METADATA_ONLY",
        ...(row.fetchedAt === null ? ["MISSING_TIMESTAMP"] : []),
      ],
    });
    const galleryIdentity = stableHash(
      "gallery-v1",
      ownedSiteSlug ?? UNATTRIBUTED_SITE,
      row.mediaPath,
    );
    const galleryPayload = {
      schemaVersion: "awwwards-atlas-legacy-gallery-v1",
      provenance: "legacy_import",
      digestKind: "legacy_metadata",
      sourceUrl,
      gallery: {
        slug: row.slug,
        title: row.title,
        siteSlug: row.siteSlug,
        ownership: ownedSiteSlug ? "explicit" : "unknown",
        author: row.author,
        mediaPath: row.mediaPath,
        mediaType: row.mediaType,
      },
    };
    return this.cache.withAtlasDb((db) => {
      let writtenArtifact: WrittenArtifact | null = null;
      let artifactWritten = false;
      let previousCapture: { status: string; last_confirmed_at: number | null } | undefined;
      try {
        db.exec("BEGIN IMMEDIATE");
        const preflightCaptureExists = db
          .prepare("SELECT 1 FROM atlas_captures WHERE id = ?")
          .get(capture) !== undefined;
        if (preflightCaptureExists && !validateCaptureArtifacts(this.cache.rootDir, db, capture)) {
          const galleryHead = db
            .prepare("SELECT capture_id FROM atlas_heads WHERE page_id = ? AND profile_key = ?")
            .get(page, GALLERY_PROFILE) as { capture_id: string } | undefined;
          if (galleryHead?.capture_id === capture) {
            removeHead(db, page, GALLERY_PROFILE, now);
          }
          db.exec("COMMIT");
          return { pageId: page, captureId: capture, published: false };
        }
        if (!preflightCaptureExists) {
          writtenArtifact = writeJsonArtifactSync(this.cache.rootDir, galleryPayload);
        }
        const priorHead = db
          .prepare(
            `SELECT h.capture_id, h.published_at,
                    COALESCE(c.last_confirmed_at, c.source_fetched_at) AS confirmed_at
             FROM atlas_heads h
             JOIN atlas_captures c ON c.id = h.capture_id
             WHERE h.page_id = ? AND h.profile_key = ?`,
          )
          .get(page, GALLERY_PROFILE) as
          | { capture_id: string; published_at: number; confirmed_at: number | null }
          | undefined;
        const latest = db
          .prepare(
            `SELECT MAX(COALESCE(c.last_confirmed_at, c.source_fetched_at)) AS latest
             FROM atlas_heads h
             JOIN atlas_captures c ON c.id = h.capture_id
             JOIN atlas_pages p ON p.id = h.page_id
             WHERE p.kind = 'legacy_gallery' AND p.url_key = ?`,
          )
          .get(urlKey) as { latest: number | null };
        // Compare against every active head for this gallery URL, not just the
        // incoming owner's page; a stale owner must never retire newer evidence.
        if (
          latest.latest !== null &&
          (row.fetchedAt === null || row.fetchedAt < latest.latest)
        ) {
          db.exec("ROLLBACK");
          if (writtenArtifact?.created) {
            this.removeOrphanArtifact(writtenArtifact.storagePath);
          }
          return { pageId: page, captureId: capture, published: false };
        }

        db.prepare(
          `INSERT INTO atlas_pages (id, site_slug, kind, url_key, public_url, path, created_at)
           VALUES (?, ?, 'legacy_gallery', ?, ?, ?, ?)
           ON CONFLICT(site_slug, kind, url_key) DO UPDATE SET
             public_url = COALESCE(excluded.public_url, atlas_pages.public_url),
             path = COALESCE(excluded.path, atlas_pages.path)`,
        ).run(page, siteSlug, urlKey, sourceUrl, `/inspiration/${row.slug}`, now);

        const captureInsert = db.prepare(
          `INSERT OR IGNORE INTO atlas_captures
             (id, attempt_id, page_id, source_kind, profile_key, config_hash, status,
              started_at, finished_at, observed_at, source_fetched_at, last_confirmed_at,
              source_digest, config_json, policy_json, coverage_json, error_json,
              extractor_version, classifier_version)
           VALUES (?, ?, ?, 'legacy_gallery', ?, ?, 'running', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        ).run(
          capture,
          attemptId,
          page,
          GALLERY_PROFILE,
          configHash,
          now,
          row.fetchedAt,
          row.fetchedAt,
          digest,
          JSON.stringify({
            source: "legacy_gallery",
            sourceUrl,
            provenance: "legacy_import",
            digestKind: "legacy_metadata",
          }),
          JSON.stringify({ status: "not_evaluated" }),
          coverage,
          EXTRACTOR_VERSION,
          CLASSIFIER_VERSION,
        );
        const newCapture = captureInsert.changes > 0;
        if (newCapture && !writtenArtifact) {
          throw new Error("Atlas gallery artifact was not written for a new capture");
        }

        const root = regionId(capture, "page", 0, "gallery-root");
        const component = regionId(capture, "component", 0, galleryIdentity);
        if (newCapture && writtenArtifact) {
          const artifact = artifactId(capture, "source_metadata", writtenArtifact.sha256);
          const artifactInsert = db.prepare(
            `INSERT OR IGNORE INTO atlas_artifacts
               (id, capture_id, region_id, kind, storage_path, external_url, sha256, bytes,
                mime_type, state, rights_json, metadata_json)
             VALUES (?, ?, NULL, 'source_metadata', ?, NULL, ?, ?, 'application/json', 'ready', ?, ?)`,
          ).run(
            artifact,
            capture,
            writtenArtifact.storagePath,
            writtenArtifact.sha256,
            writtenArtifact.bytes,
            JSON.stringify({
              status: "unknown",
              reference: null,
              recordedAt: now,
              assertedBy: "unknown",
              scope: "local_reference",
            }),
            JSON.stringify({ sourceUrl, provenance: "legacy_import" }),
          );
          artifactWritten = Number(artifactInsert.changes) > 0;

          db.prepare(
            `INSERT INTO atlas_regions
               (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
                text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
             VALUES (?, ?, NULL, 'page', 0, NULL, NULL, '', '', NULL, NULL, ?, NULL, ?)`,
          ).run(root, capture, JSON.stringify({ source: "legacy_gallery" }), coverage);
          db.prepare(
            `INSERT INTO atlas_regions
               (id, capture_id, parent_id, kind, ordinal, locator_json, fingerprint, heading,
                text_excerpt, raw_title, primary_label, samples_json, pattern_key, coverage_json)
             VALUES (?, ?, ?, 'component', 0, NULL, ?, '', ?, ?, NULL, ?, NULL, ?)`,
          ).run(
            component,
            capture,
            root,
            galleryIdentity,
            row.title,
            row.title || null,
            JSON.stringify({
              mediaPath: row.mediaPath,
              title: row.title,
              author: row.author,
              gallerySlug: row.slug,
            }),
            coverage,
          );

          if (row.title) {
            db.prepare(
              `INSERT OR IGNORE INTO atlas_claims
                 (id, region_id, field, value, sample_key, classification, basis, decision,
                  rule_id, rule_version, evidence_json, limitations_json, review_json)
               VALUES (?, ?, 'source.title', ?, ?, 'observed', 'source_metadata', 'candidate',
                  NULL, NULL, ?, '[]', NULL)`,
            ).run(
              stableHash(
                "claim-v1",
                component,
                "source.title",
                row.title,
                row.mediaPath,
                "source_metadata",
              ),
              component,
              row.title,
              row.mediaPath,
              JSON.stringify([
                {
                  artifactId: artifact,
                  pointer: "/gallery/title",
                  sampleKey: row.mediaPath.slice(0, 100),
                },
              ]),
            );
          }

          db.prepare(
            "UPDATE atlas_captures SET status = 'partial', finished_at = ? WHERE id = ?",
          ).run(now, capture);
        } else if (!newCapture) {
          previousCapture = db
            .prepare("SELECT status, last_confirmed_at FROM atlas_captures WHERE id = ?")
            .get(capture) as { status: string; last_confirmed_at: number | null };
          db.prepare(
            `UPDATE atlas_captures
             SET last_confirmed_at = CASE
               WHEN ? IS NULL THEN last_confirmed_at
               WHEN last_confirmed_at IS NULL OR ? > last_confirmed_at THEN ?
               ELSE last_confirmed_at END
             WHERE id = ?`,
          ).run(row.fetchedAt, row.fetchedAt, row.fetchedAt, capture);
        }

        const ftsVersion = (
          db.prepare("SELECT fts_version FROM atlas_state WHERE singleton = 1").get() as {
            fts_version: number;
          }
        ).fts_version;
        const deleteFts =
          ftsVersion > 0
            ? db.prepare(
                "DELETE FROM atlas_regions_fts WHERE region_id IN (SELECT id FROM atlas_regions WHERE capture_id = ?)",
              )
            : null;
        const insertGalleryFts = (): boolean => {
          if (!(ftsVersion > 0 && deleteFts)) return false;
          const before = captureFtsSnapshot(db, capture);
          deleteFts.run(capture);
          const insertFts = db.prepare(
            "INSERT INTO atlas_regions_fts (region_id, title, heading, copy, labels, context) VALUES (?, ?, '', ?, ?, ?)",
          );
          insertFts.run(root, "", "", "", siteSlug);
          insertFts.run(
            component,
            row.title,
            row.title,
            claimLabels(db, component),
            siteSlug,
          );
          return captureFtsSnapshot(db, capture) !== before;
        };
        const writeGalleryAlias = () => {
          const highlighted = ownedSiteSlug
            ? (db
                .prepare(
                  `SELECT r.id FROM atlas_regions r
                   JOIN atlas_captures c ON c.id = r.capture_id
                   JOIN atlas_pages p ON p.id = c.page_id
                   JOIN atlas_heads h
                     ON h.capture_id = c.id AND h.page_id = c.page_id
                    AND h.profile_key = c.profile_key
                   WHERE p.site_slug = ? AND r.kind = 'highlight'
                     AND json_extract(r.samples_json, '$.mediaPath') = ?
                   ORDER BY r.id`,
                )
                .all(ownedSiteSlug, row.mediaPath) as Array<{ id: string }>)
            : [];
          const aliasTarget = highlighted.length === 1 ? highlighted[0]!.id : component;
          // A gallery slug identifies one logical item; changing its media
          // must never leave the previous highlight/component alias behind.
          db.prepare(
            "DELETE FROM atlas_aliases WHERE alias_kind = 'legacy_gallery_slug' AND alias = ?",
          ).run(row.slug);
          db.prepare(
            "INSERT OR IGNORE INTO atlas_aliases (alias_kind, alias, region_id) VALUES (?, ?, ?)",
          ).run("legacy_gallery_slug", row.slug, aliasTarget);
        };

        const captureState = db
          .prepare("SELECT status, last_confirmed_at FROM atlas_captures WHERE id = ?")
          .get(capture) as { status: string; last_confirmed_at: number | null };
        const validStatus =
          captureState.status === "complete" || captureState.status === "partial";
        const wasEligibleAtPublish =
          previousCapture !== undefined && priorHead?.capture_id === capture
            ? freshnessEligible(
                previousCapture.last_confirmed_at,
                priorHead.published_at,
                previousCapture.status,
              )
            : false;
        const wasEligibleAtNow =
          previousCapture !== undefined && priorHead?.capture_id === capture
            ? freshnessEligible(previousCapture.last_confirmed_at, now, previousCapture.status)
            : false;
        const isEligible = freshnessEligible(
          captureState.last_confirmed_at,
          now,
          captureState.status,
        );
        const eligibilityChanged =
          !newCapture &&
          (wasEligibleAtPublish !== isEligible || wasEligibleAtNow !== isEligible);
        const alreadyHead = priorHead?.capture_id === capture;
        let retiredOtherHeads = false;
        if (validStatus) {
          const others = db
            .prepare(
              `SELECT h.page_id, h.profile_key
               FROM atlas_heads h
               JOIN atlas_pages p ON p.id = h.page_id
               WHERE p.kind = 'legacy_gallery' AND p.url_key = ? AND h.page_id <> ?`,
            )
            .all(urlKey, page) as Array<{ page_id: string; profile_key: string }>;
          for (const other of others) {
            if (removeHead(db, other.page_id, other.profile_key, now, undefined, false)) {
              retiredOtherHeads = true;
            }
          }
        }
        if (validStatus && alreadyHead) {
          const ftsChanged = insertGalleryFts();
          db.prepare(
            "UPDATE atlas_heads SET published_at = ? WHERE page_id = ? AND profile_key = ?",
          ).run(now, page, GALLERY_PROFILE);
          writeGalleryAlias();
          if (eligibilityChanged || ftsChanged || retiredOtherHeads) {
            bumpAtlasRevision(db, now);
          }
        } else if (validStatus) {
          const deleteAliasesForCapture = db.prepare(
            "DELETE FROM atlas_aliases WHERE region_id IN (SELECT id FROM atlas_regions WHERE capture_id = ?)",
          );
          if (priorHead) {
            deleteAliasesForCapture.run(priorHead.capture_id);
            if (deleteFts) deleteFts.run(priorHead.capture_id);
          }
          deleteAliasesForCapture.run(capture);
          if (deleteFts) deleteFts.run(capture);

          db.prepare(
            `INSERT INTO atlas_heads (page_id, profile_key, capture_id, published_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(page_id, profile_key) DO UPDATE SET
               capture_id = excluded.capture_id,
               published_at = excluded.published_at`,
          ).run(page, GALLERY_PROFILE, capture, now);
          insertGalleryFts();
          writeGalleryAlias();

          bumpAtlasRevision(db, now);
        } else if (alreadyHead) {
          removeHead(db, page, GALLERY_PROFILE, now);
        }

        db.exec("COMMIT");
        if (writtenArtifact?.created && !artifactWritten) {
          this.removeOrphanArtifact(writtenArtifact.storagePath);
        }
        return {
          pageId: page,
          captureId: capture,
          published: validStatus,
          artifactWritten,
        };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* already rolled back */
        }
        if (writtenArtifact?.created) {
          this.removeOrphanArtifact(writtenArtifact.storagePath);
        }
        throw error;
      }
    });
  }
}

/** Re-points legacy slugs at the active capture so refetches stay unambiguous. */
function writeAliases(
  db: DatabaseSync,
  prepared: PreparedSitePage,
  page: string,
  capture: string,
): void {
  const legacyRows = db.prepare(
    `SELECT slug, source FROM elements
     WHERE siteSlug = ? AND mediaPath = ?
     ORDER BY source ASC, slug ASC`,
  );
  const deleteAlias = db.prepare(
    "DELETE FROM atlas_aliases WHERE alias_kind = ? AND alias = ?",
  );
  const insertAlias = db.prepare(
    "INSERT OR IGNORE INTO atlas_aliases (alias_kind, alias, region_id) VALUES (?, ?, ?)",
  );

  const deletePageAliases = db.prepare(
    `DELETE FROM atlas_aliases
     WHERE region_id IN (
       SELECT r.id FROM atlas_regions r
       JOIN atlas_captures c ON c.id = r.capture_id
       WHERE c.page_id = ?
     )`,
  );
  deletePageAliases.run(page);

  prepared.highlights.forEach((item, index) => {
    const region = regionId(capture, "highlight", index, item.identity);
    const rows = legacyRows.all(prepared.slug, item.mediaPath) as Array<{
      slug: string;
      source: string;
    }>;
    for (const row of rows) {
      const aliasKind =
        row.source === "site" ? "legacy_element_slug" : "legacy_gallery_slug";
      // The slug has exactly one current owner/media mapping; retire stale
      // targets on other pages before inserting the current one.
      deleteAlias.run(aliasKind, row.slug);
      insertAlias.run(aliasKind, row.slug, region);
    }
  });
}

function safePath(sourceUrl: string): string | null {
  try {
    const url = new URL(sourceUrl);
    return url.pathname || "/";
  } catch {
    return null;
  }
}
