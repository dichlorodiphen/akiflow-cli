import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import {
	buildDeleteEventOperation,
	buildPatchEventOperation,
	type EventSendUpdates,
	eventOperationRoute,
	eventTargetRejectionReason,
} from "../lib/api/event-intents";
import { checkTaskMutationResult } from "../lib/api/task-results";
import type {
	ApiResponse,
	Calendar,
	Event,
	EventOperationPayload,
	MutationReceipt,
	TimeSlot,
	UpdateTimeSlotPayload,
} from "../lib/api/types";
import { isReadOnlyCanonical } from "../lib/api/types";
import { verifyEventAttendees } from "../lib/attendee-verification";
import { refreshResource, upsertResourceRecords } from "../lib/cache";
import {
	CalendarResolutionError,
	resolveCalendarFromList,
} from "../lib/calendar";
import {
	endOfDay,
	type NamedRange,
	resolveRange,
	startOfDay,
} from "../lib/date-parser";
import {
	strictBoundarySelector,
	strictDaySelector,
} from "../lib/date-selector";
import { dryRunArgs, mutationReader, previewItem } from "../lib/dry-run";
import {
	clearCreatedEvent,
	deleteNeedsConfirmation,
	loadCreatedEventIds,
} from "../lib/event-creation-journal";
import { EXIT_CODES } from "../lib/exit-codes";
import { filterEvents } from "../lib/filters/event";
import { outputMutation } from "../lib/mutation-output";
import { queryOccurrencesWithRaw } from "../lib/occurrence";
import { classifyExit } from "../lib/output-contract";
import {
	type VerificationResult,
	verifyEventDeleted,
} from "../lib/verification";
import { verificationOptions } from "../lib/verify-flag";
import {
	buildAttendeePatchIntent,
	collectAttendeeEmails,
	existingAttendeeEmails,
	resolveSendUpdatesFlag,
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

const SLOT_SELECTOR_FLAGS = [
	"date",
	"from",
	"until",
	"calendar",
	"account",
	"connector",
	"search",
];

type BatchMode = "dry-run" | "execute";
type BatchItemAction =
	| "change"
	| "noop"
	| "skip"
	| "failed"
	| "unknown"
	| "accepted"
	| "pending"
	| "verified"
	| "mismatch"
	| "timeout";
type AttendeeMode = "add" | "remove";

interface BatchDateRange {
	from: Date;
	to: Date;
}

interface PlannedBatchItem<TPayload> {
	before?: unknown;
	after?: unknown;
	notification_policy?: string;
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
	before?: unknown;
	after?: unknown;
	notification_policy?: string;
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
	accepted: number;
	unknown: number;
	pending: number;
	items: BatchReportItem[];
}

const eventSelectorArgs = {
	verify: {
		type: "boolean",
		description: "Confirm with fresh reads (default timeout: 15s)",
	},
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
	account: { type: "string", description: "Akiflow account ID" },
	connector: { type: "string", description: "Connector ID" },
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
	...dryRunArgs,
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
		const range = strictDaySelector(dateInput);
		if (!range) fail(`Could not parse date "${dateInput}"`);
		return range;
	}

	if (!fromInput && !endInput) return null;

	const from = fromInput
		? strictBoundarySelector(fromInput, "start")
		: startOfDay(new Date(0));
	const to = endInput
		? strictBoundarySelector(endInput, "end")
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

	return queryOccurrencesWithRaw(
		{ events },
		{
			from: range?.from,
			to: range ? new Date(range.to.getTime() + 1) : undefined,
			calendarId,
			accountId: args.account as string | undefined,
			connectorId: args.connector as string | undefined,
			includeDeclined: args.declined === true,
			includeCancelled: true,
			activeCalendarIds: [...activeCalendarIds],
			calendarIds: [...visibleCalendarIds],
		},
	)
		.map((pair) => pair.raw as Event)
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

	return queryOccurrencesWithRaw(
		{ slots },
		{
			from: range?.from,
			to: range ? new Date(range.to.getTime() + 1) : undefined,
			calendarId,
			accountId: args.account as string | undefined,
			connectorId: args.connector as string | undefined,
		},
	)
		.map((pair) => pair.raw as TimeSlot)
		.filter((slot) =>
			slotMatchesSearch(slot, args.search as string | undefined),
		)
		.sort(byStartThenTitle);
}

