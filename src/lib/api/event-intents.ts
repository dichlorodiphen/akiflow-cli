import type {
	CreateEventPayload,
	EventOperationPayload,
	EventStatus,
} from "./types";
import { NetworkError } from "./types";

/**
 * Guest notification policy for event mutations. `none` is the fork default:
 * David's standing rule is silent guest handling (no invite spam).
 */
export type EventSendUpdates = "none" | "all";

export const DEFAULT_EVENT_SEND_UPDATES: EventSendUpdates = "none";

/** Parse a `--send-updates` flag value; returns null for anything invalid. */
export function parseSendUpdates(value: unknown): EventSendUpdates | null {
	const normalized = String(value ?? DEFAULT_EVENT_SEND_UPDATES).trim();
	return normalized === "none" || normalized === "all" ? normalized : null;
}

/**
 * Thrown when an event mutation target is cancelled, deleted, read-only, or
 * hidden. This is the central library-level rejection; CLI commands convert it
 * to a user-facing failure, batch planners convert it to a skip reason.
 */
export class InvalidEventTargetError extends Error {
	readonly eventId: string;
	readonly reason: string;

	constructor(eventId: string, reason: string) {
		super(`Event "${eventId}" cannot be mutated: ${reason}`);
		this.name = "InvalidEventTargetError";
		this.eventId = eventId;
		this.reason = reason;
	}
}

/** Minimal observed-state surface needed to validate a mutation target. */
export interface EventMutationTarget {
	id: string;
	deleted_at: string | null;
	status: EventStatus | string | null;
	read_only: boolean;
	hidden: boolean;
}

/**
 * Central target check shared by the CLI, batch planners, and the intent
 * constructors below. Returns a precise reason when the target must be
 * rejected, or null when it is mutable.
 */
export function eventTargetRejectionReason(
	target: EventMutationTarget,
): string | null {
	if (target.deleted_at != null) return "event is deleted";
	if (target.status === "cancelled") return "event is cancelled";
	if (target.hidden) return "event is hidden";
	if (target.read_only) return "event is read-only";
	return null;
}

/** Reject cancelled/deleted/read-only/hidden targets with a precise reason. */
export function assertEventTargetMutable(target: EventMutationTarget): void {
	const reason = eventTargetRejectionReason(target);
	if (reason) throw new InvalidEventTargetError(target.id, reason);
}

function eventLocation(event: CreateEventPayload): string | null {
	const location = event.content?.location;
	return typeof location === "string" && location.trim()
		? location.trim()
		: null;
}

/** Provider-shaped create/patch fields sent inside v5 operation payloads. */
export function providerEventPayload(
	event: CreateEventPayload,
): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		title: event.title,
		description: event.description,
		start_time: event.start_time,
		end_time: event.end_time,
		start_datetime_tz: event.start_datetime_tz,
	};

	if (event.end_datetime_tz) {
		payload.end_datetime_tz = event.end_datetime_tz;
	}

	const location = eventLocation(event);
	if (location) payload.location = location;

	if (event.attendees.length > 0) payload.attendees = event.attendees;
	if (
		Array.isArray(event.recurrence)
			? event.recurrence.length > 0
			: event.recurrence
	) {
		payload.recurrence = event.recurrence;
	}

	return payload;
}

/** Routing identity shared by the patch and delete intent constructors. */
export interface EventOperationRoute {
	eventId: string;
	connectorId: string;
	accountId: string;
	calendarId: string;
	/** Observed target; validated centrally before the operation is built. */
	target: EventMutationTarget;
}

function operationShell(
	route: {
		eventId: string;
		connectorId: string;
		accountId: string;
		calendarId: string;
	},
	operation: EventOperationPayload["operation"],
	payload: Record<string, unknown>,
	clientOrder: number,
	timestamp: string,
): EventOperationPayload {
	return {
		id: crypto.randomUUID(),
		event_id: route.eventId,
		connector_id: route.connectorId,
		account_id: route.accountId,
		calendar_id: route.calendarId,
		operation,
		payload,
		result: null,
		processed_at: null,
		failed_at: null,
		client_order: clientOrder,
		global_created_at: timestamp,
		deleted_at: null,
		global_updated_at: timestamp,
	};
}

