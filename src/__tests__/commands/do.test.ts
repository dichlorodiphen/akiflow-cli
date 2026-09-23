import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doCommand } from "../../commands/do";

class ExitError extends Error {
	constructor(public code: number) {
		super(`process.exit(${code})`);
	}
}

const originalAfCacheDir = process.env.AF_CACHE_DIR;
let testCacheDir: string;
let testContextFile: string;

const mockContextFile = {
	tasks: [
		{ shortId: 1, id: "abc123def456", title: "Buy groceries" },
		{ shortId: 2, id: "xyz789uvw012", title: "Write report" },
		{ shortId: 3, id: "pqr345stu678", title: "Call client" },
	],
	timestamp: Date.now(),
};

describe("task complete command", () => {
	// Track every spyOn() return value created during a test so the
	// afterEach can mockRestore() them. Without this, `spyOn(globalThis,
	// "fetch")` calls leak across tests — later tests pick up an existing
	// spy with the previous test's recorded calls, which manifested as
	// `task.test.ts > schedules task with YYYY-MM-DD date format` reading
	// `fetchSpy.mock.calls[0]` and getting a `do` test's PATCH /v5/tasks
	// payload instead of the taskPlanCommand one (issue surfaced during
	// the zireael monorepo import).
	const spies: Array<{ mockRestore: () => void }> = [];
	const track = <T extends { mockRestore: () => void }>(spy: T): T => {
		spies.push(spy);
		return spy;
	};

	beforeEach(async () => {
		testCacheDir = mkdtempSync(join(tmpdir(), "af-do-test-"));
		process.env.AF_CACHE_DIR = testCacheDir;
		testContextFile = join(testCacheDir, "last-list.json");
		writeFileSync(testContextFile, JSON.stringify(mockContextFile));

		// Prevent hitting real ~/.config/af credentials.
		track(
			spyOn(
				await import("../../lib/auth/storage"),
				"loadCredentials",
			).mockResolvedValue({
				token: "test-token",
				clientId: "test-client-id",
				expiryTimestamp: Date.now() + 60_000,
			}),
		);

		track(
			spyOn(process, "exit").mockImplementation((code?: number) => {
				throw new ExitError(code ?? 0);
			}),
		);
	});

	afterEach(() => {
		while (spies.length > 0) {
			spies.pop()?.mockRestore();
		}
		try {
			rmSync(testCacheDir, { recursive: true, force: true });
		} catch {
			// file may not exist
		}
		if (originalAfCacheDir === undefined) delete process.env.AF_CACHE_DIR;
		else process.env.AF_CACHE_DIR = originalAfCacheDir;
	});

	it("completes single task by short ID", async () => {
		const consoleSpy = track(spyOn(console, "log"));
		const fetchSpy = track(
			spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(
					JSON.stringify({
						success: true,
						message: null,
						data: [
							{
								id: "abc123def456",
								done: true,
								done_at: new Date().toISOString(),
								status: 2,
							},
						],
					}),
					{ status: 200 },
				),
			),
		);

		const mockContext = {
			args: { id: "1" },
		};

		await doCommand.run?.(mockContext as any);

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("✓ Completed 1 task(s):"),
		);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("Buy groceries"),
		);
		expect(fetchSpy).toHaveBeenCalled();
	});

	it("completes multiple tasks by short IDs", async () => {
		const consoleSpy = track(spyOn(console, "log"));
		const fetchSpy = track(
			spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(
					JSON.stringify({
						success: true,
						message: null,
						data: [
							{
								id: "abc123def456",
								done: true,
								done_at: new Date().toISOString(),
								status: 2,
							},
							{
								id: "xyz789uvw012",
								done: true,
								done_at: new Date().toISOString(),
								status: 2,
							},
						],
					}),
					{ status: 200 },
				),
			),
		);

		const mockContext = {
			args: { id: ["1", "2"] },
		};

		await doCommand.run?.(mockContext as any);

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("✓ Completed 2 task(s):"),
		);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("Buy groceries"),
		);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("Write report"),
		);
		expect(fetchSpy).toHaveBeenCalled();
	});

	it("completes task by partial UUID", async () => {
		const consoleSpy = track(spyOn(console, "log"));
		const fetchSpy = track(
			spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(
					JSON.stringify({
						success: true,
						message: null,
						data: [
							{
								id: "abc123def456",
								done: true,
								done_at: new Date().toISOString(),
								status: 2,
							},
						],
					}),
					{ status: 200 },
				),
			),
		);

		const mockContext = {
			args: { id: "abc123" },
		};

		await doCommand.run?.(mockContext as any);

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("✓ Completed 1 task(s):"),
		);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("Buy groceries"),
		);
		expect(fetchSpy).toHaveBeenCalled();
	});

	it("handles invalid short ID", async () => {
		const consoleErrorSpy = track(spyOn(console, "error"));
		const mockContext = {
			args: { id: "999" },
		};

		try {
			await doCommand.run?.(mockContext as any);
			throw new Error("Expected ExitError");
		} catch (error) {
			if (!(error instanceof ExitError)) {
				throw error;
			}
		}

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Could not resolve task IDs"),
		);
	});

	it("handles ambiguous UUID", async () => {
		const consoleErrorSpy = track(spyOn(console, "error"));
		const contextWithDuplicates = {
			tasks: [
				{ shortId: 1, id: "abc123def456", title: "Task 1" },
				{ shortId: 2, id: "abc123xyz789", title: "Task 2" },
			],
			timestamp: Date.now(),
		};
		writeFileSync(testContextFile, JSON.stringify(contextWithDuplicates));

		const mockContext = {
			args: { id: "abc123" },
		};

		try {
			await doCommand.run?.(mockContext as any);
			throw new Error("Expected ExitError");
		} catch (error) {
			if (!(error instanceof ExitError)) {
				throw error;
			}
		}

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Ambiguous task id prefix"),
		);
	});

	it("handles missing context file", async () => {
		rmSync(testContextFile);
		const consoleErrorSpy = track(spyOn(console, "error"));

		const mockContext = {
			args: { id: "1" },
		};

		try {
			await doCommand.run?.(mockContext as any);
			throw new Error("Expected ExitError");
		} catch (error) {
			if (!(error instanceof ExitError)) {
				throw error;
			}
		}

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Short IDs and partial IDs require context"),
		);
	});

	it("completes a full UUID without list context", async () => {
		rmSync(testContextFile);
		const fullUuid = "11111111-1111-1111-1111-111111111111";
		const fetchSpy = track(
			spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(
					JSON.stringify({
						success: true,
						message: null,
						data: [{ id: fullUuid, done: true, status: 2 }],
					}),
					{ status: 200 },
				),
			),
		);

		await doCommand.run?.({ args: { id: fullUuid } } as any);

		const callArgs = fetchSpy.mock.calls[0];
		if (!callArgs?.[1]) throw new Error("fetch was not called");
		const requestBody = JSON.parse(callArgs[1].body as string);
		expect(requestBody[0].id).toBe(fullUuid);
		expect(requestBody[0].done).toBe(true);
	});

	it("handles API error", async () => {
		const consoleErrorSpy = track(spyOn(console, "error"));
		const fetchSpy = track(
			spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(
					JSON.stringify({
						success: false,
						message: "API error",
						data: [],
					}),
					{ status: 200 },
				),
			),
		);

		const mockContext = {
			args: { id: "1" },
		};

		try {
			await doCommand.run?.(mockContext as any);
			throw new Error("Expected ExitError");
		} catch (error) {
			if (!(error instanceof ExitError)) {
				throw error;
			}
		}

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Failed to complete tasks"),
		);
		expect(fetchSpy).toHaveBeenCalled();
	});

	it("handles network error", async () => {
		const consoleErrorSpy = track(spyOn(console, "error"));
		const fetchSpy = track(
			spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error")),
		);

		const mockContext = {
			args: { id: "1" },
		};

		try {
			await doCommand.run?.(mockContext as any);
			throw new Error("Expected ExitError");
		} catch (error) {
			if (!(error instanceof ExitError)) {
				throw error;
			}
		}

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Failed to complete tasks"),
		);
		expect(fetchSpy).toHaveBeenCalled();
	});

	it("sends correct payload to API", async () => {
		const fetchSpy = track(
			spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(
					JSON.stringify({
						success: true,
						message: null,
						data: [],
					}),
					{ status: 200 },
				),
			),
		);

		const mockContext = {
			args: { id: "1" },
		};

		await doCommand.run?.(mockContext as any);

		const callArgs = fetchSpy.mock.calls[0];
		if (!callArgs?.[1]) {
			throw new Error("fetch was not called");
		}

		const requestBody = JSON.parse(callArgs[1].body as string);

		expect(requestBody[0]).toHaveProperty("id", "abc123def456");
		expect(requestBody[0]).toHaveProperty("done", true);
		expect(requestBody[0]).toHaveProperty("status", 2);
		expect(requestBody[0]).toHaveProperty("done_at");
		expect(requestBody[0]).toHaveProperty("global_updated_at");
	});

	it("completes multiple tasks with mixed short IDs and UUIDs", async () => {
		const consoleSpy = track(spyOn(console, "log"));
		const fetchSpy = track(
			spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(
					JSON.stringify({
						success: true,
						message: null,
						data: [
							{
								id: "abc123def456",
								done: true,
								done_at: new Date().toISOString(),
								status: 2,
							},
							{
								id: "pqr345stu678",
								done: true,
								done_at: new Date().toISOString(),
								status: 2,
							},
						],
					}),
					{ status: 200 },
				),
			),
		);

		const mockContext = {
			args: { id: ["1", "pqr345"] },
		};

		await doCommand.run?.(mockContext as any);

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("✓ Completed 2 task(s):"),
		);
		expect(fetchSpy).toHaveBeenCalled();
	});
});
