import { describe, expect, it } from "bun:test";
import {
	buildBatchReport,
	classifyBatchResults,
	mutableTimedGoogleEventSkipReason,
	planEventAttendeeBatch,
	planEventDeleteBatch,
	planSlotDeleteBatch,
	selectBatchEvents,
	selectBatchSlots,
} from "../../commands/batch";
import { parseEventMutationResult } from "../../lib/api/mutation-results";
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
	it("only names envelope failed ids as failed and preserves unmentioned unknowns", () => {
		const planned = planEventDeleteBatch(
			[
				event({ id: "failed" }),
				event({ id: "unmentioned" }),
				event({ id: "accepted" }),
			],
			"none",
			{ createdEventIds: new Set(["failed", "unmentioned", "accepted"]) },
		);
		const classified = classifyBatchResults(planned, {
			success: false,
			message: "Partial failure",
			failed: [{ id: "failed", error: "Rejected" }],
			data: [{ id: "accepted" }],
		});
		expect(classified.map((item) => item.action)).toEqual([
			"failed",
			"unknown",
			"accepted",
		]);
	});

	it("matches operation failures by operation id while unmentioned operations stay unknown", () => {
		const operations = planEventAttendeeBatch(
			[event({ id: "first" }), event({ id: "second" })],
			["new@example.com"],
			"add",
		).map((item) => item.payload!);
		const result = parseEventMutationResult(
			{
				success: false,
				message: "Partial failure",
				data: [],
				failed: [{ id: operations[0]!.id, error: "Denied" }],
			} as never,
			operations,
		);
		// Empty result data means the envelope cannot confirm per-operation
		// outcomes: nothing is invented as accepted or failed, but the
		// matched failure detail is preserved on the receipt.
		expect(result.receipts).toMatchObject([
			{
				operation_id: operations[0]!.id,
				event_id: "first",
				status: "unknown",
				error: ["Partial failure", "Denied"],
			},
			{
				operation_id: operations[1]!.id,
				event_id: "second",
				status: "unknown",
				error: "Partial failure",
			},
		]);
		expect(result.allAccepted).toBe(false);
	});

	it("retains operation processing receipts and honors failed_at and explicit pending", () => {
		const operations = planEventAttendeeBatch(
			[event({ id: "first" }), event({ id: "second" })],
			["new@example.com"],
			"add",
		).map((item) => item.payload!);
		const result = parseEventMutationResult(
			{
				success: true,
				message: null,
				data: [
					{
						...operations[0]!,
						failed_at: "2026-09-30T10:00:00Z",
						result: "Rejected",
					},
					{ ...operations[1]!, ...({ status: "pending" } as object) },
				],
			} as never,
			operations,
		);
		expect(result.receipts.map((receipt) => receipt.status)).toEqual([
			"failed",
			"pending",
		]);
		expect(result.receipts[0]).toMatchObject({
			failed_at: "2026-09-30T10:00:00Z",
			result: "Rejected",
			kind: "patch",
		});
	});

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
		expect(planned[0]?.payload).toEqual(
			expect.objectContaining({
				event_id: "event-123",
				operation: "patch",
				payload: expect.objectContaining({
					changes: expect.objectContaining({
						attendees: [
							{ email: "pat@example.com" },
							{ email: "julia@example.com", responseStatus: "needsAction" },
						],
					}),
					send_updates: false,
				}),
			}),
		);
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

	it("builds explicit delete operations with silent notification policy", () => {
		const planned = planEventDeleteBatch([event()], "none", {
			createdEventIds: new Set(["event-123"]),
		});

		expect(planned[0]?.action).toBe("change");
		expect(planned[0]?.payload).toEqual(
			expect.objectContaining({
				event_id: "event-123",
				connector_id: "google",
				account_id: "account-123",
				calendar_id: "cal-123",
				operation: "delete",
				payload: { send_updates: false },
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

	it("skips delete targets this CLI did not create unless --confirm", () => {
		const foreign = event({ id: "foreign-1", title: "Someone else's block" });
		const own = event({ id: "own-1", title: "My CLI block" });

		const planned = planEventDeleteBatch([foreign, own], "none", {
			createdEventIds: new Set(["own-1"]),
		});

		expect(planned[0]?.action).toBe("skip");
		expect(planned[0]?.reason).toMatch(/not created by this CLI/);
		expect(planned[0]?.reason).toMatch(/--confirm/);
		expect(planned[0]?.payload).toBeUndefined();
		expect(planned[1]?.action).toBe("change");
		expect(planned[1]?.payload).toEqual(
			expect.objectContaining({ operation: "delete", event_id: "own-1" }),
		);
	});

	it("plans deletes for foreign events when confirm is true", () => {
		const planned = planEventDeleteBatch([event({ id: "foreign-1" })], "none", {
			confirm: true,
			createdEventIds: new Set(),
		});

		expect(planned[0]?.action).toBe("change");
		expect(planned[0]?.payload).toEqual(
			expect.objectContaining({ operation: "delete", event_id: "foreign-1" }),
		);
	});

	it("keeps mutability skips ahead of the provenance guard", () => {
		const readonlyEvent = event({ id: "ro-1", read_only: true });
		const planned = planEventDeleteBatch([readonlyEvent], "none", {
			createdEventIds: new Set(),
		});

		expect(planned[0]?.action).toBe("skip");
		expect(planned[0]?.reason).toBe("event is read-only");
	});
});
