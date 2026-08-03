// /@handle/board/xxx/sprints — every sprint on the board, grouped by
// status. Planning + Active are working state; Completed is history. Rows
// carry name, dates, points, and link to the sprint archive page.

import { useParams } from "@solidjs/router";
import { url } from "@routes-manifest";
import { For, Show, createResource } from "solid-js";
import { Effect } from "effect";
import { ApiClient, appRuntime, type ApiClientService, type ApiError } from "../effects";
import { TopBar } from "../components/TopBar";
import type { Sprint } from "../lib/types";
import "../lib/board.css";

const api = <T,>(f: (c: ApiClientService) => Effect.Effect<T, ApiError>): Promise<T> =>
  appRuntime.runPromise(Effect.flatMap(ApiClient, f));

const handleWithoutAt = (h: string): string => (h.startsWith("@") ? h.slice(1) : h);

const dateLabel = (ms: number | null | undefined): string => {
  if (ms == null) return "—";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

const SprintRow = (props: { sprint: Sprint; basePath: string }) => {
  const points = () => {
    const s = props.sprint;
    if (s.status === "completed") {
      return `${s.points_completed ?? 0}pts done · ${s.points_carried ?? 0}pts carried`;
    }
    if (s.status === "active") {
      return `${s.points_committed_start ?? 0}pts committed`;
    }
    return null;
  };
  const dates = () => {
    const s = props.sprint;
    if (s.status === "completed") return `${dateLabel(s.started_at_ms)} → ${dateLabel(s.completed_at_ms)}`;
    if (s.status === "active") return `Started ${dateLabel(s.started_at_ms)}`;
    return `Created ${dateLabel(s.created_at_ms)}`;
  };
  return (
    <a
      class="sprint-list-row"
      href={`${props.basePath}/sprints/${props.sprint.id}`}
      style={{
        display: "grid",
        "grid-template-columns": "minmax(0, 1fr) auto",
        gap: "0.4rem 1.2rem",
        padding: "0.9rem 1.1rem",
        border: "1px solid var(--color-ink-faint)",
        "border-radius": "0.7rem",
        "text-decoration": "none",
        color: "inherit",
        "margin-bottom": "0.5rem",
      }}
    >
      <div>
        <div class="serif" style={{ "font-size": "1.15rem" }}>{props.sprint.name}</div>
        <Show when={props.sprint.goal}>
          <div class="muted" style={{ "font-size": "0.85rem", "margin-top": "0.2rem" }}>
            {props.sprint.goal}
          </div>
        </Show>
      </div>
      <div style={{ "text-align": "right" }}>
        <div class="muted" style={{ "font-size": "0.85rem" }}>{dates()}</div>
        <Show when={points()}>
          <div class="figure" style={{ "font-size": "0.85rem", "margin-top": "0.2rem" }}>{points()}</div>
        </Show>
      </div>
    </a>
  );
};

const Group = (props: { title: string; sprints: Sprint[]; basePath: string; empty: string }) => (
  <section style={{ "margin-bottom": "2rem" }}>
    <h2 class="serif" style={{ "font-size": "1.4rem", "margin-bottom": "0.8rem" }}>
      {props.title} <span class="muted figure" style={{ "font-size": "0.9rem" }}>{props.sprints.length}</span>
    </h2>
    <Show when={props.sprints.length > 0} fallback={<p class="muted">{props.empty}</p>}>
      <For each={props.sprints}>
        {(sprint) => <SprintRow sprint={sprint} basePath={props.basePath} />}
      </For>
    </Show>
  </section>
);

export const SprintsList = () => {
  const params = useParams();
  const handle = () => handleWithoutAt(params["handle"] ?? "");
  const boardSlug = () => params["board_slug"] ?? "";
  const basePath = () => `/@${handle()}/${boardSlug()}`;
  const apiBase = () => url("board.get", { slug: boardSlug() }, handle());

  const [sprints] = createResource(
    () => `${apiBase()}/sprints`,
    async () => {
      const res = await api((c) => c.get<{ sprints: Sprint[] }>(`${apiBase()}/sprints`));
      return res.sprints;
    },
  );
  const [velocity] = createResource(
    () => `${apiBase()}/velocity`,
    async () =>
      api((c) =>
        c.get<{
          window_days: number;
          points_completed: number;
          issues_completed: number;
          per_day_average: number;
        }>(`${apiBase()}/velocity`),
      ),
  );

  const planning = () => (sprints() ?? []).filter((s) => s.status === "planning");
  const active = () => (sprints() ?? []).filter((s) => s.status === "active");
  // Completed: newest first, so the most recent retro is at the top.
  const completed = () =>
    (sprints() ?? [])
      .filter((s) => s.status === "completed")
      .sort((a, b) => (b.completed_at_ms ?? 0) - (a.completed_at_ms ?? 0));

  return (
    <main class="board-page">
      <TopBar
        crumbs={[
          { label: "Boards", href: "/boards" },
          { label: `@${handle()}`, href: `/@${handle()}` },
          { label: boardSlug(), href: basePath() },
          { label: "Sprints" },
        ]}
      />
      <header style={{ "margin-bottom": "2rem" }}>
        <h1 style={{ "font-size": "2.6rem", margin: 0 }}>Sprints</h1>
        <Show when={velocity()}>
          {(v) => (
            <p
              class="muted figure"
              style={{ "margin-top": "0.6rem", "font-size": "0.95rem" }}
              title={`${v().issues_completed} issues shipped in the last ${v().window_days} days`}
            >
              velocity · {v().points_completed}pt / {v().window_days}d ·{" "}
              {v().per_day_average} pt/day
            </p>
          )}
        </Show>
      </header>
      <Show when={!sprints.loading} fallback={<p class="muted">Finding the rhythm…</p>}>
        <Group title="Active" sprints={active()} basePath={basePath()} empty="No sprint in flight." />
        <Group
          title="Planning"
          sprints={planning()}
          basePath={basePath()}
          empty="Nothing planned. Open the Backlog to shape the next one."
        />
        <Group
          title="Completed"
          sprints={completed()}
          basePath={basePath()}
          empty="No history yet."
        />
      </Show>
    </main>
  );
};
