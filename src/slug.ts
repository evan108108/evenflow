// Short issue identifiers — the FLOW-42 reference system.
//
// Each board owns a 2-5 char uppercase alphanumeric prefix; each issue gets
// '<prefix>-<n>' with n claimed monotonically per board. Prefixes are
// globally unique (idx_issueCache_short_id is a global unique index, so two
// boards sharing FLOW would collide on FLOW-1).
//
// web/src/lib/slug.ts mirrors the derivation for the New Board modal's live
// preview — keep the two in sync.

export const PREFIX_MIN_LEN = 2;
export const PREFIX_MAX_LEN = 5;
export const PREFIX_RE = /^[A-Z0-9]{2,5}$/;
export const SHORT_ID_RE = /^[A-Z0-9]{2,5}-\d+$/;

// Leading articles carry no identity — "The Board" should read BOA, not TB.
const STOPWORDS = new Set(["THE", "A", "AN", "MY"]);

/**
 * Derive a default prefix from a board title. Multi-word titles initialize
 * ("Evan's Flow" → EF, ignoring fragments under 2 chars); single words
 * truncate ("Foo" → FOO). Degenerate titles pad to the minimum with X.
 */
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
  return prefix.slice(0, PREFIX_MAX_LEN).padEnd(PREFIX_MIN_LEN, "X");
};

/** First free prefix: the base itself, else digit-suffixed (FLOW → FLOW2 → FLOW3), trimming the base to stay within PREFIX_MAX_LEN. */
export const uniquePrefix = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const candidate = base.slice(0, PREFIX_MAX_LEN - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
};

/**
 * Normalize a path/argument reference: returns the canonical uppercase
 * short id when the string is one (case-insensitively), else null — in
 * which case the caller treats it as a UUID.
 */
export const asShortId = (ref: string): string | null => {
  const norm = ref.toUpperCase();
  return SHORT_ID_RE.test(norm) ? norm : null;
};
