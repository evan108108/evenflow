// EFB-13 — outbound webhook subscription CRUD.
//
// A NEW route family, so every body comes through `parseRouteBody` from the
// first commit — `scripts/boundary-allowlist.json` is closed to new entries and
// nothing here is added to it. See docs/BOUNDARY_DISCIPLINE.md.
//
// The division of labour that document insists on is visible below: the schemas
// answer SHAPE questions and are pure, static and DB-free; the two questions
// that need a database — "is this board private?" and "is this caller allowed
// to filter on that pubkey?" — are named authorization steps inside the
// handlers. Folding either into a schema would force a per-request schema,
// which is handler code with extra steps.

import { Hono } from "hono";
import { path } from "../routes-manifest";
import type { Context } from "hono";
import { Clock, Data, Effect, Exit } from "effect";
import { Db, DbError, bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import {
  ForbiddenError,
  UnauthorizedError,
  callerPubkey,
  requireCaller,
  resolveBoardScope,
  type BoardOwnershipError,
} from "../authz";
import { ValidationError } from "./errors";
import { parseRouteBody, IdentityRefFromInput, NonEmptyString, Uuid } from "../lib/route-body";
import { mintWebhookSecret, sealWebhookSecret } from "../github/secret";
import { subscriberMayReceive } from "../lib/webhook-dispatch";
import { Schema } from "effect";

/** The 16 frozen kinds from src/durable-objects/board-events.ts. */
export const BOARD_EVENT_KINDS = [
  "issue.created",
  "issue.updated",
  "issue.transitioned",
  "issue.container_changed",
  "issue.deleted",
  "comment.created",
  "comment.deleted",
  "board.created",
  "board.updated",
  "board.deleted",
  "sprint.created",
  "sprint.updated",
  "sprint.started",
  "sprint.completed",
  "sprint.deleted",
  "sprint.tide.updated",
  // EFB-15 — the aggregate import event. A subscriber gets ONE delivery per
  // import rather than one per row. Note that a subscription carrying an
  // `assignee` predicate will never match this kind: the payload is a summary
  // with no assignee to compare, so `matchesSubscription` answers false. That
  // is deliberate — an aggregate has no single person to attribute — and it
  // means "notify me about MY issues" stays silent through an import.
  "issues.imported",
] as const;

/**
 * Subscribing to an event kind that does not exist is always a mistake — a typo
 * or a client written against a vocabulary we never had. Enumerating the union
 * here rather than accepting `string` is what turns that into a 400 naming the
 * field instead of a subscription that silently never fires.
 *
 * NOTE for whoever adds a kind: this list mirrors board-events.ts and there is
 * a test asserting the two agree, so adding a kind there without adding it here
 * fails loudly rather than shipping a kind nobody can subscribe to.
 */
const EventKind = Schema.Literal(...BOARD_EVENT_KINDS);

/**
 * v1 predicate grammar: exactly one optional field.
 *
 * Deliberately not a filter language. The brief's out-of-scope list rules out a
 * builder wizard, and an expression grammar would be a parser plus an evaluator
 * plus an injection surface, for a feature whose only known use is "tell me
 * about my own issues".
 */
const Predicate = Schema.Struct({
  assignee: Schema.optional(IdentityRefFromInput),
});

const AuthScheme = Schema.Literal("hmac", "bearer");

export const PostSubscriptionBody = Schema.Struct({
  name: NonEmptyString,
  url: Schema.String.pipe(Schema.pattern(/^https:\/\/.+/)),
  event_kinds: Schema.Array(EventKind).pipe(Schema.minItems(1)),
  predicate: Schema.optional(Schema.NullOr(Predicate)),
  auth_scheme: Schema.optional(AuthScheme),
});

export const PatchSubscriptionBody = Schema.Struct({
  name: Schema.optional(NonEmptyString),
  url: Schema.optional(Schema.String.pipe(Schema.pattern(/^https:\/\/.+/))),
  event_kinds: Schema.optional(Schema.Array(EventKind).pipe(Schema.minItems(1))),
  predicate: Schema.optional(Schema.NullOr(Predicate)),
  auth_scheme: Schema.optional(AuthScheme),
  enabled: Schema.optional(Schema.Boolean),
});

/** Caller tried to filter on somebody else's activity. */
class PredicateForbiddenError extends Data.TaggedError("PredicateForbiddenError")<{
  readonly reason: string;
}> {}

class NotFoundError extends Data.TaggedError("NotFoundError")<{ readonly reason: string }> {}

class ConfigError extends Data.TaggedError("ConfigError")<{ readonly reason: string }> {}

type WebhookFailure =
  | ValidationError
  | PredicateForbiddenError
  | NotFoundError
  | ConfigError
  | ForbiddenError
  | UnauthorizedError
  | BoardOwnershipError
  | DbError;

interface SubscriptionRecord {
  readonly id: string;
  readonly board_id: string;
  readonly name: string;
  readonly url: string;
  readonly event_kinds: string;
  readonly predicate: string | null;
  readonly auth_scheme: string;
  readonly enabled: number;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  /** EFB-62 — NULL on subscriptions created before migration 0028. */
  readonly creator_pubkey: string | null;
}

/**
 * The secret ciphertext never leaves the server — not even to a board admin.
 *
 * `creator_pubkey` does go out: it is a board member's identity shown to a
 * board admin, who can already read the full roster, and withholding it would
 * make `member_ok: false` unactionable — an admin needs to know WHOSE
 * membership lapsed to fix it.
 */
const subscriptionWire = (r: SubscriptionRecord, memberOk: boolean) => ({
  id: r.id,
  board_id: r.board_id,
  name: r.name,
  url: r.url,
  event_kinds: JSON.parse(r.event_kinds) as unknown,
  predicate: r.predicate === null ? null : (JSON.parse(r.predicate) as unknown),
  auth_scheme: r.auth_scheme,
  enabled: r.enabled === 1,
  created_at_ms: r.created_at_ms,
  updated_at_ms: r.updated_at_ms,
  creator_pubkey: r.creator_pubkey,
  // Whether deliveries are actually flowing. `enabled` is what the admin set;
  // this is what the gate decides. They differ exactly when membership lapsed.
  member_ok: memberOk,
});

/**
 * EFB-13 surprise #9 — the activity-leak guard.
 *
 * A predicate of `assignee=<X>` turns a webhook into a per-user activity feed
 * for X. Without this, anyone who can register a URL on a board could watch any
 * individual member's work. Requiring caller == X (or board admin, who can
 * already read every issue on the board anyway) keeps a subscription's reach
 * inside what its creator could already see.
 *
 * An AUTHORIZATION step, not a shape check: it needs the resolved board role
 * and the caller identity, neither of which a pure schema has — per the DB-free
 * rule in BOUNDARY_DISCIPLINE.md. Module scope and exported so the rule can be
 * tested directly rather than only through a live router.
 */
export const requirePredicateAllowed = (
  predicate: { readonly assignee?: string | undefined } | null | undefined,
  caller: string | null,
  role: string,
): Effect.Effect<void, PredicateForbiddenError> => {
  const assignee = predicate?.assignee;
  if (assignee === undefined) return Effect.void;
  if (role === "admin" || (caller !== null && caller === assignee)) return Effect.void;
  return Effect.fail(new PredicateForbiddenError({ reason: "predicate-forbidden" }));
};

export const makeWebhooksRouter = (layerFor?: LayerFor) => {
  const app = new Hono<AppHonoEnv>();
  const layer = (c: Context<AppHonoEnv>) =>
    layerFor === undefined ? bootstrap(c.env) : layerFor(c.env);

  const errorResponse = (c: Context<AppHonoEnv>, cause: unknown) => {
    const e = cause as { _tag?: string; reason?: string };
    const tag = String(e?._tag ?? "");
    const reason = e?.reason ?? "error";
    if (tag === "UnauthorizedError") return c.json({ reason }, 401);
    if (tag === "ForbiddenError" || tag === "PredicateForbiddenError") {
      return c.json({ reason }, 403);
    }
    if (tag === "NotFoundError" || tag === "BoardOwnershipError") return c.json({ reason }, 404);
    if (tag === "ValidationError") return c.json({ reason }, 400);
    return c.json({ reason: "internal" }, 500);
  };

  const run = <A>(
    c: Context<AppHonoEnv>,
    program: Effect.Effect<A, WebhookFailure, Db>,
    ok: (a: A) => Response,
  ) =>
    Effect.runPromise(Effect.exit(Effect.provide(program, layer(c)))).then((exit) =>
      Exit.isSuccess(exit)
        ? ok(exit.value)
        : errorResponse(c, (exit.cause as { error?: unknown }).error ?? exit.cause),
    );

  const boardScope = (c: Context<AppHonoEnv>, minRole = "admin") =>
    Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const params = c.req.param() as Record<string, string | undefined>;
      const scope = yield* resolveBoardScope(
        { org_slug: params["org_slug"], slug: params["slug"] ?? "" },
        callerPubkey(claims),
        minRole,
      );
      return { ...scope, caller: callerPubkey(claims) };
    });

  // EFB-62 lifted the v1 private-board refusal that used to live here
  // (`outbound-webhooks-private-boards-unsupported-v1`). Nothing replaces it at
  // create time ON PURPOSE: a create-time check cannot see a membership change
  // that happens afterwards, which is the entire failure this ticket exists to
  // close. The gate lives at enqueue and at sweep instead — see
  // `subscriberMayReceive` in src/lib/webhook-dispatch.ts. What create time
  // does now is capture the identity that gate will check.

  // ── list ────────────────────────────────────────────────────────────────
  app.get(path("webhook.list"), (c) =>
    run(
      c,
      Effect.gen(function* () {
        const { board } = yield* boardScope(c, "admin");
        const db = yield* Db;
        const rows = yield* db.queryAll<SubscriptionRecord>(
          `SELECT * FROM webhookSubscriptions WHERE board_id = ? ORDER BY created_at_ms DESC`,
          [board.id],
        );

        // EFB-62 — why a silent drop needs a loud surface.
        //
        // The gate deliberately does NOT delete or disable a subscription whose
        // owner lost membership: they may be re-added, and deleting would force
        // them to re-register from scratch. But "row still here, deliveries
        // silently stopping" is indistinguishable from "our cron is broken"
        // unless we say which it is. `member_ok: false` is that answer, so an
        // admin looking at a quiet webhook sees the reason instead of filing a
        // bug against the sweep.
        //
        // Computed through the same `subscriberMayReceive` the dispatch path
        // uses. Reusing it rather than restating the rule is what stops this
        // display from drifting into a comfortable lie about what will be
        // delivered.
        const memberOk = new Map<string, boolean>();
        for (const r of rows) {
          const key = r.creator_pubkey ?? " null";
          if (!memberOk.has(key)) {
            memberOk.set(key, yield* subscriberMayReceive(board, r.creator_pubkey));
          }
        }

        return {
          subscriptions: rows.map((r) =>
            subscriptionWire(r, memberOk.get(r.creator_pubkey ?? " null") ?? false),
          ),
          // Retained for the UI, now purely informational rather than the
          // reason an affordance is hidden. Note this is `visibility`, not
          // `encryption_active`: a board that is private with no audience minted
          // is still a private board, and EFB-13 telling the UI otherwise is
          // the same three-state confusion that produced the leak.
          private_board: board.visibility !== "public",
        };
      }),
      (v) => c.json(v),
    ),
  );

  // ── create ──────────────────────────────────────────────────────────────
  app.post(path("webhook.create"), (c) =>
    run(
      c,
      Effect.gen(function* () {
        const { board, role, caller } = yield* boardScope(c, "admin");
        const body = yield* parseRouteBody(c, PostSubscriptionBody);
        yield* requirePredicateAllowed(body.predicate, caller, role);

        const master = c.env.EVENFLOW_WEBHOOK_SECRET;
        if (master === undefined) {
          return yield* new ConfigError({ reason: "webhook-secret-key-missing" });
        }
        const plaintext = mintWebhookSecret();
        const sealed = yield* Effect.promise(() => sealWebhookSecret(master, plaintext));
        if (sealed === null) {
          return yield* new ConfigError({ reason: "webhook-secret-key-missing" });
        }

        const now = yield* Clock.currentTimeMillis;
        const id = crypto.randomUUID();
        const db = yield* Db;
        yield* db.execute(
          `INSERT INTO webhookSubscriptions
             (id, board_id, name, url, event_kinds, predicate, auth_scheme,
              hmac_secret_ciphertext, enabled, created_at_ms, updated_at_ms, creator_pubkey)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          [
            id,
            board.id,
            body.name,
            body.url,
            JSON.stringify(body.event_kinds),
            body.predicate === undefined || body.predicate === null
              ? null
              : JSON.stringify(body.predicate),
            body.auth_scheme ?? "hmac",
            sealed,
            now,
            now,
            // EFB-62 — the subscription's bound identity, captured here because
            // here is the only place it exists. `boardScope` already proved this
            // caller is an admin of the board; what the gate re-checks later is
            // that they are still a MEMBER at all, which is the weaker and
            // correct bar: a demoted admin can still read the board, so their
            // webhook is not carrying anything they lost access to.
            caller,
          ],
        );
        const row = yield* db.queryFirst("SELECT * FROM webhookSubscriptions WHERE id = ?", [id]);
        return {
          subscription: subscriptionWire(row as SubscriptionRecord, true),
          // THIS RESPONSE ONLY, mirroring the GitHub secret route: the
          // plaintext is never retrievable again, so a subscriber that loses
          // it rotates rather than reads.
          secret: plaintext,
        };
      }),
      (v) => c.json(v, 201),
    ),
  );

  // ── update ──────────────────────────────────────────────────────────────
  app.patch(path("webhook.update"), (c) =>
    run(
      c,
      Effect.gen(function* () {
        const { board, role, caller } = yield* boardScope(c, "admin");
        const body = yield* parseRouteBody(c, PatchSubscriptionBody);
        yield* requirePredicateAllowed(body.predicate, caller, role);

        const db = yield* Db;
        const id = c.req.param("id");
        const existing = yield* db.queryFirst(
          "SELECT * FROM webhookSubscriptions WHERE id = ? AND board_id = ?",
          [id, board.id],
        );
        if (existing === null) {
          return yield* new NotFoundError({ reason: "subscription-not-found" });
        }

        const now = yield* Clock.currentTimeMillis;
        const prev = existing as SubscriptionRecord;
        yield* db.execute(
          `UPDATE webhookSubscriptions
              SET name = ?, url = ?, event_kinds = ?, predicate = ?,
                  auth_scheme = ?, enabled = ?, updated_at_ms = ?
            WHERE id = ?`,
          [
            body.name ?? prev.name,
            body.url ?? prev.url,
            body.event_kinds === undefined ? prev.event_kinds : JSON.stringify(body.event_kinds),
            body.predicate === undefined
              ? prev.predicate
              : body.predicate === null
                ? null
                : JSON.stringify(body.predicate),
            body.auth_scheme ?? prev.auth_scheme,
            body.enabled === undefined ? prev.enabled : body.enabled ? 1 : 0,
            now,
            id,
          ],
        );
        const row = yield* db.queryFirst("SELECT * FROM webhookSubscriptions WHERE id = ?", [id]);
        const updated = row as SubscriptionRecord;
        // NOT rebound to the patching caller. A second admin editing someone
        // else's webhook would otherwise silently transfer the gate's identity
        // to themselves, which is an authorization change disguised as a rename.
        return {
          subscription: subscriptionWire(
            updated,
            yield* subscriberMayReceive(board, updated.creator_pubkey),
          ),
        };
      }),
      (v) => c.json(v),
    ),
  );

  // ── delete ──────────────────────────────────────────────────────────────
  //
  // Deletes the subscription, NOT its delivery history. The delivery log is an
  // audit trail and one that vanishes with the thing it audits is not an audit
  // trail — see the soft-FK note in migration 0025. The sweep joins, so orphan
  // rows can never produce a phantom POST.
  app.delete(path("webhook.delete"), (c) =>
    run(
      c,
      Effect.gen(function* () {
        const { board } = yield* boardScope(c, "admin");
        const db = yield* Db;
        const id = c.req.param("id");
        const existing = yield* db.queryFirst(
          "SELECT id FROM webhookSubscriptions WHERE id = ? AND board_id = ?",
          [id, board.id],
        );
        if (existing === null) {
          return yield* new NotFoundError({ reason: "subscription-not-found" });
        }
        yield* db.execute("DELETE FROM webhookSubscriptions WHERE id = ?", [id]);
        return { deleted: id };
      }),
      (v) => c.json(v),
    ),
  );

  // ── delivery log ────────────────────────────────────────────────────────
  app.get(path("webhook.deliveries.list"), (c) =>
    run(
      c,
      Effect.gen(function* () {
        const { board } = yield* boardScope(c, "admin");
        const db = yield* Db;
        const id = c.req.param("id");
        const rows = yield* db.queryAll<{
          id: string;
          event_kind: string;
          created_at_ms: number;
          attempted_at_ms: number | null;
          attempt_count: number;
          status_code: number | null;
          response_body_snippet: string | null;
          next_retry_at_ms: number;
          terminal: number;
        }>(
          `SELECT id, event_kind, created_at_ms, attempted_at_ms, attempt_count,
                  status_code, response_body_snippet, next_retry_at_ms, terminal
             FROM webhookSubscriptionDeliveries
            WHERE subscription_id = ? AND board_id = ?
            ORDER BY created_at_ms DESC
            LIMIT 50`,
          [id, board.id],
        );
        return {
          deliveries: rows.map((r) => ({
            ...r,
            terminal: r.terminal === 1,
            // A row the sweep has never touched. Distinguished from "attempted
            // and failed" because the two mean different things: one is a bad
            // subscriber, the other is our cron not running.
            pending: r.attempted_at_ms === null,
          })),
        };
      }),
      (v) => c.json(v),
    ),
  );

  return app;
};
