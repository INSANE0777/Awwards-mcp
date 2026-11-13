import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildResponsiveReport,
  collapseBands,
  analyzePageStructure,
  coordinateY,
  MAX_PRESCROLL_STEPS,
  preScroll,
  PRE_SCROLL_DEADLINE_MS,
  selectorFromParts,
  splitCollapsedBands,
  diffBands,
  SCAN_SNIPPET,
} from "../src/structure.js";
import type { PageBand, PageStructure, RawResponsiveElement, RawResponsiveScan } from "../src/structure.js";
import type { RawBand } from "../src/structure.js";
import { VIEWPORT_PROFILES } from "../src/viewport.js";

const FIXTURES = join(__dirname, "fixtures");

const band = (over: Partial<RawBand> = {}): RawBand => ({
  tag: "section",
  label: "",
  bg: "rgb(16, 21, 42)",
  top: 0,
  height: 1000,
  textStart: "",
  ...over,
});

const pageBand = (label: string, height: number, offsetTop = 0, index = 0): PageBand => ({
  index,
  tag: "section",
  label,
  background: "rgb(0, 0, 0)",
  offsetTop,
  height,
  textStart: "",
});

const page = (bands: PageBand[], totalHeight: number): PageStructure => ({
  url: "https://example.com",
  title: "T",
  totalHeight,
  bands,
});

describe("buildResponsiveReport", () => {
  it("orders kinds, caps each at 10, keeps raw counts and marks truncation", () => {
    const raw = JSON.parse(
      readFileSync(join(FIXTURES, "responsive", "scan-overflow.json"), "utf8"),
    ) as RawResponsiveScan;
    const report = buildResponsiveReport(raw);
    expect(report.measuredAt).toBe("mobile");
    expect(report.viewport).toEqual({ width: 390, height: 844, dpr: 3 });
    expect(report.pageOverflow).toEqual({ horizontal: true, scrollWidth: 421, innerWidth: 390 });
    expect(report.issues.map((i) => i.kind)).toEqual([
      ...Array(10).fill("overflow"),
      "small-text",
      "small-tap-target",
    ]);
    expect(report.issues[0]!.selector).toBe("div.hero > img.banner");
    expect(report.issues[0]!.rect).toEqual({ x: 320, y: 10, w: 300, h: 120 });
    expect(report.issues[10]!.selector).toBe("main > p.lede");
    expect(report.issues[11]!.selector).toBe("button#cta");
    expect(report.counts).toEqual({ overflow: 12, smallText: 1, smallTapTarget: 1 });
    expect(report.truncated).toBe(true);
  });

  it("returns zero issues for a clean scan", () => {
    const raw = JSON.parse(
      readFileSync(join(FIXTURES, "responsive", "scan-clean.json"), "utf8"),
    ) as RawResponsiveScan;
    const report = buildResponsiveReport(raw);
    expect(report.issues).toEqual([]);
    expect(report.pageOverflow).toEqual({ horizontal: false, scrollWidth: 390, innerWidth: 390 });
    expect(report.counts).toEqual({ overflow: 0, smallText: 0, smallTapTarget: 0 });
    expect(report.truncated).toBe(false);
  });

  const rawElement = (parts: string[], y = 0): RawResponsiveElement => ({
    parts,
    x: 400,
    y,
    w: 50,
    h: 10,
    detail: "evidence",
  });

  const rawScan = (over: Partial<RawResponsiveScan> = {}): RawResponsiveScan => ({
    innerWidth: 390,
    scrollWidth: 390,
    counts: { overflow: 0, smallText: 0, smallTapTarget: 0 },
    overflow: [],
    smallText: [],
    smallTapTarget: [],
    ...over,
  });

  it("defensively caps an over-long raw overflow array at 10", () => {
    const raw = rawScan({
      scrollWidth: 421,
      counts: { overflow: 12, smallText: 0, smallTapTarget: 0 },
      overflow: Array.from({ length: 12 }, (_, i) => rawElement([`div.o${i}`], i * 10)),
    });
    const report = buildResponsiveReport(raw);
    expect(report.issues).toHaveLength(10);
    expect(report.counts.overflow).toBe(12);
    expect(report.truncated).toBe(true);
  });

  it("caps smallText at 10 while reporting the pre-cap count (11 → truncated)", () => {
    const raw = rawScan({
      counts: { overflow: 0, smallText: 11, smallTapTarget: 0 },
      smallText: Array.from({ length: 11 }, (_, i) => rawElement([`p.t${i}`], i * 10)),
    });
    const report = buildResponsiveReport(raw);
    expect(report.issues.filter((i) => i.kind === "small-text")).toHaveLength(10);
    expect(report.counts.smallText).toBe(11);
    expect(report.truncated).toBe(true);
  });

  it("caps smallTapTarget at 10 while reporting the pre-cap count (11 → truncated)", () => {
    const raw = rawScan({
      counts: { overflow: 0, smallText: 0, smallTapTarget: 11 },
      smallTapTarget: Array.from({ length: 11 }, (_, i) => rawElement([`button.b${i}`], i * 10)),
    });
    const report = buildResponsiveReport(raw);
    expect(report.issues.filter((i) => i.kind === "small-tap-target")).toHaveLength(10);
    expect(report.counts.smallTapTarget).toBe(11);
    expect(report.truncated).toBe(true);
  });

  it("keeps 10 of each kind without truncation when the caps are not hit", () => {
    const raw = rawScan({
      counts: { overflow: 0, smallText: 10, smallTapTarget: 10 },
      smallText: Array.from({ length: 10 }, (_, i) => rawElement([`p.t${i}`], i * 10)),
      smallTapTarget: Array.from({ length: 10 }, (_, i) => rawElement([`button.b${i}`], i * 10)),
    });
    const report = buildResponsiveReport(raw);
    expect(report.issues).toHaveLength(20);
    expect(report.truncated).toBe(false);
  });

  it("derives viewport from the profile used (default is the mobile profile)", () => {
    const raw = rawScan();
    const fallback = buildResponsiveReport(raw);
    expect(fallback.viewport).toEqual({
      width: VIEWPORT_PROFILES.mobile.width,
      height: VIEWPORT_PROFILES.mobile.height,
      dpr: VIEWPORT_PROFILES.mobile.deviceScaleFactor,
    });
    const custom = buildResponsiveReport(raw, {
      width: 412,
      height: 915,
      deviceScaleFactor: 2.625,
      isMobile: true,
    });
    expect(custom.viewport).toEqual({ width: 412, height: 915, dpr: 2.625 });
  });
});

describe("selectorFromParts", () => {
  it("reverses innermost-first parts and joins with >", () => {
    expect(selectorFromParts(["img.banner", "div.hero"])).toBe("div.hero > img.banner");
    expect(selectorFromParts([])).toBe("");
  });

  it("caps the selector at 160 characters", () => {
    expect(selectorFromParts(["x".repeat(200)])).toHaveLength(160);
  });
});

