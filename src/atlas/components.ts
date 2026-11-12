import { stableHash } from "./identity.js";
import type {
  AtlasClaim,
  AtlasClassificationRegistry,
  AtlasScanComponent,
  AtlasPageScan,
  ComponentCandidate,
  ComponentEvidence,
  PatternMembership,
} from "./live-types.js";
import { ATLAS_VOCABULARY } from "./vocabulary.js";

export const ATLAS_COMPONENT_RULE_VERSION = "atlas-component-rules-1";
export const COMPONENT_CAP = 120;
export const COMPONENT_PACK_CAP = 12;
export const COMPONENT_PACK_NODE_CAP = 150;
export const COMPONENT_PACK_DEPTH_CAP = 12;

/** Component types that require structure beyond a native/declared element. */
export const ATLAS_INFERRED_COMPONENT_TYPES = [
  "card",
  "drawer",
  "carousel",
  "icon_button",
  "tooltip",
] as const;

const INFERRED_TYPES: ReadonlySet<string> = new Set(ATLAS_INFERRED_COMPONENT_TYPES);

function enabled(registry: AtlasClassificationRegistry, value: string): boolean {
  return registry.some(
    (entry) => entry.field === "component.type" && entry.value === value && entry.enabled,
  );
}

function contextPurposeEnabled(
  registry: AtlasClassificationRegistry,
  value: string,
): boolean {
  return registry.some(
    (entry) =>
      entry.field === "section.purpose" && entry.value === value && entry.enabled,
  );
}

function hasLabel(component: AtlasScanComponent): boolean {
  return component.label.trim().length > 0;
}

/**
 * Refines the DOM/ARIA hint into a component type without turning structure
 * into behavior. A dialog-like element with off-canvas structure is an inferred
 * drawer, never an observed open drawer; a button with an icon is an inferred
 * icon button. A declared state is never emitted here.
 */
export function discoverComponents(scan: AtlasPageScan): ComponentCandidate[] {
  const raws = Array.isArray(scan.components) ? scan.components.slice(0, COMPONENT_CAP) : [];
  return raws.map((component, index) => {
    let type = component.hint;
    let classification: ComponentCandidate["typeClassification"] =
      component.hintBasis === "rule_derivation" ? "inferred" : "observed";
    let basis: ComponentCandidate["typeBasis"] = component.hintBasis;
    let decision: ComponentCandidate["typeDecision"] = "accepted";
    let ruleId = `component.${component.hintBasis}.${component.hint}`;

    if (type === "dialog" && (component.position === "fixed" || component.position === "absolute")) {
      // Only off-canvas geometry proves a drawer-like surface. A transformed
      // but on-screen dialog is still just a declared dialog.
      if (component.offCanvas || component.offscreen) {
        type = "drawer";
        classification = "inferred";
        basis = "rule_derivation";
        ruleId = "component.structure.drawer.offcanvas";
      }
    }
    if (type === "button" && !hasLabel(component) && component.hasIcon) {
      type = "icon_button";
      classification = "inferred";
      basis = "rule_derivation";
      ruleId = "component.structure.icon-button";
    }
    if (type === "navigation_trigger") {
      // A declared trigger is accepted only when aria-controls resolves to a
      // real element; an unresolved declaration stays a candidate.
      if (component.ariaControlsResolved) {
        decision = "accepted";
        ruleId = "component.aria.navigation-trigger.resolved";
      } else {
        decision = "candidate";
        ruleId = "component.aria.navigation-trigger.unresolved";
      }
    }
    if (INFERRED_TYPES.has(type)) {
      classification = "inferred";
      // Structural hints have no held-out precision evidence yet; they never
      // satisfy accepted or observed_only search.
      decision = "candidate";
    }
    // Effective visibility: an element is usable only when it is rendered,
    // on-canvas and not entirely clipped away by an ancestor.
    if (
      !component.visible ||
      component.offscreen ||
      component.offCanvas ||
      component.fullyClipped
    ) {
      decision = "candidate";
      if (!INFERRED_TYPES.has(type) && type !== "navigation_trigger") {
        ruleId = "component.visibility.hidden";
      }
    }

    const key = stableHash(
      "component-live-v1",
      component.nodeKey,
      component.selector,
      type,
    );
    const candidate: ComponentCandidate = {
      key,
      ordinal: index,
      scanIndex: index,
      nodeKey: component.nodeKey,
      selector: component.selector,
      tag: component.tag,
      role: component.role,
      inputType: component.inputType ?? null,
      ariaHasPopup: component.ariaHasPopup === true,
      ariaExpanded: component.ariaExpanded ?? null,
      ariaControlsResolved: component.ariaControlsResolved === true,
      inNavigation: component.inNavigation === true,
      ariaLabel: component.ariaLabel ?? null,
      type,
      typeClassification: classification,
      typeBasis: basis,
      typeDecision: decision,
      typeRuleId: ruleId,
      label: component.label,
      visible: component.visible,
      offscreen: component.offscreen,
      sectionNodeKey: component.sectionNodeKey,
      sectionKey: null,
      patternKey: "",
      rect: component.rect,
      depth: component.depth,
      pack: component.pack,
    };
    candidate.patternKey = componentPatternKey(candidate, raws[index]);
    return candidate;
  });
}

