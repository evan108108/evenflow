// EFB-15 — CSV import: bulk issue creation from the canonical shape.
//
// A NEW route family, so every body comes through `parseRouteBody` from the
// first commit and nothing here is added to `scripts/boundary-allowlist.json`,
// which is closed to new entries. See docs/BOUNDARY_DISCIPLINE.md.
//
// The shape/state division that document insists on is the organizing idea of
// this whole file, because a bulk endpoint is where it finally has teeth:
//
//   src/lib/csv-canonical.ts  answers everything decidable from a row ALONE.
//                             Its failure is a 400 and the batch never starts.
//   this file                 answers everything that needs the BOARD — which
//                             column is "In Review" here, who is on the roster,
//                             what has already been imported — and reports
//                             those per row, because a 500-row paste must not
//                             die on row 3.
//
// ── THE 100-PARAMETER WALL ───────────────────────────────────────────────
//
// D1 accepts at most 100 bound parameters per statement. Verified empirically
// against the local binding (101 fails with "too many SQL variables"), and it
// matches Cloudflare's documented limit, so it is a production constraint and
// not a Miniflare artifact.
//
// That single number dictates the write strategy below. The obvious
// implementation — reuse POST /issues per row — costs one UPDATE…RETURNING to
// claim a short id, one INSERT, and one status-change INSERT per row, so a
// 1000-row import is ~3000 sequential D1 round trips inside one Worker
// invocation. Instead:
//
//   * short ids are claimed as ONE contiguous block, in one statement
//   * issues INSERT multi-row, chunked to stay under 100 params
//   * status changes likewise
//   * the duplicate pre-check reads in chunked IN() batches
//
// which puts a 1000-row import at roughly 360 statements rather than 3000.
//
// ── WHY STATUS-CHANGE ROWS ARE WRITTEN, DESPITE THE COST ─────────────────
//
// Per-issue BOARD EVENTS are suppressed for imports (see `issues.imported` in
// durable-objects/board-events.ts) — 1000 of those would storm every open tab
// and bury webhook subscribers behind a 50-per-minute sweep, to describe one
// user action.
//
// `statusChangeCache` rows are NOT the same thing and are written in full. They
// are not a notification; they are what the tide and velocity computations read
// (lib/tide/facts.ts). Skipping them would leave an imported backlog invisible
// to `adds_today` — numbers that are quietly wrong rather than obviously
// missing, which is the failure mode this codebase treats as the worst one.

import { Hono } from "hono";
import type { Context } from "hono";
import { Clock, Data, Effect, Exit } from "effect";
import { Audience, AuditLog, BoardEmitter, Db, DbError, bootstrap } from "../effects";
import { emitSecureBoardEvent } from "../audiences";
import { boardMemberPubkeys } from "../audiences";
import type { AppHonoEnv, LayerFor } from "../http";
import {
  ForbiddenError,
  UnauthorizedError,
  callerPubkey,
  requireCaller,
  resolveBoardScope,
  type BoardOwnershipError,
} from "../authz";
import { ValidationError } from "./errors";
import { parseRouteBody } from "../lib/route-body";
import { canonicalizeIdentityRef } from "../lib/identity";
import {
  MAX_IMPORT_ROWS,
  PostBulkIssuesBody,
  type ImportRowResult,
} from "../lib/csv-canonical";
import { DEFAULT_ISSUE_TYPE, enabledColumns, type Column } from "../columns";
import { derivePrefix, uniquePrefix } from "../slug";
import { POSITION_STEP } from "./issues";
import type { BoardShape } from "../shapes";

/** D1's hard ceiling on bound parameters in one statement. See the header. */
const MAX_BOUND_PARAMS = 100;

/** Columns in the issueCache INSERT below — keep in lockstep with it. */
const ISSUE_INSERT_COLUMNS = 21;
/** Columns in the statusChangeCache INSERT below — keep in lockstep with it. */
const STATUS_CHANGE_INSERT_COLUMNS = 10;

const ISSUE_ROWS_PER_STATEMENT = Math.floor(MAX_BOUND_PARAMS / ISSUE_INSERT_COLUMNS);
const STATUS_ROWS_PER_STATEMENT = Math.floor(MAX_BOUND_PARAMS / STATUS_CHANGE_INSERT_COLUMNS);
/** One parameter is spent on board_id, so the IN() list gets the rest. */
const DEDUP_LOOKUP_CHUNK = MAX_BOUND_PARAMS - 1;

