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
import { readTaskContext, resolveTaskId } from "../../lib/task-context";
import {
	printTaskMutation,
	taskMutationOutcome,
	unknownTaskOutcome,
} from "../../lib/task-mutation-output";
import { readTasks, recordTaskIntent } from "../../lib/tasks";
import { verifyFlag } from "../../lib/verify-flag";
import { createTaskCommand } from "../create";
import { taskCompleteCommand } from "../do";
import { taskListCommand } from "../ls";

async function submitTaskMutation(
	client: ReturnType<typeof createClient>,
	command: string,
	args: Record<string, unknown>,
	payload: UpdateTaskPayload,
	intentKind: "update" | "plan" | "snooze" | "complete" | "delete" = "update",
): Promise<boolean> {
	try {
		const response = await client.upsertTasks([payload]);
		const outcome = await taskMutationOutcome(
			client,
			response,
			[payload],
			args.verify === true,
		);
		// Record pending intent for accepted/verified receipts (workstream D).
		for (const receipt of outcome.receipts) {
			if (receipt.status === "accepted" || receipt.status === "verified") {
				await recordTaskIntent(intentKind, payload);
			}
		}
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
			"update",
		);
	},
});

export const taskPlanCommand = defineCommand({
	meta: {
		name: "plan",
		description: "Schedule task for a specific date",
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
	},
	run: async (context) => {
		const id = context.args.id as string;
		const dateArg = context.args.date as string | undefined;
		const atArg = context.args.at as string | undefined;
		const taskId = resolveTaskIdentifier(
			id,
			context.args.snapshot as string | undefined,
		);

		let dateStr: string;

		if (dateArg) {
			const dateMatch = dateArg.match(/^(\d{4})-(\d{2})-(\d{2})$/);
			if (dateMatch) {
				dateStr = dateMatch[0];
			} else {
				const parsedDate = parseDate(dateArg);
				if (parsedDate) {
					dateStr = parsedDate;
				} else {
					console.error(
						`Error: Invalid date format "${dateArg}". Use YYYY-MM-DD or natural language (e.g., "today", "tomorrow", "next friday").`,
					);
					process.exit(1);
				}
			}
		} else if (atArg) {
			dateStr = getTodayDate();
		} else {
			console.error("Error: Either --date or --at must be specified.");
			process.exit(1);
		}

		const scheduledDate = new Date(dateStr);
		if (Number.isNaN(scheduledDate.getTime())) {
			console.error(`Error: Invalid date "${dateArg}"`);
			process.exit(1);
		}

		const client = createClient();
		const timestamp = new Date().toISOString();

		const updatePayload: UpdateTaskPayload = {
			id: taskId,
			date: dateStr,
			status: 2,
			global_updated_at: timestamp,
		};

		if (atArg) {
			const parsedTime = parseTime(atArg);
			if (!parsedTime) {
				console.error(
					`Error: Invalid time format "${atArg}". Use HH:MM format (e.g., "21:00", "14:30").`,
				);
				process.exit(1);
			}

			updatePayload.datetime = createDateTimeUTC(
				dateStr,
				parsedTime.hours,
				parsedTime.minutes,
			);
			updatePayload.datetime_tz = getLocalTimezone();
		}

		if (
			!atArg &&
			(await readTasks(client)).find((t) => t.id === taskId)?.datetime
		) {
			updatePayload.datetime = null;
			updatePayload.datetime_tz = null;
		}

		if (context.args["dry-run"]) {
			printDryRun(
				[previewItem(await cachedTask(taskId), updatePayload)],
				context.args.json === true,
			);
			return;
		}
		await submitTaskMutation(client, "task plan", context.args, updatePayload, "plan");
	},
});

export const taskSnoozeCommand = defineCommand({
	meta: {
		name: "snooze",
		description: "Push task back by a duration (e.g., 1h, 2d, 1w)",
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
			description: "Duration to snooze (e.g., 1h, 2d, 1w)",
			required: true,
		},
	},
	run: async (context) => {
		const id = context.args.id as string;
		const durationArg = context.args.duration as string;
		const taskId = resolveTaskIdentifier(
			id,
			context.args.snapshot as string | undefined,
		);

		let snoozeDuration: number;
		try {
			snoozeDuration = parseDuration(durationArg);
		} catch (error) {
			console.error(
				`Error: ${error instanceof Error ? error.message : "Invalid duration"}`,
			);
			process.exit(1);
		}

		const client = createClient();
		const allTasksResponse = context.args["dry-run"]
			? { success: true, data: [await cachedTask(taskId)] }
			: { success: true, data: await readTasks(client) };
		if (!allTasksResponse.success || !allTasksResponse.data) {
			console.error("Error: Failed to fetch tasks");
			process.exit(1);
		}

		const task = allTasksResponse.data.find((t) => t.id === taskId);
		if (!task) {
			console.error(`Error: Task with ID "${taskId}" not found`);
			process.exit(1);
		}

		let baseDate = task.datetime
			? new Date(task.datetime)
			: task.date
				? new Date(task.date)
				: new Date();
		if (Number.isNaN(baseDate.getTime())) {
			baseDate = new Date();
		}

		const newDate = new Date(baseDate.getTime() + snoozeDuration);
		const dateStr = formatDate(newDate);
		const timestamp = new Date().toISOString();

		const updatePayload: UpdateTaskPayload = {
			id: taskId,
			date: dateStr,
			status: 2,
			global_updated_at: timestamp,
		};

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
			"snooze",
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
			"delete",
		);
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
