// EFB-54 — the four boundary invariants, asserted against the reference route.
//
// These are the executable half of docs/BOUNDARY_DISCIPLINE.md. Each describe
// below is one invariant from that doc, and each is a property of the SCHEMA
// rather than of handler code: nothing in PATCH /issues/:id checks for unknown
// keys, and it rejects them anyway. That is the whole claim of the pattern, so
// it is the thing worth testing.
//
// The unknown-key group also closes EFB-53, which was filed as an open bug and
// had no tests of its own. Before this migration the case at the top of that
// group returned 200 and silently dropped the field.

import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import type { IssueShape } from "../src/shapes";
import { createBoard, createIssue, jsonReq, makeHarness, seedBoardMember } from "./harness";
import {
  IdentityRefFromInput,
  ImmutableField,
  Provenance,
  ShortId,
  Uuid,
  decodeBody,
  requireAnyOf,
} from "../src/lib/route-body";

const HEX = "049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2";
const CANON = `nostr:${HEX}`;

/** PATCH the reference route and return { status, reason }. */
const patch = async (body: Record<string, unknown>) => {
  const h = makeHarness();
  await createBoard(h);
  const boardId = h.db.boards[0]!["id"] as string;
  seedBoardMember(h, boardId, CANON, "contributor");
  const issue = await createIssue(h, { title: "Original" });
  const res = await h.app.request(`/api/v0/issues/${issue.id}`, jsonReq("PATCH", body), {});
  const json = (await res.json()) as { reason?: string; issue?: IssueShape };
  return { status: res.status, reason: json.reason, issue: json.issue, h, id: issue.id };
};

// ── invariant 1: unknown keys are rejected (closes EFB-53) ────────────────

describe("invariant 1 — unknown keys are rejected, and named", () => {
  // THE EFB-53 case. Pre-migration this returned 200 with the change applied
  // and `assignee` silently discarded — a caller who meant to assign somebody
  // got a success and an unassigned issue.
  it("400s on a key that is not part of the model", async () => {
    const { status, reason } = await patch({ title: "Renamed", assignee: HEX });
    expect(status).toBe(400);
    expect(reason).toBe("assignee-unknown");
  });

  it("names the offending key so a typo is self-diagnosing", async () => {
    const { reason } = await patch({ titl: "typo" });
    expect(reason).toBe("titl-unknown");
  });

  it("rejects rather than applying the valid part of a mixed body", async () => {
    const { status, h, id } = await patch({ title: "Renamed", nope: 1 });
    expect(status).toBe(400);
    // The whole request fails: a partial apply would be a quieter version of
    // the same bug.
    expect(h.db.issues.find((r) => r["id"] === id)?.["title"]).toBe("Original");
  });

  // Immutable fields are real columns, so they get the more useful answer.
  it("distinguishes a real-but-unwritable field from an unknown one", async () => {
    expect((await patch({ sprint_id: "s1" })).reason).toBe("sprint_id-immutable");
    expect((await patch({ position: 5 })).reason).toBe("position-immutable");
  });
});

// ── invariant 2: wrong types are rejected ─────────────────────────────────

describe("invariant 2 — wrong types are rejected, and named", () => {
  it("400s naming the field for a string where an int belongs", async () => {
    const { status, reason } = await patch({ priority: "high" });
    expect(status).toBe(400);
    expect(reason).toBe("priority");
  });

  it("does not coerce a numeric string into a number", async () => {
    expect((await patch({ estimate: "3" })).reason).toBe("estimate");
  });

  it("rejects a non-string inside an array field", async () => {
    expect((await patch({ labels: ["ok", 7] })).reason).toBe("labels");
  });

  it("rejects a value outside a closed vocabulary", async () => {
    expect((await patch({ type: "epic" })).reason).toBe("type");
  });
});

// ── invariant 3: required-but-missing is rejected ─────────────────────────

