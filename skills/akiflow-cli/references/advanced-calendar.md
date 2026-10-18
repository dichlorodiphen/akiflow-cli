# Recurrence, calendar review, and provider reconciliation

Use the current feature build; check `af --version` and the installation provenance for its source commit.

## Recurrence capability boundaries

Distinguish series operations from per-instance writes:

| Operation | Installed behavior |
| --- | --- |
| Read recurring/all-day events | Calendar occurrence reads expand cached series and preserve materialized exceptions |
| Create a timed or all-day Google RRULE event | `event create --rrule` builds a recurrence payload and previews up to five occurrences |
| Update/delete a recurring series | Explicit --scope series and series master ID; foreign deletion requires --confirm |
| Change attendees on recurring events | Refused by the attendee command |
| Update/delete one recurring occurrence | Native v5 exception operation with `--scope instance`; original anchor required; no external Google token |
| Create/update/delete all-day events | Date-only flags; CLI end date is exclusive and Akiflow stored end is inclusive |
| `event delete --scope series --truncate-before YYYY-MM-DD` | Submits a recurrence-only patch ending before that local day; preserves exclusions and finite bounds; foreign target requires --confirm |

Interpret accepted/pending receipts as submitted until verified. `--verify` confirms fresh Akiflow state and native instance cancellations, not Google propagation. Do not replay an uncertain operation to verify it.

```bash
af event create "Away" --all-day --date 2026-11-01 --end-date 2026-11-03 --verify --json --no-envelope
af event update <master-uuid> --scope instance --instance-anchor 2026-11-07T09:00:00-08:00 --at 10:00 --duration 45m --verify --json --no-envelope
af event delete <master-uuid> --scope instance --instance-anchor 2026-11-07T09:00:00-08:00 --confirm --verify --json --no-envelope
af event update <all-day-master-uuid> --scope instance --instance-anchor 2026-11-11 --date 2026-11-12 --verify --json --no-envelope
```

The anchor is the original start, including when an instance has moved. Real materialized instance IDs supply their observed original anchor; unmaterialized occurrences require the series master UUID and explicit anchor. The CLI checks fresh series/account/calendar identity and recurrence membership, uses Akiflow's official stable occurrence UUID contract, and submits an anchored native operation. It refuses ambiguous exceptions, cancelled/hidden targets, excluded anchors and unsupported recurrence expansion. Only the selected occurrence changes; it never loops over siblings. For materialized all-day exceptions, deletion uses the fresh observed provider-backed Akiflow exception UUID directly: live acceptance found that the service acknowledged anchored deletes of moved all-day exceptions without applying them to Google. The direct route was verified against the provider with siblings intact. Unmaterialized all-day occurrences use the native original-date/parent route. The route is chosen before submission; failed or uncertain operations are never automatically replayed. Foreign instance deletion requires `--confirm` even if its master was originally created by the CLI.

All-day `--end-date` is exclusive. Omit it for one day on create or to retain the existing civil-day length on a move. All-day dates belong to their selected calendar. The service may canonicalize stored event timezone to null; all-day update rejects --timezone because it does not change the civil-date span. No implicit timed/all-day conversion is supported. A date-only recurrence preview displays civil dates.

For authorized recurring creation, first preview a bounded rule:

```bash
af event create "Planning" --date 2026-10-19 --at 09:00 --duration 30m --timezone America/Los_Angeles --rrule 'FREQ=WEEKLY;COUNT=3' --dry-run --json
```

Recurrence preview preserves owner wall-clock time across DST. Check the intended rule/zone and provider-rendered occurrences when provider delivery matters. `--verify` compares requested recurrence fields but does not establish complete provider recurrence behavior.

Read expansion uses cached recurrence rules, series timezone, and original occurrence anchors. Materialized moved/hidden/cancelled/deleted exceptions suppress the original slot. Synthetic event IDs have the shape `virtual:recurrence:...` and are read-only. Synthetic task IDs are likewise not mutation targets.

Expansion is bounded: 366 days without an upper bound, 1,000 generated slots and 100,000 examined candidates per series, including historical candidates. Very old dense rules may exhaust the work limit before the requested window. Malformed rules/zones and EXRULE series are not expanded. Incomplete or invalid expansion emits warnings. Missing virtual occurrences alone do not establish missing provider events. Distinguish observed records from generated ones.

## Local calendar review with `audit`

```bash
af audit --timezone America/Los_Angeles --date 2026-10-19 --json
af audit --timezone America/Los_Angeles --from 2026-10-19 --to 2026-10-23 --calendar "Personal" --min-duration 30m --json
```

