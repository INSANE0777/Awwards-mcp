# Changelog

## v1.1.0 — 2026-09-18

Self-repair + observability release (all shipped in repo 2026-09-18):

- **Parser-drift monitor**: `npm run drift` probes every markup anchor the
  parsers depend on (hybrid pinned + date-sampled detail URLs, section-scoped
  element anchors); daily GitHub Action opens/updates a tracking issue and
  commits probe state for was-ok→DRIFT diffs.
- **Doctor**: `npm run doctor [-- --fix]` diagnoses network blocks, parser
  drift, playwright/ffmpeg deps, corrupt/stale SQLite cache, and server boot —
  and applies the mechanical fixes.
- **Update notification**: once-daily npm registry check at startup with a
  stderr notice on older versions; `AWWWARDS_AUTO_UPDATE=1` opts into
  background self-update.
- **New skills**: `awwwards-doctor` (repair) and `awwwards-motion-study`
  (capture → review → build), alongside `awwwards-inspiration`.
- **Fix**: `parseElements` re-anchored after live awwwards.com element-blob
  markup change (broke `get_site_elements` on 2026-09-18); new offline
  fixture covers the broken shape.

## v1.0.0 — 2026-09-18

First public release: search_sites / get_site_details / get_site_elements /
list_categories / capture_live_site / analyze_page_structure /
record_site_motion, local index (`awwwards-index`), awwwards-inspiration skill.
