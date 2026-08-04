// + New Issue modal. Submits through the onCreate callback (BoardPage wires
// it to store.createIssue and releases the butterfly on success).

import { For, Show, createMemo, createRenderEffect, createSignal } from "solid-js";
import type { Board, Sprint } from "../lib/types";
import type { NewIssueInput } from "../pages/board/store";
import { decodeJwtClaims, pubkeyOfJwt } from "../lib/jwt";
import { authorLabel, profileFor, requestProfile } from "../lib/profileStore";
import { DEFAULT_ISSUE_TYPE, ISSUE_TYPES, enabledColumns, typeLabel } from "../lib/columns";
import { MarkdownEditor } from "./MarkdownEditor";
import { PendingAttachments } from "./PendingAttachments";

const ESTIMATES = [1, 2, 3, 5, 8, 13];

/** Assignee choices: just the signed-in user for now — member search comes
 *  with the membership phase; the option label resolves via profileStore. */
const selfAssignee = (): { pubkey: string; login: string } | null => {
  let jwt: string | null = null;
  try {
    jwt = window.localStorage.getItem("evenflow.jwt");
  } catch {
    return null;
  }
  if (jwt === null) return null;
  const claims = decodeJwtClaims(jwt);
  const pubkey = pubkeyOfJwt(jwt);
  return claims === null || pubkey === null ? null : { pubkey, login: claims.login };
};

