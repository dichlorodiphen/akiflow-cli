import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearConversionEntry,
	decodeResumeToken,
	encodeResumeToken,
	findTargetForSource,
	loadConversionJournal,
	recordConversion,
	reserveConversion,
} from "../../lib/conversion-journal";

let testDir: string;
let originalCacheDir: string | undefined;

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), "af-convert-test-"));
	originalCacheDir = process.env.AF_CACHE_DIR;
	process.env.AF_CACHE_DIR = testDir;
});

afterEach(() => {
	if (originalCacheDir === undefined) {
		delete process.env.AF_CACHE_DIR;
	} else {
		process.env.AF_CACHE_DIR = originalCacheDir;
	}
	rmSync(testDir, { recursive: true, force: true });
});

describe("conversion journal", () => {
	test("records and finds mappings", async () => {
		expect(findTargetForSource("task-1")).toBeNull();

		await recordConversion({
			source_task_id: "task-1",
			target_event_id: "event-1",
			converted_at: "2026-06-20T00:00:00.000Z",
			provenance: {
				title: "Test",
				start_time: "2026-06-20T10:00:00.000Z",
				calendar_id: "cal-1",
			},
		});

		expect(findTargetForSource("task-1")).toBe("event-1");
	});

	test("record is idempotent (replaces, not duplicates)", async () => {
		await recordConversion({
			source_task_id: "task-1",
			target_event_id: "event-1",
			converted_at: "2026-06-20T00:00:00.000Z",
			provenance: { title: "Test", start_time: "", calendar_id: "" },
		});
		await recordConversion({
			source_task_id: "task-1",
			target_event_id: "event-2",
			converted_at: "2026-06-20T01:00:00.000Z",
			provenance: { title: "Test", start_time: "", calendar_id: "" },
		});

		expect(findTargetForSource("task-1")).toBe("event-2");
		const journal = loadConversionJournal();
		expect(
			journal.entries.filter((e) => e.source_task_id === "task-1"),
		).toHaveLength(1);
	});

	test("clear removes entry", async () => {
		await recordConversion({
			source_task_id: "task-1",
			target_event_id: "event-1",
			converted_at: "2026-06-20T00:00:00.000Z",
			provenance: { title: "Test", start_time: "", calendar_id: "" },
		});
		expect(findTargetForSource("task-1")).toBe("event-1");

		await clearConversionEntry("task-1");
		expect(findTargetForSource("task-1")).toBeNull();
	});

	test("persists across loads (survives rerun)", async () => {
		await recordConversion({
			source_task_id: "task-1",
			target_event_id: "event-1",
			converted_at: "2026-06-20T00:00:00.000Z",
			provenance: { title: "Test", start_time: "", calendar_id: "" },
		});

		// Simulate a new process loading the journal.
		const journal = loadConversionJournal();
		expect(journal.entries).toHaveLength(1);
		expect(journal.entries[0]!.target_event_id).toBe("event-1");
	});
	test("refuses corrupt journal without overwriting previous evidence", async () => {
		const path = join(testDir, "conversion-journal.json");
		writeFileSync(path, "{broken");
		expect(() => findTargetForSource("task-1")).toThrow(
			"Cannot read conversion journal",
		);
		await expect(
			recordConversion({
				source_task_id: "task-1",
				target_event_id: "event-1",
				converted_at: "2026-06-20T00:00:00Z",
				provenance: { title: "", start_time: "", calendar_id: "" },
			}),
		).rejects.toThrow("Cannot read conversion journal");
		expect(readFileSync(path, "utf8")).toBe("{broken");
	});
	test("concurrent records preserve every source mapping", async () => {
		await Promise.all(
			Array.from({ length: 12 }, (_, i) =>
				recordConversion({
					source_task_id: `task-${i}`,
					target_event_id: `event-${i}`,
					converted_at: "2026-06-20T00:00:00Z",
					provenance: { title: "", start_time: "", calendar_id: "" },
				}),
			),
		);
		expect(loadConversionJournal().entries).toHaveLength(12);
	});
});

describe("resume token", () => {
	test("encodes and decodes", async () => {
		const completed = [
			{ source_task_id: "task-1", target_event_id: "event-1" },
		];
		const pending = ["task-2", "task-3"];

		const token = encodeResumeToken(completed, pending);
		expect(typeof token).toBe("string");
		expect(token.length).toBeGreaterThan(0);

		const decoded = decodeResumeToken(token);
		expect(decoded).not.toBeNull();
		expect(decoded!.completed).toEqual(completed);
		expect(decoded!.pending).toEqual(pending);
		expect(decoded!.version).toBe(1);
	});

	test("decode returns null for invalid tokens", async () => {
		expect(decodeResumeToken("not-valid-base64!!!")).toBeNull();
		expect(decodeResumeToken("")).toBeNull();
		expect(
			decodeResumeToken(
				Buffer.from(
					JSON.stringify({
						version: 1,
						completed: [null],
						pending: [42],
						issued_at: "invalid",
					}),
				).toString("base64url"),
			),
		).toBeNull();
		expect(
			decodeResumeToken(
				Buffer.from(JSON.stringify({ version: 999 }), "utf-8").toString(
					"base64url",
				),
			),
		).toBeNull();
	});
});

test("concurrent reservations refuse a different target identity for one source", async () => {
	const results = await Promise.allSettled(
		["one", "two"].map((target) =>
			reserveConversion({
				source_task_id: "same",
				target_event_id: target,
				converted_at: "2026-06-20T00:00:00Z",
				provenance: { title: "", start_time: "", calendar_id: "" },
			}),
		),
	);
	expect(
		results.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	expect(loadConversionJournal().entries).toHaveLength(1);
});
