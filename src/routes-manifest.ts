/**
 * EFB-98: the single source of truth for every URL this API serves.
 *
 * Nothing else in the codebase may spell a route path. Route files, tests, the
 * web app and the generated docs all read from here, so renaming a URL is a
 * one-line edit rather than a grep-and-pray across 46 test files.
 *
 * WHY THIS EXISTS
 * ---------------
 * A coordinator script POSTed to `/boards/:slug/sprints/:id/issues` to attach
 * tickets to a sprint. The real path was `.../add-issue`, so the server 404'd,
 * the script ignored the status, and the tickets silently were not attached.
 * Three separate failures lined up: the URL was guessable-but-wrong because the
 * API was inconsistent, nothing rejected the bad shape at author time, and the
 * caller could not have derived the right URL from any single artifact.
 *
 * The manifest closes the third hole, `check-rest-conventions.mjs` closes the
 * second, and the conventions in docs/REST_CONVENTIONS.md close the first.
 *
 * A SECOND CLASS OF BUG THIS KILLS
 * --------------------------------
 * `issues.ts` used to register three routes through a helper called with a
 * VARIABLE path (`issues.post(path, ...)`). `check:boundary` scans route files
 * as text, so it could not see those routes at all — they were declared in an
 * allowlist as an audit-trail note rather than actually enforced. Registration
 * here is declaration, so a route that is not in this file does not exist, and
 * a computed path cannot hide one.
 *
 * ORG SCOPING
 * -----------
 * Ten routers are mounted twice: once at `/api/v0` and once under an org
 * prefix. Rather than declare every path twice (which drifts — exactly what we
 * are removing), an entry sets `orgScoped: true` and the router mints both
 * mounts from the one declaration. `effectivePaths()` below is what the
 * convention checker and the URL builder both expand through, so the two can
 * never disagree about what the API actually serves.
 */

/** HTTP methods this API uses. */
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Authorization required to reach a handler.
 *
 * NOTE (Phase 1): this field is DOCUMENTATION ONLY today. Authorization is
 * still enforced inside each handler by `requireCaller` / `boardScope` /
 * `orgScope`, which remain the security boundary. The field is declared now so
 * the manifest is shaped correctly, and each value is re-derived from the
 * handler it describes when that route moves to an action in Phase 2. Do not
 * make a security decision from this field until the router enforces it.
 */
export type AuthLevel =
  | "public"
  | "optional"
  | "caller"
  | "viewer"
  | "contributor"
  | "admin"
  | "owner";

export type RouteEntry = {
  /**
   * Stable handle. Tests and web callers reference routes by `id`, never by
   * path, so a URL can change without touching a single call site.
   */
  readonly id: string;
  readonly method: Method;
  /**
   * Canonical path WITHOUT any org prefix and without the `/api/v0` mount.
   * Must satisfy docs/REST_CONVENTIONS.md; check-rest-conventions.mjs enforces
   * that mechanically.
   */
  readonly path: string;
  /**
   * When true the route is ALSO served under `/org/:org_slug`, because its
   * router is mounted twice. See effectivePaths().
   */
  readonly orgScoped: boolean;
  /** Which route file owns it (until Phase 2 moves the logic to src/actions). */
  readonly file: string;
  readonly auth: AuthLevel;
  /**
   * Opt-in escape hatch for a genuine state transition that has no CRUD shape
   * — `start`, `complete`, `transition`. Without this flag the checker rejects
   * a trailing verb segment. Explicit beats an implicit allowlist: a new verb
   * route has to be justified in a diff.
   */
  readonly stateAction?: true;
  /**
   * Routes NOT mounted under `/api/v0` (the OAuth router at `/auth`, the MCP
   * and well-known routers at `/`). Recorded so the URL builder produces a
   * usable URL and the checker does not measure them against API conventions
   * they were never meant to satisfy.
   */
  readonly mount?: "auth" | "root";
};

/** The API's base mount. */
export const API_BASE = "/api/v0";

