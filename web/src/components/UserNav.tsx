// User nav pill — the caller's avatar (or initials fallback) as a small
// circle. Click reveals a dropdown with Profile + Sign out. Closes on
// outside click.
//
// The profile fetch is local (own signal) rather than routed through the
// shared profileStore, because /profile/me includes an OAuth-seed picture
// that isn't in the store until the user Saves — the store only knows
// about published kind-0 events. Priming the store is done as a courtesy
// so other <Author> chips also see it.

import { useNavigate } from "@solidjs/router";
import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { Effect } from "effect";
import { ApiClient, AuthManager, appRuntime } from "../effects";
import { pubkeyOfJwt } from "../lib/jwt";
import { primeProfile, type ProfileData } from "../lib/profileStore";

const AVATAR_PX = 40;

interface MeResponse {
  profile: ProfileData;
  seeded_from?: "oauth" | null;
}

export const UserNav = () => {
  const navigate = useNavigate();
  const [open, setOpen] = createSignal(false);
  const [profile, setProfile] = createSignal<ProfileData | null>(null);
  const [login, setLogin] = createSignal<string>("");
  let root: HTMLDivElement | undefined;

  onMount(() => {
    void appRuntime.runPromise(Effect.flatMap(AuthManager, (a) => a.get())).then((jwt) => {
      if (jwt === null) return;
      // Read the login from the JWT — used for the initials fallback.
      try {
        const claims = JSON.parse(atob(jwt.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/"))) as {
          login?: string;
        };
        if (typeof claims.login === "string") setLogin(claims.login);
      } catch {}
      const p = pubkeyOfJwt(jwt);
      if (p === null) return;
      void appRuntime
        .runPromise(
          Effect.gen(function* () {
            const client = yield* ApiClient;
            return yield* client.get<MeResponse>("/api/v0/profile/me");
          }),
        )
        .then((r) => {
          setProfile(r.profile);
          // Courtesy prime so <Author pubkey={me}> chips elsewhere also
          // render the pfp without a second fetch.
          primeProfile(r.profile);
        })
        .catch(() => {});
    });
  });

  // Outside-click close.
  const onDocClick = (e: MouseEvent) => {
    if (open() && root && !root.contains(e.target as Node)) setOpen(false);
  };
  onMount(() => document.addEventListener("mousedown", onDocClick));
  onCleanup(() => document.removeEventListener("mousedown", onDocClick));

  const signOut = () => {
    void appRuntime
      .runPromise(Effect.flatMap(AuthManager, (a) => a.clear()))
      .then(() => navigate("/", { replace: true }));
  };

  const picture = () => profile()?.picture ?? null;

  const initials = () => {
    const p = profile();
    const raw =
      p?.display_name?.trim() ||
      p?.name?.trim() ||
      login().split("@")[0] ||
      "";
    if (raw === "") return "";
    return raw
      .split(/[\s_@.:-]+/)
      .filter((s) => s.length > 0)
      .slice(0, 2)
      .map((s) => s[0]!.toUpperCase())
      .join("");
  };

  return (
    <div class="user-nav" ref={root}>
      <button
        type="button"
        class="user-nav-btn"
        onClick={() => setOpen(!open())}
        aria-haspopup="menu"
        aria-expanded={open()}
        title="Account"
      >
        <Show
          when={picture() !== null && picture() !== ""}
          fallback={<span class="user-nav-initials">{initials() || "•"}</span>}
        >
          <img
            src={picture()!}
            alt=""
            width={AVATAR_PX}
            height={AVATAR_PX}
            onError={(e) => (e.currentTarget.style.display = "none")}
          />
        </Show>
      </button>
      <Show when={open()}>
        <div class="user-nav-menu" role="menu">
          <a class="user-nav-item" href="/profile" onClick={() => setOpen(false)}>
            Profile
          </a>
          <button
            type="button"
            class="user-nav-item"
            onClick={() => {
              setOpen(false);
              signOut();
            }}
          >
            Sign out
          </button>
        </div>
      </Show>
    </div>
  );
};
