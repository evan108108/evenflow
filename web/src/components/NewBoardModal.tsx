// + New board modal. Submits through onCreate; caller decides where to
// navigate on success (BoardsList → /boards/:slug).

import { Show, createSignal } from "solid-js";

export interface NewBoardInput {
  slug: string;
  title: string;
  description?: string;
  columns?: string[];
  member_policy?: "open" | "invite";
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
  onCreate: (input: NewBoardInput) => Promise<void>;
}) => {
  const [title, setTitle] = createSignal("");
  const [slug, setSlug] = createSignal("");
  const [slugTouched, setSlugTouched] = createSignal(false);
  const [description, setDescription] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const effectiveSlug = () => (slugTouched() ? slug() : slugify(title()));

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    const t = title().trim();
    const s = effectiveSlug().trim();
    if (t === "") return;
    if (!SLUG_RE.test(s)) {
      setError("Slug must be 1–64 letters, digits, dashes, or underscores.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await props.onCreate({
        slug: s,
        title: t,
        ...(description().trim() === "" ? {} : { description: description().trim() }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something drifted. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="modal-overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
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
    </div>
  );
};
