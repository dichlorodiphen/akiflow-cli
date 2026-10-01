import { existsSync, readFileSync } from "node:fs";
import { atomicWrite } from "./cache/atomic";
import { cacheFile } from "./platform-config";

/**
 * Event-creation journal: durable record of event IDs this CLI created.
 *
 * Delete guard: `af event delete` and `af batch events delete` can cancel
 * Google Calendar events via the Akiflow server (the server propagates the
 * v5 event-operation "delete" to Google). Nothing in the CLI stops those
 * commands from deleting an event the CLI never created — e.g. a block
 * placed by the user in the Google UI or another client. That is the
 * incident shape from 2026-09-26 ("Dinner: tilapia"): a guest event the CLI
 * had created vanished from Google, and the CLI had no provenance record
 * to distinguish its own events from foreign ones.
 *
 * This journal records every event ID submitted through `af event create`
 * and `af convert` (both submit client-generated UUIDs as the canonical
 * Akiflow event ID, so the CLI knows the ID at submit time). Delete paths
 * refuse targets absent from the journal unless the user passes --confirm.
 *
 * Entries recorded before this journal existed are absent by definition;
 * those deletes require --confirm once. The journal is advisory
 * provenance, not a security boundary: it lives in the local cache dir
 * and follows the machine, not the account.
 */

export interface CreatedEventEntry {
	/** Akiflow event ID (client-generated UUID at create time). */
	event_id: string;
	/** ISO timestamp when the creation was recorded. */
	created_at: string;
	/** Provenance for debugging: what was created. */
	provenance: {
		title: string;
		calendar_id: string;
	};
}

export interface CreatedEventJournal {
	version: 1;
	entries: CreatedEventEntry[];
}

const JOURNAL_FILENAME = "created-events-journal.json";

function journalPath(): string {
	// cacheFile() keeps non-generational files at the cache root.
	return cacheFile(JOURNAL_FILENAME);
}

function emptyJournal(): CreatedEventJournal {
	return { version: 1, entries: [] };
}

/** Load the journal; returns an empty journal if none exists or it is corrupt. */
export function loadCreatedEventJournal(): CreatedEventJournal {
	const path = journalPath();
	if (!existsSync(path)) return emptyJournal();
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as CreatedEventJournal;
		if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
			return emptyJournal();
		}
		return parsed;
	} catch {
		return emptyJournal();
	}
}

/** Atomically persist the journal. */
function saveCreatedEventJournal(journal: CreatedEventJournal): void {
	atomicWrite(journalPath(), JSON.stringify(journal, null, 2));
}

/**
 * Record a CLI-created event. Idempotent: an existing entry for the ID is
 * replaced (not duplicated).
 */
export function recordCreatedEvent(entry: CreatedEventEntry): void {
	const journal = loadCreatedEventJournal();
	const idx = journal.entries.findIndex((e) => e.event_id === entry.event_id);
	if (idx >= 0) {
		journal.entries[idx] = entry;
	} else {
		journal.entries.push(entry);
	}
	saveCreatedEventJournal(journal);
}

/** True when the journal records this event ID as created by this CLI. */
export function wasCreatedByCli(eventId: string): boolean {
	return loadCreatedEventJournal().entries.some((e) => e.event_id === eventId);
}

/** Remove a journal entry (e.g., after the event was deleted). */
export function clearCreatedEvent(eventId: string): void {
	const journal = loadCreatedEventJournal();
	const filtered = journal.entries.filter((e) => e.event_id !== eventId);
	if (filtered.length !== journal.entries.length) {
		saveCreatedEventJournal({ version: 1, entries: filtered });
	}
}

/**
 * Pure guard decision: deleting `eventId` needs explicit confirmation when
 * the journal has no record of this CLI creating it. `createdIds` is the
 * journal's entry set, loaded once by the caller.
 */
export function deleteNeedsConfirmation(
	eventId: string,
	createdIds: ReadonlySet<string>,
): boolean {
	return !createdIds.has(eventId);
}

/** Load the journal as an ID set for cheap repeated guard checks. */
export function loadCreatedEventIds(): Set<string> {
	return new Set(loadCreatedEventJournal().entries.map((e) => e.event_id));
}
