// End-to-end tests for the GitHub integration endpoints: the HMAC-gated
// inbound webhook driven by the vendored fixtures, plus the admin config,
// rules, test-panel and audit surfaces.

import { beforeEach, describe, expect, it } from "vitest";
import { makeHarness, bearer, jsonReq, createBoard, createIssue, type Harness } from "./harness";
import { signGithubBody } from "../src/github/secret";
import { fixture } from "./fixtures/github";

const MASTER = "a".repeat(64);
const ENV = { EVENFLOW_WEBHOOK_SECRET: MASTER };


/**
 * Retarget a PR fixture at a real short id created by the harness.
 * Rewrites the BRANCH as well as the title/body — the fixture's branch
 * carries its own ref, and leaving it behind silently adds a second
 * (unresolved) match to every delivery.
 */
const retarget = (payload: Record<string, unknown>, shortId: string): Record<string, unknown> => {
  const pr = { ...(payload["pull_request"] as Record<string, unknown>) };
  const head = { ...(pr["head"] as Record<string, unknown>) };
  head["ref"] = `feature/${shortId}-retargeted`;
  pr["head"] = head;
  pr["title"] = `${shortId} retargeted for test`;
  pr["body"] = `Refs ${shortId}.`;
  return { ...payload, pull_request: pr };
};

let h: Harness;
let boardId: string;
let secret: string;
let shortId: string;

