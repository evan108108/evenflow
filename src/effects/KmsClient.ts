// KmsClient — Effect service for deriving a user's Nostr pubkey from their
// OAuth identity via AWS KMS HMAC (master key never leaves the HSM).
//
// The Live layer is a deliberate stub for now: the Tag + interface are the
// contract handlers code against; the real KMS wiring lands in a later
// phase.

import { Context, Data, Effect, Layer } from "effect";

export class KmsError extends Data.TaggedError("KmsError")<{
  readonly reason: string;
}> {}

export interface KmsClientService {
  readonly derivePubkey: (
    provider: string,
    oauthId: string,
  ) => Effect.Effect<string, KmsError>;
}

export class KmsClient extends Context.Tag("evenflow/KmsClient")<
  KmsClient,
  KmsClientService
>() {}

export const KmsClientLive: Layer.Layer<KmsClient> = Layer.succeed(KmsClient, {
  derivePubkey: () => Effect.fail(new KmsError({ reason: "not-yet-wired" })),
});

/** Deterministic fake pubkeys for tests. */
export const KmsClientTest: Layer.Layer<KmsClient> = Layer.succeed(KmsClient, {
  derivePubkey: (provider, oauthId) =>
    Effect.succeed(`test-pubkey-${provider}-${oauthId}`),
});
