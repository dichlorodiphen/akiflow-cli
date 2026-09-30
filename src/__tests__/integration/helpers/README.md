# Behavioral Akiflow test server

`FakeAkiflowServer` is a local behavioral model of the contract in
[`api-spec-akiflow.md`](../../../../api-spec-akiflow.md) and
[`types.ts`](../../../lib/api/types.ts). It never connects to Akiflow, Google,
OAuth providers, or a browser. Its HTTP adapter binds only `127.0.0.1` on an OS
assigned port. `makeTestEnv()` creates isolated temporary cache/config directories,
a synthetic JWT, and redirects **both** `AF_API_BASE` and `AF_REFRESH_URL`.
Always clean up the environment and stop the server in `afterEach`.

```ts
const server = new FakeAkiflowServer({ pageSize: 2 });
await server.start();
loadAllFixtures(server); // seeds stores, not immutable GET responders
const env = makeTestEnv(server.url);
try {
  const result = await spawnCli(["refresh", "--rebuild", "--json"], { env: env.env });
  expect(result.exitCode).toBe(0);
} finally {
  await server.stop();
  env.cleanup();
}
```

## Architecture and state

There are three separate layers of truth:

1. **Canonical stores** (`stores`, `snapshot(resource)`) hold applied events,
   tasks, and time slots. Supporting sync resources include calendars, accounts,
   contacts, labels and tags. Seed and write input is cloned. Client entity UUIDs
   are preserved (the API uses client-generated IDs); missing provider
   `origin_id` values are assigned by the server. Titles are trimmed, defaults
   filled, and server timestamps replace submitted timestamps. `created_at` and
   `updated_at` are also exposed, alongside `global_created_at/global_updated_at`.
   Those extra fields and synthetic task/slot origin IDs deliberately make
   canonical divergence observable; they do not assert provider behavior.
2. **Operation receipts** (`operations`, `operationHistory`) have independent
   server IDs, retain `event_id`, and transition `pending → succeeded | failed`.
   The API type calls applied operations **`succeeded`**, not `applied`.
   `processed_at`, `failed_at`, `result`, and `status` are always returned.
   Successful results contain canonical event rows; failures contain an error
   code/message. `success:true` means the envelope was accepted and may contain
   failed operations. `failed[].id` references the returned server operation ID,
   deliberately exercising clients that confuse client IDs with receipt IDs.
   Reposting an identical client operation ID reuses its receipt and does not
   apply twice. Reposting a new ID is a new operation, including after a 500.
3. **GET-visible state** and per-resource change journals are published separately
   from canonical writes. `visibilityRequests: N` hides a change for the next N
   further requests, making it visible on request N+1. Requests to any endpoint
   count, including failed requests. `visibilityMs` waits at least that many
   milliseconds; publication happens at the next request, rather than on a
   background timer. When both are set, both thresholds must be satisfied.
   `operationDelayRequests: N` independently keeps receipts pending for N further
   requests before applying/failing on request N+1. Visibility delay then starts
   at application. `GET /v5/event_operations` exposes current receipts for tests;
   this is a simulator control, **not a claim that production offers polling**.

`seed(resource, rows)` replaces one resource with normalized rows and resets its
journal. Seed before syncing; existing cursors should not be reused after reseeding.
`snapshot()` returns a clone, including soft-deleted rows. Avoid mutating `stores`
directly: it bypasses normalization, visibility, and cursor accounting.
Server timestamps advance by one millisecond per write from a fixed default epoch
(`2026-01-01T00:00:00Z`); `epoch` overrides it. `reset()` clears requests, stores,
receipts, faults, cursors and controls, retaining constructor options and listener.

The mutation surface is `POST /v5/event_operations` (create/patch/delete),
`PATCH /v5/tasks`, and `PATCH /v5/time_slots`. Patches merge specified fields;
**omission does not clear an old value**. Thus a task patch containing only `date`
preserves `datetime` and `datetime_tz`, which reproduces I8.
Event deletes set `status:cancelled` and `deleted_at`.
The default `/v3/events/modifiers` response is HTTP 410 as recorded by the spec.
Some legacy request-construction tests explicitly override this endpoint; those
stubs are not evidence that attendee changes work against the supported API.

