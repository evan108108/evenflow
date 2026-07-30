// EFB-22: publish a closed day's tide reading to the 4a substrate.
//
// Two doors, picked by the board — the same fork every other board write
// takes, kept explicit rather than hidden inside one helper:
//
//   private → kind 30565, gift-wrapped per member, signed locally with the
//     board's aud_id key. Goes through `emitSecureBoardEvent`, which also
//     fans the SSE envelope out. Needs no caller identity: the signing key
//     comes from D1, sealed under EVENFLOW_AUDIENCE_SECRET.
//
//   public → kind 30560, KMS-signed at the gateway (option A). NOT WIRED
//     YET — see `publicTidePublishBlocked` below; the endpoint doesn't exist
//     and the auth story has an open question. Public boards currently get
//     the SSE fan-out and a D1 row with a NULL substrate_event_id, which the
//     unpublished index is already shaped to sweep up later.
//
// Either way the D1 snapshot is written first and the publish is best-effort.
// A failed publish costs a substrate event, never a reading: every day is
// recomputable from the audit rows.

import { Effect } from "effect";
import { Audience } from "../../effects/Audience";
import { BoardEmitter, Db, FourA, type DbError } from "../../effects";
import { emitSecureBoardEvent, loadBoardById } from "../../audiences";
import { stampSubstrateEventId, type TideSubject } from "./snapshot";
import type { TideDay } from "./compute";

/** SSE + substrate event kind for a rolled-forward tide reading. */
export const TIDE_EVENT_KIND = "sprint.tide.updated" as const;

/**
 * The substrate `d`-tag entity for a reading. The day MUST be in here: 30560
 * and 30565 are parameterized-replaceable, so keying on the sprint alone
 * would make each day's event overwrite the last and leave the sparkline
 * with a single bar.
 */
export const tideEntityId = (subject: TideSubject, day: string): string =>
  subject.sprint_id === null ? day : `${subject.sprint_id}:${day}`;

export interface PublishTideInput {
  readonly subject: TideSubject;
  readonly snapshot_id: string;
  readonly reading: TideDay;
  readonly at_ms: number;
  /**
   * EVENFLOW_TIDE_SERVICE_JWT, passed in rather than read from AppEnv:
   * `bootstrap` consumes AppEnv to build the service layer, so it isn't
   * available to yield* downstream. Callers already hold the Worker env —
   * routes as `c.env`, the cron as its own `env` argument. Undefined means
   * public boards cache without publishing.
   */
  readonly service_jwt: string | undefined;
}

/**
 * Publish one reading and stamp the snapshot if it landed. Returns the
 * substrate event id, or null when nothing was published — an outage, a
 * board with no key material, or a public board (pending the gateway work).
 */
export const publishTide = (
  input: PublishTideInput,
): Effect.Effect<string | null, DbError, Db | Audience | BoardEmitter | FourA> =>
  Effect.gen(function* () {
    const { subject, reading } = input;
    const eventId = yield* emitSecureBoardEvent(subject.board_id, {
      kind: TIDE_EVENT_KIND,
      board_id: subject.board_id,
      ...(subject.sprint_id === null ? {} : { sprint_id: subject.sprint_id }),
      entity_id: tideEntityId(subject, reading.day),
      at_ms: input.at_ms,
      payload: {
        day: reading.day,
        committed_pts: reading.committed_pts,
        done_pts: reading.done_pts,
        remaining_pts: reading.remaining_pts,
        adds_today: reading.adds_today,
        drops_today: reading.drops_today,
      },
    });
    // A private board is done here: emitSecureBoardEvent already gift-wrapped
    // and published the 30565, and gave us its rumor id.
    if (eventId !== null) {
      yield* stampSubstrateEventId(input.snapshot_id, eventId);
      return eventId;
    }

    // A null id does NOT mean "public" — it also means "private board whose
    // wraps didn't land". Publishing 30560 on that inference would push a
    // private board's committed/done/remaining points to the substrate in
    // CLEARTEXT the first time the audience gateway hiccupped. So re-read the
    // board and fork on what it actually is, failing closed: if the row can't
    // be loaded at all, publish nothing.
    const board = yield* loadBoardById(subject.board_id).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    );
    if (board === null || board.encryption_active) {
      if (board !== null) {
        console.log(
          JSON.stringify({
            warn: "tide-publish-deferred",
            reason: "private-wraps-failed",
            board_id: subject.board_id,
            day: reading.day,
          }),
        );
      }
      return null;
    }

    // Genuinely public. 30560 goes through the gateway, which signs as the
    // evenflow service identity — there is no caller here to sign as.
    const publicId = yield* publishPublicTide(subject, reading, input.service_jwt);
    if (publicId === null) return null;
    yield* stampSubstrateEventId(input.snapshot_id, publicId);
    return publicId;
  });

/**
 * Publish the public 30560 through the gateway. Best-effort in every failure
 * mode — no credential configured, gateway down, malformed response — because
 * the snapshot is already in D1 and the reading is recomputed from audit rows
 * regardless. A failure costs a substrate event and leaves
 * `substrate_event_id` NULL for the sweep that index was built for.
 */
const publishPublicTide = (
  subject: TideSubject,
  reading: TideDay,
  token: string | undefined,
): Effect.Effect<string | null, never, FourA> =>
  Effect.gen(function* () {
    if (token === undefined || token === "") {
      console.log(
        JSON.stringify({ warn: "tide-publish-skipped", reason: "no-service-jwt", day: reading.day }),
      );
      return null;
    }
    const fourA = yield* FourA;
    return yield* fourA
      .publishKanbanTide(token, {
        boardId: subject.board_id,
        ...(subject.sprint_id === null ? {} : { sprintId: subject.sprint_id }),
        day: reading.day,
        committedPts: reading.committed_pts,
        donePts: reading.done_pts,
        remainingPts: reading.remaining_pts,
        addsToday: reading.adds_today,
        dropsToday: reading.drops_today,
      })
      .pipe(
        Effect.map((r) => r.event_id),
        Effect.catchAll((e) =>
          Effect.sync(() => {
            console.log(
              JSON.stringify({
                warn: "tide-publish-deferred",
                board_id: subject.board_id,
                day: reading.day,
                reason: e.reason,
                status: e.status ?? null,
              }),
            );
            return null;
          }),
        ),
      );
  });
