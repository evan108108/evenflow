// The API's shared failure VOCABULARY.
//
// EFB-98 split this out of src/routes/errors.ts. The tagged classes are domain
// facts — "this was invalid", "this was not found" — and an action raises them
// without knowing anything about HTTP. What stays in routes/errors.ts is the
// part that genuinely is transport: errorResponse, which turns a tag into a
// status code, and readJsonBody.
//
// The split also fixes a dependency that already pointed the wrong way before
// any of this: src/lib/route-body.ts imported these classes from src/routes/,
// so the library layer depended on the route layer to describe a validation
// failure.

import { Data } from "effect";

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
