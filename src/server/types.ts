import { BlockedError } from "../awwwards.js";
import type { AwwwardsClient, AwardFilter, SearchFilters } from "../awwwards.js";
import type { AccessibilityResult } from "../a11y.js";
import type {
  AnnualCategoriesResult,
  AnnualNomineeResult,
  AnnualNomineesResult,
} from "../annual.js";
import type { BuildProjectFn } from "../build-project.js";
import type { BundleReport } from "../bundle-forensics.js";
import type { Cache } from "../cache.js";
import type { CaptureOpts, CaptureResult } from "../capture.js";
import type { ScrollCensus } from "../census.js";
import type { CollectionsListResult, CollectionResult } from "../collections.js";
import type { ComponentNode, ComponentPack } from "../component.js";
import type { DirectoryArgs, DirectoryResult } from "../directory.js";
import type { DesignBriefInput } from "../design-brief.js";
import type { GsapStubFn } from "../gsap-stub.js";
import type { HoverCensusFn } from "../hover-census.js";
import type { RawImageScan } from "../images.js";
import type { IndexStatsArgs, IndexStatsResult } from "../index-stats.js";
import type { NetworkCaptureResult } from "../network-capture.js";
import type { PageStructure, WaitOpts, WaitStrategy } from "../structure.js";
import type { PoseGrid } from "../pose3d.js";
import type { StackFingerprint } from "../stack.js";
import type { TokenCategory } from "../tokens.js";
import type { MotionDna, SiteDetails, SiteSummary } from "../types.js";
import type { AuditCompact, AuditUrlResult } from "../audit-url.js";
import type { FlowReport, VerifyFlowArgs } from "../verify-flow.js";
import type { VerifyBuildFn, VerifyReport } from "../verify-build.js";
import type { ViewportName } from "../viewport.js";

export const AWARD_FILTER_LABELS: Record<AwardFilter, string> = {
  sotd: "Site of the Day",
  sotm: "Site of the Month",
  soty: "Site of the Year",
  nominees: "Nominee",
  developer: "Developer Award",
  honorable: "Honorable Mention",
  ecommerce: "Winners — E-commerce",
  portfolio: "Winners — Portfolio",
  product: "Winners — Product",
  typography: "Winners — Typography",
  businessServices: "Winners — Business Services",
  noCode: "Winners — No Code",
};

export const SITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CATEGORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Legacy taxonomy caches (written before technology facets existed) refresh on
// read. A failed refresh waits this long before retrying, so a flaky network
// cannot turn every list_categories call into a request.
export const TAXONOMY_RETRY_MS = 60 * 60 * 1000;

// The text block lists every element; only this many posters are fetched inline.
export const MAX_INLINE_POSTERS = 8;

export type Block =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResponse {
  content: Block[];
  isError?: boolean;
}

export interface SearchArgs extends SearchFilters {
  responseMode?: "full" | "compact";
  count?: number;
  page?: number;
  // "newest" (default) = default order: bm25 relevance for an FTS-served
  // query, otherwise newest-first; "score" orders scored sites first
  // (detail-meta score, desc), unscored after, newest-first.
  sortBy?: "score" | "newest";
}

export type CaptureFn = (
  url: string,
  imagesDir: string,
  opts?: CaptureOpts,
) => Promise<CaptureResult>;

export type AnalyzeFn = (
  url: string,
  maxBands?: number,
  opts?: WaitOpts,
) => Promise<PageStructure | { error: string }>;

export type MotionFn = (
  url: string,
  opts: {
    cacheImagesDir: string;
    frames?: number;
    waitStrategy?: WaitStrategy;
    viewport?: ViewportName;
  },
) => Promise<
  | {
      file: string;
      base64: string;
      frames: number;
      sheet?: { htmlPath: string; mdPath: string; keyframes: number; masks: number } | null;
      sheetError?: string;
    }
  | { error: string }
>;

export type MotionDnaFn = (
  url: string,
  // C2: same opts contract as the census peers — the default switched from
  // captureMotionDna (viewport-only) to captureMotionDnaUnified.
  opts?: { waitStrategy?: WaitStrategy; viewport?: ViewportName; reducedMotion?: boolean },
) => Promise<MotionDna>;

export type ScrollMapFn = (
  url: string,
  opts?: {
    waitStrategy?: WaitStrategy;
    viewport?: ViewportName;
    reducedMotion?: boolean;
    scrubProbe?: boolean;
  },
) => Promise<ScrollCensus | { error: string }>;

