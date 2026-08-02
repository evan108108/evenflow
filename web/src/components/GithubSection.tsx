// Board Settings → GitHub (phase 21).
//
// Four stacked surfaces, in the order an operator actually needs them:
//   1. Connect      — repo + the webhook URL and secret to paste into GitHub
//   2. Automation   — preset picker, then the rule table when on "custom"
//   3. Test         — paste a payload, see what WOULD fire, nothing written
//   4. Activity     — every delivery received, including the silent ones
//
// The secret is shown exactly once, at mint/rotate. There is no "reveal"
// affordance because there is nothing to reveal: D1 holds ciphertext and
// the server never hands the plaintext back.

import { For, Show, createResource, createSignal } from "solid-js";
import { Effect } from "effect";
import { ApiClient, appRuntime, type ApiClientService, type ApiError } from "../effects";
import { externalStateLabel } from "../lib/externalState";

const PRESETS = [
  { value: "defaults", label: "Use defaults", hint: "Pill + move to Done on merge." },
  { value: "status_only", label: "Status only", hint: "Pill only — never moves a card." },
  { value: "custom", label: "Custom", hint: "Your rules, edited below." },
  { value: "off", label: "Off", hint: "Record deliveries, change nothing." },
] as const;

type Preset = (typeof PRESETS)[number]["value"];

interface GithubConfig {
  repo: string | null;
  connected: boolean;
  has_secret: boolean;
  preset: Preset;
  external_states: ReadonlyArray<string>;
  webhook_url: string;
}

interface WireRule {
  id: string;
  bucket: "match" | "no_match";
  priority: number;
  when: Record<string, unknown>;
  /** One action or a list — see the `Rule` type in src/github/rules.ts. A rule
   *  that both sets the pill and moves the card sends the array form. */
  do: Record<string, unknown> | ReadonlyArray<Record<string, unknown>>;
  enabled: boolean;
}

interface AuditEntry {
  id: string;
  delivery_id: string | null;
  event_type: string;
  action: string | null;
  matched_issue_ids: ReadonlyArray<string>;
  matched_rule_ids: ReadonlyArray<string>;
  actions_taken: ReadonlyArray<{ short_id: string; kind: string; detail: string | null; applied: boolean }>;
  error: string | null;
  received_at_ms: number;
}

interface TestOutcome {
  short_id: string;
  rule_id: string | null;
  effects: ReadonlyArray<Record<string, unknown>>;
}

interface TestResult {
  refs: { short_ids: ReadonlyArray<string>; explicit: boolean };
  matched: ReadonlyArray<string>;
  unresolved: ReadonlyArray<string>;
  bucket: string;
  no_rule_matched: boolean;
  outcomes: ReadonlyArray<TestOutcome>;
}

const api = <T,>(f: (c: ApiClientService) => Effect.Effect<T, ApiError>): Promise<T> =>
  appRuntime.runPromise(Effect.flatMap(ApiClient, f));

/** One-line English for a rule's predicate — the table must be readable. */
const describeWhen = (when: Record<string, unknown>): string => {
  const bits: string[] = [String(when["event"] ?? "?")];
  if (when["action"] !== undefined) bits.push(`action=${String(when["action"])}`);
  if (when["merged"] !== undefined) bits.push(when["merged"] === true ? "merged" : "not merged");
  if (when["draft"] !== undefined) bits.push(when["draft"] === true ? "draft" : "not draft");
  if (when["review_state"] !== undefined) bits.push(`review=${String(when["review_state"])}`);
  if (when["conclusion"] !== undefined) bits.push(`conclusion=${String(when["conclusion"])}`);
  if (when["check_name_contains"] !== undefined) {
    bits.push(`check~"${String(when["check_name_contains"])}"`);
  }
  return bits.join(" · ");
};

/**
 * One-line English for a rule's action list.
 *
 * `do` has accepted an ARRAY since the engine learned multi-action rules, and
 * this read it as a single action — so the defaults preset's merged rule, which
 * has been array-form on every board since then, rendered as a bare "?" in this
 * table: `["type"]` on an array is undefined, which fell straight to the
 * default branch. Anyone reading their own rules saw the automation that
 * actually runs described as an unknown. EFB-72 turns three more rules into
 * arrays, which would have made it four unreadable rows instead of one.
 */
