import {
	type DedupedOccurrence,
	deduplicateOccurrences,
	freeWindows,
	markPossibleEchoes,
	occupiedMinutes,
} from "./capacity";
import { getLocalTimezone } from "./date-parser";
import {
	type Interval,
	intersectIntervals,
	occurrenceInterval,
} from "./intervals";
import type { Occurrence, RecurrenceIdentity } from "./occurrence";

export interface ReviewOccurrence
	extends Omit<DedupedOccurrence, "start" | "end" | "recurrence"> {
	start: string;
	end: string | null;
	recurrence: Omit<RecurrenceIdentity, "original_start_time"> & {
		original_start_time: string | null;
	};
}
export interface ReviewEnvelope {
	schema_version: 1;
	generated_at: string;
	timezone: string;
	provenance: { generation: string | null; observed_at: string | null };
	window: { start: string; end: string };
	occurrences: ReviewOccurrence[];
	busy_minutes: number;
	free_windows: { start: string; end: string }[];
	warnings: string[];
}
export function serializeOccurrence(o: DedupedOccurrence): ReviewOccurrence {
	return {
		...o,
		start: o.start.toISOString(),
		end: o.end?.toISOString() ?? null,
		recurrence: {
			...o.recurrence,
			original_start_time:
				o.recurrence.original_start_time?.toISOString() ?? null,
		},
	};
}
/** Inputs should come from queryOccurrences for this window and desired visibility. */
export function buildReviewEnvelope(
	occurrences: readonly Occurrence[],
	window: Interval,
	minMinutes = 0,
	metadata: { generation: string | null; observed_at: string | null } = {
		generation: null,
		observed_at: null,
	},
): ReviewEnvelope {
	const effective = markPossibleEchoes(deduplicateOccurrences(occurrences));
	// Envelope capacity describes its window; occupiedMinutes itself never clamps.
	const clipped = effective.flatMap((o) => {
		const interval = occurrenceInterval(o);
		const intersection = interval && intersectIntervals(interval, window);
		return intersection
			? [
					{
						...o,
						start: new Date(intersection.start),
						end: new Date(intersection.end),
					},
				]
			: [];
	});
	const groups = new Set(
		effective
			.map((o) => o.possibleEchoGroup)
			.filter((g): g is string => g !== null),
	);
	return {
		schema_version: 1,
		generated_at: new Date().toISOString(),
		timezone: getLocalTimezone(),
		provenance: metadata,
		window: {
			start: new Date(window.start).toISOString(),
			end: new Date(window.end).toISOString(),
		},
		occurrences: effective.map(serializeOccurrence),
		busy_minutes: occupiedMinutes(clipped),
		free_windows: freeWindows(effective, window, minMinutes).map((i) => ({
			start: new Date(i.start).toISOString(),
			end: new Date(i.end).toISOString(),
		})),
		warnings: [...groups].map((g) => `Possible provider echoes: ${g}`),
	};
}
