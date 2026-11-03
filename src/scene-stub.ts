// Offline scaffold from one passive scene evidence pack. This module reads the
// pack JSON and lstat()s caller-supplied local asset paths; it never downloads,
// installs, writes a directory or reads an asset body, and it never executes
// captured code, shader source, userData or callbacks. Output is a file list:
// the caller writes it. Everything not proven by the evidence is an authored
// default, listed in the returned provenance.
import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative } from "node:path";
import type { SceneEvidence, SceneResource } from "./scene-capture.js";

export const SCENE_STUB_LIMITS = {
  maxEvidenceBytes: 2 * 1024 * 1024,
  maxBindings: 32,
  maxBindingBytes: 64 * 1024 * 1024,
  maxTitleChars: 200,
  maxUnboundRows: 10,
  maxAdapterNodes: 500,
  maxAdapterGaps: 40,
  maxAdapterNameChars: 128,
} as const;

export const SCENE_STUB_EXTENSIONS: readonly string[] = [
  "glb",
  "gltf",
  "bin",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "ktx2",
  "hdr",
  "exr",
];

/** Image formats THREE.TextureLoader can read without an extra loader. */
const TEXTURE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "webp"];

const ASSET_ID_RE = /^asset-\d{1,4}$/;

export interface SceneAssetBinding {
  /** Inventory handle from the pack's resources[].assetId. */
  resourceId: string;
  /** Local file the caller already holds; only lstat()ed, never read. */
  localPath: string;
}

export interface SceneStubOptions {
  evidencePath: string;
  assetBindings?: SceneAssetBinding[];
  title?: string;
  /** Capture namespace root; the handler passes <cache>/scene-captures. */
  sceneDir?: string;
}

export type SceneStubMode = "reconstructed-subset" | "placeholder";

export interface SceneStubFile {
  path: string;
  content: string;
}

export interface SceneAssetCopy {
  from: string;
  to: string;
}

export interface SceneStubUnresolved {
  evidenceRef: string;
  reason: string;
}

export interface SceneStubAuthoredDefault {
  path: string;
  value: string;
  reason: string;
}

export interface SceneStubProvenance {
  id: "scene-stub-provenance-v1";
  evidence: {
    id: SceneEvidence["id"];
    captureId: string;
    url: string;
    capturedAt: number | null;
    viewport: { name: string; width: number; height: number } | null;
    resourceTotal: number;
    resourcesCollected: number;
    resourcesTruncated: boolean;
  };
  mode: SceneStubMode;
  rights: { status: "not-recorded"; note: string };
  authoredDefaults: SceneStubAuthoredDefault[];
  unresolved: SceneStubUnresolved[];
  limitations: string[];
}

export interface SceneStubResult {
  id: "scene-stub-v1";
  mode: SceneStubMode;
  files: SceneStubFile[];
  assetCopies: SceneAssetCopy[];
  unresolved: SceneStubUnresolved[];
  authoredDefaults: SceneStubAuthoredDefault[];
  provenance: SceneStubProvenance;
}

export type SceneStubFn = (
  opts: SceneStubOptions,
) => Promise<SceneStubResult | { error: string }>;

const MIB = 1024 * 1024;

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message.replace(/\s+/g, " ").trim() : String(err);

