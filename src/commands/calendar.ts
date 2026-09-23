import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import type { Calendar } from "../lib/api/types";
import { readResource } from "../lib/cache";
import {
	CalendarResolutionError,
	calendarFlags,
	findDefaultEventCalendar,
	formatCalendarReference,
	isDeletedCalendar,
	isHiddenCalendar,
	resolveCalendarFromList,
} from "../lib/calendar";

interface CleanCalendar {
	id: string;
	title: string;
	connector: string;
	origin_id: string;
	origin_account_id: string;
	akiflow_account_id: string;
	timezone: string;
	color: string | null;
	primary: boolean;
	akiflow_primary: boolean;
	default_event_calendar: boolean;
	writable: boolean;
	read_only: boolean;
	hidden: boolean;
	deleted: boolean;
	visible: boolean;
	flags: string[];
}

function fail(error: unknown): never {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Error: ${message}`);
	process.exit(1);
}

function cleanCalendar(
	calendar: Calendar,
	defaultEventCalendarId: string | null,
): CleanCalendar {
	const hidden = isHiddenCalendar(calendar);
	const deleted = isDeletedCalendar(calendar);
	const readOnly = calendar.read_only === true;
	return {
		id: calendar.id,
		title: calendar.title,
		connector: calendar.connector_id,
		origin_id: calendar.origin_id,
		origin_account_id: calendar.origin_account_id,
		akiflow_account_id: calendar.akiflow_account_id,
		timezone: calendar.timezone,
		color: calendar.color,
		primary: calendar.primary,
		akiflow_primary: calendar.akiflow_primary,
		default_event_calendar: calendar.id === defaultEventCalendarId,
		writable: !readOnly && !hidden && !deleted,
		read_only: readOnly,
		hidden,
		deleted,
		visible: !hidden && !deleted,
		flags: calendarFlags(calendar, defaultEventCalendarId),
	};
}

function cleanCalendars(calendars: Calendar[]): CleanCalendar[] {
	const defaultEventCalendarId =
		findDefaultEventCalendar(calendars)?.id ?? null;
	return calendars.map((calendar) =>
		cleanCalendar(calendar, defaultEventCalendarId),
	);
}

function activeVisibleCalendars(calendars: Calendar[]): Calendar[] {
	return calendars.filter(
		(calendar) => !isHiddenCalendar(calendar) && !isDeletedCalendar(calendar),
	);
}

function sortedCalendars(calendars: Calendar[]): Calendar[] {
	return [...calendars].sort((a, b) => {
		const primaryDiff =
			Number(b.primary || b.akiflow_primary) -
			Number(a.primary || a.akiflow_primary);
		if (primaryDiff !== 0) return primaryDiff;
		return a.title.localeCompare(b.title);
	});
}

function printJson(result: unknown): void {
	console.log(
		JSON.stringify({ result, next_cursor: null, errors: [] }, null, 2),
	);
}

function pad(value: string, width: number): string {
	return value.length >= width
		? value.slice(0, width - 1) + "."
		: value.padEnd(width);
}

function printCalendarTable(calendars: Calendar[]): void {
	if (calendars.length === 0) {
		console.log("No calendars found.");
		return;
	}

	const cleaned = cleanCalendars(calendars);
	const header = [
		pad("Title", 24),
		pad("Connector", 10),
		pad("Origin", 26),
		pad("Timezone", 22),
		pad("Flags", 28),
		"ID",
	].join("  ");
	console.log(header);
	console.log("-".repeat(header.length));
	for (const calendar of cleaned) {
		console.log(
			[
				pad(calendar.title, 24),
				pad(calendar.connector, 10),
				pad(calendar.origin_id ?? "", 26),
				pad(calendar.timezone ?? "", 22),
				pad(calendar.flags.join(","), 28),
				calendar.id,
			].join("  "),
		);
	}
}

function printResolvedCalendar(
	calendar: Calendar,
	calendars: Calendar[],
): void {
	const defaultEventCalendarId =
		findDefaultEventCalendar(calendars)?.id ?? null;
	const cleaned = cleanCalendar(calendar, defaultEventCalendarId);
	console.log(formatCalendarReference(calendar));
	console.log(`  Timezone: ${cleaned.timezone}`);
	console.log(`  Flags: ${cleaned.flags.join(", ")}`);
}

export const calendarListCommand = defineCommand({
	meta: {
		name: "list",
		description: "List Akiflow calendars",
	},
	args: {
		all: {
			type: "boolean",
			description: "Include hidden and deleted calendars",
		},
		json: {
			type: "boolean",
			description: "Output calendars as JSON",
		},
	},
	run: async ({ args }) => {
		const client = createClient();
		try {
			const allCalendars = sortedCalendars(
				await readResource(client, "calendars"),
			);
			const calendars = args.all
				? allCalendars
				: activeVisibleCalendars(allCalendars);
			if (args.json) {
				printJson(cleanCalendars(calendars));
			} else {
				printCalendarTable(calendars);
			}
		} catch (error) {
			fail(error);
		}
	},
});

export const calendarDefaultCommand = defineCommand({
	meta: {
		name: "default",
		description:
			"Show the writable primary Google calendar used for event creation",
	},
	args: {
		json: {
			type: "boolean",
			description: "Output default calendar as JSON",
		},
	},
	run: async ({ args }) => {
		const client = createClient();
		try {
			const calendars = await readResource(client, "calendars");
			const calendar = findDefaultEventCalendar(calendars);
			if (!calendar) {
				throw new CalendarResolutionError(
					"Could not determine a writable primary Google calendar from the Akiflow calendar cache. Run af refresh or pass --calendar explicitly.",
				);
			}
			if (args.json) {
				printJson(cleanCalendar(calendar, calendar.id));
			} else {
				printResolvedCalendar(calendar, calendars);
			}
		} catch (error) {
			fail(error);
		}
	},
});

export const calendarResolveCommand = defineCommand({
	meta: {
		name: "resolve",
		description: "Resolve a calendar id, origin id, or unique title",
	},
	args: {
		calendar: {
			type: "positional",
			description: "Calendar id, origin id, or unique title",
			required: true,
		},
		json: {
			type: "boolean",
			description: "Output resolved calendar as JSON",
		},
	},
	run: async ({ args }) => {
		const client = createClient();
		try {
			const calendars = await readResource(client, "calendars");
			const calendar = resolveCalendarFromList(
				calendars,
				args.calendar as string,
				{ includeDeleted: true, includeHidden: true },
			);
			const defaultEventCalendarId =
				findDefaultEventCalendar(calendars)?.id ?? null;
			if (args.json) {
				printJson(cleanCalendar(calendar, defaultEventCalendarId));
			} else {
				printResolvedCalendar(calendar, calendars);
			}
		} catch (error) {
			fail(error);
		}
	},
});

export const calendarCommand = defineCommand({
	meta: {
		name: "calendar",
		description: "Inspect and resolve Akiflow calendars",
	},
	subCommands: {
		list: calendarListCommand,
		default: calendarDefaultCommand,
		resolve: calendarResolveCommand,
	},
});
