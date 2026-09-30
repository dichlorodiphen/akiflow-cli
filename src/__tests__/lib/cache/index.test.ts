import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiResponse } from "../../../lib/api/types";
import { readResource, rebuild, refresh } from "../../../lib/cache";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "af-cache-idx-test-"));
	process.env.AF_CACHE_DIR = dir;
	process.env.AF_NO_AUTO_SYNC = "1";
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.AF_CACHE_DIR;
	delete process.env.AF_NO_AUTO_SYNC;
});

// Fake client that returns one record per resource with the given id prefix.
function fakeClient() {
	return {
		get: async <T>(path: string): Promise<ApiResponse<T[]>> => {
			const resource = path.replace("/v5/", "");
			return {
				success: true,
				message: null,
				data: [
					{ id: `${resource}-1`, deleted_at: null, status: 2 } as unknown as T,
				],
				sync_token: `token-${resource}`,
				has_next_page: false,
			};
		},
	};
}

describe("rebuild", () => {
	test("creates all 8 resource JSONLs + tokens.json with last_full_sync_at", async () => {
		const summary = await rebuild(fakeClient());
		for (const res of [
			"tasks",
			"events",
			"time_slots",
			"labels",
			"tags",
			"calendars",
			"accounts",
			"contacts",
		]) {
			expect(
				existsSync(
					join(
						dir,
						readFileSync(join(dir, "current"), "utf8").trim(),
						`${res}.jsonl`,
					),
				),
			).toBe(true);
			expect(summary[res as keyof typeof summary].upserted).toBe(1);
		}
		expect(
			existsSync(
				join(
					dir,
					readFileSync(join(dir, "current"), "utf8").trim(),
					"tokens.json",
				),
			),
		).toBe(true);
	});
});

describe("refresh", () => {
	test("uses stored sync_token from tokens.json", async () => {
		await rebuild(fakeClient());
		const summary = await refresh(fakeClient());
		expect(summary.tasks.upserted).toBe(1);
	});
});

describe("readResource", () => {
	test("returns parsed records for a resource", async () => {
		await rebuild(fakeClient());
		const tasks = await readResource(fakeClient(), "tasks");
		expect(tasks.length).toBe(1);
		expect(tasks[0]?.id).toBe("tasks-1");
	});
});

test("snapshotResources refreshes once and captures per-resource freshness with one generation", async () => {
	process.env.AF_NO_AUTO_SYNC = "";
	const calls: string[] = [];
	const delegate = fakeClient();
	const client = {
		get: async <T>(path: string) => {
			calls.push(path);
			return delegate.get<T>(path);
		},
	};
	const { snapshotResources } = await import("../../../lib/cache");
	const snapshot = await snapshotResources(client, [
		"events",
		"time_slots",
		"tasks",
		"calendars",
	]);
	expect(calls).toHaveLength(8);
	expect(snapshot.generation).toBe(
		readFileSync(join(dir, "current"), "utf8").trim(),
	);
	const tokens = JSON.parse(
		readFileSync(join(dir, snapshot.generation!, "tokens.json"), "utf8"),
	);
	for (const resource of [
		"events",
		"time_slots",
		"tasks",
		"calendars",
	] as const) {
		expect(snapshot.data[resource][0]?.id).toBe(`${resource}-1`);
		expect(snapshot.observedAt[resource]).toBe(
			tokens.last_success_at[resource],
		);
	}
	await snapshotResources(client, ["events", "tasks"]);
	expect(calls).toHaveLength(8);
});

test("snapshotResources does not mix resource generations during competing publication", async () => {
	const { snapshotResources, upsertResourceRecords } = await import(
		"../../../lib/cache"
	);
	await rebuild(fakeClient());
	const first = snapshotResources(fakeClient(), ["events", "tasks"]);
	await upsertResourceRecords("events", [{ id: "event-new" }]);
	const snapshot = await first;
	expect(snapshot.data.events.map((e) => e.id)).toEqual(["events-1"]);
	expect(snapshot.data.tasks.map((t) => t.id)).toEqual(["tasks-1"]);
	expect(snapshot.generation).not.toBe(
		readFileSync(join(dir, "current"), "utf8").trim(),
	);
});
