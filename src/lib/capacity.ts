import {
	type Interval,
	intersectIntervals,
	occurrenceInterval,
	subtractIntervals,
	unionIntervals,
} from "./intervals";
import type { Occurrence } from "./occurrence";

export interface DedupedOccurrence extends Occurrence {
	timeSuppressed: boolean;
	suppressReason: string | null;
	possibleEchoGroup: string | null;
}
function active(o: Occurrence): boolean {
	return !o.cancelled && !o.done && !o.trashed && !o.deleted && !o.declined;
}
/** Explicit links only. Every constituent remains available for review. */
export function deduplicateOccurrences(
	occurrences: readonly Occurrence[],
): DedupedOccurrence[] {
	const events = occurrences.filter((o) => o.source === "event" && active(o));
	const slots = occurrences.filter((o) => o.source === "slot" && active(o));
	return occurrences.map((o) => {
		let winner: Occurrence | undefined;
		if (o.source === "slot")
			winner = events.find((e) => e.linkage.timeSlotId === o.id);
		if (o.source === "task") {
			winner = events.find((e) => e.linkage.taskId === o.id);
			const slot = slots.find((s) => s.id === o.linkage.timeSlotId);
			// A linked slot's representing event also represents its contained tasks.
			if (!winner && slot)
				winner = events.find((e) => e.linkage.timeSlotId === slot.id) ?? slot;
		}
		return {
			...o,
			timeSuppressed: !!winner,
			suppressReason: winner
				? `linked ${winner.source} ${winner.id} represents ${o.source} ${o.id}`
				: null,
			possibleEchoGroup: null,
		};
	});
}
/** Connected overlap groups sharing an explicit provider identity + connector. */
export function markPossibleEchoes(
	occurrences: readonly DedupedOccurrence[],
): DedupedOccurrence[] {
	const result = occurrences.map((o) => ({
		...o,
		possibleEchoGroup: null as string | null,
	}));
	const visited = new Set<DedupedOccurrence>();
	for (const first of result) {
		if (visited.has(first)) continue;
		if (first.provenance.origin_id == null || first.connectorId == null)
			continue;
		const group = [first];
		visited.add(first);
		// Array iteration visits newly appended members, computing overlap closure.
		for (const current of group) {
			const interval = occurrenceInterval(current);
			if (!interval) continue;
			for (const other of result) {
				if (visited.has(other)) continue;
				if (
					other.connectorId !== first.connectorId ||
					other.provenance.origin_id !== first.provenance.origin_id
				)
					continue;
				const otherInterval = occurrenceInterval(other);
				if (otherInterval && intersectIntervals(interval, otherInterval)) {
					visited.add(other);
					group.push(other);
				}
			}
		}
		if (group.length > 1) {
			const key = JSON.stringify([
				first.connectorId,
				first.provenance.origin_id,
				group.map((o) => `${o.source}:${o.id}`).sort(),
			]);
			for (const o of group) o.possibleEchoGroup = key;
		}
	}
	return result;
}
function busyIntervals(
	occurrences: readonly (Occurrence | DedupedOccurrence)[],
): Interval[] {
	return unionIntervals(
		occurrences
			.filter((o) => active(o) && !("timeSuppressed" in o && o.timeSuppressed))
			.map(occurrenceInterval)
			.filter((i): i is Interval => i !== null),
	);
}
/** Plain union total, with rounding only after summing milliseconds. No clamp. */
export function occupiedMinutes(
	occurrences: readonly (Occurrence | DedupedOccurrence)[],
): number {
	return Math.round(
		busyIntervals(occurrences).reduce((sum, i) => sum + i.end - i.start, 0) /
			60000,
	);
}
export function freeWindows(
	occurrences: readonly (Occurrence | DedupedOccurrence)[],
	window: Interval,
	minMinutes = 0,
): Interval[] {
	return subtractIntervals(window, busyIntervals(occurrences)).filter(
		(i) => i.end - i.start >= minMinutes * 60000,
	);
}
