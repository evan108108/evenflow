// Shared route-level failure vocabulary for the phase-16 routers (orgs,
// invites, session). Pre-16 routers carry local copies of the same tags —
// the switch below matches on _tag, so either class works.

import type { Context } from "hono";
import { Cause, Effect, Option } from "effect";
import type { AppHonoEnv } from "../http";
import { ValidationError } from "../lib/errors";

// The failure vocabulary lives in src/lib/errors.ts now, so an action can
// raise it without importing from the route layer. Re-exported here because
// every existing route imports these from this module; the routes repoint at
// the library directly during integration, once the per-family migrations have
// landed and that edit stops colliding with five in-flight branches.
export {
  ValidationError,
  QueryValidationError,
  ConflictError,
  NotFoundError,
  RateLimitError,
} from "../lib/errors";

interface TaggedFailure {
  readonly _tag: string;
  readonly reason?: unknown;
}

/**
 * Map any route failure to its HTTP shape by tag. Unknown tags — and
 * defects — answer 500. New routers use this instead of per-file switches.
 */
export const errorResponse = (
  c: Context<AppHonoEnv>,
  cause: Cause.Cause<unknown>,
) => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const f = failure.value as TaggedFailure;
    const reason = typeof f.reason === "string" ? f.reason : "unknown";
    switch (f._tag) {
      case "ValidationError":
        return c.json({ error: "invalid-body", reason }, 400);
      case "QueryValidationError":
        return c.json({ error: "invalid-query", reason }, 400);
      case "UnauthorizedError":
        return c.json({ error: "unauthorized", reason }, 401);
      case "ForbiddenError":
        return c.json({ error: "forbidden", reason }, 403);
      case "NotFoundError":
      case "BoardOwnershipError":
        return c.json({ error: "not-found", reason }, 404);
      case "ConflictError":
        return c.json({ error: "conflict", reason }, 409);
      case "RateLimitError":
        return c.json({ error: "rate-limited", reason }, 429);
      case "DbError":
        return c.json({ error: "internal", reason: `db-${reason}` }, 500);
      case "FourAError":
        return c.json({ error: "upstream", reason: "4a" }, 502);
      case "EmailError":
        return c.json({ error: "upstream", reason: `email-${reason}` }, 502);
    }
  }
  return c.json({ error: "internal", reason: "defect" }, 500);
};

export const readJsonBody = (c: Context<AppHonoEnv>) =>
  Effect.tryPromise({
    try: () => c.req.json() as Promise<Record<string, unknown>>,
    catch: () => new ValidationError({ reason: "expected-json" }),
  }).pipe(
    Effect.filterOrFail(
      (b): b is Record<string, unknown> => typeof b === "object" && b !== null && !Array.isArray(b),
      () => new ValidationError({ reason: "expected-json-object" }),
    ),
  );