// Gap 4 wiring peers: capture browses the page (Playwright), the stub fn is
// pure given grid (+ optional census) — both optional in deps for DI tests.
export type Pose3dFn = (
  url: string,
  opts?: { steps?: number; viewport?: ViewportName },
) => Promise<PoseGrid | { error: string }>;

export type PoseStubFn = (
  grid: PoseGrid,
  census?: ScrollCensus,
) => { stubHtml: string; notes: string[] };

// analyze_stack: one polite fetch of a page's HTML, fingerprinted offline.
export type StackFn = (
  url: string,
  opts?: { timeoutMs?: number; fetchFn?: typeof fetch },
) => Promise<StackFingerprint | { error: string }>;

// analyze_bundle: fetches a page + its script chunks (bounded), greps keywords.
export type BundleFn = (
  url: string,
  opts?: { keywords?: string[]; maxChunks?: number; walkChunks?: boolean; edges?: boolean; bundleIntel?: boolean },
) => Promise<BundleReport | { error: string }>;

// analyze_network_capture: offline HAR 1.2 parsing — reads a local file only.
export type NetworkCaptureFn = (
  path: string,
  opts?: { top?: number },
) => Promise<NetworkCaptureResult | { error: string }>;

// verify_flow: two fresh headless launches, step-aligned state comparison.
export type VerifyFlowFn = (
  args: VerifyFlowArgs,
) => Promise<FlowReport | { error: string }>;

// build_gsap_stub: pure idle-CPU build from captured evidence — no fetches.
export type { GsapStubFn };

// Re-exported for consumers that spell deps in terms of server.ts types;
// captureHoverCensus (hover-census.ts) owns the canonical shape.
export type { HoverCensusFn };
export type { VerifyBuildFn };
export type { ComponentPack };

export type CaptureComponentFn = (
  url: string,
  opts?: { selector?: string; viewport?: ViewportName; maxNodes?: number; maxDepth?: number },
) => Promise<ComponentPack | { error: string }>;

// Raw document.images scan; the handler owns the pure summarizeImages reducer.
export type AnalyzeImagesFn = (
  url: string,
  opts?: { viewport?: ViewportName; maxImages?: number; loader?: () => Promise<any> },
) => Promise<RawImageScan | { error: string }>;

// Official Annual Awards API peers. Lazy defaults keep annual.ts off the hot
// path and let handler tests inject shapes without network or cache.
export type AnnualCategoriesFn = () => Promise<AnnualCategoriesResult>;
export type AnnualNomineesFn = (args: {
  category: string;
  limit?: number;
  offset?: number;
  hydrate?: boolean;
}) => Promise<AnnualNomineesResult>;
export type AnnualNomineeFn = (args: {
  id?: string;
  category?: string;
  slug?: string;
}) => Promise<AnnualNomineeResult>;

// Collections/directory peers: lazy defaults keep the modules off the hot path
// and let handler tests inject shapes without network or cache.
export type GetCollectionsFn = (args: {
  slug?: string;
  page?: number;
}) => Promise<CollectionsListResult | CollectionResult>;
export type SearchDirectoryFn = (args: DirectoryArgs) => Promise<DirectoryResult>;

// W2 inspection peers: every fn is optional so handler tests stay offline.
export type AuditUrlFn = (args: {
  url: string;
  viewport?: ViewportName;
  timeoutMs?: number;
}) => Promise<AuditUrlResult | { error: string }>;
export type AnalyzeAccessibilityFn = (args: {
  url: string;
  viewport?: ViewportName;
  limit?: number;
}) => Promise<AccessibilityResult | { error: string }>;
export type IndexStatsFn = (args: IndexStatsArgs) => Promise<IndexStatsResult>;

// C3 token-diet helpers (plan Task C3): pure compaction for the `compact`
// flag on get_site_details / capture_component. Heavy per-element detail →
// counts; top-level numerics and triggers stay. The census-typed siblings
// (compactScrollCensus / compactHoverCensus) live in verify-build.ts because
// census.ts / hover-census.ts are out of this wave's scope.
export interface SlimComponentNode {
  tag: string;
  classes: string[];
  rect: ComponentNode["rect"];
  children: SlimComponentNode[];
}

