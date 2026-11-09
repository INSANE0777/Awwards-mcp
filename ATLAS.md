# Atlas (experimental)

Atlas is the section-level evidence layer for awwwards-mcp. It is **opt-in** and off by default:

```bash
AWWWARDS_MCP_ATLAS=1
```

It adds capture, segmentation, checkpoint evidence, publication, candidate section labels and local search to the existing SQLite cache. It does **not** add or change MCP tools; tool exposure belongs to a later phase.

## Status

Phase 4B explicit hover/focus state capture and state-aware search are implemented locally and pass their focused test gates. Classification is still **not calibrated** and is not advertised as accepted.

- Held-out corpus: 50 usable pages
- Scored: 49 pages, 1,883 sections
- Label source: model review, **non-human**
- Candidate precision: **0.787**
- Candidate recall: **0.147**
- Accepted-label coverage: **0**

The spec gate in `docs/atlas-spec.md` requires accepted-label precision >= 0.90 and recall >= 0.80. That gate is **not met**.

## Deliberate deviation

Every section label written by Atlas is `candidate`. Nothing is promoted to `accepted`. Candidate labels are evidence hints, not reliable search facets, and must not be described as validated taxonomy.

Search therefore defaults to `evidenceMode: "candidate"` and marks every hit `candidateOnly: true`. `accepted` mode never includes candidates.

Structural labels are stronger than content labels:

| Class | Precision | Recall |
|---|---:|---:|
| header | 1.000 | 1.000 |
| footer | 1.000 | 0.737 |
| navigation | 1.000 | 0.667 |
| hero | 0.708 | 0.318 |
| services | n/a | 0 |

Content classes (services, features, pricing, process, CTA, product listing) need recall work before they can be exposed as filters.

## Phase 3 search

Implemented locally, with no MCP tool registration:

- Section predicates over `section.purpose`, `region.kind`, `region.tag`, `region.role` and `region.landmark`
- `region.kind` for `kind: "sections"` accepts only `section`; `page`, `highlight` and `component` are rejected with `UNSUPPORTED_PREDICATE`, so a section anchor can never match through a kind the corpus does not publish
- Region, page and site witness scopes with same-region, same-capture and same-site evidence
- Disjunctive facets whose candidate values pass the same canonicalization and support check as predicates; an unsupported tag, role, landmark or purpose never appears in a facet
- Facet counts are disjunctive; predicates are conjunctive. At region scope each advertised value counts the results that would match if that value replaced the field's current values. At page and site scope a value counts matching region occurrences inside the matched scopes, and selecting it applies the normal witness rule, so a scope can still match through a different witness than the counted occurrence. To select several values in one field, send one predicate with OR values (`values: ["header", "footer"]`); two same-field predicates are separate AND requirements (one region cannot be both header and footer, while a page or site can satisfy them through distinct witnesses), so adding a second predicate for an advertised value can yield zero
- Revision-and-query-hash bound cursors, and cursor `asOf` freshness freezing
- Candidate, accepted and observed-only evidence modes
- Canonical landmark vocabulary: scanner writes `header`/`footer`/`navigation`/`main`; `banner`, `contentinfo` and `complementary` canonicalize to `header`, `footer` and `aside` on read and query
- Bounded evidence: witness IDs are capped per explanation (200), per response (2,000 total), artifact descriptors at eight per anchor, and screenshot keys at eight per hit with `screenshotsTruncated` set; when the response-wide witness budget is exhausted every remaining explanation is emptied and marked `truncated`, including hits that receive zero IDs
- Bounded response: every successful response is at most 262,144 serialized bytes including the `{ok,data}` envelope. Region, capture and page IDs (128), site slugs (128), titles (200), URLs (1,024), paths (512), labels and claim values (200), sample and pattern keys (256), screenshot keys (256), artifact paths (1,024) and coverage limitations (200 each, at most 16) are clipped; a row whose stored region, capture or page identifier exceeds 128 characters is omitted with `responseTruncated` and no cursor, so clipped IDs can never collide and generated cursors always round-trip (`total` still counts the omitted matches); if the payload still exceeds the budget, optional evidence is shed in a fixed order (supporting IDs and sample keys, then screenshots and artifacts, then claims and observation spans) and `responseTruncated` is set. Request site slugs accept 1-128 characters: 128 is accepted and 129 is rejected with `INVALID_INPUT` rather than echoed back
- Legacy captures without `locator_json.tag` derive the tag only from the last selector compound; the derived tag is unioned into tag facets even when no other predicate or text query is present, and an unparseable compound stays `null` and surfaces as `insufficient_coverage`
- Repeated purpose predicates match one shared sample key; a site/page hit never reports a sample that satisfies only one of them. A region ranks by its best qualifying tier across the values of one OR predicate
- Repeated structural predicates intersect only at region scope, because one region has one tag/role/landmark. Page and site scope keep them separate, so `tag=header` and `tag=footer` can be satisfied by two witnesses in one capture or site
- `siteSlugs` narrows every region match, total and facet through the eligible capture set; an unrequested site never contributes a count or a facet value
- Purpose facet counts are per requested evidence mode: `candidate_regions`, `accepted_regions` and `observed_regions` count only regions whose labels qualify for that mode, so candidate or rejected evidence never inflates accepted/observed counts
- A text query also narrows purpose-derived structural facets: a purpose-matching region that did not match the query is not counted
- `predicatePresence` is evaluated against eligible captures only: stale, other-viewport or candidate-only evidence (in accepted mode) yields `insufficient_coverage`, while a present-but-unmatched purpose value yields `no_observed_match`; structural presence requires the requested tag/role/landmark value itself

