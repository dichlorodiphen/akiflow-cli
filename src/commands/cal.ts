import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import { CalendarResolutionError } from "../lib/calendar";
import { formatLocalDate, parseLocalDate } from "../lib/date-parser";
import { EXIT_CODES, UsageError } from "../lib/exit-codes";
import { emptyContext, toCleanedCalView } from "../lib/format/cleaned-types";
import type { Occurrence } from "../lib/occurrence";
import { readOccurrences } from "../lib/occurrence-read";
import { buildReviewEnvelope } from "../lib/review-envelope";

function time(date: Date): string {
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
export function formatMergedTimeline(entries: Occurrence[]): string {
	if (!entries.length) return "(no events, slots, or scheduled tasks in range)";
	const days = new Map<string, Occurrence[]>();
	for (const o of entries) {
		const day = formatLocalDate(o.start);
		const group = days.get(day) ?? [];
		group.push(o);
		days.set(day, group);
	}
	return [...days]
		.map(
			([day, group]) =>
				`${(parseLocalDate(day)!).toDateString()}\n\n${group.map((o) => `  ${time(o.start)} — ${o.end ? time(o.end) : "    "}   ${{ event: "📅", slot: "⏰", task: "📌" }[o.source]}  ${o.title ?? `(untitled ${o.source})`}`).join("\n")}`,
		)
		.join("\n\n");
}
export async function runMergedCalendar(
	args: Record<string, unknown>,
): Promise<void> {
	const { snapshot, pairs, window, minMinutes } = await readOccurrences(
		createClient(),
		args,
	);
	const occurrences = pairs.map((p) => p.occurrence);
	const envelope = buildReviewEnvelope(occurrences, window, minMinutes);
	const print = (result: unknown) =>
		console.log(
			JSON.stringify({ result, next_cursor: null, errors: [] }, null, 2),
		);
	if (args.raw) {
		print(
			pairs.map(({ occurrence: o, raw }) => ({
				type: o.source,
				record: raw,
				start: o.start,
				end: o.end,
			})),
		);
		return;
	}
	if (args.free) {
		if (args.json) print(envelope.free_windows);
		else
			console.log(
				envelope.free_windows.length
					? envelope.free_windows
							.map(
								(w) =>
									`${time(new Date(w.start))} — ${time(new Date(w.end))} (${Math.round((Date.parse(w.end) - Date.parse(w.start)) / 60000)} min)`,
							)
							.join("\n")
					: "(no free windows in range)",
			);
		return;
	}
	if (args.summary) {
		const counts = { event: 0, slot: 0, task: 0 };
		for (const o of occurrences) counts[o.source]++;
		const result = {
			counts,
			total: occurrences.length,
			busy_minutes: envelope.busy_minutes,
		};
		if (args.json) print(result);
		else
			console.log(
				[
					"Calendar summary",
					...Object.entries(counts).map(
						([source, count]) => `${source}: ${count}`,
					),
					`total: ${result.total}`,
					`busy_minutes: ${result.busy_minutes}`,
				].join("\n"),
			);
		return;
	}
	if (args.json) {
		const ctx = emptyContext();
		for (const c of snapshot.data.calendars) ctx.calendarsById.set(c.id, c);
		for (const a of snapshot.data.accounts) ctx.accountsById.set(a.id, a);
		print(pairs.map((pair) => toCleanedCalView(pair, ctx)));
		return;
	}
	console.log(formatMergedTimeline(occurrences));
}
export function readFailure(error: unknown): never {
	console.error(
		`Error: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(
		error instanceof UsageError ||
			error instanceof CalendarResolutionError ||
			(error instanceof Error && "exitCode" in error && error.exitCode === 2)
			? EXIT_CODES.validation
			: error instanceof Error && error.name === "AuthError"
				? EXIT_CODES.auth
				: EXIT_CODES.upstream,
	);
}
export const cal = defineCommand({
	meta: {
		name: "cal",
		description: "View calendar — events + time slots + scheduled tasks",
	},
	args: {
		"min-duration": {
			type: "string",
			description: "Minimum free window duration (e.g. 30m)",
		},
		free: {
			type: "boolean",
			description: "Find free windows in the selected range",
		},
		// Date range
		today: { type: "boolean", description: "Today only (default)" },
		tomorrow: { type: "boolean" },
		yesterday: { type: "boolean" },
		"this-week": { type: "boolean" },
		"next-week": { type: "boolean" },
		"this-month": { type: "boolean" },
		"next-month": { type: "boolean" },
		date: { type: "string", description: "Single day" },
		from: { type: "string", description: "Start date" },
		to: { type: "string", description: "End date" },
		// Resource filters
		calendar: {
			type: "string",
			description: "Filter by calendar id, origin id, or unique title",
		},
		account: { type: "string", description: "Filter by akiflow_account_id" },
		connector: { type: "string", description: "google | microsoft | icloud" },
		search: {
			type: "string",
			alias: "s",
			description: "Search title or description",
		},
		// citty rewrites --no-events as args.events = false (negation)
		events: {
			type: "boolean",
			description: "Include events (use --no-events to exclude)",
		},
		tasks: {
			type: "boolean",
			description: "Include scheduled tasks (use --no-tasks to exclude)",
		},
		slots: {
			type: "boolean",
			description: "Include time slots (use --no-slots to exclude)",
		},
		declined: { type: "boolean", description: "Include declined events" },
		"all-day-only": { type: "boolean" },
		"all-day": {
			type: "boolean",
			description: "Include all-day events (use --no-all-day to exclude)",
		},
		// Output
		summary: { type: "boolean", description: "Print grouped counts" },
		json: { type: "boolean", description: "Cleaned JSON" },
		raw: { type: "boolean", description: "Raw API records JSON" },
	},
	run: async ({ args }) => {
		try {
			await runMergedCalendar(args);
		} catch (error) {
			readFailure(error);
		}
	},
});