/** ComponentPack → diet: the node tree keeps {tag, classes, rect} + children only. */
export function compactComponentPack(p: ComponentPack): {
  id: string;
  url: string;
  selector: string;
  capturedAt: number;
  viewport: { width: number; height: number };
  nodeCount: number;
  depthCapped?: boolean;
  root: SlimComponentNode;
  fonts: string[];
  colors: string[];
} {
  // styles/text/svg/anims/pseudos are the per-node detail that gets
  // stripped; structure (tag/classes/rect) is what rebuild prompts need.
  const walk = (n: ComponentNode): SlimComponentNode => ({
    tag: n.tag,
    classes: n.classes,
    rect: n.rect,
    children: n.children.map(walk),
  });
  return {
    id: p.id,
    url: p.url,
    selector: p.selector,
    capturedAt: p.capturedAt,
    viewport: p.viewport,
    nodeCount: p.nodeCount,
    ...(p.depthCapped ? { depthCapped: true } : {}),
    root: walk(p.root),
    fonts: p.fonts,
    colors: p.colors,
  };
}

/** AuditUrlResult → diet: pre-cap severity counts + ranked actions instead of every finding body. */
export function compactAuditResult(r: AuditUrlResult): AuditCompact {
  return {
    url: r.url,
    // Chrome path and scroll-listener details stay in the full payload only.
    perf:
      "error" in r.perf
        ? r.perf
        : {
            fps: r.perf.fps,
            droppedFrames: r.perf.droppedFrames,
            longTasks: r.perf.longTaskCount,
            layoutThrashing: r.perf.layoutThrashCount,
          },
    antiPatterns: {
      count: r.antiPatterns.count,
      worst: r.antiPatterns.worst,
      high: r.antiPatterns.high,
      medium: r.antiPatterns.medium,
      info: r.antiPatterns.info,
      ...(r.antiPatterns.error ? { error: r.antiPatterns.error } : {}),
    },
    coverage: r.coverage,
    nextActions: r.nextActions,
    note: r.note,
  };
}

/** VerifyReport → diet: verdict + scores; band names collapse to counts, evidence dropped. */
export function compactVerifyReport(r: VerifyReport): {
  verdict: VerifyReport["verdict"];
  overall: number;
  bands: { score: number; matched: number; refOnly: number; buildOnly: number };
  motion: { score: number };
} {
  return {
    verdict: r.verdict,
    overall: r.overall,
    bands: {
      score: r.bands.score,
      matched: r.bands.matched.length,
      refOnly: r.bands.refOnly.length,
      buildOnly: r.bands.buildOnly.length,
    },
    motion: { score: r.motion.score },
  };
}

/** SiteDetails → diet: palette/technologies/elements lists → counts; awards + numerics stay. */
export function compactSiteDetails(d: SiteDetails): Record<string, unknown> {
  return {
    slug: d.slug,
    title: d.title,
    // D2: description restored to the compact diet at ≤500 chars — rebuild
    // prompts read the prose; the lists stay counts.
    description: d.description ? d.description.slice(0, 500) : null,
    liveUrl: d.liveUrl,
    nominee: d.nominee,
    score: d.score,
    juryDimensions: d.juryDimensions,
    awards: d.awards,
    paletteCount: d.palette.length,
    technologiesCount: d.technologies.length,
    elementsCount: d.elements.length,
    ogImage: d.ogImage,
  };
}

export type CompactSiteDetails = ReturnType<typeof compactSiteDetails>;
export type DetailSource = "cached" | "fetched";

// Spec §4.1: one ordered entry per requested slug. A block short-circuits
// every remaining slug to "skipped" without a request.
export type BatchDetailEntry =
  | { slug: string; status: DetailSource; details: CompactSiteDetails }
  | { slug: string; status: "error"; error: string; blocked?: true }
  | { slug: string; status: "skipped"; error: "blocked-before-request"; blocked: true };

// Taxonomy helpers live in awwwards.ts (the lowest layer that owns technology
// aliases and URL building); re-exported here so every server-side consumer
// keeps one import site.
export { canonicalFacet, slugifyTag } from "../awwwards.js";

// Free-text queries match token-wise: every punctuation-separated token must
// substring-match the site's title+tags. Punctuation is a boundary (the FTS
// tokenizer does the same), so "next.js" becomes ["next", "js"] instead of a
// glued "nextjs" token. Letters of any script stay intact ("Léo" is one
// token, not ["l", "o"]).
export function tokenizeQuery(q: string): string[] {
  return q.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
}

// Zero-result suggestions: rank taxonomy slugs against the query's tokens.
// +2 per token (>=4 chars) the slug contains; +1 when slug and token share a
// >=4-char prefix (compared via their first 5 chars, in either direction).
// Ties rank stably by slug; only positive scores are suggested.
export function suggestTags(tokens: string[], taxonomy: string[], limit = 6): string[] {
  const scored: [string, number][] = [];
  for (const slug of taxonomy) {
    let score = 0;
    for (const t of tokens) {
      if (t.length < 4) continue;
      if (slug.includes(t)) score += 2;
      else if (slug.startsWith(t.slice(0, 5)) || t.startsWith(slug.slice(0, 5))) score += 1;
    }
    if (score > 0) scored.push([slug, score]);
  }
  return scored
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([s]) => s);
}

