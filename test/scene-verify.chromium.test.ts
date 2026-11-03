import { createServer } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureScene3d } from "../src/scene-capture.js";
import type { SceneEvidence } from "../src/scene-capture.js";
import { verifyScene3d } from "../src/scene-verify.js";

// Real-browser regressions for the verify_build scene3d gate: a local fixture
// pair (reference/build) is captured once through the prod capture path with
// the test-only exact-origin loopback allowance, then replayed by
// verifyScene3d. The fixture pages load no external resources; no network.
const REQUIRED = process.env.AWWWARDS_CHROMIUM_SMOKE === "1";

// Probe-and-close, not a long-lived browser: several Chromium suites run in
// parallel here, and a resident probe per file starves the others' close hooks.
let chromiumAvailable = false;
let unavailable = "";
try {
  const { chromium } = await import("playwright");
  const probe = await chromium.launch();
  await probe.close();
  chromiumAvailable = true;
} catch (err) {
  unavailable = err instanceof Error ? err.message : String(err);
}

const dirs: string[] = [];
const sceneDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-scene-verify-"));
  dirs.push(dir);
  return dir;
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 2D canvas: deterministic pixels and no GPU/swiftshader dependency.
function sceneHtml(
  variant: "same" | "perturbed" | "blank",
  size: { width: number; height: number } = { width: 600, height: 400 },
): string {
  const main = variant === "perturbed" ? "#457b9d" : "#e63946";
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:3000px;background:#0b0d12}
#scene{position:fixed;left:40px;top:30px;width:${size.width}px;height:${size.height}px;display:block}
</style></head><body>
<canvas id="scene" width="${size.width}" height="${size.height}"></canvas>
<script>
const c = document.getElementById("scene");
const x = c.getContext("2d");
x.fillStyle = "#0d1b2a";
x.fillRect(0, 0, 600, 400);
if (!${JSON.stringify(variant === "blank")}) {
  x.fillStyle = ${JSON.stringify(main)};
  x.fillRect(40, 40, 240, 160);
  x.fillStyle = "#2a9d8f";
  x.fillRect(320, 60, 200, 200);
  x.fillStyle = "#e9c46a";
  x.beginPath();
  x.arc(160, 320, 60, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = "#8338ec";
  x.fillRect(340, 300, 180, 60);
}
</script>
</body></html>`;
}

// Same pixels as sceneHtml("same"), but with an absolutely positioned canvas
// at y=1100 so the capture only lines up when the build scrolls to 1100.
function scrollCanvasHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:3000px;background:#0b0d12}
#scene{position:absolute;left:40px;top:1100px;width:600px;height:400px;display:block}
</style></head><body>
<canvas id="scene" width="600" height="400"></canvas>
<script>
const c = document.getElementById("scene");
const x = c.getContext("2d");
x.fillStyle = "#0d1b2a";
x.fillRect(0, 0, 600, 400);
x.fillStyle = "#e63946";
x.fillRect(40, 40, 240, 160);
x.fillStyle = "#2a9d8f";
x.fillRect(320, 60, 200, 200);
x.fillStyle = "#e9c46a";
x.beginPath();
x.arc(160, 320, 60, 0, Math.PI * 2);
x.fill();
x.fillStyle = "#8338ec";
x.fillRect(340, 300, 180, 60);
</script>
</body></html>`;
}

// Snaps away from the replay position after the scroll event, the way a
// scroll-snap page can settle somewhere other than where it was sent.
function movingHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:3000px;background:#0b0d12}
#scene{position:fixed;left:40px;top:30px;width:600px;height:400px;display:block}
</style></head><body>
<canvas id="scene" width="600" height="400"></canvas>
<script>
const c = document.getElementById("scene");
const x = c.getContext("2d");
x.fillStyle = "#0d1b2a";
x.fillRect(0, 0, 600, 400);
x.fillStyle = "#e63946";
x.fillRect(40, 40, 240, 160);
x.fillStyle = "#2a9d8f";
x.fillRect(320, 60, 200, 200);
addEventListener("scroll", () => {
  if (Math.abs(window.scrollY - 1100) <= 2) window.scrollTo(0, 1360);
});
</script>
</body></html>`;
}

// Perturbed pixels plus page-level overrides of every decoding API. Metrics
// computed on this page would be falsified; the comparator page must not care.
function hijackedHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:3000px;background:#0b0d12}
#scene{position:fixed;left:40px;top:30px;width:600px;height:400px;display:block}
</style></head><body>
<canvas id="scene" width="600" height="400"></canvas>
<script>
const c = document.getElementById("scene");
const x = c.getContext("2d");
x.fillStyle = "#0d1b2a";
x.fillRect(0, 0, 600, 400);
x.fillStyle = "#457b9d";
x.fillRect(40, 40, 240, 160);
x.fillStyle = "#2a9d8f";
x.fillRect(320, 60, 200, 200);
x.fillStyle = "#e9c46a";
x.beginPath();
x.arc(160, 320, 60, 0, Math.PI * 2);
x.fill();
x.fillStyle = "#8338ec";
x.fillRect(340, 300, 180, 60);

// Adversarial page: try to make any in-page comparison report equality.
window.createImageBitmap = async () => ({
  width: 1,
  height: 1,
  close() {},
  [Symbol.toStringTag]: "ImageBitmap",
});
window.Image = class {};
window.OffscreenCanvas = class {
  constructor() {
    return { getContext: () => null, convertToBlob: async () => new Blob() };
  }
};
const nativeGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
  if (type === "2d") {
    return {
      drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      putImageData() {},
      createImageData: () => ({ data: new Uint8ClampedArray(4) }),
    };
  }
  return nativeGetContext.call(this, type, ...rest);
};
</script>
</body></html>`;
}


