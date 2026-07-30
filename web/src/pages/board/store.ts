// Board data store — signals + actions over the REST API. Every mutation
// is optimistic: the local issue list updates immediately, the API call
// runs, and a failure rolls the list back to its pre-move snapshot (the
// caller surfaces the error string from lastError).
//
// The `run` parameter is the only seam: pages pass the app ManagedRuntime,
// tests pass a runtime over a capturing ApiClient layer.

import { createSignal } from "solid-js";
import { Cause, Effect, Option, Runtime } from "effect";
import { ApiClient, appRuntime, type ApiClientService, type ApiError } from "../../effects";
import {
  CONTAINER_OF_MOVE,
  type Board,
  type Comment,
  type Container,
  type ContainerMove,
  type FeedItem,
  type Issue,
  type Sprint,
} from "../../lib/types";
import type { Column } from "../../lib/columns";
import type { Attachment } from "../../lib/attachments";
import { POSITION_STEP } from "../../lib/order";

export type RunApi = <A, E>(effect: Effect.Effect<A, E, ApiClient>) => Promise<A>;

const runOnApp: RunApi = (effect) => appRuntime.runPromise(effect);

export interface NewIssueInput {
  readonly title: string;
  readonly type?: string;
  readonly body?: string;
  readonly status?: string;
  readonly container?: string;
  readonly estimate?: number;
  readonly labels?: ReadonlyArray<string>;
  readonly assignee_pubkey?: string;
}

export type IssuePatch = Partial<{
  title: string;
  body: string | null;
  body_format: string;
  type: string;
  status: string;
  assignee_pubkey: string | null;
  priority: number | null;
  estimate: number | null;
  labels: ReadonlyArray<string>;
}>;

/** Upload rejections carry the server's actionable copy + settings link. */
export interface UploadRejection {
  readonly message: string;
  readonly link: string | null;
}

/** runPromise rejects with a FiberFailure wrapper — dig the ApiError back out. */
export const unwrapApiError = (e: unknown): ApiError | null => {
  if (e !== null && typeof e === "object" && (e as { _tag?: string })._tag === "ApiError") {
    return e as ApiError;
  }
  if (Runtime.isFiberFailure(e)) {
    const failure = Cause.failureOption(e[Runtime.FiberFailureCauseId] as Cause.Cause<unknown>);
    if (Option.isSome(failure)) return unwrapApiError(failure.value);
  }
  return null;
};

const errorText = (e: unknown): string => {
  const err = unwrapApiError(e);
  if (err !== null) {
    return err.reason === "http" ? `request failed (${err.status})` : `request failed (${err.reason})`;
  }
  return "request failed";
};

/** Per-stream page size. Server caps at 100; 50 keeps first paint quick. */
export const PAGE_SIZE = 50;

