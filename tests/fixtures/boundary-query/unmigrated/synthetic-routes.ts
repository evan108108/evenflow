// EFB-71 — synthetic UN-migrated handler. Not wired into the app.
//
// This file exists so `check:boundary-query` can be proven to FAIL, on every
// CI run, rather than being trusted because it passed once against a codebase
// that happened to be clean. A ratchet that has never been observed failing is
// indistinguishable from a ratchet that cannot fail — the `--json` output
// looks the same either way, and the failure mode is silent: the check keeps
// reporting OK long after a regex stops matching anything at all.
//
// tests/boundary-query.test.ts points the checker's --routes-dir here and
// asserts a non-zero exit naming this route.
//
// Deliberately self-contained: fake Context, fake router, no imports from src.
// It has to be scannable text with a real registration in it, and it must
// typecheck on its own, but it must never be reachable from the real app.

type FakeContext = {
  req: { query: (key?: string) => string | undefined };
  json: (value: unknown) => unknown;
};

const router = {
  get: (_path: string, _handler: (c: FakeContext) => unknown) => {},
};

// The shape the ratchet exists to reject: reads named params one at a time,
// and is structurally blind to any other key the caller sent.
router.get("/synthetic/unmigrated", async (c: FakeContext) => {
  const status = c.req.query("status");
  const container = c.req.query("container");
  return c.json({ status, container });
});

// A module, not a script: these two fixtures declare the same helper names,
// and at global scope TypeScript sees them as redeclarations of each other.
export {};
