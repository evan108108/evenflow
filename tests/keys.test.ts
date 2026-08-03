// Phase 19: developer API keys — mint/list/revoke, the evk_ auth path on
// REST and MCP, hash-only storage, the last_used throttle, and the
// keys-can't-manage-keys guard.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  const res = await h.app.request("/api/v0/keys", jsonReq("POST", { name }), {});
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
    const bad = await h.app.request("/api/v0/keys", jsonReq("POST", { name: "  " }), {});
    expect(bad.status).toBe(400);
    const anon = await h.app.request("/api/v0/keys", {
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
    const res = await h.app.request("/api/v0/keys", { headers: jsonReq("GET").headers }, {});
    expect(res.status).toBe(200);
    const { keys } = (await res.json()) as { keys: KeyView[] };
    expect(keys.map((k) => k.name)).toEqual(["second", "first"]);
    expect(Object.keys(keys[0]!)).not.toContain("key_hash");
  });

  it("soft-revokes; revoking twice stays 200; foreign keys 404", async () => {
    const h = makeHarness();
    const { key } = await mintKey(h);
    const res = await h.app.request(`/api/v0/keys/${key.id}`, jsonReq("DELETE"), {});
    expect(res.status).toBe(200);
    expect(h.db.apiKeys[0]!["revoked_at_ms"]).toBe(1_000_000);
    const again = await h.app.request(`/api/v0/keys/${key.id}`, jsonReq("DELETE"), {});
    expect(again.status).toBe(200);
    const foreign = await h.app.request(`/api/v0/keys/${key.id}`, jsonReq("DELETE", undefined, "tok-stranger"), {});
    expect(foreign.status).toBe(404);
  });
});

describe("evk_ bearer auth", () => {
  it("authenticates REST requests as the key's owner", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { plaintext } = await mintKey(h);
    const res = await h.app.request("/api/v0/boards", evkReq(plaintext), {});
    expect(res.status).toBe(200);
    const { boards } = (await res.json()) as { boards: Array<{ slug: string }> };
    expect(boards.map((b) => b.slug)).toEqual(["kb"]);
  });

  it("writes work too, and audit rows carry the key name as actor", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { plaintext } = await mintKey(h, "automation");
    const res = await h.app.request(
      "/api/v0/boards/kb/issues",
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
    const unknown = await h.app.request("/api/v0/boards", evkReq("evk_nope_nope_nope_nope_nope_nope_nope_nope"), {});
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as { reason: string }).reason).toBe("invalid-api-key");

    await h.app.request(`/api/v0/keys/${key.id}`, jsonReq("DELETE"), {});
    const revoked = await h.app.request("/api/v0/boards", evkReq(plaintext), {});
    expect(revoked.status).toBe(401);
    expect(((await revoked.json()) as { reason: string }).reason).toBe("invalid-api-key");
  });

  it("a key cannot mint, list, or revoke keys", async () => {
    const h = makeHarness();
    const { key, plaintext } = await mintKey(h);
    const mint = await h.app.request("/api/v0/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${plaintext}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "escalation" }),
    }, {});
    expect(mint.status).toBe(403);
    const list = await h.app.request("/api/v0/keys", evkReq(plaintext), {});
    expect(list.status).toBe(403);
    const revoke = await h.app.request(`/api/v0/keys/${key.id}`, { method: "DELETE", ...evkReq(plaintext) }, {});
    expect(revoke.status).toBe(403);
  });

  it("bumps last_used_at_ms at most once per minute", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { plaintext } = await mintKey(h);
    await h.app.request("/api/v0/boards", evkReq(plaintext), {});
    expect(h.db.apiKeys[0]!["last_used_at_ms"]).toBe(1_000_000);

    vi.setSystemTime(1_030_000); // +30s → throttled
    await h.app.request("/api/v0/boards", evkReq(plaintext), {});
    expect(h.db.apiKeys[0]!["last_used_at_ms"]).toBe(1_000_000);

    vi.setSystemTime(1_070_000); // +70s → bumps
    await h.app.request("/api/v0/boards", evkReq(plaintext), {});
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
    const issueRes = await h.app.request("/api/v0/boards/kb/issues", jsonReq("POST", { title: "Full" }), {});
    const { issue } = (await issueRes.json()) as { issue: { id: string } };
    await h.app.request(`/api/v0/issues/${issue.id}/comments`, jsonReq("POST", { body: "hi" }), {});
    await h.app.request(
      `/api/v0/boards/kb/issues/${issue.id}/attachments`,
      // image/* because this board is on default storage, which takes images
      // only (EFB-80); the type is incidental — the test just wants a row.
      jsonReq("POST", { file_b64: "aGk=", filename: "hi.png", content_type: "image/png" }),
      {},
    );
    const res = await h.app.request(
      `/api/v0/issues/${issue.id}?include=comments,attachments`,
      { headers: jsonReq("GET").headers },
      {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issue: object; comments: Array<{ body: string }>; attachments: Array<{ filename: string }> };
    expect(body.comments.map((c) => c.body)).toEqual(["hi"]);
    expect(body.attachments.map((a) => a.filename)).toEqual(["hi.png"]);

    const plain = await h.app.request(`/api/v0/issues/${issue.id}`, { headers: jsonReq("GET").headers }, {});
    const plainBody = (await plain.json()) as Record<string, unknown>;
    expect(plainBody["comments"]).toBeUndefined();

    const bad = await h.app.request(`/api/v0/issues/${issue.id}?include=secrets`, { headers: jsonReq("GET").headers }, {});
    expect(bad.status).toBe(400);
  });
});
