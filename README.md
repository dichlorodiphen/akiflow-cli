# akiflow-cli

Unofficial Bun-native CLI for managing Akiflow tasks, calendar events, task slots, and local cache state from the terminal.

This repository adapts [code-yeongyu/akiflow-cli](https://github.com/code-yeongyu/akiflow-cli) by Yeongyu Kim, under the included MIT license. It adds calendar, event, slot, batch, and task conversion commands.

## Features

- **Resource-first commands** - `af task`, `af event`, `af slot`, `af batch`, `af calendar`, `af project`, `af cal`
- **Task management** - list, create, complete, update, plan, snooze, delete
- **Calendar events** - create/update/delete timed Google events through Akiflow's v5 event operations
- **Task slots** - list, show, create, update, and delete true Akiflow task slots with linked tasks
- **Batch operations** - dry-run-first bulk attendee, event delete, and slot delete workflows
- **Conversion** - convert scheduled task blocks into Google Calendar events
- **Local sync cache** - JSONL stores at `~/.cache/af/` with delta sync and rebuild support
- **Stable JSON output** - cleaned `--json` shapes for task and calendar reads; `--raw` for API records
- **Diagnostics** - `af doctor` reports credentials, browser sources, cache state, and API health

## Installation

```bash
git clone https://github.com/dichlorodiphen/akiflow-cli.git
cd akiflow-cli
bun install
bun run build
install -m 0755 ./af ~/.local/bin/af
```

Install [Bun](https://bun.sh/) first and ensure `~/.local/bin` is on your `PATH`. On each computer, sign in to Akiflow in a browser and run `af auth`; account credentials and the local cache are not stored in this repository.

First-time auth requires a desktop browser logged into Akiflow:

```bash
af auth
af auth status
```

## Commands

### Tasks

```bash
af task list
af task list --today --json
af task list --from 2026-06-19 --to 2026-06-23 --search "Portland"
af task list --status inbox,planned --connector gmail

af task create "Review PR" --today
af task create "Focus block" --date 2026-06-20 --at 09:00 --duration 1h
af task create "Draft notes" --description "Details" --project <project-id>

af task complete <task-id-or-short-id>
af task complete <task-id-1> <task-id-2>
af task update <task-id> --title "New title" --duration 45m --priority 2
af task plan <task-id> --date 2026-06-20 --at 14:30
af task snooze <task-id> --duration 1d
af task delete <task-id>
```

`af task list` writes `~/.cache/af/last-list.json` so short IDs can be used by task mutation commands. Full UUIDs work without list context.

### Events

```bash
af event create "Meeting" --date 2026-06-20 --at 13:00 --duration 30m \
  --description "Discuss launch" --location "Office"

af event update <event-id> --date 2026-06-20 --at 14:30 --duration 45m \
  --title "Updated meeting" --description-file details.txt

af event delete <event-id>
af event delete <event-id> --notify none

af event attendees add <event-id> julia@example.com alex@example.com
af event attendees remove <event-id> julia@example.com
```

Event v1 supports cached, timed, non-recurring, writable Google Calendar events only. Create, update, and delete use Akiflow's asynchronous v5 event-operations API. It does not support recurrence, all-day events, reminders, or conferencing. Deletes send Google update notifications through Akiflow by default; use `af event delete --notify none` for disposable cleanup. The attendee subcommands remain exposed for compatibility, but Akiflow has deprecated their captured v3 modifier endpoint and their v5 replacement is not yet implemented.

### Batch Operations

```bash
af batch events attendees add julia@example.com \
  --search "Portland trip:" --from 2026-06-19 --to 2026-06-23
af batch events attendees add julia@example.com \
  --search "Portland trip:" --from 2026-06-19 --to 2026-06-23 --execute

af batch events attendees remove julia@example.com --date 2026-06-20 --search "Portland" --execute
af batch events delete --date 2026-06-20 --search "Test event" --notify none --execute
af batch slots delete --from 2026-06-19 --until 2026-06-23 --search "Temp" --execute
```

`af batch` is the preferred surface for selector-based mutations. It requires at least one selector, dry-runs by default, and only mutates with `--execute`. Event batches support cached, timed, non-recurring, writable Google Calendar events; unsupported selected records are reported as skipped.

### Slots

```bash
af slot list --date 2026-06-20
af slot list --from 2026-06-19 --until 2026-06-23 --search "Planning" --json
af slot show <slot-id> --json

af slot create "Planning block" --date 2026-06-20 --at 09:00 --duration 1h \
  --task "Draft plan" --task "Review notes" --task-duration 30m

af slot create "Admin" --date 2026-06-20 --at 15:00 --duration 45m \
  --task-id task-uuid-1 --task-id task-uuid-2

af slot update <slot-id> --date 2026-06-20 --at 10:00 --duration 45m
af slot update <slot-id> --add-task-id task-uuid-1
af slot update <slot-id> --remove-task-id task-uuid-1

af slot delete <slot-id>
```

`af slot update` moves, resizes, renames, or changes existing task membership for a true Akiflow task slot. It does not create new tasks during update.

### Calendar

```bash
af calendar list
af calendar list --json
af calendar default
af calendar resolve "Personal"

af cal --today
af cal --from 2026-06-19 --to 2026-06-23 --json
af cal --from 2026-06-19 --to 2026-06-23 --search "Portland" --summary
af cal --today --no-events
af cal --today --calendar "Personal"
af cal --free
```

`af calendar` lists and resolves calendar metadata. Calendar arguments accept an Akiflow calendar ID, origin calendar/email, or unique title. The merged `af cal` view includes events, time slots, and scheduled tasks. Hidden calendars and hidden/deleted/declined events are excluded by default.

### Conversion

```bash
af convert tasks --to events --search "Portland trip:" --from 2026-06-19 --until 2026-06-23
af convert tasks --to events --search "Portland trip:" --from 2026-06-19 --until 2026-06-23 \
  --calendar "Personal" --execute --delete-source
```

Conversion dry-runs by default. `--execute` creates missing events; `--delete-source` soft-deletes native source tasks only after all selected targets are created or matched. Connector-backed tasks require `--include-connector-tasks` and are never deleted by conversion v1.

### Projects, Cache, Diagnostics

```bash
af project list
af refresh --json
af refresh --rebuild --json
af doctor
af doctor --json
af completion zsh
```

Project mutation is intentionally unsupported until Akiflow's labels mutation API is captured and tested.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AF_API_BASE` | `https://api.akiflow.com` | Akiflow API base URL; used by integration tests. |
| `AF_CONFIG_DIR` | `~/.config/af` | Credentials directory. |
| `AF_CACHE_DIR` | `~/.cache/af` | Local cache root. |
| `AF_NO_AUTO_SYNC` | unset | Disables 24h auto-refresh-before-read. |
| `AF_LOG` | unset | Writes JSON Lines logs to cache. |
| `AF_DEBUG` | unset | Enables logging and mirrors logs to stderr. |

## Development

```bash
bun run typecheck
bun run lint
AF_CACHE_DIR=/private/tmp/af-test-cache bun run test
```
