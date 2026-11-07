export interface AtlasRobotsRule {
  allow: boolean;
  pattern: string;
}

export interface AtlasRobotsPolicy {
  rules: AtlasRobotsRule[];
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

function robotsPatternMatches(pattern: string, pathname: string): boolean {
  const anchored = pattern.endsWith("$");
  const source = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = source
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`).test(pathname);
}

function normalizeRobotsPath(pathname: string): string {
  const reserved = /^[A-Za-z0-9\-._~]$/;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let output = "";
  for (let index = 0; index < pathname.length; index += 1) {
    const char = pathname[index]!;
    if (char !== "%" || !/^[0-9A-Fa-f]{2}$/.test(pathname.slice(index + 1, index + 3))) {
      output += char;
      continue;
    }
    const first = Number.parseInt(pathname.slice(index + 1, index + 3), 16);
    if (first < 128) {
      const decoded = String.fromCharCode(first);
      output += reserved.test(decoded) ? decoded : `%${pathname.slice(index + 1, index + 3).toUpperCase()}`;
      index += 2;
      continue;
    }
    const bytes: number[] = [];
    let cursor = index;
    let consumed = false;
    while (cursor + 2 < pathname.length && pathname[cursor] === "%") {
      const hex = pathname.slice(cursor + 1, cursor + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) break;
      bytes.push(Number.parseInt(hex, 16));
      try {
        const text = decoder.decode(Uint8Array.from(bytes));
        output += text;
        index = cursor + 2;
        consumed = true;
        break;
      } catch {
        cursor += 3;
      }
    }
    if (!consumed) {
      output += `%${pathname.slice(index + 1, index + 3).toUpperCase()}`;
      index += 2;
    }
  }
  return output;
}

/** Parse the subset of robots.txt that Atlas collection needs. */
export function parseAtlasRobots(text: string, userAgent = "AwwwardsAtlas"): AtlasRobotsPolicy {
  const groups: Array<{ agents: string[]; rules: AtlasRobotsRule[] }> = [];
  let current: { agents: string[]; rules: AtlasRobotsRule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) {
      lastWasAgent = false;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!value) continue;
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key !== "allow" && key !== "disallow") continue;
    if (!current) {
      current = { agents: ["*"], rules: [] };
      groups.push(current);
    }
    if (value === "") continue;
    current.rules.push({ allow: key === "allow", pattern: value });
  }
  const agent = userAgent.toLowerCase();
  const agentTokens = agent.split(/[^a-z0-9._-]+/).filter(Boolean);
  const matchesAgent = (candidate: string): boolean =>
    agent.startsWith(candidate) || agentTokens.includes(candidate);
  const specific = groups
    .map((group) => {
      const token = group.agents
        .filter((candidate) => candidate !== "*" && matchesAgent(candidate))
        .sort((left, right) => right.length - left.length)[0];
      return token ? { group, token } : null;
    })
    .filter((entry): entry is { group: (typeof groups)[number]; token: string } => entry !== null);
  const wildcard = groups.filter((group) => group.agents.includes("*"));
  if (specific.length === 0) {
    return { rules: wildcard.flatMap((group) => group.rules) };
  }
  const mostSpecific = Math.max(...specific.map((entry) => entry.token.length));
  return {
    rules: specific
      .filter((entry) => entry.token.length === mostSpecific)
      .flatMap((entry) => entry.group.rules),
  };
}

export function robotsAllows(pathname: string, policy: AtlasRobotsPolicy): boolean {
  const normalized = normalizeRobotsPath(pathname);
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of policy.rules) {
    const pattern = normalizeRobotsPath(rule.pattern);
    if (!robotsPatternMatches(pattern, normalized)) continue;
    if (
      !best ||
      pattern.length > best.length ||
      (pattern.length === best.length && rule.allow)
    ) {
      best = { allow: rule.allow, length: pattern.length };
    }
  }
  return best?.allow ?? true;
}

export type AtlasRobotsFetchResult =
  | { status: number; text: string }
  | { error: string };

export async function checkAtlasRobots(
  url: URL,
  fetchRobots: (robotsUrl: string) => Promise<AtlasRobotsFetchResult>,
): Promise<{ allowed: boolean; limitation?: string }> {
  const robotsUrl = new URL("/robots.txt", url.origin).toString();
  const result = await fetchRobots(robotsUrl);
  if ("error" in result) {
    return { allowed: false, limitation: "ROBOTS_UNAVAILABLE" };
  }
  if (result.status === 404 || result.status === 410) return { allowed: true };
  if (result.status < 200 || result.status >= 300) {
    return { allowed: false, limitation: "ROBOTS_UNAVAILABLE" };
  }
  return { allowed: robotsAllows(`${url.pathname}${url.search}`, parseAtlasRobots(result.text.slice(0, 65_536))) };
}

export type AtlasRedirectResult =
  | { ok: true }
  | { ok: false; code: "DESTINATION_CHANGED" | "CREDENTIAL_URL"; message: string };

/** Same logical origin plus the release's exact www/non-www and HTTP→HTTPS rules. */
export function checkAtlasRedirect(
  requestedUrl: string,
  finalUrl: string,
  opts: { allowHttpToHttps?: boolean } = {},
): AtlasRedirectResult {
  let requested: URL;
  let final: URL;
  try {
    requested = new URL(requestedUrl);
    final = new URL(finalUrl);
  } catch {
    return {
      ok: false,
      code: "DESTINATION_CHANGED",
      message: "Redirect destination is not an absolute URL",
    };
  }
  if (requested.username || requested.password || final.username || final.password) {
    return {
      ok: false,
      code: "CREDENTIAL_URL",
      message: "Credential-bearing redirect destinations are refused",
    };
  }
  const httpsUpgrade =
    (opts.allowHttpToHttps ?? true) &&
    requested.protocol === "http:" &&
    final.protocol === "https:";
  if (!httpsUpgrade && requested.protocol !== final.protocol) {
    return {
      ok: false,
      code: "DESTINATION_CHANGED",
      message: "Redirect protocol changed",
    };
  }
  if (normalizeHost(requested.host) !== normalizeHost(final.host)) {
    return {
      ok: false,
      code: "DESTINATION_CHANGED",
      message: "Cross-host redirects are refused",
    };
  }
  const requestedPath = requested.pathname.replace(/\/+$/, "") || "/";
  const finalPath = final.pathname.replace(/\/+$/, "") || "/";
  if (requestedPath !== finalPath) {
    return {
      ok: false,
      code: "DESTINATION_CHANGED",
      message: "Redirect changed the destination path",
    };
  }
  if (requested.search !== final.search) {
    return {
      ok: false,
      code: "DESTINATION_CHANGED",
      message: "Redirect added or changed query parameters",
    };
  }
  return { ok: true };
}

/** URLs that may be mutated by the collector are refused; GET/HEAD only. */
export function isMutatingMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}
