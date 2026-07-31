// The canonical BoardEvent vocabulary — the wire contract between the Worker
// and every SSE consumer.
//
// This file is deliberately DEPENDENCY-FREE: no imports, no Cloudflare
// globals, nothing that ties it to the Worker runtime. That is what lets the
// web app type-import it across the tsconfig boundary (web/tsconfig.json is a
// separate program that has no @cloudflare/workers-types), so the client-side
// mirror in web/src/effects/SseStream.ts can be asserted equal to this union
// at compile time instead of drifting silently. Keep it that way — a single
// runtime import here (BoardDO.ts's DurableObjectState was the original
// offender) re-breaks the web typecheck. See EFB-34.
//
// EFB-24 added the board.* and sprint.* families. Before that, renaming a
// board or starting a sprint reached no SSE client at all — those mutations
// emitted nothing, so a connected board sat on stale settings and a stale
// sprint header until the user reloaded. They also gave the substrate
// publisher nothing to hang kinds 30550 and 30554 on.
//
// board.deleted (EFB-32) was deferred out of EFB-24 because emitting it
// naively publishes nothing: emitSecureBoardEvent re-reads the board to decide
// whether it may publish, and for THIS kind alone the row it re-reads is the
// row being deleted, so the read fails closed. issue.deleted and comment.deleted
// emit after their own D1 delete and are fine — the board they re-read is still
// there. The fix is to stop re-reading rather than to reorder: the delete
// handler hands emitSecureBoardEvent the board snapshot it already holds.
export type BoardEventKind =
  | "issue.created"
  | "issue.updated"
  | "issue.transitioned"
  | "issue.container_changed"
  | "issue.deleted"
  | "comment.created"
  | "comment.deleted"
  | "board.created"
  | "board.updated"
  | "board.deleted"
  | "sprint.created"
  | "sprint.updated"
  | "sprint.started"
  | "sprint.completed"
  | "sprint.deleted"
  | "sprint.tide.updated"
  // EFB-15. AGGREGATE: one event per CSV import, not one per issue. A 1000-row
  // import emitting 1000 issue.created would enqueue 1000 webhook delivery rows
  // per subscriber against a sweep that drains 50 a minute, and storm every
  // open board tab, to describe what was a SINGLE user action.
  //
  // PLURAL, and outside all four families, on purpose — `templateFor` in
  // lib/kanban/publish.ts dispatches on kind PREFIX, so `board.issues_imported`
  // would fall into the board family and publish a 30550 KanbanBoard claiming
  // the board itself changed. There is an explicit guard there too; the name is
  // not doing that job alone. If you add a kind here, check that dispatch.
  //
  // Payload is a summary ({ import_id, count, created, skipped, unassigned });
  // consumers wanting per-issue detail refetch from `at_ms`.
  | "issues.imported";

export interface BoardEvent {
  readonly kind: BoardEventKind;
  readonly board_id: string;
  readonly issue_id?: string;
  readonly comment_id?: string;
  /**
   * Set on sprint-scoped events so a client can tell whether the update
   * concerns the sprint it is displaying. Lives at the top level rather than
   * inside `payload` because a private board's payload arrives encrypted —
   * the envelope is all an un-granted client can read.
   */
  readonly sprint_id?: string;
  /**
   * Overrides the substrate `d`-tag entity for this event. Only set it when
   * the natural entity is not an issue or comment: the tide events key on
   * (subject, day), so they pass `<sprint_id>:<day>` here. Absent, the
   * encrypted path falls back to issue_id → comment_id → board_id.
   */
  readonly entity_id?: string;
  /**
   * The `statusChangeCache` row this event appended, when it appended one
   * (EFB-33). It is what the 30553 KanbanStatusChange keys on — the row id is
   * that event's `d` tag — so without it there is nothing to sign against,
   * which is exactly why EFB-24 shipped four of five kinds.
   *
   * ABSENT IS A NORMAL STATE, not a missing field. A transition that changes
   * only the column IDENTITY and not the status NAME writes no audit row: the
   * issue event still carries the new state, there is simply no status change
   * to describe. Treat absence as "nothing to publish", never as a fault.
   *
   * Top level rather than inside `payload` for the same reason as sprint_id:
   * a private board's payload arrives encrypted, and the envelope is all an
   * un-granted client can read.
   */
  readonly status_change_id?: string;
  readonly at_ms: number;
  readonly payload: unknown;
}
