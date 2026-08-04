/**
 * EFB-98: the interface every action implements.
 *
 * An ACTION is a route's business logic with the HTTP taken out of it. Routes
 * in src/routes/*.ts become thin shells that extract parameters, parse the
 * body, call an action, and hand the result to runJson. The action itself
 * never imports Hono and never sees a Context.
 *
 * WHY
 * ---
 * Before this split, the only way to test a behaviour was to name a URL. That
 * is what let a caller and the server disagree about a path while every test
 * stayed green: the tests asserted the same wrong string the client used.
 * An action is callable directly, so a test can prove the behaviour without
 * asserting anything about routing, and the routing is proved separately by
 * the manifest and its checker.
 *
 * WHAT STAYS IN THE ROUTE
 * -----------------------
 *  - reading params off the request
 *  - `parseRouteBody(c, SomeSchema)` — so check:boundary keeps seeing the
 *    body read where it has always seen it, and BOUNDARY_DISCIPLINE's rules
 *    keep applying unchanged
 *  - `c.get("claims")` and `c.get("token")`
 *  - runJson
 *
 * WHAT MOVES TO THE ACTION
 * ------------------------
 *  - authorization (requireCaller's RESULT is passed in; boardScope-style
 *    lookups run inside, because they need the database)
 *  - validation that needs state the schema cannot see
 *  - persistence, audit records, event emission
 *  - the returned value
 */

import type { Claims } from "../effects";
import type { Grant } from "../scopes";

/**
 * What an action receives.
 *
 * `body` is already decoded by the route's schema, so an action never handles
 * a malformed request — by the time it runs, the shape is settled.
 *
 * `orgSlug` is explicit rather than implied by the URL. Ten routers are
 * mounted twice, bare and under `/org/:org_slug`, and handlers branch on that
 * parameter to resolve which org a board belongs to. It is business input, not
 * a routing detail, so it is a field.
 */
export type ActionInput<Body = undefined> = {
  /**
   * The verified caller. The route runs `requireCaller` and passes the RESULT,
   * so an action typed this way cannot be reached anonymously — the 401 has
   * already happened by the time it runs.
   */
  readonly claims: Claims;
  /**
   * The caller's raw bearer token, or "" when the route does not need it.
   *
   * A field rather than an extra positional argument on the handful of actions
   * that use it. `ensurePersonalOrg` and `upsertMembership` publish signed
   * kind-30521 grants ON THE CALLER'S BEHALF, which is business logic that
   * happens to need the credential — and a token threaded through a second
   * parameter would be spelled differently by every family that hit the need.
   * It travels with `claims` because it belongs to the same caller and the
   * same trust domain.
   */
  readonly token: string;
  /**
   * EFB-100 — what the caller's API key may do, or null when nothing narrows
   * them (a JWT session, or a key minted before scoping existed).
   *
   * REQUIRED, unlike every other field on the options bag, and deliberately
   * so. The others are inputs: forgetting one yields a wrong answer, loudly.
   * This one is AUTHORITY, and a forgotten authority field yields a request
   * that succeeds when it should not, seen by nobody. Requiring it makes
   * tsc name every route that has not threaded it.
   *
   * The middleware has already enforced the DOMAIN+ACCESS half by the time an
   * action runs; this is here so `authorizeBoard` can enforce the INSTANCE
   * half once it has resolved which board is being asked for.
   */
  readonly grants: readonly Grant[] | null;
  /**
   * Which org this request is scoped to, or null when it is not scoped to one.
   *
   * Always read from `c.req.param("org_slug")`, REGARDLESS of where that
   * parameter came from. For a board-family route it arrives from the
   * `/org/:org_slug` mount prefix; for the orgs router it is part of the
   * route's own declared path. Those are different plumbing and the same fact,
   * so an action asks one field and never has to know which family it is in.
   *
   * Null is a real answer, not an absence: `POST /orgs` creates an org and is
   * scoped to none.
   *
   * It is also present in `params`, because `params` is the raw bag off the
   * request. They cannot disagree — `actionInput` fills both from the same
   * call — and this one is the named accessor with the meaning attached.
   */
  readonly orgSlug: string | null;
  /** Path parameters, already extracted. */
  readonly params: Readonly<Record<string, string>>;
  /** Query-string parameters. Absent keys are undefined, never "". */
  readonly query: Readonly<Record<string, string | undefined>>;
  /** The decoded request body, or undefined for routes that read none. */
  readonly body: Body;
};

/**
 * What an action reachable WITHOUT a caller receives.
 *
 * The API runs `/api/v0/*` behind optional auth so public boards read without
 * sign-in, which means a read action has to cope with `claims === null`. Giving
 * those a distinct input type means the auth posture of a handler is visible in
 * its signature: if it takes `ActionInput`, a caller is guaranteed; if it takes
 * `PublicActionInput`, anonymous access is a case it must have thought about.
 */
export type PublicActionInput<Body = undefined> = Omit<ActionInput<Body>, "claims"> & {
  readonly claims: Claims | null;
};

/**
 * Build an ActionInput from the pieces a route has in hand.
 *
 * A helper rather than an object literal at 106 call sites, so that adding a
 * field to ActionInput is one edit here instead of a sweep.
 */
export const actionInput = <Body = undefined, C extends Claims | null = Claims>(
  claims: C,
  params: Readonly<Record<string, string>>,
  body: Body,
  options: {
    readonly query?: Readonly<Record<string, string | undefined>>;
    readonly orgSlug?: string | null;
    readonly token?: string;
    /** Required — see the field docs on ActionInput. Route shells pass `grantsOf(c)`. */
    readonly grants: readonly Grant[] | null;
  },
): Omit<ActionInput<Body>, "claims"> & { readonly claims: C } => ({
  claims,
  token: options.token ?? "",
  grants: options.grants ?? null,
  orgSlug: options.orgSlug ?? null,
  params,
  query: options.query ?? {},
  body,
});
