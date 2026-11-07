import { acquireAtlasCaptureLease } from "../../src/atlas/lease.js";

const [root, token] = process.argv.slice(2);
if (!root || !token) throw new Error("usage: atlas-lease-worker <root> <token>");
try {
  const lease = acquireAtlasCaptureLease(root, { token, now: 1_700_000_000_000 });
  console.log(JSON.stringify({ ok: true, token: lease.token }));
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      code: (error as { code?: string }).code ?? "ERROR",
    }),
  );
}
