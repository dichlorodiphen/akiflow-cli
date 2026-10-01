import { describe, expect, test } from "bun:test";
import type { Event } from "../../lib/api/types";
import { filterEvents } from "../../lib/filters/event";
import { normalizeEvent, queryOccurrencesWithRaw } from "../../lib/occurrence";
import { expandRecurringEvents } from "../../lib/recurrence-expansion";
import { formatInTimezone } from "../../lib/timezone";
import { event } from "./occurrence-fixtures";

const from = new Date("2026-09-28T07:00:00Z");
const to = new Date("2026-10-05T07:00:00Z");
function master(overrides: Partial<Event> = {}): Event {
	return event({
		id: "d2fff2a5",
		recurring_id: "d2fff2a5",
		title: "Walk + feed corgi",
		description: "Evening walk",
		hidden: true,
		recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"],
		start_time: "2026-09-29T00:45:00.000Z",
		end_time: "2026-09-29T01:15:00.000Z",
		start_datetime_tz: "America/Los_Angeles",
		attendees: [{ email: "owner@example.com" }],
		...overrides,
	});
}
const read = (events: Event[], lower = from, upper = to) =>
	queryOccurrencesWithRaw({ events }, { from: lower, to: upper });
function instance(slot: string, overrides: Partial<Event> = {}): Event {
	return event({
		id: "instance",
		recurring_id: "d2fff2a5",
		original_start_time: slot,
		start_time: slot,
		end_time: new Date(new Date(slot).getTime() + 30 * 60_000).toISOString(),
		recurrence_exception: true,
		...overrides,
	});
}

