// Canonical wire shapes for Evenflow resources.
//
// D1 cache rows are not wire-safe as-is: JSON columns come back as strings
// and booleans as 0/1. The parse*Row functions are the single seam that
// converts a raw cache row into the shape every handler returns. They
// validate defensively — a malformed row means the cache itself is corrupt,
// which should never happen at runtime, so they throw their shape error
// (surfacing as a 500 defect) rather than returning a partial object.

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
  // Short-id prefix (FLOW) + the next unclaimed issue number. Nullable only
  // for rows that predate migration 0003's backfill; the create path derives
  // and persists a prefix on first use.
  readonly issue_prefix: string | null;
  readonly next_issue_number: number;
  // Owning org (orgCache.id). Nullable only for rows that predate migration
  // 0004's backfill; the create path always sets it.
  readonly org_id: string | null;
  readonly visibility: "private" | "public";
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

/** Mirrors orgCache (projection of kind:30520 org declarations). */
export interface OrgShape {
  readonly id: string;
  readonly slug: string;
  readonly display_name: string;
  readonly avatar_url: string | null;
  readonly bio: string | null;
  readonly kind: "personal" | "team";
  readonly created_by: string;
  readonly substrate_event_id: string | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly deleted_at_ms: number | null;
}

/** Mirrors inviteCache (D1-authoritative invite links + email invites). */
export interface InviteShape {
  readonly id: string;
  readonly code: string;
  readonly org_id: string;
  readonly board_id: string | null;
  readonly role: string;
  readonly invited_by: string;
  readonly invited_email: string | null;
  readonly bind_to_email: boolean;
  readonly expires_at_ms: number;
  readonly single_use: boolean;
  readonly used_by: string | null;
  readonly used_at_ms: number | null;
  readonly revoked_at_ms: number | null;
  readonly declined_at_ms: number | null;
  readonly created_at_ms: number;
}

/** Mirrors orgMemberCache / boardMemberCache rows (kind:30521 projections). */
export interface MemberShape {
  readonly pubkey: string;
  readonly role: string;
  readonly added_by: string;
  readonly added_at_ms: number;
  readonly substrate_event_id: string | null;
}

