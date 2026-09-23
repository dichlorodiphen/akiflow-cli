import type { Calendar } from "./api/types";
import { type CacheClient, readResource } from "./cache";

export interface ResolveCalendarOptions {
	includeHidden?: boolean;
	includeDeleted?: boolean;
}

export class CalendarResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CalendarResolutionError";
	}
}

export function isDeletedCalendar(calendar: Calendar): boolean {
	return calendar.deleted_at != null;
}

export function isHiddenCalendar(calendar: Calendar): boolean {
	return calendar.hidden_at != null;
}

export function isVisibleActiveCalendar(calendar: Calendar): boolean {
	return !isHiddenCalendar(calendar) && !isDeletedCalendar(calendar);
}

export function isWritableVisibleCalendar(calendar: Calendar): boolean {
	return isVisibleActiveCalendar(calendar) && !calendar.read_only;
}

export function isPrimaryCalendar(calendar: Calendar): boolean {
	return calendar.akiflow_primary === true || calendar.primary === true;
}

export function isGoogleCalendar(calendar: Calendar): boolean {
	return calendar.connector_id === "google";
}

export function findDefaultWritablePrimaryCalendar(
	calendars: Calendar[],
): Calendar | null {
	return (
		calendars.find(
			(calendar) =>
				isWritableVisibleCalendar(calendar) && isPrimaryCalendar(calendar),
		) ?? null
	);
}

export function findDefaultEventCalendar(
	calendars: Calendar[],
): Calendar | null {
	return (
		calendars.find(
			(calendar) =>
				isWritableVisibleCalendar(calendar) &&
				isPrimaryCalendar(calendar) &&
				isGoogleCalendar(calendar),
		) ?? null
	);
}

function eligibleForResolution(
	calendar: Calendar,
	options: ResolveCalendarOptions,
): boolean {
	if (!options.includeHidden && isHiddenCalendar(calendar)) return false;
	if (!options.includeDeleted && isDeletedCalendar(calendar)) return false;
	return true;
}

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

export function calendarFlags(
	calendar: Calendar,
	defaultEventCalendarId?: string | null,
): string[] {
	const flags: string[] = [];
	if (calendar.id === defaultEventCalendarId) flags.push("default");
	if (isPrimaryCalendar(calendar)) flags.push("primary");
	if (calendar.read_only) flags.push("read-only");
	else flags.push("writable");
	if (isHiddenCalendar(calendar)) flags.push("hidden");
	if (isDeletedCalendar(calendar)) flags.push("deleted");
	return flags;
}

export function formatCalendarReference(calendar: Calendar): string {
	const origin = calendar.origin_id ? `, origin=${calendar.origin_id}` : "";
	return `${calendar.title} (id=${calendar.id}${origin}, connector=${calendar.connector_id})`;
}

function formatCalendarSuggestions(calendars: Calendar[]): string {
	const candidates = calendars.slice(0, 5).map(formatCalendarReference);
	if (candidates.length === 0) return "No calendars are available.";
	const suffix =
		calendars.length > candidates.length
			? `, plus ${calendars.length - candidates.length} more`
			: "";
	return `Candidates: ${candidates.join("; ")}${suffix}.`;
}

function requireUniqueMatch(
	input: string,
	stage: string,
	matches: Calendar[],
): Calendar | null {
	if (matches.length === 0) return null;
	if (matches.length === 1) return matches[0] ?? null;
	throw new CalendarResolutionError(
		`Calendar "${input}" is ambiguous by ${stage}. ${formatCalendarSuggestions(matches)}`,
	);
}

export function resolveCalendarFromList(
	calendars: Calendar[],
	input: string,
	options: ResolveCalendarOptions = {},
): Calendar {
	const query = input.trim();
	if (!query) {
		throw new CalendarResolutionError("Calendar value cannot be empty.");
	}

	const candidates = calendars.filter((calendar) =>
		eligibleForResolution(calendar, options),
	);
	const exactId = candidates.find((calendar) => calendar.id === query);
	if (exactId) return exactId;

	const exactOriginId = candidates.find(
		(calendar) => calendar.origin_id === query,
	);
	if (exactOriginId) return exactOriginId;

	const normalizedQuery = normalize(query);
	const exactTitle = requireUniqueMatch(
		query,
		"title",
		candidates.filter(
			(calendar) => normalize(calendar.title) === normalizedQuery,
		),
	);
	if (exactTitle) return exactTitle;

	const titleSubstring = requireUniqueMatch(
		query,
		"title substring",
		candidates.filter((calendar) =>
			normalize(calendar.title).includes(normalizedQuery),
		),
	);
	if (titleSubstring) return titleSubstring;

	throw new CalendarResolutionError(
		`Calendar "${query}" was not found. ${formatCalendarSuggestions(candidates)}`,
	);
}

export async function resolveCalendar(
	client: CacheClient,
	input: string,
	options: ResolveCalendarOptions = {},
): Promise<Calendar> {
	const calendars = await readResource(client, "calendars");
	return resolveCalendarFromList(calendars, input, options);
}

export async function resolveWritableCalendar(
	client: CacheClient,
	calendarInput: string | undefined,
): Promise<Calendar> {
	const calendars = await readResource(client, "calendars");
	const calendar = calendarInput
		? resolveCalendarFromList(calendars, calendarInput, {
				includeDeleted: true,
				includeHidden: true,
			})
		: findDefaultWritablePrimaryCalendar(calendars);

	if (!calendar) {
		throw new CalendarResolutionError(
			"Could not determine a writable primary calendar from the Akiflow calendar cache. Pass --calendar <calendar> explicitly or run af refresh.",
		);
	}

	if (!isWritableVisibleCalendar(calendar)) {
		throw new CalendarResolutionError(
			`Calendar "${calendar.title}" (${calendar.id}) is read-only, hidden, or deleted. Pass a writable --calendar <calendar>.`,
		);
	}

	return calendar;
}

export async function resolveEventTargetCalendar(
	client: CacheClient,
	calendarInput: string | undefined,
	commandName = "af event create",
): Promise<Calendar> {
	const calendars = await readResource(client, "calendars");
	const calendar = calendarInput
		? resolveCalendarFromList(calendars, calendarInput, {
				includeDeleted: true,
				includeHidden: true,
			})
		: findDefaultEventCalendar(calendars);

	if (!calendar) {
		throw new CalendarResolutionError(
			"Could not determine a writable primary Google calendar from the Akiflow calendar cache. Pass --calendar <calendar> explicitly or run af refresh.",
		);
	}

	if (!isWritableVisibleCalendar(calendar)) {
		throw new CalendarResolutionError(
			`Calendar "${calendar.title}" (${calendar.id}) is read-only, hidden, or deleted. Pass a writable --calendar <calendar>.`,
		);
	}

	if (!isGoogleCalendar(calendar)) {
		throw new CalendarResolutionError(
			`${commandName} supports Google calendars only in v1. Calendar "${calendar.title}" (${calendar.id}) uses connector "${calendar.connector_id}".`,
		);
	}

	return calendar;
}

export async function getDefaultCalendarId(
	client: CacheClient,
): Promise<string | null> {
	try {
		const calendars = await readResource(client, "calendars");
		return findDefaultWritablePrimaryCalendar(calendars)?.id ?? null;
	} catch {
		return null;
	}
}
