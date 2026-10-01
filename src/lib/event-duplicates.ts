import type { Event } from "./api/types";
import type { TimedRecord } from "./timed-record";

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
	/** "duplicate" = same title, overlapping (almost certainly an accidental
	 * double-create). "possible-reshape" = similar title, adjacent or
	 * overlapping (a planning reshape may have left the old block standing). */
	kind: "duplicate" | "possible-reshape";
}

function normalizeTitle(title: string | null | undefined): string {
	return (title ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}

function titleTokens(title: string | null | undefined): string[] {
	return (title ?? "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 0);
}

interface TimedEvent {
	event: TimedRecord;
	startMs: number;
	endMs: number;
	key: string;
}

function toTimed(e: TimedRecord): TimedEvent | null {
	// Timed events only: all-day duplicates are a different (rarer) shape and
	// are intentionally out of scope.
	if (!e.start) return null;
	const startMs = Date.parse(e.start);
	if (Number.isNaN(startMs)) return null;
	const endMs = e.end ? Date.parse(e.end) : startMs;
	return {
		event: e,
		startMs,
		endMs: Number.isNaN(endMs) ? startMs : endMs,
		key: `${e.calendar ?? ""}|${normalizeTitle(e.title)}`,
	};
}

function overlaps(a: TimedEvent, b: TimedEvent): boolean {
	if (a.startMs < b.endMs && b.startMs < a.endMs) return true;
	// Two point-in-time events at the same instant.
	return (
		a.startMs === a.endMs && b.startMs === b.endMs && a.startMs === b.startMs
	);
}

/** Gap in ms between two events; 0 when they overlap or touch. */
function gapMs(a: TimedEvent, b: TimedEvent): number {
	if (overlaps(a, b)) return 0;
	return Math.min(Math.abs(a.startMs - b.endMs), Math.abs(b.startMs - a.endMs));
}

function toGroup(
	cluster: TimedEvent[],
	kind: DuplicateGroup["kind"],
): DuplicateGroup | null {
	const ids = [...new Set(cluster.map((t) => t.event.id))];
	if (ids.length < 2) return null;
	const first = cluster[0];
	if (!first) return null;
	return {
		calendar_id: first.event.calendar ?? "",
		title: first.event.title ?? "",
		event_ids: ids,
		kind,
		start: new Date(Math.min(...cluster.map((t) => t.startMs))).toISOString(),
		end: new Date(Math.max(...cluster.map((t) => t.endMs))).toISOString(),
	};
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
export function detectDuplicateRecords(
	events: TimedRecord[],
): DuplicateGroup[] {
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
			const g = toGroup(cluster, "duplicate");
			if (g) duplicates.push(g);
		}
	}
	return duplicates;
}

/**
 * Find the reshape-without-delete pattern: same calendar, *similar but not
 * identical* titles, times overlapping or adjacent. This is the shape a
 * planning session leaves behind when it creates a replacement block
 * ("Walk + feed Tidus" 6:25–6:55) without deleting the old one
 * ("Walk + feed corgi" 5:45–6:15).
 *
 * Similarity bar: at least 2 shared tokens and Jaccard >= 0.5, so "Dinner"
 * next to "Walk + feed Tidus" never fires but "Walk + feed corgi" next to
 * "Walk + feed Tidus" does. Proximity bar: overlap or a gap of at most 30
 * minutes. Pairs with identical normalized titles are excluded — those are
 * either tier-1 duplicates (when overlapping) or intentional back-to-back
 * splits, and flagging them here would contradict that rule.
 */
const RESHAPE_MAX_GAP_MS = 30 * 60 * 1000;

function titleSimilarity(a: TimedEvent, b: TimedEvent): number {
	const ta = new Set(titleTokens(a.event.title));
	const tb = new Set(titleTokens(b.event.title));
	if (ta.size === 0 || tb.size === 0) return 0;
	let shared = 0;
	for (const t of ta) if (tb.has(t)) shared++;
	if (shared < 2) return 0;
	return shared / (ta.size + tb.size - shared);
}

export function detectReshapeRecords(events: TimedRecord[]): DuplicateGroup[] {
	const timed = events
		.map(toTimed)
		.filter((t): t is TimedEvent => t !== null)
		.filter((t) => titleTokens(t.event.title).length > 0);

	const byCal = new Map<string, TimedEvent[]>();
	for (const t of timed) {
		const cal = t.event.calendar ?? "";
		const group = byCal.get(cal) ?? [];
		group.push(t);
		byCal.set(cal, group);
	}

	const reshapes: DuplicateGroup[] = [];
	for (const group of byCal.values()) {
		// Union-find over similar-and-near pairs.
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
				if (j <= i) return;
				if (a.event.id === b.event.id) return;
				if (normalizeTitle(a.event.title) === normalizeTitle(b.event.title))
					return;
				if (gapMs(a, b) > RESHAPE_MAX_GAP_MS) return;
				if (titleSimilarity(a, b) < 0.5) return;
				union(i, j);
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
			const g = toGroup(cluster, "possible-reshape");
			if (g) reshapes.push(g);
		}
	}
	return reshapes;
}

/** Thin adapters preserve cal's existing projections, ordering and warning bytes. */
function projectEvent(event: Event): TimedRecord {
	return {
		id: event.id,
		calendar: event.calendar_id ?? "",
		title: event.title,
		start: event.start_time,
		end: event.end_time,
	};
}

export function detectDuplicateEvents(events: Event[]): DuplicateGroup[] {
	return detectDuplicateRecords(events.map(projectEvent));
}

export function detectPossibleReshapes(events: Event[]): DuplicateGroup[] {
	return detectReshapeRecords(events.map(projectEvent));
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

/** One human-readable warning line per suspected reshape leftover. */
export function formatReshapeWarnings(groups: DuplicateGroup[]): string[] {
	return groups.map((g) => {
		const names = g.event_ids.map((id) => id.slice(0, 8)).join(", ");
		return (
			`Possible leftover block: ${g.event_ids.length} similarly-titled events sit adjacent ` +
			`(ids: ${names}). If a planning session reshaped this block (e.g. "Walk + feed corgi" → ` +
			`"Walk + feed Tidus"), the old one may not have been deleted — check the calendar UI.`
		);
	});
}
