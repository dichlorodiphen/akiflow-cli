import { readFile } from "node:fs/promises";
import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import {
	buildCreateEventOperation,
	type EventSendUpdates,
	parseSendUpdates,
} from "../lib/api/event-intents";
import type {
	Calendar,
	CreateEventPayload,
	CreateTaskPayload,
	CreateTimeSlotPayload,
	UpdateTaskPayload,
} from "../lib/api/types";
import { isReadOnlyCanonical } from "../lib/api/types";
import { upsertResourceRecords } from "../lib/cache";
import {
	CalendarResolutionError,
	getDefaultCalendarId,
	resolveEventTargetCalendar,
	resolveWritableCalendar,
} from "../lib/calendar";
import {
	createDateTimeUTC,
	getLocalTimezone,
	getTodayDate,
	getTomorrowDate,
	parseDate,
	parseTime,
} from "../lib/date-parser";
import {
	cachedTask,
	dryRunArgs,
	dryRunCalendar,
	mutationReader,
	previewItem,
	printDryRun,
} from "../lib/dry-run";
import { parseDurationToSeconds } from "../lib/duration-parser";
import { eventExpectedFields, outputMutation } from "../lib/mutation-output";
import { previewOccurrences, validateRRule } from "../lib/recurrence";
import {
	assertMutableTaskId,
	isSyntheticTaskId,
	readTaskContext,
	resolveTaskId,
} from "../lib/task-context";
import {
	printTaskMutation,
	type TaskOutcome,
	taskMutationOutcome,
	unknownTaskOutcome,
} from "../lib/task-mutation-output";
import {
	DSTFoldError,
	DSTGapError,
	InvalidCalendarDateError,
	InvalidTimezoneError,
	parseCalendarDate,
	validateTimezone,
	zonedTimeToUtc,
} from "../lib/timezone";
import { resolveEffectiveTimezone } from "../lib/timezone-profile";
import { recordTaskIntent } from "../lib/tasks";
import { verifyEventFields } from "../lib/verification";
import { verificationOptions, verifyFlag } from "../lib/verify-flag";

function stringValues(value: unknown): string[] {
	if (value == null) return [];
	return (Array.isArray(value) ? value : [value])
		.map((v) => String(v).trim())
		.filter(Boolean);
}

function resolveDate(args: Record<string, unknown>): string | undefined {
	if (args.today === true) return getTodayDate();
	if (args.tomorrow === true) return getTomorrowDate();

	const dateInput = args.date as string | undefined;
	if (!dateInput) return undefined;

	const parsed = parseDate(dateInput);
	if (!parsed) {
		console.error(`Error: Could not parse date "${dateInput}"`);
		process.exit(1);
	}

	return parsed;
}

