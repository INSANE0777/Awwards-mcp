import { ATLAS_VOCABULARY } from "./vocabulary.js";
import type {
  AtlasClaim,
  AtlasClassificationRegistry,
  AtlasRect,
  RegionCandidate,
  SectionEvidence,
} from "./live-types.js";

export const ATLAS_SECTION_RULE_VERSION = "atlas-section-rules-1";

const HEADING = {
  about: /\b(about|overview|our story|who we are|mission)\b/i,
  features: /\b(features|benefits|what we do)\b/i,
  services: /\b(services|offerings|solutions)\b/i,
  process: /\b(process|how it works|our approach|steps)\b/i,
  pricing: /\b(pricing|plans|pricing plans)\b/i,
  testimonials: /\b(testimonials|reviews|what clients say)\b/i,
  logos: /\b(trusted by|clients|partners|logos|brands)\b/i,
  metrics: /\b(metrics|impact|by the numbers|results)\b/i,
  team: /\b(team|people|leadership|our team)\b/i,
  portfolio: /\b(work|projects|portfolio|gallery|selected work)\b/i,
  caseStudy: /\b(case study|case studies|customer story)\b/i,
  resources: /\b(resources|insights|articles|guides|blog)\b/i,
  contact: /\b(contact|get in touch|let'?s talk|work with us)\b/i,
  newsletter: /\b(newsletter|subscribe|stay in the loop)\b/i,
  faq: /\b(faq|frequently asked questions|questions)\b/i,
  cta: /\b(get started|start your|book a|request a|try it|join us|sign up)\b/i,
};

function enabled(registry: AtlasClassificationRegistry, value: string): boolean {
  return registry.some(
    (entry) => entry.field === "section.purpose" && entry.value === value && entry.enabled,
  );
}

function area(rect: AtlasRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function headingText(candidate: RegionCandidate): string {
  return candidate.heading ?? "";
}

function refs(evidence: SectionEvidence, candidate: RegionCandidate) {
  return [
    {
      artifactId: evidence.artifactKey ?? "scan",
      pointer: `/scan/sections/${candidate.scanIndex}`,
      sampleKey: `${evidence.viewport}:${candidate.key}`,
    },
  ];
}

/**
 * Rule-based section classification. Every rule reads only DOM/geometry/role
 * evidence; class names and source copy never become accepted semantic labels.
 */
export function classifySections(
  input: SectionEvidence | SectionEvidence[],
  registry: AtlasClassificationRegistry = ATLAS_VOCABULARY,
): AtlasClaim[] {
  const evidence = Array.isArray(input) ? input : [input];
  const claims: AtlasClaim[] = [];
  for (const item of evidence) {
    const candidate = item.candidate;
    const heading = headingText(candidate);
    const purposes = new Set<string>();
    const add = (value: string, ruleId: string, basis: "native_semantics" | "geometry" | "rule_derivation") => {
      if (purposes.has(value) || !enabled(registry, value)) return;
      purposes.add(value);
      claims.push({
        regionKey: candidate.key,
        field: "section.purpose",
        value,
        decision: CALIBRATED_SECTION_CLASSES.has(value) ? "accepted" : "candidate",
        classification: "inferred",
        basis,
        ruleId,
        ruleVersion: ATLAS_SECTION_RULE_VERSION,
        sampleKey: `${item.viewport}:${candidate.key}`,
        evidence: refs(item, candidate),
      });
    };

    if ((candidate.landmark === "header" || candidate.tag === "header") && !candidate.landmarkNested) {
      add("header", "landmark.header", "native_semantics");
    }
    if ((candidate.landmark === "footer" || candidate.tag === "footer") && !candidate.landmarkNested) {
      add("footer", "landmark.footer", "native_semantics");
    }
    if (candidate.landmark === "navigation" || candidate.tag === "nav" || candidate.role === "navigation") {
      add("navigation", "landmark.navigation", "native_semantics");
    }

    const headingTextValue = heading;
    const orderedOrRepeated =
      candidate.orderedItems >= 2 || candidate.repeatedItems >= 2;
    const viewportArea = candidate.viewport.width * candidate.viewport.height;
    const heroLike =
      candidate.ordinal <= 3 &&
      candidate.headingLevel === 1 &&
      candidate.rect.y <= candidate.viewport.height * 1.25 &&
      area(candidate.rect) >= viewportArea * 0.5 &&
      candidate.landmark === null;

    if (HEADING.about.test(headingTextValue) && candidate.text.length >= 80) {
      add("about", "heading.about.prose", "rule_derivation");
    }
    if (HEADING.features.test(headingTextValue) && candidate.repeatedItems >= 2) {
      add("features", "heading.features.repeated", "rule_derivation");
    }
    if (HEADING.services.test(headingTextValue) && candidate.repeatedItems >= 2) {
      add("services", "heading.services.repeated", "rule_derivation");
    }
    if (HEADING.process.test(headingTextValue) && orderedOrRepeated) {
      add("process", "heading.process.ordered", "rule_derivation");
    }
    if (
      HEADING.pricing.test(headingTextValue) &&
      candidate.numericPairs >= 2
    ) {
      add("pricing", "heading.pricing.plans", "rule_derivation");
    }
    if (candidate.quoteCount > 0 && candidate.citationCount > 0) {
      add("testimonials", "quote.attributed", "native_semantics");
    }
    if (HEADING.logos.test(headingTextValue) && candidate.mediaCount >= 3) {
      add("logos", "heading.logos.media", "rule_derivation");
    }
    if (HEADING.metrics.test(headingTextValue) && candidate.numericPairs >= 2) {
      add("metrics", "heading.metrics.pairs", "rule_derivation");
    }
    if (HEADING.team.test(headingTextValue) && candidate.repeatedItems >= 2) {
      add("team", "heading.team.people", "rule_derivation");
    }
    if (HEADING.portfolio.test(headingTextValue) && (candidate.mediaCount >= 3 || candidate.linkCount >= 3)) {
      add("portfolio_gallery", "heading.work.media", "rule_derivation");
    }
    if (HEADING.caseStudy.test(headingTextValue) && candidate.text.length >= 80 && candidate.linkCount >= 1) {
      add("case_study", "heading.case.summary", "rule_derivation");
    }
    if (
      candidate.tag === "article" &&
      headingText(candidate).length > 0 &&
      candidate.paragraphCount >= 2 &&
      candidate.text.length >= 80
    ) {
      add("editorial_content", "article.paragraphs", "native_semantics");
    }
    if (HEADING.resources.test(headingTextValue) && candidate.linkCount >= 3) {
      add("resource_list", "heading.resources.links", "rule_derivation");
    }
    if (HEADING.contact.test(headingTextValue) && (candidate.formCount > 0 || candidate.linkCount > 0)) {
      add("contact", "heading.contact.action", "rule_derivation");
    }
    if (candidate.emailInputCount > 0 && HEADING.newsletter.test(headingTextValue)) {
      add("newsletter", "form.email.newsletter", "rule_derivation");
    }
    if (HEADING.faq.test(headingTextValue) && orderedOrRepeated) {
      add("faq", "heading.faq.disclosures", "rule_derivation");
    }
    const actionLabels = candidate.buttonLabels.map((label) => label.toLowerCase());
    const dismissLabel = /dismiss|close|cancel|accept|reject|decline/;
    const actionableLabels = actionLabels.filter((label) => !dismissLabel.test(label));
    if (
      HEADING.cta.test(headingTextValue) &&
      actionableLabels.some((label) =>
        /get started|start|book|request|try|join|sign up|contact|buy|shop|subscribe|download|learn more/.test(
          label,
        ),
      ) &&
      purposes.size === 0
    ) {
      add("cta", "heading.cta.action", "rule_derivation");
    }
    if (heroLike) add("hero", "geometry.hero.first", "geometry");
  }
  return claims;
}

const PRECEDENCE = [
  "header",
  "navigation",
  "footer",
  "pricing",
  "newsletter",
  "contact",
  "faq",
  "testimonials",
  "logos",
  "team",
  "metrics",
  "process",
  "services",
  "features",
  "product_listing",
  "product_showcase",
  "portfolio_gallery",
  "case_study",
  "editorial_content",
  "resource_list",
  "about",
  "hero",
  "cta",
];

// Classes stay candidate-only until a reviewed fixture count and per-class
// held-out threshold are recorded. Do not promote a class by name here.
const CALIBRATED_SECTION_CLASSES = new Set<string>();

/** Display-only primary purpose; all accepted purposes remain claims. */
export function primaryPurpose(claims: AtlasClaim[]): string | null {
  const values = new Set(
    claims.filter(
      (claim) => claim.field === "section.purpose" && claim.decision === "accepted",
    ).map((claim) => claim.value),
  );
  return PRECEDENCE.find((value) => values.has(value)) ?? null;
}
