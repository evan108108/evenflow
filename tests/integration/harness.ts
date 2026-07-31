// Integration harness — the real Worker, over real local D1, over real HTTP.
//
// This is Evenflow's first integration lane (EFB-49). Everything else under
// tests/ runs the routers in-process against tests/dbMock.ts, which is a
// SQL-interpreting fake. That layer is fast and covers a lot, but it cannot
// prove a claim about the *live* stack — EFB-35 is the proof: a mock that
// silently dropped the `board_id` bind let cross-board isolation tests pass
// without ever asserting isolation. A fake can only ever be as correct as
// our belief about what the real thing does.
//
// So this lane deliberately removes the fake:
//
//   REAL  the Worker itself, booted from src/index.ts by wrangler's own
//         `unstable_dev` — the same wrangler major the app deploys with
//         (3.114.x). No version skew between what we test and what ships.
//   REAL  D1. A throwaway SQLite, migrated by our actual migrations/*.sql
//         via the actual `wrangler d1 migrations apply --local`. The
//         board_id filters under test run as real SQL against the real
//         schema, indexes and all.
//   REAL  HTTP. Requests cross a socket into the worker runtime.
//   REAL  auth. JWT_SIGNING_KEY is set to a test value and tokens are minted
//         with genuine HS256 signatures, so src/effects/Jwt.ts verifies them
//         the way it verifies production tokens. No JwtTest layer.
//   REAL  authorization. resolveBoardScope / authorizeBoardById run live.
//
// STUBBED, and only this: the Blossom blob host. `startBlossomStub` stands in
// for blossom.band on localhost. That is external third-party infrastructure,
// not the isolation boundary — the boundary is the `board_id` predicate in
// D1, which stays real. Uploading to a public host on every test run would
// make the suite non-deterministic, network-dependent, and rude. The stub
// still speaks the real BUD-02 contract src/effects/Blossom.ts expects
// (PUT /upload, `Authorization: Nostr <base64 kind-24242 event>`, JSON blob
// descriptor back), and it verifies that authorization header rather than
// ignoring it, so a regression in our upload signing still fails here.
//
// Cost note: booting the runtime and migrating a fresh D1 costs seconds rather
// than milliseconds, so this lane is separate from `npm test` and runs via
// `npm run test:integration`.

import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

/**
 * The signing key the booted Worker verifies tokens against. Test-only value;
 * production's lives in the JWT_SIGNING_KEY Worker secret.
 */
export const TEST_JWT_SIGNING_KEY = "efb49-integration-signing-key";

/** 32-byte hex the stub Blossom host's BUD-01 auth is signed with. */
const TEST_BLOSSOM_SECRET = "11".repeat(32);

const b64url = (input: string): string =>
  Buffer.from(input, "utf8").toString("base64url");

/**
 * Mint a genuinely-signed HS256 token for a distinct identity. The pubkey the
 * routes derive is `${provider}:${oauth_id}`, so two different `oauth_id`s are
 * two different users — which is what "distinct owners" means for these tests.
 */
export const mintToken = (oauthId: string): string => {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      provider: "test",
      oauth_id: oauthId,
      login: oauthId,
      iat: 0,
      exp: 4102444800, // 2100-01-01
    }),
  );
  const signature = createHmac("sha256", TEST_JWT_SIGNING_KEY)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
};

export interface BlossomStub {
  /** Base URL the Worker is pointed at via EVENFLOW_DEFAULT_BLOSSOM_URL. */
  readonly url: string;
  /** Every blob the Worker uploaded, keyed by sha256 hex. */
  readonly blobs: Map<string, Buffer>;
  /** Upload authorization headers seen, in order — proves BUD-01 signing ran. */
  readonly authHeaders: string[];
  readonly close: () => Promise<void>;
}

/**
 * A minimal BUD-02 Blossom host on localhost. Rejects unauthorized uploads so
 * the test proves the Worker actually signed them; stores bytes in memory and
 * serves them back at the sha256-addressed path, exactly as blossom.band does
 * — including the part that matters for EFB-49's case 4: the blob is served to
 * anyone who asks, with no credential of any kind.
 */