describe("bounded recurring event reads", () => {
	test("corgi weekdays appear at 17:45, including exactly one anchor", () => {
		const records = [master()];
		const before = JSON.stringify(records);
		const pairs = read(records);
		expect(pairs).toHaveLength(5);
		expect(pairs.map((p) => p.occurrence.start.toISOString())).toEqual([
			"2026-09-29T00:45:00.000Z",
			"2026-09-30T00:45:00.000Z",
			"2026-10-01T00:45:00.000Z",
			"2026-10-02T00:45:00.000Z",
			"2026-10-03T00:45:00.000Z",
		]);
		expect(pairs[0]?.raw.id).toBe("d2fff2a5");
		for (const pair of pairs.slice(1)) {
			const raw = pair.raw as Event;
			expect(raw.id).toBe(`virtual:recurrence:d2fff2a5:${raw.start_time}`);
			expect(raw.recurrence).toBeNull();
			expect(raw.hidden).toBe(false);
			expect(raw.status).toBe("confirmed");
			expect(raw.original_start_time).toBe(raw.start_time);
			expect(raw.title).toBe("Walk + feed corgi");
			expect(raw.description).toBe("Evening walk");
			expect(raw.attendees).toEqual([{ email: "owner@example.com" }]);
			expect(filterEvents([raw], {})).toEqual([raw]);
			expect(normalizeEvent(raw)).toEqual(pair.occurrence);
			expect(
				pair.occurrence.end!.getTime() - pair.occurrence.start.getTime(),
			).toBe(1_800_000);
		}
		expect(JSON.stringify(records)).toBe(before);
	});

	test.each([
		["materialized", {}],
		["cancelled", { status: "cancelled" }],
		["deleted", { deleted_at: "2026-09-29T01:00:00Z" }],
		[
			"exception-delete",
			{ recurrence_exception_delete: "2026-09-29T01:00:00Z" },
		],
		["hidden", { hidden: true }],
	] as const)("%s instance suppresses its original slot", (_, overrides) => {
		const slot = "2026-09-30T00:45:00.000Z";
		const pairs = read([master(), instance(slot, overrides)]);
		expect(
			pairs.filter(
				(p) =>
					p.raw.id.startsWith("virtual:") &&
					(p.raw as Event).original_start_time === slot,
			),
		).toHaveLength(0);
		expect(pairs).toHaveLength(
			!("status" in overrides) &&
				!("deleted_at" in overrides) &&
				!("recurrence_exception_delete" in overrides) &&
				!("hidden" in overrides)
				? 5
				: 4,
		);
	});

	test("moved exception overlays its original slot, not its new start", () => {
		const pairs = read([
			master(),
			instance("2026-09-30T00:45:00Z", {
				start_time: "2026-09-30T02:00:00Z",
				end_time: "2026-09-30T02:30:00Z",
			}),
		]);
		expect(pairs).toHaveLength(5);
		expect(
			pairs.some(
				(p) => p.occurrence.start.toISOString() === "2026-09-30T00:45:00.000Z",
			),
		).toBe(false);
		expect(pairs.some((p) => p.raw.id === "instance")).toBe(true);
	});

	test.each([
		false,
		true,
	])("anchor covered (deleted=%s) still permits future expansion", (deleted) => {
		const pairs = read([
			master(),
			instance("2026-09-29T00:45:00Z", {
				deleted_at: deleted ? "now" : null,
			}),
		]);
		expect(pairs).toHaveLength(deleted ? 4 : 5);
		expect(pairs.some((p) => p.raw.id === "d2fff2a5")).toBe(false);
		expect(pairs.filter((p) => p.raw.id.startsWith("virtual:"))).toHaveLength(
			4,
		);
	});

	test("moved anchor is shown once, including when moved outside the window", () => {
		const pairs = read([
			master(),
			instance("2026-09-29T00:45:00Z", {
				start_time: "2026-10-10T02:00:00Z",
				end_time: "2026-10-10T02:30:00Z",
			}),
		]);
		expect(pairs).toHaveLength(4);
		expect(pairs.some((p) => p.raw.id === "d2fff2a5")).toBe(false);
	});

	test("daily 17:45 keeps local time across 2026 fall-back", () => {
		const pairs = read(
			[
				master({
					recurrence: ["RRULE:FREQ=DAILY"],
					start_time: "2026-10-30T00:45:00Z",
					end_time: "2026-10-30T01:15:00Z",
				}),
			],
			new Date("2026-10-30T07:00:00Z"),
			new Date("2026-11-04T08:00:00Z"),
		);
		expect(pairs.map((p) => p.occurrence.start.toISOString())).toEqual([
			"2026-10-31T00:45:00.000Z",
			"2026-11-01T00:45:00.000Z",
			"2026-11-02T01:45:00.000Z",
			"2026-11-03T01:45:00.000Z",
			"2026-11-04T01:45:00.000Z",
		]);
		for (const pair of pairs) {
			expect(
				formatInTimezone(
					pair.occurrence.start.toISOString(),
					"America/Los_Angeles",
				),
			).toMatchObject({ hours: 17, minutes: 45 });
		}
	});

	test("UTC EXDATE excludes a rule slot", () => {
		expect(
			read([
				master({
					recurrence: ["RRULE:FREQ=DAILY;COUNT=3", "EXDATE:20260930T004500Z"],
				}),
			]),
		).toHaveLength(2);
	});

	test("spring gaps are skipped and fall folds use the first instant", () => {
		const spring = read(
			[
				master({
					recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
					start_time: "2026-03-07T10:30:00Z",
					end_time: "2026-03-07T11:00:00Z",
				}),
			],
			new Date("2026-03-07T00:00:00Z"),
			new Date("2026-03-11T00:00:00Z"),
		);
		expect(spring.map((p) => p.occurrence.start.toISOString())).toEqual([
			"2026-03-07T10:30:00.000Z",
			"2026-03-09T09:30:00.000Z",
		]);
		const fall = read(
			[
				master({
					recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
					start_time: "2026-10-31T08:30:00Z",
					end_time: "2026-10-31T09:00:00Z",
				}),
			],
			new Date("2026-10-31T00:00:00Z"),
			new Date("2026-11-04T00:00:00Z"),
		);
		expect(fall.map((p) => p.occurrence.start.toISOString())).toEqual([
			"2026-10-31T08:30:00.000Z",
			"2026-11-01T08:30:00.000Z",
			"2026-11-02T09:30:00.000Z",
		]);
	});

	test("COUNT and UTC UNTIL remain inclusive", () => {
		expect(
			read([master({ recurrence: ["RRULE:FREQ=DAILY;COUNT=3"] })]),
		).toHaveLength(3);
		expect(
			read([
				master({ recurrence: ["RRULE:FREQ=DAILY;UNTIL=20260930T004500Z"] }),
			]),
		).toHaveLength(2);
	});

	test("all-day series preserves date span and overlays deleted dates", () => {
		const records = [
			master({
				recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
				start_time: null,
				end_time: null,
				start_date: "2026-09-29",
				end_date: "2026-09-30",
			}),
			instance("2026-09-30T00:00:00Z", {
				start_time: null,
				end_time: null,
				original_start_time: null,
				start_date: "2026-09-30",
				original_start_date: "2026-09-30",
				deleted_at: "now",
			}),
		];
		const pairs = read(records);
		expect(pairs).toHaveLength(2);
		expect(pairs.map((p) => (p.raw as Event).start_date)).toEqual([
			"2026-09-29",
			"2026-10-01",
		]);
		expect((pairs[1]?.raw as Event).end_date).toBe("2026-10-02");
		expect(pairs.every((p) => p.occurrence.allDay)).toBe(true);
	});

	test("query window includes a virtual that starts before it and overlaps", () => {
		const pairs = read(
			[master()],
			new Date("2026-09-30T01:00:00Z"),
			new Date("2026-09-30T02:00:00Z"),
		);
		expect(pairs).toHaveLength(1);
		expect(pairs[0]?.occurrence.start.toISOString()).toBe(
			"2026-09-30T00:45:00.000Z",
		);
	});

	test("identity, decline and exclusive upper-bound filters apply to virtuals", () => {
		expect(
			queryOccurrencesWithRaw(
				{ events: [master()] },
				{ from, to, calendarId: "other" },
			),
		).toEqual([]);
		expect(
			queryOccurrencesWithRaw(
				{ events: [master()] },
				{ from, to, activeCalendarIds: [] },
			),
		).toEqual([]);
		expect(read([master({ declined: true })])).toEqual([]);
		expect(
			read([master()], from, new Date("2026-09-30T00:45:00Z")),
		).toHaveLength(1);
	});

	test("unbounded daily horizon and dense occurrence cap terminate", () => {
		const daily = expandRecurringEvents([
			master({ recurrence: ["RRULE:FREQ=DAILY"] }),
		]);
		expect(daily).toHaveLength(366);
		const dense = expandRecurringEvents([
			master({ recurrence: ["RRULE:FREQ=MINUTELY"] }),
		]);
		expect(dense.length).toBeLessThanOrEqual(1000);
		expect(dense.length).toBeGreaterThan(0);
	});

	test("distant SECONDLY query bounds historical iteration work", () => {
		const future = new Date("2030-01-01T00:00:00Z");
		expect(
			expandRecurringEvents(
				[master({ recurrence: ["RRULE:FREQ=SECONDLY"] })],
				future,
				new Date("2030-01-02T00:00:00Z"),
			),
		).toEqual([]);
	});

	test("malformed rules, zones, deleted or cancelled masters do not synthesize", () => {
		for (const overrides of [
			{ recurrence: ["RRULE:INVALID"] },
			{ start_datetime_tz: "invalid-zone" },
			{ deleted_at: "now" },
			{ status: "cancelled" },
			{ recurrence: [] },
		] satisfies Partial<Event>[]) {
			expect(expandRecurringEvents([master(overrides)], from, to)).toEqual([]);
		}
	});
});