/** Mirrors issueCache (soft-FK projection of kind:30551 fa:KanbanIssue). */
export interface IssueShape {
  readonly id: string;
  // FLOW-42 — null only for rows awaiting the 0003 backfill.
  readonly short_id: string | null;
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

/** Mirrors commentCache (soft-FK projection of kind:30552 fa:KanbanComment). */
export interface CommentShape {
  readonly id: string;
  readonly issue_id: string;
  readonly author_pubkey: string;
  readonly body: string;
  readonly in_reply_to: string | null;
  readonly created_at_ms: number;
}

/** Mirrors statusChangeCache (kind:30553 fa:KanbanStatusChange) — feed rows. */
export interface StatusChangeShape {
  readonly id: string;
  readonly issue_id: string;
  readonly board_id: string;
  readonly actor_pubkey: string;
  readonly from_status: string | null;
  readonly to_status: string | null;
  readonly from_container: string | null;
  readonly to_container: string | null;
  readonly container_at_completion: string | null;
  readonly occurred_at_ms: number;
}

export class BoardShapeError extends Error {
  readonly _tag = "BoardShapeError";
  constructor(readonly reason: string) {
    super(`malformed boardCache row: ${reason}`);
    this.name = "BoardShapeError";
  }
}

export class IssueShapeError extends Error {
  readonly _tag = "IssueShapeError";
  constructor(readonly reason: string) {
    super(`malformed issueCache row: ${reason}`);
    this.name = "IssueShapeError";
  }
}

export class CommentShapeError extends Error {
  readonly _tag = "CommentShapeError";
  constructor(readonly reason: string) {
    super(`malformed commentCache row: ${reason}`);
    this.name = "CommentShapeError";
  }
}

export class StatusChangeShapeError extends Error {
  readonly _tag = "StatusChangeShapeError";
  constructor(readonly reason: string) {
    super(`malformed statusChangeCache row: ${reason}`);
    this.name = "StatusChangeShapeError";
  }
}

export class OrgShapeError extends Error {
  readonly _tag = "OrgShapeError";
  constructor(readonly reason: string) {
    super(`malformed orgCache row: ${reason}`);
    this.name = "OrgShapeError";
  }
}

export class InviteShapeError extends Error {
  readonly _tag = "InviteShapeError";
  constructor(readonly reason: string) {
    super(`malformed inviteCache row: ${reason}`);
    this.name = "InviteShapeError";
  }
}

export class MemberShapeError extends Error {
  readonly _tag = "MemberShapeError";
  constructor(readonly reason: string) {
    super(`malformed member cache row: ${reason}`);
    this.name = "MemberShapeError";
  }
}

export const CONTAINERS = ["icebox", "backlog", "active"] as const;
export type Container = (typeof CONTAINERS)[number];

// ── shared field helpers, parameterized by the shape's error class ────────

type Raise = (reason: string) => never;

const makeHelpers = (raise: Raise) => ({
  object: (row: unknown): Record<string, unknown> => {
    if (typeof row !== "object" || row === null) raise("row not an object");
    return row as Record<string, unknown>;
  },
  string: (v: unknown, column: string): string => {
    if (typeof v !== "string") raise(`${column} not a string`);
    return v as string;
  },
  stringOrNull: (v: unknown, column: string): string | null => {
    if (v === null) return null;
    if (typeof v !== "string") raise(`${column} not a string`);
    return v as string;
  },
  number: (v: unknown, column: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) raise(`${column} not a number`);
    return v as number;
  },
  numberOrNull: (v: unknown, column: string): number | null => {
    if (v === null) return null;
    if (typeof v !== "number" || !Number.isFinite(v)) raise(`${column} not a number`);
    return v as number;
  },
  json: (v: unknown, column: string): unknown => {
    if (typeof v !== "string") raise(`${column} not a string`);
    try {
      return JSON.parse(v as string);
    } catch {
      raise(`${column} not valid JSON`);
    }
  },
});

// ── boardCache ────────────────────────────────────────────────────────────

/** Convert a raw D1 boardCache row into the canonical wire shape. */
export const parseBoardRow = (row: unknown): BoardShape => {
  const raise: Raise = (reason) => {
    throw new BoardShapeError(reason);
  };
  const h = makeHelpers(raise);
  const r = h.object(row);

  const description = r["description"] === null ? null : h.json(r["description"], "description");
  if (description !== null && typeof description !== "string") raise("description not a string");

  const columns = h.json(r["columns"], "columns");
  if (!Array.isArray(columns) || columns.some((c) => typeof c !== "string")) {
    raise("columns not a string array");
  }

  const labels = h.json(r["labels"], "labels");
  if (!Array.isArray(labels)) raise("labels not an array");

  // Pre-0004 rows default to private; the column has NOT NULL DEFAULT.
  const visibility = h.string(r["visibility"] ?? "private", "visibility");
  if (visibility !== "private" && visibility !== "public") raise("visibility not a visibility");

  return {
    id: h.string(r["id"], "id"),
    pubkey: h.string(r["pubkey"], "pubkey"),
    slug: h.string(r["slug"], "slug"),
    title: h.string(r["title"], "title"),
    description: description as string | null,
    columns: columns as ReadonlyArray<string>,
    labels: labels as ReadonlyArray<unknown>,
    member_policy: h.string(r["member_policy"], "member_policy"),
    is_encrypted: h.number(r["is_encrypted"], "is_encrypted") !== 0,
    issue_prefix: h.stringOrNull(r["issue_prefix"] ?? null, "issue_prefix"),
    next_issue_number: h.number(r["next_issue_number"] ?? 1, "next_issue_number"),
    org_id: h.stringOrNull(r["org_id"] ?? null, "org_id"),
    visibility: visibility as "private" | "public",
    created_at_ms: h.number(r["created_at_ms"], "created_at_ms"),
    updated_at_ms: h.number(r["updated_at_ms"], "updated_at_ms"),
  };
};

