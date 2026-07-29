// /@{handle}/members — the org's member list. Visible to org members (the
// API 401/404s everyone else); management lives in settings, so this page
// is read-only chips.

import { useParams } from "@solidjs/router";
import { For, Show, createResource } from "solid-js";
import { Effect } from "effect";
import { ApiClient, appRuntime, type ApiClientService, type ApiError } from "../effects";
import { Author } from "../components/Author";
import { UserNav } from "../components/UserNav";
import "../lib/board.css";

interface MemberRow {
  pubkey: string;
  role: string;
  added_at_ms: number;
}

const api = <T,>(f: (c: ApiClientService) => Effect.Effect<T, ApiError>): Promise<T> =>
  appRuntime.runPromise(Effect.flatMap(ApiClient, f));

export const OrgMembers = () => {
  const params = useParams<{ handle: string }>();
  const handle = () => params.handle.replace(/^@/, "");
  const [members] = createResource(handle, (h) =>
    api<{ members: MemberRow[] }>((c) => c.get(`/api/v0/orgs/${encodeURIComponent(h)}/members`)),
  );

  return (
    <main style={{ "max-width": "var(--measure)", margin: "0 auto", padding: "4rem 1.5rem 4rem var(--page-inset-left, 3rem)" }}>
      <nav class="crumb muted" style={{ "margin-bottom": "1rem" }}>
        <a href="/boards">← Boards</a> / <a href={`/@${handle()}`}>@{handle()}</a> / members
      </nav>
      <header
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          "margin-bottom": "2rem",
        }}
      >
        <h1 style={{ "font-size": "2.2rem" }}>Members</h1>
        <UserNav />
      </header>

      <Show when={!members.loading} fallback={<p class="muted">Finding the rhythm…</p>}>
        <Show
          when={members.error === undefined}
          fallback={
            <p class="muted">
              Members are visible to members. <a href={`/@${handle()}`}>Back to @{handle()} →</a>
            </p>
          }
        >
          <ul style={{ "list-style": "none", margin: 0, padding: 0 }}>
            <For each={members()?.members ?? []}>
              {(member) => (
                <li class="member-row">
                  <Author pubkey={member.pubkey} />
                  <span class="grow" />
                  <span class="chip role-chip">{member.role}</span>
                  <span class="muted" style={{ "font-size": "0.8rem" }}>
                    since {new Date(member.added_at_ms).toLocaleDateString()}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </main>
  );
};
