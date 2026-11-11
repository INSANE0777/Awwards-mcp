import type { Cache } from "../cache.js";
import { realpathSync } from "node:fs";
import type { AtlasCliCommand } from "./cli.js";
import { collectAtlasPage } from "./collector.js";
import { importLegacyAtlas } from "./import.js";
import type { ImportReport } from "./import.js";
import type {
  AtlasCaptureAttempt,
  AtlasCollectInput,
  AtlasPublicationResult,
} from "./live-types.js";
import {
  AtlasMaintenanceError,
  pruneAtlas,
  verifyAtlasArtifacts,
} from "./maintenance.js";
import type { AtlasPruneReport, AtlasVerifyReport } from "./maintenance.js";
import { reindexAtlas } from "./schema.js";
import type { AtlasReindexResult } from "./schema.js";
import { publishCapture } from "./publish.js";

export type AtlasCollectFn = (
  input: AtlasCollectInput,
  deps: { cache: Cache },
) => Promise<AtlasCaptureAttempt>;
export type AtlasPublishFn = (attempt: AtlasCaptureAttempt) => Promise<AtlasPublicationResult>;
export type AtlasImportFn = (cache: Cache, now: () => number) => Promise<ImportReport>;
export type AtlasReindexFn = (cache: Cache, now: number) => AtlasReindexResult;
export type AtlasVerifyFn = (cache: Cache) => AtlasVerifyReport;
export type AtlasPruneFn = (
  cache: Cache,
  options: { olderThanDays: number; apply: boolean; now: number },
) => Promise<AtlasPruneReport>;

export interface AtlasCliRuntime {
  cache: Cache;
  log: (line: string) => void;
  now?: () => number;
  collect?: AtlasCollectFn;
  publish?: AtlasPublishFn;
  importLegacy?: AtlasImportFn;
  reindex?: AtlasReindexFn;
  verify?: AtlasVerifyFn;
  prune?: AtlasPruneFn;
}

function escapeRedactionSegment(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redact a cache path that may appear with either separator style. The cache
 * root is the raw environment value, while Node errors usually print native
 * separators and the real (resolved) path.
 */
export function redactCachePath(value: string, cacheRoot: string): string {
  if (!cacheRoot) return value;
  const roots = new Set<string>();
  const add = (root: string): void => {
    const trimmed = root.replace(/[\\/]+$/, "");
    if (trimmed.length > 0) roots.add(trimmed);
  };
  add(cacheRoot);
  try {
    add(realpathSync(cacheRoot));
  } catch {
    /* the cache may not exist yet (init failure) */
  }
  let redacted = value;
  for (const root of roots) {
    const pattern =
      root
        .split(/[\\/]+/)
        .map(escapeRedactionSegment)
        .join("[\\\\/]+") + "(?![\\w.-])";
    redacted = redacted.replace(
      new RegExp(pattern, process.platform === "win32" ? "gi" : "g"),
      "<cache>",
    );
  }
  return redacted;
}

function messageOf(error: unknown, cacheRoot: string): string {
  return redactCachePath(error instanceof Error ? error.message : String(error), cacheRoot);
}

function errorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : fallback;
}

