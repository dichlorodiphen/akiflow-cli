import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import type {
	Task,
	TimeSlot,
	UpdateTaskPayload,
	UpdateTimeSlotPayload,
} from "../lib/api/types";
import { readResource } from "../lib/cache";
import {
	CalendarResolutionError,
	resolveWritableCalendar,
} from "../lib/calendar";
import {
	createDateTimeUTC,
	formatLocalDate,
	getLocalTimezone,
	parseDate,
	parseDateBoundary,
	parseTime,
	resolveSingleDayRange,
} from "../lib/date-parser";
import { parseDurationToSeconds } from "../lib/duration-parser";
import { createSlotCommand } from "./create";

function fail(message: string): never {
	console.error(`Error: ${message}`);
	process.exit(1);
}

function stringValues(value: unknown): string[] {
	if (value == null) return [];
	return (Array.isArray(value) ? value : [value])
		.map((v) => String(v).trim())
		.filter(Boolean);
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values));
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

function formatLocalTime(date: Date): string {
	return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatSlotDateTime(slot: Pick<TimeSlot, "start_time" | "end_time">) {
	const start = new Date(slot.start_time);
	const end = new Date(slot.end_time);
	return `${formatLocalDate(start)} ${formatLocalTime(start)}-${formatLocalTime(end)}`;
}

function formatDurationMinutes(startTime: string, endTime: string): number {
	return Math.round(
		(new Date(endTime).getTime() - new Date(startTime).getTime()) / 60000,
	);
}

function failCalendarResolution(error: unknown): never {
	const message = error instanceof Error ? error.message : String(error);
	fail(message);
}

export function resolveCachedSlot(
	slots: TimeSlot[],
	identifier: string,
): TimeSlot {
	const exact = slots.find((slot) => slot.id === identifier);
	if (exact) return exact;

	const matches = slots.filter((slot) => slot.id.startsWith(identifier));
	const [match] = matches;
	if (matches.length === 1 && match) return match;
	if (matches.length > 1) {
		fail(
			`Slot id prefix "${identifier}" is ambiguous (${matches
				.map((slot) => slot.id)
				.join(", ")}). Use a longer id.`,
		);
	}

	fail(
		`Slot "${identifier}" was not found in the Akiflow time slot cache. Run af refresh and try again.`,
	);
}

export function resolveCachedTask(tasks: Task[], identifier: string): Task {
	const exact = tasks.find((task) => task.id === identifier);
	if (exact) {
		if (exact.deleted_at) fail(`Task "${exact.id}" is deleted`);
		return exact;
	}

	const matches = tasks.filter((task) => task.id.startsWith(identifier));
	const [match] = matches;
	if (matches.length === 1 && match) {
		if (match.deleted_at) fail(`Task "${match.id}" is deleted`);
		return match;
	}
	if (matches.length > 1) {
		fail(
			`Task id prefix "${identifier}" is ambiguous (${matches
				.map((task) => task.id)
				.join(", ")}). Use a longer id.`,
		);
	}

	fail(
		`Task "${identifier}" was not found in the Akiflow task cache. Run af refresh and try again.`,
	);
}

function requireActiveSlot(slot: TimeSlot): void {
	if (slot.deleted_at) fail(`Slot "${slot.id}" is deleted`);
}

function activeLinkedTasks(tasks: Task[], slotId: string): Task[] {
	return tasks.filter(
		(task) => task.deleted_at == null && task.time_slot_id === slotId,
	);
}

export function buildSlotDeletePayload({
	slot,
	now = new Date().toISOString(),
}: {
	slot: TimeSlot;
	now?: string;
}): UpdateTimeSlotPayload {
	if (slot.deleted_at) fail(`Slot "${slot.id}" is deleted`);

	return {
		id: slot.id,
		deleted_at: now,
		global_updated_at: now,
	};
}

export interface ResolveSlotTimingInput {
	slot: TimeSlot;
	dateInput?: string;
	atInput?: string;
	durationInput?: string;
}

export interface ResolvedSlotTiming {
	startTime: string;
	endTime: string;
	date: string;
	timezone: string;
	changed: boolean;
}

export function resolveSlotTiming({
	slot,
	dateInput,
	atInput,
	durationInput,
}: ResolveSlotTimingInput): ResolvedSlotTiming {
	const hasDate = dateInput !== undefined;
	const hasAt = atInput !== undefined;
	const hasDuration = durationInput !== undefined;
	const currentStart = new Date(slot.start_time);
	const currentEnd = new Date(slot.end_time);
	const currentDurationSeconds = Math.round(
		(currentEnd.getTime() - currentStart.getTime()) / 1000,
	);

	let date = formatLocalDate(currentStart);
	if (hasDate) {
		const parsed = parseDate(dateInput);
		if (!parsed) fail(`Could not parse date "${dateInput}"`);
		date = parsed;
	}

	let hours = currentStart.getHours();
	let minutes = currentStart.getMinutes();
	if (hasAt) {
		const parsedTime = parseTime(atInput);
		if (!parsedTime) {
			fail(
				`Invalid time format "${atInput}". Expected format: HH:MM (e.g., 21:00, 14:30)`,
			);
		}
		hours = parsedTime.hours;
		minutes = parsedTime.minutes;
	}

	let durationSeconds = currentDurationSeconds;
	if (hasDuration) {
		try {
			durationSeconds = parseDurationToSeconds(durationInput);
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error));
		}
	}
	if (durationSeconds <= 0) fail("Slot duration must be greater than 0");

	const startTime =
		hasDate || hasAt
			? createDateTimeUTC(date, hours, minutes)
			: slot.start_time;
	const endTime = new Date(
		new Date(startTime).getTime() + durationSeconds * 1000,
	).toISOString();

	return {
		startTime,
		endTime,
		date,
		timezone: getLocalTimezone(),
		changed: hasDate || hasAt || hasDuration,
	};
}

