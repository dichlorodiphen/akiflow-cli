import { join } from "node:path";
import type { ApiResponse } from "../api/types";
import { cacheFile } from "../platform-config";
import { readAllRecords, rewriteRecords } from "./jsonl-store";
import { isTombstone } from "./tombstone";

export interface ResourceClient {
	get<T>(
		path: string,
		params: { sync_token?: string; limit?: number },
	): Promise<ApiResponse<T[]>>;
}

export interface SyncOptions<T extends { id: string }> {
	/** Resource name; becomes the JSONL filename `<resource>.jsonl`. */
	resource: string;
	/** Key extractor for deduplication. */
	keyOf: (r: T) => string;
	/** Previous sync_token; pass null for cold start. */
	previousToken: string | null;
	/** Per-page limit. Default 2500 (matches Akiflow webapp). */
	limit?: number;
	/** Override the API path. Default: `/v5/<resource>`. */
	apiPath?: string;
	/** Private staging directory supplied by the generation transaction. */
	directory?: string;
}

export interface SyncResult {
	tombstoneIds: string[];
	upsertedIds: string[];
	finalToken: string;
	upsertedCount: number;
	tombstoneCount: number;
	pages: number;
	/** True if this was a cold-sync replacement (tokenless or invalid-token recovery). */
	coldReplacement: boolean;
}

/**
 * Recognized invalid-token signals from the Akiflow API.
 * When detected, sync performs one staged full replacement (cold sync).
 */
function isInvalidTokenError(message: string | null | undefined): boolean {
	if (!message) return false;
	const lower = message.toLowerCase();
	return (
		lower.includes("invalid_token") ||
		lower.includes("invalid sync_token") ||
		lower.includes("invalid synctoken") ||
		(lower.includes("sync_token") && lower.includes("invalid")) ||
		(lower.includes("token") && lower.includes("expired"))
	);
}

/**
 * Sync one resource from the Akiflow API into local JSONL cache.
 *
 * G semantics:
 * - Paginates with sync_token until has_next_page = false.
 * - Incoming versions fold by ID in documented server order (last wins);
 *   duplicate versions collapse.
 * - Tombstone (deleted_at != null OR status=9) wins over live for the same ID;
 *   live → tombstone removes active state.
 * - Tokenless cold sync REPLACES local state (not merge). Disappeared IDs are
 *   observations only — never outbound deletes.
 * - Non-advancing cursor (same sync_token twice) terminates with explicit error.
 * - Missing sync_token terminates with explicit error.
 * - Recognized invalid-token triggers one staged full replacement.
 * - Atomic file rewrite at the end; the caller publishes resources + tokens together.
 */
export async function syncResource<
	T extends { id: string; deleted_at?: string | null; status?: number | null },
>(client: ResourceClient, opts: SyncOptions<T>): Promise<SyncResult> {
	const path = opts.apiPath ?? `/v5/${opts.resource}`;
	const file = opts.directory
		? join(opts.directory, `${opts.resource}.jsonl`)
		: cacheFile(`${opts.resource}.jsonl`);
	const limit = opts.limit ?? 2500;

	// Attempt sync; on invalid-token, retry once as cold replacement.
	let attempt = 0;
	let previousToken = opts.previousToken;
	while (attempt < 2) {
		try {
			return await syncAttempt(client, {
				resource: opts.resource,
				keyOf: opts.keyOf,
				previousToken,
				limit,
				apiPath: path,
				file,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (attempt === 0 && isInvalidTokenError(message)) {
				// One staged full replacement.
				attempt++;
				previousToken = null;
				continue;
			}
			throw error;
		}
	}
	// Unreachable; loop always returns or throws.
	throw new Error(`sync ${opts.resource}: unexpected retry exhaustion`);
}

interface SyncAttemptOpts<T extends { id: string }> {
	resource: string;
	keyOf: (r: T) => string;
	previousToken: string | null;
	limit: number;
	apiPath: string;
	file: string;
}

async function syncAttempt<
	T extends { id: string; deleted_at?: string | null; status?: number | null },
>(client: ResourceClient, opts: SyncAttemptOpts<T>): Promise<SyncResult> {
	const isCold = opts.previousToken == null;
	let token: string | undefined = opts.previousToken ?? undefined;
	let pages = 0;

	// Fold by ID in server order: last version wins. Tombstone flag per ID.
	const versions = new Map<string, { record: T; tombstone: boolean }>();
	const seenTokens = new Set<string>();

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const params: { sync_token?: string; limit: number } = {
			limit: opts.limit,
		};
		if (token) params.sync_token = token;
		const resp = await client.get<T[]>(opts.apiPath, params);
		if (!resp.success) {
			throw new Error(
				`sync ${opts.resource} failed: ${resp.message ?? "unknown error"}`,
			);
		}
		pages++;

		// Cursor must advance; non-advancing cursor is an explicit error.
		if (resp.sync_token) {
			if (seenTokens.has(resp.sync_token)) {
				throw new Error(
					`sync ${opts.resource}: sync_token did not advance (${resp.sync_token}); terminating to avoid infinite loop`,
				);
			}
			seenTokens.add(resp.sync_token);
			token = resp.sync_token;
		}

		const dataRecords = resp.data as unknown as T[];
		for (const r of dataRecords) {
			const id = opts.keyOf(r);
			const tombstone = isTombstone(r);
			// Last version wins; tombstone wins over live for same ID.
			const existing = versions.get(id);
			if (!existing || tombstone || !existing.tombstone) {
				versions.set(id, { record: r, tombstone });
			}
		}

		if (!resp.has_next_page) break;
	}

	if (token === undefined) {
		throw new Error(
			`sync ${opts.resource}: no sync_token returned from server`,
		);
	}

	// Separate tombstones from live upserts.
	const tombstoneIds: string[] = [];
	const upserts: T[] = [];
	for (const [id, { record, tombstone }] of versions) {
		if (tombstone) tombstoneIds.push(id);
		else upserts.push(record);
	}

	if (isCold) {
		// Tokenless cold sync replaces state. Disappeared IDs are observations
		// only — we write exactly what the server returned, never outbound deletes.
		await rewriteRecords(opts.file, upserts);
	} else {
		// Delta merge: drop tombstoned IDs + IDs being replaced, append upserts.
		const existing = await readAllRecords<T>(opts.file);
		const tombstoneSet = new Set(tombstoneIds);
		const upsertIds = new Set(upserts.map(opts.keyOf));
		const kept = existing.filter(
			(r) => !tombstoneSet.has(opts.keyOf(r)) && !upsertIds.has(opts.keyOf(r)),
		);
		await rewriteRecords(opts.file, [...kept, ...upserts]);
	}

	return {
		finalToken: token,
		upsertedCount: upserts.length,
		tombstoneCount: tombstoneIds.length,
		pages,
		tombstoneIds,
		upsertedIds: upserts.map(opts.keyOf),
		coldReplacement: isCold,
	};
}
