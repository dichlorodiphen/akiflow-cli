import type { CacheClient, Resource } from "./cache";
import { snapshotResources } from "./cache";
import { resolveCalendarFromList } from "./calendar";
import {
	endOfDay,
	type NamedRange,
	resolveRange,
	startOfDay,
} from "./date-parser";
import {
	strictBoundarySelector,
	strictDaySelector,
	validateDateSelectors,
} from "./date-selector";
import { parseDurationToSeconds } from "./duration-parser";
import { UsageError } from "./exit-codes";
import {
	attachProvenance,
	type OccurrenceQuery,
	queryOccurrencesWithRaw,
} from "./occurrence";

export const occurrenceReadArgs = {
	today: { type: "boolean", description: "Today (default)" },
	tomorrow: { type: "boolean" },
	date: { type: "string", description: "Single local day" },
	from: { type: "string", description: "Range start" },
	to: { type: "string", description: "Range end" },
	account: { type: "string", description: "Akiflow account ID" },
	connector: { type: "string", description: "Connector ID" },
	calendar: {
		type: "string",
		description: "Calendar ID, origin ID, or unique title",
	},
	"min-duration": {
		type: "string",
		description: "Minimum free window duration (e.g. 30m)",
	},
	json: { type: "boolean", description: "JSON output" },
} as const;

export function occurrenceRange(args: Record<string, unknown>) {
	validateDateSelectors(args);
	const names: NamedRange[] = [
		"today",
		"tomorrow",
		"yesterday",
		"this-week",
		"next-week",
		"this-month",
		"next-month",
	];
	const named = names.find((name) => args[name]);
	const range = named
		? resolveRange(named)
		: args.date
			? strictDaySelector(String(args.date))
			: args.from || args.to
				? {
						from: args.from
							? strictBoundarySelector(String(args.from), "start")
							: startOfDay(new Date(0)),
						to: args.to
							? strictBoundarySelector(String(args.to), "end")
							: endOfDay(new Date(9999, 11, 31)),
					}
				: resolveRange("today");
	// Date selectors have inclusive ends; occurrence intervals use exclusive ends.
	return { from: range.from, to: new Date(range.to.getTime() + 1) };
}
export function minimumMinutes(args: Record<string, unknown>): number {
	if (args["min-duration"] === undefined) return 0;
	try {
		const seconds = parseDurationToSeconds(String(args["min-duration"]));
		if (seconds < 0) throw new Error("--min-duration must be nonnegative");
		return seconds / 60;
	} catch (error) {
		throw new UsageError(
			error instanceof Error ? error.message : String(error),
		);
	}
}
export async function readOccurrences(
	client: CacheClient,
	args: Record<string, unknown>,
) {
	const range = occurrenceRange(args);
	const minMinutes = minimumMinutes(args);
	const resources: Resource[] = ["calendars"];
	if (args.events !== false) resources.push("events");
	if (args.slots !== false) resources.push("time_slots");
	if (args.tasks !== false) resources.push("tasks");
	if (args.json && !args.summary && !args.free) resources.push("accounts");
	const snapshot = await snapshotResources(client, resources);
	const calendars = snapshot.data.calendars;
	const calendarId =
		args.calendar === undefined
			? undefined
			: resolveCalendarFromList(calendars, String(args.calendar), {
					includeDeleted: true,
					includeHidden: true,
				}).id;
	const query: OccurrenceQuery = {
		...range,
		calendarId,
		activeCalendarIds: calendars
			.filter((c) => c.deleted_at == null)
			.map((c) => c.id),
		calendarIds: calendars
			.filter((c) => c.deleted_at == null && c.hidden_at == null)
			.map((c) => c.id),
		accountId: args.account as string | undefined,
		connectorId: args.connector as string | undefined,
		includeDeclined: args.declined === true,
		allDayOnly: args["all-day-only"] === true,
		excludeAllDay: args["all-day"] === false,
	};
	const input = {
		events: snapshot.data.events,
		slots: snapshot.data.time_slots,
		tasks: snapshot.data.tasks,
	};
	const pairs = queryOccurrencesWithRaw(input, query)
		.map((pair) => {
			const resource =
				pair.occurrence.source === "event"
					? "events"
					: pair.occurrence.source === "slot"
						? "time_slots"
						: "tasks";
			return {
				...pair,
				occurrence: attachProvenance([pair.occurrence], {
					observedAt: snapshot.observedAt[resource],
					generation: snapshot.generation,
				})[0]!,
			};
		})
		.filter(
			(pair) =>
				!args.search ||
				`${pair.occurrence.title ?? ""}\n${pair.raw.description ?? ""}`
					.toLowerCase()
					.includes(String(args.search).toLowerCase()),
		);
	return {
		snapshot,
		input,
		query,
		pairs,
		minMinutes,
		window: { start: range.from.getTime(), end: range.to.getTime() },
	};
}
