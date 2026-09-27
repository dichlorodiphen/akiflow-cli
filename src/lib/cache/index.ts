import { rmSync } from "node:fs";
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
import { cacheFile, cachePath } from "../platform-config";
import { readAllRecords, upsertRecords } from "./jsonl-store";
import { withLock } from "./lock";
import { syncResource } from "./sync";
import { readTokens, type Tokens, writeTokens } from "./tokens";

const LOCK = (): string => cacheFile(".lock");

const RESOURCES = [
	"tasks",
	"events",
	"time_slots",
	"labels",
	"tags",
	"calendars",
	"accounts",
	"contacts",
] as const;
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

/**
 * Cold-start sync: delete the cache and rebuild every resource from scratch.
 */
export async function rebuild(
	client: CacheClient,
): Promise<Record<Resource, ResourceSyncSummary>> {
	return withLock(LOCK(), async () => {
		try {
			rmSync(cachePath(), { recursive: true, force: true });
		} catch {
			/* fresh */
		}
		const tokens: Tokens = {};
		const summary = {} as Record<Resource, ResourceSyncSummary>;
		for (const res of RESOURCES) {
			const result = await syncResource(client, {
				resource: res,
				keyOf: (r: { id: string }) => r.id,
				previousToken: null,
			});
			tokens[res] = result.finalToken;
			summary[res] = {
				upserted: result.upsertedCount,
				tombstones: result.tombstoneCount,
				pages: result.pages,
			};
		}
		tokens.last_full_sync_at = new Date().toISOString();
		await writeTokens(tokens);
		return summary;
	});
}

/**
 * Warm-path delta sync: fetch only changes since last token per resource.
 */
export async function refresh(
	client: CacheClient,
): Promise<Record<Resource, ResourceSyncSummary>> {
	return withLock(LOCK(), async () => {
		const tokens = await readTokens();
		const summary = {} as Record<Resource, ResourceSyncSummary>;
		for (const res of RESOURCES) {
			const result = await syncResource(client, {
				resource: res,
				keyOf: (r: { id: string }) => r.id,
				previousToken: tokens[res] ?? null,
			});
			tokens[res] = result.finalToken;
			summary[res] = {
				upserted: result.upsertedCount,
				tombstones: result.tombstoneCount,
				pages: result.pages,
			};
		}
		// A successful delta refresh leaves every resource fully synced, so the
		// cache is fresh as of now (previously only rebuild() stamped this,
		// which kept every readResource() perpetually "stale").
		tokens.last_full_sync_at = new Date().toISOString();
		await writeTokens(tokens);
		return summary;
	});
}

/**
 * Incremental refresh of a single resource. Prefer this over refresh() in
 * mutation commands that need fresh state for one resource before writing —
 * a full refresh syncs all eight resources and is slower.
 */
export async function refreshResource(
	client: CacheClient,
	resource: Resource,
): Promise<ResourceSyncSummary> {
	return withLock(LOCK(), async () => {
		const tokens = await readTokens();
		const result = await syncResource(client, {
			resource,
			keyOf: (r: { id: string }) => r.id,
			previousToken: tokens[resource] ?? null,
		});
		tokens[resource] = result.finalToken;
		tokens.last_full_sync_at = new Date().toISOString();
		await writeTokens(tokens);
		return {
			upserted: result.upsertedCount,
			tombstones: result.tombstoneCount,
			pages: result.pages,
		};
	});
}

/**
 * Write records straight into the local cache without a server round-trip.
 * Used as write-through after a successful mutation so a follow-up mutation
 * builds its operation base from the just-applied state, even when the
 * server's sync endpoint has not caught up with its write endpoint yet.
 */
export async function upsertResourceRecords<T extends { id: string }>(
	resource: Resource,
	records: T[],
): Promise<void> {
	return withLock(LOCK(), async () => {
		await upsertRecords(cacheFile(`${resource}.jsonl`), records, (r) => r.id);
	});
}

/**
 * Module-level in-flight refresh promise. Commands like `af cal` read
 * several resources concurrently via Promise.all; without sharing, each
 * readResource() would trigger its own refresh() and the losers would die
 * after ~10s with "could not acquire ... .lock". Concurrent callers share
 * one refresh instead of racing for the cache lock.
 */
let inflightRefresh: Promise<Record<Resource, ResourceSyncSummary>> | null =
	null;

function sharedRefresh(
	client: CacheClient,
): Promise<Record<Resource, ResourceSyncSummary>> {
	if (!inflightRefresh) {
		inflightRefresh = refresh(client).finally(() => {
			inflightRefresh = null;
		});
	}
	return inflightRefresh;
}

/**
 * Read all records for a resource. Auto-triggers a refresh if the cache is
 * older than 24h (unless AF_NO_AUTO_SYNC=1). If the cache has never been
 * built, runs `refresh` first.
 */
export async function readResource(
	client: CacheClient,
	resource: "tasks",
): Promise<Task[]>;
export async function readResource(
	client: CacheClient,
	resource: "events",
): Promise<Event[]>;
export async function readResource(
	client: CacheClient,
	resource: "time_slots",
): Promise<TimeSlot[]>;
export async function readResource(
	client: CacheClient,
	resource: "labels",
): Promise<Label[]>;
export async function readResource(
	client: CacheClient,
	resource: "tags",
): Promise<Tag[]>;
export async function readResource(
	client: CacheClient,
	resource: "calendars",
): Promise<Calendar[]>;
export async function readResource(
	client: CacheClient,
	resource: "accounts",
): Promise<Account[]>;
export async function readResource(
	client: CacheClient,
	resource: "contacts",
): Promise<Contact[]>;
export async function readResource<T>(
	client: CacheClient,
	resource: Resource,
): Promise<T[]> {
	const tokens = await readTokens();
	const hasToken = tokens[resource] != null;
	const stale = shouldAutoRefresh(tokens);
	if ((!hasToken || stale) && !process.env.AF_NO_AUTO_SYNC) {
		await sharedRefresh(client);
	}
	return readAllRecords<T>(cacheFile(`${resource}.jsonl`));
}

function shouldAutoRefresh(tokens: Tokens): boolean {
	if (!tokens.last_full_sync_at) return true;
	const age = Date.now() - new Date(tokens.last_full_sync_at).getTime();
	return age > 24 * 60 * 60 * 1000;
}
