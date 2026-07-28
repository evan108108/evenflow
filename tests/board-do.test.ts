// BoardDO unit tests — the class is instantiated directly (its subscriber
// state is purely in-memory and it never touches DO storage), driven through
// both the public methods and the fetch router.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BoardDO,
  HEARTBEAT_INTERVAL_MS,
  type BoardEvent,
} from "../src/durable-objects/BoardDO";

const makeDO = () => new BoardDO({} as DurableObjectState, {});

const event = (kind: BoardEvent["kind"] = "issue.created"): BoardEvent => ({
  kind,
  board_id: "b1",
  issue_id: "i1",
  at_ms: 1_000,
  payload: { hello: true },
});

const decoder = new TextDecoder();

const attach = (bdo: BoardDO) => {
  const res = bdo.subscribe(new Request("https://board-do/subscribe"));
  const reader = res.body!.getReader();
  return { res, reader };
};

const nextChunk = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const { value, done } = await reader.read();
  expect(done).toBe(false);
  return decoder.decode(value);
};

/** Let the writer.closed rejection propagate to drop() (microtask hops). */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const delivered = async (res: Response) =>
  ((await res.json()) as { delivered: number }).delivered;

afterEach(() => {
  vi.useRealTimers();
});

describe("BoardDO", () => {
  it("subscribe returns an SSE response that opens with a connected comment", async () => {
    const bdo = makeDO();
    const { res, reader } = attach(bdo);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(await nextChunk(reader)).toBe(": connected\n\n");
  });

  it("emit writes the event frame to every subscriber", async () => {
    const bdo = makeDO();
    const a = attach(bdo);
    const b = attach(bdo);
    await nextChunk(a.reader);
    await nextChunk(b.reader);

    const res = bdo.emit(event("issue.transitioned"));
    expect(await delivered(res)).toBe(2);

    for (const { reader } of [a, b]) {
      const frame = await nextChunk(reader);
      expect(frame).toBe(
        `event: issue.transitioned\ndata: ${JSON.stringify(event("issue.transitioned"))}\n\n`,
      );
    }
  });

  it("drops a subscriber whose stream was cancelled", async () => {
    const bdo = makeDO();
    const a = attach(bdo);
    const b = attach(bdo);
    await nextChunk(a.reader);
    await nextChunk(b.reader);

    await a.reader.cancel();
    await settle();

    expect(await delivered(bdo.emit(event()))).toBe(1);
    expect(await nextChunk(b.reader)).toContain("event: issue.created\n");
  });

  it("heartbeats every 30s so proxies keep the connection open", async () => {
    vi.useFakeTimers();
    const bdo = makeDO();
    const { reader } = attach(bdo);
    await nextChunk(reader);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(await nextChunk(reader)).toBe(": heartbeat\n\n");
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(await nextChunk(reader)).toBe(": heartbeat\n\n");
  });

  it("routes /subscribe and /emit through fetch and 404s anything else", async () => {
    const bdo = makeDO();
    const sub = await bdo.fetch(new Request("https://board-do/subscribe"));
    expect(sub.status).toBe(200);
    expect(sub.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = sub.body!.getReader();
    await nextChunk(reader);

    const emit = await bdo.fetch(
      new Request("https://board-do/emit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event("comment.created")),
      }),
    );
    expect(await delivered(emit)).toBe(1);
    expect(await nextChunk(reader)).toContain("event: comment.created\n");

    const miss = await bdo.fetch(new Request("https://board-do/nope"));
    expect(miss.status).toBe(404);
  });
});
