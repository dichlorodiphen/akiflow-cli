import { expect, test } from "bun:test";
import { type RRuleSet, rrulestr } from "rrule";
import { resolveCalendarFromList } from "../../lib/calendar";
import { parseDuration } from "../../lib/duration-parser";
import { filterTasks } from "../../lib/filters/task";
import { normalizeEvent, queryOccurrences } from "../../lib/occurrence";
import { occurrenceRange } from "../../lib/occurrence-read";
import {
	previewOccurrences,
	truncateSeriesUntil,
	validateRRule,
} from "../../lib/recurrence";
import { addCalendarDays } from "../../lib/timezone";
import { event, task } from "./occurrence-fixtures";
import { af, ge, normalizedA, report } from "./reconcile-fixtures";

test("default calendar visibility retains calendarless tasks but explicit calendar scope excludes them", () => {
	const input = {
		events: [
			event({ calendar_id: "deleted" }),
			event({ id: "unscoped-event", calendar_id: null as unknown as string }),
		],
		tasks: [task({ calendar_id: null })],
	};
	const scope = { activeCalendarIds: ["cal"], calendarIds: ["cal"] };
	expect(queryOccurrences(input, scope).map((o) => o.source)).toEqual(["task"]);
	expect(queryOccurrences(input, { ...scope, calendarId: "cal" })).toEqual([]);
});

test("cal date window is host independent across both DST transitions", () => {
	const spring = occurrenceRange({
		date: "2026-03-08",
		timezone: "America/Los_Angeles",
	});
	expect(spring.from.toISOString()).toBe("2026-03-08T08:00:00.000Z");
	expect(spring.to.toISOString()).toBe("2026-03-09T07:00:00.000Z");
	const fall = occurrenceRange({
		date: "2026-11-01",
		timezone: "America/Los_Angeles",
	});
	expect(fall.to.getTime() - fall.from.getTime()).toBe(25 * 3600000);
	const today = occurrenceRange(
		{ timezone: "Pacific/Kiritimati" },
		new Date("2026-06-20T22:00:00Z"),
	);
	expect(today.from.toISOString()).toBe("2026-06-20T10:00:00.000Z");
	expect(() =>
		occurrenceRange({ from: "2026-06-21", to: "2026-06-20" }),
	).toThrow("end must be after");
});

test("all-day occurrences use selected timezone and retain inclusive provider day", () => {
	const o = normalizeEvent(
		event({
			start_time: null,
			end_time: null,
			start_date: "2026-03-08",
			end_date: "2026-03-08",
		}),
		"America/Los_Angeles",
	)!;
	expect(o.start.toISOString()).toBe("2026-03-08T08:00:00.000Z");
	expect(o.end!.toISOString()).toBe("2026-03-09T07:00:00.000Z");
});

test("recurrence truncation remains parseable, retains exclusions, and removes later explicit dates", () => {
	const result = truncateSeriesUntil(
		[
			"RRULE:FREQ=DAILY",
			"EXDATE:20260620T090000Z",
			"RDATE:20260621T090000Z,20260801T090000Z",
		],
		new Date("2026-07-01T00:00:00Z"),
	);
	const set = rrulestr(result.join("\n"), { forceset: true }) as RRuleSet;
	expect(set.exdates().map((d) => d.toISOString())).toEqual([
		"2026-06-20T09:00:00.000Z",
	]);
	expect(set.rdates().map((d) => d.toISOString())).toEqual([
		"2026-06-21T09:00:00.000Z",
	]);
	expect(set.rrules()[0]!.origOptions.until!.toISOString()).toBe(
		"2026-07-01T00:00:00.000Z",
	);
});

test("recurrence preview preserves owner wall time across DST", () => {
	const preview = previewOccurrences(
		"FREQ=DAILY;COUNT=3",
		new Date("2026-03-07T17:00:00Z"),
		"America/Los_Angeles",
		3,
	);
	expect(preview.occurrences[1]).toContain("2026-03-08 09:00");
	expect(preview.occurrences[1]).toContain("2026-03-08T16:00:00.000Z");
	for (const rule of [
		"FREQ=DAILY;INTERVAL=0",
		"FREQ=DAILY;INTERVAL=-1",
		"FREQ=DAILY;BYHOUR=99",
		"DTSTART:20260620T090000Z\nRRULE:FREQ=DAILY",
	])
		expect(() => validateRRule(rule)).toThrow("Invalid RRULE");
});

test("reconciliation suppresses a moved or deleted anchor master using original-slot evidence", () => {
	const master = af("master", {
		hidden: true,
		recurring_id: "master",
		recurrence: ["RRULE:FREQ=DAILY"],
	});
	for (const deleted of [false, true]) {
		const moved = af("moved", {
			recurring_id: "master",
			original_start_time: master.start_time,
			recurrence_exception: true,
			start_time: "2026-10-02T16:00:00Z",
			end_time: "2026-10-02T17:00:00Z",
			deleted_at: deleted ? "now" : null,
		});
		expect(
			normalizedA([master, moved]).find((o) => o.id === "master")!.state,
		).toBe("hidden");
	}
});