function requireAccountId(eventId: string, accountId: string | null): string {
	if (!accountId) {
		throw new NetworkError(
			`Event "${eventId}" is missing its Akiflow account id`,
		);
	}
	return accountId;
}

/**
 * Explicit create intent. The operation kind is fixed at construction time:
 * it can never be inferred from `status`, `origin_id`, or `deleted_at`. A
 * create payload carrying tombstone markers is a caller bug and is rejected.
 */
export function buildCreateEventOperation(
	event: CreateEventPayload,
	sendUpdates: EventSendUpdates = DEFAULT_EVENT_SEND_UPDATES,
	clientOrder = 0,
): EventOperationPayload {
	if (event.deleted_at != null || event.status === "cancelled") {
		throw new InvalidEventTargetError(
			event.id,
			event.deleted_at != null ? "event is deleted" : "event is cancelled",
		);
	}
	const accountId = requireAccountId(event.id, event.akiflow_account_id);
	const timestamp = event.global_updated_at || new Date().toISOString();
	return operationShell(
		{
			eventId: event.id,
			connectorId: event.connector_id,
			accountId,
			calendarId: event.calendar_id,
		},
		"create",
		{
			event: providerEventPayload(event),
			// Operation-level notification policy; verified silent-create shape
			// (Q:15). `content.sendUpdates` on the legacy payload is NOT read —
			// the v5 adapter dropped it.
			send_updates: sendUpdates === "all",
		},
		clientOrder,
		timestamp,
	);
}

/**
 * Explicit patch intent. `base` is the pre-edit provider state and `changes`
 * the desired provider fields; neither is derived from payload inference.
 * Notification policy rides the operation-level `send_updates` field — the
 * same shape delete uses per the captured contract. Patch-level provider
 * semantics for `send_updates` have NOT been independently captured, so the
 * field is emitted with the delete-documented shape and integration tests
 * assert exactly what goes on the wire.
 */
export function buildPatchEventOperation(
	route: EventOperationRoute,
	base: Record<string, unknown>,
	changes: Record<string, unknown>,
	sendUpdates: EventSendUpdates = DEFAULT_EVENT_SEND_UPDATES,
	clientOrder = 0,
): EventOperationPayload {
	assertEventTargetMutable(route.target);
	const timestamp = new Date().toISOString();
	return operationShell(
		{
			eventId: route.eventId,
			connectorId: route.connectorId,
			accountId: route.accountId,
			calendarId: route.calendarId,
		},
		"patch",
		{
			base,
			changes,
			send_updates: sendUpdates === "all",
		},
		clientOrder,
		timestamp,
	);
}

/**
 * Explicit delete intent. The operation kind is fixed at construction time;
 * it can never be inferred from a payload's `status`/`deleted_at` fields.
 */
export function buildDeleteEventOperation(
	route: EventOperationRoute,
	sendUpdates: EventSendUpdates = DEFAULT_EVENT_SEND_UPDATES,
	clientOrder = 0,
): EventOperationPayload {
	assertEventTargetMutable(route.target);
	const timestamp = new Date().toISOString();
	return operationShell(
		{
			eventId: route.eventId,
			connectorId: route.connectorId,
			accountId: route.accountId,
			calendarId: route.calendarId,
		},
		"delete",
		{
			send_updates: sendUpdates === "all",
		},
		clientOrder,
		timestamp,
	);
}

/** Build the v5 operation route for an observed event record. */
export function eventOperationRoute(
	event: EventMutationTarget & {
		connector_id: string | null;
		akiflow_account_id: string | null;
		calendar_id: string;
	},
): EventOperationRoute {
	if (!event.connector_id) {
		throw new NetworkError(`Event "${event.id}" is missing its connector id`);
	}
	return {
		eventId: event.id,
		connectorId: event.connector_id,
		accountId: requireAccountId(event.id, event.akiflow_account_id),
		calendarId: event.calendar_id,
		target: event,
	};
}
