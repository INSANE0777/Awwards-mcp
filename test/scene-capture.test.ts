import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer as createTcpServer, connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadSceneAssets } from "../src/scene-assets.js";
import {
  SCENE_CANVAS_PICK,
  SCENE_HINTS,
  SCENE_PROBE,
  SCENE_READ,
  SCENE_SCROLL,
  SCENE_SPECTOR_PROBE,
  SCENE_THREE_PROBE,
  SCENE_LIMITS,
  SPECTOR_INSTALL_HINT,
  THREE_PROBE_CAPS,
  captureScene3d,
  classifySceneResource,
  createSceneUrlGate,
  isPrivateAddress,
  loadSpectorBundle,
  normalizeSceneAdapters,
  normalizeSceneAssetOrigins,
  normalizeSceneCheckpoints,
  normalizeScenePrivateOrigins,
  parseConnectAuthority,
  redactSceneUrl,
  sceneCanvasClip,
  sceneConnectOrigin,
  spectorInitScript,
  spectorFromProbe,
  spectorProbeCaps,
  startSceneProxy,
  summarizeSceneEvidence,
  type SceneDial,
  type SceneThreeProbeCaps,
  type SceneUrlGate,
} from "../src/scene-capture.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-scene-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

// Literal private hosts resolve to themselves, everything else to a public
// address. No DNS lookup ever runs in these tests.
const resolveHost = async (host: string): Promise<string[]> => {
  if (host === "private.test") return ["10.0.0.5"];
  // Only a literal IP resolves to itself; hostnames are not IP addresses.
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ? [host] : ["93.184.216.34"];
};

interface ResponseLike {
  url: string;
  mime: string;
  length?: number;
  type?: string;
}

function response({ url, mime, length, type = "other" }: ResponseLike): any {
  return {
    url: () => url,
    headers: async () => ({
      "content-type": mime,
      ...(length === undefined ? {} : { "content-length": String(length) }),
    }),
    request: () => ({ resourceType: () => type }),
  };
}

function fakePage(opts: {
  pick?: Record<string, unknown>;
  probe?: (arg: any, call: number) => Record<string, unknown>;
  hints?: Record<string, unknown>;
  three?: Record<string, unknown> | (() => Record<string, unknown>);
  spector?: Record<string, unknown> | (() => any);
  responses?: ResponseLike[];
  image?: Buffer;
  onScreenshot?: (shot: any, index: number) => Buffer;
  onGoto?: () => Promise<void> | void;
  hangEvaluate?: boolean;
} = {}) {
  const calls = {
    evaluates: [] as Array<{ name: string; arg: any }>,
    shots: [] as any[],
    mouse: [] as Array<{ x: number; y: number }>,
    scrolls: [] as Array<{ scrollRoot: string; top: number }>,
    initScripts: [] as string[],
    order: [] as string[],
    route: null as null | ((route: any) => Promise<void>),
    pageHandler: null as null | ((page: any) => void),
    launch: null as any,
    contextOptions: null as any,
    closed: false,
    contextClosed: false,
  };
  let actualScroll = 0;
  let probeCalls = 0;
  const page: any = {
    setDefaultTimeout: () => {},
    addInitScript: async (script: any) => {
      calls.initScripts.push(typeof script === "string" ? script : String(script?.content ?? ""));
      calls.order.push("init");
    },
    on: (event: string, handler: (res: any) => void) => {
      if (event !== "response") return;
      page.goto = async () => {
        calls.order.push("goto");
        for (const res of opts.responses ?? []) {
          const headers: Record<string, string> = { "content-type": res.mime };
          if (res.length !== undefined) headers["content-length"] = String(res.length);
          handler({
            url: () => res.url,
            headers: async () => headers,
            request: () => ({ resourceType: () => res.type ?? "other" }),
          });
        }
        if (opts.onGoto) await opts.onGoto();
      };
    },
    goto: async () => {
      calls.order.push("goto");
      if (opts.onGoto) await opts.onGoto();
    },
    waitForTimeout: async () => {},
    mouse: {
      move: async (x: number, y: number) => {
        calls.mouse.push({ x, y });
      },
    },
    evaluate: async (fn: any, arg: any) => {
      if (opts.hangEvaluate) return new Promise(() => {});
      const name = String(fn?.name ?? "anon");
      calls.evaluates.push({ name, arg });
      if (fn === SCENE_CANVAS_PICK) {
        return {
          canvases: 1,
          selector: 'canvas[data-awwwards-scene-canvas="1"]',
          rect: { x: 0, y: 0, width: 800, height: 600 },
          backing: { width: 1600, height: 1200 },
          dpr: 2,
          problem: "",
          ...opts.pick,
        };
      }
      if (fn === SCENE_HINTS) {
        return {
          threeRevision: "170",
          babylonVersion: null,
          playcanvasVersion: null,
          scripts: ["https://cdn.example.com/three.module.js?x=1"],
          canvasCount: 1,
          ...opts.hints,
        };
      }
      if (fn === SCENE_THREE_PROBE) {
        if (typeof opts.three === "function") return opts.three();
        return (
          opts.three ?? {
            available: false,
            reason: "no reachable three objects were found",
            revision: null,
            scene: null,
            camera: null,
            cameras: [],
            lights: [],
            controls: null,
          }
        );
      }
      if (fn === SCENE_SPECTOR_PROBE) {
        if (typeof opts.spector === "function") return opts.spector();
        return opts.spector ?? { error: "the spectorjs bundle did not load" };
      }
      if (fn === SCENE_PROBE) {
        probeCalls += 1;
        return {
          canvasFound: true,
          rect: { x: 0, y: 0, width: 800, height: 600 },
          backing: { width: 1600, height: 1200 },
          dpr: 2,
          scroll: { top: actualScroll, range: 2000 },
          scrollRootFound: true,
          ...(opts.probe?.(arg, probeCalls) ?? {}),
        };
      }
      if (fn === SCENE_SCROLL) {
        calls.scrolls.push(arg);
        actualScroll = arg.top;
        return actualScroll;
      }
      if (fn === SCENE_READ) return actualScroll;
      throw new Error(`unexpected evaluate ${name}`);
    },
    screenshot: async (shot: any) => {
      const index = calls.shots.length;
      calls.shots.push(shot);
      return opts.onScreenshot ? opts.onScreenshot(shot, index) : (opts.image ?? PNG);
    },
    close: async () => {},
  };
  const context = {
    route: async (_pattern: string, handler: (route: any) => Promise<void>) => {
      calls.route = handler;
    },
    on: (event: string, handler: (page: any) => void) => {
      if (event === "page") calls.pageHandler = handler;
    },
    newPage: async () => page,
    close: async () => {
      calls.contextClosed = true;
    },
  };
  const browser = {
    newContext: async (options: any) => {
      calls.contextOptions = options;
      return context;
    },
    close: async () => {
      calls.closed = true;
    },
  };
  const loader = async () => ({
    chromium: {
      launch: async (options: any) => {
        calls.launch = options;
        return browser;
      },
    },
  });
  return { page, context, loader, calls };
}

const RUN = (sceneDir: string, extra: Record<string, unknown> = {}) => ({
  loader: fakePage().loader,
  resolveHost,
  sceneDir,
  ...extra,
});

interface TcpFixture {
  port: number;
  hits: number;
  sockets: Socket[];
  close(): Promise<void>;
}

async function startTcpServer(): Promise<TcpFixture> {
  const sockets: Socket[] = [];
  let hits = 0;
  const server = createTcpServer((socket) => {
    hits += 1;
    sockets.push(socket);
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => socket.write(chunk));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    get hits() {
      return hits;
    },
    sockets,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Raw CONNECT through the real proxy; resolves with the response status. */
function openTunnel(proxyPort: number, authority: string): Promise<{ socket: Socket; status: number }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port: proxyPort });
    socket.on("error", () => undefined); // late resets after the status line are expected
    socket.once("error", reject);
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      resolve({ socket, status: Number(buffer.slice(0, end).split(" ")[1]) });
    };
    socket.on("data", onData);
    socket.once("connect", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
  });
}

function portAccepts(port: number, ms = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, ms);
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function originsOf(input: string[]): string[] {
  const normalized = normalizeScenePrivateOrigins(input);
  if ("error" in normalized) throw new Error(normalized.error);
  return normalized.origins;
}