export const describeActions = (
  actions: Record<string, unknown> | ReadonlyArray<Record<string, unknown>>,
): string => (Array.isArray(actions) ? actions : [actions]).map(describeDo).join(", then ");

const describeDo = (action: Record<string, unknown>): string => {
  switch (action["type"]) {
    case "set_external_state":
      return `set pill → ${externalStateLabel(String(action["value"]))}`;
    case "transition_to_column":
      return action["category"] !== undefined
        ? `move to first "${String(action["category"])}" column`
        : `move to a specific column`;
    case "set_container":
      return `move to ${String(action["container"])}`;
    case "add_comment":
      return "post a comment";
    case "assign":
      return action["who"] === "pr_author" ? "assign the PR author" : "assign a fixed member";
    case "add_label":
      return `add label "${String(action["label"])}"`;
    case "no_op":
      return "record only";
    default:
      return String(action["type"] ?? "?");
  }
};

const describeEffect = (e: Record<string, unknown>): string => {
  switch (e["kind"]) {
    case "set_external_state":
      return `pill → ${externalStateLabel(String(e["value"]))}`;
    case "set_column":
      return `move → ${String(e["column_name"])}`;
    case "set_container":
      return `container → ${String(e["container"])}`;
    case "add_comment":
      return `comment: ${String(e["body"]).slice(0, 120)}`;
    case "assign":
      return `assign → ${String(e["pubkey"])}`;
    case "add_label":
      return `label → ${String(e["label"])}`;
    case "record_pr_link":
      return `link ${String(e["repo"])}#${String(e["pr"])} (${String(e["state"])})`;
    case "no_op":
      return "record only";
    case "skipped":
      return `skipped — ${String(e["reason"])}`;
    default:
      return String(e["kind"]);
  }
};

const when = (ms: number): string => new Date(ms).toLocaleString();

