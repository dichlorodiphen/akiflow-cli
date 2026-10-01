import type { AkiflowClient } from "../api/client";
import type { Calendar, Event } from "../api/types";
import { type Coverage, ReconcileError } from "./types";

type Row = {
	id: string;
	deleted_at?: string | null;
	status?: string;
	recurrence_exception_delete?: unknown;
};

export function validateAkiflowPage<T extends Row>(
	value: unknown,
	seenCursors: Set<string>,
): { rows: T[]; next: string | null } {
	if (!value || typeof value !== "object")
		throw new ReconcileError("Malformed Akiflow page");
	const page = value as Record<string, unknown>;
	if (
		page.success !== true ||
		!Array.isArray(page.data) ||
		typeof page.has_next_page !== "boolean" ||
		(Array.isArray(page.failed) && page.failed.length > 0)
	)
		throw new ReconcileError("Incomplete or malformed Akiflow page");
	for (const row of page.data) {
		if (
			!row ||
			typeof row !== "object" ||
			Array.isArray(row) ||
			typeof row.id !== "string" ||
			!row.id
		)
			throw new ReconcileError("Malformed Akiflow record identity");
	}
	// Even the final page must carry a valid advancing full-read cursor.
	if (
		typeof page.sync_token !== "string" ||
		!page.sync_token ||
		seenCursors.has(page.sync_token)
	)
		throw new ReconcileError("Missing or repeated Akiflow pagination cursor");
	seenCursors.add(page.sync_token);
	return {
		rows: page.data as T[],
		next: page.has_next_page ? page.sync_token : null,
	};
}

export function foldVersions<T extends Row>(rows: T[]): T[] {
	const folded = new Map<string, T>();
	for (const row of rows) {
		if (folded.get(row.id)?.deleted_at != null) continue;
		folded.set(row.id, row);
	}
	return [...folded.values()];
}

export function isCancellation(row: Row): boolean {
	return (
		row.deleted_at != null ||
		row.status === "cancelled" ||
		!!row.recurrence_exception_delete
	);
}

/** Cold, full observation; tokens live only in this call's memory. */
export async function readAkiflowResource<T extends Row>(
	client: Pick<AkiflowClient, "get">,
	resource: "events" | "calendars",
	coverage: Coverage,
): Promise<{ rows: T[]; evidence: T[] }> {
	const all: T[] = [];
	const cursors = new Set<string>();
	let cursor: string | undefined;
	try {
		for (let page = 0; page < 1000; page++) {
			const response = await client.get<T[]>(`/v5/${resource}`, {
				limit: 2500,
				...(cursor ? { sync_token: cursor } : {}),
			});
			coverage.pages++;
			const validated = validateAkiflowPage<T>(response, cursors);
			all.push(...validated.rows);
			if (!validated.next) {
				coverage.complete = true;
				return {
					rows: foldVersions(all),
					evidence: foldVersions(all.filter(isCancellation)),
				};
			}
			cursor = validated.next;
		}
		throw new ReconcileError(
			"Akiflow pagination exceeded the 1000-page safety limit",
		);
	} catch (error) {
		coverage.error = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		coverage.read_end = new Date().toISOString();
	}
}

export async function readFreshAkiflow(
	client: Pick<AkiflowClient, "get">,
	metadata: {
		pages: { events: number; calendars: number };
		complete: boolean;
		read_end: string | null;
		error?: string;
	},
) {
	const coverage = (): Coverage => ({
		read_start: new Date().toISOString(),
		read_end: null,
		complete: false,
		pages: 0,
	});
	const calendarCoverage = coverage();
	const eventCoverage = coverage();
	try {
		const calendars = await readAkiflowResource<Calendar>(
			client,
			"calendars",
			calendarCoverage,
		);
		const events = await readAkiflowResource<Event>(
			client,
			"events",
			eventCoverage,
		);
		metadata.complete = true;
		return {
			calendars: calendars.rows,
			events: events.rows,
			evidence: events.evidence,
		};
	} catch (error) {
		metadata.error = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		metadata.pages = {
			calendars: calendarCoverage.pages,
			events: eventCoverage.pages,
		};
		metadata.read_end = new Date().toISOString();
	}
}
