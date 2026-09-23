import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import type {
	Calendar,
	CreateEventPayload,
	Event,
	EventModifier,
	EventModifierPayload,
	TimeSlot,
	UpdateTimeSlotPayload,
} from "../lib/api/types";
import { readResource } from "../lib/cache";
import {
	CalendarResolutionError,
	resolveCalendarFromList,
} from "../lib/calendar";
import {
	endOfDay,
	type NamedRange,
	parseDateBoundary,
	resolveRange,
	resolveSingleDayRange,
	startOfDay,
} from "../lib/date-parser";
import { filterEvents } from "../lib/filters/event";
import {
	buildAttendeeModifierPayload,
	buildEventDeletePayload,
	collectAttendeeEmails,
	existingAttendeeEmails,
} from "./event";
import { buildSlotDeletePayload } from "./slot";

const NAMED_RANGE_FLAGS: ReadonlyArray<NamedRange> = [
	"today",
	"tomorrow",
	"yesterday",
	"this-week",
	"next-week",
	"this-month",
	"next-month",
];

const EVENT_SELECTOR_FLAGS = [
	...NAMED_RANGE_FLAGS,
	"date",
	"from",
	"to",
	"calendar",
	"account",
	"connector",
	"search",
	"declined",
];

const SLOT_SELECTOR_FLAGS = ["date", "from", "until", "calendar", "search"];

type BatchMode = "dry-run" | "execute";
type BatchItemAction = "change" | "noop" | "skip" | "failed";
type AttendeeMode = "add" | "remove";

interface BatchDateRange {
	from: Date;
	to: Date;
}

interface PlannedBatchItem<TPayload> {
	id: string;
	title: string;
	action: BatchItemAction;
	reason?: string;
	emails?: string[];
	start?: string | null;
	end?: string | null;
	payload?: TPayload;
}

export interface BatchReportItem {
	id: string;
	title: string;
	action: BatchItemAction;
	reason?: string;
	emails?: string[];
	start?: string | null;
	end?: string | null;
}

export interface BatchReport {
	mode: BatchMode;
	operation: string;
	selected: number;
	changed: number;
	noop: number;
	skipped: number;
	failed: number;
	items: BatchReportItem[];
}

const eventSelectorArgs = {
	today: { type: "boolean", description: "Today's events" },
	tomorrow: { type: "boolean", description: "Tomorrow's events" },
	yesterday: { type: "boolean", description: "Yesterday's events" },
	"this-week": { type: "boolean", description: "This week's events" },
	"next-week": { type: "boolean", description: "Next week's events" },
	"this-month": { type: "boolean", description: "This month's events" },
	"next-month": { type: "boolean", description: "Next month's events" },
	date: { type: "string", description: "Single local date" },
	from: { type: "string", description: "Start date" },
	to: { type: "string", description: "End date" },
	calendar: {
		type: "string",
		description: "Calendar id, origin id, or unique title",
	},
	account: { type: "string", description: "Filter by akiflow_account_id" },
	connector: { type: "string", description: "Filter by connector id" },
	search: {
		type: "string",
		alias: "s",
		description: "Search event title or description",
	},
	declined: { type: "boolean", description: "Include declined events" },
} as const;

const slotSelectorArgs = {
	date: { type: "string", description: "Single local date" },
	from: { type: "string", description: "Start date" },
	until: { type: "string", description: "End date" },
	calendar: {
		type: "string",
		description: "Calendar id, origin id, or unique title",
	},
	search: {
		type: "string",
		alias: "s",
		description: "Search slot title or description",
	},
} as const;

const executionArgs = {
	execute: {
		type: "boolean",
		description: "Perform the batch mutation; default is dry-run",
	},
	json: { type: "boolean", description: "Output batch report as JSON" },
} as const;

function fail(message: string): never {
	console.error(`Error: ${message}`);
	process.exit(1);
}

function hasSelector(
	args: Record<string, unknown>,
	flags: readonly string[],
): boolean {
	return flags.some((flag) => {
		const value = args[flag];
		return value !== undefined && value !== false && value !== "";
	});
}

function requireSelector(
	args: Record<string, unknown>,
	flags: readonly string[],
	resource: "events" | "slots",
): void {
	if (!hasSelector(args, flags)) {
		fail(
			`af batch ${resource} requires at least one selector such as --date, --from/--to, --search, or --calendar.`,
		);
	}
}

