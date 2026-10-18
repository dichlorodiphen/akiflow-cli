import type { AkiflowClient } from "./api/client";
import type { Label, Task } from "./api/types";

/** A fresh, complete project observation. Never publishes into the local cache. */
export async function fetchProjects(
	client: Pick<AkiflowClient, "getLabels">,
): Promise<Label[]> {
	const rows = new Map<string, Label>();
	const seen = new Set<string>();
	let cursor: string | undefined;
	for (let page = 0; page < 1000; page++) {
		const response = await client.getLabels({ limit: 2500, syncToken: cursor });
		if (!response.success || !Array.isArray(response.data)) {
			throw new Error(
				`Project pagination failed: ${response.message ?? "invalid response"}`,
			);
		}
		for (const row of response.data) {
			if (!row || typeof row.id !== "string" || !row.id)
				throw new Error("Project response contains an invalid ID");
			rows.set(row.id, row);
		}
		if (response.has_next_page !== true) return [...rows.values()];
		if (!response.sync_token || seen.has(response.sync_token)) {
			throw new Error(
				"Project pagination failed: missing or non-advancing sync_token",
			);
		}
		seen.add(response.sync_token);
		cursor = response.sync_token;
	}
	throw new Error(
		"Project pagination exceeded 1000 pages; results are incomplete",
	);
}

/** Exact IDs win; names must identify exactly one active project. */
export function resolveProject(projects: Label[], selector: string): Label {
	if (!selector.trim())
		throw new Error("Project ID or exact title is required");
	const active = projects.filter((project) => !project.deleted_at);
	const byId = active.find((project) => project.id === selector);
	if (byId) return byId;
	const byTitle = active.filter((project) => project.title === selector);
	if (byTitle.length > 1)
		throw new Error(
			`Ambiguous project title '${selector}'; use an explicit project ID`,
		);
	if (byTitle.length === 1 && byTitle[0]) return byTitle[0];
	throw new Error(`Project not found: ${selector}`);
}

export function projectMembership(
	project: Label,
	tasks: Task[],
	projects: Label[],
): {
	task_count: number;
	pending_task_count: number;
	child_project_ids: string[];
} {
	const members = tasks.filter(
		(task) => task.listId === project.id && !task.deleted_at,
	);
	return {
		task_count: members.length,
		pending_task_count: members.filter((task) => task.pending).length,
		child_project_ids: projects
			.filter((row) => row.parent_id === project.id && !row.deleted_at)
			.map((row) => row.id),
	};
}

export type ProjectWrite = { id: string } & Record<string, unknown>;
export interface ProjectChanges {
	title?: string;
	color?: string | null;
	icon?: string | null;
	parent_id?: string | null;
	sorting?: number;
}

export function validateProjectChanges(
	changes: ProjectChanges,
	projects: Label[],
	id?: string,
): void {
	if (
		changes.title !== undefined &&
		(!changes.title.trim() || changes.title.length > 250)
	)
		throw new Error("Project title must contain 1–250 characters");
	if (
		changes.color !== undefined &&
		changes.color !== null &&
		!/^palette-[a-z]+$/.test(changes.color)
	)
		throw new Error(
			"Project color must be a palette name (e.g. palette-blueberry) or cleared explicitly",
		);
	if (changes.sorting !== undefined && !Number.isFinite(changes.sorting))
		throw new Error("Project sorting must be a finite number");
	if (changes.parent_id) {
		const parent = projects.find(
			(row) => row.id === changes.parent_id && !row.deleted_at,
		);
		if (!parent || parent.type !== "folder")
			throw new Error("A project parent must be an active folder ID");
		if (parent.id === id) throw new Error("A project cannot be its own parent");
	}
}

export function createProjectPayload(
	id: string,
	changes: ProjectChanges,
	now = new Date().toISOString(),
): ProjectWrite {
	return {
		id,
		title: changes.title,
		color: changes.color ?? null,
		icon: changes.icon ?? null,
		parent_id: changes.parent_id ?? null,
		sorting: changes.sorting ?? Date.parse(now),
		type: null,
		data: {},
		global_created_at: now,
		global_updated_at: now,
		deleted_at: null,
	};
}
export function updateProjectPayload(
	project: Label,
	changes: ProjectChanges,
	now = new Date().toISOString(),
): ProjectWrite {
	if (project.type === "folder" || project.type === "section")
		throw new Error(
			"Project mutations target projects; folders and sections are inspection-only",
		);
	if (Object.keys(changes).length === 0)
		throw new Error("No project changes requested");
	return { id: project.id, ...changes, global_updated_at: now };
}
export function deleteProjectPayload(
	project: Label,
	projects: Label[],
	slots: Array<{ label_id?: string | null; deleted_at?: string | null }>,
	now = new Date().toISOString(),
): ProjectWrite {
	if (project.type === "folder" || project.type === "section")
		throw new Error(
			"Project deletion targets ordinary projects; use the Akiflow UI for folders/sections",
		);
	if (projects.some((row) => row.parent_id === project.id && !row.deleted_at))
		throw new Error(
			"Project contains sections/children; remove them in Akiflow before CLI deletion",
		);
	if (slots.some((row) => row.label_id === project.id && !row.deleted_at))
		throw new Error(
			"Project is assigned to time slots; remove those assignments before CLI deletion",
		);
	// UI's 'just delete project' lifecycle retains tasks, and clears project presentation fields.
	return {
		id: project.id,
		title: null,
		icon: null,
		color: null,
		sorting: null,
		parent_id: null,
		deleted_at: now,
		global_updated_at: now,
	};
}

