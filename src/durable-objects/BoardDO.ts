// BoardDO — per-board Durable Object owning the live-update fanout.
//
// One named instance per board (idFromName(board_id)). Subscribers attach
// over SSE via /subscribe; the Worker calls /emit after every committed
// mutation and the DO writes the event to every open stream. Subscriber
// state is purely in-memory: an open response stream pins the object, and a
// restart just means clients reconnect (EventSource retries natively) —
// nothing to persist.
//
// SSE is one-way, so this is a plain streaming Response per subscriber (no
// hibernatable-WebSocket machinery). A 30s comment heartbeat keeps proxies
// and browsers from reaping idle connections.

// The BoardEvent vocabulary itself lives in ./board-events, which is kept
// import-free so the web app can type-import it across the tsconfig boundary
// (this file cannot serve that role — it references DurableObjectState, which
// does not resolve in web's program). Re-exported here so every existing
// `from "./durable-objects/BoardDO"` import keeps working. See EFB-34.
import type { BoardEvent } from "./board-events";

export type { BoardEvent, BoardEventKind } from "./board-events";

export const HEARTBEAT_INTERVAL_MS = 30_000;

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

const encoder = new TextEncoder();

export class BoardDO {
  private readonly subscribers = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(_state: DurableObjectState, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/subscribe") {
      return this.subscribe(request);
    }
    if (request.method === "POST" && url.pathname === "/emit") {
      const event = (await request.json()) as BoardEvent;
      return this.emit(event);
    }
    return Response.json({ error: "not-found" }, { status: 404 });
  }

  /** Attach an SSE subscriber; the returned Response streams until the client disconnects. */
  subscribe(_request: Request): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    this.subscribers.add(writer);
    void writer.write(encoder.encode(": connected\n\n")).catch(() => this.drop(writer));
    // Client disconnects cancel the readable side, which errors the writer —
    // closed settling (either way) is the removal signal.
    void writer.closed.catch(() => undefined).finally(() => this.drop(writer));
    this.ensureHeartbeat();
    return new Response(readable, { headers: SSE_HEADERS });
  }

  /** Serialize one board event as an SSE frame and write it to every subscriber. */
  emit(event: BoardEvent): Response {
    const frame = encoder.encode(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
    this.broadcast(frame);
    return Response.json({ delivered: this.subscribers.size });
  }

  private broadcast(frame: Uint8Array): void {
    // Writes are fire-and-forget: a slow client must not block the fanout,
    // and a dead one is dropped on its write failure.
    for (const writer of [...this.subscribers]) {
      void writer.write(frame).catch(() => this.drop(writer));
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) return;
    this.heartbeatTimer = setInterval(() => {
      this.broadcast(encoder.encode(": heartbeat\n\n"));
    }, HEARTBEAT_INTERVAL_MS);
  }

  private drop(writer: WritableStreamDefaultWriter<Uint8Array>): void {
    if (!this.subscribers.delete(writer)) return;
    void writer.close().catch(() => undefined);
    if (this.subscribers.size === 0 && this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}
