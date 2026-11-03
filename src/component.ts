import { installSnippetShims, preScroll } from "./structure.js";
import { resolveViewport, type ViewportName } from "./viewport.js";

/** One node of the serialized component tree (plain data, page-serializable). */
export interface ComponentNode {
  tag: string;
  classes: string[];
  rect: { x: number; y: number; w: number; h: number };
  /** Bounded computed-style subset (resolved STYLE_PROPS keys). */
  styles: Record<string, string>;
  /** Leaf text, ≤200 chars (slot candidate). */
  text?: string;
  imgSrc?: string;
  imgW?: number;
  imgH?: number;
  /** outerHTML for svg elements, ≤20KB. */
  svg?: string;
  /** Element animations ≤10 per node, timing from effect.getTiming(). */
  anims?: { props: string[]; durationMs: number | null; easing: string | null }[];
  /** Captured ::before/::after (only when content is set; ≤2 per node). */
  pseudos?: { kind: "before" | "after"; content: string; styles: Record<string, string> }[];
  children: ComponentNode[];
}

/** Reduced capture pack for one component. */
export interface ComponentPack {
  id: "component-pack-v1";
  url: string;
  selector: string;
  capturedAt: number;
  viewport: { width: number; height: number };
  nodeCount: number;
  /** True when maxDepth stopped the walk before serializing every child. */
  depthCapped?: boolean;
  root: ComponentNode;
  fonts: string[];
  colors: string[];
}

/** What page.evaluate(COMPONENT_SNIPPET) serializes back from the page. */
export interface RawComponentScan {
  notFound: boolean;
  selector: string;
  nodeCount: number;
  /** True when maxDepth stopped the walk before serializing every child. */
  depthCapped?: boolean;
  fonts: string[];
  colors: string[];
  root: ComponentNode | null;
}

export interface CaptureComponentOptions {
  selector?: string;
  timeoutMs?: number;
  viewport?: ViewportName;
  /** Max nodes the in-page walk may serialize (default 400; clamp lives in the reducer 50..2000). */
  maxNodes?: number;
  /** Max serialized tree depth, root = 0 (clamped 0..64; 0/undefined = unlimited). */
  maxDepth?: number;
  loader?: () => Promise<any>;
  /** Route every browser connection through this loopback guard proxy. */
  proxyServer?: string;
}

/** Bounded computed-style subset collected per node (brief Step 3 list). */
type StyleProp =
  | "display" | "position" | "flexDirection" | "gridTemplateColumns" | "gap" | "padding"
  | "margin" | "width" | "height" | "background" | "backgroundColor" | "color"
  | "fontFamily" | "fontSize" | "fontWeight" | "lineHeight" | "letterSpacing"
  | "textTransform" | "borderRadius" | "boxShadow" | "border" | "transform"
  | "transition" | "opacity" | "overflow" | "zIndex"
  | "left" | "top" | "right" | "bottom"
  | "backgroundImage" | "backgroundSize" | "backgroundPosition"
  | "alignItems" | "justifyContent" | "flexWrap" | "textAlign"
  | "minHeight" | "maxHeight" | "minWidth" | "maxWidth"
  | "filter" | "backdropFilter" | "objectFit" | "aspectRatio";

