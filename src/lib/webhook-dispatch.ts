// EFB-13 — outbound webhook delivery.
//
// Two halves that never run in the same invocation:
//
//   enqueueOutboundWebhooks()  — called from emitSecureBoardEvent, on the
//                                request path. Writes rows. NO network I/O.
//   sweepOutboundWebhooks()    — called from the cron. Does every POST.
//
// The split is forced, not stylistic. `emitSecureBoardEvent` has no
// ExecutionContext, so there is no `ctx.waitUntil` to hand deferred work to,
// and EFB-24 established by production evidence that `Effect.forkDaemon` at
// that site runs nothing at all — Cloudflare cancels outstanding work when the
// response returns (see the postmortem comment at src/audiences.ts:635-656).
// A "fire the POST from the emit path" design here would pass every test and
// deliver zero webhooks in production.
//
// So the sweep is the only thing that ever calls out. That makes its liveness
// load-bearing in a way a retry backstop's is not: if the cron stops, the
// feature is down, not slow. `stuckDeliveryCount` exists to make that loud.

import { Effect } from "effect";
import { Db } from "../effects";
import type { BoardEvent } from "../durable-objects/board-events";
import { parseBoardRow, type BoardShape } from "../shapes";
import { effectiveBoardRole } from "../authz";
import { publishesPlaintext } from "./kanban/publish";
import { openWebhookSecret, signGithubBody } from "../github/secret";

/**
 * Attempt N waits this long before N+1. Five entries = five attempts, then the
 * row goes terminal. Deliberately coarse at the tail: a subscriber that has
 * been down for two hours is not coming back inside the next two minutes, and
 * retrying it every minute for a day costs us 1440 pointless requests per row.
 */
export const BACKOFF_MS: ReadonlyArray<number> = [
  60_000, // 1m
  300_000, // 5m
  1_800_000, // 30m
  7_200_000, // 2h
  43_200_000, // 12h
];

export const MAX_ATTEMPTS = BACKOFF_MS.length;

/** Rows claimed per cron tick. Bounds a burst; the next tick takes the rest. */
export const SWEEP_BATCH = 50;

/** A subscriber that has not answered in this long is treated as a failure. */
const DELIVERY_TIMEOUT_MS = 10_000;

/** Error bodies are audit context, not storage. Keep a preview, drop the rest. */
const BODY_SNIPPET_MAX = 2_000;

/**
 * A delivery with `attempted_at_ms IS NULL` older than this means the sweep is
 * not running. Five minutes is four missed ticks on a one-minute cron — long
 * enough that a single slow tick is not an alarm, short enough that a real
 * outage surfaces while it still matters.
 */
export const STUCK_AFTER_MS = 300_000;

export interface SubscriptionRow {
  readonly id: string;
  readonly board_id: string;
  readonly url: string;
  readonly event_kinds: string;
  readonly predicate: string | null;
  readonly auth_scheme: string;
  readonly hmac_secret_ciphertext: string;
  /** EFB-62 — the identity the member gate checks. NULL on pre-0028 rows. */
  readonly creator_pubkey: string | null;
}

export interface DeliveryRow {
  readonly id: string;
  readonly subscription_id: string;
  readonly board_id: string;
  readonly event_json: string;
  readonly attempt_count: number;
  readonly url: string;
  readonly auth_scheme: string;
  readonly hmac_secret_ciphertext: string;
  readonly creator_pubkey: string | null;
}

/**
 * EFB-62 — may this subscription's owner still receive this board's events?
 *
 * THE GATE. Read this before changing either caller.
 *
 * `publishesPlaintext` decides whether a gate is needed at all, and it is
 * reused rather than reproduced for the reason its own header gives: the
 * obvious spelling, `!board.encryption_active`, is WRONG, and wrong in the
 * direction that leaks. `encryption_active` is derived as `visibility ===
 * "private" && audience_pubkey !== null`, so its negation covers three states —
 * public, private-with-no-audience, and board-not-loadable — and treats the
 * last two as public. Private is the default create visibility and audiences
 * are only minted on an explicit PATCH, so private-with-no-audience is not a
 * corner case: it is where every new board sits. EFB-13 gated on
 * `encryption_active` and therefore delivered those boards' cleartext to any
 * registered URL. Reusing the one primitive is what keeps that fix from
 * rotting back in.
 *
 * Membership is resolved through `effectiveBoardRole`, NOT a direct
 * `boardMemberCache` lookup. The roster is explicit grants ∪ org-member
 * projection ∪ board creator (authz.ts), so the bare-table query — the one
 * this ticket's brief proposed — would silently drop every subscriber whose
 * access comes from org membership rather than an explicit board row. Same
 * function the HTTP read path gates on, so a subscriber's webhook goes quiet
 * exactly when their API reads would start 404-ing, and never before.
 *
 * NULL `creator_pubkey` (a pre-0028 subscription) fails CLOSED on a private
 * board: an unknown subscriber cannot be shown to be a member.
 */
