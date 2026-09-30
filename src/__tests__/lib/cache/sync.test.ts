import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ResourceClient, syncResource } from "../../../lib/cache/sync";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "af-sync-test-"));
	process.env.AF_CACHE_DIR = dir;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.AF_CACHE_DIR;
});

type Rec = { id: string; deleted_at: string | null; n: number };

function fakeClient(
	pages: Array<{ data: Rec[]; sync_token: string; has_next_page: boolean }>,
): ResourceClient {
	let idx = 0;
	return {
		get: async <_T>() => {
			const page = pages[idx++];
			if (!page) throw new Error("no more pages");
			return {
				success: true,
				message: null,
				data: page.data as unknown as _T[],
				sync_token: page.sync_token,
				has_next_page: page.has_next_page,
			};
		},
	};
}

describe("syncResource — cold start", () => {
	test("paginates through all pages and writes JSONL + final token", async () => {
		const client = fakeClient([
			{
				data: [
					{ id: "a", deleted_at: null, n: 1 },
					{ id: "b", deleted_at: null, n: 2 },
				],
				sync_token: "t1",
				has_next_page: true,
			},
			{
				data: [{ id: "c", deleted_at: null, n: 3 }],
				sync_token: "t2",
				has_next_page: false,
			},
		]);
		const result = await syncResource<Rec>(client, {
			resource: "test",
			keyOf: (r) => r.id,
			previousToken: null,
			limit: 100,
		});
		expect(result.finalToken).toBe("t2");
		expect(result.upsertedCount).toBe(3);
		expect(result.tombstoneCount).toBe(0);
		expect(result.pages).toBe(2);
		const content = await readFile(join(dir, "test.jsonl"), "utf8");
		expect(content.split("\n").filter(Boolean).length).toBe(3);
	});
});

describe("syncResource — delta", () => {
	test("applies tombstones by removing local records, keeps live records", async () => {
		const initial = fakeClient([
			{
				data: [
					{ id: "a", deleted_at: null, n: 1 },
					{ id: "b", deleted_at: null, n: 2 },
				],
				sync_token: "t1",
				has_next_page: false,
			},
		]);
		await syncResource<Rec>(initial, {
			resource: "test",
			keyOf: (r) => r.id,
			previousToken: null,
			limit: 100,
		});
		expect(existsSync(join(dir, "test.jsonl"))).toBe(true);

		const delta = fakeClient([
			{
				data: [{ id: "a", deleted_at: "2026-01-01T00:00:00Z", n: 1 }],
				sync_token: "t2",
				has_next_page: false,
			},
		]);
		const result = await syncResource<Rec>(delta, {
			resource: "test",
			keyOf: (r) => r.id,
			previousToken: "t1",
			limit: 100,
		});
		expect(result.tombstoneCount).toBe(1);
		expect(result.finalToken).toBe("t2");
		const content = await readFile(join(dir, "test.jsonl"), "utf8");
		const records = content
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Rec);
		expect(records.map((r) => r.id)).toEqual(["b"]);
	});
});

describe("syncResource — G semantics", () => {
	test("duplicate versions collapse; last in server order wins", async () => {
		const client = fakeClient([
			{
				data: [
					{ id: "a", deleted_at: null, n: 1 },
					{ id: "a", deleted_at: null, n: 2 },
				],
				sync_token: "t1",
				has_next_page: false,
			},
		]);
		const result = await syncResource<Rec>(client, {
			resource: "test",
			keyOf: (r) => r.id,
			previousToken: null,
			limit: 100,
		});
		expect(result.upsertedCount).toBe(1);
		const content = await readFile(join(dir, "test.jsonl"), "utf8");
		const records = content
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Rec);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ id: "a", n: 2 });
	});

	test("tombstone wins over live for same ID in same sync", async () => {
		const client = fakeClient([
			{
				data: [
					{ id: "a", deleted_at: null, n: 1 },
					{ id: "a", deleted_at: "2026-01-01T00:00:00Z", n: 1 },
				],
				sync_token: "t1",
				has_next_page: false,
			},
		]);
		const result = await syncResource<Rec>(client, {
			resource: "test",
			keyOf: (r) => r.id,
			previousToken: null,
			limit: 100,
		});
		expect(result.tombstoneCount).toBe(1);
		expect(result.upsertedCount).toBe(0);
		const content = await readFile(join(dir, "test.jsonl"), "utf8");
		expect(content.split("\n").filter(Boolean)).toHaveLength(0);
	});

	test("tokenless cold sync replaces state; disappeared IDs not deleted", async () => {
		// Seed with a, b
		const seed = fakeClient([
			{
				data: [
					{ id: "a", deleted_at: null, n: 1 },
					{ id: "b", deleted_at: null, n: 2 },
				],
				sync_token: "t1",
				has_next_page: false,
			},
		]);
		await syncResource<Rec>(seed, {
			resource: "test",
			keyOf: (r) => r.id,
			previousToken: null,
			limit: 100,
		});

		// Cold sync returns only c; a and b disappear (observations only)
		const cold = fakeClient([
			{
				data: [{ id: "c", deleted_at: null, n: 3 }],
				sync_token: "t2",
				has_next_page: false,
			},
		]);
		const result = await syncResource<Rec>(cold, {
			resource: "test",
			keyOf: (r) => r.id,
			previousToken: null,
			limit: 100,
		});
		expect(result.coldReplacement).toBe(true);
		const content = await readFile(join(dir, "test.jsonl"), "utf8");
		const records = content
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Rec);
		// Replaced: only c remains; a,b gone (not merged)
		expect(records.map((r) => r.id)).toEqual(["c"]);
	});

	test("non-advancing cursor terminates with explicit error", async () => {
		const client = fakeClient([
			{
				data: [{ id: "a", deleted_at: null, n: 1 }],
				sync_token: "t1",
				has_next_page: true,
			},
			{
				data: [{ id: "b", deleted_at: null, n: 2 }],
				sync_token: "t1", // Same token = non-advancing
				has_next_page: false,
			},
		]);
		await expect(
			syncResource<Rec>(client, {
				resource: "test",
				keyOf: (r) => r.id,
				previousToken: null,
				limit: 100,
			}),
		).rejects.toThrow(/did not advance/);
	});

	test("invalid-token triggers one staged full replacement", async () => {
		let calls = 0;
		const client: ResourceClient = {
			get: async <_T>() => {
				calls++;
				if (calls === 1) {
					return {
						success: false,
						message: "Invalid sync_token",
						data: [] as unknown as _T[],
					};
				}
				// Cold replacement succeeds
				return {
					success: true,
					message: null,
					data: [{ id: "a", deleted_at: null, n: 1 }] as unknown as _T[],
					sync_token: "t-new",
					has_next_page: false,
				};
			},
		};
		const result = await syncResource<Rec>(client, {
			resource: "test",
			keyOf: (r) => r.id,
			previousToken: "stale-token",
			limit: 100,
		});
		expect(calls).toBe(2);
		expect(result.finalToken).toBe("t-new");
		expect(result.coldReplacement).toBe(true);
	});
});
