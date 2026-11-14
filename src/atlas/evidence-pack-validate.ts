import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { rightsRecordSchema } from "./contracts.js";
import { ATLAS_FTS_VERSION, ATLAS_SCHEMA_VERSION } from "./schema.js";
import { ATLAS_VOCABULARY_VERSION } from "./vocabulary.js";
import {
  ATLAS_CLASSIFIER_VERSION,
  ATLAS_LIVE_CLASSIFIER_VERSION,
  ATLAS_LIVE_EXTRACTOR_VERSION,
  ATLAS_STORE_CLASSIFIER_VERSION,
  ATLAS_STORE_EXTRACTOR_VERSION,
} from "./versions.js";
import {
  EVIDENCE_DESIGN_SCHEMA_VERSION,
  EVIDENCE_PACK_ATTRIBUTION,
  EVIDENCE_PACK_EXPORTER_VERSION,
  EVIDENCE_PACK_SCHEMA_VERSION,
  EVIDENCE_SELECTION_SCHEMA_VERSION,
  MAX_COPIED_ARTIFACT_BYTES,
  MAX_COPIED_ARTIFACTS,
  MAX_COPIED_TOTAL_BYTES,
  MAX_DESIGN_EVIDENCE_BYTES,
  MAX_DESIGN_MD_BYTES,
  MAX_SELECTION_BYTES,
  MAX_TEXT_DOCUMENT_BYTES,
  REQUIRED_DESIGN_SECTIONS,
  REQUIRED_PACK_FILES,
  STYLE_FIELDS,
  evidenceFileMime,
  supportedExporterVersion,
  type EvidenceSelection,
  type MediaDecision,
  type PackArtifactRef,
  type PackCapture,
  type PackClaim,
  type PackComponentSummary,
  type PackExporterVersion,
  type PackOmission,
  type PackRegion,
  type PackSectionSummary,
  type PackValidation,
  type PackValidationIssue,
} from "./evidence-pack-types.js";
import { evidencePackId, type PackIdentityInput } from "./evidence-pack-id.js";
import {
  buildTokens,
  codeText,
  copiedArtifactPath,
  deriveComponentSummaries,
  deriveSectionSummaries,
  omittedValues,
  packCoverage,
  renderGeneratedDocuments,
  renderSelectionArtifact,
  tokenCssValue,
} from "./evidence-pack-render.js";

const MANIFEST = "manifest.json";
const SELECTION = "artifacts/selection.json";
/** No valid pack manifest can describe more than this. */
const MAX_MANIFEST_BYTES = 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const CLAIM_ID = /^claim-[a-f0-9]{16}$/;
const TOKEN_NAME = /^--atlas-[a-z-]+-\d+$/;
const PLACEHOLDER = /\{\{|\}\}|\bREPLACE_ME\b|\blorem ipsum\b|\bTBD:|\bTODO:/i;
const EXTRACTOR_VERSIONS = new Set([
  ATLAS_LIVE_EXTRACTOR_VERSION,
  ATLAS_STORE_EXTRACTOR_VERSION,
]);
const CAPTURE_CLASSIFIER_VERSIONS = new Set([
  ATLAS_LIVE_CLASSIFIER_VERSION,
  ATLAS_STORE_CLASSIFIER_VERSION,
]);
const TOKEN_PROPERTIES = new Set([
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "gap",
  "padding",
  "border-radius",
  "display",
]);
const STYLE_PROPERTY = new Map<string, string>(STYLE_FIELDS.map(([field, property]) => [field, property]));
const CAPTURE_VIEWPORTS = new Set(["desktop", "mobile", "unknown"]);
const MAX_BROWSER_VERSION_LENGTH = 200;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function stripFences(text: string): string {
  const out: string[] = [];
  let marker: string | null = null;
  for (const line of text.split("\n")) {
    if (marker) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === marker[0] && close[1].length >= marker.length) {
        marker = null;
      }
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open) {
      marker = open[1];
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function safeRelativePath(path: string): boolean {
  if (!path || path.includes("\u0000") || isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) {
    return false;
  }
  const parts = path.replaceAll("\\", "/").split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** RFC 6901 resolution; `undefined` means the pointer did not resolve. */
function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;
  let node: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    for (let index = 0; index < raw.length; index += 1) {
      if (raw[index] === "~") {
        const escaped = raw[index + 1];
        if (escaped !== "0" && escaped !== "1") return undefined;
        index += 1;
      }
    }
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return undefined;
      const item = node[Number(token)];
      if (item === undefined && Number(token) >= node.length) return undefined;
      node = item;
    } else if (typeof node === "object" && node !== null) {
      if (!Object.prototype.hasOwnProperty.call(node, token)) return undefined;
      node = (node as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return node;
}

function jsonValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectsOf(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => jsonValue(entry))
    : [];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableNumber(value: unknown): boolean {
  return value === null || isFiniteNumber(value);
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isNullableTimestamp(value: unknown): boolean {
  return (
    value === null ||
    (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_TIMESTAMP_MS)
  );
}

/**
 * Nested capture provenance constraints. A capture record that a pack prints
 * must describe a real observation: a known viewport, a bounded browser string,
 * a positive DPR, integer evidence dates and hashes rather than free-form data.
 */
function captureRecordProblem(capture: Record<string, unknown>): string | null {
  if (typeof capture.viewport !== "string" || !CAPTURE_VIEWPORTS.has(capture.viewport)) {
    return "viewport";
  }
  if (
    capture.browserVersion !== null &&
    (typeof capture.browserVersion !== "string" ||
      capture.browserVersion.length > MAX_BROWSER_VERSION_LENGTH)
  ) {
    return "browserVersion";
  }
  if (capture.dpr !== null && !(isFiniteNumber(capture.dpr) && capture.dpr > 0)) {
    return "dpr";
  }
  for (const field of ["observedAt", "sourceFetchedAt", "lastConfirmedAt", "finishedAt"]) {
    if (!isNullableTimestamp(capture[field])) return field;
  }
  if (typeof capture.configHash !== "string" || !HASH.test(capture.configHash)) {
    return "configHash";
  }
  if (
    capture.sourceDigest !== null &&
    (typeof capture.sourceDigest !== "string" || !HASH.test(capture.sourceDigest))
  ) {
    return "sourceDigest";
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isSafeSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function normalizedCodeValue(value: unknown): string {
  return codeText(String(value));
}

function qualifyingRights(value: unknown): boolean {
  return (
    jsonValue(value) &&
    (value.status === "owned" ||
      value.status === "licensed" ||
      value.status === "permission") &&
    value.scope === "export_copy" &&
    typeof value.reference === "string" &&
    value.reference.trim() !== ""
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Set equality including multiplicity; duplicates must not mask a mismatch. */
function sameMultiset(left: string[], right: string[]): boolean {
  const canonical = (values: string[]): string[] => [...values].sort();
  const a = canonical(left);
  const b = canonical(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Key-order-insensitive serialization: a reserialized object with the same
 * members compares equal, so validity never depends on key order.
 */
export function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) => {
      if (!jsonValue(item)) return item;
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, item[key]]),
      );
    }) ?? "null"
  );
}

/** Order-insensitive equality for JSON records, duplicate-sensitive. */
function sameJsonSet(left: unknown[], right: unknown[]): boolean {
  const canonical = (values: unknown[]): string[] => values.map(canonicalJson).sort();
  const a = canonical(left);
  const b = canonical(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Builder cap that produced a pack path; applied before the file is read. */
function packFileLimit(relativePath: string): number {
  if (relativePath === MANIFEST) return MAX_MANIFEST_BYTES;
  if (relativePath === SELECTION) return MAX_SELECTION_BYTES;
  if (relativePath === "DESIGN.md") return MAX_DESIGN_MD_BYTES;
  if (relativePath === "design-evidence.json") return MAX_DESIGN_EVIDENCE_BYTES;
  if (relativePath.startsWith("artifacts/")) return MAX_COPIED_ARTIFACT_BYTES;
  return MAX_TEXT_DOCUMENT_BYTES;
}

/** Placeholder markers are prose-only: generated URLs and observed values are code spans. */
function placeholderScanText(text: string): string {
  return stripFences(text).replace(/`[^`\n]*`/g, "");
}

function selectionFromArtifact(selection: Record<string, unknown>): EvidenceSelection | null {
  if (
    !isNonEmptyString(selection.packId) ||
    !isNonEmptyString(selection.siteSlug) ||
    !isNonEmptyString(selection.goal) ||
    (selection.inclusionMode !== "references" && selection.inclusionMode !== "permitted") ||
    !jsonValue(selection.tokens) ||
    !isCoverage(selection.coverage) ||
    !isStringArray(selection.limitations) ||
    !isStringArray(selection.sourceUrls)
  ) {
    return null;
  }
  return {
    packId: selection.packId,
    siteSlug: selection.siteSlug,
    goal: selection.goal,
    inclusionMode: selection.inclusionMode,
    captures: objectsOf(selection.captures) as unknown as PackCapture[],
    regions: objectsOf(selection.regions) as unknown as PackRegion[],
    claims: objectsOf(selection.claims) as unknown as PackClaim[],
    tokens: selection.tokens as unknown as EvidenceSelection["tokens"],
    sections: objectsOf(selection.sections) as unknown as PackSectionSummary[],
    components: objectsOf(selection.components) as unknown as PackComponentSummary[],
    references: objectsOf(selection.references) as unknown as PackArtifactRef[],
    mediaCandidates: [],
    media: objectsOf(selection.media) as unknown as MediaDecision[],
    omitted: objectsOf(selection.omitted) as unknown as PackOmission[],
    coverage: selection.coverage as unknown as EvidenceSelection["coverage"],
    limitations: selection.limitations,
    rightsAssertions: objectsOf(
      selection.rightsAssertions,
    ) as unknown as EvidenceSelection["rightsAssertions"],
    sourceUrls: selection.sourceUrls,
  };
}

function isCoverage(value: unknown): boolean {
  return (
    jsonValue(value) &&
    (value.status === "complete" || value.status === "partial" || value.status === "unknown") &&
    isFiniteNumber(value.collected) &&
    isFiniteNumber(value.excluded) &&
    isStringArray(value.limitations)
  );
}

function validateDesignMaterials(
  design: string,
  claims: Array<Record<string, unknown>>,
  tokens: unknown,
  fail: (code: string, message: string, issuePath?: string) => void,
): void {
  const claimFor = (
    property: string,
    value: string,
    regionId?: string,
  ): Record<string, unknown> | undefined =>
    claims.find(
      (claim) =>
        claim.property === property &&
        normalizedCodeValue(claim.value) === value &&
        (regionId === undefined || claim.sourceRegionId === regionId),
    );
  const requireClaim = (property: string, value: string, context: string, regionId?: string): void => {
    if (!claimFor(property, value, regionId)) {
      fail(
        "UNCLAIMED_DESIGN_VALUE",
        `DESIGN.md ${context} value has no matching claim: ${value}`,
        "DESIGN.md",
      );
    }
  };
  const knownTokens = new Set<string>();
  if (jsonValue(tokens)) {
    const typography = jsonValue(tokens.typography) ? tokens.typography : {};
    const spacing = jsonValue(tokens.spacing) ? tokens.spacing : {};
    for (const family of [
      tokens.colors,
      typography.fontFamily,
      typography.fontSize,
      typography.fontWeight,
      typography.lineHeight,
      spacing.gap,
      spacing.padding,
      tokens.radii,
      tokens.display,
    ]) {
      for (const entry of Array.isArray(family) ? family : []) {
        if (jsonValue(entry) && typeof entry.name === "string") knownTokens.add(entry.name);
      }
    }
  }
  const typographyProperties: Record<string, string> = {
    "Font family": "font-family",
    "Font size": "font-size",
    "Font weight": "font-weight",
    "Line height": "line-height",
  };
  let section = "";
  for (const line of design.split("\n")) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      section = heading[1]!;
      continue;
    }
    if (/(?:box-shadow|text-shadow|drop-shadow|z-index)\s*:/i.test(line)) {
      fail(
        "UNCLAIMED_DESIGN_VALUE",
        "DESIGN.md declares an elevation value with no evidence claim",
        "DESIGN.md",
      );
    }
    for (const token of line.matchAll(/--atlas-[a-z-]+-\d+/g)) {
      if (!knownTokens.has(token[0])) {
        fail(
          "UNCLAIMED_DESIGN_VALUE",
          `DESIGN.md references an unknown generated token: ${token[0]}`,
          "DESIGN.md",
        );
      }
    }
    if (section === "Colors") {
      const match = /^- `([^`]+)` — observed section background/.exec(line);
      if (match) requireClaim("background-color", match[1]!, "background color");
    } else if (section === "Typography") {
      const match = /^- ([^:]+): `([^`]+)`/.exec(line);
      const property = match ? typographyProperties[match[1]!] : undefined;
      if (match && property) requireClaim(property, match[2]!, match[1]!);
    } else if (section === "Shapes") {
      const match = /^- Border radius `([^`]+)`/.exec(line);
      if (match) requireClaim("border-radius", match[1]!, "border radius");
    } else if (section === "Layout") {
      const sectionLine = /Section `([a-f0-9]{64})`/.exec(line);
      const geometry = /(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?) at \(([-\d.]+), ([-\d.]+)\)/.exec(line);
      if (sectionLine && geometry) {
        const regionId = sectionLine[1]!;
        for (const [property, value] of [
          ["width", geometry[1]!],
          ["height", geometry[2]!],
          ["x", geometry[3]!],
          ["y", geometry[4]!],
        ] as const) {
          requireClaim(property, value, "geometry", regionId);
        }
      }
      const background = /background `([^`]+)`/.exec(line);
      if (sectionLine && background) {
        requireClaim("background-color", background[1]!, "background color", sectionLine[1]!);
      }
      const componentLine = /^- Component `([a-f0-9]{64})`:/.exec(line);
      if (componentLine) {
        for (const pair of line.matchAll(/(\w+) `([^`]+)`/g)) {
          const property = STYLE_PROPERTY.get(pair[1]!);
          if (property) {
            requireClaim(property, pair[2]!, `component ${pair[1]}`, componentLine[1]!);
          }
        }
      }
    } else if (section === "Components") {
      const componentLine = /^- `([a-f0-9]{64})` — type `([^`]+)`/.exec(line);
      if (componentLine) {
        const regionId = componentLine[1]!;
        for (const pair of line.matchAll(/(\w+) `([^`]+)`/g)) {
          const property = STYLE_PROPERTY.get(pair[1]!);
          if (property) {
            requireClaim(property, pair[2]!, `component ${pair[1]}`, regionId);
          }
        }
      }
    }
  }
}