describe("diffBands", () => {
  it("returns zero deltas for identical band maps", () => {
    const bands = [pageBand(".a", 500), pageBand(".b", 500, 500, 1)];
    expect(diffBands(page(bands, 1000), page(bands, 1000))).toEqual({
      heightDelta: 0,
      bandsAdded: [],
      bandsRemoved: [],
      reordered: [],
    });
  });

  it("reports mobile-only added bands, desktop-only removed bands and height delta", () => {
    const desktop = page([pageBand(".a", 500), pageBand(".b", 500, 500, 1), pageBand(".c", 400, 1000, 2)], 1400);
    const mobile = page([pageBand(".a", 600), pageBand(".c", 300, 600, 1), pageBand(".d", 200, 900, 2)], 1100);
    expect(diffBands(desktop, mobile)).toEqual({
      heightDelta: -300,
      bandsAdded: [".d"],
      bandsRemoved: [".b"],
      reordered: [],
    });
  });

  it("flags common labels whose relative order changed", () => {
    const desktop = page([pageBand(".a", 300), pageBand(".b", 300, 300, 1), pageBand(".c", 300, 600, 2)], 900);
    const mobile = page([pageBand(".c", 300), pageBand(".a", 300, 300, 1), pageBand(".b", 300, 600, 2)], 900);
    expect(diffBands(desktop, mobile)).toMatchObject({
      heightDelta: 0,
      bandsAdded: [],
      bandsRemoved: [],
      reordered: [".a", ".b", ".c"],
    });
  });

  it("caps added, removed and reordered lists at 60", () => {
    const many = Array.from({ length: 65 }, (_, i) => pageBand(`.b${i}`, 10, i * 10, i));
    const baseOne = page([pageBand(".only", 10)], 10);
    const all = page([pageBand(".only", 10), ...many], 660);
    expect(diffBands(baseOne, all).bandsAdded).toHaveLength(60);
    expect(diffBands(all, baseOne).bandsRemoved).toHaveLength(60);
    expect(diffBands(page(many, 650), page([...many].reverse(), 650)).reordered).toHaveLength(60);
  });

  it("does not match distinct labels sharing a >24-char prefix (full labels returned)", () => {
    const prefix = "a".repeat(30);
    const base = page([pageBand(`${prefix}-hero`, 500)], 500);
    const other = page([pageBand(`${prefix}-footer`, 500)], 500);
    expect(diffBands(base, other)).toEqual({
      heightDelta: 0,
      bandsAdded: [`${prefix}-footer`],
      bandsRemoved: [`${prefix}-hero`],
      reordered: [],
    });
  });

  it("matches labels case-insensitively and names unlabeled bands", () => {
    const desktop = page([pageBand("Hero", 500), pageBand("", 500, 500, 1)], 1000);
    const mobile = page([pageBand("hero", 400), pageBand(".extra", 600, 400, 1)], 1000);
    expect(diffBands(desktop, mobile)).toEqual({
      heightDelta: 0,
      bandsAdded: [".extra"],
      bandsRemoved: ["(unlabeled)"],
      reordered: [],
    });
  });
});

describe("collapseBands", () => {
  it("resolves each y to the smallest covering candidate (most specific wins)", () => {
    const bands = collapseBands(
      [
        band({ label: "body", bg: "rgb(16, 21, 42)", top: 0, height: 2000 }),
        band({ label: ".shell", bg: "rgb(240, 242, 247)", top: 400, height: 1200 }),
      ],
      2000,
    );
    // body band 0-400, shell band 400-1600, body again 1600-2000
    expect(bands.map((b) => b.label)).toEqual(["body", ".shell", "body"]);
    expect(bands.map((b) => b.height)).toEqual([400, 1200, 400]);
  });

  it("merges consecutive runs with the same background", () => {
    const bands = collapseBands(
      [
        band({ label: "a", bg: "rgb(1, 1, 1)", top: 0, height: 300 }),
        band({ label: "b", bg: "rgb(1, 1, 1)", top: 300, height: 300 }),
      ],
      600,
    );
    expect(bands.length).toBe(1);
    expect(bands[0].height).toBe(600);
    expect(bands[0].label).toBe("a"); // first label wins on merge
  });

  it("absorbs tiny bands (<40px) into the previous band", () => {
    const bands = collapseBands(
      [
        band({ label: "big", bg: "rgb(1, 1, 1)", top: 0, height: 500 }),
        band({ label: "sliver", bg: "rgb(2, 2, 2)", top: 500, height: 30 }),
        band({ label: "tail", bg: "rgb(1, 1, 1)", top: 530, height: 470 }),
      ],
      1000,
    );
    expect(bands.map((b) => b.label)).toEqual(["big", "tail"]);
  });

  it("caps band count by merging the smallest band into its previous neighbor", () => {
    const many: RawBand[] = Array.from({ length: 12 }, (_, i) =>
      band({ label: `b${i}`, bg: `rgb(${i}, ${i}, ${i})`, top: i * 100, height: 100 }),
    );
    const bands = collapseBands(many, 1200, 5);
    expect(bands.length).toBeLessThanOrEqual(5);
    expect(bands[bands.length - 1].offsetTop + bands[bands.length - 1].height).toBe(1200);
  });

  it("rounds coordinates and assigns sequential indexes", () => {
    const bands = collapseBands(
      [band({ top: 0.4, height: 999.6, label: "x" })],
      1000,
    );
    expect(bands[0].index).toBe(0);
    expect(bands[0].offsetTop).toBe(0);
    expect(bands[0].height).toBe(1000);
  });
});

describe("splitCollapsedBands", () => {
  const pageBand = (over: Partial<PageBand> = {}): PageBand => ({
    index: 0,
    tag: "section",
    label: ".hero",
    background: "rgb(1, 1, 1)",
    offsetTop: 0,
    height: 6000,
    textStart: "Hero copy",
    ...over,
  });

  it("subdivides a giant band at landmark tops (ordered subs, heights sum to the parent)", () => {
    const subs = splitCollapsedBands([pageBand()], [1000, 3000]);
    expect(subs.map((b) => b.offsetTop)).toEqual([0, 1000, 3000]);
    expect(subs.map((b) => b.height)).toEqual([1000, 2000, 3000]);
    expect(subs.reduce((n, b) => n + b.height, 0)).toBe(6000);
    expect(subs.map((b) => b.index)).toEqual([0, 1, 2]);
    // Sub 0 keeps the parent identity; later subs take empty label/text.
    expect(subs.map((b) => b.label)).toEqual([".hero", "", ""]);
    expect(subs.map((b) => b.tag)).toEqual(["section", "section", "section"]);
    expect(subs.map((b) => b.background)).toEqual(["rgb(1, 1, 1)", "rgb(1, 1, 1)", "rgb(1, 1, 1)"]);
    expect(subs.map((b) => b.textStart)).toEqual(["Hero copy", "", ""]);
  });

  it("merges a <200px delta into the previous sub-band", () => {
    const subs = splitCollapsedBands([pageBand({ height: 3000 })], [400, 550]);
    // deltas 400 / 150 / 2450 — the 150px delta merges into sub 0.
    expect(subs.map((b) => b.offsetTop)).toEqual([0, 550]);
    expect(subs.map((b) => b.height)).toEqual([550, 2450]);
    expect(subs.reduce((n, b) => n + b.height, 0)).toBe(3000);
  });

  it("skips landmarks within 200px of an edge", () => {
    const subs = splitCollapsedBands([pageBand({ height: 3000 })], [100, 500, 2900]);
    // 100 and 2900 are <200px from an edge; only 500 is a valid cut.
    expect(subs.map((b) => b.offsetTop)).toEqual([0, 500]);
    expect(subs.map((b) => b.height)).toEqual([500, 2500]);
    // A giant whose landmarks ALL sit near the edges cannot split at all.
    expect(splitCollapsedBands([pageBand({ height: 3000 })], [100, 2900])).toEqual([
      pageBand({ height: 3000 }),
    ]);
  });

  it("passes bands through unchanged with no landmarks (byte-identical reference)", () => {
    const bands = [pageBand(), pageBand({ offsetTop: 6000, height: 500 })];
    expect(splitCollapsedBands(bands, [])).toBe(bands);
  });

  it("leaves non-giant bands and giants without 2 in-range landmarks alone", () => {
    const bands = [
      pageBand({ height: 2999 }),
      pageBand({ offsetTop: 2999, height: 2000 }),
    ];
    const res = splitCollapsedBands(bands, [1000, 1500, 3300, 3600]);
    expect(res).toHaveLength(2);
    // Small band: 2 in-range landmarks but height < 3000 → no split.
    expect(res[0].height).toBe(2999);
    // Giant band: 2 valid in-range landmarks, but 2000px height fails the ≥3000px gate → no split.
    expect(res[1]).toEqual({ ...bands[1], index: 1 });
    expect(res.map((b) => b.offsetTop + b.height)).toEqual([2999, 4999]);
  });

  it("skips the split entirely when the resulting count would exceed maxBands", () => {
    const giant = pageBand();
    // 3 valid cuts in 0-6000 → 4 sub-bands.
    expect(splitCollapsedBands([giant], [300, 600, 900], 3)).toHaveLength(1);
    expect(splitCollapsedBands([giant], [300, 600, 900], 3)).toEqual([giant]);
    expect(splitCollapsedBands([giant], [300, 600, 900], 4)).toHaveLength(4);
  });

  it("absorbs duplicate and unsorted landmark input deterministically", () => {
    const sorted = splitCollapsedBands([pageBand({ height: 3000 })], [500, 1500]);
    const messy = splitCollapsedBands([pageBand({ height: 3000 })], [1500, 500, 1500, 500]);
    expect(messy).toEqual(sorted);
    expect(sorted.map((b) => b.offsetTop)).toEqual([0, 500, 1500]);
  });

  // D2 residual gate: a giant with exactly ONE valid landmark now splits ONCE
  // into two parts (previously needed ≥2 in-range marks and stayed whole).
  it("splits a giant with a single landmark once into two bands (residual gate, was ≥2)", () => {
    const subs = splitCollapsedBands([pageBand()], [2000]);
    expect(subs.map((b) => b.offsetTop)).toEqual([0, 2000]);
    expect(subs.map((b) => b.height)).toEqual([2000, 4000]); // remainder absorbed by the tail
    expect(subs.reduce((n, b) => n + b.height, 0)).toBe(6000);
    // Sub 0 keeps the parent identity; the tail sub is anonymous.
    expect(subs.map((b) => b.label)).toEqual([".hero", ""]);
    expect(subs.map((b) => b.tag)).toEqual(["section", "section"]);
    expect(subs.map((b) => b.index)).toEqual([0, 1]);
  });

  it("single landmark inside the 200px edge clamp still cannot split", () => {
    expect(splitCollapsedBands([pageBand({ height: 3000 })], [150])).toHaveLength(1);
    expect(splitCollapsedBands([pageBand({ height: 3000 })], [2900])).toHaveLength(1);
  });
});