export interface BuildSlotUpdatePayloadInput {
	slot: TimeSlot;
	title?: string;
	calendarId?: string;
	timing?: ResolvedSlotTiming;
	now?: string;
}

export function buildSlotUpdatePayload({
	slot,
	title,
	calendarId,
	timing,
	now = new Date().toISOString(),
}: BuildSlotUpdatePayloadInput): UpdateTimeSlotPayload {
	requireActiveSlot(slot);

	return {
		id: slot.id,
		calendar_id: calendarId ?? slot.calendar_id,
		status: slot.status,
		title: title ?? slot.title,
		description: slot.description,
		start_time: timing?.startTime ?? slot.start_time,
		end_time: timing?.endTime ?? slot.end_time,
		start_datetime_tz: timing?.changed
			? timing.timezone
			: slot.start_datetime_tz,
		label_id: slot.label_id,
		section_id: slot.section_id,
		recurrence: slot.recurrence,
		color: slot.color,
		content: slot.content,
		data: slot.data,
		deleted_at: slot.deleted_at,
		global_updated_at: now,
	};
}

export interface BuildSlotTaskUpdatePayloadsInput {
	slot: TimeSlot;
	allTasks: Task[];
	addTasks?: Task[];
	removeTasks?: Task[];
	timing: ResolvedSlotTiming;
	now?: string;
}

