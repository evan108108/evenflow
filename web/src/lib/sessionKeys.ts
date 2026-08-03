// Per-session client keypair (phase 16.5).
//
// Web users have no long-lived secp256k1 keys, so each signed-in session
// mints one: the pub registers with the Worker (POST /session/register-key)
// and becomes the recipient of the session's private-board key grants.
//
// Storage discipline (locked): the private scalar lives in MEMORY first
// and sessionStorage at most — NEVER localStorage. Losing the session
// loses the key; the client self-heals via request-regrant on next login.

import { Effect } from "effect";
import { url } from "@routes-manifest";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { generateEpochKeypair, pubkeyFromPriv } from "./audience/audience-keys";
import { ApiClient, appRuntime } from "../effects";

const SESSION_KEY_STORAGE = "evenflow.session-key";
const HEX_32_BYTES = /^[0-9a-f]{64}$/i;

let cached: { priv: Uint8Array; pub: string } | null = null;

const store = (): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null; // privacy mode / jsdom — memory-only, still works for the tab's life
  }
};

/** The session keypair, minting + persisting one on first use. */
export const ensureSessionKeypair = (): { priv: Uint8Array; pub: string } => {
  if (cached !== null) return cached;
  const persisted = store()?.getItem(SESSION_KEY_STORAGE) ?? null;
  if (persisted !== null && HEX_32_BYTES.test(persisted)) {
    const priv = hexToBytes(persisted);
    cached = { priv, pub: pubkeyFromPriv(priv) };
    return cached;
  }
  const kp = generateEpochKeypair();
  cached = { priv: kp.priv, pub: kp.pub };
  store()?.setItem(SESSION_KEY_STORAGE, bytesToHex(kp.priv));
  return cached;
};

/** Forget the keypair (sign-out). */
export const clearSessionKeypair = (): void => {
  cached?.priv.fill(0);
  cached = null;
  store()?.removeItem(SESSION_KEY_STORAGE);
};

/**
 * Register this session's pub with the Worker. Fire-and-forget from the
 * bootstrap path: failures resolve false and the next board load's
 * request-regrant retries the whole chain.
 */
export const registerSessionKey = async (): Promise<boolean> => {
  try {
    const { pub } = ensureSessionKeypair();
    await appRuntime.runPromise(
      Effect.gen(function* () {
        const client = yield* ApiClient;
        return yield* client.post(url("session.key.register"), { session_pubkey: pub });
      }),
    );
    return true;
  } catch {
    return false;
  }
};

/** Test seam: drop the in-memory cache without touching storage. */
export const __resetSessionKeys = (): void => {
  cached = null;
};
