import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Cache } from "../src/cache.js";
import { discoverComponents } from "../src/atlas/components.js";
import { collectAtlasPage } from "../src/atlas/collector.js";
import { ATLAS_COMPONENT_HINTS, ATLAS_SECTION_SCAN } from "../src/atlas/scan.js";
import { publishCapture } from "../src/atlas/publish.js";
import { atlasSearchStore, searchAtlas } from "../src/atlas/search.js";
import type { AtlasPageScan } from "../src/atlas/live-types.js";
import type { SiteSummary } from "../src/types.js";

const REQUIRED = process.env.AWWARDS_CHROMIUM_SMOKE === "1";
let chromiumAvailable = false;
try {
  const executable = chromium.executablePath();
  chromiumAvailable = Boolean(executable) && existsSync(executable);
} catch {
  chromiumAvailable = false;
}
if (!chromiumAvailable && REQUIRED) {
  throw new Error(
    "AWWARDS_CHROMIUM_SMOKE=1 but Playwright's Chromium is missing: npx playwright install chromium",
  );
}
const suite = chromiumAvailable ? describe : describe.skip;

const dirs: string[] = [];
const servers: Array<{ close(cb?: () => void): void }> = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-chromium-"));
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

const site = (liveUrl: string): SiteSummary => ({
  id: 1,
  slug: "chromium-fixture",
  title: "Chromium fixture",
  createdAt: 1,
  tags: [],
  thumbnailPath: "submissions/chromium.jpg",
  liveUrl,
  detailPath: "/sites/chromium-fixture",
  awards: [],
  studio: "Studio",
});

const shell = (body: string, script = "") =>
  `<html><head><title>Fixture</title></head><body>${body}<script>${script}</script></body></html>`;