function resolveTime(
	date: string,
	timeInput: string,
	timezone: string,
	fold?: "first" | "second",
): string {
	const parsedTime = parseTime(timeInput);
	if (!parsedTime) {
		console.error(
			`Error: Invalid time format "${timeInput}". Expected format: HH:MM (e.g., 21:00, 14:30)`,
		);
		process.exit(2);
	}

	try {
		return zonedTimeToUtc(
			date,
			parsedTime.hours,
			parsedTime.minutes,
			timezone,
			fold,
		);
	} catch (error) {
		console.error(
			`Error: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(2);
	}
}

/**
 * Resolve the effective timezone for a create command.
 * Precedence: explicit --timezone flag > profile > system local.
 * Validates the date string as a real calendar date.
 */
async function resolveCreateTimezone(
	args: Record<string, unknown>,
	date: string | undefined,
): Promise<string> {
	// Validate the date is a real calendar date (rejects 2026-02-30).
	if (date) {
		try {
			parseCalendarDate(date);
		} catch (error) {
			console.error(
				`Error: ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(2);
		}
	}

	const explicit = args.timezone as string | undefined;
	try {
		return await resolveEffectiveTimezone(explicit);
	} catch (error) {
		console.error(
			`Error: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(2);
	}
}

function resolveFold(
	args: Record<string, unknown>,
): "first" | "second" | undefined {
	const foldArg = args.fold as string | undefined;
	if (foldArg !== undefined && foldArg !== "first" && foldArg !== "second") {
		console.error(
			`Error: Invalid --fold "${foldArg}". Expected "first" or "second".`,
		);
		process.exit(2);
	}
	return foldArg as "first" | "second" | undefined;
}

const timezoneArg = {
	type: "string",
	description:
		"IANA timezone for interpreting --date/--at (e.g., America/Los_Angeles). Defaults to profile, then local.",
} as const;

const foldArg = {
	type: "string",
	description:
		'Disambiguate DST fold: "first" (before transition) or "second" (after). Required if the time is ambiguous.',
} as const;

export interface BuildEventPayloadInput {
	title: string;
	description?: string;
	startTime: string;
	endTime: string;
	timezone?: string | null;
	calendar: Calendar;
	location?: string;
	id?: string;
	sendUpdates?: EventSendUpdates;
	now?: string;
	/** Validated, normalized RRULE string (without RRULE: prefix). */
	rrule?: string | null;
}

export function buildCreateEventPayload({
	title,
	description = "",
	startTime,
	endTime,
	timezone,
	calendar,
	location,
	id,
	sendUpdates = "none",
	now,
	rrule = null,
}: BuildEventPayloadInput): CreateEventPayload {
	const content: Record<string, unknown> = { sendUpdates };
	if (location?.trim()) content.location = location.trim();
	const timestamp = now ?? new Date().toISOString();
	const organizerId = calendar.origin_id || null;

	return {
		title,
		description,
		start_time: startTime,
		end_time: endTime,
		id: id ?? crypto.randomUUID(),
		status: "confirmed",
		start_datetime_tz: timezone ?? getLocalTimezone(),
		creator_id: organizerId,
		organizer_id: organizerId,
		origin_id: null,
		connector_id: calendar.connector_id,
		akiflow_account_id: calendar.akiflow_account_id ?? null,
		origin_account_id: calendar.origin_account_id ?? null,
		recurring_id: null,
		origin_recurring_id: null,
		calendar_id: calendar.id,
		origin_calendar_id: calendar.origin_id ?? null,
		original_start_time: null,
		original_start_date: null,
		start_date: null,
		end_date: null,
		end_datetime_tz: null,
		origin_updated_at: null,
		etag: null,
		content,
		attendees: [],
		recurrence: rrule ? [`RRULE:${rrule}`] : null,
		recurrence_exception: false,
		declined: false,
		read_only: false,
		hidden: false,
		url: null,
		meeting_status: null,
		meeting_url: null,
		meeting_icon: null,
		meeting_solution: null,
		color: null,
		calendar_color: calendar.color ?? null,
		task_id: null,
		time_slot_id: null,
		recurrence_exception_delete: false,
		recurrence_sync_retry: null,
		errors: null,
		global_created_at: null,
		deleted_at: null,
		global_updated_at: timestamp,
	};
}

async function resolveDescription(
	description: string | undefined,
	descriptionFile: string | undefined,
): Promise<string> {
	if (description && descriptionFile) {
		console.error(
			"Error: Use either --description or --description-file, not both",
		);
		process.exit(1);
	}

	if (!descriptionFile) return description ?? "";

	try {
		return await readFile(descriptionFile, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(
			`Error: Could not read description file "${descriptionFile}": ${message}`,
		);
		process.exit(1);
	}
}

async function resolveProjectId(
	projectName: string | undefined,
	dryRun = false,
) {
	if (!projectName) return undefined;

	const client = createClient();
	const labelsResponse = dryRun
		? { data: await mutationReader(true)(client, "labels") }
		: await client.getLabels();
	const label = labelsResponse.data.find(
		(l) => l.title.toLowerCase() === projectName.toLowerCase(),
	);

	if (!label) {
		console.error(`Error: Project "${projectName}" not found`);
		process.exit(1);
	}

	return label.id;
}

function failCalendarResolution(error: unknown): never {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Error: ${message}`);
	process.exit(1);
}

export const createTaskCommand = defineCommand({
	meta: {
		name: "create",
		description: "Create an Akiflow task",
	},
	args: {
		...dryRunArgs,
		verify: verifyFlag,
		title: {
			type: "positional",
			description: "Task title",
			required: true,
		},
		description: {
			type: "string",
			description: "Task description",
		},
		today: {
			type: "boolean",
			description: "Schedule task for today",
			alias: "t",
		},
		tomorrow: {
			type: "boolean",
			description: "Schedule task for tomorrow",
		},
		date: {
			type: "string",
			description: "Natural language date (e.g., 'next friday', 'in 3 days')",
			alias: "d",
		},
		project: {
			type: "string",
			description: "Assign to project/label by name",
			alias: "p",
		},
		at: {
			type: "string",
			description: "Local start time (e.g., '21:00', '14:30')",
		},
		timezone: timezoneArg,
		fold: foldArg,
		duration: {
			type: "string",
			description: "Duration (e.g., '30m', '1h', '2h')",
		},
		json: {
			type: "boolean",
			description: "Output versioned mutation receipts as JSON",
		},
	},
	run: async (context) => {
		const client = createClient();
		const args = context.args as Record<string, unknown>;
		const title = args.title as string;
		const description = args.description as string | undefined;
		const date = resolveDate(args);
		const at = args.at as string | undefined;
		const durationInput = args.duration as string | undefined;
		const projectName = args.project as string | undefined;
		const now = new Date().toISOString();
		const timezone = await resolveCreateTimezone(args, date);
		const fold = resolveFold(args);

		let datetime: string | undefined;
		let datetimeTz: string | undefined;
		let calendarId: string | null = null;

		if (at) {
			const taskDate = date ?? getTodayDate();
			datetime = resolveTime(taskDate, at, timezone, fold);
			datetimeTz = timezone;
			calendarId = args["dry-run"]
				? (await dryRunCalendar()).id
				: await getDefaultCalendarId(client);
		}

		let duration: number | undefined;
		if (durationInput) duration = parseDurationToSeconds(durationInput);

		const task: CreateTaskPayload = {
			id: crypto.randomUUID(),
			title,
			global_created_at: now,
			global_updated_at: now,
		};

		if (description) task.description = description;
		if (date) task.date = date;
		if (datetime) task.datetime = datetime;
		if (datetimeTz) task.datetime_tz = datetimeTz;
		if (duration !== undefined) task.duration = duration;
		const listId = await resolveProjectId(
			projectName,
			args["dry-run"] === true,
		);
		if (listId) task.listId = listId;
		if (calendarId) {
			task.calendar_id = calendarId;
			task.status = 2;
		}

		if (args["dry-run"]) {
			printDryRun([previewItem(null, task)], args.json === true);
			return;
		}
		try {
			const response = await client.upsertTasks([task]);
			const outcome = await taskMutationOutcome(
				client,
				response,
				[task],
				args.verify === true,
			);
			for (const receipt of outcome.receipts) {
				if (receipt.status === "accepted" || receipt.status === "verified") {
					const created = response.data.find((t) => t.id === receipt.id) ?? null;
					await recordTaskIntent("create", task, created ?? undefined);
				}
			}
			printTaskMutation(
				"task create",
				args.json === true,
				[outcome],
				response.data[0] ?? null,
			);
		} catch (error) {
			printTaskMutation(
				"task create",
				args.json === true,
				[unknownTaskOutcome([task.id], error)],
				null,
			);
		}
	},
});

export const createSlotCommand = defineCommand({
	meta: {
		name: "create",
		description: "Create an Akiflow task slot, optionally containing tasks",
	},
	args: {
		...dryRunArgs,
		verify: verifyFlag,
		title: {
			type: "positional",
			description: "Slot title",
			required: true,
		},
		date: {
			type: "string",
			description: "Slot date (YYYY-MM-DD or natural language)",
			required: true,
			alias: "d",
		},
		at: {
			type: "string",
			description: "Local start time (e.g., '09:30')",
			required: true,
		},
		timezone: timezoneArg,
		fold: foldArg,
		duration: {
			type: "string",
			description: "Slot duration (e.g., '30m', '1h')",
			required: true,
		},
		description: {
			type: "string",
			description: "Slot description",
		},
		calendar: {
			type: "string",
			description:
				"Calendar id, origin id, or unique title; defaults to the writable primary calendar",
		},
		task: {
			type: "string",
			description: "Create a task inside this slot; repeat for multiple tasks",
		},
		"task-id": {
			type: "string",
			description:
				"Existing task id to place inside this slot; repeat for multiple tasks",
		},
		"task-duration": {
			type: "string",
			description: "Duration to assign to newly created slot tasks",
		},
		json: {
			type: "boolean",
			description: "Output versioned mutation receipts as JSON",
		},
	},
	run: async (context) => {
		const client = createClient();
		const args = context.args as Record<string, unknown>;
		const existingTaskIds = stringValues(args["task-id"]);
		for (const taskId of existingTaskIds) {
			if (isSyntheticTaskId(taskId)) {
				console.error(`Error: Synthetic task ID "${taskId}" cannot be mutated`);
				process.exit(2);
			}
		}
		const title = args.title as string;
		const date = resolveDate(args);
		const at = args.at as string;
		const durationInput = args.duration as string;
		const description = args.description as string | undefined;
		const timezone = await resolveCreateTimezone(args, date);
		const fold = resolveFold(args);

		if (!date) {
			console.error("Error: Slot requires --date");
			process.exit(1);
		}

		const durationSeconds = parseDurationToSeconds(durationInput);
		const startTime = resolveTime(date, at, timezone, fold);
		const endTime = new Date(
			new Date(startTime).getTime() + durationSeconds * 1000,
		).toISOString();
		let calendar: Calendar;
		try {
			calendar = args["dry-run"]
				? await dryRunCalendar(args.calendar as string | undefined)
				: await resolveWritableCalendar(
						client,
						args.calendar as string | undefined,
					);
		} catch (error) {
			if (error instanceof CalendarResolutionError)
				failCalendarResolution(error);
			throw error;
		}

		const now = new Date().toISOString();
		const slotId = crypto.randomUUID();
		const slotPayload: CreateTimeSlotPayload = {
			id: slotId,
			calendar_id: calendar.id,
			status: "confirmed",
			title,
			description: description ?? null,
			start_time: startTime,
			end_time: endTime,
			start_datetime_tz: timezone,
			content: {},
			data: {},
			global_created_at: now,
			global_updated_at: now,
		};

		// Validate dependent tasks before creating the slot.
		const taskDurationInput = args["task-duration"] as string | undefined;
		const taskDuration =
			taskDurationInput == null
				? undefined
				: parseDurationToSeconds(taskDurationInput);
		const newTaskTitles = stringValues(args.task);
		const taskPayloads: Array<CreateTaskPayload | UpdateTaskPayload> = [];

		for (const taskTitle of newTaskTitles) {
			const task: CreateTaskPayload = {
				id: crypto.randomUUID(),
				title: taskTitle,
				date,
				datetime: startTime,
				datetime_tz: timezone,
				time_slot_id: slotId,
				status: 2,
				global_created_at: now,
				global_updated_at: now,
			};
			if (taskDuration !== undefined) task.duration = taskDuration;
			taskPayloads.push(task);
		}

		for (const taskId of existingTaskIds) {
			taskPayloads.push({
				id: taskId,
				date,
				datetime: startTime,
				datetime_tz: timezone,
				time_slot_id: slotId,
				status: 2,
				global_updated_at: now,
			});
		}

		if (args["dry-run"]) {
			const existing = new Set(existingTaskIds);
			printDryRun(
				[
					previewItem(null, slotPayload),
					...(await Promise.all(
						taskPayloads.map(async (payload) =>
							previewItem(
								existing.has(payload.id) ? await cachedTask(payload.id) : null,
								payload,
							),
						),
					)),
				],
				args.json === true,
			);
			return;
		}
		const outcomes: TaskOutcome[] = [];
		try {
			const slotResponse = await client.upsertTimeSlots([slotPayload]);
			const slotOutcome = await taskMutationOutcome(
				client,
				slotResponse,
				[slotPayload],
				args.verify === true,
				"slot",
			);
			outcomes.push(slotOutcome);
			const createdSlot =
				slotResponse.data.find((record) => record.id === slotId) ?? null;
			if (!slotOutcome.ok) {
				printTaskMutation("slot create", args.json === true, outcomes, {
					slot: createdSlot,
					tasks: [],
				});
				return;
			}
			let createdTasks = [] as import("../lib/api/types").Task[];
			if (taskPayloads.length > 0) {
				try {
					const response = await client.upsertTasks(taskPayloads);
					const taskOutcome = await taskMutationOutcome(
						client,
						response,
						taskPayloads,
						args.verify === true,
					);
					outcomes.push(taskOutcome);
					createdTasks = response.data.filter((task) =>
						taskOutcome.receipts.some(
							(r) =>
								r.id === task.id && ["accepted", "verified"].includes(r.status),
						),
					);
					for (const task of createdTasks) {
						const payload = taskPayloads.find((p) => p.id === task.id);
						if (payload) await recordTaskIntent("create", payload, task);
					}
				} catch (error) {
					outcomes.push(
						unknownTaskOutcome(
							taskPayloads.map((p) => p.id),
							error,
						),
					);
				}
			}
			printTaskMutation("slot create", args.json === true, outcomes, {
				slot: createdSlot,
				tasks: createdTasks,
			});
		} catch (error) {
			outcomes.push(unknownTaskOutcome([slotId], error, "slot"));
			printTaskMutation("slot create", args.json === true, outcomes, null);
		}
	},
});

export const createEventCommand = defineCommand({
	meta: {
		name: "create",
		description: "Create a timed Google calendar event through Akiflow",
	},
	args: {
		...dryRunArgs,
		title: {
			type: "positional",
			description: "Event title",
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
		timezone: timezoneArg,
		fold: foldArg,
		duration: {
			type: "string",
			description: "Event duration (e.g., '30m', '1h')",
			required: true,
		},
		calendar: {
			type: "string",
			description:
				"Calendar id, origin id, or unique title; defaults to the writable primary Google calendar",
		},
		description: {
			type: "string",
			description: "Event description",
		},
		"description-file": {
			type: "string",
			description: "Read event description from a UTF-8 text file",
		},
		location: {
			type: "string",
			description: "Event location",
		},
		"send-updates": {
			type: "string",
			description: "Guest notification mode: none (default, silent) or all",
		},
		rrule: {
			type: "string",
			description:
				"Recurrence rule (e.g., 'FREQ=WEEKLY;BYDAY=MO,WE,FR'). Validated; preview first 5 occurrences with --dry-run",
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
		const parsedSendUpdates = parseSendUpdates(args["send-updates"]);
		if (!parsedSendUpdates) {
			console.error(
				`Error: Invalid --send-updates "${args["send-updates"]}". Expected "none" or "all".`,
			);
			process.exit(1);
		}
		const sendUpdates: EventSendUpdates = parsedSendUpdates;
		const title = args.title as string;
		const date = resolveDate(args);
		const at = args.at as string;
		const durationInput = args.duration as string;
		const description = await resolveDescription(
			args.description as string | undefined,
			args["description-file"] as string | undefined,
		);
		const location = (args.location as string | undefined)?.trim();
		const timezone = await resolveCreateTimezone(args, date);
		const fold = resolveFold(args);

		if (!date) {
			console.error("Error: Event requires --date");
			process.exit(1);
		}

		// Validate --rrule early (before any side effects).
		const rruleInput = (args.rrule as string | undefined)?.trim() || null;
		let normalizedRrule: string | null = null;
		if (rruleInput) {
			try {
				normalizedRrule = validateRRule(rruleInput);
			} catch (error) {
				console.error(
					`Error: ${error instanceof Error ? error.message : String(error)}`,
				);
				process.exit(2);
			}
		}

		const durationSeconds = parseDurationToSeconds(durationInput);
		const startTime = resolveTime(date, at, timezone, fold);
		const endTime = new Date(
			new Date(startTime).getTime() + durationSeconds * 1000,
		).toISOString();
		let calendar: Calendar;
		try {
			calendar = args["dry-run"]
				? await dryRunCalendar(args.calendar as string | undefined, true)
				: await resolveEventTargetCalendar(
						client,
						args.calendar as string | undefined,
						"af event create",
					);
		} catch (error) {
			if (error instanceof CalendarResolutionError)
				failCalendarResolution(error);
			throw error;
		}
		const eventPayload = buildCreateEventPayload({
			title,
			description,
			startTime,
			endTime,
			timezone,
			calendar,
			location,
			sendUpdates,
			rrule: normalizedRrule,
		});

		if (args["dry-run"]) {
			// For recurring events, preview the bounded occurrences in the
			// owner timezone so the user can verify the rule before submitting.
			if (normalizedRrule) {
				const preview = previewOccurrences(
					normalizedRrule,
					new Date(startTime),
					timezone,
					5,
				);
				console.error("Recurrence preview (first 5 occurrences):");
				for (const occurrence of preview.occurrences) {
					console.error(`  ${occurrence}`);
				}
			}
			printDryRun(
				[previewItem(null, eventPayload, sendUpdates)],
				args.json === true,
			);
			return;
		}
		// Explicit create intent: the operation kind is fixed here, never
		// inferred from the payload's status/origin_id fields.
		const operation = buildCreateEventOperation(eventPayload, sendUpdates);
		const response = await client.submitEventOperations([operation]);
		const receipt = response.receipts[0];
		const verification =
			receipt?.status === "accepted" && args.verify === true
				? await verifyEventFields(
						client,
						receipt.event_id,
						eventExpectedFields(eventPayload),
						verificationOptions(),
					)
				: null;
		if (
			verification?.observed &&
			(verification.status === "verified" ||
				isReadOnlyCanonical(verification.observed))
		) {
			await upsertResourceRecords("events", [verification.observed]);
		}
		if (verification && isReadOnlyCanonical(verification.observed)) {
			verification.status = "mismatch";
			verification.differingFields = [
				...verification.differingFields,
				"read_only",
			];
			verification.error = `Event "${receipt?.event_id}" is read-only; further mutations are refused`;
		}
		outputMutation({
			command: "event create",
			json: args.json === true,
			receipts: response.receipts,
			verifications:
				verification && receipt
					? new Map([[receipt.event_id, verification]])
					: undefined,
			result:
				verification?.status === "verified" ? verification.observed : null,
		});
	},
});