export function validateEvidencePack(path: string): PackValidation {
  const errors: PackValidationIssue[] = [];
  const warnings: string[] = [];
  let packId: string | null = null;
  // A pack is validated with the renderer rules of the export that produced
  // it, never the current rules; unsupported versions fail closed below.
  let exporterVersion: PackExporterVersion = EVIDENCE_PACK_EXPORTER_VERSION;
  const fail = (code: string, message: string, issuePath?: string): void => {
    errors.push({ code, message, ...(issuePath ? { path: issuePath } : {}) });
  };

  let packDir: string;
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return {
        ok: false,
        packId: null,
        errors: [{ code: "PACK_NOT_DIRECTORY", message: "pack path is not a directory" }],
        warnings,
      };
    }
    packDir = realpathSync(path);
  } catch {
    return {
      ok: false,
      packId: null,
      errors: [{ code: "PACK_NOT_FOUND", message: "pack directory does not exist" }],
      warnings,
    };
  }

  const readRegular = (
    relativePath: string,
    code: string,
    limit = packFileLimit(relativePath),
  ): Buffer | null => {
    if (!safeRelativePath(relativePath)) {
      fail("PATH_TRAVERSAL", `path escapes the pack: ${relativePath}`, relativePath);
      return null;
    }
    const target = resolve(packDir, relativePath);
    if (!inside(packDir, target)) {
      fail("PATH_TRAVERSAL", `path escapes the pack: ${relativePath}`, relativePath);
      return null;
    }
    try {
      const info = lstatSync(target);
      if (info.isSymbolicLink()) {
        fail("SYMLINK_REFUSED", `symbolic link is not allowed: ${relativePath}`, relativePath);
        return null;
      }
      if (!info.isFile()) {
        fail(code, `not a regular file: ${relativePath}`, relativePath);
        return null;
      }
      // Bound the read from the stat so an oversized file is refused before
      // it is allocated; the post-read length recheck closes a growth race.
      if (info.size > limit) {
        fail("DOCUMENT_TOO_LARGE", `${relativePath} exceeds ${limit} bytes`, relativePath);
        return null;
      }
      const real = realpathSync(target);
      if (real !== target && !inside(packDir, real)) {
        fail("PATH_TRAVERSAL", `path resolves outside the pack: ${relativePath}`, relativePath);
        return null;
      }
      const bytes = readFileSync(target);
      if (bytes.length > limit) {
        fail("DOCUMENT_TOO_LARGE", `${relativePath} exceeds ${limit} bytes`, relativePath);
        return null;
      }
      return bytes;
    } catch {
      fail(code, `missing or unreadable file: ${relativePath}`, relativePath);
      return null;
    }
  };

  const manifestBytes = readRegular(MANIFEST, "MANIFEST_MISSING");
  if (!manifestBytes) {
    return { ok: false, packId, errors, warnings };
  }
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(manifestBytes.toString("utf8")) as unknown;
    if (!jsonValue(parsed)) {
      fail("MANIFEST_INVALID", "manifest must be a JSON object", MANIFEST);
      return { ok: false, packId, errors, warnings };
    }
    manifest = parsed;
  } catch {
    fail("MANIFEST_INVALID", "manifest is not valid JSON", MANIFEST);
    return { ok: false, packId, errors, warnings };
  }

  // --- 12.1 manifest fields -------------------------------------------------
  if (manifest.schemaVersion !== EVIDENCE_PACK_SCHEMA_VERSION) {
    fail("MANIFEST_INVALID", "manifest schemaVersion is not supported", MANIFEST);
  }
  const supportedVersion = supportedExporterVersion(manifest.exporterVersion);
  if (!supportedVersion) {
    fail("MANIFEST_INVALID", "manifest exporterVersion is not a supported version", MANIFEST);
  } else {
    exporterVersion = supportedVersion;
  }
  if (typeof manifest.packId !== "string" || !HASH.test(manifest.packId)) {
    fail("MANIFEST_INVALID", "manifest packId must be a hex SHA-256", MANIFEST);
  } else {
    packId = manifest.packId;
  }
  if (typeof manifest.goal !== "string" || manifest.goal.trim() === "") {
    fail("MANIFEST_INVALID", "manifest goal is required", MANIFEST);
  }
  // The creation clock is advisory: it is bounded here (integer milliseconds in
  // the JS Date range) and the atlas_packs manifest_hash pin detects a rewrite
  // after registration. Capture observation dates describe source evidence and
  // may extend past the creation clock, so createdAt is not range-derived.
  if (
    !Number.isSafeInteger(manifest.createdAt) ||
    (manifest.createdAt as number) < 0 ||
    (manifest.createdAt as number) > 8_640_000_000_000_000
  ) {
    fail("MANIFEST_INVALID", "manifest createdAt is required", MANIFEST);
  }
  if (manifest.inclusionMode !== "references" && manifest.inclusionMode !== "permitted") {
    fail("MANIFEST_INVALID", "manifest inclusionMode is invalid", MANIFEST);
  }
  if (manifest.vocabularyVersion !== ATLAS_VOCABULARY_VERSION) {
    fail("MANIFEST_INVALID", "manifest vocabularyVersion is not the supported version", MANIFEST);
  }
  if (manifest.classifierVersion !== ATLAS_CLASSIFIER_VERSION) {
    fail("MANIFEST_INVALID", "manifest classifierVersion is not the supported version", MANIFEST);
  }
  if (manifest.schemaVersionUsed !== ATLAS_SCHEMA_VERSION) {
    fail("MANIFEST_INVALID", "manifest schemaVersionUsed is not the supported version", MANIFEST);
  }
  if (manifest.ftsVersion !== ATLAS_FTS_VERSION) {
    fail("MANIFEST_INVALID", "manifest ftsVersion is not the supported version", MANIFEST);
  }
  if (!isStringArray(manifest.limitations)) {
    fail("MANIFEST_INVALID", "manifest limitations must be a string array", MANIFEST);
  }

  const selectionRecord = jsonValue(manifest.selection) ? manifest.selection : null;
  const manifestRegionIds =
    selectionRecord && Array.isArray(selectionRecord.regionIds)
      ? selectionRecord.regionIds
      : null;
  if (!manifestRegionIds) {
    fail("MANIFEST_INVALID", "manifest selection.regionIds is required", MANIFEST);
  } else if (
    manifestRegionIds.some((value) => typeof value !== "string") ||
    new Set(manifestRegionIds).size !== manifestRegionIds.length ||
    manifestRegionIds.some(
      (value, index) => index > 0 && String(manifestRegionIds[index - 1]) > String(value),
    )
  ) {
    fail("SELECTION_MISMATCH", "manifest selection.regionIds must be sorted and unique", MANIFEST);
  }
  const manifestCaptureIds =
    selectionRecord && Array.isArray(selectionRecord.captureIds)
      ? selectionRecord.captureIds
      : null;
  if (
    !manifestCaptureIds ||
    manifestCaptureIds.some((value) => typeof value !== "string" || !HASH.test(value)) ||
    new Set(manifestCaptureIds).size !== manifestCaptureIds.length
  ) {
    fail("MANIFEST_INVALID", "manifest selection.captureIds must be unique capture ids", MANIFEST);
  }

  if (!jsonValue(manifest.site) || typeof manifest.site.slug !== "string") {
    fail("MANIFEST_INVALID", "manifest site attribution is required", MANIFEST);
  } else {
    if (!/^[\w-]{1,200}$/.test(manifest.site.slug)) {
      fail("MANIFEST_INVALID", "manifest site.slug is invalid", MANIFEST);
    }
    if (manifest.site.attribution !== EVIDENCE_PACK_ATTRIBUTION) {
      fail("MANIFEST_INVALID", "manifest site.attribution is not the expected attribution", MANIFEST);
    }
    if (!isStringArray(manifest.site.sourceUrls)) {
      fail("MANIFEST_INVALID", "manifest site.sourceUrls must be a string array", MANIFEST);
    } else if (
      new Set(manifest.site.sourceUrls).size !== manifest.site.sourceUrls.length ||
      manifest.site.sourceUrls.some((url) => !isSafeSourceUrl(url))
    ) {
      fail("MANIFEST_INVALID", "manifest site.sourceUrls must be unique http(s) URLs", MANIFEST);
    }
  }
  if (!jsonValue(manifest.designEvidence)) {
    fail("MANIFEST_INVALID", "manifest designEvidence is required", MANIFEST);
  } else {
    if (manifest.designEvidence.path !== "design-evidence.json") {
      fail("MANIFEST_INVALID", "manifest designEvidence.path is invalid", MANIFEST);
    }
    if (!isFiniteNumber(manifest.designEvidence.claims)) {
      fail("MANIFEST_INVALID", "manifest designEvidence.claims is invalid", MANIFEST);
    }
  }
  if (!isCoverage(manifest.coverage)) {
    fail("MANIFEST_INVALID", "manifest coverage is invalid", MANIFEST);
  }
  if (!Array.isArray(manifest.claimIds)) {
    fail("MANIFEST_INVALID", "manifest claimIds are required", MANIFEST);
  } else {
    const ids = manifest.claimIds;
    if (
      ids.some((value) => typeof value !== "string") ||
      new Set(ids).size !== ids.length
    ) {
      fail("MANIFEST_INVALID", "manifest claimIds must be unique strings", MANIFEST);
    }
  }
  if (!Array.isArray(manifest.omitted)) {
    fail("MANIFEST_INVALID", "manifest omitted list is required", MANIFEST);
  } else {
    for (const raw of manifest.omitted) {
      if (!jsonValue(raw) || !isNonEmptyString(raw.family) || !isNonEmptyString(raw.reason)) {
        fail("MANIFEST_INVALID", "manifest omitted entry is invalid", MANIFEST);
      }
    }
  }
  if (!Array.isArray(manifest.rightsAssertions)) {
    fail("MANIFEST_INVALID", "manifest rightsAssertions is required", MANIFEST);
  } else {
    const seen = new Set<string>();
    for (const raw of manifest.rightsAssertions) {
      if (
        !jsonValue(raw) ||
        typeof raw.artifactId !== "string" ||
        !HASH.test(raw.artifactId) ||
        !rightsRecordSchema.safeParse(raw.rights).success ||
        seen.has(raw.artifactId)
      ) {
        fail("MANIFEST_INVALID", "manifest rights assertion is invalid", MANIFEST);
      } else {
        seen.add(raw.artifactId);
      }
    }
  }

  const rawCaptures = Array.isArray(manifest.captures) ? manifest.captures : [];
  const captures = objectsOf(rawCaptures);
  if (rawCaptures.length === 0) {
    fail("MANIFEST_INVALID", "manifest captures are required", MANIFEST);
  }
  const captureIds: string[] = [];
  for (const [index, capture] of captures.entries()) {
    const label = `manifest capture ${index}`;
    const valid =
      typeof capture.id === "string" &&
      HASH.test(capture.id) &&
      typeof capture.pageId === "string" &&
      HASH.test(capture.pageId) &&
      isNonEmptyString(capture.profileKey) &&
      isNonEmptyString(capture.sourceKind) &&
      isNonEmptyString(capture.status) &&
      isNonEmptyString(capture.viewport) &&
      isNullableString(capture.sourceDigest) &&
      typeof capture.configHash === "string" &&
      isNullableTimestamp(capture.observedAt) &&
      isNullableTimestamp(capture.sourceFetchedAt) &&
      isNullableTimestamp(capture.lastConfirmedAt) &&
      isNullableTimestamp(capture.finishedAt) &&
      isNonEmptyString(capture.extractorVersion) &&
      EXTRACTOR_VERSIONS.has(capture.extractorVersion) &&
      isNonEmptyString(capture.classifierVersion) &&
      CAPTURE_CLASSIFIER_VERSIONS.has(capture.classifierVersion) &&
      (capture.policy === "allowed" ||
        capture.policy === "denied" ||
        capture.policy === "unknown") &&
      isNullableString(capture.browserVersion) &&
      isNullableNumber(capture.dpr) &&
      isNullableString(capture.reducedMotion) &&
      isStringArray(capture.requestedStates) &&
      isCoverage(capture.coverage) &&
      isStringArray(capture.limitations);
    const problem = captureRecordProblem(capture);
    if (!valid || problem) {
      fail("MANIFEST_INVALID", `${label} is incomplete`, MANIFEST);
      if (problem) fail("CAPTURE_INVALID", `${label} ${problem} is invalid`, MANIFEST);
      continue;
    }
    captureIds.push(capture.id as string);
  }
  if (rawCaptures.length !== captures.length) {
    fail("MANIFEST_INVALID", "manifest captures contain non-object entries", MANIFEST);
  }
  if (new Set(captureIds).size !== captureIds.length) {
    fail("MANIFEST_INVALID", "manifest captures repeat a capture id", MANIFEST);
  }
  if (
    manifestCaptureIds &&
    !sameMultiset(captureIds, manifestCaptureIds.filter((value): value is string => typeof value === "string"))
  ) {
    fail("SELECTION_MISMATCH", "manifest capture ids do not match its captures", MANIFEST);
  }

  const extractorVersions = uniqueSorted(captureIds.length ? captures.map((capture) => String(capture.extractorVersion)) : []);
  if (
    !isStringArray(manifest.extractorVersions) ||
    !sameMultiset(extractorVersions, manifest.extractorVersions) ||
    manifest.extractorVersions.some((version) => !EXTRACTOR_VERSIONS.has(version))
  ) {
    fail("MANIFEST_INVALID", "manifest extractorVersions does not match its captures", MANIFEST);
  }

  if (!jsonValue(manifest.observationDates)) {
    fail("MANIFEST_INVALID", "manifest observationDates are required", MANIFEST);
  } else {
    const dates = manifest.observationDates;
    if (!isNullableTimestamp(dates.earliest) || !isNullableTimestamp(dates.latest)) {
      fail("MANIFEST_INVALID", "manifest observationDates must be integer dates or null", MANIFEST);
    } else if (
      typeof dates.earliest === "number" &&
      typeof dates.latest === "number" &&
      dates.earliest > dates.latest
    ) {
      fail("MANIFEST_INVALID", "manifest observationDates are inverted", MANIFEST);
    } else {
      const observed = captures
        .map((capture) =>
          isFiniteNumber(capture.observedAt)
            ? capture.observedAt
            : isFiniteNumber(capture.lastConfirmedAt)
              ? capture.lastConfirmedAt
              : isFiniteNumber(capture.sourceFetchedAt)
                ? capture.sourceFetchedAt
                : null,
        )
        .filter((value): value is number => value !== null);
      const earliest = observed.length ? Math.min(...observed) : null;
      const latest = observed.length ? Math.max(...observed) : null;
      if (dates.earliest !== earliest || dates.latest !== latest) {
        fail("MANIFEST_INVALID", "manifest observationDates do not match its captures", MANIFEST);
      }
    }
  }

  const fileEntries = new Map<string, { sha256: string; bytes: number; mimeType: string }>();
  if (!Array.isArray(manifest.files)) {
    fail("MANIFEST_INVALID", "manifest files are required", MANIFEST);
  }
  for (const raw of Array.isArray(manifest.files) ? manifest.files : []) {
    if (!jsonValue(raw) || typeof raw.path !== "string") {
      fail("MANIFEST_INVALID", "manifest file entry is invalid", MANIFEST);
      continue;
    }
    if (raw.path === MANIFEST) {
      fail("MANIFEST_INVALID", "manifest must exclude itself from files", MANIFEST);
      continue;
    }
    if (!safeRelativePath(raw.path)) {
      fail("PATH_TRAVERSAL", `manifest file path escapes the pack: ${raw.path}`, raw.path);
      continue;
    }
    if (
      typeof raw.sha256 !== "string" ||
      !HASH.test(raw.sha256) ||
      !isFiniteNumber(raw.bytes) ||
      raw.bytes < 0 ||
      raw.mimeType !== evidenceFileMime(raw.path)
    ) {
      fail("MANIFEST_INVALID", `manifest file entry is invalid: ${raw.path}`, raw.path);
      continue;
    }
    if (fileEntries.has(raw.path)) {
      fail("MANIFEST_INVALID", `manifest repeats a file entry: ${raw.path}`, raw.path);
      continue;
    }
    fileEntries.set(raw.path, {
      sha256: raw.sha256,
      bytes: raw.bytes,
      mimeType: raw.mimeType,
    });
  }

  for (const required of [...REQUIRED_PACK_FILES, SELECTION]) {
    if (!fileEntries.has(required)) {
      fail("REQUIRED_FILE_MISSING", `required file is not hashed: ${required}`, required);
    }
  }

  for (const [relativePath, expected] of fileEntries) {
    // Bounded by the path cap: a lying declared size can never make the
    // validator allocate more than a legitimate document, and a mismatch
    // between declared and actual bytes is caught by the size check below.
    const bytes = readRegular(relativePath, "REQUIRED_FILE_MISSING");
    if (!bytes) continue;
    const actual = sha256(bytes);
    if (actual !== expected.sha256) {
      fail("HASH_MISMATCH", `file hash does not match: ${relativePath}`, relativePath);
    } else if (bytes.length !== expected.bytes) {
      fail("HASH_MISMATCH", `file size does not match: ${relativePath}`, relativePath);
    }
  }

  // Every file in the pack must be listed; an unlisted file is tampering.
  const listed = new Set(fileEntries.keys());
  const walk = (directory: string, prefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const name of entries) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (relativePath === MANIFEST) continue;
      const target = join(directory, name);
      const info = lstatSync(target);
      if (info.isSymbolicLink()) {
        fail("SYMLINK_REFUSED", `symbolic link is not allowed: ${relativePath}`, relativePath);
      } else if (info.isDirectory()) {
        walk(target, relativePath);
      } else if (!listed.has(relativePath)) {
        fail("UNLISTED_FILE", `file is not listed in the manifest: ${relativePath}`, relativePath);
      }
    }
  };
  walk(packDir, "");

  const documentBytes = new Map<string, Buffer>();
  const selectionBytes = readRegular(SELECTION, "REQUIRED_FILE_MISSING");
  let selection: unknown;
  if (selectionBytes) {
    documentBytes.set(SELECTION, selectionBytes);
    try {
      selection = JSON.parse(selectionBytes.toString("utf8"));
    } catch {
      fail("JSON_INVALID", "selection artifact is not valid JSON", SELECTION);
    }
  }

  const jsonDocs: Array<[string, unknown]> = [];
  for (const name of ["design-evidence.json", "tokens.json", "components.json"]) {
    const bytes = readRegular(name, "REQUIRED_FILE_MISSING");
    if (!bytes) continue;
    documentBytes.set(name, bytes);
    try {
      jsonDocs.push([name, JSON.parse(bytes.toString("utf8"))]);
    } catch {
      fail("JSON_INVALID", `${name} is not valid JSON`, name);
    }
  }
  const designEvidence = jsonDocs.find(([name]) => name === "design-evidence.json")?.[1];
  const tokens = jsonDocs.find(([name]) => name === "tokens.json")?.[1];
  const components = jsonDocs.find(([name]) => name === "components.json")?.[1];

  const texts = new Map<string, string>();
  for (const name of ["DESIGN.md", "brief.md", "tokens.css", "rebuild-handoff.md"]) {
    const bytes = readRegular(name, "REQUIRED_FILE_MISSING");
    if (!bytes) continue;
    documentBytes.set(name, bytes);
    const text = normalizeNewlines(bytes.toString("utf8"));
    texts.set(name, text);
    // Only strong template markers in prose count; generated URLs and observed
    // values are code spans, so "TODO:" inside a URL is not a placeholder.
    if (PLACEHOLDER.test(placeholderScanText(text))) {
      fail("PLACEHOLDER_FOUND", `${name} contains placeholder text`, name);
    }
  }

  const design = texts.get("DESIGN.md");
  if (design) {
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(design);
    if (!frontmatter) {
      fail("DESIGN_FRONTMATTER", "DESIGN.md has no YAML front matter", "DESIGN.md");
    } else {
      for (const key of [
        "version",
        "name",
        "description",
        "colors",
        "typography",
        "rounded",
        "spacing",
        "components",
      ]) {
        if (!new RegExp(`^${key}:\\s*\\S`, "m").test(frontmatter[1])) {
          fail("DESIGN_FRONTMATTER", `DESIGN.md front matter is missing ${key}`, "DESIGN.md");
        }
      }
    }
    if (/data:image\/[a-z+]+;base64,/i.test(design)) {
      fail("DESIGN_EMBEDDED_IMAGE", "DESIGN.md embeds a base64 image", "DESIGN.md");
    }
    const prose = stripFences(design);
    let cursor = -1;
    for (const section of REQUIRED_DESIGN_SECTIONS) {
      const marker = `\n## ${section}\n`;
      const at = prose.indexOf(marker);
      const count = prose.split(marker).length - 1;
      if (at < 0) {
        fail("DESIGN_SECTION_MISSING", `DESIGN.md is missing H2 section ${section}`, "DESIGN.md");
        continue;
      }
      if (count !== 1) {
        fail("DESIGN_SECTION_DUPLICATE", `DESIGN.md repeats H2 section ${section}`, "DESIGN.md");
      }
      if (at < cursor) {
        fail("DESIGN_SECTION_ORDER", `DESIGN.md section ${section} is out of order`, "DESIGN.md");
      } else {
        cursor = at;
      }
    }
  }

  if (tokens !== undefined) {
    if (!jsonValue(tokens) || tokens.generated !== true) {
      fail("TOKENS_INVALID", "tokens.json must be marked generated", "tokens.json");
    }
  }

  // --- selection artifact ---------------------------------------------------
  const selectionIds = objectsOf(jsonValue(selection) ? selection.regions : undefined)
    .map((region) => region.regionId)
    .filter((value): value is string => typeof value === "string");
  const selectedCaptureIds = objectsOf(jsonValue(selection) ? selection.captures : undefined)
    .map((capture) => capture.id)
    .filter((value): value is string => typeof value === "string");
  const selectionClaimIds = objectsOf(jsonValue(selection) ? selection.claims : undefined)
    .map((claim) => claim.id)
    .filter((value): value is string => typeof value === "string");

  if (selectionBytes && !jsonValue(selection)) {
    fail("SELECTION_INVALID", "selection artifact must be a JSON object", SELECTION);
  }
  if (jsonValue(selection)) {
    if (selection.schemaVersion !== EVIDENCE_SELECTION_SCHEMA_VERSION) {
      fail("SELECTION_INVALID", "selection schemaVersion is not supported", SELECTION);
    }
    if (typeof selection.packId !== "string" || !HASH.test(selection.packId)) {
      fail("SELECTION_INVALID", "selection packId is invalid", SELECTION);
    }
    if (!isNonEmptyString(selection.siteSlug) || !isNonEmptyString(selection.goal)) {
      fail("SELECTION_INVALID", "selection site/goal is invalid", SELECTION);
    }
    if (selection.inclusionMode !== "references" && selection.inclusionMode !== "permitted") {
      fail("SELECTION_INVALID", "selection inclusionMode is invalid", SELECTION);
    }
    for (const key of [
      "captures",
      "regions",
      "claims",
      "references",
      "media",
      "rightsAssertions",
    ]) {
      if (!Array.isArray(selection[key])) {
        fail("SELECTION_INVALID", `selection ${key} must be an array`, SELECTION);
      }
    }
    const selectionCaptureRecords = objectsOf(selection.captures);
    if (
      selectionCaptureRecords.some(
        (capture) =>
          typeof capture.id !== "string" ||
          !HASH.test(capture.id) ||
          (capture.policy !== "allowed" &&
            capture.policy !== "denied" &&
            capture.policy !== "unknown"),
      )
    ) {
      fail("SELECTION_INVALID", "selection capture identity or policy is invalid", SELECTION);
    } else if (selectionCaptureRecords.some((capture) => captureRecordProblem(capture))) {
      fail("CAPTURE_INVALID", "selection capture provenance is invalid", SELECTION);
    }
    const selectionMedia = objectsOf(selection.media);
    if (Array.isArray(selection.media) && selection.media.length !== selectionMedia.length) {
      fail("SELECTION_INVALID", "selection media contains non-object entries", SELECTION);
    }
    const mediaArtifactIds = new Set<string>();
    for (const decision of selectionMedia) {
      if (
        typeof decision.artifactId !== "string" ||
        !HASH.test(decision.artifactId) ||
        typeof decision.captureId !== "string" ||
        !HASH.test(decision.captureId) ||
        typeof decision.kind !== "string" ||
        typeof decision.included !== "boolean" ||
        typeof decision.state !== "string" ||
        typeof decision.mimeType !== "string" ||
        typeof decision.sha256 !== "string" ||
        (decision.sha256 !== "" && !HASH.test(decision.sha256)) ||
        !isFiniteNumber(decision.bytes) ||
        decision.bytes < 0 ||
        (decision.policy !== "allowed" &&
          decision.policy !== "denied" &&
          decision.policy !== "unknown") ||
        !isNullableString(decision.copiedPath) ||
        !isNonEmptyString(decision.reason) ||
        mediaArtifactIds.has(decision.artifactId)
      ) {
        fail("SELECTION_INVALID", "selection media decision is invalid", SELECTION);
        continue;
      }
      mediaArtifactIds.add(decision.artifactId);
      if (decision.included && decision.copiedPath === null) {
        fail("SELECTION_INVALID", "included media decision has no copied path", SELECTION);
      }
      if (!decision.included && decision.copiedPath !== null) {
        fail("SELECTION_INVALID", "excluded media decision claims a copied path", SELECTION);
      }
    }
    const rightsAssertions = objectsOf(selection.rightsAssertions);
    if (
      Array.isArray(selection.rightsAssertions) &&
      selection.rightsAssertions.length !== rightsAssertions.length
    ) {
      fail("SELECTION_INVALID", "selection rights contain non-object entries", SELECTION);
    }
    const rightsArtifactIds = new Set<string>();
    for (const assertion of rightsAssertions) {
      if (
        typeof assertion.artifactId !== "string" ||
        !HASH.test(assertion.artifactId) ||
        !rightsRecordSchema.safeParse(assertion.rights).success ||
        rightsArtifactIds.has(assertion.artifactId)
      ) {
        fail("SELECTION_INVALID", "selection rights assertion is invalid", SELECTION);
      } else {
        rightsArtifactIds.add(assertion.artifactId);
      }
    }
    if (
      selectionIds.length !== objectsOf(selection.regions).length ||
      (Array.isArray(selection.regions) &&
        selection.regions.length !== objectsOf(selection.regions).length)
    ) {
      fail("SELECTION_INVALID", "selection regions are missing their ids", SELECTION);
    }
    if (
      selectedCaptureIds.length !== objectsOf(selection.captures).length ||
      (Array.isArray(selection.captures) &&
        selection.captures.length !== objectsOf(selection.captures).length)
    ) {
      fail("SELECTION_INVALID", "selection captures are missing their ids", SELECTION);
    }
    if (
      selectionClaimIds.length !== objectsOf(selection.claims).length ||
      (Array.isArray(selection.claims) &&
        selection.claims.length !== objectsOf(selection.claims).length)
    ) {
      fail("SELECTION_INVALID", "selection claims are missing their ids", SELECTION);
    }
    const selectionRegionById = new Map(
      objectsOf(selection.regions)
        .filter((region) => typeof region.regionId === "string")
        .map((region) => [region.regionId as string, region]),
    );
    // A claim's capture and viewport are not free text: they must describe the
    // selected region it summarizes, for source and derived claims alike.
    for (const claim of objectsOf(selection.claims)) {
      const region = selectionRegionById.get(String(claim.regionId));
      if (!region || claim.captureId !== region.captureId || claim.viewport !== region.viewport) {
        fail(
          "CLAIM_PROVENANCE_MISMATCH",
          `selection claim ${String(claim.id)} does not match its selected region`,
          SELECTION,
        );
      }
    }
  }

  // --- design-evidence.json -------------------------------------------------
  let claims: Array<Record<string, unknown>> = [];
  if (designEvidence !== undefined) {
    if (!jsonValue(designEvidence)) {
      fail("DESIGN_EVIDENCE_INVALID", "design-evidence.json must be an object", "design-evidence.json");
    } else {
      if (designEvidence.schemaVersion !== EVIDENCE_DESIGN_SCHEMA_VERSION) {
        fail("DESIGN_EVIDENCE_INVALID", "design-evidence schemaVersion is not supported", "design-evidence.json");
      }
      for (const field of [
        "packId",
        "requestedUrlHash",
        "redactedFinalUrl",
        "capturedAt",
        "viewport",
        "captures",
        "claims",
        "omissions",
      ]) {
        if (!(field in designEvidence)) {
          fail("DESIGN_EVIDENCE_INVALID", `design-evidence is missing ${field}`, "design-evidence.json");
        }
      }
      if (designEvidence.packId !== packId) {
        fail("DESIGN_EVIDENCE_INVALID", "design-evidence packId does not match manifest", "design-evidence.json");
      }
      if (
        typeof designEvidence.requestedUrlHash !== "string" ||
        !HASH.test(designEvidence.requestedUrlHash) ||
        !isFiniteNumber(designEvidence.capturedAt) ||
        !isNonEmptyString(designEvidence.viewport) ||
        designEvidence.toolVersion !== exporterVersion
      ) {
        fail("DESIGN_EVIDENCE_INVALID", "design-evidence provenance fields are invalid", "design-evidence.json");
      }
      if (!Array.isArray(designEvidence.omissions)) {
        fail("DESIGN_EVIDENCE_INVALID", "design-evidence omissions must be an array", "design-evidence.json");
      } else {
        for (const omission of designEvidence.omissions) {
          if (!jsonValue(omission) || !isNonEmptyString(omission.family) || !isNonEmptyString(omission.reason)) {
            fail("DESIGN_EVIDENCE_INVALID", "design-evidence omission is invalid", "design-evidence.json");
          }
        }
      }
      if (typeof designEvidence.redactedFinalUrl !== "string") {
        fail("DESIGN_EVIDENCE_INVALID", "redactedFinalUrl must be a string", "design-evidence.json");
      } else if (designEvidence.redactedFinalUrl) {
        try {
          const url = new URL(designEvidence.redactedFinalUrl);
          if (url.username || url.password || url.search || url.hash) {
            fail("DESIGN_EVIDENCE_INVALID", "redactedFinalUrl still contains credentials, query or fragment", "design-evidence.json");
          }
        } catch {
          fail("DESIGN_EVIDENCE_INVALID", "redactedFinalUrl is not an absolute URL", "design-evidence.json");
        }
      }
      const captures = Array.isArray(designEvidence.captures) ? designEvidence.captures : [];
      if (!captures.length) {
        fail("DESIGN_EVIDENCE_INVALID", "design-evidence has no captures", "design-evidence.json");
      }
      let selectionCaptureFound = false;
      for (const capture of captures) {
        if (!jsonValue(capture)) {
          fail("DESIGN_EVIDENCE_INVALID", "capture record is invalid", "design-evidence.json");
          continue;
        }
        for (const field of ["id", "tool", "capturedAt", "sha256", "artifactPath"]) {
          if (!(field in capture)) {
            fail("DESIGN_EVIDENCE_INVALID", `capture is missing ${field}`, "design-evidence.json");
          }
        }
        if (typeof capture.id !== "string" || typeof capture.artifactPath !== "string") continue;
        if (typeof capture.sha256 !== "string" || !HASH.test(capture.sha256)) {
          fail("DESIGN_EVIDENCE_INVALID", `capture ${capture.id} sha256 is invalid`, "design-evidence.json");
          continue;
        }
        if (capture.artifactId === "selection") {
          selectionCaptureFound = true;
          if (capture.artifactPath !== SELECTION) {
            fail("DESIGN_EVIDENCE_INVALID", "selection evidence capture must point at artifacts/selection.json", "design-evidence.json");
          } else if (selectionBytes && sha256(selectionBytes) !== capture.sha256) {
            fail("ARTIFACT_HASH_MISMATCH", "selection evidence capture hash does not match", SELECTION);
          }
        } else {
          const bytes = readRegular(capture.artifactPath, "ARTIFACT_MISSING");
          if (!bytes) continue;
          if (sha256(bytes) !== capture.sha256) {
            fail("ARTIFACT_HASH_MISMATCH", `capture ${capture.id} artifact hash does not match`, capture.artifactPath);
          }
        }
      }
      if (!selectionCaptureFound) {
        fail("DESIGN_EVIDENCE_INVALID", "design-evidence has no selection artifact capture", "design-evidence.json");
      }
      claims = Array.isArray(designEvidence.claims)
        ? (designEvidence.claims.filter((claim): claim is Record<string, unknown> => jsonValue(claim)))
        : [];
      if (!Array.isArray(designEvidence.claims)) {
        fail("DESIGN_EVIDENCE_INVALID", "claims must be an array", "design-evidence.json");
      }
      const claimIds = new Set<string>();
      const selectionRegions = new Set(selectionIds);
      const selectionCaptures = new Set(selectedCaptureIds);
      const selectionClaimRecords = jsonValue(selection) ? objectsOf(selection.claims) : [];
      const selectionClaimById = new Map(
        selectionClaimRecords
          .filter((claim) => typeof claim.id === "string")
          .map((claim) => [claim.id as string, claim]),
      );
      const selectionRegionRecords = jsonValue(selection) ? objectsOf(selection.regions) : [];
      const selectionRegionById = new Map(
        selectionRegionRecords
          .filter((region) => typeof region.regionId === "string")
          .map((region) => [region.regionId as string, region]),
      );
      for (const [index, claim] of claims.entries()) {
        const id = typeof claim.id === "string" ? claim.id : `#${index}`;
        if (typeof claim.id !== "string" || !CLAIM_ID.test(claim.id)) {
          fail("CLAIM_INVALID", `claim ${id} id is invalid`, "design-evidence.json");
        } else if (claimIds.has(claim.id)) {
          fail("CLAIM_DUPLICATE", `claim ${id} is duplicated`, "design-evidence.json");
        } else {
          claimIds.add(claim.id);
        }
        if (!["observed", "inferred", "proposed"].includes(String(claim.classification))) {
          fail("CLAIM_INVALID", `claim ${id} classification is invalid`, "design-evidence.json");
        }
        for (const field of [
          "value",
          "artifactId",
          "path",
          "property",
          "viewport",
          "state",
          "sampleKey",
          "method",
          "ruleId",
          "sampleCount",
          "sourceRegionId",
          "sourceCaptureId",
          "limitations",
        ]) {
          if (!(field in claim)) {
            fail("CLAIM_INVALID", `claim ${id} is missing ${field}`, "design-evidence.json");
          }
        }
        if (
          !["string", "number", "boolean"].includes(typeof claim.value) ||
          !isNonEmptyString(claim.property) ||
          !isNonEmptyString(claim.viewport) ||
          !isNonEmptyString(claim.state) ||
          !isNullableString(claim.sampleKey) ||
          !isNonEmptyString(claim.method) ||
          !isNullableString(claim.ruleId) ||
          !isFiniteNumber(claim.sampleCount) ||
          !isStringArray(claim.limitations)
        ) {
          fail("CLAIM_INVALID", `claim ${id} has invalid field types`, "design-evidence.json");
        }
        if (claim.artifactId !== "selection") {
          fail("CLAIM_INVALID", `claim ${id} must resolve against the selection artifact`, "design-evidence.json");
          continue;
        }
        if (typeof claim.path !== "string" || !claim.path.startsWith("/")) {
          fail("POINTER_INVALID", `claim ${id} path is not a JSON pointer`, "design-evidence.json");
          continue;
        }
        if (!jsonValue(selection)) continue;
        const resolved = resolvePointer(selection, claim.path);
        if (resolved === undefined) {
          fail("POINTER_UNRESOLVED", `claim ${id} path does not resolve`, "design-evidence.json");
          continue;
        }
        if (typeof resolved === "object" && resolved !== null) {
          fail("POINTER_INVALID", `claim ${id} path does not resolve to a scalar value`, "design-evidence.json");
        } else if (String(resolved) !== String(claim.value)) {
          fail("CLAIM_VALUE_MISMATCH", `claim ${id} value does not match its pointer`, "design-evidence.json");
        }
        const sourceClaim =
          typeof claim.id === "string" ? selectionClaimById.get(claim.id) : undefined;
        if (!sourceClaim) {
          fail(
            "CLAIM_PROVENANCE_MISMATCH",
            `claim ${id} does not match a selection claim record`,
            "design-evidence.json",
          );
        } else {
          const provenance: Array<[string, unknown, unknown]> = [
            ["classification", claim.classification, sourceClaim.classification],
            ["property", claim.property, sourceClaim.property],
            ["viewport", claim.viewport, sourceClaim.viewport],
            ["state", claim.state, sourceClaim.state],
            ["method", claim.method, sourceClaim.method],
            ["ruleId", claim.ruleId ?? null, sourceClaim.ruleId ?? null],
            ["sampleKey", claim.sampleKey ?? null, sourceClaim.sampleKey ?? null],
            ["sampleCount", claim.sampleCount, sourceClaim.sampleCount],
            ["sourceRegionId", claim.sourceRegionId, sourceClaim.regionId],
            ["sourceCaptureId", claim.sourceCaptureId, sourceClaim.captureId],
            ["limitations", claim.limitations, sourceClaim.limitations],
          ];
          if (
            provenance.some(
              ([field, left, right]) =>
                field === "limitations"
                  ? JSON.stringify(left) !== JSON.stringify(right)
                  : String(left) !== String(right),
            ) ||
            String(claim.value) !== String(sourceClaim.value)
          ) {
            fail(
              "CLAIM_PROVENANCE_MISMATCH",
              `claim ${id} provenance does not match the selection claim`,
              "design-evidence.json",
            );
          }
        }
        const pointerPath = claim.path as string;
        const claimPointer = /^\/claims\/(0|[1-9]\d*)\/value$/.exec(pointerPath);
        const regionPointer = /^\/regions\/(0|[1-9]\d*)\/(backgroundColor|styles\/([A-Za-z]+)|geometry\/(x|y|width|height))$/.exec(
          pointerPath,
        );
        if (claimPointer) {
          const indexed = selectionClaimRecords[Number(claimPointer[1])];
          if (!indexed || indexed.id !== claim.id) {
            fail(
              "CLAIM_POINTER_MISMATCH",
              `claim ${id} does not point at its own selection claim`,
              "design-evidence.json",
            );
          }
        } else if (regionPointer) {
          const region = selectionRegionRecords[Number(regionPointer[1])];
          const expectedProperty =
            regionPointer[2] === "backgroundColor"
              ? "background-color"
              : regionPointer[2]?.startsWith("styles/")
                ? STYLE_PROPERTY.get(regionPointer[3] ?? "")
                : regionPointer[4];
          if (!region || region.regionId !== claim.sourceRegionId) {
            fail(
              "CLAIM_POINTER_MISMATCH",
              `claim ${id} points at a different region`,
              "design-evidence.json",
            );
          } else if (expectedProperty !== claim.property) {
            fail(
              "CLAIM_POINTER_MISMATCH",
              `claim ${id} pointer family does not match its property`,
              "design-evidence.json",
            );
          }
        } else {
          fail(
            "CLAIM_POINTER_MISMATCH",
            `claim ${id} pointer is not a recognized evidence path`,
            "design-evidence.json",
          );
        }
        if (!isNonEmptyString(claim.sourceRegionId)) {
          fail("CLAIM_INVALID", `claim ${id} sourceRegionId must be a non-empty string`, "design-evidence.json");
        } else if (!selectionRegions.has(claim.sourceRegionId)) {
          fail("CLAIM_INVALID", `claim ${id} source region is not selected`, "design-evidence.json");
        }
        if (!isNonEmptyString(claim.sourceCaptureId)) {
          fail("CLAIM_INVALID", `claim ${id} sourceCaptureId must be a non-empty string`, "design-evidence.json");
        } else if (!selectionCaptures.has(claim.sourceCaptureId)) {
          fail("CLAIM_INVALID", `claim ${id} source capture is not selected`, "design-evidence.json");
        }
        const selectedRegion = isNonEmptyString(claim.sourceRegionId)
          ? selectionRegionById.get(claim.sourceRegionId)
          : undefined;
        if (selectedRegion && claim.sourceCaptureId !== selectedRegion.captureId) {
          fail(
            "CLAIM_PROVENANCE_MISMATCH",
            `claim ${id} capture does not match its selected region`,
            "design-evidence.json",
          );
        }
        if (selectedRegion && claim.viewport !== selectedRegion.viewport) {
          fail(
            "CLAIM_PROVENANCE_MISMATCH",
            `claim ${id} viewport does not match its selected region`,
            "design-evidence.json",
          );
        }
      }
      const manifestClaimIds = new Set(
        (Array.isArray(manifest.claimIds) ? manifest.claimIds : []).filter(
          (value): value is string => typeof value === "string",
        ),
      );
      if (!sameMultiset([...claimIds], [...manifestClaimIds])) {
        fail("CLAIM_MANIFEST_MISMATCH", "manifest claimIds does not match design-evidence claims", MANIFEST);
      }
      if (jsonValue(selection) && jsonValue(manifest.designEvidence) && isFiniteNumber(manifest.designEvidence.claims)) {
        if (manifest.designEvidence.claims !== claims.length) {
          fail("MANIFEST_INVALID", "manifest designEvidence.claims does not match the sidecar", MANIFEST);
        }
      }
      const docsText = [
        texts.get("DESIGN.md") ?? "",
        texts.get("brief.md") ?? "",
        texts.get("rebuild-handoff.md") ?? "",
        JSON.stringify(components ?? {}),
        JSON.stringify(tokens ?? {}),
      ].join("\n");
      for (const match of docsText.matchAll(/claim-[a-f0-9]{16}/g)) {
        if (!claimIds.has(match[0])) {
          fail("CLAIM_UNKNOWN", `document references unknown claim ${match[0]}`, "DESIGN.md");
        }
      }
    }
  }

  if (tokens !== undefined && jsonValue(tokens)) {
    if (tokens.packId !== packId) {
      fail("TOKENS_INVALID", "tokens.json packId does not match manifest", "tokens.json");
    }
    const typography = jsonValue(tokens.typography) ? tokens.typography : {};
    const spacing = jsonValue(tokens.spacing) ? tokens.spacing : {};
    const families: Array<[string, unknown]> = [
      ["background-color", tokens.colors],
      ["font-family", typography.fontFamily],
      ["font-size", typography.fontSize],
      ["font-weight", typography.fontWeight],
      ["line-height", typography.lineHeight],
      ["gap", spacing.gap],
      ["padding", spacing.padding],
      ["border-radius", tokens.radii],
      ["display", tokens.display],
    ];
    const entries: Array<{ entry: Record<string, unknown>; property: string }> = [];
    for (const [property, family] of families) {
      if (family === undefined) continue;
      if (!Array.isArray(family)) {
        fail("TOKENS_INVALID", `tokens.json ${property} family must be an array`, "tokens.json");
        continue;
      }
      for (const entry of family) {
        if (!jsonValue(entry)) {
          fail("TOKENS_INVALID", `tokens.json ${property} entry is invalid`, "tokens.json");
          continue;
        }
        entries.push({ entry, property });
      }
    }
    const claimById = new Map(
      claims
        .filter((claim) => typeof claim.id === "string")
        .map((claim) => [claim.id as string, claim]),
    );
    const css = texts.get("tokens.css") ?? "";
    const cssValues = new Map<string, string>();
    for (const match of css.matchAll(/^\s{2}(--atlas-[a-z-]+-\d+): (.*);$/gm)) {
      if (cssValues.has(match[1]!)) {
        fail("TOKENS_INVALID", `tokens.css repeats ${match[1]}`, "tokens.css");
      }
      cssValues.set(match[1]!, match[2]!);
    }
    const names = new Set<string>();
    for (const { entry, property } of entries) {
      const name = typeof entry.name === "string" ? entry.name : "";
      if (!TOKEN_NAME.test(name) || names.has(name)) {
        fail("TOKENS_INVALID", `generated token name is invalid: ${String(entry.name)}`, "tokens.json");
        continue;
      }
      names.add(name);
      const value = entry.value;
      if (
        typeof value !== "string" ||
        value === "" ||
        entry.property !== property ||
        !TOKEN_PROPERTIES.has(property)
      ) {
        fail("TOKENS_INVALID", `generated token ${name} has an invalid value or property`, "tokens.json");
        continue;
      }
      if (cssValues.get(name) !== tokenCssValue(value)) {
        fail("TOKENS_INVALID", `tokens.css does not declare ${name} with its generated value`, "tokens.css");
      }
      const claimIds = Array.isArray(entry.claimIds) ? entry.claimIds : [];
      const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
      if (!claimIds.length || !evidence.length) {
        fail("TOKENS_INVALID", `generated token ${name} has no provenance`, "tokens.json");
        continue;
      }
      const referenced = new Set<string>();
      for (const claimId of claimIds) {
        const claim = typeof claimId === "string" ? claimById.get(claimId) : undefined;
        if (!claim) {
          fail("CLAIM_UNKNOWN", `token references unknown claim ${String(claimId)}`, "tokens.json");
          continue;
        }
        if (claim.property !== property || String(claim.value) !== value) {
          fail(
            "TOKENS_INVALID",
            `generated token ${name} does not match claim ${String(claimId)}`,
            "tokens.json",
          );
        }
        if (typeof claim.path === "string") referenced.add(claim.path);
      }
      const evidencePaths = new Set<string>();
      for (const pointer of evidence) {
        if (
          !jsonValue(pointer) ||
          pointer.artifactId !== "selection" ||
          typeof pointer.path !== "string"
        ) {
          fail("TOKENS_INVALID", `generated token ${name} has invalid evidence`, "tokens.json");
          continue;
        }
        evidencePaths.add(pointer.path);
        if (!jsonValue(selection) || resolvePointer(selection, pointer.path) !== value) {
          fail(
            "TOKENS_INVALID",
            `generated token ${name} evidence does not resolve to its value`,
            "tokens.json",
          );
        }
      }
      if (
        referenced.size !== evidencePaths.size ||
        [...referenced].some((path) => !evidencePaths.has(path))
      ) {
        fail("TOKENS_INVALID", `generated token ${name} evidence is incomplete`, "tokens.json");
      }
    }
    for (const name of cssValues.keys()) {
      if (!names.has(name)) {
        fail("TOKENS_INVALID", `tokens.css declares an unknown token: ${name}`, "tokens.css");
      }
    }
  }

  const designText = texts.get("DESIGN.md");
  if (designText) {
    validateDesignMaterials(designText, claims, tokens, fail);
  }

  // --- derived decisions and generated documents ---------------------------
  if (jsonValue(selection) && selectionBytes) {
    const derived = selectionFromArtifact(selection);
    if (!derived) {
      fail("SELECTION_INVALID", "selection is missing derived-document inputs", SELECTION);
    } else {
      // Summaries are derived from the selected regions and claims, not a
      // second source of truth: a forged component type or claim count cannot
      // ride along in the summaries and their regenerated documents.
      const expectedSections = deriveSectionSummaries(derived.regions, derived.claims);
      if (canonicalJson(derived.sections) !== canonicalJson(expectedSections)) {
        fail(
          "SELECTION_MISMATCH",
          "selection sections do not match the selected regions and claims",
          SELECTION,
        );
      }
      const expectedComponents = deriveComponentSummaries(derived.regions, derived.claims);
      if (canonicalJson(derived.components) !== canonicalJson(expectedComponents)) {
        fail(
          "SELECTION_MISMATCH",
          "selection components do not match the selected regions and claims",
          SELECTION,
        );
      }
      try {
        const expectedCoverage = packCoverage(derived.captures, derived.regions);
        if (canonicalJson(selection.coverage) !== canonicalJson(expectedCoverage)) {
          fail(
            "MANIFEST_DECISION_MISMATCH",
            "selection coverage does not match recomputed coverage",
            SELECTION,
          );
        }
        if (
          jsonValue(manifest.coverage) &&
          canonicalJson(manifest.coverage) !== canonicalJson(expectedCoverage)
        ) {
          fail(
            "MANIFEST_DECISION_MISMATCH",
            "manifest coverage does not match recomputed coverage",
            MANIFEST,
          );
        }
        if (!sameStringList(derived.limitations, expectedCoverage.limitations)) {
          fail(
            "MANIFEST_DECISION_MISMATCH",
            "selection limitations do not match recomputed coverage",
            SELECTION,
          );
        }
        if (
          isStringArray(manifest.limitations) &&
          !sameStringList(manifest.limitations, expectedCoverage.limitations)
        ) {
          fail(
            "MANIFEST_DECISION_MISMATCH",
            "manifest limitations do not match recomputed coverage",
            MANIFEST,
          );
        }
        const expectedOmitted = omittedValues(derived, exporterVersion);
        if (!sameJsonSet(derived.omitted, expectedOmitted)) {
          fail(
            "MANIFEST_DECISION_MISMATCH",
            "selection omitted families do not match recomputed decisions",
            SELECTION,
          );
        }
        if (
          Array.isArray(manifest.omitted) &&
          !sameJsonSet(manifest.omitted.filter(jsonValue), expectedOmitted)
        ) {
          fail(
            "MANIFEST_DECISION_MISMATCH",
            "manifest omitted families do not match recomputed decisions",
            MANIFEST,
          );
        }
        const expectedTokens = buildTokens(derived);
        if (canonicalJson(expectedTokens) !== canonicalJson(derived.tokens)) {
          fail(
            "TOKENS_INVALID",
            "tokens.json is not derived from the selected claims",
            "tokens.json",
          );
        }
      } catch {
        fail(
          "SELECTION_INVALID",
          "selection derived decisions could not be recomputed",
          SELECTION,
        );
      }
      try {
        for (const expected of [
          renderSelectionArtifact(derived).document,
          ...renderGeneratedDocuments(derived, sha256(selectionBytes), exporterVersion),
        ]) {
          const actual = documentBytes.get(expected.path);
          if (!actual) continue;
          if (!actual.equals(Buffer.from(expected.content, "utf8"))) {
            fail(
              "DOCUMENT_RENDER_MISMATCH",
              `generated document does not match its deterministic render: ${expected.path}`,
              expected.path,
            );
          }
        }
      } catch {
        fail(
          "DOCUMENT_RENDER_MISMATCH",
          "generated documents could not be re-rendered from the selection",
          SELECTION,
        );
      }
    }
  }

  // --- artifacts ------------------------------------------------------------
  const selectionMediaDecisions = jsonValue(selection) ? objectsOf(selection.media) : [];
  const selectionMediaById = new Map(
    selectionMediaDecisions
      .filter((decision) => typeof decision.artifactId === "string")
      .map((decision) => [decision.artifactId as string, decision]),
  );
  const selectionReferenceById = new Map(
    (jsonValue(selection) ? objectsOf(selection.references) : [])
      .filter((reference) => typeof reference.artifactId === "string")
      .map((reference) => [reference.artifactId as string, reference]),
  );
  const selectionRightsById = new Map(
    (jsonValue(selection) ? objectsOf(selection.rightsAssertions) : [])
      .filter((assertion) => typeof assertion.artifactId === "string")
      .map((assertion) => [assertion.artifactId as string, assertion.rights]),
  );
  // A media decision and its source reference describe the same artifact: the
  // storage paths must agree so rewriting one of the two is detected.
  for (const decision of selectionMediaDecisions) {
    const reference = selectionReferenceById.get(String(decision.artifactId));
    if (reference && (decision.storagePath ?? null) !== (reference.storagePath ?? null)) {
      fail(
        "ARTIFACT_DECISION_MISMATCH",
        `selection media storage path does not match its reference: ${String(decision.artifactId)}`,
        SELECTION,
      );
    }
  }
  const selectionCapturePolicy = new Map(
    (jsonValue(selection) ? objectsOf(selection.captures) : [])
      .filter((capture) => typeof capture.id === "string")
      .map((capture) => [capture.id as string, capture.policy]),
  );
  const declaredCopies = new Set<string>();
  const declaredArtifactIds = new Set<string>();
  if (!jsonValue(manifest.artifacts)) {
    fail("MANIFEST_INVALID", "manifest artifacts decisions are required", MANIFEST);
  } else {
    const artifacts = manifest.artifacts;
    if (!Array.isArray(artifacts.included)) {
      fail("MANIFEST_INVALID", "manifest artifacts.included must be an array", MANIFEST);
    } else {
      if (artifacts.included.length > MAX_COPIED_ARTIFACTS) {
        fail(
          "PACK_LIMIT_EXCEEDED",
          `manifest includes ${artifacts.included.length} artifacts (limit ${MAX_COPIED_ARTIFACTS})`,
          MANIFEST,
        );
      }
      let totalBytes = 0;
      for (const raw of artifacts.included) {
        if (!jsonValue(raw) || typeof raw.path !== "string") {
          fail("ARTIFACT_INVALID", "included artifact entry is invalid", MANIFEST);
          continue;
        }
        if (!raw.path.startsWith("artifacts/") || !safeRelativePath(raw.path)) {
          fail("PATH_TRAVERSAL", `included artifact path is unsafe: ${raw.path}`, raw.path);
          continue;
        }
        if (
          typeof raw.artifactId !== "string" ||
          !HASH.test(raw.artifactId) ||
          typeof raw.captureId !== "string" ||
          !HASH.test(raw.captureId) ||
          typeof raw.sha256 !== "string" ||
          !HASH.test(raw.sha256) ||
          !isFiniteNumber(raw.bytes) ||
          typeof raw.kind !== "string" ||
          typeof raw.mimeType !== "string"
        ) {
          fail("ARTIFACT_INVALID", `included artifact entry is invalid: ${raw.path}`, raw.path);
          continue;
        }
        if (raw.bytes > MAX_COPIED_ARTIFACT_BYTES) {
          fail("PACK_LIMIT_EXCEEDED", `included artifact exceeds ${MAX_COPIED_ARTIFACT_BYTES} bytes: ${raw.path}`, raw.path);
        }
        totalBytes += raw.bytes;
        if (declaredCopies.has(raw.path) || declaredArtifactIds.has(raw.artifactId)) {
          fail("ARTIFACT_INVALID", `included artifact is repeated: ${raw.path}`, raw.path);
        }
        declaredCopies.add(raw.path);
        declaredArtifactIds.add(raw.artifactId);
        const entry = fileEntries.get(raw.path);
        if (!entry) {
          fail("ARTIFACT_MISSING", `included artifact is not hashed: ${raw.path}`, raw.path);
        } else if (
          raw.sha256 !== entry.sha256 ||
          raw.bytes !== entry.bytes ||
          raw.mimeType !== entry.mimeType ||
          raw.mimeType !== evidenceFileMime(raw.path)
        ) {
          fail("ARTIFACT_HASH_MISMATCH", `included artifact hash or MIME does not match: ${raw.path}`, raw.path);
        }
        const decision = selectionMediaById.get(raw.artifactId);
        if (!decision) {
          fail(
            "ARTIFACT_DECISION_MISSING",
            `included artifact has no selection media decision: ${raw.path}`,
            raw.path,
          );
        } else if (
          decision.included !== true ||
          decision.copiedPath !== raw.path ||
          decision.captureId !== raw.captureId ||
          decision.sha256 !== raw.sha256 ||
          decision.bytes !== raw.bytes ||
          decision.kind !== raw.kind ||
          decision.mimeType !== raw.mimeType ||
          decision.state !== "ready"
        ) {
          fail(
            "ARTIFACT_DECISION_MISMATCH",
            `included artifact does not match its selection media decision: ${raw.path}`,
            raw.path,
          );
        } else if (
          decision.policy !== "allowed" ||
          selectionCapturePolicy.get(String(decision.captureId)) !== "allowed"
        ) {
          fail(
            "ARTIFACT_POLICY_INVALID",
            `included artifact was not allowed by capture policy: ${raw.path}`,
            raw.path,
          );
        }
        const reference = selectionReferenceById.get(raw.artifactId);
        if (!reference) {
          fail(
            "ARTIFACT_REFERENCE_MISSING",
            `included artifact has no selection reference: ${raw.path}`,
            raw.path,
          );
        } else {
          if (
            reference.captureId !== raw.captureId ||
            reference.kind !== raw.kind ||
            reference.sha256 !== raw.sha256 ||
            reference.bytes !== raw.bytes ||
            reference.mimeType !== raw.mimeType
          ) {
            fail(
              "ARTIFACT_REFERENCE_MISMATCH",
              `included artifact does not match its selection reference: ${raw.path}`,
              raw.path,
            );
          }
          if (reference.state !== "ready") {
            fail(
              "ARTIFACT_REFERENCE_MISMATCH",
              `included artifact reference is not ready: ${raw.path}`,
              raw.path,
            );
          }
          if (
            typeof reference.storagePath !== "string" ||
            raw.path !== copiedArtifactPath(raw.artifactId, raw.sha256, reference.storagePath)
          ) {
            fail(
              "ARTIFACT_COPY_PATH_INVALID",
              `copied artifact path does not follow artifacts/<artifactId>-<sha256><ext>: ${raw.path}`,
              raw.path,
            );
          }
        }
        if (!qualifyingRights(selectionRightsById.get(raw.artifactId))) {
          fail(
            "ARTIFACT_RIGHTS_INVALID",
            `included artifact has no qualifying export rights: ${raw.path}`,
            raw.path,
          );
        }
      }
      if (totalBytes > MAX_COPIED_TOTAL_BYTES) {
        fail(
          "PACK_LIMIT_EXCEEDED",
          `included artifacts total ${totalBytes} bytes (limit ${MAX_COPIED_TOTAL_BYTES})`,
          MANIFEST,
        );
      }
      for (const decision of selectionMediaDecisions) {
        if (
          decision.included === true &&
          typeof decision.artifactId === "string" &&
          !declaredArtifactIds.has(decision.artifactId)
        ) {
          fail(
            "ARTIFACT_DECISION_MISMATCH",
            `selection media decision is not declared as included: ${decision.artifactId}`,
            SELECTION,
          );
        }
      }
      if (manifest.inclusionMode === "references" && artifacts.included.length > 0) {
        fail("NO_RAW_COPIES_REFERENCES", "references mode must not include copied artifacts", MANIFEST);
      }
    }
    if (!Array.isArray(artifacts.excluded)) {
      fail("MANIFEST_INVALID", "manifest artifacts.excluded must be an array", MANIFEST);
    } else {
      for (const raw of artifacts.excluded) {
        if (
          !jsonValue(raw) ||
          typeof raw.artifactId !== "string" ||
          !HASH.test(raw.artifactId) ||
          !isNonEmptyString(raw.reason)
        ) {
          fail("ARTIFACT_INVALID", "excluded artifact entry is invalid", MANIFEST);
        }
      }
      if (jsonValue(selection)) {
        const expected = selectionMediaDecisions
          .filter(
            (decision) =>
              decision.included === false &&
              typeof decision.artifactId === "string" &&
              isNonEmptyString(decision.reason),
          )
          .map((decision) => ({ artifactId: decision.artifactId, reason: decision.reason }));
        const actual = artifacts.excluded
          .filter(jsonValue)
          .map((entry) => ({ artifactId: entry.artifactId, reason: entry.reason }));
        if (!sameJsonSet(expected, actual)) {
          fail(
            "MANIFEST_DECISION_MISMATCH",
            "manifest artifacts.excluded does not match the selection media decisions",
            MANIFEST,
          );
        }
      }
    }
    if (!Array.isArray(artifacts.references)) {
      fail("MANIFEST_INVALID", "manifest artifacts.references must be an array", MANIFEST);
    } else {
      for (const raw of artifacts.references) {
        if (
          !jsonValue(raw) ||
          typeof raw.artifactId !== "string" ||
          !HASH.test(raw.artifactId) ||
          typeof raw.captureId !== "string" ||
          !isNullableString(raw.regionId) ||
          !isNonEmptyString(raw.kind) ||
          !isNonEmptyString(raw.mimeType) ||
          !isNonEmptyString(raw.state)
        ) {
          fail("ARTIFACT_INVALID", "artifact reference entry is incomplete", MANIFEST);
          continue;
        }
        if (typeof raw.storagePath === "string" && !safeRelativePath(raw.storagePath)) {
          fail("PATH_TRAVERSAL", `artifact reference path is unsafe: ${raw.storagePath}`, MANIFEST);
        } else if (!isNullableString(raw.storagePath)) {
          fail("ARTIFACT_INVALID", "artifact reference storagePath is invalid", MANIFEST);
        }
        if (!isNullableString(raw.sha256) || !isNullableNumber(raw.bytes)) {
          fail("ARTIFACT_INVALID", "artifact reference hash is invalid", MANIFEST);
        }
      }
      if (jsonValue(selection)) {
        const manifestReferences = artifacts.references.filter(jsonValue);
        if (
          new Set(manifestReferences.map((reference) => reference.artifactId)).size !==
            manifestReferences.length ||
          !sameJsonSet(manifestReferences, objectsOf(selection.references))
        ) {
          fail(
            "MANIFEST_DECISION_MISMATCH",
            "manifest artifact references do not match the selection",
            MANIFEST,
          );
        }
      }
    }
  }

  if (jsonValue(selection) && Array.isArray(selection.references)) {
    for (const raw of selection.references) {
      if (!jsonValue(raw)) continue;
      if (typeof raw.storagePath === "string" && !safeRelativePath(raw.storagePath)) {
        fail("PATH_TRAVERSAL", `selection reference path is unsafe: ${raw.storagePath}`, SELECTION);
      }
    }
  }

  if (jsonValue(selection) && Array.isArray(selection.media)) {
    for (const raw of selection.media) {
      if (!jsonValue(raw)) continue;
      if (raw.storagePath !== null && raw.storagePath !== undefined) {
        if (typeof raw.storagePath !== "string" || !safeRelativePath(raw.storagePath)) {
          fail("PATH_TRAVERSAL", "selection media path is unsafe", SELECTION);
        }
      }
      if (raw.copiedPath !== null && raw.copiedPath !== undefined) {
        if (
          typeof raw.copiedPath !== "string" ||
          !raw.copiedPath.startsWith("artifacts/") ||
          !safeRelativePath(raw.copiedPath)
        ) {
          fail("PATH_TRAVERSAL", "selection copied media path is unsafe", SELECTION);
        }
      }
    }
  }

  if (jsonValue(components) && Array.isArray(components.assets)) {
    for (const raw of components.assets) {
      if (!jsonValue(raw)) continue;
      if (raw.storagePath !== null && raw.storagePath !== undefined) {
        if (typeof raw.storagePath !== "string" || !safeRelativePath(raw.storagePath)) {
          fail("PATH_TRAVERSAL", "components asset path is unsafe", "components.json");
        }
      }
      if (raw.copiedPath !== null && raw.copiedPath !== undefined) {
        if (
          typeof raw.copiedPath !== "string" ||
          !raw.copiedPath.startsWith("artifacts/") ||
          !safeRelativePath(raw.copiedPath)
        ) {
          fail("PATH_TRAVERSAL", "components copied asset path is unsafe", "components.json");
        }
      }
    }
  }

  for (const file of fileEntries.keys()) {
    if (file.startsWith("artifacts/") && file !== SELECTION && !declaredCopies.has(file)) {
      fail("UNLISTED_FILE", `copied artifact is not declared: ${file}`, file);
    }
  }

  // --- cross-document equality and identity ---------------------------------
  if (jsonValue(selection) && selection.packId !== packId) {
    fail("SELECTION_MISMATCH", "selection artifact packId does not match manifest", SELECTION);
  }
  if (jsonValue(selection)) {
    if (selection.goal !== manifest.goal) {
      fail("SELECTION_MISMATCH", "selection goal does not match manifest", SELECTION);
    }
    const manifestRights = (Array.isArray(manifest.rightsAssertions)
      ? manifest.rightsAssertions
      : []
    ).filter(jsonValue);
    const selectedRights = objectsOf(selection.rightsAssertions);
    if (!sameJsonSet(manifestRights, selectedRights)) {
      fail(
        "SELECTION_MISMATCH",
        "manifest rights assertions do not match selection",
        MANIFEST,
      );
    }
    if (jsonValue(manifest.site) && selection.siteSlug !== manifest.site.slug) {
      fail("SELECTION_MISMATCH", "selection siteSlug does not match manifest", SELECTION);
    }
    if (
      jsonValue(manifest.site) &&
      isStringArray(manifest.site.sourceUrls) &&
      (!isStringArray(selection.sourceUrls) ||
        !sameMultiset(selection.sourceUrls, manifest.site.sourceUrls))
    ) {
      fail("SELECTION_MISMATCH", "selection sourceUrls do not match manifest", SELECTION);
    }
    if (selection.inclusionMode !== manifest.inclusionMode) {
      fail("SELECTION_MISMATCH", "selection inclusionMode does not match manifest", SELECTION);
    }
    if (manifestRegionIds && !sameMultiset(selectionIds, manifestRegionIds as string[])) {
      fail("SELECTION_MISMATCH", "selection regions do not match manifest regionIds", SELECTION);
    }
    if (
      manifestCaptureIds &&
      !sameMultiset(selectedCaptureIds, manifestCaptureIds as string[])
    ) {
      fail("SELECTION_MISMATCH", "selection captures do not match manifest captureIds", SELECTION);
    }
    const selectedCaptures = new Map(
      objectsOf(selection.captures)
        .filter((capture) => typeof capture.id === "string")
        .map((capture) => [capture.id as string, capture]),
    );
    for (const capture of objectsOf(manifest.captures)) {
      const selected = selectedCaptures.get(String(capture.id));
      if (!selected) {
        fail(
          "SELECTION_MISMATCH",
          "manifest capture identity does not match selection",
          MANIFEST,
        );
        continue;
      }
      if (
        selected.policy !== capture.policy ||
        selected.sourceDigest !== capture.sourceDigest ||
        selected.configHash !== capture.configHash ||
        selected.extractorVersion !== capture.extractorVersion ||
        selected.classifierVersion !== capture.classifierVersion
      ) {
        fail(
          "SELECTION_MISMATCH",
          "manifest capture identity does not match selection",
          MANIFEST,
        );
        continue;
      }
      // Complete-record comparison: viewport, browser, DPR, conditions and
      // observation dates are provenance, so a record that contradicts its
      // selection is not the observation the pack claims to export.
      if (canonicalJson(selected) !== canonicalJson(capture)) {
        fail(
          "MANIFEST_DECISION_MISMATCH",
          "manifest capture record does not match selection",
          MANIFEST,
        );
      }
    }
    const manifestClaimIdList = (Array.isArray(manifest.claimIds) ? manifest.claimIds : []).filter(
      (value): value is string => typeof value === "string",
    );
    if (!sameMultiset(selectionClaimIds, manifestClaimIdList)) {
      fail("CLAIM_MANIFEST_MISMATCH", "selection claims do not match manifest claimIds", SELECTION);
    }
    const identity = selectionIdentity(selection);
    if (!identity) {
      fail("SELECTION_INVALID", "selection is missing identity fields", SELECTION);
    } else {
      const derived = evidencePackId(identity, exporterVersion);
      if (derived !== packId) {
        fail("PACK_ID_MISMATCH", "derived pack id does not match manifest", MANIFEST);
      }
      const directory = basename(packDir);
      if (directory !== derived && !directory.startsWith(`.tmp-${derived}-`)) {
        fail("PACK_ID_MISMATCH", "pack directory does not match the derived pack id", SELECTION);
      }
    }
  }

  return { ok: errors.length === 0, packId, errors, warnings };
}

