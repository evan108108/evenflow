// EFB-71 — synthetic MIGRATED handler. Not wired into the app.
//
// The control for the fixture next door. Same route, same params, read through
// `parseRouteQuery`. Asserting only that the checker FAILS on bad input would
// leave "fails on everything" indistinguishable from "fails on the right
// thing"; this file is what makes the pass meaningful.
//
// `parseRouteQuery` is `declare`d rather than defined, on purpose: a stub with
// a real body would contain `c.req.query(` itself, and `withHelpers` resolves
// same-file helpers one level deep — so the fixture would classify as "mixed"
// and the control would prove the opposite of what it is for.

type FakeContext = {
  req: { query: (key?: string) => string | undefined };
  json: (value: unknown) => unknown;
};

declare const parseRouteQuery: (
  c: FakeContext,
  schema: unknown,
) => Record<string, string | undefined>;

declare const SyntheticQuery: unknown;

const router = {
  get: (_path: string, _handler: (c: FakeContext) => unknown) => {},
};

router.get("/synthetic/migrated", async (c: FakeContext) => {
  const q = parseRouteQuery(c, SyntheticQuery);
  return c.json({ status: q["status"], container: q["container"] });
});

// A module, not a script: these two fixtures declare the same helper names,
// and at global scope TypeScript sees them as redeclarations of each other.
export {};
