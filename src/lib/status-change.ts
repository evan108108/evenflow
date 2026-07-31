// EFB-56 — the one writer of statusChangeCache.
//
// There used to be two. `src/routes/issues.ts` had a named-argument version
// that returned the new row's id; `src/github/execute.ts` had its own
// nine-positional-argument version that generated the id inline and threw it
// away. Same table, same columns, same order — one difference, and it was the
// one that mattered.
//
// That difference is EFB-56's actual root cause, and it is worth stating
// plainly because the ticket reads like a coverage gap and isn't. EFB-33's
// unlock was exactly "return the id": the 30553 KanbanStatusChange keys on the
// statusChangeCache row — the row id IS that event's `d` tag — so an id that is
// generated and discarded leaves the publish path with nothing to sign against.
// EFB-33 made that fix in issues.ts and never propagated it to execute.ts. So
// the github-driven path was not "not yet wired to publish"; it was still
// running the pre-EFB-33 bug, and no amount of downstream wiring could have
// published a 30553 that had no id to publish against.
//
// Hence one helper rather than two callsites taught to publish. A second
// implementation is what let the first fix miss half the codebase, and adding
// publish calls to both sites would have preserved exactly the structure that
// caused the problem. Consolidating here means the next change to how a status
// change is recorded cannot reach only half the callers.
//
// NAMED ARGUMENTS, deliberately, and not merely as a style preference. The
// signature this replaces was:
//
//   (issueId, boardId, actor, fromStatus, toStatus,
//    fromContainer, toContainer, containerAtCompletion, now)
//
// — four adjacent `string | null` parameters that transpose with no type
// error and no test failure. A from/to swap would write a backwards audit row
// and publish a backwards substrate event, silently. That is the EFB-33 bug
// class (a bare pubkey passed where a different bare pubkey was meant; both
// strings, nothing complained) living inside the very function this ticket
// consolidates. A struct makes the swap impossible to express.
//
// PUBLISH-AGNOSTIC on purpose: this returns the id and lets the caller decide
// whether to publish. `src/github/execute.ts` runs in a different Effect graph
// from the API routes, and publishing from in here would drag the publish layer
// into the github webhook's graph, coupling two subsystems that are currently
// independent.

import { Effect } from "effect";
import { Db } from "../effects";

/**
 * One status-change audit row.
 *
 * `from_*` are null for a creation (there is no previous state). `to_*` are
 * null for a deletion. Both null together is not a meaningful row, but that is
 * a caller-level question — this writer records what it is given.
 */
export interface StatusChangeWrite {
  readonly issue_id: string;
  readonly board_id: string;
  readonly actor_pubkey: string;
  readonly from_status: string | null;
  readonly to_status: string | null;
  readonly from_container: string | null;
  readonly to_container: string | null;
  readonly container_at_completion: string | null;
  readonly occurred_at_ms: number;
}

/**
 * Write the status-change audit row and RETURN ITS ID.
 *
 * The return value is load-bearing, not a convenience: callers thread it onto
 * the board event as `status_change_id`, and the publish path stamps
 * `statusChangeCache` with the substrate event id it gets back. A caller that
 * ignores the return value silently opts its path out of 30553 publishing —
 * which is precisely how the github path came to be missing from the substrate.
 */
export const insertStatusChange = (w: StatusChangeWrite): Effect.Effect<string, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const statusChangeId = crypto.randomUUID();
    yield* db.execute(
      "INSERT INTO statusChangeCache (id, issue_id, board_id, actor_pubkey, from_status, to_status, from_container, to_container, container_at_completion, occurred_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        statusChangeId,
        w.issue_id,
        w.board_id,
        w.actor_pubkey,
        w.from_status,
        w.to_status,
        w.from_container,
        w.to_container,
        w.container_at_completion,
        w.occurred_at_ms,
      ],
    );
    return statusChangeId;
  }) as Effect.Effect<string, never, Db>;
