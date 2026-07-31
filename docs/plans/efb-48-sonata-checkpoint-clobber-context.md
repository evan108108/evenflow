# EFB-48 — Sonata core: checkpoint clobber for parallel dispatches

Ticket: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-48`

## Scope one-liner

Fix Sonata core's `mem_checkpoint_save` / `mem_checkpoint_restore` so parallel dispatches from one session don't clobber each other. **Different repo — this is Sonata core work at `/Users/evan/memory/`, not evenflow.**

## Load-bearing surprises

1. **This is Sonata core, not evenflow.** Repo is `/Users/evan/memory/`. Deploy freely per user memory. Restart-test after.

2. **Bug has THREE distinct failure modes reproduced multiple times today** (by different workers, across 4 dispatch batches):
   - **Single-slot clobber:** second dispatch overwrites first within seconds. File is `~/.sonata/scratch/active-checkpoint-<sessionId>.md`.
   - **Write-ordering race:** worker read timing doesn't save you; the file IS the newer (wrong) one, timestamp doesn't distinguish which is "yours."
   - **Wrong-fallback:** worker-scoped restore falls through to whatever legacy/global row exists (once reported as supervisor's checkpoint) when the worker has no own checkpoint. After the worker DOES save one, wrong-fallback becomes "return your own stale checkpoint from a prior batch" — plausibly-coherent, worse than the obviously-foreign fallback.

3. **The current workaround workers use is content-verification** — restore, read the state text, verify it names the task by content, fall back to reading the brief from origin/main if it doesn't match. Works but is a discipline every worker has to remember; a Sonata-core fix would remove the discipline requirement.

4. **Checkpoint id already exists in the dispatch payload.** Worker leans (option 1 from ticket body): key storage by checkpoint id, not session id. Restore-by-id becomes trivial; restore-latest-for-session still works via an index.

5. **Grep Sonata source at `/Users/evan/memory/`** for `mem_checkpoint_save`, `mem_checkpoint_restore`, `active-checkpoint-`. Likely in `Sources/Server/` or similar. Read before designing.

## Files to touch (probable — verify by grep)

- Wherever `mem_checkpoint_save` handler lives in Sonata core (Swift)
- Wherever `mem_checkpoint_restore` handler lives
- Storage layer that writes `~/.sonata/scratch/active-checkpoint-<sessionId>.md`
- Tests — Sonata core probably has Swift tests; add coverage for parallel dispatch scenarios

## Testing

- Two parallel `mem_checkpoint_save` calls from same session with distinct checkpoint ids → both retrievable via their own id
- `mem_checkpoint_restore` by id → returns exactly that checkpoint
- `mem_checkpoint_restore` by session only → returns most recent for that session (not global fallback)
- Regression: existing single-dispatch flow unchanged

## Deploy context

- Sonata core at `/Users/evan/memory/`. Deploy freely per user memory.
- MUST restart Sonata after deploy to test.
- No evenflow-side changes.

## Key IDs

- Sona session id (for testing parallel dispatch): `f4e8ed22-897d-418a-a96d-1ebe6fa340e4`
- Multiple worker ids are available; grep worker_list for the pool

## Related

- EFB-38, EFB-44, EFB-51/52, EFB-33 all reproduced this bug during their dispatches
- Worker-2 (EFB-44) diagnosed the single-slot mechanism
- Worker-6 (EFB-51/52) reproduced wrong-fallback-to-stale
- Worker-3 (EFB-47) reproduced twice

## Coordination points — DM me before

- Any change to the MCP tool signatures (`mem_checkpoint_save`, `mem_checkpoint_restore`) — that would ripple to every worker's discipline
- Storage layout change (moving from file-per-session to something else) — needs migration path
- Any change beyond the checkpoint tools (this is a scoped fix, not a broader refactor)

## DM FLOW — MANDATORY

1. **DM Sona (session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4`)** with questions.
2. Sona is AFK; replies via channel notifications.
3. Status DMs after grep-of-current-implementation, after design decision, after implementation, before restart-and-test.
4. **DO NOT `worker_event_complete` until Sona reviewed AND said shipit.**
5. Use `dm_send` targeting session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4` or `dm_reply`.

## Checkpoint caveat

Multiple parallel dispatches out today, including this one. IRONIC BUT REAL: verify checkpoint by content. State should say "EFB-48 dispatch". If not, restore from brief committed on origin/main.

## Standing rules

- NO deploy without approval (even though user memory allows freely — coordinate).
- Different repo from evenflow.
- Restart-test after any Sonata core change.
