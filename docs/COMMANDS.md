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
af task create <title> [--today|--date <date>] [--at HH:MM] [--duration <duration>] [--timezone <IANA>] [--fold first|second]
af task complete <task-id-or-short-id> [more ids...]
af task update <task-id> [--title <text>] [--description <text>|--description-file <path>] [--duration <duration>] [--project <project-id>] [--priority 1|2|3]
af task plan <task-id> [--date <date>] [--at HH:MM] [--clear-time] [--timezone <IANA>] [--fold first|second]
af task snooze <task-id> --duration <duration> [--timezone <IANA>] [--fold first|second]
af task delete <task-id>
```

Short IDs come from the last `af task list` (including JSON/raw output), against its merged observed + pending view. Full UUIDs work without list context. Virtual recurring instances (`virtual:<uuid>:<date>`) are query expansions only: direct IDs, prefixes, and numeric IDs pointing at them are rejected for mutations. Use the real recurring task UUID.

All task consumers (`task list`, `cal`, `convert`, `slot`, and project counts) use one local repository. Observations come from a pinned cache generation; task reads do not fetch from the API. Run `af refresh` or `af cache refresh` to obtain fresh observations. List metadata resolution and project counts also use local cache data.

Successful task writes are stored as explicit intents in `$AF_CACHE_DIR/pending-tasks.json` (default `~/.cache/af`), atomically under the cache ownership lock. Create/update/plan/snooze/complete/delete, slot task changes, and conversion source deletions immediately affect the next local read. JSON/raw task rows and cleaned calendar task entries include `pending: true`; plain list/calendar/slot/conversion output shows `[pending]`. Conversion JSON items carry the same marker, and project/slot counts annotate the number of pending tasks. Observed-only rows omit that field. Snoozing a timed task moves both its date and scheduled time. Planning with a date and no time clears any previous timed schedule; calendar only displays timed tasks.

Intents never expire by age. The repository applies them in journal order, with later fields superseding earlier fields, and reconciles a task's chain only when observed fields match its final intended state. ID presence or a newer observed version alone is insufficient. Completion remains sticky while sync lags. Newer conflicting observations retain pending fields and emit a warning (`pending_conflict` in task JSON). Delete intents hide rows without changing observations; observed tombstones confirm deletes. A newer task-resource sync proving absence can also confirm deletion of a previously observed task. Explicit tombstone receipts are published in generation token metadata so deletion of an unobserved pending create can be confirmed safely.

Trashed-state policy is **entity retention**: trashed observations stay in the generational cache. Normal list/calendar/conversion/slot/project queries exclude trash; list's explicit `--trashed`, `--status trashed`, `--all`, or `--status all` queries can include it. Deleted tasks are always hidden.

### Scheduling and timezones

All schedule writes accept `--timezone <IANA>` (e.g., `America/Los_Angeles`), which determines how `--date`/`--at` inputs are interpreted. Precedence: explicit `--timezone` flag > profile setting (`~/.config/af/config.json`) > system local timezone. UTC hosts and LA hosts produce identical instants for identical inputs.

**Snooze semantics (behavioral break):** `af task snooze` now moves the actual `datetime` for timed tasks (previously it only changed the `date` field, leaving the time wrong). The basis depends on the unit:
- `--duration 1h` (or `30m`): **elapsed basis** — adds exact milliseconds to the UTC instant.
- `--duration 1d` (or `2w`): **wall-day basis** — preserves wall-clock time in the task's timezone. Across DST spring-forward, `1d` means 23 elapsed hours but the same wall-clock time (e.g., 9:00 AM stays 9:00 AM).

The task's `datetime_tz` is preserved. During migration, `task plan --date --at` remains the verified operational path for precise scheduling.

**Date-only planning:** `af task plan <id> --date 2026-10-05` (without `--at`) on a timed task preserves the existing wall-clock time by default (moves 9:00 AM to 9:00 AM on the new date). Use `--clear-time` to explicitly convert to date-only (all-day).

**DST policy:** Times that don't exist (e.g., 2:30 AM on spring-forward day) are rejected with a clear error — never silently shifted. Ambiguous times (e.g., 1:30 AM on fall-back day, occurs twice) require `--fold first|second` — never guessed.

**Invalid dates:** `2026-02-30`, `2026-13-01`, etc. are rejected with clear errors (not rolled over).

## Events

```bash
af event create <title> --date <date> --at HH:MM --duration <duration> [--calendar <calendar>] [--description <text>|--description-file <path>] [--location <text>] [--rrule <rule>] [--timezone <IANA>] [--fold first|second] [--send-updates none|all] [--json]
af event update <event-id> [--date <date>] [--at HH:MM] [--duration <duration>] [--title <text>] [--description <text>|--description-file <path>] [--location <text>] [--scope series|instance] [--instance-anchor <ISO>] [--timezone <IANA>] [--fold first|second] [--send-updates none|all] [--json]
af event delete <event-id> [--scope series] [--truncate-before <date>] [--send-updates none|all] [--json]
af event attendees add <event-id> <email> [more emails...] [--send-updates none|all] [--json]
af event attendees remove <event-id> <email> [more emails...] [--send-updates none|all] [--json]
```

**Event update zone preservation:** `af event update <id> --date ...` preserves the event's existing timezone unless `--timezone` is explicitly given. The update interprets the new date/time in the event's zone, not the host's local zone.

Event v1 supports timed, writable Google events. `--rrule` creates recurring series (validated, serialized as `recurrence:['RRULE:...']`; `--dry-run` previews the first 5 occurrences in the event timezone). Recurring events require explicit `--scope`: `series` edits/deletes the master, `instance` edits a single occurrence via the Google fallback adapter (anchored by `original_start_time`, never current `start_time`; Akiflow sync reported as pending). Series delete truncates (via `--truncate-before` setting RRULE UNTIL) or deletes the master — never loops instances. All-day, reminders, and conferencing are unsupported. Event mutations default to `--send-updates none` (silent guest handling); use `--send-updates all` to notify guests.

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
af slot create <title> --date <date> --at HH:MM --duration <duration> [--calendar <calendar>] [--task <title>] [--task-id <task-id>] [--task-duration <duration>] [--timezone <IANA>] [--fold first|second] [--json]
af slot update <slot-id> [--title <text>] [--date <date>] [--at HH:MM] [--duration <duration>] [--calendar <calendar>] [--add-task-id <task-id>] [--remove-task-id <task-id>] [--json]
af slot delete <slot-id> [--json]
```

