// EFB-63 (Lane B) — Provenance travels route → emit → publish.
//
// EFB-58 (Lane A) put Provenance at the signed-event builder boundary and
// stopped there. Every production callsite reached the builders through
// `publishPlaintextEvent`, which had no Claims in scope, so all of them built
// `ProvenanceFromStoredActor(pubkey)` off an envelope bag and `source` was
// constant `audit.system` at every one. A field with one value discriminates
// nothing: Lane A bought the type, not the safety.
//
// Lane B makes the ROUTE construct the Provenance — where the JWT-authenticated
// caller genuinely is in scope — and passes the value down as an argument.
// `publishPlaintextEvent` therefore never ASSERTS `route.caller`; it forwards
// an assertion made by the one frame entitled to make it.
//
// ── why an argument and not `BoardEvent.payload` ─────────────────────────
//
// The ticket originally specified `payload.actor_provenance`. Three things
// make that the wrong carrier, and each is pinned by a test below:
//
//   1. `BoardEvent` is the SSE wire contract (BoardDO.emit JSON-stringifies it
//      to browsers; web/src/effects/SseStream.ts mirrors it under a compile-time
//      equality assert). Provenance is compile-time only — putting it on the
//      event puts it on a wire.
//   2. `payload` is `unknown`, so any reader must rebuild the struct with an
//      unchecked cast — and a `route.caller` that survives a cast is one
//      asserted with NO Claims in scope. `ProvenanceFromCaller` takes Claims
//      and not a string precisely so that cannot be spelled; a payload
//      round-trip hands the spelling back.
//   3. It is not needed: the publish is awaited inline, so the value the route
//      built reaches the builder untouched.
//
// The general rule, since it recurs: a compile-time-only invariant belongs in
// the function SIGNATURE. Put it in a payload and the type has to be rebuilt at
// every read site, which means every read site can lie.

import { describe, expect, it } from "vitest";
import { url } from "../src/routes-manifest";
import {
  createIssue,
  createPublicBoard,
  jsonReq,
  makeHarness,
  CALLER,
  type Harness,
} from "./harness";
import { KANBAN_PLAINTEXT_PATH, templatesFor } from "../src/lib/kanban/publish";
import {
  ProvenanceFromCaller,
  ProvenanceFromStoredActor,
  ProvenanceFromSystem,
} from "../src/lib/route-body";
import type { BoardEvent } from "../src/durable-objects/BoardDO";
import type { BoardShape } from "../src/shapes";

// `?raw` — read the route sources at build time. See tests/raw.d.ts.
import ISSUES_SRC from "../src/actions/issues.ts?raw";
// EFB-98: comments' emit callsites live in the ACTION module now — the route
// file is a transport shell. A source-scanning guard has to follow the code it
// guards, or it silently starts proving nothing.
import COMMENTS_SRC from "../src/actions/comments.ts?raw";
import GITHUB_SRC from "../src/routes/github.ts?raw";
// EFB-98: boards' emit callsites live in the ACTION module now — the route
// file is a transport shell. Same reason comments moved: a source-scanning
// guard has to follow the code it guards, or it silently starts proving
// nothing. All four are `null` actors (board.created/updated/deleted carry no
// actor slot), so only the path changes; the rule is untouched.
import BOARDS_SRC from "../src/actions/boards.ts?raw";
// Same move for sprints — all ten emit callsites are in the action module now,
// and the two that name a caller are the ones EFB-91 added.
import SPRINTS_SRC from "../src/actions/sprints.ts?raw";
import ATTACHMENTS_SRC from "../src/routes/attachments.ts?raw";
import IMPORTS_SRC from "../src/routes/imports.ts?raw";
import TIDE_SRC from "../src/lib/tide/publish.ts?raw";
import AUDIENCES_SRC from "../src/audiences.ts?raw";

const settle = () => new Promise((r) => setTimeout(r, 0));

const plaintextEvents = (h: Harness) =>
  h.audience.calls
    .filter((c) => c.path === KANBAN_PLAINTEXT_PATH)
    .map(
      (p) =>
        (p.body as { event: { id: string; kind: number; tags: string[][]; content: string } })
          .event,
    );

const contentOf = (ev: { content: string }) => JSON.parse(ev.content) as Record<string, unknown>;

const board = (over: Partial<BoardShape> = {}): BoardShape =>
  ({ id: "b", visibility: "public", encryption_active: false, ...over }) as BoardShape;

