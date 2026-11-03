import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AwwwardsClient } from "../src/awwwards.js";
import { designBriefOutputSchema } from "../src/brief-contracts.js";
import { Cache } from "../src/cache.js";
import type { Choreography } from "../src/choreography.js";
import { createDesignBrief, renderDesignBrief } from "../src/design-brief.js";
import type { DesignBrief, DesignBriefSource } from "../src/design-brief.js";
import { createHandlers } from "../src/server.js";
import { createServer } from "../src/server-instance.js";
import type { PageStructure } from "../src/structure.js";
import type { MotionDna, SiteDetails, SiteSummary } from "../src/types.js";

const dirs: string[] = [];
const tmpDir = () => {
  const d = mkdtempSync(join(tmpdir(), "awwwards-brief-contracts-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const detail = (slug: string, overrides: Partial<SiteDetails> = {}): SiteDetails => ({
  slug,
  title: slug,
  description: null,
  palette: ["#111111"],
  technologies: ["GSAP"],
  elements: ["Cursor"],
  awards: [],
  nominee: false,
  score: null,
  ogImage: null,
  liveUrl: `https://${slug}.example`,
  ...overrides,
});

const site = (slug: string): SiteSummary => ({
  id: 1,
  slug,
  title: slug,
  createdAt: 1789516800,
  tags: [],
  thumbnailPath: `submissions/${slug}.jpg`,
  liveUrl: `https://${slug}.example`,
  detailPath: `/sites/${slug}`,
  awards: [],
});

const motion = (
  url: string,
  durationVocab: MotionDna["durationVocab"] = { p25: 200, median: 400, p75: 650 },
): MotionDna => ({
  url,
  stack: { libs: ["gsap"], render: ["webgl"], scrollModel: "native" },
  scroll: {
    triggerCount: 2,
    scrubCount: 1,
    pinCount: 0,
    scrubRatio: 0.5,
    sample: [],
  },
  easingVocab: [{ token: "power2.out", bezier: null, uses: 2 }],
  durationVocab,
  capturedAt: Date.now(),
});

const structure: PageStructure = {
  url: "https://alpha.example",
  title: "Alpha",
  totalHeight: 900,
  bands: [
    { index: 0, tag: "section", label: "hero", background: "#111111", offsetTop: 0, height: 500, textStart: "Alpha" },
    { index: 1, tag: "footer", label: "footer", background: "#000000", offsetTop: 500, height: 400, textStart: "©" },
  ],
};

const sources = (): DesignBriefSource[] => [
  {
    slug: "alpha",
    title: "Alpha",
    detail: detail("alpha"),
    detailStatus: "cached",
    motion: motion("https://alpha.example"),
    structure,
    structureStatus: "captured",
  },
  {
    slug: "beta",
    title: "Beta",
    detail: detail("beta", { palette: ["#EEEEEE"], elements: ["Hover"] }),
    detailStatus: "cached",
    motion: motion("https://beta.example", null),
    structure: null,
    structureStatus: "unavailable",
  },
];

const choreography: Choreography = {
  hints: [
    { selector: ".card", value: 80, source: "tween-var" },
    { selector: ".card", value: 80, source: "tween-var" },
    { selector: ".row", value: 120, source: "delay-delta" },
  ],
  groups: 2,
};

const fullBrief = (): DesignBrief =>
  createDesignBrief(
    {
      slugs: ["alpha", "beta"],
      goal: "a studio site",
      audience: "a type foundry",
      constraints: ["no WebGL", "must work without JS"],
      includeStructure: true,
    },
    sources(),
    { choreography },
  );

const embeddedJson = (text: string): unknown =>
  JSON.parse(
    text.slice(text.indexOf("```json\n") + "```json\n".length, text.lastIndexOf("\n```")),
  );

function withProfile<T>(profile: string | undefined, fn: () => T): T {
  const savedProfile = process.env.AWWWARDS_MCP_PROFILE;
  const savedLegacy = process.env.AWARDS_MCP_PROFILE;
  if (profile === undefined) delete process.env.AWWWARDS_MCP_PROFILE;
  else process.env.AWWWARDS_MCP_PROFILE = profile;
  delete process.env.AWARDS_MCP_PROFILE;
  try {
    return fn();
  } finally {
    if (savedProfile === undefined) delete process.env.AWWWARDS_MCP_PROFILE;
    else process.env.AWWWARDS_MCP_PROFILE = savedProfile;
    if (savedLegacy === undefined) delete process.env.AWARDS_MCP_PROFILE;
    else process.env.AWARDS_MCP_PROFILE = savedLegacy;
  }
}

function withResponseLimit<T>(bytes: number, fn: () => T): T {
  const saved = process.env.AWWWARDS_MCP_MAX_RESPONSE_BYTES;
  const savedLegacy = process.env.AWARDS_MCP_MAX_RESPONSE_BYTES;
  process.env.AWWWARDS_MCP_MAX_RESPONSE_BYTES = String(bytes);
  delete process.env.AWARDS_MCP_MAX_RESPONSE_BYTES;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.AWWWARDS_MCP_MAX_RESPONSE_BYTES;
    else process.env.AWWWARDS_MCP_MAX_RESPONSE_BYTES = saved;
    if (savedLegacy === undefined) delete process.env.AWARDS_MCP_MAX_RESPONSE_BYTES;
    else process.env.AWARDS_MCP_MAX_RESPONSE_BYTES = savedLegacy;
  }
}

