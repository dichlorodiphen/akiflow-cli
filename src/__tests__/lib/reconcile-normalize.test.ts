import { expect, test } from "bun:test";
import {
	normalizeAkiflow,
	normalizeGoogle,
	parseCompositeId,
	partitionRecords,
	selectCalendars,
} from "../../lib/reconcile/normalize";
import {
	af,
	calendar,
	ge,
	normalizedA,
	normalizedG,
	now,
	observation,
	selected,
	window,
	workCalendar,
} from "./reconcile-fixtures";

test("inclusive_akiflow_all_day_end_equals_exclusive_google_end", () => {
	const a = normalizedA([
		af("a", {
			start_time: null,
			end_time: null,
			start_date: "2026-09-30",
			end_date: "2026-10-01",
		}),
	])[0];
	const g = normalizedG([
		ge("g1", { start: { date: "2026-09-30" }, end: { date: "2026-10-02" } }),
	])[0];
	expect(a?.time).toEqual(g?.time);
	expect(a?.in_window).toBe(true);
	expect(a?.source_time.end_date).toBe("2026-10-01");
	expect(g?.source_time.end_date).toBe("2026-10-02");
});
test("all-day intersection uses calendar timezone, not implicit UTC midnight", () => {
	expect(
		normalizedG([
			ge("g", { start: { date: "2026-10-01" }, end: { date: "2026-10-02" } }),
		])[0]?.in_window,
	).toBe(false);
});
test("read_only_guest_is_retained", () => {
	const record = normalizedA([af("guest", { read_only: true })])[0];
	expect(record?.state).toBe("active");
	expect(record?.read_only).toBe(true);
});
test("hidden_master_visibility_matches_cal", () => {
	const master = af("master", {
		recurring_id: "master",
		recurrence: ["RRULE:FREQ=DAILY"],
		hidden: true,
	});
	expect(normalizedA([master])[0]?.state).toBe("active");
	const covered = normalizedA([
		master,
		af("instance", { recurring_id: "master" }),
	]);
	expect(covered[0]?.state).toBe("hidden");
	expect(covered[1]?.state).toBe("active");
	const ordinaryHidden = normalizedA([af("hidden", { hidden: true })]);
	expect(ordinaryHidden[0]?.state).toBe("hidden");
});
test("explicit hidden calendar is auditable and deleted calendars excluded", () => {
	const hidden = { ...calendar, hidden_at: now.toISOString() };
	expect(
		normalizeAkiflow([af()], [hidden], window, selected, "server", null)[0]
			?.exclusion_reason,
	).toBe("hidden_calendar");
	expect(
		normalizeAkiflow(
			[af()],
			[hidden],
			window,
			selected,
			"server",
			null,
			true,
		)[0]?.state,
	).toBe("active");
	expect(
		normalizeAkiflow(
			[af()],
			[{ ...calendar, deleted_at: now.toISOString() }],
			window,
			selected,
			"server",
			null,
			true,
		)[0]?.exclusion_reason,
	).toBe("deleted_calendar");
});
test("calendar mappings preserve provider IDs and account provenance", () => {
	const record = normalizedA([af()])[0];
	expect(record?.calendar).toMatchObject({
		key: calendar.origin_id,
		source_id: calendar.id,
		akiflow_id: calendar.id,
		google_id: calendar.origin_id,
		account_id: "account",
	});
	expect(selectCalendars([calendar, workCalendar])).toEqual(selected);
	for (const input of [calendar.id, calendar.origin_id, "Personal", "Pers"])
		expect(selectCalendars([calendar, workCalendar], input)).toEqual([
			calendar.origin_id,
		]);
	expect(() =>
		selectCalendars(
			[calendar, { ...workCalendar, title: "Personal" }],
			"Personal",
		),
	).toThrow("ambiguous");
	expect(() =>
		selectCalendars(
			[{ ...calendar, deleted_at: now.toISOString() }],
			"Personal",
		),
	).toThrow();
});
test("cancelled_record_without_times_is_preserved", () => {
	const record = normalizedG([{ id: "cancelled", status: "cancelled" }])[0];
	expect(record).toMatchObject({
		title: null,
		time: { kind: "unknown" },
		state: "cancelled",
		in_window: null,
	});
	expect(partitionRecords(record ? [record] : []).cancellations).toHaveLength(
		1,
	);
});
test("workingLocation is excluded while appointment event types remain active", () => {
	for (const eventType of [
		"focusTime",
		"outOfOffice",
		"fromGmail",
		"default",
		"birthday",
	])
		expect(normalizedG([ge("g", { eventType })])[0]?.state).toBe("active");
	expect(
		normalizedG([ge("g", { eventType: "workingLocation" })])[0]
			?.exclusion_reason,
	).toBe("working_location");
});
test("declines and recurrence-delete exceptions leave active inventory", () => {
	expect(
		normalizedG([
			ge("g", { attendees: [{ self: true, responseStatus: "declined" }] }),
		])[0]?.state,
	).toBe("declined");
	expect(
		normalizedA([
			af("a", { recurrence_exception_delete: now.toISOString() }),
		])[0]?.state,
	).toBe("cancelled");
});
test("composite parsing requires evidence and preserves original opaque ID", () => {
	expect(parseCompositeId("base_20261001T023000Z", false)).toBeNull();
	expect(parseCompositeId("base_20261001T023000Z", true)).toEqual({
		base: "base",
		anchor: "2026-10-01T02:30:00.000Z",
	});
	expect(parseCompositeId("base_20260230T023000Z", true)).toBeNull();
	expect(parseCompositeId("base_20261001T293000Z", true)).toBeNull();
	const record = normalizedA([
		af("a", { origin_id: "base_20261001T023000Z", recurring_id: "master" }),
	])[0];
	expect(record?.identity.origin_id).toBe("base_20261001T023000Z");
	expect(record?.identity.series_id).toBe("base");
});
test("fresh master resolves series identity without expanding its rule", () => {
	const master = af("master", {
		origin_id: "series",
		recurring_id: "master",
		recurrence: ["RRULE:FREQ=DAILY"],
	});
	const records = normalizedA([
		master,
		af("instance", {
			origin_id: null,
			recurring_id: "master",
			original_start_time: "2026-10-01T02:30:00Z",
		}),
	]);
	expect(records).toHaveLength(2);
	expect(records[1]?.identity.series_id).toBe("series");
});
test("malformed live times fail, sparse cancellations are valid", () => {
	expect(() => normalizedA([af("a", { start_time: null })])).toThrow(
		"no valid time",
	);
	expect(() =>
		normalizedG([ge("g", { start: { dateTime: "broken" } })]),
	).toThrow("Invalid provider instant");
	expect(() =>
		normalizedG([ge("g", { end: { dateTime: "2026-10-01T01:00:00Z" } })]),
	).toThrow("interval");
	expect(() =>
		normalizeGoogle(
			[observation([{ id: "g", status: "cancelled" }])],
			[calendar],
			window,
		),
	).not.toThrow();
});

