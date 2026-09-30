# Akiflow CLI Commands Reference

## Parsing and automation contracts

Unknown commands, unknown flags, and extra positional arguments fail before authentication or cache access and name the offending token. Flags accept `--name=value`, `--name value`, declared aliases, short boolean bundles, boolean negation (`--no-name`), and `--` to end option parsing. Variadic IDs/emails are supported only by task complete and attendee commands (including batch attendees). Validation exits with code 2. Invalid date selectors, impossible dates, and partially parsed dates are errors; task list and cal never broaden the selection or substitute today after a parse failure. They share one strict selector parser for `--date`, `--from`, `--to`, and list `--month`.

Every task/event/slot mutation accepts `--dry-run`, including event delete and slot update/delete. Previews read local caches without authentication, sync, or writes. Run `af refresh` first when the inventory is missing. Output includes resolved IDs and titles, normalized before → after values, and the notification policy. Task plan/snooze/delete also accept `--json`. Batch and convert default to this preview mode; `--dry-run` explicitly confirms it. Combining `--execute --dry-run` is a validation error.

```bash
af task update <uuid> --title "New title" --dry-run --json
af event delete <event-id> --send-updates none --dry-run --json
af convert tasks --to events --search "Trip:" --dry-run --json
```

### Snapshot IDs migration

Every task list (text, cleaned JSON, or raw JSON) saves its numbered list and publishes a snapshot token: `Snapshot: <token>` in text and `meta.snapshot` in JSON. Pin numeric IDs with `--snapshot <token>` on task complete/update/plan/snooze/delete. Phase 1 warns loudly and permits unpinned numeric IDs; `AF_STRICT_IDS=1` opts into require-mode now. Phase 2 will require matching tokens by default. A supplied mismatching token already fails.

```bash
af task list --all --json
af task complete 1 --snapshot <token>
```

Full UUIDs work without list context. UUID prefixes resolve against the full cached `tasks.jsonl` inventory; only an unavailable inventory permits a last-list subset fallback. Resolution warnings identify the inventory and warn about that fallback. Virtual IDs (`virtual:<uuid>:<date>`) are synthetic, marked in list output, and rejected for mutation, including when selected through a numeric ID.

### JSON envelope migration

Legacy JSON remains the default. Add `--envelope` to a JSON-producing command, or set `AF_JSON_ENVELOPE=1`, to opt into the versioned contract:

```json
{"schema_version":1,"command":"task list","status":"ok","result":[],"errors":[],"warnings":[],"meta":{"exit_code":0}}
```

`status` is `ok`, `error`, or `partial`. Existing result wrappers retain their result, errors, warnings, cursor and metadata; bare reports become `result`. Envelope failures include errors and their exit code. Envelope mode includes a warning announcing the planned default flip; legacy JSON prints the same announcement to stderr. The default will switch only in an announced release. Consumers should opt in and check `schema_version` now. `--envelope` selects a JSON format; continue to use the command's `--json` or `--raw` flag to request JSON.

Cleaned task JSON now emits the full recurrence rule, restores `datetime_tz`, and names `calendar_id` according to its actual semantics (replacing the misleading `linked_event_id`). Synthetic rows add `synthetic: true`.

| Exit | Meaning |
| --- | --- |
| 0 | Success |
| 2 | Validation / usage |
| 3 | Authentication |
| 4 | Not found |
| 5 | Upstream / API |
| 6 | Partial success |
| 7 | Verification timeout (reserved) |

Unclassified existing failures retain their legacy code 1 during migration. The contract upgrades clear authentication, not-found, upstream, and partial-result failures; verify-timeout is reserved.

Shell completion for bash/zsh/fish is generated at invocation from the same citty command tree used by strict parsing. There is no separate hand-maintained command manifest.

## Tasks

```bash
af task list [--today|--date <date>|--from <date> --to <date>] [--json|--raw]
af task create <title> [--today|--date <date>] [--at HH:MM] [--duration <duration>]
af task complete <task-id-or-short-id> [more ids...]
af task update <task-id> [--title <text>] [--description <text>|--description-file <path>] [--duration <duration>] [--project <project-id>] [--priority 1|2|3]
af task plan <task-id> [--date <date>] [--at HH:MM]
af task snooze <task-id> --duration <duration>
af task delete <task-id>
```

Numeric short IDs come from the latest task list snapshot; use `--snapshot <token>` to pin them. Full UUIDs work without list context.

## Events

