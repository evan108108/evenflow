/**
 * EFB-100: what an API key is allowed to do.
 *
 * Before this file a key WAS its owner — `claimsForApiKey` synthesizes the
 * owner's claims, so every authz path downstream granted owner authority and a
 * leaked key was a leaked account. A scope narrows a key to part of the
 * surface.
 *
 * TWO AXES, FLAT STRINGS
 * ----------------------
 *   <domain>:<access>          profile:read, org:write, notify:read
 *   board:<slug>:<access>      board:acme:write
 *   board:*:<access>           every board, INCLUDING ONES CREATED LATER
 *   owner                      everything, stated rather than implied
 *
 * Flat rather than nested because the questions people actually ask are grep
 * questions — "who needs board:*:write?", "which keys hold org:admin?" — and a
 * nested object answers those with a traversal. It also stores as a JSON array
 * of strings in one TEXT column, so adding a domain is not a shape migration,
 * and it renders as a 7x3 picker instead of a form builder.
 *
 * WHERE THE TWO HALVES ARE ENFORCED, AND WHY IT IS TWO PLACES
 * -----------------------------------------------------------
 * DOMAIN + ACCESS is enforced once, in the auth middleware, against the
 * requirement DERIVED from the route's manifest entry. That is the whole
 * perimeter: no manifest entry means no requirement means fail closed.
 *
 * INSTANCE (which board) cannot be enforced there, and pretending otherwise
 * would ship a feature that does not work. Half the board surface addresses
 * rows, not boards — `/issue/:id`, `/comment/:id`, `/attachment/:id` — so at
 * middleware time there is no slug to compare, only an opaque id whose board
 * is unknown until something reads the database. So the instance half is
 * enforced in `authorizeBoard`, the single funnel every board-authorized path
 * already reaches (authorizeBoardById and resolveBoardScope both call it), by
 * which point the board is resolved and its slug is in hand.
 *
 * That is two choke points for two DIFFERENT questions, each at the only layer
 * that can answer its own — not two systems answering the same question and
 * drifting.
 *
 * SCOPES ARE A SECOND GATE, NEVER A SUBSTITUTE. Every requireCaller,
 * boardScope, authorizeBoard and rejectKeyCallers check that existed before
 * this file still runs afterwards. If scope enforcement ever became the only
 * check on a path, a scope bug would become an authz bypass.
 */

import type { AuthLevel, Method, RouteEntry } from "./routes-manifest";

/**
 * The domains a scope can name.
 *
 * Collapsed from the manifest's 22 id families so the picker is human-sized:
 * everything that hangs off a board is one `board` domain, because "this key
 * may touch my boards" is the sentence a user actually means. The families
 * that stayed separate are the ones a user would deliberately withhold.
 */
export const SCOPE_DOMAINS = [
  "board",
  "org",
  "profile",
  "keys",
  "github",
  "storage",
  "notify",
] as const;

export type ScopeDomain = (typeof SCOPE_DOMAINS)[number];

/**
 * Domains a key may actually be GRANTED.
 *
 * `keys` is deliberately absent and this is the security posture of the whole
 * feature, not an oversight. `rejectKeyCallers` makes the key surface
 * JWT-only so a leaked key can never mint or revoke keys — a leaked key is a
 * leaked account, but it is not a leaked account that can breed more accounts
 * or lock the owner out. A `keys:admin` scope would hand that back. The domain
 * exists in the vocabulary only so the derived requirement table has a name
 * for those routes; the grant side refuses it and the picker never offers it.
 *
 * If a future case genuinely needs key-managing automation, the answer is a
 * JWT via OAuth, not a super-key — and it gets its own ticket and its own
 * threat model.
 */
export const GRANTABLE_DOMAINS: readonly ScopeDomain[] = SCOPE_DOMAINS.filter(
  (d) => d !== "keys",
);

/**
 * The access ladder, ascending. ADDITIVE: a grant satisfies any requirement at
 * or below it, within the same domain.
 *
 * Additive rather than exact-match because the codebase already works this
 * way: `authorizeBoard` takes a minRole and compares with `roleAtLeast`, so
 * roles are a ladder (viewer < contributor < admin < owner). Exact-match
 * scopes would run two opposite mental models inside one auth path, and a key
 * holding `board:*:write` being refused a GET is the astonishing outcome, not
 * the safe one.
 *
 * Additive WITHIN a domain only. `board:admin` grants nothing on `org`.
 */
export const SCOPE_ACCESS = ["read", "write", "admin"] as const;
export type ScopeAccess = (typeof SCOPE_ACCESS)[number];

const ACCESS_RANK: Readonly<Record<ScopeAccess, number>> = {
  read: 0,
  write: 1,
  admin: 2,
};

