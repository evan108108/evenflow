// EFB-22 Phase 4: publishing a closed tide day to the substrate.
//
// The load-bearing assertion here is the unwrapped rumor. `encryptedKindOf`
// silently defaults unknown event families to 30555, so "the wraps went out"
// proves nothing on its own — a tide event published as a board event is a
// valid wrap of the wrong kind that no consumer would flag. So this decrypts
// the gift-wrap and checks the actual kind and `d` tag on the wire.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { url } from "../src/routes-manifest";
import {
  bearer,
  createBoard,
  createPublicBoard,
  createIssue,
  jsonReq,
  makeHarness,
  type Harness,
} from "./harness";
import { generateEpochKeypair } from "../src/lib/audience/audience-keys";
import { unwrap } from "../src/lib/audience/nip17";
import { KIND_ENCRYPTED_TIDE } from "../src/audiences";
import { DAY_MS } from "../src/lib/tide/compute";
import { KANBAN_TIDE_PATH, tideEntityId } from "../src/lib/tide/publish";
import { AUDIENCE_TEST_SECRET, KANBAN_TEST_SECRET } from "../src/effects/Audience";
import { deriveServerAudienceKeys } from "../src/lib/audience-store";

import type { SprintShape } from "../src/shapes";

/** Shape of the signed 30560 evenflow POSTs to the gateway. */
interface SignedTideEvent {
  id: string;
  pubkey: string;
  kind: number;
  tags: string[][];
  content: string;
}

const DAY0 = Date.UTC(2026, 6, 20);
const at = (dayOffset: number, hour = 12) => DAY0 + dayOffset * DAY_MS + hour * 3_600_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at(0, 1));
});
afterEach(() => {
  vi.useRealTimers();
});

const registerKey = async (h: Harness, sessionPub: string) => {
  const res = await h.app.request(
    url("session.key.register"),
    jsonReq("POST", { session_pubkey: sessionPub }),
    {},
  );
  expect(res.status).toBe(201);
};

const createSprint = async (h: Harness): Promise<SprintShape> => {
  const res = await h.app.request(
    url("sprint.list", { slug: "kb" }),
    jsonReq("POST", { name: "Sprint 1" }),
    {},
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { sprint: SprintShape }).sprint;
};

const readTide = async (h: Harness, sprintId: string) => {
  const res = await h.app.request(
    url("sprint.tide", { slug: "kb", id: sprintId }),
    { headers: bearer },
    {},
  );
  expect(res.status).toBe(200);
};

describe("tideEntityId", () => {
  it("always carries the day, so each day is its own replaceable event", () => {
    expect(tideEntityId({ board_id: "b", sprint_id: "s" }, "2026-07-20")).toBe("s:2026-07-20");
    expect(tideEntityId({ board_id: "b", sprint_id: null }, "2026-07-20")).toBe("2026-07-20");
  });
});

