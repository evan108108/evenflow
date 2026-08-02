// EFB-71 — the query-param ratchet, and the proof that it can fail.
//
// Two halves, and the second is the one that matters.
//
// The first asserts the pure wrapper's behavior: `parseRouteQuery`'s schema
// rejects unknown keys and names them, exactly as `parseRouteBody`'s does.
//
// The second runs `scripts/check-boundary-query.mjs` against synthetic route
// fixtures and asserts it EXITS NON-ZERO on an un-migrated handler and zero on
// a migrated one. A CI check that has only ever been observed passing is
// indistinguishable from a check that cannot fail — if the marker list stops
// matching, or the registration regex silently misses every route, the output
// is a cheerful OK either way. Pinning the failure here means the guard's own
// decay is a red test rather than a quiet green one.
//
// This is the sharper form of "a check must prove it fails": not a transcript
// pasted into a PR once, but a proof that re-runs on every CI.

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { QueryString, decodeQuery } from "../src/lib/route-body";
import { bearer, createBoard, makeHarness } from "./harness";

/**
 * Run the checker against a routes dir; never throws, returns exit + output.
 *
 * Fixtures run with a deliberately ABSENT allowlist — they must stand or fall
 * on the code, not on an exemption. The real-routes case passes the real one,
 * because that is the run CI actually performs.
 */
const runChecker = (
  routesDir: string,
  allowlist = "tests/fixtures/boundary-query/no-allowlist.json",
) => {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["scripts/check-boundary-query.mjs", "--routes-dir", routesDir, "--allowlist", allowlist],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, output: stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, output: `${e.stdout}${e.stderr}` };
  }
};

describe("the ratchet can fail — proven, not assumed", () => {
  it("FAILS on a synthetic un-migrated handler, naming the route", () => {
    const { code, output } = runChecker("tests/fixtures/boundary-query/unmigrated");
    expect(code).toBe(1);
    expect(output).toContain("GET /synthetic/unmigrated");
    expect(output).toContain("without parseRouteQuery");
  });

  it("PASSES on the same route once migrated", () => {
    const { code, output } = runChecker("tests/fixtures/boundary-query/migrated");
    expect(code).toBe(0);
    expect(output).toContain("1 migrated");
  });

  // The blind spot is part of the contract, so it is pinned like one. If this
  // line ever disappears, silence has quietly been upgraded to a clean bill of
  // health — which is the failure this check's design note exists to prevent.
  it("always reports its own blind spot on success", () => {
    const { output } = runChecker("tests/fixtures/boundary-query/migrated");
    expect(output).toContain("that is not proof they read none");
  });

  it("passes against the real routes directory", () => {
    const { code, output } = runChecker("src/routes", "scripts/boundary-query-allowlist.json");
    expect(code).toBe(0);
    expect(output).toContain("[boundary-query] OK");
  });
});

// ── the wrapper itself, unit-tested without a Context ─────────────────────

describe("parseRouteQuery's schema rejects what c.req.query() accepted", () => {
  const Q = Schema.Struct({ status: QueryString, column_id: QueryString });
  const decode = (input: unknown) =>
    Effect.runPromise(
      decodeQuery(Q, input).pipe(
        Effect.map((v) => ({ ok: v as unknown })),
        Effect.catchAll((e) => Effect.succeed({ reason: e.reason })),
      ),
    );

  it("names the unknown key, so a wrong field name is self-diagnosing", async () => {
    expect(await decode({ status_id: "x" })).toEqual({ reason: "status_id-unknown" });
  });

  it("accepts the declared keys", async () => {
    expect(await decode({ status: "Todo" })).toEqual({ ok: { status: "Todo" } });
    expect(await decode({})).toEqual({ ok: {} });
  });

  it("rejects the whole query rather than the valid part of it", async () => {
    expect(await decode({ status: "Todo", nope: "1" })).toEqual({ reason: "nope-unknown" });
  });

  it("reports every unknown key, not just the first", async () => {
    const r = (await decode({ a: "1", b: "2" })) as { reason: string };
    expect(r.reason).toContain("a-unknown");
    expect(r.reason).toContain("b-unknown");
  });
});

// ── the reference route, end to end ───────────────────────────────────────

describe("GET /boards/:slug/issues — the route that misled a caller", () => {
  const list = async (query: string) => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request(`/api/v0/boards/kb/issues?${query}`, { headers: bearer }, {});
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  // THE EFB-71 CASE. Prod answered 200 and the full unfiltered list for this,
  // byte-identical to sending no query at all, because `status_id` is not a
  // field — the real one is `column_id`. The caller read a filtered-looking
  // answer that was never filtered and concluded something false about the data.
  it("400s on ?status_id=, the param that does not exist", async () => {
    const { status, body } = await list("status_id=deadbeef");
    expect(status).toBe(400);
    expect(body["reason"]).toBe("status_id-unknown");
  });

  // A GET carries no body; telling its caller the BODY was invalid sent them
  // to look at something they never wrote.
  it("says invalid-query, not invalid-body", async () => {
    const { body } = await list("status_id=deadbeef");
    expect(body["error"]).toBe("invalid-query");
  });

  it("names the offending key even alongside valid filters", async () => {
    const { status, body } = await list("container=active&limit=50&colunm_id=c1");
    expect(status).toBe(400);
    expect(body["reason"]).toBe("colunm_id-unknown");
  });

  // Regression: every param the SPA actually sends still works. web/src/pages/
  // board/store.ts builds container + limit + column_id + after; the filter UI
  // adds status, assignee, label, sprint_id, q.
  it("still accepts every param real callers send", async () => {
    for (const q of [
      "container=active&limit=50",
      "status=Todo",
      "assignee=nostr:abc",
      "label=bug",
      "sprint_id=s1",
      "q=login",
      "status=Todo&container=active",
    ]) {
      const { status } = await list(q);
      expect(status, `query: ${q}`).toBe(200);
    }
  });

  it("accepts a request with no query at all", async () => {
    expect((await list("")).status).toBe(200);
  });
});
