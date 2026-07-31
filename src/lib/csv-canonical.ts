// EFB-15 — the canonical import shape: what an Evenflow CSV row IS.
//
// The whole feature rests on one decision: we accept ONE shape, our own. A
// user with a Linear, Jira or GitHub export asks their AI to transform it into
// the columns below (docs/import-csv.md carries a worked prompt per vendor),
// and the transformed rows come here. Nothing in this file, or anywhere in this
// feature, may name a vendor. The moment a `jira_key` column appears, every
// future export format becomes our problem instead of the AI's.
//
// ── THIS MODULE IS PURE, AND THAT IS THE DESIGN ──────────────────────────
//
// Only `effect` and the two vocabulary modules are imported — no Db, no
// Cloudflare globals, no request context. Everything decidable here is
// decidable WITHOUT the board, which is exactly the line
// docs/BOUNDARY_DISCIPLINE.md draws between a schema and a handler, and it is
// what makes the bulk endpoint's partial-success semantics coherent rather than
// ad hoc:
//
//   SHAPE  — decidable here, from the row alone. Unknown key, wrong type,
//            missing title, unknown `type`/`container` value, batch too large.
//            → 400, WHOLE BATCH REJECTED, nothing written.
//
//   STATE  — needs the board: does this status name a column on THIS board? is
//            this assignee on THIS board's roster? has THIS board already
//            imported this external_url?
//            → 200 with a per-row status array; the batch partially lands.
//
// A caller never has to guess which they hit: shape failures cost them the
// whole request and name the row, state outcomes come back per row. And the
// split is not a convention this file merely follows — a state question
// CANNOT be asked here, because there is no Db to ask it with.
//
// ── WHY `status` IS A BARE STRING HERE AND `type` IS NOT ─────────────────
//
// Both look like closed vocabularies from the outside. They are not the same
// kind of thing. `type` is closed by the CHECK constraint in migration 0005 —
// the same six values on every board, forever, knowable without a database.
// `status` is a column NAME on the TARGET board, and boards disagree: "Todo"
// here, "To Do" there, "Not Started" somewhere else. Validating it needs
// `board.columns`, so it is carried as a trimmed string and resolved in the
// handler. Folding it in would force a per-request schema, which the boundary
// doc correctly calls handler code with extra steps.

import { ParseResult, Schema } from "effect";
import { ISSUE_TYPES } from "../columns";
import { CONTAINERS } from "../shapes";

/**
 * The canonical column set, in the order docs and the UI present them.
 *
 * Exported as data rather than written out in prose three times: the docs page,
 * the import UI's example, and the header validator all read from here, so a
 * column added to the schema below cannot be missed by two of the three.
 */
export const CANONICAL_COLUMNS = [
  "title",
  "body",
  "type",
  "status",
  "container",
  "estimate",
  "labels",
  "assignee_pubkey",
  "external_url",
  "created_at_ms",
] as const;

/**
 * Rows accepted in one POST.
 *
 * Sized by the Cloudflare Workers request-body limit rather than by taste, and
 * enforced in the SCHEMA so an oversized batch is rejected before any row is
 * examined or any row is written. Larger imports paginate client-side.
 */
export const MAX_IMPORT_ROWS = 1000;

/** A trimmed string that still has content once trimmed. */
const TrimmedNonEmpty = Schema.Trim.pipe(Schema.minLength(1));

/**
 * Case-and-whitespace tolerance for a closed vocabulary, with aliases.
 *
 * A CSV that came out of a spreadsheet says `Bug`, ` bug`, or `BUG`, and all
 * three plainly mean `bug`. Normalizing here rather than rejecting is invariant
 * 4 doing its job — the handler downstream receives the canonical value and
 * never re-normalizes — and it is also what keeps the strict whole-batch
 * rejection humane: after this, a 400 means the value genuinely is not one of
 * ours, not that someone capitalized it.
 *
 * `aliases` carries renames the vocabulary has already been through, so a CSV
 * written against the old spelling still lands.
 */
const closedVocabulary = (
  name: string,
  allowed: ReadonlyArray<string>,
  aliases: Readonly<Record<string, string>> = {},
) =>
  Schema.transformOrFail(Schema.String, Schema.String, {
    strict: true,
    decode: (input, _options, ast) => {
      const folded = input.trim().toLowerCase();
      const resolved = aliases[folded] ?? folded;
      return allowed.includes(resolved)
        ? ParseResult.succeed(resolved)
        : ParseResult.fail(
            new ParseResult.Type(ast, input, `not one of: ${allowed.join(", ")}`),
          );
    },
    encode: (value) => ParseResult.succeed(value),
  }).annotations({ identifier: name });

