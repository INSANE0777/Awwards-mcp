// GSAP motion-stub builder: turns an evidence pack (pose grid + scroll census)
// into a runnable single-file HTML stub — GSAP+ScrollTrigger timelines per
// census anim, an optional scroll-driven camera module with anchors synthesized
// from pose-grid scroll ratios (guidance, not recovered camera data), and an
// unconditional reduced-motion guard.
// Pure + synchronous: never throws, never fetches, byte-deterministic output
// (no timestamps) so consumers can pin byte-equality on it.
// Ported from the agensi-kit gsap-stub tool (MIT); CLI/fs parts dropped.
import type { ScrollCensus } from "./census.js";
import type { PoseGrid } from "./pose3d.js";

// ---------------------------------------------------------------------------
// easing normalization (pure)
// ---------------------------------------------------------------------------

// cubic-bezier(x1,y1,x2,y2) -> nearest gsap token. Values mirror public easings
// docs (css keywords, material curves, common pen presets). Keys are looked up
// after 1-decimal rounding, so float noise like 0.3000000001 still hits.
const BEZIER_TABLE: [number[], string][] = [
  [[0.25, 0.1, 0.25, 1], "power2.out"], // css "ease"
  [[0.42, 0, 1, 1], "power2.in"], // css "ease-in"
  [[0, 0, 0.58, 1], "power2.out"], // css "ease-out"
  [[0.42, 0, 0.58, 1], "power2.inOut"], // css "ease-in-out"
  [[0, 0, 0.2, 1], "power3.out"], // material standard
  [[0.4, 0, 0.2, 1], "power3.out"], // material standard curve
  [[0.2, 0, 0, 1], "power3.out"], // decelerate
  [[0.55, 0.06, 0.68, 0.19], "power2.in"], // cubic ease-in
  [[0.55, 0, 1, 0.45], "power3.inOut"], // cubic ease-in-out
  [[0.32, 0, 0.67, 0], "power2.in"],
  [[0.17, 0.67, 0.12, 0.99], "expo.out"],
  [[0.83, 0, 0.17, 1], "power4.inOut"],
  [[0.16, 1, 0.3, 1], "power4.out"], // modern "easeOutExpo"
  [[0.33, 0, 0.2, 1], "power3.out"],
  [[0.33, 1, 0.68, 1], "power2.out"],
  [[0.65, 0, 0.35, 1], "power3.inOut"],
  [[0.11, 0, 0.5, 0], "power3.in"],
  [[0.39, 0.58, 0.57, 1], "sine.out"],
  [[0.95, 0.05, 0.795, 0.035], "expo.in"],
  [[0.45, 0, 0.55, 1], "power2.inOut"], // symmetric smooth
]; // 20 rows cap

const GSAP_TOKEN_RE = /^(power|back|elastic|bounce|circ|expo|sine)([1-4])?\.(in|out|inout)(\([-\d.]+\))?$/;
const FALLBACK_EASE = "power2.out";

const keyOf = (b: number[]) => b.map((n) => Math.round(n * 10) / 10).join(",");
const BEZIER_MAP = new Map(BEZIER_TABLE.map(([b, token]) => [keyOf(b), token]));

/** Normalize any census easing string to a gsap token (never throws). */
export function normalizeEase(raw: unknown): string {
  const s = String(raw ?? "").replace(/\s+/g, "").toLowerCase();
  if (!s) return FALLBACK_EASE;
  const nums = s.match(/^cubic-bezier\(([^)]+)\)$/);
  if (nums) {
    const b = nums[1].split(",").map(Number);
    if (b.length !== 4 || !b.every(Number.isFinite)) return FALLBACK_EASE;
    const exact = BEZIER_MAP.get(keyOf(b));
    if (exact) return exact;
    // nearest row by squared distance across all four control values
    let best = FALLBACK_EASE;
    let bestD = Infinity;
    for (const [b2, token] of BEZIER_TABLE) {
      const d = (b[0] - b2[0]) ** 2 + (b[1] - b2[1]) ** 2 + (b[2] - b2[2]) ** 2 + (b[3] - b2[3]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = token;
      }
    }
    return best;
  }
  if (GSAP_TOKEN_RE.test(s)) return s.replace(/\.inout$/, ".inOut"); // restore camelCase
  return FALLBACK_EASE;
}

// ---------------------------------------------------------------------------
// stub construction (pure)
// ---------------------------------------------------------------------------

