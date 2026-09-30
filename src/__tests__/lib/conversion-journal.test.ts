import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearConversionEntry,
	decodeResumeToken,
	encodeResumeToken,
	findTargetForSource,
	loadConversionJournal,
	recordConversion,
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
	test("records and finds mappings", () => {
		expect(findTargetForSource("task-1")).toBeNull();

		recordConversion({
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

	test("record is idempotent (replaces, not duplicates)", () => {
		recordConversion({
			source_task_id: "task-1",
			target_event_id: "event-1",
			converted_at: "2026-06-20T00:00:00.000Z",
			provenance: { title: "Test", start_time: "", calendar_id: "" },
		});
		recordConversion({
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

	test("clear removes entry", () => {
		recordConversion({
			source_task_id: "task-1",
			target_event_id: "event-1",
			converted_at: "2026-06-20T00:00:00.000Z",
			provenance: { title: "Test", start_time: "", calendar_id: "" },
		});
		expect(findTargetForSource("task-1")).toBe("event-1");

		clearConversionEntry("task-1");
		expect(findTargetForSource("task-1")).toBeNull();
	});

	test("persists across loads (survives rerun)", () => {
		recordConversion({
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
});

describe("resume token", () => {
	test("encodes and decodes", () => {
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

	test("decode returns null for invalid tokens", () => {
		expect(decodeResumeToken("not-valid-base64!!!")).toBeNull();
		expect(decodeResumeToken("")).toBeNull();
		expect(
			decodeResumeToken(
				Buffer.from(JSON.stringify({ version: 999 }), "utf-8").toString(
					"base64url",
				),
			),
		).toBeNull();
	});
});
