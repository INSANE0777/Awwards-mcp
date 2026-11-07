import { describe, expect, it } from "vitest";
import { buildHeldoutReview, scoreHeldout, type HeldoutReview } from "../src/atlas/heldout.js";
import type { AtlasCaptureAttempt } from "../src/atlas/live-types.js";

const attempt = {
  target: {
    siteSlug: "heldout",
    requestedUrl: "https://heldout.example/",
    urlKey: "https://heldout.example/",
    path: "/",
  },
  finishedAt: 1_700_000_000_000,
  artifacts: [],
  viewports: [
    {
      viewport: "desktop",
      screenshots: [{ key: "screenshot-desktop-0" }],
      regions: [
        { key: "r1", nodeKey: "n1", selector: "main > section.about", rect: { x: 0, y: 10, width: 100, height: 50 } },
        { key: "r2", nodeKey: "n2", selector: "main > section.pricing", rect: { x: 0, y: 100, width: 100, height: 50 } },
      ],
      claims: [
        { regionKey: "r1", value: "about", decision: "candidate" },
        { regionKey: "r2", value: "pricing", decision: "candidate" },
        { regionKey: "r2", value: "cta", decision: "candidate" },
      ],
    },
  ],
} as unknown as AtlasCaptureAttempt;

describe("Atlas held-out review harness", () => {
  it("exports candidate-only sections without claiming a review", () => {
    const review = buildHeldoutReview(attempt);
    expect(review.schemaVersion).toBe("awwwards-atlas-heldout-review-v1");
    expect(review.sections).toHaveLength(2);
    expect(review.sections[0]).toMatchObject({
      selector: "main > section.about",
      candidateLabels: ["about"],
      acceptedLabels: [],
      humanLabels: [],
      screenshotKeys: ["screenshot-desktop-0"],
      reviewed: false,
    });
    expect(review.sections[0]!.rect).toEqual({ x: 0, y: 10, width: 100, height: 50 });
    expect(review.artifacts).toEqual([]);
  });

  it("computes per-class precision and recall from reviewed human labels", () => {
    const review = buildHeldoutReview(attempt) as HeldoutReview;
    review.sections.forEach((section) => {
      section.reviewed = true;
    });
    const scored = scoreHeldout(review, {
      [`${review.captureKey}|desktop|r1`]: ["about"],
      [`${review.captureKey}|desktop|r2`]: ["pricing"],
    });
    expect(scored.perClass.find((item) => item.class === "about")).toMatchObject({
      precision: 1,
      recall: 1,
    });
    expect(scored.perClass.find((item) => item.class === "cta")).toMatchObject({
      precision: 0,
      recall: 0,
    });
    expect(scored.perClass.find((item) => item.class === "pricing")).toMatchObject({
      precision: 1,
      recall: 1,
    });
    expect(scored.macroPrecision).toBeLessThan(1);
  });

  it("requires explicit review status", () => {
    const review = buildHeldoutReview(attempt) as HeldoutReview;
    expect(() => scoreHeldout(review, {})).toThrow(/explicitly marked reviewed/);
  });

  it("rejects duplicate review keys", () => {
    const review = buildHeldoutReview(attempt) as HeldoutReview;
    review.sections.forEach((section) => {
      section.reviewed = true;
    });
    review.sections[1]!.regionKey = review.sections[0]!.regionKey;
    expect(() => scoreHeldout(review, {})).toThrow(/Duplicate/);
  });

  it("rejects unknown annotation keys instead of silently dropping them", () => {
    const review = buildHeldoutReview(attempt) as HeldoutReview;
    review.sections.forEach((section) => {
      section.reviewed = true;
    });
    expect(() =>
      scoreHeldout(review, {
        [`${review.captureKey}|desktop|missing-region`]: ["about"],
      }),
    ).toThrow(/Unknown annotation keys/);
  });

  it("includes human-only classes in scoring", () => {
    const review = buildHeldoutReview(attempt) as HeldoutReview;
    review.sections.forEach((section) => {
      section.reviewed = true;
    });
    const scored = scoreHeldout(review, {
      [`${review.captureKey}|desktop|r1`]: ["about", "pricing"],
      [`${review.captureKey}|desktop|r2`]: ["pricing"],
    });
    expect(scored.perClass.find((item) => item.class === "pricing")?.falseNegatives).toBe(1);
    expect(scored.macroRecall).toBeLessThan(1);
  });
});