const connect = async (preset = "defaults") => {
  const res = await h.app.request(
    "/api/v0/boards/kb/github",
    jsonReq("PUT", { repo: "evan108108/evenflow", preset }),
    ENV,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
};

const mintSecret = async (): Promise<string> => {
  const res = await h.app.request("/api/v0/boards/kb/github/secret", jsonReq("POST"), ENV);
  expect(res.status).toBe(201);
  return ((await res.json()) as { secret: string }).secret;
};

/** POST a payload to the webhook with a correct signature by default. */
const deliver = async (
  event: string,
  payload: unknown,
  opts: { deliveryId?: string | null; signature?: string | null; raw?: string; useSecret?: string } = {},
) => {
  const raw = opts.raw ?? JSON.stringify(payload);
  const sig =
    opts.signature === undefined
      ? await signGithubBody(opts.useSecret ?? secret, raw)
      : opts.signature;
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-github-event": event };
  if (sig !== null) headers["x-hub-signature-256"] = sig;
  const deliveryId = opts.deliveryId === undefined ? crypto.randomUUID() : opts.deliveryId;
  if (deliveryId !== null) headers["x-github-delivery"] = deliveryId;
  return h.app.request(`/api/v0/webhooks/github/${boardId}`, { method: "POST", headers, body: raw }, ENV);
};

const issueRow = () => h.db.issues.find((r) => r["short_id"] === shortId)!;

beforeEach(async () => {
  h = makeHarness();
  await createBoard(h);
  const issue = await createIssue(h, { title: "Wire the pill" });
  shortId = issue.short_id!;
  boardId = h.db.boards[0]!["id"] as string;
  await connect();
  secret = await mintSecret();
});

// ── connect / config ──────────────────────────────────────────────────────

describe("board GitHub config", () => {
  it("seeds the default preset on connect and reports it", async () => {
    const res = await h.app.request("/api/v0/boards/kb/github", { headers: bearer }, ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.config.repo).toBe("evan108108/evenflow");
    expect(body.config.connected).toBe(true);
    expect(body.config.has_secret).toBe(true);
    expect(body.config.preset).toBe("defaults");
    expect(body.rules.length).toBeGreaterThan(0);
  });

  it("never discloses the secret after minting", async () => {
    const res = await h.app.request("/api/v0/boards/kb/github", { headers: bearer }, ENV);
    const text = await res.text();
    expect(text).not.toContain(secret);
    expect(text).toContain("has_secret");
  });

  it("rotating invalidates the previous secret", async () => {
    const old = secret;
    const rotated = await mintSecret();
    expect(rotated).not.toBe(old);
    const res = await deliver("pull_request", retarget(fixture("pull_request.opened"), shortId), {
      useSecret: old,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed repo", async () => {
    const res = await h.app.request(
      "/api/v0/boards/kb/github",
      jsonReq("PUT", { repo: "not-a-repo" }),
      ENV,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).reason).toBe("repo");
  });

  it("status_only seeds no transitions", async () => {
    const body = (await connect("status_only")) as any;
    const kinds = body.rules.map((r: any) => r.do.type);
    expect(kinds).not.toContain("transition_to_column");
  });

  it("switching to custom does not wipe hand-edited rules", async () => {
    await h.app.request(
      "/api/v0/boards/kb/github/rules",
      jsonReq("PUT", {
        rules: [
          { bucket: "match", when: { event: "pull_request" }, do: { type: "set_external_state", value: "ci_passing" } },
        ],
      }),
      ENV,
    );
    await connect("custom");
    const res = await h.app.request("/api/v0/boards/kb/github", { headers: bearer }, ENV);
    const body = (await res.json()) as any;
    expect(body.rules).toHaveLength(1);
  });

  it("disconnect clears repo and secret but keeps the audit trail", async () => {
    await deliver("pull_request", retarget(fixture("pull_request.opened"), shortId));
    const res = await h.app.request("/api/v0/boards/kb/github", { method: "DELETE", headers: bearer }, ENV);
    expect(res.status).toBe(200);
    expect(h.db.boards[0]!["github_repo"]).toBeNull();
    expect(h.db.boards[0]!["github_webhook_secret_ciphertext"]).toBeNull();
    expect(h.db.githubAudit.length).toBeGreaterThan(0);
  });

  it("requires admin", async () => {
    const res = await h.app.request("/api/v0/boards/kb/github", {}, ENV);
    expect(res.status).toBe(401);
  });

  it("503s when the server master key is missing", async () => {
    const res = await h.app.request("/api/v0/boards/kb/github/secret", jsonReq("POST"), {});
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error).toBe("server-misconfigured");
  });
});

// ── the webhook ───────────────────────────────────────────────────────────

describe("POST /api/v0/webhooks/github/:board_id", () => {
  it("applies the pill on an opened PR and records the link", async () => {
    const res = await deliver("pull_request", retarget(fixture("pull_request.opened"), shortId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.matched).toEqual([shortId]);
    const row = issueRow();
    expect(row["external_state"]).toBe("pr_review");
    expect(JSON.parse(String(row["github_links"]))).toEqual([
      { repo: "evan108108/evenflow", pr: 42, state: "open" },
    ]);
  });

  it("moves the ticket to Done on merge and stamps completed_at_ms", async () => {
    const res = await deliver("pull_request", retarget(fixture("pull_request.closed_merged"), shortId));
    expect(res.status).toBe(200);
    const row = issueRow();
    expect(row["status"]).toBe("Done");
    expect(row["completed_at_ms"]).toBeTypeOf("number");
    // The move is mirrored into the activity feed, exactly as a hand-drag is.
    const change = h.db.statusChanges.find((c) => c["to_status"] === "Done");
    expect(change).toBeDefined();
    expect(change!["actor_pubkey"]).toBe("github:octodev");
  });

  it("a closed-unmerged PR sets the pill and does NOT move the card", async () => {
    const before = issueRow()["status"];
    await deliver("pull_request", retarget(fixture("pull_request.closed_unmerged"), shortId));
    const row = issueRow();
    expect(row["external_state"]).toBe("pr_closed");
    expect(row["status"]).toBe(before);
  });

  it("a draft PR reads pr_draft", async () => {
    await deliver("pull_request", retarget(fixture("pull_request.opened_draft"), shortId));
    expect(issueRow()["external_state"]).toBe("pr_draft");
  });

  it("an approved review reads pr_approved", async () => {
    await deliver(
      "pull_request_review",
      retarget(fixture("pull_request_review.submitted_approved"), shortId),
    );
    expect(issueRow()["external_state"]).toBe("pr_approved");
  });

  it("a failed check posts a rendered comment", async () => {
    const payload = fixture("check_run.completed_failure");
    const run = { ...(payload["check_run"] as Record<string, unknown>) };
    run["pull_requests"] = [{ number: 42, head: { ref: `feature/${shortId}-x` } }];
    await deliver("check_run", { ...payload, check_run: run });
    const comment = h.db.comments.at(-1);
    expect(comment).toBeDefined();
    expect(String(comment!["body"])).toContain("worker-qa");
    expect(String(comment!["body"])).toContain("#42");
    // Every placeholder resolved — a leftover {{ }} would mean the
    // template referenced a path the whitelist does not expose.
    expect(String(comment!["body"])).not.toContain("{{");
  });

  it("last-event-wins on the pill", async () => {
    await deliver("pull_request", retarget(fixture("pull_request.opened"), shortId));
    expect(issueRow()["external_state"]).toBe("pr_review");
    await deliver(
      "pull_request_review",
      retarget(fixture("pull_request_review.submitted_changes_requested"), shortId),
    );
    expect(issueRow()["external_state"]).toBe("pr_changes_requested");
  });

  it("upserts the PR link rather than accumulating duplicates", async () => {
    await deliver("pull_request", retarget(fixture("pull_request.opened"), shortId));
    await deliver("pull_request", retarget(fixture("pull_request.closed_merged"), shortId));
    const links = JSON.parse(String(issueRow()["github_links"]));
    expect(links).toHaveLength(1);
    expect(links[0].state).toBe("merged");
  });

  it("honours an explicit evenflow: override over the title's ref", async () => {
    const other = await createIssue(h, { title: "The real target" });
    const payload = fixture("pull_request.opened_explicit_override");
    const pr = { ...(payload["pull_request"] as Record<string, unknown>) };
    pr["title"] = `${shortId} says one thing`;
    pr["body"] = `but really\n\nevenflow: ${other.short_id}\n`;
    const res = await deliver("pull_request", { ...payload, pull_request: pr });
    const body = (await res.json()) as any;
    expect(body.matched).toEqual([other.short_id]);
    expect(issueRow()["external_state"]).toBeUndefined();
  });

  it("rejects a bad signature with 400 and writes no audit row", async () => {
    const res = await deliver("pull_request", retarget(fixture("pull_request.opened"), shortId), {
      signature: "sha256=" + "0".repeat(64),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("bad-signature");
    // Unverified input must not be able to fill a board's activity log.
    expect(h.db.githubAudit).toHaveLength(0);
    expect(issueRow()["external_state"]).toBeUndefined();
  });

  it("rejects a missing signature", async () => {
    const res = await deliver("pull_request", fixture("pull_request.opened"), { signature: null });
    expect(res.status).toBe(400);
  });

  it("rejects a body that is not JSON, and audits the failure", async () => {
    const res = await deliver("pull_request", null, { raw: "{not json" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("malformed-json");
    expect(h.db.githubAudit[0]!["error"]).toBe("malformed-json");
  });

  it("drops a redelivered delivery id", async () => {
    const id = "delivery-abc";
    const payload = retarget(fixture("pull_request.opened"), shortId);
    const first = await deliver("pull_request", payload, { deliveryId: id });
    expect(((await first.json()) as any).deduped).toBeUndefined();

    // Simulate the user undoing the automation by hand...
    issueRow()["external_state"] = "manually_cleared";
    // ...then GitHub retrying the same delivery.
    const second = await deliver("pull_request", payload, { deliveryId: id });
    expect(second.status).toBe(200);
    expect(((await second.json()) as any).deduped).toBe(true);
    expect(issueRow()["external_state"]).toBe("manually_cleared");
  });

  it("processes distinct delivery ids for the same payload", async () => {
    const payload = retarget(fixture("pull_request.opened"), shortId);
    await deliver("pull_request", payload, { deliveryId: "d1" });
    await deliver("pull_request", payload, { deliveryId: "d2" });
    expect(h.db.githubAudit).toHaveLength(2);
  });

  it("2xx-s a PR that matches no ticket, so GitHub stops retrying", async () => {
    const res = await deliver("pull_request", fixture("pull_request.opened_no_ref"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.matched).toEqual([]);
    expect(h.db.githubAudit).toHaveLength(1);
  });

  it("reports refs that resolve to no ticket on this board", async () => {
    const payload = retarget(fixture("pull_request.opened"), "ZZ-999");
    const res = await deliver("pull_request", payload);
    expect(((await res.json()) as any).unresolved).toEqual(["ZZ-999"]);
  });

  it("does not reach across boards", async () => {
    // A second board must not be touched by a PR naming the first's ticket.
    await createBoard(h, "other");
    const otherBoardId = h.db.boards.find((b) => b["slug"] === "other")!["id"];
    expect(otherBoardId).not.toBe(boardId);
    const res = await deliver("pull_request", retarget(fixture("pull_request.opened"), shortId));
    const body = (await res.json()) as any;
    expect(body.matched).toEqual([shortId]);
  });

  it("404s an unknown board without disclosing existence", async () => {
    const raw = JSON.stringify(fixture("pull_request.opened"));
    const res = await h.app.request(
      "/api/v0/webhooks/github/no-such-board",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-github-event": "pull_request",
          "x-hub-signature-256": await signGithubBody(secret, raw),
        },
        body: raw,
      },
      ENV,
    );
    expect(res.status).toBe(404);
  });

  it("404s a board with no secret configured", async () => {
    await h.app.request("/api/v0/boards/kb/github", { method: "DELETE", headers: bearer }, ENV);
    const res = await deliver("pull_request", retarget(fixture("pull_request.opened"), shortId));
    expect(res.status).toBe(404);
  });
});

// ── test panel ────────────────────────────────────────────────────────────

describe("POST /boards/:slug/github/test", () => {
  it("reports what would fire without writing anything", async () => {
    const payload = retarget(fixture("pull_request.closed_merged"), shortId);
    const before = JSON.stringify(issueRow());
    const res = await h.app.request(
      "/api/v0/boards/kb/github/test",
      jsonReq("POST", { event: "pull_request", payload }),
      ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.matched).toEqual([shortId]);
    expect(body.outcomes[0].effects).toContainEqual({
      kind: "set_column",
      column_id: expect.any(String),
      column_name: "Done",
    });
    // Zero side effects: no issue mutation, no audit row, no dedup claim.
    expect(JSON.stringify(issueRow())).toBe(before);
    expect(h.db.githubAudit).toHaveLength(0);
    expect(h.db.githubDedup).toHaveLength(0);
  });

  it("agrees with what the webhook then actually does", async () => {
    // The panel and the webhook share evaluateDelivery; this pins that.
    const payload = retarget(fixture("pull_request.opened"), shortId);
    const dry = await h.app.request(
      "/api/v0/boards/kb/github/test",
      jsonReq("POST", { event: "pull_request", payload }),
      ENV,
    );
    const predicted = (await dry.json()) as any;
    await deliver("pull_request", payload);
    const predictedState = predicted.outcomes[0].effects.find(
      (e: any) => e.kind === "set_external_state",
    ).value;
    expect(issueRow()["external_state"]).toBe(predictedState);
  });

  it("explains a no-match delivery", async () => {
    const res = await h.app.request(
      "/api/v0/boards/kb/github/test",
      jsonReq("POST", { event: "pull_request", payload: fixture("pull_request.opened_no_ref") }),
      ENV,
    );
    const body = (await res.json()) as any;
    expect(body.bucket).toBe("no_match");
    expect(body.matched).toEqual([]);
    expect(body.no_rule_matched).toBe(true);
  });

  it("rejects a payload that is not an object", async () => {
    const res = await h.app.request(
      "/api/v0/boards/kb/github/test",
      jsonReq("POST", { event: "pull_request", payload: "nope" }),
      ENV,
    );
    expect(res.status).toBe(400);
  });
});

// ── rules CRUD ────────────────────────────────────────────────────────────

describe("PUT /boards/:slug/github/rules", () => {
  const put = (rules: unknown) =>
    h.app.request("/api/v0/boards/kb/github/rules", jsonReq("PUT", { rules }), ENV);

  it("replaces the set and flips the preset to custom", async () => {
    const res = await put([
      { bucket: "match", when: { event: "pull_request", action: "opened" }, do: { type: "no_op", note: "watching" } },
    ]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).rules).toHaveLength(1);
    expect(h.db.boards[0]!["github_rule_preset"]).toBe("custom");
  });

  it("rejects an invalid rule with the offending index", async () => {
    const res = await put([
      { bucket: "match", when: { event: "pull_request" }, do: { type: "no_op" } },
      { bucket: "match", when: { event: "deployment" }, do: { type: "no_op" } },
    ]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).reason).toBe("rule-1-when-event");
  });

  it("rejects the whole batch atomically when one rule is bad", async () => {
    const before = h.db.githubRules.length;
    await put([{ bucket: "match", when: { event: "nope" }, do: { type: "no_op" } }]);
    expect(h.db.githubRules).toHaveLength(before);
  });

  it("rejects an external state outside the board vocabulary", async () => {
    await h.app.request(
      "/api/v0/boards/kb/github",
      jsonReq("PUT", { external_states: ["only_this"] }),
      ENV,
    );
    const res = await put([
      { bucket: "match", when: { event: "pull_request" }, do: { type: "set_external_state", value: "pr_review" } },
    ]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).reason).toBe("rule-0-do-external-state-not-allowed");
  });

  it("a disabled rule does not fire", async () => {
    await put([
      {
        bucket: "match",
        when: { event: "pull_request", action: "opened" },
        do: { type: "set_external_state", value: "ci_passing" },
        enabled: false,
      },
    ]);
    await deliver("pull_request", retarget(fixture("pull_request.opened"), shortId));
    expect(issueRow()["external_state"]).toBeUndefined();
  });

  it("priority decides which of two matching rules fires", async () => {
    await put([
      { bucket: "match", priority: 20, when: { event: "pull_request" }, do: { type: "set_external_state", value: "ci_failed" } },
      { bucket: "match", priority: 10, when: { event: "pull_request" }, do: { type: "set_external_state", value: "ci_passing" } },
    ]);
    await deliver("pull_request", retarget(fixture("pull_request.opened"), shortId));
    expect(issueRow()["external_state"]).toBe("ci_passing");
  });

  it("a no_match rule fires only when nothing matched", async () => {
    await put([
      { bucket: "no_match", when: { event: "pull_request" }, do: { type: "no_op", note: "unreffed PR" } },
    ]);
    const res = await deliver("pull_request", fixture("pull_request.opened_no_ref"));
    expect(res.status).toBe(200);
    const audit = h.db.githubAudit[0]!;
    // The rule that fired IS recorded — that is the whole point of the
    // bucket: "a PR arrived naming no ticket" becomes visible rather than
    // silent. It just has no issue to write against.
    expect(JSON.parse(String(audit["matched_rule_ids_json"]))).toHaveLength(1);
    expect(JSON.parse(String(audit["matched_issue_ids_json"]))).toHaveLength(0);
    expect(String(audit["actions_taken_json"])).toContain("no-ticket-bucket");
  });

  it("a match-bucket rule does not fire on an unreffed PR", async () => {
    await put([
      {
        bucket: "match",
        when: { event: "pull_request" },
        do: { type: "set_external_state", value: "ci_passing" },
      },
    ]);
    await deliver("pull_request", fixture("pull_request.opened_no_ref"));
    expect(h.db.issues.every((i) => i["external_state"] === undefined)).toBe(true);
  });
});

// ── audit log ─────────────────────────────────────────────────────────────

describe("GET /boards/:slug/github/audit", () => {
  it("lists deliveries newest first with their actions", async () => {
    await deliver("pull_request", retarget(fixture("pull_request.opened"), shortId));
    await deliver("check_run", fixture("check_run.completed_success"));
    const res = await h.app.request("/api/v0/boards/kb/github/audit", { headers: bearer }, ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].event_type).toBe("check_run");
    expect(body.entries[1].actions_taken.length).toBeGreaterThan(0);
  });

  it("filters by event type", async () => {
    await deliver("pull_request", retarget(fixture("pull_request.opened"), shortId));
    await deliver("check_run", fixture("check_run.completed_success"));
    const res = await h.app.request(
      "/api/v0/boards/kb/github/audit?event_type=check_run",
      { headers: bearer },
      ENV,
    );
    const body = (await res.json()) as any;
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].event_type).toBe("check_run");
  });

  it("filters to errors only", async () => {
    await deliver("pull_request", retarget(fixture("pull_request.opened"), shortId));
    await deliver("pull_request", null, { raw: "{bad" });
    const res = await h.app.request(
      "/api/v0/boards/kb/github/audit?errors_only=1",
      { headers: bearer },
      ENV,
    );
    const body = (await res.json()) as any;
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].error).toBe("malformed-json");
  });

  it("records a delivery that matched nothing, so silence is visible", async () => {
    await deliver("pull_request", fixture("pull_request.opened_no_ref"));
    const res = await h.app.request("/api/v0/boards/kb/github/audit", { headers: bearer }, ENV);
    const body = (await res.json()) as any;
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].matched_issue_ids).toEqual([]);
  });

  it("requires admin", async () => {
    const res = await h.app.request("/api/v0/boards/kb/github/audit", {}, ENV);
    expect(res.status).toBe(401);
  });
});

