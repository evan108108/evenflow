// EFB-104 — the BoardEvent ratchet, and the proof that it can fail.
//
// The real tree has no missing emits today. That is a good state to be in and
// a dangerous one to build a check on: every assertion about
// `check:board-events` would pass equally well against a script whose route
// scan matched nothing at all. So the failure path is exercised on synthetic
// fixtures on every CI run, not demonstrated once by hand in a PR.
//
// The same discipline tests/boundary-query.test.ts states, applied to the
// question "did anybody tell the open boards?".

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const FIXTURES = "tests/fixtures/board-events";

/** Run the checker; never throws, returns exit code + combined output. */
const runChecker = (args: readonly string[] = []) => {
  // spawnSync, not execFileSync: failures go to stderr while the summary goes
  // to stdout, and execFileSync returns stdout alone on a zero exit — so a
  // success-path assertion would be reading a stream it cannot see.
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/check-board-events.mjs", ...args],
    { encoding: "utf8" },
  );
  // `output` is both streams because failures print to stderr and the summary
  // to stdout. `stdout` is kept separate for --json: --experimental-strip-types
  // writes an ExperimentalWarning to stderr, and folding that in makes the
  // report unparseable for a reason that has nothing to do with the check.
  return { code: r.status ?? 1, output: `${r.stdout}${r.stderr}`, stdout: r.stdout };
};

const onFixture = (manifest: string) =>
  runChecker([
    "--routes-dir",
    `${FIXTURES}/synthetic`,
    "--src-dir",
    `${FIXTURES}/synthetic`,
    "--manifest-json",
    `${FIXTURES}/${manifest}`,
  ]);

describe("the BoardEvent ratchet can fail — proven, not assumed", () => {
  it("FAILS on a board-mutating route that emits nothing, naming it", () => {
    const { code, output } = onFixture("manifest-silent.json");
    expect(code).toBe(1);
    expect(output).toContain("synthetic.silent");
    expect(output).toContain("never reaches emitSecureBoardEvent");
  });

  it("PASSES on the same shape once it emits", () => {
    const { code, output } = onFixture("manifest-emitting.json");
    expect(code).toBe(0);
    expect(output).toContain("synthetic.emitting");
  });

  // The emit in the fixture sits two calls below the handler. If the walk ever
  // regresses to grepping the handler span, this route reads as silent and the
  // test above turns red — which is how the archive false-positive would have
  // been caught before it shipped rather than by reading the source.
  it("follows the call graph, not just the handler body", () => {
    const { output } = onFixture("manifest-emitting.json");
    expect(output).toMatch(/synthetic\.emitting\s+POST\s+emits/);
  });

  it("FAILS when a NO_EMIT exemption has gone stale", () => {
    // The fixture registers a route under a real, exempted id, and emits.
    // An exemption nobody re-checks is the one entry that can silently
    // un-check a route forever.
    const { code, output } = onFixture("manifest-stale-declaration.json");
    expect(code).toBe(1);
    expect(output).toContain("declared in NO_EMIT but DOES emit");
  });
});

describe("the real tree", () => {
  it("passes, and says out loud what it did not check", () => {
    const { code, output } = runChecker();
    expect(code).toBe(0);
    // The narrowed scope is deliberate (board domain only). Printing the
    // excluded count on every run keeps that a decision a reader can question
    // rather than an assumption buried in the source.
    expect(output).toMatch(/board-domain mutating routes emit a BoardEvent/);
    expect(output).toMatch(/outside the board domain and not checked/);
  });

  it("holds every board-domain mutating route to account", () => {
    const { stdout } = runChecker(["--json"]);
    const report = JSON.parse(stdout) as {
      counts: { inScope: number; emitting: number; declared: number };
    };
    // emitting + declared === inScope is the invariant that makes the summary
    // readable: no route is in scope and unaccounted for.
    expect(report.counts.emitting + report.counts.declared).toBe(report.counts.inScope);
    expect(report.counts.inScope).toBeGreaterThan(0);
  });
});
