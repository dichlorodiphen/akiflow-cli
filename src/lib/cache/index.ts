import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
	Account,
	ApiResponse,
	Calendar,
	Contact,
	Event,
	Label,
	Tag,
	Task,
	TimeSlot,
} from "../api/types";
import { cacheLockPath } from "../platform-config";
import {
	ensureGeneration,
	pinGeneration,
	publishGeneration,
	RESOURCES,
	stageGeneration,
} from "./generation";
import { upsertRecords } from "./jsonl-store";
import { withLock } from "./lock";
import { syncResource } from "./sync";
import { readTokens, type Tokens, writeTokens } from "./tokens";
export type Resource = (typeof RESOURCES)[number];
export interface CacheClient {
	get<T>(
		path: string,
		params: { sync_token?: string; limit?: number },
	): Promise<ApiResponse<T[]>>;
}
export interface ResourceSyncSummary {
	upserted: number;
	tombstones: number;
	pages: number;
}

/** Download into a private generation; publish only after every file validates. */
async function syncPass(
	client: CacheClient,
	resources: readonly Resource[],
	cold: boolean,
): Promise<Record<Resource, ResourceSyncSummary>> {
	return withLock(cacheLockPath(), async () => {
		const base = await ensureGeneration();
		const stage = stageGeneration(cold ? undefined : base);
		try {
			const tokens: Tokens = cold ? {} : await readTokens(base);
			const summary = {} as Record<Resource, ResourceSyncSummary>;
			for (const resource of resources) {
				const result = await syncResource(client, {
					resource,
					keyOf: (r: { id: string }) => r.id,
					previousToken: tokens[resource] ?? null,
					directory: stage,
				});
				tokens[resource] = result.finalToken;
				tokens.last_success_at ??= {};
				tokens.last_success_at[resource] = new Date().toISOString();
				if (resource === "tasks") {
					tokens.deleted_tasks ??= {};
					for (const id of result.upsertedIds) delete tokens.deleted_tasks[id];
					for (const id of result.tombstoneIds)
						tokens.deleted_tasks[id] = tokens.last_success_at[resource];
				}
				summary[resource] = {
					upserted: result.upsertedCount,
					tombstones: result.tombstoneCount,
					pages: result.pages,
				};
			}
			if (resources.length === RESOURCES.length)
				tokens.last_full_sync_at = new Date().toISOString();
			await writeTokens(tokens, stage);
			publishGeneration(stage);
			return summary;
		} finally {
			rmSync(stage, { recursive: true, force: true });
		}
	});
}

/** Rebuild observations using GETs only; root journals, contexts and logs survive. */
export async function rebuild(
	client: CacheClient,
): Promise<Record<Resource, ResourceSyncSummary>> {
	return syncPass(client, RESOURCES, true);
}
export async function refresh(
	client: CacheClient,
): Promise<Record<Resource, ResourceSyncSummary>> {
	return syncPass(client, RESOURCES, false);
}
export async function refreshResource(
	client: CacheClient,
	resource: Resource,
): Promise<ResourceSyncSummary> {
	return (await syncPass(client, [resource], false))[resource];
}

/** Write through the pinned base using a new immutable generation and atomic publication. */
export async function upsertResourceRecords<T extends { id: string }>(
	resource: Resource,
	records: T[],
): Promise<void> {
	return withLock(cacheLockPath(), async () => {
		const base = await ensureGeneration();
		const stage = stageGeneration(base);
		try {
			await upsertRecords(
				join(stage, `${resource}.jsonl`),
				records,
				(r) => r.id,
			);
			publishGeneration(stage);
		} finally {
			rmSync(stage, { recursive: true, force: true });
		}
	});
}

// Concurrent automatic reads share one complete refresh. Each resource's own
// timestamp decides whether to request it; refreshing events alone cannot hide stale tasks.
const inflightRefresh = new Map<
	string,
	Promise<Record<Resource, ResourceSyncSummary>>
