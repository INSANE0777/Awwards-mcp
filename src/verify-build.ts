// Pure verify-build layer: motion fingerprinting, band comparison, verdict.
// No static runtime imports (mirrors easings.ts) so tests and later server.ts
// wiring can pull this in without Playwright or node deps. The fingerprint
// string is the ONLY interchange format: motionDiffScore re-parses it, so
// caller and verifier don't need to share an object type.
//
// Aegon port (aegon-mcp MIT — A:\Motion; plan 2026-10-19 Task 3): a
// best-effort build-side EVIDENCE pass appends two trailing evidence lines —
// measured runtime perf (perf-live.ts) + static anti-patterns
// (audit-rules.ts) — evidence only: any failure degrades to one line and the
// score/verdict math above is untouched. Defaults lazy-import like the
// structure/scroll/hover defaults; offline tests inject fakes.
import type { PageBand, PageStructure, WaitStrategy } from "./structure.js";
import type { CensusAcquisition, ScrollCensus } from "./census.js";
import type { HoverCensus } from "./hover-census.js";
import type { ViewportName } from "./viewport.js";
import type { PerfMeasurement } from "./perf-live.js";
import type { AntiPatternFinding } from "./audit-rules.js";
import type { ComponentPack, ComponentNode } from "./component.js";

export interface MotionCensusInput {
  counts: Record<string, number>;
  anims: { easing: string | null; scrub: boolean; pin: boolean }[];
  nativeScrollTimelines: number;
  /** Pre-aggregated easing vocabulary; falls back to anims' easings. */
  easingTokens?: string[];
}

export interface BandRow {
  label: string;
  bg: string | null;
  tag: string;
  /** Band height in px; optional evidence for the generic-label fallback. */
  height?: number;
}

export interface VerifyReport {
  buildUrl: string;
  referenceUrl: string;
  bands: { score: number; matched: string[]; refOnly: string[]; buildOnly: string[] };
  motion: {
    score: number;
    refFingerprint: string;
    buildFingerprint: string;
    /** Present only when BOTH censuses carried acquisition state (absent for legacy/saved evidence that lacks it). */
    acquisition?: { reference: CensusAcquisition; build: CensusAcquisition };
  };
  overall: number;
  verdict: "pass" | "warn" | "fail";
  evidence: string[];
  /** Only present when the caller opts into domDiff (key absent otherwise). */
  domDiff?: DomDiffResult;
}

// Fixed order = positional tr tokens ("g3" = 3 gsap-scrolltrigger anims);
// "unknown" is deliberately excluded — it means "couldn't classify".
const TRIGGER_KEYS = [
  "gsap-scrolltrigger",
  "css-scroll-timeline",
  "css-view-timeline",
  "data-attr",
  "css-keyframe",
  "smil",
] as const;
const TRIGGER_PREFIX: Record<(typeof TRIGGER_KEYS)[number], string> = {
  "gsap-scrolltrigger": "g",
  "css-scroll-timeline": "c",
  "css-view-timeline": "v",
  "data-attr": "d",
  "css-keyframe": "k",
  smil: "s",
};

export function motionFingerprint(c: MotionCensusInput): string {
  const tr = TRIGGER_KEYS.map(
    (k) => `${TRIGGER_PREFIX[k]}${c.counts[k] ?? 0}`
  ).join(",");
  const sc = c.anims.filter((a) => a.scrub).length;
  const pin = c.anims.filter((a) => a.pin).length;
  const easings = (c.easingTokens ?? c.anims.map((a) => a.easing))
    .filter((e): e is string => e !== null)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(",");
  // "k1" is a format version tag so future parsers can bail politely.
  return `k1|tr:${tr}|nat:${c.nativeScrollTimelines}|sc:${sc}|pin:${pin}|e:${easings}`;
}

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
};

