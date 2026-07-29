// + New board modal. Submits through onCreate; the caller returns the
// created board so the modal can surface a server-adjusted issue prefix
// (conflict auto-suffix: FLOW → FLOW2) before handing off via onDone.

import { Show, createSignal } from "solid-js";
import { PREFIX_RE, derivePrefix } from "../lib/slug";

export interface NewBoardInput {
  slug: string;
  title: string;
  description?: string;
  issue_prefix?: string;
  columns?: string[];
  member_policy?: "open" | "invite";
}

/** The slice of the POST /boards response the modal needs. */
export interface CreatedBoard {
  slug: string;
  issue_prefix: string | null;
}

const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;

const slugify = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

export const NewBoardModal = (props: {
  onClose: () => void;
  onCreate: (input: NewBoardInput) => Promise<CreatedBoard>;
  onDone: (board: CreatedBoard) => void;
}) => {
  const [title, setTitle] = createSignal("");
  const [slug, setSlug] = createSignal("");
  const [slugTouched, setSlugTouched] = createSignal(false);
  const [prefix, setPrefix] = createSignal("");
  const [prefixTouched, setPrefixTouched] = createSignal(false);
  const [description, setDescription] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // Set when the server auto-suffixed a taken prefix — the modal stays open
  // to show the finalized value before moving to the board.
  const [suffixed, setSuffixed] = createSignal<CreatedBoard | null>(null);

  const effectiveSlug = () => (slugTouched() ? slug() : slugify(title()));
  const effectivePrefix = () =>
    (prefixTouched() ? prefix() : derivePrefix(title())).toUpperCase();

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    const t = title().trim();
    const s = effectiveSlug().trim();
    const p = effectivePrefix().trim();
    if (t === "") return;
    if (!SLUG_RE.test(s)) {
      setError("Slug must be 1–64 letters, digits, dashes, or underscores.");
      return;
    }
    if (!PREFIX_RE.test(p)) {
      setError("Prefix must be 2–5 uppercase letters or digits.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const board = await props.onCreate({
        slug: s,
        title: t,
        issue_prefix: p,
        ...(description().trim() === "" ? {} : { description: description().trim() }),
      });
      if (board.issue_prefix === p) props.onDone(board);
      else setSuffixed(board);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something drifted. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="modal-overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <Show
        when={suffixed() === null}
        fallback={
          <div class="modal">
            <h2>Board created</h2>
            <p class="muted">
              The prefix <strong class="serif">{effectivePrefix()}</strong> was already taken, so
              this board's issues will read{" "}
              <strong class="serif">{suffixed()!.issue_prefix}-1</strong>,{" "}
              <strong class="serif">{suffixed()!.issue_prefix}-2</strong>, …
            </p>
            <div class="actions">
              <button class="btn btn-solid" onClick={() => props.onDone(suffixed()!)}>
                Go to board
              </button>
            </div>
          </div>
        }
      >
        <form class="modal" onSubmit={submit}>
          <h2>New board</h2>
          <label for="nb-title">Title</label>
          <input
            id="nb-title"
            type="text"
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
            placeholder="Roadmap"
            autofocus
          />
          <label for="nb-slug">Slug (used in URL)</label>
          <input
            id="nb-slug"
            type="text"
            value={effectiveSlug()}
            onInput={(e) => {
              setSlug(e.currentTarget.value);
              setSlugTouched(true);
            }}
            placeholder="roadmap"
          />
          <label for="nb-prefix">Prefix (issue ids)</label>
          <input
            id="nb-prefix"
            type="text"
            value={effectivePrefix()}
            maxlength="5"
            onInput={(e) => {
              setPrefix(e.currentTarget.value.toUpperCase());
              setPrefixTouched(true);
            }}
            placeholder="FLOW"
          />
          <Show when={effectivePrefix() !== ""}>
            <p class="muted prefix-preview">
              Issues will read <span class="serif">{effectivePrefix()}-1</span>,{" "}
              <span class="serif">{effectivePrefix()}-2</span>, …
            </p>
          </Show>
          <label for="nb-description">Description (optional)</label>
          <textarea
            id="nb-description"
            rows={3}
            value={description()}
            onInput={(e) => setDescription(e.currentTarget.value)}
          />
          <Show when={error() !== null}>
            <p class="muted" style={{ color: "var(--color-warn, #a35b2f)", margin: "0.5rem 0 0" }}>
              {error()}
            </p>
          </Show>
          <div class="actions">
            <button type="button" class="btn" onClick={props.onClose}>
              Cancel
            </button>
            <button
              type="submit"
              class="btn btn-solid"
              disabled={title().trim() === "" || busy()}
            >
              <Show when={!busy()} fallback={"Following through…"}>
                Create board
              </Show>
            </button>
          </div>
        </form>
      </Show>
    </div>
  );
};