export function text(t: string): Block {
  return { type: "text", text: t };
}

export function summarizeSite(s: SiteSummary): string {
  const award = s.awards.length ? ` [${s.awards.join(", ")}]` : "";
  const nominee = s.nominee ? " [nominee]" : "";
  return `- ${s.title} (slug: ${s.slug})${nominee}${award}\n  live: ${s.liveUrl ?? "unknown"}\n  awwwards: https://www.awwwards.com${s.detailPath}\n  tags: ${s.tags.join(", ")}`;
}

export function formatCompactSite(s: SiteSummary, number: number): string {
  const tags = s.tags.slice(0, 3);
  const extra = s.tags.length - tags.length;
  return [
    `${number}. ${s.title} (slug: ${s.slug})`,
    s.liveUrl ? `live: ${s.liveUrl}` : null,
    s.nominee ? "status: nominee" : null,
    s.awards.length ? `awards: ${s.awards.join(", ")}` : null,
    tags.length ? `tags: ${tags.join(", ")}${extra > 0 ? ` +${extra}` : ""}` : null,
  ].filter(Boolean).join(" | ").replace(/\s+/g, " ").trim();
}

export function errorResponse(err: unknown): ToolResponse {
  const message =
    err instanceof BlockedError
      ? err.message
      : `awwwards-mcp request failed: ${err instanceof Error ? err.message : String(err)}`;
  return { content: [text(message)], isError: true };
}

