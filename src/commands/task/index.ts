import { readFile } from "node:fs/promises";
import { defineCommand } from "citty";
import { createClient } from "../../lib/api/client";
import type { UpdateTaskPayload } from "../../lib/api/types";
import {
	createDateTimeUTC,
	getLocalTimezone,
	getTodayDate,
	parseDate,
	parseTime,
} from "../../lib/date-parser";
import {
	cachedTask,
	dryRunArgs,
	previewItem,
	printDryRun,
	snapshotArgs,
} from "../../lib/dry-run";
import {
	parseDuration,
	parseDurationToSeconds,
} from "../../lib/duration-parser";
import { removePendingTask } from "../../lib/task-cache";
import { readTaskContext, resolveTaskId } from "../../lib/task-context";
import {
	printTaskMutation,
	taskMutationOutcome,
	unknownTaskOutcome,
} from "../../lib/task-mutation-output";
import {
	addCalendarDays,
	addElapsedMillis,
	formatInTimezone,
	utcToDateString,
	zonedTimeToUtc,
} from "../../lib/timezone";
import {
	resolveEffectiveTimezone,
	resolveEffectiveTimezoneSync,
} from "../../lib/timezone-profile";
import { verifyFlag } from "../../lib/verify-flag";
import { createTaskCommand } from "../create";
import { taskCompleteCommand } from "../do";
import { taskListCommand } from "../ls";

async function submitTaskMutation(
	client: ReturnType<typeof createClient>,
	command: string,
	args: Record<string, unknown>,
	payload: UpdateTaskPayload,
): Promise<boolean> {
	try {
		const response = await client.upsertTasks([payload]);
		const outcome = await taskMutationOutcome(
			client,
			response,
			[payload],
			args.verify === true,
		);
		return printTaskMutation(
			command,
			args.json === true,
			[outcome],
			response.data.find((record) => record.id === payload.id) ?? null,
		);
	} catch (error) {
		return printTaskMutation(
			command,
			args.json === true,
			[unknownTaskOutcome([payload.id], error)],
			null,
		);
	}
}

function formatDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function fail(message: string, exitCode = 1): never {
	console.error(`Error: ${message}`);
	process.exit(exitCode);
}

function resolveTaskIdentifier(identifier: string, snapshot?: string): string {
	const contextFile = readTaskContext();
	try {
		const taskId = resolveTaskId(identifier, contextFile, { snapshot });
		if (taskId) return taskId;
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), 2);
	}

	const suffix = contextFile
		? ""
		: " Numeric short IDs require list context. Run 'af task list --plain' first or provide a full UUID.";
	fail(`Could not resolve task ID "${identifier}".${suffix}`, 4);
}

