import { describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/tools/index.js";
import { createHandlers } from "../../src/server.js";
import type { AwwwardsClient } from "../../src/awwwards.js";
import type { Cache } from "../../src/cache.js";
import type { ComponentPack } from "../../src/component.js";

// createHandlers needs client+cache typed slots, but every test here injects a
// capture fn that never touches them — dummies keep the file offline.
const deps = (extra: object) =>
  ({
    client: null as unknown as AwwwardsClient,
    cache: null as unknown as Cache,
    ...extra,
  }) as Parameters<typeof createHandlers>[0];

const pack: ComponentPack = {
  id: "component-pack-v1",
  url: "https://example.dev/",
  selector: "body",
  capturedAt: 1_700_000_000_000,
  viewport: { width: 1440, height: 900 },
  nodeCount: 2,
  root: {
    tag: "body",
    classes: [],
    rect: { x: 0, y: 0, w: 1440, h: 900 },
    styles: { color: "rgb(255, 0, 0)" },
    children: [],
  },
  fonts: [],
  colors: [],
};

describe("export_design_tokens handler", () => {
  it("materializes body/desktop/800 and returns 1-space JSON", async () => {
    const seen: Array<{ url: string; opts?: { selector?: string; viewport?: string; maxNodes?: number } }> = [];
    const h = createHandlers(
      deps({
        captureComponentFn: async (url, opts) => {
          seen.push({ url, opts });
          return pack;
        },
      }),
    );

    const res = await h.export_design_tokens({ url: pack.url });
    expect(res.isError).toBeUndefined();
    expect(seen).toEqual([
      { url: pack.url, opts: { selector: "body", viewport: "desktop", maxNodes: 800 } },
    ]);

    const raw = (res.content[0] as any).text as string;
    expect(raw).toContain('\n "url"');
    const parsed = JSON.parse(raw);
    expect(parsed.url).toBe(pack.url);
    expect(parsed.selector).toBe("body");
    expect(parsed.viewport).toBe("desktop");
    expect(parsed.tokens.colors).toEqual([{ name: "--color-1", value: "#ff0000", count: 1 }]);
  });

  it("forwards include to the reducer", async () => {
    const h = createHandlers(deps({ captureComponentFn: async () => pack }));
    const res = await h.export_design_tokens({ url: pack.url, include: ["colors"] });
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.coverage.sources).toEqual(["colors"]);
    expect(parsed.tokens.spacing).toEqual([]);
  });

  it("passes capture errors through as error responses", async () => {
    const h = createHandlers(
      deps({ captureComponentFn: async () => ({ error: "selector not found: body" }) }),
    );
    const res = await h.export_design_tokens({ url: pack.url });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain("selector not found: body");
  });

  it("is registered once with non-idempotent open-world annotations", () => {
    const regs: any[][] = [];
    const tool = (...args: any[]) => regs.push(args);
    registerAllTools({ handlers: {} as any, tool, registerTool: tool }, { atlas: false });

    const matches = regs.filter((args) => args[0] === "export_design_tokens");
    expect(matches).toHaveLength(1);
    expect(matches[0]![3]).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(matches[0]![1]).toContain("any URL");
    expect(matches[0]![1]).toContain("ordinal");
  });
});
