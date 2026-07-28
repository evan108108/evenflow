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

```sh
# Local dev database
npm run d1:migrate:local
# or directly:
wrangler d1 execute evenflow --file=migrations/0001_init.sql --local

# Production
npm run d1:migrate:remote
# or directly:
wrangler d1 execute evenflow --file=migrations/0001_init.sql --remote
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

Only `webhookRoutes`, `webhookDeliveries`, and `sessionCache` hold state whose
source of truth is D1 itself.
