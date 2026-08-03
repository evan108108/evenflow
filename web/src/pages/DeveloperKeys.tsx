// /settings/keys — developer API key management (phase 19).
//
// The mint flow surfaces the plaintext exactly once, in a modal with a
// copy button and a can't-miss warning; after dismissal only the display
// prefix ever renders again. Revoke is a soft kill: the row stays,
// struck through, so the audit story is visible.

import { For, Show, createResource, createSignal } from "solid-js";
import { url } from "@routes-manifest";
import { API_KEY_ROTATION_GRACE_MS } from "@apikey-policy";
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
  /** EFB-99 — when this key was rotated away from. Null = never rotated. */
  rotated_at_ms: number | null;
  /** The successor's id, resolved to a prefix against this same list. */
  rotated_to_id: string | null;
}

/**
 * Read from the server's own constant rather than written as prose, so the
 * page cannot go on promising 24 hours after someone changes the window.
 */
const GRACE_HOURS = Math.round(API_KEY_ROTATION_GRACE_MS / 3_600_000);

const api = <T,>(f: (c: ApiClientService) => Effect.Effect<T, ApiError>): Promise<T> =>
  appRuntime.runPromise(Effect.flatMap(ApiClient, f));

const when = (ms: number | null) =>
  ms === null ? "never" : new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export const DeveloperKeys = () => {
  const [keys, { refetch }] = createResource(() =>
    // `key.list`, not `key.create`. Both live at /keys and differ only by verb,
    // so naming the wrong id here resolved to the right URL and the mistake
    // could not surface — exactly the client-server disagreement the manifest
    // exists to make impossible. Asking for the id that means "list" is the
    // whole point of asking the manifest at all.
    api<{ keys: KeyView[] }>((c) => c.get(url("key.list"))).then((r) => r.keys),
  );

  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // The one-time plaintext reveal; null once dismissed, gone forever.
  const [minted, setMinted] = createSignal<
    { plaintext: string; name: string; rotated: boolean } | null
  >(null);
  const [copied, setCopied] = createSignal(false);

  const createKey = async () => {
    const keyName = name().trim();
    if (keyName === "" || busy()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ key: KeyView; plaintext: string }>((c) =>
        c.post(url("key.create"), { name: keyName }),
      );
      setMinted({ plaintext: res.plaintext, name: keyName, rotated: false });
      setCopied(false);
      setName("");
      void refetch();
    } catch {
      setError("The current pushed back — no key was created.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Rotation is destructive-adjacent rather than destructive: the old key
   * keeps working for the grace window, so the confirm names the window and
   * the see-it-once semantics instead of the this-cannot-be-undone language
   * revoke uses. Same window.confirm shape the rest of the app uses.
   */
  const rotate = (key: KeyView) => {
    if (
      !window.confirm(
        `Rotate “${key.name}”? The current key keeps working for ${GRACE_HOURS} hours, then stops. You'll see the new key once.`,
      )
    ) {
      return;
    }
    setError(null);
    api<{ key: KeyView; plaintext: string }>((c) => c.post(url("key.rotate", { id: key.id }), {}))
      .then((res) => {
        setMinted({ plaintext: res.plaintext, name: res.key.name, rotated: true });
        setCopied(false);
        void refetch();
      })
      .catch(() => setError("The current pushed back — the key was not rotated."));
  };

  /**
   * The successor's display prefix. The successor is always one of the
   * caller's own keys, so it is already in the list this page holds — no
   * lookup, and it keeps rendering even after the successor is itself
   * revoked, because a revoked row is still listed.
   */
  const successorPrefix = (key: KeyView): string | null =>
    (keys() ?? []).find((k) => k.id === key.rotated_to_id)?.prefix ?? null;

  const revoke = (key: KeyView) => {
    // Destructive and one-way: there is no un-revoke route, and anything
    // holding this key is locked out the moment the DELETE lands. Same
    // window.confirm shape the rest of the app uses for deletes, and it names
    // the key so a mis-aimed click on the wrong row is legible before it fires.
    if (
      !window.confirm(
        `Revoke “${key.name}”? Anything using this key stops working immediately, and this can't be undone.`,
      )
    ) {
      return;
    }
    setError(null);
    api((c) => c.delete(url("key.delete", { id: key.id })))
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
        Keys authenticate the REST API and the MCP endpoint as you. Rotating a key mints a
        replacement and leaves the old one working for {GRACE_HOURS} hours, so you can swap
        it over without downtime. Docs live at <a href="/docs">/docs</a>.
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
                  {/* Three states, most-final first: revoked wins over
                      rotated, because a rotated key that was then revoked is
                      dead, not waiting. Only a key that is neither can be
                      acted on. */}
                  <Show
                    when={key.revoked_at_ms === null}
                    fallback={<span class="chip">revoked {when(key.revoked_at_ms)}</span>}
                  >
                    <Show
                      when={key.rotated_at_ms === null}
                      fallback={
                        <span class="chip">
                          rotated {when(key.rotated_at_ms)}
                          <Show when={successorPrefix(key)}>
                            {(prefix) => <>, replaced by {prefix()}…</>}
                          </Show>
                        </span>
                      }
                    >
                      <button type="button" class="btn" onClick={() => rotate(key)}>
                        Rotate
                      </button>
                      <button type="button" class="btn btn-danger" onClick={() => revoke(key)}>
                        Revoke
                      </button>
                    </Show>
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
              <h2>
                “{m().name}” is {m().rotated ? "rotated" : "ready"}
              </h2>
              <p class="key-warning">
                This is the only time the full key is shown. Copy it now — Evenflow keeps
                only a hash.
              </p>
              <Show when={m().rotated}>
                <p class="muted">
                  The previous key keeps working for {GRACE_HOURS} hours so you can swap it
                  over, then stops for good.
                </p>
              </Show>
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
