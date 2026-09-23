import { readFileSync } from "node:fs";
import { cacheFile } from "./platform-config";

export interface TaskContext {
	tasks: Array<{
		shortId: number;
		id: string;
		title: string;
	}>;
	timestamp: number;
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isFullUuid(identifier: string): boolean {
	return UUID_RE.test(identifier);
}

export function readTaskContext(): TaskContext | null {
	try {
		const content = readFileSync(cacheFile("last-list.json"), "utf-8");
		return JSON.parse(content) as TaskContext;
	} catch {
		return null;
	}
}

export function resolveTaskId(
	identifier: string,
	context: TaskContext | null,
): string | null {
	if (isFullUuid(identifier)) return identifier;
	if (!context) return null;

	const shortId = Number.parseInt(identifier, 10);
	if (!Number.isNaN(shortId) && String(shortId) === identifier) {
		return context.tasks.find((task) => task.shortId === shortId)?.id ?? null;
	}

	const matches = context.tasks.filter((task) =>
		task.id.toLowerCase().startsWith(identifier.toLowerCase()),
	);
	if (matches.length === 1) return matches[0]?.id ?? null;
	if (matches.length > 1) {
		throw new Error(
			`Ambiguous task id prefix "${identifier}" matches ${matches.length} tasks`,
		);
	}
	return null;
}

export function taskTitleFromContext(
	taskId: string,
	context: TaskContext | null,
): string | undefined {
	return context?.tasks.find((task) => task.id === taskId)?.title;
}