export const GithubSection = (props: { apiBase: string }) => {
  const url = () => `${props.apiBase}/github`;

  const [data, { refetch }] = createResource(
    () => props.apiBase,
    () => api<{ config: GithubConfig; rules: WireRule[] }>((c) => c.get(url())),
  );

  const [repo, setRepo] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  // Held in memory only, for as long as this page is open.
  const [freshSecret, setFreshSecret] = createSignal<string | null>(null);

  const [payloadText, setPayloadText] = createSignal("");
  const [testEvent, setTestEvent] = createSignal("pull_request");
  const [testResult, setTestResult] = createSignal<TestResult | null>(null);

  const [auditFilter, setAuditFilter] = createSignal<string>("");
  const [audit, { refetch: refetchAudit }] = createResource(
    () => `${props.apiBase}|${auditFilter()}`,
    () =>
      api<{ entries: AuditEntry[] }>((c) =>
        c.get(`${url()}/audit${auditFilter() === "" ? "" : `?event_type=${auditFilter()}`}`),
      )
        .then((r) => r.entries)
        .catch(() => [] as AuditEntry[]),
  );

  const config = () => data()?.config;
  const rules = () => data()?.rules ?? [];
  const repoValue = () => repo() ?? config()?.repo ?? "";

  const guard = async (label: string, run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await run();
      setNotice(label);
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveRepo = () =>
    guard("Repository saved.", () => api((c) => c.put(url(), { repo: repoValue().trim() || null })));

  const choosePreset = (preset: Preset) =>
    guard(`Preset set to ${preset}.`, () => api((c) => c.put(url(), { preset })));

  const rotate = () =>
    guard("Secret generated — copy it now.", async () => {
      const res = await api<{ secret: string }>((c) => c.post(`${url()}/secret`, {}));
      setFreshSecret(res.secret);
    });

  const disconnect = () =>
    guard("Disconnected.", async () => {
      await api((c) => c.delete(url()));
      setFreshSecret(null);
    });

  const setRuleEnabled = (id: string, enabled: boolean) =>
    guard(enabled ? "Rule enabled." : "Rule disabled.", () =>
      api((c) =>
        c.put(`${url()}/rules`, {
          rules: rules().map((r) => (r.id === id ? { ...r, enabled } : r)),
        }),
      ),
    );

  const runTest = async () => {
    setError(null);
    setTestResult(null);
    let payload: unknown;
    try {
      payload = JSON.parse(payloadText());
    } catch {
      setError("That payload is not valid JSON.");
      return;
    }
    setBusy(true);
    try {
      setTestResult(await api<TestResult>((c) => c.post(`${url()}/test`, { event: testEvent(), payload })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const webhookAbsoluteUrl = () =>
    config() === undefined ? "" : `${window.location.origin}${config()!.webhook_url}`;

  return (
    <>
      {/* ── 1. connect ───────────────────────────────────────────────── */}
      <section class="settings-section">
        <h2>GitHub</h2>
        <p class="muted">
          Link a repository so pull requests report onto your cards. A ticket's{" "}
          <strong>external state</strong> is shown as a pill and is independent of which column the
          card sits in — automation that also moves cards is opt-in below.
        </p>

        <Show when={error()}>
          <p class="muted" role="alert">
            {error()}
          </p>
        </Show>
        <Show when={notice()}>
          <p class="muted">{notice()}</p>
        </Show>

        <label class="field-label" for="gh-repo">
          Repository
        </label>
        <input
          id="gh-repo"
          type="text"
          placeholder="owner/name"
          value={repoValue()}
          onInput={(e) => setRepo(e.currentTarget.value)}
        />
        <div class="button-row">
          <button type="button" onClick={saveRepo} disabled={busy()}>
            Save repository
          </button>
        </div>

        <Show when={config()?.connected}>
          <h3>Webhook</h3>
          <p class="muted">
            In GitHub: <em>Settings → Webhooks → Add webhook</em>. Content type must be{" "}
            <code>application/json</code>. Subscribe to <code>Pull requests</code>,{" "}
            <code>Pull request reviews</code> and <code>Check runs</code>.
          </p>
          <p>
            <strong>Payload URL</strong>
            <br />
            <code>{webhookAbsoluteUrl()}</code>
          </p>

          <Show
            when={freshSecret()}
            fallback={
              <p class="muted">
                {config()?.has_secret === true
                  ? "A secret is configured. It cannot be shown again — generate a new one if you no longer have it."
                  : "No secret yet. Generate one, then paste it into GitHub's Secret field."}
              </p>
            }
          >
            {(secret) => (
              <div class="callout">
                <p>
                  <strong>Copy this now — it will not be shown again.</strong>
                </p>
                <code class="secret-once">{secret()}</code>
              </div>
            )}
          </Show>

          <div class="button-row">
            <button type="button" onClick={rotate} disabled={busy()}>
              {config()?.has_secret === true ? "Generate new secret" : "Generate secret"}
            </button>
            <button type="button" class="danger" onClick={disconnect} disabled={busy()}>
              Disconnect
            </button>
          </div>
          <Show when={config()?.has_secret === true}>
            <p class="muted">
              Generating a new secret invalidates the old one immediately; deliveries signed with it
              start failing until GitHub is updated.
            </p>
          </Show>
        </Show>
      </section>

      {/* ── 2. automation ────────────────────────────────────────────── */}
      <Show when={config()?.connected}>
        <section class="settings-section">
          <h2>Automation</h2>
          <div class="preset-grid">
            <For each={[...PRESETS]}>
              {(p) => (
                <button
                  type="button"
                  class="preset-card"
                  classList={{ active: config()?.preset === p.value }}
                  disabled={busy()}
                  onClick={() => choosePreset(p.value)}
                >
                  <span class="preset-label">{p.label}</span>
                  <span class="muted">{p.hint}</span>
                </button>
              )}
            </For>
          </div>
          <p class="muted">
            Rules are checked in priority order and <strong>the first match wins</strong> — one
            action per delivery, so a card never moves twice for one event.
          </p>

          <Show
            when={rules().length > 0}
            fallback={<p class="muted">No rules — deliveries are recorded but change nothing.</p>}
          >
            <table class="rules-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>When</th>
                  <th>Then</th>
                  <th>Bucket</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <For each={rules()}>
                  {(r) => (
                    <tr classList={{ disabled: !r.enabled }}>
                      <td class="figure">{r.priority}</td>
                      <td>
                        <code>{describeWhen(r.when)}</code>
                      </td>
                      <td>{describeActions(r.do)}</td>
                      <td class="muted">{r.bucket === "no_match" ? "no ticket matched" : "matched"}</td>
                      <td>
                        <button
                          type="button"
                          disabled={busy()}
                          onClick={() => setRuleEnabled(r.id, !r.enabled)}
                        >
                          {r.enabled ? "Disable" : "Enable"}
                        </button>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </section>

        {/* ── 3. test panel ──────────────────────────────────────────── */}
        <section class="settings-section">
          <h2>Test a payload</h2>
          <p class="muted">
            Paste a webhook payload to see which rules match and what would happen.{" "}
            <strong>Nothing is written</strong> — no cards change, no activity is recorded. In
            GitHub you can copy one from <em>Settings → Webhooks → Recent Deliveries</em>.
          </p>
          <label class="field-label" for="gh-test-event">
            Event type
          </label>
          <select
            id="gh-test-event"
            value={testEvent()}
            onChange={(e) => setTestEvent(e.currentTarget.value)}
          >
            <option value="pull_request">pull_request</option>
            <option value="pull_request_review">pull_request_review</option>
            <option value="check_run">check_run</option>
          </select>
          <label class="field-label" for="gh-test-payload">
            Payload JSON
          </label>
          <textarea
            id="gh-test-payload"
            rows={8}
            value={payloadText()}
            onInput={(e) => setPayloadText(e.currentTarget.value)}
            placeholder='{"action": "opened", "pull_request": { … }}'
          />
          <div class="button-row">
            <button type="button" onClick={runTest} disabled={busy() || payloadText().trim() === ""}>
              Test
            </button>
          </div>

          <Show when={testResult()}>
            {(result) => (
              <div class="test-result">
                <p>
                  Refs found: <code>{result().refs.short_ids.join(", ") || "none"}</code>
                  <Show when={result().refs.explicit}> (from an explicit evenflow: line)</Show>
                </p>
                <Show when={result().unresolved.length > 0}>
                  <p class="muted">
                    Not on this board: <code>{result().unresolved.join(", ")}</code>
                  </p>
                </Show>
                <Show when={result().no_rule_matched}>
                  <p class="muted">No rule matched this delivery.</p>
                </Show>
                <Show
                  when={result().outcomes.length > 0}
                  fallback={<p class="muted">No ticket would be touched.</p>}
                >
                  <ul>
                    <For each={result().outcomes}>
                      {(o) => (
                        <li>
                          <strong>{o.short_id || "(no ticket)"}</strong>
                          <ul>
                            <For each={o.effects}>{(e) => <li>{describeEffect(e)}</li>}</For>
                          </ul>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
            )}
          </Show>
        </section>

        {/* ── 4. activity ────────────────────────────────────────────── */}
        <section class="settings-section">
          <h2>Activity</h2>
          <p class="muted">
            Every verified delivery, including ones that matched nothing — so a rule that quietly
            never fires is visible rather than mysterious.
          </p>
          <div class="button-row">
            <select value={auditFilter()} onChange={(e) => setAuditFilter(e.currentTarget.value)}>
              <option value="">All events</option>
              <option value="pull_request">pull_request</option>
              <option value="pull_request_review">pull_request_review</option>
              <option value="check_run">check_run</option>
            </select>
            <button type="button" onClick={() => void refetchAudit()}>
              Refresh
            </button>
          </div>

          <Show
            when={(audit() ?? []).length > 0}
            fallback={<p class="muted">No deliveries received yet.</p>}
          >
            <table class="rules-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                <For each={audit()}>
                  {(e) => (
                    <tr classList={{ "has-error": e.error !== null }}>
                      <td class="muted">{when(e.received_at_ms)}</td>
                      <td>
                        <code>
                          {e.event_type}
                          {e.action === null ? "" : `.${e.action}`}
                        </code>
                      </td>
                      <td>
                        <Show when={e.error !== null}>
                          <span class="error-text">{e.error}</span>
                        </Show>
                        <Show when={e.error === null && e.actions_taken.length === 0}>
                          <span class="muted">no matching ticket or rule</span>
                        </Show>
                        <For each={e.actions_taken}>
                          {(a) => (
                            <div classList={{ muted: !a.applied }}>
                              {a.short_id === "" ? "" : `${a.short_id}: `}
                              {a.kind}
                              {a.detail === null ? "" : ` (${a.detail})`}
                            </div>
                          )}
                        </For>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </section>
      </Show>
    </>
  );
};
