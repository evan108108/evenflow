# Migrations

D1 (SQLite dialect) migrations for Evenflow's cache + config database.

## Convention

- Files are named `000N_description.sql` (`0001_init.sql`, `0002_add_sprints.sql`, …).
- Run in ascending order. Every statement uses `IF NOT EXISTS` where possible so
  re-running a migration is safe, but the convention is still forward-only:
  never edit a migration that has been applied remotely — add a new one.
- `--remote` applies against the production D1 database; `--local` applies
  against the Miniflare-managed local database used by `wrangler dev`.

## Running

Since phase 19 the remote database carries wrangler's `d1_migrations`
tracker (backfilled for 0001-0011), so `wrangler d1 migrations apply` only
runs what's new. Never `d1 execute --file` a historical migration — 0004
and 0010 are not idempotent.

```sh
# Local dev database
npm run d1:migrate:local     # = wrangler d1 migrations apply evenflow --local

# Production
npm run d1:migrate:remote    # = wrangler d1 migrations apply evenflow --remote
```

First-time setup (create the database, record its id in `wrangler.toml`):
see `scripts/setup-d1.sh`.

## What lives in D1 (and what doesn't)

Canonical state for boards, issues, comments, and status changes lives in
signed 4a events (kinds 30550–30559). The `*Cache` tables are refreshable
projections of those events — they can be truncated and rebuilt from 4a at
any time, which is also why they carry no FOREIGN KEY constraints (events can
arrive out of order, and a cache refresh must never depend on parent-row
ordering).

Only `webhookRoutes`, `webhookDeliveries`, `sessionCache`, and the
`githubWebhook*` tables hold state whose source of truth is D1 itself.

## Two webhook families, opposite directions

Mind the prefix — these are unrelated and must never be joined:

* `webhookRoutes` / `webhookDeliveries` (0001) are **outbound**: Evenflow
  calling someone else's URL.
* `githubWebhookRules` / `githubWebhookAudit` / `githubWebhookDedup` (0016)
  are **inbound**: GitHub calling us.

The per-board GitHub webhook secret lives in
`boardCache.github_webhook_secret_ciphertext`, AES-GCM sealed under the
`EVENFLOW_WEBHOOK_SECRET` Worker secret. It is reversible on purpose —
HMAC verification needs the shared secret back on every delivery, so it
cannot be a write-only hash the way `apiKeys.key_hash` (0008) is. D1 never
holds the plaintext.
