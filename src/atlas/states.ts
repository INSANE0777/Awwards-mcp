import type { Page } from "playwright";
import type {
  AtlasRect,
  AtlasStateAction,
  AtlasStateRequest,
  AtlasViewportProfile,
} from "./live-types.js";

export const ATLAS_STATE_RULE_VERSION = "atlas-state-rules-1";
export const MAX_STATE_REQUESTS = 3;
export const STATE_PROBE_TIMEOUT_MS = 10_000;
export const STATE_SETTLE_MS = 50;
/** Minimum viewport distance between the neutral pointer and the target. */
const STATE_POINTER_MARGIN = 8;

export interface AtlasStateTarget {
  request: AtlasStateRequest;
  kind: "section" | "component";
  /** Published region id the caller asked for. */
  regionId: string;
  viewport: AtlasViewportProfile;
  selector: string;
  tag: string;
  /** Section heading, or the component label. */
  heading: string;
  text: string;
  componentType: string | null;
  patternKey: string | null;
  /** Persisted fingerprint; verified against the stored identity before probing. */
  fingerprint: string;
}

export interface AtlasStateProbeResult {
  status: "ok" | "missing" | "ambiguous";
  count: number;
  tag?: string;
  heading?: string | null;
  text?: string;
  label?: string;
  rect?: AtlasRect;
  viewportRect?: { left: number; top: number; width: number; height: number };
  scrollX?: number;
  scrollY?: number;
  inScrollRoot?: boolean;
  coordinateSpace?: "document" | "scroll_root";
  visible?: boolean;
  center?: { x: number; y: number };
  styles?: Record<string, string>;
  hovered?: boolean;
  focusVisible?: boolean;
  activeSelf?: boolean;
  activeWithin?: boolean;
  activeTag?: string | null;
}

/**
 * Runs inside the guarded page. Resolves exactly one element for the stored
 * selector; zero or several matches are reported, never approximated. The
 * function is serialized by Playwright, so it reads only browser globals.
 */
