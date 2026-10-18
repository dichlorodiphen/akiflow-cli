# akiflow-cli

Unofficial Bun-native CLI for managing Akiflow tasks, calendar events, task slots, and local cache state from the terminal.

This repository adapts [code-yeongyu/akiflow-cli](https://github.com/code-yeongyu/akiflow-cli) by Yeongyu Kim, under the included MIT license. It adds calendar, event, slot, batch, and task conversion commands.

## Features

- **Resource-first commands** - `af task`, `af event`, `af slot`, `af batch`, `af calendar`, `af project`, `af cal`
- **Task management** - list, create, complete, update, plan, snooze, delete
- **Calendar events** - create/update/delete timed and all-day Google events, including individual recurring occurrences, through Akiflow's v5 event operations
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
bun install --frozen-lockfile
bun run build
mkdir -p ~/.local/bin
install -m 0755 ./af ~/.local/bin/af
```

Install [Bun](https://bun.sh/) first and ensure `~/.local/bin` is on your `PATH`. On each computer, sign in to Akiflow in a browser and run `af auth login`; account credentials and the local cache are not stored in this repository.

First-time auth requires a desktop browser logged into Akiflow:

```bash
af auth login
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

af event create "Away" --all-day --date 2026-06-20 --end-date 2026-06-23 --verify
af event update <all-day-event-id> --date 2026-06-21 --verify
af event update <series-master-id> --scope instance --instance-anchor 2026-06-21T09:00:00-07:00 --title "This occurrence" --verify
af event delete <series-master-id> --scope instance --instance-anchor 2026-06-21T09:00:00-07:00 --confirm --verify

af event delete <event-id>
af event delete <event-id> --send-updates none
af event delete <event-id> --confirm   # required when the event was not created by this CLI

af event attendees add <event-id> julia@example.com alex@example.com
af event attendees remove <event-id> julia@example.com
```

Events support writable timed and all-day Google records through Akiflow's asynchronous v5 operations. For all-day creation, use `--all-day --date YYYY-MM-DD`; optional `--end-date` is **exclusive** (defaults to the following day). All-day updates preserve the civil-day span when moving `--date`. All-day dates belong to their selected calendar; updates reject `--timezone`. Timed/all-day conversion is refused; all-day events do not accept `--at`, `--duration`, or `--fold`.

Recurring creation uses `--rrule`; series edits/deletes require `--scope series` and the master ID. `--truncate-before YYYY-MM-DD` cuts off future series occurrences before that local day. To edit/delete one occurrence, use `--scope instance` with the master UUID and `--instance-anchor` (the original explicit-offset ISO start, or `YYYY-MM-DD` for all-day). A materialized instance UUID supplies its original anchor automatically. Moved occurrences retain their original anchor. Native Akiflow exception operations preserve siblings; no separate Google credentials are required. Synthetic `virtual:...` read IDs remain invalid mutation inputs.

Attendee add/remove support timed, non-recurring events. Guest notifications default to silent (`--send-updates none`); use `--send-updates all` to notify. Deleting or truncating an event this CLI did not create requires `--confirm`. Accepted/pending receipts establish submission; `--verify` performs bounded fresh Akiflow field/cancellation confirmation without replay. Provider propagation is asynchronous and needs separate provider inspection when it matters. Reminders and conferencing creation remain unsupported.

### Batch Operations

```bash
af batch events attendees add julia@example.com \
  --search "Portland trip:" --from 2026-06-19 --to 2026-06-23
af batch events attendees add julia@example.com \
  --search "Portland trip:" --from 2026-06-19 --to 2026-06-23 --execute

af batch events attendees remove julia@example.com --date 2026-06-20 --search "Portland" --execute
af batch events delete --date 2026-06-20 --search "Test event" --send-updates none --execute
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

`af slot update` moves, resizes, renames, or changes existing task membership for a true Akiflow task slot. It does not create new tasks during update. Slot updates interpret dates/times in the stored slot timezone. Repeat `--task-id`, `--add-task-id`, or `--remove-task-id` to include multiple existing tasks.

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

Conversion dry-runs by default. `--execute` creates missing events; `--delete-source` soft-deletes native source tasks only after every selected target passes fresh field verification. Target IDs are reserved in a locked journal before submission; uncertain or missing prior targets block recreation. Connector-backed tasks require `--include-connector-tasks` and are never deleted by conversion v1.

### Projects, Cache, Diagnostics

```bash
af project list --json
af project show <project-id> --json
af project create "Research" --color palette-blueberry --verify --json
af project update <project-id> --title "Reading" --icon "📚" --verify
af project delete <project-id> --dry-run
af project delete <project-id> --yes --verify --json
af refresh --json
af refresh --rebuild --json
af doctor
af doctor --json
af completion zsh
```

Project writes use fresh observations and versioned receipts. Ordinary projects support title, color, icon, sorting, and placement inside an existing folder (`--parent <folder-id>`); omitted fields are preserved. Use `--clear-color`, `--clear-icon`, or `--clear-parent` to clear metadata. Exact IDs take priority; duplicate names are rejected. Deletion soft-deletes only the project and preserves tasks with their existing references. Projects with live sections/children or assigned time slots must have those relationships removed first. Folders and sections are inspection-only; no archive lifecycle is claimed.

### Aki assistant

```bash
af aki list --json
af aki create --title "Planning question" --json
af aki history <conversation-id> --json
af aki send "Explain time blocking; do not modify anything" \
  --conversation <conversation-id> --allow-actions --json
af aki send "An explicit follow-up" --conversation <conversation-id> --allow-actions --no-wait --json
af aki stop <conversation-id>
```

Aki can perform server-side account actions. Every prompt requires `--allow-actions`; there is no verified read-only chat mode. The CLI never executes instructions returned in a response. Conversation membership must include the selected login and Aki. Sessions and chat content stay in memory and are not written to the CLI cache or logs.

Submission returns a generated message ID. Waiting observes fresh posted replies for up to 120 seconds (`--timeout 1..300`); `reply_received` means a reply was observed, not that every server-side action or later reply has finished. Aki does not expose a verified turn-completion marker. `--no-wait` returns after acceptance. An interrupted/uncertain write is never replayed; inspect history before manually submitting again. `stop` requests cancellation and does not undo actions already performed.

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

### Read-only provider reconciliation

`af reconcile` compares fresh Akiflow event observations with Google and independently
checks the existing CLI cache. It never refreshes the cache or renews Akiflow credentials.
It reports missing occurrences, duplicates/overlaps, and possible reshape leftovers;
findings exit zero, while incomplete provider reads fail.

```bash
af reconcile
af reconcile --date 2026-09-30 --timezone America/Los_Angeles
af reconcile --from 2026-09-28 --to 2026-09-30 --calendar Personal --json
```

The default calendar is `dichlorodiphen@gmail.com`; `--calendar` replaces it. Google requires the
schedule watcher's `hatch_gws_cli`, or a compatible executable selected with
`--google-cmd` or `HATCH_GWS_CLI`. Its OAuth behavior must be verified separately
before treating a live invocation as read-only. See [the command reference](docs/COMMANDS.md#af-reconcile)
for coverage, evidence, schema, and exit codes.


Build verification uses Bun 1.3.14 and CI runs on Linux and macOS in UTC and
America/Los_Angeles. `node_modules` is generated locally and must not be committed
as a machine-specific symlink. The package version identifies the release version;
for local patched builds, retain the source revision and patch alongside the binary.

### Separate Akiflow login profiles

The existing login remains the `default` profile with its original config/cache
paths. Named profiles start empty; creating or switching profiles never copies
credentials, calendar mappings, caches, numbered-task context, pending writes, or
mutation journals.

```bash
af profile create work
af --profile work auth login
af --profile work auth status --json
af profile use work
af profile status --json
af --profile default task list
```

Selection precedence is `--profile NAME`, then `AF_PROFILE`, then the saved default
(`default` initially). The selection is pinned for each command; changing the saved
default affects future invocations. `AF_CONFIG_DIR` and `AF_CACHE_DIR` override the
base roots: named profile data lives under each root's `profiles/NAME/`. Existing
`config.json` timezone settings remain profile-local. `profile list`, `profile
status`, `auth status --json` and `doctor --json` identify the selected profile.

A profile represents a separate **Akiflow login**, not a Google account connected
inside that login. Connected provider accounts retain their Akiflow account IDs;
use explicit account/calendar selectors and provider bindings for those. Login
profiles cannot make a disconnected or read-only provider writable. Profile names
are restricted to letters, digits, `_` and `-`; there is no profile-delete command,
so switching cannot erase unresolved writes or credentials.

`af auth verify --json` checks the authenticated Akiflow web identity and binds the
current profile to that user. Browser login verifies this identity before importing
credentials. A bound profile refuses another user's credentials, including rotated
tokens with a conflicting user claim; logout retains the binding and cached data.
Use a new profile to sign into a different Akiflow identity. Legacy cache records
are checked for conflicting owners when binding. Decoding a JWT is only a local
mismatch guard; the authenticated web identity response establishes the binding.
