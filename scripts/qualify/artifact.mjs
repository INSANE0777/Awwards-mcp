// Artifact identity for installed qualification. The release unit is the exact
// packed tarball: a supplied tarball is hashed as-is and installed from the same
// path, and the reported package identity is read back from the installed tree.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { computeIntegrity } from "../release-integrity.mjs";

const GZIP_MAGIC = [0x1f, 0x8b];

export function describeArtifactFile(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new Error("artifact path is required");
  }
  const resolved = realpathSync(resolve(filePath));
  const stats = statSync(resolved);
  if (!stats.isFile()) throw new Error(`artifact is not a regular file: ${filePath}`);
  const bytes = readFileSync(resolved);
  if (bytes.length === 0) throw new Error(`artifact is empty: ${filePath}`);
  if (bytes[0] !== GZIP_MAGIC[0] || bytes[1] !== GZIP_MAGIC[1]) {
    throw new Error(`artifact is not a gzipped npm tarball: ${filePath}`);
  }
  return {
    path: resolved,
    filename: basename(resolved),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: computeIntegrity(bytes),
  };
}

// The installed tree is authoritative: the report must not repeat checkout
// metadata for a package that was installed from somewhere else.
export function installedPackageDir(globalRoot) {
  const packages = readdirSync(globalRoot, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith("."),
  );
  if (packages.length !== 1) {
    throw new Error(
      `expected exactly one installed package under ${globalRoot}, found ` +
        `${packages.length}${packages.length > 0 ? ` (${packages.map((entry) => entry.name).join(", ")})` : ""}`,
    );
  }
  return join(globalRoot, packages[0].name);
}

// Files the installed package must ship, independent of npm pack's own list.
export const INSTALLED_REQUIRED_FILES = Object.freeze([
  "package.json",
  "dist/cli.js",
  "dist/index-cli.js",
  "README.md",
  "ATLAS.md",
]);

// A shipped path is unsafe when any segment is a dotfile or parent traversal,
// or when it is absolute. npm's root `.package-lock.json` is the one exception.
export function unsafeArtifactPath(file) {
  if (typeof file !== "string" || file.length === 0) return true;
  if (file === ".package-lock.json") return false;
  if (isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.startsWith("\\\\")) return true;
  return file
    .split(/[/\\]/)
    .some(
      (segment) =>
        segment === ".." ||
        segment.startsWith(".") ||
        // A drive or absolute segment anywhere would escape the package root.
        /^[A-Za-z]:/.test(segment) ||
        isAbsolute(segment),
    );
}

// The installed tree must hold only the release unit: required entry points are
// present and checkout-only files (sources, tests, docs, dotfiles) never leaked.
export function assertInstalledTree(files) {
  for (const required of INSTALLED_REQUIRED_FILES) {
    if (!files.includes(required)) throw new Error(`installed artifact is missing ${required}`);
  }
  const leaked = files.filter(
    (file) =>
      /^(src|test|scripts|docs|coverage)\//.test(file) || unsafeArtifactPath(file),
  );
  if (leaked.length > 0) {
    throw new Error(`installed artifact leaks checkout files: ${leaked.slice(0, 5).join(", ")}`);
  }
}

export function readInstalledIdentity(packageDir, expectedName) {
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  if (typeof pkg.name !== "string" || pkg.name.trim() === "") {
    throw new Error(`installed package has no name: ${packageDir}`);
  }
  if (typeof pkg.version !== "string" || pkg.version.trim() === "") {
    throw new Error(`installed package has no version: ${packageDir}`);
  }
  if (expectedName && pkg.name !== expectedName) {
    throw new Error(`installed package is ${pkg.name}, expected ${expectedName}`);
  }
  return { name: pkg.name, version: pkg.version, source: "installed-artifact" };
}