export const subscriberMayReceive = (
  board: BoardShape,
  creatorPubkey: string | null,
): Effect.Effect<boolean, never, Db> =>
  Effect.gen(function* () {
    if (publishesPlaintext(board)) return true;
    if (creatorPubkey === null) return false;
    const role = yield* effectiveBoardRole(board, creatorPubkey);
    return role !== null;
  }).pipe(Effect.catchAll(() => Effect.succeed(false)));

/**
 * Does this subscription want this event?
 *
 * Pure and total: a row whose `event_kinds` or `predicate` is unparseable JSON
 * matches NOTHING rather than throwing. A corrupt subscription costs its owner
 * their notifications; it must never take down the emit path for the board.
 */
export const matchesSubscription = (
  sub: SubscriptionRow,
  event: BoardEvent,
  actorPubkey: string | null = null,
): boolean => {
  let kinds: unknown;
  try {
    kinds = JSON.parse(sub.event_kinds);
  } catch {
    return false;
  }
  if (!Array.isArray(kinds) || !kinds.includes(event.kind)) return false;

  if (sub.predicate === null) return true;
  let predicate: unknown;
  try {
    predicate = JSON.parse(sub.predicate);
  } catch {
    return false;
  }
  if (typeof predicate !== "object" || predicate === null) return false;

  // v1 grammar: at most two fields.
  //   { "assignee": "<canonical ref>" }        — deliver only when the issue is
  //                                              assigned to X. Reads
  //                                              payload.assignee_pubkey.
  //   { "exclude_actor": "<canonical ref>" }   — do NOT deliver when X caused
  //                                              the event. Reads actor
  //                                              provenance carried alongside
  //                                              the event (not payload) so it
  //                                              works uniformly on every
  //                                              kind, not just the handful
  //                                              whose payload happens to
  //                                              include actor_pubkey.
  // Both are optional; if both are set they AND. The exclude_actor test comes
  // FIRST because it is a cheaper reject on a self-loop — the common case for
  // an AI teammate.
  //
  // The payload is `unknown` by contract (board-events.ts), so this reads
  // defensively rather than casting.
  //
  // EFB-62 — this now runs for private boards too, and it must be handed the
  // PLAINTEXT event to keep working: on a private board the delivered event's
  // payload is a NIP-44 ciphertext envelope with no `assignee_pubkey` to read,
  // so matching against it would answer false for every subscription and
  // silently disable predicates on exactly the boards that most want them.
  // Hence the enqueue path's two-event signature — match on one, deliver the
  // other. Matching on cleartext leaks nothing: it happens inside the worker,
  // against a board row we already hold.
  const excludeActor = (predicate as Record<string, unknown>)["exclude_actor"];
  if (typeof excludeActor === "string") {
    if (actorPubkey !== null && actorPubkey === excludeActor) return false;
  }
  const wanted = (predicate as Record<string, unknown>)["assignee"];
  if (wanted === undefined) return true;
  if (typeof wanted !== "string") return false;
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return false;
  // Real emit paths (src/actions/issues.ts) wrap the issue as
  // { issue: { ..., assignee_pubkey, ... } } and DO NOT expose
  // assignee_pubkey at the payload top level — the top-level check alone
  // would never match a live event. Accept both spellings so a caller
  // handing us a flat {assignee_pubkey} still matches (some events
  // deliberately do that, e.g. status_change rows) but real issue events
  // find the field where it actually lives.
  const p = payload as Record<string, unknown>;
  const top = p["assignee_pubkey"];
  if (top === wanted) return true;
  const inner = p["issue"];
  if (typeof inner === "object" && inner !== null) {
    return (inner as Record<string, unknown>)["assignee_pubkey"] === wanted;
  }
  return false;
};

