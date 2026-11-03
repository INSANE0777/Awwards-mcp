# v1.18 baseline

Provisional baseline for `main` at `5766d42` (1.17.1 + M1/M3), measured with the
repository benchmark. This is **not** a p95: three runs are enough to catch a
gross regression, not tail behaviour. Re-run on the release candidate and
compare like-for-like; do not treat these numbers as universal.

```bash
npm run build
npm run perf:bench -- --runs 3 --sites 10000 --calls 7 --out benchmarks/v1.18-baseline.json
```

## Environment

- Windows x64, Node 24.18.0, 10,000 synthetic cached sites
- 3 runs × 7 calls per case
- Raw observations: `v1.18-baseline.json`

## Results

| Metric | Median | p90 |
|---|---:|---:|
| Cold initialize | 384.61 ms | 425.42 ms |
| Cold tools/list | 404.59 ms | 444.33 ms |
| Warm initialize | 400.86 ms | 438.94 ms |
| Warm tools/list | 422.97 ms | 458.52 ms |
| Search, no query | 45.45 ms | 55.05 ms |
| Search, broad query | 54.20 ms | 65.19 ms |
| Search, filtered query | 21.02 ms | 26.30 ms |
| Search, score sort | 87.53 ms | 102.24 ms |

- Tools: **41**
- Serialized tool catalog: **71,853 bytes**
- RSS after startup: **87.4 MB** median
- RSS after searches: **309.2 MB** median
- Cleanup: temp removed, **0** leftover processes, **0** blocked egress

## Release comparison rules

- Same machine, Node version, fixture size, run count and call count.
- No unexplained p90 regression above **15%**; p95 requires a separate run with at least 30 observations.
- No unexplained catalog growth above **10%** (M3 intentionally added output schemas).
- No response exceeding the configured cap.
- No orphaned processes or retained instrumentation.
