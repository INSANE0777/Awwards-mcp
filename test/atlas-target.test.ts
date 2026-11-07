import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../src/cache.js";
import { resolveAtlasTarget } from "../src/atlas/target.js";
import type { SiteSummary } from "../src/types.js";

const dirs: string[] = [];
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "awwwards-atlas-target-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const site = (liveUrl: string | null): SiteSummary => ({
  id: 1,
  slug: "known-site",
  title: "Known",
  createdAt: 1,
  tags: [],
  thumbnailPath: "submissions/known.jpg",
  liveUrl,
  detailPath: "/sites/known-site",
  awards: [],
  studio: "Studio",
});

describe("Atlas target resolution", () => {
  it("resolves the cached live origin and strips tracking-only root queries", () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site("https://example.com/?utm_source=awwwards&gclid=abc")]);
    const result = resolveAtlasTarget({ siteSlug: "known-site" }, { cache });
    expect(result).toMatchObject({
      ok: true,
      target: {
        siteSlug: "known-site",
        requestedUrl: "https://example.com/",
        path: "/",
      },
    });
  });

  it("accepts an explicit path on the known origin", () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site("https://example.com")]);
    const result = resolveAtlasTarget(
      { siteSlug: "known-site", path: "/work/case-study" },
      { cache },
    );
    expect(result).toMatchObject({
      ok: true,
      target: { requestedUrl: "https://example.com/work/case-study" },
    });
  });

  it("rejects meaningful queries, fragments and protocol-relative paths", () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site("https://example.com/?page=2")]);
    expect(resolveAtlasTarget({ siteSlug: "known-site" }, { cache })).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_ROUTE",
    });
    for (const path of ["work", "//evil.example/x", "/work?x=1", "/work#x"]) {
      expect(resolveAtlasTarget({ siteSlug: "known-site", path }, { cache })).toMatchObject({
        ok: false,
        code: "UNSUPPORTED_ROUTE",
      });
    }
  });

  it("rejects credentials and missing references", () => {
    const cache = new Cache(tmpDir());
    cache.upsertSites([site("https://user:pass@example.com/")]);
    expect(resolveAtlasTarget({ siteSlug: "known-site" }, { cache })).toMatchObject({
      ok: false,
      code: "CREDENTIAL_URL",
    });
    expect(resolveAtlasTarget({ siteSlug: "missing-site" }, { cache })).toMatchObject({
      ok: false,
      code: "REFERENCE_UNAVAILABLE",
    });
  });
});
