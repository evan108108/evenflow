// EFB-24: mirror a public board's events to the 4a substrate in plaintext.
//
// The private half of this already exists — `secureBoardEvent` gift-wraps
// kinds 30555-30557 for boards whose audience is live. This is the public
// half: kinds 30550-30554, signed by Evenflow with EVENFLOW_KANBAN_SECRET and
// handed to the gateway, exactly as EFB-22 does for the 30560 tide.
//
// Evenflow signs rather than borrowing the caller's identity for the same
// reason the tide does: a public board event is Evenflow attesting to state
// anyone can already read over the API, not a user speaking. The caller's
// pubkey travels inside the content where it belongs.
//
// Everything here is best-effort. The D1 row is authoritative and already
// committed by the time we publish, so a gateway outage costs a substrate
// event and leaves substrate_event_id NULL — never a failed board mutation.

import { Effect } from "effect";
import { Audience, bestEffortAudience } from "../../effects/Audience";
import { Db, type DbError } from "../../effects";
import type { BoardEvent } from "../../durable-objects/BoardDO";
import type { BoardShape } from "../../shapes";
import { __signEvent } from "../audience/nip17";
import {
  buildKanbanBoard,
  buildKanbanComment,
  buildKanbanIssue,
  buildKanbanSprint,
  buildKanbanStatusChange,
  type EventTemplate,
} from "../audience/audience-events";

/** Gateway route that accepts a caller-signed 30550-30554 (4a: kanban-plaintext-route.ts). */
export const KANBAN_PLAINTEXT_PATH = "/v0/publish/kanban_plaintext";

/**
 * May this board's events go to the substrate in cleartext?
 *
 * THE ONLY correct gate, and deliberately not `!board.encryption_active`.
 * `encryption_active` is derived as `visibility === "private" && audience_pubkey
 * !== null` (shapes.ts), so its negation covers three states, not two:
 *
 *   1. genuinely public                          → publish
 *   2. private, audience never minted            → DO NOT publish
 *   3. board row could not be loaded             → DO NOT publish
 *
 * State 2 is not a corner case: boards are born private with no audience
 * (boards.ts) and only mint one on an explicit PATCH visibility=private, so
 * every newly created board sits there. Gating on `!encryption_active` would
 * push those boards' issue titles, bodies and comments to a public relay.
 * State 3 is an availability failure, not evidence of a public board.
 *
 * Both this module and the EFB-22 tide publisher gate through this one
 * function so the two can never drift apart.
 */
// Deliberately NOT a `board is BoardShape` type predicate. That would assert
// the false branch is not a BoardShape, which is untrue and cost real
// narrowing: a private board is a perfectly good BoardShape that simply may
// not publish. Callers needing the non-null narrowing check `board !== null`
// alongside this.
export const publishesPlaintext = (board: BoardShape | null): boolean =>
  board !== null && board.visibility === "public";

/**
 * The PRIMARY substrate event a board event becomes, or null when this family
 * has no plaintext kind yet.
 *
 * One board event may now produce more than one substrate event — see
 * `templatesFor`, which is what the publisher actually consumes. This function
 * remains the single-template mapping for the four families that have exactly
 * one, and is kept exported because the tests pin it directly.
 */
