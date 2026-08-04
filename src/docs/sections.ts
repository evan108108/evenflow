/**
 * EFB-103: the documentation, written once.
 *
 * Rendered as pages at /docs/<id> by the SPA and as one Markdown document at
 * /docs/llms.txt by the Worker. Both read THIS — see model.ts for why that
 * matters more than it looks.
 *
 * TONE: agents first, humans close behind. In practice that means every claim
 * comes with a runnable command, tables beat paragraphs for anything
 * enumerable, and nothing says "click the button in the corner" without also
 * saying which endpoint the button calls. A human reading it should still find
 * a quickstart rather than a schema dump, which is why Getting started leads.
 */

import type { DocSection } from "./model";

const KEY = "$EVENFLOW_KEY";

export const SECTIONS: readonly DocSection[] = [
  {
    id: "quickstart",
    title: "Getting started",
    blurb: "From nothing to a board with an issue on it, in five minutes.",
    blocks: [
      {
        kind: "p",
        text: "Evenflow is a kanban whose API is not an afterthought — every action in the UI is a documented endpoint, and an API key can do anything you can do (or much less, if you scope it). If you are an agent, start here and then read the API reference; everything else is context.",
      },
      { kind: "h", text: "1. Sign in and mint a key" },
      {
        kind: "p",
        text: "Humans sign in at /signin with Google, GitHub, or a Nostr key. Keys are minted from the UI at /settings/keys — the plaintext is shown exactly once, at creation, and only a hash is stored. There is no endpoint that reveals it again, and there is no way for a key to mint another key.",
      },
      {
        kind: "code",
        lang: "bash",
        code: `export EVENFLOW_KEY="evk_..."   # from https://evenflow.work/settings/keys

# Confirm it works. 200 means you are authenticated as the key's owner.
curl -s "https://evenflow.work/api/v0/boards" \\
  -H "Authorization: Bearer ${KEY}"`,
      },
      { kind: "h", text: "2. Create a board" },
      {
        kind: "code",
        lang: "bash",
        code: `curl -s -X POST "https://evenflow.work/api/v0/boards" \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"slug":"my-board","title":"My board"}'`,
      },
      { kind: "h", text: "3. Add an issue" },
      {
        kind: "p",
        text: "Issues are created against a board slug. A new issue lands in the backlog container unless you say otherwise.",
      },
      {
        kind: "code",
        lang: "bash",
        code: `curl -s -X POST "https://evenflow.work/api/v0/board/my-board/issues" \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"First issue","body":"Written by an agent."}'`,
      },
      { kind: "h", text: "4. Move it" },
      {
        kind: "p",
        text: "An issue has two independent axes: its CONTAINER (backlog, active, icebox) and its COLUMN within the board's workflow. Moving between containers is what puts work on the kanban; moving between columns is progress across it.",
      },
      {
        kind: "code",
        lang: "bash",
        code: `# List issues to find the short id (e.g. MY-1)
curl -s "https://evenflow.work/api/v0/board/my-board/issues" \\
  -H "Authorization: Bearer ${KEY}"

# Move it onto the kanban
curl -s -X PATCH "https://evenflow.work/api/v0/issue/MY-1" \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"container":"active"}'`,
      },
      { kind: "h", text: "5. Narrow the key you just used" },
      {
        kind: "p",
        text: "The key above can do anything its owner can. That is the default, not a recommendation. Mint a second key limited to one board, and use that one for the integration you are building — see Authentication for the grammar.",
      },
      {
        kind: "p",
        text: "If you are an agent and want everything in one request rather than seven pages: https://evenflow.work/docs/llms.txt",
      },
    ],
  },

  {
    id: "concepts",
    title: "Concepts",
    blurb: "Boards, containers, columns, sprints, and the words this API uses for them.",
    blocks: [
      { kind: "h", text: "Boards" },
      {
        kind: "p",
        text: "A board owns issues, sprints, columns and members. It is addressed by slug, and lives either under a personal handle or an organisation. Boards are private by default; a public board can be READ without signing in, which is why anonymous callers are a first-class case throughout this API rather than an error.",
      },
      { kind: "h", text: "Containers and columns are different axes" },
      {
        kind: "p",
        text: "This is the single most common confusion, so it is worth being blunt about. An issue's CONTAINER answers 'is this work in play?' and its COLUMN answers 'how far along is it?'.",
      },
      {
        kind: "table",
        head: ["Container", "Meaning"],
        rows: [
          ["backlog", "Real work, not started. The default for a new issue."],
          ["active", "On the kanban. This is what the board view shows."],
          ["icebox", "Deliberately not now. Survives sprint sweeps untouched."],
        ],
      },
      {
        kind: "p",
        text: "Columns are per-board and user-defined (Todo, Doing, Done, or whatever the board says). A column carries a CATEGORY, and the done-ness of an issue is a property of its column's category rather than of its name — which is why renaming a column does not silently change what counts as finished.",
      },
      { kind: "h", text: "Sprints" },
      {
        kind: "p",
        text: "A sprint is a named batch of issues that starts together and completes together. Lifecycle is one-way: planning → active → completed.",
      },
      {
        kind: "list",
        items: [
          "Starting a sprint promotes every backlog member to active, and sweeps in anything already active that is not done — starting a sprint is a commitment to what is in flight.",
          "Completing a sprint stamps the sprint, not the issues: unfinished work stays active and either carries to the next planning sprint or returns to the backlog.",
          "Membership moves only through the attach and detach endpoints. An issue PATCH cannot change sprint_id — it is immutable there on purpose.",
          "Points are snapshotted at start and at completion, so velocity is a cheap read rather than a recomputation over history.",
        ],
      },
      { kind: "h", text: "Provenance" },
      {
        kind: "p",
        text: "Every published board event names who caused it, and the vocabulary is closed. This matters because events are signed and published to a substrate: an event that misattributes an action is not a display bug, it is an unretractable claim that someone did something they did not do.",
      },
      {
        kind: "table",
        head: ["Source", "Means"],
        rows: [
          ["route.caller", "A human or key acting on their own behalf, verified this request."],
          ["audit.system", "Nobody — a tombstone, a backfill, an administrative act."],
          ["github.actor", "A GitHub identity, re-attested server-side from a verified webhook."],
          ["external.webhook", "An outside system acting through a subscription."],
        ],
      },
      { kind: "h", text: "API keys" },
      {
        kind: "p",
        text: "A key authenticates as its owner. Without scopes it can do anything that owner can; with scopes it is narrowed to part of the surface. Keys never expire on a clock — revocation and rotation are the controls. See Authentication.",
      },
    ],
  },

  {
    id: "auth",
    title: "Authentication",
    blurb: "Sign-in options, API keys, scopes, and rotation.",
    blocks: [
      { kind: "h", text: "Ways to sign in" },
      {
        kind: "list",
        items: [
          "OAuth — Google or GitHub, at /signin. Issues a JWT held in the browser.",
          "Nostr — sign a challenge with your own key at /signin/nostr; your npub is your identity, no password and no email.",
          "Invite — an invite link admits a new member, including an agent, to a board or org without an account existing first.",
        ],
      },
      { kind: "h", text: "API keys" },
      {
        kind: "p",
        text: "Mint at /settings/keys. The plaintext appears exactly once; storage keeps sha256 plus a 12-character display prefix. Two properties are worth knowing before you build on them.",
      },
      {
        kind: "list",
        items: [
          "A key cannot manage keys. Create, rotate and revoke are JWT-only, so a leaked key can never mint a successor or lock you out — it cannot outlive its own revocation.",
          "Keys do not expire on a clock. Revoking is immediate; rotating gives you a grace window in which both secrets work, so you can redeploy without downtime.",
        ],
      },
      { kind: "h", text: "Scopes" },
      {
        kind: "p",
        text: "A key carries a scopes array that narrows what it can reach. Keys minted before scoping existed, and keys created with no explicit choice, carry full owner authority — that is the default, because silently narrowing an existing integration would break it.",
      },
      {
        kind: "code",
        lang: "text",
        code: `owner                    everything, stated rather than implied
<domain>:<access>        profile:read, org:write, notify:read
board:<slug>:<access>    board:acme:write
board:*:<access>         every board, INCLUDING ones you create later`,
      },
      {
        kind: "table",
        head: ["Domain", "Covers"],
        rows: [
          ["board", "issues, sprints, comments, attachments, feed, search, imports, webhooks"],
          ["org", "organisations, members, invites"],
          ["profile", "your own profile and session"],
          ["github", "GitHub connection and rules"],
          ["storage", "attachment storage configuration"],
          ["notify", "notification preferences"],
        ],
      },
      {
        kind: "p",
        text: "Access runs read < write < admin and is ADDITIVE WITHIN A DOMAIN: a key holding board:*:write satisfies a read requirement, and grants nothing at all on org. There is deliberately no keys domain — no scope reaches the key surface, because a key that could mint keys would undo its own revocation.",
      },
      {
        kind: "p",
        text: "Scopes are fixed when the key is minted. There is no endpoint that narrows a key in place, because that would be a downgrade path an attacker could walk as easily as an owner. To change a key's reach, mint a new one and revoke the old. A rotation carries the parent's scopes forward verbatim — a successor is capped by its parent, never widened by the act of rotating.",
      },
      {
        kind: "code",
        lang: "bash",
        code: `# What a scoped key gets when it reaches outside its scopes: 403, with prose.
curl -s "https://evenflow.work/api/v0/notifications/config" \\
  -H "Authorization: Bearer ${KEY}"
# {"error":"forbidden","reason":"this key is missing a notify:read scope"}`,
      },
      { kind: "h", text: "What the status codes mean" },
      {
        kind: "table",
        head: ["Code", "Means"],
        rows: [
          ["401", "No credential, or one that does not verify. Also what an anonymous caller gets for anything non-public."],
          ["403", "Verified, but not allowed — under-role, out of scope, or a JWT-only endpoint reached with a key."],
          ["404", "Not found, OR found and invisible to you. The two are deliberately indistinguishable so existence does not leak."],
          ["400", "The request shape is wrong. The reason names the offending field."],
          ["409", "A state conflict — starting a started sprint, rotating a rotated key."],
        ],
      },
    ],
  },

  {
    id: "api",
    title: "API reference",
    blurb: "Every endpoint the server serves, generated from its own route manifest.",
    blocks: [
      {
        kind: "p",
        text: "This list is generated from the server's route manifest at build time, not maintained by hand. If an endpoint exists, it is here; if it is here, the server serves it. Paths that a router mounts twice are shown in both spellings.",
      },
      {
        kind: "p",
        text: "Path parameters are left as :placeholders rather than filled with plausible ids, so a pasted command tells you what to replace instead of 404ing against something that never existed.",
      },
      { kind: "api-reference" },
    ],
  },

  {
    id: "mcp",
    title: "MCP",
    blurb: "Point an AI agent at Evenflow over the Model Context Protocol.",
    blocks: [
      {
        kind: "p",
        text: "Evenflow speaks MCP over Streamable HTTP at https://evenflow.work/mcp. Every tool is a thin wrapper over the same REST surface documented here — the MCP server dispatches an internal request through the same routers, so validation, authorisation, audit rows and event fan-out are identical whether a call arrives over REST or MCP. They cannot drift.",
      },
      {
        kind: "code",
        lang: "json",
        code: `{
  "mcpServers": {
    "evenflow": {
      "type": "http",
      "url": "https://evenflow.work/mcp",
      "headers": { "Authorization": "Bearer evk_your_key_here" }
    }
  }
}`,
      },
      {
        kind: "p",
        text: "Authentication is the same bearer token as REST, and SO IS SCOPING. A key narrowed to one board is narrowed on MCP too — the scope check lives in the shared auth middleware that the MCP server's internal app is built from, so there is no second gate to forget and no MCP-shaped hole around it.",
      },
      {
        kind: "p",
        text: "tools/list and initialize are public so a client can discover the surface; tools/call requires a credential.",
      },
    ],
  },

  {
    id: "integrations",
    title: "Integrations",
    blurb: "GitHub, webhooks, CSV import, attachments, Nostr.",
    blocks: [
      { kind: "h", text: "GitHub" },
      {
        kind: "p",
        text: "Connect a board to a repository and issues gain external state: a rule maps GitHub activity (a PR opening, a branch merging) onto a column transition. The webhook is HMAC-verified, and the resulting board event is attributed to github.actor — a re-attested GitHub identity, never the person who connected the integration.",
      },
      { kind: "h", text: "Webhook subscriptions" },
      {
        kind: "p",
        text: "Subscribe an outside URL to board events. Deliveries are signed so a receiver can verify them, and events published by a subscription carry external.webhook provenance rather than pretending a human acted.",
      },
      { kind: "h", text: "CSV import" },
      {
        kind: "p",
        text: "Bulk-create issues from a CSV. The importer canonicalises columns and reports per-row failures rather than aborting the batch, so a malformed row does not cost you the other four hundred.",
      },
      { kind: "h", text: "Attachments" },
      {
        kind: "p",
        text: "Files are content-addressed and stored on Blossom, which has a consequence worth stating plainly: sharing the link is sharing the file. An attachment URL is not access-controlled by the board it hangs off.",
      },
      { kind: "h", text: "Nostr" },
      {
        kind: "p",
        text: "Sign in by signing a challenge with your own key. Your npub is the identity — there is no account to create and no password to lose. Board events are published to the substrate as signed events, which is why provenance is a closed vocabulary rather than a free-text field.",
      },
    ],
  },

  {
    id: "recipes",
    title: "Recipes",
    blurb: "Whole tasks, end to end, in runnable form.",
    blocks: [
      { kind: "h", text: "File issues from an external alert" },
      {
        kind: "p",
        text: "Mint a key scoped to exactly one board with write access, and nothing else. If that key leaks, the blast radius is one board — not your account.",
      },
      {
        kind: "code",
        lang: "bash",
        code: `# Mint from the UI at /settings/keys with scope board:alerts:write, then:
curl -s -X POST "https://evenflow.work/api/v0/board/alerts/issues" \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Error rate above threshold","body":"From the alerting webhook."}'`,
      },
      { kind: "h", text: "Rotate a key without downtime" },
      {
        kind: "p",
        text: "Rotation mints a successor and leaves the old secret working for a grace window, so you can deploy the new one before the old stops. Rotation is JWT-only — it mints a key, and mint-shaped operations are never reachable with a key.",
      },
      {
        kind: "code",
        lang: "bash",
        code: `# From a signed-in session (JWT), not with an evk_ key:
curl -s -X POST "https://evenflow.work/api/v0/key/<key-id>/rotate" \\
  -H "Authorization: Bearer $EVENFLOW_JWT"
# → { "key": { ... }, "plaintext": "evk_..." }   ← shown once
# Deploy the new secret, then let the window lapse or revoke the old key.`,
      },
      { kind: "h", text: "Read sprint velocity" },
      {
        kind: "code",
        lang: "bash",
        code: `# Points completed and carried are snapshotted on the sprint row at
# completion, so this is a cheap read rather than a recomputation.
curl -s "https://evenflow.work/api/v0/board/my-board/sprints" \\
  -H "Authorization: Bearer ${KEY}"`,
      },
      { kind: "h", text: "Read a public board with no credential at all" },
      {
        kind: "code",
        lang: "bash",
        code: `curl -s "https://evenflow.work/api/v0/board/some-public-board/issues"`,
      },
    ],
  },

  {
    id: "reference",
    title: "Reference tables",
    blurb: "The closed vocabularies: containers, provenance, scopes, errors.",
    blocks: [
      { kind: "h", text: "Scope grammar" },
      {
        kind: "table",
        head: ["Production", "Example", "Covers"],
        rows: [
          ["owner", "owner", "Everything the owner can do."],
          ["<domain>:<access>", "org:write", "One domain, at that access or below."],
          ["board:<slug>:<access>", "board:acme:read", "One named board."],
          ["board:*:<access>", "board:*:write", "Every board, including future ones."],
        ],
      },
      { kind: "h", text: "Access ladder" },
      {
        kind: "table",
        head: ["Access", "Satisfies", "Typical routes"],
        rows: [
          ["read", "read", "GETs — listing and reading."],
          ["write", "read, write", "Creating and editing."],
          ["admin", "read, write, admin", "Settings, members, destructive actions."],
        ],
      },
      { kind: "h", text: "Containers" },
      {
        kind: "table",
        head: ["Container", "On the kanban?", "Swept by sprint start?"],
        rows: [
          ["backlog", "no", "yes, if a sprint member"],
          ["active", "yes", "already there"],
          ["icebox", "no", "no — icing is an explicit not-now"],
        ],
      },
      { kind: "h", text: "Provenance sources" },
      {
        kind: "table",
        head: ["Source", "Actor recorded"],
        rows: [
          ["route.caller", "The verified caller of this request."],
          ["audit.system", "Nobody. Tombstones and backfills."],
          ["github.actor", "A GitHub login, re-attested server-side."],
          ["external.webhook", "The subscription that delivered the event."],
        ],
      },
      { kind: "h", text: "Error envelope" },
      {
        kind: "p",
        text: "Every error is {\"error\": <slug>, \"reason\": <prose or field name>}. The reason is meant to be read: it names the field that was wrong or the scope that was missing, rather than restating the status code.",
      },
    ],
  },
];

/** Lookup by URL segment. */
export const sectionById = (id: string): DocSection | undefined =>
  SECTIONS.find((s) => s.id === id);