Slot update moves/resizes/renames a true Akiflow task slot and can link or unlink existing tasks. It does not create new tasks; use `af slot create --task` for that.

## Calendar

```bash
af calendar list [--json] [--all]
af calendar default [--json]
af calendar resolve <calendar> [--json]

af cal [--today|--date <date>|--from <date> --to <date>] [--search <text>] [--summary] [--timezone <IANA>] [--json|--raw]
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
af convert tasks --to events --all --execute
af convert tasks --to events --resume <token> --execute
```

Conversion dry-runs by default. A selector (e.g. `--search`, `--date`, `--project`) or `--all` is required; unfiltered conversion without `--all` exits with code 2. Source deletion is only allowed with `--execute --delete-source`. Every target (including an existing match) must first pass fresh field verification; any unverified target blocks all source deletions and exits non-zero.

Source→target mappings are persisted in a conversion journal (`conversion-journal.json` in the cache directory). Reruns skip already-converted tasks (no duplicates). On partial failure, the receipt includes `created_event_ids` and a `resume_token`; pass the token to `--resume` to continue without re-creating completed targets.

## Read-Only Projects, Auth, Cache, Diagnostics

```bash
af project list
af auth login
af auth status
af auth logout
af auth refresh
af refresh [--rebuild] [--json]
af doctor [--json] [--strict]
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

`af auth` prints subcommand help. `af auth login` scans browser storage for Akiflow tokens (via `scanBrowsers`) and saves them; it does not perform an OAuth flow.
`af auth refresh` renews saved tokens without deleting credentials on failure;
without a refresh token it falls back to login. `af doctor --strict` grades
checks as ok, warning, or critical, includes recovery instructions (also with
`--json`), and exits nonzero if any check is critical.

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

## af reconcile

Compare fresh Akiflow events with Google Calendar and inspect the existing CLI
cache independently. This command observes events only: it does not repair sync,
expand Akiflow recurrence rules, refresh caches, renew Akiflow credentials, or
mutate events. Observations remain in memory.

```text
af reconcile
  [--today | --tomorrow | --date <day> | --from <day> --to <day>]
  [--timezone <IANA>]
  [--calendar <Akiflow-id|Google-origin-id|unique-title>]
  [--google-cmd <executable>]
  [--json] [--envelope]
