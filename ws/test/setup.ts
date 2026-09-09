// Loads the repo-root .env before any test-module imports are evaluated.
// Prisma resolves DATABASE_URL when `new PrismaClient()` is constructed — and
// the ws server constructs its client at import time (src/lib/prisma.ts), so
// env must already be in place when test modules start importing the server.
import { readFileSync } from "node:fs";
import path from "node:path";

try {
  const raw = readFileSync(path.resolve(__dirname, "../../.env"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  // no .env — DB/Redis-dependent suites stay skipped
}
