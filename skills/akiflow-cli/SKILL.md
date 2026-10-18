---
name: akiflow-cli
description: Manage Akiflow tasks, calendar events, task slots, and cache state through the private resource-first `af` CLI.
metadata: {"openclaw":{"emoji":"📋","requires":{"bins":["af"]}}}
---

# Akiflow CLI

Use `af` for Akiflow task and calendar work. Checked against private build `0.4.0`. The installation provenance records the source revision and binary hashes. Use command `--help` for flags and heed the limits below.

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

Event create/update/delete support writable timed and all-day Google records. Use `event create --all-day --date YYYY-MM-DD [--end-date YYYY-MM-DD]`; **--end-date is exclusive**, defaults to the next day, and is converted to Akiflow's inclusive stored end. All-day date moves preserve their civil-day span across DST and belong to the selected calendar; all-day updates reject --timezone. Do not supply --at/--duration/--fold for all-day events; timed/all-day conversion is refused.

Recurring events require explicit scope. `--scope series` requires the master UUID; optional `event delete --truncate-before YYYY-MM-DD` is an exclusive day cutoff. `--scope instance` edits/deletes one occurrence through native Akiflow exception operations. Supply the master UUID plus `--instance-anchor` (original explicit-offset ISO time, or YYYY-MM-DD for all-day), or a real materialized instance UUID whose original anchor is observed. Never substitute a moved instance's current start for its original anchor. Deletion of foreign targets requires --confirm. Synthetic `virtual:...` IDs stay read-only. No Google fallback token or capability flag is needed.

Attendee commands still require timed, non-recurring targets. Hidden/deleted/read-only targets are refused; an explicit recurring scope may target a structurally hidden master because the official client marks every recurring parent hidden, then validates the actual occurrence independently. `--verify` confirms fresh Akiflow fields/cancellation for accepted or pending submissions; it does not prove provider propagation. Read [advanced calendar operations](references/advanced-calendar.md) before recurrence work, `audit`, or `reconcile`.

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
af project list --json
af project show <project-id> --json
af project create "Research" --verify --json
af project update <project-id> --title "Reading" --verify --json
af project delete <project-id> --dry-run
af project delete <project-id> --yes --verify --json
af aki list --json
af aki create --title "Question" --json
af aki history <conversation-id> --json
af aki send "Explicit prompt" --conversation <conversation-id> --allow-actions --json
af aki stop <conversation-id>
af auth status
af doctor --strict --json
af completion zsh
```

`auth login` imports existing browser tokens; bare `auth` prints help. `auth refresh` renews saved credentials (and can fall back to browser import if no refresh token exists). Use auth/cache-changing commands for the requested troubleshooting or freshness task; see [output and recovery](references/output-and-recovery.md).

Ordinary project create/update/soft-delete and Aki chat are supported. Project deletion preserves tasks; projects with live sections/children or assigned time slots are refused. Folder/section mutation and project archiving are unsupported. Aki may act on the account; prompts require `--allow-actions` and have no verified read-only mode. Session tokens and chat content are memory-only. `reply_received` means a posted reply was observed, not verified turn/action completion. Use history after an uncertain request; never automatically replay a prompt. `--no-wait` returns after submission; `aki stop` requests cancellation without undoing actions. Reminders and conferencing creation are unsupported. Calendar writes cover timed/all-day events and native scoped series/instance operations. For installation of this private fork, read [installation](references/installation.md).
