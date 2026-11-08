import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import { collectAtlasPage } from "../src/atlas/collector.js";
import { acquireAtlasCaptureLease } from "../src/atlas/lease.js";
import { publishCapture } from "../src/atlas/publish.js";
import { loadPhase2Fixture } from "./helpers/phase2-fixture.js";
import type { SiteSummary } from "../src/types.js";

const dirs: string[] = [];
const servers: Array<{ close(cb?: () => void): void }> = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-collector-"));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

const site = (liveUrl: string | null): SiteSummary => ({
  id: 1,
  slug: "fixture-live",
  title: "Fixture",
  createdAt: 1,
  tags: [],
  thumbnailPath: "submissions/fixture.jpg",
  liveUrl,
  detailPath: "/sites/fixture-live",
  awards: [],
  studio: "Studio",
});

async function fixtureServer(): Promise<{ origin: string }> {
  const server = createServer((req, res) => {
    if (req.url === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><main><h1>Fixture</h1></main></body></html>");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address missing");
  return { origin: `http://127.0.0.1:${address.port}` };
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function fakeBrowser(scan: any) {
  let contexts = 0;
  let closed = false;
  const makeContext = () => {
    contexts += 1;
    let pageUrl = "";
    const page = {
      route: async () => undefined,
      goto: async (url: string) => {
        pageUrl = url;
        return { status: () => 200 };
      },
      url: () => pageUrl,
      evaluate: async () => undefined,
      screenshot: async () => Buffer.from(PNG),
      close: async () => undefined,
    };
    return {
      page,
      context: {
        newPage: async () => page,
        on: () => undefined,
        close: async () => undefined,
      },
    };
  };
  const pending: ReturnType<typeof makeContext>[] = [];
  const browser = {
    newContext: async () => {
      const entry = makeContext();
      pending.push(entry);
      return entry.context;
    },
    version: () => "fake-browser-1",
    close: async () => {
      closed = true;
    },
  };
  return {
    browser,
    contexts: () => contexts,
    closed: () => closed,
  };
}

describe("Atlas collector lifecycle", () => {
  it("collects desktop and mobile in one guarded lifecycle and closes everything", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const { scan } = loadPhase2Fixture();
    const fake = fakeBrowser(scan);
    const screenshots: string[] = [];
    const attempt = await collectAtlasPage(
      { siteSlug: "fixture-live" },
      {
        cache,
        allowPrivateOrigins: [origin],
        loader: async () => ({ chromium: { launch: async () => fake.browser } }),
        settle: async () => undefined,
        scanPage: async () => ({ ...scan, url: `${origin}/` }),
        screenshot: async () => {
          screenshots.push("shot");
          return Buffer.from(PNG);
        },
        totalBudgetMs: 30_000,
      },
    );
    expect(attempt.error).toBeUndefined();
    // 8200px at 900/844px viewports needs ten checkpoints, capped at six.
    expect(attempt.limitations).toEqual(["CHECKPOINT_LIMIT"]);
    expect(attempt.status).toBe("partial");
    expect(attempt.viewports.map((item) => item.viewport)).toEqual(["desktop", "mobile"]);
    expect(fake.contexts()).toBe(2);
    expect(fake.closed()).toBe(true);
    expect(attempt.artifacts.filter((item) => item.kind === "raw_observation").length).toBeGreaterThanOrEqual(2);
    expect(
      attempt.viewports.every(
        (item) =>
          (item.observations?.length ?? 0) === item.screenshots.length + 1 &&
          item.observations!.every((observation) =>
            attempt.artifacts.some((artifact) => artifact.key === observation.scanArtifactKey),
          ),
      ),
    ).toBe(true);
    expect(attempt.artifacts.filter((item) => item.kind === "screenshot").length).toBeGreaterThan(0);
    expect(screenshots.length).toBeGreaterThan(0);
    expect(attempt.viewports.every((item) => item.regions.length > 0)).toBe(true);
    expect(attempt.viewports.some((item) => item.claims.length > 0)).toBe(true);
    const published = await publishCapture(attempt);
    expect(published.code).toBeUndefined();
    expect(published).toMatchObject({ published: true });
    expect(published.captureIds).toHaveLength(2);
  });

  it("computes status, coverage and limitations independently per viewport", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const { scan: base } = loadPhase2Fixture();
    const fake = fakeBrowser(base);
    const plainSection = {
      ...base.sections[0]!,
      nodeKey: "mobile-unclassified",
      selector: "main > section.unclassified",
      tag: "section",
      role: null,
      landmark: null,
      heading: null,
      headingLevel: null,
      text: "Unclassified mobile copy",
      paragraphCount: 1,
      linkCount: 0,
      mediaCount: 0,
      repeatedItems: 0,
      orderedItems: 0,
      quoteCount: 0,
      citationCount: 0,
      numericPairs: 0,
      formCount: 0,
      emailInputCount: 0,
      buttonCount: 0,
      buttonLabels: [],
      parentKey: null,
      rect: { x: 0, y: 0, width: 390, height: 300 },
      viewport: { width: 390, height: 844 },
    };
    const attempt = await collectAtlasPage(
      { siteSlug: "fixture-live" },
      {
        cache,
        allowPrivateOrigins: [origin],
        loader: async () => ({ chromium: { launch: async () => fake.browser } }),
        settle: async () => undefined,
        scanPage: async (_page, viewport) =>
          viewport === "desktop"
            ? { ...base, url: `${origin}/` }
            : {
                ...base,
                url: `${origin}/`,
                totalHeight: 844,
                rawSectionCount: 1,
                nodeBudgetHit: true,
                sections: [plainSection],
              },
        screenshot: async () => Buffer.from(PNG),
        totalBudgetMs: 30_000,
      },
    );

    const [desktop, mobile] = attempt.viewports;
    expect(desktop!.regions.length).toBeGreaterThan(1);
    expect(desktop!.claims.length).toBeGreaterThan(0);
    expect(desktop!.status).toBe("partial");
    expect(desktop!.coverage).toEqual({
      status: "partial",
      collected: desktop!.regions.length,
      excluded: 0,
      limitations: ["CHECKPOINT_LIMIT"],
    });
    expect(desktop!.limitations).toEqual(["CHECKPOINT_LIMIT"]);
    expect(mobile!.regions).toHaveLength(1);
    expect(mobile!.claims).toEqual([]);
    expect(mobile!.status).toBe("partial");
    expect(mobile!.coverage).toEqual({
      status: "partial",
      collected: 1,
      excluded: 0,
      limitations: ["DOM_NODE_LIMIT"],
    });
    expect(mobile!.limitations).toEqual(["DOM_NODE_LIMIT"]);
    expect(attempt.status).toBe("partial");
    expect(attempt.coverage.collected).toBe(desktop!.regions.length + 1);
    expect(attempt.limitations).toEqual(["CHECKPOINT_LIMIT", "DOM_NODE_LIMIT"]);
  });

  it("cleans up when the client cancels before capture", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const fake = fakeBrowser(loadPhase2Fixture().scan);
    const controller = new AbortController();
    controller.abort();
    const attempt = await collectAtlasPage(
      { siteSlug: "fixture-live" },
      {
        cache,
        allowPrivateOrigins: [origin],
        signal: controller.signal,
        loader: async () => ({ chromium: { launch: async () => fake.browser } }),
        settle: async () => undefined,
        scanPage: async () => loadPhase2Fixture().scan,
      },
    );
    expect(attempt.status).toBe("failed");
    expect(fake.contexts()).toBe(0);
    expect(fake.closed()).toBe(true);
  });

  it("cleans up when the capture deadline expires", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const fake = fakeBrowser(loadPhase2Fixture().scan);
    await expect(
      collectAtlasPage(
        { siteSlug: "fixture-live" },
        {
          cache,
          allowPrivateOrigins: [origin],
          totalBudgetMs: -1,
          loader: async () => ({ chromium: { launch: async () => fake.browser } }),
          settle: async () => undefined,
          scanPage: async () => loadPhase2Fixture().scan,
        },
      ),
    ).rejects.toMatchObject({ code: "CAPTURE_DEADLINE_EXCEEDED" });
    expect(fake.closed()).toBe(false);
  });

  it("times out a held browser launch without leaving the lease held", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "fixture-live" },
      {
        cache,
        allowPrivateOrigins: [origin],
        totalBudgetMs: 300,
        loader: async () => ({
          chromium: { launch: () => new Promise(() => undefined) },
        }),
      },
    );
    expect(attempt.status).toBe("failed");
    expect(attempt.limitations).toContain("CAPTURE_DEADLINE_EXCEEDED");
    expect(() =>
      acquireAtlasCaptureLease(cache.rootDir, { token: "after-timeout" }),
    ).not.toThrow();
  });

  it("times out a held loader and releases the lease", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    await expect(
      collectAtlasPage(
        { siteSlug: "fixture-live" },
        {
          cache,
          allowPrivateOrigins: [origin],
          totalBudgetMs: 20,
          loader: () => new Promise(() => undefined),
        },
      ),
    ).rejects.toMatchObject({ code: "CAPTURE_DEADLINE_EXCEEDED" });
    expect(() =>
      acquireAtlasCaptureLease(cache.rootDir, { token: "after-loader" }),
    ).not.toThrow();
  });

  it("times out a held context and releases the lease", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "fixture-live" },
      {
        cache,
        allowPrivateOrigins: [origin],
        totalBudgetMs: 300,
        loader: async () => ({
          chromium: {
            launch: async () => ({
              newContext: () => new Promise(() => undefined),
              version: () => "fake",
              close: async () => undefined,
            }),
          },
        }),
      },
    );
    expect(attempt.status).toBe("failed");
    expect(() =>
      acquireAtlasCaptureLease(cache.rootDir, { token: "after-context" }),
    ).not.toThrow();
  });

  it("times out a held page creation and releases the lease", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "fixture-live" },
      {
        cache,
        allowPrivateOrigins: [origin],
        totalBudgetMs: 300,
        loader: async () => ({
          chromium: {
            launch: async () => ({
              newContext: async () => ({
                newPage: () => new Promise(() => undefined),
                on: () => undefined,
                close: async () => undefined,
              }),
              version: () => "fake",
              close: async () => undefined,
            }),
          },
        }),
      },
    );
    expect(attempt.status).toBe("failed");
    expect(() =>
      acquireAtlasCaptureLease(cache.rootDir, { token: "after-page" }),
    ).not.toThrow();
  });

  it("times out a held scan and releases the lease", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const fake = fakeBrowser(loadPhase2Fixture().scan);
    const attempt = await collectAtlasPage(
      { siteSlug: "fixture-live", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        totalBudgetMs: 300,
        loader: async () => ({ chromium: { launch: async () => fake.browser } }),
        settle: async () => undefined,
        scanPage: () => new Promise(() => undefined),
      },
    );
    expect(attempt.status).toBe("failed");
    expect(() =>
      acquireAtlasCaptureLease(cache.rootDir, { token: "after-scan" }),
    ).not.toThrow();
  });

  it("records an explicit limitation when no sections are discovered", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const fake = fakeBrowser(loadPhase2Fixture().scan);
    const base = loadPhase2Fixture().scan;
    const attempt = await collectAtlasPage(
      { siteSlug: "fixture-live", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        loader: async () => ({ chromium: { launch: async () => fake.browser } }),
        settle: async () => undefined,
        scanPage: async () => ({ ...base, sections: [] }),
        screenshot: async () => Buffer.from(PNG),
      },
    );
    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("NO_SECTIONS");
  });

  it("reserves artifact space before writing a large raw observation", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const fake = fakeBrowser(loadPhase2Fixture().scan);
    const huge = `${"x".repeat(65 * 1024 * 1024)}`;
    const baseScan = loadPhase2Fixture().scan;
    await collectAtlasPage(
      { siteSlug: "fixture-live", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        loader: async () => ({ chromium: { launch: async () => fake.browser } }),
        settle: async () => undefined,
        scanPage: async () => ({
          ...baseScan,
          sections: baseScan.sections.map((section, index) =>
            index === 0 ? { ...section, text: huge } : section,
          ),
        }),
      },
    ).then(
      (value) => {
        expect(value.status).toBe("failed");
        expect(value.limitations).toContain("ARTIFACT_LIMIT");
      },
      (error) => {
        expect(error).toMatchObject({ code: "ARTIFACT_LIMIT" });
      },
    );
    expect(() =>
      acquireAtlasCaptureLease(cache.rootDir, { token: "after-limit" }),
    ).not.toThrow();
  });

  it("rejects non-PNG screenshot payloads and reports partial coverage", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const fake = fakeBrowser(loadPhase2Fixture().scan);
    const attempt = await collectAtlasPage(
      { siteSlug: "fixture-live", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        loader: async () => ({ chromium: { launch: async () => fake.browser } }),
        settle: async () => undefined,
        scanPage: async () => loadPhase2Fixture().scan,
        screenshot: async () => Buffer.from(PNG.subarray(0, 9)),
      },
    );
    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("SCREENSHOT_INVALID");
    expect(attempt.artifacts.filter((item) => item.kind === "screenshot")).toEqual([]);
    expect(attempt.coverage.status).toBe("partial");
  });

  it("reports retained-section truncation and preserves partial coverage", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const { scan: base } = loadPhase2Fixture();
    const sections = Array.from({ length: 30 }, (_, index) => ({
      ...base.sections[0]!,
      selector: `main > section.s${index}`,
      heading: `Section ${index}`,
      headingLevel: 2,
      text: `Section ${index} content`,
      rect: { x: 0, y: 100 + index * 200, width: 1200, height: 180 },
    }));
    const fake = fakeBrowser(base);
    const attempt = await collectAtlasPage(
      { siteSlug: "fixture-live", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        loader: async () => ({ chromium: { launch: async () => fake.browser } }),
        settle: async () => undefined,
        scanPage: async () => ({ ...base, sections }),
        screenshot: async () => Buffer.from(PNG),
      },
    );
    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("SECTION_TRUNCATION");
    expect(attempt.coverage.excluded).toBeGreaterThan(0);
    expect(attempt.coverage.limitations).toContain("SECTION_TRUNCATION");
  });

  it("counts excluded regions once for raw 100 -> 80 -> 24", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const { scan: base } = loadPhase2Fixture();
    const sections = Array.from({ length: 80 }, (_, index) => ({
      ...base.sections[0]!,
      nodeKey: `excluded-${index}`,
      selector: `main > section.e${index}`,
      heading: `Excluded ${index}`,
      headingLevel: 2,
      text: `Excluded ${index} content`,
      rect: { x: 0, y: 100 + index * 200, width: 1200, height: 180 },
    }));
    const scan = { ...base, sections, rawSectionCount: 100 };
    const fake = fakeBrowser(scan);
    const attempt = await collectAtlasPage(
      { siteSlug: "fixture-live", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        loader: async () => ({ chromium: { launch: async () => fake.browser } }),
        settle: async () => undefined,
        scanPage: async () => scan,
        screenshot: async () => Buffer.from(PNG),
      },
    );
    expect(attempt.coverage.excluded).toBe(76);
  });

  it("reports checkpoint truncation in coverage", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const { scan: base } = loadPhase2Fixture();
    const sections = Array.from({ length: 30 }, (_, index) => ({
      ...base.sections[0]!,
      nodeKey: `checkpoint-${index}`,
      selector: `main > section.s${index}`,
      heading: `Section ${index}`,
      headingLevel: 2,
      text: `Section ${index} content`,
      rect: { x: 0, y: 100 + index * 200, width: 1200, height: 180 },
    }));
    const fake = fakeBrowser(base);
    const attempt = await collectAtlasPage(
      { siteSlug: "fixture-live", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        loader: async () => ({ chromium: { launch: async () => fake.browser } }),
        settle: async () => undefined,
        scanPage: async () => ({ ...base, sections }),
        screenshot: async () => Buffer.from(PNG),
      },
    );
    expect(attempt.limitations).toContain("CHECKPOINT_SECTION_TRUNCATION");
    expect(attempt.coverage.excluded).toBeGreaterThan(0);
    expect(attempt.coverage.status).toBe("partial");
  });

  it("reports raw scan truncation even when normalization collapses below the cap", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const { scan: base } = loadPhase2Fixture();
    const sections: any[] = [];
    for (let index = 0; index < 20; index += 1) {
      sections.push({
        ...base.sections[0]!,
        nodeKey: `section-${index}`,
        selector: `main > section.s${index}`,
        heading: `Section ${index}`,
        headingLevel: 2,
        text: `Section ${index} content`,
        rect: { x: 0, y: 100 + index * 200, width: 1200, height: 180 },
      });
    }
    for (let index = 0; index < 61; index += 1) {
      const parent = index % 20;
      sections.push({
        ...base.sections[0]!,
        nodeKey: `shell-${index}`,
        selector: `main > section.s${parent} > div.shell`,
        parentKey: `section-${parent}`,
        heading: `Section ${parent}`,
        headingLevel: 2,
        text: `Section ${parent} content`,
        rect: { x: 0, y: 100 + parent * 200, width: 1200, height: 180 },
      });
    }
    const fake = fakeBrowser(base);
    const attempt = await collectAtlasPage(
      { siteSlug: "fixture-live", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        loader: async () => ({ chromium: { launch: async () => fake.browser } }),
        settle: async () => undefined,
        scanPage: async () => ({ ...base, sections }),
        screenshot: async () => Buffer.from(PNG),
      },
    );
    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("SECTION_TRUNCATION");
  });

  it("emits initial claims only for visible regions", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const { scan: base } = loadPhase2Fixture();
    const hidden = {
      ...base.sections[0]!,
      nodeKey: "below-fold",
      selector: "main > section.below-fold",
      heading: "Contact",
      headingLevel: 2,
      text: "Contact us below the fold",
      linkCount: 3,
      formCount: 1,
      rect: { x: 0, y: 2200, width: 1200, height: 300 },
    };
    const scan = { ...base, totalHeight: 3200, sections: [base.sections[0]!, hidden] };
    const fake = fakeBrowser(scan);
    const attempt = await collectAtlasPage(
      { siteSlug: "fixture-live", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        loader: async () => ({ chromium: { launch: async () => fake.browser } }),
        settle: async () => undefined,
        scanPage: (() => {
          let calls = 0;
          return async () => {
            calls += 1;
            return calls === 1 ? scan : { ...scan, scrollY: 2200 };
          };
        })(),
        screenshot: async () => Buffer.from(PNG),
      },
    );
    const region = attempt.viewports[0]!.regions.find((item) => item.nodeKey === "below-fold");
    expect(region).toBeTruthy();
    const initial = attempt.viewports[0]!.claims.filter(
      (claim) => claim.regionKey === region!.key && claim.sampleKey.includes("initial"),
    );
    const checkpoint = attempt.viewports[0]!.claims.filter(
      (claim) => claim.regionKey === region!.key && !claim.sampleKey.includes("initial"),
    );
    expect(initial).toEqual([]);
    expect(checkpoint.length).toBeGreaterThan(0);
  });

  it("persists a lazy child under its retained parent after checkpoint geometry changes", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const { scan: base } = loadPhase2Fixture();
    const parent = {
      ...base.sections[1]!,
      nodeKey: "parent",
      selector: "main > section.parent",
      heading: "Parent region",
      text: "Parent content remains present throughout the capture.",
      parentKey: null,
      rect: { x: 0, y: 0, width: 1440, height: 900 },
    };
    const checkpointParent = {
      ...parent,
      rect: { ...parent.rect, height: 1200 },
    };
    const lazyChild = {
      ...parent,
      nodeKey: "lazy-child",
      selector: "main > section.parent > section.lazy",
      parentKey: "parent",
      heading: "Contact us",
      headingLevel: 2,
      text: "Contact our studio to discuss your next project.",
      formCount: 1,
      linkCount: 1,
      rect: { x: 0, y: 150, width: 1440, height: 300 },
      depth: 2,
    };
    const initialScan = {
      ...base,
      url: `${origin}/`,
      totalHeight: 1800,
      scrollY: 0,
      sections: [parent],
    };
    const checkpointScan = {
      ...initialScan,
      sections: [checkpointParent, lazyChild],
    };
    const fake = fakeBrowser(base);
    let scans = 0;
    const attempt = await collectAtlasPage(
      { siteSlug: "fixture-live", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        loader: async () => ({ chromium: { launch: async () => fake.browser } }),
        settle: async () => undefined,
        scanPage: async () => {
          scans += 1;
          return scans === 1
            ? initialScan
            : { ...checkpointScan, scrollY: scans === 2 ? 0 : 900 };
        },
        screenshot: async () => Buffer.from(PNG),
        totalBudgetMs: 30_000,
      },
    );

    expect(attempt.status).toBe("complete");
    expect(attempt.limitations).toEqual([]);
    const viewport = attempt.viewports[0]!;
    const retainedParent = viewport.regions.find((region) => region.nodeKey === "parent")!;
    const retainedChild = viewport.regions.find((region) => region.nodeKey === "lazy-child")!;
    expect(retainedChild).toBeTruthy();
    expect(viewport.claims.some((claim) => claim.regionKey === retainedChild.key)).toBe(true);

    const published = await publishCapture(attempt);
    expect(published).toMatchObject({ published: true });
    expect(published.code).toBeUndefined();
    const stored = cache.withAtlasDb((db) => ({
      sections: db
        .prepare("SELECT id, parent_id FROM atlas_regions WHERE kind = 'section' ORDER BY ordinal")
        .all() as Array<{ id: string; parent_id: string | null }>,
      root: db
        .prepare("SELECT id FROM atlas_regions WHERE kind = 'page'")
        .get() as { id: string },
      claims: (db.prepare("SELECT COUNT(*) AS n FROM atlas_claims").get() as { n: number }).n,
    }));
    expect(stored.claims).toBe(viewport.claims.length);
    expect(stored.sections[1]!.parent_id).not.toBe(stored.root.id);
    expect(stored.sections[1]!.parent_id).toBe(stored.sections[0]!.id);
    expect(retainedChild.parentKey).toBe(retainedParent.key);
  });

  it("reports a missing checkpoint observation as partial coverage", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const { scan: base } = loadPhase2Fixture();
    let scans = 0;
    const fake = fakeBrowser(base);
    const attempt = await collectAtlasPage(
      { siteSlug: "fixture-live", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        loader: async () => ({ chromium: { launch: async () => fake.browser } }),
        settle: async () => undefined,
        scanPage: async () => {
          scans += 1;
          if (scans > 1) throw new Error("scan failed");
          return base;
        },
        screenshot: async () => Buffer.from(PNG),
      },
    );
    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("CHECKPOINT_OBSERVATION_MISSING");
    expect(attempt.coverage.status).toBe("partial");
  });

  it("blocks a reference outside the explicit private allowlist", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    await expect(
      collectAtlasPage(
        { siteSlug: "fixture-live" },
        {
          cache,
          allowPrivateOrigins: [],
          loader: async () => ({ chromium: { launch: async () => fakeBrowser(loadPhase2Fixture().scan).browser } }),
        },
      ),
    ).rejects.toMatchObject({ code: "PRIVATE_DESTINATION" });
  });
});
