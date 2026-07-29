// Shared vocabulary for issue types + board columns (phase 17).
//
// Mirrored at web/src/lib/columns.ts — the server parsers here are the
// source of truth; keep the two files in lockstep when editing either.
//
// Columns became structured in migration 0005: boardCache.columns holds a
// JSON Column[] (id/name/order/enabled/category) instead of a bare name
// array. id is the stable identity (survives renames); name is display;
// category is the semantic role — velocity and completed_at_ms key off
// category === "done", never off the literal name "Done".

export const ISSUE_TYPES = ["task", "feature", "bug", "story", "improvement", "chore"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];
export const DEFAULT_ISSUE_TYPE: IssueType = "task";

export const COLUMN_CATEGORIES = ["todo", "in_progress", "in_review", "done", "blocked"] as const;
export type ColumnCategory = (typeof COLUMN_CATEGORIES)[number];

export const MAX_COLUMNS = 12;
export const COLUMN_NAME_MAX = 30;

export interface Column {
  /** Stable identity (UUID) — survives renames; issueCache.column_id points here. */
  readonly id: string;
  /** Display name, 1-30 chars, editable. */
  readonly name: string;
  /** 0-based contiguous position. */
  readonly order: number;
  /** Hide-without-delete: disabled columns keep their issues but don't render. */
  readonly enabled: boolean;
  readonly category: ColumnCategory;
}

// ── category inference (board create with string[], 0005 backfill) ────────

/** Case-insensitive substring rules, first match wins; fallback "todo". */
const CATEGORY_RULES: ReadonlyArray<readonly [ColumnCategory, ReadonlyArray<string>]> = [
  ["todo", ["todo", "backlog"]],
  ["in_progress", ["progress", "doing", "wip"]],
  ["in_review", ["review", "pr", "qa"]],
  ["done", ["done", "shipped", "completed", "closed", "finished"]],
  ["blocked", ["blocked", "stuck", "waiting"]],
];

export const inferCategory = (name: string): ColumnCategory => {
  const lower = name.toLowerCase();
  for (const [category, needles] of CATEGORY_RULES) {
    if (needles.some((n) => lower.includes(n))) return category;
  }
  return "todo";
};

/** Coerce a legacy string[] column list into Column[] (backwards compat). */
export const coerceStringColumns = (
  names: ReadonlyArray<string>,
  mintId: () => string,
): Column[] =>
  names.map((name, order) => ({
    id: mintId(),
    name,
    order,
    enabled: true,
    category: inferCategory(name),
  }));

export const DEFAULT_COLUMN_NAMES = ["Todo", "In Progress", "In Review", "Done"] as const;

/** The board-create default: Todo / In Progress / In Review / Done. */
export const defaultColumns = (mintId: () => string): Column[] =>
  coerceStringColumns(DEFAULT_COLUMN_NAMES, mintId);

// ── validation (boards router, 0005 backfill sanity) ──────────────────────

/**
 * Validate a client-supplied Column[] against the full rule matrix. Returns
 * a rejection reason (validators surface it as `columns-<reason>`) or null
 * when the array is well-formed.
 */
export const columnArrayProblem = (v: unknown): string | null => {
  if (!Array.isArray(v) || v.length < 1) return "shape";
  if (v.length > MAX_COLUMNS) return "too-many";
  for (const c of v) {
    if (typeof c !== "object" || c === null) return "shape";
    const col = c as Record<string, unknown>;
    if (typeof col["id"] !== "string" || col["id"] === "") return "id";
    if (
      typeof col["name"] !== "string" ||
      col["name"].trim() === "" ||
      col["name"].length > COLUMN_NAME_MAX
    ) {
      return "name";
    }
    if (typeof col["order"] !== "number" || !Number.isInteger(col["order"])) return "order";
    if (typeof col["enabled"] !== "boolean") return "enabled";
    if (!(COLUMN_CATEGORIES as ReadonlyArray<string>).includes(col["category"] as string)) {
      return "category";
    }
  }
  const cols = v as Column[];
  if (!cols.some((c) => c.enabled)) return "none-enabled";
  if (new Set(cols.map((c) => c.id)).size !== cols.length) return "id-duplicate";
  const enabledNames = cols.filter((c) => c.enabled).map((c) => c.name.toLowerCase());
  if (new Set(enabledNames).size !== enabledNames.length) return "name-duplicate";
  const orders = [...cols.map((c) => c.order)].sort((a, b) => a - b);
  if (orders.some((o, i) => o !== i)) return "order-not-contiguous";
  return null;
};

// ── lookups ───────────────────────────────────────────────────────────────

/** Enabled columns in display order — what Kanban renders. */
export const enabledColumns = (columns: ReadonlyArray<Column>): Column[] =>
  columns.filter((c) => c.enabled).sort((a, b) => a.order - b.order);

export const columnById = (
  columns: ReadonlyArray<Column>,
  id: string,
): Column | undefined => columns.find((c) => c.id === id);

/**
 * Resolve a status NAME to a column (exact match, enabled preferred —
 * a disabled column may share a name with an enabled one).
 */
export const columnByName = (
  columns: ReadonlyArray<Column>,
  name: string,
): Column | undefined =>
  columns.find((c) => c.enabled && c.name === name) ?? columns.find((c) => c.name === name);

/** Does this status name land in a done-category column? (velocity, completed_at_ms) */
export const isDoneStatus = (columns: ReadonlyArray<Column>, statusName: string): boolean =>
  columnByName(columns, statusName)?.category === "done";
