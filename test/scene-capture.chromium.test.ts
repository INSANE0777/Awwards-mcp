import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCENE_LIMITS,
  SCENE_PROBE,
  SCENE_SCROLL,
  SCENE_SPECTOR_PROBE,
  captureScene3d,
  loadSpectorBundle,
  spectorInitScript,
  spectorProbeCaps,
} from "../src/scene-capture.js";

// Real-browser regressions for capture_scene_3d: a WebGL page rendered from the
// pinned local three build, plus the connection-level guard. Local fixtures are
// allowed with the test-only exact-origin list; every other loopback origin
// stays blocked by the same gate production uses. No network access.
const REQUIRED = process.env.AWWWARDS_CHROMIUM_SMOKE === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const THREE_SOURCE = readFileSync(join(ROOT, "node_modules/three/build/three.module.js"));

let chromium: typeof import("playwright").chromium | null = null;
let chromiumAvailable = false;
let unavailable = "";
try {
  ({ chromium } = await import("playwright"));
  // Probe-and-close: a resident browser here starves the close hooks of other
  // Chromium suites running in parallel.
  const probe = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
  await probe.close();
  chromiumAvailable = true;
} catch (err) {
  unavailable = err instanceof Error ? err.message : String(err);
}

const dirs: string[] = [];
const sceneDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-scene-chromium-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const WEBGL_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:3000px;background:#0b0d12}
#scene{position:fixed;left:40px;top:30px;width:600px;height:400px;display:block}
</style></head><body>
<canvas id="scene" width="600" height="400"></canvas>
<script type="module">
import * as THREE from "/three.module.js";
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(600, 400, false);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b4dff);
const camera = new THREE.PerspectiveCamera(50, 600 / 400, 0.1, 100);
camera.position.set(0, 0, 3);
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1), new THREE.MeshBasicMaterial({ color: 0xffaa00 })));
renderer.render(scene, camera);
window.__sceneReady = true;
</script>
</body></html>`;

const ADAPTER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:3000px;background:#0b0d12}
#scene{position:fixed;left:40px;top:30px;width:600px;height:400px;display:block}
</style></head><body>
<canvas id="scene" width="600" height="400"></canvas>
<script type="module">
import * as THREE from "/three.module.js";
// A page-defined URL constructor must never run inside the probe.
window.URL = function () {
  window.__urlExecuted = true;
  return { href: "https://evil.example/?leak=secret" };
};
// An observed response at this path makes the canonical texture URL linkable.
await fetch("/textures/rock.png");
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(600, 400, false);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 600 / 400, 0.1, 100);
camera.position.set(0, 0, 3);
const material = new THREE.MeshStandardMaterial({ color: 0x00ccff, roughness: 0.4, metalness: 0.1 });
const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), material);
mesh.name = "adapter-cube";
scene.add(mesh);
const light = new THREE.DirectionalLight(0xffffff, 2);
light.position.set(2, 3, 4);
scene.add(light);
renderer.render(scene, camera);
// A fake image source set after the render: protocol-relative, with
// credentials, query and hash. The probe only reads the URL, never loads it.
material.map = { image: { src: "//user:pass@" + location.host + "/textures/rock.png?token=secret#frag" } };
// The documented reachable pattern: live objects on window, no hooks.
window.scene = scene;
window.camera = camera;
window.renderer = renderer;
window.app = { scene, camera, renderer };
window.__sceneReady = true;
</script>
</body></html>`;

