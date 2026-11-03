import { poseGridInputError, type PoseGrid } from "./pose3d.js";
import type { ScrollCensus } from "./census.js";

// Deterministic one-line derived note values shared with the server handler's
// notes: st = ScrollTrigger count, pin = pinned anims, ease = distinct easings.
export function poseSuggestions(census: ScrollCensus): {
  st: number;
  pin: number;
  ease: string[];
} {
  return {
    st: census.counts["gsap-scrolltrigger"] ?? 0,
    pin: census.anims.filter((a) => a.pin).length,
    ease: [...new Set(census.anims.map((a) => a.easing).filter((e): e is string => Boolean(e)))],
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Inline-script literal: JSON with "<" neutralized so no embedded string can
// terminate the surrounding <script> (</script> breakout).
const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

// Line-comment text: neutralize "<" and collapse line terminators so an
// attacker-controlled census value cannot escape the comment or the script.
const commentText = (s: string): string =>
  s.replace(/</g, "\\u003c").replace(/[\r\n\u2028\u2029]+/g, " ");

const r4 = (n: number): number => Math.round(n * 1000) / 1000;

// PURE + synchronous: renders a PoseGrid as a standalone three.js stub page —
// snapshot frames preloaded as an image sequence, a SYNTHESIZED camera path
// linearly interpolated between snapshot scrollRatios (guidance, not recovered
// camera data — PoseSnapshot has no x/y/z), scroll-scrubbed with gsap, and a
// prefers-reduced-motion early-return to a static first frame. When a
// ScrollCensus is supplied, st/pin/ease SUGGESTION comment lines precede the
// module script (guidance for the implementer, never executed). Emits no eval
// and no Date.now — identical input grids render byte-identical stubs.
export function buildPoseStubHtml(
  grid: PoseGrid,
  extra?: { scrollCensus?: ScrollCensus },
): string {
  const invalid = poseGridInputError(grid);
  if (invalid) throw new Error(invalid);
  const frames = grid.snapshots
    .flatMap((s) => s.frames.map((f) => f.dataUrlPng))
    .filter(Boolean);
  // Synthesized camera anchors (guidance, not recovered camera data): one per
  // snapshot — slight rise + dolly-in per scroll step.
  const anchors = grid.snapshots.map((s) => ({
    t: r4(s.scrollRatio),
    x: 0,
    y: r4(s.scrollRatio * 2.5),
    z: r4(5 - s.scrollRatio * 2.5),
  }));

  const census = extra?.scrollCensus;
  let suggestions = "";
  if (census) {
    const s = poseSuggestions(census);
    const lines: string[] = [];
    if (s.st > 0)
      lines.push(
        `// SUGGESTION(st) from reference census: ${s.st} gsap-scrolltrigger animation(s) — drive camera t from their scrub triggers`,
      );
    if (s.pin > 0)
      lines.push(
        `// SUGGESTION(pin) from reference census: ${s.pin} pinned section(s) — consider pinning the canvas across its scroll span`,
      );
    if (s.ease.length > 0)
      lines.push(
        `// SUGGESTION(ease) from reference census: ${commentText(s.ease.join(", "))} — reuse these easings between synthesized camera anchors`,
      );
    suggestions = lines.length ? lines.join("\n") + "\n" : "";
  }

  const framesJson = scriptJson(frames);
  const anchorsJson = scriptJson(anchors);

  return `<!doctype html>
<!-- awwwards-mcp pose stub (pose-grid-v1) — source: ${esc(grid.url)} -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pose stub — ${esc(grid.url)}</title>
<style>
  html, body { margin: 0; background: #0b0d12; }
  #pose-canvas { position: fixed; inset: 0; width: 100%; height: 100%; display: block; }
  #scroll-room { height: 600vh; }
</style>
</head>
<body>
<canvas id="pose-canvas" width="${grid.canvasW}" height="${grid.canvasH}"></canvas>
<div id="scroll-room"></div>
<script type="module">
${suggestions}
import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";
import { gsap } from "https://unpkg.com/gsap@3.12.5/index.js";

// Captured frames, one dataURL per scroll step (values from the PoseGrid).
const FRAMES = ${framesJson};
// Synthesized camera anchors per snapshot (guidance only, not recovered camera data):
// t = scrollRatio of the source capture.
const ANCHORS = ${anchorsJson};

const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById("pose-canvas"), antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight, false);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
const geometry = new THREE.PlaneGeometry(6.4, 3.6);
const material = new THREE.MeshBasicMaterial();
scene.add(new THREE.Mesh(geometry, material));

const textureLoader = new THREE.TextureLoader();
function showFrame(i) {
  const url = FRAMES[Math.max(0, Math.min(FRAMES.length - 1, Math.round(i)))];
  if (!url) return;
  textureLoader.load(url, function (tex) {
    tex.colorSpace = THREE.SRGBColorSpace;
    if (material.map && material.map !== tex) material.map.dispose();
    material.map = tex;
    material.needsUpdate = true;
    renderer.render(scene, camera);
  });
}

// Linear interpolation between snapshot scrollRatio anchors: find the two
// anchors bracketing target t, then camera.position.lerpVectors(a, b, f).
function posAt(t) {
  let hi = 0;
  while (hi < ANCHORS.length - 1 && ANCHORS[hi].t < t) hi++;
  const b = ANCHORS[hi];
  const a = ANCHORS[Math.max(0, hi - 1)];
  const span = b.t - a.t;
  const f = span > 0 ? Math.max(0, Math.min(1, (t - a.t) / span)) : 0;
  const va = new THREE.Vector3(a.x, a.y, a.z);
  const vb = new THREE.Vector3(b.x, b.y, b.z);
  camera.position.lerpVectors(va, vb, f);
  camera.lookAt(0, 0, 0);
}

// Scrub timeline: window.scrollY / (scrollHeight - innerHeight) maps to t,
// then gsap's ticker re-renders only when the target moves.
function scrubTarget() {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return max > 0 ? window.scrollY / max : 0;
}
let current = -1;
function renderAt(t) {
  if (t === current) return;
  current = t;
  posAt(t);
  showFrame(t * (FRAMES.length - 1));
  renderer.render(scene, camera);
}

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.render(scene, camera);
}
window.addEventListener("resize", resize);

window.addEventListener("pagehide", function (event) {
  if (event.persisted) return; // keep resources alive for bfcache restore
  if (material.map) material.map.dispose();
  geometry.dispose();
  material.dispose();
  renderer.dispose();
});

posAt(0);
showFrame(0);
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  // Reduced motion: static first frame, no scroll-driven camera motion.
  showFrame(0);
  renderer.render(scene, camera);
} else {
  gsap.ticker.add(function () {
    renderAt(scrubTarget());
  });
  window.addEventListener("scroll", function () {
    renderAt(scrubTarget());
  }, { passive: true });
}
</script>
</body>
</html>
`;
}
