import { readFile } from "node:fs/promises";
import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import {
	buildDeleteEventOperation,
	buildPatchEventOperation,
	type EventSendUpdates,
	eventOperationRoute,
	eventTargetRejectionReason,
	InvalidEventTargetError,
	parseSendUpdates,
	providerEventPayload,
} from "../lib/api/event-intents";
import type { CreateEventPayload, Event } from "../lib/api/types";
import { isReadOnlyCanonical } from "../lib/api/types";
import { verifyEventAttendees } from "../lib/attendee-verification";
import { refreshResource, upsertResourceRecords } from "../lib/cache";
import {
	createDateTimeUTC,
	getLocalTimezone,
	parseDate,
	parseTime,
} from "../lib/date-parser";
import {
	dryRunArgs,
	mutationReader,
	previewItem,
	printDryRun,
} from "../lib/dry-run";
import { parseDurationToSeconds } from "../lib/duration-parser";
import { eventExpectedFields, outputMutation } from "../lib/mutation-output";
import {
	type VerificationResult,
	verifyEventDeleted,
	verifyEventFields,
} from "../lib/verification";
import { verificationOptions, verifyFlag } from "../lib/verify-flag";
import { createEventCommand } from "./create";

type MutableEvent = Record<string, unknown>;

const ATTENDEE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(message: string): never {
	console.error(`Error: ${message}`);
	process.exit(1);
}

/**
 * Parse a `--send-updates` flag value. Guest notifications default to `none`
 * (silent) per David's standing rule.
 */
export function resolveSendUpdatesFlag(
	value: unknown,
	flagName = "--send-updates",
): EventSendUpdates {
	const parsed = parseSendUpdates(value);
	if (!parsed) {
		fail(`Invalid ${flagName} "${value}". Expected "none" or "all".`);
	}
	return parsed;
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
	// Central target rejection (cancelled/deleted/read-only/hidden) with
	// precise reasons; the v1 capability limits below are CLI-specific.
	const targetReason = eventTargetRejectionReason(event);
	if (targetReason) fail(`Event "${event.id}": ${targetReason}`);
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
	sendUpdates?: EventSendUpdates;
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
	sendUpdates = "none",
	now = new Date().toISOString(),
}: BuildEventUpdatePayloadInput): CreateEventPayload {
	const payload = cloneEventForUpdate(event);
	const content =
		event.content && typeof event.content === "object"
			? { ...event.content }
			: {};

	content.sendUpdates = sendUpdates;
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

	return payload as unknown as CreateEventPayload;
}