async function resolveDescriptionUpdate(
	description: string | undefined,
	descriptionFile: string | undefined,
): Promise<string | undefined> {
	if (description !== undefined && descriptionFile !== undefined) {
		fail("Use either --description or --description-file, not both");
	}

	if (descriptionFile === undefined) return description;

	try {
		return await readFile(descriptionFile, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		fail(`Could not read description file "${descriptionFile}": ${message}`);
	}
}

export const taskUpdateCommand = defineCommand({
	meta: {
		name: "update",
		description: "Update basic fields for an Akiflow task",
	},
	args: {
		...dryRunArgs,
		...snapshotArgs,
		verify: verifyFlag,
		json: {
			type: "boolean",
			description: "Output mutation receipt envelope as JSON",
		},
		id: {
			type: "positional",
			description: "Task ID, short ID, or unique ID prefix",
			required: true,
		},
		title: {
			type: "string",
			description: "New task title",
		},
		description: {
			type: "string",
			description: "New task description",
		},
		"description-file": {
			type: "string",
			description: "Read task description from a UTF-8 text file",
		},
		duration: {
			type: "string",
			description: "Task duration (e.g., '30m', '1h')",
		},
		project: {
			type: "string",
			description: "Project/list id",
		},
		priority: {
			type: "string",
			description: "Priority 1-3",
		},
	},
	run: async (context) => {
		const args = context.args as Record<string, unknown>;
		const taskId = resolveTaskIdentifier(
			args.id as string,
			args.snapshot as string | undefined,
		);
		const description = await resolveDescriptionUpdate(
			args.description as string | undefined,
			args["description-file"] as string | undefined,
		);
		const timestamp = new Date().toISOString();
		const updatePayload: UpdateTaskPayload = {
			id: taskId,
			global_updated_at: timestamp,
		};

		if (args.title !== undefined) updatePayload.title = args.title as string;
		if (description !== undefined) updatePayload.description = description;
		if (args.duration !== undefined) {
			updatePayload.duration = parseDurationToSeconds(args.duration as string);
		}
		if (args.project !== undefined)
			updatePayload.listId = args.project as string;
		if (args.priority !== undefined) {
			const priority = Number(args.priority);
			if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
				fail("Priority must be 1, 2, or 3");
			}
			updatePayload.priority = priority;
		}

		const changedKeys = Object.keys(updatePayload).filter(
			(key) => key !== "id" && key !== "global_updated_at",
		);
		if (changedKeys.length === 0) {
			fail(
				"No changes provided. Pass --title, --description, --description-file, --duration, --project, or --priority.",
			);
		}

		const client = createClient();
		if (context.args["dry-run"]) {
			printDryRun(
				[previewItem(await cachedTask(taskId), updatePayload)],
				context.args.json === true,
			);
			return;
		}
		await submitTaskMutation(
			client,
			"task update",
			context.args,
			updatePayload,
		);
	},
});

