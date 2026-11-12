import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Documentation guard for the Phase 6 Atlas surface. Text-only on purpose: it
// must pass before the 6A/6B handlers land, and it pins the operator-facing
// claims that are easy to drop. Executable checks belong to the tool-surface
// tests added at integration.
const ATLAS_DOC = readFileSync(new URL("../ATLAS.md", import.meta.url), "utf8");
const README_DOC = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const README_ATLAS = README_DOC.slice(README_DOC.indexOf("## Atlas (experimental, opt-in)"));
const README_ATLAS_FLAT = README_ATLAS.replace(/\s+/g, " ");
const F9_GATE = ATLAS_DOC.slice(
  ATLAS_DOC.indexOf("**F9 held-out component gate"),
  ATLAS_DOC.indexOf("## Phase 4B"),
);
const F9_SECTION = ATLAS_DOC.slice(
  ATLAS_DOC.indexOf("## Component held-out review (F9)"),
  ATLAS_DOC.indexOf("## Next phase"),
);

const TOOLS = ["search_atlas", "get_atlas", "capture_atlas", "export_evidence_pack"];

function jsonFenceContaining(marker: string): unknown {
  for (const match of ATLAS_DOC.matchAll(/```json\r?\n([\s\S]*?)```/g)) {
    const body = match[1]!;
    if (body.includes(marker)) return JSON.parse(body);
  }
  throw new Error(`no JSON fence contains ${marker}`);
}

