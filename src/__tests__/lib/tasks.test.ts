import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../../lib/api/types";
import {
	readResource,
	refreshResource,
	upsertResourceRecords,
} from "../../lib/cache";
import { setAtomicWriteHook } from "../../lib/cache/atomic";
import {
	emptyContext,
	toCleanedCalView,
	toCleanedTaskView,
} from "../../lib/format/cleaned-types";
import { cacheFile } from "../../lib/platform-config";
import { resolveTaskId } from "../../lib/task-context";
import { readTasks, recordTaskIntent } from "../../lib/tasks";
import fixtures from "../integration/fixtures/tasks.json";

const id = "11111111-2222-4333-8444-555555555555";
const fixture = (fields: Partial<Task> = {}): Task =>
	({
		...fixtures[0],
		id,
		title: "Observed",
		done: false,
		deleted_at: null,
		trashed_at: null,
		global_updated_at: "2026-01-01T00:00:00.000Z",
		...fields,
	}) as Task;
const offline = {
	get: async () => {
		throw new Error("unexpected network read");
	},
} as never;
let dir: string;
let oldCache: string | undefined;
beforeEach(() => {
	oldCache = process.env.AF_CACHE_DIR;
	dir = mkdtempSync(join(tmpdir(), "af-repository-"));
	process.env.AF_CACHE_DIR = dir;
});
afterEach(() => {
	setAtomicWriteHook();
	rmSync(dir, { recursive: true, force: true });
	rmSync(`${dir}.lock.reclaim`, { force: true });
	if (oldCache === undefined) delete process.env.AF_CACHE_DIR;
	else process.env.AF_CACHE_DIR = oldCache;
});
const journal = () =>
	JSON.parse(readFileSync(cacheFile("pending-tasks.json"), "utf8")).intents;

