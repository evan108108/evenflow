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
  /** The org this request is scoped to, or null on the bare mount. */
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
  } = {},
): Omit<ActionInput<Body>, "claims"> & { readonly claims: C } => ({
  claims,
  token: options.token ?? "",
  orgSlug: options.orgSlug ?? null,
  params,
  query: options.query ?? {},
  body,
});
