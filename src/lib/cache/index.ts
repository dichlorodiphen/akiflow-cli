import { readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
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
	return (await snapshotResources(client, [resource])).data[resource] as T[];
}

export interface ResourceRecords {
	tasks: Task[];
	events: Event[];
	time_slots: TimeSlot[];
	labels: Label[];
	tags: Tag[];
	calendars: Calendar[];
	accounts: Account[];
	contacts: Contact[];
}
/** Refresh once, then capture all resource files and tokens without yielding. */
export async function snapshotResources(
	client: CacheClient,
	resources: readonly Resource[],
): Promise<{
	data: ResourceRecords;
	generation: string | null;
	observedAt: Record<Resource, string | null>;
}> {
	let generation =
		pinGeneration() ?? (await withLock(cacheLockPath(), ensureGeneration));
	let tokens = JSON.parse(
		readFileSync(join(generation, "tokens.json"), "utf8"),
	) as Tokens;
	const stale = resources.some((resource) => {
		const timestamp = tokens.last_success_at?.[resource];
		const age = timestamp ? Date.now() - Date.parse(timestamp) : Infinity;
		return (
			!tokens[resource] || !Number.isFinite(age) || age > 24 * 60 * 60 * 1000
		);
	});
	if (stale && !autoSyncDisabled()) {
		await sharedRefresh(client);
		const published = pinGeneration();
		if (!published)
			throw new Error("Cache refresh did not publish a generation");
		generation = published;
	}
	const capture = (directory: string) => {
		tokens = JSON.parse(
			readFileSync(join(directory, "tokens.json"), "utf8"),
		) as Tokens;
		const data = Object.fromEntries(
			RESOURCES.map((resource) => [
				resource,
				resources.includes(resource)
					? parseRecords(
							readFileSync(join(directory, `${resource}.jsonl`), "utf8"),
						)
					: [],
			]),
		) as unknown as ResourceRecords;
		const observedAt = Object.fromEntries(
			RESOURCES.map((resource) => [
				resource,
				tokens.last_success_at?.[resource] ?? null,
			]),
		) as Record<Resource, string | null>;
		return { data, generation: basename(directory), observedAt };
	};
	try {
		return capture(generation);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const current = pinGeneration();
		if (!current || current === generation) throw error;
		return capture(current);
	}
}

function parseRecords<T>(text: string): T[] {
	return text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as T);
}
