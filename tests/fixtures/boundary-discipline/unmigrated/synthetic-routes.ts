// EFB-87 — synthetic UN-migrated handler. Not wired into the app.
//
// The body check shipped in EFB-54 with no test that runs it at all; only the
// query half (EFB-71) got fixtures proving it can fail. So the older, more
// security-relevant of the two checks was the one trusted purely because it had
// been observed passing — which is indistinguishable from a check that cannot
// fail. This file and its siblings close that, on the same principle the query
// fixtures record: evidence stapled to a PR proves the check worked once, a
// test proves it still does.
//
// Deliberately self-contained: fake Context, fake router, no imports from src.
// Scannable text with a real registration in it, typechecks on its own, never
// reachable from the real app.

type FakeContext = {
  req: { json: () => Promise<unknown> };
  json: (value: unknown) => unknown;
};

const router = {
  post: (_path: string, _handler: (c: FakeContext) => unknown) => {},
};

// The shape the ratchet exists to reject: an untyped bag, hand-checked for
// whatever the author remembered. What they forgot is invisible by
// construction — no error, just a plausible-looking result.
router.post("/synthetic/unmigrated", async (c: FakeContext) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  if (typeof body["title"] !== "string") return c.json({ error: "invalid-body" });
  return c.json({ title: body["title"] });
});

// A module, not a script: the fixtures in this tree declare the same helper
// names, and at global scope TypeScript sees them as redeclarations.
export {};
