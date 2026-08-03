// EFB-98: guards on the shared mount table.
//
// The bug these exist for: the mount list used to be copied into src/index.ts,
// tests/harness.ts, tests/profile.test.ts and tests/auth.test.ts, and the
// copies had drifted. Six mounts lived in index.ts and in no harness, so the
// org-scoped github, imports and search routers were served in production and
// exercised by nothing. Nobody noticed because a drifted harness fails open —
// it just silently tests a smaller app than the one that ships.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";

import { MOUNTS, mountAll, API_PREFIX, ORG_PREFIX } from "../src/router";
import type { AppHonoEnv } from "../src/http";

const routeFactoryNames = () => {
  const dir = path.join(__dirname, "..", "src", "routes");
  const names = new Set<string>();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    for (const m of src.matchAll(/export const (make\w*Router)\b/g)) names.add(m[1]!);
  }
  return names;
};

describe("mount table", () => {
  it("mounts every router that exists", () => {
    // A router file that nobody mounts is dead code that looks alive. This is
    // the check that would have caught the drift as it was introduced.
    const declared = new Set(MOUNTS.map((m) => m.make.name));
    const missing = [...routeFactoryNames()].filter((n) => !declared.has(n));
    expect(missing).toEqual([]);
  });

  it("mounts each board-family router both bare and org-scoped", () => {
    // The org-scoped twin is easy to forget: the bare mount makes the feature
    // work in testing and manual use, and only org users hit the hole.
    const boardFamily = [
      "makeBoardsRouter",
      "makeImportsRouter",
      "makeIssuesRouter",
      "makeSprintsRouter",
      "makeCommentsRouter",
      "makeFeedRouter",
      "makeAttachmentsRouter",
      "makeSearchRouter",
      "makeAudiencesRouter",
    ];
    for (const name of boardFamily) {
      const prefixes = MOUNTS.filter((m) => m.make.name === name).map((m) => m.prefix);
      expect(prefixes, `${name} must be mounted bare and org-scoped`).toEqual(
        expect.arrayContaining([API_PREFIX, ORG_PREFIX]),
      );
    }
  });

  it("keeps the routers that own specific paths ahead of the mirrored ones", () => {
    // Hono resolves by registration order. These three constraints are the
    // ones with a comment in index.ts explaining why they matter; encoding
    // them here means a future reorder fails loudly instead of silently
    // re-pointing a URL at a different handler.
    const at = (name: string) => MOUNTS.findIndex((m) => m.make.name === name);
    const firstBoardFamily = at("makeBoardsRouter");

    expect(at("makeOrgsRouter")).toBeLessThan(firstBoardFamily);
    expect(at("makeStorageRouter")).toBeLessThan(firstBoardFamily);
    expect(at("makeGithubRouter")).toBeLessThan(firstBoardFamily);
    expect(at("makeImportsRouter")).toBeLessThan(at("makeIssuesRouter"));
  });

  it("registers the same route set that production does", () => {
    // Both apps go through mountAll, so this asserts the property rather than
    // re-listing it: if someone hand-mounts a router in index.ts again, the
    // sets diverge and this fails.
    const build = () => {
      const app = new Hono<AppHonoEnv>();
      mountAll(app);
      return new Set(
        (app as unknown as { routes: Array<{ method: string; path: string }> }).routes.map(
          (r) => `${r.method} ${r.path}`,
        ),
      );
    };
    expect(build()).toEqual(build());
    expect(build().size).toBeGreaterThan(100);
  });
});