export function motionDiffScore(a: string, b: string): number {
  const parse = (fp: string) => {
    const p = { tr: new Set<string>(), nat: 0, sc: 0, pin: 0, e: new Set<string>() };
    for (const seg of fp.split("|")) {
      const i = seg.indexOf(":");
      if (i < 0) continue; // the "k1" version tag
      const key = seg.slice(0, i);
      const val = seg.slice(i + 1);
      if (key === "tr") {
        for (const t of val.split(",")) if (t) p.tr.add(t);
      } else if (key === "nat") {
        p.nat = Number(val) || 0;
      } else if (key === "sc") {
        p.sc = Number(val) || 0;
      } else if (key === "pin") {
        p.pin = Number(val) || 0;
      } else if (key === "e") {
        for (const t of val.split(",")) if (t) p.e.add(t);
      }
    }
    return p;
  };
  const pa = parse(a), pb = parse(b);
  const trJ = jaccard(pa.tr, pb.tr);
  const l1 = Math.abs(pa.sc - pb.sc) + Math.abs(pa.pin - pb.pin);
  const eJ = jaccard(pa.e, pb.e);
  const natD = Math.abs(pa.nat - pb.nat);
  const score =
    0.30 * trJ +
    0.20 * (1 - Math.min(1, l1 / 8)) +
    0.35 * eJ +
    0.15 * (1 - Math.min(1, natD / 10));
  return Math.round(score * 100);
}

const normLabel = (s: string) => s.trim().toLowerCase();
const normBg = (s: string | null) => (s ?? "").trim().toLowerCase();

// Labels the structure scanner emits for anonymous wrappers: they name no
// section, so label equality alone proves nothing about which band is which.
const GENERIC_LABELS = new Set(["", "body", "div", "section", "main", "header", "footer", "nav", "(unlabeled)"]);

const heightOf = (row: BandRow): number | null =>
  typeof row.height === "number" && Number.isFinite(row.height) ? row.height : null;

// Relative height gap, symmetric and 0 when both sides are 0.
const heightGap = (a: number, b: number): number => {
  const denom = Math.max(Math.abs(a), Math.abs(b));
  return denom === 0 ? 0 : Math.abs(a - b) / denom;
};

export function compareBands(
  ref: BandRow[],
  build: BandRow[]
): { score: number; matched: string[]; refOnly: string[]; buildOnly: string[] } {
  const pool = build.map((b) => ({
    label: normLabel(b.label),
    display: b.label.trim(),
    bg: normBg(b.bg),
    tag: b.tag,
    height: heightOf(b),
    used: false,
  }));
  const buildLabelCounts = new Map<string, number>();
  for (const b of pool) {
    buildLabelCounts.set(b.label, (buildLabelCounts.get(b.label) ?? 0) + 1);
  }
  const matched: string[] = [];
  const refOnly: string[] = [];
  // Greedy first match, consuming the build pool so one build band can't
  // absorb several ref bands.
  for (const r of ref) {
    const rl = normLabel(r.label);
    const rb = normBg(r.bg);
    let hit = pool.find(
      (b) =>
        !b.used &&
        (((b.label === rl && !GENERIC_LABELS.has(rl) && (buildLabelCounts.get(rl) ?? 0) === 1)) ||
          (b.bg !== "" && b.bg === rb && b.tag === r.tag))
    );
    // A rebuild with anonymous wrappers (empty/body labels, or duplicates) has
    // no label identity; fall back to same-tag + closest height. A named build
    // band never matches an unrelated generic ref band by height alone.
    if (!hit) {
      const rh = heightOf(r);
      const buildGeneric = (b: typeof pool[number]) =>
        GENERIC_LABELS.has(b.label) || (buildLabelCounts.get(b.label) ?? 0) > 1;
      if (rh !== null) {
        let bestGap = Infinity;
        for (const b of pool) {
          if (b.used || b.tag !== r.tag || b.height === null || !buildGeneric(b)) continue;
          // Different explicit backgrounds are different sections, not a match.
          if (rb !== "" && b.bg !== "" && rb !== b.bg) continue;
          const gap = heightGap(rh, b.height);
          if (gap <= 0.25 && gap < bestGap) {
            bestGap = gap;
            hit = b;
          }
        }
      }
    }
    if (hit) {
      hit.used = true;
      matched.push(r.label.trim());
    } else {
      refOnly.push(r.label.trim() || "(unlabeled)");
    }
  }
  const buildOnly = pool.filter((b) => !b.used).map((b) => b.display);
  const total = ref.length + build.length;
  const score = total === 0 ? 100 : Math.round((2 * matched.length) / (total) * 100);
  return { score, matched, refOnly, buildOnly };
}

