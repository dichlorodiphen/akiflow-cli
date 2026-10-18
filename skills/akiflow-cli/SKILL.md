---
name: akiflow-cli
description: Manage Akiflow tasks, calendar events, task slots, and cache state through the private resource-first `af` CLI.
metadata: {"openclaw":{"emoji":"📋","requires":{"bins":["af"]}}}
---

# Akiflow CLI

Use `af` for Akiflow task and calendar work. Checked against local audited build `0.3.6-audit.1`, based on upstream `1ff76ab` with local fixes. The installation provenance records the patch and binary hashes. Use command `--help` for flags, but heed the incomplete-feature limits below.

Prefer `--json --envelope` for reads. Check `schema_version`, `errors`, `warnings`, and the command-specific `result` shape; it is not always an array. For mutations, prefer `--json --no-envelope` to retain native receipt status and receipts at the top level. Read [output and recovery](references/output-and-recovery.md) for receipt parsing, uncertain writes, and cache/auth diagnosis.

## Freshness, previews, and outcomes

- Task reads use local observations plus pending intents. Run `af refresh --json` when the user asks for current state; inspect its outcome before trusting subsequent reads. Calendar reads may auto-refresh and are not strictly offline. Mutation previews read local cache without authentication, sync, or writes; refresh separately if needed.
- All task/event/slot mutations accept `--dry-run`. Batch and conversion preview by default and require `--execute` to write. Do not combine `--execute` with `--dry-run`.
- A mutation receipt with `status: "accepted"` means submitted, not confirmed. Add `--verify` to the original authorized write when fresh field confirmation is needed (15-second default). This confirms observed Akiflow state, not Google/provider application. Failed, unknown, pending, mismatch, timeout, or partial results are not success, even if a returned object looks correct.
- Never repeat a write simply to verify it, including when the CLI says “re-run with --verify.” Inspect fresh records first after an uncertain result. Preserve operation IDs and any conversion resume token.
- `pending: true` and `pending_conflict` describe local intent, not server confirmation. Pending intents do not expire by age. Refresh and inspect observed state to resolve uncertainty; do not delete cache files to make a warning disappear.

## Tasks and identifiers

```bash
af task list --today --json --envelope
af task list --date 2026-10-19 --json --envelope
af task list --inbox --json --envelope
af task list --search "review" --json --envelope
af task list --from 2026-10-19 --to 2026-10-21 --json --envelope
af task list --all --json --envelope
```

Filters include `--status inbox,planned,done,trashed,active,all`, `--connector gmail|linear|akiflow|none`, `--priority 1|2|3`, `--project`, `--tag`, `--bucket week|month`, `--recurring`, and `--overdue`. Normal queries exclude trash; `--all`, `--trashed`, or explicit trash/all status filters include it. Deleted tasks remain hidden.

Every task list, including JSON/raw, saves numbered context and publishes a snapshot token (`meta.snapshot` in JSON, `Snapshot:` in text). Prefer full UUIDs. Pin numeric IDs with `--snapshot <token>` on complete/update/plan/snooze/delete; mismatched tokens fail. Unpinned numeric IDs currently warn; `AF_STRICT_IDS=1` requires a token. UUID prefixes resolve against the full cached inventory, with a warned last-list fallback if unavailable. Synthetic `virtual:...` task/event occurrences are read-only; resolve the real task or event before a mutation.

```bash
af task create "Task title" --today --dry-run --json
af task create "Task title" --date 2026-10-19 --at 14:30 --duration 1h --timezone America/Los_Angeles --verify --json --no-envelope
af task update <task-uuid> --title "New title" --description-file details.txt --dry-run --json
af task plan <task-uuid> --date 2026-10-19 --at 14:30 --timezone America/Los_Angeles --verify --json --no-envelope
af task snooze <task-uuid> --duration 1d --dry-run --json
af task complete 1 --snapshot <token> --verify --json --no-envelope
af task delete <task-uuid> --dry-run --json
```

Complete tasks only when the user asks. Task deletion requires explicit user authorization; an existing explicit instruction counts.

Dates are local calendar dates; use explicit `YYYY-MM-DD`. Creation accepts `--timezone <IANA>` with flag > profile (`~/.config/af/config.json`, or `$AF_CONFIG_DIR/config.json`) > host precedence. Task plan/snooze and event update preserve the existing record's zone ahead of profile/host unless explicitly overridden. DST gaps are rejected; ambiguous folds require `--fold first|second`.

`task plan --date` without `--at` preserves an existing timed task's wall-clock time; use `--clear-time` for date-only. Snooze `m`/`h` units add elapsed time; `d`/`w` preserve wall-clock time across DST. Slot update does **not** accept `--timezone`/`--fold`; it preserves and interprets timing in the stored slot timezone. Inspect the preview's UTC instants.

## Calendars and availability

```bash
af calendar list --json --envelope
af calendar default --json --envelope
af calendar resolve "Personal" --json --envelope
af cal --today --json --envelope
af cal --from 2026-10-19 --to 2026-10-23 --summary --json --envelope
af cal --date 2026-10-19 --free --min-duration 30m --json --envelope
af cal --today --no-events --json --envelope
af cal --today --calendar "Personal" --json --envelope
```

