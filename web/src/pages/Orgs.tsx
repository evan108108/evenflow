// /orgs — every org the caller is part of, with role and quick links.
// The list already lives on the bootstrap response the UserNav dropdown
// reads; this page just gives it a full page treatment for cases where
// the dropdown row is too small (many orgs, want to skim roles, etc).

import { For, Show, createResource } from "solid-js";
import { bootstrap, type OrgSummary } from "../lib/orgStore";
import { TopBar } from "../components/TopBar";
import "../lib/board.css";

const roleChip = (role: string): string => {
  switch (role) {
    case "owner":
      return "OWNER";
    case "admin":
      return "ADMIN";
    default:
      return role.toUpperCase();
  }
};

const canAdmin = (role: string): boolean => role === "owner" || role === "admin";

export const Orgs = () => {
  const [me] = createResource(() => bootstrap());

  return (
    <main class="board-page">
      <TopBar crumbs={[{ label: "Orgs" }]} />
      <header
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          "margin-bottom": "2rem",
        }}
      >
        <h1 style={{ "font-size": "2.6rem" }}>Orgs</h1>
        <a class="btn btn-solid" href="/o/new">
          + New org
        </a>
      </header>

      <Show
        when={!me.loading}
        fallback={<p class="muted">Finding the rhythm…</p>}
      >
        <Show
          when={(me()?.orgs.length ?? 0) > 0}
          fallback={
            <p class="empty-state">
              You're not part of any orgs yet. Create one to organize boards under a shared handle.
            </p>
          }
        >
          <ul
            style={{
              "list-style": "none",
              padding: 0,
              margin: 0,
              display: "flex",
              "flex-direction": "column",
              gap: "0.5rem",
            }}
          >
            <For each={me()?.orgs}>
              {(org: OrgSummary) => (
                <li
                  style={{
                    display: "flex",
                    "align-items": "center",
                    gap: "1rem",
                    padding: "0.9rem 1rem",
                    background: "var(--color-paper-raised)",
                    border: "1px solid var(--color-ink-faint)",
                    "border-radius": "8px",
                  }}
                >
                  <div style={{ flex: "1", "min-width": "0" }}>
                    <div style={{ display: "flex", "align-items": "baseline", gap: "0.6rem", "flex-wrap": "wrap" }}>
                      <a
                        href={`/@${org.slug}`}
                        style={{
                          "font-family": "var(--font-serif)",
                          "font-size": "1.25rem",
                          color: "var(--color-ink)",
                          "text-decoration": "none",
                        }}
                      >
                        {org.display_name}
                      </a>
                      <span class="muted" style={{ "font-size": "0.9rem" }}>
                        @{org.slug}
                      </span>
                      <span
                        class="chip"
                        style={{ "font-size": "0.7rem", "letter-spacing": "0.08em" }}
                      >
                        {roleChip(org.role)}
                      </span>
                      <Show when={org.kind === "personal"}>
                        <span class="muted" style={{ "font-size": "0.75rem" }}>
                          (your personal org)
                        </span>
                      </Show>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "0.4rem", "flex-shrink": "0" }}>
                    <a class="btn" href={`/@${org.slug}`}>
                      Open
                    </a>
                    <Show when={canAdmin(org.role)}>
                      <a class="btn" href={`/@${org.slug}/settings`}>
                        Settings
                      </a>
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </main>
  );
};
