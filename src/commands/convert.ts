import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import type {
	CreateEventPayload,
	Event,
	Task,
	UpdateTaskPayload,
} from "../lib/api/types";
import { readResource } from "../lib/cache";
import {
	CalendarResolutionError,
	resolveEventTargetCalendar,
} from "../lib/calendar";
import {
	endOfDay,
	type NamedRange,
	parseDateBoundary,
	parseMonth,
	resolveRange,
	resolveSingleDayRange,
	startOfDay,
} from "../lib/date-parser";
import { parseDurationToSeconds } from "../lib/duration-parser";
import {
	filterTasks,
	type StatusName,
	type TaskFilter,
} from "../lib/filters/task";
import { buildCreateEventPayload } from "./create";

const NAMED_RANGE_FLAGS: ReadonlyArray<NamedRange> = [
	"today",
	"tomorrow",
	"yesterday",
	"this-week",
	"next-week",
	"this-month",
	"next-month",
];

interface ConversionCandidate {
	task: Task;
	startTime: string;
	endTime: string;
	durationSeconds: number;
	payload: CreateEventPayload;
	match: Event | null;
}

function taskSearchMatches(task: Task, search: string | undefined): boolean {
	if (!search) return true;
	const query = search.toLowerCase();
	const title = task.title?.toLowerCase() ?? "";
	const description = task.description?.toLowerCase() ?? "";
	const originalMessage =
		(task.doc?.original_message as string | undefined)?.toLowerCase() ?? "";
	return (
		title.includes(query) ||
		description.includes(query) ||
		originalMessage.includes(query)
	);
}

function buildTaskFilter(args: Record<string, unknown>): TaskFilter {
	const filter: TaskFilter = {};

	if (args.status) {
		filter.status = (args.status as string)
			.split(",")
			.map((s) => s.trim()) as StatusName[];
	}

	const named = NAMED_RANGE_FLAGS.find((n) => args[n]);
	if (named) {
		const range = resolveRange(named);
		filter.from = range.from;
		filter.to = range.to;
	} else if (args.date) {
		const range = resolveSingleDayRange(args.date as string);
		if (range) {
			filter.from = range.from;
			filter.to = range.to;
		}
	} else if (args.month) {
		const month = parseMonth(args.month as string);
		if (month) {
			filter.from = new Date(month.year, month.month - 1, 1);
			filter.to = new Date(month.year, month.month, 0);
		}
	} else if (args.from || args.until || args["range-to"]) {
		const rangeEnd = (args.until ?? args["range-to"]) as string | undefined;
		filter.from = args.from
			? (parseDateBoundary(args.from as string, "start") ?? undefined)
			: startOfDay(new Date(0));
		filter.to = rangeEnd
			? (parseDateBoundary(rangeEnd, "end") ?? undefined)
			: endOfDay(new Date(9999, 11, 31));
	}

	if (args.overdue) filter.overdue = true;
	if (args.project) filter.project = args.project as string;
	if (args.tag) filter.tag = args.tag as string;
	if (args.priority) filter.priority = Number(args.priority);
	if (args.connector) filter.connector = args.connector as string;
	if (args.bucket) filter.bucket = args.bucket as "week" | "month";
	if (args.recurring) filter.recurring = true;
	if (args.planned) filter.planned = true;
	if (args.unplanned) filter.unplanned = true;

	return filter;
}

function selectTasks(tasks: Task[], args: Record<string, unknown>): Task[] {
	const filtered = filterTasks(tasks, buildTaskFilter(args));
	const search = args.search as string | undefined;
	return filtered.filter((task) => taskSearchMatches(task, search));
}

function validateSelectedTasks(
	tasks: Task[],
	args: Record<string, unknown>,
	defaultDurationSeconds: number | null,
): string[] {
	const errors: string[] = [];
	const includeConnectorTasks = args["include-connector-tasks"] === true;
	const deleteSource = args["delete-source"] === true;

	for (const task of tasks) {
		const label = `${task.title ?? "(untitled task)"} (${task.id})`;
		if (!task.title?.trim()) {
			errors.push(`${label}: missing title`);
		}
		if (!task.datetime) {
			errors.push(`${label}: missing datetime`);
		} else if (Number.isNaN(new Date(task.datetime).getTime())) {
			errors.push(`${label}: invalid datetime "${task.datetime}"`);
		}
		const durationSeconds = task.duration ?? defaultDurationSeconds;
		if (durationSeconds == null) {
			errors.push(`${label}: missing duration; pass --default-duration`);
		} else if (durationSeconds <= 0) {
			errors.push(`${label}: duration must be positive`);
		}
		if (task.connector_id && !includeConnectorTasks) {
			errors.push(
				`${label}: connector-backed task; pass --include-connector-tasks to create an event from it`,
			);
		}
		if (task.connector_id && includeConnectorTasks && deleteSource) {
			errors.push(
				`${label}: connector-backed source tasks cannot be deleted by af convert v1`,
			);
		}
	}

	return errors;
}

