// EFB-87 — synthetic handler whose query read is INVISIBLE to detection.
//
// The query half of the same drift: this route reads params, but through
// `readParams` — the name you get by extracting a helper and not updating
// QUERY_MARKERS. No marker matches, so detection classifies it as reading no
// query at all, and an allowlist entry for it used to pass in silence.
//
// `readParams` is `declare`d rather than defined, for the reason the fixtures
// next door record: a real body here would contain `c.req.query(`, which
// `withHelpers` resolves one level deep, and the blind spot the fixture exists
// to reproduce would disappear.

type FakeContext = {
  req: { query: (key?: string) => string | undefined };
  json: (value: unknown) => unknown;
};

declare const readParams: (c: FakeContext) => Record<string, string | undefined>;

const router = {
  get: (_path: string, _handler: (c: FakeContext) => unknown) => {},
};

router.get("/synthetic/renamed", async (c: FakeContext) => {
  const params = readParams(c);
  return c.json({ status: params["status"], container: params["container"] });
});

// A module, not a script: these fixtures declare the same helper names, and at
// global scope TypeScript sees them as redeclarations of each other.
export {};
