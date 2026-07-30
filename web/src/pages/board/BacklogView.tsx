// BacklogView (phase 21a remodel) — the planning surface.
//
// Shows ONLY container=backlog issues. No Active section — that lives on
// Kanban. This ends the cross-view duplication where a card in a sprint
// with container=active used to appear on both surfaces at once.
//
// Layout, top to bottom:
//   1. Planning sprints (status=planning) — each an editable drop-target
//      sub-bucket of the backlog. Drag issues in/out to shape the sprint.
//   2. Unassigned Backlog — flat list of container=backlog && sprint_id=null.
//   3. Icebox drop strip — drop here to park.
//
// A started sprint (status=active) does NOT render here at all. Once started
// it lives on Kanban under the sprint-filter chip (phase 21c). Completed
// sprints are read-only history and live at /sprints/:id (phase 21b).

import { For, Show, createSignal } from "solid-js";
import { IssueCard } from "../../components/IssueCard";
import { StreamSentinel } from "../../components/StreamSentinel";
import { moveZone, sprintZone, type DndHandle } from "../../lib/dnd";
import { FALLBACK_SPRINT_DAYS, effectiveSprintDays } from "../../lib/sprints";
import { byBoardOrder } from "../../lib/order";
import type { Issue, Sprint } from "../../lib/types";
import type { BoardStore } from "./store";

const SprintSection = (props: {
  sprint: Sprint;
  issues: readonly Issue[];
  dnd: DndHandle;
  onOpen: (id: string) => void;
  onRename: (name: string) => void;
  onGoal: (goal: string | null) => void;
  onDays: (days: number | null) => void;
  onStart: () => void;
  onDelete: () => void;
  defaultDays: number;
}) => {
  const points = () => props.issues.reduce((sum, i) => sum + (i.estimate ?? 0), 0);
  const zone = sprintZone(props.sprint.id);

  return (
    <section
      class="list-section sprint-section"
      classList={{ "drop-over": props.dnd.overZone() === zone }}
      data-dropzone={zone}
    >
      <div class="sprint-header">
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
        <span class="count figure muted">
          {props.issues.length}
          <Show when={points() > 0}> · {points()}pts</Show>
        </span>
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
                props.onDays(null);
                return;
              }
              const days = Number(raw);
              if (Number.isInteger(days) && days >= 1 && days <= 90) props.onDays(days);
              else e.currentTarget.value = String(props.sprint.planned_days ?? "");
            }}
          />
          d
        </label>
        <div class="spacer" />
        <button
          class="btn btn-small btn-quiet"
          title="Delete this planning sprint — its issues go back to Unassigned Backlog"
          onClick={() => {
            const n = props.issues.length;
            if (n === 0 || window.confirm(`Delete "${props.sprint.name}"? Its ${n} issue${n === 1 ? "" : "s"} will move back to the Backlog.`)) {
              props.onDelete();
            }
          }}
        >
          Delete
        </button>
        <button class="btn btn-small" onClick={props.onStart}>
          Start sprint
        </button>
      </div>
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
      <Show
        when={props.issues.length > 0}
        fallback={<p class="empty-state">Drag issues here to shape the sprint.</p>}
      >
        <For each={props.issues}>
          {(issue) => <IssueCard issue={issue} dnd={props.dnd} onOpen={props.onOpen} compact />}
        </For>
      </Show>
    </section>
  );
};

export const BacklogView = (props: {
  store: BoardStore;
  dnd: DndHandle;
  onOpen: (id: string) => void;
}) => {
  const planningSprints = () => props.store.sprints().filter((s) => s.status === "planning");
  // Unassigned Backlog: container=backlog AND not in any planning sprint. An
  // active sprint's members already left the backlog container when their
  // sprint started (via Kanban); a completed sprint's members either shipped
  // (container=active, column=done) or were carried/dropped by the complete
  // handler in 21b.
  const planningSprintIds = () => new Set(planningSprints().map((s) => s.id));
  const inSprint = (sprint: Sprint) =>
    props.store.issues().filter((i) => i.sprint_id === sprint.id && i.container === "backlog");
  const unassigned = () =>
    props.store
      .issues()
      .filter(
        (i) =>
          i.container === "backlog" &&
          (i.sprint_id === null || !planningSprintIds().has(i.sprint_id)),
      )
      .sort(byBoardOrder);

  const backlogZone = moveZone("promote_to_backlog");
  const iceboxZone = moveZone("send_to_icebox");

  const newSprint = () => {
    void props.store.createSprint(`Sprint ${props.store.sprints().length + 1}`);
  };

  const defaultDays = () => props.store.board()?.default_sprint_days ?? FALLBACK_SPRINT_DAYS;

  return (
    <div>
      <Show when={planningSprints().length > 0}>
        <div class="sprints-block">
          <For each={planningSprints()}>
            {(sprint) => (
              <SprintSection
                sprint={sprint}
                issues={inSprint(sprint)}
                dnd={props.dnd}
                onOpen={props.onOpen}
                onRename={(name) => void props.store.patchSprint(sprint.id, { name })}
                onGoal={(goal) => void props.store.patchSprint(sprint.id, { goal })}
                onDays={(days) => void props.store.patchSprint(sprint.id, { planned_days: days })}
                onStart={() => void props.store.startSprint(sprint.id)}
                onDelete={() => void props.store.deleteSprint(sprint.id)}
                defaultDays={defaultDays()}
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
          Backlog <span class="count figure muted">{unassigned().length}</span>
          <button class="btn btn-small sprint-new" onClick={newSprint}>
            + New sprint
          </button>
        </h2>
        <Show
          when={unassigned().length > 0}
          fallback={<p class="empty-state">Nothing on your mind. What are you thinking about?</p>}
        >
          <For each={unassigned()}>
            {(issue) => <IssueCard issue={issue} dnd={props.dnd} onOpen={props.onOpen} compact />}
          </For>
        </Show>
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
