import { describe, expect, it } from "vitest";
import { classifySections, primaryPurpose } from "../src/atlas/classification.js";
import { segmentRegions } from "../src/atlas/segmentation.js";
import { ATLAS_VOCABULARY } from "../src/atlas/vocabulary.js";
import { loadPhase2Fixture } from "./helpers/phase2-fixture.js";

describe("Atlas section classification", () => {
  it("matches the owned ground-truth fixture and reports fixture precision/recall", () => {
    const { scan, labels } = loadPhase2Fixture();
    const regions = segmentRegions(scan);
    const claims = classifySections(
      regions.map((candidate) => ({
        viewport: "desktop" as const,
        candidate,
        scan,
        artifactKey: "scan-desktop",
      })),
      ATLAS_VOCABULARY,
    );
    const predicted = new Map<string, Set<string>>();
    for (const claim of claims) {
      const set = predicted.get(claim.regionKey) ?? new Set<string>();
      set.add(claim.value);
      predicted.set(claim.regionKey, set);
    }
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const region of regions) {
      const truth = new Set(labels.get(region.selector) ?? []);
      const guess = predicted.get(region.key) ?? new Set<string>();
      for (const value of guess) {
        if (truth.has(value)) tp += 1;
        else fp += 1;
      }
      for (const value of truth) if (!guess.has(value)) fn += 1;
    }
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    expect({ precision, recall }).toEqual({ precision: 1, recall: 1 });
    expect(claims.every((claim) => claim.evidence.length === 1)).toBe(true);
    expect(claims.every((claim) => claim.decision === "candidate")).toBe(true);
    expect(claims.every((claim) => claim.classification === "inferred")).toBe(true);
    expect(claims.filter((claim) => claim.decision === "accepted")).toHaveLength(0);
    expect(claims.some((claim) => claim.value === "product_listing")).toBe(false);
    expect(primaryPurpose(claims)).toBeNull();
  });

  it("leaves unknown and reserved product sections unlabeled", () => {
    const { scan } = loadPhase2Fixture();
    const candidate = segmentRegions({
      ...scan,
      sections: [
        {
          ...scan.sections[0]!,
          selector: "main > section.product",
          tag: "section",
          landmark: null,
          heading: "Product listing",
          headingLevel: 2,
          text: "Browse products with filters and sorting.",
          rect: { x: 0, y: 400, width: 1200, height: 500 },
        },
      ],
    })[0]!;
    expect(
      classifySections(
        { viewport: "desktop", candidate, scan, artifactKey: "scan-desktop" },
        ATLAS_VOCABULARY,
      ),
    ).toEqual([]);
  });

  it("rejects nested headers, hidden pricing, unpriced plans, and dismiss controls", () => {
    const { scan } = loadPhase2Fixture();
    const base = scan.sections[1]!;
    const cases = [
      {
        ...base,
        selector: "article > header",
        tag: "header",
        landmark: "header",
        articleNested: true,
        landmarkNested: true,
        heading: "Article header",
      },
      {
        ...base,
        selector: "article > section > footer",
        tag: "footer",
        landmark: "footer",
        landmarkNested: true,
        heading: "Section footer",
      },
      {
        ...base,
        selector: "main > section.hidden-pricing",
        heading: "Pricing plans",
        headingLevel: 2,
        numericPairs: 2,
        visible: false,
      },
      {
        ...base,
        selector: "main > section.pricing-no-prices",
        heading: "Pricing plans",
        headingLevel: 2,
        numericPairs: 0,
      },
      {
        ...base,
        selector: "main > section.dismiss-cta",
        heading: "Get started",
        headingLevel: 2,
        buttonCount: 1,
        buttonLabels: ["Dismiss"],
        numericPairs: 0,
      },
      {
        ...base,
        selector: "main > section.dismiss",
        heading: "Dismiss",
        headingLevel: 2,
        buttonCount: 1,
        numericPairs: 0,
      },
    ];
    const regions = segmentRegions({ ...scan, sections: cases });
    const claims = classifySections(
      regions.map((candidate) => ({
        viewport: "desktop" as const,
        candidate,
        scan,
        artifactKey: "scan-desktop",
      })),
      ATLAS_VOCABULARY,
    );
    expect(claims).toEqual([]);
  });

  it("does not classify keywords that appear only in body copy", () => {
    const { scan } = loadPhase2Fixture();
    const base = scan.sections[0]!;
    const regions = segmentRegions({
      ...scan,
      sections: [
        {
          ...base,
          selector: "main > section.copy",
          tag: "section",
          landmark: null,
          role: null,
          heading: null,
          headingLevel: null,
          text: `${"about pricing contact resources editorial case study features services ".repeat(
            5,
          )}`,
          paragraphCount: 4,
          articleNested: false,
        },
      ],
    });
    const claims = classifySections(
      regions.map((candidate) => ({
        viewport: "desktop" as const,
        candidate,
        scan,
        artifactKey: "scan-desktop",
      })),
      ATLAS_VOCABULARY,
    );
    expect(claims.map((claim) => claim.value)).toEqual([]);
  });
});
