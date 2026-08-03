// Board Settings → Webhook subscriptions (EFB-13).
//
// The outbound counterpart to GithubSection's inbound surface. Three stacked
// pieces: the list of subscriptions, an add form, and a per-row delivery log.
//
// Named WebhooksSection rather than the brief's "WebhookSubscriptionsView"
// because every other panel on this page is a `*Section` (GithubSection,
// StorageSection) and consistency beats the brief's guess at a filename.
//
// The secret is shown exactly once, at create. There is no reveal affordance
// because there is nothing to reveal — D1 holds ciphertext and the server never
// hands the plaintext back. Same posture as the GitHub webhook secret.

import { For, Show, createResource, createSignal } from "solid-js";
import { Effect } from "effect";
import { ApiClient, appRuntime, type ApiClientService, type ApiError } from "../effects";

const api = <T,>(f: (c: ApiClientService) => Effect.Effect<T, ApiError>): Promise<T> =>
  appRuntime.runPromise(Effect.flatMap(ApiClient, f));

/** Mirrors the frozen vocabulary in src/durable-objects/board-events.ts. */
const EVENT_KINDS = [
  "issue.created",
  "issue.updated",
  "issue.transitioned",
  "issue.container_changed",
  "issue.deleted",
  "comment.created",
  "comment.deleted",
  "board.created",
  "board.updated",
  "board.deleted",
  "sprint.created",
  "sprint.updated",
  "sprint.started",
  "sprint.completed",
  "sprint.deleted",
  "sprint.tide.updated",
  // EFB-15. NOTE for whoever adds the next kind: this list is a FIFTH mirror of
  // the vocabulary, and unlike the other four it is asserted by nothing — the
  // EFB-13 mirror test covers src/routes/webhooks.ts and the tsc assertion
  // covers SseStream.ts, but a kind missing here just fails to appear as a
  // checkbox, silently, and becomes unsubscribable through the UI.
  "issues.imported",
] as const;

/** Sensible starting set — the kinds a notification bridge actually wants. */
const DEFAULT_KINDS = ["issue.created", "issue.transitioned", "comment.created"];

interface Subscription {
  id: string;
  name: string;
  url: string;
  event_kinds: string[];
  predicate: { assignee?: string } | null;
  auth_scheme: string;
  enabled: boolean;
  created_at_ms: number;
  /** EFB-62 — who the private-board delivery gate checks. */
  creator_pubkey: string | null;
  /**
   * Whether deliveries are actually flowing. Distinct from `enabled`: that is
   * what the admin set, this is what the server's member gate decided. On a
   * public board it is always true.
   */
  member_ok: boolean;
}

interface Delivery {
  id: string;
  event_kind: string;
  created_at_ms: number;
  attempted_at_ms: number | null;
  attempt_count: number;
  status_code: number | null;
  response_body_snippet: string | null;
  terminal: boolean;
  pending: boolean;
}

const when = (ms: number | null) =>
  ms === null ? "—" : new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

