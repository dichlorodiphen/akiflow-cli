import { describe, expect, it } from "bun:test";
import {
	buildBatchReport,
	mutableTimedGoogleEventSkipReason,
	planEventAttendeeBatch,
	planEventDeleteBatch,
	planSlotDeleteBatch,
	selectBatchEvents,
	selectBatchSlots,
} from "../../commands/batch";
import type { Calendar, Event, TimeSlot } from "../../lib/api/types";

function calendar(overrides: Partial<Calendar> = {}): Calendar {
	return {
		id: "cal-123",
		title: "Personal",
		origin_id: "person@example.com",
		akiflow_account_id: "account-123",
		connector_id: "google",
		deleted_at: null,
		hidden_at: null,
		read_only: false,
		...overrides,
	} as Calendar;
}

function event(overrides: Partial<Event> = {}): Event {
	return {
		id: "event-123",
		title: "Portland trip: flight",
		description: "Gate details",
		start_time: "2026-06-20T16:00:00.000Z",
		end_time: "2026-06-20T17:00:00.000Z",
		start_date: null,
		end_date: null,
		status: "confirmed",
		declined: false,
		read_only: false,
		hidden: false,
		deleted_at: null,
		connector_id: "google",
		calendar_id: "cal-123",
		akiflow_account_id: "account-123",
		recurring_id: null,
		origin_recurring_id: null,
		recurrence: null,
		recurrence_exception: false,
		attendees: [{ email: "pat@example.com" }],
		content: {},
		data: {},
		fingerprints: {},
		user_id: 1,
		...overrides,
	} as Event;
}

function slot(overrides: Partial<TimeSlot> = {}): TimeSlot {
	return {
		id: "slot-123",
		title: "Portland planning",
		description: "Trip work",
		start_time: "2026-06-20T16:00:00.000Z",
		end_time: "2026-06-20T17:00:00.000Z",
		calendar_id: "cal-123",
		deleted_at: null,
		...overrides,
	} as TimeSlot;
}

describe("batch command helpers", () => {
	it("selects cached events by date, search, and calendar", () => {
		const selected = selectBatchEvents(
			[
				event(),
				event({
					id: "event-other-title",
					title: "Dinner",
				}),
				event({
					id: "event-other-date",
					start_time: "2026-06-21T16:00:00.000Z",
					end_time: "2026-06-21T17:00:00.000Z",
				}),
			],
			[calendar()],
			{
				date: "2026-06-20",
				search: "Portland",
				calendar: "Personal",
			},
		);

		expect(selected.map((item) => item.id)).toEqual(["event-123"]);
	});

	it("classifies attendee changes and no-ops per event", () => {
		const planned = planEventAttendeeBatch(
			[
				event(),
				event({
					id: "event-existing",
					attendees: [{ email: "julia@example.com" }],
				}),
			],
			["julia@example.com"],
			"add",
		);

		expect(planned.map((item) => item.action)).toEqual(["change", "noop"]);
		expect(planned[0]?.payload?.content).toEqual({
			attendeeEmailsToAdd: ["julia@example.com"],
			attendeeEmailsToRemove: [],
			attendeeResponseStatusesByEmail: {
				"julia@example.com": "needsAction",
			},
			sendUpdates: "all",
		});
	});

	it("skips non-mutable event records instead of failing the whole batch", () => {
		const readonly = event({ read_only: true });

		expect(mutableTimedGoogleEventSkipReason(readonly)).toBe(
			"event is read-only",
		);
		expect(
			planEventAttendeeBatch([readonly], ["julia@example.com"], "add"),
		).toEqual([
			expect.objectContaining({
				action: "skip",
				reason: "event is read-only",
			}),
		]);
	});

	it("builds event delete payloads with the captured single-event shape", () => {
		const planned = planEventDeleteBatch([event()], "none");

		expect(planned[0]?.action).toBe("change");
		expect(planned[0]?.payload).toEqual(
			expect.objectContaining({
				id: "event-123",
				status: "cancelled",
				deleted_at: expect.any(String),
				global_updated_at: expect.any(String),
				content: { sendUpdates: "none" },
			}),
		);
	});

	it("selects and plans slot deletes from slot filters", () => {
		const selected = selectBatchSlots(
			[
				slot(),
				slot({ id: "slot-other", title: "Other" }),
				slot({
					id: "slot-later",
					start_time: "2026-06-21T16:00:00.000Z",
					end_time: "2026-06-21T17:00:00.000Z",
				}),
			],
			[calendar()],
			{
				date: "2026-06-20",
				search: "Portland",
				calendar: "Personal",
			},
		);
		const planned = planSlotDeleteBatch(selected);

		expect(selected.map((item) => item.id)).toEqual(["slot-123"]);
		expect(planned[0]?.payload).toEqual({
			id: "slot-123",
			deleted_at: expect.any(String),
			global_updated_at: expect.any(String),
		});
	});

	it("summarizes dry-run output with stable counts", () => {
		const report = buildBatchReport(
			"events.attendees.remove",
			"dry-run",
			planEventAttendeeBatch(
				[
					event(),
					event({
						id: "event-missing",
						attendees: [],
					}),
					event({
						id: "event-recurring",
						recurring_id: "series-1",
					}),
				],
				["pat@example.com"],
				"remove",
			),
		);

		expect(report).toMatchObject({
			mode: "dry-run",
			operation: "events.attendees.remove",
			selected: 3,
			changed: 1,
			noop: 1,
			skipped: 1,
			failed: 0,
		});
	});
});