// A decoy canvas pre-marked with the old fixed marker value and placed first in
// document order. A picker that trusts that fixed value resolves the decoy, not
// the explicitly requested #wanted canvas.
const DECOY_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:3000px;background:#0b0d12}
#decoy{position:fixed;left:700px;top:30px;width:400px;height:300px;display:block}
#wanted{position:fixed;left:40px;top:30px;width:600px;height:400px;display:block}
</style></head><body>
<canvas id="decoy" data-awwwards-scene-canvas="1" width="400" height="300"></canvas>
<canvas id="wanted" width="600" height="400"></canvas>
<script>
const decoy = document.getElementById("decoy");
const dx = decoy.getContext("2d");
dx.fillStyle = "#808080";
dx.fillRect(0, 0, 400, 300);
const wanted = document.getElementById("wanted");
const wx = wanted.getContext("2d");
wx.fillStyle = "#1b4dff";
wx.fillRect(0, 0, 600, 400);
wx.fillStyle = "#ffaa00";
wx.fillRect(40, 40, 240, 160);
</script>
</body></html>`;

const POPUP_HTML = (popupUrl: string) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:3000px;background:#0b0d12}
#scene{position:fixed;left:40px;top:30px;width:600px;height:400px;display:block}
</style></head><body>
<canvas id="scene" width="600" height="400"></canvas>
<script>
const c = document.getElementById("scene");
const x = c.getContext("2d");
x.fillStyle = "#00aa55";
x.fillRect(0, 0, 600, 400);
window.open(${JSON.stringify(popupUrl)}, "_blank");
</script>
</body></html>`;

// A continuous rAF loop: spector captures one complete frame, so the page must
// keep producing frames while the probe waits.
const LOOP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:3000px;background:#0b0d12}
#scene{position:fixed;left:40px;top:30px;width:600px;height:400px;display:block}
</style></head><body>
<canvas id="scene" width="600" height="400"></canvas>
<script type="module">
import * as THREE from "/three.module.js";
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(600, 400, false);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b4dff);
const camera = new THREE.PerspectiveCamera(50, 600 / 400, 0.1, 100);
camera.position.set(0, 0, 3);
const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x00ccff, roughness: 0.4, metalness: 0.1 }),
);
scene.add(cube);
const clock = new THREE.Clock();
const loop = () => {
  cube.rotation.y = clock.getElapsedTime();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
};
loop();
window.scene = scene;
window.camera = camera;
window.renderer = renderer;
window.__gl = renderer.getContext();
window.__sceneReady = true;
</script>
</body></html>`;

const IDLE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:3000px;background:#0b0d12}
#scene{position:fixed;left:40px;top:30px;width:600px;height:400px;display:block}
</style></head><body>
<canvas id="scene" width="600" height="400"></canvas>
<script>
// One clear at load, then no requestAnimationFrame and no timers: spector has
// no frame to capture, so the in-page probe must hit its own timeout.
const canvas = document.getElementById("scene");
const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
gl.clearColor(0.1, 0.2, 0.3, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
window.__gl = gl;
window.__sceneReady = true;
</script>
</body></html>`;

interface Fixture {
  origin: string;
  pageHits: string[];
  blockedHits: string[];
  close(): Promise<void>;
}

async function startFixtures(): Promise<Fixture> {
  const pageHits: string[] = [];
  const blockedHits: string[] = [];
  const blocked = createServer((req, res) => {
    blockedHits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("secret");
  });
  await new Promise<void>((resolve) => blocked.listen(0, "127.0.0.1", resolve));
  const blockedAddress = blocked.address();
  const blockedOrigin = `http://127.0.0.1:${
    typeof blockedAddress === "object" && blockedAddress ? blockedAddress.port : 0
  }`;

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    pageHits.push(path);
    if (path === "/scene-redirect") {
      res.writeHead(302, { location: `http://${req.headers.host}/scene.html` });
      res.end();
      return;
    }
    if (path === "/scene.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(WEBGL_HTML);
      return;
    }
    if (path === "/adapter.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(ADAPTER_HTML);
      return;
    }
    if (path === "/loop.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(LOOP_HTML);
      return;
    }
    if (path === "/idle.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(IDLE_HTML);
      return;
    }
    if (path === "/decoy.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(DECOY_HTML);
      return;
    }
    if (path === "/three.module.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(THREE_SOURCE);
      return;
    }
    if (path === "/textures/rock.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from("fake-png"));
      return;
    }
    if (path === "/popup.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(POPUP_HTML(`${blockedOrigin}/popup-secret`));
      return;
    }
    if (path === "/start") {
      res.writeHead(302, { location: `${blockedOrigin}/secret` });
      res.end();
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  return {
    origin,
    pageHits,
    blockedHits,
    close: () =>
      Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => blocked.close(() => resolve())),
      ]).then(() => undefined),
  };
}

