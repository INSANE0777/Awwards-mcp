import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCENE_ASSET_LIMITS,
  downloadSceneAssets,
  safeSceneDownloadUrl,
  sceneAssetExtension,
  type SceneAssetFetcher,
  type SceneAssetHop,
  type SceneAssetsResult,
} from "../src/scene-assets.js";
import { sceneDownloadTarget, SCENE_LIMITS } from "../src/scene-capture.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-scene-assets-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const captureId = "scene-mg2k3j4p-0123abcd";
const rights = { basis: "licensed" as const, evidence: "CC BY 4.0, attribution recorded" };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

interface InventoryRow {
  assetId: string;
  url?: string;
  download?: unknown;
  mime?: string;
}

/** Writes a minimal but real evidence.json into a fresh scene-captures root. */
function captureWith(rows: InventoryRow[]): { root: string; dir: string } {
  const root = join(tmpDir(), "scene-captures");
  const dir = join(root, captureId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "evidence.json"),
    JSON.stringify({
      id: "scene-evidence-v1",
      captureId,
      resources: rows.map((row) => ({
        assetId: row.assetId,
        url: row.url ?? `https://cdn.test/${row.assetId}.png`,
        origin: "https://cdn.test",
        mime: row.mime ?? "image/png",
        bytes: null,
        resourceType: "image",
        classification: "image",
        discovery: "response",
        assetOrigin: false,
        download:
          row.download ??
          ({ status: "available", url: row.url ?? `https://cdn.test/${row.assetId}.png` } as const),
      })),
    }),
  );
  return { root, dir };
}

const publicResolveHost = async (host: string): Promise<string[]> =>
  host === "private.test" ? ["10.0.0.5"] : ["93.184.216.34"];

function hop(
  status: number,
  headers: Record<string, string>,
  chunks: Buffer[] = [],
  options: { stall?: boolean } = {},
): SceneAssetHop {
  const body = (async function* () {
    for (const chunk of chunks) yield chunk;
    if (options.stall) await new Promise<void>(() => undefined);
  })();
  return { status, headers, body, destroy: () => undefined };
}

function download(
  root: string,
  assetIds: string[],
  fetch: SceneAssetFetcher,
  extra: Record<string, unknown> = {},
) {
  return downloadSceneAssets({
    sceneDir: root,
    captureId,
    assetIds,
    rights,
    resolveHost: publicResolveHost,
    fetch,
    limits: { minRequestIntervalMs: 0 },
    ...extra,
  });
}

function assetsOf(result: SceneAssetsResult | { error: string }): SceneAssetsResult {
  if ("error" in result) throw new Error(result.error);
  return result;
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

describe("safeSceneDownloadUrl / sceneDownloadTarget", () => {
  it("only allows http(s) origin+pathname without credentials, query or hash", () => {
    expect(safeSceneDownloadUrl("https://cdn.test/a.png")).toBe("https://cdn.test/a.png");
    expect(safeSceneDownloadUrl("https://user:pw@cdn.test/a.png")).toBeNull();
    expect(safeSceneDownloadUrl("https://cdn.test/a.png?token=secret")).toBeNull();
    expect(safeSceneDownloadUrl("https://cdn.test/a.png#frag")).toBeNull();
    expect(safeSceneDownloadUrl("file:///etc/passwd")).toBeNull();
    expect(safeSceneDownloadUrl("not a url")).toBeNull();
  });

  it("marks query-string and credential observations not downloadable with a reason", () => {
    expect(sceneDownloadTarget("https://cdn.test/rock.png?token=secret")).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/query/i),
    });
    expect(sceneDownloadTarget("https://user:pw@cdn.test/a.png")).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/credentials/i),
    });
    expect(sceneDownloadTarget("https://cdn.test/model.glb")).toEqual({
      status: "available",
      url: "https://cdn.test/model.glb",
    });
  });

  it("marks an overlong observed URL not downloadable instead of truncating it", () => {
    const long = `https://cdn.test/${"a".repeat(SCENE_LIMITS.maxResourceUrlChars)}.png`;
    expect(sceneDownloadTarget(long)).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/longer than 2048/),
    });
  });
});

