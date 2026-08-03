// Polish batch: board archive round-trip + list filtering, cross-board
// issue moves (short_id re-mint, column reset, dual events), and the
// notifications config CRUD.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { url } from "../src/routes-manifest";
import type { BoardShape, IssueShape } from "../src/shapes";
import {
  CALLER,
  callerOrg,
  createBoard,
  createIssue,
  jsonReq,
  makeHarness,
  pubkeyFor,
  seedOrgMember,
  tokenFor,
  type Harness,
} from "./harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  vi.useRealTimers();
});

const listBoards = async (h: Harness, qs = "") => {
  const res = await h.app.request(`/api/v0/boards${qs}`, jsonReq("GET"), {});
  expect(res.status).toBe(200);
  return (await res.json()) as { boards: BoardShape[]; total: number };
};

describe("board archive", () => {
  it("archives and unarchives from the owner, filtering list surfaces", async () => {
    const h = makeHarness();
    await createBoard(h, "kb");
    await createBoard(h, "kb2");

    const res = await h.app.request(url("board.archive.set", { slug: "kb" }), jsonReq("POST", {}), {});
    expect(res.status).toBe(200);
    const { board } = (await res.json()) as { board: BoardShape };
    expect(board.archived_at_ms).toBe(1_000);

    // Hidden by default, visible with include_archived=1 + the flag set.
    const dft = await listBoards(h);
    expect(dft.boards.map((b) => b.slug)).toEqual(["kb2"]);
    expect(dft.total).toBe(1);
    const all = await listBoards(h, "?include_archived=1");
    expect(all.boards.map((b) => b.slug).sort()).toEqual(["kb", "kb2"]);
    expect(all.boards.find((b) => b.slug === "kb")?.archived_at_ms).toBe(1_000);

    // Org-scoped listing filters too.
    const org = callerOrg(h);
    const orgList = await h.app.request(url("board.create", {}, String(org["slug"])), jsonReq("GET"), {});
    expect(((await orgList.json()) as { boards: BoardShape[] }).boards.map((b) => b.slug)).toEqual(["kb2"]);

    // Unarchive restores.
    const un = await h.app.request(url("board.archive.clear", { slug: "kb" }), jsonReq("DELETE"), {});
    expect(un.status).toBe(200);
    expect((await listBoards(h)).boards.map((b) => b.slug).sort()).toEqual(["kb", "kb2"]);
  });

  it("is owner-only: an org admin gets 403", async () => {
    const h = makeHarness();
    await createBoard(h, "kb");
    seedOrgMember(h, String(callerOrg(h)["id"]), pubkeyFor("bob"), "admin");
    const res = await h.app.request(
      url("board.archive.set", { slug: "kb" }),
      jsonReq("POST", {}, tokenFor("bob")),
      {},
    );
    expect(res.status).toBe(403);
  });

  it("keeps archived boards reachable by direct slug", async () => {
    const h = makeHarness();
    await createBoard(h, "kb");
    await h.app.request(url("board.archive.set", { slug: "kb" }), jsonReq("POST", {}), {});
    const res = await h.app.request(url("board.get", { slug: "kb" }), jsonReq("GET"), {});
    expect(res.status).toBe(200);
  });
});