/** Full owner authority, stated. The only grant that is not `domain:access`. */
export const OWNER_SCOPE = "owner";

/** Every board, including ones created after the key was minted. */
export const BOARD_WILDCARD = "*";

/**
 * Which domain a route file belongs to.
 *
 * TOTAL over every file that owns a non-public route — `derivedRequirement`
 * throws on a miss rather than defaulting, so a new route file cannot reach
 * production without someone deciding what it is. Absence is ambiguity, and
 * ambiguity fails closed; it is never tacit permission.
 *
 * auth.ts, signin.ts, wellknown.ts and mcp.ts are absent on purpose: every
 * route they own is public or optional, so the auth level answers first and
 * the domain is never consulted. That is asserted by the checker, not assumed.
 */
const DOMAIN_BY_FILE: Readonly<Record<string, ScopeDomain>> = {
  // Everything that hangs off a board.
  "attachments.ts": "board",
  "audiences.ts": "board",
  "boards.ts": "board",
  "comments.ts": "board",
  "feed.ts": "board",
  "imports.ts": "board",
  "issues.ts": "board",
  "search.ts": "board",
  "sprints.ts": "board",
  "webhooks.ts": "board",
  // Org membership and the invitations that grant it.
  "orgs.ts": "org",
  "invites.ts": "org",
  // The caller's own identity and session.
  "profile.ts": "profile",
  "session.ts": "profile",
  // Never grantable — see GRANTABLE_DOMAINS.
  "keys.ts": "keys",
  "github.ts": "github",
  "storage.ts": "storage",
  "notifications.ts": "notify",
};

/** What a route demands of a scoped key. */
export type ScopeRequirement =
  /** No gate: the route is public or optional-auth, so a key adds nothing. */
  | { readonly kind: "public" }
  /**
   * Reachable by NO scoped key, whatever it holds. The keys surface, which
   * `rejectKeyCallers` already refuses; declaring it here makes the refusal
   * visible in the derived table instead of only in a guard three files away.
   */
  | { readonly kind: "never"; readonly why: string }
  | {
      readonly kind: "scope";
      readonly domain: ScopeDomain;
      readonly access: ScopeAccess;
    };

/**
 * Access a route's auth level demands.
 *
 * `caller` means "any signed-in user, no board role" — a read or a write
 * depending on the verb, which is the only signal that distinguishes
 * `GET /boards` from `POST /boards`.
 */
const accessFor = (auth: AuthLevel, method: Method): ScopeAccess | "public" => {
  switch (auth) {
    case "public":
    case "optional":
      return "public";
    case "viewer":
      return "read";
    case "contributor":
      return "write";
    case "admin":
    case "owner":
      return "admin";
    case "caller":
      return method === "GET" ? "read" : "write";
  }
};

/**
 * The scope a route requires, derived from what the manifest already declares.
 *
 * DERIVED, not hand-annotated, and that is the point. 106 hand-typed security
 * annotations is 106 chances to typo one that nobody notices until the wrong
 * key gets in; one function is a single thing to review and a single thing to
 * mutate when falsifying. `scripts/check-scope-declarations.mjs` prints the
 * full derived table so review reads 106 rows of output rather than diffing
 * 106 lines of annotation.
 *
 * Throws on a file with no domain. That is deliberate: it fires at module
 * load, so a route file nobody classified cannot boot the server, let alone
 * serve a request.
 */
export const derivedRequirement = (entry: RouteEntry): ScopeRequirement => {
  const access = accessFor(entry.auth, entry.method);
  if (access === "public") return { kind: "public" };

  const domain = DOMAIN_BY_FILE[entry.file];
  if (domain === undefined) {
    throw new Error(
      `EFB-100: no scope domain for route file "${entry.file}" (route ${entry.id}). ` +
        `Add it to DOMAIN_BY_FILE in src/scopes.ts — a route whose scope requirement ` +
        `is unknown must not be reachable.`,
    );
  }
  if (domain === "keys") {
    return {
      kind: "never",
      why: "the key surface is JWT-only so a leaked key cannot mint or revoke keys",
    };
  }
  return { kind: "scope", domain, access };
};

// ── grants ────────────────────────────────────────────────────────────────

/** A parsed grant. `board` is null for domains that carry no instance. */
export type Grant =
  | { readonly kind: "owner" }
  | {
      readonly kind: "scope";
      readonly domain: ScopeDomain;
      readonly access: ScopeAccess;
      /** Board slug, `*` for all boards, or null for non-board domains. */
      readonly board: string | null;
    };

const isAccess = (s: string): s is ScopeAccess =>
  (SCOPE_ACCESS as readonly string[]).includes(s);

