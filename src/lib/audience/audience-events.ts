// Local builders for 4A v0.5 audience event templates.
//
// Mirrors gateway/src/lib/audience-events.ts (the v0.5 SPEC implementation),
// restated locally so the plugin can compile without a cross-repo import.
// Drift here = silent on-wire incompatibility, so any change must round-trip
// through the gateway's parser. The handful of builders we need:
//
//   kind:30520  — buildAudienceDeclaration  (room.create)
//   kind:30521  — buildKeyGrant             (room.create founding grant)
//   kind:30522  — buildAudienceClaim        (room.join)
//
// Encrypted-variant rumor builder (kinds 30530-30536) lives in
// `actions/util.ts`'s `buildSignedRumor` since it's tightly coupled to
// gift-wrap + room context.

import type { Provenance } from "../route-body";
import { blake3ContentTag } from "./blake3-tag";

export const FA_CONTEXT_V0 = "https://4a4.ai/ns/v0";
export const KIND_AUDIENCE = 30520;
export const KIND_KEYGRANT = 30521;
export const KIND_CLAIM = 30522;
/** Public sprint-tide snapshot (EFB-22). Encrypted variant is 30565, in audiences.ts. */
export const KIND_SPRINT_TIDE = 30560;

// ── plaintext kanban kinds (EFB-24) ───────────────────────────────────────
//
// The public half of the board vocabulary. Each has an encrypted counterpart
// at +5 (30555-30557, in audiences.ts) used when a board's audience is live;
// a board publishes through exactly one of the two, never both.
//
// All five are parameterized-replaceable (NIP-01 30000-39999), so the `d` tag
// is the entity's identity and a republish CORRECTS the entity rather than
// appending to it. That is the property that makes the *Cache tables
// reconstructible by replay, which is the whole point of the ticket: content
// therefore carries the entity's current state, not the delta that produced
// it. The one exception is KanbanStatusChange, which is an append-only audit
// record whose identity is the change itself.
export const KIND_KANBAN_BOARD = 30550;
export const KIND_KANBAN_ISSUE = 30551;
export const KIND_KANBAN_COMMENT = 30552;
export const KIND_KANBAN_STATUS_CHANGE = 30553;
export const KIND_KANBAN_SPRINT = 30554;

export interface EventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export interface BuildAudienceDeclarationInput {
  audIdPub: string;
  slug: string;
  name: string;
  description?: string;
  epoch: number;
  epochPub: string;
  members: string[];
  pending?: { invitePub: string; expirationUnix: number }[];
  expiration?: number;
  createdAt?: number;
  /**
   * Room lifecycle status (sonata-studio-room-lifecycle.md §4.1). Absence
   * means "active"; only "closed" carries a wire-level effect. Founders
   * close the room by republishing with status="closed".
   */
  status?: "active" | "closed";
  /** Unix-seconds when the founder closed the room. Required if status="closed". */
  closedAt?: number;
}

export function buildAudienceDeclaration(
  input: BuildAudienceDeclarationInput,
): EventTemplate {
  const memberCount = input.members.length;
  const isClosed = input.status === "closed";
  const altSummary = `Audience: ${input.slug} (${memberCount} member${memberCount === 1 ? "" : "s"}, epoch ${input.epoch}${isClosed ? ", closed" : ""})`;
  const tags: string[][] = [
    ["d", input.slug],
    ["fa:context", FA_CONTEXT_V0],
    ["alt", altSummary],
    ["fa:epoch", String(input.epoch)],
    ["fa:epoch-pubkey", input.epochPub],
  ];
  if (isClosed) {
    tags.push(["fa:status", "closed"]);
    const closedAt =
      typeof input.closedAt === "number" && input.closedAt > 0
        ? input.closedAt
        : nowSec();
    tags.push(["fa:closed-at", String(closedAt)]);
  }
  for (const m of input.members) tags.push(["p", m]);
  for (const p of input.pending ?? []) {
    tags.push(["fa:pending", `${p.invitePub}:${p.expirationUnix}`]);
  }
  if (input.expiration !== undefined) {
    tags.push(["expiration", String(input.expiration)]);
  }
  const contentObj: Record<string, unknown> = {
    "@context": FA_CONTEXT_V0,
    "@type": "Audience",
    name: input.name,
    epoch: input.epoch,
  };
  if (input.description !== undefined) contentObj.description = input.description;
  return {
    kind: KIND_AUDIENCE,
    created_at: input.createdAt ?? nowSec(),
    tags,
    content: JSON.stringify(contentObj),
  };
}

