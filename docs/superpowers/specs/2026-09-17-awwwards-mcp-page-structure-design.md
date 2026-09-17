# Awwwards MCP — Page Structure Analysis Design Spec

Date: 2026-09-17
Status: Approved by user (design conversation, 2026-09-17)
Parent specs: v1, local-index, element-visuals designs. Version target: 1.4.0.

## Problem (learned from the cerebrium.ai recreation loop)

The capture→recreate loop failed twice for structural reasons that full-page screenshots alone did not surface:
1. Hero-only thumbnails hid page structure — fixed by the full-page capture mandate (v1.3.0).
2. The recreation matched the reference's **total page height** while inflating an empty spacer band to 1,200px — section distribution was wrong and the error was only found by manual pixel-band analysis (ad-hoc Python row-luminance scan comparing reference vs build captures).

The comparison step that caught the bug is not a tool, and the skill does not mandate it.

## Goal

A `analyze_page_structure({ url })` MCP tool returning a page's section band map (DOM ground truth), plus skill doctrine making reference-vs-build band comparison a mandatory loop step.

## Design

### Tool: `analyze_page_structure({ url })`

Returns one JSON text block:

```
PageStructure {
  url: string
  title: string
  totalHeight: number          // document scrollHeight
  bands: PageBand[]            // top-to-bottom, capped (default 40)
}
PageBand {
  index: number
  tag: string                  // "section" | "header" | "footer" | "div" | ...
  label: string                // "#id" and/or ".first-class" ("" when anonymous)
  background: string           // computed background-color, "rgb(r, g, b)" or "transparent"
  offsetTop: number            // px from document top (rounded)
  height: number               // px (rounded)
  textStart: string            // first ~60 chars of the band's own visible text
}
```

Works for `https://` and `file://` URLs (Playwright handles both) — so the same tool analyzes a live reference AND the agent's local build.

### Extraction approach (DOM, not pixels)

`page.evaluate` walks the document and collects candidates: elements with `rect.height ≥ 120` whose computed background-color differs from their parent's (plus `body`'s own background as the base band). Raw candidates → pure `collapseBands()`:

- drop bands fully contained in a taller band with the same effective background (nested duplicates)
- merge adjacent bands with same background AND same label
- sort by offsetTop, cap at `maxBands` (default 40)
- round all coordinates

Rationale: DOM measurement is exact (no PNG decoding dependency in the server; the pixel-luminance scan was only ever a proxy because we compared screenshots). Heuristic limits are documented in-code; the tool surfaces data — the agent does the comparison reasoning.

### Files

| File | Change |
|------|--------|
| `src/structure.ts` (new) | `analyzePageStructure(url, loader?)` mirroring `capture.ts`'s optional-Playwright pattern (dynamic `import("playwright" as string)`, install-hint error object, never-throw shape `{ structure } | { error }`); exports pure `collapseBands(raw, maxBands?)` and the `page.evaluate` walk snippet; `goto` with `networkidle`, 45s timeout; browser closed in `finally` (close guarded); scroll through the page first (450px steps) so lazy-rendered sections have layout |
| `src/server.ts` | `analyze_page_structure` handler: `{ url }` (http/https/file only), calls the module (lazy dynamic import like capture), formats `PageStructure` as JSON text block; install-hint → isError text; never-throw |
| `src/cli.ts` | Register tool: `url: z.string().url()`, `maxBands: z.number().int().min(5).max(60).default(40)` |
| `skills/awwwards-inspiration/SKILL.md` | New loop step 8 (structure compare), new anti-pattern, two polish items, tool-reference row |
| `README.md` + `package.json` | Tools table row; version 1.4.0 |

### SKILL.md changes (exact doctrine)

New loop step (after step 7 "state the design direction"):
> **8. Verify structure, then polish.** After building, capture your own build full-page (`capture_live_site` on its `file://` or served URL) and run `analyze_page_structure` on BOTH the reference and the build. Compare band maps section by section (count, order, backgrounds, heights). Fix distribution mismatches first — a section that is 3× the reference's height is a structural bug no amount of pixel polish fixes. Match the reference's band structure, never just its total height.

New anti-pattern:
> **Padding empty bands to match total height** — if your build's total height matches the reference but a spacer/background band is far taller than the reference's equivalent, the height is stolen from real content sections. Compare band maps, not totals.

Polish: step 4's capture mandate explicitly includes capturing YOUR OWN BUILD (not just the reference); spacer/decorative elements must be measured against the reference's equivalent, never invented.

## Error handling

- Playwright missing → install-hint `{ error }` → handler isError (same as capture)
- `goto` failure / bad URL → isError with the message; page-level runtime errors propagate to the handler's error path (module/launch failures get the hint, page errors get real messages — the capture.ts scoping pattern)
- Bands capped; pages with no detectable bands (all-transparent, tiny) → bands: [] with totalHeight still reported (legitimate, not an error)

## Testing

- `collapseBands` pure tests (offline): nested same-bg dedupe, adjacent merge, ordering, cap, rounding
- `analyzePageStructure` test with injected loader (fake playwright: evaluate returns canned raw bands; goto/launch/close lifecycle asserted via the fake)
- Handler tests: success → JSON text block contains url/title/bands; module error path → isError with hint; no cache interaction
- Registration covered by a live stdio probe (manual): analyze the cerebrium.ai URL and the local build `file://` — build totalHeight ≈ 10,870, first band dark, light shell bands present
- Suite target: 66 → ≥72, all offline

## Out of scope

- Pixel-level diffing, visual regression screenshots comparison
- Automatic "fix" suggestions — the tool reports, the agent reasons
- Persisting band maps to the cache
