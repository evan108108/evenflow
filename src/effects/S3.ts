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
  signGetObject,
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
  /**
   * GET bytes at `key`. Returns the raw payload alongside the server-reported
   * content-type when present, so an attachment-download handler can pass
   * through the type the upload wrote rather than second-guess it.
   */
  readonly getObject: (
    target: S3Target,
    key: string,
  ) => Effect.Effect<{ bytes: Uint8Array; contentType: string | null }, S3Error>;
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
  getObject: (target, key) =>
    Effect.tryPromise({
      try: async () => {
        const signed = signGetObject(signArgs(target, key));
        const res = await run(signed.url, { method: "GET", headers: signed.headers });
        const buf = await res.arrayBuffer();
        return {
          bytes: new Uint8Array(buf),
          contentType: res.headers.get("content-type"),
        };
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
  /**
   * In-memory blob store for the `getObject` path. `${bucket}/${key}` →
   * `{bytes, contentType}`; a get on a missing key answers 404 to mirror
   * a live bucket. Tests seed this by calling `putObject` (which records)
   * or by writing directly on the returned handle.
   */
  readonly objects: Map<string, { bytes: Uint8Array; contentType: string }>;
}

export const makeS3Test = (): S3TestHandle => {
  const calls: string[] = [];
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
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
    objects,
    failOps: false,
    layer: Layer.succeed(S3, {
      putObject: (target, key, bytes, contentType) =>
        Effect.flatMap(op(`put(${contentType}:${bytes.byteLength})`, target, key), () => {
          objects.set(`${target.bucket}/${key}`, { bytes, contentType });
          return Effect.succeed({
            url: buildS3Url({
              endpoint: target.endpoint,
              bucket: target.bucket,
              key,
              pathStyle: target.pathStyle,
            }).url,
          });
        }),
      getObject: (target, key) =>
        Effect.flatMap(op("get", target, key), () => {
          const row = objects.get(`${target.bucket}/${key}`);
          if (row === undefined) {
            return Effect.fail(
              new S3Error({ reason: "http", status: 404, code: "NoSuchKey", detail: "test-missing" }),
            );
          }
          return Effect.succeed({ bytes: row.bytes, contentType: row.contentType });
        }),
      headObject: (target, key) => op("head", target, key),
      deleteObject: (target, key) => op("delete", target, key),
    }),
  };
  return handle;
};
