// --skip-build guard: the existing dist is only trustworthy when it was built
// after the newest source file. A stale dist would qualify code that is not in
// the checkout, so the check fails closed.
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export function newestMtimeMs(dir) {
  let newest = null;
  for (const file of walkFiles(dir)) {
    try {
      const stat = lstatSync(file);
      if (newest === null || stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch {
      /* a file disappearing mid-walk cannot make the build fresher */
    }
  }
  return newest;
}

export function checkDistFreshness({ srcDir, distDir }) {
  const newestSrc = newestMtimeMs(srcDir);
  const newestDist = newestMtimeMs(distDir);
  if (newestSrc === null) {
    return { ok: false, newestSrc, newestDist, reason: `no source files found under ${srcDir}` };
  }
  if (newestDist === null) {
    return { ok: false, newestSrc, newestDist, reason: `no built files found under ${distDir}` };
  }
  if (newestDist < newestSrc) {
    return {
      ok: false,
      newestSrc,
      newestDist,
      reason:
        `dist is stale: newest source ${new Date(newestSrc).toISOString()} is newer than ` +
        `newest build ${new Date(newestDist).toISOString()}`,
    };
  }
  return {
    ok: true,
    newestSrc,
    newestDist,
    reason: `dist is newer than src (build ${new Date(newestDist).toISOString()})`,
  };
}