describe("private board — encrypted 30565", () => {
  it("publishes the rolled-forward day as kind 30565, not the 30555 default", async () => {
    const h = makeHarness();
    const session = generateEpochKeypair();
    await registerKey(h, session.pub);
    await createBoard(h);
    const flip = await h.app.request(
      url("board.get", { slug: "kb" }),
      jsonReq("PATCH", { visibility: "private" }),
      {},
    );
    expect(flip.status).toBe(200);

    const sprint = await createSprint(h);
    const issue = await createIssue(h, { title: "Secret work" });
    await h.app.request(
      url("sprint.issues.attach", { slug: "kb", id: sprint.id }),
      jsonReq("POST", { issue_id: issue.id }),
      {},
    );
    await h.app.request(url("issue.get", { id: issue.id }), jsonReq("PATCH", { estimate: 5 }), {});

    // Cross into a new day so the read closes out day 0.
    vi.setSystemTime(at(1));
    h.audience.calls.length = 0;
    await readTide(h, sprint.id);

    const wraps = h.audience.calls.filter((c) => c.path === "/v0/audience/raw/publish-wraps");
    expect(wraps).toHaveLength(1);
    const body = wraps[0]!.body as { gift_wraps: Array<Parameters<typeof unwrap>[0]> };
    expect(body.gift_wraps).toHaveLength(1);

    const { rumor } = unwrap(body.gift_wraps[0]!, session.priv);
    expect(rumor.kind).toBe(KIND_ENCRYPTED_TIDE);
    expect(rumor.kind).toBe(30565);

    // The day MUST be in the d tag: these are parameterized-replaceable, so
    // keying on the sprint alone would make every day overwrite the last.
    const dTag = rumor.tags.find((t) => t[0] === "d");
    expect(dTag?.[1]).toBe(`${h.db.boards[0]!["id"] as string}:${sprint.id}:2026-07-20`);
  });

  it("stamps substrate_event_id when the wraps land, leaves it NULL when they don't", async () => {
    const h = makeHarness();
    const session = generateEpochKeypair();
    await registerKey(h, session.pub);
    await createBoard(h);
    await h.app.request(url("board.get", { slug: "kb" }), jsonReq("PATCH", { visibility: "private" }), {});
    const sprint = await createSprint(h);

    vi.setSystemTime(at(1));
    await readTide(h, sprint.id);
    expect(h.db.tideSnapshots).toHaveLength(1);
    expect(h.db.tideSnapshots[0]!["substrate_event_id"]).toMatch(/^[0-9a-f]{64}$/);

    // A gateway outage must not cost the reading — only the event id. Build
    // the second board back on day 0 so its day-0 snapshot is closeable.
    vi.setSystemTime(at(0, 1));
    const h2 = makeHarness();
    const session2 = generateEpochKeypair();
    await registerKey(h2, session2.pub);
    await createBoard(h2);
    await h2.app.request(url("board.get", { slug: "kb" }), jsonReq("PATCH", { visibility: "private" }), {});
    const sprint2 = await createSprint(h2);

    vi.setSystemTime(at(1));
    h2.audience.flags.failPosts = true;
    await readTide(h2, sprint2.id);
    expect(h2.db.tideSnapshots).toHaveLength(1);
    expect(h2.db.tideSnapshots[0]!["substrate_event_id"]).toBeNull();
    expect(h2.db.tideSnapshots[0]!["remaining_pts"]).toBe(0);
  });
});

describe("private board — never leaks to the public substrate", () => {
  it("does NOT publish a cleartext 30560 when the encrypted wraps fail", async () => {
    // A null substrate id from emitSecureBoardEvent means EITHER "public
    // board" OR "private board whose wraps didn't land". Treating it as the
    // former would push a private board's points to 4a in the clear the first
    // time the audience gateway hiccupped.
    const h = makeHarness();
    const session = generateEpochKeypair();
    await registerKey(h, session.pub);
    await createBoard(h);
    await h.app.request(url("board.get", { slug: "kb" }), jsonReq("PATCH", { visibility: "private" }), {});
    const sprint = await createSprint(h);

    vi.setSystemTime(at(1));
    h.audience.flags.failPosts = true; // encrypted publish is down
    // The kanban signing key IS configured — nothing but the board's privacy
    // should be stopping a public publish here.
    expect(h.audience.flags.noKanbanKey).toBe(false);

    await readTide(h, sprint.id);

    expect(h.audience.calls.filter((c) => c.path === KANBAN_TIDE_PATH)).toHaveLength(0);
    // Cached, unpublished, awaiting the retry sweep — not leaked.
    expect(h.db.tideSnapshots).toHaveLength(1);
    expect(h.db.tideSnapshots[0]!["substrate_event_id"]).toBeNull();
  });
});

