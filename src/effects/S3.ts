// S3 — Effect service for BYO S3-compatible buckets (phase 18b).
//
// Wraps the pure SigV4 signing in src/lib/s3-sign.ts with fetch, exposing
// exactly the three operations the app needs: putObject for uploads,
// headObject + deleteObject for the connection test's probe cycle.
//
// Credentials arrive per-call, already NIP-44-unwrapped by the route (see
// src/lib/nostr-keys.ts) — this service never reads env and holds no key
// material between calls.

import { Context, Data, Effect, Layer } from "effect";
import {
  buildS3Url,
  parseS3Error,
  signDeleteObject,
  signHeadObject,
  signPutObject,
} from "../lib/s3-sign";

export class S3Error extends Data.TaggedError("S3Error")<{
  readonly reason: "network" | "http";
  readonly status?: number;
  readonly code?: string;
  readonly detail?: string;
}> {}

export interface S3Target {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly pathStyle: boolean;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface S3Service {
  /** PUT bytes at `key`; returns the object's canonical URL. */
  readonly putObject: (
    target: S3Target,
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ) => Effect.Effect<{ url: string }, S3Error>;
  readonly headObject: (target: S3Target, key: string) => Effect.Effect<void, S3Error>;
  readonly deleteObject: (target: S3Target, key: string) => Effect.Effect<void, S3Error>;
}

export class S3 extends Context.Tag("evenflow/S3")<S3, S3Service>() {}

const run = async (url: string, init: RequestInit): Promise<Response> => {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new S3Error({ reason: "network", detail: String(e) });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const parsed = parseS3Error(res.status, body);
    throw new S3Error({
      reason: "http",
      status: res.status,
      code: parsed.code,
      detail: parsed.message,
    });
  }
  return res;
};

const asS3Error = (e: unknown): S3Error =>
  e instanceof S3Error ? e : new S3Error({ reason: "network", detail: String(e) });

const signArgs = (target: S3Target, key: string) => ({
  endpoint: target.endpoint,
  region: target.region,
  bucket: target.bucket,
  key,
  pathStyle: target.pathStyle,
  accessKeyId: target.accessKeyId,
  secretAccessKey: target.secretAccessKey,
});

export const S3Live: Layer.Layer<S3> = Layer.succeed(S3, {
  putObject: (target, key, bytes, contentType) =>
    Effect.tryPromise({
      try: async () => {
        const signed = signPutObject({ ...signArgs(target, key), body: bytes, contentType });
        await run(signed.url, {
          method: "PUT",
          headers: signed.headers,
          body: bytes as unknown as BodyInit,
        });
        return { url: signed.url };
      },
      catch: asS3Error,
    }),
  headObject: (target, key) =>
    Effect.tryPromise({
      try: async () => {
        const signed = signHeadObject(signArgs(target, key));
        await run(signed.url, { method: "HEAD", headers: signed.headers });
      },
      catch: asS3Error,
    }),
  deleteObject: (target, key) =>
    Effect.tryPromise({
      try: async () => {
        const signed = signDeleteObject(signArgs(target, key));
        await run(signed.url, { method: "DELETE", headers: signed.headers });
      },
      catch: asS3Error,
    }),
});

// ─── test double ────────────────────────────────────────────────────────────

export interface S3TestHandle {
  readonly layer: Layer.Layer<S3>;
  /** Every call in order: `${op}:${bucket}/${key}`. */
  readonly calls: string[];
  /** When set, every op fails with an http error (bad-creds tests). */
  failOps: boolean;
}

export const makeS3Test = (): S3TestHandle => {
  const calls: string[] = [];
  const op = (name: string, target: S3Target, key: string): Effect.Effect<void, S3Error> => {
    calls.push(`${name}:${target.bucket}/${key}`);
    if (handle.failOps) {
      return Effect.fail(
        new S3Error({ reason: "http", status: 403, code: "SignatureDoesNotMatch", detail: "test-denied" }),
      );
    }
    return Effect.void;
  };
  const handle: S3TestHandle = {
    calls,
    failOps: false,
    layer: Layer.succeed(S3, {
      putObject: (target, key, bytes, contentType) =>
        Effect.flatMap(op(`put(${contentType}:${bytes.byteLength})`, target, key), () =>
          Effect.succeed({
            url: buildS3Url({
              endpoint: target.endpoint,
              bucket: target.bucket,
              key,
              pathStyle: target.pathStyle,
            }).url,
          }),
        ),
      headObject: (target, key) => op("head", target, key),
      deleteObject: (target, key) => op("delete", target, key),
    }),
  };
  return handle;
};
