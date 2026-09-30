import { describe, expect, it } from "bun:test";
import type { EventMutationTarget } from "../../lib/api/event-intents";
import {
	assertEventTargetMutable,
	buildCreateEventOperation,
	buildDeleteEventOperation,
	buildPatchEventOperation,
	DEFAULT_EVENT_SEND_UPDATES,
	eventOperationRoute,
	eventTargetRejectionReason,
	InvalidEventTargetError,
	parseSendUpdates,
} from "../../lib/api/event-intents";
import type { CreateEventPayload } from "../../lib/api/types";
import { NetworkError } from "../../lib/api/types";

function createPayload(
	overrides: Partial<CreateEventPayload> = {},
): CreateEventPayload {
	return {
		title: "Standup",
		description: "Discuss launch",
		start_time: "2026-06-20T16:00:00.000Z",
		end_time: "2026-06-20T16:30:00.000Z",
		id: "create-123",
		status: "confirmed",
		start_datetime_tz: "America/Los_Angeles",
		creator_id: null,
		organizer_id: null,
		origin_id: null,
		connector_id: "google",
		akiflow_account_id: "akiflow-account-1",
		origin_account_id: "google-account-1",
		recurring_id: null,
		origin_recurring_id: null,
		calendar_id: "cal-123",
		origin_calendar_id: "person@example.com",
		original_start_time: null,
		original_start_date: null,
		start_date: null,
		end_date: null,
		end_datetime_tz: null,
		origin_updated_at: null,
		etag: null,
		content: {},
		attendees: [],
		recurrence: null,
		deleted_at: null,
		global_created_at: "2026-06-19T00:00:00.000Z",
		global_updated_at: "2026-06-19T00:00:00.000Z",
		...overrides,
	} as CreateEventPayload;
}

function mutableTarget(
	overrides: Partial<EventMutationTarget> = {},
): EventMutationTarget {
	return {
		id: "event-123",
		deleted_at: null,
		status: "confirmed",
		read_only: false,
		hidden: false,
		...overrides,
	};
}

function route(target: EventMutationTarget = mutableTarget()) {
	return {
		eventId: target.id,
		connectorId: "google",
		accountId: "akiflow-account-1",
		calendarId: "cal-123",
		target,
	};
}

