import type { Calendar, Event } from "../api/types";
import { resolveCalendarFromList } from "../calendar";
import { filterEvents } from "../filters/event";
import { expandRecurringEvents } from "../recurrence-expansion";
import { parseCalendarDate, validateTimezone } from "../timezone";
import type { GoogleEvent, GoogleObservation } from "./google-reader";
import {
	ReconcileError,
	type ReconcileRecord,
	type ReconcileWindow,
	type RecordTime,
} from "./types";
import { addCalendarDays, intersectsWindow } from "./window";

export const DEFAULT_RECONCILE_CALENDARS = ["dichlorodiphen@gmail.com"];
// 2026-10-01: David decided personal-only. The work Google account cannot be
// linked to the Hatch connector and the work calendar is no longer shared
// with the personal identity, so the default must not include
// david.young@databricks.com (its Google read 404s and fails the run).
// Revisit if he shares the work calendar with the personal account; the
// --calendar flag still selects any calendar explicitly.

export function selectCalendars(
	calendars: Calendar[],
	input?: string,
): string[] {
	for (const calendar of calendars) {
		if (!calendar || typeof calendar.id !== "string" || !calendar.id)
			throw new ReconcileError("Malformed Akiflow calendar");
	}
	if (!input) return [...DEFAULT_RECONCILE_CALENDARS];
	try {
		const calendar = resolveCalendarFromList(calendars, input, {
			includeHidden: true,
		});
		if (calendar.connector_id !== "google" || !calendar.origin_id)
			throw new Error("Selected calendar has no Google calendar mapping");
		return [calendar.origin_id];
	} catch (error) {
		throw new ReconcileError(
			error instanceof Error ? error.message : String(error),
			2,
			"invalid_calendar",
		);
	}
}

export function recordRef(
	side: ReconcileRecord["side"],
	observation: ReconcileRecord["observation"],
	calendar: string,
	id: string,
): string {
	return `${side}:${observation}:${encodeURIComponent(calendar)}:${encodeURIComponent(id)}`;
}

export function instant(value: string): string {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
		!Number.isFinite(Date.parse(value))
	)
		throw new ReconcileError(`Invalid provider instant: ${value}`);
	parseCalendarDate(value.slice(0, 10));
	return new Date(value).toISOString();
}

/** A composite suffix is evidence only in a corroborated recurring series. */
export function parseCompositeId(
	id: string,
	recurrenceEvidence: boolean,
): { base: string; anchor: string } | null {
	if (!recurrenceEvidence) return null;
	const match = /^(.*)_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(id);
	if (!match?.[1]) return null;
	try {
		const date = `${match[2]}-${match[3]}-${match[4]}`;
		parseCalendarDate(date);
		if (Number(match[5]) > 23 || Number(match[6]) > 59 || Number(match[7]) > 59)
			return null;
		return {
			base: match[1],
			anchor: instant(`${date}T${match[5]}:${match[6]}:${match[7]}Z`),
		};
	} catch {
		return null;
	}
}

function checkedTime(time: RecordTime): RecordTime {
	if (time.kind === "all_day") {
		parseCalendarDate(time.start_date);
		parseCalendarDate(time.end_date_exclusive);
		if (time.end_date_exclusive <= time.start_date)
			throw new ReconcileError("Invalid provider all-day interval");
	} else if (time.kind === "timed" && time.end && time.end < time.start)
		throw new ReconcileError("Invalid provider timed interval");
	return time;
}

function akiflowTime(event: Event, evidence: boolean): RecordTime {
	if (event.start_date != null)
		return checkedTime({
			kind: "all_day",
			start_date: event.start_date,
			end_date_exclusive: addCalendarDays(
				event.end_date ?? event.start_date,
				1,
			),
		});
	if (event.start_time)
		return checkedTime({
			kind: "timed",
			start: instant(event.start_time),
			end: event.end_time ? instant(event.end_time) : null,
		});
	if (evidence) return { kind: "unknown" };
	throw new ReconcileError(
		`Active Akiflow event ${event.id} has no valid time`,
	);
}

