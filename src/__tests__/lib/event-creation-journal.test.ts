import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearCreatedEvent,
	deleteNeedsConfirmation,
	loadCreatedEventIds,
	loadCreatedEventJournal,
	recordCreatedEvent,
	wasCreatedByCli,
} from "../../lib/event-creation-journal";

let testDir: string;
let originalCacheDir: string | undefined;

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), "af-created-events-test-"));
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

function entry(id: string) {
	return {
		event_id: id,
		created_at: "2026-09-30T00:00:00.000Z",
		provenance: { title: "Test event", calendar_id: "cal-123" },
	};
}

describe("event-creation journal", () => {
	test("starts empty", () => {
		expect(wasCreatedByCli("event-1")).toBe(false);
		expect(loadCreatedEventJournal().entries).toEqual([]);
		expect(loadCreatedEventIds().size).toBe(0);
	});

	test("records and finds created events", () => {
		recordCreatedEvent(entry("event-1"));
		expect(wasCreatedByCli("event-1")).toBe(true);
		expect(wasCreatedByCli("event-2")).toBe(false);
		expect(loadCreatedEventIds()).toEqual(new Set(["event-1"]));
	});

	test("recording is idempotent (no duplicates)", () => {
		recordCreatedEvent(entry("event-1"));
		recordCreatedEvent(entry("event-1"));
		expect(loadCreatedEventJournal().entries).toHaveLength(1);
	});

	test("clear removes the entry", () => {
		recordCreatedEvent(entry("event-1"));
		recordCreatedEvent(entry("event-2"));
		clearCreatedEvent("event-1");
		expect(wasCreatedByCli("event-1")).toBe(false);
		expect(wasCreatedByCli("event-2")).toBe(true);
	});

	test("clear is a no-op for unknown ids", () => {
		recordCreatedEvent(entry("event-1"));
		clearCreatedEvent("missing");
		expect(loadCreatedEventJournal().entries).toHaveLength(1);
	});

	test("corrupt journal reads as empty", () => {
		writeFileSync(join(testDir, "created-events-journal.json"), "{nope");
		expect(wasCreatedByCli("event-1")).toBe(false);
		expect(loadCreatedEventJournal().entries).toEqual([]);
	});

	test("wrong-version journal reads as empty", () => {
		writeFileSync(
			join(testDir, "created-events-journal.json"),
			JSON.stringify({ version: 2, entries: [entry("event-1")] }),
		);
		expect(wasCreatedByCli("event-1")).toBe(false);
	});
});

describe("deleteNeedsConfirmation", () => {
	test("needs confirmation for events the CLI did not create", () => {
		expect(deleteNeedsConfirmation("foreign-1", new Set(["own-1"]))).toBe(true);
	});

	test("no confirmation needed for CLI-created events", () => {
		expect(deleteNeedsConfirmation("own-1", new Set(["own-1"]))).toBe(false);
	});

	test("empty journal means every delete needs confirmation", () => {
		expect(deleteNeedsConfirmation("anything", new Set())).toBe(true);
	});
});
