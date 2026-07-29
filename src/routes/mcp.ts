// /mcp — MCP server surface over the Streamable HTTP transport: one POST
// endpoint handling every JSON-RPC 2.0 method (initialize, tools/list,
// tools/call, ping, notifications).
//
// Every kanban_* tool is a thin wrapper over the existing REST surface: the
// router owns a private Hono app mounting the same routers index.ts mounts,
// and tools/call translates {name, arguments} into an internal /api/v0
// request (caller's Authorization header forwarded, so requireAuth +
// assertOwnBoard run unchanged). That keeps validation, authz, audit rows,
// and BoardDO fanout in exactly one place — REST and MCP cannot drift.
//
// Errors are JSON-RPC error responses (not isError tool results), mapped
// from the REST status: 400/409 → -32602, 401/403 → -32001, 404 → -32004,
// anything else → -32603. The REST error body rides along as error.data.
//
// initialize and tools/list are public (clients need them for discovery);
// tools/call hits requireAuth on the internal app, so a missing/bad JWT
// surfaces as -32001.

import { Hono } from "hono";
import type { Context } from "hono";
import { requireAuth } from "../middleware/requireAuth";
import { bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { makeBoardsRouter } from "./boards";
import { makeCommentsRouter } from "./comments";
import { makeFeedRouter } from "./feed";
import { makeIssuesRouter } from "./issues";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_INFO = { name: "evenflow", version: "0.1.0" } as const;

// ── JSON-RPC plumbing ─────────────────────────────────────────────────────

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const UNAUTHORIZED = -32001;
const NOT_FOUND = -32004;

class RpcError extends Error {
  constructor(
    readonly code: number,
    override readonly message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const codeForStatus = (status: number): number => {
  if (status === 401 || status === 403) return UNAUTHORIZED;
  if (status === 404) return NOT_FOUND;
  if (status === 400 || status === 409) return INVALID_PARAMS;
  return INTERNAL_ERROR;
};

// ── tool table ────────────────────────────────────────────────────────────

interface RestRequest {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
}

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly toRequest: (args: Record<string, unknown>) => RestRequest;
}

/** Require a string argument (path params must exist before dispatch). */
const str = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  if (typeof v !== "string" || v === "") {
    throw new RpcError(INVALID_PARAMS, `'${key}' must be a non-empty string`);
  }
  return v;
};

/** Subset of args to forward as a JSON body — absent keys stay absent. */
const pick = (args: Record<string, unknown>, keys: ReadonlyArray<string>) => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (args[k] !== undefined) out[k] = args[k];
  return out;
};