export const NewIssueModal = (props: {
  board: Board;
  /** Active + planning sprints, in display order. Modal filters and offers
   *  them; picking one triggers an attach after the create. Undefined means
   *  no sprint picker is rendered (defensive — the shell always passes []
   *  or better). */
  sprints?: ReadonlyArray<Sprint>;
  onClose: () => void;
  onCreate: (
    input: NewIssueInput,
    files: ReadonlyArray<File>,
    sprintId: string | null,
  ) => Promise<void>;
}) => {
  const [title, setTitle] = createSignal("");
  const [type, setType] = createSignal<string>(DEFAULT_ISSUE_TYPE);
  const [body, setBody] = createSignal("");
  const [files, setFiles] = createSignal<File[]>([]);
  const columns = enabledColumns(props.board.columns);
  const [status, setStatus] = createSignal(columns[0]?.name ?? "");
  const [container, setContainer] = createSignal("backlog");
  const [estimate, setEstimate] = createSignal("");
  const [labels, setLabels] = createSignal("");
  const [assignee, setAssignee] = createSignal("");
  // EFB-108 — pick a sprint at create time. Empty string = no sprint. If the
  // sprint is the active one, EFB-17's server-side auto-promote flips the
  // container to `active` after attach, so the user does not have to
  // co-choose it here.
  const [sprintId, setSprintId] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const me = selfAssignee();
  createRenderEffect(() => {
    if (me !== null) requestProfile(me.pubkey);
  });
  const meLabel = createMemo(() =>
    me === null ? "" : authorLabel(profileFor(me.pubkey), me.pubkey, me),
  );

  const submit = async (e: Event) => {
    e.preventDefault();
    if (title().trim() === "" || busy()) return;
    setBusy(true);
    const labelList = labels()
      .split(",")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    const input: NewIssueInput = {
      title: title().trim(),
      type: type(),
      ...(body().trim() === "" ? {} : { body: body() }),
      status: status(),
      container: container(),
      ...(estimate() === "" ? {} : { estimate: Number(estimate()) }),
      ...(labelList.length === 0 ? {} : { labels: labelList }),
      ...(assignee() === "" ? {} : { assignee_pubkey: assignee() }),
    };
    try {
      await props.onCreate(input, files(), sprintId() === "" ? null : sprintId());
    } finally {
      setBusy(false);
    }
  };

  // Only offer sprints the user could reasonably pick — active + planning,
  // never completed. Completed sprints are archival and can't take issues.
  const pickableSprints = createMemo(() =>
    (props.sprints ?? []).filter((s) => s.status === "active" || s.status === "planning"),
  );

  return (
    <div class="modal-overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <form class="modal" onSubmit={submit}>
        <h2>New issue</h2>
        <label for="ni-title">Title</label>
        <input
          id="ni-title"
          type="text"
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
        <label for="ni-type">Type</label>
        <select id="ni-type" value={type()} onInput={(e) => setType(e.currentTarget.value)}>
          <For each={[...ISSUE_TYPES]}>{(t) => <option value={t}>{typeLabel(t)}</option>}</For>
        </select>
        <label for="ni-body">Body</label>
        <MarkdownEditor value={body()} onInput={setBody} />
        <label>Files</label>
        <PendingAttachments
          files={files()}
          onAdd={(file) => setFiles((list) => [...list, file])}
          onRemove={(index) => setFiles((list) => list.filter((_, i) => i !== index))}
          disabled={busy()}
        />
        <label for="ni-status">Status</label>
        <select id="ni-status" value={status()} onInput={(e) => setStatus(e.currentTarget.value)}>
          <For each={columns}>{(c) => <option value={c.name}>{c.name}</option>}</For>
        </select>
        <label for="ni-container">Container</label>
        <select
          id="ni-container"
          value={container()}
          onInput={(e) => setContainer(e.currentTarget.value)}
        >
          <option value="backlog">Backlog</option>
          <option value="active">Active</option>
          <option value="icebox">Icebox</option>
        </select>
        <Show when={pickableSprints().length > 0}>
          <label for="ni-sprint">Sprint</label>
          <select
            id="ni-sprint"
            value={sprintId()}
            onInput={(e) => setSprintId(e.currentTarget.value)}
          >
            <option value="">— None</option>
            <For each={pickableSprints()}>
              {(s) => (
                <option value={s.id}>
                  {s.name}
                  {s.status === "active" ? " · active" : " · planning"}
                </option>
              )}
            </For>
          </select>
        </Show>
        <label for="ni-estimate">Estimate</label>
        <select
          id="ni-estimate"
          value={estimate()}
          onInput={(e) => setEstimate(e.currentTarget.value)}
        >
          <option value="">—</option>
          <For each={ESTIMATES}>{(n) => <option value={String(n)}>{n}</option>}</For>
        </select>
        <Show when={me !== null}>
          <label for="ni-assignee">Assignee</label>
          <select
            id="ni-assignee"
            value={assignee()}
            onInput={(e) => setAssignee(e.currentTarget.value)}
          >
            <option value="">Unassigned</option>
            <option value={me!.pubkey}>{meLabel()}</option>
          </select>
        </Show>
        <label for="ni-labels">Labels (comma-separated)</label>
        <input
          id="ni-labels"
          type="text"
          value={labels()}
          onInput={(e) => setLabels(e.currentTarget.value)}
        />
        <div class="actions">
          <button type="button" class="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" class="btn btn-solid" disabled={title().trim() === "" || busy()}>
            <Show when={!busy()} fallback={"Following the thread…"}>
              Create issue
            </Show>
          </button>
        </div>
      </form>
    </div>
  );
};

/** The signature moment: a butterfly emerges near (x, y) and flutters away. */
export const Butterfly = (props: { x: number; y: number }) => (
  <svg
    class="butterfly"
    style={{ left: `${props.x}px`, top: `${props.y}px` }}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <g class="wing-l">
      <path d="M12 12 C6 4, 1 6, 3 11 C4 14, 8 14, 12 12 Z" fill="#17233b" opacity="0.85" />
      <path d="M12 12 C7 14, 4 18, 7 19 C9 20, 11 16, 12 12 Z" fill="#17233b" opacity="0.6" />
    </g>
    <g class="wing-r">
      <path d="M12 12 C18 4, 23 6, 21 11 C20 14, 16 14, 12 12 Z" fill="#17233b" opacity="0.85" />
      <path d="M12 12 C17 14, 20 18, 17 19 C15 20, 13 16, 12 12 Z" fill="#17233b" opacity="0.6" />
    </g>
    <ellipse cx="12" cy="12.5" rx="0.9" ry="3.2" fill="#17233b" />
  </svg>
);