export async function runAtlasCommand(
  command: AtlasCliCommand,
  runtime: AtlasCliRuntime,
): Promise<number> {
  if (command.kind === "error") {
    runtime.log(`awwwards-index: ${command.message}`);
    return 2;
  }
  const { cache, log } = runtime;
  const now = runtime.now ?? Date.now;
  if (command.kind === "import") {
    try {
      const report = await (
        runtime.importLegacy ?? ((target, clock) => importLegacyAtlas(target, { now: clock }))
      )(cache, now);
      log(
        `awwwards-index: atlas import — ${report.processed} processed ` +
          `(${report.sitePages} site pages, ${report.galleryItems} gallery items), ` +
          `${report.published} published, ${report.unpublished} unpublished, ` +
          `${report.failures.length} failures`,
      );
      for (const failure of report.failures) {
        log(`awwwards-index: ${failure.slug}: ${redactCachePath(failure.error, cache.rootDir)}`);
      }
      return report.failures.length > 0 ? 1 : 0;
    } catch (error) {
      log(
        `awwwards-index: atlas import failed [${errorCode(error, "IMPORT_FAILED")}]: ` +
          messageOf(error, cache.rootDir),
      );
      return 1;
    }
  }
  if (command.kind === "capture") {
    const collect =
      runtime.collect ??
      ((input: AtlasCollectInput, deps: { cache: Cache }) => collectAtlasPage(input, deps));
    const publish = runtime.publish ?? publishCapture;
    const viewports =
      command.viewport === "both" ? (["desktop", "mobile"] as const) : [command.viewport];
    let failed = false;
    for (const viewport of viewports) {
      try {
        const attempt = await collect(
          { siteSlug: command.slug, path: command.path, viewports: [viewport] },
          { cache },
        );
        const publication = await publish(attempt);
        if (publication.published) {
          log(
            `awwwards-index: atlas capture ${viewport} — published ` +
              `${publication.captureIds.length} capture(s), ${publication.regionCount} regions, ` +
              `${publication.claimCount} claims`,
          );
        } else {
          failed = true;
          const limitations =
            attempt.limitations.length > 0 ? `, limitations: ${attempt.limitations.join(", ")}` : "";
          log(
            `awwwards-index: atlas capture ${viewport} — not published ` +
              `(${redactCachePath(publication.code ?? "UNKNOWN", cache.rootDir)}, ` +
              `status: ${attempt.status}${limitations})`,
          );
        }
      } catch (error) {
        failed = true;
        log(
          `awwwards-index: atlas capture ${viewport} failed ` +
            `[${errorCode(error, "CAPTURE_FAILED")}]: ${messageOf(error, cache.rootDir)}`,
        );
      }
    }
    return failed ? 1 : 0;
  }
  if (command.kind === "reindex") {
    try {
      const result = (
        runtime.reindex ??
        ((target: Cache, at: number) => target.withAtlasDb((db) => reindexAtlas(db, at)))
      )(cache, now());
      log(
        `awwwards-index: atlas reindex — revision ${result.revision} ` +
          `(${result.changed ? "heads/FTS repaired" : "already current"})`,
      );
      return 0;
    } catch (error) {
      log(
        `awwwards-index: atlas reindex failed [${errorCode(error, "REINDEX_FAILED")}]: ` +
          messageOf(error, cache.rootDir),
      );
      return 1;
    }
  }
  if (command.kind === "verify") {
    try {
      const report = (runtime.verify ?? verifyAtlasArtifacts)(cache);
      log(
        `awwwards-index: atlas verify — ${report.ok}/${report.checked} artifacts ok, ` +
          `${report.missing} missing, ${report.sizeMismatch} size mismatches, ` +
          `${report.hashMismatch} hash mismatches, ${report.notFile} not files, ` +
          `${report.unsafePath} unsafe paths, ${report.external} external skipped`,
      );
      for (const issue of report.issues.slice(0, 10)) {
        log(
          `awwwards-index: verify ${issue.artifactId} (${issue.kind}): ${issue.code}`,
        );
      }
      if (report.issues.length > 10) {
        log(`awwwards-index: verify ${report.issues.length - 10} more issue(s)`);
      }
      return report.issues.length > 0 ? 1 : 0;
    } catch (error) {
      log(
        `awwwards-index: atlas verify failed [${errorCode(error, "VERIFY_FAILED")}]: ` +
          messageOf(error, cache.rootDir),
      );
      return 1;
    }
  }
  try {
    const report = await (
      runtime.prune ??
      ((target: Cache, options: { olderThanDays: number; apply: boolean; now: number }) =>
        pruneAtlas(target, options))
    )(cache, { olderThanDays: command.olderThanDays, apply: command.apply, now: now() });
    const verb = command.apply ? "deleted" : "would remove";
    log(
      `awwwards-index: atlas prune — ${command.apply ? "apply" : "dry run"}: ` +
        `${report.eligible} capture(s) ${verb}, ${report.regions} regions, ` +
        `${report.claims} claims, ${report.aliases} aliases, ${report.artifacts} artifacts, ` +
        `${report.files} files (${report.bytes} bytes); protected ` +
        `${report.protectedActiveHeads} active head(s), ${report.protectedPacks} pack-pinned, ` +
        `${report.skippedRunning} running, ${report.retainedYoung} young, ` +
        `${report.skippedUnsafe} unsafe, ${report.skippedNotFile} not-file`,
    );
    if (command.apply) {
      log(
        `awwwards-index: atlas prune — ${report.deleted} capture(s) deleted, ` +
          `${report.filesDeleted} file(s) (${report.bytesDeleted} bytes) removed, ` +
          `${report.fileFailures} file failure(s), ${report.skippedUnsafe} unsafe path(s)`,
      );
    } else if (report.fileFailures > 0 || report.skippedUnsafe > 0) {
      log(
        `awwwards-index: atlas prune — ${report.fileFailures} file failure(s), ` +
          `${report.skippedUnsafe} unsafe path(s); affected evidence was left in place`,
      );
    }
    return report.fileFailures > 0 || report.skippedUnsafe > 0 ? 1 : 0;
  } catch (error) {
    const code = error instanceof AtlasMaintenanceError ? error.code : "PRUNE_FAILED";
    log(`awwwards-index: atlas prune failed [${code}]: ${messageOf(error, cache.rootDir)}`);
    return 1;
  }
}