/** Collapses page-derived text so it cannot forge extra markdown lines. */
const md = (value: string): string =>
  value.replace(/[`\r\n]+/g, " ").replace(/\s+/g, " ").trim();

const assetOrdinal = (assetId: string): number => Number(assetId.slice("asset-".length));

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Rejects "..", empty and NUL-bearing path segments at the trust boundary. */
function unsafeLocalPath(value: string): boolean {
  if (!value || value.includes("\0")) return true;
  return value.split(/[\\/]+/).some((segment) => segment === "..");
}

interface Binding {
  resourceId: string;
  localPath: string;
  extension: string;
  bytes: number;
  to: string;
  resource: SceneResource;
}

async function normalizeBindings(
  raw: unknown,
  resources: ReadonlyMap<string, SceneResource>,
): Promise<{ bindings: Binding[] } | { error: string }> {
  if (raw === undefined || raw === null) return { bindings: [] };
  if (!Array.isArray(raw)) return { error: "assetBindings must be an array." };
  if (raw.length > SCENE_STUB_LIMITS.maxBindings) {
    return {
      error: `assetBindings accepts at most ${SCENE_STUB_LIMITS.maxBindings} entries (received ${raw.length}).`,
    };
  }
  const bindings: Binding[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Partial<SceneAssetBinding> | null;
    const resourceId = typeof row?.resourceId === "string" ? row.resourceId : "";
    const localPath = typeof row?.localPath === "string" ? row.localPath : "";
    if (!ASSET_ID_RE.test(resourceId)) {
      return {
        error: `assetBindings[${i}].resourceId ${JSON.stringify(resourceId)} is not an inventory ID (expected asset-<n>).`,
      };
    }
    if (seen.has(resourceId)) {
      return { error: `assetBindings repeats resourceId ${resourceId}; each inventory row binds once.` };
    }
    seen.add(resourceId);
    if (unsafeLocalPath(localPath)) {
      return {
        error: `assetBindings[${i}].localPath is empty or contains a ".." traversal segment.`,
      };
    }
    const resource = resources.get(resourceId);
    if (!resource) {
      return { error: `assetBindings[${i}].resourceId ${resourceId} is not in this evidence inventory.` };
    }
    if (resource.classification === "script" || resource.classification === "shader") {
      return {
        error: `assetBindings[${i}].resourceId ${resourceId} is a captured ${resource.classification}; the stub never binds captured code or shader source.`,
      };
    }
    let entry;
    try {
      entry = await lstat(localPath);
    } catch {
      return { error: `assetBindings[${i}].localPath does not exist or is not readable.` };
    }
    if (entry.isSymbolicLink() || !entry.isFile()) {
      return { error: `assetBindings[${i}].localPath is not a regular file (symlinks are refused).` };
    }
    if (entry.size > SCENE_STUB_LIMITS.maxBindingBytes) {
      return {
        error: `assetBindings[${i}].localPath is ${Math.round((entry.size / MIB) * 10) / 10} MiB; the limit is ${SCENE_STUB_LIMITS.maxBindingBytes / MIB} MiB.`,
      };
    }
    const extension = extname(localPath).slice(1).toLowerCase();
    if (!SCENE_STUB_EXTENSIONS.includes(extension)) {
      return {
        error: `assetBindings[${i}].localPath has extension ".${extension || "(none)"}"; allowed: ${SCENE_STUB_EXTENSIONS.join(", ")}.`,
      };
    }
    bindings.push({
      resourceId,
      localPath,
      extension,
      bytes: entry.size,
      to: `public/assets/${resourceId}.${extension}`,
      resource,
    });
  }
  // Stable output: inventory order, not caller order.
  bindings.sort((a, b) => assetOrdinal(a.resourceId) - assetOrdinal(b.resourceId));
  return { bindings };
}

interface LoadedEvidence {
  evidence: SceneEvidence;
  resources: Map<string, SceneResource>;
}

async function loadEvidence(
  evidencePath: string,
  sceneDir: string,
): Promise<LoadedEvidence | { error: string }> {
  if (typeof evidencePath !== "string" || !evidencePath) {
    return { error: "evidencePath is required: the local scene-evidence-v1 JSON file." };
  }
  let entry;
  try {
    entry = await lstat(evidencePath);
  } catch {
    return { error: "evidencePath does not exist or is not readable." };
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    return { error: "evidencePath is not a regular file (symlinks are refused)." };
  }
  if (entry.size > SCENE_STUB_LIMITS.maxEvidenceBytes) {
    return {
      error: `evidencePath is larger than ${SCENE_STUB_LIMITS.maxEvidenceBytes / MIB} MiB.`,
    };
  }
  let evidence: SceneEvidence;
  try {
    evidence = JSON.parse(await readFile(evidencePath, "utf8")) as SceneEvidence;
  } catch {
    return { error: "evidencePath is not valid JSON." };
  }
  if (evidence?.id !== "scene-evidence-v1" || !Array.isArray(evidence.resources)) {
    return {
      error: 'evidencePath is not a scene-evidence-v1 pack (id must be "scene-evidence-v1" with resources[]).',
    };
  }
  if (typeof evidence.captureId !== "string" || !evidence.captureId) {
    return { error: "evidencePath has no captureId." };
  }

  // Namespace gate: only this server's own capture directory, or a pack the
  // caller explicitly exported (top-level "exported": true). Reading a random
  // JSON file would let an unrelated document masquerade as capture evidence.
  let resolved: string;
  let namespaceRoot: string | null = null;
  try {
    resolved = await realpath(evidencePath);
  } catch {
    return { error: "evidencePath could not be resolved." };
  }
  try {
    namespaceRoot = await realpath(sceneDir);
  } catch {
    namespaceRoot = null;
  }
  const exported = (evidence as { exported?: unknown }).exported === true;
  if (!exported && (!namespaceRoot || !inside(namespaceRoot, resolved))) {
    return {
      error:
        "evidencePath is outside the scene-captures directory; copy the pack out and set a top-level \"exported\": true to build from an exported pack.",
    };
  }

  const resources = new Map<string, SceneResource>();
  for (const row of evidence.resources) {
    if (typeof row?.assetId === "string" && ASSET_ID_RE.test(row.assetId) && !resources.has(row.assetId)) {
      resources.set(row.assetId, row);
    }
  }
  return { evidence, resources };
}

const extOf = (binding: Binding): string => binding.extension;
const isModel = (binding: Binding): boolean => ["glb", "gltf"].includes(extOf(binding));
const isTexture = (binding: Binding): boolean => TEXTURE_EXTENSIONS.includes(extOf(binding));

// ---- opt-in three adapter ------------------------------------------------
// The adapter block in evidence.json is page-derived and may come from an
// exported pack, so it is re-validated here: only known fields, finite numbers,
// bounded strings and the four primitive geometries are ever used.

type CapturedGeometryKind = "box" | "plane" | "sphere" | "cylinder";

interface CapturedMesh {
  name: string;
  kind: CapturedGeometryKind;
  args: number[];
  position: [number, number, number] | null;
  quaternion: [number, number, number, number] | null;
  scale: [number, number, number] | null;
  visible: boolean;
  material: {
    kind: "standard" | "basic";
    color: string | null;
    opacity: number | null;
    transparent: boolean;
    metalness: number | null;
    roughness: number | null;
    side: number | null;
    map: string | null;
  };
}

interface CapturedScene {
  meshes: CapturedMesh[];
  camera: { fov: number; near: number; far: number; matrixWorld: number[] } | null;
  lights: number;
  gaps: SceneStubUnresolved[];
}

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string" || !value) return null;
  return value.slice(0, max);
}

function tuple3(value: unknown): [number, number, number] | null {
  const parts = tupleN(value, 3);
  return parts ? (parts as [number, number, number]) : null;
}

function tuple4(value: unknown): [number, number, number, number] | null {
  const parts = tupleN(value, 4);
  return parts ? (parts as [number, number, number, number]) : null;
}

function tupleN(value: unknown, size: number): number[] | null {
  if (!Array.isArray(value) || value.length !== size) return null;
  const parts = value.map(finiteNumber);
  return parts.every((part): part is number => part !== null) ? parts : null;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/** Primitive geometry kinds only; anything else stays unresolved. */
function geometryKind(type: unknown): CapturedGeometryKind | null {
  if (typeof type !== "string") return null;
  const name = type.toLowerCase().replace(/geometry$/, "");
  return name === "box" || name === "plane" || name === "sphere" || name === "cylinder"
    ? name
    : null;
}

const MAX_DIMENSION = 1_000_000;

/** A numeric geometry parameter, or an explicit authored default plus a gap. */
function dimension(
  geometry: Record<string, unknown>,
  key: string,
  ref: string,
  gap: (evidenceRef: string, reason: string) => void,
): number {
  let value: unknown;
  const params = geometry.parameters;
  if (params && typeof params === "object") value = (params as Record<string, unknown>)[key];
  const n = finiteNumber(value);
  if (n === null || n < 0 || n > MAX_DIMENSION) {
    gap(
      ref,
      `geometry.parameters.${key} is missing or not a bounded number; an authored default of 1 is used for it.`,
    );
    return 1;
  }
  return round4(n);
}

function geometryArgs(
  kind: CapturedGeometryKind,
  geometry: Record<string, unknown>,
  ref: string,
  gap: (evidenceRef: string, reason: string) => void,
): number[] {
  const dim = (key: string): number => dimension(geometry, key, ref, gap);
  switch (kind) {
    case "box":
      return [dim("width"), dim("height"), dim("depth")];
    case "plane":
      return [dim("width"), dim("height")];
    case "sphere":
      return [dim("radius")];
    case "cylinder":
      return [dim("radiusTop"), dim("radiusBottom"), dim("height")];
  }
}

/** 16 finite elements, affine last row (0,0,0,1) and a non-zero upper-3x3 determinant. */
function validCameraMatrix(value: unknown): value is number[] {
  const m = tupleN(value, 16);
  if (!m) return false;
  const zero = (v: number): boolean => Math.abs(v) < 1e-6;
  if (!zero(m[3]!) || !zero(m[7]!) || !zero(m[11]!) || Math.abs(m[15]! - 1) > 1e-6) return false;
  const det =
    m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) -
    m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) +
    m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
  return Number.isFinite(det) && Math.abs(det) > 1e-8;
}

/**
 * Reads evidence.three when it is a usable adapter result with at least one
 * mesh. Malformed or meshless adapter data returns null, which keeps the
 * pre-adapter placeholder behaviour byte-for-byte.
 */
function capturedScene(evidence: SceneEvidence, bindings: Binding[]): CapturedScene | null {
  const raw = (evidence as { three?: unknown }).three;
  if (!raw || typeof raw !== "object") return null;
  const adapter = raw as Record<string, unknown>;
  if (adapter.id !== "three-adapter-v1" || adapter.available !== true) return null;
  const scene = adapter.scene as { nodes?: unknown } | null | undefined;
  if (!scene || typeof scene !== "object" || !Array.isArray(scene.nodes)) return null;
  const nodes = scene.nodes.slice(0, SCENE_STUB_LIMITS.maxAdapterNodes);

  const gaps: SceneStubUnresolved[] = [];
  const gap = (evidenceRef: string, reason: string): void => {
    if (gaps.length < SCENE_STUB_LIMITS.maxAdapterGaps) gaps.push({ evidenceRef, reason });
  };
  const byResource = new Map(bindings.map((binding) => [binding.resourceId, binding]));
  const texturePath = (assetId: unknown): string | null => {
    if (typeof assetId !== "string") return null;
    const binding = byResource.get(assetId);
    if (!binding || !isTexture(binding)) return null;
    return `/${binding.to.replace(/^public\//, "")}`;
  };

  const readMaterial = (rawMaterial: unknown, ref: string): CapturedMesh["material"] => {
    let value = rawMaterial;
    if (Array.isArray(value)) {
      gap(ref, "multi-material mesh: only the first material is recreated.");
      value = value[0];
    }
    if (!value || typeof value !== "object") {
      gap(ref, "mesh has no material record; a default MeshStandardMaterial is used.");
      return {
        kind: "standard",
        color: null,
        opacity: null,
        transparent: false,
        metalness: null,
        roughness: null,
        side: null,
        map: null,
      };
    }
    const material = value as Record<string, unknown>;
    const type = typeof material.type === "string" ? material.type : "";
    const kind = type.includes("MeshBasicMaterial")
      ? ("basic" as const)
      : type.includes("MeshStandardMaterial")
        ? ("standard" as const)
        : null;
    if (!kind) {
      gap(ref, `material type ${JSON.stringify(type || "unknown")} is not recreated; a MeshStandardMaterial is used instead.`);
    }
    const color = boundedString(material.color, 7);
    let map: string | null = null;
    const rawMap = material.map as { url?: unknown; assetId?: unknown } | null | undefined;
    if (rawMap && typeof rawMap === "object") {
      const assetId = typeof rawMap.assetId === "string" ? rawMap.assetId : null;
      map = texturePath(assetId);
      if (!map) {
        gap(
          ref,
          assetId
            ? `texture map (${assetId}) is not bound to a local image file; the material keeps its flat colour.`
            : "texture map has no inventory assetId; the material keeps its flat colour.",
        );
      }
    }
    return {
      kind: kind ?? "standard",
      color: color && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : null,
      opacity: finiteNumber(material.opacity),
      transparent: material.transparent === true,
      metalness: kind === "standard" ? finiteNumber(material.metalness) : null,
      roughness: kind === "standard" ? finiteNumber(material.roughness) : null,
      side: finiteNumber(material.side),
      map,
    };
  };

  const meshes: CapturedMesh[] = [];
  for (const row of nodes) {
    if (!row || typeof row !== "object") continue;
    const node = row as Record<string, unknown>;
    if (node.type !== "mesh") continue;
    const name =
      boundedString(node.name, SCENE_STUB_LIMITS.maxAdapterNameChars) ?? `mesh-${meshes.length + 1}`;
    const geometry = node.geometry as Record<string, unknown> | null | undefined;
    if (!geometry || typeof geometry !== "object") {
      gap(name, "mesh has no geometry record, so no primitive can be recreated.");
      continue;
    }
    const kind = geometryKind(geometry.type);
    if (!kind) {
      gap(
        name,
        `geometry type ${JSON.stringify(typeof geometry.type === "string" ? geometry.type : "unknown")} is not a supported primitive (box/plane/sphere/cylinder).`,
      );
      continue;
    }
    meshes.push({
      name,
      kind,
      args: geometryArgs(kind, geometry, name, gap),
      position: tuple3(node.position),
      quaternion: tuple4(node.quaternion),
      scale: tuple3(node.scale),
      visible: node.visible !== false,
      material: readMaterial(node.material, name),
    });
  }

  let camera: CapturedScene["camera"] = null;
  const rawCamera = adapter.camera as Record<string, unknown> | null | undefined;
  if (rawCamera && typeof rawCamera === "object") {
    const fov = finiteNumber(rawCamera.fov);
    const near = finiteNumber(rawCamera.near);
    const far = finiteNumber(rawCamera.far);
    const matrix = validCameraMatrix(rawCamera.matrixWorld) ? (rawCamera.matrixWorld as number[]) : null;
    const type = typeof rawCamera.type === "string" ? rawCamera.type : "";
    const projectionValid = fov !== null && fov > 0 && fov < 180;
    const clipValid = near !== null && far !== null && near > 0 && far > near;
    if (type.includes("PerspectiveCamera") && projectionValid && clipValid && matrix) {
      camera = { fov, near: near!, far: far!, matrixWorld: matrix };
    } else {
      gap(
        "three.camera",
        "camera matrix/projection is invalid (needs 16 finite affine elements with non-zero scale, 0<fov<180 and 0<near<far); the authored camera is kept.",
      );
    }
  }

  // Controls are never wired for a captured camera: OrbitControls works from
  // position/quaternion, so enabling it would let decompose/recompose (or its
  // own update) move the captured pose. The exact matrix wins.
  const rawControls = adapter.controls as Record<string, unknown> | null | undefined;
  if (rawControls && typeof rawControls === "object") {
    // Reserved outside the capped mesh diagnostics: this reason must survive
    // even when 40 unsupported meshes already filled the gap list.
    gaps.push({
      evidenceRef: "three.controls",
      reason: "controls not recreated because exact captured camera matrix is preserved.",
    });
  }

  const lights = Array.isArray(adapter.lights) ? adapter.lights.length : 0;
  // No supported mesh: keep the pre-adapter placeholder scene, but keep the
  // gaps so unsupported geometry is reported rather than silently dropped.
  if (meshes.length === 0) return { meshes, camera: null, lights, gaps };
  return { meshes, camera, lights, gaps };
}


/** Escapes page-derived text for HTML text/attribute contexts. */
function html(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON inside a generated module: "<" cannot start a tag or terminate markup. */
const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

// node:path.basename only knows the host separator, so a pack captured on
// Windows and built on POSIX (or the reverse) would keep a whole path in the
// frame reference. Split on both separators instead.
function frameBasename(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const trimmed = value.replace(/[\\/]+$/, "");
  const leaf = trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
  const name = leaf.replace(/[^\w.-]+/g, "-");
  return name && name !== "." && name !== ".." ? name : null;
}

interface FrameRef {
  index: number;
  scrollRatio: number | null;
  canvas: string;
  viewport: string | null;
}

function frameRefs(evidence: SceneEvidence): FrameRef[] {
  const frames = Array.isArray(evidence.checkpoints) ? evidence.checkpoints : [];
  return frames.map((frame, i) => ({
    index: Number.isInteger(frame?.index) ? frame.index : i,
    scrollRatio:
      typeof frame?.requestedScrollRatio === "number" && Number.isFinite(frame.requestedScrollRatio)
        ? frame.requestedScrollRatio
        : null,
    canvas: frameBasename(frame?.files?.canvas) ?? "",
    viewport: frameBasename(frame?.files?.viewport),
  }));
}

function buildMainJs(
  bindings: Binding[],
  placeholder: boolean,
  captured: CapturedScene | null,
): string {
  const models = bindings
    .filter(isModel)
    .map((binding) => ({ path: `/${binding.to.replace(/^public\//, "")}`, resourceId: binding.resourceId }));
  const textures = bindings
    .filter(isTexture)
    .map((binding) => ({ path: `/${binding.to.replace(/^public\//, "")}`, resourceId: binding.resourceId }));
  // Captured meshes replace the placeholder plane; a bound model still loads
  // alongside them, so its success handler must not unhide a missing plane.
  const showPlaceholder = captured === null || captured.meshes.length === 0;

  const lines: string[] = captured
    ? [
        "// Generated by awwwards-mcp build_scene_stub from a scene evidence pack.",
        "// Experimental three adapter: only objects reachable from window.scene, window.camera,",
        "// window.renderer and window.app/experience/viewer/world were read. The heap was not",
        "// crawled and node transforms are parent-relative, so recreated meshes sit at the root.",
        'import * as THREE from "three";',
      ]
    : [
        "// Generated by awwwards-mcp build_scene_stub from a passive scene evidence pack.",
        "// Offline scaffold, not a recovery: no scene graph, camera, controls, shader",
        "// source or geometry was read. Values marked \"authored\" are guesses; edit them.",
        'import * as THREE from "three";',
      ];
  if (models.length > 0) {
    lines.push('import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";');
  }

  const cameraMatrix = captured?.camera ? scriptJson(captured.camera.matrixWorld) : "";
  const cameraLines = captured?.camera
    ? [
        "// Camera: captured matrix kept exactly; no decomposition, so shear survives.",
        `const camera = new THREE.PerspectiveCamera(${captured.camera.fov}, window.innerWidth / window.innerHeight, ${captured.camera.near}, ${captured.camera.far});`,
        `camera.matrix.fromArray(${cameraMatrix});`,
        `camera.matrixWorld.fromArray(${cameraMatrix});`,
        "camera.matrixWorldInverse.copy(camera.matrixWorld).invert();",
        "camera.matrixAutoUpdate = false;",
        "camera.matrixWorldAutoUpdate = false;",
        "camera.updateProjectionMatrix();",
      ]
    : [
        "// Camera: scene evidence stores no camera state, so this is authored.",
        "const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);",
        "camera.position.set(0, 0, 5); // authored default",
        "camera.lookAt(0, 0, 0);",
      ];

  lines.push(
    "",
    "// Bound local copies. The tool referenced these paths; it did not read or copy them.",
    `const MODELS = ${scriptJson(models)};`,
    `const TEXTURES = ${scriptJson(textures)};`,
    "",
    'const canvas = document.getElementById("scene-canvas");',
    'const status = document.getElementById("scene-status");',
    "",
    "const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });",
    "renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));",
    "renderer.setSize(window.innerWidth, window.innerHeight, false);",
    "",
    "const scene = new THREE.Scene();",
    "scene.background = new THREE.Color(0x0b0d12); // authored default",
    "",
    ...cameraLines,
    "",
    captured
      ? "// Lighting: authored defaults; captured light values are recorded but not applied."
      : "// Lighting: authored defaults; the capture recorded rendered pixels only.",
    "scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 2.2));",
    "const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);",
    "keyLight.position.set(3, 5, 4);",
    "scene.add(keyLight);",
    "",
    ...(showPlaceholder
      ? [
          placeholder
            ? "// No model is bound: this plane is a labelled placeholder, not captured geometry."
            : "// Shown until a bound model loads; no geometry was recovered from the page.",
          "const placeholder = new THREE.Mesh(",
          "  new THREE.PlaneGeometry(3.2, 3.2),",
          "  new THREE.MeshStandardMaterial({ color: 0x2a3340, roughness: 0.75, metalness: 0.05 }),",
          ");",
          'placeholder.name = "awwwards-placeholder";',
          "scene.add(placeholder);",
          "",
        ]
      : []),
    "const textures = [];",
    "let disposed = false;",
    "",
    "function setStatus(message) {",
    "  if (!status) return;",
    "  status.textContent = message;",
    "  status.hidden = !message;",
    "}",
    "",
    "function fail(label, error) {",
    "  const detail = error && error.message ? error.message : String(error);",
    '  setStatus(label + " failed to load: " + detail + ". Check that the file exists under public/assets.");',
    '  console.error("scene stub asset failed:", label, error);',
    "}",
    "",
    "function render() {",
    "  if (!disposed) renderer.render(scene, camera);",
    "}",
    "",
    "function resize() {",
    "  const width = window.innerWidth;",
    "  const height = window.innerHeight;",
    "  camera.aspect = width / height;",
    "  camera.updateProjectionMatrix();",
    "  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));",
    "  renderer.setSize(width, height, false);",
    "  render();",
    "}",
    'window.addEventListener("resize", resize);',
    "",
    "// Image bindings: the first one becomes scene.background (authored default).",
    "const textureLoader = new THREE.TextureLoader();",
    "TEXTURES.forEach(function (binding, index) {",
    "  textureLoader.load(",
    "    binding.path,",
    "    function (texture) {",
    "      texture.colorSpace = THREE.SRGBColorSpace;",
    "      textures.push(texture);",
    "      if (index === 0) scene.background = texture;",
    "      render();",
    "    },",
    "    undefined,",
    "    function (error) {",
    "      fail(binding.path, error);",
    "    },",
    "  );",
    "});",
  );

  if (captured && captured.meshes.length > 0) {
    lines.push(
      "",
      "// Captured meshes: primitive geometry only, recreated flat at the scene root.",
      `const CAPTURED = ${scriptJson(captured.meshes)};`,
      "function capturedGeometry(spec) {",
      '  if (spec.kind === "box") return new THREE.BoxGeometry(spec.args[0], spec.args[1], spec.args[2]);',
      '  if (spec.kind === "plane") return new THREE.PlaneGeometry(spec.args[0], spec.args[1]);',
      '  if (spec.kind === "sphere") return new THREE.SphereGeometry(spec.args[0], 32, 16);',
      '  if (spec.kind === "cylinder") return new THREE.CylinderGeometry(spec.args[0], spec.args[1], spec.args[2], 24);',
      "  return null;",
      "}",
      "function capturedMaterial(spec) {",
      "  const options = {};",
      '  if (typeof spec.color === "string") options.color = new THREE.Color(spec.color);',
      '  if (typeof spec.opacity === "number") options.opacity = spec.opacity;',
      "  if (spec.transparent === true) options.transparent = true;",
      '  if (typeof spec.side === "number") options.side = spec.side;',
      '  if (spec.kind === "standard") {',
      '    if (typeof spec.metalness === "number") options.metalness = spec.metalness;',
      '    if (typeof spec.roughness === "number") options.roughness = spec.roughness;',
      "    return new THREE.MeshStandardMaterial(options);",
      "  }",
      "  return new THREE.MeshBasicMaterial(options);",
      "}",
      "CAPTURED.forEach(function (spec) {",
      "  const geometry = capturedGeometry(spec);",
      "  if (!geometry) return;",
      "  const material = capturedMaterial(spec.material);",
      "  const mesh = new THREE.Mesh(geometry, material);",
      "  mesh.name = spec.name;",
      "  if (spec.position) mesh.position.fromArray(spec.position);",
      "  if (spec.quaternion) mesh.quaternion.fromArray(spec.quaternion);",
      "  if (spec.scale) mesh.scale.fromArray(spec.scale);",
      "  mesh.visible = spec.visible !== false;",
      "  scene.add(mesh);",
      "  if (spec.material.map) {",
      "    textureLoader.load(",
      "      spec.material.map,",
      "      function (texture) {",
      "        texture.colorSpace = THREE.SRGBColorSpace;",
      "        textures.push(texture);",
      "        material.map = texture;",
      "        material.needsUpdate = true;",
      "        render();",
      "      },",
      "      undefined,",
      "      function (error) {",
      "        fail(spec.material.map, error);",
      "      },",
      "    );",
      "  }",
      "});",
    );
  }

  if (models.length > 0) {
    lines.push(
      "",
      "const gltfLoader = new GLTFLoader();",
      "MODELS.forEach(function (binding) {",
      "  gltfLoader.load(",
      "    binding.path,",
      "    function (gltf) {",
      ...(showPlaceholder ? ["      placeholder.visible = false;"] : []),
      "      scene.add(gltf.scene);",
      "      render();",
      "    },",
      "    undefined,",
      "    function (error) {",
      ...(showPlaceholder ? ["      placeholder.visible = true;"] : []),
      "      fail(binding.path, error);",
      "    },",
      "  );",
      "});",
    );
  } else if (captured && captured.meshes.length > 0) {
    lines.push(
      "",
      "// No model binding: captured meshes above are the scene content.",
    );
  } else {
    lines.push(
      "",
      "// Placeholder mode: no model binding was supplied; index.html labels the plane.",
    );
  }


  lines.push(
    "",
    "function dispose() {",
    "  disposed = true;",
    "  scene.traverse(function (object) {",
    "    if (!object.isMesh) return;",
    "    if (object.geometry) object.geometry.dispose();",
    "    const materials = Array.isArray(object.material) ? object.material : [object.material];",
    "    materials.forEach(function (material) {",
    "      if (!material) return;",
    "      Object.keys(material).forEach(function (key) {",
    "        const value = material[key];",
    "        if (value && value.isTexture) value.dispose();",
    "      });",
    "      material.dispose();",
    "    });",
    "  });",
    "  textures.forEach(function (texture) {",
    "    texture.dispose();",
    "  });",
    "  renderer.dispose();",
    "}",
    "",
    'window.addEventListener("pagehide", function (event) {',
    "  if (event.persisted) return; // keep the scene for a bfcache restore",
    "  dispose();",
    "});",
    "",
    "render();",
    ...(captured
      ? ["// Captured camera: static render, no authored orbit, lookAt or controls update."]
      : [
          'if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {',
          "  // Reduced motion: one static render, no idle orbit.",
          "  render();",
          "} else {",
          "  const clock = new THREE.Clock();",
          "  const animate = function () {",
          "    if (disposed) return;",
          "    const elapsed = clock.getElapsedTime();",
          "    camera.position.x = Math.sin(elapsed * 0.15) * 0.6; // authored default",
          "    camera.lookAt(0, 0, 0);",
          "    render();",
          "    window.requestAnimationFrame(animate);",
          "  };",
          "  window.requestAnimationFrame(animate);",
          "}",
        ]),
    "",
  );
  return lines.join("\n");
}

function buildIndexHtml(title: string, placeholder: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(title)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0d12; color: #dbe4f0; }
  body { font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  #scene-canvas { display: block; width: 100%; height: 100%; }
  #scene-status { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); max-width: min(90vw, 720px); margin: 0; padding: 10px 14px; border-radius: 6px; background: #2a1d24; color: #ffd7dc; }
  #scene-status[hidden] { display: none; }
${
  placeholder
    ? `  #scene-placeholder-label { position: fixed; left: 0; right: 0; bottom: 24px; margin: 0; text-align: center; text-transform: uppercase; letter-spacing: 0.08em; font-size: 11px; color: #8fa3bd; }\n`
    : ""
}\
</style>
</head>
<body>
<canvas id="scene-canvas"></canvas>
${
  placeholder
    ? `<p id="scene-placeholder-label">Placeholder scene — no model binding in this evidence pack</p>\n`
    : ""
}\
<p id="scene-status" role="status" hidden></p>
<script type="module" src="/src/main.js"></script>
</body>
</html>
`;
}

function buildSceneJson(
  evidence: SceneEvidence,
  mode: SceneStubMode,
  bindings: Binding[],
  frames: FrameRef[],
): string {
  const scene = {
    id: "scene-stub-scene-v1",
    mode,
    evidence: {
      id: evidence.id,
      captureId: evidence.captureId,
      url: typeof evidence.url === "string" ? evidence.url : "",
      capturedAt: Number.isFinite(evidence.capturedAt) ? evidence.capturedAt : null,
      viewport: evidence.viewport
        ? {
            name: String(evidence.viewport.name ?? ""),
            width: Number(evidence.viewport.width) || 0,
            height: Number(evidence.viewport.height) || 0,
          }
        : null,
      canvas: evidence.canvas
        ? {
            usedSelector: String(evidence.canvas.usedSelector ?? ""),
            canvases: Number(evidence.canvas.canvases) || 0,
          }
        : null,
    },
    // Frames stay in the pack: these are basename references, never copies.
    frames,
    bindings: bindings.map((binding) => ({
      resourceId: binding.resourceId,
      path: `/${binding.to.replace(/^public\//, "")}`,
      to: binding.to,
      mime: binding.resource.mime ?? "",
      classification: binding.resource.classification ?? "other",
      downloadStatus:
        binding.resource.download && typeof binding.resource.download.status === "string"
          ? binding.resource.download.status
          : "unknown",
      bytes: binding.resource.bytes ?? null,
    })),
    assets: {
      publicDir: "public/assets",
      note: "Copy assetCopies[].from to assetCopies[].to before running the project.",
    },
  };
  return `${JSON.stringify(scene, null, 2)}\n`;
}

function buildReadme(
  provenance: SceneStubProvenance,
  title: string,
  copies: Array<{ resourceId: string; to: string }>,
  adapter: boolean,
): string {
  const lines: string[] = [
    `# ${md(title)}`,
    "",
    adapter
      ? "Offline scaffold from a `scene-evidence-v1` pack. An experimental, opt-in three adapter"
      : "Offline scaffold from a passive `scene-evidence-v1` pack. It is a starting point, not a",
    adapter
      ? "read objects reachable from a few `window` properties, so a bounded subset of meshes and"
      : "recovery: the capture read rendered frames and observed responses only, so no scene graph,",
    adapter
      ? "camera is recreated; controls and everything else are authored defaults or unresolved."
      : "camera, controls, shader source or geometry is present here.",
    "",
    "## Evidence",
    "",
    `- captureId: \`${md(provenance.evidence.captureId)}\``,
    `- id: \`${provenance.evidence.id}\``,
    `- source: ${md(provenance.evidence.url) || "(not recorded)"}`,
    `- capturedAt (epoch ms): ${provenance.evidence.capturedAt ?? "unknown"}`,
    provenance.evidence.viewport
      ? `- viewport: ${provenance.evidence.viewport.width}x${provenance.evidence.viewport.height} (${md(provenance.evidence.viewport.name) || "unknown"})`
      : "- viewport: unknown",
    `- mode: \`${provenance.mode}\``,
    `- resources: ${provenance.evidence.resourcesCollected} collected of ${provenance.evidence.resourceTotal} observed (truncated: ${provenance.evidence.resourcesTruncated ? "yes" : "no"})`,
    "",
    "## Rights",
    "",
    "The scene pack does not record a licence, so no rights claim is made here. Asset use is",
    "your responsibility: confirm ownership, licence or permission before shipping these files.",
    "This tool references local paths and never downloads or copies an asset body.",
    "",
    "## Asset copies",
    "",
  ];
  if (copies.length === 0) {
    lines.push(
      provenance.mode === "placeholder"
        ? "None: placeholder mode, no local asset was bound."
        : "None: no local asset was bound; captured meshes use flat colours.",
      "",
    );
  } else {
    lines.push(
      "| resourceId | to |",
      "|---|---|",
      ...copies.map((copy) => `| ${md(copy.resourceId)} | ${md(copy.to)} |`),
      "",
      "Source paths are machine-local, so they stay in the tool result (`assetCopies[].from`), not here.",
      "",
    );
  }
  lines.push("## Authored defaults", "");
  for (const item of provenance.authoredDefaults) {
    lines.push(`- \`${md(item.path)}\` — ${md(item.value)}: ${md(item.reason)}`);
  }
  lines.push("", "## Unresolved", "");
  if (provenance.unresolved.length === 0) {
    lines.push("None recorded.");
  } else {
    for (const item of provenance.unresolved) {
      lines.push(`- \`${md(item.evidenceRef)}\`: ${md(item.reason)}`);
    }
  }
  lines.push("", "## Limitations", "");
  for (const limitation of provenance.limitations) {
    lines.push(`- ${md(limitation)}`);
  }
  lines.push(
    "",
    "## Run",
    "",
    "This is source, not a servable site. Install (needs network for the pinned three and vite",
    "versions), then build:",
    "",
    "```sh",
    "npm install",
    "npm run dev",
    "npm run build",
    "npm run preview",
    "```",
    "",
  );
  return lines.join("\n");
}

const LIMITATION = [
  "Offline scaffold only: no scene graph, camera, controls, shader source or geometry is recovered, and captured application code, shader source, userData and callbacks are never executed.",
  "Frames stay in the evidence pack; scene.json references them by basename.",
  "Asset bodies are neither read nor copied: assetCopies tells the caller which local file belongs at which public path.",
  "Camera, lights, background, orbit and the placeholder plane are authored defaults, not measurements.",
];

const ADAPTER_LIMITATION = [
  "Experimental three adapter: only objects reachable from window.THREE, window.scene/camera/renderer and window.app/experience/viewer/world were read; the heap was not crawled, so missing nodes are not evidence of absence.",
  "Captured node transforms are parent-relative and the bounded record carries no hierarchy: meshes are recreated flat at the scene root, with primitive geometry only.",
  "Non-primitive geometry, unbound texture maps, non-standard materials, non-perspective cameras and controls are listed as unresolved instead of being guessed.",
  "A captured camera matrix is emitted exactly; OrbitControls are never wired for a captured camera because their TRS update can move a sheared or non-orthogonal pose.",
  "Frames stay in the evidence pack; scene.json references them by basename.",
  "Asset bodies are neither read nor copied: assetCopies tells the caller which local file belongs at which public path.",
  "Lighting and background remain authored defaults; captured light values are recorded but not applied, and no idle orbit is added to a captured camera.",
];

/**
 * Builds a minimal Vite + Three.js project from one scene evidence pack.
 * Pure with respect to the filesystem: reads the pack, lstat()s bound paths,
 * returns files the caller writes. Never fetches, installs or writes.
 */
export async function buildSceneStub(
  opts: SceneStubOptions,
): Promise<SceneStubResult | { error: string }> {
  try {
    const loaded = await loadEvidence(
      opts.evidencePath,
      opts.sceneDir ?? join(process.cwd(), "scene-captures"),
    );
    if ("error" in loaded) return loaded;
    const { evidence, resources } = loaded;

    const normalized = await normalizeBindings(opts.assetBindings, resources);
    if ("error" in normalized) return normalized;
    const bindings = normalized.bindings;
    // Experimental adapter data from an exported or edited pack is re-validated;
    // unusable data returns null, which leaves the placeholder path unchanged.
    const captured = capturedScene(evidence, bindings);

    const rawTitle = typeof opts.title === "string" ? opts.title : "";
    if (rawTitle.length > SCENE_STUB_LIMITS.maxTitleChars) {
      return { error: `title must be at most ${SCENE_STUB_LIMITS.maxTitleChars} characters.` };
    }
    const title = rawTitle.trim() || `Scene stub — ${evidence.captureId}`;

    const modelBindings = bindings.filter(isModel);
    const mode: SceneStubMode =
      modelBindings.length > 0 || (captured?.meshes.length ?? 0) > 0
        ? "reconstructed-subset"
        : "placeholder";
    const frames = frameRefs(evidence);

    const assetCopies: SceneAssetCopy[] = bindings.map((binding) => ({
      from: binding.localPath,
      to: binding.to,
    }));

    const unresolved: SceneStubUnresolved[] = [];
    for (const binding of bindings) {
      const ext = extOf(binding);
      if (["ktx2", "hdr", "exr"].includes(ext)) {
        unresolved.push({
          evidenceRef: binding.resourceId,
          reason: `copied as .${ext} but not loaded: three needs a dedicated KTX2/HDR/EXR loader.`,
        });
      }
      if (ext === "gltf") {
        unresolved.push({
          evidenceRef: binding.resourceId,
          reason:
            "a .gltf can reference sibling .bin/textures by relative path; copies are renamed to public/assets/<assetId>.<ext>, so rebase those URIs.",
        });
      }
      if (ext === "bin") {
        unresolved.push({
          evidenceRef: binding.resourceId,
          reason: "buffer copied only; glTF buffer URIs are not rewritten by this scaffold.",
        });
      }
    }
    if (mode === "placeholder") {
      unresolved.push({
        evidenceRef: "model",
        reason: "no model binding was supplied: the project renders a labelled placeholder plane.",
      });
    }
    if (captured) {
      unresolved.push(...captured.gaps);
      if (captured.lights > 0) {
        unresolved.push({
          evidenceRef: "three.lights",
          reason: `${captured.lights} captured light${captured.lights === 1 ? "" : "s"} recorded but not recreated; lighting stays authored.`,
        });
      }
    }
    const bound = new Set(bindings.map((binding) => binding.resourceId));
    let unbound = 0;
    for (const resource of resources.values()) {
      if (unbound >= SCENE_STUB_LIMITS.maxUnboundRows) break;
      if (bound.has(resource.assetId)) continue;
      if (!["model", "texture", "hdr", "image"].includes(resource.classification)) continue;
      unbound += 1;
      unresolved.push({
        evidenceRef: resource.assetId,
        reason: `${resource.classification} observed in the pack but not bound to a local file.`,
      });
    }

    const authoredDefaults: SceneStubAuthoredDefault[] = [];
    if (!captured?.camera) {
      authoredDefaults.push({
        path: "src/main.js",
        value: "PerspectiveCamera(50), position (0, 0, 5), lookAt (0, 0, 0)",
        reason: "scene evidence stores no camera state; frames show its effect only.",
      });
    }
    authoredDefaults.push({
      path: "src/main.js",
      value: "HemisphereLight(0xffffff, 0x223344, 2.2) + DirectionalLight 1.6 at (3, 5, 4)",
      reason: captured
        ? "captured light values are not applied; these are plausible defaults."
        : "lighting is not recorded by the capture; these are plausible defaults.",
    });
    authoredDefaults.push({
      path: "src/main.js",
      value: "background #0b0d12" + (bindings.some(isTexture) ? "; first image binding overrides it" : ""),
      reason: "the captured backdrop colour was not sampled, and only the first texture is wired.",
    });
    authoredDefaults.push(
      captured
        ? {
            path: "src/main.js",
            value: "static captured camera, no idle motion or controls",
            reason: "the exact captured camera matrix is kept; OrbitControls would decompose it and can move the pose.",
          }
        : {
            path: "src/main.js",
            value: "idle orbit amplitude 0.6 at 0.15 rad/s when motion is allowed",
            reason: "motion was not measured; reduced-motion users get one static render instead.",
          },
    );
    authoredDefaults.push({
      path: "package.json",
      value: "three 0.160.0 + vite 8.3.5, scripts dev/build/preview",
      reason: "pinned so two builds of the same evidence produce the same dependency tree.",
    });
    if (mode === "placeholder") {
      authoredDefaults.push({
        path: "src/main.js",
        value: "3.2x3.2 placeholder plane, labelled in index.html",
        reason: "no model binding exists, and no geometry was recovered from the page.",
      });
    }

    const limitations = [
      ...(captured ? ADAPTER_LIMITATION : LIMITATION),
      ...(Array.isArray(evidence.limitations) ? evidence.limitations.slice(0, 4).map((value) => String(value)) : []),
    ];

    const provenance: SceneStubProvenance = {
      id: "scene-stub-provenance-v1",
      evidence: {
        id: evidence.id,
        captureId: evidence.captureId,
        url: typeof evidence.url === "string" ? evidence.url : "",
        capturedAt: Number.isFinite(evidence.capturedAt) ? evidence.capturedAt : null,
        viewport: evidence.viewport
          ? {
              name: String(evidence.viewport.name ?? ""),
              width: Number(evidence.viewport.width) || 0,
              height: Number(evidence.viewport.height) || 0,
            }
          : null,
        resourceTotal: Number(evidence.resourceTotal) || evidence.resources.length,
        resourcesCollected: evidence.resources.length,
        resourcesTruncated: evidence.resourcesTruncated === true,
      },
      mode,
      rights: {
        status: "not-recorded",
        note: "The scene pack records no licence; asset use is the caller's responsibility.",
      },
      authoredDefaults,
      unresolved,
      limitations,
    };

    const packageJson = `${JSON.stringify(
      {
        name: "scene-stub",
        private: true,
        version: "0.0.0",
        type: "module",
        scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
        dependencies: { three: "0.160.0" },
        devDependencies: { vite: "8.3.5" },
      },
      null,
      2,
    )}\n`;

    const files: SceneStubFile[] = [
      { path: "package.json", content: packageJson },
      { path: "index.html", content: buildIndexHtml(title, mode === "placeholder") },
      { path: "src/main.js", content: buildMainJs(bindings, mode === "placeholder", captured) },
      { path: "scene.json", content: buildSceneJson(evidence, mode, bindings, frames) },
      { path: "README.md", content: buildReadme(provenance, title, bindings, captured !== null) },
    ];

    return {
      id: "scene-stub-v1",
      mode,
      files,
      assetCopies,
      unresolved,
      authoredDefaults,
      provenance,
    };
  } catch (err) {
    return { error: `build_scene_stub failed: ${messageOf(err)}` };
  }
}
