import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { CAPTURE_INSTALL_HINT, waitForOverlays } from "../capture.js";
import { preScroll } from "../structure.js";
import { resolveViewport } from "../viewport.js";
import {
  createSceneUrlGate,
  defaultSceneResolveHost,
  fetchSceneBinaryResponse,
  fetchSceneHtmlResponse,
  normalizeScenePrivateOrigins,
  startSceneProxy,
} from "../scene-capture.js";
import {
  isValidPngBuffer,
  removeArtifactFileSync,
  writeArtifactBytesSync,
  writeJsonArtifactSync,
} from "./artifacts.js";
import { classifySections } from "./classification.js";
import { stableHash } from "./identity.js";
import {
  acquireAtlasCaptureLease,
  releaseAtlasCaptureLease,
  type AtlasCaptureLease,
} from "./lease.js";
import {
  checkAtlasRedirect,
  isMutatingMethod,
  parseAtlasRobots,
  robotsAllows,
  type AtlasRobotsPolicy,
} from "./policy.js";
import { ATLAS_SECTION_SCAN } from "./scan.js";
import { regionStableKey, segmentRegionsWithStats } from "./segmentation.js";
import { resolveAtlasTarget } from "./target.js";
import type {
  AtlasCaptureAttempt,
  AtlasClaim,
  AtlasCollectDeps,
  AtlasCollectInput,
  AtlasObservation,
  AtlasPageScan,
  AtlasScanSection,
  AtlasStoredArtifact,
  AtlasViewportCapture,
  AtlasViewportProfile,
  RegionCandidate,
} from "./live-types.js";

const TOTAL_BUDGET_MS = 90_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_CHECKPOINTS = 6;
const MAX_SCREENSHOT_BYTES = 64 * 1024 * 1024;
const MAX_SCREENSHOT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SCREENSHOTS = 18;

export class AtlasCollectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AtlasCollectionError";
  }
}

function isPng(buffer: Buffer): boolean {
  return isValidPngBuffer(buffer);
}

function pickFixtureHeaders(headers?: Record<string, string>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of ["content-type", "cache-control"]) {
    if (headers?.[key]) picked[key] = headers[key]!;
  }
  return picked;
}

function withTimeout<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new AtlasCollectionError(code, "The capture exceeded its deadline"));
    }, Math.max(1, ms));
    timer.unref?.();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function viewportOptions(viewport: AtlasViewportProfile) {
  return resolveViewport(viewport);
}

async function scrollTo(
  page: Page,
  scrollRoot: string | null,
  y: number,
): Promise<{ found: boolean; unique: boolean; scrollY: number }> {
  return page.evaluate(
    ({ root, top }: { root: string | null; top: number }) => {
      const g = globalThis as any;
      if (root) {
        // A duplicated label cannot say which element owns the scroll: report
        // it instead of scrolling whichever match happens to come first. A
        // page-controlled label that no longer parses is the same refusal.
        let matches: any = null;
        try {
          matches = g.document.querySelectorAll(root);
        } catch {
          matches = null;
        }
        if (!matches || matches.length !== 1) {
          return { found: Boolean(matches && matches.length > 0), unique: false, scrollY: 0 };
        }
        const el = matches[0];
        // Pin smooth scrolling for this jump, then restore: an inner root with
        // scroll-behavior:smooth would otherwise animate past the screenshot.
        const inlineBehavior = el.style ? el.style.getPropertyValue("scroll-behavior") : "";
        const inlinePriority = el.style ? el.style.getPropertyPriority("scroll-behavior") : "";
        try {
          if (el.style) el.style.setProperty("scroll-behavior", "auto", "important");
          el.scrollTo({ top, behavior: "instant" });
        } finally {
          if (el.style) {
            if (inlineBehavior) el.style.setProperty("scroll-behavior", inlineBehavior, inlinePriority);
            else el.style.removeProperty("scroll-behavior");
          }
        }
        return { found: true, unique: true, scrollY: Number(el.scrollTop || 0) };
      }
      // Instant beats a page's scroll-behavior:smooth, which would otherwise
      // put the capture mid-animation.
      g.window.scrollTo({ left: 0, top, behavior: "instant" });
      return { found: true, unique: true, scrollY: Number(g.window.scrollY || 0) };
    },
    { root: scrollRoot, top: y },
  );
}

async function measureScrollOffsets(
  page: Page,
  scrollRoot: string | null,
): Promise<{
  found: boolean;
  unique: boolean;
  documentX: number;
  documentY: number;
  rootX: number;
  rootY: number;
}> {
  return page.evaluate(({ root }: { root: string | null }) => {
    const g = globalThis as any;
    let matches: any = null;
    try {
      matches = root ? g.document.querySelectorAll(root) : null;
    } catch {
      matches = null;
    }
    const el = matches && matches.length === 1 ? matches[0] : null;
    return {
      found: root ? Boolean(matches && matches.length > 0) : true,
      unique: root ? Boolean(matches && matches.length === 1) : true,
      documentX: Number(g.window.scrollX || 0),
      documentY: Number(g.window.scrollY || 0),
      rootX: el ? Number(el.scrollLeft || 0) : Number(g.window.scrollX || 0),
      rootY: el ? Number(el.scrollTop || 0) : Number(g.window.scrollY || 0),
    };
  }, { root: scrollRoot });
}

function normalizeScan(raw: AtlasPageScan): AtlasPageScan {
  const rawSections = Array.isArray(raw.sections) ? raw.sections : [];
  const sections = rawSections.slice(0, 80);
  return {
    title: String(raw.title ?? "").slice(0, 500),
    url: String(raw.url ?? "").slice(0, 2048),
    totalHeight: Math.max(0, Number(raw.totalHeight) || 0),
    scrollRoot: typeof raw.scrollRoot === "string" ? raw.scrollRoot : null,
    scrollRootClientHeight:
      typeof raw.scrollRootClientHeight === "number" ? raw.scrollRootClientHeight : null,
    scrollRootScrollLeft:
      typeof raw.scrollRootScrollLeft === "number" ? raw.scrollRootScrollLeft : null,
    scrollRootScrollTop:
      typeof raw.scrollRootScrollTop === "number" ? raw.scrollRootScrollTop : null,
    scrollX: typeof raw.scrollX === "number" ? raw.scrollX : 0,
    scrollY: typeof raw.scrollY === "number" ? raw.scrollY : 0,
    sectionLimitHit: raw.sectionLimitHit === true || rawSections.length > 80,
    nodeBudgetHit: raw.nodeBudgetHit === true,
    rawSectionCount:
      typeof raw.rawSectionCount === "number" ? raw.rawSectionCount : rawSections.length,
    sections: sections.filter(
      (section): section is AtlasScanSection =>
        Boolean(section) &&
        typeof section === "object" &&
        typeof section.selector === "string" &&
        typeof section.tag === "string",
    ),
    technologies: Array.isArray(raw.technologies)
      ? raw.technologies.filter((value): value is string => typeof value === "string").slice(0, 64)
      : [],
    canvasCount: Math.max(0, Number(raw.canvasCount) || 0),
    webglObserved: raw.webglObserved === true,
  };
}

