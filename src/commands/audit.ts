import { defineCommand } from "citty";
import { createClient } from "../lib/api/client";
import { auditDiscrepancies, auditStatusCounts } from "../lib/audit";
import { occurrenceReadArgs, readOccurrences } from "../lib/occurrence-read";
import { buildReviewEnvelope } from "../lib/review-envelope";
import { readTasks } from "../lib/tasks";
import { readFailure } from "./cal";

export const auditCommand = defineCommand({
	meta: {
		name: "audit",
		description: "Review calendar observations, capacity, and discrepancies",
	},
	args: occurrenceReadArgs,
	run: async ({ args }) => {
		try {
			const client = createClient();
			const { snapshot, input, query, pairs, window, minMinutes } =
				await readOccurrences(client, args);
			// Status diagnostics need retained trash, even though the timeline excludes it.
			const statusInput = {
				...input,
				tasks:
					args.tasks === false
						? []
						: await readTasks(client, { includeTrashed: true }),
			};
			const occurrences = pairs.map((p) => p.occurrence);
			const fetch_times = Object.fromEntries(
				(["events", "time_slots", "tasks", "calendars"] as const).map(
					(resource) => [resource, snapshot.observedAt[resource]],
				),
			);
			const times = Object.values(fetch_times);
			const observed_at = times.every((t) => t !== null)
				? [...(times as string[])].sort()[0]!
				: null;
			const envelope = buildReviewEnvelope(occurrences, window, minMinutes, {
				generation: snapshot.generation,
				observed_at,
			});
			const counts = { event: 0, slot: 0, task: 0 };
			for (const o of occurrences) counts[o.source]++;
			const audit = {
				fetch: { observed_at: fetch_times, generation: snapshot.generation },
				coverage: {
					window: envelope.window,
					counts,
					freshness: Object.fromEntries(
						Object.entries(fetch_times).map(([resource, timestamp]) => [
							resource,
							{
								age_seconds: timestamp
									? Math.max(
											0,
											Math.floor((Date.now() - Date.parse(timestamp)) / 1000),
										)
									: null,
								stale:
									!timestamp ||
									!Number.isFinite(Date.parse(timestamp)) ||
									Date.now() - Date.parse(timestamp) > 86400000,
							},
						]),
					),
				},
				discrepancies: {
					...auditDiscrepancies(occurrences),
					statuses: auditStatusCounts(statusInput, query, occurrences),
				},
				effective: envelope.occurrences,
			};
			if (args.json)
				console.log(
					JSON.stringify({ schema_version: 1, audit, envelope }, null, 2),
				);
			else
				console.log(
					[
						"FETCH",
						JSON.stringify(audit.fetch, null, 2),
						"COVERAGE",
						JSON.stringify(audit.coverage, null, 2),
						"DISCREPANCIES",
						JSON.stringify(audit.discrepancies, null, 2),
						"EFFECTIVE",
						...audit.effective.map(
							(o) => `${o.source} ${o.id} ${o.start} ${o.title ?? ""}`,
						),
					].join("\n"),
				);
		} catch (error) {
			readFailure(error);
		}
	},
});