const isDomain = (s: string): s is ScopeDomain =>
  (SCOPE_DOMAINS as readonly string[]).includes(s);

/**
 * Parse one grant string, or null if it is not a well-formed grant.
 *
 * Returns null rather than throwing so the caller decides: the create path
 * turns null into a 400 naming the offending string, while the verification
 * path drops it — a stored grant that no longer parses (a domain removed in a
 * later release, say) must not widen a key by being ignored, and dropping it
 * narrows.
 */
export const parseGrant = (raw: string): Grant | null => {
  if (raw === OWNER_SCOPE) return { kind: "owner" };
  const parts = raw.split(":");
  if (parts.length === 2) {
    const [domain, access] = parts as [string, string];
    if (domain === "board") return null; // board grants must name an instance
    if (!isDomain(domain) || !isAccess(access)) return null;
    return { kind: "scope", domain, access, board: null };
  }
  if (parts.length === 3) {
    const [domain, board, access] = parts as [string, string, string];
    if (domain !== "board") return null; // only board carries an instance
    if (!isAccess(access) || board === "") return null;
    return { kind: "scope", domain: "board", access, board };
  }
  return null;
};

/** Reason a grant string is refused at create time, or null if it is fine. */
export const grantRefusal = (raw: string): string | null => {
  const grant = parseGrant(raw);
  if (grant === null) return `"${raw}" is not a scope this API understands`;
  if (grant.kind === "owner") return null;
  if (!GRANTABLE_DOMAINS.includes(grant.domain)) {
    return `the ${grant.domain} domain is not grantable to an API key, because a key must never be able to mint or revoke keys`;
  }
  return null;
};

/**
 * Parse a stored scopes array into grants, dropping any that no longer parse.
 *
 * Dropping is the safe direction: an unparseable stored grant grants nothing.
 */
export const parseGrants = (scopes: readonly string[]): readonly Grant[] =>
  scopes.map(parseGrant).filter((g): g is Grant => g !== null);

/**
 * Read a key row's `scopes` column into grants, or null for a legacy key.
 *
 * null means the row predates EFB-100 and carries full owner authority — see
 * migrations/0030. A row whose JSON is unreadable is treated as granting
 * NOTHING (an empty grant list), never as owner: a corrupt value must not be
 * the widest one.
 */
export const grantsFromColumn = (raw: string | null): readonly Grant[] | null => {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parseGrants(parsed.filter((s): s is string => typeof s === "string"));
  } catch {
    return [];
  }
};

const satisfiesAccess = (held: ScopeAccess, required: ScopeAccess): boolean =>
  ACCESS_RANK[held] >= ACCESS_RANK[required];

/**
 * DOMAIN + ACCESS half, enforced in the auth middleware.
 *
 * A board grant for ANY instance satisfies this half — which board is settled
 * later by `grantsCoverBoard`, once the board is resolved. Splitting it this
 * way is what lets a key scoped to one board still use `/issue/:id`.
 */
export const grantsSatisfy = (
  grants: readonly Grant[],
  requirement: ScopeRequirement,
): boolean => {
  if (requirement.kind === "public") return true;
  if (requirement.kind === "never") return false;
  return grants.some(
    (g) =>
      g.kind === "owner" ||
      (g.domain === requirement.domain && satisfiesAccess(g.access, requirement.access)),
  );
};

/** Board roles, mapped onto the access ladder for the instance check. */
const ACCESS_FOR_ROLE: Readonly<Record<string, ScopeAccess>> = {
  viewer: "read",
  contributor: "write",
  admin: "admin",
  owner: "admin",
};

/**
 * INSTANCE half, enforced in `authorizeBoard` where the board is resolved.
 *
 * `minRole` is the role the handler already demanded; it maps onto the same
 * ladder so a key needs board access at least as strong as the role being
 * asked for.
 */
export const grantsCoverBoard = (
  grants: readonly Grant[],
  slug: string,
  minRole: string,
): boolean => {
  const required = ACCESS_FOR_ROLE[minRole] ?? "admin";
  return grants.some(
    (g) =>
      g.kind === "owner" ||
      (g.domain === "board" &&
        (g.board === BOARD_WILDCARD || g.board === slug) &&
        satisfiesAccess(g.access, required)),
  );
};

/** Human-readable requirement, for the 403 body. Prose, never a bare slug. */
export const describeRequirement = (requirement: ScopeRequirement): string => {
  if (requirement.kind === "public") return "no scope";
  if (requirement.kind === "never") return requirement.why;
  return requirement.domain === "board"
    ? `a board:<slug>:${requirement.access} or board:*:${requirement.access} scope`
    : `a ${requirement.domain}:${requirement.access} scope`;
};
