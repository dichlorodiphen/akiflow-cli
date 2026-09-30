# AKIFLOW-CLI KNOWLEDGE BASE

Private Bun-native Akiflow CLI with a resource-first command surface.

## Structure

- `src/index.ts` registers top-level resources: `task`, `event`, `slot`, `convert`, `cal`, `project`, `auth`, `cache`, `doctor`, `refresh`, and `completion`.
- `src/commands/task/index.ts` exposes `list`, `create`, `complete`, `update`, `plan`, `snooze`, and `delete`.
- `src/commands/event.ts` exposes `create`, `update`, and `attendees add|remove`.
- `src/commands/slot.ts` exposes `create`.
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

## Development

```bash
bun run typecheck
bun run lint
bun run test:unit # includes src/__tests__/version.test.ts
bun run test:integration
bun run test:ci # typecheck + non-writing lint + both full test suites
bun run test:smoke # compile to a temp path and check the standalone binary
```

For isolated full-suite verification, set `AF_CONFIG_DIR` and `AF_CACHE_DIR` to
fresh temporary directories, `AF_API_BASE=http://127.0.0.1:1`,
`AF_REFRESH_URL=http://127.0.0.1:1/oauth/refreshToken`, and `AF_NO_AUTO_SYNC=1`.
Run `bun run test:ci` under both `TZ=UTC` and `TZ=America/Los_Angeles`, as CI does.
`bun run test` remains the combined unit and integration target. The lint and
typecheck scripts use `bun x --no-install` so checks use installed dependencies.
The unit preload isolates config/cache, clears endpoint overrides for mocked
URL assertions, and rejects unmocked external fetches.

Use `bun`, `bunx`, and the existing citty command patterns. Keep command docs, completions, and repo skill docs in sync with the exposed CLI surface.