// Runs IN THE PAGE via page.evaluate(COMPONENT_SNIPPET, { selector, maxNodes, maxDepth }).
// Plain `function` expression (no arrow — page.evaluate re-serializes the
// source) with zero outer references, browser globals through globalThis (Node
// tsconfig has no DOM lib), every probe try/caught. Mirrors POSE_SNIPPET
// (pose3d.ts) and SCROLL_CENSUS_SNIPPET (census.ts). Depth-first walk with an
// explicit counter; stops enqueueing children past maxNodes or maxDepth so the
// returned tree is bounded. Fonts/colors collect into Sets at the root during
// the walk.
export const COMPONENT_SNIPPET = function (arg: { selector: string; maxNodes: number; maxDepth?: number }): RawComponentScan {
  const g = globalThis as any;
  const doc = g.document;
  // Declared INSIDE the snippet: page.evaluate serializes the function source
  // only — module-scope constants would be undefined in the page.
  const STYLE_PROPS: StyleProp[] = [
    "display", "position", "flexDirection", "gridTemplateColumns", "gap", "padding",
    "margin", "width", "height", "background", "backgroundColor", "color",
    "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
    "textTransform", "borderRadius", "boxShadow", "border", "transform",
    "transition", "opacity", "overflow", "zIndex",
    "left", "top", "right", "bottom",
    "backgroundImage", "backgroundSize", "backgroundPosition",
    "alignItems", "justifyContent", "flexWrap", "textAlign",
    "minHeight", "maxHeight", "minWidth", "maxWidth",
    "filter", "backdropFilter", "objectFit", "aspectRatio",
  ];
  // In-page safety clamp: the reducer clamps 50..2000 too, but a hostile arg
  // must not explode the walk before the pack ever reaches the reducer.
  const maxNodes = Math.max(1, Math.min(2000, (arg && arg.maxNodes) || 400));
  // Depth budget: 0/undefined = unlimited; otherwise clamp 0..64. Callers that
  // must cross Code Mode's depth cap (v2 capture_page) pass 12.
  const rawDepth = arg && arg.maxDepth ? Math.floor(Number(arg.maxDepth)) : 0;
  const maxDepth = Number.isFinite(rawDepth) ? Math.max(0, Math.min(64, rawDepth)) : 0;
  const fonts: string[] = [];
  const colors: string[] = [];
  let count = 0;
  let depthCapped = false;

  function addFont(v: unknown): void {
    try {
      const s = String(v);
      if (s && fonts.indexOf(s) === -1) fonts.push(s);
    } catch {}
  }
  function addColor(v: unknown): void {
    try {
      const s = String(v);
      if (s && colors.indexOf(s) === -1) colors.push(s);
    } catch {}
  }

  // Bounded computed-style subset; each probe try/caught, undefined skipped.
  // Pseudo arg (::before/::after) reuses the same STYLE_PROPS list; the fonts
  // and colors harvested inside also feed the pack's sets (requirement 2).
  function stylesOf(el: any, pseudo?: string): Record<string, string> {
    const out: Record<string, string> = {};
    let s: any = null;
    try {
      s = pseudo ? g.getComputedStyle(el, pseudo) : g.getComputedStyle(el);
    } catch {}
    if (!s) return out;
    for (let i = 0; i < STYLE_PROPS.length; i++) {
      const p = STYLE_PROPS[i];
      try {
        const v = s[p];
        if (v === undefined || v === null || v === "") continue;
        if (p === "color" || p === "backgroundColor" || p === "background") {
          addColor(v);
          if (v !== "none") out[p] = String(v);
        } else if (p === "fontFamily") {
          addFont(v);
          if (v !== "none") out[p] = String(v);
        } else if (v !== "none") {
          out[p] = String(v);
        }
      } catch {}
    }
    return out;
  }

  // ::before/::after, ≤2 per node: captured only when a real content value is
  // set (the marker of an intentional decorative pseudo-element). Each probe
  // try/caught; the style fetch reuses stylesOf with the pseudo arg.
  function pseudosOf(el: any): { kind: "before" | "after"; content: string; styles: Record<string, string> }[] {
    const rows: { kind: "before" | "after"; content: string; styles: Record<string, string> }[] = [];
    try {
      const cs = g.getComputedStyle(el, "::before");
      if (cs.content && cs.content !== "none" && cs.content !== "normal") {
        rows.push({ kind: "before", content: String(cs.content), styles: stylesOf(el, "::before") });
      }
    } catch {}
    try {
      const cs = g.getComputedStyle(el, "::after");
      if (cs.content && cs.content !== "none" && cs.content !== "normal") {
        rows.push({ kind: "after", content: String(cs.content), styles: stylesOf(el, "::after") });
      }
    } catch {}
    return rows;
  }

  // ≤10 element animations per node: props from transitionProperty (transitions)
  // or the animationName flag (keyframes), timing from effect.getTiming().
  function animsOf(el: any): { props: string[]; durationMs: number | null; easing: string | null }[] {
    const rows: { props: string[]; durationMs: number | null; easing: string | null }[] = [];
    try {
      const anims = el.getAnimations ? el.getAnimations({ subtree: false }) : [];
      for (let i = 0; i < anims.length && i < 10; i++) {
        try {
          const a = anims[i];
          const effect = a && a.effect;
          // CSSTransition exposes the animated property on a.propertyName
          // (transitionProperty is not a real accessor); CSSAnimation keeps
          // animationName. Undefined-safe, dropped when both probes miss.
          let props: string[] = [];
          try {
            const tp = a.propertyName ?? a.transitionProperty;
            if (tp && tp !== "all") props = String(tp).split(/\s+/).filter(Boolean);
          } catch {}
          if (props.length === 0) {
            try {
              const an = a.animationName;
              if (an && an !== "none") props = ["animationName"];
            } catch {}
          }
          if (props.length === 0) continue;
          let durationMs: number | null = null;
          let easing: string | null = null;
          try {
            const timing = effect && effect.getTiming ? effect.getTiming() : null;
            if (timing) {
              if (typeof timing.duration === "number") durationMs = timing.duration;
              if (timing.easing) easing = String(timing.easing);
            }
          } catch {}
          rows.push({ props: props, durationMs: durationMs, easing: easing });
        } catch {}
      }
    } catch {}
    return rows;
  }

  // Text inside a hidden or CSS-unrendered subtree is not visible page copy.
  // aria-hidden/inert remove content from AT or interaction, not from the
  // rendered page, so they must not suppress visible text. Ancestors count.
  function hiddenFromAT(el: any): boolean {
    let cur = el;
    for (let i = 0; cur && i < 100; i++) {
      try {
        if (cur.hasAttribute && cur.hasAttribute("hidden")) return true;
        const cs = getComputedStyle(cur);
        if (!cs) return false;
        if (cs.display === "none") return true;
        if (cs.visibility === "hidden" || cs.visibility === "collapse") return true;
      } catch {}
      cur = cur.parentElement;
    }
    return false;
  }

  function ser(el: any): ComponentNode | null {
    if (count >= maxNodes) return null;
    count++;
    const node: any = { tag: "*", classes: [], rect: { x: 0, y: 0, w: 0, h: 0 }, styles: {}, children: [] };
    try {
      node.tag = String(el.tagName || "*").toLowerCase();
    } catch {}
    try {
      const cl = el.classList;
      if (cl) {
        for (let i = 0; i < cl.length; i++) node.classes.push(String(cl[i]));
      }
    } catch {}
    try {
      const r = el.getBoundingClientRect();
      node.rect = { x: r.x, y: r.y, w: r.width, h: r.height };
    } catch {}
    node.styles = stylesOf(el);
    try {
      const ps = pseudosOf(el);
      if (ps.length > 0) node.pseudos = ps; // absent = none (lean packs)
    } catch {}
    try {
      if (!el.children || el.children.length === 0) {
        if (!hiddenFromAT(el)) {
          const t = el.textContent;
          if (t && t.trim()) node.text = String(t).trim().slice(0, 200);
        }
      }
    } catch {}
    try {
      if (node.tag === "img") {
        try { node.imgSrc = String(el.currentSrc || el.src || ""); } catch {}
        try { node.imgW = el.naturalWidth; } catch {}
        try { node.imgH = el.naturalHeight; } catch {}
      } else if (node.tag === "svg") {
        try { node.svg = String(el.outerHTML).slice(0, 20000); } catch {}
      }
    } catch {}
    node.anims = animsOf(el);
    return node;
  }

  function walk(el: any, depth: number): ComponentNode | null {
    const node = ser(el);
    if (!node) return null;
    try {
      const kids = el.children ? Array.from(el.children) : [];
      // At the depth limit the node is kept but its children are omitted.
      if (maxDepth > 0 && depth >= maxDepth) {
        if (kids.length > 0) depthCapped = true;
        return node;
      }
      if (count < maxNodes) {
        for (let i = 0; i < kids.length; i++) {
          if (count >= maxNodes) break;
          const sub = walk(kids[i], depth + 1);
          if (sub) node.children.push(sub);
        }
      }
    } catch {}
    return node;
  }

  let root: ComponentNode | null = null;
  let usedSelector = arg && arg.selector ? String(arg.selector) : "header";
  try {
    const el = doc.querySelector(usedSelector);
    if (el) root = walk(el, 0);
  } catch {}

  return {
    notFound: !root,
    selector: usedSelector,
    nodeCount: count,
    depthCapped: depthCapped,
    fonts: fonts,
    colors: colors,
    root: root,
  };
};

