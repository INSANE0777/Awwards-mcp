import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseListing,
  decodeEntities,
  parseDetail,
  parseCategories,
  parseElements,
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
