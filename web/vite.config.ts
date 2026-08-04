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
  // EFB-99: same reasoning, second file. The rotation grace window is a
  // security-relevant number the UI states in prose ("keeps working for 24
  // hours"), and a hardcoded copy of it would keep saying 24 after someone
  // changed the constant — telling users something false about how long a
  // compromised key stays live. It points at src/apikey-policy.ts and NOT at
  // src/apikeys.ts, which is where that constant would naturally have lived:
  // apikeys.ts carries `import type { Claims } from "./effects"`, and while
  // esbuild erases a type import, tsc still RESOLVES it — aliasing that file
  // pulls D1Database, DurableObjectState and Fetcher into a browser program
  // that has no lib for them. Dependency-free has to mean dependency-free at
  // typecheck too, which is why the policy module has no imports at all.
  resolve: {
    alias: {
      "@routes-manifest": path.resolve(__dirname, "../src/routes-manifest.ts"),
      "@apikey-policy": path.resolve(__dirname, "../src/apikey-policy.ts"),
      // EFB-100: the scope vocabulary, so the picker cannot drift from what
      // the server enforces. Safe to alias for the same reason the manifest
      // is — its only import is `import type` from the manifest itself, which
      // is already dependency-free, so nothing Worker-shaped reaches the
      // browser program at typecheck OR at runtime. Importing GRANTABLE_DOMAINS
      // is also what makes it impossible for the picker to offer the `keys`
      // domain: the exclusion is the same constant the server refuses on.
      "@scopes": path.resolve(__dirname, "../src/scopes.ts"),
      // EFB-103: documentation content, authored once and rendered twice —
      // as pages here, as one text/plain document by the Worker. Same
      // dependency-free rule as the modules above.
      "@docs-content/sections": path.resolve(__dirname, "../src/docs/sections.ts"),
      "@docs-content/model": path.resolve(__dirname, "../src/docs/model.ts"),
      "@docs-content/api-reference": path.resolve(__dirname, "../src/docs/api-reference.ts"),
    },
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
