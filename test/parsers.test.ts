import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseListing, decodeEntities } from "../src/parsers.js";

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
      '<a href="/collections/coll-1">c</a></div>',
      '<div data-collectable-model-value="{broken json"><span>garbage</span></div>',
      '<div data-collectable-model-value="{&quot;slug&quot;:&quot;no-href&quot;,&quot;title&quot;:&quot;No Href&quot;,&quot;type&quot;:&quot;submission&quot;}">',
      '<span>no sites link here</span></div>',
    ].join("");
    const baseline = parseListing(readFixture("listing.html"));
    const sites = parseListing(synthetic + readFixture("listing.html"));
    expect(sites.length).toBe(baseline.length);
    expect(sites.map((s) => s.slug)).toEqual(baseline.map((s) => s.slug));
    for (const s of sites) expect(s.detailPath).toMatch(/^\/sites\//);
  });
});