export const ATLAS_STATE_PROBE = function (input: {
  op: "resolve" | "measure" | "measure-hover" | "focus" | "blur" | "measure-scroll";
  selector: string;
  scrollRoot: string | null;
  scrollIntoView: boolean;
  /** Actual pointer position for a hover confirmation. */
  pointer?: { x: number; y: number } | null;
}): AtlasStateProbeResult {
  const g = globalThis as any;
  const doc = g.document;
  const win = g.window;
  const clean = (value: unknown): string =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  if (input.op === "blur") {
    try {
      const active = doc.activeElement;
      if (active && typeof active.blur === "function") active.blur();
    } catch {
      /* an unblurrable active element is reported by the next probe */
    }
    return { status: "ok", count: 0 };
  }
  if (input.op === "measure-scroll") {
    const scrollRootMatches = input.scrollRoot
      ? Array.from(doc.querySelectorAll(input.scrollRoot))
      : [];
    let scrollRootElement: any = null;
    if (scrollRootMatches.length === 1) scrollRootElement = scrollRootMatches[0];
    return {
      status: "ok",
      count: 0,
      scrollX: scrollRootElement
        ? Number(scrollRootElement.scrollLeft || 0)
        : Number(win.scrollX || 0),
      scrollY: scrollRootElement
        ? Number(scrollRootElement.scrollTop || 0)
        : Number(win.scrollY || 0),
    };
  }
  let matches: any[] = [];
  try {
    matches = Array.from(doc.querySelectorAll(input.selector));
  } catch {
    matches = [];
  }
  if (matches.length === 0) return { status: "missing", count: 0 };
  if (matches.length > 1) return { status: "ambiguous", count: matches.length };
  const el = matches[0];
  if (input.op === "focus") {
    try {
      el.focus({ focusVisible: true });
    } catch {
      try {
        el.focus();
      } catch {
        /* handled by the active-element check */
      }
    }
  }
  if (input.scrollIntoView) {
    try {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    } catch {
      try {
        el.scrollIntoView();
      } catch {
        /* measurement below records wherever the element ended up */
      }
    }
  }
  const style = win.getComputedStyle(el);
  const styleKeys = [
    "color",
    "backgroundColor",
    "backgroundImage",
    "borderTopColor",
    "borderRightColor",
    "borderBottomColor",
    "borderLeftColor",
    "borderTopWidth",
    "borderTopStyle",
    "borderRadius",
    "outlineColor",
    "outlineStyle",
    "outlineWidth",
    "outlineOffset",
    "boxShadow",
    "opacity",
    "filter",
    "transform",
    "textDecorationLine",
    "textDecorationColor",
    "letterSpacing",
    "fontSize",
    "fontWeight",
    "paddingTop",
    "paddingLeft",
  ];
  const styles: Record<string, string> = {};
  for (const key of styleKeys) styles[key] = String(style[key] ?? "");
  const rect = el.getBoundingClientRect();
  const rootMatches = input.scrollRoot
    ? Array.from(doc.querySelectorAll(input.scrollRoot))
    : [];
  let root: any = null;
  if (rootMatches.length === 1) root = rootMatches[0];
  const inScrollRoot = Boolean(root && root.contains(el));
  const rootRect = root ? root.getBoundingClientRect() : null;
  const coordinateSpace = inScrollRoot ? "scroll_root" : "document";
  const scrollX = inScrollRoot
    ? Number(root.scrollLeft || 0)
    : Number(win.scrollX || 0);
  const scrollY = inScrollRoot
    ? Number(root.scrollTop || 0)
    : Number(win.scrollY || 0);
  const left = Math.max(rect.left, 0);
  const top = Math.max(rect.top, 0);
  const right = Math.min(rect.right, Number(win.innerWidth || 0));
  const bottom = Math.min(rect.bottom, Number(win.innerHeight || 0));
  let visible = right > left && bottom > top;
  let centerHit: any = null;
  if (visible) {
    centerHit = doc.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    visible = Boolean(centerHit && (centerHit === el || el.contains(centerHit)));
  }
  const active = doc.activeElement;
  const headingEl = el.querySelector
    ? el.querySelector("h1,h2,h3,h4,h5,h6")
    : null;
  // A hover sample is only honest when the real pointer is still over the
  // resolved element (or a descendant) and both report the hover state. A
  // center hit-test says nothing about where the pointer actually is.
  let hovered = false;
  if (input.op === "measure-hover" && input.pointer) {
    const pointer = input.pointer;
    if (Number.isFinite(pointer.x) && Number.isFinite(pointer.y)) {
      const hit = doc.elementFromPoint(pointer.x, pointer.y);
      const within = Boolean(hit && (hit === el || el.contains(hit)));
      hovered =
        within &&
        (typeof el.matches !== "function" || el.matches(":hover")) &&
        (typeof hit.matches !== "function" || hit.matches(":hover"));
    }
  } else {
    hovered = typeof el.matches === "function" ? el.matches(":hover") : false;
  }
  return {
    status: "ok",
    count: 1,
    tag: String(el.tagName || "").toLowerCase(),
    heading: headingEl
      ? clean(String(headingEl.textContent || "").slice(0, 2_000)).slice(0, 300)
      : null,
    text: clean(String(el.textContent || "").slice(0, 8_000)).slice(0, 4_000),
    label: clean(
      el.getAttribute?.("aria-label") ||
        el.getAttribute?.("title") ||
        String(el.textContent || "").slice(0, 2_000),
    ).slice(0, 200),
    rect: {
      x: Math.round(
        inScrollRoot
          ? rect.left - (rootRect?.left ?? 0) + (root.scrollLeft || 0)
          : rect.left + (win.scrollX || 0),
      ),
      y: Math.round(
        inScrollRoot
          ? rect.top - (rootRect?.top ?? 0) + (root.scrollTop || 0)
          : rect.top + (win.scrollY || 0),
      ),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    viewportRect: {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    },
    scrollX,
    scrollY,
    inScrollRoot,
    coordinateSpace,
    visible,
    center: { x: (left + right) / 2, y: (top + bottom) / 2 },
    styles,
    hovered,
    focusVisible:
      active &&
      (active === el || el.contains(active)) &&
      typeof active.matches === "function"
        ? active.matches(":focus-visible")
        : false,
    activeSelf: active === el,
    activeWithin: Boolean(active && (active === el || el.contains(active))),
    activeTag: active ? String(active.tagName || "").toLowerCase() : null,
  };
};

export interface AtlasStateSamplePayload {
  key: string;
  sampleKey: string;
  selector: string;
  tag: string;
  heading: string | null;
  text: string;
  rect: AtlasRect;
  scrollX: number;
  scrollY: number;
  coordinateSpace: "document" | "scroll_root";
  inScrollRoot: boolean;
  visible: boolean;
}

export interface AtlasStateCaptureOutcome {
  action: AtlasStateAction;
  targetRegionId: string;
  status: "observed" | "inconclusive";
  code?: string;
  /** Published region key this sample belongs to (claims and artifacts). */
  regionKey?: string;
  sampleKey?: string;
  sample: AtlasStateSamplePayload | null;
  evidence: Record<string, unknown> | null;
  claimValue: "hover_change_observed" | "focus_visible_observed" | null;
}

export interface AtlasStateResolvedRegion {
  /** Published region key used by claims and artifacts in this capture. */
  key: string;
  /** Observation key used by this capture's samples (sections use the stable key). */
  observationKey: string;
  /** Scan node key of the candidate observed in this capture. */
  nodeKey: string;
  /** Containing section node key and published key for component targets. */
  sectionNodeKey?: string | null;
  sectionKey?: string | null;
  selector: string;
  tag: string;
  heading: string;
  text: string;
  /** Fingerprint recomputed from this capture's observed candidate. */
  fingerprint: string;
}

export interface AtlasStateCaptureOptions {
  viewport: AtlasViewportProfile;
  scrollRoot: string | null;
  checkpoint: number;
  deadline: number;
  now: () => number;
  /** Return the pointer, focus and scroll to the neutral baseline. */
  reset: () => Promise<void>;
  /**
   * Maps the persisted target onto a region discovered by this capture.
   * Failure is explicit: no nearest-element substitute exists.
   */
  resolveRegion: (
    target: AtlasStateTarget,
  ) => { ok: true; region: AtlasStateResolvedRegion } | { ok: false; code: string };
  /**
   * Re-resolves the same target against the post-interaction DOM. Evidence is
   * only attributable when the element still carries the same identity.
   */
  revalidateRegion?: (
    target: AtlasStateTarget,
    region: AtlasStateResolvedRegion,
  ) => Promise<{ ok: true } | { ok: false; code: string }>;
  settleMs?: number;
}

class StateDeadlineError extends Error {
  readonly code = "STATE_DEADLINE_EXCEEDED";
}

function failureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("STATE_")
    ? code
    : "STATE_PROBE_FAILED";
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new StateDeadlineError("The state observation exceeded its deadline"));
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