describe("sceneAssetExtension", () => {
  const url = new URL("https://cdn.test/a");

  it("trusts magic bytes, then MIME, and refuses unknown types unless explicit", () => {
    expect(sceneAssetExtension(PNG, "text/plain", url, false)).toBe("png");
    expect(sceneAssetExtension(Buffer.from("glTFpayload"), "image/png", url, false)).toBe("glb");
    expect(sceneAssetExtension(Buffer.from("KTX"), "image/ktx2", url, false)).toBe("ktx2");
    expect(sceneAssetExtension(Buffer.from("<html>"), "text/html", url, false)).toBeNull();
    expect(sceneAssetExtension(Buffer.from("<html>"), "text/html", url, true)).toBe("bin");
    expect(sceneAssetExtension(Buffer.from([0]), "application/octet-stream", url, false)).toBe("bin");
    // Object.prototype names are not MIME types.
    expect(sceneAssetExtension(Buffer.from("<html>"), "constructor", url, false)).toBeNull();
  });
});

describe("downloadSceneAssets confinement", () => {
  const fetch = (async () => hop(200, { "content-type": "image/png" }, [PNG])) as SceneAssetFetcher;

  it("rejects traversal and unknown captureIds before touching the filesystem", async () => {
    const { root } = captureWith([{ assetId: "asset-1" }]);
    for (const bad of ["../../etc", "scene-x-0123abcd/../../y", `${captureId}/../x`, ""]) {
      const result = await downloadSceneAssets({
        sceneDir: root,
        captureId: bad,
        assetIds: ["asset-1"],
        rights,
        fetch,
        resolveHost: publicResolveHost,
      });
      expect("error" in result, bad).toBe(true);
    }
    const missing = await downloadSceneAssets({
      sceneDir: root,
      captureId: "scene-mg2k3j4p-ffffffff",
      assetIds: ["asset-1"],
      rights,
      fetch,
      resolveHost: publicResolveHost,
    });
    expect(missing).toHaveProperty("error");
  });

  it("rejects a symlinked capture directory that points outside the root", async () => {
    const root = join(tmpDir(), "scene-captures");
    mkdirSync(root, { recursive: true });
    const outside = join(tmpDir(), "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "evidence.json"), JSON.stringify({ id: "scene-evidence-v1", captureId, resources: [] }));
    try {
      symlinkSync(outside, join(root, captureId), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // symlink creation is privilege-gated on some Windows setups
    }
    const result = await downloadSceneAssets({
      sceneDir: root,
      captureId,
      assetIds: ["asset-1"],
      rights,
      fetch,
      resolveHost: publicResolveHost,
    });
    expect(result).toHaveProperty("error");
  });

  it("rejects assetId traversal and IDs that are not in the capture inventory", async () => {
    const { root } = captureWith([{ assetId: "asset-1" }]);
    const traversal = await download(root, ["../../etc/passwd"], fetch);
    expect(traversal).toHaveProperty("error");
    const unknown = await download(root, ["asset-9"], fetch);
    expect(unknown).toHaveProperty("error");
    expect(("error" in unknown && unknown.error) || "").toMatch(/not in this capture's inventory/);
  });

  it("skips inventory rows that were marked not downloadable, with the stored reason", async () => {
    const { root } = captureWith([
      { assetId: "asset-1", download: { status: "skipped", reason: "the observed URL has a query string" } },
    ]);
    let calls = 0;
    const result = assetsOf(await download(root, ["asset-1"], async () => {
      calls += 1;
      return hop(200, { "content-type": "image/png" }, [PNG]);
    }));
    expect(calls).toBe(0);
    expect(result).toMatchObject({ downloaded: 0, skipped: 1, totalBytes: 0, files: [] });
    expect(result.limitations.join(" ")).toMatch(/asset-1 skipped: .*query string/);
  });
});

describe("downloadSceneAssets transfers", () => {
  it("writes original bytes with SHA-256, MIME-validated extension and provenance", async () => {
    const { root, dir } = captureWith([{ assetId: "asset-1", url: "https://cdn.test/model" }]);
    const result = assetsOf(
      await download(
        root,
        ["asset-1"],
        async () => hop(200, { "content-type": "image/png; charset=binary" }, [PNG.subarray(0, 4), PNG.subarray(4)]),
        { now: () => 1_700_000_000_000 },
      ),
    );
    expect(result.id).toBe("scene-assets-v1");
    expect(result).toMatchObject({ downloaded: 1, skipped: 0, totalBytes: PNG.length });
    expect(result.rights).toEqual({ ...rights, recordedAt: 1_700_000_000_000 });
    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    expect(file.assetId).toBe("asset-1");
    expect(realpathSync.native(file.path)).toBe(realpathSync.native(join(dir, "assets", "asset-1.png")));
    expect(file.sha256).toBe(sha256(PNG));
    expect(file.mime).toBe("image/png");
    expect(readFileSync(file.path).equals(PNG)).toBe(true);

    const provenance = JSON.parse(readFileSync(join(dir, "provenance.json"), "utf8"));
    expect(provenance).toMatchObject({
      id: "scene-assets-provenance-v1",
      captureId,
      rights: [{ ...rights, recordedAt: 1_700_000_000_000 }],
      files: [{ assetId: "asset-1", sha256: sha256(PNG), bytes: PNG.length }],
    });
    // Nothing partial survives a successful publish.
    expect(readdirSync(join(dir, "assets")).filter((name) => name.includes(".partial-"))).toEqual([]);
  });

  it("rejects a body over the per-file cap without leaving a partial file", async () => {
    const { root, dir } = captureWith([{ assetId: "asset-1", url: "https://cdn.test/big.png" }]);
    const result = assetsOf(
      await download(
        root,
        ["asset-1"],
        async () => hop(200, { "content-type": "image/png" }, [Buffer.concat([PNG, Buffer.alloc(32)])]),
        { limits: { minRequestIntervalMs: 0, maxFileBytes: 16 } },
      ),
    );
    expect(result).toMatchObject({ downloaded: 0, skipped: 1, files: [] });
    expect(result.limitations.join(" ")).toMatch(/per-file cap/);
    expect(readdirSync(join(dir, "assets"))).toEqual([]);
  });

  it("rejects an oversized declared Content-Length before reading the body", async () => {
    const { root, dir } = captureWith([{ assetId: "asset-1", url: "https://cdn.test/big.png" }]);
    const result = assetsOf(
      await download(
        root,
        ["asset-1"],
        async () => hop(200, { "content-type": "image/png", "content-length": "999999" }, [PNG]),
        { limits: { minRequestIntervalMs: 0, maxFileBytes: 16 } },
      ),
    );
    expect(result).toMatchObject({ downloaded: 0, skipped: 1 });
    expect(result.limitations.join(" ")).toMatch(/per-file cap/);
    expect(readdirSync(join(dir, "assets"))).toEqual([]);
  });

  it("aborts a stalled body on the deadline and leaves no partial file", async () => {
    const { root, dir } = captureWith([{ assetId: "asset-1", url: "https://cdn.test/stall.png" }]);
    const result = assetsOf(
      await download(root, ["asset-1"], async () => hop(200, { "content-type": "image/png" }, [], { stall: true }), {
        limits: { minRequestIntervalMs: 0, bodyDeadlineMs: 50 },
      }),
    );
    expect(result).toMatchObject({ downloaded: 0, skipped: 1 });
    expect(result.limitations.join(" ")).toMatch(/did not finish within/);
    expect(readdirSync(join(dir, "assets"))).toEqual([]);
  });

  it("aborts a connection that never answers at the overall deadline", async () => {
    const { root } = captureWith([
      { assetId: "asset-1", url: "https://cdn.test/a.png" },
      { assetId: "asset-2", url: "https://cdn.test/b.png" },
    ]);
    let calls = 0;
    const result = assetsOf(
      await download(
        root,
        ["asset-1", "asset-2"],
        async () => {
          calls += 1;
          return new Promise<never>(() => undefined);
        },
        { limits: { minRequestIntervalMs: 0, overallDeadlineMs: 50 } },
      ),
    );
    expect(result).toMatchObject({ downloaded: 0, skipped: 2 });
    expect(result.limitations.join(" ")).toMatch(/overall deadline/);
    expect(calls).toBe(1);
  });

  it("aborts a hanging DNS lookup at the overall deadline and releases the queue", async () => {
    const { root } = captureWith([{ assetId: "asset-1", url: "https://slow.test/a.png" }]);
    const started = Date.now();
    let calls = 0;
    const result = assetsOf(
      await download(
        root,
        ["asset-1"],
        async () => {
          calls += 1;
          return hop(200, { "content-type": "image/png" }, [PNG]);
        },
        {
          resolveHost: () => new Promise<string[]>(() => undefined),
          limits: { minRequestIntervalMs: 0, overallDeadlineMs: 50 },
        },
      ),
    );
    expect(calls).toBe(0);
    expect(result).toMatchObject({ downloaded: 0, skipped: 1, receivedBytes: 0 });
    expect(result.limitations.join(" ")).toMatch(/overall deadline/);
    expect(Date.now() - started).toBeLessThan(5_000);

    // The queue slot is free again: a normal lookup can download.
    const queued = assetsOf(
      await download(root, ["asset-1"], async () =>
        hop(200, { "content-type": "image/png" }, [PNG]),
      ),
    );
    expect(queued).toMatchObject({ downloaded: 1, totalBytes: PNG.length });
  });

  it("returns a cancelled result without DNS or fetch when already aborted", async () => {
    const { root } = captureWith([
      { assetId: "asset-1", url: "https://cdn.test/a.png" },
      { assetId: "asset-2", url: "https://cdn.test/b.png" },
    ]);
    let lookups = 0;
    let fetches = 0;
    const result = assetsOf(
      await download(
        root,
        ["asset-1", "asset-2"],
        async () => {
          fetches += 1;
          return hop(200, { "content-type": "image/png" }, [PNG]);
        },
        {
          signal: AbortSignal.abort(),
          resolveHost: async () => {
            lookups += 1;
            return ["93.184.216.34"];
          },
        },
      ),
    );
    expect(result).toMatchObject({
      downloaded: 0,
      skipped: 2,
      receivedBytes: 0,
      totalBytes: 0,
      cancelled: true,
    });
    expect(result.limitations.join(" ")).toMatch(/cancelled by the client/);
    expect(result.limitations.filter((line) => line.includes("skipped: cancelled by the client"))).toHaveLength(2);
    expect(lookups).toBe(0);
    expect(fetches).toBe(0);
  });

  it("a live abort during a pending DNS lookup returns promptly and frees the queue", async () => {
    const { root } = captureWith([{ assetId: "asset-1", url: "https://slow.test/a.png" }]);
    const controller = new AbortController();
    let fetches = 0;
    const started = Date.now();
    const pending = download(
      root,
      ["asset-1"],
      async () => {
        fetches += 1;
        return hop(200, { "content-type": "image/png" }, [PNG]);
      },
      { resolveHost: () => new Promise<string[]>(() => undefined), signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);
    const result = assetsOf(await pending);
    expect(result).toMatchObject({ downloaded: 0, skipped: 1, receivedBytes: 0, cancelled: true });
    expect(result.limitations.join(" ")).toMatch(/cancelled by the client/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fetches).toBe(0);

    const queued = assetsOf(
      await download(root, ["asset-1"], async () =>
        hop(200, { "content-type": "image/png" }, [PNG]),
      ),
    );
    expect(queued).toMatchObject({ downloaded: 1, totalBytes: PNG.length });
    expect("cancelled" in queued).toBe(false);
  });

  it("a live abort stops before the next job, aborts the body and keeps received-byte accounting", async () => {
    const { root, dir } = captureWith([
      { assetId: "asset-1", url: "https://cdn.test/a.png" },
      { assetId: "asset-2", url: "https://cdn.test/b.png" },
    ]);
    const controller = new AbortController();
    let fetches = 0;
    let destroyed = 0;
    let chunkRead!: () => void;
    const firstChunk = new Promise<void>((resolve) => (chunkRead = resolve));
    const body = (async function* () {
      yield PNG;
      chunkRead();
      await new Promise<void>(() => undefined);
    })();
    const pending = download(
      root,
      ["asset-1", "asset-2"],
      async () => {
        fetches += 1;
        return {
          status: 200,
          headers: { "content-type": "image/png" },
          body,
          destroy: () => {
            destroyed += 1;
          },
        };
      },
      { signal: controller.signal },
    );
    await firstChunk;
    const started = Date.now();
    controller.abort();
    const result = assetsOf(await pending);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fetches).toBe(1);
    expect(result).toMatchObject({
      downloaded: 0,
      skipped: 2,
      receivedBytes: PNG.length,
      totalBytes: 0,
      cancelled: true,
    });
    expect(result.limitations.join(" ")).toMatch(/cancelled by the client/);
    expect(destroyed).toBeGreaterThanOrEqual(1);
    expect(readdirSync(join(dir, "assets"))).toEqual([]);
  });

  it("blocks a redirect hop that resolves to a private address", async () => {
    const { root, dir } = captureWith([{ assetId: "asset-1", url: "https://cdn.test/r.png" }]);
    const hosts: string[] = [];
    const fetcher: SceneAssetFetcher = async (url) => {
      hosts.push(url.hostname);
      if (url.hostname === "cdn.test") {
        return hop(302, { location: "https://private.test/secret.png" });
      }
      return hop(200, { "content-type": "image/png" }, [PNG]);
    };
    const result = assetsOf(await download(root, ["asset-1"], fetcher));
    expect(result).toMatchObject({ downloaded: 0, skipped: 1 });
    expect(result.limitations.join(" ")).toMatch(/private|loopback|reserved/i);
    // The second hop was never dialed.
    expect(hosts).toEqual(["cdn.test"]);
    expect(readdirSync(join(dir, "assets"))).toEqual([]);
  });

  it("blocks a direct private target before any connection", async () => {
    const { root } = captureWith([{ assetId: "asset-1", url: "https://private.test/a.png" }]);
    let calls = 0;
    const result = assetsOf(
      await download(root, ["asset-1"], async () => {
        calls += 1;
        return hop(200, { "content-type": "image/png" }, [PNG]);
      }),
    );
    expect(calls).toBe(0);
    expect(result).toMatchObject({ downloaded: 0, skipped: 1 });
    expect(result.limitations.join(" ")).toMatch(/loopback|private|metadata|reserved/i);
  });

  it("refuses more than five manual redirects", async () => {
    const { root } = captureWith([{ assetId: "asset-1", url: "https://cdn.test/0.png" }]);
    let calls = 0;
    const fetcher: SceneAssetFetcher = async (url) => {
      calls += 1;
      return hop(302, { location: `https://cdn.test/${calls}.png` });
    };
    const result = assetsOf(await download(root, ["asset-1"], fetcher));
    expect(result).toMatchObject({ downloaded: 0, skipped: 1 });
    expect(result.limitations.join(" ")).toMatch(/more than 5 redirects/);
    expect(calls).toBe(SCENE_ASSET_LIMITS.maxRedirects + 1);
  });

  it("applies the safe-URL rule to every redirect target", async () => {
    const { root, dir } = captureWith([
      { assetId: "asset-1", url: "https://cdn.test/1.png" },
      { assetId: "asset-2", url: "https://cdn.test/2.png" },
      { assetId: "asset-3", url: "https://cdn.test/3.png" },
    ]);
    const redirects: Record<string, string> = {
      "/1.png": "https://cdn.test/secret.png?token=secret",
      "/2.png": "https://cdn.test/secret.png#fragment",
      "/3.png": "https://user:pw@cdn.test/secret.png",
    };
    const visited: string[] = [];
    const fetcher: SceneAssetFetcher = async (url) => {
      visited.push(url.href);
      const location = redirects[url.pathname];
      return location
        ? hop(302, { location })
        : hop(200, { "content-type": "image/png" }, [PNG]);
    };
    const result = assetsOf(await download(root, ["asset-1", "asset-2", "asset-3"], fetcher));
    expect(result).toMatchObject({
      downloaded: 0,
      skipped: 3,
      receivedBytes: 0,
      totalBytes: 0,
      files: [],
    });
    // Only the clean initial URLs were dialed; the unsafe targets never were.
    expect(visited).toEqual([
      "https://cdn.test/1.png",
      "https://cdn.test/2.png",
      "https://cdn.test/3.png",
    ]);
    expect(result.limitations.join(" ")).toMatch(
      /redirect target has a query string, fragment or credentials/,
    );
    expect(readdirSync(join(dir, "assets"))).toEqual([]);
  });

  it("stops at the total cap and counts the remaining assets as skipped", async () => {
    const { root, dir } = captureWith([
      { assetId: "asset-1", url: "https://cdn.test/a.png" },
      { assetId: "asset-2", url: "https://cdn.test/b.png" },
      { assetId: "asset-3", url: "https://cdn.test/c.png" },
    ]);
    const bytes = Buffer.concat([PNG, Buffer.alloc(4)]);
    const result = assetsOf(
      await download(root, ["asset-1", "asset-2", "asset-3"], async () => hop(200, { "content-type": "image/png" }, [bytes]), {
        limits: { minRequestIntervalMs: 0, maxFileBytes: bytes.length, maxTotalBytes: bytes.length + 4 },
      }),
    );
    expect(result.downloaded).toBe(1);
    expect(result.skipped).toBe(2);
    expect(realpathSync.native(result.files[0].path)).toBe(realpathSync.native(join(dir, "assets", "asset-1.png")));
    expect(result.limitations.join(" ")).toMatch(/total cap/);
    expect(readdirSync(join(dir, "assets"))).toEqual(["asset-1.png"]);
  });

  it("skips unknown types unless allowUnknown saves them as .bin", async () => {
    const { root, dir } = captureWith([
      { assetId: "asset-1", url: "https://cdn.test/unknown" },
      { assetId: "asset-2", url: "https://cdn.test/unknown2" },
    ]);
    const fetcher: SceneAssetFetcher = async () =>
      hop(200, { "content-type": "text/html" }, [Buffer.from("<html>nope</html>")]);
    const strict = assetsOf(await download(root, ["asset-1"], fetcher));
    expect(strict).toMatchObject({ downloaded: 0, skipped: 1 });
    expect(strict.limitations.join(" ")).toMatch(/not a recognised asset type/);

    const allowed = assetsOf(await download(root, ["asset-2"], fetcher, { allowUnknown: true }));
    expect(allowed.downloaded).toBe(1);
    expect(allowed.files[0].path && realpathSync.native(allowed.files[0].path)).toBe(realpathSync.native(join(dir, "assets", "asset-2.bin")));
  });

  it("treats a Content-Type of constructor as unknown, not an extension", async () => {
    const { root, dir } = captureWith([{ assetId: "asset-1", url: "https://cdn.test/odd" }]);
    const result = assetsOf(
      await download(root, ["asset-1"], async () =>
        hop(200, { "content-type": "constructor" }, [Buffer.from("<html>")]),
      ),
    );
    expect(result).toMatchObject({
      downloaded: 0,
      skipped: 1,
      receivedBytes: 6,
      totalBytes: 0,
      files: [],
    });
    expect(result.limitations.join(" ")).toMatch(/not a recognised asset type/);
    expect(readdirSync(join(dir, "assets"))).toEqual([]);
  });

  it("counts discarded bodies against the run total and stops", async () => {
    const { root, dir } = captureWith([
      { assetId: "asset-1", url: "https://cdn.test/1" },
      { assetId: "asset-2", url: "https://cdn.test/2" },
      { assetId: "asset-3", url: "https://cdn.test/3" },
    ]);
    // Unknown-type bodies are discarded, but still consume the 1 MiB run cap.
    const discarded = Buffer.alloc(700 * 1024, 0x61);
    let calls = 0;
    const result = assetsOf(
      await download(
        root,
        ["asset-1", "asset-2", "asset-3"],
        async () => {
          calls += 1;
          return hop(200, { "content-type": "text/html" }, [discarded]);
        },
        { limits: { minRequestIntervalMs: 0, maxTotalBytes: 1024 * 1024 } },
      ),
    );
    expect(result).toMatchObject({
      downloaded: 0,
      skipped: 3,
      receivedBytes: discarded.length * 2,
      totalBytes: 0,
      files: [],
    });
    expect(calls).toBe(2);
    expect(result.limitations.join(" ")).toMatch(/total cap/);
    expect(readdirSync(join(dir, "assets"))).toEqual([]);
  });

  it("counts bytes from a failed transfer against the run total", async () => {
    const { root } = captureWith([
      { assetId: "asset-1", url: "https://cdn.test/broken" },
      { assetId: "asset-2", url: "https://cdn.test/next.png" },
    ]);
    const partial = Buffer.alloc(70, 0x61);
    const broken: SceneAssetHop = {
      status: 200,
      headers: { "content-type": "image/png" },
      body: (async function* () {
        yield partial;
        throw new Error("connection reset");
      })(),
      destroy: () => undefined,
    };
    let calls = 0;
    const result = assetsOf(
      await download(
        root,
        ["asset-1", "asset-2"],
        async () => {
          calls += 1;
          return calls === 1
            ? broken
            : hop(200, { "content-type": "image/png" }, [PNG]);
        },
        { limits: { minRequestIntervalMs: 0, maxTotalBytes: 80 } },
      ),
    );
    expect(calls).toBe(2);
    // 70 failed bytes left only 10 of the 80-byte run cap, so the 12-byte
    // second body overflows it even though nothing was ever saved.
    expect(result).toMatchObject({
      downloaded: 0,
      skipped: 2,
      receivedBytes: partial.length + PNG.length,
      totalBytes: 0,
      files: [],
    });
    expect(result.limitations.join(" ")).toMatch(/transfer failed/);
    expect(result.limitations.join(" ")).toMatch(/total cap/);
  });
});

describe("downloadSceneAssets real loopback fixture", () => {
  async function fixture(): Promise<{ server: Server; origin: string; hits: number[] }> {
    const hits: number[] = [];
    const server = createHttpServer((req, res) => {
      hits.push(Date.now());
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(PNG.length),
      });
      res.end(PNG);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { server, origin: `http://127.0.0.1:${port}`, hits };
  }

  it("downloads through the test-only loopback allowance at one request per second", async () => {
    const { server, origin, hits } = await fixture();
    try {
      const { root, dir } = captureWith([
        { assetId: "asset-1", url: `${origin}/a.png` },
        { assetId: "asset-2", url: `${origin}/b.png` },
      ]);
      const result = assetsOf(
        await downloadSceneAssets({
          sceneDir: root,
          captureId,
          assetIds: ["asset-1", "asset-2"],
          rights,
          allowPrivateOrigins: [origin],
        }),
      );

      expect(result).toMatchObject({ downloaded: 2, skipped: 0, totalBytes: PNG.length * 2 });
      for (const file of result.files) {
        expect(file.sha256).toBe(sha256(PNG));
        expect(file.mime).toBe("image/png");
        expect(readFileSync(file.path).equals(PNG)).toBe(true);
      }
      expect(result.files.map((file) => realpathSync.native(file.path))).toEqual([
        realpathSync.native(join(dir, "assets", "asset-1.png")),
        realpathSync.native(join(dir, "assets", "asset-2.png")),
      ]);
      expect(hits).toHaveLength(2);
      // The default 1 s spacing is not disabled by the allowance.
      expect(hits[1]! - hits[0]!).toBeGreaterThanOrEqual(950);
      expect(JSON.parse(readFileSync(join(dir, "provenance.json"), "utf8")).files).toHaveLength(2);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it("refuses the same loopback target without the allowance", async () => {
    const { server, origin, hits } = await fixture();
    try {
      const { root } = captureWith([{ assetId: "asset-1", url: `${origin}/a.png` }]);
      const result = assetsOf(
        await downloadSceneAssets({
          sceneDir: root,
          captureId,
          assetIds: ["asset-1"],
          rights,
        }),
      );
      expect(hits).toHaveLength(0);
      expect(result).toMatchObject({ downloaded: 0, skipped: 1 });
      expect(result.limitations.join(" ")).toMatch(/loopback|private|metadata|reserved/i);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});
