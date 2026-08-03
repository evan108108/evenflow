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

import { spawnSync } from "node:child_process";
import { url } from "../src/routes-manifest";
import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import type { IssueShape } from "../src/shapes";
import { createBoard, createIssue, jsonReq, makeHarness, seedBoardMember } from "./harness";
import {
  IdentityRefFromInput,
  ImmutableField,
  Provenance,
  ProvenanceFromCaller,
  ProvenanceFromExternalActor,
  ProvenanceFromStoredActor,
  ProvenanceFromSystem,
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
  const res = await h.app.request(url("issue.get", { id: issue.id }), jsonReq("PATCH", body), {});
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

  // EFB-58 — the three construction sites. Each names a different claim about
  // where a pubkey came from, and the point of having three is that picking one
  // is a decision the author has to make out loud.
  it("the Provenance constructors each assert a different claim", () => {
    const claims = {
      provider: "nostr",
      oauth_id: HEX,
      login: "evan",
      iat: 0,
      exp: 0,
    } as const;

    // Takes Claims, never a pubkey — so it structurally cannot be handed some
    // other person's key. That is the EFB-33 near-miss made unrepresentable.
    expect(ProvenanceFromCaller(claims)).toEqual({
      source: "route.caller",
      pubkey: `nostr:${HEX}`,
    });

    // No argument at all: an event with no human actor has nobody to name, and
    // the empty pubkey is what the pre-EFB-58 builders already put on the wire.
    expect(ProvenanceFromSystem()).toEqual({ source: "audit.system", pubkey: "" });

    // Same source, but re-attesting a stored identity rather than claiming
    // there is none — a republished comment still belongs to its author.
    expect(ProvenanceFromStoredActor(HEX)).toEqual({
      source: "audit.system",
      pubkey: HEX,
    });

    // EFB-92. The fourth literal, and the distinction it buys: this is NOT
    // `audit.system`, because Sonata did not act — an integration outside this
    // system did. Same bare-string shape as ProvenanceFromStoredActor, and the
    // safety is the same kind: the NAME reads false if you hand it an internal
    // pubkey. No `platform` argument — that is the pubkey's prefix already.
    expect(ProvenanceFromExternalActor("github:alice")).toEqual({
      source: "external.webhook",
      pubkey: "github:alice",
    });
    // The delivery that named no author. `github:webhook` is the integration
    // acting as itself, and it is still an EXTERNAL origin — routing it to
    // audit.system would be the same "Sonata acted" claim this literal exists
    // to stop making.
    expect(ProvenanceFromExternalActor("github:webhook").source).toBe("external.webhook");
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

// ── the checker itself, run as a subprocess (EFB-87) ──────────────────────
//
// Everything above tests the SCHEMA. Nothing tested the tool that decides which
// routes have one — `check:boundary` shipped in EFB-54 with no test that runs
// it, and only the query half got fixtures. So the older and more
// security-relevant of the two checks was the one trusted purely because it had
// been observed passing, which is indistinguishable from a check that cannot
// fail: if the marker list stops matching or the registration regex misses
// every route, the output is a cheerful OK either way.

const F = "tests/fixtures/boundary-discipline";

/**
 * Run the checker against a routes dir; never throws, returns exit + output.
 *
 * `spawnSync` rather than `execFileSync`, because the acknowledged-debt lines
 * go to stderr while the OK line goes to stdout, and execFileSync hands back
 * stdout ALONE on a zero exit. A success-path assertion about a warning would
 * have been checking a stream it could not see.
 */
const runChecker = (routesDir: string, allowlist = `${F}/none.json`) => {
  const r = spawnSync(
    process.execPath,
    [
      "scripts/check-boundary-discipline.mjs",
      "--routes-dir",
      routesDir,
      "--allowlist",
      allowlist,
    ],
    {
      encoding: "utf8",
      // Fixture entries carry sunsets, so "today" is pinned. Left to the real
      // clock these turn red on a calendar boundary rather than on a
      // regression, and a test that fails for a reason nobody changed is one
      // people learn to re-run rather than read.
      env: { ...process.env, BOUNDARY_TODAY: "2026-09-01" },
    },
  );
  return { code: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
};

describe("the body ratchet can fail — proven, not assumed", () => {
  // `none.json` does not exist, deliberately: fixtures stand or fall on the
  // code rather than on an exemption.
  it("FAILS on a synthetic un-migrated handler, naming the route", () => {
    const { code, output } = runChecker(`${F}/unmigrated`);
    expect(code).toBe(1);
    expect(output).toContain("POST /synthetic/unmigrated");
    expect(output).toContain("without parseRouteBody");
  });

  it("PASSES on the same route once migrated", () => {
    const { code, output } = runChecker(`${F}/migrated`);
    expect(code).toBe(0);
    expect(output).toContain("1 migrated");
  });

  it("passes against the real routes directory", () => {
    const { code, output } = runChecker("src/routes", "scripts/boundary-allowlist.json");
    expect(code).toBe(0);
    expect(output).toContain("[boundary] OK");
  });
});

// ── EFB-87: the allowlist is re-audited, so it cannot go inert ────────────
//
// The hole. Detection and the allowlist were only ever checked in one
// direction — detection found debt, the allowlist excused it — so nothing asked
// whether an entry still described anything real. For an UNallowlisted route,
// losing the marker failed loudly; for an allowlisted one it passed in silence.
// The allowlist bought quiet about exactly the routes the tool knew least
// about, and the check went on printing OK for a scan that had stopped looking.

describe("EFB-87 — an allowlist entry must still describe detected debt", () => {
  // The ticket's falsification case, and what an ordinary migration produces
  // when step 4 (remove the route from the allowlist) gets skipped.
  it("FAILS on an entry for a route that already reads through parseRouteBody", () => {
    const { code, output } = runChecker(`${F}/migrated`, `${F}/allowlist-stale-migrated.json`);
    expect(code).toBe(1);
    expect(output).toContain("POST /synthetic/migrated");
    expect(output).toContain("reads its body through parseRouteBody");
  });

  // The drift class EFB-61 named. The single stale entry is the symptom; that
  // the message names UNMIGRATED_MARKERS as a suspect is the point, because a
  // rename stops every entry on the list from being checked at the same moment.
  it("FAILS when no marker matches, and says the marker list may be stale", () => {
    const { code, output } = runChecker(`${F}/renamed-marker`, `${F}/allowlist-stale-renamed.json`);
    expect(code).toBe(1);
    expect(output).toContain("POST /synthetic/renamed");
    expect(output).toContain("UNMIGRATED_MARKERS is now stale");
  });

  // Same fixture, no entry: this is the asymmetry that made it a bug. Without
  // the allowlist the checker already refused to infer safety from silence —
  // WITH it, the route passed. The excuse was doing the opposite of its job.
  it("had always failed on that same route when it was NOT allowlisted", () => {
    const { code, output } = runChecker(`${F}/renamed-marker`);
    expect(code).toBe(1);
    expect(output).toContain("no body read detected, but that is not proof there is none");
  });

  it("FAILS on an entry naming a route the scan cannot see", () => {
    const { code, output } = runChecker(`${F}/migrated`, `${F}/allowlist-dangling.json`);
    expect(code).toBe(1);
    expect(output).toContain("POST /synthetic/gone");
    expect(output).toContain("matches no route this scan can see");
  });

  // The hatch has to be provable, not merely present: one nobody can
  // demonstrate opening is one the next person routes around by deleting the
  // check. It costs a written sentence, so it stays disputable in review.
  it("PASSES on the same entry once the blind spot is declared in writing", () => {
    const { code, output } = runChecker(`${F}/renamed-marker`, `${F}/allowlist-blind-declared.json`);
    expect(code).toBe(0);
    expect(output).toContain("declared: Reads its body through readRequestBody");
  });

  it("still counts a declared-blind route as debt, not as reading no body", () => {
    const { output } = runChecker(`${F}/renamed-marker`, `${F}/allowlist-blind-declared.json`);
    expect(output).toContain("1 allowlisted");
    expect(output).toContain("0 read no body");
  });

  // An empty reason would silence the re-audit while recording nothing a
  // reviewer could argue with — the form of a declaration with none of the cost.
  it("rejects an empty scanner_blind_reason rather than honouring it", () => {
    const { code, output } = runChecker(`${F}/renamed-marker`, `${F}/allowlist-blind-empty.json`);
    expect(code).toBe(1);
    expect(output).toContain('empty "scanner_blind_reason"');
  });
});