// ── 1. the carrier itself ────────────────────────────────────────────────
//
// What `templatesFor` does with each Provenance it can be handed. These are
// the byte-identity proofs: the hard constraint is that a 30552/30553 built
// through Lane B is indistinguishable on the wire from the one EFB-58 built,
// because `source` is compile-time only and must never reach a relay.

describe("EFB-63 — Provenance as a publish argument", () => {
  const transitionEvent: BoardEvent = {
    kind: "issue.transitioned",
    board_id: "b",
    issue_id: "i1",
    status_change_id: "sc1",
    at_ms: 1_760_000_000_000,
    payload: { issue: { title: "t" }, from_status: "Todo", to_status: "In Progress" },
  };

  const statusChangeOf = (actor: Parameters<typeof templatesFor>[2]) => {
    const item = templatesFor(board(), transitionEvent, actor).find(
      (i) => i.template.kind === 30553,
    );
    expect(item).toBeDefined();
    return item!.template;
  };

  it("renders actor_pubkey from the argument's .pubkey", () => {
    const t = statusChangeOf(ProvenanceFromStoredActor("049b628c"));
    expect(contentOf(t).actor_pubkey).toBe("049b628c");
  });

  // The whole point of Lane B: two DIFFERENT sources, one identical wire.
  // If this ever fails, `source` has leaked out of the type system and every
  // golden event the gateway pins cross-repo has drifted.
  it("emits byte-identical events for route.caller and audit.system", () => {
    const claims = { provider: "nostr", oauth_id: "049b628c", login: "x" } as Parameters<
      typeof ProvenanceFromCaller
    >[0];
    const viaCaller = statusChangeOf(ProvenanceFromCaller(claims));
    const viaStored = statusChangeOf(ProvenanceFromStoredActor(ProvenanceFromCaller(claims).pubkey));

    expect(ProvenanceFromCaller(claims).source).toBe("route.caller");
    expect(ProvenanceFromStoredActor("x").source).toBe("audit.system");
    // Same pubkey, different source → the SAME bytes.
    expect(viaCaller).toEqual(viaStored);
    expect(viaCaller.tags.some((t) => t[0]?.startsWith("fa:provenance"))).toBe(false);
    expect(Object.keys(contentOf(viaCaller))).not.toContain("source");
  });

  // `null` is the no-actor-slot marker, and it must render exactly what the
  // pre-EFB-63 publisher rendered when the envelope carried no actor: the
  // empty pubkey. Anything else is a wire change on every tombstone.
  it("renders the empty pubkey for null, matching ProvenanceFromSystem", () => {
    expect(statusChangeOf(null)).toEqual(statusChangeOf(ProvenanceFromSystem()));
    expect(contentOf(statusChangeOf(null)).actor_pubkey).toBe("");
  });

  // The bag read EFB-63 deleted. A payload that still carries `actor_pubkey`
  // must NOT be able to steer attribution — otherwise the argument is
  // decorative and the old hole is still open.
  it("ignores payload.actor_pubkey entirely — the argument is the only source", () => {
    const spoofed: BoardEvent = {
      ...transitionEvent,
      payload: { ...(transitionEvent.payload as object), actor_pubkey: "attacker" },
    };
    const item = templatesFor(board(), spoofed, ProvenanceFromStoredActor("real")).find(
      (i) => i.template.kind === 30553,
    )!;
    expect(contentOf(item.template).actor_pubkey).toBe("real");

    const unattributed = templatesFor(board(), spoofed, null).find((i) => i.template.kind === 30553)!;
    expect(contentOf(unattributed.template).actor_pubkey).toBe("");
  });
});

// ── 2. per-path, end-to-end ──────────────────────────────────────────────
//
// The value that actually reaches the wire when a real route runs. `source`
// is invisible here by design (it never reaches a relay), so these pin the
// PUBKEY — which is what distinguishes a caller-attributed event from a
// system one, and is the half a wrong wiring would get wrong.

