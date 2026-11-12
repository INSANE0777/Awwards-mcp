# Atlas (experimental)

Atlas is the section-level evidence layer for awwwards-mcp. It is **opt-in** and off by default:

```bash
AWWWARDS_MCP_ATLAS=1
```

It adds capture, segmentation, checkpoint evidence, publication, candidate section labels, local search and evidence packs to the existing SQLite cache. With `AWWWARDS_MCP_ATLAS=1` it also adds four experimental MCP tools (`search_atlas`, `get_atlas`, `capture_atlas`, `export_evidence_pack`) and their v2 branches. With the flag off, the surfaces stay at **41 full / 13 core / 15 v2**.

## Status

Phase 4B explicit hover/focus state capture and state-aware search are implemented locally and pass their focused test gates. Phase 5 evidence packs are implemented locally and pass their focused test gates. Phase 6 adds the four MCP tools, the v2 branches and the Atlas CLI actions behind the same flag; see [Using Atlas](#using-atlas-phase-6). Classification is still **not calibrated** and is not advertised as accepted.

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

The candidate default is an accepted deviation from spec §10.1, which names `accepted` as the default. This release does not claim §10.1 compliance. The export copy cap is a second accepted deviation: spec §16 allows 64 MiB of copied artifacts, while this release caps copies at 32 MiB (see [`export_evidence_pack` constraints](#export_evidence_pack-inputs-rights-and-constraints)).

Structural labels are stronger than content labels:

| Class | Precision | Recall |
|---|---:|---:|
| header | 1.000 | 1.000 |
| footer | 1.000 | 0.737 |
| navigation | 1.000 | 0.667 |
| hero | 0.708 | 0.318 |
| services | n/a | 0 |

Content classes (services, features, pricing, process, CTA, product listing) need recall work before they can be exposed as filters.

## Using Atlas (Phase 6)

This is the operator-facing guide to the Phase 6 surface. `docs/atlas-spec.md` §11, §15, §16, §18 and §19 are normative; this section summarises those contracts and adds the usage rules that are easy to get wrong.

### Feature flag and surface counts

`AWWWARDS_MCP_ATLAS=1` enables Atlas. The flag is read once at server start, so changing it requires a restart. It is off by default.

| Profile | Flag off | Flag on |
|---|---:|---:|
| `full` (default) | 41 | 45 |
| `core` | 13 | 13 |
| `v2` | 15 | 16 |

- Flag on adds `search_atlas`, `get_atlas`, `capture_atlas` and `export_evidence_pack` to `full` (41 → 45). None is a `core` tool, so `core` stays 13. `v2` gains one tool, `export_evidence_pack` (15 → 16); the other Atlas operations are branches of existing v2 tools.
- Flag off: the four tools are not registered. The v2 Atlas branches still validate their request shape but return `FEATURE_DISABLED` without network access or mutation, and the surface counts stay 41 / 13 / 15.
- Atlas tables and files are additive and are not removed when the flag is turned off. Unsetting the flag is the operational rollback; an older binary ignores the additive tables and keeps using the legacy tools.
- These are surface counts, not a claim about any one installed build. Verify them at release with `npm run protocol:smoke` (flag off) and `AWWWARDS_MCP_ATLAS=1 npm run protocol:smoke` (flag on), and never hard-code one count for both states.

All four tools return the Atlas result envelope from spec §5.6. This blocked example shows the error form:

```json
{
  "schemaVersion": "awwwards-atlas-v1",
  "operation": "capture_atlas",
  "status": "blocked",
  "data": null,
  "coverage": { "status": "unknown", "collected": 0, "excluded": 0, "limitations": [] },
  "warnings": [],
  "error": {
    "code": "ROBOTS_DISALLOWED",
    "message": "The destination is disallowed by robots; no bypass was attempted",
    "retryable": false
  }
}
```

`ok` and `partial` always carry operation data in `data`. `inconclusive` carries resolved evidence when the operation produced any — an ambiguous highlight returns its candidate `regionIds` — and `data: null` when it did not. Every result includes concise text, and `ok`, `partial` and `inconclusive` also return `structuredContent` with the envelope. `blocked` and `error` carry `data: null`, set `isError: true`, and return the envelope serialized in text without `structuredContent`. Error messages never include stacks or absolute paths.

### Tools

| Tool | Read-only | Idempotent | Open world | Purpose |
|---|---:|---:|---:|---|
| `search_atlas` | yes | yes | no | Local section or component search with predicates, facets, scopes, evidence modes and cursors. Zero network. |
| `get_atlas` | yes | yes | no | Read `status`, `taxonomy`, one `region` or one `highlight`. Zero network. |
| `capture_atlas` | no | no | yes | Guarded live capture and publication for one known site slug and one viewport. Writes an active head when publication succeeds. |
| `export_evidence_pack` | no | yes | no | Build and validate a local evidence pack for 1–12 selected regions. Zero network. |

`search_atlas` takes `kind: "sections" | "components"` plus the search filters below. `get_atlas`, `capture_atlas` and `export_evidence_pack` take one flat object each; the v2 branches take the same fields inside `request`.

#### `search_atlas` inputs

| Field | Values | Default | Rules |
|---|---|---|---|
| `kind` | `sections`, `components` | required | One kind per call. |
| `query` | string | none | 1–300 characters, at most 16 tokens. Lexical FTS5 search over stored region text and accepted labels; every token is required. It does not assert traits. |
| `predicates` | `{field, values}[]` | none | At most 8 predicates. Each predicate carries 1–8 canonical values; the engine caps a predicate at 8 values. Predicates are ANDed; values inside one predicate are ORed. Repeated predicates on the same field stay separate AND requirements. |
| `scope` | `region`, `page`, `site` | `region` | Witness scope; see [Scopes](#scopes-states-and-evidence-modes). |
| `viewport` | `desktop`, `mobile` | `desktop` | Collection viewport. |
| `state` | `default`, `hover`, `focus` | `default` | A state query reads only claims with that exact state. |
| `evidenceMode` | `accepted`, `observed_only`, `candidate` | `candidate` | See the deviation note below and [evidence modes](#scopes-states-and-evidence-modes). |
| `siteSlugs` | string[] | none | 1–20 distinct cached site slugs; duplicates are rejected; narrows matches, totals and facets. |
| `maxAgeDays` | integer 1–3650 | 30 | Freshness window over the confirmation time. |
| `groupBy` | `instance`, `pattern` | `instance` sections, `pattern` components | Pattern grouping counts repeated component families. |
| `sort` | `relevance`, `newest` | `relevance` | BM25 for a text query; tiered relevance otherwise. |
| `facets` | field[] | none | At most 4 distinct fields. Counts are disjunctive. |
| `limit` | integer 1–20 | 8 | Anchors per page. |
| `cursor` | string | none | `nextCursor` from the previous page; bound to the query and revision, expires after 15 minutes. |

Supported predicate fields: `section.purpose`, `component.type`, `context.section_purpose`, `region.kind`, `region.tag`, `region.role`, `region.landmark`. A section search accepts only `region.kind: "section"`; a component search accepts only `region.kind: "component"`. Any other field or value returns `UNSUPPORTED_PREDICATE` before any query runs. Appearance, layout, behavior, rendering and technology fields exist in the classifier vocabulary but are not exposed as predicates in this release.

> **Default evidence mode is a deliberate deviation.** Spec §10.1 names `accepted` as the default, but every section label in this release is still candidate. Search therefore defaults to `candidate`, marks every hit `candidateOnly: true`, sets `candidateNote` and adds the `CLASSIFICATION_AMBIGUOUS` warning. Pass `evidenceMode: "accepted"` to search accepted labels only. This deviation is accepted for the release: the release does not claim §10.1 compliance and the difference is tracked in [Deliberate deviation](#deliberate-deviation).

### `get_atlas` branches

| `kind` | Input | Data returned |
|---|---|---|
| `status` | none | Enabled and available state; stored and current schema/FTS/vocabulary/classifier versions; revision and `updatedAt`; counts by source, region kind and capture status; fresh/stale live captures; latest publication; latest failed attempt; lease state, expiry and `ttlSeconds` (`null` when free, at most 150 while held); artifact records, distinct hashes, ready records and deduplicated bytes; FTS availability; coverage note. |
| `taxonomy` | none | Registry version; every field with values, labels, support (`supported`, `reserved`, `dynamic`, `disabled`), enabled/searchable flags, permitted evidence bases, aliases and rule IDs; supported scopes, states, evidence modes and grouping; explicitly unsupported operations. |
| `region` | `regionId` (64 lowercase hex) | Stored region record; capture conditions and source identity; up to 128 claims; availability-checked artifact descriptors; parent and up to 24 bounded child summaries; current/historical head status. |
| `highlight` | `elementId` | Alias resolution to one region: `status` is `resolved`, `ambiguous` or `not_found`, with `aliasKind`, candidate `regionIds` and an optional full `region`. |

- `status` reads the SQLite cache only. It does not scan the filesystem, and its counts describe the locally cached subset, not all of Awwwards. Collection errors that happen before publication are returned by the capture call itself and are not stored as capture rows, so `latestFailedAttempt` only covers persisted attempts.
- `region` does not embed a raw component tree by default. Component packs and screenshots are returned as artifact descriptors with `storagePath`, `sha256`, `bytes`, `mimeType`, `state` (`ready`, `missing`, `corrupt`, `restricted`) and `available`. Claim lists are capped at 128 (`claimsTruncated`), children at 24 (`childrenTruncated`) and artifacts at 32 (`artifactsTruncated`).
- `highlight` resolves an existing element id through `atlas_aliases`, trying `legacy_element_slug` and then `legacy_gallery_slug`. Ambiguity returns envelope `inconclusive` with error `AMBIGUOUS_ALIAS` and the candidate `regionIds`; an unknown id returns `inconclusive` with `status: "not_found"` and no error. The old gallery page is never fetched.
- An invalid `regionId` returns `INVALID_INPUT`; an unknown one returns `REGION_NOT_FOUND`; a cache written by a newer schema returns `SCHEMA_TOO_NEW` without modifying anything.

### `capture_atlas` inputs and output

| Input | Values | Default | Rules |
|---|---|---|---|
| `slug` | cached site slug | required | The live URL comes from cached site metadata, never from a free URL. |
| `path` | path on that origin | known root | Must start with one `/`, must not start with `//`, and may not contain `?`, `#` or credentials. |
| `viewport` | `desktop`, `mobile` | `desktop` | One viewport per call; 1440×900 or 390×844. |
| `components` | boolean | `true` | Component candidates and packs; `false` returns `components: []`. |
| `states` | `{action, targetRegionId}[]` | none | At most 3 unique `hover`/`focus` pairs on regions of the current active head. |
| `refresh` | boolean | `false` | `false` reuses a matching usable active head up to 7 days old; `true` always launches a capture. |

Output data: `captureId`, `attemptId`, `pageId`, `cached`, `published`, `previousHeadId`, `viewport`, `sections`, `components` (bounded `RegionSummary` lists; 64 each), `artifacts` (availability-checked descriptors; 32), `capabilityCoverage` (geometry, sections, components, screenshots, tokens, states, motion, rendering, policy) and `omitted` (sections, components, screenshots, componentPacks).

Publication semantics:

- `cached: true` means no new capture ran. A matching usable active head up to seven days old was reused, with the same requested states. `published` is `false` because nothing was republished, and `previousHeadId` is `null`.
- `published: true` means a new capture replaced the active head. `previousHeadId` is the head it replaced, or `null` for a first publication.
- `published: false` with `cached: false` means the attempt produced evidence that could not be published. Envelope `status` is `partial` when usable evidence was collected, or `inconclusive` when the result is unknown. The bounded summaries and `omitted` counters still describe what was collected, and `captureId` is empty when nothing was stored. The previous head is preserved.
- A blocked policy result returns envelope `blocked` and `isError` (`ROBOTS_DISALLOWED`, `DESTINATION_CHANGED`, `BLOCKED_DESTINATION`, `HTTP_BLOCKED`, `PRIVATE_DESTINATION`, `POLICY_BLOCKED`). A page destination that changes during collection is `inconclusive` with `TARGET_CHANGED`; it is not a policy block, publishes nothing and preserves the previous head. A navigation failure or deadline returns `inconclusive` and is retryable (`NAVIGATION_FAILED`, `CAPTURE_TIMEOUT`, `CAPTURE_DEADLINE_EXCEEDED`, `ROBOTS_UNAVAILABLE`). A second concurrent capture returns retryable `CAPTURE_BUSY`; it never waits out the other capture's deadline.
- One capture runs per cache at a time through the capture lease. The capture budget is 90 seconds; the lease TTL is 150 seconds (the 90-second budget plus 60 seconds of slack), and the lease is not a queue and there is no background scheduler.
- State capture supports `hover` and `focus` only. Click, type, submit, drag, keyboard navigation and route transitions are never performed. An unresolved, ambiguous or changed target makes that state inconclusive and does not abort the default capture.
- Component packs follow the Phase 4A bounds: at most 120 candidates, 12 packs, 150 nodes and depth 12 per pack. Hidden, offscreen and inferred types stay candidate-only.
- `components` is recorded in the capture config hash, but reuse is matched on the requested states, not on `components`. A `components: true` request that reuses a head captured with components off stays a reuse and returns `status: "partial"` with limitation `COMPONENTS_NOT_COLLECTED` and `components: []`; it never claims component completeness or launches a second capture. A `components: false` request only omits component summaries and counts them in `omitted.components`; an otherwise complete reuse stays `ok`/`complete`.
- Page-derived content is local evidence, not redistribution permission. Capture uses fresh anonymous contexts, rejects sensitive query parameters before launch, and redacts credentials, queries and fragments from exposed provenance.

### `export_evidence_pack` inputs, rights and constraints

| Input | Values | Default | Rules |
|---|---|---|---|
| `regionIds` | id[] | required | 1–12 distinct section/component regions from the active heads of one cached site. The page root and highlights are not selectable. |
| `goal` | string | neutral local-reference goal | At most 1,000 characters after trimming. |
| `includeMedia` | `references`, `permitted` | `references` | See the rights rules below. |
| `rightsAssertions` | `{artifactId, rights}[]` | none | At most 24, one per artifact id. Rights is the spec `RightsRecord`. |

Output data: `packId`, `directory`, `manifestPath`, `manifestHash`, `files` (`path`, `sha256`, `bytes`, `mimeType`), `selectedRegionIds`, `excludedArtifacts` (`artifactId`, `reason`), `validation` (`manifest`, `claims`, `hashes`, `designMd`) and `cached`.

Rights:

- `references` copies only derived manifests and summaries. Raw component packs and screenshots stay referenced by artifact id, path and hash; no source SVG, image, font, video, model or bundle enters the pack.
- `permitted` copies only selected stored artifacts covered by a caller assertion with status `owned`, `licensed` or `permission`, `scope: "export_copy"` and a non-empty reference. Unknown, missing, wrong-scope and restricted artifacts are excluded with a reason. Copies are capped at 24 artifacts, 8 MiB each and 32 MiB total — 32 MiB is the accepted release cap; spec §16 allows 64 MiB.
- No permission assertion overrides a robots or destination refusal. Missing third-party payloads are never fetched.
- Assertions are recorded, not independently verified, and are never presented as legal conclusions. Unknown rights stay unknown. Captured page content remains its creators' property and is not covered by this repository's MIT license.

Constraints:

- The pack is always written under `<cache>/atlas/evidence-packs/<packId>/`. There is no arbitrary output path, overwrite switch, asset downloader, public-sharing or publish operation.
- The pack id hashes the sorted region ids, the selected captures' identity and evidence hashes, the goal, the inclusion mode, the rights assertions and the Atlas/exporter versions. The same selection yields the same id.
- An existing intact pack is validated and returned with `cached: true`; a corrupt one returns `PACK_CORRUPT` and is preserved, never overwritten.
- Files are staged in a unique temporary directory, fully validated, then atomically renamed. `validation.designMd` is `not_applicable` when the selected evidence produces no DESIGN.md; the other three checks must pass.
- Export is local only: it reads the SQLite cache and artifact files, never the network. The specification's 15-second budget covers 12 regions and up to 64 MiB of copied artifacts. This release deliberately caps copied artifacts at 32 MiB: 32 MiB is the accepted release cap and the spec §16 64 MiB allowance is not implemented.

### Robots, rights and privacy

- Robots policy is evaluated before each new document request and redirect, using the most restrictive result of the project restrictions and the robots rules. Successful decisions are cached for at most 24 hours; 404/410 means no published rules; network failure and 5xx mean unavailable, so collection is deferred. No alternate transport bypasses a refusal, requested subresources are covered too, and a redirect decision that cannot be enforced before the request fails closed.
- Awwwards metadata requests stay at one request start per second. Live top-level navigations are limited to one start per origin per second. Browser subresources are bounded by the capture deadline and resource budget. There are no retries through 403/429, no stealth or proxy rotation, no authenticated fallback, and no retired endpoint is accessed during import, indexing, retrieval or export.
- Rights stay separate from source eligibility. Public access does not establish redistribution permission; unknown rights remain unknown; the repository's MIT license does not apply to captured content; no third-party payload enters public distribution automatically; and no export downloads a missing asset. Removal is supported by withdrawing heads and explicitly pruning unpinned artifacts.
- Capture uses fresh anonymous contexts with no cookies or session import. Credentials, queries and fragments are redacted from exposed provenance, sensitive URL parameter names are rejected before capture, and form values, passwords, tokens and hidden page content are not indexed. Email and phone strings are removed from bounded searchable excerpts. Page-derived text is treated as untrusted data, escaped in generated HTML/Markdown, and is never sent to an external model.

### v2 mapping

| v2 call | Atlas branch | Envelope |
|---|---|---|
| `search_references` | `request.kind: "sections"` or `"components"`, with the `search_atlas` filter fields inline in the same object | `search_atlas` |
| `get_reference` | `request.kind: "atlas_region"` (`regionId`), `"atlas_highlight"` (`elementId`) or `"atlas_taxonomy"` | `get_atlas.region`, `get_atlas.highlight` or `get_atlas.taxonomy` |
| `get_index` | `request.kind: "atlas_status"` | `get_atlas.status` |
| `capture_page` | `request.kind: "atlas"` with the `capture_atlas` fields inline | `capture_atlas` |
| `export_evidence_pack` | a new flat tool, not a branch | `export_evidence_pack` |

Old branches keep their existing response shapes. New branches use the Atlas envelope. Mixed v2 groups keep conservative annotations: `search_references`, `get_reference` and `get_index` stay read-only; `capture_page` is already non-read-only because its recording branch can interact with a page. A branch validating is not proof that the flag is on — with the flag off it returns `FEATURE_DISABLED`.

### CLI actions

Atlas extends the existing `awwwards-index` executable; there is no second binary. Every action requires `AWWWARDS_MCP_ATLAS=1` and is mutually exclusive with the normal site crawl.

| Action | Form | Network | Behaviour |
|---|---|---|---|
| Import | `--atlas import` | no | Project cached item pages and legacy gallery rows into Atlas. Never captures afterwards. |
| Capture | `--atlas capture --slug <slug> [--path /] --viewport desktop\|mobile\|both` | yes | Run the same guarded capture used by `capture_atlas`. `both` runs the desktop capture, then the mobile capture, sequentially. |
| Reindex | `--atlas reindex` | no | Rebuild the Atlas FTS layer and search projections from stored evidence. |
| Verify | `--atlas verify` | no | Offline, read-only artifact-integrity census. Reports checked/ok, external, missing, size-mismatch, hash-mismatch, not-a-file and unsafe-path counts, lists up to ten issues, and exits 1 when any issue exists. It never marks, rewrites or withdraws evidence. |
| Prune | `--atlas prune --older-than-days <N>` | no | Dry-run by default. Deletion requires an explicit `--apply` and user authorisation. |

Rules:

- Arguments are validated before any cache, client or file is constructed. An unknown or malformed action, or a missing flag, exits 2 with a usage message and no network access.
- `--atlas` is never combined with the site crawl. The existing `--elements` / `--elements=*` refusal is unchanged and still runs before cache construction.
- `reindex` and `verify` are offline. `verify` is read-only; `reindex` rebuilds the derived FTS layer and projections. `import` reads the local cache only.
- `verify` compares every stored artifact record with its recorded byte size and SHA-256. A missing file, size mismatch, hash mismatch, non-regular file or unsafe path is counted and reported, never repaired: no database write is performed, no head is withdrawn and no file is deleted.
- Pruning never removes active-head evidence, pack-pinned captures or artifacts, or any file outside the resolved Atlas cache subtree.
- Prune defaults to dry-run. `--apply` requires explicit user authorisation; there is no scheduled or automatic pruning.

### Scopes, states and evidence modes

**Scopes.** `region` (default) requires every predicate to be satisfied by the anchor region, with state claims sharing one sample key. `page` lets witnesses come from different regions of the same capture, viewport and state. `site` lets witnesses come from different explicit pages of the same site, with the same viewport and state, and returns an observation time span. Trait combinations never combine across regions except through the declared page or site scope, and never across sites. Each witness must satisfy the age constraint. `query` always matches the anchor.

**States.** `default`, `hover` and `focus`. A hover/focus query reads only evidence recorded for that exact state; default-state claims never fill a state query. Without state evidence the outcome is `insufficient_coverage`. Only explicit state capture produces those claims; click, type, submit and navigation are unsupported.

**Evidence modes.**

| Mode | Includes | Default |
|---|---|---|
| `accepted` | Accepted observed and accepted inferred claims. | no |
| `observed_only` | Accepted observed claims only; excludes inferred semantic purposes. | no |
| `candidate` | Accepted evidence plus candidate hints; every hit is marked `candidateOnly`. | yes, in this release |

Candidates, rejected claims, proposed claims and unknown values never satisfy `accepted` or `observed_only` predicates. Highlight regions are excluded from section and component search. The default `candidate` mode is the deliberate deviation described above.

**Freshness.** `maxAgeDays` defaults to 30 and is capped at 3650. A hit is displayed as `fresh` through seven days and `stale` afterwards; stale evidence is still returned inside the requested age window. Unknown observation times do not satisfy live-evidence queries. A failed refresh preserves the previous usable head.

### Limits

Search:

- `query` 1–300 characters and at most 16 tokens; at most 8 predicates; 1–8 canonical values per predicate; at most 4 distinct facets; `siteSlugs` 1–20 distinct; `limit` 1–20, default 8; `cursor` at most 4,096 characters and valid for 15 minutes.
- Response cap is 262,144 serialized bytes. Per-hit witnesses are capped at 200 per explanation and 2,000 per response, artifact descriptors at 8 per anchor and screenshot keys at 8 per hit. `responseTruncated` is true only when optional evidence was shed; per-field clipping is silent.
- Outcome is `matches`, `no_observed_match`, `empty_corpus` or `insufficient_coverage`. An empty index returns envelope `inconclusive`; absence of evidence is never proof of absence.

Capture (spec §9.5): 90-second wall time, 6,000 inspected DOM nodes, traversal depth 12, 200 headings, 24 sections, 120 component candidates, 12 component packs, 150 nodes and depth 12 per pack, 800 token-sampled nodes, 6 default scroll checkpoints, 3 explicit states, 18 screenshots, 2,400 CSS pixels per screenshot, 64 MiB stored artifacts and 128 claims per region. Exceeding a bound yields partial coverage and a specific limitation.

Export: 1–12 regions, 1,000-character goal, 24 rights assertions, 24 copied artifacts, 8 MiB per artifact, 32 MiB total copies, 24 KiB DESIGN.md, 256 KiB per JSON document and 1 MiB for the selection artifact. The 15-second export budget covers 12 regions and 64 MiB in spec §16; this release caps copies at 32 MiB, the accepted release cap.

Performance gates, not measured promises: local search p95 ≤300 ms without facets and ≤500 ms with four facets at 100,000 eligible regions; region retrieval ≤100 ms excluding payload reads; status ≤200 ms; live capture ≤90 s; one capture per cache; SQLite busy wait ≤5 s; cursor lifetime 15 minutes. The benchmark section below records the latest local measurements.

### Errors and inconclusive results

| Code | Envelope status | Meaning |
|---|---|---|
| `FEATURE_DISABLED` | error | Atlas is off; no tool registration, capture, publication or mutation. |
| `INVALID_INPUT` | error | Rejected before network or browser work. |
| `INVALID_SELECTION` | error | A pack selection is empty, duplicated, not 1–12 regions, not section/component, or spans sites. |
| `INVALID_STATE_REQUEST` | error | Unknown action, duplicate pair, foreign page/viewport, or unverifiable target; rejected before browser launch. |
| `UNSUPPORTED_PREDICATE` | error | Unknown field, disabled value, or a kind the corpus does not publish. |
| `UNSUPPORTED_KIND` / `UNSUPPORTED_STATE` / `UNSUPPORTED_GROUPING` | error | Search option not supported for that kind or release. |
| `UNKNOWN_SITE` / `INVALID_SITE_SLUG` | error | The slug is malformed or not in the local cache; no source discovery. |
| `UNSUPPORTED_ROUTE` | error | Path variant is not supported; no route guessing. |
| `UNSUPPORTED_PROTOCOL` / `CREDENTIAL_URL` | error | The cached reference is not HTTP(S) or carries credentials; refused before launch. |
| `LIVE_URL_UNAVAILABLE` / `REFERENCE_UNAVAILABLE` | inconclusive/error | The cached site has no usable live reference URL. |
| `REGION_NOT_FOUND` | error | No stored region has that id. |
| `AMBIGUOUS_ALIAS` | inconclusive | A highlight resolves to several regions; candidates are returned. |
| `ARTIFACT_MISSING` / `ARTIFACT_CORRUPT` | inconclusive | Stored bytes are absent or fail their hash; nothing is regenerated or fetched during a read. |
| `ROBOTS_DISALLOWED` | blocked | Refused by robots; no bypass. |
| `ROBOTS_UNAVAILABLE` | inconclusive | Robots could not be evaluated; collection is deferred. |
| `DESTINATION_CHANGED` / `BLOCKED_DESTINATION` / `PRIVATE_DESTINATION` / `HTTP_BLOCKED` | blocked | Destination or response is not eligible; no retry through the block. |
| `POLICY_BLOCKED` | blocked | Publication refused by capture policy. |
| `NAVIGATION_FAILED` | inconclusive | Main navigation failed; the previous head is preserved. |
| `CAPTURE_TIMEOUT` / `CAPTURE_DEADLINE_EXCEEDED` | inconclusive, retryable | Budget exhausted; publish only if minimum usability holds. |
| `OVERLAY_UNRESOLVED` | partial/inconclusive | A blocking overlay was not resolved; underlying content is not assumed observed. |
| `PARSER_DRIFT` | inconclusive | A parse no longer matches the expected shape; no replacement projection. |
| `TARGET_CHANGED` | inconclusive | The page destination changed during collection; nothing is published and the previous head is preserved. |
| `STATE_TARGET_MISSING` / `STATE_TARGET_AMBIGUOUS` / `STATE_TARGET_CHANGED` | limitation | A state target is missing, ambiguous or changed; that request is inconclusive with this limitation and there is no nearest-element fallback. |
| `CAPTURE_BUSY` | error, retryable | Another capture owns the per-cache lease. |
| `CAPTURE_LEASE_UNAVAILABLE` / `CAPTURE_LEASE_CORRUPT` | error, retryable | The lease cannot be acquired or read. |
| `PUBLICATION_BUSY` → `DATABASE_BUSY` | error, retryable | Another publication holds the cache; bounded retry only. |
| `FTS_UNAVAILABLE` | error for text queries | Facet-only search remains available. |
| `SEARCH_NOT_READY` | error, retryable | The search snapshot or projection is not ready; retry. |
| `CURSOR_STALE` / `CURSOR_EXPIRED` / `CURSOR_QUERY_MISMATCH` / `CURSOR_INVALID` | error | Restart from page one with the original query. |
| `RIGHTS_REQUIRED` | partial/error | Copies are excluded; references are retained where possible. |
| `PACK_CORRUPT` | error | The existing pack is invalid and is preserved, never overwritten. |
| `PACK_STALE` | error | A selected capture, region, artifact or claim changed before publication. |
| `STORAGE_LIMIT` | partial/error | Writes stop; prior valid data is preserved. |
| `SCHEMA_TOO_NEW` | error | The cache schema is newer than this binary; Atlas access is disabled and files are preserved. |
| `CAPTURE_FAILED` / `EXPORT_FAILED` / `NOT_PUBLISHED` | error/partial | The operation did not produce a publishable result; `published` states the truth. |

Publication evidence checks can also surface `ATTEMPT_NOT_PUBLISHABLE`, `NO_CLAIMS`, `DUPLICATE_REGION_KEY`, `INVALID_GEOMETRY`, `NO_SECTION_REGIONS`, `CLAIM_REGION_MISSING`, `PACK_OWNERSHIP_MISMATCH`, `EVIDENCE_UNRESOLVED` and `STALE_OBSERVATION`. A blocked or failed publication publishes nothing and preserves the previous head. Evidence-pack exclusion reasons appear in `excludedArtifacts[].reason`: `RIGHTS_NOT_ASSERTED`, `RIGHTS_UNKNOWN`, `RIGHTS_SCOPE`, `RIGHTS_REFERENCE`, `ARTIFACT_NOT_READY`, `ARTIFACT_INVALID`, `POLICY_UNKNOWN` and `ROBOTS_OR_DESTINATION_REFUSED`, alongside the size and count limits.

Collector coverage limitations — written to `coverage.limitations` and, for capture, also into envelope `warnings` — include `DOM_NODE_LIMIT`, `SECTION_TRUNCATION`, `SECTION_EXCLUDED`, `NO_SECTIONS`, `SCREENSHOT_LIMIT`, `SCREENSHOT_FAILED`, `SCREENSHOT_EMPTY`, `SCREENSHOT_INVALID`, `SCREENSHOTS_MISSING`, `CHECKPOINT_LIMIT`, `CHECKPOINT_EVIDENCE_LIMIT`, `CHECKPOINT_SECTION_TRUNCATION`, `CHECKPOINT_SECTION_EXCLUDED`, `CHECKPOINT_OBSERVATION_MISSING`, `SCROLL_ROOT_UNKNOWN`, `SCROLL_OFFSET_MISMATCH`, `REDIRECT_LIMIT`, `RESOURCE_NETWORK_ERROR`, `COMPONENT_CAP` (or `COMPONENT_CAP:<dropped>`), `COMPONENT_PACK_CAP`, `COMPONENT_PACK_TRUNCATED`, `COMPONENTS_NOT_COLLECTED`, `POLICY_BLOCKED`, `BLOCKED_DESTINATION` and `CAPTURE_DEADLINE_EXCEEDED`. State limitations are `STATE_TARGET_MISSING`, `STATE_TARGET_AMBIGUOUS`, `STATE_TARGET_CHANGED`, `STATE_TARGET_FULL_VIEWPORT`, `STATE_HOVER_NOT_ACTIVE`, `STATE_FOCUS_UNCONFIRMED`, `STATE_FOCUS_NOT_VISIBLE`, `STATE_NO_CHANGE`, `STATE_PROBE_FAILED`, `STATE_DEADLINE_EXCEEDED`, `STATE_RESET_FAILED` and `STATE_ARTIFACT_LIMIT`. Legacy import adds `LEGACY_DETAIL_MISSING`, `LEGACY_ELEMENTS_MISSING`, `LEGACY_ELEMENTS_MALFORMED`, `LEGACY_GALLERY_NO_SOURCE_ARTIFACT` and `MISSING_TIMESTAMP`. Candidate-mode search also adds the `CLASSIFICATION_AMBIGUOUS` warning; it is a search warning, not a collector limitation.

### Unsupported operations

`get_atlas` taxonomy reports this list explicitly; it is part of the contract, not a roadmap:

- `state.click` — click, type, submit, drag, keyboard navigation and route transitions are never performed.
- `accepted.inferred_component_type` — card, drawer, carousel, icon_button and tooltip stay candidate-only until human labels exist.
- `cross_site.combination` — scopes are same region, same page or same site; traits never combine across regions or sites.
- `asset.download` — search, retrieval and export never fetch missing third-party assets.
- `color.similarity` — no colour-similarity search.
- `vector.semantic_search` — SQLite FTS5 plus explicit predicates; no embeddings.
- `gallery.fetch` — highlights resolve through stored aliases only; the legacy gallery is not fetched.
- `arbitrary_url.capture` — capture accepts a known slug and a path on its known live origin.
- `reduced_motion.comparison` — not collected in this release.

Also unsupported: human classification editing, arbitrary export paths, pack overwrite, public sharing or publishing, background capture queues, automatic capture after import, and treating an observed subset as an official brand system.

### Examples

The examples are abridged to the fields that matter. `…` marks a clipped list, `<TypeName>` stands for one element of that contract type, and ids are shown as `<64-hex>`; none of these placeholders is a literal value. Field names follow the Phase 6 tool contract; where the specification describes content rather than key names, that contract is the reference.

#### `search_atlas`

Request:

```json
{
  "kind": "sections",
  "predicates": [
    { "field": "section.purpose", "values": ["hero"] },
    { "field": "region.landmark", "values": ["main"] }
  ],
  "scope": "region",
  "viewport": "desktop",
  "state": "default",
  "facets": ["region.tag"],
  "limit": 8
}
```

Response (abridged):

```json
{
  "schemaVersion": "awwwards-atlas-v1",
  "operation": "search_atlas",
  "status": "ok",
  "data": {
    "outcome": "matches",
    "revision": 42,
    "asOf": 1783000000000,
    "interpreted": {
      "kind": "sections",
      "predicates": [
        { "field": "section.purpose", "values": ["hero"] },
        { "field": "region.landmark", "values": ["main"] }
      ],
      "scope": "region",
      "viewport": "desktop",
      "state": "default",
      "evidenceMode": "candidate",
      "maxAgeDays": 30,
      "groupBy": "instance",
      "sort": "relevance",
      "facets": ["region.tag"],
      "limit": 8
    },
    "results": [
      {
        "regionId": "<64-hex>",
        "captureId": "<64-hex>",
        "pageId": "<64-hex>",
        "siteSlug": "example-site",
        "siteTitle": "Example Site",
        "sitePublicUrl": "https://example.com/",
        "sourceUrl": "https://www.awwwards.com/sites/example-site",
        "pageUrl": "https://example.com/",
        "pagePath": "/",
        "kind": "section",
        "componentType": null,
        "primaryLabel": "hero",
        "viewport": "desktop",
        "state": "default",
        "observedAt": 1782900000000,
        "freshness": "fresh",
        "matchedSampleKey": "default:0",
        "explanations": [
          {
            "field": "section.purpose",
            "values": ["hero"],
            "supportingRegionIds": ["<64-hex>"],
            "sampleKeys": ["default:0"],
            "truncated": false
          }
        ],
        "explanationsTruncated": false,
        "claims": [
          {
            "field": "section.purpose",
            "value": "hero",
            "classification": "inferred",
            "decision": "candidate",
            "basis": "rule_derivation",
            "sampleKey": "default:0"
          }
        ],
        "screenshotKeys": ["desktop:0"],
        "screenshotsTruncated": false,
        "artifacts": [
          {
            "kind": "screenshot",
            "storagePath": "atlas/artifacts/<sha256>.png",
            "sha256": "<sha256>",
            "bytes": 182000,
            "mimeType": "image/png"
          }
        ],
        "coverage": { "status": "complete", "collected": 1, "excluded": 0, "limitations": [] },
        "patternKey": null,
        "group": null,
        "candidateOnly": true
      }
    ],
    "total": 1,
    "countUnit": "region_instance",
    "nextCursor": null,
    "facets": [
      {
        "field": "region.tag",
        "disjunctive": true,
        "countUnit": "region_instance",
        "values": [{ "value": "section", "count": 1, "selected": false }]
      }
    ],
    "corpus": {
      "sites": 1,
      "pages": 1,
      "captures": 1,
      "note": "locally cached subset",
      "catalogueTotal": null
    },
    "candidateOnly": true,
    "candidateNote": "Candidate labels are hints, not accepted evidence.",
    "responseTruncated": false
  },
  "coverage": { "status": "complete", "collected": 1, "excluded": 0, "limitations": [] },
  "warnings": ["CLASSIFICATION_AMBIGUOUS"],
  "error": null
}
```

To page, resend the same request with `"cursor": "<nextCursor>"`. A changed query, viewport, scope, state or evidence mode with an old cursor returns `CURSOR_QUERY_MISMATCH`.

#### `get_atlas` — status

```json
{ "kind": "status" }
```

```json
{
  "schemaVersion": "awwwards-atlas-v1",
  "operation": "get_atlas.status",
  "status": "ok",
  "data": {
    "enabled": true,
    "available": true,
    "versions": {
      "schema": 10,
      "fts": 4,
      "vocabulary": "atlas-vocabulary-4",
      "classifier": "atlas-classifier-2",
      "currentSchema": 10,
      "currentFts": 4,
      "currentVocabulary": "atlas-vocabulary-4",
      "currentClassifier": "atlas-classifier-2"
    },
    "revision": 42,
    "updatedAt": 1783000000000,
    "counts": {
      "sources": { "awwwardsItem": 120, "legacyGallery": 0, "livePage": 18 },
      "regions": { "page": 18, "highlight": 0, "section": 612, "component": 240 },
      "captures": {
        "running": 0,
        "complete": 16,
        "partial": 2,
        "unknown": 0,
        "blocked": 0,
        "failed": 0,
        "abandoned": 0
      }
    },
    "liveCaptures": { "fresh": 15, "stale": 3, "total": 18 },
    "latestPublication": {
      "publishedAt": 1782990000000,
      "pageId": "<64-hex>",
      "captureId": "<64-hex>",
      "profileKey": "live-desktop"
    },
    "latestFailedAttempt": null,
    "lease": { "state": "free", "expiresAt": null, "ttlSeconds": null },
    "artifacts": { "records": 96, "distinctHashes": 91, "bytes": 48234496, "readyRecords": 94 },
    "fts": { "available": true, "version": 4 },
    "coverageNote": "Locally cached subset only; live-capture freshness is 30 days. Counts describe this cache, not all of Awwwards."
  },
  "coverage": { "status": "complete", "collected": 18, "excluded": 0, "limitations": [] },
  "warnings": [],
  "error": null
}
```

Version numbers in this example are from the current build; read them at runtime instead of pinning them.

#### `get_atlas` — taxonomy

```json
{ "kind": "taxonomy" }
```

The data is large; this is the shape of one field (abridged):

```json
{
  "registryVersion": "atlas-vocabulary-4",
  "fields": [
    {
      "field": "section.purpose",
      "support": "supported",
      "provider": null,
      "values": [
        {
          "value": "hero",
          "label": "Hero",
          "support": "supported",
          "enabled": true,
          "searchable": true,
          "permittedBases": ["rule_derivation", "human_review"],
          "aliases": [],
          "ruleIds": ["section.hero"]
        }
      ]
    }
  ],
  "scopes": ["region", "page", "site"],
  "states": ["default", "hover", "focus"],
  "evidenceModes": ["accepted", "observed_only", "candidate"],
  "groupBy": ["instance", "pattern"],
  "unsupported": [
    {
      "operation": "state.click",
      "reason": "Click, type, submit, drag, keyboard navigation and route transitions are never performed."
    }
  ]
}
```

#### `get_atlas` — region

```json
{ "kind": "region", "regionId": "<64-hex>" }
```

Response data (abridged; arrays are capped as described above):

```json
{
  "region": {
    "regionId": "<64-hex>",
    "captureId": "<64-hex>",
    "pageId": "<64-hex>",
    "parentId": null,
    "kind": "section",
    "ordinal": 2,
    "tag": "section",
    "role": "region",
    "landmark": "main",
    "selector": "main > section.hero",
    "heading": "Build faster",
    "textExcerpt": "…",
    "rawTitle": null,
    "primaryLabel": "hero",
    "patternKey": null,
    "fingerprint": "<hash>",
    "coverage": { "status": "complete", "collected": 1, "excluded": 0, "limitations": [] },
    "sampleKeys": ["default:0"],
    "geometry": { "x": 0, "y": 0, "width": 1440, "height": 900 },
    "viewport": "desktop"
  },
  "capture": {
    "captureId": "<64-hex>",
    "pageId": "<64-hex>",
    "siteSlug": "example-site",
    "sourceKind": "live_page",
    "profileKey": "live-desktop",
    "status": "complete",
    "startedAt": 1782980000000,
    "finishedAt": 1782980042000,
    "observedAt": 1782980000000,
    "lastConfirmedAt": 1782980042000,
    "sourceFetchedAt": 1782900000000,
    "configHash": "<hash>",
    "extractorVersion": "atlas-extractor-3",
    "classifierVersion": "atlas-classifier-2",
    "policy": { "robots": "allowed", "publicOnly": false },
    "conditions": {
      "browserVersion": "…",
      "dpr": 1,
      "reducedMotion": "no-preference",
      "viewport": "desktop",
      "requestedStates": []
    },
    "source": {
      "publicUrl": "https://example.com/",
      "path": "/",
      "requestedUrl": "https://example.com/"
    }
  },
  "claims": [
    {
      "claimId": "<64-hex>",
      "field": "section.purpose",
      "value": "hero",
      "sampleKey": "default:0",
      "state": "default",
      "classification": "inferred",
      "basis": "rule_derivation",
      "decision": "candidate",
      "ruleId": "section.hero",
      "ruleVersion": "1",
      "evidence": [
        { "artifactId": "<64-hex>", "pointer": "/regions/2", "sampleKey": "default:0" }
      ],
      "limitations": []
    }
  ],
  "claimsTruncated": false,
  "artifacts": [
    {
      "artifactId": "<64-hex>",
      "captureId": "<64-hex>",
      "regionId": "<64-hex>",
      "kind": "screenshot",
      "storagePath": "atlas/artifacts/<sha256>.png",
      "sha256": "<sha256>",
      "bytes": 182000,
      "mimeType": "image/png",
      "state": "ready",
      "available": true,
      "availabilityNote": null
    }
  ],
  "artifactsTruncated": false,
  "parent": null,
  "children": [],
  "childrenTruncated": false,
  "head": { "current": true, "headCaptureId": "<64-hex>", "publishedAt": 1782980042000 }
}
```

The raw component tree is never embedded. Use the `component_pack` artifact's `storagePath` and `sha256` to read it locally.

#### `get_atlas` — highlight

Ambiguous id:

```json
{ "kind": "highlight", "elementId": "example-legacy-slug" }
```

```json
{
  "schemaVersion": "awwwards-atlas-v1",
  "operation": "get_atlas.highlight",
  "status": "inconclusive",
  "data": {
    "elementId": "example-legacy-slug",
    "status": "ambiguous",
    "aliasKind": "legacy_element_slug",
    "regionIds": ["<64-hex>", "<64-hex>"],
    "region": null
  },
  "coverage": { "status": "unknown", "collected": 0, "excluded": 0, "limitations": [] },
  "warnings": [],
  "error": {
    "code": "AMBIGUOUS_ALIAS",
    "message": "The element id resolves to more than one Atlas region; choose one of the returned region ids",
    "retryable": false
  }
}
```

A single resolution returns `status: "ok"` with `data.status: "resolved"` and `data.region` filled by the `get_atlas` region shape. An unknown id returns `inconclusive` with `data.status: "not_found"`, `regionIds: []` and `error: null`.

#### `capture_atlas`

Request:

```json
{
  "slug": "example-site",
  "viewport": "mobile",
  "components": true,
  "states": [
    { "action": "hover", "targetRegionId": "<64-hex>" }
  ],
  "refresh": false
}
```

Published response (abridged):

```json
{
  "schemaVersion": "awwwards-atlas-v1",
  "operation": "capture_atlas",
  "status": "ok",
  "data": {
    "captureId": "<64-hex>",
    "attemptId": "<uuid>",
    "pageId": "<64-hex>",
    "cached": false,
    "published": true,
    "previousHeadId": "<64-hex>",
    "viewport": "mobile",
    "sections": [
      {
        "regionId": "<64-hex>",
        "kind": "section",
        "ordinal": 0,
        "tag": "header",
        "role": "banner",
        "landmark": "header",
        "selector": "body > header",
        "heading": "",
        "primaryLabel": "header",
        "type": null,
        "patternKey": null,
        "rect": { "x": 0, "y": 0, "width": 390, "height": 72 },
        "visible": true,
        "state": null,
        "coverage": { "status": "complete", "collected": 1, "excluded": 0, "limitations": [] }
      }
    ],
    "components": ["<RegionSummary>"],
    "artifacts": ["<ArtifactAvailability>"],
    "capabilityCoverage": {
      "geometry": { "status": "complete", "collected": 18, "excluded": 0, "limitations": [] },
      "sections": { "status": "complete", "collected": 7, "excluded": 0, "limitations": [] },
      "components": { "status": "complete", "collected": 12, "excluded": 0, "limitations": [] },
      "screenshots": { "status": "complete", "collected": 8, "excluded": 0, "limitations": [] },
      "tokens": { "status": "unknown", "collected": 0, "excluded": 0, "limitations": [] },
      "states": { "status": "complete", "collected": 1, "excluded": 0, "limitations": [] },
      "motion": { "status": "unknown", "collected": 0, "excluded": 0, "limitations": [] },
      "rendering": { "status": "unknown", "collected": 0, "excluded": 0, "limitations": [] },
      "policy": { "status": "complete", "collected": 0, "excluded": 0, "limitations": [] }
    },
    "omitted": { "sections": 0, "components": 0, "screenshots": 0, "componentPacks": 0 }
  },
  "coverage": { "status": "complete", "collected": 19, "excluded": 0, "limitations": [] },
  "warnings": [],
  "error": null
}
```

Unpublished partial result: `status: "partial"`, `published: false`, `cached: false`, `captureId: ""` when nothing was stored, and the previous head untouched. A cached reuse returns `cached: true`, `published: false`, `previousHeadId: null` and the stored summaries.

#### `export_evidence_pack`

Request:

```json
{
  "regionIds": ["<64-hex>", "<64-hex>"],
  "goal": "Rebuild the hero and pricing sections in the same visual language",
  "includeMedia": "permitted",
  "rightsAssertions": [
    {
      "artifactId": "<64-hex>",
      "rights": {
        "status": "licensed",
        "reference": "licence-ref-2026-11",
        "recordedAt": 1783000000000,
        "assertedBy": "caller",
        "scope": "export_copy"
      }
    }
  ]
}
```

Response (abridged):

```json
{
  "schemaVersion": "awwwards-atlas-v1",
  "operation": "export_evidence_pack",
  "status": "ok",
  "data": {
    "packId": "<64-hex>",
    "directory": "<cache>/atlas/evidence-packs/<packId>",
    "manifestPath": "<cache>/atlas/evidence-packs/<packId>/manifest.json",
    "manifestHash": "<64-hex>",
    "files": [
      { "path": "design-evidence.json", "sha256": "<64-hex>", "bytes": 22100, "mimeType": "application/json" },
      { "path": "DESIGN.md", "sha256": "<64-hex>", "bytes": 6100, "mimeType": "text/markdown" },
      { "path": "artifacts/<artifactId>-<sha256>.png", "sha256": "<64-hex>", "bytes": 182000, "mimeType": "image/png" }
    ],
    "selectedRegionIds": ["<64-hex>", "<64-hex>"],
    "excludedArtifacts": [
      { "artifactId": "<64-hex>", "reason": "RIGHTS_UNKNOWN" }
    ],
    "validation": { "manifest": "pass", "claims": "pass", "hashes": "pass", "designMd": "pass" },
    "cached": false
  },
  "coverage": { "status": "complete", "collected": 3, "excluded": 1, "limitations": [] },
  "warnings": [],
  "error": null
}
```

Files with no supporting evidence are omitted and listed in the manifest; no placeholder claims are written.

#### v2 calls

```text
{ "request": { "kind": "sections", "predicates": [{ "field": "section.purpose", "values": ["pricing"] }], "limit": 4 } }
{ "request": { "kind": "components", "predicates": [{ "field": "component.type", "values": ["card"] }], "groupBy": "pattern", "limit": 4 } }
{ "request": { "kind": "atlas_region", "regionId": "<64-hex>" } }
{ "request": { "kind": "atlas_highlight", "elementId": "example-legacy-slug" } }
{ "request": { "kind": "atlas_taxonomy" } }
{ "request": { "kind": "atlas_status" } }
{ "request": { "kind": "atlas", "slug": "example-site", "viewport": "desktop", "refresh": false } }
{ "regionIds": ["<64-hex>"], "goal": "Local reference for a pricing-section rebuild" }
```

The first two are `search_references`, the next three `get_reference`, the sixth `get_index`, the seventh `capture_page`, and the last is the flat `export_evidence_pack`. Each returns its Atlas envelope.

#### CLI

```bash
# Project the existing cache; no capture afterwards.
awwwards-index --atlas import

# One viewport, or desktop then mobile sequentially.
awwwards-index --atlas capture --slug example-site --viewport desktop
awwwards-index --atlas capture --slug example-site --path /pricing --viewport both

# Offline maintenance.
awwwards-index --atlas reindex
awwwards-index --atlas verify

# Dry-run first; --apply deletes after explicit authorisation.
awwwards-index --atlas prune --older-than-days 30
awwwards-index --atlas prune --older-than-days 30 --apply
```

Every command above requires `AWWWARDS_MCP_ATLAS=1`. From a local checkout, use `npm run index -- --atlas …`; the arguments after `--` are identical.

## Phase 3 search

Phase 3 implemented the search core locally; Phase 6 exposes it through `search_atlas` and the v2 `search_references` branches:

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

Phase 4A implemented component search locally; Phase 6 exposes it through `search_atlas kind:"components"`:

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

**F9 held-out component gate (spec 17.4) is not met.** Accepted native/declared type precision >= 95% is measured against held-out human labels. No held-out human component labels exist yet; the fixtures only audit the mapping table and structural rules, so they are not a precision measurement. The component held-out harness now exports blind rows and scores accepted types, but the gate opens only after humans label a fresh corpus. A 2026-11-12 Codex-labeled provisional run covered 44 pages and 512 accepted components using the older `regionKey` label format; it predates the `nodeKey` keying, is not scoreable by the current harness, and is retained only as calibration history — it does not validate the current blind export. Inferred card/drawer/tooltip/carousel/icon_button quality is reported as unreviewed with no precision claim.

## Phase 4B explicit states

Phase 4B implemented explicit states locally; Phase 6 exposes them through `search_atlas state:"hover"|"focus"` and the `capture_atlas` states input:

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



## Phase 5 evidence packs

Phase 5 implemented this as an internal export path and left the surfaces unchanged; Phase 6 adds the `export_evidence_pack` tool. No schema change was needed (v10 already has `atlas_packs`):

- Public internal interfaces: `buildEvidencePack(input, store)`, `validateEvidencePack(path)`, `renderDesignMd(selection)` and `renderRebuildHandoff(selection, goal)`.
- Input: `siteSlug`, a required bounded goal (1,000 characters), 1-200 region ids, optional capture ids, `inclusionMode: "references" | "permitted"` (default `references`) and up to 24 rights assertions.
- Selection ownership: every region must exist, be a `section` or `component` (never the page root or a highlight), belong to a capture that is the site's active head, match the requested capture filter and belong to the requested site. Unknown, foreign, duplicate, root/page-only and capture-mismatched ids fail with typed `INVALID_SELECTION` before any directory is created. Region ids are sorted for output; duplicate input ids are rejected instead of silently collapsed.
- Pack directory: `<cache>/atlas/evidence-packs/<packId>/` with `manifest.json`, `design-evidence.json`, `DESIGN.md`, `brief.md`, `tokens.json`, `tokens.css`, `components.json`, `rebuild-handoff.md` and `artifacts/selection.json`. The derived selection artifact is the bounded source of truth for every evidence JSON pointer; it contains no source HTML, text excerpt or media bytes.
- Pack id hashes the sorted selected region ids, the selected captures' identity/config/evidence hashes and canonical policy decisions (allowed/denied/unknown), referenced artifact ids/hashes/sizes, the goal, inclusion mode and rights assertions, and the vocabulary, classifier, exporter, schema and FTS versions. It does not include the creation clock, so the same selection has the same id and a changed capture policy produces a new id.
- `manifest.json` records the schema/exporter versions, pack id and creation time, goal, region/capture ids, site attribution and source URLs, capture conditions and observation dates, vocabulary/classifier/extractor versions, every file hash except the manifest itself, artifact include/exclude decisions and references, rights assertions, coverage, limitations, claim ids used by the generated documents and the omitted evidence families.
- `design-evidence.json` follows the existing `awwwards-design-md` evidence distinction: every material value is `observed`, `inferred` or `proposed`, carries a stable claim id, source region and capture, a JSON pointer that resolves in `artifacts/selection.json`, viewport/state/sample, method/rule, sample count and limitations. Values without evidence are omitted and listed in the manifest; no placeholder value is emitted.
- `DESIGN.md` uses the skill's H2-only order: Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Components, Do's and Don'ts, Sources, Coverage and limitations, Unresolved details. It describes the observed subset, identifies generated token names, marks missing viewports/states, resolves material values through claim ids and never invents elevation, font substitutes, brand intent, spacing systems or motion rules.
- `tokens.json` / `tokens.css` are generated from observed section `backgroundColor` and selected component `display`, `gap`, `padding`, `border-radius`, `font-family`, `font-size`, `font-weight` and `line-height`. Names are generated (`--atlas-*`), values are sorted deterministically, unavailable families are omitted, and every token carries its claim ids and selection pointers. `display` is emitted as a generated custom property too.
- `components.json` lists selected sections and components with type, type classification, candidate-only status, pattern key, geometry, observed styles, state claims and the component-pack reference or permitted copy. `brief.md` contains the goal, selected evidence, supported commonalities and differences, missing evidence and explicitly labelled proposed adaptations. `rebuild-handoff.md` contains the intended order, observed constraints, permitted versus reference-only assets, verification targets and limitations; it states that `build_project` cannot recover application logic, data, business rules, fonts, licensed assets or unobserved interactions. Page-derived prose is escaped for CommonMark (links, images, raw HTML, backticks and block structure cannot be injected), generated URLs are emitted only as vetted code spans, and `components.json` display text is single-line and Markdown-neutralized.
- Inclusion modes: `references` copies only derived summaries; component packs and screenshots stay referenced by artifact id/path/hash and no source SVG, image, font, video, model or bundle is copied. `permitted` copies only selected stored artifacts whose caller assertion is `owned`, `licensed` or `permission`, has `scope: "export_copy"` and a non-empty rights reference. Unknown, missing, wrong-scope and restricted artifacts are excluded with a reason (`RIGHTS_NOT_ASSERTED`, `RIGHTS_UNKNOWN`, `RIGHTS_SCOPE`, `RIGHTS_REFERENCE`, `ARTIFACT_NOT_READY`, `ARTIFACT_INVALID`, `POLICY_UNKNOWN`, `ROBOTS_OR_DESTINATION_REFUSED`, size/count limits). A permission assertion never overrides a robots or destination refusal.
- Copy safety: sources are resolved through the existing artifact containment check (absolute, traversal, junction and symlink paths are refused), must be regular files, must match the stored byte size and SHA-256, and are capped at 24 artifacts, 8 MiB each and 32 MiB total. Stored media paths are sanitized at build time (unsafe absolute or traversal values become `null` in the selection and components documents) and re-checked by the validator. Copies are written under exactly `artifacts/<artifactId>-<sha256><extension>` so identical bytes from different captures keep distinct names, and are validated again after writing.
- Writes: the pack is built in a unique `.tmp-*` directory inside `evidence-packs`, fully validated, then published. Fresh publication, the final head/region recheck, the atomic rename and the `atlas_packs` registration commit inside one `BEGIN IMMEDIATE` write transaction, so a concurrent head retirement, region rewrite, capture change or replacement cannot interleave between the recheck and the rename. Fresh publication re-derives every selected capture and region from `atlas_captures`/`atlas_pages`/`atlas_regions`/`atlas_heads`: each region must still name its own capture, that capture must be the selected active head of the same page/profile, page/profile/viewport/kind/ordinal/parent, every stored samples-derived field (role, landmark, type, type classification, pattern key, geometry, background, observations, region-coverage limitations) and each component's computed styles and scan-artifact pointer must still derive from the current row and its hash/size-checked scan artifact, every exported claim must still match its accepted `atlas_claims` row or selected region value with a capture and viewport equal to that region, and each capture's provenance must still match; a changed capture, region, artifact or claim returns typed `PACK_STALE` before any rename. After pre-publication validation the staged manifest pin, every `manifest.files` hash/size and the canonical selection hash are frozen, then re-hashed under the lock after the pre-rename seam and again after the post-rename seam (source artifacts are not re-read); a seam or another process that rewrites provenance and regenerates every document/hash self-consistently still returns `PACK_CORRUPT`, removes only a final directory this build created and registers nothing, and the `atlas_packs` row uses the frozen manifest hash rather than one recomputed from the final bytes. A failure before rename removes the temp directory and publishes nothing. An existing final directory is never overwritten: it is validated and adopted as `cached` only inside a `BEGIN IMMEDIATE` transaction that rechecks every selected region still belongs to an active head of the same site, re-derives each selected capture's provenance (viewport/profile, browser, DPR, observation dates, conditions, coverage, hashes, policy, status and source URLs) from `atlas_captures`/`atlas_capture_summary`/`atlas_pages`, compares it with the selection, re-derives each exported claim from `atlas_claims` (id, region, capture, field, value, accepted decision, classification, basis/tier, state, sample key, rule and limitations) or, for derived style/background/geometry claims, from the selected region value and pointer, requires each claim's capture and viewport to equal its selected region, binds every selection reference and media decision to the current `atlas_artifacts` row (capture, region, kind, storage path, hash, size, MIME, state and rights), and rechecks that the recorded policy decisions still match current capture policy; a retired head, removed or rewritten region, changed/denying policy or a copy that is no longer permitted returns typed `PACK_STALE` and is never registered or served, while an invalid pack returns `PACK_CORRUPT`. An identical refetch that only advances `last_confirmed_at` is freshness, not changed evidence: a pack whose recorded confirmation is at or before the current DB confirmation adopts and serves for as long as every other capture field still matches; a backwards confirmation or any other capture change returns `PACK_STALE`. A registered pack is pinned by its canonical `manifest_hash`, which excludes the advisory `createdAt` clock so concurrent builds with different clocks share one pin: publication and adoption compare the recomputed canonical hash with the row before writing, and a differing hash beside an existing registered directory returns `PACK_CORRUPT` without adopting the pack or overwriting the pin; only a missing registered `storage_path` lets a freshly validated rebuild replace that pin. Adoption is limited to a canonical directory inside `<cache>/atlas/evidence-packs` and returns `PACK_OUTSIDE_STORE` before reading any file otherwise; the supplied pack directory is `lstat`-checked before any `realpath`, and a symlinked or junctioned `<cache>/atlas`, `<cache>/atlas/evidence-packs` or pack directory is refused, so a redirect (including pack A junctioned to pack B) never returns another pack's identity. A build verifies the returned pack id equals its recomputed id, and adoption verifies the requested id when one is supplied. Concurrent publishers of the same selection race on the atomic rename; the loser waits for the write lock, revalidates the winner's directory and registers it. If post-rename validation fails, only the final directory created by that build is removed after containment/ownership checks; a valid pack whose database registration fails is kept for later adoption.
- Pin registration: `atlas_packs` is written only after successful publication (or when an intact existing pack is adopted), with `state = 'ready'`, the canonical manifest hash, the exporter version and a `selection_json` summary. A corrupt or failed pack is never registered, and a pin is only ever replaced by a validated rebuild of a pack whose registered directory is missing. Registration is idempotent.
- `validateEvidencePack` is an independent integrity pass: it requires every required file and JSON document, validates every 12.1 manifest field and nested type (versions, captures and conditions, observation dates, coverage, rights, omitted families, artifact decisions and references), verifies every manifest hash and size, rejects unlisted files, path traversal and symlinks, checks that claim source region/capture ids are non-empty strings, that every source and derived claim's capture and viewport equal its selected region, validates manifest, selection and components artifact paths, re-derives the pack id from the selection artifact and compares it with the manifest and directory, requires multiset equality (duplicates are never masked) between the manifest and selection (regions, captures, claims, goal, site and inclusion mode) and compares each manifest capture's complete record (viewport, browser, DPR, observation dates, conditions, coverage) against its selection capture, resolves every claim pointer against `artifacts/selection.json` only, compares its value, checks claim ids against the manifest and generated documents, validates the DESIGN.md front matter and exact H2 order, rejects base64 images and strong template markers (`{{`, `}}`, `REPLACE_ME`, `lorem ipsum`, `TBD:`, `TODO:`) in prose without masking the goal, observed values or generated code spans, enforces document and copied-artifact caps, stats every listed file and refuses one over the applicable cap before reading it, and verifies included artifacts and capture hashes. It also requires exact exporter/vocabulary/classifier/schema/FTS versions and known extractor/classifier versions per capture, a supported site attribution and exact file MIME types, binds every `artifacts.included` copy to both its selection media decision and its selection reference (capture id, kind, hash, size, MIME and ready state) with the exact `artifacts/<artifactId>-<sha256><ext>` path, requires each selection media `storagePath` to equal its reference `storagePath`, and requires a qualifying `owned`/`licensed`/`permission` `export_copy` rights record under an allowed capture policy. It re-derives the section and component summaries from the selected regions and claims and rejects a summary whose type, classification, pattern key, section linkage, geometry, styles, claims or state counts disagree (`SELECTION_MISMATCH`). It re-renders every generated document from `artifacts/selection.json` with the same renderers and byte-compares `artifacts/selection.json`, `DESIGN.md`, `tokens.json`, `tokens.css`, `components.json`, `brief.md`, `rebuild-handoff.md` and `design-evidence.json`, so appended CSS, prose or formatting returns `DOCUMENT_RENDER_MISMATCH`. Manifest coverage, limitations, omitted families, excluded artifacts and artifact references are compared with the selection and with recomputed coverage/omitted/token decisions (`MANIFEST_DECISION_MISMATCH`; objects are compared canonically so key order never changes validity), and `createdAt` must be an integer millisecond timestamp in the JS Date range; the creation clock is advisory and excluded from the `atlas_packs.manifest_hash` pin, and it is not range-derived from observation dates because source evidence may be timestamped after the export. It checks generated token and `tokens.css` values against claim values and pointers, checks DESIGN.md color/font/geometry/style/material values against claims (including unclaimed elevation), and requires every claim's classification/source/method/sampleKey to match the selection claim. Malformed nested structures fail with an error code instead of throwing.
- The spec's 17.2 `test/atlas-export.test.ts` suite is implemented as `test/atlas-evidence-pack.test.ts` (plus `test/helpers/atlas-pack-fixture.ts`); no separate export suite exists.
- Policy refusal is fail-closed: only an explicit affirmative policy (`robots: "allowed"`, `status: "allowed"` or `publicOnly: true`) allows a copy; a missing, empty or malformed capture `policy_json` yields `POLICY_UNKNOWN`, and no permission assertion can override either refusal.
- Caps: 200 selected regions, 1,000-character goal, 24 rights assertions, 24 copied artifacts, 8 MiB per artifact, 32 MiB total copies (the accepted release cap; spec §16 allows 64 MiB), 24 KiB DESIGN.md, 256 KiB design-evidence/sidecar and other documents, 1 MiB selection artifact. These are enforced before the final directory is published.
- No network: build and validation read only the SQLite cache and local artifact files; they never refresh captures, fetch assets or resolve a URL.
- Known gaps: Phase 5 shipped as an internal export path; Phase 6A exposes it as a tool. `permitted` mode cannot acquire missing payloads or override robots/destination refusals; raw `external_media` artifacts are never copied; elevation/border/motion values are omitted unless a future capture stores default-state evidence; component styles depend on the stored initial scan and are omitted when the scan artifact is unavailable; selected regions may span multiple active captures/pages of one site (narrowed by an optional `captureIds` filter), and the documents separate them by capture. A process killed mid-write can leave a `.tmp-*` directory (never a final pack); a database failure after the atomic rename leaves a complete but unregistered pack that the next build adopts and registers.

## Search

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

## Phase 6B CLI maintenance

The existing `awwwards-index` executable exposes explicit Atlas actions. There is no new binary, and no automatic capture after an import.

```bash
AWWWARDS_MCP_ATLAS=1 awwwards-index --atlas import
AWWWARDS_MCP_ATLAS=1 awwwards-index --atlas capture --slug <slug> [--path /] --viewport desktop|mobile|both
AWWWARDS_MCP_ATLAS=1 awwwards-index --atlas reindex
AWWWARDS_MCP_ATLAS=1 awwwards-index --atlas verify
AWWWARDS_MCP_ATLAS=1 awwwards-index --atlas prune --older-than-days <N>
AWWWARDS_MCP_ATLAS=1 awwwards-index --atlas prune --older-than-days <N> --apply
```

- Every action requires `AWWWARDS_MCP_ATLAS=1`. A missing flag or a malformed argument exits `2` before the cache directory, cache database or network client is created.
- Atlas actions are mutually exclusive with the normal site crawl. `--elements` keeps its existing refusal before cache construction.
- `capture` resolves the cached Awwwards slug to its known live origin, refuses arbitrary URLs, and never follows a failed target into the crawler. The documented spec form includes `--path /`: `--slug <slug> --path / --viewport desktop|mobile|both`. `--path` may be omitted and then defaults to `/`. `--viewport both` runs the desktop capture and publish, then the mobile capture and publish, sequentially.
- `reindex` is offline: it validates active heads, repairs the canonical FTS documents and rebuilds the revision-keyed search projections. A repaired head set or changed FTS document set bumps the revision once; a projection-only rebuild does not bump it, and an identical rerun leaves the revision unchanged.
- `verify` is offline and reports stored artifact integrity (`missing`, size, hash, not-a-file and unsafe-path counts). It prints the artifact ID and kind of up to ten issues (plus a remaining-issue count) and exits `1` when any artifact fails. It opens the cache read-only: it does not create the cache, migrate it or touch the database. A cache without Atlas tables also exits `1`; run `--atlas import` or `--atlas reindex` first.
- `prune` is a dry run by default. `--apply` is required to delete. It never removes active-head evidence, captures pinned by an `atlas_packs` registration, running captures, captures younger than the cutoff, or any capture with an artifact path that resolves outside `<cache>/atlas/artifacts`. Unsafe-path and non-regular-file captures are classified independently of artifact row order: a capture with both is skipped once, still counts as one unsafe capture and one not-file capture, never becomes eligible, and makes the command exit `1`. A non-regular artifact path always counts as a file failure, so `--apply` never reports that evidence as removed. Shared content-addressed files stay while any remaining artifact references them. Files are unlinked under the artifact lock, after deletion, and only when still unreferenced; publication holds the same per-path lock from artifact write or validation through COMMIT, so prune cannot unlink bytes under an uncommitted reference.
- The artifact lock wait is bounded at 120 s, longer than a full publish (the 100k-region projection rebuild was measured at 7.6-17.7 s and runs inside the publish transaction) but not unbounded. A wait that exceeds it fails closed with `Atlas artifact lock timeout`; prune counts it as a file failure and exits `1` without unlinking, so the caller retries.
- A prune that removes a shared file before an in-flight capture publishes makes that capture fail artifact validation instead of leaving a dangling reference. The publish pre-flight withdraws heads whose artifacts are already invalid, but the recheck inside the publish transaction returns `ARTIFACT_INVALID` without withdrawing a head; `verify` reports the missing file and the next successful publish replaces the head.
- The unlink pass runs after COMMIT and is not transactional. A crash between the commit and the unlink leaves an unreferenced artifact file behind. `verify` walks database rows and does not report it, and no reclaim command exists; the file is inert because no row references it, and a later identical artifact write reuses the same content-addressed path.
- Output is counts, typed codes, verify artifact IDs/kinds and redacted failure messages; stack traces and absolute cache paths are never printed.

## Component held-out review (F9)

F9 is component-type precision, not section classification. The harness exports only scorable accepted rows to the labeler's file and keeps every prediction out of it.

```bash
npm run atlas:heldout -- collect-components <cacheRoot> <siteSlug> <outDir>
# label <outDir>/components-review.json, filling <outDir>/component-labels.json
npm run atlas:heldout -- score-components <outDir>/components-review-full.json <outDir>/component-labels.json
# or score every <outRoot>/<slug>/ pair together:
npm run atlas:heldout -- score-components-corpus <outRoot>
```

- `components-review.json` is the blind input. It contains only scorable accepted components — observed `native_semantics`/`declared_aria` rows whose `acceptedTypes` is exactly one real vocabulary type other than `none` or `ambiguous` — with selector, tag, role, accessible name, section heading, rect, screenshot keys, `inputType`, `ariaHasPopup`, `ariaExpanded`, `ariaControlsResolved`, `inNavigation` and the bounded 200-character `ariaLabel`. It contains no predicted type, basis, classification, decision, rule ID or claim.
- `component-labels.json` is a map from `capture|viewport|nodeKey` to exactly one human label for those scorable accepted components. The key contains no type, unlike the hashed region key, so a labeler cannot brute-force the prediction from it.
- Allowed labels are the `component.type` vocabulary entries with `support: "supported"`, excluding the inferred types (`card`, `drawer`, `carousel`, `icon_button`, `tooltip`), plus `none` and `ambiguous`.
- `components-review-full.json` is the scoring input and must not be shown to labelers.
- Only `components-review.json` may be shared with labelers. Never hand over the output directory or the full review: the full review contains the predictions, and the labels file reveals the keys they are scored under.
- Every accepted **scorable** component needs a label. Candidate and inferred components are excluded from the precision denominator.
- An accepted scorable row is defined once (`isScorableAcceptedComponent`) and used by both the blind export and the scorer, so the labelable set and the measured set cannot diverge. An accepted row outside that set is listed in `invalidAcceptedRows`, stays out of the denominator and forces the gate to `fail`.
- `score-components-corpus` reads immediate child directories only. Every immediate child directory of the corpus root must be a real directory and a complete page with both files, so an unrelated nested directory aborts scoring rather than being skipped. A symlinked or junction page directory is refused with `HELDOUT_COMPONENT_INVALID_CORPUS` instead of being skipped; a symlinked file is ignored like any other stray file. A label key may not repeat across pages, and `__proto__`, `constructor` and `prototype` are reserved.
- Re-running `collect-components` rewrites the full and blind reviews but never overwrites an existing `component-labels.json`, so re-collecting a page keeps human labels. Use a fresh output directory for a fresh corpus; labels from an older capture no longer match and are reported as unknown keys.
- Per-type status is `pass` at precision >= 0.95 with at least 20 accepted samples, `insufficient` below 20, and `fail` below 0.95. The report gate is `fail` if any measured type fails, `insufficient` if any type lacks samples or nothing was measured, else `pass`.
- `score-components` and `score-components-corpus` are report-only: they print the report and exit 0 even when the gate is `fail` or `insufficient`. Callers must parse `report.gate`; no `--fail-on-gate` flag exists.

### Labeling contract

- An explicit ARIA role wins over the native tag.
- The one navigation exception: for a `nav` element or `role="navigation"`, a bounded 200-character `ariaLabel` matching `breadcrumb` case-insensitively yields `breadcrumb`; otherwise a bounded 200-character `ariaLabel` matching `pager` or `pagination` yields `pagination`; otherwise `navigation`. Breadcrumb is tested first. The page scan's component hint matches this bounded 200-character `ariaLabel` (trimmed, then capped) and the blind row carries the same value.
- `navigation_trigger` only when all of these hold: the row is inside a navigation landmark (`inNavigation` is true); the element is an `a` or `button`, or has `role="button"` or `role="link"`; it declares `aria-haspopup` or `aria-expanded`; and its `aria-controls` resolves to real content. A `nav` landmark without a button/link role follows the breadcrumb/pagination/navigation exception above; a `navigation_trigger` outside a `nav` landmark (or `role="navigation"`) is not a trigger.
- For an `input`, its type decides `checkbox`, `radio` or `text_input`; button-like input types remain `button`.
- If no rule yields exactly one type, label `ambiguous`; use `none` only when the row is not a component at all.

Blind rows carry only evidence, never predictions. Do not infer the label from the row order, the section heading or the scoring report.

Do not tune rules on the rows used to score them. Demote a failing type to candidate or change its rule, then collect a fresh held-out set before re-scoring.

## Next phase

Phase 6 tool surfaces, v2 branches and Atlas CLI actions are implemented and gated behind `AWWWARDS_MCP_ATLAS=1`. Remaining Phase 6 work is release qualification, not new behaviour:

- installed-artifact and browser qualification reports
- optional CLI entry point for local pack creation (not implemented; no pack CLI exists, and `export_evidence_pack` is the only pack surface)
- human review of generated DESIGN.md/brief/handoff from a permitted pilot pack
- real-page density and rights checks on the held-out corpus
- component-pack and screenshot copy policy sign-off before any public distribution

Until the flag is enabled, the surfaces stay 41 full / 13 core / 15 v2. With `AWWWARDS_MCP_ATLAS=1` they are 45 / 13 / 16.

## Verification

```bash
npm run typecheck
npm test -- --maxWorkers=2
npm run build
npm run protocol:smoke
AWWWARDS_MCP_ATLAS=1 npm run protocol:smoke
npm run atlas:search:bench
npx vitest run test/atlas-tool-surface.test.ts test/atlas-tool-contracts.test.ts test/atlas-tool-capture.test.ts
npx vitest run test/atlas-docs.test.ts
npx vitest run test/atlas-evidence-pack.test.ts
npx vitest run test/atlas-collector.chromium.test.ts
```

The held-out report and corpus are local review artifacts and are not committed.
