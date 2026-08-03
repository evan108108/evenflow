// GitHub integration routes (phase 21).
//
// Two very different surfaces live here:
//
//   1. The INBOUND WEBHOOK — POST /api/v0/webhooks/github/:board_id. Public
//      by design; HMAC over the raw body is the only gate. It runs behind
//      optionalAuth (mounted under /api/v0) but never reads claims.
//
//   2. The BOARD CONFIG surface — connect/rotate/disconnect, rule CRUD, the
//      test panel, and the activity log. All admin-gated through
//      resolveBoardScope, same as every other board-settings route.
//
// The webhook answers 2xx for anything it has verified, INCLUDING deliveries
// that matched no ticket or no rule. GitHub retries non-2xx, and retrying a
// delivery whose only problem is "this PR mentions no ticket" would hammer
// us forever. Only signature failure and unreadable bodies are 4xx.

import { Hono } from "hono";
import { path, url } from "../routes-manifest";
import type { Context } from "hono";
import { Cause, Clock, Data, Effect, Exit, Option } from "effect";
import { Audience, AuditLog, BoardEmitter, Db, DbError, bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import {
  ForbiddenError,
  UnauthorizedError,
  callerPubkey,
  requireCaller,
  resolveBoardScope,
  type BoardOwnershipError,
} from "../authz";
import { parseBoardRow, parseIssueRow, type BoardShape } from "../shapes";
import { enabledColumns } from "../columns";
import {
  allowedExternalStates,
  externalStateConfigProblem,
  DEFAULT_EXTERNAL_STATES,
} from "../github/external-state";
import {
  mintWebhookSecret,
  openWebhookSecret,
  sealWebhookSecret,
  verifyGithubSignature,
} from "../github/secret";
import {
  MAX_RULES_PER_BOARD,
  RULE_BUCKETS,
  RULE_PRESETS,
  actionProblem,
  predicateProblem,
  presetRules,
  type Rule,
  type RuleBucket,
  type RulePreset,
} from "../github/rules";
import { evaluateDelivery, parseDelivery, type TargetIssue } from "../github/engine";
import { WEBHOOK_ACTOR_FALLBACK, executePlan, type AppliedAction } from "../github/execute";
import { emitSecureBoardEvent } from "../audiences";
import { ProvenanceFromStoredActor } from "../lib/route-body";

/**
 * EFB-66 — turn the transitions a webhook applied into BoardEvents.
 *
 * Before this, github-driven moves emitted nothing at all: connected clients
 * saw no change until a reload, and the 30553 substrate publish never fired
 * because it hangs off a board event that was never raised. Both close here.
 *
 * At the API layer rather than inside `execute.ts`, per EFB-56 — the executor
 * runs in a Db-only Effect graph, and emitting from in there would drag the
 * Audience and BoardEmitter services into the webhook's graph and couple two
 * subsystems that are currently independent. The same argument applies to the
 * read below, which is why it lives here too.
 *
 * The issue rows are re-read AFTER the executor has run, deliberately: the
 * payload must carry the issue's post-transition state, and `statusByIssue` on
 * the executor's input holds the pre-transition snapshot. One query for every
 * transition in the delivery rather than a read per effect.
 */
const TRANSITION_KINDS = new Set(["set_column", "set_container"]);

const emitTransitionEvents = (
  boardId: string,
  applied: ReadonlyArray<AppliedAction>,
  actor: string,
) =>
  Effect.gen(function* () {
    // A type predicate rather than a bare boolean so the `statusChangeId`
    // check narrows the element type. Without it the emit below would have to
    // re-handle an `undefined` this filter has already excluded — and the
    // usual way to silence that is a non-null assertion, which is the same
    // claim with the compiler's check removed.
    const transitions = applied.filter(
      (a): a is AppliedAction & { statusChangeId: string } =>
        a.applied && TRANSITION_KINDS.has(a.kind) && a.statusChangeId !== undefined,
    );
    if (transitions.length === 0) return;

    const db = yield* Db;
    const ids = [...new Set(transitions.map((t) => t.issue_id))];
    const rows = yield* db.queryAll(
      `SELECT * FROM issueCache WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids,
    );
    const issues = new Map<string, ReturnType<typeof parseIssueRow>>();
    for (const row of rows) {
      const issue = parseIssueRow(row);
      issues.set(issue.id, issue);
    }

    const now = yield* Clock.currentTimeMillis;
    for (const t of transitions) {
      const issue = issues.get(t.issue_id);
      // Emit per surviving issue rather than all-or-none. These are independent
      // facts about different issues, and suppressing issue B's event because
      // issue A was deleted mid-delivery would couple them for no gain — the
      // same per-item independence `publishPlaintextEvent` keeps between the
      // 30551 and the 30553. A missing row means the issue was deleted between
      // the update and this read; there is no state left to describe, so the
      // event is dropped and said out loud rather than emitted hollow.
      if (issue === undefined) {
        console.log(
          JSON.stringify({
            warn: "github-emit-skipped",
            reason: "issue-row-missing",
            board_id: boardId,
            issue_id: t.issue_id,
            kind: t.kind,
          }),
        );
        continue;
      }
      const isColumn = t.kind === "set_column";
      yield* emitSecureBoardEvent(
        boardId,
        {
          kind: isColumn ? "issue.transitioned" : "issue.container_changed",
          board_id: boardId,
          issue_id: t.issue_id,
          at_ms: now,
          status_change_id: t.statusChangeId,
          payload: {
            issue,
            // Same reason the UI path carries it: nothing on the issue row records
            // WHO moved the card, and the 30553 attributes the change. Kept for
            // SSE consumers; the publisher reads the Provenance below (EFB-63).
            actor_pubkey: actor,
            ...(isColumn
              ? { from_status: t.fromStatus ?? null, to_status: t.toStatus ?? null }
              : { from_container: t.fromContainer ?? null, to_container: t.toContainer ?? null }),
          },
        },
        // NOT `route.caller`: this request's authenticated caller is GitHub's
        // webhook delivery, not the person who moved the card. `actor` is
        // `github:<login>` resolved from the PR author, or the fallback when
        // the delivery named none — a stored/derived identity the server is
        // re-attesting, which is exactly `ProvenanceFromStoredActor`.
        //
        // There IS a real external human here, and none of the three sources
        // says so; `webhook.external` would. Deliberately not minted in EFB-63 —
        // ProvenanceSource is a closed union (BOUNDARY_DISCIPLINE) and widening
        // it is a documented architectural claim, not a side effect of a
        // plumbing ticket. Filed as a follow-up. `audit.system` is honest in the
        // meantime: no live caller acted, and the pubkey is one we looked up.
        ProvenanceFromStoredActor(actor),
      );
    }
  });

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** Bodies larger than this are refused unread — GitHub's own cap is 25MB. */
const MAX_BODY_BYTES = 1_000_000;
const DEDUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const AUDIT_PAGE_DEFAULT = 50;
const AUDIT_PAGE_MAX = 200;

class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly reason: string;
}> {}
class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly reason: string;
}> {}
class ConflictError extends Data.TaggedError("ConflictError")<{
  readonly reason: string;
}> {}
class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly reason: string;
}> {}

type GithubFailure =
  | ValidationError
  | NotFoundError
  | ConflictError
  | ConfigError
  | BoardOwnershipError
  | UnauthorizedError
  | ForbiddenError
  | DbError;

const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<GithubFailure>) => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const f = failure.value;
    switch (f._tag) {
      case "ValidationError":
        return c.json({ error: "invalid-body", reason: f.reason }, 400);
      case "UnauthorizedError":
        return c.json({ error: "unauthorized", reason: f.reason }, 401);
      case "ForbiddenError":
        return c.json({ error: "forbidden", reason: f.reason }, 403);
      case "NotFoundError":
      case "BoardOwnershipError":
        return c.json({ error: "not-found", reason: f.reason }, 404);
      case "ConflictError":
        return c.json({ error: "conflict", reason: f.reason }, 409);
      case "ConfigError":
        // The server is missing EVENFLOW_WEBHOOK_SECRET — an operator
        // problem, not the caller's. Say so plainly instead of a bare 500.
        return c.json({ error: "server-misconfigured", reason: f.reason }, 503);
      case "DbError":
        return c.json({ error: "internal", reason: `db-${f.reason}` }, 500);
    }
  }
  return c.json({ error: "internal", reason: "defect" }, 500);
};

const readJsonBody = (c: Context<AppHonoEnv>) =>
  Effect.tryPromise({
    try: () => c.req.json() as Promise<Record<string, unknown>>,
    catch: () => new ValidationError({ reason: "expected-json" }),
  }).pipe(
    Effect.filterOrFail(
      (b): b is Record<string, unknown> => typeof b === "object" && b !== null && !Array.isArray(b),
      () => new ValidationError({ reason: "expected-json-object" }),
    ),
  );

// ── row parsing ───────────────────────────────────────────────────────────

const parseRuleRow = (row: Record<string, unknown>): Rule | null => {
  try {
    const when = JSON.parse(String(row["when_json"])) as Rule["when"];
    const action = JSON.parse(String(row["do_json"])) as Rule["do"];
    return {
      id: String(row["id"]),
      board_id: String(row["board_id"]),
      bucket: String(row["bucket"]) as RuleBucket,
      priority: Number(row["priority"]),
      when,
      do: action,
      enabled: row["enabled"] === 1 || row["enabled"] === true,
      created_at_ms: Number(row["created_at_ms"]),
      updated_at_ms: Number(row["updated_at_ms"]),
    };
  } catch {
    // A rule whose JSON no longer parses must not take down every delivery
    // for the board; it is dropped from evaluation and stays visible (and
    // fixable) in the editor.
    return null;
  }
};

const ruleWire = (r: Rule) => ({
  id: r.id,
  bucket: r.bucket,
  priority: r.priority,
  when: r.when,
  do: r.do,
  enabled: r.enabled,
  created_at_ms: r.created_at_ms,
  updated_at_ms: r.updated_at_ms,
});

const loadRules = (boardId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db.queryAll<Record<string, unknown>>(
      "SELECT * FROM githubWebhookRules WHERE board_id = ? ORDER BY bucket ASC, priority ASC",
      [boardId],
    );
    return rows.map(parseRuleRow).filter((r): r is Rule => r !== null);
  });

const jsonArray = (v: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(v ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
};

const jsonLinks = (v: unknown): Array<{ repo: string; pr: number; state: string }> => {
  try {
    const parsed = JSON.parse(String(v ?? "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (l): l is { repo: string; pr: number; state: string } =>
        typeof l === "object" &&
        l !== null &&
        typeof (l as Record<string, unknown>)["repo"] === "string" &&
        typeof (l as Record<string, unknown>)["pr"] === "number" &&
        typeof (l as Record<string, unknown>)["state"] === "string",
    );
  } catch {
    return [];
  }
};

/** Board config view — never discloses the secret, only whether one exists. */
const githubConfigWire = (board: BoardShape, row: Record<string, unknown>) => ({
  repo: (row["github_repo"] as string | null) ?? null,
  connected: (row["github_repo"] as string | null) !== null,
  has_secret: (row["github_webhook_secret_ciphertext"] as string | null) !== null,
  preset: ((row["github_rule_preset"] as string | null) ?? "defaults") as RulePreset,
  external_states: allowedExternalStates((row["external_state_config"] as string | null) ?? null),
  external_state_config_is_custom: (row["external_state_config"] as string | null) !== null,
  webhook_url: url("github.webhook.receive", { board_id: board.id }),
});

const loadBoardRow = (boardId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row = yield* db.queryFirst<Record<string, unknown>>(
      "SELECT * FROM boardCache WHERE id = ?",
      [boardId],
    );
    if (row === null) return yield* new NotFoundError({ reason: "board" });
    return row;
  });

/** Replace the board's rule set with a preset's rules. */
const seedPreset = (boardId: string, preset: RulePreset, now: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.execute("DELETE FROM githubWebhookRules WHERE board_id = ?", [boardId]);
    const rules = presetRules(preset);
    for (const [index, r] of rules.entries()) {
      yield* db.execute(
        "INSERT INTO githubWebhookRules (id, board_id, bucket, priority, when_json, do_json, enabled, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          crypto.randomUUID(),
          boardId,
          r.bucket,
          index * 10,
          JSON.stringify(r.when),
          JSON.stringify(r.do),
          1,
          now,
          now,
        ],
      );
    }
    return rules.length;
  });

// ── the webhook itself ────────────────────────────────────────────────────

interface ProcessOutcome {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const writeAudit = (
  boardId: string,
  deliveryId: string | null,
  eventType: string,
  action: string | null,
  matchedIssueIds: ReadonlyArray<string>,
  matchedRuleIds: ReadonlyArray<string>,
  actionsTaken: unknown,
  error: string | null,
  now: number,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.execute(
      "INSERT INTO githubWebhookAudit (id, board_id, delivery_id, event_type, action, matched_issue_ids_json, matched_rule_ids_json, actions_taken_json, error, received_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        crypto.randomUUID(),
        boardId,
        deliveryId,
        eventType,
        action,
        JSON.stringify(matchedIssueIds),
        JSON.stringify(matchedRuleIds),
        JSON.stringify(actionsTaken),
        error,
        now,
      ],
    );
  });

/**
 * Claim a delivery id. Returns false when this delivery was already
 * processed — GitHub redelivers on timeout, and re-firing "PR merged" would
 * undo a move the user has since made by hand.
 *
 * The INSERT is the claim: a composite-PK collision is the guard, so two
 * concurrent redeliveries cannot both win.
 */
const claimDelivery = (boardId: string, deliveryId: string | null, now: number) =>
  Effect.gen(function* () {
    if (deliveryId === null) return true; // no id to dedup on; process once.
    const db = yield* Db;
    const existing = yield* db.queryFirst<Record<string, unknown>>(
      "SELECT delivery_id FROM githubWebhookDedup WHERE board_id = ? AND delivery_id = ?",
      [boardId, deliveryId],
    );
    if (existing !== null) return false;
    yield* db.execute(
      "INSERT INTO githubWebhookDedup (board_id, delivery_id, received_at_ms) VALUES (?, ?, ?)",
      [boardId, deliveryId, now],
    );
    // Opportunistic retention sweep — no cron trigger exists in
    // wrangler.toml, so the write path carries it.
    yield* db.execute("DELETE FROM githubWebhookDedup WHERE received_at_ms < ?", [
      now - DEDUP_RETENTION_MS,
    ]);
    return true;
  });

const processDelivery = (
  boardId: string,
  eventType: string,
  deliveryId: string | null,
  signature: string | null,
  rawBody: string,
  masterSecret: string | undefined,
  // BoardEmitter | Audience joined the requirements in EFB-66: this handler now
  // emits board events for the transitions it applies, and `emitSecureBoardEvent`
  // needs both. `bootstrap` already provides them — AppServices has carried them
  // all along — so this widening is a declaration catching up to what the layer
  // could always satisfy, not new plumbing.
): Effect.Effect<ProcessOutcome, DbError, Db | AuditLog | BoardEmitter | Audience> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const now = yield* Clock.currentTimeMillis;
    const audit = yield* AuditLog;

    const boardRow = yield* db.queryFirst<Record<string, unknown>>(
      "SELECT * FROM boardCache WHERE id = ?",
      [boardId],
    );
    // An unknown board and a board with no secret are indistinguishable to
    // the caller on purpose: probing board ids should not be a way to learn
    // which ones exist.
    if (boardRow === null) {
      return { status: 404, body: { error: "not-found" } };
    }
    const sealed = (boardRow["github_webhook_secret_ciphertext"] as string | null) ?? null;
    const secret = yield* Effect.promise(() => openWebhookSecret(masterSecret, sealed));
    if (secret === null) {
      return { status: 404, body: { error: "not-found" } };
    }

    const verified = yield* Effect.promise(() => verifyGithubSignature(secret, rawBody, signature));
    if (!verified) {
      yield* audit.record({
        event_type: "github_webhook_rejected",
        board: boardId,
        details: { reason: "bad-signature", delivery_id: deliveryId, github_event: eventType },
      });
      // Deliberately NOT audited to D1: an unverified body is unattributed
      // input, and writing it would let anyone fill a board's activity log.
      return { status: 400, body: { error: "bad-signature" } };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      yield* writeAudit(boardId, deliveryId, eventType, null, [], [], [], "malformed-json", now);
      return { status: 400, body: { error: "malformed-json" } };
    }

    const fresh = yield* claimDelivery(boardId, deliveryId, now);
    if (!fresh) {
      return { status: 200, body: { ok: true, deduped: true } };
    }

    const board = parseBoardRow(boardRow);
    const delivery = parseDelivery(eventType, payload);

    // Resolve refs → issues on THIS board only. A PR that names a ticket on
    // someone else's board must not reach across the boundary.
    const targets: TargetIssue[] = [];
    const unresolved: string[] = [];
    const linksByIssue = new Map<string, ReadonlyArray<{ repo: string; pr: number; state: string }>>();
    const labelsByIssue = new Map<string, ReadonlyArray<string>>();
    const statusByIssue = new Map<string, { status: string; container: string }>();

    for (const shortId of delivery.refs.shortIds) {
      const row = yield* db.queryFirst<Record<string, unknown>>(
        "SELECT * FROM issueCache WHERE board_id = ? AND short_id = ?",
        [boardId, shortId],
      );
      if (row === null) {
        unresolved.push(shortId);
        continue;
      }
      const id = String(row["id"]);
      const labels = jsonArray(row["labels"]);
      targets.push({
        id,
        short_id: shortId,
        title: String(row["title"] ?? ""),
        column_id: (row["column_id"] as string | null) ?? null,
        container: String(row["container"] ?? "backlog"),
        labels,
        external_state: (row["external_state"] as string | null) ?? null,
      });
      linksByIssue.set(id, jsonLinks(row["github_links"]));
      labelsByIssue.set(id, labels);
      statusByIssue.set(id, {
        status: String(row["status"] ?? ""),
        container: String(row["container"] ?? "backlog"),
      });
    }

    const rules = yield* loadRules(boardId);
    const plan = evaluateDelivery({
      delivery,
      rules,
      columns: board.columns,
      targets,
      unresolvedShortIds: unresolved,
      // GitHub login → evenflow pubkey. Boards store OAuth stand-in
      // pubkeys as `github:<numeric id>`, which a webhook payload's login
      // cannot be mapped to without an account lookup; assign(pr_author)
      // therefore resolves only when a member's pubkey is literally
      // `github:<login>`. Unmapped authors surface as a skipped effect
      // rather than a silently wrong assignment.
      authorPubkey:
        delivery.pr?.author_login === null || delivery.pr?.author_login === undefined
          ? null
          : yield* resolveAuthorPubkey(boardId, delivery.pr.author_login),
    });

    // Hoisted (EFB-66): the board events emitted below must be attributed to
    // the same actor the statusChangeCache rows were written with, or the
    // 30553 would credit the change to someone the audit row never named.
    const actor =
      delivery.pr?.author_login != null
        ? `github:${delivery.pr.author_login}`
        : WEBHOOK_ACTOR_FALLBACK;

    const applied = yield* executePlan({
      plan,
      boardId,
      columns: board.columns,
      actor,
      linksByIssue,
      labelsByIssue,
      statusByIssue,
    });

    yield* emitTransitionEvents(boardId, applied, actor);

    yield* writeAudit(
      boardId,
      deliveryId,
      eventType,
      delivery.facts.action,
      targets.map((t) => t.id),
      plan.outcomes.map((o) => o.rule_id).filter((id): id is string => id !== null),
      applied,
      null,
      now,
    );

    return {
      status: 200,
      body: {
        ok: true,
        matched: plan.matched_short_ids,
        unresolved: plan.unresolved_short_ids,
        rule_matched: !plan.no_rule_matched,
        actions: applied.length,
      },
    };
  });

/**
 * Map a GitHub login to a board member's pubkey. Only an exact
 * `github:<login>` membership row counts — guessing would assign the wrong
 * person, and a skipped assign is recoverable while a wrong one is not.
 */
const resolveAuthorPubkey = (boardId: string, login: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const candidate = `github:${login}`;
    const row = yield* db.queryFirst<Record<string, unknown>>(
      "SELECT pubkey FROM boardMemberCache WHERE board_id = ? AND pubkey = ?",
      [boardId, candidate],
    );
    return row === null ? null : candidate;
  });

// ── router ────────────────────────────────────────────────────────────────

export const makeGithubRouter = (layerFor?: LayerFor) => {
  const app = new Hono<AppHonoEnv>();
  const layer = (c: Context<AppHonoEnv>) =>
    layerFor === undefined ? bootstrap(c.env) : layerFor(c.env);

  const run = <A>(
    c: Context<AppHonoEnv>,
    program: Effect.Effect<A, GithubFailure, Db | AuditLog>,
    ok: (a: A) => Response,
  ) =>
    Effect.runPromise(Effect.exit(Effect.provide(program, layer(c)))).then((exit) =>
      Exit.isSuccess(exit) ? ok(exit.value) : errorResponse(c, exit.cause),
    );

  // ── inbound webhook ─────────────────────────────────────────────────────
  app.post(path("github.webhook.receive"), async (c) => {
    const boardId = c.req.param("board_id");
    const eventType = c.req.header("x-github-event") ?? "unknown";
    const deliveryId = c.req.header("x-github-delivery") ?? null;
    const signature = c.req.header("x-hub-signature-256") ?? null;

    const declared = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return c.json({ error: "body-too-large" }, 413);
    }

    // The RAW body is what GitHub signed — re-serializing parsed JSON
    // changes whitespace and key order and would fail every signature.
    const rawBody = await c.req.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      return c.json({ error: "body-too-large" }, 413);
    }

    const program = processDelivery(
      boardId,
      eventType,
      deliveryId,
      signature,
      rawBody,
      c.env.EVENFLOW_WEBHOOK_SECRET,
    );
    const exit = await Effect.runPromise(Effect.exit(Effect.provide(program, layer(c))));
    if (Exit.isSuccess(exit)) {
      return c.json(exit.value.body, exit.value.status as 200);
    }
    return c.json({ error: "internal" }, 500);
  });

  // ── config surface (admin) ──────────────────────────────────────────────

  const boardScope = (c: Context<AppHonoEnv>, minRole = "admin") =>
    Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      // Org-scoped mounts contribute org_slug via the mount prefix, so it
      // is read off the whole param bag rather than the route pattern
      // (same accessor sprints.ts uses).
      const params = c.req.param() as Record<string, string | undefined>;
      const scope = yield* resolveBoardScope(
        { org_slug: params["org_slug"], slug: params["slug"] ?? "" },
        callerPubkey(claims),
        minRole,
      );
      return scope;
    });

  app.get(path("github.config.get"), (c) =>
    run(
      c,
      Effect.gen(function* () {
        const { board } = yield* boardScope(c, "admin");
        const row = yield* loadBoardRow(board.id);
        const rules = yield* loadRules(board.id);
        return { config: githubConfigWire(board, row), rules: rules.map(ruleWire) };
      }),
      (v) => c.json(v),
    ),
  );

  /** Connect or update: repo, preset, pill vocabulary. Never the secret. */
  app.put(path("github.config.set"), (c) =>
    run(
      c,
      Effect.gen(function* () {
        const { board } = yield* boardScope(c, "admin");
        const body = yield* readJsonBody(c);
        const now = yield* Clock.currentTimeMillis;
        const db = yield* Db;

        const repo = body["repo"];
        if (repo !== undefined && repo !== null) {
          if (typeof repo !== "string" || !REPO_RE.test(repo)) {
            return yield* new ValidationError({ reason: "repo" });
          }
        }

        const preset = body["preset"];
        if (preset !== undefined && !(RULE_PRESETS as ReadonlyArray<string>).includes(preset as string)) {
          return yield* new ValidationError({ reason: "preset" });
        }

        const statesRaw = body["external_states"];
        let statesJson: string | null | undefined;
        if (statesRaw !== undefined) {
          if (statesRaw === null) {
            statesJson = null;
          } else {
            const problem = externalStateConfigProblem(statesRaw);
            if (problem !== null) {
              return yield* new ValidationError({ reason: `external_states-${problem}` });
            }
            statesJson = JSON.stringify(statesRaw);
          }
        }

        const current = yield* loadBoardRow(board.id);
        const nextRepo = repo === undefined ? (current["github_repo"] as string | null) : (repo as string | null);
        const nextPreset = (preset ?? current["github_rule_preset"] ?? "defaults") as RulePreset;
        const nextStates =
          statesJson === undefined ? (current["external_state_config"] as string | null) : statesJson;

        yield* db.execute(
          "UPDATE boardCache SET github_repo = ?, github_rule_preset = ?, external_state_config = ?, updated_at_ms = ? WHERE id = ?",
          [nextRepo, nextPreset, nextStates, now, board.id],
        );

        // Switching preset re-seeds the rule set. 'custom' deliberately
        // does NOT — it means "these rules are mine now, stop managing
        // them", and re-seeding would silently discard the user's edits.
        let seeded: number | null = null;
        if (preset !== undefined && preset !== "custom") {
          seeded = yield* seedPreset(board.id, nextPreset, now);
        }

        const row = yield* loadBoardRow(board.id);
        const rules = yield* loadRules(board.id);
        return { config: githubConfigWire(board, row), rules: rules.map(ruleWire), seeded };
      }),
      (v) => c.json(v),
    ),
  );

  /**
   * Mint (or rotate) the webhook secret. The plaintext is in THIS RESPONSE
   * ONLY and is never retrievable again — rotating invalidates the old one
   * immediately, which is the intended break-glass behaviour.
   */
  app.post(path("github.secret.set"), (c) =>
    run(
      c,
      Effect.gen(function* () {
        const { board } = yield* boardScope(c, "admin");
        const now = yield* Clock.currentTimeMillis;
        const db = yield* Db;
        const master = c.env.EVENFLOW_WEBHOOK_SECRET;
        const plaintext = mintWebhookSecret();
        const sealed = yield* Effect.promise(() => sealWebhookSecret(master, plaintext));
        if (sealed === null) {
          return yield* new ConfigError({ reason: "webhook-secret-key-missing" });
        }
        yield* db.execute(
          "UPDATE boardCache SET github_webhook_secret_ciphertext = ?, updated_at_ms = ? WHERE id = ?",
          [sealed, now, board.id],
        );
        return {
          secret: plaintext,
          webhook_url: url("github.webhook.receive", { board_id: board.id }),
          note: "Shown once. Paste into GitHub → Settings → Webhooks → Secret.",
        };
      }),
      (v) => c.json(v, 201),
    ),
  );

  /** Disconnect: clears repo + secret, leaves rules and audit history intact. */
  app.delete(path("github.config.delete"), (c) =>
    run(
      c,
      Effect.gen(function* () {
        const { board } = yield* boardScope(c, "admin");
        const now = yield* Clock.currentTimeMillis;
        const db = yield* Db;
        yield* db.execute(
          "UPDATE boardCache SET github_repo = NULL, github_webhook_secret_ciphertext = NULL, updated_at_ms = ? WHERE id = ?",
          [now, board.id],
        );
        return { ok: true };
      }),
      (v) => c.json(v),
    ),
  );

  // ── rules CRUD ──────────────────────────────────────────────────────────

  /**
   * Replace the whole rule set. A wholesale PUT (rather than per-rule
   * POST/PATCH) is what a drag-reorder editor actually produces, and it
   * makes priority renumbering atomic instead of a sequence of conflicting
   * partial writes.
   */
  app.put(path("github.rules.set"), (c) =>
    run(
      c,
      Effect.gen(function* () {
        const { board } = yield* boardScope(c, "admin");
        const body = yield* readJsonBody(c);
        const now = yield* Clock.currentTimeMillis;
        const db = yield* Db;

        const list = body["rules"];
        if (!Array.isArray(list)) return yield* new ValidationError({ reason: "rules-shape" });
        if (list.length > MAX_RULES_PER_BOARD) {
          return yield* new ValidationError({ reason: "rules-too-many" });
        }

        const boardRow = yield* loadBoardRow(board.id);
        const allowed = allowedExternalStates(
          (boardRow["external_state_config"] as string | null) ?? null,
        );

        const validated = list.map((raw, index) => {
          const r = raw as Record<string, unknown>;
          const bucket = (r["bucket"] ?? "match") as string;
          if (!(RULE_BUCKETS as ReadonlyArray<string>).includes(bucket)) {
            return { problem: `rule-${index}-bucket` } as const;
          }
          const wp = predicateProblem(r["when"]);
          if (wp !== null) return { problem: `rule-${index}-${wp}` } as const;
          const ap = actionProblem(r["do"], allowed);
          if (ap !== null) return { problem: `rule-${index}-${ap}` } as const;
          return {
            ok: {
              bucket,
              priority: typeof r["priority"] === "number" ? (r["priority"] as number) : index * 10,
              when: JSON.stringify(r["when"]),
              action: JSON.stringify(r["do"]),
              enabled: r["enabled"] === false ? 0 : 1,
            },
          } as const;
        });

        for (const v of validated) {
          if ("problem" in v) return yield* new ValidationError({ reason: v.problem });
        }

        yield* db.execute("DELETE FROM githubWebhookRules WHERE board_id = ?", [board.id]);
        for (const v of validated) {
          if (!("ok" in v)) continue;
          yield* db.execute(
            "INSERT INTO githubWebhookRules (id, board_id, bucket, priority, when_json, do_json, enabled, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
              crypto.randomUUID(),
              board.id,
              v.ok.bucket,
              v.ok.priority,
              v.ok.when,
              v.ok.action,
              v.ok.enabled,
              now,
              now,
            ],
          );
        }

        // Hand-edited rules mean the board is no longer on a managed preset.
        yield* db.execute(
          "UPDATE boardCache SET github_rule_preset = 'custom', updated_at_ms = ? WHERE id = ?",
          [now, board.id],
        );

        const rules = yield* loadRules(board.id);
        return { rules: rules.map(ruleWire) };
      }),
      (v) => c.json(v),
    ),
  );

  // ── test panel ──────────────────────────────────────────────────────────

  /**
   * Dry-run a payload against the board's live rules. Calls exactly the
   * same evaluateDelivery the webhook does and performs ZERO writes — no
   * issue update, no audit row, no dedup claim. The only difference from a
   * real delivery is that the plan is rendered instead of executed.
   */
  app.post(path("github.connection.test"), (c) =>
    run(
      c,
      Effect.gen(function* () {
        const { board } = yield* boardScope(c, "admin");
        const body = yield* readJsonBody(c);
        const db = yield* Db;

        const eventType = body["event"];
        if (typeof eventType !== "string" || eventType === "") {
          return yield* new ValidationError({ reason: "event" });
        }
        const payload = body["payload"];
        if (typeof payload !== "object" || payload === null) {
          return yield* new ValidationError({ reason: "payload" });
        }

        const delivery = parseDelivery(eventType, payload);
        const targets: TargetIssue[] = [];
        const unresolved: string[] = [];
        for (const shortId of delivery.refs.shortIds) {
          const row = yield* db.queryFirst<Record<string, unknown>>(
            "SELECT * FROM issueCache WHERE board_id = ? AND short_id = ?",
            [board.id, shortId],
          );
          if (row === null) {
            unresolved.push(shortId);
            continue;
          }
          targets.push({
            id: String(row["id"]),
            short_id: shortId,
            title: String(row["title"] ?? ""),
            column_id: (row["column_id"] as string | null) ?? null,
            container: String(row["container"] ?? "backlog"),
            labels: jsonArray(row["labels"]),
            external_state: (row["external_state"] as string | null) ?? null,
          });
        }

        const rules = yield* loadRules(board.id);
        const plan = evaluateDelivery({
          delivery,
          rules,
          columns: board.columns,
          targets,
          unresolvedShortIds: unresolved,
          authorPubkey:
            delivery.pr?.author_login == null
              ? null
              : yield* resolveAuthorPubkey(board.id, delivery.pr.author_login),
        });

        return {
          facts: plan.facts,
          refs: { short_ids: delivery.refs.shortIds, explicit: delivery.refs.explicit },
          matched: plan.matched_short_ids,
          unresolved: plan.unresolved_short_ids,
          bucket: plan.bucket,
          no_rule_matched: plan.no_rule_matched,
          outcomes: plan.outcomes,
          columns: enabledColumns(board.columns).map((col) => ({
            id: col.id,
            name: col.name,
            category: col.category,
          })),
        };
      }),
      (v) => c.json(v),
    ),
  );

  // ── activity log ────────────────────────────────────────────────────────

  app.get(path("github.audit.list"), (c) =>
    run(
      c,
      Effect.gen(function* () {
        const { board } = yield* boardScope(c, "admin");
        const db = yield* Db;
        const limitRaw = Number(c.req.query("limit") ?? AUDIT_PAGE_DEFAULT);
        const limit = Number.isFinite(limitRaw)
          ? Math.min(Math.max(Math.trunc(limitRaw), 1), AUDIT_PAGE_MAX)
          : AUDIT_PAGE_DEFAULT;
        const eventFilter = c.req.query("event_type") ?? null;
        const errorsOnly = c.req.query("errors_only") === "1";
        const since = Number(c.req.query("since") ?? "0");

        const clauses = ["board_id = ?"];
        const params: unknown[] = [board.id];
        if (eventFilter !== null) {
          clauses.push("event_type = ?");
          params.push(eventFilter);
        }
        if (errorsOnly) clauses.push("error IS NOT NULL");
        if (Number.isFinite(since) && since > 0) {
          clauses.push("received_at_ms >= ?");
          params.push(since);
        }
        params.push(limit);

        const rows = yield* db.queryAll<Record<string, unknown>>(
          `SELECT * FROM githubWebhookAudit WHERE ${clauses.join(" AND ")} ORDER BY received_at_ms DESC LIMIT ?`,
          params,
        );

        return {
          entries: rows.map((r) => ({
            id: String(r["id"]),
            delivery_id: (r["delivery_id"] as string | null) ?? null,
            event_type: String(r["event_type"]),
            action: (r["action"] as string | null) ?? null,
            matched_issue_ids: jsonArray(r["matched_issue_ids_json"]),
            matched_rule_ids: jsonArray(r["matched_rule_ids_json"]),
            actions_taken: JSON.parse(String(r["actions_taken_json"] ?? "[]")),
            error: (r["error"] as string | null) ?? null,
            received_at_ms: Number(r["received_at_ms"]),
          })),
        };
      }),
      (v) => c.json(v),
    ),
  );

  return app;
};

export { DEFAULT_EXTERNAL_STATES };
