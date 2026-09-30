// Revert checks: each exported normalizer and query was individually replaced
// with a null/empty implementation; this file failed for every replacement.
// The library was backed up outside git and restored after each check (untracked).
import { describe, expect, test } from "bun:test";
import {
	normalizeEvent,
	normalizeSlot,
	normalizeTask,
	queryOccurrences,
} from "../../lib/occurrence";
import { event, instant, slot, task } from "./occurrence-fixtures";

const window = { from: instant(8), to: instant(11) };
describe("occurrence normalization", () => {
	test("timed events, slots and tasks preserve source, identity, links and provenance", () => {
		const e = normalizeEvent(
			event({
				task_id: "t",
				time_slot_id: "s",
				origin_id: "provider",
				recurring_id: "series",
				origin_recurring_id: "provider-series",
				original_start_time: instant(8).toISOString(),
				original_start_date: "2026-06-19",
				recurrence_exception: true,
			}),
		)!;
		expect(e.start).toEqual(instant(9));
		expect(e.end).toEqual(instant(10));
		expect(e.source).toBe("event");
		expect(e.linkage).toEqual({ taskId: "t", timeSlotId: "s" });
		expect(e.provenance.origin_id).toBe("provider");
		expect(e.recurrence).toEqual({
			recurring_id: "series",
			origin_recurring_id: "provider-series",
			original_start_time: instant(8),
			original_start_date: "2026-06-19",
			recurrence_exception: true,
		});
		const s = normalizeSlot(
			slot({ original_start_time: instant(7).toISOString() }),
		)!;
		expect(s.source).toBe("slot");
		expect(s.start).toEqual(instant(9));
		expect(s.end).toEqual(instant(10));
		expect(s.recurrence.original_start_time).toEqual(instant(7));
		const t = normalizeTask(
			task({ done: true, trashed_at: "now", time_slot_id: "s" }),
		)!;
		expect(t.source).toBe("task");
		expect(t.start).toEqual(instant(9));
		expect(t.end).toEqual(instant(10));
		expect(t.done).toBe(true);
		expect(t.trashed).toBe(true);
		expect(t.linkage.timeSlotId).toBe("s");
	});
	test("all-day inclusive end dates become multi-day half-open local intervals", () => {
		const e = normalizeEvent(
			event({ start_date: "2026-06-20", end_date: "2026-06-22" }),
		)!;
		expect(e.allDay).toBe(true);
		expect(e.start).toEqual(new Date(2026, 5, 20));
		expect(e.end).toEqual(new Date(2026, 5, 23));
		expect(normalizeEvent(event({ start_date: "2026-06-20" }))!.end).toEqual(
			new Date(2026, 5, 21),
		);
		const dst = normalizeEvent(
			event({ start_date: "2026-03-08", end_date: "2026-03-08" }),
		)!;
		expect(dst.end).toEqual(new Date(2026, 2, 9));
	});
	test("null/zero task duration is a point; missing datetime is excluded", () => {
		for (const duration of [null, 0])
			expect(normalizeTask(task({ duration }))!.end).toBeNull();
		expect(normalizeTask(task({ datetime: null }))).toBeNull();
		expect(queryOccurrences({ tasks: [task({ datetime: null })] })).toEqual([]);
	});
	test("malformed timestamps and inverted spans are rejected", () => {
		expect(normalizeEvent(event())).not.toBeNull();
		expect(normalizeSlot(slot())).not.toBeNull();
		expect(normalizeTask(task())).not.toBeNull();
		expect(normalizeEvent(event({ start_time: "invalid" }))).toBeNull();
		expect(normalizeEvent(event({ start_date: "2026-02-30" }))).toBeNull();
		expect(
			normalizeSlot(slot({ end_time: instant(8).toISOString() })),
		).toBeNull();
		expect(normalizeTask(task({ datetime: "invalid" }))).toBeNull();
	});
});
describe("queryOccurrences", () => {
	test("overnight intervals intersect both adjacent days for every source", () => {
		const start = "2026-06-20T22:00:00Z";
		const end = "2026-06-21T02:00:00Z";
		const input = {
			events: [event({ start_time: start, end_time: end })],
			slots: [slot({ start_time: start, end_time: end })],
			tasks: [task({ datetime: start, duration: 14400 })],
		};
		for (const day of [20, 21])
			expect(
				queryOccurrences(input, {
					from: instant(0 + (day - 20) * 24),
					to: instant(24 + (day - 20) * 24),
				}),
			).toHaveLength(3);
	});
	test("half-open boundaries exclude touching intervals and include points only within window", () => {
		const input = {
			events: [
				event({
					end_time: instant(8).toISOString(),
					start_time: instant(7).toISOString(),
				}),
				event({
					id: "late",
					start_time: instant(11).toISOString(),
					end_time: instant(12).toISOString(),
				}),
			],
			tasks: [
				task({
					id: "left",
					datetime: instant(8).toISOString(),
					duration: null,
				}),
				task({ id: "right", datetime: instant(11).toISOString(), duration: 0 }),
			],
		};
		expect(queryOccurrences(input, window).map((o) => o.id)).toEqual(["left"]);
		expect(
			queryOccurrences(input, { from: instant(9), to: instant(9) }),
		).toEqual([]);
	});
	test("cancelled/done/trashed/declined excluded by default and individually opt in", () => {
		const input = {
			events: [
				event({ id: "cancelled", status: "cancelled" }),
				event({ id: "declined", declined: true }),
			],
			tasks: [
				task({ id: "done", done: true }),
				task({ id: "trashed", trashed_at: "now" }),
			],
		};
		expect(queryOccurrences(input)).toEqual([]);
		for (const [flag, id] of [
			["includeCancelled", "cancelled"],
			["includeDeclined", "declined"],
			["includeDone", "done"],
			["includeTrashed", "trashed"],
		] as const)
			expect(
				queryOccurrences(input, { [flag]: true }).map((o) => o.id),
			).toEqual([id]);
		expect(
			queryOccurrences(input, {
				includeCancelled: true,
				includeDone: true,
				includeTrashed: true,
				includeDeclined: true,
			}),
		).toHaveLength(4);
	});
	test("account/connector/calendar filters apply uniformly to every source", () => {
		const input = { events: [event()], slots: [slot()], tasks: [task()] };
		for (const [key, value] of [
			["accountId", "account"],
			["connectorId", "google"],
			["calendarId", "cal"],
		] as const) {
			expect(queryOccurrences(input, { [key]: value })).toHaveLength(3);
			expect(queryOccurrences(input, { [key]: "different" })).toEqual([]);
		}
		expect(
			queryOccurrences(
				{ slots: [slot({ connector_id: null })] },
				{ connectorId: "google" },
			),
		).toEqual([]);
	});
	test("hidden masters show only when no visible nondeleted instance covers their slot", () => {
		const master = event({
			id: "series",
			recurring_id: "series",
			hidden: true,
		});
		const instance = event({ id: "instance", recurring_id: "series" });
		expect(queryOccurrences({ events: [master] }).map((o) => o.id)).toEqual([
			"series",
		]);
		expect(
			queryOccurrences({ events: [master, instance] }).map((o) => o.id),
		).toEqual(["instance"]);
		expect(
			queryOccurrences({
				events: [master, { ...instance, deleted_at: "now" }],
			}).map((o) => o.id),
		).toEqual(["series"]);
		expect(
			queryOccurrences({ events: [master, { ...instance, hidden: true }] }).map(
				(o) => o.id,
			),
		).toEqual(["series"]);
		expect(
			queryOccurrences({
				events: [
					master,
					{
						...instance,
						start_time: instant(11).toISOString(),
						end_time: instant(12).toISOString(),
					},
				],
			}),
		).toHaveLength(2);
		expect(queryOccurrences({ events: [event({ hidden: true })] })).toEqual([]);
	});
	test("all-day flags mirror event filters and deletion never leaks", () => {
		const input = {
			events: [event(), event({ id: "day", start_date: "2026-06-20" })],
			slots: [slot()],
			tasks: [task()],
		};
		expect(
			queryOccurrences(input, { allDayOnly: true }).map((o) => o.id),
		).toEqual(["day"]);
		expect(queryOccurrences(input, { excludeAllDay: true })).toHaveLength(3);
		expect(
			queryOccurrences({
				events: [event({ deleted_at: "now" })],
				slots: [slot({ deleted_at: "now" })],
				tasks: [task({ deleted_at: "now" })],
			}),
		).toEqual([]);
	});
});
