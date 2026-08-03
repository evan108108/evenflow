// /i/inv-{code} — the invite preview page. Anonymous-readable (GET
// /api/v0/invites/:code needs no JWT): shows who invited you, into what,
// as which role, and when it lapses. Accept while signed in grants and
// redirects; signed out, the code is stashed and the OAuth flow brings the
// browser back here to auto-continue.

import { useNavigate, useParams } from "@solidjs/router";
import { url } from "@routes-manifest";
import { Show, createResource, createSignal, onMount } from "solid-js";
import { Effect } from "effect";
import { ApiClient, AuthManager, appRuntime, type ApiClientService, type ApiError } from "../effects";
import { stashPendingInvite, takePendingInvite } from "../lib/orgStore";
import "../lib/board.css";

interface InvitePreviewData {
  code: string;
  org: { slug: string; display_name: string; avatar_url: string | null };
  board: { slug: string; title: string } | null;
  role: string;
  invited_by_profile: {
    pubkey: string;
    name: string | null;
    display_name: string | null;
    picture: string | null;
  };
  expires_at_ms: number;
  valid: boolean;
  reason?: string;
}

const DAY_MS = 86_400_000;

const REASON_COPY: Record<string, string> = {
  expired: "This invite has drifted past its expiration.",
  revoked: "This invite was revoked.",
  used: "This invite was already used.",
  declined: "This invite was declined.",
};

const api = <T,>(f: (c: ApiClientService) => Effect.Effect<T, ApiError>): Promise<T> =>
  appRuntime.runPromise(Effect.flatMap(ApiClient, f));

export const InvitePreview = () => {
  const params = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [preview] = createResource(() =>
    api<InvitePreviewData>((c) => c.get(url("invite.get", { code: params.code }))),
  );
  const [signedIn, setSignedIn] = createSignal<boolean | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [declined, setDeclined] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const accept = async () => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ target_url: string }>((c) =>
        c.post(url("invite.accept", { code: params.code }), {}),
      );
      navigate(res.target_url, { replace: true });
    } catch {
      setError("The current pushed back — the invite could not be accepted.");
      setBusy(false);
    }
  };

  onMount(() => {
    void appRuntime.runPromise(Effect.flatMap(AuthManager, (a) => a.get())).then((jwt) => {
      setSignedIn(jwt !== null);
      // OAuth return leg: if this code was stashed pre-sign-in, continue.
      if (jwt !== null && takePendingInvite() === params.code) void accept();
    });
  });

  const acceptSignedOut = (provider: "google" | "github") => {
    stashPendingInvite(params.code);
    window.location.assign(`${url("auth.oauth.start")}?provider=${provider}`);
  };

  const decline = async () => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await api((c) => c.post(url("invite.decline", { code: params.code }), {}));
      setDeclined(true);
    } catch {
      setError("The current pushed back — try again.");
    } finally {
      setBusy(false);
    }
  };

  const inviterName = () => {
    const p = preview()?.invited_by_profile;
    return p?.display_name || p?.name || `${p?.pubkey.slice(0, 8) ?? ""}…`;
  };

  const targetLabel = () => {
    const data = preview();
    if (data === undefined) return "";
    return data.board === null
      ? `${data.org.display_name} (@${data.org.slug})`
      : `${data.board.title} (@${data.org.slug}/${data.board.slug})`;
  };

  const daysLeft = () =>
    Math.max(1, Math.round(((preview()?.expires_at_ms ?? 0) - Date.now()) / DAY_MS));

  return (
    <main style={{ display: "grid", "place-items": "center", "min-height": "100vh" }}>
      <Show when={!preview.loading} fallback={<p class="muted">Finding the rhythm…</p>}>
        <Show
          when={preview.error === undefined}
          fallback={
            <p class="muted">
              This invite is drifting — it may never have existed.{" "}
              <a href="/">Head back to the flow →</a>
            </p>
          }
        >
          <div style={{ "text-align": "center", "max-width": "28rem", padding: "1.5rem" }}>
            <Show when={preview()?.invited_by_profile.picture}>
              {(pic) => (
                <img
                  src={pic()}
                  alt=""
                  width="72"
                  height="72"
                  style={{ "border-radius": "50%", "object-fit": "cover", "margin-bottom": "1rem" }}
                  onError={(e) => (e.currentTarget.style.display = "none")}
                />
              )}
            </Show>
            <Show
              when={!declined()}
              fallback={<p style={{ "font-size": "1.1rem" }}>Declined. Nothing joins the flow.</p>}
            >
              <h1 class="serif" style={{ "font-size": "1.9rem", "margin-bottom": "0.8rem" }}>
                {inviterName()} invited you
              </h1>
              <p style={{ "margin-bottom": "0.4rem" }}>
                to <strong>{targetLabel()}</strong> as <strong>{preview()?.role}</strong>
              </p>
              <Show
                when={preview()?.valid}
                fallback={
                  <p class="muted" style={{ "margin-top": "1rem" }}>
                    {REASON_COPY[preview()?.reason ?? ""] ?? "This invite is no longer valid."}
                  </p>
                }
              >
                <p class="muted" style={{ "font-size": "0.9rem" }}>
                  expires in {daysLeft()} day{daysLeft() === 1 ? "" : "s"}
                </p>
                <Show when={error()}>
                  <p class="muted" role="alert">
                    {error()}
                  </p>
                </Show>
                <div
                  style={{
                    display: "flex",
                    gap: "0.6rem",
                    "justify-content": "center",
                    "margin-top": "1.6rem",
                  }}
                >
                  <Show
                    when={signedIn()}
                    fallback={
                      <>
                        <button
                          class="btn btn-solid"
                          disabled={busy()}
                          onClick={() => acceptSignedOut("google")}
                        >
                          Accept with Google
                        </button>
                        <button class="btn" disabled={busy()} onClick={() => acceptSignedOut("github")}>
                          Accept with GitHub
                        </button>
                      </>
                    }
                  >
                    <button class="btn btn-solid" disabled={busy()} onClick={() => void accept()}>
                      {busy() ? "Joining…" : "Accept"}
                    </button>
                  </Show>
                  <button class="btn" disabled={busy()} onClick={() => void decline()}>
                    Decline
                  </button>
                </div>
              </Show>
            </Show>
          </div>
        </Show>
      </Show>
    </main>
  );
};
