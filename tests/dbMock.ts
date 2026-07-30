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
  readonly sprintMemberships: Row[];
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
  readonly githubRules: Row[];
  readonly githubAudit: Row[];
  readonly githubDedup: Row[];
  readonly estimateHistory: Row[];
  readonly tideSnapshots: Row[];
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
  const sprintMemberships: Row[] = [];
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
  const githubRules: Row[] = [];
  const githubAudit: Row[] = [];
  const githubDedup: Row[] = [];
  const estimateHistory: Row[] = [];
  const tideSnapshots: Row[] = [];

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
    // Filters COMPOSE since phase 22, so this walks EVERY present clause in
    // the exact order routes/issues.ts appends them and advances the param
    // cursor once per clause. The previous early-return-on-first-match
    // shape silently mis-bound params the moment two filters were combined
    // (clause 2 read clause 1's value), which reads as an empty result
    // rather than an error — keep this list in lockstep with the route.
    let out = rows;
    let i = at;
    // The column_id clause embeds "... IS NULL AND status = ?", which makes
    // a naive includes("AND status = ?") fire for a request that has no
    // status filter at all — binding the container's param as a status and
    // silently emptying the result. Mask that clause out before probing for
    // the others; it is handled last, matching the route's param order.
    const COLUMN_CLAUSE = " AND (column_id = ? OR (column_id IS NULL AND status = ?))";
    const hasColumnClause = sql.includes(COLUMN_CLAUSE);
    const probe = hasColumnClause ? sql.replace(COLUMN_CLAUSE, "") : sql;
    if (probe.includes("AND status = ?")) {
      out = out.filter((r) => r["status"] === params[i]);
      i += 1;
    }
    if (probe.includes("AND container = ?")) {
      out = out.filter((r) => r["container"] === params[i]);
      i += 1;
    }
    if (probe.includes("AND assignee_pubkey = ?")) {
      out = out.filter((r) => r["assignee_pubkey"] === params[i]);
      i += 1;
    }
    if (probe.includes("json_each")) {
      out = out.filter((r) => (JSON.parse(str(r["labels"])) as string[]).includes(str(params[i])));
      i += 1;
    }
    if (probe.includes("AND sprint_id = ?")) {
      out = out.filter((r) => r["sprint_id"] === params[i]);
      i += 1;
    }
    if (probe.includes("title LIKE ?")) {
      // Route sends the same needle twice (title OR body), already
      // %-wrapped and escaped.
      const needle = str(params[i]).replace(/^%|%$/g, "").replace(/\\([\\%_])/g, "$1");
      out = out.filter(
        (r) =>
          str(r["title"]).toLowerCase().includes(needle.toLowerCase()) ||
          str(r["body"] ?? "").toLowerCase().includes(needle.toLowerCase()),
      );
      i += 2;
    }
    if (hasColumnClause) {
      const colId = params[i];
      const colName = params[i + 1];
      out = out.filter(
        (r) => r["column_id"] === colId || (r["column_id"] == null && r["status"] === colName),
      );
      i += 2;
    }
    return [out, i];
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
        // ── EFB-22 sprint tide ────────────────────────────────────────────
        if (sql.startsWith("INSERT INTO issueEstimateHistory")) {
          const [id, issue_id, occurred_at_ms, prev_estimate, next_estimate, actor_pubkey] = params;
          estimateHistory.push({ id, issue_id, occurred_at_ms, prev_estimate, next_estimate, actor_pubkey });
          return;
        }
        if (sql.startsWith("INSERT INTO sprintTideSnapshot")) {
          const [id, sprint_id, board_id, day_start_ms, committed_pts, done_pts, remaining_pts, adds_today, drops_today, computed_at_ms] = params;
          // Mirrors the two partial unique indexes from migration 0021.
          const clash = tideSnapshots.some((s) =>
            sprint_id === null
              ? s["sprint_id"] === null &&
                s["board_id"] === board_id &&
                s["day_start_ms"] === day_start_ms
              : s["sprint_id"] === sprint_id && s["day_start_ms"] === day_start_ms,
          );
          if (clash) {
            throw new Error("DbMock: UNIQUE violation on sprintTideSnapshot (subject, day)");
          }
          tideSnapshots.push({ id, sprint_id, board_id, day_start_ms, committed_pts, done_pts, remaining_pts, adds_today, drops_today, computed_at_ms, substrate_event_id: null });
          return;
        }
        if (sql.startsWith("UPDATE sprintTideSnapshot") && sql.includes("SET committed_pts")) {
          const [committed_pts, done_pts, remaining_pts, adds_today, drops_today, computed_at_ms, id] = params;
          const row = tideSnapshots.find((s) => s["id"] === id);
          if (row !== undefined) {
            Object.assign(row, { committed_pts, done_pts, remaining_pts, adds_today, drops_today, computed_at_ms });
          }
          return;
        }
        if (sql.startsWith("UPDATE sprintTideSnapshot SET substrate_event_id = ?")) {
          const [substrate_event_id, id] = params;
          const row = tideSnapshots.find((s) => s["id"] === id);
          if (row !== undefined) row["substrate_event_id"] = substrate_event_id;
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
        if (sql.startsWith("INSERT INTO inviteCache (id, code, org_id, board_id, role, invited_by, invited_email, bind_to_email, bind_to_pubkey, expires_at_ms, single_use, created_at_ms)")) {
          const [id, code, org_id, board_id, role, invited_by, invited_email, bind_to_email, bind_to_pubkey, expires_at_ms, single_use, created_at_ms] = params;
          invites.push({ id, code, org_id, board_id, role, invited_by, invited_email, bind_to_email, bind_to_pubkey, expires_at_ms, single_use, used_by: null, used_at_ms: null, revoked_at_ms: null, declined_at_ms: null, created_at_ms });
          return;
        }
        if (sql.startsWith("INSERT INTO inviteCache")) {
          const [id, code, org_id, board_id, role, invited_by, invited_email, bind_to_email, expires_at_ms, single_use, created_at_ms] = params;
          invites.push({ id, code, org_id, board_id, role, invited_by, invited_email, bind_to_email, bind_to_pubkey: null, expires_at_ms, single_use, used_by: null, used_at_ms: null, revoked_at_ms: null, declined_at_ms: null, created_at_ms });
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
        // Phase 21 webhook transitions. These MUST precede the generic
        // status+column handler below: its prefix also matches them, and
        // the completed_at_ms = NULL variant carries one FEWER param, so
        // falling through would bind `id` to undefined and silently no-op.
        if (
          sql.startsWith(
            "UPDATE issueCache SET status = ?, column_id = ?, updated_at_ms = ?, completed_at_ms = COALESCE(completed_at_ms, ?)",
          )
        ) {
          const [status, column_id, updated_at_ms, completedFallback, id] = params;
          const row = issues.find((r) => r["id"] === id);
          if (row) {
            Object.assign(row, {
              status,
              column_id,
              updated_at_ms,
              completed_at_ms: row["completed_at_ms"] ?? completedFallback,
            });
          }
          return;
        }
        if (
          sql.startsWith(
            "UPDATE issueCache SET status = ?, column_id = ?, updated_at_ms = ?, completed_at_ms = NULL",
          )
        ) {
          const [status, column_id, updated_at_ms, id] = params;
          const row = issues.find((r) => r["id"] === id);
          if (row) Object.assign(row, { status, column_id, updated_at_ms, completed_at_ms: null });
          return;
        }
        if (sql.startsWith("UPDATE issueCache SET external_state = ?")) {
          const [external_state, external_state_updated_at_ms, updated_at_ms, id] = params;
          const row = issues.find((r) => r["id"] === id);
          if (row) {
            Object.assign(row, { external_state, external_state_updated_at_ms, updated_at_ms });
          }
          return;
        }
        if (sql.startsWith("UPDATE issueCache SET assignee_pubkey = ?, updated_at_ms = ? WHERE id = ?")) {
          const [assignee_pubkey, updated_at_ms, id] = params;
          const row = issues.find((r) => r["id"] === id);
          if (row) Object.assign(row, { assignee_pubkey, updated_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE issueCache SET labels = ?, updated_at_ms = ? WHERE id = ?")) {
          const [labels, updated_at_ms, id] = params;
          const row = issues.find((r) => r["id"] === id);
          if (row) Object.assign(row, { labels, updated_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE issueCache SET github_links = ?, updated_at_ms = ? WHERE id = ?")) {
          const [github_links, updated_at_ms, id] = params;
          const row = issues.find((r) => r["id"] === id);
          if (row) Object.assign(row, { github_links, updated_at_ms });
          return;
        }
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
        // Phase 21 GitHub columns — like the audience/prefix/archive
        // handlers above, these MUST precede the generic "UPDATE
        // boardCache SET" fallback, which shares their prefix and would
        // otherwise bind their params to the wrong columns.
        if (sql.startsWith("UPDATE boardCache SET github_repo = NULL")) {
          const [updated_at_ms, id] = params;
          const row = boards.find((r) => r["id"] === id);
          if (row) {
            Object.assign(row, {
              github_repo: null,
              github_webhook_secret_ciphertext: null,
              updated_at_ms,
            });
          }
          return;
        }
        if (sql.startsWith("UPDATE boardCache SET github_repo = ?")) {
          const [github_repo, github_rule_preset, external_state_config, updated_at_ms, id] = params;
          const row = boards.find((r) => r["id"] === id);
          if (row) {
            Object.assign(row, {
              github_repo,
              github_rule_preset,
              external_state_config,
              updated_at_ms,
            });
          }
          return;
        }
        if (sql.startsWith("UPDATE boardCache SET github_webhook_secret_ciphertext = ?")) {
          const [github_webhook_secret_ciphertext, updated_at_ms, id] = params;
          const row = boards.find((r) => r["id"] === id);
          if (row) Object.assign(row, { github_webhook_secret_ciphertext, updated_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE boardCache SET github_rule_preset = 'custom'")) {
          const [updated_at_ms, id] = params;
          const row = boards.find((r) => r["id"] === id);
          if (row) Object.assign(row, { github_rule_preset: "custom", updated_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE boardCache SET title = ?, description = ?, columns = ?, labels = ?, member_policy = ?, issue_prefix = ?, visibility = ?, default_sprint_days = ?, done_window_days = ?, updated_at_ms = ? WHERE id = ?")) {
          const [title, description, columns, labels, member_policy, issue_prefix, visibility, default_sprint_days, done_window_days, updated_at_ms, id] = params;
          const row = boards.find((r) => r["id"] === id);
          if (row) Object.assign(row, { title, description, columns, labels, member_policy, issue_prefix, visibility, default_sprint_days, done_window_days, updated_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE boardCache SET title = ?, description = ?, columns = ?, labels = ?, member_policy = ?, issue_prefix = ?, visibility = ?, default_sprint_days = ?, updated_at_ms = ? WHERE id = ?")) {
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
        // Phase 21d: standalone points_committed_start backfill on read.
        if (sql.startsWith("UPDATE sprintCache SET points_committed_start = ? WHERE id = ?")) {
          const row = sprints.find((r) => r["id"] === params[1]);
          if (row) row["points_committed_start"] = params[0];
          return;
        }
        // Phase 21b: start snapshots points_committed_start.
        if (sql.startsWith("UPDATE sprintCache SET status = 'active', started_at_ms = ?, points_committed_start = ? WHERE id = ?")) {
          const row = sprints.find((r) => r["id"] === params[2]);
          if (row) Object.assign(row, {
            status: "active",
            started_at_ms: params[0],
            points_committed_start: params[1],
          });
          return;
        }
        if (sql.startsWith("UPDATE sprintCache SET status = 'completed', completed_at_ms = ? WHERE id = ?")) {
          const row = sprints.find((r) => r["id"] === params[1]);
          if (row) Object.assign(row, { status: "completed", completed_at_ms: params[0] });
          return;
        }
        // Phase 21b: complete snapshots points_completed / points_carried.
        if (sql.startsWith("UPDATE sprintCache SET status = 'completed', completed_at_ms = ?, points_completed = ?, points_carried = ? WHERE id = ?")) {
          const row = sprints.find((r) => r["id"] === params[3]);
          if (row) Object.assign(row, {
            status: "completed",
            completed_at_ms: params[0],
            points_completed: params[1],
            points_carried: params[2],
          });
          return;
        }
        // ── phase 21a: sprint membership audit + adds counter + delete ──
        if (sql.startsWith("INSERT INTO sprintMembership")) {
          const [id, sprint_id, issue_id, added_at_ms] = params;
          sprintMemberships.push({
            id,
            sprint_id,
            issue_id,
            added_at_ms,
            removed_at_ms: null,
            was_completed_in_sprint: 0,
            carried_to_sprint_id: null,
          });
          return;
        }
        if (sql.startsWith("UPDATE sprintCache SET adds_mid_sprint = adds_mid_sprint + 1 WHERE id = ?")) {
          const row = sprints.find((r) => r["id"] === params[0]);
          if (row) row["adds_mid_sprint"] = ((row["adds_mid_sprint"] as number) ?? 0) + 1;
          return;
        }
        if (sql.startsWith("UPDATE sprintMembership SET removed_at_ms = ? WHERE sprint_id = ? AND issue_id = ? AND removed_at_ms IS NULL")) {
          const [removed_at_ms, sprint_id, issue_id] = params;
          for (const m of sprintMemberships) {
            if (m["sprint_id"] === sprint_id && m["issue_id"] === issue_id && m["removed_at_ms"] === null) {
              m["removed_at_ms"] = removed_at_ms;
            }
          }
          return;
        }
        // Phase 21b: complete-endpoint variants that mark done/carried.
        if (sql.startsWith("UPDATE sprintMembership SET removed_at_ms = ?, was_completed_in_sprint = 1 WHERE sprint_id = ? AND issue_id = ? AND removed_at_ms IS NULL")) {
          const [removed_at_ms, sprint_id, issue_id] = params;
          for (const m of sprintMemberships) {
            if (m["sprint_id"] === sprint_id && m["issue_id"] === issue_id && m["removed_at_ms"] === null) {
              Object.assign(m, { removed_at_ms, was_completed_in_sprint: 1 });
            }
          }
          return;
        }
        if (sql.startsWith("UPDATE sprintMembership SET removed_at_ms = ?, carried_to_sprint_id = ? WHERE sprint_id = ? AND issue_id = ? AND removed_at_ms IS NULL")) {
          const [removed_at_ms, carried_to_sprint_id, sprint_id, issue_id] = params;
          for (const m of sprintMemberships) {
            if (m["sprint_id"] === sprint_id && m["issue_id"] === issue_id && m["removed_at_ms"] === null) {
              Object.assign(m, { removed_at_ms, carried_to_sprint_id });
            }
          }
          return;
        }
        if (sql.startsWith("UPDATE issueCache SET sprint_id = ?, updated_at_ms = ? WHERE id = ?")) {
          const [sprint_id, updated_at_ms, id] = params;
          const row = issues.find((r) => r["id"] === id);
          if (row) Object.assign(row, { sprint_id, updated_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE issueCache SET sprint_id = NULL, updated_at_ms = ? WHERE sprint_id = ?")) {
          const [updated_at_ms, sprint_id] = params;
          for (const row of issues) {
            if (row["sprint_id"] === sprint_id) Object.assign(row, { sprint_id: null, updated_at_ms });
          }
          return;
        }
        if (sql.startsWith("DELETE FROM sprintMembership WHERE sprint_id = ?")) {
          const [sprint_id] = params;
          for (let i = sprintMemberships.length - 1; i >= 0; i--) {
            if (sprintMemberships[i]!["sprint_id"] === sprint_id) sprintMemberships.splice(i, 1);
          }
          return;
        }
        if (sql.startsWith("DELETE FROM sprintCache WHERE id = ?")) {
          const [id] = params;
          const idx = sprints.findIndex((r) => r["id"] === id);
          if (idx >= 0) sprints.splice(idx, 1);
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
        if (sql.startsWith("DELETE FROM githubWebhookRules WHERE board_id = ?")) {
          for (let i = githubRules.length - 1; i >= 0; i--) {
            if (githubRules[i]?.["board_id"] === params[0]) githubRules.splice(i, 1);
          }
          return;
        }
        if (sql.startsWith("INSERT INTO githubWebhookRules")) {
          const [id, board_id, bucket, priority, when_json, do_json, enabled, created_at_ms, updated_at_ms] = params;
          githubRules.push({ id, board_id, bucket, priority, when_json, do_json, enabled, created_at_ms, updated_at_ms });
          return;
        }
        if (sql.startsWith("INSERT INTO githubWebhookAudit")) {
          const [id, board_id, delivery_id, event_type, action, matched_issue_ids_json, matched_rule_ids_json, actions_taken_json, error, received_at_ms] = params;
          githubAudit.push({ id, board_id, delivery_id, event_type, action, matched_issue_ids_json, matched_rule_ids_json, actions_taken_json, error, received_at_ms });
          return;
        }
        if (sql.startsWith("INSERT INTO githubWebhookDedup")) {
          const [board_id, delivery_id, received_at_ms] = params;
          if (
            githubDedup.some(
              (r) => r["board_id"] === board_id && r["delivery_id"] === delivery_id,
            )
          ) {
            throw new Error("DbMock: UNIQUE violation on githubWebhookDedup PK");
          }
          githubDedup.push({ board_id, delivery_id, received_at_ms });
          return;
        }
        if (sql.startsWith("DELETE FROM githubWebhookDedup WHERE received_at_ms < ?")) {
          for (let i = githubDedup.length - 1; i >= 0; i--) {
            if (num(githubDedup[i]?.["received_at_ms"]) < num(params[0])) githubDedup.splice(i, 1);
          }
          return;
        }
        // Profile OAuth-seed persistence (regression fix for missing PFP on
        // cards): the /profile/me handler upserts picture into profileCache
        // when the JWT carries one and the cached row has picture=null.
        if (sql.startsWith("UPDATE profileCache SET picture = ?, updated_at_ms = ?, fetched_at_ms = ? WHERE pubkey = ? AND picture IS NULL")) {
          const [picture, updated_at_ms, fetched_at_ms, pubkey] = params;
          const existing = profiles.find((r) => r["pubkey"] === pubkey);
          if (existing !== undefined) {
            if (existing["picture"] === null || existing["picture"] === undefined) {
              Object.assign(existing, { picture, updated_at_ms, fetched_at_ms });
            }
          } else {
            profiles.push({
              pubkey,
              name: null,
              display_name: null,
              picture,
              about: null,
              event_id: null,
              updated_at_ms,
              fetched_at_ms,
            });
          }
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
        // Phase 21b: auto-pick oldest OTHER planning sprint for carry-over.
        if (sql.startsWith("SELECT id FROM sprintCache WHERE board_id = ? AND status = 'planning' AND id != ? ORDER BY created_at_ms ASC LIMIT 1")) {
          const [board_id, exclude_id] = params;
          const candidate = sprints
            .filter((x) => x["board_id"] === board_id && x["status"] === "planning" && x["id"] !== exclude_id)
            .sort((a, b) => (a["created_at_ms"] as number) - (b["created_at_ms"] as number))[0];
          return (candidate ? { id: candidate["id"] } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM issueCache WHERE board_id = ? AND short_id = ?")) {
          const r = issues.find(
            (x) => x["board_id"] === params[0] && x["short_id"] === params[1],
          );
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT delivery_id FROM githubWebhookDedup")) {
          const r = githubDedup.find(
            (x) => x["board_id"] === params[0] && x["delivery_id"] === params[1],
          );
          return (r ? { delivery_id: r["delivery_id"] } : null) as R | null;
        }
        if (sql.startsWith("SELECT pubkey FROM boardMemberCache WHERE board_id = ? AND pubkey = ?")) {
          const r = boardMembers.find(
            (x) => x["board_id"] === params[0] && x["pubkey"] === params[1],
          );
          return (r ? { pubkey: r["pubkey"] } : null) as R | null;
        }
        // ── EFB-22 sprint tide ────────────────────────────────────────────
        if (sql.startsWith("SELECT id FROM sprintTideSnapshot WHERE board_id = ? AND sprint_id IS NULL")) {
          const r = tideSnapshots.find(
            (x) =>
              x["board_id"] === params[0] &&
              x["sprint_id"] === null &&
              x["day_start_ms"] === params[1],
          );
          return (r ? { id: r["id"] } : null) as R | null;
        }
        if (sql.startsWith("SELECT id FROM sprintTideSnapshot WHERE sprint_id = ?")) {
          const r = tideSnapshots.find(
            (x) => x["sprint_id"] === params[0] && x["day_start_ms"] === params[1],
          );
          return (r ? { id: r["id"] } : null) as R | null;
        }
        throw new Error(`DbMock: unexpected queryFirst: ${sql}`);
      }),
    queryAll: <R>(sql: string, params: ReadonlyArray<unknown> = []) =>
      Effect.sync(() => {
        // Reorder's column-mates query — must precede the generic
        // board-list handler, which shares its prefix.
        // Reorder's column-mates fetch (issues.ts:1030). Since phase 22 the
        // paged LIST query can begin with this exact prefix too — same
        // board/container/column clauses — so this branch must additionally
        // require the ABSENCE of an ORDER BY, which only the list query
        // carries. Without that guard this handler swallows the list query
        // and returns it unfiltered, unordered and unlimited: the caller
        // then sees rows.length > limit forever and the scroll never ends.
        if (
          sql.startsWith("SELECT * FROM issueCache WHERE board_id = ? AND container = ? AND (column_id = ?") &&
          !sql.includes("ORDER BY")
        ) {
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
        // Phase 21+ start-sprint sweep: every active-container issue.
        if (sql === "SELECT * FROM issueCache WHERE board_id = ? AND container = 'active'") {
          return issues
            .filter((r) => r["board_id"] === params[0] && r["container"] === "active")
            .map((r) => ({ ...r })) as R[];
        }
        // Phase 21a: delete-planning-sprint enumeration.
        if (sql === "SELECT * FROM issueCache WHERE sprint_id = ?") {
          return issues
            .filter((r) => (r["sprint_id"] ?? null) === params[0])
            .map((r) => ({ ...r })) as R[];
        }
        // Phase 21b: complete-sprint estimates snapshot + archive JOIN +
        // next-planning-sprint pick.
        if (sql === "SELECT estimate FROM issueCache WHERE sprint_id = ?") {
          return issues
            .filter((r) => (r["sprint_id"] ?? null) === params[0])
            .map((r) => ({ estimate: r["estimate"] ?? null })) as R[];
        }
        // Phase 21d: velocity — done issues within window.
        if (sql === "SELECT estimate FROM issueCache WHERE board_id = ? AND completed_at_ms IS NOT NULL AND completed_at_ms >= ?") {
          return issues
            .filter((r) => r["board_id"] === params[0] && r["completed_at_ms"] != null && (r["completed_at_ms"] as number) >= (params[1] as number))
            .map((r) => ({ estimate: r["estimate"] ?? null })) as R[];
        }
        if (sql.startsWith("SELECT m.*, i.title, i.short_id, i.status, i.column_id, i.estimate, i.assignee_pubkey, i.priority FROM sprintMembership m LEFT JOIN issueCache i")) {
          const [sprint_id] = params;
          return sprintMemberships
            .filter((m) => m["sprint_id"] === sprint_id)
            .sort((a, b) => (a["added_at_ms"] as number) - (b["added_at_ms"] as number))
            .map((m) => {
              const iss = issues.find((r) => r["id"] === m["issue_id"]);
              return {
                ...m,
                title: iss?.["title"] ?? null,
                short_id: iss?.["short_id"] ?? null,
                status: iss?.["status"] ?? null,
                column_id: iss?.["column_id"] ?? null,
                estimate: iss?.["estimate"] ?? null,
                assignee_pubkey: iss?.["assignee_pubkey"] ?? null,
                priority: iss?.["priority"] ?? null,
              };
            }) as R[];
        }
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
          // Phase 22 position stream: ORDER BY (position IS NULL) ASC,
          // position ASC, id DESC. The NULL-position tail sorts LAST — a
          // scalar comparison cannot express that, which is why both the
          // sort and the cursor below work on the (isNull, value, id) tuple.
          const positionStream = sql.includes("ORDER BY (position IS NULL) ASC");
          if (positionStream) {
            rows = [...rows].sort((a, b) => {
              const an = a["position"] == null ? 1 : 0;
              const bn = b["position"] == null ? 1 : 0;
              if (an !== bn) return an - bn;
              const ap = num(a["position"] ?? 0);
              const bp = num(b["position"] ?? 0);
              if (ap !== bp) return ap - bp;
              return str(b["id"]).localeCompare(str(a["id"]));
            });
          }
          if (sql.includes("AND ((position IS NULL) > ?")) {
            const isNull = num(params[at]);
            const value = num(params[at + 2]);
            const afterId = str(params[at + 5]);
            at += 6;
            rows = rows.filter((r) => {
              const rn = r["position"] == null ? 1 : 0;
              const rp = num(r["position"] ?? 0);
              if (rn !== isNull) return rn > isNull;
              if (rp !== value) return rp > value;
              return str(r["id"]) < afterId;
            });
          }
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
        if (
          sql.startsWith(
            "SELECT * FROM boardCache WHERE org_id = ? AND visibility = 'private' AND audience_pubkey IS NOT NULL",
          )
        ) {
          return boards
            .filter(
              (r) =>
                r["org_id"] === params[0] &&
                r["visibility"] === "private" &&
                r["audience_pubkey"] != null,
            )
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
        if (sql.startsWith("SELECT * FROM githubWebhookRules WHERE board_id = ?")) {
          return githubRules
            .filter((r) => r["board_id"] === params[0])
            .sort(
              (a, b) =>
                str(a["bucket"]).localeCompare(str(b["bucket"])) ||
                num(a["priority"]) - num(b["priority"]),
            )
            .map((r) => ({ ...r })) as R[];
        }
        if (sql.startsWith("SELECT * FROM githubWebhookAudit WHERE board_id = ?")) {
          // Mirrors the router's dynamic WHERE: board, then the optional
          // event_type / errors_only / since filters, then LIMIT last.
          const rest = [...params];
          const boardId = rest.shift();
          const limit = num(rest.pop());
          let rows = githubAudit.filter((r) => r["board_id"] === boardId);
          if (sql.includes("event_type = ?")) {
            const ev = rest.shift();
            rows = rows.filter((r) => r["event_type"] === ev);
          }
          if (sql.includes("error IS NOT NULL")) {
            rows = rows.filter((r) => r["error"] !== null && r["error"] !== undefined);
          }
          if (sql.includes("received_at_ms >= ?")) {
            const since = num(rest.shift());
            rows = rows.filter((r) => num(r["received_at_ms"]) >= since);
          }
          return rows
            .sort((a, b) => num(b["received_at_ms"]) - num(a["received_at_ms"]))
            .slice(0, limit)
            .map((r) => ({ ...r })) as R[];
        }
        // ── EFB-22 sprint tide ────────────────────────────────────────────
        if (sql.startsWith("SELECT s.id AS sprint_id, s.board_id")) {
          return sprints
            .filter((s) => s["status"] === "active")
            .map((s) => ({
              sprint_id: s["id"],
              board_id: s["board_id"],
              sprint_created_at_ms: s["created_at_ms"],
              completed_at_ms: s["completed_at_ms"] ?? null,
            })) as R[];
        }
        if (sql === "SELECT id FROM boardCache") {
          return boards.map((b) => ({ id: b["id"] })) as R[];
        }
        if (sql.startsWith("SELECT issue_id, added_at_ms, removed_at_ms FROM sprintMembership WHERE sprint_id = ?")) {
          return sprintMemberships
            .filter((m) => m["sprint_id"] === params[0])
            .map((m) => ({
              issue_id: m["issue_id"],
              added_at_ms: m["added_at_ms"],
              removed_at_ms: m["removed_at_ms"] ?? null,
            })) as R[];
        }
        if (sql.startsWith("SELECT id, estimate, status, created_at_ms FROM issueCache WHERE id IN")) {
          const wanted = new Set(params.map(str));
          return issues
            .filter((i) => wanted.has(str(i["id"])))
            .map((i) => ({
              id: i["id"],
              estimate: i["estimate"] ?? null,
              status: i["status"],
              created_at_ms: i["created_at_ms"],
            })) as R[];
        }
        if (sql.startsWith("SELECT issue_id, occurred_at_ms, prev_estimate, next_estimate FROM issueEstimateHistory WHERE issue_id IN")) {
          const wanted = new Set(params.map(str));
          return estimateHistory
            .filter((e) => wanted.has(str(e["issue_id"])))
            .map((e) => ({
              issue_id: e["issue_id"],
              occurred_at_ms: e["occurred_at_ms"],
              prev_estimate: e["prev_estimate"] ?? null,
              next_estimate: e["next_estimate"] ?? null,
            })) as R[];
        }
        if (sql.startsWith("SELECT issue_id, occurred_at_ms, from_status, to_status FROM statusChangeCache WHERE issue_id IN")) {
          const wanted = new Set(params.map(str));
          return statusChanges
            .filter((s) => wanted.has(str(s["issue_id"])))
            .map((s) => ({
              issue_id: s["issue_id"],
              occurred_at_ms: s["occurred_at_ms"],
              from_status: s["from_status"] ?? null,
              to_status: s["to_status"] ?? null,
            })) as R[];
        }
        // Kanban tide scope: board issues that are either still open or moved
        // recently enough for the Done window to still cover them. Params are
        // [board_id, rangeEnd, ...openColumnNames, activitySince].
        if (sql.startsWith("SELECT i.id, i.estimate, i.status, i.created_at_ms")) {
          const board_id = params[0];
          const rangeEnd = num(params[1]);
          const activitySince = num(params[params.length - 1]);
          const openNames = new Set(params.slice(2, params.length - 1).map(str));
          return issues
            .filter((i) => i["board_id"] === board_id && num(i["created_at_ms"]) <= rangeEnd)
            .filter(
              (i) =>
                openNames.has(str(i["status"])) ||
                statusChanges.some(
                  (s) =>
                    s["issue_id"] === i["id"] && num(s["occurred_at_ms"]) >= activitySince,
                ),
            )
            .map((i) => ({
              id: i["id"],
              estimate: i["estimate"] ?? null,
              status: i["status"],
              created_at_ms: i["created_at_ms"],
            })) as R[];
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
    sprintMemberships,
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
    githubRules,
    githubAudit,
    githubDedup,
    estimateHistory,
    tideSnapshots,
    layer: Layer.succeed(Db, service),
  };
};
