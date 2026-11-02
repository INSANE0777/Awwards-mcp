import { defineConfig } from "vitest/config";

// Isolated pool for the real-Chromium smoke (test/component-chromium.smoke.ts).
// Kept out of the main suite's parallel run: when it ran alongside the full
// suite, one launch timed out at the 30s test limit (a standalone run takes ~6s).
// CI runs this on the Chromium matrix entries.
export default defineConfig({ test: { include: ["test/**/*.smoke.ts"], testTimeout: 30000 } });
