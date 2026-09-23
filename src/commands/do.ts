import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import type { UpdateTaskPayload } from "../lib/api/types";
import {
	readTaskContext,
	resolveTaskId,
	taskTitleFromContext,
} from "../lib/task-context";

function collectTaskIds(args: Record<string, unknown>): string[] {
	const positional = Array.isArray(args._) ? [...args._] : [];
	if (
		positional.length > 0 &&
		String(positional[0]) === String(args.id ?? "")
	) {
		positional.shift();
	}

	return [args.id, ...positional]
		.flatMap((value) => {
			if (value == null) return [];
			return Array.isArray(value) ? value : [value];
		})
		.flatMap((value) =>
			String(value)
				.split(",")
				.map((part) => part.trim())
				.filter(Boolean),
		);
}

export const taskCompleteCommand = defineCommand({
	meta: {
		name: "complete",
		description: "Mark tasks as complete by short ID or UUID",
	},
	args: {
		id: {
			type: "positional",
			description:
				"Task ID, short ID, or unique ID prefix; additional IDs may follow",
			required: true,
		},
		json: {
			type: "boolean",
			description: "Output completed task IDs as JSON",
		},
	},
	run: async (context) => {
		const args = context.args as Record<string, unknown>;
		const ids = collectTaskIds(args);

		if (!ids || ids.length === 0) {
			console.error("Error: No task IDs provided");
			process.exit(1);
		}

		const contextFile = readTaskContext();

		const resolvedTasks: Array<{ id: string; title: string }> = [];
		const failedIds: string[] = [];

		for (const id of ids) {
			let resolvedId: string | null = null;
			try {
				resolvedId = resolveTaskId(id, contextFile);
			} catch (error) {
				console.error(
					`Error: ${error instanceof Error ? error.message : error}`,
				);
				process.exit(1);
			}
			if (resolvedId) {
				const title = taskTitleFromContext(resolvedId, contextFile);
				resolvedTasks.push({
					id: resolvedId,
					title: title || resolvedId,
				});
			} else {
				failedIds.push(id);
			}
		}

		if (failedIds.length > 0) {
			console.error(
				`Error: Could not resolve task IDs: ${failedIds.join(", ")}`,
			);
			if (!contextFile) {
				console.error(
					"Short IDs and partial IDs require context. Run 'af task list --plain' first or provide full UUIDs.",
				);
			}
			if (resolvedTasks.length === 0) {
				process.exit(1);
			}
		}

		const client = createClient();
		const now = Date.now();
		const timestamp = new Date(now).toISOString();

		const updatePayloads: UpdateTaskPayload[] = resolvedTasks.map((task) => ({
			id: task.id,
			done: true,
			done_at: timestamp,
			status: 2,
			global_updated_at: timestamp,
		}));

		try {
			const response = await client.upsertTasks(updatePayloads);

			if (response.success) {
				if (args.json === true) {
					console.log(
						JSON.stringify(
							{ result: resolvedTasks, next_cursor: null, errors: [] },
							null,
							2,
						),
					);
					return;
				}
				console.log(`✓ Completed ${resolvedTasks.length} task(s):`);
				for (const task of resolvedTasks) {
					console.log(`  • ${task.title}`);
				}
			} else {
				console.error("Error: Failed to complete tasks");
				console.error(response.message);
				process.exit(1);
			}
		} catch (error) {
			console.error("Error: Failed to complete tasks");
			if (error instanceof Error) {
				console.error(error.message);
			}
			process.exit(1);
		}
	},
});

export const doCommand = taskCompleteCommand;
