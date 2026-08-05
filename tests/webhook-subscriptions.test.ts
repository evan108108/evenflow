// EFB-13 — outbound webhook subscriptions.
//
// Everything here tests a PURE surface: the schemas, the leak guard, the match
// predicate, and the retry ladder. That is deliberate and it is the payoff of
// the Boundary Discipline split — the shape rules and the authorization rule
// are both reachable without a database or a live router, so they can be
// asserted directly instead of inferred from an HTTP status.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { url } from "../src/routes-manifest";
import { Effect, Exit } from "effect";
import { decodeBody } from "../src/lib/route-body";
import { makeDbMock, type DbMock, type Row } from "./dbMock";
import { parseBoardRow } from "../src/shapes";
import {
  CALLER,
  bearer,
  createBoard,
  createIssue,
  jsonReq,
  makeHarness,
  type Harness,
} from "./harness";
// EFB-98 — the subscription vocabulary (event kinds, the two body schemas) and
// the predicate authorization rule are business logic, so they moved to the
// action module with the handlers that use them. The route file is now the HTTP
// shell. Same symbols, same rules, one directory over.
import {
  BOARD_EVENT_KINDS,
  PatchSubscriptionBody,
  PostSubscriptionBody,
  requirePredicateAllowed,
} from "../src/actions/webhooks";
import type { BoardEventKind } from "../src/durable-objects/board-events";
import {
  BACKOFF_MS,
  MAX_ATTEMPTS,
  enqueueOutboundWebhooks,
  matchesSubscription,
  subscriberMayReceive,
  sweepOutboundWebhooks,
  type SubscriptionRow,
} from "../src/lib/webhook-dispatch";

const ALICE = "nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2";
const BOB = "nostr:1111111111111111111111111111111111111111111111111111111111111111";

const decode = <A, I>(schema: Parameters<typeof decodeBody<A, I>>[0], input: unknown) =>
  Effect.runSync(Effect.exit(decodeBody(schema, input)));

const reasonOf = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return "<succeeded>";
  const err = (exit.cause as { error?: { reason?: string } }).error;
  return err?.reason ?? "<no reason>";
};

const okBody = {
  name: "Slack bridge",
  url: "https://example.com/hook",
  event_kinds: ["issue.created"],
};

describe("event-kind vocabulary", () => {
  // The route's literal union is a hand-maintained mirror of the DO's type.
  // A kind added there but not here would be un-subscribable with no error
  // anywhere — so the mirror is asserted rather than trusted.
  it("mirrors BoardEventKind exactly", () => {
    const fromRoute = [...BOARD_EVENT_KINDS].sort();
    const fromVocabulary: BoardEventKind[] = [
      "issue.created",
      "issue.updated",
      "issue.transitioned",
      "issue.container_changed",
      "issue.deleted",
      "comment.created",
      "comment.deleted",
      "board.created",
      "board.updated",
      "board.deleted",
      "sprint.created",
      "sprint.updated",
      "sprint.started",
      "sprint.completed",
      "sprint.deleted",
      "sprint.tide.updated",
      "issues.imported",
    ];
    expect(fromRoute).toEqual([...fromVocabulary].sort());
    // Compile-time half: every routed kind must BE a BoardEventKind. If the
    // union shrinks, this assignment stops compiling.
    const _typecheck: ReadonlyArray<BoardEventKind> = BOARD_EVENT_KINDS;
    expect(_typecheck.length).toBe(17);
  });
});