// D2 grab-bag: the scan snippet's landmark collection now also records
// <section>/<article>/[role=main] rect tops. No fake-document executor in
// this suite, so the contract is source-locked (house pattern).
it("SCAN_SNIPPET collects section/article/[role=main] landmark tops, bounded at 12 (source-lock)", () => {
  const src = String(SCAN_SNIPPET);
  expect(src).toContain(`querySelectorAll("section, article, [role=main]")`);
  expect(src).toContain("< 12"); // the new contributor's cap
  expect(src).toContain("querySelectorAll"); // runs inside the landmark try-block
});

// Review pins: the responsive predicates have no DOM executor offline, so each
// exclusion/guard is source-locked — deleting one fails a named assertion.
describe("SCAN_SNIPPET responsive predicates (source-lock)", () => {
  const src = String(SCAN_SNIPPET);

  it("measures overflow against documentElement.clientWidth, not window.innerWidth", () => {
    expect(src).toContain("doc.documentElement.clientWidth || g.innerWidth");
    expect(src).toContain("right > viewportWidth + 1");
    expect(src).toContain("innerWidth: viewportWidth");
  });

  it("§7: an inline prose link is not a tap target", () => {
    expect(src).toContain('g.getComputedStyle(el).display === "inline"');
    expect(src).toContain('String(el.tagName || "").toLowerCase() === "a"');
    expect(src).toContain('doc.querySelectorAll("a[href], button, input, select, textarea, [role=button]")');
  });

  it("§7: a marquee inside an overflow-x scroller is excluded from offences", () => {
    expect(src).toContain('s.overflowX === "auto" || s.overflowX === "scroll"');
    expect(src).toContain('s.overflowX === "hidden" && !isRoot');
    expect(src).toContain('String(s.transform || "none") !== "none" && !isRoot');
    expect(src).toContain("!insideScroller(el)");
    expect(src).toContain("depth < 100");
  });

  // A hidden clip or transform on body/html applies to the whole page, so it
  // must not excuse offenders: otherwise `overflow-x:hidden` on the root
  // reports pageOverflow with an empty offender list. No DOM executor here,
  // so the root exception is source-locked per the house pattern.
  it("a root overflow-x:hidden or transform still reports overflow offenders", () => {
    expect(src).toContain("const isRoot = cur === doc.body || cur === doc.documentElement;");
    expect(src).toContain('s.overflowX === "hidden" && !isRoot');
    expect(src).toContain('String(s.transform || "none") !== "none" && !isRoot');
    expect(src).toContain("right > viewportWidth + 1 && !insideScroller(el)");
  });

  it("counts small text only when the element owns a direct text node below 12px", () => {
    expect(src).toContain("if (!hasDirectText(el)) continue;");
    expect(src).toContain("if (!(size < 12)) continue;");
  });

  it("only measures widths > 0 and keeps the widest overflow offenders first", () => {
    expect(src).toContain("if (r.width > 0) {");
    expect(src).toContain("return b.over - a.over;");
  });

  it("keeps the 24px tap floor and a per-kind cap of 10", () => {
    expect(src).toContain("if (r.width >= 24 && r.height >= 24) continue;");
    expect(src).toContain("overflow.length < 10");
    expect(src).toContain("smallText.length < 10");
    expect(src).toContain("smallTapTarget.length < 10");
  });

  it("guards the scan on args.responsive === true and uses document scroll offsets", () => {
    expect(src).toContain("args.responsive === true");
    expect(src).toContain("r.left + g.scrollX");
    expect(src).toContain("r.top + g.scrollY");
  });

  it("rejects opacity:0 and clipped sr-only boxes as invisible", () => {
    expect(src).toContain('parseFloat(String(s.opacity || "1")) === 0');
    expect(src).toContain('clip === "rect(0px, 0px, 0px, 0px)"');
    expect(src).toContain('clipPath === "inset(50%)"');
  });

  it("mirrors a11y.ts selector parts: classList[0] only, 4 parts, id stops", () => {
    expect(src).toContain("while (cur && cur.nodeType === 1 && depth < 4)");
    expect(src).toContain("String(cur.classList[0])");
    expect(src).toContain('parts.push(tag + "#" + String(cur.id))');
    expect(src).not.toContain("classes[i]"); // no fallback to later classes
  });

  // §7 acceptance: run the in-page snippet against a minimal DOM. The inline
  // prose link must be excluded at scan time, leaving exactly 3 issues.
  it("§7 acceptance: one overflow, one 10px text, one 16px button and an inline link report 3 issues", () => {
    type FakeEl = {
      tagName: string;
      id: string;
      classList: string[];
      children: FakeEl[];
      childNodes: Array<{ nodeType: number; textContent: string }>;
      parentElement: FakeEl | null;
      nodeType: number;
      textContent: string;
      rect: { left: number; top: number; width: number; height: number };
      style: Record<string, string>;
      getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
    };
    const el = (
      tagName: string,
      rect: FakeEl["rect"],
      style: Record<string, string> = {},
      text = "",
      className = "",
    ): FakeEl => {
      const node: FakeEl = {
        tagName,
        id: "",
        classList: className ? [className] : [],
        children: [],
        childNodes: text ? [{ nodeType: 3, textContent: text }] : [],
        parentElement: null,
        nodeType: 1,
        textContent: text,
        rect,
        style,
        getBoundingClientRect: () => node.rect,
      };
      return node;
    };
    const html = el("html", { left: 0, top: 0, width: 390, height: 800 });
    const body = el("body", { left: 0, top: 0, width: 390, height: 800 }, {}, "", "page");
    const overflow = el("div", { left: 320, top: 10, width: 300, height: 100 }, {}, "wide", "overflow");
    const smallText = el("p", { left: 16, top: 240, width: 320, height: 14 }, { fontSize: "10px" }, "small text", "lede");
    const button = el("button", { left: 16, top: 360, width: 16, height: 16 }, {}, "Go", "cta");
    const inlineLink = el("a", { left: 40, top: 400, width: 80, height: 16 }, { display: "inline" }, "prose link", "link");
    html.children = [body];
    body.children = [overflow, smallText, button, inlineLink];
    for (const child of body.children) child.parentElement = body;
    body.parentElement = html;
    const documentElement = Object.assign(html, { scrollHeight: 800, clientWidth: 390, scrollWidth: 421 });
    const fakeDoc = {
      title: "Acceptance",
      documentElement,
      body,
      querySelectorAll: (selector: string): FakeEl[] => {
        if (selector === "*") return [html, body, overflow, smallText, button, inlineLink];
        if (selector.includes("a[href]")) return [button, inlineLink];
        return [];
      },
    };
    const g = globalThis as any;
    const saved = {
      document: g.document,
      getComputedStyle: g.getComputedStyle,
      scrollX: g.scrollX,
      scrollY: g.scrollY,
    };
    g.document = fakeDoc;
    g.scrollX = 0;
    g.scrollY = 0;
    g.getComputedStyle = (node: FakeEl) => ({
      display: node.style.display ?? "block",
      visibility: "visible",
      opacity: "1",
      clip: "",
      clipPath: "",
      overflowX: "visible",
      transform: "none",
      fontSize: node.style.fontSize ?? "16px",
      backgroundColor: "rgb(255, 255, 255)",
    });
    try {
      const raw = SCAN_SNIPPET({ responsive: true }).responsive!;
      expect(raw.counts).toEqual({ overflow: 1, smallText: 1, smallTapTarget: 1 });
      expect(raw.overflow).toHaveLength(1);
      expect(raw.smallText[0]!.detail).toContain("10px");
      expect(raw.smallTapTarget).toHaveLength(1);
      expect(raw.smallTapTarget[0]!.parts[0]).toBe("button.cta");
      const report = buildResponsiveReport(raw);
      expect(report.issues.map((i) => i.kind)).toEqual([
        "overflow",
        "small-text",
        "small-tap-target",
      ]);
      expect(report.issues).toHaveLength(3);
      expect(report.truncated).toBe(false);
    } finally {
      g.document = saved.document;
      g.getComputedStyle = saved.getComputedStyle;
      g.scrollX = saved.scrollX;
      g.scrollY = saved.scrollY;
    }
  });
});

