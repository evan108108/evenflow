// EFB-83 — the three github body schemas, and the two coercions they replaced.
//
// Schema-level cases go through `decodeBody`, which exists so a schema can be
// tested without standing up a Context. Wire-level cases go through the app,
// because a reason composed with an element index (`rule-0-priority`) is
// produced by the handler and only observable end to end.
//
// Every predicate below is one the PRE-migration handler enforced by hand. The
// point of the file is that each can be deleted and something fails loudly —
// verified by mutation, not assumed.

import { describe, expect, it, beforeEach } from "vitest";
import { Effect, Exit } from "effect";

import { decodeBody } from "../src/lib/route-body";
import {
  GithubConfigBody,
  GithubRulesBody,
  GithubTestBody,
} from "../src/actions/github";
import { url } from "../src/routes-manifest";
import { makeHarness, bearer, jsonReq, createBoard, type Harness } from "./harness";

const MASTER = "0".repeat(64);
const ENV = { EVENFLOW_WEBHOOK_SECRET: MASTER };

/** The `reason` a schema rejection carries, or null if it decoded. */
const reasonOf = <A, I>(schema: Parameters<typeof decodeBody<A, I>>[0], input: unknown) => {
  const exit = Effect.runSyncExit(decodeBody(schema, input));
  return Exit.isFailure(exit) ? null : "OK";
};

const rejectionOf = <A, I>(schema: Parameters<typeof decodeBody<A, I>>[0], input: unknown) => {
  const exit = Effect.runSyncExit(decodeBody(schema, input));
  if (!Exit.isFailure(exit)) return null;
  const e = exit.cause as unknown as { error?: { reason?: string } };
  return e.error?.reason ?? "failed";
};

describe("GithubConfigBody", () => {
  it("accepts repo: null — null CLEARS the repo, it is not absence", () => {
    expect(reasonOf(GithubConfigBody, { repo: null })).toBe("OK");
  });

  it("accepts external_states: null — same, it clears the config", () => {
    expect(reasonOf(GithubConfigBody, { external_states: null })).toBe("OK");
  });

  // THE ASYMMETRY. Spelling all three fields NullOr — the obvious uniform
  // shape — would make this pass, silently accepting a preset that means
  // nothing. The pre-migration handler answered 400 here and still does.
  it("REJECTS preset: null, where the other two nulls are meaningful", () => {
    expect(rejectionOf(GithubConfigBody, { preset: null })).toBe("preset");
  });

  it("accepts a real preset and rejects an invented one", () => {
    expect(reasonOf(GithubConfigBody, { preset: "status_only" })).toBe("OK");
    expect(rejectionOf(GithubConfigBody, { preset: "aggressive" })).toBe("preset");
  });

  // What the raw reader could never do. `{"repo":"a/b","repoo":"c/d"}` was a
  // 200 that configured nothing — EFB-53's bug at a third callsite.
  it("rejects an unknown key rather than ignoring it", () => {
    expect(rejectionOf(GithubConfigBody, { repo: "o/n", repoo: "typo/here" })).toBe("repoo-unknown");
  });

  it("accepts an empty body — every field is optional", () => {
    expect(reasonOf(GithubConfigBody, {})).toBe("OK");
  });
});

describe("GithubTestBody", () => {
  it('rejects event: "" — the predicate the handler spelled as === ""', () => {
    expect(rejectionOf(GithubTestBody, { event: "", payload: {} })).toBe("event");
  });

  // THE INVERSE OF THE EFB-61/85 TRAP, and the reason this schema does not say
  // NonEmptyString. The hand-rolled guard is `=== ""`, NOT `.trim() !== ""`, so
  // whitespace is a working request today. NonEmptyString trims and would
  // start rejecting it — tightening a contract where the sibling tickets were
  // at risk of loosening one. If someone "tidies" this to NonEmptyString, this
  // test is what stops them.
  it('ACCEPTS event: "   " — whitespace is not empty on this route', () => {
    expect(reasonOf(GithubTestBody, { event: "   ", payload: {} })).toBe("OK");
  });

  // `typeof [] === "object"` and `[] !== null`, so an array satisfies the
  // hand-rolled payload check. Schema.Object would reject it and 400 a shape
  // that works in production today.
  it("ACCEPTS payload: [] — typeof admits an array, so the migration must too", () => {
    expect(reasonOf(GithubTestBody, { event: "push", payload: [] })).toBe("OK");
  });

  it("rejects a non-string event and an unknown key", () => {
    expect(rejectionOf(GithubTestBody, { event: 7, payload: {} })).toBe("event");
    expect(rejectionOf(GithubTestBody, { event: "push", payload: {}, extra: 1 })).toBe(
      "extra-unknown",
    );
  });
});

describe("GithubRulesBody", () => {
  // This schema buys exactly one thing and the test says so plainly: unknown
  // TOP-LEVEL keys. Everything inside the array is index-composed or depends
  // on the board's external-state config, so it stays in the handler.
  it("rejects an unknown top-level key", () => {
    expect(rejectionOf(GithubRulesBody, { rules: [], rulez: 1 })).toBe("rulez-unknown");
  });

  it("passes any rules shape through — the handler owns the per-rule rules", () => {
    expect(reasonOf(GithubRulesBody, { rules: "not an array" })).toBe("OK");
    expect(reasonOf(GithubRulesBody, { rules: [{ anything: true }] })).toBe("OK");
  });
});

// ── quirk 6: the two silent coercions, now loud ──────────────────────────
//
// Wire-level because the reason carries the element index, which only the
// handler can compose.
describe("EFB-83 — priority and enabled no longer swallow garbage", () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness();
    await createBoard(h);
    await h.app.request(
      url("github.config.set", { slug: "kb" }),
      jsonReq("PUT", { repo: "owner/name" }),
      ENV,
    );
  });

  const put = (rules: unknown) =>
    h.app.request(url("github.rules.set", { slug: "kb" }), jsonReq("PUT", { rules }), ENV);

  const rule = (extra: Record<string, unknown>) => ({
    bucket: "match",
    when: { event: "pull_request", action: "opened" },
    do: { type: "no_op", note: "n" },
    ...extra,
  });

  it("400s a non-number priority, naming the element", async () => {
    const res = await put([rule({ priority: "high" })]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("rule-0-priority");
  });

  it("400s a non-boolean enabled, naming the element", async () => {
    const res = await put([rule({ enabled: "no" })]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("rule-0-enabled");
  });

  it("names the RIGHT element when a later rule is the bad one", async () => {
    const res = await put([rule({ priority: 10 }), rule({ priority: null })]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("rule-1-priority");
  });

  // ABSENT still means default. The fix refuses a wrong TYPE, it does not make
  // the fields required — omitting them is the common case and must keep
  // working exactly as it did.
  it("still defaults both when omitted", async () => {
    const res = await put([rule({}), rule({})]);
    expect(res.status).toBe(200);
    const stored = h.db.githubRules;
    expect(stored.map((r) => r["priority"])).toEqual([0, 10]);
    expect(stored.every((r) => r["enabled"] === 1)).toBe(true);
  });

  it("still accepts the well-typed values the web app actually sends", async () => {
    const res = await put([rule({ priority: 20, enabled: false })]);
    expect(res.status).toBe(200);
    expect(h.db.githubRules[0]!["priority"]).toBe(20);
    expect(h.db.githubRules[0]!["enabled"]).toBe(0);
  });
});