test("sparse Akiflow tombstone preserves unknown calendar and time evidence", () => {
	const record = normalizedA([
		{ id: "tombstone", deleted_at: now.toISOString() } as ReturnType<typeof af>,
	])[0];
	expect(record).toMatchObject({
		state: "deleted",
		title: null,
		time: { kind: "unknown" },
		calendar: { key: null, source_id: "", akiflow_id: null },
	});
});
test("invalid civil date in provider timestamp and invalid status fail", () => {
	expect(() =>
		normalizedG([ge("bad", { start: { dateTime: "2026-02-30T10:00:00Z" } })]),
	).toThrow();
	expect(() => normalizedG([ge("bad", { status: "broken" })])).toThrow(
		"status",
	);
});

test("both providers use the canonical Google calendar timezone for all-day intersection", async () => {
	const { alignCalendarTimezones } = await import(
		"../../lib/reconcile/normalize"
	);
	const events = [
		af("a", {
			start_time: null,
			end_time: null,
			start_date: "2026-10-01",
			end_date: "2026-10-01",
		}),
	];
	const initially = normalizedA(events, "server", [
		{ ...calendar, timezone: "UTC" },
	]);
	expect(initially[0]?.in_window).toBe(true);
	const observations = [
		observation([
			ge("g1", { start: { date: "2026-10-01" }, end: { date: "2026-10-02" } }),
		]),
	];
	const aligned = alignCalendarTimezones(initially, observations, window);
	expect(aligned[0]?.in_window).toBe(false);
	expect(aligned[0]?.calendar.timezone).toBe("America/Los_Angeles");
	expect(aligned[0]?.source_time.calendar_timezone).toBe("UTC");
});
