// Phase 19: developer API keys — mint/list/revoke, the evk_ auth path on
// REST and MCP, hash-only storage, the last_used throttle, and the
// keys-can't-manage-keys guard.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { url } from "../src/routes-manifest";
import { API_KEY_DISPLAY_PREFIX_LEN, API_KEY_PREFIX } from "../src/apikeys";
import { CALLER, createBoard, jsonReq, makeHarness, type Harness } from "./harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

interface KeyView {
  id: string;
  name: string;
  prefix: string;
  created_at_ms: number;
  last_used_at_ms: number | null;
  revoked_at_ms: number | null;
}

const mintKey = async (h: Harness, name = "CI bot") => {
  const res = await h.app.request(url("key.create"), jsonReq("POST", { name }), {});
  expect(res.status).toBe(201);
  return (await res.json()) as { key: KeyView; plaintext: string };
};

const evkReq = (plaintext: string) => ({ headers: { Authorization: `Bearer ${plaintext}` } });

describe("POST /api/v0/keys", () => {
  it("mints evk_ keys, returning the plaintext exactly once", async () => {
    const h = makeHarness();
    const { key, plaintext } = await mintKey(h);
    expect(plaintext.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(plaintext.length).toBeGreaterThan(40);
    expect(key.prefix).toBe(plaintext.slice(0, API_KEY_DISPLAY_PREFIX_LEN));
    expect(key).toMatchObject({ name: "CI bot", created_at_ms: 1_000_000, last_used_at_ms: null, revoked_at_ms: null });
    // Storage holds the hash, never the plaintext.
    const row = h.db.apiKeys[0]!;
    expect(row["pubkey"]).toBe(CALLER);
    expect(row["key_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(h.db.apiKeys)).not.toContain(plaintext.slice(API_KEY_DISPLAY_PREFIX_LEN));
  });

  it("validates the name and requires auth", async () => {
    const h = makeHarness();
    const bad = await h.app.request(url("key.create"), jsonReq("POST", { name: "  " }), {});
    expect(bad.status).toBe(400);
    const anon = await h.app.request(url("key.create"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    }, {});
    expect(anon.status).toBe(401);
  });
});

describe("GET /api/v0/keys + DELETE", () => {
  it("lists the caller's keys newest-first, metadata only", async () => {
    const h = makeHarness();
    await mintKey(h, "first");
    vi.setSystemTime(2_000_000);
    await mintKey(h, "second");
    const res = await h.app.request(url("key.list"), { headers: jsonReq("GET").headers }, {});
    expect(res.status).toBe(200);
    const { keys } = (await res.json()) as { keys: KeyView[] };
    expect(keys.map((k) => k.name)).toEqual(["second", "first"]);
    expect(Object.keys(keys[0]!)).not.toContain("key_hash");
  });

  it("soft-revokes; revoking twice stays 200; foreign keys 404", async () => {
    const h = makeHarness();
    const { key } = await mintKey(h);
    const res = await h.app.request(url("key.delete", { id: key.id }), jsonReq("DELETE"), {});
    expect(res.status).toBe(200);
    expect(h.db.apiKeys[0]!["revoked_at_ms"]).toBe(1_000_000);
    const again = await h.app.request(url("key.delete", { id: key.id }), jsonReq("DELETE"), {});
    expect(again.status).toBe(200);
    const foreign = await h.app.request(url("key.delete", { id: key.id }), jsonReq("DELETE", undefined, "tok-stranger"), {});
    expect(foreign.status).toBe(404);
  });
});

describe("evk_ bearer auth", () => {
  it("authenticates REST requests as the key's owner", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { plaintext } = await mintKey(h);
    const res = await h.app.request(url("board.create"), evkReq(plaintext), {});
    expect(res.status).toBe(200);
    const { boards } = (await res.json()) as { boards: Array<{ slug: string }> };
    expect(boards.map((b) => b.slug)).toEqual(["kb"]);
  });

  it("writes work too, and audit rows carry the key name as actor", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { plaintext } = await mintKey(h, "automation");
    const res = await h.app.request(
      url("issue.create", { slug: "kb" }),
      {
        method: "POST",
        headers: { Authorization: `Bearer ${plaintext}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Via key" }),
      },
      {},
    );
    expect(res.status).toBe(201);
    expect(h.audit.events.some((e) => e.event_type === "issue_created" && e.actor === "key:automation")).toBe(true);
  });

  it("rejects unknown and revoked keys with the same 401 reason", async () => {
    const h = makeHarness();
    const { key, plaintext } = await mintKey(h);
    const unknown = await h.app.request(url("board.create"), evkReq("evk_nope_nope_nope_nope_nope_nope_nope_nope"), {});
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as { reason: string }).reason).toBe("invalid-api-key");

    await h.app.request(url("key.delete", { id: key.id }), jsonReq("DELETE"), {});
    const revoked = await h.app.request(url("board.create"), evkReq(plaintext), {});
    expect(revoked.status).toBe(401);
    expect(((await revoked.json()) as { reason: string }).reason).toBe("invalid-api-key");
  });

  it("a key cannot mint, list, or revoke keys", async () => {
    const h = makeHarness();
    const { key, plaintext } = await mintKey(h);
    const mint = await h.app.request(url("key.create"), {
      method: "POST",
      headers: { Authorization: `Bearer ${plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "escalation" }),
    }, {});
    expect(mint.status).toBe(403);
    const list = await h.app.request(url("key.list"), evkReq(plaintext), {});
    expect(list.status).toBe(403);
    const revoke = await h.app.request(url("key.delete", { id: key.id }), { method: "DELETE", ...evkReq(plaintext) }, {});
    expect(revoke.status).toBe(403);
  });

  it("bumps last_used_at_ms at most once per minute", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { plaintext } = await mintKey(h);
    await h.app.request(url("board.create"), evkReq(plaintext), {});
    expect(h.db.apiKeys[0]!["last_used_at_ms"]).toBe(1_000_000);

    vi.setSystemTime(1_030_000); // +30s → throttled
    await h.app.request(url("board.create"), evkReq(plaintext), {});
    expect(h.db.apiKeys[0]!["last_used_at_ms"]).toBe(1_000_000);

    vi.setSystemTime(1_070_000); // +70s → bumps
    await h.app.request(url("board.create"), evkReq(plaintext), {});
    expect(h.db.apiKeys[0]!["last_used_at_ms"]).toBe(1_070_000);
  });

  it("authenticates MCP tools/call", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { plaintext } = await mintKey(h);
    const res = await h.app.request(
      "/mcp",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${plaintext}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "kanban_board_list", arguments: {} },
        }),
      },
      {},
    );
    expect(res.status).toBe(200);
    const rpc = (await res.json()) as { result?: { structuredContent: { boards: unknown[] } }; error?: unknown };
    expect(rpc.error).toBeUndefined();
    expect(rpc.result!.structuredContent.boards).toHaveLength(1);
  });
});