export function mutableTimedGoogleEventSkipReason(event: Event): string | null {
	// Central target rejection (cancelled/deleted/read-only/hidden) with
	// precise reasons; the v1 capability limits below are CLI-specific.
	const targetReason = eventTargetRejectionReason(event);
	if (targetReason) return targetReason;
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
	sendUpdates: EventSendUpdates = "none",
): Array<PlannedBatchItem<EventOperationPayload>> {
	return events.map((event, index) => {
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

		// Attendee edits ride the supported v5 event_operations path as an
		// explicit patch intent. The legacy POST /v3/events/modifiers
		// endpoint returns HTTP 410 and is never called.
		const intent = buildAttendeePatchIntent({
			event,
			add: mode === "add" ? toChange : [],
			remove: mode === "remove" ? toChange : [],
			sendUpdates,
		});
		const payload = buildPatchEventOperation(
			eventOperationRoute(event),
			intent.base,
			intent.changes,
			intent.sendUpdates,
			index,
		);
		return {
			...item,
			action: "change",
			emails: toChange,
			payload,
		};
	});
}

export function planEventDeleteBatch(
	events: Event[],
	sendUpdates: EventSendUpdates = "none",
	options: {
		/** Explicit user confirmation; skips the creation-journal guard. */
		confirm?: boolean;
		/** IDs this CLI created (from the creation journal); others need --confirm. */
		createdEventIds?: ReadonlySet<string>;
	} = {},
): Array<PlannedBatchItem<EventOperationPayload>> {
	return events.map((event, index) => {
		const item = baseEventItem(event);
		const skipReason = mutableTimedGoogleEventSkipReason(event);
		if (skipReason) return { ...item, action: "skip", reason: skipReason };
		// Delete-propagation guard: a submitted delete is fanned out to
		// Google Calendar by the Akiflow server, so targets this CLI did not
		// create require explicit confirmation (2026-09-26 "tilapia" shape).
		if (
			!options.confirm &&
			deleteNeedsConfirmation(event.id, options.createdEventIds ?? new Set())
		) {
			return {
				...item,
				action: "skip",
				reason:
					"not created by this CLI; re-run with --confirm to delete (deleting cancels the event on Google Calendar)",
			};
		}
		return {
			...item,
			action: "change",
			payload: buildDeleteEventOperation(
				eventOperationRoute(event),
				sendUpdates,
				index,
			),
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

export function classifyBatchResults<TPayload>(
	items: Array<PlannedBatchItem<TPayload>>,
	response: ApiResponse<Array<{ id: string }>>,
): Array<PlannedBatchItem<TPayload>> {
	const checked = checkTaskMutationResult(
		response,
		changedItems(items).map((item) => item.id),
	);
	return items.map((item) => {
		if (item.action !== "change") return item;
		if (checked.failedIds.includes(item.id))
			return { ...item, action: "failed", reason: checked.errors.join("; ") };
		if (checked.succeededIds.includes(item.id))
			return {
				...item,
				action: "accepted",
				reason: "submitted, not yet confirmed",
			};
		return {
			...item,
			action: "unknown",
			reason:
				response.message ??
				"API did not identify an outcome; no success claimed",
		};
	});
}

function toReportItem<TPayload>(
	item: PlannedBatchItem<TPayload>,
): BatchReportItem {
	return {
		id: item.id,
		title: item.title,
		action: item.action,
		before: item.before,
		after: item.after,
		notification_policy: item.notification_policy,
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
		changed: reportItems.filter(
			(item) => item.action === "change" || item.action === "verified",
		).length,
		noop: reportItems.filter((item) => item.action === "noop").length,
		skipped: reportItems.filter((item) => item.action === "skip").length,
		failed: reportItems.filter((item) => item.action === "failed").length,
		accepted: reportItems.filter((item) => item.action === "accepted").length,
		unknown: reportItems.filter((item) => item.action === "unknown").length,
		pending: reportItems.filter((item) => item.action === "pending").length,
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
	console.log(
		`${report.mode === "execute" ? "Verified changes" : "Changes planned"}: ${report.changed}`,
	);
	if (report.mode === "execute") {
		console.log(`Accepted, not yet confirmed: ${report.accepted}`);
		console.log(`Unknown: ${report.unknown}`);
		console.log(`Pending: ${report.pending}`);
	}
	console.log(`No-op: ${report.noop}`);
	console.log(`Skipped: ${report.skipped}`);
	console.log(`Failed: ${report.failed}`);
	if (report.items.length === 0) return;
	console.log("");
	for (const item of report.items) {
		const emails = item.emails?.length ? ` [${item.emails.join(", ")}]` : "";
		const reason = item.reason ? ` - ${item.reason}` : "";
		if (report.mode === "dry-run") {
			console.log(
				`  ${JSON.stringify(item.before)} → ${JSON.stringify(item.after)}`,
			);
			console.log(`  Notification policy: ${item.notification_policy}`);
		}
		const time = item.start ? ` @ ${item.start}` : "";
		console.log(
			`- ${item.action}: ${item.title} (${item.id})${time}${emails}${reason}`,
		);
	}
}

function printBatchMutationReport<TPayload>(
	operation: string,
	items: Array<PlannedBatchItem<TPayload>>,
	json: boolean,
	receipts: unknown[] = items
		.filter((item) => !["noop", "skip"].includes(item.action))
		.map((item) => ({ id: item.id, status: item.action })),
	diagnostics: string[] = [],
): void {
	const report = buildBatchReport(operation, "execute", items);
	const unsuccessful = items.filter((item) =>
		["failed", "unknown", "pending", "mismatch", "timeout"].includes(
			item.action,
		),
	);
	const status =
		unsuccessful[0]?.action ??
		(diagnostics.length
			? "unknown"
			: items.some((item) => item.action === "accepted")
				? "accepted"
				: "verified");
	// Versioned mutation envelope (Workstreams A + H).
	if (json)
		console.log(
			JSON.stringify(
				{
					schema_version: 1,
					command: `batch ${operation.replaceAll(".", " ")}`,
					status,
					receipts,
					result: report,
					errors: [
						...diagnostics,
						...unsuccessful.map(
							(item) => `${item.id}: ${item.reason ?? item.action}`,
						),
					],
					warnings:
						status === "accepted" ? ["Submitted, not yet confirmed"] : [],
				},
				null,
				2,
			),
		);
	else {
		printBatchReport(report, false);
		for (const error of diagnostics) console.error(error);
	}
	if (unsuccessful.length > 0 || diagnostics.length > 0)
		process.exit(
			report.changed > 0 ? EXIT_CODES.partialSuccess : EXIT_CODES.upstream,
		);
}

async function runBatchEventAttendees(
	args: Record<string, unknown>,
	mode: AttendeeMode,
): Promise<void> {
	requireSelector(args, EVENT_SELECTOR_FLAGS, "events");
	const emails = collectAttendeeEmails(args);
	const sendUpdates = resolveSendUpdatesFlag(args["send-updates"]);
	const client = createClient();
	if (args.execute === true) await refreshResource(client, "events");
	const [events, calendars] = await Promise.all([
		mutationReader(args.execute !== true)(client, "events"),
		mutationReader(args.execute !== true)(client, "calendars"),
	]);
	const selected = selectBatchEvents(events, calendars, args);
	let planned = planEventAttendeeBatch(selected, emails, mode, sendUpdates);
	const operation = `events.attendees.${mode}`;
	const execute = args.execute === true;
	const json = args.json === true;

	if (!execute) {
		planned = planned.map((item) => {
			const event = selected.find((record) => record.id === item.id);
			const existing = event ? [...existingAttendeeEmails(event)] : [];
			const changes = item.emails ?? [];
			const after = event
				? {
						...event,
						attendees:
							mode === "add"
								? [...existing, ...changes]
								: existing.filter((email) => !changes.includes(email)),
					}
				: null;
			return {
				...item,
				...previewItem(
					event ? { ...event, attendees: existing } : null,
					after,
					sendUpdates,
				),
				action: item.action,
			};
		});
		printBatchReport(buildBatchReport(operation, "dry-run", planned), json);
		return;
	}

	const changes = changedItems(planned);
	const response =
		changes.length > 0
			? await client.submitEventOperations(changes.map((item) => item.payload))
			: {
					receipts: [] as MutationReceipt[],
					raw: { success: true, message: null, data: [] },
					allAccepted: true,
				};
	const receipts = response.receipts;
	const errors: string[] = [];
	const verifications = new Map<string, VerificationResult<Event>>();
	if (args.verify === true) {
		for (const receipt of receipts) {
			if (receipt.status !== "accepted") continue;
			const item = changes.find((item) => item.id === receipt.event_id);
			const verification = await verifyEventAttendees(
				client,
				receipt.event_id,
				mode === "add" ? (item?.emails ?? []) : [],
				mode === "remove" ? (item?.emails ?? []) : [],
				verificationOptions(),
			);
			if (isReadOnlyCanonical(verification.observed)) {
				if (verification.observed)
					await upsertResourceRecords("events", [verification.observed]);
				verification.status = "mismatch";
				verification.differingFields.push("read_only");
				errors.push(
					`Event ${receipt.event_id} is read-only; further mutation refused.`,
				);
			}
			verifications.set(receipt.event_id, verification);
		}
	}
	planned = planned.map((item) => {
		if (item.action !== "change") return item;
		const receipt = receipts.find((receipt) => receipt.event_id === item.id);
		const verification = verifications.get(item.id);
		return {
			...item,
			action: verification?.status ?? receipt?.status ?? "unknown",
			reason:
				verification?.error ??
				(verification?.status === "mismatch"
					? `Mismatch on fields: ${verification.differingFields.join(", ")}`
					: receipt?.error === undefined
						? receipt?.status === "accepted"
							? "submitted, not yet confirmed"
							: undefined
						: JSON.stringify(receipt.error)),
		};
	});
	const returnedEventIds = new Set(
		(response.raw.data ?? []).map((d) => d.event_id),
	);
	const missing = changes.filter((c) => !returnedEventIds.has(c.id));
	const isPartial =
		response.raw.success === true &&
		missing.length > 0 &&
		returnedEventIds.size > 0;
	if (isPartial) {
		// Partial success: some items returned, some missing.
		const report = buildBatchReport(operation, "execute", planned);
		// Override report counts for the partial case.
		const partialReport = {
			...report,
			changed: returnedEventIds.size,
			failed: missing.length,
		};
		const structuredErrors = missing.map((c) => ({
			id: c.id,
			message:
				response.raw.message ?? "API did not return a result for this item",
		}));
		if (json) {
			console.log(
				JSON.stringify(
					{
						schema_version: 1,
						command: `batch events attendees ${mode}`,
						status: "partial",
						receipts,
						result: partialReport,
						errors: structuredErrors,
						warnings: [],
					},
					null,
					2,
				),
			);
		} else {
			printBatchReport(partialReport, false);
			for (const e of structuredErrors) console.error(`${e.id}: ${e.message}`);
		}
		process.exitCode = 6;
		return;
	}
	outputMutation({
		command: `batch events attendees ${mode}`,
		json,
		receipts,
		verifications,
		result: buildBatchReport(operation, "execute", planned),
		errors,
		...(errors.length &&
		receipts.every((receipt) => receipt.status === "accepted")
			? { status: "unknown" as const }
			: {}),
	});
	if (!json)
		printBatchReport(buildBatchReport(operation, "execute", planned), false);
	const hasFailures =
		errors.length > 0 ||
		receipts.some((r) =>
			["failed", "unknown", "mismatch", "timeout"].includes(r.status),
		);
	if (hasFailures) {
		const allErrors = [
			...errors,
			...receipts
				.filter((r) => r.error !== undefined)
				.map((r) => `${r.event_id}: ${r.error}`),
		];
		process.exitCode = classifyExit(1, allErrors, []);
	}
}

async function runBatchEventDelete(
	args: Record<string, unknown>,
): Promise<void> {
	requireSelector(args, EVENT_SELECTOR_FLAGS, "events");
	const sendUpdates = resolveSendUpdatesFlag(args["send-updates"]);

	const client = createClient();
	if (args.execute === true) await refreshResource(client, "events");
	const [events, calendars] = await Promise.all([
		mutationReader(args.execute !== true)(client, "events"),
		mutationReader(args.execute !== true)(client, "calendars"),
	]);
	const selected = selectBatchEvents(events, calendars, args);
	let planned = planEventDeleteBatch(selected, sendUpdates, {
		confirm: args.confirm === true,
		createdEventIds: loadCreatedEventIds(),
	});
	const operation = "events.delete";
	const execute = args.execute === true;
	const json = args.json === true;

	if (!execute) {
		planned = planned.map((item) => {
			const original = selected.find((record) => record.id === item.id);
			return {
				...item,
				before: original ?? null,
				after: original ? { ...original, status: "cancelled" } : null,
				notification_policy: sendUpdates,
			};
		});
		printBatchReport(buildBatchReport(operation, "dry-run", planned), json);
		return;
	}

	const changes = changedItems(planned);
	const response = await client.submitEventOperations(
		changes.map((item) => item.payload),
	);
	// Drop journal entries for deleted events so the guard stays accurate.
	for (const receipt of response.receipts) {
		if (receipt.status === "accepted") {
			clearCreatedEvent(receipt.event_id);
		}
	}
	const verifications = new Map<string, VerificationResult<Event>>();
	if (args.verify === true) {
		for (const receipt of response.receipts) {
			if (receipt.status === "accepted")
				verifications.set(
					receipt.event_id,
					await verifyEventDeleted(
						client,
						receipt.event_id,
						verificationOptions(),
					),
				);
		}
	}
	for (const verification of verifications.values()) {
		if (isReadOnlyCanonical(verification.observed)) {
			if (verification.observed)
				await upsertResourceRecords("events", [verification.observed]);
			verification.status = "mismatch";
			verification.differingFields.push("read_only");
			verification.error =
				"Observed event is read-only; further mutations refused.";
		}
	}
	planned = planned.map((item) => {
		if (item.action !== "change") return item;
		const receipt = response.receipts.find(
			(receipt) => receipt.event_id === item.id,
		);
		const verification = verifications.get(item.id);
		return {
			...item,
			action: verification?.status ?? receipt?.status ?? "unknown",
			reason: verification
				? verification.differingFields.join(", ") || verification.error
				: receipt?.error === undefined
					? receipt?.status === "accepted"
						? "submitted, not yet confirmed"
						: undefined
					: JSON.stringify(receipt.error),
		};
	});
	const report = buildBatchReport(operation, "execute", planned);
	const status = outputMutation({
		command: "batch events delete",
		json,
		receipts: response.receipts,
		verifications,
		result: report,
	});
	if (!json) printBatchReport(report, false);
	if (status !== "accepted" && status !== "verified") process.exitCode = 1;
}

async function runBatchSlotDelete(
	args: Record<string, unknown>,
): Promise<void> {
	requireSelector(args, SLOT_SELECTOR_FLAGS, "slots");
	const client = createClient();
	const [slots, calendars] = await Promise.all([
		mutationReader(args.execute !== true)(client, "time_slots"),
		mutationReader(args.execute !== true)(client, "calendars"),
	]);
	const selected = selectBatchSlots(slots, calendars, args);
	let planned = planSlotDeleteBatch(selected);
	const operation = "slots.delete";
	const execute = args.execute === true;
	const json = args.json === true;

	if (!execute) {
		planned = planned.map((item) => ({
			...item,
			before: selected.find((record) => record.id === item.id) ?? null,
			after:
				item.payload ??
				selected.find((record) => record.id === item.id) ??
				null,
			notification_policy: operation.includes("slot")
				? "none"
				: String(args.notify ?? "all"),
		}));
		printBatchReport(buildBatchReport(operation, "dry-run", planned), json);
		return;
	}

	const changes = changedItems(planned);
	let response: ApiResponse<Array<{ id: string }>> = {
		success: true,
		message: null,
		data: [],
	};
	if (changes.length > 0) {
		try {
			response = await client.upsertTimeSlots(
				changes.map((item) => item.payload),
			);
		} catch (error) {
			response = { success: false, data: [], message: String(error) };
		}
		planned = classifyBatchResults(planned, response);
	}
	printBatchMutationReport(
		operation,
		planned,
		json,
		undefined,
		checkTaskMutationResult(
			response,
			changes.map((item) => item.id),
		).errors,
	);
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
		"send-updates": {
			type: "string",
			description: "Guest notification mode: none (default, silent) or all",
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
		"send-updates": {
			type: "string",
			description: "Guest notification mode: none (default, silent) or all",
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
		"send-updates": {
			type: "string",
			description: "Guest notification mode: none (default, silent) or all",
		},
		confirm: {
			type: "boolean",
			description:
				"Confirm deletion of events this CLI did not create (required for targets absent from the CLI's creation journal)",
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
