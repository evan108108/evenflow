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
import { BoardEmitter, Db, type DbError } from "../../effects";
import { emitSecureBoardEvent } from "../../audiences";
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

/**
 * Why public 30560 isn't published yet, in one place so the reason travels
 * with the code rather than living in a DM.
 *
 * Every existing `FourA` publish rides the CALLER's JWT (`membership.ts`,
 * `routes/orgs.ts`, `routes/profile.ts` all pull it off the Authorization
 * header). Tide has no caller to borrow from in either of the paths that
 * matter: `GET /tide` is anonymous on a public board, and the daily cron has
 * no request at all. So option A needs a service credential the gateway will
 * accept from evenflow itself — an open design question, not a TODO.
 */
export const publicTidePublishBlocked = "gateway-endpoint-and-service-auth-pending" as const;

export interface PublishTideInput {
  readonly subject: TideSubject;
  readonly snapshot_id: string;
  readonly reading: TideDay;
  readonly at_ms: number;
}

/**
 * Publish one reading and stamp the snapshot if it landed. Returns the
 * substrate event id, or null when nothing was published — an outage, a
 * board with no key material, or a public board (pending the gateway work).
 */
export const publishTide = (
  input: PublishTideInput,
): Effect.Effect<string | null, DbError, Db | Audience | BoardEmitter> =>
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
    if (eventId === null) return null;
    yield* stampSubstrateEventId(input.snapshot_id, eventId);
    return eventId;
  });