Not implemented in Phase 4A/4B:

- Component interaction/state claims beyond explicit `hover_change_observed` and `focus_visible_observed` (open drawer, active tooltip, carousel behavior)
- Component `evidenceMode` search still defaults to `candidate`

## Phase 4A component search

Implemented locally, with no MCP tool registration:

- `kind: "components"` anchors only on `atlas_regions.kind = 'component'`; a section in the same capture is never returned, even with no predicate or query
- `component.type` and `context.section_purpose` predicates, plus `region.kind = component` as a no-op
- `groupBy: "pattern"` (the component default) groups repeated instances by pattern key; `groupBy: "instance"` counts regions
- Pattern keys include type, containing section, a depth-three tag/role shape, child counts and selected computed display/spacing/radius/typography values, scoped to site + page + viewport. Text, image URLs, labels, selectors and class names never enter the key
- Component facets in `region_instance` or `component_pattern` units; `region.kind` reports `component`
- Component caps: at most 120 candidates retained from a bounded raw set, ranked by on-screen visibility, area and section containment before the cap; the highest-ranked 12 get packs. `COMPONENT_CAP:<dropped>` records the number discarded, `COMPONENT_PACK_CAP` records omitted packs and `COMPONENT_PACK_TRUNCATED` records a clipped pack (150 nodes, depth 12). Any of these makes coverage `partial`
- Components are discovered and packed only from the initial scan; checkpoint scans carry no components and record `COMPONENT_INITIAL_SCAN_ONLY` in coverage when components exist (a coverage scope note, not an exhausted bound, so it does not by itself mark the capture partial)
- A component pack artifact is attached to its component region, so a component hit exposes the `component_pack` descriptor. Publication accepts a pack only when its payload names the owning component, repeats its type, and its root tag/role match that component; claim evidence must reference a pack owned by the claim's own region

Native and declared ARIA mappings are a fixed table validated by `test/atlas-components.test.ts` (`ATLAS_COMPONENT_HINTS`). Every native tag, ARIA role and input type maps to one canonical value or is omitted. ARIA `listbox` and `grid` are omitted because the vocabulary has no matching type; they are never aliased to `list` or `table`.

Evidence honesty:

