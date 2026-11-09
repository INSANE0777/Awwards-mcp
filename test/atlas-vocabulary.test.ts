import { describe, expect, it } from "vitest";
import {
  ATLAS_VOCABULARY,
  ATLAS_VOCABULARY_NAMESPACES,
  isSearchableVocabulary,
  lookupVocabulary,
  lookupVocabularyNamespace,
} from "../src/atlas/vocabulary.js";

describe("atlas vocabulary", () => {
  it("has unique field/value keys and at least one permitted basis", () => {
    const keys = ATLAS_VOCABULARY.map((entry) => `${entry.field}\u0000${entry.value}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ATLAS_VOCABULARY.every((entry) => entry.permittedBases.length > 0)).toBe(true);
  });

  it("keeps reserved or unknown values out of search", () => {
    expect(isSearchableVocabulary("section.purpose", "hero")).toBe(true);
    expect(isSearchableVocabulary("section.purpose", "announcement")).toBe(false);
    expect(isSearchableVocabulary("section.purpose", "unknown")).toBe(false);
    expect(isSearchableVocabulary("component.type", "carousel")).toBe(true);
    expect(isSearchableVocabulary("component.type", "drawer")).toBe(true);
    expect(isSearchableVocabulary("component.type", "button")).toBe(true);
  });

  it("registers the required appearance and layout namespaces", () => {
    for (const value of ["dark", "light", "mid", "mixed"]) {
      expect(isSearchableVocabulary("appearance.surface", value), value).toBe(true);
    }
    for (const value of ["stack", "split", "grid", "full_bleed"]) {
      expect(isSearchableVocabulary("layout.pattern", value), value).toBe(true);
    }
    expect(isSearchableVocabulary("treatment.surface", "dark")).toBe(false);
    expect(isSearchableVocabulary("treatment.layout", "stacked")).toBe(false);
    expect(lookupVocabulary("appearance.surface", "dark")?.aliases).toEqual([
      "treatment.surface:dark",
    ]);
    expect(lookupVocabulary("layout.pattern", "stack")?.aliases).toEqual([
      "treatment.layout:stacked",
    ]);
  });

  it("declares every spec §8.6 namespace with an explicit support state", () => {
    const required = [
      "section.purpose",
      "component.type",
      "context.section_purpose",
      "appearance.surface",
      "layout.pattern",
      "behavior",
      "rendering",
      "site.technology_declared",
      "page.technology_detected",
    ];
    expect(ATLAS_VOCABULARY_NAMESPACES.map((namespace) => namespace.field).sort()).toEqual(
      required.sort(),
    );
    for (const namespace of ATLAS_VOCABULARY_NAMESPACES) {
      if (namespace.support === "dynamic") {
        expect(namespace.provider, namespace.field).toBeTruthy();
        expect(namespace.values).toEqual([]);
      } else {
        expect(namespace.provider, namespace.field).toBeNull();
        for (const value of namespace.values) {
          const entry = lookupVocabulary(namespace.field, value);
          expect(entry, `${namespace.field}:${value}`).not.toBeNull();
          expect(entry?.searchable, `${namespace.field}:${value}`).toBe(
            entry?.support === "supported",
          );
        }
      }
    }
    expect(lookupVocabularyNamespace("context.section_purpose")?.provider).toBe("section.purpose");
    expect(lookupVocabularyNamespace("site.technology_declared")?.provider).toBe(
      "awwwards.technology",
    );
    expect(lookupVocabularyNamespace("page.technology_detected")?.provider).toBe(
      "fingerprint.technology",
    );
  });

  it("keeps reserved, disabled and unsupported dynamic values non-searchable", () => {
    for (const value of [
      "horizontal_scrollable",
      "sticky_observed",
      "hover_change_observed",
      "focus_visible_observed",
    ]) {
      expect(isSearchableVocabulary("behavior", value), value).toBe(true);
    }
    for (const value of ["canvas_present", "webgl_observed"]) {
      expect(isSearchableVocabulary("rendering", value), value).toBe(true);
    }
    expect(isSearchableVocabulary("behavior", "not_a_behavior")).toBe(false);
    expect(isSearchableVocabulary("rendering", "not_rendering")).toBe(false);
    expect(isSearchableVocabulary("section.purpose", "announcement")).toBe(false);
    expect(lookupVocabulary("section.purpose", "announcement")?.support).toBe("reserved");
    expect(lookupVocabulary("treatment.surface", "dark")?.support).toBe("disabled");
    expect(isSearchableVocabulary("context.section_purpose", "hero")).toBe(true);
    expect(isSearchableVocabulary("context.section_purpose", "announcement")).toBe(false);
    expect(isSearchableVocabulary("site.technology_declared", "GSAP")).toBe(true);
    expect(isSearchableVocabulary("site.technology_declared", "three.js")).toBe(true);
    expect(isSearchableVocabulary("site.technology_declared", "not-a-real-technology")).toBe(
      false,
    );
    expect(isSearchableVocabulary("site.technology_declared", "")).toBe(false);
    expect(isSearchableVocabulary("page.technology_detected", "three.js")).toBe(true);
    expect(isSearchableVocabulary("page.technology_detected", "webgl")).toBe(true);
    expect(isSearchableVocabulary("page.technology_detected", "not-a-real-technology")).toBe(
      false,
    );
  });

  it("returns null for unregistered field/value pairs", () => {
    expect(lookupVocabulary("section.purpose", "hero")?.label).toBe("hero");
    expect(lookupVocabulary("user.supplied", "anything")).toBeNull();
    expect(lookupVocabulary("section.purpose", "not-a-purpose")).toBeNull();
  });
});
