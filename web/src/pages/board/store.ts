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
  type ContainerMove,
  type FeedItem,
  type Issue,
} from "../../lib/types";
import type { Column } from "../../lib/columns";

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
  type: string;
  status: string;
  assignee_pubkey: string | null;
  priority: number | null;
  estimate: number | null;
  labels: ReadonlyArray<string>;
}>;

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

export const createBoardStore = (
  slug: string,
  run: RunApi = runOnApp,
  // Board-scoped API prefix. Legacy default; org-scoped pages pass
  // /api/v0/orgs/<handle>/boards/<slug> (phase 16 canonical namespace).
  apiBase: string = `/api/v0/boards/${encodeURIComponent(slug)}`,
) => {
  const [board, setBoard] = createSignal<Board | null>(null);
  const [issues, setIssues] = createSignal<Issue[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [lastError, setLastError] = createSignal<string | null>(null);
  const [statusFeed, setStatusFeed] = createSignal<FeedItem[]>([]);

  const api = <A>(f: (client: ApiClientService) => Effect.Effect<A, ApiError>) =>
    run(Effect.flatMap(ApiClient, f));

  const replaceIssue = (updated: Issue) =>
    setIssues((list) => list.map((i) => (i.id === updated.id ? updated : i)));

  /** Optimistically apply `patch` to one issue, run the API call, roll back on failure. */
  const optimistic = async (id: string, patch: Partial<Issue>, call: () => Promise<Issue>) => {
    const snapshot = issues();
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
      const [b, list] = await Promise.all([
        api((c) => c.get<{ board: Board }>(apiBase)),
        api((c) => c.get<{ issues: Issue[] }>(`${apiBase}/issues?limit=100`)),
      ]);
      setBoard(b.board);
      setIssues(list.issues);
      setLastError(null);
    } catch (e) {
      setLastError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  const refetchIssues = async () => {
    try {
      const list = await api((c) => c.get<{ issues: Issue[] }>(`${apiBase}/issues?limit=100`));
      setIssues(list.issues);
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

  /** Move to a column by stable id (column_id survives renames). */
  const transition = (issue: Issue, to: Column) => {
    if (to.id === issue.column_id && to.name === issue.status) return Promise.resolve();
    return optimistic(issue.id, { status: to.name, column_id: to.id }, async () => {
      const res = await api((c) =>
        c.post<{ issue: Issue }>(`/api/v0/issues/${issue.id}/transition`, { column_id: to.id }),
      );
      return res.issue;
    });
  };

  const moveContainer = (issue: Issue, move: ContainerMove) => {
    if (CONTAINER_OF_MOVE[move] === issue.container) return Promise.resolve();
    return optimistic(issue.id, { container: CONTAINER_OF_MOVE[move] }, async () => {
      const res = await api((c) => c.post<{ issue: Issue }>(`/api/v0/issues/${issue.id}/${move}`, {}));
      return res.issue;
    });
  };

  const createIssue = async (input: NewIssueInput): Promise<Issue> => {
    const res = await api((c) => c.post<{ issue: Issue }>(`${apiBase}/issues`, input));
    setIssues((list) => [res.issue, ...list]);
    return res.issue;
  };

  const patchIssue = async (id: string, patch: IssuePatch): Promise<Issue | null> => {
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

  const postComment = (issueId: string, body: string) =>
    api((c) => c.post<{ comment: Comment }>(`/api/v0/issues/${issueId}/comments`, { body })).then(
      (r) => r.comment,
    );

  const deleteComment = (commentId: string) =>
    api((c) => c.delete<{ deleted: boolean }>(`/api/v0/comments/${commentId}`));

  const fetchIssueActivity = (issueId: string) =>
    api((c) => c.get<{ activity: FeedItem[] }>(`/api/v0/issues/${issueId}/activity`)).then(
      (r) => r.activity,
    );

  return {
    slug,
    apiBase,
    board,
    issues,
    loading,
    lastError,
    statusFeed,
    load,
    refetchIssues,
    refetchStatusFeed,
    transition,
    moveContainer,
    createIssue,
    patchIssue,
    deleteIssue,
    fetchComments,
    postComment,
    deleteComment,
    fetchIssueActivity,
  };
};

export type BoardStore = ReturnType<typeof createBoardStore>;