/**
 * All SIX types, from the shared `ISSUE_TYPES` const.
 *
 * The brief specified three (`bug|task|feature`). That was wrong, and importing
 * the real vocabulary instead of retyping a subset is what makes it impossible
 * to be wrong again: migration 0005's CHECK constraint pins the same six, and a
 * narrower union here would reject a `story` at import while the UI creates one
 * happily — the drift the boundary checker exists to catch, shipped as a
 * feature.
 */
const ImportType = closedVocabulary("IssueType", ISSUE_TYPES);

/**
 * `icebox | backlog | active`, with `iced` accepted as the old spelling.
 *
 * EFB-17 renamed it, and a CSV a user wrote last month against the old
 * vocabulary is not a client bug — it is the rename's cost, and carrying the
 * alias is how we pay it instead of billing the user.
 */
const ImportContainer = closedVocabulary("Container", CONTAINERS, { iced: "icebox" });

/**
 * An assignee as some OTHER system wrote it.
 *
 * Deliberately NOT `IdentityRefFromInput`, and this is the one place in the
 * codebase where that is the right call. Every other route takes an assignee
 * from a client that knows our identity vocabulary, so a malformed one is a
 * client bug worth a 400. A CSV exported from another tracker says
 * `jane@acme.com`, or `Jane Doe`, or a vendor's opaque user id — values that
 * are not identity references and never could be. Running them through
 * `IdentityRefFromInput` would 400 the entire import on the first row that has
 * a human's email in it, which is most real imports.
 *
 * So the shape rule is only "somebody wrote something here". Whether it names a
 * person this board knows is a STATE question — canonicalize, then check the
 * roster — answered in the handler, where an unmappable value causes the issue
 * to land UNASSIGNED with the intended string reported back on that row and
 * counted in the audit. Evan's Option a: never invent a shadow identity.
 *
 * That is a policy exception to "shape errors are 400", made deliberately and
 * in one named place. It is NOT a silent drop: every unmapped assignee is
 * reported per-row AND counted in `issueImports.unmapped_assignees`, so the
 * user learns what we could not map. Silence is the thing the boundary doc
 * forbids; reporting a documented policy outcome is not silence.
 */
const ForeignAssignee = TrimmedNonEmpty;

/**
 * The vendor's permalink for this row — and the dedup key on re-import.
 *
 * Required to be an absolute http(s) URL rather than any string, because its
 * whole job is to be stable and comparable across two exports of the same
 * tracker. A relative path or a bare id is neither.
 */
const ExternalUrl = Schema.Trim.pipe(
  Schema.pattern(/^https?:\/\/.+/),
).annotations({ identifier: "ExternalUrl" });

/**
 * One canonical row.
 *
 * Only `title` is required — every other column is optional, and an import that
 * carries titles alone is a legitimate one. Optional fields accept `null` as
 * well as absence so a CSV transform that emits explicit empties (most of them
 * do) does not have to strip keys.
 *
 * NUMBERS ARRIVE AS NUMBERS. `estimate: "3"` is a 400, not a coerced 3 —
 * invariant 2, no coercion. The browser parses the CSV and types the column
 * before POSTing, so a non-numeric estimate surfaces in the preview against the
 * offending row rather than as a server error against the whole batch. A direct
 * API caller sends JSON and should be sending JSON numbers.
 *
 * LABELS ARE AN ARRAY HERE, not the semicolon-joined string the CSV carries.
 * Semicolon separation is a CSV ENCODING detail — it exists because commas are
 * the field separator — and it has no business in a JSON API. The browser
 * splits on `;` during parse; the docs teach the convention to the AI writing
 * the CSV. The server never sees a semicolon and never has to guess whether one
 * inside a label was a separator or a character.
 */
