// /@{handle}/settings — org administration. Personal orgs get the kind-0
// profile editor (the org IS the person) plus a handle rename; team orgs
// get the org profile editor, members, pending invites, and the danger
// zone (transfer / delete, both slug-confirmed).

import { useNavigate, useParams } from "@solidjs/router";
import { url } from "@routes-manifest";
import { For, Show, createResource, createSignal } from "solid-js";
import { Effect } from "effect";
import { ApiClient, appRuntime, type ApiClientService, type ApiError } from "../effects";
import { pubkeyOfJwt } from "../lib/jwt";
import { bootstrap } from "../lib/orgStore";
import { InviteModal } from "../components/InviteModal";
import { MembersPanel, type MemberRow } from "../components/MembersPanel";
import { StorageSection } from "../components/StorageSection";
import { TopBar } from "../components/TopBar";
import { ProfileEditor } from "./Profile";
import "../lib/board.css";

const ORG_ROLES = ["owner", "admin", "member"] as const;
const ORG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface OrgDetailResponse {
  org: {
    slug: string;
    display_name: string;
    avatar_url: string | null;
    bio: string | null;
    kind: "personal" | "team";
  };
  role: string | null;
}

interface PendingInvite {
  id: string;
  code: string;
  role: string;
  invited_email: string | null;
  expires_at_ms: number;
}

const api = <T,>(f: (c: ApiClientService) => Effect.Effect<T, ApiError>): Promise<T> =>
  appRuntime.runPromise(Effect.flatMap(ApiClient, f));