/**
 * Every route the server serves.
 *
 * Ordered by owning file to keep review diffable against the route sources.
 * Paths here are the POST-EFB-98 canonical spellings; the old ones are gone,
 * with no aliases, per the ticket's no-backward-compat rule.
 */
export const ROUTES = [
  // ---- attachments.ts -----------------------------------------------------
  {
    id: "attachment.create",
    method: "POST",
    path: "/board/:slug/issue/:issue_ref/attachments",
    orgScoped: true,
    file: "attachments.ts",
    auth: "contributor",
  },
  {
    id: "attachment.list",
    method: "GET",
    path: "/board/:slug/issue/:issue_ref/attachments",
    orgScoped: true,
    file: "attachments.ts",
    auth: "viewer",
  },
  {
    id: "attachment.update",
    method: "PATCH",
    path: "/attachment/:id",
    orgScoped: true,
    file: "attachments.ts",
    auth: "contributor",
  },
  {
    id: "attachment.delete",
    method: "DELETE",
    path: "/attachment/:id",
    orgScoped: true,
    file: "attachments.ts",
    auth: "contributor",
  },
  {
    id: "attachment.download",
    method: "GET",
    path: "/attachment/:id/download",
    orgScoped: true,
    file: "attachments.ts",
    auth: "viewer",
  },

  // ---- audiences.ts -------------------------------------------------------
  {
    id: "audience.keyGrant.get",
    method: "GET",
    path: "/board/:slug/key-grant",
    orgScoped: true,
    file: "audiences.ts",
    auth: "viewer",
  },
  {
    // Was POST /boards/:slug/request-regrant. "request-regrant" is a verb; the
    // thing being created is a regrant request, so it becomes a collection POST.
    id: "audience.regrantRequest.create",
    method: "POST",
    path: "/board/:slug/regrant-requests",
    orgScoped: true,
    file: "audiences.ts",
    auth: "viewer",
  },

  // ---- auth.ts (mounted at /auth, not /api/v0) ----------------------------
  { id: "auth.whoami", method: "GET", path: "/whoami", orgScoped: false, file: "auth.ts", auth: "optional", mount: "auth" },
  { id: "auth.session.create", method: "POST", path: "/session", orgScoped: false, file: "auth.ts", auth: "public", mount: "auth" },
  { id: "auth.session.delete", method: "DELETE", path: "/session", orgScoped: false, file: "auth.ts", auth: "optional", mount: "auth" },
  {
    id: "auth.oauth.start",
    method: "GET",
    path: "/oauth/start",
    orgScoped: false,
    file: "auth.ts",
    auth: "public",
    mount: "auth",
    stateAction: true,
  },
  { id: "auth.oauth.callback", method: "GET", path: "/callback", orgScoped: false, file: "auth.ts", auth: "public", mount: "auth" },

  // ---- boards.ts ----------------------------------------------------------
  { id: "board.create", method: "POST", path: "/boards", orgScoped: true, file: "boards.ts", auth: "caller" },
  {
    // NOT org-scoped, despite boards.ts being mounted under the org prefix.
    // `orgs.ts` separately registers GET /orgs/:slug/boards and is mounted
    // FIRST (index.ts:107 vs :136), so Hono has always resolved that URL to
    // the orgs.ts handler and this router's org twin has never been reachable.
    // check-rest-conventions rule 7 surfaced the collision; the web app
    // (HandlePage.tsx) consumes the orgs.ts response shape, confirming which
    // handler is the intended one. Declaring it truthfully here deletes a
    // route that only ever existed on paper.
    id: "board.list",
    method: "GET",
    path: "/boards",
    orgScoped: false,
    file: "boards.ts",
    auth: "caller",
  },
  { id: "board.get", method: "GET", path: "/board/:slug", orgScoped: true, file: "boards.ts", auth: "viewer" },
  { id: "board.velocity", method: "GET", path: "/board/:slug/velocity", orgScoped: true, file: "boards.ts", auth: "viewer" },
  { id: "board.update", method: "PATCH", path: "/board/:slug", orgScoped: true, file: "boards.ts", auth: "admin" },
  {
    // POST /archive + DELETE /archive replace POST /archive + POST /unarchive.
    // "unarchive" was a verb-in-URL for what is plainly the removal of a state.
    id: "board.archive.set",
    method: "POST",
    path: "/board/:slug/archive",
    orgScoped: true,
    file: "boards.ts",
    auth: "admin",
  },
  {
    id: "board.archive.clear",
    method: "DELETE",
    path: "/board/:slug/archive",
    orgScoped: true,
    file: "boards.ts",
    auth: "admin",
  },
  { id: "board.delete", method: "DELETE", path: "/board/:slug", orgScoped: true, file: "boards.ts", auth: "owner" },

  // ---- comments.ts --------------------------------------------------------
  { id: "comment.create", method: "POST", path: "/issue/:id/comments", orgScoped: true, file: "comments.ts", auth: "contributor" },
  { id: "comment.list", method: "GET", path: "/issue/:id/comments", orgScoped: true, file: "comments.ts", auth: "viewer" },
  { id: "comment.delete", method: "DELETE", path: "/comment/:id", orgScoped: true, file: "comments.ts", auth: "contributor" },

  // ---- feed.ts ------------------------------------------------------------
  { id: "feed.board.activity", method: "GET", path: "/board/:slug/activity", orgScoped: true, file: "feed.ts", auth: "viewer" },
  { id: "feed.issue.activity", method: "GET", path: "/issue/:id/activity", orgScoped: true, file: "feed.ts", auth: "viewer" },
  { id: "feed.board.stream", method: "GET", path: "/board/:slug/stream", orgScoped: true, file: "feed.ts", auth: "viewer" },

  // ---- github.ts ----------------------------------------------------------
  {
    // EXTERNAL CONTRACT: GitHub itself POSTs here, at a URL already saved in
    // every repo's webhook settings. Renaming it breaks those silently — the
    // deliveries just start 404ing — and unlike our own callers we cannot
    // migrate them from this repo.
    //
    // It also does not need renaming. The convention is singular-when-followed-
    // by-an-id, and `webhooks` here is followed by the literal `github`, not by
    // a parameter; `github` is what `:board_id` qualifies. So the plural is
    // correct: this is the collection of github webhook endpoints, one per
    // board. An earlier draft of this migration renamed it anyway, which would
    // have broken a live integration to satisfy a rule it already satisfied.
    id: "github.webhook.receive",
    method: "POST",
    path: "/webhooks/github/:board_id",
    orgScoped: false,
    file: "github.ts",
    auth: "public",
  },
  { id: "github.config.get", method: "GET", path: "/board/:slug/github", orgScoped: true, file: "github.ts", auth: "admin" },
  { id: "github.config.set", method: "PUT", path: "/board/:slug/github", orgScoped: true, file: "github.ts", auth: "admin" },
  { id: "github.config.delete", method: "DELETE", path: "/board/:slug/github", orgScoped: true, file: "github.ts", auth: "admin" },
  { id: "github.secret.set", method: "POST", path: "/board/:slug/github/secret", orgScoped: true, file: "github.ts", auth: "admin" },
  { id: "github.rules.set", method: "PUT", path: "/board/:slug/github/rules", orgScoped: true, file: "github.ts", auth: "admin" },
  {
    id: "github.connection.test",
    method: "POST",
    path: "/board/:slug/github/test",
    orgScoped: true,
    file: "github.ts",
    auth: "admin",
    stateAction: true,
  },
  { id: "github.audit.list", method: "GET", path: "/board/:slug/github/audit", orgScoped: true, file: "github.ts", auth: "admin" },

  // ---- imports.ts ---------------------------------------------------------
  { id: "import.issues.bulk", method: "POST", path: "/board/:slug/issues/bulk", orgScoped: true, file: "imports.ts", auth: "contributor" },
  { id: "import.list", method: "GET", path: "/board/:slug/imports", orgScoped: true, file: "imports.ts", auth: "admin" },

  // ---- invites.ts ---------------------------------------------------------
  { id: "invite.create", method: "POST", path: "/invites", orgScoped: false, file: "invites.ts", auth: "caller" },
  { id: "invite.get", method: "GET", path: "/invite/:code", orgScoped: false, file: "invites.ts", auth: "optional" },
  {
    id: "invite.accept",
    method: "POST",
    path: "/invite/:code/accept",
    orgScoped: false,
    file: "invites.ts",
    auth: "caller",
    stateAction: true,
  },
  {
    id: "invite.decline",
    method: "POST",
    path: "/invite/:code/decline",
    orgScoped: false,
    file: "invites.ts",
    auth: "caller",
    stateAction: true,
  },
  { id: "invite.email.send", method: "POST", path: "/invite/:id/email", orgScoped: false, file: "invites.ts", auth: "caller" },
  { id: "invite.delete", method: "DELETE", path: "/invite/:id", orgScoped: false, file: "invites.ts", auth: "caller" },
  { id: "invite.org.list", method: "GET", path: "/org/:org_slug/invites", orgScoped: false, file: "invites.ts", auth: "admin" },
  {
    id: "invite.orgBoard.list",
    method: "GET",
    path: "/org/:org_slug/board/:slug/invites",
    orgScoped: false,
    file: "invites.ts",
    auth: "admin",
  },

  // ---- issues.ts ----------------------------------------------------------
  { id: "issue.create", method: "POST", path: "/board/:slug/issues", orgScoped: true, file: "issues.ts", auth: "contributor" },
  { id: "issue.list", method: "GET", path: "/board/:slug/issues", orgScoped: true, file: "issues.ts", auth: "viewer" },
  { id: "issue.get", method: "GET", path: "/issue/:id", orgScoped: true, file: "issues.ts", auth: "viewer" },
  { id: "issue.update", method: "PATCH", path: "/issue/:id", orgScoped: true, file: "issues.ts", auth: "contributor" },
  { id: "issue.delete", method: "DELETE", path: "/issue/:id", orgScoped: true, file: "issues.ts", auth: "contributor" },
  {
    id: "issue.transition",
    method: "POST",
    path: "/issue/:id/transition",
    orgScoped: true,
    file: "issues.ts",
    auth: "contributor",
    stateAction: true,
  },
  {
    // Was POST /issues/:id/move-to-board. Deliberately NOT folded into
    // PATCH /issue/:id: moving a board requires write authorization on BOTH
    // the source and destination boards, and burying that in a PATCH branch
    // would hide a security check inside a conditional. A sub-resource with
    // its own handler keeps the rule visible.
    id: "issue.board.set",
    method: "PUT",
    path: "/issue/:id/board",
    orgScoped: true,
    file: "issues.ts",
    auth: "contributor",
  },
  {
    // Was PATCH /issues/:id/reorder. "reorder" is a verb; the noun it edits is
    // the issue's position.
    id: "issue.position.set",
    method: "PUT",
    path: "/issue/:id/position",
    orgScoped: true,
    file: "issues.ts",
    auth: "contributor",
  },
  {
    // Replaces THREE routes that were registered through a variable path and
    // were therefore invisible to check:boundary:
    //   POST /issues/:id/promote_to_active
    //   POST /issues/:id/promote_to_backlog
    //   POST /issues/:id/send_to_icebox
    // They were authorization-identical and differed only in destination, so
    // the destination belongs in the body: {"container": "active"}.
    id: "issue.container.set",
    method: "POST",
    path: "/issue/:id/container",
    orgScoped: true,
    file: "issues.ts",
    auth: "contributor",
  },

  // ---- keys.ts ------------------------------------------------------------
  { id: "key.create", method: "POST", path: "/keys", orgScoped: false, file: "keys.ts", auth: "caller" },
  { id: "key.list", method: "GET", path: "/keys", orgScoped: false, file: "keys.ts", auth: "caller" },
  { id: "key.delete", method: "DELETE", path: "/key/:id", orgScoped: false, file: "keys.ts", auth: "caller" },
  {
    // EFB-99. `stateAction: true` is declared even though it is not required:
    // `rotate` is absent from check-rest-conventions' CRUD_VERBS, so the
    // checker would pass this path without the flag. That is a gap in the
    // checker's vocabulary, not permission to elide the declaration — rotating
    // a credential is a real state transition, same class as
    // /invite/:code/accept and /issue/:id/transition, and the flag is how a
    // reader learns that from the manifest alone.
    id: "key.rotate",
    method: "POST",
    path: "/key/:id/rotate",
    orgScoped: false,
    file: "keys.ts",
    auth: "caller",
    stateAction: true,
  },

  // ---- mcp.ts (mounted at root) -------------------------------------------
  { id: "mcp.post", method: "POST", path: "/mcp", orgScoped: false, file: "mcp.ts", auth: "optional", mount: "root" },
  { id: "mcp.get", method: "GET", path: "/mcp", orgScoped: false, file: "mcp.ts", auth: "optional", mount: "root" },
  { id: "mcp.delete", method: "DELETE", path: "/mcp", orgScoped: false, file: "mcp.ts", auth: "optional", mount: "root" },

  // ---- notifications.ts ---------------------------------------------------
  { id: "notifications.config.get", method: "GET", path: "/notifications/config", orgScoped: false, file: "notifications.ts", auth: "caller" },
  { id: "notifications.config.set", method: "PATCH", path: "/notifications/config", orgScoped: false, file: "notifications.ts", auth: "caller" },

  // ---- orgs.ts ------------------------------------------------------------
  // Every org path here spells the parameter `:org_slug`. Before EFB-98 the
  // same concept appeared as `:slug` (20 uses), `:handle` (12) and `:org_slug`
  // (11), so which parameter held the org depended on which file you read.
  { id: "org.create", method: "POST", path: "/orgs", orgScoped: false, file: "orgs.ts", auth: "caller" },
  { id: "org.get", method: "GET", path: "/org/:org_slug", orgScoped: false, file: "orgs.ts", auth: "viewer" },
  { id: "org.update", method: "PATCH", path: "/org/:org_slug", orgScoped: false, file: "orgs.ts", auth: "admin" },
  { id: "org.delete", method: "DELETE", path: "/org/:org_slug", orgScoped: false, file: "orgs.ts", auth: "owner" },
  {
    id: "org.transfer",
    method: "POST",
    path: "/org/:org_slug/transfer",
    orgScoped: false,
    file: "orgs.ts",
    auth: "owner",
    stateAction: true,
  },
  { id: "org.boards.list", method: "GET", path: "/org/:org_slug/boards", orgScoped: false, file: "orgs.ts", auth: "viewer" },
  { id: "org.members.list", method: "GET", path: "/org/:org_slug/members", orgScoped: false, file: "orgs.ts", auth: "viewer" },
  { id: "org.member.add", method: "POST", path: "/org/:org_slug/members", orgScoped: false, file: "orgs.ts", auth: "admin" },
  { id: "org.member.update", method: "PATCH", path: "/org/:org_slug/member/:pubkey", orgScoped: false, file: "orgs.ts", auth: "admin" },
  { id: "org.member.remove", method: "DELETE", path: "/org/:org_slug/member/:pubkey", orgScoped: false, file: "orgs.ts", auth: "admin" },
  { id: "org.board.members.list", method: "GET", path: "/org/:org_slug/board/:slug/members", orgScoped: false, file: "orgs.ts", auth: "viewer" },
  { id: "org.board.member.add", method: "POST", path: "/org/:org_slug/board/:slug/members", orgScoped: false, file: "orgs.ts", auth: "admin" },
  {
    id: "org.board.member.update",
    method: "PATCH",
    path: "/org/:org_slug/board/:slug/member/:pubkey",
    orgScoped: false,
    file: "orgs.ts",
    auth: "admin",
  },
  {
    id: "org.board.member.remove",
    method: "DELETE",
    path: "/org/:org_slug/board/:slug/member/:pubkey",
    orgScoped: false,
    file: "orgs.ts",
    auth: "admin",
  },

  // ---- profile.ts ---------------------------------------------------------
  { id: "profile.me.get", method: "GET", path: "/profile/me", orgScoped: false, file: "profile.ts", auth: "caller" },
  { id: "profile.me.set", method: "PUT", path: "/profile/me", orgScoped: false, file: "profile.ts", auth: "caller" },
  { id: "profile.picture.create", method: "POST", path: "/profile/picture", orgScoped: false, file: "profile.ts", auth: "caller" },
  { id: "profile.list", method: "GET", path: "/profile", orgScoped: false, file: "profile.ts", auth: "optional" },
  { id: "profile.get", method: "GET", path: "/profile/:pubkey", orgScoped: false, file: "profile.ts", auth: "optional" },

  // ---- search.ts ----------------------------------------------------------
  {
    // POST rather than GET because the query arrives as a body; it is a search
    // request resource, not a mutation.
    id: "search.board",
    method: "POST",
    path: "/board/:slug/search",
    orgScoped: true,
    file: "search.ts",
    auth: "viewer",
  },

  // ---- session.ts ---------------------------------------------------------
  {
    id: "session.bootstrap",
    method: "POST",
    path: "/session/bootstrap",
    orgScoped: false,
    file: "session.ts",
    auth: "caller",
    stateAction: true,
  },
  {
    // Was POST /session/register-key — a verb for what is the creation of a
    // key within the session.
    id: "session.key.register",
    method: "POST",
    path: "/session/keys",
    orgScoped: false,
    file: "session.ts",
    auth: "caller",
  },

  // ---- signin.ts ----------------------------------------------------------
  { id: "signin.nostr.challenge", method: "GET", path: "/signin/nostr/challenge", orgScoped: false, file: "signin.ts", auth: "public" },
  { id: "signin.nostr.verify", method: "POST", path: "/signin/nostr", orgScoped: false, file: "signin.ts", auth: "public" },

  // ---- sprints.ts ---------------------------------------------------------
  { id: "sprint.list", method: "GET", path: "/board/:slug/sprints", orgScoped: true, file: "sprints.ts", auth: "viewer" },
  { id: "sprint.create", method: "POST", path: "/board/:slug/sprints", orgScoped: true, file: "sprints.ts", auth: "contributor" },
  { id: "sprint.update", method: "PATCH", path: "/board/:slug/sprint/:id", orgScoped: true, file: "sprints.ts", auth: "contributor" },
  { id: "sprint.delete", method: "DELETE", path: "/board/:slug/sprint/:id", orgScoped: true, file: "sprints.ts", auth: "contributor" },
  {
    id: "sprint.start",
    method: "POST",
    path: "/board/:slug/sprint/:id/start",
    orgScoped: true,
    file: "sprints.ts",
    auth: "contributor",
    stateAction: true,
  },
  {
    id: "sprint.complete",
    method: "POST",
    path: "/board/:slug/sprint/:id/complete",
    orgScoped: true,
    file: "sprints.ts",
    auth: "contributor",
    stateAction: true,
  },
  {
    // Was GET /boards/:slug/sprints/:id/archive, which collided with the
    // POST/DELETE archive state pair used elsewhere. This one READS the
    // archived issues; it never mutates archive state, so it gets the noun
    // that says so.
    id: "sprint.archivedIssues.list",
    method: "GET",
    path: "/board/:slug/sprint/:id/archived-issues",
    orgScoped: true,
    file: "sprints.ts",
    auth: "viewer",
  },
  { id: "sprint.tide", method: "GET", path: "/board/:slug/sprint/:id/tide", orgScoped: true, file: "sprints.ts", auth: "viewer" },
  { id: "board.tide", method: "GET", path: "/board/:slug/tide", orgScoped: true, file: "sprints.ts", auth: "viewer" },
  {
    // THE BUG THIS TICKET EXISTS FOR. Was POST .../sprints/:id/add-issue.
    // A caller who guessed the RESTful spelling got a silent 404.
    id: "sprint.issues.attach",
    method: "POST",
    path: "/board/:slug/sprint/:id/issues",
    orgScoped: true,
    file: "sprints.ts",
    auth: "contributor",
  },
  {
    // Was POST .../sprints/:id/remove-issue with the id in the body. Removal
    // is a DELETE, and the thing removed is addressable, so it goes in the path.
    id: "sprint.issue.detach",
    method: "DELETE",
    path: "/board/:slug/sprint/:id/issue/:issue_id",
    orgScoped: true,
    file: "sprints.ts",
    auth: "contributor",
  },

  // ---- storage.ts ---------------------------------------------------------
  { id: "storage.serverPubkey", method: "GET", path: "/server-pubkey", orgScoped: false, file: "storage.ts", auth: "public" },
  { id: "storage.get", method: "GET", path: "/org/:org_slug/storage", orgScoped: false, file: "storage.ts", auth: "admin" },
  { id: "storage.set", method: "PUT", path: "/org/:org_slug/storage", orgScoped: false, file: "storage.ts", auth: "admin" },
  { id: "storage.delete", method: "DELETE", path: "/org/:org_slug/storage", orgScoped: false, file: "storage.ts", auth: "admin" },
  {
    id: "storage.test",
    method: "POST",
    path: "/org/:org_slug/storage/test",
    orgScoped: false,
    file: "storage.ts",
    auth: "admin",
    stateAction: true,
  },

  // ---- webhooks.ts --------------------------------------------------------
  { id: "webhook.list", method: "GET", path: "/board/:slug/webhooks", orgScoped: true, file: "webhooks.ts", auth: "admin" },
  { id: "webhook.create", method: "POST", path: "/board/:slug/webhooks", orgScoped: true, file: "webhooks.ts", auth: "admin" },
  { id: "webhook.update", method: "PATCH", path: "/board/:slug/webhook/:id", orgScoped: true, file: "webhooks.ts", auth: "admin" },
  { id: "webhook.delete", method: "DELETE", path: "/board/:slug/webhook/:id", orgScoped: true, file: "webhooks.ts", auth: "admin" },
  {
    id: "webhook.deliveries.list",
    method: "GET",
    path: "/board/:slug/webhook/:id/deliveries",
    orgScoped: true,
    file: "webhooks.ts",
    auth: "admin",
  },

  // ---- wellknown.ts (mounted at root) -------------------------------------
  {
    // EFB-103 — the whole documentation set as one text/plain document, so an
    // agent can read it in a single request instead of crawling the SPA.
    id: "docs.llms",
    method: "GET",
    path: "/docs/llms.txt",
    orgScoped: false,
    file: "docs.ts",
    auth: "public",
    mount: "root",
  },
  {
    id: "wellknown.oauthProtectedResource",
    method: "GET",
    path: "/.well-known/oauth-protected-resource",
    orgScoped: false,
    file: "wellknown.ts",
    auth: "public",
    mount: "root",
  },
] as const satisfies readonly RouteEntry[];

