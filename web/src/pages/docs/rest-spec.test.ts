// EFB-98: the /docs page hands readers URLs they will paste into a terminal.
//
// Before this ticket every path on that page was stale — it advertised
// `/orgs/:org/boards/:slug` after the rename and `/issues/:ref/promote_to_active`
// after that route was deleted outright. A reader copying either got a 404,
// which is the bug that opened this ticket wearing a different hat: a URL that
// looks right, is not served, and fails somewhere far from the mistake.
//
// The method and path now derive from the manifest, so those cannot drift. The
// curl SAMPLES are still hand-written prose, and prose drifts — so this file
// checks them mechanically against the route they claim to demonstrate.

import { describe, expect, it } from "vitest";

import { API_BASE, effectivePaths, route } from "@routes-manifest";
import { MCP_TOOLS, REST_SECTIONS, methodOf, pathOf } from "./rest-spec";

const ENDPOINTS = REST_SECTIONS.flatMap((s) => s.endpoints);

/** Does a concrete URL path match a route template, treating `:x` as a hole? */
const matchesTemplate = (concrete: string, template: string): boolean => {
  const a = concrete.split("/").filter(Boolean);
  const b = template.split("/").filter(Boolean);
  if (a.length !== b.length) return false;
  return b.every((want, i) => want.startsWith(":") || want === a[i]);
};

describe("rest-spec", () => {
  it("documents only routes that exist", () => {
    // route() throws on an unknown id, so this also pins that every documented
    // id survives a future rename rather than silently describing nothing.
    for (const e of ENDPOINTS) expect(() => route(e.id)).not.toThrow();
    expect(ENDPOINTS.length).toBeGreaterThan(20);
  });

  // Two kinds of sample, and the rule is total over both rather than skipping
  // one. A sample either SHOWS a URL — in which case the route has to serve it
  // — or it shows none at all, which is how an endpoint nobody invokes by hand
  // (GitHub's own delivery target) says so. What is not allowed is the middle:
  // a sample that names a URL the server does not answer.
  const isNote = (curl: string) => curl.trimStart().startsWith("#");

  it("shows a curl whose URL is actually served by the route it documents", () => {
    const offenders: string[] = [];
    for (const e of ENDPOINTS) {
      const match = /https:\/\/evenflow\.work(\/[^\s"']*)/.exec(e.curl);
      if (isNote(e.curl)) {
        // A note must not smuggle a URL in: no address, nothing to go stale.
        if (match !== null) offenders.push(`${e.id}: explanatory note still names a URL`);
        continue;
      }
      if (match === null) {
        offenders.push(`${e.id}: curl names no evenflow.work URL`);
        continue;
      }
      const concrete = (match[1] ?? "").split("?")[0] ?? "";
      const served = effectivePaths(route(e.id)).some((t) => matchesTemplate(concrete, t));
      if (!served) offenders.push(`${e.id}: curl path ${concrete} matches no path this route serves`);
    }
    expect(offenders).toEqual([]);
  });

  it("shows a curl whose HTTP method matches the documented one", () => {
    const methodIn = (curl: string) => /-X\s+([A-Z]+)/.exec(curl)?.[1] ?? "GET";
    const offenders = ENDPOINTS.filter((e) => !isNote(e.curl) && methodOf(e) !== methodIn(e.curl)).map(
      (e) => `${e.id}: documented ${methodOf(e)}, curl sends ${methodIn(e.curl)}`,
    );
    expect(offenders).toEqual([]);
  });

  it("keeps every documented path under the API base", () => {
    for (const e of ENDPOINTS) expect(`${API_BASE}${pathOf(e)}`.startsWith(API_BASE)).toBe(true);
  });

  it("still lists the MCP tools", () => {
    expect(MCP_TOOLS.length).toBeGreaterThan(0);
  });
});