function googleTime(event: GoogleEvent, evidence: boolean): RecordTime {
	if (event.start?.date)
		return checkedTime({
			kind: "all_day",
			start_date: event.start.date,
			end_date_exclusive:
				event.end?.date ??
				(evidence ? addCalendarDays(event.start.date, 1) : ""),
		});
	if (event.start?.dateTime)
		return checkedTime({
			kind: "timed",
			start: instant(event.start.dateTime),
			end: event.end?.dateTime ? instant(event.end.dateTime) : null,
		});
	if (evidence) return { kind: "unknown" };
	throw new ReconcileError(`Active Google event ${event.id} has no valid time`);
}

export function normalizeAkiflow(
	events: Event[],
	calendars: Calendar[],
	window: ReconcileWindow,
	selected: string[],
	observation: "server" | "cache",
	observedAt: string | null,
	explicitCalendar = false,
	freshMasters = events,
): ReconcileRecord[] {
	// Retain all exception evidence, including existing virtual slots, but never
	// expand a synthetic master if this input has already been expanded.
	const evidence = events.filter(
		(event) =>
			!event.id.startsWith("virtual:") || event.recurring_id !== event.id,
	);
	const expanded = [
		...events,
		...expandRecurringEvents(
			events,
			new Date(window.start),
			new Date(window.end),
			evidence,
		),
	];
	const visible = new Set(
		filterEvents(expanded, { includeDeclined: true }).map((event) => event.id),
	);
	const byId = new Map(calendars.map((calendar) => [calendar.id, calendar]));
	const masters = new Map(freshMasters.map((event) => [event.id, event]));
	return expanded.map((event) => {
		if (event.calendar_id != null && typeof event.calendar_id !== "string")
			throw new ReconcileError(
				`Malformed Akiflow calendar identity for ${event.id}`,
			);
		const cancellation =
			event.deleted_at != null ||
			event.status === "cancelled" ||
			!!event.recurrence_exception_delete;
		if (
			(typeof event.calendar_id !== "string" || !event.calendar_id) &&
			!cancellation
		)
			throw new ReconcileError(
				`Akiflow event ${event.id} has no calendar identity`,
			);
		if (event.origin_id != null && typeof event.origin_id !== "string")
			throw new ReconcileError(`Malformed Akiflow provider ID for ${event.id}`);
		if (
			event.status != null &&
			!["confirmed", "tentative", "cancelled"].includes(event.status)
		)
			throw new ReconcileError(`Malformed Akiflow status for ${event.id}`);
		if (event.title != null && typeof event.title !== "string")
			throw new ReconcileError(`Malformed Akiflow title for ${event.id}`);
		const calendarId = event.calendar_id ?? "";
		const calendar = byId.get(calendarId);
		const key =
			calendar?.connector_id === "google" && calendar.origin_id
				? calendar.origin_id
				: null;
		const timezone = validateTimezone(calendar?.timezone || window.timezone);
		let state: ReconcileRecord["state"] = "active";
		let reason: string | null = null;
		if (event.deleted_at != null) state = "deleted";
		else if (event.status === "cancelled" || event.recurrence_exception_delete)
			state = "cancelled";
		else if (event.declined) state = "declined";
		else if (!visible.has(event.id)) {
			state = "hidden";
			reason = "hidden_record";
		} else if (calendar?.deleted_at != null) {
			state = "excluded";
			reason = "deleted_calendar";
		} else if (calendar?.hidden_at != null && !explicitCalendar) {
			state = "excluded";
			reason = "hidden_calendar";
		} else if (!key) {
			state = "excluded";
			reason = "unmapped_calendar";
		} else if (!selected.includes(key)) {
			state = "excluded";
			reason = "unselected_calendar";
		}
		const content = event.content as
			| { event_type?: string; eventType?: string }
			| undefined;
		const eventType = content?.event_type ?? content?.eventType ?? null;
		if (state === "active" && eventType === "workingLocation") {
			state = "excluded";
			reason = "working_location";
		}
		const time = akiflowTime(
			event,
			state === "cancelled" || state === "deleted",
		);
		const master = event.recurring_id
			? masters.get(event.recurring_id)
			: undefined;
		const recurrent = !!(
			event.origin_recurring_id ||
			event.recurring_id ||
			event.recurrence?.length ||
			master?.recurrence?.length
		);
		const composite = event.origin_id
			? parseCompositeId(event.origin_id, recurrent)
			: null;
		const masterComposite = master?.origin_id
			? parseCompositeId(master.origin_id, recurrent)
			: null;
		const series =
			event.origin_recurring_id ||
			composite?.base ||
			(master?.origin_id
				? (masterComposite?.base ?? master.origin_id)
				: null) ||
			(recurrent ? event.origin_id : null);
		let anchor = event.original_start_time
			? instant(event.original_start_time)
			: (event.original_start_date ?? composite?.anchor ?? null);
		let anchorKind: "instant" | "date" | null =
			event.original_start_time || composite?.anchor
				? "instant"
				: event.original_start_date
					? "date"
					: null;
		let provisional = false;
		if (
			!anchor &&
			series &&
			!event.recurrence_exception &&
			time.kind !== "unknown"
		) {
			anchor = time.kind === "timed" ? time.start : time.start_date;
			anchorKind = time.kind === "timed" ? "instant" : "date";
			provisional = true;
		}
		if (anchorKind === "date" && anchor) parseCalendarDate(anchor);
		return {
			ref: recordRef("akiflow", observation, calendarId, event.id),
			side: "akiflow",
			observation,
			id: event.id,
			calendar: {
				key,
				source_id: calendarId,
				akiflow_id: calendarId || null,
				google_id: key,
				account_id:
					event.akiflow_account_id ?? calendar?.akiflow_account_id ?? null,
				title: calendar?.title ?? null,
				timezone,
			},
			title: event.title ?? null,
			time,
			source_time: {
				calendar_timezone: calendar?.timezone ?? null,
				start_timezone: event.start_datetime_tz ?? null,
				end_timezone: event.end_datetime_tz ?? null,
				start_time: event.start_time ?? null,
				end_time: event.end_time ?? null,
				start_date: event.start_date ?? null,
				end_date: event.end_date ?? null,
				original_start_time: event.original_start_time ?? null,
				original_start_date: event.original_start_date ?? null,
			},
			state,
			exclusion_reason: reason,
			in_window: intersectsWindow(time, window, timezone),
			identity: {
				origin_id: event.origin_id ?? null,
				series_id: series,
				anchor,
				anchor_kind: anchorKind,
				provisional_anchor: provisional,
			},
			is_series_master:
				event.recurring_id === event.id ||
				!!(event.recurrence?.length && !event.recurring_id && !composite),
			read_only: event.read_only ?? null,
			event_type: eventType,
			observed_at: observedAt,
		};
	});
}