function cachedHandlers() {
  const cache = new Cache(tmpDir());
  cache.upsertSites([site("alpha"), site("beta")]);
  cache.setMeta("detail:alpha", detail("alpha"));
  cache.setMeta("detail:beta", detail("beta", { palette: ["#EEEEEE"], elements: ["Hover"] }));
  cache.upsertMotionDna(motion("https://alpha.example"));
  return createHandlers({ client: {} as any, cache });
}

const args = { slugs: ["alpha", "beta"], goal: "a studio site" };

describe("create_design_brief output contract", () => {
  it("preserves luminanceBand on shared palette signals too", () => {
    const sharedSources = sources().map((source) => ({
      ...source,
      detail: source.detail ? { ...source.detail, palette: ["#111111"] } : null,
    }));
    const brief = createDesignBrief(
      { slugs: ["alpha", "beta"], goal: "a studio site" },
      sharedSources,
    );
    const palette = brief.direction.sharedPatterns.find((signal) => signal.value === "palette:#111111");
    expect(palette?.luminanceBand).toBe("dark");
    const parsed = designBriefOutputSchema.parse(brief);
    expect(
      parsed.direction.sharedPatterns.find((signal) => signal.value === "palette:#111111")?.luminanceBand,
    ).toBe("dark");
  });

  it("preserves luminanceBand on palette entries in outliers and shared patterns", () => {
    const brief = fullBrief();
    const parsed = designBriefOutputSchema.parse(brief);
    const paletteSignals = [...parsed.direction.outliers, ...parsed.direction.sharedPatterns].filter(
      (signal) => signal.value.startsWith("palette:"),
    );
    expect(paletteSignals.length).toBeGreaterThan(0);
    expect(paletteSignals.every((signal) => signal.luminanceBand !== undefined)).toBe(true);
  });

  it("validates the full brief with audience, structure and stagger hints", () => {
    const brief = fullBrief();

    expect(brief.audience).toBe("a type foundry");
    expect(brief.direction.structure?.bandCounts).toEqual([{ slug: "alpha", count: 2 }]);
    expect(brief.direction.interactionPlan.staggerHints).toEqual([
      "tween-var=80 @ .card",
      "delay-delta=120 @ .row",
    ]);
    expect(designBriefOutputSchema.safeParse(brief).success).toBe(true);
    expect(JSON.parse(renderDesignBrief(brief).split("```json\n")[1]!.replace(/\n```\n$/, ""))).toEqual(brief);
  });

  it("accepts a brief without audience, structure or stagger hints and keeps null durations", () => {
    const brief = createDesignBrief(
      { slugs: ["alpha", "beta"], goal: "a studio site" },
      sources().map((source) => ({ ...source, structure: null, structureStatus: "not_requested" as const })),
    );

    expect("audience" in brief).toBe(false);
    expect("structure" in brief.direction).toBe(false);
    expect("staggerHints" in brief.direction.interactionPlan).toBe(false);
    expect(brief.direction.motion.durationRange).toEqual({
      p25: 200,
      median: 400,
      p75: 650,
      sourceSlugs: ["alpha"],
    });
    expect(designBriefOutputSchema.safeParse(brief).success).toBe(true);

    const withoutTiming = createDesignBrief(
      { slugs: ["alpha", "beta"], goal: "a studio site" },
      sources().map((source) => ({
        ...source,
        motion: source.motion ? { ...source.motion, durationVocab: null } : null,
      })),
    );
    expect(withoutTiming.direction.motion.durationRange).toBeNull();
    expect(withoutTiming.direction.interactionPlan.durationRange).toBeNull();
    expect(designBriefOutputSchema.safeParse(withoutTiming).success).toBe(true);
  });

  it("rejects malformed fields and unknown top-level keys", () => {
    const brief = fullBrief();
    const reject = (candidate: unknown) =>
      expect(designBriefOutputSchema.safeParse(candidate).success, JSON.stringify(candidate)).toBe(false);

    reject({ ...brief, version: 2 });
    const { goal: _goal, ...withoutGoal } = brief;
    reject(withoutGoal);
    reject({ ...brief, audience: 5 });
    reject({ ...brief, constraints: "no WebGL" });
    reject({ ...brief, extra: true });
    reject({
      ...brief,
      sources: [{ ...brief.sources[0]!, evidence: { ...brief.sources[0]!.evidence, detail: "stale" } }, brief.sources[1]!],
    });
    reject({
      ...brief,
      direction: {
        ...brief.direction,
        palette: [{ ...brief.direction.palette[0]!, luminanceBand: "bright" }],
      },
    });
    reject({
      ...brief,
      direction: {
        ...brief.direction,
        motion: {
          ...brief.direction.motion,
          durationRange: { ...brief.direction.motion.durationRange!, p25: "200" },
        },
      },
    });
    reject({
      ...brief,
      direction: {
        ...brief.direction,
        structure: {
          ...brief.direction.structure!,
          bandCounts: [{ slug: "alpha", count: 1.5 }],
        },
      },
    });
  });

  it("passes the SDK output validator in the full and v2 profiles", async () => {
    const h = cachedHandlers();
    const result = await h.create_design_brief(args);

    expect(result.isError).toBeUndefined();
    expect(designBriefOutputSchema.safeParse(result.structuredContent).success).toBe(true);
    expect(result.structuredContent).toEqual(embeddedJson((result.content[0] as any).text));
    expect((result.content[0] as any).text).toBe(
      renderDesignBrief(result.structuredContent as unknown as DesignBrief),
    );

    const full = withProfile(undefined, () =>
      createServer({ handlers: h, version: "0.0.0-test" }),
    ) as any;
    await expect(
      full.validateToolOutput(full._registeredTools.create_design_brief, result, "create_design_brief"),
    ).resolves.toBeUndefined();

    const v2 = withProfile("v2", () =>
      createServer({ handlers: h, version: "0.0.0-test" }),
    ) as any;
    await expect(
      v2.validateToolOutput(v2._registeredTools.create_design_brief, result, "create_design_brief"),
    ).resolves.toBeUndefined();
  });

  it("keeps errors as isError with no structured success payload", async () => {
    const client = new AwwwardsClient({
      fetchFn: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    const result = await createHandlers({ client, cache: new Cache(tmpDir()) }).create_design_brief({
      slugs: ["alpha", "beta"],
      goal: "a gallery",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect((result.content[0] as any).text).toContain("No usable design evidence");
  });

  it("drops structuredContent when the response exceeds the byte ceiling", async () => {
    const h = cachedHandlers();
    const server = withResponseLimit(512, () =>
      createServer({ handlers: h, version: "0.0.0-test" }),
    ) as any;
    const result = await server._registeredTools.create_design_brief.executor(args, {});

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      truncated: true,
      tool: "create_design_brief",
    });
    await expect(
      server.validateToolOutput(server._registeredTools.create_design_brief, result, "create_design_brief"),
    ).resolves.toBeUndefined();
  });
});