function resolveBatchRange(
	args: Record<string, unknown>,
	endFlag: "to" | "until",
): BatchDateRange | null {
	const named = NAMED_RANGE_FLAGS.filter((flag) => args[flag] === true);
	const dateInput = args.date as string | undefined;
	const fromInput = args.from as string | undefined;
	const endInput = args[endFlag] as string | undefined;

	if (named.length > 1) {
		fail(`Use only one named date range, not ${named.join(", ")}.`);
	}
	if (named.length > 0 && (dateInput || fromInput || endInput)) {
		fail(
			"Use either a named date range, --date, or --from/--to, not more than one.",
		);
	}
	if (dateInput && (fromInput || endInput)) {
		fail("Use either --date or --from/--to, not both.");
	}

	const [namedRange] = named;
	if (namedRange) return resolveRange(namedRange);

	if (dateInput) {
		const range = resolveSingleDayRange(dateInput);
		if (!range) fail(`Could not parse date "${dateInput}"`);
		return range;
	}

	if (!fromInput && !endInput) return null;

	const from = fromInput
		? parseDateBoundary(fromInput, "start")
		: startOfDay(new Date(0));
	const to = endInput
		? parseDateBoundary(endInput, "end")
		: endOfDay(new Date(9999, 11, 31));
	if (!from) fail(`Could not parse --from "${fromInput}"`);
	if (!to) fail(`Could not parse --${endFlag} "${endInput}"`);
	if (from > to) fail("--from must be before or equal to the range end");

	return { from, to };
}

function resolveCalendarId(
	calendars: Calendar[],
	input: unknown,
): string | undefined {
	if (input === undefined) return undefined;
	try {
		return resolveCalendarFromList(calendars, String(input), {
			includeDeleted: true,
			includeHidden: true,
		}).id;
	} catch (error) {
		if (error instanceof CalendarResolutionError) fail(error.message);
		throw error;
	}
}

function eventMatchesSearch(event: Event, search: string | undefined): boolean {
	if (!search) return true;
	const query = search.toLowerCase();
	return (
		(event.title ?? "").toLowerCase().includes(query) ||
		(event.description ?? "").toLowerCase().includes(query)
	);
}

function slotMatchesSearch(
	slot: TimeSlot,
	search: string | undefined,
): boolean {
	if (!search) return true;
	const query = search.toLowerCase();
	return (
		slot.title.toLowerCase().includes(query) ||
		(slot.description ?? "").toLowerCase().includes(query)
	);
}

function slotOverlapsRange(slot: TimeSlot, range: BatchDateRange): boolean {
	const start = new Date(slot.start_time);
	const end = new Date(slot.end_time);
	return start <= range.to && end >= range.from;
}

function byStartThenTitle<
	T extends { start_time: string | null; title: string | null },
>(a: T, b: T): number {
	const aMs = a.start_time ? new Date(a.start_time).getTime() : 0;
	const bMs = b.start_time ? new Date(b.start_time).getTime() : 0;
	if (aMs !== bMs) return aMs - bMs;
	return (a.title ?? "").localeCompare(b.title ?? "");
}

export function selectBatchEvents(
	events: Event[],
	calendars: Calendar[],
	args: Record<string, unknown>,
): Event[] {
	const range = resolveBatchRange(args, "to");
	const calendarId = resolveCalendarId(calendars, args.calendar);
	const activeCalendarIds = new Set(
		calendars
			.filter((calendar) => calendar.deleted_at == null)
			.map((calendar) => calendar.id),
	);
	const visibleCalendarIds = new Set(
		calendars
			.filter(
				(calendar) => calendar.deleted_at == null && calendar.hidden_at == null,
			)
			.map((calendar) => calendar.id),
	);

	return filterEvents(events, {
		from: range?.from,
		to: range?.to,
		calendar: calendarId,
		account: args.account as string | undefined,
		connector: args.connector as string | undefined,
		includeDeclined: args.declined === true,
		activeCalendarIds,
		visibleCalendarIds,
	})
		.filter((event) =>
			eventMatchesSearch(event, args.search as string | undefined),
		)
		.sort(byStartThenTitle);
}

