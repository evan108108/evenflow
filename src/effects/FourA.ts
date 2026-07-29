// FourA — Effect service for the 4a gateway's profile surface.
//
// Three calls, all thin HTTP against api.4a4.ai:
//   whoami(token)                — the caller's KMS-derived hex pubkey.
//   publishProfile(token, f)     — publish a standard kind 0 for the caller
//                                  (the gateway signs with the KMS-derived
//                                  key; Evenflow never holds key material).
//   fetchProfile(author)         — latest kind 0 for an author; `author`
//                                  accepts hex64 or the composite
//                                  `provider:oauth_id` Evenflow uses as its
//                                  pubkey stand-in. A user with no kind 0
//                                  still succeeds — empty fields, null
//                                  event_id — because bulk chip resolution
//                                  treats "no profile yet" as data, not
//                                  as an error.
//
// This service replaces the old KmsClient stub: derivation happens on the
// gateway (one call site, shared with event signing), and Evenflow only
// ever sees the resulting hex pubkey.

import { Context, Data, Effect, Layer } from "effect";

const FOURA_API_BASE = "https://api.4a4.ai";

export class FourAError extends Data.TaggedError("FourAError")<{
  readonly reason: "network" | "http" | "bad-response";
  readonly status?: number;
  readonly detail?: string;
}> {}

/** The four user-chosen kind-0 fields. Everything else never leaves Evenflow. */
export interface ProfileFields {
  readonly name?: string;
  readonly display_name?: string;
  readonly picture?: string;
  readonly about?: string;
}

export interface RemoteProfile {
  /** Hex pubkey the author resolves to on the substrate. */
  readonly pubkey: string;
  /** Latest kind-0 event id; null = the author has never published one. */
  readonly event_id: string | null;
  readonly fields: ProfileFields;
  /** kind-0 created_at in ms; null when event_id is null. */
  readonly updated_at_ms: number | null;
}

export interface FourAService {
  readonly whoami: (token: string) => Effect.Effect<{ pubkey: string }, FourAError>;
  readonly publishProfile: (
    token: string,
    fields: ProfileFields,
  ) => Effect.Effect<{ event_id: string; pubkey: string }, FourAError>;
  readonly fetchProfile: (author: string) => Effect.Effect<RemoteProfile, FourAError>;
}

export class FourA extends Context.Tag("evenflow/FourA")<FourA, FourAService>() {}

const request = (path: string, init: RequestInit) =>
  Effect.tryPromise({
    try: () => fetch(`${FOURA_API_BASE}${path}`, init),
    catch: (cause) => new FourAError({ reason: "network", detail: String(cause) }),
  }).pipe(
    Effect.flatMap((res) =>
      Effect.tryPromise({
        try: async () => ({ status: res.status, body: (await res.json()) as Record<string, unknown> }),
        catch: () => new FourAError({ reason: "bad-response", status: res.status }),
      }),
    ),
    Effect.filterOrFail(
      ({ status }) => status >= 200 && status < 300,
      ({ status, body }) =>
        new FourAError({
          reason: "http",
          status,
          ...(typeof body["message"] === "string" ? { detail: body["message"] } : {}),
        }),
    ),
  );

/** Parse a kind-0 content JSON string into the four known fields. */
const parseProfileContent = (content: unknown): ProfileFields => {
  if (typeof content !== "string" || content === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const source = parsed as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const key of ["name", "display_name", "picture", "about"] as const) {
    if (typeof source[key] === "string") fields[key] = source[key];
  }
  return fields;
};

const makeLive = (): FourAService => ({
  whoami: (token) =>
    request("/v0/whoami", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }).pipe(
      Effect.flatMap(({ body }) =>
        typeof body["pubkey"] === "string" && body["pubkey"] !== ""
          ? Effect.succeed({ pubkey: body["pubkey"] })
          : Effect.fail(new FourAError({ reason: "bad-response", detail: "missing pubkey" })),
      ),
    ),

  publishProfile: (token, fields) =>
    request("/v0/publish/profile", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    }).pipe(
      Effect.flatMap(({ body }) =>
        typeof body["eventId"] === "string" && typeof body["pubkey"] === "string"
          ? Effect.succeed({ event_id: body["eventId"], pubkey: body["pubkey"] })
          : Effect.fail(new FourAError({ reason: "bad-response", detail: "missing eventId/pubkey" })),
      ),
    ),

  fetchProfile: (author) =>
    request(`/v0/profile?author=${encodeURIComponent(author)}`, { method: "GET" }).pipe(
      Effect.flatMap(({ body }) => {
        if (typeof body["pubkey"] !== "string") {
          return Effect.fail(new FourAError({ reason: "bad-response", detail: "missing pubkey" }));
        }
        const eventId = typeof body["event_id"] === "string" ? body["event_id"] : null;
        const createdAt = typeof body["created_at"] === "number" ? body["created_at"] : null;
        return Effect.succeed<RemoteProfile>({
          pubkey: body["pubkey"],
          event_id: eventId,
          fields: parseProfileContent(body["content"]),
          updated_at_ms: eventId === null || createdAt === null ? null : createdAt * 1000,
        });
      }),
    ),
});

export const FourALive: Layer.Layer<FourA> = Layer.succeed(FourA, makeLive());

// ─── test double ────────────────────────────────────────────────────────────

export interface FourATestHandle {
  readonly layer: Layer.Layer<FourA>;
  /** Every call in order, for asserting cache behavior ("hit avoids 4a"). */
  readonly calls: Array<{ method: keyof FourAService; arg: string }>;
  /** Mutable canned profiles keyed by author; absent key = no kind 0. */
  readonly profiles: Map<string, { event_id: string; fields: ProfileFields; updated_at_ms: number }>;
  /** When set, fetchProfile fails with this error (stale-fallback tests). */
  failFetches: boolean;
  /** When set, whoami fails (pubkey-null / sentinel-row tests). */
  failWhoami: boolean;
}

export const makeFourATest = (): FourATestHandle => {
  const calls: FourATestHandle["calls"] = [];
  const profiles: FourATestHandle["profiles"] = new Map();
  const handle: FourATestHandle = {
    calls,
    profiles,
    failFetches: false,
    failWhoami: false,
    layer: Layer.succeed(FourA, {
      whoami: (token) => {
        calls.push({ method: "whoami", arg: token });
        if (handle.failWhoami) {
          return Effect.fail(new FourAError({ reason: "network", detail: "test-outage" }));
        }
        return Effect.succeed({ pubkey: `hex-${token.slice(0, 8)}` });
      },
      publishProfile: (token, fields) => {
        calls.push({ method: "publishProfile", arg: JSON.stringify(fields) });
        return Effect.succeed({ event_id: `evt-${calls.length}`, pubkey: `hex-${token.slice(0, 8)}` });
      },
      fetchProfile: (author) => {
        calls.push({ method: "fetchProfile", arg: author });
        if (handle.failFetches) {
          return Effect.fail(new FourAError({ reason: "network", detail: "test-outage" }));
        }
        const canned = profiles.get(author);
        return Effect.succeed<RemoteProfile>(
          canned === undefined
            ? { pubkey: `hex-of-${author}`, event_id: null, fields: {}, updated_at_ms: null }
            : { pubkey: `hex-of-${author}`, event_id: canned.event_id, fields: canned.fields, updated_at_ms: canned.updated_at_ms },
        );
      },
    }),
  };
  return handle;
};
