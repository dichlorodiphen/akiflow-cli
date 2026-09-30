# Workstream K — Auth and transport hardening

Implementation is in `ws/k-auth-transport`.

| Item | Change and evidence |
| --- | --- |
| K1 | Explicit `auth login`; bare `auth` prints help and matched subcommands never fall through to scanning. Actual citty runner tests exercise status, logout, refresh, bare auth, and login with browser extraction stubbed. |
| K2 | Shared `refreshAccessToken` posts unchanged JSON to the configured refresh endpoint, validates tokens/expiry, and returns null on rejection, malformed payload, timeout, or connection failure. |
| K3 | `auth refresh` saves replacement tokens only after successful renewal. Fake endpoint success rotates tokens; wrong refresh token exits nonzero and retains byte-identical credentials. Missing refresh token falls back to login. |
| K4 | Concurrent 401s share one refresh promise; late 401s reuse an already rotated token. Failed refresh reloads disk credentials before one guarded retry. API and refresh requests use `AF_REQUEST_TIMEOUT_MS` (positive milliseconds, default 30000). Timeouts name method/path; `HttpError` adds status/path/raw response body while retaining readable HTTP messages. Tests cover eight concurrent requests, API/refresh latency, HTTP errors, disk rotation, and repeated 401 refusal. |
| K5 | Same-directory exclusive 0600 temporary file plus rename publishes complete credentials. Independent-process raw reads remain valid during 100 writes; a pinned reader retains its original complete snapshot. No fsync durability guarantee. |
| K6 | `doctor --strict` adds severity and recovery checks in text/JSON, skips API health when credentials are missing, and exits nonzero on critical checks. Default report formatting and JSON fields remain unchanged. |

Command docs, README, the hand-maintained completion manifest (all generated
shells), and the repository skill installation reference now use `auth login`
and document strict diagnostics.

## Verification

New coverage: three unit tests and fifteen integration tests using the existing
`FakeAkiflowServer`, `makeTestEnv`, and local citty runner. No second fake,
production requests, or real credentials. Browser extraction is stubbed.
The local CLI runner now honors request abort signals and captures/restores
`process.exitCode`, and includes auth/doctor commands.

Temporarily reverting each of dispatch, refresh retention, shared refresh,
request timeout, and atomic writes caused its selected regression test to fail.
The fixed targeted run passed all 18 tests. Atomic publication's pinned-inode
assertion makes its reversion check deterministic even when individual writes
complete too quickly to expose a partial JSON read.

UTC prescribed suite: **358 unit pass, 0 fail; 34 integration pass, 8 skip,
37 fail**. Untouched baseline: **355 unit pass, 0 fail; 19 integration pass,
8 skip, 37 fail**. The integration failure names match exactly (zero new
failures); loopback listeners are rejected with `EPERM` here. API-unreachable
coverage uses the fake's connection-drop fault at the isolated closed-port base.
The two-failure environment described in the brief is not available here.
The Los Angeles run has the same pass/failure counts and identical failure names.
Raw `bun test` was also compared: baseline 350 pass / 61 fail, final 368 pass /
61 fail, with identical failure names (the raw target lacks the unit preload).

Typecheck passes. Repository lint reports two pre-existing errors in untouched
`src/__tests__/lib/cache/lock.test.ts` (format) and
`src/__tests__/integration/surface.integration.test.ts` (control-character regex).
Changed TypeScript files pass Biome checks apart from non-fatal warnings.

Commit is blocked: `git add` cannot create
`/home/hatch/workspace/akiflow-cli/.git/worktrees/k/index.lock` because the linked
Git metadata is read-only. Changes remain in this worktree; no push attempted.
Suggested commit: `fix(auth): harden dispatch, credential rotation and transport`.