export function selectBatchSlots(
	slots: TimeSlot[],
	calendars: Calendar[],
	args: Record<string, unknown>,
): TimeSlot[] {
	const range = resolveBatchRange(args, "until");
	const calendarId = resolveCalendarId(calendars, args.calendar);

	return slots
		.filter((slot) => slot.deleted_at == null)
		.filter((slot) => (range ? slotOverlapsRange(slot, range) : true))
		.filter((slot) => (calendarId ? slot.calendar_id === calendarId : true))
		.filter((slot) =>
			slotMatchesSearch(slot, args.search as string | undefined),
		)
		.sort(byStartThenTitle);
}

export function mutableTimedGoogleEventSkipReason(event: Event): string | null {
	if (event.deleted_at) return "event is deleted";
	if (event.status === "cancelled") return "event is cancelled";
	if (event.hidden) return "event is hidden";
	if (event.read_only) return "event is read-only";
	if (event.connector_id !== "google") {
		return `event uses connector "${event.connector_id}"`;
	}
	if (
		event.start_date ||
		event.end_date ||
		!event.start_time ||
		!event.end_time
	) {
		return "event is all-day or missing timed start/end fields";
	}
	if (
		event.recurring_id ||
		event.origin_recurring_id ||
		(Array.isArray(event.recurrence)
			? event.recurrence.length > 0
			: event.recurrence) ||
		event.recurrence_exception
	) {
		return "recurring event mutation is not implemented in v1";
	}
	return null;
}

function baseEventItem(event: Event): BatchReportItem {
	return {
		id: event.id,
		title: event.title ?? "(untitled event)",
		action: "change",
		start: event.start_time,
		end: event.end_time,
	};
}

function baseSlotItem(slot: TimeSlot): BatchReportItem {
	return {
		id: slot.id,
		title: slot.title,
		action: "change",
		start: slot.start_time,
		end: slot.end_time,
	};
}

export function planEventAttendeeBatch(
	events: Event[],
	emails: string[],
	mode: AttendeeMode,
): Array<PlannedBatchItem<EventModifierPayload>> {
	return events.map((event) => {
		const item = baseEventItem(event);
		const skipReason = mutableTimedGoogleEventSkipReason(event);
		if (skipReason) return { ...item, action: "skip", reason: skipReason };

		const existing = existingAttendeeEmails(event);
		const toChange =
			mode === "add"
				? emails.filter((email) => !existing.has(email))
				: emails.filter((email) => existing.has(email));

		if (toChange.length === 0) {
			return {
				...item,
				action: "noop",
				emails,
				reason:
					mode === "add"
						? "all requested attendees are already present"
						: "none of the requested attendees are present",
			};
		}

		return {
			...item,
			action: "change",
			emails: toChange,
			payload: buildAttendeeModifierPayload({
				event,
				add: mode === "add" ? toChange : [],
				remove: mode === "remove" ? toChange : [],
			}),
		};
	});
}

export function planEventDeleteBatch(
	events: Event[],
	notify: "all" | "none",
): Array<PlannedBatchItem<CreateEventPayload>> {
	return events.map((event) => {
		const item = baseEventItem(event);
		const skipReason = mutableTimedGoogleEventSkipReason(event);
		if (skipReason) return { ...item, action: "skip", reason: skipReason };
		return {
			...item,
			action: "change",
			payload: buildEventDeletePayload({ event, notify }),
		};
	});
}

export function planSlotDeleteBatch(
	slots: TimeSlot[],
): Array<PlannedBatchItem<UpdateTimeSlotPayload>> {
	return slots.map((slot) => {
		const item = baseSlotItem(slot);
		if (slot.deleted_at) {
			return { ...item, action: "skip", reason: "slot is deleted" };
		}
		return {
			...item,
			action: "change",
			payload: buildSlotDeletePayload({ slot }),
		};
	});
}

function changedItems<TPayload>(
	items: Array<PlannedBatchItem<TPayload>>,
): Array<PlannedBatchItem<TPayload> & { payload: TPayload }> {
	return items.filter(
		(item): item is PlannedBatchItem<TPayload> & { payload: TPayload } =>
			item.action === "change" && item.payload !== undefined,
	);
}

function markMissingResults<TPayload>(
	items: Array<PlannedBatchItem<TPayload>>,
	returnedIds: Set<string>,
	reason: string,
): Array<PlannedBatchItem<TPayload>> {
	return items.map((item) => {
		if (item.action !== "change") return item;
		if (returnedIds.has(item.id)) return item;
		return { ...item, action: "failed", reason };
	});
}

