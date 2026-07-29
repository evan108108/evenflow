// /settings/keys — developer API key management (phase 19).
//
// The mint flow surfaces the plaintext exactly once, in a modal with a
// copy button and a can't-miss warning; after dismissal only the display
// prefix ever renders again. Revoke is a soft kill: the row stays,
// struck through, so the audit story is visible.

import { For, Show, createResource, createSignal } from "solid-js";
import { Effect } from "effect";
import { ApiClient, appRuntime, type ApiClientService, type ApiError } from "../effects";
import { TopBar } from "../components/TopBar";
import { UserNav } from "../components/UserNav";
import "../lib/board.css";

interface KeyView {
  id: string;
  name: string;
  prefix: string;
  created_at_ms: number;
  last_used_at_ms: number | null;
  revoked_at_ms: number | null;
}

const api = <T,>(f: (c: ApiClientService) => Effect.Effect<T, ApiError>): Promise<T> =>
  appRuntime.runPromise(Effect.flatMap(ApiClient, f));

const when = (ms: number | null) =>
  ms === null ? "never" : new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export const DeveloperKeys = () => {
  const [keys, { refetch }] = createResource(() =>
    api<{ keys: KeyView[] }>((c) => c.get("/api/v0/keys")).then((r) => r.keys),
  );

  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // The one-time plaintext reveal; null once dismissed, gone forever.
  const [minted, setMinted] = createSignal<{ plaintext: string; name: string } | null>(null);
  const [copied, setCopied] = createSignal(false);

  const createKey = async () => {
    const keyName = name().trim();
    if (keyName === "" || busy()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ key: KeyView; plaintext: string }>((c) =>
        c.post("/api/v0/keys", { name: keyName }),
      );
      setMinted({ plaintext: res.plaintext, name: keyName });
      setCopied(false);
      setName("");
      void refetch();
    } catch {
      setError("The current pushed back — no key was created.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = (key: KeyView) => {
    setError(null);
    api((c) => c.delete(`/api/v0/keys/${encodeURIComponent(key.id)}`))
      .then(() => void refetch())
      .catch(() => setError("The current pushed back — nothing changed."));
  };

  const copyPlaintext = () => {
    const m = minted();
    if (m === null) return;
    void navigator.clipboard.writeText(m.plaintext).then(() => setCopied(true));
  };

  return (
    <main style={{ "max-width": "var(--measure)", margin: "0 auto", padding: "4rem 1.5rem 4rem var(--page-inset-left, 3rem)" }}>
      <TopBar crumbs={[{ label: "Boards", href: "/boards" }, { label: "API keys" }]} />
      <header
        style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "0.4rem" }}
      >
        <h1 style={{ "font-size": "2.2rem" }}>API keys</h1>
        <UserNav />
      </header>
      <p class="muted" style={{ "margin-bottom": "1.8rem" }}>
        Keys authenticate the REST API and the MCP endpoint as you. Docs live at{" "}
        <a href="/docs">/docs</a>.
      </p>

      <Show when={error()}>
        <p class="muted" role="alert">
          {error()}
        </p>
      </Show>

      <section class="settings-section">
        <h2>Your keys</h2>
        <Show
          when={(keys() ?? []).length > 0}
          fallback={<p class="muted">Nothing minted yet.</p>}
        >
          <ul class="key-list">
            <For each={keys()}>
              {(key) => (
                <li class="key-row" classList={{ revoked: key.revoked_at_ms !== null }}>
                  <span class="key-name">{key.name}</span>
                  <code class="key-prefix">{key.prefix}…</code>
                  <span class="muted key-meta">
                    created {when(key.created_at_ms)} · last used {when(key.last_used_at_ms)}
                  </span>
                  <span class="grow" />
                  <Show
                    when={key.revoked_at_ms === null}
                    fallback={<span class="chip">revoked {when(key.revoked_at_ms)}</span>}
                  >
                    <button type="button" class="btn btn-danger" onClick={() => revoke(key)}>
                      Revoke
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <section class="settings-section">
        <h2>Create a key</h2>
        <div class="key-create">
          <input
            type="text"
            placeholder="What will use this key? (e.g. CI, Claude)"
            value={name()}
            maxlength={60}
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && void createKey()}
          />
          <button type="button" class="btn btn-solid" disabled={name().trim() === "" || busy()} onClick={() => void createKey()}>
            <Show when={!busy()} fallback={"Catching the current…"}>
              Create key
            </Show>
          </button>
        </div>
      </section>

      <Show when={minted()}>
        {(m) => (
          <div class="modal-overlay">
            <div class="modal" role="dialog" aria-label="API key created">
              <h2>“{m().name}” is ready</h2>
              <p class="key-warning">
                This is the only time the full key is shown. Copy it now — Evenflow keeps
                only a hash.
              </p>
              <div class="key-reveal">
                <code>{m().plaintext}</code>
                <button type="button" class="btn" onClick={copyPlaintext}>
                  {copied() ? "Copied" : "Copy"}
                </button>
              </div>
              <div class="actions" style={{ "margin-top": "1rem" }}>
                <button type="button" class="btn btn-solid" onClick={() => setMinted(null)}>
                  I've stored it
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </main>
  );
};
