// EFB-13 — outbound webhook subscriptions.
//
// Everything here tests a PURE surface: the schemas, the leak guard, the match
// predicate, and the retry ladder. That is deliberate and it is the payoff of
// the Boundary Discipline split — the shape rules and the authorization rule
// are both reachable without a database or a live router, so they can be
// asserted directly instead of inferred from an HTTP status.

import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { decodeBody } from "../src/lib/route-body";
import {
  BOARD_EVENT_KINDS,
  PatchSubscriptionBody,
  PostSubscriptionBody,
  requirePredicateAllowed,
} from "../src/routes/webhooks";
import type { BoardEventKind } from "../src/durable-objects/board-events";
import {
  BACKOFF_MS,
  MAX_ATTEMPTS,
  matchesSubscription,
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