// Same pixels as sceneHtml("same"), but the first probe at scrollY 1050 starts
// a two-frame chain that moves the page to 1310 while the screenshot is taken.
function shotMoveHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:3000px;background:#0b0d12}
#scene{position:fixed;left:40px;top:30px;width:600px;height:400px;display:block}
</style></head><body>
<canvas id="scene" width="600" height="400"></canvas>
<script>
const c = document.getElementById("scene");
const x = c.getContext("2d");
x.fillStyle = "#0d1b2a";
x.fillRect(0, 0, 600, 400);
x.fillStyle = "#e63946";
x.fillRect(40, 40, 240, 160);
x.fillStyle = "#2a9d8f";
x.fillRect(320, 60, 200, 200);
x.fillStyle = "#e9c46a";
x.beginPath();
x.arc(160, 320, 60, 0, Math.PI * 2);
x.fill();
x.fillStyle = "#8338ec";
x.fillRect(340, 300, 180, 60);
const nativeRect = c.getBoundingClientRect.bind(c);
let scheduled = false;
c.getBoundingClientRect = () => {
  const rect = nativeRect();
  if (!scheduled && Math.abs(window.scrollY - 1050) <= 2) {
    scheduled = true;
    requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, 1310)));
  }
  return rect;
};
</script>
</body></html>`;
}

// The page settles at 1102 (2px from the reference), then drifts to 1104 while
// the screenshot is taken. Each adjacent gap is within 2px; only the comparison
// with the reference reveals the accumulated 4px drift.
function scrollDriftHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:3000px;background:#0b0d12}
#scene{position:fixed;left:40px;top:30px;width:600px;height:400px;display:block}
</style></head><body>
<canvas id="scene" width="600" height="400"></canvas>
<script>
const c = document.getElementById("scene");
const x = c.getContext("2d");
x.fillStyle = "#0d1b2a";
x.fillRect(0, 0, 600, 400);
x.fillStyle = "#e63946";
x.fillRect(40, 40, 240, 160);
x.fillStyle = "#2a9d8f";
x.fillRect(320, 60, 200, 200);
x.fillStyle = "#e9c46a";
x.beginPath();
x.arc(160, 320, 60, 0, Math.PI * 2);
x.fill();
x.fillStyle = "#8338ec";
x.fillRect(340, 300, 180, 60);
let nudged = false;
addEventListener("scroll", () => {
  if (!nudged && Math.abs(window.scrollY - 1100) <= 2) {
    nudged = true;
    window.scrollTo(0, 1102);
  }
});
const nativeRect = c.getBoundingClientRect.bind(c);
let scheduled = false;
c.getBoundingClientRect = () => {
  const rect = nativeRect();
  if (!scheduled && Math.abs(window.scrollY - 1102) <= 0) {
    scheduled = true;
    requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, 1104)));
  }
  return rect;
};
</script>
</body></html>`;
}