export function verdictFrom(bandScore: number, motionScore: number) {
  const overall = Math.round(0.6 * bandScore + 0.4 * motionScore);
  const verdict: VerifyReport["verdict"] =
    overall >= 80 ? "pass" : overall >= 55 ? "warn" : "fail";
  const evidence = [
    `Bands: ${bandScore}/100 similarity`,
    `Motion: ${motionScore}/100 fingerprint similarity`,
    `Overall: ${overall}/100 → ${verdict.toUpperCase()}`,
  ];
  return { overall, verdict, evidence };
}

// One-line acquisition disclosure appended to live reports. The zero/absent
// case stays byte-identical: when either side lacks acquisition state, no
// line is added, so legacy output is preserved.
function captureEvidenceLine(
  reference: CensusAcquisition,
  build: CensusAcquisition,
): string {
  const side = (a: CensusAcquisition): string => {
    const h = a.documentHeight === null ? "?" : String(a.documentHeight);
    const stable =
      a.stable === null ? "stability-unknown" : a.stable ? "stable" : "MUTATED";
    return `h=${h} anims=${a.animationCount} gsap=${a.gsapRegistryCount} ${stable}`;
  };
  return (
    `capture: reference ${side(reference)}; build ${side(build)} ` +
    `(wait=${reference.waitStrategy}/${build.waitStrategy}, settle=${reference.settleMs}+${reference.postScrollMs}ms)`
  );
}

// ---- D2: DOM-structure diff between two component captures ----
// Bounded + honest by construction: skeleton paths are tag+index chains
// (index = position among same-tag siblings, so inserting a different tag
// never shifts later indices); every output list caps at 40 (first-wins in
// DFS order); and `incomplete` is true whenever the evidence behind these
// lists is unsound — an errored scan, a scan truncated at the maxNodes cap,
// or a list cut at its cap. Absence of evidence proves nothing: a clean
// diff over truncated/errored input must never read as a verified match.

export interface DomDiffResult {
  /** ref-side paths absent from the build. */
  missing: string[];
  /** build-side paths absent from the reference. */
  extra: string[];
  /** paths present in both whose relative order among common siblings differs. */
  reordered: string[];
  /** matched paths whose L∞ rect delta exceeds the drift floor. */
  rectDrift: Array<{ path: string; dPx: number }>;
  incomplete: boolean;
}

export interface DomDiffOptions {
  /** The capture cap actually used; a pack's nodeCount ≥ cap ⇒ truncated scan. */
  maxNodes?: number;
  /** L∞ rect delta (px) above which a matched node counts as drifted (default 8). */
  rectDriftPx?: number;
}

const DOM_DIFF_LIST_CAP = 40;

type DomDiffInput = ComponentPack | { error: string };

