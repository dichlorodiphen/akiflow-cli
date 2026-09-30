import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createTaskSnapshot,
	resolveTaskId,
	type TaskContext,
	taskTitleFromContext,
} from "../../lib/task-context";

const first = "aaaaaaaa-1111-1111-1111-111111111111";
const second = "bbbbbbbb-2222-2222-2222-222222222222";
let cacheDir: string;
let oldCache: string | undefined;
let oldStrict: string | undefined;
const context: TaskContext = {
	tasks: [{ shortId: 1, id: first, title: "First" }],
	timestamp: 123,
	snapshot: "pinned",
};
beforeEach(() => {
	oldCache = process.env.AF_CACHE_DIR;
	oldStrict = process.env.AF_STRICT_IDS;
	cacheDir = mkdtempSync(join(tmpdir(), "af-ids-unit-"));
	process.env.AF_CACHE_DIR = cacheDir;
	delete process.env.AF_STRICT_IDS;
});
afterEach(() => {
	if (oldCache === undefined) delete process.env.AF_CACHE_DIR;
	else process.env.AF_CACHE_DIR = oldCache;
	if (oldStrict === undefined) delete process.env.AF_STRICT_IDS;
	else process.env.AF_STRICT_IDS = oldStrict;
	rmSync(cacheDir, { recursive: true, force: true });
});
test("numeric IDs warn during migration and pinned IDs suppress warning", () => {
	const warnings: string[] = [];
	expect(resolveTaskId("1", context, { warn: (s) => warnings.push(s) })).toBe(
		first,
	);
	expect(warnings[0]).toContain("will soon require --snapshot");
	warnings.length = 0;
	expect(
		resolveTaskId("1", context, {
			snapshot: "pinned",
			warn: (s) => warnings.push(s),
		}),
	).toBe(first);
	expect(warnings).toEqual([]);
});
test("strict numeric IDs require token and mismatched snapshots always fail", () => {
	process.env.AF_STRICT_IDS = "1";
	expect(() => resolveTaskId("1", context)).toThrow("requires --snapshot");
	expect(resolveTaskId("1", context, { snapshot: "pinned" })).toBe(first);
	expect(() => resolveTaskId("1", context, { snapshot: "other" })).toThrow(
		"does not match",
	);
	delete process.env.AF_STRICT_IDS;
	expect(() => resolveTaskId("1", context, { snapshot: "other" })).toThrow(
		"does not match",
	);
});
test("prefixes and titles use full cache even with absent or subset list context", () => {
	writeFileSync(
		join(cacheDir, "tasks.jsonl"),
		`${JSON.stringify({ id: second, title: "Second" })}\n`,
	);
	const warnings: string[] = [];
	expect(
		resolveTaskId("bbbb", context, { warn: (s) => warnings.push(s) }),
	).toBe(second);
	expect(resolveTaskId("bbbb", null, { warn: () => {} })).toBe(second);
	expect(taskTitleFromContext(second, context)).toBe("Second");
	expect(warnings[0]).toContain("full cached task inventory");
	// A present full inventory is authoritative; never silently consult a subset.
	expect(resolveTaskId("aaaa", context, { warn: () => {} })).toBeNull();
});
test("full inventory ambiguity wins over a seemingly unique filtered list", () => {
	writeFileSync(
		join(cacheDir, "tasks.jsonl"),
		[first, "aaaaaaaa-2222-2222-2222-222222222222"]
			.map((id) => JSON.stringify({ id }))
			.join("\n"),
	);
	expect(() => resolveTaskId("aaaa", context, { warn: () => {} })).toThrow(
		"Ambiguous",
	);
});
test("missing or corrupt inventory fallback explicitly warns about stale subset", () => {
	const warnings: string[] = [];
	expect(
		resolveTaskId("aaaa", context, { warn: (s) => warnings.push(s) }),
	).toBe(first);
	expect(warnings[0]).toContain("last-list.json subset, which may be stale");
	writeFileSync(join(cacheDir, "tasks.jsonl"), "malformed");
	expect(
		resolveTaskId("aaaa", context, { warn: (s) => warnings.push(s) }),
	).toBe(first);
	expect(warnings).toHaveLength(2);
});
test("synthetic IDs cannot be mutated directly or through a numeric short ID", () => {
	const id = `virtual:${first}:2026-09-30`;
	expect(() => resolveTaskId(id, null)).toThrow("Synthetic task ID");
	expect(() =>
		resolveTaskId("1", {
			...context,
			tasks: [{ shortId: 1, id, title: "Virtual", synthetic: true }],
		}),
	).toThrow("cannot be mutated");
});
test("snapshot hash pins list order and timestamp", () => {
	expect(createTaskSnapshot(context)).toBe(createTaskSnapshot(context));
	expect(createTaskSnapshot(context)).not.toBe(
		createTaskSnapshot({ ...context, timestamp: 124 }),
	);
	expect(createTaskSnapshot(context)).not.toBe(
		createTaskSnapshot({
			...context,
			tasks: [{ shortId: 1, id: second, title: "Second" }],
		}),
	);
});

test("synthetic task prefix cannot bypass mutation rejection in list fallback or full cache", () => {
	const id = `virtual:${first}:2026-09-30`;
	const syntheticContext = {
		...context,
		tasks: [{ shortId: 1, id, title: "Virtual", synthetic: true }],
	};
	expect(() =>
		resolveTaskId("vir", syntheticContext, { warn: () => {} }),
	).toThrow("Synthetic task ID");
	writeFileSync(
		join(cacheDir, "tasks.jsonl"),
		JSON.stringify({ id, title: "Virtual" }),
	);
	expect(() => resolveTaskId("vir", null, { warn: () => {} })).toThrow(
		"Synthetic task ID",
	);
});