// A WebGL canvas that loses its context shortly after the replay scroll, i.e.
// after verify's pre-scroll context check and around the screenshot.
function loseContextHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:3000px;background:#0b0d12}
#scene{position:fixed;left:40px;top:30px;width:600px;height:400px;display:block}
</style></head><body>
<canvas id="scene" width="600" height="400"></canvas>
<script>
const c = document.getElementById("scene");
const gl = c.getContext("webgl", { preserveDrawingBuffer: true });
if (gl) {
  gl.clearColor(0.1, 0.25, 0.7, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
}
const ext = gl && gl.getExtension("WEBGL_lose_context");
let lost = false;
addEventListener("scroll", () => {
  if (!lost && Math.abs(window.scrollY - 1100) <= 2) {
    lost = true;
    setTimeout(() => { if (ext) ext.loseContext(); }, 20);
  }
});
</script>
</body></html>`;
}

// For capture-side stability: the first probe past the top starts a two-frame
// chain that scrolls away, so the post-screenshot re-probe must record it.
function captureMovingHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:3000px;background:#0b0d12}
#scene{position:fixed;left:40px;top:30px;width:600px;height:400px;display:block}
</style></head><body>
<canvas id="scene" width="600" height="400"></canvas>
<script>
const c = document.getElementById("scene");
const x = c.getContext("2d");
x.fillStyle = "#1d3557";
x.fillRect(0, 0, 600, 400);
x.fillStyle = "#e63946";
x.fillRect(80, 80, 200, 200);
const nativeRect = c.getBoundingClientRect.bind(c);
let scheduled = false;
c.getBoundingClientRect = () => {
  const rect = nativeRect();
  if (!scheduled && window.scrollY > 100) {
    scheduled = true;
    requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, 500)));
  }
  return rect;
};
</script>
</body></html>`;
}

interface Fixture {
  origin: string;
  close(): Promise<void>;
}

