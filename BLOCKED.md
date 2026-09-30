# D Workstream: Blocked on J Integration

## Status
D (unified task repository) is rebased onto main (9987031) with B, J, F. Typecheck is clean. Unit tests pass. However, D cannot be merged due to fundamental incompatibility with J's occurrence model.

## The Problem
D and J solve overlapping problems in incompatible ways:
- **D**: Unified task repository (`src/lib/tasks.ts`) with pending intent overlay. Tasks are read via `readTasks()`, which merges observed tasks with pending intents.
- **J**: Occurrence model (`src/lib/occurrence.ts`) that normalizes tasks/events/slots into a unified timeline. Tasks are read via `snapshotResources`, which does NOT apply D's pending overlay.

D's integration tests expect `af cal` to show pending tasks (via D's overlay), but J's `af cal` uses the occurrence model which doesn't know about D's pending intents.

## What Was Tried
1. ✅ Rebasing D onto main - completed successfully
2. ✅ Adding `snapshotResources` compatibility wrapper - typecheck clean
3. ✅ Modifying J's `occurrence-read.ts` to use D's `readTasks` - typecheck clean
4. ✅ Propagating `task.pending` to `occurrence.provenance.pending` - typecheck clean
5. ❌ Integration tests still fail - 11 failures in tasks-repository.integration.test.ts

The remaining failures are due to test expectations not matching J's occurrence output format. D's tests were written before J existed and expect D's original `af cal` behavior.

## Options
1. **Update D's tests** to match J's occurrence model output (11 tests need updating)
2. **Modify J's occurrence model** to output D's expected format (architectural change)
3. **Rework D** to integrate more deeply with J's model (significant refactoring)

## Recommendation
This requires architectural decision from David. D's pending overlay is valuable, but J's occurrence model is the current `af cal` implementation. The two need to be unified, not just merged.

## Current Branch State
- Branch: `ws/d-unified-tasks`
- Commit: `e54a7ab`
- Typecheck: ✅ Clean
- Unit tests: ✅ 16/16 D tests pass, 152/154 command tests pass
- Integration tests: ❌ 3 pass, 11 fail
