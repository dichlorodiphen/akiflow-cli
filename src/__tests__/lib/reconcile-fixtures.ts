import type { Calendar, Event } from "../../lib/api/types";
import { buildReconcileReport } from "../../lib/reconcile/diff";
import type {
	GoogleEvent,
	GoogleObservation,
} from "../../lib/reconcile/google-reader";
import {
	normalizeAkiflow,
	normalizeGoogle,
} from "../../lib/reconcile/normalize";
import type { Sources } from "../../lib/reconcile/types";
import { resolveReconcileWindow } from "../../lib/reconcile/window";

export const calendar = {
	id: "personal",
	origin_id: "dichlorodiphen@gmail.com",
	connector_id: "google",
	title: "Personal",
	timezone: "America/Los_Angeles",
	deleted_at: null,
	hidden_at: null,
	akiflow_account_id: "account",
} as Calendar;
export const workCalendar = {
	...calendar,
	id: "work",
	origin_id: "david.young@databricks.com",
	title: "Work",
};
export const now = new Date("2026-10-01T05:00:00Z");
export const window = resolveReconcileWindow(
	{ date: "2026-09-30" },
	now,
	"America/Los_Angeles",
);
export const selected = [calendar.origin_id, workCalendar.origin_id];
export function af(id = "a1", overrides: Partial<Event> = {}): Event {
	return {
		id,
		calendar_id: calendar.id,
		title: "Study",
		start_time: "2026-10-01T02:30:00Z",
		end_time: "2026-10-01T04:30:00Z",
		origin_id: "g1",
		deleted_at: null,
		hidden: false,
		declined: false,
		read_only: false,
		status: "confirmed",
		recurring_id: null,
		recurrence: null,
		recurrence_exception: false,
		recurrence_exception_delete: null,
		start_date: null,
		end_date: null,
		...overrides,
	} as Event;
}
export function ge(
	id = "g1",
	overrides: Partial<GoogleEvent> = {},
): GoogleEvent {
	return {
		id,
		summary: "Study",
		status: "confirmed",
		start: { dateTime: "2026-10-01T02:30:00Z" },
		end: { dateTime: "2026-10-01T04:30:00Z" },
		...overrides,
	};
}
export function observation(
	events: GoogleEvent[],
	calendarId = calendar.origin_id,
): GoogleObservation {
	return {
		calendar_id: calendarId,
		timezone: calendar.timezone,
		events,
		not_found_ids: [],
		metadata: {
			calendar_id: calendarId,
			read_start: now.toISOString(),
			read_end: now.toISOString(),
			complete: true,
			pages: 1,
			identity_probes: 0,
		},
	};
}
export function sources(available = true): Sources {
	return {
		atomic: false,
		akiflow: {
			mode: "fresh_full",
			read_start: now.toISOString(),
			read_end: now.toISOString(),
			complete: true,
			pages: { events: 1, calendars: 1 },
		},
		cache: {
			availability: available ? "available" : "unavailable",
			generation: available ? "gen-1" : null,
			captured_at: now.toISOString(),
			resource_timestamps: {
				events: now.toISOString(),
				calendars: now.toISOString(),
			},
			events_age_seconds: 0,
		},
		google: [],
	};
}
export function normalizedA(
	events: Event[],
	observation: "server" | "cache" = "server",
	calendars = [calendar, workCalendar],
) {
	return normalizeAkiflow(
		events,
		calendars,
		window,
		selected,
		observation,
		now.toISOString(),
	);
}
export function normalizedG(
	events: GoogleEvent[],
	calendarId = calendar.origin_id,
) {
	return normalizeGoogle(
		[observation(events, calendarId)],
		[calendar, workCalendar],
		window,
	);
}
export function report(
	server: Event[],
	google: GoogleEvent[],
	cache: Event[] = [],
	available = true,
) {
	return buildReconcileReport({
		records: [
			...normalizedA(server),
			...normalizedA(cache, "cache"),
			...normalizedG(google),
		],
		window,
		selected,
		now,
		sources: sources(available),
	});
}
