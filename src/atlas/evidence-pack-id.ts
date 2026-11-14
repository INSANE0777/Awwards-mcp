import { ATLAS_CLASSIFIER_VERSION, ATLAS_FTS_VERSION, ATLAS_SCHEMA_VERSION } from "./schema.js";
import { ATLAS_VOCABULARY_VERSION } from "./vocabulary.js";
import { stableHash } from "./identity.js";
import {
  EVIDENCE_PACK_EXPORTER_VERSION,
  type InclusionMode,
  type PackExporterVersion,
  type PolicyState,
} from "./evidence-pack-types.js";
import type { RightsRecord } from "./types.js";

export interface PackIdentityCapture {
  id: string;
  sourceDigest: string | null;
  configHash: string;
  extractorVersion: string;
  classifierVersion: string;
  policy: PolicyState;
}

export interface PackIdentityReference {
  artifactId: string;
  kind: string;
  sha256: string | null;
  bytes: number | null;
}

export interface PackIdentityInput {
  siteSlug: string;
  goal: string;
  inclusionMode: InclusionMode;
  regionIds: string[];
  captures: PackIdentityCapture[];
  references: PackIdentityReference[];
  rights: Array<{ artifactId: string; rights: RightsRecord }>;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Deterministic pack identity; the creation clock is deliberately excluded. */
export function evidencePackId(
  input: PackIdentityInput,
  exporterVersion: PackExporterVersion = EVIDENCE_PACK_EXPORTER_VERSION,
): string {
  const captureIdentity = input.captures.map((capture) =>
    JSON.stringify([
      capture.id,
      capture.sourceDigest,
      capture.configHash,
      capture.extractorVersion,
      capture.classifierVersion,
      capture.policy,
    ]),
  );
  const artifactIdentity = input.references
    .map((reference) =>
      JSON.stringify([reference.artifactId, reference.kind, reference.sha256, reference.bytes]),
    )
    .sort(compareText);
  const rightsIdentity = input.rights.map((entry) =>
    JSON.stringify([
      entry.artifactId,
      entry.rights.status,
      entry.rights.scope,
      entry.rights.reference,
      entry.rights.assertedBy,
      entry.rights.recordedAt,
    ]),
  );
  return stableHash(
    "evidence-pack-v1",
    input.siteSlug,
    input.goal,
    input.inclusionMode,
    JSON.stringify([...input.regionIds].sort(compareText)),
    JSON.stringify(captureIdentity),
    JSON.stringify(artifactIdentity),
    JSON.stringify(rightsIdentity),
    ATLAS_VOCABULARY_VERSION,
    ATLAS_CLASSIFIER_VERSION,
    exporterVersion,
    String(ATLAS_SCHEMA_VERSION),
    String(ATLAS_FTS_VERSION),
  );
}