function toReportItem<TPayload>(
	item: PlannedBatchItem<TPayload>,
): BatchReportItem {
	return {
		id: item.id,
		title: item.title,
		action: item.action,
		reason: item.reason,
		emails: item.emails,
		start: item.start,
		end: item.end,
	};
}

export function buildBatchReport<TPayload>(
	operation: string,
	mode: BatchMode,
	items: Array<PlannedBatchItem<TPayload>>,
): BatchReport {
	const reportItems = items.map(toReportItem);
	return {
		mode,
		operation,
		selected: reportItems.length,
		changed: reportItems.filter((item) => item.action === "change").length,
		noop: reportItems.filter((item) => item.action === "noop").length,
		skipped: reportItems.filter((item) => item.action === "skip").length,
		failed: reportItems.filter((item) => item.action === "failed").length,
		items: reportItems,
	};
}

function printBatchReport(report: BatchReport, json: boolean): void {
	if (json) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}

	const label = report.mode === "execute" ? "Batch result" : "Batch plan";
	console.log(`${label}: ${report.operation}`);
	console.log(`Selected: ${report.selected}`);
	console.log(`Changed: ${report.changed}`);
	console.log(`No-op: ${report.noop}`);
	console.log(`Skipped: ${report.skipped}`);
	console.log(`Failed: ${report.failed}`);
	if (report.items.length === 0) return;
	console.log("");
	for (const item of report.items) {
		const emails = item.emails?.length ? ` [${item.emails.join(", ")}]` : "";
		const reason = item.reason ? ` - ${item.reason}` : "";
		const time = item.start ? ` @ ${item.start}` : "";
		console.log(
			`- ${item.action}: ${item.title} (${item.id})${time}${emails}${reason}`,
		);
	}
}

function failAfterReport<TPayload>(
	operation: string,
	items: Array<PlannedBatchItem<TPayload>>,
	json: boolean,
): never {
	const report = buildBatchReport(operation, "execute", items);
	printBatchReport(report, json);
	process.exit(1);
}

async function runBatchEventAttendees(
	args: Record<string, unknown>,
	mode: AttendeeMode,
): Promise<void> {
	requireSelector(args, EVENT_SELECTOR_FLAGS, "events");
	const emails = collectAttendeeEmails(args);
	const client = createClient();
	const [events, calendars] = await Promise.all([
		readResource(client, "events"),
		readResource(client, "calendars"),
	]);
	const selected = selectBatchEvents(events, calendars, args);
	let planned = planEventAttendeeBatch(selected, emails, mode);
	const operation = `events.attendees.${mode}`;
	const execute = args.execute === true;
	const json = args.json === true;

	if (!execute) {
		printBatchReport(buildBatchReport(operation, "dry-run", planned), json);
		return;
	}

	const changes = changedItems(planned);
	if (changes.length > 0) {
		const response = await client.createEventModifiers(
			changes.map((item) => item.payload),
		);
		const returnedIds = new Set(
			(response.data ?? []).map((modifier: EventModifier) => modifier.event_id),
		);
		if (!response.success || returnedIds.size !== changes.length) {
			planned = markMissingResults(
				planned,
				response.success ? returnedIds : new Set(),
				response.message ?? "API did not return a result for this item",
			);
			failAfterReport(operation, planned, json);
		}
	}

	printBatchReport(buildBatchReport(operation, "execute", planned), json);
}

async function runBatchEventDelete(
	args: Record<string, unknown>,
): Promise<void> {
	requireSelector(args, EVENT_SELECTOR_FLAGS, "events");
	const notify = String(args.notify ?? "all");
	if (notify !== "all" && notify !== "none") {
		fail(`Invalid --notify "${notify}". Expected "all" or "none".`);
	}

	const client = createClient();
	const [events, calendars] = await Promise.all([
		readResource(client, "events"),
		readResource(client, "calendars"),
	]);
	const selected = selectBatchEvents(events, calendars, args);
	let planned = planEventDeleteBatch(selected, notify);
	const operation = "events.delete";
	const execute = args.execute === true;
	const json = args.json === true;

	if (!execute) {
		printBatchReport(buildBatchReport(operation, "dry-run", planned), json);
		return;
	}

	const changes = changedItems(planned);
	if (changes.length > 0) {
		const response = await client.createEvents(
			changes.map((item) => item.payload),
		);
		const returnedIds = new Set(
			(response.data ?? []).map((event: Event) => event.id),
		);
		if (!response.success || returnedIds.size !== changes.length) {
			planned = markMissingResults(
				planned,
				response.success ? returnedIds : new Set(),
				response.message ?? "API did not return a result for this item",
			);
			failAfterReport(operation, planned, json);
		}
	}

	printBatchReport(buildBatchReport(operation, "execute", planned), json);
}