Calendar selectors accept Akiflow ID, origin calendar/email, or a unique title. `cal` merges events, task slots, and scheduled tasks. Hidden calendars and hidden/deleted/declined events are excluded by default; an explicit calendar can select a hidden calendar. Use `--declined` only when asked. Account/connector/calendar filters and `--no-events`, `--no-slots`, `--no-tasks` control included sources.

`--summary` returns counts and unioned, window-clipped `busy_minutes`; counts include linked constituents, so do not sum their durations. `--free` returns free windows across selected sources. Cleaned JSON calls slots `time_slot`; summary/raw source names use `slot`.

`cal` and `audit` use explicit `--timezone`, then profile timezone, then host timezone for day selection/rendering. Native calendarless scheduled tasks remain visible unless explicitly calendar-filtered. Task-list date selectors use the process timezone; use `TZ=America/Los_Angeles af task list --date 2026-10-19 --json --envelope` for cross-zone task-list dates. Reconcile uses its own effective-zone implementation with the same explicit/profile/host precedence.

Calendar warnings cover stale data (events older than 10 minutes), possible duplicates, and possible reshape leftovers. Rebuild with `af refresh --rebuild --json` and recheck stale results before diagnosing missing/duplicate events. A similarity warning is evidence to investigate, not authorization to delete. Confirm ambiguous provider state in the calendar UI.

## Events and task slots

Use `event` for real Google Calendar events and `slot` for Akiflow task blocks:

```bash
af event create "Meeting" --date 2026-10-19 --at 14:30 --duration 30m --timezone America/Los_Angeles --description "Details" --location "Office" --dry-run --json
af event update <event-id> --date 2026-10-19 --at 15:00 --duration 1h --description-file details.txt --verify --json --no-envelope
af event attendees add <event-id> julia@example.com --dry-run --json
af event attendees remove <event-id> julia@example.com --verify --json --no-envelope
af event delete <event-id> --dry-run --json
af slot list --date 2026-10-19 --json --envelope
af slot show <slot-id> --json --envelope
af slot create "Planning" --date 2026-10-19 --at 14:30 --duration 1h --timezone America/Los_Angeles --task-id <task-uuid> --dry-run --json
af slot update <slot-id> --add-task-id <task-uuid> --dry-run --json
af slot update <slot-id> --remove-task-id <task-uuid> --dry-run --json
af slot delete <slot-id> --dry-run --json
```

Event mutations use **`--send-updates none|all`**, default `none` (silent). `--notify` is obsolete and rejected. Use `all` when guest notifications are requested. Deleting through Akiflow propagates cancellation to Google even with notifications suppressed. Event/batch delete requires `--confirm` for targets absent from the local CLI creation journal; use it only for a deletion already authorized by the user.

Event update/delete support writable timed Google records, including series masters with explicit `--scope series`. Series deletion can use `--truncate-before YYYY-MM-DD` as an exclusive local-day cutoff; foreign deletion/truncation requires --confirm. Series scope rejects instance IDs. Attendee commands still reject recurring targets. All-day, hidden, deleted, and read-only writes are refused. Event creation accepts `--rrule`; `--verify` compares the requested recurrence too. Per-instance edits/deletes remain unsupported because the Google adapter is a stub. Read [advanced calendar operations](references/advanced-calendar.md) before recurrence work, `audit`, or `reconcile`.

Slot update moves/resizes/renames a true slot and links/unlinks existing tasks; it does not create tasks. Repeat `--task-id`, `--add-task-id`, or `--remove-task-id` for multiple existing tasks; IDs resolve before writes. Use `slot create --task "Title"` to create a task inside a new slot. Slot list and batch slot selection accept account/connector/calendar filters.

## Batch and conversion

```bash
af batch events attendees add julia@example.com --search "Trip:" --from 2026-10-19 --to 2026-10-23 --json
af batch events attendees add julia@example.com --search "Trip:" --from 2026-10-19 --to 2026-10-23 --execute --verify --json --no-envelope
af batch events delete --date 2026-10-19 --search "Disposable" --json
af batch slots delete --from 2026-10-19 --until 2026-10-23 --search "Temp" --json
af convert tasks --to events --search "Trip:" --from 2026-10-19 --until 2026-10-23 --json
```

Prefer batch selectors over shell mutation loops. Batch requires at least one selector. Inspect changed/no-op/skipped/failed items as well as overall status.

Conversion requires a task selector or explicit `--all`. `--to events` selects the target surface; use `--until`/`--range-to` for the date range end. Executing requires `--execute`; optional `--delete-source` requires every target to pass fresh verification before any source deletion. Connector-backed sources require `--include-connector-tasks` and are never deleted by conversion. Target IDs are reserved durably under lock before submission. Journal mappings and `--resume <token>` support recovery; missing/unreadable prior targets and corrupt journals refuse recreation. Inspect fresh targets before resuming an uncertain conversion; do not delete mappings to force a retry.

## Diagnostics and limits

```bash
af project list
af auth status
af doctor --strict --json
af completion zsh
```

`auth login` imports existing browser tokens; bare `auth` prints help. `auth refresh` renews saved credentials (and can fall back to browser import if no refresh token exists). Use auth/cache-changing commands for the requested troubleshooting or freshness task; see [output and recovery](references/output-and-recovery.md).

Project mutation, all-day event writes, per-instance recurring event writes, reminders, conferencing creation, and Aki chat are unsupported. All-day/recurring reads, RRULE creation, and scoped series update/delete/truncation are available. For installation of this private fork, read [installation](references/installation.md).
