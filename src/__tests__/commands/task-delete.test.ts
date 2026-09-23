import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskDeleteCommand } from "../../commands/task";
import type { Task } from "../../lib/api/types";
import * as storage from "../../lib/auth/storage";
import { addPendingTask, loadPendingTasks } from "../../lib/task-cache";

const originalAfCacheDir = process.env.AF_CACHE_DIR;
const taskId = "11111111-2222-4333-8444-555555555555";

describe("task delete command", () => {
	let testCacheDir: string;
	let fetchSpy: ReturnType<typeof spyOn>;
	let loadCredentialsSpy: ReturnType<typeof spyOn>;
	let consoleSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		testCacheDir = mkdtempSync(join(tmpdir(), "af-task-delete-test-"));
		process.env.AF_CACHE_DIR = testCacheDir;
		fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					message: null,
					data: [{ id: taskId, deleted_at: "2026-06-20T00:00:00.000Z" }],
				}),
				{ status: 200 },
			),
		);
		loadCredentialsSpy = spyOn(storage, "loadCredentials").mockResolvedValue({
			token: "test-token",
			clientId: "test-client-id",
			expiryTimestamp: Date.now() + 60_000,
		});
		consoleSpy = spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		loadCredentialsSpy.mockRestore();
		consoleSpy.mockRestore();
		rmSync(testCacheDir, { recursive: true, force: true });
		if (originalAfCacheDir === undefined) delete process.env.AF_CACHE_DIR;
		else process.env.AF_CACHE_DIR = originalAfCacheDir;
	});

	it("removes a successfully deleted task from the pending cache", async () => {
		await addPendingTask({
			id: taskId,
			title: "Pending temp task",
			deleted_at: null,
		} as Task);

		expect(await loadPendingTasks()).toHaveLength(1);

		await taskDeleteCommand.run?.({
			args: { id: taskId },
			rawArgs: [],
		} as unknown as Parameters<NonNullable<typeof taskDeleteCommand.run>>[0]);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(await loadPendingTasks()).toHaveLength(0);
		expect(consoleSpy).toHaveBeenCalledWith(`✓ Deleted task "${taskId}"`);
	});
});
