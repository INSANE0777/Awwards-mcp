import { describe, expect, it } from "vitest";
import {
  compilePredicates,
  decodeCursor,
  encodeCursor,
  searchAtlas,
} from "../src/atlas/search.js";
import type {
  AtlasCursorPayload,
  AtlasSearchStore,
  SearchAtlasData,
  SearchAtlasInput,
  SearchAtlasResult,
} from "../src/atlas/search-types.js";
import {
  SEARCH_DAY,
  SEARCH_NOW,
  makeSnapshot,
  memoryStore,
} from "./helpers/atlas-search-fixture.js";

const TTL = 15 * 60_000;

function dataOrThrow(result: SearchAtlasResult<SearchAtlasData>): SearchAtlasData {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

function compile(input: SearchAtlasInput): Extract<ReturnType<typeof compilePredicates>, { ok: true }> {
  const compiled = compilePredicates(input);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return compiled;
}

function payload(overrides: Partial<AtlasCursorPayload> = {}): AtlasCursorPayload {
  const queryHash = overrides.queryHash ?? compile({ kind: "sections", query: "hero" }).queryHash;
  return {
    version: 1,
    revision: 3,
    queryHash,
    asOf: SEARCH_NOW,
    expiresAt: SEARCH_NOW + TTL,
    lastSortTuple: ["-1", "1", String(-SEARCH_NOW), "region-1"],
    ...overrides,
  };
}

describe("Atlas cursor encoding", () => {
  it("round-trips canonical base64url JSON", () => {
    const cursor = payload();
    const encoded = encodeCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = decodeCursor(encoded, { queryHash: cursor.queryHash }, cursor.revision, SEARCH_NOW);
    expect(decoded).toEqual({ ok: true, cursor });
  });

  it("rejects stale, mismatched, expired, oversized and malformed cursors", () => {
    const cursor = payload();
    const encoded = encodeCursor(cursor);
    const stale = decodeCursor(encoded, { queryHash: cursor.queryHash }, 4, SEARCH_NOW);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("CURSOR_STALE");

    const mismatch = decodeCursor(
      encoded,
      { queryHash: compile({ kind: "sections", query: "about" }).queryHash },
      cursor.revision,
      SEARCH_NOW,
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe("CURSOR_QUERY_MISMATCH");

    const expired = decodeCursor(
      encoded,
      { queryHash: cursor.queryHash },
      cursor.revision,
      SEARCH_NOW + TTL,
    );
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.error.code).toBe("CURSOR_EXPIRED");

    const oversized = decodeCursor(
      "a".repeat(4097),
      { queryHash: cursor.queryHash },
      cursor.revision,
      SEARCH_NOW,
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.error.code).toBe("CURSOR_INVALID");

    const invalidBase64 = decodeCursor(
      "!!!",
      { queryHash: cursor.queryHash },
      cursor.revision,
      SEARCH_NOW,
    );
    expect(invalidBase64.ok).toBe(false);
    if (!invalidBase64.ok) expect(invalidBase64.error.code).toBe("CURSOR_INVALID");

    const invalidJson = Buffer.from("not json", "utf8").toString("base64url");
    const badJson = decodeCursor(
      invalidJson,
      { queryHash: cursor.queryHash },
      cursor.revision,
      SEARCH_NOW,
    );
    expect(badJson.ok).toBe(false);
    if (!badJson.ok) expect(badJson.error.code).toBe("CURSOR_INVALID");

    const badVersion = decodeCursor(
      Buffer.from(JSON.stringify({ ...cursor, version: 2 }), "utf8").toString("base64url"),
      { queryHash: cursor.queryHash },
      cursor.revision,
      SEARCH_NOW,
    );
    expect(badVersion.ok).toBe(false);
    if (!badVersion.ok) expect(badVersion.error.code).toBe("CURSOR_INVALID");

    const badTuple = decodeCursor(
      encodeCursor({ ...cursor, lastSortTuple: [] }),
      { queryHash: cursor.queryHash },
      cursor.revision,
      SEARCH_NOW,
    );
    expect(badTuple.ok).toBe(false);
    if (!badTuple.ok) expect(badTuple.error.code).toBe("CURSOR_INVALID");

    const futureAsOf = decodeCursor(
      encodeCursor({ ...cursor, asOf: SEARCH_NOW + 10 * 60_000, expiresAt: SEARCH_NOW + 25 * 60_000 }),
      { queryHash: cursor.queryHash },
      cursor.revision,
      SEARCH_NOW,
    );
    expect(futureAsOf.ok).toBe(false);
    if (!futureAsOf.ok) expect(futureAsOf.error.code).toBe("CURSOR_INVALID");

    const longLifetime = decodeCursor(
      encodeCursor({ ...cursor, expiresAt: SEARCH_NOW + 20 * 60_000 }),
      { queryHash: cursor.queryHash },
      cursor.revision,
      SEARCH_NOW,
    );
    expect(longLifetime.ok).toBe(false);
    if (!longLifetime.ok) expect(longLifetime.error.code).toBe("CURSOR_INVALID");
  });
});

function countingStore(): { store: AtlasSearchStore; loads: () => number } {
  let loads = 0;
  return {
    store: {
      query: () => {
        loads += 1;
        return {
          ok: true,
          data: {
            revision: 1,
            ftsAvailable: true,
            hits: [],
            total: 0,
            hasMore: false,
            nextTuple: null,
            facets: [],
            corpus: { sites: 0, pages: 0, captures: 0 },
            eligibleRegions: 0,
            predicatePresence: {},
          },
        };
      },
    },
    loads: () => loads,
  };
}

describe("Atlas cursor preflight", () => {
  it("rejects malformed, oversized and expired cursors with zero store loads", () => {
    const { store, loads } = countingStore();
    const base = payload();
    const request = { kind: "sections", query: "hero" } as const;
    const cases: Array<{ cursor: string; code: string }> = [
      { cursor: "a".repeat(4097), code: "CURSOR_INVALID" },
      { cursor: "!!!", code: "CURSOR_INVALID" },
      {
        cursor: Buffer.from("not json", "utf8").toString("base64url"),
        code: "CURSOR_INVALID",
      },
      {
        cursor: Buffer.from(JSON.stringify({ ...base, version: 2 }), "utf8").toString("base64url"),
        code: "CURSOR_INVALID",
      },
      { cursor: encodeCursor({ ...base, lastSortTuple: ["2", "-1", "region-1"] }), code: "CURSOR_INVALID" },
      { cursor: encodeCursor({ ...base, lastSortTuple: ["x", "1", "-1", "region-1"] }), code: "CURSOR_INVALID" },
      {
        cursor: encodeCursor({ ...base, asOf: SEARCH_NOW + 10 * 60_000, expiresAt: SEARCH_NOW + 25 * 60_000 }),
        code: "CURSOR_INVALID",
      },
      {
        cursor: encodeCursor({ ...base, expiresAt: SEARCH_NOW + 20 * 60_000 }),
        code: "CURSOR_INVALID",
      },
      {
        cursor: encodeCursor({
          ...base,
          asOf: SEARCH_NOW - 16 * 60_000,
          expiresAt: SEARCH_NOW - 60_000,
        }),
        code: "CURSOR_EXPIRED",
      },
    ];
    for (const item of cases) {
      const result = searchAtlas({ ...request, cursor: item.cursor }, store, SEARCH_NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(item.code);
    }
    expect(loads()).toBe(0);
  });
});

describe("Atlas cursor pagination", () => {
  const snapshot = makeSnapshot(
    Array.from({ length: 5 }, (_, index) => ({
      id: `s${index}`,
      page: `page-${index}`,
      observedAt: SEARCH_NOW - (index + 1) * SEARCH_DAY,
    })),
  );

  it("returns non-overlapping pages and rejects a changed limit", () => {
    const first = dataOrThrow(
      searchAtlas({ kind: "sections", limit: 2 }, memoryStore(snapshot), SEARCH_NOW),
    );
    const second = dataOrThrow(
      searchAtlas(
        { kind: "sections", limit: 2, cursor: first.nextCursor! },
        memoryStore(snapshot),
        SEARCH_NOW,
      ),
    );
    expect(first.results.map((hit) => hit.regionId)).toEqual(["s0", "s1"]);
    expect(second.results.map((hit) => hit.regionId)).toEqual(["s2", "s3"]);
    expect(second.total).toBe(5);

    const changed = searchAtlas(
      { kind: "sections", limit: 3, cursor: first.nextCursor! },
      memoryStore(snapshot),
      SEARCH_NOW,
    );
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.code).toBe("CURSOR_QUERY_MISMATCH");
  });

  it("keeps subsequent cursors anchored to the original asOf expiry", () => {
    const first = dataOrThrow(
      searchAtlas({ kind: "sections", limit: 2 }, memoryStore(snapshot), SEARCH_NOW),
    );
    const second = dataOrThrow(
      searchAtlas(
        { kind: "sections", limit: 2, cursor: first.nextCursor! },
        memoryStore(snapshot),
        SEARCH_NOW + 10 * 60_000,
      ),
    );
    expect(second.nextCursor).not.toBeNull();
    const third = dataOrThrow(
      searchAtlas(
        { kind: "sections", limit: 2, cursor: second.nextCursor! },
        memoryStore(snapshot),
        SEARCH_NOW + 14 * 60_000,
      ),
    );
    expect(third.results.map((hit) => hit.regionId)).toEqual(["s4"]);
    const expired = searchAtlas(
      { kind: "sections", limit: 2, cursor: second.nextCursor! },
      memoryStore(snapshot),
      SEARCH_NOW + 15 * 60_000,
    );
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.error.code).toBe("CURSOR_EXPIRED");
  });

  it("rejects invalid sort tuples before matching", () => {
    const request: SearchAtlasInput = { kind: "sections", limit: 2 };
    const compiled = compile(request);
    const invalidTuple = encodeCursor({
      version: 1,
      revision: snapshot.revision,
      queryHash: compiled.queryHash,
      asOf: SEARCH_NOW,
      expiresAt: SEARCH_NOW + TTL,
      lastSortTuple: ["one", "two", "three", "region"],
    });
    const result = searchAtlas(
      { ...request, cursor: invalidTuple },
      memoryStore(snapshot),
      SEARCH_NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CURSOR_INVALID");
  });

  it("rejects a cursor after the revision changes", () => {
    const first = dataOrThrow(
      searchAtlas({ kind: "sections", limit: 2 }, memoryStore(snapshot), SEARCH_NOW),
    );
    const stale = searchAtlas(
      { kind: "sections", limit: 2, cursor: first.nextCursor! },
      memoryStore(makeSnapshot(snapshot.regions.map((region) => ({ id: region.id })), { revision: 2 })),
      SEARCH_NOW,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("CURSOR_STALE");
  });

  it("expires cursors after fifteen minutes", () => {
    const first = dataOrThrow(
      searchAtlas({ kind: "sections", limit: 2 }, memoryStore(snapshot), SEARCH_NOW),
    );
    const expired = searchAtlas(
      { kind: "sections", limit: 2, cursor: first.nextCursor! },
      memoryStore(snapshot),
      SEARCH_NOW + TTL,
    );
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.error.code).toBe("CURSOR_EXPIRED");
  });

  it("freezes age at the cursor asOf", () => {
    const boundary = makeSnapshot([
      { id: "s0", page: "page-0", observedAt: SEARCH_NOW - SEARCH_DAY },
      { id: "s1", page: "page-1", observedAt: SEARCH_NOW - 2 * SEARCH_DAY },
      {
        id: "s2",
        page: "page-2",
        observedAt: SEARCH_NOW - 30 * SEARCH_DAY + 60_000,
      },
    ]);
    const first = dataOrThrow(
      searchAtlas({ kind: "sections", limit: 2 }, memoryStore(boundary), SEARCH_NOW),
    );
    expect(first.results.map((hit) => hit.regionId)).toEqual(["s0", "s1"]);
    const second = dataOrThrow(
      searchAtlas(
        { kind: "sections", limit: 2, cursor: first.nextCursor! },
        memoryStore(boundary),
        SEARCH_NOW + 2 * 60_000,
      ),
    );
    expect(second.results.map((hit) => hit.regionId)).toEqual(["s2"]);
  });

  it("paginates newest sort and pattern groups without overlap", () => {
    const newestSnapshot = makeSnapshot(
      Array.from({ length: 5 }, (_, index) => ({
        id: `n${index}`,
        page: `page-${index}`,
        observedAt: SEARCH_NOW - (index + 1) * SEARCH_DAY,
      })),
    );
    const first = dataOrThrow(
      searchAtlas(
        { kind: "sections", sort: "newest", limit: 2 },
        memoryStore(newestSnapshot),
        SEARCH_NOW,
      ),
    );
    const second = dataOrThrow(
      searchAtlas(
        { kind: "sections", sort: "newest", limit: 2, cursor: first.nextCursor! },
        memoryStore(newestSnapshot),
        SEARCH_NOW,
      ),
    );
    expect(first.results.map((hit) => hit.regionId)).toEqual(["n0", "n1"]);
    expect(second.results.map((hit) => hit.regionId)).toEqual(["n2", "n3"]);
  });

  it("rejects section pattern grouping instead of reporting region counts", () => {
    const result = searchAtlas(
      { kind: "sections", groupBy: "pattern" },
      memoryStore(snapshot),
      SEARCH_NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNSUPPORTED_GROUPING");
  });
});

describe("Atlas query hash", () => {
  it("includes filters, evidence mode, sort, facets and limit", () => {
    const base = compile({ kind: "sections", query: "hero" }).queryHash;
    const variants = [
      compile({ kind: "sections", query: "hero", scope: "page" }),
      compile({ kind: "sections", query: "hero", evidenceMode: "accepted" }),
      compile({ kind: "sections", query: "hero", sort: "newest" }),
      compile({ kind: "sections", query: "hero", facets: ["section.purpose"] }),
      compile({ kind: "sections", query: "hero", limit: 3 }),
      compile({ kind: "sections", query: "hero", maxAgeDays: 7 }),
    ];
    for (const variant of variants) expect(variant.queryHash).not.toBe(base);
    expect(compile({ kind: "sections", query: "HERO" }).queryHash).toBe(base);
  });
});