export interface BuildKeyGrantInput {
  audIdPub: string;
  slug: string;
  epoch: number;
  recipientPub: string;
  /** NIP-44 v2 ciphertext of the bare 32-byte epoch private key. */
  ciphertext: string;
  createdAt?: number;
}

export function buildKeyGrant(input: BuildKeyGrantInput): EventTemplate {
  const aTag = `${KIND_AUDIENCE}:${input.audIdPub}:${input.slug}`;
  const dTag = `${input.slug}:${input.epoch}:${input.recipientPub}`;
  return {
    kind: KIND_KEYGRANT,
    created_at: input.createdAt ?? nowSec(),
    tags: [
      ["d", dTag],
      ["fa:context", FA_CONTEXT_V0],
      ["alt", `KeyGrant: ${input.slug} epoch ${input.epoch}`],
      ["a", aTag],
      ["fa:epoch", String(input.epoch)],
      ["p", input.recipientPub],
    ],
    content: input.ciphertext,
  };
}

/**
 * Optional profile preview embedded in a claim. Avatar is deliberately
 * excluded at claim-time: the joiner has no room-epoch key yet, so it
 * can't encrypt to the room's Blossom server, and using a public Blossom
 * would defeat audience-level privacy. Nickname + bio are exposed in
 * plain JSON because anyone holding the invite URL can read the claim
 * content — joiner is opting into that visibility by attaching a profile.
 * Avatar lands ~2s after admit via the auto-publish `_profile` card.
 */
export interface ClaimProfile {
  nickname?: string;
  bio?: string;
}

export interface BuildAudienceClaimInput {
  audIdPub: string;
  slug: string;
  epoch: number;
  invitePub: string;
  inviterPub: string;
  claimPub: string;
  note?: string;
  expiration?: number;
  createdAt?: number;
  /**
   * Optional profile preview the joiner volunteers so the founder can
   * recognize them in the admit dialog before clicking Admit. See
   * `ClaimProfile` for the visibility tradeoff — anyone with the invite
   * URL can read this; only attach if you're OK with that.
   */
  profile?: ClaimProfile;
  /**
   * Claim flavor. Absence (or "active") emits a join claim addressable by
   * invite_pub. "left" emits the self-removal claim per
   * sonata-studio-room-lifecycle.md §4.2 — d-tag becomes
   * `<slug>:<epoch>:left:<claimPub>`, the inviter `p` tag is omitted, the
   * profile preview is dropped (irrelevant for leave), and the JSON-LD
   * body carries `status: "left"`.
   */
  status?: "active" | "left";
}