describe("EFB-63 — provenance per route path", () => {
  it("attributes a transition's 30553 to the caller", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const issue = await createIssue(h, { title: "Ship it" });
    await settle();

    await h.app.request(
      url("issue.transition", { id: issue.id }),
      jsonReq("POST", { to: "In Progress" }),
      {},
    );
    await settle();

    const row = h.db.statusChanges.find((r) => r["to_status"] === "In Progress")!;
    const change = plaintextEvents(h).find(
      (e) => e.kind === 30553 && e.tags.find((t) => t[0] === "d")?.[1] === row["id"],
    )!;
    expect(contentOf(change).actor_pubkey).toBe(CALLER);
  });

  it("attributes a creation's 30553 to the caller", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const issue = await createIssue(h, { title: "Born" });
    await settle();

    const row = h.db.statusChanges.find((r) => r["issue_id"] === issue.id)!;
    const change = plaintextEvents(h).find(
      (e) => e.kind === 30553 && e.tags.find((t) => t[0] === "d")?.[1] === row["id"],
    )!;
    expect(contentOf(change).actor_pubkey).toBe(CALLER);
  });

  it("attributes a comment's 30552 to its author", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const issue = await createIssue(h);
    await settle();

    await h.app.request(
      url("comment.create", { id: issue.id }),
      jsonReq("POST", { body: "hello" }),
      {},
    );
    await settle();

    const comment = plaintextEvents(h).find((e) => e.kind === 30552)!;
    expect(contentOf(comment).author_pubkey).toBe(CALLER);
    expect(contentOf(comment).deleted).toBe(false);
  });

  // THE TRAP. The ticket listed comment.deleted as an actor-slot event to
  // attach caller provenance to. Doing that publishes a signed, public,
  // unretractable claim that whoever pressed delete AUTHORED the comment —
  // EFB-33's exact failure at a new callsite. A tombstone attributes nobody.
  //
  // It is also the byte-identity guard for this path: the pre-EFB-63 publisher
  // found no comment row on this payload and emitted the empty pubkey too.
  it("does NOT attribute a comment tombstone to the deleter", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const issue = await createIssue(h);
    await settle();

    const created = await h.app.request(
      url("comment.create", { id: issue.id }),
      jsonReq("POST", { body: "delete me" }),
      {},
    );
    const { comment } = (await created.json()) as { comment: { id: string } };
    await settle();

    await h.app.request(url("comment.delete", { id: comment.id }), jsonReq("DELETE", {}), {});
    await settle();

    const tombstone = plaintextEvents(h).find(
      (e) => e.kind === 30552 && contentOf(e).deleted === true,
    )!;
    expect(tombstone).toBeDefined();
    expect(contentOf(tombstone).author_pubkey).toBe("");
    expect(contentOf(tombstone).author_pubkey).not.toBe(CALLER);
  });
});

// ── 3. every callsite states its position ────────────────────────────────
//
// WHY STATIC, in the same spirit as dbMock-dispatch.test.ts (EFB-35): `source`
// is a compile-time device that never reaches the wire, so no runtime
// observation can distinguish `route.caller` from `audit.system` at a callsite
// that happens to carry the same pubkey. The claim "this callsite names the
// caller because the caller was seen" is a property of the CALLSITE, and the
// callsite is where it has to be checked.
//
// This also enforces the constructor-only rule: an inline `{ source: ... }`
// object literal would typecheck and would be exactly the fabricated
// attribution `ProvenanceFromCaller`'s Claims-not-string signature exists to
// prevent, so only the three named constructors and `null` are admissible.

interface Callsite {
  readonly file: string;
  readonly line: number;
  readonly actor: string;
}

const SOURCES: ReadonlyArray<readonly [string, string]> = [
  // EFB-98 fan-out A: the issue emits moved to the action module. This path
  // has to follow them — left pointing at src/routes/issues.ts the guard would
  // have kept passing while scanning a file with no emits left in it, which is
  // the worst failure mode a source-scanning check has.
  ["actions/issues.ts", ISSUES_SRC],
  ["actions/comments.ts", COMMENTS_SRC],
  ["routes/github.ts", GITHUB_SRC],
  ["actions/boards.ts", BOARDS_SRC],
  ["actions/sprints.ts", SPRINTS_SRC],
  ["routes/attachments.ts", ATTACHMENTS_SRC],
  ["routes/imports.ts", IMPORTS_SRC],
  ["lib/tide/publish.ts", TIDE_SRC],
];

/**
 * Pull the actor argument out of every `emitSecureBoardEvent` call.
 *
 * Every callsite is formatted the same way — args one per line, the object
 * literal in the middle — so the actor is the first non-comment line after the
 * `},` that closes the event object, at the call's argument indentation. The
 * extractor understands only that shape and reports anything else as
 * `"<unparsed>"` rather than skipping it: a checker that silently ignores what
 * it does not understand reproduces the bug class it exists to catch.
 */