test("ambiguous provider calendar IDs are rejected rather than choosing an account", () => {
	const calendars = [
		{ id: "a", origin_id: "same", title: "A" },
		{ id: "b", origin_id: "same", title: "B" },
	];
	expect(() => resolveCalendarFromList(calendars as never, "same")).toThrow(
		"ambiguous",
	);
	expect(resolveCalendarFromList(calendars as never, "b").id).toBe("b");
});

test("duration overflow and timestamp filters do not silently change queries", () => {
	expect(() => parseDuration("99999999999999999999999w")).toThrow("too large");
	const tasks = [
		task({ datetime: "2026-06-20T09:00:00Z" }),
		task({ id: "later", datetime: "2026-06-20T11:00:00Z" }),
	];
	expect(
		filterTasks(tasks, {
			from: new Date("2026-06-20T10:00:00Z"),
			to: new Date("2026-06-20T12:00:00Z"),
		}).map((t) => t.id),
	).toEqual(["later"]);
});

test("reconcile cannot infer server/cache presence from a self-ID recurrence master", () => {
	const master = af("master", {
		hidden: true,
		recurring_id: "master",
		origin_id: "series",
		recurrence: ["RRULE:FREQ=DAILY"],
		start_time: "2026-09-30T02:30:00Z",
		end_time: "2026-09-30T04:30:00Z",
	});
	const result = report(
		[master],
		[
			ge("series_20261001T023000Z", {
				recurringEventId: "series",
				originalStartTime: { dateTime: "2026-10-01T02:30:00Z" },
			}),
		],
		[master],
	);
	expect(result.tiers?.google_missing[0]).toMatchObject({
		server_presence: "absent",
		cache_presence: "absent",
		reason: "both_gap",
	});
	expect(result.records.some((r) => r.id.startsWith("virtual:"))).toBe(false);
});

test("recurrence expansion exposes capped coverage and honors TZID exclusions including the anchor", () => {
	const master = event({
		id: "m",
		recurring_id: "m",
		hidden: true,
		start_time: "2026-09-29T00:45:00Z",
		end_time: "2026-09-29T01:15:00Z",
		start_datetime_tz: "America/Los_Angeles",
		recurrence: [
			"RRULE:FREQ=DAILY;COUNT=3",
			"EXDATE;TZID=America/Los_Angeles:20260928T174500,20260929T174500",
		],
	});
	const dates = queryOccurrences(
		{ events: [master] },
		{ from: new Date("2026-09-28"), to: new Date("2026-10-02") },
	).map((o) => o.start.toISOString());
	expect(dates).toEqual(["2026-10-01T00:45:00.000Z"]);
	const recurrenceWarnings: string[] = [];
	queryOccurrences(
		{ events: [{ ...master, recurrence: ["RRULE:FREQ=SECONDLY"] }] },
		{
			from: new Date("2030-01-01"),
			to: new Date("2030-01-02"),
			recurrenceWarnings,
		},
	);
	expect(recurrenceWarnings[0]).toContain("safety limit");
});

test("calendar-day arithmetic preserves sub-minute time across DST", () => {
	expect(
		addCalendarDays("2026-03-07T17:00:42.123Z", 1, "America/Los_Angeles"),
	).toBe("2026-03-08T16:00:42.123Z");
	expect(queryOccurrences({ tasks: [task({ duration: Infinity })] })).toEqual(
		[],
	);
});

test("truncating a COUNT series preserves its finite bound across DST without COUNT/UNTIL conflict", () => {
	expect(() =>
		truncateSeriesUntil(
			["RRULE:FREQ=DAILY;COUNT=3"],
			new Date("2026-04-01T00:00:00Z"),
		),
	).toThrow("without its start time");
	const [rule] = truncateSeriesUntil(
		["RRULE:FREQ=DAILY;COUNT=3"],
		new Date("2026-04-01T00:00:00Z"),
		new Date("2026-03-07T17:00:00Z"),
		"America/Los_Angeles",
	);
	expect(rule).not.toContain("COUNT=");
	expect(rule).toContain("UNTIL=20260309T160000Z");
	const [earlier] = truncateSeriesUntil(
		["RRULE:FREQ=DAILY;COUNT=3"],
		new Date("2026-03-08T16:00:00Z"),
		new Date("2026-03-07T17:00:00Z"),
		"America/Los_Angeles",
	);
	expect(earlier).toContain("UNTIL=20260308T160000Z");
});

test("open-ended calendar selectors retain a valid exclusive year-10000 sentinel", () => {
	const range = occurrenceRange({
		from: "2026-06-20",
		timezone: "America/Los_Angeles",
	});
	expect(range.from.toISOString()).toBe("2026-06-20T07:00:00.000Z");
	expect(range.to.toISOString()).toBe("+010000-01-01T08:00:00.000Z");
	const toOnly = occurrenceRange({
		to: "2026-06-20",
		timezone: "America/Los_Angeles",
	});
	expect(toOnly.to.toISOString()).toBe("2026-06-21T07:00:00.000Z");
});