```

```bash
af reconcile --date 2026-09-30 --timezone America/Los_Angeles
af reconcile --calendar Personal --tomorrow --json
af reconcile --from 2026-09-28 --to 2026-09-30 --json --envelope
```

Today is the default. Select exactly one selector family, and supply both range
boundaries. Day selectors accept the existing strict vocabulary (for example,
`today`, `tomorrow`, `next monday`, `in 3 days`, and `YYYY-MM-DD`), with timestamps
and time-of-day selectors rejected. `--to` includes that entire local day. The
limit is 31 local calendar days, including both endpoints. Windows are half-open
`[start,end)` and handle 23/25-hour DST days using calendar-day arithmetic.

Timezone precedence is `--timezone`, then `~/.config/af/config.json`'s `timezone`,
then the host timezone. The September 30 example above reads
`[2026-09-30T07:00:00Z,2026-10-01T07:00:00Z)` on both providers. All-day events
participate in presence comparisons; Akiflow's inclusive end date is converted
to Google's exclusive end date. All-day window intersection uses the canonical
calendar's timezone.

The private-fork defaults are `dichlorodiphen@gmail.com` and
`david.young@databricks.com`. `--calendar` replaces both with one calendar,
resolved against fresh Akiflow metadata by ID, Google origin ID, or unique title
(including a unique title substring). Explicit hidden calendars are auditable;
deleted calendars are excluded. A default calendar without a connection is
still read from Google and receives `calendar_not_connected` diagnostics.

Google executable precedence is `--google-cmd`, then `HATCH_GWS_CLI`, then
`hatch_gws_cli` on PATH. Each override is one executable name/path, including
paths containing spaces. Compatible wrappers must accept:

```text
<executable> calendar events list --params <one JSON argument>
<executable> calendar events get --params <one JSON argument>
```

There is no shell or command splitting. List requests use identical window
bounds, `singleEvents:true`, `showDeleted:true`, `orderBy:"startTime"`, and
`maxResults:2500`. Every `nextPageToken` is followed, including on empty pages.
The reader requires the native `calendar#events` collection object with `items`
and optional `nextPageToken`; flattened/human helper output is rejected.
Structured failures use an API `error` object with numeric `code` and `message`.
Each subprocess is bounded to 30 seconds. A privsep socket failure is preserved
as an upstream error. No Google sync token is persisted.

Akiflow uses only GET `/v5/calendars` and `/v5/events`, starting without a cached
cursor, and validates advancing pagination up to 1,000 pages. The read-only
client rejects writes and fails a 401 without refreshing/persisting credentials.
Authenticate separately with `af auth login`, then rerun. The cache reader pins
one existing generation and reads events, calendars, and resource timestamps
synchronously. It never initializes, migrates, locks, refreshes, or publishes.
Missing/corrupt cache is `unavailable`, which cannot establish a cache gap.

