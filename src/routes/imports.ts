// EFB-15 CSV import — HTTP shell over src/actions/imports.ts.
//
// EFB-98 split this file in two. Everything that decides what an import DOES —
// the 100-parameter write strategy, the dedup/replay window, the per-row board
// resolution, the audit record — moved to the action module, and the header
// documenting that strategy moved with it. What stays here is transport:
// requireCaller, the body parse, failure-to-status-code, and the one piece of
// response FORMATTING this router has always done.
//
// A NEW route family, so every body comes through `parseRouteBody` and nothing
// here is in `scripts/boundary-allowlist.json`, which is closed to new
// entries. The parse stays physically in this file (rule 2) so check:boundary
// keeps seeing the marker where it has always seen it.

import { Hono } from "hono";
import { path } from "../routes-manifest";
import type { Context } from "hono";
import { Cause, Effect, Option } from "effect";
import { bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { requireCaller } from "../authz";
import { parseRouteBody } from "../lib/route-body";
import { makeRunJson } from "../lib/run-json";
import { PostBulkIssuesBody } from "../lib/csv-canonical";
import { actionInput } from "../actions/types";
import {
  createBulkImport,
  listImports,
  type ImportFailure,
  type ImportServices,
} from "../actions/imports";

export const makeImportsRouter = (layerFor: LayerFor = bootstrap) => {
  const app = new Hono<AppHonoEnv>();

  /**
   * This router's OWN mapping, kept byte-for-byte (rule 3). Deliberately NOT
   * the shared errorResponse from ./errors: the default arm here answers
   * `{error:"internal", reason:"internal"}` where the shared one answers
   * `defect`, and a DbError falls to that default here where the shared one
   * answers `db-<reason>`. Swapping mappings would change reason strings on
   * the wire — BOUNDARY_DISCIPLINE.md:244, a separate decision needing a
   * ticket, not a side effect of a migration.
   *
   * EFB-98 rule 13 — the PARAMETER changed and nothing else. The old local
   * `run` called this with the Fail's error already unwrapped
   * (`(exit.cause as {error?}).error ?? exit.cause`); `makeRunJson` passes the
   * CAUSE. Left as it was, `_tag` would read undefined off a Cause, every
   * branch would miss, and every 400/401/403/404 would quietly answer 500 —
   * invisible to the typechecker, because the parameter was `unknown`.
   * `Cause.failureOption` recovers exactly what the old unwrap did on a Fail,
   * and on a Die both spellings land on the same 500 default.
   */
  const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<ImportFailure>) => {
    const failure = Cause.failureOption(cause);
    const e = (Option.isSome(failure) ? failure.value : undefined) as
      | { _tag?: string; reason?: string }
      | undefined;
    const tag = String(e?._tag ?? "");
    const reason = e?.reason ?? "error";
    if (tag === "UnauthorizedError") return c.json({ error: "unauthorized", reason }, 401);
    if (tag === "ForbiddenError") return c.json({ error: "forbidden", reason }, 403);
    if (tag === "NotFoundError" || tag === "BoardOwnershipError") {
      return c.json({ error: "not-found", reason }, 404);
    }
    if (tag === "ValidationError") return c.json({ error: "invalid-body", reason }, 400);
    return c.json({ error: "internal", reason: "internal" }, 500);
  };

  const runJson = makeRunJson<ImportFailure, ImportServices>(layerFor, errorResponse);

  // ── POST /board/:slug/issues/bulk ───────────────────────────────────────
  //
  // The parse is DEFERRED (rule 10): `parseRouteBody` is constructed here — so
  // check:boundary still sees it in a route file — but handed over un-yielded
  // and run inside the action below the board gate. This handler has always
  // resolved the board first, so a malformed body aimed at a board the caller
  // cannot contribute to keeps answering 404/403 rather than a 400 about the
  // JSON. Yielding it here would flip that.
  //
  // The `.body` unwrap is this router's own response formatting, which the old
  // local `run` did through a third argument. The action returns the domain
  // result `{ replayed, body }`; only this shell knows `replayed` is not part
  // of the response.
  app.post(path("import.issues.bulk"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const result = yield* createBulkImport(
        actionInput(claims, c.req.param(), parseRouteBody(c, PostBulkIssuesBody), {
          orgSlug: c.req.param("org_slug") ?? null,
        }),
      );
      return result.body;
    });
    return runJson(c, program);
  });

  // ── GET /board/:slug/imports — the audit list ───────────────────────────
  app.get(path("import.list"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* listImports(
        actionInput(claims, c.req.param(), undefined, {
          orgSlug: c.req.param("org_slug") ?? null,
        }),
      );
    });
    return runJson(c, program);
  });

  return app;
};