// PURE: stamps id/viewport/nodeCount and dedupes+sorts fonts/colors. Truncates
// the raw tree at maxNodes (clamped 50..2000) with a recursive counter so
// nodeCount always equals the nodes actually kept.
export function reduceComponent(
  input: {
    url: string;
    capturedAt: number;
    selector: string;
    viewport: { width: number; height: number };
    scan: RawComponentScan;
  },
  maxNodes = 400,
): ComponentPack | { error: string } {
  const cap = Math.min(2000, Math.max(50, maxNodes));
  if (!input.scan || input.scan.notFound || !input.scan.root) {
    return { error: "selector not found: " + input.selector };
  }
  // Fonts/colors are collected in-page by the snippet; the reducer only
  // dedupes+sorts the scan's collected values — plus anything harvestable
  // from captured pseudo styles (fake/manual snippet output may include them
  // without the in-page sets having run).
  const fonts = new Set<string>(input.scan.fonts ?? []);
  const colors = new Set<string>(input.scan.colors ?? []);
  function harvestPseudo(node: ComponentNode): void {
    if (node.pseudos) {
      for (const p of node.pseudos) {
        const ff = p.styles["fontFamily"];
        if (ff) fonts.add(ff);
        for (const key of ["color", "backgroundColor", "background"]) {
          const cv = p.styles[key];
          if (cv && cv !== "none") colors.add(cv);
        }
      }
    }
    for (const child of node.children) harvestPseudo(child);
  }
  harvestPseudo(input.scan.root);
  let nodeCount = 0;

  // Keeps `node` plus as much of its subtree as `budget` allows; prunes
  // children lists at the cap (truncation, never a crash). Returns budget left.
  function keep(node: ComponentNode, budget: number): number {
    nodeCount++;
    let rem = budget - 1;
    if (rem <= 0) {
      node.children = [];
      return rem;
    }
    const kept: ComponentNode[] = [];
    for (const child of node.children) {
      if (rem <= 0) break;
      kept.push(child);
      rem = keep(child, rem);
    }
    node.children = kept;
    return rem;
  }

  keep(input.scan.root, cap);
  return {
    id: "component-pack-v1",
    url: input.url,
    selector: input.selector,
    capturedAt: input.capturedAt,
    viewport: input.viewport,
    nodeCount: nodeCount,
    // Only surfaced when true: old packs keep their exact shape.
    ...(input.scan.depthCapped ? { depthCapped: true } : {}),
    root: input.scan.root,
    fonts: Array.from(fonts).sort(),
    colors: Array.from(colors).sort(),
  };
}

