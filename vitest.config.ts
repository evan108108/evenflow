// Root vitest covers the Worker only. The webapp has its own vitest
// (jsdom + solid plugin) — run it via `cd web && npm test`.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
