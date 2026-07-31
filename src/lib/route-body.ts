// EFB-54 — the one door a request body comes through.
//
// See docs/BOUNDARY_DISCIPLINE.md for the why. The short version: handlers used
// to receive `Record<string, unknown>` from `readJsonBody` and hand-check
// whatever the author remembered, so whatever the author forgot returned 200
// with a plausible-looking result. Eight bugs in one day had that shape.
//
// Everything here is PURE. No Db, no Audience, no request-scoped services —
// `parseRouteBody` returns `Effect<A, ValidationError, never>` and schemas are
// hoistable to module scope. Checks that need a database read or a scope id the
// route hasn't resolved yet (roster membership, ownership) are authorization
// and belong in the handler as a named step. That boundary is the reason these
// schemas unit-test without a database.

import { Effect, ParseResult, Schema } from "effect";
import type { Context } from "hono";
import { callerPubkey } from "../authz";
import type { Claims } from "../effects";
import type { AppHonoEnv } from "../http";
import { ValidationError } from "../routes/errors";
import { canonicalizeIdentityRef } from "./identity";

/**
 * Parse options shared by every route.
 *
 * `onExcessProperty: "error"` is the entire point of EFB-53 — Effect Schema's
 * default is to STRIP unknown keys, which is the silent-drop behavior we are
 * here to delete. `errors: "all"` collects every problem instead of stopping at
 * the first, so a caller with three bad fields learns about three, not one per
 * round trip.
 */
const PARSE_OPTIONS = { onExcessProperty: "error", errors: "all" } as const;

/**
 * The `reason` string a failed parse becomes.
 *
 * Callers already branch on `reason` (EFB-38's tests assert `assignee_pubkey`
 * and `not-a-member`), so the field name has to survive into it rather than
 * being flattened into a prose blob. ArrayFormatter gives one entry per
 * problem with a structured path; the path IS the field name.
 *
 * Unknown keys are reported by Effect at the path of the offending key, which
 * is what lets the message name `titl` rather than saying "somewhere in body".
 */
/**
 * A message that is a bare kebab slug is a deliberate reason CODE, not prose.
 * That is how a schema hands a specific string to the caller — `immutable`
 * becomes `sprint_id-immutable`, `empty-patch` passes through whole — while
 * Effect's own prose messages ("Expected string, actual 3") fall back to the
 * field name.
 */
const REASON_CODE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const reasonFor = (error: ParseResult.ParseError): string => {
  const issues = ParseResult.ArrayFormatter.formatErrorSync(error);
  if (issues.length === 0) return "invalid-body";
  // One reason per FIELD, not per issue. A single bad field can raise several
  // issues — a refinement failure arrives alongside the underlying type issue —
  // and reporting `sprint_id-immutable,sprint_id` tells the caller nothing the
  // first half didn't. Where a field has both a coded message and a generic
  // one, the coded message wins: it is the specific thing we chose to say.
  // Grouped by the ROOT field, so a bad element inside `labels` reports as
  // `labels` rather than `labels.1,labels`. The index is more precise but the
  // root is what the caller has to fix, and it is the string this route
  // already answered before the migration — changing an error string is a
  // decision that deserves its own ticket, not a side effect of this one.
  const byField = new Map<string, string>();
  for (const i of issues) {
    const field = i.path.length > 0 ? String(i.path[0]) : "";
    const coded =
      i._tag === "Unexpected"
        ? `${field || "body"}-unknown`
        : REASON_CODE.test(i.message)
          ? field === ""
            ? i.message
            : `${field}-${i.message}`
          : null;
    const existing = byField.get(field);
    if (coded !== null) byField.set(field, coded);
    else if (existing === undefined) byField.set(field, field || "body");
  }
  return [...byField.values()].join(",");
};

/**
 * Decode an already-materialized value against a schema.
 *
 * Split out from `parseRouteBody` so schemas can be tested — and reused for
 * query/path params later — without constructing a Hono Context.
 */
export const decodeBody = <A, I>(
  schema: Schema.Schema<A, I, never>,
  input: unknown,
): Effect.Effect<A, ValidationError, never> =>
  Schema.decodeUnknown(schema)(input, PARSE_OPTIONS).pipe(
    Effect.mapError((e) => new ValidationError({ reason: reasonFor(e) })),
  );

/**
 * Read this request's JSON body and decode it against `schema`.
 *
 * Guarantees, by construction rather than by handler diligence:
 *   1. unknown keys → 400 naming the key
 *   2. wrong types  → 400 naming the field
 *   3. missing required → 400 naming the field
 *   4. the value handed back is CANONICAL — downstream never re-normalizes
 */
export const parseRouteBody = <A, I>(
  c: Context<AppHonoEnv>,
  schema: Schema.Schema<A, I, never>,
): Effect.Effect<A, ValidationError, never> =>
  Effect.tryPromise({
    try: () => c.req.json() as Promise<unknown>,
    catch: () => new ValidationError({ reason: "expected-json" }),
  }).pipe(
    Effect.filterOrFail(
      (b): b is Record<string, unknown> =>
        typeof b === "object" && b !== null && !Array.isArray(b),
      () => new ValidationError({ reason: "expected-json-object" }),
    ),
    Effect.flatMap((body) => decodeBody(schema, body)),
  );

// ── composable primitives ─────────────────────────────────────────────────

