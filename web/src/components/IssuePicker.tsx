// IssuePicker — search-as-type over one board's issues, for choosing a
// target issue (EFB-30's "mark as duplicate of…").
//
// SEARCHES THE SERVER, not the loaded pages. The board's issues arrive as
// per-column cursor-paged streams (phase 22), so `store.issues()` holds "the
// cards we have scrolled to", not the board. Filtering that locally would
// make the picker's results depend on how far the user had scrolled each
// column — the original of a duplicate is very often an old issue nobody has
// paged to. The list endpoint's ?q is the only source that sees all of them.
//
// The empty query still fetches, so opening the picker shows the most
// recently updated issues rather than an empty box that gives no hint what
// it wants.

import { For, Show, createResource, createSignal } from "solid-js";
import { Effect } from "effect";
import { ApiClient, appRuntime, type ApiClientService, type ApiError } from "../effects";
import type { Issue } from "../lib/types";
import { IssueRef } from "./IssueRef";
import { IssueTypeIcon } from "./IssueTypeIcon";

const api = <T,>(f: (c: ApiClientService) => Effect.Effect<T, ApiError>): Promise<T> =>
  appRuntime.runPromise(Effect.flatMap(ApiClient, f));

/** How many candidates one search returns. A picker is for recognising a
 *  known issue, not for browsing — past ~20 rows the answer is "type more". */
const PICKER_LIMIT = 20;

/** Debounce on the query. Long enough that ordinary typing sends one request
 *  per pause rather than per keystroke, short enough to feel immediate. */
const SEARCH_DEBOUNCE_MS = 200;

export const IssuePicker = (props: {
  /** Board-scoped API prefix, e.g. /api/v0/boards/my-board. */
  apiBase: string;
  /** Issue doing the pointing — never offered as its own target. */
  excludeIssueId: string;
  /** Currently highlighted candidate, or null. */
  selected: Issue | null;
  onSelect: (issue: Issue) => void;
}) => {
  const [query, setQuery] = createSignal("");
  const [debounced, setDebounced] = createSignal("");
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onInput = (value: string) => {
    setQuery(value);
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => setDebounced(value), SEARCH_DEBOUNCE_MS);
  };

  const [results] = createResource(debounced, async (q: string) => {
    const params = new URLSearchParams({ limit: String(PICKER_LIMIT) });
    if (q.trim() !== "") params.set("q", q.trim());
    const res = await api<{ issues: Issue[] }>((c) =>
      c.get(`${props.apiBase}/issues?${params.toString()}`),
    );
    return res.issues.filter((i) => i.id !== props.excludeIssueId);
  });

  return (
    <>
      <input
        type="text"
        placeholder="Search issues…"
        value={query()}
        onInput={(e) => onInput(e.currentTarget.value)}
      />
      <div style={{ "max-height": "14rem", "overflow-y": "auto", "margin-top": "0.6rem" }}>
        {/* results.loading is true on EVERY refetch, so keying the fallback
            off it alone would blank the list on each keystroke's settle.
            Showing the previous rows until the new ones land keeps the list
            from flickering; only the very first load has nothing to show. */}
        <Show when={!(results.loading && results() === undefined)} fallback={<p class="muted">Finding the rhythm…</p>}>
          <Show
            when={(results() ?? []).length > 0}
            fallback={
              <p class="muted">
                {query().trim() === "" ? "No other issues on this board." : "Nothing matches."}
              </p>
            }
          >
            <For each={results()}>
              {(issue) => (
                <button
                  type="button"
                  class="user-nav-item"
                  style={{
                    width: "100%",
                    "text-align": "left",
                    display: "flex",
                    "align-items": "center",
                    gap: "0.4rem",
                    background:
                      props.selected?.id === issue.id ? "var(--surface-2, #f0f0f0)" : "transparent",
                  }}
                  aria-pressed={props.selected?.id === issue.id}
                  onClick={() => props.onSelect(issue)}
                >
                  <span class="type-badge">
                    <IssueTypeIcon type={issue.type} />
                  </span>
                  <Show when={issue.short_id}>
                    {(shortId) => <IssueRef shortId={shortId()} class="card-ref" />}
                  </Show>
                  <span
                    style={{
                      overflow: "hidden",
                      "text-overflow": "ellipsis",
                      "white-space": "nowrap",
                    }}
                  >
                    {issue.title}
                  </span>
                </button>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </>
  );
};
