/**
 * Session actions — session bootstrap for the SPA.
 *
 * `bootstrapSession` runs after every OAuth callback (and is safe to run on
 * every app load): idempotently ensures the caller's personal org exists
 * (slug = login-prefix, digit-suffixed on collision, reserved words skipped;
 * an optional `claim` body field carries the sign-up CTA's ?claim=<handle>
 * hint), then returns the caller's identity + org list so the client can
 * populate the org switcher without a second round-trip.
 *
 * EFB-98: bodies moved VERBATIM from src/routes/session.ts. Both actions need
 * the caller's raw bearer — `ensurePersonalOrg` publishes a signed grant with
 * it, and the key registration is keyed by its hash — so it arrives as
 * `input.token`.
 */

import { Clock, Effect } from "effect";

import { Db, DbError, FourA, hashToken } from "../effects";
import { callerPubkey, type UnauthorizedError } from "../authz";
import { ensurePersonalOrg } from "../membership";
import { ValidationError } from "../lib/errors";
import type { ActionInput } from "./types";

const SESSION_PUBKEY_RE = /^[0-9a-f]{64}$/i;

export type SessionFailure = ValidationError | UnauthorizedError | DbError;

/** Services every session action needs. */
export type SessionServices = Db | FourA;

/**
 * POST /session/bootstrap.
 *
 * The claim hint is best-effort, which is why the body arrives already
 * decoded to `Record<string, unknown> | null` rather than as a failable parse:
 * a malformed or taken handle falls back to login-prefix derivation rather
 * than failing sign-in, so the route's read swallows its own error and there
 * is no ordering question to preserve.
 */
export const bootstrapSession = (
  input: ActionInput<Record<string, unknown> | null>,
): Effect.Effect<unknown, SessionFailure, SessionServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    const token = input.token;
    const pubkey = callerPubkey(claims);

    const body = input.body;
    const claim =
      body !== null && typeof body["claim"] === "string" ? body["claim"] : undefined;

    const { org: personal, created } = yield* ensurePersonalOrg(claims, token, claim);

    const db = yield* Db;
    const orgRows = yield* db.queryAll<{
      slug: string;
      display_name: string;
      avatar_url: string | null;
      kind: string;
      role: string;
    }>(
      "SELECT o.slug, o.display_name, o.avatar_url, o.kind, m.role FROM orgMemberCache m JOIN orgCache o ON o.id = m.org_id WHERE m.pubkey = ? AND o.deleted_at_ms IS NULL ORDER BY (o.kind = 'personal') DESC, o.slug ASC",
      [pubkey],
    );

    return {
      me: {
        handle: personal.slug,
        pubkey,
        login: claims.login,
        orgs: orgRows,
      },
      last_active_org: personal.slug,
      personal_org_created: created,
    };
  });

/**
 * POST /session/register-key — per-session client keypair (16.5).
 *
 * Web users hold no long-lived secp256k1 keys, so each signed-in session
 * generates one and registers the pub here. Private-board key grants are
 * issued to these session pubs. Keyed by jwt_hash (one key per session,
 * re-registering replaces); expiry rides the JWT's own exp.
 */
export const registerSessionKey = (
  input: ActionInput<Record<string, unknown>>,
): Effect.Effect<unknown, SessionFailure, SessionServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    const token = input.token;
    const pubkey = callerPubkey(claims);
    const body = input.body;
    const sessionPub = body["session_pubkey"];
    if (typeof sessionPub !== "string" || !SESSION_PUBKEY_RE.test(sessionPub)) {
      return yield* new ValidationError({ reason: "session_pubkey" });
    }
    const db = yield* Db;
    const now = yield* Clock.currentTimeMillis;
    const jwtHash = yield* hashToken(token);
    // Nostr sessions (16.7) register their REAL key at sign-in with
    // source='nostr' — an ephemeral registration must never replace it,
    // or the session's grants silently drop from level-4 to session-key
    // trust. Registering is idempotent from the client's view either way.
    const existing = yield* db.queryFirst<{ session_pubkey: string; session_key_source: string }>(
      "SELECT session_pubkey, session_key_source FROM sessionKeyRegistrations WHERE jwt_hash = ?",
      [jwtHash],
    );
    if (existing !== null && existing.session_key_source === "nostr") {
      return { registered: true, session_pubkey: existing.session_pubkey, source: "nostr" };
    }
    yield* db.execute(
      "INSERT OR REPLACE INTO sessionKeyRegistrations (jwt_hash, member_pubkey, session_pubkey, created_at_ms, expires_at_ms, session_key_source) VALUES (?, ?, ?, ?, ?, 'ephemeral')",
      [jwtHash, pubkey, sessionPub.toLowerCase(), now, claims.exp * 1000],
    );
    return { registered: true, session_pubkey: sessionPub.toLowerCase(), source: "ephemeral" };
  });
