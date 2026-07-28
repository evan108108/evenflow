// Canonical wire shapes for Evenflow resources.
//
// D1 cache rows are not wire-safe as-is: JSON columns come back as strings
// and booleans as 0/1. parseBoardRow is the single seam that converts a raw
// boardCache row into the BoardShape every handler returns. It validates
// defensively — a malformed row means the cache itself is corrupt, which
// should never happen at runtime, so it throws BoardShapeError (surfacing
// as a 500 defect) rather than returning a partial object.

export interface BoardShape {
  readonly id: string;
  readonly pubkey: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string | null;
  readonly columns: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<unknown>;
  readonly member_policy: string;
  readonly is_encrypted: boolean;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

/**
 * Declared now, used by the issues phase. Mirrors issueCache (soft-FK
 * projection of kind:30551 fa:KanbanIssue).
 */
export interface IssueShape {
  readonly id: string;
  readonly board_id: string;
  readonly title: string;
  readonly body: string | null;
  readonly status: string;
  readonly container: "icebox" | "backlog" | "active";
  readonly assignee_pubkey: string | null;
  readonly priority: number | null;
  readonly estimate: number | null;
  readonly labels: ReadonlyArray<string>;
  readonly github_links: ReadonlyArray<{
    readonly repo: string;
    readonly pr: number;
    readonly state: string;
  }>;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly completed_at_ms: number | null;
}

export class BoardShapeError extends Error {
  readonly _tag = "BoardShapeError";
  constructor(readonly reason: string) {
    super(`malformed boardCache row: ${reason}`);
    this.name = "BoardShapeError";
  }
}

const parseJsonColumn = (value: unknown, column: string): unknown => {
  if (typeof value !== "string") throw new BoardShapeError(`${column} not a string`);
  try {
    return JSON.parse(value);
  } catch {
    throw new BoardShapeError(`${column} not valid JSON`);
  }
};

const requireString = (value: unknown, column: string): string => {
  if (typeof value !== "string") throw new BoardShapeError(`${column} not a string`);
  return value;
};

const requireNumber = (value: unknown, column: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BoardShapeError(`${column} not a number`);
  }
  return value;
};

/** Convert a raw D1 boardCache row into the canonical wire shape. */
export const parseBoardRow = (row: unknown): BoardShape => {
  if (typeof row !== "object" || row === null) {
    throw new BoardShapeError("row not an object");
  }
  const r = row as Record<string, unknown>;

  const description =
    r["description"] === null ? null : parseJsonColumn(r["description"], "description");
  if (description !== null && typeof description !== "string") {
    throw new BoardShapeError("description not a string");
  }

  const columns = parseJsonColumn(r["columns"], "columns");
  if (!Array.isArray(columns) || columns.some((c) => typeof c !== "string")) {
    throw new BoardShapeError("columns not a string array");
  }

  const labels = parseJsonColumn(r["labels"], "labels");
  if (!Array.isArray(labels)) throw new BoardShapeError("labels not an array");

  return {
    id: requireString(r["id"], "id"),
    pubkey: requireString(r["pubkey"], "pubkey"),
    slug: requireString(r["slug"], "slug"),
    title: requireString(r["title"], "title"),
    description,
    columns: columns as ReadonlyArray<string>,
    labels,
    member_policy: requireString(r["member_policy"], "member_policy"),
    is_encrypted: requireNumber(r["is_encrypted"], "is_encrypted") !== 0,
    created_at_ms: requireNumber(r["created_at_ms"], "created_at_ms"),
    updated_at_ms: requireNumber(r["updated_at_ms"], "updated_at_ms"),
  };
};