export function diffComponentTrees(
  refTree: DomDiffInput,
  buildTree: DomDiffInput,
  opts?: DomDiffOptions,
): DomDiffResult {
  const cap = Math.min(2000, Math.max(50, opts?.maxNodes ?? 1200));
  const driftFloor = opts?.rectDriftPx ?? 8;

  const isErr = (t: DomDiffInput): boolean => "error" in t;
  const truncated = (t: DomDiffInput): boolean =>
    !isErr(t) && (t as ComponentPack).nodeCount >= cap;

  // DFS pre-order skeleton (empty map for errored input, so every ref node
  // reports missing and `incomplete` carries the caveat).
  const skeletonize = (pack: ComponentPack): Map<string, { rect: ComponentNode["rect"]; order: number }> => {
    const map = new Map<string, { rect: ComponentNode["rect"]; order: number }>();
    const walk = (node: ComponentNode, path: string, order: number): void => {
      map.set(path, { rect: node.rect, order });
      const perTag = new Map<string, number>();
      let ord = 0;
      for (const child of node.children) {
        const n = perTag.get(child.tag) ?? 0;
        perTag.set(child.tag, n + 1);
        walk(child, `${path}/${child.tag}[${n}]`, ord);
        ord++;
      }
    };
    walk(pack.root, pack.root.tag, 0);
    return map;
  };

  const ref = isErr(refTree) ? new Map() : skeletonize(refTree as ComponentPack);
  const build = isErr(buildTree) ? new Map() : skeletonize(buildTree as ComponentPack);
  const incompleteScan = isErr(refTree) || isErr(buildTree) || truncated(refTree) || truncated(buildTree);

  const parentOf = (path: string): string =>
    path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

  // First-wins DFS order (Map insertion order == pre-order walk).
  const allMissing = [...ref.keys()].filter((k) => !build.has(k));
  const allExtra = [...build.keys()].filter((k) => !ref.has(k));

  // Relative-order check per parent, over COMMON children only: ranks among
  // the filtered sequences make this robust — inserting a new child shifts
  // positional indices but never the common siblings' relative order.
  const rawReordered: string[] = [];
  const parents = new Set<string>();
  for (const k of ref.keys()) if (build.has(k)) parents.add(parentOf(k));
  for (const parent of parents) {
    const rankOf = (entries: [string, { rect: ComponentNode["rect"]; order: number }][]) =>
      new Map(entries.map(([k], i) => [k, i]));
    const refSeq = [...ref].filter(([k]) => build.has(k) && parentOf(k) === parent);
    const buildSeq = [...build].filter(([k]) => ref.has(k) && parentOf(k) === parent);
    const refRank = rankOf(refSeq);
    const buildRank = rankOf(buildSeq);
    for (const [k, r] of refRank) {
      if (buildRank.get(k) !== r) rawReordered.push(k);
    }
  }

  const rawDrift: Array<{ path: string; dPx: number }> = [];
  for (const [path, s] of ref) {
    const b = build.get(path);
    if (!b) continue;
    const d = Math.max(
      Math.abs(s.rect.x - b.rect.x),
      Math.abs(s.rect.y - b.rect.y),
      Math.abs(s.rect.w - b.rect.w),
      Math.abs(s.rect.h - b.rect.h),
    );
    if (d > driftFloor) rawDrift.push({ path, dPx: Math.round(d * 10) / 10 });
  }

  return {
    missing: allMissing.slice(0, DOM_DIFF_LIST_CAP),
    extra: allExtra.slice(0, DOM_DIFF_LIST_CAP),
    reordered: rawReordered.slice(0, DOM_DIFF_LIST_CAP),
    rectDrift: rawDrift.slice(0, DOM_DIFF_LIST_CAP),
    incomplete:
      incompleteScan ||
      allMissing.length > DOM_DIFF_LIST_CAP ||
      allExtra.length > DOM_DIFF_LIST_CAP ||
      rawReordered.length > DOM_DIFF_LIST_CAP ||
      rawDrift.length > DOM_DIFF_LIST_CAP,
  };
}

// Task 6 wiring contract: server.ts createHandlers deps get an optional
// verifyBuildFn of this shape (peers: ScrollMapFn/HoverCensusFn in server.ts).
export type VerifyBuildFn = (
  args: {
    buildUrl: string;
    referenceUrl: string;
    waitStrategy?: WaitStrategy;
    viewport?: ViewportName;
    domDiff?: boolean;
  },
) => Promise<VerifyReport | { error: string }>;

// Orchestrates the design loop: structure-scan both pages → scroll-census
// both → hover-census both (presence only — the score stays scroll-focused).
type VerifyStructureFn = (
  url: string,
) => Promise<PageStructure | { error: string }>;
type VerifyScrollFn = (url: string) => Promise<ScrollCensus | { error: string }>;
type VerifyHoverFn = (url: string) => Promise<HoverCensus | { error: string }>;

// Aegon-port evidence knobs (plan Task 3). Both produce evidence lines only —
// never score/verdict inputs — and every failure degrades to a one-line note.
type VerifyPerfFn = (
  url: string,
  opts?: { seconds?: number },
) => Promise<PerfMeasurement | { error: string }>;
type VerifyRulesFn = (
  inputs: { html: string },
) => AntiPatternFinding[] | Promise<AntiPatternFinding[]>;
// D2 dom-diff knob: same injectable-fake shape as its peers above.
type VerifyComponentFn = (
  url: string,
  opts?: { selector?: string; maxNodes?: number; viewport?: ViewportName },
) => Promise<ComponentPack | { error: string }>;

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