/**
 * Pattern identity contains only structure, layout and selected computed
 * values. Text, image URLs and arbitrary class names never enter the key.
 */
export function componentPatternKey(
  component: Pick<ComponentCandidate, "type" | "sectionKey" | "sectionNodeKey">,
  raw?: Pick<
    AtlasScanComponent,
    | "shape"
    | "childCounts"
    | "display"
    | "gap"
    | "padding"
    | "radius"
    | "fontFamily"
    | "fontSize"
    | "fontWeight"
    | "lineHeight"
  > | null,
  /** Capture-local scope (site/page/viewport) so equal structures never merge across sites. */
  scope = "",
): string {
  const section = component.sectionKey ?? component.sectionNodeKey ?? "none";
  return stableHash(
    "component-pattern-v1",
    scope,
    component.type,
    section,
    raw?.shape ?? "",
    raw?.childCounts ?? "",
    raw?.display ?? "",
    raw?.gap ?? "",
    raw?.padding ?? "",
    raw?.radius ?? "",
    raw?.fontFamily ?? "",
    raw?.fontSize ?? "",
    raw?.fontWeight ?? "",
    raw?.lineHeight ?? "",
  );
}

/** Groups repeated component patterns within one capture. */
export function groupComponentPatterns(
  components: ComponentCandidate[],
): PatternMembership[] {
  const groups = new Map<string, PatternMembership>();
  for (const component of components) {
    const key = component.patternKey || componentPatternKey(component);
    const group = groups.get(key) ?? { key, memberKeys: [], count: 0 };
    group.memberKeys.push(component.key);
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => left.key.localeCompare(right.key));
}

/**
 * Emits component.type from the structural type only, plus
 * context.section_purpose from accepted containing-section purposes. No
 * behavior/state claim is produced here.
 */
export function classifyComponents(
  input: ComponentEvidence | ComponentEvidence[],
  registry: AtlasClassificationRegistry = ATLAS_VOCABULARY,
): AtlasClaim[] {
  const evidence = Array.isArray(input) ? input : [input];
  const claims: AtlasClaim[] = [];
  for (const item of evidence) {
    const candidate = item.candidate;
    if (!enabled(registry, candidate.type)) continue;
    const artifactKey = item.packArtifactKey ?? item.artifactKey;
    if (!artifactKey) continue;
    const sampleKey = `${item.viewport}:${candidate.key}`;
    const componentRef = {
      artifactId: artifactKey,
      pointer: item.packArtifactKey ? "/nodes/0" : `/scan/components/${candidate.scanIndex}`,
      sampleKey,
    };
    const refs = [componentRef];
    // An inferred type is a structural hint, never accepted evidence.
    const typeDecision =
      candidate.typeClassification === "inferred" ? "candidate" : candidate.typeDecision;
    claims.push({
      regionKey: candidate.key,
      field: "component.type",
      value: candidate.type,
      decision: typeDecision,
      classification: candidate.typeClassification,
      basis: candidate.typeBasis,
      ruleId: candidate.typeRuleId,
      ruleVersion: ATLAS_COMPONENT_RULE_VERSION,
      sampleKey,
      evidence: refs,
    });
    // The context claim is supported by the containing section's scan entry,
    // not by the component: resolve sectionNodeKey to its scan index.
    const sectionIndex =
      item.scan && candidate.sectionNodeKey
        ? item.scan.sections.findIndex((section) => section.nodeKey === candidate.sectionNodeKey)
        : -1;
    if (sectionIndex < 0 || !item.artifactKey) continue;
    const sectionRef = {
      artifactId: item.artifactKey,
      pointer: `/scan/sections/${sectionIndex}`,
      sampleKey,
    };
    for (const purpose of [...new Set(item.sectionPurposes ?? [])]) {
      if (!contextPurposeEnabled(registry, purpose)) continue;
      claims.push({
        regionKey: candidate.key,
        field: "context.section_purpose",
        value: purpose,
        decision: "accepted",
        classification: "inferred",
        basis: "rule_derivation",
        ruleId: "context.section_purpose.accepted",
        ruleVersion: ATLAS_COMPONENT_RULE_VERSION,
        sampleKey,
        evidence: [sectionRef, componentRef],
      });
    }
  }
  return claims;
}
