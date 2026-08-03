// IssueSheet — right-side slide-in detail panel, deep-linked at
// /@handle/:slug/issue/:ref. Title edits inline on blur/Enter; body is plain
// text with an edit toggle (markdown rendering is a later polish pass);
// status/priority/estimate/labels PATCH through the store; container badges
// fire the container-move endpoints; comments + recent activity below.

import { For, Show, createResource, createSignal } from "solid-js";
import { url } from "@routes-manifest";
import { useNavigate } from "@solidjs/router";
import { Effect } from "effect";
import { ApiClient, appRuntime, type ApiClientService, type ApiError } from "../effects";
import type { Board, Comment, Container, Issue } from "../lib/types";
import { MOVE_TO_CONTAINER } from "../lib/types";
import { ISSUE_TYPES, enabledColumns, typeLabel } from "../lib/columns";
import { formatBytes, isImageContentType, type Attachment } from "../lib/attachments";
import { issuePath } from "../lib/boardView";
import { sprintOptions } from "../lib/sprints";
import type { BoardStore } from "../pages/board/store";
import { AttachmentsPanel, type AttachmentActionError } from "./AttachmentsPanel";
import { PendingAttachments } from "./PendingAttachments";
import { Author } from "./Author";
import { AssigneeAvatar } from "./AssigneeAvatar";
import { authorLabel, profileFor, requestProfile } from "../lib/profileStore";
import { createRenderEffect } from "solid-js";
import { IssuePicker } from "./IssuePicker";
import { IssueRef } from "./IssueRef";
import { IssueTypeIcon } from "./IssueTypeIcon";
import { MarkdownEditor } from "./MarkdownEditor";
import { MarkdownView } from "./MarkdownView";

const api = <T,>(f: (c: ApiClientService) => Effect.Effect<T, ApiError>): Promise<T> =>
  appRuntime.runPromise(Effect.flatMap(ApiClient, f));

interface MovableBoard {
  id: string;
  slug: string;
  title: string;
  org_slug: string | null;
}

