import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import type { UpdateTaskPayload } from "../lib/api/types";
import {
	readTaskContext,
	resolveTaskId,
	taskTitleFromContext,
} from "../lib/task-context";
import {
	printTaskMutation,
	taskMutationOutcome,
	unknownTaskOutcome,
} from "../lib/task-mutation-output";
import { verifyFlag } from "../lib/verify-flag";

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
		verify: verifyFlag,
		id: {
			type: "positional",
			description:
				"Task ID, short ID, or unique ID prefix; additional IDs may follow",
			required: true,
		},
		json: {
			type: "boolean",
			description: "Output versioned mutation receipts as JSON",
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
			const outcome = await taskMutationOutcome(
				client,
				response,
				updatePayloads,
				args.verify === true,
			);
			if (failedIds.length > 0) {
				outcome.ok = false;
				outcome.errors.push(
					`Could not resolve task IDs: ${failedIds.join(", ")}`,
				);
				outcome.receipts.push(
					...failedIds.map((id) => ({
						id,
						resource: "task" as const,
						status: "failed" as const,
						error: "Could not resolve task ID",
					})),
				);
			}
			printTaskMutation(
				"task complete",
				args.json === true,
				[outcome],
				resolvedTasks.filter((task) =>
					outcome.receipts.some(
						(r) =>
							r.id === task.id && ["accepted", "verified"].includes(r.status),
					),
				),
			);
		} catch (error) {
			printTaskMutation(
				"task complete",
				args.json === true,
				[
					unknownTaskOutcome(
						updatePayloads.map((p) => p.id),
						error,
					),
				],
				null,
			);
		}
	},
});

export const doCommand = taskCompleteCommand;
