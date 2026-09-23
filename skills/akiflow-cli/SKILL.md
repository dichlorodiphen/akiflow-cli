---
name: akiflow-cli
description: Manage Akiflow tasks, calendar events, task slots, and cache state through the private resource-first `af` CLI.
metadata: {"openclaw":{"emoji":"📋","requires":{"bins":["af"]}}}
---

# Akiflow CLI

Use `af` for Akiflow task and calendar work. Prefer `--json` for reads and parse the cleaned `result` array. Run `af refresh --json` when the user asks for the latest state or after mutations that need verification.

Dates are local calendar dates. Use explicit `YYYY-MM-DD` in commands and reports.

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
af task complete 1
af task complete <full-uuid>
```

Short IDs require the last non-JSON `af task list`; full UUIDs do not. Delete only after explicit user confirmation:

```bash
af task delete <task-id>
```

## Projects And Gaps

Project listing is read-only:

```bash
af project list
```

Known gaps: event delete, all-day events, recurring events, reminders, conferencing, Aki chat messages, and project mutation are unsupported.

For Southwest flight rechecks, use Chrome on `https://www.southwest.com/air/flight-status/path?departureDate=YYYY-MM-DD&flightNumber=N`, trust the rendered Southwest status, then update dependent Akiflow events with `af event update`.
