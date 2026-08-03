// BoardSearch — the board header's search box (EFB-14).
//
// Posts to POST {apiBase}/search, which is FTS5 over this board's issue
// titles/bodies and comment bodies, BM25-ranked and scoped server-side to the
// board the caller is looking at.
//
// SEARCHES THE SERVER, for the same reason IssuePicker does: the board's
// issues arrive as per-column cursor-paged streams, so the loaded store holds
// "the cards we have scrolled to", not the board. Filtering that locally
// would make results depend on scroll position — and it could not search
// comment bodies at all, since comments are only fetched when a sheet opens.
//
// POST, not GET, because the query is a body — search text routinely contains
// `/`, `#`, `?` and `&`, and a body keeps what people type out of access logs
// and browser history. That means `createResource` drives a POST here, which
// is not the usual read shape in this app; it is a read in every sense that
// matters (idempotent, no side effects) and the verb is about the payload.

import { For, Show, createResource, createSignal, onCleanup } from "solid-js";
import { Effect } from "effect";
import { ApiClient, appRuntime, type ApiClientService, type ApiError } from "../effects";
import { issuePath, type BoardView } from "../lib/boardView";
import type { Issue } from "../lib/types";
import { IssueTypeIcon } from "./IssueTypeIcon";

const api = <T,>(f: (c: ApiClientService) => Effect.Effect<T, ApiError>): Promise<T> =>
  appRuntime.runPromise(Effect.flatMap(ApiClient, f));

/**
 * Debounce on the query — matched to IssuePicker's, so the two search inputs
 * in this app feel like the same control.
 */
const SEARCH_DEBOUNCE_MS = 200;

/** Rows per section. A header dropdown is for finding one thing. */
const SEARCH_LIMIT = 8;

/** Characters of comment body shown around nothing in particular — enough to
 *  recognise the remark, short enough to keep one row one line. */
const COMMENT_PREVIEW_CHARS = 120;

interface IssueHit {
  readonly issue: Issue;
  readonly rank: number;
}

interface CommentHit {
  readonly comment: { readonly id: string; readonly body: string };
  readonly issue_id: string;
  readonly issue_title: string | null;
  readonly issue_short_id: string | null;
  readonly rank: number;
}

interface SearchResults {
  readonly issues: IssueHit[];
  readonly comments: CommentHit[];
}

const preview = (body: string): string => {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= COMMENT_PREVIEW_CHARS
    ? flat
    : `${flat.slice(0, COMMENT_PREVIEW_CHARS)}…`;
};

export const BoardSearch = (props: {
  /** Board-scoped API prefix, e.g. /api/v0/orgs/@me/boards/my-board. */
  apiBase: string;
  /** Route prefix for issue links, e.g. /@handle/board-slug. */
  base: string;
  /**
   * The view the searcher is looking at. Passed in rather than read off the
   * router because a result opens a sheet *over* the current view, and
   * landing on the kanban form would silently move a backlog reader off
   * their view — the invariant BoardPage's openPath holds.
   */
  view: BoardView;
}) => {
  const [query, setQuery] = createSignal("");
  const [debounced, setDebounced] = createSignal("");
  const [open, setOpen] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wrap: HTMLDivElement | undefined;

  const onInput = (value: string) => {
    setQuery(value);
    setOpen(true);
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => setDebounced(value), SEARCH_DEBOUNCE_MS);
  };

  const close = () => {
    setOpen(false);
  };

  // Click-outside and Escape both close. The listener is on document because
  // the panel overlaps the board beneath it, and a click on a card should
  // dismiss the panel rather than fall through to two different behaviours.
  const onDocumentPointerDown = (e: PointerEvent) => {
    if (wrap !== undefined && !wrap.contains(e.target as Node)) close();
  };
  const onDocumentKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  if (typeof document !== "undefined") {
    document.addEventListener("pointerdown", onDocumentPointerDown);
    document.addEventListener("keydown", onDocumentKeyDown);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDocumentPointerDown);
      document.removeEventListener("keydown", onDocumentKeyDown);
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  // An empty query fetches nothing. Unlike IssuePicker — which opens onto a
  // list and needs something in it — this box starts closed and only has
  // meaning once someone types.
  const [results] = createResource(
    () => debounced().trim(),
    async (q: string): Promise<SearchResults | null> => {
      if (q === "") return null;
      return api<SearchResults>((c) =>
        c.post(`${props.apiBase}/search`, { q, limit: SEARCH_LIMIT }),
      );
    },
  );

  // EFB-88: this used to concatenate base and ref directly, dropping the
  // issue segment entirely — the result matched no route and every search
  // hit landed on the 404. issuePath is the one place that shape is known.
  const refHref = (ref: string) => issuePath(props.base, props.view, ref);

  const issueHref = (issue: Issue) => refHref(issue.short_id ?? issue.id);

  const total = () => (results()?.issues.length ?? 0) + (results()?.comments.length ?? 0);

  // "Searching…" only on the FIRST load. results.loading is true on every
  // refetch, so keying the fallback off it alone blanks the panel on each
  // keystroke's settle — the same flicker IssuePicker guards against.
  const settling = () => results.loading && results() === undefined;

  return (
    <div class="board-search" ref={wrap}>
      <input
        type="text"
        class="board-search-input"
        placeholder="Search this board…"
        aria-label="Search this board"
        value={query()}
        onInput={(e) => onInput(e.currentTarget.value)}
        onFocus={() => {
          if (query().trim() !== "") setOpen(true);
        }}
      />
      <Show when={open() && debounced().trim() !== ""}>
        <div class="board-search-panel" role="listbox">
          <Show when={!settling()} fallback={<p class="board-search-empty">Searching…</p>}>
            <Show when={total() > 0} fallback={<p class="board-search-empty">Nothing matches.</p>}>
              <Show when={(results()?.issues.length ?? 0) > 0}>
                <p class="board-search-section">Issues</p>
                <For each={results()?.issues}>
                  {(hit) => (
                    <a class="user-nav-item board-search-row" href={issueHref(hit.issue)} onClick={close}>
                      <span class="board-search-row-main">
                        <IssueTypeIcon type={hit.issue.type} />
                        <span class="board-search-title">{hit.issue.title}</span>
                      </span>
                      <Show when={hit.issue.short_id}>
                        {(shortId) => <span class="board-search-ref serif">{shortId()}</span>}
                      </Show>
                    </a>
                  )}
                </For>
              </Show>
              <Show when={(results()?.comments.length ?? 0) > 0}>
                <p class="board-search-section">Comments</p>
                <For each={results()?.comments}>
                  {(hit) => (
                    <a
                      class="user-nav-item board-search-row board-search-row-comment"
                      href={refHref(hit.issue_short_id ?? hit.issue_id)}
                      onClick={close}
                    >
                      <span class="board-search-comment-body">{preview(hit.comment.body)}</span>
                      <span class="board-search-comment-on">
                        on {hit.issue_title ?? "an issue"}
                      </span>
                    </a>
                  )}
                </For>
              </Show>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
};
