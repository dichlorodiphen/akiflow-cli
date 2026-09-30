import { readFile } from "node:fs/promises";
import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import type {
	CreateEventPayload,
	Event,
	EventModifierPayload,
} from "../lib/api/types";
import {
	readResource,
	refreshResource,
	upsertResourceRecords,
} from "../lib/cache";
import {
	createDateTimeUTC,
	getLocalTimezone,
	parseDate,
	parseTime,
} from "../lib/date-parser";
import { parseDurationToSeconds } from "../lib/duration-parser";
import { createEventCommand } from "./create";

type MutableEvent = Record<string, unknown>;

const ATTENDEE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(message: string): never {
	console.error(`Error: ${message}`);
	process.exit(1);
}

function resolveDateInput(dateInput: string | undefined): string {
	if (!dateInput) fail("Event update requires --date");

	const parsed = parseDate(dateInput);
	if (!parsed) fail(`Could not parse date "${dateInput}"`);

	return parsed;
}

function resolveTimeInput(date: string, timeInput: string | undefined): string {
	if (!timeInput) fail("Event update requires --at");

	const parsedTime = parseTime(timeInput);
	if (!parsedTime) {
		fail(
			`Invalid time format "${timeInput}". Expected format: HH:MM (e.g., 21:00, 14:30)`,
		);
	}

	return createDateTimeUTC(date, parsedTime.hours, parsedTime.minutes);
}

async function resolveDescription(
	description: string | undefined,
	descriptionFile: string | undefined,
	fallback: string | null,
): Promise<string> {
	if (description && descriptionFile) {
		fail("Use either --description or --description-file, not both");
	}

	if (descriptionFile) {
		try {
			return await readFile(descriptionFile, "utf-8");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			fail(`Could not read description file "${descriptionFile}": ${message}`);
		}
	}

	return description ?? fallback ?? "";
}

export function resolveCachedEvent(events: Event[], identifier: string): Event {
	const exact = events.find((event) => event.id === identifier);
	if (exact) return exact;

	const matches = events.filter((event) => event.id.startsWith(identifier));
	const [match] = matches;
	if (matches.length === 1 && match) return match;
	if (matches.length > 1) {
		fail(
			`Event id prefix "${identifier}" is ambiguous (${matches
				.map((event) => event.id)
				.join(", ")}). Use a longer id.`,
		);
	}

	fail(
		`Event "${identifier}" was not found in the Akiflow event cache. Run af refresh and try again.`,
	);
}

export function validateMutableTimedGoogleEvent(event: Event): void {
	if (event.deleted_at) fail(`Event "${event.id}" is deleted`);
	if (event.hidden) fail(`Event "${event.id}" is hidden`);
	if (event.read_only) fail(`Event "${event.id}" is read-only`);
	if (event.connector_id !== "google") {
		fail(
			`af event supports Google calendar events only in v1. Event "${event.id}" uses connector "${event.connector_id}".`,
		);
	}
	if (
		event.start_date ||
		event.end_date ||
		!event.start_time ||
		!event.end_time
	) {
		fail(`Event "${event.id}" is all-day or missing timed start/end fields`);
	}
	if (
		event.recurring_id ||
		event.origin_recurring_id ||
		(Array.isArray(event.recurrence)
			? event.recurrence.length > 0
			: event.recurrence) ||
		event.recurrence_exception
	) {
		fail(
			`Event "${event.id}" is recurring; recurring event updates are not implemented in v1`,
		);
	}
}

function cloneEventForUpdate(event: Event): MutableEvent {
	const payload: MutableEvent = { ...event };
	delete payload.data;
	delete payload.fingerprints;
	delete payload.user_id;
	return payload;
}

function eventOperationBase(event: Event): Record<string, unknown> {
	const base: Record<string, unknown> = {
		title: event.title ?? "",
		description: event.description ?? "",
		start_time: event.start_time,
		end_time: event.end_time,
		start_datetime_tz: event.start_datetime_tz,
	};
	if (event.end_datetime_tz) base.end_datetime_tz = event.end_datetime_tz;

	const location = event.content?.location;
	if (typeof location === "string" && location.trim()) {
		base.location = location.trim();
	}
	if ((event.attendees ?? []).length > 0) base.attendees = event.attendees;
	if (
		Array.isArray(event.recurrence)
			? event.recurrence.length > 0
			: event.recurrence
	) {
		base.recurrence = event.recurrence;
	}

	return base;
}