// Inner scroll containers (body{position:fixed} + div.page{overflow-y:auto}):
// the scan must report scroller coordinates so bands match the real content
// height instead of one viewport-tall band.
describe("inner scroll root", () => {
  it("coordinateY maps document-root and element-scroller rect tops", () => {
    expect(coordinateY(100, 500)).toBe(600);
    expect(coordinateY(100, 500, null)).toBe(600);
    // Scroller top 20, scrolled 3000: element at viewport 120 sits at content 3100.
    expect(coordinateY(120, 999, { top: 20, scrollTop: 3000 })).toBe(3100);
    // Window scroll cancels out of the scroller form (both rects move together).
    expect(coordinateY(120 + 250, 250, { top: 20 + 250, scrollTop: 3000 })).toBe(3100);
  });

  it("collapses a scroller scan in scroller coordinates", () => {
    const raw = {
      title: "Scroller",
      totalHeight: 4992,
      scrollRoot: "div#page.page",
      candidates: [
        { tag: "body", label: "body", bg: "rgb(0, 0, 0)", top: 0, height: 4992, textStart: "" },
        { tag: "section", label: ".hero", bg: "rgb(255, 255, 255)", top: 0, height: 2496, textStart: "Hero" },
        { tag: "section", label: ".outro", bg: "rgb(0, 0, 255)", top: 2496, height: 2496, textStart: "Outro" },
      ],
    };
    const bands = collapseBands(raw.candidates, raw.totalHeight);
    expect(bands.map((b) => [b.offsetTop, b.height, b.label])).toEqual([
      [0, 2496, ".hero"],
      [2496, 2496, ".outro"],
    ]);
    expect(splitCollapsedBands(bands, [1500]).map((b) => b.offsetTop)).toEqual([0, 2496]);
  });

  it("escapes special-character ids/classes in scrollRoot so re-query stays valid", () => {
    const label = String.raw`div#page\:main\/x\.y.scroll\.inner`;
    const scroller = {
      tagName: "DIV",
      id: "page:main/x.y",
      classList: ["scroll.inner"],
      scrollHeight: 4000,
      clientHeight: 900,
      scrollTop: 0,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1440, height: 900 }),
    };
    const body = {
      tagName: "BODY",
      id: "",
      classList: [] as string[],
      children: [] as any[],
      textContent: "",
      getBoundingClientRect: () => ({ width: 1440, height: 900 }),
    };
    const fakeDoc = {
      title: "Special",
      documentElement: { scrollHeight: 900, clientHeight: 900 },
      body,
      querySelectorAll: (selector: string) => {
        if (selector === "*") return [body, scroller];
        // capture re-queries the exact label the scan returned.
        if (selector === label) return [scroller];
        return [];
      },
    };
    const g = globalThis as any;
    const saved = {
      document: g.document,
      CSS: g.CSS,
      getComputedStyle: g.getComputedStyle,
      scrollX: g.scrollX,
      scrollY: g.scrollY,
    };
    g.document = fakeDoc;
    g.scrollX = 0;
    g.scrollY = 0;
    g.getComputedStyle = () => ({
      overflowY: "auto",
      display: "block",
      visibility: "visible",
      backgroundColor: "rgb(255, 255, 255)",
    });
    try {
      g.CSS = { escape: (s: string) => String(s).replace(/[^A-Za-z0-9_-]/g, "\\$&") };
      expect(SCAN_SNIPPET({}).scrollRoot).toBe(label);
      expect(fakeDoc.querySelectorAll(label)).toHaveLength(1);
      // Old engine / fake page without CSS.escape: the fallback escapes the same
      // punctuation, so the label stays a valid one-element selector.
      g.CSS = undefined;
      expect(SCAN_SNIPPET({}).scrollRoot).toBe(label);
      expect(fakeDoc.querySelectorAll(label)).toHaveLength(1);
    } finally {
      g.document = saved.document;
      g.CSS = saved.CSS;
      g.getComputedStyle = saved.getComputedStyle;
      g.scrollX = saved.scrollX;
      g.scrollY = saved.scrollY;
    }
  });

  it("passes the scanned scrollRoot through to PageStructure", async () => {
    const fake = {
      launch: async () => ({
        newPage: async () => ({
          goto: async () => {},
          waitForTimeout: async () => {},
          evaluate: async () => ({
            title: "Pinned Body",
            totalHeight: 4000,
            scrollRoot: "div#page.page",
            candidates: [band({ label: "body", top: 0, height: 4000 })],
          }),
        }),
        close: async () => {},
      }),
    };
    const res = await analyzePageStructure("https://example.com", async () => ({ chromium: fake }));
    expect("error" in res).toBe(false);
    if (!("error" in res)) expect(res.scrollRoot).toBe("div#page.page");
  });

  it("omits scrollRoot for document-root scans", async () => {
    const fake = {
      launch: async () => ({
        newPage: async () => ({
          goto: async () => {},
          waitForTimeout: async () => {},
          evaluate: async () => ({
            title: "Normal",
            totalHeight: 800,
            candidates: [band({ label: "body", top: 0, height: 800 })],
          }),
        }),
        close: async () => {},
      }),
    };
    const res = await analyzePageStructure("https://example.com", async () => ({ chromium: fake }));
    expect("error" in res).toBe(false);
    if (!("error" in res)) expect("scrollRoot" in res).toBe(false);
  });

  it("SCAN_SNIPPET detection and preScroll mirror each other (source-lock)", () => {
    const scan = String(SCAN_SNIPPET);
    const scroll = String(preScroll);
    for (const src of [scan, scroll]) {
      expect(src).toContain("el === doc.body || el === doc.documentElement");
      expect(src).toContain("el.scrollHeight > el.clientHeight + 100");
      expect(src).toContain('String(s.overflowY) !== "auto" && String(s.overflowY) !== "scroll"');
      expect(src).toContain("css.escape"); // id/class escaped for a valid selector
    }
    expect(scan).toContain("Math.max(Number(de.scrollHeight || 0), bodyHeight) > viewportHeight + 100"); // document scroll wins
    expect(scan).toContain("r.top - scrollerTop + scrollerScrollTop");
    expect(scan).toContain("out.scrollRoot = scrollRootLabel(scroller)");
    expect(scroll).toContain("Math.max(Number(de.scrollHeight || 0), bodyHeight) > viewportHeight + 100");
    expect(scroll).toContain('behavior: "instant"');
    expect(scroll).toContain("scroller.scrollTop = y");
    expect(scroll).toContain("scroller.scrollTop = 0");
  });
});