export const ImportIssueRow = Schema.Struct({
  title: TrimmedNonEmpty,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  type: Schema.optional(Schema.NullOr(ImportType)),
  status: Schema.optional(Schema.NullOr(TrimmedNonEmpty)),
  container: Schema.optional(Schema.NullOr(ImportContainer)),
  estimate: Schema.optional(Schema.NullOr(Schema.Int.pipe(Schema.nonNegative()))),
  labels: Schema.optional(Schema.NullOr(Schema.Array(TrimmedNonEmpty))),
  assignee_pubkey: Schema.optional(Schema.NullOr(ForeignAssignee)),
  external_url: Schema.optional(Schema.NullOr(ExternalUrl)),
  // The original creation time, so an imported backlog keeps its age instead of
  // every row claiming to have been filed the moment the CSV was pasted.
  // Positive-int only; a vendor exporting seconds instead of milliseconds
  // produces a 1970 date, which is wrong but not something a schema can tell
  // from a genuinely old issue.
  created_at_ms: Schema.optional(Schema.NullOr(Schema.Int.pipe(Schema.positive()))),
});
export type ImportIssueRow = Schema.Schema.Type<typeof ImportIssueRow>;

/**
 * The `issues` array — decoded row by row so the failure can NAME THE ROWS.
 *
 * A plain `Schema.Array(ImportIssueRow)` validates identically and reports
 * uselessly. `reasonFor` in lib/route-body.ts groups issues by their ROOT
 * field, so every problem anywhere in a thousand rows collapses to `issues`:
 * true, unchanged from what that route contract promises, and no help at all to
 * someone holding a CSV. Widening `reasonFor` to full paths is not the fix —
 * it would change the error strings every other route already answers, which
 * the boundary doc says is a decision needing its own ticket.
 *
 * So the detail is produced HERE, where it costs nobody else anything. A bare
 * kebab-slug message is the documented way a schema hands a specific code to
 * the caller (see `REASON_CODE`), so failing with `rows-7-14-22` surfaces as
 * `issues-rows-7-14-22` — the 0-based indices of the offending rows, which is
 * exactly what a client needs to fix its CSV.
 *
 * Doing it in the SCHEMA rather than in the handler's error path is what keeps
 * `POST …/issues/bulk` a clean single-door route. The obvious alternative —
 * catch the 400 and re-read the body to diagnose it — makes the handler call
 * both `parseRouteBody` and a raw body reader, which `check:boundary` rejects
 * by design: it cannot tell a read-only diagnostic from a validation bypass,
 * and "half-migrated is worse than unmigrated" is the right rule even when a
 * particular instance is harmless.
 *
 * `MAX_REPORTED_ROW_ERRORS` bounds the list: a CSV with its columns shifted by
 * one fails every row, and a reason string naming a thousand of them is a
 * denial of service against the person reading it.
 */
const ImportIssueRows = Schema.transformOrFail(
  // maxItems lives on the FROM side deliberately: an oversized batch is
  // rejected before a single row is decoded, so a 50,000-row paste costs one
  // length check rather than 50,000 struct decodes.
  Schema.Array(Schema.Unknown).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_IMPORT_ROWS),
  ),
  Schema.Array(Schema.typeSchema(ImportIssueRow)),
  {
    strict: true,
    decode: (input, _options, ast) => {
      const decoded: ImportIssueRow[] = [];
      const bad: number[] = [];
      for (const [index, row] of input.entries()) {
        const result = Schema.decodeUnknownEither(ImportIssueRow)(row, {
          onExcessProperty: "error",
          errors: "all",
        });
        if (result._tag === "Left") bad.push(index);
        else decoded.push(result.right);
      }
      return bad.length === 0
        ? ParseResult.succeed(decoded)
        : ParseResult.fail(
            new ParseResult.Type(
              ast,
              input,
              `rows-${bad.slice(0, MAX_REPORTED_ROW_ERRORS).join("-")}`,
            ),
          );
    },
    encode: (value) => ParseResult.succeed(value),
  },
).annotations({ identifier: "ImportIssueRows" });

/**
 * The POST body.
 *
 * `import_id` is minted CLIENT-SIDE when the CSV is parsed, not server-side on
 * arrival, and that ordering is the entire idempotency guarantee. A server-
 * minted id is fresh on every retry and therefore dedupes nothing; an id fixed
 * at parse time is the same across every retry of that one paste, so a client
 * that lost the response to a 900-row import can safely POST it again and get
 * the original report back rather than 900 duplicate issues.
 */
export const PostBulkIssuesBody = Schema.Struct({
  import_id: Schema.UUID,
  issues: ImportIssueRows,
});
export type PostBulkIssuesBody = Schema.Schema.Type<typeof PostBulkIssuesBody>;