## Sync protocol

Every resource owns its revision counter and opaque cursor registry. Tokens from
another resource or unknown tokens return HTTP 410 with
`Invalid or expired sync_token`. `expireToken("events")` forces exactly the next
GET of that resource to fail, including a tokenless GET, then allows cold recovery.

A tokenless GET starts a snapshot of currently visible rows and current tombstones.
`limit` and `pageSize` cap the number of new rows per page. While paging, that
snapshot and its revision are frozen: concurrent writes appear in the next delta,
not halfway through the snapshot. Every response issues a new cursor, including
empty deltas. `has_next_page:true` cursors advance through the snapshot; the final
cursor records its revision. Following GETs return changes after that revision in
server publication order. Replaying a cursor is supported.

With `duplicatePageBoundaries:true`, subsequent pages repeat the previous page's
last row **in addition to** their new rows. The response can therefore contain
`limit + 1` rows; progress counts only new rows. This exercises duplicate folding.
Deleting removes the live GET row and journals a tombstone. A delta returns that
tombstone; the next delta using its final token omits it. Replaying an older token
can return it again, as a real incremental protocol would. Cold snapshots retain
one current tombstone per deleted ID. Restoring clears its current tombstone.

## Fault DSL

`schedule(...faults)` accepts one-shot rules. Selectors `index` (one-based arrival
index), `path` (pathname only), and `predicate(request)` can be combined with AND.
Omit selectors to match the next request. A matching rule is consumed before any
await, so concurrent requests cannot consume it twice. `requests` records method,
URL/query, headers, raw body and index, including refresh requests and failures.

```ts
server.schedule(
  { index: 1, type: "latency", ms: 50 },
  { path: "/v5/tasks", type: "rate-limit", retryAfter: 3 },
  { predicate: r => r.method === "POST", type: "drop" },
);
server.schedule({ path: "/v5/event_operations", type: "after-apply" });
```

- `latency`: fixed delay before handling. Use request barriers for ordering tests.
- `rate-limit`: HTTP 429, `Retry-After` in seconds, no application.
- `drop`: destroys the incoming TCP socket without an HTTP response or application.
- `after-apply`: handles the request, including its mutation, then returns HTTP 500.
  Pending operation delay is bypassed for this fault so canonical application has
  happened before the response is lost. GET visibility delay still applies.
  Schedule it on a mutation path; it demonstrates why retrying with fresh IDs can
  duplicate side effects.

Matching latencies/gates run in registration order. Drop takes precedence over
rate limiting, which takes precedence over normal handling. Do not combine
`rate-limit`/`drop` with `after-apply` when testing uncertain outcomes.

A gate holds exactly one matching request and exposes an arrival signal:

```ts
const gate = server.gate({ path: "/v5/event_operations" });
const first = spawnCli(firstArgs, { env: env.env });
await gate.entered;
try {
  // Start another client while the first request is held.
} finally {
  gate.release();
  await first;
}
```

`respondTo(method, path, responseOrFunction, status?)` remains an escape hatch;
the latest matching override wins, and async responders are supported. Overrides
bypass behavioral application and sync. They run after auth/fault controls. Prefer
`seed`, lifecycle controls and faults; an echo override recreates the defect this
server was built to catch. Unknown routes return 404.

## Scenario catalog and confirmed incident probes

Each scenario can be configured in one or two lines:

