// Revert checks: serializeOccurrence and buildReviewEnvelope were individually
// replaced with empty implementations; both caused failures in this file.
// Originals were restored from an external backup after each replacement.
import { expect, test } from "bun:test";
import { deduplicateOccurrences } from "../../lib/capacity";
import { normalizeTask } from "../../lib/occurrence";
import {
	buildReviewEnvelope,
	serializeOccurrence,
} from "../../lib/review-envelope";
import { instant, occurrence, task } from "./occurrence-fixtures";

const window = { start: instant(8).getTime(), end: instant(12).getTime() };
test("serializeOccurrence emits plain JSON including recurrence anchor and dedup reason", () => {
	const input = occurrence({
		task_id: "t",
		original_start_time: instant(7).toISOString(),
		recurring_id: "series",
	});
	const result = deduplicateOccurrences([input, normalizeTask(task())!]);
	const serialized = serializeOccurrence(result[0]!);
	expect(serialized.start).toBe(instant(9).toISOString());
	expect(serialized.end).toBe(instant(10).toISOString());
	expect(serialized.recurrence.original_start_time).toBe(
		instant(7).toISOString(),
	);
	expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);
	const taskRecord = serializeOccurrence(result[1]!);
	expect(taskRecord.timeSuppressed).toBe(true);
	expect(taskRecord.suppressReason).toContain("event e");
	const point = serializeOccurrence(
		deduplicateOccurrences([normalizeTask(task({ duration: null }))!])[0]!,
	);
	expect(point.end).toBeNull();
	expect(point.recurrence.original_start_time).toBeNull();
});
test("review envelope retains constituents, computes window capacity and min-size free windows", () => {
	const envelope = buildReviewEnvelope(
		[occurrence({ task_id: "t" }), normalizeTask(task({ duration: 7200 }))!],
		window,
		90,
	);
	expect(envelope.schema_version).toBe(1);
	expect(envelope.occurrences).toHaveLength(2);
	expect(envelope.occurrences[1]!.timeSuppressed).toBe(true);
	expect(envelope.busy_minutes).toBe(60);
	expect(envelope.window).toEqual({
		start: instant(8).toISOString(),
		end: instant(12).toISOString(),
	});
	expect(envelope.free_windows).toEqual([
		{ start: instant(10).toISOString(), end: instant(12).toISOString() },
	]);
	expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
});
test("envelope clips capacity but preserves original overnight occurrence bounds", () => {
	const envelope = buildReviewEnvelope(
		[
			occurrence({
				start_time: instant(7).toISOString(),
				end_time: instant(9).toISOString(),
			}),
		],
		window,
	);
	expect(envelope.busy_minutes).toBe(60);
	expect(envelope.occurrences[0]!.start).toBe(instant(7).toISOString());
	expect(envelope.free_windows).toEqual([
		{ start: instant(9).toISOString(), end: instant(12).toISOString() },
	]);
});
test("echo warnings are visible without suppressing either constituent", () => {
	const envelope = buildReviewEnvelope(
		[
			occurrence({ id: "one", origin_id: "same" }),
			occurrence({
				id: "two",
				origin_id: "same",
				end_time: instant(11).toISOString(),
			}),
		],
		window,
	);
	expect(envelope.warnings).toHaveLength(1);
	expect(envelope.warnings[0]).toContain("Possible provider echoes");
	expect(
		envelope.occurrences.every(
			(o) => !o.timeSuppressed && o.possibleEchoGroup !== null,
		),
	).toBe(true);
	expect(envelope.busy_minutes).toBe(120);
});