export const OrgSettings = () => {
  const params = useParams<{ handle: string }>();
  const navigate = useNavigate();
  const handle = () => params.handle.replace(/^@/, "");
  const orgApi = () => url("org.get", { org_slug: encodeURIComponent(handle()) });

  const selfPubkey = (() => {
    try {
      const jwt = window.localStorage.getItem("evenflow.jwt");
      return jwt === null ? null : pubkeyOfJwt(jwt);
    } catch {
      return null;
    }
  })();

  const [detail, { refetch: refetchDetail }] = createResource(handle, () =>
    api<OrgDetailResponse>((c) => c.get(orgApi())),
  );
  const [members, { refetch: refetchMembers }] = createResource(handle, () =>
    api<{ members: MemberRow[] }>((c) => c.get(`${orgApi()}/members`))
      .then((r) => r.members)
      .catch(() => [] as MemberRow[]),
  );
  const [invites, { refetch: refetchInvites }] = createResource(handle, () =>
    api<{ invites: PendingInvite[] }>((c) => c.get(`${orgApi()}/invites`))
      .then((r) => r.invites)
      .catch(() => [] as PendingInvite[]),
  );

  // Personal orgs don't have a membership row for the owner — the API returns
  // role: null. But if you can load the org's settings page at all, you own
  // it (personal org = your user's namespace), so you have every permission.
  const isAdmin = () =>
    detail()?.org.kind === "personal" ||
    detail()?.role === "admin" ||
    detail()?.role === "owner";
  const isOwner = () =>
    detail()?.org.kind === "personal" || detail()?.role === "owner";
  const isPersonal = () => detail()?.org.kind === "personal";

  const [displayName, setDisplayName] = createSignal<string | null>(null);
  const [bio, setBio] = createSignal<string | null>(null);
  const [avatarUrl, setAvatarUrl] = createSignal<string | null>(null);
  const [newSlug, setNewSlug] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [showInvite, setShowInvite] = createSignal(false);
  const [confirmKind, setConfirmKind] = createSignal<"delete" | "transfer" | null>(null);
  const [confirmText, setConfirmText] = createSignal("");
  const [transferTo, setTransferTo] = createSignal("");

  const field = (local: () => string | null, remote: () => string | null | undefined) => () =>
    local() ?? remote() ?? "";
  const displayNameValue = field(displayName, () => detail()?.org.display_name);
  const bioValue = field(bio, () => detail()?.org.bio);
  const avatarValue = field(avatarUrl, () => detail()?.org.avatar_url);
  const slugValue = field(newSlug, () => detail()?.org.slug);

  const saveOrg = async (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    const s = slugValue().trim();
    if (!ORG_SLUG_RE.test(s)) {
      setError("Handle must be lowercase letters, digits, and dashes.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        display_name: displayNameValue().trim(),
        bio: bioValue().trim() === "" ? null : bioValue().trim(),
        avatar_url: avatarValue().trim() === "" ? null : avatarValue().trim(),
        ...(s !== detail()?.org.slug ? { slug: s } : {}),
      };
      await api((c) => c.patch(orgApi(), body));
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
      await bootstrap({ force: true });
      if (s !== handle()) {
        navigate(`/@${s}/settings`, { replace: true });
      } else {
        void refetchDetail();
      }
    } catch {
      setError("The current pushed back. Nothing was saved — try again.");
    } finally {
      setBusy(false);
    }
  };

  const withRefresh = (call: Promise<unknown>, refresh: () => void) => {
    setError(null);
    call.then(refresh).catch(() => setError("The current pushed back — nothing changed."));
  };

  const changeRole = (pubkey: string, role: string) =>
    withRefresh(
      api((c) => c.patch(`${orgApi()}/members/${encodeURIComponent(pubkey)}`, { role })),
      () => void refetchMembers(),
    );
  const kick = (pubkey: string) =>
    withRefresh(
      api((c) => c.delete(`${orgApi()}/members/${encodeURIComponent(pubkey)}`)),
      () => void refetchMembers(),
    );
  const revokeInvite = (id: string) =>
    withRefresh(
      api((c) => c.delete(url("invite.get", { code: id }))),
      () => void refetchInvites(),
    );

  const doDelete = () => {
    if (confirmText() !== handle()) return;
    withRefresh(
      api((c) => c.delete(orgApi())),
      () => navigate("/boards", { replace: true }),
    );
  };

  const doTransfer = () => {
    if (confirmText() !== handle() || transferTo().trim() === "") return;
    withRefresh(
      api((c) =>
        c.post(`${orgApi()}/transfer`, {
          to_pubkey: transferTo().trim(),
          confirmation_slug: confirmText(),
        }),
      ),
      () => {
        setConfirmKind(null);
        void refetchDetail();
        void refetchMembers();
      },
    );
  };

  return (
    <main class="board-page">
      <TopBar
        crumbs={[
          { label: "Boards", href: "/boards" },
          { label: `@${handle()}`, href: `/@${handle()}` },
          { label: "settings" },
        ]}
      />
      <header style={{ "margin-bottom": "2rem" }}>
        <h1 style={{ "font-size": "2.2rem" }}>
          {isPersonal() ? "Your page" : detail()?.org.display_name ?? "Org settings"}
        </h1>
      </header>

      <Show when={error()}>
        <p class="muted" role="alert">
          {error()}
        </p>
      </Show>

      <Show when={!detail.loading} fallback={<p class="muted">Finding the rhythm…</p>}>
        <Show when={isPersonal()}>
          <section class="settings-section">
            <h2>Public profile</h2>
            <ProfileEditor />
          </section>
          <section class="settings-section">
            <h2>Handle</h2>
            <form class="profile-form" onSubmit={saveOrg}>
              <label for="org-slug">evenflow.work/@…</label>
              <input
                id="org-slug"
                type="text"
                maxlength="64"
                value={slugValue()}
                onInput={(e) => setNewSlug(e.currentTarget.value.toLowerCase())}
              />
              <span class="muted" style={{ "font-size": "0.8rem" }}>
                Old links keep working — the previous handle redirects forever.
              </span>
              <div class="actions" style={{ "margin-top": "1rem" }}>
                <button class="btn btn-solid" type="submit" disabled={busy()}>
                  {busy() ? "Saving…" : "Rename"}
                </button>
                <Show when={saved()}>
                  <span class="muted" style={{ "font-size": "0.9rem" }}>
                    Saved — flowing outward.
                  </span>
                </Show>
              </div>
            </form>
          </section>
          <Show when={isOwner()}>
            <StorageSection handle={handle()} />
          </Show>
        </Show>

        <Show when={!isPersonal()}>
          <section class="settings-section">
            <h2>Org profile</h2>
            <form class="profile-form" onSubmit={saveOrg}>
              <label for="org-display">Name</label>
              <input
                id="org-display"
                type="text"
                maxlength="128"
                value={displayNameValue()}
                onInput={(e) => setDisplayName(e.currentTarget.value)}
              />
              <label for="org-slug">Handle</label>
              <input
                id="org-slug"
                type="text"
                maxlength="64"
                value={slugValue()}
                onInput={(e) => setNewSlug(e.currentTarget.value.toLowerCase())}
              />
              <label for="org-avatar">Avatar URL</label>
              <input
                id="org-avatar"
                type="text"
                maxlength="512"
                placeholder="https://…"
                value={avatarValue()}
                onInput={(e) => setAvatarUrl(e.currentTarget.value)}
              />
              <label for="org-bio">Bio</label>
              <textarea
                id="org-bio"
                rows={3}
                maxlength="4000"
                value={bioValue()}
                onInput={(e) => setBio(e.currentTarget.value)}
              />
              <div class="actions" style={{ "margin-top": "1rem" }}>
                <button class="btn btn-solid" type="submit" disabled={busy() || !isAdmin()}>
                  {busy() ? "Saving…" : "Save"}
                </button>
                <Show when={saved()}>
                  <span class="muted" style={{ "font-size": "0.9rem" }}>
                    Saved — flowing outward.
                  </span>
                </Show>
              </div>
            </form>
          </section>

          <section class="settings-section">
            <h2>Members</h2>
            <Show when={!members.loading} fallback={<p class="muted">Finding the rhythm…</p>}>
              <MembersPanel
                members={members() ?? []}
                roles={ORG_ROLES}
                canManage={isAdmin()}
                selfPubkey={selfPubkey}
                onRoleChange={changeRole}
                onKick={kick}
              />
            </Show>
            <Show when={isAdmin()}>
              <div style={{ "margin-top": "1rem" }}>
                <button type="button" class="btn btn-solid" onClick={() => setShowInvite(true)}>
                  Invite
                </button>
              </div>
            </Show>
          </section>

          <Show when={isAdmin()}>
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
                        <button
                          type="button"
                          class="btn btn-danger"
                          onClick={() => revokeInvite(invite.id)}
                        >
                          Revoke
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>
          </Show>

          <Show when={isOwner()}>
            <StorageSection handle={handle()} />
            <section class="settings-section">
              <div class="danger-zone">
                <h3>Danger zone</h3>
                <div style={{ display: "flex", gap: "0.6rem" }}>
                  <button
                    type="button"
                    class="btn"
                    onClick={() => {
                      setConfirmText("");
                      setConfirmKind("transfer");
                    }}
                  >
                    Transfer ownership
                  </button>
                  <button
                    type="button"
                    class="btn btn-danger"
                    onClick={() => {
                      setConfirmText("");
                      setConfirmKind("delete");
                    }}
                  >
                    Delete org
                  </button>
                </div>
              </div>
            </section>
          </Show>
        </Show>
      </Show>

      <Show when={showInvite()}>
        <InviteModal
          scope={{ org_slug: handle(), roles: ["member", "admin"] }}
          onClose={() => setShowInvite(false)}
          onCreated={() => void refetchInvites()}
        />
      </Show>

      <Show when={confirmKind() !== null}>
        <div
          class="modal-overlay"
          onClick={(e) => e.target === e.currentTarget && setConfirmKind(null)}
        >
          <div class="modal" role="dialog">
            <h2>{confirmKind() === "delete" ? "Delete this org?" : "Transfer ownership?"}</h2>
            <Show when={confirmKind() === "transfer"}>
              <label for="transfer-to">New owner's pubkey</label>
              <input
                id="transfer-to"
                type="text"
                value={transferTo()}
                onInput={(e) => setTransferTo(e.currentTarget.value)}
              />
            </Show>
            <p>
              Type <strong>{handle()}</strong> to confirm.
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
                disabled={confirmText() !== handle()}
                onClick={() => (confirmKind() === "delete" ? doDelete() : doTransfer())}
              >
                {confirmKind() === "delete" ? "Delete forever" : "Transfer"}
              </button>
              <button type="button" class="btn" onClick={() => setConfirmKind(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </Show>
    </main>
  );
};
