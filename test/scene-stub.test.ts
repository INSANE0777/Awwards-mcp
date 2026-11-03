import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AwwwardsClient } from "../src/awwwards.js";
import { Cache } from "../src/cache.js";
import type { SceneEvidence, SceneThreeNode } from "../src/scene-capture.js";
import { buildSceneStub } from "../src/scene-stub.js";
import { createHandlers } from "../src/server.js";
import { CORE_TOOL_NAMES } from "../src/tool-profile.js";
import { registerAllTools } from "../src/tools/index.js";
import { registerBuildSceneStub } from "../src/tools/build.js";
import { registerBuildMotion } from "../src/v2/build-motion.js";
import { V2_TOOL_NAMES } from "../src/v2/register.js";

// The tool must never write, install or fetch. Builtin fs/promises is wrapped
// so any write-side call is recorded; fixtures use the sync API instead.
const fsCalls = vi.hoisted(() => ({
  writeFile: vi.fn(),
  appendFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  rename: vi.fn(),
  copyFile: vi.fn(),
  cp: vi.fn(),
  open: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const wrap = (name: keyof typeof fsCalls, value: unknown) =>
    typeof value === "function"
      ? (...args: unknown[]) => {
          fsCalls[name](...args);
          return (value as (...a: unknown[]) => unknown)(...args);
        }
      : value;
  return {
    ...actual,
    writeFile: wrap("writeFile", actual.writeFile),
    appendFile: wrap("appendFile", actual.appendFile),
    mkdir: wrap("mkdir", actual.mkdir),
    rm: wrap("rm", actual.rm),
    rename: wrap("rename", actual.rename),
    copyFile: wrap("copyFile", actual.copyFile),
    cp: wrap("cp", actual.cp),
  };
});

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

const dirs: string[] = [];
const tmpDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-scene-stub-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const captureId = "scene-mg2k3j4p-0123abcd";

function evidence(overrides: Partial<SceneEvidence> = {}): SceneEvidence {
  return {
    id: "scene-evidence-v1",
    url: "https://example.com/scene",
    captureId,
    capturedAt: 1_700_000_000_000,
    viewport: { name: "desktop", width: 1440, height: 900 },
    canvas: { requestedSelector: null, usedSelector: "canvas", canvases: 1 },
    frameworkHints: {
      three: { detected: true, version: "160", scripts: [] },
      babylon: { detected: false, version: null, scripts: [] },
      playcanvas: { detected: false, version: null, scripts: [] },
      canvasCount: 1,
    },
    checkpoints: [
      {
        index: 0,
        requestedScrollRatio: 0,
        requestedScrollTop: 0,
        actualScrollTop: 0,
        scrollRange: 0,
        scrollRoot: "window",
        scrollRootFound: true,
        pointer: null,
        pointerPx: null,
        waitMs: 0,
        elapsedMs: 5,
        canvas: { rect: { x: 0, y: 0, width: 1440, height: 900 }, backing: { width: 1440, height: 900 }, dpr: 1 },
        stable: true,
        files: { canvas: "/tmp/pack/frame-01-canvas.png", viewport: "/tmp/pack/frame-01-viewport.png" },
      },
    ],
    resources: [
      {
        assetId: "asset-1",
        url: "https://example.com/models/scene.glb",
        origin: "https://example.com",
        mime: "model/gltf-binary",
        bytes: 1024,
        resourceType: "fetch",
        classification: "model",
        discovery: "response",
        assetOrigin: true,
        download: { status: "available", url: "https://example.com/models/scene.glb" },
      },
      {
        assetId: "asset-2",
        url: "https://example.com/textures/photo.png",
        origin: "https://example.com",
        mime: "image/png",
        bytes: 256,
        resourceType: "image",
        classification: "image",
        discovery: "response",
        assetOrigin: true,
        download: { status: "available", url: "https://example.com/textures/photo.png" },
      },
      {
        assetId: "asset-3",
        url: "https://example.com/app.js",
        origin: "https://example.com",
        mime: "text/javascript",
        bytes: 99,
        resourceType: "script",
        classification: "script",
        discovery: "response",
        assetOrigin: true,
        download: { status: "available", url: "https://example.com/app.js" },
      },
    ],
    resourceTotal: 3,
    resourcesTruncated: false,
    blockedRequests: { count: 0, samples: [] },
    assetOrigins: ["https://example.com"],
    paths: { dir: "/tmp/pack", evidence: "/tmp/pack/evidence.json", framesDir: "/tmp/pack" },
    coverage: {
      status: "partial",
      collected: 1,
      excluded: 0,
      limitations: ["passive"],
      capabilities: {
        scene: { status: "unavailable", reason: "not read" },
        camera: { status: "unavailable", reason: "not read" },
        controls: { status: "unavailable", reason: "not read" },
        shaders: { status: "unavailable", reason: "not read" },
        geometry: { status: "unavailable", reason: "not read" },
      },
    },
    limitations: ["Passive evidence only."],
    ...overrides,
  };
}

/** Writes a pack under <root>/scene-captures/<captureId>/evidence.json. */
function writePack(root: string, pack: SceneEvidence = evidence()): { sceneDir: string; evidencePath: string } {
  const sceneDir = join(root, "scene-captures");
  const dir = join(sceneDir, pack.captureId);
  mkdirSync(dir, { recursive: true });
  const evidencePath = join(dir, "evidence.json");
  writeFileSync(evidencePath, JSON.stringify(pack, null, 1));
  return { sceneDir, evidencePath };
}

function localFile(root: string, name: string, bytes = "fixture"): string {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

function fileOf(result: { files: Array<{ path: string; content: string }> }, path: string): string {
  const found = result.files.find((file) => file.path === path);
  expect(found, path).toBeDefined();
  return found!.content;
}

describe("build_scene_stub core", () => {
  it("is byte-identical across two calls and stays placeholder with a texture binding", async () => {
    const root = tmpDir();
    const { sceneDir, evidencePath } = writePack(root);
    const texture = localFile(root, "photo.png", "not-a-real-png");
    const opts = {
      evidencePath,
      sceneDir,
      assetBindings: [{ resourceId: "asset-2", localPath: texture }],
    };

    const first = await buildSceneStub(opts);
    const second = await buildSceneStub(opts);
    if ("error" in first || "error" in second) throw new Error("expected a build");
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    expect(first.id).toBe("scene-stub-v1");
    expect(first.mode).toBe("placeholder");
    expect(first.files.map((file) => file.path)).toEqual([
      "package.json",
      "index.html",
      "src/main.js",
      "scene.json",
      "README.md",
    ]);
    expect(first.assetCopies).toEqual([{ from: texture, to: "public/assets/asset-2.png" }]);

    const pkg = JSON.parse(fileOf(first, "package.json"));
    expect(pkg.dependencies.three).toBe("0.160.0");
    expect(pkg.devDependencies.vite).toBe("8.3.5");
    expect(pkg.scripts).toMatchObject({ dev: "vite", build: "vite build", preview: "vite preview" });

    const main = fileOf(first, "src/main.js");
    expect(main).toContain("TextureLoader");
    expect(main).toContain("/assets/asset-2.png");
    expect(main).not.toContain("GLTFLoader");
    expect(main).toContain("prefers-reduced-motion");
    expect(main).toContain("pagehide");
    expect(main).toContain("failed to load");
    expect(fileOf(first, "index.html")).toContain("Placeholder scene — no model binding");

    const scene = JSON.parse(fileOf(first, "scene.json"));
    expect(scene.frames).toEqual([
      { index: 0, scrollRatio: 0, canvas: "frame-01-canvas.png", viewport: "frame-01-viewport.png" },
    ]);
    expect(scene.bindings[0]).toMatchObject({ resourceId: "asset-2", path: "/assets/asset-2.png" });

    const readme = fileOf(first, "README.md");
    expect(readme).toContain(captureId);
    expect(readme).toContain("not recorded");
    expect(readme).toContain("Authored defaults");
    expect(readme).toContain("npm install");
    // No machine-local evidence path leaks into generated files.
    const escaped = JSON.stringify(root).slice(1, -1);
    for (const file of first.files) {
      expect(file.content).not.toContain(root);
      expect(file.content).not.toContain(escaped);
    }
    expect(first.provenance.evidence.captureId).toBe(captureId);
    expect(first.provenance.rights.status).toBe("not-recorded");
    expect(first.authoredDefaults.length).toBeGreaterThan(0);
    expect(first.unresolved.some((row) => row.evidenceRef === "asset-1")).toBe(true);
  });

  it("switches to reconstructed-subset with GLTFLoader when a glb model is bound", async () => {
    const root = tmpDir();
    const { sceneDir, evidencePath } = writePack(root);
    const model = localFile(root, "scene.glb", "glTFfixture");

    const result = await buildSceneStub({
      evidencePath,
      sceneDir,
      assetBindings: [{ resourceId: "asset-1", localPath: model }],
      title: "Fixture scene",
    });
    if ("error" in result) throw new Error(result.error);

    expect(result.mode).toBe("reconstructed-subset");
    expect(result.assetCopies).toEqual([{ from: model, to: "public/assets/asset-1.glb" }]);
    const main = fileOf(result, "src/main.js");
    expect(main).toContain('from "three/addons/loaders/GLTFLoader.js"');
    expect(main).toContain("/assets/asset-1.glb");
    expect(main).toContain("placeholder.visible = false");
    expect(fileOf(result, "index.html")).toContain("<title>Fixture scene</title>");
    expect(fileOf(result, "index.html")).not.toContain("scene-placeholder-label");
  });

  it("refuses duplicates, traversal, missing/symlinked files, scripts and foreign packs", async () => {
    const root = tmpDir();
    const { sceneDir, evidencePath } = writePack(root);
    const model = localFile(root, "scene.glb", "glTFfixture");

    const dup = await buildSceneStub({
      evidencePath,
      sceneDir,
      assetBindings: [
        { resourceId: "asset-1", localPath: model },
        { resourceId: "asset-1", localPath: model },
      ],
    });
    expect(dup).toEqual({ error: expect.stringMatching(/repeats resourceId asset-1/) });

    const traversal = await buildSceneStub({
      evidencePath,
      sceneDir,
      assetBindings: [{ resourceId: "asset-1", localPath: "../escape.glb" }],
    });
    expect(traversal).toEqual({ error: expect.stringMatching(/traversal segment/) });

    const missing = await buildSceneStub({
      evidencePath,
      sceneDir,
      assetBindings: [{ resourceId: "asset-1", localPath: join(root, "nope.glb") }],
    });
    expect(missing).toEqual({ error: expect.stringMatching(/does not exist/) });

    const unknown = await buildSceneStub({
      evidencePath,
      sceneDir,
      assetBindings: [{ resourceId: "asset-9", localPath: model }],
    });
    expect(unknown).toEqual({ error: expect.stringMatching(/not in this evidence inventory/) });

    const script = await buildSceneStub({
      evidencePath,
      sceneDir,
      assetBindings: [{ resourceId: "asset-3", localPath: localFile(root, "app.js", "x") }],
    });
    expect(script).toEqual({ error: expect.stringMatching(/captured script/) });

    const badExt = await buildSceneStub({
      evidencePath,
      sceneDir,
      assetBindings: [{ resourceId: "asset-1", localPath: localFile(root, "scene.obj", "x") }],
    });
    expect(badExt).toEqual({ error: expect.stringMatching(/allowed: glb, gltf, bin/) });

    const foreign = join(root, "exported", "evidence.json");
    mkdirSync(dirname(foreign), { recursive: true });
    writeFileSync(foreign, JSON.stringify(evidence()));
    const outside = await buildSceneStub({ evidencePath: foreign, sceneDir });
    expect(outside).toEqual({ error: expect.stringMatching(/outside the scene-captures directory/) });
    writeFileSync(foreign, JSON.stringify({ ...evidence(), exported: true }));
    const exported = await buildSceneStub({ evidencePath: foreign, sceneDir });
    expect("error" in exported).toBe(false);
  });

  it("refuses a symlinked binding (file symlink, else directory junction)", async (ctx) => {
    const root = tmpDir();
    const { sceneDir, evidencePath } = writePack(root);
    const target = localFile(root, "scene.glb", "glTFfixture");
    const link = join(root, "link.glb");
    try {
      symlinkSync(target, link, "file");
    } catch {
      // Windows without Developer Mode cannot create file symlinks; a directory
      // junction is still a symlink and must be refused the same way.
      try {
        symlinkSync(root, link, "junction");
      } catch {
        ctx.skip();
        return;
      }
    }
    const result = await buildSceneStub({
      evidencePath,
      sceneDir,
      assetBindings: [{ resourceId: "asset-1", localPath: link }],
    });
    expect(result).toEqual({ error: expect.stringMatching(/not a regular file \(symlinks are refused\)/) });
  });

  it("rejects evidence above 2 MiB", async () => {
    const root = tmpDir();
    const { sceneDir } = writePack(root);
    const big = join(sceneDir, "big.json");
    writeFileSync(big, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
    const result = await buildSceneStub({ evidencePath: big, sceneDir });
    expect(result).toEqual({ error: expect.stringMatching(/larger than 2 MiB/) });
  });

  it("never calls fetch, install or a write-side fs API", async () => {
    const root = tmpDir();
    const { sceneDir, evidencePath } = writePack(root);
    const model = localFile(root, "scene.glb", "glTFfixture");
    const result = await buildSceneStub({
      evidencePath,
      sceneDir,
      assetBindings: [{ resourceId: "asset-1", localPath: model }],
    });
    expect("error" in result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const [name, spy] of Object.entries(fsCalls)) {
      expect(spy, `${name} must not be called`).not.toHaveBeenCalled();
    }
  });
});

function threeNode(overrides: Partial<SceneThreeNode> = {}): SceneThreeNode {
  return {
    type: "mesh",
    name: "mesh",
    uuid: "uuid-mesh",
    visible: true,
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    childCount: 0,
    geometry: null,
    material: null,
    camera: null,
    light: null,
    ...overrides,
  };
}

function adapterThree(
  overrides: Partial<NonNullable<SceneEvidence["three"]>> = {},
): NonNullable<SceneEvidence["three"]> {
  const camera = {
    type: "PerspectiveCamera",
    fov: 45,
    near: 0.5,
    far: 500,
    // Column-major affine matrix with translation (0, 0, 5) and unit scale.
    matrixWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1],
  };
  return {
    id: "three-adapter-v1",
    available: true,
    reason: "Reachable three objects were read from window.* only; the heap was not crawled.",
    revision: "170",
    scene: {
      nodes: [
        threeNode({ type: "scene", name: "root", uuid: "scene-1", childCount: 7 }),
        threeNode({
          name: "box",
          uuid: "mesh-box",
          position: [1, 2, 3],
          quaternion: [0, 0.7071, 0, 0.7071],
          scale: [2, 2, 2],
          geometry: {
            type: "BoxGeometry",
            attributes: [{ name: "position", count: 24 }],
            indexCount: 36,
            bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
            parameters: { width: 2, height: 2, depth: 2 },
          },
          material: {
            type: "MeshStandardMaterial",
            color: "#ff8800",
            opacity: 0.75,
            transparent: true,
            metalness: 0.2,
            roughness: 0.4,
            side: 0,
            map: { url: "https://cdn.example.com/textures/photo.png", assetId: "asset-2" },
          },
        }),
        threeNode({
          name: "plane",
          uuid: "mesh-plane",
          geometry: {
            type: "PlaneGeometry",
            attributes: [{ name: "position", count: 4 }],
            indexCount: 6,
            bounds: { min: [-2, -1, 0], max: [2, 1, 0] },
            parameters: { width: 4, height: 2 },
          },
          material: {
            type: "MeshBasicMaterial",
            color: "#112233",
            opacity: 1,
            transparent: false,
            metalness: null,
            roughness: null,
            side: 2,
            map: null,
          },
        }),
        threeNode({
          name: "sphere",
          uuid: "mesh-sphere",
          geometry: {
            type: "SphereGeometry",
            attributes: [],
            indexCount: null,
            bounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
            parameters: { radius: 0.5 },
          },
          material: null,
        }),
        threeNode({
          name: "cylinder",
          uuid: "mesh-cylinder",
          geometry: {
            type: "CylinderGeometry",
            attributes: [],
            indexCount: null,
            bounds: { min: [-0.5, -1.5, -0.5], max: [0.5, 1.5, 0.5] },
            parameters: { radiusTop: 0.5, radiusBottom: 0.5, height: 3 },
          },
          material: {
            type: "MeshStandardMaterial",
            color: "#445566",
            opacity: 1,
            transparent: false,
            metalness: 0,
            roughness: 1,
            side: 0,
            map: null,
          },
        }),
        threeNode({
          name: "torus",
          uuid: "mesh-torus",
          geometry: {
            type: "TorusGeometry",
            attributes: [],
            indexCount: null,
            bounds: null,
            parameters: null,
          },
          material: {
            type: "MeshStandardMaterial",
            color: "#778899",
            opacity: 1,
            transparent: false,
            metalness: 0,
            roughness: 1,
            side: 0,
            map: null,
          },
        }),
        threeNode({ type: "group", name: "rig", uuid: "group-1" }),
      ],
      truncated: false,
      total: 7,
    },
    camera,
    cameras: [camera],
    lights: [
      { type: "DirectionalLight", color: "#ffffff", intensity: 2, distance: 0 },
      { type: "PointLight", color: "#ff0000", intensity: 1, distance: 10 },
    ],
    controls: { type: "controls", target: [0, 1, 0] },
    coverage: { scene: true, geometry: true, camera: true, controls: true, lights: true, materials: true },
    ...overrides,
  };
}

function capturedConstant(main: string): any[] {
  const match = /const CAPTURED = (.*);\n/.exec(main);
  expect(match, "CAPTURED constant").not.toBeNull();
  return JSON.parse(match![1]!);
}

describe("build_scene_stub three adapter", () => {
  it("recreates primitive meshes, camera and controls from evidence.three", async () => {
    const root = tmpDir();
    const pack = evidence({ three: adapterThree() });
    const { sceneDir, evidencePath } = writePack(root, pack);
    const texture = localFile(root, "photo.png", "not-a-real-png");
    const opts = {
      evidencePath,
      sceneDir,
      assetBindings: [{ resourceId: "asset-2", localPath: texture }],
      title: "Adapter scene",
    };

    const first = await buildSceneStub(opts);
    const second = await buildSceneStub(opts);
    if ("error" in first || "error" in second) throw new Error(String((first as any).error));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    expect(first.mode).toBe("reconstructed-subset");
    const main = fileOf(first, "src/main.js");
    expect(main).toContain("new THREE.BoxGeometry");
    expect(main).toContain("new THREE.PlaneGeometry");
    expect(main).toContain("new THREE.SphereGeometry");
    expect(main).toContain("new THREE.CylinderGeometry");
    expect(main).toContain("new THREE.MeshStandardMaterial");
    expect(main).toContain("new THREE.MeshBasicMaterial");
    expect(main).toContain("new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.5, 500)");
    expect(main).not.toContain("OrbitControls");
    expect(main).not.toContain("controls.update");
    expect(main).toContain("/assets/asset-2.png");
    expect(main).toContain("matrix.fromArray([1,0,0,0,0,1,0,0,0,0,1,0,0,0,5,1])");
    expect(main).toContain("matrixWorld.fromArray([1,0,0,0,0,1,0,0,0,0,1,0,0,0,5,1])");
    expect(main).not.toContain("TorusGeometry");
    expect(main).not.toContain("awwwards-placeholder");
    // Captured camera pose is kept: no authored orbit or lookAt.
    expect(main).not.toContain("camera.position.x = Math.sin");
    expect(main).not.toContain("camera.lookAt(0, 0, 0)");
    expect(fileOf(first, "index.html")).not.toContain("scene-placeholder-label");

    const captured = capturedConstant(main);
    expect(captured.map((row) => row.kind)).toEqual(["box", "plane", "sphere", "cylinder"]);
    expect(captured[0]).toMatchObject({
      name: "box",
      args: [2, 2, 2],
      position: [1, 2, 3],
      quaternion: [0, 0.7071, 0, 0.7071],
      scale: [2, 2, 2],
      material: { kind: "standard", color: "#ff8800", opacity: 0.75, transparent: true, map: "/assets/asset-2.png" },
    });
    expect(captured[1]).toMatchObject({ kind: "plane", args: [4, 2], material: { kind: "basic" } });
    expect(captured[2]).toMatchObject({ kind: "sphere", args: [0.5] });
    expect(captured[3]).toMatchObject({ kind: "cylinder", args: [0.5, 0.5, 3] });

    // Unsupported geometry and unbound material data are reported, not guessed.
    expect(first.unresolved.some((row) => row.evidenceRef === "torus" && /TorusGeometry/.test(row.reason))).toBe(true);
    expect(first.unresolved.some((row) => row.evidenceRef === "sphere" && /no material record/.test(row.reason))).toBe(true);
    expect(first.unresolved.some((row) => row.evidenceRef === "three.lights")).toBe(true);
    expect(
      first.unresolved.some(
        (row) =>
          row.evidenceRef === "three.controls" && /exact captured camera matrix/.test(row.reason),
      ),
    ).toBe(true);

    expect(first.provenance.limitations.join(" ")).toMatch(/heap was not crawled/i);
    expect(first.provenance.limitations.join(" ")).toMatch(/parent-relative/i);
    expect(fileOf(first, "README.md")).toMatch(/three adapter/i);
    expect(fileOf(first, "README.md")).not.toContain("no scene graph,");
    expect(first.authoredDefaults.some((row) => /PerspectiveCamera/.test(row.value))).toBe(false);
    expect(first.authoredDefaults.some((row) => /static captured camera/.test(row.value))).toBe(true);

    // The generated module parses as ESM (imports are not resolved by --check).
    const parsed = join(root, "adapter-main.mjs");
    writeFileSync(parsed, main);
    execFileSync(process.execPath, ["--check", parsed], { stdio: "pipe" });
  });

  it("uses real geometry parameters and reports missing ones with authored defaults", async () => {
    const root = tmpDir();
    const three = adapterThree();
    three.scene = {
      nodes: [
        threeNode({
          name: "sized",
          geometry: {
            type: "BoxGeometry",
            attributes: [],
            indexCount: null,
            bounds: null,
            parameters: { width: 2, height: 3, depth: 4, widthSegments: 1 },
          },
        }),
        threeNode({
          name: "unsized",
          geometry: { type: "BoxGeometry", attributes: [], indexCount: null, bounds: null, parameters: null },
        }),
      ],
      truncated: false,
      total: 2,
    };
    const { sceneDir, evidencePath } = writePack(root, evidence({ three }));
    const result = await buildSceneStub({ evidencePath, sceneDir });
    if ("error" in result) throw new Error(result.error);

    const captured = capturedConstant(fileOf(result, "src/main.js"));
    expect(captured[0]).toMatchObject({ name: "sized", kind: "box", args: [2, 3, 4] });
    expect(captured[1]).toMatchObject({ name: "unsized", kind: "box", args: [1, 1, 1] });
    const missing = result.unresolved.filter(
      (row) => row.evidenceRef === "unsized" && /parameters\.(width|height|depth)/.test(row.reason),
    );
    expect(missing).toHaveLength(3);
  });

  it("refuses invalid camera matrices and projection and keeps the authored camera", async () => {
    const cases: Array<{ name: string; camera: Record<string, unknown> }> = [
      {
        name: "all-zero matrix",
        camera: {
          type: "PerspectiveCamera",
          fov: 45,
          near: 0.5,
          far: 500,
          matrixWorld: Array.from({ length: 16 }, () => 0),
        },
      },
      {
        name: "negative fov",
        camera: {
          type: "PerspectiveCamera",
          fov: -10,
          near: 0.5,
          far: 500,
          matrixWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1],
        },
      },
      {
        name: "near equals far and zero",
        camera: {
          type: "PerspectiveCamera",
          fov: 45,
          near: 0,
          far: 0,
          matrixWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1],
        },
      },
      {
        name: "non-affine last row",
        camera: {
          type: "PerspectiveCamera",
          fov: 45,
          near: 0.5,
          far: 500,
          matrixWorld: [1, 0, 0, 0.5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1],
        },
      },
    ];

    for (const testCase of cases) {
      const root = tmpDir();
      const three = adapterThree({ camera: testCase.camera as never, cameras: [testCase.camera as never] });
      const { sceneDir, evidencePath } = writePack(root, evidence({ three }));
      const result = await buildSceneStub({ evidencePath, sceneDir });
      if ("error" in result) throw new Error(result.error);
      const main = fileOf(result, "src/main.js");
      expect(main, testCase.name).toContain("new THREE.PerspectiveCamera(50,");
      expect(main, testCase.name).not.toContain("matrixWorld.fromArray");
      expect(
        result.unresolved.some((row) => row.evidenceRef === "three.camera"),
        testCase.name,
      ).toBe(true);
      expect(
        result.authoredDefaults.some((row) => /PerspectiveCamera/.test(row.value)),
        testCase.name,
      ).toBe(true);
    }
  });

  it("keeps a captured camera static when no controls are captured", async () => {
    const root = tmpDir();
    const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1];
    const three = adapterThree({
      camera: { type: "PerspectiveCamera", fov: 60, near: 1, far: 1000, matrixWorld: matrix },
      cameras: [{ type: "PerspectiveCamera", fov: 60, near: 1, far: 1000, matrixWorld: matrix }],
      controls: null,
    });
    const { sceneDir, evidencePath } = writePack(root, evidence({ three }));
    const result = await buildSceneStub({ evidencePath, sceneDir });
    if ("error" in result) throw new Error(result.error);

    const main = fileOf(result, "src/main.js");
    expect(main).toContain("new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 1000)");
    expect(main).toContain("matrix.fromArray([1,0,0,0,0,1,0,0,0,0,1,0,7,8,9,1])");
    expect(main).toContain("matrixWorld.fromArray([1,0,0,0,0,1,0,0,0,0,1,0,7,8,9,1])");
    expect(main).toContain("matrixWorldInverse.copy(camera.matrixWorld).invert()");
    expect(main).toContain("camera.matrixAutoUpdate = false");
    expect(main).toContain("camera.matrixWorldAutoUpdate = false");
    expect(main).not.toContain("decompose(camera.position");
    expect(main).not.toContain("camera.lookAt");
    expect(main).not.toContain("camera.position.x = Math.sin");
    expect(main).not.toContain("OrbitControls");
    expect(main).toContain("static render, no authored orbit");
    expect(result.authoredDefaults.some((row) => /static captured camera/.test(row.value))).toBe(true);
  });

  it("keeps a sheared camera matrix exactly and refuses controls", async () => {
    const root = tmpDir();
    const shear = [1, 0, 0, 0, 0.3, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1];
    const three = adapterThree({
      camera: { type: "PerspectiveCamera", fov: 45, near: 0.5, far: 500, matrixWorld: shear },
      cameras: [{ type: "PerspectiveCamera", fov: 45, near: 0.5, far: 500, matrixWorld: shear }],
      controls: { type: "controls", target: [0, 0, 0] },
    });
    const { sceneDir, evidencePath } = writePack(root, evidence({ three }));
    const result = await buildSceneStub({ evidencePath, sceneDir });
    if ("error" in result) throw new Error(result.error);

    const main = fileOf(result, "src/main.js");
    const serialized = JSON.stringify(shear);
    expect(main).toContain(`camera.matrix.fromArray(${serialized})`);
    expect(main).toContain(`camera.matrixWorld.fromArray(${serialized})`);
    expect(main).toContain("camera.matrixWorldInverse.copy(camera.matrixWorld).invert()");
    expect(main).toContain("camera.matrixAutoUpdate = false");
    expect(main).toContain("camera.matrixWorldAutoUpdate = false");
    expect(main).not.toContain("decompose(camera.position");
    expect(main).not.toContain("OrbitControls");
    expect(main).not.toContain("controls.update");
    const gap = result.unresolved.find((row) => row.evidenceRef === "three.controls");
    expect(gap?.reason).toMatch(/exact captured camera matrix/);
  });

  it("preserves a huge-scale sheared matrix exactly and never wires controls", async () => {
    // The old orthogonality gate accepted this (1e-6 normalized shear), but a
    // decompose/recompose would move an element by 0.5 at this scale.
    const root = tmpDir();
    const huge = [1_000_000, 0, 0, 0, 1, 1_000_000, 0, 0, 0, 0, 1_000_000, 0, 7, 8, 9, 1];
    const three = adapterThree({
      camera: { type: "PerspectiveCamera", fov: 45, near: 0.5, far: 500, matrixWorld: huge },
      cameras: [{ type: "PerspectiveCamera", fov: 45, near: 0.5, far: 500, matrixWorld: huge }],
      controls: { type: "controls", target: [0, 1, 0] },
    });
    const { sceneDir, evidencePath } = writePack(root, evidence({ three }));
    const result = await buildSceneStub({ evidencePath, sceneDir });
    if ("error" in result) throw new Error(result.error);

    const main = fileOf(result, "src/main.js");
    const serialized = JSON.stringify(huge);
    expect(main).toContain(`camera.matrix.fromArray(${serialized})`);
    expect(main).toContain(`camera.matrixWorld.fromArray(${serialized})`);
    expect(main).toContain("camera.matrixAutoUpdate = false");
    expect(main).toContain("camera.matrixWorldAutoUpdate = false");
    expect(main).not.toContain("decompose(camera.position");
    expect(main).not.toContain("OrbitControls");
    expect(main).not.toContain("controls.update");
    expect(
      result.unresolved.some(
        (row) =>
          row.evidenceRef === "three.controls" && /exact captured camera matrix/.test(row.reason),
      ),
    ).toBe(true);
  });

  it("keeps the controls reason when the mesh gap cap is full", async () => {
    const root = tmpDir();
    const torus = (index: number) =>
      threeNode({
        name: `torus-${index}`,
        uuid: `torus-${index}`,
        geometry: { type: "TorusGeometry", attributes: [], indexCount: null, bounds: null, parameters: null },
      });
    const three = adapterThree({
      scene: {
        nodes: [
          threeNode({ type: "scene", name: "root", uuid: "root", childCount: 42 }),
          ...Array.from({ length: 40 }, (_, index) => torus(index)),
          threeNode({
            name: "box",
            uuid: "box",
            geometry: {
              type: "BoxGeometry",
              attributes: [],
              indexCount: null,
              bounds: null,
              parameters: { width: 1, height: 1, depth: 1 },
            },
          }),
        ],
        truncated: false,
        total: 42,
      },
      controls: { type: "controls", target: [0, 1, 0] },
    });
    const { sceneDir, evidencePath } = writePack(root, evidence({ three }));
    const result = await buildSceneStub({ evidencePath, sceneDir });
    if ("error" in result) throw new Error(result.error);

    const main = fileOf(result, "src/main.js");
    expect(main).toContain("matrix.fromArray([1,0,0,0,0,1,0,0,0,0,1,0,0,0,5,1])");
    expect(main).toContain("matrixWorld.fromArray([1,0,0,0,0,1,0,0,0,0,1,0,0,0,5,1])");
    expect(main).toContain("camera.matrixAutoUpdate = false");
    expect(main).toContain("camera.matrixWorldAutoUpdate = false");
    expect(main).not.toContain("OrbitControls");
    expect(main).not.toContain("controls.update");
    expect(
      result.unresolved.filter(
        (row) =>
          row.evidenceRef === "three.controls" && /exact captured camera matrix/.test(row.reason),
      ),
    ).toHaveLength(1);
    expect(result.mode).toBe("reconstructed-subset");
  });

  it("keeps an exact non-uniform camera matrix and refuses controls", async () => {
    const root = tmpDir();
    const nonuniform = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 1, 2, 3, 1];
    const three = adapterThree({
      camera: { type: "PerspectiveCamera", fov: 45, near: 0.5, far: 500, matrixWorld: nonuniform },
      cameras: [{ type: "PerspectiveCamera", fov: 45, near: 0.5, far: 500, matrixWorld: nonuniform }],
      controls: { type: "controls", target: [0, 1, 0] },
    });
    const { sceneDir, evidencePath } = writePack(root, evidence({ three }));
    const result = await buildSceneStub({ evidencePath, sceneDir });
    if ("error" in result) throw new Error(result.error);

    const main = fileOf(result, "src/main.js");
    const serialized = JSON.stringify(nonuniform);
    expect(main).toContain(`camera.matrix.fromArray(${serialized})`);
    expect(main).toContain(`camera.matrixWorld.fromArray(${serialized})`);
    expect(main).not.toContain("decompose(camera.position");
    expect(main).not.toContain("OrbitControls");
    expect(main).not.toContain("controls.update");
    expect(result.unresolved.some((row) => row.evidenceRef === "three.controls")).toBe(true);
  });

  it("records unsupported-only adapters as unresolved and keeps the placeholder scene", async () => {
    const root = tmpDir();
    const three = adapterThree();
    three.scene = {
      nodes: [
        threeNode({
          name: "torus",
          geometry: { type: "TorusGeometry", attributes: [], indexCount: null, bounds: null, parameters: null },
        }),
      ],
      truncated: false,
      total: 1,
    };
    const { sceneDir, evidencePath } = writePack(root, evidence({ three }));

    const result = await buildSceneStub({ evidencePath, sceneDir });
    if ("error" in result) throw new Error(result.error);
    expect(result.mode).toBe("placeholder");
    const main = fileOf(result, "src/main.js");
    expect(main).not.toContain("const CAPTURED");
    expect(main).toContain("awwwards-placeholder");
    expect(main).toContain("PerspectiveCamera(50");
    expect(result.unresolved.some((row) => /TorusGeometry/.test(row.reason))).toBe(true);
  });

  it("ignores a malformed adapter block and keeps the no-adapter output byte-identical", async () => {
    const plainRoot = tmpDir();
    const plain = writePack(plainRoot);
    const adapterRoot = tmpDir();
    const malformed = writePack(
      adapterRoot,
      evidence({ three: { id: "three-adapter-v1", available: true, scene: { nodes: "nope" } } as never }),
    );

    const plainBuild = await buildSceneStub({ evidencePath: plain.evidencePath, sceneDir: plain.sceneDir });
    const malformedBuild = await buildSceneStub({
      evidencePath: malformed.evidencePath,
      sceneDir: malformed.sceneDir,
    });
    if ("error" in plainBuild || "error" in malformedBuild) throw new Error("expected a build");

    expect(malformedBuild.mode).toBe("placeholder");
    expect(JSON.stringify(malformedBuild)).toBe(JSON.stringify(plainBuild));
    // Malformed node rows inside an otherwise valid adapter are skipped too.
    const weirdRoot = tmpDir();
    const weird = writePack(
      weirdRoot,
      evidence({
        three: adapterThree({
          scene: {
            nodes: [null, "x", { type: "mesh", geometry: { type: "BoxGeometry" } }] as never,
            truncated: false,
            total: 3,
          },
        }),
      }),
    );
    const weirdBuild = await buildSceneStub({ evidencePath: weird.evidencePath, sceneDir: weird.sceneDir });
    if ("error" in weirdBuild) throw new Error(weirdBuild.error);
    // A nameless box is still a supported primitive; its defaults are bounded.
    expect(weirdBuild.mode).toBe("reconstructed-subset");
    expect(capturedConstant(fileOf(weirdBuild, "src/main.js"))[0]).toMatchObject({
      name: "mesh-1",
      kind: "box",
      args: [1, 1, 1],
      position: null,
    });
  });

  it("does not execute page strings in generated output", async () => {
    const root = tmpDir();
    const three = adapterThree();
    three.scene = {
      nodes: [
        threeNode({
          name: '");globalThis.pwned=1;("',
          geometry: { type: "BoxGeometry", attributes: [], indexCount: null, bounds: null, parameters: { width: 1, height: 1, depth: 1 } },
          material: {
            type: "MeshStandardMaterial",
            color: "#ffffff",
            opacity: 1,
            transparent: false,
            metalness: 0,
            roughness: 1,
            side: 0,
            map: null,
          },
        }),
      ],
      truncated: false,
      total: 1,
    };
    const { sceneDir, evidencePath } = writePack(root, evidence({ three }));
    const result = await buildSceneStub({ evidencePath, sceneDir });
    if ("error" in result) throw new Error(result.error);
    const main = fileOf(result, "src/main.js");
    expect(main).toContain("globalThis.pwned=1");
    // It is data: the payload is JSON-stringified, never spliced into code.
    expect(main).not.toMatch(/mesh\.name\s*=\s*"/);
    expect(capturedConstant(main)[0].name).toBe('");globalThis.pwned=1;("');
  });
});


