/**
 * Outbound webhook subscription actions (EFB-13) — the business half of
 * src/routes/webhooks.ts, split out by EFB-98.
 *
 * Everything here takes a plain input record, talks to the database through
 * Effect services, and returns a value. It imports no Hono and never sees a
 * Context. The route is the HTTP shell: it extracts params, parses the body,
 * runs requireCaller, calls one of these, and maps a failure to a status code.
 *
 * The division of labour BOUNDARY_DISCIPLINE.md insists on survives the move
 * unchanged: the schemas answer SHAPE questions and are pure, static and
 * DB-free; the two questions that need a database — "is this board private?"
 * and "is this caller allowed to filter on that pubkey?" — are named
 * authorization steps inside the actions. Folding either into a schema would
 * force a per-request schema, which is handler code with extra steps.
 *
 * Bodies moved VERBATIM. Every comment, ordering decision and failure reason
 * below is the pre-split code; the only edits read params/body/claims off an
 * input record instead of off a Context.
 */

import { Clock, Data, Effect, Schema } from "effect";

import { Db, type DbError } from "../effects";
import {
  ForbiddenError,
  UnauthorizedError,
  callerPubkey,
  resolveBoardScope,
  type BoardOwnershipError,
} from "../authz";
import { ValidationError } from "../lib/errors";
import { roleAtLeast } from "../roles";
import { IdentityRefFromInput, NonEmptyString } from "../lib/route-body";
import { mintWebhookSecret, sealWebhookSecret } from "../github/secret";
import { subscriberMayReceive } from "../lib/webhook-dispatch";
import type { ActionInput } from "./types";

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
  // EFB — actor-aware webhooks. When set, a matching subscription DOES NOT
  // fire if the event was caused by this pubkey. The single load-bearing use
  // case: an AI teammate on a board that subscribes to "issues assigned to
  // me" would loop on its own transitions/comments without this. Applies to
  // every kind — the emit path knows the actor via Provenance whether or
  // not the event's own payload carries an `actor_pubkey`.
  exclude_actor: Schema.optional(IdentityRefFromInput),
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
export class PredicateForbiddenError extends Data.TaggedError("PredicateForbiddenError")<{
  readonly reason: string;
}> {}

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly reason: string;
}> {}

export class ConfigError extends Data.TaggedError("ConfigError")<{ readonly reason: string }> {}

export type WebhookFailure =
  | ValidationError
  | PredicateForbiddenError
  | NotFoundError
  | ConfigError
  | ForbiddenError
  | UnauthorizedError
  | BoardOwnershipError
  | DbError;

/** Everything the webhook actions ask the layer for. */
export type WebhookServices = Db;

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
  predicate:
    | { readonly assignee?: string | undefined; readonly exclude_actor?: string | undefined }
    | null
    | undefined,
  caller: string | null,
  role: string,
): Effect.Effect<void, PredicateForbiddenError> => {
  // Anyone at admin OR ABOVE — that includes org owners (role="owner") whose
  // projection sits at rank 4, higher than admin's 3. Bare equality was wrong
  // and blocked the org owner from ever creating a predicate-filtered webhook
  // that named a pubkey other than themselves, even though owner is strictly
  // stronger than admin. Same bug also applied to the assignee check when it
  // stood alone; fixed together.
  const admin = roleAtLeast(role, "admin");
  const assignee = predicate?.assignee;
  if (assignee !== undefined && !admin && !(caller !== null && caller === assignee)) {
    return Effect.fail(new PredicateForbiddenError({ reason: "predicate-forbidden" }));
  }
  // Same posture as `assignee`: an `exclude_actor` predicate names a specific
  // pubkey, which turns "notify me on this board except when X acts" into a
  // channel that leaks X's inactivity to whoever registers it. Only board
  // admins (who can already see every action) or the actor themselves (a
  // self-suppress — "don't ping me for my own work") may set it.
  const excludeActor = predicate?.exclude_actor;
  if (excludeActor !== undefined && !admin && !(caller !== null && caller === excludeActor)) {
    return Effect.fail(new PredicateForbiddenError({ reason: "predicate-forbidden" }));
  }
  return Effect.void;
};

