import { afterEach, expect, spyOn, test } from "bun:test";
import { runMergedCalendar } from "../../commands/cal";
import * as cache from "../../lib/cache";
import { readOccurrences } from "../../lib/occurrence-read";
import * as taskRepository from "../../lib/tasks";
import { event, instant, slot, task } from "../lib/occurrence-fixtures";

let readTasks: ReturnType<typeof spyOn>;
const snapshot = spyOn(cache, "snapshotResources");
const log = spyOn(console, "log").mockImplementation(() => {});
afterEach(() => {
	snapshot.mockReset();
	readTasks?.mockRestore();
	log.mockClear();
});
function seed(
	tasks = [task({ duration: 10800 })],
	tasksObservedAt: string | null = null,
) {
	readTasks = spyOn(taskRepository, "readTasks").mockResolvedValue(tasks);
	snapshot.mockResolvedValue({
		data: {
			events: [event({ task_id: "t" })],
			time_slots: [
				slot({
					start_time: instant(9.5).toISOString(),
					end_time: instant(11).toISOString(),
				}),
			],
			tasks,
			calendars: [
				{ id: "cal", title: "Primary", hidden_at: null, deleted_at: null },
			],
			accounts: [],
			labels: [],
			tags: [],
			contacts: [],
		},
		generation: "gen-1",
		observedAt: {
			events: null,
			tasks: tasksObservedAt,
			time_slots: null,
			calendars: null,
		},
	} as never);
}

// Restore module spies after this file, so other command suites see real functions.
import { afterAll } from "bun:test";

afterAll(() => {
	snapshot.mockRestore();
	log.mockRestore();
});
test("cal summary counts constituents but unions overlap and honors linked time owner", async () => {
	seed();
	await runMergedCalendar({ date: "2026-06-20", summary: true, json: true });
	expect(JSON.parse(String(log.mock.calls[0]![0])).result).toEqual({
		counts: { event: 1, slot: 1, task: 1 },
		total: 3,
		busy_minutes: 120,
	});
});
test("cal free uses the selector window, capacity union, and minimum duration", async () => {
	seed();
	await runMergedCalendar({
		date: "2026-06-20",
		free: true,
		json: true,
		"min-duration": "1h",
	});
	expect(JSON.parse(String(log.mock.calls[0]![0])).result).toEqual([
		{
			start: new Date(2026, 5, 20).toISOString(),
			end: instant(9).toISOString(),
		},
		{
			start: instant(11).toISOString(),
			end: new Date(2026, 5, 21).toISOString(),
		},
	]);
});

test("cal pins task observations alongside events and never repins through readTasks", async () => {
	seed();
	await runMergedCalendar({ date: "2026-06-20", summary: true, json: true });
	expect(snapshot.mock.calls[0]?.[1]).toContain("tasks");
	expect(readTasks).not.toHaveBeenCalled();
});

test("intent-only task never claims a resource observation timestamp", async () => {
	seed([], "2026-06-20T00:00:00Z");
	const overlay = spyOn(taskRepository, "overlayPendingTasks").mockReturnValue([
		task({ pending: true }),
	]);
	try {
		const result = await readOccurrences({} as never, {
			date: "2026-06-20",
			timezone: "UTC",
		});
		const occurrence = result.pairs.find(
			(pair) => pair.occurrence.source === "task",
		)?.occurrence;
		expect(occurrence?.provenance).toMatchObject({
			pending: true,
			generation: "gen-1",
			observedAt: null,
		});
	} finally {
		overlay.mockRestore();
	}
});
