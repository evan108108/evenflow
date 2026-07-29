// /@{handle}/{board_slug}/settings — board administration, tabbed since
// phase 17: General (visibility), Members (members + pending invites),
// Columns (the structured-column editor), Danger zone. Non-admins can look
// (the API refuses their writes); the danger zone demands the board slug
// typed back.
//
// The Columns tab edits a local draft and ships ONE PATCH on Save: renames
// keep the column's stable id (issues stay put), disabling hides without
// deleting, and deleting a column that still holds issues opens the
// move-or-hide modal — a move rides along as column_move_map.

import { useNavigate, useParams } from "@solidjs/router";
import { For, Show, createResource, createSignal } from "solid-js";
import { Effect } from "effect";
import { ApiClient, appRuntime, type ApiClientService, type ApiError } from "../effects";
import { pubkeyOfJwt } from "../lib/jwt";
import { createDnd } from "../lib/dnd";
import {
  CATEGORY_LABELS,
  COLUMN_CATEGORIES,
  COLUMN_NAME_MAX,
  MAX_COLUMNS,
  defaultColumnsTemplate,
  type Column,
  type ColumnCategory,
} from "../lib/columns";
import { InviteModal } from "../components/InviteModal";
import { MembersPanel, type MemberRow } from "../components/MembersPanel";
import { UserNav } from "../components/UserNav";
import "../lib/board.css";

const BOARD_ROLES = ["admin", "contributor", "viewer"] as const;
const TABS = ["General", "Members", "Columns", "Danger zone"] as const;
type Tab = (typeof TABS)[number];

interface BoardDetail {
  board: {
    id: string;
    slug: string;
    title: string;
    visibility: "private" | "public";
    columns: Column[];
  };
}

interface PendingInvite {
  id: string;
  code: string;
  role: string;
  invited_email: string | null;
  expires_at_ms: number;
}

const api = <T,>(
  f: (c: ApiClientService) => Effect.Effect<T, ApiError>,
): Promise<T> => appRuntime.runPromise(Effect.flatMap(ApiClient, f));