function eventKey(
	title: string | null,
	startTime: string | null,
	endTime: string | null,
	calendarId: string,
): string {
	return `${calendarId}\u0000${startTime ?? ""}\u0000${endTime ?? ""}\u0000${title ?? ""}`;
}

function buildExistingEventMap(events: Event[]): Map<string, Event> {
	const map = new Map<string, Event>();
	for (const event of events) {
		if (event.deleted_at || event.hidden || event.status === "cancelled")
			continue;
		if (!event.start_time || !event.end_time) continue;
		map.set(
			eventKey(
				event.title,
				event.start_time,
				event.end_time,
				event.calendar_id,
			),
			event,
		);
	}
	return map;
}

function buildCandidates(
	tasks: Task[],
	existingEvents: Event[],
	calendar: Awaited<ReturnType<typeof resolveEventTargetCalendar>>,
	defaultDurationSeconds: number | null,
): ConversionCandidate[] {
	const existing = buildExistingEventMap(existingEvents);
	return tasks.map((task) => {
		const startTime = new Date(task.datetime!).toISOString();
		const durationSeconds = task.duration ?? defaultDurationSeconds!;
		const endTime = new Date(
			new Date(startTime).getTime() + durationSeconds * 1000,
		).toISOString();
		const payload = buildCreateEventPayload({
			title: task.title!,
			description: task.description ?? "",
			startTime,
			endTime,
			timezone: task.datetime_tz,
			calendar,
		});
		const match =
			existing.get(eventKey(payload.title, startTime, endTime, calendar.id)) ??
			null;
		return { task, startTime, endTime, durationSeconds, payload, match };
	});
}