describe("GET /issues/:id?include=", () => {
  it("expands comments + attachments in one response (the MCP shape)", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issueRes = await h.app.request(url("issue.create", { slug: "kb" }), jsonReq("POST", { title: "Full" }), {});
    const { issue } = (await issueRes.json()) as { issue: { id: string } };
    await h.app.request(url("comment.create", { id: issue.id }), jsonReq("POST", { body: "hi" }), {});
    await h.app.request(
      url("attachment.create", { slug: "kb", issue_ref: issue.id }),
      // image/* because this board is on default storage, which takes images
      // only (EFB-80); the type is incidental — the test just wants a row.
      jsonReq("POST", { file_b64: "aGk=", filename: "hi.png", content_type: "image/png" }),
      {},
    );
    const res = await h.app.request(
      `${url("issue.get", { id: issue.id })}?include=comments,attachments`,
      { headers: jsonReq("GET").headers },
      {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issue: object; comments: Array<{ body: string }>; attachments: Array<{ filename: string }> };
    expect(body.comments.map((c) => c.body)).toEqual(["hi"]);
    expect(body.attachments.map((a) => a.filename)).toEqual(["hi.png"]);

    const plain = await h.app.request(url("issue.get", { id: issue.id }), { headers: jsonReq("GET").headers }, {});
    const plainBody = (await plain.json()) as Record<string, unknown>;
    expect(plainBody["comments"]).toBeUndefined();

    const bad = await h.app.request(`${url("issue.get", { id: issue.id })}?include=secrets`, { headers: jsonReq("GET").headers }, {});
    expect(bad.status).toBe(400);
  });
});

