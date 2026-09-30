import type { Event, Task, TimeSlot } from "./api/types";
import { parseLocalDate } from "./date-parser";
import { filterEvents } from "./filters/event";

export type OccurrenceSource = "event" | "slot" | "task";
export interface RecurrenceIdentity {
	recurring_id: string | null;
	origin_recurring_id: string | null;
	original_start_time: Date | null;
	original_start_date: string | null;
	recurrence_exception: boolean;
}
export interface OccurrenceLinkage {
	taskId: string | null;
	timeSlotId: string | null;
}
export interface Occurrence {
	id: string;
	source: OccurrenceSource;
	title: string | null;
	start: Date;
	end: Date | null;
	allDay: boolean;
	accountId: string | null;
	connectorId: string | null;
	calendarId: string | null;
	cancelled: boolean;
	done: boolean;
	trashed: boolean;
	declined: boolean;
	deleted: boolean;
	recurrence: RecurrenceIdentity;
	linkage: OccurrenceLinkage;
	/** Observed provider identity, not proof of provider verification. */
	provenance: {
		origin_id: string | null;
		origin_account_id: string | null;
		observedAt: string | null;
		generation: string | null;
		pending: boolean;
	};
}
export interface OccurrenceQuery {
	from?: Date;
	to?: Date;
	accountId?: string;
	connectorId?: string;
	calendarId?: string;
	calendarIds?: string[];
	activeCalendarIds?: string[];
	includeCancelled?: boolean;
	includeDone?: boolean;
	includeTrashed?: boolean;
	includeDeclined?: boolean;
	allDayOnly?: boolean;
	excludeAllDay?: boolean;
}
/** Read fields absent from some current API declarations. No payload changes. */
export interface OccurrenceReadFields {
	akiflow_account_id?: string | null;
	connector_id?: string | null;
	origin_id?: string | null;
	origin_account_id?: string | null;
	origin_recurring_id?: string | null;
	original_start_time?: string | null;
	original_start_date?: string | null;
	recurrence_exception?: boolean;
}
export interface OccurrenceInputs {
	events?: Event[];
	slots?: (TimeSlot & OccurrenceReadFields)[];
	tasks?: (Task & OccurrenceReadFields)[];
}

function parsed(value: string | null | undefined): Date | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date : null;
}
function base(
	record: (Event | TimeSlot | Task) & OccurrenceReadFields,
	source: OccurrenceSource,
	start: Date,
	end: Date | null,
): Occurrence {
	return {
		id: record.id,
		source,
		title: record.title,
		start,
		end,
		allDay: false,
		accountId: record.akiflow_account_id ?? null,
		connectorId: record.connector_id ?? null,
		calendarId: record.calendar_id ?? null,
		cancelled: false,
		done: false,
		trashed: false,
		declined: false,
		deleted: record.deleted_at != null,
		recurrence: {
			recurring_id: record.recurring_id ?? null,
			origin_recurring_id: record.origin_recurring_id ?? null,
			original_start_time: parsed(record.original_start_time),
			original_start_date: record.original_start_date ?? null,
			recurrence_exception: record.recurrence_exception ?? false,
		},
		linkage: { taskId: null, timeSlotId: null },
		provenance: {
			origin_id: record.origin_id ?? null,
			origin_account_id: record.origin_account_id ?? null,
			observedAt: null,
			generation: null,
			pending: false,
		},
	};
}
export function normalizeEvent(event: Event): Occurrence | null {
	const allDay = event.start_date != null;
	const start =
		event.start_date != null
			? parseLocalDate(event.start_date)
			: parsed(event.start_time);
	if (!start) return null;
	let end: Date | null;
	if (event.start_date != null) {
		end = parseLocalDate(event.end_date ?? event.start_date);
		if (!end) return null;
		// Calendar arithmetic preserves midnight across DST changes.
		end.setDate(end.getDate() + 1);
	} else {
		end = parsed(event.end_time);
	}
	if (end && end < start) return null;
	return {
		...base(event, "event", start, end),
		allDay,
		cancelled: event.status === "cancelled",
		declined: event.declined,
		linkage: {
			taskId: event.task_id ?? null,
			timeSlotId: event.time_slot_id ?? null,
		},
	};
}
export function normalizeSlot(
	slot: TimeSlot & OccurrenceReadFields,
): Occurrence | null {
	const start = parsed(slot.start_time);
	const end = parsed(slot.end_time);
	if (!start || !end || end < start) return null;
	return base(slot, "slot", start, end);
}
export function normalizeTask(
	task: Task & OccurrenceReadFields,
): Occurrence | null {
	const start = parsed(task.datetime);
	if (!start) return null;
	const end =
		task.duration && task.duration > 0
			? new Date(start.getTime() + task.duration * 1000)
			: null;
	return {
		...base(task, "task", start, end),
		done: task.done,
		trashed: task.trashed_at != null,
		linkage: { taskId: null, timeSlotId: task.time_slot_id ?? null },
	};
}

