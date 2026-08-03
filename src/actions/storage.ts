/**
 * BYOB storage actions (phase 18b).
 *
 * EFB-98 split src/routes/storage.ts in two. The route shell extracts params,
 * constructs the body read, runs requireCaller and runJson; everything that
 * decides what a storage config IS lives here.
 *
 * Bodies moved VERBATIM; the only edits read params/body/claims off `input`.
 *
 * THE SERVER STORAGE SECRET IS A POSITIONAL PARAMETER, NOT AN INPUT FIELD.
 * `EVENFLOW_STORAGE_SECRET` is ambient server configuration — it belongs to
 * the deployment, not to the caller, and nothing about it varies per request.
 * `ActionInput` carries what the CALLER sent (claims, token, params, body), so
 * putting a server secret in there would blur the one distinction that makes
 * the record safe to reason about. It is typed `string | undefined` and every
 * consumer handles the unset case explicitly — never `!` — because an
 * unconfigured deployment is a real state these routes already answer for.
 *
 * GET /server-pubkey has no action. It reads the secret, derives a pubkey with
 * a pure lib function, sets a Cache-Control header and answers 503 when
 * unconfigured — all transport, plus a call to code that already unit-tests
 * without HTTP. See the note at its registration in the route file.
 */

import { Clock, Effect } from "effect";

import { AuditLog, Blossom, Db, DbError, S3, type S3Target } from "../effects";
import {
  ForbiddenError,
  UnauthorizedError,
  authorizeOrgAccess,
  callerPubkey,
  type BoardOwnershipError,
} from "../authz";
import { deriveServerStorageKeys, decryptS3Creds } from "../lib/nostr-keys";
import {
  getOrgStorageConfig,
  redactedStorageView,
  type OrgStorageConfigShape,
} from "../storage-config";
import { NotFoundError, ValidationError } from "../lib/errors";
import type { ActionInput } from "./types";

const URL_MAX = 512;
const FIELD_MAX = 512;
const CIPHERTEXT_MAX = 8192;
const SENDER_PUBKEY_RE = /^[0-9a-f]{64}$/i;
const PROBE_BYTES = 16;

export type StorageFailure =
  | ValidationError
  | NotFoundError
  | BoardOwnershipError
  | UnauthorizedError
  | ForbiddenError
  | DbError;

/** Services the storage actions need. */
export type StorageServices = Db | AuditLog | Blossom | S3;

/** Accept http(s) URLs only; return the trailing-slash-trimmed form. */
const asHttpUrl = (v: unknown): string | null => {
  if (typeof v !== "string" || v === "" || v.length > URL_MAX) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return v.replace(/\/+$/, "");
  } catch {
    return null;
  }
};

const asField = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" && v.length <= FIELD_MAX ? v.trim() : null;

interface StorageUpsert {
  readonly kind: "default" | "blossom" | "s3";
  readonly blossom_url: string | null;
  readonly s3_endpoint: string | null;
  readonly s3_region: string | null;
  readonly s3_bucket: string | null;
  readonly s3_path_style: boolean;
  /** null = keep existing ciphertext (s3 only). */
  readonly s3_creds_ciphertext: string | null;
  readonly s3_creds_sender_pubkey: string | null;
}

/** Validate the PUT body into an upsert, or fail with the offending field. */
const validateUpsert = (
  body: Record<string, unknown>,
): Effect.Effect<StorageUpsert, ValidationError> =>
  Effect.gen(function* () {
    const kind = body["kind"];
    if (kind === "default") {
      return {
        kind: "default" as const,
        blossom_url: null,
        s3_endpoint: null,
        s3_region: null,
        s3_bucket: null,
        s3_path_style: true,
        s3_creds_ciphertext: null,
        s3_creds_sender_pubkey: null,
      };
    }
    if (kind === "blossom") {
      const url = asHttpUrl(body["blossom_url"]);
      if (url === null) return yield* new ValidationError({ reason: "blossom_url" });
      return {
        kind: "blossom" as const,
        blossom_url: url,
        s3_endpoint: null,
        s3_region: null,
        s3_bucket: null,
        s3_path_style: true,
        s3_creds_ciphertext: null,
        s3_creds_sender_pubkey: null,
      };
    }
    if (kind === "s3") {
      const endpoint = asField(body["s3_endpoint"]);
      const region = asField(body["s3_region"]);
      const bucket = asField(body["s3_bucket"]);
      if (endpoint === null) return yield* new ValidationError({ reason: "s3_endpoint" });
      if (region === null) return yield* new ValidationError({ reason: "s3_region" });
      if (bucket === null) return yield* new ValidationError({ reason: "s3_bucket" });
      const pathStyleRaw = body["s3_path_style"];
      if (pathStyleRaw !== undefined && typeof pathStyleRaw !== "boolean") {
        return yield* new ValidationError({ reason: "s3_path_style" });
      }
      const ciphertext = body["s3_creds_ciphertext"];
      const senderPubkey = body["s3_creds_sender_pubkey"];
      if (ciphertext === undefined && senderPubkey === undefined) {
        // Keep-existing form — the PUT action verifies a row with creds exists.
        return {
          kind: "s3" as const,
          blossom_url: null,
          s3_endpoint: endpoint,
          s3_region: region,
          s3_bucket: bucket,
          s3_path_style: pathStyleRaw ?? true,
          s3_creds_ciphertext: null,
          s3_creds_sender_pubkey: null,
        };
      }
      if (
        typeof ciphertext !== "string" ||
        ciphertext === "" ||
        ciphertext.length > CIPHERTEXT_MAX
      ) {
        return yield* new ValidationError({ reason: "s3_creds_ciphertext" });
      }
      if (typeof senderPubkey !== "string" || !SENDER_PUBKEY_RE.test(senderPubkey)) {
        return yield* new ValidationError({ reason: "s3_creds_sender_pubkey" });
      }
      return {
        kind: "s3" as const,
        blossom_url: null,
        s3_endpoint: endpoint,
        s3_region: region,
        s3_bucket: bucket,
        s3_path_style: pathStyleRaw ?? true,
        s3_creds_ciphertext: ciphertext,
        s3_creds_sender_pubkey: senderPubkey,
      };
    }
    return yield* new ValidationError({ reason: "kind" });
  });

