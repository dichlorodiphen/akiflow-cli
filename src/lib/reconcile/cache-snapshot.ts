import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Calendar, Event } from "../api/types";
import { pinGeneration } from "../cache/generation";
import type { Sources } from "./types";

export interface CacheCapture {
	events: Event[];
	calendars: Calendar[];
	metadata: Sources["cache"];
	warnings: string[];
}

function rows<T>(text: string): T[] {
	return text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			const row = JSON.parse(line);
			if (
				!row ||
				typeof row !== "object" ||
				Array.isArray(row) ||
				typeof row.id !== "string" ||
				!row.id
			)
				throw new Error("Invalid cache record");
			return row as T;
		});
}

/** No async boundary, initialization, locks, migrations, or token publication. */
export function captureCacheSnapshot(now = new Date()): CacheCapture {
	const metadata: Sources["cache"] = {
		availability: "unavailable",
		generation: null,
		captured_at: now.toISOString(),
		resource_timestamps: { events: null, calendars: null },
		events_age_seconds: null,
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		let directory: string | undefined;
		try {
			directory = pinGeneration();
			if (!directory)
				return {
					events: [],
					calendars: [],
					metadata,
					warnings: ["CLI cache is unavailable: no existing generation."],
				};
			const events = rows<Event>(
				readFileSync(join(directory, "events.jsonl"), "utf8"),
			);
			const calendars = rows<Calendar>(
				readFileSync(join(directory, "calendars.jsonl"), "utf8"),
			);
			const tokens = JSON.parse(
				readFileSync(join(directory, "tokens.json"), "utf8"),
			);
			if (!tokens || typeof tokens !== "object" || Array.isArray(tokens))
				throw new Error("Invalid cache timestamps");
			const timestamp = (resource: string): string | null => {
				const value = tokens.last_success_at?.[resource];
				return typeof value === "string" && Number.isFinite(Date.parse(value))
					? value
					: null;
			};
			metadata.availability = "available";
			metadata.generation = basename(directory);
			metadata.resource_timestamps = {
				events: timestamp("events"),
				calendars: timestamp("calendars"),
			};
			metadata.events_age_seconds = metadata.resource_timestamps.events
				? Math.max(
						0,
						(now.getTime() - Date.parse(metadata.resource_timestamps.events)) /
							1000,
					)
				: null;
			const warnings: string[] = [];
			if (metadata.events_age_seconds === null)
				warnings.push("CLI cache events timestamp is missing.");
			else if (metadata.events_age_seconds > 600)
				warnings.push(
					"CLI cache events are older than ten minutes; run af refresh --rebuild separately before trusting the cached view.",
				);
			if (!metadata.resource_timestamps.calendars)
				warnings.push("CLI cache calendars timestamp is missing.");
			return { events, calendars, metadata, warnings };
		} catch (error) {
			// Only a reclaimed pin warrants retry; never mix data from two pins.
			if (attempt === 0 && directory && !existsSync(directory)) continue;
			return {
				events: [],
				calendars: [],
				metadata,
				warnings: [
					`CLI cache is unavailable: ${error instanceof Error ? error.message : error}`,
				],
			};
		}
	}
	return {
		events: [],
		calendars: [],
		metadata,
		warnings: ["CLI cache is unavailable: pinned generation vanished."],
	};
}