/**
 * An identity reference in a request body.
 *
 * Accepts every spelling a client might legitimately send — bare hex,
 * `nostr:<hex>`, `npub1…` — and yields the ONE canonical `<provider>:<id>`
 * form. That normalization is invariant 4: the handler that receives this
 * never calls `canonicalizeIdentityRef` again, and a value that reached the
 * database through this schema cannot be a second spelling of an identity
 * already stored (EFB-38, EFB-42, EFB-51).
 *
 * Shape only. Whether the referenced person is on a given roster is a database
 * question — `isRosterMember` in the handler, after the board is resolved.
 */
export const IdentityRefFromInput = Schema.transformOrFail(
  Schema.String,
  Schema.String,
  {
    strict: true,
    decode: (input, _options, ast) => {
      const ref = canonicalizeIdentityRef(input);
      return ref === null
        ? ParseResult.fail(
            new ParseResult.Type(ast, input, "not a canonical identity reference"),
          )
        : ParseResult.succeed(ref);
    },
    encode: (value) => ParseResult.succeed(value),
  },
).annotations({ identifier: "IdentityRef" });

/**
 * Where an actor on a signed substrate event came from.
 *
 * EFB-33 shipped an attribution bug by passing a bare pubkey string into a
 * signed-event builder: `assignee_pubkey` was substituted for `actor_pubkey`
 * and the event went out on a public relay attributing a change to the wrong
 * person. Both are strings, so nothing complained.
 *
 * Builders take this struct instead. `source` makes the substitution visible at
 * the call site — `route.caller` and `user.explicit` are different claims about
 * the world, and a reviewer can see which one a builder was handed.
 */
export const ProvenanceSource = Schema.Literal(
  "route.caller",
  "user.explicit",
  "audit.system",
);
export type ProvenanceSource = Schema.Schema.Type<typeof ProvenanceSource>;

export const Provenance = Schema.Struct({
  source: ProvenanceSource,
  pubkey: IdentityRefFromInput,
}).annotations({ identifier: "Provenance" });
export type Provenance = Schema.Schema.Type<typeof Provenance>;

/**
 * This request's JWT-authenticated caller is the actor.
 *
 * Takes `Claims` rather than a pubkey string on purpose: the only way to
 * construct a `route.caller` provenance is to hold the claims, so there is no
 * spelling of this call that quietly accepts some OTHER person's pubkey. That
 * is the property EFB-33 needed and `string` could not provide.
 *
 * Derivation goes through `callerPubkey` rather than re-forming
 * `provider:oauth_id` here — one definition of what a caller's pubkey IS, so
 * the KMS backfill that replaces it has one place to change.
 *
 * Lane B seam — currently unused in src/; kept because dropping/re-adding
 * across Lane B is noise, and the Claims-not-string invariant preserved here is
 * the load-bearing safety.
 */
export const ProvenanceFromCaller = (claims: Claims): Provenance => ({
  source: "route.caller",
  pubkey: callerPubkey(claims),
});

/**
 * No human actor — the server generated this event.
 *
 * Tombstones and backfills have no one to attribute, and the honest wire value
 * for "nobody" is the empty pubkey these builders already emitted when the
 * envelope carried no actor. Taking no argument is the point: a system event
 * that could be handed a pubkey would eventually be handed the wrong one.
 */
export const ProvenanceFromSystem = (): Provenance => ({
  source: "audit.system",
  pubkey: "",
});

/**
 * The server is re-emitting an identity it read off a stored row.
 *
 * Also `audit.system` — no live human is calling — but carrying the stored
 * pubkey rather than the empty one, because the fact being re-attested is
 * someone else's. A backfill republishing a year-old comment must still name
 * its original author.
 *
 * This is the honest constructor for a publisher: it takes a bare string, which
 * looks like the very thing EFB-58 set out to delete, and the distinction is
 * that the STRING is not the safety here — the NAME is. A caller writing
 * `ProvenanceFromStoredActor(issue.assignee_pubkey)` has written something that
 * reads false on the page, where `actorPubkey: issue.assignee_pubkey` read fine.
 * Use it only where the value genuinely comes from a stored row; where claims
 * are in scope, `ProvenanceFromCaller` is strictly stronger and takes no string
 * at all.
 */
export const ProvenanceFromStoredActor = (pubkey: string): Provenance => ({
  source: "audit.system",
  pubkey,
});

/** A v4 UUID as this codebase mints them (`crypto.randomUUID`). */
export const Uuid = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
).annotations({ identifier: "Uuid" });

/** A human issue reference, e.g. `EFB-54`. */
export const ShortId = Schema.String.pipe(
  Schema.pattern(/^[A-Z][A-Z0-9]*-\d+$/),
).annotations({ identifier: "ShortId" });

/** A non-empty, trimmed-meaningful string — the common case for titles. */
export const NonEmptyString = Schema.String.pipe(Schema.minLength(1));

/**
 * A field that exists in the model but may not be written through THIS route.
 *
 * Declared rather than left to the unknown-key rule on purpose. Both reject,
 * but they say different things: `sprint_id-immutable` tells a caller the field
 * is real and they are using the wrong endpoint, while `sprint_id-unknown`
 * would tell them it does not exist. The first is true and actionable; the
 * second sends them looking for a typo. Existing tests pin the distinction.
 */
export const ImmutableField = Schema.optional(
  Schema.Unknown.pipe(Schema.filter(() => "immutable")),
);

/**
 * Require at least one meaningful key, so an empty `{}` is a 400 rather than a
 * no-op 200. Reported as `empty-patch` at the struct level.
 */
export const requireAnyOf =
  <A extends Record<string, unknown>>(keys: ReadonlyArray<string>) =>
  (value: A): string | undefined =>
    keys.some((k) => value[k] !== undefined) ? undefined : "empty-patch";
