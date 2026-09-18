// Update notification: once a day, compare the running version against the
// npm registry and (optionally) self-update. Designed around the constraints
// of a stdio MCP server:
//   - stdout is the JSON-RPC channel → every notice goes to stderr only
//   - serving must never wait on this → fire-and-forget, 3s timeout,
//     every failure swallowed (registry unreachable / package unpublished)
//   - at most one registry hit per day per machine (state in the cache dir)
// Auto-update is strictly opt-in: AWWWARDS_AUTO_UPDATE=1 runs
// `npm install -g awwwards-mcp@<latest>` detached, then asks the user to
// restart their agent; without the env var, the notice just tells the agent.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const REGISTRY_URL = "https://registry.npmjs.org/awwwards-mcp/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function parseVersion(v: string): [number, number, number] {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 1 when a > b, -1 when a < b, 0 when equal. Unparseable sorts as oldest. */
export function compareVersions(a: string, b: string): number {
  const [pa, pb] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

type CheckState = { checkedAt: number; latest?: string };

function stateFile(): string {
  const cacheRoot =
    process.env.AWWWARDS_CACHE_DIR ?? join(homedir(), ".awwwards-mcp");
  return join(cacheRoot, "version-check.json");
}

function readState(): CheckState | null {
  try {
    if (!existsSync(stateFile())) return null;
    return JSON.parse(readFileSync(stateFile(), "utf8")) as CheckState;
  } catch {
    return null;
  }
}

function writeState(state: CheckState): void {
  try {
    mkdirSync(join(stateFile(), ".."), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(state));
  } catch {
    // notification is best-effort; an unwritable cache dir is fine
  }
}

export function buildUpdateNotice(
  current: string,
  latest: string,
  autoUpdateEnabled: boolean,
): string | null {
  if (compareVersions(latest, current) <= 0) return null;
  const lines = [
    `awwwards-mcp: update available — v${latest} (running v${current}).`,
    autoUpdateEnabled
      ? `awwwards-mcp: v${latest} is being installed in the background; restart your agent to load it.`
      : `awwwards-mcp: update with \`npm install -g awwwards-mcp@latest\` (or clear your npx cache), or set AWWWARDS_AUTO_UPDATE=1 to self-update on startup.`,
  ];
  return lines.join("\n");
}

/**
 * Fire-and-forget update check. Never throws, never blocks the caller:
 * registry errors, timeouts, and unwritable state files are all swallowed.
 */
export function checkForUpdate(currentVersion: string): void {
  const auto = process.env.AWWWARDS_AUTO_UPDATE === "1";
  // Skip the daily gate when auto-update is on but no latest is known yet?
  // No: state gates the fetch itself, so a fresh install always has a shot.
  const state = readState();
  if (state && Date.now() - state.checkedAt < CHECK_INTERVAL_MS) {
    // within the interval: reuse the known latest to (re)warn without fetching
    if (state.latest) {
      const notice = buildUpdateNotice(currentVersion, state.latest, auto);
      if (notice) console.error(notice);
    }
    return;
  }

  void (async () => {
    try {
      const res = await fetch(REGISTRY_URL, {
        signal: AbortSignal.timeout(3000),
        headers: { accept: "application/json" },
      });
      if (!res.ok) return; // unpublished / registry hiccup → silent
      const data = (await res.json()) as { version?: string };
      if (!data?.version) return;
      writeState({ checkedAt: Date.now(), latest: data.version });
      const notice = buildUpdateNotice(currentVersion, data.version, auto);
      if (notice) console.error(notice);
      if (notice && auto) startSelfUpdate(data.version);
    } catch {
      // offline / timeout / JSON garbage — never surface, never block
    }
  })();
}

function startSelfUpdate(version: string): void {
  try {
    const child = spawn(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "-g", `awwwards-mcp@${version}`],
      { detached: true, stdio: "ignore" },
    );
    child.on("error", () => {
      console.error(
        `awwwards-mcp: background self-update failed to start — install manually with \`npm install -g awwwards-mcp@${version}\``,
      );
    });
    child.unref();
  } catch {
    // self-update is best-effort; the notice already told the user what to do
  }
}
