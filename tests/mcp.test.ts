import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_PROTOCOL_VERSION, MCP_TOOLS } from "../src/routes/mcp";
import { bearer, createBoard, createIssue, makeHarness, type Harness } from "./harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  vi.useRealTimers();
});

interface RpcEnvelope {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

const rpc = async (h: Harness, payload: unknown, withAuth = true) => {
  const res = await h.app.request(
    "/mcp",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(withAuth ? bearer : {}) },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    },
    {},
  );
  return { res, body: (await res.json()) as RpcEnvelope };
};

const call = (h: Harness, name: string, args: Record<string, unknown> = {}, withAuth = true) =>
  rpc(h, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, withAuth);

const structured = (body: RpcEnvelope) =>
  (body.result as { structuredContent: Record<string, unknown> }).structuredContent;

describe("POST /mcp protocol methods", () => {
  it("initialize returns the capabilities envelope", async () => {
    const h = makeHarness();
    const { body } = await rpc(h, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: "evenflow", version: "0.1.0" },
        capabilities: { tools: {} },
      },
    });
  });

  it("tools/list enumerates all 17 tools, each with an object inputSchema", async () => {
    const h = makeHarness();
    const { body } = await rpc(h, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (body.result as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools).toHaveLength(17);
    expect(tools.map((t) => t["name"])).toEqual(MCP_TOOLS.map((t) => t.name));
    for (const tool of tools) {
      expect(typeof tool["description"]).toBe("string");
      const schema = tool["inputSchema"] as Record<string, unknown>;
      expect(schema["type"]).toBe("object");
      expect(typeof schema["properties"]).toBe("object");
    }
  });

  it("answers ping, rejects unknown methods, notifications get 202", async () => {
    const h = makeHarness();
    expect((await rpc(h, { jsonrpc: "2.0", id: 3, method: "ping" })).body.result).toEqual({});
    expect(
      (await rpc(h, { jsonrpc: "2.0", id: 4, method: "resources/list" })).body.error?.code,
    ).toBe(-32601);
    const notif = await h.app.request(
      "/mcp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      },
      {},
    );
    expect(notif.status).toBe(202);
  });

  it("rejects malformed JSON (-32700) and batch arrays (-32600)", async () => {
    const h = makeHarness();
    const bad = await rpc(h, "{not json");
    expect(bad.res.status).toBe(400);
    expect(bad.body.error?.code).toBe(-32700);
    const batch = await rpc(h, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(batch.body.error?.code).toBe(-32600);
  });

  it("GET /mcp is 405 (POST-only transport)", async () => {
    const h = makeHarness();
    expect((await h.app.request("/mcp", {}, {})).status).toBe(405);
  });
});

describe("tools/call", () => {
  it("kanban_board_create returns the board in structuredContent and content text", async () => {
    const h = makeHarness();
    const { body } = await call(h, "kanban_board_create", { slug: "kb", title: "Board" });
    expect(body.error).toBeUndefined();
    const result = body.result as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { board: Record<string, unknown> };
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(result.structuredContent.board).toMatchObject({ slug: "kb", title: "Board" });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    expect(h.db.boards).toHaveLength(1);
  });

  it("unknown tool name → -32601", async () => {
    const h = makeHarness();
    const { body } = await call(h, "kanban_sprint_start");
    expect(body.error?.code).toBe(-32601);
  });

  it("missing auth → -32001 (JSON-RPC error, not HTTP 401)", async () => {
    const h = makeHarness();
    const { res, body } = await call(h, "kanban_board_list", {}, false);
    expect(res.status).toBe(200);
    expect(body.error?.code).toBe(-32001);
  });

  it("invalid input → -32602, unknown resource → -32004", async () => {
    const h = makeHarness();
    const noTitle = await call(h, "kanban_board_create", { slug: "kb" });
    expect(noTitle.body.error?.code).toBe(-32602);
    const missing = await call(h, "kanban_board_get", { slug: "nope" });
    expect(missing.body.error?.code).toBe(-32004);
    const badArg = await call(h, "kanban_board_get", {});
    expect(badArg.body.error?.code).toBe(-32602);
  });

  it("end-to-end: create + get via MCP match the REST shapes", async () => {
    const h = makeHarness();
    const created = await call(h, "kanban_board_create", { slug: "kb", title: "Board" });
    const got = await call(h, "kanban_board_get", { slug: "kb" });
    // GET decorates the board with org context + the caller's role.
    expect(structured(got.body)["board"]).toEqual(structured(created.body)["board"]);
    expect(structured(got.body)["role"]).toBe("owner");

    const rest = await h.app.request("/api/v0/boards/kb", { headers: bearer }, {});
    expect(await rest.json()).toEqual(structured(got.body));
  });

  it("issue lifecycle through MCP: create, transition, list, activity", async () => {
    const h = makeHarness();
    await createBoard(h);
    const created = await call(h, "kanban_issue_create", {
      board_slug: "kb",
      title: "Via MCP",
      labels: ["mcp"],
    });
    const issue = structured(created.body)["issue"] as { id: string; status: string };
    expect(issue.status).toBe("Todo");

    vi.setSystemTime(2_000);
    const moved = await call(h, "kanban_issue_transition", { id: issue.id, to_status: "Done" });
    expect((structured(moved.body)["issue"] as { status: string }).status).toBe("Done");

    const listed = await call(h, "kanban_issue_list", { board_slug: "kb", status: "Done" });
    expect((structured(listed.body)["issues"] as unknown[]).length).toBe(1);

    const activity = await call(h, "kanban_activity_read", { board_slug: "kb" });
    const items = structured(activity.body)["activity"] as Array<{ kind: string }>;
    expect(items.map((a) => a.kind)).toEqual(["status", "creation"]);

    // MCP writes ride the same emit path as REST.
    expect(h.emitter.events.map((e) => e.event.kind)).toEqual([
      "issue.created",
      "issue.transitioned",
    ]);
  });

  it("kanban_comment_post + kanban_comment_list round-trip", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const posted = await call(h, "kanban_comment_post", { issue_id: issue.id, body: "hi" });
    const comment = structured(posted.body)["comment"] as { id: string };
    const listed = await call(h, "kanban_comment_list", { issue_id: issue.id });
    expect((structured(listed.body)["comments"] as Array<{ id: string }>)[0]!.id).toBe(comment.id);
  });
});

describe("GET /.well-known/oauth-protected-resource", () => {
  it("serves the RFC 9728 metadata unauthenticated", async () => {
    const h = makeHarness();
    const res = await h.app.request("/.well-known/oauth-protected-resource", {}, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: "https://evenflow.work",
      authorization_servers: ["https://api.4a4.ai"],
      scopes_supported: ["publish"],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://evenflow.work",
    });
  });
});