async function startFixture(): Promise<Fixture> {
  const pages = {
    "/reference.html": sceneHtml("same"),
    "/build-same.html": sceneHtml("same"),
    "/build-perturbed.html": sceneHtml("perturbed"),
    "/build-blank.html": sceneHtml("blank"),
    "/build-small.html": sceneHtml("same", { width: 300, height: 200 }),
    "/build-hijacked.html": hijackedHtml(),
    "/build-scroll-canvas.html": scrollCanvasHtml(),
    "/build-moves.html": movingHtml(),
    "/build-shot-move.html": shotMoveHtml(),
    "/build-scroll-drift.html": scrollDriftHtml(),
    "/build-lose-context.html": loseContextHtml(),
    "/capture-moving.html": captureMovingHtml(),
  } as const;
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname as keyof typeof pages;
    const body = pages[path];
    if (!body) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return {
    origin,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const tolerances = { pixelThreshold: 0.02, maxChangedFraction: 0.01 };

if (!chromiumAvailable && REQUIRED) {
  describe("scene3d verify Chromium", () => {
    it("launches Chromium", () => {
      throw new Error(
        `AWWWARDS_CHROMIUM_SMOKE=1 but Chromium is unavailable: ${unavailable || "playwright missing"}\n` +
          "Install it with: npm exec -- playwright install chromium",
      );
    });
  });
} else {
  const suite = chromiumAvailable ? describe : describe.skip;
  suite("scene3d verify Chromium", () => {
    let fixture: Fixture;
    let dir: string;
    let pack: SceneEvidence;

    // One reference pack for the whole suite: the capture path is already
    // covered by scene-capture.chromium.test.ts; here it is the input fixture.
    beforeAll(async () => {
      fixture = await startFixture();
      dir = sceneDir();
      const result = await captureScene3d(`${fixture.origin}/reference.html`, {
        allowPrivateOrigins: [fixture.origin],
        sceneDir: dir,
        includeViewportShots: false,
        checkpoints: [
          { scrollRatio: 0, waitMs: 200 },
          { scrollRatio: 1, waitMs: 200 },
        ],
      });
      if ("error" in result) throw new Error(result.error);
      pack = result;
    }, 120_000);

    afterAll(async () => {
      for (const entry of dirs.splice(0)) rmSync(entry, { recursive: true, force: true });
      if (fixture) await fixture.close();
    }, 60_000);

    const verify = (page: string, opts: { tolerances?: typeof tolerances; loader?: any } = {}) =>
      verifyScene3d({
        buildUrl: `${fixture.origin}/${page}`,
        referenceCaptureId: pack.captureId,
        buildSelector: "#scene",
        sceneDir: dir,
        allowPrivateOrigins: [fixture.origin],
        // Real pages and several parallel Chromium suites need more than the
        // 15s product default; the deadline itself is covered by unit tests.
        timeoutMs: 60_000,
        ...opts,
      });

    const webglLoader = async () => {
      const { chromium } = await import("playwright");
      return {
        chromium: {
          launch: (options: any) =>
            chromium.launch({
              ...options,
              args: [...(options?.args ?? []), "--enable-unsafe-swiftshader"],
            }),
        },
      };
    };

    // Rewrites the shared pack for one call, then restores it byte-for-byte.
    const withPatchedEvidence = async <T>(
      mutate: (evidence: any) => void,
      run: () => Promise<T>,
    ): Promise<T> => {
      const original = readFileSync(pack.paths.evidence, "utf8");
      const evidence = JSON.parse(original);
      mutate(evidence);
      writeFileSync(pack.paths.evidence, JSON.stringify(evidence));
      try {
        return await run();
      } finally {
        writeFileSync(pack.paths.evidence, original);
      }
    };

    // Reference packs captured by this suite always measured the position they
    // replay; requested 1260 vs actual 1100 isolates which one verify uses.
    const replayAt = (actual: number, waitMs = 200) => (evidence: any) => {
      for (const checkpoint of evidence.checkpoints) {
        checkpoint.requestedScrollRatio = 0.6;
        checkpoint.requestedScrollTop = actual + 160;
        checkpoint.actualScrollTop = actual;
        checkpoint.waitMs = waitMs;
      }
    };
    const replayAtActual = replayAt(1100);

    it(
      "identical build: comparable and within-tolerance with diff artifacts",
      { timeout: 90_000 },
      async () => {
        const result = await verify("build-same.html", { tolerances });
        if ("error" in result) throw new Error(result.error);

        expect(result.status).toBe("comparable");
        expect(result.verdict).toBe("within-tolerance");
        expect(result.requested).toBe(2);
        expect(result.compared).toBe(2);
        for (const checkpoint of result.checkpoints) {
          expect(checkpoint.status).toBe("comparable");
          expect(checkpoint.changedPixelFraction).toBe(0);
          expect(checkpoint.meanAbsoluteChannelError).toBe(0);
          // Camera state is never read, so it stays null with a stated reason.
          expect(checkpoint.cameraAngleDeg).toBeNull();
          expect(checkpoint.reasons.join(" ")).toContain("camera angle");
          expect(checkpoint.referenceImage).toContain("frame-0");
          expect(checkpoint.buildImage).toBeTruthy();
          expect(checkpoint.diffImage).toBeTruthy();
          const diff = readFileSync(checkpoint.diffImage!);
          expect(diff.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
          expect(existsSync(checkpoint.buildImage!)).toBe(true);
          expect(checkpoint.diffImage).toContain(join("verify"));
        }
        expect(result.limitations.join(" ")).toContain("Pixel comparison only");
      },
    );

    it(
      "perturbed colour: outside-tolerance",
      { timeout: 90_000 },
      async () => {
        const result = await verify("build-perturbed.html", { tolerances });
        if ("error" in result) throw new Error(result.error);

        expect(result.status).toBe("comparable");
        expect(result.verdict).toBe("outside-tolerance");
        expect(result.compared).toBe(2);
        // The repainted 240x160 block is 16% of the 600x400 canvas.
        for (const checkpoint of result.checkpoints) {
          expect(checkpoint.changedPixelFraction!).toBeGreaterThan(0.1);
          expect(checkpoint.meanAbsoluteChannelError!).toBeGreaterThan(0.01);
        }
      },
    );

    it(
      "blank build canvas: inconclusive, never a pass",
      { timeout: 90_000 },
      async () => {
        const result = await verify("build-blank.html", { tolerances });
        if ("error" in result) throw new Error(result.error);

        expect(result.status).toBe("inconclusive");
        expect(result.verdict).toBe("inconclusive");
        expect(result.compared).toBe(0);
        expect(result.checkpoints[0].reasons.join(" ")).toContain("blank");
        expect(result.coverage.status).toBe("unknown");
      },
    );

    it(
      "mismatched canvas dimensions: inconclusive, never a pass",
      { timeout: 90_000 },
      async () => {
        const result = await verify("build-small.html", { tolerances });
        if ("error" in result) throw new Error(result.error);

        expect(result.status).toBe("inconclusive");
        expect(result.verdict).toBe("inconclusive");
        expect(result.compared).toBe(0);
        // The backing-size guard fires before the screenshot; the decoded-PNG
        // dimension guard is the second line of defence.
        expect(result.checkpoints[0].reasons.join(" ")).toContain("backing size differs");
      },
    );

    it(
      "missing reference frame: that checkpoint is inconclusive, never comparable",
      { timeout: 90_000 },
      async () => {
        const framePath = pack.checkpoints[1].files.canvas;
        const parked = `${framePath}.parked`;
        renameSync(framePath, parked);
        try {
          const result = await verify("build-same.html", { tolerances });
          if ("error" in result) throw new Error(result.error);

          expect(result.status).toBe("inconclusive");
          expect(result.verdict).toBe("inconclusive");
          expect(result.requested).toBe(2);
          expect(result.compared).toBe(1);
          expect(result.checkpoints[0].status).toBe("comparable");
          expect(result.checkpoints[1].status).toBe("inconclusive");
          expect(result.checkpoints[1].reasons.join(" ")).toContain("missing or unreadable");
        } finally {
          renameSync(parked, framePath);
        }
      },
    );

    it(
      "no tolerances: metrics reported, verdict inconclusive",
      { timeout: 90_000 },
      async () => {
        const result = await verify("build-same.html");
        if ("error" in result) throw new Error(result.error);

        expect(result.status).toBe("comparable");
        expect(result.verdict).toBe("inconclusive");
        expect(result.checkpoints[0].changedPixelFraction).toBe(0);
        expect(result.limitations.join(" ")).toContain("No verdict inputs");
      },
    );

    it(
      "replays the reference actual scroll (1100), not its requested target (1260)",
      { timeout: 90_000 },
      async () => {
        const result = await withPatchedEvidence(replayAtActual, () =>
          verify("build-scroll-canvas.html", { tolerances }),
        );
        if ("error" in result) throw new Error(result.error);

        // The canvas only fills the 600x400 crop when scrolled to 1100; using
        // requested 1260 would move it and produce a dimension mismatch.
        expect(result.status).toBe("comparable");
        expect(result.verdict).toBe("within-tolerance");
        for (const checkpoint of result.checkpoints) {
          expect(checkpoint.changedPixelFraction).toBe(0);
        }
      },
    );

    it(
      "a build that scroll-snaps away after settle is inconclusive",
      { timeout: 90_000 },
      async () => {
        const result = await withPatchedEvidence(replayAtActual, () =>
          verify("build-moves.html", { tolerances }),
        );
        if ("error" in result) throw new Error(result.error);

        expect(result.status).toBe("inconclusive");
        expect(result.verdict).toBe("inconclusive");
        expect(result.compared).toBe(0);
        expect(result.checkpoints[0].reasons.join(" ")).toContain(
          "scroll position differs after settle",
        );
      },
    );

    it(
      "build-page decoding overrides cannot falsify the metrics",
      { timeout: 90_000 },
      async () => {
        const result = await verify("build-hijacked.html", { tolerances });
        if ("error" in result) throw new Error(result.error);

        // The page perturbs a 240x160 block and overrides createImageBitmap,
        // Image, OffscreenCanvas and getContext to fake equality. An isolated
        // comparator reads the real PNGs, so the change is still visible.
        expect(result.status).toBe("comparable");
        expect(result.verdict).toBe("outside-tolerance");
        for (const checkpoint of result.checkpoints) {
          expect(checkpoint.changedPixelFraction!).toBeGreaterThan(0.1);
        }
      },
    );

    it(
      "scroll that moves from 1050 to 1310 during the screenshot is inconclusive",
      { timeout: 90_000 },
      async () => {
        const result = await withPatchedEvidence(replayAt(1050, 0), () =>
          verify("build-shot-move.html", { tolerances }),
        );
        if ("error" in result) throw new Error(result.error);

        // Identical pixels at the target position, but the page moves while the
        // frame is being captured; the post-screenshot re-probe must reject it.
        expect(result.status).toBe("inconclusive");
        expect(result.verdict).toBe("inconclusive");
        expect(result.checkpoints[0].status).toBe("inconclusive");
        expect(result.checkpoints[0].reasons.join(" ")).toContain(
          "moved during the screenshot",
        );
      },
    );

    it(
      "scroll drift 1100 to 1102 to 1104 is inconclusive at 2px tolerance",
      { timeout: 90_000 },
      async () => {
        const result = await withPatchedEvidence(replayAt(1100, 100), () =>
          verify("build-scroll-drift.html", {
            tolerances: { pixelThreshold: 0.05, maxChangedFraction: 0.02 },
          }),
        );
        if ("error" in result) throw new Error(result.error);

        // Pre-shot 1102 is within 2px of the reference and post-shot 1104 is
        // within 2px of pre-shot, but post-shot is 4px from the reference. The
        // pixels are identical, so only the accumulated-tolerance check fails.
        expect(result.status).toBe("inconclusive");
        expect(result.verdict).toBe("inconclusive");
        expect(result.checkpoints[0].status).toBe("inconclusive");
        expect(result.checkpoints[0].changedPixelFraction).toBeNull();
        expect(result.checkpoints[0].reasons.join(" ")).toContain(
          "drifted away from the reference",
        );
      },
    );

    it(
      "WebGL context loss after the initial check is inconclusive even with maxChangedFraction 1",
      { timeout: 90_000 },
      async () => {
        const result = await withPatchedEvidence(replayAtActual, () =>
          verify("build-lose-context.html", {
            tolerances: { pixelThreshold: 0, maxChangedFraction: 1 },
            loader: webglLoader,
          }),
        );
        if ("error" in result) throw new Error(result.error);

        expect(result.status).toBe("inconclusive");
        expect(result.verdict).toBe("inconclusive");
        expect(result.compared).toBe(0);
        expect(result.checkpoints[0].reasons.join(" ")).toContain(
          "lost its WebGL context",
        );
      },
    );

    it(
      "capture records a frame whose scroll moves during the screenshot as unstable",
      { timeout: 90_000 },
      async () => {
        const captureDir = sceneDir();
        const result = await captureScene3d(`${fixture.origin}/capture-moving.html`, {
          allowPrivateOrigins: [fixture.origin],
          sceneDir: captureDir,
          includeViewportShots: false,
          checkpoints: [
            { scrollRatio: 0, waitMs: 100 },
            { scrollRatio: 1, waitMs: 100 },
          ],
        });
        if ("error" in result) throw new Error(result.error);

        expect(result.checkpoints[0].stable).toBe(true);
        expect(result.checkpoints[1].stable).toBe(false);
        expect(result.checkpoints[1].stabilityReason).toContain("moved during the screenshot");
      },
    );
  });
}