>();
function sharedRefresh(
	client: CacheClient,
): Promise<Record<Resource, ResourceSyncSummary>> {
	const key = cacheLockPath();
	let pending = inflightRefresh.get(key);
	if (!pending) {
		pending = refresh(client).finally(() => {
			inflightRefresh.delete(key);
		});
		inflightRefresh.set(key, pending);
	}
	return pending;
}

/** AF_NO_AUTO_SYNC: 1, true, yes or on (case insensitive) explicitly disable sync. */
export function autoSyncDisabled(): boolean {
	return /^(1|true|yes|on)$/i.test(process.env.AF_NO_AUTO_SYNC?.trim() ?? "");
}

/**
 * Read all records for a resource. Auto-triggers a refresh if the cache is
 * older than 24h (unless AF_NO_AUTO_SYNC=1). If the cache has never been
 * built, runs `refresh` first.
 */
export async function readResource(
	client: CacheClient,
	resource: "tasks",
	options?: { cacheOnly?: boolean },
): Promise<Task[]>;
export async function readResource(
	client: CacheClient,
	resource: "events",
	options?: { cacheOnly?: boolean },
): Promise<Event[]>;
export async function readResource(
	client: CacheClient,
	resource: "time_slots",
	options?: { cacheOnly?: boolean },
): Promise<TimeSlot[]>;
export async function readResource(
	client: CacheClient,
	resource: "labels",
	options?: { cacheOnly?: boolean },
): Promise<Label[]>;
export async function readResource(
	client: CacheClient,
	resource: "tags",
	options?: { cacheOnly?: boolean },
): Promise<Tag[]>;
export async function readResource(
	client: CacheClient,
	resource: "calendars",
	options?: { cacheOnly?: boolean },
): Promise<Calendar[]>;
export async function readResource(
	client: CacheClient,
	resource: "accounts",
	options?: { cacheOnly?: boolean },
): Promise<Account[]>;
export async function readResource(
	client: CacheClient,
	resource: "contacts",
	options?: { cacheOnly?: boolean },
): Promise<Contact[]>;
export async function readResource<T>(
	client: CacheClient,
	resource: Resource,
	options: { cacheOnly?: boolean } = {},
): Promise<T[]> {
	let generation = pinGeneration();
	if (!generation)
		generation = await withLock(cacheLockPath(), ensureGeneration);
	const tokens = await readTokens(generation);
	const timestamp = tokens.last_success_at?.[resource];
	const age = timestamp
		? Date.now() - Date.parse(timestamp)
		: Number.POSITIVE_INFINITY;
	if (
		(!tokens[resource] || !Number.isFinite(age) || age > 24 * 60 * 60 * 1000) &&
		!autoSyncDisabled() &&
		!options.cacheOnly
	) {
		await sharedRefresh(client);
		const published = pinGeneration();
		if (!published)
			throw new Error("Cache refresh did not publish a generation");
		generation = published;
	}
	// Pin once, then capture the whole file synchronously. No await can mix tokens
	// or resource files from a subsequent publication. Retry if GC removed an old pin.
	try {
		return parseRecords<T>(
			readFileSync(join(generation, `${resource}.jsonl`), "utf8"),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const current = pinGeneration();
		if (!current || current === generation) throw error;
		return parseRecords<T>(
			readFileSync(join(current, `${resource}.jsonl`), "utf8"),
		);
	}
}
function parseRecords<T>(text: string): T[] {
	return text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as T);
}

/** Resource-specific confirmation timestamp from one pinned observation generation. */
export async function observationTimestamp(
	resource: Resource,
): Promise<string | undefined> {
	const generation = pinGeneration();
	return generation
		? (await readTokens(generation)).last_success_at?.[resource]
		: undefined;
}

/** Initialize/adopt observations before acquiring a repository transaction lock. */
export async function initializeCache(): Promise<void> {
	if (!pinGeneration()) await withLock(cacheLockPath(), ensureGeneration);
}

/** Explicit tombstones survive removal of rows, within the same pinned generation. */
export async function observedTaskDeletions(): Promise<Record<string, string>> {
	const generation = pinGeneration();
	return generation ? ((await readTokens(generation)).deleted_tasks ?? {}) : {};
}
