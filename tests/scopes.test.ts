// EFB-100: what a scoped API key may and may not reach.
//
// The claim under test is the one the whole ticket rests on: a key carrying a
// narrow scope is refused everything outside it, and the refusal happens in
// ONE place — the shared auth middleware — against the requirement DERIVED
// from the route's manifest entry.
//
// These go through h.app.request deliberately, unlike an action test. The
// thing being proved IS the routing-to-manifest resolution: that the pattern
// Hono matched maps back to the entry whose scope requirement gates it. An
// action test cannot see that, because it never routes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { url } from "../src/routes-manifest";
import { createBoard, createIssue, jsonReq, makeHarness, type Harness } from "./harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Mint a key, then write its scopes straight onto the row.
 *
 * The create surface does not accept scopes yet at this point in the branch;
 * writing the column directly is what lets the ENFORCEMENT be tested
 * independently of the grant path, which is its own set of tests.
 */
const scopedKey = async (h: Harness, scopes: readonly string[] | null) => {
  const res = await h.app.request(url("key.create"), jsonReq("POST", { name: "scoped" }), {});
  expect(res.status).toBe(201);
  const { key, plaintext } = (await res.json()) as { key: { id: string }; plaintext: string };
  const row = h.db.apiKeys.find((r) => r["id"] === key.id)!;
  row["scopes"] = scopes === null ? null : JSON.stringify(scopes);
  return plaintext;
};

const withKey = (plaintext: string) => ({ headers: { Authorization: `Bearer ${plaintext}` } });

