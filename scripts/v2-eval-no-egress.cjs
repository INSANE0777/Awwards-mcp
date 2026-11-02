// Preloaded into the v2 eval server child (`node --require ... cli.js`).
// Refuses any non-loopback socket connect or fetch so a cache miss/stale index
// cannot turn an evidence run into a live crawl. Blocked attempts are written
// to stderr as "v2-eval-guard: blocked egress ..." and counted by the runner.
const net = require("node:net");
const { GUARD_MARKER } = require("./egress-guard-marker.cjs");

const isLoopback = (host) => {
  if (!host) return true;
  const value = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "localhost" || value === "::1") return true;
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  );
};
const block = (host, port) => {
  process.stderr.write(`${GUARD_MARKER} to ${host}${port ? `:${port}` : ""}\n`);
  const err = new Error(`v2-eval no-egress guard blocked ${host}`);
  err.code = "ENOEGRESS";
  return err;
};

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const opts =
    first && typeof first === "object"
      ? first
      : typeof first === "string"
        ? { path: first }
        : { port: first, host: args[1] };
  if (opts.path == null && !isLoopback(opts.host)) {
    const err = block(opts.host, opts.port);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return originalConnect.apply(this, args);
};

const originalFetch = globalThis.fetch;
if (originalFetch) {
  globalThis.fetch = (input, init) => {
    let host = null;
    try {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      host = new URL(url).hostname;
    } catch {
      // Non-URL fetch inputs fall through to the original implementation.
    }
    if (host && !isLoopback(host)) return Promise.reject(block(host));
    return originalFetch(input, init);
  };
}
