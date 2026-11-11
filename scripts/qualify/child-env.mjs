// Child-process environment for installed qualification. Every spawned server
// and CLI gets an ephemeral HOME/APPDATA tree plus an explicit cache directory,
// so a qualification run can never create or read the operator's real
// ~/.awwwards-mcp cache.
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

const STRIPPED_KEYS = Object.freeze([
  "AWWWARDS_MCP_ATLAS",
  "AWARDS_MCP_ATLAS",
  "AWWWARDS_MCP_PROFILE",
  "AWARDS_MCP_PROFILE",
  "AWWWARDS_MCP_MAX_RESPONSE_BYTES",
  "AWARDS_MCP_MAX_RESPONSE_BYTES",
  "AWWWARDS_MCP_ATTACH",
  "AWWWARDS_MCP_IMAGE_MAX_BYTES",
  "AWWWARDS_MCP_IMAGE_RETENTION_DAYS",
  "NODE_PATH",
  "NODE_OPTIONS",
]);

const HOME_KEYS = Object.freeze([
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
]);

export function buildChildEnv({
  baseEnv = process.env,
  cacheDir,
  homeDir,
  flagOn = false,
  profile,
  playwrightBrowsersPath,
} = {}) {
  if (!cacheDir) throw new Error("buildChildEnv requires cacheDir");
  if (!homeDir) throw new Error("buildChildEnv requires homeDir");
  const env = {
    ...baseEnv,
    AWWWARDS_CACHE_DIR: cacheDir,
    AWWWARDS_AUTO_UPDATE: "0",
    AWWWARDS_MCP_DEBUG_MEMORY: "0",
  };
  for (const key of STRIPPED_KEYS) delete env[key];
  for (const key of HOME_KEYS) env[key] = homeDir;
  // Isolating HOME hides Playwright's default browser cache; keep the real
  // cache visible so the browser check does not try to download Chromium.
  if (playwrightBrowsersPath) env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath;
  if (flagOn) env.AWWWARDS_MCP_ATLAS = "1";
  if (profile) env.AWWWARDS_MCP_PROFILE = profile;
  return env;
}

function safeLstat(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

// Shallow, read-only snapshot of a cache directory. Any real use of the cache
// touches cache.db (or adds a top-level entry), which changes this fingerprint.
export function cacheFingerprint(dir) {
  const stat = safeLstat(dir);
  if (!stat) return { exists: false };
  let entries = [];
  try {
    entries = readdirSync(dir)
      .sort()
      .map((name) => {
        const entry = safeLstat(join(dir, name));
        return [name, entry?.isFile() ? entry.size : null, entry?.mtimeMs ?? null];
      });
  } catch {
    entries = [["<unreadable>", null, null]];
  }
  return { exists: true, dirMtimeMs: stat.mtimeMs, entries };
}

export function sameCacheFingerprint(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}