export function buildAudienceClaim(input: BuildAudienceClaimInput): EventTemplate {
  const aTag = `${KIND_AUDIENCE}:${input.audIdPub}:${input.slug}`;
  const isLeave = input.status === "left";
  const dTag = isLeave
    ? `${input.slug}:${input.epoch}:left:${input.claimPub}`
    : `${input.slug}:${input.epoch}:${input.invitePub}`;
  const tags: string[][] = [
    ["d", dTag],
    ["fa:context", FA_CONTEXT_V0],
    ["alt", isLeave
      ? `leave audience ${input.slug} epoch ${input.epoch}`
      : `claim audience ${input.slug} epoch ${input.epoch}`],
    ["a", aTag],
    ["fa:epoch", String(input.epoch)],
  ];
  if (!isLeave) tags.push(["p", input.inviterPub]);
  tags.push(["fa:claim-pubkey", input.claimPub]);
  if (isLeave) tags.push(["fa:status", "left"]);
  if (input.expiration !== undefined) {
    tags.push(["expiration", String(input.expiration)]);
  }
  const contentObj: Record<string, unknown> = {
    "@context": FA_CONTEXT_V0,
    "@type": "AudienceClaim",
    audience: input.slug,
    epoch: input.epoch,
    claimPubkey: input.claimPub,
  };
  if (isLeave) contentObj.status = "left";
  if (input.note !== undefined) contentObj.note = input.note;
  if (!isLeave && input.profile !== undefined) {
    const cleaned: Record<string, string> = {};
    if (typeof input.profile.nickname === "string" && input.profile.nickname.trim().length > 0) {
      cleaned.nickname = input.profile.nickname.trim().slice(0, 200);
    }
    if (typeof input.profile.bio === "string" && input.profile.bio.trim().length > 0) {
      cleaned.bio = input.profile.bio.trim().slice(0, 500);
    }
    if (Object.keys(cleaned).length > 0) {
      contentObj.profile = cleaned;
    }
  }
  return {
    kind: KIND_CLAIM,
    created_at: input.createdAt ?? nowSec(),
    tags,
    content: JSON.stringify(contentObj),
  };
}

/**
 * Best-effort parse of the `profile` field from a serialized claim event's
 * content. Tolerates malformed JSON, missing fields, and non-string values.
 * Returns null when no parseable profile is present so callers can keep
 * the pre-existing "no preview, just pubkey" UI for old claims.
 */
