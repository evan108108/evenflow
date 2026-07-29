// User + org menu. Avatar pill collapses TWO controls that used to be
// separate (OrgSwitcher on the left, avatar on the right) into one
// top-right dropdown. Slack/Notion pattern: the same menu shows the org
// list (with a chip for role) and the account actions (Profile, Sign out).
// On a personal org the two collapsed into a "who am I twice?" duplication
// on screen; folding here removes it.

import { useNavigate } from "@solidjs/router";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Effect } from "effect";
import { ApiClient, AuthManager, appRuntime } from "../effects";
import { pubkeyOfJwt } from "../lib/jwt";
import { primeProfile, type ProfileData } from "../lib/profileStore";
import {
  bootstrap,
  currentMe,
  lastActiveOrg,
  setLastActiveOrg,
  type OrgSummary,
} from "../lib/orgStore";

const AVATAR_PX = 48;

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
    // Kick off /session/bootstrap so the orgs list is in the menu on first click.
    void bootstrap();
    void appRuntime.runPromise(Effect.flatMap(AuthManager, (a) => a.get())).then((jwt) => {
      if (jwt === null) return;
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
          primeProfile(r.profile);
        })
        .catch(() => {});
    });
  });

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
    const raw = p?.display_name?.trim() || p?.name?.trim() || login().split("@")[0] || "";
    if (raw === "") return "";
    return raw
      .split(/[\s_@.:-]+/)
      .filter((s) => s.length > 0)
      .slice(0, 2)
      .map((s) => s[0]!.toUpperCase())
      .join("");
  };

  const orgs = (): ReadonlyArray<OrgSummary> => currentMe()?.orgs ?? [];
  const activeSlug = (): string | null =>
    lastActiveOrg() ?? currentMe()?.handle ?? null;

  const pickOrg = (org: OrgSummary) => {
    setOpen(false);
    setLastActiveOrg(org.slug);
    navigate(`/@${org.slug}`);
  };

  return (
    <div class="user-nav" ref={root}>
      <button
        type="button"
        class="user-nav-btn"
        onClick={() => setOpen(!open())}
        aria-haspopup="menu"
        aria-expanded={open()}
        title="Account & orgs"
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
          <Show when={orgs().length > 0}>
            <div class="user-nav-section-label">Orgs</div>
            <For each={orgs()}>
              {(org) => (
                <button
                  type="button"
                  class="user-nav-item user-nav-org"
                  onClick={() => pickOrg(org)}
                  aria-current={org.slug === activeSlug() ? "true" : undefined}
                >
                  <span class="user-nav-org-name">@{org.slug}</span>
                  <span class="chip user-nav-role">{org.role}</span>
                </button>
              )}
            </For>
            <a
              class="user-nav-item user-nav-org-create"
              href="/o/new"
              onClick={() => setOpen(false)}
            >
              + Create org
            </a>
            <div class="user-nav-divider" />
          </Show>
          <a
            class="user-nav-item"
            href="/profile"
            onClick={() => setOpen(false)}
          >
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
