// Membership writes shared by session bootstrap, org routes, board-member
// routes, and invite acceptance.
//
// Substrate posture (spec: non-blocking): every membership mutation caches
// the D1 row FIRST, then best-effort publishes the matching 4a event
// (kind 30520 org declaration / kind 30521 key-grant). A 4a outage leaves
// substrate_event_id NULL; a retry sweep republishes later.
// TODO(substrate-retry): sweep rows WHERE substrate_event_id IS NULL and
// republish — needs a scheduled trigger; stubbed for now.

import { Clock, Effect } from "effect";
import { Db, FourA, type Claims, type DbError } from "./effects";
import { callerPubkey } from "./authz";
import { parseOrgRow, type OrgShape } from "./shapes";
import { slugifyHandle, uniqueOrgSlug, ORG_SLUG_RE } from "./roles";

/** Best-effort wrapper: substrate failures log and resolve null, never fail. */
const bestEffort = <A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | null, never, R> =>
  effect.pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => {
        console.log(JSON.stringify({ warn: "substrate-publish-deferred", label, error: String(e) }));
        return null;
      }),
    ),
  );

/** Publish the org declaration and stamp substrate_event_id when it lands. */
export const publishOrgBestEffort = (
  token: string,
  org: OrgShape,
): Effect.Effect<string | null, DbError, Db | FourA> =>
  Effect.gen(function* () {
    const foura = yield* FourA;
    const db = yield* Db;
    const admins = yield* db.queryAll<{ pubkey: string }>(
      "SELECT pubkey FROM orgMemberCache WHERE org_id = ? AND role IN ('owner','admin')",
      [org.id],
    );
    const result = yield* bestEffort(
      `org:${org.slug}`,
      foura.publishOrg(token, {
        slug: org.slug,
        display_name: org.display_name,
        kind: org.kind,
        ...(org.avatar_url === null ? {} : { avatar_url: org.avatar_url }),
        ...(org.bio === null ? {} : { bio: org.bio }),
        admins: admins.map((a) => a.pubkey),
      }),
    );
    if (result === null) return null;
    yield* db.execute("UPDATE orgCache SET substrate_event_id = ? WHERE id = ?", [
      result.event_id,
      org.id,
    ]);
    return result.event_id;
  });

interface GrantTarget {
  readonly scope: "org" | "board";
  /** `<org_slug>` or `<org_slug>/<board_slug>` */
  readonly target: string;
}

/**
 * Insert (or upsert) a membership row + best-effort publish its key-grant.
 * `table` picks the scope. Existing rows get their role replaced — a
 * re-grant republishes the same substrate address.
 */
export const upsertMembership = (options: {
  readonly table: "orgMemberCache" | "boardMemberCache";
  readonly scopeId: string;
  readonly pubkey: string;
  readonly role: string;
  readonly addedBy: string;
  readonly token: string;
  readonly grant: GrantTarget;
}): Effect.Effect<{ substrate_event_id: string | null }, DbError, Db | FourA> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const foura = yield* FourA;
    const now = yield* Clock.currentTimeMillis;
    const idColumn = options.table === "orgMemberCache" ? "org_id" : "board_id";
    const result = yield* bestEffort(
      `grant:${options.grant.target}:${options.pubkey}`,
      foura.publishGrant(options.token, {
        recipient: options.pubkey,
        role: options.role,
        scope: options.grant.scope,
        target: options.grant.target,
      }),
    );
    yield* db.execute(
      `INSERT INTO ${options.table} (${idColumn}, pubkey, role, added_by, added_at_ms, substrate_event_id) VALUES (?, ?, ?, ?, ?, ?) ` +
        `ON CONFLICT(${idColumn}, pubkey) DO UPDATE SET role = excluded.role, substrate_event_id = excluded.substrate_event_id`,
      [options.scopeId, options.pubkey, options.role, options.addedBy, now, result?.event_id ?? null],
    );
    return { substrate_event_id: result?.event_id ?? null };
  });

