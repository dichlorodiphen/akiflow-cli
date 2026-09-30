import type { Occurrence } from "./occurrence";

/** Epoch milliseconds; half-open [start, end). */
export interface Interval {
	start: number;
	end: number;
}
export function occurrenceInterval(
	occurrence: Pick<Occurrence, "start" | "end">,
): Interval | null {
	const start = occurrence.start.getTime();
	const end = occurrence.end?.getTime();
	return end !== undefined &&
		Number.isFinite(start) &&
		Number.isFinite(end) &&
		end > start
		? { start, end }
		: null;
}
export function unionIntervals(intervals: readonly Interval[]): Interval[] {
	const sorted = intervals
		.filter(
			(i) =>
				Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start,
		)
		.map((i) => ({ ...i }))
		.sort((a, b) => a.start - b.start);
	const result: Interval[] = [];
	for (const interval of sorted) {
		const last = result.at(-1);
		if (last && interval.start <= last.end)
			last.end = Math.max(last.end, interval.end);
		else result.push(interval);
	}
	return result;
}
export function intersectIntervals(a: Interval, b: Interval): Interval | null {
	const start = Math.max(a.start, b.start);
	const end = Math.min(a.end, b.end);
	return end > start ? { start, end } : null;
}
export function intervalMinutes(interval: Interval): number {
	return Math.round(Math.max(0, interval.end - interval.start) / 60000);
}
export function subtractIntervals(
	window: Interval,
	busy: readonly Interval[],
): Interval[] {
	if (window.end <= window.start) return [];
	let cursor = window.start;
	const result: Interval[] = [];
	for (const interval of unionIntervals(busy)) {
		const clipped = intersectIntervals(window, interval);
		if (!clipped) continue;
		if (clipped.start > cursor)
			result.push({ start: cursor, end: clipped.start });
		cursor = Math.max(cursor, clipped.end);
	}
	if (cursor < window.end) result.push({ start: cursor, end: window.end });
	return result;
}