// PerfMeasurement (perf-live.ts renamed aegon's collector fields) → evidence
// line. Field mapping: fps→fps, droppedFrames→dropped, longTaskCount→
// longTasks, layoutThrashCount→thrash.
async function perfEvidenceLine(
  perfFn: VerifyPerfFn,
  buildUrl: string,
): Promise<string> {
  try {
    // FPS-window audit (plan Task C1, comfyui frontend issue #15997: a helper
    // that samples rAF AFTER the workload describes the idle tail — a busy
    // workload can appear green). Ours cannot slide into that failure: the
    // perf-live collector is registered via Page.addScriptToEvaluateOnNewDocument
    // BEFORE navigation, so its in-page deadline (performance.now() + seconds)
    // starts at page-time 0 and the busy load/init work always falls INSIDE
    // the measured window. Residual bias points the strict way: navigation
    // dead-time dilutes fps downward, never green-washes it. Bounded to 6s.
    // Plan default: small measured window, ≤10s.
    const meas = await perfFn(buildUrl, { seconds: 6 });
    if ("error" in meas) return `perf: not measured (${meas.error})`;
    return `perf: fps=${num(meas.fps)} dropped=${num(meas.droppedFrames)} longTasks=${num(meas.longTaskCount)} thrash=${num(meas.layoutThrashCount)} (measured)`;
  } catch (err) {
    return `perf: not measured (${err instanceof Error ? err.message : String(err)})`;
  }
}