const escHtml = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Safe literal for inline JS: standard JSON escaping + "<" neutralized so a
// hostile selector can never close the script tag.
const jsStr = (s: unknown) =>
  JSON.stringify(String(s))
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
// Line-comment text: no breaks (a newline would end the comment and run the
// payload) and no raw angle brackets (they could close the surrounding
// <script> in generated HTML).
const noteText = (s: unknown) =>
  String(s)
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
const round2 = (v: number) => Math.round(v * 100) / 100;
const num = (v: unknown, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

// Lenient lenses over the captured shapes: real inputs are PoseGrid /
// ScrollCensus, but every field is read through an unknown-checked view so
// schema drift (or plain null) can never throw the builder.
type SnapRow = { scrollRatio?: unknown; x?: unknown; y?: unknown; z?: unknown };
type AnimRow = {
  selector?: unknown;
  durationMs?: unknown;
  easing?: unknown;
  scrub?: unknown;
  pin?: unknown;
  trigger?: unknown;
  props?: unknown;
  svgStroke?: unknown;
};

/** Pure: (poseGrid, scrollCensus) -> complete html string. Synchronous. */
export function buildGsapStub(poseGrid: unknown, scrollCensus: unknown): string {
  const pg = (poseGrid ?? null) as Partial<PoseGrid> | null;
  const sc = (scrollCensus ?? null) as Partial<ScrollCensus> | null;
  const anims: AnimRow[] = Array.isArray(sc?.anims) ? sc.anims : [];
  const snaps: SnapRow[] = Array.isArray(pg?.snapshots) ? pg.snapshots : [];
  const canvasW = num(pg?.canvasW, 0);
  const canvasH = num(pg?.canvasH, 0);
  const canvasSel = typeof pg?.canvasSelector === "string" && pg.canvasSelector ? pg.canvasSelector : "#stage";
  const host = escHtml(typeof pg?.url === "string" ? pg.url : typeof sc?.url === "string" ? sc.url : "unknown");
  const censusHonorsReduced = sc?.reducedMotion === true;

  // L3 scrub probe curves (ScrubCurve in census.ts): measured keyframes for
  // scrubbed triggers. Lenient over runtime JSON; a null-transform step
  // contributes nothing, consecutive identical transforms collapse into one key.
  const curves = Array.isArray(sc?.scrubCurves) ? sc.scrubCurves : [];
  const measured = curves
    .filter((c) => c && typeof c.selector === "string" && c.selector.trim() && Array.isArray(c.steps))
    .map((c) => {
      const tos: string[] = [];
      for (const s of c.steps) {
        if (typeof s?.transform !== "string") continue;
        if (tos[tos.length - 1] !== s.transform) tos.push(s.transform);
      }
      return {
        selector: c.selector,
        startPx: num(c.startPx, 0),
        endPx: num(c.endPx, 0),
        tos,
      };
    });
  const measuredSels = new Set(measured.filter((m) => m.tos.length > 0).map((m) => m.selector));
  // D2 rider: a PINNED census row superseded by its measured scrub curve must
  // still end up pinned — the measured timeline replaces the census one, so
  // it inherits the flag (otherwise the stub silently unpins the section).
  const supersededPins = new Set(
    anims
      .filter(
        (a) =>
          a && a.scrub === true && a.pin === true &&
          typeof a.selector === "string" && measuredSels.has(a.selector),
      )
      .map((a) => a.selector as string),
  );
  // Camera keys: synthesized from pose-grid scroll ratios (not raw captured
  // camera coords — PoseSnapshot has no x/y/z): a gentle dolly-in mapped over
  // scroll progress. Optional s.x/s.y/s.z snapshot overrides win when present.
  const poseKeys = snaps
    .map((s) => {
      const t = Number(s?.scrollRatio);
      if (!Number.isFinite(t)) return null;
      return {
        t,
        x: num(s?.x, 0),
        y: num(s?.y, t * 2.5),
        z: num(s?.z, 12 - t * 4),
      };
    })
    .filter((k): k is NonNullable<typeof k> => k !== null)
    .sort((a, b) => a.t - b.t);
  const camEnabled = canvasW > 0 && poseKeys.length >= 2;

  // One timeline per usable census anim; duration from durationMs (fallback 0.6s), ease normalized.
  const timelines = anims
    .filter((a) => a && typeof a.selector === "string" && a.selector.trim())
    // a scrub anim with measured keyframes is superseded by its curve below —
    // the guessed tween would fight the measured one on the same trigger
    .filter((a) => !(a.scrub === true && measuredSels.has(a.selector as string)))
    .map((a) => {
      const ms = num(a.durationMs, 0);
      return {
        selector: a.selector as string,
        dur: ms > 0 ? round2(ms / 1000) : 0.6,
        ease: normalizeEase(a.easing),
        scrub: a.scrub === true,
        pin: a.pin === true,
        trigger: typeof a.trigger === "string" ? a.trigger : "unknown",
        props: Array.isArray(a.props) && a.props.length ? a.props.join(", ") : "",
        svgStroke: a.svgStroke === true,
      };
    });

  const timelineLines = timelines.map((t) => {
    const st = [`trigger: ${jsStr(t.selector)}`, `start: "top 80%"`];
    if (t.scrub) st.push(`scrub: true`);
    if (t.pin) st.push(`pin: true`);
    const note = `// census anim: ${noteText(t.selector)} | trigger: ${noteText(t.trigger)}${t.props ? ` | props: ${noteText(t.props)}` : ""}${t.svgStroke ? " | svg stroke draw (wire dashoffset here)" : ""}`;
    return `${note}
  gsap.timeline({ scrollTrigger: { ${st.join(", ")} }, defaults: { duration: ${t.dur}, ease: ${jsStr(t.ease)} } })
    .from(${jsStr(t.selector)}, { opacity: 0, y: 40 });`;
  });

  const animBlock = timelineLines.length
    ? timelineLines.join("\n\n")
    : "  // no usable scroll-census anims captured -- nothing to stub";

  // Measured scrub timelines (B1): one scrub-timeline per usable curve carrying
  // the probe's transform chain; a curve with no measured transforms falls back
  // to the census pattern, and one whose selector already has a census timeline
  // is skipped so nothing is emitted twice.
  const emitSels = new Set(timelines.map((t) => t.selector));
  const measuredLines = measured
    .filter((m) => m.tos.length > 0 || !emitSels.has(m.selector))
    .map((m) => {
      const note = `// measured scrub curve: ${noteText(m.selector)} ${m.startPx}->${m.endPx}`;
      const body = m.tos.length
        ? m.tos.map((tf) => `.to(${jsStr(m.selector)}, { transform: ${jsStr(tf)} })`).join("\n    ") + ";"
        : `.from(${jsStr(m.selector)}, { opacity: 0, y: 40 });`;
      const st = [`trigger: ${jsStr(m.selector)}`, `start: "top 80%"`, `scrub: true`];
      if (supersededPins.has(m.selector)) st.push(`pin: true`);
      const tl = `gsap.timeline({ scrollTrigger: { ${st.join(", ")} } })`;
      return `${note}\n  ${tl}\n    ${body}`;
    });
  const measuredBlock = measuredLines.length ? "\n\n" + measuredLines.join("\n\n") : "";

  const nativeNote = num(sc?.nativeScrollTimelines, 0) > 0
    ? `\n// census also found ${num(sc?.nativeScrollTimelines)} native scroll timelines (not recreated by this stub)\n`
    : "";

  const script = `gsap.registerPlugin(ScrollTrigger);

const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if (!REDUCED) {
  ${animBlock}${measuredBlock}${nativeNote}
  ScrollTrigger.refresh();
} else {
  // static first frame: no tweens created, content renders in its final state
}
`;

  const cameraModule = !camEnabled
    ? ""
    : `
<script type="module">
// camera interpolation from pose-grid snapshots (anchors synthesized from
// scroll ratios: gentle dolly-in), not raw captured camera coordinates
import * as THREE from "https://esm.sh/three@0.160.0";

const POSE_KEYS = ${JSON.stringify(poseKeys).replace(/</g, "\\u003c")};

function poseAt(t) {
  if (t <= POSE_KEYS[0].t) return POSE_KEYS[0];
  if (t >= POSE_KEYS[POSE_KEYS.length - 1].t) return POSE_KEYS[POSE_KEYS.length - 1];
  for (let i = 1; i < POSE_KEYS.length; i++) {
    if (t <= POSE_KEYS[i].t) {
      const a = POSE_KEYS[i - 1], b = POSE_KEYS[i];
      const f = (t - a.t) / (b.t - a.t || 1);
      return {
        t,
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        z: a.z + (b.z - a.z) * f,
      };
    }
  }
  return POSE_KEYS[POSE_KEYS.length - 1];
}

// placeholder stage object -- swap in the real scene
// runtime canvas is THIS stub's own #stage; the audited site's selector
// (canvasSelector: ${noteText(canvasSel)}) only documents the source capture.
const canvas = document.querySelector("#stage") ?? document.body;
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
${canvasW > 0 && canvasH > 0 ? `renderer.setSize(${canvasW}, ${canvasH}, false);` : ""}
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, ${canvasW > 0 && canvasH > 0 ? round2(canvasW / canvasH) : 1}, 0.1, 100);
scene.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshNormalMaterial()));
const applyPose = (p) => { camera.position.set(p.x, p.y, p.z); camera.lookAt(0, 0, 0); renderer.render(scene, camera); };

applyPose(poseAt(0)); // static first frame renders even under reduced motion
if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  ScrollTrigger.create({
    trigger: document.body,
    start: "top top",
    end: "bottom bottom",
    onUpdate: (self) => applyPose(poseAt(self.progress)),
  });
}
</script>
`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Motion stub -- ${host}</title>
<!-- generated motion stub from a local evidence pack (pose-grid + scroll-census) -->
${censusHonorsReduced ? "<!-- census: source already honors reduced motion; guard retained anyway -->\n" : ""}<style>
  body { margin: 0; background: #101014; color: #eee; font: 16px/1.5 system-ui, sans-serif; }
  #stage { position: sticky; top: 0; height: 100vh; }
  .stub-spacer { height: 400vh; }
  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
  }
</style>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js"></script>
</head>
<body>
<h1 style="position:fixed;left:12px;top:10px;margin:0;font:600 13px system-ui;opacity:.55">Generated motion stub</h1>
<div id="stage"></div>
<div class="stub-spacer"></div>
<script>
${script}</script>
${cameraModule}</body>
</html>
`;
}

/** DI shape consumed by the build_gsap_stub MCP tool handler. */
export type GsapStubFn = (args: { scrollCensus: unknown; poseGrid?: unknown }) => { stubHtml: string };