describe("public board — caller-signed 30560", () => {
  it("signs as Evenflow and posts the event to the gateway", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const sprint = await createSprint(h);
    const issue = await createIssue(h, { title: "Open work" });
    await h.app.request(
      url("sprint.issues.attach", { slug: "kb", id: sprint.id }),
      jsonReq("POST", { issue_id: issue.id }),
      {},
    );
    await h.app.request(url("issue.get", { id: issue.id }), jsonReq("PATCH", { estimate: 5 }), {});

    vi.setSystemTime(at(1));
    await readTide(h, sprint.id);

    const posts = h.audience.calls.filter((c) => c.path === KANBAN_TIDE_PATH);
    expect(posts).toHaveLength(1);
    const { event } = posts[0]!.body as { event: SignedTideEvent };

    // Signed by Evenflow's kanban key — NOT the audience key, which seals
    // private-board material and must never author a public event.
    const kanbanPub = deriveServerAudienceKeys(KANBAN_TEST_SECRET)!.pubkeyHex;
    const audiencePub = deriveServerAudienceKeys(AUDIENCE_TEST_SECRET)!.pubkeyHex;
    expect(event.pubkey).toBe(kanbanPub);
    expect(event.pubkey).not.toBe(audiencePub);

    expect(event.kind).toBe(30560);
    const tag = (name: string) => event.tags.find((t) => t[0] === name)?.[1];
    expect(tag("d")).toBe(`${sprint.id}:2026-07-20`);
    expect(tag("fa:board")).toBe(h.db.boards[0]!["id"]);
    expect(tag("fa:sprint")).toBe(sprint.id);
    expect(tag("fa:scope")).toBe("sprint");
    expect(tag("fa:day")).toBe("2026-07-20");
    expect(JSON.parse(event.content)).toMatchObject({
      "@type": "KanbanTideSnapshot",
      committed_pts: 5,
      done_pts: 0,
      remaining_pts: 5,
    });

    // The id we stamp is the signed event's own id — no response parsing.
    expect(h.db.tideSnapshots[0]!["substrate_event_id"]).toBe(event.id);
  });

  it("omits fa:sprint and keys on the board for the kanban-only variant", async () => {
    const h = makeHarness();
    await createPublicBoard(h);

    vi.setSystemTime(at(1));
    const res = await h.app.request(url("board.tide", { slug: "kb" }), { headers: bearer }, {});
    expect(res.status).toBe(200);

    const { event } = (h.audience.calls.find((c) => c.path === KANBAN_TIDE_PATH)!
      .body as { event: SignedTideEvent });
    const boardId = h.db.boards[0]!["id"] as string;
    expect(event.tags.find((t) => t[0] === "fa:sprint")).toBeUndefined();
    expect(event.tags.find((t) => t[0] === "fa:scope")?.[1]).toBe("board");
    expect(event.tags.find((t) => t[0] === "d")?.[1]).toBe(`${boardId}:2026-07-20`);
  });

  it("caches with a NULL substrate_event_id when no kanban key is configured", async () => {
    const h = makeHarness();
    h.audience.flags.noKanbanKey = true;
    await createBoard(h);
    const sprint = await createSprint(h);

    vi.setSystemTime(at(1));
    await readTide(h, sprint.id);

    expect(h.audience.calls.filter((c) => c.path === KANBAN_TIDE_PATH)).toHaveLength(0);
    expect(h.db.tideSnapshots).toHaveLength(1);
    // The unpublished index (migration 0021) is shaped to sweep exactly this.
    expect(h.db.tideSnapshots[0]!["substrate_event_id"]).toBeNull();
  });

  it("keeps the reading and the D1 row when the gateway rejects the post", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    h.audience.flags.failPosts = true;

    vi.setSystemTime(at(1));
    await readTide(h, sprint.id); // must still be a 200

    expect(h.db.tideSnapshots).toHaveLength(1);
    expect(h.db.tideSnapshots[0]!["substrate_event_id"]).toBeNull();
  });

  it("emits the SSE envelope regardless of the substrate", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);

    vi.setSystemTime(at(1));
    await readTide(h, sprint.id);

    const emitted = h.emitter.events.filter((e) => e.event.kind === "sprint.tide.updated");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event.sprint_id).toBe(sprint.id);
    expect(emitted[0]!.event.entity_id).toBe(`${sprint.id}:2026-07-20`);
  });
});