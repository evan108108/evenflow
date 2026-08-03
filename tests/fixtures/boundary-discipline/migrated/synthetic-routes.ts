// EFB-87 — synthetic MIGRATED handler. Not wired into the app.
//
// The falsification target for the re-audit: point the checker here WITH an
// allowlist entry for this route and it must fail, because the entry claims
// debt that the code no longer has. That is the ordinary end of a migration
// with step 4 (remove the route from the allowlist) skipped, and before EFB-87
// it was a warning nobody had to read.
//
// `parseRouteBody` is `declare`d rather than defined, for the reason the query
// fixtures record next door: a stub with a real body would contain a raw body
// read itself, `withHelpers` resolves same-file helpers one level deep, and the
// fixture would classify as "mixed" — proving the opposite of what it is for.

type FakeContext = {
  req: { json: () => Promise<unknown> };
  json: (value: unknown) => unknown;
};

declare const parseRouteBody: (c: FakeContext, schema: unknown) => Record<string, unknown>;

declare const SyntheticBody: unknown;

const router = {
  post: (_path: string, _handler: (c: FakeContext) => unknown) => {},
};

router.post("/synthetic/migrated", async (c: FakeContext) => {
  const body = parseRouteBody(c, SyntheticBody);
  return c.json({ title: body["title"] });
});

// A module, not a script: the fixtures in this tree declare the same helper
// names, and at global scope TypeScript sees them as redeclarations.
export {};
