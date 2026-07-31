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

// EFB-24 added the board.* and sprint.* families. Before that, renaming a
// board or starting a sprint reached no SSE client at all — those mutations
// emitted nothing, so a connected board sat on stale settings and a stale
// sprint header until the user reloaded. They also gave the substrate
// publisher nothing to hang kinds 30550 and 30554 on.
//
// board.deleted is deliberately absent: the fork in emitSecureBoardEvent
// re-reads the board to decide whether it may publish, and by the time a
// delete handler could emit, the row is gone and the read fails closed. A
// tombstone would need emitting BEFORE the delete, which is a change to
// delete ordering rather than a new event. See the EFB-24 PR description.
export type BoardEventKind =
  | "issue.created"
  | "issue.updated"
  | "issue.transitioned"
  | "issue.container_changed"
  | "issue.deleted"
  | "comment.created"
  | "comment.deleted"
  | "board.created"
  | "board.updated"
  | "sprint.created"
  | "sprint.updated"
  | "sprint.started"
  | "sprint.completed"
  | "sprint.deleted"
  | "sprint.tide.updated";

export interface BoardEvent {
  readonly kind: BoardEventKind;
  readonly board_id: string;
  readonly issue_id?: string;
  readonly comment_id?: string;
  /**
   * Set on sprint-scoped events so a client can tell whether the update
   * concerns the sprint it is displaying. Lives at the top level rather than
   * inside `payload` because a private board's payload arrives encrypted —
   * the envelope is all an un-granted client can read.
   */
  readonly sprint_id?: string;
  /**
   * Overrides the substrate `d`-tag entity for this event. Only set it when
   * the natural entity is not an issue or comment: the tide events key on
   * (subject, day), so they pass `<sprint_id>:<day>` here. Absent, the
   * encrypted path falls back to issue_id → comment_id → board_id.
   */
  readonly entity_id?: string;
  readonly at_ms: number;
  readonly payload: unknown;
}

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
