// BacklogView — Active section on top (grouped by status column), Sprints
// between (phase 20: planning sprints are drop zones you drag backlog
// issues onto; started sprints collapse to a summary row), Backlog below
// (flat, newest-updated first), plus an icebox drop strip. Dragging
// between sections fires the container-move / sprint-membership endpoints.

import { For, Show, createSignal } from "solid-js";
import { IssueCard } from "../../components/IssueCard";
import { StreamSentinel } from "../../components/StreamSentinel";
import { moveZone, sprintZone, transitionZone, type DndHandle } from "../../lib/dnd";
import { enabledColumns, type Column } from "../../lib/columns";
import { byBoardOrder, issuesInColumn } from "../../lib/order";
import { FALLBACK_SPRINT_DAYS, effectiveSprintDays } from "../../lib/sprints";
import type { Issue, Sprint } from "../../lib/types";
import type { BoardStore } from "./store";

const SprintSection = (props: {
  sprint: Sprint;
  issues: readonly Issue[];
  dnd: DndHandle;
  onOpen: (id: string) => void;
  onRename: (name: string) => void;
  onGoal: (goal: string | null) => void;
  /** Board default sprint length — the fallback when planned_days is null. */
  defaultDays: number;
  /** Planning-only: set/clear the sprint's planned_days override. */
  onDays?: (days: number | null) => void;
  onStart?: () => void;
  onComplete?: () => void;
}) => {
  // Planning sprints sit open (they're the working surface); started ones
  // collapse to a summary row until clicked.
  const [expanded, setExpanded] = createSignal(props.sprint.status === "planning");
  const points = () => props.issues.reduce((sum, i) => sum + (i.estimate ?? 0), 0);
  const zone = sprintZone(props.sprint.id);

  return (
    <section
      class="list-section sprint-section"
      classList={{ "drop-over": props.dnd.overZone() === zone, started: props.sprint.status === "active" }}
      data-dropzone={zone}
    >
      <div class="sprint-header">
        <Show
          when={props.sprint.status === "active"}
          fallback={
            <input
              class="sprint-name serif"
              value={props.sprint.name}
              aria-label="Sprint name"
              onChange={(e) => {
                const name = e.currentTarget.value.trim();
                if (name !== "" && name !== props.sprint.name) props.onRename(name);
                else e.currentTarget.value = props.sprint.name;
              }}
            />
          }
        >
          <button class="sprint-name serif as-button" onClick={() => setExpanded((v) => !v)}>
            {props.sprint.name}
            <span class="sprint-caret" aria-hidden="true">
              {expanded() ? "▾" : "▸"}
            </span>
          </button>
        </Show>
        <span class="count figure muted">
          {props.issues.length}
          <Show when={points() > 0}> · {points()}pts</Show>
        </span>
        <Show when={props.sprint.status === "planning" && props.onDays !== undefined}>
          <label
            class="sprint-days"
            title={`${effectiveSprintDays(props.sprint, props.defaultDays)} days — ${
              props.sprint.planned_days == null ? "from board default" : "custom for this sprint"
            }`}
          >
            <input
              type="number"
              min="1"
              max="90"
              placeholder={String(props.defaultDays)}
              value={props.sprint.planned_days ?? ""}
              aria-label="Sprint length in days"
              onChange={(e) => {
                const raw = e.currentTarget.value.trim();
                if (raw === "") {
                  props.onDays?.(null);
                  return;
                }
                const days = Number(raw);
                if (Number.isInteger(days) && days >= 1 && days <= 90) props.onDays?.(days);
                else e.currentTarget.value = String(props.sprint.planned_days ?? "");
              }}
            />
            d
          </label>
        </Show>
        <div class="spacer" />
        <Show when={props.onStart}>
          <button class="btn btn-small" onClick={() => props.onStart?.()}>
            Start sprint
          </button>
        </Show>
        <Show when={props.onComplete && expanded()}>
          <button class="btn btn-small" onClick={() => props.onComplete?.()}>
            Complete sprint
          </button>
        </Show>
      </div>
      <Show when={props.sprint.status === "planning"}>
        <input
          class="sprint-goal"
          value={props.sprint.goal ?? ""}
          placeholder="What's this sprint for?"
          aria-label="Sprint goal"
          onChange={(e) => {
            const goal = e.currentTarget.value.trim();
            if (goal !== (props.sprint.goal ?? "")) props.onGoal(goal === "" ? null : goal);
          }}
        />
      </Show>
      <Show when={props.sprint.status === "active" && props.sprint.goal !== null && expanded()}>
        <p class="sprint-goal-line muted">{props.sprint.goal}</p>
      </Show>
      <Show when={expanded()}>
        <Show
          when={props.issues.length > 0}
          fallback={<p class="empty-state">Drag issues here to shape the sprint.</p>}
        >
          <For each={props.issues}>
            {(issue) => <IssueCard issue={issue} dnd={props.dnd} onOpen={props.onOpen} compact />}
          </For>
        </Show>
      </Show>
    </section>
  );
};

