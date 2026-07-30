// MembersPanel — the shared members list UI: <Author> chip per row, a role
// dropdown and kick button when the caller may manage, read-only chips
// otherwise. Used by board settings and team-org settings; the parent owns
// the API calls (org- vs board-scoped) and passes them in.

import { For, Show } from "solid-js";
import { Author } from "./Author";
import { AssigneeAvatar } from "./AssigneeAvatar";

export interface MemberRow {
  pubkey: string;
  role: string;
  added_at_ms: number;
}

export const MembersPanel = (props: {
  members: ReadonlyArray<MemberRow>;
  roles: ReadonlyArray<string>;
  canManage: boolean;
  /** The caller — their own row never shows a kick button. */
  selfPubkey: string | null;
  onRoleChange: (pubkey: string, role: string) => void;
  onKick: (pubkey: string) => void;
  /** Private boards: per-member key-grant status line (phase 16.5). */
  grantLabel?: (pubkey: string) => string | null;
}) => (
  <Show when={props.members.length > 0} fallback={<p class="muted">Quiet so far.</p>}>
    <ul style={{ "list-style": "none", margin: 0, padding: 0 }}>
      <For each={props.members}>
        {(member) => (
          <li class="member-row">
            <span style={{ display: "inline-flex", "align-items": "center", gap: "0.5rem" }}>
              <AssigneeAvatar pubkey={member.pubkey} size={24} />
              <Author pubkey={member.pubkey} />
            </span>
            <Show when={props.grantLabel?.(member.pubkey) ?? null}>
              {(label) => (
                <span class="muted" style={{ "font-size": "0.78rem", "margin-left": "0.6rem" }}>
                  {label()}
                </span>
              )}
            </Show>
            <span class="grow" />
            <Show
              when={props.canManage && member.pubkey !== props.selfPubkey}
              fallback={<span class="chip role-chip">{member.role}</span>}
            >
              <select
                value={member.role}
                aria-label={`role of ${member.pubkey}`}
                onChange={(e) => props.onRoleChange(member.pubkey, e.currentTarget.value)}
              >
                <For each={props.roles}>{(r) => <option value={r}>{r}</option>}</For>
              </select>
              <button
                type="button"
                class="btn btn-danger"
                onClick={() => props.onKick(member.pubkey)}
              >
                Kick
              </button>
            </Show>
          </li>
        )}
      </For>
    </ul>
  </Show>
);