describe("invariant 3 — a body that says nothing is rejected", () => {
  it("400s on an empty patch rather than 200-ing a no-op", async () => {
    const { status, reason } = await patch({});
    expect(status).toBe(400);
    expect(reason).toBe("empty-patch");
  });

  it("400s when every key present is unwritable", async () => {
    expect((await patch({ id: "x" })).reason).toBe("id-immutable");
  });
});

// ── invariant 4: output is canonical ──────────────────────────────────────

describe("invariant 4 — the schema returns the canonical form", () => {
  it("normalizes a raw hex identity before it reaches the handler", async () => {
    const { status, issue, h, id } = await patch({ assignee_pubkey: HEX });
    expect(status).toBe(200);
    expect(issue?.assignee_pubkey).toBe(CANON);
    // Stored canonical too — the point is that no second spelling exists.
    expect(h.db.issues.find((r) => r["id"] === id)?.["assignee_pubkey"]).toBe(CANON);
  });

  it("leaves an already-canonical value untouched", async () => {
    const { issue } = await patch({ assignee_pubkey: CANON });
    expect(issue?.assignee_pubkey).toBe(CANON);
  });

  it("still separates shape from roster membership", async () => {
    // Well-formed, canonical, and not on this board: shape passes, authz
    // fails, and the two answer with different reasons on purpose.
    const stranger = "nostr:1111111111111111111111111111111111111111111111111111111111111111";
    expect((await patch({ assignee_pubkey: stranger })).reason).toBe("not-a-member");
    expect((await patch({ assignee_pubkey: "not-a-key" })).reason).toBe("assignee_pubkey");
  });
});

// ── the composable primitives, unit-tested without a database ────────────

describe("primitives are pure — no Db, no Context, no harness", () => {
  const decode = <A, I>(schema: Schema.Schema<A, I, never>, input: unknown) =>
    Effect.runPromise(
      decodeBody(schema, input).pipe(
        Effect.map((v) => ({ ok: v as unknown })),
        Effect.catchAll((e) => Effect.succeed({ reason: e.reason })),
      ),
    );

  it("IdentityRefFromInput canonicalizes every accepted spelling", async () => {
    const S = Schema.Struct({ p: IdentityRefFromInput });
    expect(await decode(S, { p: HEX })).toEqual({ ok: { p: CANON } });
    expect(await decode(S, { p: CANON })).toEqual({ ok: { p: CANON } });
    expect(await decode(S, { p: "nonsense" })).toEqual({ reason: "p" });
  });

  it("Provenance keeps the actor's source explicit (EFB-33)", async () => {
    expect(await decode(Provenance, { source: "route.caller", pubkey: HEX })).toEqual({
      ok: { source: "route.caller", pubkey: CANON },
    });
    // A bare string is exactly what EFB-33 shipped; the struct makes the
    // substitution impossible to perform silently.
    expect(await decode(Provenance, { source: "whatever", pubkey: HEX })).toEqual({
      reason: "source",
    });
  });

  it("Uuid and ShortId reject each other's forms", async () => {
    const U = Schema.Struct({ v: Uuid });
    const S = Schema.Struct({ v: ShortId });
    expect(await decode(U, { v: "EFB-54" })).toEqual({ reason: "v" });
    expect(await decode(S, { v: "550e8400-e29b-41d4-a716-446655440000" })).toEqual({
      reason: "v",
    });
    expect(await decode(S, { v: "EFB-54" })).toEqual({ ok: { v: "EFB-54" } });
  });

  it("requireAnyOf fires only when no listed key is present", async () => {
    const S = Schema.Struct({
      a: Schema.optional(Schema.String),
      locked: ImmutableField,
    }).pipe(Schema.filter(requireAnyOf(["a"])));
    expect(await decode(S, {})).toEqual({ reason: "empty-patch" });
    expect(await decode(S, { a: "x" })).toEqual({ ok: { a: "x" } });
    expect(await decode(S, { locked: 1 })).toEqual({ reason: "locked-immutable" });
  });
});
