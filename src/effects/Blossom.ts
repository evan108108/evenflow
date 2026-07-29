// Blossom — Effect service for uploading blobs to the Evenflow-managed
// default Blossom host (BUD-01/BUD-02).
//
// Default host choice: **blossom.band** (EVENFLOW_DEFAULT_BLOSSOM_URL).
// Picked over blossom.nostr.build because it is BUD-01/02 compliant, free,
// public, and doesn't gate uploads behind an account tier; the env var
// keeps the host swappable without a deploy-time code change.
//
// Signing: uploads are authorized by a kind-24242 event signed with the
// EVENFLOW SERVICE key (EVENFLOW_BLOSSOM_SECRET, 32-byte hex Worker
// secret) — one service identity owns every default-storage blob, so users
// never need Blossom keys of their own. The user-facing KMS design keeps
// per-user key material in the 4a gateway, which is out of scope this
// phase; if 18b wants per-user ownership it swaps this signer for a
// gateway call.

import { Context, Data, Effect, Layer } from "effect";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/curves/utils.js";
import { AppEnv } from "./AppEnv";

const BLOSSOM_AUTH_KIND = 24242;
const AUTH_EXPIRY_SECONDS = 300;

export class BlossomError extends Data.TaggedError("BlossomError")<{
  readonly reason: "not-configured" | "network" | "http" | "bad-response";
  readonly status?: number;
  readonly detail?: string;
}> {}

export interface BlossomService {
  /** Upload bytes to the default host; returns the immutable sha256-addressed public URL. */
  readonly upload: (
    bytes: Uint8Array,
    contentType: string,
    filename: string,
  ) => Effect.Effect<{ url: string; sha256: string }, BlossomError>;
  /** Upload bytes to a specific Blossom host (BYO Blossom, phase 18b). */
  readonly uploadTo: (
    blossomUrl: string,
    bytes: Uint8Array,
    contentType: string,
    filename: string,
  ) => Effect.Effect<{ url: string; sha256: string }, BlossomError>;
}

export class Blossom extends Context.Tag("evenflow/Blossom")<Blossom, BlossomService>() {}

export const sha256Hex = (bytes: Uint8Array): Promise<string> =>
  crypto.subtle
    .digest("SHA-256", bytes as unknown as ArrayBuffer)
    .then((d) => bytesToHex(new Uint8Array(d)));

/** Build + sign the BUD-01 kind-24242 upload authorization event. */
const signUploadAuth = async (
  secretHex: string,
  blobSha256: string,
  filename: string,
): Promise<string> => {
  const secret = hexToBytes(secretHex);
  const pubkey = bytesToHex(schnorr.getPublicKey(secret));
  const created_at = Math.floor(Date.now() / 1000);
  const kind = BLOSSOM_AUTH_KIND;
  const tags = [
    ["t", "upload"],
    ["x", blobSha256],
    ["expiration", String(created_at + AUTH_EXPIRY_SECONDS)],
  ];
  const content = `Upload ${filename}`;
  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  const id = await sha256Hex(new TextEncoder().encode(serialized));
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secret));
  const event = { id, pubkey, created_at, kind, tags, content, sig };
  return btoa(JSON.stringify(event));
};

// NOTE: AppEnv must be dereferenced INSIDE the generator (same as every
// other Live layer) — AppEnv.ts ↔ service modules are circular, and an
// eager `Effect.map(AppEnv, …)` reads the binding mid-import, yielding
// undefined and killing bootstrap at runtime.
export const BlossomLive: Layer.Layer<Blossom, never, AppEnv> = Layer.effect(
  Blossom,
  Effect.gen(function* () {
    const env = yield* AppEnv;
    return makeLive(env);
  }),
);

const uploadToHost = async (
  base: string,
  secret: string,
  bytes: Uint8Array,
  contentType: string,
  filename: string,
): Promise<{ url: string; sha256: string }> => {
  const sha256 = await sha256Hex(bytes);
  const auth = await signUploadAuth(secret, sha256, filename);
  const res = await fetch(`${base.replace(/\/$/, "")}/upload`, {
    method: "PUT",
    headers: {
      Authorization: `Nostr ${auth}`,
      "Content-Type": contentType,
    },
    body: bytes as unknown as BodyInit,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 256);
    throw new BlossomError({ reason: "http", status: res.status, detail });
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  // BUD-02 blob descriptor; fall back to the sha256-addressed
  // convention if a host omits `url`.
  const url =
    body !== null && typeof body["url"] === "string" && body["url"] !== ""
      ? body["url"]
      : `${base.replace(/\/$/, "")}/${sha256}`;
  return { url, sha256 };
};

const asBlossomError = (e: unknown): BlossomError =>
  e instanceof BlossomError ? e : new BlossomError({ reason: "network", detail: String(e) });

const makeLive = (env: { EVENFLOW_DEFAULT_BLOSSOM_URL?: string; EVENFLOW_BLOSSOM_SECRET?: string }): BlossomService => {
  // Both the default host and BYO hosts sign BUD-01 auth with the Evenflow
  // service key — BYO Blossom is a public-URL override, not a key handoff.
  const requireSecret = (): string => {
    const secret = env.EVENFLOW_BLOSSOM_SECRET;
    if (secret === undefined || secret === "") throw new BlossomError({ reason: "not-configured" });
    return secret;
  };
  return {
    upload: (bytes, contentType, filename) =>
      Effect.tryPromise({
        try: () => {
          const base = env.EVENFLOW_DEFAULT_BLOSSOM_URL;
          if (base === undefined || base === "") throw new BlossomError({ reason: "not-configured" });
          return uploadToHost(base, requireSecret(), bytes, contentType, filename);
        },
        catch: asBlossomError,
      }),
    uploadTo: (blossomUrl, bytes, contentType, filename) =>
      Effect.tryPromise({
        try: () => uploadToHost(blossomUrl, requireSecret(), bytes, contentType, filename),
        catch: asBlossomError,
      }),
  };
};

// ─── test double ────────────────────────────────────────────────────────────

export interface BlossomTestHandle {
  readonly layer: Layer.Layer<Blossom>;
  /**
   * Every upload in order: `${contentType}:${filename}:${byteLength}` for
   * the default host, prefixed `${blossomUrl}|` for uploadTo targets.
   */
  readonly calls: string[];
  /** When set, uploads fail with an http error (host-down tests). */
  failUploads: boolean;
}

export const makeBlossomTest = (): BlossomTestHandle => {
  const calls: string[] = [];
  const record = (
    prefix: string,
    bytes: Uint8Array,
    contentType: string,
    filename: string,
    host: string,
  ) => {
    calls.push(`${prefix}${contentType}:${filename}:${bytes.byteLength}`);
    if (handle.failUploads) {
      return Effect.fail(new BlossomError({ reason: "http", status: 502, detail: "test-outage" }));
    }
    return Effect.succeed({
      url: `${host}/sha-${bytes.byteLength}`,
      sha256: `sha-${bytes.byteLength}`,
    });
  };
  const handle: BlossomTestHandle = {
    calls,
    failUploads: false,
    layer: Layer.succeed(Blossom, {
      upload: (bytes, contentType, filename) =>
        record("", bytes, contentType, filename, "https://blossom.test"),
      uploadTo: (blossomUrl, bytes, contentType, filename) =>
        record(`${blossomUrl}|`, bytes, contentType, filename, blossomUrl.replace(/\/$/, "")),
    }),
  };
  return handle;
};