function fakeCtx(handlers: object) {
  return { handlers, tool: vi.fn(), registerTool: vi.fn() } as any;
}

describe("build_scene_stub registration", () => {
  it("is read-only, idempotent, closed-world and rejects traversal at the schema", () => {
    const ctx = fakeCtx({ build_scene_stub: vi.fn() });
    registerBuildSceneStub(ctx);
    const [name, , shape, annotations] = ctx.tool.mock.calls[0];
    expect(name).toBe("build_scene_stub");
    expect(annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    const schema = z.object(shape);
    expect(schema.safeParse({ evidencePath: "/tmp/pack/evidence.json" }).success).toBe(true);
    expect(
      schema.safeParse({
        evidencePath: "/tmp/pack/evidence.json",
        assetBindings: [{ resourceId: "asset-1", localPath: "../../etc/passwd.glb" }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        evidencePath: "/tmp/pack/evidence.json",
        assetBindings: Array.from({ length: 33 }, (_, i) => ({
          resourceId: `asset-${i + 1}`,
          localPath: `/tmp/a${i}.glb`,
        })),
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ evidencePath: "/tmp/pack/evidence.json", assetBindings: [{ resourceId: "nope", localPath: "/tmp/a.glb" }] })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        evidencePath: "/tmp/pack/evidence.json",
        assetBindings: [
          { resourceId: "asset-1", localPath: "/tmp/a.glb" },
          { resourceId: "asset-1", localPath: "/tmp/b.glb" },
        ],
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ evidencePath: "/tmp/pack/evidence.json", title: "x".repeat(201) }).success).toBe(false);
  });

  it("handler passes the scene-captures namespace and returns the build as JSON text", async () => {
    const root = tmpDir();
    const seen: any[] = [];
    const handlers = createHandlers({
      client: new AwwwardsClient(),
      cache: new Cache(root),
      sceneStubFn: async (opts) => {
        seen.push(opts);
        return {
          id: "scene-stub-v1",
          mode: "placeholder",
          files: [],
          assetCopies: [],
          unresolved: [],
          authoredDefaults: [],
          provenance: {
            id: "scene-stub-provenance-v1",
            evidence: {
              id: "scene-evidence-v1",
              captureId,
              url: "https://example.com",
              capturedAt: 1,
              viewport: null,
              resourceTotal: 0,
              resourcesCollected: 0,
              resourcesTruncated: false,
            },
            mode: "placeholder",
            rights: { status: "not-recorded", note: "x" },
            authoredDefaults: [],
            unresolved: [],
            limitations: [],
          },
        };
      },
    });

    const result = await handlers.build_scene_stub({ evidencePath: "pack/evidence.json", title: "T" });
    expect(result.isError).toBeUndefined();
    expect(seen[0]).toEqual({ evidencePath: "pack/evidence.json", title: "T", sceneDir: join(root, "scene-captures") });
    expect(JSON.parse((result.content[0] as any).text).mode).toBe("placeholder");
  });
});