// The pre-scroll walk must terminate even when a page grows its scrollHeight
// on every scroll: 80 × 450px steps / 8s hard cap, then back to the top.
describe("preScroll caps", () => {
  const withFakes = async (doc: any, win: any, run: () => Promise<unknown>) => {
    const g = globalThis as any;
    const saved = {
      document: g.document,
      window: g.window,
      setTimeout: g.setTimeout,
      getComputedStyle: g.getComputedStyle,
    };
    g.document = doc;
    g.window = win;
    g.getComputedStyle = () => ({ overflowY: "auto", display: "block", visibility: "visible" });
    g.setTimeout = (cb: any) => saved.setTimeout(cb, 0); // no real 40ms settle in tests
    try {
      return await run();
    } finally {
      g.document = saved.document;
      g.window = saved.window;
      g.setTimeout = saved.setTimeout;
      g.getComputedStyle = saved.getComputedStyle;
    }
  };

  it("caps the window walk when scrollHeight keeps growing, then resets", async () => {
    const scrolled: number[] = [];
    let height = 1000;
    const doc = {
      documentElement: {
        get scrollHeight() {
          return height;
        },
        clientHeight: 900,
      },
      body: {},
      querySelectorAll: () => [],
    };
    const win = {
      scrollTo: (...args: any[]) => {
        const position = args[0];
        const y = typeof position === "object" ? Number(position.top) : Number(args[1]);
        scrolled.push(y);
        height += 4500; // would never terminate without the cap
      },
    };
    await withFakes(doc, win, () =>
      preScroll({ evaluate: async (fn: any) => fn() }),
    );
    expect(scrolled).toHaveLength(MAX_PRESCROLL_STEPS + 1);
    expect(scrolled[MAX_PRESCROLL_STEPS]).toBe(0); // reset
    expect(Math.max(...scrolled)).toBe(450 * (MAX_PRESCROLL_STEPS - 1));
  });

  it("caps the inner-scroller walk and resets scrollTop", async () => {
    const tops: number[] = [];
    let height = 2000;
    let top = 0;
    const el = {
      tagName: "DIV",
      id: "page",
      classList: [],
      clientHeight: 900,
      get scrollHeight() {
        return height;
      },
      get scrollTop() {
        return top;
      },
      set scrollTop(v: number) {
        top = v;
        tops.push(v);
        height += 4500;
      },
      getBoundingClientRect: () => ({ width: 1440, height: 900 }),
    };
    const doc = {
      documentElement: { scrollHeight: 900, clientHeight: 900 },
      body: {},
      querySelectorAll: (sel: string) => (sel === "*" ? [el] : []),
    };
    const win = {
      scrollTo: () => {
        throw new Error("window must not scroll when an inner root exists");
      },
    };
    await withFakes(doc, win, () =>
      preScroll({ evaluate: async (fn: any) => fn() }),
    );
    expect(tops).toHaveLength(MAX_PRESCROLL_STEPS + 1);
    expect(tops[MAX_PRESCROLL_STEPS]).toBe(0); // reset
    expect(Math.max(...tops)).toBe(450 * (MAX_PRESCROLL_STEPS - 1));
  });

  it("returns document metrics and a null scrollRoot for a document-scrolling page", async () => {
    const doc = {
      documentElement: { scrollHeight: 2000, clientHeight: 900 },
      body: {},
      querySelectorAll: () => [],
    };
    const win = { scrollTo: () => {} };
    const info = await withFakes(doc, win, () =>
      preScroll({ evaluate: async (fn: any) => fn() }),
    );
    expect(info).toEqual({ scrollRoot: null, scrollHeight: 2000, clientHeight: 900 });
  });

  it("returns the inner scroller label and its metrics", async () => {
    const el = {
      tagName: "DIV",
      id: "page",
      classList: ["page"],
      clientHeight: 800,
      scrollHeight: 4000,
      scrollTop: 0,
      getBoundingClientRect: () => ({ width: 1440, height: 800 }),
    };
    const doc = {
      documentElement: { scrollHeight: 800, clientHeight: 800 },
      body: {},
      querySelectorAll: (sel: string) => (sel === "*" ? [el] : []),
    };
    const win = { scrollTo: () => {} };
    const info = await withFakes(doc, win, () =>
      preScroll({ evaluate: async (fn: any) => fn() }),
    );
    expect(info).toEqual({ scrollRoot: "div#page.page", scrollHeight: 4000, clientHeight: 800 });
    expect(el.scrollTop).toBe(0); // walk reset the scroller
  });

  it("escapes special-character scroller ids/classes (CSS.escape and fallback)", async () => {
    const el = {
      tagName: "DIV",
      id: "page:main/x.y",
      classList: ["scroll.inner"],
      clientHeight: 900,
      scrollHeight: 2000,
      scrollTop: 0,
      getBoundingClientRect: () => ({ width: 1440, height: 900 }),
    };
    const doc = {
      documentElement: { scrollHeight: 900, clientHeight: 900 },
      body: {},
      querySelectorAll: (sel: string) => (sel === "*" ? [el] : []),
    };
    const win = { scrollTo: () => {} };
    const g = globalThis as any;
    const saved = g.CSS;
    const expected = String.raw`div#page\:main\/x\.y.scroll\.inner`;
    try {
      g.CSS = { escape: (s: string) => String(s).replace(/[^A-Za-z0-9_-]/g, "\\$&") };
      const escaped = await withFakes(doc, win, () =>
        preScroll({ evaluate: async (fn: any) => fn() }),
      );
      expect(escaped.scrollRoot).toBe(expected);
      // No CSS.escape in an old engine/fake page: the fallback still escapes.
      g.CSS = undefined;
      const fallback = await withFakes(doc, win, () =>
        preScroll({ evaluate: async (fn: any) => fn() }),
      );
      expect(fallback.scrollRoot).toBe(expected);
    } finally {
      g.CSS = saved;
    }
  });

  it("source-locks the cap literals and applies them to both walks", () => {
    const src = String(preScroll);
    expect(src).toContain(`maxSteps = ${MAX_PRESCROLL_STEPS}`);
    expect(PRE_SCROLL_DEADLINE_MS).toBe(8000);
    expect(src).toMatch(/deadlineMs = (8e3|8000)/); // esbuild prints 8000 as 8e3
    expect(src).toContain("Date.now() - started < deadlineMs");
    expect(src.match(/steps < maxSteps/g)).toHaveLength(2);
  });
});