async function start(handler: (path: string, res: any) => void) {
  const server = createServer((req, res) => handler(req.url ?? "/", res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address missing");
  return `http://127.0.0.1:${address.port}`;
}

suite("Atlas collector with real Chromium", () => {
  it("keeps the primary page alive while dismissing popups", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      if (path === "/popup") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(shell("<main><h1>Popup</h1></main>"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Primary page</h1><p>Real Chromium content.</p></section></main>`,
          "setTimeout(() => window.open('/popup', '_blank'), 50)",
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(attempt.status).toBe("complete");
    expect(attempt.viewports[0]!.regions.length).toBeGreaterThan(0);
  }, 60_000);

  it("enforces robots on a redirect destination before following it", async () => {
    let privateRequests = 0;
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nDisallow: /private\nAllow: /\n");
        return;
      }
      if (path === "/start") {
        res.writeHead(302, { location: "/private" });
        res.end();
        return;
      }
      if (path === "/private") {
        privateRequests += 1;
        res.writeHead(302, { location: "/start" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(shell("<main><h1>Never</h1></main>"));
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/start`)]);
    await expect(
      collectAtlasPage(
        { siteSlug: "chromium-fixture", path: "/start", viewports: ["desktop"] },
        { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
      ),
    ).rejects.toMatchObject({ code: "DESTINATION_CHANGED" });
    expect(privateRequests).toBe(0);
  }, 60_000);

  it("prefers the scrollable document over a preceding overflowing sidebar", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html>" + shell(`
          <style>html, body { margin: 0; } h2 { margin: 0; }</style>
          <aside id="sidebar" style="height:250px;overflow-y:auto">
            <div style="height:1800px">Sidebar navigation</div>
          </aside>
          <main>
            <section id="hero" style="height:900px"><h2>Hero</h2></section>
            <section id="about" style="height:800px"><h2>About</h2><p>About our studio.</p></section>
            <section id="contact" style="height:1000px"><h2>Contact</h2><p>Contact our studio.</p><a href="/contact">Talk to us</a></section>
          </main>`),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const screenshotScrollY: number[] = [];
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        totalBudgetMs: 45_000,
        screenshot: async (page: any) => {
          screenshotScrollY.push(await page.evaluate(() => window.scrollY));
          return page.screenshot({ fullPage: false, type: "png" });
        },
      },
    );

    expect(attempt.status).toBe("complete");
    expect(screenshotScrollY).toEqual([0, 683, 1367, 2050]);
    const viewport = attempt.viewports[0]!;
    expect(viewport.scrollRoot).toBeNull();
    expect(viewport.scan.scrollRoot).toBeNull();
    expect(viewport.scan.totalHeight).toBe(2950);
    expect(viewport.limitations).toEqual([]);
    const observations = viewport.observations ?? [];
    expect(observations.filter((item) => item.checkpoint > 0 || item.screenshotKey)).toHaveLength(4);
    for (const [id, top] of [["about", 1150], ["contact", 1950]] as const) {
      const samples = observations.flatMap((observation) => observation.regions)
        .filter((region) => region.selector.includes(`#${id}`));
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.some((sample) => sample.visible)).toBe(true);
      expect(samples.every((sample) =>
        sample.rect.y === top &&
        sample.coordinateSpace === "document" &&
        sample.inScrollRoot === false
      )).toBe(true);
    }
    await expect(publishCapture(attempt)).resolves.toMatchObject({ published: true });
  }, 60_000);

  it("treats a quirks-mode document as scrolling instead of a 250px sidebar", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      // No doctype: Chromium renders this in BackCompat, where
      // documentElement.clientHeight reports the content height.
      res.end(shell(`
          <style>html, body { margin: 0; } h2 { margin: 0; }</style>
          <aside id="sidebar" style="height:250px;overflow-y:auto">
            <div style="height:1800px">Sidebar navigation</div>
          </aside>
          <main>
            <section id="hero" style="height:900px"><h2>Hero</h2></section>
            <section id="about" style="height:800px"><h2>About</h2><p>About our studio.</p></section>
            <section id="contact" style="height:1000px"><h2>Contact</h2><p>Contact our studio.</p><a href="/contact">Talk to us</a></section>
          </main>`));
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const screenshotScrollY: number[] = [];
    const compatModes: string[] = [];
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        totalBudgetMs: 45_000,
        screenshot: async (page: any) => {
          screenshotScrollY.push(await page.evaluate(() => window.scrollY));
          compatModes.push(await page.evaluate(() => document.compatMode));
          return page.screenshot({ fullPage: false, type: "png" });
        },
      },
    );

    expect(compatModes.every((mode) => mode === "BackCompat")).toBe(true);
    expect(attempt.status).toBe("complete");
    expect(screenshotScrollY).toEqual([0, 683, 1367, 2050]);
    const viewport = attempt.viewports[0]!;
    expect(viewport.scrollRoot).toBeNull();
    expect(viewport.scan.scrollRoot).toBeNull();
    expect(viewport.scan.totalHeight).toBe(2950);
    expect(viewport.limitations).toEqual([]);
    const samples = (viewport.observations ?? []).flatMap((observation) => observation.regions);
    for (const [id, top] of [["about", 1150], ["contact", 1950]] as const) {
      const sectionSamples = samples.filter((sample) => sample.selector.includes(`#${id}`));
      expect(sectionSamples.length).toBeGreaterThan(0);
      expect(sectionSamples.some((sample) => sample.visible)).toBe(true);
      expect(sectionSamples.every((sample) => sample.rect.y === top)).toBe(true);
    }
  }, 60_000);

  it("forces instant scrolling on a scroll-behavior:smooth page", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html>" + shell(`
          <style>
            html, body { margin: 0; }
            html { scroll-behavior: smooth; }
            section { height: 900px; }
            h2 { margin: 0; }
          </style>
          <main>
            <section id="one"><h2>One</h2></section>
            <section id="two"><h2>Two</h2></section>
            <section id="three"><h2>Three</h2></section>
          </main>`, `
          (() => {
            const original = window.scrollTo.bind(window);
            window.__atlasScrollCalls = [];
            window.scrollTo = (...args) => {
              const first = args[0];
              window.__atlasScrollCalls.push(
                typeof first === "object" && first !== null
                  ? { top: first.top, behavior: first.behavior ?? null }
                  : { top: args[1], behavior: null },
              );
              return original(...args);
            };
          })()`),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const screenshotScrollY: number[] = [];
    let scrollCalls: Array<{ top: number; behavior: string | null }> = [];
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        totalBudgetMs: 45_000,
        screenshot: async (page: any) => {
          screenshotScrollY.push(await page.evaluate(() => window.scrollY));
          scrollCalls = await page.evaluate(() => (window as any).__atlasScrollCalls);
          return page.screenshot({ fullPage: false, type: "png" });
        },
      },
    );

    expect(attempt.status).toBe("complete");
    expect(attempt.limitations).toEqual([]);
    expect(screenshotScrollY).toEqual([0, 900, 1800]);
    expect(scrollCalls.length).toBeGreaterThan(0);
    expect(scrollCalls.every((call) => call.behavior === "instant")).toBe(true);
  }, 60_000);

  it("reports CHECKPOINT_LIMIT instead of complete coverage on a tall document", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html>" + shell(`
          <style>html, body { margin: 0; } h2 { margin: 0; }</style>
          <main>
            <section id="start" style="height:6600px"><h2>Start</h2></section>
            <section id="late" style="height:400px"><h2>Late</h2><p>Late content</p></section>
            <section id="end" style="height:1000px"><h2>End</h2></section>
          </main>`),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );

    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("CHECKPOINT_LIMIT");
    expect(attempt.coverage.status).toBe("partial");
    const viewport = attempt.viewports[0]!;
    expect(viewport.limitations).toContain("CHECKPOINT_LIMIT");
    expect(viewport.screenshots).toHaveLength(6);
    const lateSamples = (viewport.observations ?? [])
      .flatMap((observation) => observation.regions)
      .filter((sample) => sample.selector.includes("#late"));
    expect(lateSamples.length).toBeGreaterThan(0);
    expect(lateSamples.some((sample) => sample.visible)).toBe(false);
  }, 60_000);

  it("stops with SCROLL_ROOT_UNKNOWN when the scroll-root label goes stale", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html>" + shell(`
          <style>
            html, body { margin: 0; }
            #page { height: 400px; overflow-y: auto; }
            section { height: 800px; }
            h2 { margin: 0; }
          </style>
          <div id="page" class="firstClass">
            <section><h2>One</h2></section>
            <section><h2>Two</h2></section>
            <section><h2>Three</h2></section>
          </div>`, `
          const root = document.getElementById('page');
          root.addEventListener('scroll', () => {
            const late = root.scrollTop >= 800;
            root.classList.toggle('firstClass', !late);
            root.classList.toggle('secondClass', late);
          });`),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );

    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("SCROLL_ROOT_UNKNOWN");
    expect(attempt.limitations).not.toContain("CHECKPOINT_LIMIT");
    const viewport = attempt.viewports[0]!;
    expect(viewport.scan.scrollRoot).toBe("div#page.firstClass");
    expect(viewport.screenshots.length).toBeGreaterThan(0);
    expect(viewport.screenshots.length).toBeLessThan(6);
    const observedTops = (viewport.observations ?? []).map((observation) => observation.scrollY);
    expect(observedTops.some((top) => top > 0)).toBe(true);
  }, 60_000);

  it("refuses a duplicated scroll-root label instead of completing at the wrong offset", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html>" + shell(`
          <style>
            html, body { margin: 0; }
            .pane { height: 400px; overflow-y: auto; }
            .pane section { height: 800px; }
            h2 { margin: 0; }
          </style>
          <div class="pane" style="visibility:hidden">
            <section><h2>Hidden one</h2></section>
            <section><h2>Hidden two</h2></section>
            <section><h2>Hidden three</h2></section>
          </div>
          <div class="pane">
            <section><h2>Visible one</h2></section>
            <section><h2>Visible two</h2></section>
            <section><h2>Visible three</h2></section>
          </div>`),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const visibleTops: number[] = [];
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        totalBudgetMs: 45_000,
        screenshot: async (page: any) => {
          visibleTops.push(
            await page.evaluate(
              () => (document.querySelectorAll(".pane")[1] as HTMLElement).scrollTop,
            ),
          );
          return page.screenshot({ fullPage: false, type: "png" });
        },
      },
    );

    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("SCROLL_ROOT_UNKNOWN");
    const viewport = attempt.viewports[0]!;
    expect(viewport.scan.scrollRoot).toBe("div.pane");
    expect(viewport.screenshots).toEqual([]);
    expect(visibleTops).toEqual([]);
  }, 60_000);

  it("refuses a checkpoint scan that picked a different scroll root of equal size", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html>" + shell(`
          <style>
            html, body { margin: 0; }
            #alpha, #beta { height: 400px; overflow-y: auto; }
            #alpha { width: 700px; }
            #beta { width: 300px; }
            section { height: 800px; }
            h2 { margin: 0; }
          </style>
          <div id="alpha">
            <section><h2>Alpha one</h2></section>
            <section><h2>Alpha two</h2></section>
            <section><h2>Alpha three</h2></section>
          </div>
          <div id="beta">
            <section><h2>Beta one</h2></section>
            <section><h2>Beta two</h2></section>
            <section><h2>Beta three</h2></section>
          </div>`, `
          const alpha = document.getElementById('alpha');
          const beta = document.getElementById('beta');
          // Alpha is the larger root at scan time. The collector's exact
          // 400px checkpoint makes alpha shrink and beta grow while both sit
          // at the same offset, so the checkpoint scan re-picks beta.
          alpha.addEventListener('scroll', () => {
            beta.scrollTop = alpha.scrollTop;
            if (alpha.scrollTop !== 400) return;
            alpha.style.width = '300px';
            beta.style.width = '700px';
          });`),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        totalBudgetMs: 45_000,
        // Flush the scroll event (and the size swap) before the collector
        // measures the offsets that label the screenshot.
        settle: async (page: any) => {
          await page.evaluate(
            () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
        },
      },
    );

    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("SCROLL_ROOT_UNKNOWN");
    const viewport = attempt.viewports[0]!;
    expect(viewport.scan.scrollRoot).toBe("div#alpha");
    expect(viewport.screenshots).toHaveLength(1);
    expect(viewport.observations?.map((item) => item.checkpoint)).toEqual([0, 0]);
    expect(viewport.observations?.every((item) => item.scrollRoot === "div#alpha")).toBe(true);
    expect(viewport.observations?.some((item) => item.scrollY === 400)).toBe(false);
    // Nothing from the swapped checkpoint may be published: no claims tied to
    // its observation and no checkpoint artifact for it.
    expect(
      viewport.claims.every((claim) =>
        (claim.checkpointKeys ?? []).every((key) => key === "observation-desktop-0"),
      ),
    ).toBe(true);
    expect(
      attempt.artifacts.some((artifact) => artifact.key === "checkpoint-desktop-1"),
    ).toBe(false);
  }, 60_000);

  it("suppresses a viewport when the initial scan measured a different scroll root", async () => {
    // The scan's 6,000-node walk cannot reach #big, so it measures #small.
    // preScroll's full walk picks the larger #big. Mixing the two would label
    // small-space rects under #big.
    const filler = "<i></i>".repeat(7_001);
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html>" + shell(`
          <style>
            html, body { margin: 0; }
            #small { width: 300px; height: 400px; overflow-y: auto; }
            #big { width: 700px; height: 400px; overflow-y: auto; }
            #small section, #big section { height: 800px; }
            h2 { margin: 0; }
          </style>
          <div id="small">
            <section><h2>Small one</h2></section>
            <section><h2>Small two</h2></section>
            <section><h2>Small three</h2></section>
          </div>
          ${filler}
          <div id="big">
            <section><h2>Big one</h2></section>
            <section><h2>Big two</h2></section>
            <section><h2>Big three</h2></section>
          </div>`),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop", "mobile"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );

    expect(attempt.status).toBe("partial");
    expect(attempt.coverage.status).toBe("partial");
    expect(attempt.limitations).toContain("SCROLL_ROOT_UNKNOWN");
    expect(attempt.limitations).toContain("DOM_NODE_LIMIT");
    expect(attempt.viewports).toHaveLength(2);
    expect(attempt.artifacts).toEqual([]);
    for (const viewport of attempt.viewports) {
      expect(viewport.scrollRoot).toBe("div#small");
      expect(viewport.scan.scrollRoot).toBe("div#small");
      expect(viewport.regions).toEqual([]);
      expect(viewport.claims).toEqual([]);
      expect(viewport.observations).toEqual([]);
      expect(viewport.screenshots).toEqual([]);
      expect(viewport.artifacts).toEqual([]);
    }
    await expect(publishCapture(attempt)).resolves.toMatchObject({
      published: false,
      code: "NO_CLAIMS",
    });
  }, 60_000);

  it("discovers structured div sections and an inner scroll root", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html>" + shell(`
          <aside id="sidebar" style="width:100px;height:250px;overflow-y:auto">
            <div style="height:1800px">Sidebar navigation</div>
          </aside>
          <main>
            <div id="scroller" style="height:400px;overflow-y:auto">
              <div class="about"><h2>About us</h2><p>${"A".repeat(200)}</p></div>
              <div class="features"><h2>Features</h2><p>${"B".repeat(200)}</p></div>
              <div class="work"><h2>Selected work</h2><p>${"C".repeat(200)}</p></div>
              <div style="height:1000px"></div>
            </div>
          </main>`),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(attempt.status).toBe("complete");
    const viewport = attempt.viewports[0]!;
    expect(viewport.scan.scrollRoot).toContain("scroller");
    expect(viewport.scan.totalHeight).toBeGreaterThan(900);
    expect(viewport.regions.length).toBeGreaterThan(0);
    const innerSamples = (viewport.observations ?? []).flatMap((observation) => observation.regions)
      .filter((region) => /(?:about|features|work)/.test(region.selector));
    expect(innerSamples.length).toBeGreaterThan(0);
    expect(innerSamples.every((sample) =>
      sample.coordinateSpace === "scroll_root" && sample.inScrollRoot === true
    )).toBe(true);
  }, 60_000);

  it("captures every checkpoint on a smooth inner scroll root", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html>" + shell(`
          <style>
            html, body { margin: 0; }
            #smooth { height: 400px; overflow-y: auto; scroll-behavior: smooth; }
            #smooth section { height: 800px; }
            h2 { margin: 0; }
          </style>
          <div id="smooth">
            <section><h2>One</h2></section>
            <section><h2>Two</h2></section>
            <section><h2>Three</h2></section>
          </div>`),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const observed: Array<{ top: number; behavior: string }> = [];
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        totalBudgetMs: 45_000,
        screenshot: async (page: any) => {
          observed.push(
            await page.evaluate(() => {
              const el = document.getElementById("smooth")!;
              return {
                top: el.scrollTop,
                behavior: window.getComputedStyle(el).scrollBehavior,
              };
            }),
          );
          return page.screenshot({ fullPage: false, type: "png" });
        },
      },
    );

    expect(attempt.status).toBe("complete");
    expect(attempt.limitations).not.toContain("SCROLL_OFFSET_MISMATCH");
    expect(observed.map((item) => item.top)).toEqual([0, 400, 800, 1200, 1600, 2000]);
    expect(observed.every((item) => item.behavior === "smooth")).toBe(true);
    const viewport = attempt.viewports[0]!;
    expect(viewport.scrollRoot).toBe("div#smooth");
    expect(viewport.screenshots).toHaveLength(6);
  }, 60_000);

  it("blocks a robots-disallowed subresource before requesting it", async () => {
    let secretRequests = 0;
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nDisallow: /secret.js\nAllow: /\n");
        return;
      }
      if (path === "/secret.js") {
        secretRequests += 1;
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end("window.secret = true");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Asset policy</h1></section></main><script src="/secret.js"></script>`,
          "",
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("POLICY_BLOCKED");
    expect(secretRequests).toBe(0);
  }, 60_000);

  it("rejects a delayed JavaScript navigation away from the original target", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      if (path === "/other") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(shell("<main><h1>Other</h1></section></main>"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Original</h1></section></main>`,
          "setTimeout(() => { location.href = '/other'; }, 50)",
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(attempt.status).not.toBe("complete");
    expect(attempt.viewports).toHaveLength(0);
  }, 60_000);

  it("does not accept hidden prices, hidden dismiss controls, or nested section footers", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(`
          <main>
            <section><h2>Pricing plans</h2><p>$19 per month</p><p style="display:none">$99 per month</p></section>
            <div style="opacity:0"><section><h2>Pricing plans</h2><p>$1</p><p>$2</p></section></div>
            <section><h2>Dismiss</h2><div style="opacity:0"><button>Dismiss</button></div></section>
            <section><section role="contentinfo"><h2>Nested footer</h2></section></section>
            <aside role="navigation"><h2>Navigation</h2></aside>
            <article><section><footer><h2>Section footer</h2></footer></section></article>
          </main>`),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    const values = attempt.viewports.flatMap((viewport) =>
      viewport.claims.map((claim) => claim.value),
    );
    expect(values).not.toContain("pricing");
    expect(values).not.toContain("cta");
    expect(values).not.toContain("footer");
    expect(values).toContain("navigation");
  }, 60_000);

  it("blocks denied child documents and redirected resources", async () => {
    let childRequests = 0;
    let secretRequests = 0;
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nDisallow: /frame\nDisallow: /secret.js\nAllow: /\n");
        return;
      }
      if (path === "/frame") {
        childRequests += 1;
        res.writeHead(200, { "content-type": "text/html" });
        res.end(shell("<main><h1>Frame</h1></main>"));
        return;
      }
      if (path === "/redirect.js") {
        res.writeHead(302, { location: "/secret.js" });
        res.end();
        return;
      }
      if (path === "/secret.js") {
        secretRequests += 1;
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end("window.secret = true");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Resources</h1></section><iframe src="/frame"></iframe><script src="/redirect.js"></script></main>`,
          "",
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(childRequests).toBe(0);
    expect(secretRequests).toBe(0);
  }, 60_000);

  it("aborts redirect exhaustion instead of fulfilling a remaining 302", async () => {
    let forbiddenRequests = 0;
    let documentRequests = 0;
    let okRequests = 0;
    let redirectHops = 0;
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\nDisallow: /forbidden\n");
        return;
      }
      if (/^\/redir[0-5]$/.test(path)) {
        redirectHops += 1;
        const index = Number(path.slice("/redir".length));
        res.writeHead(302, { location: index === 5 ? "/forbidden" : `/redir${index + 1}` });
        res.end();
        return;
      }
      if (path === "/forbidden") {
        forbiddenRequests += 1;
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end("window.forbidden = true");
        return;
      }
      if (path === "/ok.js") {
        okRequests += 1;
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end("window.ok = true");
        return;
      }
      documentRequests += 1;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Redirect budget</h1></section><script src="/redir0"></script><script src="/ok.js"></script></main>`,
          "",
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("REDIRECT_LIMIT");
    expect(attempt.limitations).not.toContain("POLICY_BLOCKED");
    expect(forbiddenRequests).toBe(0);
    expect(okRequests).toBe(1);
    expect(redirectHops).toBe(6);
    expect(documentRequests).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("rejects a document redirect that changes identity before transport", async () => {
    let otherRequests = 0;
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      if (path === "/start2") {
        res.writeHead(302, { location: "/other2" });
        res.end();
        return;
      }
      if (path === "/other2") {
        otherRequests += 1;
        res.writeHead(302, { location: "/start2" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(shell("<main><h1>Start</h1></main>"));
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/start2`)]);
    await expect(
      collectAtlasPage(
        { siteSlug: "chromium-fixture", path: "/start2", viewports: ["desktop"] },
        { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
      ),
    ).rejects.toMatchObject({ code: "DESTINATION_CHANGED" });
    expect(otherRequests).toBe(0);
  }, 60_000);

  // macOS runners cannot reliably bind/route the alternate loopback address
  // used to prove pinning; Linux and Windows cover this path.
  it.skipIf(process.platform === "darwin")("uses the pinned guarded address for fixture resources", async () => {
    let assetRequests = 0;
    const server = createServer((req, res) => {
      const path = req.url ?? "/";
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      if (path === "/asset.js") assetRequests += 1;
      res.writeHead(200, { "content-type": path.endsWith(".js") ? "text/javascript" : "text/html" });
      res.end(
        path.endsWith(".js")
          ? "window.asset = true"
          : shell(
              `<main><section><h1>Pinned</h1></section><script src="/asset.js"></script></main>`,
            ),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
    const port = (server.address() as any).port as number;
    const origin = `http://pinned.test:${port}`;
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        resolveHost: async () => ["127.0.0.2"],
        totalBudgetMs: 45_000,
      },
    );
    expect(assetRequests).toBe(1);
  }, 60_000);

  it("preserves binary PNGs and module MIME through fixture transport", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    let imageRequests = 0;
    let moduleRequests = 0;
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      if (path === "/pixel.png") {
        imageRequests += 1;
        res.writeHead(200, { "content-type": "image/png" });
        res.end(png);
        return;
      }
      if (path === "/asset.mjs") {
        moduleRequests += 1;
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(
          "const img = document.getElementById('pixel'); const run = () => { const p = document.createElement('p'); p.textContent = 'module-ok width=' + img.naturalWidth; document.querySelector('section').appendChild(p); }; if (img.complete) run(); else img.addEventListener('load', run);",
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Binary fixture</h1><img id="pixel" src="/pixel.png"></section></main>`,
          "",
        ).replace("</body>", `<script type="module" src="/asset.mjs"></script></body>`),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(attempt.status).toBe("complete");
    expect(imageRequests).toBe(1);
    expect(moduleRequests).toBe(1);
    expect(attempt.viewports[0]!.regions.some((region) => region.text.includes("module-ok width=1"))).toBe(
      true,
    );
  }, 60_000);

  it("collapses equivalent nested shells before the section cap", async () => {
    const sections = Array.from({ length: 13 }, (_, index) => {
      const title = `Section ${index + 1}`;
      return `<section class="shell-${index}"><h2>${title}</h2><div class="inner"><h2>${title}</h2><p>Same copy</p></div></section>`;
    }).join("");
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(shell(sections));
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(attempt.viewports[0]!.regions.length).toBeGreaterThan(0);
    const headings = attempt.viewports[0]!.regions.map((region) => region.heading ?? "");
    expect(headings).toHaveLength(13);
    expect(new Set(headings).size).toBe(13);
  }, 60_000);

  it("reports raw section truncation as partial coverage", async () => {
    const sections = Array.from(
      { length: 30 },
      (_, index) => `<section><h2>Section ${index + 1}</h2><p>Copy ${index + 1}</p></section>`,
    ).join("");
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(shell(`<main>${sections}</main>`));
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("SECTION_TRUNCATION");
    expect(attempt.viewports[0]!.regions).toHaveLength(24);
  }, 60_000);

  it("reports DOM candidate truncation before geometry filtering", async () => {
    const hidden = Array.from(
      { length: 119 },
      () => `<div class="zero" style="display:none"><h2>Zero</h2></div>`,
    ).join("");
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `${hidden}<section><h2>Visible A</h2><p>A</p></section><section><h2>Visible B</h2><p>B</p></section>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("SECTION_TRUNCATION");
  }, 60_000);

  it("matches robots rules against query-bearing resource paths", async () => {
    let blockedRequests = 0;
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nDisallow: /blocked.png?mode=private\nAllow: /\n");
        return;
      }
      if (path.startsWith("/blocked.png")) {
        blockedRequests += 1;
        res.writeHead(200, { "content-type": "image/png" });
        res.end("blocked");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Query policy</h1><img src="/blocked.png?mode=private" alt="blocked"></section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("POLICY_BLOCKED");
    expect(blockedRequests).toBe(0);
  }, 60_000);

  it("records checkpoint observations for pinned and delayed content", async () => {
    const sections = Array.from(
      { length: 6 },
      (_, index) =>
        `<section style="min-height:520px"><h2>Section ${index + 1}</h2><p>${
          index === 3 ? '<span id="lazy-slot">Waiting</span>' : "Static copy"
        }</p></section>`,
    ).join("");
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<header style="position:sticky;top:0;background:white">Pinned header</header><main>${sections}</main>`,
          "setTimeout(() => { const slot = document.getElementById('lazy-slot'); if (slot) slot.textContent = 'Lazy appeared late'; }, 150)",
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        totalBudgetMs: 45_000,
        settle: async (page: any) => {
          await page.waitForTimeout(50);
        },
      },
    );
    const viewport = attempt.viewports[0]!;
    const observations = viewport.observations ?? [];
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.length).toBe(viewport.screenshots.length + 1);
    const [initial, ...settledObservations] = observations;
    expect(initial?.state).toBe("default");
    expect(initial?.scrollY).toBe(0);
    expect(initial?.screenshotKey).toBe("");
    for (const observation of settledObservations) {
      expect(observation.coordinateSpace).toBe("document");
      expect(observation.state).toBe("default");
      expect(observation.settleStatus).toBe("settled");
      expect(Number.isFinite(observation.scrollY)).toBe(true);
      expect(observation.screenshotKey).toMatch(/^screenshot-/);
      expect(observation.regionKeys).toEqual(
        observation.regions.map((region) => region.key),
      );
      expect(observation.scanArtifactKey).toMatch(/^checkpoint-/);
      expect(observation.regions.length).toBeGreaterThan(0);
    }
    expect(
      observations.some((observation) =>
        observation.regions.some((region) => region.text.includes("Lazy appeared late")),
      ),
    ).toBe(true);
    const headerYs = observations
      .flatMap((observation) => observation.regions)
      .filter((region) => region.selector.includes("header"))
      .map((region) => Math.round(region.rect.y));
    expect(new Set(headerYs).size).toBeGreaterThan(1);
    expect(viewport.artifacts.some((artifact) => artifact.key.startsWith("checkpoint-"))).toBe(
      true,
    );
  }, 60_000);

  it("allows a fragment redirect and records the final URL", async () => {
    let first = true;
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      if (path === "/start-fragment" && first) {
        first = false;
        res.writeHead(302, { location: "/start-fragment#section" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(shell("<main><section><h1>Fragment final</h1><p id=section>Done</p></section></main>"));
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/start-fragment`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", path: "/start-fragment", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(attempt.status).toBe("complete");
    expect(attempt.viewports[0]!.finalUrl).toContain("#section");
  }, 60_000);

  it("reports a redirect to a private destination", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      if (path === "/start-private") {
        const port = new URL(origin).port;
        res.writeHead(302, { location: `http://private.test:${port}/private-target` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(shell("<main><h1>Never</h1></main>"));
    });
    const publicOrigin = origin;
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${publicOrigin}/start-private`)]);
    await expect(
      collectAtlasPage(
        { siteSlug: "chromium-fixture", path: "/start-private", viewports: ["desktop"] },
        { cache, allowPrivateOrigins: [publicOrigin], totalBudgetMs: 45_000,
          resolveHost: async (hostname: string) =>
            hostname === "private.test" ? ["127.0.0.2"] : ["127.0.0.1"],
        },
      ),
    ).rejects.toMatchObject({ code: "PRIVATE_DESTINATION" });
  }, 60_000);

  it("keeps header and nav outside an inner scroll root in document coordinates", async () => {
    const sections = Array.from(
      { length: 6 },
      (_, index) =>
        `<section style="min-height:520px"><h2>Inner ${index + 1}</h2><p>Copy ${index + 1}</p></section>`,
    ).join("");
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<header id="page-header">Page header</header><nav id="page-nav">Page nav</nav><div id="scroller" style="height:400px;overflow-y:auto">${sections}</div>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    const observations = attempt.viewports[0]!.observations ?? [];
    expect(observations.length).toBeGreaterThan(1);
    for (const selectorPart of ["header", "nav"]) {
      const samples = observations
        .flatMap((observation) => observation.regions)
        .filter((sample) => sample.selector.includes(selectorPart));
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.every((sample) => sample.coordinateSpace === "document")).toBe(true);
      expect(samples.every((sample) => sample.inScrollRoot === false)).toBe(true);
      expect(samples.every((sample) => sample.visible)).toBe(true);
      expect(samples.every((sample) => sample.scrollX === 0)).toBe(true);
      expect(new Set(samples.map((sample) => Math.round(sample.rect.y))).size).toBe(1);
    }
  }, 60_000);

  it("captures horizontal scroll offsets inside an inner scroller", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<div id="hscroller" style="height:400px;width:300px;overflow:auto"><div style="width:1000px"><section style="min-height:2000px"><h2>Wide</h2></section></div></div>`,
          "document.getElementById('hscroller').scrollLeft = 50",
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    const samples = (attempt.viewports[0]!.observations ?? []).flatMap(
      (observation) => observation.regions,
    );
    expect(samples.some((sample) => sample.scrollX > 0)).toBe(true);
    expect(
      samples.filter((sample) => sample.scrollX > 0).every(
        (sample) => sample.coordinateSpace === "scroll_root",
      ),
    ).toBe(true);
  }, 60_000);

  it("marks a denied redirected subresource as a policy block", async () => {
    let secretRequests = 0;
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nDisallow: /secret.png\nAllow: /\n");
        return;
      }
      if (path === "/ok.png") {
        res.writeHead(302, { location: "/secret.png" });
        res.end();
        return;
      }
      if (path === "/secret.png") {
        secretRequests += 1;
        res.writeHead(200, { "content-type": "image/png" });
        res.end("secret");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Redirect policy</h1><img src="/ok.png" alt="asset"></section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("POLICY_BLOCKED");
    expect(secretRequests).toBe(0);
  }, 60_000);

  it("marks a private redirected subresource as blocked", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      if (path === "/ok-private.png") {
        res.writeHead(302, { location: "http://127.0.0.2:1/secret.png" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Private asset</h1><img src="/ok-private.png" alt="private"></section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("POLICY_BLOCKED");
    expect(attempt.limitations).toContain("BLOCKED_DESTINATION");
  }, 60_000);

  it("excludes sections inside fixed overlays", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<div style="position:fixed;top:0;left:0;width:100px;height:100px;background:white"><section><h2>Fixed overlay content</h2><p>Overlay copy</p></section></div><main><section><h1>Page</h1><p>Body</p></section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(
      attempt.viewports[0]!.regions.some(
        (region) => region.heading === "Fixed overlay content",
      ),
    ).toBe(false);
    expect(
      attempt.viewports[0]!.regions.some((region) => region.heading === "Page"),
    ).toBe(true);
  }, 60_000);

  it("reports a DOM node budget limitation", async () => {
    const nodes = Array.from(
      { length: 6_001 },
      (_, index) => `<div role="region">Node ${index}</div>`,
    ).join("");
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(shell(`<main><section><h1>Many nodes</h1>${nodes}</section></main>`));
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("DOM_NODE_LIMIT");
  }, 60_000);

  it("reports DOM budget on non-candidate nodes", async () => {
    const spans = Array.from({ length: 7_001 }, (_, index) => `<span>${index}</span>`).join("");
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(shell(`<main><section><h1>Spans</h1>${spans}</section></main>`));
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("DOM_NODE_LIMIT");
  }, 60_000);

  it("does not include a sentinel section beyond the DOM budget", async () => {
    const spans = Array.from({ length: 7_001 }, (_, index) => `<span>${index}</span>`).join("");
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Start</h1>${spans}</section><section><h2>Sentinel beyond budget</h2></section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("DOM_NODE_LIMIT");
    expect(
      attempt.viewports[0]!.regions.some(
        (region) => region.heading === "Sentinel beyond budget",
      ),
    ).toBe(false);
    expect(
      attempt.viewports[0]!.regions.every(
        (region) => !region.text.includes("Sentinel beyond budget"),
      ),
    ).toBe(true);
  }, 60_000);

  it("does not report DOM budget below the limit", async () => {
    const spans = Array.from({ length: 5_990 }, (_, index) => `<span>${index}</span>`).join("");
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(shell(`<main><section><h1>Under limit</h1>${spans}</section></main>`));
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(attempt.limitations).not.toContain("DOM_NODE_LIMIT");
  }, 60_000);

  it("excludes hidden and script text from section evidence", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Clean text</h1><p style="display:none">HIDDEN_TEXT</p><script>SCRIPT_TEXT</script><p>Visible copy</p></section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    const region = attempt.viewports[0]!.regions.find((item) => item.heading === "Clean text");
    expect(region?.text).toContain("Visible copy");
    expect(region?.text).not.toContain("HIDDEN_TEXT");
    expect(region?.text).not.toContain("SCRIPT_TEXT");
  }, 60_000);

  it("propagates DOM budget from a lazy checkpoint", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section style="min-height:3000px"><h1>Initial</h1><div id="lazy-root"></div></section></main>`,
          "setTimeout(() => { const root = document.getElementById('lazy-root'); for (let i = 0; i < 6100; i++) { const span = document.createElement('span'); span.textContent = 'lazy'; root.appendChild(span); } const late = document.createElement('section'); late.innerHTML = '<h2>Late section</h2>'; root.parentElement.appendChild(late); }, 150)",
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        totalBudgetMs: 45_000,
        settle: async (page: any) => {
          await page.waitForTimeout(50);
        },
      },
    );
    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("DOM_NODE_LIMIT");
    expect(
      attempt.viewports[0]!.regions.some((region) => region.heading === "Late section"),
    ).toBe(false);
  }, 60_000);

  it("collects exact nested heading text and publishes its claims", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h2><span>Contact us</span></h2><a href="/contact">Talk to us</a></section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    const viewport = attempt.viewports[0]!;
    const section = viewport.regions.find((region) => region.tag === "section");
    expect(section?.heading).toBe("Contact us");
    expect(viewport.claims.some((claim) => claim.value === "contact")).toBe(true);
    await expect(publishCapture(attempt)).resolves.toMatchObject({ published: true });
  }, 60_000);

  it("excludes hidden inline descendants from nested heading text", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h2><span>Contact</span><span style="display:none">HIDDEN_DISPLAY</span> <span>us</span><span style="visibility:hidden">HIDDEN_VISIBILITY</span><span style="opacity:0">HIDDEN_OPACITY</span><script>HIDDEN_SCRIPT</script><style>HIDDEN_STYLE</style></h2></section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    const section = attempt.viewports[0]!.regions.find((region) => region.tag === "section");
    expect(section?.heading).toBe("Contact us");
  }, 60_000);

  it("discards a checkpoint when a delayed scroll handler returns to zero", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `
          <style>
            html, body { margin: 0; }
            section { box-sizing: border-box; height: 500px; }
            h2 { margin: 0; }
          </style>
          <main>
            <section id="one"><h2>One</h2></section>
            <section id="two"><h2>Two</h2></section>
            <section id="three"><h2>Three</h2></section>
            <div style="height:350px"></div>
          </main>`,
          `
          window.__resetOnScroll = false;
          window.__armScrollReset = function () {
            window.__resetOnScroll = true;
            window.dispatchEvent(new Event("scroll"));
          };
          window.addEventListener("scroll", function () {
            if (!window.__resetOnScroll) return;
            window.__resetOnScroll = false;
            requestAnimationFrame(function () {
              requestAnimationFrame(function () {
                window.scrollTo({ left: 0, top: 0, behavior: "instant" });
              });
            });
          });`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        totalBudgetMs: 45_000,
        // The page only schedules its two-frame reset during the checkpoint
        // screenshot, after the pre-screenshot offset check has passed.
        screenshot: async (page: any) => {
          await page.evaluate(() => (window as any).__armScrollReset());
          await page.waitForFunction(() => window.scrollY === 0);
          return page.screenshot({ fullPage: false, type: "png" });
        },
      },
    );
    const viewport = attempt.viewports[0]!;
    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("SCROLL_OFFSET_MISMATCH");
    expect(viewport.screenshots).toHaveLength(1);
    expect(viewport.observations?.map((item) => item.checkpoint)).toEqual([0, 0]);
    expect(viewport.observations?.every((item) => item.scrollY === 0)).toBe(true);
    expect(viewport.claims.every((claim) =>
      (claim.checkpointKeys ?? []).every((key) => key === "observation-desktop-0"),
    )).toBe(true);
    expect(
      viewport.artifacts.some((artifact) => artifact.key === "checkpoint-desktop-1"),
    ).toBe(false);
    expect(
      attempt.artifacts.some((artifact) => artifact.key === "checkpoint-desktop-1"),
    ).toBe(false);
  }, 60_000);

  it("stops with SCROLL_OFFSET_MISMATCH when a requested scroll snaps elsewhere", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(`
          <style>
            html { scroll-snap-type: y mandatory; }
            html, body { margin: 0; }
            section { box-sizing: border-box; height: 500px; scroll-snap-align: start; }
            h2 { margin: 0; }
          </style>
          <main>
            <section class="snap-first"><h2>First</h2></section>
            <section class="snap-second"><h2>Second</h2></section>
            <section class="snap-third"><h2>Third</h2></section>
            <div style="height:350px"></div>
          </main>`),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const screenshotScrollY: number[] = [];
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      {
        cache,
        allowPrivateOrigins: [origin],
        totalBudgetMs: 45_000,
        settle: async (page: any) => {
          await page.waitForTimeout(100);
        },
        screenshot: async (page: any) => {
          screenshotScrollY.push(await page.evaluate(() => window.scrollY));
          return page.screenshot({ fullPage: false, type: "png" });
        },
      },
    );
    const viewport = attempt.viewports[0]!;
    // 1850px tall in a 900px viewport requests 0, 475 and 950; the mandatory
    // snap pulls 475 to 500, so the capture must not claim checkpoint 1.
    expect(attempt.status).toBe("partial");
    expect(attempt.limitations).toContain("SCROLL_OFFSET_MISMATCH");
    expect(screenshotScrollY).toEqual([0]);
    expect(viewport.screenshots).toHaveLength(1);
    expect(viewport.observations?.some((item) => item.checkpoint === 1)).toBe(false);
  }, 60_000);

  it("bounds component candidates and packs during acquisition", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      const buttons = Array.from(
        { length: 130 },
        (_, index) => `<button aria-label="Action ${index}">Action ${index}</button>`,
      ).join("");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Components</h1>
            <div role="dialog" aria-label="Menu" style="position:fixed;transform:translateX(-100%);width:200px;height:300px">
              <button>Inside</button>
            </div>
            ${buttons}
          </section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    const scan = attempt.viewports[0]!.scan;
    const components = scan.components ?? [];
    expect(components).toHaveLength(120);
    expect(scan.componentLimitHit).toBe(true);
    expect(new Set(components.map((component) => component.nodeKey)).size).toBe(120);
    const packs = components.filter((component) => component.pack);
    expect(packs.length).toBeLessThanOrEqual(12);
    for (const component of packs) {
      expect(component.pack!.nodes.length).toBeLessThanOrEqual(150);
      expect(Math.max(...component.pack!.nodes.map((node) => node.depth))).toBeLessThanOrEqual(12);
    }
    // The fixed panel still overlaps the viewport by 8px, so it is a visible
    // large candidate; the cap and pack bounds are what this test binds.
    expect(components.some((component) => component.hint === "dialog")).toBe(true);
    expect(components[0]!.hint).toBe("dialog");
    // Checkpoint scans run the browser-side scan with components disabled.
    const checkpoint = attempt.viewports[0]!.artifacts.find(
      (artifact) => artifact.key === "checkpoint-desktop-0",
    );
    expect(checkpoint).toBeTruthy();
    const checkpointPayload = JSON.parse(
      readFileSync(join(cache.rootDir, checkpoint!.storagePath), "utf8"),
    ) as { scan: { components?: unknown[] } };
    expect(checkpointPayload.scan.components ?? []).toEqual([]);
  }, 60_000);

  it("skips the component loop when the scan is told not to collect components", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Controls</h1><button>Action</button><a href="/x">Link</a></section></main>`,
        ),
      );
    });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1_200, height: 800 } });
      await page.goto(`${origin}/`);
      const withComponents = (await page.evaluate(
        ATLAS_SECTION_SCAN,
        ATLAS_COMPONENT_HINTS,
      )) as AtlasPageScan;
      const withoutComponents = (await page.evaluate(ATLAS_SECTION_SCAN, {
        ...ATLAS_COMPONENT_HINTS,
        components: false,
      })) as AtlasPageScan;
      expect(withComponents.components?.length).toBeGreaterThan(0);
      expect(withoutComponents.components ?? []).toEqual([]);
      expect(withoutComponents.sections.length).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("records hidden and offscreen controls without claiming they are usable", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Controls</h1>
            <input type="text" aria-label="Hidden field" style="display:none">
            <button aria-label="Offscreen action" style="position:absolute;left:-9999px;top:0">Offscreen</button>
            <button aria-label="Visible action">Visible</button>
          </section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    const components = attempt.viewports[0]!.scan.components ?? [];
    const hidden = components.find((component) => component.label === "Hidden field")!;
    const offscreen = components.find((component) => component.label === "Offscreen action")!;
    const visible = components.find((component) => component.label === "Visible action")!;
    expect(hidden.hint).toBe("text_input");
    expect(hidden.visible).toBe(false);
    expect(offscreen.visible).toBe(true);
    expect(offscreen.offscreen).toBe(true);
    expect(visible.visible).toBe(true);
    expect(visible.offscreen).toBe(false);
    const discovered = attempt.viewports[0]!.components ?? [];
    expect(discovered.find((component) => component.label === "Hidden field")!.typeDecision).toBe(
      "candidate",
    );
    expect(
      discovered.find((component) => component.label === "Offscreen action")!.typeDecision,
    ).toBe("candidate");
    expect(discovered.find((component) => component.label === "Visible action")!.typeDecision).toBe(
      "accepted",
    );
  }, 60_000);

  it("keeps card inference structural and drops lossy listbox and grid aliases", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Cards</h1>
            <ul class="cards">
              <li class="card"><h3>One</h3><a href="/one">Open</a></li>
              <li class="card"><h3>Two</h3><a href="/two">Open</a></li>
            </ul>
            <article class="long">
              <h2>Story</h2>
              <p>First paragraph of a long editorial article.</p>
              <p>Second paragraph of the same article.</p>
              <p>Third paragraph with <a href="/more">a link</a>.</p>
            </article>
            <div role="listbox" aria-label="Options"><div role="option">A</div></div>
            <div role="grid" aria-label="Sheet"><div role="row">B</div></div>
          </section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    const viewport = attempt.viewports[0]!;
    const scan = viewport.scan;
    const cards = (scan.components ?? []).filter(
      (component) => component.tag === "li" && component.hint === "card",
    );
    expect(cards).toHaveLength(2);
    expect(cards.every((component) => component.hint === "card")).toBe(true);
    expect((scan.components ?? []).some((component) => component.tag === "article")).toBe(false);
    expect(
      (scan.components ?? []).some(
        (component) => component.role === "listbox" || component.role === "grid",
      ),
    ).toBe(false);
    const discoveredCards = (viewport.components ?? []).filter(
      (component) => component.type === "card",
    );
    expect(discoveredCards).toHaveLength(2);
    expect(discoveredCards.every((component) => component.typeDecision === "candidate")).toBe(true);
  }, 60_000);

  it("omits an explicit unsupported ARIA role instead of aliasing the native tag", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Roles</h1>
            <table role="grid" aria-label="Grid table"><tr><td>1</td></tr></table>
            <ul role="listbox" aria-label="Listbox list"><li>One</li></ul>
            <table aria-label="Plain table"><tr><td>2</td></tr></table>
            <ul aria-label="Plain list"><li>Two</li></ul>
          </section></main>`,
        ),
      );
    });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1_200, height: 800 } });
      await page.goto(`${origin}/`);
      const scan = (await page.evaluate(
        ATLAS_SECTION_SCAN,
        ATLAS_COMPONENT_HINTS,
      )) as AtlasPageScan;
      const components = scan.components ?? [];
      expect(components.find((component) => component.label === "Grid table")).toBeUndefined();
      expect(components.find((component) => component.label === "Listbox list")).toBeUndefined();
      expect(components.find((component) => component.label === "Plain table")?.hint).toBe("table");
      expect(components.find((component) => component.label === "Plain list")?.hint).toBe("list");
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("bounds the nav aria-label before matching breadcrumb", async () => {
    const longLabel = `${"z".repeat(200)}breadcrumb`;
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Navigation</h1>
            <nav aria-label="  Breadcrumb  "><a href="/home">Home</a></nav>
            <nav aria-label="${longLabel}"><a href="/long">Long</a></nav>
            <nav aria-label="  Products  "><a href="/products">Products</a></nav>
          </section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    const navs = (attempt.viewports[0]!.scan.components ?? []).filter(
      (component) => component.tag === "nav",
    );
    expect(navs).toHaveLength(3);
    const breadcrumb = navs.find((component) => component.label === "Breadcrumb")!;
    expect(breadcrumb.hint).toBe("breadcrumb");
    expect(breadcrumb.ariaLabel).toBe("Breadcrumb");
    // The padded value is trimmed before export, not carried as written.
    expect(breadcrumb.ariaLabel).not.toBe("  Breadcrumb  ");
    const capped = navs.find((component) => component.ariaLabel?.startsWith("z"))!;
    expect(capped.ariaLabel).toBe("z".repeat(200));
    expect(capped.ariaLabel!.length).toBe(200);
    expect(capped.hint).toBe("navigation");
    const plain = navs.find((component) => component.label === "Products")!;
    expect(plain.hint).toBe("navigation");
    expect(plain.ariaLabel).toBe("Products");
  }, 60_000);

  it("keys distinct three-level trees apart while identical trees share one pattern", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Trees</h1>
            <button aria-label="Tree A"><div><div></div><div></div></div><div></div></button>
            <button aria-label="Tree B"><div><div></div></div><div><div></div></div></button>
            <button aria-label="Twin A"><div><div></div><div></div></div><div></div></button>
            <button aria-label="Twin B"><div><div></div><div></div></div><div></div></button>
          </section></main>`,
        ),
      );
    });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1_200, height: 800 } });
      await page.goto(`${origin}/`);
      const scan = (await page.evaluate(
        ATLAS_SECTION_SCAN,
        ATLAS_COMPONENT_HINTS,
      )) as AtlasPageScan;
      const candidates = discoverComponents(scan);
      const byLabel = new Map(candidates.map((candidate) => [candidate.label, candidate]));
      const treeA = byLabel.get("Tree A")!;
      const treeB = byLabel.get("Tree B")!;
      const twinA = byLabel.get("Twin A")!;
      const twinB = byLabel.get("Twin B")!;
      expect(treeA.patternKey).not.toBe(treeB.patternKey);
      expect(twinA.patternKey).toBe(twinB.patternKey);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("records off-canvas and clipped controls without accepting them", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Clipping</h1>
            <button aria-label="Fixed below" style="position:fixed;left:10px;top:900px">Fixed</button>
            <div style="height:100px;overflow:hidden;position:relative">
              <button aria-label="Fully clipped" style="position:absolute;top:200px">Clipped</button>
            </div>
            <div style="height:100px;overflow:hidden;position:relative">
              <button aria-label="Partially visible" style="position:absolute;top:80px">Partial</button>
            </div>
          </section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    const scan = attempt.viewports[0]!.scan;
    const components = scan.components ?? [];
    const fixed = components.find((component) => component.label === "Fixed below")!;
    const clipped = components.find((component) => component.label === "Fully clipped")!;
    const partial = components.find((component) => component.label === "Partially visible")!;
    expect(fixed).toMatchObject({
      visible: true,
      offscreen: false,
      offCanvas: true,
      fullyClipped: true,
    });
    expect(clipped).toMatchObject({
      visible: true,
      offscreen: false,
      offCanvas: false,
      fullyClipped: true,
    });
    expect(partial).toMatchObject({
      visible: true,
      offscreen: false,
      offCanvas: false,
      fullyClipped: false,
    });
    const published = await publishCapture(attempt);
    expect(published.published, published.code).toBe(true);
    const labelByRegion = cache.withAtlasDb(
      (db) =>
        new Map(
          (
            db
              .prepare("SELECT id, heading FROM atlas_regions WHERE kind = 'component'")
              .all() as Array<{ id: string; heading: string }>
          ).map((row) => [row.id, row.heading]),
        ),
    );
    const accepted = searchAtlas(
      { kind: "components", evidenceMode: "accepted", groupBy: "instance", limit: 20 },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!accepted.ok) throw new Error(accepted.error.code);
    expect(accepted.data.results.map((hit) => labelByRegion.get(hit.regionId))).toEqual([
      "Partially visible",
    ]);
    const candidates = searchAtlas(
      { kind: "components", evidenceMode: "candidate", groupBy: "instance", limit: 20 },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!candidates.ok) throw new Error(candidates.error.code);
    expect(candidates.data.total).toBe(3);
  }, 60_000);

  it("applies padding boxes and containing-block chains to effective visibility", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Effective visibility</h1>
            <div style="position:static;width:200px;height:100px;overflow:hidden;border:10px solid #000">
              <button aria-label="Visible positioned" style="position:absolute;left:400px;top:0;width:140px;height:40px">Visible positioned</button>
            </div>
            <div style="position:relative;width:160px;height:60px;overflow:hidden;border:20px solid #000">
              <button aria-label="Hidden border" style="position:absolute;left:-15px;top:-15px;width:10px;height:10px">Hidden border</button>
            </div>
            <div style="position:relative;width:240px;height:140px;overflow:hidden;border:24px solid #000">
              <div style="position:absolute;left:10px;top:10px;width:160px;height:90px;overflow:hidden;border:18px solid #000">
                <button aria-label="Combined clipping" style="position:absolute;left:-12px;top:-12px;width:8px;height:8px">Combined clipping</button>
              </div>
            </div>
            <div style="width:200px;height:60px;overflow:hidden">
              <button aria-label="Static clipped" style="margin-top:150px;width:80px;height:30px">Static clipped</button>
            </div>
          </section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    const scan = attempt.viewports[0]!.scan;
    const byLabel = new Map(
      (scan.components ?? []).map((component) => [component.label, component]),
    );
    expect(byLabel.get("Visible positioned")).toMatchObject({ fullyClipped: false });
    expect(byLabel.get("Hidden border")).toMatchObject({ fullyClipped: true });
    expect(byLabel.get("Combined clipping")).toMatchObject({ fullyClipped: true });
    expect(byLabel.get("Static clipped")).toMatchObject({ fullyClipped: true });
    const published = await publishCapture(attempt);
    expect(published.published, published.code).toBe(true);
    const labelByRegion = cache.withAtlasDb(
      (db) =>
        new Map(
          (
            db
              .prepare("SELECT id, heading FROM atlas_regions WHERE kind = 'component'")
              .all() as Array<{ id: string; heading: string }>
          ).map((row) => [row.id, row.heading]),
        ),
    );
    const accepted = searchAtlas(
      { kind: "components", evidenceMode: "accepted", groupBy: "instance", limit: 20 },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!accepted.ok) throw new Error(accepted.error.code);
    expect(accepted.data.results.map((hit) => labelByRegion.get(hit.regionId))).toEqual([
      "Visible positioned",
    ]);
    const observed = searchAtlas(
      { kind: "components", evidenceMode: "observed_only", groupBy: "instance", limit: 20 },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!observed.ok) throw new Error(observed.error.code);
    expect(observed.data.results.map((hit) => labelByRegion.get(hit.regionId))).toEqual([
      "Visible positioned",
    ]);
    const candidates = searchAtlas(
      { kind: "components", evidenceMode: "candidate", groupBy: "instance", limit: 20 },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!candidates.ok) throw new Error(candidates.error.code);
    expect(candidates.data.total).toBe(4);
  }, 60_000);

  it("hit-tests visibility through transforms, escaping wrappers and overlays", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Hit-test visibility</h1>
            <div style="transform:scale(2);transform-origin:0 0;width:120px;height:60px;overflow:hidden;margin:20px">
              <button aria-label="Scaled fixed" style="position:fixed;left:70px;top:10px;width:40px;height:24px">Scaled fixed</button>
            </div>
            <div style="position:static;width:160px;height:40px;overflow:hidden;border:1px solid #000;margin:20px">
              <div style="position:absolute;left:320px;top:20px">
                <button aria-label="Escaping wrapper" style="width:150px;height:30px">Escaping wrapper</button>
              </div>
            </div>
            <div style="position:relative;width:160px;height:40px;overflow:hidden;margin:20px">
              <button aria-label="Fully clipped" style="position:absolute;top:200px;width:120px;height:30px">Fully clipped</button>
            </div>
            <div style="position:relative;width:160px;height:60px;overflow:hidden;border:20px solid #000;margin:20px">
              <button aria-label="Hidden border" style="position:absolute;left:-16px;top:-16px;width:10px;height:10px">Hidden border</button>
            </div>
            <div style="position:relative;width:180px;height:40px;margin:20px">
              <button aria-label="Covered overlay" style="width:180px;height:40px">Covered overlay</button>
              <div aria-hidden="true" style="position:absolute;inset:0;background:#000"></div>
            </div>
            <div style="position:relative;width:160px;height:60px;overflow:hidden;margin:20px">
              <button aria-label="Partial edge" style="position:absolute;top:45px;width:120px;height:30px">Partial edge</button>
            </div>
            <button aria-label="Fixed below viewport" style="position:fixed;left:10px;top:2000px">Fixed below viewport</button>
          </section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    const scan = attempt.viewports[0]!.scan;
    const byLabel = new Map(
      (scan.components ?? []).map((component) => [component.label, component]),
    );
    expect(byLabel.get("Scaled fixed")).toMatchObject({ fullyClipped: false });
    expect(byLabel.get("Escaping wrapper")).toMatchObject({ fullyClipped: false });
    expect(byLabel.get("Partial edge")).toMatchObject({ fullyClipped: false });
    expect(byLabel.get("Fully clipped")).toMatchObject({ visible: true, fullyClipped: true });
    expect(byLabel.get("Hidden border")).toMatchObject({ visible: true, fullyClipped: true });
    expect(byLabel.get("Covered overlay")).toMatchObject({ visible: true, fullyClipped: true });
    expect(byLabel.get("Fixed below viewport")).toMatchObject({
      offCanvas: true,
      fullyClipped: true,
    });
    const published = await publishCapture(attempt);
    expect(published.published, published.code).toBe(true);
    const labelByRegion = cache.withAtlasDb(
      (db) =>
        new Map(
          (
            db
              .prepare("SELECT id, heading FROM atlas_regions WHERE kind = 'component'")
              .all() as Array<{ id: string; heading: string }>
          ).map((row) => [row.id, row.heading]),
        ),
    );
    const labels = (mode: "accepted" | "observed_only" | "candidate") => {
      const result = searchAtlas(
        { kind: "components", evidenceMode: mode, groupBy: "instance", limit: 20 },
        atlasSearchStore(cache),
        Date.now(),
      );
      if (!result.ok) throw new Error(result.error.code);
      return result;
    };
    const visible = ["Escaping wrapper", "Partial edge", "Scaled fixed"];
    expect(
      labels("accepted")
        .data.results.map((hit) => labelByRegion.get(hit.regionId))
        .sort(),
    ).toEqual(visible);
    expect(
      labels("observed_only")
        .data.results.map((hit) => labelByRegion.get(hit.regionId))
        .sort(),
    ).toEqual(visible);
    expect(labels("candidate").data.total).toBe(7);
  }, 60_000);

  it("clips a fixed control only inside its fixed containing block", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<main><section><h1>Fixed containing block</h1>
            <div style="width:200px;height:120px;overflow:hidden;border:10px solid #000">
              <button aria-label="Visible fixed" style="position:fixed;left:500px;top:20px;width:100px;height:30px">Visible fixed</button>
            </div>
            <div style="width:200px;height:120px;overflow:hidden;border:10px solid #000;transform:translateZ(0)">
              <button aria-label="Clipped fixed" style="position:fixed;left:700px;top:200px;width:100px;height:30px">Clipped fixed</button>
            </div>
          </section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const attempt = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    const scan = attempt.viewports[0]!.scan;
    const byLabel = new Map(
      (scan.components ?? []).map((component) => [component.label, component]),
    );
    expect(byLabel.get("Visible fixed")).toMatchObject({ fullyClipped: false });
    expect(byLabel.get("Clipped fixed")).toMatchObject({ fullyClipped: true });
    const published = await publishCapture(attempt);
    expect(published.published, published.code).toBe(true);
    const labelByRegion = cache.withAtlasDb(
      (db) =>
        new Map(
          (
            db
              .prepare("SELECT id, heading FROM atlas_regions WHERE kind = 'component'")
              .all() as Array<{ id: string; heading: string }>
          ).map((row) => [row.id, row.heading]),
        ),
    );
    const accepted = searchAtlas(
      { kind: "components", evidenceMode: "accepted", groupBy: "instance", limit: 20 },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!accepted.ok) throw new Error(accepted.error.code);
    expect(accepted.data.results.map((hit) => labelByRegion.get(hit.regionId))).toEqual([
      "Visible fixed",
    ]);
    const candidates = searchAtlas(
      { kind: "components", evidenceMode: "candidate", groupBy: "instance", limit: 20 },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!candidates.ok) throw new Error(candidates.error.code);
    expect(candidates.data.total).toBe(2);
  }, 60_000);

  it("captures real hover and focus samples with resets between states", async () => {
    let clicks = 0;
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      if (path === "/clicked") {
        clicks += 1;
        res.writeHead(204);
        res.end();
        return;
      }
      if (path === "/state-page") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          "<!doctype html>" +
            shell(
              `<style>
                 body { margin: 0; }
                 #focus-input:focus-visible { outline: 4px solid rgb(220, 20, 60); outline-offset: 2px; }
                 #hover-target { display: inline-block; padding: 10px; color: rgb(10, 10, 10); background-color: rgb(240, 240, 240); }
                 #hover-target:hover { color: rgb(250, 250, 250); background-color: rgb(20, 60, 200); }
                 section#tail:hover { background-color: rgb(230, 240, 255); }
               </style>
               <main>
                 <section id="hero"><h1>State fixture</h1><input id="focus-input" aria-label="Focus target"><div style="height:1400px"></div></section>
                 <section id="tail"><h2>Tail section</h2><a id="hover-target" href="#tail">Hover target</a></section>
               </main>`,
              "document.addEventListener('click', () => { fetch('/clicked'); });",
            ),
        );
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing");
    });
    // Count mutation methods at the fixture boundary, not only click handlers.
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/state-page`)]);
    const first = await collectAtlasPage(
      { siteSlug: "chromium-fixture", path: "/state-page", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect((await publishCapture(first)).published).toBe(true);
    const firstRevision = cache.withAtlasDb(
      (db) =>
        (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
          revision: number;
        }).revision,
    );
    const ids = cache.withAtlasDb((db) =>
      (
        db
          .prepare(
            "SELECT id, locator_json FROM atlas_regions WHERE kind = 'component'",
          )
          .all() as Array<{ id: string; locator_json: string }>
      )
        .map((row) => ({
          id: row.id,
          selector: String((JSON.parse(row.locator_json) as any).selector ?? ""),
        }))
        .filter((row) => row.selector.includes("#focus-input") || row.selector.includes("#hover-target")),
    );
    const focusId = ids.find((row) => row.selector.includes("#focus-input"))!.id;
    const hoverId = ids.find((row) => row.selector.includes("#hover-target"))!.id;
    const sectionIds = cache.withAtlasDb(
      (db) =>
        db
          .prepare("SELECT id, locator_json FROM atlas_regions WHERE kind = 'section'")
          .all() as Array<{ id: string; locator_json: string }>,
    );
    const tailSectionId = sectionIds.find((row) =>
      String((JSON.parse(row.locator_json) as any).selector ?? "").includes("#tail"),
    )!.id;

    const second = await collectAtlasPage(
      {
        siteSlug: "chromium-fixture",
        path: "/state-page",
        viewports: ["desktop"],
        states: [
          { action: "focus", targetRegionId: focusId },
          { action: "hover", targetRegionId: hoverId },
          { action: "hover", targetRegionId: tailSectionId },
        ],
      },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    const published = await publishCapture(second);
    expect(published.published, published.code).toBe(true);
    const viewport = second.viewports[0]!;
    expect(viewport.states).toEqual([
      expect.objectContaining({ action: "focus", targetRegionId: focusId, status: "observed" }),
      expect.objectContaining({ action: "hover", targetRegionId: hoverId, status: "observed" }),
      expect.objectContaining({
        action: "hover",
        targetRegionId: tailSectionId,
        status: "observed",
      }),
    ]);
    const stateObservations = (viewport.observations ?? []).filter(
      (observation) => observation.state !== "default",
    );
    expect(stateObservations).toHaveLength(3);
    const sectionObservation = stateObservations.find(
      (observation) => observation.regions[0]!.targetRegionId === tailSectionId,
    )!;
    expect(sectionObservation.state).toBe("hover");
    expect(sectionObservation.regions[0]!.sampleKey).toContain(":state-hover");
    expect(
      viewport.claims.find(
        (claim) =>
          claim.value === "hover_change_observed" &&
          claim.sampleKey === sectionObservation.regions[0]!.sampleKey,
      ),
    ).toBeDefined();
    expect(viewport.claims.filter((claim) => claim.field === "behavior")).toHaveLength(3);
    const focusObservation = stateObservations.find(
      (observation) => observation.state === "focus",
    )!;
    const hoverObservation = stateObservations.find(
      (observation) => observation.state === "hover",
    )!;
    expect(focusObservation.scrollY).toBe(0);
    expect(hoverObservation.scrollY).toBeGreaterThan(0);
    expect(focusObservation.regions[0]).toMatchObject({
      targetRegionId: focusId,
      visible: true,
      coordinateSpace: "document",
    });
    expect(hoverObservation.regions[0]).toMatchObject({
      targetRegionId: hoverId,
      visible: true,
      coordinateSpace: "document",
    });
    expect(hoverObservation.regions[0]!.rect.y).not.toBe(
      focusObservation.regions[0]!.rect.y,
    );

    const claims = viewport.claims.filter((claim) => claim.field === "behavior");
    expect(claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "focus_visible_observed",
          decision: "accepted",
          classification: "observed",
          basis: "interaction_observation",
          sampleKey: focusObservation.regions[0]!.sampleKey,
        }),
        expect.objectContaining({
          value: "hover_change_observed",
          decision: "accepted",
          classification: "observed",
          basis: "interaction_observation",
          sampleKey: hoverObservation.regions[0]!.sampleKey,
        }),
      ]),
    );

    const focusArtifact = viewport.artifacts.find(
      (artifact) => artifact.key === "state-desktop-0-focus",
    )!;
    const hoverArtifact = viewport.artifacts.find(
      (artifact) => artifact.key === "state-desktop-1-hover",
    )!;
    const focusEvidence = JSON.parse(
      readFileSync(join(cache.rootDir, focusArtifact.storagePath), "utf8"),
    );
    const hoverEvidence = JSON.parse(
      readFileSync(join(cache.rootDir, hoverArtifact.storagePath), "utf8"),
    );
    expect(focusEvidence.activeElement).toMatchObject({ self: true, within: true });
    expect(focusEvidence.focusVisible).toBe(true);
    expect(focusEvidence.changedProperties).toContain("outlineStyle");
    expect(focusEvidence.baselineScroll).toEqual({ x: 0, y: 0 });
    expect(hoverEvidence.hovered).toBe(true);
    expect(hoverEvidence.activeElement.within).toBe(false);
    expect(hoverEvidence.baselineScroll).toEqual({ x: 0, y: 0 });
    expect(hoverEvidence.changedProperties).toEqual(
      expect.arrayContaining(["backgroundColor", "color"]),
    );

    const head = cache.withAtlasDb((db) => {
      const headRow = db
        .prepare(
          "SELECT capture_id FROM atlas_heads WHERE page_id = (SELECT page_id FROM atlas_captures WHERE id = ?) AND profile_key = 'live-desktop'",
        )
        .get(published.captureIds[0]!) as { capture_id: string };
      const headCount = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM atlas_heads WHERE page_id = (SELECT page_id FROM atlas_captures WHERE id = ?) AND profile_key = 'live-desktop'",
          )
          .get(published.captureIds[0]!) as { n: number }
      ).n;
      const samples = db
        .prepare(
          `SELECT r.samples_json FROM atlas_regions r
           WHERE r.capture_id = ?
             AND json_extract(r.locator_json, '$.selector') LIKE '%#hover-target%'`,
        )
        .get(published.captureIds[0]!) as { samples_json: string };
      const sectionSamples = db
        .prepare(
          `SELECT r.samples_json FROM atlas_regions r
           WHERE r.capture_id = ?
             AND json_extract(r.locator_json, '$.selector') LIKE '%#tail%'`,
        )
        .get(published.captureIds[0]!) as { samples_json: string };
      return { headRow, headCount, samples, sectionSamples };
    });
    expect(head.headRow.capture_id).toBe(published.captureIds[0]);
    expect(head.headCount).toBe(1);
    expect(head.samples.samples_json).toContain('"state":"hover"');
    expect(head.sectionSamples.samples_json).toContain('"state":"hover"');
    expect(viewport.finalUrl).toBe(first.viewports[0]!.finalUrl);
    const secondRevision = cache.withAtlasDb(
      (db) =>
        (db.prepare("SELECT revision FROM atlas_state WHERE singleton = 1").get() as {
          revision: number;
        }).revision,
    );
    expect(secondRevision).toBeGreaterThan(firstRevision);
    const labelByRegion = cache.withAtlasDb(
      (db) =>
        new Map(
          (
            db
              .prepare(
                "SELECT id, heading FROM atlas_regions WHERE capture_id = ?",
              )
              .all(published.captureIds[0]!) as Array<{ id: string; heading: string }>
          ).map((row) => [row.id, row.heading]),
        ),
    );
    const hoverHits = searchAtlas(
      { kind: "components", state: "hover", evidenceMode: "accepted", groupBy: "instance", limit: 20 },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!hoverHits.ok) throw new Error(hoverHits.error.code);
    expect(hoverHits.data.outcome).toBe("matches");
    expect(hoverHits.data.results.map((hit) => labelByRegion.get(hit.regionId))).toEqual([
      "Hover target",
    ]);
    expect(hoverHits.data.results[0]!.state).toBe("hover");
    const focusHits = searchAtlas(
      { kind: "components", state: "focus", evidenceMode: "accepted", groupBy: "instance", limit: 20 },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!focusHits.ok) throw new Error(focusHits.error.code);
    expect(focusHits.data.results.map((hit) => labelByRegion.get(hit.regionId))).toEqual([
      "Focus target",
    ]);
    const defaultHits = searchAtlas(
      { kind: "components", evidenceMode: "accepted", groupBy: "instance", limit: 20 },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!defaultHits.ok) throw new Error(defaultHits.error.code);
    // The hover target is below the fold in the default scan, so its default
    // type claim is candidate-only. The accepted type claim exists only in the
    // hover sample and must not leak into default accepted search.
    expect(defaultHits.data.results.map((hit) => labelByRegion.get(hit.regionId))).toEqual([
      "Focus target",
    ]);
    const defaultCandidates = searchAtlas(
      { kind: "components", evidenceMode: "candidate", groupBy: "instance", limit: 20 },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!defaultCandidates.ok) throw new Error(defaultCandidates.error.code);
    expect(
      defaultCandidates.data.results
        .map((hit) => labelByRegion.get(hit.regionId))
        .sort(),
    ).toEqual(["Focus target", "Hover target"]);
    const sectionHits = searchAtlas(
      {
        kind: "sections",
        state: "hover",
        scope: "region",
        evidenceMode: "candidate",
        predicates: [{ field: "region.tag", values: ["section"] }],
        limit: 20,
      },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!sectionHits.ok) throw new Error(sectionHits.error.code);
    expect(sectionHits.data.outcome).toBe("matches");
    expect(sectionHits.data.results.map((hit) => labelByRegion.get(hit.regionId))).toEqual([
      "Tail section",
    ]);
    expect(clicks).toBe(0);
  }, 90_000);

  it("reports no measured change and unconfirmed focus as inconclusive", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html>" +
          shell(
          `<style>
             #flat-hover, #flat-hover:hover { color: rgb(0, 0, 0); background-color: rgb(255, 255, 255); border-color: rgb(0, 0, 0); outline: none; }
             #flat-focus, #flat-focus:focus, #flat-focus:focus-visible { outline: none !important; box-shadow: none !important; color: rgb(0, 0, 0) !important; background-color: rgb(255, 255, 255) !important; border-color: rgb(0, 0, 0) !important; }
           </style>
           <main><section id="s">
             <button id="flat-hover">Flat hover</button>
             <input id="flat-focus" aria-label="Flat focus">
             <input id="blurred" aria-label="Blurred focus" onfocus="this.blur()">
           </section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const first = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect((await publishCapture(first)).published).toBe(true);
    const ids = cache.withAtlasDb((db) =>
      (
        db
          .prepare("SELECT id, locator_json FROM atlas_regions WHERE kind = 'component'")
          .all() as Array<{ id: string; locator_json: string }>
      ).map((row) => ({
        id: row.id,
        selector: String((JSON.parse(row.locator_json) as any).selector ?? ""),
      })),
    );
    const flatHover = ids.find((row) => row.selector.includes("#flat-hover"))!.id;
    const flatFocus = ids.find((row) => row.selector.includes("#flat-focus"))!.id;
    const blurred = ids.find((row) => row.selector.includes("#blurred"))!.id;
    const second = await collectAtlasPage(
      {
        siteSlug: "chromium-fixture",
        viewports: ["desktop"],
        states: [
          { action: "hover", targetRegionId: flatHover },
          { action: "focus", targetRegionId: flatFocus },
          { action: "focus", targetRegionId: blurred },
        ],
      },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(second.viewports[0]!.states).toEqual([
      expect.objectContaining({
        action: "hover",
        targetRegionId: flatHover,
        status: "inconclusive",
        code: "STATE_NO_CHANGE",
      }),
      expect.objectContaining({
        action: "focus",
        targetRegionId: flatFocus,
        status: "inconclusive",
        code: "STATE_NO_CHANGE",
      }),
      expect.objectContaining({
        action: "focus",
        targetRegionId: blurred,
        status: "inconclusive",
        code: "STATE_FOCUS_UNCONFIRMED",
      }),
    ]);
    expect(
      second.viewports[0]!.claims.filter((claim) => claim.field === "behavior"),
    ).toEqual([]);
    expect(
      (second.viewports[0]!.observations ?? []).filter(
        (observation) => observation.state !== "default",
      ),
    ).toEqual([]);
    expect((await publishCapture(second)).published).toBe(true);
  }, 90_000);

  it("reports ambiguous, missing and changed state targets without fallback", async () => {
    let variant = 0;
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          variant === 0
            ? `<main><section id="s">
                 <a id="changed" class="c" href="#changed">Original label</a>
                 <button id="removed">Remove me</button>
                 <div><button class="dup">Duplicate one</button></div>
                 <div><button class="dup">Duplicate two</button></div>
               </section></main>`
            : `<main><section id="s">
                 <a id="changed" class="c" href="#changed">Changed label</a>
                 <div><button class="dup">Duplicate one</button></div>
                 <div><button class="dup">Duplicate two</button></div>
               </section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const first = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect((await publishCapture(first)).published).toBe(true);
    const ids = cache.withAtlasDb((db) =>
      (
        db
          .prepare("SELECT id, locator_json FROM atlas_regions WHERE kind = 'component'")
          .all() as Array<{ id: string; locator_json: string }>
      ).map((row) => ({
        id: row.id,
        selector: String((JSON.parse(row.locator_json) as any).selector ?? ""),
      })),
    );
    const changedId = ids.find((row) => row.selector.includes("#changed"))!.id;
    const removedId = ids.find((row) => row.selector.includes("#removed"))!.id;
    const ambiguousId = ids.find((row) => row.selector.includes("button.dup"))!.id;
    variant = 1;
    const second = await collectAtlasPage(
      {
        siteSlug: "chromium-fixture",
        viewports: ["desktop"],
        states: [
          { action: "hover", targetRegionId: changedId },
          { action: "hover", targetRegionId: removedId },
          { action: "focus", targetRegionId: ambiguousId },
        ],
      },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(second.viewports[0]!.states).toEqual([
      expect.objectContaining({
        action: "hover",
        targetRegionId: changedId,
        status: "inconclusive",
        code: "STATE_TARGET_CHANGED",
      }),
      expect.objectContaining({
        action: "hover",
        targetRegionId: removedId,
        status: "inconclusive",
        code: "STATE_TARGET_MISSING",
      }),
      expect.objectContaining({
        action: "focus",
        targetRegionId: ambiguousId,
        status: "inconclusive",
        code: "STATE_TARGET_AMBIGUOUS",
      }),
    ]);
    expect(
      (second.viewports[0]!.observations ?? []).filter(
        (observation) => observation.state !== "default",
      ),
    ).toEqual([]);
    expect(
      second.viewports[0]!.claims.filter((claim) => claim.field === "behavior"),
    ).toEqual([]);
    expect(second.limitations).toEqual(
      expect.arrayContaining([
        "STATE_TARGET_CHANGED",
        "STATE_TARGET_MISSING",
        "STATE_TARGET_AMBIGUOUS",
      ]),
    );
    const published = await publishCapture(second);
    expect(published.published, published.code).toBe(true);
  }, 90_000);

  it("normalizes nested inline identity and re-emits purpose evidence for state search", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html>" +
          shell(
          `<style>
             #inline-section:hover { background-color: rgb(235, 245, 255); }
             #inline-link { color: rgb(10, 10, 10); }
             #inline-link:hover { color: rgb(200, 20, 20); }
             #focus-wrap { display: block; width: 220px; padding: 8px; }
             #focus-wrap:focus-within { background-color: rgb(255, 240, 200); }
             #inner:focus-visible { outline: 4px solid rgb(20, 80, 220); }
           </style>
           <main>
             <header id="inline-section"><h2>Inline<span>heading</span></h2><p>Nested inline body</p></header>
             <a id="inline-link" href="#inline-link"><span>Nested</span><span>inline</span></a>
             <div id="focus-wrap" role="button" tabindex="0"
                  onfocus="document.getElementById('inner').focus({ focusVisible: true })">
               <span id="inner" tabindex="0">Inner</span>
             </div>
           </main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const first = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect((await publishCapture(first)).published).toBe(true);
    const ids = cache.withAtlasDb((db) =>
      (
        db
          .prepare(
            "SELECT id, kind, locator_json FROM atlas_regions WHERE kind IN ('section','component')",
          )
          .all() as Array<{ id: string; kind: string; locator_json: string }>
      ).map((row) => ({
        id: row.id,
        kind: row.kind,
        selector: String((JSON.parse(row.locator_json) as any).selector ?? ""),
      })),
    );
    const sectionId = ids.find((row) => row.selector.includes("#inline-section"))!.id;
    const linkId = ids.find((row) => row.selector.includes("#inline-link"))!.id;
    const focusId = ids.find((row) => row.selector.includes("#focus-wrap"))!.id;
    const second = await collectAtlasPage(
      {
        siteSlug: "chromium-fixture",
        viewports: ["desktop"],
        states: [
          { action: "hover", targetRegionId: sectionId },
          { action: "hover", targetRegionId: linkId },
          { action: "focus", targetRegionId: focusId },
        ],
      },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(second.viewports[0]!.states).toEqual([
      expect.objectContaining({ targetRegionId: sectionId, status: "observed" }),
      expect.objectContaining({ targetRegionId: linkId, status: "observed" }),
      expect.objectContaining({ targetRegionId: focusId, status: "observed" }),
    ]);
    const stateObservations = (second.viewports[0]!.observations ?? []).filter(
      (observation) => observation.state !== "default",
    );
    expect(stateObservations).toHaveLength(3);
    expect(stateObservations.every((observation) => observation.scanArtifactKey === "scan-desktop")).toBe(
      true,
    );
    expect(
      stateObservations.every((observation) =>
        Boolean(observation.stateArtifactKey?.startsWith("state-desktop-")),
      ),
    ).toBe(true);
    const focusEvidence = JSON.parse(
      readFileSync(
        join(
          cache.rootDir,
          second.viewports[0]!.artifacts.find(
            (artifact) => artifact.key === "state-desktop-2-focus",
          )!.storagePath,
        ),
        "utf8",
      ),
    );
    expect(focusEvidence.activeElement).toMatchObject({ within: true, self: false });
    expect(focusEvidence.focusVisible).toBe(true);
    expect(focusEvidence.changedProperties).toContain("backgroundColor");
    const published = await publishCapture(second);
    expect(published.published, published.code).toBe(true);
    const purposeHits = searchAtlas(
      {
        kind: "sections",
        state: "hover",
        scope: "region",
        evidenceMode: "candidate",
        predicates: [{ field: "section.purpose", values: ["header"] }],
        limit: 20,
      },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!purposeHits.ok) throw new Error(purposeHits.error.code);
    expect(purposeHits.data.outcome).toBe("matches");
    expect(purposeHits.data.results.map((hit) => hit.regionId)).toContain(
      cache.withAtlasDb(
        (db) =>
          (
            db
              .prepare(
                "SELECT id FROM atlas_regions WHERE capture_id = ? AND locator_json LIKE '%#inline-section%'",
              )
              .get(published.captureIds[0]!) as { id: string }
          ).id,
      ),
    );
  }, 90_000);

  it("rejects a structural change even when selector, tag and label are unchanged", async () => {
    let variant = 0;
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<style>
             ${variant === 0 ? "" : "#pattern-target { padding: 14px; }"}
             #pattern-target { display: inline-block; color: rgb(5, 5, 5); }
             #pattern-target:hover { color: rgb(220, 40, 40); }
           </style>
           <main><section id="s">
             <a id="pattern-target" href="#pattern-target"><span>Same</span><span>label</span></a>
           </section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const first = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect((await publishCapture(first)).published).toBe(true);
    const targetId = cache.withAtlasDb(
      (db) =>
        (
          db
            .prepare(
              "SELECT id FROM atlas_regions WHERE kind = 'component' AND locator_json LIKE '%#pattern-target%'",
            )
            .get() as { id: string }
        ).id,
    );
    variant = 1;
    const second = await collectAtlasPage(
      {
        siteSlug: "chromium-fixture",
        viewports: ["desktop"],
        states: [{ action: "hover", targetRegionId: targetId }],
      },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(second.viewports[0]!.states).toEqual([
      expect.objectContaining({
        targetRegionId: targetId,
        status: "inconclusive",
        code: "STATE_TARGET_CHANGED",
      }),
    ]);
    expect((await publishCapture(second)).published).toBe(true);
  }, 90_000);

  it("rejects targets relabelled or replaced by the interaction", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html>" +
          shell(
          `<style>
             body { margin: 0; }
             #relabel, #replace { display: inline-block; margin: 12px; padding: 10px;
               background-color: rgb(240, 240, 240); color: rgb(10, 10, 10); }
             #relabel:hover, #replace:hover { background-color: rgb(20, 60, 200); color: rgb(250, 250, 250); }
           </style>
           <main><section id="s"><h1>Interaction identity</h1>
             <a id="relabel" href="#relabel">Stable label</a>
             <button id="replace">Replace me</button>
           </section></main>`,
          `document.getElementById('relabel').addEventListener('mouseenter', () => {
             document.getElementById('relabel').textContent = 'Changed label';
           });
           document.getElementById('replace').addEventListener('focus', (event) => {
             event.target.outerHTML = '<button id="replace">Replace me</button>';
             document.getElementById('replace').focus({ focusVisible: true });
           });`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const first = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect((await publishCapture(first)).published).toBe(true);
    const ids = cache.withAtlasDb((db) =>
      (
        db
          .prepare("SELECT id, locator_json FROM atlas_regions WHERE kind = 'component'")
          .all() as Array<{ id: string; locator_json: string }>
      ).map((row) => ({
        id: row.id,
        selector: String((JSON.parse(row.locator_json) as any).selector ?? ""),
      })),
    );
    const relabelId = ids.find((row) => row.selector.includes("#relabel"))!.id;
    const replaceId = ids.find((row) => row.selector.includes("#replace"))!.id;
    const second = await collectAtlasPage(
      {
        siteSlug: "chromium-fixture",
        viewports: ["desktop"],
        states: [
          { action: "hover", targetRegionId: relabelId },
          { action: "focus", targetRegionId: replaceId },
        ],
      },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(second.viewports[0]!.states).toEqual([
      expect.objectContaining({
        action: "hover",
        targetRegionId: relabelId,
        status: "inconclusive",
        code: "STATE_TARGET_CHANGED",
      }),
      expect.objectContaining({
        action: "focus",
        targetRegionId: replaceId,
        status: "inconclusive",
        code: "STATE_TARGET_CHANGED",
      }),
    ]);
    expect(
      second.viewports[0]!.claims.filter((claim) => claim.field === "behavior"),
    ).toEqual([]);
    expect(
      (second.viewports[0]!.observations ?? []).filter(
        (observation) => observation.state !== "default",
      ),
    ).toEqual([]);
    const published = await publishCapture(second);
    expect(published.published, published.code).toBe(true);

    const acceptedHover = searchAtlas(
      {
        kind: "components",
        state: "hover",
        evidenceMode: "accepted",
        groupBy: "instance",
        limit: 20,
      },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!acceptedHover.ok) throw new Error(acceptedHover.error.code);
    expect(acceptedHover.data.total).toBe(0);
    expect(acceptedHover.data.outcome).toBe("insufficient_coverage");
    const candidateHover = searchAtlas(
      {
        kind: "components",
        state: "hover",
        evidenceMode: "candidate",
        groupBy: "instance",
        limit: 20,
      },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!candidateHover.ok) throw new Error(candidateHover.error.code);
    expect(candidateHover.data.total).toBe(0);

    const labelByRegion = cache.withAtlasDb(
      (db) =>
        new Map(
          (
            db
              .prepare("SELECT id, heading FROM atlas_regions WHERE kind = 'component'")
              .all() as Array<{ id: string; heading: string }>
          ).map((row) => [row.id, row.heading]),
        ),
    );
    const defaultHits = searchAtlas(
      {
        kind: "components",
        evidenceMode: "accepted",
        groupBy: "instance",
        limit: 20,
      },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!defaultHits.ok) throw new Error(defaultHits.error.code);
    expect(defaultHits.data.results.map((hit) => labelByRegion.get(hit.regionId))).toEqual(
      expect.arrayContaining(["Stable label", "Replace me"]),
    );
  }, 120_000);

  it("rejects a target whose structure changes after the interaction", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html>" +
          shell(
          `<style>
             body { margin: 0; }
             #shape { display: inline-block; margin: 12px; padding: 10px;
               background-color: rgb(240, 240, 240); color: rgb(10, 10, 10); }
             #shape:hover { background-color: rgb(20, 60, 200); }
           </style>
           <main><section id="s"><h1>Structure identity</h1>
             <button id="shape">Shape me</button>
           </section></main>`,
          `document.getElementById('shape').addEventListener('mouseenter', () => {
             const el = document.getElementById('shape');
             if (!el.querySelector('i')) el.appendChild(document.createElement('i'));
           });`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const first = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect((await publishCapture(first)).published).toBe(true);
    const id = cache.withAtlasDb((db) => {
      const row = db
        .prepare("SELECT id FROM atlas_regions WHERE kind = 'component' AND locator_json LIKE '%#shape%' LIMIT 1")
        .get() as { id?: string } | undefined;
      return row?.id;
    });
    expect(id).toBeTruthy();
    const second = await collectAtlasPage(
      {
        siteSlug: "chromium-fixture",
        viewports: ["desktop"],
        states: [{ action: "hover", targetRegionId: id! }],
      },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(second.viewports[0]!.states).toEqual([
      expect.objectContaining({
        action: "hover",
        targetRegionId: id,
        status: "inconclusive",
        code: "STATE_TARGET_CHANGED",
      }),
    ]);
    expect(
      second.viewports[0]!.claims.filter((claim) => claim.field === "behavior"),
    ).toEqual([]);
    expect((await publishCapture(second)).published).toBe(true);
  }, 120_000);

  it("requires the pointer to remain over the hover target", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html>" +
          shell(
          `<style>
             body { margin: 0; }
             #steady, #moved { display: inline-block; margin: 12px; padding: 10px;
               background-color: rgb(240, 240, 240); color: rgb(10, 10, 10); }
             #steady:hover, #moved:hover { background-color: rgb(20, 60, 200); color: rgb(250, 250, 250); }
           </style>
           <main><section id="s"><h1>Pointer position</h1>
             <a id="steady" href="#steady">Steady target</a>
             <a id="moved" href="#moved">Moved target</a>
           </section></main>`,
          `document.getElementById('moved').addEventListener('mouseenter', () => {
             document.getElementById('moved').style.transform = 'translateY(320px)';
           });`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const first = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect((await publishCapture(first)).published).toBe(true);
    const ids = cache.withAtlasDb((db) =>
      (
        db
          .prepare("SELECT id, locator_json FROM atlas_regions WHERE kind = 'component'")
          .all() as Array<{ id: string; locator_json: string }>
      ).map((row) => ({
        id: row.id,
        selector: String((JSON.parse(row.locator_json) as any).selector ?? ""),
      })),
    );
    const steadyId = ids.find((row) => row.selector.includes("#steady"))!.id;
    const movedId = ids.find((row) => row.selector.includes("#moved"))!.id;
    const second = await collectAtlasPage(
      {
        siteSlug: "chromium-fixture",
        viewports: ["desktop"],
        states: [
          { action: "hover", targetRegionId: steadyId },
          { action: "hover", targetRegionId: movedId },
        ],
      },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(second.viewports[0]!.states).toEqual([
      expect.objectContaining({
        action: "hover",
        targetRegionId: steadyId,
        status: "observed",
      }),
      expect.objectContaining({
        action: "hover",
        targetRegionId: movedId,
        status: "inconclusive",
        code: "STATE_HOVER_NOT_ACTIVE",
      }),
    ]);
    const behaviorClaims = second.viewports[0]!.claims.filter(
      (claim) => claim.field === "behavior",
    );
    expect(behaviorClaims).toHaveLength(1);
    expect(behaviorClaims[0]).toMatchObject({
      value: "hover_change_observed",
      decision: "accepted",
    });
    expect(
      (second.viewports[0]!.observations ?? []).filter(
        (observation) => observation.state !== "default",
      ),
    ).toHaveLength(1);
    expect((await publishCapture(second)).published).toBe(true);
  }, 120_000);

  it("returns published region ids that a follow-up state request accepts", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<style>
             #follow-target { display: inline-block; padding: 8px; }
             #follow-target:hover { background-color: rgb(20, 90, 220); color: rgb(255, 255, 255); }
           </style>
           <main><section id="s"><a id="follow-target" href="#follow-target">Follow target</a></section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const first = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect((await publishCapture(first)).published).toBe(true);
    const targetId = cache.withAtlasDb(
      (db) =>
        (
          db
            .prepare(
              "SELECT id FROM atlas_regions WHERE kind = 'component' AND locator_json LIKE '%#follow-target%'",
            )
            .get() as { id: string }
        ).id,
    );
    const second = await collectAtlasPage(
      {
        siteSlug: "chromium-fixture",
        viewports: ["desktop"],
        states: [{ action: "hover", targetRegionId: targetId }],
      },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    const published = await publishCapture(second);
    expect(published.published, published.code).toBe(true);
    const followUpId = published.publishedRegionIds?.[targetId];
    expect(followUpId).toBeTruthy();
    expect(followUpId).not.toBe(targetId);
    const third = await collectAtlasPage(
      {
        siteSlug: "chromium-fixture",
        viewports: ["desktop"],
        states: [{ action: "hover", targetRegionId: followUpId! }],
      },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(third.viewports[0]!.states).toEqual([
      expect.objectContaining({ targetRegionId: followUpId, status: "observed" }),
    ]);
    expect((await publishCapture(third)).published).toBe(true);
  }, 120_000);

  it("keeps a candidate section purpose candidate in the hover sample", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html>" +
          shell(
          `<style>
             body { margin: 0; }
             #hero { min-height: 60vh; background-color: rgb(240, 240, 240); }
             #hero:hover { background-color: rgb(20, 60, 200); }
           </style>
           <main>
             <section id="hero"><h1>Hero</h1><p>Hero copy</p></section>
             <section id="tail"><h2>Tail</h2><div style="height:900px"></div></section>
           </main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const first = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    const firstPublished = await publishCapture(first);
    expect(firstPublished.published, firstPublished.code).toBe(true);
    const heroId = cache.withAtlasDb(
      (db) =>
        (
          db
            .prepare(
              "SELECT id FROM atlas_regions WHERE kind = 'section' AND json_extract(locator_json, '$.selector') LIKE '%#hero'",
            )
            .get() as { id: string }
        ).id,
    );
    const defaultPurpose = first.viewports[0]!.claims.find(
      (claim) => claim.field === "section.purpose",
    )!;
    expect(defaultPurpose).toMatchObject({ value: "hero", decision: "candidate" });

    const second = await collectAtlasPage(
      {
        siteSlug: "chromium-fixture",
        viewports: ["desktop"],
        states: [{ action: "hover", targetRegionId: heroId }],
      },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(second.viewports[0]!.states).toEqual([
      expect.objectContaining({
        action: "hover",
        targetRegionId: heroId,
        status: "observed",
      }),
    ]);
    const hoverPurpose = second.viewports[0]!.claims.find(
      (claim) => claim.field === "section.purpose" && claim.state === "hover",
    )!;
    expect(hoverPurpose).toMatchObject({
      value: "hero",
      decision: "candidate",
      classification: "inferred",
    });
    const secondPublished = await publishCapture(second);
    expect(secondPublished.published, secondPublished.code).toBe(true);
    const publishedHeroId = secondPublished.publishedRegionIds?.[heroId] ?? heroId;

    const accepted = searchAtlas(
      {
        kind: "sections",
        state: "hover",
        scope: "region",
        evidenceMode: "accepted",
        predicates: [{ field: "section.purpose", values: ["hero"] }],
      },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!accepted.ok) throw new Error(accepted.error.code);
    expect(accepted.data.total).toBe(0);
    const candidates = searchAtlas(
      {
        kind: "sections",
        state: "hover",
        scope: "region",
        evidenceMode: "candidate",
        predicates: [{ field: "section.purpose", values: ["hero"] }],
      },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!candidates.ok) throw new Error(candidates.error.code);
    expect(candidates.data.results.map((hit) => hit.regionId)).toEqual([
      publishedHeroId,
    ]);
    expect(candidates.data.results[0]!.claims).toContainEqual(
      expect.objectContaining({ value: "hero", decision: "candidate" }),
    );
  }, 120_000);

  it("keeps an unresolved navigation trigger candidate in default and hover samples", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html>" +
          shell(
          `<style>
             body { margin: 0; }
             #missing-trigger { display: block; margin: 8px; padding: 8px;
               color: rgb(10, 10, 10); background-color: rgb(240, 240, 240); }
             #missing-trigger:hover { color: rgb(250, 250, 250); background-color: rgb(20, 60, 200); }
           </style>
           <main><section id="nav-section"><h1>Navigation</h1>
             <nav><button id="missing-trigger" aria-haspopup="true"
               aria-controls="missing-panel">Missing trigger</button></nav>
           </section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const first = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect((await publishCapture(first)).published).toBe(true);
    const triggerKey = first.viewports[0]!.components!.find((component) =>
      component.selector.includes("#missing-trigger"),
    )!.key;
    const typeClaim = first.viewports[0]!.claims.find(
      (claim) => claim.field === "component.type" && claim.regionKey === triggerKey,
    )!;
    expect(typeClaim).toMatchObject({
      value: "navigation_trigger",
      decision: "candidate",
      ruleId: "component.aria.navigation-trigger.unresolved",
    });
    const triggerId = cache.withAtlasDb(
      (db) =>
        (
          db
            .prepare(
              "SELECT id FROM atlas_regions WHERE kind = 'component' AND json_extract(locator_json, '$.selector') LIKE '%#missing-trigger'",
            )
            .get() as { id: string }
        ).id,
    );
    const second = await collectAtlasPage(
      {
        siteSlug: "chromium-fixture",
        viewports: ["desktop"],
        states: [{ action: "hover", targetRegionId: triggerId }],
      },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(second.viewports[0]!.states).toEqual([
      expect.objectContaining({
        action: "hover",
        targetRegionId: triggerId,
        status: "observed",
      }),
    ]);
    const hoverType = second.viewports[0]!.claims.find(
      (claim) =>
        claim.field === "component.type" &&
        claim.state === "hover" &&
        claim.regionKey === triggerKey,
    )!;
    expect(hoverType).toMatchObject({
      decision: "candidate",
      ruleId: "component.aria.navigation-trigger.unresolved",
    });
    expect((await publishCapture(second)).published).toBe(true);

    const labelByRegion = cache.withAtlasDb(
      (db) =>
        new Map(
          (
            db
              .prepare("SELECT id, heading FROM atlas_regions WHERE kind = 'component'")
              .all() as Array<{ id: string; heading: string }>
          ).map((row) => [row.id, row.heading]),
        ),
    );
    const accepted = searchAtlas(
      {
        kind: "components",
        state: "hover",
        evidenceMode: "accepted",
        groupBy: "instance",
        limit: 20,
      },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!accepted.ok) throw new Error(accepted.error.code);
    expect(accepted.data.outcome).toBe("insufficient_coverage");
    expect(accepted.data.total).toBe(0);
    const candidates = searchAtlas(
      {
        kind: "components",
        state: "hover",
        evidenceMode: "candidate",
        groupBy: "instance",
        limit: 20,
      },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!candidates.ok) throw new Error(candidates.error.code);
    expect(candidates.data.results.map((hit) => labelByRegion.get(hit.regionId))).toEqual([
      "Missing trigger",
    ]);
    expect(candidates.data.results[0]!.claims).toContainEqual(
      expect.objectContaining({ value: "navigation_trigger", decision: "candidate" }),
    );
  }, 120_000);

  it("keeps a resolved navigation trigger accepted in default and hover samples", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html>" +
          shell(
          `<style>
             body { margin: 0; }
             #resolved-trigger { display: block; margin: 8px; padding: 8px;
               color: rgb(10, 10, 10); background-color: rgb(240, 240, 240); }
             #resolved-trigger:hover { color: rgb(250, 250, 250); background-color: rgb(20, 140, 60); }
           </style>
           <main><section id="nav-section"><h1>Navigation</h1>
             <nav><button id="resolved-trigger" aria-haspopup="true"
               aria-controls="real-panel">Resolved trigger</button>
               <div id="real-panel">Menu</div></nav>
           </section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const first = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect((await publishCapture(first)).published).toBe(true);
    const triggerKey = first.viewports[0]!.components!.find((component) =>
      component.selector.includes("#resolved-trigger"),
    )!.key;
    expect(
      first.viewports[0]!.claims.find(
        (claim) =>
          claim.field === "component.type" && claim.regionKey === triggerKey,
      ),
    ).toMatchObject({
      value: "navigation_trigger",
      decision: "accepted",
      ruleId: "component.aria.navigation-trigger.resolved",
    });
    const triggerId = cache.withAtlasDb(
      (db) =>
        (
          db
            .prepare(
              "SELECT id FROM atlas_regions WHERE kind = 'component' AND json_extract(locator_json, '$.selector') LIKE '%#resolved-trigger'",
            )
            .get() as { id: string }
        ).id,
    );
    const second = await collectAtlasPage(
      {
        siteSlug: "chromium-fixture",
        viewports: ["desktop"],
        states: [{ action: "hover", targetRegionId: triggerId }],
      },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    const hoverType = second.viewports[0]!.claims.find(
      (claim) =>
        claim.field === "component.type" &&
        claim.state === "hover" &&
        claim.regionKey === triggerKey,
    )!;
    expect(hoverType).toMatchObject({
      decision: "accepted",
      ruleId: "component.aria.navigation-trigger.resolved",
    });
    expect((await publishCapture(second)).published).toBe(true);
    const labelByRegion = cache.withAtlasDb(
      (db) =>
        new Map(
          (
            db
              .prepare("SELECT id, heading FROM atlas_regions WHERE kind = 'component'")
              .all() as Array<{ id: string; heading: string }>
          ).map((row) => [row.id, row.heading]),
        ),
    );
    const hovered = searchAtlas(
      {
        kind: "components",
        state: "hover",
        evidenceMode: "accepted",
        groupBy: "instance",
        limit: 20,
      },
      atlasSearchStore(cache),
      Date.now(),
    );
    if (!hovered.ok) throw new Error(hovered.error.code);
    expect(hovered.data.results.map((hit) => labelByRegion.get(hit.regionId))).toEqual([
      "Resolved trigger",
    ]);
  }, 120_000);

  it("re-measures the hover baseline away from a top-left reset pointer", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html>" +
          shell(
          `<style>
             body { margin: 0; }
             #corner { position: absolute; left: 0; top: 0; z-index: 5;
               width: 240px; height: 120px; padding: 8px; box-sizing: border-box;
               background-color: rgb(240, 240, 240); color: rgb(10, 10, 10); }
             #corner:hover { background-color: rgb(20, 60, 200); color: rgb(250, 250, 250); }
           </style>
           <main>
             <header id="corner"><h1>Corner</h1></header>
             <section id="tail"><h2>Tail</h2><div style="height:800px"></div></section>
           </main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const first = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    const firstPublished = await publishCapture(first);
    expect(firstPublished.published, firstPublished.code).toBe(true);
    const cornerId = cache.withAtlasDb(
      (db) =>
        (
          db
            .prepare(
              "SELECT id FROM atlas_regions WHERE kind = 'section' AND json_extract(locator_json, '$.selector') LIKE '%#corner'",
            )
            .get() as { id: string }
        ).id,
    );
    const second = await collectAtlasPage(
      {
        siteSlug: "chromium-fixture",
        viewports: ["desktop"],
        states: [{ action: "hover", targetRegionId: cornerId }],
      },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(second.viewports[0]!.states).toEqual([
      expect.objectContaining({
        action: "hover",
        targetRegionId: cornerId,
        status: "observed",
      }),
    ]);
    expect(
      second.viewports[0]!.claims.find(
        (claim) => claim.field === "behavior" && claim.state === "hover",
      ),
    ).toMatchObject({ value: "hover_change_observed", decision: "accepted" });
    expect((await publishCapture(second)).published).toBe(true);
  }, 120_000);

  it("reports a full-viewport state target as inconclusive instead of no change", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        shell(
          `<style>
             html, body { margin: 0; height: 100%; }
             #full { position: absolute; inset: 0; z-index: 5;
               background-color: rgb(240, 240, 240); }
             #full:hover { background-color: rgb(20, 60, 200); }
           </style>
           <main><section id="full"><h1>Full viewport</h1></section></main>`,
        ),
      );
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    const first = await collectAtlasPage(
      { siteSlug: "chromium-fixture", viewports: ["desktop"] },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    const firstPublished = await publishCapture(first);
    expect(firstPublished.published, firstPublished.code).toBe(true);
    const fullId = cache.withAtlasDb(
      (db) =>
        (
          db
            .prepare(
              "SELECT id FROM atlas_regions WHERE kind = 'section' AND json_extract(locator_json, '$.selector') LIKE '%#full'",
            )
            .get() as { id: string }
        ).id,
    );
    const second = await collectAtlasPage(
      {
        siteSlug: "chromium-fixture",
        viewports: ["desktop"],
        states: [{ action: "hover", targetRegionId: fullId }],
      },
      { cache, allowPrivateOrigins: [origin], totalBudgetMs: 45_000 },
    );
    expect(second.viewports[0]!.states).toEqual([
      expect.objectContaining({
        action: "hover",
        targetRegionId: fullId,
        status: "inconclusive",
        code: "STATE_TARGET_FULL_VIEWPORT",
      }),
    ]);
    expect(second.viewports[0]!.limitations).toContain("STATE_TARGET_FULL_VIEWPORT");
    expect(
      second.viewports[0]!.claims.filter((claim) => claim.field === "behavior"),
    ).toEqual([]);
    expect((await publishCapture(second)).published).toBe(true);
  }, 120_000);

  it("blocks robots.txt HTTP 503 instead of launching a browser", async () => {
    const origin = await start((path, res) => {
      if (path === "/robots.txt") {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("unavailable");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(shell("<main><h1>Never</h1></main>"));
    });
    const cache = new Cache(tmpDir(), () => Date.now(), { atlas: true });
    cache.upsertSites([site(`${origin}/`)]);
    let launched = false;
    await expect(
      collectAtlasPage(
        { siteSlug: "chromium-fixture", viewports: ["desktop"] },
        {
          cache,
          allowPrivateOrigins: [origin],
          loader: async () => {
            launched = true;
            return { chromium: { launch: async () => ({}) } };
          },
        },
      ),
    ).rejects.toMatchObject({ code: "ROBOTS_UNAVAILABLE" });
    expect(launched).toBe(false);
  }, 30_000);
});
