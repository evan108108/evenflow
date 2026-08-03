/**
 * Per-user notification preference actions.
 *
 * CONFIG SURFACE ONLY (polish batch): rows persist what the user wants; the
 * delivery machinery that reads them (email on mention/assignment, digests)
 * is a later phase. A missing row reads as the schema defaults, so the read
 * never 404s and the write upserts.
 *
 * EFB-98: bodies moved VERBATIM from src/routes/notifications.ts.
 */

import { Clock, Effect } from "effect";

import { AuditLog, Db, DbError } from "../effects";
import { callerPubkey, type UnauthorizedError } from "../authz";
import { ValidationError } from "../lib/errors";
import type { ActionInput } from "./types";

export const EMAIL_DIGESTS = ["off", "daily", "weekly"] as const;
export type EmailDigest = (typeof EMAIL_DIGESTS)[number];

export interface NotificationsConfigShape {
  readonly email_on_mention: boolean;
  readonly email_on_assignment: boolean;
  readonly email_on_issue_moved_to_me: boolean;
  readonly email_digest: EmailDigest;
}

export type NotificationsFailure = ValidationError | UnauthorizedError | DbError;

/** Services every notifications action needs. */
export type NotificationServices = Db | AuditLog;

/** Column defaults from migration 0013 — what a rowless user reads as. */
const DEFAULTS: NotificationsConfigShape = {
  email_on_mention: true,
  email_on_assignment: true,
  email_on_issue_moved_to_me: false,
  email_digest: "off",
};

const BOOL_FIELDS = [
  "email_on_mention",
  "email_on_assignment",
  "email_on_issue_moved_to_me",
] as const;

const parseConfigRow = (row: Record<string, unknown> | null): NotificationsConfigShape =>
  row === null
    ? DEFAULTS
    : {
        email_on_mention: row["email_on_mention"] === 1,
        email_on_assignment: row["email_on_assignment"] === 1,
        email_on_issue_moved_to_me: row["email_on_issue_moved_to_me"] === 1,
        email_digest: row["email_digest"] as EmailDigest,
      };

const fetchConfig = (pubkey: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row = yield* db.queryFirst<Record<string, unknown>>(
      "SELECT * FROM notificationsConfig WHERE pubkey = ?",
      [pubkey],
    );
    return parseConfigRow(row);
  });

/** GET /notifications/config. */
export const getNotificationsConfig = (
  input: ActionInput,
): Effect.Effect<unknown, NotificationsFailure, NotificationServices> =>
  Effect.gen(function* () {
    const config = yield* fetchConfig(callerPubkey(input.claims));
    return { config };
  });

/** PATCH /notifications/config — partial update, upserts. */
export const setNotificationsConfig = (
  input: ActionInput<Record<string, unknown>>,
): Effect.Effect<unknown, NotificationsFailure, NotificationServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    const pubkey = callerPubkey(claims);
    const body = input.body;

    for (const f of BOOL_FIELDS) {
      if (body[f] !== undefined && typeof body[f] !== "boolean") {
        return yield* new ValidationError({ reason: f });
      }
    }
    const digest = body["email_digest"];
    if (digest !== undefined && !(EMAIL_DIGESTS as ReadonlyArray<unknown>).includes(digest)) {
      return yield* new ValidationError({ reason: "email_digest" });
    }

    const current = yield* fetchConfig(pubkey);
    const next: NotificationsConfigShape = {
      email_on_mention: (body["email_on_mention"] as boolean | undefined) ?? current.email_on_mention,
      email_on_assignment: (body["email_on_assignment"] as boolean | undefined) ?? current.email_on_assignment,
      email_on_issue_moved_to_me:
        (body["email_on_issue_moved_to_me"] as boolean | undefined) ?? current.email_on_issue_moved_to_me,
      email_digest: (digest as EmailDigest | undefined) ?? current.email_digest,
    };

    const db = yield* Db;
    const audit = yield* AuditLog;
    const now = yield* Clock.currentTimeMillis;
    yield* db.execute(
      "INSERT INTO notificationsConfig (pubkey, email_on_mention, email_on_assignment, email_on_issue_moved_to_me, email_digest, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(pubkey) DO UPDATE SET email_on_mention = excluded.email_on_mention, email_on_assignment = excluded.email_on_assignment, email_on_issue_moved_to_me = excluded.email_on_issue_moved_to_me, email_digest = excluded.email_digest, updated_at_ms = excluded.updated_at_ms",
      [
        pubkey,
        next.email_on_mention ? 1 : 0,
        next.email_on_assignment ? 1 : 0,
        next.email_on_issue_moved_to_me ? 1 : 0,
        next.email_digest,
        now,
      ],
    );
    yield* audit.record({
      event_type: "notifications_config_updated",
      actor: claims.login,
      details: { digest: next.email_digest },
    });
    return { config: next };
  });
