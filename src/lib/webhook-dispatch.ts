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
import type { BoardShape } from "../shapes";
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
}

export interface DeliveryRow {
  readonly id: string;
  readonly subscription_id: string;
  readonly event_json: string;
  readonly attempt_count: number;
  readonly url: string;
  readonly auth_scheme: string;
  readonly hmac_secret_ciphertext: string;
}

/**
 * Does this subscription want this event?
 *
 * Pure and total: a row whose `event_kinds` or `predicate` is unparseable JSON
 * matches NOTHING rather than throwing. A corrupt subscription costs its owner
 * their notifications; it must never take down the emit path for the board.
 */
export const matchesSubscription = (sub: SubscriptionRow, event: BoardEvent): boolean => {
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

  // v1 grammar is exactly one field: {"assignee": "<canonical ref>"}. The
  // payload is `unknown` by contract (board-events.ts), so this reads
  // defensively rather than casting — and a private board never reaches here
  // at all, since subscriptions cannot be registered on one.
  const wanted = (predicate as Record<string, unknown>)["assignee"];
  if (typeof wanted !== "string") return false;
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return false;
  return (payload as Record<string, unknown>)["assignee_pubkey"] === wanted;
};

/**
 * Queue every matching subscription's delivery for `event`.
 *
 * Returns the number of rows enqueued. NEVER fails: the caller is the emit
 * path, and a webhook bookkeeping problem must not turn a successful board
 * mutation into an error. Failures are logged and swallowed.
 *
 * Private boards are skipped wholesale. The route refuses to create
 * subscriptions on them, so this is defence in depth for a board that was
 * flipped private AFTER subscriptions existed — in which case the right
 * behaviour is to stop delivering, silently, rather than to start leaking the
 * cleartext envelope (kind, issue_id, timing) that a private board's event
 * still carries.
 */
export const enqueueOutboundWebhooks = (
  board: BoardShape,
  event: BoardEvent,
  nowMs: number,
): Effect.Effect<number, never, Db> =>
  Effect.gen(function* () {
    if (board.encryption_active) return 0;

    const db = yield* Db;
    const subs = yield* db.queryAll<SubscriptionRow>(
      `SELECT id, board_id, url, event_kinds, predicate, auth_scheme, hmac_secret_ciphertext
         FROM webhookSubscriptions
        WHERE board_id = ? AND enabled = 1`,
      [board.id],
    );

    const matching = subs.filter((s) => matchesSubscription(s, event));
    if (matching.length === 0) return 0;

    const eventJson = JSON.stringify(event);
    for (const sub of matching) {
      yield* db.execute(
        `INSERT INTO webhookSubscriptionDeliveries
           (id, subscription_id, board_id, event_kind, event_json,
            created_at_ms, attempt_count, next_retry_at_ms, terminal)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0)`,
        [crypto.randomUUID(), sub.id, board.id, event.kind, eventJson, nowMs, nowMs],
      );
    }
    return matching.length;
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
): Effect.Effect<{ attempted: number; delivered: number; stuck: number }, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const due = yield* db.queryAll<DeliveryRow>(
      `SELECT d.id, d.subscription_id, d.event_json, d.attempt_count,
              s.url, s.auth_scheme, s.hmac_secret_ciphertext
         FROM webhookSubscriptionDeliveries d
         JOIN webhookSubscriptions s ON s.id = d.subscription_id
        WHERE d.terminal = 0 AND d.next_retry_at_ms <= ?
        ORDER BY d.next_retry_at_ms ASC
        LIMIT ?`,
      [nowMs, SWEEP_BATCH],
    );

    let delivered = 0;
    for (const row of due) {
      if (yield* deliverOne(row, masterSecret, nowMs)) delivered += 1;
    }

    const stuck = yield* stuckDeliveryCount(nowMs);
    if (due.length > 0 || stuck > 0) {
      console.log(
        JSON.stringify({
          info: "webhook-sweep-complete",
          attempted: due.length,
          delivered,
          stuck,
        }),
      );
    }
    return { attempted: due.length, delivered, stuck };
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => {
        console.log(JSON.stringify({ warn: "webhook-sweep-failed", error: String(e) }));
        return { attempted: 0, delivered: 0, stuck: 0 };
      }),
    ),
  );
