// Shared route-level failure vocabulary for the phase-16 routers (orgs,
// invites, session). Pre-16 routers carry local copies of the same tags —
// the switch below matches on _tag, so either class works.

import type { Context } from "hono";
import { Cause, Data, Effect, Option } from "effect";
import type { AppHonoEnv } from "../http";

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly reason: string;
}> {}
/**
 * EFB-71 — a request's QUERY STRING was malformed, as opposed to its body.
 *
 * Separate from `ValidationError` for one reason: the envelope. Every 400 in
 * this app answered `{"error":"invalid-body"}`, which on a GET that carries no
 * body at all is a small lie of exactly the kind this ticket exists to delete —
 * a caller who sent a bad query param was told to go look at a body they never
 * wrote. The `reason` grammar is unchanged (`<key>-unknown`, `<key>`), because
 * callers already parse it; only the envelope tells the truth now.
 */
export class QueryValidationError extends Data.TaggedError("QueryValidationError")<{
  readonly reason: string;
}> {}
export class ConflictError extends Data.TaggedError("ConflictError")<{
  readonly reason: string;
}> {}
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly reason: string;
}> {}
export class RateLimitError extends Data.TaggedError("RateLimitError")<{
  readonly reason: string;
}> {}

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
