/// <reference types="vitest/config" />
// Vite build for the Evenflow SPA. Output lands in the repo-root dist/web/,
// which wrangler.toml's [assets] section uploads alongside the Worker.
// `vite dev` proxies API paths to a local `wrangler dev` on :8787.

import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import path from "node:path";

const WORKER_DEV = "http://localhost:8787";

export default defineConfig({
  plugins: [solid()],
  // EFB-98: the SPA builds its URLs from the same manifest the server routes
  // from. The manifest is deliberately dependency-free — no hono, no effect —
  // so it crosses this boundary without dragging the server runtime with it.
  resolve: {
    alias: { "@routes-manifest": path.resolve(__dirname, "../src/routes-manifest.ts") },
  },
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
    setupFiles: ["./src/test-setup.ts"],
  },
});