/** The connection test's uniform result — always 200, ok flags the outcome. */
type TestResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

const s3TargetOf = (
  cfg: OrgStorageConfigShape,
  creds: { access_key_id: string; secret_access_key: string },
): S3Target => ({
  endpoint: cfg.s3_endpoint ?? "",
  region: cfg.s3_region ?? "",
  bucket: cfg.s3_bucket ?? "",
  pathStyle: cfg.s3_path_style,
  accessKeyId: creds.access_key_id,
  secretAccessKey: creds.secret_access_key,
});

/** GET /org/:handle/storage — current config, redacted. */
export const getStorageConfig = (
  input: ActionInput,
): Effect.Effect<unknown, StorageFailure, StorageServices> =>
  Effect.gen(function* () {
    const { org } = yield* authorizeOrgAccess(
      input.orgSlug ?? "",
      callerPubkey(input.claims),
      "owner",
    );
    const cfg = yield* getOrgStorageConfig(org.id);
    return { config: redactedStorageView(cfg) };
  });

/**
 * PUT /org/:handle/storage — upsert.
 *
 * DEFERRED PARSE (EFB-98 rule 10). `body` arrives as an un-yielded Effect and
 * is yielded below `authorizeOrgAccess`, on the line the raw read has always
 * sat on. This endpoint is org-OWNER only, and the whole point of the
 * encrypt-to-server design is that non-owners never touch storage credentials
 * — so a non-owner sending a malformed body must keep getting the
 * authorization answer, not a 400 that tells them their JSON was the problem.
 * Yielding this in the route shell would flip that.
 */
export const setStorageConfig = (
  input: ActionInput<Effect.Effect<Record<string, unknown>, ValidationError, never>>,
  storageSecret: string | undefined,
): Effect.Effect<unknown, StorageFailure, StorageServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    const pubkey = callerPubkey(claims);
    const { org } = yield* authorizeOrgAccess(input.orgSlug ?? "", pubkey, "owner");
    const body = yield* input.body;
    const upsert = yield* validateUpsert(body);

    const existing = yield* getOrgStorageConfig(org.id);
    // s3 without fresh creds keeps the saved ciphertext — which must exist.
    let ciphertext = upsert.s3_creds_ciphertext;
    let senderPubkey = upsert.s3_creds_sender_pubkey;
    if (upsert.kind === "s3" && ciphertext === null) {
      if (existing?.s3_creds_ciphertext == null || existing.s3_creds_sender_pubkey == null) {
        return yield* new ValidationError({ reason: "s3_creds_ciphertext" });
      }
      ciphertext = existing.s3_creds_ciphertext;
      senderPubkey = existing.s3_creds_sender_pubkey;
    }
    // Refuse ciphertext the server can't unwrap — catches a client that
    // encrypted to a stale/wrong pubkey at save time, not at upload time.
    if (upsert.kind === "s3" && upsert.s3_creds_ciphertext !== null) {
      const keys = deriveServerStorageKeys(storageSecret);
      if (keys === null || decryptS3Creds(keys, ciphertext!, senderPubkey!) === null) {
        return yield* new ValidationError({ reason: "s3_creds_undecryptable" });
      }
    }

    const db = yield* Db;
    const audit = yield* AuditLog;
    const now = yield* Clock.currentTimeMillis;
    yield* db.execute(
      "INSERT INTO orgStorageConfig (org_id, kind, blossom_url, s3_endpoint, s3_region, s3_bucket, s3_path_style, s3_creds_ciphertext, s3_creds_sender_pubkey, updated_by_pubkey, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(org_id) DO UPDATE SET kind = excluded.kind, blossom_url = excluded.blossom_url, s3_endpoint = excluded.s3_endpoint, s3_region = excluded.s3_region, s3_bucket = excluded.s3_bucket, s3_path_style = excluded.s3_path_style, s3_creds_ciphertext = excluded.s3_creds_ciphertext, s3_creds_sender_pubkey = excluded.s3_creds_sender_pubkey, updated_by_pubkey = excluded.updated_by_pubkey, updated_at_ms = excluded.updated_at_ms",
      [
        org.id,
        upsert.kind,
        upsert.blossom_url,
        upsert.s3_endpoint,
        upsert.s3_region,
        upsert.s3_bucket,
        upsert.s3_path_style ? 1 : 0,
        ciphertext,
        senderPubkey,
        pubkey,
        now,
      ],
    );
    yield* audit.record({
      event_type: "storage_config_updated",
      actor: claims.login,
      details: { org: org.id, kind: upsert.kind },
    });
    const cfg = yield* getOrgStorageConfig(org.id);
    return { config: redactedStorageView(cfg) };
  });