describe("Atlas documentation", () => {
  it("documents the flag and both profile-count states", () => {
    expect(README_DOC).toContain("## Atlas (experimental, opt-in)");
    expect(ATLAS_DOC).toContain("## Using Atlas (Phase 6)");
    expect(README_DOC).toContain("AWWWARDS_MCP_ATLAS=1");
    expect(ATLAS_DOC).toContain("AWWWARDS_MCP_ATLAS=1");

    for (const doc of [README_DOC, ATLAS_DOC]) {
      expect(doc).toContain("| `full` (default) | 41 | 45 |");
      expect(doc).toContain("| `core` | 13 | 13 |");
      expect(doc).toContain("| `v2` | 15 | 16 |");
    }
  });

  it("documents every Atlas tool and its annotations", () => {
    for (const tool of TOOLS) expect(ATLAS_DOC).toContain(`\`${tool}\``);

    expect(ATLAS_DOC).toContain("| `search_atlas` | yes | yes | no |");
    expect(ATLAS_DOC).toContain("| `get_atlas` | yes | yes | no |");
    expect(ATLAS_DOC).toContain("| `capture_atlas` | no | no | yes |");
    expect(ATLAS_DOC).toContain("| `export_evidence_pack` | no | yes | no |");
  });

  it("pins the v2 branches and the one extra v2 tool", () => {
    for (const branch of [
      "atlas_region",
      "atlas_highlight",
      "atlas_taxonomy",
      "atlas_status",
    ]) {
      expect(ATLAS_DOC).toContain(`"${branch}"`);
    }

    expect(ATLAS_DOC).toContain('`search_references` | `request.kind: "sections"`');
    expect(ATLAS_DOC).toContain('`capture_page` | `request.kind: "atlas"`');
    expect(ATLAS_DOC).toContain("a new flat tool, not a branch");
  });

  it("documents every CLI action and the prune safety rule", () => {
    for (const action of [
      "--atlas import",
      "--atlas capture",
      "--atlas reindex",
      "--atlas verify",
      "--atlas prune",
    ]) {
      expect(ATLAS_DOC).toContain(action);
    }

    expect(ATLAS_DOC).toContain("--apply");
    expect(ATLAS_DOC).toContain("Dry-run by default");
    expect(ATLAS_DOC).toContain("never removes active-head evidence");
  });

  it("keeps the evidence honesty and rights boundaries", () => {
    expect(README_ATLAS_FLAT).toContain("candidate-only");
    expect(README_ATLAS_FLAT).toContain("not met");
    expect(README_ATLAS_FLAT).toContain("never fetches the old gallery page");
    expect(README_ATLAS_FLAT).toContain("does **not** embed the raw component tree by default");
    expect(README_ATLAS_FLAT).toContain("no arbitrary output path");
    expect(README_ATLAS_FLAT).toContain("unknown or restricted artifacts are excluded");

    expect(ATLAS_DOC).toContain("does not embed a raw component tree by default");
    expect(ATLAS_DOC).toContain("no arbitrary output path, overwrite switch");
    expect(ATLAS_DOC).toContain("Unknown rights stay unknown");
    expect(ATLAS_DOC).toContain("never proof of absence");
  });

  it("keeps the documented errors and the deliberate evidence-mode deviation", () => {
    for (const code of [
      "FEATURE_DISABLED",
      "INVALID_SELECTION",
      "AMBIGUOUS_ALIAS",
      "CAPTURE_BUSY",
      "PACK_CORRUPT",
      "SCHEMA_TOO_NEW",
    ]) {
      expect(ATLAS_DOC).toContain(`\`${code}\``);
    }

    expect(ATLAS_DOC).toContain("Default evidence mode is a deliberate deviation");
    expect(ATLAS_DOC).toContain("Spec §10.1 names `accepted` as the default");
    expect(ATLAS_DOC).toContain("does not claim §10.1 compliance");
  });

  it("keeps the status publication shape and lease values honest", () => {
    const status = jsonFenceContaining('"latestPublication"') as {
      data: {
        latestPublication: Record<string, unknown>;
        lease: Record<string, unknown>;
      };
    };
    expect(Object.keys(status.data.latestPublication)).toEqual([
      "publishedAt",
      "pageId",
      "captureId",
      "profileKey",
    ]);
    expect(status.data.latestPublication).not.toHaveProperty("siteSlug");
    expect(status.data.lease).toEqual({ state: "free", expiresAt: null, ttlSeconds: null });
    expect(ATLAS_DOC).toContain("lease TTL is 150 seconds");
    expect(ATLAS_DOC).toContain("at most 150 while held");
  });

  it("keeps verify a read-only census that never mutates evidence", () => {
    expect(ATLAS_DOC).toContain("Offline, read-only artifact-integrity census");
    expect(ATLAS_DOC).toContain("exits 1 when any issue exists");
    expect(ATLAS_DOC).toContain("never marks, rewrites or withdraws evidence");
    expect(ATLAS_DOC).not.toContain("can mark artifacts missing/corrupt");
    expect(ATLAS_DOC).toContain("no database write is performed, no head is withdrawn");
  });

  it("keeps TARGET_CHANGED inconclusive and out of the blocked list", () => {
    const blockedLine = ATLAS_DOC.split(/\r?\n/).find((line) =>
      line.startsWith("- A blocked policy result"),
    );
    const blockedCodes = (blockedLine ?? "").slice(
      (blockedLine ?? "").indexOf("("),
      (blockedLine ?? "").indexOf(")"),
    );
    expect(blockedCodes).toContain("POLICY_BLOCKED");
    expect(blockedCodes).not.toContain("TARGET_CHANGED");
    expect(ATLAS_DOC).toContain(
      "A page destination that changes during collection is `inconclusive` with `TARGET_CHANGED`",
    );
    expect(ATLAS_DOC).not.toContain("TARGET_NOT_FOUND");
  });

  it("pins the predicate value and siteSlug limits", () => {
    expect(ATLAS_DOC).toContain("Each predicate carries 1–8 canonical values");
    expect(ATLAS_DOC).toContain("1–8 canonical values per predicate");
    expect(ATLAS_DOC).toContain("1–20 distinct cached site slugs; duplicates are rejected");
    expect(ATLAS_DOC).toContain("`siteSlugs` 1–20 distinct");
  });

  it("documents component reuse without claiming component completeness", () => {
    expect(ATLAS_DOC).toContain("`components` is recorded in the capture config hash");
    expect(ATLAS_DOC).toContain("reuse is matched on the requested states, not on `components`");
    expect(ATLAS_DOC).toContain("`COMPONENTS_NOT_COLLECTED`");
    expect(ATLAS_DOC).toContain("A `components: false` request only omits component summaries");
    expect(ATLAS_DOC).not.toContain("`components` is not part of the stored config hash");
  });

  it("pins the accepted 32 MiB export cap against spec 16", () => {
    expect(ATLAS_DOC).toContain("32 MiB is the accepted release cap; spec §16 allows 64 MiB");
    expect(ATLAS_DOC).toContain("the spec §16 64 MiB allowance is not implemented");
    expect(ATLAS_DOC).toContain("this release caps copies at 32 MiB, the accepted release cap");
  });

  it("keeps the F9 component held-out contract honest", () => {
    expect(F9_GATE).toContain("not met");
    expect(F9_GATE).toContain("not scoreable by the current harness");
    expect(F9_GATE).toContain("retained only as calibration history");
    expect(F9_GATE).toContain("does not validate the current blind export");

    expect(F9_SECTION).toContain("scorable accepted components");
    expect(F9_SECTION).toContain("0.95");
    expect(F9_SECTION).toContain("capture|viewport|nodeKey");
    expect(F9_SECTION).toContain("at least 20 accepted samples");
    expect(F9_SECTION).toContain("exit 0 even when the gate is `fail` or `insufficient`");
    expect(F9_SECTION).toContain("Only `components-review.json` may be shared with labelers");
    expect(F9_SECTION).toContain("report-only");

    // Nav exception, bounded label and the full trigger contract.
    expect(F9_SECTION).toContain("a bounded 200-character `ariaLabel` matching `breadcrumb`");
    expect(F9_SECTION).toContain("otherwise `navigation`");
    expect(F9_SECTION).toContain("bounded 200-character `ariaLabel`");
    expect(F9_SECTION).toContain("page scan's component hint");
    expect(F9_SECTION).not.toContain("The classifier matches");
    expect(F9_SECTION).toContain("the blind row carries the same value");
    expect(F9_SECTION).toContain(
      "`nav` landmark without a button/link role follows the breadcrumb/pagination/navigation exception",
    );
    expect(F9_SECTION).not.toContain("raw `ariaLabel`");
    expect(F9_SECTION).toContain("`inNavigation` is true");
    expect(F9_SECTION).toContain('`role="button"` or `role="link"`');
    expect(F9_SECTION).toContain("`aria-controls` resolves to real content");
    expect(F9_SECTION).toContain("is not a trigger");

    // The symlink refusal sentence, verbatim.
    expect(F9_SECTION).toContain(
      "A symlinked or junction page directory is refused with `HELDOUT_COMPONENT_INVALID_CORPUS` instead of being skipped",
    );
  });

  it("documents the result-envelope data rules", () => {
    expect(ATLAS_DOC).toContain("`ok` and `partial` always carry operation data in `data`");
    expect(ATLAS_DOC).toContain("`inconclusive` carries resolved evidence when the operation produced any");
    expect(ATLAS_DOC).toContain("`blocked` and `error` carry `data: null`");
    expect(ATLAS_DOC).toContain("also return `structuredContent` with the envelope");
  });

  it("documents only real collector warning and limitation codes", () => {
    for (const code of [
      "DOM_NODE_LIMIT",
      "SECTION_TRUNCATION",
      "SECTION_EXCLUDED",
      "NO_SECTIONS",
      "SCREENSHOT_LIMIT",
      "SCREENSHOT_FAILED",
      "SCREENSHOT_EMPTY",
      "SCREENSHOT_INVALID",
      "SCREENSHOTS_MISSING",
      "CHECKPOINT_LIMIT",
      "CHECKPOINT_EVIDENCE_LIMIT",
      "CHECKPOINT_SECTION_TRUNCATION",
      "CHECKPOINT_SECTION_EXCLUDED",
      "CHECKPOINT_OBSERVATION_MISSING",
      "SCROLL_ROOT_UNKNOWN",
      "SCROLL_OFFSET_MISMATCH",
      "REDIRECT_LIMIT",
      "RESOURCE_NETWORK_ERROR",
      "COMPONENT_CAP",
      "COMPONENT_PACK_CAP",
      "COMPONENT_PACK_TRUNCATED",
      "COMPONENTS_NOT_COLLECTED",
      "POLICY_BLOCKED",
      "BLOCKED_DESTINATION",
      "CAPTURE_DEADLINE_EXCEEDED",
      "STATE_TARGET_MISSING",
      "STATE_TARGET_AMBIGUOUS",
      "STATE_TARGET_CHANGED",
      "STATE_TARGET_FULL_VIEWPORT",
      "STATE_HOVER_NOT_ACTIVE",
      "STATE_FOCUS_UNCONFIRMED",
      "STATE_FOCUS_NOT_VISIBLE",
      "STATE_NO_CHANGE",
      "STATE_PROBE_FAILED",
      "STATE_DEADLINE_EXCEEDED",
      "STATE_RESET_FAILED",
      "STATE_ARTIFACT_LIMIT",
      "LEGACY_DETAIL_MISSING",
      "LEGACY_ELEMENTS_MISSING",
      "LEGACY_ELEMENTS_MALFORMED",
      "LEGACY_GALLERY_NO_SOURCE_ARTIFACT",
      "MISSING_TIMESTAMP",
    ]) {
      expect(ATLAS_DOC).toContain(code);
    }

    for (const invented of [
      "NODE_CAP",
      "DEPTH_CAP",
      "SECTION_CAP",
      "SCREENSHOT_CAP",
      "PARTIAL_REGION_IMAGE",
      "TOKEN_SAMPLE_CAP",
      "STATE_NOT_REQUESTED",
      "UNSUPPORTED_FRAME",
      "UNSUPPORTED_SHADOW_CONTENT",
      "RESOURCE_FAILURE",
      "STALE_EVIDENCE",
      "LEGACY_PROVENANCE_INCOMPLETE",
    ]) {
      expect(ATLAS_DOC).not.toContain(invented);
    }
    expect(ATLAS_DOC).toContain("Candidate-mode search also adds the `CLASSIFICATION_AMBIGUOUS` warning");
  });

  it("adds flag-on counts to every unconditional README surface statement", () => {
    expect(README_DOC).toContain("`full` keeps all 41 (45 with `AWWWARDS_MCP_ATLAS=1`)");
    expect(README_DOC).toContain(
      "15-tool consolidated surface (16 with `AWWWARDS_MCP_ATLAS=1`)",
    );
    expect(README_DOC).toContain(
      "`full` = 41, `core` = 13, `v2` = 15 (45 / 13 / 16 with `AWWWARDS_MCP_ATLAS=1`)",
    );
    expect(README_DOC).toContain("**41 / 13 / 15** tool surface (**45 / 13 / 16** with");
    expect(README_DOC).toContain("default 41-tool surface (45 with");
    expect(README_DOC).toContain("15 tools (16 with `AWWWARDS_MCP_ATLAS=1`)");
    expect(README_DOC).toContain("the same check reports 45 tools");
  });

  it("uses the exact Atlas flag name", () => {
    expect(ATLAS_DOC).not.toContain("AWWARDS_MCP_ATLAS");
    expect(README_DOC).not.toContain("AWWARDS_MCP_ATLAS");
  });

  it("keeps every Atlas JSON example parseable", () => {
    const fences = [...ATLAS_DOC.matchAll(/```json\r?\n([\s\S]*?)```/g)];
    expect(fences.length).toBeGreaterThanOrEqual(10);
    for (const [, body] of fences) {
      expect(() => JSON.parse(body!)).not.toThrow();
    }
  });
});
