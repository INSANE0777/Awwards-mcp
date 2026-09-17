# Awwwards MCP — parseDetail Live-Drift Fix Design Spec

Date: 2026-09-17
Status: Approved by user (design conversation, 2026-09-17)

## Problem

`parseDetail` (src/parsers.ts) is broken against **live** awwwards.com: pages return HTTP 200 but parse to all-empty `SiteDetails`, so `get_site_details` returns its parser-mismatch isError for any uncached slug. Found by the awwwards-inspiration skill's live smoke test (2026-09-17); pre-existing upstream layout drift — the fixture-era anchors (`<strong>HEX</strong>` palette markers, `>Color Palette</h2>`, `>Technologies & Tools</h2>`, `>Description</h2>`) no longer exist on live pages. The committed fixture `test/fixtures/detail.html` (captured ~2026-08) predates the drift, which is why all 66 offline tests pass while the live tool fails.

`search_sites` and `get_site_elements` still work live (verified 2026-09-17). The skill currently routes agents around `get_site_details`.

## Goal

Restore `get_site_details` against current live awwwards markup, TDD against a fresh live fixture, without changing the `SiteDetails` shape or tool contract.

## Approach

### 1. Probe first (before any parser change)

Fetch a fresh live detail page (pick the first card from a live `/websites/` fetch — a currently-listed site, NOT the stale `l-i-s-a` page), save as the new fixture, and report which anchors exist in the live HTML:

- `>Elements</h2>`, `>Color Palette</h2>` (Elements/palette section bounds — parseElements depends on these too)
- `<strong>HEX</strong>` palette markers; any JSON-LD / meta alternative carrying palette data
- `Technologies & Tools</h2>`, `>Description</h2>`, `heading-6`
- `<h1 class="heading-1` live-URL anchor, `og:image`, `budget-tag--` award badges

The probe output determines which selectors need rework and whether some data has moved (e.g., into JSON-LD) or is no longer server-rendered at all.

### 2. Fixture strategy

Replace `test/fixtures/detail.html` with the fresh live capture (the old capture stays in git history). Re-derive ALL fixture-dependent expectations from the new page's real values:

- `parseDetail` tests: new slug's real title / palette hexes / technologies / elements / awards / live URL / og:image
- `parseElements` tests: new element count/titles (prefer floors — `toBeGreaterThanOrEqual` — for counts that may vary between captures; keep exact assertions only for stable values like URLs)
- Server tests asserting fixture specifics (`get_site_details`, `get_site_elements`, fakeClient serving): update slugs/values accordingly

### 3. Parser rework (TDD)

Rewrite `parseDetail` selectors per the probe findings, keeping the `SiteDetails` contract and the section-bounding style (literal heading anchors + bounded slices) that the codebase already uses. Graceful degradation rules unchanged (missing section → empty array / null). The all-empty parser-mismatch guard in `get_site_details` stays as-is.

**Contingency:** if the probe shows a data class is no longer server-rendered at all (JS-loaded only), do not fake it — return the empty/null for that field and note it in the report; the tool contract tolerates partial parses. If EVERYTHING meaningful is JS-loaded (page is a client-rendered shell), STOP and report BLOCKED with the probe evidence — the fix would then be out of the parser's reach.

### 4. Verification

- Full offline suite green (66/66 baseline; counts may shift slightly if tests merge — report actuals)
- Live stdio probe: `get_site_details` on the fresh slug → `isError` false with real palette/technologies/awards; `get_site_elements` on the same slug still works
- `npm run smoke` still passes (listing + detail + thumbnail)

## Out of scope

- Fuzzy/semantic extraction, headless-browser rendering of awwwards pages
- Caching strategy changes
