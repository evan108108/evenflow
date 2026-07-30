// /settings/notifications — per-user notification preferences. Save-on-
// change: every toggle/dropdown PATCHes immediately and a small "Saved"
// note breathes in. Config surface only — delivery ships in a later phase,
// so the copy promises persistence, not emails.

import { Show, createResource, createSignal } from "solid-js";
import { Effect } from "effect";
import { ApiClient, appRuntime, type ApiClientService, type ApiError } from "../effects";
import { TopBar } from "../components/TopBar";
import "../lib/board.css";

interface NotificationsConfig {
  email_on_mention: boolean;
  email_on_assignment: boolean;
  email_on_issue_moved_to_me: boolean;
  email_digest: "off" | "daily" | "weekly";
}

const api = <T,>(f: (c: ApiClientService) => Effect.Effect<T, ApiError>): Promise<T> =>
  appRuntime.runPromise(Effect.flatMap(ApiClient, f));

const TOGGLES: ReadonlyArray<{ key: keyof NotificationsConfig & string; label: string }> = [
  { key: "email_on_mention", label: "Email me when I'm mentioned" },
  { key: "email_on_assignment", label: "Email me when an issue is assigned to me" },
  { key: "email_on_issue_moved_to_me", label: "Email me when an issue is moved onto my board" },
];

export const NotificationsSettings = () => {
  const [config, { mutate }] = createResource(() =>
    api<{ config: NotificationsConfig }>((c) => c.get("/api/v0/notifications/config")).then(
      (r) => r.config,
    ),
  );
  const [saved, setSaved] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const patch = async (change: Partial<NotificationsConfig>) => {
    const before = config();
    if (before === undefined) return;
    mutate({ ...before, ...change });
    setError(null);
    try {
      const res = await api<{ config: NotificationsConfig }>((c) =>
        c.patch("/api/v0/notifications/config", change),
      );
      mutate(res.config);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch {
      mutate(before);
      setError("The current pushed back — that change didn't stick.");
    }
  };

  return (
    <main style={{ "max-width": "34rem", margin: "0 auto", padding: "2.5rem 1.5rem 4rem var(--page-inset-left, 3rem)" }}>
      <TopBar crumbs={[{ label: "Boards", href: "/boards" }, { label: "Notifications" }]} />
      <header style={{ margin: "1.6rem 0 2rem" }}>
        <h1 style={{ "font-size": "2.2rem" }}>Notifications</h1>
        <p class="muted" style={{ "margin-top": "0.4rem", "font-size": "0.9rem" }}>
          Choose what lands in your inbox. Changes save as you make them.
        </p>
      </header>

      <Show when={error()}>
        <p class="muted" role="alert">
          {error()}
        </p>
      </Show>

      <Show when={config()} fallback={<p class="muted">Finding the rhythm…</p>}>
        {(cfg) => (
          <section class="settings-section">
            <div style={{ display: "flex", "flex-direction": "column", gap: "0.9rem" }}>
              {TOGGLES.map((t) => (
                <label style={{ display: "flex", "align-items": "center", gap: "0.6rem", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={cfg()[t.key] === true}
                    onChange={(e) => void patch({ [t.key]: e.currentTarget.checked })}
                  />
                  {t.label}
                </label>
              ))}
              <label
                for="digest"
                style={{ display: "flex", "align-items": "center", gap: "0.6rem", "margin-top": "0.4rem" }}
              >
                Email digest
                <select
                  id="digest"
                  value={cfg().email_digest}
                  onInput={(e) =>
                    void patch({ email_digest: e.currentTarget.value as NotificationsConfig["email_digest"] })
                  }
                >
                  <option value="off">Off</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
              </label>
            </div>
            <Show when={saved()}>
              <p class="muted" style={{ "font-size": "0.85rem", "margin-top": "0.9rem" }}>
                Saved — flowing outward.
              </p>
            </Show>
          </section>
        )}
      </Show>
    </main>
  );
};
