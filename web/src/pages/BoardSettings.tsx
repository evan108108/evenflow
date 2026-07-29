// /@{handle}/{board_slug}/settings — board administration: members, pending
// invites, visibility, danger zone. Non-admins can look (the API refuses
// their writes); the danger zone demands the board slug typed back.

import { useNavigate, useParams } from "@solidjs/router";
import { For, Show, createResource, createSignal } from "solid-js";
import { Effect } from "effect";
import { ApiClient, appRuntime, type ApiClientService, type ApiError } from "../effects";
import { pubkeyOfJwt } from "../lib/jwt";
import { InviteModal } from "../components/InviteModal";
import { MembersPanel, type MemberRow } from "../components/MembersPanel";
import { UserNav } from "../components/UserNav";
import "../lib/board.css";

const BOARD_ROLES = ["admin", "contributor", "viewer"] as const;

interface BoardDetail {
  board: {
    id: string;
    slug: string;
    title: string;
    visibility: "private" | "public";
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

      <Show when={error()}>
        <p class="muted" role="alert">
          {error()}
        </p>
      </Show>

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

      <Show when={showInvite()}>
        <InviteModal
          scope={{ org_slug: handle(), board_slug: params.board_slug, roles: BOARD_ROLES }}
          onClose={() => setShowInvite(false)}
          onCreated={() => void refetchInvites()}
        />
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
