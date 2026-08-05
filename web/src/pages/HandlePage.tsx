// /@{handle} — the public identity page. Org header (avatar, display name,
// bio) + the boards the caller can see in that org. Works signed out: the
// API returns public info and public boards anonymously. An unknown handle
// renders the claim CTA — sign-up carries the handle as a ?claim hint via
// localStorage so bootstrap can auto-slug the personal org.

import { useNavigate, useParams } from "@solidjs/router";
import { url } from "@routes-manifest";
import { For, Show, createResource, createSignal } from "solid-js";
import { Effect } from "effect";
import { ApiClient, appRuntime } from "../effects";
import { unwrapApiError } from "./board/store";
import { TopBar } from "../components/TopBar";
import { NewBoardModal, type CreatedBoard, type NewBoardInput } from "../components/NewBoardModal";
import { currentMe, bootstrap, setLastActiveOrg, stashClaimedHandle } from "../lib/orgStore";
import "../lib/board.css";

export interface OrgPublic {
  slug: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  kind: "personal" | "team";
}

interface OrgDetailResponse {
  org: OrgPublic;
  role: string | null;
}

export interface OrgBoardRow {
  id: string;
  slug: string;
  title: string;
  visibility: "private" | "public";
  updated_at_ms: number;
  role?: string;
}

interface OrgBoardsResponse {
  boards: OrgBoardRow[];
  total: number;
}

const NOT_FOUND = Symbol("org-not-found");

const fetchHandle = async (
  handle: string,
): Promise<{ detail: OrgDetailResponse; boards: OrgBoardRow[] } | typeof NOT_FOUND> => {
  try {
    const [detail, boards] = await Promise.all([
      appRuntime.runPromise(
        Effect.flatMap(ApiClient, (c) =>
          c.get<OrgDetailResponse>(url("org.get", { org_slug: handle })),
        ),
      ),
      appRuntime.runPromise(
        Effect.flatMap(ApiClient, (c) =>
          c.get<OrgBoardsResponse>(url("org.boards.list", { org_slug: handle })),
        ),
      ),
    ]);
    return { detail, boards: boards.boards };
  } catch (e) {
    if (unwrapApiError(e)?.status === 404) return NOT_FOUND;
    throw e;
  }
};

const ClaimCta = (props: { handle: string }) => {
  const signUp = (provider: "google" | "github") => {
    stashClaimedHandle(props.handle);
    window.location.assign(`${url("auth.oauth.start")}?provider=${provider}`);
  };
  return (
    <main style={{ display: "grid", "place-items": "center", "min-height": "100vh" }}>
      <div style={{ "text-align": "center", "max-width": "26rem", padding: "1.5rem" }}>
        <h1 class="serif" style={{ "font-size": "2.6rem", "margin-bottom": "0.8rem" }}>
          @{props.handle}
        </h1>
        <p style={{ "margin-bottom": "1.6rem" }}>
          This handle is available — claim it and make it yours.
        </p>
        <div style={{ display: "flex", gap: "0.6rem", "justify-content": "center" }}>
          <button class="btn btn-solid" onClick={() => signUp("google")}>
            Sign up with Google
          </button>
          <button class="btn" onClick={() => signUp("github")}>
            Sign up with GitHub
          </button>
        </div>
        <p class="muted" style={{ "margin-top": "1.4rem", "font-size": "0.85rem" }}>
          Already flowing? <a href="/">Sign in</a>
        </p>
      </div>
    </main>
  );
};

