import { readFile } from "node:fs/promises";
import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import type {
	Calendar,
	CreateEventPayload,
	CreateTaskPayload,
	CreateTimeSlotPayload,
	UpdateTaskPayload,
} from "../lib/api/types";
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
import { parseDurationToSeconds } from "../lib/duration-parser";
import { addPendingTask } from "../lib/task-cache";

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

function resolveTime(date: string, timeInput: string): string {
	const parsedTime = parseTime(timeInput);
	if (!parsedTime) {
		console.error(
			`Error: Invalid time format "${timeInput}". Expected format: HH:MM (e.g., 21:00, 14:30)`,
		);
		process.exit(1);
	}

	return createDateTimeUTC(date, parsedTime.hours, parsedTime.minutes);
}

export interface BuildEventPayloadInput {
	title: string;
	description?: string;
	startTime: string;
	endTime: string;
	timezone?: string | null;
	calendar: Calendar;
	location?: string;
	id?: string;
	now?: string;
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
	now,
}: BuildEventPayloadInput): CreateEventPayload {
	const content: Record<string, unknown> = { sendUpdates: "all" };
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
		recurrence: null,
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

async function resolveProjectId(projectName: string | undefined) {
	if (!projectName) return undefined;

	const client = createClient();
	const labelsResponse = await client.getLabels();
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
		duration: {
			type: "string",
			description: "Duration (e.g., '30m', '1h', '2h')",
		},
		json: {
			type: "boolean",
			description: "Output created task as JSON",
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

		let datetime: string | undefined;
		let datetimeTz: string | undefined;
		let calendarId: string | null = null;

		if (at) {
			const taskDate = date ?? getTodayDate();
			datetime = resolveTime(taskDate, at);
			datetimeTz = getLocalTimezone();
			calendarId = await getDefaultCalendarId(client);
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
		const listId = await resolveProjectId(projectName);
		if (listId) task.listId = listId;
		if (calendarId) {
			task.calendar_id = calendarId;
			task.status = 2;
		}

		const response = await client.upsertTasks([task]);
		const createdTask = response.data[0];

		if (!createdTask) {
			console.error("Error: Failed to create task - no data returned");
			process.exit(1);
		}

		await addPendingTask(createdTask);

		if (args.json === true) {
			console.log(JSON.stringify(createdTask, null, 2));
			return;
		}

		console.log("✓ Akiflow task created successfully");
		console.log(`  ID: ${createdTask.id}`);
		console.log(`  Title: ${createdTask.title}`);
		if (createdTask.date) console.log(`  Date: ${createdTask.date}`);
		if (createdTask.datetime) {
			const localTime = new Date(createdTask.datetime).toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
			});
			console.log(`  Time: ${localTime}`);
		}
	},
});

export const createSlotCommand = defineCommand({
	meta: {
		name: "create",
		description: "Create an Akiflow task slot, optionally containing tasks",
	},
	args: {
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
			description: "Output created records as JSON",
		},
	},
	run: async (context) => {
		const client = createClient();
		const args = context.args as Record<string, unknown>;
		const title = args.title as string;
		const date = resolveDate(args);
		const at = args.at as string;
		const durationInput = args.duration as string;
		const description = args.description as string | undefined;
		const timezone = getLocalTimezone();

		if (!date) {
			console.error("Error: Slot requires --date");
			process.exit(1);
		}

		const durationSeconds = parseDurationToSeconds(durationInput);
		const startTime = resolveTime(date, at);
		const endTime = new Date(
			new Date(startTime).getTime() + durationSeconds * 1000,
		).toISOString();
		let calendar: Calendar;
		try {
			calendar = await resolveWritableCalendar(
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

		const slotResponse = await client.upsertTimeSlots([slotPayload]);
		const createdSlot = slotResponse.data[0];

		if (!createdSlot) {
			console.error("Error: Failed to create task slot - no data returned");
			process.exit(1);
		}

		const taskDurationInput = args["task-duration"] as string | undefined;
		const taskDuration =
			taskDurationInput == null
				? undefined
				: parseDurationToSeconds(taskDurationInput);
		const newTaskTitles = stringValues(args.task);
		const existingTaskIds = stringValues(args["task-id"]);
		const taskPayloads: Array<CreateTaskPayload | UpdateTaskPayload> = [];

		for (const taskTitle of newTaskTitles) {
			const task: CreateTaskPayload = {
				id: crypto.randomUUID(),
				title: taskTitle,
				date,
				datetime: startTime,
				datetime_tz: timezone,
				time_slot_id: createdSlot.id,
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
				time_slot_id: createdSlot.id,
				status: 2,
				global_updated_at: now,
			});
		}

		const taskResponse =
			taskPayloads.length > 0
				? await client.upsertTasks(taskPayloads)
				: { data: [] };

		for (const task of taskResponse.data) {
			await addPendingTask(task);
		}

		if (args.json === true) {
			console.log(
				JSON.stringify(
					{
						slot: createdSlot,
						tasks: taskResponse.data,
					},
					null,
					2,
				),
			);
			return;
		}

		console.log("✓ Akiflow task slot created successfully");
		console.log(`  ID: ${createdSlot.id}`);
		console.log(`  Title: ${createdSlot.title}`);
		console.log(`  Time: ${at} (${durationInput})`);
		if (taskResponse.data.length > 0) {
			console.log(`  Linked tasks: ${taskResponse.data.length}`);
		}
	},
});

export const createEventCommand = defineCommand({
	meta: {
		name: "create",
		description: "Create a timed Google calendar event through Akiflow",
	},
	args: {
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
		json: {
			type: "boolean",
			description: "Output created event as JSON",
		},
	},
	run: async (context) => {
		const client = createClient();
		const args = context.args as Record<string, unknown>;
		const title = args.title as string;
		const date = resolveDate(args);
		const at = args.at as string;
		const durationInput = args.duration as string;
		const description = await resolveDescription(
			args.description as string | undefined,
			args["description-file"] as string | undefined,
		);
		const location = (args.location as string | undefined)?.trim();
		const timezone = getLocalTimezone();

		if (!date) {
			console.error("Error: Event requires --date");
			process.exit(1);
		}

		const durationSeconds = parseDurationToSeconds(durationInput);
		const startTime = resolveTime(date, at);
		const endTime = new Date(
			new Date(startTime).getTime() + durationSeconds * 1000,
		).toISOString();
		let calendar: Calendar;
		try {
			calendar = await resolveEventTargetCalendar(
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
		});

		const response = await client.createEvents([eventPayload]);
		const createdEvent = response.data[0];

		if (!createdEvent) {
			console.error("Error: Failed to create event - no data returned");
			process.exit(1);
		}

		if (args.json === true) {
			console.log(JSON.stringify(createdEvent, null, 2));
			return;
		}

		console.log("✓ Akiflow calendar event created successfully");
		console.log(`  ID: ${createdEvent.id}`);
		console.log(`  Title: ${createdEvent.title ?? title}`);
		console.log(`  Calendar: ${calendar.title} (${calendar.id})`);
		console.log(`  Time: ${at} (${durationInput})`);
		if (location) console.log(`  Location: ${location}`);
	},
});
