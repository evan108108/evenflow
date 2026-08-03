/**
 * GitHub integration actions (phase 21) — the business half of
 * src/routes/github.ts, split out by EFB-98.
 *
 * Two very different surfaces live here:
 *
 *   1. The INBOUND WEBHOOK. Public by design; HMAC over the raw body is the
 *      only gate. It runs behind optionalAuth but never reads claims, which is
 *      why `receiveWebhook` takes a `PublicActionInput` — anonymous is not an
 *      accident on that path, it is the whole design, and the signature says so.
 *
 *   2. The BOARD CONFIG surface — connect/rotate/disconnect, rule CRUD, the
 *      test panel, and the activity log. All admin-gated through
 *      `resolveBoardScope`, same as every other board-settings action, so those
 *      take `ActionInput` and are guaranteed a caller.
 *
 * The webhook answers 2xx for anything it has verified, INCLUDING deliveries
 * that matched no ticket or no rule. GitHub retries non-2xx, and retrying a
 * delivery whose only problem is "this PR mentions no ticket" would hammer
 * us forever. Only signature failure and unreadable bodies are 4xx. That is
 * why `receiveWebhook` returns an outcome record carrying its own status
 * rather than failing — its statuses are answers, not errors.
 *
 * Bodies moved VERBATIM. Every comment, ordering decision and failure reason
 * below is the pre-split code; the only edits read params/body/claims off an
 * input record instead of off a Context.
 */

import { Clock, Data, Effect } from "effect";

import { url } from "../routes-manifest";
import { Audience, AuditLog, BoardEmitter, Db, DbError } from "../effects";
import {
  ForbiddenError,
  UnauthorizedError,
  callerPubkey,
  resolveBoardScope,
  type BoardOwnershipError,
} from "../authz";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors";
import { parseBoardRow, parseIssueRow, type BoardShape } from "../shapes";
import { enabledColumns } from "../columns";
import {
  allowedExternalStates,
  externalStateConfigProblem,
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
import { ProvenanceFromExternalActor } from "../lib/route-body";
import type { ActionInput, PublicActionInput } from "./types";

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
        // webhook delivery, not the person who moved the card.
        //
        // EFB-92 minted `external.webhook` and this is the callsite it was
        // minted for. EFB-63 shipped `ProvenanceFromStoredActor` here and said
        // in this comment that the fit was honest but lossy — `audit.system`
        // claimed Sonata acted, when GitHub did. That follow-up is this one.
        //
        // `actor` is `github:<login>` when the delivery named a PR author, and
        // `github:webhook` when it named none. BOTH take this constructor: the
        // literal marks the action's ORIGIN as outside this system, not the
        // presence of a human, and the fallback is if anything the branch that
        // needed it most — it is where "the integration acted as itself" was
        // being recorded as "Sonata acted".
        ProvenanceFromExternalActor(actor),
      );
    }
  });

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const DEDUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const AUDIT_PAGE_DEFAULT = 50;
const AUDIT_PAGE_MAX = 200;

/**
 * The server is missing EVENFLOW_WEBHOOK_SECRET — an operator problem, not the
 * caller's, which is why the route answers it 503 rather than a bare 500.
 * Local to this family: the shared vocabulary has no equivalent, and inventing
 * one would claim a generality this single case does not have.
 */
export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly reason: string;
}> {}

export type GithubFailure =
  | ValidationError
  | NotFoundError
  | ConflictError
  | ConfigError
  | BoardOwnershipError
  | UnauthorizedError
  | ForbiddenError
  | DbError;

/** Everything the github config actions ask the layer for. */
export type GithubServices = Db | AuditLog;

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

/**
 * Board config view — never discloses the secret, only whether one exists.
 *
 * `webhook_url` is built from the manifest rather than hand-assembled, so the
 * URL a board admin pastes into GitHub can only ever be the URL the router
 * actually serves.
 */
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

/**
 * What GitHub's delivery carries besides the board id: three headers and the
 * RAW request body. The body is read eagerly in the route — re-serializing
 * parsed JSON changes whitespace and key order and would fail every signature,
 * so the bytes have to survive intact, and the length refusal has to happen
 * before any of this runs.
 */