export function parseClaimProfile(content: string | undefined | null): ClaimProfile | null {
  if (typeof content !== "string" || content.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const raw = obj["profile"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const out: ClaimProfile = {};
  if (typeof rec["nickname"] === "string") {
    const t = (rec["nickname"] as string).trim();
    if (t.length > 0) out.nickname = t.slice(0, 200);
  }
  if (typeof rec["bio"] === "string") {
    const t = (rec["bio"] as string).trim();
    if (t.length > 0) out.bio = t.slice(0, 500);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * One day's tide reading for a sprint, or for a whole board when the team
 * runs kanban-only (no sprint — `sprintId` omitted, `doneWindowDays` acting
 * as the virtual sprint).
 *
 * Parameterized-replaceable on (subject, day): recomputing a day republishes
 * over the previous reading rather than appending, so a late estimate change
 * corrects history instead of duplicating it. That is why `day` is in the
 * `d` tag and not only in `fa:day` — drop it and every snapshot for a sprint
 * collapses onto one event.
 */
export interface BuildSprintTideInput {
  /** Absent for the kanban-only variant; then `boardId` is the subject. */
  sprintId?: string;
  boardId: string;
  /** UTC calendar day this reading closes, `YYYY-MM-DD`. */
  day: string;
  committedPts: number;
  donePts: number;
  remainingPts: number;
  addsToday: number;
  dropsToday: number;
  createdAt?: number;
}

export function buildSprintTide(input: BuildSprintTideInput): EventTemplate {
  const subject = input.sprintId ?? input.boardId;
  const scope = input.sprintId === undefined ? "board" : "sprint";
  const content = JSON.stringify({
    "@context": FA_CONTEXT_V0,
    "@type": "KanbanTideSnapshot",
    committed_pts: input.committedPts,
    done_pts: input.donePts,
    remaining_pts: input.remainingPts,
    adds_today: input.addsToday,
    drops_today: input.dropsToday,
  });
  const tags: string[][] = [
    ["d", `${subject}:${input.day}`],
    ["fa:context", FA_CONTEXT_V0],
    ["alt", `Tide ${input.day}: ${input.remainingPts} of ${input.committedPts} pts remaining`],
    ["blake3", blake3ContentTag(content)],
    ["fa:board", input.boardId],
    ["fa:day", input.day],
    ["fa:scope", scope],
  ];
  if (input.sprintId !== undefined) tags.push(["fa:sprint", input.sprintId]);
  return {
    kind: KIND_SPRINT_TIDE,
    created_at: input.createdAt ?? nowSec(),
    tags,
    content,
  };
}

// ── plaintext kanban builders (EFB-24) ────────────────────────────────────
//
// Every builder here follows buildSprintTide's shape exactly: a `d` tag
// carrying the entity id, `fa:context`, a human `alt`, the `blake3` content
// tag, `fa:board`, then kind-specific `fa:` tags. The gateway's validators
// pin this shape against golden events captured from these functions, so a
// change on either side that isn't mirrored fails the cross-repo test rather
// than silently going out on the wire.
//
// `deleted` is a flag rather than a NIP-09 deletion request: these are
// replaceable events, so the tombstone must occupy the same address as the
// row it retires, or a replaying consumer resurrects a deleted issue from the
// last surviving version.

export interface BuildKanbanBoardInput {
  boardId: string;
  slug: string;
  title: string;
  description?: string | null;
  orgId?: string | null;
  issuePrefix?: string | null;
  defaultSprintDays: number;
  doneWindowDays: number;
  columns: ReadonlyArray<unknown>;
  labels: ReadonlyArray<unknown>;
  memberPolicy: string;
  archived?: boolean;
  deleted?: boolean;
  createdAt?: number;
}

export function buildKanbanBoard(input: BuildKanbanBoardInput): EventTemplate {
  const content = JSON.stringify({
    "@context": FA_CONTEXT_V0,
    "@type": "KanbanBoard",
    slug: input.slug,
    title: input.title,
    description: input.description ?? null,
    org_id: input.orgId ?? null,
    issue_prefix: input.issuePrefix ?? null,
    default_sprint_days: input.defaultSprintDays,
    done_window_days: input.doneWindowDays,
    columns: input.columns,
    labels: input.labels,
    member_policy: input.memberPolicy,
    archived: input.archived ?? false,
    deleted: input.deleted ?? false,
  });
  // A board tombstone still carries the board's full last-known state, unlike
  // the issue and comment ones, which are built from an envelope after the row
  // is gone. The delete handler snapshots the row before deleting it (EFB-32),
  // so `deleted: true` retires a complete description rather than a stub —
  // which also keeps `fa:slug` non-empty, as the gateway's 30550 spec requires.
  const tags: string[][] = [
    ["d", input.boardId],
    ["fa:context", FA_CONTEXT_V0],
    ["alt", `Board ${input.title}`],
    ["blake3", blake3ContentTag(content)],
    ["fa:board", input.boardId],
    ["fa:slug", input.slug],
  ];
  if (input.deleted === true) tags.push(["fa:deleted", "1"]);
  return {
    kind: KIND_KANBAN_BOARD,
    created_at: input.createdAt ?? nowSec(),
    tags,
    content,
  };
}

export interface BuildKanbanIssueInput {
  issueId: string;
  boardId: string;
  shortId?: string | null;
  title: string;
  body?: string | null;
  bodyFormat: string;
  type: string;
  status: string;
  columnId?: string | null;
  container: string;
  assigneePubkey?: string | null;
  priority?: number | null;
  estimate?: number | null;
  labels: ReadonlyArray<string>;
  position?: number | null;
  sprintId?: string | null;
  externalState?: string | null;
  /**
   * The issue this one duplicates (EFB-30). Null/absent = not a duplicate.
   * A consumer replaying the substrate needs this to reconstruct why an issue
   * is in Done without any work having been done on it.
   */
  duplicateOfIssueId?: string | null;
  deleted?: boolean;
  createdAt?: number;
}

export function buildKanbanIssue(input: BuildKanbanIssueInput): EventTemplate {
  const content = JSON.stringify({
    "@context": FA_CONTEXT_V0,
    "@type": "KanbanIssue",
    short_id: input.shortId ?? null,
    title: input.title,
    body: input.body ?? null,
    body_format: input.bodyFormat,
    type: input.type,
    status: input.status,
    column_id: input.columnId ?? null,
    container: input.container,
    assignee_pubkey: input.assigneePubkey ?? null,
    priority: input.priority ?? null,
    estimate: input.estimate ?? null,
    labels: input.labels,
    position: input.position ?? null,
    sprint_id: input.sprintId ?? null,
    external_state: input.externalState ?? null,
    duplicate_of_issue_id: input.duplicateOfIssueId ?? null,
    deleted: input.deleted ?? false,
  });
  const tags: string[][] = [
    ["d", input.issueId],
    ["fa:context", FA_CONTEXT_V0],
    ["alt", `Issue ${input.shortId ?? input.issueId}: ${input.title}`],
    ["blake3", blake3ContentTag(content)],
    ["fa:board", input.boardId],
    ["fa:type", input.type],
    ["fa:status", input.status],
    ["fa:container", input.container],
  ];
  if (input.sprintId != null) tags.push(["fa:sprint", input.sprintId]);
  // Tagged, not just in content, so a relay query can select duplicates
  // without fetching and parsing every issue's body — same reason fa:sprint
  // and fa:status are tags. Only present when set: an absent tag means "not a
  // duplicate", which keeps the tag list of an ordinary issue unchanged.
  if (input.duplicateOfIssueId != null) {
    tags.push(["fa:duplicate_of", input.duplicateOfIssueId]);
  }
  if (input.deleted === true) tags.push(["fa:deleted", "1"]);
  return {
    kind: KIND_KANBAN_ISSUE,
    created_at: input.createdAt ?? nowSec(),
    tags,
    content,
  };
}

export interface BuildKanbanCommentInput {
  commentId: string;
  issueId: string;
  boardId: string;
  /**
   * WHO WROTE THE COMMENT (EFB-58) — the second and last actor slot among these
   * builders. `buildKanbanBoard` and `buildKanbanSprint` carry no pubkey at all,
   * and `buildKanbanIssue.assigneePubkey` is a REFERENCE (the owner of the work)
   * rather than an actor, so migrating it would widen the type without adding
   * safety. Two is the whole set, not a partial migration.
   *
   * Unlike a status change, authorship is a property of the row and not of the
   * request doing the publishing: a comment republished by a backfill still has
   * its original author, so the `source` here describes where THIS build got the
   * identity, which for a stored comment is `user.explicit`.
   */
  author: Provenance;
  body: string;
  bodyFormat: string;
  inReplyTo?: string | null;
  deleted?: boolean;
  createdAt?: number;
}

export function buildKanbanComment(input: BuildKanbanCommentInput): EventTemplate {
  const content = JSON.stringify({
    "@context": FA_CONTEXT_V0,
    "@type": "KanbanComment",
    issue_id: input.issueId,
    author_pubkey: input.author.pubkey,
    body: input.body,
    body_format: input.bodyFormat,
    in_reply_to: input.inReplyTo ?? null,
    deleted: input.deleted ?? false,
  });
  const tags: string[][] = [
    ["d", input.commentId],
    ["fa:context", FA_CONTEXT_V0],
    ["alt", `Comment on issue ${input.issueId}`],
    ["blake3", blake3ContentTag(content)],
    ["fa:board", input.boardId],
    ["fa:issue", input.issueId],
  ];
  if (input.deleted === true) tags.push(["fa:deleted", "1"]);
  return {
    kind: KIND_KANBAN_COMMENT,
    created_at: input.createdAt ?? nowSec(),
    tags,
    content,
  };
}

/**
 * Append-only audit record — the one builder here whose `d` tag is the change
 * rather than the entity changed. Republishing a status change would mean the
 * transition itself was misrecorded, which never happens; the issue's own
 * 30551 carries the current status.
 */
export interface BuildKanbanStatusChangeInput {
  statusChangeId: string;
  issueId: string;
  boardId: string;
  /**
   * WHO MOVED THE CARD, as a Provenance rather than a bare pubkey (EFB-58).
   *
   * This is the slot EFB-33 nearly got wrong: the event carries no actor of its
   * own, the first draft reached for `issue.assignee_pubkey` — a DIFFERENT
   * person, the owner of the work rather than the mover of the card — and
   * TypeScript had nothing to say because both are `string`. All 676 tests
   * passed. It would have shipped false attribution on a signed public event.
   *
   * `Provenance` closes that by making the semantic role a required field: a
   * caller must write `source` to construct one, and `{source: "route.caller"}`
   * next to an assignee lookup is a visible contradiction rather than an
   * invisible one. Only `.pubkey` reaches the wire, so the event is
   * byte-identical to the pre-EFB-58 one.
   */
  actor: Provenance;
  fromStatus?: string | null;
  toStatus?: string | null;
  fromContainer?: string | null;
  toContainer?: string | null;
  occurredAtMs: number;
  createdAt?: number;
}

export function buildKanbanStatusChange(input: BuildKanbanStatusChangeInput): EventTemplate {
  const content = JSON.stringify({
    "@context": FA_CONTEXT_V0,
    "@type": "KanbanStatusChange",
    issue_id: input.issueId,
    actor_pubkey: input.actor.pubkey,
    from_status: input.fromStatus ?? null,
    to_status: input.toStatus ?? null,
    from_container: input.fromContainer ?? null,
    to_container: input.toContainer ?? null,
    occurred_at_ms: input.occurredAtMs,
  });
  return {
    kind: KIND_KANBAN_STATUS_CHANGE,
    created_at: input.createdAt ?? nowSec(),
    tags: [
      ["d", input.statusChangeId],
      ["fa:context", FA_CONTEXT_V0],
      ["alt", `Issue ${input.issueId}: ${input.fromStatus ?? "—"} → ${input.toStatus ?? "—"}`],
      ["blake3", blake3ContentTag(content)],
      ["fa:board", input.boardId],
      ["fa:issue", input.issueId],
    ],
    content,
  };
}

export interface BuildKanbanSprintInput {
  sprintId: string;
  boardId: string;
  name: string;
  goal?: string | null;
  status: string;
  plannedDays?: number | null;
  startedAtMs?: number | null;
  completedAtMs?: number | null;
  pointsCommittedStart?: number | null;
  pointsCompleted?: number | null;
  pointsCarried?: number | null;
  addsMidSprint: number;
  createdAt?: number;
}

export function buildKanbanSprint(input: BuildKanbanSprintInput): EventTemplate {
  const content = JSON.stringify({
    "@context": FA_CONTEXT_V0,
    "@type": "KanbanSprint",
    name: input.name,
    goal: input.goal ?? null,
    status: input.status,
    planned_days: input.plannedDays ?? null,
    started_at_ms: input.startedAtMs ?? null,
    completed_at_ms: input.completedAtMs ?? null,
    points_committed_start: input.pointsCommittedStart ?? null,
    points_completed: input.pointsCompleted ?? null,
    points_carried: input.pointsCarried ?? null,
    adds_mid_sprint: input.addsMidSprint,
  });
  return {
    kind: KIND_KANBAN_SPRINT,
    created_at: input.createdAt ?? nowSec(),
    tags: [
      ["d", input.sprintId],
      ["fa:context", FA_CONTEXT_V0],
      ["alt", `Sprint ${input.name} (${input.status})`],
      ["blake3", blake3ContentTag(content)],
      ["fa:board", input.boardId],
      ["fa:sprint", input.sprintId],
      ["fa:status", input.status],
    ],
    content,
  };
}

export function audienceAddress(audIdPub: string, slug: string): string {
  return `${KIND_AUDIENCE}:${audIdPub}:${slug}`;
}

export function parseAudienceAddress(
  address: string,
): { kind: number; pubkey: string; slug: string } | null {
  const parts = address.split(":");
  if (parts.length !== 3) return null;
  const [kindStr, pubkey, slug] = parts as [string, string, string];
  if (kindStr !== String(KIND_AUDIENCE)) return null;
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return null;
  if (!/^[A-Za-z0-9-]+$/.test(slug)) return null;
  return { kind: KIND_AUDIENCE, pubkey, slug };
}

// blake3 helper kept here so callers wanting just a tag don't need the lib import.
export { blake3ContentTag };
