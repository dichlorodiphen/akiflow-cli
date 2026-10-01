import { expect, test } from "bun:test";
import {
	intersectsWindow,
	resolveReconcileWindow,
} from "../../lib/reconcile/window";
import { now, window } from "./reconcile-fixtures";

test("la_day_selects_correct_utc_window", () => {
	expect(window).toEqual({
		start: "2026-09-30T07:00:00.000Z",
		end: "2026-10-01T07:00:00.000Z",
		timezone: "America/Los_Angeles",
		end_exclusive: true,
	});
	expect(resolveReconcileWindow({}, now, "America/Los_Angeles")).toEqual(
		window,
	);
	expect(
		resolveReconcileWindow({ date: "today" }, now, "America/Los_Angeles"),
	).toEqual(window);
	expect(
		resolveReconcileWindow({ tomorrow: true }, now, "America/Los_Angeles")
			.start,
	).toBe(window.end);
	expect(
		resolveReconcileWindow({ date: "tomorrow" }, now, "America/Los_Angeles")
			.start,
	).toBe(window.end);
});
test("dst_days_are_23_and_25_hours", () => {
	for (const [date, hours] of [
		["2026-03-08", 23],
		["2026-11-01", 25],
	] as const) {
		const resolved = resolveReconcileWindow(
			{ date },
			now,
			"America/Los_Angeles",
		);
		expect(
			(Date.parse(resolved.end) - Date.parse(resolved.start)) / 3600000,
		).toBe(hours);
	}
});
test("range uses inclusive civil to and permits exactly 31 local days", () => {
	const range = resolveReconcileWindow(
		{ from: "2026-03-01", to: "2026-03-31" },
		now,
		"America/Los_Angeles",
	);
	expect(range.end).toBe("2026-04-01T07:00:00.000Z");
	expect(() =>
		resolveReconcileWindow(
			{ from: "2026-03-01", to: "2026-04-01" },
			now,
			"UTC",
		),
	).toThrow("31");
});
test.each([
	{ today: true, tomorrow: true },
	{ date: "today", today: true },
	{ date: "today", from: "today", to: "tomorrow" },
	{ from: "today" },
	{ to: "tomorrow" },
	{ from: "tomorrow", to: "today" },
	{ date: "2026-02-30" },
	{ date: "2026-09-30T12:00:00Z" },
	{ date: "today at 9am" },
	{ date: "9am" },
	{ date: "today extra nonsense" },
])("invalid selectors fail: %j", (args) => {
	expect(() =>
		resolveReconcileWindow(args, now, "America/Los_Angeles"),
	).toThrow();
});
test("natural day vocabulary resolves in reporting timezone", () => {
	expect(
		resolveReconcileWindow({ date: "yesterday" }, now, "America/Los_Angeles")
			.start,
	).toBe("2026-09-29T07:00:00.000Z");
	expect(
		resolveReconcileWindow({ date: "in 3 days" }, now, "America/Los_Angeles")
			.start,
	).toBe("2026-10-03T07:00:00.000Z");
	expect(
		resolveReconcileWindow({ date: "next monday" }, now, "America/Los_Angeles")
			.start,
	).toBe("2026-10-05T07:00:00.000Z");
});
test("boundary_touching_is_excluded", () => {
	expect(
		intersectsWindow(
			{ kind: "timed", start: "2026-09-30T06:00:00Z", end: window.start },
			window,
			"UTC",
		),
	).toBe(false);
	expect(
		intersectsWindow(
			{ kind: "timed", start: window.end, end: "2026-10-01T08:00:00Z" },
			window,
			"UTC",
		),
	).toBe(false);
	expect(
		intersectsWindow(
			{ kind: "timed", start: window.start, end: null },
			window,
			"UTC",
		),
	).toBe(true);
	expect(
		intersectsWindow(
			{ kind: "timed", start: window.end, end: null },
			window,
			"UTC",
		),
	).toBe(false);
	expect(intersectsWindow({ kind: "unknown" }, window, "UTC")).toBeNull();
});
test("invalid timezone is usage error", () => {
	expect(() => resolveReconcileWindow({}, now, "Mars/Olympus")).toThrow(
		"Invalid timezone",
	);
});

test("DST transition at midnight uses the first instant of the local day", () => {
	const resolved = resolveReconcileWindow(
		{ date: "2026-03-08" },
		now,
		"America/Havana",
	);
	expect(resolved.start).toBe("2026-03-08T05:00:00.000Z");
	expect(resolved.end).toBe("2026-03-09T04:00:00.000Z");
});
