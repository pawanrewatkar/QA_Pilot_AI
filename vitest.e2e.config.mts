import path from "node:path";
import { defineConfig } from "vitest/config";

/** End-to-end suite: needs `npm run build` first and the Playwright Chromium browser. */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname),
      "server-only": path.resolve(import.meta.dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 180_000,
  },
});
