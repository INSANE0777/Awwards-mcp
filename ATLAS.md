# Atlas (experimental)

Atlas is the section-level evidence layer for awwwards-mcp. It is **opt-in** and off by default:

```bash
AWWWARDS_MCP_ATLAS=1
```

It adds capture, segmentation, checkpoint evidence, publication, candidate section labels and local search to the existing SQLite cache. It does **not** add or change MCP tools; tool exposure belongs to a later phase.

## Status

Phase 3 search is implemented locally and passes its focused test gate. Classification is still **not calibrated** and is not advertised as accepted.

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
- `region.kind` accepts only `section`; `page`, `highlight` and `component` are rejected with `UNSUPPORTED_PREDICATE`, so a section anchor can never match through a kind the corpus does not publish
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

Not implemented in Phase 3:

- Component search (`kind: "components"`) arrives in Phase 4
- Hover and focus evidence (`state: "hover" | "focus"`) arrives in Phase 4
- Pattern grouping (`groupBy: "pattern"`) is rejected with `UNSUPPORTED_GROUPING` until instance counts can be reported exactly

## SQL-backed performance

Search pushes eligibility, predicate matching, ordering, pagination, facet counting and the requested anchor page into SQLite. The JavaScript layer receives only the requested page of anchors, its page-capped witnesses, claims and artifact descriptors. The query path is **read-only**.

### Schema v8 search projections

Schema v8 adds seven revision-keyed projections derived from active heads. They are derived data: a rebuild deletes and recreates every row.

- `atlas_capture_summary` — one row per eligible capture: active head, `live_page`, `complete`/`partial`, known confirmation time; page, site, profile, observed/fresh timestamps and section count
- `atlas_capture_features` — distinct tag, role, landmark and purpose values per capture, with structural and per-evidence-mode claim tiers and the number of regions carrying each value
- `atlas_capture_purposes` — purpose values per capture with per-mode tiers and the exact number of regions carrying that value in each evidence mode
- `atlas_site_features` — the same feature values aggregated per **site + profile**, with the newest confirmation among captures holding the value and a summed per-feature region count
- `atlas_region_features` — per-region structural and purpose values, keyed by profile with the region's capture freshness
- `atlas_region_purposes` — purpose values per region with candidate/accepted/observed tiers, profile, freshness and the region's tag/role/landmark; a covering scope index serves purpose matching and a second covering index orders tag/role/landmark before purpose value for structural purpose facets
- `atlas_feature_totals` — corpus-wide capture and region counts per value, used to skip predicates every scope satisfies and to answer all-scope facets without scanning

Page- and site-scope facet counts are region-instance counts from these per-feature region counts, not capture section totals. A page with a footer and two sections reports `footer: 1` and `section: 2`; a capture-level sum would report `3` for both.

A text query changes the counting unit for page/site facets: counts come from the regions that matched the query (`atlas_search_fts_anchors.region_id`) joined to `atlas_region_features`/`atlas_region_purposes`. A capture that matched `pricing` in one section therefore reports `footer: 0, section: 1` rather than contributing every section of that capture. Page/site predicates are not re-applied to the anchor; they are already satisfied at scope level, so a page can match `purpose=hero` through one section and `pricing` through another and still count the pricing anchor. Facet values are also restricted to eligible captures for the requested viewport and age window.

A missing projection table or a table with any column the query path reads is repaired on the next cache open: all seven projections are dropped, recreated from `SEARCH_PROJECTION_SCHEMA` and rebuilt from the current active heads. The search-supporting indexes (`atlas_claims_facet_idx`, `atlas_regions_lookup_idx`, `atlas_regions_features_idx`, `atlas_regions_sort_idx`, `atlas_regions_tag_fallback_idx`, `atlas_regions_kind_idx`, `atlas_region_features_region_idx`) plus the four projection-local indexes (`atlas_capture_summary_scope_idx`, `atlas_site_features_lookup_idx`, `atlas_region_purposes_scope_idx`, `atlas_region_purposes_facet_idx`) are checked separately on every writer open and recreated when missing, without dropping a projection table or rebuilding rows. A missing search object observed by a reader maps to the typed, retryable `SEARCH_NOT_READY`.

`atlas_state.feature_revision` is the revision the projections were built from; a committed revision always has a matching `feature_revision`.

### Publish-time rebuild, read-only search

