import type { CacheClient, Resource } from "./cache";
import { snapshotResources } from "./cache";
import { resolveCalendarFromList } from "./calendar";
import {
	endOfDay,
	formatLocalDate,
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
import { overlayPendingTasks } from "./tasks";
import {
	calendarDayStartUtc,
	formatInTimezone,
	utcToDateString,
	zonedTimeToUtc,
} from "./timezone";
import { resolveEffectiveTimezone } from "./timezone-profile";

export const occurrenceReadArgs = {
	timezone: {
		type: "string",
		description:
			"IANA timezone for date selectors (profile, then local by default)",
	},
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

export function occurrenceRange(
	args: Record<string, unknown>,
	now = new Date(),
) {
	const timezone =
		typeof args.timezone === "string"
			? args.timezone
			: Intl.DateTimeFormat().resolvedOptions().timeZone;
	const wall = formatInTimezone(now.toISOString(), timezone);
	const reference = new Date(
		wall.year,
		wall.month - 1,
		wall.day,
		wall.hours,
		wall.minutes,
	);
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
		? resolveRange(named, reference)
		: args.date
			? strictDaySelector(
					/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(
						String(args.date).trim(),
					)
						? utcToDateString(String(args.date), timezone)
						: String(args.date),
					reference,
				)
			: args.from || args.to
				? {
						from: args.from
							? strictBoundarySelector(String(args.from), "start", reference)
							: startOfDay(new Date(0)),
						to: args.to
							? strictBoundarySelector(String(args.to), "end", reference)
							: endOfDay(new Date(9999, 11, 31)),
					}
				: resolveRange("today", reference);
	// Date selectors have inclusive ends; occurrence intervals use exclusive ends.
	const boundary = (date: Date, value: unknown, end: boolean): Date => {
		if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value.trim())) {
			if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim()))
				return new Date(date.getTime() + Number(end));
			return new Date(
				Date.parse(
					zonedTimeToUtc(
						formatLocalDate(date),
						date.getHours(),
						date.getMinutes(),
						timezone,
					),
				) +
					date.getSeconds() * 1000 +
					date.getMilliseconds() +
					Number(end),
			);
		}
		const civil = new Date(date);
		if (
			end &&
			civil.getFullYear() === 9999 &&
			civil.getMonth() === 11 &&
			civil.getDate() === 31
		) {
			// The open upper sentinel is one instant beyond the four-digit input
			// vocabulary; never feed year 10000 back into the date validator.
			return new Date(
				Date.parse(zonedTimeToUtc("9999-12-31", 23, 59, timezone, "second")) +
					60000,
			);
		}
		if (end) civil.setDate(civil.getDate() + 1);
		return new Date(calendarDayStartUtc(formatLocalDate(civil), timezone));
	};
	const from = boundary(range.from, args.from, false);
	const to = boundary(range.to, args.to, true);
	if (from >= to)
		throw new UsageError("Date range end must be after its start");
	return { from, to };
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
	const timezone = await resolveEffectiveTimezone(
		args.timezone as string | undefined,
	);
	const range = occurrenceRange({ ...args, timezone });
	const minMinutes = minimumMinutes(args);
	const resources: Resource[] = ["calendars"];
	if (args.events !== false) resources.push("events");
	if (args.slots !== false) resources.push("time_slots");
	if (args.tasks !== false) resources.push("tasks");
	if (args.json && !args.summary && !args.free) resources.push("accounts");
	const snapshot = await snapshotResources(client, resources);
	const observedTaskIds = new Set(
		(snapshot.data.tasks ?? []).map((task) => task.id),
	);
	const tasks =
		args.tasks === false
			? []
			: overlayPendingTasks(snapshot.data.tasks, {
					includeTrashed: true,
					deletedTasks: snapshot.deletedTasks,
				});
	const calendars = snapshot.data.calendars;
	const calendarId =
		args.calendar === undefined
			? undefined
			: resolveCalendarFromList(calendars, String(args.calendar), {
					includeDeleted: true,
					includeHidden: true,
				}).id;
	const recurrenceWarnings: string[] = [];
	const query: OccurrenceQuery = {
		recurrenceWarnings,
		...range,
		timezone,
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
		tasks,
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
					observedAt:
						resource === "tasks" && !observedTaskIds.has(pair.raw.id)
							? null
							: snapshot.observedAt[resource],
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
		recurrenceWarnings: [...new Set(recurrenceWarnings)],
		timezone,
		input,
		query,
		pairs,
		minMinutes,
		window: { start: range.from.getTime(), end: range.to.getTime() },
	};
}