/**
 * Queue every matching subscription's delivery for `event`.
 *
 * Returns the number of rows enqueued. NEVER fails: the caller is the emit
 * path, and a webhook bookkeeping problem must not turn a successful board
 * mutation into an error. Failures are logged and swallowed.
 *
 * EFB-62 — private boards are no longer skipped wholesale. Each matching
 * subscription is gated individually through `subscriberMayReceive`, and what
 * gets persisted is `deliverEvent` (the encrypted-payload event on a private
 * board), never the plaintext one used for predicate matching.
 *
 * Two events, because the two questions differ. `event` answers "does this
 * subscription want this?" and must be cleartext to answer it. `deliverEvent`
 * answers "what bytes leave the building?" and must be the same wrap a member
 * would have received over SSE — so a subscriber never gets bytes their
 * membership could not already decrypt.
 *
 * A drop here writes NO delivery row, deliberately. A revoked subscriber on a
 * busy board would otherwise mint one identical audit row per event, forever.
 * The transition worth auditing — queued while a member, refused when due —
 * is caught by the sweep, where the row already exists (migration 0028).
 */
export const enqueueOutboundWebhooks = (
  board: BoardShape,
  event: BoardEvent,
  deliverEvent: BoardEvent,
  nowMs: number,
  actorPubkey: string | null,
): Effect.Effect<number, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const subs = yield* db.queryAll<SubscriptionRow>(
      `SELECT id, board_id, url, event_kinds, predicate, auth_scheme, hmac_secret_ciphertext, creator_pubkey
         FROM webhookSubscriptions
        WHERE board_id = ? AND enabled = 1`,
      [board.id],
    );

    const matching = subs.filter((s) => matchesSubscription(s, event, actorPubkey));
    if (matching.length === 0) return 0;

    // Resolved once per distinct subscriber, not once per subscription: a
    // board with several webhooks owned by one admin should cost one roster
    // read, and `effectiveBoardRole` is two queries every time it is called.
    const roleCache = new Map<string, boolean>();
    const allowed: SubscriptionRow[] = [];
    for (const sub of matching) {
      const key = sub.creator_pubkey ?? " null";
      let ok = roleCache.get(key);
      if (ok === undefined) {
        ok = yield* subscriberMayReceive(board, sub.creator_pubkey);
        roleCache.set(key, ok);
      }
      if (ok) allowed.push(sub);
      else {
        console.log(
          JSON.stringify({
            debug: "webhook-enqueue-membership-denied",
            board_id: board.id,
            subscription_id: sub.id,
            kind: event.kind,
            creator_known: sub.creator_pubkey !== null,
          }),
        );
      }
    }
    if (allowed.length === 0) return 0;

    const eventJson = JSON.stringify(deliverEvent);
    for (const sub of allowed) {
      yield* db.execute(
        `INSERT INTO webhookSubscriptionDeliveries
           (id, subscription_id, board_id, event_kind, event_json,
            created_at_ms, attempt_count, next_retry_at_ms, terminal)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0)`,
        [crypto.randomUUID(), sub.id, board.id, event.kind, eventJson, nowMs, nowMs],
      );
    }
    return allowed.length;
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => {
        console.log(
          JSON.stringify({
            warn: "webhook-enqueue-failed",
            board_id: board.id,
            kind: event.kind,
            error: String(e),
          }),
        );
        return 0;
      }),
    ),
    // DEFECTS TOO, and this is not belt-and-braces — it is the difference
    // between "never fails" being true and merely intended. `catchAll` covers
    // the typed error channel; a driver-level problem (missing table, malformed
    // SQL) arrives as a DEFECT and sails straight past it. That is not
    // hypothetical: adding this hook without this line turned 372 tests red,
    // because the test fixture's schema has no webhookSubscriptions table and
    // every issue-creating test inherited the die through emitSecureBoardEvent.
    //
    // Which is the real lesson: the emit path is shared by every mutation in
    // the app, so anything bolted onto it must be unfailable in the strong
    // sense. A webhook bookkeeping problem must never be able to turn a
    // committed board mutation into a 500.
    Effect.catchAllDefect((defect) =>
      Effect.sync(() => {
        console.log(
          JSON.stringify({
            warn: "webhook-enqueue-defect",
            board_id: board.id,
            kind: event.kind,
            detail: String(defect),
          }),
        );
        return 0;
      }),
    ),
  );

