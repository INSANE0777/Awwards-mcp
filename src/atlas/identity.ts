import { createHash } from "node:crypto";

/** Length-prefixed fields make ("ab","c") and ("a","bc") different inputs. */
export function stableHash(namespace: string, ...fields: string[]): string {
  const hash = createHash("sha256");
  hash.update(namespace);
  for (const field of fields) {
    hash.update(`\u0000${Buffer.byteLength(field, "utf8")}:${field}`);
  }
  return hash.digest("hex");
}

export function pageId(siteSlug: string, kind: string, urlKey: string): string {
  return stableHash("page-v1", siteSlug, kind, urlKey);
}

export function highlightIdentity(siteSlug: string, mediaPath: string): string {
  return stableHash("highlight-v1", siteSlug, mediaPath);
}

export function regionId(
  captureId: string,
  kind: string,
  ordinal: number,
  sourceIdentity: string,
): string {
  return stableHash("region-v1", captureId, kind, String(ordinal), sourceIdentity);
}

export function artifactId(
  captureId: string,
  kind: string,
  sha256: string,
  ordinal = 0,
): string {
  return stableHash("artifact-v1", captureId, kind, sha256, String(ordinal));
}

/** Capture identity excludes fetch time so unchanged projections deduplicate. */
export function captureId(
  page: string,
  profileKey: string,
  sourceDigest: string,
  configHash: string,
): string {
  return stableHash("capture-v1", page, profileKey, sourceDigest, configHash);
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Persisted section identity; the collector re-verifies it against the DOM. */
export function sectionFingerprint(
  selector: string,
  heading: string | null,
  text: string,
): string {
  return sha256Text(`${selector}|${heading ?? ""}|${text.slice(0, 80)}`);
}

/** Persisted component identity; type and pattern are structural, not content. */
export function componentFingerprint(
  selector: string,
  type: string,
  patternKey: string | null,
): string {
  return sha256Text(`${selector}|${type}|${patternKey ?? ""}`);
}

export function captureConfigHash(value: unknown): string {
  return sha256Text(JSON.stringify(value));
}
