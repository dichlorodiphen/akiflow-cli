# Akiflow CLI Commands Reference

## Parsing and automation contracts

Unknown commands, unknown flags, and extra positional arguments fail before authentication or cache access and name the offending token. Flags accept `--name=value`, `--name value`, declared aliases, short boolean bundles, boolean negation (`--no-name`), and `--` to end option parsing. Variadic IDs/emails are supported only by task complete and attendee commands (including batch attendees). Validation exits with code 2. Invalid date selectors, impossible dates, and partially parsed dates are errors; task list and cal never broaden the selection or substitute today after a parse failure. They share one strict selector parser for `--date`, `--from`, `--to`, and list `--month`.

Every task/event/slot mutation accepts `--dry-run`, including event delete and slot update/delete. Previews read local caches without authentication, sync, or writes. Run `af refresh` first when the inventory is missing. Output includes resolved IDs and titles, normalized before → after values, and the notification policy. Task plan/snooze/delete also accept `--json`. Batch and convert default to this preview mode; `--dry-run` explicitly confirms it. Combining `--execute --dry-run` is a validation error.

```bash
af task update <uuid> --title "New title" --dry-run --json
af event delete <event-id> --notify none --dry-run --json
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
af event create <title> --date <date> --at HH:MM --duration <duration> [--calendar <calendar>] [--description <text>|--description-file <path>] [--location <text>] [--json]
af event update <event-id> --date <date> --at HH:MM --duration <duration> [--title <text>] [--description <text>|--description-file <path>] [--location <text>] [--json]
af event delete <event-id> [--notify all|none] [--json]
af event attendees add <event-id> <email> [more emails...] [--json]
af event attendees remove <event-id> <email> [more emails...] [--json]
```

Event v1 supports timed, writable, non-recurring Google events only. All-day, recurrence, reminders, and conferencing are unsupported. Event delete defaults to `--notify all`; use `--notify none` for disposable cleanup.

## Batch Operations

```bash
af batch events attendees add <email> [more emails...] [event selectors] [--execute] [--json]
af batch events attendees remove <email> [more emails...] [event selectors] [--execute] [--json]
af batch events delete [event selectors] [--notify all|none] [--execute] [--json]
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

Conversion dry-runs by default. Source deletion is only allowed with `--execute --delete-source`.

## Read-Only Projects, Auth, Cache, Diagnostics

```bash
af project list
af auth
af auth status
af refresh [--rebuild] [--json]
af doctor [--json]
af completion bash|zsh|fish
```