export const createBoardStore = (
  slug: string,
  run: RunApi = runOnApp,
  // Board-scoped API prefix. Legacy default; org-scoped pages pass
  // /api/v0/orgs/<handle>/boards/<slug> (phase 16 canonical namespace).
  apiBase: string = `/api/v0/boards/${encodeURIComponent(slug)}`,
) => {
  const [board, setBoard] = createSignal<Board | null>(null);
  const [issues, setIssues] = createSignal<Issue[]>([]);
  const [sprints, setSprints] = createSignal<Sprint[]>([]);
  const [members, setMembers] = createSignal<Array<{ pubkey: string; role: string }>>([]);
  const [loading, setLoading] = createSignal(true);
  const [lastError, setLastError] = createSignal<string | null>(null);
  const [statusFeed, setStatusFeed] = createSignal<FeedItem[]>([]);

  const api = <A>(f: (client: ApiClientService) => Effect.Effect<A, ApiError>) =>
    run(Effect.flatMap(ApiClient, f));

  // ── paged streams (phase 22) ────────────────────────────────────────────
  //
  // Every visible list is its own cursor-paged stream, keyed
  // `${container}:${columnId ?? ""}`. Boards used to fetch a flat
  // `?limit=100` and silently drop card 101+; streams remove the ceiling.
  //
  // `issues()` deliberately remains the UNION of every loaded page rather
  // than being replaced by per-stream accessors. Twelve call sites read it
  // — deep-link resolution, sprint grouping, velocity estimates, the
  // reorder neighbour lookup — and all of them want "the cards we have",
  // not "one column's page". Keeping the union means paging is additive:
  // the streams decide what to FETCH, the existing views keep deciding what
  // to SHOW. (Deviation from the brief, which had issues() stop returning
  // everything; same user-visible result, far smaller blast radius.)
  const [streamTick, setStreamTick] = createSignal(0);
  interface StreamState {
    hasMore: boolean;
    nextAfter: string | null;
    loading: boolean;
    started: boolean;
    /** Guards against a second in-flight page while one is already running. */
    inflight: Promise<void> | null;
  }
  const streams = new Map<string, StreamState>();
  const streamKey = (container: Container, columnId?: string | null) =>
    `${container}:${columnId ?? ""}`;

  const mergeIssues = (incoming: Issue[]) =>
    setIssues((list) => {
      const byId = new Map(list.map((i) => [i.id, i]));
      for (const i of incoming) byId.set(i.id, i);
      return [...byId.values()];
    });

  const fetchPage = async (
    container: Container,
    columnId: string | null,
    after: string | null,
  ) => {
    const params = new URLSearchParams({ container, limit: String(PAGE_SIZE) });
    if (columnId !== null) params.set("column_id", columnId);
    if (after !== null) params.set("after", after);
    return api((c) =>
      c.get<{ issues: Issue[]; has_more: boolean; next_after: string | null }>(
        `${apiBase}/issues?${params.toString()}`,
      ),
    );
  };

  const stateFor = (key: string): StreamState => {
    let s = streams.get(key);
    if (s === undefined) {
      s = { hasMore: true, nextAfter: null, loading: false, started: false, inflight: null };
      streams.set(key, s);
    }
    return s;
  };

  /**
   * A stream handle for one visible list. Views call `loadNext()` from an
   * IntersectionObserver sentinel; repeated calls while a page is in flight
   * return the SAME promise, so a fast scroll cannot fire two requests for
   * the same cursor (which would double-append and skip a page).
   */
  const streamFor = (container: Container, columnId?: string | null) => {
    const key = streamKey(container, columnId);
    const loadNext = (): Promise<void> => {
      const s = stateFor(key);
      if (s.inflight !== null) return s.inflight;
      if (s.started && !s.hasMore) return Promise.resolve();
      s.loading = true;
      s.started = true;
      setStreamTick((n) => n + 1);
      const p = (async () => {
        try {
          const page = await fetchPage(container, columnId ?? null, s.nextAfter);
          mergeIssues(page.issues);
          s.hasMore = page.has_more;
          s.nextAfter = page.next_after;
          // Deliberately does NOT clear lastError on success. Stream
          // refreshes run right after a mutation, including a FAILED one —
          // clearing here would wipe the rollback's error message before
          // the user ever saw it. Errors are cleared by the next
          // successful user action, not by background paging.
        } catch (e) {
          // Stop the stream on error rather than letting the sentinel
          // retry forever against a failing endpoint.
          s.hasMore = false;
          setLastError(errorText(e));
        } finally {
          s.loading = false;
          s.inflight = null;
          setStreamTick((n) => n + 1);
        }
      })();
      s.inflight = p;
      return p;
    };
    return {
      key,
      loadNext,
      hasMore: () => {
        streamTick();
        const s = stateFor(key);
        return s.hasMore;
      },
      loading: () => {
        streamTick();
        return stateFor(key).loading;
      },
      started: () => {
        streamTick();
        return stateFor(key).started;
      },
      /** Drop pagination state so the next loadNext refetches page one. */
      reset: () => {
        streams.set(key, {
          hasMore: true,
          nextAfter: null,
          loading: false,
          started: false,
          inflight: null,
        });
        setStreamTick((n) => n + 1);
      },
    };
  };

  /**
   * Refetch the first page of both sides of a move. Called after
   * transition/moveContainer so a card that left one stream and joined
   * another is reflected without reloading the whole board.
   */
  const refreshStreams = async (keys: Array<[Container, string | null]>) => {
    await Promise.all(
      keys.map(async ([container, columnId]) => {
        const s = streamFor(container, columnId);
        s.reset();
        await s.loadNext();
      }),
    );
  };

  const replaceIssue = (updated: Issue) =>
    setIssues((list) => list.map((i) => (i.id === updated.id ? updated : i)));

  // Track issues we just mutated locally so the board-stream SSE echo of our
  // own write doesn't fire a full refetchIssues() (which wipes streams and
  // re-primes — visible flash). 2s TTL is well past round-trip.
  const localMutationDeadlines = new Map<string, number>();
  const LOCAL_MUTATION_TTL_MS = 2000;
  const noteLocalMutation = (id: string) => {
    localMutationDeadlines.set(id, Date.now() + LOCAL_MUTATION_TTL_MS);
  };
  const isLocalMutation = (id: string): boolean => {
    const until = localMutationDeadlines.get(id);
    if (until === undefined) return false;
    if (Date.now() > until) {
      localMutationDeadlines.delete(id);
      return false;
    }
    return true;
  };

  /** Optimistically apply `patch` to one issue, run the API call, roll back on failure. */
  const optimistic = async (id: string, patch: Partial<Issue>, call: () => Promise<Issue>) => {
    const snapshot = issues();
    noteLocalMutation(id);
    setIssues((list) => list.map((i) => (i.id === id ? ({ ...i, ...patch } as Issue) : i)));
    try {
      replaceIssue(await call());
      setLastError(null);
    } catch (e) {
      setIssues(snapshot);
      setLastError(errorText(e));
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const [b, sp] = await Promise.all([
        api((c) => c.get<{ board: Board }>(apiBase)),
        api((c) => c.get<{ sprints: Sprint[] }>(`${apiBase}/sprints`)),
      ]);
      setBoard(b.board);
      setSprints(sp.sprints);
      // Members feed the assignee picker in IssueSheet. Best-effort — the
      // /members endpoint requires contributor scope, so viewers just get
      // an empty list and see the current assignee (if any) as a chip.
      api((c) => c.get<{ members: Array<{ pubkey: string; role: string }> }>(`${apiBase}/members`))
        .then((r) => setMembers(r.members))
        .catch(() => setMembers([]));
      // Prime the first page of every stream the board can show. The
      // sentinels take over from here, but priming means first paint has
      // cards even in columns that start off-screen horizontally — a
      // sentinel that is never scrolled into view would otherwise leave
      // its column looking empty rather than unloaded.
      setIssues([]);
      streams.clear();
      await primeStreams(b.board);
      setLastError(null);
    } catch (e) {
      setLastError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  /**
   * Every stream a board can display: one per enabled column, plus the two
   * side-lists. Used to prime first paint and to re-prime after a refetch.
   */
  const allStreamKeys = (b: Board | null): Array<[Container, string | null]> => {
    const cols = b?.columns ?? [];
    return [
      ...cols.filter((col) => col.enabled).map((col): [Container, string | null] => ["active", col.id]),
      ["backlog", null],
      ["icebox", null],
    ];
  };

  const primeStreams = (b: Board | null) => refreshStreams(allStreamKeys(b));

  const refetchIssues = async () => {
    // Non-destructive refresh: fetch every stream's first page in parallel
    // FIRST, then swap issues[] to the union in a single setIssues() call.
    // Previously we wiped issues[] + cleared streams and awaited the reprime
    // — every stream was empty for the fetch window, which reads as a full-
    // board flash on any SSE-driven refresh. Now the old data stays on
    // screen until the new page lands, so a transition looks like a card
    // jumping columns instead of a whole-board blink.
    try {
      const keys = allStreamKeys(board());
      const pages = await Promise.all(
        keys.map(([container, columnId]) => fetchPage(container, columnId, null)),
      );
      const collected: Issue[] = [];
      const seen = new Set<string>();
      keys.forEach(([container, columnId], idx) => {
        const page = pages[idx]!;
        const stateKey = streamKey(container, columnId);
        const s = stateFor(stateKey);
        s.hasMore = page.has_more;
        s.nextAfter = page.next_after;
        s.started = true;
        s.loading = false;
        s.inflight = null;
        for (const i of page.issues) {
          if (!seen.has(i.id)) {
            seen.add(i.id);
            collected.push(i);
          }
        }
      });
      // Single reactive write — a transitioned card visibly jumps to its
      // new column in one frame, no empty intermediate state.
      setIssues(collected);
      setStreamTick((n) => n + 1);
    } catch {
      // Quiet refresh — a failed background refetch keeps the current view.
    }
  };

  /** Status-change feed rows for "The Current" (velocity sparkline). */
  const refetchStatusFeed = async () => {
    try {
      const res = await api((c) =>
        c.get<{ activity: FeedItem[] }>(`${apiBase}/activity?type=status&limit=100`),
      );
      setStatusFeed(res.activity);
    } catch {
      // Sparkline is decoration; never block the board on it.
    }
  };

  /** Move to a column by stable id (column_id survives renames). If the
   *  issue is in the backlog or icebox (rail drop → status column), promote
   *  to active first — /transition only touches status, not container. */
  const transition = async (issue: Issue, to: Column) => {
    if (to.id === issue.column_id && to.name === issue.status && issue.container === "active") {
      return;
    }
    if (issue.container !== "active") {
      await optimistic(issue.id, { container: "active" }, async () => {
        const res = await api((c) =>
          c.post<{ issue: Issue }>(`/api/v0/issues/${issue.id}/promote_to_active`, {}),
        );
        return res.issue;
      });
    }
    await optimistic(issue.id, { status: to.name, column_id: to.id }, async () => {
      const res = await api((c) =>
        c.post<{ issue: Issue }>(`/api/v0/issues/${issue.id}/transition`, { column_id: to.id }),
      );
      return res.issue;
    });
    // Re-prime BOTH sides of the move. The optimistic patch already moved
    // the card locally; this reconciles each stream's cursor, because the
    // source stream now has one fewer row before its cursor and the target
    // one more — leaving them stale would skip a card on the next page.
    const from: [Container, string | null] =
      issue.container === "active" ? ["active", issue.column_id] : [issue.container, null];
    await refreshStreams([from, ["active", to.id]]);
  };

  /**
   * Reorder within the column: place `issue` between its new neighbors
   * (either may be null at the column's edges). Optimistic when the local
   * midpoint is computable; the follow-up refetch picks up any server-side
   * column rebalance either way.
   */
  const reorderIssue = async (
    issue: Issue,
    beforeId: string | null,
    afterId: string | null,
  ) => {
    const before = beforeId === null ? undefined : issues().find((i) => i.id === beforeId);
    const after = afterId === null ? undefined : issues().find((i) => i.id === afterId);
    let optimisticPos: number | null = null;
    if (before?.position != null && after?.position != null && after.position > before.position) {
      optimisticPos = (before.position + after.position) / 2;
    } else if (before?.position != null && afterId === null) {
      optimisticPos = before.position + POSITION_STEP;
    } else if (after?.position != null && beforeId === null) {
      optimisticPos = after.position - POSITION_STEP;
    }
    await optimistic(issue.id, optimisticPos === null ? {} : { position: optimisticPos }, async () => {
      const res = await api((c) =>
        c.patch<{ issue: Issue }>(`/api/v0/issues/${issue.id}/reorder`, {
          ...(beforeId === null ? {} : { before_issue_id: beforeId }),
          ...(afterId === null ? {} : { after_issue_id: afterId }),
        }),
      );
      return res.issue;
    });
    void refetchIssues();
  };

  // ── sprints (phase 20) ──────────────────────────────────────────────────

  const refetchSprints = async () => {
    try {
      const res = await api((c) => c.get<{ sprints: Sprint[] }>(`${apiBase}/sprints`));
      setSprints(res.sprints);
    } catch {
      // Quiet refresh — same posture as refetchIssues.
    }
  };

  const replaceSprint = (updated: Sprint) =>
    setSprints((list) => list.map((s) => (s.id === updated.id ? updated : s)));

  const createSprint = async (name: string): Promise<Sprint | null> => {
    try {
      const res = await api((c) => c.post<{ sprint: Sprint }>(`${apiBase}/sprints`, { name }));
      setSprints((list) => [...list, res.sprint]);
      setLastError(null);
      return res.sprint;
    } catch (e) {
      setLastError(errorText(e));
      return null;
    }
  };

  const patchSprint = async (
    id: string,
    patch: { name?: string; goal?: string | null; planned_days?: number | null },
  ) => {
    try {
      const res = await api((c) => c.patch<{ sprint: Sprint }>(`${apiBase}/sprints/${id}`, patch));
      replaceSprint(res.sprint);
      setLastError(null);
    } catch (e) {
      setLastError(errorText(e));
    }
  };

  /** Kickoff: the server moves the sprint's backlog issues to active. */
  const startSprint = async (id: string) => {
    try {
      const res = await api((c) => c.post<{ sprint: Sprint }>(`${apiBase}/sprints/${id}/start`, {}));
      replaceSprint(res.sprint);
      setLastError(null);
    } catch (e) {
      setLastError(errorText(e));
    }
    void refetchIssues();
  };

  /** Complete a sprint. carryOver defaults to "next_planning" (server picks
   *  the oldest planning sprint if nextSprintId is omitted). SSE refetch
   *  reconciles the issues that were carried or dropped. */
  const completeSprint = async (
    id: string,
    opts?: { carryOver?: "next_planning" | "drop"; nextSprintId?: string },
  ) => {
    try {
      const body: Record<string, unknown> = {};
      if (opts?.carryOver !== undefined) body["carryOver"] = opts.carryOver;
      if (opts?.nextSprintId !== undefined) body["nextSprintId"] = opts.nextSprintId;
      const res = await api((c) =>
        c.post<{ sprint: Sprint }>(`${apiBase}/sprints/${id}/complete`, body),
      );
      replaceSprint(res.sprint);
      setLastError(null);
      void refetchIssues();
    } catch (e) {
      setLastError(errorText(e));
    }
  };

  /** Delete a planning sprint. Members' sprint_id gets cleared server-side;
   *  we drop the sprint locally and let the SSE refetch reconcile issue
   *  rows so their card returns to Unassigned Backlog. */
  const deleteSprint = async (id: string) => {
    try {
      await api((c) => c.delete<{ deleted: true }>(`${apiBase}/sprints/${id}`));
      setSprints((list) => list.filter((s) => s.id !== id));
      setLastError(null);
      void refetchIssues();
    } catch (e) {
      setLastError(errorText(e));
    }
  };

  const setSprintMembership = (issue: Issue, sprintId: string | null) => {
    if ((issue.sprint_id ?? null) === sprintId) return Promise.resolve();
    const verb = sprintId === null ? "remove-issue" : "add-issue";
    const target = sprintId ?? issue.sprint_id;
    return optimistic(issue.id, { sprint_id: sprintId }, async () => {
      const res = await api((c) =>
        c.post<{ issue: Issue }>(`${apiBase}/sprints/${target}/${verb}`, { issue_id: issue.id }),
      );
      return res.issue;
    });
  };

  const addIssueToSprint = (issue: Issue, sprintId: string) => setSprintMembership(issue, sprintId);
  const removeIssueFromSprint = (issue: Issue) => setSprintMembership(issue, null);

  const moveContainer = (issue: Issue, move: ContainerMove) => {
    if (CONTAINER_OF_MOVE[move] === issue.container) return Promise.resolve();
    const target = CONTAINER_OF_MOVE[move];
    const from: [Container, string | null] =
      issue.container === "active" ? ["active", issue.column_id] : [issue.container, null];
    const to: [Container, string | null] =
      target === "active" ? ["active", issue.column_id] : [target, null];
    return optimistic(issue.id, { container: target }, async () => {
      const res = await api((c) => c.post<{ issue: Issue }>(`/api/v0/issues/${issue.id}/${move}`, {}));
      void refreshStreams([from, to]);
      return res.issue;
    });
  };

  const createIssue = async (input: NewIssueInput): Promise<Issue> => {
    const res = await api((c) => c.post<{ issue: Issue }>(`${apiBase}/issues`, input));
    setIssues((list) => [res.issue, ...list]);
    return res.issue;
  };

  const patchIssue = async (id: string, patch: IssuePatch): Promise<Issue | null> => {
    // Mark as a local mutation so the SSE echo of our own PATCH doesn't
    // trigger BoardPage's refetchIssues() (which wipes every stream and
    // re-primes — visible flash). isLocalMutation() gates that path in
    // BoardPage. Same pattern optimistic() uses for the drag paths.
    noteLocalMutation(id);
    try {
      const res = await api((c) => c.patch<{ issue: Issue }>(`/api/v0/issues/${id}`, patch));
      replaceIssue(res.issue);
      setLastError(null);
      return res.issue;
    } catch (e) {
      setLastError(errorText(e));
      return null;
    }
  };

  const deleteIssue = async (id: string) => {
    const snapshot = issues();
    setIssues((list) => list.filter((i) => i.id !== id));
    try {
      await api((c) => c.delete(`/api/v0/issues/${id}`));
    } catch (e) {
      setIssues(snapshot);
      setLastError(errorText(e));
    }
  };

  const fetchComments = (issueId: string) =>
    api((c) => c.get<{ comments: Comment[] }>(`/api/v0/issues/${issueId}/comments?limit=200`)).then(
      (r) => r.comments,
    );

  const postComment = (issueId: string, body: string, attachmentIds: ReadonlyArray<string> = []) =>
    api((c) =>
      c.post<{ comment: Comment }>(`/api/v0/issues/${issueId}/comments`, {
        body,
        ...(attachmentIds.length === 0 ? {} : { attachment_ids: attachmentIds }),
      }),
    ).then((r) => r.comment);

  const deleteComment = (commentId: string) =>
    api((c) => c.delete<{ deleted: boolean }>(`/api/v0/comments/${commentId}`));

  const fetchIssueActivity = (issueId: string) =>
    api((c) => c.get<{ activity: FeedItem[] }>(`/api/v0/issues/${issueId}/activity`)).then(
      (r) => r.activity,
    );

  // ── attachments (phase 18a) ─────────────────────────────────────────────

  const fetchAttachments = (issueId: string) =>
    api((c) =>
      c.get<{ attachments: Attachment[] }>(`${apiBase}/issues/${issueId}/attachments`),
    ).then((r) => r.attachments);

  /** Base64 file → JSON upload. Returns the actionable rejection, if any. */
  const uploadAttachment = async (
    issueId: string,
    file: File,
  ): Promise<{ attachment: Attachment | null; rejection: UploadRejection | null }> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    try {
      const res = await api((c) =>
        c.post<{ attachment: Attachment }>(`${apiBase}/issues/${issueId}/attachments`, {
          file_b64: btoa(binary),
          filename: file.name,
          content_type: file.type === "" ? "application/octet-stream" : file.type,
        }),
      );
      return { attachment: res.attachment, rejection: null };
    } catch (e) {
      const err = unwrapApiError(e);
      const body = (err?.body ?? null) as { message?: string; link?: string } | null;
      return {
        attachment: null,
        rejection: {
          message: typeof body?.message === "string" ? body.message : errorText(e),
          link: typeof body?.link === "string" ? body.link : null,
        },
      };
    }
  };

  const setAttachmentCover = (attachmentId: string, is_cover: boolean) =>
    api((c) => c.patch<{ attachment: Attachment }>(`/api/v0/attachments/${attachmentId}`, { is_cover }));

  const deleteAttachment = (attachmentId: string) =>
    api((c) => c.delete<{ deleted: boolean }>(`/api/v0/attachments/${attachmentId}`));

  return {
    slug,
    apiBase,
    board,
    issues,
    members,
    streamFor,
    refreshStreams,
    sprints,
    loading,
    lastError,
    statusFeed,
    load,
    refetchIssues,
    isLocalMutation,
    refetchStatusFeed,
    refetchSprints,
    createSprint,
    patchSprint,
    startSprint,
    completeSprint,
    deleteSprint,
    addIssueToSprint,
    removeIssueFromSprint,
    transition,
    moveContainer,
    reorderIssue,
    createIssue,
    patchIssue,
    deleteIssue,
    fetchComments,
    postComment,
    deleteComment,
    fetchIssueActivity,
    fetchAttachments,
    uploadAttachment,
    setAttachmentCover,
    deleteAttachment,
  };
};

export type BoardStore = ReturnType<typeof createBoardStore>;