/** Pure snapshot query. Hidden-master visibility delegates to the existing rule. */
export function queryOccurrencesWithRaw(
	input: OccurrenceInputs,
	query: OccurrenceQuery = {},
): OccurrenceWithRaw[] {
	if (query.from && query.to && query.from >= query.to) return [];
	const candidates: {
		occurrence: Occurrence | null;
		raw: Event | TimeSlot | Task;
	}[] = [
		...filterEvents(input.events ?? [], { includeDeclined: true }).map(
			(raw) => ({ occurrence: normalizeEvent(raw), raw }),
		),
		...(input.slots ?? []).map((raw) => ({
			occurrence: normalizeSlot(raw),
			raw,
		})),
		...(input.tasks ?? []).map((raw) => ({
			occurrence: normalizeTask(raw),
			raw,
		})),
	];
	return candidates
		.filter((pair): pair is OccurrenceWithRaw => {
			const o = pair.occurrence;
			if (!o || o.deleted) return false;
			if (
				(!query.includeCancelled && o.cancelled) ||
				(!query.includeDone && o.done) ||
				(!query.includeTrashed && o.trashed) ||
				(!query.includeDeclined && o.declined)
			)
				return false;
			if (query.accountId !== undefined && o.accountId !== query.accountId)
				return false;
			if (
				query.connectorId !== undefined &&
				o.connectorId !== query.connectorId
			)
				return false;
			if (query.calendarId !== undefined && o.calendarId !== query.calendarId)
				return false;
			if (
				query.activeCalendarIds &&
				(o.calendarId === null ||
					!query.activeCalendarIds.includes(o.calendarId))
			)
				return false;
			if (
				query.calendarId === undefined &&
				query.calendarIds &&
				(o.calendarId === null || !query.calendarIds.includes(o.calendarId))
			)
				return false;
			if ((query.allDayOnly && !o.allDay) || (query.excludeAllDay && o.allDay))
				return false;
			const point = !o.end || o.end.getTime() === o.start.getTime();
			if (
				query.from &&
				(point ? o.start < query.from : (o.end ?? o.start) <= query.from)
			)
				return false;
			if (query.to && o.start >= query.to) return false;
			return true;
		})
		.sort(
			(a, b) => a.occurrence.start.getTime() - b.occurrence.start.getTime(),
		);
}

export interface OccurrenceWithRaw {
	occurrence: Occurrence;
	raw: Event | TimeSlot | Task;
}
export function queryOccurrences(
	input: OccurrenceInputs,
	query: OccurrenceQuery = {},
): Occurrence[] {
	return queryOccurrencesWithRaw(input, query).map((pair) => pair.occurrence);
}
/** Immutable observation metadata; pending overlays are reserved for workstream D. */
export function attachProvenance(
	occurrences: readonly Occurrence[],
	metadata: { observedAt: string | null; generation: string | null },
): Occurrence[] {
	return occurrences.map((o) => ({
		...o,
		provenance: { ...o.provenance, ...metadata, pending: false },
	}));
}