describe("isPrivateAddress", () => {
  it("rejects loopback, link-local, RFC1918, CGNAT, metadata and reserved IPv4", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.0.2.10",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.7",
      "203.0.113.9",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
  });

  it("rejects loopback, unique-local, link-local, multicast and embedded IPv4", () => {
    for (const address of [
      "::",
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "64:ff9b::192.168.1.1",
      "2002:0a00:0001::1",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("fails closed for unparseable addresses", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

describe("redactSceneUrl and classification", () => {
  it("keeps origin+pathname and strips query, hash and credentials", () => {
    expect(redactSceneUrl("https://user:pass@cdn.example.com/a/b.png?token=secret#frag")).toBe(
      "https://cdn.example.com/a/b.png",
    );
  });

  it("classifies by MIME and path only", () => {
    expect(classifySceneResource("image/png", "https://x.test/textures/rock.png")).toBe("texture");
    expect(classifySceneResource("image/png", "https://x.test/photo.png")).toBe("image");
    expect(classifySceneResource("model/gltf-binary", "https://x.test/scene.glb")).toBe("model");
    expect(classifySceneResource("application/octet-stream", "https://x.test/env.hdr")).toBe("hdr");
    expect(classifySceneResource("text/plain", "https://x.test/shader.frag")).toBe("shader");
    expect(classifySceneResource("text/javascript", "https://x.test/app.js")).toBe("script");
    expect(classifySceneResource("font/woff2", "https://x.test/font.woff2")).toBe("font");
    expect(classifySceneResource("application/json", "https://x.test/data.json")).toBe("other");
  });
});

describe("normalizeSceneCheckpoints", () => {
  it("defaults to six evenly spaced checkpoints", () => {
    const result = normalizeSceneCheckpoints();
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.checkpoints.map((cp) => cp.scrollRatio)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(result.checkpoints[0].waitMs).toBe(SCENE_LIMITS.defaultWaitMs);
    expect(result.checkpoints[0].pointer).toBeNull();
  });

  it("caps waitMs at 2000 and rejects bad ratios or more than 10 checkpoints", () => {
    const capped = normalizeSceneCheckpoints([
      { scrollRatio: 0.5, pointer: { x: 1, y: 0 }, waitMs: 99_999 },
    ]);
    expect("error" in capped).toBe(false);
    if (!("error" in capped)) {
      expect(capped.checkpoints[0].waitMs).toBe(SCENE_LIMITS.maxWaitMs);
      expect(capped.checkpoints[0].pointer).toEqual({ x: 1, y: 0 });
    }
    expect(normalizeSceneCheckpoints([{ scrollRatio: 1.5 }])).toHaveProperty("error");
    expect(normalizeSceneCheckpoints([{ scrollRatio: 0, pointer: { x: 2, y: 0 } }])).toHaveProperty(
      "error",
    );
    expect(
      normalizeSceneCheckpoints(Array.from({ length: 11 }, () => ({ scrollRatio: 0 }))),
    ).toHaveProperty("error");
  });
});

describe("normalizeSceneAssetOrigins", () => {
  it("dedupes origins and enforces the 8-origin cap", () => {
    const result = normalizeSceneAssetOrigins([
      "https://cdn.example.com/a.png",
      "https://cdn.example.com/b.png",
      "http://other.test/x",
    ]);
    expect(result).toEqual({ origins: ["https://cdn.example.com", "http://other.test"] });
    expect(normalizeSceneAssetOrigins(["ftp://files.test/x"])).toHaveProperty("error");
    expect(
      normalizeSceneAssetOrigins(
        Array.from({ length: 9 }, (_, i) => `https://cdn${i}.example.com`),
      ),
    ).toHaveProperty("error");
  });
});

describe("normalizeSceneAdapters", () => {
  it("accepts the two opt-in adapters at most once each", () => {
    expect(normalizeSceneAdapters()).toEqual({ adapters: [] });
    expect(normalizeSceneAdapters([])).toEqual({ adapters: [] });
    expect(normalizeSceneAdapters(["three"])).toEqual({ adapters: ["three"] });
    expect(normalizeSceneAdapters(["spector"])).toEqual({ adapters: ["spector"] });
    expect(normalizeSceneAdapters(["three", "spector"])).toEqual({
      adapters: ["three", "spector"],
    });
    expect(normalizeSceneAdapters(["spector", "three"])).toEqual({
      adapters: ["spector", "three"],
    });
    expect(normalizeSceneAdapters(["three", "three"])).toHaveProperty("error");
    expect(normalizeSceneAdapters(["spector", "spector"])).toHaveProperty("error");
    expect(normalizeSceneAdapters(["three", "spector", "spector"] as never)).toHaveProperty("error");
    expect(normalizeSceneAdapters(["babylon"] as never)).toHaveProperty("error");
  });
});

describe("sceneCanvasClip", () => {
  it("clips in viewport coordinates without translating by scroll offsets", () => {
    // getBoundingClientRect is viewport-relative and Playwright clips viewport
    // screenshots the same way, so a fixed canvas at y=30 stays y=30 even when
    // the document is scrolled far below it.
    expect(
      sceneCanvasClip({ x: 0, y: 30, width: 400, height: 300 }, { width: 1440, height: 900 }),
    ).toEqual({ x: 0, y: 30, width: 400, height: 300 });
    expect(
      sceneCanvasClip(
        { x: -20, y: -10, width: 400, height: 300 },
        { width: 1440, height: 900 },
      ),
    ).toEqual({ x: 0, y: 0, width: 380, height: 290 });
    expect(
      sceneCanvasClip(
        { x: 0, y: 0, width: 2000, height: 1200 },
        { width: 1440, height: 900 },
      ),
    ).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
    expect(
      sceneCanvasClip({ x: 0, y: 0, width: 10, height: 10 }, { width: 1440, height: 900 }),
    ).toHaveProperty("width", 10);
    expect(
      sceneCanvasClip({ x: 0, y: 900, width: 100, height: 100 }, { width: 1440, height: 900 }),
    ).toBeNull();
  });
});

describe("SCENE_CANVAS_PICK", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function canvasAt(
    rect: { x: number; y: number; width: number; height: number },
    picked: boolean[],
    index: number,
  ) {
    return {
      tagName: "CANVAS",
      width: 100,
      height: 100,
      getBoundingClientRect: () => rect,
      setAttribute: () => {
        picked[index] = true;
      },
    };
  }

  it("ignores a larger offscreen canvas in favour of a smaller visible one", () => {
    const picked = [false, false];
    const canvases = [
      canvasAt({ x: 0, y: 5000, width: 3000, height: 2000 }, picked, 0),
      canvasAt({ x: 100, y: 100, width: 400, height: 300 }, picked, 1),
    ];
    vi.stubGlobal("document", {
      querySelectorAll: () => canvases,
      querySelector: () => null,
    });
    vi.stubGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible" }));
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("innerHeight", 720);

    const result = SCENE_CANVAS_PICK({ selector: "" });
    expect(result.problem).toBe("");
    expect(picked).toEqual([false, true]);
  });

  it("ranks by visible intersection, not the full offscreen area", () => {
    const picked = [false, false];
    const canvases = [
      // 2000x1000 but only 200x1000 is inside the viewport.
      canvasAt({ x: -1800, y: 0, width: 2000, height: 1000 }, picked, 0),
      canvasAt({ x: 0, y: 0, width: 500, height: 400 }, picked, 1),
    ];
    vi.stubGlobal("document", {
      querySelectorAll: () => canvases,
      querySelector: () => null,
    });
    vi.stubGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible" }));
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("innerHeight", 720);

    expect(SCENE_CANVAS_PICK({ selector: "" }).problem).toBe("");
    expect(picked).toEqual([false, true]);
  });
});

describe("SCENE_THREE_PROBE", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const vector = (x: number, y: number, z: number) => ({ x, y, z });
  const matrix = () => ({
    elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1],
  });
  const color = (hex: string) => {
    // Three Color stores sRGB inputs in linear working space.
    const linear = (channel: number): number =>
      channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
    return {
      r: linear(parseInt(hex.slice(0, 2), 16) / 255),
      g: linear(parseInt(hex.slice(2, 4), 16) / 255),
      b: linear(parseInt(hex.slice(4, 6), 16) / 255),
    };
  };

  function mesh(overrides: Record<string, unknown> = {}): any {
    return {
      isMesh: true,
      name: "cube",
      uuid: "mesh-1",
      visible: true,
      position: vector(1, 2, 3),
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
      scale: vector(1, 1, 1),
      children: [],
      geometry: {
        type: "BoxGeometry",
        attributes: { position: { count: 24 }, normal: { count: 24 }, uv: { count: 24 } },
        index: { count: 36 },
        boundingBox: { min: vector(-1, -1, -1), max: vector(1, 1, 1) },
      },
      material: {
        type: "MeshStandardMaterial",
        color: color("ff8800"),
        opacity: 0.5,
        transparent: true,
        metalness: 0.2,
        roughness: 0.4,
        side: 0,
        map: { image: { src: "https://cdn.example.com/tex/rock.png" } },
      },
      ...overrides,
    };
  }

  function camera(): any {
    return {
      isCamera: true,
      type: "PerspectiveCamera",
      name: "main-camera",
      uuid: "cam-1",
      visible: true,
      position: vector(0, 0, 5),
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
      scale: vector(1, 1, 1),
      children: [],
      fov: 50,
      near: 0.1,
      far: 100,
      matrixWorld: matrix(),
    };
  }

  function light(): any {
    return {
      isLight: true,
      type: "DirectionalLight",
      name: "key",
      uuid: "light-1",
      visible: true,
      position: vector(3, 5, 4),
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
      scale: vector(1, 1, 1),
      children: [],
      color: color("ffffff"),
      intensity: 2,
      distance: 0,
    };
  }

  function scene(children: any[]): any {
    return {
      isScene: true,
      type: "Scene",
      name: "root",
      uuid: "scene-1",
      visible: true,
      position: vector(0, 0, 0),
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
      scale: vector(1, 1, 1),
      children,
    };
  }

  function controls(cam: any): any {
    return {
      camera: cam,
      target: vector(0, 1, 0),
      update: () => undefined,
      constructor: { name: "OrbitControls" },
    };
  }

  const probe = (caps: Partial<SceneThreeProbeCaps> = {}) =>
    SCENE_THREE_PROBE({ ...THREE_PROBE_CAPS, ...caps });

  it("serializes a reachable scene, camera, light, material and controls", () => {
    const cam = camera();
    const root = scene([mesh(), cam, light()]);
    vi.stubGlobal("THREE", { REVISION: "170" });
    vi.stubGlobal("scene", root);
    vi.stubGlobal("camera", cam);
    vi.stubGlobal("app", { scene: root, camera: cam, renderer: {}, controls: controls(cam) });

    const result = probe();
    expect(result.available).toBe(true);
    expect(result.revision).toBe("170");
    expect(result.reason).toMatch(/heap was not crawled/i);
    expect(result.scene?.nodes.map((node) => node.type)).toEqual(["scene", "mesh", "camera", "light"]);
    expect(result.scene?.truncated).toBe(false);

    const cube = result.scene!.nodes[1]!;
    expect(cube).toMatchObject({
      name: "cube",
      uuid: "mesh-1",
      visible: true,
      position: [1, 2, 3],
      quaternion: [0, 0, 0, 1],
      childCount: 0,
    });
    expect(cube.geometry).toMatchObject({
      type: "BoxGeometry",
      indexCount: 36,
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
    });
    expect(cube.geometry?.attributes.map((row) => row.name)).toEqual(["position", "normal", "uv"]);
    expect(cube.material).toMatchObject({
      type: "MeshStandardMaterial",
      color: "#ff8800",
      opacity: 0.5,
      transparent: true,
      metalness: 0.2,
      roughness: 0.4,
      side: 0,
      map: "https://cdn.example.com/tex/rock.png",
    });
    expect(JSON.stringify(cube)).not.toContain("token=secret");

    expect(result.camera).toMatchObject({ type: "PerspectiveCamera", fov: 50, near: 0.1, far: 100 });
    expect(result.camera?.matrixWorld).toHaveLength(16);
    expect(result.cameras).toHaveLength(1);
    expect(result.lights).toEqual([
      { type: "DirectionalLight", color: "#ffffff", intensity: 2, distance: 0 },
    ]);
    expect(result.controls).toEqual({ type: "controls", target: [0, 1, 0] });
  });

  it("reports an unreachable page without inventing a scene", () => {
    vi.stubGlobal("THREE", { REVISION: "171" });
    const withThree = probe();
    expect(withThree.available).toBe(false);
    expect(withThree.scene).toBeNull();
    expect(withThree.camera).toBeNull();
    expect(withThree.cameras).toEqual([]);
    expect(withThree.controls).toBeNull();
    expect(withThree.reason).toMatch(/no reachable scene/i);
    expect(withThree.reason).toContain("171");

    vi.unstubAllGlobals();
    const withoutThree = probe();
    expect(withoutThree.available).toBe(false);
    expect(withoutThree.revision).toBeNull();
    expect(withoutThree.reason).toMatch(/No window\.THREE/i);
  });

  it("caps nodes, depth, cameras, lights, materials and texture URLs", () => {
    const flat = scene(Array.from({ length: 8 }, (_, i) => mesh({ uuid: `m-${i}`, name: `m${i}` })));
    vi.stubGlobal("scene", flat);
    const capped = probe({ maxNodes: 3 });
    expect(capped.scene?.nodes).toHaveLength(3);
    expect(capped.scene?.truncated).toBe(true);
    expect(capped.scene?.total).toBeGreaterThanOrEqual(3);

    const deep = scene([
      mesh({
        children: [mesh({ uuid: "child", name: "child" })],
      }),
    ]);
    vi.stubGlobal("scene", deep);
    const shallow = probe({ maxDepth: 0 });
    expect(shallow.scene?.nodes.map((node) => node.name)).toEqual(["root"]);
    expect(shallow.scene?.truncated).toBe(true);
    // The depth-capped child is never inferred, only the truncation flag is set.
    expect(shallow.scene?.nodes.some((node) => node.name === "child")).toBe(false);
    expect(shallow.scene?.nodes.some((node) => node.name === "cube")).toBe(false);

    const cam = camera();
    vi.stubGlobal(
      "scene",
      scene([
        cam,
        camera(),
        camera(),
        light(),
        light(),
        mesh({ material: { ...mesh().material, map: { image: { src: "https://cdn.example.com/a.png" } } } }),
        mesh({ uuid: "m-2", material: { ...mesh().material, map: { image: { src: "https://cdn.example.com/b.png" } } } }),
      ]),
    );
    vi.stubGlobal("camera", cam);
    const caps = probe({ maxCameras: 2, maxLights: 1, maxMaterials: 2, maxTextures: 1 });
    expect(caps.cameras).toHaveLength(2);
    expect(caps.lights).toHaveLength(1);
    const maps = caps.scene!.nodes
      .filter((node) => node.type === "mesh")
      .map((node) => (node.material && !Array.isArray(node.material) ? node.material.map : null));
    expect(maps.filter((map) => map !== null)).toEqual(["https://cdn.example.com/a.png"]);
    const materials = caps.scene!.nodes.filter((node) => node.material !== null);
    expect(materials).toHaveLength(2);
  });

  it("ignores hostile fields, functions and userData and never throws", () => {
    const hostile = {
      get isMesh() {
        return true;
      },
      get name() {
        throw new Error("hostile getter");
      },
      get children() {
        throw new Error("hostile children");
      },
      get material() {
        throw new Error("hostile material");
      },
      userData: { secret: "do-not-serialize" },
    };
    const benign = mesh({
      name: () => "function-name",
      userData: { secret: "do-not-serialize" },
      material: {
        ...mesh().material,
        userData: { secret: "do-not-serialize" },
        onBeforeCompile: () => "do-not-serialize",
        shader: "do-not-serialize",
      },
    });
    vi.stubGlobal("scene", scene([hostile, benign]));

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = probe();
    expect(result.available).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("do-not-serialize");
    expect(serialized).not.toContain("userData");
    // The hostile node is dropped and the function-valued name is not
    // serialized; neither is guessed.
    expect(result.scene?.nodes.map((node) => node.name)).toEqual(["root", null, null]);
  });

  it("never crawls the heap for scene objects", () => {
    const reachable = scene([mesh({ name: "reachable" })]);
    vi.stubGlobal("scene", reachable);
    vi.stubGlobal("elsewhere", { scene: scene([mesh({ name: "unreachable" })]) });

    const result = probe();
    expect(result.available).toBe(true);
    expect(result.scene?.nodes.map((node) => node.name)).toEqual(["root", "reachable"]);
    expect(JSON.stringify(result)).not.toContain("unreachable");
  });

  it("never executes page-defined coercion, colour methods or network calls", () => {
    const valueOf = vi.fn(() => {
      throw new Error("valueOf executed");
    });
    const getHexString = vi.fn(() => {
      throw new Error("getHexString executed");
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal(
      "scene",
      scene([
        mesh({
          opacity: { valueOf },
          material: {
            ...mesh().material,
            color: { r: 1, g: 1, b: 0, getHexString },
            opacity: { valueOf },
            metalness: { valueOf },
          },
        }),
      ]),
    );

    const result = probe();
    expect(valueOf).not.toHaveBeenCalled();
    expect(getHexString).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const cube = result.scene!.nodes[1]!;
    expect(cube.material).toMatchObject({ color: "#ffff00", opacity: null, metalness: null });;
  });

  it("bounds node acquisition for a 10k child list and completes on cyclic/throwing graphs", () => {
    const wide = scene(
      Array.from({ length: 10_000 }, () => ({
        isMesh: true,
        children: [],
        geometry: null,
        material: null,
      })),
    );
    vi.stubGlobal("scene", wide);
    const started = Date.now();
    const capped = probe({ maxNodes: 2 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(capped.scene?.nodes).toHaveLength(2);
    expect(capped.scene?.total).toBeLessThanOrEqual(2);
    expect(capped.scene?.truncated).toBe(true);

    const a: any = { isMesh: true, name: "a", children: [], geometry: null, material: null };
    const b: any = { isMesh: true, name: "b", children: [a], geometry: null, material: null };
    a.children = [b];
    const throwing: any = {
      isMesh: true,
      name: "throwing",
      get children() {
        throw new Error("children getter");
      },
      geometry: null,
      material: null,
    };
    vi.stubGlobal("scene", scene([a, throwing]));
    const cyclic = probe({ maxNodes: 20 });
    expect(cyclic.available).toBe(true);
    expect(cyclic.scene!.nodes.length).toBeLessThanOrEqual(20);
    expect(cyclic.scene!.nodes.map((node) => node.name)).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("returns raw texture sources without calling the page URL constructor", () => {
    const urlSpy = vi.fn(function () {
      throw new Error("page URL constructor executed");
    });
    vi.stubGlobal("URL", urlSpy);
    vi.stubGlobal("document", { baseURI: "https://evil.example/" });
    vi.stubGlobal(
      "scene",
      scene([
        mesh({
          material: {
            ...mesh().material,
            map: {
              image: {
                src: "//user:pass@cdn.example.com/textures/rock.png?token=secret#frag",
              },
            },
          },
        }),
      ]),
    );

    const result = probe();
    const cube = result.scene!.nodes[1]!;
    const map = cube.material && !Array.isArray(cube.material) ? cube.material.map : null;
    // Raw primitive; Node resolves and redacts it against the evidence URL.
    expect(map).toBe("//user:pass@cdn.example.com/textures/rock.png?token=secret#frag");
    expect(urlSpy).not.toHaveBeenCalled();
  });

  it("examines only the fixed attribute allowlist with own data descriptors", () => {
    let getterCalls = 0;
    const proto: Record<string, unknown> = {};
    for (let i = 0; i < 10_000; i++) {
      Object.defineProperty(proto, `inherited${i}`, {
        enumerable: true,
        get() {
          getterCalls += 1;
          return { count: i };
        },
      });
    }
    const attributes: Record<string, unknown> = Object.create(proto);
    attributes.position = { count: 24 };
    Object.defineProperty(attributes, "normal", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { count: 3 };
      },
    });
    vi.stubGlobal(
      "scene",
      scene([
        mesh({
          geometry: {
            type: "BoxGeometry",
            attributes,
            index: null,
            boundingBox: null,
            parameters: null,
          },
        }),
      ]),
    );

    const result = probe({ maxAttributes: 2 });
    const cube = result.scene!.nodes[1]!;
    // position is accepted; normal is an own getter and is skipped.
    expect(cube.geometry?.attributes).toEqual([{ name: "position", count: 24 }]);
    expect(getterCalls).toBe(0);
  });

  it("reads colour channels only from own data properties", () => {
    let getterCalls = 0;
    const proto: Record<string, unknown> = {};
    for (const key of ["r", "g", "b"]) {
      Object.defineProperty(proto, key, {
        get() {
          getterCalls += 1;
          return 1;
        },
      });
    }
    const inherited = Object.create(proto);
    const ownGetter = { r: 0.5, g: 0.5, b: 0.5 };
    Object.defineProperty(ownGetter, "r", {
      get() {
        getterCalls += 1;
        return 1;
      },
    });

    vi.stubGlobal(
      "scene",
      scene([
        mesh({ material: { ...mesh().material, color: inherited } }),
        mesh({ material: { ...mesh().material, color: ownGetter } }),
      ]),
    );
    const result = probe();
    expect(result.scene!.nodes[1]!.material).toMatchObject({ color: null });
    expect(result.scene!.nodes[2]!.material).toMatchObject({ color: null });
    expect(getterCalls).toBe(0);
  });

  it("enforces camera, light, material and texture budgets before serialization", () => {
    let secondTextureReads = 0;
    const firstMaterial = mesh().material;
    const secondMaterial = {
      ...firstMaterial,
      map: {
        image: {
          get src() {
            secondTextureReads += 1;
            return "https://cdn.example.com/second.png";
          },
        },
      },
    };
    vi.stubGlobal(
      "scene",
      scene([
        camera(),
        camera(),
        light(),
        light(),
        mesh({ uuid: "m-1", material: firstMaterial }),
        mesh({ uuid: "m-2", material: secondMaterial }),
        mesh({ uuid: "m-3", material: firstMaterial }),
      ]),
    );

    const result = probe({ maxCameras: 1, maxLights: 1, maxMaterials: 1, maxTextures: 1 });
    expect(result.cameras).toHaveLength(1);
    expect(result.lights).toHaveLength(1);
    const nodeCameras = result.scene!.nodes.filter((node) => node.camera !== null);
    expect(nodeCameras).toHaveLength(1);
    const nodeLights = result.scene!.nodes.filter((node) => node.light !== null);
    expect(nodeLights).toHaveLength(1);
    const materials = result.scene!.nodes.flatMap((node) =>
      Array.isArray(node.material) ? node.material : node.material ? [node.material] : [],
    );
    expect(materials).toHaveLength(1);
    expect(materials[0]!.map).toBe("https://cdn.example.com/tex/rock.png");
    // Once the texture budget is full, later map sources are never read.
    expect(secondTextureReads).toBe(0);
  });

  it("keeps a reachable camera when a window getter throws", () => {
    const cam = camera();
    Object.defineProperty(globalThis, "scene", {
      configurable: true,
      get() {
        throw new Error("hostile window.scene");
      },
    });
    vi.stubGlobal("camera", cam);
    try {
      const result = probe();
      expect(result.available).toBe(true);
      expect(result.cameras).toHaveLength(1);
      expect(result.camera).toMatchObject({ type: "PerspectiveCamera", fov: 50 });
      expect(result.scene).toBeNull();
    } finally {
      delete (globalThis as any).scene;
    }
  });

  it("accepts OrbitControls with .object or .camera", () => {
    const cam = camera();
    vi.stubGlobal("camera", cam);
    vi.stubGlobal("controls", {
      object: cam,
      target: vector(0, 1, 0),
      update: () => undefined,
    });
    expect(probe().controls).toEqual({ type: "controls", target: [0, 1, 0] });

    vi.unstubAllGlobals();
    vi.stubGlobal("controls", {
      camera: cam,
      target: vector(1, 2, 3),
      update: () => undefined,
    });
    expect(probe().controls).toEqual({ type: "controls", target: [1, 2, 3] });

    vi.unstubAllGlobals();
    vi.stubGlobal("controls", { target: vector(0, 0, 0), update: () => undefined });
    expect(probe().controls).toBeNull();
  });

  it("copies numeric geometry parameters", () => {
    vi.stubGlobal(
      "scene",
      scene([
        mesh({
          geometry: {
            type: "BoxGeometry",
            attributes: { position: { count: 24 } },
            index: { count: 36 },
            boundingBox: null,
            parameters: { width: 2, height: 3, depth: 4, widthSegments: 1, bogus: 9 },
          },
        }),
      ]),
    );
    const cube = probe().scene!.nodes[1]!;
    expect(cube.geometry?.parameters).toEqual({ width: 2, height: 3, depth: 4, widthSegments: 1 });
  });

  it("bounds page-derived text and texture sources", () => {
    vi.stubGlobal(
      "scene",
      scene([
        mesh({
          name: "n".repeat(5_000),
          uuid: "u".repeat(5_000),
          material: {
            ...mesh().material,
            map: { image: { src: `https://cdn.example.com/tex.png?token=${"t".repeat(5_000)}#frag` } },
          },
        }),
      ]),
    );
    vi.stubGlobal("THREE", { REVISION: "r".repeat(5_000) });
    const result = probe({ maxNameChars: 8, maxUuidChars: 8, maxUrlChars: 64 });
    const cube = result.scene!.nodes[1]!;
    expect(cube.name).toHaveLength(8);
    expect(cube.uuid).toHaveLength(8);
    expect(result.revision).toHaveLength(8);
    const map = cube.material && !Array.isArray(cube.material) ? cube.material.map : null;
    expect(map).toHaveLength(64);
    expect(map!.startsWith("https://cdn.example.com/tex.png?token=")).toBe(true);
  });
});

describe("captureScene3d", () => {
  const url = "https://example.com/scene?token=secret#frag";

  it("writes an evidence pack with frames and a redacted response inventory", async () => {
    const dir = tmpDir();
    const fake = fakePage({
      responses: [
        {
          url: "https://cdn.example.com/textures/rock.png?token=secret",
          mime: "image/png",
          length: 2048,
          type: "image",
        },
        {
          url: "https://cdn.example.com/model/scene.glb",
          mime: "model/gltf-binary",
          length: 4096,
          type: "fetch",
        },
        {
          url: "https://three.example.com/build/three.module.js",
          mime: "text/javascript",
          type: "script",
        },
      ],
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await captureScene3d(url, {
      loader: fake.loader,
      resolveHost,
      sceneDir: dir,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.id).toBe("scene-evidence-v1");
    expect(result.url).toBe("https://example.com/scene");
    expect(result.checkpoints).toHaveLength(SCENE_LIMITS.defaultCheckpoints);
    expect(result.viewport).toEqual({ name: "desktop", width: 1440, height: 900 });

    // Canvas pick: no selector given, so the in-page snippet chooses.
    const pick = fake.calls.evaluates.find((call) => call.name === "SCENE_CANVAS_PICK");
    expect(pick?.arg).toEqual({ selector: "" });

    // Redaction: query strings never reach evidence.
    expect(result.resources).toHaveLength(3);
    expect(result.resources[0]).toMatchObject({
      url: "https://cdn.example.com/textures/rock.png",
      origin: "https://cdn.example.com",
      mime: "image/png",
      bytes: 2048,
      classification: "texture",
      resourceType: "image",
      discovery: "response",
    });
    expect(result.resources[1].classification).toBe("model");
    expect(result.resources[2].classification).toBe("script");
    expect(JSON.stringify(result)).not.toContain("token=secret");

    // Each row gets a stable inventory handle; only query-free observations
    // store a fetchable URL, and the skip reason travels with the row.
    expect(result.resources.map((row) => row.assetId)).toEqual(["asset-1", "asset-2", "asset-3"]);
    expect(result.resources[0].download).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/query/i),
    });
    expect(result.resources[1].download).toEqual({
      status: "available",
      url: "https://cdn.example.com/model/scene.glb",
    });
    expect(result.resources[2].download).toEqual({
      status: "available",
      url: "https://three.example.com/build/three.module.js",
    });

    // Checkpoint measurements and files.
    expect(result.checkpoints[0].requestedScrollRatio).toBe(0);
    expect(result.checkpoints[1].requestedScrollTop).toBe(400); // 0.2 * 2000
    expect(result.checkpoints.at(-1)!.actualScrollTop).toBe(2000);
    expect(result.checkpoints[0].canvas).toEqual({
      rect: { x: 0, y: 0, width: 800, height: 600 },
      backing: { width: 1600, height: 1200 },
      dpr: 2,
    });
    // Viewport shots are on by default: 6 frames x 2 files.
    expect(fake.calls.shots).toHaveLength(12);
    for (const frame of result.checkpoints) {
      expect(statSync(frame.files.canvas).size).toBe(PNG.length);
      expect(frame.files.viewport).toBeDefined();
      expect(statSync(frame.files.viewport!).size).toBe(PNG.length);
    }

    // Evidence file mirrors the returned pack.
    const saved = JSON.parse(readFileSync(result.paths.evidence, "utf8"));
    expect(saved.id).toBe("scene-evidence-v1");
    expect(saved.captureId).toBe(result.captureId);
    expect(saved.resources).toHaveLength(3);
    expect(result.paths.dir.endsWith(result.captureId)).toBe(true);

    // Coverage is explicit, never inferred.
    expect(result.coverage.status).toBe("partial"); // limitations are present
    expect(result.coverage.capabilities.scene.status).toBe("unavailable");
    expect(result.coverage.capabilities.camera.status).toBe("unavailable");
    expect(result.coverage.capabilities.controls.status).toBe("unavailable");
    expect(result.coverage.capabilities.shaders.status).toBe("unavailable");
    expect(result.coverage.capabilities.geometry.status).toBe("unavailable");
    expect(result.coverage.capabilities.shaders.reason).toMatch(/no shader source/i);

    expect(result.frameworkHints.three).toMatchObject({
      detected: true,
      version: "170",
      scripts: ["https://cdn.example.com/three.module.js"],
    });
    expect(result.frameworkHints.canvasCount).toBe(1);

    // MCP summary is compact and has no resource bodies or base64.
    const summary = summarizeSceneEvidence(result);
    expect(summary.resources).toMatchObject({
      total: 3,
      collected: 3,
      truncated: false,
      byClassification: { texture: 1, model: 1, script: 1, image: 0, other: 0 },
      assetIds: ["asset-1", "asset-2", "asset-3"],
      downloadable: ["asset-2", "asset-3"],
    });
    expect(JSON.stringify(summary)).not.toContain("base64");
    expect(fake.calls.closed).toBe(true);
  });

  it("uses the requested selector, pointer, wait and viewport shots off", async () => {
    const dir = tmpDir();
    const fake = fakePage();
    const result = await captureScene3d("https://example.com", {
      loader: fake.loader,
      resolveHost,
      sceneDir: dir,
      canvasSelector: "#hero-canvas",
      viewport: "mobile",
      includeViewportShots: false,
      checkpoints: [{ scrollRatio: 0.5, pointer: { x: 0.5, y: 0.25 }, waitMs: 120 }],
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(
      fake.calls.evaluates.find((call) => call.name === "SCENE_CANVAS_PICK")?.arg,
    ).toEqual({ selector: "#hero-canvas" });
    expect(result.checkpoints).toHaveLength(1);
    expect(result.checkpoints[0].pointer).toEqual({ x: 0.5, y: 0.25 });
    expect(result.checkpoints[0].pointerPx).toEqual({ x: 195, y: 211 });
    expect(fake.calls.mouse).toEqual([{ x: 195, y: 211 }]);
    expect(result.checkpoints[0].waitMs).toBe(120);
    expect(result.checkpoints[0].requestedScrollTop).toBe(1000);
    expect(result.checkpoints[0].files.viewport).toBeUndefined();
    expect(fake.calls.shots).toHaveLength(1);
    expect(result.viewport).toEqual({ name: "mobile", width: 390, height: 844 });
  });

  it("caps collected resources at 200 and records the truncation", async () => {
    const dir = tmpDir();
    const responses = Array.from({ length: 205 }, (_, i) => ({
      url: `https://cdn.example.com/r${i}.png`,
      mime: "image/png",
      type: "image",
    }));
    const fake = fakePage({ responses });
    const result = await captureScene3d("https://example.com", {
      loader: fake.loader,
      resolveHost,
      sceneDir: dir,
      checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.resources).toHaveLength(SCENE_LIMITS.maxResources);
    expect(result.resourceTotal).toBe(205);
    expect(result.resourcesTruncated).toBe(true);
    expect(result.limitations.join(" ")).toContain("Only the first 200 responses");
  });

  it("re-checks routed requests and aborts private or non-http targets", async () => {
    const dir = tmpDir();
    const fake = fakePage();
    const result = await captureScene3d("https://example.com", {
      loader: fake.loader,
      resolveHost,
      sceneDir: dir,
      checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
    });
    expect("error" in result).toBe(false);
    const route = fake.calls.route;
    expect(route).not.toBeNull();

    const request = (target: string) => {
      const call = {
        request: () => ({ url: () => target }),
        continue: vi.fn(async () => {}),
        abort: vi.fn(async () => {}),
      };
      return call;
    };
    const privateRequest = request("http://127.0.0.1:8080/admin");
    await route!(privateRequest);
    expect(privateRequest.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(privateRequest.continue).not.toHaveBeenCalled();

    const fileRequest = request("file:///etc/passwd");
    await route!(fileRequest);
    expect(fileRequest.abort).toHaveBeenCalledWith("blockedbyclient");

    const publicRequest = request("https://cdn.example.com/a.png");
    await route!(publicRequest);
    expect(publicRequest.continue).toHaveBeenCalledTimes(1);
    expect(publicRequest.abort).not.toHaveBeenCalled();
  });

  it("rejects non-http, localhost, private-resolved and invalid checkpoint inputs before launch", async () => {
    const dir = tmpDir();
    const loader = vi.fn(fakePage().loader);
    const base = { loader, resolveHost, sceneDir: dir };

    const cases = [
      "file:///etc/passwd",
      "http://localhost:3000/",
      "http://private.test/",
      "https://example.com/",
    ];
    for (const target of cases.slice(0, 3)) {
      const result = await captureScene3d(target, base);
      expect("error" in result, target).toBe(true);
    }
    const tooMany = await captureScene3d("https://example.com", {
      ...base,
      checkpoints: Array.from({ length: 11 }, () => ({ scrollRatio: 0.5 })),
    });
    expect(tooMany).toHaveProperty("error");
    const badRatio = await captureScene3d("https://example.com", {
      ...base,
      checkpoints: [{ scrollRatio: 2 }],
    });
    expect(badRatio).toHaveProperty("error");
    expect(loader).not.toHaveBeenCalled();
  });

  it("fails clearly when the selector matches nothing or the page has no canvas", async () => {
    const dir = tmpDir();
    const missing = await captureScene3d("https://example.com", {
      loader: fakePage({ pick: { problem: "selector-not-found", selector: "" } }).loader,
      resolveHost,
      sceneDir: dir,
      canvasSelector: "#nope",
      checkpoints: [{ scrollRatio: 0 }],
    });
    expect(missing).toEqual({
      error: 'Scene capture failed: canvasSelector "#nope" matched no element.',
    });

    const none = await captureScene3d("https://example.com", {
      loader: fakePage({ pick: { problem: "no-canvas", selector: "" } }).loader,
      resolveHost,
      sceneDir: dir,
    });
    expect("error" in none && none.error).toMatch(/no visible <canvas>/);
  });

  it("fails on an oversized frame and removes the temp pack", async () => {
    const dir = tmpDir();
    const result = await captureScene3d("https://example.com", {
      loader: fakePage({
        onScreenshot: () => Buffer.alloc(SCENE_LIMITS.maxImageBytes + 1),
      }).loader,
      resolveHost,
      sceneDir: dir,
      checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/8 MiB per-image limit/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("returns on the deadline and closes the context and browser when an evaluate hangs", async () => {
    const dir = tmpDir();
    const fake = fakePage({ hangEvaluate: true });
    const started = Date.now();
    const result = await captureScene3d("https://example.com", {
      loader: fake.loader,
      resolveHost,
      sceneDir: dir,
      timeoutMs: 150,
      checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/timed out/i);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fake.calls.contextClosed).toBe(true);
    expect(fake.calls.closed).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("closes a browser that arrives after the watchdog deadline and its proxy", async () => {
    const dir = tmpDir();
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const browserClose = vi.fn(async () => {});
    let proxyServer = "";
    const loader = async () => ({
      chromium: {
        launch: async (options: any) => {
          proxyServer = options.proxy.server;
          await launchGate;
          return {
            newContext: async () => {
              throw new Error("a context must not be created after cancellation");
            },
            close: browserClose,
          };
        },
      },
    });

    const started = Date.now();
    const result = await captureScene3d("https://example.com", {
      loader,
      resolveHost,
      sceneDir: dir,
      timeoutMs: 150,
      checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/timed out/i);
    expect(Date.now() - started).toBeLessThan(5_000);

    // The proxy existed before the deadline, so the watchdog close must have
    // stopped it accepting new tunnels.
    expect(proxyServer).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(portAccepts(Number(new URL(proxyServer).port))).resolves.toBe(false);
    expect(browserClose).not.toHaveBeenCalled();

    // The late launch is now owned by the still-running acquisition, which must
    // close it on its next cancellation check.
    releaseLaunch();
    await vi.waitFor(() => expect(browserClose).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("caps redacted blocked-request samples at record time", async () => {
    const dir = tmpDir();
    const blockedUrls = Array.from(
      { length: 5 },
      (_, i) => `https://private.test/${"p".repeat(450_000)}-${i}?token=secret`,
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const fake = fakePage({
      onGoto: async () => {
        for (const target of blockedUrls) {
          const call = {
            request: () => ({ url: () => target }),
            continue: vi.fn(async () => {}),
            abort: vi.fn(async () => {}),
          };
          await fake.calls.route!(call);
          expect(call.abort).toHaveBeenCalledWith("blockedbyclient");
          expect(call.continue).not.toHaveBeenCalled();
        }
      },
    });
    const result = await captureScene3d("https://example.com", {
      loader: fake.loader,
      resolveHost,
      sceneDir: dir,
      checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.blockedRequests.count).toBe(5);
    expect(result.blockedRequests.samples).toHaveLength(5);
    for (const sample of result.blockedRequests.samples) {
      expect(sample.length).toBeLessThanOrEqual(SCENE_LIMITS.maxBlockedSampleChars);
      expect(sample.startsWith("https://private.test/")).toBe(true);
      expect(sample).not.toContain("token=secret");
    }
    // The stored samples are metadata, not a 2 MiB budget breaker.
    expect(Buffer.byteLength(readFileSync(result.paths.evidence, "utf8"))).toBeLessThan(
      SCENE_LIMITS.maxMetadataBytes,
    );
  });

  it("caps every page-derived string and keeps a 2 MiB version out of evidence", async () => {
    const dir = tmpDir();
    const longUrl = `https://cdn.example.com/three-${"s".repeat(5_000)}.js?token=secret`;
    const fake = fakePage({
      hints: { threeRevision: "v".repeat(2 * 1024 * 1024), scripts: [longUrl] },
      responses: [
        {
          url: `https://cdn.example.com/${"r".repeat(5_000)}.png?token=secret#frag`,
          mime: `application/${"m".repeat(500)}`,
          type: "t".repeat(500),
        },
      ],
    });
    const result = await captureScene3d("https://example.com", {
      loader: fake.loader,
      resolveHost,
      sceneDir: dir,
      checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.frameworkHints.three.version).toHaveLength(SCENE_LIMITS.maxVersionChars);
    expect(result.frameworkHints.three.scripts[0]!.length).toBeLessThanOrEqual(
      SCENE_LIMITS.maxScriptChars,
    );
    expect(result.resources[0].url.length).toBeLessThanOrEqual(SCENE_LIMITS.maxResourceUrlChars);
    expect(result.resources[0].mime.length).toBeLessThanOrEqual(SCENE_LIMITS.maxMimeChars);
    expect(result.resources[0].resourceType.length).toBeLessThanOrEqual(
      SCENE_LIMITS.maxResourceTypeChars,
    );
    const saved = readFileSync(result.paths.evidence, "utf8");
    expect(saved.length).toBeLessThan(SCENE_LIMITS.maxMetadataBytes);
    expect(saved).not.toContain("token=secret");
  });

  it("marks an overlong observed URL not downloadable instead of storing a truncated target", async () => {
    const dir = tmpDir();
    const observed = `https://cdn.example.com/${"a".repeat(SCENE_LIMITS.maxResourceUrlChars)}.png`;
    const result = await captureScene3d("https://example.com", {
      loader: fakePage({ responses: [{ url: observed, mime: "image/png" }] }).loader,
      resolveHost,
      sceneDir: dir,
      checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    const resource = result.resources[0]!;
    expect(resource.download).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/longer than 2048/),
    });
    expect(resource.download).not.toHaveProperty("url");

    const saved = JSON.parse(readFileSync(result.paths.evidence, "utf8"));
    expect(saved.resources[0].download).toEqual(resource.download);
    // No truncated fetch target survives in evidence.
    expect(JSON.stringify(saved.resources[0].download)).not.toContain("cdn.example.com");

    let fetches = 0;
    const downloaded = await downloadSceneAssets({
      sceneDir: dir,
      captureId: result.captureId,
      assetIds: [resource.assetId],
      rights: { basis: "licensed", evidence: "test fixture" },
      resolveHost,
      fetch: async () => {
        fetches += 1;
        throw new Error("must not fetch an overlong target");
      },
      limits: { minRequestIntervalMs: 0 },
    });
    expect(fetches).toBe(0);
    expect("error" in downloaded).toBe(false);
    if ("error" in downloaded) return;
    expect(downloaded).toMatchObject({
      downloaded: 0,
      skipped: 1,
      receivedBytes: 0,
      totalBytes: 0,
      files: [],
    });
    expect(downloaded.limitations.join(" ")).toMatch(/longer than 2048/);
  });

  it("keeps a finite zero actual scroll instead of the requested value", async () => {
    const dir = tmpDir();
    const result = await captureScene3d("https://example.com", {
      loader: fakePage({
        probe: () => ({ scroll: { top: 0, range: 2000 } }),
      }).loader,
      resolveHost,
      sceneDir: dir,
      checkpoints: [{ scrollRatio: 1, waitMs: 0 }],
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.checkpoints[0].requestedScrollTop).toBe(2000);
    expect(result.checkpoints[0].actualScrollTop).toBe(0);
  });

  it("redacts URLs with query and hash from navigation failures", async () => {
    const dir = tmpDir();
    const fake = fakePage({
      onGoto: () => {
        throw new Error(
          "page.goto: net::ERR_FAILED at https://example.com/secret?token=abc#frag",
        );
      },
    });
    const result = await captureScene3d("https://example.com", {
      loader: fake.loader,
      resolveHost,
      sceneDir: dir,
    });
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("https://example.com/secret");
    expect(result.error).not.toContain("token=abc");
    expect(result.error).not.toContain("#frag");
  });

  it("records an opt-in three adapter and links texture maps to the inventory", async () => {
    const dir = tmpDir();
    const fake = fakePage({
      responses: [
        {
          url: "https://cdn.example.com/textures/rock.png?token=secret",
          mime: "image/png",
          type: "image",
        },
      ],
      three: {
        available: true,
        reason: "Reachable three objects were read from window.* only; the heap was not crawled.",
        revision: "170",
        scene: {
          nodes: [
            {
              type: "scene",
              name: "root",
              uuid: "scene-1",
              visible: true,
              position: [0, 0, 0],
              quaternion: [0, 0, 0, 1],
              scale: [1, 1, 1],
              childCount: 2,
              geometry: null,
              material: null,
              camera: null,
              light: null,
            },
            {
              type: "mesh",
              name: "cube",
              uuid: "mesh-1",
              visible: true,
              position: [1, 2, 3],
              quaternion: [0, 0, 0, 1],
              scale: [1, 1, 1],
              childCount: 0,
              geometry: {
                type: "BoxGeometry",
                attributes: [{ name: "position", count: 24 }],
                indexCount: 36,
                bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
              },
              material: {
                type: "MeshStandardMaterial",
                color: "#ff8800",
                opacity: 1,
                transparent: false,
                metalness: 0.2,
                roughness: 0.4,
                side: 0,
                map: { url: "https://cdn.example.com/textures/rock.png", assetId: null },
              },
              camera: null,
              light: null,
            },
            {
              type: "camera",
              name: "main",
              uuid: "cam-1",
              visible: true,
              position: [0, 0, 5],
              quaternion: [0, 0, 0, 1],
              scale: [1, 1, 1],
              childCount: 0,
              geometry: null,
              material: null,
              camera: { type: "PerspectiveCamera", fov: 45, near: 0.5, far: 500, matrixWorld: Array.from({ length: 16 }, (_, i) => i) },
              light: null,
            },
          ],
          truncated: false,
          total: 3,
        },
        camera: { type: "PerspectiveCamera", fov: 45, near: 0.5, far: 500, matrixWorld: Array.from({ length: 16 }, (_, i) => i) },
        cameras: [{ type: "PerspectiveCamera", fov: 45, near: 0.5, far: 500, matrixWorld: Array.from({ length: 16 }, (_, i) => i) }],
        lights: [{ type: "DirectionalLight", color: "#ffffff", intensity: 2, distance: 0 }],
        controls: { type: "OrbitControls", target: [0, 1, 0] },
      },
    });

    const result = await captureScene3d("https://example.com", {
      loader: fake.loader,
      resolveHost,
      sceneDir: dir,
      adapters: ["three"],
      includeViewportShots: false,
      checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    const probeCall = fake.calls.evaluates.find((call) => call.name === "SCENE_THREE_PROBE");
    expect(probeCall).toBeDefined();
    expect(probeCall?.arg).toEqual(THREE_PROBE_CAPS);

    expect(result.three).toBeDefined();
    expect(result.three).toMatchObject({
      id: "three-adapter-v1",
      available: true,
      revision: "170",
      controls: { type: "OrbitControls", target: [0, 1, 0] },
      coverage: { scene: true, geometry: true, camera: true, controls: true, lights: true, materials: true },
    });
    expect(result.three?.scene?.nodes).toHaveLength(3);
    expect(result.three?.scene?.truncated).toBe(false);
    // The redacted texture URL matched the inventory row.
    expect(result.three?.scene?.nodes[1]?.material).toMatchObject({
      type: "MeshStandardMaterial",
      map: { url: "https://cdn.example.com/textures/rock.png", assetId: "asset-1" },
    });

    expect(result.coverage.capabilities.scene.status).toBe("available");
    expect(result.coverage.capabilities.camera.status).toBe("available");
    expect(result.coverage.capabilities.controls.status).toBe("available");
    expect(result.coverage.capabilities.geometry.status).toBe("available");
    expect(result.coverage.capabilities.shaders.status).toBe("unavailable");
    expect(result.limitations.join(" ")).toMatch(/heap was not crawled/i);

    const saved = JSON.parse(readFileSync(result.paths.evidence, "utf8"));
    expect(saved.three).toEqual(result.three);
    expect(JSON.stringify(saved)).not.toContain("token=secret");

    const summary = summarizeSceneEvidence(result);
    expect(summary.three).toMatchObject({
      id: "three-adapter-v1",
      available: true,
      scene: { nodes: 3, truncated: false, total: 3 },
      cameras: 1,
      lights: 1,
    });
  });

  it("re-applies adapter budgets to a hostile probe payload", async () => {
    const dir = tmpDir();
    const cameraRecord = {
      type: "PerspectiveCamera",
      fov: 50,
      near: 0.1,
      far: 100,
      matrixWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1],
    };
    const lightRecord = { type: "PointLight", color: "#ffffff", intensity: 1, distance: 0 };
    const meshes = Array.from({ length: 40 }, (_, i) => ({
      type: "mesh",
      name: `m${i}`,
      uuid: `u${i}`,
      visible: true,
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      childCount: 0,
      geometry: {
        type: "BoxGeometry",
        attributes: [],
        indexCount: null,
        bounds: null,
        parameters: { width: 1, height: 1, depth: 1 },
      },
      material: {
        type: "MeshStandardMaterial",
        color: "#ffffff",
        opacity: 1,
        transparent: false,
        metalness: 0,
        roughness: 1,
        side: 0,
        map: { url: `https://cdn.example.com/t${i}.png`, assetId: null },
      },
      camera: i === 0 ? cameraRecord : null,
      light: i === 0 ? lightRecord : null,
    }));

    const fake = fakePage({
      three: {
        available: true,
        reason: "hostile payload",
        revision: "170",
        scene: {
          nodes: [
            {
              type: "scene",
              name: "root",
              uuid: "root",
              visible: true,
              position: [0, 0, 0],
              quaternion: [0, 0, 0, 1],
              scale: [1, 1, 1],
              childCount: meshes.length,
              geometry: null,
              material: null,
              camera: null,
              light: null,
            },
            ...meshes,
          ],
          truncated: false,
          total: meshes.length + 1,
        },
        camera: cameraRecord,
        cameras: Array.from({ length: 9 }, () => cameraRecord),
        lights: Array.from({ length: 9 }, () => lightRecord),
        controls: { type: "controls", target: [0, 0, 0] },
      },
    });

    const result = await captureScene3d("https://example.com", {
      loader: fake.loader,
      resolveHost,
      sceneDir: dir,
      adapters: ["three"],
      includeViewportShots: false,
      checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.three?.cameras).toHaveLength(8);
    expect(result.three?.lights).toHaveLength(8);
    expect(result.three?.scene?.nodes.some((node) => node.camera !== null)).toBe(false);
    expect(result.three?.scene?.nodes.some((node) => node.light !== null)).toBe(false);
    const materials = (result.three?.scene?.nodes ?? []).flatMap((node) =>
      Array.isArray(node.material) ? node.material : node.material ? [node.material] : [],
    );
    expect(materials).toHaveLength(32);
    expect(materials.filter((material) => material.map !== null)).toHaveLength(32);
  });

  it("canonicalizes raw texture sources on the trusted side and links inventory", async () => {
    const dir = tmpDir();
    const node = (name: string, map: string) => ({
      type: "mesh",
      name,
      uuid: name,
      visible: true,
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      childCount: 0,
      geometry: {
        type: "BoxGeometry",
        attributes: [],
        indexCount: null,
        bounds: null,
        parameters: { width: 1, height: 1, depth: 1 },
      },
      material: {
        type: "MeshStandardMaterial",
        color: "#ffffff",
        opacity: 1,
        transparent: false,
        metalness: 0,
        roughness: 1,
        side: 0,
        map,
      },
      camera: null,
      light: null,
    });

    const fake = fakePage({
      responses: [
        { url: "https://cdn.example.com/textures/rock.png", mime: "image/png" },
        { url: "https://example.com/textures/relative.png", mime: "image/png" },
      ],
      three: {
        available: true,
        reason: "raw payload",
        revision: "170",
        scene: {
          nodes: [
            {
              type: "scene",
              name: "root",
              uuid: "root",
              visible: true,
              position: [0, 0, 0],
              quaternion: [0, 0, 0, 1],
              scale: [1, 1, 1],
              childCount: 2,
              geometry: null,
              material: null,
              camera: null,
              light: null,
            },
            node("credentialed", "//user:pass@cdn.example.com/textures/rock.png?token=secret#frag"),
            node("relative", "/textures/relative.png?token=secret"),
          ],
          truncated: false,
          total: 3,
        },
        camera: null,
        cameras: [],
        lights: [],
        controls: null,
      },
    });

    const result = await captureScene3d("https://example.com/scene", {
      loader: fake.loader,
      resolveHost,
      sceneDir: dir,
      adapters: ["three"],
      includeViewportShots: false,
      checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    const nodes = result.three?.scene?.nodes ?? [];
    const credentialed = nodes.find((row) => row.name === "credentialed");
    const relative = nodes.find((row) => row.name === "relative");
    expect(credentialed?.material && !Array.isArray(credentialed.material) ? credentialed.material.map : null).toEqual({
      url: "https://cdn.example.com/textures/rock.png",
      assetId: "asset-1",
    });
    expect(relative?.material && !Array.isArray(relative.material) ? relative.material.map : null).toEqual({
      url: "https://example.com/textures/relative.png",
      assetId: "asset-2",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("user:pass");
    expect(serialized).not.toContain("token=secret");
  });

  it("does not probe for three unless the adapter is requested", async () => {
    const dir = tmpDir();
    const three = vi.fn(() => ({ available: true }));
    const fake = fakePage({ three });
    const result = await captureScene3d("https://example.com", {
      loader: fake.loader,
      resolveHost,
      sceneDir: dir,
      checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
      includeViewportShots: false,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(three).not.toHaveBeenCalled();
    expect(fake.calls.evaluates.some((call) => call.name === "SCENE_THREE_PROBE")).toBe(false);
    expect(result.three).toBeUndefined();
    expect(result.coverage.capabilities.scene.status).toBe("unavailable");
    expect(result.coverage.capabilities.geometry.status).toBe("unavailable");
  });

  it("keeps the capture successful when the three probe fails or is hostile", async () => {
    const dir = tmpDir();
    const fake = fakePage({
      three: () => {
        throw new Error("probe exploded at https://secret.test/x?token=abc#frag");
      },
    });
    const result = await captureScene3d("https://example.com", {
      loader: fake.loader,
      resolveHost,
      sceneDir: dir,
      adapters: ["three"],
      checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
      includeViewportShots: false,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.three).toMatchObject({ id: "three-adapter-v1", available: false, scene: null });
    expect(result.three?.reason).toMatch(/could not read the page/i);
    expect(result.three?.reason).not.toContain("token=abc");
    expect(result.three?.reason).not.toContain("#frag");
    expect(result.coverage.capabilities.scene.status).toBe("unknown");
    expect(result.coverage.capabilities.scene.reason).toMatch(/requested but returned no scene/i);
    expect(result.coverage.capabilities.shaders.status).toBe("unavailable");
    // The pack still exists.
    expect(statSync(result.paths.evidence).isFile()).toBe(true);
  });

  it("rejects invalid adapters before launching a browser", async () => {
    const dir = tmpDir();
    const loader = vi.fn(fakePage().loader);
    const result = await captureScene3d("https://example.com", {
      loader,
      resolveHost,
      sceneDir: dir,
      adapters: ["three", "three"] as never,
    });
    expect(result).toEqual({ error: expect.stringMatching(/listed more than once/) });
    expect(loader).not.toHaveBeenCalled();
  });

  it("routes through a connection-level proxy created before the context", async () => {
    const dir = tmpDir();
    const fake = fakePage();
    const result = await captureScene3d("https://example.com", {
      loader: fake.loader,
      resolveHost,
      sceneDir: dir,
      checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
    });
    expect("error" in result).toBe(false);
    expect(fake.calls.launch?.proxy?.server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(fake.calls.launch?.proxy?.bypass).toBe("<-loopback>");
    expect(fake.calls.contextOptions?.serviceWorkers).toBe("block");
    expect(fake.calls.route).not.toBeNull();
    expect(fake.calls.pageHandler).not.toBeNull();

    // The first page is kept; every later page is closed immediately.
    const popup = { close: vi.fn(async () => {}) };
    fake.calls.pageHandler!(fake.page);
    fake.calls.pageHandler!(popup);
    expect(popup.close).toHaveBeenCalledTimes(1);
  });
});

describe("spector adapter", () => {
  const FAKE_BUNDLE = {
    source: "/*FAKE-SPECTOR-BUNDLE*/ window.SPECTOR = window.SPECTOR || {};",
    version: "0.9.33",
  };

  // A hostile page can return anything from its evaluate: every value is
  // re-typed and capped, and unknown/raw capture fields are dropped.
  const hostileSummary = (): Record<string, unknown> => ({
    canvas: { width: 600, height: 400 },
    context: {
      version: 2,
      attributes: { alpha: true, antialias: false, depth: 24, powerPreference: "high-performance" },
    },
    commands: {
      total: 120,
      drawCalls: 12,
      byName: Array.from({ length: 40 }, (_, i) => ({ name: `cmd${i}`, count: 40 - i })),
      statuses: { unknown: 0, unused: 0, disabled: 0, redundant: 30, valid: 90, deprecated: 0 },
    },
    programs: Array.from({ length: 12 }, (_, i) => ({
      programStatus: { LINK_STATUS: true, VALIDATE_STATUS: true, infoLog: "log".repeat(3_000) },
      shaders: [
        {
          type: "VERTEX_SHADER",
          source: i === 0 ? "v0:" + "a".repeat(70 * 1024) : `v${i}:` + "a".repeat(1_000),
          length: i === 0 ? 70 * 1024 : 1_000,
          truncated: false,
        },
      ],
    })),
    analyses: Array.from({ length: 20 }, (_, i) => ({
      name: `analysis${i}`,
      values: { frames: i, stable: true, label: "x".repeat(500), nested: { secret: true } },
    })),
    programsTruncated: false,
    shadersTruncated: false,
    // Never persisted: raw capture material.
    commandArguments: ["secret-arg"],
    stackTrace: ["at secret"],
    initState: { secret: "init" },
    endState: { secret: "end" },
    frameMemory: { secret: 1 },
    rawCapture: { secret: true },
  });

  it("injects the bundle before goto and persists a capped summary", async () => {
    const dir = tmpDir();
    const fake = fakePage({ spector: hostileSummary() });
    const result = await captureScene3d("https://example.com", {
      loader: fake.loader,
      resolveHost,
      sceneDir: dir,
      adapters: ["spector"],
      includeViewportShots: false,
      checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
      spectorBundleLoader: async () => FAKE_BUNDLE,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    // The bundle is an init script, and every init script runs before goto.
    const bundleIndex = fake.calls.initScripts.findIndex((script) =>
      script.includes("FAKE-SPECTOR-BUNDLE"),
    );
    expect(bundleIndex).toBeGreaterThanOrEqual(0);
    expect(fake.calls.order.lastIndexOf("init")).toBeLessThan(fake.calls.order.indexOf("goto"));
    const bundleScript = fake.calls.initScripts[bundleIndex]!;
    expect(bundleScript).toContain("delete document.head");
    // The in-page probe receives the canvas selector and the caps, nothing else.
    const probeCall = fake.calls.evaluates.find((call) => call.name === "SCENE_SPECTOR_PROBE");
    expect(probeCall?.arg).toEqual(spectorProbeCaps(probeCall?.arg.canvasSelector, probeCall?.arg.timeoutMs));
    expect(probeCall?.arg.timeoutMs).toBeGreaterThan(0);
    expect(probeCall?.arg.timeoutMs).toBeLessThanOrEqual(SCENE_LIMITS.spectorProbeTimeoutMs);

    const spector = result.spector;
    expect(spector).toMatchObject({
      id: "spector-adapter-v1",
      available: true,
      version: "0.9.33",
      canvas: { width: 600, height: 400 },
      context: { version: 2 },
    });
    expect(spector?.commands).toMatchObject({ total: 120, drawCalls: 12 });
    expect(spector?.commands.byName).toHaveLength(SCENE_LIMITS.maxSpectorCommandNames);
    expect(spector?.commands.byName[0]).toEqual({ name: "cmd0", count: 40 });
    expect(spector?.commands.statuses).toMatchObject({ redundant: 30, valid: 90 });

    expect(spector?.programs).toHaveLength(SCENE_LIMITS.maxSpectorPrograms);
    const shaders = (spector?.programs ?? []).flatMap((program) => program.shaders);
    expect(shaders).toHaveLength(SCENE_LIMITS.maxSpectorPrograms);
    expect(shaders.every((shader) => shader.source.length <= SCENE_LIMITS.maxSpectorShaderChars)).toBe(true);
    const totalChars = shaders.reduce((sum, shader) => sum + shader.source.length, 0);
    expect(totalChars).toBeLessThanOrEqual(SCENE_LIMITS.maxSpectorTotalShaderChars);
    expect(shaders[0]?.source.length).toBe(SCENE_LIMITS.maxSpectorShaderChars);
    expect(shaders[0]?.truncated).toBe(true);
    expect(shaders[0]?.length).toBe(70 * 1024);
    expect(spector?.programs[0]?.programStatus.infoLog?.length).toBe(
      SCENE_LIMITS.maxSpectorInfoLogChars,
    );
    expect(spector?.limits).toMatchObject({
      programsTruncated: true,
      shadersTruncated: false,
      maxPrograms: SCENE_LIMITS.maxSpectorPrograms,
      maxShaders: SCENE_LIMITS.maxSpectorShaders,
    });
    expect(spector?.analyses).toHaveLength(SCENE_LIMITS.maxSpectorAnalyses);
    expect(spector?.analyses[0]?.values).toMatchObject({ frames: 0, stable: true });
    expect(spector?.analyses[0]?.values).not.toHaveProperty("nested");

    // Only the known fields are persisted, and no raw capture material.
    expect(Object.keys(spector ?? {}).sort()).toEqual([
      "analyses",
      "available",
      "canvas",
      "commands",
      "context",
      "id",
      "limits",
      "programs",
      "reason",
      "version",
    ]);
    const saved = JSON.parse(readFileSync(result.paths.evidence, "utf8"));
    expect(saved.spector).toEqual(spector);
    for (const raw of ["secret-arg", "stackTrace", "initState", "endState", "frameMemory", "rawCapture"]) {
      expect(JSON.stringify(saved)).not.toContain(raw);
    }
    const summary = summarizeSceneEvidence(result);
    // Source stays in evidence.json; the MCP summary keeps lengths only.
    expect(summary.spector?.programs[0]?.shaders[0]).toEqual({
      type: "VERTEX_SHADER",
      length: 70 * 1024,
      truncated: true,
    });
    expect(result.coverage.capabilities.shaders.status).toBe("available");
    expect(result.coverage.capabilities.scene.status).toBe("unavailable");
    expect(result.limitations.join(" ")).toMatch(/spector adapter captured one WebGL frame/i);
  });

  it("reports the adapter unavailable when spectorjs is not installed", async () => {
    const dir = tmpDir();
    const fake = fakePage();
    const result = await captureScene3d("https://example.com", {
      loader: fake.loader,
      resolveHost,
      sceneDir: dir,
      adapters: ["spector"],
      includeViewportShots: false,
      checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
      spectorBundleLoader: async () => null,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.spector).toMatchObject({
      id: "spector-adapter-v1",
      available: false,
      version: null,
      canvas: null,
      programs: [],
    });
    expect(result.spector?.reason).toContain("spectorjs is not installed");
    expect(result.spector?.reason).toContain("npm install --save-optional spectorjs@0.9.33");
    expect(SPECTOR_INSTALL_HINT).toContain("spectorjs@0.9.33");
    expect(fake.calls.evaluates.some((call) => call.name === "SCENE_SPECTOR_PROBE")).toBe(false);
    expect(fake.calls.initScripts.some((script) => script.includes("SPECTOR"))).toBe(false);
    expect(result.coverage.capabilities.shaders.status).toBe("unknown");
    expect(result.coverage.capabilities.shaders.reason).toMatch(/requested but captured no shader source/i);
    expect(result.coverage.capabilities.scene.status).toBe("unavailable");
    expect(statSync(result.paths.evidence).isFile()).toBe(true);
  });

  it("keeps the capture successful when the spector probe fails, redacted", async () => {
    const dir = tmpDir();
    const fake = fakePage({
      spector: () => {
        throw new Error("boom at https://secret.test/x?token=abc#frag");
      },
    });
    const result = await captureScene3d("https://example.com", {
      loader: fake.loader,
      resolveHost,
      sceneDir: dir,
      adapters: ["spector"],
      includeViewportShots: false,
      checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
      spectorBundleLoader: async () => FAKE_BUNDLE,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.spector).toMatchObject({ id: "spector-adapter-v1", available: false });
    expect(result.spector?.reason).toMatch(/could not capture a frame/i);
    expect(result.spector?.reason).not.toContain("token=abc");
    expect(result.spector?.reason).not.toContain("#frag");
    expect(result.coverage.capabilities.shaders.status).toBe("unknown");
    expect(statSync(result.paths.evidence).isFile()).toBe(true);
  });

  it("keeps the capture successful when the spector probe times out, redacted", async () => {
    const dir = tmpDir();
    const fake = fakePage({
      spector: { error: "the in-page spector capture exceeded its time budget" },
    });
    const result = await captureScene3d("https://example.com", {
      loader: fake.loader,
      resolveHost,
      sceneDir: dir,
      adapters: ["spector"],
      includeViewportShots: false,
      checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
      spectorBundleLoader: async () => FAKE_BUNDLE,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.spector).toMatchObject({ available: false });
    expect(result.spector?.reason).toMatch(/time budget/i);
    expect(result.coverage.capabilities.shaders.status).toBe("unknown");
  });

  it("skips the spector probe when the budget cannot cover the 1s outer race", async () => {
    const dir = tmpDir();
    const fake = fakePage({ spector: hostileSummary() });
    const result = await captureScene3d("https://example.com", {
      loader: fake.loader,
      resolveHost,
      sceneDir: dir,
      adapters: ["spector"],
      includeViewportShots: false,
      checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
      spectorBundleLoader: async () => FAKE_BUNDLE,
      // ~150ms left after the 6s reserve (8s probe + 1s outer race).
      timeoutMs: 6_150,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.spector).toMatchObject({ available: false });
    expect(result.spector?.reason).toMatch(/no time budget/i);
    expect(fake.calls.evaluates.some((call) => call.name === "SCENE_SPECTOR_PROBE")).toBe(false);
    expect(result.checkpoints).toHaveLength(1);
  });

  it("captures both adapters together", async () => {
    const dir = tmpDir();
    const fake = fakePage({
      three: {
        available: true,
        reason: "three fixture",
        revision: "170",
        scene: {
          nodes: [
            {
              type: "mesh",
              name: "cube",
              uuid: "u1",
              visible: true,
              position: [0, 0, 0],
              quaternion: [0, 0, 0, 1],
              scale: [1, 1, 1],
              childCount: 0,
              geometry: null,
              material: null,
              camera: null,
              light: null,
            },
          ],
          truncated: false,
          total: 1,
        },
        camera: null,
        cameras: [],
        lights: [],
        controls: null,
      },
      spector: hostileSummary(),
    });
    const result = await captureScene3d("https://example.com", {
      loader: fake.loader,
      resolveHost,
      sceneDir: dir,
      adapters: ["three", "spector"],
      includeViewportShots: false,
      checkpoints: [{ scrollRatio: 0, waitMs: 0 }],
      spectorBundleLoader: async () => FAKE_BUNDLE,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.three?.available).toBe(true);
    expect(result.spector?.available).toBe(true);
    expect(fake.calls.evaluates.some((call) => call.name === "SCENE_THREE_PROBE")).toBe(true);
    expect(fake.calls.evaluates.some((call) => call.name === "SCENE_SPECTOR_PROBE")).toBe(true);
    expect(result.coverage.capabilities.scene.status).toBe("available");
    expect(result.coverage.capabilities.shaders.status).toBe("available");
    const saved = JSON.parse(readFileSync(result.paths.evidence, "utf8"));
    expect(saved.three).toBeDefined();
    expect(saved.spector).toBeDefined();
  });
});

describe("SCENE_SPECTOR_PROBE", () => {
  const canvas = { tag: "canvas" };
  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).SPECTOR;
  });

  const observable = () => {
    const handlers: Record<number, (value: any) => void> = {};
    let next = 0;
    return {
      handlers,
      add: (callback: (value: any) => void) => {
        handlers[next++] = callback;
        return next;
      },
      clear: () => {
        for (const key of Object.keys(handlers)) delete handlers[Number(key)];
      },
    };
  };

  function installFakeSpector(capture: any) {
    const calls = {
      captures: [] as Array<{ count: number; quick: boolean; full: boolean; canvas: any }>,
      stopped: 0,
      displayUI: 0,
      instances: [] as any[],
    };
    class FakeSpector {
      constructor() {
        calls.instances.push(this);
      }
      onCapture = observable();
      onError = observable();
      onCaptureStarted = observable();
      displayUI() {
        calls.displayUI += 1;
      }
      captureCanvas(target: any, count: number, quick: boolean, full: boolean) {
        calls.captures.push({ count, quick, full, canvas: target });
        Promise.resolve().then(() => {
          for (const handler of Object.values(this.onCapture.handlers)) handler(capture);
        });
      }
      stopCapture() {
        calls.stopped += 1;
      }
    }
    (globalThis as any).document = { querySelector: () => canvas };
    (globalThis as any).SPECTOR = { Spector: FakeSpector };
    return calls;
  }

  it("summarizes in the page, caps source and never copies raw capture fields", async () => {
    const commands = Array.from({ length: 12 }, (_, i) => ({
      name: i % 4 === 0 ? "drawElements" : "uniform4f",
      status: 40,
      commandArguments: ["secret-arg"],
      result: { secret: "result" },
      stackTrace: ["at secret"],
      VisualState: { secret: "state" },
      DrawCall: {
        programStatus: {
          LINK_STATUS: true,
          VALIDATE_STATUS: false,
          infoLog: "ok",
          program: { __SPECTOR_Object_TAG: { id: i } },
        },
        shaders: [
          {
            shaderType: "VERTEX_SHADER",
            source: i === 0 ? "v0:" + "a".repeat(70 * 1024) : `v${i}:` + "a".repeat(1_000),
          },
          { shaderType: "FRAGMENT_SHADER", source: `f${i}:` + "b".repeat(1_000) },
          { shaderType: "FRAGMENT_SHADER", source: `g${i}:` + "c".repeat(1_000) },
        ],
      },
    }));
    const calls = installFakeSpector({
      canvas: { width: 600, height: 400 },
      context: { version: 2, contextAttributes: { alpha: true, depth: 24, powerPreference: "default" } },
      commands,
      analyses: [{ analyserName: "FrameStatistics", frameTime: 16.6, secret: { nested: true } }],
      initState: { secret: "init" },
      endState: { secret: "end" },
      memory: { secret: 1 },
      frameMemory: { secret: 2 },
    });

    const summary = await SCENE_SPECTOR_PROBE(spectorProbeCaps("canvas", 50));
    expect("error" in summary).toBe(false);
    if ("error" in summary) throw new Error(summary.error);

    expect(calls.captures).toEqual([{ count: 0, quick: false, full: false, canvas }]);
    expect(calls.stopped).toBeGreaterThan(0);
    expect(calls.displayUI).toBe(0);
    // Disposal ran on success too: capture state is zeroed and no observer
    // still points at the page's frame loop.
    const instance = calls.instances[0];
    expect(instance.captureNextFrames).toBe(0);
    expect(instance.captureNextCommands).toBe(0);
    expect(instance.capturingContext).toBeUndefined();
    expect(instance.retry).toBe(0);
    expect(Object.keys(instance.onCapture.handlers)).toHaveLength(0);
    expect(Object.keys(instance.onError.handlers)).toHaveLength(0);
    expect(Object.keys(instance.onCaptureStarted.handlers)).toHaveLength(0);

    expect(summary.commands.total).toBe(12);
    expect(summary.commands.drawCalls).toBe(3);
    expect(summary.commands.byName).toEqual([
      { name: "uniform4f", count: 9 },
      { name: "drawElements", count: 3 },
    ]);
    expect(summary.commands.statuses.valid).toBe(12);
    expect(summary.programs).toHaveLength(6);
    const shaders = summary.programs.flatMap((program) => program.shaders);
    expect(shaders).toHaveLength(SCENE_LIMITS.maxSpectorShaders);
    expect(shaders.reduce((sum, shader) => sum + shader.source.length, 0)).toBeLessThanOrEqual(
      SCENE_LIMITS.maxSpectorTotalShaderChars,
    );
    expect(shaders[0]?.source.length).toBe(SCENE_LIMITS.maxSpectorShaderChars);
    expect(shaders[0]?.truncated).toBe(true);
    expect(summary.programsTruncated).toBe(false);
    expect(summary.shadersTruncated).toBe(true);
    expect(summary.context).toEqual({
      version: 2,
      attributes: { alpha: true, depth: 24, powerPreference: "default" },
    });
    expect(summary.analyses).toEqual([
      { name: "FrameStatistics", values: { frameTime: 16.6 } },
    ]);

    const serialized = JSON.stringify(summary);
    for (const raw of ["secret-arg", "stackTrace", "VisualState", "result", "initState", "endState", "memory"]) {
      expect(serialized).not.toContain(raw);
    }
  });

  it("disposes the capture on timeout and restores timing and WebGL hooks", async () => {
    const savedRaf = (globalThis as any).requestAnimationFrame;
    const savedWebGL = (globalThis as any).WebGLRenderingContext;
    const originalRaf = function originalRaf() {};
    const originalLink = function originalLinkProgram() {};
    const originalGet = function originalGetProgramParameter() {};
    (globalThis as any).requestAnimationFrame = originalRaf;
    (globalThis as any).WebGLRenderingContext = {
      prototype: { linkProgram: originalLink, getProgramParameter: originalGet },
    };

    // The selected context already owns linkProgram but inherits
    // getProgramParameter: disposal must restore the descriptor, not just
    // remove whatever unSpy() wrote.
    const inheritedGet = function inheritedGetProgramParameter() {};
    const pageOwnLink = function pageOwnLinkProgram() {};
    const fakeContext: any = Object.create({ getProgramParameter: inheritedGet });
    fakeContext.linkProgram = pageOwnLink;

    const unSpy = vi.fn();
    const canvasUnSpy = vi.fn();
    const instance: any = {
      // The frame Spector would have armed before the timeout, plus its retry
      // path that stopCapture() alone re-arms.
      captureNextFrames: 3,
      captureNextCommands: 5,
      capturingContext: { tag: "context" },
      retry: 2,
      noFrameTimeout: -1,
      onCapture: observable(),
      onError: observable(),
      onCaptureStarted: observable(),
      timeSpy: {
        onFrameStart: observable(),
        onFrameEnd: observable(),
        onError: observable(),
      },
      contexts: [{ contextSpy: { capturing: true, unSpy } }],
      canvasSpy: { unSpy: canvasUnSpy },
      captureCanvas() {},
      stopCapture() {},
    };
    class HookedSpector {
      static getFirstAvailable3dContext() {
        return fakeContext;
      }
      constructor() {
        // What TimeSpy.init() and ShaderCompileDelay.install() do in the real
        // constructor, before the probe arms its capture.
        (globalThis as any).__SPECTOR_Origin_requestAnimationFrame = originalRaf;
        (globalThis as any).requestAnimationFrame = function wrappedRaf() {};
        (globalThis as any).WebGLRenderingContext.prototype.linkProgram = function patchedLink() {};
        (globalThis as any).WebGLRenderingContext.prototype.getProgramParameter =
          function patchedGet() {};
        // ContextSpy.spy() replaces each context method with an own property.
        fakeContext.linkProgram = function spectorSpyLink() {};
        fakeContext.getProgramParameter = function spectorSpyGet() {};
        Object.assign(this, instance);
        created = this;
      }
    }
    let created: any = null;
    (globalThis as any).document = { querySelector: () => canvas };
    (globalThis as any).SPECTOR = { Spector: HookedSpector };

    try {
      const summary = await SCENE_SPECTOR_PROBE(spectorProbeCaps("canvas", 25));
      expect(summary).toEqual({ error: expect.stringMatching(/time budget/) });

      expect(unSpy).toHaveBeenCalled();
      expect(canvasUnSpy).toHaveBeenCalled();
      expect(created.captureNextFrames).toBe(0);
      expect(created.captureNextCommands).toBe(0);
      expect(created.capturingContext).toBeUndefined();
      expect(created.retry).toBe(0);
      expect(created.noFrameTimeout).toBe(-1);
      expect(Object.keys(instance.onCapture.handlers)).toHaveLength(0);
      expect(Object.keys(instance.onError.handlers)).toHaveLength(0);
      expect(Object.keys(instance.onCaptureStarted.handlers)).toHaveLength(0);
      expect(Object.keys(instance.timeSpy.onFrameStart.handlers)).toHaveLength(0);
      expect(Object.keys(instance.timeSpy.onFrameEnd.handlers)).toHaveLength(0);
      expect(Object.keys(instance.timeSpy.onError.handlers)).toHaveLength(0);

      expect((globalThis as any).requestAnimationFrame).toBe(originalRaf);
      expect("__SPECTOR_Origin_requestAnimationFrame" in globalThis).toBe(false);
      expect((globalThis as any).WebGLRenderingContext.prototype.linkProgram).toBe(originalLink);
      expect((globalThis as any).WebGLRenderingContext.prototype.getProgramParameter).toBe(
        originalGet,
      );
      // Context-level hooks: the original own descriptor comes back and an
      // originally inherited method loses the own property unSpy() wrote.
      expect(fakeContext.linkProgram).toBe(pageOwnLink);
      expect(Object.prototype.hasOwnProperty.call(fakeContext, "linkProgram")).toBe(true);
      expect(fakeContext.getProgramParameter).toBe(inheritedGet);
      expect(Object.prototype.hasOwnProperty.call(fakeContext, "getProgramParameter")).toBe(false);
    } finally {
      if (savedRaf === undefined) delete (globalThis as any).requestAnimationFrame;
      else (globalThis as any).requestAnimationFrame = savedRaf;
      if (savedWebGL === undefined) delete (globalThis as any).WebGLRenderingContext;
      else (globalThis as any).WebGLRenderingContext = savedWebGL;
    }
  });

  it("reports a missing bundle and a missing canvas as errors", async () => {
    (globalThis as any).document = { querySelector: () => null };
    expect(await SCENE_SPECTOR_PROBE(spectorProbeCaps("canvas", 20))).toEqual({
      error: expect.stringMatching(/bundle did not load/),
    });
    (globalThis as any).SPECTOR = { Spector: class {} };
    expect(await SCENE_SPECTOR_PROBE(spectorProbeCaps("canvas", 20))).toEqual({
      error: expect.stringMatching(/canvas is no longer/),
    });
  });

  it("wraps the bundle so it can load before the document exists", () => {
    const script = spectorInitScript("/*BUNDLE*/");
    expect(script).toContain("/*BUNDLE*/");
    expect(script).toContain("delete document.head");
    expect(SCENE_SPECTOR_PROBE.toString()).not.toContain("displayUI");
  });

  it("re-applies program, shader-count and total-source caps on a hostile summary", () => {
    type ProbeSummary = Parameters<typeof spectorFromProbe>[0];
    const probeSummary = (programs: ProbeSummary["programs"]): ProbeSummary => ({
      canvas: { width: 1, height: 1 },
      context: null,
      commands: {
        total: 0,
        drawCalls: 0,
        byName: [],
        statuses: { unknown: 0, unused: 0, disabled: 0, redundant: 0, valid: 0, deprecated: 0 },
      },
      programs,
      analyses: [],
      programsTruncated: false,
      shadersTruncated: false,
    });
    const program = (shaderCount: number, chars: number) => ({
      programStatus: { LINK_STATUS: true, VALIDATE_STATUS: true, infoLog: "x" },
      shaders: Array.from({ length: shaderCount }, () => ({
        type: "VERTEX_SHADER",
        source: "s".repeat(chars),
        length: chars,
        truncated: false,
      })),
    });

    const byProgram = spectorFromProbe(
      probeSummary(Array.from({ length: 12 }, () => program(1, 1_000))),
      null,
    );
    expect(byProgram.programs).toHaveLength(8);
    expect(byProgram.limits.programsTruncated).toBe(true);
    expect(byProgram.limits.shadersTruncated).toBe(false);

    const byShaders = spectorFromProbe(
      probeSummary(Array.from({ length: 8 }, () => program(3, 1_000))),
      null,
    );
    expect(byShaders.programs.flatMap((row) => row.shaders)).toHaveLength(16);
    expect(byShaders.limits.shadersTruncated).toBe(true);

    const byTotal = spectorFromProbe(probeSummary([program(5, 60_000)]), null);
    const shaders = byTotal.programs.flatMap((row) => row.shaders);
    expect(shaders.reduce((sum, shader) => sum + shader.source.length, 0)).toBe(
      SCENE_LIMITS.maxSpectorTotalShaderChars,
    );
    expect(shaders[shaders.length - 1]?.truncated).toBe(true);
    expect(byTotal.limits.shadersTruncated).toBe(true);
  });

  it("keeps an exact original shader length past the numeric counter cap", () => {
    type ProbeSummary = Parameters<typeof spectorFromProbe>[0];
    const source = "void main(){}";
    const withLength = (length: unknown): ProbeSummary => ({
      canvas: { width: 1, height: 1 },
      context: null,
      commands: {
        total: 0,
        drawCalls: 0,
        byName: [],
        statuses: { unknown: 0, unused: 0, disabled: 0, redundant: 0, valid: 0, deprecated: 0 },
      },
      programs: [
        {
          programStatus: { LINK_STATUS: true, VALIDATE_STATUS: true, infoLog: "" },
          shaders: [
            {
              type: "VERTEX_SHADER",
              source,
              length: length as number,
              truncated: true,
            },
          ],
        },
      ],
      analyses: [],
      programsTruncated: false,
      shadersTruncated: false,
    });
    const lengthOf = (value: unknown): number => {
      const result = spectorFromProbe(withLength(value), null);
      return result.programs[0]!.shaders[0]!.length;
    };

    // The counter cap is 1,000,000; a length must stay exact past it.
    expect(lengthOf(2_000_000)).toBe(2_000_000);
    expect(lengthOf(0)).toBe(source.length);
    expect(lengthOf(-5)).toBe(source.length);
    expect(lengthOf(Number.NaN)).toBe(source.length);
    expect(lengthOf(Number.POSITIVE_INFINITY)).toBe(source.length);
    expect(lengthOf(1e300)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("loads the installed optional bundle and reports a missing one as null", async () => {
    const bundle = await loadSpectorBundle();
    expect(bundle?.source).toContain("SPECTOR");
    expect(bundle?.version).toBe("0.9.33");
    expect(
      await loadSpectorBundle(() => {
        throw new Error("MODULE_NOT_FOUND");
      }),
    ).toBeNull();
  });
});

describe("CONNECT authority and origin exemptions", () => {
  it("preserves an explicit port and defaults to 443 only when absent", () => {
    expect(parseConnectAuthority("public.test:80")).toEqual({ hostname: "public.test", port: 80 });
    expect(parseConnectAuthority("public.test")).toEqual({ hostname: "public.test", port: 443 });
    expect(parseConnectAuthority("public.test:443")).toEqual({ hostname: "public.test", port: 443 });
    expect(parseConnectAuthority("[::1]:8443")).toEqual({ hostname: "::1", port: 8443 });
    expect(parseConnectAuthority("[::1]")).toEqual({ hostname: "::1", port: 443 });
    expect(parseConnectAuthority("user@public.test:443")).toBeNull();
    expect(parseConnectAuthority("public.test:0")).toBeNull();
    expect(parseConnectAuthority("public.test:65536")).toBeNull();
    expect(parseConnectAuthority("public.test:")).toBeNull();
    expect(parseConnectAuthority("")).toBeNull();
  });

  it("rejects a CONNECT authority that cannot form an origin", async () => {
    const gate = createSceneUrlGate(async () => ["127.0.0.1"], []);
    const proxy = await startSceneProxy(gate);
    try {
      const tunnel = await openTunnel(Number(new URL(proxy.url).port), "xn--:443");
      expect(tunnel.status).toBe(400);
      tunnel.socket.destroy();
    } finally {
      await proxy.close();
    }
  });

  it("builds an https origin with the default port normalized", () => {
    expect(sceneConnectOrigin({ hostname: "127.0.0.1", port: 443 })).toBe("https://127.0.0.1");
    expect(sceneConnectOrigin({ hostname: "127.0.0.1", port: 80 })).toBe("https://127.0.0.1:80");
    expect(sceneConnectOrigin({ hostname: "::1", port: 8443 })).toBe("https://[::1]:8443");
    expect(originsOf(["https://127.0.0.1:443"])).toEqual(["https://127.0.0.1"]);
  });

  it("dials an explicit CONNECT :80 and defaults an absent port to 443", async () => {
    const dialed: number[] = [];
    const dial: SceneDial = (options, onConnect) => {
      dialed.push(options.port);
      const upstream = new PassThrough();
      queueMicrotask(onConnect);
      return upstream;
    };
    const gate = createSceneUrlGate(
      async () => ["127.0.0.1"],
      originsOf(["https://public.test:80", "https://public.test"]),
    );
    const proxy = await startSceneProxy(gate, dial);
    const proxyPort = Number(new URL(proxy.url).port);
    try {
      const explicit = await openTunnel(proxyPort, "public.test:80");
      expect(explicit.status).toBe(200);
      explicit.socket.destroy();

      const implicit = await openTunnel(proxyPort, "public.test");
      expect(implicit.status).toBe(200);
      implicit.socket.destroy();

      // URL parsing used to drop :80 here and fall through to 443.
      expect(dialed).toEqual([80, 443]);
    } finally {
      await proxy.close();
    }
  });

  it("does not let an HTTP-only exemption authorize a CONNECT tunnel", async () => {
    const target = await startTcpServer();
    const gate = createSceneUrlGate(
      async () => ["127.0.0.1"],
      originsOf([`http://public.test:${target.port}`]),
    );
    const proxy = await startSceneProxy(gate);
    try {
      const tunnel = await openTunnel(
        Number(new URL(proxy.url).port),
        `public.test:${target.port}`,
      );
      expect(tunnel.status).toBe(403);
      tunnel.socket.destroy();
      expect(target.hits).toBe(0);
    } finally {
      await proxy.close();
      await target.close();
    }
  });

  it("dials an explicit non-default CONNECT port and requires the exact https origin", async () => {
    const target = await startTcpServer();
    const gate = createSceneUrlGate(
      async () => ["127.0.0.1"],
      originsOf([`https://public.test:${target.port}`]),
    );
    const proxy = await startSceneProxy(gate);
    const proxyPort = Number(new URL(proxy.url).port);
    try {
      const allowed = await openTunnel(proxyPort, `public.test:${target.port}`);
      expect(allowed.status).toBe(200);
      expect(target.hits).toBe(1);
      allowed.socket.destroy();

      const wrongPort = await openTunnel(proxyPort, "public.test:9");
      expect(wrongPort.status).toBe(403);
      wrongPort.socket.destroy();

      // No port means 443, which is not this allowlisted origin.
      const implicit = await openTunnel(proxyPort, "public.test");
      expect(implicit.status).toBe(403);
      implicit.socket.destroy();
      expect(target.hits).toBe(1);
    } finally {
      await proxy.close();
      await target.close();
    }
  });

  it("matches an HTTPS origin across its default port but not a different port", async () => {
    const defaultGate = createSceneUrlGate(resolveHost, originsOf(["https://127.0.0.1:443"]));
    expect(
      await defaultGate.connectAddress("127.0.0.1", 443, [
        sceneConnectOrigin({ hostname: "127.0.0.1", port: 443 }),
      ]),
    ).toBe("127.0.0.1");

    const nonDefault = createSceneUrlGate(resolveHost, originsOf(["https://127.0.0.1:8443"]));
    expect(
      await nonDefault.connectAddress("127.0.0.1", 8443, [
        sceneConnectOrigin({ hostname: "127.0.0.1", port: 8443 }),
      ]),
    ).toBe("127.0.0.1");
    expect(
      await nonDefault.connectAddress("127.0.0.1", 8444, [
        sceneConnectOrigin({ hostname: "127.0.0.1", port: 8444 }),
      ]),
    ).toBeNull();
    expect(
      await nonDefault.connectAddress("127.0.0.1", 443, [
        sceneConnectOrigin({ hostname: "127.0.0.1", port: 443 }),
      ]),
    ).toBeNull();
    // The HTTPS exemption also must not authorize a plain HTTP request.
    expect(await nonDefault.allows("http://127.0.0.1:8443/app")).toBe(false);
  });

  it("destroys both ends of an upgraded CONNECT tunnel when the proxy closes", async () => {
    const target = await startTcpServer();
    const gate = createSceneUrlGate(
      async () => ["127.0.0.1"],
      originsOf([`https://public.test:${target.port}`]),
    );
    const proxy = await startSceneProxy(gate);
    try {
      const tunnel = await openTunnel(
        Number(new URL(proxy.url).port),
        `public.test:${target.port}`,
      );
      expect(tunnel.status).toBe(200);
      await vi.waitFor(() => expect(target.sockets).toHaveLength(1));
      const serverSide = target.sockets[0]!;

      const started = Date.now();
      await proxy.close();
      expect(Date.now() - started).toBeLessThan(3_000);
      await expect(proxy.close()).resolves.toBeUndefined();
      await vi.waitFor(
        () => {
          expect(tunnel.socket.destroyed).toBe(true);
          expect(serverSide.destroyed).toBe(true);
        },
        { timeout: 3_000 },
      );
      tunnel.socket.destroy();
    } finally {
      await proxy.close();
      await target.close();
    }
  });

  it("closes while a CONNECT gate lookup is pending and never dials late", async () => {
    let releaseGate!: (address: string | null) => void;
    let lookupStarted!: () => void;
    const startedLookup = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    const pending = new Promise<string | null>((resolve) => {
      releaseGate = resolve;
    });
    const gate: SceneUrlGate = {
      allows: async () => true,
      connectAddress: () => {
        lookupStarted();
        return pending;
      },
      blocked: { count: 0, samples: [] },
    };
    const dial = vi.fn(() => new PassThrough());
    const proxy = await startSceneProxy(gate, dial);
    const socket = netConnect({ host: "127.0.0.1", port: Number(new URL(proxy.url).port) });
    socket.on("error", () => undefined);
    try {
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      socket.write("CONNECT public.test:443 HTTP/1.1\r\n\r\n");
      await startedLookup;

      const started = Date.now();
      await proxy.close();
      expect(Date.now() - started).toBeLessThan(3_000);
      await vi.waitFor(() => expect(socket.destroyed).toBe(true));
      releaseGate("127.0.0.1");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(dial).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
      await proxy.close();
    }
  });

  it("survives a client reset while the CONNECT gate is pending", async () => {
    let releaseGate: (value: string | null) => void = () => undefined;
    let lookupStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    const pending = new Promise<string | null>((resolve) => {
      releaseGate = resolve;
    });
    const gate: SceneUrlGate = {
      allows: async () => true,
      connectAddress: () => {
        lookupStarted();
        return pending;
      },
      blocked: { count: 0, samples: [] },
    };
    const dial = vi.fn(() => new PassThrough());
    const proxy = await startSceneProxy(gate, dial);
    const socket = netConnect({ host: "127.0.0.1", port: Number(new URL(proxy.url).port) });
    socket.on("error", () => undefined);
    try {
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      socket.write("CONNECT public.test:443 HTTP/1.1\r\n\r\n");
      await started;
      socket.resetAndDestroy();
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseGate("127.0.0.1");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(dial).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
      await proxy.close();
    }
  });
});