export const BacklogView = (props: {
  store: BoardStore;
  dnd: DndHandle;
  onOpen: (id: string) => void;
}) => {
  const active = () => props.store.issues().filter((i) => i.container === "active");
  // Issues sitting in a planning/active sprint render inside that sprint's
  // section; a completed sprint releases its issues back to the flat list.
  const liveSprintIds = () =>
    new Set(props.store.sprints().filter((s) => s.status !== "completed").map((s) => s.id));
  const backlog = () =>
    props.store
      .issues()
      .filter((i) => i.container === "backlog" && !liveSprintIds().has(i.sprint_id ?? ""))
      .sort(byBoardOrder);
  const activeInColumn = (column: Column) => issuesInColumn(active(), column);
  const planningSprints = () => props.store.sprints().filter((s) => s.status === "planning");
  const startedSprints = () => props.store.sprints().filter((s) => s.status === "active");
  const inSprint = (sprint: Sprint) =>
    props.store.issues().filter((i) => i.sprint_id === sprint.id);

  const activeZone = moveZone("promote_to_active");
  const backlogZone = moveZone("promote_to_backlog");
  const iceboxZone = moveZone("send_to_icebox");

  const newSprint = () => {
    void props.store.createSprint(`Sprint ${props.store.sprints().length + 1}`);
  };

  const defaultDays = () => props.store.board()?.default_sprint_days ?? FALLBACK_SPRINT_DAYS;

  return (
    <div>
      <section
        class="list-section"
        classList={{ "drop-over": props.dnd.overZone() === activeZone }}
        data-dropzone={activeZone}
      >
        <h2>
          Active <span class="count figure muted">{active().length}</span>
        </h2>
        <Show when={active().length > 0} fallback={<p class="empty-state">Still waters.</p>}>
          <For each={enabledColumns(props.store.board()?.columns ?? [])}>
            {(column) => {
              const zone = transitionZone(column.id);
              // Always render the group — an empty column needs to remain a
              // drop target so you can transition a card into it from another
              // column (otherwise the only way to reach an empty column is
              // via the Kanban tab).
              return (
                <div
                  class="status-group"
                  classList={{ "drop-over": props.dnd.overZone() === zone }}
                  data-dropzone={zone}
                >
                  <h4>{column.name} <span class="count figure muted">{activeInColumn(column).length}</span></h4>
                  <For each={activeInColumn(column)}>
                    {(issue) => <IssueCard issue={issue} dnd={props.dnd} onOpen={props.onOpen} compact />}
                  </For>
                </div>
              );
            }}
          </For>
        </Show>
      </section>

      <Show when={startedSprints().length > 0 || planningSprints().length > 0}>
        <div class="sprints-block">
          <For each={startedSprints()}>
            {(sprint) => (
              <SprintSection
                sprint={sprint}
                issues={inSprint(sprint)}
                dnd={props.dnd}
                onOpen={props.onOpen}
                onRename={(name) => void props.store.patchSprint(sprint.id, { name })}
                onGoal={(goal) => void props.store.patchSprint(sprint.id, { goal })}
                defaultDays={defaultDays()}
                onComplete={() => void props.store.completeSprint(sprint.id)}
              />
            )}
          </For>
          <For each={planningSprints()}>
            {(sprint) => (
              <SprintSection
                sprint={sprint}
                issues={inSprint(sprint)}
                dnd={props.dnd}
                onOpen={props.onOpen}
                onRename={(name) => void props.store.patchSprint(sprint.id, { name })}
                onGoal={(goal) => void props.store.patchSprint(sprint.id, { goal })}
                defaultDays={defaultDays()}
                onDays={(days) => void props.store.patchSprint(sprint.id, { planned_days: days })}
                onStart={() => void props.store.startSprint(sprint.id)}
              />
            )}
          </For>
        </div>
      </Show>

      <section
        class="list-section"
        classList={{ "drop-over": props.dnd.overZone() === backlogZone }}
        data-dropzone={backlogZone}
      >
        <h2>
          Backlog <span class="count figure muted">{backlog().length}</span>
          <button class="btn btn-small sprint-new" onClick={newSprint}>
            + New sprint
          </button>
        </h2>
        <Show
          when={backlog().length > 0}
          fallback={<p class="empty-state">Nothing on your mind. What are you thinking about?</p>}
        >
          <For each={backlog()}>
            {(issue) => <IssueCard issue={issue} dnd={props.dnd} onOpen={props.onOpen} compact />}
          </For>
        </Show>
        {/* Phase 22: the backlog is its own recency-paged stream. */}
        <StreamSentinel stream={props.store.streamFor("backlog")} />
      </section>

      <div
        class="drop-strip"
        classList={{ "drop-over": props.dnd.overZone() === iceboxZone }}
        data-dropzone={iceboxZone}
      >
        Drag here to put a thought on ice ❄
      </div>
    </div>
  );
};
