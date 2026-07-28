// Shared in-memory Db mock for route tests, covering boardCache,
// issueCache, commentCache, and statusChangeCache.
//
// Same discipline as the boards.test.ts mock (the pattern Sona ratified):
// it interprets exactly the SQL the routers issue and THROWS on anything
// unexpected, so route/SQL drift fails loudly at test time instead of
// silently returning empty results.

import { Effect, Layer } from "effect";
import { Db, type DbService } from "../src/effects";

export type Row = Record<string, unknown>;

export interface DbMock {
  readonly boards: Row[];
  readonly issues: Row[];
  readonly comments: Row[];
  readonly statusChanges: Row[];
  readonly layer: Layer.Layer<Db>;
}

const num = (v: unknown): number => v as number;
const str = (v: unknown): string => String(v);

export const makeDbMock = (): DbMock => {
  const boards: Row[] = [];
  const issues: Row[] = [];
  const comments: Row[] = [];
  const statusChanges: Row[] = [];

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
          const [id, pubkey, slug, title, description, columns, labels, member_policy, is_encrypted, created_at_ms, updated_at_ms] = params;
          boards.push({ id, pubkey, slug, title, description, columns, labels, member_policy, is_encrypted, created_at_ms, updated_at_ms });
          return;
        }
        if (sql.startsWith("INSERT INTO issueCache")) {
          const [id, board_id, title, body, status, container, assignee_pubkey, priority, estimate, labels, github_links, created_at_ms, updated_at_ms, completed_at_ms] = params;
          issues.push({ id, board_id, title, body, status, container, assignee_pubkey, priority, estimate, labels, github_links, created_at_ms, updated_at_ms, completed_at_ms });
          return;
        }
        if (sql.startsWith("INSERT INTO commentCache")) {
          const [id, issue_id, author_pubkey, body, in_reply_to, created_at_ms] = params;
          comments.push({ id, issue_id, author_pubkey, body, in_reply_to, created_at_ms });
          return;
        }
        if (sql.startsWith("INSERT INTO statusChangeCache")) {
          const [id, issue_id, board_id, actor_pubkey, from_status, to_status, from_container, to_container, container_at_completion, occurred_at_ms] = params;
          statusChanges.push({ id, issue_id, board_id, actor_pubkey, from_status, to_status, from_container, to_container, container_at_completion, occurred_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE issueCache SET status = ?")) {
          const [status, updated_at_ms, completed_at_ms, id] = params;
          const row = issues.find((r) => r["id"] === id);
          if (row) Object.assign(row, { status, updated_at_ms, completed_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE issueCache SET container = ?")) {
          const [container, updated_at_ms, id] = params;
          const row = issues.find((r) => r["id"] === id);
          if (row) Object.assign(row, { container, updated_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE issueCache SET title = ?")) {
          const [title, body, status, assignee_pubkey, priority, estimate, labels, updated_at_ms, completed_at_ms, id] = params;
          const row = issues.find((r) => r["id"] === id);
          if (row) Object.assign(row, { title, body, status, assignee_pubkey, priority, estimate, labels, updated_at_ms, completed_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE boardCache SET")) {
          const [title, description, columns, labels, member_policy, updated_at_ms, id] = params;
          const row = boards.find((r) => r["id"] === id);
          if (row) Object.assign(row, { title, description, columns, labels, member_policy, updated_at_ms });
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
        throw new Error(`DbMock: unexpected execute: ${sql}`);
      }),
    queryFirst: <R>(sql: string, params: ReadonlyArray<unknown> = []) =>
      Effect.sync(() => {
        if (sql.startsWith("SELECT id FROM boardCache WHERE pubkey = ? AND slug = ?")) {
          const r = boards.find((x) => x["pubkey"] === params[0] && x["slug"] === params[1]);
          return (r ? { id: r["id"] } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM boardCache WHERE pubkey = ? AND slug = ?")) {
          const r = boards.find((x) => x["pubkey"] === params[0] && x["slug"] === params[1]);
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
        if (sql.startsWith("SELECT * FROM issueCache WHERE id = ?")) {
          const r = issues.find((x) => x["id"] === params[0]);
          return (r ? { ...r } : null) as R | null;
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
        throw new Error(`DbMock: unexpected queryFirst: ${sql}`);
      }),
    queryAll: <R>(sql: string, params: ReadonlyArray<unknown> = []) =>
      Effect.sync(() => {
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
        if (sql.startsWith("SELECT id, title FROM issueCache WHERE id IN")) {
          return issues
            .filter((r) => (params as unknown[]).includes(r["id"]))
            .map((r) => ({ id: r["id"], title: r["title"] })) as R[];
        }
        if (sql.startsWith("SELECT * FROM boardCache WHERE pubkey = ? ORDER BY")) {
          const rows = boards
            .filter((r) => r["pubkey"] === params[0])
            .sort(
              (a, b) =>
                num(b["updated_at_ms"]) - num(a["updated_at_ms"]) ||
                str(b["id"]).localeCompare(str(a["id"])),
            );
          return rows.slice(0, num(params[1])).map((r) => ({ ...r })) as R[];
        }
        throw new Error(`DbMock: unexpected queryAll: ${sql}`);
      }),
  };

  return { boards, issues, comments, statusChanges, layer: Layer.succeed(Db, service) };
};
