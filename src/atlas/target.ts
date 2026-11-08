import type { Cache } from "../cache.js";
import type { SiteDetails } from "../types.js";
import type { AtlasTarget } from "./live-types.js";

export type AtlasTargetResult =
  | { ok: true; target: AtlasTarget }
  | { ok: false; code: string; message: string };

const TRACKING = new Set(["gclid", "fbclid"]);

function isTracking(key: string): boolean {
  return key.startsWith("utm_") || TRACKING.has(key);
}

function reject(code: string, message: string): AtlasTargetResult {
  return { ok: false, code, message };
}

/**
 * Resolve a known Awwwards reference to its live URL. The caller may select a
 * path on that origin but cannot provide an arbitrary URL.
 */
export function resolveAtlasTarget(
  input: { siteSlug: string; path?: string },
  deps: { cache: Cache },
): AtlasTargetResult {
  if (!/^[\w-]+$/.test(input.siteSlug)) {
    return reject("INVALID_SITE_SLUG", "siteSlug must be a known Awwwards slug");
  }
  const summary = deps.cache.getSite(input.siteSlug, Number.POSITIVE_INFINITY);
  const detail = deps.cache.getMeta<SiteDetails>(
    `detail:${input.siteSlug}`,
    Number.POSITIVE_INFINITY,
  );
  const liveUrl = summary?.liveUrl ?? detail?.liveUrl ?? null;
  if (!liveUrl) {
    return reject(
      "REFERENCE_UNAVAILABLE",
      `No usable live URL is cached for site ${input.siteSlug}`,
    );
  }

  let base: URL;
  try {
    base = new URL(liveUrl);
  } catch {
    return reject("REFERENCE_UNAVAILABLE", "The cached live URL is not absolute");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    return reject("UNSUPPORTED_PROTOCOL", "Only HTTP(S) live references are eligible");
  }
  if (base.username || base.password) {
    return reject("CREDENTIAL_URL", "Credential-bearing reference URLs are refused");
  }

  let target: URL;
  if (input.path !== undefined) {
    const path = input.path;
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("?") || path.includes("#")) {
      return reject(
        "UNSUPPORTED_ROUTE",
        "Explicit paths must start with one slash and may not contain a query or fragment",
      );
    }
    target = new URL(base.origin + path);
  } else {
    target = new URL(base.toString());
    target.hash = "";
    const kept: Array<[string, string]> = [];
    for (const [key, value] of target.searchParams) {
      if (!isTracking(key)) kept.push([key, value]);
    }
    if (kept.length > 0) {
      return reject(
        "UNSUPPORTED_ROUTE",
        "Meaningful query parameters are not supported for Atlas capture",
      );
    }
    target.search = "";
  }

  if (target.username || target.password) {
    return reject("CREDENTIAL_URL", "Credential-bearing reference URLs are refused");
  }
  return {
    ok: true,
    target: {
      siteSlug: input.siteSlug,
      requestedUrl: target.toString(),
      urlKey: `${target.origin}${target.pathname}`,
      path: target.pathname,
    },
  };
}
