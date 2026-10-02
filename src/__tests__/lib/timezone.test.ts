import { describe, expect, test } from "bun:test";
import {
	addCalendarDays,
	addElapsedMillis,
	DSTFoldError,
	DSTGapError,
	formatInTimezone,
	InvalidCalendarDateError,
	InvalidTimezoneError,
	parseCalendarDate,
	utcToDateString,
	validateTimezone,
	zonedTimeToUtc,
} from "../../lib/timezone";

describe("validateTimezone", () => {
	test("accepts valid IANA names", () => {
		expect(validateTimezone("America/Los_Angeles")).toBe("America/Los_Angeles");
		expect(validateTimezone("UTC")).toBe("UTC");
		expect(validateTimezone("Asia/Tokyo")).toBe("Asia/Tokyo");
	});

	test("rejects invalid timezone", () => {
		expect(() => validateTimezone("Not/AZone")).toThrow(InvalidTimezoneError);
		expect(() => validateTimezone("")).toThrow(InvalidTimezoneError);
	});
});

describe("parseCalendarDate", () => {
	test("accepts valid dates", () => {
		expect(parseCalendarDate("2026-09-30")).toEqual({
			year: 2026,
			month: 9,
			day: 30,
		});
		expect(parseCalendarDate("2024-02-29")).toEqual({
			year: 2024,
			month: 2,
			day: 29,
		}); // leap year
	});

	test("rejects 2026-02-30 (nonexistent date)", () => {
		expect(() => parseCalendarDate("2026-02-30")).toThrow(
			InvalidCalendarDateError,
		);
	});

	test("rejects 2026-13-01 (invalid month)", () => {
		expect(() => parseCalendarDate("2026-13-01")).toThrow(
			InvalidCalendarDateError,
		);
	});

	test("rejects 2023-02-29 (not a leap year)", () => {
		expect(() => parseCalendarDate("2023-02-29")).toThrow(
			InvalidCalendarDateError,
		);
	});

	test("rejects malformed input", () => {
		expect(() => parseCalendarDate("not-a-date")).toThrow(
			InvalidCalendarDateError,
		);
		expect(() => parseCalendarDate("2026/09/30")).toThrow(
			InvalidCalendarDateError,
		);
	});
});

describe("zonedTimeToUtc", () => {
	test("converts LA time to UTC correctly (PDT, UTC-7)", () => {
		// 2026-09-30 09:00 PDT = 16:00 UTC
		const result = zonedTimeToUtc("2026-09-30", 9, 0, "America/Los_Angeles");
		expect(result).toBe("2026-09-30T16:00:00.000Z");
	});

	test("converts LA time to UTC correctly (PST, UTC-8)", () => {
		// 2026-01-15 09:00 PST = 17:00 UTC
		const result = zonedTimeToUtc("2026-01-15", 9, 0, "America/Los_Angeles");
		expect(result).toBe("2026-01-15T17:00:00.000Z");
	});

	test("rejects DST gap (2026-03-08 02:30 America/Los_Angeles)", () => {
		// Spring forward: 2:00 AM -> 3:00 AM, 2:30 AM does not exist
		expect(() =>
			zonedTimeToUtc("2026-03-08", 2, 30, "America/Los_Angeles"),
		).toThrow(DSTGapError);
	});

	test("accepts time after DST gap", () => {
		// 3:30 AM exists (PDT, UTC-7)
		const result = zonedTimeToUtc("2026-03-08", 3, 30, "America/Los_Angeles");
		expect(result).toBe("2026-03-08T10:30:00.000Z");
	});

	test("requires fold choice for ambiguous time (2026-11-01 01:30 LA)", () => {
		// Fall back: 1:30 AM occurs twice
		expect(() =>
			zonedTimeToUtc("2026-11-01", 1, 30, "America/Los_Angeles"),
		).toThrow(DSTFoldError);
	});

	test("resolves fold with --fold first (before transition)", () => {
		const result = zonedTimeToUtc(
			"2026-11-01",
			1,
			30,
			"America/Los_Angeles",
			"first",
		);
		// First occurrence is in PDT (UTC-7)
		expect(result).toBe("2026-11-01T08:30:00.000Z");
	});

	test("resolves fold with --fold second (after transition)", () => {
		const result = zonedTimeToUtc(
			"2026-11-01",
			1,
			30,
			"America/Los_Angeles",
			"second",
		);
		// Second occurrence is in PST (UTC-8)
		expect(result).toBe("2026-11-01T09:30:00.000Z");
	});

	test("fold first and second differ by one hour", () => {
		const first = zonedTimeToUtc(
			"2026-11-01",
			1,
			30,
			"America/Los_Angeles",
			"first",
		);
		const second = zonedTimeToUtc(
			"2026-11-01",
			1,
			30,
			"America/Los_Angeles",
			"second",
		);
		const diff = new Date(second).getTime() - new Date(first).getTime();
		expect(diff).toBe(3600000);
	});

	test("rejects invalid calendar date", () => {
		expect(() =>
			zonedTimeToUtc("2026-02-30", 9, 0, "America/Los_Angeles"),
		).toThrow(InvalidCalendarDateError);
	});

	test("rejects invalid time", () => {
		expect(() =>
			zonedTimeToUtc("2026-09-30", 25, 0, "America/Los_Angeles"),
		).toThrow();
	});

	test("is host-timezone independent (UTC vs LA produce identical instants)", () => {
		// This test verifies the function doesn't depend on process TZ.
		// The implementation uses only Intl with explicit timeZone, so it
		// should be identical regardless of host TZ. We verify by checking
		// a known conversion is correct (the actual TZ-independence is
		// tested by running the suite under TZ=UTC and TZ=America/Los_Angeles).
		const result = zonedTimeToUtc("2026-09-30", 9, 0, "America/Los_Angeles");
		expect(result).toBe("2026-09-30T16:00:00.000Z");
	});
});