const ESTIMATES = [1, 2, 3, 5, 8, 13];
const PRIORITIES = [1, 2, 3, 4];
const CONTAINERS: Container[] = ["icebox", "backlog", "active"];

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export const IssueSheet = (props: {
  issue: Issue;
  board: Board;
  /**
   * The board's canonical route prefix (`/@handle/slug`, or `/boards/slug`
   * for a board that resolves to no org). BoardPage owns it because only it
   * knows the org handle — `Board` carries `org_id`, not the slug.
   */
  base: string;
  store: BoardStore;
  callerPubkey: string | null;
  /** Bumped by BoardPage when a comment.* SSE event arrives for this issue. */
  commentsVersion: () => number;
  onClose: () => void;
}) => {
  const navigate = useNavigate();

  /**
   * What "copy URL" hands you. The canonical org-scoped form — it used to
   * mint the pre-Phase-16 `/boards/{slug}/…` shape, so every copied link
   * spent a server 302 before it landed. No view segment: a link shared out
   * of this app should open the issue, not assert which of the sharer's
   * three views they happened to be reading it from.
   */
  const copyPath = (shortId: string) => issuePath(props.base, "kanban", shortId);

  const [menuOpen, setMenuOpen] = createSignal(false);
  const [showMove, setShowMove] = createSignal(false);
  const [moveFilter, setMoveFilter] = createSignal("");
  const [moveTarget, setMoveTarget] = createSignal<MovableBoard | null>(null);
  const [moveBusy, setMoveBusy] = createSignal(false);
  const [moveError, setMoveError] = createSignal<string | null>(null);
  const [editingBody, setEditingBody] = createSignal(false);
  const [bodyDraft, setBodyDraft] = createSignal("");
  const [commentDraft, setCommentDraft] = createSignal("");
  const [commentFiles, setCommentFiles] = createSignal<File[]>([]);
  const [commentBusy, setCommentBusy] = createSignal(false);
  const [commentError, setCommentError] = createSignal<string | null>(null);
  const [labelDraft, setLabelDraft] = createSignal("");
  const [showDuplicate, setShowDuplicate] = createSignal(false);
  const [duplicateTarget, setDuplicateTarget] = createSignal<Issue | null>(null);
  const [duplicateBusy, setDuplicateBusy] = createSignal(false);
  const [duplicateError, setDuplicateError] = createSignal<string | null>(null);

  const [comments, { refetch: refetchComments }] = createResource(
    () => [props.issue.id, props.commentsVersion()] as const,
    ([id]) => props.store.fetchComments(id),
  );
  const [activity] = createResource(
    () => props.issue.id,
    (id) => props.store.fetchIssueActivity(id),
  );
  const [attachments, { refetch: refetchAttachments }] = createResource(
    () => props.issue.id,
    (id) => props.store.fetchAttachments(id),
  );

  // Anonymous viewers (public boards) get the read-only sheet: attachments
  // list without upload/delete/set-cover.
  const readOnly = () => props.callerPubkey === null;

  const uploadAttachment = async (file: File): Promise<AttachmentActionError | null> => {
    const { rejection } = await props.store.uploadAttachment(props.issue.id, file);
    if (rejection !== null) return rejection;
    void refetchAttachments();
    void props.store.refetchIssues();
    return null;
  };

  const setCover = (attachment: Attachment, is_cover: boolean) => {
    void props.store.setAttachmentCover(attachment.id, is_cover).then(() => {
      void refetchAttachments();
      void props.store.refetchIssues();
    });
  };

  const deleteAttachment = (attachment: Attachment) => {
    void props.store.deleteAttachment(attachment.id).then(() => {
      void refetchAttachments();
      void props.store.refetchIssues();
    });
  };

  const saveTitle = (value: string) => {
    const title = value.trim();
    if (title !== "" && title !== props.issue.title) {
      void props.store.patchIssue(props.issue.id, { title });
    }
  };

  const saveBody = async () => {
    const body = bodyDraft().trim() === "" ? null : bodyDraft();
    // Editing through the markdown editor upgrades plain-format bodies.
    await props.store.patchIssue(props.issue.id, { body, body_format: "markdown" });
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
    if (body === "" || commentBusy()) return;
    setCommentBusy(true);
    setCommentError(null);
    try {
      // Buffered files upload to the issue first (there's no comment to own
      // them yet), then the post claims them via attachment_ids.
      const ids: string[] = [];
      for (const file of commentFiles()) {
        const { attachment, rejection } = await props.store.uploadAttachment(props.issue.id, file);
        if (attachment === null) {
          setCommentError(`${file.name}: ${rejection?.message ?? "upload failed"}`);
          return;
        }
        ids.push(attachment.id);
      }
      await props.store.postComment(props.issue.id, body, ids);
      setCommentDraft("");
      setCommentFiles([]);
      void refetchComments();
    } catch {
      setCommentError("Comment didn't post. Try again.");
    } finally {
      setCommentBusy(false);
    }
  };

  // Boards the caller could move this issue to — everything they can see
  // minus the current board; the server still enforces contributor on both.
  const [movableBoards] = createResource(
    () => (showMove() ? props.issue.id : null),
    async () => {
      const res = await api<{ boards: MovableBoard[] }>((c) => c.get(`${url("board.create")}?limit=100`));
      return res.boards.filter((b) => b.id !== props.board.id);
    },
  );

  const filteredBoards = () => {
    const q = moveFilter().trim().toLowerCase();
    const all = movableBoards() ?? [];
    return q === ""
      ? all
      : all.filter((b) => b.title.toLowerCase().includes(q) || b.slug.toLowerCase().includes(q));
  };

  const doMove = async () => {
    const target = moveTarget();
    if (target === null || moveBusy()) return;
    setMoveBusy(true);
    setMoveError(null);
    try {
      const { issue: moved } = await api<{ issue: Issue }>((c) =>
        c.put(url("issue.board.set", { id: props.issue.id }), { target_board_id: target.id }),
      );
      setShowMove(false);
      props.onClose();
      const ref = moved.short_id ?? moved.id;
      navigate(
        issuePath(
          target.org_slug !== null ? `/@${target.org_slug}/${target.slug}` : `/boards/${target.slug}`,
          // The issue landed on a board we are not looking at, so there is
          // no view to preserve — kanban is that board's front door.
          "kanban",
          ref,
        ),
      );
    } catch {
      setMoveError("The move didn't take — check you can contribute to that board.");
    } finally {
      setMoveBusy(false);
    }
  };

  // The issue this one duplicates, resolved to a card for the badge. Only
  // resolvable when the target is among the loaded pages — the pointer is
  // authoritative either way, so an unresolved target still renders (as the
  // raw pointer) rather than disappearing.
  const duplicateOf = () => {
    const targetId = props.issue.duplicate_of_issue_id ?? null;
    if (targetId === null) return null;
    return props.store.issues().find((i) => i.id === targetId) ?? null;
  };

  const applyDuplicate = async (targetId: string | null) => {
    if (duplicateBusy()) return;
    setDuplicateBusy(true);
    setDuplicateError(null);
    try {
      const updated = await props.store.markDuplicateOf(props.issue, targetId);
      if (updated === null) {
        setDuplicateError(
          targetId === null
            ? "Couldn't clear the duplicate mark. Try again."
            : "Couldn't mark it as a duplicate — check that issue is still on this board.",
        );
        return;
      }
      setShowDuplicate(false);
      setDuplicateTarget(null);
    } finally {
      setDuplicateBusy(false);
    }
  };

  return (
    <>
      <div class="sheet-overlay" onClick={props.onClose} />
      <aside class="issue-sheet" aria-label="Issue detail">
        <button class="close" onClick={props.onClose} aria-label="Close">
          ×
        </button>
        <Show when={!readOnly()}>
          <div style={{ position: "absolute", top: "0.6rem", right: "2.6rem" }}>
            <button
              type="button"
              class="btn"
              style={{ padding: "0.1rem 0.55rem", "line-height": "1.4" }}
              aria-haspopup="menu"
              aria-label="Issue actions"
              onClick={() => setMenuOpen(!menuOpen())}
            >
              ⋯
            </button>
            <Show when={menuOpen()}>
              <div
                role="menu"
                style={{
                  position: "absolute",
                  right: 0,
                  "margin-top": "0.3rem",
                  background: "var(--bg, #fff)",
                  border: "1px solid var(--border, #ddd)",
                  "border-radius": "6px",
                  "box-shadow": "0 4px 14px rgba(0,0,0,0.12)",
                  "z-index": 30,
                  "white-space": "nowrap",
                }}
              >
                <button
                  type="button"
                  class="user-nav-item"
                  onClick={() => {
                    setMenuOpen(false);
                    setMoveFilter("");
                    setMoveTarget(null);
                    setMoveError(null);
                    setShowMove(true);
                  }}
                >
                  Move to another board…
                </button>
                {/* EFB-30. Sits ABOVE Delete because it is the answer most
                    of the time somebody reaches for Delete: the ticket is a
                    duplicate, and pointing at the original keeps the context
                    the second filing carried. Not hidden behind a reveal —
                    both are ordinary actions and the delete confirm is
                    already the safety net. */}
                <button
                  type="button"
                  class="user-nav-item"
                  onClick={() => {
                    setMenuOpen(false);
                    setDuplicateTarget(null);
                    setDuplicateError(null);
                    setShowDuplicate(true);
                  }}
                >
                  Mark as duplicate of…
                </button>
                {/* Deleting one issue sits with the other issue-level
                    actions rather than in a danger zone of its own — the
                    sheet has no room for one, and the confirm is the
                    safety net. window.confirm matches how the app already
                    guards deleting a sprint; typing the ref back is what
                    Board settings reserves for deleting a whole board. */}
                <button
                  type="button"
                  class="user-nav-item"
                  style={{ color: "#9b2c2c" }}
                  onClick={() => {
                    setMenuOpen(false);
                    const ref = props.issue.short_id ?? props.issue.title;
                    if (!window.confirm(`Delete ${ref}? Its comments go too. This can't be undone.`))
                      return;
                    // The store removes it optimistically and puts it back
                    // if the server refuses, so closing here is safe: a
                    // failed delete surfaces on the board, not in a sheet
                    // the issue no longer has.
                    void Promise.resolve(props.store.deleteIssue(props.issue.id)).then(() =>
                      props.onClose(),
                    );
                  }}
                >
                  Delete issue…
                </button>
              </div>
            </Show>
          </div>
        </Show>

        <Show when={props.issue.short_id}>
          {(shortId) => (
            <div class="sheet-ref-row">
              <IssueRef shortId={shortId()} class="sheet-ref" />
              <button
                class="copy-url"
                onClick={() =>
                  void navigator.clipboard.writeText(
                    `${window.location.origin}${copyPath(shortId())}`,
                  )
                }
              >
                copy URL
              </button>
            </div>
          )}
        </Show>

        <input
          class="title-input"
          value={props.issue.title}
          onBlur={(e) => saveTitle(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />

        <div class="sheet-row">
          <span class="key">Type</span>
          <span class="type-badge" title={`Type: ${typeLabel(props.issue.type)}`}>
            <IssueTypeIcon type={props.issue.type} />
          </span>
          <select
            value={props.issue.type}
            onInput={(e) => void props.store.patchIssue(props.issue.id, { type: e.currentTarget.value })}
          >
            <For each={[...ISSUE_TYPES]}>{(t) => <option value={t}>{typeLabel(t)}</option>}</For>
          </select>
        </div>

        <div class="sheet-row">
          <span class="key">Status</span>
          <select
            value={props.issue.column_id ?? props.issue.status}
            onInput={(e) => {
              const to = props.board.columns.find((c) => c.id === e.currentTarget.value);
              if (to !== undefined) void props.store.transition(props.issue, to);
            }}
          >
            <For each={enabledColumns(props.board.columns)}>
              {(c) => <option value={c.id}>{c.name}</option>}
            </For>
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
          <Show when={!readOnly()} fallback={
            <span style={{ display: "flex", "align-items": "center", gap: "0.5rem" }}>
              <Show when={props.issue.assignee_pubkey !== null} fallback={<span class="muted">—</span>}>
                <AssigneeAvatar pubkey={props.issue.assignee_pubkey!} />
                <Author pubkey={props.issue.assignee_pubkey!} />
              </Show>
            </span>
          }>
            {(() => {
              // Members from the store: caller first (so "Assign me" is one
              // click), then everyone else by role weight then name. Each
              // option's display name resolves via profileStore — request the
              // profile so the select label is a real name, not truncated hex.
              const members = () => props.store.members?.() ?? [];
              createRenderEffect(() => {
                for (const m of members()) requestProfile(m.pubkey);
              });
              const orderedMembers = () => {
                const list = [...members()];
                if (props.callerPubkey !== null) {
                  const meIdx = list.findIndex((m) => m.pubkey === props.callerPubkey);
                  if (meIdx >= 0) {
                    const [me] = list.splice(meIdx, 1);
                    list.unshift(me!);
                  }
                }
                return list;
              };
              const labelFor = (pubkey: string): string =>
                authorLabel(profileFor(pubkey), pubkey, null);
              return (
                <span style={{ display: "flex", "align-items": "center", gap: "0.5rem" }}>
                  <Show when={props.issue.assignee_pubkey !== null}>
                    <AssigneeAvatar pubkey={props.issue.assignee_pubkey!} />
                  </Show>
                  <select
                    value={props.issue.assignee_pubkey ?? ""}
                    onChange={(e) =>
                      void props.store.patchIssue(props.issue.id, {
                        assignee_pubkey: e.currentTarget.value === "" ? null : e.currentTarget.value,
                      })
                    }
                  >
                    <option value="">Unassigned</option>
                    <For each={orderedMembers()}>
                      {(m) => (
                        <option value={m.pubkey}>
                          {labelFor(m.pubkey)}
                          {m.pubkey === props.callerPubkey ? " (me)" : ""}
                        </option>
                      )}
                    </For>
                    {/* Fallback: current assignee isn't in the member list
                        (kicked, or the caller can't see members). Keep them
                        visible so the value round-trips. */}
                    <Show
                      when={
                        props.issue.assignee_pubkey !== null &&
                        !orderedMembers().some((m) => m.pubkey === props.issue.assignee_pubkey)
                      }
                    >
                      <option value={props.issue.assignee_pubkey!}>
                        {labelFor(props.issue.assignee_pubkey!)}
                      </option>
                    </Show>
                  </select>
                </span>
              );
            })()}
          </Show>
        </div>

        <div class="sheet-row">
          <span class="key">Sprint</span>
          {(() => {
            const options = () => sprintOptions(props.store.sprints?.() ?? []);
            // sprint_id is optional on Issue, so it arrives as undefined on
            // payloads predating sprints — normalise before comparing.
            const sprintId = () => props.issue.sprint_id ?? null;
            const labelFor = (id: string) =>
              options().find((o) => o.id === id)?.label ?? "Unknown sprint";
            // Adding to a sprint auto-promotes the container server-side
            // (phase 21b symmetry) — don't move it here as well.
            const choose = (value: string) =>
              value === ""
                ? props.store.removeIssueFromSprint(props.issue)
                : props.store.addIssueToSprint(props.issue, value);
            return (
              <Show
                when={!readOnly()}
                fallback={
                  <Show when={sprintId() !== null} fallback={<span class="muted">—</span>}>
                    <span>{labelFor(sprintId()!)}</span>
                  </Show>
                }
              >
                <select
                  value={sprintId() ?? ""}
                  onChange={(e) => void choose(e.currentTarget.value)}
                >
                  <option value="">— None —</option>
                  <For each={options()}>
                    {(o) => <option value={o.id}>{o.label}</option>}
                  </For>
                  {/* The sprint list is fetched separately from the issue, so
                      a stale or not-yet-loaded list would otherwise silently
                      reset the select to "— None —". Keep the current value
                      selectable so it round-trips. */}
                  <Show
                    when={sprintId() !== null && !options().some((o) => o.id === sprintId())}
                  >
                    <option value={sprintId()!}>{labelFor(sprintId()!)}</option>
                  </Show>
                </select>
              </Show>
            );
          })()}
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

        {/* Only present when the issue IS a duplicate — an empty "Duplicate
            of: —" row on every other issue would be noise for a state that
            is rare and, unlike estimate or assignee, not a field anyone is
            expected to fill in. */}
        <Show when={props.issue.duplicate_of_issue_id}>
          {(targetId) => (
            <div class="sheet-row">
              <span class="key">Duplicate of</span>
              <span style={{ display: "flex", "align-items": "center", gap: "0.5rem", flex: "1" }}>
                <Show
                  when={duplicateOf()}
                  fallback={
                    // Target isn't in the loaded pages (or was deleted since).
                    // The pointer is still the truth, so show it rather than
                    // pretending the issue isn't a duplicate.
                    <span class="muted" title={targetId()}>
                      another issue
                    </span>
                  }
                >
                  {(target) => (
                    <>
                      <Show when={target().short_id}>
                        {(shortId) => <IssueRef shortId={shortId()} class="card-ref" />}
                      </Show>
                      <span
                        style={{
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                        }}
                      >
                        {target().title}
                      </span>
                    </>
                  )}
                </Show>
                <Show when={!readOnly()}>
                  <button
                    type="button"
                    class="btn"
                    style={{ "margin-left": "auto", padding: "0.1rem 0.55rem" }}
                    disabled={duplicateBusy()}
                    // Clearing the pointer does NOT move the issue back out
                    // of Done: that transition really happened, and the audit
                    // trail is append-only even though the state reverts.
                    onClick={() => void applyDuplicate(null)}
                  >
                    Clear
                  </button>
                </Show>
              </span>
            </div>
          )}
        </Show>

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
            <div
              class="issue-body"
              onDblClick={() => {
                if (readOnly()) return;
                setBodyDraft(props.issue.body ?? "");
                setEditingBody(true);
              }}
            >
              <Show
                when={props.issue.body !== null}
                fallback={
                  <span class="muted">
                    {readOnly() ? "Nothing written yet." : "Nothing written yet. Double-click to begin."}
                  </span>
                }
              >
                <MarkdownView source={props.issue.body ?? ""} format={props.issue.body_format} />
              </Show>
            </div>
          }
        >
          <MarkdownEditor value={bodyDraft()} onInput={setBodyDraft} />
          <div class="actions" style={{ display: "flex", gap: "0.5rem", "margin-top": "0.5rem" }}>
            <button class="btn" onClick={() => setEditingBody(false)}>
              Cancel
            </button>
            <button class="btn btn-solid" onClick={() => void saveBody()}>
              Save
            </button>
          </div>
        </Show>

        <AttachmentsPanel
          attachments={attachments() ?? []}
          readOnly={readOnly()}
          boardVisibility={props.board.visibility}
          onUpload={uploadAttachment}
          onSetCover={setCover}
          onDelete={deleteAttachment}
        />

        <section class="sheet-section">
          <h3>Comments</h3>
          <Show when={(comments() ?? []).length > 0} fallback={<p class="muted">Quiet so far.</p>}>
            <For each={comments()}>
              {(comment: Comment) => (
                <div class="comment" id={`comment-${comment.id.slice(0, 8)}`}>
                  <div class="meta">
                    <span>
                      <Author pubkey={comment.author_pubkey} /> · {when(comment.created_at_ms)}
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
                  <div class="comment-body">
                    <MarkdownView source={comment.body} format={comment.body_format} />
                  </div>
                  <Show when={(comment.attachments ?? []).length > 0}>
                    <ul class="attachment-list comment-attachments">
                      <For each={comment.attachments ?? []}>
                        {(attachment) => (
                          <li class="attachment-row">
                            <Show
                              when={isImageContentType(attachment.content_type)}
                              fallback={<span class="file-card" aria-hidden="true">▤</span>}
                            >
                              <a href={attachment.blob_url} target="_blank" rel="noreferrer">
                                <img
                                  class="attachment-thumb"
                                  src={attachment.blob_url}
                                  alt={attachment.filename}
                                />
                              </a>
                            </Show>
                            <a
                              class="attachment-name"
                              href={attachment.blob_url}
                              target="_blank"
                              rel="noreferrer"
                              title={attachment.filename}
                            >
                              {attachment.filename}
                            </a>
                            <span class="muted attachment-size">
                              {formatBytes(attachment.size_bytes)}
                            </span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </div>
              )}
            </For>
          </Show>
          <Show when={!readOnly()}>
            <form class="comment-composer" onSubmit={postComment}>
              <MarkdownEditor value={commentDraft()} onInput={setCommentDraft} />
              <PendingAttachments
                files={commentFiles()}
                onAdd={(file) => setCommentFiles((list) => [...list, file])}
                onRemove={(index) => setCommentFiles((list) => list.filter((_, i) => i !== index))}
                disabled={commentBusy()}
              />
              <Show when={commentError()}>
                <p class="attachment-error" role="alert">
                  {commentError()}
                </p>
              </Show>
              <div class="actions">
                <button
                  type="submit"
                  class="btn btn-solid"
                  disabled={commentDraft().trim() === "" || commentBusy()}
                >
                  <Show when={!commentBusy()} fallback={"Catching the current…"}>
                    Post
                  </Show>
                </button>
              </div>
            </form>
          </Show>
        </section>

        <section class="sheet-section">
          <h3>Activity</h3>
          <For each={activity() ?? []}>
            {(item) => (
              <div class="activity-line">
                <Show when={item.issue_short_id}>
                  <strong class="serif">{item.issue_short_id}</strong>
                  {" "}
                </Show>
                <Author pubkey={item.actor_pubkey} />
                {" "}
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

      <Show when={showDuplicate()}>
        <div
          class="modal-overlay"
          onClick={(e) => e.target === e.currentTarget && setShowDuplicate(false)}
        >
          <div class="modal" role="dialog" aria-label="Mark as duplicate">
            <h2>Mark as duplicate of…</h2>
            <p class="muted" style={{ "font-size": "0.85rem" }}>
              This issue moves to Done and stops counting toward the tide. Nothing is deleted —
              the pointer stays, and you can clear it later.
            </p>
            <IssuePicker
              apiBase={props.store.apiBase}
              excludeIssueId={props.issue.id}
              selected={duplicateTarget()}
              onSelect={setDuplicateTarget}
            />
            <Show when={duplicateError()}>
              <p class="muted" role="alert" style={{ "margin-top": "0.6rem" }}>
                {duplicateError()}
              </p>
            </Show>
            <div class="actions" style={{ "margin-top": "1rem" }}>
              <button
                type="button"
                class="btn btn-solid"
                disabled={duplicateTarget() === null || duplicateBusy()}
                // Reads the signal rather than passing `?? null`, which would
                // silently mean "clear the pointer" — a different action.
                onClick={() => {
                  const target = duplicateTarget();
                  if (target !== null) void applyDuplicate(target.id);
                }}
              >
                {duplicateBusy() ? "Marking…" : "Mark as duplicate"}
              </button>
              <button type="button" class="btn" onClick={() => setShowDuplicate(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={showMove()}>
        <div
          class="modal-overlay"
          onClick={(e) => e.target === e.currentTarget && setShowMove(false)}
        >
          <div class="modal" role="dialog" aria-label="Move to another board">
            <h2>Move to another board</h2>
            <p class="muted" style={{ "font-size": "0.85rem" }}>
              The issue gets a new id in the target board's numbering and lands in its first
              matching column.
            </p>
            <input
              type="text"
              placeholder="Search boards…"
              value={moveFilter()}
              onInput={(e) => setMoveFilter(e.currentTarget.value)}
            />
            <div style={{ "max-height": "14rem", "overflow-y": "auto", "margin-top": "0.6rem" }}>
              <Show when={!movableBoards.loading} fallback={<p class="muted">Finding the rhythm…</p>}>
                <Show when={filteredBoards().length > 0} fallback={<p class="muted">No other boards.</p>}>
                  <For each={filteredBoards()}>
                    {(b) => (
                      <button
                        type="button"
                        class="user-nav-item"
                        style={{
                          width: "100%",
                          "text-align": "left",
                          background: moveTarget()?.id === b.id ? "var(--surface-2, #f0f0f0)" : "transparent",
                        }}
                        aria-pressed={moveTarget()?.id === b.id}
                        onClick={() => setMoveTarget(b)}
                      >
                        {b.title}
                        <span class="muted" style={{ "margin-left": "0.5rem", "font-size": "0.8rem" }}>
                          {b.org_slug !== null ? `@${b.org_slug}/` : ""}{b.slug}
                        </span>
                      </button>
                    )}
                  </For>
                </Show>
              </Show>
            </div>
            <Show when={moveError()}>
              <p class="muted" role="alert" style={{ "margin-top": "0.6rem" }}>
                {moveError()}
              </p>
            </Show>
            <div class="actions" style={{ "margin-top": "1rem" }}>
              <button
                type="button"
                class="btn btn-solid"
                disabled={moveTarget() === null || moveBusy()}
                onClick={() => void doMove()}
              >
                {moveBusy() ? "Moving…" : "Move issue"}
              </button>
              <button type="button" class="btn" onClick={() => setShowMove(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
};