export const templateFor = (board: BoardShape, event: BoardEvent): EventTemplate | null => {
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  if (event.kind.startsWith("board.")) {
    const b = (payload["board"] as BoardShape | undefined) ?? board;
    return buildKanbanBoard({
      boardId: board.id,
      slug: b.slug,
      title: b.title,
      description: b.description,
      orgId: b.org_id,
      issuePrefix: b.issue_prefix,
      defaultSprintDays: b.default_sprint_days,
      doneWindowDays: b.done_window_days,
      columns: b.columns,
      labels: b.labels,
      memberPolicy: b.member_policy,
      archived: b.archived_at_ms !== null,
      deleted: event.kind === "board.deleted",
    });
  }

  if (event.kind.startsWith("issue.")) {
    // issue.deleted carries only the id — there is no row left to describe,
    // so the tombstone is published from the envelope alone.
    const issue = payload["issue"] as Record<string, unknown> | undefined;
    const issueId = event.issue_id;
    if (issueId === undefined) return null;
    if (issue === undefined) {
      return event.kind === "issue.deleted"
        ? buildKanbanIssue({
            issueId,
            boardId: board.id,
            title: "",
            bodyFormat: "markdown",
            type: "task",
            status: "",
            container: "backlog",
            labels: [],
            deleted: true,
          })
        : null;
    }
    return buildKanbanIssue({
      issueId,
      boardId: board.id,
      shortId: (issue["short_id"] as string | null) ?? null,
      title: (issue["title"] as string) ?? "",
      body: (issue["body"] as string | null) ?? null,
      bodyFormat: (issue["body_format"] as string) ?? "markdown",
      type: (issue["type"] as string) ?? "task",
      status: (issue["status"] as string) ?? "",
      columnId: (issue["column_id"] as string | null) ?? null,
      container: (issue["container"] as string) ?? "backlog",
      assigneePubkey: (issue["assignee_pubkey"] as string | null) ?? null,
      priority: (issue["priority"] as number | null) ?? null,
      estimate: (issue["estimate"] as number | null) ?? null,
      labels: (issue["labels"] as ReadonlyArray<string>) ?? [],
      position: (issue["position"] as number | null) ?? null,
      sprintId: (issue["sprint_id"] as string | null) ?? null,
      externalState: (issue["external_state"] as string | null) ?? null,
      deleted: event.kind === "issue.deleted",
    });
  }

  if (event.kind.startsWith("comment.")) {
    const commentId = event.comment_id;
    const issueId = event.issue_id;
    if (commentId === undefined || issueId === undefined) return null;
    // comment.deleted carries { comment_id, issue_id } only.
    const comment = payload["comment"] as Record<string, unknown> | undefined;
    return buildKanbanComment({
      commentId,
      issueId,
      boardId: board.id,
      authorPubkey: (comment?.["author_pubkey"] as string) ?? "",
      body: (comment?.["body"] as string) ?? "",
      bodyFormat: (comment?.["body_format"] as string) ?? "markdown",
      inReplyTo: (comment?.["in_reply_to"] as string | null) ?? null,
      deleted: event.kind === "comment.deleted",
    });
  }

  // sprint.tide.* is EFB-22's 30560 and publishes through its own path.
  if (event.kind.startsWith("sprint.") && !event.kind.startsWith("sprint.tide.")) {
    const sprint = payload["sprint"] as Record<string, unknown> | undefined;
    const sprintId = event.sprint_id;
    if (sprintId === undefined || sprint === undefined) return null;
    return buildKanbanSprint({
      sprintId,
      boardId: board.id,
      name: (sprint["name"] as string) ?? "",
      goal: (sprint["goal"] as string | null) ?? null,
      status: event.kind === "sprint.deleted" ? "deleted" : ((sprint["status"] as string) ?? ""),
      plannedDays: (sprint["planned_days"] as number | null) ?? null,
      startedAtMs: (sprint["started_at_ms"] as number | null) ?? null,
      completedAtMs: (sprint["completed_at_ms"] as number | null) ?? null,
      pointsCommittedStart: (sprint["points_committed_start"] as number | null) ?? null,
      pointsCompleted: (sprint["points_completed"] as number | null) ?? null,
      pointsCarried: (sprint["points_carried"] as number | null) ?? null,
      addsMidSprint: (sprint["adds_mid_sprint"] as number) ?? 0,
    });
  }

  return null;
};

/** Which cache row records where this event landed, if any. */
export const stampTargetOf = (
  event: BoardEvent,
): { readonly table: string; readonly id: string } | null => {
  if (event.kind.startsWith("board.")) return { table: "boardCache", id: event.board_id };
  if (event.kind.startsWith("issue.") && event.issue_id !== undefined) {
    return { table: "issueCache", id: event.issue_id };
  }
  if (event.kind.startsWith("comment.") && event.comment_id !== undefined) {
    return { table: "commentCache", id: event.comment_id };
  }
  if (
    event.kind.startsWith("sprint.") &&
    !event.kind.startsWith("sprint.tide.") &&
    event.sprint_id !== undefined
  ) {
    return { table: "sprintCache", id: event.sprint_id };
  }
  return null;
};

/** One substrate event to publish, paired with the row that records where it landed. */
export interface PublishItem {
  readonly template: EventTemplate;
  readonly stamp: { readonly table: string; readonly id: string } | null;
}

