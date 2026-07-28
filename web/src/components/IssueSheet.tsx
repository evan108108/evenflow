// IssueSheet — right-side slide-in detail panel, deep-linked at
// /boards/:slug/issues/:id. Title edits inline on blur/Enter; body is plain
// text with an edit toggle (markdown rendering is a later polish pass);
// status/priority/estimate/labels PATCH through the store; container badges
// fire the container-move endpoints; comments + recent activity below.

import { For, Show, createResource, createSignal } from "solid-js";
import type { Board, Comment, Container, Issue } from "../lib/types";
import { MOVE_TO_CONTAINER } from "../lib/types";
import { shortPubkey } from "../lib/jwt";
import type { BoardStore } from "../pages/board/store";

const ESTIMATES = [1, 2, 3, 5, 8, 13];
const PRIORITIES = [1, 2, 3, 4];
const CONTAINERS: Container[] = ["icebox", "backlog", "active"];

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export const IssueSheet = (props: {
  issue: Issue;
  board: Board;
  store: BoardStore;
  callerPubkey: string | null;
  /** Bumped by BoardPage when a comment.* SSE event arrives for this issue. */
  commentsVersion: () => number;
  onClose: () => void;
}) => {
  const [editingBody, setEditingBody] = createSignal(false);
  const [bodyDraft, setBodyDraft] = createSignal("");
  const [commentDraft, setCommentDraft] = createSignal("");
  const [labelDraft, setLabelDraft] = createSignal("");

  const [comments, { refetch: refetchComments }] = createResource(
    () => [props.issue.id, props.commentsVersion()] as const,
    ([id]) => props.store.fetchComments(id),
  );
  const [activity] = createResource(
    () => props.issue.id,
    (id) => props.store.fetchIssueActivity(id),
  );

  const saveTitle = (value: string) => {
    const title = value.trim();
    if (title !== "" && title !== props.issue.title) {
      void props.store.patchIssue(props.issue.id, { title });
    }
  };

  const saveBody = async () => {
    const body = bodyDraft().trim() === "" ? null : bodyDraft();
    await props.store.patchIssue(props.issue.id, { body });
    setEditingBody(false);
  };

  const addLabel = () => {
    const label = labelDraft().trim();
    if (label === "" || props.issue.labels.includes(label)) return;
    void props.store.patchIssue(props.issue.id, { labels: [...props.issue.labels, label] });
    setLabelDraft("");
  };

  const postComment = async (e: Event) => {
    e.preventDefault();
    const body = commentDraft().trim();
    if (body === "") return;
    await props.store.postComment(props.issue.id, body);
    setCommentDraft("");
    void refetchComments();
  };

  return (
    <>
      <div class="sheet-overlay" onClick={props.onClose} />
      <aside class="issue-sheet" aria-label="Issue detail">
        <button class="close" onClick={props.onClose} aria-label="Close">
          ×
        </button>

        <input
          class="title-input"
          value={props.issue.title}
          onBlur={(e) => saveTitle(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />

        <div class="sheet-row">
          <span class="key">Status</span>
          <select
            value={props.issue.status}
            onInput={(e) => void props.store.transition(props.issue, e.currentTarget.value)}
          >
            <For each={[...props.board.columns]}>{(c) => <option value={c}>{c}</option>}</For>
          </select>
        </div>

        <div class="sheet-row">
          <span class="key">Container</span>
          <div class="container-badges">
            <For each={CONTAINERS}>
              {(container) => (
                <button
                  classList={{ on: props.issue.container === container }}
                  onClick={() =>
                    void props.store.moveContainer(props.issue, MOVE_TO_CONTAINER[container])
                  }
                >
                  {container}
                </button>
              )}
            </For>
          </div>
        </div>

        <div class="sheet-row">
          <span class="key">Assignee</span>
          <span>
            {props.issue.assignee_pubkey === null ? "—" : shortPubkey(props.issue.assignee_pubkey)}
          </span>
        </div>

        <div class="sheet-row">
          <span class="key">Priority</span>
          <select
            value={props.issue.priority === null ? "" : String(props.issue.priority)}
            onInput={(e) =>
              void props.store.patchIssue(props.issue.id, {
                priority: e.currentTarget.value === "" ? null : Number(e.currentTarget.value),
              })
            }
          >
            <option value="">—</option>
            <For each={PRIORITIES}>{(p) => <option value={String(p)}>P{p}</option>}</For>
          </select>
        </div>

        <div class="sheet-row">
          <span class="key">Estimate</span>
          <select
            value={props.issue.estimate === null ? "" : String(props.issue.estimate)}
            onInput={(e) =>
              void props.store.patchIssue(props.issue.id, {
                estimate: e.currentTarget.value === "" ? null : Number(e.currentTarget.value),
              })
            }
          >
            <option value="">—</option>
            <For each={ESTIMATES}>{(n) => <option value={String(n)}>{n}</option>}</For>
          </select>
        </div>

        <div class="sheet-row">
          <span class="key">Labels</span>
          <div class="chips" style={{ flex: "1" }}>
            <For each={props.issue.labels}>
              {(label) => (
                <button
                  class="chip"
                  title="Remove label"
                  onClick={() =>
                    void props.store.patchIssue(props.issue.id, {
                      labels: props.issue.labels.filter((l) => l !== label),
                    })
                  }
                >
                  {label} ×
                </button>
              )}
            </For>
            <input
              type="text"
              placeholder="+ label"
              size={8}
              value={labelDraft()}
              onInput={(e) => setLabelDraft(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addLabel())}
            />
          </div>
        </div>

        <Show when={props.issue.github_links.length > 0}>
          <div class="sheet-row">
            <span class="key">GitHub</span>
            <div class="chips">
              <For each={props.issue.github_links}>
                {(link) => (
                  <span class="chip">
                    {link.repo}#{link.pr} · {link.state}
                  </span>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show
          when={editingBody()}
          fallback={
            <div class="issue-body" onDblClick={() => (setBodyDraft(props.issue.body ?? ""), setEditingBody(true))}>
              <Show when={props.issue.body !== null} fallback={<span class="muted">No body. Double-click to write one.</span>}>
                {props.issue.body}
              </Show>
            </div>
          }
        >
          <textarea
            class="issue-body-edit"
            value={bodyDraft()}
            onInput={(e) => setBodyDraft(e.currentTarget.value)}
          />
          <div class="actions" style={{ display: "flex", gap: "0.5rem", "margin-top": "0.5rem" }}>
            <button class="btn" onClick={() => setEditingBody(false)}>
              Cancel
            </button>
            <button class="btn btn-solid" onClick={() => void saveBody()}>
              Save
            </button>
          </div>
        </Show>

        <section class="sheet-section">
          <h3>Comments</h3>
          <Show when={(comments() ?? []).length > 0} fallback={<p class="muted">Quiet so far.</p>}>
            <For each={comments()}>
              {(comment: Comment) => (
                <div class="comment">
                  <div class="meta">
                    <span>
                      {shortPubkey(comment.author_pubkey)} · {when(comment.created_at_ms)}
                    </span>
                    <Show when={comment.author_pubkey === props.callerPubkey}>
                      <button
                        onClick={() =>
                          void props.store.deleteComment(comment.id).then(() => refetchComments())
                        }
                      >
                        delete
                      </button>
                    </Show>
                  </div>
                  <div>{comment.body}</div>
                </div>
              )}
            </For>
          </Show>
          <form class="comment-input" onSubmit={postComment}>
            <input
              type="text"
              placeholder="Add a comment…"
              value={commentDraft()}
              onInput={(e) => setCommentDraft(e.currentTarget.value)}
            />
            <button type="submit" class="btn" disabled={commentDraft().trim() === ""}>
              Post
            </button>
          </form>
        </section>

        <section class="sheet-section">
          <h3>Activity</h3>
          <For each={activity() ?? []}>
            {(item) => (
              <div class="activity-line">
                {item.kind === "creation"
                  ? `created as ${item.to ?? "?"}`
                  : `${item.kind}: ${item.from ?? "—"} → ${item.to ?? "—"}`}
                {" · "}
                {when(item.occurred_at_ms)}
              </div>
            )}
          </For>
        </section>
      </aside>
    </>
  );
};