describe("formatInTimezone", () => {
	test("formats UTC as LA wall-clock", () => {
		const result = formatInTimezone(
			"2026-09-30T16:00:00.000Z",
			"America/Los_Angeles",
		);
		expect(result).toEqual({
			year: 2026,
			month: 9,
			day: 30,
			hours: 9,
			minutes: 0,
		});
	});
});

describe("addCalendarDays", () => {
	test("preserves wall-clock across spring-forward", () => {
		// 2026-03-07 09:00 PST (17:00 UTC) + 1 day = 2026-03-08 09:00 PDT (16:00 UTC)
		const result = addCalendarDays(
			"2026-03-07T17:00:00.000Z",
			1,
			"America/Los_Angeles",
		);
		expect(result).toBe("2026-03-08T16:00:00.000Z");
		const wall = formatInTimezone(result, "America/Los_Angeles");
		expect(wall.hours).toBe(9);
		expect(wall.minutes).toBe(0);
	});

	test("preserves wall-clock across fall-back", () => {
		// 2026-10-31 09:00 PDT (16:00 UTC) + 1 day = 2026-11-01 09:00 PST (17:00 UTC)
		const result = addCalendarDays(
			"2026-10-31T16:00:00.000Z",
			1,
			"America/Los_Angeles",
		);
		expect(result).toBe("2026-11-01T17:00:00.000Z");
		const wall = formatInTimezone(result, "America/Los_Angeles");
		expect(wall.hours).toBe(9);
	});

	test("adds 7 days for week snooze", () => {
		const result = addCalendarDays(
			"2026-09-30T16:00:00.000Z",
			7,
			"America/Los_Angeles",
		);
		expect(result).toBe("2026-10-07T16:00:00.000Z");
	});
});

describe("addElapsedMillis", () => {
	test("adds elapsed time (1d = 24h, wall-clock shifts across DST)", () => {
		// 2026-03-07 09:00 PST + 24h = 2026-03-08 10:00 PDT (wall-clock shifts!)
		const result = addElapsedMillis(
			"2026-03-07T17:00:00.000Z",
			24 * 60 * 60 * 1000,
		);
		expect(result).toBe("2026-03-08T17:00:00.000Z");
		const wall = formatInTimezone(result, "America/Los_Angeles");
		expect(wall.hours).toBe(10); // 10:00, not 09:00 (elapsed basis)
	});
});

describe("utcToDateString", () => {
	test("extracts date in timezone", () => {
		// 2026-09-30T02:00:00Z is 2026-09-29 19:00 in LA
		const result = utcToDateString(
			"2026-09-30T02:00:00.000Z",
			"America/Los_Angeles",
		);
		expect(result).toBe("2026-09-29");
	});
});
