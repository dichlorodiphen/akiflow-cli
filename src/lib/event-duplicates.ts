import type { Event } from "./api/types";

export interface DuplicateGroup {
	/** The calendar both events live on. */
	calendar_id: string;
	/** The shared (original-casing) title. */
	title: string;
	/** Full IDs of the suspected duplicates. */
	event_ids: string[];
	/** ISO start of the earliest event in the group. */
	start: string | null;
	/** ISO end of the latest event in the group. */
	end: string | null;
}

function normalizeTitle(title: string | null | undefined): string {
	return (title ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}

interface TimedEvent {
	event: Event;
	startMs: number;
	endMs: number;
	key: string;
}

function toTimed(e: Event): TimedEvent | null {
	// Timed events only: all-day duplicates are a different (rarer) shape and
	// are intentionally out of scope.
	if (!e.start_time) return null;
	const startMs = Date.parse(e.start_time);
	if (Number.isNaN(startMs)) return null;
	const endMs = e.end_time ? Date.parse(e.end_time) : startMs;
	return {
		event: e,
		startMs,
		endMs: Number.isNaN(endMs) ? startMs : endMs,
		key: `${e.calendar_id ?? ""}|${normalizeTitle(e.title)}`,
	};
}

function overlaps(a: TimedEvent, b: TimedEvent): boolean {
	if (a.startMs < b.endMs && b.startMs < a.endMs) return true;
	// Two point-in-time events at the same instant.
	return (
		a.startMs === a.endMs && b.startMs === b.endMs && a.startMs === b.startMs
	);
}

/**
 * Find events that look like accidental duplicates: same calendar, same
 * normalized title, overlapping time ranges. Back-to-back blocks with the
 * same title do NOT count.
 *
 * Same-ID records are never duplicates of each other (sync folds versions by
 * ID). Deleted/hidden records must be filtered by the caller — this runs on
 * the already-filtered display set.
 */
export function detectDuplicateEvents(events: Event[]): DuplicateGroup[] {
	const timed = events
		.map(toTimed)
		.filter((t): t is TimedEvent => t !== null)
		.filter((t) => t.key.split("|")[1] !== "");

	const byKey = new Map<string, TimedEvent[]>();
	for (const t of timed) {
		const group = byKey.get(t.key) ?? [];
		group.push(t);
		byKey.set(t.key, group);
	}

	const duplicates: DuplicateGroup[] = [];
	for (const group of byKey.values()) {
		if (group.length < 2) continue;
		// Union-find over overlapping pairs.
		const parent = group.map((_, i) => i);
		const find = (i: number): number => {
			const p: number | undefined = parent[i];
			if (p === undefined || p === i) return i;
			const root = find(p);
			parent[i] = root;
			return root;
		};
		const union = (a: number, b: number) => {
			parent[find(a)] = find(b);
		};
		group.forEach((a, i) => {
			group.forEach((b, j) => {
				if (j > i && overlaps(a, b)) union(i, j);
			});
		});
		const clusters = new Map<number, TimedEvent[]>();
		group.forEach((t, i) => {
			const root = find(i);
			const cluster = clusters.get(root) ?? [];
			cluster.push(t);
			clusters.set(root, cluster);
		});
		for (const cluster of clusters.values()) {
			const ids = [...new Set(cluster.map((t) => t.event.id))];
			if (ids.length < 2) continue;
			const first = cluster[0];
			if (!first) continue;
			duplicates.push({
				calendar_id: first.event.calendar_id ?? "",
				title: first.event.title ?? "",
				event_ids: ids,
				start: new Date(
					Math.min(...cluster.map((t) => t.startMs)),
				).toISOString(),
				end: new Date(Math.max(...cluster.map((t) => t.endMs))).toISOString(),
			});
		}
	}
	return duplicates;
}

/** One human-readable warning line per duplicate group. */
export function formatDuplicateWarnings(groups: DuplicateGroup[]): string[] {
	return groups.map(
		(g) =>
			`Possible duplicate: "${g.title}" appears ${g.event_ids.length}x at overlapping times ` +
			`(ids: ${g.event_ids.map((id) => id.slice(0, 8)).join(", ")}). ` +
			`If you expected one, delete the extra; if the cache is stale, run \`af refresh --rebuild\` and re-check.`,
	);
}
