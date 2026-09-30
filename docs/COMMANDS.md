# Akiflow CLI Commands Reference

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

Short IDs come from the last non-JSON `af task list`. Full UUIDs work without list context.

## Events

```bash
af event create <title> --date <date> --at HH:MM --duration <duration> [--calendar <calendar>] [--description <text>|--description-file <path>] [--location <text>] [--json]
af event update <event-id> [--date <date>] [--at HH:MM] [--duration <duration>] [--title <text>] [--description <text>|--description-file <path>] [--location <text>] [--json]
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
