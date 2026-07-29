// Client mirror of src/slug.ts (the Worker owns the authoritative copy —
// keep the derivation in sync). Used by the New Board modal for the live
// prefix preview; the server re-derives and finalizes on create.

export const PREFIX_MIN_LEN = 2;
export const PREFIX_MAX_LEN = 5;
export const PREFIX_RE = /^[A-Z0-9]{2,5}$/;

const STOPWORDS = new Set(["THE", "A", "AN", "MY"]);

export const derivePrefix = (title: string): string => {
  const words = title
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((w) => w !== "");
  if (words.length > 1 && STOPWORDS.has(words[0]!)) words.shift();

  const usable = words.filter((w) => w.length >= 2);
  let prefix =
    usable.length >= 2
      ? usable.slice(0, PREFIX_MAX_LEN).map((w) => w[0]!).join("")
      : (usable[0] ?? words.join("")).slice(0, 3);

  if (prefix.length < PREFIX_MIN_LEN) {
    const letters = words.join("");
    prefix = (prefix + letters.slice(prefix.length)).slice(0, PREFIX_MAX_LEN);
  }
  // No title yet → no derivation. UI shows an empty preview until the user
  // types something. Don't invent "XX" as a placeholder — that's a real
  // usable prefix and users were saving boards with it by accident.
  if (prefix.length < PREFIX_MIN_LEN) return "";
  return prefix.slice(0, PREFIX_MAX_LEN);
};