// ── EFB-66: github-driven transitions emit BoardEvents ────────────────────
//
// Before this, a github webhook could move a card and the world would not
// hear about it: no SSE frame for connected clients, and no 30553 on the
// substrate — the publish path hangs off a board event that was never raised.
// EFB-56 fixed the half where the statusChangeCache id was discarded; these
// pin the half where the id was kept and still went nowhere.
describe("EFB-66 — github transitions emit board events", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const issueEvents = () =>
    h.emitter.events.filter((e) => e.event.kind.startsWith("issue."));
  const transitions = () =>
    issueEvents().filter(
      (e) => e.event.kind === "issue.transitioned" || e.event.kind === "issue.container_changed",
    );

  it("emits issue.transitioned for a column move, carrying the 30553's row id", async () => {
    const before = transitions().length;
    const res = await deliver("pull_request", retarget(fixture("pull_request.closed_merged"), shortId));
    expect(res.status).toBe(200);

    const emitted = transitions().slice(before);
    expect(emitted).toHaveLength(1);
    const event = emitted[0]!.event;
    expect(event.kind).toBe("issue.transitioned");
    expect(event.issue_id).toBe(issueRow()["id"]);

    // The envelope id must be the statusChangeCache row this delivery wrote —
    // that row id IS the 30553's `d` tag, so a mismatch here publishes an
    // audit event keyed to the wrong change.
    const row = h.db.statusChanges.find((r) => r["to_status"] === "Done")!;
    expect(row).toBeDefined();
    expect((event as { status_change_id?: string }).status_change_id).toBe(row["id"]);

    const payload = event.payload as Record<string, unknown>;
    expect(payload["from_status"]).toBe(row["from_status"]);
    expect(payload["to_status"]).toBe("Done");
    // github moves are attributed to the webhook actor, never to the assignee.
    expect(String(payload["actor_pubkey"])).toMatch(/^github:/);
    expect(payload["actor_pubkey"]).toBe(row["actor_pubkey"]);
  });

  // The payload carries the issue POST-transition. publish.ts builds the 30551
  // from payload.issue and returns null without it, so an event that omits the
  // row would stamp a 30553 while the substrate's copy of the issue silently
  // kept the old status — an audit trail saying a card moved, next to a card
  // that never did.
  it("carries the post-transition issue row, not the pre-transition one", async () => {
    await deliver("pull_request", retarget(fixture("pull_request.closed_merged"), shortId));
    const event = transitions().at(-1)!.event;
    const issue = (event.payload as { issue?: Record<string, unknown> }).issue;
    expect(issue).toBeDefined();
    expect(issue!["id"]).toBe(issueRow()["id"]);
    expect(issue!["status"]).toBe("Done");
    expect(issue!["status"]).toBe(issueRow()["status"]);
  });

  it("emits issue.container_changed for a container move, with from/to container", async () => {
    const put = await h.app.request(
      "/api/v0/boards/kb/github/rules",
      jsonReq("PUT", {
        rules: [
          {
            bucket: "match",
            when: { event: "pull_request", action: "opened" },
            do: { type: "set_container", container: "active" },
          },
        ],
      }),
      ENV,
    );
    expect(put.status).toBe(200);

    const before = transitions().length;
    const res = await deliver("pull_request", retarget(fixture("pull_request.opened"), shortId));
    expect(res.status).toBe(200);

    const emitted = transitions().slice(before);
    expect(emitted).toHaveLength(1);
    const event = emitted[0]!.event;
    // The kind that would have been missed by emitting only issue.transitioned.
    expect(event.kind).toBe("issue.container_changed");
    const payload = event.payload as Record<string, unknown>;
    expect(payload["to_container"]).toBe("active");
    expect(payload).not.toHaveProperty("to_status");
    const row = h.db.statusChanges.find((r) => r["to_container"] === "active")!;
    expect((event as { status_change_id?: string }).status_change_id).toBe(row["id"]);
  });

  // Only transitions. A webhook that labels, assigns or comments has moved
  // nothing, and emitting a transition for it would put a phantom move on the
  // substrate's audit trail.
  it("emits no transition event for a non-transition action", async () => {
    const put = await h.app.request(
      "/api/v0/boards/kb/github/rules",
      jsonReq("PUT", {
        rules: [
          {
            bucket: "match",
            when: { event: "pull_request", action: "opened" },
            do: { type: "add_label", label: "from-github" },
          },
        ],
      }),
      ENV,
    );
    expect(put.status).toBe(200);

    const before = transitions().length;
    const res = await deliver("pull_request", retarget(fixture("pull_request.opened"), shortId));
    expect(res.status).toBe(200);
    expect(transitions().slice(before)).toHaveLength(0);
  });

  it("publishes BOTH the 30551 and the 30553 on a public board", async () => {
    h = makeHarness();
    await createBoard(h, "kb", { visibility: "public" });
    const issue = await createIssue(h, { title: "Wire the pill" });
    shortId = issue.short_id!;
    boardId = h.db.boards[0]!["id"] as string;
    await connect();
    secret = await mintSecret();
    await settle();

    const before = h.audience.calls.length;
    const res = await deliver("pull_request", retarget(fixture("pull_request.closed_merged"), shortId));
    expect(res.status).toBe(200);
    await settle();

    const posted = h.audience.calls
      .slice(before)
      .map((c) => (c.body as { event?: { kind: number; id: string } }).event)
      .filter((e): e is { kind: number; id: string } => e !== undefined);
    // Both, not one instead of the other — the 30551 is the issue's new state,
    // the 30553 is the record that it changed.
    expect(posted.map((e) => e.kind).sort()).toEqual([30551, 30553]);

    const changeRow = h.db.statusChanges.find((r) => r["to_status"] === "Done")!;
    const issueRowNow = h.db.issues.find((r) => r["id"] === issue.id)!;
    expect(changeRow["substrate_event_id"]).toBe(posted.find((e) => e.kind === 30553)!.id);
    expect(issueRowNow["substrate_event_id"]).toBe(posted.find((e) => e.kind === 30551)!.id);
  });
});
