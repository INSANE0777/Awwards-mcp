import { defineConfig } from "vitest/config";

// Indexer tests exercise full multi-page crawls and legitimately take up to
// ~6s under system load — well past vitest's 5s default.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 30000 } });
