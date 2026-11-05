import { TECHNOLOGY_ALIASES, canonicalizeTechnology } from "../awwwards.js";
import type { EvidenceBasis } from "./types.js";

export const ATLAS_VOCABULARY_VERSION = "atlas-vocabulary-3";

/** Canonical technology tokens accepted by declared/detected providers. */
export const TECHNOLOGY_ALLOWLIST: ReadonlySet<string> = new Set([
  ...Object.values(TECHNOLOGY_ALIASES),
  "html",
  "css3",
  "javascript",
  "typescript",
  "webgl",
  "canvas",
  "wordpress",
  "shopify",
  "webflow",
  "framer",
  "angularjs",
  "laravel",
  "django",
  "ruby-on-rails",
  "php",
  "python",
  "mysql",
  "postgresql",
  "supabase",
  "firebase",
  "contentful",
  "prismic",
  "sanity",
  "strapi",
  "woocommerce",
  "magento",
  "unity",
  "unreal-engine",
  "blender",
  "after-effects",
  "figma",
  "illustrator",
  "photoshop",
]);

function isTechnologyValue(value: string): boolean {
  const token = value.trim();
  if (!token) return false;
  return TECHNOLOGY_ALLOWLIST.has(canonicalizeTechnology(token.toLowerCase()));
}

export type VocabularySupport = "supported" | "reserved" | "dynamic" | "disabled";

export interface VocabularyEntry {
  field: string;
  value: string;
  label: string;
  support: VocabularySupport;
  enabled: boolean;
  searchable: boolean;
  permittedBases: EvidenceBasis[];
  ruleIds: string[];
  aliases: string[];
}

export interface VocabularyNamespace {
  field: string;
  support: "supported" | "dynamic";
  provider: string | null;
  values: readonly string[];
}

const inferredBases: EvidenceBasis[] = [
  "native_semantics",
  "declared_aria",
  "computed_style",
  "geometry",
  "rule_derivation",
  "human_review",
];

const sourceBases: EvidenceBasis[] = ["source_title", "source_metadata", "human_review"];

const sectionValues = [
  "announcement",
  "header",
  "navigation",
  "hero",
  "about",
  "features",
  "services",
  "process",
  "pricing",
  "product_listing",
  "product_showcase",
  "testimonials",
  "logos",
  "metrics",
  "team",
  "portfolio_gallery",
  "case_study",
  "editorial_content",
  "resource_list",
  "cta",
  "contact",
  "newsletter",
  "faq",
  "footer",
  "other",
  "unknown",
] as const;

const componentValues = [
  "link",
  "button",
  "icon_button",
  "navigation",
  "navigation_trigger",
  "breadcrumb",
  "card",
  "list",
  "table",
  "form",
  "text_input",
  "select",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "tabs",
  "disclosure",
  "dialog",
  "drawer",
  "tooltip",
  "carousel",
  "pagination",
  "alert",
  "progress",
  "media_player",
  "canvas",
] as const;

const reservedSections = new Set(["announcement", "product_listing", "product_showcase"]);
const reservedComponents = new Set([
  "carousel",
  "drawer",
  "tooltip",
  "alert",
  "progress",
  "media_player",
  "canvas",
]);

function entry(
  field: string,
  value: string,
  allowed: EvidenceBasis[],
  options: {
    enabled?: boolean;
    aliases?: string[];
    support?: VocabularySupport;
  } = {},
): VocabularyEntry {
  const support =
    options.support ?? (options.enabled === false ? "disabled" : "supported");
  const enabled =
    support === "supported" && (options.enabled ?? true);
  return {
    field,
    value,
    label: value.replaceAll("_", " "),
    support,
    enabled,
    searchable: enabled,
    permittedBases: allowed,
    ruleIds: [],
    aliases: options.aliases ?? [],
  };
}