export type RouteId = (typeof ROUTES)[number]["id"];

const BY_ID = new Map<string, RouteEntry>(ROUTES.map((r) => [r.id, r]));

/** Look up an entry, throwing on an unknown id so a typo fails loudly. */
export const route = (id: RouteId): RouteEntry => {
  const entry = BY_ID.get(id);
  if (entry === undefined) throw new Error(`Unknown route id: ${id}`);
  return entry;
};

/**
 * The path a route file registers with Hono.
 *
 * Routers are mounted under a prefix, so what they register is the entry's own
 * path — no `/api/v0`, no org prefix. This is the ONLY way a route file may
 * spell a URL:
 *
 *   issues.get(path("issue.get"), handler)
 *
 * A string literal in a route file is the defect this ticket removes: it is
 * how the manifest and the server drift, and drift is how a caller ends up
 * POSTing to a URL that 404s.
 *
 * The return type is the specific literal path for `id`, not `string`. That
 * matters more than it looks: Hono derives a handler's parameter types from
 * the literal it is registered with, so a widened `string` would silently turn
 * every `c.req.param("slug")` into `string | undefined` across the codebase.
 * Keeping the literal type means routing moves into the manifest and nothing
 * about handler typing changes.
 */
type EntryFor<Id extends RouteId> = Extract<(typeof ROUTES)[number], { id: Id }>;

