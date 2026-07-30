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
import type { EvaluationPlan, PlannedEffect } from "./engine";

export const WEBHOOK_ACTOR_FALLBACK = "github:webhook";

export interface AppliedAction {
  readonly issue_id: string;
  readonly short_id: string;
  readonly kind: string;
  readonly detail: string | null;
  /** False when the effect was planned but deliberately not performed. */
  readonly applied: boolean;
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

const insertStatusChange = (
  issueId: string,
  boardId: string,
  actor: string,
  fromStatus: string | null,
  toStatus: string | null,
  fromContainer: string | null,
  toContainer: string | null,
  containerAtCompletion: string | null,
  now: number,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.execute(
      "INSERT INTO statusChangeCache (id, issue_id, board_id, actor_pubkey, from_status, to_status, from_container, to_container, container_at_completion, occurred_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        crypto.randomUUID(),
        issueId,
        boardId,
        actor,
        fromStatus,
        toStatus,
        fromContainer,
        toContainer,
        containerAtCompletion,
        now,
      ],
    );
  });

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
        if (toDone) {
          yield* db.execute(
            "UPDATE issueCache SET status = ?, column_id = ?, updated_at_ms = ?, completed_at_ms = COALESCE(completed_at_ms, ?) WHERE id = ?",
            [effect.column_name, effect.column_id, now, now, issueId],
          );
        } else {
          yield* db.execute(
            "UPDATE issueCache SET status = ?, column_id = ?, updated_at_ms = ?, completed_at_ms = NULL WHERE id = ?",
            [effect.column_name, effect.column_id, now, issueId],
          );
        }
        yield* insertStatusChange(
          issueId,
          input.boardId,
          input.actor,
          prev?.status ?? null,
          effect.column_name,
          null,
          null,
          toDone ? (prev?.container ?? null) : null,
          now,
        );
        return done("set_column", effect.column_name);
      }

      case "set_container": {
        const prev = input.statusByIssue.get(issueId);
        yield* db.execute("UPDATE issueCache SET container = ?, updated_at_ms = ? WHERE id = ?", [
          effect.container,
          now,
          issueId,
        ]);
        yield* insertStatusChange(
          issueId,
          input.boardId,
          input.actor,
          null,
          null,
          prev?.container ?? null,
          effect.container,
          null,
          now,
        );
        return done("set_container", effect.container);
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
