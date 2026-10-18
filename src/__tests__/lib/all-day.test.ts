import { describe, expect, test } from "bun:test";
import { buildCreateEventPayload } from "../../commands/create";
import { allDaySpan, moveAllDaySpan } from "../../lib/all-day";
import { providerEventPayload } from "../../lib/api/event-intents";
import type { Calendar } from "../../lib/api/types";
import { eventExpectedFields } from "../../lib/mutation-output";

describe("date-only event spans", () => {
	test("one day defaults to an exclusive following date across DST", () => {
		expect(allDaySpan("2026-03-08")).toEqual({
			start_date: "2026-03-08",
			end_date: "2026-03-09",
		});
	});
	test("rejects invalid, equal and reversed dates", () => {
		for (const [start, end] of [
			["2026-02-30", undefined],
			["2026-03-08", "2026-03-08"],
			["2026-03-08", "2026-03-07"],
		])
			expect(() => allDaySpan(start!, end)).toThrow();
	});
	test("moves preserve civil duration across DST and year boundaries", () => {
		expect(moveAllDaySpan("2026-03-07", "2026-03-10", "2026-12-31")).toEqual({
			start_date: "2026-12-31",
			end_date: "2027-01-03",
		});
	});
	test("wire create and verification keep dates and null timed fields", () => {
		const payload = buildCreateEventPayload({
			title: "date-only",
			startTime: null,
			endTime: null,
			startDate: "2026-03-08",
			endDate: "2026-03-10",
			timezone: "Pacific/Kiritimati",
			calendar: {
				id: "cal",
				akiflow_account_id: "account",
				connector_id: "google",
				origin_id: "calendar@example.com",
			} as Calendar,
		});
		const wire = providerEventPayload(payload);
		expect(Object.hasOwn(wire, "start_time")).toBe(false);
		expect(Object.hasOwn(wire, "end_time")).toBe(false);
		expect(wire.start_date).toBe("2026-03-08");
		expect(wire.end_date).toBe("2026-03-10");
		expect(eventExpectedFields(payload).end_date).toBe("2026-03-10");
	});
});
