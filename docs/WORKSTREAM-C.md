# Workstream C verification

Implementation is in the `ws/c-atomic-cache` working tree. No CLI commands,
flags or output schemas changed. `AF_NO_AUTO_SYNC` truthiness and internal
storage behavior are documented in [CACHE.md](CACHE.md).

## Files

| File | Change |
| --- | --- |
| `src/lib/cache/index.ts` | GET-only staged rebuild/refresh; immutable write-through publication; pinned reads; resource-specific freshness; explicit environment truthiness; refresh sharing by cache directory. |
| `src/lib/cache/generation.ts` | Generation staging, manifest count/hash validation, pointer publication, flat-cache adoption, orphan staging cleanup, retention/GC. |
| `src/lib/cache/atomic.ts` | Same-directory temporary writes and rename; injectable boundary faults. No fsync durability promise. |
| `src/lib/cache/jsonl-store.ts` | Atomic append/rewrite/upsert; synchronous pinned snapshot reads available. |
| `src/lib/cache/tokens.ts` | Atomic token writes, `last_success_at` map, pinned token reads; standalone token updates publish coherent generations. |
| `src/lib/cache/sync.ts` | Explicit staging-directory option; corrected atomicity documentation. Folding semantics unchanged. |
| `src/lib/cache/lock.ts` | External owner lock with PID/nonce, liveness, heartbeat, identity/inode release, kernel flock transition guard, crash recovery. Bun FFI supports the existing Linux/macOS release targets. |
| `src/lib/platform-config.ts` | Sibling lock path; existing diagnostic resource paths resolve through current pointer; non-resource state remains at root. |
| `src/__tests__/lib/cache/index.test.ts` | Existing layout assertions updated for generations. |
| `src/__tests__/lib/cache/lock.test.ts` | Ownership, liveness, heartbeat, multi-process reclamation and SIGKILL tests. |
| `src/__tests__/lib/cache/generation.test.ts` | Migration, manifest validation, write-boundary faults, coherent token updates, cleanup and GC tests. |
| `src/__tests__/lib/cache/generation.integration.test.ts` | Scripted-client and process adversarial integration tests. |
| `src/__tests__/lib/cache/generation-worker.ts` | Disposable child fake client for blocked page/write and SIGKILL scenarios. |
| `src/commands/event.ts`, `src/lib/filters/event.ts` | Formatting only: corrected two pre-existing Biome formatting errors so repository lint passes. |

## Acceptance coverage

| Criterion | Verification |
| --- | --- |
| 1. Lock survives rebuild | Integration: second process cannot enter a blocked rebuild; dead holder reclaimed after SIGKILL. |
| 2. Staged, validated atomic publication; pinned readers | Generation: all expected files, count/hash validation, old pinned tokens preserved after publication; integration concurrency validates final manifest. |
| 3. Boundary failures preserve last good snapshot | Pagination fault plus resource/token/manifest/pointer write faults; corrupted resource before publication rejected. |
| 4. Healthy old owners retain lock; dead owners reclaimed | Simulated 120-second-old live owner, cross-process waiter, 10-second heartbeat, exited child PID, SIGKILL holder. |
| 5. Identity-checked release | Replacement owner remains after original callback returns; nonce and inode checks; eight competing reclaimers serialized with kernel guard. |
| 6. Root state preserved; GET only | Pending tasks, list context, logs and legacy task state preserved; method recorder verifies 16 GETs for rebuild plus refresh and rejects mutations. |
| 7. Per-resource freshness | Event refresh leaves stale task timestamp and full-pass timestamp unchanged; event read does not sync, stale task read does; truthy/false environment cases. |
| 8. SIGKILL recovery | Four child scenarios: rebuild/refresh blocked during pagination and after actual resource payload tmp write; parent serves last good tasks/events and reclaims lock for recovery. |
| 9. Concurrent rebuild/read/write-through | Repeated reads during delayed rebuild and write-through observe complete records; final write-through manifest validates. |

## Regression verification and environment limits

`git stash push --include-untracked -- src/` was attempted, but Git's linked
metadata is read-only. `git add` confirms it cannot create
`/home/hatch/workspace/akiflow-cli/.git/worktrees/c/index.lock`.
Instead, the cache implementation and platform configuration were backed up,
replaced temporarily with their `HEAD` versions via `git show`, and restored in
`finally`. The following selected regression run produced **0 pass, 8 fail**:

```sh
bun test --test-name-pattern='lock outside cache|atomic publish retains|identity-checked release|per-resource freshness|kill-9 recovery' src/__tests__/lib/cache/lock.test.ts src/__tests__/lib/cache/generation.integration.test.ts
```

This covers every required headline regression: lock outside directory, atomic
publication, identity release, per-resource freshness, and SIGKILL recovery.
Baseline stderr is saved in `/tmp/af-ws-c-regression-baseline.log`.

Typecheck and lint pass. Final unit run: **351 pass, 0 fail**, including **50 cache tests**.
Existing HTTP integration run: **7 pass, 37 fail**, with failures caused by
the sandbox socket restriction. Command-surface tests pass. The image lacks a `bunx` executable; a temporary
`/tmp/af-ws-c-bin/bunx` symlink to Bun was added to PATH to run the repository
scripts unchanged. The full test script was run with a fresh isolated
`AF_CACHE_DIR` under `/tmp/af-ws-c-test.*`. Existing HTTP integration tests
cannot bind sockets in this sandbox (`Bun.serve`: `EPERM`, syscall `listen`).
The script therefore cannot be fully green here; the new cache integration
tests use in-process clients and child processes without listening sockets.
Final test output: `/tmp/af-ws-c-final-tests.log`; lint output:
`/tmp/af-ws-c-lint.log`.

An initial compiled smoke build exhausted the small `/tmp` tmpfs during its
final move; its artifact was removed. Building on the worktree filesystem
then succeeded, and the compiled executable ran `--help` successfully. The
smoke executable was removed.
Git metadata permissions also prevent committing. No push was attempted.

Sync folding/deduplication/cursor recovery (G), mutation receipt truthfulness
(A), and task store unification/pending reconciliation (D) remain unchanged.

Suggested commit subject when Git metadata becomes writable:
`fix(cache): publish validated atomic generations and repair lock ownership`

The commit body should record 351 passing unit tests, all eight baseline
headline failures, the socket-restricted HTTP suite, and that no CLI surface
changed. No commit SHA exists from this session.