describe("PostSubscriptionBody — shape", () => {
  it("accepts a well-formed body", () => {
    const exit = decode(PostSubscriptionBody, okBody);
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  // EFB-53's rule, applied to a route born after it: an unknown key is a
  // client bug and must be a 400 naming the key, never a silent drop.
  it("rejects an unknown key, naming it", () => {
    const exit = decode(PostSubscriptionBody, { ...okBody, secret: "hunter2" });
    expect(Exit.isFailure(exit)).toBe(true);
    expect(reasonOf(exit)).toContain("secret");
  });

  it("rejects a typo'd known key rather than ignoring it", () => {
    const exit = decode(PostSubscriptionBody, { ...okBody, event_kind: ["issue.created"] });
    expect(Exit.isFailure(exit)).toBe(true);
    expect(reasonOf(exit)).toContain("event_kind");
  });

  // The whole point of the literal union: a kind we never emit fails at write
  // time instead of producing a subscription that silently never fires.
  it("rejects an event kind outside the frozen vocabulary", () => {
    const exit = decode(PostSubscriptionBody, { ...okBody, event_kinds: ["issue.assigned"] });
    expect(Exit.isFailure(exit)).toBe(true);
    expect(reasonOf(exit)).toContain("event_kinds");
  });

  it("rejects an empty event_kinds array", () => {
    const exit = decode(PostSubscriptionBody, { ...okBody, event_kinds: [] });
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("rejects a non-https url", () => {
    const exit = decode(PostSubscriptionBody, { ...okBody, url: "http://example.com/hook" });
    expect(Exit.isFailure(exit)).toBe(true);
    expect(reasonOf(exit)).toContain("url");
  });

  it("rejects a missing required field, naming it", () => {
    const { name: _drop, ...withoutName } = okBody;
    const exit = decode(PostSubscriptionBody, withoutName);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(reasonOf(exit)).toContain("name");
  });

  // Invariant 4: output is canonical, so the handler never re-normalizes.
  it("canonicalizes a bare-hex predicate assignee", () => {
    const bare = ALICE.slice("nostr:".length);
    const exit = decode(PostSubscriptionBody, { ...okBody, predicate: { assignee: bare } });
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect((exit.value as { predicate?: { assignee?: string } }).predicate?.assignee).toBe(ALICE);
    }
  });

  it("rejects a predicate field that is not part of the v1 grammar", () => {
    const exit = decode(PostSubscriptionBody, { ...okBody, predicate: { author: ALICE } });
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("PatchSubscriptionBody", () => {
  it("accepts a partial patch", () => {
    expect(Exit.isSuccess(decode(PatchSubscriptionBody, { enabled: false }))).toBe(true);
  });

  it("still rejects unknown keys", () => {
    const exit = decode(PatchSubscriptionBody, { enabled: false, hmac_secret_ciphertext: "x" });
    expect(Exit.isFailure(exit)).toBe(true);
    expect(reasonOf(exit)).toContain("hmac_secret_ciphertext");
  });
});

describe("predicate leak guard (surprise #9)", () => {
  const run = (predicate: { assignee?: string } | null, caller: string | null, role: string) =>
    Exit.isSuccess(Effect.runSyncExit(requirePredicateAllowed(predicate, caller, role)));

  it("allows a subscription with no predicate", () => {
    expect(run(null, ALICE, "member")).toBe(true);
    expect(run({}, ALICE, "member")).toBe(true);
  });

  it("allows filtering on yourself", () => {
    expect(run({ assignee: ALICE }, ALICE, "member")).toBe(true);
  });

  // The leak: without this rule, anyone able to register a URL could watch any
  // individual member's activity by naming their pubkey.
  it("REJECTS filtering on somebody else", () => {
    expect(run({ assignee: BOB }, ALICE, "member")).toBe(false);
  });

  it("rejects a cross-pubkey filter from an anonymous caller", () => {
    expect(run({ assignee: BOB }, null, "member")).toBe(false);
  });

  // An admin can already read every issue on the board, so this grants no
  // reach they did not have.
  it("allows an admin to filter on anyone", () => {
    expect(run({ assignee: BOB }, ALICE, "admin")).toBe(true);
  });
});

describe("matchesSubscription", () => {
  const sub = (over: Partial<SubscriptionRow>): SubscriptionRow => ({
    id: "s1",
    board_id: "b1",
    url: "https://example.com/hook",
    event_kinds: JSON.stringify(["issue.created"]),
    predicate: null,
    auth_scheme: "hmac",
    hmac_secret_ciphertext: "sealed",
    creator_pubkey: ALICE,
    ...over,
  });

  const event = (kind: string, payload: unknown = {}) =>
    ({ kind, board_id: "b1", at_ms: 1, payload }) as never;

  it("matches a subscribed kind", () => {
    expect(matchesSubscription(sub({}), event("issue.created"))).toBe(true);
  });

  it("ignores an unsubscribed kind", () => {
    expect(matchesSubscription(sub({}), event("comment.created"))).toBe(false);
  });

  it("applies an assignee predicate", () => {
    const s = sub({ predicate: JSON.stringify({ assignee: ALICE }) });
    expect(matchesSubscription(s, event("issue.created", { assignee_pubkey: ALICE }))).toBe(true);
    expect(matchesSubscription(s, event("issue.created", { assignee_pubkey: BOB }))).toBe(false);
    expect(matchesSubscription(s, event("issue.created", {}))).toBe(false);
  });

  // The real emit path (src/actions/issues.ts) sends
  //   payload = { issue: { ..., assignee_pubkey, ... } }
  // — assignee sits INSIDE the issue object, not at payload top level. A
  // matcher that read only the top level saw every live issue event as
  // "no assignee" and dropped the delivery, which is what broke the
  // Scout webhook on 2026-08-05. The subscription that had a valid
  // predicate silently produced zero deliveries.
  it("matches assignee nested inside payload.issue (real emit shape)", () => {
    const s = sub({
      event_kinds: JSON.stringify(["issue.created", "issue.updated"]),
      predicate: JSON.stringify({ assignee: ALICE }),
    });
    expect(
      matchesSubscription(s, event("issue.updated", { issue: { assignee_pubkey: ALICE } })),
    ).toBe(true);
    expect(
      matchesSubscription(s, event("issue.updated", { issue: { assignee_pubkey: BOB } })),
    ).toBe(false);
    expect(matchesSubscription(s, event("issue.updated", { issue: {} }))).toBe(false);
  });

  // Actor-aware webhooks: an `exclude_actor` predicate suppresses delivery
  // when the event was caused by the named pubkey. The load-bearing use
  // case is an AI teammate that subscribes to "issues assigned to me" and
  // would otherwise loop on its own transitions.
  it("suppresses via exclude_actor when the actor matches", () => {
    const s = sub({ predicate: JSON.stringify({ exclude_actor: ALICE }) });
    // Alice caused the event → dropped.
    expect(matchesSubscription(s, event("issue.created", {}), ALICE)).toBe(false);
    // Bob caused it → delivered.
    expect(matchesSubscription(s, event("issue.created", {}), BOB)).toBe(true);
    // Actor unknown (system emit) → delivered; we never match null against
    // a string.
    expect(matchesSubscription(s, event("issue.created", {}), null)).toBe(true);
  });

  // Both predicates AND: the event must be assigned to X AND not caused by
  // Y. This is the shape a Scout-style route actually needs — deliver only
  // when someone else touches something assigned to Scout.
  it("ANDs exclude_actor with assignee", () => {
    const s = sub({
      predicate: JSON.stringify({ assignee: ALICE, exclude_actor: ALICE }),
    });
    // Assigned to Alice, Bob acted → delivered.
    expect(
      matchesSubscription(s, event("issue.created", { assignee_pubkey: ALICE }), BOB),
    ).toBe(true);
    // Assigned to Alice, Alice acted → suppressed (self-loop).
    expect(
      matchesSubscription(s, event("issue.created", { assignee_pubkey: ALICE }), ALICE),
    ).toBe(false);
    // Assigned to Bob, Bob acted → dropped on assignee, not on actor.
    expect(
      matchesSubscription(s, event("issue.created", { assignee_pubkey: BOB }), BOB),
    ).toBe(false);
  });

  // Blast radius: a corrupt row costs its own owner notifications. It must not
  // throw, because this runs inside the emit path shared by every mutation.
  it("matches NOTHING on unparseable json rather than throwing", () => {
    expect(matchesSubscription(sub({ event_kinds: "{not json" }), event("issue.created"))).toBe(
      false,
    );
    expect(
      matchesSubscription(
        sub({ predicate: "{not json" }),
        event("issue.created", { assignee_pubkey: ALICE }),
      ),
    ).toBe(false);
  });
});

// ── EFB-62 — the private-board member gate ────────────────────────────────
//
// These are NOT pure-surface tests, and they could not be. The bug this ticket
// closes lived in the seam between a board row, a roster and a dispatch
// decision; asserting it needs all three, so these run against the DbMock.
//
// Every test here is written to fail on the pre-fix code. That was checked by
// reverting each change in turn, not assumed — the first three fail with a
// delivery row that should not exist, and the fourth fails with a MISSING
// delivery row, which is the failure mode a naive boardMemberCache gate
// introduces.

describe("EFB-62 — private-board member gate", () => {
  const ORG = "org-1";
  const BOARD = "board-1";

  /**
   * A board row as `parseBoardRow` expects it.
   *
   * `visibility` and `audience_pubkey` are the two independent axes that make
   * the three-state trap possible, so they are both parameters here rather
   * than one derived flag. A test that could only express "public" and
   * "encrypted" could not have caught this bug.
   */
  const boardRow = (visibility: string, audiencePubkey: string | null): Row => ({
    id: BOARD,
    pubkey: "nostr:owner",
    slug: "b",
    title: "B",
    description: null,
    columns: JSON.stringify([
      { id: "c1", name: "Todo", order: 0, enabled: true, category: "todo" },
    ]),
    labels: JSON.stringify([]),
    member_policy: "invite",
    issue_prefix: "B",
    next_issue_number: 1,
    org_id: ORG,
    visibility,
    audience_epoch: 1,
    audience_pubkey: audiencePubkey,
    default_sprint_days: 14,
    created_at_ms: 1,
    updated_at_ms: 1,
  });

  const subscriptionRow = (creator: string | null): Row => ({
    id: "sub-1",
    board_id: BOARD,
    name: "hook",
    url: "https://example.com/hook",
    event_kinds: JSON.stringify(["issue.created"]),
    predicate: null,
    auth_scheme: "hmac",
    hmac_secret_ciphertext: "sealed",
    enabled: 1,
    created_at_ms: 1,
    updated_at_ms: 1,
    creator_pubkey: creator,
  });

  const plaintextEvent = {
    kind: "issue.created",
    board_id: BOARD,
    issue_id: "i1",
    at_ms: 1000,
    payload: { title: "Series B term sheet", assignee_pubkey: ALICE },
  } as never;

  /** What `secureBoardEvent` hands the enqueue on an encrypting board. */
  const encryptedEvent = {
    kind: "issue.created",
    board_id: BOARD,
    issue_id: "i1",
    at_ms: 1000,
    payload: { enc: true, epoch: 1, ciphertext: "AAAA" },
  } as never;

  const enqueue = (
    db: DbMock,
    board: Row,
    deliver: unknown = plaintextEvent,
  ): Promise<number> =>
    Effect.runPromise(
      Effect.provide(
        enqueueOutboundWebhooks(
          parseBoardRow(board),
          plaintextEvent,
          deliver as never,
          1000,
        ),
        db.layer,
      ),
    );

  // ── the leak, stated as a test ──────────────────────────────────────────
  //
  // THE headline case. A board created through the normal path is private and
  // has no audience — that is the default create visibility, not a corner
  // case. Pre-fix, `encryption_active` is false for exactly this row, so both
  // EFB-13 gates read it as public and the plaintext payload was queued for
  // delivery to any registered URL. Reverting either half of the fix turns
  // this assertion red with a row containing "Series B term sheet".
  it("does NOT deliver a default-created private board's events to a non-member", async () => {
    const db = makeDbMock();
    db.boards.push(boardRow("private", null));
    db.webhookSubscriptions.push(subscriptionRow(BOB)); // never on the roster

    expect(await enqueue(db, boardRow("private", null))).toBe(0);
    expect(db.webhookDeliveries).toHaveLength(0);
  });

  it("delivers on that same board when the subscriber IS a member", async () => {
    const db = makeDbMock();
    db.boards.push(boardRow("private", null));
    db.boardMembers.push({ board_id: BOARD, pubkey: ALICE, role: "admin", added_at_ms: 1 });
    db.webhookSubscriptions.push(subscriptionRow(ALICE));

    expect(await enqueue(db, boardRow("private", null))).toBe(1);
    expect(db.webhookDeliveries).toHaveLength(1);
  });

  // The gate is not "is the board encrypted" — it is "may this board's bytes
  // go out in the clear". A fully encrypted board is gated the same way, and
  // this is the case EFB-13's `encryption_active` check DID cover, kept so a
  // future simplification cannot quietly drop it.
  it("gates an encryption-active private board the same way", async () => {
    const db = makeDbMock();
    const board = boardRow("private", "npub-audience");
    db.boards.push(board);
    db.webhookSubscriptions.push(subscriptionRow(BOB));

    expect(await enqueue(db, board, encryptedEvent)).toBe(0);
    expect(db.webhookDeliveries).toHaveLength(0);
  });

  // ── the roster catch ────────────────────────────────────────────────────
  //
  // The gate this ticket's brief proposed — a direct `boardMemberCache`
  // lookup — would answer "not a member" here and silently kill a legitimate
  // subscription. Membership is grants ∪ ORG members ∪ creator, and an org
  // member with no explicit board row is the common case for a team board.
  // This test fails against a bare-table gate, which is why it exists.
  it("delivers to an org member who has NO explicit board-member row", async () => {
    const db = makeDbMock();
    const board = boardRow("private", null);
    db.boards.push(board);
    db.orgMembers.push({ org_id: ORG, pubkey: ALICE, role: "member", added_at_ms: 1 });
    db.webhookSubscriptions.push(subscriptionRow(ALICE));
    expect(db.boardMembers).toHaveLength(0);

    expect(await enqueue(db, board)).toBe(1);
    expect(db.webhookDeliveries).toHaveLength(1);
  });

  // Pre-0028 rows carry no identity. On a private board that must read as
  // "cannot prove membership" rather than "no gate applies".
  it("fails CLOSED for a subscription with no bound creator", async () => {
    const db = makeDbMock();
    const board = boardRow("private", null);
    db.boards.push(board);
    db.webhookSubscriptions.push(subscriptionRow(null));

    expect(await enqueue(db, board)).toBe(0);
  });

  // The other side of the asymmetry: a public board's contents are public, so
  // an unbound legacy subscription keeps working exactly as it did.
  it("still delivers on a PUBLIC board with no bound creator", async () => {
    const db = makeDbMock();
    const board = boardRow("public", null);
    db.boards.push(board);
    db.webhookSubscriptions.push(subscriptionRow(null));

    expect(await enqueue(db, board)).toBe(1);
    expect(db.webhookDeliveries).toHaveLength(1);
  });

  // ── what actually goes over the wire ────────────────────────────────────
  //
  // The gate decides WHETHER; this decides WHAT. A member is entitled to the
  // event, but only in the form their membership already gets — the wrap, not
  // the cleartext. Pre-fix, audiences.ts passed the plaintext event for both
  // arguments, so this stored "Series B term sheet" in a delivery row bound
  // for an arbitrary URL.
  it("persists the ENCRYPTED payload for a private board, never the plaintext", async () => {
    const db = makeDbMock();
    const board = boardRow("private", "npub-audience");
    db.boards.push(board);
    db.boardMembers.push({ board_id: BOARD, pubkey: ALICE, role: "admin", added_at_ms: 1 });
    db.webhookSubscriptions.push(subscriptionRow(ALICE));

    await enqueue(db, board, encryptedEvent);

    const stored = String(db.webhookDeliveries[0]!["event_json"]);
    expect(stored).not.toContain("Series B term sheet");
    expect(JSON.parse(stored).payload).toEqual({ enc: true, epoch: 1, ciphertext: "AAAA" });
  });

  // Predicates must keep working on private boards, which means matching runs
  // against the plaintext event even though the encrypted one is delivered.
  // Match on the wrap instead and every predicate silently stops firing.
  it("evaluates predicates against the plaintext while delivering the wrap", async () => {
    const db = makeDbMock();
    const board = boardRow("private", "npub-audience");
    db.boards.push(board);
    db.boardMembers.push({ board_id: BOARD, pubkey: ALICE, role: "admin", added_at_ms: 1 });
    db.webhookSubscriptions.push({
      ...subscriptionRow(ALICE),
      predicate: JSON.stringify({ assignee: ALICE }),
    });

    expect(await enqueue(db, board, encryptedEvent)).toBe(1);
  });

  // ── the sweep-time half ─────────────────────────────────────────────────
  //
  // Enqueue-time alone is not enough: the backoff ladder runs to twelve hours,
  // so a row queued while its owner was a member can come due long after they
  // were removed. Without the sweep gate this test POSTs.
  it("refuses a due delivery whose subscriber was removed after enqueue", async () => {
    const db = makeDbMock();
    const board = boardRow("private", null);
    db.boards.push(board);
    db.boardMembers.push({ board_id: BOARD, pubkey: ALICE, role: "admin", added_at_ms: 1 });
    db.webhookSubscriptions.push(subscriptionRow(ALICE));

    await enqueue(db, board);
    expect(db.webhookDeliveries).toHaveLength(1);

    // Removal happens between enqueue and sweep — the exact window.
    db.boardMembers.length = 0;

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await Effect.runPromise(
      Effect.provide(sweepOutboundWebhooks(2000, "master-secret"), db.layer),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.denied).toBe(1);
    expect(result.delivered).toBe(0);
    // Terminal with the reason recorded — the audit trail the ticket asked
    // for, on the existing table rather than a new one.
    expect(db.webhookDeliveries[0]!["terminal"]).toBe(1);
    expect(db.webhookDeliveries[0]!["response_body_snippet"]).toBe("membership_revoked");
    fetchSpy.mockRestore();
  });

  // A board that will not load is not evidence of a public board — the same
  // reading publishesPlaintext takes of its third state.
  it("refuses a due delivery when the board row is gone", async () => {
    const db = makeDbMock();
    const board = boardRow("private", null);
    db.boards.push(board);
    db.boardMembers.push({ board_id: BOARD, pubkey: ALICE, role: "admin", added_at_ms: 1 });
    db.webhookSubscriptions.push(subscriptionRow(ALICE));
    await enqueue(db, board);

    db.boards.length = 0;

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await Effect.runPromise(
      Effect.provide(sweepOutboundWebhooks(2000, "master-secret"), db.layer),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.denied).toBe(1);
    expect(db.webhookDeliveries[0]!["response_body_snippet"]).toBe("board_unavailable");
    fetchSpy.mockRestore();
  });

  // ── subscriberMayReceive, directly ──────────────────────────────────────
  //
  // The gate is one exported function precisely so the route's `member_ok`
  // display and the dispatch path's decision cannot drift. Asserted here on
  // its own so that contract is visible rather than inferred.
  it("answers true for a board creator with no roster row at all", async () => {
    const db = makeDbMock();
    const board = parseBoardRow(boardRow("private", null));
    const ok = await Effect.runPromise(
      Effect.provide(subscriberMayReceive(board, "nostr:owner"), db.layer),
    );
    expect(ok).toBe(true);
  });

  it("answers false for a stranger on a private board, true on a public one", async () => {
    const db = makeDbMock();
    const priv = parseBoardRow(boardRow("private", null));
    const pub = parseBoardRow(boardRow("public", null));
    expect(
      await Effect.runPromise(Effect.provide(subscriberMayReceive(priv, BOB), db.layer)),
    ).toBe(false);
    expect(
      await Effect.runPromise(Effect.provide(subscriberMayReceive(pub, BOB), db.layer)),
    ).toBe(true);
  });
});

// ── EFB-62 — the emit-path wiring ─────────────────────────────────────────
//
// Everything above tests `enqueueOutboundWebhooks` with its arguments handed
// in directly, which cannot catch the seam that produced half this bug:
// audiences.ts passing the PLAINTEXT event where the deliverable belongs. Both
// parameters are `BoardEvent`, so that mistake typechecks perfectly. These
// drive the real HTTP surface instead — create a board, register a webhook,
// mutate an issue — and assert on what actually landed in the delivery table.

// The AES-GCM master key the route seals subscription secrets under. Any
// valid 32-byte hex works; without it the route answers a 500 ConfigError.
const WEBHOOK_ENV = { EVENFLOW_WEBHOOK_SECRET: "11".repeat(32) };

describe("EFB-62 — emit-path wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const registerWebhook = (h: Harness, slug = "kb") =>
    h.app.request(
      url("webhook.list", { slug: slug }),
      jsonReq("POST", {
        name: "hook",
        url: "https://example.com/hook",
        event_kinds: ["issue.created"],
      }),
      WEBHOOK_ENV,
    );

  it("binds the creating caller as the subscription's gate identity", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await registerWebhook(h);

    expect(res.status).toBe(201);
    expect(h.db.webhookSubscriptions).toHaveLength(1);
    expect(h.db.webhookSubscriptions[0]!["creator_pubkey"]).toBe(CALLER);
  });

  // The v1 refusal this ticket lifted. A private board used to answer 400
  // `outbound-webhooks-private-boards-unsupported-v1` here; boards are born
  // private, so that was every board until someone flipped it public.
  it("no longer refuses a subscription on a private board", async () => {
    const h = makeHarness();
    await createBoard(h);
    expect(h.db.boards[0]!["visibility"]).toBe("private");

    expect((await registerWebhook(h)).status).toBe(201);
  });

  // The end-to-end version of the headline leak: a real board, a real
  // subscription, a real issue mutation. The board creator IS a member, so the
  // delivery is legitimate — what is asserted is that it went through the gate
  // rather than round it, and that a stranger's would not.
  it("queues a delivery for the board creator and not for a stranger", async () => {
    const h = makeHarness();
    await createBoard(h);
    await registerWebhook(h);
    await createIssue(h);

    expect(h.db.webhookDeliveries).toHaveLength(1);

    // Same board, same event, a subscription owned by someone off the roster.
    h.db.webhookSubscriptions[0]!["creator_pubkey"] = BOB;
    h.db.webhookDeliveries.length = 0;
    await createIssue(h);

    expect(h.db.webhookDeliveries).toHaveLength(0);
  });

  it("surfaces member_ok on the list endpoint so a silent drop is visible", async () => {
    const h = makeHarness();
    await createBoard(h);
    await registerWebhook(h);

    const ok = (await (
      await h.app.request(url("webhook.list", { slug: "kb" }), { headers: bearer }, WEBHOOK_ENV)
    ).json()) as { subscriptions: Array<{ member_ok: boolean }>; private_board: boolean };
    expect(ok.subscriptions[0]!.member_ok).toBe(true);
    // `private_board` now reads `visibility`, not `encryption_active` — a board
    // with no audience minted is still private, and saying otherwise here is
    // the same three-state confusion that produced the leak.
    expect(ok.private_board).toBe(true);

    h.db.webhookSubscriptions[0]!["creator_pubkey"] = BOB;
    const revoked = (await (
      await h.app.request(url("webhook.list", { slug: "kb" }), { headers: bearer }, WEBHOOK_ENV)
    ).json()) as { subscriptions: Array<{ member_ok: boolean; enabled: boolean }> };
    // Still enabled — the row is deliberately left alive — but visibly not
    // delivering. Those two facts differing IS the signal.
    expect(revoked.subscriptions[0]!.enabled).toBe(true);
    expect(revoked.subscriptions[0]!.member_ok).toBe(false);
  });

  // A second admin renaming someone else's webhook must not quietly become its
  // gate identity — that would be an authorization transfer disguised as an edit.
  it("does not rebind the creator on PATCH", async () => {
    const h = makeHarness();
    await createBoard(h);
    await registerWebhook(h);
    const id = h.db.webhookSubscriptions[0]!["id"] as string;
    h.db.webhookSubscriptions[0]!["creator_pubkey"] = BOB;

    const res = await h.app.request(
      url("webhook.update", { slug: "kb", id: id }),
      jsonReq("PATCH", { name: "renamed" }),
      WEBHOOK_ENV,
    );

    expect(res.status).toBe(200);
    expect(h.db.webhookSubscriptions[0]!["name"]).toBe("renamed");
    expect(h.db.webhookSubscriptions[0]!["creator_pubkey"]).toBe(BOB);
  });
});

describe("retry ladder", () => {
  it("has one delay per attempt", () => {
    expect(BACKOFF_MS.length).toBe(MAX_ATTEMPTS);
    expect(MAX_ATTEMPTS).toBe(5);
  });

  // Strictly increasing: a flat or non-monotonic ladder would hammer a
  // struggling subscriber at a constant rate instead of backing off.
  it("increases strictly", () => {
    for (let i = 1; i < BACKOFF_MS.length; i += 1) {
      expect(BACKOFF_MS[i]!).toBeGreaterThan(BACKOFF_MS[i - 1]!);
    }
  });

  it("starts at a minute and ends at twelve hours", () => {
    expect(BACKOFF_MS[0]).toBe(60_000);
    expect(BACKOFF_MS[BACKOFF_MS.length - 1]).toBe(43_200_000);
  });
});
