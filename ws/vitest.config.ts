import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Loads the repo-root .env BEFORE any test-module imports are evaluated —
    // Prisma snapshots process.env when `new PrismaClient()` runs, and the ws
    // server's client is constructed at import time.
    setupFiles: ["./test/setup.ts"],
    // integration suites boot two servers + real Redis/Postgres round-trips
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
