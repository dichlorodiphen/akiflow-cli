import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiResponse } from "../../../lib/api/types";
import {
	readResource,
	rebuild,
	refresh,
	refreshResource,
	upsertResourceRecords,
} from "../../../lib/cache";
import { readTokens, writeTokens } from "../../../lib/cache/tokens";

let fixture: string;
let dir: string;
const children: Bun.Subprocess[] = [];
const originalCache = process.env.AF_CACHE_DIR;
const originalAuto = process.env.AF_NO_AUTO_SYNC;
beforeEach(() => {
	fixture = mkdtempSync(join(tmpdir(), "af-generation-integration-"));
	dir = join(fixture, "cache");
	process.env.AF_CACHE_DIR = dir;
	process.env.AF_NO_AUTO_SYNC = "1";
});
afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill("SIGKILL");
		await child.exited;
	}
	rmSync(fixture, { recursive: true, force: true });
	if (originalCache === undefined) delete process.env.AF_CACHE_DIR;
	else process.env.AF_CACHE_DIR = originalCache;
	if (originalAuto === undefined) delete process.env.AF_NO_AUTO_SYNC;
	else process.env.AF_NO_AUTO_SYNC = originalAuto;
});

function client(version = "good", getHook?: (path: string) => Promise<void>) {
	return {
		async get<T>(path: string): Promise<ApiResponse<T[]>> {
			await getHook?.(path);
			const resource = path.slice("/v5/".length);
			return {
				success: true,
				message: null,
				data: [
					{ id: `${resource}-1`, title: version, deleted_at: null },
				] as T[],
				sync_token: `${version}-${resource}`,
				has_next_page: false,
			};
		},
	};
}

function activeDirectory(): string {
	return existsSync(join(dir, "current"))
		? join(dir, readFileSync(join(dir, "current"), "utf8").trim())
		: dir;
}

function worker(operation: string, resource: string, marker: string) {
	const child = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "generation-worker.ts"),
			operation,
			resource,
			marker,
		],
		{
			env: { ...process.env, AF_CACHE_DIR: dir, AF_NO_AUTO_SYNC: "1" },
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	children.push(child);
	return child;
}

async function waitFor(marker: string) {
	for (let i = 0; i < 200 && !existsSync(marker); i++) await Bun.sleep(10);
	expect(existsSync(marker)).toBe(true);
}

