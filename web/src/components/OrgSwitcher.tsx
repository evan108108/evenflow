// OrgSwitcher — the top-left org pill. Shows the current org's avatar +
// name; click reveals every org the caller belongs to (role chip each) and
// a "Create org" hand-off to /o/new. Selecting an org navigates to its
// /@handle page and persists it as last-active.

import { useNavigate } from "@solidjs/router";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import {
  bootstrap,
  currentMe,
  lastActiveOrg,
  setLastActiveOrg,
  type OrgSummary,
} from "../lib/orgStore";

const AVATAR_PX = 22;

const OrgAvatar = (props: { org: OrgSummary | null }) => (
  <Show
    when={props.org?.avatar_url}
    fallback={
      <span class="org-switcher-initial" aria-hidden="true">
        {(props.org?.display_name ?? "?")[0]?.toUpperCase() ?? "?"}
      </span>
    }
  >
    {(url) => (
      <img
        src={url()}
        alt=""
        width={AVATAR_PX}
        height={AVATAR_PX}
        style={{ "border-radius": "50%", "object-fit": "cover" }}
        onError={(e) => (e.currentTarget.style.display = "none")}
      />
    )}
  </Show>
);

export const OrgSwitcher = (props: {
  /** Slug of the org this page is scoped to; falls back to last-active/personal. */
  current?: string | undefined;
}) => {
  const navigate = useNavigate();
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;

  onMount(() => {
    void bootstrap();
  });

  const orgs = () => currentMe()?.orgs ?? [];
  const current = (): OrgSummary | null => {
    const list = orgs();
    if (list.length === 0) return null;
    const wanted = props.current ?? lastActiveOrg() ?? currentMe()?.handle ?? null;
    return list.find((o) => o.slug === wanted) ?? list[0] ?? null;
  };

  const onDocClick = (e: MouseEvent) => {
    if (open() && root && !root.contains(e.target as Node)) setOpen(false);
  };
  onMount(() => document.addEventListener("mousedown", onDocClick));
  onCleanup(() => document.removeEventListener("mousedown", onDocClick));

  const pick = (org: OrgSummary) => {
    setOpen(false);
    setLastActiveOrg(org.slug);
    navigate(`/@${org.slug}`);
  };

  return (
    <Show when={currentMe() !== null}>
      <div class="org-switcher" ref={root}>
        <button
          type="button"
          class="org-switcher-btn"
          onClick={() => setOpen(!open())}
          aria-haspopup="menu"
          aria-expanded={open()}
          title="Switch org"
        >
          <OrgAvatar org={current()} />
          <span class="org-switcher-name">{current()?.display_name ?? "…"}</span>
          <span class="org-switcher-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        <Show when={open()}>
          <div class="org-switcher-menu" role="menu">
            <For each={orgs()}>
              {(org) => (
                <button type="button" class="org-switcher-item" onClick={() => pick(org)}>
                  <OrgAvatar org={org} />
                  <span class="org-switcher-item-name">{org.display_name}</span>
                  <span class="chip role-chip">{org.role}</span>
                </button>
              )}
            </For>
            <a
              class="org-switcher-item org-switcher-create"
              href="/o/new"
              onClick={() => setOpen(false)}
            >
              + Create org
            </a>
          </div>
        </Show>
      </div>
    </Show>
  );
};
