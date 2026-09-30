import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { Task } from "./api/types";
import {
	type CacheClient,
	initializeCache,
	observationTimestamp,
	observedTaskDeletions,
	readResource,
} from "./cache";
import { atomicWrite } from "./cache/atomic";
import { withLock } from "./cache/lock";
import { cacheFile, cacheLockPath } from "./platform-config";
import { assertMutableTaskId } from "./task-context";

export type IntentKind =
	| "create"
	| "update"
	| "complete"
	| "delete"
	| "plan"
	| "snooze";
export interface TaskIntent {
	intentId: string;
	taskId: string;
	kind: IntentKind;
	fields: Partial<Task>;
	createdAt: string;
	baseObservedVersion: string | null;
	/** Local fallback for an as-yet unobserved task; never written to observations. */
	snapshot?: Task;
}
const localClient: CacheClient = {
	get: async () => {
		throw new Error("Task reads must stay local; run af refresh to sync.");
	},
};
const journalPath = () => cacheFile("pending-tasks.json");

function loadIntents(): TaskIntent[] {
	let text: string;
	try {
		text = readFileSync(journalPath(), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const journal = JSON.parse(text);
	if (journal.version === 1 && Array.isArray(journal.intents))
		return journal.intents;
	// Upgrade the old pending-create journal under the lock without expiring it.
	if (Array.isArray(journal.tasks))
		return journal.tasks.map((entry: { task: Task; createdAt: number }) => ({
			intentId: randomUUID(),
			taskId: entry.task.id,
			kind: "create",
			fields: intendedFields(entry.task),
			snapshot: entry.task,
			createdAt: new Date(entry.createdAt).toISOString(),
			baseObservedVersion: null,
		}));
	throw new Error(
		"Invalid pending task journal; refusing to discard unacknowledged intents",
	);
}
function saveIntents(intents: TaskIntent[]): void {
	atomicWrite(journalPath(), JSON.stringify({ version: 1, intents }));
}
function intendedFields(payload: Partial<Task>): Partial<Task> {
	const {
		id: _id,
		global_updated_at: _updated,
		global_created_at: _created,
		pending: _pending,
		pending_conflict: _conflict,
		...fields
	} = payload;
	return fields;
}
function matches(task: Task, fields: Partial<Task>): boolean {
	return Object.entries(fields).every(([key, value]) =>
		isDeepStrictEqual(task[key as keyof Task], value),
	);
}

/** Append under C's ownership lock. API acknowledgements are intents, never observations. */
export async function recordTaskIntent(
	kind: IntentKind,
	payload: Partial<Task> & { id: string },
	snapshot?: Task,
): Promise<void> {
	assertMutableTaskId(payload.id);
	await initializeCache();
	await withLock(cacheLockPath(), async () => {
		const observed = (
			await readResource(localClient, "tasks", { cacheOnly: true })
		).find((t) => t.id === payload.id);
		const intents = loadIntents();
		intents.push({
			intentId: randomUUID(),
			taskId: payload.id,
			kind,
			fields: intendedFields(payload),
			createdAt: new Date().toISOString(),
			baseObservedVersion: observed?.global_updated_at ?? null,
			snapshot: snapshot ?? observed,
		});
		saveIntents(intents);
	});
}

/**
 * Entity retention: trashed observations remain in the generational store.
 * Every task consumer excludes them by default; explicit trash queries opt in.
 * Delete overlays hide rows; only a tombstone or a newer task sync proving
 * absence of a previously observed row confirms deletion. No TTL is used.
 * The lock keeps observation publication and journal reconciliation consistent.
 */
export async function readTasks(
	client: CacheClient = localClient,
	options: { includeTrashed?: boolean } = {},
): Promise<Task[]> {
	await initializeCache();
	return withLock(cacheLockPath(), async () => {
		const observed = await readResource(client, "tasks", { cacheOnly: true });
		const syncedAt = await observationTimestamp("tasks");
		const deleted = await observedTaskDeletions();
		const rows = new Map(observed.map((t) => [t.id, { ...t }]));
		const intents = loadIntents();
		const groups = new Map<string, TaskIntent[]>();
		for (const intent of intents) {
			assertMutableTaskId(intent.taskId);
			const group = groups.get(intent.taskId) ?? [];
			group.push(intent);
			groups.set(intent.taskId, group);
		}
		const retained: TaskIntent[] = [];
		for (const [id, group] of groups) {
			const base = rows.get(id);
			const latest = group.at(-1);
			if (!latest) continue;
			const deletedAt = deleted[id];
			// Journal order is lock acquisition order. Later fields supersede
			// earlier fields, so acknowledgement of the final state clears the chain.
			const fields = Object.assign(
				{},
				...group.map((i) => i.fields),
			) as Partial<Task>;
			const deletion = group.some((i) => i.kind === "delete");
			const confirmed = deletion
				? Boolean(
						base?.deleted_at ||
							base?.status === 9 ||
							(!base && deletedAt && deletedAt >= latest.createdAt) ||
							(!base &&
								group.some((i) => i.baseObservedVersion !== null) &&
								syncedAt &&
								syncedAt > latest.createdAt),
					)
				: Boolean(base && matches(base, fields));
			if (confirmed) continue;
			retained.push(...group);
			if (deletion) {
				rows.delete(id);
				continue;
			}
			const fallback = group.find((i) => i.snapshot)?.snapshot;
			const row = {
				...emptyTask(id),
				...(fallback ?? {}),
				...(base ?? {}),
				...fields,
				pending: true as const,
			};
			// A newer conflicting observation cannot silently undo completion.
			const conflict =
				base &&
				group.some(
					(i) =>
						i.baseObservedVersion &&
						base.global_updated_at > i.baseObservedVersion &&
						!matches(base, i.fields),
				);
			if (conflict) {
				row.pending_conflict = `Observed task ${id} conflicts with unacknowledged intent; pending fields retained`;
				console.error(`Warning: ${row.pending_conflict}`);
			}
			rows.set(id, row);
		}
		if (retained.length !== intents.length || intents.length)
			saveIntents(retained);
		return [...rows.values()].filter(
			(t) =>
				!t.deleted_at &&
				t.status !== 9 &&
				(options.includeTrashed || (!t.trashed_at && t.status !== 10)),
		);
	});
}

function emptyTask(id: string): Task {
	return {
		id,
		user_id: 0,
		title: null,
		description: null,
		recurring_id: null,
		date: null,
		datetime: null,
		datetime_tz: null,
		original_date: null,
		original_datetime: null,
		duration: null,
		recurrence: null,
		recurrence_version: null,
		status: 1,
		priority: null,
		dailyGoal: null,
		done: false,
		done_at: null,
		read_at: null,
		listId: null,
		section_id: null,
		tags_ids: [],
		sorting: 0,
		sorting_label: null,
		origin: null,
		due_date: null,
		connector_id: null,
		origin_id: null,
		origin_account_id: null,
		akiflow_account_id: null,
		doc: {},
		calendar_id: null,
		time_slot_id: null,
		links: [],
		content: {},
		trashed_at: null,
		plan_unit: null,
		plan_period: null,
		global_list_id_updated_at: null,
		global_tags_ids_updated_at: null,
		global_created_at: "",
		global_updated_at: "",
		data: {},
		deleted_at: null,
	};
}