// Reuse the real capture path, adding only launch flags, never a fake browser.
const loader = async () => ({
  chromium: {
    launch: (options: any) =>
      chromium!.launch({
        ...options,
        args: [...(options?.args ?? []), "--disable-popup-blocking", "--enable-unsafe-swiftshader"],
      }),
  },
});

function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// Structural fingerprint of what Spector's constructor patches, used to prove
// disposal restored the page. The context hooks are compared by identity with
// the methods captured on the first call (before the probe constructs Spector),
// so an own context hook left by unSpy() fails the comparison even when the
// prototype is restored.
function instrumentationSnapshot() {
  const source = (value: any): string => (typeof value === "function" ? value.toString() : "");
  const hook = (iface: any, name: string): string => {
    try {
      const fn = iface && iface.prototype ? iface.prototype[name] : null;
      return source(fn);
    } catch {
      return "";
    }
  };
  const g = globalThis as any;
  const context = g.__gl ?? null;
  let contextHooks: Record<string, any> | null = null;
  if (context) {
    if (!g.__originalContextHooks) {
      g.__originalContextHooks = {
        linkProgram: context.linkProgram,
        getProgramParameter: context.getProgramParameter,
      };
    }
    const original = g.__originalContextHooks;
    contextHooks = {
      ownLinkProgram: Object.prototype.hasOwnProperty.call(context, "linkProgram"),
      ownGetProgramParameter: Object.prototype.hasOwnProperty.call(context, "getProgramParameter"),
      linkProgram: source(context.linkProgram),
      getProgramParameter: source(context.getProgramParameter),
      linkIdentity: context.linkProgram === original.linkProgram,
      getIdentity: context.getProgramParameter === original.getProgramParameter,
    };
  }
  return {
    raf: source(g.requestAnimationFrame),
    timers: [source(g.setTimeout), source(g.setInterval)],
    webgl1: [
      hook(g.WebGLRenderingContext, "linkProgram"),
      hook(g.WebGLRenderingContext, "getProgramParameter"),
    ],
    webgl2: [
      hook(g.WebGL2RenderingContext, "linkProgram"),
      hook(g.WebGL2RenderingContext, "getProgramParameter"),
    ],
    originKeys: Object.getOwnPropertyNames(g).filter((key) => key.indexOf("__SPECTOR_Origin_") === 0)
      .length,
    styles: document.querySelectorAll("style").length,
    contextHooks,
  };
}

async function pixelStats(pngPath: string): Promise<{
  colorful: number;
  total: number;
  width: number;
  height: number;
}> {
  const browser = await chromium!.launch({ args: ["--enable-unsafe-swiftshader"] });
  try {
    const page = await browser.newPage();
    return await page.evaluate(async (b64) => {
      const blob = await (await fetch("data:image/png;base64," + b64)).blob();
      const bitmap = await createImageBitmap(blob);
      const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = surface.getContext("2d");
      if (!ctx) throw new Error("2D canvas unavailable");
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let colorful = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]!;
        const g = data[i + 1]!;
        const b = data[i + 2]!;
        if (Math.max(r, g, b) - Math.min(r, g, b) > 60) colorful++;
      }
      return {
        colorful,
        total: bitmap.width * bitmap.height,
        width: bitmap.width,
        height: bitmap.height,
      };
    }, readFileSync(pngPath).toString("base64"));
  } finally {
    await browser.close();
  }
}