/**
 * How long a completed import can be replayed by re-POSTing its import_id.
 *
 * Long enough to cover a user retrying after a dropped connection, a flaky
 * network, or closing and reopening a laptop; short enough that the stored
 * response bodies do not accumulate. Beyond it, the same import_id is treated
 * as new — which is safe, because `external_url` dedup then skips every row
 * that actually landed.
 */
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

class NotFoundError extends Data.TaggedError("NotFoundError")<{ readonly reason: string }> {}

type ImportFailure =
  | ValidationError
  | NotFoundError
  | ForbiddenError
  | UnauthorizedError
  | BoardOwnershipError
  | DbError;

interface ImportRecord {
  readonly id: string;
  readonly board_id: string;
  readonly imported_by_pubkey: string;
  readonly imported_at_ms: number;
  readonly row_count: number;
  readonly created_count: number;
  readonly skipped_count: number;
  readonly failed_count: number;
  readonly unmapped_assignees: number;
}

/**
 * Resolve a status NAME to a column on THIS board, case- and
 * whitespace-insensitively.
 *
 * The tolerance is the point. `status` in a canonical CSV is a column name, and
 * the same board is spelled "Todo" by one exporter and "todo " by another. What
 * this does NOT do is guess: an unresolvable name is reported and the row is
 * skipped, never coerced into the first column or used to create a new one.
 * Silently landing an issue somewhere the user did not ask for is worse than
 * telling them the name did not match.
 *
 * Enabled columns win over disabled ones with the same folded name, matching
 * `columnByName`'s precedence — an import should land where the board actually
 * renders, not in a hidden column.
 */
const resolveStatusColumn = (
  columns: ReadonlyArray<Column>,
  name: string,
): Column | undefined => {
  const folded = name.trim().toLowerCase();
  return (
    columns.find((c) => c.enabled && c.name.trim().toLowerCase() === folded) ??
    columns.find((c) => c.name.trim().toLowerCase() === folded)
  );
};

