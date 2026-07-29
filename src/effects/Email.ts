// Email — Effect service for outbound notification mail via AgentMail.
//
// One call: send(). The Live layer POSTs to AgentMail's REST API from the
// Worker using the AGENTMAIL_API_KEY secret and the notifications inbox
// (notifications@evenflow.work). Absent binding fails typed at call time —
// same posture as Db — so environments without the secret (local dev,
// tests) degrade to a clean "email-unconfigured" error instead of a crash.

import { Context, Data, Effect, Layer } from "effect";
import { AppEnv } from "./AppEnv";

export const NOTIFICATIONS_INBOX = "notifications@evenflow.work";
const AGENTMAIL_API_BASE = "https://api.agentmail.to/v0";

export class EmailError extends Data.TaggedError("EmailError")<{
  readonly reason: "email-unconfigured" | "network" | "http";
  readonly status?: number;
  readonly detail?: string;
}> {}

export interface EmailSend {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface EmailService {
  readonly send: (mail: EmailSend) => Effect.Effect<{ message_id: string | null }, EmailError>;
}

export class Email extends Context.Tag("evenflow/Email")<Email, EmailService>() {}

const makeLive = (apiKey: string | undefined): EmailService => ({
  send: (mail) => {
    if (apiKey === undefined || apiKey === "") {
      return Effect.fail(new EmailError({ reason: "email-unconfigured" }));
    }
    return Effect.tryPromise({
      try: () =>
        fetch(`${AGENTMAIL_API_BASE}/inboxes/${encodeURIComponent(NOTIFICATIONS_INBOX)}/messages/send`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            to: [mail.to],
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
          }),
        }),
      catch: (cause) => new EmailError({ reason: "network", detail: String(cause) }),
    }).pipe(
      Effect.flatMap((res) =>
        Effect.tryPromise({
          try: async () => {
            if (res.status < 200 || res.status >= 300) {
              const detail = (await res.text()).slice(0, 512);
              throw new EmailError({ reason: "http", status: res.status, detail });
            }
            const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
            return {
              message_id: typeof body["message_id"] === "string" ? body["message_id"] : null,
            };
          },
          catch: (cause) =>
            cause instanceof EmailError
              ? cause
              : new EmailError({ reason: "http", status: res.status, detail: String(cause) }),
        }),
      ),
    );
  },
});

export const EmailLive: Layer.Layer<Email, never, AppEnv> = Layer.effect(
  Email,
  Effect.gen(function* () {
    const env = yield* AppEnv;
    return makeLive(env.AGENTMAIL_API_KEY);
  }),
);

// ─── test double ────────────────────────────────────────────────────────────

export interface EmailTestHandle {
  readonly layer: Layer.Layer<Email>;
  readonly sent: Array<EmailSend>;
  failSends: boolean;
}

export const makeEmailTest = (): EmailTestHandle => {
  const sent: Array<EmailSend> = [];
  const handle: EmailTestHandle = {
    sent,
    failSends: false,
    layer: Layer.succeed(Email, {
      send: (mail) => {
        if (handle.failSends) {
          return Effect.fail(new EmailError({ reason: "http", status: 500, detail: "test-outage" }));
        }
        sent.push(mail);
        return Effect.succeed({ message_id: `test-msg-${sent.length}` });
      },
    }),
  };
  return handle;
};
