// AuditLog — Effect service for structured audit logging.
//
// Live writes one JSON line per event to console.log (picked up by Workers
// observability). Test records into an in-memory array via makeAuditLogTest.

import { Clock, Context, Effect, Layer } from "effect";

export interface AuditEvent {
  readonly event_type: string;
  readonly actor?: string;
  readonly board?: string;
  readonly issue?: string;
  readonly details?: Record<string, unknown>;
}

export interface AuditLogService {
  readonly record: (event: AuditEvent) => Effect.Effect<void>;
}

export class AuditLog extends Context.Tag("evenflow/AuditLog")<
  AuditLog,
  AuditLogService
>() {}

export const AuditLogLive: Layer.Layer<AuditLog> = Layer.succeed(AuditLog, {
  record: (event) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      console.log(JSON.stringify({ ts: new Date(nowMs).toISOString(), ...event }));
    }),
});

export interface AuditLogTestHandle {
  readonly layer: Layer.Layer<AuditLog>;
  readonly events: Array<AuditEvent>;
}

export const makeAuditLogTest = (): AuditLogTestHandle => {
  const events: Array<AuditEvent> = [];
  return {
    events,
    layer: Layer.succeed(AuditLog, {
      record: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
    }),
  };
};