export function verifyStateTargetFingerprint(
  target: AtlasStateTarget,
  observedFingerprint: string,
): boolean {
  return observedFingerprint === target.fingerprint;
}

function normalize(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Identity compares DOM text, so nested inline markup cannot invent spaces. */
function stripWhitespace(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, "");
}

type IdentityCheck = { ok: true } | { ok: false; code: string };

function identityCheck(
  target: AtlasStateTarget,
  probe: AtlasStateProbeResult,
): IdentityCheck {
  if (probe.status === "missing") return { ok: false, code: "STATE_TARGET_MISSING" };
  if (probe.status === "ambiguous") return { ok: false, code: "STATE_TARGET_AMBIGUOUS" };
  if (stripWhitespace(probe.tag) !== stripWhitespace(target.tag)) {
    return { ok: false, code: "STATE_TARGET_CHANGED" };
  }
  if (target.kind === "section") {
    const heading = stripWhitespace(target.heading);
    if (
      heading &&
      !stripWhitespace(probe.heading).startsWith(heading) &&
      !stripWhitespace(probe.text).startsWith(heading)
    ) {
      return { ok: false, code: "STATE_TARGET_CHANGED" };
    }
    const prefix = stripWhitespace(target.text).slice(0, 80);
    if (prefix && !stripWhitespace(probe.text).startsWith(prefix)) {
      return { ok: false, code: "STATE_TARGET_CHANGED" };
    }
  } else {
    const label = stripWhitespace(target.heading);
    if (label && !stripWhitespace(probe.label).startsWith(label)) {
      // The stored component label is its heading; a relabelled control is a
      // different target even when the selector still resolves.
      return { ok: false, code: "STATE_TARGET_CHANGED" };
    }
  }
  return { ok: true };
}