Audit accepts today/tomorrow/date/from/to, account/connector/calendar, and min-duration selectors. It accepts `--timezone`, with profile then host fallback. Plain output groups FETCH, COVERAGE, DISCREPANCIES, and EFFECTIVE. Native JSON is `{schema_version: 1, audit, envelope}`. With universal `--envelope`, that whole report is under `result`.

Inspect fetch timestamps/generation, coverage freshness, discrepancies, and the review envelope's occurrences, busy minutes and free windows. Overlaps are unioned and clipped to the window; linked events own time ahead of slots and tasks. Linked constituents remain visible, so counts are not additive occupied time. Echo suggestions retain records and do not automatically suppress them; native tasks without provider identities are not echo-grouped. Local pending tasks are intent, not provider evidence.

`audit` and `cal` can auto-refresh. They are cached calendar reviews, not independent fresh Google comparisons. For a suspected sync/cache gap use `reconcile` when its helper is available.

## Fresh read-only reconciliation

```bash
af reconcile --date 2026-10-19 --timezone America/Los_Angeles --json --envelope
af reconcile --calendar "Personal" --tomorrow --timezone America/Los_Angeles --json --envelope
af reconcile --from 2026-10-19 --to 2026-10-23 --timezone America/Los_Angeles --google-cmd /path/to/helper --json --envelope
```

Reconciliation compares fresh Akiflow events/calendars, fresh Google events, and an existing pinned local cache snapshot. It does not synthesize Akiflow recurrence presence, refresh, initialize, migrate, or repair cache and does not submit event writes. Only observed records establish server/cache presence. Its read-only Akiflow client refuses a 401 without token-refresh writes; authenticate separately if necessary.

Exactly one day-selector family is allowed. Today is default; ranges require both endpoints, include the entire `--to` day, and are limited to 31 local calendar days. Timezone precedence is explicit `--timezone` > profile `timezone` > host. All-day events participate in presence comparisons. Date windows are half-open UTC bounds derived from selected local days.

Without `--calendar`, the private fork compares `dichlorodiphen@gmail.com` and `david.young@databricks.com`. Explicit calendar selection replaces both defaults and resolves against fresh Akiflow metadata by ID, Google origin ID, or unique title. An explicitly selected hidden calendar is auditable; deleted calendars are excluded.

Google helper precedence is `--google-cmd`, `HATCH_GWS_CLI`, then `hatch_gws_cli` on PATH. An override is one executable name/path, not a shell command. The helper must support:

```text
<executable> calendar events list --params <one JSON argument>
<executable> calendar events get --params <one JSON argument>
```

It must return native Google API JSON (`calendar#events`, `items`, and optional `nextPageToken` for lists), not flattened/human output. Pagination and identity GETs are required; each invocation has a 30-second bound. The CLI invokes read methods, but a helper may perform its own hidden OAuth/token writes. Before describing a live run as strictly read-only, establish the helper's actual behavior and authorization; do not assume the adapter's read-only intent proves that.

Parse `result.complete`, source coverage, structured diagnostics, and tiers before reporting findings:

- Google missing from Akiflow: distinguish server/cache/both gaps, unconnected calendars, and excluded counterparts.
- Fresh Akiflow missing/cancelled on Google: explicit identity-not-found and cancellation evidence differ from merely not observed in the window.
- Duplicates/overlaps: calendar-scoped identity collisions, strict same-title overlaps, and neutral different-title overlaps.
- Possible reshape leftovers: similar unequal titles with overlap or proximity; these are suspicions for review.

Matching prefers provider identity, then series/original anchor, then mutually unique title/time matches. Ambiguous matches and exclusions remain evidence. An unavailable cache cannot establish a cache gap. A 404/410 is identity-not-found evidence, not proof of who deleted an event.

Complete reports exit 0 even with findings. Usage/window/helper errors exit 2, explicit auth failures 3, and upstream/timeout/malformed/incomplete results 5. Source failures produce `complete: false`, errors and `tiers: null`; never present these as “no discrepancies.” These reads are fresh but not an atomic provider snapshot. Reconciliation v1 does not audit task/slot/reminder state, recurrence definitions, descriptions, or capacity, and performs no repair.

## Flight-dependent events

For the existing Southwest recheck workflow, use Chrome on `https://www.southwest.com/air/flight-status/path?departureDate=YYYY-MM-DD&flightNumber=N`, read the rendered flight status, then apply authorized dependent Akiflow event changes with `af event update`.
