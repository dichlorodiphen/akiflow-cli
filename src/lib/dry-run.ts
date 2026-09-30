import type { Calendar, Task } from "./api/types";
import { type CacheClient, readResource } from "./cache";
import { readAllRecords } from "./cache/jsonl-store";
import {
	CalendarResolutionError,
	findDefaultEventCalendar,
	findDefaultWritablePrimaryCalendar,
	isWritableVisibleCalendar,
	resolveCalendarFromList,
} from "./calendar";
import { cacheFile } from "./platform-config";

export const dryRunArgs = {
	"dry-run": {
		type: "boolean" as const,
		description:
			"Preview normalized changes without any writes (uses local cache only)",
	},
};
export const snapshotArgs = {
	snapshot: {
		type: "string" as const,
		description: "Pin numeric task IDs to the token from task list",
	},
};

/** Local reads bypass auto-sync and authentication, including token refresh writes. */
export function mutationReader(dryRun: boolean): typeof readResource {
	return (
		dryRun
			? async (_client: CacheClient, resource: string) =>
					readAllRecords(cacheFile(`${resource}.jsonl`))
			: readResource
	) as typeof readResource;
}
export async function dryRunCalendar(
	input?: string,
	google = false,
): Promise<Calendar> {
	const calendars = await readAllRecords<Calendar>(
		cacheFile("calendars.jsonl"),
	);
	const calendar = input
		? resolveCalendarFromList(calendars, input, {
				includeHidden: true,
				includeDeleted: true,
			})
		: google
			? findDefaultEventCalendar(calendars)
			: findDefaultWritablePrimaryCalendar(calendars);
	if (
		!calendar ||
		!isWritableVisibleCalendar(calendar) ||
		(google && calendar.connector_id !== "google")
	)
		throw new CalendarResolutionError(
			"Dry-run requires a cached writable calendar. Run af refresh or select --calendar.",
		);
	return calendar;
}
export async function cachedTask(id: string): Promise<Task> {
	const tasks = await readAllRecords<Task>(cacheFile("tasks.jsonl"));
	const task = tasks.find((task) => task.id === id);
	if (!task) {
		console.error(
			`Error: Task "${id}" was not found in the local cache. Run af refresh before previewing.`,
		);
		process.exit(4);
	}
	return task;
}
export interface PreviewItem {
	id: string;
	title: string;
	before: Record<string, unknown> | null;
	after: Record<string, unknown> | null;
	notification_policy: string;
}
export function previewItem(
	before: unknown,
	after: unknown,
	notificationPolicy = "none",
): PreviewItem {
	const old = before as Record<string, unknown> | null;
	const next = after as Record<string, unknown> | null;
	const source = next ?? old ?? {};
	const keys = Object.keys(next ?? old ?? {}).filter(
		(key) =>
			![
				"id",
				"global_created_at",
				"global_updated_at",
				"data",
				"fingerprints",
				"user_id",
			].includes(key),
	);
	const normalize = (record: Record<string, unknown> | null) =>
		record === null
			? null
			: Object.fromEntries(keys.map((key) => [key, record[key] ?? null]));
	return {
		id: String(source.id ?? ""),
		title: String(source.title ?? old?.title ?? ""),
		before: normalize(old),
		after: normalize(next),
		notification_policy: notificationPolicy,
	};
}
export function printDryRun(items: PreviewItem[], json = false): void {
	const result = { mode: "dry-run", inventory: "local-cache", items };
	if (json) console.log(JSON.stringify(result, null, 2));
	else {
		console.log("Dry-run (local cache; no writes)");
		for (const item of items) {
			console.log(`${item.id} ${item.title}`);
			console.log(
				`  ${JSON.stringify(item.before)} → ${JSON.stringify(item.after)}`,
			);
			console.log(`  Notification policy: ${item.notification_policy}`);
		}
	}
}
