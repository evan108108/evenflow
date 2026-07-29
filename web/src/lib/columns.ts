// Client mirror of src/columns.ts on the Worker — issue-type + board-column
// vocabulary (phase 17). The server module is the source of truth; keep the
// two files in lockstep when editing either.

export const ISSUE_TYPES = ["task", "feature", "bug", "story", "improvement", "chore"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];
export const DEFAULT_ISSUE_TYPE: IssueType = "task";

export const COLUMN_CATEGORIES = ["todo", "in_progress", "in_review", "done", "blocked"] as const;
export type ColumnCategory = (typeof COLUMN_CATEGORIES)[number];

export const MAX_COLUMNS = 12;
export const COLUMN_NAME_MAX = 30;

export interface Column {
  /** Stable identity (UUID) — survives renames; Issue.column_id points here. */
  readonly id: string;
  /** Display name, 1-30 chars, editable. */
  readonly name: string;
  /** 0-based contiguous position. */
  readonly order: number;
  /** Hide-without-delete: disabled columns keep their issues but don't render. */
  readonly enabled: boolean;
  readonly category: ColumnCategory;
}

/** Dropdown labels for the five fixed categories. */
export const CATEGORY_LABELS: Record<ColumnCategory, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  blocked: "Blocked",
};

/** `Type: Feature` etc — the badge hover text. */
export const typeLabel = (type: IssueType): string =>
  type.charAt(0).toUpperCase() + type.slice(1);

/** The stock four-column set (mirrors the server's board-create default). */
export const defaultColumnsTemplate = (mintId: () => string): Column[] =>
  (
    [
      ["Todo", "todo"],
      ["In Progress", "in_progress"],
      ["In Review", "in_review"],
      ["Done", "done"],
    ] as const
  ).map(([name, category], order) => ({ id: mintId(), name, order, enabled: true, category }));

/** Enabled columns in display order — what Kanban renders. */
export const enabledColumns = (columns: ReadonlyArray<Column>): Column[] =>
  columns.filter((c) => c.enabled).sort((a, b) => a.order - b.order);

export const columnById = (
  columns: ReadonlyArray<Column>,
  id: string,
): Column | undefined => columns.find((c) => c.id === id);

/** Status-name set of the board's done-category columns (velocity name-match). */
export const doneNames = (columns: ReadonlyArray<Column>): Set<string> =>
  new Set(columns.filter((c) => c.category === "done").map((c) => c.name));
