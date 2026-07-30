// /signin/nostr — key-based sign-in (phase 16.7).
//
// Two ways in, mirroring the Worker's two proof shapes:
//   * NIP-07 extension (Alby, nos2x): one click — the extension signs a
//     NIP-98 event for the sign-in POST. Detected at mount.
//   * Paste-and-sign: paste a pubkey (hex or npub), sign the issued
//     challenge externally (nak / nsec.app), paste the signed event back.
//
// After the JWT lands, an OPT-IN "hold my key in this tab" step lets
// paste-flow users read private boards in-browser: sessionStorage at
// most, cleared on tab close, behind an explicit warning. Keys are never
// requested by default and never leave the tab.

import { useNavigate } from "@solidjs/router";
import { Show, createSignal, onMount } from "solid-js";
import { Effect } from "effect";
import { AuthManager, appRuntime } from "../effects";
import { bootstrap } from "../lib/orgStore";
import {
  nip07,
  normalizePrivkey,
  normalizePubkey,
  storeTabKey,
  type Nip07Provider,
} from "../lib/nostr";
import "../lib/board.css";

interface ChallengeWire {
  readonly challenge: string;
  readonly sign_hint: string;
}

const SIGNIN_PATH = "/api/v0/signin/nostr";

export const NostrSignIn = () => {
  const navigate = useNavigate();
  const [extension, setExtension] = createSignal<Nip07Provider | null>(null);
  const [pubkeyInput, setPubkeyInput] = createSignal("");
  const [challenge, setChallenge] = createSignal<ChallengeWire | null>(null);
  const [signedPaste, setSignedPaste] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  // Post-JWT step: the optional tab-key opt-in.
  const [signedIn, setSignedIn] = createSignal(false);
  const [holdKey, setHoldKey] = createSignal(false);
  const [nsecInput, setNsecInput] = createSignal("");

  onMount(() => setExtension(nip07()));

  const finishSignin = async (jwt: string) => {
    await appRuntime.runPromise(Effect.flatMap(AuthManager, (a) => a.set(jwt)));
    await bootstrap({ force: true });
    setSignedIn(true);
  };

  const continueToBoards = () => {
    if (holdKey()) {
      const priv = normalizePrivkey(nsecInput());
      if (priv === null) {
        setError("That key doesn't parse as nsec1… or 64-char hex.");
        return;
      }
      storeTabKey(priv);
      priv.fill(0);
      setNsecInput("");
    }
    navigate("/boards", { replace: true });
  };

  const signInWithExtension = async () => {
    const provider = extension();
    if (provider === null) return;
    setBusy(true);
    setError(null);
    try {
      const url = `${window.location.origin}${SIGNIN_PATH}`;
      const signed = await provider.signEvent({
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["u", url], ["method", "POST"]],
        content: "",
      });
      const res = await fetch(SIGNIN_PATH, {
        method: "POST",
        headers: { Authorization: `Nostr ${btoa(JSON.stringify(signed))}` },
      });
      const body = (await res.json()) as { jwt?: string; reason?: string };
      if (!res.ok || body.jwt === undefined) {
        setError(`Sign-in refused (${body.reason ?? res.status}).`);
        return;
      }
      await finishSignin(body.jwt);
    } catch {
      setError("The extension declined to sign.");
    } finally {
      setBusy(false);
    }
  };

  const fetchChallenge = async () => {
    const pubkey = normalizePubkey(pubkeyInput());
    if (pubkey === null) {
      setError("That doesn't parse as npub1… or 64-char hex.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${SIGNIN_PATH}/challenge?pubkey=${pubkey}`);
      if (!res.ok) {
        setError("Couldn't mint a challenge.");
        return;
      }
      setChallenge((await res.json()) as ChallengeWire);
    } finally {
      setBusy(false);
    }
  };

  const submitSignedEvent = async () => {
    const wire = challenge();
    if (wire === null) return;
    let event: unknown;
    try {
      event = JSON.parse(signedPaste());
    } catch {
      setError("That's not JSON — paste the whole signed event.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(SIGNIN_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge: wire.challenge, signed_event: event }),
      });
      const body = (await res.json()) as { jwt?: string; reason?: string };
      if (!res.ok || body.jwt === undefined) {
        setError(`Sign-in refused (${body.reason ?? res.status}).`);
        return;
      }
      await finishSignin(body.jwt);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="nostr-signin">
      <header>
        <a class="docs-wordmark" href="/">Evenflow</a>
        <h1>Sign in with a Nostr key</h1>
        <p class="muted">
          For people — and agents — who hold their own keys. Humans usually want the
          Google/GitHub buttons on the <a href="/">front page</a>; a key sign-in gets you
          level-4 privacy on encrypted boards: grants are addressed to <em>your</em> key,
          and only your key decrypts.
        </p>
      </header>

      <Show when={error()}>
        <p class="attachment-error" role="alert">{error()}</p>
      </Show>

      <Show when={!signedIn()} fallback={
        <section class="settings-section">
          <h2>You're in</h2>
          <p>One optional step: to read private boards in this browser, Evenflow needs your
            key at decrypt time. With a NIP-07 extension, skip this — the extension handles it.</p>
          <label class="key-warning" style={{ display: "block" }}>
            <input type="checkbox" checked={holdKey()} onInput={(e) => setHoldKey(e.currentTarget.checked)} />
            {" "}Hold my key in this tab only. It lives in sessionStorage, dies with the tab,
            and is never sent anywhere. Don't do this on a shared machine.
          </label>
          <Show when={holdKey()}>
            <input
              type="password"
              placeholder="nsec1… or hex private key"
              value={nsecInput()}
              onInput={(e) => setNsecInput(e.currentTarget.value)}
              style={{ width: "100%", "margin-top": "0.6rem" }}
            />
          </Show>
          <div class="actions" style={{ "margin-top": "1rem" }}>
            <button type="button" class="btn btn-solid" onClick={continueToBoards}>
              Continue to boards
            </button>
          </div>
        </section>
      }>
        <Show when={extension() !== null}>
          <section class="settings-section">
            <h2>Browser extension</h2>
            <p class="muted">A NIP-07 signer is available — the smooth path.</p>
            <button type="button" class="btn btn-solid" disabled={busy()} onClick={() => void signInWithExtension()}>
              Sign in with extension
            </button>
          </section>
        </Show>

        <section class="settings-section">
          <h2>{extension() !== null ? "Or paste and sign" : "Paste and sign"}</h2>
          <ol class="nostr-steps">
            <li>
              <label for="ns-pubkey">Your public key</label>
              <div class="key-create">
                <input
                  id="ns-pubkey"
                  type="text"
                  placeholder="npub1… or 64-char hex"
                  value={pubkeyInput()}
                  onInput={(e) => setPubkeyInput(e.currentTarget.value)}
                />
                <button type="button" class="btn" disabled={busy() || pubkeyInput().trim() === ""} onClick={() => void fetchChallenge()}>
                  Get challenge
                </button>
              </div>
            </li>
            <Show when={challenge()}>
              {(wire) => (
                <>
                  <li>
                    <label>Sign it with your key (expires in 5 minutes)</label>
                    <pre class="docs-code">{wire().sign_hint}</pre>
                  </li>
                  <li>
                    <label for="ns-signed">Paste the signed event</label>
                    <textarea
                      id="ns-signed"
                      rows={5}
                      placeholder='{"id":"…","pubkey":"…","sig":"…"}'
                      value={signedPaste()}
                      onInput={(e) => setSignedPaste(e.currentTarget.value)}
                    />
                    <div class="actions" style={{ "margin-top": "0.6rem" }}>
                      <button type="button" class="btn btn-solid" disabled={busy() || signedPaste().trim() === ""} onClick={() => void submitSignedEvent()}>
                        Sign in
                      </button>
                    </div>
                  </li>
                </>
              )}
            </Show>
          </ol>
        </section>

        <p class="muted nostr-modes">
          Three ways things connect to Evenflow: an agent acting <em>as you</em> uses an
          API key; OAuth is for humans with accounts; a Nostr key makes an agent (or a
          human) a first-class member with its own end-to-end grants — that's this page.
        </p>
      </Show>
    </main>
  );
};
