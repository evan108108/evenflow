// EFB-98 rule 13 — the webhooks family's failure-to-status mapping, pinned.
//
// WHY THIS FILE EXISTS. Before EFB-98 this router ran its own `run` helper,
// which unwrapped the Fail and handed `errorResponse` the raw error object.
// The shared `makeRunJson` hands `errorResponse` a Cause instead. Adopting the
// shared runner without also changing what `errorResponse` accepts is a silent
// catastrophe: `_tag` reads undefined on a Cause, every branch misses, and
// EVERY failure — 401, 403, 404, 400 — falls out of the bottom as a 500.
// Nothing about it is visible to the typechecker, because the old signature
// took `unknown`.
//
// And it was invisible to the suite too. `tests/webhook-subscriptions.test.ts`
// is 41 tests deep on this family and asserts exactly three statuses: 200, 201
// and 201. I verified the gap rather than assuming it — with the mapping
// deliberately short-circuited so that every failure answered 500, all 41
// still passed. So the conversion this ticket required was, until this file,
// entirely untested.
//
// Each case below therefore asserts a SPECIFIC non-500 status. A 500 here means
// the Cause never got unwrapped. The bare `{ reason }` envelope is asserted
// too, because this family deliberately does not use the `{ error, reason }`
// shape the comments and github families answer, and a "tidy-up" that
// harmonised them would be a wire-visible change to shipped behaviour.

import { describe, expect, it } from "vitest";

import { url } from "../src/routes-manifest";
import { bearer, createBoard, jsonReq, makeHarness } from "./harness";

/** The master key the create path seals its per-subscription secret with. */
const WEBHOOK_ENV = { EVENFLOW_WEBHOOK_SECRET: "test-master-secret-value" };

describe("EFB-98 rule 13 — webhook failures keep their own status codes", () => {
  it("401s an anonymous caller rather than 500ing", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request(url("webhook.list", { slug: "kb" }), {}, WEBHOOK_ENV);
    expect(res.status).toBe(401);
    // The bare envelope this family has always answered — no `error` key.
    expect(await res.json()).toEqual({ reason: "authentication-required" });
  });

  it("404s a board the caller cannot see rather than 500ing", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request(
      url("webhook.list", { slug: "no-such-board" }),
      { headers: bearer },
      WEBHOOK_ENV,
    );
    expect(res.status).toBe(404);
  });

  it("400s a malformed body rather than 500ing", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request(
      url("webhook.list", { slug: "kb" }),
      // `event_kinds` must be a non-empty array of known kinds; an unknown
      // kind is the schema's refusal, and it has to survive as a 400.
      jsonReq("POST", { name: "hook", url: "https://example.com/h", event_kinds: ["nope.bogus"] }),
      WEBHOOK_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("404s an unknown subscription id on delete rather than 500ing", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request(
      url("webhook.delete", { slug: "kb", id: "no-such-subscription" }),
      { method: "DELETE", headers: bearer },
      WEBHOOK_ENV,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ reason: "subscription-not-found" });
  });

  it("500s a missing server secret as this family always has — NOT the 503 github answers", async () => {
    // ConfigError has no branch in this router's mapping and falls through to
    // the bare 500, which is what shipped. github.ts answers 503 for the same
    // condition. The difference is real and preserved rather than harmonised:
    // making them agree is a wire change, and this ticket moves code.
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request(
      url("webhook.list", { slug: "kb" }),
      jsonReq("POST", {
        name: "hook",
        url: "https://example.com/h",
        event_kinds: ["issue.created"],
      }),
      {}, // no EVENFLOW_WEBHOOK_SECRET
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ reason: "internal" });
  });
});
