import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
// flushVideo, when given, runs on context.close() — the point where a real
// context flushes its .webm into the (per-call) recordVideo dir.
// capturedEvals, when given, collects the serialized discovery callback and
// its forwarded argument ({ fn, arg }) so a test can execute it against a
// DOM stub (browser scripts must not close over Node-scope bindings).
function fakeChromium(
  calls: string[],
  mouse: { down: number; up: number },
  contextOpts: any[],
  flushVideo?: (recordVideoDir: string) => void,
  capturedEvals?: Array<{ fn: any; arg?: any }>,
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
        capturedEvals?.push({ fn, arg });
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
        const recordVideoDir: string = opts?.recordVideo?.dir;
        return {
          newPage: async () => page,
          close: async () => {
            calls.push("context:close");
            flushVideo?.(recordVideoDir); // the flush point
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
    // The fake browser "flushes" its own .webm into the per-call recordVideo
    // dir on context.close(): the implementation globs *.webm out of that dir
    // and renames it to its URL-keyed name.
    const ffmpegCalls: Array<{ bin: string; video: string; strip: string; frames: number }> = [];
    const res = await recordSiteMotion(URL_UNDER_TEST, {
      cacheImagesDir: dir,
      loader: async () =>
        ({ chromium: fakeChromium(calls, mouse, contextOpts, (recDir) => {
          writeFileSync(join(recDir, "recording.webm"), "fake-webm");
        }) }),
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
    // The flushed webm was renamed into place; the per-call tmp dir is gone.
    expect(existsSync(res.file)).toBe(true);
    expect(readFileSync(res.file, "utf8")).toBe("fake-webm");
    const recordVideoDir: string = contextOpts[0].recordVideo.dir;
    expect(existsSync(recordVideoDir)).toBe(false);
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
    // The recordVideo context points at a per-call tmp dir (mkdtemp under
    // cacheImagesDir, NOT a shared fixed dir) with the capture viewport.
    expect(recordVideoDir.startsWith(join(dir, ".video-tmp-"))).toBe(true);
    expect(contextOpts[0].viewport).toEqual({ width: 1440, height: 900 });
    // Flow shape: goto(load) → 4s preloader dwell → pre-scroll → scroll tour
    // (350ms steps) → discovery → hover tour (500ms dwells, one safe click)
    // → return to top → context.close() flush.
    expect(calls[0]).toBe("goto:load");
    expect(calls[1]).toBe("wait:4000");
    expect(calls.indexOf("eval:page")).toBeGreaterThan(calls.indexOf("wait:4000")); // preScroll after dwell
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

  it("discovery script is page-safe: hover cap arrives as an evaluate argument, not a Node-scope free identifier", async () => {
    // Regression: the discovery callback used to reference the module
    // constant MAX_HOVER_TARGETS directly — page.evaluate serializes the
    // callback into the browser, where that binding does not exist, so every
    // real recording died with "ReferenceError: MAX_HOVER_TARGETS is not
    // defined". The cap must be passed as an evaluate argument instead.
    const dir = tmpDir();
    const calls: string[] = [];
    const capturedEvals: Array<{ fn: any; arg?: any }> = [];
    const res = await recordSiteMotion(URL_UNDER_TEST, {
      cacheImagesDir: dir,
      loader: async () => ({
        chromium: fakeChromium(calls, { down: 0, up: 0 }, [], (recDir) => {
          writeFileSync(join(recDir, "recording.webm"), "fake-webm");
        }, capturedEvals),
      }),
      ffmpegPath: "ffmpeg-stub-bin",
      ffmpegFn: async (_bin, _video, strip) => {
        const fs = await import("node:fs/promises");
        await fs.writeFile(strip, Buffer.from("strip-jpeg"));
      },
    });
    expect("error" in res).toBe(false);
    expect(capturedEvals.length).toBe(1);
    // The hover-target cap is forwarded as the evaluate argument (the
    // documented MAX_HOVER_TARGETS of 12) — NOT referenced as a free identifier.
    const { fn, arg } = capturedEvals[0];
    expect(arg).toBe(12);
    // Execute the serialized discovery callback against a minimal DOM stub —
    // with no Node-scope bindings in reach, exactly as in the browser.
    const g = globalThis as any;
    const link = {
      tagName: "A",
      parentElement: null,
      getBoundingClientRect: () => ({ top: 100, left: 20, width: 80, height: 32 }),
      getAttribute: (name: string) => (name === "href" ? "#section" : null),
    };
    const saved = {
      scrollY: g.scrollY,
      getComputedStyle: g.getComputedStyle,
      document: g.document,
    };
    g.scrollY = 0;
    g.getComputedStyle = () => ({ cursor: "pointer" });
    g.document = { body: { scrollHeight: 1200 }, querySelectorAll: () => [link] };
    try {
      const spread = await fn(arg);
      expect(spread).toEqual([{ x: 60, y: 116, safeClick: true }]);
    } finally {
      g.scrollY = saved.scrollY;
      g.getComputedStyle = saved.getComputedStyle;
      g.document = saved.document;
    }
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

  it("isolates the per-call tmp dir: a decoy webm in the shared parent location is never picked up", async () => {
    const dir = tmpDir();
    const calls: string[] = [];
    const mouse = { down: 0, up: 0 };
    const contextOpts: any[] = [];
    // Decoy exactly where a naive shared-dir glob would find it: a stale
    // partial video left behind by an earlier failed run (or a concurrent
    // run) in a fixed shared tmp location.
    const staleDir = join(dir, ".video-tmp");
    mkdirSync(staleDir, { recursive: true });
    const decoy = join(staleDir, "stale.webm");
    writeFileSync(decoy, "decoy-webm");

    const res = await recordSiteMotion(URL_UNDER_TEST, {
      cacheImagesDir: dir,
      loader: async () => ({
        chromium: fakeChromium(calls, mouse, contextOpts, (recDir) => {
          // This run's fake flushes its OWN video into its per-call dir.
          writeFileSync(join(recDir, "fresh.webm"), "fresh-webm");
        }),
      }),
      ffmpegPath: "ffmpeg-stub-bin",
      ffmpegFn: async (_bin, _video, strip) => {
        const fs = await import("node:fs/promises");
        await fs.writeFile(strip, Buffer.from("strip-jpeg"));
      },
    });

    expect("error" in res).toBe(false);
    if ("error" in res) return;
    // The returned file is THIS call's video, not the decoy.
    expect(readFileSync(res.file, "utf8")).toBe("fresh-webm");
    // The per-call tmp dir no longer exists after the run...
    const recordVideoDir: string = contextOpts[0].recordVideo.dir;
    expect(recordVideoDir).not.toBe(staleDir);
    expect(existsSync(recordVideoDir)).toBe(false);
    // ...and the decoy in the shared parent location is left untouched.
    expect(readFileSync(decoy, "utf8")).toBe("decoy-webm");
  });

  it("stale-tmp sweep is age-guarded: a concurrent run's young tmp dir survives, a leaked old one is swept", async () => {
    const dir = tmpDir();
    const calls: string[] = [];
    const mouse = { down: 0, up: 0 };
    const contextOpts: any[] = [];
    // "Concurrent" run: a .video-tmp-* dir written moments ago must survive
    // the sweep — deleting it would starve that in-flight recording.
    const liveDir = join(dir, ".video-tmp-live");
    mkdirSync(liveDir, { recursive: true });
    const liveVideo = join(liveDir, "in-flight.webm");
    writeFileSync(liveVideo, "in-flight-webm");
    // Leaked run: a tmp dir backdated past the sweep threshold must be swept.
    const oldDir = join(dir, ".video-tmp-old");
    mkdirSync(oldDir, { recursive: true });
    const ninety = new Date(Date.now() - 90 * 60_000);
    utimesSync(oldDir, ninety, ninety);

    const res = await recordSiteMotion(URL_UNDER_TEST, {
      cacheImagesDir: dir,
      loader: async () => ({
        chromium: fakeChromium(calls, mouse, contextOpts, (recDir) => {
          writeFileSync(join(recDir, "fresh.webm"), "fresh-webm");
        }),
      }),
      ffmpegPath: "ffmpeg-stub-bin",
      ffmpegFn: async (_bin, _video, strip) => {
        const fs = await import("node:fs/promises");
        await fs.writeFile(strip, Buffer.from("strip-jpeg"));
      },
    });

    expect("error" in res).toBe(false);
    if ("error" in res) return;
    // The concurrent run's dir and video survive the sweep...
    expect(existsSync(liveDir)).toBe(true);
    expect(readFileSync(liveVideo, "utf8")).toBe("in-flight-webm");
    // ...while the leaked 90-minute-old dir is gone.
    expect(existsSync(oldDir)).toBe(false);
  });

  it("uses the mobile viewport profile when opts.viewport is mobile", async () => {
    const dir = tmpDir();
    const calls: string[] = [];
    const contextOpts: any[] = [];
    const res = await recordSiteMotion(URL_UNDER_TEST, {
      cacheImagesDir: dir,
      loader: async () => ({
        chromium: fakeChromium(calls, { down: 0, up: 0 }, contextOpts, (recDir) => {
          writeFileSync(join(recDir, "recording.webm"), "fake-webm");
        }),
      }),
      ffmpegPath: "ffmpeg-stub-bin",
      ffmpegFn: async (_bin, _video, strip) => {
        const fs = await import("node:fs/promises");
        await fs.writeFile(strip, Buffer.from("strip-jpeg"));
      },
      viewport: "mobile",
    });
    expect("error" in res).toBe(false);
    expect(contextOpts).toHaveLength(1);
    // The profile is SPLIT into newContext: width/height land in the
    // `viewport` key, the mobile flags are sibling context options.
    expect(contextOpts[0]).toMatchObject({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    // The existing context fields survive the spread untouched, and the video
    // canvas is derived from the same profile: a mobile recording films the
    // 390x844 viewport onto a matching 390x844 canvas (no pillarboxing).
    expect(contextOpts[0].recordVideo).toMatchObject({ size: { width: 390, height: 844 } });
    expect(typeof contextOpts[0].recordVideo.dir).toBe("string");
  });

  it("defaults to the desktop viewport, preserving the existing context fields (no mobile flags)", async () => {
    const dir = tmpDir();
    const calls: string[] = [];
    const contextOpts: any[] = [];
    const res = await recordSiteMotion(URL_UNDER_TEST, {
      cacheImagesDir: dir,
      loader: async () => ({
        chromium: fakeChromium(calls, { down: 0, up: 0 }, contextOpts, (recDir) => {
          writeFileSync(join(recDir, "recording.webm"), "fake-webm");
        }),
      }),
      ffmpegPath: "ffmpeg-stub-bin",
      ffmpegFn: async (_bin, _video, strip) => {
        const fs = await import("node:fs/promises");
        await fs.writeFile(strip, Buffer.from("strip-jpeg"));
      },
    });
    expect("error" in res).toBe(false);
    expect(contextOpts).toHaveLength(1);
    // Desktop default: exact viewport, recordVideo canvas unchanged at
    // 1440x900 (derived from the same desktop profile), and no mobile flags
    // injected into the context.
    expect(contextOpts[0].viewport).toEqual({ width: 1440, height: 900 });
    expect(contextOpts[0].recordVideo).toMatchObject({ size: { width: 1440, height: 900 } });
    expect(typeof contextOpts[0].recordVideo.dir).toBe("string");
    expect(contextOpts[0].deviceScaleFactor).toBeUndefined();
    expect(contextOpts[0].isMobile).toBeUndefined();
    expect(contextOpts[0].hasTouch).toBeUndefined();
  });
});
