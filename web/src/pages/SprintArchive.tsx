// /@handle/board/xxx/sprints/:sprintId — read-only history of one sprint.
// Groups every membership row into Completed-in-sprint / Carried-over /
// Dropped / Open, with the sprint's headline metrics up top.

import { useParams } from "@solidjs/router";
import { For, Show, createResource } from "solid-js";
import { Effect } from "effect";
import { ApiClient, appRuntime, type ApiClientService, type ApiError } from "../effects";
import { TopBar } from "../components/TopBar";
import { AssigneeAvatar } from "../components/AssigneeAvatar";
import { IssueRef } from "../components/IssueRef";
import type { Sprint, SprintArchivePayload, SprintMembership } from "../lib/types";
import "../lib/board.css";

const api = <T,>(f: (c: ApiClientService) => Effect.Effect<T, ApiError>): Promise<T> =>
  appRuntime.runPromise(Effect.flatMap(ApiClient, f));

const handleWithoutAt = (h: string): string => (h.startsWith("@") ? h.slice(1) : h);

const dateLabel = (ms: number | null | undefined): string => {
  if (ms == null) return "—";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

const durationDays = (from: number | null, to: number | null): string => {
  if (from == null || to == null) return "—";
  return `${Math.max(1, Math.round((to - from) / 86_400_000))}d`;
};

const MembershipRow = (props: {
  m: SprintMembership;
  basePath: string;
  // `| undefined` explicitly, not just `?`. Under `exactOptionalPropertyTypes`
  // those are different types: `?` alone means "may be absent", while the sole
  // caller passes `props.extraFor?.(m)` — a value that is PRESENT and
  // `undefined`. Widening to match is the honest shape, because `extraFor` is
  // itself declared to return `string | undefined`; the alternative (spreading
  // the prop conditionally at the callsite) would preserve a stricter contract
  // that nothing upstream can actually satisfy.
  extra?: string | undefined;
}) => (
  <li
    style={{
      display: "grid",
      "grid-template-columns": "auto auto minmax(0, 1fr) auto auto",
      "align-items": "center",
      gap: "0.7rem",
      padding: "0.6rem 0.9rem",
      "border-bottom": "1px solid var(--color-ink-faint)",
    }}
  >
    <Show when={props.m.short_id}>
      {(sid) => <IssueRef shortId={sid()} class="card-ref" />}
    </Show>
    <Show
      when={props.m.assignee_pubkey}
      fallback={<span style={{ width: "20px", height: "20px" }} />}
    >
      {(pk) => <AssigneeAvatar pubkey={pk()} />}
    </Show>
    <div>
      <div>{props.m.title ?? <span class="muted">(untitled)</span>}</div>
      <Show when={props.extra}>
        <div class="muted" style={{ "font-size": "0.8rem", "margin-top": "0.15rem" }}>
          {props.extra}
        </div>
      </Show>
    </div>
    <div class="muted figure" style={{ "text-align": "right", "min-width": "3rem" }}>
      <Show when={props.m.estimate !== null}>{props.m.estimate}pt</Show>
    </div>
    <div class="muted" style={{ "font-size": "0.8rem", "text-align": "right" }}>
      {props.m.status ?? ""}
    </div>
  </li>
);

const Section = (props: {
  title: string;
  rows: readonly SprintMembership[];
  basePath: string;
  emptyLine: string;
  extraFor?: (m: SprintMembership) => string | undefined;
}) => (
  <section style={{ "margin-bottom": "2rem" }}>
    <h2 class="serif" style={{ "font-size": "1.3rem", "margin-bottom": "0.6rem" }}>
      {props.title} <span class="muted figure" style={{ "font-size": "0.9rem" }}>{props.rows.length}</span>
    </h2>
    <Show when={props.rows.length > 0} fallback={<p class="muted">{props.emptyLine}</p>}>
      <ul
        style={{
          "list-style": "none",
          padding: 0,
          margin: 0,
          border: "1px solid var(--color-ink-faint)",
          "border-radius": "0.7rem",
          overflow: "hidden",
        }}
      >
        <For each={props.rows}>
          {(m) => <MembershipRow m={m} basePath={props.basePath} extra={props.extraFor?.(m)} />}
        </For>
      </ul>
    </Show>
  </section>
);

const Metric = (props: { label: string; value: string }) => (
  <div>
    <div class="muted" style={{ "font-size": "0.75rem", "letter-spacing": "0.05em", "text-transform": "uppercase" }}>
      {props.label}
    </div>
    <div class="figure" style={{ "font-size": "1.4rem", "margin-top": "0.2rem" }}>{props.value}</div>
  </div>
);

export const SprintArchive = () => {
  const params = useParams();
  const handle = () => handleWithoutAt(params["handle"] ?? "");
  const boardSlug = () => params["board_slug"] ?? "";
  const sprintId = () => params["sprintId"] ?? "";
  const basePath = () => `/@${handle()}/${boardSlug()}`;
  const apiBase = () => `/api/v0/orgs/${handle()}/boards/${boardSlug()}`;

  const [archive] = createResource(
    () => sprintId(),
    async () => {
      return api((c) => c.get<SprintArchivePayload>(`${apiBase()}/sprints/${sprintId()}/archive`));
    },
  );

  // Sprint from the archive payload — the same object the /sprints listing
  // ships, so we can render metrics without a second call.
  const sprint = (): Sprint | null => archive()?.sprint ?? null;

  return (
    <main class="board-page">
      <TopBar
        crumbs={[
          { label: "Boards", href: "/boards" },
          { label: `@${handle()}`, href: `/@${handle()}` },
          { label: boardSlug(), href: basePath() },
          { label: "Sprints", href: `${basePath()}/sprints` },
          { label: sprint()?.name ?? "…" },
        ]}
      />
      <Show when={!archive.loading && sprint()} fallback={<p class="muted">Finding the rhythm…</p>}>
        {(s) => (
          <>
            <header style={{ "margin-bottom": "2rem" }}>
              <h1 style={{ "font-size": "2.6rem", margin: 0 }}>{s().name}</h1>
              <Show when={s().goal}>
                <p class="muted" style={{ "font-size": "1.1rem", "margin-top": "0.4rem" }}>
                  {s().goal}
                </p>
              </Show>
              <div
                style={{
                  display: "grid",
                  "grid-template-columns": "repeat(auto-fit, minmax(120px, 1fr))",
                  gap: "1.2rem",
                  "margin-top": "1.5rem",
                  padding: "1.1rem",
                  border: "1px solid var(--color-ink-faint)",
                  "border-radius": "0.7rem",
                }}
              >
                <Metric label="Status" value={s().status} />
                <Metric label="Started" value={dateLabel(s().started_at_ms)} />
                <Metric
                  label={s().status === "completed" ? "Completed" : "Ends"}
                  value={dateLabel(s().completed_at_ms)}
                />
                <Metric label="Duration" value={durationDays(s().started_at_ms, s().completed_at_ms)} />
                <Metric label="Committed" value={`${s().points_committed_start ?? 0}pt`} />
                <Metric label="Completed" value={`${s().points_completed ?? 0}pt`} />
                <Metric label="Carried" value={`${s().points_carried ?? 0}pt`} />
                <Metric label="Mid-sprint adds" value={String(s().adds_mid_sprint ?? 0)} />
              </div>
            </header>

            <Section
              title="Completed in sprint"
              rows={archive()!.completed_in_sprint}
              basePath={basePath()}
              emptyLine="Nothing shipped in this sprint."
            />
            <Section
              title="Carried over"
              rows={archive()!.carried_over}
              basePath={basePath()}
              emptyLine="Nothing carried."
            />
            <Section
              title="Dropped"
              rows={archive()!.dropped}
              basePath={basePath()}
              emptyLine="Nothing dropped."
            />
            <Show when={archive()!.open.length > 0}>
              <Section
                title="Still open"
                rows={archive()!.open}
                basePath={basePath()}
                emptyLine=""
              />
            </Show>
          </>
        )}
      </Show>
    </main>
  );
};
