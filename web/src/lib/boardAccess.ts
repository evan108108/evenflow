// EFB-47 — who gets bounced off a board.
//
// Extracted from BoardPage.onMount so the rule is testable on its own. The
// mount path needs a router, the Effect runtime and an AuthManager before it
// will run at all, which is why this branch went unverified long enough to
// ship the bug this ticket fixes.

import type { Board } from "./types";

/**
 * Should an anonymous visitor be redirected away from this board?
 *
 * Called AFTER the board fetch, because visibility is not knowable before it.
 *
 * The test is "did the board come back", NOT `visibility === "private"`. The
 * API answers an anonymous request for a private board with 404
 * `{reason:"board"}` — byte-identical to its answer for a board that does not
 * exist — so a private board never reaches the client as an object and a
 * visibility check here would be unreachable code. Keying off absence also
 * keeps the SPA from reintroducing the existence distinction the API
 * deliberately hides: "private" and "no such board" must stay
 * indistinguishable to a signed-out caller.
 *
 * Signed-in callers are never bounced by this rule. A signed-in user who
 * requests a board they cannot see gets the same 404, but they land on the
 * board-missing state instead, which is a better answer than a silent
 * redirect for someone who can actually sign in and ask for access.
 */
export const shouldRedirectAnonymous = (jwt: string | null, board: Board | null): boolean =>
  jwt === null && board === null;
