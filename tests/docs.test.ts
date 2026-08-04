// EFB-103: /docs/llms.txt — the whole documentation set in one request.
//
// The claim being tested is the one that makes this route worth having: an
// agent with no credential, no JavaScript and no crawler gets everything.

import { describe, expect, it } from "vitest";
import { url, ROUTES } from "../src/routes-manifest";
import { makeHarness } from "./harness";

describe("GET /docs/llms.txt", () => {
  it("serves the documentation to an anonymous caller as text/plain", async () => {
    const h = makeHarness();

    const res = await h.app.request(url("docs.llms"), {}, {});

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("# Evenflow documentation");
    // No credential was sent and none was demanded.
    expect(body).not.toContain("unauthorized");
  });

  it("contains every endpoint the server declares", async () => {
    // The falsification for "an agent can learn the API from one fetch". If a
    // route exists and is absent here, the agent cannot know about it.
    const h = makeHarness();
    const body = await (await h.app.request(url("docs.llms"), {}, {})).text();

    for (const entry of ROUTES) {
      expect(body).toContain(entry.path);
    }
  });

  it("gives an agent the four things the quickstart promises", async () => {
    // Sign in, create a board, add an issue, list keys — the ticket's own
    // agent-falsification, reduced to the claim the document has to support.
    const h = makeHarness();
    const body = await (await h.app.request(url("docs.llms"), {}, {})).text();

    expect(body).toContain("/settings/keys");
    expect(body).toContain("/api/v0/boards");
    expect(body).toContain("/board/:slug/issues");
    expect(body).toContain("Authorization: Bearer");
  });
});