export const ATLAS_VOCABULARY: readonly VocabularyEntry[] = [
  entry("source.title", "title", sourceBases),
  entry("page.purpose", "home", inferredBases),
  entry("page.purpose", "pricing", inferredBases),
  entry("page.purpose", "product", inferredBases),
  entry("page.purpose", "case_study", inferredBases),
  entry("page.purpose", "article", inferredBases),
  entry("page.purpose", "contact", inferredBases),
  entry("page.purpose", "signup", inferredBases),
  entry("page.purpose", "unknown", inferredBases, { support: "reserved" }),
  ...sectionValues.map((value) =>
    entry("section.purpose", value, inferredBases, {
      support:
        reservedSections.has(value) || value === "unknown" ? "reserved" : "supported",
    }),
  ),
  ...componentValues.map((value) =>
    entry("component.type", value, inferredBases, {
      support: reservedComponents.has(value) ? "reserved" : "supported",
    }),
  ),
  entry("appearance.surface", "dark", inferredBases, { aliases: ["treatment.surface:dark"] }),
  entry("appearance.surface", "light", inferredBases, { aliases: ["treatment.surface:light"] }),
  entry("appearance.surface", "mid", inferredBases),
  entry("appearance.surface", "mixed", inferredBases),
  entry("layout.pattern", "stack", inferredBases, { aliases: ["treatment.layout:stacked"] }),
  entry("layout.pattern", "split", inferredBases, { aliases: ["treatment.layout:split"] }),
  entry("layout.pattern", "grid", inferredBases, { aliases: ["treatment.layout:grid"] }),
  entry("layout.pattern", "full_bleed", inferredBases, {
    aliases: ["treatment.layout:full_bleed"],
  }),
  entry("behavior", "horizontal_scrollable", ["interaction_observation"]),
  entry("behavior", "sticky_observed", ["interaction_observation", "computed_style"]),
  entry("behavior", "hover_change_observed", ["interaction_observation"]),
  entry("behavior", "focus_visible_observed", ["interaction_observation"]),
  entry("rendering", "canvas_present", ["computed_style", "native_semantics"]),
  entry("rendering", "webgl_observed", ["interaction_observation", "computed_style"]),
  // Legacy treatment names remain registered but are not searchable; only
  // values with an exact layout.pattern/appearance.surface equivalent are
  // advertised as aliases (see the Phase 0 compatibility matrix).
  entry("treatment.layout", "grid", inferredBases, { support: "disabled" }),
  entry("treatment.layout", "split", inferredBases, { support: "disabled" }),
  entry("treatment.layout", "stacked", inferredBases, { support: "disabled" }),
  entry("treatment.layout", "asymmetric", inferredBases, { support: "disabled" }),
  entry("treatment.layout", "full_bleed", inferredBases, { support: "disabled" }),
  entry("treatment.layout", "horizontal_sequence", inferredBases, { support: "disabled" }),
  entry("treatment.surface", "dark", inferredBases, { support: "disabled" }),
  entry("treatment.surface", "light", inferredBases, { support: "disabled" }),
  entry("treatment.scroll", "sticky", inferredBases),
  entry("treatment.state", "open", [...inferredBases, "interaction_observation"]),
  entry("treatment.state", "closed", [...inferredBases, "interaction_observation"]),
  entry("treatment.state", "hover", [...inferredBases, "interaction_observation"]),
  entry("treatment.state", "focus", [...inferredBases, "interaction_observation"]),
];

const byKey = new Map<string, VocabularyEntry>(
  ATLAS_VOCABULARY.map((item) => [`${item.field}\u0000${item.value}`, item]),
);

/** Spec §8.6 searchable field registry, including dynamic providers. */
export const ATLAS_VOCABULARY_NAMESPACES: readonly VocabularyNamespace[] = [
  { field: "section.purpose", support: "supported", provider: null, values: sectionValues },
  { field: "component.type", support: "supported", provider: null, values: componentValues },
  {
    field: "context.section_purpose",
    support: "dynamic",
    provider: "section.purpose",
    values: [],
  },
  {
    field: "appearance.surface",
    support: "supported",
    provider: null,
    values: ["dark", "light", "mid", "mixed"],
  },
  {
    field: "layout.pattern",
    support: "supported",
    provider: null,
    values: ["stack", "split", "grid", "full_bleed"],
  },
  {
    field: "behavior",
    support: "supported",
    provider: null,
    values: [
      "horizontal_scrollable",
      "sticky_observed",
      "hover_change_observed",
      "focus_visible_observed",
    ],
  },
  {
    field: "rendering",
    support: "supported",
    provider: null,
    values: ["canvas_present", "webgl_observed"],
  },
  {
    field: "site.technology_declared",
    support: "dynamic",
    provider: "awwwards.technology",
    values: [],
  },
  {
    field: "page.technology_detected",
    support: "dynamic",
    provider: "fingerprint.technology",
    values: [],
  },
];

const namespaces = new Map(
  ATLAS_VOCABULARY_NAMESPACES.map((namespace) => [namespace.field, namespace]),
);

export function lookupVocabulary(field: string, value: string): VocabularyEntry | null {
  return byKey.get(`${field}\u0000${value}`) ?? null;
}

export function lookupVocabularyNamespace(field: string): VocabularyNamespace | null {
  return namespaces.get(field) ?? null;
}

export function isSearchableVocabulary(field: string, value: string): boolean {
  const item = lookupVocabulary(field, value);
  if (item) return Boolean(item.enabled && item.searchable);
  const namespace = namespaces.get(field);
  if (!namespace || namespace.support !== "dynamic" || !value.trim()) return false;
  // Provider-backed fields are validated by their provider at query time.
  // Context purposes delegate to the section vocabulary so unsupported values
  // stay non-searchable.
  if (namespace.provider === "section.purpose") {
    return isSearchableVocabulary("section.purpose", value);
  }
  if (
    namespace.provider === "awwwards.technology" ||
    namespace.provider === "fingerprint.technology"
  ) {
    return isTechnologyValue(value);
  }
  return false;
}

export const SECTION_PURPOSES = sectionValues;
export const COMPONENT_TYPES = componentValues;