/**
 * Resolve the board this request is scoped to, proving `minRole` on it.
 *
 * `requireCaller` ran in the route and its RESULT is passed in, which is why
 * every action below takes `ActionInput` rather than `PublicActionInput`:
 * there is no anonymous path onto a board's webhook settings.
 */
const boardScope = (
  input: Pick<ActionInput<unknown>, "claims" | "orgSlug" | "params" | "grants">,
  minRole = "admin",
) =>
  Effect.gen(function* () {
    const scope = yield* resolveBoardScope(
      { org_slug: input.orgSlug ?? undefined, slug: input.params["slug"] ?? "" },
      callerPubkey(input.claims),
      minRole, input.grants,);
    return { ...scope, caller: callerPubkey(input.claims) };
  });

// EFB-62 lifted the v1 private-board refusal that used to live here
// (`outbound-webhooks-private-boards-unsupported-v1`). Nothing replaces it at
// create time ON PURPOSE: a create-time check cannot see a membership change
// that happens afterwards, which is the entire failure this ticket exists to
// close. The gate lives at enqueue and at sweep instead — see
// `subscriberMayReceive` in src/lib/webhook-dispatch.ts. What create time
// does now is capture the identity that gate will check.

// ── list ────────────────────────────────────────────────────────────────
export const listWebhooks = (input: ActionInput) =>
  Effect.gen(function* () {
    const { board } = yield* boardScope(input, "admin");
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
  });

// ── create ──────────────────────────────────────────────────────────────
/**
 * `masterSecret` is `c.env.EVENFLOW_WEBHOOK_SECRET`, read in the route and
 * passed explicitly. Env is not request input, so it does not belong on
 * ActionInput; passing it here keeps the dependency visible in the signature
 * instead of hidden inside a record every other action would also carry.
 *
 * `input.body` is a DEFERRED parse (EFB-98 rule 10). The pre-split handler ran
 * `boardScope` BEFORE `parseRouteBody`, so a caller who cannot see the board
 * got its 401/403/404 rather than a 400 about a body they were never entitled
 * to have read. Handing the action an unevaluated Effect keeps the
 * `parseRouteBody` call physically in the route — where check:boundary and the
 * allowlist both need to see it — while the parse still happens exactly where
 * it always did, one line below the gate.
 */
export const createWebhook = (
  input: ActionInput<Effect.Effect<typeof PostSubscriptionBody.Type, ValidationError>>,
  masterSecret: string | undefined,
) =>
  Effect.gen(function* () {
    const { board, role, caller } = yield* boardScope(input, "admin");
    const body = yield* input.body;
    yield* requirePredicateAllowed(body.predicate, caller, role);

    const master = masterSecret;
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
  });

// ── update ──────────────────────────────────────────────────────────────
/** Deferred parse for the same reason as `createWebhook` — see rule 10 there. */
export const updateWebhook = (
  input: ActionInput<Effect.Effect<typeof PatchSubscriptionBody.Type, ValidationError>>,
) =>
  Effect.gen(function* () {
    const { board, role, caller } = yield* boardScope(input, "admin");
    const body = yield* input.body;
    yield* requirePredicateAllowed(body.predicate, caller, role);

    const db = yield* Db;
    const id = input.params["id"];
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
  });

// ── delete ──────────────────────────────────────────────────────────────
//
// Deletes the subscription, NOT its delivery history. The delivery log is an
// audit trail and one that vanishes with the thing it audits is not an audit
// trail — see the soft-FK note in migration 0025. The sweep joins, so orphan
// rows can never produce a phantom POST.
export const deleteWebhook = (input: ActionInput) =>
  Effect.gen(function* () {
    const { board } = yield* boardScope(input, "admin");
    const db = yield* Db;
    const id = input.params["id"];
    const existing = yield* db.queryFirst(
      "SELECT id FROM webhookSubscriptions WHERE id = ? AND board_id = ?",
      [id, board.id],
    );
    if (existing === null) {
      return yield* new NotFoundError({ reason: "subscription-not-found" });
    }
    yield* db.execute("DELETE FROM webhookSubscriptions WHERE id = ?", [id]);
    return { deleted: id };
  });

// ── delivery log ────────────────────────────────────────────────────────
export const listWebhookDeliveries = (input: ActionInput) =>
  Effect.gen(function* () {
    const { board } = yield* boardScope(input, "admin");
    const db = yield* Db;
    const id = input.params["id"];
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
  });