/** One captured value and how many nodes used it. */
export interface ValueCount {
  value: string;
  count: number;
}

/** Typography usage distilled from the pack's computed styles (top 12 each). */
export interface TypographySummary {
  sampled: number;
  families: ValueCount[];
  sizes: ValueCount[];
  weights: ValueCount[];
  lineHeights: ValueCount[];
  letterSpacings: ValueCount[];
}

/** Deduped colour usage from node styles + pack.colors (top 24). */
export interface PaletteSummary {
  colors: ValueCount[];
  junkFiltered: number;
}

const TOP_TYPO_VALUES = 12;
const TOP_PALETTE_VALUES = 24;
const PALETTE_KEYS = ["color", "backgroundColor"];

function topCounts(counts: Map<string, number>, limit: number): ValueCount[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

// Counts one occurrence per node that carries the property (not per property
// byte); returns the number of nodes walked so summaries can state coverage.
function eachNode(root: ComponentNode, fn: (node: ComponentNode) => void): number {
  let sampled = 0;
  const walk = (node: ComponentNode): void => {
    sampled++;
    fn(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return sampled;
}

export function summarizeTypography(pack: ComponentPack): TypographySummary {
  const families = new Map<string, number>();
  const sizes = new Map<string, number>();
  const weights = new Map<string, number>();
  const lineHeights = new Map<string, number>();
  const letterSpacings = new Map<string, number>();
  const add = (map: Map<string, number>, raw: string | undefined): void => {
    const value = raw?.trim();
    if (!value) return;
    map.set(value, (map.get(value) ?? 0) + 1);
  };
  const sampled = eachNode(pack.root, (node) => {
    add(families, node.styles["fontFamily"]);
    add(sizes, node.styles["fontSize"]);
    add(weights, node.styles["fontWeight"]);
    add(lineHeights, node.styles["lineHeight"]);
    add(letterSpacings, node.styles["letterSpacing"]);
  });
  return {
    sampled,
    families: topCounts(families, TOP_TYPO_VALUES),
    sizes: topCounts(sizes, TOP_TYPO_VALUES),
    weights: topCounts(weights, TOP_TYPO_VALUES),
    lineHeights: topCounts(lineHeights, TOP_TYPO_VALUES),
    letterSpacings: topCounts(letterSpacings, TOP_TYPO_VALUES),
  };
}

// Palette values must be pure colour tokens. Computed `background` shorthand
// (e.g. "rgb(1, 2, 3) none repeat scroll ...") and gradients/images are not
// colours and must not be ranked as palette entries.
const NAMED_NON_COLORS = new Set([
  "none",
  "transparent",
  "auto",
  "initial",
  "inherit",
  "unset",
  "revert",
  "currentcolor",
]);

function isColorValue(value: string): boolean {
  const s = value.trim();
  const lower = s.toLowerCase();
  if (NAMED_NON_COLORS.has(lower)) return false;
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return true;
  if (/^(?:rgb|rgba|hsl|hsla)\([^()]*\)$/i.test(s)) return true;
  // Bare CSS colour keyword (rebeccapurple, tomato, ...). Reject anything with
  // spaces or punctuation that is not one of the function forms above.
  return /^[a-z]+$/i.test(s);
}

function hexAlphaZero(s: string): boolean {
  const m = /^#([0-9a-f]{4}|[0-9a-f]{8})$/i.exec(s);
  if (!m) return false;
  const hex = m[1]!;
  const alpha = hex.length === 4 ? hex.slice(3) : hex.slice(6);
  return /^0+$/.test(alpha);
}

// `none`/`transparent`/non-colour strings and any alpha-0 colour are noise.
export function isJunkColor(value: string): boolean {
  if (!isColorValue(value)) return true;
  const s = value.trim().toLowerCase();
  if (hexAlphaZero(s)) return true;
  const m = /^(?:rgba?|hsla?)\(([^)]*)\)$/.exec(s);
  if (!m) return false;
  const parts = m[1].replace(/\//g, " ").split(/[\s,]+/).filter(Boolean);
  const alphaRaw = parts.length >= 4 ? parts[3]! : "1";
  const alpha = alphaRaw.endsWith("%") ? parseFloat(alphaRaw) / 100 : parseFloat(alphaRaw);
  return alpha === 0;
}

export function summarizePalette(pack: ComponentPack): PaletteSummary {
  const colors = new Map<string, number>();
  let junkFiltered = 0;
  const add = (raw: string | undefined): void => {
    const value = raw?.trim();
    if (!value) return;
    if (isJunkColor(value)) {
      junkFiltered++;
      return;
    }
    colors.set(value, (colors.get(value) ?? 0) + 1);
  };
  eachNode(pack.root, (node) => {
    for (const key of PALETTE_KEYS) add(node.styles[key]);
  });
  // The in-page sets are a deduped union; only values not already counted in
  // node styles contribute one (a pseudo-harvested color, typically).
  for (const raw of pack.colors) {
    const value = raw.trim();
    if (!value) continue;
    if (isJunkColor(value)) {
      junkFiltered++;
      continue;
    }
    if (!colors.has(value)) colors.set(value, 1);
  }
  return { colors: topCounts(colors, TOP_PALETTE_VALUES), junkFiltered };
}

// Captures one component subtree: house lifecycle (shims → goto → settle →
// preScroll → back to top → 500ms so entrance animations land and the
// component is at rest) then one COMPONENT_SNIPPET evaluate. Mirrors
// capturePose3d (pose3d.ts). Not-found is an error contract, not a throw.
export async function captureComponent(
  url: string,
  opts?: CaptureComponentOptions,
): Promise<ComponentPack | { error: string }> {
  let chrome: any;
  try {
    // Lazy default: playwright is only touched when the tool actually runs.
    const loader = opts?.loader ?? (() => import("playwright" as string));
    ({ chromium: chrome } = await loader());
    const browser = await chrome.launch(
      opts?.proxyServer
        ? { proxy: { server: opts.proxyServer, bypass: "<-loopback>" } }
        : {},
    );
    try {
      // Viewport profile split as in structure.ts: width/height fill the
      // `viewport` key; mobile-profile flags are sibling context options.
      const { width, height, ...contextOpts } = resolveViewport(opts?.viewport ?? "desktop");
      const page = await browser.newPage({ viewport: { width, height }, ...contextOpts });
      await installSnippetShims(page);
      await page.goto(url, { waitUntil: "load", timeout: opts?.timeoutMs ?? 45_000 });
      // "load" can fire before late XHRs settle; fixed settle window.
      await page.waitForTimeout(3000);
      await preScroll(page);
      try {
        await page.evaluate(function () {
          try {
            (globalThis as any).scrollTo(0, 0);
          } catch {}
        });
      } catch {}
      // 500ms after returning to top: entrance animations fire and the
      // component is at rest before serialization.
      await page.waitForTimeout(500);
      const arg = {
        selector: opts?.selector ?? "header",
        maxNodes: opts?.maxNodes ?? 400,
        ...(opts?.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
      };
      const scan = (await page.evaluate(COMPONENT_SNIPPET, arg)) as RawComponentScan;
      return reduceComponent(
        { url: url, capturedAt: Date.now(), selector: arg.selector, viewport: { width: width, height: height }, scan: scan },
        arg.maxNodes,
      );
    } finally {
      try {
        await browser.close();
      } catch {
        /* keep the primary error */
      }
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