/** POST /org/:handle/storage/test — probe the SAVED config. */
export const testStorageConfig = (
  input: ActionInput,
  storageSecret: string | undefined,
): Effect.Effect<unknown, StorageFailure, StorageServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    const { org } = yield* authorizeOrgAccess(
      input.orgSlug ?? "",
      callerPubkey(claims),
      "owner",
    );
    const cfg = yield* getOrgStorageConfig(org.id);
    const audit = yield* AuditLog;

    const probe = crypto.getRandomValues(new Uint8Array(PROBE_BYTES));
    const result: TestResult = yield* Effect.gen(function* () {
      if (cfg === null || cfg.kind === "default") {
        // Default storage is Evenflow's to keep healthy — nothing org-specific to probe.
        return { ok: true } as TestResult;
      }
      if (cfg.kind === "blossom") {
        const blossom = yield* Blossom;
        return yield* blossom
          .uploadTo(cfg.blossom_url ?? "", probe, "application/octet-stream", "evenflow-connection-test")
          .pipe(
            Effect.as({ ok: true } as TestResult),
            Effect.catchTag("BlossomError", (e) =>
              Effect.succeed<TestResult>({
                ok: false,
                code: `blossom_${e.reason}`,
                message: e.detail ?? `Blossom host answered ${e.status ?? "nothing"}.`,
              }),
            ),
          );
      }
      // s3 — unwrap creds, then put/head/delete a probe object.
      const keys = deriveServerStorageKeys(storageSecret);
      if (keys === null) {
        return { ok: false, code: "server_not_configured", message: "Server storage key missing." } as TestResult;
      }
      if (cfg.s3_creds_ciphertext === null || cfg.s3_creds_sender_pubkey === null) {
        return { ok: false, code: "missing_credentials", message: "No credentials saved." } as TestResult;
      }
      const creds = decryptS3Creds(keys, cfg.s3_creds_ciphertext, cfg.s3_creds_sender_pubkey);
      if (creds === null) {
        return { ok: false, code: "creds_unreadable", message: "Saved credentials could not be unwrapped — re-enter them." } as TestResult;
      }
      const target = s3TargetOf(cfg, creds);
      const key = `evenflow/${org.id}/connection-test-${crypto.randomUUID()}`;
      const s3 = yield* S3;
      return yield* Effect.gen(function* () {
        yield* s3.putObject(target, key, probe, "application/octet-stream");
        yield* s3.headObject(target, key);
        yield* s3.deleteObject(target, key);
        return { ok: true } as TestResult;
      }).pipe(
        Effect.catchTag("S3Error", (e) =>
          Effect.succeed<TestResult>({
            ok: false,
            code: e.code ?? `s3_${e.reason}`,
            message: e.detail ?? "The bucket did not accept the probe.",
          }),
        ),
      );
    });

    yield* audit.record({
      event_type: "storage_config_tested",
      actor: claims.login,
      details: { org: org.id, kind: cfg?.kind ?? "default", ok: result.ok },
    });
    return result;
  });

/** DELETE /org/:handle/storage — back to default. */
export const deleteStorageConfig = (
  input: ActionInput,
): Effect.Effect<unknown, StorageFailure, StorageServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    const { org } = yield* authorizeOrgAccess(
      input.orgSlug ?? "",
      callerPubkey(claims),
      "owner",
    );
    const db = yield* Db;
    const audit = yield* AuditLog;
    yield* db.execute("DELETE FROM orgStorageConfig WHERE org_id = ?", [org.id]);
    yield* audit.record({
      event_type: "storage_config_reset",
      actor: claims.login,
      details: { org: org.id },
    });
    return { config: redactedStorageView(null) };
  });