```bash
af event create <title> --date <date> --at HH:MM --duration <duration> [--calendar <calendar>] [--description <text>|--description-file <path>] [--location <text>] [--send-updates none|all] [--json]
af event update <event-id> [--date <date>] [--at HH:MM] [--duration <duration>] [--title <text>] [--description <text>|--description-file <path>] [--location <text>] [--send-updates none|all] [--json]
af event delete <event-id> [--send-updates none|all] [--json]
af event attendees add <event-id> <email> [more emails...] [--send-updates none|all] [--json]
af event attendees remove <event-id> <email> [more emails...] [--send-updates none|all] [--json]
```

Event v1 supports timed, writable, non-recurring Google events only. All-day, recurrence, reminders, and conferencing are unsupported. Event mutations default to `--send-updates none` (silent guest handling); use `--send-updates all` to notify guests.

## Batch Operations

```bash
af batch events attendees add <email> [more emails...] [event selectors] [--send-updates none|all] [--execute] [--json]
af batch events attendees remove <email> [more emails...] [event selectors] [--send-updates none|all] [--execute] [--json]
af batch events delete [event selectors] [--send-updates none|all] [--execute] [--json]
af batch slots delete [slot selectors] [--execute] [--json]
```

Batch commands require at least one selector and dry-run by default. Event selectors include `--date`, `--from/--to`, `--search`, `--calendar`, `--account`, `--connector`, and named ranges. Slot selectors include `--date`, `--from/--until`, `--search`, and `--calendar`.

## Slots

```bash
af slot list [--date <date>|--from <date> --until <date>] [--search <text>] [--json]
af slot show <slot-id> [--json]
af slot create <title> --date <date> --at HH:MM --duration <duration> [--calendar <calendar>] [--task <title>] [--task-id <task-id>] [--task-duration <duration>] [--json]
af slot update <slot-id> [--title <text>] [--date <date>] [--at HH:MM] [--duration <duration>] [--calendar <calendar>] [--add-task-id <task-id>] [--remove-task-id <task-id>] [--json]
af slot delete <slot-id> [--json]
```

Slot update moves/resizes/renames a true Akiflow task slot and can link or unlink existing tasks. It does not create new tasks; use `af slot create --task` for that.

## Calendar

```bash
af calendar list [--json] [--all]
af calendar default [--json]
af calendar resolve <calendar> [--json]

af cal [--today|--date <date>|--from <date> --to <date>] [--search <text>] [--summary] [--json|--raw]
af cal --calendar <calendar>
af cal --free
af cal --no-events
af cal --no-tasks
af cal --no-slots
```

`af calendar` lists and resolves calendar metadata. Calendar arguments accept an Akiflow calendar ID, origin calendar/email, or unique title. `af cal` merges events, task slots, and scheduled tasks.

## Conversion

```bash
af convert tasks --to events [task-list filters] [--default-duration <duration>] [--calendar <calendar>]
af convert tasks --to events [task-list filters] --execute [--delete-source]
```

Conversion dry-runs by default. Source deletion is only allowed with `--execute --delete-source`. Every target (including an existing match) must first pass fresh field verification; any unverified target blocks all source deletions and exits non-zero.

## Read-Only Projects, Auth, Cache, Diagnostics

```bash
af project list
af auth
af auth status
af refresh [--rebuild] [--json]
af doctor [--json]
af completion bash|zsh|fish
```

## Mutation Receipts And Verification

Use `--verify` on `event create/update/delete` and `event attendees add/remove`, `task create/update/plan/snooze/complete/delete`, `slot create`, `batch events` mutations, and `convert tasks --to events --execute` to confirm the requested state via uncached, paginated Akiflow reads. The default timeout is **15 seconds**. Verification compares requested fields, including instants and timezone strings. This confirms Akiflow state, not Google/provider application. Deletion verification requires an observed tombstone.

Without verification, a recorded event operation prints `Operation accepted (<operation_id>) — submitted, not yet confirmed`. Accepted exits zero but does not establish application. Failed, unknown, pending, mismatch, and timeout outcomes exit non-zero. A partial task/slot mutation reports succeeded, failed, and unknown IDs and exits non-zero. No mutation is automatically resubmitted after an uncertain outcome; inspect fresh state before manually rerunning.

With `--verify`, confirmation prints `Verified: <id>`. A field mismatch names the differing fields. A timeout reports `Verification timed out — outcome unknown, no success claimed`. An explicit pending receipt remains pending; the CLI does not treat it as acceptance.

Mutation `--json` returns a versioned receipt envelope:

