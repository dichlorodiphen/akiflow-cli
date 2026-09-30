# AKIFLOW-CLI KNOWLEDGE BASE

Private Bun-native Akiflow CLI with a resource-first command surface.

## Structure

- `src/index.ts` registers top-level resources: `task`, `event`, `slot`, `batch`, `convert`, `cal`, `calendar`, `project`, `auth`, `cache`, `doctor`, `refresh`, and `completion`.
- `src/commands/task/index.ts` exposes `list`, `create`, `complete`, `update`, `plan`, `snooze`, and `delete`.
- `src/commands/event.ts` exposes `create`, `update`, `delete`, and `attendees add|remove`.
- `src/commands/slot.ts` exposes `list`, `show`, `create`, `update`, and `delete`.
- `src/commands/create.ts` contains the shared task, event, and slot creation implementations and payload builders.
- `src/commands/ls.ts` contains the task list implementation used as `af task list`.
- `src/commands/do.ts` contains the task completion implementation used as `af task complete`.
- `src/lib/task-context.ts` resolves full UUIDs without list context and short IDs or prefixes from `last-list.json`.

## Canonical Commands

```bash
af task list
af task create "Title"
af task complete <id> [more ids...]
af task update <id> --title "New title"
af task plan <id> --date tomorrow --at 09:00
af task snooze <id> --duration 1d
af task delete <id>

af event create "Title" --date 2026-06-20 --at 09:00 --duration 30m
af event update <event-id> --title "New title"
af event attendees add <event-id> person@example.com
af event attendees remove <event-id> person@example.com

af slot create "Focus" --date 2026-06-20 --at 10:00 --duration 1h
af convert tasks --to events --search "Trip:" --execute --delete-source
af project list
af cal --date today
```

## Removed Legacy Commands

Do not use or document these old top-level commands:

- `af add`
- `af ls`
- `af do`
- `af block`
- `af create`
- `af hello`

Use the resource-first replacements instead: `af task create`, `af task list`, `af task complete`, `af slot create`, and `af event create`.

## Short ID Context

`af task list` saves task context to the cache. Short task IDs and unique ID prefixes depend on that context. Full UUID task IDs work without context.

## Mutation Outcomes

Mutation JSON uses a versioned receipt envelope. `accepted` means submitted, not confirmed. Use `--verify` for bounded fresh field confirmation (default timeout 15s); unknown, failed, pending, mismatch, timeout, and partial results exit non-zero. Never automatically rerun uncertain writes. Conversion source deletion requires every target to pass fresh verification first.

## Development

```bash
bun run typecheck
bun run lint
AF_CACHE_DIR=/private/tmp/af-test-cache bun run test
```

Use `bun`, `bunx`, and the existing citty command patterns. Keep command docs, completions, and repo skill docs in sync with the exposed CLI surface.
