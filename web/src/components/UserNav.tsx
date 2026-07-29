// User nav pill — the caller's avatar (or initials fallback) as a small
// circle. Click reveals a dropdown with Profile + Sign out. Closes on
// outside click.

import { useNavigate } from "@solidjs/router";
import { Show, createSignal, createEffect, onCleanup, onMount } from "solid-js";
import { Effect } from "effect";
import { AuthManager, appRuntime } from "../effects";
import { pubkeyOfJwt } from "../lib/jwt";
import { profileFor, requestProfile, authorLabel } from "../lib/profileStore";

const AVATAR_PX = 34;

export const UserNav = () => {
  const navigate = useNavigate();
  const [open, setOpen] = createSignal(false);
  const [pubkey, setPubkey] = createSignal<string | null>(null);
  let root: HTMLDivElement | undefined;

  onMount(() => {
    void appRuntime.runPromise(Effect.flatMap(AuthManager, (a) => a.get())).then((jwt) => {
      if (jwt !== null) setPubkey(pubkeyOfJwt(jwt));
    });
  });

  // Trigger a store fetch so the caller's own profile lands.
  createEffect(() => {
    const p = pubkey();
    if (p !== null) requestProfile(p);
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

  const picture = () => {
    const p = pubkey();
    return p === null ? null : profileFor(p)?.picture ?? null;
  };

  const initials = () => {
    const p = pubkey();
    if (p === null) return "";
    const label = authorLabel(p, profileFor(p) ?? null);
    return label
      .split(/[\s@:_-]+/)
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
