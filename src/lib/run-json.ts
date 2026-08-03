/**
 * EFB-98: the one place an Effect program becomes an HTTP response.
 *
 * This existed eight times — separately declared inside makeKeysRouter,
 * makeCommentsRouter, makeIssuesRouter, makeSprintsRouter, makeProfileRouter,
 * makeStorageRouter, makeAttachmentsRouter and makeNotificationsRouter — with
 * the same four lines in each. Eight copies is eight chances for one of them
 * to drift on the status code, the layer, or whether a failure is reported at
 * all.
 *
 * The error MAPPING deliberately stays per-file. Each router owns a distinct
 * failure union and answers reasons specific to its domain, and collapsing
 * those into one switch would either lose reasons or grow a union nobody can
 * read. What is shared is the plumbing: provide the layer, run to an Exit,
 * branch once.
 */

import { Effect, Exit, type Cause } from "effect";
import type { Context } from "hono";

import type { AppHonoEnv, LayerFor } from "../http";

/** The success statuses this API returns from a JSON handler. */
export type OkStatus = 200 | 201;

/**
 * Build a router's `runJson`.
 *
 * @param layerFor  the router's layer factory — production bootstrap, or a
 *                  test layer over an in-memory database.
 * @param errorResponse  the router's own failure-to-response mapping.
 */
export const makeRunJson =
  <Failure, Services>(
    layerFor: LayerFor,
    errorResponse: (c: Context<AppHonoEnv>, cause: Cause.Cause<Failure>) => Response,
  ) =>
  async (
    c: Context<AppHonoEnv>,
    program: Effect.Effect<unknown, Failure, Services>,
    okStatus: OkStatus = 200,
  ): Promise<Response> => {
    // The layer supplies every service the program asks for. The cast keeps
    // each router's precise `Services` union at its own call sites rather than
    // widening every program to the full AppServices set — the layer really
    // does provide them, but only `bootstrap`'s return type says so.
    const provided = Effect.provide(
      program as Effect.Effect<unknown, Failure, never>,
      layerFor(c.env),
    );
    const exit = await Effect.runPromiseExit(provided);
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value as never, okStatus);
  };
