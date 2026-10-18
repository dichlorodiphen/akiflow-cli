# JSON contracts, verification, and recovery

Applies to local audited build `0.3.6-audit.1` (upstream base `1ff76ab` plus local fixes). Check the installed version and provenance after an update.

## Read output

`--json --envelope` opts into the universal wrapper. `--envelope` alone does not request JSON. `AF_JSON_ENVELOPE=1` opts in globally; `--no-envelope` overrides it. Legacy JSON remains the default and prints a migration announcement to stderr. Read stdout as JSON and stderr as diagnostics.

The universal envelope has `schema_version: 1`, `command`, `status: ok|error|partial`, `result`, `errors`, `warnings`, and `meta.exit_code`. Check the exit code and errors as well as status.

Do not assume every result is an array:

| Command | Result in universal envelope |
| --- | --- |
| `task list` | Cleaned task array; `meta.snapshot` pins numbered IDs |
| `cal` | Cleaned calendar entry array |
| `cal --summary` | `{counts: {event, slot, task}, total, busy_minutes}` |
| `cal --free` | `[{start, end}]` |
| `audit` | `{schema_version: 1, audit, envelope}`; its inner `envelope` is a calendar review, not a mutation receipt |
| `reconcile` | Report object; inspect `complete`, coverage, diagnostics, and tiers |

Cleaned task fields include `datetime_tz`, `calendar_id` (replaces the incorrect `linked_event_id` label), `linked_slot_id`, and the full `recurring.rule` when available. Pending local task intents appear as `pending: true`; conflicts can add `pending_conflict`. Raw output is for investigating source fields and identities.

## Mutation receipts

Prefer `--json --no-envelope` for mutations. Their native JSON already carries `schema_version: 1`, `command`, `status`, `receipts`, `result`, `errors`, and `warnings`. Native status is `accepted`, `verified`, `failed`, `unknown`, `pending`, `mismatch`, or `timeout`; inspect per-record outcomes for partial writes. A preview has no mutation receipt and instead reports proposed changes.

If universal envelope mode is used on a mutation, outer `status` describes process completion, while original mutation `status` and `receipts` move into `meta.status` and `meta.receipts`. An outer `status: ok` can mean only that an operation was accepted. Never mistake that for verification.

Event receipts retain `operation_id`, target event ID, processing diagnostics and any verification result. Task/slot receipts identify the resource and individual requested IDs. Preserve these IDs in an uncertain outcome report.

Add `--verify` to the original command when confirmation is required. Task create/update/plan/snooze/complete/delete, event create/update/delete/attendee changes, slot create/update/delete, batch event changes, and executed conversions expose it. It polls fresh Akiflow reads for up to 15 seconds. Requested fields, instants, and timezone strings are compared; deletion needs an observed tombstone. It does not verify Google application. Slot deletion verification specifically requires a tombstone; recurring creation verification includes the requested rule.

Receipt guidance that says “re-run with --verify” is unsafe when interpreted as repeating the write. A timeout, missing record, or failed read does not prove the write never happened. Refresh and identify the actual record before deciding whether another write is appropriate. For creation/conversion, inspect target IDs, provider state if needed, and the journal; a missing cached target alone is not a reason to recreate it.

Exit codes are 0 success, 2 validation/usage, 3 auth, 4 not found, 5 upstream, 6 partial success; 7 is reserved for verification timeout. Some failures, including verification uncertainty, still use legacy 1. Classify outcomes from receipts/errors rather than expecting timeout to exit 7. Unknown flags, removed commands, invalid selectors, and extra positionals fail validation before authentication/cache work.

## Freshness and cache

```bash
af refresh --json
af refresh --rebuild --json
af doctor --strict --json
```

Refresh obtains new observations; rebuild is useful when diagnosing stale/inconsistent event views. Inspect refresh errors rather than assuming it succeeded because local reads still work. The cache uses immutable generations with ownership locking. Pending task intentions live separately in `pending-tasks.json`; list context and event/conversion journals are also outside generation resources.

Pending intentions are retained until observed fields match, not merely until an ID appears or a timestamp changes. A locally hidden delete intention is not an observed deletion. Calendar/audit pin task/event/slot/calendar observations together, then overlay local intentions without repinning or writing. Intent-only tasks have null observedAt. A newer explicit server tombstone suppresses older pending intentions; age or uncertain absence alone does not. This is not proof of an atomic fresh server snapshot.

`cal` warns if events are unsynced or older than 10 minutes. It also suspects same-title overlaps and unequal similar-title reshape leftovers. Rebuild stale data and recheck before taking action. A warning neither establishes a duplicate nor authorizes deletion. If identity, recurrence exceptions, or provider sync remain ambiguous, inspect the calendar UI. Do not edit JSONL cache records as a repair for real provider events.

## Authentication and diagnosis

```bash
af auth status
af auth login
af auth refresh
af doctor --strict --json
```

`auth login` explicitly scans browser storage for existing Akiflow tokens and saves them; it is not an OAuth browser sign-in flow. Bare `af auth` prints help. `auth refresh` renews tokens without intentionally deleting saved credentials on failure; without a refresh token, it falls back to browser import. `auth logout` removes local saved credentials and should be used only when requested. `doctor --strict` grades checks, gives recovery instructions, and exits nonzero for critical checks.

Configuration defaults to `~/.config/af`; cache defaults to `~/.cache/af`. `AF_CONFIG_DIR`/`AF_CACHE_DIR` override those paths. `AF_NO_AUTO_SYNC=1` disables implicit synchronization, but explicit refresh still requests new data. Avoid dumping credentials or token files during diagnosis.