describe("unified task repository", () => {
	test("marks overlays in raw, cleaned list and calendar output without changing observations", async () => {
		await upsertResourceRecords("tasks", [fixture()]);
		await recordTaskIntent("update", { id, title: "Pending" });
		const [row] = await readTasks(offline);
		expect(row!.title).toBe("Pending");
		expect(row!.pending).toBe(true);
		expect(toCleanedTaskView(row!, emptyContext()).pending).toBe(true);
		expect(
			toCleanedCalView(
				{
					type: "task",
					record: row!,
					start: new Date("2026-01-01"),
					end: null,
				},
				emptyContext(),
			).pending,
		).toBe(true);
		expect(
			(await readResource(offline, "tasks", { cacheOnly: true }))[0]!.title,
		).toBe("Observed");
		expect(journal()[0]).toMatchObject({
			taskId: id,
			kind: "update",
			baseObservedVersion: "2026-01-01T00:00:00.000Z",
		});
		expect(journal()[0].intentId).toMatch(/^[a-f0-9-]{36}$/);
	});
	test("unacknowledged creates survive advancing the clock past the old TTL", async () => {
		await recordTaskIntent("create", fixture());
		const now = Date.now();
		const clock = spyOn(Date, "now").mockReturnValue(now + 365 * 86400000);
		try {
			expect((await readTasks())[0]).toMatchObject({ id, pending: true });
			expect(journal()).toHaveLength(1);
		} finally {
			clock.mockRestore();
		}
	});
	test("reconciles fields, never mere ID presence or a newer version alone", async () => {
		await upsertResourceRecords("tasks", [fixture()]);
		await recordTaskIntent("update", { id, title: "New" });
		await readTasks();
		expect(journal()).toHaveLength(1);
		await upsertResourceRecords("tasks", [
			fixture({ global_updated_at: "2026-02-01", title: "Other" }),
		]);
		const warning = spyOn(console, "error").mockImplementation(() => {});
		try {
			expect((await readTasks())[0]).toMatchObject({
				title: "New",
				pending: true,
			});
			expect(warning).toHaveBeenCalled();
		} finally {
			warning.mockRestore();
		}
		await upsertResourceRecords("tasks", [fixture({ title: "New" })]);
		expect((await readTasks())[0]!.pending).toBeUndefined();
		expect(journal()).toHaveLength(0);
	});
	test("field confirmation compares nested JSON values independent of object key order", async () => {
		await upsertResourceRecords("tasks", [fixture()]);
		await recordTaskIntent("update", {
			id,
			content: { first: 1, second: { a: 2, b: 3 } },
		});
		await upsertResourceRecords("tasks", [
			fixture({ content: { second: { b: 3, a: 2 }, first: 1 } }),
		]);
		expect((await readTasks())[0]?.pending).toBeUndefined();
		expect(journal()).toHaveLength(0);
	});
	test("completion stays sticky through stale and conflicting observations until field confirmation", async () => {
		await upsertResourceRecords("tasks", [fixture()]);
		await recordTaskIntent("complete", {
			id,
			done: true,
			done_at: "2026-02-01",
			status: 2,
		});
		for (let i = 0; i < 3; i++)
			expect((await readTasks())[0]).toMatchObject({
				done: true,
				pending: true,
			});
		await upsertResourceRecords("tasks", [
			fixture({ global_updated_at: "2026-03-01" }),
		]);
		const warning = spyOn(console, "error").mockImplementation(() => {});
		try {
			const row = (await readTasks())[0]!;
			expect(row.done).toBe(true);
			expect(row.pending_conflict).toContain("conflicts");
			expect(warning).toHaveBeenCalled();
		} finally {
			warning.mockRestore();
		}
		await upsertResourceRecords("tasks", [
			fixture({ done: true, done_at: "2026-02-01", status: 2 }),
		]);
		expect((await readTasks())[0]).toMatchObject({ done: true });
		expect(journal()).toHaveLength(0);
	});
	test("later fields supersede earlier intents and the final state acknowledges the chain", async () => {
		await recordTaskIntent("create", { id, title: "First" }, fixture());
		await recordTaskIntent("update", { id, title: "Second" });
		await recordTaskIntent("plan", { id, date: "2026-02-01" });
		expect((await readTasks())[0]).toMatchObject({
			title: "Second",
			date: "2026-02-01",
			pending: true,
		});
		await upsertResourceRecords("tasks", [
			fixture({ title: "Second", date: "2026-02-01" }),
		]);
		await readTasks();
		expect(journal()).toHaveLength(0);
	});
	test("delete hides observations and only a newer task sync can confirm absence", async () => {
		await upsertResourceRecords("tasks", [fixture()]);
		await recordTaskIntent("delete", { id, deleted_at: "2026-02-01" });
		expect(await readTasks()).toHaveLength(0);
		expect(
			await readResource(offline, "tasks", { cacheOnly: true }),
		).toHaveLength(1);
		await refreshResource(
			{
				get: async () => ({
					success: true,
					message: null,
					data: [{ id, deleted_at: "2026-02-01" }],
					sync_token: "confirmed",
				}),
			} as never,
			"tasks",
		);
		await readTasks();
		expect(journal()).toHaveLength(0);
	});
	test("a create followed by delete never resurrects when a delayed create observation arrives", async () => {
		await recordTaskIntent("create", { id, title: "Late" }, fixture());
		await recordTaskIntent("delete", { id, deleted_at: "2026-02-01" });
		expect(await readTasks()).toHaveLength(0);
		expect(journal()).toHaveLength(2);
		await upsertResourceRecords("tasks", [fixture({ title: "Late" })]);
		expect(await readTasks()).toHaveLength(0);
		expect(journal()).toHaveLength(2);
	});
	test("retains trash observations but filters query visibility unless explicitly requested", async () => {
		await upsertResourceRecords("tasks", [
			fixture({ trashed_at: "2026-02-01", status: 10 }),
		]);
		expect(await readTasks()).toHaveLength(0);
		expect(await readTasks(offline, { includeTrashed: true })).toHaveLength(1);
		expect(
			await readResource(offline, "tasks", { cacheOnly: true }),
		).toHaveLength(1);
	});
	test("virtual identifiers and numeric context pointing at virtuals cannot enter intents", async () => {
		const virtual = `virtual:${id}:2026-01-01`;
		const context = {
			timestamp: 0,
			tasks: [
				{ shortId: 1, id: virtual, title: "Virtual" },
				{ shortId: 2, id, title: "Real" },
			],
		};
		expect(() => resolveTaskId("1", context)).toThrow("Synthetic task ID");
		expect(() => resolveTaskId(virtual, null)).toThrow("Synthetic task ID");
		expect(() => resolveTaskId("virtual:", context)).toThrow(
			"Synthetic task ID",
		);
		expect(resolveTaskId("2", context)).toBe(id);
		await expect(
			recordTaskIntent("complete", { id: virtual, done: true }),
		).rejects.toThrow("Synthetic");
		expect(existsSync(cacheFile("pending-tasks.json"))).toBe(false);
	});
	test("atomic failure leaves the old journal intact", async () => {
		await recordTaskIntent("create", { id, title: "First" });
		setAtomicWriteHook((path) => {
			if (path.endsWith("pending-tasks.json"))
				throw new Error("injected failure");
		});
		await expect(
			recordTaskIntent("update", { id, title: "Torn" }),
		).rejects.toThrow("injected failure");
		setAtomicWriteHook();
		expect((await readTasks())[0]!.title).toBe("First");
		expect(journal()).toHaveLength(1);
	});
	test("parallel readers and writers lose no intents or fields and never see torn journals", async () => {
		await upsertResourceRecords("tasks", [fixture()]);
		const fields = [
			{ title: "Concurrent" },
			{ description: "Description" },
			{ date: "2026-02-01" },
			{ duration: 300 },
			{ priority: 3 },
		];
		await Promise.all(
			fields.flatMap((field) => [
				recordTaskIntent("update", { id, ...field }),
				readTasks(),
			]),
		);
		expect(journal()).toHaveLength(fields.length);
		expect((await readTasks())[0]).toMatchObject(
			Object.assign({ pending: true }, ...fields),
		);
	});
	test("migrates old pending creates without their TTL and refuses corrupt journals", async () => {
		writeFileSync(
			cacheFile("pending-tasks.json"),
			JSON.stringify({ tasks: [{ task: fixture(), createdAt: 0 }] }),
		);
		expect((await readTasks())[0]!.pending).toBe(true);
		expect(journal()).toHaveLength(1);
		writeFileSync(cacheFile("pending-tasks.json"), "{broken");
		await expect(readTasks()).rejects.toThrow();
	});
	test("explicit generation tombstones confirm deletion of an unobserved pending create", async () => {
		await recordTaskIntent("create", { id, title: "Never observed" });
		await recordTaskIntent("delete", { id, deleted_at: "2026-02-01" });
		await refreshResource(
			{
				get: async () => ({
					success: true,
					message: null,
					data: [{ id, status: 9, deleted_at: "2026-02-01" }],
					sync_token: "deleted",
				}),
			} as never,
			"tasks",
		);
		expect(await readTasks()).toHaveLength(0);
		expect(journal()).toHaveLength(0);
	});
	test("cold and stale task reads stay local even when automatic sync is enabled", async () => {
		const previous = process.env.AF_NO_AUTO_SYNC;
		process.env.AF_NO_AUTO_SYNC = "";
		try {
			expect(await readTasks(offline)).toHaveLength(0);
			await upsertResourceRecords("tasks", [fixture()]);
			expect((await readTasks(offline))[0]!.pending).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.AF_NO_AUTO_SYNC;
			else process.env.AF_NO_AUTO_SYNC = previous;
		}
	});
	test("legacy observed replica has been removed", () => {
		expect(
			existsSync(join(import.meta.dir, "../../lib/tasks-local-cache.ts")),
		).toBe(false);
	});
});