export const HandlePage = () => {
  const params = useParams<{ handle: string }>();
  const navigate = useNavigate();
  const handle = () => params.handle.replace(/^@/, "");

  void bootstrap();
  const [page, { refetch }] = createResource(handle, fetchHandle);
  const [showNewBoard, setShowNewBoard] = createSignal(false);

  const isMember = () => {
    const data = page();
    return data !== undefined && data !== NOT_FOUND && data.detail.role !== null;
  };
  // EFB-12: + New board affordance on the org landing. Only shown when the
  // caller is authenticated + admin/owner on this org (server enforces the
  // same on the create-board endpoint). Posts to the org-scoped endpoint so
  // the board lands here, not in the caller's personal org.
  const canCreateBoard = () => {
    const data = page();
    if (data === undefined || data === NOT_FOUND) return false;
    const role = data.detail.role;
    return role === "owner" || role === "admin";
  };
  const onCreate = async (input: NewBoardInput): Promise<CreatedBoard> => {
    const res = await appRuntime.runPromise(
      Effect.flatMap(ApiClient, (c) =>
        c.post<{ board: CreatedBoard }>(
          // POST creates a board IN the org, so it is board.create under the
          // org prefix — not the org boards listing.
          url("board.create", {}, handle()),
          input,
        ),
      ),
    );
    void refetch();
    return res.board;
  };
  const onDone = (board: CreatedBoard) => {
    setShowNewBoard(false);
    setLastActiveOrg(handle());
    navigate(`/@${handle()}/${board.slug}`);
  };

  return (
    <Show when={page() !== NOT_FOUND} fallback={<ClaimCta handle={handle()} />}>
      <main class="board-page" style={{ padding: "4rem 1.5rem 4rem var(--page-inset-left, 3rem)" }}>
        <TopBar
          crumbs={[
            { label: "Boards", href: "/boards" },
            { label: `@${handle()}` },
          ]}
        />
        <header
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "flex-end",
            "margin": "1.6rem 0 2rem",
          }}
        >
          <div style={{ display: "flex", gap: "0.6rem", "align-items": "center" }}>
            <Show when={isMember()}>
              <a class="btn" href={`/@${handle()}/members`}>
                Members
              </a>
              <a class="btn" href={`/@${handle()}/settings`}>
                Settings
              </a>
            </Show>
            <Show when={canCreateBoard()}>
              <button class="btn btn-solid" onClick={() => setShowNewBoard(true)}>
                + New board
              </button>
            </Show>
          </div>
        </header>

        <Show when={showNewBoard()}>
          <NewBoardModal
            onClose={() => setShowNewBoard(false)}
            onCreate={onCreate}
            onDone={onDone}
          />
        </Show>

        <Show when={!page.loading} fallback={<p class="muted">Finding the rhythm…</p>}>
          <Show when={page() !== undefined && page() !== NOT_FOUND}>
            {(_) => {
              const data = () => page() as { detail: OrgDetailResponse; boards: OrgBoardRow[] };
              const org = () => data().detail.org;
              return (
                <div class="paper-glass">
                  <div class="org-header">
                    <Show
                      when={org().avatar_url}
                      fallback={
                        <div class="org-avatar-fallback">
                          {org().display_name[0]?.toUpperCase() ?? "?"}
                        </div>
                      }
                    >
                      {(url) => <img class="org-avatar" src={url()} alt="" />}
                    </Show>
                    <div>
                      <h1 style={{ "font-size": "2.4rem" }}>{org().display_name}</h1>
                      <p class="muted" style={{ "margin-top": "0.3rem" }}>
                        @{org().slug}
                        <Show when={org().kind === "team"}> · team</Show>
                      </p>
                      <Show when={org().bio}>
                        <p style={{ "margin-top": "0.6rem", "max-width": "32rem" }}>{org().bio}</p>
                      </Show>
                    </div>
                  </div>

                  <Show
                    when={data().boards.length > 0}
                    fallback={<p class="muted">Still waters. What flows next?</p>}
                  >
                    <ul style={{ "list-style": "none", margin: 0, padding: 0 }}>
                      <For each={data().boards}>
                        {(board) => (
                          <li style={{ "margin-bottom": "0.8rem" }}>
                            <a
                              href={`/@${handle()}/${board.slug}`}
                              onClick={() => setLastActiveOrg(handle())}
                              style={{
                                padding: "1.1rem 1.2rem",
                                background: "var(--color-paper-raised)",
                                border: "1px solid var(--color-ink-faint)",
                                "border-radius": "var(--radius-chamfer)",
                                display: "flex",
                                "justify-content": "space-between",
                                "align-items": "baseline",
                                "text-decoration": "none",
                              }}
                            >
                              <span class="serif" style={{ "font-size": "1.25rem" }}>
                                {board.title}
                              </span>
                              <span class="muted" style={{ "font-size": "0.85rem" }}>
                                <Show when={board.visibility === "public"}>
                                  <span class="chip" style={{ "margin-right": "0.6rem" }}>
                                    public
                                  </span>
                                </Show>
                                {new Date(board.updated_at_ms).toLocaleDateString()}
                              </span>
                            </a>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </div>
              );
            }}
          </Show>
        </Show>
      </main>
    </Show>
  );
};