/**
 * Which rows failed to parse, and why — the diagnostic for a rejected batch.
 *
 * `parseRouteBody` correctly answers a shape failure with `issues`, because
 * `reasonFor` groups by the ROOT field and the root of `issues.7.titl` is
 * `issues`. That is the right contract for every other route and must not
 * change (the boundary doc: an error string is a decision deserving its own
 * ticket). For a 1000-row import it is also nearly useless on its own — "one of
 * your thousand rows is wrong" gives a user nothing to fix.
 *
 * So this runs ONLY on the already-failed path, re-decoding row by row where
 * the path root IS the field name, and its output rides alongside the
 * unchanged `reason` as additive detail. No existing contract moves; the caller
 * learns the row and the field.
 *
 * Bounded at `MAX_REPORTED_ROW_ERRORS`: a CSV with the columns shifted by one
 * fails every row, and a 400 body listing a thousand identical problems is a
 * denial of service against the person reading it. The count is always honest
 * about how many were truncated.
 */
export const MAX_REPORTED_ROW_ERRORS = 20;

export interface RowError {
  readonly row: number;
  readonly reason: string;
}

export interface RowErrorReport {
  readonly errors: ReadonlyArray<RowError>;
  /** Total failing rows, which may exceed `errors.length`. */
  readonly total: number;
}

const rowReason = (error: ParseResult.ParseError): string => {
  const issues = ParseResult.ArrayFormatter.formatErrorSync(error);
  if (issues.length === 0) return "invalid-row";
  const byField = new Map<string, string>();
  for (const i of issues) {
    const field = i.path.length > 0 ? String(i.path[0]) : "row";
    // Same shape as route-body's `reasonFor`: an unknown key names itself, and
    // a field that raised several issues reports once.
    byField.set(field, i._tag === "Unexpected" ? `${field}-unknown` : field);
  }
  return [...byField.values()].join(",");
};

/**
 * Re-decode each row alone to find which ones are bad.
 *
 * Takes the raw parsed JSON body, which on this path is whatever the client
 * sent — hence the defensive shape checks. `issues` not being an array at all
 * is itself the failure, reported as row -1 so the caller is not left with an
 * empty error list explaining nothing.
 */
export const rowErrorsOf = (body: unknown): RowErrorReport => {
  const rows =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)["issues"]
      : undefined;
  if (!Array.isArray(rows)) {
    return { errors: [{ row: -1, reason: "issues-not-an-array" }], total: 1 };
  }
  const errors: RowError[] = [];
  let total = 0;
  for (const [index, row] of rows.entries()) {
    const result = Schema.decodeUnknownEither(ImportIssueRow)(row, {
      onExcessProperty: "error",
      errors: "all",
    });
    if (result._tag === "Left") {
      total += 1;
      if (errors.length < MAX_REPORTED_ROW_ERRORS) {
        errors.push({ row: index, reason: rowReason(result.left) });
      }
    }
  }
  return { errors, total };
};

// ── per-row outcomes (the STATE half) ────────────────────────────────────

/**
 * What happened to one row.
 *
 * Three values, and the distinction between them is the part worth getting
 * right — a user reads these as counts and makes decisions from them:
 *
 *   created  a row landed. It may still carry `assignee_skipped`: the ISSUE
 *            exists, one FIELD on it does not. Counting those as skips would
 *            tell the user 40 issues failed to import when all 40 are on the
 *            board.
 *   skipped  no row was written, and that is the feature working as designed —
 *            a duplicate, or a value this board has no home for.
 *   failed   no row was written for a reason we did not choose. Rare, and the
 *            only one of the three that means "look at this".
 */
export const ROW_STATUSES = ["created", "skipped", "failed"] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];

export interface ImportRowResult {
  /** 0-based index in the submitted array — the only stable key back to the UI's preview table. */
  readonly row: number;
  readonly status: RowStatus;
  readonly issue_id?: string;
  readonly short_id?: string;
  /** Why, for `skipped` and `failed`. Absent on a clean create. */
  readonly reason?: string;
  /** The offending value, where naming it helps (an unknown status, say). */
  readonly value?: string;
  /** The existing issue a duplicate row resolved to. */
  readonly existing_short_id?: string;
  /**
   * The assignee designator we could not map. Present ONLY on `created` rows —
   * the issue landed unassigned. See `ForeignAssignee`.
   */
  readonly assignee_skipped?: string;
}