describe("v2 scene_stub branch", () => {
  function v2Ctx() {
    const ctx = fakeCtx({ build_scene_stub: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }) });
    registerBuildMotion(ctx);
    const [name, , schema, annotations, callback] = ctx.tool.mock.calls[0];
    return { ctx, name, schema, annotations, callback };
  }

  it("dispatches exactly one scene_stub request to build_scene_stub", async () => {
    const { ctx, name, schema, annotations, callback } = v2Ctx();
    expect(name).toBe("build_motion");
    expect(annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    const parser = schema as z.ZodType<{ request: Record<string, unknown> }>;
    const request = {
      request: { kind: "scene_stub", evidencePath: "/tmp/pack/evidence.json", assetBindings: [] },
    };
    expect(parser.safeParse(request).success).toBe(true);
    expect(
      parser.safeParse({ request: { kind: "scene_stub", evidencePath: "/tmp/pack/evidence.json", bands: [] } }).success,
    ).toBe(false);

    await callback(parser.parse(request));
    expect(ctx.handlers.build_scene_stub).toHaveBeenCalledWith({
      evidencePath: "/tmp/pack/evidence.json",
      assetBindings: [],
    });
  });

  it("keeps the profile counts at 41 full, 13 core and 15 v2", () => {
    const names: string[] = [];
    registerAllTools({
      handlers: {} as never,
      tool: ((name: string) => names.push(name)) as never,
      registerTool: ((name: string) => names.push(name)) as never,
    });
    expect(names).toHaveLength(41);
    expect(new Set(names).size).toBe(41);
    expect(names).toContain("build_scene_stub");
    expect(CORE_TOOL_NAMES).toHaveLength(13);
    expect(CORE_TOOL_NAMES).not.toContain("build_scene_stub");
    expect(V2_TOOL_NAMES).toHaveLength(15);
  });
});