// ── EFB-99: rotation ──────────────────────────────────────────────────────
//
// Rotation replaces a key's SECRET without changing who it authenticates as.
// The interesting properties are all about what stays the same (owner, claims,
// name, audit actor) and what stops (the old secret, eventually) — so these
// assert equivalence and expiry, not just that a new string came back.

interface RotatedKeyView extends KeyView {
  rotated_at_ms: number | null;
  rotated_to_id: string | null;
}

/** Default caller is the JWT session; pass a token to rotate AS that bearer. */
const rotateKeyReq = (h: Harness, id: string, token?: string) =>
  h.app.request(url("key.rotate", { id }), jsonReq("POST", undefined, token), {});

const listKeys = async (h: Harness) => {
  const res = await h.app.request(url("key.list"), { headers: jsonReq("GET").headers }, {});
  expect(res.status).toBe(200);
  return ((await res.json()) as { keys: RotatedKeyView[] }).keys;
};

const GRACE_MS = 24 * 60 * 60 * 1000;

describe("POST /api/v0/key/:id/rotate", () => {
  it("mints a new secret for the same owner, inheriting the name", async () => {
    const h = makeHarness();
    const first = await mintKey(h, "deploy-bot");

    const res = await rotateKeyReq(h, first.key.id);
    expect(res.status).toBe(201);
    const second = (await res.json()) as { key: RotatedKeyView; plaintext: string };

    // A genuinely different secret, not a re-issue of the same one.
    expect(second.plaintext).not.toBe(first.plaintext);
    expect(second.key.prefix).not.toBe(first.key.prefix);
    expect(second.key.id).not.toBe(first.key.id);
    // The name is INHERITED, not re-supplied. Asserted against the STORED
    // row, not just the response: the response echoes `row.name` and would
    // keep reading "deploy-bot" even if a different string were written to
    // the table. The stored value is the one that matters, because
    // claimsForApiKey reads it back to synthesize `login`.
    expect(second.key.name).toBe("deploy-bot");
    const storedSuccessor = h.db.apiKeys.find((r) => r["id"] === second.key.id)!;
    expect(storedSuccessor["name"]).toBe("deploy-bot");
    // Same owner — the property that makes this a rotation rather than a
    // new key that happens to exist.
    expect(h.db.apiKeys.every((r) => r["pubkey"] === CALLER)).toBe(true);
    // Storage still never holds a plaintext.
    expect(JSON.stringify(h.db.apiKeys)).not.toContain(
      second.plaintext.slice(API_KEY_DISPLAY_PREFIX_LEN),
    );

    // The predecessor is marked, and points at its successor.
    const keys = await listKeys(h);
    const old = keys.find((k) => k.id === first.key.id)!;
    expect(old.rotated_at_ms).toBe(1_000_000);
    expect(old.rotated_to_id).toBe(second.key.id);
    // The successor is not itself rotated.
    expect(keys.find((k) => k.id === second.key.id)!.rotated_at_ms).toBeNull();
    expect(h.audit.events.some((e) => e.event_type === "api_key_rotated")).toBe(true);
  });

  it("keeps the audit actor identical across the rotation boundary", async () => {
    // The consequence of name-inheritance, stated as behaviour rather than as
    // a field comparison. claimsForApiKey synthesizes `login` as `key:<name>`,
    // so if a rotation renamed the key, every audit row written after it would
    // attribute to a different actor than every row before it — the trail
    // would silently fork mid-incident, which is exactly when someone is
    // reading it.
    const h = makeHarness();
    await createBoard(h);
    const first = await mintKey(h, "automation");
    const res = await rotateKeyReq(h, first.key.id);
    const second = (await res.json()) as { key: RotatedKeyView; plaintext: string };

    const write = await h.app.request(
      url("issue.create", { slug: "kb" }),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${second.plaintext}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Via the rotated key" }),
      },
      {},
    );
    expect(write.status).toBe(201);
    expect(
      h.audit.events.some((e) => e.event_type === "issue_created" && e.actor === "key:automation"),
    ).toBe(true);
    // And nothing attributed to a renamed variant.
    expect(h.audit.events.every((e) => !String(e.actor ?? "").includes("rotated"))).toBe(true);
  });

  it("keeps BOTH keys authenticating during the grace window", async () => {
    const h = makeHarness();
    const first = await mintKey(h);
    const res = await rotateKeyReq(h, first.key.id);
    const second = (await res.json()) as { key: RotatedKeyView; plaintext: string };

    // Immediately after rotation.
    expect((await h.app.request(url("board.list"), evkReq(first.plaintext), {})).status).toBe(200);
    expect((await h.app.request(url("board.list"), evkReq(second.plaintext), {})).status).toBe(200);

    // One minute inside the window's far edge — still both.
    vi.setSystemTime(1_000_000 + GRACE_MS - 60_000);
    expect((await h.app.request(url("board.list"), evkReq(first.plaintext), {})).status).toBe(200);
    expect((await h.app.request(url("board.list"), evkReq(second.plaintext), {})).status).toBe(200);
  });

  it("refuses the rotated key past the grace window, and revokes it on the way", async () => {
    const h = makeHarness();
    const first = await mintKey(h);
    const res = await rotateKeyReq(h, first.key.id);
    const second = (await res.json()) as { key: RotatedKeyView; plaintext: string };

    vi.setSystemTime(1_000_000 + GRACE_MS + 1);
    const stale = await h.app.request(url("board.list"), evkReq(first.plaintext), {});
    expect(stale.status).toBe(401);
    // The successor is unaffected — expiry is a property of the ROTATED row,
    // not of the prefix or the owner.
    expect((await h.app.request(url("board.list"), evkReq(second.plaintext), {})).status).toBe(200);

    // The revoke is bookkeeping DOWNSTREAM of the refusal: the request was
    // already rejected on the grace predicate, and the write records it.
    const old = h.db.apiKeys.find((r) => r["id"] === first.key.id)!;
    expect(old["revoked_at_ms"]).not.toBeNull();
  });

  it("answers a past-grace key the SAME 401 reason as a key that never existed", async () => {
    // Probing must not distinguish "rotated" / "revoked" / "never existed" —
    // a truer message would confirm the prefix once existed AND that its
    // owner is actively managing it.
    const h = makeHarness();
    const first = await mintKey(h);
    await rotateKeyReq(h, first.key.id);
    vi.setSystemTime(1_000_000 + GRACE_MS + 1);

    const stale = await h.app.request(url("board.list"), evkReq(first.plaintext), {});
    const garbage = await h.app.request(
      url("board.list"),
      evkReq(`${API_KEY_PREFIX}${"z".repeat(43)}`),
      {},
    );
    expect(stale.status).toBe(garbage.status);
    expect(((await stale.json()) as { reason: string }).reason).toBe("invalid-api-key");
    expect(((await garbage.json()) as { reason: string }).reason).toBe("invalid-api-key");
  });

  it("is JWT-only — an evk_ caller cannot rotate, not even its own key", async () => {
    // THE load-bearing guard. Rotation MINTS, so a key-callable rotate would
    // make a leaked key permanent: rotate, take the fresh plaintext, and the
    // owner revoking the key they know about leaves the child alive.
    const h = makeHarness();
    const { key, plaintext } = await mintKey(h);

    const res = await rotateKeyReq(h, key.id, plaintext);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toBe("jwt-required");
    // Nothing was minted.
    expect(h.db.apiKeys).toHaveLength(1);
  });

  it("refuses to rotate a key that is already rotated, or revoked", async () => {
    const h = makeHarness();
    const first = await mintKey(h);
    await rotateKeyReq(h, first.key.id);

    // Already rotated — a second successor would fork the chain and make
    // "replaced by" a two-valued answer.
    const again = await rotateKeyReq(h, first.key.id);
    expect(again.status).toBe(400);
    expect(((await again.json()) as { reason: string }).reason).toBe("already-rotated");

    const revoked = await mintKey(h, "doomed");
    await h.app.request(url("key.delete", { id: revoked.key.id }), jsonReq("DELETE"), {});
    const dead = await rotateKeyReq(h, revoked.key.id);
    expect(dead.status).toBe(400);
    expect(((await dead.json()) as { reason: string }).reason).toBe("already-revoked");
  });

  it("404s a key belonging to somebody else, indistinguishably from a missing one", async () => {
    const h = makeHarness();
    const { key } = await mintKey(h);
    // Re-owned behind the caller's back; the lookup is scoped by pubkey.
    h.db.apiKeys.find((r) => r["id"] === key.id)!["pubkey"] = "github:999999";

    const res = await rotateKeyReq(h, key.id);
    expect(res.status).toBe(404);
    const missing = await rotateKeyReq(h, "no-such-key-id");
    expect(missing.status).toBe(404);
  });
});

