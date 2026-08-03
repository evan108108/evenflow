// Invite modal — three tabs over the same POST /api/v0/invites record:
//   Link   — generates a shareable /i/inv-… URL (role, expiration, single-use)
//   Email  — same invite, plus POST /invites/:id/email fires the notification
//            (bind-to-email optionally locks acceptance to that address)
//   Nostr  — pre-issue the invite bound to a specific pubkey. Only the exact
//            Nostr identity can accept — no URL-leak race between an AI agent
//            and a human tripping on the link (migration 0020).

import { Show, createSignal } from "solid-js";
import { url } from "@routes-manifest";
import { Effect } from "effect";
import { ApiClient, appRuntime } from "../effects";

const EXPIRY_CHOICES_DAYS = [1, 3, 7, 14, 30] as const;
const DEFAULT_EXPIRY_DAYS = 7;
const HOURS_PER_DAY = 24;

export interface InviteScope {
  org_slug: string;
  /** Absent = org-level invite. */
  board_slug?: string;
  /** Selectable roles for this scope. */
  roles: ReadonlyArray<string>;
}

interface InviteCreateResponse {
  invite: { id: string; code: string };
  url: string;
}

const createInvite = (body: Record<string, unknown>): Promise<InviteCreateResponse> =>
  appRuntime.runPromise(
    Effect.flatMap(ApiClient, (c) => c.post<InviteCreateResponse>(url("invite.create"), body)),
  );

const emailInvite = (id: string): Promise<{ sent: boolean }> =>
  appRuntime.runPromise(
    Effect.flatMap(ApiClient, (c) =>
      c.post<{ sent: boolean }>(url("invite.email.send", { id: id }), {}),
    ),
  );

