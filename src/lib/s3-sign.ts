// S3 SigV4 request signing — pure functions. No SDK.
//
// Used by BYO-S3 attachment storage (phase 18b). Builds canonical request →
// string-to-sign → signature → Authorization header per
// https://docs.aws.amazon.com/general/latest/gr/sigv4-signed-request-examples.html.
//
// Adapted from Sonata Studio's storage/s3.ts (same field names + shapes for
// cross-app consistency); HMAC + sha256 come from @noble/hashes, which runs
// fine on Workers.
//
// Path-style is the default (R2 requires it; AWS allows it on most regions).
// Virtual-hosted-style is opt-in via `pathStyle: false`.

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const SERVICE = "s3";
const ALGO = "AWS4-HMAC-SHA256";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export interface S3SignArgs {
  endpoint: string;
  region: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Default true (R2). Set false for virtual-hosted-style URLs (AWS modern). */
  pathStyle?: boolean;
  /** Override the wall-clock time used for signing (ISO 8601 basic). Test hook. */
  nowIsoBasic?: string;
}

export interface S3PutArgs extends S3SignArgs {
  body: Uint8Array;
  contentType?: string;
  /** If true, hash the payload and sign with that hex; else use UNSIGNED-PAYLOAD. */
  signPayload?: boolean;
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function signPutObject(args: S3PutArgs): SignedRequest {
  const payloadHash = args.signPayload === true ? sha256Hex(args.body) : UNSIGNED_PAYLOAD;
  return sign({
    ...args,
    method: "PUT",
    payloadHash,
    extraHeaders: args.contentType ? { "content-type": args.contentType } : {},
  });
}

export function signHeadObject(args: S3SignArgs): SignedRequest {
  return sign({
    ...args,
    method: "HEAD",
    payloadHash: emptyBodySha256(),
    extraHeaders: {},
  });
}

// DELETE — used by the connection test to clean up the probe object.
export function signDeleteObject(args: S3SignArgs): SignedRequest {
  return sign({
    ...args,
    method: "DELETE",
    payloadHash: emptyBodySha256(),
    extraHeaders: {},
  });
}

// ── URL builders ────────────────────────────────────────────────────────────

/**
 * Build the request URL for `bucket/key` under `endpoint`. Path-style:
 *   https://<host>/<bucket>/<key>
 * Virtual-hosted-style:
 *   https://<bucket>.<host>/<key>
 *
 * `endpoint` may be passed with or without a scheme. If no scheme, defaults
 * to https.
 */
export function buildS3Url(args: {
  endpoint: string;
  bucket: string;
  key: string;
  pathStyle?: boolean | undefined;
}): { url: string; host: string; canonicalUri: string } {
  const { protocol, host } = parseEndpoint(args.endpoint);
  const encodedKey = encodeS3Key(args.key);
  if (args.pathStyle !== false) {
    return {
      url: `${protocol}//${host}/${encodeURIComponent(args.bucket)}/${encodedKey}`,
      host,
      canonicalUri: `/${encodeURIComponent(args.bucket)}/${encodedKey}`,
    };
  }
  return {
    url: `${protocol}//${args.bucket}.${host}/${encodedKey}`,
    host: `${args.bucket}.${host}`,
    canonicalUri: `/${encodedKey}`,
  };
}

// ── Core sign ───────────────────────────────────────────────────────────────

interface SignCore extends S3SignArgs {
  method: "GET" | "PUT" | "HEAD" | "DELETE";
  payloadHash: string;
  extraHeaders: Record<string, string>;
}

function sign(args: SignCore): SignedRequest {
  const { url, host, canonicalUri } = buildS3Url({
    endpoint: args.endpoint,
    bucket: args.bucket,
    key: args.key,
    pathStyle: args.pathStyle,
  });

  const isoBasic = args.nowIsoBasic ?? toIsoBasic(new Date());
  const dateStamp = isoBasic.slice(0, 8); // YYYYMMDD

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": args.payloadHash,
    "x-amz-date": isoBasic,
    ...args.extraHeaders,
  };

  // Canonical request
  const signedHeaderNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalHeaders =
    signedHeaderNames.map((h) => `${h}:${(headers[h] ?? "").trim()}`).join("\n") + "\n";
  const canonicalQuery = ""; // No query strings needed; presigned URLs are a future card.
  const canonicalRequest = [
    args.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    args.payloadHash,
  ].join("\n");

  // String-to-sign
  const credentialScope = `${dateStamp}/${args.region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    ALGO,
    isoBasic,
    credentialScope,
    sha256Hex(textEncode(canonicalRequest)),
  ].join("\n");

  // Signing key derivation
  const kDate = hmacBytes(textEncode(`AWS4${args.secretAccessKey}`), dateStamp);
  const kRegion = hmacBytes(kDate, args.region);
  const kService = hmacBytes(kRegion, SERVICE);
  const kSigning = hmacBytes(kService, "aws4_request");
  const signature = bytesToHex(hmacBytes(kSigning, stringToSign));

  const authorization =
    `${ALGO} Credential=${args.accessKeyId}/${credentialScope}` +
    `, SignedHeaders=${signedHeaders}` +
    `, Signature=${signature}`;

  return {
    url,
    headers: { ...headers, Authorization: authorization },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseEndpoint(endpoint: string): { protocol: string; host: string } {
  const trimmed = endpoint.replace(/\/+$/, "");
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const m = /^([a-z]+:)\/\/([^/]+)/i.exec(withScheme);
  if (!m) throw new Error(`invalid s3 endpoint: ${endpoint}`);
  return { protocol: m[1]!, host: m[2]! };
}

/**
 * Encode an S3 object key for use in a URL path. Per SigV4, RFC 3986
 * unreserved chars stay; `/` stays (S3 treats it as path); everything else
 * percent-encoded. encodeURIComponent is closer but encodes `/`; we splice.
 */
export function encodeS3Key(key: string): string {
  return key
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

function toIsoBasic(d: Date): string {
  // YYYYMMDDTHHMMSSZ
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function sha256Hex(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}

function emptyBodySha256(): string {
  // sha256("")
  return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
}

function textEncode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function hmacBytes(key: Uint8Array, msg: string | Uint8Array): Uint8Array {
  const m = typeof msg === "string" ? textEncode(msg) : msg;
  return hmac(sha256, key, m);
}

/**
 * Parse an S3 XML error body into `code` + human message. Falls back to the
 * raw text when no `<Code>` is present.
 */
export function parseS3Error(status: number, body: string): { code: string; message: string } {
  const codeMatch = /<Code>([^<]+)<\/Code>/i.exec(body);
  const msgMatch = /<Message>([^<]+)<\/Message>/i.exec(body);
  const code = codeMatch ? codeMatch[1]! : "s3_http_error";
  const msg = msgMatch ? msgMatch[1]! : body.slice(0, 200);
  return { code, message: `S3 ${status} ${code}: ${msg}` };
}