/**
 * A viewport point at least `STATE_POINTER_MARGIN` away from the target on one
 * side, so the baseline is measured with the pointer demonstrably off the
 * target. Null means the target leaves no such point: it covers the viewport.
 */
function neutralPointerPoint(
  rect: { left: number; top: number; width: number; height: number } | undefined,
  viewport: { width: number; height: number } | null,
): { x: number; y: number } | null {
  if (!rect || !viewport) return null;
  const margin = STATE_POINTER_MARGIN;
  const centerX = Math.min(
    Math.max(rect.left + rect.width / 2, margin),
    viewport.width - margin,
  );
  const centerY = Math.min(
    Math.max(rect.top + rect.height / 2, margin),
    viewport.height - margin,
  );
  if (rect.left >= margin * 2) return { x: margin, y: centerY };
  if (viewport.width - (rect.left + rect.width) >= margin * 2) {
    return { x: viewport.width - margin, y: centerY };
  }
  if (rect.top >= margin * 2) return { x: centerX, y: margin };
  if (viewport.height - (rect.top + rect.height) >= margin * 2) {
    return { x: centerX, y: viewport.height - margin };
  }
  return null;
}

function changedStyleKeys(
  baseline: Record<string, string>,
  observed: Record<string, string>,
): string[] {
  const keys = new Set([...Object.keys(baseline), ...Object.keys(observed)]);
  return [...keys]
    .filter((key) => baseline[key] !== observed[key])
    .sort();
}

function geometryChanged(baseline: AtlasRect, observed: AtlasRect): boolean {
  return (
    Math.abs(baseline.x - observed.x) > 1 ||
    Math.abs(baseline.y - observed.y) > 1 ||
    Math.abs(baseline.width - observed.width) > 1 ||
    Math.abs(baseline.height - observed.height) > 1
  );
}

async function probe(
  page: Page,
  input: {
    op: "resolve" | "measure" | "measure-hover" | "focus" | "blur" | "measure-scroll";
    selector: string;
    scrollRoot: string | null;
    scrollIntoView: boolean;
    pointer?: { x: number; y: number } | null;
  },
  ms: number,
): Promise<AtlasStateProbeResult> {
  return withDeadline(
    page.evaluate(ATLAS_STATE_PROBE, input) as Promise<AtlasStateProbeResult>,
    ms,
  );
}

/**
 * Captures at most one sample per target/action after the default checkpoints.
 * Every request is independent: the pointer, focus and scroll return to the
 * neutral baseline before the next one. A failed request never throws.
 */
