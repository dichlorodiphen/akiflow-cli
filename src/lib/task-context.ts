import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cacheFile } from "./platform-config";

interface ContextTask {
	shortId: number;
	id: string;
	title: string;
	synthetic?: boolean;
}

export interface TaskContext {
	tasks: ContextTask[];
	timestamp: number;
	/** Pins the exact numbered list, including its creation time. */
	snapshot?: string;
}

export interface TaskIdOptions {
	snapshot?: string;
	warn?: (message: string) => void;
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validationError(message: string): Error & { exitCode: number } {
	return Object.assign(new Error(message), { exitCode: 2 });
}

export function isFullUuid(identifier: string): boolean {
	return UUID_RE.test(identifier);
}

export function isSyntheticTaskId(identifier: string): boolean {
	return identifier.startsWith("virtual:");
}

export function assertMutableTaskId(id: string): void {
	if (isSyntheticTaskId(id)) {
		throw validationError(
			`Synthetic task ID "${id}" cannot be mutated; use the real recurring task UUID`,
		);
	}
}

export function createTaskSnapshot(
	context: Pick<TaskContext, "tasks" | "timestamp">,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				context.timestamp,
				context.tasks.map((t) => [t.shortId, t.id]),
			]),
		)
		.digest("hex")
		.slice(0, 24);
}

export function readTaskContext(): TaskContext | null {
	try {
		const content = readFileSync(cacheFile("last-list.json"), "utf-8");
		return JSON.parse(content) as TaskContext;
	} catch {
		return null;
	}
}

/** Read the full inventory without triggering sync, auth, or cache writes. */
function readInventory(): Array<{ id: string; title?: string }> | null {
	try {
		const content = readFileSync(cacheFile("tasks.jsonl"), "utf-8");
		return content
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => {
				const record = JSON.parse(line) as { id: string; title?: string };
				if (typeof record.id !== "string")
					throw new Error("Invalid task inventory");
				return record;
			});
	} catch {
		return null;
	}
}

export function resolveTaskId(
	identifier: string,
	context: TaskContext | null,
	options: TaskIdOptions = {},
): string | null {
	assertMutableTaskId(identifier);
	if (isFullUuid(identifier)) return identifier;
	const warn = options.warn ?? console.warn;

	if (/^\d+$/.test(identifier)) {
		const task = context?.tasks.find(
			(task) => task.shortId === Number(identifier),
		);
		if (!task) return null;
		assertMutableTaskId(task.id);
		if (task.synthetic) {
			throw validationError(
				`Synthetic task ID "${task.id}" cannot be mutated; use the real recurring task UUID`,
			);
		}
		if (options.snapshot !== undefined) {
			if (!context?.snapshot || options.snapshot !== context.snapshot) {
				throw validationError(
					`Snapshot token "${options.snapshot}" does not match the current task list; run 'af task list' again`,
				);
			}
		} else if (process.env.AF_STRICT_IDS === "1") {
			throw validationError(
				`Numeric task ID "${identifier}" requires --snapshot <token> (AF_STRICT_IDS=1)`,
			);
		} else {
			warn(
				`Warning: Unpinned numeric task ID "${identifier}" will soon require --snapshot <token>. Run 'af task list' and pass its snapshot token; AF_STRICT_IDS=1 enables require-mode now.`,
			);
		}
		return task.id;
	}

	const inventory = readInventory();
	warn(
		inventory !== null
			? `Warning: Task ID prefix "${identifier}" resolved against the full cached task inventory (tasks.jsonl).`
			: `Warning: Full task cache unavailable; task ID prefix "${identifier}" resolved against the last-list.json subset, which may be stale.`,
	);
	const matches = (inventory ?? context?.tasks ?? []).filter((task) =>
		task.id.toLowerCase().startsWith(identifier.toLowerCase()),
	);
	if (matches.length === 1) {
		const id = matches[0]!.id;
		assertMutableTaskId(id);
		return id;
	}
	if (matches.length > 1) {
		throw validationError(
			`Ambiguous task id prefix "${identifier}" matches ${matches.length} tasks`,
		);
	}
	const matchedId = matches[0]?.id;
	if (matchedId && isSyntheticTaskId(matchedId)) {
		throw validationError(
			`Synthetic task ID "${matchedId}" cannot be mutated; use the real recurring task UUID`,
		);
	}
	return matchedId ?? null;
}

export function taskTitleFromContext(
	taskId: string,
	context: TaskContext | null,
): string | undefined {
	return (
		readInventory()?.find((task) => task.id === taskId)?.title ??
		context?.tasks.find((task) => task.id === taskId)?.title
	);
}