// One polite fetch of the build page's raw HTML — stack.ts's pattern: neutral
// UA, AbortController timer, {error} instead of throwing.
function fetchBuildHtml(
  fetchFn: typeof fetch,
  url: string,
): Promise<string | { error: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  return (async () => {
    try {
      const res = await fetchFn(url, {
        headers: { "user-agent": "verify-build/1.0 (research tooling)" },
        signal: ac.signal,
      });
      if (!res.ok) return { error: `HTTP ${res.status} fetching ${url}` };
      return await res.text();
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  })();
}

// Static scan of the fetched build HTML: finding count + worst rule by
// SEVERITY_WEIGHTS (findings without a severity — tier rows — weigh as INFO;
// first finding wins ties). Every failure degrades to a note.
async function rulesEvidenceLine(
  fetchFn: typeof fetch,
  rulesFn: VerifyRulesFn,
  buildUrl: string,
): Promise<string> {
  try {
    const html = await fetchBuildHtml(fetchFn, buildUrl);
    if (typeof html !== "string")
      return `anti-patterns: not scanned (${html.error})`;
    const findings = await rulesFn({ html });
    if (!Array.isArray(findings)) throw new Error("rulesFn returned a non-array");
    if (findings.length === 0) return "anti-patterns: 0";
    const { SEVERITY_WEIGHTS } = await import("./audit-rules.js");
    let worst = findings[0];
    for (const f of findings.slice(1)) {
      if (SEVERITY_WEIGHTS[f.severity ?? "INFO"] > SEVERITY_WEIGHTS[worst.severity ?? "INFO"])
        worst = f;
    }
    return `anti-patterns: ${findings.length} (worst: ${worst.ruleId})`;
  } catch (err) {
    return `anti-patterns: not scanned (${err instanceof Error ? err.message : String(err)})`;
  }
}

export async function verifyBuild(
  args: {
    buildUrl: string;
    referenceUrl: string;
    waitStrategy?: WaitStrategy;
    viewport?: ViewportName;
    // D2 opt-in: structural body-subtree diff (evidence-only, like perf/rules).
    domDiff?: boolean;
    // Injectable fakes for tests; lazily-imported defaults otherwise.
    structureFn?: VerifyStructureFn;
    scrollFn?: VerifyScrollFn;
    hoverFn?: VerifyHoverFn;
    componentFn?: VerifyComponentFn;
    // Aegon-port evidence knobs (evidence-only; offline tests inject fakes).
    perfFn?: VerifyPerfFn;
    rulesFn?: VerifyRulesFn;
    fetchFn?: typeof fetch;
  },
): Promise<VerifyReport | { error: string }> {
  // One shared wait/viewport profile for every capture of a verification run.
  const opts = { waitStrategy: args.waitStrategy, viewport: args.viewport };
  const structureFn =
    args.structureFn ??
    ((url: string) =>
      import("./structure.js").then((m) =>
        m.analyzePageStructure(url, undefined, undefined, opts),
      ));
  const scrollFn =
    args.scrollFn ??
    ((url: string) => import("./census.js").then((m) => m.captureScrollCensus(url, opts)));
  const hoverFn =
    args.hoverFn ??
    ((url: string) =>
      import("./hover-census.js").then((m) => m.captureHoverCensus(url, opts)));
  const perfFn =
    args.perfFn ??
    ((url: string, perfOpts?: { seconds?: number }) =>
      import("./perf-live.js").then((m) => m.measureRuntime(url, perfOpts)));
  const rulesFn =
    args.rulesFn ??
    ((inputs: { html: string }) =>
      import("./audit-rules.js").then((m) => m.scanAntiPatterns(inputs)));
  const componentFn =
    args.componentFn ??
    ((url: string) =>
      import("./component.js").then((m) =>
        m.captureComponent(url, { selector: "body", maxNodes: 1200, viewport: args.viewport }),
      ));
  const fetchFn = args.fetchFn ?? fetch;
  try {
    // Structure scan first: bands gate everything downstream, so a page that
    // won't load is reported before any motion capture spends time on it.
    const [refStruct, buildStruct] = await Promise.all([
      structureFn(args.referenceUrl),
      structureFn(args.buildUrl),
    ]);
    if ("error" in refStruct)
      return { error: `could not structure-scan reference page: ${refStruct.error}` };
    if ("error" in buildStruct)
      return { error: `could not structure-scan build page: ${buildStruct.error}` };

    const [refScroll, buildScroll] = await Promise.all([
      scrollFn(args.referenceUrl),
      scrollFn(args.buildUrl),
    ]);
    // Headless browser is the likely cause — the censuses need Playwright.
    if ("error" in refScroll)
      return { error: `motion census failed for reference page: ${refScroll.error} (headless browser required)` };
    if ("error" in buildScroll)
      return { error: `motion census failed for build page: ${buildScroll.error} (headless browser required)` };

    // Hover censuses are presence-only: surfaced in the JSON but they never
    // move the score, which stays scroll-focused.
    const [refHover, buildHover] = await Promise.allSettled([
      hoverFn(args.referenceUrl),
      hoverFn(args.buildUrl),
    ]);
    const hoverNote = (r: PromiseSettledResult<HoverCensus | { error: string }>) =>
      r.status === "fulfilled" && !("error" in r.value)
        ? `${r.value.samples.length} samples`
        : "unavailable";
    const hoverEvidence = `Hover: reference ${hoverNote(refHover)}, build ${hoverNote(buildHover)} (presence only)`;

    // Structure bands reach compareBands's BandRow shape. PageBand names the
    // field `background`, but tests/fixture-census callers may pass the `bg`
    // spelling — accept both.
    const bandRows = (bands: (PageBand & { bg?: string | null })[]) =>
      bands.map((b) => ({
        label: b.label ?? "",
        bg: b.bg ?? b.background ?? "",
        tag: b.tag,
        height: b.height,
      }));
    const bands = compareBands(bandRows(refStruct.bands), bandRows(buildStruct.bands));
    const refFp = motionFingerprint(refScroll);
    const buildFp = motionFingerprint(buildScroll);
    const motionScore = motionDiffScore(refFp, buildFp);
    const { overall, verdict, evidence } = verdictFrom(bands.score, motionScore);

    // Acquisition disclosure: the score above is a pure function of the two
    // fingerprints (identical saved inputs ⇒ identical score), but the live
    // fixed waits can sample different states of an async page. The full block
    // and capture line are added only when BOTH censuses carry acquisition;
    // the motion-line mutation suffix is added when either side reports
    // stable:false. Output stays unchanged when acquisition is absent.
    const refAcq = refScroll.acquisition;
    const buildAcq = buildScroll.acquisition;
    const captureUnstable = refAcq?.stable === false || buildAcq?.stable === false;
    if (captureUnstable) {
      evidence[1] = `${evidence[1]} (capture unstable: page changed during sampling)`;
    }
    const captureLine =
      refAcq && buildAcq ? captureEvidenceLine(refAcq, buildAcq) : null;

    // Aegon-port evidence pass, AFTER the score-derived lines. Evidence only:
    // never touches bands/motion/overall/verdict; every failure degrades to a
    // one-line note. Runs only on this happy path — the early {error} returns
    // above (structure/scroll) never reach it, so measurement is never
    // started for a run that already failed.
    const rulesLine = await rulesEvidenceLine(fetchFn, rulesFn, args.buildUrl);
    const perfLine = await perfEvidenceLine(perfFn, args.buildUrl);

    // D2 opt-in dom-structure diff: a third capture pair (body subtree,
    // selector "body" / maxNodes 1200) run on BOTH urls. Evidence-only like
    // the perf/anti-patterns pass: the line and the payload key exist only
    // when the caller asked for it, so the default report stays byte-identical.
    let domLine: string | null = null;
    let domDiff: DomDiffResult | undefined;
    if (args.domDiff) {
      const settled = await Promise.allSettled([
        componentFn(args.referenceUrl),
        componentFn(args.buildUrl),
      ]);
      const pack = (r: PromiseSettledResult<ComponentPack | { error: string }>): DomDiffInput =>
        r.status === "fulfilled"
          ? r.value
          : { error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
      const diff = diffComponentTrees(pack(settled[0]), pack(settled[1]), { maxNodes: 1200 });
      domDiff = diff;
      // "(incomplete)" suffix: counts alone would read as a verified match
      // when the scans errored/truncated (absence of evidence ≠ evidence).
      domLine =
        `dom: ${diff.missing.length} missing, ${diff.extra.length} extra, ${diff.rectDrift.length} rectDrift (body)` +
        (diff.incomplete ? " (incomplete)" : "");
    }

    return {
      buildUrl: args.buildUrl,
      referenceUrl: args.referenceUrl,
      bands,
      motion: {
        score: motionScore,
        refFingerprint: refFp,
        buildFingerprint: buildFp,
        ...(refAcq && buildAcq
          ? { acquisition: { reference: refAcq, build: buildAcq } }
          : {}),
      },
      overall,
      verdict,
      // Display order per the plan: perf line first, then anti-patterns.
      evidence: [
        evidence[0],
        evidence[1],
        evidence[2],
        hoverEvidence,
        perfLine,
        rulesLine,
        ...(domLine ? [domLine] : []),
        ...(captureLine ? [captureLine] : []),
      ],
      // Key absent when domDiff is off — pinned by a keys-absence test.
      ...(domDiff ? { domDiff } : {}),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ---- C3 token-diet helpers ----
// Pure compaction of capture results for the tools' `compact` flag. Strip
// rules (plan Task C3): heavy per-element detail → counts; every top-level
// numeric, trigger list and flag stays. census.ts / hover-census.ts are out
// of this wave's scope, so the helpers live here (this module already owns
// the ScrollCensus/HoverCensus typings).

/** ScrollCensus → diet: anims lose keyframes/durations/easings (props→count); scrubCurves → count. */
export function compactScrollCensus(c: ScrollCensus): {
  url: string;
  capturedAt: number;
  counts: ScrollCensus["counts"];
  nativeScrollTimelines: number;
  svgStrokes: string[];
  gsapRegistryCount: number;
  gsapTriggers: Array<Omit<ScrollCensus["gsapTriggers"][number], "vars">>;
  animCount: number;
  scrubCount: number;
  pinCount: number;
  scrubCurveCount: number;
  reducedMotion: boolean;
  acquisition?: ScrollCensus["acquisition"];
} {
  return {
    url: c.url,
    capturedAt: c.capturedAt,
    ...(c.acquisition ? { acquisition: c.acquisition } : {}),
    counts: c.counts,
    nativeScrollTimelines: c.nativeScrollTimelines,
    svgStrokes: c.svgStrokes,
    gsapRegistryCount: c.gsapRegistryCount,
    // Registry rows keep their compiled numerics; the bounded (but verbose)
    // tween vars map is the per-trigger detail that gets stripped.
    gsapTriggers: c.gsapTriggers.map((g) => ({
      selector: g.selector,
      scrub: g.scrub,
      pin: g.pin,
      startPx: g.startPx,
      endPx: g.endPx,
      progress: g.progress,
    })),
    animCount: c.anims.length,
    scrubCount: c.anims.filter((a) => a.scrub).length,
    pinCount: c.anims.filter((a) => a.pin).length,
    scrubCurveCount: c.scrubCurves?.length ?? 0,
    reducedMotion: c.reducedMotion,
  };
}

/** HoverCensus → diet: sample bodies (computed-style rows, trails) → selectors + count. */
export function compactHoverCensus(h: HoverCensus): {
  url: string;
  capturedAt: number;
  hoverRuleCount: number;
  candidates: number;
  sampleCount: number;
  sampleSelectors: string[];
  note?: string;
  reducedMotion: boolean;
} {
  return {
    url: h.url,
    capturedAt: h.capturedAt,
    hoverRuleCount: h.hoverRuleCount,
    candidates: h.candidates,
    sampleCount: h.samples.length,
    sampleSelectors: h.samples.map((s) => s.selector),
    ...(h.note !== undefined ? { note: h.note } : {}),
    reducedMotion: h.reducedMotion,
  };
}
