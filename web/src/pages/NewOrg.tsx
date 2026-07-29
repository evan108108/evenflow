// /o/new — create a team org. Personal orgs are never created here; they
// auto-create on session bootstrap. Slug live-derives from the name until
// touched, validated lowercase-kebab client-side (the server enforces the
// reserved blocklist and uniqueness — 409s surface inline).

import { useNavigate } from "@solidjs/router";
import { Show, createSignal, onMount } from "solid-js";
import { Effect } from "effect";
import { ApiClient, AuthManager, appRuntime, type ApiClientService, type ApiError } from "../effects";
import { bootstrap, setLastActiveOrg } from "../lib/orgStore";
import { unwrapApiError } from "./board/store";
import "../lib/board.css";

const ORG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const slugifyName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

const api = <T,>(f: (c: ApiClientService) => Effect.Effect<T, ApiError>): Promise<T> =>
  appRuntime.runPromise(Effect.flatMap(ApiClient, f));

export const NewOrg = () => {
  const navigate = useNavigate();
  const [name, setName] = createSignal("");
  const [slug, setSlug] = createSignal("");
  const [slugTouched, setSlugTouched] = createSignal(false);
  const [bio, setBio] = createSignal("");
  const [avatarUrl, setAvatarUrl] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  onMount(() => {
    void appRuntime.runPromise(Effect.flatMap(AuthManager, (a) => a.get())).then((jwt) => {
      if (jwt === null) navigate("/", { replace: true });
    });
  });

  const effectiveSlug = () => (slugTouched() ? slug() : slugifyName(name()));

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    const s = effectiveSlug().trim();
    if (name().trim() === "") return;
    if (!ORG_SLUG_RE.test(s)) {
      setError("Handle must be lowercase letters, digits, and dashes.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api((c) =>
        c.post("/api/v0/orgs", {
          kind: "team",
          slug: s,
          display_name: name().trim(),
          ...(bio().trim() === "" ? {} : { bio: bio().trim() }),
          ...(avatarUrl().trim() === "" ? {} : { avatar_url: avatarUrl().trim() }),
        }),
      );
      await bootstrap({ force: true }); // refresh the org switcher
      setLastActiveOrg(s);
      navigate(`/@${s}`);
    } catch (err) {
      const status = unwrapApiError(err)?.status;
      setError(
        status === 409
          ? "That handle is taken (or reserved). Try another."
          : "The current pushed back. Nothing was created — try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ "max-width": "30rem", margin: "0 auto", padding: "4rem 1.5rem" }}>
      <header style={{ "margin-bottom": "2rem" }}>
        <h1 style={{ "font-size": "2.2rem" }}>New org</h1>
        <p class="muted" style={{ "margin-top": "0.4rem" }}>
          A shared home for boards — teammates join by invite.
        </p>
      </header>

      <form class="profile-form" onSubmit={submit}>
        <label for="org-name">Name</label>
        <input
          id="org-name"
          type="text"
          maxlength="128"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
        />

        <label for="org-slug">Handle</label>
        <input
          id="org-slug"
          type="text"
          maxlength="64"
          placeholder="lowercase-and-dashes"
          value={effectiveSlug()}
          onInput={(e) => {
            setSlugTouched(true);
            setSlug(e.currentTarget.value.toLowerCase());
          }}
        />
        <span class="muted" style={{ "font-size": "0.8rem" }}>
          evenflow.work/@{effectiveSlug() || "…"}
        </span>

        <label for="org-bio">Bio</label>
        <textarea
          id="org-bio"
          rows={3}
          maxlength="4000"
          value={bio()}
          onInput={(e) => setBio(e.currentTarget.value)}
        />

        <label for="org-avatar">Avatar URL</label>
        <input
          id="org-avatar"
          type="text"
          maxlength="512"
          placeholder="https://…"
          value={avatarUrl()}
          onInput={(e) => setAvatarUrl(e.currentTarget.value)}
        />

        <Show when={error()}>
          <p class="muted" role="alert">
            {error()}
          </p>
        </Show>

        <div class="actions" style={{ display: "flex", gap: "0.6rem", "margin-top": "1.4rem" }}>
          <button class="btn btn-solid" type="submit" disabled={busy()}>
            {busy() ? "Creating…" : "Create org"}
          </button>
          <button class="btn" type="button" onClick={() => history.back()}>
            Cancel
          </button>
        </div>
      </form>
    </main>
  );
};
