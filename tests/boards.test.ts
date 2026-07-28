import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Effect, Layer } from "effect";
import {
  Db,
  type DbService,
  JwtTest,
  JWT_TEST_CLAIMS,
  JWT_TEST_TOKEN,
  KmsClientTest,
  makeAuditLogTest,
  makeBoardEmitterTest,
  type AppServices,
} from "../src/effects";
import type { AppHonoEnv } from "../src/http";
import { requireAuth } from "../src/middleware/requireAuth";
import { makeBoardsRouter } from "../src/routes/boards";
import type { BoardShape } from "../src/shapes";

// The stand-in pubkey the router derives until KMS is wired.
const CALLER = `${JWT_TEST_CLAIMS.provider}:${JWT_TEST_CLAIMS.oauth_id}`;

type Row = Record<string, unknown>;

/**
 * In-memory boardCache. Interprets exactly the SQL the boards router
 * issues — an unexpected statement throws so route/SQL drift fails loudly
 * instead of silently returning empty results.
 */
const makeDbMock = () => {
  const rows: Row[] = [];
  const byPubkeyDesc = (pubkey: unknown) =>
    rows
      .filter((r) => r["pubkey"] === pubkey)
      .sort(
        (a, b) =>
          (b["updated_at_ms"] as number) - (a["updated_at_ms"] as number) ||
          String(b["id"]).localeCompare(String(a["id"])),
      );

  const service: DbService = {
    execute: (sql, params = []) =>
      Effect.sync(() => {
        if (sql.startsWith("INSERT INTO boardCache")) {
          const [id, pubkey, slug, title, description, columns, labels, member_policy, is_encrypted, created_at_ms, updated_at_ms] = params;
          rows.push({ id, pubkey, slug, title, description, columns, labels, member_policy, is_encrypted, created_at_ms, updated_at_ms });
          return;
        }
        if (sql.startsWith("UPDATE boardCache SET")) {
          const [title, description, columns, labels, member_policy, updated_at_ms, id] = params;
          const row = rows.find((r) => r["id"] === id);
          if (row) Object.assign(row, { title, description, columns, labels, member_policy, updated_at_ms });
          return;
        }
        if (sql.startsWith("DELETE FROM boardCache")) {
          const idx = rows.findIndex((r) => r["id"] === params[0]);
          if (idx >= 0) rows.splice(idx, 1);
          return;
        }
        throw new Error(`DbMock: unexpected execute: ${sql}`);
      }),
    queryFirst: <R>(sql: string, params: ReadonlyArray<unknown> = []) =>
      Effect.sync(() => {
        if (sql.startsWith("SELECT id FROM boardCache WHERE pubkey = ? AND slug = ?")) {
          const r = rows.find((x) => x["pubkey"] === params[0] && x["slug"] === params[1]);
          return (r ? { id: r["id"] } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM boardCache WHERE pubkey = ? AND slug = ?")) {
          const r = rows.find((x) => x["pubkey"] === params[0] && x["slug"] === params[1]);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT * FROM boardCache WHERE pubkey = ? AND id = ?")) {
          const r = rows.find((x) => x["pubkey"] === params[0] && x["id"] === params[1]);
          return (r ? { ...r } : null) as R | null;
        }
        if (sql.startsWith("SELECT COUNT(*) AS n FROM boardCache WHERE pubkey = ?")) {
          return { n: rows.filter((x) => x["pubkey"] === params[0]).length } as R;
        }
        throw new Error(`DbMock: unexpected queryFirst: ${sql}`);
      }),
    queryAll: <R>(sql: string, params: ReadonlyArray<unknown> = []) =>
      Effect.sync(() => {
        if (sql.includes("(updated_at_ms < ?")) {
          const [pubkey, upd, , afterId, limit] = params;
          return byPubkeyDesc(pubkey)
            .filter(
              (r) =>
                (r["updated_at_ms"] as number) < (upd as number) ||
                (r["updated_at_ms"] === upd && String(r["id"]) < String(afterId)),
            )
            .slice(0, limit as number)
            .map((r) => ({ ...r })) as R[];
        }
        if (sql.startsWith("SELECT * FROM boardCache WHERE pubkey = ? ORDER BY")) {
          const [pubkey, limit] = params;
          return byPubkeyDesc(pubkey)
            .slice(0, limit as number)
            .map((r) => ({ ...r })) as R[];
        }
        throw new Error(`DbMock: unexpected queryAll: ${sql}`);
      }),
  };
  return { rows, layer: Layer.succeed(Db, service) };
};

const makeHarness = () => {
  const db = makeDbMock();
  const audit = makeAuditLogTest();
  const emitter = makeBoardEmitterTest();
  const layer: Layer.Layer<AppServices> = Layer.mergeAll(
    JwtTest,
    db.layer,
    audit.layer,
    emitter.layer,
    KmsClientTest,
  );
  const app = new Hono<AppHonoEnv>();
  app.use("/api/v0/*", requireAuth(() => layer));
  app.route("/api/v0", makeBoardsRouter(() => layer));
  return { app, db, audit };
};

const bearer = { Authorization: `Bearer ${JWT_TEST_TOKEN}` };
const jsonReq = (method: string, body?: unknown) => ({
  method,
  headers: { ...bearer, "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const createBoard = (app: Hono<AppHonoEnv>, overrides?: Record<string, unknown>) =>
  app.request("/api/v0/boards", jsonReq("POST", { slug: "kb", title: "Kanban", ...overrides }), {});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/v0/boards", () => {
  it("creates a board with defaults and returns 201", async () => {
    const { app, db } = makeHarness();
    const res = await createBoard(app);
    expect(res.status).toBe(201);
    const { board } = (await res.json()) as { board: BoardShape };
    expect(board).toMatchObject({
      pubkey: CALLER,
      slug: "kb",
      title: "Kanban",
      description: null,
      columns: ["Backlog", "Todo", "In Progress", "In Review", "Done"],
      labels: [],
      member_policy: "invite",
      is_encrypted: false,
      created_at_ms: 1_000,
      updated_at_ms: 1_000,
    });
    expect(board.id).toBeTruthy();
    expect(db.rows).toHaveLength(1);
    // JSON columns hit storage as strings.
    expect(db.rows[0]!["columns"]).toBe(JSON.stringify(board.columns));
  });

  it("rejects a duplicate slug with 409", async () => {
    const { app } = makeHarness();
    expect((await createBoard(app)).status).toBe(201);
    const res = await createBoard(app, { title: "Second" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict", reason: "slug-in-use" });
  });

  it("rejects an invalid slug with 400", async () => {
    const { app } = makeHarness();
    const res = await createBoard(app, { slug: "not a slug!" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-body", reason: "slug" });
  });

  it("rejects a missing title with 400", async () => {
    const { app } = makeHarness();
    const res = await app.request("/api/v0/boards", jsonReq("POST", { slug: "kb" }), {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-body", reason: "title" });
  });

  it("rejects an unknown member_policy with 400", async () => {
    const { app } = makeHarness();
    const res = await createBoard(app, { member_policy: "anarchy" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v0/boards", () => {
  it("lists only the caller's boards, newest-updated first", async () => {
    const { app, db } = makeHarness();
    await createBoard(app, { slug: "older" });
    vi.setSystemTime(2_000);
    await createBoard(app, { slug: "newer" });
    // A foreign board must never leak into the caller's list.
    db.rows.push({
      id: "foreign", pubkey: "github:999", slug: "theirs", title: "Theirs",
      description: null, columns: "[]", labels: "[]", member_policy: "invite",
      is_encrypted: 0, created_at_ms: 3_000, updated_at_ms: 3_000,
    });

    const res = await app.request("/api/v0/boards", { headers: bearer }, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { boards: BoardShape[]; total: number };
    expect(body.total).toBe(2);
    expect(body.boards.map((b) => b.slug)).toEqual(["newer", "older"]);
  });

  it("paginates with ?limit= and ?after=", async () => {
    const { app } = makeHarness();
    for (const [i, slug] of (["a", "b", "c"] as const).entries()) {
      vi.setSystemTime(1_000 * (i + 1));
      await createBoard(app, { slug });
    }
    const first = await app.request("/api/v0/boards?limit=2", { headers: bearer }, {});
    const page1 = (await first.json()) as { boards: BoardShape[]; total: number };
    expect(page1.boards.map((b) => b.slug)).toEqual(["c", "b"]);
    expect(page1.total).toBe(3);

    const cursor = page1.boards[1]!.id;
    const second = await app.request(`/api/v0/boards?limit=2&after=${cursor}`, { headers: bearer }, {});
    const page2 = (await second.json()) as { boards: BoardShape[] };
    expect(page2.boards.map((b) => b.slug)).toEqual(["a"]);
  });

  it("rejects an unknown after-cursor with 400", async () => {
    const { app } = makeHarness();
    const res = await app.request("/api/v0/boards?after=nope", { headers: bearer }, {});
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v0/boards/:slug", () => {
  it("returns the board", async () => {
    const { app } = makeHarness();
    await createBoard(app);
    const res = await app.request("/api/v0/boards/kb", { headers: bearer }, {});
    expect(res.status).toBe(200);
    const { board } = (await res.json()) as { board: BoardShape };
    expect(board.slug).toBe("kb");
    expect(board.title).toBe("Kanban");
  });

  it("404s on an unknown slug", async () => {
    const { app } = makeHarness();
    const res = await app.request("/api/v0/boards/nope", { headers: bearer }, {});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not-found", reason: "board" });
  });
});

describe("PATCH /api/v0/boards/:slug", () => {
  it("updates title and bumps updated_at_ms", async () => {
    const { app, db } = makeHarness();
    await createBoard(app);
    vi.setSystemTime(5_000);
    const res = await app.request("/api/v0/boards/kb", jsonReq("PATCH", { title: "Renamed" }), {});
    expect(res.status).toBe(200);
    const { board } = (await res.json()) as { board: BoardShape };
    expect(board.title).toBe("Renamed");
    expect(board.updated_at_ms).toBe(5_000);
    expect(board.created_at_ms).toBe(1_000);
    expect(db.rows[0]!["updated_at_ms"]).toBe(5_000);
  });

  it("404s on a non-existent board", async () => {
    const { app } = makeHarness();
    const res = await app.request("/api/v0/boards/nope", jsonReq("PATCH", { title: "X" }), {});
    expect(res.status).toBe(404);
  });

  it("rejects slug changes with 400", async () => {
    const { app } = makeHarness();
    await createBoard(app);
    const res = await app.request("/api/v0/boards/kb", jsonReq("PATCH", { slug: "kb2" }), {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-body", reason: "slug-immutable" });
  });

  it("rejects an empty patch with 400", async () => {
    const { app } = makeHarness();
    await createBoard(app);
    const res = await app.request("/api/v0/boards/kb", jsonReq("PATCH", {}), {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-body", reason: "empty-patch" });
  });
});

describe("DELETE /api/v0/boards/:slug", () => {
  it("deletes the board; subsequent GET 404s", async () => {
    const { app, db } = makeHarness();
    await createBoard(app);
    const res = await app.request("/api/v0/boards/kb", { method: "DELETE", headers: bearer }, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(db.rows).toHaveLength(0);
    const gone = await app.request("/api/v0/boards/kb", { headers: bearer }, {});
    expect(gone.status).toBe(404);
  });

  it("404s on an unknown slug", async () => {
    const { app } = makeHarness();
    const res = await app.request("/api/v0/boards/nope", { method: "DELETE", headers: bearer }, {});
    expect(res.status).toBe(404);
  });
});

describe("auth gating", () => {
  it.each([
    ["POST", "/api/v0/boards"],
    ["GET", "/api/v0/boards"],
    ["GET", "/api/v0/boards/kb"],
    ["PATCH", "/api/v0/boards/kb"],
    ["DELETE", "/api/v0/boards/kb"],
  ])("%s %s rejects unauthenticated requests", async (method, path) => {
    const { app } = makeHarness();
    const res = await app.request(path, { method }, {});
    expect(res.status).toBe(401);
  });
});