| Scenario | Builder | Correct CLI behavior / observed current defect | Fix owner |
| --- | --- | --- | --- |
| Fabricated acceptance | `server.scenarios.fabricatedAcceptance(true)` | `success:false` must not print creation success; current CLI prints “created successfully”. | A |
| Failed receipt | `server.scenarios.fabricatedAcceptance()` | Accepted envelope containing a failed receipt must surface failure; current CLI prints creation success. | A |
| Mixed batch | `server.scenarios.mixedBatch(op => op.event_id === badId)` | Report applied and failed items independently; current CLI reports two failed despite one applied. | A |
| Stale base chain | `server.scenarios.staleBaseChain(); const gate = server.gate({ path: "/v5/event_operations" });` | Competing independent edits preserve both fields; current last full snapshot erases the other description. | A/E |
| Lock race | `const gate = server.scenarios.lockRace();` | Second rebuild cannot enter while the first is held; current second rebuild completes before the first resumes. | C |
| Timed snooze | `server.scenarios.snooze(taskUuid)` | `1h` moves the actual instant and preserves its zone; current PATCH omits both timing fields. | F |
| Date-only planning | `server.scenarios.snooze(taskUuid)` | Move to the new date preserving wall time; current datetime stays on the old date. | F |
| Cancelled update intent | `server.seed("events", [{ ...event, status: "cancelled" }])` | Reject cancelled targets without dispatching delete; current update sends a delete operation. | E |

`strictBase:true` optionally rejects patch operations whose supplied base fields
do not equal the canonical row (`result.error:stale_base`). This is a simplified
optimistic conflict model, not a reproduction of undocumented Google conflict
resolution. Default mode applies competing patches in application order, making
lost full-snapshot fields observable. Failure predicates receive the original
submitted operation, before its receipt ID changes.

All eight incident tests in `../fake-server.behavioral.test.ts` were executed as
ordinary tests against the current CLI on 2026-09-30 and failed at the expected
assertions above. They are now `test.skip`, with an owner and expected behavior
comment. The model's own tests and working CLI auth/uncertain-write controls stay
active. No CLI bug is fixed by this workstream.

To land a fixing workstream, change its corresponding `test.skip` to `test`, run
it with the owning change, then revert that fix and verify the assertion fails
again. A receipt schema migration may require updating JSON field paths; preserve
the server-truth assertions and the expected applied/failed counts. The competing
update probe allows a repaired command queue to wait before releasing its first
request. Cache races test actual overlapping rebuilds against one isolated cache.

## Running tests and transport limits

```bash
bun test src/__tests__/integration/fake-server.behavioral.test.ts \
  src/__tests__/integration/helpers/fake-server.behavior.test.ts
TZ=UTC bun test src/__tests__/commands/ls.test.ts
TZ=America/Los_Angeles bun test src/__tests__/commands/ls.test.ts
bun test src/__tests__/integration
bun run typecheck
```

`dispatch(Request)` runs the exact same behavioral engine as the HTTP adapter.
`run-local-cli.ts` uses the real citty command parser/handlers, isolated credentials
and filesystem cache, and intercepts **all** fetches into this engine. It never
falls through to native fetch. It captures stdout/stderr and intercepts
`process.exit`; restore its spies with `cleanup()`. This lets incident probes run
in sandboxes that disallow loopback listeners. Use it sequentially with unrelated
tests because fetch/console/exit/env are process globals; concurrency inside one
session intentionally models competing command handlers.

The original `spawnCli()` helper still launches the CLI in a separate Bun process
and exercises real HTTP through `start()/stop()`. Those tests require loopback
socket permission. The development sandbox rejected listeners with `EPERM`, so
the complete socket integration suite could not be validated here; that is an
environmental failure, not a behavioral CLI probe. In-process drop tests verify
connection-failure signaling; actual abrupt TCP close is exercised only through
the socket adapter. Neither adapter models Google delivery, JWT signature checks,
provider notification delivery, quota policy, or every provider conflict rule.
The fake preserves protocol distinctions needed for incident tests, rather than
claiming to be the production service.

The recurring-task unit fixture freezes the clock at a fixed local Wednesday
noon and uses a literal `BYDAY=WE`; it no longer derives its weekday from the
wall clock. The recurrence anchor is Wednesday in both UTC and local time,
including UTC+14 and UTC-12. The fixture suite passed in UTC, Los Angeles,
Kiritimati, UTC-12 and Kathmandu. Date-sensitive command tests restore the clock
and isolated env.