export function buildSlotTaskUpdatePayloads({
	slot,
	allTasks,
	addTasks = [],
	removeTasks = [],
	timing,
	now = new Date().toISOString(),
}: BuildSlotTaskUpdatePayloadsInput): UpdateTaskPayload[] {
	const payloads = new Map<string, UpdateTaskPayload>();
	const removeIds = new Set(removeTasks.map((task) => task.id));
	const addIds = new Set(addTasks.map((task) => task.id));

	for (const task of removeTasks) {
		if (task.time_slot_id !== slot.id) {
			fail(`Task "${task.id}" is not linked to slot "${slot.id}"`);
		}
	}

	for (const task of activeLinkedTasks(allTasks, slot.id)) {
		if (!timing.changed || removeIds.has(task.id)) continue;
		payloads.set(task.id, {
			id: task.id,
			date: timing.date,
			datetime: timing.startTime,
			datetime_tz: timing.timezone,
			time_slot_id: slot.id,
			status: 2,
			global_updated_at: now,
		});
	}

	for (const task of addTasks) {
		if (removeIds.has(task.id)) {
			fail(`Task "${task.id}" cannot be both added to and removed from a slot`);
		}
		payloads.set(task.id, {
			id: task.id,
			date: timing.date,
			datetime: timing.startTime,
			datetime_tz: timing.timezone,
			time_slot_id: slot.id,
			status: 2,
			global_updated_at: now,
		});
	}

	for (const task of removeTasks) {
		if (addIds.has(task.id)) {
			fail(`Task "${task.id}" cannot be both added to and removed from a slot`);
		}
		payloads.set(task.id, {
			id: task.id,
			time_slot_id: null,
			global_updated_at: now,
		});
	}

	return Array.from(payloads.values());
}

interface SlotWithTasks {
	slot: TimeSlot;
	tasks: Task[];
}

function toSlotWithTasks(slot: TimeSlot, tasks: Task[]): SlotWithTasks {
	return {
		slot,
		tasks: activeLinkedTasks(tasks, slot.id),
	};
}

function slotMatchesSearch(slot: TimeSlot, search: string): boolean {
	const query = search.trim().toLowerCase();
	if (!query) return true;
	return (
		slot.title.toLowerCase().includes(query) ||
		(slot.description ?? "").toLowerCase().includes(query)
	);
}

function slotOverlapsRange(
	slot: TimeSlot,
	range: { from: Date; to: Date },
): boolean {
	const start = new Date(slot.start_time);
	const end = new Date(slot.end_time);
	return start <= range.to && end >= range.from;
}

function resolveSlotListRange(
	args: Record<string, unknown>,
): { from: Date; to: Date } | null {
	const dateInput = args.date as string | undefined;
	const fromInput = args.from as string | undefined;
	const untilInput = args.until as string | undefined;

	if (dateInput && (fromInput || untilInput)) {
		fail("Use either --date or --from/--until, not both");
	}

	if (dateInput) {
		const range = resolveSingleDayRange(dateInput);
		if (!range) fail(`Could not parse date "${dateInput}"`);
		return range;
	}

	if (fromInput || untilInput) {
		if (!fromInput || !untilInput) {
			fail("Use --from and --until together for slot list ranges");
		}
		const from = parseDateBoundary(fromInput, "start");
		const to = parseDateBoundary(untilInput, "end");
		if (!from) fail(`Could not parse --from "${fromInput}"`);
		if (!to) fail(`Could not parse --until "${untilInput}"`);
		if (from > to) fail("--from must be before or equal to --until");
		return { from, to };
	}

	return null;
}

function selectSlots(
	slots: TimeSlot[],
	args: Record<string, unknown>,
): TimeSlot[] {
	const range = resolveSlotListRange(args);
	const search = args.search as string | undefined;

	return slots
		.filter((slot) => slot.deleted_at == null)
		.filter((slot) => (range ? slotOverlapsRange(slot, range) : true))
		.filter((slot) => (search ? slotMatchesSearch(slot, search) : true))
		.sort(
			(a, b) =>
				new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
		);
}

function printSlotList(items: SlotWithTasks[]): void {
	if (items.length === 0) {
		console.log("No Akiflow task slots found.");
		return;
	}

	console.log("Akiflow task slots");
	for (const { slot, tasks } of items) {
		const duration = formatDurationMinutes(slot.start_time, slot.end_time);
		const taskText = tasks.length === 1 ? "1 task" : `${tasks.length} tasks`;
		console.log(
			`${formatSlotDateTime(slot)}  ${slot.title}  ${slot.id}  ${duration}m  ${taskText}`,
		);
	}
}

