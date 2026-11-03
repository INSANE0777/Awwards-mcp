import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const GUARD = join(import.meta.dirname, "..", "scripts", "v2-eval-no-egress.cjs");
const { isGuardLine } = createRequire(import.meta.url)(
  join(import.meta.dirname, "..", "scripts", "egress-guard-marker.cjs"),
);

function runGuarded(source: string) {
  return spawnSync(process.execPath, ["--require", GUARD, "-e", source], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("v2 eval egress guard", () => {
  it("counts the exact marker the guard emits", () => {
    const lines = [
      "noise",
      "v2-eval-guard: blocked egress to 127.attacker.example:80",
      "v2-eval-guard: blocked egress to evil.test",
    ];
    expect(lines.filter(isGuardLine)).toHaveLength(2);
    expect(isGuardLine("perf-bench-guard: blocked egress")).toBe(false);
  });

  it("blocks a hostname that merely starts with 127.", () => {
    const res = runGuarded(`
      const net = require("node:net");
      const s = net.connect({ host: "127.attacker.example", port: 80 });
      s.on("error", (e) => process.exit(e.code === "ENOEGRESS" ? 0 : 2));
      setTimeout(() => process.exit(3), 2000);
    `);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("v2-eval-guard: blocked egress");
  });

  it("blocks http.get to a non-loopback host", () => {
    const res = runGuarded(`
      const http = require("node:http");
      const req = http.get("http://127.attacker.example/");
      req.on("error", (e) => process.exit(e.code === "ENOEGRESS" ? 0 : 2));
      setTimeout(() => process.exit(3), 2000);
    `);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("v2-eval-guard: blocked egress");
  });

  it("allows a real loopback connection", () => {
    const res = runGuarded(`
      const net = require("node:net");
      const server = net.createServer((c) => c.end("ok"));
      server.listen(0, "127.0.0.1", () => {
        const c = net.connect({ host: "127.0.0.1", port: server.address().port });
        c.on("connect", () => c.end(() => server.close(() => process.exit(0))));
        c.on("error", () => process.exit(2));
      });
      setTimeout(() => process.exit(3), 3000);
    `);
    expect(res.status).toBe(0);
  });
});