export interface BuildEventUpdatePayloadInput {
	event: Event;
	title?: string;
	description: string;
	location?: string;
	startTime: string;
	endTime: string;
	timezone?: string;
	now?: string;
}

export function buildEventUpdatePayload({
	event,
	title,
	description,
	location,
	startTime,
	endTime,
	timezone = getLocalTimezone(),
	now = new Date().toISOString(),
}: BuildEventUpdatePayloadInput): CreateEventPayload {
	const payload = cloneEventForUpdate(event);
	const content =
		event.content && typeof event.content === "object"
			? { ...event.content }
			: {};

	content.sendUpdates = "all";
	if (location !== undefined) {
		if (location.trim()) content.location = location.trim();
		else delete content.location;
	}

	payload.title = title ?? event.title ?? "";
	payload.description = description;
	payload.start_time = startTime;
	payload.end_time = endTime;
	payload.start_datetime_tz = timezone;
	payload.end_datetime_tz = timezone;
	payload.start_date = null;
	payload.end_date = null;
	payload.content = content;
	payload.global_updated_at = now;
	Object.defineProperty(payload, "event_operation_base", {
		value: eventOperationBase(event),
		enumerable: false,
		configurable: false,
		writable: false,
	});

	return payload as unknown as CreateEventPayload;
}

export function buildEventDeletePayload({
	event,
	notify = "all",
	now = new Date().toISOString(),
}: {
	event: Event;
	notify?: "all" | "none";
	now?: string;
}): CreateEventPayload {
	const payload = cloneEventForUpdate(event);
	const content =
		event.content && typeof event.content === "object"
			? { ...event.content }
			: {};

	content.sendUpdates = notify;
	payload.status = "cancelled";
	payload.content = content;
	payload.deleted_at = now;
	payload.global_updated_at = now;

	return payload as unknown as CreateEventPayload;
}

function normalizeEmail(value: string): string {
	return value.trim().toLowerCase();
}

function attendeeEmail(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const email = (value as { email?: unknown }).email;
	if (typeof email !== "string") return null;
	const normalized = normalizeEmail(email);
	return normalized || null;
}

export function existingAttendeeEmails(event: Event): Set<string> {
	return new Set(
		(event.attendees ?? [])
			.map(attendeeEmail)
			.filter((email): email is string => email != null),
	);
}

export function collectAttendeeEmails(args: Record<string, unknown>): string[] {
	const positional = Array.isArray(args._) ? [...args._] : [];
	if (
		positional.length > 0 &&
		normalizeEmail(String(positional[0])) ===
			normalizeEmail(String(args.id ?? ""))
	) {
		positional.shift();
	}
	if (
		positional.length > 0 &&
		normalizeEmail(String(positional[0])) ===
			normalizeEmail(String(args.email ?? ""))
	) {
		positional.shift();
	}

	const rawValues = [args.email, ...positional].flatMap((value) => {
		if (value == null) return [];
		return Array.isArray(value) ? value : [value];
	});
	const emails = rawValues
		.map((value) => normalizeEmail(String(value)))
		.filter(Boolean);
	const uniqueEmails = [...new Set(emails)];
	const invalid = uniqueEmails.filter(
		(email) => !ATTENDEE_EMAIL_RE.test(email),
	);

	if (invalid.length > 0) {
		fail(
			`Invalid attendee email${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}`,
		);
	}

	if (uniqueEmails.length === 0)
		fail("At least one attendee email is required");

	return uniqueEmails;
}

export function buildAttendeeModifierPayload({
	event,
	add,
	remove,
	now = new Date().toISOString(),
	id = crypto.randomUUID(),
}: {
	event: Event;
	add: string[];
	remove: string[];
	now?: string;
	id?: string;
}): EventModifierPayload {
	const content: EventModifierPayload["content"] = {
		attendeeEmailsToAdd: add,
		attendeeEmailsToRemove: remove,
		sendUpdates: "all",
	};

	if (add.length > 0) {
		content.attendeeResponseStatusesByEmail = Object.fromEntries(
			add.map((email) => [email, "needsAction"]),
		);
	}

	return {
		id,
		akiflow_account_id: event.akiflow_account_id ?? null,
		event_id: event.id,
		calendar_id: event.calendar_id,
		action: "attendees/updateList",
		content,
		processed_at: null,
		failed_at: null,
		result: null,
		attempts: 0,
		global_created_at: now,
		deleted_at: null,
		global_updated_at: now,
	};
}

