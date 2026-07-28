#!/usr/bin/env bash
# One-time D1 setup for Evenflow.
#
# Step 1 — create the database (records the database id; run once):
#
#   wrangler d1 create evenflow
#
#   The output includes a `database_id`. Paste it into wrangler.toml,
#   replacing REPLACE_ME_AFTER_wrangler_d1_create in the [[d1_databases]]
#   block.
#
# Step 2 — apply the schema remotely (production):
#
#   wrangler d1 execute evenflow --file=migrations/0001_init.sql --remote
#
# Step 3 — apply the schema locally (Miniflare database used by wrangler dev):
#
#   wrangler d1 execute evenflow --file=migrations/0001_init.sql --local
#
# Later migrations follow the same shape — see migrations/README.md.

set -euo pipefail
cd "$(dirname "$0")/.."

if grep -q 'REPLACE_ME_AFTER_wrangler_d1_create' wrangler.toml; then
  echo "wrangler.toml still has the placeholder database_id."
  echo "Run 'wrangler d1 create evenflow' and paste the database_id into"
  echo "wrangler.toml first. (--local migrations work without it.)"
else
  echo "Applying migrations remotely..."
  wrangler d1 execute evenflow --file=migrations/0001_init.sql --remote
fi

echo "Applying migrations locally..."
wrangler d1 execute evenflow --file=migrations/0001_init.sql --local
echo "Done."
