import { expect, test } from "bun:test";
import type { Event } from "../../lib/api/types";
import { buildReconcileReport } from "../../lib/reconcile/diff";
import {
	normalizeAkiflow,
	normalizeGoogle,
} from "../../lib/reconcile/normalize";
import type { ReconcileWindow } from "../../lib/reconcile/types";
import { resolveReconcileWindow } from "../../lib/reconcile/window";
import { expandRecurringEvents } from "../../lib/recurrence-expansion";
import { formatInTimezone } from "../../lib/timezone";
import {
	af,
	calendar,
	ge,
	now,
	observation,
	selected,
	sources,
	window,
	workCalendar,
} from "./reconcile-fixtures";

function master(overrides: Partial<Event> = {}) {
	return af("master", {
		origin_id: "series",
		recurring_id: "master",
		recurrence: ["RRULE:FREQ=DAILY"],
		start_time: "2026-09-30T02:30:00Z",
		end_time: "2026-09-30T04:30:00Z",
		start_datetime_tz: "America/Los_Angeles",
		...overrides,
	});
}
const slot = "2026-10-01T02:30:00.000Z";
const virtualId = `virtual:recurrence:master:${slot}`;
function instance(anchor = slot, series = "series") {
	return ge(`instance-${series}-${anchor}`, {
		recurringEventId: series,
		originalStartTime: { dateTime: anchor, timeZone: calendar.timezone },
		start: { dateTime: anchor, timeZone: calendar.timezone },
		end: { dateTime: new Date(Date.parse(anchor) + 7_200_000).toISOString() },
	});
}
function normalize(
	events: Event[],
	range = window,
	cache = false,
	fresh = events,
) {
	return normalizeAkiflow(
		events,
		[calendar, workCalendar],
		range,
		selected,
		cache ? "cache" : "server",
		now.toISOString(),
		false,
		fresh,
	);
}
function compare(
	events: Event[],
	google = [instance()],
	range: ReconcileWindow = window,
) {
	return buildReconcileReport({
		records: [
			...normalize(events, range),
			...normalize(events, range, true),
			...normalizeGoogle(
				[observation(google)],
				[calendar, workCalendar],
				range,
			),
		],
		window: range,
		selected,
		now,
		sources: sources(),
	});
}

test("virtual occurrence matches Google through occurrence_anchor on server and cache", () => {
	const events = [master({ read_only: true })];
	const before = JSON.stringify(events);
	const result = compare(events);
	expect(result.tiers?.google_missing).toHaveLength(0);
	expect(result.matches).toContainEqual(
		expect.objectContaining({
			akiflow_id: virtualId,
			method: "occurrence_anchor",
			confidence: "confirmed",
			calendar: calendar.origin_id,
			differences: [],
		}),
	);
	expect(
		normalize(events).find((record) => record.id === virtualId),
	).toMatchObject({
		state: "active",
		in_window: true,
		read_only: true,
		is_series_master: false,
		calendar: {
			key: calendar.origin_id,
			akiflow_id: calendar.id,
			account_id: "account",
		},
		identity: {
			series_id: "series",
			anchor: slot,
			anchor_kind: "instant",
			provisional_anchor: false,
		},
	});
	expect(
		result.records
			.filter((record) => record.id === virtualId)
			.map((record) => record.observation)
			.sort(),
	).toEqual(["cache", "server"]);
	expect(JSON.stringify(events)).toBe(before);
});

test.each([
	[slot, "unknown-series"],
	["2026-10-01T03:00:00Z", "series"],
])("nonmatching anchor %s / series %s remains google_missing", (anchor, series) => {
	const result = compare([master()], [instance(anchor, series)]);
	expect(result.tiers?.google_missing).toHaveLength(1);
	expect(result.tiers?.google_missing[0]?.reason).toBe("both_gap");
	expect(result.matches).toHaveLength(0);
});

