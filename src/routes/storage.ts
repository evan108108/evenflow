// /api/v0 BYOB storage surface (phase 18b).
//
//   GET    /server-pubkey             — public; the static pubkey clients
//                                       NIP-44-encrypt S3 creds to.
//   GET    /orgs/:handle/storage      — current config, secrets redacted.
//   PUT    /orgs/:handle/storage      — upsert (default | blossom | s3).
//   POST   /orgs/:handle/storage/test — probe the configured backend.
//   DELETE /orgs/:handle/storage      — reset to default storage.
//
// All /orgs/… endpoints are org-OWNER only — the whole point of the
// encrypt-to-server design is that members (even admins) never touch
// storage credentials, so the config surface matches: owners only.
//
// PUT with kind "s3" and no ciphertext keeps the previously-saved
// credentials, so owners can edit endpoint/region/bucket without re-typing
// secrets. The connection test always runs against what is SAVED — save
// first, then test.

import { Hono } from "hono";
import { path } from "../routes-manifest";
import type { Context } from "hono";
import { Clock, Effect, Exit } from "effect";
import {
  AuditLog,
  Blossom,
  BlossomError,
  Db,
  S3,
  S3Error,
  bootstrap,
  type S3Target,
} from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { authorizeOrgAccess, callerPubkey, requireCaller } from "../authz";
import { deriveServerStorageKeys, decryptS3Creds } from "../lib/nostr-keys";
import {
  getOrgStorageConfig,
  redactedStorageView,
  type OrgStorageConfigShape,
} from "../storage-config";
import { ValidationError, errorResponse, readJsonBody } from "./errors";

const URL_MAX = 512;
const FIELD_MAX = 512;
const CIPHERTEXT_MAX = 8192;
const SENDER_PUBKEY_RE = /^[0-9a-f]{64}$/i;
const PROBE_BYTES = 16;

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
        // Keep-existing form — the PUT handler verifies a row with creds exists.
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

export const makeStorageRouter = (layerFor: LayerFor = bootstrap) => {
  const storage = new Hono<AppHonoEnv>();

  const runJson = async (
    c: Context<AppHonoEnv>,
    program: Effect.Effect<unknown, unknown, Db | AuditLog | Blossom | S3>,
    okStatus: 200 | 201 = 200,
  ) => {
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value, okStatus);
  };

  // ── GET /server-pubkey — public, static, cacheable ──────────────────────
  storage.get(path("storage.serverPubkey"), (c) => {
    const keys = deriveServerStorageKeys(c.env.EVENFLOW_STORAGE_SECRET);
    if (keys === null) {
      return c.json({ error: "not-configured", reason: "storage-secret" }, 503);
    }
    c.header("Cache-Control", "public, max-age=86400");
    return c.json({ pubkey: keys.pubkeyHex });
  });

  // ── GET /orgs/:handle/storage — current config, redacted ────────────────
  storage.get(path("storage.get"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const { org } = yield* authorizeOrgAccess(c.req.param("org_slug"), callerPubkey(claims), "owner");
      const cfg = yield* getOrgStorageConfig(org.id);
      return { config: redactedStorageView(cfg) };
    });
    return runJson(c, program);
  });

  // ── PUT /orgs/:handle/storage — upsert ──────────────────────────────────
  storage.put(path("storage.set"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      const { org } = yield* authorizeOrgAccess(c.req.param("org_slug"), pubkey, "owner");
      const body = yield* readJsonBody(c);
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
        const keys = deriveServerStorageKeys(c.env.EVENFLOW_STORAGE_SECRET);
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
    return runJson(c, program);
  });

  // ── POST /orgs/:handle/storage/test — probe the SAVED config ────────────
  storage.post(path("storage.test"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const { org } = yield* authorizeOrgAccess(c.req.param("org_slug"), callerPubkey(claims), "owner");
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
        const keys = deriveServerStorageKeys(c.env.EVENFLOW_STORAGE_SECRET);
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
    return runJson(c, program);
  });

  // ── DELETE /orgs/:handle/storage — back to default ──────────────────────
  storage.delete(path("storage.delete"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const { org } = yield* authorizeOrgAccess(c.req.param("org_slug"), callerPubkey(claims), "owner");
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
    return runJson(c, program);
  });

  return storage;
};
