// Wire shapes returned by the REST API — mirrors src/shapes.ts on the
// Worker (the server parsers are the source of truth; these are the
// client's read-side view of the same JSON).

import type { Column, IssueType } from "./columns";
import type { BodyFormat } from "./attachments";

export type Container = "icebox" | "backlog" | "active";

export interface Board {
  readonly id: string;
  readonly pubkey: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string | null;
  // Structured since phase 17 (schema v5) — see lib/columns.ts.
  readonly columns: ReadonlyArray<Column>;
  readonly labels: ReadonlyArray<unknown>;
  readonly member_policy: string;
  // Privacy is one setting — `visibility` (below). `encryption_active` is
  // derived server-side: visibility is private AND the board's 4a audience
  // has been minted. Optional so pre-0015 payloads still parse.
  readonly encryption_active?: boolean;
  /** @deprecated pre-0015 mirror of `encryption_active`. */
  readonly is_encrypted?: boolean;
  // Phase 16.5 audience state. Optional so pre-16.5 payloads still parse.
  readonly audience_epoch?: number;
  readonly audience_pubkey?: string | null;
  // Short-id prefix (FLOW) + next unclaimed issue number. Prefix is null
  // only for boards that predate the 0003 backfill.
  readonly issue_prefix: string | null;
  readonly next_issue_number: number;
  // Phase 16 org scope. Optional so pre-16 API responses still parse.
  readonly org_id?: string | null;
  readonly visibility?: "private" | "public";
  // Sprint length fallback (migration 0011). Optional so cached pre-0011
  // payloads still parse; absent reads as the historical 14.
  readonly default_sprint_days?: number;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export interface Issue {
  readonly id: string;
  // FLOW-42 — null only for issues awaiting the 0003 backfill.
  readonly short_id: string | null;
  readonly board_id: string;
  readonly title: string;
  readonly body: string | null;
  // 'markdown' since phase 18a; pre-0006 rows stay 'plain' (pre-wrap render).
  readonly body_format: BodyFormat;
  readonly type: IssueType;
  readonly status: string;
  // Stable column reference; status mirrors the column's display name.
  // Null only for issues awaiting the 0005 backfill.
  readonly column_id: string | null;
  readonly container: Container;
  readonly assignee_pubkey: string | null;
  readonly priority: number | null;
  readonly estimate: number | null;
  readonly labels: ReadonlyArray<string>;
  readonly github_links: ReadonlyArray<{ repo: string; pr: number; state: string }>;
  // Intra-column fractional sort key (phase 18d). Null = legacy row —
  // sorts after every positioned row, by updated_at_ms DESC. Optional so
  // pre-18d cached payloads still parse.
  readonly position?: number | null;
  // Owning sprint (phase 20). Null when not in a sprint; optional so
  // pre-20 cached payloads still parse.
  readonly sprint_id?: string | null;
  // GitHub-integration pill (phase 21), INDEPENDENT of column position — a
  // ticket can read "PR in review" while sitting in Todo. Optional so
  // pre-21 cached payloads still parse.
  readonly external_state?: string | null;
  readonly external_state_updated_at_ms?: number | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly completed_at_ms: number | null;
  // List-endpoint enrichment: the image cover's blob URL, when one is set.
  // Optional so single-issue responses (no enrichment) still parse.
  readonly cover_url?: string | null;
}

export interface Comment {
  readonly id: string;
  readonly issue_id: string;
  readonly author_pubkey: string;
  readonly body: string;
  // 'markdown' since phase 18c; pre-0007 rows stay 'plain' (pre-wrap render).
  readonly body_format: import("./attachments").BodyFormat;
  readonly in_reply_to: string | null;
  readonly created_at_ms: number;
  // Comment-owned attachments (phase 18c list enrichment).
  readonly attachments?: ReadonlyArray<import("./attachments").Attachment>;
}

export interface FeedItem {
  readonly id: string;
  readonly issue_id: string;
  readonly issue_title: string | null;
  readonly issue_short_id: string | null;
  readonly actor_pubkey: string;
  readonly kind: "creation" | "status" | "container";
  readonly from: string | null;
  readonly to: string | null;
  readonly container_at_completion: string | null;
  readonly occurred_at_ms: number;
}

export type SprintStatus = "planning" | "active" | "completed";

/** Mirrors SprintShape on the Worker (phase 20). */
export interface Sprint {
  readonly id: string;
  readonly board_id: string;
  readonly name: string;
  readonly goal: string | null;
  readonly status: SprintStatus;
  // Per-sprint length override; null → the board's default_sprint_days.
  // Optional so pre-0011 cached payloads still parse.
  readonly planned_days?: number | null;
  readonly started_at_ms: number | null;
  readonly completed_at_ms: number | null;
  readonly created_at_ms: number;
  // Phase 21b — snapshotted metrics; optional on cached payloads.
  readonly points_committed_start?: number | null;
  readonly points_completed?: number | null;
  readonly points_carried?: number | null;
  readonly adds_mid_sprint?: number;
}

/** Phase 21b: one issue's participation in one sprint (audit trail row). */
export interface SprintMembership {
  readonly membership_id: string;
  readonly issue_id: string;
  readonly added_at_ms: number;
  readonly removed_at_ms: number | null;
  readonly was_completed_in_sprint: boolean;
  readonly carried_to_sprint_id: string | null;
  readonly title: string | null;
  readonly short_id: string | null;
  readonly status: string | null;
  readonly estimate: number | null;
  readonly assignee_pubkey: string | null;
  readonly priority: number | null;
}

export interface SprintArchivePayload {
  readonly sprint: Sprint;
  readonly completed_in_sprint: ReadonlyArray<SprintMembership>;
  readonly carried_over: ReadonlyArray<SprintMembership>;
  readonly dropped: ReadonlyArray<SprintMembership>;
  readonly open: ReadonlyArray<SprintMembership>;
}

/** The three container-move verbs, as REST path suffixes. */
export type ContainerMove = "promote_to_backlog" | "promote_to_active" | "send_to_icebox";

export const CONTAINER_OF_MOVE: Record<ContainerMove, Container> = {
  promote_to_backlog: "backlog",
  promote_to_active: "active",
  send_to_icebox: "icebox",
};

export const MOVE_TO_CONTAINER: Record<Container, ContainerMove> = {
  backlog: "promote_to_backlog",
  active: "promote_to_active",
  icebox: "send_to_icebox",
};
