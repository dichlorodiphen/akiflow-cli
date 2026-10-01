import { describe, expect, test } from "bun:test";
import type { Event } from "../../lib/api/types";
import {
	detectDuplicateEvents,
	detectPossibleReshapes,
	formatDuplicateWarnings,
	formatReshapeWarnings,
} from "../../lib/event-duplicates";

function event(overrides: Partial<Event> & { id: string }): Event {
	return {
		title: "Walk + feed Tidus",
		calendar_id: "cal-1",
		start_time: "2026-10-01T01:25:00.000Z",
		end_time: "2026-10-01T01:55:00.000Z",
		...overrides,
	} as Event;
}

describe("detectDuplicateEvents", () => {
	test("flags two identical same-calendar events", () => {
		const groups = detectDuplicateEvents([
			event({ id: "aaa" }),
			event({ id: "bbb" }),
		]);
		expect(groups).toHaveLength(1);
		const group = groups[0];
		expect(group).toBeDefined();
		expect(group?.event_ids.sort()).toEqual(["aaa", "bbb"]);
		expect(group?.title).toBe("Walk + feed Tidus");
	});

	test("flags overlapping (not just identical) times", () => {
		const groups = detectDuplicateEvents([
			event({ id: "aaa" }),
			event({
				id: "bbb",
				start_time: "2026-10-01T01:40:00.000Z",
				end_time: "2026-10-01T02:10:00.000Z",
			}),
		]);
		expect(groups).toHaveLength(1);
	});

	test("does not flag back-to-back blocks with the same title", () => {
		const groups = detectDuplicateEvents([
			event({ id: "aaa" }),
			event({
				id: "bbb",
				start_time: "2026-10-01T01:55:00.000Z",
				end_time: "2026-10-01T02:25:00.000Z",
			}),
		]);
		expect(groups).toHaveLength(0);
	});

	test("does not flag different titles or different calendars", () => {
		expect(
			detectDuplicateEvents([
				event({ id: "aaa" }),
				event({ id: "bbb", title: "Walk + feed corgi" }),
			]),
		).toHaveLength(0);
		expect(
			detectDuplicateEvents([
				event({ id: "aaa" }),
				event({ id: "bbb", calendar_id: "cal-2" }),
			]),
		).toHaveLength(0);
	});

	test("title matching is case- and whitespace-insensitive", () => {
		const groups = detectDuplicateEvents([
			event({ id: "aaa" }),
			event({ id: "bbb", title: "  walk + FEED tidus " }),
		]);
		expect(groups).toHaveLength(1);
	});

	test("same ID twice is a version fold, not a duplicate", () => {
		expect(
			detectDuplicateEvents([event({ id: "aaa" }), event({ id: "aaa" })]),
		).toHaveLength(0);
	});

	test("transitive overlap clusters into one group", () => {
		const groups = detectDuplicateEvents([
			event({
				id: "aaa",
				start_time: "2026-10-01T01:00:00.000Z",
				end_time: "2026-10-01T01:30:00.000Z",
			}),
			event({
				id: "bbb",
				start_time: "2026-10-01T01:20:00.000Z",
				end_time: "2026-10-01T01:50:00.000Z",
			}),
			event({
				id: "ccc",
				start_time: "2026-10-01T01:40:00.000Z",
				end_time: "2026-10-01T02:10:00.000Z",
			}),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.event_ids.sort()).toEqual(["aaa", "bbb", "ccc"]);
	});

	test("ignores all-day and untimed events", () => {
		expect(
			detectDuplicateEvents([
				event({ id: "aaa", start_time: undefined, end_time: undefined }),
				event({ id: "bbb", start_time: undefined, end_time: undefined }),
			]),
		).toHaveLength(0);
	});

	test("formatDuplicateWarnings renders ids and titles", () => {
		const groups = detectDuplicateEvents([
			event({ id: "dcd57e10-0000" }),
			event({ id: "e17726f7-0000" }),
		]);
		const warnings = formatDuplicateWarnings(groups);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Walk + feed Tidus");
		expect(warnings[0]).toContain("dcd57e10");
		expect(warnings[0]).toContain("e17726f7");
	});
});

describe("detectPossibleReshapes", () => {
	test("flags tonight's reshape pair: corgi 5:45-6:15, Tidus 6:25-6:55", () => {
		const groups = detectPossibleReshapes([
			event({
				id: "corgi-1",
				title: "Walk + feed corgi",
				start_time: "2026-10-01T00:45:00.000Z",
				end_time: "2026-10-01T01:15:00.000Z",
			}),
			event({ id: "tidus-1", title: "Walk + feed Tidus" }),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.kind).toBe("possible-reshape");
		expect(groups[0]?.event_ids.sort()).toEqual(["corgi-1", "tidus-1"]);
	});

	test("does not flag adjacent blocks with unrelated titles", () => {
		const groups = detectPossibleReshapes([
			event({ id: "tidus-1", title: "Walk + feed Tidus" }),
			event({
				id: "dinner-1",
				title: "Dinner",
				start_time: "2026-10-01T01:55:00.000Z",
				end_time: "2026-10-01T02:45:00.000Z",
			}),
		]);
		expect(groups).toHaveLength(0);
	});

	test("does not flag similar titles far apart", () => {
		const groups = detectPossibleReshapes([
			event({
				id: "corgi-1",
				title: "Walk + feed corgi",
				start_time: "2026-10-01T00:45:00.000Z",
				end_time: "2026-10-01T01:15:00.000Z",
			}),
			event({
				id: "tidus-1",
				title: "Walk + feed Tidus",
				start_time: "2026-10-01T05:25:00.000Z",
				end_time: "2026-10-01T05:55:00.000Z",
			}),
		]);
		expect(groups).toHaveLength(0);
	});

	test("does not flag identical titles (tier-1 territory)", () => {
		const groups = detectPossibleReshapes([
			event({ id: "aaa" }),
			event({
				id: "bbb",
				start_time: "2026-10-01T01:55:00.000Z",
				end_time: "2026-10-01T02:25:00.000Z",
			}),
		]);
		expect(groups).toHaveLength(0);
	});

	test("does not flag different calendars", () => {
		const groups = detectPossibleReshapes([
			event({
				id: "corgi-1",
				title: "Walk + feed corgi",
				start_time: "2026-10-01T00:45:00.000Z",
				end_time: "2026-10-01T01:15:00.000Z",
			}),
			event({ id: "tidus-1", title: "Walk + feed Tidus", calendar_id: "cal-2" }),
		]);
		expect(groups).toHaveLength(0);
	});

	test("flags overlapping similar titles too, not just adjacent", () => {
		const groups = detectPossibleReshapes([
			event({
				id: "corgi-1",
				title: "Walk + feed corgi",
				start_time: "2026-10-01T01:00:00.000Z",
				end_time: "2026-10-01T01:40:00.000Z",
			}),
			event({ id: "tidus-1", title: "Walk + feed Tidus" }),
		]);
		expect(groups).toHaveLength(1);
	});

	test("formatReshapeWarnings mentions the reshape pattern", () => {
		const groups = detectPossibleReshapes([
			event({
				id: "corgi-1",
				title: "Walk + feed corgi",
				start_time: "2026-10-01T00:45:00.000Z",
				end_time: "2026-10-01T01:15:00.000Z",
			}),
			event({ id: "tidus-1", title: "Walk + feed Tidus" }),
		]);
		const warnings = formatReshapeWarnings(groups);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("leftover");
	});
});