describe("analyzePageStructure", () => {
  it("builds the structure from the loader's evaluate result", async () => {
    const fake = {
      launch: async () => ({
        newPage: async () => ({
          goto: async () => {},
          // settle wait from the load strategy; the fake's evaluate result is
          // returned for both the pre-scroll and the scan call
          waitForTimeout: async () => {},
          evaluate: async () => ({
            title: "Test Page",
            totalHeight: 2000,
            candidates: [
              band({ label: "body", bg: "rgb(16, 21, 42)", top: 0, height: 2000 }),
              band({ tag: "section", label: ".shell", bg: "rgb(240, 242, 247)", top: 500, height: 1000, textStart: "Production speed" }),
            ],
          }),
        }),
        close: async () => {},
      }),
    };
    const res = await analyzePageStructure("https://example.com", async () => ({ chromium: fake }));
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.title).toBe("Test Page");
      expect(res.totalHeight).toBe(2000);
      expect(res.bands.map((b) => b.label)).toContain(".shell");
      expect(res.bands[0].background).toBe("rgb(16, 21, 42)");
    }
  });

  it("passes landmark tops through the scan into band splitting", async () => {
    const fake = {
      launch: async () => ({
        newPage: async () => ({
          goto: async () => {},
          waitForTimeout: async () => {},
          evaluate: async () => ({
            title: "Giant Page",
            totalHeight: 6000,
            landmarks: [1000, 3000],
            candidates: [
              band({ label: "body", bg: "rgb(16, 21, 42)", top: 0, height: 6000 }),
            ],
          }),
        }),
        close: async () => {},
      }),
    };
    const res = await analyzePageStructure("https://example.com", async () => ({ chromium: fake }));
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      // The 6000px body band split at both landmarks; later subs carry an
      // empty label.
      expect(res.bands.map((b) => b.height)).toEqual([1000, 2000, 3000]);
      expect(res.bands.map((b) => b.label)).toEqual(["body", "", ""]);
      expect(res.bands.map((b) => b.offsetTop)).toEqual([0, 1000, 3000]);
    }
  });

  it("passes the responsive flag to the scan and builds the report", async () => {
    const rawScan = {
      title: "Mobile Page",
      totalHeight: 800,
      candidates: [
        band({ label: "body", bg: "rgb(16, 21, 42)", top: 0, height: 800 }),
      ],
      responsive: {
        innerWidth: 390,
        scrollWidth: 390,
        counts: { overflow: 0, smallText: 0, smallTapTarget: 0 },
        overflow: [],
        smallText: [],
        smallTapTarget: [],
      },
    };
    const argsSeen: any[] = [];
    const fake = {
      launch: async () => ({
        newPage: async () => ({
          goto: async () => {},
          waitForTimeout: async () => {},
          evaluate: async (_fn: unknown, arg?: unknown) => {
            argsSeen.push(arg);
            return rawScan;
          },
        }),
        close: async () => {},
      }),
    };
    const res = await analyzePageStructure(
      "https://example.com",
      async () => ({ chromium: fake }),
      40,
      { viewport: "mobile", responsive: true },
    );
    expect("error" in res).toBe(false);
    // preScroll calls evaluate with no argument; the scan passes the options.
    expect(argsSeen).toEqual([undefined, undefined, { responsive: true }]);
    if (!("error" in res)) {
      expect(res.responsive).toEqual({
        measuredAt: "mobile",
        viewport: { width: 390, height: 844, dpr: 3 },
        pageOverflow: { horizontal: false, scrollWidth: 390, innerWidth: 390 },
        issues: [],
        counts: { overflow: 0, smallText: 0, smallTapTarget: 0 },
        truncated: false,
      });
    }
  });

  it("omits responsive when the scan does not return raw evidence", async () => {
    const argsSeen: any[] = [];
    const fake = {
      launch: async () => ({
        newPage: async () => ({
          goto: async () => {},
          waitForTimeout: async () => {},
          evaluate: async (_fn: unknown, arg?: unknown) => {
            argsSeen.push(arg);
            return {
              title: "Desktop Page",
              totalHeight: 800,
              candidates: [
                band({ label: "body", bg: "rgb(16, 21, 42)", top: 0, height: 800 }),
              ],
            };
          },
        }),
        close: async () => {},
      }),
    };
    const res = await analyzePageStructure(
      "https://example.com",
      async () => ({ chromium: fake }),
      40,
      { responsive: false },
    );
    expect("error" in res).toBe(false);
    expect(argsSeen[2]).toEqual({ responsive: false });
    if (!("error" in res)) expect("responsive" in res).toBe(false);
  });

  it("viewport mobile without compare does not scan and returns no responsive key", async () => {
    const argsSeen: any[] = [];
    const fake = {
      launch: async () => ({
        newPage: async () => ({
          goto: async () => {},
          waitForTimeout: async () => {},
          evaluate: async (_fn: unknown, arg?: unknown) => {
            argsSeen.push(arg);
            return {
              title: "Mobile Page",
              totalHeight: 800,
              candidates: [
                band({ label: "body", bg: "rgb(16, 21, 42)", top: 0, height: 800 }),
              ],
            };
          },
        }),
        close: async () => {},
      }),
    };
    const res = await analyzePageStructure(
      "https://example.com",
      async () => ({ chromium: fake }),
      40,
      { viewport: "mobile" },
    );
    expect("error" in res).toBe(false);
    expect(argsSeen[2]).toEqual({ responsive: false });
    if (!("error" in res)) expect("responsive" in res).toBe(false);
  });

  it("returns the install hint when playwright is missing", async () => {
    const res = await analyzePageStructure("https://example.com", async () => {
      throw new Error("Cannot find package 'playwright'");
    });
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toContain("npm exec --global -- playwright install chromium");
  });

  it("defaults to the load strategy, settles, and scrolls before the scan", async () => {
    const calls: string[] = [];
    const fake = {
      launch: async () => ({
        newPage: async () => ({
          goto: async (_u: string, o: any) => { calls.push("goto:" + o.waitUntil); },
          waitForTimeout: async (ms: number) => { calls.push("wait:" + ms); },
          evaluate: async () => {
            calls.push("eval");
            return {
              title: "Test Page",
              totalHeight: 2000,
              candidates: [
                band({ label: "body", bg: "rgb(16, 21, 42)", top: 0, height: 2000 }),
              ],
            };
          },
        }),
        close: async () => {},
      }),
    };
    const res = await analyzePageStructure("https://example.com", async () => ({ chromium: fake }));
    expect("error" in res).toBe(false);
    expect(calls[0]).toBe("goto:load"); // default wait strategy is "load"
    expect(calls.indexOf("wait:3000")).toBe(1); // settle right after load
    expect(calls.filter((c) => c === "eval").length).toBe(3); // overlay + pre-scroll + scan
    expect(calls[calls.length - 1]).toBe("eval"); // scan runs last, after the scroll
  });

  // Fake chromium whose newPage captures its creation options so tests can
  // pin the viewport threading (desktop default vs the mobile profile flags).
  const optionCapturingFake = (captured: any[]) => ({
    launch: async () => ({
      newPage: async (opts: any) => {
        captured.push(opts);
        return {
          goto: async () => {},
          // settle wait from the load strategy; the fake's evaluate result is
          // returned for both the pre-scroll and the scan call
          waitForTimeout: async () => {},
          evaluate: async () => ({
            title: "Test Page",
            totalHeight: 2000,
            candidates: [
              band({ label: "body", bg: "rgb(16, 21, 42)", top: 0, height: 2000 }),
            ],
          }),
        };
      },
      close: async () => {},
    }),
  });

  it("uses the mobile viewport profile when opts.viewport is mobile", async () => {
    const captured: any[] = [];
    const res = await analyzePageStructure(
      "https://x.test",
      async () => ({ chromium: optionCapturingFake(captured) }),
      40,
      { viewport: "mobile" },
    );
    expect("error" in res).toBe(false);
    expect(captured).toHaveLength(1);
    // The profile is SPLIT: width/height land in playwright's `viewport` key,
    // the mobile flags are sibling context options.
    expect(captured[0]).toEqual({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
  });

  it("defaults to the desktop viewport (no mobile flags)", async () => {
    const captured: any[] = [];
    const res = await analyzePageStructure(
      "https://x.test",
      async () => ({ chromium: optionCapturingFake(captured) }),
    );
    expect("error" in res).toBe(false);
    expect(captured).toHaveLength(1);
    // Exact equality: the desktop default must inject no mobile flags and no
    // extra fields into newPage.
    expect(captured[0]).toEqual({ viewport: { width: 1440, height: 900 } });
  });
});