function printSlotShow(item: SlotWithTasks): void {
	const { slot, tasks } = item;
	const duration = formatDurationMinutes(slot.start_time, slot.end_time);
	console.log("Akiflow task slot");
	console.log(`  ID: ${slot.id}`);
	console.log(`  Title: ${slot.title}`);
	console.log(`  Calendar: ${slot.calendar_id}`);
	console.log(`  Time: ${formatSlotDateTime(slot)} (${duration}m)`);
	if (slot.description) console.log(`  Description: ${slot.description}`);
	console.log(`  Linked tasks: ${tasks.length}`);
	for (const task of tasks) {
		console.log(`  - ${task.title ?? "(untitled task)"} (${task.id})`);
	}
}

export const listSlotCommand = defineCommand({
	meta: {
		name: "list",
		description: "List cached Akiflow task slots",
	},
	args: {
		date: {
			type: "string",
			description: "Single local date (YYYY-MM-DD or natural language)",
		},
		from: {
			type: "string",
			description: "Start date for slot range",
		},
		until: {
			type: "string",
			description: "End date for slot range",
		},
		search: {
			type: "string",
			alias: "s",
			description: "Search slot title or description",
		},
		json: {
			type: "boolean",
			description: "Output slots and linked tasks as JSON",
		},
	},
	run: async (context) => {
		const client = createClient();
		const args = context.args as Record<string, unknown>;
		const [slots, tasks] = await Promise.all([
			readResource(client, "time_slots"),
			readResource(client, "tasks"),
		]);
		const result = selectSlots(slots, args).map((slot) =>
			toSlotWithTasks(slot, tasks),
		);

		if (args.json === true) {
			console.log(JSON.stringify(result, null, 2));
			return;
		}

		printSlotList(result);
	},
});

export const showSlotCommand = defineCommand({
	meta: {
		name: "show",
		description: "Show a cached Akiflow task slot",
	},
	args: {
		id: {
			type: "positional",
			description: "Slot id or unique id prefix",
			required: true,
		},
		json: {
			type: "boolean",
			description: "Output slot and linked tasks as JSON",
		},
	},
	run: async (context) => {
		const client = createClient();
		const args = context.args as Record<string, unknown>;
		const [slots, tasks] = await Promise.all([
			readResource(client, "time_slots"),
			readResource(client, "tasks"),
		]);
		const slot = resolveCachedSlot(slots, args.id as string);
		requireActiveSlot(slot);
		const result = toSlotWithTasks(slot, tasks);

		if (args.json === true) {
			console.log(JSON.stringify(result, null, 2));
			return;
		}

		printSlotShow(result);
	},
});