The projection rebuild runs **inside the publishing `BEGIN IMMEDIATE` transaction**, before `COMMIT`, using the connection publish already holds. Publish pays the cost; search never writes and never waits for a rebuild on its own path.

An identical live recapture keeps the revision and skips the rebuild on a same-day confirmation. A later-day identical confirmation refreshes the derived freshness columns in place — `atlas_capture_summary.fresh`, `atlas_region_features.fresh`, `atlas_region_purposes.fresh` and the affected site/profile rows in `atlas_site_features` — and bumps the revision without rebuilding the projections, so old cursors invalidate and a day-29 recapture stays searchable at day 31. A recapture that crosses the 30-day window or changes status still triggers the full rebuild.

Atlas-enabled caches use `journal_mode = WAL` with `synchronous = NORMAL`. The WAL request is confirmed from the pragma's read-back value: a VFS that silently stays on `delete` (or `memory`) keeps `synchronous = FULL`, because NORMAL on a rollback journal can corrupt. WAL+NORMAL can lose the most recent transactions on an OS crash or power loss but leaves the database consistent. Search opens a **genuine read-only connection** that runs no schema DDL, no `ALTER TABLE`, no FTS migration, no Atlas migration and no write PRAGMAs. A search-only process can construct the cache with `{ readOnly: true }`, which also skips directory repair and eager database opening. On read-only media, or a directory whose ACL denies writes, a WAL database cannot create the `-shm` file, so the read-only open fails with `SQLITE_CANTOPEN` (sometimes only at the first b-tree read). When the file header says WAL and `-wal`, `-shm` and `-journal` are all absent — the file is exactly the last checkpointed snapshot — search retries it as `file:<abs>?immutable=1`, which takes no locks and creates nothing. A sidecar that appears in the meantime disables the fallback before it is used. A normal writer open first probes the FTS version/table state read-only and only takes the FTS `BEGIN IMMEDIATE` when the layer is missing or stale, so a healthy open never queues behind a publisher's write lock. Search reads `revision`, `feature_revision` and every projection row from one deferred read snapshot, and returns the **last committed revision** even while a publisher holds its write transaction. Publish commits without waiting for readers to finish. Open, PRAGMA, missing-object and transaction failures caused by a concurrent writer map to the typed, retryable `SEARCH_NOT_READY` error, never a raw `SQLITE_BUSY` or `database is locked`. If `feature_revision !== revision` search retries once and then returns `SEARCH_NOT_READY`; it never labels R+1 results built from R projections.

Batch withdrawal of invalid artifact heads removes every affected head with `bumpRevision = false` and bumps the revision once after the loop, so one bad artifact does not rebuild the projections once per head. Busy failures inside that transaction are typed as `PUBLICATION_BUSY`.

Retired heads leave no projection rows: a rebuild clears the derived tables and re-inserts only from the active head set, so a head swap cannot leave summary, purpose or structural rows behind.

Production opens one connection per search. Each connection sets a 32 MiB page cache (`PRAGMA cache_size = -32768`) and keeps temporary projections in memory; concurrent searches therefore each carry their own page cache while sharing the persisted v8 projections. RSS below is the measured additional peak with that setting.

### Benchmark

`npm run atlas:search:bench` generates a local temporary SQLite corpus with **100,000 eligible regions** plus **20,000 separate stale/unknown-status regions** (10,000 outside the 30-day window, 10,000 recent but unknown status; 1,200,000 claims, 12,000 captures, 1,200 sites) and runs the same eight-predicate conjunction across region, page and site scopes, without facets and with four facets (`region.tag`, `region.role`, `region.landmark`, `section.purpose`). Eligible captures are fresh (0-28 days) and mix complete/partial status and per-capture structural subsets. The separate stale captures are complete but outside the 30-day window; the separate unknown captures are recent but unpublishable. No eligible query may see either set, so corpus-wide shortcuts cannot pass by accident. No network is used. Each workload runs one first pass, five warmup passes and 50 measured queries; 300 queries are measured in total. Only the **first workload's first pass is cold**; the other first passes are warm and are labelled as such.

Measured on the Phase 3 worktree (12th Gen Intel Core i5-12450HX, Node v24.18.0, SQLite 3.53.1, warm cache, WAL + `synchronous = NORMAL`, database ~766-786 MiB; the host was also running its normal background processes during the run):

