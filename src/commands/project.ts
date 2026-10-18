import { randomUUID } from "node:crypto";
import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import { readResource } from "../lib/cache";
import {
	createProjectPayload,
	deleteProjectPayload,
	fetchProjects,
	fetchProjectTimeSlots,
	type ProjectChanges,
	type ProjectWrite,
	projectMembership,
	resolveProject,
	submitProject,
	updateProjectPayload,
	validateProjectChanges,
} from "../lib/projects";
import { readTasks } from "../lib/tasks";
import { verifyFlag } from "../lib/verify-flag";

function colorizeProjectColor(hexColor: string | null): string {
	if (!hexColor) {
		return "⚪";
	}
	return "●";
}

const projectListCommand = defineCommand({
	meta: {
		name: "list",
		description: "List all projects with task counts",
	},
	args: {
		json: {
			type: "boolean",
			description: "Output project records and membership counts as JSON",
		},
	},
	run: async ({ args }) => {
		const client = createClient();

		try {
			const labels = await readResource(client, "labels", { cacheOnly: true });
			const projects = labels.filter((label) => !label.deleted_at);

			const tasks = await readTasks(client);
			if (args.json) {
				console.log(
					JSON.stringify(
						projects.map((project) => ({
							...project,
							...projectMembership(project, tasks, projects),
						})),
						null,
						2,
					),
				);
				return;
			}

			if (projects.length === 0) {
				console.log("No projects found.");
				return;
			}

			console.log("\nProjects:");
			console.log("─".repeat(50));

			for (const project of projects) {
				const taskCount = projectMembership(
					project,
					tasks,
					projects,
				).task_count;
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

const projectShowCommand = defineCommand({
	meta: {
		name: "show",
		description: "Inspect one project by ID or exact unambiguous title",
	},
	args: {
		project: {
			type: "positional",
			required: true,
			description: "Project ID or exact title",
		},
		json: {
			type: "boolean",
			description: "Output project and membership counts as JSON",
		},
	},
	run: async ({ args }) => {
		try {
			const client = createClient();
			const projects = await readResource(client, "labels", {
				cacheOnly: true,
			});
			const project = resolveProject(projects, args.project);
			const tasks = await readTasks(client);
			const result = {
				...project,
				...projectMembership(project, tasks, projects),
			};
			if (args.json) console.log(JSON.stringify(result, null, 2));
			else
				console.log(
					`${project.title} (${project.id})\n${result.task_count} tasks; ${result.child_project_ids.length} child projects\nParent: ${project.parent_id ?? "none"}\nColor: ${project.color ?? "none"}\nIcon: ${project.icon ?? "none"}`,
				);
		} catch (error) {
			console.error(
				"Error:",
				error instanceof Error ? error.message : "Failed to inspect project",
			);
			process.exitCode = 1;
		}
	},
});

const mutationArgs = {
	json: {
		type: "boolean" as const,
		description: "Output versioned mutation receipt",
	},
	"dry-run": {
		type: "boolean" as const,
		description: "Preview fresh project changes without writing",
	},
	verify: verifyFlag,
};
const metadataArgs = {
	color: {
		type: "string" as const,
		description: "Palette color name, e.g. palette-blueberry",
	},
	icon: { type: "string" as const, description: "Project icon/emoji" },
	parent: { type: "string" as const, description: "Active folder ID" },
	sorting: { type: "string" as const, description: "Numeric sort position" },
	"clear-color": {
		type: "boolean" as const,
		description: "Clear the project color",
	},
	"clear-icon": {
		type: "boolean" as const,
		description: "Clear the project icon",
	},
	"clear-parent": {
		type: "boolean" as const,
		description: "Move to the root level",
	},
};
function readChanges(args: Record<string, unknown>): ProjectChanges {
	const changes: ProjectChanges = {};
	if (typeof args.title === "string") changes.title = args.title;
	for (const [flag, field] of [
		["color", "color"],
		["icon", "icon"],
		["parent", "parent_id"],
	] as const) {
		if (args[flag] !== undefined && args[`clear-${flag}`])
			throw new Error(`Cannot combine --${flag} with --clear-${flag}`);
		if (typeof args[flag] === "string") changes[field] = args[flag] as string;
		else if (args[`clear-${flag}`]) changes[field] = null;
	}
	if (args.sorting !== undefined) {
		if (typeof args.sorting !== "string" || !args.sorting.trim())
			throw new Error("Sorting must be a number");
		changes.sorting = Number(args.sorting);
	}
	return changes;
}
async function runProjectMutation(
	mode: "create" | "update" | "delete",
	args: Record<string, unknown>,
): Promise<void> {
	try {
		const client = createClient();
		const projects = await fetchProjects(client);
		const changes = readChanges(args);
		const project =
			mode === "create"
				? undefined
				: resolveProject(projects, String(args.project));
		validateProjectChanges(changes, projects, project?.id);
		const id = project?.id ?? randomUUID();
		const slots = mode === "delete" ? await fetchProjectTimeSlots(client) : [];
		let payload: ProjectWrite;
		if (mode === "create") payload = createProjectPayload(id, changes);
		else {
			if (!project) throw new Error("Project not found");
			payload =
				mode === "update"
					? updateProjectPayload(project, changes)
					: deleteProjectPayload(project, projects, slots);
		}
		const tasks = project ? await client.getAllTasks() : [];
		const effects = project
			? {
					...projectMembership(project, tasks, projects),
					tasks_preserved: true,
				}
			: { task_count: 0, tasks_preserved: true };
		if (args["dry-run"]) {
			console.log(
				JSON.stringify(
					{ command: `project ${mode}`, dry_run: true, payload, effects },
					null,
					2,
				),
			);
			return;
		}
		if (mode === "delete" && !args.yes)
			throw new Error(
				"Project deletion requires --yes; inspect --dry-run first. Tasks are preserved.",
			);
		const receipt = await submitProject(client, payload, args.verify === true);
		const warnings =
			mode === "delete"
				? [
						"Tasks are preserved with their existing project references; deleted projects no longer appear as active projects.",
					]
				: [];
		if (args.json)
			console.log(
				JSON.stringify(
					{
						schema_version: 1,
						command: `project ${mode}`,
						status: receipt.status,
						receipts: [receipt],
						result: { id, effects },
						errors: receipt.error ? [receipt.error] : [],
						warnings,
					},
					null,
					2,
				),
			);
		else {
			console.log(`${receipt.status}: project ${id}`);
			for (const warning of warnings) console.error(warning);
			if (receipt.error) console.error(receipt.error);
		}
		if (!["accepted", "verified"].includes(receipt.status))
			process.exitCode = 1;
	} catch (error) {
		console.error(
			"Error:",
			error instanceof Error ? error.message : "Project mutation failed",
		);
		process.exitCode = 1;
	}
}
const projectCreateCommand = defineCommand({
	meta: {
		name: "create",
		description:
			"Create a project (ordinary project, optionally inside a folder)",
	},
	args: {
		title: {
			type: "positional",
			required: true,
			description: "Project title, 1–250 characters",
		},
		...metadataArgs,
		...mutationArgs,
	},
	run: async ({ args }) => runProjectMutation("create", args),
});
const projectUpdateCommand = defineCommand({
	meta: {
		name: "update",
		description: "Update or rename a project while preserving omitted fields",
	},
	args: {
		project: {
			type: "positional",
			required: true,
			description: "Project ID or exact unambiguous title",
		},
		title: { type: "string", description: "New project title" },
		...metadataArgs,
		...mutationArgs,
	},
	run: async ({ args }) => runProjectMutation("update", args),
});
const projectDeleteCommand = defineCommand({
	meta: {
		name: "delete",
		description:
			"Soft-delete a project while preserving tasks; related sections/time slots must be removed first",
	},
	args: {
		project: {
			type: "positional",
			required: true,
			description: "Project ID or exact unambiguous title",
		},
		yes: {
			type: "boolean",
			description: "Confirm project deletion (tasks preserved)",
		},
		...mutationArgs,
	},
	run: async ({ args }) => runProjectMutation("delete", args),
});

export const projectCommand = defineCommand({
	meta: {
		name: "project",
		description: "Inspect and manage Akiflow projects",
	},
	subCommands: {
		list: projectListCommand,
		show: projectShowCommand,
		create: projectCreateCommand,
		update: projectUpdateCommand,
		delete: projectDeleteCommand,
	},
});
