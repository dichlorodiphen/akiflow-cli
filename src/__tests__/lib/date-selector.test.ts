import { describe, expect, test } from "bun:test";
import {
	strictBoundarySelector,
	strictDaySelector,
	strictMonthSelector,
	validateDateSelectors,
} from "../../lib/date-selector";

const now = new Date(2026, 4, 21, 12);
describe("strict shared date selectors", () => {
	test("rejects garbage, partial natural language and impossible ISO dates", () => {
		for (const value of [
			"nonsense",
			"junk tomorrow junk",
			"2026-02-30",
			"2026-13-01",
			"",
		]) {
			expect(() => strictDaySelector(value, now)).toThrow(
				"Invalid --date selector",
			);
			expect(() => strictBoundarySelector(value, "start", now)).toThrow(
				"Invalid --from selector",
			);
		}
	});
	test("normalizes whole natural language and ISO dates without fallback", () => {
		expect(strictDaySelector("tomorrow", now).from.getDate()).toBe(22);
		expect(strictDaySelector("2026-05-21", now).from.getDate()).toBe(21);
		expect(
			strictBoundarySelector("2026-05-21T12:00:00Z", "end", now).toISOString(),
		).toBe("2026-05-21T12:00:00.000Z");
	});
	test("validates months and includes the entire last day", () => {
		for (const value of [
			"2026-00",
			"2026-13",
			"may nonsense",
			"marching",
			"may 2026 extra",
		])
			expect(() => strictMonthSelector(value, now)).toThrow(
				"Invalid --month selector",
			);
		expect(strictMonthSelector("may 2026", now).to.getHours()).toBe(23);
		expect(strictMonthSelector("2026-05", now).to.getDate()).toBe(31);
	});
	test("validates every supplied selector even when another selector wins", () => {
		expect(() =>
			validateDateSelectors({ today: true, date: "nonsense" }),
		).toThrow();
	});
});
