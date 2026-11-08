import type { AtlasPageScan, AtlasScanSection } from "./live-types.js";

/**
 * Runs inside the guarded page. Reads only DOM, geometry and declared roles;
 * no visual guessing and no speculative WebGL context creation.
 */
export const ATLAS_SECTION_SCAN = function (): AtlasPageScan {
  const g = globalThis as any;
  const doc = g.document;
  const win = g.window;
  const selectorFor = (el: any): string => {
    const parts: string[] = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 8) {
      let part = String(cur.tagName || "").toLowerCase();
      if (cur.id) part += `#${String(cur.id).replace(/[^\w-]/g, "_")}`;
      if (cur.classList && cur.classList.length) {
        part += `.${String(cur.classList[0]).replace(/[^\w-]/g, "_")}`;
      }
      parts.unshift(part);
      cur = cur.parentElement;
      depth += 1;
    }
    return parts.join(" > ").slice(0, 240);
  };
  // Same tag#id.class[0] label preScroll/SCAN_SNIPPET emit, so the collector
  // can compare this scan's root with the element it scrolled.
  const scrollRootLabel = (el: any): string => {
    const css = g.CSS;
    const escapeIdent = (value: any): string =>
      css && typeof css.escape === "function"
        ? String(css.escape(String(value)))
        : String(value).replace(/[^A-Za-z0-9_\u00A0-\uFFFF-]/g, "\\$&");
    const id = el.id ? `#${escapeIdent(el.id)}` : "";
    const cls =
      el.classList && el.classList.length ? `.${escapeIdent(el.classList[0])}` : "";
    return String(el.tagName || "").toLowerCase() + id + cls;
  };
  const clean = (value: unknown): string =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  const directText = (element: any, maxChars = 4_000): string => {
    try {
      const tag = String(element.tagName || "").toUpperCase();
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(tag)) return "";
      if (!visibleNode(element)) return "";
      const parts: string[] = [];
      let chars = 0;
      let inspected = 0;
      let child = element.firstChild;
      while (child && chars < maxChars && inspected < 6_000) {
        inspected += 1;
        if (child.nodeType === 3) {
          const remaining = maxChars - chars;
          const value =
            typeof child.substringData === "function"
              ? child.substringData(0, remaining)
              : String(child.nodeValue ?? "").slice(0, remaining);
          parts.push(value);
          chars += value.length;
        }
        child = child.nextSibling;
      }
      return clean(parts.join(" ")).slice(0, maxChars);
    } catch {
      return "";
    }
  };
  const boundedText = (
    node: any,
    maxChars = 4_000,
    boundedNodes: any[] = walked,
  ): string => {
    try {
      const elements = boundedNodes.filter(
        (element: any) => element === node || node.contains(element),
      );
      const parts: string[] = [];
      let chars = 0;
      for (const element of elements) {
        if (chars >= maxChars) break;
        const text = directText(element, maxChars - chars);
        if (!text) continue;
        parts.push(text);
        chars += text.length;
      }
      return clean(parts.join(" ")).slice(0, maxChars);
    } catch {
      return "";
    }
  };
  const closestWithin = (node: any, selector: string, maxDepth = 12): any => {
    let current = node;
    let depth = 0;
    while (current && depth < maxDepth) {
      if (current.matches?.(selector)) return current;
      current = current.parentElement;
      depth += 1;
    }
    return null;
  };
  function visibleNode(node: any): boolean {
    try {
      let current = node;
      let depth = 0;
      while (current && current !== doc.documentElement && depth < 12) {
        const s = win.getComputedStyle(current);
        if (
          String(s.display) === "none" ||
          String(s.visibility) === "hidden" ||
          Number(s.opacity || 1) <= 0
        ) {
          return false;
        }
        current = current.parentElement;
        depth += 1;
      }
      const r = node.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch {
      return false;
    }
  }
  const sections: AtlasScanSection[] = [];
  const nodeIds: WeakMap<object, string> =
    win.__atlasNodeIds ?? (win.__atlasNodeIds = new WeakMap<object, string>());
  let nextNodeId = Number(win.__atlasNextNodeId ?? 0);
  function nodeKeyFor(node: any): string {
    const existing = nodeIds.get(node);
    if (existing) return existing;
    const key = `node-${nextNodeId++}`;
    nodeIds.set(node, key);
    win.__atlasNextNodeId = nextNodeId;
    return key;
  }
  const candidateSelector =
    "main, section, article, header, footer, nav, aside, div, [role=region], [role=main], [role=banner], [role=contentinfo], [role=navigation]";
  const structuralMatch = (el: any): boolean => {
    if (!el.matches?.(candidateSelector)) return false;
    if (String(el.tagName || "").toLowerCase() !== "div") return true;
    if (el.getAttribute("role")) return true;
    const children = el.children ?? [];
    const limit = Math.min(Number(children.length || 0), 200);
    for (let index = 0; index < limit; index += 1) {
      if (/^h[1-6]$/i.test(String(children[index]?.tagName || ""))) return true;
    }
    return false;
  };
  let inspectedNodes = 0;
  let nodeBudgetHit = false;
  let overflowCandidate = false;
  const walked: any[] = [];
  const walker = doc.createTreeWalker(doc.documentElement, 1);
  let walkedNode: any = doc.documentElement;
  while (walkedNode) {
    inspectedNodes += 1;
    if (inspectedNodes > 6_000) {
      nodeBudgetHit = true;
      overflowCandidate = structuralMatch(walkedNode);
      break;
    }
    walked.push(walkedNode);
    walkedNode = walker.nextNode();
  }
  // Mirror preScroll: document wins; otherwise use the largest visible inner scroller.
  const root = doc.documentElement;
  let scrollRootEl: any = null;
  const documentHeight = Math.max(
    Number(root?.scrollHeight || 0),
    Number(doc.body?.scrollHeight || 0),
  );
  // Quirks mode reports clientHeight as the content height; compare against
  // the viewport so a real document scroll is not mistaken for an inner root.
  const documentScrolls =
    documentHeight > Number(win.innerHeight || root?.clientHeight || 0) + 100;
  if (!documentScrolls) {
    let bestArea = 0;
    for (const node of walked) {
      if (node === doc.body || node === root) continue;
      if (Number(node.scrollHeight || 0) <= Number(node.clientHeight || 0) + 100) continue;
      const style = win.getComputedStyle(node);
      const overflowY = String(style.overflowY || "");
      if (overflowY !== "auto" && overflowY !== "scroll") continue;
      if (String(style.display) === "none" || String(style.visibility) === "hidden") continue;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        scrollRootEl = node;
      }
    }
  }
  const scrollRootRect = scrollRootEl?.getBoundingClientRect?.() ?? null;
  const structuralCandidates = walked
    .filter((el: any) => structuralMatch(el)) as any[];
  const rawCandidateCount = structuralCandidates.length + (overflowCandidate ? 1 : 0);
  const sectionNodes = structuralCandidates.slice(0, 120) as any[];
  const candidateNodes = new Set(sectionNodes);
  for (const el of sectionNodes) {
    try {
      const rect = el.getBoundingClientRect();
      const style = win.getComputedStyle(el);
      if (rect.width <= 0 || rect.height <= 0) continue;
      const bounded = walked.filter(
        (node: any) => node === el || el.contains(node),
      ) as any[];
      const headingEl = bounded.find((node) =>
        /^h[1-6]$/i.test(String(node.tagName || "")),
      );
      const heading = headingEl ? boundedText(headingEl, 300, bounded) : null;
      const headingLevel = headingEl
        ? Number(String(headingEl.tagName).replace(/[^1-6]/g, ""))
        : null;
      const countTag = (tag: string): number =>
        bounded.filter((node) => String(node.tagName || "").toLowerCase() === tag).length;
      const paragraphs = countTag("p");
      const links = bounded.filter(
        (node) => String(node.tagName || "").toLowerCase() === "a" && node.hasAttribute?.("href"),
      ).length;
      const media = bounded.filter((node) =>
        /^(img|video|canvas|picture)$/i.test(String(node.tagName || "")),
      ).length;
      const items = countTag("li");
      const ordered = bounded.filter(
        (node) =>
          String(node.tagName || "").toLowerCase() === "li" &&
          String(node.parentElement?.tagName || "").toLowerCase() === "ol",
      ).length;
      const quotes = bounded.filter(
        (node) =>
          /^(blockquote|q)$/i.test(String(node.tagName || "")) && visibleNode(node),
      ).length;
      const citations = bounded.filter(
        (node) => String(node.tagName || "").toLowerCase() === "cite" && visibleNode(node),
      ).length;
      const numericPairs = bounded
        .filter((node) => /^(p|li|span|strong)$/i.test(String(node.tagName || "")))
        .filter((node: any) => {
          if (!visibleNode(node)) return false;
          let parent = node.parentElement;
          let depth = 0;
          while (parent && parent !== el && depth < 12) {
            if (/^(P|LI|SPAN|STRONG)$/i.test(String(parent.tagName))) return false;
            parent = parent.parentElement;
            depth += 1;
          }
          return /[$€£¥]?\s*\d[\d,.%]*/.test(directText(node, 200));
        }).length;
      const forms = countTag("form");
      const emails = bounded.filter(
        (node) =>
          String(node.tagName || "").toLowerCase() === "input" &&
          String(node.getAttribute?.("type") || "").toLowerCase() === "email" &&
          visibleNode(node),
      ).length;
      const buttonNodes = bounded.filter(
        (node) =>
          (/^button$/i.test(String(node.tagName || "")) ||
            String(node.getAttribute?.("role") || "").toLowerCase() === "button") &&
          visibleNode(node),
      );
      const buttons = buttonNodes.length;
      const buttonLabels = buttonNodes
        .map((node: any) => directText(node, 80))
        .filter((label: string) => label.length > 0)
        .slice(0, 12);
      const role = el.getAttribute("role");
      const roleValue = role ? String(role).toLowerCase() : null;
      const landmark =
        el.tagName === "HEADER" || roleValue === "banner"
          ? "header"
          : el.tagName === "FOOTER" || roleValue === "contentinfo"
            ? "footer"
            : el.tagName === "NAV" || roleValue === "navigation"
              ? "navigation"
              : el.tagName === "MAIN" || roleValue === "main"
                ? "main"
                : null;
      const parentSection = (() => {
        let parent = el.parentElement;
        let depth = 0;
        while (parent && !candidateNodes.has(parent) && depth < 12) {
          parent = parent.parentElement;
          depth += 1;
        }
        return parent && candidateNodes.has(parent) ? parent : null;
      })();
      sections.push({
        nodeKey: nodeKeyFor(el),
        selector: selectorFor(el),
        tag: String(el.tagName || "").toLowerCase(),
        role: role ? String(role) : null,
        landmark,
        heading,
        headingLevel,
        text: boundedText(el, 4_000, bounded),
        visible: visibleNode(el),
        articleNested:
          Boolean(closestWithin(el, "article", 12)) &&
          String(el.tagName || "").toLowerCase() !== "article",
        landmarkNested: Boolean(closestWithin(el.parentElement, "article, section", 12)),
        paragraphCount: paragraphs,
        linkCount: links,
        mediaCount: media,
        repeatedItems: items,
        orderedItems: ordered,
        quoteCount: quotes,
        citationCount: citations,
        numericPairs,
        formCount: forms,
        emailInputCount: emails,
        buttonCount: buttons,
        buttonLabels,
        rect: {
          x: Math.round(
            scrollRootEl && scrollRootEl.contains(el)
              ? rect.x - (scrollRootRect?.left ?? 0) + (scrollRootEl.scrollLeft || 0)
              : rect.x + (win.scrollX || 0),
          ),
          y: Math.round(
            scrollRootEl && scrollRootEl.contains(el)
              ? rect.y - (scrollRootRect?.top ?? 0) + (scrollRootEl.scrollTop || 0)
              : rect.y + (win.scrollY || 0),
          ),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        viewport: {
          width: Math.round(win.innerWidth),
          height: Math.round(win.innerHeight),
        },
        backgroundColor: style && style.backgroundColor ? String(style.backgroundColor) : null,
        fixed: (() => {
          let current = el;
          let depth = 0;
          while (current && current !== doc.documentElement && depth < 12) {
            const currentStyle = win.getComputedStyle(current);
            if (String(currentStyle.position) === "fixed") return true;
            current = current.parentElement;
            depth += 1;
          }
          return String(win.getComputedStyle(doc.documentElement).position) === "fixed";
        })(),
        depth: (() => {
          let d = 0;
          let p = el.parentElement;
          let walkedDepth = 0;
          while (p && walkedDepth < 12) {
            if (/^(MAIN|SECTION|ARTICLE|HEADER|FOOTER|NAV)$/.test(String(p.tagName))) d += 1;
            p = p.parentElement;
            walkedDepth += 1;
          }
          return Math.min(d, 12);
        })(),
        parentKey: parentSection ? nodeKeyFor(parentSection) : null,
        inScrollRoot: scrollRootEl ? scrollRootEl.contains(el) : false,
      });
    } catch {
      /* skip an unreadable node, keep the scan deterministic */
    }
  }
  return {
    title: clean(doc.title),
    url: String(win.location.href),
    totalHeight: scrollRootEl
      ? Number(scrollRootEl.scrollHeight || 0)
      : documentHeight,
    scrollRoot: scrollRootEl ? scrollRootLabel(scrollRootEl) : null,
    scrollRootClientHeight: scrollRootEl ? Number(scrollRootEl.clientHeight || 0) : null,
    scrollRootScrollLeft: scrollRootEl ? Number(scrollRootEl.scrollLeft || 0) : null,
    scrollRootScrollTop: scrollRootEl ? Number(scrollRootEl.scrollTop || 0) : null,
    scrollX: Number(win.scrollX || 0),
    scrollY: Number(win.scrollY || 0),
    sections,
    sectionLimitHit: rawCandidateCount > 120,
    rawSectionCount: rawCandidateCount,
    nodeBudgetHit,
    technologies: [],
    canvasCount: walked.filter(
      (node: any) => String(node.tagName || "").toLowerCase() === "canvas",
    ).length,
    webglObserved: false,
  };
};
