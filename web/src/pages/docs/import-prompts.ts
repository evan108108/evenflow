// EFB-15 — the three worked transform prompts, served at /docs#import.
//
// These ARE the import feature's vendor support. Evenflow accepts one CSV shape
// and contains no vendor-specific code; the per-tracker knowledge lives here, as
// prose an AI assistant reads, where adding a fourth tracker costs a paragraph
// instead of a parser.
//
// ONE COPY, deliberately. `docs/import-csv.md` documents the schema and the
// semantics and POINTS here rather than reproducing the prompts, because two
// copies of a 40-line prompt drift the first time a column is added and the
// drift is invisible — both look plausible.
//
// Data module rather than JSX, following `rest-spec.ts`, so Docs.tsx stays a
// renderer and these stay copy-pasteable strings.

/** Prefixed to every vendor prompt — the rules that do not vary by tracker. */
export const IMPORT_PROMPT_PREAMBLE = `You are converting a project-tracker CSV export into Evenflow's canonical import format.

Output ONLY the CSV. No explanation, no code fences. The first line must be exactly:

title,body,type,status,container,estimate,labels,assignee_pubkey,external_url,created_at_ms

Rules for every row:
- title is required. Every other field may be blank.
- type must be one of: task, feature, bug, story, improvement, chore. If you can't tell, use task.
- container must be one of: backlog, active, icebox. Use backlog unless the source says otherwise.
- labels is SEMICOLON-separated, not comma-separated: auth;urgent
- created_at_ms is a Unix timestamp in MILLISECONDS. Convert whatever date format the source uses.
- assignee_pubkey: leave BLANK unless you have the person's Evenflow pubkey. Don't put an email
  or a display name there — those can't be matched to a person, and the issue imports unassigned
  either way. Blank is the honest answer.
- external_url is the original ticket's permalink. Keep it: it's how a re-import knows what it
  already brought in.
- status must match a column name on the destination board exactly (case doesn't matter). Ask me
  what the board's columns are if you don't already know.
- Never invent data. A field you don't have is blank.`;

export interface ImportPrompt {
  readonly vendor: string;
  readonly blurb: string;
  readonly body: string;
}

export const IMPORT_PROMPTS: ReadonlyArray<ImportPrompt> = [
  {
    vendor: "Linear",
    blurb: "Issues → CSV from the Linear export menu.",
    body: `Source is a Linear CSV export. Map it:

- Title -> title, Description -> body
- URL -> external_url. If there's no URL column, build it from the issue ID.
- Created -> created_at_ms
- Estimate -> estimate. Linear writes it as a plain integer; carry it as a plain integer.
  Blank ONLY when the source cell is truly empty — don't drop it because it looked small.
- Labels -> labels, semicolon-separated. Every non-empty label in the Labels cell survives;
  swap the "," between labels for ";" and keep the label text untouched. Do not filter out
  labels you consider organizational (team names, area tags) — they carry meaning on the
  destination board.
- Priority -> ALSO into labels as a "priority:<value>" tag, lowercased and hyphenated
  ("High" -> "priority:high", "No priority" -> "priority:none"). Evenflow's canonical schema
  has no priority column, so folding it into labels is how it survives the import. Append it
  to whatever labels the row already has; don't drop the row's other labels to make room.
- Linear's Status values are Backlog / Todo / In Progress / In Review / Done / Canceled /
  Duplicate. Map them to the destination board's column names. Canceled and Duplicate usually
  belong in whatever column that board treats as done — ask me rather than guessing.
- Linear has no type field. Infer it from labels: a "bug" label -> bug, "feature" or
  "enhancement" -> feature, otherwise task. (Use the Labels cell for this inference, NOT the
  priority:* tag you just added.)
- Issues in Backlog status usually want container backlog; anything In Progress or In Review
  wants active. Triage or parked states -> icebox.
- Drop Linear's Cycle, Project, Parent issue and SLA columns. Evenflow's canonical import
  doesn't carry them.
- Every source row becomes one output row. Descriptions often contain newlines and quotes —
  that is normal CSV, quote the body field and keep going; do not silently skip a row because
  its body was multi-line.`,
  },
  {
    vendor: "Jira",
    blurb: "Issues → Export → CSV (all fields).",
    body: `Source is a Jira CSV export. Map it:

- Summary -> title, Description -> body, Story Points -> estimate
- Created -> created_at_ms. Jira usually writes dates like "31/Jul/26 10:23 AM" — convert
  carefully, and read a 2-digit year as 20xx.
- Build external_url from your Jira base URL plus the Issue key, e.g.
  https://yourcompany.atlassian.net/browse/PROJ-123 — ask me for the base URL if you don't
  have it.
- Issue Type: Bug -> bug, Story -> story, Task and Sub-task -> task, Epic -> feature,
  Improvement -> improvement.
- JIRA EXPORTS REPEAT COLUMN NAMES. There are often several columns all headed "Labels", one
  per label, and the same for "Comment". Collect every Labels column for a row into ONE
  semicolon-separated list. Ignore the Comment columns entirely — comments don't import.
- Status -> the destination board's column names. Jira's defaults are To Do / In Progress /
  Done, which rarely match another board exactly.
- Drop Reporter, Resolution, Priority, Sprint and the Jira-internal id columns.`,
  },
  {
    vendor: "GitHub",
    blurb: "gh issue list --json number,title,body,state,labels,assignees,createdAt,url",
    body: `Source is a GitHub issues export — CSV, or JSON from:
gh issue list --json number,title,body,state,labels,assignees,createdAt,url

Map it:

- title -> title, body -> body, url -> external_url, createdAt -> created_at_ms
- labels -> labels, semicolon-separated
- GitHub has no type field. Infer from labels: "bug" -> bug, "enhancement" or "feature" ->
  feature, "chore" or "dependencies" -> chore, otherwise task.
- GitHub has only open and closed. Open -> the board's first working column, closed ->
  whatever column that board treats as done. Tell me the board's columns and I'll place them.
- GitHub has no estimate. Leave it blank unless a label encodes points.
- PULL REQUESTS ARE NOT ISSUES. If the export contains PRs, drop them.
- Closed issues usually want container backlog with a done status, not icebox — icebox means
  "deliberately parked", which isn't what closed means.`,
  },
];
