// Integration lane (EFB-49) — boots the real Worker over a real local D1.
// Separate from the root config because these tests are slow by construction
// and shouldn't run in the fast unit loop. See tests/integration/harness.ts.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    // Booting the runtime and applying every migration takes real time.
    hookTimeout: 180_000,
    testTimeout: 60_000,
    // Each file would boot its own Worker; keep them serial so ports and
    // temp D1 directories don't contend.
    fileParallelism: false,
  },
});