/**
 * One guarded lifecycle for both viewport profiles. Browser, proxy, contexts
 * and temporary artifacts are owned by this function and closed in finally.
 */
export async function collectAtlasPage(
  input: AtlasCollectInput,
  deps: AtlasCollectDeps,
): Promise<AtlasCaptureAttempt> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const deadline = startedAt + (deps.totalBudgetMs ?? TOTAL_BUDGET_MS);
  if (deadline <= now()) {
    throw new AtlasCollectionError("CAPTURE_DEADLINE_EXCEEDED", "The capture budget is exhausted");
  }
  const targetResult = resolveAtlasTarget(input, { cache: deps.cache });
  if (!targetResult.ok) {
    throw new AtlasCollectionError(targetResult.code, targetResult.message);
  }
  const target = targetResult.target;
  const origins = normalizeScenePrivateOrigins(deps.allowPrivateOrigins);
  if ("error" in origins) throw new AtlasCollectionError("POLICY_CONFIG", origins.error);
  const gate = createSceneUrlGate(
    deps.resolveHost ?? defaultSceneResolveHost,
    origins.origins,
  );
  const robotsCache = new Map<string, AtlasRobotsPolicy | null>();
  const robotsFor = async (url: URL): Promise<AtlasRobotsPolicy | null> => {
    if (robotsCache.has(url.origin)) return robotsCache.get(url.origin) ?? null;
    const response = await fetchSceneHtmlResponse(
      gate,
      new URL("/robots.txt", url.origin).toString(),
      {
        timeoutMs: Math.max(1, Math.min(4_000, deadline - now())),
        maxBytes: 65_536,
      },
    );
    let policy: AtlasRobotsPolicy | null = null;
    if (response.error && response.status === undefined) {
      policy = null;
    } else if (response.status === 404 || response.status === 410) {
      policy = { rules: [] };
    } else if (response.status !== undefined && (response.status < 200 || response.status >= 300)) {
      policy = null;
    } else {
      policy = parseAtlasRobots((response.body ?? "").slice(0, 65_536));
    }
    robotsCache.set(url.origin, policy);
    return policy;
  };
  const hopAllowed = async (
    raw: string,
  ): Promise<{ ok: boolean; privateDestination: boolean }> => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, privateDestination: false };
    }
    let allowed = false;
    try {
      allowed = await withTimeout(
        gate.allows(url.toString()),
        Math.max(1, deadline - now()),
        "CAPTURE_DEADLINE_EXCEEDED",
      );
    } catch (error) {
      if (error instanceof AtlasCollectionError) throw error;
      allowed = false;
    }
    if (!allowed) return { ok: false, privateDestination: true };
    const policy = await robotsFor(url);
    if (policy === null) return { ok: false, privateDestination: false };
    return { ok: robotsAllows(`${url.pathname}${url.search}`, policy), privateDestination: false };
  };
  const initialPolicy = await withTimeout(
    hopAllowed(target.requestedUrl),
    Math.max(1, deadline - now()),
    "CAPTURE_DEADLINE_EXCEEDED",
  );
  if (!initialPolicy.ok) {
    throw new AtlasCollectionError(
      initialPolicy.privateDestination ? "PRIVATE_DESTINATION" : "ROBOTS_DENIED",
      initialPolicy.privateDestination
        ? "The target resolves to a private, loopback, metadata or reserved destination"
        : "The reference's robots policy refuses Atlas collection",
    );
  }
  let preflightBlocked = false;
  let preflightPrivate = false;
  let preflightDestinationChanged = false;
  const preflight = await withTimeout(
    fetchSceneHtmlResponse(gate, target.requestedUrl, {
      timeoutMs: Math.max(1, Math.min(8_000, deadline - now())),
      maxBytes: 1_048_576,
      onHop: async (url, previous) => {
        const hop = await hopAllowed(url);
        if (!hop.ok && hop.privateDestination) {
          preflightBlocked = true;
          preflightPrivate = true;
          return false;
        }
        if (previous) {
          const identity = checkAtlasRedirect(previous, url);
          if (!identity.ok) {
            preflightDestinationChanged = true;
            return false;
          }
        }
        if (!hop.ok) preflightBlocked = true;
        return hop.ok;
      },
    }),
    Math.max(1, deadline - now()),
    "CAPTURE_DEADLINE_EXCEEDED",
  );
  if (preflightDestinationChanged) {
    throw new AtlasCollectionError(
      "DESTINATION_CHANGED",
      "A redirect destination changes the reference identity",
    );
  }
  if (preflightBlocked) {
    throw new AtlasCollectionError(
      preflightPrivate ? "PRIVATE_DESTINATION" : "ROBOTS_DENIED",
      preflightPrivate
        ? "A redirect destination resolves to a private, loopback, metadata or reserved address"
        : "A redirect destination is refused by robots or network policy",
    );
  }
  if (preflight.error) {
    const privateDestination = /loopback|link-local|private|metadata|reserved/i.test(
      preflight.error,
    );
    throw new AtlasCollectionError(
      privateDestination ? "PRIVATE_DESTINATION" : "PREFLIGHT_FAILED",
      preflight.error,
    );
  }
  const navigationUrl = preflight.finalUrl ?? target.requestedUrl;
  const navigationRedirect = checkAtlasRedirect(target.requestedUrl, navigationUrl);
  if (!navigationRedirect.ok) {
    throw new AtlasCollectionError(navigationRedirect.code, navigationRedirect.message);
  }

  let lease: AtlasCaptureLease | undefined;
  try {
    lease = acquireAtlasCaptureLease(deps.cache.rootDir, {
      ttlMs: (deps.totalBudgetMs ?? 90_000) + 60_000,
    });
  } catch (error) {
    throw new AtlasCollectionError(
      (error as { code?: string }).code ?? "CAPTURE_BUSY",
      error instanceof Error ? error.message : "Another Atlas capture owns this cache",
    );
  }

  let chromium: any;
  try {
    const loaded = await withTimeout(
      Promise.resolve((deps.loader ?? (() => import("playwright" as string)))()),
      Math.max(1, deadline - now()),
      "CAPTURE_DEADLINE_EXCEEDED",
    );
    chromium = loaded.chromium;
  } catch (error) {
    if (lease) releaseAtlasCaptureLease(lease) || releaseAtlasCaptureLease(lease);
    if (error instanceof AtlasCollectionError) throw error;
    throw new AtlasCollectionError("BROWSER_UNAVAILABLE", CAPTURE_INSTALL_HINT);
  }
  if (!chromium) {
    if (lease) releaseAtlasCaptureLease(lease) || releaseAtlasCaptureLease(lease);
    throw new AtlasCollectionError("BROWSER_UNAVAILABLE", CAPTURE_INSTALL_HINT);
  }

  let proxy: { url: string; close(): Promise<void> } | undefined;
  let browser: any;
  const artifacts: AtlasStoredArtifact[] = [];
  const viewports: AtlasViewportCapture[] = [];
  let screenshotBytes = 0;
  let artifactBytes = 0;
  let screenshotCount = 0;
  const attemptLimitations: string[] = [];
  let cancelled = false;
  let policyBlocked = false;

  const close = async (resource: any): Promise<void> => {
    if (!resource) return;
    try {
      await Promise.race([
        Promise.resolve().then(() => resource.close()),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 4_000);
          t.unref?.();
        }),
      ]);
    } catch {
      /* cleanup is best effort and must not mask the primary result */
    }
  };
  const abort = () => {
    cancelled = true;
  };
  if (deps.signal?.aborted) cancelled = true;
  deps.signal?.addEventListener("abort", abort, { once: true });
  try {
    const proxyPromise = startSceneProxy(gate);
    try {
      proxy = await withTimeout(
        proxyPromise,
        Math.max(1, deadline - now()),
        "CAPTURE_DEADLINE_EXCEEDED",
      );
    } catch (error) {
      void proxyPromise.then((late) => close(late)).catch(() => undefined);
      throw error;
    }
    const launch = Promise.resolve().then(() =>
      chromium.launch({
        proxy: { server: proxy!.url, bypass: "<-loopback>" },
      }),
    );
    try {
      browser = await withTimeout(
        launch,
        Math.max(1, deadline - now()),
        "CAPTURE_DEADLINE_EXCEEDED",
      );
    } catch (error) {
      // The loader may still resolve after the watchdog; close that late browser.
      void launch.then((late) => close(late)).catch(() => undefined);
      throw error;
    }
    const browserVersion = String(browser.version?.() ?? "unknown");
    const requestedProfiles = input.viewports ?? ["desktop", "mobile"];
    for (const viewport of [...new Set(requestedProfiles)]) {
      if (cancelled) break;
      if (now() > deadline) {
        attemptLimitations.push("CAPTURE_DEADLINE_EXCEEDED");
        break;
      }
      const profile = viewportOptions(viewport);
      const limitations: string[] = [];
      const checkpointExcludedKeys = new Set<string>();
      let normalizationDropped = 0;
      const markCheckpointExcluded = (
        scanValue: AtlasPageScan,
        kept: RegionCandidate[],
      ): void => {
        const keptKeys = new Set(kept.map((region) => regionStableKey(region)));
        for (const section of scanValue.sections) {
          const stable = regionStableKey(section as unknown as RegionCandidate);
          if (!keptKeys.has(stable)) checkpointExcludedKeys.add(stable);
        }
        normalizationDropped = Math.max(
          normalizationDropped,
          Math.max(
            0,
            (scanValue.rawSectionCount ?? scanValue.sections.length) - scanValue.sections.length,
          ),
        );
      };
      let viewportPolicyBlocked = false;
      const markPolicyBlocked = (): void => {
        policyBlocked = true;
        viewportPolicyBlocked = true;
      };
      let context: any;
      let routeHandler: ((route: any) => Promise<void>) | undefined;
      try {
        const contextPromise = browser.newContext({
          viewport: { width: profile.width, height: profile.height },
          deviceScaleFactor: profile.deviceScaleFactor,
          isMobile: profile.isMobile,
          hasTouch: profile.hasTouch,
          serviceWorkers: "block",
          acceptDownloads: false,
        });
        try {
          context = await withTimeout(
            contextPromise,
            Math.max(1, deadline - now()),
            "CAPTURE_DEADLINE_EXCEEDED",
          );
        } catch (error) {
          void contextPromise.then((late: any) => close(late)).catch(() => undefined);
          throw error;
        }
        const popups: string[] = [];
        const pagePromise = context.newPage();
        let page: any;
        try {
          page = await withTimeout(
            pagePromise,
            Math.max(1, deadline - now()),
            "CAPTURE_DEADLINE_EXCEEDED",
          );
        } catch (error) {
          void pagePromise.then((late: any) => close(late)).catch(() => undefined);
          throw error;
        }
        context.on?.("page", (popup: any) => {
          if (popup === page) return;
          popups.push("popup");
          void popup?.close?.().catch?.(() => undefined);
        });
        await page.addInitScript?.(
          "globalThis.__name = globalThis.__name || function (fn) { return fn; };",
        );
        routeHandler = async (route: any) => {
          try {
            const request = route.request?.();
            const method = String(request?.method?.() ?? "GET");
            if (isMutatingMethod(method)) {
              await route.abort("blockedbyclient");
              return;
            }
            const requestUrl = String(request?.url?.() ?? "");
            const isHttp = /^https?:/i.test(requestUrl);
            const isFixtureOrigin = (() => {
              try {
                return origins.origins.includes(new URL(requestUrl).origin);
              } catch {
                return false;
              }
            })();
            let frame: any = null;
            try {
              frame = typeof request?.frame === "function" ? request.frame() : null;
            } catch {
              frame = null;
            }
            const main = typeof page.mainFrame === "function" ? page.mainFrame() : null;
            const isMainDocument = Boolean(
              request?.isNavigationRequest?.() && (!frame || !main || frame === main),
            );
            if (request?.isNavigationRequest?.() && isHttp) {
              const previous = request.redirectedFrom?.()?.url?.() ?? null;
              if (isMainDocument && !previous && requestUrl !== navigationUrl) {
                const initialIdentity = checkAtlasRedirect(navigationUrl, requestUrl);
                if (!initialIdentity.ok) {
                  await route.abort("blockedbyclient");
                  return;
                }
              }
              const initialHop = await hopAllowed(requestUrl);
              if (!initialHop.ok) {
                markPolicyBlocked();
                await route.abort("blockedbyclient");
                return;
              }
              let blocked = false;
              if (isFixtureOrigin) {
                const fetched = await fetchSceneBinaryResponse(gate, requestUrl, {
                  timeoutMs: Math.max(1, Math.min(15_000, deadline - now())),
                  maxBytes: 8 * 1024 * 1024,
                  onHop: async (url, prior) => {
                    if (isMainDocument && prior) {
                      const identity = checkAtlasRedirect(navigationUrl, url);
                      if (!identity.ok) {
                        blocked = true;
                        return false;
                      }
                    }
                    const hop = await hopAllowed(url);
                    if (!hop.ok) blocked = true;
                    return hop.ok;
                  },
                });
                if (blocked || fetched.error || fetched.body === undefined) {
                  if (blocked) markPolicyBlocked();
                  await route.abort("blockedbyclient");
                  return;
                }
                await route.fulfill({
                  status: fetched.status ?? 200,
                  body: fetched.body,
                  headers: pickFixtureHeaders(fetched.headers),
                });
                return;
              }
              const fetched = await fetchSceneHtmlResponse(gate, requestUrl, {
                timeoutMs: Math.max(1, Math.min(15_000, deadline - now())),
                maxBytes: 8 * 1024 * 1024,
                onHop: async (url, prior) => {
                  if (isMainDocument && prior) {
                    const identity = checkAtlasRedirect(navigationUrl, url);
                    if (!identity.ok) {
                      blocked = true;
                      return false;
                    }
                  }
                  const hop = await hopAllowed(url);
                  if (!hop.ok) blocked = true;
                  return hop.ok;
                },
              });
              if (blocked || fetched.error || fetched.body === undefined) {
                if (blocked) markPolicyBlocked();
                await route.abort("blockedbyclient");
                return;
              }
              await route.fulfill({
                status: fetched.status ?? 200,
                body: fetched.body,
                headers: { "content-type": "text/html; charset=utf-8" },
              });
              return;
            }
            if (!isHttp) {
              await route.continue();
              return;
            }
            const hop = await hopAllowed(requestUrl);
            if (!hop.ok) {
              markPolicyBlocked();
              limitations.push("BLOCKED_DESTINATION");
              await route.abort("blockedbyclient");
              return;
            }
            // Follow subresource redirects ourselves so a denied destination
            // is refused before the browser transports it.
            if (isFixtureOrigin) {
              let policyDenied = false;
              const fetched = await fetchSceneBinaryResponse(gate, requestUrl, {
                timeoutMs: Math.max(1, Math.min(15_000, deadline - now())),
                maxBytes: 8 * 1024 * 1024,
                onHop: async (url) => {
                  const nextHop = await hopAllowed(url);
                  if (!nextHop.ok) policyDenied = true;
                  return nextHop.ok;
                },
              });
              if (policyDenied) markPolicyBlocked();
              if (fetched.error || fetched.body === undefined) {
                if (fetched.reason === "policy") {
                  markPolicyBlocked();
                  limitations.push("BLOCKED_DESTINATION");
                } else if (fetched.reason === "redirect_limit") {
                  limitations.push("REDIRECT_LIMIT");
                } else {
                  limitations.push("RESOURCE_NETWORK_ERROR");
                }
                await route.abort("blockedbyclient");
                return;
              }
              await route.fulfill({
                status: fetched.status ?? 200,
                body: fetched.body,
                headers: pickFixtureHeaders(fetched.headers),
              });
              return;
            }
            let current = requestUrl;
            let response = await route.fetch({ maxRedirects: 0 });
            let redirected = true;
            for (let redirects = 0; redirects < 5; redirects += 1) {
              if (response.status() < 300 || response.status() >= 400) {
                redirected = false;
                break;
              }
              const location = response.headers()["location"];
              if (!location) {
                redirected = false;
                break;
              }
              const next = new URL(location, current).toString();
              const nextHop = await hopAllowed(next);
              if (!nextHop.ok) {
                markPolicyBlocked();
                await route.abort("blockedbyclient");
                return;
              }
              current = next;
              response = await route.fetch({ url: current, maxRedirects: 0 });
            }
            if (
              redirected &&
              !(response.status() < 300 || response.status() >= 400)
            ) {
              limitations.push("REDIRECT_LIMIT");
              await route.abort("blockedbyclient");
              return;
            }
            await route.fulfill({ response });
          } catch {
            try {
              await route.abort("blockedbyclient");
            } catch {
              /* request already disposed */
            }
          }
        };
        const registerRoute = context.route
          ? context.route.bind(context)
          : page.route?.bind(page);
        await withTimeout(
          registerRoute?.("**/*", routeHandler) ?? Promise.resolve(),
          Math.max(1, deadline - now()),
          "CAPTURE_DEADLINE_EXCEEDED",
        );
        const ensureTarget = () => {
          const current = page.url();
          const check = checkAtlasRedirect(navigationUrl, current);
          if (!check.ok) {
            throw new AtlasCollectionError("TARGET_CHANGED", "The page destination changed");
          }
        };
        const response: any = await withTimeout(
          page.goto(navigationUrl, {
            waitUntil: "load",
            timeout: Math.max(
              1,
              Math.min(
                deps.navigationTimeoutMs ?? NAVIGATION_TIMEOUT_MS,
                deadline - now(),
              ),
            ),
          }),
          Math.max(1, deadline - now()),
          "CAPTURE_DEADLINE_EXCEEDED",
        );
        const finalUrl = page.url();
        const redirect = checkAtlasRedirect(navigationUrl, finalUrl);
        if (!redirect.ok) throw new AtlasCollectionError("TARGET_CHANGED", redirect.message);
        if (response && typeof response.status === "function" && response.status() >= 400) {
          throw new AtlasCollectionError(
            "HTTP_STATUS",
            `The reference returned HTTP ${response.status()}`,
          );
        }
        await withTimeout(
          Promise.resolve(
            (deps.settle ?? (async (p: Page) => {
              await waitForOverlays(p, 8_000);
              await p.waitForTimeout(1_000);
              await preScroll(p);
            }))(page),
          ),
          Math.max(1, deadline - now()),
          "CAPTURE_DEADLINE_EXCEEDED",
        );
        const settledUrl = page.url();
        const settledRedirect = checkAtlasRedirect(navigationUrl, settledUrl);
        if (!settledRedirect.ok) {
          throw new AtlasCollectionError(settledRedirect.code, settledRedirect.message);
        }
        if (cancelled) break;
        const rawScan = deps.scanPage
          ? await withTimeout(
              deps.scanPage(page, viewport),
              Math.max(1, deadline - now()),
              "CAPTURE_DEADLINE_EXCEEDED",
            )
          : await withTimeout(
              page.evaluate(ATLAS_SECTION_SCAN) as Promise<AtlasPageScan>,
              Math.max(1, deadline - now()),
              "CAPTURE_DEADLINE_EXCEEDED",
            );
        const scan = normalizeScan(rawScan);
        // The scan's sections and rects were measured against the root it
        // picked itself. preScroll re-picks a root with an uncapped walk, so
        // overwriting one label with the other would mix coordinate spaces.
        const measuredRoot = scan.scrollRoot ?? null;
        if (!deps.scanPage) {
          try {
            const scroll = await withTimeout(
              preScroll(page),
              Math.max(1, deadline - now()),
              "CAPTURE_DEADLINE_EXCEEDED",
            );
            const scrollRoot = scroll.scrollRoot ?? null;
            if (scrollRoot !== measuredRoot) {
              // No region, observation or claim measured against measuredRoot
              // can be labelled under scrollRoot, so publish nothing for this
              // viewport and disclose why.
              limitations.push("SCROLL_ROOT_UNKNOWN");
              if (scan.nodeBudgetHit) limitations.push("DOM_NODE_LIMIT");
              if (viewportPolicyBlocked) limitations.push("POLICY_BLOCKED");
              const viewportLimitations = [...new Set(limitations)];
              viewports.push({
                viewport,
                profileKey: `live-${viewport}`,
                status: "partial",
                coverage: {
                  status: "partial",
                  collected: 0,
                  excluded: 0,
                  limitations: viewportLimitations,
                },
                limitations: viewportLimitations,
                finalUrl,
                browserVersion,
                dpr: profile.deviceScaleFactor ?? 1,
                reducedMotion: "no-preference",
                scrollRoot: measuredRoot,
                overlayState: "none",
                loadingFailures: popups,
                scan,
                regions: [],
                claims: [],
                screenshots: [],
                observations: [],
                artifacts: [],
              });
              continue;
            }
            scan.scrollRoot = scrollRoot;
            scan.totalHeight = scroll.scrollHeight;
            scan.scrollRootClientHeight = scrollRoot ? scroll.clientHeight : null;
            if (!scrollRoot) {
              scan.scrollRootScrollLeft = null;
              scan.scrollRootScrollTop = null;
            }
          } catch {
            limitations.push("SCROLL_ROOT_UNKNOWN");
          }
        }
        const scanRedirect = checkAtlasRedirect(navigationUrl, scan.url || settledUrl);
        if (!deps.scanPage && !scanRedirect.ok) {
          throw new AtlasCollectionError("TARGET_CHANGED", scanRedirect.message);
        }
        const segmented = segmentRegionsWithStats(scan);
        const regions = segmented.regions;
        if (regions.length === 0) limitations.push("NO_SECTIONS");
        if (scan.nodeBudgetHit) limitations.push("DOM_NODE_LIMIT");
        if (scan.sectionLimitHit || segmented.truncated) {
          limitations.push("SECTION_TRUNCATION");
        } else if (segmented.filtered > 0) {
          limitations.push("SECTION_EXCLUDED");
        }
        const scanPayload = {
          schemaVersion: "awwwards-atlas-live-scan-v1",
          viewport,
          provenance: {
            requestedUrl: target.requestedUrl,
            finalUrl,
            browserVersion,
            dpr: profile.deviceScaleFactor ?? 1,
            reducedMotion: "no-preference",
            settlePolicy: "load+overlay+prescroll",
          },
          scan,
        };
        const scanBytes = Buffer.byteLength(JSON.stringify(scanPayload), "utf8");
        if (artifactBytes + scanBytes > MAX_SCREENSHOT_BYTES) {
          throw new AtlasCollectionError(
            "ARTIFACT_LIMIT",
            "The raw observation exceeds the artifact budget",
          );
        }
        const scanArtifact = writeJsonArtifactSync(deps.cache.rootDir, scanPayload);
        const scanKey = `scan-${viewport}`;
        const scanStored: AtlasStoredArtifact = {
          key: scanKey,
          kind: "raw_observation",
          storagePath: scanArtifact.storagePath,
          sha256: scanArtifact.sha256,
          bytes: scanArtifact.bytes,
          mimeType: "application/json",
          regionKey: null,
        };
        artifacts.push(scanStored);
        artifactBytes += scanStored.bytes;

        const screenshots: AtlasStoredArtifact[] = [];
        const observations: AtlasObservation[] = [];
        const initialSampleKey = `observation-${viewport}-initial`;
        observations.push({
          key: initialSampleKey,
          checkpoint: 0,
          scrollY: 0,
          scrollRoot: scan.scrollRoot,
          state: "default",
          coordinateSpace: scan.scrollRoot ? "scroll_root" : "document",
          scrollX: scan.scrollRoot ? (scan.scrollRootScrollLeft ?? 0) : (scan.scrollX ?? 0),
          viewport,
          regionKeys: regions.map((region) => regionStableKey(region)),
          regions: regions.map((region) => {
            const stable = regionStableKey(region);
            const initialBottom = region.inScrollRoot
              ? (scan.scrollRootClientHeight ?? profile.height)
              : profile.height;
            const sampleSpace: "document" | "scroll_root" = region.inScrollRoot
              ? "scroll_root"
              : "document";
            return {
              key: stable,
              sampleKey: `${viewport}:${stable}:${initialSampleKey}`,
              targetRegionId: null,
              visible:
                region.rect.y < initialBottom &&
                region.rect.y + region.rect.height > 0,
              coordinateSpace: sampleSpace,
              inScrollRoot: region.inScrollRoot === true,
              scrollX: region.inScrollRoot
                ? (scan.scrollRootScrollLeft ?? 0)
                : (scan.scrollX ?? 0),
              selector: region.selector,
              tag: region.tag,
              heading: region.heading,
              text: region.text,
              rect: region.rect,
            };
          }),
          screenshotKey: "",
          scanArtifactKey: scanKey,
        });
        const checkpointArtifacts: AtlasStoredArtifact[] = [];
        const checkpointEvidence: Array<{
          regions: RegionCandidate[];
          scan: AtlasPageScan;
          artifactKey: string;
          observationKey: string;
          visibleKeys: string[];
        }> = [];
        const viewportLimited = limitations.includes("SCREENSHOT_LIMIT");
        if (!viewportLimited) {
          const scrollViewportHeight = Math.max(
            1,
            scan.scrollRoot ? (scan.scrollRootClientHeight ?? profile.height) : profile.height,
          );
          const maxScroll = Math.max(0, scan.totalHeight - scrollViewportHeight);
          const neededCheckpoints = Math.max(
            1,
            Math.ceil(scan.totalHeight / scrollViewportHeight),
          );
          if (neededCheckpoints > MAX_CHECKPOINTS) {
            limitations.push("CHECKPOINT_LIMIT");
          }
          const steps = Math.min(MAX_CHECKPOINTS, neededCheckpoints);
          for (let index = 0; index < steps; index += 1) {
            if (now() > deadline || cancelled) {
              limitations.push("CAPTURE_DEADLINE_EXCEEDED");
              break;
            }
            if (screenshotCount >= MAX_SCREENSHOTS || screenshotBytes >= MAX_SCREENSHOT_BYTES) {
              limitations.push("SCREENSHOT_LIMIT");
              break;
            }
            const y = Math.round(steps <= 1 ? 0 : (index * maxScroll) / (steps - 1));
            ensureTarget();
            const scrolled = await withTimeout(
              scrollTo(page, scan.scrollRoot, y),
              Math.max(1, deadline - now()),
              "CAPTURE_DEADLINE_EXCEEDED",
            );
            if (scrolled?.found === false || scrolled?.unique === false) {
              // The label no longer resolves, or now matches several elements
              // (e.g. a class swap after preScroll): continuing would capture
              // every checkpoint at the wrong offset.
              limitations.push("SCROLL_ROOT_UNKNOWN");
              break;
            }
            await withTimeout(
              Promise.resolve(deps.settle?.(page) ?? Promise.resolve()),
              Math.max(1, deadline - now()),
              "CAPTURE_DEADLINE_EXCEEDED",
            );
            ensureTarget();
            const measuredScroll = deps.scanPage
              ? null
              : await withTimeout(
                  measureScrollOffsets(page, scan.scrollRoot),
                  Math.max(1, deadline - now()),
                  "CAPTURE_DEADLINE_EXCEEDED",
                );
            if (measuredScroll) {
              if (!measuredScroll.found || !measuredScroll.unique) {
                limitations.push("SCROLL_ROOT_UNKNOWN");
                break;
              }
              const recheck = await withTimeout(
                measureScrollOffsets(page, scan.scrollRoot),
                Math.max(1, deadline - now()),
                "CAPTURE_DEADLINE_EXCEEDED",
              );
              if (!recheck.found || !recheck.unique) {
                limitations.push("SCROLL_ROOT_UNKNOWN");
                break;
              }
              const rechecked = scan.scrollRoot ? recheck.rootY : recheck.documentY;
              // The observed position must be the requested one within a
              // two-pixel rounding allowance; a stable clamp, snap or
              // counter-scroll is a wrong screenshot, not a settled one.
              if (Math.abs(rechecked - y) > 2) {
                limitations.push("SCROLL_OFFSET_MISMATCH");
                break;
              }
            }
            let buffer: Buffer | undefined;
            try {
              buffer = await withTimeout(
                Promise.resolve(
                  deps.screenshot?.(page) ??
                    (page.screenshot({ fullPage: false, type: "png" }) as Promise<Buffer>),
                ),
                Math.max(1, deadline - now()),
                "CAPTURE_DEADLINE_EXCEEDED",
              );
            } catch {
              limitations.push("SCREENSHOT_FAILED");
              continue;
            }
            if (!buffer || buffer.length === 0) {
              limitations.push("SCREENSHOT_EMPTY");
              continue;
            }
            if (!isPng(buffer)) {
              limitations.push("SCREENSHOT_INVALID");
              continue;
            }
            if (
              buffer.length > MAX_SCREENSHOT_FILE_BYTES ||
              artifactBytes + buffer.length > MAX_SCREENSHOT_BYTES
            ) {
              limitations.push("SCREENSHOT_LIMIT");
              break;
            }
            const stored = writeArtifactBytesSync(deps.cache.rootDir, buffer, ".png");
            artifactBytes += stored.bytes;
            screenshotBytes += stored.bytes;
            screenshotCount += 1;
            const item: AtlasStoredArtifact = {
              key: `screenshot-${viewport}-${index}`,
              kind: "screenshot",
              storagePath: stored.storagePath,
              sha256: stored.sha256,
              bytes: stored.bytes,
              mimeType: "image/png",
              regionKey: null,
            };
            screenshots.push(item);
            artifacts.push(item);
            const discardScreenshot = (): void => {
              const artifactIndex = artifacts.indexOf(item);
              if (artifactIndex >= 0) artifacts.splice(artifactIndex, 1);
              const screenshotIndex = screenshots.indexOf(item);
              if (screenshotIndex >= 0) screenshots.splice(screenshotIndex, 1);
              screenshotBytes = Math.max(0, screenshotBytes - item.bytes);
              artifactBytes = Math.max(0, artifactBytes - item.bytes);
              screenshotCount = Math.max(0, screenshotCount - 1);
              if (
                stored.created &&
                !artifacts.some((entry) => entry.storagePath === item.storagePath)
              ) {
                try {
                  removeArtifactFileSync(deps.cache.rootDir, item.storagePath);
                } catch {
                  /* orphan cleanup is best effort */
                }
              }
            };
            try {
              const rawCheckpointScan = deps.scanPage
                ? await withTimeout(
                    deps.scanPage(page, viewport),
                    Math.max(1, deadline - now()),
                    "CAPTURE_DEADLINE_EXCEEDED",
                  )
                : await withTimeout(
                    page.evaluate(ATLAS_SECTION_SCAN) as Promise<AtlasPageScan>,
                    Math.max(1, deadline - now()),
                    "CAPTURE_DEADLINE_EXCEEDED",
                  );
              const checkpointScan = normalizeScan(rawCheckpointScan);
              // The checkpoint scan re-picks the page's scroll root by
              // geometry. A different pick means every offset and rect in
              // this scan belongs to another element than the one the
              // capture scrolled and measured, so none of it can be
              // published under scan.scrollRoot.
              if ((checkpointScan.scrollRoot ?? null) !== (scan.scrollRoot ?? null)) {
                discardScreenshot();
                limitations.push("SCROLL_ROOT_UNKNOWN");
                break;
              }
              // The pre-screenshot measurement can be stale: a delayed page
              // handler may move the page after it. Revalidate the live root
              // and offsets before this checkpoint labels any evidence.
              const verifiedScroll = deps.scanPage
                ? null
                : await withTimeout(
                    measureScrollOffsets(page, scan.scrollRoot),
                    Math.max(1, deadline - now()),
                    "CAPTURE_DEADLINE_EXCEEDED",
                  );
              if (verifiedScroll) {
                if (!verifiedScroll.found || !verifiedScroll.unique) {
                  discardScreenshot();
                  limitations.push("SCROLL_ROOT_UNKNOWN");
                  break;
                }
                const verifiedY = scan.scrollRoot
                  ? verifiedScroll.rootY
                  : verifiedScroll.documentY;
                if (Math.abs(verifiedY - y) > 2) {
                  discardScreenshot();
                  limitations.push("SCROLL_OFFSET_MISMATCH");
                  break;
                }
                const scanY = scan.scrollRoot
                  ? checkpointScan.scrollRootScrollTop
                  : checkpointScan.scrollY;
                if (scanY !== null && scanY !== undefined && Math.abs(scanY - verifiedY) > 2) {
                  discardScreenshot();
                  limitations.push("SCROLL_OFFSET_MISMATCH");
                  break;
                }
              }
              const checkpointSegment = segmentRegionsWithStats(checkpointScan);
              const checkpointRegions = checkpointSegment.regions;
              if (checkpointScan.nodeBudgetHit) {
                limitations.push("DOM_NODE_LIMIT");
              }
              const checkpointCoordinateSpace = scan.scrollRoot ? "scroll_root" : "document";
              const documentScrollX = verifiedScroll?.documentX ?? (checkpointScan.scrollX ?? 0);
              const documentScrollY = verifiedScroll?.documentY ?? (checkpointScan.scrollY ?? y);
              const rootScrollX =
                verifiedScroll?.rootX ??
                (checkpointScan.scrollRootScrollLeft ?? scan.scrollRootScrollLeft ?? 0);
              const rootScrollY = verifiedScroll?.rootY ?? y;
              const checkpointTop = scan.scrollRoot ? rootScrollY : documentScrollY;
              const checkpointBottom =
                checkpointTop +
                (scan.scrollRoot ? (scan.scrollRootClientHeight ?? profile.height) : profile.height);
              const checkpointRegionsPayload = checkpointRegions.map((region) => {
                const stable = regionStableKey(region);
                const sampleRootSpace = region.inScrollRoot === true;
                const sampleTop = sampleRootSpace ? rootScrollY : documentScrollY;
                const sampleBottom = sampleRootSpace
                  ? checkpointBottom
                  : documentScrollY + profile.height;
                const sampleSpace: "document" | "scroll_root" = sampleRootSpace
                  ? "scroll_root"
                  : "document";
                return {
                  key: stable,
                  sampleKey: `${viewport}:${stable}:observation-${viewport}-${index}`,
                  targetRegionId: null,
                  visible:
                    region.rect.y < sampleBottom &&
                    region.rect.y + region.rect.height > sampleTop,
                  coordinateSpace: sampleSpace,
                  inScrollRoot: sampleRootSpace,
                  scrollX: sampleRootSpace ? rootScrollX : documentScrollX,
                  selector: region.selector,
                  tag: region.tag,
                  heading: region.heading,
                  text: region.text,
                  rect: region.rect,
                };
              });
              const checkpointPayload = {
                schemaVersion: "awwwards-atlas-checkpoint-v1",
                checkpoint: index,
                scrollY: checkpointTop,
                scrollRoot: scan.scrollRoot,
                state: "default",
                settleStatus: "settled",
                coordinateSpace: checkpointCoordinateSpace,
                scrollX: scan.scrollRoot ? rootScrollX : documentScrollX,
                viewport,
                scan: checkpointScan,
                regions: checkpointRegionsPayload,
              };
              const checkpointBuffer = Buffer.from(JSON.stringify(checkpointPayload), "utf8");
              if (artifactBytes + checkpointBuffer.length > MAX_SCREENSHOT_BYTES) {
                limitations.push("CHECKPOINT_EVIDENCE_LIMIT");
                break;
              }
              const checkpointStored = writeArtifactBytesSync(
                deps.cache.rootDir,
                checkpointBuffer,
                ".json",
              );
              artifactBytes += checkpointStored.bytes;
              checkpointEvidence.push({
                regions: checkpointRegions,
                scan: checkpointScan,
                artifactKey: `checkpoint-${viewport}-${index}`,
                observationKey: `observation-${viewport}-${index}`,
                visibleKeys: checkpointRegionsPayload
                  .filter((region) => region.visible)
                  .map((region) => region.key),
              });
              if (checkpointScan.sectionLimitHit) {
                markCheckpointExcluded(checkpointScan, checkpointRegions);
                limitations.push("CHECKPOINT_SECTION_TRUNCATION");
              } else if (checkpointSegment.truncated) {
                markCheckpointExcluded(checkpointScan, checkpointRegions);
                limitations.push("CHECKPOINT_SECTION_TRUNCATION");
              } else if (checkpointSegment.filtered > 0) {
                markCheckpointExcluded(checkpointScan, checkpointRegions);
                limitations.push("CHECKPOINT_SECTION_EXCLUDED");
              }
              const checkpointArtifact: AtlasStoredArtifact = {
                key: `checkpoint-${viewport}-${index}`,
                kind: "raw_observation",
                storagePath: checkpointStored.storagePath,
                sha256: checkpointStored.sha256,
                bytes: checkpointStored.bytes,
                mimeType: "application/json",
                regionKey: null,
              };
              artifacts.push(checkpointArtifact);
              checkpointArtifacts.push(checkpointArtifact);
              observations.push({
                key: `observation-${viewport}-${index}`,
                checkpoint: index,
                scrollY: checkpointTop,
                scrollRoot: scan.scrollRoot,
                state: "default",
                settleStatus: "settled",
                coordinateSpace: checkpointCoordinateSpace,
                scrollX: scan.scrollRoot ? rootScrollX : documentScrollX,
                viewport,
                regionKeys: checkpointRegionsPayload.map((region) => region.key),
                regions: checkpointRegionsPayload,
                screenshotKey: item.key,
                scanArtifactKey: checkpointArtifact.key,
              });
            } catch {
              limitations.push("CHECKPOINT_OBSERVATION_MISSING");
            }
          }
        }
        if (screenshots.length === 0) limitations.push("SCREENSHOTS_MISSING");
        if (observations.length < screenshots.length) {
          limitations.push("CHECKPOINT_OBSERVATION_MISSING");
        }
        const publishedRegions = [...regions];
        const stableRegions = new Map(
          regions.map((candidate) => [regionStableKey(candidate), candidate]),
        );
        const regionKeysSeen = new Set(publishedRegions.map((candidate) => candidate.key));
        let unionExcluded = 0;
        for (const checkpoint of checkpointEvidence) {
          for (const candidate of checkpoint.regions) {
            const stable = regionStableKey(candidate);
            if (stableRegions.has(stable)) continue;
            if (publishedRegions.length >= 24) {
              unionExcluded += 1;
              checkpointExcludedKeys.add(stable);
              continue;
            }
            const published = { ...candidate, ordinal: publishedRegions.length };
            stableRegions.set(stable, published);
            if (!regionKeysSeen.has(published.key)) {
              regionKeysSeen.add(published.key);
              publishedRegions.push(published);
            }
          }
        }
        const retainedKeysByObservedKey = new Map<string, string>();
        for (const candidate of [
          ...regions,
          ...checkpointEvidence.flatMap((checkpoint) => checkpoint.regions),
        ]) {
          const retained = stableRegions.get(regionStableKey(candidate));
          // Geometry changes must not strand a child's native parent on an unused scan key.
          if (retained) retainedKeysByObservedKey.set(candidate.key, retained.key);
        }
        for (const region of publishedRegions) {
          if (region.parentKey) {
            region.parentKey = retainedKeysByObservedKey.get(region.parentKey) ?? region.parentKey;
          }
        }
        if (unionExcluded > 0) {
          limitations.push("SECTION_TRUNCATION");
        }
        const claims: AtlasClaim[] = [];
        const claimSeen = new Set<string>();
        const addClaims = (
          candidates: RegionCandidate[],
          scanValue: AtlasPageScan,
          artifactKey: string,
          observationKey: string | null,
          visibleKeys?: string[],
        ): void => {
          const candidatesForClaims = visibleKeys
            ? candidates.filter((candidate) => visibleKeys.includes(regionStableKey(candidate)))
            : candidates;
          const evidence = candidatesForClaims.map((candidate) => ({
            viewport,
            candidate,
            scan: scanValue,
            artifactKey,
          }));
          for (const claim of classifySections(evidence)) {
            const candidate = candidatesForClaims.find((item) => item.key === claim.regionKey);
            if (!candidate) continue;
            const stable = regionStableKey(candidate);
            const published = stableRegions.get(stable);
            if (!published) continue;
            claim.regionKey = published.key;
            const sampleKey = observationKey
              ? `${viewport}:${stable}:${observationKey}`
              : `${viewport}:${stable}:${initialSampleKey}`;
            claim.sampleKey = sampleKey;
            claim.evidence = claim.evidence.map((ref) => ({ ...ref, sampleKey }));
            if (observationKey) {
              claim.checkpointKeys = [observationKey];
            }
            const id = `${claim.regionKey}|${claim.field}|${claim.value}|${claim.basis}|${sampleKey}`;
            if (claimSeen.has(id)) continue;
            claimSeen.add(id);
            claims.push(claim);
          }
        };
        const initialVisibleKeys = observations
          .find((observation) => observation.key === initialSampleKey)!
          .regions.filter((sample) => sample.visible)
          .map((sample) => sample.key);
        addClaims(regions, scan, scanKey, null, initialVisibleKeys);
        for (const checkpoint of checkpointEvidence) {
          addClaims(
            checkpoint.regions,
            checkpoint.scan,
            checkpoint.artifactKey,
            checkpoint.observationKey,
            checkpoint.visibleKeys,
          );
        }
        if (viewportPolicyBlocked) limitations.push("POLICY_BLOCKED");
        const published = new Set(publishedRegions.map((region) => regionStableKey(region)));
        for (const section of scan.sections) {
          const stable = regionStableKey(section as unknown as RegionCandidate);
          if (!published.has(stable)) checkpointExcludedKeys.add(stable);
        }
        normalizationDropped = Math.max(
          normalizationDropped,
          Math.max(0, (scan.rawSectionCount ?? scan.sections.length) - scan.sections.length),
        );
        const viewportLimitations = [...new Set(limitations)];
        const status = viewportLimitations.length === 0 ? "complete" : "partial";
        const coverage = {
          status,
          collected: publishedRegions.length,
          excluded: checkpointExcludedKeys.size + normalizationDropped,
          limitations: viewportLimitations,
        } as const;
        ensureTarget();
        viewports.push({
          viewport,
          profileKey: `live-${viewport}`,
          status,
          coverage,
          limitations: viewportLimitations,
          finalUrl,
          browserVersion,
          dpr: profile.deviceScaleFactor ?? 1,
          reducedMotion: "no-preference",
          scrollRoot: scan.scrollRoot,
          overlayState: "none",
          loadingFailures: popups,
          scan,
          regions: publishedRegions,
          claims,
          screenshots,
          observations,
          artifacts: [scanStored, ...screenshots, ...checkpointArtifacts],
        });
      } finally {
        try {
          if (routeHandler) await context?.unroute?.("**/*", routeHandler);
        } catch {
          /* context already disposed */
        }
        await close(context);
      }
    }
  } catch (error) {
    const code = error instanceof AtlasCollectionError ? error.code : "CAPTURE_FAILED";
    return {
      cache: deps.cache,
      target,
      attemptId: randomUUID(),
      startedAt,
      finishedAt: now(),
      status: code === "ROBOTS_DENIED" || code === "PRIVATE_DESTINATION" ? "blocked" : "failed",
      coverage: {
        status: "unknown",
        collected: 0,
        excluded: 0,
        limitations: [...attemptLimitations, code],
      },
      limitations: [...attemptLimitations, code],
      viewports,
      artifacts,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    deps.signal?.removeEventListener("abort", abort);
    await close(browser);
    await close(proxy);
    if (lease) releaseAtlasCaptureLease(lease) || releaseAtlasCaptureLease(lease);
  }

  const complete = viewports.length === (input.viewports ?? ["desktop", "mobile"]).length;
  if (policyBlocked) attemptLimitations.push("POLICY_BLOCKED");
  const limitations = [
    ...new Set([
      ...attemptLimitations,
      ...viewports.flatMap((item) => item.limitations),
    ]),
  ];
  return {
    cache: deps.cache,
    target,
    attemptId: randomUUID(),
    startedAt,
    finishedAt: now(),
    status: complete && limitations.length === 0 ? "complete" : viewports.length > 0 ? "partial" : "failed",
    coverage: {
      status: limitations.length === 0 && complete ? "complete" : "partial",
      collected: viewports.reduce((sum, item) => sum + item.regions.length, 0),
      excluded: viewports.reduce((sum, item) => sum + item.coverage.excluded, 0),
      limitations,
    },
    limitations,
    viewports,
    artifacts,
  };
}

/** Stable key for a scan section across viewports. */
export function sectionKey(viewport: string, selector: string, ordinal: number): string {
  return stableHash("section-live-v1", viewport, selector, String(ordinal));
}