/**
 * POST one delivery and record the outcome.
 *
 * Terminal on 2xx (done) and on 4xx (the subscriber's configuration is wrong —
 * a wrong URL or a revoked token does not heal, and retrying it five times
 * just makes our traffic look like an attack). 5xx, network failure and
 * timeout all retry: they are the cases where the same request later plausibly
 * succeeds.
 */
export const deliverOne = (
  row: DeliveryRow,
  masterSecret: string | undefined,
  nowMs: number,
): Effect.Effect<boolean, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const attempt = row.attempt_count + 1;

    const finish = (
      statusCode: number | null,
      snippet: string | null,
      terminal: boolean,
    ) =>
      db.execute(
        `UPDATE webhookSubscriptionDeliveries
            SET attempted_at_ms = ?, attempt_count = ?, status_code = ?,
                response_body_snippet = ?, next_retry_at_ms = ?, terminal = ?
          WHERE id = ?`,
        [
          nowMs,
          attempt,
          statusCode,
          snippet,
          terminal ? nowMs : nowMs + (BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[MAX_ATTEMPTS - 1]!),
          terminal ? 1 : 0,
          row.id,
        ],
      );

    // A subscription whose secret cannot be opened can never be delivered —
    // terminal immediately rather than five identical failures.
    let secret: string | null = null;
    if (masterSecret !== undefined) {
      secret = yield* Effect.promise(() =>
        openWebhookSecret(masterSecret, row.hmac_secret_ciphertext),
      );
    }
    if (secret === null) {
      yield* finish(null, "webhook-secret-unavailable", true);
      return false;
    }

    // DELIBERATELY the same function the INBOUND GitHub path verifies with, not
    // a second HMAC-SHA256 implementation that happens to agree today. Inbound
    // and outbound are one algorithm by construction: change the signing there
    // and this moves in lockstep, with no duplicate to drift. If a future
    // refactor is tempted to give outbound its own signer, that is the property
    // being given up — the two are only "the same story in both directions"
    // (EFB-13's premise) for as long as they are the same code.
    const signature = yield* Effect.promise(() => signGithubBody(secret, row.event_json));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "evenflow-webhooks/1",
      "x-evenflow-event": JSON.parse(row.event_json).kind ?? "unknown",
      "x-evenflow-delivery": row.id,
    };
    if (row.auth_scheme === "bearer") headers["authorization"] = `Bearer ${secret}`;
    else headers["x-evenflow-signature"] = signature;

    const outcome = yield* Effect.tryPromise({
      try: () =>
        fetch(row.url, {
          method: "POST",
          headers,
          body: row.event_json,
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        }),
      catch: (e) => e,
    }).pipe(
      Effect.flatMap((res) =>
        Effect.promise(() =>
          res
            .text()
            .then((t) => ({ status: res.status, body: t.slice(0, BODY_SNIPPET_MAX) }))
            .catch(() => ({ status: res.status, body: "" })),
        ),
      ),
      Effect.catchAll((e) => Effect.succeed({ status: null, body: String(e).slice(0, BODY_SNIPPET_MAX) })),
    );

    const status = outcome.status;
    const ok = status !== null && status >= 200 && status < 300;
    const clientError = status !== null && status >= 400 && status < 500;
    const exhausted = attempt >= MAX_ATTEMPTS;
    yield* finish(status, outcome.body, ok || clientError || exhausted);
    return ok;
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => {
        console.log(
          JSON.stringify({ warn: "webhook-deliver-failed", delivery_id: row.id, error: String(e) }),
        );
        return false;
      }),
    ),
  );