describe("cross-board issue move", () => {
  const setupTwoBoards = async (h: Harness) => {
    await createBoard(h, "kb");
    await createBoard(h, "kb2");
    const issue = await createIssue(h);
    const target = h.db.boards.find((b) => b["slug"] === "kb2")!;
    return { issue, target };
  };

  it("re-mints the short id, resets the column, and emits on both boards", async () => {
    const h = makeHarness();
    const { issue, target } = await setupTwoBoards(h);
    const eventsBefore = h.emitter.events.length;

    const res = await h.app.request(
      url("issue.board.set", { id: issue.id }), jsonReq("PUT", { target_board_id: target["id"] }),
      {},
    );
    expect(res.status).toBe(200);
    const { issue: moved } = (await res.json()) as { issue: IssueShape };
    expect(moved.board_id).toBe(target["id"]);
    expect(moved.short_id).not.toBe(issue.short_id);
    expect(moved.short_id).toMatch(/-1$/);
    expect(moved.container).toBe(issue.container);
    expect(moved.sprint_id ?? null).toBeNull();

    // Same-named column exists on the identically-titled board → status keeps its name.
    expect(moved.status).toBe(issue.status);

    const row = h.db.issues.find((r) => r["id"] === issue.id)!;
    expect(row["board_id"]).toBe(target["id"]);
    expect(row["short_id"]).toBe(moved.short_id);

    const emitted = h.emitter.events.slice(eventsBefore);
    expect(emitted.map((e) => e.board_id).sort()).toEqual(
      [issue.board_id, String(target["id"])].sort(),
    );
  });

  it("rejects moving a board onto itself and unknown targets", async () => {
    const h = makeHarness();
    const { issue } = await setupTwoBoards(h);
    const self = await h.app.request(
      url("issue.board.set", { id: issue.id }), jsonReq("PUT", { target_board_id: issue.board_id }),
      {},
    );
    expect(self.status).toBe(400);
    const ghost = await h.app.request(
      url("issue.board.set", { id: issue.id }), jsonReq("PUT", { target_board_id: "nope" }),
      {},
    );
    expect(ghost.status).toBe(404);
  });

  it("requires contributor on the target: an outsider's board 404s", async () => {
    const h = makeHarness();
    const { issue } = await setupTwoBoards(h);
    // A board the caller can't see at all.
    h.db.boards.push({
      id: "foreign", pubkey: "github:999", slug: "theirs", title: "Theirs",
      description: null, columns: JSON.stringify(["Todo", "Done"]), labels: "[]",
      member_policy: "invite", is_encrypted: 0, org_id: null, visibility: "private",
      issue_prefix: "THR", next_issue_number: 1, created_at_ms: 1, updated_at_ms: 1,
    });
    const res = await h.app.request(
      url("issue.board.set", { id: issue.id }), jsonReq("PUT", { target_board_id: "foreign" }),
      {},
    );
    expect(res.status).toBe(404);
  });
});

describe("notifications config", () => {
  it("reads defaults with no row, PATCHes partially, and persists", async () => {
    const h = makeHarness();
    const dft = await h.app.request(url("notifications.config.get"), jsonReq("GET"), {});
    expect(dft.status).toBe(200);
    expect(await dft.json()).toEqual({
      config: {
        email_on_mention: true,
        email_on_assignment: true,
        email_on_issue_moved_to_me: false,
        email_digest: "off",
      },
    });

    const patch = await h.app.request(
      url("notifications.config.get"),
      jsonReq("PATCH", { email_on_mention: false, email_digest: "weekly" }),
      {},
    );
    expect(patch.status).toBe(200);

    // Partial: untouched fields keep their values across a second PATCH.
    await h.app.request(url("notifications.config.get"), jsonReq("PATCH", { email_on_assignment: false }), {});
    const read = await h.app.request(url("notifications.config.get"), jsonReq("GET"), {});
    expect(await read.json()).toEqual({
      config: {
        email_on_mention: false,
        email_on_assignment: false,
        email_on_issue_moved_to_me: false,
        email_digest: "weekly",
      },
    });
    expect(h.db.notificationConfigs).toHaveLength(1);
    expect(h.db.notificationConfigs[0]!["pubkey"]).toBe(CALLER);
  });

  it("rejects bad digests and non-boolean toggles; requires auth", async () => {
    const h = makeHarness();
    const bad = await h.app.request(
      url("notifications.config.get"),
      jsonReq("PATCH", { email_digest: "hourly" }),
      {},
    );
    expect(bad.status).toBe(400);
    const badBool = await h.app.request(
      url("notifications.config.get"),
      jsonReq("PATCH", { email_on_mention: "yes" }),
      {},
    );
    expect(badBool.status).toBe(400);
    const anon = await h.app.request(url("notifications.config.get"), { method: "GET" }, {});
    expect(anon.status).toBe(401);
  });
});
