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
    loading,
    lastError,
    statusFeed,
    load,
    refetchIssues,
    refetchStatusFeed,
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
