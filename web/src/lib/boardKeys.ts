// Private-board epoch keys, client side (phase 16.5).
//
// On a private board the client fetches its key grant (the epoch's raw
// 32-byte scalar, NIP-44-encrypted from the board's aud_id to this
// session's pub), decrypts it with the session privkey, and caches the
// epoch key IN MEMORY keyed by (board, epoch) — never persisted. SSE
// payloads arrive as { enc, epoch, ciphertext }; a mismatched epoch
// (rotation happened) refetches the grant once via request-regrant.

import { Effect } from "effect";
import { decrypt, decryptString } from "./audience/nip44";
import { ensureSessionKeypair } from "./sessionKeys";
import { ApiClient, appRuntime } from "../effects";

export interface EncryptedPayload {
  readonly enc: true;
  readonly epoch: number;
  readonly ciphertext: string | null;
}

export const isEncryptedPayload = (payload: unknown): payload is EncryptedPayload =>
  typeof payload === "object" &&
  payload !== null &&
  (payload as { enc?: unknown }).enc === true &&
  typeof (payload as { epoch?: unknown }).epoch === "number";

interface GrantWire {
  readonly grant: {
    readonly epoch: number;
    readonly grant_ciphertext: string;
    readonly grant_sender_pubkey: string;
    readonly audience_pubkey: string;
  };
}

interface EpochKey {
  readonly priv: Uint8Array;
  readonly audiencePub: string;
}

/** In-memory only: `${boardKey}:${epoch}` → epoch key material. */
const epochKeys = new Map<string, EpochKey>();

const api = <A>(f: (client: import("../effects").ApiClientService) => Effect.Effect<A, unknown>) =>
  appRuntime.runPromise(Effect.flatMap(ApiClient, f)) as Promise<A>;

/** Fetch (or self-serve re-issue) the caller's grant and unwrap it. */
const fetchEpochKey = async (apiBase: string, boardKey: string): Promise<EpochKey | null> => {
  const { priv: sessionPriv } = ensureSessionKeypair();
  let wire: GrantWire;
  try {
    wire = await api((c) => c.get<GrantWire>(`${apiBase}/key-grant`));
  } catch {
    try {
      wire = await api((c) => c.post<GrantWire>(`${apiBase}/request-regrant`, {}));
    } catch {
      return null;
    }
  }
  try {
    const scalar = decrypt(wire.grant.grant_ciphertext, sessionPriv, wire.grant.grant_sender_pubkey);
    const key: EpochKey = { priv: scalar, audiencePub: wire.grant.audience_pubkey };
    epochKeys.set(`${boardKey}:${wire.grant.epoch}`, key);
    return key;
  } catch {
    return null;
  }
};

/**
 * Decrypt one encrypted SSE payload. Returns the parsed plaintext object,
 * or null when it cannot be read (no grant — e.g. we were rotated out —
 * or a degraded ciphertext-less envelope).
 */
export const decryptBoardPayload = async (
  apiBase: string,
  boardKey: string,
  payload: EncryptedPayload,
): Promise<unknown | null> => {
  if (payload.ciphertext === null) return null;
  let key = epochKeys.get(`${boardKey}:${payload.epoch}`) ?? null;
  if (key === null) {
    // Unknown epoch: first load, or a rotation bumped past our cache.
    key = await fetchEpochKey(apiBase, boardKey);
  }
  if (key === null) return null;
  try {
    return JSON.parse(decryptString(payload.ciphertext, key.priv, key.audiencePub)) as unknown;
  } catch {
    return null;
  }
};

/** Test seam / sign-out hygiene. */
export const __resetBoardKeys = (): void => {
  for (const key of epochKeys.values()) key.priv.fill(0);
  epochKeys.clear();
};
