// /api/v0/keys — HTTP shell over src/actions/keys.ts.
//
// JWT-only surface on purpose: a key cannot mint or revoke keys, so a leaked
// key can never escalate to more keys. requireCaller still runs here (the
// router mounts behind optionalAuth like everything else); the key-token guard
// moved to the action, which reads the same bearer off `input.token`.
//
// The raw body read stays HERE, and stays raw. GET/POST /keys is on
// check:boundary's unmigrated allowlist, and the re-audit fails an allowlisted
// route whose file no longer shows the read — so converting this to a schema
// would break the ratchet on the way past. That is another ticket's work.
//
// POST /keys hands the action an UNRUN body Effect rather than a parsed body.
// See the rule-10 note on createKey: the 403 for a key-bearing caller has
// always been answered BEFORE the 400 for a malformed body, and running the
// parse on the way in would silently swap them.

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Effect, Option } from "effect";

import { path } from "../routes-manifest";
import { makeRunJson } from "../lib/run-json";
import { bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { requireCaller } from "../authz";
import { ValidationError } from "../lib/errors";
import { actionInput } from "../actions/types";
import {
  createKey,
  deleteKey,
  listKeys,
  type KeyServices,
  type KeysFailure,
} from "../actions/keys";

const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<KeysFailure>) => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const f = failure.value;
    switch (f._tag) {
      case "ValidationError":
        return c.json({ error: "invalid-body", reason: f.reason }, 400);
      case "UnauthorizedError":
        return c.json({ error: "unauthorized", reason: f.reason }, 401);
      case "ForbiddenError":
        return c.json({ error: "forbidden", reason: f.reason }, 403);
      case "NotFoundError":
        return c.json({ error: "not-found", reason: f.reason }, 404);
      case "DbError":
        return c.json({ error: "internal", reason: `db-${f.reason}` }, 500);
    }
  }
  return c.json({ error: "internal", reason: "defect" }, 500);
};

export const makeKeysRouter = (layerFor: LayerFor = bootstrap) => {
  const keys = new Hono<AppHonoEnv>();
  const runJson = makeRunJson<KeysFailure, KeyServices>(layerFor, errorResponse);

  // ── POST /keys — mint; the plaintext appears here and never again ───────
  keys.post(path("key.create"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* createKey(
        actionInput(
          claims,
          c.req.param(),
          Effect.tryPromise({
            try: () => c.req.json() as Promise<Record<string, unknown>>,
            catch: () => new ValidationError({ reason: "expected-json" }),
          }),
          { token: c.get("token") ?? "" },
        ),
      );
    });
    return runJson(c, program, 201);
  });

  // ── GET /keys — the caller's keys, newest first, metadata only ──────────
  keys.get(path("key.list"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* listKeys(
        actionInput(claims, c.req.param(), undefined, { token: c.get("token") ?? "" }),
      );
    });
    return runJson(c, program);
  });

  // ── DELETE /keys/:id — soft revoke ──────────────────────────────────────
  keys.delete(path("key.delete"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* deleteKey(
        actionInput(claims, c.req.param(), undefined, { token: c.get("token") ?? "" }),
      );
    });
    return runJson(c, program);
  });

  return keys;
};
