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
import { bootstrap } from "../lib/orgStore";
import "../lib/board.css";

const SAVED_FLASH_MS = 2200;
const MAX_UPLOAD_BYTES = 256 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

interface MeResponse {
  profile: ProfileData;
  /** "oauth" when picture is a response-only seed from the provider avatar. */
  seeded_from?: "oauth" | null;
}

const fetchMe = (): Promise<MeResponse> =>
  appRuntime.runPromise(
    Effect.gen(function* () {
      const client = yield* ApiClient;
      return yield* client.get<MeResponse>("/api/v0/profile/me");
    }),
  );

const uploadPicture = (image_b64: string, content_type: string): Promise<{ url: string }> =>
  appRuntime.runPromise(
    Effect.gen(function* () {
      const client = yield* ApiClient;
      return yield* client.post<{ url: string }>("/api/v0/profile/picture", {
        image_b64,
        content_type,
      });
    }),
  );

/** File → bare base64 (no data: prefix) via FileReader. */
const fileToB64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

const putMe = (body: Record<string, string>): Promise<{ profile: ProfileData }> =>
  appRuntime.runPromise(
    Effect.gen(function* () {
      const client = yield* ApiClient;
      return yield* client.put<{ profile: ProfileData }>("/api/v0/profile/me", body);
    }),
  );

/** The kind-0 editor form, embeddable (org settings reuses it for personal orgs). */
export const ProfileEditor = () => {
  const [me] = createResource(fetchMe);
  const [displayName, setDisplayName] = createSignal<string | null>(null);
  const [name, setName] = createSignal<string | null>(null);
  const [picture, setPicture] = createSignal<string | null>(null);
  const [about, setAbout] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [uploading, setUploading] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let fileInput: HTMLInputElement | undefined;

  // The provider avatar URL, when this load was seeded from OAuth. Held for
  // the session so "Use Google/GitHub pic" can restore after a change.
  const oauthSeed = () =>
    me()?.seeded_from === "oauth" ? (me()!.profile.picture ?? null) : null;
  // Banner shows while the seed is what's displayed (picture untouched).
  const showSeedBanner = () => oauthSeed() !== null && picture() === null;

  const pickFile = async (file: File) => {
    setError(null);
    const type = file.type.toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.includes(type)) {
      setError("Use a JPEG, PNG, or WebP image.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`Image too large — max ${Math.floor(MAX_UPLOAD_BYTES / 1024)} KB.`);
      return;
    }
    setUploading(true);
    try {
      const b64 = await fileToB64(file);
      const { url } = await uploadPicture(b64, type);
      setPicture(url); // preview only — published on Save
    } catch {
      setError("Upload drifted off course. Try again.");
    } finally {
      setUploading(false);
    }
  };

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
    <Show when={!me.loading} fallback={<p class="muted">Finding the rhythm…</p>}>
        <form class="profile-form" onSubmit={save}>
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

          <label>Picture</label>
          <Show when={showSeedBanner()}>
            <p class="seed-banner muted">
              Your {me()?.profile.pubkey.startsWith("google:") ? "Google" : "GitHub"} avatar —
              Save to keep it.
            </p>
          </Show>
          <div class="profile-avatar-row">
            <Show
              when={pictureValue().trim() !== ""}
              fallback={<div class="profile-avatar-placeholder">no image</div>}
            >
              <img
                class="profile-avatar-preview"
                src={pictureValue()}
                alt=""
                onError={(e) => (e.currentTarget.style.display = "none")}
              />
            </Show>
            <div class="profile-avatar-actions">
              <input
                ref={fileInput}
                type="file"
                accept={ALLOWED_IMAGE_TYPES.join(",")}
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  e.currentTarget.value = "";
                  if (file !== undefined) void pickFile(file);
                }}
              />
              <div style={{ display: "flex", gap: "0.5rem", "flex-wrap": "wrap" }}>
                <button type="button" class="btn" disabled={uploading()} onClick={() => fileInput?.click()}>
                  {uploading() ? "Uploading…" : "Upload picture"}
                </button>
                <Show when={oauthSeed() !== null && pictureValue() !== oauthSeed()}>
                  <button type="button" class="btn" onClick={() => setPicture(oauthSeed())}>
                    Use {me()?.profile.pubkey.startsWith("google:") ? "Google" : "GitHub"} pic
                  </button>
                </Show>
                <Show when={pictureValue().trim() !== ""}>
                  <button type="button" class="btn" onClick={() => setPicture("")}>
                    Remove
                  </button>
                </Show>
              </div>
              <span class="muted" style={{ "font-size": "0.75rem" }}>
                JPEG, PNG, or WebP up to 256 KB. Stored on 4a; published when you Save.
              </span>
              <details class="picture-url-advanced">
                <summary class="muted">advanced: paste URL</summary>
                <input
                  id="pf-picture"
                  type="text"
                  maxlength="512"
                  placeholder="https://…"
                  value={pictureValue()}
                  onInput={(e) => setPicture(e.currentTarget.value)}
                />
              </details>
            </div>
          </div>

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
            style={{ display: "flex", gap: "0.6rem", "align-items": "center", "margin-top": "1.4rem" }}
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
  );
};

/**
 * /profile — now a bounce to the caller's org settings (/@{me}/settings),
 * where the same editor lives. Kept as a route so old bookmarks and the
 * UserNav menu keep working; signed-out callers drift home.
 */
export const Profile = () => {
  const navigate = useNavigate();

  onMount(() => {
    void appRuntime
      .runPromise(Effect.flatMap(AuthManager, (a) => a.get()))
      .then(async (jwt) => {
        if (jwt === null) {
          navigate("/", { replace: true });
          return;
        }
        const who = await bootstrap();
        if (who !== null) navigate(`/@${who.handle}/settings`, { replace: true });
      });
  });

  return (
    <main style={{ display: "grid", "place-items": "center", "min-height": "100vh" }}>
      <p class="muted">Catching the current…</p>
    </main>
  );
};
