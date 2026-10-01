---
name: akiflow-cli
description: Manage Akiflow tasks, calendar events, task slots, and cache state through the private resource-first `af` CLI.
metadata: {"openclaw":{"emoji":"📋","requires":{"bins":["af"]}}}
---

# Akiflow CLI

Use `af` for Akiflow task and calendar work. Prefer `--json --envelope` for reads and parse the cleaned `result` array. Check `schema_version: 1`, `status`, `errors`, and `warnings`; `meta` carries the snapshot and exit code. Legacy JSON remains default with a stderr migration announcement; `AF_JSON_ENVELOPE=1` opts in globally ahead of the announced default flip. Run `af refresh --json` when the user asks for the latest state or after mutations that need verification. Use mutation `--verify` for field confirmation.

Task reads share one local repository across list, calendar, conversion, slots, and project counts. Run `af refresh` for fresh observations. Successful mutations immediately overlay local reads with `pending: true` in JSON and `[pending]` in plain list/calendar output; pending fields are intent, not observed server confirmation. Intents live in the atomic, locked `pending-tasks.json` journal and never expire by age. Reconciliation requires matching intended fields; completion remains sticky during sync lag, and newer conflicts produce a warning. Delete intents hide tasks until sync confirms deletion. Trashed observations are retained but excluded from normal queries; only explicit list trash/all filters include them.

Dates are local calendar dates. Use explicit `YYYY-MM-DD` in commands and reports. Invalid task-list/cal selectors error rather than broadening the selection or substituting today. Unknown flags/commands and extra positionals fail before auth/cache access (exit 2). Completions are generated from the CLI command tree.

All task/event/slot mutations accept `--dry-run`. Preview first to inspect resolved IDs/titles, normalized before → after values, and notification policy. Previews use the local cache and perform zero writes, authentication, or auto-sync; refresh separately if needed. Batch/convert default to preview; `--execute --dry-run` is rejected. Task plan/snooze/delete support `--json` too.

Exit codes: 0 success; 2 validation; 3 auth; 4 not found; 5 upstream/API; 6 partial success; 7 reserved verification timeout. Unclassified legacy failures retain 1. Cleaned task JSON has full `recurring.rule`, `datetime_tz`, and `calendar_id` (formerly mislabeled `linked_event_id`).

## Inspect Tasks

```bash
af task list --today --json
af task list --date 2026-06-19 --json
af task list --inbox --json
af task list --search "review" --json
af task list --from 2026-06-19 --to 2026-06-21 --json
af task list --all --json
```

Useful filters: `--status inbox,planned,done,trashed,active,all`, `--connector gmail|linear|akiflow|none`, `--priority 1|2|3`, `--bucket week|month`, `--recurring`, `--overdue`.

## Inspect Calendar

```bash
af cal --today --json
af cal --date 2026-06-19 --json
af cal --from 2026-06-19 --to 2026-06-23 --json
af cal --from 2026-06-19 --to 2026-06-23 --search "Portland trip:" --summary
af cal --today --no-events --json
af cal --today --calendar <calendar-id> --json
```

`af cal` returns events, time slots, and scheduled tasks. Cached recurring events expand locally in the series timezone, including all-day series; materialized exceptions suppress their original slots. Virtual event IDs (`virtual:recurrence:...`) are read-only and cannot be updated or deleted. Expansion uses no API calls or cache writes, with a 366-day default horizon, 1000-slot limit and 100,000-candidate work limit per series. Dense old rules can exhaust that work limit before the requested window. DST gaps are skipped; folds use the first instant. Invalid rules/zones and EXRULE series are not expanded. Hidden calendars and hidden/deleted/declined events are excluded by default. Use `--declined` only when asked.

## Create And Schedule

```bash
af task create "Task title"
af task create "Task title" --today
af task create "Task title" --date 2026-06-19 --at 14:30 --duration 1h
af task plan <task-id> --date 2026-06-19 --at 14:30
af task snooze <task-id> --duration 1d
```

**Timezone handling:** All schedule writes accept `--timezone <IANA>` (e.g., `America/Los_Angeles`). Precedence: explicit flag > profile (`~/.config/af/config.json`) > system local. `af task snooze` moves the actual `datetime` for timed tasks: `1h`/`30m` use elapsed basis, `1d`/`1w` preserve wall-clock time (across DST, `1d` keeps 9:00 AM at 9:00 AM). `af task plan --date` (without `--at`) preserves wall-clock time by default; use `--clear-time` for date-only. DST gaps are rejected; folds require `--fold first|second`. Invalid dates like `2026-02-30` are rejected.

Use `af slot create` for true Akiflow task slots:

```bash
af slot create "Planning block" --date 2026-06-19 --at 14:30 --duration 1h
af slot create "Admin block" --date 2026-06-19 --at 16:00 --duration 45m --task-id <uuid-1> --task-id <uuid-2>
```

Use `af event create` for real timed Google Calendar events:

```bash
af event create "Meeting" --date 2026-06-19 --at 14:30 --duration 30m --description "Details" --location "Office"
```

`af event create` supports timed Google events, including recurring series via `--rrule` (e.g., `--rrule 'FREQ=WEEKLY;BYDAY=MO,WE,FR'`). The rule is validated and `--dry-run` previews the first 5 occurrences in the event timezone. It accepts optional `--calendar`, `--description`, `--description-file`, `--location`, and `--json`.

