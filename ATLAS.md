# Atlas (experimental)

Atlas is the section-level evidence layer for awwwards-mcp. It is **opt-in** and off by default:

```bash
AWWWARDS_MCP_ATLAS=1
```

It adds capture, segmentation, checkpoint evidence, publication and candidate section labels to the existing SQLite cache. It does **not** add or change MCP tools; tool exposure belongs to a later phase.

## Status

Phase 2 code is complete and passes its code gate. Classification is **not calibrated** and is not advertised as accepted.

- Held-out corpus: 50 usable pages
- Scored: 49 pages, 1,883 sections
- Label source: model review, **non-human**
- Candidate precision: **0.787**
- Candidate recall: **0.147**
- Accepted-label coverage: **0**

The spec gate in `docs/atlas-spec.md` requires accepted-label precision >= 0.90 and recall >= 0.80. That gate is **not met**.

## Deliberate deviation

Every section label written by Atlas is `candidate`. Nothing is promoted to `accepted`. Candidate labels are evidence hints, not reliable search facets, and must not be described as validated taxonomy.

Structural labels are stronger than content labels:

| Class | Precision | Recall |
|---|---:|---:|
| header | 1.000 | 1.000 |
| footer | 1.000 | 0.737 |
| navigation | 1.000 | 0.667 |
| hero | 0.708 | 0.318 |
| services | n/a | 0 |

Content classes (services, features, pricing, process, CTA, product listing) need recall work before they can be exposed as filters.

## Next phase

Phase 3 should search regions and evidence, not uncalibrated semantics:

- heading, text, geometry and landmark filters
- same-region / same-page / same-site scopes
- candidate labels displayed as hints
- human labels on a smaller set before any class is promoted

## Verification

```bash
npm run typecheck
npm test -- --maxWorkers=2
npm run build
npx vitest run test/atlas-collector.chromium.test.ts
```

The held-out report and corpus are local review artifacts and are not committed.
