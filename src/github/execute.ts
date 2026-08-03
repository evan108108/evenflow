// Apply an EvaluationPlan to the database.
//
// Every write here mirrors the equivalent hand-driven path in
// routes/issues.ts — status changes write statusChangeCache so the activity
// feed and velocity stay correct, container moves do the same. A webhook
// that mutated issueCache directly would produce cards whose history has a
// hole exactly where the automation ran.
//
// Attribution: the actor is `github:<login>` (falling back to
// `github:webhook` when the payload carries no author), so every row this
// writes is distinguishable from a human's action in the feed.

import { Clock, Effect } from "effect";
import { Db, type DbError } from "../effects";
import type { Column } from "../columns";
import { columnById } from "../columns";
import { topOfColumnPosition, topOfContainerPosition } from "../lib/position";
import { insertStatusChange } from "../lib/status-change";
import type { EvaluationPlan, PlannedEffect } from "./engine";

export const WEBHOOK_ACTOR_FALLBACK = "github:webhook";

export interface AppliedAction {
  readonly issue_id: string;
  readonly short_id: string;
  readonly kind: string;
  readonly detail: string | null;
  /** False when the effect was planned but deliberately not performed. */
  readonly applied: boolean;
  /**
   * EFB-66 — what the route needs to emit a BoardEvent for this action.
   *
   * Present only on the two transition kinds (`set_column`, `set_container`);
   * absent everywhere else, which is what the route filters on. The id is the
   * statusChangeCache row EFB-56's helper returned: the 30553's `d` tag IS that
   * row id, so an action that reaches the route without it cannot be published,
   * which was the whole pre-EFB-56 defect.
   *
   * The from/to pairs are carried rather than re-derived at the route because
   * `input.statusByIssue` holds the state as it was BEFORE this webhook's
   * effects ran. Re-reading at the route would report the post-update value as
   * the "from", producing an audit row that says an issue moved from where it
   * now is to where it now is.
   */
  readonly statusChangeId?: string;
  readonly fromStatus?: string | null;
  readonly toStatus?: string | null;
  readonly fromContainer?: string | null;
  readonly toContainer?: string | null;
}

interface ExecuteInput {
  readonly plan: EvaluationPlan;
  readonly boardId: string;
  readonly columns: ReadonlyArray<Column>;
  readonly actor: string;
  /** Existing github_links per issue id, so we merge rather than clobber. */
  readonly linksByIssue: ReadonlyMap<string, ReadonlyArray<{ repo: string; pr: number; state: string }>>;
  readonly labelsByIssue: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly statusByIssue: ReadonlyMap<string, { status: string; container: string }>;
}

// insertStatusChange moved to src/lib/status-change.ts (EFB-56).
//
// The version that lived here took nine positional arguments and DISCARDED the
// generated row id. That single difference from the issues.ts copy is why
// github-driven transitions never appeared on the substrate: the 30553 keys on
// the statusChangeCache row id, so a discarded id left nothing to publish
// against. This path was not un-wired — it was still running the bug EFB-33
// fixed everywhere else. The shared helper returns the id; the callers below
// now keep it.

