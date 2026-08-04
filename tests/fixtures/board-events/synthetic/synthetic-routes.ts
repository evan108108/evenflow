// EFB-104 — synthetic board-mutating routes. Not wired into the app.
//
// These exist so `check:board-events` can be proven to FAIL, on every CI run,
// rather than trusted because it passed once against a codebase that happened
// to be clean. The real tree has no missing emits today, so without a fixture
// the check's failure path would never execute — and a guard whose failure
// path never runs is indistinguishable from one that cannot fail. The `--json`
// output looks identical either way.
//
// tests/board-events.test.ts points the checker's --routes-dir and --src-dir
// here, with a manifest naming one route or the other, and asserts the exit
// code flips.
//
// Deliberately self-contained: fake router, local `path`, local emit. It must
// be scannable text with a real registration in it, must typecheck on its own,
// and must never be reachable from the real app.

interface FakeContext {
  readonly param: (key: string) => string;
}

interface BoardEventish {
  readonly kind: string;
  readonly board_id: string;
}

/** Stands in for src/audiences.ts's publisher — the marker the check hunts. */
const emitSecureBoardEvent = (boardId: string, event: BoardEventish): string =>
  `${boardId}:${event.kind}`;

/** Stands in for the manifest's `path()` — the check keys on the id inside. */
const path = (id: string): string => `/${id}`;

const router = {
  post: (_path: string, _handler: (c: FakeContext) => unknown) => {},
};

/**
 * The bug shape: writes board-visible state, tells nobody. A card moved by
 * this route stays wrong in every open tab until the poll heals it.
 */
const silentAction = (c: FakeContext): string => {
  const boardId = c.param("board_id");
  return `moved ${boardId}, told nobody`;
};

/** The same write, done correctly. */
const emittingAction = (c: FakeContext): string => {
  const boardId = c.param("board_id");
  return emitSecureBoardEvent(boardId, { kind: "issue.transitioned", board_id: boardId });
};

/**
 * Indirection on purpose. The emit is two calls deep, so this fixture also
 * pins that the walk follows a call graph rather than only grepping the
 * handler span — the exact thing that made the first, text-based version of
 * the check report `board.archive.set` as silent when it emits.
 */
const emittingHandler = (c: FakeContext): string => emittingAction(c);

router.post(path("synthetic.silent"), (c) => silentAction(c));
router.post(path("synthetic.emitting"), (c) => emittingHandler(c));

/**
 * Borrows a REAL id that is declared in the check's NO_EMIT list, so the
 * stale-exemption guard can be exercised: here the route does emit, which
 * makes the declaration a lie. That matters because an exemption is the one
 * kind of entry that silently un-checks a route — if `search.board` ever grows
 * an emit for real, nobody would notice the declaration had become wrong.
 *
 * Safe despite the name collision: this file is only ever scanned with an
 * injected --manifest-json, never during the real run.
 */
router.post(path("search.board"), (c) => emittingHandler(c));