describe("analyzePageStructure attach mode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const SCAN = {
    title: "Attached Page",
    totalHeight: 900,
    candidates: [
      band({ label: "body", bg: "rgb(16, 21, 42)", top: 0, height: 900 }),
    ],
  };
  // ws input avoids http discovery (covered in browser.test.ts) so these tests
  // never touch the network.
  const ATTACH_WS = "ws://127.0.0.1:9222/devtools/browser/test";

  // Fake browser with no newPage: any launch/page-creation fallback throws.
  function attachFake(pageUrl = "https://example.com/", scan: any = SCAN) {
    const evalCalls: Array<{ fn: unknown; arg?: unknown }> = [];
    const calls: string[] = [];
    const page = {
      url: () => pageUrl,
      evaluate: async (fn: unknown, arg?: unknown) => {
        evalCalls.push({ fn, arg });
        return scan;
      },
      goto: async () => {
        calls.push("goto");
      },
      waitForTimeout: async () => {
        calls.push("wait");
      },
      close: async () => {
        calls.push("page.close");
      },
    };
    const browser = {
      contexts: () => [
        {
          pages: () => [page],
          close: async () => {
            calls.push("context.close");
          },
        },
      ],
      close: async () => {
        calls.push("browser.close");
      },
    };
    const chromium = {
      launch: async () => {
        calls.push("launch");
        return browser;
      },
      connectOverCDP: async (endpoint: string) => {
        calls.push("connect:" + endpoint);
        return browser;
      },
    };
    return { evalCalls, calls, page, loader: async () => ({ chromium }) };
  }

  it.each([undefined, ""])(
    "requires AWWWARDS_MCP_ATTACH=1 (ambient value %s) and never loads playwright otherwise",
    async (ambient) => {
      vi.stubEnv("AWWWARDS_MCP_ATTACH", ambient);
      let loaded = false;
      const res = await analyzePageStructure(
        "https://example.com",
        async () => {
          loaded = true;
          return {};
        },
        40,
        { cdpEndpoint: "http://127.0.0.1:9222" },
      );
      expect("error" in res).toBe(true);
      if ("error" in res) expect(res.error).toContain("AWWWARDS_MCP_ATTACH=1");
      expect(loaded).toBe(false);
    },
  );

  it("scans the attached page without launch, goto, settle or preScroll", async () => {
    vi.stubEnv("AWWWARDS_MCP_ATTACH", "1");
    const fake = attachFake();
    const res = await analyzePageStructure(
      "https://example.com",
      fake.loader,
      40,
      { cdpEndpoint: ATTACH_WS },
    );
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.attached).toBe(true);
      expect(res.title).toBe("Attached Page");
      expect(res.totalHeight).toBe(900);
      expect(res.bands.map((b) => b.label)).toEqual(["body"]);
    }
    expect(fake.calls).toEqual(["connect:" + ATTACH_WS, "browser.close"]);
    // Two evaluates: the one-shot dev shim, then the scan (preScroll would add
    // an argument-less call after them).
    expect(fake.evalCalls).toHaveLength(2);
    expect(String(fake.evalCalls[0]!.fn)).toContain("globalThis.__name");
    expect(fake.evalCalls[1]).toEqual({ fn: SCAN_SNIPPET, arg: { responsive: false } });
  });

  it("rejects an invalid endpoint before loading playwright", async () => {
    vi.stubEnv("AWWWARDS_MCP_ATTACH", "1");
    let loaded = false;
    const res = await analyzePageStructure(
      "https://example.com",
      async () => {
        loaded = true;
        return {};
      },
      40,
      { cdpEndpoint: "https://127.0.0.1:9222" },
    );
    expect("error" in res).toBe(true);
    expect(loaded).toBe(false);
  });

  it("rejects a custom viewport in attach mode", async () => {
    vi.stubEnv("AWWWARDS_MCP_ATTACH", "1");
    const fake = attachFake();
    const res = await analyzePageStructure(
      "https://example.com",
      fake.loader,
      40,
      { viewport: "mobile", cdpEndpoint: "http://127.0.0.1:9222" },
    );
    expect("error" in res).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  it("rejects a responsive scan in attach mode", async () => {
    vi.stubEnv("AWWWARDS_MCP_ATTACH", "1");
    const fake = attachFake();
    const res = await analyzePageStructure(
      "https://example.com",
      fake.loader,
      40,
      { responsive: true, cdpEndpoint: "http://127.0.0.1:9222" },
    );
    expect("error" in res).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  it("errors when no open page matches and disconnects", async () => {
    vi.stubEnv("AWWWARDS_MCP_ATTACH", "1");
    const fake = attachFake("https://other.test/page");
    const res = await analyzePageStructure(
      "https://example.com",
      fake.loader,
      40,
      { cdpEndpoint: ATTACH_WS },
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toContain("https://other.test");
    expect(fake.evalCalls).toEqual([]);
    expect(fake.calls).toEqual(["connect:" + ATTACH_WS, "browser.close"]);
  });
});

// No-arrow lock for SCAN_SNIPPET's in-page code: page.evaluate re-serializes
// the source, so the snippet (and every helper inside it) must stay a plain
// function / function declaration — no arrows anywhere in its body.
it("SCAN_SNIPPET is a serializable plain function (no-arrow lock)", () => {
  expect(typeof SCAN_SNIPPET).toBe("function");
  const src = String(SCAN_SNIPPET);
  expect(src).not.toContain("=>");
  expect(src).toContain("smallTapTarget");
});

// Mirror of the SCAN_SNIPPET in-page alpha parse (src/structure.ts). The
// snippet runs in a browser DOM we cannot spin up in offline tests, so the
// parse logic is mirrored here to pin the exact contract: space syntax,
// slash notation, percentage alphas, and the rgba?()-miss fallback (modern
// color functions are opaque; anything else stays conservative at 0).
// Keep in sync with src/structure.ts.
it("SCAN_SNIPPET alpha parsing handles space syntax and percentage alphas", () => {
  const parseAlpha = (color: string): number => {
    const m = /rgba?\(([^)]+)\)/.exec(color);
    let alpha = 0;
    if (m) {
      const parts = m[1].replace(/\//g, " ").trim().split(/[\s,]+/).filter(Boolean);
      const aRaw = parts.length >= 4 ? parts[3] : "1";
      alpha = aRaw.endsWith("%") ? parseFloat(aRaw) / 100 : parseFloat(aRaw);
      if (Number.isNaN(alpha)) alpha = 0;
    } else if (/^(oklch|oklab|lab|lch|hwb|color)\(/.test(color.trim())) {
      alpha = 1;
    }
    return alpha;
  };
  expect(parseAlpha("rgb(16 21 42 / 0)")).toBe(0); // space syntax, transparent
  expect(parseAlpha("rgb(16, 21, 42, 0)")).toBe(0); // legacy comma, transparent
  expect(parseAlpha("rgb(16 21 42 / 50%)")).toBeCloseTo(0.5); // percentage alpha
  expect(parseAlpha("rgb(240, 242, 247)")).toBe(1); // opaque, no alpha part
  expect(parseAlpha("oklch(0.7 0.1 200)")).toBe(1); // modern opaque function
  expect(parseAlpha("color(srgb 0.2 0.4 0.6)")).toBe(1); // modern opaque function
  expect(parseAlpha("linear-gradient(...)")).toBe(0); // non-function → conservative
});

// Scroll modes: document / virtual (transform-driven wrapper) / canvas-only.
// The fake DOM carries just what SCAN_SNIPPET reads; elements are listed flat
// in document order (outermost first) like querySelectorAll("*").
describe("SCAN_SNIPPET scrollMode", () => {
  const fakeEl = (tag: string, cls: string, rect: Record<string, number>, over: Record<string, unknown> = {}) => ({
    tagName: tag.toUpperCase(),
    id: "",
    classList: cls ? [cls] : [],
    children: [] as any[],
    textContent: "",
    scrollHeight: 0,
    clientHeight: 0,
    scrollTop: 0,
    getBoundingClientRect: () => ({ left: 0, right: 1440, bottom: rect.top + rect.height, ...rect }),
    ...over,
  });

  const scanFake = (opts: { docHeight: number; els: any[]; canvases?: any[]; styleFor?: (el: any) => any }) => {
    const body: any = fakeEl("body", "", { top: 0, width: 1440, height: opts.docHeight });
    body.children = opts.els.filter((e) => !opts.els.some((p) => p.children.includes(e)));
    const fakeDoc = {
      title: "T",
      documentElement: { scrollHeight: opts.docHeight, clientHeight: 900 },
      body,
      scrollingElement: { clientHeight: 900 },
      querySelectorAll: (sel: string) => {
        if (sel === "*") return [body, ...opts.els];
        if (sel === "canvas") return opts.canvases ?? [];
        return [];
      },
    };
    const g = globalThis as any;
    const saved = {
      document: g.document,
      getComputedStyle: g.getComputedStyle,
      scrollX: g.scrollX,
      scrollY: g.scrollY,
      innerHeight: g.innerHeight,
      innerWidth: g.innerWidth,
    };
    g.document = fakeDoc;
    g.scrollX = 0;
    g.scrollY = 0;
    g.innerHeight = 900;
    g.innerWidth = 1440;
    g.getComputedStyle = (el: any) => ({
      overflowY: "visible",
      display: "block",
      visibility: "visible",
      position: "relative",
      backgroundColor: "rgb(255, 255, 255)",
      ...(opts.styleFor ? opts.styleFor(el) : {}),
    });
    try {
      return SCAN_SNIPPET({});
    } finally {
      Object.assign(g, saved);
    }
  };

  it("virtual: translated 25200px wrapper gives its height and 0-based band tops", () => {
    // main moved to top -7955 by the virtual scroller; the document stays 900.
    const main = fakeEl("main", "home", { top: -7955, width: 1440, height: 25200 });
    const hero = fakeEl("section", "hero", { top: -7955, width: 1440, height: 900 });
    const work = fakeEl("section", "work", { top: -7055, width: 1440, height: 3000 });
    const inner = fakeEl("div", "inner", { top: -7955, width: 1440, height: 25200 }); // equal height: outermost wins
    main.children = [hero, work];
    const res = scanFake({
      docHeight: 900,
      els: [main, inner, hero, work],
      styleFor: (el) => (el === work ? { backgroundColor: "rgb(10, 10, 10)" } : {}),
    });
    expect(res.scrollMode).toBe("virtual");
    expect(res.virtualRoot).toBe("main.home");
    expect(res.totalHeight).toBe(25200);
    expect(res.scrollRoot).toBeUndefined();
    const tops = res.candidates.filter((c) => c.tag === "section").map((c) => c.top);
    expect(tops).toEqual([0, 900]);
    const bands = collapseBands(res.candidates, res.totalHeight);
    expect(bands.length).toBeGreaterThan(1);
    expect(bands[bands.length - 1].offsetTop + bands[bands.length - 1].height).toBe(25200);
  });

  it("virtual: ignores a fixed-position tall element", () => {
    const fixedBg = fakeEl("div", "bg", { top: 0, width: 1440, height: 5000 });
    const res = scanFake({
      docHeight: 900,
      els: [fixedBg],
      styleFor: (el) => (el === fixedBg ? { position: "fixed" } : {}),
    });
    expect(res.scrollMode).not.toBe("virtual");
  });

  it("canvas: a full-viewport canvas on a one-screen page", () => {
    const canvas = fakeEl("canvas", "webgl", { top: 0, width: 1440, height: 900 });
    const res = scanFake({ docHeight: 900, els: [canvas], canvases: [canvas] });
    expect(res.scrollMode).toBe("canvas");
    expect(res.note).toContain("record_site_motion");
    expect(res.note).toContain("capture_pose_3d");
    expect(res.totalHeight).toBe(900);
    expect(res.virtualRoot).toBeUndefined();
  });

  it("canvas: a small canvas does not trigger canvas mode", () => {
    const canvas = fakeEl("canvas", "chart", { top: 0, width: 400, height: 300 }, {});
    const res = scanFake({ docHeight: 900, els: [canvas], canvases: [canvas] });
    expect(res.scrollMode).toBe("document");
    expect(res.note).toBeUndefined();
  });

  it("document: normal tall page is unchanged (height, no virtualRoot, no note)", () => {
    const section = fakeEl("section", "a", { top: 0, width: 1440, height: 5000 });
    const res = scanFake({ docHeight: 5000, els: [section] });
    expect(res.scrollMode).toBe("document");
    expect(res.totalHeight).toBe(5000);
    expect(res.virtualRoot).toBeUndefined();
    expect(res.scrollRoot).toBeUndefined();
    expect(res.note).toBeUndefined();
  });

  it("element scroll root keeps scrollRoot and reports element mode", () => {
    const scroller = fakeEl("div", "page", { top: 0, width: 1440, height: 900 }, {
      scrollHeight: 4000,
      clientHeight: 900,
    });
    const res = scanFake({
      docHeight: 900,
      els: [scroller],
      styleFor: (el) => (el === scroller ? { overflowY: "auto" } : {}),
    });
    expect(res.scrollMode).toBe("element");
    expect(res.scrollRoot).toBe("div.page");
    expect(res.totalHeight).toBe(4000);
  });

  it("analyzePageStructure passes scrollMode/virtualRoot/note through; omits them when absent", async () => {
    const mk = (extra: Record<string, unknown>) => ({
      chromium: {
        launch: async () => ({
          newPage: async () => ({
            addInitScript: async () => {},
            goto: async () => {},
            waitForTimeout: async () => {},
            url: () => "https://x.test/",
            evaluate: async () => ({
              title: "T",
              totalHeight: 25200,
              candidates: [{ tag: "body", label: "body", bg: "rgb(0,0,0)", top: 0, height: 25200, textStart: "" }],
              ...extra,
            }),
          }),
          close: async () => {},
        }),
      },
    });
    const withMode = await analyzePageStructure("https://x.test/", async () => mk({ scrollMode: "virtual", virtualRoot: "main.home" }));
    if ("error" in withMode) throw new Error(withMode.error);
    expect(withMode.scrollMode).toBe("virtual");
    expect(withMode.virtualRoot).toBe("main.home");
    const without = await analyzePageStructure("https://x.test/", async () => mk({}));
    if ("error" in without) throw new Error(without.error);
    expect("scrollMode" in without).toBe(false);
    expect("virtualRoot" in without).toBe(false);
    expect("note" in without).toBe(false);
  });

  it("SCAN_SNIPPET virtual detection and preScroll mirror each other (source-lock)", () => {
    for (const src of [String(SCAN_SNIPPET), String(preScroll)]) {
      expect(src).toMatch(/r\.width >= (0)?\.6 \* bodyWidth/);
      expect(src).toContain("viewportHeight + 100");
      expect(src).toContain('String(s.position) === "fixed"');
    }
  });
});