export interface GithubDelivery {
  readonly eventType: string;
  readonly deliveryId: string | null;
  readonly signature: string | null;
  readonly rawBody: string;
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

/**
 * The inbound webhook.
 *
 * `PublicActionInput` because GitHub is not a signed-in caller and never will
 * be: `claims` is null on every real delivery, and HMAC over the raw body is
 * the gate instead. `masterSecret` is `c.env.EVENFLOW_WEBHOOK_SECRET`, server
 * configuration passed explicitly rather than smuggled through the request
 * record.
 *
 * Returns an outcome rather than failing, because its 404s and 400s are
 * ANSWERS: an unknown board and a board with no secret are deliberately
 * indistinguishable, and a bad signature is a refusal this function decided on
 * — none of them is an error the transport should be mapping.
 *
 * BoardEmitter | Audience joined the requirements in EFB-66: this handler now
 * emits board events for the transitions it applies, and `emitSecureBoardEvent`
 * needs both. `bootstrap` already provides them — AppServices has carried them
 * all along — so this widening is a declaration catching up to what the layer
 * could always satisfy, not new plumbing.
 */
export const receiveWebhook = (
  input: PublicActionInput<GithubDelivery>,
  masterSecret: string | undefined,
): Effect.Effect<ProcessOutcome, DbError, Db | AuditLog | BoardEmitter | Audience> =>
  Effect.gen(function* () {
    const boardId = input.params["board_id"] ?? "";
    const { eventType, deliveryId, signature, rawBody } = input.body;

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

// ── config surface (admin) ──────────────────────────────────────────────

/**
 * Resolve the board this request is scoped to, proving `minRole` on it.
 *
 * `requireCaller` ran in the route and its RESULT is passed in, which is why
 * every config action takes `ActionInput`: there is no anonymous path onto a
 * board's GitHub settings.
 */
const boardScope = (
  input: Pick<ActionInput<unknown>, "claims" | "orgSlug" | "params">,
  minRole = "admin",
) =>
  Effect.gen(function* () {
    const scope = yield* resolveBoardScope(
      { org_slug: input.orgSlug ?? undefined, slug: input.params["slug"] ?? "" },
      callerPubkey(input.claims),
      minRole,
    );
    return scope;
  });

export const getGithubConfig = (input: ActionInput) =>
  Effect.gen(function* () {
    const { board } = yield* boardScope(input, "admin");
    const row = yield* loadBoardRow(board.id);
    const rules = yield* loadRules(board.id);
    return { config: githubConfigWire(board, row), rules: rules.map(ruleWire) };
  });

/**
 * Connect or update: repo, preset, pill vocabulary. Never the secret.
 *
 * `input.body` is a DEFERRED read (EFB-98 rule 10). The pre-split handler
 * proved board admin BEFORE reading the body, so a caller who cannot see the
 * board still gets its 401/403/404 rather than a 400 about a body they were
 * never entitled to send.
 */
export const setGithubConfig = (
  input: ActionInput<Effect.Effect<Record<string, unknown>, ValidationError, never>>,
) =>
  Effect.gen(function* () {
    const { board } = yield* boardScope(input, "admin");
    const body = yield* input.body;
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
  });

/**
 * Mint (or rotate) the webhook secret. The plaintext is in THIS RESPONSE
 * ONLY and is never retrievable again — rotating invalidates the old one
 * immediately, which is the intended break-glass behaviour.
 *
 * `masterSecret` is server configuration, passed explicitly; an unset one is
 * handled here rather than asserted away, so the operator gets a 503 naming
 * the problem instead of a TypeError three frames down.
 */
export const setGithubSecret = (input: ActionInput, masterSecret: string | undefined) =>
  Effect.gen(function* () {
    const { board } = yield* boardScope(input, "admin");
    const now = yield* Clock.currentTimeMillis;
    const db = yield* Db;
    const plaintext = mintWebhookSecret();
    const sealed = yield* Effect.promise(() => sealWebhookSecret(masterSecret, plaintext));
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
  });

/** Disconnect: clears repo + secret, leaves rules and audit history intact. */
export const deleteGithubConfig = (input: ActionInput) =>
  Effect.gen(function* () {
    const { board } = yield* boardScope(input, "admin");
    const now = yield* Clock.currentTimeMillis;
    const db = yield* Db;
    yield* db.execute(
      "UPDATE boardCache SET github_repo = NULL, github_webhook_secret_ciphertext = NULL, updated_at_ms = ? WHERE id = ?",
      [now, board.id],
    );
    return { ok: true };
  });

// ── rules CRUD ──────────────────────────────────────────────────────────

/**
 * Replace the whole rule set. A wholesale PUT (rather than per-rule
 * POST/PATCH) is what a drag-reorder editor actually produces, and it
 * makes priority renumbering atomic instead of a sequence of conflicting
 * partial writes.
 *
 * Deferred body for the same reason as `setGithubConfig` — see rule 10 there.
 */
export const setGithubRules = (
  input: ActionInput<Effect.Effect<Record<string, unknown>, ValidationError, never>>,
) =>
  Effect.gen(function* () {
    const { board } = yield* boardScope(input, "admin");
    const body = yield* input.body;
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
  });

// ── test panel ──────────────────────────────────────────────────────────

/**
 * Dry-run a payload against the board's live rules. Calls exactly the
 * same evaluateDelivery the webhook does and performs ZERO writes — no
 * issue update, no audit row, no dedup claim. The only difference from a
 * real delivery is that the plan is rendered instead of executed.
 *
 * Deferred body for the same reason as `setGithubConfig` — see rule 10 there.
 */
export const testGithubConnection = (
  input: ActionInput<Effect.Effect<Record<string, unknown>, ValidationError, never>>,
) =>
  Effect.gen(function* () {
    const { board } = yield* boardScope(input, "admin");
    const body = yield* input.body;
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
  });

// ── activity log ────────────────────────────────────────────────────────

/**
 * The query string arrives on `input.query`, filled from the route's own
 * `c.req.query()` call — the read stays in the route file because the query
 * allowlist names this route there, while the paging POLICY (defaults, the
 * clamp, which filters compose) is business logic and lives here.
 */
export const listGithubAudit = (input: ActionInput) =>
  Effect.gen(function* () {
    const { board } = yield* boardScope(input, "admin");
    const db = yield* Db;
    const limitRaw = Number(input.query["limit"] ?? AUDIT_PAGE_DEFAULT);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), AUDIT_PAGE_MAX)
      : AUDIT_PAGE_DEFAULT;
    const eventFilter = input.query["event_type"] ?? null;
    const errorsOnly = input.query["errors_only"] === "1";
    const since = Number(input.query["since"] ?? "0");

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
  });