- `card`, `drawer`, `carousel`, `icon_button` and `tooltip` are inferred structural types and are **candidate-only**. They never satisfy `accepted` or `observed_only` search
- Hidden (`display:none`), offscreen, off-canvas and fully clipped controls are candidate-only; accepted and observed_only component search never return them while candidate mode can
- Every accepted/observed_only component anchor requires an eligible `component.type` claim; an accepted `context.section_purpose` alone never qualifies a candidate type
- A drawer inference requires off-canvas geometry (a rect entirely outside the viewport) or offscreen placement; a transform alone never turns a dialog into a drawer
- A resolved `aria-controls` relationship makes a `navigation_trigger` accepted with rule `component.aria.navigation-trigger.resolved`; an unresolved declaration stays candidate
- `context.section_purpose` evidence points at the containing section's scan entry, and is emitted only for accepted section purposes

**F9 held-out component gate (spec 17.4) is not met.** Accepted native/declared type precision >= 95% is measured against held-out human labels. No held-out human component labels exist yet; the fixtures only audit the mapping table and structural rules, so they are not a precision measurement. Inferred card/drawer/tooltip/carousel/icon_button quality is reported as unreviewed with no precision claim.

## Phase 4B explicit states

Implemented locally, with no MCP tool registration:

- `collectAtlasPage({ states })` accepts at most **three** `{ action: "hover" | "focus", targetRegionId }` requests. A fourth, a duplicate target/action pair, an unknown action, a target from another page or viewport, a non-section/component target, a target that is not part of the current active head, or a component target without a verifiable persisted type **and** `patternKey` is rejected with `INVALID_STATE_REQUEST` before the browser launches. A missing `patternKey` is never re-derived from the request.
- State capture runs after the default scan, checkpoints and component classification, inside the containing capture. It does **not** create a separate capture, head or revision of its own: the state samples and claims are part of that capture, and publishing it replaces the active head and bumps the revision exactly like any other capture.
- Each request resolves the **stored locator** from the target region's `locator_json`: the selector must match exactly one current element, and the element's tag plus section heading/text (or component label/type/pattern) must match the persisted identity. The persisted fingerprint is compared with a fingerprint recomputed from the candidate this capture actually observed; it is never re-derived from the stored fields alone. After the real interaction, the target is resolved again against the live DOM and its tag/heading/text or label/type/pattern, section assignment, node identity and fingerprint are re-checked while the state is still active; a relabelled, replaced or structurally changed element is `STATE_TARGET_CHANGED` and emits no claim. Zero matches, several matches, a changed identity, or a mismatched fingerprint produce an inconclusive result, identified by `scanArtifactKey` pointing at the page scan and `stateArtifactKey` at the state JSON. There is **no nearest-element fallback**.
- Before every independent state the pointer returns to `(0, 0)`, the active element is blurred and both axes of the scroll (including an inner scroll root's `scrollLeft`) reset to the capture baseline. The target is scrolled into view, then the pointer moves to a point at least 8 px outside the target's rect and the baseline is re-measured there, so a target at the top-left cannot inherit the reset pointer's hover style as its baseline. A target that leaves no such point — it covers the viewport — is inconclusive with `STATE_TARGET_FULL_VIEWPORT` instead of a false `STATE_NO_CHANGE`. The sample records the actual baseline and observed `scrollX`, `scrollY`, `scrollRoot`, state-specific `rect`, `coordinateSpace`, `visible` and sample key.
- `hover` moves the real pointer to the target's hit-tested centre, then confirms the pointer is **still over the verified target or a descendant**: `document.elementFromPoint(pointerX, pointerY)` must resolve inside the target and the target and hit element must both match `:hover`. A button moved away by `mouseenter` is therefore `STATE_HOVER_NOT_ACTIVE`, never a false observation. `behavior=hover_change_observed` is accepted/observed only when a measured style or geometry change exists and the pointer is confirmed.
- `focus` calls `focus({ focusVisible: true })` and requires `document.activeElement` to be the target or a descendant, the focused element itself to match `:focus-visible` (not only its ancestor), and a measured style/geometry change. Otherwise the request is inconclusive (`STATE_FOCUS_UNCONFIRMED`, `STATE_FOCUS_NOT_VISIBLE` or `STATE_NO_CHANGE`).
- Supported actions only: click, type, submit, drag, keyboard navigation and route transitions are never performed.
- Every observed state persists one sample in the target region's `samples_json` with `state: "hover" | "focus"` and one claim: `behavior=hover_change_observed` or `behavior=focus_visible_observed`, basis `interaction_observation`, sharing that sample key. For a component target the observed `component.type` is re-emitted under the state sample key. Only a type that was candidate **solely for default visibility** (`component.visibility.hidden`, or a resolved navigation trigger that was hidden/offscreen) becomes accepted when the state probe actually hit-tested it; that promotion uses the state-specific rule `component.visibility.observed-in-state`. An unresolved navigation trigger stays candidate however visible it is, and inferred structural types stay candidate. A section re-emits its existing accepted or candidate `section.purpose` claims and a component its existing accepted or candidate `context.section_purpose` claims under the state sample key, **preserving the source decision** and never inventing a purpose: a candidate source stays candidate in the state sample, so an accepted state+purpose query does not match it (rejected and proposed claims are never re-emitted).
- Inconclusive requests add an explicit limitation (`STATE_TARGET_MISSING`, `STATE_TARGET_AMBIGUOUS`, `STATE_TARGET_CHANGED`, `STATE_TARGET_FULL_VIEWPORT`, `STATE_HOVER_NOT_ACTIVE`, `STATE_FOCUS_UNCONFIRMED`, `STATE_FOCUS_NOT_VISIBLE`, `STATE_NO_CHANGE`, `STATE_PROBE_FAILED`, `STATE_DEADLINE_EXCEEDED`, `STATE_RESET_FAILED`, `STATE_ARTIFACT_LIMIT`) and never abort the default capture.

State-aware search (`state: "hover" | "focus"`) is enabled in both section and component search. Every claim stores its explicit `state` (`default`, `hover` or `focus`), and a state query reads only claims with that exact state on an eligible region; default-state and other-state claims never combine into a state result. Region-scope repeated predicates must share one state sample key, and component state evidence also requires an eligible `component.type` claim in the same state. Page/site structural scope sets are derived from the requested state's eligible regions and claims, never from the default-state feature projections, and the default-only "value present in every capture" shortcut is disabled for state queries. The anchor must itself carry an eligible claim in the requested state. Default-state search (labels, hit claims, tier, predicates, facets and FTS) ignores every non-default claim. With no state evidence the outcome is `insufficient_coverage`; with state evidence but no matching region it is `no_observed_match`; an empty corpus stays `empty_corpus`.

Schema v10 adds the additive `atlas_claims.state` column (existing rows default to `default`) plus `(state, region_id, sample_key)` and `(region_id, state, sample_key)` indexes, and FTS v4 rebuilds labels from default-state accepted claims only. A legacy schema 3-9 cache gains and backfills the column inside the upgrade transaction before any FTS reconciliation reads it. State search filters on the indexed claim state column; it does not scan `samples_json` for eligible regions.



Search pushes eligibility, predicate matching, ordering, pagination, facet counting and the requested anchor page into SQLite. The JavaScript layer receives only the requested page of anchors, its page-capped witnesses, claims and artifact descriptors. The query path is **read-only**.

### Schema v10 search projections

Schema v9 added the component count column and per-evidence-mode claim tiers to the derived projections, and FTS v3 indexes component documents alongside sections; v10 adds the explicit claim state and FTS v4 default-state labels. The seven revision-keyed projections are derived data: a rebuild deletes and recreates every row.

- `atlas_capture_summary` — one row per eligible capture: active head, `live_page`, `complete`/`partial`, known confirmation time; page, site, profile, observed/fresh timestamps and section count
- `atlas_capture_features` — distinct tag, role, landmark and purpose values per capture, with structural and per-evidence-mode claim tiers and the number of regions carrying each value
- `atlas_capture_purposes` — purpose values per capture with per-mode tiers and the exact number of regions carrying that value in each evidence mode
- `atlas_site_features` — the same feature values aggregated per **site + profile**, with the newest confirmation among captures holding the value and a summed per-feature region count
- `atlas_region_features` — per-region structural and purpose values, keyed by profile with the region's capture freshness
- `atlas_region_purposes` — purpose values per region with candidate/accepted/observed tiers, profile, freshness and the region's tag/role/landmark; a covering scope index serves purpose matching and a second covering index orders tag/role/landmark before purpose value for structural purpose facets
- `atlas_feature_totals` — corpus-wide capture and region counts per value, used to skip predicates every scope satisfies and to answer all-scope facets without scanning

Page- and site-scope facet counts are region-instance counts from these per-feature region counts, not capture section totals. A page with a footer and two sections reports `footer: 1` and `section: 2`; a capture-level sum would report `3` for both.

A text query changes the counting unit for page/site facets: counts come from the regions that matched the query (`atlas_search_fts_anchors.region_id`) joined to `atlas_region_features`/`atlas_region_purposes`. A capture that matched `pricing` in one section therefore reports `footer: 0, section: 1` rather than contributing every section of that capture. Page/site predicates are not re-applied to the anchor; they are already satisfied at scope level, so a page can match `purpose=hero` through one section and `pricing` through another and still count the pricing anchor. Facet values are also restricted to eligible captures for the requested viewport and age window.

A missing projection table or a table with any column the query path reads is repaired on the next cache open: all seven projections are dropped, recreated from `SEARCH_PROJECTION_SCHEMA` and rebuilt from the current active heads. The seven search-supporting indexes (`atlas_claims_facet_idx`, `atlas_regions_lookup_idx`, `atlas_regions_features_idx`, `atlas_regions_sort_idx`, `atlas_regions_tag_fallback_idx`, `atlas_regions_kind_idx`, `atlas_region_features_region_idx`), the two state-evidence indexes (`atlas_claims_state_region_idx`, `atlas_claims_region_state_idx`) and the five projection-local indexes (`atlas_capture_summary_scope_idx`, `atlas_site_features_lookup_idx`, `atlas_region_purposes_scope_idx`, `atlas_region_purposes_facet_idx`, `atlas_region_features_claim_idx`) are checked separately on every writer open and recreated when missing, without dropping a projection table or rebuilding rows. A missing search object observed by a reader maps to the typed, retryable `SEARCH_NOT_READY`.

`atlas_state.feature_revision` is the revision the projections were built from; a committed revision always has a matching `feature_revision`.

### Publish-time rebuild, read-only search

The projection rebuild runs **inside the publishing `BEGIN IMMEDIATE` transaction**, before `COMMIT`, using the connection publish already holds. Publish pays the cost; search never writes and never waits for a rebuild on its own path.

An identical live recapture keeps the revision and skips the rebuild on a same-day confirmation. A later-day identical confirmation refreshes the derived freshness columns in place — `atlas_capture_summary.fresh`, `atlas_region_features.fresh`, `atlas_region_purposes.fresh` and the affected site/profile rows in `atlas_site_features` — and bumps the revision without rebuilding the projections, so old cursors invalidate and a day-29 recapture stays searchable at day 31. A recapture that crosses the 30-day window or changes status still triggers the full rebuild.

Atlas-enabled caches use `journal_mode = WAL` with `synchronous = NORMAL`. The WAL request is confirmed from the pragma's read-back value: a VFS that silently stays on `delete` (or `memory`) keeps `synchronous = FULL`, because NORMAL on a rollback journal can corrupt. WAL+NORMAL can lose the most recent transactions on an OS crash or power loss but leaves the database consistent. Search opens a **genuine read-only connection** that runs no schema DDL, no `ALTER TABLE`, no FTS migration, no Atlas migration and no write PRAGMAs. A search-only process can construct the cache with `{ readOnly: true }`, which also skips directory repair and eager database opening. On read-only media, or a directory whose ACL denies writes, a WAL database cannot create the `-shm` file, so the read-only open fails with `SQLITE_CANTOPEN` (sometimes only at the first b-tree read). When the file header says WAL and `-wal`, `-shm` and `-journal` are all absent — the file is exactly the last checkpointed snapshot — search retries it as `file:<abs>?immutable=1`, which takes no locks and creates nothing. A sidecar that appears in the meantime disables the fallback before it is used. A normal writer open first probes the FTS version/table state read-only and only takes the FTS `BEGIN IMMEDIATE` when the layer is missing or stale, so a healthy open never queues behind a publisher's write lock. Search reads `revision`, `feature_revision` and every projection row from one deferred read snapshot, and returns the **last committed revision** even while a publisher holds its write transaction. Publish commits without waiting for readers to finish. Open, PRAGMA, missing-object and transaction failures caused by a concurrent writer map to the typed, retryable `SEARCH_NOT_READY` error, never a raw `SQLITE_BUSY` or `database is locked`. If `feature_revision !== revision` search retries once and then returns `SEARCH_NOT_READY`; it never labels R+1 results built from R projections.

Batch withdrawal of invalid artifact heads removes every affected head with `bumpRevision = false` and bumps the revision once after the loop, so one bad artifact does not rebuild the projections once per head. Busy failures inside that transaction are typed as `PUBLICATION_BUSY`.

Retired heads leave no projection rows: a rebuild clears the derived tables and re-inserts only from the active head set, so a head swap cannot leave summary, purpose or structural rows behind.

Production opens one connection per search. Each connection sets a 32 MiB page cache (`PRAGMA cache_size = -32768`) and keeps temporary projections in memory; concurrent searches therefore each carry their own page cache while sharing the persisted v10 projections. RSS below is the measured additional peak with that setting.

### Benchmark

`npm run atlas:search:bench` generates a local temporary SQLite corpus with **100,000 eligible regions** plus **20,000 separate stale/unknown-status regions** (10,000 outside the 30-day window, 10,000 recent but unknown status; 1,212,000 claims including 12,000 state claims, 12,000 captures, 1,200 sites) and runs the same eight-predicate conjunction across region, page and site scopes, without facets and with four facets (`region.tag`, `region.role`, `region.landmark`, `section.purpose`). Two additional region-scope workloads request `state: "hover"`: their evidence is a 5% subset of eligible regions, and their purpose/structural predicate sets are narrowed to values that subset actually carries, so the run measures state filtering, facets and cursor paging rather than an empty intersection. Eligible captures are fresh (0-28 days) and mix complete/partial status and per-capture structural subsets. The separate stale captures are complete but outside the 30-day window; the separate unknown captures are recent but unpublishable. No eligible query may see either set, so corpus-wide shortcuts cannot pass by accident. No network is used. Each workload runs one first pass, five warmup passes and 50 measured queries; **400 queries are measured in total**. Only the **first workload's first pass is cold**; the other first passes are warm and are labelled as such.

Measured on the Phase 4B worktree (12th Gen Intel Core i5-12450HX, Node v24.18.0, SQLite 3.53.1, warm cache, WAL + `synchronous = NORMAL`, database ~1,092 MiB; the host was also running its normal background processes during the run):

| Workload | p50 | p95 | Gate |
|---|---:|---:|---:|
| Region, 8 predicates | 88.0 ms | 111.2 ms | <= 300 ms |
| Region, 8 predicates + 4 facets | 112.6 ms | 173.9 ms | <= 500 ms |
| State region, predicates | 42.0 ms | 55.2 ms | <= 300 ms |
| State region, predicates + 4 facets | 167.6 ms | 208.1 ms | <= 500 ms |
| Page, 8 predicates | 154.9 ms | 207.8 ms | <= 300 ms |
| Page, 8 predicates + 4 facets | 221.9 ms | 252.7 ms | <= 500 ms |
| Site, 8 predicates | 96.5 ms | 124.7 ms | <= 300 ms |
| Site, 8 predicates + 4 facets | 144.0 ms | 207.1 ms | <= 500 ms |

Additional RSS during search: **18.7 MiB** (gate <= 128 MiB). First-run timings: 131.2 ms cold for the first region workload, 70.4-229.0 ms warm for the others. State cursor paging completed without duplicate regions.

All eight gates passed in the final 400-measurement run; the state workloads were **55.2 ms** (no facets) and **208.1 ms** (four facets) p95. The publish-side projection rebuild measured 9.67 s on the same corpus, inside the publish transaction and excluded from the search timings. The benchmark seeds with WAL and `synchronous = NORMAL`, the same journal and sync mode a real cache now uses. These are local synthetic measurements, not production latency promises. The corpus is generated in a temp database and deleted after the run.

Residual risks:

- Publish latency grows with the live corpus: every new capture, status change or freshness-window crossing rebuilds all seven projections. The rebuild measured 7.6-17.7 s at 100k eligible regions across runs, inside the 90 s capture budget; legacy import paths that bump the revision pay the same rebuild.
- A second writer on the same cache is serialized by `BEGIN IMMEDIATE` and the 5 s busy timeout; a publish that outlives the timeout fails with the typed `PUBLICATION_BUSY` instead of overlapping the rebuild. The legacy ingest store (`AtlasStore.commitSitePage`) still surfaces the raw SQLite busy error in that case. One publish runs per cache at a time.
- Page and site scope with four facets are inside their 500 ms gate (p95 174-253 ms in the final run); run-to-run p95 varies with host load. Region scope without facets is the tightest gate because it materializes the full anchor set (111 ms p95 in the final run). State region scope without facets stays evidence-bounded (55 ms p95) because it starts from the indexed claim-state set rather than scanning every eligible region's `samples_json`.
- A publish that outlives the 5 s SQLite busy timeout does not block an already-open read-only search: it reads the last committed snapshot. Opening a normal (writer) cache or running a migration during a long write maps busy failures to the typed, retryable `SEARCH_NOT_READY`; callers should retry. Search never reports partial or mixed-revision results.
- A same-day identical recapture updates `last_confirmed_at` but does not refresh the projections, so the projection's `fresh` value stays at the previous confirmation until the next day's recapture, a head/status change or a >30-day crossing. Such a same-day shift can only matter within hours of the 30-day boundary.
- Site predicate membership and tier come from eligible captures only (requested viewport, complete/partial status, within the age window); stale or other-viewport captures never contribute a tier or a facet count.
- Search's read transaction is served from WAL and does not block publish commits. Search work is bounded to one page plus capped witnesses and eight screenshot keys per hit.
- The immutable fallback is a snapshot read by construction: it ignores any `-wal` or `-journal` that appears after the sidecar check and assumes the file cannot change. That is sound for read-only media and ACL-denied directories; if a writer can still reach the same path, readers keep the last checkpointed content until they reconnect. The fallback refuses whenever a sidecar is present at open, and is never used on a normal writable cache.
- Immutable media caveat: the connection reports `journal_mode = delete`, takes no locks and rejects writes with `SQLITE_READONLY`; replacing the database file behind an open handle is not observed. If the platform's SQLite build cannot open URI filenames, the fallback fails and search returns the typed `SEARCH_NOT_READY`.

## Next phase

Phase 4B is implemented; the remaining Phase 4 work is calibration, not new capture:

- contract-extracted patterns for uncorroborated ARIA roles (native/declared type stays the accepted path)
- human component labels on a smaller set before any inferred class is promoted to accepted
- held-out measurement of accepted native/declared component precision
- human review of hover/focus state claims before treating them as a quality signal

## Verification

```bash
npm run typecheck
npm test -- --maxWorkers=2
npm run build
npm run atlas:search:bench
npx vitest run test/atlas-collector.chromium.test.ts
```

The held-out report and corpus are local review artifacts and are not committed.
