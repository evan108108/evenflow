// EFB-87 — synthetic handler whose body read is INVISIBLE to detection.
//
// This is the drift class EFB-61 named, reproduced. The route reads a body, but
// through `readRequestBody` — the name you get by renaming the local
// `readJsonBody` helper and not updating UNMIGRATED_MARKERS. No marker matches,
// so the checker classifies it as reading no body at all.
//
// The asymmetry that made this worth a ticket is what the tests assert against
// this one file:
//
//   not allowlisted -> the checker already failed loudly ("no body read
//                      detected, but that is not proof there is none")
//   allowlisted     -> it PASSED, silently, because the allowlist flipped the
//                      route back to "unmigrated" and nothing re-checked that
//                      the flip was standing on anything.
//
// So the allowlist made the check quieter about the route it knew least about.
//
// `readRequestBody` is `declare`d for the same reason `parseRouteBody` is in
// the fixture next door: a real body here would contain `c.req.json(`, which
// `withHelpers` would resolve and classify as a detected read, erasing the
// blind spot the fixture exists to reproduce.

type FakeContext = {
  req: { json: () => Promise<unknown> };
  json: (value: unknown) => unknown;
};

declare const readRequestBody: (c: FakeContext) => Record<string, unknown>;

const router = {
  post: (_path: string, _handler: (c: FakeContext) => unknown) => {},
};

router.post("/synthetic/renamed", async (c: FakeContext) => {
  const body = readRequestBody(c);
  if (typeof body["title"] !== "string") return c.json({ error: "invalid-body" });
  return c.json({ title: body["title"] });
});

// A module, not a script: the fixtures in this tree declare the same helper
// names, and at global scope TypeScript sees them as redeclarations.
export {};