// ── issueCache ────────────────────────────────────────────────────────────

/** Convert a raw D1 issueCache row into the canonical wire shape. */
export const parseIssueRow = (row: unknown): IssueShape => {
  const raise: Raise = (reason) => {
    throw new IssueShapeError(reason);
  };
  const h = makeHelpers(raise);
  const r = h.object(row);

  const container = h.string(r["container"], "container");
  if (!(CONTAINERS as ReadonlyArray<string>).includes(container)) raise("container not a container");

  const labels = h.json(r["labels"], "labels");
  if (!Array.isArray(labels) || labels.some((l) => typeof l !== "string")) {
    raise("labels not a string array");
  }

  const github_links = h.json(r["github_links"], "github_links");
  if (
    !Array.isArray(github_links) ||
    github_links.some(
      (g) =>
        typeof g !== "object" ||
        g === null ||
        typeof (g as Record<string, unknown>)["repo"] !== "string" ||
        typeof (g as Record<string, unknown>)["pr"] !== "number" ||
        typeof (g as Record<string, unknown>)["state"] !== "string",
    )
  ) {
    raise("github_links malformed");
  }

  return {
    id: h.string(r["id"], "id"),
    short_id: h.stringOrNull(r["short_id"] ?? null, "short_id"),
    board_id: h.string(r["board_id"], "board_id"),
    title: h.string(r["title"], "title"),
    body: h.stringOrNull(r["body"], "body"),
    status: h.string(r["status"], "status"),
    container: container as Container,
    assignee_pubkey: h.stringOrNull(r["assignee_pubkey"], "assignee_pubkey"),
    priority: h.numberOrNull(r["priority"], "priority"),
    estimate: h.numberOrNull(r["estimate"], "estimate"),
    labels: labels as ReadonlyArray<string>,
    github_links: github_links as IssueShape["github_links"],
    created_at_ms: h.number(r["created_at_ms"], "created_at_ms"),
    updated_at_ms: h.number(r["updated_at_ms"], "updated_at_ms"),
    completed_at_ms: h.numberOrNull(r["completed_at_ms"], "completed_at_ms"),
  };
};

// ── commentCache ──────────────────────────────────────────────────────────

/** Convert a raw D1 commentCache row into the canonical wire shape. */
export const parseCommentRow = (row: unknown): CommentShape => {
  const raise: Raise = (reason) => {
    throw new CommentShapeError(reason);
  };
  const h = makeHelpers(raise);
  const r = h.object(row);
  return {
    id: h.string(r["id"], "id"),
    issue_id: h.string(r["issue_id"], "issue_id"),
    author_pubkey: h.string(r["author_pubkey"], "author_pubkey"),
    body: h.string(r["body"], "body"),
    in_reply_to: h.stringOrNull(r["in_reply_to"], "in_reply_to"),
    created_at_ms: h.number(r["created_at_ms"], "created_at_ms"),
  };
};

// ── statusChangeCache ─────────────────────────────────────────────────────

/** Convert a raw D1 statusChangeCache row into the canonical wire shape. */
export const parseStatusChangeRow = (row: unknown): StatusChangeShape => {
  const raise: Raise = (reason) => {
    throw new StatusChangeShapeError(reason);
  };
  const h = makeHelpers(raise);
  const r = h.object(row);
  return {
    id: h.string(r["id"], "id"),
    issue_id: h.string(r["issue_id"], "issue_id"),
    board_id: h.string(r["board_id"], "board_id"),
    actor_pubkey: h.string(r["actor_pubkey"], "actor_pubkey"),
    from_status: h.stringOrNull(r["from_status"], "from_status"),
    to_status: h.stringOrNull(r["to_status"], "to_status"),
    from_container: h.stringOrNull(r["from_container"], "from_container"),
    to_container: h.stringOrNull(r["to_container"], "to_container"),
    container_at_completion: h.stringOrNull(r["container_at_completion"], "container_at_completion"),
    occurred_at_ms: h.number(r["occurred_at_ms"], "occurred_at_ms"),
  };
};

