import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { atomicWrite, setAtomicWriteHook } from "../../../lib/cache/atomic";
import {
	ensureGeneration,
	pinGeneration,
	publishGeneration,
	RESOURCES,
	setBeforePublishHook,
	stageGeneration,
	validateGeneration,
} from "../../../lib/cache/generation";
import { readAllRecords } from "../../../lib/cache/jsonl-store";
import { readTokens, writeTokens } from "../../../lib/cache/tokens";

let directory: string;
let originalDirectory: string | undefined;
beforeEach(() => {
	originalDirectory = process.env.AF_CACHE_DIR;
	directory = mkdtempSync(join(tmpdir(), "af-generation-"));
	process.env.AF_CACHE_DIR = directory;
});
afterEach(() => {
	setAtomicWriteHook();
	setBeforePublishHook();
	if (originalDirectory === undefined) delete process.env.AF_CACHE_DIR;
	else process.env.AF_CACHE_DIR = originalDirectory;
	rmSync(directory, { recursive: true, force: true });
});

function seedLegacy(): void {
	writeFileSync(join(directory, "tasks.jsonl"), '{"id":"legacy-task"}\n');
	writeFileSync(join(directory, "events.jsonl"), '{"id":"legacy-event"}\n');
	writeFileSync(
		join(directory, "tokens.json"),
		JSON.stringify({
			tasks: "task-cursor",
			events: "event-cursor",
			user_id: 42,
		}),
	);
	writeFileSync(join(directory, "last-list.json"), "saved context");
	writeFileSync(join(directory, "pending-tasks.json"), "pending intent");
	writeFileSync(join(directory, "sync.log"), "audit history");
}