export const updateSlotCommand = defineCommand({
	meta: {
		name: "update",
		description:
			"Move, resize, rename, or update existing task membership for a slot",
	},
	args: {
		id: {
			type: "positional",
			description: "Slot id or unique id prefix",
			required: true,
		},
		title: {
			type: "string",
			description: "New slot title",
		},
		date: {
			type: "string",
			description: "New slot date (YYYY-MM-DD or natural language)",
		},
		at: {
			type: "string",
			description: "New local start time (HH:MM)",
		},
		duration: {
			type: "string",
			description: "New slot duration (e.g., 30m, 1h)",
		},
		calendar: {
			type: "string",
			description: "Move slot to a writable calendar",
		},
		"add-task-id": {
			type: "string",
			description: "Existing task id or unique prefix to link to this slot",
		},
		"remove-task-id": {
			type: "string",
			description: "Existing task id or unique prefix to unlink from this slot",
		},
		json: {
			type: "boolean",
			description: "Output updated slot and patched tasks as JSON",
		},
	},
	run: async (context) => {
		const client = createClient();
		const args = context.args as Record<string, unknown>;
		const hasSlotFieldChange =
			args.title !== undefined ||
			args.date !== undefined ||
			args.at !== undefined ||
			args.duration !== undefined ||
			args.calendar !== undefined;
		const addTaskInputs = unique(stringValues(args["add-task-id"]));
		const removeTaskInputs = unique(stringValues(args["remove-task-id"]));
		const hasTaskChange =
			addTaskInputs.length > 0 || removeTaskInputs.length > 0;

		if (!hasSlotFieldChange && !hasTaskChange) {
			fail(
				"No changes provided. Pass --title, --date, --at, --duration, --calendar, --add-task-id, or --remove-task-id.",
			);
		}

		const [slots, tasks] = await Promise.all([
			readResource(client, "time_slots"),
			readResource(client, "tasks"),
		]);
		const slot = resolveCachedSlot(slots, args.id as string);
		requireActiveSlot(slot);

		const addTasks = addTaskInputs.map((taskId) =>
			resolveCachedTask(tasks, taskId),
		);
		const removeTasks = removeTaskInputs.map((taskId) =>
			resolveCachedTask(tasks, taskId),
		);
		const timing = resolveSlotTiming({
			slot,
			dateInput: args.date as string | undefined,
			atInput: args.at as string | undefined,
			durationInput: args.duration as string | undefined,
		});
		const now = new Date().toISOString();
		let calendarId: string | undefined;
		if (args.calendar !== undefined) {
			try {
				calendarId = (
					await resolveWritableCalendar(client, args.calendar as string)
				).id;
			} catch (error) {
				if (error instanceof CalendarResolutionError) {
					failCalendarResolution(error);
				}
				throw error;
			}
		}

		const taskPayloads = buildSlotTaskUpdatePayloads({
			slot,
			allTasks: tasks,
			addTasks,
			removeTasks,
			timing,
			now,
		});

		let updatedSlot: TimeSlot = slot;
		if (hasSlotFieldChange) {
			const slotPayload = buildSlotUpdatePayload({
				slot,
				title: args.title as string | undefined,
				calendarId,
				timing,
				now,
			});
			const slotResponse = await client.upsertTimeSlots([slotPayload]);
			updatedSlot = slotResponse.data[0] ?? slot;
			if (!slotResponse.data[0])
				fail("Failed to update slot - no data returned");
		}

		const updatedTasks =
			taskPayloads.length > 0
				? (await client.upsertTasks(taskPayloads)).data
				: [];

		if (args.json === true) {
			console.log(
				JSON.stringify(
					{
						slot: updatedSlot,
						tasks: updatedTasks,
					},
					null,
					2,
				),
			);
			return;
		}

		console.log("✓ Akiflow task slot updated successfully");
		console.log(`  ID: ${updatedSlot.id}`);
		console.log(`  Title: ${updatedSlot.title ?? slot.title}`);
		if (hasSlotFieldChange) {
			console.log(
				`  Time: ${formatSlotDateTime(updatedSlot)} (${formatDurationMinutes(
					updatedSlot.start_time,
					updatedSlot.end_time,
				)}m)`,
			);
		}
		if (taskPayloads.length > 0) {
			console.log(`  Patched tasks: ${updatedTasks.length}`);
		}
	},
});

export const deleteSlotCommand = defineCommand({
	meta: {
		name: "delete",
		description: "Soft-delete an Akiflow task slot",
	},
	args: {
		id: {
			type: "positional",
			description: "Slot id or unique id prefix",
			required: true,
		},
		json: {
			type: "boolean",
			description: "Output deleted slot as JSON",
		},
	},
	run: async (context) => {
		const client = createClient();
		const args = context.args as Record<string, unknown>;
		const slots = await readResource(client, "time_slots");
		const slot = resolveCachedSlot(slots, args.id as string);
		const payload = buildSlotDeletePayload({ slot });
		const response = await client.upsertTimeSlots([payload]);
		const deletedSlot = response.data[0];
		if (!deletedSlot) fail("Failed to delete slot - no data returned");

		if (args.json === true) {
			console.log(JSON.stringify(deletedSlot, null, 2));
			return;
		}

		console.log("✓ Akiflow task slot deleted successfully");
		console.log(`  ID: ${deletedSlot.id}`);
		console.log(`  Title: ${deletedSlot.title ?? slot.title}`);
	},
});

export const slotCommand = defineCommand({
	meta: {
		name: "slot",
		description: "Manage Akiflow task slots",
	},
	subCommands: {
		create: createSlotCommand,
		list: listSlotCommand,
		show: showSlotCommand,
		update: updateSlotCommand,
		delete: deleteSlotCommand,
	},
});
