import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordSiteMotion } from "../src/motion.js";

const dirs: string[] = [];
const tmpDir = () => {
  const d = mkdtempSync(join(tmpdir(), "awwwards-motion-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const URL_UNDER_TEST = "https://example.com";
const hashOf = (url: string) => createHash("sha1").update(url).digest("hex").slice(0, 10);

// Fake playwright whose page records the recording-pass calls (mirrors
// capture.test.ts's recordingFake). The evaluate fake dispatches on the
// snippet source like a mini browser: target discovery returns hover
// targets, the tour-height probe returns a page height, elementFromPoint
// lookups return a hit-box; everything else (cursor injection, pre-scroll,
// return-to-top) returns undefined. Arg-carrying evaluates (scroll steps,
// hit-box probes, cursor moves) are recorded without dispatching.
function fakeChromium(
  calls: string[],
  mouse: { down: number; up: number },
  contextOpts: any[],
) {
  const page = {
    goto: async (_u: string, o: any) => {
      calls.push("goto:" + o.waitUntil);
    },
    waitForTimeout: async (ms: number) => {
      calls.push("wait:" + ms);
    },
    evaluate: async (fn: any, arg?: any) => {
      const src = String(fn);
      // Hit-box lookups carry an argument AND need a dispatched return, so
      // they are matched by source before the arg-carrying fallback.
      if (src.includes("querySelectorAll")) {
        calls.push("eval:discover");
        return [
          { x: 60, y: 300, safeClick: true },
          { x: 400, y: 700, safeClick: false },
        ];
      }
      if (src.includes("elementFromPoint")) {
        calls.push("eval:box");
        return { x: 60, y: 120 };
      }
      if (arg !== undefined) {
        calls.push("eval:arg");
        return undefined;
      }
      if (src.includes("body.scrollHeight")) {
        calls.push("eval:height");
        return 1200;
      }
      calls.push("eval:page");
      return undefined;
    },
    mouse: {
      move: async () => {
        calls.push("mouse:move");
      },
      down: async () => {
        mouse.down++;
      },
      up: async () => {
        mouse.up++;
      },
    },
  };
  return {
    launch: async () => ({
      newContext: async (opts: any) => {
        contextOpts.push(opts);
        return {
          newPage: async () => page,
          close: async () => {
            calls.push("context:close");
          },
        };
      },
      close: async () => {},
    }),
  };
}

describe("recordSiteMotion", () => {
  it("records the tour, extracts a filmstrip, and returns file + base64", async () => {
    const dir = tmpDir();
    const calls: string[] = [];
    const mouse = { down: 0, up: 0 };
    const contextOpts: any[] = [];
    // Pre-write the webm the fake browser "flushes" on context.close(): the
    // implementation globs *.webm out of the recordVideo tmp dir after close
    // and renames it to its URL-keyed name.
    const videoTmp = join(dir, ".video-tmp");
    mkdirSync(videoTmp, { recursive: true });
    writeFileSync(join(videoTmp, "recording.webm"), "fake-webm");

    const ffmpegCalls: Array<{ bin: string; video: string; strip: string; frames: number }> = [];
    const res = await recordSiteMotion(URL_UNDER_TEST, {
      cacheImagesDir: dir,
      loader: async () => ({ chromium: fakeChromium(calls, mouse, contextOpts) }),
      ffmpegPath: "ffmpeg-stub-bin",
      ffmpegFn: async (bin, video, strip, frames) => {
        ffmpegCalls.push({ bin, video, strip, frames });
        const fs = await import("node:fs/promises");
        await fs.writeFile(strip, Buffer.from("strip-jpeg"));
      },
    });

    expect("error" in res).toBe(false);
    if ("error" in res) return;
    const hash = hashOf(URL_UNDER_TEST);
    expect(res.file).toBe(join(dir, `motion-${hash}.webm`));
    expect(res.frames).toBe(16); // default grid
    expect(res.base64).toBe(Buffer.from("strip-jpeg").toString("base64"));
    // The pre-written webm was renamed into place; the tmp dir is drained.
    expect(existsSync(res.file)).toBe(true);
    expect(readdirSync(videoTmp).length).toBe(0);
    // ffmpeg received the renamed video and the strip target, default 16
    // frames, with the binary path passed through untouched.
    expect(ffmpegCalls).toEqual([
      {
        bin: "ffmpeg-stub-bin",
        video: res.file,
        strip: join(dir, `motion-${hash}-strip.jpg`),
        frames: 16,
      },
    ]);
    expect(existsSync(join(dir, `motion-${hash}-strip.jpg`))).toBe(true);
    // The recordVideo context points at the tmp dir with the capture viewport.
    expect(contextOpts[0].recordVideo.dir).toBe(videoTmp);
    expect(contextOpts[0].viewport).toEqual({ width: 1440, height: 900 });
    // Flow shape: goto(load) → 5s preloader dwell → pre-scroll → scroll tour
    // (350ms steps) → discovery → hover tour (500ms dwells, one safe click)
    // → return to top → context.close() flush.
    expect(calls[0]).toBe("goto:load");
    expect(calls[1]).toBe("wait:5000");
    expect(calls.indexOf("eval:page")).toBeGreaterThan(calls.indexOf("wait:5000")); // preScroll after dwell
    expect(calls.indexOf("eval:discover")).toBeGreaterThan(calls.indexOf("eval:page")); // discovery after pre-render
    expect(calls.filter((c) => c === "eval:height").length).toBe(1); // tour height probe
    expect(calls.filter((c) => c === "wait:350").length).toBe(3); // 1200px page / 450px steps
    expect(calls.filter((c) => c === "wait:250").length).toBe(2); // into-view settle per target
    expect(calls.filter((c) => c === "wait:500").length).toBe(2); // hover dwell per target
    expect(calls.filter((c) => c === "wait:650").length).toBe(1); // click settle (one safe target)
    expect(mouse.down).toBe(1); // only the safeClick target is clicked
    expect(mouse.up).toBe(1);
    expect(calls[calls.length - 2]).toBe("wait:1500"); // ends back at the top
    expect(calls[calls.length - 1]).toBe("context:close"); // flush point
  });

  it("returns the ffmpeg hint without launching a browser when ffmpeg is missing", async () => {
    const dir = tmpDir();
    let loaderCalls = 0;
    const res = await recordSiteMotion(URL_UNDER_TEST, {
      cacheImagesDir: dir,
      loader: async () => {
        loaderCalls++;
        return { chromium: {} };
      },
      ffmpegPath: null,
    });
    expect("error" in res).toBe(true);
    if (!("error" in res)) return;
    expect(res.error).toContain("ffmpeg-static");
    expect(res.error).toContain("npm install");
    expect(loaderCalls).toBe(0); // fail-fast: a missing binary never pays for a launch
  });

  it("returns the capture install hint when playwright is missing", async () => {
    const dir = tmpDir();
    const res = await recordSiteMotion(URL_UNDER_TEST, {
      cacheImagesDir: dir,
      loader: async () => {
        throw new Error("Cannot find package 'playwright'");
      },
      ffmpegPath: "ffmpeg-stub-bin",
    });
    expect("error" in res).toBe(true);
    if (!("error" in res)) return;
    expect(res.error).toContain("npx playwright install chromium");
  });
});
