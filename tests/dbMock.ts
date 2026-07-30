// Shared in-memory Db mock for route tests, covering boardCache,
// issueCache, commentCache, statusChangeCache, and — since phase 16 —
// orgCache, orgMemberCache, boardMemberCache, inviteCache, orgSlugAlias,
// and the profileCache reads the invite surfaces make.
//
// Same discipline as always (the pattern Sona ratified): it interprets
// exactly the SQL the routers issue and THROWS on anything unexpected, so
// route/SQL drift fails loudly at test time instead of silently returning
// empty results.

import { Effect, Layer } from "effect";
import { Db, type DbService } from "../src/effects";

export type Row = Record<string, unknown>;

export interface DbMock {
  readonly boards: Row[];
  readonly issues: Row[];
  readonly comments: Row[];
  readonly statusChanges: Row[];
  readonly attachments: Row[];
  readonly sprints: Row[];
  readonly apiKeys: Row[];
  readonly orgs: Row[];
  readonly orgMembers: Row[];
  readonly boardMembers: Row[];
  readonly invites: Row[];
  readonly orgAliases: Row[];
  readonly profiles: Row[];
  readonly storageConfigs: Row[];
  readonly notificationConfigs: Row[];
  readonly audienceKeys: Row[];
  readonly keyGrants: Row[];
  readonly sessionKeys: Row[];
  readonly sessions: Row[];
  readonly layer: Layer.Layer<Db>;
}

const num = (v: unknown): number => v as number;
const str = (v: unknown): string => String(v);