const applyEffect = (
  effect: PlannedEffect,
  issueId: string,
  shortId: string,
  input: ExecuteInput,
): Effect.Effect<AppliedAction, DbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const now = yield* Clock.currentTimeMillis;
    const done = (kind: string, detail: string | null, applied = true): AppliedAction => ({
      issue_id: issueId,
      short_id: shortId,
      kind,
      detail,
      applied,
    });

    switch (effect.kind) {
      case "skipped":
        return done("skipped", effect.reason, false);

      case "no_op":
        return done("no_op", effect.note, true);

      case "set_external_state": {
        yield* db.execute(
          "UPDATE issueCache SET external_state = ?, external_state_updated_at_ms = ?, updated_at_ms = ? WHERE id = ?",
          [effect.value, now, now, issueId],
        );
        return done("set_external_state", effect.value);
      }

      case "set_column": {
        const target = columnById(input.columns, effect.column_id);
        const prev = input.statusByIssue.get(issueId);
        const toDone = target?.category === "done";
        // completed_at_ms follows the done-category edge, same rule as
        // routes/issues.ts nextCompletedAt: stamped on arrival (kept if
        // already set), cleared on exit.
        // EFB-78: land at the top of the target column, same rule as the API
        // transition path. This is the case the ticket was filed for — a merged
        // PR auto-moves to Done, and Done is only a useful "what just shipped"
        // feed if the arrival is at the top.
        const position = yield* topOfColumnPosition({
          boardId: input.boardId,
          columnId: effect.column_id,
          issueId,
        });
        if (toDone) {
          yield* db.execute(
            "UPDATE issueCache SET status = ?, column_id = ?, position = ?, updated_at_ms = ?, completed_at_ms = COALESCE(completed_at_ms, ?) WHERE id = ?",
            [effect.column_name, effect.column_id, position, now, now, issueId],
          );
        } else {
          yield* db.execute(
            "UPDATE issueCache SET status = ?, column_id = ?, position = ?, updated_at_ms = ?, completed_at_ms = NULL WHERE id = ?",
            [effect.column_name, effect.column_id, position, now, issueId],
          );
        }
        const statusChangeId = yield* insertStatusChange({
          issue_id: issueId,
          board_id: input.boardId,
          actor_pubkey: input.actor,
          from_status: prev?.status ?? null,
          to_status: effect.column_name,
          from_container: null,
          to_container: null,
          container_at_completion: toDone ? (prev?.container ?? null) : null,
          occurred_at_ms: now,
        });
        // EFB-66: kept, not discarded. The route turns this into an
        // issue.transitioned whose 30553 keys on exactly this row.
        return {
          ...done("set_column", effect.column_name),
          statusChangeId,
          fromStatus: prev?.status ?? null,
          toStatus: effect.column_name,
        };
      }

      case "set_container": {
        const prev = input.statusByIssue.get(issueId);
        // EFB-78: container twin of the branch above.
        const position = yield* topOfContainerPosition({
          boardId: input.boardId,
          container: effect.container,
          issueId,
        });
        yield* db.execute(
          "UPDATE issueCache SET container = ?, position = ?, updated_at_ms = ? WHERE id = ?",
          [effect.container, position, now, issueId],
        );
        const statusChangeId = yield* insertStatusChange({
          issue_id: issueId,
          board_id: input.boardId,
          actor_pubkey: input.actor,
          from_status: null,
          to_status: null,
          from_container: prev?.container ?? null,
          to_container: effect.container,
          container_at_completion: null,
          occurred_at_ms: now,
        });
        // EFB-66: the container twin of the branch above. Emitting only the
        // status kind would leave every github-driven container move as
        // invisible and unpublished as both were before this ticket.
        return {
          ...done("set_container", effect.container),
          statusChangeId,
          fromContainer: prev?.container ?? null,
          toContainer: effect.container,
        };
      }

      case "add_comment": {
        yield* db.execute(
          "INSERT INTO commentCache (id, issue_id, author_pubkey, body, body_format, in_reply_to, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [crypto.randomUUID(), issueId, input.actor, effect.body, "markdown", null, now],
        );
        const warn =
          effect.unknown_paths.length === 0
            ? null
            : `unknown-paths:${effect.unknown_paths.join(",")}`;
        return done("add_comment", warn);
      }

      case "assign": {
        yield* db.execute(
          "UPDATE issueCache SET assignee_pubkey = ?, updated_at_ms = ? WHERE id = ?",
          [effect.pubkey, now, issueId],
        );
        return done("assign", effect.pubkey);
      }

      case "add_label": {
        const existing = input.labelsByIssue.get(issueId) ?? [];
        const next = [...existing, effect.label];
        yield* db.execute("UPDATE issueCache SET labels = ?, updated_at_ms = ? WHERE id = ?", [
          JSON.stringify(next),
          now,
          issueId,
        ]);
        return done("add_label", effect.label);
      }

      case "record_pr_link": {
        const existing = input.linksByIssue.get(issueId) ?? [];
        // Upsert by (repo, pr): a PR that goes open → merged updates its
        // entry rather than accumulating one row per delivery.
        const others = existing.filter((l) => !(l.repo === effect.repo && l.pr === effect.pr));
        const next = [...others, { repo: effect.repo, pr: effect.pr, state: effect.state }];
        yield* db.execute(
          "UPDATE issueCache SET github_links = ?, updated_at_ms = ? WHERE id = ?",
          [JSON.stringify(next), now, issueId],
        );
        return done("record_pr_link", `${effect.repo}#${effect.pr}:${effect.state}`);
      }
    }
  });

/**
 * Run every planned effect, in order, per matched issue. Returns the
 * applied-action list that lands in the audit row.
 */
export const executePlan = (
  input: ExecuteInput,
): Effect.Effect<ReadonlyArray<AppliedAction>, DbError, Db> =>
  Effect.gen(function* () {
    const applied: AppliedAction[] = [];
    for (const outcome of input.plan.outcomes) {
      // no_match-bucket outcomes carry no issue; their action is recorded
      // in the audit row but has nothing to write against.
      if (outcome.issue_id === "") {
        for (const e of outcome.effects) {
          applied.push({
            issue_id: "",
            short_id: "",
            kind: e.kind,
            detail: "no-ticket-bucket",
            applied: false,
          });
        }
        continue;
      }
      for (const effect of outcome.effects) {
        applied.push(yield* applyEffect(effect, outcome.issue_id, outcome.short_id, input));
      }
    }
    return applied;
  });