function formatLocalTime(instant: string): string {
	return new Date(instant).toLocaleString([], {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export const eventUpdateCommand = defineCommand({
	meta: {
		name: "update",
		description: "Update timing and basic fields for a timed Google event",
	},
	args: {
		id: {
			type: "positional",
			description: "Event id or unique id prefix",
			required: true,
		},
		date: {
			type: "string",
			description: "Event date (YYYY-MM-DD or natural language)",
			required: true,
			alias: "d",
		},
		at: {
			type: "string",
			description: "Local start time (e.g., '09:30')",
			required: true,
		},
		duration: {
			type: "string",
			description: "Event duration (e.g., '30m', '1h')",
			required: true,
		},
		title: {
			type: "string",
			description: "New event title",
		},
		description: {
			type: "string",
			description: "New event description",
		},
		"description-file": {
			type: "string",
			description: "Read event description from a UTF-8 text file",
		},
		location: {
			type: "string",
			description: "New event location; pass an empty value to clear",
		},
		json: {
			type: "boolean",
			description: "Output updated event as JSON",
		},
	},
	run: async (context) => {
		const client = createClient();
		const args = context.args as Record<string, unknown>;
		// Refresh events first so the update's operation base is built from the
		// latest server state. Without this, back-to-back updates build the
		// second operation from stale cache and the server silently drops it.
		await refreshResource(client, "events");
		const events = await readResource(client, "events");
		const event = resolveCachedEvent(events, args.id as string);
		validateMutableTimedGoogleEvent(event);

		const date = resolveDateInput(args.date as string | undefined);
		const startTime = resolveTimeInput(date, args.at as string | undefined);
		let durationSeconds: number;
		try {
			durationSeconds = parseDurationToSeconds(args.duration as string);
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error));
		}
		const endTime = new Date(
			new Date(startTime).getTime() + durationSeconds * 1000,
		).toISOString();
		const description = await resolveDescription(
			args.description as string | undefined,
			args["description-file"] as string | undefined,
			event.description,
		);
		const payload = buildEventUpdatePayload({
			event,
			title: args.title as string | undefined,
			description,
			location: args.location as string | undefined,
			startTime,
			endTime,
		});

		const response = await client.createEvents([payload]);
		const updatedEvent = response.data[0];
		if (!updatedEvent) fail("Failed to update event - no data returned");

		// Write-through: cache the server's returned state so a follow-up
		// update builds its operation base from the just-applied change, even
		// when the sync endpoint has not caught up with the write endpoint.
		if (updatedEvent.id && updatedEvent.start_time) {
			await upsertResourceRecords("events", [updatedEvent]);
		}

		if (args.json === true) {
			console.log(JSON.stringify(updatedEvent, null, 2));
			return;
		}

		console.log("✓ Akiflow calendar event updated successfully");
		console.log(`  ID: ${updatedEvent.id}`);
		console.log(`  Title: ${updatedEvent.title ?? payload.title}`);
		console.log(`  Calendar: ${updatedEvent.calendar_id ?? event.calendar_id}`);
		console.log(`  Time: ${formatLocalTime(startTime)} (${args.duration})`);
	},
});

export const eventDeleteCommand = defineCommand({
	meta: {
		name: "delete",
		description: "Soft-delete a timed Google calendar event",
	},
	args: {
		id: {
			type: "positional",
			description: "Event id or unique id prefix",
			required: true,
		},
		notify: {
			type: "string",
			description: "Google attendee notification mode: all or none",
			default: "all",
		},
		json: {
			type: "boolean",
			description: "Output deleted event as JSON",
		},
	},
	run: async (context) => {
		const client = createClient();
		const args = context.args as Record<string, unknown>;
		const notify = String(args.notify ?? "all");
		if (notify !== "all" && notify !== "none") {
			fail(`Invalid --notify "${notify}". Expected "all" or "none".`);
		}

		const events = await readResource(client, "events");
		const event = resolveCachedEvent(events, args.id as string);
		validateMutableTimedGoogleEvent(event);

		const payload = buildEventDeletePayload({ event, notify });
		const response = await client.createEvents([payload]);
		const deletedEvent = response.data[0];
		if (!deletedEvent) fail("Failed to delete event - no data returned");

		if (args.json === true) {
			console.log(JSON.stringify(deletedEvent, null, 2));
			return;
		}

		console.log("✓ Akiflow calendar event deleted successfully");
		console.log(`  ID: ${deletedEvent.id}`);
		console.log(`  Title: ${deletedEvent.title ?? event.title ?? ""}`);
		console.log(`  Notify: ${notify}`);
	},
});

async function runAttendeeCommand(
	args: Record<string, unknown>,
	mode: "add" | "remove",
): Promise<void> {
	const client = createClient();
	const events = await readResource(client, "events");
	const event = resolveCachedEvent(events, args.id as string);
	validateMutableTimedGoogleEvent(event);

	const requested = collectAttendeeEmails(args);
	const existing = existingAttendeeEmails(event);
	const toChange =
		mode === "add"
			? requested.filter((email) => !existing.has(email))
			: requested.filter((email) => existing.has(email));

	if (toChange.length === 0) {
		const message =
			mode === "add"
				? "No attendees to add; all requested emails are already present."
				: "No attendees to remove; none of the requested emails are present.";
		if (args.json === true) {
			console.log(
				JSON.stringify(
					{
						event_id: event.id,
						action: mode,
						requested: requested.length,
						changed: 0,
						message,
					},
					null,
					2,
				),
			);
			return;
		}
		console.log(message);
		return;
	}

	const payload = buildAttendeeModifierPayload({
		event,
		add: mode === "add" ? toChange : [],
		remove: mode === "remove" ? toChange : [],
	});
	const response = await client.createEventModifiers([payload]);
	const modifier = response.data[0];
	if (!modifier) fail("Failed to update attendees - no data returned");

	if (args.json === true) {
		console.log(JSON.stringify(modifier, null, 2));
		return;
	}

	console.log(
		`✓ Akiflow calendar event attendee${toChange.length === 1 ? "" : "s"} ${mode === "add" ? "added" : "removed"} successfully`,
	);
	console.log(`  Event: ${event.id}`);
	console.log(
		`  ${mode === "add" ? "Added" : "Removed"}: ${toChange.join(", ")}`,
	);
}

export const attendeeAddCommand = defineCommand({
	meta: {
		name: "add",
		description: "Add attendee emails to a timed Google event",
	},
	args: {
		id: {
			type: "positional",
			description: "Event id or unique id prefix",
			required: true,
		},
		email: {
			type: "positional",
			description: "Attendee email; additional emails may follow",
			required: true,
		},
		json: {
			type: "boolean",
			description: "Output modifier as JSON",
		},
	},
	run: async (context) => {
		await runAttendeeCommand(context.args as Record<string, unknown>, "add");
	},
});

export const attendeeRemoveCommand = defineCommand({
	meta: {
		name: "remove",
		description: "Remove attendee emails from a timed Google event",
	},
	args: {
		id: {
			type: "positional",
			description: "Event id or unique id prefix",
			required: true,
		},
		email: {
			type: "positional",
			description: "Attendee email; additional emails may follow",
			required: true,
		},
		json: {
			type: "boolean",
			description: "Output modifier as JSON",
		},
	},
	run: async (context) => {
		await runAttendeeCommand(context.args as Record<string, unknown>, "remove");
	},
});

const eventAttendeesCommand = defineCommand({
	meta: {
		name: "attendees",
		description: "Manage attendee emails on timed Google events",
	},
	subCommands: {
		add: attendeeAddCommand,
		remove: attendeeRemoveCommand,
	},
});

export const eventCommand = defineCommand({
	meta: {
		name: "event",
		description: "Manage timed Google calendar events through Akiflow",
	},
	subCommands: {
		create: createEventCommand,
		update: eventUpdateCommand,
		delete: eventDeleteCommand,
		attendees: eventAttendeesCommand,
	},
});
