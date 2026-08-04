// /api/v0 BYOB storage surface (phase 18b) — HTTP shell over
// src/actions/storage.ts.
//
//   GET    /server-pubkey             — public; the static pubkey clients
//                                       NIP-44-encrypt S3 creds to.
//   GET    /org/:handle/storage       — current config, secrets redacted.
//   PUT    /org/:handle/storage       — upsert (default | blossom | s3).
//   POST   /org/:handle/storage/test  — probe the configured backend.
//   DELETE /org/:handle/storage       — reset to default storage.
//
// All /org/… endpoints are org-OWNER only — the whole point of the
// encrypt-to-server design is that members (even admins) never touch
// storage credentials, so the config surface matches: owners only.
//
// PUT with kind "s3" and no ciphertext keeps the previously-saved
// credentials, so owners can edit endpoint/region/bucket without re-typing
// secrets. The connection test always runs against what is SAVED — save
// first, then test.
//
// `readJsonBody(c)` stays PHYSICALLY in this file (EFB-98 rule 11).
// PUT /org/:org_slug/storage is on scripts/boundary-allowlist.json, and both
// boundary checkers scan src/routes as text — move the read into the action
// and the entry stops describing anything real, silently turning detected debt
// into declared debt while the checker keeps exiting 0.

import { Hono } from "hono";
import { path } from "../routes-manifest";
import { Effect } from "effect";
import { bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { grantsOf } from "../http";
import { requireCaller } from "../authz";
import { deriveServerStorageKeys } from "../lib/nostr-keys";
import { errorResponse, readJsonBody } from "./errors";
import { makeRunJson } from "../lib/run-json";
import { actionInput } from "../actions/types";
import {
  deleteStorageConfig,
  getStorageConfig,
  setStorageConfig,
  testStorageConfig,
  type StorageFailure,
  type StorageServices,
} from "../actions/storage";

export const makeStorageRouter = (layerFor: LayerFor = bootstrap) => {
  const storage = new Hono<AppHonoEnv>();
  const runJson = makeRunJson<StorageFailure, StorageServices>(layerFor, errorResponse);

  // ── GET /server-pubkey — public, static, cacheable ──────────────────────
  //
  // DELIBERATELY HAS NO ACTION (EFB-98). There is no business logic to move:
  // `deriveServerStorageKeys` is a pure function in src/lib/nostr-keys.ts that
  // already unit-tests without HTTP, and everything else here is transport —
  // a response header and a 503 that the shared errorResponse does not carry.
  // Giving it an action would mean inventing a failure tag and a status-code
  // mapping to satisfy a shape, which is the opposite of what the split buys.
  storage.get(path("storage.serverPubkey"), (c) => {
    const keys = deriveServerStorageKeys(c.env.EVENFLOW_STORAGE_SECRET);
    if (keys === null) {
      return c.json({ error: "not-configured", reason: "storage-secret" }, 503);
    }
    c.header("Cache-Control", "public, max-age=86400");
    return c.json({ pubkey: keys.pubkeyHex });
  });

  // ── GET /org/:handle/storage — current config, redacted ─────────────────
  storage.get(path("storage.get"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* getStorageConfig(
        actionInput(claims, c.req.param(), undefined, {
          grants: grantsOf(c),
          orgSlug: c.req.param("org_slug") ?? null,
        }),
      );
    });
    return runJson(c, program);
  });

  // ── PUT /org/:handle/storage — upsert ───────────────────────────────────
  //
  // The read is DEFERRED (EFB-98 rule 10): `readJsonBody` is constructed here,
  // so the boundary allowlist entry pinned to this file still describes a real
  // read, but it is handed over UN-YIELDED and run inside the action below
  // authorizeOrgAccess. This endpoint has always authorized before reading, so
  // a non-owner sending a malformed body gets the authorization answer rather
  // than a 400 about their JSON. Yielding it here would flip that.
  storage.put(path("storage.set"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* setStorageConfig(
        actionInput(claims, c.req.param(), readJsonBody(c), {
          grants: grantsOf(c),
          orgSlug: c.req.param("org_slug") ?? null,
        }),
        // Ambient server configuration, so it travels as an explicit parameter
        // rather than riding in the caller's input record.
        c.env.EVENFLOW_STORAGE_SECRET,
      );
    });
    return runJson(c, program);
  });

  // ── POST /org/:handle/storage/test — probe the SAVED config ─────────────
  storage.post(path("storage.test"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* testStorageConfig(
        actionInput(claims, c.req.param(), undefined, {
          grants: grantsOf(c),
          orgSlug: c.req.param("org_slug") ?? null,
        }),
        c.env.EVENFLOW_STORAGE_SECRET,
      );
    });
    return runJson(c, program);
  });

  // ── DELETE /org/:handle/storage — back to default ───────────────────────
  storage.delete(path("storage.delete"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* deleteStorageConfig(
        actionInput(claims, c.req.param(), undefined, {
          grants: grantsOf(c),
          orgSlug: c.req.param("org_slug") ?? null,
        }),
      );
    });
    return runJson(c, program);
  });

  return storage;
};
