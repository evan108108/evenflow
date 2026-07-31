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
//   public → kind 30560, built and signed HERE with EVENFLOW_KANBAN_SECRET,
//     then POSTed NIP-98-authed to the gateway's /v0/publish/kanban_tide,
//     which validates and fans out. Evenflow signs rather than borrowing a
//     caller's identity because there is no caller — the cron has no request
//     and a public board's GET /tide is anonymous — and because a public tide
//     is Evenflow attesting to a number anyone can re-derive, not a user
//     speaking.
//
// Either way the D1 snapshot is written first and the publish is best-effort.
// A failed publish costs a substrate event, never a reading: every day is
// recomputable from the audit rows.

import { Effect } from "effect";
import { Audience, bestEffortAudience } from "../../effects/Audience";
import { BoardEmitter, Db, type DbError } from "../../effects";
import { emitSecureBoardEvent, loadBoardById } from "../../audiences";
import { __signEvent } from "../audience/nip17";
import { buildSprintTide } from "../audience/audience-events";
import { publishesPlaintext } from "../kanban/publish";
import { stampSubstrateEventId, type TideSubject } from "./snapshot";
import type { TideDay } from "./compute";

/** Gateway route that accepts a caller-signed 30560 (4a: kanban-tide-route.ts). */
export const KANBAN_TIDE_PATH = "/v0/publish/kanban_tide";

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
    // EFB-24 fix: this used to read `board === null || board.encryption_active`,
    // which published a cleartext 30560 for a board that is private but has
    // never minted an audience — the state every board is born into. Those
    // boards' committed/done/remaining points were going to a public relay.
    // Shares the predicate with the plaintext kanban publisher so the two
    // gates cannot drift.
    if (!publishesPlaintext(board)) {
      if (board !== null) {
        console.log(
          JSON.stringify({
            warn: "tide-publish-deferred",
            // Distinguishes the two private cases now that both land here:
            // an encrypted board whose wraps failed, versus a board that is
            // private with no audience yet (nothing was ever going to wrap).
            reason: board.encryption_active ? "private-wraps-failed" : "private-no-audience",
            board_id: subject.board_id,
            day: reading.day,
          }),
        );
      }
      return null;
    }

    // Genuinely public: sign a 30560 as Evenflow and hand it to the gateway.
    const publicId = yield* publishPublicTide(subject, reading);
    if (publicId === null) return null;
    yield* stampSubstrateEventId(input.snapshot_id, publicId);
    return publicId;
  });

/**
 * Build, sign and publish the public 30560.
 *
 * The event id is known the moment we sign — the gateway echoes it back but
 * we never need to parse a response for it, which is why `rawPost` returning
 * void is enough.
 *
 * Best-effort in every failure mode (no key configured, gateway down, relays
 * refusing): the snapshot is already in D1 and readings are recomputed from
 * audit rows regardless, so a failure costs a substrate event and leaves
 * `substrate_event_id` NULL for the sweep that index was built for.
 */
const publishPublicTide = (
  subject: TideSubject,
  reading: TideDay,
): Effect.Effect<string | null, never, Audience> =>
  Effect.gen(function* () {
    const audience = yield* Audience;
    const keys = audience.kanbanKeys();
    if (keys === null) {
      console.log(
        JSON.stringify({
          warn: "tide-publish-skipped",
          reason: "no-kanban-key",
          board_id: subject.board_id,
          day: reading.day,
        }),
      );
      return null;
    }

    const template = buildSprintTide({
      boardId: subject.board_id,
      ...(subject.sprint_id === null ? {} : { sprintId: subject.sprint_id }),
      day: reading.day,
      committedPts: reading.committed_pts,
      donePts: reading.done_pts,
      remainingPts: reading.remaining_pts,
      addsToday: reading.adds_today,
      dropsToday: reading.drops_today,
    });
    const signed = __signEvent(
      { ...template, pubkey: keys.pubkeyHex },
      keys.privkey,
    );

    const posted = yield* bestEffortAudience(
      `kanban-tide:${subject.board_id}:${reading.day}`,
      audience.rawPost(KANBAN_TIDE_PATH, { event: signed }, keys.privkey),
    );
    return posted === null ? null : signed.id;
  });