export const makeDbMock = (): DbMock => {
  const boards: Row[] = [];
  const issues: Row[] = [];
  const comments: Row[] = [];
  const statusChanges: Row[] = [];
  const attachments: Row[] = [];
  const sprints: Row[] = [];
  const apiKeys: Row[] = [];
  const orgs: Row[] = [];
  const orgMembers: Row[] = [];
  const boardMembers: Row[] = [];
  const invites: Row[] = [];
  const orgAliases: Row[] = [];
  const profiles: Row[] = [];
  const storageConfigs: Row[] = [];
  const notificationConfigs: Row[] = [];
  const audienceKeys: Row[] = [];
  const keyGrants: Row[] = [];
  const sessionKeys: Row[] = [];
  const sessions: Row[] = [];

  const issuesForBoardDesc = (boardId: unknown) =>
    issues
      .filter((r) => r["board_id"] === boardId)
      .sort(
        (a, b) =>
          num(b["updated_at_ms"]) - num(a["updated_at_ms"]) ||
          str(b["id"]).localeCompare(str(a["id"])),
      );

  const commentsForIssueAsc = (issueId: unknown) =>
    comments
      .filter((r) => r["issue_id"] === issueId)
      .sort(
        (a, b) =>
          num(a["created_at_ms"]) - num(b["created_at_ms"]) ||
          str(a["id"]).localeCompare(str(b["id"])),
      );

  /** Apply the archive filter iff the SQL carries it (polish batch). */
  const liveOnly = (rows: Row[], sql: string) =>
    sql.includes("archived_at_ms IS NULL")
      ? rows.filter((r) => (r["archived_at_ms"] ?? null) === null)
      : rows;

  /** The boards router's visibility predicate: org member ∪ explicit grant ∪ creator. */
  const visibleBoards = (pubkey: unknown) => {
    const orgIds = new Set(
      orgMembers.filter((m) => m["pubkey"] === pubkey).map((m) => m["org_id"]),
    );
    const boardIds = new Set(
      boardMembers.filter((m) => m["pubkey"] === pubkey).map((m) => m["board_id"]),
    );
    return boards.filter(
      (b) => orgIds.has(b["org_id"]) || boardIds.has(b["id"]) || b["pubkey"] === pubkey,
    );
  };

  const byUpdatedDesc = (rows: Row[]) =>
    [...rows].sort(
      (a, b) =>
        num(b["updated_at_ms"]) - num(a["updated_at_ms"]) ||
        str(b["id"]).localeCompare(str(a["id"])),
    );

  /** Apply the routers' single-filter fragment; returns [rows, paramsConsumed]. */
  const applyIssueFilter = (
    sql: string,
    rows: Row[],
    params: ReadonlyArray<unknown>,
    at: number,
  ): [Row[], number] => {
    if (sql.includes("AND status = ?")) {
      return [rows.filter((r) => r["status"] === params[at]), at + 1];
    }
    if (sql.includes("AND container = ?")) {
      return [rows.filter((r) => r["container"] === params[at]), at + 1];
    }
    if (sql.includes("AND assignee_pubkey = ?")) {
      return [rows.filter((r) => r["assignee_pubkey"] === params[at]), at + 1];
    }
    if (sql.includes("json_each")) {
      return [
        rows.filter((r) => (JSON.parse(str(r["labels"])) as string[]).includes(str(params[at]))),
        at + 1,
      ];
    }
    return [rows, at];
  };

  const service: DbService = {
    execute: (sql, params = []) =>
      Effect.sync(() => {
        if (sql.startsWith("INSERT INTO boardCache")) {
          const [id, pubkey, slug, title, description, columns, labels, member_policy, is_encrypted, issue_prefix, next_issue_number, org_id, visibility, created_at_ms, updated_at_ms] = params;
          boards.push({ id, pubkey, slug, title, description, columns, labels, member_policy, is_encrypted, issue_prefix, next_issue_number, org_id, visibility, created_at_ms, updated_at_ms });
          return;
        }
        if (sql.startsWith("INSERT INTO issueCache")) {
          const [id, short_id, board_id, title, body, body_format, type, status, column_id, container, assignee_pubkey, priority, estimate, labels, github_links, position, created_at_ms, updated_at_ms, completed_at_ms] = params;
          if (issues.some((r) => r["short_id"] !== null && r["short_id"] === short_id)) {
            throw new Error(`DbMock: UNIQUE violation on issueCache.short_id: ${String(short_id)}`);
          }
          issues.push({ id, short_id, board_id, title, body, body_format, type, status, column_id, container, assignee_pubkey, priority, estimate, labels, github_links, position, created_at_ms, updated_at_ms, completed_at_ms });
          return;
        }
        if (sql.startsWith("INSERT INTO apiKeys")) {
          const [id, pubkey, name, key_hash, prefix, created_at_ms, last_used_at_ms, revoked_at_ms] = params;
          apiKeys.push({ id, pubkey, name, key_hash, prefix, created_at_ms, last_used_at_ms, revoked_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE apiKeys SET last_used_at_ms = ?")) {
          const [last_used_at_ms, id] = params;
          const row = apiKeys.find((r) => r["id"] === id);
          if (row) Object.assign(row, { last_used_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE apiKeys SET revoked_at_ms = ?")) {
          const [revoked_at_ms, id] = params;
          const row = apiKeys.find((r) => r["id"] === id);
          if (row) Object.assign(row, { revoked_at_ms });
          return;
        }
        if (sql.startsWith("INSERT INTO issueAttachmentCache")) {
          const [id, issue_id, comment_id, blob_url, sha256, filename, content_type, size_bytes, storage_kind, is_cover, uploaded_by, uploaded_at_ms, deleted_at_ms] = params;
          attachments.push({ id, issue_id, comment_id, blob_url, sha256, filename, content_type, size_bytes, storage_kind, is_cover, uploaded_by, uploaded_at_ms, deleted_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE issueAttachmentCache SET comment_id = ? WHERE id = ?")) {
          const row = attachments.find(
            (r) => r["id"] === params[1] && (r["comment_id"] ?? null) === null && r["deleted_at_ms"] === null,
          );
          if (row) row["comment_id"] = params[0];
          return;
        }
        if (sql.startsWith("UPDATE issueAttachmentCache SET deleted_at_ms = ?, is_cover = 0 WHERE comment_id = ?")) {
          for (const row of attachments) {
            if (row["comment_id"] === params[1] && row["deleted_at_ms"] === null) {
              Object.assign(row, { deleted_at_ms: params[0], is_cover: 0 });
            }
          }
          return;
        }
        if (sql.startsWith("UPDATE issueAttachmentCache SET is_cover = 0 WHERE issue_id = ?")) {
          for (const row of attachments) {
            if (row["issue_id"] === params[0] && row["is_cover"] === 1 && row["deleted_at_ms"] === null) {
              row["is_cover"] = 0;
            }
          }
          return;
        }
        if (sql.startsWith("UPDATE issueAttachmentCache SET is_cover = 1 WHERE id = ?")) {
          const row = attachments.find((r) => r["id"] === params[0]);
          if (row) {
            // Mirror the 0006 partial unique index: at most one live cover.
            if (
              attachments.some(
                (o) => o !== row && o["issue_id"] === row["issue_id"] && o["is_cover"] === 1 && o["deleted_at_ms"] === null,
              )
            ) {
              throw new Error("DbMock: UNIQUE violation on idx_issueAttachmentCache_one_cover_per_issue");
            }
            row["is_cover"] = 1;
          }
          return;
        }
        if (sql.startsWith("UPDATE issueAttachmentCache SET is_cover = 0 WHERE id = ?")) {
          const row = attachments.find((r) => r["id"] === params[0]);
          if (row) row["is_cover"] = 0;
          return;
        }
        if (sql.startsWith("UPDATE issueAttachmentCache SET deleted_at_ms = ?")) {
          const [deleted_at_ms, id] = params;
          const row = attachments.find((r) => r["id"] === id);
          if (row) Object.assign(row, { deleted_at_ms, is_cover: 0 });
          return;
        }
        if (sql.startsWith("INSERT INTO commentCache")) {
          const [id, issue_id, author_pubkey, body, body_format, in_reply_to, created_at_ms] = params;
          comments.push({ id, issue_id, author_pubkey, body, body_format, in_reply_to, created_at_ms });
          return;
        }
        if (sql.startsWith("INSERT INTO statusChangeCache")) {
          const [id, issue_id, board_id, actor_pubkey, from_status, to_status, from_container, to_container, container_at_completion, occurred_at_ms] = params;
          statusChanges.push({ id, issue_id, board_id, actor_pubkey, from_status, to_status, from_container, to_container, container_at_completion, occurred_at_ms });
          return;
        }
        // Org creation: session bootstrap inlines 'personal', the orgs
        // router inlines 'team'; the literal picks the param shape.
        if (sql.startsWith("INSERT INTO orgCache") && sql.includes("'personal'")) {
          const [id, slug, display_name, created_by, created_at_ms, updated_at_ms] = params;
          orgs.push({ id, slug, display_name, avatar_url: null, bio: null, kind: "personal", created_by, substrate_event_id: null, created_at_ms, updated_at_ms, deleted_at_ms: null });
          return;
        }
        if (sql.startsWith("INSERT INTO orgCache") && sql.includes("'team'")) {
          const [id, slug, display_name, avatar_url, bio, created_by, created_at_ms, updated_at_ms] = params;
          orgs.push({ id, slug, display_name, avatar_url, bio, kind: "team", created_by, substrate_event_id: null, created_at_ms, updated_at_ms, deleted_at_ms: null });
          return;
        }
        if (sql.startsWith("INSERT OR IGNORE INTO orgMemberCache")) {
          const [org_id, pubkey, added_by, added_at_ms] = params;
          if (!orgMembers.some((m) => m["org_id"] === org_id && m["pubkey"] === pubkey)) {
            orgMembers.push({ org_id, pubkey, role: "owner", added_by, added_at_ms, substrate_event_id: null });
          }
          return;
        }
        if (sql.startsWith("INSERT INTO orgMemberCache") && sql.includes("ON CONFLICT")) {
          const [org_id, pubkey, role, added_by, added_at_ms, substrate_event_id] = params;
          const existing = orgMembers.find((m) => m["org_id"] === org_id && m["pubkey"] === pubkey);
          if (existing) Object.assign(existing, { role, substrate_event_id });
          else orgMembers.push({ org_id, pubkey, role, added_by, added_at_ms, substrate_event_id });
          return;
        }
        if (sql.startsWith("INSERT INTO boardMemberCache") && sql.includes("ON CONFLICT")) {
          const [board_id, pubkey, role, added_by, added_at_ms, substrate_event_id] = params;
          const existing = boardMembers.find((m) => m["board_id"] === board_id && m["pubkey"] === pubkey);
          if (existing) Object.assign(existing, { role, substrate_event_id });
          else boardMembers.push({ board_id, pubkey, role, added_by, added_at_ms, substrate_event_id });
          return;
        }
        if (sql.startsWith("INSERT OR REPLACE INTO orgSlugAlias")) {
          const [old_slug, org_id, created_at_ms] = params;
          const existing = orgAliases.find((a) => a["old_slug"] === old_slug);
          if (existing) Object.assign(existing, { org_id, created_at_ms });
          else orgAliases.push({ old_slug, org_id, created_at_ms });
          return;
        }
        if (sql.startsWith("INSERT INTO inviteCache")) {
          const [id, code, org_id, board_id, role, invited_by, invited_email, bind_to_email, expires_at_ms, single_use, created_at_ms] = params;
          invites.push({ id, code, org_id, board_id, role, invited_by, invited_email, bind_to_email, expires_at_ms, single_use, used_by: null, used_at_ms: null, revoked_at_ms: null, declined_at_ms: null, created_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE orgCache SET substrate_event_id = ?")) {
          const [substrate_event_id, id] = params;
          const row = orgs.find((r) => r["id"] === id);
          if (row) Object.assign(row, { substrate_event_id });
          return;
        }
        if (sql.startsWith("UPDATE orgCache SET slug = ?")) {
          const [slug, display_name, avatar_url, bio, updated_at_ms, id] = params;
          const row = orgs.find((r) => r["id"] === id);
          if (row) Object.assign(row, { slug, display_name, avatar_url, bio, updated_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE orgCache SET deleted_at_ms = ?")) {
          const [deleted_at_ms, updated_at_ms, id] = params;
          const row = orgs.find((r) => r["id"] === id);
          if (row) Object.assign(row, { deleted_at_ms, updated_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE orgMemberCache SET substrate_event_id = ?")) {
          const [substrate_event_id, org_id, pubkey] = params;
          const row = orgMembers.find((m) => m["org_id"] === org_id && m["pubkey"] === pubkey);
          if (row) Object.assign(row, { substrate_event_id });
          return;
        }
        if (sql.startsWith("DELETE FROM orgMemberCache WHERE org_id = ? AND pubkey = ?")) {
          const idx = orgMembers.findIndex((m) => m["org_id"] === params[0] && m["pubkey"] === params[1]);
          if (idx >= 0) orgMembers.splice(idx, 1);
          return;
        }
        if (sql.startsWith("DELETE FROM boardMemberCache WHERE board_id = ? AND pubkey = ?")) {
          const idx = boardMembers.findIndex((m) => m["board_id"] === params[0] && m["pubkey"] === params[1]);
          if (idx >= 0) boardMembers.splice(idx, 1);
          return;
        }
        if (sql.startsWith("DELETE FROM boardMemberCache WHERE board_id = ?")) {
          for (let i = boardMembers.length - 1; i >= 0; i--) {
            if (boardMembers[i]!["board_id"] === params[0]) boardMembers.splice(i, 1);
          }
          return;
        }
        if (sql.startsWith("UPDATE inviteCache SET used_by = ?, used_at_ms = ? WHERE id = ?") && !sql.includes("RETURNING")) {
          const [used_by, used_at_ms, id] = params;
          const row = invites.find((r) => r["id"] === id);
          if (row) Object.assign(row, { used_by, used_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE inviteCache SET declined_at_ms = ?")) {
          const [declined_at_ms, id] = params;
          const row = invites.find((r) => r["id"] === id);
          if (row) Object.assign(row, { declined_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE inviteCache SET revoked_at_ms = ?")) {
          const [revoked_at_ms, id] = params;
          const row = invites.find((r) => r["id"] === id);
          if (row) Object.assign(row, { revoked_at_ms });
          return;
        }
        // Transition: status name mirror + column_id identity move together.
        if (sql.startsWith("UPDATE issueCache SET status = ?, column_id = ?, updated_at_ms = ?")) {
          const [status, column_id, updated_at_ms, completed_at_ms, id] = params;
          const row = issues.find((r) => r["id"] === id);
          if (row) Object.assign(row, { status, column_id, updated_at_ms, completed_at_ms });
          return;
        }
        // Column rename: re-point the status mirror of every issue in the column.
        if (sql.startsWith("UPDATE issueCache SET status = ? WHERE board_id = ? AND column_id = ?")) {
          const [status, board_id, column_id] = params;
          for (const row of issues) {
            if (row["board_id"] === board_id && row["column_id"] === column_id) {
              Object.assign(row, { status });
            }
          }
          return;
        }
        // Column delete with move: issues relocate to the surviving column.
        if (sql.startsWith("UPDATE issueCache SET column_id = ?, status = ? WHERE board_id = ? AND column_id = ?")) {
          const [column_id, status, board_id, from_column_id] = params;
          for (const row of issues) {
            if (row["board_id"] === board_id && row["column_id"] === from_column_id) {
              Object.assign(row, { column_id, status });
            }
          }
          return;
        }
        if (sql.startsWith("UPDATE issueCache SET position = ?, updated_at_ms = ? WHERE id = ?")) {
          const row = issues.find((r) => r["id"] === params[2]);
          if (row) Object.assign(row, { position: params[0], updated_at_ms: params[1] });
          return;
        }
        if (sql.startsWith("UPDATE issueCache SET position = ? WHERE id = ?")) {
          const row = issues.find((r) => r["id"] === params[1]);
          if (row) row["position"] = params[0];
          return;
        }
        if (sql.startsWith("UPDATE issueCache SET container = ?")) {
          const [container, updated_at_ms, id] = params;
          const row = issues.find((r) => r["id"] === id);
          if (row) Object.assign(row, { container, updated_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE issueCache SET title = ?")) {
          const [title, body, body_format, type, status, column_id, assignee_pubkey, priority, estimate, labels, updated_at_ms, completed_at_ms, id] = params;
          const row = issues.find((r) => r["id"] === id);
          if (row) Object.assign(row, { title, body, body_format, type, status, column_id, assignee_pubkey, priority, estimate, labels, updated_at_ms, completed_at_ms });
          return;
        }
        // Phase-16.5 boardCache updates — must precede the bare
        // "UPDATE boardCache SET" fallback, which shares their prefix.
        if (sql.startsWith("UPDATE boardCache SET is_encrypted = 1, audience_epoch = 1, audience_pubkey = ?")) {
          const [audience_pubkey, updated_at_ms, id] = params;
          const row = boards.find((r) => r["id"] === id);
          if (row) Object.assign(row, { is_encrypted: 1, audience_epoch: 1, audience_pubkey, updated_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE boardCache SET audience_epoch = ?, updated_at_ms = ? WHERE id = ?")) {
          const [audience_epoch, updated_at_ms, id] = params;
          const row = boards.find((r) => r["id"] === id);
          if (row) Object.assign(row, { audience_epoch, updated_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE boardCache SET issue_prefix = ?")) {
          const [issue_prefix, id] = params;
          const row = boards.find((r) => r["id"] === id && r["issue_prefix"] == null);
          if (row) Object.assign(row, { issue_prefix });
          return;
        }
        // Archive toggle (polish batch) — must precede the generic
        // board-PATCH branch below, which shares its prefix.
        if (sql.startsWith("UPDATE boardCache SET archived_at_ms = ?, updated_at_ms = ? WHERE id = ?")) {
          const [archived_at_ms, updated_at_ms, id] = params;
          const row = boards.find((r) => r["id"] === id);
          if (row) Object.assign(row, { archived_at_ms, updated_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE boardCache SET")) {
          const [title, description, columns, labels, member_policy, issue_prefix, visibility, default_sprint_days, updated_at_ms, id] = params;
          const row = boards.find((r) => r["id"] === id);
          if (row) Object.assign(row, { title, description, columns, labels, member_policy, issue_prefix, visibility, default_sprint_days, updated_at_ms });
          return;
        }
        if (sql.startsWith("DELETE FROM issueCache WHERE id = ?")) {
          const idx = issues.findIndex((r) => r["id"] === params[0]);
          if (idx >= 0) issues.splice(idx, 1);
          return;
        }
        if (sql.startsWith("DELETE FROM commentCache WHERE issue_id = ?")) {
          for (let i = comments.length - 1; i >= 0; i--) {
            if (comments[i]!["issue_id"] === params[0]) comments.splice(i, 1);
          }
          return;
        }
        if (sql.startsWith("DELETE FROM commentCache WHERE id = ?")) {
          const idx = comments.findIndex((r) => r["id"] === params[0]);
          if (idx >= 0) comments.splice(idx, 1);
          return;
        }
        if (sql.startsWith("DELETE FROM boardCache WHERE id = ?")) {
          const idx = boards.findIndex((r) => r["id"] === params[0]);
          if (idx >= 0) boards.splice(idx, 1);
          return;
        }
        // ── phase 18b: BYOB storage config ──
        // ── phase 16.5: private-board audiences ──
        if (sql.startsWith("INSERT INTO boardAudienceKey")) {
          const [board_id, epoch, aud_id_pubkey, epoch_pubkey, aud_id_priv_ciphertext, epoch_priv_ciphertext, sender_pubkey, created_at_ms] = params;
          audienceKeys.push({ board_id, epoch, aud_id_pubkey, epoch_pubkey, aud_id_priv_ciphertext, epoch_priv_ciphertext, sender_pubkey, created_at_ms });
          return;
        }
        if (sql.startsWith("INSERT INTO boardMemberKeyGrant")) {
          const [id, board_id, member_pubkey, recipient_pubkey, epoch, grant_ciphertext, grant_sender_pubkey, issued_at_ms, revoked_at_ms] = params;
          keyGrants.push({ id, board_id, member_pubkey, recipient_pubkey, epoch, grant_ciphertext, grant_sender_pubkey, issued_at_ms, revoked_at_ms });
          return;
        }
        if (sql.startsWith("INSERT OR REPLACE INTO sessionCache")) {
          const [jwt_hash, pubkey, provider, oauth_id, expires_at_ms, last_seen_ms] = params;
          const row = sessions.find((r) => r["jwt_hash"] === jwt_hash);
          if (row) Object.assign(row, { pubkey, provider, oauth_id, expires_at_ms, last_seen_ms });
          else sessions.push({ jwt_hash, pubkey, provider, oauth_id, expires_at_ms, last_seen_ms });
          return;
        }
        if (sql.startsWith("INSERT OR REPLACE INTO sessionKeyRegistrations")) {
          const [jwt_hash, member_pubkey, session_pubkey, created_at_ms, expires_at_ms] = params;
          // 16.7: the source arrives as a SQL literal ('nostr' | 'ephemeral').
          const session_key_source = sql.includes("'nostr'") ? "nostr" : "ephemeral";
          const row = sessionKeys.find((r) => r["jwt_hash"] === jwt_hash);
          if (row) Object.assign(row, { member_pubkey, session_pubkey, created_at_ms, expires_at_ms, session_key_source });
          else sessionKeys.push({ jwt_hash, member_pubkey, session_pubkey, created_at_ms, expires_at_ms, session_key_source });
          return;
        }
        if (sql.startsWith("UPDATE boardMemberKeyGrant SET revoked_at_ms = ? WHERE board_id = ? AND revoked_at_ms IS NULL")) {
          for (const row of keyGrants) {
            if (row["board_id"] === params[1] && row["revoked_at_ms"] === null) {
              row["revoked_at_ms"] = params[0];
            }
          }
          return;
        }
        if (sql.startsWith("INSERT INTO orgStorageConfig")) {
          const [org_id, kind, blossom_url, s3_endpoint, s3_region, s3_bucket, s3_path_style, s3_creds_ciphertext, s3_creds_sender_pubkey, updated_by_pubkey, updated_at_ms] = params;
          const next = { org_id, kind, blossom_url, s3_endpoint, s3_region, s3_bucket, s3_path_style, s3_creds_ciphertext, s3_creds_sender_pubkey, updated_by_pubkey, updated_at_ms };
          const existing = storageConfigs.find((r) => r["org_id"] === org_id);
          if (existing) Object.assign(existing, next);
          else storageConfigs.push(next);
          return;
        }
        if (sql.startsWith("DELETE FROM orgStorageConfig WHERE org_id = ?")) {
          const idx = storageConfigs.findIndex((r) => r["org_id"] === params[0]);
          if (idx >= 0) storageConfigs.splice(idx, 1);
          return;
        }
        // ── phase 20: sprints ──
        if (sql.startsWith("INSERT INTO sprintCache")) {
          const [id, board_id, name, goal, status, planned_days, started_at_ms, completed_at_ms, created_at_ms] = params;
          sprints.push({ id, board_id, name, goal, status, planned_days, started_at_ms, completed_at_ms, created_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE sprintCache SET name = ?, goal = ?, planned_days = ? WHERE id = ?")) {
          const [name, goal, planned_days, id] = params;
          const row = sprints.find((r) => r["id"] === id);
          if (row) Object.assign(row, { name, goal, planned_days });
          return;
        }
        if (sql.startsWith("UPDATE sprintCache SET status = 'active', started_at_ms = ? WHERE id = ?")) {
          const row = sprints.find((r) => r["id"] === params[1]);
          if (row) Object.assign(row, { status: "active", started_at_ms: params[0] });
          return;
        }
        if (sql.startsWith("UPDATE sprintCache SET status = 'completed', completed_at_ms = ? WHERE id = ?")) {
          const row = sprints.find((r) => r["id"] === params[1]);
          if (row) Object.assign(row, { status: "completed", completed_at_ms: params[0] });
          return;
        }
        // ── polish batch: cross-board move + notifications ──
        if (sql.startsWith("UPDATE issueCache SET board_id = ?, short_id = ?, column_id = ?, status = ?, sprint_id = NULL, position = ?, updated_at_ms = ? WHERE id = ?")) {
          const [board_id, short_id, column_id, status, position, updated_at_ms, id] = params;
          const row = issues.find((r) => r["id"] === id);
          if (row) Object.assign(row, { board_id, short_id, column_id, status, sprint_id: null, position, updated_at_ms });
          return;
        }
        if (sql.startsWith("INSERT INTO notificationsConfig")) {
          const [pubkey, email_on_mention, email_on_assignment, email_on_issue_moved_to_me, email_digest, updated_at_ms] = params;
          const next = { pubkey, email_on_mention, email_on_assignment, email_on_issue_moved_to_me, email_digest, updated_at_ms };
          const existing = notificationConfigs.find((r) => r["pubkey"] === pubkey);
          if (existing) Object.assign(existing, next);
          else notificationConfigs.push(next);
          return;
        }
        if (sql.startsWith("UPDATE issueCache SET sprint_id = ?, updated_at_ms = ? WHERE id = ?")) {
          const [sprint_id, updated_at_ms, id] = params;
          const row = issues.find((r) => r["id"] === id);
          if (row) Object.assign(row, { sprint_id, updated_at_ms });
          return;
        }
        throw new Error(`DbMock: unexpected execute: ${sql}`);
      }),
    queryFirst: <R>(sql: string, params: ReadonlyArray<unknown> = []) =>
      Effect.sync(() => {
        // The atomic issue-number claim (single-statement UPDATE...RETURNING).
        if (sql.startsWith("UPDATE boardCache SET next_issue_number = next_issue_number + 1")) {
          const row = boards.find((x) => x["id"] === params[0]);
          if (!row) return null;
          const claimed = num(row["next_issue_number"]);
          row["next_issue_number"] = claimed + 1;
          return { n: claimed } as R;
        }
        // The atomic single-use invite claim.
        if (sql.startsWith("UPDATE inviteCache SET used_by = ?") && sql.includes("used_by IS NULL RETURNING")) {
          const [used_by, used_at_ms, id] = params;
          const row = invites.find((r) => r["id"] === id && r["used_by"] === null);
          if (!row) return null;
          Object.assign(row, { used_by, used_at_ms });
          return { id: row["id"] } as R;
        }
        if (sql.startsWith("SELECT * FROM issueCache WHERE short_id = ?")) {
          const r = issues.find((x) => x["short_id"] === params[0]);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT id FROM boardCache WHERE org_id = ? AND slug = ?")) {
          const r = boards.find((x) => x["org_id"] === params[0] && x["slug"] === params[1]);
          return (r ? { id: r["id"] } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM boardCache WHERE org_id = ? AND slug = ?")) {
          const r = boards.find((x) => x["org_id"] === params[0] && x["slug"] === params[1]);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.includes("boardCache.org_id IN (SELECT org_id FROM orgMemberCache") && sql.startsWith("SELECT COUNT(*)")) {
          return { n: liveOnly(visibleBoards(params[0]), sql).length } as R;
        }
        if (sql.includes("boardCache.org_id IN (SELECT org_id FROM orgMemberCache") && sql.includes("AND id = ?")) {
          const r = liveOnly(visibleBoards(params[0]), sql).find((x) => x["id"] === params[3]);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM notificationsConfig WHERE pubkey = ?")) {
          const r = notificationConfigs.find((x) => x["pubkey"] === params[0]);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM boardCache WHERE id = ?")) {
          const r = boards.find((x) => x["id"] === params[0]);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM issueCache WHERE board_id = ? AND id = ?")) {
          const r = issues.find((x) => x["board_id"] === params[0] && x["id"] === params[1]);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM issueCache WHERE id = ? AND board_id = ?")) {
          const r = issues.find((x) => x["id"] === params[0] && x["board_id"] === params[1]);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM issueCache WHERE short_id = ? AND board_id = ?")) {
          const r = issues.find((x) => x["short_id"] === params[0] && x["board_id"] === params[1]);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT id, revoked_at_ms FROM apiKeys WHERE id = ? AND pubkey = ?")) {
          const r = apiKeys.find((x) => x["id"] === params[0] && x["pubkey"] === params[1]);
          return (r ? { id: r["id"], revoked_at_ms: r["revoked_at_ms"] } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM issueAttachmentCache WHERE id = ? AND deleted_at_ms IS NULL")) {
          const r = attachments.find((x) => x["id"] === params[0] && x["deleted_at_ms"] === null);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM issueAttachmentCache WHERE id = ? AND issue_id = ? AND comment_id IS NULL AND deleted_at_ms IS NULL")) {
          const r = attachments.find(
            (x) =>
              x["id"] === params[0] &&
              x["issue_id"] === params[1] &&
              (x["comment_id"] ?? null) === null &&
              x["deleted_at_ms"] === null,
          );
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM issueAttachmentCache WHERE id = ? AND comment_id = ?")) {
          const r = attachments.find((x) => x["id"] === params[0] && x["comment_id"] === params[1]);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT MAX(position) AS m FROM issueCache WHERE board_id = ?")) {
          const positions = issues
            .filter((x) => x["board_id"] === params[0] && typeof x["position"] === "number")
            .map((x) => num(x["position"]));
          return { m: positions.length === 0 ? null : Math.max(...positions) } as R;
        }
        if (sql.startsWith("SELECT * FROM issueCache WHERE id = ?")) {
          const r = issues.find((x) => x["id"] === params[0]);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT COUNT(*) AS n FROM issueCache WHERE board_id = ? AND column_id = ?")) {
          return {
            n: issues.filter((x) => x["board_id"] === params[0] && x["column_id"] === params[1]).length,
          } as R;
        }
        if (sql.startsWith("SELECT COUNT(*) AS n FROM issueCache WHERE board_id = ?")) {
          const [filtered] = applyIssueFilter(
            sql,
            issues.filter((x) => x["board_id"] === params[0]),
            params,
            1,
          );
          return { n: filtered.length } as R;
        }
        if (sql.startsWith("SELECT * FROM commentCache WHERE id = ? AND issue_id = ?")) {
          const r = comments.find((x) => x["id"] === params[0] && x["issue_id"] === params[1]);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM commentCache WHERE id = ?")) {
          const r = comments.find((x) => x["id"] === params[0]);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT COUNT(*) AS n FROM commentCache WHERE issue_id = ?")) {
          return { n: comments.filter((x) => x["issue_id"] === params[0]).length } as R;
        }
        if (sql.startsWith("SELECT * FROM statusChangeCache WHERE board_id = ? AND id = ?")) {
          const r = statusChanges.find((x) => x["board_id"] === params[0] && x["id"] === params[1]);
          return (r ? { ...r } : null) as R | null;
        }
        // ── org / membership / invite surfaces ────────────────────────────
        if (sql.startsWith("SELECT * FROM orgCache WHERE slug = ? AND deleted_at_ms IS NULL")) {
          const r = orgs.find((x) => x["slug"] === params[0] && x["deleted_at_ms"] === null);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM orgCache WHERE id = ? AND deleted_at_ms IS NULL")) {
          const r = orgs.find((x) => x["id"] === params[0] && x["deleted_at_ms"] === null);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM orgCache WHERE created_by = ? AND kind = 'personal'")) {
          const r = orgs.find(
            (x) => x["created_by"] === params[0] && x["kind"] === "personal" && x["deleted_at_ms"] === null,
          );
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM orgCache WHERE id = ?")) {
          const r = orgs.find((x) => x["id"] === params[0]);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT id FROM orgCache WHERE slug = ?")) {
          const r = orgs.find((x) => x["slug"] === params[0]);
          return (r ? { id: r["id"] } : null) as R | null;
        }
        if (sql.startsWith("SELECT org_id FROM orgSlugAlias WHERE old_slug = ?")) {
          const r = orgAliases.find((x) => x["old_slug"] === params[0]);
          return (r ? { org_id: r["org_id"] } : null) as R | null;
        }
        if (sql.startsWith("SELECT role FROM orgMemberCache WHERE org_id = ? AND pubkey = ?")) {
          const r = orgMembers.find((x) => x["org_id"] === params[0] && x["pubkey"] === params[1]);
          return (r ? { role: r["role"] } : null) as R | null;
        }
        if (sql.startsWith("SELECT role FROM boardMemberCache WHERE board_id = ? AND pubkey = ?")) {
          const r = boardMembers.find((x) => x["board_id"] === params[0] && x["pubkey"] === params[1]);
          return (r ? { role: r["role"] } : null) as R | null;
        }
        if (sql.startsWith("SELECT substrate_event_id FROM orgMemberCache WHERE org_id = ? AND pubkey = ?")) {
          const r = orgMembers.find((x) => x["org_id"] === params[0] && x["pubkey"] === params[1]);
          return (r ? { substrate_event_id: r["substrate_event_id"] } : null) as R | null;
        }
        if (sql.startsWith("SELECT substrate_event_id FROM boardMemberCache WHERE board_id = ? AND pubkey = ?")) {
          const r = boardMembers.find((x) => x["board_id"] === params[0] && x["pubkey"] === params[1]);
          return (r ? { substrate_event_id: r["substrate_event_id"] } : null) as R | null;
        }
        if (sql.startsWith("SELECT COUNT(*) AS n FROM orgMemberCache WHERE org_id = ? AND role = 'owner'")) {
          return { n: orgMembers.filter((x) => x["org_id"] === params[0] && x["role"] === "owner").length } as R;
        }
        if (sql.startsWith("SELECT COUNT(*) AS n FROM inviteCache WHERE invited_by = ?")) {
          const [invited_by, org_id, boardIs, boardEq, after] = params;
          return {
            n: invites.filter(
              (x) =>
                x["invited_by"] === invited_by &&
                x["org_id"] === org_id &&
                (x["board_id"] === boardIs || x["board_id"] === boardEq) &&
                num(x["created_at_ms"]) > num(after),
            ).length,
          } as R;
        }
        if (sql.startsWith("SELECT * FROM inviteCache WHERE id = ?")) {
          const r = invites.find((x) => x["id"] === params[0]);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM inviteCache WHERE code = ?")) {
          const r = invites.find((x) => x["code"] === params[0]);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT name, display_name, picture FROM profileCache WHERE pubkey = ?")) {
          const r = profiles.find((x) => x["pubkey"] === params[0]);
          return (r ? { name: r["name"] ?? null, display_name: r["display_name"] ?? null, picture: r["picture"] ?? null } : null) as R | null;
        }
        if (sql.startsWith("SELECT display_name, name FROM profileCache WHERE pubkey = ?")) {
          const r = profiles.find((x) => x["pubkey"] === params[0]);
          return (r ? { display_name: r["display_name"] ?? null, name: r["name"] ?? null } : null) as R | null;
        }
        // ── phase 16.5: private-board audiences ──
        if (sql.startsWith("SELECT * FROM boardAudienceKey WHERE board_id = ? AND epoch = ?")) {
          const r = audienceKeys.find((x) => x["board_id"] === params[0] && x["epoch"] === params[1]);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT id FROM boardMemberKeyGrant WHERE board_id = ? AND recipient_pubkey = ? AND epoch = ? AND revoked_at_ms IS NULL")) {
          const r = keyGrants.find(
            (x) => x["board_id"] === params[0] && x["recipient_pubkey"] === params[1] && x["epoch"] === params[2] && x["revoked_at_ms"] === null,
          );
          return (r ? { id: r["id"] } : null) as R | null;
        }
        if (sql.startsWith("SELECT grant_ciphertext FROM boardMemberKeyGrant WHERE board_id = ? AND recipient_pubkey = ? AND epoch = ? AND revoked_at_ms IS NULL")) {
          const r = keyGrants.find(
            (x) => x["board_id"] === params[0] && x["recipient_pubkey"] === params[1] && x["epoch"] === params[2] && x["revoked_at_ms"] === null,
          );
          return (r ? { grant_ciphertext: r["grant_ciphertext"] } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM boardMemberKeyGrant WHERE board_id = ? AND member_pubkey = ? AND recipient_pubkey = ? AND epoch = ? AND revoked_at_ms IS NULL")) {
          const r = keyGrants.find(
            (x) => x["board_id"] === params[0] && x["member_pubkey"] === params[1] && x["recipient_pubkey"] === params[2] && x["epoch"] === params[3] && x["revoked_at_ms"] === null,
          );
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT session_pubkey, session_key_source FROM sessionKeyRegistrations WHERE jwt_hash = ?")) {
          const r = sessionKeys.find((x) => x["jwt_hash"] === params[0]);
          return (r
            ? { session_pubkey: r["session_pubkey"], session_key_source: r["session_key_source"] ?? "ephemeral" }
            : null) as R | null;
        }
        if (sql.startsWith("SELECT session_pubkey FROM sessionKeyRegistrations WHERE jwt_hash = ?")) {
          const r = sessionKeys.find((x) => x["jwt_hash"] === params[0]);
          return (r ? { session_pubkey: r["session_pubkey"] } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM orgStorageConfig WHERE org_id = ?")) {
          const r = storageConfigs.find((x) => x["org_id"] === params[0]);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM sprintCache WHERE id = ? AND board_id = ?")) {
          const r = sprints.find((x) => x["id"] === params[0] && x["board_id"] === params[1]);
          return (r ? { ...r } : null) as R | null;
        }
        throw new Error(`DbMock: unexpected queryFirst: ${sql}`);
      }),
    queryAll: <R>(sql: string, params: ReadonlyArray<unknown> = []) =>
      Effect.sync(() => {
        // Reorder's column-mates query — must precede the generic
        // board-list handler, which shares its prefix.
        if (sql.startsWith("SELECT * FROM issueCache WHERE board_id = ? AND container = ? AND (column_id = ?")) {
          return issues
            .filter(
              (r) =>
                r["board_id"] === params[0] &&
                r["container"] === params[1] &&
                (r["column_id"] === params[2] ||
                  ((r["column_id"] ?? null) === null && r["status"] === params[3])),
            )
            .map((r) => ({ ...r })) as R[];
        }
        // Sprint-start's backlog sweep — must precede the generic
        // board-list handler, which shares its prefix.
        if (sql.startsWith("SELECT * FROM issueCache WHERE board_id = ? AND sprint_id = ? AND container = 'backlog'")) {
          return issues
            .filter(
              (r) =>
                r["board_id"] === params[0] &&
                (r["sprint_id"] ?? null) === params[1] &&
                r["container"] === "backlog",
            )
            .map((r) => ({ ...r })) as R[];
        }
        if (sql.startsWith("SELECT * FROM issueCache WHERE board_id = ?")) {
          let rows = issuesForBoardDesc(params[0]);
          let at = 1;
          [rows, at] = applyIssueFilter(sql, rows, params, at);
          if (sql.includes("(updated_at_ms < ?")) {
            const [upd, , afterId] = [params[at], params[at + 1], params[at + 2]];
            at += 3;
            rows = rows.filter(
              (r) =>
                num(r["updated_at_ms"]) < num(upd) ||
                (r["updated_at_ms"] === upd && str(r["id"]) < str(afterId)),
            );
          }
          return rows.slice(0, num(params[at])).map((r) => ({ ...r })) as R[];
        }
        if (sql.startsWith("SELECT * FROM commentCache WHERE issue_id = ?")) {
          let rows = commentsForIssueAsc(params[0]);
          let at = 1;
          if (sql.includes("(created_at_ms > ?")) {
            const [created, , afterId] = [params[at], params[at + 1], params[at + 2]];
            at += 3;
            rows = rows.filter(
              (r) =>
                num(r["created_at_ms"]) > num(created) ||
                (r["created_at_ms"] === created && str(r["id"]) > str(afterId)),
            );
          }
          return rows.slice(0, num(params[at])).map((r) => ({ ...r })) as R[];
        }
        if (sql.startsWith("SELECT * FROM statusChangeCache WHERE issue_id = ?")) {
          const rows = statusChanges
            .filter((r) => r["issue_id"] === params[0])
            .sort(
              (a, b) =>
                num(b["occurred_at_ms"]) - num(a["occurred_at_ms"]) ||
                str(b["id"]).localeCompare(str(a["id"])),
            );
          return rows.slice(0, num(params[1])).map((r) => ({ ...r })) as R[];
        }
        if (sql.startsWith("SELECT * FROM statusChangeCache WHERE board_id = ?")) {
          let rows = statusChanges
            .filter((r) => r["board_id"] === params[0])
            .sort(
              (a, b) =>
                num(b["occurred_at_ms"]) - num(a["occurred_at_ms"]) ||
                str(b["id"]).localeCompare(str(a["id"])),
            );
          let at = 1;
          // Feed-kind discriminator fragments (see routes/feed.ts KIND_SQL).
          if (sql.includes("AND to_status IS NOT NULL AND to_container IS NOT NULL")) {
            rows = rows.filter((r) => r["to_status"] !== null && r["to_container"] !== null);
          } else if (sql.includes("AND to_status IS NOT NULL AND to_container IS NULL")) {
            rows = rows.filter((r) => r["to_status"] !== null && r["to_container"] === null);
          } else if (sql.includes("AND to_status IS NULL")) {
            rows = rows.filter((r) => r["to_status"] === null);
          }
          if (sql.includes("(occurred_at_ms < ?")) {
            const [occ, , afterId] = [params[at], params[at + 1], params[at + 2]];
            at += 3;
            rows = rows.filter(
              (r) =>
                num(r["occurred_at_ms"]) < num(occ) ||
                (r["occurred_at_ms"] === occ && str(r["id"]) < str(afterId)),
            );
          }
          return rows.slice(0, num(params[at])).map((r) => ({ ...r })) as R[];
        }
        if (sql.startsWith("SELECT id, pubkey, name, key_hash, last_used_at_ms FROM apiKeys WHERE prefix = ? AND revoked_at_ms IS NULL")) {
          return apiKeys
            .filter((r) => r["prefix"] === params[0] && r["revoked_at_ms"] === null)
            .map((r) => ({ id: r["id"], pubkey: r["pubkey"], name: r["name"], key_hash: r["key_hash"], last_used_at_ms: r["last_used_at_ms"] })) as R[];
        }
        if (sql.startsWith("SELECT id, name, prefix, created_at_ms, last_used_at_ms, revoked_at_ms FROM apiKeys WHERE pubkey = ?")) {
          return apiKeys
            .filter((r) => r["pubkey"] === params[0])
            .sort((a, b) => num(b["created_at_ms"]) - num(a["created_at_ms"]))
            .map((r) => ({ id: r["id"], name: r["name"], prefix: r["prefix"], created_at_ms: r["created_at_ms"], last_used_at_ms: r["last_used_at_ms"], revoked_at_ms: r["revoked_at_ms"] })) as R[];
        }
        if (sql.startsWith("SELECT * FROM issueAttachmentCache WHERE issue_id = ? AND deleted_at_ms IS NULL")) {
          return attachments
            .filter((r) => r["issue_id"] === params[0] && r["deleted_at_ms"] === null)
            .sort((a, b) => num(a["uploaded_at_ms"]) - num(b["uploaded_at_ms"]))
            .map((r) => ({ ...r })) as R[];
        }
        if (sql.startsWith("SELECT * FROM issueAttachmentCache WHERE issue_id = ? AND comment_id IS NULL AND deleted_at_ms IS NULL")) {
          return attachments
            .filter(
              (r) =>
                r["issue_id"] === params[0] &&
                (r["comment_id"] ?? null) === null &&
                r["deleted_at_ms"] === null,
            )
            .sort((a, b) => num(a["uploaded_at_ms"]) - num(b["uploaded_at_ms"]))
            .map((r) => ({ ...r })) as R[];
        }
        if (sql.startsWith("SELECT * FROM issueAttachmentCache WHERE issue_id = ? AND comment_id IS NOT NULL AND deleted_at_ms IS NULL")) {
          return attachments
            .filter(
              (r) =>
                r["issue_id"] === params[0] &&
                (r["comment_id"] ?? null) !== null &&
                r["deleted_at_ms"] === null,
            )
            .sort((a, b) => num(a["uploaded_at_ms"]) - num(b["uploaded_at_ms"]))
            .map((r) => ({ ...r })) as R[];
        }
        if (sql.startsWith("SELECT issue_id, blob_url, content_type FROM issueAttachmentCache WHERE is_cover = 1")) {
          return attachments
            .filter(
              (r) =>
                r["is_cover"] === 1 &&
                r["deleted_at_ms"] === null &&
                (params as unknown[]).includes(r["issue_id"]),
            )
            .map((r) => ({ issue_id: r["issue_id"], blob_url: r["blob_url"], content_type: r["content_type"] })) as R[];
        }
        if (sql.startsWith("SELECT id, title, short_id FROM issueCache WHERE id IN")) {
          return issues
            .filter((r) => (params as unknown[]).includes(r["id"]))
            .map((r) => ({ id: r["id"], title: r["title"], short_id: r["short_id"] ?? null })) as R[];
        }
        if (sql.startsWith("SELECT issue_prefix FROM boardCache WHERE issue_prefix IS NOT NULL")) {
          return boards
            .filter((r) => r["issue_prefix"] != null)
            .map((r) => ({ issue_prefix: r["issue_prefix"] })) as R[];
        }
        // ── org / membership / invite surfaces ────────────────────────────
        if (sql.startsWith("SELECT * FROM boardCache WHERE slug = ? ORDER BY (pubkey = ?) DESC")) {
          return boards
            .filter((r) => r["slug"] === params[0])
            .sort((a, b) => {
              const aOwn = a["pubkey"] === params[1] ? 1 : 0;
              const bOwn = b["pubkey"] === params[1] ? 1 : 0;
              return bOwn - aOwn || num(a["created_at_ms"]) - num(b["created_at_ms"]);
            })
            .map((r) => ({ ...r })) as R[];
        }
        if (sql.startsWith("SELECT * FROM boardCache WHERE org_id = ?") && sql.includes("ORDER BY")) {
          return byUpdatedDesc(liveOnly(boards.filter((r) => r["org_id"] === params[0]), sql)).map((r) => ({ ...r })) as R[];
        }
        if (sql.includes("boardCache.org_id IN (SELECT org_id FROM orgMemberCache")) {
          let rows = byUpdatedDesc(liveOnly(visibleBoards(params[0]), sql));
          let at = 3;
          if (sql.includes("(updated_at_ms < ?")) {
            const [upd, , afterId] = [params[at], params[at + 1], params[at + 2]];
            at += 3;
            rows = rows.filter(
              (r) =>
                num(r["updated_at_ms"]) < num(upd) ||
                (r["updated_at_ms"] === upd && str(r["id"]) < str(afterId)),
            );
          }
          return rows.slice(0, num(params[at])).map((r) => ({ ...r })) as R[];
        }
        if (sql.startsWith("SELECT slug FROM orgCache")) {
          return orgs.map((r) => ({ slug: r["slug"] })) as R[];
        }
        if (sql.startsWith("SELECT old_slug FROM orgSlugAlias")) {
          return orgAliases.map((r) => ({ old_slug: r["old_slug"] })) as R[];
        }
        // ── phase 16.5: private-board audiences ──
        if (sql.startsWith("SELECT pubkey FROM boardMemberCache WHERE board_id = ?")) {
          return boardMembers
            .filter((m) => m["board_id"] === params[0])
            .map((m) => ({ pubkey: m["pubkey"] })) as R[];
        }
        if (sql.startsWith("SELECT session_pubkey FROM sessionKeyRegistrations WHERE member_pubkey = ? AND expires_at_ms > ?")) {
          return sessionKeys
            .filter((r) => r["member_pubkey"] === params[0] && num(r["expires_at_ms"]) > num(params[1]))
            .map((r) => ({ session_pubkey: r["session_pubkey"] })) as R[];
        }
        if (sql.startsWith("SELECT member_pubkey, epoch, MAX(issued_at_ms) AS issued_at_ms FROM boardMemberKeyGrant WHERE board_id = ? AND epoch = ? AND revoked_at_ms IS NULL GROUP BY member_pubkey")) {
          const grouped = new Map<string, { member_pubkey: unknown; epoch: unknown; issued_at_ms: number }>();
          for (const r of keyGrants) {
            if (r["board_id"] !== params[0] || r["epoch"] !== params[1] || r["revoked_at_ms"] !== null) continue;
            const key = String(r["member_pubkey"]);
            const prev = grouped.get(key);
            const issued = num(r["issued_at_ms"]);
            if (!prev || issued > prev.issued_at_ms) {
              grouped.set(key, { member_pubkey: r["member_pubkey"], epoch: r["epoch"], issued_at_ms: issued });
            }
          }
          return [...grouped.values()] as R[];
        }
        if (sql.startsWith("SELECT recipient_pubkey FROM boardMemberKeyGrant WHERE board_id = ? AND epoch = ? AND revoked_at_ms IS NULL")) {
          return keyGrants
            .filter((r) => r["board_id"] === params[0] && r["epoch"] === params[1] && r["revoked_at_ms"] === null)
            .map((r) => ({ recipient_pubkey: r["recipient_pubkey"] })) as R[];
        }
        if (sql.startsWith("SELECT * FROM boardCache WHERE org_id = ? AND is_encrypted = 1")) {
          return boards
            .filter((r) => r["org_id"] === params[0] && r["is_encrypted"] === 1)
            .map((r) => ({ ...r })) as R[];
        }
        if (sql.startsWith("SELECT pubkey FROM orgMemberCache WHERE org_id = ? AND role IN")) {
          return orgMembers
            .filter((m) => m["org_id"] === params[0] && (m["role"] === "owner" || m["role"] === "admin"))
            .map((m) => ({ pubkey: m["pubkey"] })) as R[];
        }
        // Bare (no role filter) — must sit AFTER the role-IN variant, whose
        // SQL it prefixes.
        if (sql.startsWith("SELECT pubkey FROM orgMemberCache WHERE org_id = ?")) {
          return orgMembers
            .filter((m) => m["org_id"] === params[0])
            .map((m) => ({ pubkey: m["pubkey"] })) as R[];
        }
        if (sql.startsWith("SELECT * FROM orgMemberCache WHERE org_id = ? ORDER BY")) {
          return orgMembers
            .filter((m) => m["org_id"] === params[0])
            .sort((a, b) => num(a["added_at_ms"]) - num(b["added_at_ms"]))
            .map((r) => ({ ...r })) as R[];
        }
        if (sql.startsWith("SELECT * FROM boardMemberCache WHERE board_id = ? ORDER BY")) {
          return boardMembers
            .filter((m) => m["board_id"] === params[0])
            .sort((a, b) => num(a["added_at_ms"]) - num(b["added_at_ms"]))
            .map((r) => ({ ...r })) as R[];
        }
        if (sql.startsWith("SELECT o.slug, o.display_name, o.avatar_url, o.kind, m.role FROM orgMemberCache m")) {
          return orgMembers
            .filter((m) => m["pubkey"] === params[0])
            .map((m) => ({ m, o: orgs.find((o) => o["id"] === m["org_id"]) }))
            .filter((x) => x.o !== undefined && x.o["deleted_at_ms"] === null)
            .sort((a, b) => {
              const aP = a.o!["kind"] === "personal" ? 1 : 0;
              const bP = b.o!["kind"] === "personal" ? 1 : 0;
              return bP - aP || str(a.o!["slug"]).localeCompare(str(b.o!["slug"]));
            })
            .map((x) => ({
              slug: x.o!["slug"],
              display_name: x.o!["display_name"],
              avatar_url: x.o!["avatar_url"],
              kind: x.o!["kind"],
              role: x.m["role"],
            })) as R[];
        }
        if (sql.startsWith("SELECT id, slug, display_name, kind FROM orgCache WHERE deleted_at_ms IS NULL AND id IN")) {
          const memberOrgIds = new Set(
            orgMembers.filter((m) => m["pubkey"] === params[0]).map((m) => m["org_id"]),
          );
          const grantBoardOrgIds = new Set(
            boards
              .filter((b) =>
                boardMembers.some((m) => m["pubkey"] === params[1] && m["board_id"] === b["id"]),
              )
              .map((b) => b["org_id"]),
          );
          return orgs
            .filter(
              (o) =>
                o["deleted_at_ms"] === null &&
                (memberOrgIds.has(o["id"]) || grantBoardOrgIds.has(o["id"])),
            )
            .map((o) => ({ id: o["id"], slug: o["slug"], display_name: o["display_name"], kind: o["kind"] })) as R[];
        }
        if (sql.startsWith("SELECT * FROM inviteCache WHERE org_id = ?")) {
          const [org_id, boardIs, boardEq, now] = params;
          return invites
            .filter(
              (x) =>
                x["org_id"] === org_id &&
                (x["board_id"] === boardIs || x["board_id"] === boardEq) &&
                x["revoked_at_ms"] === null &&
                x["declined_at_ms"] === null &&
                num(x["expires_at_ms"]) > num(now) &&
                (x["single_use"] === 0 || x["used_by"] === null),
            )
            .sort((a, b) => num(b["created_at_ms"]) - num(a["created_at_ms"]))
            .map((r) => ({ ...r })) as R[];
        }
        if (sql.startsWith("SELECT * FROM sprintCache WHERE board_id = ?")) {
          return sprints
            .filter((r) => r["board_id"] === params[0])
            .sort(
              (a, b) =>
                num(a["created_at_ms"]) - num(b["created_at_ms"]) ||
                str(a["id"]).localeCompare(str(b["id"])),
            )
            .map((r) => ({ ...r })) as R[];
        }
        throw new Error(`DbMock: unexpected queryAll: ${sql}`);
      }),
  };

  return {
    boards,
    issues,
    comments,
    statusChanges,
    attachments,
    sprints,
    apiKeys,
    orgs,
    orgMembers,
    boardMembers,
    invites,
    orgAliases,
    profiles,
    storageConfigs,
    notificationConfigs,
    audienceKeys,
    keyGrants,
    sessionKeys,
    sessions,
    layer: Layer.succeed(Db, service),
  };
};
