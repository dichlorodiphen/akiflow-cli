// Revert checks: deduplicateOccurrences, markPossibleEchoes, occupiedMinutes and
// freeWindows were individually replaced with identity/zero/empty implementations.
// Each replacement failed this file; the backed-up library was restored each time.
import { expect, test } from "bun:test";
import {
	deduplicateOccurrences,
	freeWindows,
	markPossibleEchoes,
	occupiedMinutes,
} from "../../lib/capacity";
import { normalizeSlot, normalizeTask } from "../../lib/occurrence";
import { instant, occurrence, slot, task } from "./occurrence-fixtures";

const t = (overrides: Parameters<typeof task>[0] = {}) =>
	normalizeTask(task(overrides))!;
const s = (overrides: Parameters<typeof slot>[0] = {}) =>
	normalizeSlot(slot(overrides))!;

test("event represents linked task even when their intervals differ; retains reason naming winner", () => {
	const result = deduplicateOccurrences([
		occurrence({ task_id: "t" }),
		t({ duration: 7200 }),
	]);
	expect(result).toHaveLength(2);
	expect(result[1]!.timeSuppressed).toBe(true);
	expect(result[1]!.suppressReason).toBe("linked event e represents task t");
	expect(occupiedMinutes(result)).toBe(60);
});
test("event represents linked slot; constituent retained", () => {
	const result = deduplicateOccurrences([
		occurrence({ time_slot_id: "s" }),
		s({ end_time: instant(11).toISOString() }),
	]);
	expect(result).toHaveLength(2);
	expect(result[1]!.timeSuppressed).toBe(true);
	expect(result[1]!.suppressReason).toBe("linked event e represents slot s");
	expect(occupiedMinutes(result)).toBe(60);
});
test("slot represents every explicitly contained task", () => {
	const result = deduplicateOccurrences([
		s(),
		t({ time_slot_id: "s", duration: 7200 }),
		t({ id: "t2", time_slot_id: "s", duration: 10800 }),
	]);
	expect(result).toHaveLength(3);
	for (const taskOccurrence of result.slice(1)) {
		expect(taskOccurrence.timeSuppressed).toBe(true);
		expect(taskOccurrence.suppressReason).toContain("linked slot s");
	}
	expect(occupiedMinutes(result)).toBe(60);
});
test("event beats slot for same task regardless of input order; transitive winner is named", () => {
	for (const input of [
		[
			t({ time_slot_id: "s", duration: 10800 }),
			s(),
			occurrence({ task_id: "t" }),
		],
		[occurrence({ task_id: "t" }), s(), t({ time_slot_id: "s" })],
	]) {
		const result = deduplicateOccurrences(input);
		expect(result.find((o) => o.source === "task")!.suppressReason).toBe(
			"linked event e represents task t",
		);
	}
	const result = deduplicateOccurrences([
		t({ time_slot_id: "s", duration: 10800 }),
		s({ end_time: instant(11).toISOString() }),
		occurrence({ time_slot_id: "s" }),
	]);
	expect(result.find((o) => o.source === "task")!.suppressReason).toBe(
		"linked event e represents task t",
	);
	expect(occupiedMinutes(result)).toBe(60);
});
test("titles/time similarity and inactive links never suppress active work", () => {
	expect(
		deduplicateOccurrences([occurrence({ task_id: "t" }), t()])[1]
			?.timeSuppressed,
	).toBe(true);
	const result = deduplicateOccurrences([
		occurrence({ title: "Task", task_id: "t", status: "cancelled" }),
		t(),
		s(),
	]);
	expect(result.every((o) => !o.timeSuppressed)).toBe(true);
	expect(
		deduplicateOccurrences([occurrence({ title: "Task" }), t()]).every(
			(o) => !o.timeSuppressed,
		),
	).toBe(true);
});
test("possible echoes group overlapping provider identities, visibly but without suppression", () => {
	const input = deduplicateOccurrences([
		occurrence({ id: "e1", origin_id: "provider" }),
		occurrence({
			id: "e2",
			origin_id: "provider",
			start_time: instant(9).toISOString(),
			end_time: instant(11).toISOString(),
		}),
		occurrence({
			id: "touching",
			origin_id: "provider",
			start_time: instant(11).toISOString(),
			end_time: instant(12).toISOString(),
		}),
		occurrence({
			id: "other-connector",
			origin_id: "provider",
			connector_id: "microsoft",
		}),
		occurrence({ id: "null-origin" }),
	]);
	const result = markPossibleEchoes(input);
	expect(result[0]!.possibleEchoGroup).not.toBeNull();
	expect(result[1]!.possibleEchoGroup).toBe(result[0]!.possibleEchoGroup);
	for (const o of result.slice(2)) expect(o.possibleEchoGroup).toBeNull();
	expect(
		result.every((o) => !o.timeSuppressed && o.suppressReason === null),
	).toBe(true);
	expect(input.every((o) => o.possibleEchoGroup === null)).toBe(true);
	expect(occupiedMinutes(result.slice(0, 2))).toBe(120);
});
test("busy union excludes cancelled, done, trashed, declined, deleted, suppressed and point records", () => {
	const result = deduplicateOccurrences([
		occurrence(),
		occurrence({
			id: "overlap",
			start_time: instant(9).toISOString(),
			end_time: instant(11).toISOString(),
		}),
		occurrence({
			id: "cancelled",
			status: "cancelled",
			end_time: instant(15).toISOString(),
		}),
		occurrence({
			id: "declined",
			declined: true,
			end_time: instant(15).toISOString(),
		}),
		t({ done: true, duration: 21600 }),
		t({ trashed_at: "now", duration: 21600 }),
		t({ deleted_at: "now", duration: 21600 }),
		t({ duration: null }),
	]);
	expect(occupiedMinutes(result)).toBe(120);
	expect(
		occupiedMinutes([
			occurrence({
				start_time: instant(7).toISOString(),
				end_time: instant(12).toISOString(),
			}),
		]),
	).toBe(300);
});
test("free windows clamp to window, subtract union, and compare exact minimum duration", () => {
	const window = { start: instant(8).getTime(), end: instant(12).getTime() };
	expect(freeWindows([occurrence()], window, 90)).toEqual([
		{ start: instant(10).getTime(), end: instant(12).getTime() },
	]);
	expect(freeWindows([occurrence()], window, 60)).toEqual([
		{ start: instant(8).getTime(), end: instant(9).getTime() },
		{ start: instant(10).getTime(), end: instant(12).getTime() },
	]);
	expect(
		freeWindows(
			[
				occurrence({
					start_time: instant(7).toISOString(),
					end_time: instant(13).toISOString(),
				}),
			],
			window,
		),
	).toEqual([]);
	expect(freeWindows([], { start: 0, end: 59999 }, 1)).toEqual([]);
});