| Workload | p50 | p95 | Gate |
|---|---:|---:|---:|
| Region, 8 predicates | 111.0 ms | 172.2 ms | <= 300 ms |
| Region, 8 predicates + 4 facets | 154.6 ms | 220.4 ms | <= 500 ms |
| Page, 8 predicates | 126.0 ms | 190.0 ms | <= 300 ms |
| Page, 8 predicates + 4 facets | 213.7 ms | 354.5 ms | <= 500 ms |
| Site, 8 predicates | 96.1 ms | 144.8 ms | <= 300 ms |
| Site, 8 predicates + 4 facets | 137.1 ms | 205.0 ms | <= 500 ms |

Additional RSS during search: **19.4 MiB** (gate <= 128 MiB). First-run timings: 111.8 ms cold for the first region workload, 93-234 ms warm for the others.

Across four post-fix runs on the same host the page 4-facet p95 ranged 194.5-354.5 ms, site 4-facet 160.0-205.0 ms and region 8-predicate 98.3-265.6 ms as host load varied. All six gates passed in every run. The publish-side projection rebuild measured 7.58-17.69 s on the same corpus, inside the publish transaction and excluded from the search timings. The benchmark seeds with WAL and `synchronous = NORMAL`, the same journal and sync mode a real cache now uses. These are local synthetic measurements, not production latency promises. The corpus is generated in a temp database and deleted after the run.

Residual risks:

- Publish latency grows with the live corpus: every new capture, status change or freshness-window crossing rebuilds all seven projections. The rebuild measured 7.6-17.7 s at 100k eligible regions across runs, inside the 90 s capture budget; legacy import paths that bump the revision pay the same rebuild.
- A second writer on the same cache is serialized by `BEGIN IMMEDIATE` and the 5 s busy timeout; a publish that outlives the timeout fails with the typed `PUBLICATION_BUSY` instead of overlapping the rebuild. The legacy ingest store (`AtlasStore.commitSitePage`) still surfaces the raw SQLite busy error in that case. One publish runs per cache at a time.
- Page and site scope with four facets are inside their 500 ms gate (p95 about 160-355 ms across runs); run-to-run p95 varies with host load. Region scope without facets is the tightest gate because it materializes the full anchor set; it ranged 98-266 ms p95 against 300 ms.
- A publish that outlives the 5 s SQLite busy timeout does not block an already-open read-only search: it reads the last committed snapshot. Opening a normal (writer) cache or running a migration during a long write maps busy failures to the typed, retryable `SEARCH_NOT_READY`; callers should retry. Search never reports partial or mixed-revision results.
- A same-day identical recapture updates `last_confirmed_at` but does not refresh the projections, so the projection's `fresh` value stays at the previous confirmation until the next day's recapture, a head/status change or a >30-day crossing. Such a same-day shift can only matter within hours of the 30-day boundary.
- Site predicate membership and tier come from eligible captures only (requested viewport, complete/partial status, within the age window); stale or other-viewport captures never contribute a tier or a facet count.
- Search's read transaction is served from WAL and does not block publish commits. Search work is bounded to one page plus capped witnesses and eight screenshot keys per hit.
- The immutable fallback is a snapshot read by construction: it ignores any `-wal` or `-journal` that appears after the sidecar check and assumes the file cannot change. That is sound for read-only media and ACL-denied directories; if a writer can still reach the same path, readers keep the last checkpointed content until they reconnect. The fallback refuses whenever a sidecar is present at open, and is never used on a normal writable cache.
- Immutable media caveat: the connection reports `journal_mode = delete`, takes no locks and rejects writes with `SQLITE_READONLY`; replacing the database file behind an open handle is not observed. If the platform's SQLite build cannot open URI filenames, the fallback fails and search returns the typed `SEARCH_NOT_READY`.

## Next phase

Phase 4 can add component search, hover/focus evidence and pattern grouping once it can count instances exactly:

- component regions and component packs
- interaction-state evidence with separate sample keys
- pattern grouping whose `countUnit` matches the reported count
- human labels on a smaller set before any class is promoted

## Verification

```bash
npm run typecheck
npm test -- --maxWorkers=2
npm run build
npm run atlas:search:bench
npx vitest run test/atlas-collector.chromium.test.ts
```

The held-out report and corpus are local review artifacts and are not committed.
