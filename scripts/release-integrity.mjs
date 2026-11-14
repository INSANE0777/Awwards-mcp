// Subresource Integrity string shared by the registry gate and the artifact
// verifier. Both must reject before a registry value reaches the shell.
import { createHash } from "node:crypto";

export const SRI_PATTERN = /^sha(1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

export function isSRI(value) {
  return typeof value === "string" && SRI_PATTERN.test(value);
}

// npm dist.integrity for a tarball is the base64 SHA-512 of its exact bytes.
export function computeIntegrity(bytes, algorithm = "sha512") {
  if (!Buffer.isBuffer(bytes)) throw new Error("computeIntegrity needs a Buffer");
  return `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`;
}
