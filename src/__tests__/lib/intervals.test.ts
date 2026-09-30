// Revert checks: each exported primitive was replaced individually with an
// empty/null/zero result; this file failed each time; the original was restored.
import { expect, test } from "bun:test";
import {
	intersectIntervals,
	intervalMinutes,
	occurrenceInterval,
	subtractIntervals,
	unionIntervals,
} from "../../lib/intervals";

test("occurrenceInterval excludes points and zero-length spans", () => {
	expect(occurrenceInterval({ start: new Date(1), end: new Date(2) })).toEqual({
		start: 1,
		end: 2,
	});
	for (const end of [null, new Date(1), new Date(0)])
		expect(occurrenceInterval({ start: new Date(1), end })).toBeNull();
});
test("union merges overlap, nesting and adjacency without mutating inputs", () => {
	const input = [
		{ start: 4, end: 7 },
		{ start: 1, end: 3 },
		{ start: 3, end: 5 },
		{ start: 2, end: 3 },
		{ start: 9, end: 10 },
	];
	const before = structuredClone(input);
	expect(unionIntervals(input)).toEqual([
		{ start: 1, end: 7 },
		{ start: 9, end: 10 },
	]);
	expect(input).toEqual(before);
	expect(unionIntervals([{ start: 1, end: 1 }])).toEqual([]);
});
test("intersection is half-open", () => {
	expect(
		intersectIntervals({ start: 1, end: 5 }, { start: 3, end: 7 }),
	).toEqual({ start: 3, end: 5 });
	expect(
		intersectIntervals({ start: 1, end: 3 }, { start: 3, end: 7 }),
	).toBeNull();
});
test("minutes round", () => {
	expect(intervalMinutes({ start: 0, end: 90000 })).toBe(2);
	expect(intervalMinutes({ start: 0, end: 29000 })).toBe(0);
});
test("subtract clamps busy union and keeps all gaps", () => {
	expect(
		subtractIntervals({ start: 0, end: 10 }, [
			{ start: -1, end: 2 },
			{ start: 3, end: 4 },
			{ start: 4, end: 6 },
			{ start: 8, end: 12 },
		]),
	).toEqual([
		{ start: 2, end: 3 },
		{ start: 6, end: 8 },
	]);
	expect(subtractIntervals({ start: 0, end: 10 }, [])).toEqual([
		{ start: 0, end: 10 },
	]);
	expect(
		subtractIntervals({ start: 0, end: 10 }, [{ start: -1, end: 11 }]),
	).toEqual([]);
});