export const taskPlanCommand = defineCommand({
	meta: {
		name: "plan",
		description:
			"Schedule task for a specific date. Date-only --date preserves the task's wall-clock time by default; use --clear-time to make it date-only.",
	},
	args: {
		...dryRunArgs,
		...snapshotArgs,
		verify: verifyFlag,
		json: {
			type: "boolean",
			description: "Output mutation receipt envelope as JSON",
		},
		id: {
			type: "positional",
			description: "Task ID (short ID or UUID)",
			required: true,
		},
		date: {
			type: "string",
			description: "Date to schedule task (YYYY-MM-DD or natural language)",
			required: false,
		},
		at: {
			type: "string",
			description: "Time for scheduling (e.g., 21:00, 14:30)",
			required: false,
		},
		"clear-time": {
			type: "boolean",
			description:
				"Remove the time component, making the task date-only (all-day)",
		},
		timezone: {
			type: "string",
			description:
				"IANA timezone for interpreting --date/--at (defaults to the task's timezone, then profile, then local)",
		},
		fold: {
			type: "string",
			description:
				'Disambiguate DST fold: "first" (before transition) or "second" (after). Required if the time is ambiguous.',
		},
	},
	run: async (context) => {
		const id = context.args.id as string;
		const dateArg = context.args.date as string | undefined;
		const atArg = context.args.at as string | undefined;
		const clearTime = context.args["clear-time"] === true;
		const taskId = resolveTaskIdentifier(
			id,
			context.args.snapshot as string | undefined,
		);

		const foldArg = context.args.fold as string | undefined;
		if (foldArg !== undefined && foldArg !== "first" && foldArg !== "second") {
			console.error(
				`Error: Invalid --fold "${foldArg}". Expected "first" or "second".`,
			);
			process.exit(2);
		}
		const fold = foldArg as "first" | "second" | undefined;

		if (clearTime && atArg) {
			console.error("Error: --clear-time cannot be combined with --at.");
			process.exit(2);
		}

		let dateStr: string;

		if (dateArg) {
			const dateMatch = dateArg.match(/^(\d{4})-(\d{2})-(\d{2})$/);
			if (dateMatch) {
				// Validate it's a real calendar date (rejects 2026-02-30).
				try {
					const { parseCalendarDate } = await import("../../lib/timezone");
					parseCalendarDate(dateMatch[0]);
				} catch (error) {
					console.error(
						`Error: ${error instanceof Error ? error.message : String(error)}`,
					);
					process.exit(2);
				}
				dateStr = dateMatch[0];
			} else {
				const parsedDate = parseDate(dateArg);
				if (parsedDate) {
					dateStr = parsedDate;
				} else {
					console.error(
						`Error: Invalid date format "${dateArg}". Use YYYY-MM-DD or natural language (e.g., "today", "tomorrow", "next friday").`,
					);
					process.exit(2);
				}
			}
		} else if (atArg) {
			dateStr = getTodayDate();
		} else {
			console.error("Error: Either --date or --at must be specified.");
			process.exit(2);
		}

		const client = createClient();
		const timestamp = new Date().toISOString();

		// For wall-clock preservation and timezone resolution, we need the
		// current task. Try the local cache first (without exiting if missing),
		// then fall back to the server.
		let existingTask: import("../../lib/api/types").Task | null = null;
		try {
			const { cacheFile } = await import("../../lib/platform-config");
			const { readAllRecords } = await import("../../lib/cache/jsonl-store");
			const tasks = await readAllRecords<import("../../lib/api/types").Task>(
				cacheFile("tasks.jsonl"),
			);
			existingTask = tasks.find((t) => t.id === taskId) ?? null;
		} catch {
			// Cache read failed; try server below.
		}
		if (!existingTask) {
			try {
				const tasksResponse = await client.getTasks();
				if (tasksResponse.success && tasksResponse.data) {
					existingTask =
						tasksResponse.data.find((t) => t.id === taskId) ?? null;
				}
			} catch {
				// Server fetch failed; proceed without existing task data.
				// Wall-clock preservation won't apply, but the plan can still work.
			}
		}

		// Resolve effective timezone: explicit flag > task's timezone > profile > local.
		let timezone: string;
		try {
			const explicitTz = context.args.timezone as string | undefined;
			if (explicitTz) {
				const { validateTimezone } = await import("../../lib/timezone");
				timezone = validateTimezone(explicitTz);
			} else if (existingTask?.datetime_tz) {
				timezone = existingTask.datetime_tz;
			} else {
				timezone = await resolveEffectiveTimezone();
			}
		} catch (error) {
			console.error(
				`Error: ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(2);
		}

		const updatePayload: UpdateTaskPayload = {
			id: taskId,
			date: dateStr,
			global_updated_at: timestamp,
		};

		try {
			if (clearTime) {
				// Explicitly make the task date-only.
				updatePayload.datetime = null;
				updatePayload.datetime_tz = null;
			} else if (atArg) {
				const parsedTime = parseTime(atArg);
				if (!parsedTime) {
					console.error(
						`Error: Invalid time format "${atArg}". Use HH:MM format (e.g., "21:00", "14:30").`,
					);
					process.exit(2);
				}

				updatePayload.datetime = zonedTimeToUtc(
					dateStr,
					parsedTime.hours,
					parsedTime.minutes,
					timezone,
					fold,
				);
				updatePayload.datetime_tz = timezone;
			} else if (existingTask?.datetime) {
				// Date-only --date on a timed task: preserve the wall-clock time
				// by default. Move the existing wall-clock time to the new date
				// in the task's timezone (or the explicit --timezone).
				const wall = formatInTimezone(existingTask.datetime, timezone);
				updatePayload.datetime = zonedTimeToUtc(
					dateStr,
					wall.hours,
					wall.minutes,
					timezone,
					fold,
				);
				updatePayload.datetime_tz = timezone;
			}
			// If the task has no datetime and no --at, it's date-only; just set date.
		} catch (error) {
			console.error(
				`Error: ${error instanceof Error ? error.message : String(error)}`,
			);
			const name = error instanceof Error ? error.name : "";
			process.exit(
				name === "DSTGapError" ||
					name === "DSTFoldError" ||
					name === "InvalidCalendarDateError" ||
					name === "InvalidTimezoneError"
					? 2
					: 1,
			);
		}

		if (context.args["dry-run"]) {
			printDryRun(
				[previewItem(await cachedTask(taskId), updatePayload)],
				context.args.json === true,
			);
			return;
		}
		await submitTaskMutation(client, "task plan", context.args, updatePayload);
	},
});

export const taskSnoozeCommand = defineCommand({
	meta: {
		name: "snooze",
		description:
			"Push task back by a duration. Timed tasks shift their datetime (wall-clock preserved for day/week units, elapsed for minute/hour units); date-only tasks shift their date.",
	},
	args: {
		...dryRunArgs,
		...snapshotArgs,
		verify: verifyFlag,
		json: {
			type: "boolean",
			description: "Output mutation receipt envelope as JSON",
		},
		id: {
			type: "positional",
			description: "Task ID (short ID or UUID)",
			required: true,
		},
		duration: {
			type: "string",
			description:
				"Duration to snooze (e.g., 1h, 2d, 1w). For timed tasks: m/h are elapsed time, d/w preserve wall-clock time in the task's timezone.",
			required: true,
		},
		timezone: {
			type: "string",
			description:
				"IANA timezone for interpreting the snooze (defaults to the task's timezone, then profile, then local)",
		},
		fold: {
			type: "string",
			description:
				'Disambiguate DST fold: "first" (before transition) or "second" (after). Required if the result lands in a fold.',
		},
	},
	run: async (context) => {
		const id = context.args.id as string;
		const durationArg = context.args.duration as string;
		const taskId = resolveTaskIdentifier(
			id,
			context.args.snapshot as string | undefined,
		);

		// Parse duration into value + unit to decide elapsed vs wall-day basis.
		const durationMatch = durationArg.trim().toLowerCase().match(/^(\d+)\s*([mhdw])$/);
		if (!durationMatch) {
			console.error(
				`Error: Invalid duration format "${durationArg}". Expected format: <number><unit> (e.g., 1h, 2d, 1w)`,
			);
			process.exit(2);
		}
		const durationValue = parseInt(durationMatch[1]!, 10);
		const durationUnit = durationMatch[2]!;
		let snoozeMillis: number;
		try {
			snoozeMillis = parseDuration(durationArg);
		} catch (error) {
			console.error(
				`Error: ${error instanceof Error ? error.message : "Invalid duration"}`,
			);
			process.exit(2);
		}

		const foldArg = context.args.fold as string | undefined;
		if (foldArg !== undefined && foldArg !== "first" && foldArg !== "second") {
			console.error(
				`Error: Invalid --fold "${foldArg}". Expected "first" or "second".`,
			);
			process.exit(2);
		}
		const fold = foldArg as "first" | "second" | undefined;

		const client = createClient();
		const allTasksResponse = context.args["dry-run"]
			? { success: true, data: [await cachedTask(taskId)] }
			: await client.getTasks();
		if (!allTasksResponse.success || !allTasksResponse.data) {
			console.error("Error: Failed to fetch tasks");
			process.exit(1);
		}

		const task = allTasksResponse.data.find((t) => t.id === taskId);
		if (!task) {
			console.error(`Error: Task with ID "${taskId}" not found`);
			process.exit(1);
		}

		// Resolve the timezone: explicit flag > task's timezone > profile > local.
		let timezone: string;
		try {
			const explicitTz = context.args.timezone as string | undefined;
			if (explicitTz) {
				const { validateTimezone } = await import("../../lib/timezone");
				timezone = validateTimezone(explicitTz);
			} else if (task.datetime_tz) {
				timezone = task.datetime_tz;
			} else {
				timezone = await resolveEffectiveTimezone();
			}
		} catch (error) {
			console.error(
				`Error: ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(2);
		}

		const timestamp = new Date().toISOString();
		const updatePayload: UpdateTaskPayload = {
			id: taskId,
			global_updated_at: timestamp,
		};

		try {
			if (task.datetime) {
				// Timed task: move the actual datetime.
				// - m/h units: elapsed basis (add milliseconds to the UTC instant).
				// - d/w units: wall-day basis (preserve wall-clock in the task's timezone).
				let newDatetime: string;
				if (durationUnit === "m" || durationUnit === "h") {
					newDatetime = addElapsedMillis(task.datetime, snoozeMillis);
				} else {
					const days = durationUnit === "d" ? durationValue : durationValue * 7;
					newDatetime = addCalendarDays(task.datetime, days, timezone, fold);
				}
				updatePayload.datetime = newDatetime;
				updatePayload.datetime_tz = timezone;
				// Keep the date field in sync with the datetime's date in the task's timezone.
				updatePayload.date = utcToDateString(newDatetime, timezone);
			} else {
				// Date-only task: move the date by calendar days.
				// m/h units are converted to fractional days? No — for date-only tasks,
				// sub-day snoozes don't make sense. Treat m/h as 0 days minimum 1?
				// Actually: for date-only, we move by calendar days. m/h round up to 1 day.
				let days: number;
				if (durationUnit === "m" || durationUnit === "h") {
					// Sub-day snooze on a date-only task: move to next day (can't represent time).
					days = 1;
				} else {
					days = durationUnit === "d" ? durationValue : durationValue * 7;
				}
				const baseDateStr = task.date ?? formatDate(new Date());
				const { parseCalendarDate } = await import("../../lib/timezone");
				const { year, month, day } = parseCalendarDate(baseDateStr);
				const base = new Date(Date.UTC(year, month - 1, day));
				base.setUTCDate(base.getUTCDate() + days);
				const y = base.getUTCFullYear();
				const m = String(base.getUTCMonth() + 1).padStart(2, "0");
				const d = String(base.getUTCDate()).padStart(2, "0");
				updatePayload.date = `${y}-${m}-${d}`;
			}
		} catch (error) {
			console.error(
				`Error: ${error instanceof Error ? error.message : String(error)}`,
			);
			// DST errors and validation errors are usage errors (exit 2).
			const name = error instanceof Error ? error.name : "";
			process.exit(
				name === "DSTGapError" ||
					name === "DSTFoldError" ||
					name === "InvalidCalendarDateError" ||
					name === "InvalidTimezoneError"
					? 2
					: 1,
			);
		}

		if (context.args["dry-run"]) {
			printDryRun(
				[previewItem(await cachedTask(taskId), updatePayload)],
				context.args.json === true,
			);
			return;
		}
		await submitTaskMutation(
			client,
			"task snooze",
			context.args,
			updatePayload,
		);
	},
});

export const taskDeleteCommand = defineCommand({
	meta: {
		name: "delete",
		description: "Soft delete a task",
	},
	args: {
		...dryRunArgs,
		...snapshotArgs,
		verify: verifyFlag,
		json: {
			type: "boolean",
			description: "Output mutation receipt envelope as JSON",
		},
		id: {
			type: "positional",
			description: "Task ID (short ID or UUID)",
			required: true,
		},
	},
	run: async (context) => {
		const id = context.args.id as string;
		const taskId = resolveTaskIdentifier(
			id,
			context.args.snapshot as string | undefined,
		);

		const client = createClient();
		const timestamp = new Date().toISOString();

		const updatePayload: UpdateTaskPayload = {
			id: taskId,
			deleted_at: timestamp,
			global_updated_at: timestamp,
		};

		if (context.args["dry-run"]) {
			printDryRun(
				[previewItem(await cachedTask(taskId), updatePayload)],
				context.args.json === true,
			);
			return;
		}
		const ok = await submitTaskMutation(
			client,
			"task delete",
			context.args,
			updatePayload,
		);
		if (ok) await removePendingTask(taskId);
	},
});

export const taskCommand = defineCommand({
	meta: {
		name: "task",
		description: "Task management subcommands",
	},
	subCommands: {
		list: taskListCommand,
		create: createTaskCommand,
		complete: taskCompleteCommand,
		update: taskUpdateCommand,
		plan: taskPlanCommand,
		snooze: taskSnoozeCommand,
		delete: taskDeleteCommand,
	},
});
