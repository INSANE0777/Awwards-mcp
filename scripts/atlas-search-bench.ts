import { runAtlasSearchBenchmark } from "../src/atlas/search-bench.js";

const regions = Number(process.env.ATLAS_BENCH_REGIONS ?? 100_000);
const claimsPerRegion = Number(process.env.ATLAS_BENCH_CLAIMS_PER_REGION ?? 10);
const runs = Number(process.env.ATLAS_BENCH_RUNS ?? 50);

const result = runAtlasSearchBenchmark({ regions, claimsPerRegion, runs });

console.log(
  `${result.regions} eligible regions (+${result.staleRegions} stale, +${result.unknownRegions} unknown) / ${result.claims} claims / ${result.sites} sites / ${result.captures} captures`,
);
console.log(
  `CPU: ${result.environment.cpu ?? "unknown"} | Node ${result.environment.nodeVersion} | SQLite ${result.environment.sqliteVersion} | ${result.environment.warmState} | DB ${(result.databaseBytes / (1024 * 1024)).toFixed(1)} MiB`,
);
console.log(
  `runs: ${result.runsPerQuery} per workload / ${result.measuredRuns} measured | RSS +${(result.additionalRssBytes / (1024 * 1024)).toFixed(1)} MiB`,
);
console.log(
  `publish-side projection rebuild: ${(result.publishRebuildMs / 1000).toFixed(2)} s (paid inside the publish transaction, excluded from search timings)`,
);
console.log("");
console.log("| Workload | p50 | p95 | Gate | First run | Results |");
console.log("|---|---:|---:|---:|---:|---:|");
for (const workload of result.workloads) {
  console.log(
    `| ${workload.name} | ${workload.p50Ms.toFixed(1)} ms | ${workload.p95Ms.toFixed(1)} ms | <= ${workload.gateMs} ms | ${workload.firstRunMs.toFixed(1)} ms ${workload.cold ? "(cold)" : "(warm)"} | ${workload.total} |`,
  );
}
console.log("");
console.log(
  JSON.stringify(
    {
      schemaVersion: result.schemaVersion,
      regions: result.regions,
      ineligibleRegions: result.ineligibleRegions,
      staleRegions: result.staleRegions,
      unknownRegions: result.unknownRegions,
      claims: result.claims,
      measuredRuns: result.measuredRuns,
      p50Ms: Number(result.p50Ms.toFixed(1)),
      p95Ms: Number(result.p95Ms.toFixed(1)),
      publishRebuildSeconds: Number((result.publishRebuildMs / 1000).toFixed(2)),
      coldFirstRunMs: Number(result.coldFirstRunMs.toFixed(1)),
      additionalRssMiB: Number((result.additionalRssBytes / (1024 * 1024)).toFixed(1)),
      databaseMiB: Number((result.databaseBytes / (1024 * 1024)).toFixed(1)),
      deterministicDigest: result.deterministicDigest,
    },
    null,
    2,
  ),
);

const failures: string[] = [];
if (result.regions < 100_000) {
  failures.push(`regions ${result.regions} is below the 100,000 gate`);
}
if (result.staleRegions < 1) {
  failures.push("the corpus has no separate stale captures");
}
if (result.unknownRegions < 1) {
  failures.push("the corpus has no separate unknown-status captures");
}
if (result.claims < 1_000_000) {
  failures.push(`claims ${result.claims} is below the 1,000,000 gate`);
}
if (result.measuredRuns < 100) {
  failures.push(`measured runs ${result.measuredRuns} is below the 100 gate`);
}
for (const workload of result.workloads) {
  if (workload.p95Ms > workload.gateMs) {
    failures.push(
      `${workload.name} p95 ${workload.p95Ms.toFixed(1)}ms exceeds ${workload.gateMs}ms`,
    );
  }
}
if (result.additionalRssBytes > 128 * 1024 * 1024) {
  failures.push(
    `additional RSS ${(result.additionalRssBytes / (1024 * 1024)).toFixed(1)}MiB exceeds 128MiB`,
  );
}
if (result.publishRebuildMs > 60_000) {
  failures.push(
    `publish projection rebuild ${(result.publishRebuildMs / 1000).toFixed(1)}s exceeds the 60s publish allowance`,
  );
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