describe("scoped API keys", () => {
  it("lets a board-scoped key read boards", async () => {
    const h = makeHarness();
    await createBoard(h);
    const key = await scopedKey(h, ["board:*:read"]);

    const res = await h.app.request(url("board.list"), withKey(key), {});

    expect(res.status).toBe(200);
  });

  it("refuses the same key a route in another domain", async () => {
    // GET /notifications/config is notify:read. A board scope says nothing
    // about it, and additivity is WITHIN a domain only.
    const h = makeHarness();
    await createBoard(h);
    const key = await scopedKey(h, ["board:*:read"]);

    const res = await h.app.request(url("notifications.config.get"), withKey(key), {});

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("forbidden");
    // Prose, never a bare slug — `reasonFor` reads slugs as codes.
    expect(body.reason).toContain("notify:read");
  });

  it("refuses a read-only key a write on the domain it does hold", async () => {
    const h = makeHarness();
    await createBoard(h);
    const key = await scopedKey(h, ["board:*:read"]);

    const res = await h.app.request(
      url("issue.create", { slug: "kb" }),
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "should not land" }),
      },
      {},
    );

    expect(res.status).toBe(403);
    expect(h.db.issues).toHaveLength(0);
  });

  it("is ADDITIVE along the ladder: a write scope satisfies a read requirement", async () => {
    // The property that would break if scopes were exact-match. It is the one
    // most likely to be "simplified" later by someone who reads exact-match as
    // the safer default, so it is pinned.
    const h = makeHarness();
    await createBoard(h);
    const key = await scopedKey(h, ["board:*:write"]);

    const res = await h.app.request(url("board.list"), withKey(key), {});

    expect(res.status).toBe(200);
  });

  it("leaves a legacy key (scopes NULL) with full owner authority", async () => {
    // The backward-compat guarantee, byte-for-byte pre-EFB-100 behaviour.
    // Every key minted before the migration lands here.
    const h = makeHarness();
    await createBoard(h);
    const key = await scopedKey(h, null);

    expect((await h.app.request(url("board.list"), withKey(key), {})).status).toBe(200);
    expect((await h.app.request(url("notifications.config.get"), withKey(key), {})).status).toBe(200);
  });

  it("treats an explicit owner grant exactly like a legacy key", async () => {
    const h = makeHarness();
    await createBoard(h);
    const key = await scopedKey(h, ["owner"]);

    expect((await h.app.request(url("board.list"), withKey(key), {})).status).toBe(200);
    expect((await h.app.request(url("notifications.config.get"), withKey(key), {})).status).toBe(200);
  });

  it("still refuses the keys surface to a key holding owner", async () => {
    // Decision 5: no scope reaches the key surface, not even `owner`. The
    // pre-existing rejectKeyCallers guard answers first — scopes are a SECOND
    // gate and never loosen an existing one.
    const h = makeHarness();
    const key = await scopedKey(h, ["owner"]);

    const res = await h.app.request(url("key.list"), withKey(key), {});

    expect(res.status).toBe(403);
  });

  // EFB-99 + EFB-100 INTERACTION. Rotation MINTS a row, and a mint that does
  // not carry the parent's scopes forward writes NULL — which this ticket
  // defines as "minted before scoping", i.e. FULL OWNER AUTHORITY. Rotating a
  // read-only key would then hand back a key that can do anything, through a
  // flow whose entire promise is that nothing changes but the secret. Neither
  // ticket could see this alone: rotation shipped before scopes existed, and
  // scopes arrived after rotation had merged.
  it("carries scopes across a rotation — the successor is capped by its parent", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request(url("key.create"), jsonReq("POST", { name: "narrow" }), {});
    const { key } = (await res.json()) as { key: { id: string } };
    const row = h.db.apiKeys.find((r) => r["id"] === key.id)!;
    row["scopes"] = JSON.stringify(["board:*:read"]);

    const rotated = await h.app.request(
      url("key.rotate", { id: key.id }),
      jsonReq("POST", {}),
      {},
    );
    expect(rotated.status).toBe(201);
    const { plaintext } = (await rotated.json()) as { plaintext: string };

    // The successor reads boards, exactly like its parent...
    expect((await h.app.request(url("board.list"), withKey(plaintext), {})).status).toBe(200);
    // ...and is refused everything the parent was refused. Without the
    // carry-forward this is a 200 and the rotation silently granted the world.
    expect(
      (await h.app.request(url("notifications.config.get"), withKey(plaintext), {})).status,
    ).toBe(403);
  });

  // ── the INSTANCE half, enforced in authorizeBoard ──────────────────────
  //
  // The middleware settles whether a key may touch boards AT ALL; it cannot
  // settle WHICH board, because half the board surface addresses rows rather
  // than boards and at request time there is no slug to compare. So this half
  // lives in authorizeBoard, where the board has been resolved. These two
  // tests are what prove the second funnel exists: without it, a key scoped to
  // one board reads every board the owner has, and the middleware is perfectly
  // happy about it because the DOMAIN is right.
  it("lets a board-scoped key read the board it names", async () => {
    const h = makeHarness();
    await createBoard(h, "mine");
    const key = await scopedKey(h, ["board:mine:read"]);

    const res = await h.app.request(url("board.get", { slug: "mine" }), withKey(key), {});

    expect(res.status).toBe(200);
  });

  it("refuses that same key a DIFFERENT board — the instance half", async () => {
    const h = makeHarness();
    await createBoard(h, "mine");
    await createBoard(h, "theirs");
    const key = await scopedKey(h, ["board:mine:read"]);

    const res = await h.app.request(url("board.get", { slug: "theirs" }), withKey(key), {});

    expect(res.status).toBe(403);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toContain("theirs");
  });

  // THE CASE DECISION 6 EXISTS FOR, and the one the tests above do NOT reach.
  //
  // `/issue/:id` names a row, not a board. At middleware time there is no slug
  // to compare, so the instance check has to happen after the issue's board is
  // resolved — inside authorizeBoard, via authorizeBoardById. The by-slug
  // tests above travel a DIFFERENT branch of resolveBoardScope entirely, which
  // is how I discovered they left authorizeBoard's own check unexercised:
  // deleting it reddened nothing. These two are what hold it.
  it("refuses an id-addressed route whose board the key does not cover", async () => {
    const h = makeHarness();
    await createBoard(h, "mine");
    const issue = await createIssue(h, {}, "mine");
    const key = await scopedKey(h, ["board:elsewhere:read"]);

    const res = await h.app.request(url("issue.get", { id: issue.id }), withKey(key), {});

    expect(res.status).toBe(403);
  });

  it("allows the same id-addressed route when the key does cover that board", async () => {
    const h = makeHarness();
    await createBoard(h, "mine");
    const issue = await createIssue(h, {}, "mine");
    const key = await scopedKey(h, ["board:mine:read"]);

    const res = await h.app.request(url("issue.get", { id: issue.id }), withKey(key), {});

    expect(res.status).toBe(200);
  });

  it("a wildcard board scope covers a board created after the key was minted", async () => {
    // `*` means "including ones you make later", which is the surprising half
    // of the wildcard and the reason the UI has to say so out loud.
    const h = makeHarness();
    const key = await scopedKey(h, ["board:*:read"]);
    await createBoard(h, "made-later");

    const res = await h.app.request(url("board.get", { slug: "made-later" }), withKey(key), {});

    expect(res.status).toBe(200);
  });

  // ── the grant side ─────────────────────────────────────────────────────

  it("refuses a create that asks for the keys domain, and says why", async () => {
    // Decision 5 from the grant direction. The enforcement side already
    // refuses; this is the half that stops the scope existing at all.
    const h = makeHarness();

    const res = await h.app.request(
      url("key.create"),
      jsonReq("POST", { name: "sneaky", scopes: ["keys:admin"] }),
      {},
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { reason: string };
    // Prose that explains the refusal — someone asking for this is trying to
    // do something the API will never allow and deserves to know why.
    expect(body.reason).toContain("not grantable");
    expect(h.db.apiKeys).toHaveLength(0);
  });

  it("refuses a scope string it does not understand", async () => {
    const h = makeHarness();
    const res = await h.app.request(
      url("key.create"),
      jsonReq("POST", { name: "typo", scopes: ["board:read"] }),
      {},
    );
    expect(res.status).toBe(400);
    expect(h.db.apiKeys).toHaveLength(0);
  });

  it("never stores NULL scopes on a freshly minted key — NULL is legacy-only", async () => {
    // The ratchet. NULL means "minted before scoping" and grants everything;
    // if a mint path can produce it, that permanently fail-open default is
    // back. `SELECT COUNT(*) WHERE scopes IS NULL` has to be able to reach
    // zero and stay there.
    const h = makeHarness();

    await h.app.request(url("key.create"), jsonReq("POST", { name: "default" }), {});
    await h.app.request(
      url("key.create"),
      jsonReq("POST", { name: "narrow", scopes: ["board:*:read"] }),
      {},
    );

    expect(h.db.apiKeys).toHaveLength(2);
    for (const row of h.db.apiKeys) expect(row["scopes"]).not.toBeNull();
    // The default is full authority, STATED.
    expect(JSON.parse(String(h.db.apiKeys[0]!["scopes"]))).toEqual(["owner"]);
  });

  it("fails CLOSED on a route the manifest does not declare", async () => {
    // The property that makes the manifest a perimeter rather than a
    // description: a route registered outside it cannot be reached by a
    // scoped key, because nothing can say what reaching it would require.
    const h = makeHarness();
    // Registered BEFORE the first request: Hono freezes its matcher once it
    // has routed anything.
    h.app.get("/api/v0/undeclared", (c) => c.json({ reached: true }));
    const key = await scopedKey(h, ["board:*:read"]);

    const res = await h.app.request("/api/v0/undeclared", withKey(key), {});

    expect(res.status).toBe(403);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toContain("not declared in the API manifest");
  });

  it("grants a JWT caller everything, unchanged — nothing narrows a session", async () => {
    const h = makeHarness();
    await createBoard(h);

    expect((await h.app.request(url("board.list"), jsonReq("GET"), {})).status).toBe(200);
    expect((await h.app.request(url("notifications.config.get"), jsonReq("GET"), {})).status).toBe(200);
  });
});