const schema = (
  properties: Record<string, unknown>,
  required: ReadonlyArray<string> = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

const PAGING = {
  limit: { type: "integer", minimum: 1, description: "Page size (server caps apply)" },
  after: { type: "string", description: "Keyset cursor: the id of the last item of the previous page" },
};

const CONTAINER = { type: "string", enum: ["icebox", "backlog", "active"] };

const ISSUE_TYPE = {
  type: "string",
  enum: ["task", "feature", "bug", "story", "improvement", "chore"],
  description: "Issue type (defaults to 'task')",
};

// Structured Column[] since phase 17; a bare string[] of names is still
// accepted and coerced server-side with inferred categories.
const COLUMNS = {
  type: "array",
  minItems: 1,
  items: { anyOf: [{ type: "string" }, { type: "object" }] },
  description:
    "Column[] of {id, name, order, enabled, category: todo|in_progress|in_review|done|blocked}, or a legacy string[] of names",
};

// Every issue-scoped tool takes either identifier form; the REST layer
// resolves both (src/slug.ts asShortId).
const ISSUE_REF = "Issue UUID or short id like FLOW-42 (case-insensitive)";

export const MCP_TOOLS: ReadonlyArray<ToolDef> = [
  {
    name: "kanban_board_list",
    description: "List the caller's kanban boards, newest-updated first.",
    inputSchema: schema({ ...PAGING }),
    toRequest: (a) => ({ method: "GET", path: "/api/v0/boards", query: pick(a, ["limit", "after"]) }),
  },
  {
    name: "kanban_board_get",
    description: "Fetch one of the caller's boards by slug.",
    inputSchema: schema({ slug: { type: "string" } }, ["slug"]),
    toRequest: (a) => ({ method: "GET", path: `/api/v0/boards/${encodeURIComponent(str(a, "slug"))}` }),
  },
  {
    name: "kanban_board_create",
    description:
      "Create a kanban board. Columns default to Todo/In Progress/In Review/Done; member_policy defaults to 'invite'.",
    inputSchema: schema(
      {
        slug: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
        title: { type: "string" },
        description: { type: ["string", "null"] },
        columns: COLUMNS,
        labels: { type: "array" },
        member_policy: { type: "string", enum: ["open", "invite"] },
      },
      ["slug", "title"],
    ),
    toRequest: (a) => ({
      method: "POST",
      path: "/api/v0/boards",
      body: pick(a, ["slug", "title", "description", "columns", "labels", "member_policy"]),
    }),
  },
  {
    name: "kanban_board_update",
    description: "Update mutable fields of a board (title, description, columns, labels, member_policy).",
    inputSchema: schema(
      {
        slug: { type: "string", description: "Which board to update (slugs are immutable)" },
        title: { type: "string" },
        description: { type: ["string", "null"] },
        columns: COLUMNS,
        column_move_map: {
          type: "object",
          description:
            "When a columns update deletes a column that still has issues: {deleted_column_id: target_column_id} — target must be a surviving enabled column",
        },
        labels: { type: "array" },
        member_policy: { type: "string", enum: ["open", "invite"] },
      },
      ["slug"],
    ),
    toRequest: (a) => ({
      method: "PATCH",
      path: `/api/v0/boards/${encodeURIComponent(str(a, "slug"))}`,
      body: pick(a, ["title", "description", "columns", "column_move_map", "labels", "member_policy"]),
    }),
  },
  {
    name: "kanban_board_delete",
    description: "Delete one of the caller's boards. Issues are not cascaded (audit history is kept).",
    inputSchema: schema({ slug: { type: "string" } }, ["slug"]),
    toRequest: (a) => ({ method: "DELETE", path: `/api/v0/boards/${encodeURIComponent(str(a, "slug"))}` }),
  },
  {
    name: "kanban_issue_list",
    description:
      "List issues on a board, newest-updated first. At most one filter (status, container, assignee, label) at a time.",
    inputSchema: schema(
      {
        board_slug: { type: "string" },
        status: { type: "string", description: "Filter: exact column name" },
        container: { ...CONTAINER, description: "Filter: icebox | backlog | active" },
        assignee: { type: "string", description: "Filter: assignee pubkey" },
        label: { type: "string", description: "Filter: label present on the issue" },
        ...PAGING,
      },
      ["board_slug"],
    ),
    toRequest: (a) => ({
      method: "GET",
      path: `/api/v0/boards/${encodeURIComponent(str(a, "board_slug"))}/issues`,
      query: pick(a, ["status", "container", "assignee", "label", "limit", "after"]),
    }),
  },
  {
    name: "kanban_issue_get",
    description:
      "Fetch a single issue by UUID or short id (e.g. FLOW-42) — the full picture: issue fields plus its comments and attachments.",
    inputSchema: schema({ id: { type: "string", description: ISSUE_REF } }, ["id"]),
    toRequest: (a) => ({
      method: "GET",
      path: `/api/v0/issues/${encodeURIComponent(str(a, "id"))}`,
      query: { include: "comments,attachments" },
    }),
  },
  {
    name: "kanban_issue_create",
    description:
      "Create an issue on a board. Status must be one of the board's columns (defaults to the first); container defaults to 'backlog'.",
    inputSchema: schema(
      {
        board_slug: { type: "string" },
        title: { type: "string" },
        body: { type: ["string", "null"], description: "Markdown body" },
        type: ISSUE_TYPE,
        status: { type: "string" },
        container: CONTAINER,
        assignee_pubkey: { type: ["string", "null"] },
        priority: { type: ["integer", "null"] },
        estimate: { type: ["integer", "null"] },
        labels: { type: "array", items: { type: "string" } },
      },
      ["board_slug", "title"],
    ),
    toRequest: (a) => ({
      method: "POST",
      path: `/api/v0/boards/${encodeURIComponent(str(a, "board_slug"))}/issues`,
      body: pick(a, ["title", "body", "type", "status", "container", "assignee_pubkey", "priority", "estimate", "labels"]),
    }),
  },
  {
    name: "kanban_issue_update",
    description:
      "Partially update an issue (title, body, type, status, assignee_pubkey, priority, estimate, labels). Container moves use the dedicated tools.",
    inputSchema: schema(
      {
        id: { type: "string", description: ISSUE_REF },
        title: { type: "string" },
        body: { type: ["string", "null"] },
        type: ISSUE_TYPE,
        status: { type: "string", description: "Must be one of the board's columns" },
        assignee_pubkey: { type: ["string", "null"] },
        priority: { type: ["integer", "null"] },
        estimate: { type: ["integer", "null"] },
        labels: { type: "array", items: { type: "string" } },
      },
      ["id"],
    ),
    toRequest: (a) => ({
      method: "PATCH",
      path: `/api/v0/issues/${encodeURIComponent(str(a, "id"))}`,
      body: pick(a, ["title", "body", "type", "status", "assignee_pubkey", "priority", "estimate", "labels"]),
    }),
  },
  {
    name: "kanban_issue_transition",
    description:
      "Move an issue to another status column (the drag-drop verb). Address the target by column_id (stable across renames, preferred) or by name via `to`; column_id wins when both are given.",
    inputSchema: schema(
      {
        id: { type: "string", description: ISSUE_REF },
        column_id: { type: "string", description: "Target Column.id on the issue's board" },
        to: { type: "string", description: "Target column by exact name (legacy)" },
      },
      ["id"],
    ),
    toRequest: (a) => ({
      method: "POST",
      path: `/api/v0/issues/${encodeURIComponent(str(a, "id"))}/transition`,
      body: pick(a, ["column_id", "to", "to_status"]),
    }),
  },
  {
    name: "kanban_issue_promote_to_backlog",
    description: "Move an issue into the backlog container. Idempotent.",
    inputSchema: schema({ id: { type: "string", description: ISSUE_REF } }, ["id"]),
    toRequest: (a) => ({
      method: "POST",
      path: `/api/v0/issues/${encodeURIComponent(str(a, "id"))}/promote_to_backlog`,
      body: {},
    }),
  },
  {
    name: "kanban_issue_promote_to_active",
    description: "Move an issue into the active container. Idempotent.",
    inputSchema: schema({ id: { type: "string", description: ISSUE_REF } }, ["id"]),
    toRequest: (a) => ({
      method: "POST",
      path: `/api/v0/issues/${encodeURIComponent(str(a, "id"))}/promote_to_active`,
      body: {},
    }),
  },
  {
    name: "kanban_issue_send_to_icebox",
    description: "Move an issue into the icebox container. Idempotent.",
    inputSchema: schema({ id: { type: "string", description: ISSUE_REF } }, ["id"]),
    toRequest: (a) => ({
      method: "POST",
      path: `/api/v0/issues/${encodeURIComponent(str(a, "id"))}/send_to_icebox`,
      body: {},
    }),
  },
  {
    name: "kanban_issue_delete",
    description: "Delete an issue and its comments. Activity-feed audit rows are kept.",
    inputSchema: schema({ id: { type: "string", description: ISSUE_REF } }, ["id"]),
    toRequest: (a) => ({ method: "DELETE", path: `/api/v0/issues/${encodeURIComponent(str(a, "id"))}` }),
  },
  {
    name: "kanban_comment_post",
    description: "Post a comment on an issue, optionally as a reply to another comment on the same issue.",
    inputSchema: schema(
      {
        issue_id: { type: "string", description: ISSUE_REF },
        body: { type: "string" },
        in_reply_to: { type: ["string", "null"], description: "Parent comment id on the same issue" },
      },
      ["issue_id", "body"],
    ),
    toRequest: (a) => ({
      method: "POST",
      path: `/api/v0/issues/${encodeURIComponent(str(a, "issue_id"))}/comments`,
      body: pick(a, ["body", "in_reply_to"]),
    }),
  },
  {
    name: "kanban_comment_list",
    description: "List an issue's comments in chronological order (forward keyset pagination).",
    inputSchema: schema({ issue_id: { type: "string", description: ISSUE_REF }, ...PAGING }, ["issue_id"]),
    toRequest: (a) => ({
      method: "GET",
      path: `/api/v0/issues/${encodeURIComponent(str(a, "issue_id"))}/comments`,
      query: pick(a, ["limit", "after"]),
    }),
  },
  {
    name: "kanban_activity_read",
    description:
      "Read a board's activity feed newest-first. type filters to creation | status | container events.",
    inputSchema: schema(
      {
        board_slug: { type: "string" },
        type: { type: "string", enum: ["creation", "status", "container"] },
        ...PAGING,
      },
      ["board_slug"],
    ),
    toRequest: (a) => ({
      method: "GET",
      path: `/api/v0/boards/${encodeURIComponent(str(a, "board_slug"))}/activity`,
      query: pick(a, ["type", "limit", "after"]),
    }),
  },
];

const TOOL_BY_NAME = new Map(MCP_TOOLS.map((t) => [t.name, t]));

// ── router ────────────────────────────────────────────────────────────────

export const makeMcpRouter = (layerFor: LayerFor = bootstrap) => {
  // The internal REST app the tools dispatch against — identical mounting to
  // index.ts, including requireAuth, so MCP inherits the whole behavior.
  const api = new Hono<AppHonoEnv>();
  api.use("/api/v0/*", requireAuth(layerFor));
  api.route("/api/v0", makeBoardsRouter(layerFor));
  api.route("/api/v0", makeIssuesRouter(layerFor));
  api.route("/api/v0", makeCommentsRouter(layerFor));
  api.route("/api/v0", makeFeedRouter(layerFor));

  const callTool = async (
    c: Context<AppHonoEnv>,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    const name = params["name"];
    if (typeof name !== "string") {
      throw new RpcError(INVALID_PARAMS, "tools/call requires a 'name' string");
    }
    const tool = TOOL_BY_NAME.get(name);
    if (tool === undefined) {
      throw new RpcError(METHOD_NOT_FOUND, `unknown tool: ${name}`);
    }
    const args =
      typeof params["arguments"] === "object" && params["arguments"] !== null
        ? (params["arguments"] as Record<string, unknown>)
        : {};

    const rest = tool.toRequest(args);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(rest.query ?? {})) qs.set(k, String(v));
    const url = qs.size > 0 ? `${rest.path}?${qs.toString()}` : rest.path;

    const headers: Record<string, string> = {};
    const auth = c.req.header("Authorization");
    if (auth !== undefined) headers["Authorization"] = auth;
    if (rest.body !== undefined) headers["Content-Type"] = "application/json";

    const res = await api.request(
      url,
      {
        method: rest.method,
        headers,
        ...(rest.body === undefined ? {} : { body: JSON.stringify(rest.body) }),
      },
      c.env,
    );

    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const reason = typeof data["reason"] === "string" ? `: ${data["reason"]}` : "";
      throw new RpcError(codeForStatus(res.status), `${data["error"] ?? "error"}${reason}`, data);
    }
    return data;
  };

  const mcp = new Hono<AppHonoEnv>();

  mcp.post("/mcp", async (c) => {
    let message: unknown;
    try {
      message = await c.req.json();
    } catch {
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "parse error" } },
        400,
      );
    }

    const reply = (id: unknown, body: { result: unknown } | { error: unknown }) =>
      c.json({ jsonrpc: "2.0", id: id as string | number | null, ...body });

    if (
      typeof message !== "object" ||
      message === null ||
      Array.isArray(message) || // 2025-06-18 removed JSON-RPC batching
      (message as Record<string, unknown>)["jsonrpc"] !== "2.0" ||
      typeof (message as Record<string, unknown>)["method"] !== "string"
    ) {
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: "invalid request" } },
        400,
      );
    }

    const { id, method } = message as { id?: unknown; method: string };
    const params =
      typeof (message as Record<string, unknown>)["params"] === "object" &&
      (message as Record<string, unknown>)["params"] !== null
        ? ((message as Record<string, unknown>)["params"] as Record<string, unknown>)
        : {};

    // Notifications (no id) get 202 Accepted with no body, per the
    // Streamable HTTP transport.
    if (id === undefined || id === null) return c.body(null, 202);

    try {
      switch (method) {
        case "initialize":
          return reply(id, {
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              serverInfo: MCP_SERVER_INFO,
              capabilities: { tools: {} },
            },
          });
        case "ping":
          return reply(id, { result: {} });
        case "tools/list":
          return reply(id, {
            result: {
              tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({
                name,
                description,
                inputSchema,
              })),
            },
          });
        case "tools/call": {
          const data = await callTool(c, params);
          return reply(id, {
            result: {
              content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
              structuredContent: data,
              isError: false,
            },
          });
        }
        default:
          return reply(id, {
            error: { code: METHOD_NOT_FOUND, message: `method not found: ${method}` },
          });
      }
    } catch (e) {
      if (e instanceof RpcError) {
        return reply(id, {
          error: { code: e.code, message: e.message, ...(e.data === undefined ? {} : { data: e.data }) },
        });
      }
      return reply(id, { error: { code: INTERNAL_ERROR, message: "internal error" } });
    }
  });

  // The transport is POST-only here: no server-initiated stream is offered.
  mcp.get("/mcp", (c) => c.json({ error: "method-not-allowed" }, 405));
  mcp.delete("/mcp", (c) => c.json({ error: "method-not-allowed" }, 405));

  return mcp;
};