export const startBlossomStub = async (): Promise<BlossomStub> => {
  const blobs = new Map<string, Buffer>();
  const authHeaders: string[] = [];
  let port = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "PUT" && req.url === "/upload") {
        const auth = req.headers["authorization"];
        if (auth === undefined || !auth.startsWith("Nostr ")) {
          res.writeHead(401, { "Content-Type": "text/plain" });
          res.end("missing BUD-01 authorization");
          return;
        }
        authHeaders.push(auth);
        const body = Buffer.concat(chunks);
        const sha256 = createHash("sha256").update(body).digest("hex");
        blobs.set(sha256, body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            url: `http://127.0.0.1:${port}/${sha256}`,
            sha256,
            size: body.byteLength,
            type: req.headers["content-type"] ?? "application/octet-stream",
          }),
        );
        return;
      }
      const sha = (req.url ?? "").slice(1);
      const blob = blobs.get(sha);
      if (req.method === "GET" && blob !== undefined) {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(blob);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("no such blob");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("blossom stub failed to bind");
  }
  port = address.port;

  return {
    url: `http://127.0.0.1:${port}`,
    blobs,
    authHeaders,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

export interface ApiResponse<T = unknown> {
  readonly status: number;
  readonly body: T;
}

export interface Stack {
  readonly worker: Unstable_DevWorker;
  readonly blossom: BlossomStub;
  /** Call the Worker as `token`, or anonymously when token is null. */
  readonly api: <T = unknown>(
    token: string | null,
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<ApiResponse<T>>;
  readonly stop: () => Promise<void>;
}

/**
 * wrangler.toml's `[assets] directory` must exist before the runtime boots,
 * and dist/web is a build output (gitignored, absent in a fresh clone). A
 * placeholder keeps the integration lane runnable without a full `cd web &&
 * npm run build`; a real build simply overwrites it.
 */
const ensureAssetsDir = (repoRoot: string): void => {
  const dir = join(repoRoot, "dist", "web");
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "index.html"),
    "<!doctype html><title>evenflow test placeholder</title>\n",
  );
};

/**
 * Boot the full stack against a throwaway D1. Each call gets its own temp
 * persist directory migrated from scratch, so runs are hermetic — no state
 * leaks between runs and no dependence on whatever is in `.wrangler/`.
 */
export const startStack = async (): Promise<Stack> => {
  const repoRoot = process.cwd();
  ensureAssetsDir(repoRoot);

  const persistTo = mkdtempSync(join(tmpdir(), "evenflow-integration-"));
  execFileSync(
    join(repoRoot, "node_modules", ".bin", "wrangler"),
    ["d1", "migrations", "apply", "evenflow", "--local", "--persist-to", persistTo],
    { cwd: repoRoot, stdio: "ignore" },
  );

  const blossom = await startBlossomStub();

  const worker = await unstable_dev("src/index.ts", {
    config: "wrangler.toml",
    local: true,
    persistTo,
    logLevel: "error",
    vars: {
      JWT_SIGNING_KEY: TEST_JWT_SIGNING_KEY,
      EVENFLOW_DEFAULT_BLOSSOM_URL: blossom.url,
      EVENFLOW_BLOSSOM_SECRET: TEST_BLOSSOM_SECRET,
    },
    experimental: {
      disableExperimentalWarning: true,
      disableDevRegistry: true,
    },
  });

  const api = async <T = unknown>(
    token: string | null,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<T>> => {
    const res = await worker.fetch(path, {
      method,
      headers: {
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed as T };
  };

  return {
    worker,
    blossom,
    api,
    stop: async () => {
      await worker.stop();
      await blossom.close();
      rmSync(persistTo, { recursive: true, force: true });
    },
  };
};

// ─── seed helpers — every one of these goes through the real API ────────────

export interface SeededBoard {
  readonly orgSlug: string;
  readonly boardSlug: string;
  readonly boardId: string;
  readonly token: string;
}

export interface SeededIssue {
  readonly id: string;
  readonly short_id: string;
}

/** Create a board (and, implicitly, its owner's personal org) as `token`. */
export const seedBoard = async (
  stack: Stack,
  token: string,
  slug: string,
  title: string,
): Promise<SeededBoard> => {
  const res = await stack.api<{
    board: { id: string; slug: string };
    org: { slug: string };
  }>(token, "POST", "/api/v0/boards", { slug, title });
  if (res.status !== 201) {
    throw new Error(`seedBoard ${slug} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    orgSlug: res.body.org.slug,
    boardSlug: res.body.board.slug,
    boardId: res.body.board.id,
    token,
  };
};

export const seedIssue = async (
  stack: Stack,
  board: SeededBoard,
  title: string,
): Promise<SeededIssue> => {
  const res = await stack.api<{ issue: SeededIssue }>(
    board.token,
    "POST",
    `/api/v0/orgs/${board.orgSlug}/boards/${board.boardSlug}/issues`,
    { title },
  );
  if (res.status !== 201) {
    throw new Error(`seedIssue failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.issue;
};

export interface SeededAttachment {
  readonly id: string;
  readonly issue_id: string;
  readonly blob_url: string;
  readonly sha256: string;
  readonly filename: string;
  readonly storage_kind: string;
  readonly is_cover: boolean;
}

/** Upload through the real POST attachments route — no direct D1 writes. */
export const seedAttachment = async (
  stack: Stack,
  board: SeededBoard,
  issue: SeededIssue,
  filename: string,
  contents: string,
): Promise<SeededAttachment> => {
  const res = await stack.api<{ attachment: SeededAttachment }>(
    board.token,
    "POST",
    `/api/v0/orgs/${board.orgSlug}/boards/${board.boardSlug}/issues/${issue.short_id}/attachments`,
    {
      file_b64: Buffer.from(contents, "utf8").toString("base64"),
      filename,
      content_type: "text/plain",
    },
  );
  if (res.status !== 201) {
    throw new Error(`seedAttachment failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.attachment;
};
