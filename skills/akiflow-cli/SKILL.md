---
name: akiflow-cli
description: Manage Akiflow tasks, calendar events, task slots, and cache state through the private resource-first `af` CLI.
metadata: {"openclaw":{"emoji":"📋","requires":{"bins":["af"]}}}
---

# Akiflow CLI

Use `af` for Akiflow task and calendar work. Prefer `--json --envelope` for reads and parse the cleaned `result` array. Check `schema_version: 1`, `status`, `errors`, and `warnings`; `meta` carries the snapshot and exit code. Legacy JSON remains default with a stderr migration announcement; `AF_JSON_ENVELOPE=1` opts in globally ahead of the announced default flip. Run `af refresh --json` when the user asks for the latest state or after mutations that need verification. Use mutation `--verify` for field confirmation.

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

`af cal` returns events, time slots, and scheduled tasks. Hidden calendars and hidden/deleted/declined events are excluded by default. Use `--declined` only when asked.

## Create And Schedule

```bash
af task create "Task title"
af task create "Task title" --today
af task create "Task title" --date 2026-06-19 --at 14:30 --duration 1h
af task plan <task-id> --date 2026-06-19 --at 14:30
af task snooze <task-id> --duration 1d
```

Use `af slot create` for true Akiflow task slots:

```bash
af slot create "Planning block" --date 2026-06-19 --at 14:30 --duration 1h
af slot create "Admin block" --date 2026-06-19 --at 16:00 --duration 45m --task-id <uuid-1> --task-id <uuid-2>
```

Use `af event create` for real timed Google Calendar events:

```bash
af event create "Meeting" --date 2026-06-19 --at 14:30 --duration 30m --description "Details" --location "Office"
```

`af event create` v1 supports timed, non-recurring Google events only. It accepts optional `--calendar`, `--description`, `--description-file`, `--location`, and `--json`.

## Update Events And Attendees

```bash
af event update <event-id> --date 2026-06-19 --at 21:45 --duration 1h --description-file details.txt
af event attendees add <event-id> julia@example.com
af event attendees remove <event-id> julia@example.com
```

`af event` refuses all-day, recurring, hidden, deleted, read-only, and non-Google events. Event updates and attendee changes send Google update notifications.

## Convert Tasks To Events

Use this when planned task blocks should become real calendar events:

```bash
af convert tasks --to events --search "Portland trip:" --from 2026-06-19 --until 2026-06-23
af convert tasks --to events --search "Portland trip:" --from 2026-06-19 --until 2026-06-23 --execute --delete-source
```

Conversion dry-runs by default. Connector-backed tasks require `--include-connector-tasks` and are never deleted by conversion v1.

## Complete And Delete Tasks

Complete tasks only when the user explicitly asks:

```bash
af task list --today --plain
af task complete 1 --snapshot <token>
af task complete <full-uuid>
```

Every task list publishes a snapshot (text or `meta.snapshot`) and saves numbered context. Numeric IDs without a pin warn in phase 1; supply `--snapshot <token>` on task complete/update/plan/snooze/delete. `AF_STRICT_IDS=1` requires it now; phase 2 will require tokens by default. Mismatched pins fail already. UUID prefixes use the full cached inventory with an explicit warning, falling back to last-list only when unavailable. Full UUIDs need no context. Synthetic `virtual:<uuid>:<date>` rows are marked and cannot be mutated. Delete only after explicit user confirmation:

```bash
af task delete <task-id>
```

## Projects And Gaps

Project listing is read-only:

```bash
af project list
```

Event deletion supports `af event delete <event-id> --notify all|none --dry-run`; default notifications are `all`. Slot update/delete also accept `--dry-run`.

Known gaps: all-day events, recurring events, reminders, conferencing, Aki chat messages, and project mutation are unsupported.

For Southwest flight rechecks, use Chrome on `https://www.southwest.com/air/flight-status/path?departureDate=YYYY-MM-DD&flightNumber=N`, trust the rendered Southwest status, then update dependent Akiflow events with `af event update`.

## Interpret Mutation Outcomes

Mutation JSON is a receipt envelope with `schema_version: 1`, `command`, `status`, `receipts`, `result`, `errors`, and `warnings`. Parse the receipts and status before reporting an outcome. `accepted` means submitted, not confirmed; never describe it as created/updated/deleted successfully. Failed, unknown, pending, mismatch, timeout, and partial task outcomes exit non-zero. Preserve operation IDs for diagnosis.

Add `--verify` to event create/update/delete and event attendees add/remove, task create/update/plan/snooze/complete/delete, slot create, batch events mutations, and executed task-to-event conversions when confirmation is needed. Verification uses fresh Akiflow reads, compares requested fields and time/zone, and defaults to a 15-second timeout. `verified` confirms observed Akiflow state, not provider state. Timeout claims no success. Never automatically rerun a write after an unknown outcome; inspect fresh records first.

Conversion with `--delete-source` verifies every target before deleting any source. If one target is unverified, all sources remain and the command exits non-zero. Preview remains the default.