/** Rows the sweep has never attempted despite being due — the outage signal. */
export const stuckDeliveryCount = (nowMs: number): Effect.Effect<number, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row = yield* db.queryFirst(
      `SELECT COUNT(*) AS n FROM webhookSubscriptionDeliveries
        WHERE attempted_at_ms IS NULL AND created_at_ms < ?`,
      [nowMs - STUCK_AFTER_MS],
    );
    const n = (row as { n?: unknown } | null)?.n;
    return typeof n === "number" ? n : 0;
  }).pipe(Effect.catchAll(() => Effect.succeed(0)));

/**
 * The delivery path. Claims up to SWEEP_BATCH due rows, oldest first, and
 * POSTs each.
 *
 * `ORDER BY next_retry_at_ms ASC` is anti-starvation, not incidental: under a
 * backlog a busy board would otherwise keep minting fresher rows that crowd
 * out an older pending delivery forever.
 */
export const sweepOutboundWebhooks = (
  nowMs: number,
  masterSecret: string | undefined,
): Effect.Effect<
  { attempted: number; delivered: number; denied: number; stuck: number },
  never,
  Db
> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const due = yield* db.queryAll<DeliveryRow>(
      `SELECT d.id, d.subscription_id, d.board_id, d.event_json, d.attempt_count,
              s.url, s.auth_scheme, s.hmac_secret_ciphertext, s.creator_pubkey
         FROM webhookSubscriptionDeliveries d
         JOIN webhookSubscriptions s ON s.id = d.subscription_id
        WHERE d.terminal = 0 AND d.next_retry_at_ms <= ?
        ORDER BY d.next_retry_at_ms ASC
        LIMIT ?`,
      [nowMs, SWEEP_BATCH],
    );

    // EFB-62 — the second half of the gate, and the half that closes the
    // window the first half cannot. The backoff ladder runs to twelve hours, so
    // a delivery queued while its subscriber was a member can come due long
    // after they were removed. Re-checking here is what makes revocation take
    // effect on the next tick rather than on the next event.
    //
    // Boards are loaded once per tick, not once per delivery: a busy board's
    // fifty due rows share one board read.
    const boards = new Map<string, BoardShape | null>();
    const boardOf = (boardId: string) =>
      Effect.gen(function* () {
        const cached = boards.get(boardId);
        if (cached !== undefined) return cached;
        const row = yield* db
          .queryFirst("SELECT * FROM boardCache WHERE id = ?", [boardId])
          .pipe(Effect.catchAll(() => Effect.succeed(null)));
        let board: BoardShape | null = null;
        if (row !== null) {
          try {
            board = parseBoardRow(row);
          } catch {
            board = null;
          }
        }
        boards.set(boardId, board);
        return board;
      });

    let delivered = 0;
    let denied = 0;
    for (const row of due) {
      const board = yield* boardOf(row.board_id);
      // A board that will not load is not evidence of a public board — the
      // same reading `publishesPlaintext` takes of its third state. Terminal
      // rather than skipped, because a skipped row never increments
      // attempt_count and would be retried until the end of time; a deleted
      // board's pending deliveries have to stop somewhere.
      const mayReceive =
        board === null ? false : yield* subscriberMayReceive(board, row.creator_pubkey);
      if (!mayReceive) {
        denied += 1;
        yield* db
          .execute(
            `UPDATE webhookSubscriptionDeliveries
                SET attempted_at_ms = ?, status_code = NULL,
                    response_body_snippet = ?, terminal = 1
              WHERE id = ?`,
            [nowMs, board === null ? "board_unavailable" : "membership_revoked", row.id],
          )
          .pipe(Effect.catchAll(() => Effect.void));
        continue;
      }
      if (yield* deliverOne(row, masterSecret, nowMs)) delivered += 1;
    }

    const stuck = yield* stuckDeliveryCount(nowMs);
    if (due.length > 0 || stuck > 0) {
      console.log(
        JSON.stringify({
          info: "webhook-sweep-complete",
          attempted: due.length,
          delivered,
          denied,
          stuck,
        }),
      );
    }
    return { attempted: due.length, delivered, denied, stuck };
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => {
        console.log(JSON.stringify({ warn: "webhook-sweep-failed", error: String(e) }));
        return { attempted: 0, delivered: 0, denied: 0, stuck: 0 };
      }),
    ),
  );