const chunk = <T>(items: ReadonlyArray<T>, size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** A row that survived resolution and is ready to be written. */
interface PlannedIssue {
  readonly row: number;
  readonly id: string;
  readonly title: string;
  readonly body: string | null;
  readonly type: string;
  readonly column: Column;
  readonly container: string;
  readonly assignee: string | null;
  readonly assigneeSkipped: string | null;
  readonly estimate: number | null;
  readonly labels: ReadonlyArray<string>;
  readonly externalUrl: string | null;
  readonly createdAtMs: number;
  readonly completedAtMs: number | null;
}

export const makeImportsRouter = (layerFor?: LayerFor) => {
  const app = new Hono<AppHonoEnv>();
  const layer = (c: Context<AppHonoEnv>) =>
    layerFor === undefined ? bootstrap(c.env) : layerFor(c.env);

  const errorResponse = (c: Context<AppHonoEnv>, cause: unknown) => {
    const e = cause as { _tag?: string; reason?: string };
    const tag = String(e?._tag ?? "");
    const reason = e?.reason ?? "error";
    if (tag === "UnauthorizedError") return c.json({ error: "unauthorized", reason }, 401);
    if (tag === "ForbiddenError") return c.json({ error: "forbidden", reason }, 403);
    if (tag === "NotFoundError" || tag === "BoardOwnershipError") {
      return c.json({ error: "not-found", reason }, 404);
    }
    if (tag === "ValidationError") return c.json({ error: "invalid-body", reason }, 400);
    return c.json({ error: "internal", reason: "internal" }, 500);
  };

  const run = <A>(
    c: Context<AppHonoEnv>,
    program: Effect.Effect<A, ImportFailure, Db | AuditLog | BoardEmitter | Audience>,
    ok: (a: A) => Response,
  ) =>
    Effect.runPromise(Effect.exit(Effect.provide(program, layer(c)))).then((exit) =>
      Exit.isSuccess(exit)
        ? ok(exit.value)
        : errorResponse(c, (exit.cause as { error?: unknown }).error ?? exit.cause),
    );

  const boardScope = (c: Context<AppHonoEnv>, minRole: string) =>
    Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const params = c.req.param() as Record<string, string | undefined>;
      const scope = yield* resolveBoardScope(
        { org_slug: params["org_slug"], slug: params["slug"] ?? "" },
        callerPubkey(claims),
        minRole,
      );
      return { ...scope, caller: callerPubkey(claims), claims };
    });

  // ── POST /boards/:slug/issues/bulk ──────────────────────────────────────
  app.post("/boards/:slug/issues/bulk", (c) =>
    run(
      c,
      Effect.gen(function* () {
        const { board, caller, claims } = yield* boardScope(c, "contributor");

        // The ONE door. A row-level shape problem comes back as
        // `issues-rows-7-14-22`, naming the offending indices — the schema
        // produces that itself (see `ImportIssueRows`), so this handler never
        // needs a second look at the raw body. That matters beyond tidiness:
        // reading the body again here would make this route call both
        // parseRouteBody and a raw reader, which `check:boundary` rejects
        // outright, and rightly — it cannot distinguish a harmless diagnostic
        // from a validation bypass.
        const body = yield* parseRouteBody(c, PostBulkIssuesBody);

        const db = yield* Db;
        const now = yield* Clock.currentTimeMillis;

        // ── idempotency ────────────────────────────────────────────────────
        //
        // Opportunistic retention sweep, following 0016's githubWebhookDedup
        // precedent: no cron branch needed for a table this cold.
        //
        // BEFORE the replay check, not after. Sweeping second would let an
        // already-expired row answer one more request before being deleted,
        // which makes the window "24 hours, plus however long until the next
        // import" — not what the docs promise, and not a rule anyone could
        // predict. Expiring first means the TTL is the TTL.
        yield* db.execute("DELETE FROM issueImportDedup WHERE created_at_ms < ?", [
          now - DEDUP_TTL_MS,
        ]);

        // The import id was minted client-side at CSV-parse time, so a retry of
        // the same paste carries the same id and replays the ORIGINAL report
        // rather than creating a second copy of everything.
        const replay = yield* db.queryFirst<{ response_json: string }>(
          "SELECT response_json FROM issueImportDedup WHERE id = ?",
          [body.import_id],
        );
        if (replay !== null) {
          return { replayed: true, body: JSON.parse(replay.response_json) as unknown };
        }

        // ── board context (the STATE half) ─────────────────────────────────
        const columns = board.columns;
        const fallbackColumn = enabledColumns(columns)[0] ?? columns[0];
        if (fallbackColumn === undefined) {
          return yield* new NotFoundError({ reason: "board-has-no-columns" });
        }
        const roster = new Set(yield* boardMemberPubkeys(board));

        // Already-imported URLs on this board. Chunked because the IN() list is
        // bound parameters and 1000 of them is ten times D1's ceiling.
        const wantedUrls = [
          ...new Set(
            body.issues
              .map((r) => r.external_url)
              .filter((u): u is string => typeof u === "string" && u !== ""),
          ),
        ];
        const existingByUrl = new Map<string, string>();
        for (const part of chunk(wantedUrls, DEDUP_LOOKUP_CHUNK)) {
          const rows = yield* db.queryAll<{ external_url: string; short_id: string | null }>(
            `SELECT external_url, short_id FROM issueCache
              WHERE board_id = ? AND external_url IN (${part.map(() => "?").join(",")})`,
            [board.id, ...part],
          );
          for (const r of rows) existingByUrl.set(r.external_url, r.short_id ?? "");
        }

        // ── resolve every row before writing anything ──────────────────────
        //
        // Two passes on purpose: the short-id block below is claimed in ONE
        // statement, which means knowing how many issues will actually land
        // before claiming. Resolving first also means a row can be skipped
        // without having burned an issue number — numbers are a visible,
        // permanent sequence and gaps in them look like deleted work.
        const results: ImportRowResult[] = [];
        const planned: PlannedIssue[] = [];
        // Duplicates WITHIN the batch, not only against the board. A CSV that
        // lists the same ticket twice must not create it twice, and the
        // pre-check above cannot see rows that do not exist yet.
        const seenUrls = new Set<string>();

        for (const [index, row] of body.issues.entries()) {
          const url = row.external_url ?? null;
          if (url !== null) {
            const existing = existingByUrl.get(url);
            if (existing !== undefined) {
              results.push({
                row: index,
                status: "skipped",
                reason: "duplicate-external-url",
                value: url,
                ...(existing === "" ? {} : { existing_short_id: existing }),
              });
              continue;
            }
            if (seenUrls.has(url)) {
              results.push({
                row: index,
                status: "skipped",
                reason: "duplicate-external-url-in-batch",
                value: url,
              });
              continue;
            }
          }

          const statusName = row.status ?? null;
          const column =
            statusName === null ? fallbackColumn : resolveStatusColumn(columns, statusName);
          if (column === undefined) {
            // Never guessed, never created on the fly.
            results.push({
              row: index,
              status: "skipped",
              reason: "unknown-status",
              value: statusName ?? "",
            });
            continue;
          }

          // Assignee: SHAPE was accepted upstream (any non-empty string, since
          // a foreign export writes emails and display names). Mapping it to a
          // person on THIS board is the state question, and an unmappable value
          // costs the FIELD, never the row — Evan's Option a, no shadow
          // identity is ever invented.
          const designator = row.assignee_pubkey ?? null;
          const canonical = designator === null ? null : canonicalizeIdentityRef(designator);
          const assignee =
            canonical !== null && roster.has(canonical) ? canonical : null;
          const assigneeSkipped = designator !== null && assignee === null ? designator : null;

          const createdAtMs = row.created_at_ms ?? now;
          const id = crypto.randomUUID();
          if (url !== null) seenUrls.add(url);
          planned.push({
            row: index,
            id,
            title: row.title,
            body: row.body ?? null,
            type: row.type ?? DEFAULT_ISSUE_TYPE,
            column,
            container: row.container ?? "backlog",
            assignee,
            assigneeSkipped,
            estimate: row.estimate ?? null,
            labels: row.labels ?? [],
            externalUrl: url,
            createdAtMs,
            // Importing straight into a done column is legitimate — a closed
            // backlog is most of what a migration carries.
            completedAtMs: column.category === "done" ? createdAtMs : null,
          });
        }

        // ── claim resources for the rows that will land ────────────────────
        const importId = body.import_id;
        let created: ImportRowResult[] = [];
        let failed: ImportRowResult[] = [];

        if (planned.length > 0) {
          // Board prefix self-heal, same as POST /issues: boards predating
          // 0003's backfill mint one on first write.
          let prefix = board.issue_prefix;
          if (prefix === null) {
            const taken = yield* db.queryAll<{ issue_prefix: string }>(
              "SELECT issue_prefix FROM boardCache WHERE issue_prefix IS NOT NULL",
            );
            prefix = uniquePrefix(
              derivePrefix(board.title),
              new Set(taken.map((r) => r.issue_prefix)),
            );
            yield* db.execute(
              "UPDATE boardCache SET issue_prefix = ? WHERE id = ? AND issue_prefix IS NULL",
              [prefix, board.id],
            );
          }

          // ONE atomic claim for the whole block. The per-row UPDATE…RETURNING
          // that POST /issues uses is the right primitive for one issue and the
          // wrong one for a thousand; incrementing by N is equally atomic and
          // costs one statement instead of N.
          const claimed = yield* db.queryFirst<{ start: number }>(
            `UPDATE boardCache SET next_issue_number = next_issue_number + ?
              WHERE id = ? RETURNING next_issue_number - ? AS start`,
            [planned.length, board.id, planned.length],
          );
          if (claimed === null) return yield* new NotFoundError({ reason: "board" });

          const maxPos = yield* db.queryFirst<{ m: number | null }>(
            "SELECT MAX(position) AS m FROM issueCache WHERE board_id = ?",
            [board.id],
          );
          const basePosition = (maxPos?.m ?? 0) + POSITION_STEP;

          const numbered = planned.map((p, i) => ({
            ...p,
            shortId: `${prefix}-${claimed.start + i}`,
            position: basePosition + i * POSITION_STEP,
          }));

          const issueParams = (p: (typeof numbered)[number]) => [
            p.id,
            p.shortId,
            board.id,
            p.title,
            p.body,
            "markdown",
            p.type,
            p.column.name,
            p.column.id,
            p.container,
            p.assignee,
            null, // priority — not a canonical CSV column
            p.estimate,
            JSON.stringify(p.labels),
            "[]", // github_links
            p.position,
            p.createdAtMs,
            p.createdAtMs,
            p.completedAtMs,
            p.externalUrl,
            importId,
          ];

          const insertSql = (rows: number) =>
            `INSERT INTO issueCache
               (id, short_id, board_id, title, body, body_format, type, status, column_id,
                container, assignee_pubkey, priority, estimate, labels, github_links, position,
                created_at_ms, updated_at_ms, completed_at_ms, external_url, import_event_id)
             VALUES ${Array.from({ length: rows }, () => `(${Array.from({ length: ISSUE_INSERT_COLUMNS }, () => "?").join(",")})`).join(",")}`;

          const landed: (typeof numbered)[number][] = [];
          for (const part of chunk(numbered, ISSUE_ROWS_PER_STATEMENT)) {
            const attempt = yield* Effect.exit(
              db.execute(insertSql(part.length), part.flatMap(issueParams)),
            );
            if (Exit.isSuccess(attempt)) {
              landed.push(...part);
              continue;
            }
            // A chunk failing must not condemn its innocent neighbours, so the
            // rows are retried individually to find the one that is actually
            // bad. The realistic cause is the UNIQUE (board_id, external_url)
            // index firing on a concurrent import of the same CSV — see
            // migration 0026 — and that row is reported as FAILED, not as a
            // routine `skipped-duplicate`. Mapping a constraint violation onto
            // the expected-skip path would let any future unique-index bug
            // present itself as normal, designed behaviour.
            for (const one of part) {
              const single = yield* Effect.exit(db.execute(insertSql(1), issueParams(one)));
              if (Exit.isSuccess(single)) landed.push(one);
              else {
                failed.push({
                  row: one.row,
                  status: "failed",
                  reason: "insert-failed",
                  ...(one.externalUrl === null ? {} : { value: one.externalUrl }),
                });
              }
            }
          }

          // Status-change rows for everything that landed. See the header for
          // why these are written in full while board events are not.
          const statusParams = (p: (typeof numbered)[number]) => [
            crypto.randomUUID(),
            p.id,
            board.id,
            caller,
            null, // from_status — a created issue came from nowhere
            p.column.name,
            null, // from_container
            p.container,
            p.completedAtMs === null ? null : p.container,
            p.createdAtMs,
          ];
          for (const part of chunk(landed, STATUS_ROWS_PER_STATEMENT)) {
            yield* db
              .execute(
                `INSERT INTO statusChangeCache
                   (id, issue_id, board_id, actor_pubkey, from_status, to_status,
                    from_container, to_container, container_at_completion, occurred_at_ms)
                 VALUES ${Array.from({ length: part.length }, () => `(${Array.from({ length: STATUS_CHANGE_INSERT_COLUMNS }, () => "?").join(",")})`).join(",")}`,
                part.flatMap(statusParams),
              )
              // Audit rows must never turn a committed import into an error.
              // The issues are already in; losing a tide fact is the cheaper
              // failure, and it is logged rather than swallowed silently.
              .pipe(
                Effect.catchAll((e) =>
                  Effect.sync(() => {
                    console.log(
                      JSON.stringify({
                        warn: "import-status-change-failed",
                        import_id: importId,
                        board_id: board.id,
                        rows: part.length,
                        error: String(e),
                      }),
                    );
                  }),
                ),
              );
          }

          created = landed.map((p) => ({
            row: p.row,
            status: "created" as const,
            issue_id: p.id,
            short_id: p.shortId,
            ...(p.assigneeSkipped === null ? {} : { assignee_skipped: p.assigneeSkipped }),
          }));
        }

        // ── assemble the report ────────────────────────────────────────────
        const allRows = [...results, ...created, ...failed].sort((a, b) => a.row - b.row);
        const createdCount = allRows.filter((r) => r.status === "created").length;
        const skippedCount = allRows.filter((r) => r.status === "skipped").length;
        const failedCount = allRows.filter((r) => r.status === "failed").length;
        const unassignedCount = allRows.filter((r) => r.assignee_skipped !== undefined).length;

        const responseBody = {
          import_id: importId,
          board_slug: board.slug,
          counts: {
            total: body.issues.length,
            created: createdCount,
            skipped: skippedCount,
            failed: failedCount,
            // "Landed WITHOUT an assignee", NOT "did not land". Distinct from
            // `skipped` on purpose: conflating them would tell a user that N
            // issues failed to import when all N are on the board.
            unassigned: unassignedCount,
          },
          // Stated rather than left to be inferred from a NULL column. See
          // lib/kanban/publish.ts and migration 0026.
          substrate: {
            state: "not_applicable_for_imports",
            reason:
              "Per-issue substrate publish would require one gateway round-trip per row within a single request; imported issues carry NULL substrate_event_id by design. One aggregate `issues.imported` board event is emitted per import.",
          },
          rows: allRows,
        };

        // Claiming the replay window. The PK collides when the SAME import_id
        // is POSTed twice CONCURRENTLY — both requests get past the replay
        // check above before either has written this row.
        //
        // Losing that race must not be a 500 on a request whose issues are
        // already committed. The winner's report is the honest answer to "what
        // happened to this import", so it is read back and returned; the rows
        // this request created are the ones it describes, because
        // `external_url` dedup and the UNIQUE index kept the two from both
        // landing the same issue. A sequential retry never reaches here at all
        // — it is answered by the replay check.
        const claimed = yield* Effect.exit(
          db.execute(
            "INSERT INTO issueImportDedup (id, created_at_ms, response_json) VALUES (?, ?, ?)",
            [importId, now, JSON.stringify(responseBody)],
          ),
        );
        if (Exit.isFailure(claimed)) {
          const winner = yield* db.queryFirst<{ response_json: string }>(
            "SELECT response_json FROM issueImportDedup WHERE id = ?",
            [importId],
          );
          if (winner !== null) {
            console.log(
              JSON.stringify({
                warn: "import-dedup-race",
                import_id: importId,
                board_id: board.id,
              }),
            );
            return { replayed: true, body: JSON.parse(winner.response_json) as unknown };
          }
          // The insert failed for some reason OTHER than a concurrent claim.
          // Nothing to replay, so the report this request actually produced is
          // still the truthful answer — it just cannot be replayed later.
          console.log(
            JSON.stringify({ warn: "import-dedup-unwritable", import_id: importId }),
          );
        }

        // AFTER the claim, deliberately. `issueImports.id` is the same
        // import_id and therefore the same primary key, so writing the audit
        // row first would make the concurrent-duplicate case collide HERE —
        // before the guarded claim above could turn it into a replay — and
        // answer 500 on a request whose issues are already committed.
        yield* db.execute(
          `INSERT INTO issueImports
             (id, board_id, imported_by_pubkey, imported_at_ms, row_count,
              created_count, skipped_count, failed_count, unmapped_assignees)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            importId,
            board.id,
            caller,
            now,
            body.issues.length,
            createdCount,
            skippedCount,
            failedCount,
            unassignedCount,
          ],
        );

        const audit = yield* AuditLog;
        yield* audit.record({
          event_type: "issues_imported",
          actor: claims.login,
          details: {
            board: board.slug,
            import_id: importId,
            rows: body.issues.length,
            created: createdCount,
            skipped: skippedCount,
            failed: failedCount,
            unassigned: unassignedCount,
          },
        });

        // ONE event for the whole import. No issue_id: N issues landed, so
        // there is no single one to name.
        if (createdCount > 0) {
          yield* emitSecureBoardEvent(board.id, {
            kind: "issues.imported",
            board_id: board.id,
            at_ms: now,
            payload: {
              import_id: importId,
              count: body.issues.length,
              created: createdCount,
              skipped: skippedCount,
              unassigned: unassignedCount,
            },
          });
        }

        return { replayed: false, body: responseBody };
      }),
      (v) => c.json(v.body as Record<string, unknown>, 200),
    ),
  );

  // ── GET /boards/:slug/imports — the audit list ──────────────────────────
  //
  // Permanent, and deliberately without the per-row detail: that lives in
  // issueImportDedup and is swept at 24h. What survives is who imported how
  // much, when — including `unmapped_assignees`, so "we quietly dropped 40
  // assignees" outlives the report that first said so.
  app.get("/boards/:slug/imports", (c) =>
    run(
      c,
      Effect.gen(function* () {
        const { board } = yield* boardScope(c, "contributor");
        const db = yield* Db;
        const rows = yield* db.queryAll<ImportRecord>(
          `SELECT * FROM issueImports WHERE board_id = ? ORDER BY imported_at_ms DESC LIMIT 50`,
          [board.id],
        );
        return { imports: rows, max_rows_per_import: MAX_IMPORT_ROWS };
      }),
      (v) => c.json(v),
    ),
  );

  return app;
};

/** Exported for tests — the resolution rules that need no database. */
export { resolveStatusColumn, chunk, ISSUE_ROWS_PER_STATEMENT, STATUS_ROWS_PER_STATEMENT };
export type { PlannedIssue, BoardShape };
