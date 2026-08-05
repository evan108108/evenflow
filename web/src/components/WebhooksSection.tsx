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

import { For, Show, createEffect, createResource, createSignal } from "solid-js";
import { Effect } from "effect";
import { ApiClient, appRuntime, type ApiClientService, type ApiError } from "../effects";
import { authorLabel, profileFor, requestProfile } from "../lib/profileStore";

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
  predicate: { assignee?: string; exclude_actor?: string } | null;
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

interface MemberOption {
  readonly pubkey: string;
  readonly role: string;
}

/** Resolved display name for a member, matching how <Author> renders
 *  everywhere else on the app. Reads reactively from profileStore — the
 *  label updates from a canonical ref (google:... / nostr:...) to the
 *  member's display_name once their profile lands. */
const memberLabel = (m: MemberOption) =>
  `${authorLabel(profileFor(m.pubkey), m.pubkey, null)} · ${m.role}`;

const CUSTOM_SENTINEL = "__custom__";
const NONE_SENTINEL = "";

export const WebhooksSection = (props: {
  apiBase: string;
  /** Board's member roster, threaded from BoardSettings so we don't refetch
   *  the same rows the Members panel already loaded. */
  members: ReadonlyArray<MemberOption>;
}) => {
  const url = () => `${props.apiBase}/webhooks`;

  // Kick off a profile fetch for every roster member so their display
  // names resolve inside the <select>s below. Also request profiles for
  // any pubkey referenced by an existing subscription row so the "…
  // assignee=<name>" summary line reads the same way.
  createEffect(() => {
    for (const m of props.members) requestProfile(m.pubkey);
  });
  createEffect(() => {
    for (const s of data()?.subscriptions ?? []) {
      if (s.predicate?.assignee) requestProfile(s.predicate.assignee);
      if (s.predicate?.exclude_actor) requestProfile(s.predicate.exclude_actor);
    }
  });

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
  // Two-part state per predicate slot: a select-value + a text-value used
  // only when the select is on CUSTOM_SENTINEL. Keeping them separate means
  // switching from a member back to "any" doesn't lose what was typed.
  const [assigneeSelect, setAssigneeSelect] = createSignal(NONE_SENTINEL);
  const [assigneeCustom, setAssigneeCustom] = createSignal("");
  const [excludeSelect, setExcludeSelect] = createSignal(NONE_SENTINEL);
  const [excludeCustom, setExcludeCustom] = createSignal("");

  /** Resolve a select+custom pair to the string the API expects. Empty
   *  string means "unset — do not include in predicate." */
  const resolvePubkey = (select: string, custom: string): string => {
    if (select === CUSTOM_SENTINEL) return custom.trim();
    if (select === NONE_SENTINEL) return "";
    return select;
  };

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
      const predicate: Record<string, string> = {};
      const assigneeValue = resolvePubkey(assigneeSelect(), assigneeCustom());
      const excludeValue = resolvePubkey(excludeSelect(), excludeCustom());
      if (assigneeValue !== "") predicate["assignee"] = assigneeValue;
      if (excludeValue !== "") predicate["exclude_actor"] = excludeValue;
      if (Object.keys(predicate).length > 0) body["predicate"] = predicate;
      const res = await api<{ secret: string }>((c) => c.post(url(), body));
      setFreshSecret(res.secret);
      setName("");
      setTarget("");
      setKinds(DEFAULT_KINDS);
      setAssigneeSelect(NONE_SENTINEL);
      setAssigneeCustom("");
      setExcludeSelect(NONE_SENTINEL);
      setExcludeCustom("");
    });

  const setEnabled = (s: Subscription, enabled: boolean) =>
    guard(() => api((c) => c.patch(`${url()}/${s.id}`, { enabled })));

  const remove = (s: Subscription) =>
    guard(() => api((c) => c.delete(`${url()}/${s.id}`)));

  return (
    <section class="settings-section">
      <h2>Webhook subscriptions</h2>
      <p class="muted">
          POST board events to a URL you control. Each delivery is signed with
          HMAC-SHA256 in the <code>x-evenflow-signature</code> header.
      </p>

      {/*
        EFB-62 replaced a hard block here with an explanation. The old copy said
        webhooks were unavailable on private boards and hid the entire form —
        which, since boards are born private, meant the feature was unreachable
        for most boards rather than merely restricted. Private boards now
        subscribe like any other; what changes is that each delivery is checked
        against the subscription owner's board membership at send time.
      */}
      <Show when={isPrivate()}>
        <p class="callout">
          This board is private. Webhooks work, with one difference: each
          delivery is checked against the subscribing member's access at send
          time, so a subscription stops delivering if its owner leaves the
          board. Payloads are delivered encrypted — your endpoint needs the
          board's epoch key to read them.
        </p>
      </Show>

      <Show when={true}>
        <Show when={error() !== null}>
          <p class="muted" role="alert">{error()}</p>
        </Show>

        <Show when={freshSecret() !== null}>
          <div class="callout">
            <p><strong>Signing secret — copy it now.</strong></p>
            <p class="muted">
              This is the only time it's shown. If you lose it, delete the
              subscription and create a new one.
            </p>
            <code class="secret-once">{freshSecret()}</code>
            <button
              type="button"
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
          fallback={<p class="muted">No subscriptions yet.</p>}
        >
          <ul class="form-stack">
            <For each={subscriptions()}>
              {(s) => (
                <li class="callout">
                  <div class="stack-row">
                    <div class="grow-min">
                      <p>
                        {s.name}
                        <Show when={!s.enabled}>
                          <span class="muted">(disabled)</span>
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
                            class="badge-warn"
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
                      <p class="muted">{s.url}</p>
                      <p class="muted">
                        {s.event_kinds.join(", ")}
                        <Show when={s.predicate?.assignee !== undefined}>
                          {" · assignee="}
                          {authorLabel(
                            profileFor(s.predicate!.assignee!),
                            s.predicate!.assignee!,
                            null,
                          )}
                        </Show>
                        <Show when={s.predicate?.exclude_actor !== undefined}>
                          {" · exclude_actor="}
                          {authorLabel(
                            profileFor(s.predicate!.exclude_actor!),
                            s.predicate!.exclude_actor!,
                            null,
                          )}
                        </Show>
                      </p>
                    </div>
                    <div class="button-row">
                      <button
                        type="button"
                        class="btn btn-small"
                        disabled={busy()}
                        onClick={() => void setEnabled(s, !s.enabled)}
                      >
                        {s.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        class="btn btn-small"
                        onClick={() => {
                          setOpenLog(openLog() === s.id ? null : s.id);
                          void refetchLog();
                        }}
                      >
                        Deliveries
                      </button>
                      <button
                        type="button"
                        class="btn btn-small btn-danger"
                        disabled={busy()}
                        onClick={() => void remove(s)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  <Show when={openLog() === s.id}>
                    <div class="callout">
                      <Show
                        when={(log() ?? []).length > 0}
                        fallback={<p class="muted">No deliveries yet.</p>}
                      >
                        <table class="rules-table">
                          <thead>
                            <tr>
                              <th>Event</th>
                              <th>Queued</th>
                              <th>Attempted</th>
                              <th>Tries</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={log() ?? []}>
                              {(d) => (
                                <tr>
                                  <td>{d.event_kind}</td>
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
                                      fallback={<span class="muted">pending</span>}
                                    >
                                      {d.status_code ?? "network error"}
                                      <Show when={!d.terminal}>
                                        <span class="muted">(retrying)</span>
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
        <div class="form-stack">
          <h3>Add a subscription</h3>
          <input
            type="text"
            placeholder="Name (e.g. Slack bridge)"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
          />
          <input
            type="text"
            placeholder="https://example.com/hook"
            value={target()}
            onInput={(e) => setTarget(e.currentTarget.value)}
          />
          <div class="checkbox-grid">
            <For each={EVENT_KINDS}>
              {(k) => (
                <label>
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
          <label style={{ display: "flex", "flex-direction": "column", gap: "0.3rem" }}>
            <span class="muted" style={{ "font-size": "0.85rem" }}>Only issues assigned to</span>
            <select
              value={assigneeSelect()}
              onChange={(e) => setAssigneeSelect(e.currentTarget.value)}
            >
              <option value={NONE_SENTINEL}>— any assignee —</option>
              <For each={props.members}>
                {(m) => <option value={m.pubkey}>{memberLabel(m)}</option>}
              </For>
              <option value={CUSTOM_SENTINEL}>Custom identity…</option>
            </select>
            <Show when={assigneeSelect() === CUSTOM_SENTINEL}>
              <input
                type="text"
                placeholder="google:… / nostr:… / 64-char hex"
                value={assigneeCustom()}
                onInput={(e) => setAssigneeCustom(e.currentTarget.value)}
                style={{ "font-family": "monospace", "font-size": "0.85rem" }}
              />
            </Show>
          </label>
          <label style={{ display: "flex", "flex-direction": "column", gap: "0.3rem" }}>
            <span class="muted" style={{ "font-size": "0.85rem" }}>
              Suppress when caused by <em>(skip self-loop, e.g. your AI teammate's own actions)</em>
            </span>
            <select
              value={excludeSelect()}
              onChange={(e) => setExcludeSelect(e.currentTarget.value)}
            >
              <option value={NONE_SENTINEL}>— no suppression —</option>
              <For each={props.members}>
                {(m) => <option value={m.pubkey}>{memberLabel(m)}</option>}
              </For>
              <option value={CUSTOM_SENTINEL}>Custom identity…</option>
            </select>
            <Show when={excludeSelect() === CUSTOM_SENTINEL}>
              <input
                type="text"
                placeholder="google:… / nostr:… / 64-char hex"
                value={excludeCustom()}
                onInput={(e) => setExcludeCustom(e.currentTarget.value)}
                style={{ "font-family": "monospace", "font-size": "0.85rem" }}
              />
            </Show>
          </label>
          {/* In a .button-row rather than bare in the .form-stack: the stack is
              a flex column, so a bare button would stretch to the full width of
              the fields above it. */}
          <div class="button-row">
            <button
              type="button"
              class="btn btn-solid"
              disabled={busy() || name().trim() === "" || target().trim() === "" || kinds().length === 0}
              onClick={() => void create()}
            >
              Add subscription
            </button>
          </div>
        </div>
      </Show>
    </section>
  );
};
