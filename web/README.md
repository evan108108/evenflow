# Evenflow webapp

Solid + Effect SPA, served by the same Cloudflare Worker that serves the API
(`../src`). Vite builds into `../dist/web/`, which `wrangler.toml`'s
`[assets]` section uploads on deploy; the Worker's catch-all GET serves
`index.html` for any non-API path so Solid Router owns client-side routing.

## Commands

```bash
npm install        # once
npm run dev        # Vite dev server on :5173, proxies /api /auth /mcp to :8787
npm run build      # emits ../dist/web/  (required before `wrangler deploy`)
npm run typecheck  # tsc --noEmit
npm test           # vitest (jsdom)
```

Local full-stack loop: run `npx wrangler dev` from the repo root (API on
:8787) and `npm run dev` here — the proxy stitches them together. Or
`npm run build` and hit :8787 directly for the deployed shape.

## Layout

- `src/effects/` — browser-side Effect services, same vocabulary as the
  Worker: `ApiClient` (fetch + Bearer), `SseStream` (fetch-based SSE with
  reconnect; EventSource can't send Authorization), `AuthManager`
  (localStorage JWT). Composed in `index.ts` into `AppLayer` + `appRuntime`.
- `src/pages/` — `Landing` (editorial front door), `SignIn`
  (`/auth/callback` JWT capture), `BoardsList` (first protected page).
- `src/lib/theme.css` — design tokens: cream `#f5f2ec`, ink `#17233b`,
  Bodoni Moda (display serif) + DM Sans (wide sans), chamfered corners, no
  focus outlines.