/** Delete a membership row + best-effort publish the grant revocation. */
export const removeMembership = (options: {
  readonly table: "orgMemberCache" | "boardMemberCache";
  readonly scopeId: string;
  readonly pubkey: string;
  readonly token: string;
}): Effect.Effect<{ removed: boolean }, DbError, Db | FourA> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const foura = yield* FourA;
    const idColumn = options.table === "orgMemberCache" ? "org_id" : "board_id";
    const row = yield* db.queryFirst<{ substrate_event_id: string | null }>(
      `SELECT substrate_event_id FROM ${options.table} WHERE ${idColumn} = ? AND pubkey = ?`,
      [options.scopeId, options.pubkey],
    );
    if (row === null) return { removed: false };
    yield* db.execute(`DELETE FROM ${options.table} WHERE ${idColumn} = ? AND pubkey = ?`, [
      options.scopeId,
      options.pubkey,
    ]);
    if (row.substrate_event_id !== null) {
      yield* bestEffort(
        `revoke:${options.scopeId}:${options.pubkey}`,
        foura.publishGrantRevoke(options.token, row.substrate_event_id),
      );
    }
    return { removed: true };
  });

/**
 * Idempotently ensure the caller owns a personal org, creating one on first
 * call. Slug preference order: an explicitly claimed handle (the sign-up
 * CTA's ?claim= hint), else the login's mailbox prefix, else a
 * provider-derived short — digit-suffixed past reserved words and
 * collisions. Safe to call on every bootstrap.
 */
export const ensurePersonalOrg = (
  claims: Claims,
  token: string,
  claimedHandle?: string,
): Effect.Effect<{ org: OrgShape; created: boolean }, DbError, Db | FourA> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const pubkey = callerPubkey(claims);
    const existing = yield* db.queryFirst<Record<string, unknown>>(
      "SELECT * FROM orgCache WHERE created_by = ? AND kind = 'personal' AND deleted_at_ms IS NULL",
      [pubkey],
    );
    if (existing !== null) return { org: parseOrgRow(existing), created: false };

    const loginPrefix = claims.login.split("@")[0] ?? claims.login;
    const claimed =
      claimedHandle !== undefined && ORG_SLUG_RE.test(claimedHandle) ? claimedHandle : null;
    const base = claimed ?? slugifyHandle(loginPrefix);
    const takenRows = yield* db.queryAll<{ slug: string }>("SELECT slug FROM orgCache");
    const aliasRows = yield* db.queryAll<{ old_slug: string }>("SELECT old_slug FROM orgSlugAlias");
    const taken = new Set([
      ...takenRows.map((r) => r.slug),
      ...aliasRows.map((r) => r.old_slug),
    ]);
    const slug = uniqueOrgSlug(base, taken);

    const now = yield* Clock.currentTimeMillis;
    const id = crypto.randomUUID();
    const displayName = claims.login.split("@")[0] ?? claims.login;
    yield* db.execute(
      "INSERT INTO orgCache (id, slug, display_name, avatar_url, bio, kind, created_by, substrate_event_id, created_at_ms, updated_at_ms) VALUES (?, ?, ?, NULL, NULL, 'personal', ?, NULL, ?, ?)",
      [id, slug, displayName, pubkey, now, now],
    );
    yield* db.execute(
      "INSERT OR IGNORE INTO orgMemberCache (org_id, pubkey, role, added_by, added_at_ms, substrate_event_id) VALUES (?, ?, 'owner', ?, ?, NULL)",
      [id, pubkey, pubkey, now],
    );
    const orgRow = yield* db.queryFirst<Record<string, unknown>>(
      "SELECT * FROM orgCache WHERE id = ?",
      [id],
    );
    // Row was just inserted; a null read here means the cache is corrupt.
    const org = parseOrgRow(orgRow);
    yield* publishOrgBestEffort(token, org);
    const foura = yield* FourA;
    const granted = yield* bestEffort(
      `grant:${slug}:${pubkey}`,
      foura.publishGrant(token, { recipient: pubkey, role: "owner", scope: "org", target: slug }),
    );
    if (granted !== null) {
      yield* db.execute(
        "UPDATE orgMemberCache SET substrate_event_id = ? WHERE org_id = ? AND pubkey = ?",
        [granted.event_id, id, pubkey],
      );
    }
    return { org, created: true };
  });
