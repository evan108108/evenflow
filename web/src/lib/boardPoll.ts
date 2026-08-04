// EFB-104 — when the board re-checks the server, and when it deliberately does not.
//
// This is three lines of wiring in BoardPage's onMount, and it lives here for
// the reason signedOutBoard.test.tsx states about the redirect rule it also
// extracted: asserting anything inside BoardPage costs a router, the Effect
// runtime and an AuthManager, and that weight is exactly why a branch went
// unverified long enough to ship a bug. A scheduling rule with no test is the
// same trade — it looks obvious, and "polls a hidden tab forever" is not the
// kind of thing anyone notices by reading.
//
// The rules, and why each exists:
//
//   - Poll every 60s while the tab is VISIBLE. Self-heals drift from any
//     mutation path SSE did not report.
//   - Never poll a HIDDEN tab. A background tab that stays open for a day is
//     1,440 requests describing a board nobody is looking at, times every such
//     tab. The state is refreshed on the way back in anyway.
//   - Poll IMMEDIATELY when the tab becomes visible. A tab hidden for an hour
//     is the worst staleness in the system and the cheapest moment to fix it;
//     making it wait out the remaining interval is where "I looked at it and
//     it was wrong" comes from.

/** How often a visible board re-checks the server. */
export const POLL_INTERVAL_MS = 60_000;

/** The slice of `document` this needs, so a test can drive visibility. */
export interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  readonly addEventListener: (type: "visibilitychange", listener: () => void) => void;
  readonly removeEventListener: (type: "visibilitychange", listener: () => void) => void;
}

export interface BoardPollOptions {
  /** Run one refresh. Errors are the caller's problem; this never awaits. */
  readonly poll: () => void;
  readonly intervalMs?: number;
  readonly doc?: VisibilitySource;
}

/**
 * Start the poll. Returns a disposer that must be called on unmount —
 * a surviving interval would keep refetching a board that is no longer
 * mounted, and a surviving listener would keep a disposed store alive.
 */
export const startBoardPoll = (options: BoardPollOptions): (() => void) => {
  const { poll, intervalMs = POLL_INTERVAL_MS } = options;
  const doc = options.doc ?? (document as VisibilitySource);

  const pollIfVisible = () => {
    if (doc.visibilityState === "visible") poll();
  };

  const timer = setInterval(pollIfVisible, intervalMs);
  // Same predicate, different trigger: `visibilitychange` fires for hidden too,
  // and only the return-to-visible edge is worth a request.
  doc.addEventListener("visibilitychange", pollIfVisible);

  return () => {
    clearInterval(timer);
    doc.removeEventListener("visibilitychange", pollIfVisible);
  };
};
