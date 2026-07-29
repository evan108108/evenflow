#!/usr/bin/env node
// One-shot backfill for migration 0004 (orgs + membership): every distinct
// board-owning pubkey gets a `personal` org (slug derived from their kind-0
// profile name — which OAuth seeded from the login prefix — else a
// pubkey-derived short), their boards move into it, and membership rows
// land (org owner + per-board admin).
//
// Safe to re-run: pubkeys that already own a personal org are skipped, the
// board update only touches org_id IS NULL rows, and membership inserts are
// INSERT OR IGNORE.
//
// Usage (needs the CF creds in the environment):
//   set -a; source /Users/evan/projects/4a/.env; set +a
//   node scripts/backfill-orgs.mjs [--local]

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const REMOTE_FLAG = process.argv.includes("--local") ? "--local" : "--remote";

// Mirrors RESERVED_ORG_SLUGS in src/roles.ts — SQL can't share constants.
const RESERVED_SLUGS = new Set([
  "boards", "profile", "settings", "i", "o", "api", "auth", "mcp", "new",
  "admin", "evenflow", "sona", "sonata", "enginable", "4a", "webhook",
  "healthz", ".well-known", "assets",
]);

const ORG_SLUG_MAX = 64;

const slugify = (input) => {
  const cleaned = String(input)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, ORG_SLUG_MAX).replace(/-+$/g, "");
};

const uniqueSlug = (base, taken) => {
  let candidate = base;
  if (candidate === "" ) candidate = "user";
  for (let n = 2; RESERVED_SLUGS.has(candidate) || taken.has(candidate); n++) {
    const suffix = String(n);
    candidate = base.slice(0, ORG_SLUG_MAX - suffix.length) + suffix;
  }
  return candidate;
};

const d1 = (sql) => {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "evenflow", REMOTE_FLAG, "--json", "--command", sql],
    { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" },
  );
  const parsed = JSON.parse(out);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (first?.success === false) throw new Error(`D1 statement failed: ${sql}`);
  return first?.results ?? [];
};

const q = (s) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);

const now = Date.now();

const owners = d1("SELECT DISTINCT pubkey FROM boardCache ORDER BY pubkey");
const profiles = d1("SELECT pubkey, name, display_name FROM profileCache");
const profileByPubkey = new Map(profiles.map((p) => [p.pubkey, p]));
const existingOrgs = d1("SELECT id, slug, kind, created_by FROM orgCache");
const taken = new Set(existingOrgs.map((o) => o.slug));
const personalOrgByOwner = new Map(
  existingOrgs.filter((o) => o.kind === "personal").map((o) => [o.created_by, o]),
);

console.log(`[backfill-orgs] board owners: ${owners.length}, existing orgs: ${existingOrgs.length}`);

for (const { pubkey } of owners) {
  let org = personalOrgByOwner.get(pubkey);
  if (org === undefined) {
    const profile = profileByPubkey.get(pubkey);
    // Login-prefix proxy: the OAuth seed wrote the login's mailbox part into
    // profileCache.name. Pubkey short is the no-profile fallback.
    const [provider = "user", oauthId = pubkey] = pubkey.split(":");
    const base = slugify(profile?.name ?? "") || slugify(`${provider}-${String(oauthId).slice(-6)}`);
    const slug = uniqueSlug(base, taken);
    taken.add(slug);
    const displayName = profile?.display_name || profile?.name || slug;
    org = { id: randomUUID(), slug, kind: "personal", created_by: pubkey };
    d1(
      `INSERT INTO orgCache (id, slug, display_name, avatar_url, bio, kind, created_by, substrate_event_id, created_at_ms, updated_at_ms) ` +
      `VALUES (${q(org.id)}, ${q(slug)}, ${q(displayName)}, NULL, NULL, 'personal', ${q(pubkey)}, NULL, ${now}, ${now})`,
    );
    console.log(`[backfill-orgs] ${pubkey} → personal org @${slug} (${org.id})`);
  } else {
    console.log(`[backfill-orgs] ${pubkey} already owns @${org.slug} — reusing`);
  }

  d1(
    `INSERT OR IGNORE INTO orgMemberCache (org_id, pubkey, role, added_by, added_at_ms, substrate_event_id) ` +
    `VALUES (${q(org.id)}, ${q(pubkey)}, 'owner', ${q(pubkey)}, ${now}, NULL)`,
  );

  d1(
    `UPDATE boardCache SET org_id = ${q(org.id)} WHERE pubkey = ${q(pubkey)} AND org_id IS NULL`,
  );

  const boards = d1(`SELECT id, slug FROM boardCache WHERE org_id = ${q(org.id)}`);
  for (const board of boards) {
    d1(
      `INSERT OR IGNORE INTO boardMemberCache (board_id, pubkey, role, added_by, added_at_ms, substrate_event_id) ` +
      `VALUES (${q(board.id)}, ${q(pubkey)}, 'admin', ${q(pubkey)}, ${now}, NULL)`,
    );
  }
  console.log(`[backfill-orgs] @${org.slug}: ${boards.length} boards assigned + admin rows`);
}

console.log("[backfill-orgs] done");
