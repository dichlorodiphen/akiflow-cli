import { describe, expect, it } from "bun:test";
import type { Label, Task } from "../../lib/api/types";
import {
	fetchProjects,
	projectMembership,
	resolveProject,
} from "../../lib/projects";

function project(
	id: string,
	title = "Project",
	patch: Partial<Label> = {},
): Label {
	return {
		id,
		title,
		user_id: 1,
		parent_id: null,
		icon: null,
		color: null,
		sorting: 0,
		type: null,
		global_created_at: "2026-10-18T00:00:00Z",
		global_updated_at: "2026-10-18T00:00:00Z",
		data: {},
		deleted_at: null,
		...patch,
	};
}

describe("project observations and identity", () => {
	it("paginates fully and folds later versions by ID", async () => {
		const calls: unknown[] = [];
		const rows = await fetchProjects({
			getLabels: async (options) => {
				calls.push(options);
				return options?.syncToken
					? {
							success: true,
							message: "",
							data: [project("one", "New"), project("two")],
							has_next_page: false,
						}
					: {
							success: true,
							message: "",
							data: [project("one", "Old")],
							has_next_page: true,
							sync_token: "next",
						};
			},
		});
		expect(rows.map((row) => row.title)).toEqual(["New", "Project"]);
		expect(calls).toEqual([
			{ limit: 2500, syncToken: undefined },
			{ limit: 2500, syncToken: "next" },
		]);
	});
	it("rejects incomplete observations rather than using a partial project set", async () => {
		await expect(
			fetchProjects({
				getLabels: async () => ({
					success: true,
					message: "",
					data: [project("one")],
					has_next_page: true,
					sync_token: "same",
				}),
			}),
		).rejects.toThrow("non-advancing");
		await expect(
			fetchProjects({
				getLabels: async () => ({
					success: false,
					data: [],
					message: "denied",
				}),
			}),
		).rejects.toThrow("denied");
	});
	it("requires exact unambiguous names and gives explicit IDs precedence", () => {
		const rows = [
			project("one", "Work"),
			project("two", "Work"),
			project("Work", "Different"),
			project("deleted", "Old", { deleted_at: "2026-10-18" }),
		];
		expect(resolveProject(rows, "Work").id).toBe("Work");
		expect(() => resolveProject(rows.slice(0, 2), "Work")).toThrow("Ambiguous");
		expect(() => resolveProject(rows, "Wor")).toThrow("not found");
		expect(() => resolveProject(rows, "deleted")).toThrow("not found");
	});
	it("counts live membership and child projects without including trash", () => {
		const parent = project("parent");
		const tasks = [
			{ listId: "parent", pending: true },
			{ listId: "parent", deleted_at: "2026-10-18" },
			{ listId: "other" },
		] as Task[];
		expect(
			projectMembership(parent, tasks, [
				parent,
				project("child", "Child", { parent_id: "parent" }),
				project("trash", "Trash", {
					parent_id: "parent",
					deleted_at: "2026-10-18",
				}),
			]),
		).toEqual({
			task_count: 1,
			pending_task_count: 1,
			child_project_ids: ["child"],
		});
	});
});

describe("project mutation safety", () => {
	it("creates the official project defaults and updates only requested fields", async () => {
		const { createProjectPayload, updateProjectPayload } = await import(
			"../../lib/projects"
		);
		const now = "2026-10-18T00:00:00.000Z";
		expect(createProjectPayload("new", { title: "New" }, now)).toMatchObject({
			id: "new",
			title: "New",
			icon: null,
			color: null,
			sorting: Date.parse(now),
			parent_id: null,
			type: null,
			data: {},
			deleted_at: null,
		});
		expect(
			updateProjectPayload(project("one"), { title: "Renamed" }, now),
		).toEqual({ id: "one", title: "Renamed", global_updated_at: now });
	});
	it("requires real folder parents and rejects unsupported lifecycle targets", async () => {
		const {
			validateProjectChanges,
			updateProjectPayload,
			deleteProjectPayload,
		} = await import("../../lib/projects");
		expect(() =>
			validateProjectChanges({ parent_id: "ordinary" }, [project("ordinary")]),
		).toThrow("folder");
		expect(() =>
			validateProjectChanges({ title: " ", sorting: Number.NaN }, []),
		).toThrow("title");
		expect(() =>
			updateProjectPayload(project("folder", "Folder", { type: "folder" }), {
				title: "New",
			}),
		).toThrow("inspection-only");
		expect(() =>
			deleteProjectPayload(
				project("one"),
				[project("section", "Section", { parent_id: "one", type: "section" })],
				[],
			),
		).toThrow("children");
		expect(() =>
			deleteProjectPayload(project("one"), [], [{ label_id: "one" }]),
		).toThrow("time slots");
	});
	it("soft deletion retains task membership and only writes project tombstone fields", async () => {
		const { deleteProjectPayload } = await import("../../lib/projects");
		const payload = deleteProjectPayload(
			project("one"),
			[],
			[],
			"2026-10-18T00:00:00Z",
		);
		expect(payload).toEqual({
			id: "one",
			title: null,
			icon: null,
			color: null,
			sorting: null,
			parent_id: null,
			deleted_at: "2026-10-18T00:00:00Z",
			global_updated_at: "2026-10-18T00:00:00Z",
		});
	});
	it("never replays an uncertain write and requires a matching successful record", async () => {
		const { submitProject } = await import("../../lib/projects");
		let writes = 0;
		const failed = await submitProject(
			{
				upsertLabels: async () => {
					writes++;
					throw new Error("reset");
				},
				getLabels: async () => {
					throw new Error("must not verify an unknown submission");
				},
			},
			{ id: "one", title: "New" },
			true,
		);
		expect(writes).toBe(1);
		expect(failed.status).toBe("unknown");
		const missing = await submitProject(
			{
				upsertLabels: async () => ({
					success: true,
					message: "",
					data: [project("other")],
				}),
				getLabels: async () => {
					throw new Error("must not verify unknown");
				},
			},
			{ id: "one" },
			true,
		);
		expect(missing.status).toBe("unknown");
	});
	it("verifies changed fields from fresh complete observation without cache writes", async () => {
		const { submitProject } = await import("../../lib/projects");
		const result = await submitProject(
			{
				upsertLabels: async () => ({
					success: true,
					message: "",
					data: [project("one", "Old")],
				}),
				getLabels: async () => ({
					success: true,
					message: "",
					data: [project("one", "New")],
				}),
			},
			{ id: "one", title: "New" },
			true,
			1000,
		);
		expect(result.status).toBe("verified");
	});
});

it("bounds fresh project verification even when the observation never resolves", async () => {
	const { submitProject } = await import("../../lib/projects");
	let writes = 0;
	const started = Date.now();
	const result = await submitProject(
		{
			upsertLabels: async () => {
				writes++;
				return { success: true, message: "", data: [project("one")] };
			},
			getLabels: async () => new Promise(() => {}),
		},
		{ id: "one", title: "New" },
		true,
		20,
	);
	expect(result.status).toBe("timeout");
	expect(writes).toBe(1);
	expect(Date.now() - started).toBeLessThan(250);
});