function formatDuration(seconds: number): string {
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

function formatPreview(
	candidates: ConversionCandidate[],
	deleteSource: boolean,
	execute: boolean,
): string {
	if (candidates.length === 0) return "No matching tasks to convert.";

	const toCreate = candidates.filter((c) => !c.match);
	const matched = candidates.filter((c) => c.match);
	const lines = [
		execute
			? "Conversion result: tasks -> events"
			: "Conversion plan: tasks -> events",
		`Selected tasks: ${candidates.length}`,
		`Already matched events: ${matched.length}`,
		`${execute ? "Created events" : "Events to create"}: ${toCreate.length}`,
		`${execute ? "Deleted source tasks" : "Source tasks to delete"}: ${
			deleteSource ? candidates.length : 0
		}`,
		"",
	];

	for (const candidate of candidates) {
		const marker = candidate.match ? "match" : execute ? "created" : "create";
		lines.push(
			`- ${marker}: ${candidate.task.title} @ ${candidate.startTime} (${formatDuration(candidate.durationSeconds)})`,
		);
	}

	return lines.join("\n");
}

function printJsonSummary(
	candidates: ConversionCandidate[],
	mode: "dry-run" | "execute",
	deleteSource: boolean,
): void {
	const toCreate = candidates.filter((c) => !c.match);
	const matched = candidates.filter((c) => c.match);
	console.log(
		JSON.stringify(
			{
				mode,
				selected: candidates.length,
				matched: matched.length,
				to_create: toCreate.length,
				to_delete: deleteSource ? candidates.length : 0,
				items: candidates.map((candidate) => ({
					task_id: candidate.task.id,
					title: candidate.task.title,
					start: candidate.startTime,
					end: candidate.endTime,
					duration_seconds: candidate.durationSeconds,
					action: candidate.match ? "matched" : "create",
					matched_event_id: candidate.match?.id ?? null,
				})),
			},
			null,
			2,
		),
	);
}

export const convertTasksCommand = defineCommand({
	meta: {
		name: "tasks",
		description: "Convert Akiflow tasks to another surface",
	},
	args: {
		to: {
			type: "string",
			description: "Target surface; v1 supports only events",
			required: true,
		},
		execute: {
			type: "boolean",
			description: "Perform the conversion; default is dry-run",
		},
		"delete-source": {
			type: "boolean",
			description: "Soft-delete source tasks after successful event creation",
		},
		"default-duration": {
			type: "string",
			description: "Duration to use when a selected task has no duration",
		},
		"include-connector-tasks": {
			type: "boolean",
			description: "Allow connector-backed tasks as event sources",
		},
		calendar: {
			type: "string",
			description:
				"Calendar id, origin id, or unique title; defaults to writable primary Google calendar",
		},
		search: {
			type: "string",
			alias: "s",
			description: "Search task title, description, or content",
		},
		today: { type: "boolean", description: "Today's tasks" },
		tomorrow: { type: "boolean", description: "Tomorrow's tasks" },
		yesterday: { type: "boolean", description: "Yesterday's tasks" },
		"this-week": { type: "boolean", description: "This week's tasks" },
		"next-week": { type: "boolean", description: "Next week's tasks" },
		"this-month": { type: "boolean", description: "This month's tasks" },
		"next-month": { type: "boolean", description: "Next month's tasks" },
		date: { type: "string", description: "Single-day filter" },
		month: { type: "string", description: "Month filter" },
		from: { type: "string", description: "Start date for custom range" },
		until: { type: "string", description: "End date for custom range" },
		"range-to": {
			type: "string",
			description:
				"End date for custom range; use because --to is the target surface",
		},
		overdue: { type: "boolean", description: "Only overdue tasks" },
		status: {
			type: "string",
			description: "Comma-separated: inbox,planned,done,trashed,active,all",
		},
		planned: { type: "boolean", description: "Tasks with a plan" },
		unplanned: { type: "boolean", description: "Tasks without a plan" },
		project: { type: "string", description: "Filter by project/list id" },
		tag: { type: "string", description: "Filter by tag id" },
		priority: { type: "string", description: "Priority 1-3" },
		connector: {
			type: "string",
			description: "gmail | linear | akiflow | none",
		},
		bucket: { type: "string", description: "week | month" },
		recurring: { type: "boolean", description: "Only recurring tasks" },
		json: { type: "boolean", description: "Output summary as JSON" },
	},
	run: async ({ args }) => {
		const rawArgs = args as Record<string, unknown>;
		if (rawArgs.to !== "events") {
			console.error(
				`Error: af convert tasks --to ${rawArgs.to} is not implemented in v1. Supported: --to events.`,
			);
			process.exit(1);
		}

		const client = createClient();
		const defaultDurationSeconds = rawArgs["default-duration"]
			? parseDurationToSeconds(rawArgs["default-duration"] as string)
			: null;
		const [tasks, events] = await Promise.all([
			readResource(client, "tasks"),
			readResource(client, "events"),
		]);
		const selectedTasks = selectTasks(tasks, rawArgs);
		const validationErrors = validateSelectedTasks(
			selectedTasks,
			rawArgs,
			defaultDurationSeconds,
		);

		if (validationErrors.length > 0) {
			console.error("Error: Cannot convert selected tasks:");
			for (const error of validationErrors) console.error(`  - ${error}`);
			process.exit(1);
		}

		let calendar: Awaited<ReturnType<typeof resolveEventTargetCalendar>>;
		try {
			calendar = await resolveEventTargetCalendar(
				client,
				rawArgs.calendar as string | undefined,
				"af convert tasks --to events",
			);
		} catch (error) {
			if (error instanceof CalendarResolutionError) {
				console.error(`Error: ${error.message}`);
				process.exit(1);
			}
			throw error;
		}
		const candidates = buildCandidates(
			selectedTasks,
			events,
			calendar,
			defaultDurationSeconds,
		);
		const execute = rawArgs.execute === true;
		const deleteSource = rawArgs["delete-source"] === true;

		if (!execute) {
			if (rawArgs.json) {
				printJsonSummary(candidates, "dry-run", deleteSource);
			} else {
				console.log(formatPreview(candidates, deleteSource, false));
			}
			return;
		}

		const toCreate = candidates.filter((candidate) => !candidate.match);
		if (toCreate.length > 0) {
			const response = await client.createEvents(
				toCreate.map((candidate) => candidate.payload),
			);
			if (response.data.length !== toCreate.length) {
				console.error(
					"Error: Failed to create all target events; source tasks were not deleted.",
				);
				process.exit(1);
			}
		}

		if (deleteSource && candidates.length > 0) {
			const timestamp = new Date().toISOString();
			const deletePayloads: UpdateTaskPayload[] = candidates.map(
				(candidate) => ({
					id: candidate.task.id,
					deleted_at: timestamp,
					global_updated_at: timestamp,
				}),
			);
			const response = await client.upsertTasks(deletePayloads);
			if (!response.success) {
				console.error(
					"Error: Events were created, but source task deletion failed.",
				);
				console.error(response.message);
				process.exit(1);
			}
		}

		if (rawArgs.json) {
			printJsonSummary(candidates, "execute", deleteSource);
		} else {
			console.log(formatPreview(candidates, deleteSource, true));
		}
	},
});

function unsupportedConvertCommand(source: "slots" | "events") {
	return defineCommand({
		meta: {
			name: source,
			description: `Convert Akiflow ${source} to another surface`,
		},
		args: {
			to: {
				type: "string",
				description: "Target surface",
				required: true,
			},
		},
		run: ({ args }) => {
			console.error(
				`Error: af convert ${source} --to ${(args as Record<string, unknown>).to} is not implemented in v1. Supported: af convert tasks --to events.`,
			);
			process.exit(1);
		},
	});
}

export const convertCommand = defineCommand({
	meta: {
		name: "convert",
		description: "Convert between Akiflow surfaces",
	},
	subCommands: {
		tasks: convertTasksCommand,
		slots: unsupportedConvertCommand("slots"),
		events: unsupportedConvertCommand("events"),
	},
});
