// /profile — the caller's public profile. Saving PUTs /api/v0/profile/me,
// which publishes a standard kind 0 on 4a and refreshes the D1 cache, so
// the same identity shows up in every 4a-substrate client. The form seeds
// from GET /profile/me (which fills display_name with the login prefix for
// fresh users — visible and overridable here before anything publishes).

import { useNavigate } from "@solidjs/router";
import { Show, createResource, createSignal, onMount } from "solid-js";
import { Effect } from "effect";
import { ApiClient, AuthManager, appRuntime } from "../effects";
import { primeProfile, type ProfileData } from "../lib/profileStore";

const SAVED_FLASH_MS = 2200;

const fetchMe = (): Promise<{ profile: ProfileData }> =>
  appRuntime.runPromise(
    Effect.gen(function* () {
      const client = yield* ApiClient;
      return yield* client.get<{ profile: ProfileData }>("/api/v0/profile/me");
    }),
  );

const putMe = (body: Record<string, string>): Promise<{ profile: ProfileData }> =>
  appRuntime.runPromise(
    Effect.gen(function* () {
      const client = yield* ApiClient;
      return yield* client.put<{ profile: ProfileData }>("/api/v0/profile/me", body);
    }),
  );

export const Profile = () => {
  const navigate = useNavigate();

  onMount(() => {
    void appRuntime
      .runPromise(Effect.flatMap(AuthManager, (a) => a.get()))
      .then((jwt) => {
        if (jwt === null) navigate("/", { replace: true });
      });
  });

  const [me] = createResource(fetchMe);
  const [displayName, setDisplayName] = createSignal<string | null>(null);
  const [name, setName] = createSignal<string | null>(null);
  const [picture, setPicture] = createSignal<string | null>(null);
  const [about, setAbout] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Signals override the resource once touched; until then the form shows
  // what the server sent (including the login-prefix seed for fresh users).
  const field = (local: () => string | null, remote: (p: ProfileData) => string | null) => () =>
    local() ?? (me() === undefined ? "" : remote(me()!.profile) ?? "");

  const displayNameValue = field(displayName, (p) => p.display_name);
  const nameValue = field(name, (p) => p.name);
  const pictureValue = field(picture, (p) => p.picture);
  const aboutValue = field(about, (p) => p.about);

  const save = async (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError(null);
    const body: Record<string, string> = {
      display_name: displayNameValue().trim(),
      name: nameValue().trim(),
      picture: pictureValue().trim(),
      about: aboutValue().trim(),
    };
    try {
      const { profile } = await putMe(body);
      primeProfile(profile); // every <Author> chip on screen updates now
      setSaved(true);
      setTimeout(() => setSaved(false), SAVED_FLASH_MS);
    } catch {
      setError("The current pushed back. Nothing was saved — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ "max-width": "34rem", margin: "0 auto", padding: "4rem 1.5rem" }}>
      <header style={{ "margin-bottom": "2rem" }}>
        <h1 style={{ "font-size": "2.2rem" }}>Profile</h1>
        <p class="muted" style={{ "margin-top": "0.4rem" }}>
          Public — published to the 4a substrate, visible in any client.
        </p>
      </header>

      <Show when={!me.loading} fallback={<p class="muted">Finding the rhythm…</p>}>
        <form onSubmit={save}>
          <label for="pf-display">Display name</label>
          <input
            id="pf-display"
            type="text"
            maxlength="128"
            value={displayNameValue()}
            onInput={(e) => setDisplayName(e.currentTarget.value)}
          />

          <label for="pf-name">Username</label>
          <input
            id="pf-name"
            type="text"
            maxlength="64"
            placeholder="nostr-style slug, e.g. evan108108"
            value={nameValue()}
            onInput={(e) => setName(e.currentTarget.value)}
          />

          <label for="pf-picture">Picture URL</label>
          <input
            id="pf-picture"
            type="text"
            maxlength="512"
            placeholder="https://…"
            value={pictureValue()}
            onInput={(e) => setPicture(e.currentTarget.value)}
          />

          <label for="pf-about">About</label>
          <textarea
            id="pf-about"
            rows={4}
            maxlength="4000"
            value={aboutValue()}
            onInput={(e) => setAbout(e.currentTarget.value)}
          />

          <Show when={error()}>
            <p class="muted" role="alert">
              {error()}
            </p>
          </Show>

          <div
            class="actions"
            style={{ display: "flex", gap: "0.6rem", "align-items": "center", "margin-top": "1.2rem" }}
          >
            <button class="btn btn-solid" type="submit" disabled={busy()}>
              {busy() ? "Saving…" : "Save"}
            </button>
            <button class="btn" type="button" onClick={() => history.back()}>
              Cancel
            </button>
            <Show when={saved()}>
              <span class="muted" style={{ "font-size": "0.9rem" }}>
                Saved — flowing outward.
              </span>
            </Show>
          </div>
        </form>
      </Show>
    </main>
  );
};
