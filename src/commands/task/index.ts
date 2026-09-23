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
	parseDuration,
	parseDurationToSeconds,
} from "../../lib/duration-parser";
import { removePendingTask } from "../../lib/task-cache";
import { readTaskContext, resolveTaskId } from "../../lib/task-context";
import { createTaskCommand } from "../create";
import { taskCompleteCommand } from "../do";
import { taskListCommand } from "../ls";

function formatDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function fail(message: string): never {
	console.error(`Error: ${message}`);
	process.exit(1);
}

function resolveTaskIdentifier(identifier: string): string {
	const contextFile = readTaskContext();
	try {
		const taskId = resolveTaskId(identifier, contextFile);
		if (taskId) return taskId;
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}

	const suffix = contextFile
		? ""
		: " Short IDs and partial IDs require context. Run 'af task list --plain' first or provide a full UUID.";
	fail(`Could not resolve task ID "${identifier}".${suffix}`);
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
		json: {
			type: "boolean",
			description: "Output updated task as JSON",
		},
	},
	run: async (context) => {
		const args = context.args as Record<string, unknown>;
		const taskId = resolveTaskIdentifier(args.id as string);
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
		const response = await client.upsertTasks([updatePayload]);
		const updatedTask = response.data[0];

		if (!response.success || !updatedTask) {
			console.error("Error: Failed to update task");
			if (response.message) console.error(response.message);
			process.exit(1);
		}

		if (args.json === true) {
			console.log(JSON.stringify(updatedTask, null, 2));
			return;
		}

		console.log("✓ Updated task successfully");
		console.log(`  ID: ${updatedTask.id}`);
		console.log(`  Title: ${updatedTask.title ?? updatePayload.title ?? ""}`);
	},
});

export const taskPlanCommand = defineCommand({
	meta: {
		name: "plan",
		description: "Schedule task for a specific date",
	},
	args: {
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
		const taskId = resolveTaskIdentifier(id);

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

		try {
			const response = await client.upsertTasks([updatePayload]);

			if (response.success) {
				if (atArg) {
					console.log(`✓ Scheduled task "${id}" for ${dateStr} at ${atArg}`);
				} else {
					console.log(`✓ Scheduled task "${id}" for ${dateStr}`);
				}
			} else {
				console.error("Error: Failed to schedule task");
				console.error(response.message);
				process.exit(1);
			}
		} catch (error) {
			console.error("Error: Failed to schedule task");
			if (error instanceof Error) {
				console.error(error.message);
			}
			process.exit(1);
		}
	},
});

export const taskSnoozeCommand = defineCommand({
	meta: {
		name: "snooze",
		description: "Push task back by a duration (e.g., 1h, 2d, 1w)",
	},
	args: {
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
		const taskId = resolveTaskIdentifier(id);

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
		const allTasksResponse = await client.getTasks();
		if (!allTasksResponse.success || !allTasksResponse.data) {
			console.error("Error: Failed to fetch tasks");
			process.exit(1);
		}

		const task = allTasksResponse.data.find((t) => t.id === taskId);
		if (!task) {
			console.error(`Error: Task with ID "${taskId}" not found`);
			process.exit(1);
		}

		let baseDate = task.date ? new Date(task.date) : new Date();
		if (Number.isNaN(baseDate.getTime())) {
			baseDate = new Date();
		}

		const newDate = new Date(baseDate.getTime() + snoozeDuration);
		const dateStr = formatDate(newDate);
		const timestamp = new Date().toISOString();

		const updatePayload: UpdateTaskPayload = {
			id: taskId,
			date: dateStr,
			global_updated_at: timestamp,
		};

		try {
			const response = await client.upsertTasks([updatePayload]);

			if (response.success) {
				console.log(`✓ Snoozed task "${id}" to ${dateStr}`);
			} else {
				console.error("Error: Failed to snooze task");
				console.error(response.message);
				process.exit(1);
			}
		} catch (error) {
			console.error("Error: Failed to snooze task");
			if (error instanceof Error) {
				console.error(error.message);
			}
			process.exit(1);
		}
	},
});

export const taskDeleteCommand = defineCommand({
	meta: {
		name: "delete",
		description: "Soft delete a task",
	},
	args: {
		id: {
			type: "positional",
			description: "Task ID (short ID or UUID)",
			required: true,
		},
	},
	run: async (context) => {
		const id = context.args.id as string;
		const taskId = resolveTaskIdentifier(id);

		const client = createClient();
		const timestamp = new Date().toISOString();

		const updatePayload: UpdateTaskPayload = {
			id: taskId,
			deleted_at: timestamp,
			global_updated_at: timestamp,
		};

		try {
			const response = await client.upsertTasks([updatePayload]);

			if (response.success) {
				await removePendingTask(taskId);
				console.log(`✓ Deleted task "${id}"`);
			} else {
				console.error("Error: Failed to delete task");
				console.error(response.message);
				process.exit(1);
			}
		} catch (error) {
			console.error("Error: Failed to delete task");
			if (error instanceof Error) {
				console.error(error.message);
			}
			process.exit(1);
		}
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