export const BoardSettings = () => {
  const params = useParams<{ handle: string; board_slug: string }>();
  const navigate = useNavigate();
  const handle = () => params.handle.replace(/^@/, "");
  const apiBase = () =>
    `/api/v0/orgs/${encodeURIComponent(handle())}/boards/${encodeURIComponent(params.board_slug)}`;

  const selfPubkey = (() => {
    try {
      const jwt = window.localStorage.getItem("evenflow.jwt");
      return jwt === null ? null : pubkeyOfJwt(jwt);
    } catch {
      return null;
    }
  })();

  const [board, { refetch: refetchBoard }] = createResource(() =>
    api<BoardDetail>((c) => c.get(apiBase())),
  );
  const [members, { refetch: refetchMembers }] = createResource(() =>
    api<{ members: MemberRow[] }>((c) => c.get(`${apiBase()}/members`)).then((r) => r.members),
  );
  const [invites, { refetch: refetchInvites }] = createResource(() =>
    api<{ invites: PendingInvite[] }>((c) => c.get(`${apiBase()}/invites`))
      .then((r) => r.invites)
      .catch(() => [] as PendingInvite[]), // non-admins get 403/404 — hide the section
  );
  // First page of issues, for per-column counts in the delete flow. Same
  // 100-cap the board views run with.
  const [issues, { refetch: refetchIssues }] = createResource(() =>
    api<{ issues: Array<{ id: string; column_id: string | null; status: string }> }>((c) =>
      c.get(`${apiBase()}/issues?limit=100`),
    ).then((r) => r.issues),
  );

  const [tab, setTab] = createSignal<Tab>("General");
  const [showInvite, setShowInvite] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [confirmText, setConfirmText] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);

  const withRefresh = (call: Promise<unknown>, refresh: () => void) => {
    setError(null);
    call.then(refresh).catch(() => setError("The current pushed back — nothing changed."));
  };

  const changeRole = (pubkey: string, role: string) =>
    withRefresh(
      api((c) => c.patch(`${apiBase()}/members/${encodeURIComponent(pubkey)}`, { role })),
      () => void refetchMembers(),
    );

  const kick = (pubkey: string) =>
    withRefresh(
      api((c) => c.delete(`${apiBase()}/members/${encodeURIComponent(pubkey)}`)),
      () => void refetchMembers(),
    );

  const revokeInvite = (id: string) =>
    withRefresh(
      api((c) => c.delete(`/api/v0/invites/${encodeURIComponent(id)}`)),
      () => void refetchInvites(),
    );

  const toggleVisibility = () => {
    const next = board()?.board.visibility === "public" ? "private" : "public";
    withRefresh(
      api((c) => c.patch(apiBase(), { visibility: next })),
      () => void refetchBoard(),
    );
  };

  const deleteBoard = () => {
    if (confirmText() !== params.board_slug) return;
    withRefresh(
      api((c) => c.delete(apiBase())),
      () => navigate(`/@${handle()}`, { replace: true }),
    );
  };

  const base = () => `/@${handle()}/${params.board_slug}`;

  // ── Columns tab state ─────────────────────────────────────────────────────

  const [draft, setDraft] = createSignal<Column[] | null>(null);
  const [moveMap, setMoveMap] = createSignal<Record<string, string>>({});
  const [newName, setNewName] = createSignal("");
  const [newCategory, setNewCategory] = createSignal<ColumnCategory>("todo");
  const [savingColumns, setSavingColumns] = createSignal(false);
  // Delete-confirmation modal target + its chosen move destination.
  const [deleting, setDeleting] = createSignal<Column | null>(null);
  const [moveTarget, setMoveTarget] = createSignal("");

  /** The working list: local edits when dirty, else the server's columns. */
  const columns = (): Column[] =>
    draft() ?? [...(board()?.board.columns ?? [])].sort((a, b) => a.order - b.order);

  const reindex = (list: Column[]): Column[] => list.map((c, order) => ({ ...c, order }));
  const edit = (next: Column[]) => setDraft(reindex(next));
  const dirty = () => draft() !== null;

  const patchColumn = (id: string, patch: Partial<Column>) =>
    edit(columns().map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const issueCount = (column: Column) =>
    (issues() ?? []).filter((i) =>
      i.column_id !== null ? i.column_id === column.id : i.status === column.name,
    ).length;

  const columnsDnd = createDnd((draggedId, zone) => {
    const targetId = zone.startsWith("colrow:") ? zone.slice(7) : null;
    if (targetId === null || targetId === draggedId) return;
    const list = columns();
    const from = list.findIndex((c) => c.id === draggedId);
    const to = list.findIndex((c) => c.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    edit(next);
  });

  const removeColumn = (column: Column) => {
    if (issueCount(column) === 0) {
      edit(columns().filter((c) => c.id !== column.id));
      return;
    }
    setMoveTarget("");
    setDeleting(column);
  };

  const confirmMove = () => {
    const gone = deleting();
    const target = moveTarget();
    if (gone === null || target === "") return;
    setMoveMap((m) => ({ ...m, [gone.id]: target }));
    edit(columns().filter((c) => c.id !== gone.id));
    setDeleting(null);
  };

  const confirmHide = () => {
    const gone = deleting();
    if (gone === null) return;
    patchColumn(gone.id, { enabled: false });
    setDeleting(null);
  };

  const addColumn = () => {
    const name = newName().trim();
    if (name === "" || columns().length >= MAX_COLUMNS) return;
    edit([
      ...columns(),
      { id: crypto.randomUUID(), name, order: columns().length, enabled: true, category: newCategory() },
    ]);
    setNewName("");
  };

  /**
   * Reset to the stock four columns. Every current column disappears, so
   * each one maps into the fresh set by category (todo fallback) — the
   * server only consults the map for columns that still hold issues.
   */
  const resetToDefault = () => {
    const stock = defaultColumnsTemplate(() => crypto.randomUUID());
    const map: Record<string, string> = {};
    for (const old of columns()) {
      const target = stock.find((c) => c.category === old.category) ?? stock[0]!;
      map[old.id] = target.id;
    }
    setMoveMap((m) => ({ ...m, ...map }));
    edit(stock);
  };

  const saveColumns = () => {
    const body: Record<string, unknown> = { columns: columns() };
    if (Object.keys(moveMap()).length > 0) body["column_move_map"] = moveMap();
    setSavingColumns(true);
    setError(null);
    api((c) => c.patch(apiBase(), body))
      .then(() => {
        setDraft(null);
        setMoveMap({});
        void refetchBoard();
        void refetchIssues();
      })
      .catch(() => setError("The current pushed back — nothing changed."))
      .finally(() => setSavingColumns(false));
  };

  const enabledOthers = (except: Column) =>
    columns().filter((c) => c.enabled && c.id !== except.id);

  return (
    <main style={{ "max-width": "var(--measure)", margin: "0 auto", padding: "4rem 1.5rem 4rem var(--page-inset-left, 3rem)" }}>
      <nav class="crumb muted" style={{ "margin-bottom": "1rem" }}>
        <a href="/boards">← Boards</a> / <a href={`/@${handle()}`}>@{handle()}</a> /{" "}
        <a href={base()}>{board()?.board.title ?? params.board_slug}</a> / settings
      </nav>
      <header
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          "margin-bottom": "1rem",
        }}
      >
        <h1 style={{ "font-size": "2.2rem" }}>Board settings</h1>
        <UserNav />
      </header>

      <nav class="tab-row settings-tabs">
        <For each={[...TABS]}>
          {(t) => (
            <button type="button" classList={{ active: tab() === t }} onClick={() => setTab(t)}>
              {t}
            </button>
          )}
        </For>
      </nav>

      <Show when={error()}>
        <p class="muted" role="alert">
          {error()}
        </p>
      </Show>

      <Show when={tab() === "General"}>
        <section class="settings-section">
          <h2>Visibility</h2>
          <p>
            This board is{" "}
            <strong>{board()?.board.visibility === "public" ? "Public" : "Private"}</strong>.
          </p>
          <Show when={board()?.board.visibility === "public"}>
            <p class="visibility-warning">
              Anyone with the URL can view this board — no sign-in required to read.
            </p>
          </Show>
          <div style={{ "margin-top": "0.8rem" }}>
            <button type="button" class="btn" onClick={toggleVisibility}>
              Make {board()?.board.visibility === "public" ? "private" : "public"}
            </button>
          </div>
        </section>
      </Show>

      <Show when={tab() === "Members"}>
        <section class="settings-section">
          <h2>Members</h2>
          <Show when={!members.loading} fallback={<p class="muted">Finding the rhythm…</p>}>
            <MembersPanel
              members={members() ?? []}
              roles={BOARD_ROLES}
              canManage={true}
              selfPubkey={selfPubkey}
              onRoleChange={changeRole}
              onKick={kick}
            />
          </Show>
          <div style={{ "margin-top": "1rem" }}>
            <button type="button" class="btn btn-solid" onClick={() => setShowInvite(true)}>
              Invite
            </button>
          </div>
        </section>

        <section class="settings-section">
          <h2>Pending invites</h2>
          <Show
            when={(invites() ?? []).length > 0}
            fallback={<p class="muted">Nothing outstanding.</p>}
          >
            <ul style={{ "list-style": "none", margin: 0, padding: 0 }}>
              <For each={invites()}>
                {(invite) => (
                  <li class="member-row">
                    <span>
                      {invite.invited_email ?? invite.code}
                      <span class="chip role-chip" style={{ "margin-left": "0.6rem" }}>
                        {invite.role}
                      </span>
                    </span>
                    <span class="grow" />
                    <span class="muted" style={{ "font-size": "0.8rem" }}>
                      expires {new Date(invite.expires_at_ms).toLocaleDateString()}
                    </span>
                    <button type="button" class="btn btn-danger" onClick={() => revokeInvite(invite.id)}>
                      Revoke
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
      </Show>

      <Show when={tab() === "Columns"}>
        <section class="settings-section">
          <h2>Columns</h2>
          <p class="muted">
            Drag to reorder. Renames keep issues in place; a disabled column hides from the
            board but keeps its issues.
          </p>
          <ul class="column-list">
            <For each={columns()}>
              {(column) => {
                const zone = `colrow:${column.id}`;
                return (
                  <li
                    class="column-row"
                    classList={{
                      "drop-over": columnsDnd.overZone() === zone,
                      dragging: columnsDnd.draggingId() === column.id,
                      disabled: !column.enabled,
                    }}
                    data-dropzone={zone}
                  >
                    <span
                      class="drag-handle"
                      title="Drag to reorder"
                      onPointerDown={(e) => columnsDnd.startDrag(e, column.id, () => undefined)}
                    >
                      ⠿
                    </span>
                    <input
                      class="column-name"
                      value={column.name}
                      maxlength={COLUMN_NAME_MAX}
                      onChange={(e) => {
                        const name = e.currentTarget.value.trim();
                        if (name !== "") patchColumn(column.id, { name });
                        else e.currentTarget.value = column.name;
                      }}
                    />
                    <select
                      class="column-category"
                      value={column.category}
                      onInput={(e) =>
                        patchColumn(column.id, { category: e.currentTarget.value as ColumnCategory })
                      }
                    >
                      <For each={[...COLUMN_CATEGORIES]}>
                        {(cat) => <option value={cat}>{CATEGORY_LABELS[cat]}</option>}
                      </For>
                    </select>
                    <label class="column-enabled" title="Enabled — untick to hide without deleting">
                      <input
                        type="checkbox"
                        checked={column.enabled}
                        onInput={(e) => patchColumn(column.id, { enabled: e.currentTarget.checked })}
                      />
                      Enabled
                    </label>
                    <span class="muted column-count figure">{issueCount(column)}</span>
                    <button
                      type="button"
                      class="column-delete"
                      title="Delete column"
                      onClick={() => removeColumn(column)}
                    >
                      ×
                    </button>
                  </li>
                );
              }}
            </For>
          </ul>

          <div class="column-add">
            <input
              type="text"
              placeholder="New column name"
              value={newName()}
              maxlength={COLUMN_NAME_MAX}
              onInput={(e) => setNewName(e.currentTarget.value)}
            />
            <select
              value={newCategory()}
              onInput={(e) => setNewCategory(e.currentTarget.value as ColumnCategory)}
            >
              <For each={[...COLUMN_CATEGORIES]}>
                {(cat) => <option value={cat}>{CATEGORY_LABELS[cat]}</option>}
              </For>
            </select>
            <button
              type="button"
              class="btn"
              disabled={newName().trim() === "" || columns().length >= MAX_COLUMNS}
              onClick={addColumn}
            >
              + Add column
            </button>
          </div>

          <div class="actions" style={{ display: "flex", gap: "0.6rem", "margin-top": "1.2rem" }}>
            <button
              type="button"
              class="btn btn-solid"
              disabled={!dirty() || savingColumns()}
              onClick={saveColumns}
            >
              <Show when={!savingColumns()} fallback={"Following the thread…"}>
                Save columns
              </Show>
            </button>
            <span class="grow" />
            <button type="button" class="btn btn-danger" onClick={resetToDefault}>
              Reset to default
            </button>
          </div>
        </section>
      </Show>

      <Show when={tab() === "Danger zone"}>
        <section class="settings-section">
          <div class="danger-zone">
            <h3>Danger zone</h3>
            <div style={{ display: "flex", gap: "0.6rem" }}>
              <button type="button" class="btn btn-danger" onClick={() => setConfirmDelete(true)}>
                Delete board
              </button>
              <button type="button" class="btn" disabled title="Archive lands in a later phase">
                Archive
              </button>
            </div>
          </div>
        </section>
      </Show>

      <Show when={showInvite()}>
        <InviteModal
          scope={{ org_slug: handle(), board_slug: params.board_slug, roles: BOARD_ROLES }}
          onClose={() => setShowInvite(false)}
          onCreated={() => void refetchInvites()}
        />
      </Show>

      <Show when={deleting()}>
        {(column) => (
          <div
            class="modal-overlay"
            onClick={(e) => e.target === e.currentTarget && setDeleting(null)}
          >
            <div class="modal" role="dialog" aria-label="Delete column">
              <h2>Delete “{column().name}”?</h2>
              <p>
                “{column().name}” holds {issueCount(column())}{" "}
                {issueCount(column()) === 1 ? "issue" : "issues"}.
              </p>
              <label for="col-move-target">Move them to</label>
              <select
                id="col-move-target"
                value={moveTarget()}
                onInput={(e) => setMoveTarget(e.currentTarget.value)}
              >
                <option value="">—</option>
                <For each={enabledOthers(column())}>
                  {(c) => <option value={c.id}>{c.name}</option>}
                </For>
              </select>
              <div class="actions" style={{ "margin-top": "1rem" }}>
                <button
                  type="button"
                  class="btn btn-danger"
                  disabled={moveTarget() === ""}
                  onClick={confirmMove}
                >
                  Move &amp; delete
                </button>
                <button type="button" class="btn" onClick={confirmHide}>
                  Just hide the column
                </button>
                <button type="button" class="btn" onClick={() => setDeleting(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      <Show when={confirmDelete()}>
        <div
          class="modal-overlay"
          onClick={(e) => e.target === e.currentTarget && setConfirmDelete(false)}
        >
          <div class="modal" role="dialog" aria-label="Delete board">
            <h2>Delete this board?</h2>
            <p>
              Every issue on it orphans. Type <strong>{params.board_slug}</strong> to confirm.
            </p>
            <input
              type="text"
              value={confirmText()}
              onInput={(e) => setConfirmText(e.currentTarget.value)}
            />
            <div class="actions" style={{ "margin-top": "1rem" }}>
              <button
                type="button"
                class="btn btn-danger"
                disabled={confirmText() !== params.board_slug}
                onClick={deleteBoard}
              >
                Delete forever
              </button>
              <button type="button" class="btn" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </Show>
    </main>
  );
};