export function normalizeGoogle(
	observations: GoogleObservation[],
	calendars: Calendar[],
	window: ReconcileWindow,
): ReconcileRecord[] {
	return observations.flatMap((source) => {
		const calendar = calendars.find(
			(value) =>
				value.origin_id === source.calendar_id &&
				value.connector_id === "google" &&
				value.deleted_at == null,
		);
		const timezone = validateTimezone(
			source.timezone || calendar?.timezone || window.timezone,
		);
		return source.events.map((event) => {
			if (
				event.status != null &&
				!["confirmed", "tentative", "cancelled"].includes(event.status)
			)
				throw new ReconcileError(`Malformed Google status for ${event.id}`);
			if (event.summary != null && typeof event.summary !== "string")
				throw new ReconcileError(`Malformed Google title for ${event.id}`);
			if (event.attendees != null && !Array.isArray(event.attendees))
				throw new ReconcileError(`Malformed Google attendees for ${event.id}`);
			let state: ReconcileRecord["state"] =
				event.status === "cancelled"
					? "cancelled"
					: event.attendees?.some(
								(attendee) =>
									attendee.self && attendee.responseStatus === "declined",
							)
						? "declined"
						: "active";
			let reason: string | null = null;
			if (state === "active" && event.eventType === "workingLocation") {
				state = "excluded";
				reason = "working_location";
			}
			if (state === "active" && event.recurrence?.length) {
				state = "excluded";
				reason = "series_presence_only";
			}
			const time = googleTime(
				event,
				state === "cancelled" || reason === "series_presence_only",
			);
			const composite = parseCompositeId(event.id, !!event.recurringEventId);
			const anchor = event.originalStartTime?.dateTime
				? instant(event.originalStartTime.dateTime)
				: (event.originalStartTime?.date ?? composite?.anchor ?? null);
			const anchorKind = event.originalStartTime?.date
				? "date"
				: anchor
					? "instant"
					: null;
			if (anchorKind === "date" && anchor) parseCalendarDate(anchor);
			return {
				ref: recordRef("google", "server", source.calendar_id, event.id),
				side: "google",
				observation: "server",
				id: event.id,
				calendar: {
					key: source.calendar_id,
					source_id: source.calendar_id,
					akiflow_id: calendar?.id ?? null,
					google_id: source.calendar_id,
					account_id: calendar?.akiflow_account_id ?? null,
					title: calendar?.title ?? source.calendar_id,
					timezone,
				},
				title: event.summary ?? null,
				time,
				source_time: {
					calendar_timezone: source.timezone,
					start_timezone: event.start?.timeZone ?? null,
					end_timezone: event.end?.timeZone ?? null,
					original_start_timezone: event.originalStartTime?.timeZone ?? null,
					start_time: event.start?.dateTime ?? null,
					end_time: event.end?.dateTime ?? null,
					start_date: event.start?.date ?? null,
					end_date: event.end?.date ?? null,
					original_start_time: event.originalStartTime?.dateTime ?? null,
					original_start_date: event.originalStartTime?.date ?? null,
				},
				state,
				exclusion_reason: reason,
				in_window: intersectsWindow(time, window, timezone),
				identity: {
					origin_id: event.id,
					series_id:
						event.recurringEventId ??
						(event.recurrence?.length ? event.id : null),
					anchor,
					anchor_kind: anchorKind,
					provisional_anchor: false,
				},
				is_series_master: !!event.recurrence?.length,
				read_only: null,
				event_type: event.eventType ?? null,
				observed_at: source.metadata.read_end,
			} satisfies ReconcileRecord;
		});
	});
}

export function partitionRecords(records: ReconcileRecord[]) {
	return {
		active: records.filter(
			(record) => record.state === "active" && record.in_window,
		),
		evidence: records.filter((record) => record.state !== "active"),
		cancellations: records.filter(
			(record) => record.state === "cancelled" || record.state === "deleted",
		),
	};
}

/** Google's collection timezone is canonical for all-day inclusion on both sides. */
export function alignCalendarTimezones(
	records: ReconcileRecord[],
	observations: GoogleObservation[],
	window: ReconcileWindow,
): ReconcileRecord[] {
	const timezones = new Map(
		observations
			.filter((source) => source.timezone)
			.map((source) => [source.calendar_id, source.timezone as string]),
	);
	return records.map((record) => {
		const timezone = record.calendar.key
			? timezones.get(record.calendar.key)
			: undefined;
		if (!timezone) return record;
		validateTimezone(timezone);
		return {
			...record,
			calendar: { ...record.calendar, timezone },
			in_window: intersectsWindow(record.time, window, timezone),
		};
	});
}