const extractCallsites = (file: string, src: string): Callsite[] => {
  const lines = src.split("\n");
  const found: Callsite[] = [];
  for (let i = 0; i < lines.length; i++) {
    // The prefix is deliberately open-ended: the tide publisher binds the
    // result (`const eventId = yield* emitSecureBoardEvent(`), and an
    // extractor that only knew the bare `yield*` spelling silently found 31 of
    // 32 — which is exactly the vacuous-pass the scale assertion below exists
    // to catch, and did.
    const open = /^(\s*).*\bemitSecureBoardEvent\($/.exec(lines[i] ?? "");
    if (open === null) continue;
    const argIndent = `${open[1]}  `;
    let actor = "<unparsed>";
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? "";
      if (line === `${open[1]});`) break;
      // The `},` that closes the event object, at argument indentation.
      if (line !== `${argIndent}},`) continue;
      for (let k = j + 1; k < lines.length; k++) {
        const next = (lines[k] ?? "").trim();
        if (next.startsWith("//")) continue;
        actor = next.replace(/,$/, "");
        break;
      }
      break;
    }
    found.push({ file, line: i + 1, actor });
  }
  return found;
};

const CALLSITES = SOURCES.flatMap(([file, src]) => extractCallsites(file, src));

/** Which constructor each callsite is allowed to use, keyed by file:line. */
const expectedActor = (c: Callsite): string | null => {
  if (c.file === "actions/comments.ts") {
    // created → the caller IS the author; deleted → nobody (see the trap above).
    return c.actor.startsWith("ProvenanceFromCaller") ||
      c.actor === "ProvenanceFromSystem()"
      ? c.actor
      : null;
  }
  return null;
};

describe("EFB-63 — every emit callsite names its actor", () => {
  // If the formatter or a refactor changes the callsite shape, the extractor
  // could quietly match nothing and every assertion below would vacuously
  // pass. Pin the scale so that failure is loud.
  it("finds every emitSecureBoardEvent callsite", () => {
    // 32 before EFB-98. Folding POST /issues/:id/duplicate-of into
    // PATCH /issue/:id deleted that route's two emits — the set/clear pair —
    // because PATCH already published for the same edit.
    expect(CALLSITES.length).toBe(30);
    expect(CALLSITES.filter((c) => c.actor === "<unparsed>")).toEqual([]);
  });

  // The constructor-only rule. An inline `{ source: "route.caller", pubkey: x }`
  // typechecks and is precisely the fabrication the Claims-not-string signature
  // exists to prevent, so the literal spelling is what gets banned.
  it("uses only the named constructors or an explicit null", () => {
    // A callsite may GUARD a constructor behind a boolean it already computed
    // — `moved ? … : null`, `statusChangeId === null ? null : …` — because one
    // handler can emit on two paths and only one of them attributes anything.
    // Both arms still have to be a constructor or `null`, which is the rule
    // that matters: what is banned is an inline object literal, and a ternary
    // between two admissible values cannot smuggle one in.
    // EFB-98: `ProvenanceFromCaller(input.claims)` is admitted alongside
    // `(claims)`. An action reads its caller off the input record rather than
    // off a Context, and the constructor is the same one — widening the
    // spelling keeps the rule (a NAMED constructor, never an inline literal)
    // exactly as strict.
    const CONSTRUCTOR = String.raw`null|ProvenanceFromCaller\((?:input\.)?claims\)|ProvenanceFromSystem\(\)|ProvenanceFromStoredActor\(actor\)`;
    const ADMISSIBLE = new RegExp(
      `^(?:${CONSTRUCTOR}|[A-Za-z0-9_.]+(?: === null)? \\? (?:${CONSTRUCTOR}) : (?:${CONSTRUCTOR}))$`,
    );
    const offenders = CALLSITES.filter((c) => !ADMISSIBLE.test(c.actor));
    expect(offenders).toEqual([]);
  });

  // The guard above is only safe because it is narrow. An inline literal in
  // either arm must still be caught.
  it("rejects a fabricated literal even inside a guard", () => {
    const CONSTRUCTOR = String.raw`null|ProvenanceFromCaller\((?:input\.)?claims\)|ProvenanceFromSystem\(\)|ProvenanceFromStoredActor\(actor\)`;
    const ADMISSIBLE = new RegExp(
      `^(?:${CONSTRUCTOR}|[A-Za-z0-9_.]+(?: === null)? \\? (?:${CONSTRUCTOR}) : (?:${CONSTRUCTOR}))$`,
    );
    expect(ADMISSIBLE.test('{ source: "route.caller", pubkey: x }')).toBe(false);
    expect(ADMISSIBLE.test('moved ? { source: "route.caller", pubkey: x } : null')).toBe(false);
    expect(ADMISSIBLE.test("moved ? ProvenanceFromCaller(claims) : null")).toBe(true);
  });

  // The seven provenance-consuming paths, pinned individually. These are the
  // only callsites whose actor argument reaches a builder; everything else
  // passes `null` because its kind has no actor slot.
  //
  // EFB-91 added the two sprint ones. They were passing `null` while ALSO
  // writing statusChangeCache rows whose ids never reached the event, so they
  // published no 30553 at all — and had the id been threaded without this
  // change, every sprint-driven move would have gone out attributed to
  // `audit.system` rather than the person who started the sprint.
  it("names route.caller exactly where a live caller was seen", () => {
    const callerSites = CALLSITES.filter((c) => c.actor.includes("ProvenanceFromCaller"));
    expect(callerSites.map((c) => c.file).sort()).toEqual([
      // EFB-98 moved two families under actions/, which sorts ahead of routes/.
      // The SET is unchanged — same seven paths, same reasons.
      "actions/comments.ts", // comment.created — caller is the author
      "actions/issues.ts", // issue.created
      "actions/issues.ts", // issue.transitioned
      "actions/issues.ts", // issue.transitioned (duplicate-of, when it moved)
      "actions/issues.ts", // issue.container_changed
      "actions/sprints.ts", // sprint start — backlog → active bulk promote
      "actions/sprints.ts", // attach mid-sprint — backlog → active promote
    ]);
  });

  it("never names route.caller on the github webhook path", () => {
    const github = CALLSITES.filter((c) => c.file === "routes/github.ts");
    expect(github).toHaveLength(1);
    // The webhook's authenticated caller is GitHub, not the person who moved
    // the card. `actor` is a resolved `github:<login>` the server re-attests.
    expect(github[0]!.actor).toBe("ProvenanceFromStoredActor(actor)");
  });

  it("attributes nobody on the comment tombstone", () => {
    const comments = CALLSITES.filter((c) => c.file === "actions/comments.ts");
    expect(comments.map((c) => expectedActor(c))).toEqual([
      // EFB-98: same constructor, reading the caller off the action input.
      "ProvenanceFromCaller(input.claims)",
      "ProvenanceFromSystem()",
    ]);
  });
});