export async function captureAtlasStates(
  page: Page,
  targets: AtlasStateTarget[],
  options: AtlasStateCaptureOptions,
): Promise<AtlasStateCaptureOutcome[]> {
  const outcomes: AtlasStateCaptureOutcome[] = [];
  const settleMs = options.settleMs ?? STATE_SETTLE_MS;
  for (const target of targets) {
    const action = target.request.action;
    const inconclusive = (
      code: string,
      sampleKey?: string,
      sample: AtlasStateSamplePayload | null = null,
    ): AtlasStateCaptureOutcome => ({
      action,
      targetRegionId: target.request.targetRegionId,
      status: "inconclusive",
      code,
      ...(sampleKey ? { sampleKey } : {}),
      sample,
      evidence: null,
      claimValue: null,
    });
    const remaining = () =>
      Math.max(1, Math.min(STATE_PROBE_TIMEOUT_MS, options.deadline - options.now()));
    if (options.deadline <= options.now()) {
      outcomes.push(inconclusive("STATE_DEADLINE_EXCEEDED"));
      continue;
    }
    const resolved = options.resolveRegion(target);
    if (!resolved.ok) {
      outcomes.push(inconclusive(resolved.code));
      continue;
    }
    const region = resolved.region;
    if (!verifyStateTargetFingerprint(target, region.fingerprint)) {
      // The candidate that this capture observed is not the persisted target:
      // a changed type/pattern/content is a different target even when the
      // selector, tag and label still resolve.
      outcomes.push(inconclusive("STATE_TARGET_CHANGED"));
      continue;
    }
    const sampleKey = `${options.viewport}:${region.observationKey}:state-${action}`;
    let baselineProbe: AtlasStateProbeResult;
    let baselineScroll = { x: 0, y: 0 };
    try {
      await withDeadline(options.reset(), remaining());
      baselineScroll = await probe(
        page,
        {
          op: "measure-scroll",
          selector: "",
          scrollRoot: options.scrollRoot,
          scrollIntoView: false,
        },
        remaining(),
      ).then((measurement) => ({
        x: measurement.scrollX ?? 0,
        y: measurement.scrollY ?? 0,
      }));
      baselineProbe = await probe(
        page,
        {
          op: "resolve",
          selector: target.selector,
          scrollRoot: options.scrollRoot,
          scrollIntoView: true,
        },
        remaining(),
      );
    } catch (error) {
      outcomes.push(inconclusive(failureCode(error)));
      continue;
    }
    const identity = identityCheck(target, baselineProbe);
    if (!identity.ok) {
      outcomes.push(inconclusive(identity.code));
      await options.reset().catch(() => undefined);
      continue;
    }
    // The pointer reset parks at (0, 0), which is over the target when the
    // target sits at the top-left. Move it to a point outside the target's
    // rect and re-measure, so a hover style already active at the reset point
    // cannot become the baseline and hide the state change.
    const neutral = neutralPointerPoint(baselineProbe.viewportRect, page.viewportSize());
    if (!neutral) {
      outcomes.push(inconclusive("STATE_TARGET_FULL_VIEWPORT", sampleKey));
      continue;
    }
    try {
      await withDeadline(page.mouse.move(neutral.x, neutral.y), remaining());
      baselineProbe = await probe(
        page,
        {
          op: "measure",
          selector: target.selector,
          scrollRoot: options.scrollRoot,
          scrollIntoView: false,
        },
        remaining(),
      );
    } catch (error) {
      outcomes.push(inconclusive(failureCode(error), sampleKey));
      await options.reset().catch(() => undefined);
      continue;
    }
    if (
      baselineProbe.status !== "ok" ||
      !baselineProbe.styles ||
      !baselineProbe.rect
    ) {
      outcomes.push(
        inconclusive(
          baselineProbe.status === "ambiguous"
            ? "STATE_TARGET_AMBIGUOUS"
            : baselineProbe.status === "missing"
              ? "STATE_TARGET_MISSING"
              : "STATE_PROBE_FAILED",
          sampleKey,
        ),
      );
      await options.reset().catch(() => undefined);
      continue;
    }
    const baseline = {
      rect: baselineProbe.rect,
      styles: baselineProbe.styles,
    };
    let observedProbe: AtlasStateProbeResult | null = null;
    let code: string | null = null;
    try {
      if (action === "hover") {
        const center = baselineProbe.center!;
        await withDeadline(
          page.mouse.move(center.x, center.y),
          remaining(),
        );
        if (settleMs > 0) await page.waitForTimeout(settleMs);
        observedProbe = await probe(
          page,
          {
            op: "measure-hover",
            selector: target.selector,
            scrollRoot: options.scrollRoot,
            scrollIntoView: false,
            pointer: { x: center.x, y: center.y },
          },
          remaining(),
        );
        if (!observedProbe.hovered) code = "STATE_HOVER_NOT_ACTIVE";
      } else {
        observedProbe = await probe(
          page,
          {
            op: "focus",
            selector: target.selector,
            scrollRoot: options.scrollRoot,
            scrollIntoView: false,
          },
          remaining(),
        );
        if (settleMs > 0) await page.waitForTimeout(settleMs);
        observedProbe = await probe(
          page,
          {
            op: "measure",
            selector: target.selector,
            scrollRoot: options.scrollRoot,
            scrollIntoView: false,
          },
          remaining(),
        );
        if (!observedProbe.activeWithin) code = "STATE_FOCUS_UNCONFIRMED";
        else if (!observedProbe.focusVisible) code = "STATE_FOCUS_NOT_VISIBLE";
      }
    } catch (error) {
      code = failureCode(error);
    }
    // The interaction may have relabelled, replaced or restructured the
    // element. Check the live DOM before the reset removes the state.
    if (
      !code &&
      observedProbe?.status === "ok" &&
      options.revalidateRegion
    ) {
      try {
        const check = await withDeadline(
          options.revalidateRegion(target, region),
          remaining(),
        );
        if (!check.ok) code = check.code;
      } catch (error) {
        code = failureCode(error);
      }
    }
    // Restore the neutral baseline even when the observation failed.
    await options.reset().catch(() => undefined);
    if (!observedProbe || code) {
      outcomes.push(inconclusive(code ?? "STATE_PROBE_FAILED", sampleKey));
      continue;
    }
    if (observedProbe.status !== "ok" || !observedProbe.rect) {
      // The element disappeared or became ambiguous between the baseline and
      // the state measurement; the sample cannot be attributed.
      outcomes.push(
        inconclusive(
          observedProbe.status === "ambiguous"
            ? "STATE_TARGET_AMBIGUOUS"
            : observedProbe.status === "missing"
              ? "STATE_TARGET_MISSING"
              : "STATE_PROBE_FAILED",
          sampleKey,
        ),
      );
      continue;
    }
    const observedStyles = observedProbe.styles ?? {};
    const styles = changedStyleKeys(baseline.styles, observedStyles);
    const moved = geometryChanged(baseline.rect, observedProbe.rect);
    if (styles.length === 0 && !moved) {
      outcomes.push(inconclusive("STATE_NO_CHANGE", sampleKey));
      continue;
    }
    const claimValue =
      action === "hover" ? "hover_change_observed" : "focus_visible_observed";
    const sample: AtlasStateSamplePayload = {
      key: region.observationKey,
      sampleKey,
      selector: region.selector,
      tag: region.tag,
      heading: region.heading || null,
      text: region.text,
      rect: observedProbe.rect!,
      scrollX: observedProbe.scrollX ?? 0,
      scrollY: observedProbe.scrollY ?? 0,
      coordinateSpace: observedProbe.coordinateSpace ?? "document",
      inScrollRoot: observedProbe.inScrollRoot === true,
      visible: observedProbe.visible === true,
    };
    outcomes.push({
      action,
      targetRegionId: target.request.targetRegionId,
      status: "observed",
      regionKey: region.key,
      sampleKey,
      sample,
      evidence: {
        schemaVersion: "awwwards-atlas-state-v1",
        action,
        state: action,
        targetRegionId: target.request.targetRegionId,
        targetKey: region.key,
        viewport: options.viewport,        checkpoint: options.checkpoint,
        scrollRoot: options.scrollRoot,
        baselineScroll,
        coordinateSpace: sample.coordinateSpace,
        scrollX: sample.scrollX,
        scrollY: sample.scrollY,
        rect: sample.rect,
        baseline,
        observed: {
          rect: observedProbe.rect,
          styles: observedStyles,
        },
        changedProperties: styles,
        geometryChanged: moved,
        hovered: observedProbe.hovered === true,
        focusVisible: observedProbe.focusVisible === true,
        activeElement: {
          tag: observedProbe.activeTag ?? null,
          self: observedProbe.activeSelf === true,
          within: observedProbe.activeWithin === true,
        },
      },
      claimValue,
    });
  }
  return outcomes;
}
