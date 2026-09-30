import type { Event, Task, TimeSlot } from "../../lib/api/types";
import {
	normalizeEvent,
	type OccurrenceReadFields,
} from "../../lib/occurrence";

export const instant = (hour: number) => new Date(Date.UTC(2026, 5, 20, hour));
export function event(overrides: Partial<Event> = {}): Event {
	return {
		id: "e",
		title: "Event",
		start_time: instant(9).toISOString(),
		end_time: instant(10).toISOString(),
		start_date: null,
		end_date: null,
		status: "confirmed",
		declined: false,
		hidden: false,
		deleted_at: null,
		recurring_id: null,
		origin_recurring_id: null,
		original_start_time: null,
		original_start_date: null,
		recurrence_exception: false,
		task_id: null,
		time_slot_id: null,
		calendar_id: "cal",
		akiflow_account_id: "account",
		connector_id: "google",
		origin_id: null,
		origin_account_id: null,
		...overrides,
	} as Event;
}
export function slot(
	overrides: Partial<TimeSlot & OccurrenceReadFields> = {},
): TimeSlot & OccurrenceReadFields {
	return {
		id: "s",
		title: "Slot",
		start_time: instant(9).toISOString(),
		end_time: instant(10).toISOString(),
		deleted_at: null,
		recurring_id: null,
		original_start_time: null,
		calendar_id: "cal",
		akiflow_account_id: "account",
		connector_id: "google",
		...overrides,
	} as TimeSlot & OccurrenceReadFields;
}
export function task(
	overrides: Partial<Task & OccurrenceReadFields> = {},
): Task & OccurrenceReadFields {
	return {
		id: "t",
		title: "Task",
		datetime: instant(9).toISOString(),
		duration: 3600,
		done: false,
		trashed_at: null,
		deleted_at: null,
		recurring_id: null,
		time_slot_id: null,
		calendar_id: "cal",
		akiflow_account_id: "account",
		connector_id: "google",
		origin_id: null,
		origin_account_id: null,
		...overrides,
	} as Task & OccurrenceReadFields;
}
export const occurrence = (overrides: Partial<Event> = {}) =>
	normalizeEvent(event(overrides))!;
