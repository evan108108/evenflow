// EFB-30 — resolving a duplicate-of pointer to something a card can show.
//
// The pointer is an issue id; the badge wants a short id ("EFB-7"). The
// translation needs the other issue, and the only copy the client has is the
// union of loaded pages (`store.issues()`), so the lookup CAN miss: the
// original of a duplicate is often an old ticket nobody has paged to.
//
// A miss is not an error and must not hide the badge. `duplicate_of_issue_id`
// being set is itself the fact worth showing — the card falls back to an
// unlabelled "duplicate" marker, and the sheet (which the user is one click
// from) does the same. Anything else would make a duplicate look like an
// ordinary issue purely because of scroll position.

import type { Issue } from "./types";

/**
 * Index the loaded issues by id → short id, for `refFor` below. Built once
 * per render pass rather than per card: the views render hundreds of cards
 * off one list, and a find() per card would be quadratic over it.
 */
export const shortIdIndex = (issues: ReadonlyArray<Issue>): Map<string, string> => {
  const index = new Map<string, string>();
  for (const issue of issues) {
    if (issue.short_id !== null) index.set(issue.id, issue.short_id);
  }
  return index;
};

/**
 * The short id of the issue `issue` duplicates, or null when it isn't a
 * duplicate OR the target isn't loaded. Callers must not distinguish those
 * two cases from this return value alone — check `duplicate_of_issue_id` for
 * "is a duplicate", and use this only for "what do I call the target".
 */
export const refFor = (index: Map<string, string>, issue: Issue): string | null => {
  const targetId = issue.duplicate_of_issue_id ?? null;
  if (targetId === null) return null;
  return index.get(targetId) ?? null;
};
