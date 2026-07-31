// Board Settings → CSV import (EFB-15).
//
// Paste or upload → preview → confirm. Named `ImportSection` to match the other
// panels on this page (GithubSection, StorageSection, WebhooksSection), same
// reasoning WebhooksSection records for its own name.
//
// ── THE PREVIEW VALIDATES WITH THE SERVER'S OWN SCHEMA ───────────────────
//
// `ImportIssueRow` is imported from `src/lib/csv-canonical.ts` — the Worker
// module the endpoint itself decodes with, not a copy of it. That import
// resolves because csv-canonical is dependency-free apart from `effect` and two
// pure vocabulary modules, the same discipline `board-events.ts` keeps for the
// SSE wire contract (EFB-34). It is worth protecting: a hand-maintained mirror
// of ten field rules would drift on the first schema change, and the drift
// would show up as a preview that says "looks good" followed by a 400.
//
// So the preview is not an approximation of what the server will accept. It is
// the same decision, run earlier.
//
// ── WHERE CSV-NESS STOPS ─────────────────────────────────────────────────
//
// This component is the ONLY place in the codebase that knows what a CSV is.
// It parses, then posts JSON. Two encoding details die here and never reach the
// API: labels are `;`-separated in a cell (commas being the field separator)
// and become a JSON array, and every cell arrives as a string, so numeric
// columns are typed here. A blank cell becomes an ABSENT key rather than an
// empty string — "the exporter had nothing to say" and "the value is empty
// text" are different claims, and the schema treats them differently.

import { For, Show, createMemo, createSignal } from "solid-js";
import { Effect, ParseResult, Schema } from "effect";
import Papa from "papaparse";
import { ApiClient, appRuntime, type ApiClientService, type ApiError } from "../effects";
import {
  CANONICAL_COLUMNS,
  ImportIssueRow,
  MAX_IMPORT_ROWS,
} from "../../../src/lib/csv-canonical";

const api = <T,>(f: (c: ApiClientService) => Effect.Effect<T, ApiError>): Promise<T> =>
  appRuntime.runPromise(Effect.flatMap(ApiClient, f));

/** Rows rendered in the preview table. The rest are counted, not drawn. */
const PREVIEW_ROWS = 10;

/** Cells that carry a `;`-separated list rather than a scalar. */
const LIST_COLUMNS = new Set(["labels"]);
/** Cells that must reach the API as numbers, not strings. */
const NUMERIC_COLUMNS = new Set(["estimate", "created_at_ms"]);

interface RowResult {
  row: number;
  status: "created" | "skipped" | "failed";
  short_id?: string;
  reason?: string;
  value?: string;
  existing_short_id?: string;
  assignee_skipped?: string;
}

interface ImportReport {
  import_id: string;
  counts: {
    total: number;
    created: number;
    skipped: number;
    failed: number;
    unassigned: number;
  };
  rows: RowResult[];
}

interface ParsedRow {
  readonly index: number;
  readonly canonical: Record<string, unknown>;
  readonly error: string | null;
}

interface Parsed {
  readonly rows: ReadonlyArray<ParsedRow>;
  /** Minted at PARSE time, never at post time — see the idempotency note below. */
  readonly importId: string;
  readonly unknownColumns: ReadonlyArray<string>;
}

/**
 * Turn one parsed CSV record into a canonical API row.
 *
 * Blank cells are DROPPED rather than sent as `""`. A CSV exporter emits a
 * column for every field whether or not the row has one, so keeping the empties
 * would mean posting `body: ""` and `status: ""` on every row and having the
 * schema reject them — the file is fine, the transcription would be wrong.
 */
const toCanonicalRow = (record: Record<string, string>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(record)) {
    const value = (raw ?? "").trim();
    if (value === "") continue;
    if (LIST_COLUMNS.has(key)) {
      const items = value
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      if (items.length > 0) out[key] = items;
      continue;
    }
    if (NUMERIC_COLUMNS.has(key)) {
      const n = Number(value);
      // A non-numeric estimate is passed THROUGH as the string it was, so the
      // schema rejects it and the preview names that row. Coercing it to NaN or
      // silently dropping it would hide a real mistake in the user's file.
      out[key] = Number.isFinite(n) ? n : value;
      continue;
    }
    out[key] = value;
  }
  return out;
};

/**
 * Decode one row against the server's schema; return a human-readable problem
 * or null.
 *
 * Uses `ArrayFormatter` — the same formatter `lib/route-body.ts` reports with —
 * so the field names a user sees here are the ones the API would name. Reported
 * per FIELD rather than per issue: one bad value commonly raises both a
 * refinement failure and the underlying type failure, and "title, title" tells
 * nobody anything.
 */
const rowError = (row: Record<string, unknown>): string | null => {
  const result = Schema.decodeUnknownEither(ImportIssueRow)(row, {
    onExcessProperty: "error",
    errors: "all",
  });
  if (result._tag === "Right") return null;
  const byField = new Map<string, string>();
  for (const issue of ParseResult.ArrayFormatter.formatErrorSync(result.left)) {
    const field = issue.path.length > 0 ? String(issue.path[0]) : "row";
    byField.set(
      field,
      issue._tag === "Unexpected" ? `${field} isn't a canonical column` : `${field}: ${issue.message}`,
    );
  }
  return byField.size === 0 ? "invalid row" : [...byField.values()].join("; ");
};