export const path = <Id extends RouteId>(id: Id): EntryFor<Id>["path"] =>
  route(id).path as EntryFor<Id>["path"];

/** The prefix an entry is mounted under, before its own path. */
export const mountPrefix = (entry: RouteEntry): string =>
  entry.mount === "auth" ? "/auth" : entry.mount === "root" ? "" : API_BASE;

/**
 * Every fully-qualified path an entry actually serves.
 *
 * An org-scoped entry serves two: the bare one and the org-prefixed one. The
 * router wires both, the checker validates both, and the URL builder picks
 * between them — all from this one function, so they cannot disagree.
 */
export const effectivePaths = (entry: RouteEntry): readonly string[] => {
  const base = `${mountPrefix(entry)}${entry.path}`;
  return entry.orgScoped ? [base, `${mountPrefix(entry)}/org/:org_slug${entry.path}`] : [base];
};

/**
 * EFB-100: which entry serves a request Hono has already matched.
 *
 * The auth middleware needs the manifest entry to know what scope a route
 * requires, and the only handle it has at that point is the pattern Hono
 * matched. `routePath(c, -1)` returns that pattern fully qualified — mount
 * prefix and org segment included — which is precisely what effectivePaths()
 * generates, so the two sides are keyed off the same function and cannot
 * drift. (Verified against hono 4.12.32 rather than assumed: a probe asserted
 * both `/api/v0/board/:slug/issues` and the org-prefixed spelling come back
 * exactly as written here.)
 *
 * A pattern with no entry returns null, and the middleware treats null as
 * FAIL CLOSED for a scoped key. That is what makes "every route declares a
 * scope" a property of routing rather than a linter's opinion: a route
 * registered outside this file is unreachable by a scoped key, because
 * nothing here can say what it would take to reach it.
 */