export interface ProjectReceipt {
	id: string;
	resource: "project";
	status:
		| "accepted"
		| "verified"
		| "failed"
		| "unknown"
		| "pending"
		| "timeout";
	error?: string;
}
export async function submitProject(
	client: Pick<AkiflowClient, "upsertLabels" | "getLabels">,
	payload: ProjectWrite,
	verify: boolean,
	timeoutMs = 15000,
): Promise<ProjectReceipt> {
	let receipt: ProjectReceipt;
	try {
		const response = await client.upsertLabels([payload]);
		const failure = response.failed?.find((row) => row.id === payload.id);
		if (failure)
			return {
				id: payload.id,
				resource: "project",
				status: "failed",
				error:
					typeof failure.error === "string"
						? failure.error
						: "Server rejected project mutation",
			};
		const match = response.data?.find((row) => row.id === payload.id);
		receipt = {
			id: payload.id,
			resource: "project",
			status: response.success === true && match ? "accepted" : "unknown",
			...(!(response.success === true && match)
				? {
						error:
							"No successful matching project result returned; do not automatically retry",
					}
				: {}),
		};
	} catch {
		return {
			id: payload.id,
			resource: "project",
			status: "unknown",
			error:
				"Project transport failed; outcome unknown. Inspect project state before any manual retry.",
		};
	}
	if (!verify || receipt.status !== "accepted") return receipt;
	const deadline = Date.now() + timeoutMs;
	let mismatch = false;
	while (Date.now() < deadline) {
		try {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const observed = await Promise.race([
				fetchProjects(client),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error("Project verification deadline elapsed")),
						Math.max(0, deadline - Date.now()),
					);
				}),
			]).finally(() => {
				if (timer) clearTimeout(timer);
			});
			const project = observed.find((row) => row.id === payload.id);
			if (
				payload.deleted_at
					? !project || !!project.deleted_at
					: project &&
						!project.deleted_at &&
						Object.entries(payload)
							.filter(
								([key]) =>
									!["global_created_at", "global_updated_at"].includes(key),
							)
							.every(
								([key, expected]) =>
									JSON.stringify(
										(project as unknown as Record<string, unknown>)[key],
									) === JSON.stringify(expected),
							)
			)
				return { ...receipt, status: "verified" };
			mismatch = !!project;
		} catch {
			return {
				...receipt,
				status: "timeout",
				error: "Fresh project verification failed; outcome remains unconfirmed",
			};
		}
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))),
		);
	}
	return {
		...receipt,
		status: mismatch ? "pending" : "timeout",
		error:
			"Project not confirmed before verification deadline; do not automatically resubmit",
	};
}

/** Delete guards must use a complete fresh slot set rather than a possibly stale cache. */
export async function fetchProjectTimeSlots(
	client: Pick<AkiflowClient, "getTimeSlots">,
): Promise<Array<{ label_id?: string | null; deleted_at?: string | null }>> {
	const rows = new Map<
		string,
		{ label_id?: string | null; deleted_at?: string | null }
	>();
	const seen = new Set<string>();
	let cursor: string | undefined;
	for (let page = 0; page < 1000; page++) {
		const response = await client.getTimeSlots({
			limit: 2500,
			syncToken: cursor,
		});
		if (!response.success || !Array.isArray(response.data))
			throw new Error(
				"Cannot establish fresh complete project time-slot membership",
			);
		for (const row of response.data) rows.set(row.id, row);
		if (!response.has_next_page) return [...rows.values()];
		if (!response.sync_token || seen.has(response.sync_token))
			throw new Error(
				"Time-slot pagination did not advance; refusing project deletion",
			);
		seen.add(response.sync_token);
		cursor = response.sync_token;
	}
	throw new Error("Time-slot pagination incomplete; refusing project deletion");
}
