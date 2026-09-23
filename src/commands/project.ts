import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import type { Task } from "../lib/api/types";
import { syncTasksCache } from "../lib/tasks-local-cache";

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
			const response = await client.getLabels();
			const projects = response.data.filter((label) => !label.deleted_at);

			if (projects.length === 0) {
				console.log("No projects found.");
				return;
			}

			console.log("\nProjects:");
			console.log("─".repeat(50));

			const { tasks } = await syncTasksCache(client, { quiet: true });

			for (const project of projects) {
				const taskCount = countTasksForProjectId(tasks, project.id);
				const colorIndicator = colorizeProjectColor(project.color);
				const taskText = taskCount === 1 ? "task" : "tasks";
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