describe("cache generations", () => {
	test("adopts flat records and tokens as generation zero while preserving non-resource state", async () => {
		seedLegacy();
		const generation = await ensureGeneration();
		expect(basename(generation)).toBe("gen-0");
		expect(pinGeneration()).toBe(generation);
		validateGeneration(generation);
		expect(await readAllRecords(join(generation, "tasks.jsonl"))).toEqual([
			{ id: "legacy-task" },
		]);
		expect(await readTokens()).toEqual({
			tasks: "task-cursor",
			events: "event-cursor",
			user_id: 42,
		});
		expect(existsSync(join(directory, "tasks.jsonl"))).toBe(false);
		for (const [file, contents] of [
			["last-list.json", "saved context"],
			["pending-tasks.json", "pending intent"],
			["sync.log", "audit history"],
		] as const) {
			expect(readFileSync(join(directory, file), "utf8")).toBe(contents);
		}
	});

	test("interrupted migration retains every legacy record and token until pointer publication", async () => {
		seedLegacy();
		setAtomicWriteHook((path) => {
			if (basename(path) === "current")
				throw new Error("pointer write interrupted");
		});
		await expect(ensureGeneration()).rejects.toThrow(
			"pointer write interrupted",
		);
		expect(pinGeneration()).toBeUndefined();
		expect(readFileSync(join(directory, "tasks.jsonl"), "utf8")).toContain(
			"legacy-task",
		);
		expect(await readTokens()).toEqual({
			tasks: "task-cursor",
			events: "event-cursor",
			user_id: 42,
		});
		setAtomicWriteHook();
		const recovered = await ensureGeneration();
		validateGeneration(recovered);
		expect(await readAllRecords(join(recovered, "tasks.jsonl"))).toEqual([
			{ id: "legacy-task" },
		]);
	});

	test("staging contains all eight resource files plus tokens and validates manifest counts/hashes", async () => {
		const stage = stageGeneration();
		for (const resource of RESOURCES)
			expect(existsSync(join(stage, `${resource}.jsonl`))).toBe(true);
		expect(existsSync(join(stage, "tokens.json"))).toBe(true);
		atomicWrite(join(stage, "tasks.jsonl"), '{"id":"a"}\n{"id":"b"}\n');
		await writeTokens({ tasks: "cursor" }, stage);
		const generation = publishGeneration(stage);
		validateGeneration(generation);
		const manifest = JSON.parse(
			readFileSync(join(generation, "manifest.json"), "utf8"),
		);
		expect(manifest.resources.tasks.count).toBe(2);
		expect(manifest.resources.tasks.sha256).toHaveLength(64);
		expect(manifest.tokens.sha256).toHaveLength(64);
		writeFileSync(join(generation, "tasks.jsonl"), '{"id":"different"}\n');
		expect(() => validateGeneration(generation)).toThrow("manifest mismatch");
	});

	test("corrupted resource before publication leaves previous generation fully valid", async () => {
		seedLegacy();
		const good = await ensureGeneration();
		const stage = stageGeneration(good);
		setBeforePublishHook((path) =>
			writeFileSync(join(path, "events.jsonl"), "broken JSON"),
		);
		expect(() => publishGeneration(stage)).toThrow();
		expect(pinGeneration()).toBe(good);
		validateGeneration(good);
	});

	for (const target of [
		"tasks.jsonl",
		"tokens.json",
		"manifest.json",
		"current",
	]) {
		test(`failure writing ${target} keeps last good generation`, async () => {
			seedLegacy();
			const good = await ensureGeneration();
			const stage = stageGeneration(good);
			setAtomicWriteHook((path) => {
				if (basename(path) === target) throw new Error("injected write fault");
			});
			const attempt = async () => {
				atomicWrite(join(stage, "tasks.jsonl"), '{"id":"replacement"}\n');
				await writeTokens({ tasks: "replacement-cursor" }, stage);
				publishGeneration(stage);
			};
			await expect(attempt()).rejects.toThrow("injected write fault");
			expect(pinGeneration()).toBe(good);
			validateGeneration(good);
			expect(await readAllRecords(join(good, "tasks.jsonl"))).toEqual([
				{ id: "legacy-task" },
			]);
		});
	}

	test("default token updates publish a coherent new generation and preserve pinned readers", async () => {
		seedLegacy();
		const good = await ensureGeneration();
		await writeTokens({
			tasks: "new-token",
			last_success_at: { tasks: "2026-09-30T00:00:00Z" },
		});
		const current = pinGeneration();
		expect(current).not.toBe(good);
		validateGeneration(good);
		if (!current) throw new Error("missing pointer");
		validateGeneration(current);
		expect((await readTokens(good)).tasks).toBe("task-cursor");
		expect((await readTokens()).tasks).toBe("new-token");
	});

	test("writer recovery removes abandoned staging files and retains only two aged old generations", async () => {
		seedLegacy();
		let current = await ensureGeneration();
		const abandoned = stageGeneration(current);
		writeFileSync(join(directory, "current.tmp-abandoned"), "unpublished");
		expect(await ensureGeneration()).toBe(current);
		expect(existsSync(abandoned)).toBe(false);
		expect(existsSync(join(directory, "current.tmp-abandoned"))).toBe(false);
		const oldTime = new Date(Date.now() - 10 * 60 * 1000);
		for (let count = 0; count < 4; count++) {
			utimesSync(current, oldTime, oldTime);
			current = publishGeneration(stageGeneration(current));
		}
		expect(
			readdirSync(directory).filter((name) => /^gen-\d+$/.test(name)),
		).toHaveLength(3);
		validateGeneration(current);
	});

	test("atomic replacement cleans temporary file after a failed write and preserves old contents", () => {
		const file = join(directory, "record.jsonl");
		atomicWrite(file, '{"id":"old"}\n');
		setAtomicWriteHook(() => {
			throw new Error("crash before rename");
		});
		expect(() => atomicWrite(file, '{"id":"new"}\n')).toThrow();
		expect(readFileSync(file, "utf8")).toBe('{"id":"old"}\n');
		expect(readdirSync(directory)).toEqual(["record.jsonl"]);
	});
});