The four tiers are:

| Tier | Interpretation |
| --- | --- |
| Google missing from Akiflow | One finding per active Google occurrence, distinguishing `server_gap`, `cache_gap`, `both_gap`, `calendar_not_connected`, and identity-linked `excluded` records. |
| Akiflow missing/cancelled on Google | Fresh Akiflow only, distinguishing cancellation evidence, explicit provider-ID not-found, and not observed in the window. Read-only guest events remain eligible; `possible_phantom` is suspicion. |
| Duplicates / overlaps | Identity collisions, same-title strict overlaps with transitive grouping, and neutral different-title overlaps, separately within each fresh source. |
| Possible reshape leftovers | Unequal similar titles on the same calendar with at least two shared tokens, Jaccard ≥ 0.5, and overlap or a gap ≤ 30 minutes. Unique mirrors collapse in a combined inventory, retaining both source references. |

Identities stay calendar scoped and case sensitive. Matching proceeds through
exact provider ID, series plus original occurrence anchor, then mutually unique
nonempty normalized title plus exact start. Contradictory provider IDs and
ambiguous candidates remain possible counterparts. Identity-linked moves can
be found outside the window by supplementary Google `events get` calls using
only IDs actually observed on Akiflow. A series master establishes series
presence only. A 404/410 establishes ID-not-found evidence without deletion
causality. Declined/hidden/working-location records remain exclusion evidence;
known declined counterparts are status differences, not missing occurrences.

`--json` emits the existing wrapper:

```json
{"result":{"schema_version":1,"complete":true,"window":{},"sources":{},"records":[],"matches":[],"tiers":{},"cancelled_evidence":[],"cache_diagnostics":[],"diagnostics":[],"counts":{}},"next_cursor":null,"errors":[],"warnings":[]}
```

`result` includes UTC window bounds, timezone, `end_exclusive:true`, and
`generated_at`. `sources.atomic:false` records that these reads are fresh but
not an atomic provider snapshot. Akiflow coverage includes mode `fresh_full`,
read times, pages per resource, and completeness; cache coverage includes
availability, generation, capture time, resource timestamps, and events age;
each Google calendar includes read times, pages, identity probes, and completeness.

`records` retains every normalized observation, original source timing fields,
source IDs/provenance, exclusions, cancellations, and out-of-window counterparts.
Stable `ref` values distinguish side, observation, calendar, and native ID.
`matches` includes both references and native IDs, method/confidence, and field
differences. Cache comparisons stay in `cache_diagnostics`. Counts distinguish
findings by tier and unique records involved; overlapping tiers do not imply
additive duration or capacity. No capacity/free-time totals are emitted.

Top-level `warnings` are strings; structured diagnostics stay inside `result`.
Human warnings go to stderr as `Warning:` lines. A required-source failure emits
`complete:false`, failed coverage, structured errors, and `tiers:null`, never a
clean report based on an empty failed source. `--envelope` uses the existing
universal output contract.

| Outcome | Exit code |
| --- | --- |
| Complete report, including findings | 0 |
| Invalid usage/window/calendar or missing/unexecutable helper | 2 |
| Explicit authentication failure | 3 |
| Provider/process failure, timeout, malformed or incomplete response | 5 |

Before live acceptance, confirm the two defaults/profile timezone, the real
helper's API envelopes/pagination/get support and hidden OAuth behavior, and a
read-only all-day specimen. The helper's potential hidden state-changing auth
calls require an explicit decision; the CLI does not assume an exception.
Validate the Study specimen and retained corgi/Tidus and Dinner incident evidence.
Sparse cancellation records remain null for absent title/time and may eventually
disappear; a bounded date audit cannot guarantee historical deletion discovery.
No tasks, slots, attendees, recurrence definitions, descriptions, reminders,
repair operations, executable deletes, raw mode, or search are included in v1.