function selectionIdentity(selection: Record<string, unknown>): PackIdentityInput | null {
  const { siteSlug, goal, inclusionMode } = selection;
  if (
    !isNonEmptyString(siteSlug) ||
    !isNonEmptyString(goal) ||
    (inclusionMode !== "references" && inclusionMode !== "permitted")
  ) {
    return null;
  }
  const regions = objectsOf(selection.regions);
  const regionIds = regions.map((region) => region.regionId);
  if (regionIds.some((value) => typeof value !== "string")) return null;
  const captures = objectsOf(selection.captures).map((capture) => ({
    id: capture.id,
    sourceDigest: capture.sourceDigest,
    configHash: capture.configHash,
    extractorVersion: capture.extractorVersion,
    classifierVersion: capture.classifierVersion,
    policy: capture.policy,
  }));
  if (
    captures.some(
      (capture) =>
        typeof capture.id !== "string" ||
        !isNullableString(capture.sourceDigest) ||
        typeof capture.configHash !== "string" ||
        typeof capture.extractorVersion !== "string" ||
        typeof capture.classifierVersion !== "string" ||
        (capture.policy !== "allowed" &&
          capture.policy !== "denied" &&
          capture.policy !== "unknown"),
    )
  ) {
    return null;
  }
  const references = objectsOf(selection.references).map((reference) => ({
    artifactId: reference.artifactId,
    kind: reference.kind,
    sha256: reference.sha256,
    bytes: reference.bytes,
  }));
  if (
    references.some(
      (reference) =>
        typeof reference.artifactId !== "string" ||
        typeof reference.kind !== "string" ||
        !isNullableString(reference.sha256) ||
        !isNullableNumber(reference.bytes),
    )
  ) {
    return null;
  }
  const rights = objectsOf(selection.rightsAssertions).map((entry) => ({
    artifactId: entry.artifactId,
    rights: rightsRecordSchema.safeParse(entry.rights),
  }));
  if (rights.some((entry) => typeof entry.artifactId !== "string" || !entry.rights.success)) {
    return null;
  }
  return {
    siteSlug,
    goal,
    inclusionMode,
    regionIds: regionIds as string[],
    captures: captures as PackIdentityInput["captures"],
    references: references as PackIdentityInput["references"],
    rights: rights.map((entry) => ({
      artifactId: entry.artifactId as string,
      rights: (entry.rights as { success: true; data: PackIdentityInput["rights"][number]["rights"] }).data,
    })),
  };
}