test.each([
	["materialized", {}],
	[
		"moved",
		{ start_time: "2026-10-01T05:00:00Z", end_time: "2026-10-01T06:00:00Z" },
	],
	["cancelled", { status: "cancelled" }],
	["deleted", { deleted_at: now.toISOString() }],
	["hidden", { hidden: true }],
	["exception-delete", { recurrence_exception_delete: now.toISOString() }],
] satisfies [
	string,
	Partial<Event>,
][])("%s exception suppresses virtual slot on both observations", (_, overrides) => {
	const events = [
		master(),
		af("exception", {
			origin_id: "materialized",
			recurring_id: "master",
			original_start_time: slot,
			recurrence_exception: true,
			...overrides,
		}),
	];
	const result = compare(events);
	expect(result.records.some((record) => record.id === virtualId)).toBe(false);
	expect(
		result.matches.some((match) => match.akiflow_id.startsWith("virtual:")),
	).toBe(false);
	// The materialized evidence, including a moved or cancelled exception,
	// can still pair by its original anchor.
	expect(result.matches).toContainEqual(
		expect.objectContaining({
			akiflow_id: "exception",
			method: "occurrence_anchor",
		}),
	);
});

test("daily virtuals preserve 17:45 Los Angeles time across fall-back", () => {
	const range = resolveReconcileWindow(
		{ from: "2026-10-30", to: "2026-11-03" },
		now,
		calendar.timezone,
	);
	const events = [
		master({
			start_time: "2026-10-30T00:45:00Z",
			end_time: "2026-10-30T02:45:00Z",
		}),
	];
	const virtuals = normalize(events, range).filter((record) =>
		record.id.startsWith("virtual:"),
	);
	expect(virtuals.map((record) => record.identity.anchor)).toEqual([
		"2026-10-31T00:45:00.000Z",
		"2026-11-01T00:45:00.000Z",
		"2026-11-02T01:45:00.000Z",
		"2026-11-03T01:45:00.000Z",
		"2026-11-04T01:45:00.000Z",
	]);
	for (const record of virtuals) {
		expect(
			formatInTimezone(record.identity.anchor ?? "", calendar.timezone),
		).toMatchObject({ hours: 17, minutes: 45 });
	}
	const shifted = instance("2026-11-02T01:45:00Z");
	const unshifted = instance("2026-11-02T00:45:00Z");
	const result = compare(events, [shifted, unshifted], range);
	expect(result.matches).toContainEqual(
		expect.objectContaining({
			google_id: shifted.id,
			method: "occurrence_anchor",
		}),
	);
	expect(result.matches.some((match) => match.google_id === unshifted.id)).toBe(
		false,
	);
	expect(result.tiers?.google_missing).toHaveLength(1);
});

test("visible series anchor is retained once and expanded input is idempotent", () => {
	const events = [
		master({ start_time: slot, end_time: "2026-10-01T04:30:00Z" }),
	];
	expect(normalize(events)).toHaveLength(1);
	const raw = [master()];
	const expanded = [
		...raw,
		...expandRecurringEvents(raw, new Date(window.start), new Date(window.end)),
	];
	expect(normalize(expanded)).toEqual(normalize(raw));
	const syntheticMaster = master({
		id: "virtual:master",
		recurring_id: "virtual:master",
	});
	expect(normalize([syntheticMaster])).toHaveLength(1);
});

test.each([
	{ status: "cancelled" },
	{ deleted_at: now.toISOString() },
	{ recurrence_exception_delete: now.toISOString() },
	{ recurrence: ["RRULE:INVALID"] },
	{ start_datetime_tz: "invalid-zone" },
	{ recurrence: ["RRULE:FREQ=DAILY", "EXRULE:FREQ=WEEKLY"] },
] satisfies Partial<Event>[])("nonexpandable master %j stays raw, including evidence calls", (overrides) => {
	const events = [master(overrides)];
	expect(normalize(events)).toHaveLength(1);
	expect(normalize(events, window, true, [master()])).toHaveLength(1);
});

test("hidden masters still expand future slots; unselected calendars remain excluded", () => {
	expect(
		normalize([master({ hidden: true })]).find(
			(record) => record.id === virtualId,
		)?.state,
	).toBe("active");
	const records = normalizeAkiflow(
		[master({ calendar_id: workCalendar.id })],
		[calendar, workCalendar],
		window,
		[calendar.origin_id],
		"server",
		now.toISOString(),
	);
	expect(records.find((record) => record.id === virtualId)).toMatchObject({
		state: "excluded",
		exclusion_reason: "unselected_calendar",
		calendar: { key: workCalendar.origin_id },
	});
});