## Update Events And Attendees

```bash
af event update <event-id> --date 2026-06-19 --at 21:45 --duration 1h --description-file details.txt
af event attendees add <event-id> julia@example.com
af event attendees remove <event-id> julia@example.com
```

`af event` refuses all-day, hidden, deleted, read-only, and non-Google events. For recurring events, `--scope series` edits the series master; `--scope instance` edits a single occurrence (anchored by `original_start_time`, via Google fallback with `sendUpdates=none`; Akiflow sync reported as pending). Recurring events require explicit `--scope`. Event updates and attendee changes default to silent (`--send-updates none`).

## Convert Tasks To Events

Use this when planned task blocks should become real calendar events:

```bash
af convert tasks --to events --search "Portland trip:" --from 2026-06-19 --until 2026-06-23
af convert tasks --to events --search "Portland trip:" --from 2026-06-19 --until 2026-06-23 --execute --delete-source
```

Conversion dry-runs by default. A selector or `--all` is required (unfiltered conversion exits 2). Connector-backed tasks require `--include-connector-tasks` and are never deleted by conversion v1. Source→target mappings persist in the conversion journal; reruns skip already-converted tasks. On partial failure, use the `resume_token` from the receipt with `--resume` to continue.

## Complete And Delete Tasks

Complete tasks only when the user explicitly asks:

```bash
af task list --today --plain
af task complete 1 --snapshot <token>
af task complete <full-uuid>
```

Every task list publishes a snapshot (text or `meta.snapshot`) and saves numbered context. Numeric IDs without a pin warn in phase 1; supply `--snapshot <token>` on task complete/update/plan/snooze/delete. `AF_STRICT_IDS=1` requires it now; phase 2 will require tokens by default. Mismatched pins fail already. Short IDs refer to the last `af task list` (including JSON/raw output) against its merged observed + pending view. UUID prefixes use the full cached inventory with an explicit warning, falling back to last-list only when unavailable. Full UUIDs need no context. Synthetic `virtual:<uuid>:<date>` rows are marked and cannot be mutated; numeric IDs pointing at virtual instances are rejected. Use the real recurring task UUID. Delete only after explicit user confirmation:

```bash
af task delete <task-id>
```

## Projects And Gaps

Project listing is read-only:

```bash
af project list
```

Event mutations support `--send-updates none|all`; guest notifications default to `none` (silent). Slot update/delete also accept `--dry-run`.

Known gaps: all-day events, recurring events, reminders, conferencing, Aki chat messages, and project mutation are unsupported.

For Southwest flight rechecks, use Chrome on `https://www.southwest.com/air/flight-status/path?departureDate=YYYY-MM-DD&flightNumber=N`, trust the rendered Southwest status, then update dependent Akiflow events with `af event update`.

## Interpret Mutation Outcomes

Mutation JSON is a receipt envelope with `schema_version: 1`, `command`, `status`, `receipts`, `result`, `errors`, and `warnings`. Parse the receipts and status before reporting an outcome. `accepted` means submitted, not confirmed; never describe it as created/updated/deleted successfully. Failed, unknown, pending, mismatch, timeout, and partial task outcomes exit non-zero. Preserve operation IDs for diagnosis.

Add `--verify` to event create/update/delete and event attendees add/remove, task create/update/plan/snooze/complete/delete, slot create, batch events mutations, and executed task-to-event conversions when confirmation is needed. Verification uses fresh Akiflow reads, compares requested fields and time/zone, and defaults to a 15-second timeout. `verified` confirms observed Akiflow state, not provider state. Timeout claims no success. Never automatically rerun a write after an unknown outcome; inspect fresh records first.

Conversion with `--delete-source` verifies every target before deleting any source. If one target is unverified, all sources remain and the command exits non-zero. Preview remains the default.

Occurrence reads: `af cal` pins one generation for events/slots/tasks/calendars;
account/connector/calendar filters apply across sources. Linked constituents remain
visible, while event > slot > task ownership determines capacity. `--summary`
includes unioned, window-clipped `busy_minutes` and `{event, slot, task}` counts.
Raw/summary source naming is `slot`; cleaned JSON retains `time_slot` and existing
fields. `--free [--min-duration 30m]` returns free windows across the selected
sources and date range, defaulting to today. `slot list` and batch slot selection
accept `--account`, `--connector`, and `--calendar`.

Use `af audit --date YYYY-MM-DD --json` to review FETCH/COVERAGE/DISCREPANCIES/EFFECTIVE.
It accepts today/tomorrow/date/from/to, account/connector/calendar, and min-duration.
JSON contains `{schema_version: 1, audit, envelope}`; universal `--envelope` is
also supported. The review envelope includes generated_at, timezone, generation
and oldest observed_at, effective occurrences, busy minutes, free windows and warnings.
Echo canonical suggestions prefer provider origin_id, then earliest start; no
automatic echo suppression. Explicit linked event owner overrides and divergent
times remain visible. Native tasks without provider origin_id never echo-group.
Occurrence `pending: false` is reserved for D; the legacy task-list pending helper
is not integrated into calendar/audit snapshots. These commands are reads and may
auto-refresh; they do not need `--dry-run`.
