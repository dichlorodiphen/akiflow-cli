import { deduplicateOccurrences, markPossibleEchoes } from "./capacity";
import { intersectIntervals, occurrenceInterval } from "./intervals";
import {
	normalizeEvent,
	normalizeSlot,
	normalizeTask,
	type Occurrence,
	type OccurrenceInputs,
	type OccurrenceQuery,
} from "./occurrence";

const identity = (o: Occurrence) => ({
	source: o.source,
	id: o.id,
	start: o.start.toISOString(),
	end: o.end?.toISOString() ?? null,
});
export function auditDiscrepancies(occurrences: readonly Occurrence[]) {
	const effective = markPossibleEchoes(deduplicateOccurrences(occurrences));
	const groups = new Map<string, typeof effective>();
	for (const o of effective)
		if (o.possibleEchoGroup) {
			const group = groups.get(o.possibleEchoGroup) ?? [];
			group.push(o);
			groups.set(o.possibleEchoGroup, group);
		}
	const possible_echo_groups = [...groups].map(([group, members]) => ({
		group,
		members: members.map(identity),
		suggested_canonical: identity(
			// Group membership already requires a shared non-null provider
			// origin_id on one connector, so "provider wins" is inherent in
			// the grouping: the canonical is the earliest start, id on ties.
			[...members].sort(
				(a, b) =>
					a.start.getTime() - b.start.getTime() || a.id.localeCompare(b.id),
			)[0]!,
		),
		reason:
			"Group shares one provider origin_id on one connector; earliest start wins (ID breaks exact ties); review only",
	}));
	const owner_overrides = occurrences
		.filter((o) => o.source === "event" && !o.cancelled && !o.declined)
		.flatMap((event) =>
			occurrences
				.filter(
					(o) =>
						(o.source === "task" && o.id === event.linkage.taskId) ||
						(o.source === "slot" && o.id === event.linkage.timeSlotId),
				)
				.map((linked) => {
					const a = occurrenceInterval(event);
					const b = occurrenceInterval(linked);
					const overlapping =
						a && b
							? intersectIntervals(a, b) !== null
							: linked.start >= event.start &&
								(!event.end || linked.start < event.end);
					return {
						owner: identity(event),
						linked: identity(linked),
						divergent: !overlapping,
						reason: "Owner overrides win: linked event owns time",
					};
				}),
		);
	return {
		possible_echo_groups,
		owner_overrides,
		link_divergences: owner_overrides.filter((o) => o.divergent),
	};
}
/** Count status exclusions within range and identity scope, before visibility filtering. */
export function auditStatusCounts(
	input: OccurrenceInputs,
	query: OccurrenceQuery,
	effective: readonly Occurrence[],
) {
	const seen = [
		...(input.events ?? []).map(normalizeEvent),
		...(input.slots ?? []).map(normalizeSlot),
		...(input.tasks ?? []).map(normalizeTask),
	]
		.filter((o): o is Occurrence => !!o)
		.filter(
			(o) =>
				(!query.from ||
					(o.end && o.end > o.start
						? o.end > query.from
						: o.start >= query.from)) &&
				(!query.to || o.start < query.to) &&
				(query.accountId === undefined || o.accountId === query.accountId) &&
				(query.connectorId === undefined ||
					o.connectorId === query.connectorId) &&
				(query.calendarId === undefined || o.calendarId === query.calendarId),
		);
	return Object.fromEntries(
		(["cancelled", "declined", "done", "trashed"] as const).map((status) => {
			const records = seen.filter((o) => o[status]);
			return [
				status,
				{
					seen: records.length,
					excluded: records.filter(
						(o) =>
							!effective.some((e) => e.source === o.source && e.id === o.id),
					).length,
				},
			];
		}),
	);
}
