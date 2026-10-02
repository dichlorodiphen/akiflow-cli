import { describe, expect, test } from "bun:test";
import {
	previewOccurrences,
	serializeRecurrence,
	truncateSeriesUntil,
	validateRRule,
} from "../../lib/recurrence";

describe("validateRRule", () => {
	test("accepts a valid weekly rule", () => {
		const normalized = validateRRule("FREQ=WEEKLY;BYDAY=MO,WE,FR");
		expect(normalized).toContain("FREQ=WEEKLY");
	});

	test("accepts with RRULE: prefix and strips it", () => {
		const normalized = validateRRule("RRULE:FREQ=DAILY;COUNT=5");
		expect(normalized).not.toContain("RRULE:");
		expect(normalized).toContain("FREQ=DAILY");
	});

	test("rejects empty input", () => {
		expect(() => validateRRule("")).toThrow("must not be empty");
		expect(() => validateRRule("   ")).toThrow("must not be empty");
	});

	test("rejects garbage", () => {
		expect(() => validateRRule("not-a-rule")).toThrow("Invalid RRULE");
	});

	test("rejects missing FREQ", () => {
		// A rule without FREQ is not a valid recurrence rule.
		expect(() => validateRRule("INTERVAL=2")).toThrow("Invalid RRULE");
	});

	test("revert-sensitive: validation is not a passthrough", () => {
		// If validateRRule were replaced with identity, invalid input would pass.
		expect(() => validateRRule("FREQ=BOGUSFREQ")).toThrow();
	});
});

describe("serializeRecurrence", () => {
	test("wraps normalized rule with RRULE: prefix", () => {
		expect(serializeRecurrence("FREQ=DAILY")).toEqual(["RRULE:FREQ=DAILY"]);
	});
});

describe("previewOccurrences", () => {
	test("expands first 5 occurrences in owner timezone", () => {
		// Monday 2026-06-22 09:00 in America/Los_Angeles (PDT, UTC-7).
		const dtstart = new Date("2026-06-22T16:00:00.000Z");
		const preview = previewOccurrences(
			"FREQ=WEEKLY;BYDAY=MO",
			dtstart,
			"America/Los_Angeles",
			5,
		);
		expect(preview.occurrences).toHaveLength(5);
		// First occurrence is the dtstart itself, rendered in owner zone.
		expect(preview.occurrences[0]).toContain("2026-06-22 09:00");
		expect(preview.occurrences[0]).toContain("America/Los_Angeles");
		// Second is a week later.
		expect(preview.occurrences[1]).toContain("2026-06-29 09:00");
	});

	test("occurrences carry the exact instant for auditability", () => {
		const dtstart = new Date("2026-06-22T16:00:00.000Z");
		const preview = previewOccurrences(
			"FREQ=DAILY;COUNT=2",
			dtstart,
			"America/Los_Angeles",
			2,
		);
		expect(preview.occurrences[0]).toContain("2026-06-22T16:00:00.000Z");
		expect(preview.occurrences[1]).toContain("2026-06-23T16:00:00.000Z");
	});

	test("revert-sensitive: preview is not empty", () => {
		const dtstart = new Date("2026-06-22T16:00:00.000Z");
		const preview = previewOccurrences("FREQ=DAILY", dtstart, "UTC", 3);
		// If preview were stubbed to return [], this fails.
		expect(preview.occurrences.length).toBeGreaterThan(0);
	});
});

describe("truncateSeriesUntil", () => {
	test("sets RRULE UNTIL on the series master", () => {
		const result = truncateSeriesUntil(
			["RRULE:FREQ=WEEKLY;BYDAY=MO"],
			new Date("2026-08-01T00:00:00.000Z"),
		);
		expect(result).toHaveLength(1);
		expect(result[0]!.startsWith("RRULE:")).toBe(true);
		expect(result[0]).toContain("UNTIL=20260801T000000Z");
	});

	test("refuses when master has no RRULE", () => {
		expect(() => truncateSeriesUntil(null, new Date())).toThrow("has no RRULE");
		expect(() => truncateSeriesUntil([], new Date())).toThrow("has no RRULE");
	});

	test("revert-sensitive: truncation actually modifies the rule", () => {
		const before = ["RRULE:FREQ=DAILY"];
		const after = truncateSeriesUntil(before, new Date("2026-07-01T00:00:00Z"));
		// If truncate were a no-op returning the input, UNTIL would be missing.
		expect(after[0]).not.toEqual(before[0]);
		expect(after[0]).toContain("UNTIL=");
	});
});