const BY_MATCH = new Map<string, RouteEntry>();
for (const entry of ROUTES) {
  for (const p of effectivePaths(entry)) BY_MATCH.set(`${entry.method} ${p}`, entry);
}

export const entryForMatch = (method: string, matchedPath: string): RouteEntry | null =>
  BY_MATCH.get(`${method} ${matchedPath}`) ?? null;

/**
 * Build a concrete URL for a route.
 *
 * Throws when a required parameter is missing, which is the point: the silent
 * 404 that motivated this ticket becomes an author-time error instead. Passing
 * `org` to a route that is not org-scoped is likewise an error rather than a
 * quietly ignored argument.
 */
export const url = (
  id: RouteId,
  params: Readonly<Record<string, string>> = {},
  org?: string,
): string => {
  const entry = route(id);
  if (org !== undefined && !entry.orgScoped) {
    throw new Error(`Route ${id} is not org-scoped; drop the org argument`);
  }
  const template =
    org === undefined
      ? `${mountPrefix(entry)}${entry.path}`
      : `${mountPrefix(entry)}/org/:org_slug${entry.path}`;
  const filled: Readonly<Record<string, string | undefined>> = {
    ...params,
    ...(org === undefined ? {} : { org_slug: org }),
  };
  return template.replace(/:([A-Za-z_][\w]*)/g, (_m, name: string) => {
    const value = filled[name];
    if (value === undefined) {
      throw new Error(`Route ${id} requires parameter ":${name}"`);
    }
    return encodeURIComponent(value);
  });
};