export const WebhooksSection = (props: { apiBase: string }) => {
  const url = () => `${props.apiBase}/webhooks`;

  const [data, { refetch }] = createResource(
    () => props.apiBase,
    () => api<{ subscriptions: Subscription[]; private_board: boolean }>((c) => c.get(url())),
  );

  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // Held in memory only, for as long as this page is open.
  const [freshSecret, setFreshSecret] = createSignal<string | null>(null);

  const [name, setName] = createSignal("");
  const [target, setTarget] = createSignal("");
  const [kinds, setKinds] = createSignal<string[]>(DEFAULT_KINDS);
  const [assignee, setAssignee] = createSignal("");

  const [openLog, setOpenLog] = createSignal<string | null>(null);
  const [log, { refetch: refetchLog }] = createResource(
    () => openLog(),
    async (id) =>
      id === null
        ? []
        : await api<{ deliveries: Delivery[] }>((c) => c.get(`${url()}/${id}/deliveries`))
            .then((r) => r.deliveries)
            .catch(() => [] as Delivery[]),
  );

  const subscriptions = () => data()?.subscriptions ?? [];
  const isPrivate = () => data()?.private_board === true;

  const guard = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      await refetch();
    } catch (e) {
      const reason = (e as { reason?: string })?.reason;
      setError(reason ?? "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const toggleKind = (k: string) =>
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  const create = () =>
    guard(async () => {
      const body: Record<string, unknown> = {
        name: name().trim(),
        url: target().trim(),
        event_kinds: kinds(),
      };
      // Absent, not null — the schema rejects unknown keys but treats an
      // omitted optional differently from an explicit null, and "no predicate"
      // is the former.
      if (assignee().trim() !== "") body["predicate"] = { assignee: assignee().trim() };
      const res = await api<{ secret: string }>((c) => c.post(url(), body));
      setFreshSecret(res.secret);
      setName("");
      setTarget("");
      setKinds(DEFAULT_KINDS);
      setAssignee("");
    });

  const setEnabled = (s: Subscription, enabled: boolean) =>
    guard(() => api((c) => c.patch(`${url()}/${s.id}`, { enabled })));

  const remove = (s: Subscription) =>
    guard(() => api((c) => c.delete(`${url()}/${s.id}`)));

  return (
    <section class="space-y-4">
      <header>
        <h2 class="text-lg font-medium">Webhook subscriptions</h2>
        <p class="text-sm opacity-70">
          POST board events to a URL you control. Each delivery is signed with
          HMAC-SHA256 in the <code>x-evenflow-signature</code> header.
        </p>
      </header>

      {/*
        EFB-62 replaced a hard block here with an explanation. The old copy said
        webhooks were unavailable on private boards and hid the entire form —
        which, since boards are born private, meant the feature was unreachable
        for most boards rather than merely restricted. Private boards now
        subscribe like any other; what changes is that each delivery is checked
        against the subscription owner's board membership at send time.
      */}
      <Show when={isPrivate()}>
        <p class="rounded border border-sky-500/40 bg-sky-500/10 p-3 text-sm">
          This board is private. Webhooks work, with one difference: each
          delivery is checked against the subscribing member's access at send
          time, so a subscription stops delivering if its owner leaves the
          board. Payloads are delivered encrypted — your endpoint needs the
          board's epoch key to read them.
        </p>
      </Show>

      <Show when={true}>
        <Show when={error() !== null}>
          <p class="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm">{error()}</p>
        </Show>

        <Show when={freshSecret() !== null}>
          <div class="rounded border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
            <p class="font-medium">Signing secret — copy it now.</p>
            <p class="opacity-80">
              This is the only time it's shown. If you lose it, delete the
              subscription and create a new one.
            </p>
            <code class="mt-2 block break-all rounded bg-black/20 p-2">{freshSecret()}</code>
            <button
              type="button"
              class="mt-2 rounded border px-2 py-1 hover:bg-white/10"
              onClick={() => {
                void navigator.clipboard?.writeText(freshSecret() ?? "");
                setFreshSecret(null);
              }}
            >
              Copy and dismiss
            </button>
          </div>
        </Show>

        {/* ── list ─────────────────────────────────────────────────────── */}
        <Show
          when={subscriptions().length > 0}
          fallback={<p class="text-sm opacity-70">No subscriptions yet.</p>}
        >
          <ul class="space-y-2">
            <For each={subscriptions()}>
              {(s) => (
                <li class="rounded border p-3">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <p class="font-medium">
                        {s.name}
                        <Show when={!s.enabled}>
                          <span class="ml-2 text-xs opacity-60">(disabled)</span>
                        </Show>
                        {/*
                          EFB-62 — the whole reason `member_ok` is on the wire.
                          The gate deliberately leaves a lapsed subscription's
                          row alive and silently drops its deliveries, so
                          without this badge an admin sees an enabled webhook
                          that has simply gone quiet, which is indistinguishable
                          from our cron being broken.
                        */}
                        <Show when={s.enabled && !s.member_ok}>
                          <span
                            class="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-200"
                            title={
                              "Deliveries are paused: this subscription's owner" +
                              " is no longer a member of this board. Re-add them" +
                              " to resume, or delete the subscription."
                            }
                          >
                            not delivering — owner left the board
                          </span>
                        </Show>
                      </p>
                      <p class="truncate text-sm opacity-70">{s.url}</p>
                      <p class="mt-1 text-xs opacity-60">
                        {s.event_kinds.join(", ")}
                        <Show when={s.predicate?.assignee !== undefined}>
                          {" · assignee="}
                          {s.predicate?.assignee}
                        </Show>
                      </p>
                    </div>
                    <div class="flex shrink-0 gap-2">
                      <button
                        type="button"
                        class="rounded border px-2 py-1 text-sm hover:bg-white/10"
                        disabled={busy()}
                        onClick={() => void setEnabled(s, !s.enabled)}
                      >
                        {s.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        class="rounded border px-2 py-1 text-sm hover:bg-white/10"
                        onClick={() => {
                          setOpenLog(openLog() === s.id ? null : s.id);
                          void refetchLog();
                        }}
                      >
                        Deliveries
                      </button>
                      <button
                        type="button"
                        class="rounded border border-red-500/40 px-2 py-1 text-sm hover:bg-red-500/10"
                        disabled={busy()}
                        onClick={() => void remove(s)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  <Show when={openLog() === s.id}>
                    <div class="mt-3 border-t pt-3">
                      <Show
                        when={(log() ?? []).length > 0}
                        fallback={<p class="text-sm opacity-70">No deliveries yet.</p>}
                      >
                        <table class="w-full text-left text-xs">
                          <thead class="opacity-60">
                            <tr>
                              <th class="py-1">Event</th>
                              <th>Queued</th>
                              <th>Attempted</th>
                              <th>Tries</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={log() ?? []}>
                              {(d) => (
                                <tr class="border-t border-white/10">
                                  <td class="py-1">{d.event_kind}</td>
                                  <td>{when(d.created_at_ms)}</td>
                                  <td>{when(d.attempted_at_ms)}</td>
                                  <td>{d.attempt_count}</td>
                                  <td>
                                    {/*
                                      "Pending" is distinct from a failure on
                                      purpose: a row the sweep has never touched
                                      means our cron hasn't run, which is a
                                      different problem from a subscriber that
                                      answered badly.
                                    */}
                                    <Show
                                      when={!d.pending}
                                      fallback={<span class="opacity-60">pending</span>}
                                    >
                                      {d.status_code ?? "network error"}
                                      <Show when={!d.terminal}>
                                        <span class="ml-1 opacity-60">(retrying)</span>
                                      </Show>
                                    </Show>
                                  </td>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </Show>
                    </div>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>

        {/* ── add ──────────────────────────────────────────────────────── */}
        <div class="space-y-2 rounded border p-3">
          <p class="font-medium">Add a subscription</p>
          <input
            class="w-full rounded border bg-transparent px-2 py-1"
            placeholder="Name (e.g. Slack bridge)"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
          />
          <input
            class="w-full rounded border bg-transparent px-2 py-1"
            placeholder="https://example.com/hook"
            value={target()}
            onInput={(e) => setTarget(e.currentTarget.value)}
          />
          <div class="flex flex-wrap gap-2">
            <For each={EVENT_KINDS}>
              {(k) => (
                <label class="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={kinds().includes(k)}
                    onChange={() => toggleKind(k)}
                  />
                  {k}
                </label>
              )}
            </For>
          </div>
          <input
            class="w-full rounded border bg-transparent px-2 py-1"
            placeholder="Only issues assigned to (optional pubkey — yours, unless you're an admin)"
            value={assignee()}
            onInput={(e) => setAssignee(e.currentTarget.value)}
          />
          <button
            type="button"
            class="rounded border px-3 py-1 hover:bg-white/10 disabled:opacity-50"
            disabled={busy() || name().trim() === "" || target().trim() === "" || kinds().length === 0}
            onClick={() => void create()}
          >
            Add subscription
          </button>
        </div>
      </Show>
    </section>
  );
};