async function runBatchSlotDelete(
	args: Record<string, unknown>,
): Promise<void> {
	requireSelector(args, SLOT_SELECTOR_FLAGS, "slots");
	const client = createClient();
	const [slots, calendars] = await Promise.all([
		readResource(client, "time_slots"),
		readResource(client, "calendars"),
	]);
	const selected = selectBatchSlots(slots, calendars, args);
	let planned = planSlotDeleteBatch(selected);
	const operation = "slots.delete";
	const execute = args.execute === true;
	const json = args.json === true;

	if (!execute) {
		printBatchReport(buildBatchReport(operation, "dry-run", planned), json);
		return;
	}

	const changes = changedItems(planned);
	if (changes.length > 0) {
		const response = await client.upsertTimeSlots(
			changes.map((item) => item.payload),
		);
		const returnedIds = new Set(
			(response.data ?? []).map((slot: TimeSlot) => slot.id),
		);
		if (!response.success || returnedIds.size !== changes.length) {
			planned = markMissingResults(
				planned,
				response.success ? returnedIds : new Set(),
				response.message ?? "API did not return a result for this item",
			);
			failAfterReport(operation, planned, json);
		}
	}

	printBatchReport(buildBatchReport(operation, "execute", planned), json);
}

const batchEventAttendeeAddCommand = defineCommand({
	meta: {
		name: "add",
		description: "Add attendee emails to selected timed Google events",
	},
	args: {
		email: {
			type: "positional",
			description: "Attendee email; additional emails may follow",
			required: true,
		},
		...eventSelectorArgs,
		...executionArgs,
	},
	run: async ({ args }) => {
		await runBatchEventAttendees(args as Record<string, unknown>, "add");
	},
});

const batchEventAttendeeRemoveCommand = defineCommand({
	meta: {
		name: "remove",
		description: "Remove attendee emails from selected timed Google events",
	},
	args: {
		email: {
			type: "positional",
			description: "Attendee email; additional emails may follow",
			required: true,
		},
		...eventSelectorArgs,
		...executionArgs,
	},
	run: async ({ args }) => {
		await runBatchEventAttendees(args as Record<string, unknown>, "remove");
	},
});

const batchEventAttendeesCommand = defineCommand({
	meta: {
		name: "attendees",
		description: "Batch manage attendee emails on selected events",
	},
	subCommands: {
		add: batchEventAttendeeAddCommand,
		remove: batchEventAttendeeRemoveCommand,
	},
});

const batchEventDeleteCommand = defineCommand({
	meta: {
		name: "delete",
		description: "Soft-delete selected timed Google calendar events",
	},
	args: {
		...eventSelectorArgs,
		notify: {
			type: "string",
			description: "Google attendee notification mode: all or none",
			default: "all",
		},
		...executionArgs,
	},
	run: async ({ args }) => {
		await runBatchEventDelete(args as Record<string, unknown>);
	},
});

const batchEventsCommand = defineCommand({
	meta: {
		name: "events",
		description: "Batch mutate selected timed Google events",
	},
	subCommands: {
		attendees: batchEventAttendeesCommand,
		delete: batchEventDeleteCommand,
	},
});

const batchSlotDeleteCommand = defineCommand({
	meta: {
		name: "delete",
		description: "Soft-delete selected Akiflow task slots",
	},
	args: {
		...slotSelectorArgs,
		...executionArgs,
	},
	run: async ({ args }) => {
		await runBatchSlotDelete(args as Record<string, unknown>);
	},
});

const batchSlotsCommand = defineCommand({
	meta: {
		name: "slots",
		description: "Batch mutate selected Akiflow task slots",
	},
	subCommands: {
		delete: batchSlotDeleteCommand,
	},
});

export const batchCommand = defineCommand({
	meta: {
		name: "batch",
		description: "Safely mutate selected Akiflow resources in bulk",
	},
	subCommands: {
		events: batchEventsCommand,
		slots: batchSlotsCommand,
	},
});