/**
 * Every substrate event a board event becomes, in publish order.
 *
 * EFB-24 mapped one board event to at most one template, and `stampTargetOf`
 * derives its target from the EVENT — a shape that structurally cannot express
 * two destinations. That held only because every family it served had exactly
 * one. EFB-33 is the N=2 case: a transition on a public board is BOTH the
 * issue's new state (30551, stamping issueCache) AND the change itself (30553,
 * stamping statusChangeCache). Pairing each template with its own stamp target
 * is what the domain actually looks like once a second one exists.
 *
 * The four shipped families return a single-element array here, built from the
 * same `templateFor` + `stampTargetOf` they already used, so their behavior is
 * unchanged by construction rather than by inspection — which is what lets the
 * existing kanban-publish tests keep covering them without modification.
 */
export const templatesFor = (
  board: BoardShape,
  event: BoardEvent,
): ReadonlyArray<PublishItem> => {
  const items: PublishItem[] = [];

  const primary = templateFor(board, event);
  if (primary !== null) items.push({ template: primary, stamp: stampTargetOf(event) });

  // The 30553 rides alongside the issue event rather than replacing it.
  // Absent status_change_id means no statusChangeCache row was appended —
  // a column-only transition, where the issue event carries the state and
  // there is no status change to describe. Nothing to publish, not a fault.
  if (event.kind === "issue.transitioned" || event.kind === "issue.container_changed") {
    const statusChangeId = event.status_change_id;
    const issueId = event.issue_id;
    if (statusChangeId !== undefined && issueId !== undefined) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      items.push({
        template: buildKanbanStatusChange({
          statusChangeId,
          issueId,
          boardId: board.id,
          // The actor is who performed the transition — NOT the issue's
          // assignee, who is usually somebody else. It is carried explicitly
          // on the payload because nothing in the issue row records it.
          actorPubkey: (payload["actor_pubkey"] as string | null) ?? "",
          fromStatus: (payload["from_status"] as string | null) ?? null,
          toStatus: (payload["to_status"] as string | null) ?? null,
          fromContainer: (payload["from_container"] as string | null) ?? null,
          toContainer: (payload["to_container"] as string | null) ?? null,
          occurredAtMs: event.at_ms,
        }),
        stamp: { table: "statusChangeCache", id: statusChangeId },
      });
    }
  }

  return items;
};

/**
 * Build, sign, publish and stamp. Never fails: every failure mode — no key
 * configured, unmapped event family, gateway down — leaves the cache row's
 * substrate_event_id NULL, which is exactly what that column means.
 *
 * The stamp is skipped for a deleted entity: the row is already gone (issue
 * and sprint deletes remove it), so the UPDATE would touch nothing. The
 * tombstone still goes to the substrate, which is the point.
 *
 * Returns the PRIMARY event's id (EFB-33), so callers that recorded one id
 * before the fan-out keep seeing the same value. Additional events are
 * published and stamped, never returned — a caller wanting the 30553's id
 * should read substrate_event_id off the statusChangeCache row.
 */
export const publishPlaintextEvent = (
  board: BoardShape,
  event: BoardEvent,
): Effect.Effect<string | null, DbError, Db | Audience> =>
  Effect.gen(function* () {
    const items = templatesFor(board, event);
    if (items.length === 0) return null;

    const audience = yield* Audience;
    const keys = audience.kanbanKeys();
    if (keys === null) {
      console.log(
        JSON.stringify({
          warn: "kanban-publish-skipped",
          reason: "no-kanban-key",
          board_id: board.id,
          kind: event.kind,
        }),
      );
      return null;
    }

    let primaryId: string | null = null;
    for (const [index, item] of items.entries()) {
      const signed = __signEvent({ ...item.template, pubkey: keys.pubkeyHex }, keys.privkey);
      const posted = yield* bestEffortAudience(
        `kanban:${event.kind}:${board.id}:${item.template.kind}`,
        audience.rawPost(KANBAN_PLAINTEXT_PATH, { event: signed }, keys.privkey),
      );
      // Best-effort per item, deliberately: a gateway failure on the 30553
      // must not un-publish the 30551 that already landed. Each row's
      // substrate_event_id independently records whether its own event made it.
      if (posted === null) continue;

      if (item.stamp !== null && !event.kind.endsWith(".deleted")) {
        const db = yield* Db;
        yield* db.execute(`UPDATE ${item.stamp.table} SET substrate_event_id = ? WHERE id = ?`, [
          signed.id,
          item.stamp.id,
        ]);
      }
      if (index === 0) primaryId = signed.id;
    }
    return primaryId;
  });