describe("event intents", () => {
	it("defaults guest notifications to none and parses --send-updates", () => {
		expect(DEFAULT_EVENT_SEND_UPDATES).toBe("none");
		expect(parseSendUpdates("none")).toBe("none");
		expect(parseSendUpdates("all")).toBe("all");
		expect(parseSendUpdates(undefined)).toBe("none");
		expect(parseSendUpdates(null)).toBe("none");
		expect(parseSendUpdates("everyone")).toBeNull();
		expect(parseSendUpdates("")).toBeNull();
	});

	it("builds an explicit create operation that cannot be inferred from legacy markers", () => {
		// Legacy inference would read origin_id as "existing event" and flip
		// the kind to patch; the explicit intent pins create.
		const operation = buildCreateEventOperation(
			createPayload({ origin_id: "google-event-123" }),
		);
		expect(operation.operation).toBe("create");
		expect(operation.event_id).toBe("create-123");
		expect(operation.connector_id).toBe("google");
		expect(operation.account_id).toBe("akiflow-account-1");
		expect(operation.calendar_id).toBe("cal-123");
		expect(operation.payload).toEqual({
			event: expect.objectContaining({ title: "Standup" }),
			send_updates: false,
		});
		expect(typeof operation.id).toBe("string");
		expect(operation.client_order).toBe(0);
	});

	it("sends updates on create only with --send-updates all", () => {
		const silent = buildCreateEventOperation(createPayload());
		expect(silent.payload).toMatchObject({ send_updates: false });
		const notifying = buildCreateEventOperation(createPayload(), "all", 2);
		expect(notifying.payload).toMatchObject({ send_updates: true });
		expect(notifying.client_order).toBe(2);
	});

	it("rejects create payloads carrying tombstone or cancelled markers", () => {
		expect(() =>
			buildCreateEventOperation(
				createPayload({ deleted_at: "2026-06-19T00:00:00.000Z" }),
			),
		).toThrow(InvalidEventTargetError);
		expect(() =>
			buildCreateEventOperation(
				createPayload({ deleted_at: "2026-06-19T00:00:00.000Z" }),
			),
		).toThrow("event is deleted");
		expect(() =>
			buildCreateEventOperation(createPayload({ status: "cancelled" })),
		).toThrow("event is cancelled");
	});

	it("fails a create before POST when the account id is missing", () => {
		expect(() =>
			buildCreateEventOperation(createPayload({ akiflow_account_id: null })),
		).toThrow(NetworkError);
	});

	it("builds an explicit patch operation that keeps its kind on misleading targets", () => {
		// A target whose status/origin markers once drove inference stays a
		// patch: the kind is fixed by the constructor, never by the payload.
		const target = mutableTarget({
			id: "patch-123",
			status: "confirmed",
		});
		const operation = buildPatchEventOperation(
			route(target),
			{ title: "Old title" },
			{ title: "New title" },
		);
		expect(operation.operation).toBe("patch");
		expect(operation.event_id).toBe("patch-123");
		expect(operation.payload).toEqual({
			base: { title: "Old title" },
			changes: { title: "New title" },
			send_updates: false,
		});
	});

	it("builds an explicit delete operation with silent notification policy", () => {
		const operation = buildDeleteEventOperation(
			route(mutableTarget({ id: "delete-123" })),
		);
		expect(operation.operation).toBe("delete");
		expect(operation.event_id).toBe("delete-123");
		expect(operation.payload).toEqual({ send_updates: false });
		const notifying = buildDeleteEventOperation(
			route(mutableTarget({ id: "delete-456" })),
			"all",
		);
		expect(notifying.payload).toEqual({ send_updates: true });
	});

	it("centrally rejects cancelled, deleted, read-only, and hidden targets", () => {
		const cases: Array<{ target: EventMutationTarget; reason: string }> = [
			{
				target: mutableTarget({ status: "cancelled" }),
				reason: "event is cancelled",
			},
			{
				target: mutableTarget({ deleted_at: "2026-06-19T00:00:00.000Z" }),
				reason: "event is deleted",
			},
			{ target: mutableTarget({ hidden: true }), reason: "event is hidden" },
			{
				target: mutableTarget({ read_only: true }),
				reason: "event is read-only",
			},
		];
		for (const { target, reason } of cases) {
			expect(eventTargetRejectionReason(target)).toBe(reason);
			expect(() => assertEventTargetMutable(target)).toThrow(
				InvalidEventTargetError,
			);
			try {
				assertEventTargetMutable(target);
				expect.unreachable();
			} catch (error) {
				const invalid = error as InvalidEventTargetError;
				expect(invalid.eventId).toBe(target.id);
				expect(invalid.reason).toBe(reason);
				expect(invalid.message).toContain(reason);
			}
			// Both patch and delete intents enforce the central check.
			expect(() =>
				buildPatchEventOperation(route(target), {}, { title: "x" }),
			).toThrow(reason);
			expect(() => buildDeleteEventOperation(route(target))).toThrow(reason);
		}
		expect(eventTargetRejectionReason(mutableTarget())).toBeNull();
		expect(() => assertEventTargetMutable(mutableTarget())).not.toThrow();
	});

	it("gives every operation a distinct id so receipts match by id, not position", () => {
		const first = buildPatchEventOperation(
			route(),
			{ title: "a" },
			{ title: "b" },
		);
		const second = buildPatchEventOperation(
			route(),
			{ title: "a" },
			{ title: "c" },
		);
		expect(first.id).not.toBe(second.id);
		expect(first.client_order).toBe(0);
	});

	it("builds the v5 route from an observed event and rejects missing ids", () => {
		const built = eventOperationRoute({
			...mutableTarget(),
			connector_id: "google",
			akiflow_account_id: "akiflow-account-1",
			calendar_id: "cal-123",
		});
		expect(built).toMatchObject({
			eventId: "event-123",
			connectorId: "google",
			accountId: "akiflow-account-1",
			calendarId: "cal-123",
		});
		expect(() =>
			eventOperationRoute({
				...mutableTarget(),
				connector_id: null,
				akiflow_account_id: "akiflow-account-1",
				calendar_id: "cal-123",
			}),
		).toThrow(NetworkError);
		expect(() =>
			eventOperationRoute({
				...mutableTarget(),
				connector_id: "google",
				akiflow_account_id: null,
				calendar_id: "cal-123",
			}),
		).toThrow(NetworkError);
	});
});
