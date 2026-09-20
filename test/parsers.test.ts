import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseListing,
  decodeEntities,
  parseDetail,
  parseCategories,
  parseElements,
  parseScore,
} from "../src/parsers.js";

const FIXTURES = join(__dirname, "fixtures");

// Repo uses core.autocrlf=true: committed blobs are LF but a future checkout
// may materialize CRLF. Normalize so parser behavior is checkout-independent.
function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8").replace(/\r\n/g, "\n");
}

const listing = () => readFixture("listing.html");

describe("decodeEntities", () => {
  it("unescapes the entities found in card JSON blobs", () => {
    expect(decodeEntities("&quot;a&quot; &amp; &quot;b&quot;")).toBe('"a" & "b"');
    expect(decodeEntities("L&#039;Oreal")).toBe("L'Oreal");
  });
});

describe("parseListing", () => {
  it("parses the ~31 site cards from the listing fixture", () => {
    const sites = parseListing(listing());
    expect(sites.length).toBeGreaterThanOrEqual(25);
  });

  it("extracts L.I.S.A. with live url, tags, thumbnail and award badge", () => {
    const lisa = parseListing(listing()).find((s) => s.slug === "l-i-s-a");
    expect(lisa).toBeDefined();
    expect(lisa!.title).toBe("L.I.S.A.");
    expect(lisa!.liveUrl).toBe("https://lisa.locomotive.ca/en");
    expect(lisa!.detailPath).toBe("/sites/l-i-s-a");
    expect(lisa!.tags).toContain("WebGL");
    expect(lisa!.thumbnailPath).toContain("submissions/2026/08/");
    expect(lisa!.awards).toContain("Developer Award");
    expect(lisa!.createdAt).toBeGreaterThan(0);
  });

  it("skips non-site collectables (no /sites/ href)", () => {
    const sites = parseListing(listing());
    for (const s of sites) expect(s.detailPath).toMatch(/^\/sites\//);
  });

  it("skips collection blobs, malformed JSON, and cards without a /sites/ href", () => {
    const synthetic = [
      '<div data-collectable-model-value="{&quot;slug&quot;:&quot;coll-1&quot;,&quot;title&quot;:&quot;Some Collection&quot;,&quot;type&quot;:&quot;collection&quot;}">',
      '<a href="/sites/decoy">d</a>',
      '<div data-collectable-model-value="{&quot;slug&quot;:&quot;no-href&quot;,&quot;title&quot;:&quot;No Href&quot;,&quot;type&quot;:&quot;submission&quot;}">',
      '<span>no sites link here</span></div>',
      '<div data-collectable-model-value="{broken json"><span>garbage</span></div>',
    ].join("");
    const baseline = parseListing(readFixture("listing.html"));
    const sites = parseListing(synthetic + readFixture("listing.html"));
    expect(sites.length).toBe(baseline.length);
    expect(sites.map((s) => s.slug)).toEqual(baseline.map((s) => s.slug));
    for (const s of sites) expect(s.detailPath).toMatch(/^\/sites\//);
  });
});

const detail = () => readFixture("detail.html");

describe("parseDetail", () => {
  const d = () => parseDetail(detail(), "l-i-s-a");

  it("extracts the color palette", () => {
    expect(d().palette.length).toBeGreaterThanOrEqual(1);
    expect(d().palette[0]).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("extracts technologies, elements and description", () => {
    expect(d().technologies.length).toBeGreaterThanOrEqual(3);
    expect(d().technologies).toContain("WebGL");
    expect(d().elements).toContain("3D model");
    expect(d().description).toContain("Locomotive Interactive Super Assistant");
  });

  it("extracts the award with date", () => {
    expect(d().awards.some((a) => a.title === "Site of the Day")).toBe(true);
    expect(d().awards[0].date).toMatch(/^[A-Z][a-z]+ \d{1,2}, \d{4}$/);
  });

  it("extracts og image and live url", () => {
    expect(d().ogImage).toContain("assets.awwwards.com");
    expect(d().liveUrl).toBe("https://lisa.locomotive.ca/en");
  });

  it("captures element names containing entities", () => {
    const html =
      '<h2 class="text-default">Elements</h2>' +
      '<div data-collectable-model-value="{&quot;collectableTitle&quot;:&quot;UI &amp; UX&quot;,&quot;id&quot;:1}"></div>' +
      '<h2 class="text-default">Color Palette</h2>';
    expect(parseDetail(html, "x").elements).toContain("UI & UX");
  });
});

describe("parseCategories", () => {
  it("extracts color hex codes and tag slugs from the listing fixture", () => {
    const cats = parseCategories(listing());
    expect(cats.colors.length).toBeGreaterThanOrEqual(20);
    expect(cats.colors).toContain("#404040");
    expect(cats.filters).toContain("3d");
    expect(cats.filters).toContain("webgl");
    expect(cats.filters.length).toBeGreaterThanOrEqual(100);
  });

  it("excludes award collections from the filter list", () => {
    const cats = parseCategories(listing());
    expect(cats.filters).not.toContain("sites_of_the_day");
  });
});

describe("parseElements", () => {
  it("parses the 6 element blobs from the detail fixture", () => {
    const els = parseElements(detail())!;
    expect(els.length).toBe(6);
    expect(els[0]).toEqual({
      title: "Virtual assistant",
      mediaPath: "element/2026/08/6a723caaa57bb151055998.mp4",
    });
    expect(els.map((e) => e.title)).toContain("3D model");
    expect(els.map((e) => e.title)).toContain("Microcopy");
    expect(els.filter((e) => e.mediaPath.endsWith(".mp4")).length).toBe(4);
    expect(els.filter((e) => e.mediaPath.endsWith(".jpg")).length).toBe(2);
  });

  it("returns null when the page has no Elements section", () => {
    expect(parseElements("<html><body>nothing here</body></html>")).toBeNull();
  });

  it("returns an empty array when the section exists but no blobs parse", () => {
    const html = "<h2>Elements</h2><p>broken markup</p><h2>Color Palette</h2>";
    expect(parseElements(html)).toEqual([]);
  });

  it("parses legacy external/ media paths (live-broken case: emergence-magazine)", () => {
    // 2018-era sites store element media under external/YYYY/MM/<hash>.mp4;
    // the parser historically accepted only element/ and returned 0 for them.
    const els = parseElements(readFixture("detail-emergence.html"))!;
    expect(els).not.toBeNull();
    expect(els.length).toBeGreaterThanOrEqual(1);
    for (const el of els) {
      expect(el.mediaPath).toMatch(/^(element|external)\//);
      expect(el.title.length).toBeGreaterThan(0);
    }
    expect(els.map((e) => e.title)).toContain("Amplifying Circles Hover Interaction");
    expect(els.map((e) => e.title)).toContain("Elegant Typography Combination on Scroll");
  });
});

// Second fixture captured fresh from live awwwards.com (2026-09-17, site
// "LxL Creative") so the parsers are proven against current markup, not just
// the August-era detail.html. Floor-based assertions where values may vary
// between captures; exact only where the contract demands it.
describe("parseDetail against fresh live markup (detail-lxl fixture)", () => {
  const lxl = () => parseDetail(readFixture("detail-lxl.html"), "lxl-creative");

  it("extracts a complete design-DNA parse from current live markup", () => {
    const d = lxl();
    expect(d.title).toContain("LxL Creative");
    expect(d.palette.length).toBeGreaterThanOrEqual(1);
    for (const hex of d.palette) expect(hex).toMatch(/^#[0-9A-F]{6}$/);
    expect(d.technologies.length).toBeGreaterThanOrEqual(3);
    expect(d.elements.length).toBeGreaterThanOrEqual(3);
    expect(d.awards.some((a) => a.title === "Site of the Day")).toBe(true);
    expect(d.awards[0].date).toMatch(/^[A-Z][a-z]+ \d{1,2}, \d{4}$/);
    expect(d.description).toContain("LxL Creative");
    expect(d.ogImage).toContain("assets.awwwards.com");
    expect(d.liveUrl).toBe("https://www.lxlcreative.co.uk/");
  });

  it("parseElements still works on the same fresh page", () => {
    const els = parseElements(readFixture("detail-lxl.html"));
    expect(els).not.toBeNull();
    expect(els!.length).toBeGreaterThanOrEqual(3);
    expect(els!.every((e) => e.mediaPath.startsWith("element/"))).toBe(true);
  });
});

// Jury dimensions: the layout-overall chartbar block on award pages. Live
// probe 2026-09-20 (SOTD winners aspen-search, hearst-exhibit-2026,
// emergence-magazine): scores are server-rendered — four weighted type labels
// (Design 40% / Usability 30% / Creativity 20% / Content 10%) followed by four
// js-chart-bar progressbars whose data-note attributes carry the per-dimension
// scores in the same order; the 40/30/20/10-weighted average reproduces the
// displayed total exactly on every probed page. No Development dimension
// exists anywhere in the HTML (0 occurrences across all probes).
describe("parseDetail jury dimensions (detail-jury fixture, live 2026-09-20)", () => {
  const d = () => parseDetail(readFixture("detail-jury.html"), "aspen-search");

  it("extracts the four per-dimension jury scores", () => {
    expect(d().juryDimensions).toEqual({
      design: 7.54,
      usability: 7.27,
      creativity: 7.7,
      content: 7.39,
    });
  });

  it("keeps the total score and the curated description on the same page", () => {
    expect(d().score).toBeCloseTo(7.48, 2);
    // The suffix past the og:description truncation point pins that the
    // curated h3 wins: og stops at "...venture-backed..." while the curated
    // section carries "...venture-backed technology companies.".
    expect(d().description).toContain("Boutique executive search");
    expect(d().description).toContain("venture-backed technology companies.");
  });

  it("returns undefined when the page has no jury chartbar block", () => {
    expect(parseDetail("<html><body>no votes</body></html>", "x").juryDimensions).toBeUndefined();
  });

  it("returns undefined when the dimension labels drift from the known four", () => {
    // A renamed/fifth dimension must yield undefined, not misaligned scores.
    const html =
      '<div class="layout-overall" data-controller="chartbar">' +
      '<div class="layout-overall__type">Design<strong>40%</strong></div>' +
      '<div class="layout-overall__chart">' +
      '<div class="layout-overall__progressbar js-chart-bar" data-note="8.00"></div>' +
      "</div></div>";
    expect(parseDetail(html, "x").juryDimensions).toBeUndefined();
  });

  it("returns undefined when a fourth label is renamed but counts still match", () => {
    // Four labels, four notes — the count guard passes — but the 4th label
    // is not one of the known four, so the exact-label-set guard must refuse
    // rather than misalign notes onto dimensions.
    const html =
      '<div class="layout-overall" data-controller="chartbar">' +
      '<div class="layout-overall__type">Design<strong>40%</strong></div>' +
      '<div class="layout-overall__type">Usability<strong>30%</strong></div>' +
      '<div class="layout-overall__type">Creativity<strong>20%</strong></div>' +
      '<div class="layout-overall__type">Development<strong>10%</strong></div>' +
      '<div class="layout-overall__chart "><div class="layout-overall__progressbar js-chart-bar" data-note="8.1"></div></div>' +
      '<div class="layout-overall__chart "><div class="layout-overall__progressbar js-chart-bar" data-note="7.2"></div></div>' +
      '<div class="layout-overall__chart "><div class="layout-overall__progressbar js-chart-bar" data-note="6.3"></div></div>' +
      '<div class="layout-overall__chart layout-overall__chart--last"><div class="layout-overall__progressbar js-chart-bar" data-note="5.4"></div></div>' +
      "</div>";
    expect(parseDetail(html, "x").juryDimensions).toBeUndefined();
  });

  it("extracts jury dimensions from all three probed live shapes", () => {
    // The same selectors must hold on the other two probed SOTD pages; their
    // layout-overall blocks are inlined from the live captures.
    const hearst =
      '<div class="layout-overall" data-controller="chartbar">' +
      '<div class="layout-overall__type">Design<strong>40%</strong></div>' +
      '<div class="layout-overall__type">Usability<strong>30%</strong></div>' +
      '<div class="layout-overall__type">Creativity<strong>20%</strong></div>' +
      '<div class="layout-overall__type">Content<strong>10%</strong></div>' +
      '<div class="layout-overall__chart "><div class="layout-overall__progressbar js-chart-bar" data-note="7.27"></div></div>' +
      '<div class="layout-overall__chart "><div class="layout-overall__progressbar js-chart-bar" data-note="6.9"></div></div>' +
      '<div class="layout-overall__chart "><div class="layout-overall__progressbar js-chart-bar" data-note="7.4"></div></div>' +
      '<div class="layout-overall__chart layout-overall__chart--last"><div class="layout-overall__progressbar js-chart-bar" data-note="7.5"></div></div>' +
      "</div>";
    expect(parseDetail(hearst, "x").juryDimensions).toEqual({
      design: 7.27,
      usability: 6.9,
      creativity: 7.4,
      content: 7.5,
    });
  });

  it("pins jury-vs-votes disambiguation on a full-page fixture", () => {
    // Full emergence-magazine capture: the page carries 10 data-note
    // attributes — the 4 jury dimensions plus 6 per-juror vote notes after
    // the tabs controller. The tabs bound in parseJuryDimensions must exclude
    // the votes; synthetic inlined blocks above cannot catch that leak.
    expect(
      parseDetail(readFixture("detail-emergence.html"), "emergence-magazine").juryDimensions,
    ).toEqual({
      design: 7.23,
      usability: 6.94,
      creativity: 6.86,
      content: 7.37,
    });
  });
});

// og:description fallback: the curated ">Description</h2>" section exists on
// only ~16% of pages (8/50 in the 2026-09-19 probe); og:description was on
// 50/50 with the same text as meta description. The curated block stays
// primary; og:description is the fallback when the section is missing or
// yields empty. Ported from the inline fallback in scripts/enrich-styles.mjs.
describe("parseDetail og:description fallback (detail-og-fallback fixture)", () => {
  it("falls back to og:description when the curated Description section is absent", () => {
    const d = parseDetail(readFixture("detail-og-fallback.html"), "aspen-search");
    expect(d.description).toContain("Boutique executive search specialists");
    expect(d.description).toContain("quantitative trading firms");
  });

  it("prefers the curated Description block over og:description", () => {
    const html =
      '<meta property="og:description" content="og fallback text">' +
      '<h2 class="text-default">Description</h2>' +
      '<h3 class="heading-6">curated section text</h3>';
    expect(parseDetail(html, "x").description).toBe("curated section text");
  });

  it("falls back to og:description when the Description section yields empty", () => {
    const html =
      '<meta property="og:description" content="og fallback text">' +
      '<h2 class="text-default">Description</h2><p>no h3 follows</p>';
    expect(parseDetail(html, "x").description).toBe("og fallback text");
  });

  it("returns null when neither the section nor og:description exists", () => {
    expect(parseDetail("<html><body>nothing</body></html>", "x").description).toBeNull();
  });

  it("HTML-entity-decodes the og:description text", () => {
    const html = '<meta property="og:description" content="L&#039;agent &amp; co">';
    expect(parseDetail(html, "x").description).toBe("L'agent & co");
  });
});

describe("parseScore", () => {
  it("extracts the displayed overall score from the score heading", () => {
    const d = readFixture("detail-lxl.html");
    expect(parseScore(d)).toBeCloseTo(7.37, 2);
  });
  it("returns null when no score heading exists", () => {
    expect(parseScore("<html><body>no score</body></html>")).toBeNull();
  });
});