// ── orgCache ──────────────────────────────────────────────────────────────

/** Convert a raw D1 orgCache row into the canonical wire shape. */
export const parseOrgRow = (row: unknown): OrgShape => {
  const raise: Raise = (reason) => {
    throw new OrgShapeError(reason);
  };
  const h = makeHelpers(raise);
  const r = h.object(row);

  const kind = h.string(r["kind"], "kind");
  if (kind !== "personal" && kind !== "team") raise("kind not an org kind");

  return {
    id: h.string(r["id"], "id"),
    slug: h.string(r["slug"], "slug"),
    display_name: h.string(r["display_name"], "display_name"),
    avatar_url: h.stringOrNull(r["avatar_url"], "avatar_url"),
    bio: h.stringOrNull(r["bio"], "bio"),
    kind: kind as "personal" | "team",
    created_by: h.string(r["created_by"], "created_by"),
    substrate_event_id: h.stringOrNull(r["substrate_event_id"], "substrate_event_id"),
    created_at_ms: h.number(r["created_at_ms"], "created_at_ms"),
    updated_at_ms: h.number(r["updated_at_ms"], "updated_at_ms"),
    deleted_at_ms: h.numberOrNull(r["deleted_at_ms"], "deleted_at_ms"),
  };
};

// ── inviteCache ───────────────────────────────────────────────────────────

/** Convert a raw D1 inviteCache row into the canonical wire shape. */
export const parseInviteRow = (row: unknown): InviteShape => {
  const raise: Raise = (reason) => {
    throw new InviteShapeError(reason);
  };
  const h = makeHelpers(raise);
  const r = h.object(row);
  return {
    id: h.string(r["id"], "id"),
    code: h.string(r["code"], "code"),
    org_id: h.string(r["org_id"], "org_id"),
    board_id: h.stringOrNull(r["board_id"], "board_id"),
    role: h.string(r["role"], "role"),
    invited_by: h.string(r["invited_by"], "invited_by"),
    invited_email: h.stringOrNull(r["invited_email"], "invited_email"),
    bind_to_email: h.number(r["bind_to_email"], "bind_to_email") !== 0,
    expires_at_ms: h.number(r["expires_at_ms"], "expires_at_ms"),
    single_use: h.number(r["single_use"], "single_use") !== 0,
    used_by: h.stringOrNull(r["used_by"], "used_by"),
    used_at_ms: h.numberOrNull(r["used_at_ms"], "used_at_ms"),
    revoked_at_ms: h.numberOrNull(r["revoked_at_ms"], "revoked_at_ms"),
    declined_at_ms: h.numberOrNull(r["declined_at_ms"], "declined_at_ms"),
    created_at_ms: h.number(r["created_at_ms"], "created_at_ms"),
  };
};

// ── orgMemberCache / boardMemberCache ─────────────────────────────────────

/** Convert a raw member cache row (either scope) into the wire shape. */
export const parseMemberRow = (row: unknown): MemberShape => {
  const raise: Raise = (reason) => {
    throw new MemberShapeError(reason);
  };
  const h = makeHelpers(raise);
  const r = h.object(row);
  return {
    pubkey: h.string(r["pubkey"], "pubkey"),
    role: h.string(r["role"], "role"),
    added_by: h.string(r["added_by"], "added_by"),
    added_at_ms: h.number(r["added_at_ms"], "added_at_ms"),
    substrate_event_id: h.stringOrNull(r["substrate_event_id"], "substrate_event_id"),
  };
};
