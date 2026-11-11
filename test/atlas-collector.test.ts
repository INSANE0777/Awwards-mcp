import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import { collectAtlasPage, scrollTo } from "../src/atlas/collector.js";
import { componentPatternKey } from "../src/atlas/components.js";
import { acquireAtlasCaptureLease } from "../src/atlas/lease.js";
import { publishCapture } from "../src/atlas/publish.js";
import { runAtlasCapture } from "../src/atlas/tool-capture.js";
import { loadPhase2Fixture } from "./helpers/phase2-fixture.js";
import type {
  AtlasPageScan,
  AtlasScanComponent,
  AtlasScanSection,
} from "../src/atlas/live-types.js";
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

async function fixtureServer(
  robotsStatus = 200,
  robotsBody = "User-agent: *\nAllow: /\n",
): Promise<{ origin: string }> {
  const server = createServer((req, res) => {
    if (req.url === "/robots.txt") {
      res.writeHead(robotsStatus, { "content-type": "text/plain" });
      res.end(robotsBody);
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

function scanSection(overrides: Partial<AtlasScanSection> = {}): AtlasScanSection {
  return {
    nodeKey: "section-header",
    selector: "main > header",
    tag: "header",
    role: null,
    landmark: "header",
    heading: "Header",
    headingLevel: 1,
    text: "Demo",
    visible: true,
    articleNested: false,
    landmarkNested: false,
    paragraphCount: 0,
    linkCount: 1,
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
    rect: { x: 0, y: 0, width: 1_200, height: 200 },
    viewport: { width: 1_200, height: 800 },
    backgroundColor: "rgb(255, 255, 255)",
    fixed: false,
    depth: 1,
    parentKey: null,
    ...overrides,
  };
}

function scanComponent(overrides: Partial<AtlasScanComponent> = {}): AtlasScanComponent {
  return {
    nodeKey: "component-1",
    selector: "header a.cta",
    tag: "a",
    role: null,
    hint: "link",
    hintBasis: "native_semantics",
    label: "CTA",
    visible: true,
    offscreen: false,
    offCanvas: false,
    fullyClipped: false,
    sectionNodeKey: "section-header",
    childCount: 0,
    descendantCount: 0,
    hasHeading: false,
    hasMedia: false,
    hasIcon: false,
    inNavigation: false,
    ariaHasPopup: false,
    ariaExpanded: null,
    ariaControlsResolved: false,
    ariaLabel: null,
    overflowX: "visible",
    scrollableX: false,
    position: "static",
    transformed: false,
    shape: "span",
    childCounts: "1,0,0",
    display: "inline",
    gap: "normal",
    padding: "0px/0px/0px/0px",
    radius: "0px",
    fontFamily: "Inter",
    fontSize: "16px",
    fontWeight: "400",
    lineHeight: "24px",
    rect: { x: 0, y: 0, width: 200, height: 40 },
    depth: 1,
    pack: { nodes: [{ tag: "a", role: null, depth: 0, childCount: 0 }], truncated: false },
    ...overrides,
  };
}

function componentScan(
  components: AtlasScanComponent[],
  sections: AtlasScanSection[] = [scanSection()],
): AtlasPageScan {
  return {
    title: "Component collector fixture",
    url: "https://fixture.example/",
    totalHeight: 800,
    scrollRoot: null,
    sections,
    components,
    technologies: [],
    canvasCount: 0,
    webglObserved: false,
  };
}

async function collectWithScan(
  scan: AtlasPageScan,
): Promise<{ attempt: Awaited<ReturnType<typeof collectAtlasPage>>; cache: Cache }> {
  const { origin } = await fixtureServer();
  const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
  cache.upsertSites([site(`${origin}/`)]);
  const attempt = await collectAtlasPage(
    { siteSlug: "fixture-live", viewports: ["desktop"] },
    {
      cache,
      allowPrivateOrigins: [origin],
      loader: async () => ({ chromium: { launch: async () => fakeBrowser(scan).browser } }),
      settle: async () => undefined,
      scanPage: async () => ({ ...scan, url: `${origin}/` }),
      totalBudgetMs: 30_000,
    },
  );
  return { attempt, cache };
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

  it("reports unavailable robots separately from a denial", async () => {
    const { origin } = await fixtureServer(503);
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    await expect(
      collectAtlasPage(
        { siteSlug: "fixture-live" },
        {
          cache,
          allowPrivateOrigins: [origin],
          loader: async () => {
            throw new Error("browser must not launch when robots is unavailable");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "ROBOTS_UNAVAILABLE" });
  });

  it("maps a robots denial through capture_atlas to blocked", async () => {
    const { origin } = await fixtureServer(200, "User-agent: *\nDisallow: /\n");
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const result = await runAtlasCapture(cache, { slug: "fixture-live", refresh: true }, {
      now: () => Date.now(),
      collectDeps: { allowPrivateOrigins: [origin] },
    });
    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("ROBOTS_DENIED");
    expect(result.error?.retryable).toBe(false);
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
          totalBudgetMs: 500,
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

  it("collects components with section context, scoped patterns, packs and caps", async () => {
    const pricingSection = scanSection({
      nodeKey: "section-pricing",
      selector: "main > section.pricing",
      tag: "section",
      landmark: null,
      heading: "Pricing",
      headingLevel: 2,
      text: "$10 per seat and $20 per team",
      numericPairs: 2,
      rect: { x: 0, y: 400, width: 1_200, height: 300 },
    });
    const hero = scanComponent({
      nodeKey: "hero-cta",
      selector: "header a.hero",
      label: "Start now",
      rect: { x: 100, y: 40, width: 320, height: 120 },
    });
    const pricingCta = scanComponent({
      nodeKey: "pricing-cta",
      selector: "section.pricing a.buy",
      label: "Buy",
      sectionNodeKey: "section-pricing",
      rect: { x: 100, y: 450, width: 200, height: 40 },
    });
    const navLinks = Array.from({ length: 121 }, (_, index) =>
      scanComponent({
        nodeKey: `nav-${index}`,
        selector: `header a.nav-${index}`,
        label: `Nav ${index}`,
        rect: { x: index * 4, y: 150, width: 10, height: 10 },
        pack: null,
      }),
    );
    const scan = componentScan(
      [hero, pricingCta, ...navLinks],
      [scanSection(), pricingSection],
    );
    const { attempt } = await collectWithScan(scan);
    const viewport = attempt.viewports[0]!;
    const section = viewport.regions.find((region) => region.nodeKey === "section-header")!;
    const component = viewport.components!.find((candidate) => candidate.nodeKey === "hero-cta")!;
    expect(component.sectionKey).toBe(section.key);
    expect(component.patternKey).toBe(
      componentPatternKey(
        component,
        hero,
        `${attempt.target.siteSlug}|${attempt.target.urlKey}|desktop`,
      ),
    );
    const acceptedPurposes = new Set(
      viewport.claims
        .filter((claim) => claim.field === "section.purpose" && claim.decision === "accepted")
        .map((claim) => claim.value),
    );
    const contextClaims = viewport.claims.filter(
      (claim) =>
        claim.regionKey === component.key && claim.field === "context.section_purpose",
    );
    // Context is sourced only from accepted section purposes. This branch
    // publishes every section purpose as candidate, so no context claim may be
    // produced; the invariant still holds when calibration promotes classes.
    expect(acceptedPurposes.size).toBe(0);
    expect(contextClaims).toEqual([]);
    const pricingComponent = viewport.components!.find(
      (candidate) => candidate.nodeKey === "pricing-cta",
    )!;
    expect(
      viewport.claims.filter(
        (claim) =>
          claim.regionKey === pricingComponent.key &&
          claim.field === "context.section_purpose",
      ),
    ).toEqual([]);
    expect(
      viewport.artifacts.some(
        (artifact) =>
          artifact.kind === "component_pack" && artifact.regionKey === component.key,
      ),
    ).toBe(true);
    expect(viewport.limitations.some((value) => value.startsWith("COMPONENT_CAP"))).toBe(true);
  });

  it("bounds pack nodes and depth and reports pack truncation", async () => {
    const nodes = [
      ...Array.from({ length: 200 }, (_, index) => ({
        tag: "span",
        role: null,
        depth: index % 13,
        childCount: 0,
      })),
      { tag: "span", role: null, depth: 20, childCount: 0 },
    ];
    const scan = componentScan(
      Array.from({ length: 13 }, (_, index) =>
        scanComponent({
          nodeKey: `packed-${index}`,
          selector: `header a.packed-${index}`,
          label: `Packed ${index}`,
          rect: { x: 0, y: index, width: 200, height: 40 },
          pack: { nodes, truncated: false },
        }),
      ),
    );
    const { attempt } = await collectWithScan(scan);
    const viewport = attempt.viewports[0]!;
    const pack = viewport.scan.components![0]!.pack!;
    expect(pack.nodes).toHaveLength(150);
    expect(Math.max(...pack.nodes.map((node) => node.depth))).toBeLessThanOrEqual(12);
    expect(pack.truncated).toBe(true);
    expect(viewport.limitations).toContain("COMPONENT_PACK_TRUNCATED");
    expect(viewport.limitations).toContain("COMPONENT_PACK_CAP");
    expect(viewport.coverage.status).toBe("partial");
  });

  it("keeps a hero CTA when navigation links exhaust the component cap", async () => {
    const hero = scanComponent({
      nodeKey: "hero-cta",
      label: "Hero CTA",
      rect: { x: 40, y: 20, width: 320, height: 120 },
    });
    const links = Array.from({ length: 130 }, (_, index) =>
      scanComponent({
        nodeKey: `nav-${index}`,
        selector: `nav a.nav-${index}`,
        label: `Nav ${index}`,
        sectionNodeKey: "section-nav",
        rect: { x: index, y: 0, width: 12, height: 12 },
      }),
    );
    const scan = componentScan(
      [...links, hero],
      [
        scanSection(),
        scanSection({
          nodeKey: "section-nav",
          selector: "main > nav",
          tag: "nav",
          landmark: "navigation",
          heading: "Nav",
          headingLevel: 2,
          rect: { x: 0, y: 200, width: 1_200, height: 100 },
        }),
      ],
    );
    const { attempt } = await collectWithScan(scan);
    const viewport = attempt.viewports[0]!;
    expect(viewport.components).toHaveLength(120);
    expect(viewport.components![0]!.label).toBe("Hero CTA");
    expect(viewport.components!.some((candidate) => candidate.label === "Hero CTA")).toBe(true);
    expect(viewport.scan.componentLimitHit).toBe(true);
    expect(viewport.scan.componentDroppedCount).toBe(11);
    expect(viewport.limitations).toContain("COMPONENT_CAP:11");
  });

  it("preserves the scan's own dropped count instead of recomputing it from the capped array", async () => {
    const components = Array.from({ length: 120 }, (_, index) =>
      scanComponent({
        nodeKey: `capped-${index}`,
        selector: `main a.capped-${index}`,
        label: `Capped ${index}`,
        sectionNodeKey: null,
        pack: null,
        rect: { x: index, y: 0, width: 10, height: 10 },
      }),
    );
    const scan = componentScan(components);
    const { attempt } = await collectWithScan({
      ...scan,
      componentLimitHit: true,
      componentDroppedCount: 11,
    });
    const viewport = attempt.viewports[0]!;
    expect(viewport.components).toHaveLength(120);
    expect(viewport.scan.componentDroppedCount).toBe(11);
    expect(viewport.limitations).toContain("COMPONENT_CAP:11");
    // Attempt coverage includes components, exactly like viewport coverage.
    expect(attempt.coverage.collected).toBe(viewport.coverage.collected);
    expect(attempt.coverage.collected).toBe(viewport.regions.length + 120);
  });

  it("passes components:false to checkpoint scans and records no components in them", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const scan = componentScan([scanComponent()]);
    const calls: Array<{ components?: boolean } | undefined> = [];
    const attempt = await collectAtlasPage(
      { siteSlug: "fixture-live", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        loader: async () => ({ chromium: { launch: async () => fakeBrowser(scan).browser } }),
        settle: async () => undefined,
        scanPage: async (_page, _viewport, options) => {
          calls.push(options);
          return { ...scan, url: `${origin}/` };
        },
        totalBudgetMs: 30_000,
      },
    );
    expect(calls[0]).toBeUndefined();
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.slice(1).every((options) => options?.components === false)).toBe(true);
    const viewport = attempt.viewports[0]!;
    const checkpoints = viewport.artifacts.filter((artifact) =>
      artifact.key.startsWith("checkpoint-"),
    );
    expect(checkpoints.length).toBeGreaterThan(0);
    for (const checkpoint of checkpoints) {
      const payload = JSON.parse(
        readFileSync(join(cache.rootDir, checkpoint.storagePath), "utf8"),
      ) as { scan: AtlasPageScan };
      expect(payload.scan.components ?? []).toEqual([]);
      expect(payload.scan.componentLimitHit).toBe(false);
    }
  });

  it("passes components:false to the initial scan and records no components", async () => {
    const { origin } = await fixtureServer();
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const scan = componentScan([scanComponent()]);
    const calls: Array<{ components?: boolean } | undefined> = [];
    const attempt = await collectAtlasPage(
      { siteSlug: "fixture-live", viewports: ["desktop"], components: false },
      {
        cache,
        allowPrivateOrigins: [origin],
        loader: async () => ({ chromium: { launch: async () => fakeBrowser(scan).browser } }),
        settle: async () => undefined,
        scanPage: async (_page, _viewport, options) => {
          calls.push(options);
          return {
            ...scan,
            url: `${origin}/`,
            components: options?.components === false ? [] : scan.components,
          };
        },
        totalBudgetMs: 30_000,
      },
    );
    expect(calls[0]).toEqual({ components: false });
    expect(attempt.viewports[0]!.components ?? []).toEqual([]);
    expect(attempt.components).toBe(false);
  });

  it("discovers components only on the initial scan", async () => {
    const scan = componentScan([scanComponent()]);
    const { attempt, cache } = await collectWithScan(scan);
    const viewport = attempt.viewports[0]!;
    expect(viewport.components).toHaveLength(1);
    expect(viewport.scan.components ?? []).toHaveLength(1);
    expect(viewport.coverage.limitations).toContain("COMPONENT_INITIAL_SCAN_ONLY");
    expect(viewport.limitations).not.toContain("COMPONENT_INITIAL_SCAN_ONLY");
    expect(attempt.coverage.limitations).toContain("COMPONENT_INITIAL_SCAN_ONLY");
    const checkpoint = viewport.artifacts.find((artifact) =>
      artifact.key.startsWith("checkpoint-"),
    )!;
    const payload = JSON.parse(
      readFileSync(join(cache.rootDir, checkpoint.storagePath), "utf8"),
    ) as { scan: { components?: unknown[] } };
    expect(payload.scan.components).toEqual([]);
  });

  it("resets an inner scroll root horizontally and vertically", async () => {
    const calls: Array<{ left: number; top: number }> = [];
    const element = {
      scrollLeft: 120,
      scrollTop: 40,
      style: {
        getPropertyValue: () => "",
        getPropertyPriority: () => "",
        setProperty: () => undefined,
        removeProperty: () => undefined,
      },
      scrollTo(options: { left: number; top: number }) {
        calls.push(options);
        this.scrollLeft = options.left;
        this.scrollTop = options.top;
      },
    };
    const page = {
      evaluate: async (fn: (input: unknown) => unknown, input: unknown) => {
        const globals = globalThis as Record<string, unknown>;
        const previousDocument = globals.document;
        const previousWindow = globals.window;
        globals.document = { querySelectorAll: () => [element] };
        globals.window = {};
        try {
          return fn(input);
        } finally {
          globals.document = previousDocument;
          globals.window = previousWindow;
        }
      },
    };
    const result = await scrollTo(page as never, "div#pane", 0);
    expect(calls[0]).toMatchObject({ left: 0, top: 0 });
    expect(result).toMatchObject({ unique: true, scrollX: 0, scrollY: 0 });
  });
});
