// EFB-104 — the SSE reconnect policy, pinned as a delay sequence.
//
// This is the root cause of EFB-102 and it was invisible in review: the old
// policy read as `Schedule.exponential("1 second")`, which looks like textbook
// backoff and is textbook backoff, right up until nobody caps it. Nothing
// about the expression says "this tab will wait 34 minutes".
//
// Asserting the SEQUENCE rather than "it retries" is the point. A test that
// only proved retries happen would pass against the unbounded version, which
// is the version that shipped the bug.

import { describe, expect, it } from "vitest";
import { Chunk, Duration, Effect, Schedule } from "effect";
import { MAX_RECONNECT_DELAY, RECONNECT_POLICY } from "./SseStream";

/** The delay before each successive reconnect attempt, in ms. */
const delaysOf = (schedule: Schedule.Schedule<unknown, number>, n: number): number[] =>
  Chunk.toReadonlyArray(
    Effect.runSync(
      Schedule.run(Schedule.delays(schedule), 0, Array.from({ length: n }, (_, i) => i)),
    ),
  ).map(Duration.toMillis);

const capMs = Duration.toMillis(Duration.decode(MAX_RECONNECT_DELAY));

describe("SSE reconnect policy", () => {
  it("backs off exponentially, then stops at the cap", () => {
    expect(delaysOf(RECONNECT_POLICY, 12)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000, 30000,
    ]);
  });

  it("never waits longer than the cap, however long the tab has been open", () => {
    // 200 failures stands in for a tab left open for days across deploys, DO
    // evictions and sleep/wake. The uncapped policy reaches ~10^57 ms here;
    // that is not a slow reconnect, it is a tab that never reconnects again.
    const delays = delaysOf(RECONNECT_POLICY, 200);
    expect(Math.max(...delays)).toBe(capMs);
  });

  it("is strictly better than the uncapped policy it replaced", () => {
    // The discriminator. Both policies are identical for the first five
    // attempts, so a test that stopped there would pass against the bug.
    const old = delaysOf(Schedule.exponential("1 second"), 12);
    const now = delaysOf(RECONNECT_POLICY, 12);

    expect(now.slice(0, 5)).toEqual(old.slice(0, 5));
    expect(old[8]).toBeGreaterThan(4 * 60_000); // 9th attempt: 4m16s — EFB-102's symptom
    expect(now[8]).toBe(capMs);
    for (let i = 0; i < now.length; i += 1) expect(now[i]!).toBeLessThanOrEqual(old[i]!);
  });

  it("still recovers fast from a single blip", () => {
    // Capping must not make the common case worse: one drop still reconnects
    // in a second, which is what keeps a collaborator's move feeling live.
    expect(delaysOf(RECONNECT_POLICY, 1)).toEqual([1000]);
  });
});