export const InviteModal = (props: {
  scope: InviteScope;
  onClose: () => void;
  onCreated?: () => void;
}) => {
  const [tab, setTab] = createSignal<"link" | "email" | "nostr">("link");
  const [role, setRole] = createSignal(props.scope.roles[0] ?? "member");
  const [days, setDays] = createSignal(DEFAULT_EXPIRY_DAYS);
  const [singleUse, setSingleUse] = createSignal(true);
  const [email, setEmail] = createSignal("");
  const [bindToEmail, setBindToEmail] = createSignal(false);
  const [pubkey, setPubkey] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [resultUrl, setResultUrl] = createSignal<string | null>(null);
  const [emailSent, setEmailSent] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);

  const validPubkey = (v: string): boolean => /^[0-9a-f]{64}$/.test(v.trim().toLowerCase());

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    if (tab() === "email" && !email().includes("@")) {
      setError("Enter an email address.");
      return;
    }
    if (tab() === "nostr" && !validPubkey(pubkey())) {
      setError("Enter a 64-character hex Nostr pubkey.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        org_slug: props.scope.org_slug,
        ...(props.scope.board_slug === undefined ? {} : { board_slug: props.scope.board_slug }),
        role: role(),
        expires_hours: days() * HOURS_PER_DAY,
        single_use: singleUse(),
        ...(tab() === "email"
          ? { invited_email: email().trim(), bind_to_email: bindToEmail() }
          : {}),
        ...(tab() === "nostr" ? { bind_to_pubkey: pubkey().trim().toLowerCase() } : {}),
      };
      const created = await createInvite(body);
      if (tab() === "email") {
        await emailInvite(created.invite.id);
        setEmailSent(email().trim());
      } else {
        // Both Link and Nostr surface the URL — Nostr's URL is just
        // additionally gated to the pubkey it was bound to.
        setResultUrl(created.url);
      }
      props.onCreated?.();
    } catch {
      setError("The current pushed back. Nothing was sent — try again.");
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    const url = resultUrl();
    if (url === null) return;
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div class="modal-overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="modal" role="dialog" aria-label="Invite">
        <h2>Invite</h2>

        <div class="tab-row" role="tablist">
          <button
            type="button"
            classList={{ active: tab() === "link" }}
            onClick={() => setTab("link")}
          >
            Link
          </button>
          <button
            type="button"
            classList={{ active: tab() === "email" }}
            onClick={() => setTab("email")}
          >
            Email
          </button>
          <button
            type="button"
            classList={{ active: tab() === "nostr" }}
            onClick={() => setTab("nostr")}
          >
            Nostr
          </button>
        </div>

        <Show
          when={resultUrl() === null && emailSent() === null}
          fallback={
            <div>
              <Show when={resultUrl()}>
                {(url) => (
                  <>
                    <p>Share this link — it grants {role()} access.</p>
                    <div class="invite-url-row">
                      <input type="text" readOnly value={url()} onFocus={(e) => e.currentTarget.select()} />
                      <button type="button" class="btn" onClick={copy}>
                        {copied() ? "Copied" : "Copy"}
                      </button>
                    </div>
                  </>
                )}
              </Show>
              <Show when={emailSent()}>
                {(to) => <p>Invitation sent to {to()} — flowing outward.</p>}
              </Show>
              <div class="actions" style={{ "margin-top": "1.2rem" }}>
                <button type="button" class="btn btn-solid" onClick={props.onClose}>
                  Done
                </button>
              </div>
            </div>
          }
        >
          <form onSubmit={submit}>
            <label for="inv-role">Role</label>
            <select id="inv-role" value={role()} onChange={(e) => setRole(e.currentTarget.value)}>
              {props.scope.roles.map((r) => (
                <option value={r}>{r}</option>
              ))}
            </select>

            <label for="inv-days">Expires in</label>
            <select
              id="inv-days"
              value={String(days())}
              onChange={(e) => setDays(Number(e.currentTarget.value))}
            >
              {EXPIRY_CHOICES_DAYS.map((d) => (
                <option value={String(d)}>{d === 1 ? "1 day" : `${d} days`}</option>
              ))}
            </select>

            <Show when={tab() === "email"}>
              <label for="inv-email">Email address</label>
              <input
                id="inv-email"
                type="text"
                placeholder="them@example.com"
                value={email()}
                onInput={(e) => setEmail(e.currentTarget.value)}
              />
              <label style={{ display: "flex", gap: "0.5rem", "align-items": "center" }}>
                <input
                  type="checkbox"
                  checked={bindToEmail()}
                  onChange={(e) => setBindToEmail(e.currentTarget.checked)}
                />
                Only this email can accept
              </label>
            </Show>

            <Show when={tab() === "nostr"}>
              <label for="inv-pubkey">Nostr pubkey (hex)</label>
              <input
                id="inv-pubkey"
                type="text"
                placeholder="64 characters, lowercase hex"
                value={pubkey()}
                onInput={(e) => setPubkey(e.currentTarget.value)}
                style={{ "font-family": "monospace", "font-size": "0.85rem" }}
              />
              <p class="muted" style={{ "font-size": "0.8rem", "margin-top": "0.4rem" }}>
                The invite URL will only accept from this exact identity — safe to
                share, no human racer can claim it.
              </p>
            </Show>

            <label style={{ display: "flex", gap: "0.5rem", "align-items": "center" }}>
              <input
                type="checkbox"
                checked={singleUse()}
                onChange={(e) => setSingleUse(e.currentTarget.checked)}
              />
              Single use
            </label>

            <Show when={error()}>
              <p class="muted" role="alert">
                {error()}
              </p>
            </Show>

            <div class="actions">
              <button type="submit" class="btn btn-solid" disabled={busy()}>
                {busy()
                  ? "Working…"
                  : tab() === "email"
                    ? "Send invite"
                    : tab() === "nostr"
                      ? "Generate bound link"
                      : "Generate link"}
              </button>
              <button type="button" class="btn" onClick={props.onClose}>
                Cancel
              </button>
            </div>
          </form>
        </Show>
      </div>
    </div>
  );
};
