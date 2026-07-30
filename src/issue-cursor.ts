// Keyset cursors for the paged board streams (phase 22).
//
// Two orderings, one cursor discipline. A cursor encodes the FULL sort key
// of the last row on a page, so the next page is a seek rather than an
// offset — offsets skip and duplicate rows the moment anything above the
// window moves, and a kanban board is a surface people drag on.
//
// Why the sort key is a TUPLE, not just `position`:
//
//   Legacy pre-18d rows carry position IS NULL and sort last. A scalar
//   predicate cannot page past them — `position > NULL` is NULL, which is
//   not true, so the NULL tail becomes unreachable. That is the same
//   silently-truncated-list bug this whole phase exists to remove, merely
//   relocated to the oldest rows. So the key is (is_null, position, id)
//   and the ORDER BY names the same three parts.
//
// Why an ENCODED cursor rather than "pass the last issue id and look it
// up": the anchor row can be dragged to a new position, or deleted, between
// one page and the next. Looking it up then yields a moved cursor (skipped
// or duplicated cards) or a hard 404. Encoding the key freezes it — the
// cursor keeps describing the same *point in the ordering* even if the row
// that produced it is gone.

export type StreamKind = "position" | "recency";

/** The frozen sort key of the last row of a page. */
export interface IssueCursor {
  readonly kind: StreamKind;
  /** position-stream: 0 for a real position, 1 for the NULL tail. */
  readonly isNull: 0 | 1;
  /** position-stream: the fractional position. recency: updated_at_ms. */
  readonly value: number;
  readonly id: string;
}

const b64encode = (s: string): string =>
  btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64decode = (s: string): string | null => {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  } catch {
    return null;
  }
};

/**
 * `["p",0,12.5,"<id>"]`, base64url-wrapped.
 *
 * A JSON tuple rather than a delimited string on purpose: `position` is
 * FRACTIONAL, so a dot-delimited encoding splits `12.5` down the middle and
 * silently yields a wrong-but-parseable cursor — which pages from the wrong
 * point instead of erroring, i.e. an infinite scroll that never advances.
 * Issue ids are equally free to contain any delimiter we might pick.
 */
export const encodeCursor = (c: IssueCursor): string =>
  b64encode(JSON.stringify([c.kind === "position" ? "p" : "r", c.isNull, c.value, c.id]));

/**
 * Decode a cursor. Null on anything malformed — callers surface that as a
 * 400 rather than silently restarting the stream from the top, which would
 * loop an infinite scroll forever.
 */
export const decodeCursor = (raw: string): IssueCursor | null => {
  const plain = b64decode(raw);
  if (plain === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) return null;
  const [kindTag, isNullRaw, value, id] = parsed as [unknown, unknown, unknown, unknown];
  if (kindTag !== "p" && kindTag !== "r") return null;
  if (isNullRaw !== 0 && isNullRaw !== 1) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (typeof id !== "string" || id === "") return null;
  return {
    kind: kindTag === "p" ? "position" : "recency",
    isNull: isNullRaw === 1 ? 1 : 0,
    value,
    id,
  };
};

/** The ORDER BY for a stream. Must stay in lockstep with cursorPredicate. */
export const orderByFor = (kind: StreamKind): string =>
  kind === "position"
    ? "ORDER BY (position IS NULL) ASC, position ASC, id DESC"
    : "ORDER BY updated_at_ms DESC, id DESC";

/**
 * The keyset predicate selecting rows strictly AFTER the cursor in the
 * stream's order, plus its bound params.
 *
 * position-stream is ASC, so "after" means `>` — the direction the brief's
 * draft SQL had backwards, which would have paged away from the tail and
 * stalled the scroll on page one. The id tiebreak is DESC in both streams,
 * so it is always `<`.
 *
 * `COALESCE(position, 0)` only ever applies inside a branch where the
 * is-null flag already matched, so it compares like with like.
 */
export const cursorPredicate = (
  c: IssueCursor,
): { sql: string; params: unknown[] } => {
  if (c.kind === "position") {
    return {
      sql:
        " AND ((position IS NULL) > ?" +
        " OR ((position IS NULL) = ? AND COALESCE(position, 0) > ?)" +
        " OR ((position IS NULL) = ? AND COALESCE(position, 0) = ? AND id < ?))",
      params: [c.isNull, c.isNull, c.value, c.isNull, c.value, c.id],
    };
  }
  return {
    sql: " AND (updated_at_ms < ? OR (updated_at_ms = ? AND id < ?))",
    params: [c.value, c.value, c.id],
  };
};

/** Freeze the sort key of the last row on a page into the next cursor. */
export const cursorOf = (
  kind: StreamKind,
  row: { id: string; position: number | null; updated_at_ms: number },
): IssueCursor =>
  kind === "position"
    ? {
        kind,
        isNull: row.position === null ? 1 : 0,
        value: row.position ?? 0,
        id: row.id,
      }
    : { kind, isNull: 0, value: row.updated_at_ms, id: row.id };