// Offline proof: the returned project builds with the repo's installed vite and
// three (no npm install, no registry access). Command, from the generated root:
//   node node_modules/vite/bin/vite.js build
// (here the binary is passed by absolute path because the project lives inside
// this repo, so `three` also resolves from the repo's node_modules).
describe("generated project build", () => {
  const repoRoot = resolve(__dirname, "..");
  const viteBin = join(repoRoot, "node_modules", "vite", "bin", "vite.js");

  it("builds dist/index.html + JS with the local vite + three", async () => {
    const root = tmpDir();
    const { sceneDir, evidencePath } = writePack(root);
    const model = localFile(root, "scene.glb", "glTFfixture");
    const result = await buildSceneStub({
      evidencePath,
      sceneDir,
      assetBindings: [{ resourceId: "asset-1", localPath: model }],
    });
    if ("error" in result) throw new Error(result.error);

    // Inside the repo, so `three` resolves from repo node_modules without a
    // junction and without npm install.
    const project = mkdtempSync(join(repoRoot, ".tmp-scene-stub-build-"));
    dirs.push(project);
    for (const file of result.files) {
      const path = join(project, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
    }
    execFileSync(process.execPath, [viteBin, "build", "--logLevel", "warn"], {
      cwd: project,
      stdio: "pipe",
      timeout: 120_000,
    });

    expect(existsSync(join(project, "dist", "index.html"))).toBe(true);
    const assets = readdirSync(join(project, "dist", "assets"));
    expect(assets.some((name) => name.endsWith(".js"))).toBe(true);
  }, 120_000);

  it("builds the three-adapter project with the local vite + three", async () => {
    const root = tmpDir();
    const { sceneDir, evidencePath } = writePack(root, evidence({ three: adapterThree() }));
    const texture = localFile(root, "photo.png", "not-a-real-png");
    const result = await buildSceneStub({
      evidencePath,
      sceneDir,
      assetBindings: [{ resourceId: "asset-2", localPath: texture }],
    });
    if ("error" in result) throw new Error(result.error);

    const project = mkdtempSync(join(repoRoot, ".tmp-scene-stub-adapter-build-"));
    dirs.push(project);
    for (const file of result.files) {
      const path = join(project, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
    }
    execFileSync(process.execPath, [viteBin, "build", "--logLevel", "warn"], {
      cwd: project,
      stdio: "pipe",
      timeout: 120_000,
    });

    expect(existsSync(join(project, "dist", "index.html"))).toBe(true);
    const assets = readdirSync(join(project, "dist", "assets"));
    expect(assets.some((name) => name.endsWith(".js"))).toBe(true);
  }, 120_000);
});
