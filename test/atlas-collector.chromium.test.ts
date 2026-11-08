import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Cache } from "../src/cache.js";
import { collectAtlasPage } from "../src/atlas/collector.js";
import { publishCapture } from "../src/atlas/publish.js";
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
    ).rejects.toMatchObject({ code: "ROBOTS_DENIED" });
    expect(launched).toBe(false);
  }, 30_000);
});