// ── EFB-99: the migration cannot quietly revoke every existing key ────────
//
// migration 0029 adds rotated_at_ms as NULLABLE WITH NO DEFAULT, so every row
// already in the table reads "never rotated" by construction and no backfill
// is needed. The tempting alternative — `INTEGER NOT NULL DEFAULT 0` — is a
// production incident with a plausible-looking diff: every pre-existing key
// would read rotated_at_ms = 0, the grace check would compute
// `now - 0 > 24h` as true for all of them, and the first authenticated
// request each one made after deploy would revoke it. A whole customer base
// re-keying at once, from a migration that ran without error.
//
// The file assertion is here because that failure is unreachable through the
// db mock: the mock never executes DDL, so nothing else in this suite reads
// the migration at all.

describe("EFB-99 migration 0029", () => {
  const sql = readFileSync("migrations/0029_apikey_rotation.sql", "utf8");
  const statements = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join(" ");

  it("adds both columns nullable, with no NOT NULL and no DEFAULT", () => {
    expect(statements).toMatch(/ALTER TABLE apiKeys ADD COLUMN rotated_at_ms INTEGER\s*;/);
    expect(statements).toMatch(/ALTER TABLE apiKeys ADD COLUMN rotated_to_id TEXT\s*;/);
    // The two words that would turn this migration into a mass revocation.
    expect(statements).not.toMatch(/NOT NULL/i);
    expect(statements).not.toMatch(/DEFAULT/i);
  });

  it("leaves a pre-migration key authenticating untouched", async () => {
    // The behavioural half: a row carrying the post-migration default for an
    // untouched key (rotated_at_ms NULL) authenticates exactly as before.
    const h = makeHarness();
    const { plaintext } = await mintKey(h);
    expect(h.db.apiKeys[0]!["rotated_at_ms"]).toBeNull();
    vi.setSystemTime(1_000_000 + GRACE_MS * 10);
    expect((await h.app.request(url("board.list"), evkReq(plaintext), {})).status).toBe(200);
  });
});