// ── 4. the type-level closure ────────────────────────────────────────────
//
// `@ts-expect-error` asserts a COMPILE error: an unused one is itself a tsc
// error, so a clean typecheck is positive evidence that each substitution
// below still fails. Deliberately never executed — the type check IS the
// assertion, and running these would only prove the runtime tolerates
// garbage, which is the property we do not care about.

describe("EFB-63 — the substitutions that must not compile", () => {
  it("rejects a bare string, a missing argument, and a payload-carried struct", () => {
    const event: BoardEvent = {
      kind: "issue.transitioned",
      board_id: "b",
      issue_id: "i",
      at_ms: 1,
      payload: {},
    };
    const pubkey = "049b-somebody-else";

    const bareString = () =>
      // @ts-expect-error — a bare pubkey string is not a Provenance. This is
      // the substitution EFB-33 shipped, now blocked one layer further out
      // than EFB-58 blocked it.
      templatesFor(board(), event, pubkey);

    const missingArgument = () =>
      // @ts-expect-error — the actor is REQUIRED. An emit that says nothing
      // about its actor is the state this ticket exists to make unspellable;
      // an optional parameter would let a callsite reach it by forgetting.
      templatesFor(board(), event);

    const noSource = () =>
      // @ts-expect-error — a pubkey without a `source` is not a Provenance.
      // Naming the semantic role is the requirement, not carrying a string.
      templatesFor(board(), event, { pubkey });

    const bagRead = () =>
      // @ts-expect-error — `payload` is `unknown`; it cannot be spent as a
      // Provenance without a cast, and the cast is the hole. This is the
      // shape the ticket originally specified.
      templatesFor(board(), event, event.payload);

    expect([bareString, missingArgument, noSource, bagRead]).toHaveLength(4);
  });
});