export interface Handlers {
  search_sites(args: SearchArgs): Promise<ToolResponse>;
  get_site_details(args: { slug?: string; slugs?: string[]; compact?: boolean }): Promise<ToolResponse>;
  compare_sites(args: { slugs: string[] }): Promise<ToolResponse>;
  create_design_brief(args: DesignBriefInput & {
    viewport?: ViewportName;
    waitStrategy?: WaitStrategy;
    maxBands?: number;
  }): Promise<ToolResponse>;
  get_index_status(): Promise<ToolResponse>;
  get_index_stats(args: IndexStatsArgs): Promise<ToolResponse>;
  get_site_elements(args: { slug: string }): Promise<ToolResponse>;
  search_elements(args: {
    query?: string;
    category?: string;
    stack?: string[];
    limit?: number;
  }): Promise<ToolResponse>;
  get_element(args: { id: string }): Promise<ToolResponse>;
  list_categories(): Promise<ToolResponse>;
  get_annual_categories(): Promise<ToolResponse>;
  get_annual_nominees(args: {
    category: string;
    limit?: number;
    offset?: number;
    hydrate?: boolean;
  }): Promise<ToolResponse>;
  get_annual_nominee(args: {
    id?: string;
    category?: string;
    slug?: string;
  }): Promise<ToolResponse>;
  get_collections(args: { slug?: string; page?: number }): Promise<ToolResponse>;
  search_directory(args: DirectoryArgs): Promise<ToolResponse>;
  audit_url(args: {
    url: string;
    viewport?: ViewportName;
    timeoutMs?: number;
    compact?: boolean;
  }): Promise<ToolResponse>;
  analyze_accessibility(args: {
    url: string;
    viewport?: ViewportName;
    limit?: number;
  }): Promise<ToolResponse>;
  capture_live_site(args: {
    url: string;
    waitStrategy?: WaitStrategy;
    viewport?: ViewportName;
    inline?: boolean;
    maxInlineBytes?: number;
    waitForOverlay?: boolean;
    scrollCapture?: "auto" | "anchors" | "viewport";
  }): Promise<ToolResponse>;
  analyze_page_structure(args: {
    url: string;
    maxBands?: number;
    waitStrategy?: WaitStrategy;
    viewport?: ViewportName;
    compare?: "mobile";
    cdpEndpoint?: string;
  }): Promise<ToolResponse>;
  record_site_motion(args: {
    url: string;
    frames?: number;
    waitStrategy?: WaitStrategy;
    viewport?: ViewportName;
  }): Promise<ToolResponse>;
  get_motion_dna(args: { url: string; recapture?: boolean }): Promise<ToolResponse>;
  analyze_scroll_map(args: {
    url: string;
    waitStrategy?: WaitStrategy;
    viewport?: ViewportName;
    reducedMotion?: boolean;
    scrubProbe?: boolean;
    compact?: boolean;
  }): Promise<ToolResponse>;
  analyze_hover_census(args: {
    url: string;
    waitStrategy?: WaitStrategy;
    viewport?: ViewportName;
    reducedMotion?: boolean;
    compact?: boolean;
  }): Promise<ToolResponse>;
  analyze_bundle(args: {
    url: string;
    keywords?: string[];
    maxChunks?: number;
    walkChunks?: boolean;
    edges?: boolean;
    bundleIntel?: boolean;
  }): Promise<ToolResponse>;
  analyze_network_capture(args: { path: string; top?: number }): Promise<ToolResponse>;
  verify_flow(args: VerifyFlowArgs): Promise<ToolResponse>;
  verify_build(args: { buildUrl: string; referenceUrl: string; waitStrategy?: WaitStrategy; viewport?: ViewportName; domDiff?: boolean; compact?: boolean }): Promise<ToolResponse>;
  capture_component(args: {
    url: string;
    selector?: string;
    viewport?: ViewportName;
    maxNodes?: number;
    maxDepth?: number;
    compact?: boolean;
  }): Promise<ToolResponse>;
  export_design_tokens(args: {
    url: string;
    selector?: string;
    viewport?: ViewportName;
    maxNodes?: number;
    include?: TokenCategory[];
  }): Promise<ToolResponse>;
  analyze_images(args: {
    url: string;
    viewport?: ViewportName;
    maxImages?: number;
  }): Promise<ToolResponse>;
  capture_pose_3d(args: {
    url: string;
    steps?: number;
    viewport?: ViewportName;
  }): Promise<ToolResponse>;
  build_pose_stub(args: {
    poseGrid: PoseGrid;
    scrollCensus?: ScrollCensus;
  }): Promise<ToolResponse>;
  analyze_stack(args: { url: string; timeoutMs?: number }): Promise<ToolResponse>;
  build_gsap_stub(args: { scrollCensus: unknown; poseGrid?: unknown }): Promise<ToolResponse>;
  build_motion_manifest(args: {
    bands: unknown;
    scrollCensus: unknown;
    sections?: { label: string; selector?: string }[];
  }): Promise<ToolResponse>;
  build_project(args: { htmlPath: string; target: "vite" | "astro" | "next"; out: string; name?: string }): Promise<ToolResponse>;
  search_motion(args: {
    lib?: string;
    scrubOnly?: boolean;
    hasPins?: boolean;
    limit?: number;
  }): Promise<ToolResponse>;
  new_winners(args: { award?: "sotd" | "developer" | "honorable" }): Promise<ToolResponse>;
  watch_site(args: {
    action: "add" | "list" | "remove";
    kind?: "studio" | "tag" | "url";
    pattern?: string;
    award?: "sotd" | "developer" | "honorable";
    note?: string;
  }): Promise<ToolResponse>;
}

// Freshness window for cached Motion DNA rows; records older than this are
// re-captured live by get_motion_dna.
export const MOTION_DNA_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface CreateHandlersDeps {
  client: AwwwardsClient;
  cache: Cache;
  captureFn?: CaptureFn;
  analyzeFn?: AnalyzeFn;
  motionFn?: MotionFn;
  motionDnaFn?: MotionDnaFn;
  scrollMapFn?: ScrollMapFn;
  hoverCensusFn?: HoverCensusFn;
  bundleFn?: BundleFn;
  networkCaptureFn?: NetworkCaptureFn;
  verifyFlowFn?: VerifyFlowFn;
  verifyBuildFn?: VerifyBuildFn;
  captureComponentFn?: CaptureComponentFn;
  analyzeImagesFn?: AnalyzeImagesFn;
  pose3dFn?: Pose3dFn;
  poseStubFn?: PoseStubFn;
  stackFn?: StackFn;
  gsapStubFn?: GsapStubFn;
  buildProjectFn?: BuildProjectFn;
  annualCategoriesFn?: AnnualCategoriesFn;
  annualNomineesFn?: AnnualNomineesFn;
  annualNomineeFn?: AnnualNomineeFn;
  getCollectionsFn?: GetCollectionsFn;
  searchDirectoryFn?: SearchDirectoryFn;
  auditUrlFn?: AuditUrlFn;
  analyzeAccessibilityFn?: AnalyzeAccessibilityFn;
  indexStatsFn?: IndexStatsFn;
  // Injectable clock (ms epoch): defaults to Date.now. Lets tests pin time so
  // date-windowed tools (new_winners) don't break at UTC midnight rollovers.
  now?: () => number;
}
