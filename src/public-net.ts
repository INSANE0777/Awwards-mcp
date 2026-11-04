import { createHash } from "node:crypto";
import {
  createSceneUrlGate,
  defaultSceneResolveHost,
  startSceneProxy,
} from "./scene-capture.js";

export interface PublicNetworkGuard {
  /** Loopback proxy URL; pass to Playwright's browser proxy option. */
  proxyUrl: string;
  /** Requests refused by the gate after preflight (redirects, subresources). */
  blocked(): number;
  close(): Promise<void>;
}

export interface CaptureProvenance {
  schemaVersion: "awwwards-capture-provenance-v1";
  requestedUrlHash: string;
  finalUrl: string;
  capturedAt: number;
  viewport: string;
  settlePolicy: string;
  extractorVersion: 1;
}

export function captureProvenance(
  requestedUrl: string,
  finalUrl: string,
  viewport: string,
  settlePolicy: string,
): CaptureProvenance {
  return {
    schemaVersion: "awwwards-capture-provenance-v1",
    requestedUrlHash: createHash("sha256").update(requestedUrl).digest("hex"),
    finalUrl: redactUrl(finalUrl),
    capturedAt: Date.now(),
    viewport,
    settlePolicy,
    extractorVersion: 1,
  };
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.replace(/[?#].*$/, "").replace(/\/\/[^/@]*@/, "//");
  }
}

/**
 * Refuse a private/reserved destination before launching a browser, then route
 * every rendered connection through the same pinned DNS + private-address gate
 * used by scene capture. Test seams are intentionally not exposed here.
 */
export async function startPublicNetworkGuard(
  url: string,
): Promise<PublicNetworkGuard | { error: string }> {
  const gate = createSceneUrlGate(defaultSceneResolveHost, []);
  let allowed = false;
  try {
    allowed = await gate.allows(url);
  } catch {
    allowed = false;
  }
  if (!allowed) {
    return {
      error:
        `Refusing to load ${url}: publicOnly accepts http(s) URLs whose host resolves only to public addresses. ` +
        "Loopback, link-local, private, metadata and reserved destinations are blocked.",
    };
  }
  try {
    const proxy = await startSceneProxy(gate);
    return {
      proxyUrl: proxy.url,
      blocked: () => gate.blocked.count,
      close: () => proxy.close(),
    };
  } catch {
    return { error: "publicOnly could not start the local network guard for this page." };
  }
}
