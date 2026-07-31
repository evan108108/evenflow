// Root vitest covers the Worker only. The webapp has its own vitest
// (jsdom + solid plugin) — run it via `cd web && npm test`.
//
// tests/integration/ is excluded here on purpose: it boots a real Worker
// runtime and migrates a real D1 per file, which is seconds of setup rather
// than milliseconds and does not belong in the fast unit loop. Run it with
// `npm run test:integration`, config in vitest.integration.config.ts.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "tests/integration/**"],
  },
});
