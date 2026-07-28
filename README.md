# Evenflow

*The Even Flow of Work.*

A kanban built on [4a](https://4a4.ai). Free. Yours.

**Status: under construction (2026-07-28).** Foundation scaffolding in progress.

---

## What it is

Linear-shaped issue tracker as a webapp with the [4a substrate](https://4a4.ai) as the entire backend — no accounts to admin, no per-seat pricing, no vendor lock. Private teams use 4a audiences with NIP-44 encryption; public boards use plain signed events any 4a client can read. AI features are user-supplied via webhook routes — no embedded LLM, no per-seat AI markup.

The tagline does the work: kanban was invented at Toyota specifically to smooth the *even flow* of work. That's the whole thesis.

## Stack

- **Server** — TypeScript + [Hono](https://hono.dev) on Cloudflare Workers
- **Runtime** — [Effect](https://effect.website) end-to-end (server + client)
- **Client** — [Solid](https://www.solidjs.com/) + Effect
- **Storage** — Cloudflare D1 (structured), R2 (artifact bodies), Durable Objects (per-board SSE)
- **Identity + auth** — 4a's existing OAuth AS at `api.4a4.ai/auth/*` (Google/GitHub), KMS-derived Nostr keys
- **Event substrate** — 4a kind range `30550–30559` (fresh, distinct from Sonata Studio's `30530–30539`)

## Development

```sh
pnpm install       # or npm / bun / yarn
pnpm dev           # wrangler dev on localhost:8787
pnpm typecheck     # tsc --noEmit
pnpm deploy        # wrangler deploy (needs CLOUDFLARE_API_TOKEN)
```

## The plan

See [`PLAN.md`](./PLAN.md) for the complete design: event schema, kanban semantics (icebox/backlog/active as first-class), MCP + REST surfaces, GitHub link-back via webhook responder, cards-as-artifacts direction, voice + design language, and the honest cost economics of running on Workers.

Original design notes live in the private wiki at `~/.sonata/wiki/ideas/kanban-on-4a.md`; `PLAN.md` in this repo is the public copy and the source of truth going forward.

## License

Apache 2.0. See [`LICENSE`](./LICENSE).