export function buildEventDeletePayload({
	event,
	sendUpdates = "none",
	now = new Date().toISOString(),
}: {
	event: Event;
	sendUpdates?: EventSendUpdates;
	now?: string;
}): CreateEventPayload {
	const payload = cloneEventForUpdate(event);
	const content =
		event.content && typeof event.content === "object"
			? { ...event.content }
			: {};

	content.sendUpdates = sendUpdates;
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

export interface AttendeePatchIntent {
	/** Pre-edit provider fields (the operation base). */
	base: Record<string, unknown>;
	/** Desired provider fields: the full merged attendee list. */
	changes: Record<string, unknown>;
	sendUpdates: EventSendUpdates;
}

/**
 * Build an attendee-list patch as a v5 patch intent. Attendee edits ride the
 * supported v5 event_operations path (`operation: "patch"` with the full
 * merged attendee list in `changes`); the legacy `POST /v3/events/modifiers`
 * endpoint returns HTTP 410 and is no longer used.
 */
export function buildAttendeePatchIntent({
	event,
	add,
	remove,
	sendUpdates = "none",
}: {
	event: Event;
	add: string[];
	remove: string[];
	sendUpdates?: EventSendUpdates;
}): AttendeePatchIntent {
	const removeSet = new Set(remove.map(normalizeEmail));
	const kept = (event.attendees ?? []).filter((attendee) => {
		const email = attendeeEmail(attendee);
		return !email || !removeSet.has(email);
	});
	const added = add.map((email) => ({
		email: normalizeEmail(email),
		responseStatus: "needsAction",
	}));
	return {
		base: eventOperationBase(event),
		changes: { attendees: [...kept, ...added] },
		sendUpdates,
	};
}

export const eventUpdateCommand = defineCommand({
	meta: {
		name: "update",
		description: "Update timing and basic fields for a timed Google event",
	},
	args: {
		...dryRunArgs,
		id: {
			type: "positional",
			description: "Event id or unique id prefix",
			required: true,
		},
		date: {
			type: "string",
			description: "Event date (YYYY-MM-DD or natural language)",
			alias: "d",
		},
		at: {
			type: "string",
			description: "Local start time (e.g., '09:30')",
		},
		duration: {
			type: "string",
			description: "Event duration (e.g., '30m', '1h')",
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
		"send-updates": {
			type: "string",
			description: "Guest notification mode: none (default, silent) or all",
		},
		verify: verifyFlag,
		json: {
			type: "boolean",
			description: "Output versioned mutation receipts as JSON",
		},
	},
	run: async (context) => {
		const client = createClient();
		const args = context.args as Record<string, unknown>;
		const sendUpdates = resolveSendUpdatesFlag(args["send-updates"]);
		// Refresh events first so the update's operation base is built from the
		// latest server state. Without this, back-to-back updates build the
		// second operation from stale cache and the server silently drops it.
		if (!args["dry-run"]) await refreshResource(client, "events");
		const events = await mutationReader(args["dry-run"] === true)(
			client,
			"events",
		);
		const event = resolveCachedEvent(events, args.id as string);
		validateMutableTimedGoogleEvent(event);

		const observedStart = new Date(event.start_time as string);
		const observedDate = `${observedStart.getFullYear()}-${String(observedStart.getMonth() + 1).padStart(2, "0")}-${String(observedStart.getDate()).padStart(2, "0")}`;
		const date = args.date
			? resolveDateInput(args.date as string)
			: observedDate;
		const observedTime = `${String(observedStart.getHours()).padStart(2, "0")}:${String(observedStart.getMinutes()).padStart(2, "0")}`;
		const startTime =
			args.date || args.at
				? resolveTimeInput(
						date,
						(args.at as string | undefined) ?? observedTime,
					)
				: (event.start_time as string);
		let durationSeconds =
			(Date.parse(event.end_time as string) -
				Date.parse(event.start_time as string)) /
			1000;
		if (args.duration) {
			try {
				durationSeconds = parseDurationToSeconds(args.duration as string);
			} catch (error) {
				fail(error instanceof Error ? error.message : String(error));
			}
		}
		const endTime = new Date(
			Date.parse(startTime) + durationSeconds * 1000,
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
			timezone:
				args.date || args.at
					? getLocalTimezone()
					: (event.start_datetime_tz ?? getLocalTimezone()),
			sendUpdates,
		});

		if (args["dry-run"]) {
			printDryRun(
				[previewItem(event, payload, sendUpdates)],
				args.json === true,
			);
			return;
		}
		if (!args.date && !args.at && event.end_datetime_tz !== undefined) {
			payload.end_datetime_tz = event.end_datetime_tz;
		}

		// Explicit patch intent: the operation kind is fixed here, never
		// inferred from the payload's status/origin_id fields.
		const operation = buildPatchEventOperation(
			eventOperationRoute(event),
			eventOperationBase(event),
			providerEventPayload(payload),
			sendUpdates,
		);
		const response = await client.submitEventOperations([operation]);
		const receipt = response.receipts[0];
		const verifications = new Map<string, VerificationResult<Event>>();
		if (receipt?.status === "accepted" && args.verify === true) {
			const verification = await verifyEventFields(
				client,
				event.id,
				eventExpectedFields(payload),
				verificationOptions(),
			);
			if (isReadOnlyCanonical(verification.observed)) {
				verification.status = "mismatch";
				verification.differingFields = [
					...verification.differingFields,
					"read_only",
				];
				verification.error = `Event "${event.id}" is read-only; further mutations are refused`;
			}
			verifications.set(event.id, verification);
			if (
				verification.observed &&
				(verification.status === "verified" ||
					isReadOnlyCanonical(verification.observed))
			) {
				await upsertResourceRecords("events", [verification.observed]);
			}
		} else if (
			receipt?.status === "accepted" &&
			receipt.result &&
			typeof receipt.result === "object"
		) {
			// Only accepted server-returned fields can be merged onto the observed
			// base. Submitted desired fields are never cached as confirmation.
			const returned = receipt.result as Partial<Event>;
			if (returned.id === event.id) {
				await upsertResourceRecords("events", [
					{
						...event,
						...returned,
						...(isReadOnlyCanonical(event) ? { read_only: true } : {}),
					},
				]);
			}
		}
		outputMutation({
			command: "event update",
			json: args.json === true,
			receipts: response.receipts,
			verifications,
			result:
				verifications.get(event.id)?.status === "verified"
					? verifications.get(event.id)?.observed
					: null,
		});
	},
});

export const eventDeleteCommand = defineCommand({
	meta: {
		name: "delete",
		description: "Soft-delete a timed Google calendar event",
	},
	args: {
		...dryRunArgs,
		id: {
			type: "positional",
			description: "Event id or unique id prefix",
			required: true,
		},
		"send-updates": {
			type: "string",
			description: "Guest notification mode: none (default, silent) or all",
		},
		verify: verifyFlag,
		json: {
			type: "boolean",
			description: "Output versioned mutation receipts as JSON",
		},
	},
	run: async (context) => {
		const client = createClient();
		const args = context.args as Record<string, unknown>;
		const sendUpdates = resolveSendUpdatesFlag(args["send-updates"]);

		const events = await mutationReader(args["dry-run"] === true)(
			client,
			"events",
		);
		const event = resolveCachedEvent(events, args.id as string);
		validateMutableTimedGoogleEvent(event);

		const payload = buildEventDeletePayload({ event, sendUpdates });
		if (args["dry-run"]) {
			printDryRun(
				[previewItem(event, payload, sendUpdates)],
				args.json === true,
			);
			return;
		}
		// Explicit delete intent: the operation kind is fixed here, never
		// inferred from the payload's status/deleted_at fields.
		const operation = buildDeleteEventOperation(
			eventOperationRoute(event),
			sendUpdates,
		);
		const response = await client.submitEventOperations([operation]);
		const receipt = response.receipts[0];
		const verifications = new Map<string, VerificationResult<Event>>();
		if (receipt?.status === "accepted" && args.verify === true) {
			const verification = await verifyEventDeleted(
				client,
				event.id,
				verificationOptions(),
			);
			if (isReadOnlyCanonical(verification.observed)) {
				verification.status = "mismatch";
				verification.differingFields = [
					...verification.differingFields,
					"read_only",
				];
				verification.error = `Event "${event.id}" is read-only; further mutations are refused`;
			}
			verifications.set(event.id, verification);
			if (
				verification.observed &&
				(verification.status === "verified" ||
					isReadOnlyCanonical(verification.observed))
			) {
				await upsertResourceRecords("events", [verification.observed]);
			}
		}
		outputMutation({
			command: "event delete",
			json: args.json === true,
			receipts: response.receipts,
			verifications,
			result:
				verifications.get(event.id)?.status === "verified"
					? verifications.get(event.id)?.observed
					: null,
		});
	},
});

async function runAttendeeCommand(
	args: Record<string, unknown>,
	mode: "add" | "remove",
): Promise<void> {
	const client = createClient();
	const sendUpdates = resolveSendUpdatesFlag(args["send-updates"]);
	// Refresh before the no-op decision: attendee membership must be observed
	// from the server, not from a possibly stale cache.
	if (!args["dry-run"]) await refreshResource(client, "events");
	const events = await mutationReader(args["dry-run"] === true)(
		client,
		"events",
	);
	const event = resolveCachedEvent(events, args.id as string);
	validateMutableTimedGoogleEvent(event);

	const requested = collectAttendeeEmails(args);
	const existing = existingAttendeeEmails(event);
	const toChange =
		mode === "add"
			? requested.filter((email) => !existing.has(email))
			: requested.filter((email) => existing.has(email));

	if (args["dry-run"]) {
		const after = {
			...event,
			attendees:
				mode === "add"
					? [...existing, ...toChange]
					: [...existing].filter((email) => !toChange.includes(email)),
		};
		printDryRun(
			[previewItem({ ...event, attendees: [...existing] }, after, sendUpdates)],
			args.json === true,
		);
		return;
	}
	if (toChange.length === 0) {
		const message =
			mode === "add"
				? "No attendees to add; all requested emails are already present."
				: "No attendees to remove; none of the requested emails are present.";
		if (args.json === true) {
			outputMutation({
				command: `event attendees ${mode}`,
				json: true,
				receipts: [],
				result: {
					event_id: event.id,
					action: mode,
					requested: requested.length,
					changed: 0,
					message,
				},
				warnings: [
					"No mutation submitted; attendee membership was observed during refresh.",
				],
			});
			return;
		}
		console.log(message);
		return;
	}

	const intent = buildAttendeePatchIntent({
		event,
		add: mode === "add" ? toChange : [],
		remove: mode === "remove" ? toChange : [],
		sendUpdates,
	});
	// Attendee edits ride the supported v5 event_operations path as an
	// explicit patch intent. The legacy POST /v3/events/modifiers endpoint
	// returns HTTP 410 and is never called.
	const operation = buildPatchEventOperation(
		eventOperationRoute(event),
		intent.base,
		intent.changes,
		intent.sendUpdates,
	);
	const response = await client.submitEventOperations([operation]);
	const receipts = response.receipts;
	const verifications = new Map<string, VerificationResult<Event>>();
	if (args.verify === true && receipts[0]?.status === "accepted") {
		const verification = await verifyEventAttendees(
			client,
			event.id,
			mode === "add" ? requested : [],
			mode === "remove" ? requested : [],
			verificationOptions(),
		);
		if (
			verification.observed &&
			(verification.status === "verified" ||
				isReadOnlyCanonical(verification.observed))
		) {
			await upsertResourceRecords("events", [verification.observed]);
		}
		if (isReadOnlyCanonical(verification.observed)) {
			verification.status = "mismatch";
			verification.differingFields.push("read_only");
			verification.error = `Event "${event.id}" is read-only; further mutations are refused`;
		}
		verifications.set(event.id, verification);
	}
	outputMutation({
		command: `event attendees ${mode}`,
		json: args.json === true,
		receipts,
		verifications,
		result:
			verifications.get(event.id)?.status === "verified"
				? verifications.get(event.id)?.observed
				: null,
	});
}

export const attendeeAddCommand = defineCommand({
	meta: {
		name: "add",
		description: "Add attendee emails to a timed Google event",
	},
	args: {
		...dryRunArgs,
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
		"send-updates": {
			type: "string",
			description: "Guest notification mode: none (default, silent) or all",
		},
		verify: verifyFlag,
		json: {
			type: "boolean",
			description: "Output versioned mutation receipts as JSON",
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
		...dryRunArgs,
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
		"send-updates": {
			type: "string",
			description: "Guest notification mode: none (default, silent) or all",
		},
		verify: verifyFlag,
		json: {
			type: "boolean",
			description: "Output versioned mutation receipts as JSON",
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