```json
{
  "schema_version": 1,
  "command": "event create",
  "status": "accepted",
  "receipts": [
    {
      "operation_id": "operation-uuid",
      "event_id": "event-uuid",
      "kind": "create",
      "status": "accepted",
      "failed_at": null,
      "processed_at": null,
      "result": null
    }
  ],
  "result": null,
  "errors": [],
  "warnings": []
}
```

The envelope status is `accepted`, `verified`, `failed`, `unknown`, `pending`, `mismatch`, or `timeout`. Event receipts retain server operation IDs and diagnostics; task/slot receipts identify each requested record and its outcome. `result` contains observed/returned records or the command report, or null; it must not be interpreted as confirmation without `status: "verified"`. Preview output retains its existing report shape because it submits no mutation.

## Occurrence calendar and audit reads

`af cal` queries events, slots, and scheduled tasks from one pinned cache generation.
It attaches per-resource fetch timestamps and keeps linked constituents visible;
linked events own time, followed by slots, then tasks. Deleted, hidden, cancelled,
declined, done, and trashed records are excluded by default. Uncovered recurring
series masters retain their existing visibility rule. An explicit calendar can
select a hidden calendar, but deleted calendars remain excluded. Without an
explicit calendar, the active visible calendar set applies. Account and connector
filters apply to every source. `--no-events`, `--no-slots`, and `--no-tasks` skip
the corresponding source. Search covers normalized title and original description.

```bash
af cal --date 2026-06-20 --summary --json
af cal --date 2026-06-20 --free --min-duration 30m --json
af slot list --account <account-id> --connector google --calendar <calendar> --json
af audit --date 2026-06-20 --json
af audit --from 2026-06-20 --to 2026-06-23 --calendar <calendar> --min-duration 1h
```

Summary JSON has `result: {counts: {event, slot, task}, total, busy_minutes}`.
Counts include constituents; busy minutes union overlapping active intervals,
apply explicit link time ownership, and clip to the requested window. Human
summaries start with `Calendar summary`. The summary and raw source name is now
`slot` (formerly `time_slot`); cleaned calendar JSON retains its established
`time_slot` type and existing field names. Raw JSON contains `{type, record,
start, end}` entries under `{result, next_cursor: null, errors: []}`.

`--free` uses the capacity library across all selected sources and the requested
window (today by default), rather than a separate slot-only request. JSON returns
`result: [{start, end}]`; text lists `HH:MM — HH:MM (N min)`, or
`(no free windows in range)`. `--min-duration` accepts the existing duration syntax
and defaults to zero. Intervals are half open; local day selectors include the
entire day, including DST changes.

`slot list` and batch slot selectors also accept `--account`, `--connector`, and
`--calendar`. Batch event/slot selection uses the same occurrence identity and
overlap rules. Batch mutation previews retain their no-auth/no-sync/no-write
contract, so their cache readers are not replaced with auto-refreshing reads.

`af audit` is read-only and can trigger the usual cache auto-refresh. Selectors:
`--today`, `--tomorrow`, `--date`, `--from`, `--to`, `--account`, `--connector`,
`--calendar`, `--min-duration`, and `--json`. Human sections are FETCH, COVERAGE,
DISCREPANCIES, and EFFECTIVE. JSON is `{schema_version: 1, audit, envelope}`;
`--envelope` can wrap this in the CLI's universal output contract.

Audit fetch metadata includes per-resource `observed_at` and the pinned generation.
Coverage includes effective source counts and each resource's age/staleness.
Discrepancies list possible provider echo groups, suggested canonical members,
explicit event owner overrides, nonoverlapping linked times, and status counts
seen versus excluded within the range and identity scope before visibility filtering.
Suggestions prefer a non-null provider `origin_id`, then earliest start (ID breaks
exact ties). This is the “Google wins for matched provider events” review rule,
not provider verification. Echoes never suppress time or hide records; native
Akiflow tasks without a provider origin ID never join echo groups. Owner overrides
remain informational: the linked event owns time even when the linked times diverge.

The review envelope stays at schema version 1 and includes ISO `generated_at`,
local IANA `timezone`, `provenance: {generation, observed_at}`, the window,
occurrences, unioned busy minutes, free windows, and warnings. Envelope
`observed_at` is the oldest fetch timestamp across events/slots/tasks/calendars,
or null if any is unknown. Occurrences have provider identity plus `observedAt`,
`generation`, and `pending: false`. Pending is reserved for workstream D's overlay.
The legacy `pending-tasks.json` helper used by task list is not part of these
snapshot calendar/audit reads.