describe("cache generation integration", () => {
	test("rebuild preserves pending journal, list context, logs and uses GET only", async () => {
		await rebuild(client());
		const state = [
			"pending-tasks.json",
			"last-list.json",
			"operations.log",
			"tasks-cache.json",
		];
		for (const file of state)
			writeFileSync(join(dir, file), `preserve-${file}`);
		const methods: string[] = [];
		const fake = client("new", async () => {
			methods.push("GET");
		});
		Object.assign(fake, {
			post: () => {
				methods.push("POST");
				throw new Error("mutation forbidden");
			},
			patch: () => {
				methods.push("PATCH");
				throw new Error("mutation forbidden");
			},
			delete: () => {
				methods.push("DELETE");
				throw new Error("mutation forbidden");
			},
		});
		await rebuild(fake);
		await refresh(fake);
		expect(methods).toEqual(Array(16).fill("GET"));
		for (const file of state)
			expect(readFileSync(join(dir, file), "utf8")).toBe(`preserve-${file}`);
	});

	test("lock outside cache prevents a second rebuild entering while first rebuild is blocked", async () => {
		await rebuild(client());
		const first = worker("rebuild", "tasks", join(fixture, "first"));
		await waitFor(join(fixture, "first"));
		worker("rebuild", "tasks", join(fixture, "second"));
		await Bun.sleep(200);
		expect(existsSync(join(fixture, "second"))).toBe(false);
		first.kill("SIGKILL");
		await first.exited;
		await waitFor(join(fixture, "second"));
	});

	test("atomic publish retains every old resource and token after pagination failure", async () => {
		await rebuild(client());
		const before = activeDirectory();
		const tokens = readFileSync(join(before, "tokens.json"), "utf8");
		let pages = 0;
		const failed = client("replacement", async (path) => {
			if (path === "/v5/events" && ++pages === 2) throw new Error("page fault");
		});
		const get = failed.get.bind(failed);
		failed.get = async <T>(path: string) => {
			const response = await get<T>(path);
			if (path === "/v5/events") response.has_next_page = true;
			return response;
		};
		await expect(rebuild(failed)).rejects.toThrow("page fault");
		expect(activeDirectory()).toBe(before);
		expect((await readResource(client(), "tasks"))[0]?.title).toBe("good");
		expect(readFileSync(join(activeDirectory(), "tokens.json"), "utf8")).toBe(
			tokens,
		);
	});

	for (const operation of [
		"rebuild",
		"refresh",
		"rebuild-write",
		"refresh-write",
	]) {
		test(`kill-9 recovery during ${operation} leaves last good generation complete`, async () => {
			await rebuild(client());
			const before = activeDirectory();
			const child = worker(operation, "labels", join(fixture, "blocked"));
			await waitFor(join(fixture, "blocked"));
			child.kill("SIGKILL");
			await child.exited;
			expect(activeDirectory()).toBe(before);
			expect((await readResource(client(), "tasks"))[0]?.title).toBe("good");
			expect((await readResource(client(), "events"))[0]?.title).toBe("good");
			// The dead process lock must be reclaimed without waiting for age expiry.
			await refresh(client("recovered"));
			expect((await readResource(client(), "tasks"))[0]?.title).toBe(
				"recovered",
			);
		});
	}

	test("concurrent rebuild, reads and write-throughs always return complete records", async () => {
		await rebuild(client());
		let running = true;
		const observations: string[] = [];
		const reader = (async () => {
			while (running) {
				const tasks = await readResource(client(), "tasks");
				expect(tasks).toHaveLength(1);
				expect(tasks[0]?.id).toBe("tasks-1");
				observations.push(tasks[0]?.title ?? "missing");
				await Bun.sleep(1);
			}
		})();
		try {
			await Promise.all([
				rebuild(
					client("new", async () => {
						await Bun.sleep(5);
					}),
				),
				upsertResourceRecords("tasks", [
					{ id: "tasks-1", title: "write-through" },
				]),
			]);
		} finally {
			running = false;
			await reader;
		}
		expect(observations.length).toBeGreaterThan(1);
		expect(
			observations.every((title) =>
				["good", "new", "write-through"].includes(title),
			),
		).toBe(true);
		expect((await readResource(client(), "tasks"))[0]?.title).toBe(
			"write-through",
		);
		const generationModule = "../../../lib/cache/generation";
		const { validateGeneration } = await import(generationModule);
		expect(() => validateGeneration(activeDirectory())).not.toThrow();
	});

	test("per-resource freshness: refreshing events does not freshen stale tasks", async () => {
		await rebuild(client());
		const tokens = await readTokens();
		const old = "2000-01-01T00:00:00.000Z";
		tokens.last_full_sync_at = old;
		Object.assign(tokens, { last_success_at: { tasks: old, events: old } });
		await writeTokens(tokens);
		await refreshResource(client("events-new"), "events");
		expect((await readTokens()).last_full_sync_at).toBe(old);
		delete process.env.AF_NO_AUTO_SYNC;
		const requested: string[] = [];
		const fake = client("fresh", async (path) => {
			requested.push(path);
		});
		await readResource(fake, "events");
		expect(requested).toEqual([]);
		await readResource(fake, "tasks");
		expect(requested).toContain("/v5/tasks");
	});

	test("clearly truthy AF_NO_AUTO_SYNC values disable refresh", async () => {
		await rebuild(client());
		const tokens = await readTokens();
		tokens.last_full_sync_at = "2000-01-01T00:00:00.000Z";
		Object.assign(tokens, {
			last_success_at: { tasks: "2000-01-01T00:00:00.000Z" },
		});
		await writeTokens(tokens);
		for (const value of ["1", "true", "yes", "on", "TRUE"]) {
			process.env.AF_NO_AUTO_SYNC = value;
			const fake = client("unwanted", async () => {
				throw new Error("auto-sync forbidden");
			});
			expect((await readResource(fake, "tasks"))[0]?.title).toBe("good");
		}
	});

	test("false AF_NO_AUTO_SYNC values permit stale resource refresh", async () => {
		await rebuild(client());
		for (const value of ["0", "false", "no", "off", ""]) {
			const tokens = await readTokens();
			tokens.last_full_sync_at = "2000-01-01T00:00:00.000Z";
			Object.assign(tokens, {
				last_success_at: { tasks: "2000-01-01T00:00:00.000Z" },
			});
			await writeTokens(tokens);
			process.env.AF_NO_AUTO_SYNC = value;
			const requested: string[] = [];
			await readResource(
				client("fresh", async (path) => {
					requested.push(path);
				}),
				"tasks",
			);
			expect(requested).toContain("/v5/tasks");
		}
	});
});
