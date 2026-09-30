import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import type { Task } from "../lib/api/types";
import { readResource } from "../lib/cache";
import { readTasks } from "../lib/tasks";

function colorizeProjectColor(hexColor: string | null): string {
	if (!hexColor) {
		return "⚪";
	}
	return "●";
}

function countTasksForProjectId(tasks: Task[], projectId: string): number {
	return tasks.filter((task) => task.listId === projectId && !task.deleted_at)
		.length;
}

const projectListCommand = defineCommand({
	meta: {
		name: "list",
		description: "List all projects with task counts",
	},
	run: async () => {
		const client = createClient();

		try {
			const labels = await readResource(client, "labels", { cacheOnly: true });
			const projects = labels.filter((label) => !label.deleted_at);

			if (projects.length === 0) {
				console.log("No projects found.");
				return;
			}

			console.log("\nProjects:");
			console.log("─".repeat(50));

			const tasks = await readTasks(client);

			for (const project of projects) {
				const taskCount = countTasksForProjectId(tasks, project.id);
				const colorIndicator = colorizeProjectColor(project.color);
				const pendingCount = tasks.filter(
					(task) => task.listId === project.id && task.pending,
				).length;
				const taskText = `${taskCount === 1 ? "task" : "tasks"}${pendingCount ? ` (${pendingCount} pending)` : ""}`;
				console.log(
					`${colorIndicator} ${project.title.padEnd(30)} ${taskCount} ${taskText}`,
				);
			}

			console.log("─".repeat(50));
		} catch (error) {
			console.error(
				"Error:",
				error instanceof Error ? error.message : "Failed to list projects",
			);
			process.exit(1);
		}
	},
});

export const projectCommand = defineCommand({
	meta: {
		name: "project",
		description: "Inspect Akiflow projects",
	},
	subCommands: {
		list: projectListCommand,
	},
});
