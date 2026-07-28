/// <reference types="vitest/config" />
// Vite build for the Evenflow SPA. Output lands in the repo-root dist/web/,
// which wrangler.toml's [assets] section uploads alongside the Worker.
// `vite dev` proxies API paths to a local `wrangler dev` on :8787.

import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const WORKER_DEV = "http://localhost:8787";

export default defineConfig({
  plugins: [solid()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
  server: {
    proxy: Object.fromEntries(
      ["/api", "/auth", "/mcp", "/healthz", "/.well-known"].map((p) => [p, WORKER_DEV]),
    ),
  },
  test: {
    environment: "jsdom",
  },
});
