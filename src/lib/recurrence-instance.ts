import { createHash } from "node:crypto";
import {
	buildDeleteEventOperation,
	buildPatchEventOperation,
	type EventSendUpdates,
	eventOperationRoute,
} from "./api/event-intents";
import type { Event, EventOperationPayload } from "./api/types";
import {
	expandRecurringEvents,
	isRecurringEventMaster,
} from "./recurrence-expansion";
import { parseCalendarDate } from "./timezone";

/** Matches the official Akiflow rust client's generateStableUuid(namespace, anchor). */
export function occurrenceUuid(masterId: string, anchor: string): string {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			masterId,
		)
	)
		throw new Error("Recurring master requires a full UUID");
	const namespace = Buffer.from(masterId.replaceAll("-", ""), "hex");
	const bytes = createHash("sha1")
		.update(namespace)
		.update(anchor)
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6]! & 15) | 80;
	bytes[8] = (bytes[8]! & 63) | 128;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface RecurrenceInstance {
	event: Event;
	parent: Event;
	anchor: string;
	allDay: boolean;
	materialized: boolean;
}

/** Resolve against one fresh inventory, preserving moved exceptions and tombstones. */
export function resolveRecurrenceInstance(
	selected: Event,
	events: Event[],
	requestedAnchor?: string,
): RecurrenceInstance {
	const parentId = isRecurringEventMaster(selected)
		? selected.id
		: selected.recurring_id;
	const parents = events.filter(
		(event) => event.id === parentId && isRecurringEventMaster(event),
	);
	if (parents.length !== 1)
		throw new Error(
			"The recurring series master must be uniquely observed in the fresh event inventory",
		);
	const parent = parents[0]!;
	if (
		parent.deleted_at != null ||
		parent.status === "cancelled" ||
		parent.read_only
	)
		throw new Error(
			"The recurring series master is deleted, cancelled or read-only",
		);
	if (
		parent.calendar_id !== selected.calendar_id ||
		parent.akiflow_account_id !== selected.akiflow_account_id ||
		parent.connector_id !== selected.connector_id
	)
		throw new Error(
			"Occurrence and series account/calendar identity do not match",
		);
	const allDay = parent.start_date != null;
	let anchor =
		requestedAnchor ??
		(allDay ? selected.original_start_date : selected.original_start_time);
	if (!anchor)
		throw new Error(
			"--scope instance requires --instance-anchor or an observed original occurrence anchor",
		);
	if (allDay) parseCalendarDate(anchor);
	else {
		if (
			!/(?:Z|[+-]\d{2}:\d{2})$/i.test(anchor) ||
			!Number.isFinite(Date.parse(anchor))
		)
			throw new Error(
				"Timed --instance-anchor requires an explicit-offset ISO instant",
			);
		anchor = new Date(anchor).toISOString();
	}
	const selectedAnchor = allDay
		? selected.original_start_date
		: selected.original_start_time;
	if (
		!isRecurringEventMaster(selected) &&
		selectedAnchor &&
		(allDay
			? selectedAnchor !== anchor
			: Date.parse(selectedAnchor) !== Date.parse(anchor))
	)
		throw new Error(
			"--instance-anchor conflicts with the selected occurrence's original anchor",
		);
	const matching = events.filter(
		(event) =>
			event.id !== parent.id &&
			event.recurring_id === parent.id &&
			event.calendar_id === parent.calendar_id &&
			event.akiflow_account_id === parent.akiflow_account_id &&
			event.connector_id === parent.connector_id &&
			(allDay
				? event.original_start_date === anchor
				: !!event.original_start_time &&
					Date.parse(event.original_start_time) === Date.parse(anchor)),
	);
	if (matching.length > 1)
		throw new Error(
			"Multiple observed exceptions share this series and original anchor; refusing ambiguous mutation",
		);
	if (matching[0]?.recurrence_exception_delete)
		throw new Error(
			"The observed occurrence has a recurrence cancellation marker",
		);
	if (matching[0])
		return { event: matching[0], parent, anchor, allDay, materialized: true };
	// Unmaterialized occurrences use exactly the client's stable UUID contract.
	// Validate recurrence membership before constructing an operation target.
	const instant = new Date(allDay ? `${anchor}T00:00:00Z` : anchor);
	const warnings: string[] = [];
	const generated = expandRecurringEvents(
		[],
		instant,
		instant,
		[parent],
		warnings,
	);
	if (warnings.length) throw new Error(warnings.join("; "));
	const occurrence = generated.find((event) =>
		allDay
			? event.original_start_date === anchor
			: event.original_start_time === anchor,
	);
	if (!occurrence)
		throw new Error(
			"Original anchor is not an active occurrence of the observed series (it may be excluded or outside its recurrence)",
		);
	return {
		event: {
			...occurrence,
			id: occurrenceUuid(parent.id, anchor),
			origin_id: null,
			origin_recurring_id: parent.origin_id,
		},
		parent,
		anchor,
		allDay,
		materialized: false,
	};
}

export function instancePayload(
	instance: RecurrenceInstance,
): Record<string, unknown> {
	return {
		parent_event_id: instance.parent.id,
		[instance.allDay ? "original_start_date" : "original_start_time"]:
			instance.anchor,
	};
}
export function buildInstancePatch(
	instance: RecurrenceInstance,
	base: Record<string, unknown>,
	changes: Record<string, unknown>,
	sendUpdates: EventSendUpdates,
): EventOperationPayload {
	const operation = buildPatchEventOperation(
		eventOperationRoute(instance.event),
		base,
		changes,
		sendUpdates,
	);
	Object.assign(operation.payload, instancePayload(instance));
	return operation;
}
export function buildInstanceDelete(
	instance: RecurrenceInstance,
	sendUpdates: EventSendUpdates,
): EventOperationPayload {
	const operation = buildDeleteEventOperation(
		eventOperationRoute(instance.event),
		sendUpdates,
	);
	if (instance.allDay && instance.materialized) {
		// Live Akiflow/Google acceptance: anchored deletes of moved all-day
		// exceptions were acknowledged but did not reach Google. A direct
		// observed exception UUID delete preserves the parent and siblings.
		// Select this route before submission; never retry a prior operation.
		const { event, parent, anchor } = instance;
		if (
			!event.origin_id ||
			event.recurrence_exception !== true ||
			event.recurring_id !== parent.id ||
			event.original_start_date !== anchor ||
			event.calendar_id !== parent.calendar_id ||
			event.akiflow_account_id !== parent.akiflow_account_id ||
			event.connector_id !== parent.connector_id
		)
			throw new Error(
				"Materialized all-day deletion requires a fresh provider-backed exception and exact parent/account/calendar/original-date identity",
			);
		return operation;
	}
	Object.assign(operation.payload, instancePayload(instance));
	return operation;
}
