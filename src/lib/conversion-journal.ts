import { existsSync, readFileSync } from "node:fs";
import { atomicWrite } from "./cache/atomic";
import { cacheFile } from "./platform-config";

/**
 * Conversion journal: durable source→target mapping for `af convert`.
 *
 * When a task is converted to an event, the mapping is recorded here. On
 * rerun (or resume after partial failure), the journal is consulted first:
 * if a source task already has a recorded target event, the conversion is
 * skipped for that task (no duplicate creation). This replaces the fragile
 * title/time heuristic matching with provider identity (Akiflow event IDs).
 *
 * The journal is stored as JSON in the cache directory and written atomically
 * (temp file + rename) to survive crashes mid-write.
 */

export interface ConversionEntry {
	/** Akiflow task ID (source). */
	source_task_id: string;
	/** Akiflow event ID (target). */
	target_event_id: string;
	/** ISO timestamp when the conversion was recorded. */
	converted_at: string;
	/** Provenance for debugging: what was converted. */
	provenance: {
		title: string;
		start_time: string;
		calendar_id: string;
	};
}

export interface ConversionJournal {
	version: 1;
	entries: ConversionEntry[];
}

const JOURNAL_FILENAME = "conversion-journal.json";

function journalPath(): string {
	// cacheFile() keeps non-generational files at the cache root.
	return cacheFile(JOURNAL_FILENAME);
}

function emptyJournal(): ConversionJournal {
	return { version: 1, entries: [] };
}

/** Load the conversion journal; returns empty journal if none exists. */
export function loadConversionJournal(): ConversionJournal {
	const path = journalPath();
	if (!existsSync(path)) return emptyJournal();
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as ConversionJournal;
		if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
			return emptyJournal();
		}
		return parsed;
	} catch {
		return emptyJournal();
	}
}

/** Atomically persist the journal. */
function saveConversionJournal(journal: ConversionJournal): void {
	atomicWrite(journalPath(), JSON.stringify(journal, null, 2));
}

/**
 * Record a source→target mapping. Idempotent: if the source already has an
 * entry, it is replaced (not duplicated).
 */
export function recordConversion(entry: ConversionEntry): void {
	const journal = loadConversionJournal();
	const idx = journal.entries.findIndex(
		(e) => e.source_task_id === entry.source_task_id,
	);
	if (idx >= 0) {
		journal.entries[idx] = entry;
	} else {
		journal.entries.push(entry);
	}
	saveConversionJournal(journal);
}

/** Find the target event ID for a source task, or null if not converted. */
export function findTargetForSource(sourceTaskId: string): string | null {
	const journal = loadConversionJournal();
	const entry = journal.entries.find(
		(e) => e.source_task_id === sourceTaskId,
	);
	return entry?.target_event_id ?? null;
}

/** Remove a journal entry (e.g., when the target event was deleted). */
export function clearConversionEntry(sourceTaskId: string): void {
	const journal = loadConversionJournal();
	const filtered = journal.entries.filter(
		(e) => e.source_task_id !== sourceTaskId,
	);
	if (filtered.length !== journal.entries.length) {
		saveConversionJournal({ version: 1, entries: filtered });
	}
}

/**
 * Resume token: opaque string encoding the state of a partial conversion.
 * Contains the completed mappings and pending source IDs, allowing
 * `af convert --resume <token>` to continue without duplicates.
 */
export interface ResumeTokenPayload {
	version: 1;
	/** Source task IDs that were successfully converted (with targets). */
	completed: Array<{ source_task_id: string; target_event_id: string }>;
	/** Source task IDs that were not yet attempted. */
	pending: string[];
	/** ISO timestamp when the token was issued. */
	issued_at: string;
}

/** Encode a resume token from completed mappings and pending IDs. */
export function encodeResumeToken(
	completed: Array<{ source_task_id: string; target_event_id: string }>,
	pending: string[],
): string {
	const payload: ResumeTokenPayload = {
		version: 1,
		completed,
		pending,
		issued_at: new Date().toISOString(),
	};
	return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

/** Decode a resume token; returns null if invalid. */
export function decodeResumeToken(token: string): ResumeTokenPayload | null {
	try {
		const json = Buffer.from(token, "base64url").toString("utf-8");
		const parsed = JSON.parse(json) as ResumeTokenPayload;
		if (parsed.version !== 1) return null;
		if (!Array.isArray(parsed.completed) || !Array.isArray(parsed.pending)) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}