export const ImportSection = (props: { apiBase: string }) => {
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [report, setReport] = createSignal<ImportReport | null>(null);
  const [parsed, setParsed] = createSignal<Parsed | null>(null);

  const reset = () => {
    setParsed(null);
    setReport(null);
    setError(null);
  };

  const parse = () => {
    setError(null);
    setReport(null);
    const source = text().trim();
    if (source === "") {
      setParsed(null);
      return;
    }
    const result = Papa.parse<Record<string, string>>(source, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase(),
    });
    if (result.errors.length > 0) {
      const first = result.errors[0];
      setParsed(null);
      setError(
        `Couldn't read that CSV: ${first?.message ?? "parse error"}${
          first?.row === undefined ? "" : ` (row ${first.row + 1})`
        }`,
      );
      return;
    }

    // Header check up front. Without it, one misspelled column header turns
    // into the same unknown-key error repeated on every single row, which
    // buries the one fact the user needs.
    const known = new Set<string>(CANONICAL_COLUMNS);
    const unknownColumns = (result.meta.fields ?? []).filter((f) => !known.has(f));

    const rows = result.data.map((record, index) => {
      const canonical = toCanonicalRow(record);
      return { index, canonical, error: rowError(canonical) };
    });

    setParsed({
      rows,
      // Minted HERE, at parse time, and reused for every retry of this paste.
      // That ordering is the whole idempotency guarantee: an id minted at POST
      // time would be fresh on every retry and dedupe nothing, while this one
      // lets a user who lost the response safely press the button again and get
      // the original report back instead of a second copy of their backlog.
      importId: crypto.randomUUID(),
      unknownColumns,
    });
  };

  const onFile = async (file: File | undefined) => {
    if (file === undefined) return;
    setText(await file.text());
    parse();
  };

  const validRows = createMemo(() => (parsed()?.rows ?? []).filter((r) => r.error === null));
  const badRows = createMemo(() => (parsed()?.rows ?? []).filter((r) => r.error !== null));
  const blocked = createMemo(
    () =>
      (parsed()?.unknownColumns.length ?? 0) > 0 ||
      badRows().length > 0 ||
      validRows().length === 0 ||
      (parsed()?.rows.length ?? 0) > MAX_IMPORT_ROWS,
  );

  const submit = async () => {
    const current = parsed();
    if (current === null) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        import_id: current.importId,
        issues: current.rows.map((r) => r.canonical),
      };
      const res = await api<ImportReport>((c) =>
        c.post(`${props.apiBase}/issues/bulk`, body),
      );
      setReport(res);
      setParsed(null);
      setText("");
    } catch (e) {
      const reason = (e as { reason?: string })?.reason;
      setError(reason ?? "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const example = createMemo(
    () =>
      `${CANONICAL_COLUMNS.join(",")}\n` +
      `Fix the login redirect,Users bounce to /,bug,Todo,backlog,3,auth;urgent,,https://example.com/issues/1,`,
  );

  return (
    <section class="space-y-4">
      <header>
        <h2 class="text-lg font-medium">Import from CSV</h2>
        <p class="text-sm opacity-70">
          Paste a canonical Evenflow CSV, or upload one. Coming from Linear, Jira
          or GitHub? Export to CSV and ask your AI assistant to convert it —{" "}
          <a class="underline" href="/docs#import">
            the docs page
          </a>{" "}
          has a ready-made prompt for each.
        </p>
      </header>

      <Show when={error() !== null}>
        <p class="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm">{error()}</p>
      </Show>

      {/* ── the report from a completed import ─────────────────────────── */}
      {/*
        `when={report()}` and not `when={report() !== null}` — the callback form
        receives the WHEN VALUE, so a boolean predicate hands the child `true`
        instead of the report.
      */}
      <Show when={report()}>
        {(r) => (
          <div class="rounded border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
            <p class="font-medium">
              Imported {r().counts.created} of {r().counts.total} rows.
            </p>
            <ul class="mt-1 space-y-0.5 opacity-80">
              <Show when={r().counts.skipped > 0}>
                <li>{r().counts.skipped} skipped — already imported, or a value this board has no column for.</li>
              </Show>
              <Show when={r().counts.failed > 0}>
                <li>{r().counts.failed} failed.</li>
              </Show>
              <Show when={r().counts.unassigned > 0}>
                {/*
                  Phrased to distinguish it from a skip, because the two are
                  easy to conflate and mean opposite things: these issues ARE on
                  the board. Only the assignee field was dropped.
                */}
                <li>
                  {r().counts.unassigned} landed unassigned — the assignee named
                  in the CSV isn't a member of this board.
                </li>
              </Show>
            </ul>
            <Show when={r().rows.some((row) => row.status !== "created")}>
              <details class="mt-2">
                <summary class="cursor-pointer">Row detail</summary>
                <ul class="mt-1 space-y-0.5 text-xs opacity-80">
                  <For each={r().rows.filter((row) => row.status !== "created")}>
                    {(row) => (
                      <li>
                        Row {row.row + 1}: {row.status}
                        <Show when={row.reason !== undefined}> — {row.reason}</Show>
                        <Show when={row.value !== undefined}> ({row.value})</Show>
                        <Show when={row.existing_short_id !== undefined}>
                          {" "}
                          → already here as {row.existing_short_id}
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
            <button
              type="button"
              class="mt-2 rounded border px-2 py-1 hover:bg-white/10"
              onClick={reset}
            >
              Import another
            </button>
          </div>
        )}
      </Show>

      {/* ── input ──────────────────────────────────────────────────────── */}
      <Show when={report() === null}>
        <div class="space-y-2">
          <textarea
            class="h-40 w-full rounded border bg-transparent p-2 font-mono text-xs"
            placeholder={example()}
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            onBlur={parse}
          />
          <div class="flex flex-wrap items-center gap-2">
            <input
              type="file"
              accept=".csv,text/csv"
              class="text-sm"
              onChange={(e) => void onFile(e.currentTarget.files?.[0])}
            />
            <button
              type="button"
              class="rounded border px-2 py-1 text-sm hover:bg-white/10"
              onClick={parse}
            >
              Preview
            </button>
          </div>
        </div>

        <Show when={parsed()}>
          {(p) => (
            <div class="space-y-2">
              <Show when={p().unknownColumns.length > 0}>
                <p class="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm">
                  Unrecognised column{p().unknownColumns.length > 1 ? "s" : ""}:{" "}
                  <code>{p().unknownColumns.join(", ")}</code>. The canonical
                  columns are <code>{CANONICAL_COLUMNS.join(", ")}</code>. Rename
                  or delete the extra ones and preview again.
                </p>
              </Show>

              <Show when={p().rows.length > MAX_IMPORT_ROWS}>
                <p class="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm">
                  {p().rows.length} rows — the limit is {MAX_IMPORT_ROWS} per
                  import. Split the file and import it in batches.
                </p>
              </Show>

              <Show when={badRows().length > 0}>
                <div class="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                  <p class="font-medium">
                    {badRows().length} row{badRows().length > 1 ? "s" : ""} can't
                    be imported yet:
                  </p>
                  <ul class="mt-1 space-y-0.5 text-xs">
                    <For each={badRows().slice(0, PREVIEW_ROWS)}>
                      {(r) => (
                        <li>
                          Row {r.index + 1}: {r.error}
                        </li>
                      )}
                    </For>
                  </ul>
                  <Show when={badRows().length > PREVIEW_ROWS}>
                    <p class="mt-1 text-xs opacity-70">
                      …and {badRows().length - PREVIEW_ROWS} more.
                    </p>
                  </Show>
                </div>
              </Show>

              <p class="text-sm opacity-70">
                {p().rows.length} row{p().rows.length === 1 ? "" : "s"} parsed,{" "}
                {validRows().length} ready to import.
              </p>

              <div class="overflow-x-auto rounded border">
                <table class="w-full text-left text-xs">
                  <thead class="opacity-60">
                    <tr>
                      <th class="p-2">#</th>
                      <th class="p-2">Title</th>
                      <th class="p-2">Type</th>
                      <th class="p-2">Status</th>
                      <th class="p-2">Container</th>
                      <th class="p-2">Labels</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={p().rows.slice(0, PREVIEW_ROWS)}>
                      {(r) => (
                        <tr class={r.error === null ? "" : "bg-red-500/10"}>
                          <td class="p-2 opacity-60">{r.index + 1}</td>
                          <td class="p-2">{String(r.canonical["title"] ?? "—")}</td>
                          <td class="p-2">{String(r.canonical["type"] ?? "task")}</td>
                          <td class="p-2">{String(r.canonical["status"] ?? "—")}</td>
                          <td class="p-2">{String(r.canonical["container"] ?? "backlog")}</td>
                          <td class="p-2">
                            {((r.canonical["labels"] as string[] | undefined) ?? []).join(", ")}
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
              <Show when={p().rows.length > PREVIEW_ROWS}>
                <p class="text-xs opacity-60">
                  Showing the first {PREVIEW_ROWS} of {p().rows.length} rows.
                </p>
              </Show>

              <div class="flex gap-2">
                <button
                  type="button"
                  class="rounded border px-3 py-1 text-sm hover:bg-white/10 disabled:opacity-40"
                  disabled={busy() || blocked()}
                  onClick={() => void submit()}
                >
                  {busy() ? "Importing…" : `Import ${validRows().length} issues`}
                </button>
                <button
                  type="button"
                  class="rounded border px-3 py-1 text-sm hover:bg-white/10"
                  onClick={reset}
                >
                  Cancel
                </button>
              </div>
              <p class="text-xs opacity-60">
                Re-importing the same file is safe: rows already imported (matched
                by <code>external_url</code>) are skipped rather than duplicated.
              </p>
            </div>
          )}
        </Show>
      </Show>
    </section>
  );
};