if (!chromiumAvailable && REQUIRED) {
  describe("scene capture Chromium", () => {
    it("launches Chromium", () => {
      throw new Error(
        `AWWWARDS_CHROMIUM_SMOKE=1 but Chromium is unavailable: ${unavailable || "playwright missing"}\n` +
          "Install it with: npm exec -- playwright install chromium",
      );
    });
  });
} else {
  const suite = chromiumAvailable ? describe : describe.skip;
  suite("scene capture Chromium", () => {
    it(
      "follows a same-origin redirect and captures a real WebGL canvas at a fixed y across scroll",
      { timeout: 90_000 },
      async () => {
        const fixture = await startFixtures();
        try {
          const dir = sceneDir();
          const result = await captureScene3d(`${fixture.origin}/scene-redirect`, {
            loader,
            allowPrivateOrigins: [fixture.origin],
            sceneDir: dir,
            checkpoints: [
              { scrollRatio: 0, waitMs: 200 },
              { scrollRatio: 1, waitMs: 200 },
            ],
          });
          expect("error" in result).toBe(false);
          if ("error" in result) throw new Error(result.error);

          expect(result.checkpoints).toHaveLength(2);
          expect(result.checkpoints[1].actualScrollTop).toBeGreaterThan(0);
          expect(result.canvas.canvases).toBe(1);
          expect(fixture.pageHits).toEqual(
            expect.arrayContaining(["/scene-redirect", "/scene.html", "/three.module.js"]),
          );

          // The fixed canvas is at viewport y=30 with a 3000px document and the
          // page scrolled to the bottom. A scroll translation would capture the
          // wrong region or no region at all.
          const canvasPng = readFileSync(result.checkpoints[1].files.canvas);
          expect(pngSize(canvasPng)).toEqual({ width: 600, height: 400 });

          // Real pixels, not a blank canvas: WebGL painted through three.
          const stats = await pixelStats(result.checkpoints[1].files.canvas);
          expect(stats.width).toBe(600);
          expect(stats.height).toBe(400);
          expect(stats.colorful).toBeGreaterThan(100_000);

          // The page's own module response is part of the inventory.
          expect(
            result.resources.some(
              (row) => row.url === `${fixture.origin}/three.module.js` && row.classification === "script",
            ),
          ).toBe(true);
          expect(result.blockedRequests.count).toBe(0);
        } finally {
          await fixture.close();
        }
      },
    );

    it(
      "captures the canvas the selector resolved, not a pre-marked decoy",
      { timeout: 90_000 },
      async () => {
        const fixture = await startFixtures();
        try {
          const result = await captureScene3d(`${fixture.origin}/decoy.html`, {
            loader,
            allowPrivateOrigins: [fixture.origin],
            sceneDir: sceneDir(),
            canvasSelector: "#wanted",
            includeViewportShots: false,
            checkpoints: [{ scrollRatio: 0, waitMs: 100 }],
          });
          if ("error" in result) throw new Error(result.error);

          expect(result.canvas.requestedSelector).toBe("#wanted");
          // The decoy is first in document order and pre-carries the old fixed
          // marker value; the captured geometry must still be #wanted's.
          expect(result.checkpoints[0].canvas).toEqual({
            rect: { x: 40, y: 30, width: 600, height: 400 },
            backing: { width: 600, height: 400 },
            dpr: 1,
          });
          const png = readFileSync(result.checkpoints[0].files.canvas);
          expect(pngSize(png)).toEqual({ width: 600, height: 400 });
          // #wanted is saturated blue/orange; the decoy is uniform grey, so a
          // decoy capture would contain no colourful pixels.
          const stats = await pixelStats(result.checkpoints[0].files.canvas);
          expect(stats.colorful).toBeGreaterThan(600 * 400 * 0.9);
        } finally {
          await fixture.close();
        }
      },
    );

    it(
      "reads a real three scene when the adapter is requested and stays passive without it",
      { timeout: 90_000 },
      async () => {
        const fixture = await startFixtures();
        try {
          const without = await captureScene3d(`${fixture.origin}/adapter.html`, {
            loader,
            allowPrivateOrigins: [fixture.origin],
            sceneDir: sceneDir(),
            includeViewportShots: false,
            checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
          });
          expect("error" in without).toBe(false);
          if ("error" in without) throw new Error(without.error);
          expect(without.three).toBeUndefined();
          expect(without.coverage.capabilities.scene.status).toBe("unavailable");

          const result = await captureScene3d(`${fixture.origin}/adapter.html`, {
            loader,
            allowPrivateOrigins: [fixture.origin],
            sceneDir: sceneDir(),
            includeViewportShots: false,
            adapters: ["three"],
            checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
          });
          expect("error" in result).toBe(false);
          if ("error" in result) throw new Error(result.error);

          // The module scope owns THREE, so only the live objects are reachable;
          // revision stays null while the scene, camera and light are read.
          expect(result.three?.available, result.three?.reason).toBe(true);
          expect(result.three).toMatchObject({ id: "three-adapter-v1", revision: null });
          const nodes = result.three?.scene?.nodes ?? [];
          const cube = nodes.find((node) => node.type === "mesh");
          expect(cube?.name).toBe("adapter-cube");
          expect(cube?.geometry?.type).toBe("BoxGeometry");
          expect(cube?.geometry?.parameters).toMatchObject({ width: 1, height: 2, depth: 3 });
          expect(cube?.geometry?.attributes.map((row) => row.name)).toEqual(
            expect.arrayContaining(["position", "normal", "uv"]),
          );
          expect(cube?.material).toMatchObject({ type: "MeshStandardMaterial", color: "#00ccff" });
          const map = cube?.material && !Array.isArray(cube.material) ? cube.material.map : null;
          expect(map?.url).toBe(`${fixture.origin}/textures/rock.png`);
          expect(map?.assetId).toMatch(/^asset-\d+$/);
          expect(JSON.stringify(result)).not.toContain("user:pass");
          expect(JSON.stringify(result)).not.toContain("token=secret");
          expect(JSON.stringify(result)).not.toContain("evil.example");
          expect(JSON.stringify(result)).not.toContain("leak=secret");
          expect(result.three?.camera).toMatchObject({ type: "PerspectiveCamera", fov: 50 });
          expect(result.three?.camera?.matrixWorld).toHaveLength(16);
          expect(result.three?.lights).toEqual(
            expect.arrayContaining([expect.objectContaining({ type: "DirectionalLight", intensity: 2 })]),
          );
          expect(result.coverage.capabilities.scene.status).toBe("available");
          expect(result.coverage.capabilities.geometry.status).toBe("available");
          expect(result.coverage.capabilities.camera.status).toBe("available");
          expect(result.coverage.capabilities.controls.status).toBe("unknown");
          expect(result.coverage.capabilities.shaders.status).toBe("unavailable");
        } finally {
          await fixture.close();
        }
      },
    );

    it(
      "captures one real WebGL frame with the spector adapter and no UI",
      { timeout: 120_000 },
      async () => {
        const fixture = await startFixtures();
        try {
          const result = await captureScene3d(`${fixture.origin}/loop.html`, {
            loader,
            allowPrivateOrigins: [fixture.origin],
            sceneDir: sceneDir(),
            includeViewportShots: false,
            adapters: ["spector"],
            checkpoints: [{ scrollRatio: 0, waitMs: 100 }],
          });
          expect("error" in result).toBe(false);
          if ("error" in result) throw new Error(result.error);

          const spector = result.spector;
          expect(spector?.available, spector?.reason).toBe(true);
          expect(spector).toMatchObject({ id: "spector-adapter-v1", version: "0.9.33" });
          expect(spector?.canvas).toEqual({ width: 600, height: 400 });
          expect(spector?.context?.version).toBeGreaterThanOrEqual(1);
          expect(spector?.commands.total).toBeGreaterThan(0);
          expect(spector?.commands.drawCalls).toBeGreaterThan(0);
          expect(spector?.programs.length).toBeGreaterThan(0);
          const shaders = (spector?.programs ?? []).flatMap((program) => program.shaders);
          expect(shaders.length).toBeGreaterThan(0);
          // Real GLSL read from the page, stored as data and capped.
          expect(shaders.some((shader) => /void\s+main/.test(shader.source))).toBe(true);
          expect(
            shaders.every((shader) => shader.source.length <= SCENE_LIMITS.maxSpectorShaderChars),
          ).toBe(true);
          expect(spector?.limits.programsTruncated).toBe(false);
          expect(result.coverage.capabilities.shaders.status).toBe("available");
          expect(result.coverage.capabilities.scene.status).toBe("unavailable");
          expect(result.limitations.join(" ")).toMatch(/spector adapter captured one WebGL frame/i);

          // The pack stays inside the shared 2 MiB evidence cap.
          const evidence = readFileSync(result.paths.evidence);
          expect(evidence.length).toBeLessThan(2 * 1024 * 1024);
          // No network fetch for the bundle: it was installed as an init script.
          expect(fixture.pageHits).toEqual(
            expect.arrayContaining(["/loop.html", "/three.module.js"]),
          );
          expect(fixture.pageHits.some((path) => path.includes("spector.bundle"))).toBe(false);
        } finally {
          await fixture.close();
        }
      },
    );

    it(
      "runs the spector probe in-page without adding UI or styles",
      { timeout: 90_000 },
      async () => {
        const fixture = await startFixtures();
        const bundle = await loadSpectorBundle();
        expect(bundle?.version).toBe("0.9.33");
        const browser = await chromium!.launch({ args: ["--enable-unsafe-swiftshader"] });
        try {
          const page = await browser.newPage();
          await page.addInitScript(spectorInitScript(bundle!.source));
          await page.goto(`${fixture.origin}/loop.html`, { waitUntil: "load" });
          await page.waitForFunction(() => (window as any).__sceneReady === true);
          const before = await page.evaluate(() => ({
            bodyChildren: document.body.children.length,
            styles: document.querySelectorAll("style").length,
          }));
          const instrumentationBefore = await page.evaluate(instrumentationSnapshot);

          const summary = await page.evaluate(
            SCENE_SPECTOR_PROBE,
            spectorProbeCaps("#scene", SCENE_LIMITS.spectorProbeTimeoutMs),
          );
          expect("error" in summary).toBe(false);
          if ("error" in summary) throw new Error(summary.error);
          expect(summary.commands.drawCalls).toBeGreaterThan(0);
          expect(summary.programs.length).toBeGreaterThan(0);

          // Disposal after a successful capture restores the page too.
          const instrumentationAfter = await page.evaluate(instrumentationSnapshot);
          expect(instrumentationAfter).toEqual(instrumentationBefore);
          expect(instrumentationAfter.originKeys).toBe(0);
          // The context must not keep the constructor's own compile hooks:
          // unSpy() restores to those hooks, so identity is asserted here.
          expect(instrumentationAfter.contextHooks).toMatchObject({
            ownLinkProgram: false,
            ownGetProgramParameter: false,
            linkIdentity: true,
            getIdentity: true,
          });

          const after = await page.evaluate(() => ({
            bodyChildren: document.body.children.length,
            styles: document.querySelectorAll("style").length,
            spectorNodes: document.querySelectorAll(
              '[id*="spector" i], [class*="spector" i], [data-spector]',
            ).length,
          }));
          expect(after.bodyChildren).toBe(before.bodyChildren);
          expect(after.styles).toBe(before.styles);
          expect(after.spectorNodes).toBe(0);
        } finally {
          await browser.close();
          await fixture.close();
        }
      },
    );

    it(
      "disposes spector after an idle-canvas timeout and restores page instrumentation",
      { timeout: 120_000 },
      async () => {
        const fixture = await startFixtures();
        const bundle = await loadSpectorBundle();
        expect(bundle?.version).toBe("0.9.33");
        const browser = await chromium!.launch({ args: ["--enable-unsafe-swiftshader"] });
        try {
          const page = await browser.newPage();
          await page.addInitScript(spectorInitScript(bundle!.source));
          await page.goto(`${fixture.origin}/idle.html`, { waitUntil: "load" });
          await page.waitForFunction(() => (window as any).__sceneReady === true);
          const before = await page.evaluate(instrumentationSnapshot);

          const summary = await page.evaluate(SCENE_SPECTOR_PROBE, spectorProbeCaps("#scene", 300));
          expect(summary).toEqual({ error: expect.stringMatching(/time budget/) });

          // Timing wrappers and the global WebGL shader-compile hooks installed
          // by the constructor are restored; no originals are left behind.
          const after = await page.evaluate(instrumentationSnapshot);
          expect(after).toEqual(before);
          expect(after.originKeys).toBe(0);
          // unSpy() writes back the hook it captured (the constructor's own
          // wrapper); disposal must remove that own property and fall back to
          // the restored native prototype method.
          expect(after.contextHooks).toMatchObject({
            ownLinkProgram: false,
            ownGetProgramParameter: false,
            linkIdentity: true,
            getIdentity: true,
          });

          // No lingering frame callback: the page's rAF loop still runs.
          const frames = await page.evaluate(
            () =>
              new Promise<number>((resolve) => {
                let count = 0;
                const tick = () => {
                  count += 1;
                  if (count >= 3) resolve(count);
                  else requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
                setTimeout(() => resolve(-1), 2000);
              }),
          );
          expect(frames).toBe(3);

          // Checkpoints still run in the same page with no active capture.
          const probe = await page.evaluate(SCENE_PROBE, {
            canvasSelector: "#scene",
            scrollRoot: "",
          });
          expect(probe.canvasFound).toBe(true);
          const top = Number(
            await page.evaluate(SCENE_SCROLL, { scrollRoot: "", top: 150 }),
          );
          expect(top).toBeGreaterThan(0);
          const shot = await page.screenshot({ clip: { x: 0, y: 0, width: 80, height: 80 } });
          expect(shot.length).toBeGreaterThan(0);
          // WebGL still executes; spector no longer spies the context.
          const glError = await page.evaluate(() => {
            const gl = (window as any).__gl;
            gl.clear(gl.COLOR_BUFFER_BIT);
            return gl.getError();
          });
          expect(glError).toBe(0);
          expect(fixture.pageHits).toContain("/idle.html");
        } finally {
          await browser.close();
          await fixture.close();
        }
      },
    );

    it(
      "blocks a redirect hop to a loopback server outside the allowlist",
      { timeout: 90_000 },
      async () => {
        const fixture = await startFixtures();
        try {
          const result = await captureScene3d(`${fixture.origin}/start`, {
            loader,
            allowPrivateOrigins: [fixture.origin],
            sceneDir: sceneDir(),
            checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
          });
          expect("error" in result).toBe(true);
          expect(fixture.pageHits).toContain("/start");
          expect(fixture.blockedHits).toEqual([]);
        } finally {
          await fixture.close();
        }
      },
    );

    it(
      "blocks and closes a popup aimed at a loopback server outside the allowlist",
      { timeout: 90_000 },
      async () => {
        const fixture = await startFixtures();
        try {
          const result = await captureScene3d(`${fixture.origin}/popup.html`, {
            loader,
            allowPrivateOrigins: [fixture.origin],
            sceneDir: sceneDir(),
            checkpoints: [{ scrollRatio: 0, waitMs: 300 }],
          });
          expect("error" in result).toBe(false);
          expect(fixture.pageHits).toContain("/popup.html");
          expect(fixture.blockedHits).toEqual([]);
        } finally {
          await fixture.close();
        }
      },
    );
  });
}
